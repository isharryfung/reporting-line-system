from datetime import datetime, timezone

import pytest

from src.models import (
    ApprovalRequest,
    AuditLog,
    CoHeadAssignment,
    DelegationAssignment,
    DepartmentFallbackRule,
    ReportingLine,
)
from src.services.approval import submit_request
from src.services.org_chart import get_department_org_chart
from src.services.permissions import validate_team_lead_edit_permission
from src.services.routing import RoutingError, build_approval_chain


def dt(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=timezone.utc)


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


def test_org_chart_display_includes_org_units_team_leads_and_co_heads(db_session, seed):
    chart = get_department_org_chart(db_session, "FIN")
    assert chart["department"]["name"] == "Finance"
    finance_team = next(
        org_unit for org_unit in chart["org_units"] if org_unit["code"] == "FIN-TEAM"
    )
    assert [lead["name"] for lead in finance_team["team_leads"]] == ["Mary"]
    assert [head["name"] for head in finance_team["co_heads"]] == ["Mary", "Nina"]
    peter = next(member for member in finance_team["members"] if member["name"] == "Peter")
    assert peter["manager_name"] == "Mary"


def test_layer1_executive_tier_sits_above_department_heads(db_session, seed):
    # Layer 1 corporate tier exists with Provost > VP > School.
    assert seed["provost"].dept_level.level_rank == 1
    assert seed["vp"].dept_level.level_rank == 2
    assert seed["school"].dept_level.level_rank == 3
    assert seed["school"].reporting_lines[0].manager_id == seed["vp"].id
    assert seed["vp"].reporting_lines[0].manager_id == seed["provost"].id
    # Department heads report up to the School (Layer 2 -> Layer 1).
    fiona_managers = [
        line.manager_id for line in seed["fiona"].reporting_lines if line.is_active
    ]
    assert fiona_managers == [seed["school"].id]


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


def test_acting_replaces_approver_during_valid_date_range(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "sick_leave",
        request_at=dt(2027, 6, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["nina"].id]
    assert chain.steps[0].source == "acting"


def test_acting_ignored_outside_date_range(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "sick_leave",
        request_at=dt(2027, 7, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id]


def test_peer_coverage_replaces_approver_during_valid_coverage(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "annual_leave",
        request_at=dt(2027, 8, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["nina"].id, seed["fiona"].id]
    assert chain.steps[0].source == "peer_coverage"


def test_self_approval_is_blocked_and_redirected(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "sick_leave",
        request_at=dt(2027, 10, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["fiona"].id]
    assert "self-approval prevented" in chain.steps[0].explanation.lower()


def test_handover_both_required_produces_two_steps(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "sick_leave",
        request_at=dt(2027, 11, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id, seed["nina"].id]
    assert all(step.source == "handover" for step in chain.steps)


def test_cross_department_project_action_routes_to_project_manager(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "project_change_request",
        project_code="UTP",
    )
    assert [step.approver.id for step in chain.steps] == [seed["helen"].id]
    assert chain.steps[0].source == "project"


def test_annual_leave_ignores_project_manager_unless_action_is_project_scoped(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "annual_leave",
        project_code="UTP",
    )
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id, seed["fiona"].id]


def test_co_head_either_one_approves_policy(db_session, seed):
    chain = build_approval_chain(db_session, seed["peter"].id, "finance_team_plan")
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id]
    assert chain.steps[0].alternate_approvers == ["Nina"]
    assert chain.steps[0].source == "co_head"


def test_co_head_both_required_policy(db_session, seed):
    assignments = db_session.query(CoHeadAssignment).all()
    for assignment in assignments:
        assignment.policy = "both_required"
    db_session.commit()

    chain = build_approval_chain(db_session, seed["peter"].id, "finance_team_plan")
    assert [step.approver.id for step in chain.steps] == [seed["mary"].id, seed["nina"].id]


def test_delegation_replaces_approver_during_valid_date_range(db_session, seed):
    chain = build_approval_chain(
        db_session,
        seed["peter"].id,
        "annual_leave",
        request_at=dt(2027, 9, 15),
    )
    assert [step.approver.id for step in chain.steps] == [seed["nina"].id, seed["fiona"].id]
    assert chain.steps[0].source == "delegation"


def test_delegation_to_inactive_user_is_rejected(db_session, seed):
    delegation = db_session.query(DelegationAssignment).one()
    seed["nina"].is_active = False
    db_session.commit()

    with pytest.raises(RoutingError, match="inactive"):
        build_approval_chain(
            db_session,
            seed["peter"].id,
            "annual_leave",
            request_at=delegation.effective_from,
        )


def test_self_delegation_is_rejected(db_session, seed):
    delegation = db_session.query(DelegationAssignment).one()
    delegation.delegate_user_id = delegation.delegator_user_id
    db_session.commit()

    with pytest.raises(RoutingError, match="Self-delegation"):
        build_approval_chain(
            db_session,
            seed["peter"].id,
            "annual_leave",
            request_at=delegation.effective_from,
        )


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
            user_id=seed["provost"].id,
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
    request = submit_request(
        db_session,
        seed["peter"].id,
        "annual_leave",
        request_at=dt(2027, 9, 15),
    )
    stored_request = db_session.get(ApprovalRequest, request.id)
    assert stored_request is not None
    assert [step.approver_id for step in stored_request.steps] == [
        seed["nina"].id,
        seed["fiona"].id,
    ]


def test_audit_log_recorded_when_overlay_is_applied(db_session, seed):
    build_approval_chain(
        db_session,
        seed["peter"].id,
        "annual_leave",
        request_at=dt(2027, 9, 15),
    )
    logs = db_session.query(AuditLog).all()
    assert any(log.action == "overlay_applied" for log in logs)
    assert any(log.action == "chain_built" for log in logs)
