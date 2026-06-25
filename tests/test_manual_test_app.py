from src.manual_test_app import (
    BUSINESS_CASES,
    build_bootstrap_payload,
    simulate_action_request,
    simulate_team_lead_permission,
)


def test_bootstrap_payload_exposes_seed_data_and_business_cases():
    payload = build_bootstrap_payload()
    assert [department["code"] for department in payload["departments"]] == ["FIN", "HR"]
    assert any(user["name"] == "Mary" and user["is_team_lead"] for user in payload["users"])
    assert len(BUSINESS_CASES) >= 6


def test_bootstrap_payload_includes_org_chart_data():
    payload = build_bootstrap_payload()
    finance_chart = payload["org_charts"]["FIN"]
    finance_team = next(
        org_unit for org_unit in finance_chart["org_units"] if org_unit["code"] == "FIN-TEAM"
    )
    assert [lead["name"] for lead in finance_team["team_leads"]] == ["Mary"]


def test_simulate_action_request_returns_generated_chain():
    payload = build_bootstrap_payload()
    peter = next(user for user in payload["users"] if user["name"] == "Peter")
    result = simulate_action_request(peter["id"], "annual_leave")
    assert result["status"] == "success"
    assert [step["approver"] for step in result["steps"]] == ["Mary", "Fiona"]


def test_simulate_action_request_returns_error_for_missing_rule():
    payload = build_bootstrap_payload()
    peter = next(user for user in payload["users"] if user["name"] == "Peter")
    result = simulate_action_request(peter["id"], "training_request")
    assert result["status"] == "error"
    assert "routing rule" in result["error"].lower()


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
