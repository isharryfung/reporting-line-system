"""Simple frontend/API server for the reporting-line POC."""

from __future__ import annotations

import json
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from sqlalchemy.orm import Session

from src.database import create_engine_sqlite, get_session, init_db
from src.models import (
    Action,
    ActionRoutingRule,
    ActingAssignment,
    ApprovalRequest,
    ApprovalStep,
    ApprovalRouteTemplate,
    AuditLog,
    CoHeadAssignment,
    CoverageAssignment,
    DelegationAssignment,
    Department,
    DepartmentFallbackRule,
    DeptLevel,
    HandoverOverlap,
    OrgUnit,
    OrgUnitMembership,
    ProjectAssignment,
    ProjectReportingLine,
    ReportingLine,
    User,
)
from src.sample_data import seed_approval_templates, seed_sample_data
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

# ---------------------------------------------------------------------------
# Persistent state: one SQLite file, seeded once per process.
# Set REPORTING_LINE_DB env var to override the path (useful for tests).
# ---------------------------------------------------------------------------
_DB_PATH = os.environ.get("REPORTING_LINE_DB", "/tmp/reporting_line_manual_test.db")
_engine = None
_SessionFactory = None

# Department codes the sample data is expected to seed. A persisted database
# created by an older build (e.g. before the ITSO/HRO or EXEC departments were
# added) will be missing some of these, in which case it is re-seeded so the
# diagrams always show the full sample organisation, including the Layer 1
# corporate tier (EXEC: Provost > VP > School).
_EXPECTED_SEED_DEPARTMENTS = frozenset({"FIN", "HR", "ITSO", "HRO", "EXEC"})

# Level ranks the sample data is expected to seed per department. A persisted
# database created by an older build may still carry stale ranks (e.g. ITSO/HRO
# levels before they were shifted to the global rank scheme), in which case it is
# re-seeded so the diagrams always reflect the current ranks.
_EXPECTED_DEPT_LEVEL_RANKS = {
    "ITSO": frozenset({4, 5, 6, 7, 8, 9}),
    "HRO": frozenset({4, 5, 6, 8, 9}),
}


def _get_engine():
    global _engine, _SessionFactory
    if _engine is None:
        _engine = create_engine_sqlite(_DB_PATH)
        init_db(_engine)
        from sqlalchemy.orm import sessionmaker
        _SessionFactory = sessionmaker(bind=_engine)
        # Seed if empty, or re-seed if a persisted database from an older build
        # is missing some of the expected sample departments (e.g. ITSO/HRO).
        session = _SessionFactory()
        try:
            if session.query(User).count() == 0:
                seed_sample_data(session)
            elif not _seed_is_complete(session):
                session.close()
                _reseed_engine()
                return _engine
        finally:
            session.close()
    return _engine


def _seed_is_complete(session: Session) -> bool:
    """Return True if the persisted sample organisation is up to date.

    Checks that every expected sample department exists, that the ITSO/HRO
    departments carry the current expected level ranks, and that the seeded
    Case #1 (skip-level acting) overlay is present, so a database seeded by an
    older build (e.g. with stale ITSO/HRO ranks, or from before the acting
    overlay was seeded) is re-seeded.
    """
    existing = {code for (code,) in session.query(Department.code).all()}
    if not _EXPECTED_SEED_DEPARTMENTS.issubset(existing):
        return False
    for code, expected_ranks in _EXPECTED_DEPT_LEVEL_RANKS.items():
        ranks = {
            rank
            for (rank,) in session.query(DeptLevel.level_rank)
            .join(Department, DeptLevel.dept_id == Department.id)
            .filter(Department.code == code)
            .all()
        }
        if not expected_ranks.issubset(ranks):
            return False
    # A database seeded before the Case #1 skip-level acting overlay was added
    # has the right departments and ranks but no ITSO acting assignment, so the
    # cascade onto Ivan's dependents (e.g. Isaac) never appears. Treat that as
    # stale so it is re-seeded.
    itso_acting = (
        session.query(ActingAssignment.id)
        .join(Department, ActingAssignment.dept_id == Department.id)
        .filter(Department.code == "ITSO")
        .first()
    )
    if itso_acting is None:
        return False
    # A database seeded before Case #3 (Partial Acting) lacks the Performance
    # Review action used to scope the performance-review coverage overlay, so its
    # leave/review decoupling cannot be simulated. Treat that as stale too.
    performance_review = (
        session.query(Action.id)
        .filter(Action.code == "performance_review")
        .first()
    )
    if performance_review is None:
        return False
    return True


def _reseed_engine() -> None:
    """Drop and re-create the schema on the active engine, then re-seed."""
    from src.models import Base
    Base.metadata.drop_all(_engine)
    Base.metadata.create_all(_engine)
    session = _SessionFactory()
    try:
        seed_sample_data(session)
    finally:
        session.close()


def _get_session() -> Session:
    _get_engine()
    return _SessionFactory()


def _reset_database() -> None:
    """Drop all data and re-seed from defaults."""
    if _engine is not None:
        _reseed_engine()
    else:
        _get_engine()


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
        "scenario": "Diagram node edit updates level and refreshes chart.",
        "input": "Edit Peter's level from Finance Officer (Level 9) to Senior Manager (Level 5)",
        "preconditions": "POC state is editable via diagram UI.",
        "expected_output": "Peter's node shows Level 5; routing chain updates accordingly.",
        "pass_criteria": "PUT /api/users/{id} persists change; GET /api/org-chart reflects update.",
    },
    {
        "id": "BC-17",
        "scenario": "Diagram edge edit updates reporting line.",
        "input": "Change Peter's manager from Mary to Nina via diagram edit panel",
        "preconditions": "POC state is editable via diagram UI.",
        "expected_output": "Peter's manager is now Nina; Annual Leave routes Peter→Nina→Fiona.",
        "pass_criteria": "POST /api/reporting-lines persists change; routing reflects new manager.",
    },
    {
        "id": "BC-18",
        "scenario": "Circular reporting line edit is blocked.",
        "input": "Attempt to set Fiona's manager to Peter",
        "preconditions": "Peter reports to Mary who reports to Fiona — would create a cycle.",
        "expected_output": "Validation error: circular reporting line detected.",
        "pass_criteria": "POST /api/reporting-lines returns 400 with clear error.",
    },
    {
        "id": "BC-19",
        "scenario": "Seed data edit changes available users in scenario builder.",
        "input": "Add new user via seed data editor; run scenario",
        "preconditions": "POC seed data is editable.",
        "expected_output": "New user appears in requester dropdown and can be selected.",
        "pass_criteria": "POST /api/users creates user; bootstrap returns updated list.",
    },
    {
        "id": "BC-20",
        "scenario": "Corrected default levels are displayed.",
        "input": "Load the POC page",
        "preconditions": "Default seed data is loaded.",
        "expected_output": "Director shown as Level 4, Senior Manager as Level 5, Officer as Level 9.",
        "pass_criteria": "Seed user pills and org chart nodes show correct level labels and ranks.",
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


# ---------------------------------------------------------------------------
# Circular-reporting detection helper
# ---------------------------------------------------------------------------

def _would_create_cycle(session: Session, user_id: int, proposed_manager_id: int) -> bool:
    """Return True if making proposed_manager_id the manager of user_id would create a cycle."""
    if user_id == proposed_manager_id:
        return True
    visited: set[int] = set()
    current = proposed_manager_id
    while current is not None:
        if current in visited:
            break
        if current == user_id:
            return True
        visited.add(current)
        line = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id == current,
                ReportingLine.is_primary.is_(True),
                ReportingLine.is_active.is_(True),
            )
            .first()
        )
        if line is None:
            break
        current = line.manager_id
    return False


def build_bootstrap_payload() -> dict[str, Any]:
    session = _get_session()
    try:
        departments = session.query(Department).order_by(Department.name).all()
        users_raw = session.query(User).filter(User.is_active.is_(True)).all()
        users = sorted(
            [_serialize_user(user) for user in users_raw],
            key=lambda item: (item["department_code"], item["level_rank"], item["name"]),
        )
        actions_raw = session.query(Action).order_by(Action.name).all()
        return {
            "departments": [
                {"code": d.code, "name": d.name} for d in departments
            ],
            "actions": [
                {"code": a.code, "name": a.name} for a in actions_raw
            ],
            "users": users,
            "business_cases": BUSINESS_CASES,
            "advanced_scenarios": ADVANCED_SCENARIOS,
            "overlay_simulations": [
                {"type": key, **meta} for key, meta in OVERLAY_SIMULATIONS.items()
            ],
            "handover_policies": HANDOVER_POLICIES,
            "notes": [
                "Reporting lines drive both approval routing and org chart display.",
                "Each staff member can have only one active official primary manager.",
                "Advanced cases are modeled as temporary overlays, not extra primary managers.",
                "Project overlays apply only to project-scoped actions.",
                "Director = Level 4, Senior Manager = Level 5, Officer = Level 9.",
            ],
            "org_charts": {
                d.code: get_department_org_chart(session, d.code)
                for d in departments
            },
        }
    finally:
        session.close()


def simulate_action_request(
    requester_id: int,
    action_code: str,
    request_at: str | None = None,
    project_code: str | None = None,
) -> dict[str, Any]:
    session = _get_session()
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
    finally:
        session.close()


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
    session = _get_session()
    try:
        decision = validate_team_lead_edit_permission(
            session,
            editor_id=editor_id,
            target_user_id=target_user_id,
        )
        return {"allowed": decision.allowed, "reason": decision.reason}
    finally:
        session.close()


def _serialize_user(user: Any) -> dict[str, Any]:
    memberships = [
        membership.org_unit.name
        for membership in user.org_unit_memberships
        if membership.is_active
    ]
    org_unit_ids = [
        membership.org_unit.id
        for membership in user.org_unit_memberships
        if membership.is_active
    ]
    is_team_lead = any(
        membership.is_active and membership.is_team_lead
        for membership in user.org_unit_memberships
    )
    active_lines = [
        line
        for line in user.reporting_lines
        if line.is_active and line.is_primary and line.manager is not None
    ]
    manager_id = active_lines[0].manager_id if len(active_lines) == 1 else None
    manager_name = active_lines[0].manager.name if len(active_lines) == 1 else None
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "department_code": user.department.code,
        "department_id": user.dept_id,
        "level_name": user.dept_level.level_name,
        "level_rank": user.dept_level.level_rank,
        "dept_level_id": user.dept_level_id,
        "org_units": memberships,
        "org_unit_ids": org_unit_ids,
        "is_team_lead": is_team_lead,
        "is_active": user.is_active,
        "manager_id": manager_id,
        "manager_name": manager_name,
    }


# ---------------------------------------------------------------------------
# Seed data read helpers
# ---------------------------------------------------------------------------

def get_seed_data() -> dict[str, Any]:
    """Return all editable seed data tables."""
    session = _get_session()
    try:
        departments = session.query(Department).order_by(Department.name).all()
        dept_levels = session.query(DeptLevel).order_by(DeptLevel.dept_id, DeptLevel.level_rank).all()
        org_units = session.query(OrgUnit).order_by(OrgUnit.name).all()
        users = session.query(User).order_by(User.name).all()
        reporting_lines = (
            session.query(ReportingLine)
            .filter(ReportingLine.is_active.is_(True))
            .order_by(ReportingLine.user_id)
            .all()
        )
        actions = session.query(Action).order_by(Action.name).all()
        routing_rules = session.query(ActionRoutingRule).all()
        fallback_rules = session.query(DepartmentFallbackRule).all()

        return {
            "departments": [
                {"id": d.id, "name": d.name, "code": d.code}
                for d in departments
            ],
            "dept_levels": [
                {
                    "id": lv.id,
                    "dept_id": lv.dept_id,
                    "dept_name": lv.department.name,
                    "level_rank": lv.level_rank,
                    "level_name": lv.level_name,
                    "is_top_level": lv.is_top_level,
                }
                for lv in dept_levels
            ],
            "org_units": [
                {"id": ou.id, "dept_id": ou.dept_id, "dept_name": ou.department.name,
                 "name": ou.name, "code": ou.code}
                for ou in org_units
            ],
            "users": [
                {
                    "id": u.id,
                    "name": u.name,
                    "email": u.email,
                    "dept_id": u.dept_id,
                    "dept_name": u.department.name,
                    "dept_level_id": u.dept_level_id,
                    "level_name": u.dept_level.level_name,
                    "level_rank": u.dept_level.level_rank,
                    "is_active": u.is_active,
                }
                for u in users
            ],
            "reporting_lines": [
                {
                    "id": rl.id,
                    "user_id": rl.user_id,
                    "user_name": rl.user.name,
                    "manager_id": rl.manager_id,
                    "manager_name": rl.manager.name if rl.manager else None,
                    "dept_id": rl.dept_id,
                    "is_primary": rl.is_primary,
                    "is_active": rl.is_active,
                }
                for rl in reporting_lines
            ],
            "actions": [
                {
                    "id": a.id,
                    "name": a.name,
                    "code": a.code,
                    "is_project_scoped": a.is_project_scoped,
                }
                for a in actions
            ],
            "routing_rules": [
                {
                    "id": rr.id,
                    "action_id": rr.action_id,
                    "action_name": rr.action.name,
                    "dept_id": rr.dept_id,
                    "dept_name": rr.department.name,
                    "requires_primary": rr.requires_primary,
                    "requires_second_level": rr.requires_second_level,
                }
                for rr in routing_rules
            ],
            "fallback_rules": [
                {
                    "id": fb.id,
                    "dept_id": fb.dept_id,
                    "dept_name": fb.department.name,
                    "fallback_user_id": fb.fallback_user_id,
                    "fallback_user_name": fb.fallback_user.name if fb.fallback_user else None,
                    "fallback_label": fb.fallback_label,
                }
                for fb in fallback_rules
            ],
        }
    finally:
        session.close()


# ---------------------------------------------------------------------------
# User CRUD
# ---------------------------------------------------------------------------

def api_update_user(user_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update an existing user's fields."""
    session = _get_session()
    try:
        user = session.get(User, user_id)
        if user is None:
            return {"error": f"User {user_id} not found."}, 404

        if "name" in body:
            body_name = str(body["name"]).strip()
            if not body_name:
                return {"error": "name must not be empty."}, 400
            user.name = body_name

        if "email" in body:
            body_email = str(body["email"]).strip()
            if not body_email:
                return {"error": "email must not be empty."}, 400
            user.email = body_email

        if "dept_level_id" in body:
            level_id = int(body["dept_level_id"])
            level = session.get(DeptLevel, level_id)
            if level is None:
                return {"error": f"DeptLevel {level_id} not found."}, 400
            user.dept_level_id = level_id
            user.dept_id = level.dept_id  # keep department in sync with level

        if "dept_id" in body:
            dept_id = int(body["dept_id"])
            dept = session.get(Department, dept_id)
            if dept is None:
                return {"error": f"Department {dept_id} not found."}, 400
            user.dept_id = dept_id

        if "is_active" in body:
            user.is_active = bool(body["is_active"])

        session.commit()
        session.refresh(user)

        # Also handle org-unit membership update
        if "org_unit_id" in body or "is_team_lead" in body:
            new_ou_id = body.get("org_unit_id")
            is_lead = bool(body.get("is_team_lead", False))
            if new_ou_id is not None:
                new_ou_id = int(new_ou_id)
                # Deactivate all current memberships
                for m in user.org_unit_memberships:
                    m.is_active = False
                # Find or create membership in target org unit
                existing = (
                    session.query(OrgUnitMembership)
                    .filter(
                        OrgUnitMembership.user_id == user_id,
                        OrgUnitMembership.org_unit_id == new_ou_id,
                    )
                    .first()
                )
                if existing:
                    existing.is_active = True
                    existing.is_team_lead = is_lead
                else:
                    session.add(
                        OrgUnitMembership(
                            org_unit_id=new_ou_id,
                            user_id=user_id,
                            is_team_lead=is_lead,
                        )
                    )
                session.commit()
                session.refresh(user)

        return {"status": "ok", "user": _serialize_user(user)}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_create_user(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create a new user."""
    session = _get_session()
    try:
        name = str(body.get("name", "")).strip()
        email = str(body.get("email", "")).strip()
        dept_level_id = body.get("dept_level_id")
        if not name or not email or dept_level_id is None:
            return {"error": "name, email, and dept_level_id are required."}, 400

        dept_level_id = int(dept_level_id)
        level = session.get(DeptLevel, dept_level_id)
        if level is None:
            return {"error": f"DeptLevel {dept_level_id} not found."}, 400

        # Check email uniqueness
        existing = session.query(User).filter(User.email == email).first()
        if existing:
            return {"error": f"Email {email!r} is already in use."}, 400

        user = User(
            name=name,
            email=email,
            dept_id=level.dept_id,
            dept_level_id=dept_level_id,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return {"status": "ok", "user": _serialize_user(user)}, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_user(user_id: int) -> tuple[dict[str, Any], int]:
    """Delete a user if it is not referenced by dependent records."""
    session = _get_session()
    try:
        user = session.get(User, user_id)
        if user is None:
            return {"error": f"User {user_id} not found."}, 404

        dependency_checks: list[tuple[str, int]] = [
            (
                "reporting lines",
                session.query(ReportingLine)
                .filter(
                    (ReportingLine.user_id == user_id) | (ReportingLine.manager_id == user_id)
                )
                .count(),
            ),
            (
                "org unit memberships",
                session.query(OrgUnitMembership)
                .filter(OrgUnitMembership.user_id == user_id)
                .count(),
            ),
            (
                "department fallback rules",
                session.query(DepartmentFallbackRule)
                .filter(DepartmentFallbackRule.fallback_user_id == user_id)
                .count(),
            ),
            (
                "acting assignments",
                session.query(ActingAssignment)
                .filter(
                    (ActingAssignment.principal_user_id == user_id)
                    | (ActingAssignment.acting_user_id == user_id)
                )
                .count(),
            ),
            (
                "coverage assignments",
                session.query(CoverageAssignment)
                .filter(
                    (CoverageAssignment.covered_user_id == user_id)
                    | (CoverageAssignment.coverage_user_id == user_id)
                )
                .count(),
            ),
            (
                "delegation assignments",
                session.query(DelegationAssignment)
                .filter(
                    (DelegationAssignment.delegator_user_id == user_id)
                    | (DelegationAssignment.delegate_user_id == user_id)
                )
                .count(),
            ),
            (
                "handover overlaps",
                session.query(HandoverOverlap)
                .filter(
                    (HandoverOverlap.requester_user_id == user_id)
                    | (HandoverOverlap.old_approver_id == user_id)
                    | (HandoverOverlap.new_approver_id == user_id)
                )
                .count(),
            ),
            (
                "project assignments",
                session.query(ProjectAssignment)
                .filter(ProjectAssignment.user_id == user_id)
                .count(),
            ),
            (
                "project reporting lines",
                session.query(ProjectReportingLine)
                .filter(
                    (ProjectReportingLine.user_id == user_id)
                    | (ProjectReportingLine.project_manager_id == user_id)
                )
                .count(),
            ),
            (
                "co-head assignments",
                session.query(CoHeadAssignment)
                .filter(CoHeadAssignment.user_id == user_id)
                .count(),
            ),
            (
                "approval requests",
                session.query(ApprovalRequest)
                .filter(ApprovalRequest.requester_id == user_id)
                .count(),
            ),
            (
                "approval steps",
                session.query(ApprovalStep)
                .filter(ApprovalStep.approver_id == user_id)
                .count(),
            ),
        ]

        blockers = [f"{count} {label}" for label, count in dependency_checks if count > 0]
        if blockers:
            return {
                "error": f"Cannot delete user: referenced by {', '.join(blockers)}."
            }, 400

        session.delete(user)
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Reporting-line CRUD
# ---------------------------------------------------------------------------

def api_create_reporting_line(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create or replace the active primary reporting line for a user."""
    session = _get_session()
    try:
        user_id = body.get("user_id")
        manager_id = body.get("manager_id")
        if user_id is None or manager_id is None:
            return {"error": "user_id and manager_id are required."}, 400

        user_id = int(user_id)
        manager_id = int(manager_id)

        user = session.get(User, user_id)
        manager = session.get(User, manager_id)
        if user is None:
            return {"error": f"User {user_id} not found."}, 404
        if manager is None:
            return {"error": f"Manager {manager_id} not found."}, 404

        # Circular check
        if _would_create_cycle(session, user_id, manager_id):
            return {
                "error": "Circular reporting line detected: this assignment would create a cycle."
            }, 400

        # Deactivate current primary lines for this user
        existing_lines = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id == user_id,
                ReportingLine.is_primary.is_(True),
                ReportingLine.is_active.is_(True),
            )
            .all()
        )
        for line in existing_lines:
            line.is_active = False

        # Create new primary line
        new_line = ReportingLine(
            user_id=user_id,
            manager_id=manager_id,
            dept_id=user.dept_id,
            is_primary=True,
        )
        session.add(new_line)
        session.commit()
        return {
            "status": "ok",
            "reporting_line": {
                "id": new_line.id,
                "user_id": user_id,
                "user_name": user.name,
                "manager_id": manager_id,
                "manager_name": manager.name,
            },
        }, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_reporting_line(line_id: int) -> tuple[dict[str, Any], int]:
    """Deactivate a reporting line by ID."""
    session = _get_session()
    try:
        line = session.get(ReportingLine, line_id)
        if line is None:
            return {"error": f"ReportingLine {line_id} not found."}, 404
        line.is_active = False
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Dept-level CRUD
# ---------------------------------------------------------------------------

def api_update_dept_level(level_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update a department level's name or rank."""
    session = _get_session()
    try:
        level = session.get(DeptLevel, level_id)
        if level is None:
            return {"error": f"DeptLevel {level_id} not found."}, 404

        if "level_name" in body:
            level.level_name = str(body["level_name"]).strip()
        if "level_rank" in body:
            level.level_rank = int(body["level_rank"])
        if "is_top_level" in body:
            level.is_top_level = bool(body["is_top_level"])

        session.commit()
        return {
            "status": "ok",
            "dept_level": {
                "id": level.id,
                "dept_id": level.dept_id,
                "level_rank": level.level_rank,
                "level_name": level.level_name,
                "is_top_level": level.is_top_level,
            },
        }, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_create_dept_level(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create a new department level."""
    session = _get_session()
    try:
        dept_id = body.get("dept_id")
        level_rank = body.get("level_rank")
        level_name = str(body.get("level_name", "")).strip()
        if dept_id is None or level_rank is None or not level_name:
            return {"error": "dept_id, level_rank, and level_name are required."}, 400

        dept_id = int(dept_id)
        level_rank = int(level_rank)
        if session.get(Department, dept_id) is None:
            return {"error": f"Department {dept_id} not found."}, 400

        duplicate = (
            session.query(DeptLevel)
            .filter(DeptLevel.dept_id == dept_id, DeptLevel.level_rank == level_rank)
            .first()
        )
        if duplicate:
            return {
                "error": f"Level rank {level_rank} already exists for this department."
            }, 400

        level = DeptLevel(
            dept_id=dept_id,
            level_rank=level_rank,
            level_name=level_name,
            is_top_level=bool(body.get("is_top_level", False)),
        )
        session.add(level)
        session.commit()
        session.refresh(level)
        return {
            "status": "ok",
            "dept_level": {
                "id": level.id,
                "dept_id": level.dept_id,
                "level_rank": level.level_rank,
                "level_name": level.level_name,
                "is_top_level": level.is_top_level,
            },
        }, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_dept_level(level_id: int) -> tuple[dict[str, Any], int]:
    """Delete a department level if no users are assigned to it."""
    session = _get_session()
    try:
        level = session.get(DeptLevel, level_id)
        if level is None:
            return {"error": f"DeptLevel {level_id} not found."}, 404
        user_count = session.query(User).filter(User.dept_level_id == level_id).count()
        if user_count > 0:
            return {
                "error": f"Cannot delete level: {user_count} user(s) are assigned to it."
            }, 400
        session.delete(level)
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Department CRUD
# ---------------------------------------------------------------------------

def api_create_department(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create a new department."""
    session = _get_session()
    try:
        name = str(body.get("name", "")).strip()
        code = str(body.get("code", "")).strip()
        if not name or not code:
            return {"error": "name and code are required."}, 400
        if session.query(Department).filter(Department.code == code).first():
            return {"error": f"Department code {code!r} is already in use."}, 400
        if session.query(Department).filter(Department.name == name).first():
            return {"error": f"Department name {name!r} is already in use."}, 400
        dept = Department(name=name, code=code)
        session.add(dept)
        session.commit()
        session.refresh(dept)
        return {
            "status": "ok",
            "department": {"id": dept.id, "name": dept.name, "code": dept.code},
        }, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_update_department(dept_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update a department's name or code."""
    session = _get_session()
    try:
        dept = session.get(Department, dept_id)
        if dept is None:
            return {"error": f"Department {dept_id} not found."}, 404

        if "name" in body:
            name = str(body["name"]).strip()
            if not name:
                return {"error": "name must not be empty."}, 400
            clash = (
                session.query(Department)
                .filter(Department.name == name, Department.id != dept_id)
                .first()
            )
            if clash:
                return {"error": f"Department name {name!r} is already in use."}, 400
            dept.name = name

        if "code" in body:
            code = str(body["code"]).strip()
            if not code:
                return {"error": "code must not be empty."}, 400
            clash = (
                session.query(Department)
                .filter(Department.code == code, Department.id != dept_id)
                .first()
            )
            if clash:
                return {"error": f"Department code {code!r} is already in use."}, 400
            dept.code = code

        session.commit()
        return {
            "status": "ok",
            "department": {"id": dept.id, "name": dept.name, "code": dept.code},
        }, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_department(dept_id: int) -> tuple[dict[str, Any], int]:
    """Delete a department if it has no users."""
    session = _get_session()
    try:
        dept = session.get(Department, dept_id)
        if dept is None:
            return {"error": f"Department {dept_id} not found."}, 404
        user_count = session.query(User).filter(User.dept_id == dept_id).count()
        if user_count > 0:
            return {
                "error": f"Cannot delete department: {user_count} user(s) belong to it."
            }, 400
        session.delete(dept)  # cascades to levels, org_units, fallback rules
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Action CRUD
# ---------------------------------------------------------------------------

def api_create_action(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create a new action."""
    session = _get_session()
    try:
        name = str(body.get("name", "")).strip()
        code = str(body.get("code", "")).strip()
        if not name or not code:
            return {"error": "name and code are required."}, 400
        if session.query(Action).filter(Action.code == code).first():
            return {"error": f"Action code {code!r} is already in use."}, 400
        if session.query(Action).filter(Action.name == name).first():
            return {"error": f"Action name {name!r} is already in use."}, 400
        action = Action(
            name=name,
            code=code,
            is_project_scoped=bool(body.get("is_project_scoped", False)),
        )
        session.add(action)
        session.commit()
        session.refresh(action)
        return {
            "status": "ok",
            "action": {
                "id": action.id,
                "name": action.name,
                "code": action.code,
                "is_project_scoped": action.is_project_scoped,
            },
        }, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_update_action(action_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update an action's name, code, or project-scoped flag."""
    session = _get_session()
    try:
        action = session.get(Action, action_id)
        if action is None:
            return {"error": f"Action {action_id} not found."}, 404

        if "name" in body:
            name = str(body["name"]).strip()
            if not name:
                return {"error": "name must not be empty."}, 400
            clash = (
                session.query(Action)
                .filter(Action.name == name, Action.id != action_id)
                .first()
            )
            if clash:
                return {"error": f"Action name {name!r} is already in use."}, 400
            action.name = name

        if "code" in body:
            code = str(body["code"]).strip()
            if not code:
                return {"error": "code must not be empty."}, 400
            clash = (
                session.query(Action)
                .filter(Action.code == code, Action.id != action_id)
                .first()
            )
            if clash:
                return {"error": f"Action code {code!r} is already in use."}, 400
            action.code = code

        if "is_project_scoped" in body:
            action.is_project_scoped = bool(body["is_project_scoped"])

        session.commit()
        return {
            "status": "ok",
            "action": {
                "id": action.id,
                "name": action.name,
                "code": action.code,
                "is_project_scoped": action.is_project_scoped,
            },
        }, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_action(action_id: int) -> tuple[dict[str, Any], int]:
    """Delete an action (cascades its routing rules)."""
    session = _get_session()
    try:
        action = session.get(Action, action_id)
        if action is None:
            return {"error": f"Action {action_id} not found."}, 404
        session.delete(action)  # cascades to routing rules
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Org-unit CRUD
# ---------------------------------------------------------------------------

def api_create_org_unit(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Create a new org unit / team."""
    session = _get_session()
    try:
        dept_id = body.get("dept_id")
        name = str(body.get("name", "")).strip()
        code = str(body.get("code", "")).strip()
        if dept_id is None or not name or not code:
            return {"error": "dept_id, name, and code are required."}, 400
        dept_id = int(dept_id)
        if session.get(Department, dept_id) is None:
            return {"error": f"Department {dept_id} not found."}, 400
        duplicate = (
            session.query(OrgUnit)
            .filter(OrgUnit.dept_id == dept_id, OrgUnit.code == code)
            .first()
        )
        if duplicate:
            return {
                "error": f"Org-unit code {code!r} already exists for this department."
            }, 400
        org_unit = OrgUnit(dept_id=dept_id, name=name, code=code)
        session.add(org_unit)
        session.commit()
        session.refresh(org_unit)
        return {
            "status": "ok",
            "org_unit": {
                "id": org_unit.id,
                "dept_id": org_unit.dept_id,
                "name": org_unit.name,
                "code": org_unit.code,
            },
        }, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_update_org_unit(org_unit_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update an org unit's name or code."""
    session = _get_session()
    try:
        org_unit = session.get(OrgUnit, org_unit_id)
        if org_unit is None:
            return {"error": f"OrgUnit {org_unit_id} not found."}, 404

        if "name" in body:
            name = str(body["name"]).strip()
            if not name:
                return {"error": "name must not be empty."}, 400
            org_unit.name = name

        if "code" in body:
            code = str(body["code"]).strip()
            if not code:
                return {"error": "code must not be empty."}, 400
            clash = (
                session.query(OrgUnit)
                .filter(
                    OrgUnit.dept_id == org_unit.dept_id,
                    OrgUnit.code == code,
                    OrgUnit.id != org_unit_id,
                )
                .first()
            )
            if clash:
                return {
                    "error": f"Org-unit code {code!r} already exists for this department."
                }, 400
            org_unit.code = code

        session.commit()
        return {
            "status": "ok",
            "org_unit": {
                "id": org_unit.id,
                "dept_id": org_unit.dept_id,
                "name": org_unit.name,
                "code": org_unit.code,
            },
        }, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_org_unit(org_unit_id: int) -> tuple[dict[str, Any], int]:
    """Delete an org unit if it has no active members."""
    session = _get_session()
    try:
        org_unit = session.get(OrgUnit, org_unit_id)
        if org_unit is None:
            return {"error": f"OrgUnit {org_unit_id} not found."}, 404
        active_members = (
            session.query(OrgUnitMembership)
            .filter(
                OrgUnitMembership.org_unit_id == org_unit_id,
                OrgUnitMembership.is_active.is_(True),
            )
            .count()
        )
        if active_members > 0:
            return {
                "error": f"Cannot delete org unit: {active_members} active member(s) remain."
            }, 400
        session.delete(org_unit)  # cascades inactive memberships
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Routing-rule update
# ---------------------------------------------------------------------------

def api_update_routing_rule(rule_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update requires_primary / requires_second_level for an action routing rule."""
    session = _get_session()
    try:
        rule = session.get(ActionRoutingRule, rule_id)
        if rule is None:
            return {"error": f"ActionRoutingRule {rule_id} not found."}, 404

        if "requires_primary" in body:
            rule.requires_primary = bool(body["requires_primary"])
        if "requires_second_level" in body:
            rule.requires_second_level = bool(body["requires_second_level"])

        session.commit()
        return {
            "status": "ok",
            "routing_rule": {
                "id": rule.id,
                "action_id": rule.action_id,
                "dept_id": rule.dept_id,
                "requires_primary": rule.requires_primary,
                "requires_second_level": rule.requires_second_level,
            },
        }, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Fallback-rule update
# ---------------------------------------------------------------------------

def api_update_fallback_rule(rule_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update the fallback approver for a department."""
    session = _get_session()
    try:
        rule = session.get(DepartmentFallbackRule, rule_id)
        if rule is None:
            return {"error": f"DepartmentFallbackRule {rule_id} not found."}, 404

        if "fallback_user_id" in body:
            uid = int(body["fallback_user_id"])
            user = session.get(User, uid)
            if user is None:
                return {"error": f"User {uid} not found."}, 400
            rule.fallback_user_id = uid

        if "fallback_label" in body:
            rule.fallback_label = str(body["fallback_label"])

        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Diagram node update (combines user + reporting-line in one call)
# ---------------------------------------------------------------------------

def api_update_diagram_node(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Update a user's profile and optionally their primary manager from the diagram."""
    user_id = body.get("user_id")
    if user_id is None:
        return {"error": "user_id is required."}, 400

    user_id = int(user_id)
    errors = []

    # Update user fields
    user_fields = {
        k: body[k]
        for k in ("name", "email", "dept_level_id", "dept_id", "is_team_lead", "org_unit_id", "is_active")
        if k in body
    }
    if user_fields:
        result, status = api_update_user(user_id, user_fields)
        if status not in (200, 201):
            return result, status

    # Update manager if provided
    if "manager_id" in body:
        manager_id = body["manager_id"]
        if manager_id is not None:
            rl_result, rl_status = api_create_reporting_line(
                {"user_id": user_id, "manager_id": int(manager_id)}
            )
            if rl_status not in (200, 201):
                return rl_result, rl_status

    if errors:
        return {"errors": errors}, 400

    session = _get_session()
    try:
        user = session.get(User, user_id)
        if user is None:
            return {"error": f"User {user_id} not found."}, 404
        return {"status": "ok", "user": _serialize_user(user)}, 200
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Scenario Lab: ephemeral overlay simulation
# ---------------------------------------------------------------------------

# Supported overlay types for the Scenario Lab, mapped to their assignment model
# and the field naming conventions used by the routing service.
OVERLAY_SIMULATIONS = {
    "acting": {
        "label": "Acting",
        "owner_label": "Principal (whose authority is acted)",
        "substitute_label": "Acting approver",
    },
    "delegation": {
        "label": "Delegation",
        "owner_label": "Delegator (whose authority is delegated)",
        "substitute_label": "Delegate approver",
    },
    "peer_coverage": {
        "label": "Peer coverage",
        "owner_label": "Covered approver",
        "substitute_label": "Coverage approver",
    },
    "handover": {
        "label": "Handover overlap",
        "owner_label": "Outgoing approver",
        "substitute_label": "Incoming approver",
    },
}

HANDOVER_POLICIES = [
    "old_until_end_date",
    "new_from_start_date",
    "both_required",
    "new_primary_old_observer",
]


def _build_overlay_object(
    overlay: dict[str, Any],
    requester: User,
    session: Session | None = None,
):
    """Construct (but do not commit) an overlay assignment object from a spec."""
    overlay_type = str(overlay.get("type", "")).strip()
    owner_id = overlay.get("owner_id")
    substitute_id = overlay.get("substitute_id")
    if overlay_type not in OVERLAY_SIMULATIONS:
        raise ValueError(f"Unsupported overlay type {overlay_type!r}.")
    if owner_id is None or substitute_id is None:
        raise ValueError("owner_id and substitute_id are required.")

    owner_id = int(owner_id)
    substitute_id = int(substitute_id)

    effective_from = _parse_request_at(overlay.get("effective_from")) or datetime(
        2000, 1, 1
    )
    effective_to = _parse_request_at(overlay.get("effective_to")) or datetime(
        2099, 12, 31
    )

    # An overlay may scope itself to a specific action either by numeric id or,
    # more conveniently for callers that only know action codes (e.g. the Test
    # Case Diagram), by ``action_code`` which is resolved against the session.
    action_id = overlay.get("action_id")
    action_code = overlay.get("action_code")
    if action_id in (None, "") and action_code and session is not None:
        action = (
            session.query(Action).filter(Action.code == str(action_code)).first()
        )
        if action is None:
            raise ValueError(f"Action {action_code!r} not found.")
        action_id = action.id

    scope = {
        "dept_id": overlay.get("dept_id"),
        "org_unit_id": overlay.get("org_unit_id"),
        "action_id": action_id,
    }
    scope = {key: int(value) for key, value in scope.items() if value not in (None, "")}

    if overlay_type == "acting":
        return ActingAssignment(
            principal_user_id=owner_id,
            acting_user_id=substitute_id,
            effective_from=effective_from,
            effective_to=effective_to,
            **scope,
        )
    if overlay_type == "delegation":
        return DelegationAssignment(
            delegator_user_id=owner_id,
            delegate_user_id=substitute_id,
            effective_from=effective_from,
            effective_to=effective_to,
            **scope,
        )
    if overlay_type == "peer_coverage":
        return CoverageAssignment(
            covered_user_id=owner_id,
            coverage_user_id=substitute_id,
            effective_from=effective_from,
            effective_to=effective_to,
            **scope,
        )
    # handover
    policy = str(overlay.get("policy", "both_required")).strip() or "both_required"
    if policy not in HANDOVER_POLICIES:
        raise ValueError(f"Unsupported handover policy {policy!r}.")
    return HandoverOverlap(
        requester_user_id=requester.id,
        old_approver_id=owner_id,
        new_approver_id=substitute_id,
        policy=policy,
        effective_from=effective_from,
        effective_to=effective_to,
        **scope,
    )


def simulate_scenario_overlay(
    requester_id: int,
    action_code: str,
    overlays: list[dict[str, Any]] | None = None,
    request_at: str | None = None,
    project_code: str | None = None,
) -> dict[str, Any]:
    """Simulate an approval chain with ad-hoc overlays applied, without persisting.

    The overlays (acting, delegation, peer_coverage, handover) are inserted into a
    transaction that is rolled back afterwards, so the Scenario Lab never mutates
    the persisted POC state. The result highlights the resolved primary and
    second-level approvers.
    """
    overlays = overlays or []
    session = _get_session()
    try:
        requester = session.get(User, requester_id)
        if requester is None or not requester.is_active:
            return {"status": "error", "error": f"Requester {requester_id} not found or inactive."}

        for overlay in overlays:
            try:
                overlay_obj = _build_overlay_object(overlay, requester, session)
            except ValueError as exc:
                return {"status": "error", "error": str(exc)}
            session.add(overlay_obj)
        session.flush()

        parsed_request_at = _parse_request_at(request_at)
        chain = build_approval_chain(
            session,
            requester_id,
            action_code,
            request_at=parsed_request_at,
            project_code=project_code,
        )
        response = approval_chain_to_dict(chain)
        steps = response.get("steps", [])
        response.update(
            {
                "status": "success",
                "request_at": request_at,
                "project_code": project_code,
                "primary_approver": steps[0]["approver"] if len(steps) >= 1 else None,
                "primary_source": steps[0]["source"] if len(steps) >= 1 else None,
                "primary_acting_approver": (
                    steps[0].get("acting_approver") if len(steps) >= 1 else None
                ),
                "second_level_approver": steps[1]["approver"] if len(steps) >= 2 else None,
                "second_level_source": steps[1]["source"] if len(steps) >= 2 else None,
                "second_level_acting_approver": (
                    steps[1].get("acting_approver") if len(steps) >= 2 else None
                ),
            }
        )
        return response
    except RoutingError as exc:
        return {"status": "error", "error": str(exc)}
    except Exception as exc:  # pragma: no cover - defensive
        return {"status": "error", "error": str(exc)}
    finally:
        # Never persist Scenario Lab overlays or the simulated approval request.
        session.rollback()
        session.close()


# ---------------------------------------------------------------------------
# Test Case Diagram: ephemeral reporting-line simulation
# ---------------------------------------------------------------------------

def _user_line_label(user: User) -> str:
    """Human-readable label for a user used in reporting-line wording."""
    top = ", top level" if user.dept_level.is_top_level else ""
    return (
        f"{user.name} ({user.department.code} "
        f"{user.dept_level.level_name}, L{user.dept_level.level_rank}{top})"
    )


def _apply_reporting_line_edges(session: Session, edges: list[dict[str, Any]]) -> None:
    """Apply temporary primary reporting-line edits inside the open transaction.

    Each edge is ``{"user_id": int, "manager_id": int | None}``. The existing
    active primary line for the user is deactivated, and when a manager is given
    a fresh active primary line is added. Nothing is committed by this helper.
    """
    for edge in edges or []:
        user_id = edge.get("user_id")
        if user_id is None:
            raise ValueError("Each edge requires a user_id.")
        user_id = int(user_id)
        user = session.get(User, user_id)
        if user is None:
            raise ValueError(f"User {user_id} not found.")

        existing_lines = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id == user_id,
                ReportingLine.is_primary.is_(True),
                ReportingLine.is_active.is_(True),
            )
            .all()
        )
        for line in existing_lines:
            line.is_active = False

        manager_id = edge.get("manager_id")
        if manager_id in (None, ""):
            continue
        manager_id = int(manager_id)
        if manager_id == user_id:
            raise ValueError(f"{user.name} cannot report to themselves.")
        manager = session.get(User, manager_id)
        if manager is None:
            raise ValueError(f"Manager {manager_id} not found.")
        session.add(
            ReportingLine(
                user_id=user_id,
                manager_id=manager_id,
                dept_id=user.dept_id,
                is_primary=True,
            )
        )


def simulate_reporting_line(
    requester_id: int,
    edges: list[dict[str, Any]] | None = None,
    overlays: list[dict[str, Any]] | None = None,
    action_code: str | None = None,
    request_at: str | None = None,
    project_code: str | None = None,
) -> dict[str, Any]:
    """Resolve a requester's reporting line for a temporarily edited diagram.

    The ``edges`` describe the diagram the user built on the Test Case Diagram
    tab as primary manager assignments. They are applied inside a transaction
    that is always rolled back, so editing the test-case diagram never mutates
    the persisted POC state. The reporting line is walked from the requester up
    to the top and returned both as structured steps and as plain wording.

    When ``action_code`` is supplied, the same rolled-back transaction also runs
    the full routing engine so the user can see how overlays change the resolved
    approver line. ``overlays`` are ad-hoc acting/delegation/peer_coverage/handover
    assignments (built with :func:`_build_overlay_object`); ``project_code`` drives
    cross-department project routing; co-head and self-approval-blocked behaviour
    emerge automatically from the routing engine for the chosen action. The
    overlay-resolved chain is returned as ``overlay_steps`` with per-step ``source``
    labels plus plain-language ``overlay_wording``.
    """
    edges = edges or []
    overlays = overlays or []
    session = _get_session()
    try:
        requester = session.get(User, requester_id)
        if requester is None:
            return {"status": "error", "error": f"Requester {requester_id} not found."}

        try:
            _apply_reporting_line_edges(session, edges)
        except ValueError as exc:
            return {"status": "error", "error": str(exc)}
        session.flush()

        # Walk the primary reporting line from the requester to the top, guarding
        # against cycles introduced by the temporary edits.
        steps: list[dict[str, Any]] = []
        visited: set[int] = set()
        current = requester
        cycle = False
        while True:
            if current.id in visited:
                cycle = True
                break
            visited.add(current.id)
            line = (
                session.query(ReportingLine)
                .filter(
                    ReportingLine.user_id == current.id,
                    ReportingLine.is_primary.is_(True),
                    ReportingLine.is_active.is_(True),
                )
                .first()
            )
            if line is None:
                break
            manager = session.get(User, line.manager_id)
            if manager is None:
                break
            steps.append(
                {
                    "user": current.name,
                    "user_id": current.id,
                    "manager": manager.name,
                    "manager_id": manager.id,
                    "manager_label": _user_line_label(manager),
                    "manager_is_active": manager.is_active,
                    "manager_is_top_level": manager.dept_level.is_top_level,
                }
            )
            current = manager

        if cycle:
            return {
                "status": "error",
                "error": (
                    "Circular reporting line detected: the edited diagram forms a "
                    "loop, so the reporting line cannot be resolved."
                ),
            }

        top_user = current
        wording = _reporting_line_wording(requester, steps, top_user)
        response: dict[str, Any] = {
            "status": "success",
            "requester": requester.name,
            "requester_id": requester.id,
            "requester_label": _user_line_label(requester),
            "steps": steps,
            "top_of_line": top_user.name,
            "top_of_line_label": _user_line_label(top_user),
            "wording": wording,
        }

        # Optionally resolve the overlay-aware approval line through the routing
        # engine, inside this same rolled-back transaction so nothing persists.
        if action_code:
            response.update(
                _resolve_overlay_chain(
                    session,
                    requester,
                    overlays,
                    action_code,
                    request_at,
                    project_code,
                )
            )
        return response
    except Exception as exc:  # pragma: no cover - defensive
        return {"status": "error", "error": str(exc)}
    finally:
        # Never persist test-case diagram edits.
        session.rollback()
        session.close()


def _overlay_applies_to_action(overlay: dict[str, Any], action: Action) -> bool:
    """Return True if ``overlay`` can affect routing for ``action``.

    An overlay may be scoped to a specific action by ``action_code`` or numeric
    ``action_id``. The routing engine only applies an action-scoped overlay to
    its own action, so an overlay scoped to a *different* action is irrelevant to
    this simulation and is skipped (avoiding a needless, possibly failing, action
    lookup when building it). Overlays with no action scope apply to every action.
    """
    code = overlay.get("action_code")
    if code not in (None, ""):
        return str(code) == action.code
    action_id = overlay.get("action_id")
    if action_id not in (None, ""):
        try:
            return int(action_id) == action.id
        except (TypeError, ValueError):
            return False
    return True


def _resolve_overlay_chain(
    session: Session,
    requester: User,
    overlays: list[dict[str, Any]],
    action_code: str,
    request_at: str | None,
    project_code: str | None,
) -> dict[str, Any]:
    """Resolve the overlay-affected approval line for the Test Case Diagram.

    Builds the requested overlay objects in the open (rolled-back) transaction,
    runs :func:`build_approval_chain`, and returns the resolved approver steps
    with per-step ``source`` labels plus plain-language wording. Any failure is
    returned as ``overlay_error`` so the base reporting line still displays.

    Only overlays relevant to the simulated action are built. The routing engine
    filters overlays by action scope (an overlay scoped to action A never affects
    action B's routing), so action-scoped overlays for a *different* action are
    skipped here. This keeps action-decoupled cases such as Case #3 (Partial
    Acting, where leave and performance-review covers are separate overlays) from
    aborting the leave approver line just because a performance-review-scoped
    overlay is in the payload.
    """
    action = session.query(Action).filter(Action.code == action_code).first()
    if action is None:
        return {"action_code": action_code, "overlay_error": f"Action {action_code!r} not found."}

    try:
        for overlay in overlays:
            if not _overlay_applies_to_action(overlay, action):
                continue
            session.add(_build_overlay_object(overlay, requester, session))
        session.flush()

        chain = build_approval_chain(
            session,
            requester.id,
            action_code,
            request_at=_parse_request_at(request_at),
            project_code=project_code or None,
        )
    except (ValueError, RoutingError) as exc:
        return {
            "action_code": action_code,
            "action_name": action.name,
            "overlay_error": str(exc),
        }

    chain_dict = approval_chain_to_dict(chain)
    overlay_steps = chain_dict.get("steps", [])
    return {
        "action_code": action_code,
        "action_name": action.name,
        "overlay_steps": overlay_steps,
        "overlay_wording": _overlay_chain_wording(requester, action, overlay_steps),
    }


def _overlay_chain_wording(
    requester: User,
    action: Action,
    steps: list[dict[str, Any]],
) -> str:
    """Compose a plain-language description of an overlay-resolved approval line."""
    if not steps:
        return (
            f"{requester.name} has no approver for {action.name}; the request would "
            f"have no one to approve it."
        )

    first = steps[0]
    if first.get("acting_approver"):
        opening = (
            f"For {action.name}, {requester.name}'s request is approved by "
            f"{first['approver']} (via {first['source']}), with "
            f"{first['acting_approver']} acting on their behalf."
        )
    else:
        opening = (
            f"For {action.name}, {requester.name}'s request is approved by "
            f"{first['approver']} (via {first['source']})."
        )
    sentences = [opening]
    for step in steps[1:]:
        if step.get("acting_approver"):
            sentences.append(
                f"It then escalates to {step['approver']} (via {step['source']}), "
                f"with {step['acting_approver']} acting on their behalf."
            )
        else:
            sentences.append(
                f"It then escalates to {step['approver']} (via {step['source']})."
            )
    for step in steps:
        if step.get("alternate_approvers"):
            alternates = ", ".join(step["alternate_approvers"])
            sentences.append(
                f"{step['approver']} may alternatively be covered by {alternates}."
            )
    return " ".join(sentences)


def _reporting_line_wording(
    requester: User,
    steps: list[dict[str, Any]],
    top_user: User,
) -> str:
    """Compose a plain-language description of a resolved reporting line."""
    if not steps:
        return (
            f"{_user_line_label(requester)} is at the top of this reporting line "
            f"and has no manager."
        )

    sentences = []
    sentences.append(f"{_user_line_label(requester)} reports to {steps[0]['manager_label']}.")
    for step in steps[1:]:
        sentences.append(f"{step['user']} in turn reports to {step['manager_label']}.")
    sentences.append(
        f"{_user_line_label(top_user)} is at the top of this reporting line."
    )
    return " ".join(sentences)


# ---------------------------------------------------------------------------
# Audit log helper
# ---------------------------------------------------------------------------

def add_audit_log(
    session: Session,
    *,
    actor: str = "system",
    action: str,
    entity_type: str,
    entity_id: int | None = None,
    entity_name: str | None = None,
    before_value: str | None = None,
    after_value: str | None = None,
    source_page: str | None = None,
    result: str = "success",
) -> None:
    """Add an audit log entry."""
    session.add(
        AuditLog(
            actor=actor,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_name=entity_name,
            before_value=before_value,
            after_value=after_value,
            source_page=source_page,
            result=result,
            details=None,
        )
    )
    session.flush()


# ---------------------------------------------------------------------------
# Dashboard stats
# ---------------------------------------------------------------------------

def api_dashboard_stats() -> dict[str, Any]:
    """Return summary statistics for the dashboard."""
    session = _get_session()
    try:
        dept_count = session.query(Department).count()
        employee_count = session.query(User).count()
        active_count = session.query(User).filter(User.is_active.is_(True)).count()
        inactive_count = employee_count - active_count

        from datetime import timezone as _tz
        now = datetime.now(_tz.utc)

        acting_count = (
            session.query(ActingAssignment)
            .filter(
                ActingAssignment.is_active.is_(True),
                ActingAssignment.effective_from <= now,
                ActingAssignment.effective_to >= now,
            )
            .count()
        )
        coverage_count = (
            session.query(CoverageAssignment)
            .filter(
                CoverageAssignment.is_active.is_(True),
                CoverageAssignment.effective_from <= now,
                CoverageAssignment.effective_to >= now,
            )
            .count()
        )
        delegation_count = (
            session.query(DelegationAssignment)
            .filter(
                DelegationAssignment.is_active.is_(True),
                DelegationAssignment.effective_from <= now,
                DelegationAssignment.effective_to >= now,
            )
            .count()
        )
        handover_count = (
            session.query(HandoverOverlap)
            .filter(
                HandoverOverlap.is_active.is_(True),
                HandoverOverlap.effective_from <= now,
                HandoverOverlap.effective_to >= now,
            )
            .count()
        )
        active_overlays = acting_count + coverage_count + delegation_count + handover_count

        action_count = session.query(Action).count()

        # Validation issues
        issues = _compute_validation_issues(session)
        validation_count = len(issues)

        # Recent changes from audit log
        recent_logs = (
            session.query(AuditLog)
            .order_by(AuditLog.created_at.desc())
            .limit(5)
            .all()
        )
        recent_changes = [
            {
                "timestamp": log.created_at.isoformat(),
                "actor": log.actor or "system",
                "action": log.action,
                "entity_type": log.entity_type,
                "entity_name": log.entity_name or f"id:{log.entity_id}",
            }
            for log in recent_logs
        ]

        return {
            "departments": dept_count,
            "employees": employee_count,
            "active_employees": active_count,
            "inactive_employees": inactive_count,
            "active_overlays": active_overlays,
            "overlay_breakdown": {
                "acting": acting_count,
                "coverage": coverage_count,
                "delegation": delegation_count,
                "handover": handover_count,
            },
            "actions": action_count,
            "validation_issues": validation_count,
            "recent_changes": recent_changes,
        }
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Approval templates CRUD
# ---------------------------------------------------------------------------

def api_list_approval_templates() -> dict[str, Any]:
    session = _get_session()
    try:
        templates = session.query(ApprovalRouteTemplate).order_by(ApprovalRouteTemplate.id).all()
        return {
            "templates": [
                {
                    "id": t.id,
                    "name": t.name,
                    "code": t.code,
                    "description": t.description,
                    "num_levels": t.num_levels,
                    "routing_type": t.routing_type,
                    "allow_overlay": t.allow_overlay,
                    "self_approval_handling": t.self_approval_handling,
                    "is_active": t.is_active,
                }
                for t in templates
            ]
        }
    finally:
        session.close()


def api_create_approval_template(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        name = str(body.get("name", "")).strip()
        code = str(body.get("code", "")).strip()
        if not name or not code:
            return {"error": "name and code are required."}, 400
        if session.query(ApprovalRouteTemplate).filter(ApprovalRouteTemplate.code == code).first():
            return {"error": f"Template code {code!r} already in use."}, 400
        tpl = ApprovalRouteTemplate(
            name=name,
            code=code,
            description=body.get("description"),
            num_levels=int(body.get("num_levels", 1)),
            routing_type=str(body.get("routing_type", "standard")),
            allow_overlay=bool(body.get("allow_overlay", True)),
            self_approval_handling=str(body.get("self_approval_handling", "escalate")),
            is_active=bool(body.get("is_active", True)),
        )
        session.add(tpl)
        session.commit()
        session.refresh(tpl)
        return {"status": "ok", "template": {"id": tpl.id, "name": tpl.name, "code": tpl.code}}, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_update_approval_template(tpl_id: int, body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        tpl = session.get(ApprovalRouteTemplate, tpl_id)
        if tpl is None:
            return {"error": f"Template {tpl_id} not found."}, 404
        for field in ("name", "description", "routing_type", "self_approval_handling"):
            if field in body:
                setattr(tpl, field, str(body[field]))
        if "code" in body:
            code = str(body["code"]).strip()
            clash = (
                session.query(ApprovalRouteTemplate)
                .filter(ApprovalRouteTemplate.code == code, ApprovalRouteTemplate.id != tpl_id)
                .first()
            )
            if clash:
                return {"error": f"Template code {code!r} already in use."}, 400
            tpl.code = code
        if "num_levels" in body:
            tpl.num_levels = int(body["num_levels"])
        if "allow_overlay" in body:
            tpl.allow_overlay = bool(body["allow_overlay"])
        if "is_active" in body:
            tpl.is_active = bool(body["is_active"])
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_approval_template(tpl_id: int) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        tpl = session.get(ApprovalRouteTemplate, tpl_id)
        if tpl is None:
            return {"error": f"Template {tpl_id} not found."}, 404
        session.delete(tpl)
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Overlays unified API
# ---------------------------------------------------------------------------

def _serialize_overlay(obj: Any, overlay_type: str) -> dict[str, Any]:
    """Serialize any overlay assignment object to a dict."""
    result: dict[str, Any] = {
        "id": obj.id,
        "overlay_type": overlay_type,
        "effective_from": obj.effective_from.isoformat() if obj.effective_from else None,
        "effective_to": obj.effective_to.isoformat() if obj.effective_to else None,
        "is_active": obj.is_active,
        "dept_id": obj.dept_id,
        "dept_name": obj.department.name if obj.department else None,
        "org_unit_id": obj.org_unit_id,
        "action_id": obj.action_id,
    }
    if overlay_type == "acting":
        result.update({
            "from_user_id": obj.principal_user_id,
            "from_user_name": obj.principal_user.name if obj.principal_user else None,
            "to_user_id": obj.acting_user_id,
            "to_user_name": obj.acting_user.name if obj.acting_user else None,
        })
    elif overlay_type == "coverage":
        result.update({
            "from_user_id": obj.covered_user_id,
            "from_user_name": obj.covered_user.name if obj.covered_user else None,
            "to_user_id": obj.coverage_user_id,
            "to_user_name": obj.coverage_user.name if obj.coverage_user else None,
        })
    elif overlay_type == "delegation":
        result.update({
            "from_user_id": obj.delegator_user_id,
            "from_user_name": obj.delegator_user.name if obj.delegator_user else None,
            "to_user_id": obj.delegate_user_id,
            "to_user_name": obj.delegate_user.name if obj.delegate_user else None,
        })
    elif overlay_type == "handover":
        result.update({
            "from_user_id": obj.old_approver_id,
            "from_user_name": obj.old_approver.name if obj.old_approver else None,
            "to_user_id": obj.new_approver_id,
            "to_user_name": obj.new_approver.name if obj.new_approver else None,
            "policy": obj.policy,
        })
    return result


def api_list_overlays() -> dict[str, Any]:
    session = _get_session()
    try:
        acting = session.query(ActingAssignment).all()
        coverage = session.query(CoverageAssignment).all()
        delegation = session.query(DelegationAssignment).all()
        handover = session.query(HandoverOverlap).all()
        overlays = (
            [_serialize_overlay(o, "acting") for o in acting]
            + [_serialize_overlay(o, "coverage") for o in coverage]
            + [_serialize_overlay(o, "delegation") for o in delegation]
            + [_serialize_overlay(o, "handover") for o in handover]
        )
        return {"overlays": overlays}
    finally:
        session.close()


def api_create_overlay(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        overlay_type = str(body.get("overlay_type", "")).strip()
        from_user_id = body.get("from_user_id")
        to_user_id = body.get("to_user_id")
        if not overlay_type or from_user_id is None or to_user_id is None:
            return {"error": "overlay_type, from_user_id, to_user_id are required."}, 400

        eff_from = _parse_request_at(body.get("effective_from")) or datetime(2000, 1, 1)
        eff_to = _parse_request_at(body.get("effective_to")) or datetime(2099, 12, 31)
        scope = {
            k: int(body[k])
            for k in ("dept_id", "org_unit_id", "action_id")
            if body.get(k) not in (None, "")
        }
        is_active = bool(body.get("status", "active") == "active")

        if overlay_type == "acting":
            obj = ActingAssignment(
                principal_user_id=int(from_user_id),
                acting_user_id=int(to_user_id),
                effective_from=eff_from,
                effective_to=eff_to,
                is_active=is_active,
                **scope,
            )
        elif overlay_type == "coverage":
            obj = CoverageAssignment(
                covered_user_id=int(from_user_id),
                coverage_user_id=int(to_user_id),
                effective_from=eff_from,
                effective_to=eff_to,
                is_active=is_active,
                **scope,
            )
        elif overlay_type == "delegation":
            obj = DelegationAssignment(
                delegator_user_id=int(from_user_id),
                delegate_user_id=int(to_user_id),
                effective_from=eff_from,
                effective_to=eff_to,
                is_active=is_active,
                **scope,
            )
        elif overlay_type == "handover":
            policy = str(body.get("policy", "both_required"))
            obj = HandoverOverlap(
                requester_user_id=int(from_user_id),
                old_approver_id=int(from_user_id),
                new_approver_id=int(to_user_id),
                policy=policy,
                effective_from=eff_from,
                effective_to=eff_to,
                is_active=is_active,
                **scope,
            )
        else:
            return {"error": f"Unknown overlay_type {overlay_type!r}."}, 400

        session.add(obj)
        session.commit()
        session.refresh(obj)
        return {"status": "ok", "overlay": _serialize_overlay(obj, overlay_type)}, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


def api_delete_overlay(overlay_type: str, overlay_id: int) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        model_map = {
            "acting": ActingAssignment,
            "coverage": CoverageAssignment,
            "delegation": DelegationAssignment,
            "handover": HandoverOverlap,
        }
        model = model_map.get(overlay_type)
        if model is None:
            return {"error": f"Unknown overlay type {overlay_type!r}."}, 400
        obj = session.get(model, overlay_id)
        if obj is None:
            return {"error": f"Overlay {overlay_type}/{overlay_id} not found."}, 404
        session.delete(obj)
        session.commit()
        return {"status": "ok"}, 200
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Audit log API
# ---------------------------------------------------------------------------

def api_list_audit_logs(entity_type: str | None = None, limit: int = 50) -> dict[str, Any]:
    session = _get_session()
    try:
        q = session.query(AuditLog).order_by(AuditLog.created_at.desc())
        if entity_type:
            q = q.filter(AuditLog.entity_type == entity_type)
        logs = q.limit(limit).all()
        return {
            "logs": [
                {
                    "id": log.id,
                    "timestamp": log.created_at.isoformat(),
                    "actor": log.actor or "system",
                    "action": log.action,
                    "entity_type": log.entity_type,
                    "entity_id": log.entity_id,
                    "entity_name": log.entity_name,
                    "before_value": log.before_value,
                    "after_value": log.after_value,
                    "source_page": log.source_page,
                    "result": log.result,
                    "details": log.details,
                }
                for log in logs
            ]
        }
    finally:
        session.close()


def api_create_audit_log(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        actor = str(body.get("actor", "system"))
        action = str(body.get("action", "")).strip()
        entity_type = str(body.get("entity_type", "")).strip()
        if not action or not entity_type:
            return {"error": "action and entity_type are required."}, 400
        log = AuditLog(
            actor=actor,
            action=action,
            entity_type=entity_type,
            entity_id=body.get("entity_id"),
            entity_name=body.get("entity_name"),
            before_value=body.get("before_value"),
            after_value=body.get("after_value"),
            source_page=body.get("source_page"),
            result=str(body.get("result", "success")),
            details=body.get("details"),
        )
        session.add(log)
        session.commit()
        return {"status": "ok", "id": log.id}, 201
    except Exception as exc:
        session.rollback()
        return {"error": str(exc)}, 500
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Validation issues
# ---------------------------------------------------------------------------

def _compute_validation_issues(session: Session) -> list[dict[str, Any]]:
    """Compute validation issues across the data model."""
    issues: list[dict[str, Any]] = []
    from datetime import timezone as _tz
    now = datetime.now(_tz.utc)

    # Missing manager: active users with no active primary reporting line
    all_users = session.query(User).filter(User.is_active.is_(True)).all()
    for user in all_users:
        active_primary = [
            l for l in user.reporting_lines
            if l.is_active and l.is_primary
        ]
        if not active_primary and not user.dept_level.is_top_level:
            issues.append({
                "issue_type": "missing_manager",
                "severity": "error",
                "user_id": user.id,
                "user_name": user.name,
                "description": f"{user.name} has no active primary reporting line.",
            })

    # Circular reporting: detect cycles
    def _has_cycle(start_id: int) -> bool:
        visited: set[int] = set()
        current = start_id
        while current is not None:
            if current in visited:
                return True
            visited.add(current)
            line = (
                session.query(ReportingLine)
                .filter(
                    ReportingLine.user_id == current,
                    ReportingLine.is_primary.is_(True),
                    ReportingLine.is_active.is_(True),
                )
                .first()
            )
            if line is None:
                return False
            current = line.manager_id
        return False

    for user in all_users:
        if _has_cycle(user.id):
            issues.append({
                "issue_type": "circular_reporting",
                "severity": "error",
                "user_id": user.id,
                "user_name": user.name,
                "description": f"{user.name} is in a circular reporting chain.",
            })

    # Inactive approver: acting/delegation/coverage that points to inactive user
    for aa in session.query(ActingAssignment).filter(ActingAssignment.is_active.is_(True)).all():
        acting_user = session.get(User, aa.acting_user_id)
        if acting_user and not acting_user.is_active:
            principal = session.get(User, aa.principal_user_id)
            issues.append({
                "issue_type": "inactive_approver",
                "severity": "warning",
                "user_id": aa.acting_user_id,
                "user_name": acting_user.name,
                "description": f"Acting overlay: {acting_user.name} is inactive but covers {principal.name if principal else 'unknown'}.",
            })

    # Duplicate primary manager: users with more than one active primary line
    from sqlalchemy import func
    dup_query = (
        session.query(ReportingLine.user_id, func.count(ReportingLine.id).label("cnt"))
        .filter(ReportingLine.is_primary.is_(True), ReportingLine.is_active.is_(True))
        .group_by(ReportingLine.user_id)
        .having(func.count(ReportingLine.id) > 1)
        .all()
    )
    for (uid, cnt) in dup_query:
        user = session.get(User, uid)
        if user:
            issues.append({
                "issue_type": "duplicate_primary_manager",
                "severity": "error",
                "user_id": uid,
                "user_name": user.name,
                "description": f"{user.name} has {cnt} active primary reporting lines.",
            })

    # Expired overlay: overlays past effective_to still marked active
    for aa in session.query(ActingAssignment).filter(
        ActingAssignment.is_active.is_(True),
        ActingAssignment.effective_to < now,
    ).all():
        issues.append({
            "issue_type": "expired_overlay",
            "severity": "info",
            "user_id": aa.acting_user_id,
            "user_name": session.get(User, aa.acting_user_id).name if session.get(User, aa.acting_user_id) else "?",
            "description": f"Acting overlay (id={aa.id}) expired on {aa.effective_to.date()} but is still active.",
        })

    return issues


def api_validation_issues() -> dict[str, Any]:
    session = _get_session()
    try:
        issues = _compute_validation_issues(session)
        return {"issues": issues, "count": len(issues)}
    finally:
        session.close()


# ---------------------------------------------------------------------------
# GET /api/users/{id}
# ---------------------------------------------------------------------------

def api_get_user(user_id: int) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        user = session.get(User, user_id)
        if user is None:
            return {"error": f"User {user_id} not found."}, 404
        data = _serialize_user(user)
        # Add reporting path
        path = []
        current_id = user_id
        visited: set[int] = set()
        while current_id is not None:
            if current_id in visited:
                break
            visited.add(current_id)
            line = (
                session.query(ReportingLine)
                .filter(
                    ReportingLine.user_id == current_id,
                    ReportingLine.is_primary.is_(True),
                    ReportingLine.is_active.is_(True),
                )
                .first()
            )
            if line is None:
                break
            mgr = session.get(User, line.manager_id)
            if mgr:
                path.append({"id": mgr.id, "name": mgr.name})
            current_id = line.manager_id
        data["reporting_path"] = path
        # Direct reports
        direct_reports = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.manager_id == user_id,
                ReportingLine.is_primary.is_(True),
                ReportingLine.is_active.is_(True),
            )
            .all()
        )
        data["direct_reports"] = [
            {"id": rl.user_id, "name": rl.user.name if rl.user else "?"}
            for rl in direct_reports
        ]
        return data, 200
    finally:
        session.close()


# ---------------------------------------------------------------------------
# GET /api/departments/{id}/diagram-data
# ---------------------------------------------------------------------------

def api_department_diagram_data(dept_id: int) -> tuple[dict[str, Any], int]:
    session = _get_session()
    try:
        dept = session.get(Department, dept_id)
        if dept is None:
            return {"error": f"Department {dept_id} not found."}, 404

        levels = (
            session.query(DeptLevel)
            .filter(DeptLevel.dept_id == dept_id)
            .order_by(DeptLevel.level_rank)
            .all()
        )
        org_units = (
            session.query(OrgUnit).filter(OrgUnit.dept_id == dept_id).all()
        )
        users = (
            session.query(User).filter(User.dept_id == dept_id).all()
        )

        # All reporting lines for users in this dept
        user_ids = [u.id for u in users]
        reporting_lines = (
            session.query(ReportingLine)
            .filter(
                ReportingLine.user_id.in_(user_ids),
                ReportingLine.is_active.is_(True),
            )
            .all()
        )

        from datetime import timezone as _tz
        now = datetime.now(_tz.utc)

        acting = (
            session.query(ActingAssignment)
            .filter(ActingAssignment.dept_id == dept_id)
            .all()
        )
        coverage = (
            session.query(CoverageAssignment)
            .filter(CoverageAssignment.dept_id == dept_id)
            .all()
        )
        delegation = (
            session.query(DelegationAssignment)
            .filter(DelegationAssignment.dept_id == dept_id)
            .all()
        )
        handover = (
            session.query(HandoverOverlap)
            .filter(HandoverOverlap.dept_id == dept_id)
            .all()
        )

        return {
            "department": {"id": dept.id, "name": dept.name, "code": dept.code},
            "levels": [
                {
                    "id": lv.id,
                    "level_rank": lv.level_rank,
                    "level_name": lv.level_name,
                    "is_top_level": lv.is_top_level,
                }
                for lv in levels
            ],
            "org_units": [
                {"id": ou.id, "name": ou.name, "code": ou.code}
                for ou in org_units
            ],
            "users": [_serialize_user(u) for u in users],
            "reporting_lines": [
                {
                    "id": rl.id,
                    "user_id": rl.user_id,
                    "manager_id": rl.manager_id,
                    "is_primary": rl.is_primary,
                    "is_active": rl.is_active,
                }
                for rl in reporting_lines
            ],
            "overlays": {
                "acting": [_serialize_overlay(o, "acting") for o in acting],
                "coverage": [_serialize_overlay(o, "coverage") for o in coverage],
                "delegation": [_serialize_overlay(o, "delegation") for o in delegation],
                "handover": [_serialize_overlay(o, "handover") for o in handover],
            },
        }, 200
    finally:
        session.close()


# ---------------------------------------------------------------------------
# POST /api/scenario-builder
# ---------------------------------------------------------------------------

def api_scenario_builder(body: dict[str, Any]) -> dict[str, Any]:
    """Run a custom scenario and return approval chain + explanation."""
    requester_id = body.get("requester_id")
    dept_id = body.get("dept_id")
    action_code = body.get("action_code", "annual_leave")
    request_date = body.get("request_date")
    overlay_enabled = bool(body.get("overlay_enabled", False))
    scenario_name = str(body.get("scenario_name", "Custom Scenario"))

    if requester_id is None:
        return {"status": "error", "error": "requester_id is required."}

    result = simulate_action_request(
        requester_id=int(requester_id),
        action_code=str(action_code),
        request_at=request_date,
    )

    if result.get("status") == "error":
        return result

    steps = result.get("steps", [])
    explanation_parts = [f"Scenario: {scenario_name}."]
    if steps:
        approvers = [s["approver"] for s in steps]
        explanation_parts.append(f"Approval chain: {' → '.join(approvers)}.")
        fallback_steps = [s for s in steps if s.get("is_fallback")]
        if fallback_steps:
            explanation_parts.append(
                f"Fallback used: {fallback_steps[0]['approver']}."
            )
    else:
        explanation_parts.append("No approvers found.")

    overlay_steps = [s for s in steps if s.get("source") not in ("official", "fallback")]

    result["scenario_name"] = scenario_name
    result["fallback_used"] = any(s.get("is_fallback") for s in steps)
    result["overlays_applied"] = [s["source"] for s in overlay_steps]
    result["explanation"] = " ".join(explanation_parts)
    result["validation_result"] = "pass" if steps else "fail"
    return result


# ---------------------------------------------------------------------------
# GET /api/actions (enhanced with template info)
# ---------------------------------------------------------------------------

def api_list_actions() -> dict[str, Any]:
    session = _get_session()
    try:
        actions = session.query(Action).order_by(Action.name).all()
        routing_rules = session.query(ActionRoutingRule).all()
        rules_by_action: dict[int, list[dict[str, Any]]] = {}
        for rr in routing_rules:
            rules_by_action.setdefault(rr.action_id, []).append({
                "id": rr.id,
                "dept_id": rr.dept_id,
                "dept_name": rr.department.name if rr.department else None,
                "requires_primary": rr.requires_primary,
                "requires_second_level": rr.requires_second_level,
            })
        return {
            "actions": [
                {
                    "id": a.id,
                    "name": a.name,
                    "code": a.code,
                    "is_project_scoped": a.is_project_scoped,
                    "routing_rules": rules_by_action.get(a.id, []),
                }
                for a in actions
            ]
        }
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
            self._send_json(build_bootstrap_payload())
        elif path == "/api/org-chart":
            department_code = query.get("department", ["FIN"])[0]
            try:
                session = _get_session()
                try:
                    self._send_json(get_department_org_chart(session, department_code))
                finally:
                    session.close()
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=404)
        elif path == "/api/seed-data":
            self._send_json(get_seed_data())
        elif path == "/api/dashboard-stats":
            self._send_json(api_dashboard_stats())
        elif path == "/api/approval-templates":
            self._send_json(api_list_approval_templates())
        elif path == "/api/overlays":
            self._send_json(api_list_overlays())
        elif path == "/api/audit-logs":
            entity_type = query.get("entity_type", [None])[0]
            limit = int(query.get("limit", [50])[0])
            self._send_json(api_list_audit_logs(entity_type=entity_type, limit=limit))
        elif path == "/api/validation-issues":
            self._send_json(api_validation_issues())
        elif path == "/api/actions":
            self._send_json(api_list_actions())
        elif path.startswith("/api/users/"):
            try:
                user_id = int(path.split("/api/users/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid user ID."}, status=400)
                return
            result, status = api_get_user(user_id)
            self._send_json(result, status=status)
        elif path.startswith("/api/departments/") and path.endswith("/diagram-data"):
            try:
                dept_id = int(path.split("/api/departments/")[1].split("/")[0])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid department ID."}, status=400)
                return
            result, status = api_department_diagram_data(dept_id)
            self._send_json(result, status=status)
        else:
            self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/simulate-request":
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

        if path == "/api/simulate-scenario":
            payload = self._read_json_body()
            self._send_json(simulate_advanced_scenario(str(payload["scenario_id"])))
            return

        if path == "/api/team-lead-permission":
            payload = self._read_json_body()
            self._send_json(
                simulate_team_lead_permission(
                    editor_id=int(payload["editor_id"]),
                    target_user_id=int(payload["target_user_id"]),
                )
            )
            return

        if path == "/api/users":
            payload = self._read_json_body()
            result, status = api_create_user(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/reporting-lines":
            payload = self._read_json_body()
            result, status = api_create_reporting_line(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/departments":
            payload = self._read_json_body()
            result, status = api_create_department(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/actions":
            payload = self._read_json_body()
            result, status = api_create_action(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/org-units":
            payload = self._read_json_body()
            result, status = api_create_org_unit(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/dept-levels":
            payload = self._read_json_body()
            result, status = api_create_dept_level(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/simulate-overlay":
            payload = self._read_json_body()
            self._send_json(
                simulate_scenario_overlay(
                    requester_id=int(payload["requester_id"]),
                    action_code=str(payload["action_code"]),
                    overlays=payload.get("overlays"),
                    request_at=payload.get("request_at"),
                    project_code=payload.get("project_code"),
                )
            )
            return

        if path == "/api/simulate-reporting-line":
            payload = self._read_json_body()
            self._send_json(
                simulate_reporting_line(
                    requester_id=int(payload["requester_id"]),
                    edges=payload.get("edges"),
                    overlays=payload.get("overlays"),
                    action_code=payload.get("action_code"),
                    request_at=payload.get("request_at"),
                    project_code=payload.get("project_code"),
                )
            )
            return

        if path == "/api/diagram/update-node":
            payload = self._read_json_body()
            result, status = api_update_diagram_node(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/reset":
            _reset_database()
            self._send_json({"status": "ok", "message": "Database reset to default seed data."})
            return

        if path == "/api/approval-templates":
            payload = self._read_json_body()
            result, status = api_create_approval_template(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/overlays":
            payload = self._read_json_body()
            result, status = api_create_overlay(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/audit-logs":
            payload = self._read_json_body()
            result, status = api_create_audit_log(payload)
            self._send_json(result, status=status)
            return

        if path == "/api/scenario-builder":
            payload = self._read_json_body()
            self._send_json(api_scenario_builder(payload))
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        payload = self._read_json_body()

        # PUT /api/users/{id}
        if path.startswith("/api/users/"):
            try:
                user_id = int(path.split("/api/users/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid user ID."}, status=400)
                return
            result, status = api_update_user(user_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/dept-levels/{id}
        if path.startswith("/api/dept-levels/"):
            try:
                level_id = int(path.split("/api/dept-levels/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid level ID."}, status=400)
                return
            result, status = api_update_dept_level(level_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/departments/{id}
        if path.startswith("/api/departments/"):
            try:
                dept_id = int(path.split("/api/departments/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid department ID."}, status=400)
                return
            result, status = api_update_department(dept_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/actions/{id}
        if path.startswith("/api/actions/"):
            try:
                action_id = int(path.split("/api/actions/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid action ID."}, status=400)
                return
            result, status = api_update_action(action_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/org-units/{id}
        if path.startswith("/api/org-units/"):
            try:
                org_unit_id = int(path.split("/api/org-units/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid org-unit ID."}, status=400)
                return
            result, status = api_update_org_unit(org_unit_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/routing-rules/{id}
        if path.startswith("/api/routing-rules/"):
            try:
                rule_id = int(path.split("/api/routing-rules/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid rule ID."}, status=400)
                return
            result, status = api_update_routing_rule(rule_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/fallback-rules/{id}
        if path.startswith("/api/fallback-rules/"):
            try:
                rule_id = int(path.split("/api/fallback-rules/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid rule ID."}, status=400)
                return
            result, status = api_update_fallback_rule(rule_id, payload)
            self._send_json(result, status=status)
            return

        # PUT /api/approval-templates/{id}
        if path.startswith("/api/approval-templates/"):
            try:
                tpl_id = int(path.split("/api/approval-templates/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid template ID."}, status=400)
                return
            result, status = api_update_approval_template(tpl_id, payload)
            self._send_json(result, status=status)
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        # DELETE /api/reporting-lines/{id}
        if path.startswith("/api/reporting-lines/"):
            try:
                line_id = int(path.split("/api/reporting-lines/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid line ID."}, status=400)
                return
            result, status = api_delete_reporting_line(line_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/users/{id}
        if path.startswith("/api/users/"):
            try:
                user_id = int(path.split("/api/users/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid user ID."}, status=400)
                return
            result, status = api_delete_user(user_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/dept-levels/{id}
        if path.startswith("/api/dept-levels/"):
            try:
                level_id = int(path.split("/api/dept-levels/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid level ID."}, status=400)
                return
            result, status = api_delete_dept_level(level_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/departments/{id}
        if path.startswith("/api/departments/"):
            try:
                dept_id = int(path.split("/api/departments/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid department ID."}, status=400)
                return
            result, status = api_delete_department(dept_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/actions/{id}
        if path.startswith("/api/actions/"):
            try:
                action_id = int(path.split("/api/actions/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid action ID."}, status=400)
                return
            result, status = api_delete_action(action_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/org-units/{id}
        if path.startswith("/api/org-units/"):
            try:
                org_unit_id = int(path.split("/api/org-units/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid org-unit ID."}, status=400)
                return
            result, status = api_delete_org_unit(org_unit_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/approval-templates/{id}
        if path.startswith("/api/approval-templates/"):
            try:
                tpl_id = int(path.split("/api/approval-templates/")[1])
            except (ValueError, IndexError):
                self._send_json({"error": "Invalid template ID."}, status=400)
                return
            result, status = api_delete_approval_template(tpl_id)
            self._send_json(result, status=status)
            return

        # DELETE /api/overlays/{type}/{id}
        if path.startswith("/api/overlays/"):
            parts = path.split("/")
            # /api/overlays/{type}/{id}
            if len(parts) >= 5:
                try:
                    overlay_type = parts[3]
                    overlay_id = int(parts[4])
                except (ValueError, IndexError):
                    self._send_json({"error": "Invalid overlay path."}, status=400)
                    return
                result, status = api_delete_overlay(overlay_type, overlay_id)
                self._send_json(result, status=status)
                return

        self._send_json({"error": "Not found"}, status=404)

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw_body.decode("utf-8"))

    def _send_static(self, filename: str, content_type: str, base_dir: Path = FRONTEND_DIR) -> None:
        file_path = base_dir / filename
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
    _get_engine()  # Initialize DB before accepting requests
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
