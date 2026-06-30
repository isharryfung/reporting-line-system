import pytest

from src.manual_test_app import (
    ADVANCED_SCENARIOS,
    BUSINESS_CASES,
    _reset_database,
    api_create_action,
    api_create_department,
    api_create_dept_level,
    api_create_org_unit,
    api_create_reporting_line,
    api_create_user,
    api_delete_action,
    api_delete_department,
    api_delete_dept_level,
    api_delete_org_unit,
    api_update_action,
    api_update_department,
    api_update_diagram_node,
    api_update_org_unit,
    api_update_user,
    build_bootstrap_payload,
    get_seed_data,
    simulate_action_request,
    simulate_advanced_scenario,
    simulate_scenario_overlay,
    simulate_reporting_line,
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
    assert [department["code"] for department in payload["departments"]] == [
        "FIN",
        "HR",
        "HRO",
        "ITSO",
        "EXEC",
    ]
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
    assert {d["code"] for d in data["departments"]} == {"EXEC", "FIN", "HR", "HRO", "ITSO"}
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


# ---------------------------------------------------------------------------
# Seed Data Editor CRUD: departments, actions, org units, levels
# ---------------------------------------------------------------------------

def test_department_create_update_delete():
    created, status = api_create_department({"name": "Library", "code": "LIB"})
    assert status == 201
    dept_id = created["department"]["id"]
    assert any(d["code"] == "LIB" for d in get_seed_data()["departments"])

    updated, status = api_update_department(dept_id, {"name": "Library Services"})
    assert status == 200
    assert updated["department"]["name"] == "Library Services"

    deleted, status = api_delete_department(dept_id)
    assert status == 200
    assert not any(d["code"] == "LIB" for d in get_seed_data()["departments"])


def test_department_delete_blocked_when_users_exist():
    fin = next(d for d in get_seed_data()["departments"] if d["code"] == "FIN")
    result, status = api_delete_department(fin["id"])
    assert status == 400
    assert "user" in result["error"].lower()


def test_department_create_rejects_duplicate_code():
    result, status = api_create_department({"name": "Finance Two", "code": "FIN"})
    assert status == 400
    assert "code" in result["error"].lower()


def test_action_create_update_delete():
    created, status = api_create_action(
        {"name": "Overtime", "code": "overtime", "is_project_scoped": False}
    )
    assert status == 201
    action_id = created["action"]["id"]

    updated, status = api_update_action(action_id, {"is_project_scoped": True})
    assert status == 200
    assert updated["action"]["is_project_scoped"] is True

    deleted, status = api_delete_action(action_id)
    assert status == 200
    assert not any(a["code"] == "overtime" for a in get_seed_data()["actions"])


def test_org_unit_create_update_delete():
    fin = next(d for d in get_seed_data()["departments"] if d["code"] == "FIN")
    created, status = api_create_org_unit(
        {"dept_id": fin["id"], "name": "Treasury Desk", "code": "FIN-TREAS"}
    )
    assert status == 201
    org_unit_id = created["org_unit"]["id"]

    updated, status = api_update_org_unit(org_unit_id, {"name": "Treasury"})
    assert status == 200
    assert updated["org_unit"]["name"] == "Treasury"

    # No members assigned, so deletion should succeed.
    deleted, status = api_delete_org_unit(org_unit_id)
    assert status == 200


def test_dept_level_create_and_delete():
    fin = next(d for d in get_seed_data()["departments"] if d["code"] == "FIN")
    created, status = api_create_dept_level(
        {"dept_id": fin["id"], "level_rank": 7, "level_name": "Assistant Manager"}
    )
    assert status == 201
    level_id = created["dept_level"]["id"]
    assert any(lv["id"] == level_id for lv in get_seed_data()["dept_levels"])

    deleted, status = api_delete_dept_level(level_id)
    assert status == 200
    assert not any(lv["id"] == level_id for lv in get_seed_data()["dept_levels"])


def test_dept_level_delete_blocked_when_user_assigned():
    seed = get_seed_data()
    peter = next(u for u in seed["users"] if u["name"] == "Peter")
    result, status = api_delete_dept_level(peter["dept_level_id"])
    assert status == 400
    assert "user" in result["error"].lower()


# ---------------------------------------------------------------------------
# Scenario Lab: ephemeral overlay simulation
# ---------------------------------------------------------------------------

def _user_ids():
    return {u["name"]: u["id"] for u in build_bootstrap_payload()["users"]}


def test_simulate_overlay_delegation_resolves_primary_and_second_level():
    ids = _user_ids()
    result = simulate_scenario_overlay(
        requester_id=ids["Peter"],
        action_code="annual_leave",
        overlays=[
            {"type": "delegation", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    assert result["status"] == "success"
    assert result["primary_approver"] == "Nina"
    assert result["primary_source"] == "delegation"
    assert result["second_level_approver"] == "Fiona"


def test_simulate_overlay_acting_annotates_primary_approver():
    ids = _user_ids()
    result = simulate_scenario_overlay(
        requester_id=ids["Peter"],
        action_code="sick_leave",
        overlays=[
            {"type": "acting", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    assert result["status"] == "success"
    # Acting is additive: Mary stays the official approver, Nina acts for her.
    assert result["primary_approver"] == "Mary"
    assert result["primary_source"] == "official"
    assert result["primary_acting_approver"] == "Nina"


def test_simulate_overlay_handover_both_required_keeps_both_approvers():
    ids = _user_ids()
    result = simulate_scenario_overlay(
        requester_id=ids["Peter"],
        action_code="sick_leave",
        overlays=[
            {
                "type": "handover",
                "owner_id": ids["Mary"],
                "substitute_id": ids["Nina"],
                "policy": "both_required",
            }
        ],
    )
    assert result["status"] == "success"
    approvers = [step["approver"] for step in result["steps"]]
    assert "Mary" in approvers and "Nina" in approvers


def test_simulate_overlay_does_not_persist_overlays():
    """Scenario Lab overlays must not mutate persisted POC state."""
    ids = _user_ids()
    simulate_scenario_overlay(
        requester_id=ids["Peter"],
        action_code="annual_leave",
        overlays=[
            {"type": "delegation", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    # Without the ad-hoc overlay, default annual_leave still routes to Mary.
    plain = simulate_action_request(ids["Peter"], "annual_leave")
    assert plain["steps"][0]["approver"] == "Mary"


def test_simulate_overlay_with_no_overlays_matches_official_route():
    ids = _user_ids()
    result = simulate_scenario_overlay(
        requester_id=ids["Peter"], action_code="annual_leave", overlays=[]
    )
    assert result["status"] == "success"
    assert result["primary_approver"] == "Mary"
    assert result["second_level_approver"] == "Fiona"


def test_simulate_overlay_rejects_unknown_type():
    ids = _user_ids()
    result = simulate_scenario_overlay(
        requester_id=ids["Peter"],
        action_code="annual_leave",
        overlays=[
            {"type": "bogus", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    assert result["status"] == "error"


def test_bootstrap_exposes_overlay_simulation_metadata():
    payload = build_bootstrap_payload()
    types = {o["type"] for o in payload["overlay_simulations"]}
    assert {"acting", "delegation", "peer_coverage", "handover"} <= types
    assert "both_required" in payload["handover_policies"]


# ---------------------------------------------------------------------------
# Test Case Diagram: ephemeral reporting-line simulation
# ---------------------------------------------------------------------------

def test_simulate_reporting_line_official_chain_produces_wording():
    ids = _user_ids()
    result = simulate_reporting_line(requester_id=ids["Peter"], edges=[])
    assert result["status"] == "success"
    managers = [step["manager"] for step in result["steps"]]
    assert managers == ["Mary", "Fiona", "School", "VP", "Provost"]
    assert result["top_of_line"] == "Provost"
    assert "reports to" in result["wording"]
    assert "top of this reporting line" in result["wording"]


def test_simulate_reporting_line_applies_temporary_edge():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[{"user_id": ids["Peter"], "manager_id": ids["Nina"]}],
    )
    assert result["status"] == "success"
    managers = [step["manager"] for step in result["steps"]]
    assert managers == ["Nina", "Fiona", "School", "VP", "Provost"]
    assert "Nina" in result["wording"]


def test_simulate_reporting_line_edits_are_not_persisted():
    ids = _user_ids()
    simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[{"user_id": ids["Peter"], "manager_id": ids["Nina"]}],
    )
    # The official line must be untouched after the rolled-back simulation.
    plain = simulate_reporting_line(requester_id=ids["Peter"], edges=[])
    assert plain["steps"][0]["manager"] == "Mary"


def test_simulate_reporting_line_top_level_user_has_no_manager():
    ids = _user_ids()
    result = simulate_reporting_line(requester_id=ids["Provost"], edges=[])
    assert result["status"] == "success"
    assert result["steps"] == []
    assert result["top_of_line"] == "Provost"
    assert "no manager" in result["wording"]


def test_simulate_reporting_line_detects_cycle():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[
            {"user_id": ids["Mary"], "manager_id": ids["Peter"]},
        ],
    )
    assert result["status"] == "error"
    assert "Circular" in result["error"]


def test_simulate_reporting_line_rejects_self_manager():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[{"user_id": ids["Peter"], "manager_id": ids["Peter"]}],
    )
    assert result["status"] == "error"


def test_simulate_reporting_line_acting_overlay_changes_resolved_approver():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="sick_leave",
        overlays=[
            {"type": "acting", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    assert result["status"] == "success"
    assert result["action_name"] == "Sick Leave"
    # Acting is additive: Mary remains the official approver, Nina acts for her.
    assert result["overlay_steps"][0]["approver"] == "Mary"
    assert result["overlay_steps"][0]["source"] == "official"
    assert result["overlay_steps"][0]["acting_approver"] == "Nina"
    assert "Nina" in result["overlay_wording"]


def test_simulate_reporting_line_delegation_overlay_changes_resolved_approver():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="annual_leave",
        overlays=[
            {"type": "delegation", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    assert result["status"] == "success"
    assert result["overlay_steps"][0]["approver"] == "Nina"
    assert result["overlay_steps"][0]["source"] == "delegation"


def test_seed_includes_performance_review_action_for_itso():
    payload = build_bootstrap_payload()
    assert any(
        action["code"] == "performance_review" and action["name"] == "Performance Review"
        for action in payload["actions"]
    )


def test_simulate_reporting_line_partial_acting_decouples_leave_and_review():
    """Case #3: an on-leave manager's leave approvals and performance reviews
    route to different covers (scoped by action), while the second level rolls
    back to the manager's own manager."""
    ids = _user_ids()
    overlays = [
        {
            "type": "peer_coverage",
            "owner_id": ids["Cyrus"],
            "substitute_id": ids["Isaac"],
            "action_code": "annual_leave",
        },
        {
            "type": "peer_coverage",
            "owner_id": ids["Cyrus"],
            "substitute_id": ids["Evan"],
            "action_code": "performance_review",
        },
    ]

    leave = simulate_reporting_line(
        requester_id=ids["Cleo"], edges=[], action_code="annual_leave", overlays=overlays
    )
    assert leave["status"] == "success"
    assert leave["overlay_steps"][0]["approver"] == "Isaac"
    assert leave["overlay_steps"][0]["source"] == "peer_coverage"
    # Second level rolls back to Cyrus's own manager, Cara.
    assert leave["overlay_steps"][1]["approver"] == "Cara"

    review = simulate_reporting_line(
        requester_id=ids["Cleo"],
        edges=[],
        action_code="performance_review",
        overlays=overlays,
    )
    assert review["status"] == "success"
    assert review["overlay_steps"][0]["approver"] == "Evan"
    assert review["overlay_steps"][0]["source"] == "peer_coverage"
    assert review["overlay_steps"][1]["approver"] == "Cara"


def test_simulate_overlay_resolves_action_code_scope():
    """An overlay scoped by action_code applies only to that action."""
    ids = _user_ids()
    overlays = [
        {
            "type": "peer_coverage",
            "owner_id": ids["Cyrus"],
            "substitute_id": ids["Isaac"],
            "action_code": "performance_review",
        }
    ]
    # Scoped to performance_review, so annual_leave is unaffected (Cyrus stays).
    leave = simulate_reporting_line(
        requester_id=ids["Cleo"], edges=[], action_code="annual_leave", overlays=overlays
    )
    assert leave["overlay_steps"][0]["approver"] == "Cyrus"


def test_simulate_overlay_rejects_unknown_action_code():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Cleo"],
        edges=[],
        action_code="annual_leave",
        overlays=[
            {
                "type": "peer_coverage",
                "owner_id": ids["Cyrus"],
                "substitute_id": ids["Isaac"],
                "action_code": "does_not_exist",
            }
        ],
    )
    assert result["overlay_error"] == "Action 'does_not_exist' not found."


def test_simulate_reporting_line_project_overlay_routes_cross_department():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="project_change_request",
        project_code="UTP",
    )
    assert result["status"] == "success"
    assert result["overlay_steps"][0]["approver"] == "Helen"
    assert result["overlay_steps"][0]["source"] == "project"


def test_simulate_reporting_line_co_head_overlay_offers_alternate_approver():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="finance_team_plan",
    )
    assert result["status"] == "success"
    primary = result["overlay_steps"][0]
    assert primary["approver"] == "Mary"
    assert primary["source"] == "co_head"
    assert "Nina" in primary["alternate_approvers"]


def test_simulate_reporting_line_blocks_self_approval():
    ids = _user_ids()
    # Acting makes Peter his own approver for sick_leave, which must be redirected.
    result = simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="sick_leave",
        overlays=[
            {"type": "acting", "owner_id": ids["Mary"], "substitute_id": ids["Peter"]}
        ],
    )
    assert result["status"] == "success"
    primary = result["overlay_steps"][0]
    assert primary["approver"] != "Peter"
    assert primary["source"] == "self_approval_redirect"


def test_simulate_reporting_line_without_action_has_no_overlay_fields():
    ids = _user_ids()
    result = simulate_reporting_line(requester_id=ids["Peter"], edges=[])
    assert result["status"] == "success"
    assert "overlay_steps" not in result
    assert "action_code" not in result


def test_simulate_reporting_line_reports_unknown_action_as_overlay_error():
    ids = _user_ids()
    result = simulate_reporting_line(
        requester_id=ids["Peter"], edges=[], action_code="does_not_exist"
    )
    # Base reporting line still succeeds; only the overlay resolution reports the error.
    assert result["status"] == "success"
    assert "not found" in result["overlay_error"]


def test_simulate_reporting_line_overlays_are_not_persisted():
    ids = _user_ids()
    simulate_reporting_line(
        requester_id=ids["Peter"],
        edges=[],
        action_code="sick_leave",
        overlays=[
            {"type": "acting", "owner_id": ids["Mary"], "substitute_id": ids["Nina"]}
        ],
    )
    # Without the ad-hoc overlay, the official sick_leave route still goes to Mary.
    plain = simulate_action_request(ids["Peter"], "sick_leave")
    assert plain["steps"][0]["approver"] == "Mary"


def test_stale_persisted_db_missing_seed_departments_is_reseeded(tmp_path, monkeypatch):
    """A persisted DB from an older build (missing ITSO/HRO) is re-seeded so the
    full sample organisation is always available."""
    import src.manual_test_app as app
    from src.database import create_engine_sqlite, init_db
    from sqlalchemy.orm import sessionmaker
    from src.models import Department, DeptLevel, User

    db_path = tmp_path / "stale.db"

    # Build a stale database that only contains the original FIN + HR seed.
    engine = create_engine_sqlite(str(db_path))
    init_db(engine)
    session = sessionmaker(bind=engine)()
    finance = Department(name="Finance", code="FIN")
    session.add(finance)
    session.flush()
    level = DeptLevel(
        dept_id=finance.id, level_rank=4, level_name="Director", is_top_level=True
    )
    session.add(level)
    session.flush()
    session.add(
        User(name="Old", email="old@university.edu", dept_id=finance.id, dept_level_id=level.id)
    )
    session.commit()
    session.close()
    engine.dispose()

    # Point the app at the stale database and force a fresh engine load.
    monkeypatch.setattr(app, "_DB_PATH", str(db_path))
    monkeypatch.setattr(app, "_engine", None)
    monkeypatch.setattr(app, "_SessionFactory", None)

    payload = app.build_bootstrap_payload()
    assert app._EXPECTED_SEED_DEPARTMENTS.issubset(
        {department["code"] for department in payload["departments"]}
    )


def test_stale_persisted_db_with_old_itso_hro_ranks_is_reseeded(tmp_path, monkeypatch):
    """A persisted DB whose ITSO/HRO levels still carry the old (pre-shift) ranks
    is re-seeded so diagrams reflect the current rank scheme."""
    import src.manual_test_app as app
    from src.database import create_engine_sqlite, init_db
    from sqlalchemy.orm import sessionmaker
    from src.models import Department, DeptLevel, User

    db_path = tmp_path / "stale_ranks.db"

    # Build a stale database that has all expected departments, but with the old
    # ITSO/HRO ranks (1-based) from before they were shifted to the global scheme.
    engine = create_engine_sqlite(str(db_path))
    init_db(engine)
    session = sessionmaker(bind=engine)()
    for code, name, top_rank in (
        ("FIN", "Finance", 4),
        ("HR", "Human Resources", 4),
        ("ITSO", "Information Technology Services Office", 1),
        ("HRO", "Human Resources Office", 1),
    ):
        dept = Department(name=name, code=code)
        session.add(dept)
        session.flush()
        level = DeptLevel(
            dept_id=dept.id, level_rank=top_rank, level_name="Head", is_top_level=True
        )
        session.add(level)
        session.flush()
        session.add(
            User(
                name=f"{code} Head",
                email=f"{code.lower()}@university.edu",
                dept_id=dept.id,
                dept_level_id=level.id,
            )
        )
    session.commit()
    session.close()
    engine.dispose()

    # Point the app at the stale database and force a fresh engine load.
    monkeypatch.setattr(app, "_DB_PATH", str(db_path))
    monkeypatch.setattr(app, "_engine", None)
    monkeypatch.setattr(app, "_SessionFactory", None)

    payload = app.get_seed_data()
    itso_ranks = {
        level["level_rank"]
        for level in payload["dept_levels"]
        if level["dept_name"] == "Information Technology Services Office"
    }
    assert app._EXPECTED_DEPT_LEVEL_RANKS["ITSO"].issubset(itso_ranks)


def test_stale_persisted_db_missing_acting_overlay_is_reseeded(tmp_path, monkeypatch):
    """A persisted DB seeded before the Case #1 skip-level acting overlay existed
    has the right departments and ranks but no ITSO acting assignment, so it must
    be re-seeded; otherwise Ivan's dependents (e.g. Isaac) never show the acting
    cascade."""
    import src.manual_test_app as app
    from src.database import create_engine_sqlite, init_db
    from sqlalchemy.orm import sessionmaker
    from src.models import ActingAssignment, Department
    from src.sample_data import seed_sample_data

    db_path = tmp_path / "stale_acting.db"

    # Build a fully-seeded database, then drop the acting assignments to mimic an
    # older build that never seeded the Case #1 skip-level acting overlay.
    engine = create_engine_sqlite(str(db_path))
    init_db(engine)
    session = sessionmaker(bind=engine)()
    seed_sample_data(session)
    session.query(ActingAssignment).delete()
    session.commit()
    assert app._seed_is_complete(session) is False
    session.close()
    engine.dispose()

    # Point the app at the stale database and force a fresh engine load.
    monkeypatch.setattr(app, "_DB_PATH", str(db_path))
    monkeypatch.setattr(app, "_engine", None)
    monkeypatch.setattr(app, "_SessionFactory", None)

    # Loading the app re-seeds, restoring the ITSO acting assignment.
    app.build_bootstrap_payload()
    session = app._get_session()
    itso_acting = (
        session.query(ActingAssignment)
        .join(Department, ActingAssignment.dept_id == Department.id)
        .filter(Department.code == "ITSO")
        .count()
    )
    session.close()
    assert itso_acting == 1

