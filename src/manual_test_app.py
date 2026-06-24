"""Manual test frontend and API for the reporting-line POC.

Run locally:

    python -m src.manual_test_app

Then open http://127.0.0.1:8000.

The server intentionally uses only Python's standard library so the POC does
not need a web framework dependency. Each manual test run creates a fresh
in-memory SQLite database, seeds the university sample data, applies that test
case's setup changes, and executes the same routing service used by pytest.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from src.database import create_engine_sqlite, get_session, init_db
from src.models import (
    Action,
    ActionFallbackRule,
    ActionRoutingRule,
    Department,
    DeptLevel,
    ReportingLine,
    User,
)
from src.services.routing import RoutingError, build_approval_chain


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"


ManualData = dict[str, Any]
SetupFn = Callable[[Session, ManualData], None]


def _noop_setup(session: Session, data: ManualData) -> None:
    return None


def _remove_annual_leave_fallback(session: Session, data: ManualData) -> None:
    session.delete(data["fb_al"])
    session.commit()


def _deactivate_staff_reporting_line(session: Session, data: ManualData) -> None:
    data["rl_staff_to_senior"].is_active = False
    session.commit()


def _create_reporting_cycle(session: Session, data: ManualData) -> None:
    session.add(
        ReportingLine(
            user_id=data["dept_head"].id,
            manager_id=data["staff_a"].id,
            dept_id=data["cs_dept"].id,
        )
    )
    session.commit()


MANUAL_TEST_CASES: list[dict[str, Any]] = [
    {
        "id": "TC-1",
        "title": "Annual Leave for normal staff",
        "requester_key": "staff_a",
        "action_code": "annual_leave",
        "input": "Requester: Staff A; Action: Annual Leave",
        "setup": "Normal CS reporting line: Staff A → Dr. Senior → Dr. Head",
        "expected_output": "Primary approver Dr. Senior plus second-level approver Dr. Head.",
        "pass_criteria": "2 steps returned in order: Dr. Senior, then Dr. Head; no fallback.",
        "expected": {"status": "success", "approver_names": ["Dr. Senior", "Dr. Head"], "fallback_flags": [False, False]},
        "setup_fn": _noop_setup,
    },
    {
        "id": "TC-2",
        "title": "Sick Leave for normal staff",
        "requester_key": "staff_a",
        "action_code": "sick_leave",
        "input": "Requester: Staff A; Action: Sick Leave",
        "setup": "Normal CS reporting line: Staff A → Dr. Senior → Dr. Head",
        "expected_output": "Primary approver Dr. Senior only.",
        "pass_criteria": "1 step returned: Dr. Senior; no second-level approver.",
        "expected": {"status": "success", "approver_names": ["Dr. Senior"], "fallback_flags": [False]},
        "setup_fn": _noop_setup,
    },
    {
        "id": "TC-3",
        "title": "Annual Leave for department head",
        "requester_key": "dept_head",
        "action_code": "annual_leave",
        "input": "Requester: Dr. Head; Action: Annual Leave",
        "setup": "Top-level requester has no higher CS manager; fallback rule exists.",
        "expected_output": "Fallback approver HR Officer.",
        "pass_criteria": "1 fallback step returned: HR Officer.",
        "expected": {"status": "success", "approver_names": ["HR Officer"], "fallback_flags": [True]},
        "setup_fn": _noop_setup,
    },
    {
        "id": "TC-4",
        "title": "Sick Leave for department head",
        "requester_key": "dept_head",
        "action_code": "sick_leave",
        "input": "Requester: Dr. Head; Action: Sick Leave",
        "setup": "Top-level requester has no higher CS manager; fallback rule exists.",
        "expected_output": "Fallback approver HR Officer.",
        "pass_criteria": "1 fallback step returned; no missing-manager error.",
        "expected": {"status": "success", "approver_names": ["HR Officer"], "fallback_flags": [True]},
        "setup_fn": _noop_setup,
    },
    {
        "id": "TC-5",
        "title": "Missing action rule",
        "requester_key": "staff_a",
        "action_code": "conference_travel",
        "input": "Requester: Staff A; Action: Unknown Action (conference_travel)",
        "setup": "No action or routing rule exists for conference_travel.",
        "expected_output": "Routing error explaining that the action/routing rule is missing.",
        "pass_criteria": "Clear error is returned and includes conference_travel.",
        "expected": {"status": "error", "error_contains": "conference_travel"},
        "setup_fn": _noop_setup,
    },
    {
        "id": "TC-6",
        "title": "Missing fallback rule for top-level user",
        "requester_key": "dept_head",
        "action_code": "annual_leave",
        "input": "Requester: Dr. Head; Action: Annual Leave",
        "setup": "Annual Leave fallback rule is removed before routing.",
        "expected_output": "Routing error explaining that no fallback rule is configured.",
        "pass_criteria": "Clear error is returned and mentions fallback.",
        "expected": {"status": "error", "error_contains": "fallback"},
        "setup_fn": _remove_annual_leave_fallback,
    },
    {
        "id": "TC-7",
        "title": "Missing primary manager",
        "requester_key": "staff_a",
        "action_code": "annual_leave",
        "input": "Requester: Staff A; Action: Annual Leave",
        "setup": "Staff A's reporting line is deactivated before routing.",
        "expected_output": "Routing error explaining that the primary manager was not found.",
        "pass_criteria": "Clear error is returned and mentions primary manager.",
        "expected": {"status": "error", "error_contains": "primary manager"},
        "setup_fn": _deactivate_staff_reporting_line,
    },
    {
        "id": "TC-8",
        "title": "Circular reporting detection",
        "requester_key": "staff_a",
        "action_code": "annual_leave",
        "input": "Requester: Staff A; Action: Annual Leave",
        "setup": "Cycle is created: Staff A → Dr. Senior → Dr. Head → Staff A.",
        "expected_output": "Routing error explaining that circular reporting was detected.",
        "pass_criteria": "Clear error is returned and mentions circular reporting or cycle.",
        "expected": {"status": "error", "error_contains": "circular"},
        "setup_fn": _create_reporting_cycle,
    },
]


def seed_manual_data(session: Session) -> ManualData:
    """Seed a fresh database with the university POC sample data."""
    cs_dept = Department(name="Computer Science", code="CS")
    hr_dept = Department(name="Human Resources", code="HR")
    session.add_all([cs_dept, hr_dept])
    session.flush()

    cs_level1 = DeptLevel(
        dept_id=cs_dept.id,
        level_rank=1,
        level_name="Head of Department",
        is_top_level=True,
    )
    cs_level2 = DeptLevel(
        dept_id=cs_dept.id,
        level_rank=2,
        level_name="Senior Lecturer",
        is_top_level=False,
    )
    cs_level3 = DeptLevel(
        dept_id=cs_dept.id,
        level_rank=3,
        level_name="Lecturer",
        is_top_level=False,
    )
    hr_level1 = DeptLevel(
        dept_id=hr_dept.id,
        level_rank=1,
        level_name="HR Officer",
        is_top_level=True,
    )
    session.add_all([cs_level1, cs_level2, cs_level3, hr_level1])
    session.flush()

    dept_head = User(
        name="Dr. Head",
        email="head@university.edu",
        dept_id=cs_dept.id,
        dept_level_id=cs_level1.id,
    )
    senior_lect = User(
        name="Dr. Senior",
        email="senior@university.edu",
        dept_id=cs_dept.id,
        dept_level_id=cs_level2.id,
    )
    staff_a = User(
        name="Staff A",
        email="staff.a@university.edu",
        dept_id=cs_dept.id,
        dept_level_id=cs_level3.id,
    )
    hr_officer = User(
        name="HR Officer",
        email="hr@university.edu",
        dept_id=hr_dept.id,
        dept_level_id=hr_level1.id,
    )
    session.add_all([dept_head, senior_lect, staff_a, hr_officer])
    session.flush()

    rl_staff_to_senior = ReportingLine(
        user_id=staff_a.id,
        manager_id=senior_lect.id,
        dept_id=cs_dept.id,
    )
    rl_senior_to_head = ReportingLine(
        user_id=senior_lect.id,
        manager_id=dept_head.id,
        dept_id=cs_dept.id,
    )
    session.add_all([rl_staff_to_senior, rl_senior_to_head])
    session.flush()

    annual_leave = Action(name="Annual Leave", code="annual_leave")
    sick_leave = Action(name="Sick Leave", code="sick_leave")
    session.add_all([annual_leave, sick_leave])
    session.flush()

    rule_al = ActionRoutingRule(
        action_id=annual_leave.id,
        dept_id=cs_dept.id,
        requires_primary=True,
        requires_second_level=True,
    )
    rule_sl = ActionRoutingRule(
        action_id=sick_leave.id,
        dept_id=cs_dept.id,
        requires_primary=True,
        requires_second_level=False,
    )
    session.add_all([rule_al, rule_sl])
    session.flush()

    fb_al = ActionFallbackRule(
        action_id=annual_leave.id,
        dept_id=cs_dept.id,
        fallback_user_id=hr_officer.id,
        fallback_label="HR Officer",
    )
    fb_sl = ActionFallbackRule(
        action_id=sick_leave.id,
        dept_id=cs_dept.id,
        fallback_user_id=hr_officer.id,
        fallback_label="HR Officer",
    )
    session.add_all([fb_al, fb_sl])
    session.commit()

    return {
        "cs_dept": cs_dept,
        "hr_dept": hr_dept,
        "dept_head": dept_head,
        "senior_lect": senior_lect,
        "staff_a": staff_a,
        "hr_officer": hr_officer,
        "annual_leave": annual_leave,
        "sick_leave": sick_leave,
        "fb_al": fb_al,
        "fb_sl": fb_sl,
        "rl_staff_to_senior": rl_staff_to_senior,
        "rl_senior_to_head": rl_senior_to_head,
    }


def public_test_cases() -> list[dict[str, Any]]:
    """Return test case metadata safe for the frontend."""
    return [
        {k: v for k, v in case.items() if k not in {"setup_fn", "expected"}}
        for case in MANUAL_TEST_CASES
    ]


def run_manual_test_case(test_id: str) -> dict[str, Any]:
    """Run one manual test case against a fresh in-memory database."""
    case = next((item for item in MANUAL_TEST_CASES if item["id"] == test_id), None)
    if case is None:
        return {"status": "not_found", "passed": False, "error": f"Unknown test case {test_id!r}."}

    engine = create_engine_sqlite(":memory:")
    init_db(engine)
    session = get_session(engine)

    try:
        data = seed_manual_data(session)
        case["setup_fn"](session, data)
        requester = data[case["requester_key"]]

        try:
            chain = build_approval_chain(session, requester.id, case["action_code"])
            actual = {
                "status": "success",
                "requester": chain.requester.name,
                "action": chain.action.name,
                "steps": [
                    {
                        "order": step.step_order,
                        "approver": step.approver.name,
                        "is_fallback": step.is_fallback,
                    }
                    for step in chain.steps
                ],
            }
        except RoutingError as exc:
            actual = {"status": "error", "error": str(exc)}

        passed = _matches_expected(actual, case["expected"])
        return {
            "id": case["id"],
            "title": case["title"],
            "input": case["input"],
            "setup": case["setup"],
            "expected_output": case["expected_output"],
            "pass_criteria": case["pass_criteria"],
            "passed": passed,
            "actual": actual,
        }
    finally:
        session.close()
        engine.dispose()


def run_all_manual_test_cases() -> list[dict[str, Any]]:
    """Run all manual test cases."""
    return [run_manual_test_case(case["id"]) for case in MANUAL_TEST_CASES]


def _matches_expected(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
    if actual.get("status") != expected.get("status"):
        return False

    if expected["status"] == "success":
        steps = actual.get("steps", [])
        approver_names = [step["approver"] for step in steps]
        fallback_flags = [step["is_fallback"] for step in steps]
        return (
            approver_names == expected["approver_names"]
            and fallback_flags == expected["fallback_flags"]
        )

    error = actual.get("error", "").lower()
    return expected["error_contains"].lower() in error


class ManualTestRequestHandler(BaseHTTPRequestHandler):
    """Small JSON/static-file server for manual test execution."""

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self._send_static("index.html", "text/html; charset=utf-8")
        elif path in {"/app.js", "/styles.css"}:
            content_type = "application/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8"
            self._send_static(path.lstrip("/"), content_type)
        elif path == "/api/test-cases":
            self._send_json({"test_cases": public_test_cases()})
        elif path == "/api/run-all":
            self._send_json({"results": run_all_manual_test_cases()})
        elif path.startswith("/api/test-cases/") and path.endswith("/run"):
            test_id = path.removeprefix("/api/test-cases/").removesuffix("/run")
            self._send_json(run_manual_test_case(test_id))
        else:
            self._send_json({"error": "Not found"}, status=404)

    def log_message(self, format: str, *args: Any) -> None:
        """Silence per-request logs for a cleaner POC console."""
        return None

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
    """Start the manual test frontend server."""
    server = ThreadingHTTPServer((host, port), ManualTestRequestHandler)
    print(f"Manual test frontend running at http://{host}:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
