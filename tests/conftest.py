"""
pytest fixtures — shared seed data for all test modules.

Hierarchy used in tests
-----------------------
Department: Computer Science (CS)

Levels (rank 1 = highest / protected):
  Level 1 — Head of Department (is_top_level=True)
  Level 2 — Senior Lecturer
  Level 3 — Lecturer

Users:
  dept_head   — rank 1 (Head of Dept)  → no manager in CS
  senior_lect — rank 2                  → reports to dept_head
  staff_a     — rank 3 Lecturer         → reports to senior_lect

HR department (fallback approver source):
  hr_officer  — rank 1 of HR dept, used as fallback approver

Actions:
  annual_leave — requires primary + second level
  sick_leave   — requires primary only

Routing rules (CS dept):
  annual_leave → requires_primary=True, requires_second_level=True
  sick_leave   → requires_primary=True, requires_second_level=False

Fallback rules (CS dept):
  annual_leave → fallback_user = hr_officer, label='HR Officer'
  sick_leave   → fallback_user = hr_officer, label='HR Officer'
"""

import pytest
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


@pytest.fixture()
def db_session() -> Session:
    """Yield a fresh in-memory SQLite session with all tables created."""
    engine = create_engine_sqlite(":memory:")
    init_db(engine)
    session = get_session(engine)
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def seed(db_session: Session):
    """
    Populate the database with a minimal but complete university data set
    sufficient to exercise all 8 test cases.

    Returns a namespace-like dict so tests can reference named objects.
    """
    session = db_session

    # ------------------------------------------------------------------
    # Departments
    # ------------------------------------------------------------------
    cs_dept = Department(name="Computer Science", code="CS")
    hr_dept = Department(name="Human Resources", code="HR")
    session.add_all([cs_dept, hr_dept])
    session.flush()

    # ------------------------------------------------------------------
    # Dept levels — CS
    # ------------------------------------------------------------------
    cs_level1 = DeptLevel(
        dept_id=cs_dept.id, level_rank=1, level_name="Head of Department",
        is_top_level=True,
    )
    cs_level2 = DeptLevel(
        dept_id=cs_dept.id, level_rank=2, level_name="Senior Lecturer",
        is_top_level=False,
    )
    cs_level3 = DeptLevel(
        dept_id=cs_dept.id, level_rank=3, level_name="Lecturer",
        is_top_level=False,
    )
    # HR levels
    hr_level1 = DeptLevel(
        dept_id=hr_dept.id, level_rank=1, level_name="HR Officer",
        is_top_level=True,
    )
    session.add_all([cs_level1, cs_level2, cs_level3, hr_level1])
    session.flush()

    # ------------------------------------------------------------------
    # Users
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # Reporting lines (active)
    # staff_a → senior_lect → dept_head  (dept_head has no manager in CS)
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    annual_leave = Action(name="Annual Leave", code="annual_leave")
    sick_leave = Action(name="Sick Leave", code="sick_leave")
    session.add_all([annual_leave, sick_leave])
    session.flush()

    # ------------------------------------------------------------------
    # Routing rules (CS dept)
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # Fallback rules (CS dept → hr_officer)
    # ------------------------------------------------------------------
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
        "cs_level1": cs_level1,
        "cs_level2": cs_level2,
        "cs_level3": cs_level3,
        "dept_head": dept_head,
        "senior_lect": senior_lect,
        "staff_a": staff_a,
        "hr_officer": hr_officer,
        "annual_leave": annual_leave,
        "sick_leave": sick_leave,
        "rule_al": rule_al,
        "rule_sl": rule_sl,
        "fb_al": fb_al,
        "fb_sl": fb_sl,
        "rl_staff_to_senior": rl_staff_to_senior,
        "rl_senior_to_head": rl_senior_to_head,
    }
