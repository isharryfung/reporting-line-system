import pytest

from src.services.configuration import (
    ConfigurationError,
    apply_configuration_change,
    apply_diagram_edit,
)
from src.services.routing import build_approval_chain


def test_custom_user_creation_and_editing(db_session, seed):
    created = apply_configuration_change(
        db_session,
        entity="users",
        operation="upsert",
        payload={
            "name": "Iris",
            "email": "iris@university.edu",
            "dept_id": seed["finance"].id,
            "dept_level_id": seed["fin_level3"].id,
            "org_unit_ids": [seed["finance_team"].id],
            "manager_id": seed["mary"].id,
        },
    )
    assert created["updated_via_diagram"] is True

    updated = apply_configuration_change(
        db_session,
        entity="users",
        operation="upsert",
        payload={
            "id": created["id"],
            "name": "Iris Updated",
            "email": "iris.updated@university.edu",
            "dept_id": seed["finance"].id,
            "dept_level_id": seed["fin_level3"].id,
        },
    )
    assert updated["name"] == "Iris Updated"


def test_custom_level_department_org_unit_and_action_configuration(db_session, seed):
    level = apply_configuration_change(
        db_session,
        entity="dept_levels",
        operation="upsert",
        payload={
            "dept_id": seed["finance"].id,
            "level_rank": 4,
            "level_name": "Assistant Officer",
        },
    )
    assert level["level_name"] == "Assistant Officer"

    org_unit = apply_configuration_change(
        db_session,
        entity="org_units",
        operation="upsert",
        payload={
            "dept_id": seed["finance"].id,
            "code": "FIN-OPS",
            "name": "Finance Operations",
        },
    )
    assert org_unit["code"] == "FIN-OPS"

    action = apply_configuration_change(
        db_session,
        entity="actions",
        operation="upsert",
        payload={"name": "Procurement Review", "code": "procurement_review"},
    )
    rule = apply_configuration_change(
        db_session,
        entity="action_routing_rules",
        operation="upsert",
        payload={
            "action_id": action["id"],
            "dept_id": seed["finance"].id,
            "requires_primary": True,
            "requires_second_level": False,
        },
    )
    assert rule["action_id"] == action["id"]


def test_diagram_edit_change_position_department_org_unit_and_manager(db_session, seed):
    result = apply_diagram_edit(
        db_session,
        target_user_id=seed["peter"].id,
        dept_id=seed["hr"].id,
        dept_level_id=seed["hr_level3"].id,
        org_unit_ids=[seed["hr_advisory"].id],
        manager_id=seed["helen"].id,
        is_team_lead=False,
    )
    assert result.department_id == seed["hr"].id
    assert result.dept_level_id == seed["hr_level3"].id
    assert result.manager_id == seed["helen"].id


def test_diagram_edit_blocks_circular_reporting(db_session, seed):
    with pytest.raises(ConfigurationError, match="Circular reporting"):
        apply_diagram_edit(
            db_session,
            target_user_id=seed["mary"].id,
            manager_id=seed["peter"].id,
        )


def test_diagram_edit_blocks_protected_top_level_change(db_session, seed):
    with pytest.raises(ConfigurationError, match="Protected highest"):
        apply_diagram_edit(
            db_session,
            target_user_id=seed["fiona"].id,
            dept_level_id=seed["fin_level2"].id,
        )


def test_routing_simulation_updates_after_configuration_change(db_session, seed):
    apply_configuration_change(
        db_session,
        entity="action_routing_rules",
        operation="upsert",
        payload={
            "action_id": seed["sick_leave"].id,
            "dept_id": seed["finance"].id,
            "requires_primary": True,
            "requires_second_level": True,
        },
    )

    chain = build_approval_chain(db_session, seed["peter"].id, "sick_leave")
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id, seed["fiona"].id]
