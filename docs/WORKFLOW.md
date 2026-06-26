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

### Corrected global level mapping

| Level Rank | Role/Position example |
|---|---|
| 4 | Director (Finance Director, HR Director) |
| 5 | Senior Manager, HR Manager |
| 9 | Officer (Finance Officer, HR Officer) |

This matches the university global hierarchy where Level 4 is Director,
Level 5 is Senior Manager, and Level 9 is Officer.

The sample data includes at least the following departments:

- **Finance**
- **Human Resources**

Example Finance scenario:

- Fiona — Finance Director (Level 4, top level)
- Mary — Senior Manager (Level 5) and Finance Team lead
- Nina — Senior Manager (Level 5) and secondary Finance co-head
- Peter — Finance Officer (Level 9)
- Quinn — Payroll Team Finance Officer (Level 9)

Example HR scenario:

- Henry — HR Director (Level 4, top level)
- Helen — HR Manager (Level 5) and HR Advisory team lead
- Olivia — HR Officer (Level 9)

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

The POC UI state persists in `/tmp/reporting_line_manual_test.db` (SQLite).
Set `REPORTING_LINE_DB=/path/to/file.db` to use a different location.
Use the **Reset to default seed data** button in the Seed Data Editor tab to
restore the original sample data at any time.

## Editing the visual diagram

1. Open <http://127.0.0.1:8000> and click the **Diagram Editor** tab.
2. Select a department from the dropdown, or choose **All Departments** to view
   every department in one combined diagram (nodes are tagged with their
   department code).
3. The layered SVG diagram shows all users as nodes, with:
   - solid lines representing official primary reporting relationships
   - level numbers on each node (`L4` = Director, `L5` = Senior Manager, `L9` = Officer)
   - ★ marker next to team leads
   - dark-coloured nodes for top-level (Director) users
4. **Click any node** to open the edit panel on the right.
5. Edit any of the following fields:
   - **Name** — user's display name
   - **Email** — user's email address
   - **Level** — dropdown of all available department levels
   - **Org Unit / Team** — the org-unit the user belongs to
   - **Team Lead** — toggle the team lead flag on/off
   - **Primary Manager** — change the official reporting-to manager
6. Click **Save changes**.
   - If a circular reporting line would result, an error is shown and the
     change is not saved.
   - On success the diagram and simulation dropdowns refresh immediately.
7. After saving, switch to the **Simulation** tab and run a scenario to see
   the updated approval chain.

## Editing seed data

1. Click the **Seed Data Editor** tab.
2. Select a sub-tab: Users, Levels, Reporting Lines, Routing Rules, Fallback
   Approvers, Actions, Departments, or Org Units.
3. Edit values inline and click **Save** on the row.
4. Users, Levels, Reporting Lines, Actions, Departments, and Org Units support
   adding new records via the **+ Add** button above each table, and removing
   existing records via the **Remove** button on each row.
5. Deletions are guarded against referential integrity issues: a department with
   users, a level still assigned to a user, or an org unit with active members
   cannot be removed.
6. Click **Reset to default seed data** at the top to restore original values.

### Entities editable from the UI

| Entity | Operations | Editable fields |
|---|---|---|
| Users | add / edit / deactivate | name, email, level, active |
| Department Levels | add / edit / remove | department, rank, name, top-level flag |
| Departments | add / edit / remove | name, code |
| Actions | add / edit / remove | name, code, project-scoped flag |
| Org Units | add / edit / remove | department, name, code |
| Reporting Lines | add / remove | active primary manager relationships |
| Routing Rules | edit | requires_primary, requires_second_level per action/dept |
| Fallback Approvers | edit | fallback user and label per department |

### How seed data edits affect simulation

After any edit, the **Simulation** tab and **Advanced Scenario Simulations**
automatically use the updated state.  Example flow:

1. In **Seed Data Editor → Reporting Lines**, change Peter's manager from
   Mary to Nina.
2. Switch to **Simulation**, select Peter as requester and Annual Leave.
3. The chain now shows Nina → Fiona instead of Mary → Fiona.

## Test Case Diagram (temporary reporting-line builder)

The **Test Case Diagram** tab lets you build a reporting-line diagram for a test
case, edit it temporarily, and read the resolved reporting line in plain wording
under the diagram — without mutating the persisted POC state.

1. Click the **Test Case Diagram** tab.
2. Optionally choose a **Department** (or **All Departments**) to scope the
   diagram.
3. **Click any node** to open the temporary edit panel and change who that
   person **reports to**. The change updates the diagram immediately but is
   **not saved** to the POC state.
4. Choose a **Requester**. The reporting line is walked from the requester up to
   the top and described in plain wording beneath the diagram, with each step
   listed (e.g. `Peter → Mary (FIN Senior Manager, L5)`).
5. Circular reporting lines introduced by the edits are detected and reported.
6. **Reset diagram** restores the official reporting lines.

The diagram edits are sent as primary manager assignments to
`POST /api/simulate-reporting-line`, applied inside a transaction that is always
rolled back, so the test-case diagram never changes persisted data.

## Scenario Lab (advanced test-case simulator)

The **Scenario Lab** tab lets you construct advanced overlay test cases on top
of the official reporting line and inspect the resolved approvers, without
mutating the persisted POC state.

1. Click the **Scenario Lab** tab.
2. Choose a **Requester** and **Action** (optionally a request date and project
   code).
3. Add one or more **overlays**. Each overlay has a type and two participants:
   - **Acting** — principal whose authority is acted, and the acting approver
   - **Delegation** — delegator and the delegate approver
   - **Peer coverage** — covered approver and the coverage approver
   - **Handover overlap** — outgoing and incoming approver, plus a policy
     (`old_until_end_date`, `new_from_start_date`, `both_required`,
     `new_primary_old_observer`)
4. Click **Run scenario**. The resolved **primary** and **second-level**
   approvers are highlighted, with the full approval chain shown below.
5. Overlays defined here are simulated in a rolled-back transaction (via
   `POST /api/simulate-overlay`) and are never saved, so you can test cases
   freely.

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
| BC-25 | Diagram node edit updates level and refreshes chart | Edit Peter's level to Senior Manager (Level 5) | POC state is editable via diagram UI | Peter's node shows Level 5 | PUT `/api/users/{id}` persists change; GET `/api/org-chart` reflects update |
| BC-26 | Diagram edge edit updates reporting line | Change Peter's manager from Mary to Nina | POC state is editable via diagram UI | Annual Leave routes Peter→Nina→Fiona | POST `/api/reporting-lines` persists change; routing reflects new manager |
| BC-27 | Circular reporting line edit is blocked | Attempt to set Fiona's manager to Peter | Peter→Mary→Fiona cycle would result | Validation error shown in edit panel | POST `/api/reporting-lines` returns 400 with clear error |
| BC-28 | Seed data edit changes available users in scenario builder | Add new user via seed data editor | POC seed data is editable | New user appears in requester dropdown | POST `/api/users` creates user; bootstrap returns updated list |
| BC-29 | Corrected default levels are displayed | Load the POC page | Default seed data is loaded | Director shown as Level 4, Senior Manager as Level 5, Officer as Level 9 | Seed user pills and org chart nodes show correct level labels and ranks |
| BC-30 | Scenario builder uses updated data after edit | Change Peter's manager; run Annual Leave | Diagram edit has been saved | Approval chain updated to use new manager | Scenario builder reflects current DB state, not snapshot at page load |
