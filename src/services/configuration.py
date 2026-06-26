"""Configurable data and editable diagram helpers for the POC."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    ActingAssignment,
    CoHeadAssignment,
    CoverageAssignment,
    DelegationAssignment,
    Department,
    DepartmentFallbackRule,
    DeptLevel,
    HandoverOverlap,
    OrgUnit,
    OrgUnitMembership,
    ReportingLine,
    User,
)
from src.services.permissions import validate_team_lead_edit_permission


class ConfigurationError(ValueError):
    """Raised when configurable data edits are invalid."""


@dataclass
class DiagramEditResult:
    target_user_id: int
    manager_id: int | None
    department_id: int
    dept_level_id: int
    org_unit_ids: list[int]
    is_team_lead: bool


OVERLAY_MODELS: dict[str, type[Any]] = {
    "acting_assignments": ActingAssignment,
    "delegation_assignments": DelegationAssignment,
    "coverage_assignments": CoverageAssignment,
    "handover_overlaps": HandoverOverlap,
    "co_head_assignments": CoHeadAssignment,
}


def _require_active_user(session: Session, user_id: int, label: str) -> User:
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise ConfigurationError(f"{label} user id={user_id} not found or inactive.")
    return user


def _get_primary_line(session: Session, user_id: int) -> ReportingLine | None:
    lines = (
        session.query(ReportingLine)
        .filter(
            ReportingLine.user_id == user_id,
            ReportingLine.is_active.is_(True),
            ReportingLine.is_primary.is_(True),
        )
        .all()
    )
    if len(lines) > 1:
        raise ConfigurationError(
            f"User id={user_id} has more than one active primary manager."
        )
    return lines[0] if lines else None


def _would_create_cycle(session: Session, user_id: int, manager_id: int) -> bool:
    seen = {user_id}
    current_id = manager_id
    while True:
        if current_id in seen:
            return True
        seen.add(current_id)
        line = _get_primary_line(session, current_id)
        if line is None:
            return False
        current_id = line.manager_id


def _validate_dept_level_for_department(dept_level: DeptLevel, dept_id: int) -> None:
    if dept_level.dept_id != dept_id:
        raise ConfigurationError(
            "Selected department level does not belong to the selected department."
        )


def _validate_org_units_for_department(org_units: list[OrgUnit], dept_id: int) -> None:
    if any(org_unit.dept_id != dept_id for org_unit in org_units):
        raise ConfigurationError(
            "Selected org-unit does not belong to the selected department."
        )


def _set_primary_manager(
    session: Session,
    target: User,
    manager_id: int | None,
    dept_id: int,
) -> None:
    if manager_id is None:
        return
    if manager_id == target.id:
        raise ConfigurationError("A user cannot be their own primary manager.")

    manager = _require_active_user(session, manager_id, "Primary manager")
    if manager.dept_id != dept_id:
        raise ConfigurationError(
            "Primary manager must belong to the same department as the target user."
        )

    if _would_create_cycle(session, target.id, manager.id):
        raise ConfigurationError("Circular reporting detected. Diagram edit blocked.")

    existing_primary = (
        session.query(ReportingLine)
        .filter(
            ReportingLine.user_id == target.id,
            ReportingLine.is_primary.is_(True),
            ReportingLine.is_active.is_(True),
        )
        .all()
    )
    for line in existing_primary:
        line.is_active = False

    session.add(
        ReportingLine(
            user_id=target.id,
            manager_id=manager.id,
            dept_id=dept_id,
            is_primary=True,
            is_active=True,
        )
    )


def apply_diagram_edit(
    session: Session,
    *,
    target_user_id: int,
    editor_user_id: int | None = None,
    dept_id: int | None = None,
    dept_level_id: int | None = None,
    manager_id: int | None = None,
    org_unit_ids: list[int] | None = None,
    is_team_lead: bool | None = None,
) -> DiagramEditResult:
    target = _require_active_user(session, target_user_id, "Target")

    if editor_user_id is not None:
        decision = validate_team_lead_edit_permission(
            session,
            editor_id=editor_user_id,
            target_user_id=target_user_id,
        )
        if not decision.allowed:
            raise ConfigurationError(decision.reason)

    if target.dept_level.is_top_level and (
        (dept_level_id is not None and dept_level_id != target.dept_level_id)
        or (dept_id is not None and dept_id != target.dept_id)
        or manager_id is not None
    ):
        raise ConfigurationError(
            "Protected highest department level cannot be modified from diagram editor."
        )

    next_dept_id = dept_id if dept_id is not None else target.dept_id
    department = session.get(Department, next_dept_id)
    if department is None:
        raise ConfigurationError(f"Department id={next_dept_id} not found.")

    next_level_id = dept_level_id if dept_level_id is not None else target.dept_level_id
    dept_level = session.get(DeptLevel, next_level_id)
    if dept_level is None:
        raise ConfigurationError(f"Department level id={next_level_id} not found.")
    _validate_dept_level_for_department(dept_level, next_dept_id)

    requested_org_units = org_unit_ids
    if requested_org_units is not None:
        org_units = [session.get(OrgUnit, org_unit_id) for org_unit_id in requested_org_units]
        if any(org_unit is None for org_unit in org_units):
            raise ConfigurationError("One or more selected org-units were not found.")
        typed_org_units = [org_unit for org_unit in org_units if org_unit is not None]
        _validate_org_units_for_department(typed_org_units, next_dept_id)
    else:
        typed_org_units = [
            membership.org_unit
            for membership in target.org_unit_memberships
            if membership.is_active and membership.org_unit is not None
        ]

    target.dept_id = next_dept_id
    target.dept_level_id = next_level_id

    memberships = (
        session.query(OrgUnitMembership)
        .filter(OrgUnitMembership.user_id == target.id)
        .all()
    )
    if requested_org_units is not None:
        selected_ids = {org_unit.id for org_unit in typed_org_units}
        for membership in memberships:
            membership.is_active = membership.org_unit_id in selected_ids

        existing_ids = {membership.org_unit_id for membership in memberships}
        for org_unit_id in selected_ids:
            if org_unit_id in existing_ids:
                continue
            session.add(
                OrgUnitMembership(
                    org_unit_id=org_unit_id,
                    user_id=target.id,
                    is_team_lead=False,
                    is_active=True,
                )
            )

    if is_team_lead is not None:
        active_memberships = [
            membership
            for membership in session.query(OrgUnitMembership)
            .filter(
                OrgUnitMembership.user_id == target.id,
                OrgUnitMembership.is_active.is_(True),
            )
            .all()
        ]
        if is_team_lead and not active_memberships:
            raise ConfigurationError("User must belong to at least one org-unit to be team lead.")
        for membership in active_memberships:
            membership.is_team_lead = is_team_lead

    if manager_id is not None:
        _set_primary_manager(session, target, manager_id, next_dept_id)

    session.commit()

    active_org_unit_ids = [
        membership.org_unit_id
        for membership in session.query(OrgUnitMembership)
        .filter(
            OrgUnitMembership.user_id == target.id,
            OrgUnitMembership.is_active.is_(True),
        )
        .all()
    ]
    active_is_team_lead = any(
        membership.is_team_lead
        for membership in session.query(OrgUnitMembership)
        .filter(
            OrgUnitMembership.user_id == target.id,
            OrgUnitMembership.is_active.is_(True),
        )
        .all()
    )
    primary_line = _get_primary_line(session, target.id)

    return DiagramEditResult(
        target_user_id=target.id,
        manager_id=None if primary_line is None else primary_line.manager_id,
        department_id=target.dept_id,
        dept_level_id=target.dept_level_id,
        org_unit_ids=sorted(active_org_unit_ids),
        is_team_lead=active_is_team_lead,
    )


def apply_configuration_change(
    session: Session,
    *,
    entity: str,
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    operation = operation.lower()
    if operation not in {"upsert", "delete", "activate", "deactivate"}:
        raise ConfigurationError(f"Unsupported operation {operation!r}.")

    entity_key = entity.lower()

    if entity_key == "users":
        return _mutate_user(session, operation, payload)
    if entity_key == "dept_levels":
        return _mutate_level(session, operation, payload)
    if entity_key == "departments":
        return _mutate_department(session, operation, payload)
    if entity_key == "org_units":
        return _mutate_org_unit(session, operation, payload)
    if entity_key == "actions":
        return _mutate_action(session, operation, payload)
    if entity_key == "action_routing_rules":
        return _mutate_action_routing_rule(session, operation, payload)
    if entity_key == "reporting_lines":
        return _mutate_reporting_line(session, operation, payload)
    if entity_key == "department_fallback_rules":
        return _mutate_fallback_rule(session, operation, payload)
    if entity_key in OVERLAY_MODELS:
        return _mutate_overlay(session, entity_key, operation, payload)

    raise ConfigurationError(f"Unsupported entity {entity!r}.")


def _mutate_department(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    department_id = payload.get("id")
    department = session.get(Department, department_id) if department_id else None

    if operation == "delete":
        if department is None:
            raise ConfigurationError("Department id is required for delete.")
        session.delete(department)
        session.commit()
        return {"id": department_id, "deleted": True}

    if department is None:
        department = Department(name=str(payload["name"]), code=str(payload["code"]))
        session.add(department)
    else:
        department.name = str(payload.get("name", department.name))
        department.code = str(payload.get("code", department.code))

    session.commit()
    return {"id": department.id, "name": department.name, "code": department.code}


def _mutate_level(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    level_id = payload.get("id")
    level = session.get(DeptLevel, level_id) if level_id else None

    if operation == "delete":
        if level is None:
            raise ConfigurationError("Department level id is required for delete.")
        if level.is_top_level:
            raise ConfigurationError("Protected highest level cannot be deleted.")
        session.delete(level)
        session.commit()
        return {"id": level_id, "deleted": True}

    if level is None:
        level = DeptLevel(
            dept_id=int(payload["dept_id"]),
            level_rank=int(payload["level_rank"]),
            level_name=str(payload["level_name"]),
            is_top_level=bool(payload.get("is_top_level", False)),
        )
        session.add(level)
    else:
        if level.is_top_level and payload.get("is_top_level") is False:
            raise ConfigurationError("Protected highest level cannot be downgraded.")
        level.dept_id = int(payload.get("dept_id", level.dept_id))
        level.level_rank = int(payload.get("level_rank", level.level_rank))
        level.level_name = str(payload.get("level_name", level.level_name))
        if "is_top_level" in payload:
            level.is_top_level = bool(payload["is_top_level"])

    session.commit()
    return {
        "id": level.id,
        "dept_id": level.dept_id,
        "level_rank": level.level_rank,
        "level_name": level.level_name,
        "is_top_level": level.is_top_level,
    }


def _mutate_user(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    user_id = payload.get("id")
    user = session.get(User, user_id) if user_id else None

    if operation in {"activate", "deactivate"}:
        if user is None:
            raise ConfigurationError("User id is required for activation change.")
        user.is_active = operation == "activate"
        session.commit()
        return {"id": user.id, "is_active": user.is_active}

    if operation == "delete":
        if user is None:
            raise ConfigurationError("User id is required for delete.")
        session.delete(user)
        session.commit()
        return {"id": user_id, "deleted": True}

    if user is None:
        user = User(
            name=str(payload["name"]),
            email=str(payload["email"]),
            dept_id=int(payload["dept_id"]),
            dept_level_id=int(payload["dept_level_id"]),
            is_active=bool(payload.get("is_active", True)),
        )
        session.add(user)
        session.flush()
    else:
        user.name = str(payload.get("name", user.name))
        user.email = str(payload.get("email", user.email))
        user.dept_id = int(payload.get("dept_id", user.dept_id))
        user.dept_level_id = int(payload.get("dept_level_id", user.dept_level_id))
        if "is_active" in payload:
            user.is_active = bool(payload["is_active"])

    dept_level = session.get(DeptLevel, user.dept_level_id)
    if dept_level is None:
        raise ConfigurationError("Selected department level was not found.")
    _validate_dept_level_for_department(dept_level, user.dept_id)

    requested_org_units = payload.get("org_unit_ids")
    if requested_org_units is not None:
        apply_diagram_edit(
            session,
            target_user_id=user.id,
            dept_id=user.dept_id,
            dept_level_id=user.dept_level_id,
            org_unit_ids=[int(org_unit_id) for org_unit_id in requested_org_units],
            is_team_lead=bool(payload.get("is_team_lead", False)),
            manager_id=payload.get("manager_id"),
        )
        return {"id": user.id, "updated_via_diagram": True}

    session.commit()
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "dept_id": user.dept_id,
        "dept_level_id": user.dept_level_id,
        "is_active": user.is_active,
    }


def _mutate_org_unit(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    org_unit_id = payload.get("id")
    org_unit = session.get(OrgUnit, org_unit_id) if org_unit_id else None

    if operation == "delete":
        if org_unit is None:
            raise ConfigurationError("Org-unit id is required for delete.")
        session.delete(org_unit)
        session.commit()
        return {"id": org_unit_id, "deleted": True}

    if org_unit is None:
        org_unit = OrgUnit(
            dept_id=int(payload["dept_id"]),
            code=str(payload["code"]),
            name=str(payload["name"]),
        )
        session.add(org_unit)
    else:
        org_unit.dept_id = int(payload.get("dept_id", org_unit.dept_id))
        org_unit.code = str(payload.get("code", org_unit.code))
        org_unit.name = str(payload.get("name", org_unit.name))

    session.commit()
    return {
        "id": org_unit.id,
        "dept_id": org_unit.dept_id,
        "name": org_unit.name,
        "code": org_unit.code,
    }


def _mutate_action(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    action_id = payload.get("id")
    action = session.get(Action, action_id) if action_id else None

    if operation == "delete":
        if action is None:
            raise ConfigurationError("Action id is required for delete.")
        session.delete(action)
        session.commit()
        return {"id": action_id, "deleted": True}

    if action is None:
        action = Action(
            name=str(payload["name"]),
            code=str(payload["code"]),
            is_project_scoped=bool(payload.get("is_project_scoped", False)),
        )
        session.add(action)
    else:
        action.name = str(payload.get("name", action.name))
        action.code = str(payload.get("code", action.code))
        if "is_project_scoped" in payload:
            action.is_project_scoped = bool(payload["is_project_scoped"])

    session.commit()
    return {
        "id": action.id,
        "name": action.name,
        "code": action.code,
        "is_project_scoped": action.is_project_scoped,
    }


def _mutate_action_routing_rule(
    session: Session,
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    rule_id = payload.get("id")
    rule = session.get(ActionRoutingRule, rule_id) if rule_id else None

    if rule is None and rule_id is None:
        action_id = int(payload["action_id"])
        dept_id = int(payload["dept_id"])
        rule = (
            session.query(ActionRoutingRule)
            .filter(
                ActionRoutingRule.action_id == action_id,
                ActionRoutingRule.dept_id == dept_id,
            )
            .first()
        )

    if operation == "delete":
        if rule is None:
            raise ConfigurationError("Routing rule id (or action_id + dept_id) required for delete.")
        session.delete(rule)
        session.commit()
        return {"id": rule.id, "deleted": True}

    if rule is None:
        rule = ActionRoutingRule(
            action_id=int(payload["action_id"]),
            dept_id=int(payload["dept_id"]),
            requires_primary=bool(payload.get("requires_primary", True)),
            requires_second_level=bool(payload.get("requires_second_level", False)),
        )
        session.add(rule)
    else:
        rule.requires_primary = bool(payload.get("requires_primary", rule.requires_primary))
        rule.requires_second_level = bool(
            payload.get("requires_second_level", rule.requires_second_level)
        )

    session.commit()
    return {
        "id": rule.id,
        "action_id": rule.action_id,
        "dept_id": rule.dept_id,
        "requires_primary": rule.requires_primary,
        "requires_second_level": rule.requires_second_level,
    }


def _mutate_reporting_line(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    line_id = payload.get("id")
    line = session.get(ReportingLine, line_id) if line_id else None

    if operation in {"activate", "deactivate"}:
        if line is None:
            raise ConfigurationError("Reporting line id is required for activation change.")
        line.is_active = operation == "activate"
        session.commit()
        return {"id": line.id, "is_active": line.is_active}

    if operation == "delete":
        if line is None:
            raise ConfigurationError("Reporting line id is required for delete.")
        session.delete(line)
        session.commit()
        return {"id": line_id, "deleted": True}

    user = _require_active_user(session, int(payload["user_id"]), "Target")
    manager = _require_active_user(session, int(payload["manager_id"]), "Manager")
    if user.id == manager.id:
        raise ConfigurationError("A user cannot report to themselves.")
    if user.dept_id != manager.dept_id:
        raise ConfigurationError("Primary manager must belong to the same department.")
    if _would_create_cycle(session, user.id, manager.id):
        raise ConfigurationError("Circular reporting detected. Configuration blocked.")

    if line is None:
        line = ReportingLine(
            user_id=user.id,
            manager_id=manager.id,
            dept_id=user.dept_id,
            is_primary=bool(payload.get("is_primary", True)),
            is_active=bool(payload.get("is_active", True)),
        )
        session.add(line)
    else:
        line.user_id = user.id
        line.manager_id = manager.id
        line.dept_id = user.dept_id
        line.is_primary = bool(payload.get("is_primary", line.is_primary))
        line.is_active = bool(payload.get("is_active", line.is_active))

    if line.is_primary and line.is_active:
        other_primary = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id == user.id,
                ReportingLine.is_primary.is_(True),
                ReportingLine.is_active.is_(True),
                ReportingLine.id != line.id,
            )
            .all()
        )
        for existing in other_primary:
            existing.is_active = False

    session.commit()
    return {
        "id": line.id,
        "user_id": line.user_id,
        "manager_id": line.manager_id,
        "dept_id": line.dept_id,
        "is_primary": line.is_primary,
        "is_active": line.is_active,
    }


def _mutate_fallback_rule(session: Session, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    rule_id = payload.get("id")
    rule = session.get(DepartmentFallbackRule, rule_id) if rule_id else None

    if rule is None and rule_id is None and "dept_id" in payload:
        rule = (
            session.query(DepartmentFallbackRule)
            .filter(DepartmentFallbackRule.dept_id == int(payload["dept_id"]))
            .first()
        )

    if operation == "delete":
        if rule is None:
            raise ConfigurationError("Fallback rule id (or dept_id) is required for delete.")
        session.delete(rule)
        session.commit()
        return {"id": rule.id, "deleted": True}

    fallback_user = _require_active_user(
        session,
        int(payload["fallback_user_id"]),
        "Fallback approver",
    )

    if rule is None:
        rule = DepartmentFallbackRule(
            dept_id=int(payload["dept_id"]),
            fallback_user_id=fallback_user.id,
            fallback_label=str(payload.get("fallback_label", fallback_user.name)),
        )
        session.add(rule)
    else:
        rule.dept_id = int(payload.get("dept_id", rule.dept_id))
        rule.fallback_user_id = fallback_user.id
        rule.fallback_label = str(payload.get("fallback_label", rule.fallback_label))

    session.commit()
    return {
        "id": rule.id,
        "dept_id": rule.dept_id,
        "fallback_user_id": rule.fallback_user_id,
        "fallback_label": rule.fallback_label,
    }


def _parse_datetime(raw: Any) -> datetime:
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, str):
        return datetime.fromisoformat(raw)
    raise ConfigurationError("Expected datetime in ISO string format.")


def _mutate_overlay(
    session: Session,
    entity_key: str,
    operation: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    model = OVERLAY_MODELS[entity_key]
    record_id = payload.get("id")
    record = session.get(model, record_id) if record_id else None

    if record is None:
        raise ConfigurationError(
            f"POC supports activate/deactivate only for {entity_key}; provide existing id."
        )

    if operation == "activate":
        record.is_active = True
    elif operation == "deactivate":
        record.is_active = False
    elif operation == "delete":
        session.delete(record)
    elif operation == "upsert":
        if "effective_from" in payload:
            record.effective_from = _parse_datetime(payload["effective_from"])
        if "effective_to" in payload:
            record.effective_to = _parse_datetime(payload["effective_to"])
        if "policy" in payload and hasattr(record, "policy"):
            record.policy = str(payload["policy"])
    else:
        raise ConfigurationError(f"Unsupported operation {operation!r} for overlays.")

    session.commit()
    return {
        "id": record_id,
        "entity": entity_key,
        "is_active": None if operation == "delete" else record.is_active,
        "deleted": operation == "delete",
    }


def serialize_configurable_data(session: Session) -> dict[str, Any]:
    return {
        "departments": [
            {"id": item.id, "name": item.name, "code": item.code}
            for item in session.query(Department).order_by(Department.name).all()
        ],
        "dept_levels": [
            {
                "id": item.id,
                "dept_id": item.dept_id,
                "level_rank": item.level_rank,
                "level_name": item.level_name,
                "is_top_level": item.is_top_level,
            }
            for item in session.query(DeptLevel)
            .order_by(DeptLevel.dept_id, DeptLevel.level_rank)
            .all()
        ],
        "org_units": [
            {"id": item.id, "dept_id": item.dept_id, "name": item.name, "code": item.code}
            for item in session.query(OrgUnit).order_by(OrgUnit.dept_id, OrgUnit.name).all()
        ],
        "users": [
            {
                "id": item.id,
                "name": item.name,
                "email": item.email,
                "dept_id": item.dept_id,
                "dept_level_id": item.dept_level_id,
                "is_active": item.is_active,
                "org_unit_ids": [
                    membership.org_unit_id
                    for membership in item.org_unit_memberships
                    if membership.is_active
                ],
                "is_team_lead": any(
                    membership.is_active and membership.is_team_lead
                    for membership in item.org_unit_memberships
                ),
            }
            for item in session.query(User).order_by(User.name).all()
        ],
        "actions": [
            {
                "id": item.id,
                "name": item.name,
                "code": item.code,
                "is_project_scoped": item.is_project_scoped,
            }
            for item in session.query(Action).order_by(Action.name).all()
        ],
        "action_routing_rules": [
            {
                "id": item.id,
                "action_id": item.action_id,
                "dept_id": item.dept_id,
                "requires_primary": item.requires_primary,
                "requires_second_level": item.requires_second_level,
            }
            for item in session.query(ActionRoutingRule)
            .order_by(ActionRoutingRule.dept_id, ActionRoutingRule.action_id)
            .all()
        ],
        "reporting_lines": [
            {
                "id": item.id,
                "user_id": item.user_id,
                "manager_id": item.manager_id,
                "dept_id": item.dept_id,
                "is_primary": item.is_primary,
                "is_active": item.is_active,
            }
            for item in session.query(ReportingLine).order_by(ReportingLine.user_id).all()
        ],
        "department_fallback_rules": [
            {
                "id": item.id,
                "dept_id": item.dept_id,
                "fallback_user_id": item.fallback_user_id,
                "fallback_label": item.fallback_label,
            }
            for item in session.query(DepartmentFallbackRule)
            .order_by(DepartmentFallbackRule.dept_id)
            .all()
        ],
        "overlays": {
            key: [
                {"id": record.id, "is_active": record.is_active}
                for record in session.query(model).order_by(model.id).all()
            ]
            for key, model in OVERLAY_MODELS.items()
        },
    }
