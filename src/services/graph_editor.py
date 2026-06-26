"""Graph editing helpers for the manual POC UI."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    Department,
    DepartmentFallbackRule,
    DeptLevel,
    OrgUnit,
    OrgUnitMembership,
    ReportingLine,
    User,
)
from src.services.org_chart import get_department_org_chart
from src.services.permissions import validate_team_lead_edit_permission


class GraphEditError(Exception):
    """Raised when a graph edit request is invalid."""


@dataclass
class GraphEditResult:
    status: str
    message: str
    data: dict[str, Any]


def list_customization_options(session: Session) -> dict[str, Any]:
    departments = (
        session.query(Department).order_by(Department.name.asc()).all()
    )
    levels = (
        session.query(DeptLevel).order_by(DeptLevel.dept_id.asc(), DeptLevel.level_rank.asc()).all()
    )
    org_units = (
        session.query(OrgUnit).order_by(OrgUnit.name.asc()).all()
    )
    actions = session.query(Action).order_by(Action.name.asc()).all()
    users = session.query(User).filter(User.is_active.is_(True)).order_by(User.name.asc()).all()
    return {
        "departments": [{"id": item.id, "code": item.code, "name": item.name} for item in departments],
        "levels": [
            {
                "id": item.id,
                "dept_id": item.dept_id,
                "level_rank": item.level_rank,
                "level_name": item.level_name,
                "is_top_level": item.is_top_level,
            }
            for item in levels
        ],
        "org_units": [
            {"id": item.id, "dept_id": item.dept_id, "code": item.code, "name": item.name}
            for item in org_units
        ],
        "actions": [
            {"id": item.id, "code": item.code, "name": item.name}
            for item in actions
        ],
        "users": [
            {
                "id": item.id,
                "name": item.name,
                "department_code": item.department.code,
                "level_name": item.dept_level.level_name,
                "level_rank": item.dept_level.level_rank,
            }
            for item in users
        ],
        "approval_levels": [
            {"code": "first_level", "label": "1st Level"},
            {"code": "second_level", "label": "2nd Level"},
        ],
    }


def apply_user_edit(
    session: Session,
    *,
    editor_id: int | None,
    editor_scope: str,
    target_user_id: int,
    department_id: int | None = None,
    level_id: int | None = None,
    org_unit_id: int | None = None,
    manager_id: int | None = None,
    is_team_lead: bool | None = None,
) -> GraphEditResult:
    target = session.get(User, target_user_id)
    if target is None or not target.is_active:
        raise GraphEditError("Target user not found or inactive.")

    if editor_scope == "team_lead":
        if editor_id is None:
            raise GraphEditError("Editor is required for team-lead edits.")
        decision = validate_team_lead_edit_permission(
            session, editor_id=editor_id, target_user_id=target_user_id
        )
        if not decision.allowed:
            raise GraphEditError(decision.reason)
    elif target.dept_level.is_top_level and editor_scope != "hro":
        raise GraphEditError("Protected highest-level users can be edited only by HRO.")

    new_department = target.department
    if department_id is not None:
        department = session.get(Department, department_id)
        if department is None:
            raise GraphEditError("Selected department was not found.")
        new_department = department
        target.dept_id = department.id

    if level_id is not None:
        level = session.get(DeptLevel, level_id)
        if level is None:
            raise GraphEditError("Selected level was not found.")
        if level.dept_id != new_department.id:
            raise GraphEditError("Selected level does not belong to the selected department.")
        target.dept_level_id = level.id

    active_primary_lines = _active_primary_lines(session, target.id)
    if len(active_primary_lines) > 1:
        raise GraphEditError("Target user has multiple active primary managers.")

    if manager_id is not None:
        manager = session.get(User, manager_id)
        if manager is None or not manager.is_active:
            raise GraphEditError("Primary manager not found or inactive.")
        if manager.id == target.id:
            raise GraphEditError("A user cannot report to themselves.")
        if manager.dept_id != target.dept_id:
            raise GraphEditError("Primary manager must belong to the same department.")
        if _creates_circular_reporting(session, target.id, manager.id):
            raise GraphEditError("Circular reporting line detected.")

        if active_primary_lines:
            active_primary_lines[0].manager_id = manager.id
            active_primary_lines[0].dept_id = target.dept_id
            active_primary_lines[0].is_active = True
            active_primary_lines[0].is_primary = True
        else:
            session.add(
                ReportingLine(
                    user_id=target.id,
                    manager_id=manager.id,
                    dept_id=target.dept_id,
                    is_primary=True,
                    is_active=True,
                )
            )

    if org_unit_id is not None:
        org_unit = session.get(OrgUnit, org_unit_id)
        if org_unit is None:
            raise GraphEditError("Selected org-unit was not found.")
        if org_unit.dept_id != target.dept_id:
            raise GraphEditError("Selected org-unit must belong to the selected department.")
        _set_active_org_unit_membership(session, target.id, org_unit.id)

    if is_team_lead is not None:
        membership = _get_active_membership(session, target.id)
        if membership is None:
            raise GraphEditError("Target user must belong to an org-unit before team-lead assignment.")
        membership.is_team_lead = is_team_lead

    # If department changed and manager edit was omitted, ensure active manager still valid.
    if department_id is not None and manager_id is None and active_primary_lines:
        existing_manager = session.get(User, active_primary_lines[0].manager_id)
        if existing_manager is None or existing_manager.dept_id != target.dept_id:
            raise GraphEditError(
                "Changing department requires selecting a valid primary manager in the same department."
            )

    session.flush()
    if len(_active_primary_lines(session, target.id)) > 1:
        raise GraphEditError("One staff member can have only one active official primary manager.")
    session.commit()

    return GraphEditResult(
        status="success",
        message="Graph edit applied.",
        data={
            "target_user_id": target.id,
            "department_code": target.department.code,
            "level_name": target.dept_level.level_name,
            "level_rank": target.dept_level.level_rank,
            "org_chart": get_department_org_chart(session, target.department.code),
        },
    )


def update_routing_rule(
    session: Session,
    *,
    department_code: str,
    action_code: str,
    approval_level: str,
) -> GraphEditResult:
    department = (
        session.query(Department).filter(Department.code == department_code).first()
    )
    action = session.query(Action).filter(Action.code == action_code).first()
    if department is None or action is None:
        raise GraphEditError("Department or action not found.")

    requires_second_level = approval_level == "second_level"
    rule = (
        session.query(ActionRoutingRule)
        .filter(
            ActionRoutingRule.action_id == action.id,
            ActionRoutingRule.dept_id == department.id,
        )
        .first()
    )
    if rule is None:
        rule = ActionRoutingRule(
            action_id=action.id,
            dept_id=department.id,
            requires_primary=True,
            requires_second_level=requires_second_level,
        )
        session.add(rule)
    else:
        rule.requires_primary = True
        rule.requires_second_level = requires_second_level

    session.commit()
    return GraphEditResult(
        status="success",
        message="Routing rule updated.",
        data={
            "department_code": department.code,
            "action_code": action.code,
            "approval_level": "second_level" if rule.requires_second_level else "first_level",
        },
    )


def update_department_fallback(
    session: Session,
    *,
    department_code: str,
    fallback_user_id: int,
    label: str | None = None,
) -> GraphEditResult:
    department = (
        session.query(Department).filter(Department.code == department_code).first()
    )
    fallback_user = session.get(User, fallback_user_id)
    if department is None or fallback_user is None or not fallback_user.is_active:
        raise GraphEditError("Department or fallback user not found or inactive.")
    rule = (
        session.query(DepartmentFallbackRule)
        .filter(DepartmentFallbackRule.dept_id == department.id)
        .first()
    )
    if rule is None:
        rule = DepartmentFallbackRule(
            dept_id=department.id,
            fallback_user_id=fallback_user.id,
            fallback_label=label or fallback_user.dept_level.level_name,
        )
        session.add(rule)
    else:
        rule.fallback_user_id = fallback_user.id
        if label:
            rule.fallback_label = label

    session.commit()
    return GraphEditResult(
        status="success",
        message="Fallback approver updated.",
        data={
            "department_code": department.code,
            "fallback_user": fallback_user.name,
            "fallback_user_id": fallback_user.id,
            "fallback_label": rule.fallback_label,
        },
    )


def _active_primary_lines(session: Session, user_id: int) -> list[ReportingLine]:
    return (
        session.query(ReportingLine)
        .filter(
            ReportingLine.user_id == user_id,
            ReportingLine.is_active.is_(True),
            ReportingLine.is_primary.is_(True),
        )
        .all()
    )


def _get_active_membership(session: Session, user_id: int) -> OrgUnitMembership | None:
    return (
        session.query(OrgUnitMembership)
        .filter(
            OrgUnitMembership.user_id == user_id,
            OrgUnitMembership.is_active.is_(True),
        )
        .first()
    )


def _set_active_org_unit_membership(session: Session, user_id: int, org_unit_id: int) -> None:
    memberships = (
        session.query(OrgUnitMembership)
        .filter(OrgUnitMembership.user_id == user_id)
        .all()
    )
    target_membership = None
    for membership in memberships:
        if membership.org_unit_id == org_unit_id:
            target_membership = membership
            membership.is_active = True
        else:
            membership.is_active = False
            membership.is_team_lead = False

    if target_membership is None:
        target_membership = OrgUnitMembership(
            org_unit_id=org_unit_id,
            user_id=user_id,
            is_active=True,
            is_team_lead=False,
        )
        session.add(target_membership)


def _creates_circular_reporting(
    session: Session, target_user_id: int, manager_id: int
) -> bool:
    visited = {target_user_id}
    current_id = manager_id
    while True:
        if current_id in visited:
            return True
        visited.add(current_id)
        primary_line = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id == current_id,
                ReportingLine.is_active.is_(True),
                ReportingLine.is_primary.is_(True),
            )
            .first()
        )
        if primary_line is None:
            return False
        current_id = primary_line.manager_id
