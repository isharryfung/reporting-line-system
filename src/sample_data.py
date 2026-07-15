"""Shared sample data for the reporting-line POC."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from src.models import (
    Action,
    ActionRoutingRule,
    ActingAssignment,
    ApprovalRouteTemplate,
    CoHeadAssignment,
    CoverageAssignment,
    DelegationAssignment,
    Department,
    DepartmentFallbackRule,
    DeptLevel,
    HandoverOverlap,
    OrgUnit,
    OrgUnitMembership,
    Project,
    ProjectAssignment,
    ProjectReportingLine,
    ReportingLine,
    User,
)


def _dt(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=timezone.utc)


def _build_team(
    session: Session,
    *,
    dept: Department,
    team: OrgUnit,
    level_by_rank: dict[int, DeptLevel],
    composition: list[tuple[int, int]],
    names: "Any",
    head: User,
) -> list[User]:
    """Create users for a single team and wire their reporting lines.

    ``composition`` is an ordered list of ``(level_rank, count)`` tuples sorted
    from the most senior level (the team-lead level) down to the most junior.
    Each junior user reports, round-robin, to a user at the nearest more-senior
    level present in the team; the team-lead reports to the department head.
    Layer 4 staff (rank 8+) always report to a Layer 3 manager (rank 5-7),
    never to another Layer 4 member.
    """
    rank_order = [rank for rank, _ in composition]
    lead_rank = rank_order[0]
    by_rank: dict[int, list[User]] = {}
    created: list[User] = []

    for rank, count in composition:
        for _ in range(count):
            person_name = next(names)
            user = User(
                name=person_name,
                email=f"{person_name.lower()}@university.edu",
                dept_id=dept.id,
                dept_level_id=level_by_rank[rank].id,
            )
            session.add(user)
            session.flush()
            by_rank.setdefault(rank, []).append(user)
            created.append(user)

    for pos, rank in enumerate(rank_order):
        members = by_rank.get(rank, [])
        if rank == lead_rank:
            for index, user in enumerate(members):
                session.add(
                    OrgUnitMembership(
                        org_unit_id=team.id,
                        user_id=user.id,
                        is_team_lead=(index == 0),
                    )
                )
                session.add(
                    ReportingLine(
                        user_id=user.id, manager_id=head.id, dept_id=dept.id
                    )
                )
            continue

        senior_members: list[User] = []
        for senior_rank in reversed(rank_order[:pos]):
            # Layer 4 staff (rank 8+) report up to a Layer 3 manager (5-7),
            # never to another Layer 4 member.
            if rank >= 8 and senior_rank >= 8:
                continue
            if by_rank.get(senior_rank):
                senior_members = by_rank[senior_rank]
                break
        if not senior_members:
            senior_members = by_rank[lead_rank]

        for index, user in enumerate(members):
            manager = senior_members[index % len(senior_members)]
            session.add(
                OrgUnitMembership(org_unit_id=team.id, user_id=user.id)
            )
            session.add(
                ReportingLine(
                    user_id=user.id, manager_id=manager.id, dept_id=dept.id
                )
            )

    session.flush()
    return created


def _seed_itso_hro_departments(
    session: Session, actions: dict[str, Action]
) -> dict[str, Any]:
    """Seed the ITSO and HRO departments with levels, teams and staff.

    ITSO carries roughly 30 staff and HRO roughly 20 staff, each split across
    several teams with their own reporting lines, matching the level mapping
    requested for the POC.
    """
    itso = Department(name="Information Technology Services Office", code="ITSO")
    hro = Department(name="Human Resources Office", code="HRO")
    session.add_all([itso, hro])
    session.flush()

    # ITSO levels (rank 4 = most senior / top level).
    itso_level_specs = [
        (4, "Department Head", True),
        (5, "Senior Manager (Team Lead)", False),
        (6, "Manager", False),
        (7, "Systems Analyst", False),
        (8, "Analyst Programmer", False),
        (9, "Programmer", False),
    ]
    # HRO levels (no rank 7 - Systems Analyst is ITSO only).
    hro_level_specs = [
        (4, "Department Head", True),
        (5, "Manager (Team Lead)", False),
        (6, "Assistant Manager", False),
        (8, "Officer", False),
        (9, "Assistant Officer", False),
    ]

    itso_levels: dict[int, DeptLevel] = {}
    for rank, level_name, is_top in itso_level_specs:
        level = DeptLevel(
            dept_id=itso.id,
            level_rank=rank,
            level_name=level_name,
            is_top_level=is_top,
        )
        session.add(level)
        itso_levels[rank] = level

    hro_levels: dict[int, DeptLevel] = {}
    for rank, level_name, is_top in hro_level_specs:
        level = DeptLevel(
            dept_id=hro.id,
            level_rank=rank,
            level_name=level_name,
            is_top_level=is_top,
        )
        session.add(level)
        hro_levels[rank] = level
    session.flush()

    itso_infra = OrgUnit(dept_id=itso.id, name="Infrastructure Team", code="ITSO-INFRA")
    itso_apps = OrgUnit(dept_id=itso.id, name="Applications Team", code="ITSO-APP")
    itso_svc = OrgUnit(dept_id=itso.id, name="Service Desk Team", code="ITSO-SVC")
    hro_recruitment = OrgUnit(dept_id=hro.id, name="Recruitment Team", code="HRO-REC")
    hro_operations = OrgUnit(dept_id=hro.id, name="Operations Team", code="HRO-OPS")
    session.add_all(
        [itso_infra, itso_apps, itso_svc, hro_recruitment, hro_operations]
    )
    session.flush()

    itso_names = iter(
        [
            "Ivan", "Ingrid", "Isaac", "Iris", "Igor",
            "Bella", "Bruno", "Bianca", "Boris", "Bonnie",
            "Carl", "Cara", "Cyrus", "Cleo", "Conrad",
            "Dana", "Dean", "Daisy", "Drake", "Dora",
            "Ethan", "Elena", "Evan", "Esme", "Eric",
            "Felix", "Faye", "Fritz", "Greg", "Gemma",
        ]
    )
    hro_names = iter(
        [
            "Hannah", "Harvey", "Hazel", "Hugo", "Holly",
            "Hector", "Heidi", "Hope", "Hank", "Hilda",
            "Jack", "Jane", "Jasper", "Joan", "Jude",
            "Kara", "Kevin", "Kyra", "Liam", "Lena",
        ]
    )

    itso_head_name = next(itso_names)
    itso_head = User(
        name=itso_head_name,
        email=f"{itso_head_name.lower()}@university.edu",
        dept_id=itso.id,
        dept_level_id=itso_levels[4].id,
    )
    hro_head_name = next(hro_names)
    hro_head = User(
        name=hro_head_name,
        email=f"{hro_head_name.lower()}@university.edu",
        dept_id=hro.id,
        dept_level_id=hro_levels[4].id,
    )
    session.add_all([itso_head, hro_head])
    session.flush()

    itso_users: list[User] = [itso_head]
    itso_users += _build_team(
        session,
        dept=itso,
        team=itso_infra,
        level_by_rank=itso_levels,
        composition=[(5, 1), (6, 1), (7, 2), (8, 3), (9, 3)],
        names=itso_names,
        head=itso_head,
    )
    itso_users += _build_team(
        session,
        dept=itso,
        team=itso_apps,
        level_by_rank=itso_levels,
        composition=[(5, 1), (6, 1), (7, 2), (8, 3), (9, 3)],
        names=itso_names,
        head=itso_head,
    )
    itso_users += _build_team(
        session,
        dept=itso,
        team=itso_svc,
        level_by_rank=itso_levels,
        composition=[(5, 1), (6, 1), (7, 2), (8, 2), (9, 3)],
        names=itso_names,
        head=itso_head,
    )

    hro_users: list[User] = [hro_head]
    hro_users += _build_team(
        session,
        dept=hro,
        team=hro_recruitment,
        level_by_rank=hro_levels,
        composition=[(5, 1), (6, 1), (8, 4), (9, 4)],
        names=hro_names,
        head=hro_head,
    )
    hro_users += _build_team(
        session,
        dept=hro,
        team=hro_operations,
        level_by_rank=hro_levels,
        composition=[(5, 1), (6, 1), (8, 3), (9, 4)],
        names=hro_names,
        head=hro_head,
    )

    session.add_all(
        [
            DepartmentFallbackRule(
                dept_id=itso.id,
                fallback_user_id=hro_head.id,
                fallback_label="HRO Department Head",
            ),
            DepartmentFallbackRule(
                dept_id=hro.id,
                fallback_user_id=itso_head.id,
                fallback_label="ITSO Department Head",
            ),
        ]
    )

    annual_leave = actions["annual_leave"]
    sick_leave = actions["sick_leave"]
    training_request = actions["training_request"]
    performance_review = actions.get("performance_review")
    routing_rules = [
            ActionRoutingRule(
                action_id=annual_leave.id,
                dept_id=itso.id,
                requires_primary=True,
                requires_second_level=True,
            ),
            ActionRoutingRule(
                action_id=sick_leave.id,
                dept_id=itso.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=training_request.id,
                dept_id=itso.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=annual_leave.id,
                dept_id=hro.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=sick_leave.id,
                dept_id=hro.id,
                requires_primary=True,
                requires_second_level=True,
            ),
            ActionRoutingRule(
                action_id=training_request.id,
                dept_id=hro.id,
                requires_primary=True,
                requires_second_level=False,
            ),
    ]
    # Case #3 (Partial Acting): performance reviews are a distinct workflow from
    # leave approvals, routed primary + second level so the second level still
    # rolls up to the on-leave manager's own manager (the default second level).
    if performance_review is not None:
        routing_rules += [
            ActionRoutingRule(
                action_id=performance_review.id,
                dept_id=itso.id,
                requires_primary=True,
                requires_second_level=True,
            ),
            ActionRoutingRule(
                action_id=performance_review.id,
                dept_id=hro.id,
                requires_primary=True,
                requires_second_level=True,
            ),
        ]
    session.add_all(routing_rules)
    session.flush()

    # Case #1 (Skip-level Acting): a single position-level acting overlay where
    # the junior programmer Boris acts for the ITSO Senior Leader (Ivan). The
    # assignment is keyed on the principal (Ivan), so the routing engine
    # cascades it to every approval chain where Ivan is an approver — i.e. all
    # of his second-level dependents (Isaac, Cyrus, Evan, ...) — without editing
    # any individual reporting line. It is date-scoped to July 2027 so the
    # default chains keep showing Ivan and the cascade only appears on that date.
    itso_by_name = {user.name: user for user in itso_users}
    boris = itso_by_name["Boris"]
    session.add(
        ActingAssignment(
            principal_user_id=itso_head.id,
            acting_user_id=boris.id,
            dept_id=itso.id,
            org_unit_id=None,
            action_id=None,
            effective_from=_dt(2027, 7, 1),
            effective_to=_dt(2027, 7, 31),
        )
    )
    session.flush()

    return {
        "itso": itso,
        "hro": hro,
        "itso_ivan": itso_head,
        "itso_boris": boris,
        "itso_isaac": itso_by_name["Isaac"],
        "itso_ingrid": itso_by_name["Ingrid"],
        "itso_cyrus": itso_by_name["Cyrus"],
        "itso_cara": itso_by_name["Cara"],
        "itso_cleo": itso_by_name["Cleo"],
        "itso_evan": itso_by_name["Evan"],
        "itso_infra": itso_infra,
        "itso_apps": itso_apps,
        "itso_svc": itso_svc,
        "hro_recruitment": hro_recruitment,
        "hro_operations": hro_operations,
        "itso_levels": itso_levels,
        "hro_levels": hro_levels,
        "itso_head": itso_head,
        "hro_head": hro_head,
        "itso_users": itso_users,
        "hro_users": hro_users,
    }


def _seed_executive_tier(session: Session) -> dict[str, Any]:
    """Seed the corporate Layer 1 tier shared by every department.

    Layer 1 sits above the department heads (Layer 2) and contains three
    ranks: Provost (rank 1), VP (rank 2) and School (rank 3). The School
    reports to the VP, who reports to the Provost, who is the top of the
    institution. Department heads are wired to report up to the School.
    """
    executive = Department(name="University Executive", code="EXEC")
    session.add(executive)
    session.flush()

    exec_specs = [
        (1, "Provost", True),
        (2, "VP", False),
        (3, "School", False),
    ]
    exec_levels: dict[int, DeptLevel] = {}
    for rank, level_name, is_top in exec_specs:
        level = DeptLevel(
            dept_id=executive.id,
            level_rank=rank,
            level_name=level_name,
            is_top_level=is_top,
        )
        session.add(level)
        exec_levels[rank] = level
    session.flush()

    provost = User(
        name="Provost",
        email="provost@university.edu",
        dept_id=executive.id,
        dept_level_id=exec_levels[1].id,
    )
    vp = User(
        name="VP",
        email="vp@university.edu",
        dept_id=executive.id,
        dept_level_id=exec_levels[2].id,
    )
    school = User(
        name="School",
        email="school@university.edu",
        dept_id=executive.id,
        dept_level_id=exec_levels[3].id,
    )
    session.add_all([provost, vp, school])
    session.flush()

    session.add_all(
        [
            ReportingLine(user_id=school.id, manager_id=vp.id, dept_id=executive.id),
            ReportingLine(user_id=vp.id, manager_id=provost.id, dept_id=executive.id),
        ]
    )
    session.flush()

    return {
        "executive": executive,
        "exec_levels": exec_levels,
        "provost": provost,
        "vp": vp,
        "school": school,
    }


def seed_approval_templates(session: Session) -> None:
    """Seed the standard approval route templates if they don't already exist."""
    existing_codes = {
        code for (code,) in session.query(ApprovalRouteTemplate.code).all()
    }
    templates = [
        ApprovalRouteTemplate(
            name="Primary Only",
            code="primary_only",
            description="Route to primary manager only.",
            num_levels=1,
            routing_type="standard",
        ),
        ApprovalRouteTemplate(
            name="Primary + Second Level",
            code="primary_second",
            description="Route to primary manager then second level.",
            num_levels=2,
            routing_type="standard",
        ),
        ApprovalRouteTemplate(
            name="Direct to Director",
            code="direct_director",
            description="Route directly to the top-level director.",
            num_levels=1,
            routing_type="direct_top",
        ),
        ApprovalRouteTemplate(
            name="Department Head Only",
            code="dept_head_only",
            description="Route to the department head.",
            num_levels=1,
            routing_type="dept_head",
        ),
        ApprovalRouteTemplate(
            name="Fallback Only",
            code="fallback_only",
            description="Route to fallback approver only.",
            num_levels=1,
            routing_type="fallback",
        ),
        ApprovalRouteTemplate(
            name="Project Manager",
            code="project_manager",
            description="Route to project manager for project-scoped actions.",
            num_levels=1,
            routing_type="project",
        ),
        ApprovalRouteTemplate(
            name="Co-head Either One",
            code="cohead_either",
            description="Either co-head may approve.",
            num_levels=1,
            routing_type="cohead_either",
        ),
        ApprovalRouteTemplate(
            name="Co-head Both Required",
            code="cohead_both",
            description="Both co-heads must approve in sequence.",
            num_levels=2,
            routing_type="cohead_both",
        ),
        ApprovalRouteTemplate(
            name="Custom Chain",
            code="custom_chain",
            description="Custom 3-level approval chain.",
            num_levels=3,
            routing_type="custom",
        ),
    ]
    for tpl in templates:
        if tpl.code not in existing_codes:
            session.add(tpl)
    session.commit()


def seed_sample_data(session: Session) -> dict[str, Any]:
    """Populate the database with Finance + HR sample data for the POC."""
    finance = Department(name="Finance", code="FIN")
    hr = Department(name="Human Resources", code="HR")
    session.add_all([finance, hr])
    session.flush()

    fin_level1 = DeptLevel(
        dept_id=finance.id,
        level_rank=4,
        level_name="Finance Director",
        is_top_level=True,
    )
    fin_level2 = DeptLevel(
        dept_id=finance.id,
        level_rank=5,
        level_name="Senior Manager",
    )
    fin_level3 = DeptLevel(
        dept_id=finance.id,
        level_rank=9,
        level_name="Finance Officer",
    )
    hr_level1 = DeptLevel(
        dept_id=hr.id,
        level_rank=4,
        level_name="HR Director",
        is_top_level=True,
    )
    hr_level2 = DeptLevel(
        dept_id=hr.id,
        level_rank=5,
        level_name="HR Manager",
    )
    hr_level3 = DeptLevel(
        dept_id=hr.id,
        level_rank=9,
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
    project_change = Action(
        name="Project Change Request",
        code="project_change_request",
        is_project_scoped=True,
    )
    finance_team_plan = Action(
        name="Finance Team Plan",
        code="finance_team_plan",
    )
    # Case #3 (Partial Acting) decouples workflows by approval type: leave
    # approvals follow one cover, performance reviews follow another. A dedicated
    # Performance Review action lets each coverage overlay be scoped to its own
    # workflow so the two routes can diverge for the same on-leave manager.
    performance_review = Action(
        name="Performance Review",
        code="performance_review",
    )
    session.add_all(
        [
            annual_leave,
            sick_leave,
            training_request,
            project_change,
            finance_team_plan,
            performance_review,
        ]
    )
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
            ActionRoutingRule(
                action_id=project_change.id,
                dept_id=finance.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=project_change.id,
                dept_id=hr.id,
                requires_primary=True,
                requires_second_level=False,
            ),
            ActionRoutingRule(
                action_id=finance_team_plan.id,
                dept_id=finance.id,
                requires_primary=True,
                requires_second_level=False,
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
    session.flush()

    project_transform = Project(
        name="University Transformation Programme",
        code="UTP",
        home_dept_id=finance.id,
    )
    session.add(project_transform)
    session.flush()

    session.add_all(
        [
            ProjectAssignment(
                project_id=project_transform.id,
                user_id=peter.id,
                role_name="Finance representative",
            ),
            ProjectAssignment(
                project_id=project_transform.id,
                user_id=olivia.id,
                role_name="HR representative",
            ),
            ProjectReportingLine(
                project_id=project_transform.id,
                user_id=peter.id,
                project_manager_id=helen.id,
                action_id=project_change.id,
            ),
            ProjectReportingLine(
                project_id=project_transform.id,
                user_id=olivia.id,
                project_manager_id=mary.id,
                action_id=project_change.id,
            ),
        ]
    )

    session.add_all(
        [
            ActingAssignment(
                principal_user_id=mary.id,
                acting_user_id=nina.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=sick_leave.id,
                effective_from=_dt(2027, 6, 1),
                effective_to=_dt(2027, 6, 30),
            ),
            ActingAssignment(
                principal_user_id=mary.id,
                acting_user_id=peter.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=sick_leave.id,
                effective_from=_dt(2027, 10, 1),
                effective_to=_dt(2027, 10, 31),
            ),
            CoverageAssignment(
                covered_user_id=mary.id,
                coverage_user_id=nina.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=annual_leave.id,
                effective_from=_dt(2027, 8, 1),
                effective_to=_dt(2027, 8, 31),
            ),
            DelegationAssignment(
                delegator_user_id=mary.id,
                delegate_user_id=nina.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=annual_leave.id,
                effective_from=_dt(2027, 9, 1),
                effective_to=_dt(2027, 9, 30),
            ),
            HandoverOverlap(
                requester_user_id=peter.id,
                old_approver_id=mary.id,
                new_approver_id=nina.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=sick_leave.id,
                effective_from=_dt(2027, 11, 1),
                effective_to=_dt(2027, 11, 30),
                policy="both_required",
            ),
            CoHeadAssignment(
                user_id=mary.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=finance_team_plan.id,
                policy="either_one_approves",
                sequence_order=1,
                is_primary=True,
            ),
            CoHeadAssignment(
                user_id=nina.id,
                dept_id=finance.id,
                org_unit_id=finance_team.id,
                action_id=finance_team_plan.id,
                policy="either_one_approves",
                sequence_order=2,
            ),
        ]
    )

    extended = _seed_itso_hro_departments(
        session,
        {
            "annual_leave": annual_leave,
            "sick_leave": sick_leave,
            "training_request": training_request,
            "performance_review": performance_review,
        },
    )

    # Layer 1 corporate tier (Provost > VP > School) shared by all departments.
    executive = _seed_executive_tier(session)
    school = executive["school"]
    session.add_all(
        [
            ReportingLine(user_id=fiona.id, manager_id=school.id, dept_id=finance.id),
            ReportingLine(user_id=henry.id, manager_id=school.id, dept_id=hr.id),
            ReportingLine(
                user_id=extended["itso_head"].id,
                manager_id=school.id,
                dept_id=extended["itso"].id,
            ),
            ReportingLine(
                user_id=extended["hro_head"].id,
                manager_id=school.id,
                dept_id=extended["hro"].id,
            ),
        ]
    )

    session.commit()

    # Seed approval route templates
    seed_approval_templates(session)

    result: dict[str, Any] = {
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
        "project_change": project_change,
        "finance_team_plan": finance_team_plan,
        "performance_review": performance_review,
        "project_transform": project_transform,
    }
    result.update(extended)
    result.update(executive)
    return result
