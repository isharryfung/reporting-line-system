"""Shared sample data for the reporting-line POC."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    Department,
    DepartmentFallbackRule,
    DeptLevel,
    OrgUnit,
    OrgUnitMembership,
    ReportingLine,
    User,
)


def seed_sample_data(session: Session) -> dict[str, Any]:
    """Populate the database with Finance + HR sample data for the POC."""
    finance = Department(name="Finance", code="FIN")
    hr = Department(name="Human Resources", code="HR")
    session.add_all([finance, hr])
    session.flush()

    fin_level1 = DeptLevel(
        dept_id=finance.id,
        level_rank=1,
        level_name="Finance Director",
        is_top_level=True,
    )
    fin_level2 = DeptLevel(
        dept_id=finance.id,
        level_rank=2,
        level_name="Senior Manager",
    )
    fin_level3 = DeptLevel(
        dept_id=finance.id,
        level_rank=3,
        level_name="Finance Officer",
    )
    hr_level1 = DeptLevel(
        dept_id=hr.id,
        level_rank=1,
        level_name="HR Director",
        is_top_level=True,
    )
    hr_level2 = DeptLevel(
        dept_id=hr.id,
        level_rank=2,
        level_name="HR Manager",
    )
    hr_level3 = DeptLevel(
        dept_id=hr.id,
        level_rank=3,
        level_name="HR Officer",
    )
    session.add_all(
        [fin_level1, fin_level2, fin_level3, hr_level1, hr_level2, hr_level3]
    )
    session.flush()

    finance_team = OrgUnit(dept_id=finance.id, name="Finance Team", code="FIN-TEAM")
    payroll_team = OrgUnit(dept_id=finance.id, name="Payroll Team", code="PAYROLL")
    hr_advisory = OrgUnit(dept_id=hr.id, name="HR Advisory", code="HR-ADV")
    session.add_all([finance_team, payroll_team, hr_advisory])
    session.flush()

    fiona = User(
        name="Fiona",
        email="fiona@university.edu",
        dept_id=finance.id,
        dept_level_id=fin_level1.id,
    )
    mary = User(
        name="Mary",
        email="mary@university.edu",
        dept_id=finance.id,
        dept_level_id=fin_level2.id,
    )
    nina = User(
        name="Nina",
        email="nina@university.edu",
        dept_id=finance.id,
        dept_level_id=fin_level2.id,
    )
    peter = User(
        name="Peter",
        email="peter@university.edu",
        dept_id=finance.id,
        dept_level_id=fin_level3.id,
    )
    quinn = User(
        name="Quinn",
        email="quinn@university.edu",
        dept_id=finance.id,
        dept_level_id=fin_level3.id,
    )
    henry = User(
        name="Henry",
        email="henry@university.edu",
        dept_id=hr.id,
        dept_level_id=hr_level1.id,
    )
    helen = User(
        name="Helen",
        email="helen@university.edu",
        dept_id=hr.id,
        dept_level_id=hr_level2.id,
    )
    olivia = User(
        name="Olivia",
        email="olivia@university.edu",
        dept_id=hr.id,
        dept_level_id=hr_level3.id,
    )
    session.add_all([fiona, mary, nina, peter, quinn, henry, helen, olivia])
    session.flush()

    session.add_all(
        [
            OrgUnitMembership(
                org_unit_id=finance_team.id,
                user_id=fiona.id,
            ),
            OrgUnitMembership(
                org_unit_id=finance_team.id,
                user_id=mary.id,
                is_team_lead=True,
            ),
            OrgUnitMembership(
                org_unit_id=finance_team.id,
                user_id=nina.id,
            ),
            OrgUnitMembership(
                org_unit_id=finance_team.id,
                user_id=peter.id,
            ),
            OrgUnitMembership(
                org_unit_id=payroll_team.id,
                user_id=quinn.id,
            ),
            OrgUnitMembership(
                org_unit_id=hr_advisory.id,
                user_id=henry.id,
            ),
            OrgUnitMembership(
                org_unit_id=hr_advisory.id,
                user_id=helen.id,
                is_team_lead=True,
            ),
            OrgUnitMembership(
                org_unit_id=hr_advisory.id,
                user_id=olivia.id,
            ),
        ]
    )
    session.flush()

    session.add_all(
        [
            ReportingLine(user_id=mary.id, manager_id=fiona.id, dept_id=finance.id),
            ReportingLine(user_id=nina.id, manager_id=fiona.id, dept_id=finance.id),
            ReportingLine(user_id=peter.id, manager_id=mary.id, dept_id=finance.id),
            ReportingLine(user_id=quinn.id, manager_id=fiona.id, dept_id=finance.id),
            ReportingLine(user_id=helen.id, manager_id=henry.id, dept_id=hr.id),
            ReportingLine(user_id=olivia.id, manager_id=helen.id, dept_id=hr.id),
        ]
    )
    session.flush()

    annual_leave = Action(name="Annual Leave", code="annual_leave")
    sick_leave = Action(name="Sick Leave", code="sick_leave")
    training_request = Action(name="Training Request", code="training_request")
    session.add_all([annual_leave, sick_leave, training_request])
    session.flush()

    session.add_all(
        [
            ActionRoutingRule(
                action_id=annual_leave.id,
                dept_id=finance.id,
                requires_primary=True,
                requires_second_level=True,
            ),
            ActionRoutingRule(
                action_id=sick_leave.id,
                dept_id=finance.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=annual_leave.id,
                dept_id=hr.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=sick_leave.id,
                dept_id=hr.id,
                requires_primary=True,
                requires_second_level=True,
            ),
        ]
    )
    session.flush()

    session.add_all(
        [
            DepartmentFallbackRule(
                dept_id=finance.id,
                fallback_user_id=henry.id,
                fallback_label="HR Director",
            ),
            DepartmentFallbackRule(
                dept_id=hr.id,
                fallback_user_id=fiona.id,
                fallback_label="Finance Director",
            ),
        ]
    )
    session.commit()

    return {
        "finance": finance,
        "hr": hr,
        "finance_team": finance_team,
        "payroll_team": payroll_team,
        "hr_advisory": hr_advisory,
        "fin_level1": fin_level1,
        "fin_level2": fin_level2,
        "fin_level3": fin_level3,
        "hr_level1": hr_level1,
        "hr_level2": hr_level2,
        "hr_level3": hr_level3,
        "fiona": fiona,
        "mary": mary,
        "nina": nina,
        "peter": peter,
        "quinn": quinn,
        "henry": henry,
        "helen": helen,
        "olivia": olivia,
        "annual_leave": annual_leave,
        "sick_leave": sick_leave,
        "training_request": training_request,
    }
