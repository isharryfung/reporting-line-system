import pytest

from src.manual_test_app import (
    ADVANCED_SCENARIOS,
    BUSINESS_CASES,
    _reset_database,
    api_create_reporting_line,
    api_create_user,
    api_update_diagram_node,
    api_update_user,
    build_bootstrap_payload,
    get_seed_data,
    simulate_action_request,
    simulate_advanced_scenario,
    simulate_team_lead_permission,
)


@pytest.fixture(autouse=True)
def _fresh_state():
    """Reset the POC database to default seed data before each test in this module."""
    _reset_database()
    yield
    # No teardown needed — next test resets on entry.


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


# ---------------------------------------------------------------------------
# Level correction tests
# ---------------------------------------------------------------------------

def test_default_levels_are_director_4_senior_manager_5_officer_9():
    """BC-20: Director = Level 4, Senior Manager = Level 5, Officer = Level 9."""
    payload = build_bootstrap_payload()
    fiona = next(u for u in payload["users"] if u["name"] == "Fiona")
    mary = next(u for u in payload["users"] if u["name"] == "Mary")
    peter = next(u for u in payload["users"] if u["name"] == "Peter")
    assert fiona["level_rank"] == 4, "Finance Director should be Level 4"
    assert mary["level_rank"] == 5, "Senior Manager should be Level 5"
    assert peter["level_rank"] == 9, "Finance Officer should be Level 9"


def test_hr_levels_follow_same_global_ranks():
    payload = build_bootstrap_payload()
    henry = next(u for u in payload["users"] if u["name"] == "Henry")
    helen = next(u for u in payload["users"] if u["name"] == "Helen")
    olivia = next(u for u in payload["users"] if u["name"] == "Olivia")
    assert henry["level_rank"] == 4
    assert helen["level_rank"] == 5
    assert olivia["level_rank"] == 9


# ---------------------------------------------------------------------------
# Diagram/node edit tests
# ---------------------------------------------------------------------------

def test_update_user_name_persists_and_refreshes_bootstrap():
    """BC-16: edit node level updates user in bootstrap."""
    payload = build_bootstrap_payload()
    peter = next(u for u in payload["users"] if u["name"] == "Peter")

    result, status = api_update_user(peter["id"], {"name": "Peter Edited"})
    assert status == 200
    assert result["user"]["name"] == "Peter Edited"

    updated = build_bootstrap_payload()
    assert any(u["name"] == "Peter Edited" for u in updated["users"])
    assert not any(u["name"] == "Peter" for u in updated["users"])


def test_update_user_level_changes_routing():
    """Changing a user's level persists and affects org chart display."""
    seed = get_seed_data()
    peter = next(u for u in seed["users"] if u["name"] == "Peter")
    mary = next(u for u in seed["users"] if u["name"] == "Mary")

    # Promote Peter to Senior Manager level
    result, status = api_update_user(peter["id"], {"dept_level_id": mary["dept_level_id"]})
    assert status == 200
    assert result["user"]["level_rank"] == 5


def test_update_diagram_node_combines_user_and_manager_update():
    """BC-17: updating a node's manager changes the reporting line."""
    payload = build_bootstrap_payload()
    peter = next(u for u in payload["users"] if u["name"] == "Peter")
    nina = next(u for u in payload["users"] if u["name"] == "Nina")

    result, status = api_update_diagram_node({"user_id": peter["id"], "manager_id": nina["id"]})
    assert status == 200

    # Routing should now go Peter → Nina → Fiona
    chain = simulate_action_request(peter["id"], "annual_leave")
    assert chain["status"] == "success"
    assert chain["steps"][0]["approver"] == "Nina"


def test_create_reporting_line_detects_circular_cycle():
    """BC-18: circular reporting line edit is rejected."""
    payload = build_bootstrap_payload()
    fiona = next(u for u in payload["users"] if u["name"] == "Fiona")
    peter = next(u for u in payload["users"] if u["name"] == "Peter")

    # Fiona → Peter would create: Peter → Mary → Fiona → Peter (cycle)
    result, status = api_create_reporting_line(
        {"user_id": fiona["id"], "manager_id": peter["id"]}
    )
    assert status == 400
    assert "circular" in result["error"].lower()


def test_create_user_appears_in_bootstrap():
    """BC-19: new user appears in scenario builder dropdown."""
    seed = get_seed_data()
    fin_officer_level = next(
        lv for lv in seed["dept_levels"] if lv["level_name"] == "Finance Officer"
    )
    result, status = api_create_user(
        {
            "name": "TestUser",
            "email": "testuser@university.edu",
            "dept_level_id": fin_officer_level["id"],
        }
    )
    assert status == 201
    assert result["user"]["name"] == "TestUser"

    payload = build_bootstrap_payload()
    assert any(u["name"] == "TestUser" for u in payload["users"])


def test_get_seed_data_returns_all_entity_types():
    """Seed data editor exposes all editable tables."""
    data = get_seed_data()
    assert "departments" in data
    assert "dept_levels" in data
    assert "org_units" in data
    assert "users" in data
    assert "reporting_lines" in data
    assert "actions" in data
    assert "routing_rules" in data
    assert "fallback_rules" in data
    assert len(data["departments"]) == 2
    assert len(data["users"]) > 0


def test_scenario_builder_uses_updated_data_after_diagram_edit():
    """After editing a node's manager, scenario builder returns updated chain."""
    payload = build_bootstrap_payload()
    peter = next(u for u in payload["users"] if u["name"] == "Peter")
    nina = next(u for u in payload["users"] if u["name"] == "Nina")

    # Before edit: Peter → Mary → Fiona
    before = simulate_action_request(peter["id"], "annual_leave")
    assert before["steps"][0]["approver"] == "Mary"

    # Edit: change Peter's manager to Nina
    api_update_diagram_node({"user_id": peter["id"], "manager_id": nina["id"]})

    # After edit: Peter → Nina → Fiona
    after = simulate_action_request(peter["id"], "annual_leave")
    assert after["steps"][0]["approver"] == "Nina"

