"""
Approval routing service.

This module contains the logic to build an approval chain for a given
(requester, action) pair.

Design rules
------------
1. Look up the action routing rule for the requester's department.
2. Determine whether the requester is the top-level user in the department.
3. If top-level → use fallback approver from action_fallback_rules.
4. If not top-level → walk up the reporting-line tree to collect approvers.
   - Always collect the primary (direct) manager.
   - If the rule requires a second level, collect the manager's manager too.
5. Circular reporting-line references are detected and raise RoutingError.

Exceptions
----------
RoutingError  — raised for any invalid or unsupported routing situation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionFallbackRule,
    ActionRoutingRule,
    AuditLog,
    ReportingLine,
    User,
)


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------


class RoutingError(Exception):
    """Raised when the approval chain cannot be built."""


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class ApprovalChain:
    """The resolved approval chain for a request."""

    requester: User
    action: Action
    steps: List[_ApprovalStep] = field(default_factory=list)

    def __repr__(self) -> str:  # pragma: no cover
        step_names = [s.approver.name for s in self.steps]
        return (
            f"<ApprovalChain requester={self.requester.name!r} "
            f"action={self.action.code!r} steps={step_names}>"
        )


@dataclass
class _ApprovalStep:
    step_order: int
    approver: User
    is_fallback: bool = False


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_active_manager(session: Session, user_id: int) -> User | None:
    """Return the user's current active direct manager, or None."""
    rl = (
        session.query(ReportingLine)
        .filter(
            ReportingLine.user_id == user_id,
            ReportingLine.is_active.is_(True),
        )
        .first()
    )
    if rl is None:
        return None
    return rl.manager


def _detect_cycle(session: Session, start_user_id: int) -> bool:
    """
    Walk the reporting-line chain from *start_user_id* upward.
    Return True if a cycle is detected (visited a node twice).
    """
    visited: set[int] = set()
    current_id = start_user_id
    while True:
        if current_id in visited:
            return True
        visited.add(current_id)
        manager = _get_active_manager(session, current_id)
        if manager is None:
            return False
        current_id = manager.id


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_approval_chain(
    session: Session,
    requester_id: int,
    action_code: str,
) -> ApprovalChain:
    """
    Build and return the approval chain for a request.

    Parameters
    ----------
    session      : active SQLAlchemy Session
    requester_id : primary key of the requesting User
    action_code  : code string identifying the Action (e.g. 'annual_leave')

    Returns
    -------
    ApprovalChain

    Raises
    ------
    RoutingError
        - Requester not found or inactive
        - Action not found
        - No routing rule configured for this action / department
        - Circular reporting detected
        - Primary manager not found (and user is not top-level)
        - No fallback rule configured for top-level requester
    """
    # 1. Load requester
    requester = (
        session.query(User)
        .filter(User.id == requester_id, User.is_active.is_(True))
        .first()
    )
    if requester is None:
        raise RoutingError(f"Requester id={requester_id} not found or inactive.")

    # 2. Load action
    action = session.query(Action).filter(Action.code == action_code).first()
    if action is None:
        raise RoutingError(
            f"No routing rule found: action code {action_code!r} does not exist."
        )

    dept_id = requester.dept_id

    # 3. Load routing rule
    rule: ActionRoutingRule | None = (
        session.query(ActionRoutingRule)
        .filter(
            ActionRoutingRule.action_id == action.id,
            ActionRoutingRule.dept_id == dept_id,
        )
        .first()
    )
    if rule is None:
        raise RoutingError(
            f"No routing rule found for action {action_code!r} "
            f"in department id={dept_id}."
        )

    # 4. Cycle detection
    if _detect_cycle(session, requester_id):
        _audit(
            session,
            entity_type="approval_request",
            entity_id=None,
            action="cycle_detected",
            details=f"Circular reporting detected for user id={requester_id}.",
        )
        raise RoutingError(
            f"Circular reporting detected for user id={requester_id}. "
            "Request blocked."
        )

    # 5. Is this user the top-level in the department?
    is_top_level = requester.dept_level.is_top_level

    if is_top_level:
        return _build_fallback_chain(session, requester, action, dept_id)

    # 6. Normal routing: walk up the reporting tree
    return _build_normal_chain(session, requester, action, rule)


def _build_normal_chain(
    session: Session,
    requester: User,
    action: Action,
    rule: ActionRoutingRule,
) -> ApprovalChain:
    """Build chain for a non-top-level requester."""
    chain = ApprovalChain(requester=requester, action=action)

    # Primary manager
    primary_manager = _get_active_manager(session, requester.id)
    if primary_manager is None:
        raise RoutingError(
            f"Primary manager not found for user id={requester.id} "
            f"({requester.name!r}). Cannot build approval chain."
        )
    chain.steps.append(_ApprovalStep(step_order=1, approver=primary_manager))

    # Second-level manager (only if required and available)
    if rule.requires_second_level:
        second_manager = _get_active_manager(session, primary_manager.id)
        if second_manager is not None:
            chain.steps.append(
                _ApprovalStep(step_order=2, approver=second_manager)
            )

    _audit(
        session,
        entity_type="approval_chain",
        entity_id=None,
        action="chain_built",
        details=(
            f"requester={requester.id} action={action.code!r} "
            f"steps={[s.approver.id for s in chain.steps]}"
        ),
    )
    return chain


def _build_fallback_chain(
    session: Session,
    requester: User,
    action: Action,
    dept_id: int,
) -> ApprovalChain:
    """Build chain using the fallback rule for a top-level requester."""
    fallback_rule: ActionFallbackRule | None = (
        session.query(ActionFallbackRule)
        .filter(
            ActionFallbackRule.action_id == action.id,
            ActionFallbackRule.dept_id == dept_id,
        )
        .first()
    )
    if fallback_rule is None:
        raise RoutingError(
            f"No fallback rule configured for action {action.code!r} "
            f"in department id={dept_id} for top-level requester id={requester.id}."
        )

    chain = ApprovalChain(requester=requester, action=action)
    chain.steps.append(
        _ApprovalStep(
            step_order=1,
            approver=fallback_rule.fallback_user,
            is_fallback=True,
        )
    )

    _audit(
        session,
        entity_type="approval_chain",
        entity_id=None,
        action="fallback_chain_built",
        details=(
            f"requester={requester.id} action={action.code!r} "
            f"fallback_user={fallback_rule.fallback_user_id} "
            f"label={fallback_rule.fallback_label!r}"
        ),
    )
    return chain


# ---------------------------------------------------------------------------
# Audit helper
# ---------------------------------------------------------------------------


def _audit(
    session: Session,
    entity_type: str,
    entity_id: int | None,
    action: str,
    details: str | None = None,
) -> None:
    log = AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        details=details,
    )
    session.add(log)
    session.flush()
