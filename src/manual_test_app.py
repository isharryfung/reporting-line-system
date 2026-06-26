"""Simple frontend/API server for the reporting-line POC."""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from sqlalchemy import func
from sqlalchemy.orm import Session

from src.database import create_engine_sqlite, get_session, init_db
from src.models import Action, ActionRoutingRule, Department, User
from src.sample_data import seed_sample_data
from src.services.approval import submit_request
from src.services.graph_editor import (
    GraphEditError,
    apply_user_edit,
    list_customization_options,
    update_department_fallback,
    update_routing_rule,
)
from src.services.org_chart import get_department_org_chart
from src.services.permissions import validate_team_lead_edit_permission
from src.services.routing import (
    RoutingError,
    approval_chain_to_dict,
    build_approval_chain,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"
RUNTIME_DB_PATH = Path("/tmp/reporting_line_manual_test.db")


BUSINESS_CASES = [
    {
        "id": "BC-01",
        "scenario": "Official Annual Leave route uses primary and second-level approvers.",
        "input": "Requester: Peter; Action: Annual Leave",
        "preconditions": "Finance annual_leave requires primary + second level.",
        "expected_output": "Mary then Fiona.",
        "pass_criteria": "Two ordered approval steps are generated.",
    },
    {
        "id": "BC-02",
        "scenario": "Official Sick Leave route uses only the primary approver.",
        "input": "Requester: Peter; Action: Sick Leave",
        "preconditions": "Finance sick_leave requires primary only.",
        "expected_output": "Mary only.",
        "pass_criteria": "One approval step is generated.",
    },
    {
        "id": "BC-03",
        "scenario": "Department fallback covers top-level users.",
        "input": "Requester: Fiona; Action: Annual Leave",
        "preconditions": "Finance fallback approver is Henry.",
        "expected_output": "Henry as fallback approver.",
        "pass_criteria": "Fallback step is returned for top-level requester.",
    },
    {
        "id": "BC-04",
        "scenario": "Team lead may edit lower-level user in same org-unit.",
        "input": "Editor: Mary; Target: Peter",
        "preconditions": "Mary leads Finance Team; Peter is lower-level in Finance Team.",
        "expected_output": "Allowed.",
        "pass_criteria": "Permission result is allowed with same-org-unit explanation.",
    },
    {
        "id": "BC-05",
        "scenario": "Acting assignment replaces official approver during valid dates.",
        "input": "Requester: Peter; Action: Sick Leave; Date: 2027-06-15",
        "preconditions": "Mary has valid acting assignment to Nina for sick_leave.",
        "expected_output": "Nina approves instead of Mary.",
        "pass_criteria": "Final chain shows acting overlay explanation and Nina approver.",
    },
    {
        "id": "BC-06",
        "scenario": "Peer coverage replaces official approver during valid dates.",
        "input": "Requester: Peter; Action: Annual Leave; Date: 2027-08-15",
        "preconditions": "Mary has valid peer coverage by Nina for annual_leave.",
        "expected_output": "Nina then Fiona.",
        "pass_criteria": "Coverage overlay is shown and audit log is written.",
    },
    {
        "id": "BC-07",
        "scenario": "Delegation replaces approver during valid dates.",
        "input": "Requester: Peter; Action: Annual Leave; Date: 2027-09-15",
        "preconditions": "Mary delegated annual_leave approval to Nina.",
        "expected_output": "Nina then Fiona.",
        "pass_criteria": "Delegation overlay is shown and audit log is written.",
    },
    {
        "id": "BC-08",
        "scenario": "Self-approval is prevented and redirected.",
        "input": "Requester: Peter; Action: Sick Leave; Date: 2027-10-15",
        "preconditions": "Acting assignment would otherwise route approval to Peter.",
        "expected_output": "Fiona replaces self-approval.",
        "pass_criteria": "Final chain contains no requester approval step and explains redirect.",
    },
    {
        "id": "BC-09",
        "scenario": "Handover overlap can require outgoing and incoming approvers.",
        "input": "Requester: Peter; Action: Sick Leave; Date: 2027-11-15",
        "preconditions": "Peter has both_required overlap from Mary to Nina.",
        "expected_output": "Mary then Nina.",
        "pass_criteria": "Two handover steps are generated with policy explanation.",
    },
    {
        "id": "BC-10",
        "scenario": "Cross-department project routing applies only to project-scoped actions.",
        "input": "Requester: Peter; Action: Project Change Request; Project: UTP",
        "preconditions": "Peter is assigned to UTP; Helen is project manager.",
        "expected_output": "Helen approves.",
        "pass_criteria": "Project overlay replaces official route only for project action.",
    },
    {
        "id": "BC-11",
        "scenario": "Annual Leave ignores project reporting overlay.",
        "input": "Requester: Peter; Action: Annual Leave; Project: UTP",
        "preconditions": "Annual Leave is not project-scoped.",
        "expected_output": "Mary then Fiona.",
        "pass_criteria": "Project manager is not used for HR action.",
    },
    {
        "id": "BC-12",
        "scenario": "Co-head either_one_approves policy is supported.",
        "input": "Requester: Peter; Action: Finance Team Plan",
        "preconditions": "Finance Team has co-heads Mary and Nina with either_one_approves policy.",
        "expected_output": "Mary primary approver with Nina shown as alternate.",
        "pass_criteria": "Chain explains co-head policy and lists alternate approver.",
    },
    {
        "id": "BC-13",
        "scenario": "Co-head both_required policy is supported.",
        "input": "Requester: Peter; Action: Finance Team Plan",
        "preconditions": "Same co-head group switched to both_required.",
        "expected_output": "Mary then Nina.",
        "pass_criteria": "Two co-head approval steps are generated.",
    },
    {
        "id": "BC-14",
        "scenario": "Invalid delegation to inactive user is rejected.",
        "input": "Delegator: Mary; Delegate: inactive user",
        "preconditions": "Applicable delegation exists but delegate is inactive.",
        "expected_output": "Clear error.",
        "pass_criteria": "Routing rejects inactive delegate.",
    },
    {
        "id": "BC-15",
        "scenario": "Self-delegation is rejected.",
        "input": "Delegator: Mary; Delegate: Mary",
        "preconditions": "Applicable delegation exists.",
        "expected_output": "Clear error.",
        "pass_criteria": "Routing rejects self-delegation.",
    },
    {
        "id": "BC-16",
        "scenario": "Display layered org chart with ownership boundaries.",
        "input": "Department: FIN",
        "preconditions": "Level labels and ownership regions are configured.",
        "expected_output": "Level 1-9 labels plus HRO/Dept/Team Lead boundaries.",
        "pass_criteria": "Graph payload includes level labels and ownership regions.",
    },
    {
        "id": "BC-17",
        "scenario": "Edit user position/level from graph panel.",
        "input": "Editor scope: HRO; Target: Peter; Level: Finance Officer",
        "preconditions": "Target user exists and selected level belongs to selected department.",
        "expected_output": "Position/level updates successfully.",
        "pass_criteria": "Updated user level is reflected in graph and simulation.",
    },
    {
        "id": "BC-18",
        "scenario": "Edit user department and org-unit/team from graph panel.",
        "input": "Editor scope: HRO; Target: Quinn; Department: FIN; Org-unit: Team C",
        "preconditions": "Selected org-unit belongs to selected department.",
        "expected_output": "Department/team updates successfully.",
        "pass_criteria": "Updated org-unit region is reflected in graph.",
    },
    {
        "id": "BC-19",
        "scenario": "Edit primary manager/reporting line from graph panel.",
        "input": "Editor scope: HRO; Target: Peter; Manager: Nina",
        "preconditions": "New manager is active and in same department.",
        "expected_output": "New official reporting line is saved.",
        "pass_criteria": "Simulation chain reflects the updated manager.",
    },
    {
        "id": "BC-20",
        "scenario": "Scenario builder changes action type and approval level.",
        "input": "Requester: Peter; Action: annual_leave; Approval level: second_level",
        "preconditions": "Routing rule exists for selected department/action.",
        "expected_output": "Simulation reflects selected action and level rule.",
        "pass_criteria": "Generated route changes when level mode changes.",
    },
    {
        "id": "BC-21",
        "scenario": "Simulate first-level approval route.",
        "input": "Requester: Peter; Action: sick_leave",
        "preconditions": "Rule requires primary only.",
        "expected_output": "One approval step.",
        "pass_criteria": "Only primary manager appears in chain.",
    },
    {
        "id": "BC-22",
        "scenario": "Simulate second-level approval route.",
        "input": "Requester: Peter; Action: annual_leave",
        "preconditions": "Rule requires primary + second-level.",
        "expected_output": "Two approval steps.",
        "pass_criteria": "Primary and second-level approvers appear in order.",
    },
    {
        "id": "BC-23",
        "scenario": "Block circular reporting-line edit.",
        "input": "Target: Fiona; New manager: Peter",
        "preconditions": "Peter already reports through Fiona chain.",
        "expected_output": "Validation error.",
        "pass_criteria": "Edit request is rejected with circular-line message.",
    },
    {
        "id": "BC-24",
        "scenario": "Block unauthorized protected-level edit.",
        "input": "Editor scope: team_lead; Editor: Mary; Target: Fiona",
        "preconditions": "Fiona is protected top-level user.",
        "expected_output": "Validation error.",
        "pass_criteria": "Edit request is rejected as unauthorized.",
    },
    {
        "id": "BC-25",
        "scenario": "Routing output changes after graph edit.",
        "input": "Change Peter manager from Mary to Nina then run annual_leave.",
        "preconditions": "Graph edit is valid and committed.",
        "expected_output": "Nina appears as first approval step.",
        "pass_criteria": "Simulation follows updated graph configuration.",
    },
    {
        "id": "BC-26",
        "scenario": "Dashed approval path shown for selected scenario.",
        "input": "Run scenario builder simulation from diagram UI.",
        "preconditions": "Graph has official reporting edges and simulation result exists.",
        "expected_output": "Dashed approval route overlay is returned.",
        "pass_criteria": "UI draws dashed approval route nodes/edges.",
    },
]


ADVANCED_SCENARIOS = [
    {
        "id": "official_route",
        "title": "Official reporting line route",
        "description": "Core route from department reporting line.",
        "requester_name": "Peter",
        "action_code": "annual_leave",
    },
    {
        "id": "acting_route",
        "title": "Acting route",
        "description": "Mary is temporarily acted by Nina for sick leave.",
        "requester_name": "Peter",
        "action_code": "sick_leave",
        "request_at": "2027-06-15T00:00:00+00:00",
    },
    {
        "id": "peer_coverage_route",
        "title": "Peer coverage route",
        "description": "Mary is covered by Nina for annual leave.",
        "requester_name": "Peter",
        "action_code": "annual_leave",
        "request_at": "2027-08-15T00:00:00+00:00",
    },
    {
        "id": "delegation_route",
        "title": "Delegation route",
        "description": "Mary delegates annual leave approval to Nina.",
        "requester_name": "Peter",
        "action_code": "annual_leave",
        "request_at": "2027-09-15T00:00:00+00:00",
    },
    {
        "id": "handover_route",
        "title": "Handover overlap route",
        "description": "Outgoing and incoming approvers are both required.",
        "requester_name": "Peter",
        "action_code": "sick_leave",
        "request_at": "2027-11-15T00:00:00+00:00",
    },
    {
        "id": "project_route",
        "title": "Cross-department project route",
        "description": "Project-scoped action routes to cross-department project manager.",
        "requester_name": "Peter",
        "action_code": "project_change_request",
        "project_code": "UTP",
    },
    {
        "id": "co_head_route",
        "title": "Co-head route",
        "description": "Finance Team co-head policy is applied.",
        "requester_name": "Peter",
        "action_code": "finance_team_plan",
    },
    {
        "id": "self_approval_route",
        "title": "Self-approval blocked route",
        "description": "Overlay would route approval to requester, so system redirects it.",
        "requester_name": "Peter",
        "action_code": "sick_leave",
        "request_at": "2027-10-15T00:00:00+00:00",
    },
]


def _parse_request_at(raw_value: str | None) -> datetime | None:
    if not raw_value:
        return None
    return datetime.fromisoformat(raw_value)


def build_bootstrap_payload(session: Session | None = None) -> dict[str, Any]:
    if session is None:
        with _seeded_session() as (_, seeded_session, _):
            return _build_bootstrap_payload_from_session(seeded_session)
    return _build_bootstrap_payload_from_session(session)


def _build_bootstrap_payload_from_session(session: Session) -> dict[str, Any]:
    departments = session.query(Department).order_by(Department.name.asc()).all()
    actions = session.query(Action).order_by(Action.name.asc()).all()
    users = session.query(User).filter(User.is_active.is_(True)).all()
    users_payload = [_serialize_user(user) for user in users]
    users_payload.sort(
        key=lambda item: (item["department_code"], item["level_rank"], item["name"])
    )
    options = list_customization_options(session)

    return {
        "departments": [
            {"code": department.code, "name": department.name, "id": department.id}
            for department in departments
        ],
        "actions": [{"code": action.code, "name": action.name, "id": action.id} for action in actions],
        "users": users_payload,
        "options": options,
        "scenario_builder_fields": [
            "requester",
            "action_type",
            "department",
            "org_unit",
            "position_level",
            "request_effective_date",
            "approval_level_rule",
            "overlay_case",
        ],
        "business_cases": BUSINESS_CASES,
        "advanced_scenarios": ADVANCED_SCENARIOS,
        "notes": [
            "Reporting lines drive both approval routing and org-chart graph display.",
            "Each staff member can have only one active official primary manager.",
            "Use graph edit panel to update user position, department, team, manager, and lead role.",
            "Scenario builder runs simulations and returns dashed approval overlays.",
        ],
        "org_charts": {
            department.code: get_department_org_chart(session, department.code)
            for department in departments
        },
    }


def simulate_action_request(
    requester_id: int,
    action_code: str,
    request_at: str | None = None,
    project_code: str | None = None,
    department_code: str | None = None,
    org_unit_code: str | None = None,
    position_level: int | None = None,
    approval_level: str | None = None,
    session: Session | None = None,
) -> dict[str, Any]:
    if session is None:
        with _seeded_session() as (_, seeded_session, _):
            return _simulate_action_request_with_session(
                seeded_session,
                requester_id=requester_id,
                action_code=action_code,
                request_at=request_at,
                project_code=project_code,
                department_code=department_code,
                org_unit_code=org_unit_code,
                position_level=position_level,
                approval_level=approval_level,
            )
    return _simulate_action_request_with_session(
        session,
        requester_id=requester_id,
        action_code=action_code,
        request_at=request_at,
        project_code=project_code,
        department_code=department_code,
        org_unit_code=org_unit_code,
        position_level=position_level,
        approval_level=approval_level,
    )


def _simulate_action_request_with_session(
    session: Session,
    *,
    requester_id: int,
    action_code: str,
    request_at: str | None,
    project_code: str | None,
    department_code: str | None,
    org_unit_code: str | None,
    position_level: int | None,
    approval_level: str | None,
) -> dict[str, Any]:
    action = session.query(Action).filter(Action.code == action_code).first()
    updated_rule: ActionRoutingRule | None = None
    previous_second_level: bool | None = None
    try:
        requester = session.get(User, requester_id)
        if requester is None:
            return {"status": "error", "error": f"Requester id={requester_id} not found."}
        if department_code and requester.department.code != department_code:
            return {"status": "error", "error": "Requester does not belong to selected department."}
        if position_level is not None and requester.dept_level.level_rank != position_level:
            return {"status": "error", "error": "Requester does not match selected position/level."}
        if org_unit_code:
            org_units = {
                membership.org_unit.code
                for membership in requester.org_unit_memberships
                if membership.is_active
            }
            if org_unit_code not in org_units:
                return {"status": "error", "error": "Requester does not belong to selected org-unit/team."}

        if approval_level in {"first_level", "second_level"}:
            if action is not None:
                rule = (
                    session.query(ActionRoutingRule)
                    .filter(
                        ActionRoutingRule.action_id == action.id,
                        ActionRoutingRule.dept_id == requester.dept_id,
                    )
                    .first()
                )
                if rule is not None:
                    updated_rule = rule
                    previous_second_level = rule.requires_second_level
                    rule.requires_second_level = approval_level == "second_level"
                    session.flush()

        parsed_request_at = _parse_request_at(request_at)
        chain = build_approval_chain(
            session,
            requester_id,
            action_code,
            request_at=parsed_request_at,
            project_code=project_code,
        )
        request = submit_request(
            session,
            requester_id,
            action_code,
            request_at=parsed_request_at,
            project_code=project_code,
        )
        response = approval_chain_to_dict(chain)
        response.update(
            {
                "status": "success",
                "request_id": request.id,
                "request_at": request_at,
                "project_code": project_code,
                "department": requester.department.code,
                "org_units": [
                    membership.org_unit.code
                    for membership in requester.org_unit_memberships
                    if membership.is_active
                ],
                "position_level": requester.dept_level.level_rank,
                "approval_level": approval_level,
                "overlays_applied": sorted(
                    {step["source"] for step in response["steps"] if step["source"] != "official"}
                ),
                "fallback_used": any(step["is_fallback"] for step in response["steps"]),
                "audit_log": [step["explanation"] for step in response["steps"] if step["explanation"]],
            }
        )
        return response
    except RoutingError as exc:
        return {"status": "error", "error": str(exc)}
    finally:
        if updated_rule is not None and previous_second_level is not None:
            updated_rule.requires_second_level = previous_second_level
            session.commit()


def simulate_advanced_scenario(
    scenario_id: str,
    *,
    session: Session | None = None,
) -> dict[str, Any]:
    bootstrap = build_bootstrap_payload(session=session)
    scenario = next(
        (
            item
            for item in bootstrap["advanced_scenarios"]
            if item["id"] == scenario_id
        ),
        None,
    )
    if scenario is None:
        return {"status": "error", "error": f"Scenario {scenario_id!r} not found."}

    requester = next(
        user for user in bootstrap["users"] if user["name"] == scenario["requester_name"]
    )
    result = simulate_action_request(
        requester_id=requester["id"],
        action_code=scenario["action_code"],
        request_at=scenario.get("request_at"),
        project_code=scenario.get("project_code"),
        session=session,
    )
    result["scenario"] = {
        "id": scenario["id"],
        "title": scenario["title"],
        "description": scenario["description"],
    }
    return result


def simulate_team_lead_permission(
    editor_id: int,
    target_user_id: int,
    *,
    session: Session | None = None,
) -> dict[str, Any]:
    if session is None:
        with _seeded_session() as (_, seeded_session, _):
            decision = validate_team_lead_edit_permission(
                seeded_session,
                editor_id=editor_id,
                target_user_id=target_user_id,
            )
            return {"allowed": decision.allowed, "reason": decision.reason}

    decision = validate_team_lead_edit_permission(
        session,
        editor_id=editor_id,
        target_user_id=target_user_id,
    )
    return {"allowed": decision.allowed, "reason": decision.reason}


def _serialize_user(user: Any) -> dict[str, Any]:
    memberships = [
        membership.org_unit.name
        for membership in user.org_unit_memberships
        if membership.is_active
    ]
    is_team_lead = any(
        membership.is_active and membership.is_team_lead
        for membership in user.org_unit_memberships
    )
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "department_id": user.department.id,
        "department_code": user.department.code,
        "level_id": user.dept_level.id,
        "level_name": user.dept_level.level_name,
        "level_rank": user.dept_level.level_rank,
        "org_units": memberships,
        "is_team_lead": is_team_lead,
        "manager_id": _primary_manager_id(user),
    }


def _primary_manager_id(user: Any) -> int | None:
    active_lines = [
        line
        for line in user.reporting_lines
        if line.is_active and line.is_primary and line.manager is not None
    ]
    if len(active_lines) != 1:
        return None
    return active_lines[0].manager_id


class _SeededSession:
    def __enter__(self) -> tuple[Any, Any, dict[str, Any]]:
        self.engine = create_engine_sqlite(":memory:")
        init_db(self.engine)
        self.session = get_session(self.engine)
        self.data = seed_sample_data(self.session)
        return self.engine, self.session, self.data

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.session.close()
        self.engine.dispose()


def _seeded_session() -> _SeededSession:
    return _SeededSession()


_runtime_engine = None


def _runtime_session() -> Session:
    global _runtime_engine
    if _runtime_engine is None:
        RUNTIME_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _runtime_engine = create_engine_sqlite(str(RUNTIME_DB_PATH))
        init_db(_runtime_engine)
    session = get_session(_runtime_engine)
    has_users = session.query(func.count(User.id)).scalar() or 0
    if has_users == 0:
        seed_sample_data(session)
    return session


def reset_runtime_state() -> dict[str, Any]:
    if RUNTIME_DB_PATH.exists():
        RUNTIME_DB_PATH.unlink()
    global _runtime_engine
    if _runtime_engine is not None:
        _runtime_engine.dispose()
    _runtime_engine = None
    session = _runtime_session()
    try:
        return {"status": "success", "message": "Runtime state reset."}
    finally:
        session.close()


class ManualTestRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/":
            self._send_static("index.html", "text/html; charset=utf-8")
        elif path in {"/app.js", "/styles.css"}:
            content_type = (
                "application/javascript; charset=utf-8"
                if path.endswith(".js")
                else "text/css; charset=utf-8"
            )
            self._send_static(path.lstrip("/"), content_type)
        elif path == "/api/bootstrap":
            session = _runtime_session()
            try:
                self._send_json(build_bootstrap_payload(session=session))
            finally:
                session.close()
        elif path == "/api/org-chart":
            department_code = query.get("department", ["FIN"])[0]
            try:
                session = _runtime_session()
                try:
                    self._send_json(get_department_org_chart(session, department_code))
                finally:
                    session.close()
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=404)
        elif path == "/api/options":
            session = _runtime_session()
            try:
                self._send_json(list_customization_options(session))
            finally:
                session.close()
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        if self.path == "/api/simulate-request":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                result = simulate_action_request(
                    requester_id=int(payload["requester_id"]),
                    action_code=str(payload["action_code"]),
                    request_at=payload.get("request_at"),
                    project_code=payload.get("project_code"),
                    department_code=payload.get("department_code"),
                    org_unit_code=payload.get("org_unit_code"),
                    position_level=None
                    if payload.get("position_level") in {None, ""}
                    else int(payload["position_level"]),
                    approval_level=payload.get("approval_level"),
                    session=session,
                )
                self._send_json(result)
            finally:
                session.close()
            return

        if self.path == "/api/graph-edit":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                result = apply_user_edit(
                    session,
                    editor_id=None
                    if payload.get("editor_id") in {None, ""}
                    else int(payload["editor_id"]),
                    editor_scope=str(payload.get("editor_scope") or "hro"),
                    target_user_id=int(payload["target_user_id"]),
                    department_id=None
                    if payload.get("department_id") in {None, ""}
                    else int(payload["department_id"]),
                    level_id=None
                    if payload.get("level_id") in {None, ""}
                    else int(payload["level_id"]),
                    org_unit_id=None
                    if payload.get("org_unit_id") in {None, ""}
                    else int(payload["org_unit_id"]),
                    manager_id=None
                    if payload.get("manager_id") in {None, ""}
                    else int(payload["manager_id"]),
                    is_team_lead=payload.get("is_team_lead"),
                )
                self._send_json(
                    {"status": result.status, "message": result.message, **result.data}
                )
            except GraphEditError as exc:
                session.rollback()
                self._send_json({"status": "error", "error": str(exc)}, status=400)
            finally:
                session.close()
            return

        if self.path == "/api/routing-rule-edit":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                result = update_routing_rule(
                    session,
                    department_code=str(payload["department_code"]),
                    action_code=str(payload["action_code"]),
                    approval_level=str(payload["approval_level"]),
                )
                self._send_json(
                    {"status": result.status, "message": result.message, **result.data}
                )
            except GraphEditError as exc:
                session.rollback()
                self._send_json({"status": "error", "error": str(exc)}, status=400)
            finally:
                session.close()
            return

        if self.path == "/api/fallback-edit":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                result = update_department_fallback(
                    session,
                    department_code=str(payload["department_code"]),
                    fallback_user_id=int(payload["fallback_user_id"]),
                    label=payload.get("fallback_label"),
                )
                self._send_json(
                    {"status": result.status, "message": result.message, **result.data}
                )
            except GraphEditError as exc:
                session.rollback()
                self._send_json({"status": "error", "error": str(exc)}, status=400)
            finally:
                session.close()
            return

        if self.path == "/api/reset-runtime":
            self._send_json(reset_runtime_state())
            return

        if self.path == "/api/simulate-scenario":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                self._send_json(
                    simulate_advanced_scenario(str(payload["scenario_id"]), session=session)
                )
            finally:
                session.close()
            return

        if self.path == "/api/team-lead-permission":
            payload = self._read_json_body()
            session = _runtime_session()
            try:
                self._send_json(
                    simulate_team_lead_permission(
                        editor_id=int(payload["editor_id"]),
                        target_user_id=int(payload["target_user_id"]),
                        session=session,
                    )
                )
            finally:
                session.close()
            return

        self._send_json({"error": "Not found"}, status=404)

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw_body.decode("utf-8"))

    def _send_static(self, filename: str, content_type: str) -> None:
        file_path = FRONTEND_DIR / filename
        if not file_path.is_file():
            self._send_json({"error": "File not found"}, status=404)
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), ManualTestRequestHandler)
    print(f"Manual test app running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        server.server_close()


if __name__ == "__main__":  # pragma: no cover
    run()
