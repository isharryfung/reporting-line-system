"""Simple frontend/API server for the reporting-line POC."""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.database import create_engine_sqlite, get_session, init_db
from src.models import Department
from src.sample_data import seed_sample_data
from src.services.approval import submit_request
from src.services.configuration import (
    ConfigurationError,
    apply_configuration_change,
    apply_diagram_edit,
    serialize_configurable_data,
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
        "scenario": "Custom user record can be created and edited from configurable data API.",
        "input": "Create user Iris then edit level/email fields.",
        "preconditions": "Valid department, level, org-unit, and manager IDs are provided.",
        "expected_output": "User record is persisted and immediately selectable for simulation.",
        "pass_criteria": "Subsequent bootstrap payload includes updated user fields.",
    },
    {
        "id": "BC-17",
        "scenario": "Custom level/action/routing records can be configured.",
        "input": "Create department level, action type, and routing rule.",
        "preconditions": "Entity IDs are valid and rule references active action + department.",
        "expected_output": "Config records are persisted.",
        "pass_criteria": "Routing simulation uses the updated approval-step requirement.",
    },
    {
        "id": "BC-18",
        "scenario": "Diagram edit can change target user's position and org-unit.",
        "input": "Target Peter moved to another level/org-unit.",
        "preconditions": "Selected level and org-unit belong to selected department.",
        "expected_output": "Target user's assignment is updated.",
        "pass_criteria": "Org chart and configurable-data payload both show new assignment.",
    },
    {
        "id": "BC-19",
        "scenario": "Diagram edit can change target user's primary manager.",
        "input": "Target Peter re-assigned from Mary to Nina.",
        "preconditions": "New manager is active and no circular chain is formed.",
        "expected_output": "New active primary manager is applied.",
        "pass_criteria": "Routing simulation follows the updated manager.",
    },
    {
        "id": "BC-20",
        "scenario": "Diagram edit blocks circular reporting chain.",
        "input": "Attempt to set Fiona's manager to Peter.",
        "preconditions": "Fiona is already above Peter in the reporting chain.",
        "expected_output": "Edit is rejected with circular reporting message.",
        "pass_criteria": "No changes committed to reporting lines.",
    },
    {
        "id": "BC-21",
        "scenario": "Diagram edit blocks protected highest level modification.",
        "input": "Attempt to change Fiona from top level to another level.",
        "preconditions": "Fiona has protected highest-level flag.",
        "expected_output": "Edit is rejected.",
        "pass_criteria": "Protected top-level user remains unchanged.",
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


def build_bootstrap_payload() -> dict[str, Any]:
    with _seeded_session() as (_, session, data):
        users = [
            _serialize_user(user)
            for _, user in data.items()
            if hasattr(user, "email")
        ]
        users.sort(key=lambda item: (item["department_code"], item["level_rank"], item["name"]))
        return {
            "departments": [
                {"code": department.code, "name": department.name}
                for department in sorted([data["finance"], data["hr"]], key=lambda item: item.name)
            ],
            "actions": [
                {"code": data["annual_leave"].code, "name": data["annual_leave"].name},
                {"code": data["sick_leave"].code, "name": data["sick_leave"].name},
                {
                    "code": data["training_request"].code,
                    "name": data["training_request"].name,
                },
                {
                    "code": data["project_change"].code,
                    "name": data["project_change"].name,
                },
                {
                    "code": data["finance_team_plan"].code,
                    "name": data["finance_team_plan"].name,
                },
            ],
            "users": users,
            "business_cases": BUSINESS_CASES,
            "advanced_scenarios": ADVANCED_SCENARIOS,
            "notes": [
                "Reporting lines drive both approval routing and org chart display.",
                "Each staff member can have only one active official primary manager.",
                "Advanced cases are modeled as temporary overlays, not extra primary managers.",
                "Project overlays apply only to project-scoped actions.",
            ],
            "org_charts": {
                department["code"]: get_department_org_chart(session, department["code"])
                for department in [
                    {"code": data["finance"].code},
                    {"code": data["hr"].code},
                ]
            },
        }


def simulate_action_request(
    requester_id: int,
    action_code: str,
    request_at: str | None = None,
    project_code: str | None = None,
) -> dict[str, Any]:
    with _seeded_session() as (_, session, _):
        try:
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
            return _format_simulation_response(
                chain=chain,
                request_id=request.id,
                request_at=request_at,
                project_code=project_code,
            )
        except RoutingError as exc:
            return {"status": "error", "error": str(exc)}


def simulate_advanced_scenario(scenario_id: str) -> dict[str, Any]:
    bootstrap = build_bootstrap_payload()
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
    )
    result["scenario"] = {
        "id": scenario["id"],
        "title": scenario["title"],
        "description": scenario["description"],
    }
    return result


def simulate_team_lead_permission(editor_id: int, target_user_id: int) -> dict[str, Any]:
    with _seeded_session() as (_, session, _):
        return _permission_result(
            session,
            editor_id=editor_id,
            target_user_id=target_user_id,
        )


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
        "department_code": user.department.code,
        "level_name": user.dept_level.level_name,
        "level_rank": user.dept_level.level_rank,
        "org_units": memberships,
        "is_team_lead": is_team_lead,
    }


def _permission_result(session: Any, editor_id: int, target_user_id: int) -> dict[str, Any]:
    decision = validate_team_lead_edit_permission(
        session,
        editor_id=editor_id,
        target_user_id=target_user_id,
    )
    return {"allowed": decision.allowed, "reason": decision.reason}


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


class _PersistentState:
    def __init__(self) -> None:
        self.engine = create_engine_sqlite("/tmp/reporting_line_manual_test.db")
        init_db(self.engine)
        session = get_session(self.engine)
        try:
            if session.query(Department).count() == 0:
                seed_sample_data(session)
        finally:
            session.close()

    def run(self, callback: Any) -> Any:
        session = get_session(self.engine)
        try:
            return callback(session)
        finally:
            session.close()


LIVE_STATE = _PersistentState()


def _format_simulation_response(
    *,
    chain: Any,
    request_id: int,
    request_at: str | None,
    project_code: str | None,
) -> dict[str, Any]:
    response = approval_chain_to_dict(chain)
    overlays = sorted(
        {
            step["source"]
            for step in response["steps"]
            if step["source"] not in {"official", "fallback"}
        }
    )
    response.update(
        {
            "status": "success",
            "request_id": request_id,
            "request_at": request_at,
            "project_code": project_code,
            "approval_levels": len(response["steps"]),
            "fallback_used": any(step["is_fallback"] for step in response["steps"]),
            "overlays_applied": overlays,
        }
    )
    return response


def build_live_bootstrap_payload() -> dict[str, Any]:
    def _build(session: Any) -> dict[str, Any]:
        base_payload = build_bootstrap_payload()
        current = serialize_configurable_data(session)
        base_payload["configurable_data"] = current
        base_payload["departments"] = [
            {
                "code": department["code"],
                "name": department["name"],
                "id": department["id"],
            }
            for department in current["departments"]
        ]
        base_payload["actions"] = [
            {"code": action["code"], "name": action["name"], "id": action["id"]}
            for action in current["actions"]
        ]
        base_payload["users"] = [
            _serialize_live_user(user, current)
            for user in current["users"]
            if user["is_active"]
        ]
        base_payload["org_charts"] = {
            department["code"]: get_department_org_chart(session, department["code"])
            for department in current["departments"]
        }
        return base_payload

    return LIVE_STATE.run(_build)


def simulate_action_request_live(
    requester_id: int,
    action_code: str,
    request_at: str | None = None,
    project_code: str | None = None,
) -> dict[str, Any]:
    def _simulate(session: Any) -> dict[str, Any]:
        try:
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
            return _format_simulation_response(
                chain=chain,
                request_id=request.id,
                request_at=request_at,
                project_code=project_code,
            )
        except RoutingError as exc:
            return {"status": "error", "error": str(exc)}

    return LIVE_STATE.run(_simulate)


def _serialize_live_user(user: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    departments_by_id = {department["id"]: department for department in current["departments"]}
    levels_by_id = {level["id"]: level for level in current["dept_levels"]}
    org_units_by_id = {org_unit["id"]: org_unit for org_unit in current["org_units"]}
    level = levels_by_id[user["dept_level_id"]]
    department = departments_by_id[user["dept_id"]]
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "department_code": department["code"],
        "level_name": level["level_name"],
        "level_rank": level["level_rank"],
        "org_units": [
            org_units_by_id[org_unit_id]["name"]
            for org_unit_id in user["org_unit_ids"]
            if org_unit_id in org_units_by_id
        ],
        "is_team_lead": user["is_team_lead"],
    }


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
            self._send_json(build_live_bootstrap_payload())
        elif path == "/api/org-chart":
            department_code = query.get("department", ["FIN"])[0]
            try:
                self._send_json(
                    LIVE_STATE.run(
                        lambda session: get_department_org_chart(session, department_code)
                    )
                )
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=404)
        elif path == "/api/configurable-data":
            self._send_json(
                LIVE_STATE.run(lambda session: serialize_configurable_data(session))
            )
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        if self.path == "/api/simulate-request":
            payload = self._read_json_body()
            self._send_json(
                simulate_action_request_live(
                    requester_id=int(payload["requester_id"]),
                    action_code=str(payload["action_code"]),
                    request_at=payload.get("request_at"),
                    project_code=payload.get("project_code"),
                )
            )
            return

        if self.path == "/api/simulate-scenario":
            payload = self._read_json_body()
            self._send_json(simulate_advanced_scenario(str(payload["scenario_id"])))
            return

        if self.path == "/api/team-lead-permission":
            payload = self._read_json_body()
            self._send_json(
                LIVE_STATE.run(
                    lambda session: _permission_result(
                        session,
                        editor_id=int(payload["editor_id"]),
                        target_user_id=int(payload["target_user_id"]),
                    )
                )
            )
            return

        if self.path == "/api/configurable-data":
            payload = self._read_json_body()
            try:
                self._send_json(
                    LIVE_STATE.run(
                        lambda session: apply_configuration_change(
                            session,
                            entity=str(payload["entity"]),
                            operation=str(payload["operation"]),
                            payload=dict(payload.get("payload", {})),
                        )
                    )
                )
            except ConfigurationError as exc:
                self._send_json({"status": "error", "error": str(exc)}, status=400)
            return

        if self.path == "/api/diagram-edit":
            payload = self._read_json_body()
            try:
                result = LIVE_STATE.run(
                    lambda session: apply_diagram_edit(
                        session,
                        target_user_id=int(payload["target_user_id"]),
                        editor_user_id=(
                            int(payload["editor_user_id"])
                            if payload.get("editor_user_id") is not None
                            else None
                        ),
                        dept_id=(
                            int(payload["dept_id"])
                            if payload.get("dept_id") is not None
                            else None
                        ),
                        dept_level_id=(
                            int(payload["dept_level_id"])
                            if payload.get("dept_level_id") is not None
                            else None
                        ),
                        manager_id=(
                            int(payload["manager_id"])
                            if payload.get("manager_id") is not None
                            else None
                        ),
                        org_unit_ids=(
                            [int(org_unit_id) for org_unit_id in payload["org_unit_ids"]]
                            if payload.get("org_unit_ids") is not None
                            else None
                        ),
                        is_team_lead=payload.get("is_team_lead"),
                    )
                )
                self._send_json(
                    {
                        "status": "success",
                        "result": {
                            "target_user_id": result.target_user_id,
                            "manager_id": result.manager_id,
                            "dept_id": result.department_id,
                            "dept_level_id": result.dept_level_id,
                            "org_unit_ids": result.org_unit_ids,
                            "is_team_lead": result.is_team_lead,
                        },
                    }
                )
            except ConfigurationError as exc:
                self._send_json({"status": "error", "error": str(exc)}, status=400)
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
