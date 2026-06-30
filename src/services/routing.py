"""Approval routing service."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    ActingAssignment,
    AuditLog,
    CoHeadAssignment,
    CoverageAssignment,
    DelegationAssignment,
    DepartmentFallbackRule,
    HandoverOverlap,
    Project,
    ProjectAssignment,
    ProjectReportingLine,
    ReportingLine,
    User,
)


class RoutingError(Exception):
    """Raised when the approval chain cannot be built."""


@dataclass
class ApprovalStepResult:
    step_order: int
    approver: User
    is_fallback: bool = False
    source: str = "official"
    explanation: str = ""
    alternate_approvers: list[str] = field(default_factory=list)
    authority_owner_id: int | None = None
    acting_approver: User | None = None

    @property
    def effective_approver(self) -> User:
        """The person actually exercising the authority for this step.

        When an acting overlay is applied additively the official authority
        owner (``approver``) stays on the step for display, but the acting
        holder (``acting_approver``) is the one who actually approves. Routing
        rules that care about *who clicks approve* (e.g. self-approval
        prevention) should use this instead of ``approver``.
        """
        return self.acting_approver or self.approver


@dataclass
class ApprovalChain:
    requester: User
    action: Action
    steps: list[ApprovalStepResult] = field(default_factory=list)


def approval_chain_to_dict(chain: ApprovalChain) -> dict[str, object]:
    return {
        "requester": chain.requester.name,
        "action": chain.action.name,
        "steps": [
            {
                "order": step.step_order,
                "approver": step.approver.name,
                "is_fallback": step.is_fallback,
                "source": step.source,
                "explanation": step.explanation,
                "alternate_approvers": step.alternate_approvers,
                "acting": step.acting_approver is not None,
                "acting_approver": (
                    step.acting_approver.name if step.acting_approver else None
                ),
                "authority_owner": step.approver.name,
            }
            for step in chain.steps
        ],
    }


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _get_primary_reporting_line(
    session: Session, user_id: int
) -> ReportingLine | None:
    lines = (
        session.query(ReportingLine)
        .filter(
            ReportingLine.user_id == user_id,
            ReportingLine.is_primary.is_(True),
            ReportingLine.is_active.is_(True),
        )
        .all()
    )
    if len(lines) > 1:
        raise RoutingError(
            f"User id={user_id} has more than one active primary manager."
        )
    return lines[0] if lines else None


def _get_active_manager(
    session: Session,
    user_id: int,
    label: str,
) -> User | None:
    line = _get_primary_reporting_line(session, user_id)
    if line is None:
        return None
    manager = session.get(User, line.manager_id)
    if manager is None or not manager.is_active:
        raise RoutingError(f"{label} manager for user id={user_id} is inactive.")
    return manager


def _detect_cycle(session: Session, start_user_id: int) -> bool:
    visited: set[int] = set()
    current_id = start_user_id
    while True:
        if current_id in visited:
            return True
        visited.add(current_id)
        line = _get_primary_reporting_line(session, current_id)
        if line is None:
            return False
        current_id = line.manager_id


def _get_fallback_rule(
    session: Session, dept_id: int
) -> DepartmentFallbackRule | None:
    return (
        session.query(DepartmentFallbackRule)
        .filter(DepartmentFallbackRule.dept_id == dept_id)
        .first()
    )


def _build_fallback_step(
    session: Session,
    requester: User,
    step_order: int,
    explanation: str = "",
) -> ApprovalStepResult:
    fallback_rule = _get_fallback_rule(session, requester.dept_id)
    if fallback_rule is None:
        raise RoutingError(
            f"No fallback rule configured for department {requester.department.code!r}."
        )
    fallback_user = fallback_rule.fallback_user
    if fallback_user is None or not fallback_user.is_active:
        raise RoutingError(
            f"Fallback approver for department {requester.department.code!r} is inactive."
        )
    return ApprovalStepResult(
        step_order=step_order,
        approver=fallback_user,
        is_fallback=True,
        source="fallback",
        explanation=explanation or f"Department fallback approver {fallback_user.name}.",
        authority_owner_id=fallback_user.id,
    )


def _append_normal_steps(
    session: Session,
    requester: User,
    rule: ActionRoutingRule,
    chain: ApprovalChain,
) -> None:
    if not rule.requires_primary:
        return

    primary_manager = _get_active_manager(session, requester.id, "Primary")
    if primary_manager is None:
        raise RoutingError(
            f"No active primary manager found for user {requester.name!r}."
        )

    chain.steps.append(
        ApprovalStepResult(
            step_order=1,
            approver=primary_manager,
            source="official",
            explanation=f"Official primary manager {primary_manager.name}.",
            authority_owner_id=primary_manager.id,
        )
    )

    if not rule.requires_second_level:
        return

    second_manager = _get_active_manager(session, primary_manager.id, "Second-level")
    if second_manager is None:
        chain.steps.append(
            _build_fallback_step(
                session,
                requester,
                2,
                explanation="Second-level manager missing, so department fallback applies.",
            )
        )
        return

    chain.steps.append(
        ApprovalStepResult(
            step_order=2,
            approver=second_manager,
            source="official",
            explanation=f"Official second-level manager {second_manager.name}.",
            authority_owner_id=second_manager.id,
        )
    )


def _requester_org_unit_ids(requester: User) -> set[int]:
    return {
        membership.org_unit_id
        for membership in requester.org_unit_memberships
        if membership.is_active
    }


def _is_valid_window(effective_from: datetime, effective_to: datetime, label: str) -> None:
    if effective_to < effective_from:
        raise RoutingError(f"Invalid {label} date range configuration.")


def _is_date_valid(
    request_at: datetime, effective_from: datetime, effective_to: datetime
) -> bool:
    return _ensure_utc(effective_from) <= _ensure_utc(request_at) <= _ensure_utc(
        effective_to
    )


def _matches_scope(
    assignment: Any,
    requester: User,
    action: Action,
    requester_org_unit_ids: set[int],
) -> bool:
    if getattr(assignment, "dept_id", None) not in (None, requester.dept_id):
        return False
    action_id = getattr(assignment, "action_id", None)
    if action_id is not None and action_id != action.id:
        return False
    org_unit_id = getattr(assignment, "org_unit_id", None)
    if org_unit_id is not None and org_unit_id not in requester_org_unit_ids:
        return False
    return True


def _audit(
    session: Session,
    entity_type: str,
    action: str,
    details: str | None = None,
    entity_id: int | None = None,
) -> None:
    session.add(
        AuditLog(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            details=details,
        )
    )
    session.flush()


def _apply_handover_overlap(
    session: Session,
    requester: User,
    action: Action,
    request_at: datetime,
    steps: list[ApprovalStepResult],
    requester_org_unit_ids: set[int],
) -> list[ApprovalStepResult]:
    overlaps = (
        session.query(HandoverOverlap)
        .filter(
            HandoverOverlap.requester_user_id == requester.id,
            HandoverOverlap.is_active.is_(True),
        )
        .all()
    )

    for overlap in overlaps:
        _is_valid_window(overlap.effective_from, overlap.effective_to, "handover")
        if not _is_date_valid(request_at, overlap.effective_from, overlap.effective_to):
            continue
        if not _matches_scope(overlap, requester, action, requester_org_unit_ids):
            continue

        transformed: list[ApprovalStepResult] = []
        applied = False
        for step in steps:
            if step.authority_owner_id != overlap.old_approver_id:
                transformed.append(step)
                continue

            if overlap.old_approver is None or not overlap.old_approver.is_active:
                raise RoutingError("Old handover approver is inactive.")
            if overlap.new_approver is None or not overlap.new_approver.is_active:
                raise RoutingError("New handover approver is inactive.")

            if overlap.policy == "old_until_end_date":
                transformed.append(
                    ApprovalStepResult(
                        step_order=step.step_order,
                        approver=overlap.old_approver,
                        source="handover",
                        explanation=(
                            f"Handover policy keeps {overlap.old_approver.name} as approver "
                            f"until {overlap.effective_to.date().isoformat()}."
                        ),
                        authority_owner_id=overlap.old_approver_id,
                    )
                )
            elif overlap.policy == "new_from_start_date":
                transformed.append(
                    ApprovalStepResult(
                        step_order=step.step_order,
                        approver=overlap.new_approver,
                        source="handover",
                        explanation=(
                            f"Handover policy switches approval to {overlap.new_approver.name} "
                            f"from {overlap.effective_from.date().isoformat()}."
                        ),
                        authority_owner_id=overlap.new_approver_id,
                    )
                )
            elif overlap.policy == "both_required":
                transformed.extend(
                    [
                        ApprovalStepResult(
                            step_order=step.step_order,
                            approver=overlap.old_approver,
                            source="handover",
                            explanation=(
                                f"Handover overlap requires outgoing approver "
                                f"{overlap.old_approver.name}."
                            ),
                            authority_owner_id=overlap.old_approver_id,
                        ),
                        ApprovalStepResult(
                            step_order=step.step_order + 1,
                            approver=overlap.new_approver,
                            source="handover",
                            explanation=(
                                f"Handover overlap also requires incoming approver "
                                f"{overlap.new_approver.name}."
                            ),
                            authority_owner_id=overlap.new_approver_id,
                        ),
                    ]
                )
            elif overlap.policy == "new_primary_old_observer":
                transformed.append(
                    ApprovalStepResult(
                        step_order=step.step_order,
                        approver=overlap.new_approver,
                        source="handover",
                        explanation=(
                            f"Handover uses {overlap.new_approver.name} as approver while "
                            f"{overlap.old_approver.name} remains observer only."
                        ),
                        authority_owner_id=overlap.new_approver_id,
                    )
                )
            else:
                raise RoutingError(f"Unsupported handover policy {overlap.policy!r}.")

            _audit(
                session,
                entity_type="approval_chain",
                action="overlay_applied",
                details=(
                    f"handover requester={requester.id} policy={overlap.policy} "
                    f"old={overlap.old_approver_id} new={overlap.new_approver_id}"
                ),
            )
            applied = True

        if applied:
            return transformed

    return steps


def _apply_person_overlay(
    session: Session,
    requester: User,
    action: Action,
    request_at: datetime,
    steps: list[ApprovalStepResult],
    requester_org_unit_ids: set[int],
    model: type[Any],
    owner_field: str,
    replacement_field: str,
    overlay_name: str,
    additive: bool = False,
) -> list[ApprovalStepResult]:
    """Apply a person-level overlay (acting / delegation / peer coverage).

    By default the matched assignment *replaces* the official approver with the
    substitute (the historical behaviour for delegation and peer coverage).

    When ``additive`` is ``True`` (used for acting) the official authority owner
    stays on the step as ``approver`` and the substitute is attached as
    ``acting_approver`` instead, so the resolved line keeps showing the official
    approver alongside the acting holder (e.g. ``Ivan [official] (Boris
    acting)``) rather than silently swapping Ivan out for Boris.
    """
    transformed: list[ApprovalStepResult] = []
    for step in steps:
        assignments = (
            session.query(model)
            .filter(
                getattr(model, owner_field) == step.approver.id,
                model.is_active.is_(True),
            )
            .all()
        )

        replacement = None
        for assignment in assignments:
            _is_valid_window(
                assignment.effective_from,
                assignment.effective_to,
                overlay_name,
            )
            if not _is_date_valid(
                request_at, assignment.effective_from, assignment.effective_to
            ):
                continue
            if not _matches_scope(assignment, requester, action, requester_org_unit_ids):
                continue
            replacement = assignment
            break

        if replacement is None:
            transformed.append(step)
            continue

        substitute = getattr(replacement, replacement_field)
        if substitute is None or not substitute.is_active:
            raise RoutingError(
                f"{overlay_name.capitalize()} replacement user is inactive."
            )

        if overlay_name == "delegation" and replacement.delegator_user_id == replacement.delegate_user_id:
            raise RoutingError("Self-delegation is not allowed.")

        if additive:
            transformed.append(
                ApprovalStepResult(
                    step_order=step.step_order,
                    approver=step.approver,
                    is_fallback=step.is_fallback,
                    source=step.source,
                    explanation=(
                        f"{substitute.name} is acting for {step.approver.name}."
                    ),
                    alternate_approvers=step.alternate_approvers,
                    authority_owner_id=step.authority_owner_id,
                    acting_approver=substitute,
                )
            )
        else:
            transformed.append(
                ApprovalStepResult(
                    step_order=step.step_order,
                    approver=substitute,
                    is_fallback=step.is_fallback,
                    source=overlay_name,
                    explanation=(
                        f"{overlay_name.replace('_', ' ').capitalize()} replaces "
                        f"{step.approver.name} with {substitute.name}."
                    ),
                    alternate_approvers=step.alternate_approvers,
                    authority_owner_id=step.authority_owner_id,
                )
            )
        _audit(
            session,
            entity_type="approval_chain",
            action="overlay_applied",
            details=(
                f"{overlay_name} requester={requester.id} owner={step.approver.id} "
                f"replacement={substitute.id}"
            ),
        )

    return transformed


def _apply_project_overlay(
    session: Session,
    requester: User,
    action: Action,
    project_code: str | None,
    steps: list[ApprovalStepResult],
) -> list[ApprovalStepResult]:
    if not action.is_project_scoped or not project_code:
        return steps

    project = (
        session.query(Project)
        .filter(Project.code == project_code, Project.is_active.is_(True))
        .first()
    )
    if project is None:
        raise RoutingError(f"Project {project_code!r} not found.")

    project_assignment = (
        session.query(ProjectAssignment)
        .filter(
            ProjectAssignment.project_id == project.id,
            ProjectAssignment.user_id == requester.id,
            ProjectAssignment.is_active.is_(True),
        )
        .first()
    )
    if project_assignment is None:
        raise RoutingError(
            f"Requester {requester.name!r} is not assigned to project {project.code!r}."
        )

    project_line = (
        session.query(ProjectReportingLine)
        .filter(
            ProjectReportingLine.project_id == project.id,
            ProjectReportingLine.user_id == requester.id,
            ProjectReportingLine.is_active.is_(True),
        )
        .filter(
            (ProjectReportingLine.action_id.is_(None))
            | (ProjectReportingLine.action_id == action.id)
        )
        .first()
    )
    if project_line is None:
        raise RoutingError(
            f"No project reporting line configured for {requester.name!r} on project "
            f"{project.code!r}."
        )
    if project_line.project_manager is None or not project_line.project_manager.is_active:
        raise RoutingError("Project manager is inactive.")

    transformed: list[ApprovalStepResult] = []
    replaced = False
    for step in steps:
        if replaced or step.is_fallback:
            transformed.append(step)
            continue
        transformed.append(
            ApprovalStepResult(
                step_order=step.step_order,
                approver=project_line.project_manager,
                is_fallback=step.is_fallback,
                source="project",
                explanation=(
                    f"Project-scoped action routes through project manager "
                    f"{project_line.project_manager.name} for {project.code}."
                ),
                authority_owner_id=step.authority_owner_id,
            )
        )
        replaced = True
        _audit(
            session,
            entity_type="approval_chain",
            action="overlay_applied",
            details=(
                f"project requester={requester.id} project={project.code} "
                f"manager={project_line.project_manager_id}"
            ),
        )

    return transformed


def _apply_co_head_policy(
    session: Session,
    requester: User,
    action: Action,
    steps: list[ApprovalStepResult],
    requester_org_unit_ids: set[int],
) -> list[ApprovalStepResult]:
    assignments = (
        session.query(CoHeadAssignment)
        .filter(CoHeadAssignment.is_active.is_(True))
        .all()
    )
    scoped_assignments = [
        assignment
        for assignment in assignments
        if _matches_scope(assignment, requester, action, requester_org_unit_ids)
    ]
    if not scoped_assignments:
        return steps

    policy = scoped_assignments[0].policy
    ordered_assignments = sorted(
        scoped_assignments,
        key=lambda item: (0 if item.is_primary else 1, item.sequence_order, item.user.name),
    )
    co_head_ids = {assignment.user_id for assignment in ordered_assignments}
    if not any(step.approver.id in co_head_ids for step in steps):
        return steps

    transformed: list[ApprovalStepResult] = []
    applied = False
    for step in steps:
        if applied or step.approver.id not in co_head_ids:
            transformed.append(step)
            continue

        co_heads = [assignment.user for assignment in ordered_assignments]
        if any(user is None or not user.is_active for user in co_heads):
            raise RoutingError("Co-head assignment includes an inactive user.")

        if policy == "either_one_approves":
            primary = co_heads[0]
            alternates = [user.name for user in co_heads[1:]]
            transformed.append(
                ApprovalStepResult(
                    step_order=step.step_order,
                    approver=primary,
                    source="co_head",
                    explanation=(
                        f"Co-head policy allows either co-head to approve; "
                        f"{primary.name} is shown as the primary approver."
                    ),
                    alternate_approvers=alternates,
                    authority_owner_id=step.authority_owner_id,
                )
            )
        elif policy in {"both_required", "primary_then_secondary"}:
            transformed.extend(
                [
                    ApprovalStepResult(
                        step_order=step.step_order + index,
                        approver=user,
                        source="co_head",
                        explanation=(
                            "Co-head policy requires multiple approvers."
                            if policy == "both_required"
                            else "Co-head policy requires primary then secondary approval."
                        ),
                        authority_owner_id=user.id,
                    )
                    for index, user in enumerate(co_heads)
                ]
            )
        elif policy == "split_by_org_unit":
            transformed.append(
                ApprovalStepResult(
                    step_order=step.step_order,
                    approver=co_heads[0],
                    source="co_head",
                    explanation=(
                        f"Co-head routing split by org-unit selects {co_heads[0].name}."
                    ),
                    authority_owner_id=co_heads[0].id,
                )
            )
        else:
            raise RoutingError(f"Unsupported co-head policy {policy!r}.")

        _audit(
            session,
            entity_type="approval_chain",
            action="overlay_applied",
            details=f"co_head requester={requester.id} policy={policy}",
        )
        applied = True

    return transformed


def _redirect_self_approval(
    session: Session,
    requester: User,
    step: ApprovalStepResult,
) -> ApprovalStepResult:
    if step.authority_owner_id is not None:
        escalation_user = _get_active_manager(
            session, step.authority_owner_id, "Escalation"
        )
        if escalation_user is not None and escalation_user.id != requester.id:
            _audit(
                session,
                entity_type="approval_chain",
                action="self_approval_prevented",
                details=(
                    f"requester={requester.id} redirected_from={step.approver.id} "
                    f"to={escalation_user.id}"
                ),
            )
            return ApprovalStepResult(
                step_order=step.step_order,
                approver=escalation_user,
                source="self_approval_redirect",
                explanation=(
                    f"Self-approval prevented, so approval escalates to "
                    f"{escalation_user.name}."
                ),
                authority_owner_id=escalation_user.id,
            )

    fallback_step = _build_fallback_step(
        session,
        requester,
        step.step_order,
        explanation="Self-approval prevented, so department fallback applies.",
    )
    if fallback_step.approver.id == requester.id:
        raise RoutingError(
            f"Self-approval blocked for user {requester.name!r}; no valid alternative approver."
        )
    _audit(
        session,
        entity_type="approval_chain",
        action="self_approval_prevented",
        details=(
            f"requester={requester.id} redirected_from={step.approver.id} "
            f"to_fallback={fallback_step.approver.id}"
        ),
    )
    return fallback_step


def _prevent_self_approval(
    session: Session,
    requester: User,
    steps: list[ApprovalStepResult],
) -> list[ApprovalStepResult]:
    resolved: list[ApprovalStepResult] = []
    for step in steps:
        if step.effective_approver.id != requester.id:
            resolved.append(step)
            continue
        resolved.append(_redirect_self_approval(session, requester, step))
    return resolved


def _dedupe_steps(steps: list[ApprovalStepResult]) -> list[ApprovalStepResult]:
    deduped: list[ApprovalStepResult] = []
    seen: set[int] = set()
    for step in steps:
        if step.approver.id in seen:
            continue
        seen.add(step.approver.id)
        deduped.append(step)
    return deduped


def _renumber_steps(steps: list[ApprovalStepResult]) -> list[ApprovalStepResult]:
    for index, step in enumerate(steps, start=1):
        step.step_order = index
    return steps


def build_approval_chain(
    session: Session,
    requester_id: int,
    action_code: str,
    request_at: datetime | None = None,
    project_code: str | None = None,
) -> ApprovalChain:
    requester = (
        session.query(User)
        .filter(User.id == requester_id, User.is_active.is_(True))
        .first()
    )
    if requester is None:
        raise RoutingError(f"Requester id={requester_id} not found or inactive.")

    action = session.query(Action).filter(Action.code == action_code).first()
    if action is None:
        raise RoutingError(f"Action {action_code!r} not found.")

    rule = (
        session.query(ActionRoutingRule)
        .filter(
            ActionRoutingRule.action_id == action.id,
            ActionRoutingRule.dept_id == requester.dept_id,
        )
        .first()
    )
    if rule is None:
        raise RoutingError(
            f"No routing rule configured for action {action_code!r} "
            f"in department {requester.department.code!r}."
        )

    if _detect_cycle(session, requester.id):
        _audit(
            session,
            entity_type="approval_request",
            action="cycle_detected",
            details=f"Circular reporting detected for user id={requester.id}.",
        )
        raise RoutingError(
            f"Circular reporting detected for user id={requester.id}. Request blocked."
        )

    chain = ApprovalChain(requester=requester, action=action)
    if requester.dept_level.is_top_level:
        chain.steps.append(_build_fallback_step(session, requester, 1))
    else:
        _append_normal_steps(session, requester, rule, chain)

    request_at = request_at or _utcnow()
    requester_org_unit_ids = _requester_org_unit_ids(requester)

    chain.steps = _apply_handover_overlap(
        session,
        requester,
        action,
        request_at,
        chain.steps,
        requester_org_unit_ids,
    )
    chain.steps = _apply_person_overlay(
        session,
        requester,
        action,
        request_at,
        chain.steps,
        requester_org_unit_ids,
        ActingAssignment,
        "principal_user_id",
        "acting_user",
        "acting",
        additive=True,
    )
    chain.steps = _apply_person_overlay(
        session,
        requester,
        action,
        request_at,
        chain.steps,
        requester_org_unit_ids,
        DelegationAssignment,
        "delegator_user_id",
        "delegate_user",
        "delegation",
    )
    chain.steps = _apply_person_overlay(
        session,
        requester,
        action,
        request_at,
        chain.steps,
        requester_org_unit_ids,
        CoverageAssignment,
        "covered_user_id",
        "coverage_user",
        "peer_coverage",
    )
    chain.steps = _apply_project_overlay(
        session,
        requester,
        action,
        project_code,
        chain.steps,
    )
    chain.steps = _apply_co_head_policy(
        session,
        requester,
        action,
        chain.steps,
        requester_org_unit_ids,
    )
    chain.steps = _prevent_self_approval(session, requester, chain.steps)
    chain.steps = _renumber_steps(_dedupe_steps(chain.steps))

    _audit(
        session,
        entity_type="approval_chain",
        action="chain_built",
        details=(
            f"requester={requester.id} dept={requester.department.code} "
            f"action={action.code} approvers={[step.approver.id for step in chain.steps]}"
        ),
    )
    return chain
