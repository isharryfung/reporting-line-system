"""Org chart query helpers."""

from __future__ import annotations

from sqlalchemy.orm import Session

from src.models import (
    CoHeadAssignment,
    Department,
    DepartmentFallbackRule,
    OrgUnitMembership,
    User,
)


def get_department_org_chart(session: Session, department_code: str) -> dict[str, object]:
    department = (
        session.query(Department).filter(Department.code == department_code).first()
    )
    if department is None:
        raise ValueError(f"Department {department_code!r} not found.")

    lead_memberships = (
        session.query(OrgUnitMembership)
        .join(OrgUnitMembership.user)
        .filter(
            OrgUnitMembership.is_active.is_(True),
            OrgUnitMembership.is_team_lead.is_(True),
            User.dept_id == department.id,
            User.is_active.is_(True),
        )
        .all()
    )
    team_lead_ids = {membership.user_id for membership in lead_memberships}
    co_head_assignments = (
        session.query(CoHeadAssignment)
        .filter(CoHeadAssignment.is_active.is_(True))
        .all()
    )

    fallback_rule = (
        session.query(DepartmentFallbackRule)
        .filter(DepartmentFallbackRule.dept_id == department.id)
        .first()
    )

    department_users = (
        session.query(User)
        .filter(User.dept_id == department.id, User.is_active.is_(True))
        .all()
    )

    assigned_user_ids: set[int] = set()
    org_units_payload: list[dict[str, object]] = []
    for org_unit in sorted(department.org_units, key=lambda item: item.name):
        active_memberships = [
            membership
            for membership in org_unit.memberships
            if membership.is_active and membership.user.is_active
        ]
        assigned_user_ids.update(membership.user_id for membership in active_memberships)
        ordered_memberships = sorted(
            active_memberships,
            key=lambda membership: (
                membership.user.dept_level.level_rank,
                membership.user.name,
            ),
        )
        org_units_payload.append(
            {
                "id": org_unit.id,
                "code": org_unit.code,
                "name": org_unit.name,
                "co_heads": [
                    {
                        "name": assignment.user.name,
                        "policy": assignment.policy,
                        "is_primary": assignment.is_primary,
                    }
                    for assignment in sorted(
                        [
                            assignment
                            for assignment in co_head_assignments
                            if assignment.org_unit_id == org_unit.id
                            and assignment.user is not None
                            and assignment.user.is_active
                        ],
                        key=lambda item: (
                            0 if item.is_primary else 1,
                            item.sequence_order,
                            item.user.name,
                        ),
                    )
                ],
                "team_leads": [
                    _serialize_user(membership.user, True)
                    for membership in ordered_memberships
                    if membership.is_team_lead
                ],
                "members": [
                    _serialize_user(
                        membership.user,
                        membership.user_id in team_lead_ids,
                    )
                    for membership in ordered_memberships
                ],
            }
        )

    unassigned_users = [
        _serialize_user(user, user.id in team_lead_ids)
        for user in sorted(
            department_users,
            key=lambda item: (item.dept_level.level_rank, item.name),
        )
        if user.id not in assigned_user_ids
    ]

    return {
        "department": {
            "id": department.id,
            "code": department.code,
            "name": department.name,
        },
        "fallback_approver": None
        if fallback_rule is None
        else {
            "id": fallback_rule.fallback_user.id,
            "name": fallback_rule.fallback_user.name,
            "label": fallback_rule.fallback_label,
            "department": fallback_rule.fallback_user.department.code,
        },
        "org_units": org_units_payload,
        "unassigned_users": unassigned_users,
    }


def _serialize_user(user: User, is_team_lead: bool) -> dict[str, object]:
    memberships = [
        membership.org_unit.name
        for membership in user.org_unit_memberships
        if membership.is_active
    ]
    manager_name = _get_manager_name(user)
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "level_name": user.dept_level.level_name,
        "level_rank": user.dept_level.level_rank,
        "department_code": user.department.code,
        "manager_name": manager_name,
        "org_units": memberships,
        "is_team_lead": is_team_lead,
        "is_top_level": user.dept_level.is_top_level,
    }


def _get_manager_name(user: User) -> str | None:
    active_lines = [
        line
        for line in user.reporting_lines
        if line.is_active and line.is_primary and line.manager is not None
    ]
    if len(active_lines) > 1:
        return "Multiple active primary managers"
    if not active_lines:
        return None
    return active_lines[0].manager.name
