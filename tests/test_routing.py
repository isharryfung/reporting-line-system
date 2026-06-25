import pytest

from src.models import (
    ApprovalRequest,
    AuditLog,
    DepartmentFallbackRule,
    ReportingLine,
)
from src.services.approval import submit_request
from src.services.org_chart import get_department_org_chart
from src.services.permissions import validate_team_lead_edit_permission
from src.services.routing import RoutingError, build_approval_chain


def test_finance_annual_leave_routes_primary_and_second_level(db_session, seed):
    chain = build_approval_chain(db_session, seed["peter"].id, "annual_leave")
    assert [step.approver.id for step in chain.steps] == [
        seed["mary"].id,
        seed["fiona"].id,
    ]
    assert [step.is_fallback for step in chain.steps] == [False, False]


def test_finance_sick_leave_routes_primary_only(db_session, seed):
    chain = build_approval_chain(db_session, seed["peter"].id, "sick_leave")
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id]


def test_department_specific_routing_differs_between_finance_and_hr(db_session, seed):
    finance_chain = build_approval_chain(db_session, seed["peter"].id, "annual_leave")
    hr_chain = build_approval_chain(db_session, seed["olivia"].id, "annual_leave")
    assert len(finance_chain.steps) == 2
    assert [step.approver.id for step in hr_chain.steps] == [seed["helen"].id]


def test_top_level_department_fallback_routing(db_session, seed):
    chain = build_approval_chain(db_session, seed["fiona"].id, "annual_leave")
    assert len(chain.steps) == 1
    assert chain.steps[0].approver.id == seed["henry"].id
    assert chain.steps[0].is_fallback is True


def test_org_chart_display_includes_org_units_and_team_leads(db_session, seed):
    chart = get_department_org_chart(db_session, "FIN")
    assert chart["department"]["name"] == "Finance"
    finance_team = next(
        org_unit for org_unit in chart["org_units"] if org_unit["code"] == "FIN-TEAM"
    )
    assert [lead["name"] for lead in finance_team["team_leads"]] == ["Mary"]
    peter = next(member for member in finance_team["members"] if member["name"] == "Peter")
    assert peter["manager_name"] == "Mary"


def test_team_lead_can_edit_lower_level_user_in_same_org_unit(db_session, seed):
    decision = validate_team_lead_edit_permission(
        db_session,
        editor_id=seed["mary"].id,
        target_user_id=seed["peter"].id,
    )
    assert decision.allowed is True


def test_team_lead_cannot_edit_same_level_user(db_session, seed):
    decision = validate_team_lead_edit_permission(
        db_session,
        editor_id=seed["mary"].id,
        target_user_id=seed["nina"].id,
    )
    assert decision.allowed is False
    assert "lower-level" in decision.reason.lower()


def test_team_lead_cannot_edit_protected_highest_level_user(db_session, seed):
    decision = validate_team_lead_edit_permission(
        db_session,
        editor_id=seed["mary"].id,
        target_user_id=seed["fiona"].id,
    )
    assert decision.allowed is False
    assert "protected" in decision.reason.lower()


def test_team_lead_cannot_edit_user_in_another_org_unit(db_session, seed):
    decision = validate_team_lead_edit_permission(
        db_session,
        editor_id=seed["mary"].id,
        target_user_id=seed["quinn"].id,
    )
    assert decision.allowed is False
    assert "outside" in decision.reason.lower()


def test_team_lead_cannot_edit_themselves(db_session, seed):
    decision = validate_team_lead_edit_permission(
        db_session,
        editor_id=seed["mary"].id,
        target_user_id=seed["mary"].id,
    )
    assert decision.allowed is False
    assert "themselves" in decision.reason.lower()


def test_missing_action_routing_rule(db_session, seed):
    with pytest.raises(RoutingError, match="No routing rule configured"):
        build_approval_chain(db_session, seed["peter"].id, "training_request")


def test_missing_primary_manager(db_session, seed):
    peter_line = (
        db_session.query(ReportingLine)
        .filter(ReportingLine.user_id == seed["peter"].id, ReportingLine.is_active.is_(True))
        .one()
    )
    peter_line.is_active = False
    db_session.commit()

    with pytest.raises(RoutingError, match="primary manager"):
        build_approval_chain(db_session, seed["peter"].id, "annual_leave")


def test_missing_fallback_rule(db_session, seed):
    fallback_rule = (
        db_session.query(DepartmentFallbackRule)
        .filter(DepartmentFallbackRule.dept_id == seed["finance"].id)
        .one()
    )
    db_session.delete(fallback_rule)
    db_session.commit()

    with pytest.raises(RoutingError, match="fallback"):
        build_approval_chain(db_session, seed["fiona"].id, "annual_leave")


def test_circular_reporting_chain(db_session, seed):
    db_session.add(
        ReportingLine(
            user_id=seed["fiona"].id,
            manager_id=seed["peter"].id,
            dept_id=seed["finance"].id,
        )
    )
    db_session.commit()

    with pytest.raises(RoutingError, match="Circular reporting"):
        build_approval_chain(db_session, seed["peter"].id, "annual_leave")


@pytest.mark.parametrize(
    ("mutator", "requester_id", "pattern"),
    [
        (lambda data: setattr(data["mary"], "is_active", False), lambda data: data["peter"].id, "inactive"),
        (lambda data: setattr(data["peter"], "is_active", False), lambda data: data["peter"].id, "inactive"),
    ],
)
def test_inactive_manager_or_user(
    db_session,
    seed,
    mutator,
    requester_id,
    pattern,
):
    mutator(seed)
    db_session.commit()

    with pytest.raises(RoutingError, match=pattern):
        build_approval_chain(db_session, requester_id(seed), "annual_leave")


def test_only_one_active_primary_manager_per_staff_member(db_session, seed):
    db_session.add(
        ReportingLine(
            user_id=seed["peter"].id,
            manager_id=seed["nina"].id,
            dept_id=seed["finance"].id,
            is_primary=True,
        )
    )
    db_session.commit()

    with pytest.raises(RoutingError, match="more than one active primary manager"):
        build_approval_chain(db_session, seed["peter"].id, "annual_leave")


def test_submit_request_persists_generated_approval_chain(db_session, seed):
    request = submit_request(db_session, seed["peter"].id, "annual_leave")
    stored_request = db_session.get(ApprovalRequest, request.id)
    assert stored_request is not None
    assert [step.approver_id for step in stored_request.steps] == [
        seed["mary"].id,
        seed["fiona"].id,
    ]


def test_audit_log_recorded_when_chain_is_built(db_session, seed):
    build_approval_chain(db_session, seed["peter"].id, "annual_leave")
    logs = db_session.query(AuditLog).all()
    assert any(log.action == "chain_built" for log in logs)
