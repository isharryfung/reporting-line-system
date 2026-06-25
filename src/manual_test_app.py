"""Simple frontend/API server for the reporting-line POC."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.database import create_engine_sqlite, get_session, init_db
from src.sample_data import seed_sample_data
from src.services.approval import submit_request
from src.services.org_chart import get_department_org_chart
from src.services.permissions import validate_team_lead_edit_permission
from src.services.routing import RoutingError


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"


BUSINESS_CASES = [
    {
        "id": "BC-01",
        "scenario": "Finance staff Annual Leave routes to primary and second-level approvers.",
        "input": "Requester: Peter; Action: Annual Leave",
        "preconditions": "Finance annual_leave requires primary + second level.",
        "expected_output": "Mary then Fiona.",
        "pass_criteria": "Two ordered approval steps are generated.",
    },
    {
        "id": "BC-02",
        "scenario": "Finance staff Sick Leave routes to primary approver only.",
        "input": "Requester: Peter; Action: Sick Leave",
        "preconditions": "Finance sick_leave requires primary only.",
        "expected_output": "Mary only.",
        "pass_criteria": "One approval step is generated.",
    },
    {
        "id": "BC-03",
        "scenario": "HR staff Annual Leave uses department-specific routing.",
        "input": "Requester: Olivia; Action: Annual Leave",
        "preconditions": "HR annual_leave requires primary only.",
        "expected_output": "Helen only.",
        "pass_criteria": "HR routing differs from Finance for the same action.",
    },
    {
        "id": "BC-04",
        "scenario": "Finance director uses department-level fallback approver.",
        "input": "Requester: Fiona; Action: Annual Leave",
        "preconditions": "Finance fallback approver is Henry.",
        "expected_output": "Henry as fallback approver.",
        "pass_criteria": "Fallback step is returned for the top-level requester.",
    },
    {
        "id": "BC-05",
        "scenario": "Mary may edit Peter inside Finance Team because Peter is lower level.",
        "input": "Editor: Mary; Target: Peter",
        "preconditions": "Mary is Finance Team lead; Peter is Finance Officer in Finance Team.",
        "expected_output": "Allowed.",
        "pass_criteria": "Permission result is allowed with a same-org-unit explanation.",
    },
    {
        "id": "BC-06",
        "scenario": "Acting/delegation is not supported in this POC.",
        "input": "Any acting or delegate request",
        "preconditions": "POC scope excludes acting/delegation.",
        "expected_output": "Feature is documented as unsupported/future enhancement.",
        "pass_criteria": "No acting/delegation workflow is exposed by the POC.",
    },
]


def build_bootstrap_payload() -> dict[str, Any]:
    with _seeded_session() as (_, session, data):
        users = [
            _serialize_user(user)
            for key, user in data.items()
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
            ],
            "users": users,
            "business_cases": BUSINESS_CASES,
            "notes": [
                "Reporting lines drive both approval routing and org chart display.",
                "Each staff member can have only one active primary manager.",
                "Acting/delegation is intentionally out of scope for this POC.",
            ],
            "org_charts": {
                department["code"]: get_department_org_chart(session, department["code"])
                for department in [
                    {"code": data["finance"].code},
                    {"code": data["hr"].code},
                ]
            },
        }


def simulate_action_request(requester_id: int, action_code: str) -> dict[str, Any]:
    with _seeded_session() as (_, session, _):
        try:
            request = submit_request(session, requester_id, action_code)
            session.refresh(request)
            return {
                "status": "success",
                "request_id": request.id,
                "requester": request.requester.name,
                "action": request.action.name,
                "steps": [
                    {
                        "order": step.step_order,
                        "approver": step.approver.name,
                        "is_fallback": step.is_fallback,
                    }
                    for step in request.steps
                ],
            }
        except RoutingError as exc:
            return {"status": "error", "error": str(exc)}


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
                )
            )
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


def run_server(host: str = "127.0.0.1", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), ManualTestRequestHandler)
    print(f"Manual test frontend running at http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
