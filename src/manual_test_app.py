"""Simple frontend/API server for the reporting-line POC."""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.database import create_engine_sqlite, get_session, init_db
from src.sample_data import seed_sample_data
from src.services.approval import submit_request
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
            response = approval_chain_to_dict(chain)
            response.update(
                {
                    "status": "success",
                    "request_id": request.id,
                    "request_at": request_at,
                    "project_code": project_code,
                }
            )
            return response
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
        "department_code": user.department.code,
        "level_name": user.dept_level.level_name,
        "level_rank": user.dept_level.level_rank,
        "org_units": memberships,
        "is_team_lead": is_team_lead,
    }


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
            self._send_json(build_bootstrap_payload())
        elif path == "/api/org-chart":
            department_code = query.get("department", ["FIN"])[0]
            try:
                with _seeded_session() as (_, session, _):
                    self._send_json(get_department_org_chart(session, department_code))
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=404)
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        if self.path == "/api/simulate-request":
            payload = self._read_json_body()
            self._send_json(
                simulate_action_request(
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
                simulate_team_lead_permission(
                    editor_id=int(payload["editor_id"]),
                    target_user_id=int(payload["target_user_id"]),
                )
            )
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
