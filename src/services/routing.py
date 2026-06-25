"""Approval routing service."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    AuditLog,
    DepartmentFallbackRule,
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
            }
            for step in chain.steps
        ],
    }


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
    )


def build_approval_chain(
    session: Session,
    requester_id: int,
    action_code: str,
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

    chain.steps.append(ApprovalStepResult(step_order=1, approver=primary_manager))

    if not rule.requires_second_level:
        return

    second_manager = _get_active_manager(session, primary_manager.id, "Second-level")
    if second_manager is None:
        chain.steps.append(_build_fallback_step(session, requester, 2))
        return

    chain.steps.append(ApprovalStepResult(step_order=2, approver=second_manager))


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
