# University Reporting-Line System POC

## Overview

This proof-of-concept models a university reporting-line system that is used for
both:

1. **approval routing**, and
2. **org chart display**.

The POC is department-based and org-unit aware:

- departments own their own levels, org-units, routing rules, and fallback
  approvers
- staff members have exactly one active primary manager
- team lead is an **assignment/role** inside an org-unit, not a position
- second-level approval is usually the primary manager's primary manager
- top-level users route to a department-level fallback approver

Advanced reporting-line cases are implemented as temporary routing overlays,
not additional official primary-manager records.

## Architecture

```text
src/
├── database.py
├── manual_test_app.py
├── models.py
├── sample_data.py
└── services/
    ├── approval.py
    ├── configuration.py
    ├── org_chart.py
    ├── permissions.py
    └── routing.py

frontend/
├── app.js
├── index.html
└── styles.css

tests/
├── conftest.py
├── test_manual_test_app.py
└── test_routing.py
```

## Schema summary

The schema includes:

- `departments`
- `dept_levels`
- `org_units`
- `org_unit_memberships`
- `users`
- `reporting_lines`
- `actions`
- `action_routing_rules`
- `department_fallback_rules`
- `acting_assignments`
- `coverage_assignments`
- `delegation_assignments`
- `handover_overlaps`
- `projects`
- `project_assignments`
- `project_reporting_lines`
- `co_head_assignments`
- `approval_requests`
- `approval_steps`
- `approval_actions`
- `audit_logs`

## Seed data

The sample data includes at least the following departments:

- **Finance**
- **Human Resources**

Example Finance scenario:

- Fiona — Finance Director (top level)
- Mary — Senior Manager and Finance Team lead
- Nina — Senior Manager and secondary Finance co-head
- Peter — Finance Officer
- Quinn — Payroll Team Finance Officer

Example HR scenario:

- Henry — HR Director (top level)
- Helen — HR Manager and HR Advisory team lead
- Olivia — HR Officer

## Business logic summary

### Routing

1. Load the requester and action.
2. Find the official department/org-unit route from the action rule and
   reporting line.
3. Validate that the requester has at most one active primary manager.
4. Detect circular reporting before building the chain.
5. If the requester is top-level, use the department fallback approver.
6. Otherwise:
   - step 1 = primary manager
   - step 2 = primary manager's primary manager when required
   - if step 2 is missing, use the department fallback approver
7. Apply date-valid overlays, when in scope:
   - handover overlap
   - acting
   - delegation
   - peer coverage
   - cross-department project routing for project-scoped actions only
   - co-head policies
8. Prevent self-approval by escalating or falling back to a safe approver.
9. Audit overlay application and final chain generation.
10. Reject missing rule, missing primary manager, missing fallback rule,
    inactive user, inactive replacement approver, self-delegation, or invalid
    overlay configuration with explicit errors.

### Team-lead permissions

A team lead may edit reporting-line data only when all conditions are true:

- editor is an active team lead
- target is active
- editor and target share the same org-unit
- target is lower level than the editor
- target is not top-level/protected
- target is not the editor

### Configurable data + editable diagram

The manual frontend exposes API-backed controls for:

- configurable field CRUD/activate/deactivate for users, levels, departments,
  org-units, actions, routing rules, reporting lines, fallback rules, and
  supported overlay records
- diagram edits for user department, level, manager, org-unit, and team-lead
  assignment

Diagram edits reuse business validations:

- one active primary manager per user
- no circular reporting
- protected top-level users cannot be moved/demoted
- team lead editor permissions are enforced when editor is provided
- target department/level/org-unit combinations must be valid
- inactive managers are rejected for active primary routing

### Supported overlay policies

- **Acting** — replaces an approver during a valid date range with optional
  department/org-unit/action scope
- **Peer coverage** — temporary peer replacement without changing official
  org chart or primary manager
- **Delegation** — temporary delegated approval with active-user and
  self-delegation validation
- **Handover overlap** — supports `old_until_end_date`, `new_from_start_date`,
  `both_required`, and `new_primary_old_observer`
- **Cross-department projects** — project manager overlay applies only to
  project-scoped actions
- **Co-heads** — supports `either_one_approves`, `both_required`,
  `primary_then_secondary`, and `split_by_org_unit`
- **Self-approval prevention** — redirects to escalation or fallback

## Run locally

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
python -m src.manual_test_app
```

Open <http://127.0.0.1:8000>.

## Full business/test case table

| Business Case ID | Scenario | Input | Preconditions | Expected Output | Pass Criteria |
|---|---|---|---|---|---|
| BC-01 | Official Annual Leave routing | Requester Peter, action `annual_leave` | Finance Annual Leave requires primary + second-level approval; Peter → Mary → Fiona | Mary then Fiona | Two approval steps are returned in order and neither is fallback |
| BC-02 | Official Sick Leave routing | Requester Peter, action `sick_leave` | Finance Sick Leave requires primary only; Peter → Mary | Mary only | One approval step is returned |
| BC-03 | HR department-specific Annual Leave routing | Requester Olivia, action `annual_leave` | HR Annual Leave is configured differently from Finance and requires primary only; Olivia → Helen | Helen only | HR routing result differs from Finance routing for the same action |
| BC-04 | Finance top-level fallback routing | Requester Fiona, action `annual_leave` | Fiona is Finance top-level user; Finance fallback approver is Henry | Henry as fallback approver | One fallback step is returned |
| BC-05 | Org chart display with org-units, team leads, and co-heads | Department `FIN` | Finance Team and Payroll Team exist; Mary is team lead; Mary and Nina are co-heads | Org chart shows org-units, members, direct managers, team leads, and co-heads | UI/API returns Finance Team with Mary in `team_leads` and Mary/Nina in `co_heads` |
| BC-06 | Team lead edits lower-level user in same org-unit | Editor Mary, target Peter | Mary is Finance Team lead; Peter is lower-level Finance Team member | Allowed | Permission check returns `allowed = true` |
| BC-07 | Acting replaces approver during valid date range | Requester Peter, action `sick_leave`, date `2027-06-15` | Mary has acting assignment to Nina for sick leave | Nina replaces Mary | Routing shows acting overlay explanation and Nina as approver |
| BC-08 | Acting ignored outside date range | Requester Peter, action `sick_leave`, date `2027-07-15` | Acting assignment expired | Mary remains approver | Routing ignores acting overlay |
| BC-09 | Peer coverage replaces approver during valid coverage | Requester Peter, action `annual_leave`, date `2027-08-15` | Mary is covered by Nina for annual leave | Nina then Fiona | Routing shows coverage overlay and audit log |
| BC-10 | Delegation replaces approver during valid date range | Requester Peter, action `annual_leave`, date `2027-09-15` | Mary delegates annual leave to Nina | Nina then Fiona | Routing shows delegation overlay and audit log |
| BC-11 | Self-approval is blocked or redirected | Requester Peter, action `sick_leave`, date `2027-10-15` | Acting assignment would route approval to Peter | Fiona replaces self-approval | Final chain excludes requester and explains redirect |
| BC-12 | Handover overlap both_required policy | Requester Peter, action `sick_leave`, date `2027-11-15` | Handover overlap from Mary to Nina uses `both_required` | Mary then Nina | Two handover approval steps are generated |
| BC-13 | Cross-department project action routing | Requester Peter, action `project_change_request`, project `UTP` | Peter belongs to UTP; Helen is project manager | Helen approves | Project manager replaces official route for project-scoped action |
| BC-14 | Annual Leave ignores project routing | Requester Peter, action `annual_leave`, project `UTP` | Annual Leave is not project-scoped | Mary then Fiona | Project overlay is not applied |
| BC-15 | Co-head either_one_approves policy | Requester Peter, action `finance_team_plan` | Finance Team co-heads use `either_one_approves` | Mary primary approver, Nina alternate | Routing explains co-head policy and shows alternate |
| BC-16 | Co-head both_required policy | Requester Peter, action `finance_team_plan` | Finance Team co-head policy switched to `both_required` | Mary then Nina | Two co-head steps are generated |
| BC-17 | Invalid delegation to inactive user | Requester Peter, action `annual_leave`, date within delegation window | Applicable delegate is inactive | Error for inactive delegate | API/service raises clear inactive-user error |
| BC-18 | Self-delegation rejected | Requester Peter, action `annual_leave`, date within delegation window | Applicable delegate equals delegator | Error for self-delegation | API/service raises explicit self-delegation error |
| BC-19 | Missing action routing rule | Requester Peter, action `training_request` | Action exists but no Finance routing rule exists | Error for missing routing rule | API/service raises clear routing-rule error |
| BC-20 | Missing primary manager | Requester Peter, action `annual_leave` | Peter's active reporting line is deactivated | Error for missing primary manager | API/service raises clear primary-manager error |
| BC-21 | Missing fallback rule | Requester Fiona, action `annual_leave` | Finance fallback rule is removed | Error for missing fallback rule | API/service raises clear fallback error |
| BC-22 | Circular reporting chain | Requester Peter, action `annual_leave` | Extra line Fiona → Peter creates a cycle | Error for circular reporting | API/service raises clear cycle error |
| BC-23 | Inactive manager/user | Requester Peter or inactive requester Peter, action `annual_leave` | Mary is inactive or Peter is inactive | Error for inactive manager/requester | API/service raises clear inactive-user error |
| BC-24 | Multiple active primary managers | Requester Peter, action `annual_leave` | Peter has two active primary reporting lines | Error for multiple active primary managers | API/service raises explicit single-primary-manager error |
| BC-25 | Custom user creation/editing | Create user Iris and update fields | Valid department, level, org-unit, and manager exist | User persisted and editable | Bootstrap/config APIs expose updated user immediately |
| BC-26 | Custom level/department/org-unit/action routing configuration | Create level, org-unit, action type, and routing rule | Referenced records exist | New configurable records persisted | Routing simulation can run using new rule |
| BC-27 | Diagram edit: change user position/department/org-unit | Move Peter to HR Advisory and HR level | Selected level and org-unit belong to HR | Edit succeeds | Org chart and routing reflect new placement |
| BC-28 | Diagram edit: change primary manager | Reassign Peter's manager | New manager active, no cycle | Edit succeeds | Approval chain uses new manager |
| BC-29 | Diagram edit blocked: circular reporting | Set Fiona's manager to Peter | Fiona is in Peter's chain | Clear validation error | Reporting line unchanged |
| BC-30 | Diagram edit blocked: protected highest level | Demote Fiona | Fiona is protected top-level | Clear validation error | User remains at protected top level |
| BC-31 | Routing simulation updates after field changes | Enable second-level requirement for Finance sick leave | Routing rule updated in configurable API | Chain adds second-level approver | Simulation output shows updated levels/fallback/overlay summary |
