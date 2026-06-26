import pytest

from src.manual_test_app import (
    ADVANCED_SCENARIOS,
    BUSINESS_CASES,
    build_bootstrap_payload,
    simulate_action_request,
    simulate_advanced_scenario,
    simulate_team_lead_permission,
)
from src.services.graph_editor import GraphEditError, apply_user_edit, update_routing_rule


def test_bootstrap_payload_exposes_seed_data_and_advanced_business_cases():
    payload = build_bootstrap_payload()
    assert [department["code"] for department in payload["departments"]] == ["FIN", "HR"]
    assert any(user["name"] == "Mary" and user["is_team_lead"] for user in payload["users"])
    assert len(BUSINESS_CASES) >= 15
    assert len(ADVANCED_SCENARIOS) >= 8


def test_bootstrap_payload_includes_org_chart_data_and_scenarios():
    payload = build_bootstrap_payload()
    finance_chart = payload["org_charts"]["FIN"]
    finance_team = next(
        org_unit for org_unit in finance_chart["org_units"] if org_unit["code"] == "FIN-TEAM"
    )
    assert [lead["name"] for lead in finance_team["team_leads"]] == ["Mary"]
    assert [head["name"] for head in finance_team["co_heads"]] == ["Mary", "Nina"]
    assert any(scenario["id"] == "self_approval_route" for scenario in payload["advanced_scenarios"])
    assert len(finance_chart["level_labels"]) == 9
    assert finance_chart["ownership_regions"][0]["name"] == "Own by HRO"
    assert finance_chart["graph"]["nodes"]


def test_simulate_action_request_returns_generated_chain_with_overlay_explanations():
    payload = build_bootstrap_payload()
    peter = next(user for user in payload["users"] if user["name"] == "Peter")
    result = simulate_action_request(
        peter["id"],
        "annual_leave",
        request_at="2027-09-15T00:00:00+00:00",
    )
    assert result["status"] == "success"
    assert [step["approver"] for step in result["steps"]] == ["Nina", "Fiona"]
    assert result["steps"][0]["source"] == "delegation"


def test_simulate_action_request_returns_error_for_missing_rule():
    payload = build_bootstrap_payload()
    peter = next(user for user in payload["users"] if user["name"] == "Peter")
    result = simulate_action_request(peter["id"], "training_request")
    assert result["status"] == "error"
    assert "routing rule" in result["error"].lower()


def test_simulate_advanced_scenario_returns_self_approval_redirect_case():
    result = simulate_advanced_scenario("self_approval_route")
    assert result["status"] == "success"
    assert [step["approver"] for step in result["steps"]] == ["Fiona"]
    assert "self-approval" in result["steps"][0]["explanation"].lower()


def test_simulate_team_lead_permission_returns_allowed_and_denied_cases():
    payload = build_bootstrap_payload()
    mary = next(user for user in payload["users"] if user["name"] == "Mary")
    peter = next(user for user in payload["users"] if user["name"] == "Peter")
    quinn = next(user for user in payload["users"] if user["name"] == "Quinn")

    allowed = simulate_team_lead_permission(mary["id"], peter["id"])
    denied = simulate_team_lead_permission(mary["id"], quinn["id"])

    assert allowed["allowed"] is True
    assert denied["allowed"] is False
    assert "outside" in denied["reason"].lower()


def test_graph_edit_updates_manager_and_routing_output_changes(db_session, seed):
    peter = seed["peter"]
    mary = seed["mary"]
    nina = seed["nina"]

    before = simulate_action_request(
        requester_id=peter.id,
        action_code="annual_leave",
        session=db_session,
    )
    assert [step["approver"] for step in before["steps"]][:1] == ["Mary"]

    result = apply_user_edit(
        db_session,
        editor_id=None,
        editor_scope="hro",
        target_user_id=peter.id,
        manager_id=nina.id,
    )
    assert result.status == "success"

    after = simulate_action_request(
        requester_id=peter.id,
        action_code="annual_leave",
        session=db_session,
    )
    assert [step["approver"] for step in after["steps"]][:1] == ["Nina"]
    assert "team_regions" in result.data["org_chart"]


def test_graph_edit_blocks_circular_reporting_line(db_session, seed):
    with pytest.raises(GraphEditError, match="Circular"):
        apply_user_edit(
            db_session,
            editor_id=None,
            editor_scope="hro",
            target_user_id=seed["fiona"].id,
            manager_id=seed["peter"].id,
        )


def test_graph_edit_blocks_unauthorized_protected_level_edit(db_session, seed):
    with pytest.raises(GraphEditError, match="Protected"):
        apply_user_edit(
            db_session,
            editor_id=seed["mary"].id,
            editor_scope="team_lead",
            target_user_id=seed["fiona"].id,
            level_id=seed["fin_level2"].id,
        )


def test_routing_rule_edit_changes_first_vs_second_level_path(db_session, seed):
    peter = seed["peter"]
    update_routing_rule(
        db_session,
        department_code="FIN",
        action_code="annual_leave",
        approval_level="first_level",
    )
    first_level = simulate_action_request(
        requester_id=peter.id,
        action_code="annual_leave",
        session=db_session,
    )
    assert [step["approver"] for step in first_level["steps"]] == ["Mary"]

    update_routing_rule(
        db_session,
        department_code="FIN",
        action_code="annual_leave",
        approval_level="second_level",
    )
    second_level = simulate_action_request(
        requester_id=peter.id,
        action_code="annual_leave",
        session=db_session,
    )
    assert [step["approver"] for step in second_level["steps"]] == ["Mary", "Fiona"]
