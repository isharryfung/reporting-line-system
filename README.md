# reporting-line-system

University reporting-line system proof-of-concept built with Python, SQLAlchemy, SQLite, and a lightweight browser UI.

## What this POC covers

- Department-owned reporting structures
- Org-units/teams inside departments
- Team lead assignments as org-unit roles
- One active primary manager per staff member
- Department-specific action routing for Annual Leave and Sick Leave
- Department-level fallback approvers for top-level users
- Org chart display with team-lead and co-head indicators
- **Editable visual reporting-line diagram** with SVG nodes and edit panel
  (including an **All Departments** combined view)
- **Seed data editor** with full add/edit/remove for users, levels, departments,
  actions, org units, routing rules, fallback approvers, and reporting lines
- **Scenario Lab** to simulate advanced overlay test cases (delegation, acting,
  peer coverage, handover) and see the resolved primary and second-level approvers
- **Persistent POC state** stored in SQLite (edits survive across simulations)
- Advanced overlay routing for:
  - acting
  - peer coverage
  - delegation
  - handover overlap
  - cross-department project approval
  - co-head approval policies
  - self-approval prevention

Advanced cases are modeled as temporary overlays on top of the official
department reporting line so the core rule still holds: each staff member has
only one active official primary manager.

## Quick start

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
python -m src.manual_test_app
```

Then open <http://127.0.0.1:8000>.

## Layer model

The hierarchy is organised into four layers, mirroring the reporting-line
structure diagram:

| Layer | Levels | Roles | Owned by | Managed by |
|---|---|---|---|---|
| **Layer 1** | 1–3 | Provost, VP, School | Corporate (shared by all departments) | Provost / VP |
| **Layer 2** | 4 | Department Head | Each department | Layer 1 (corporate) |
| **Layer 3** | 5–7 | Senior Manager (Team Lead), Manager, Systems Analyst | Department Head | Department Head |
| **Layer 4** | 8–9 | Analyst Programmer, Programmer | Each team lead | Each team lead |

Layer 1 is seeded as a shared **University Executive** department (`EXEC`):
School reports to VP, VP reports to Provost (the top of the institution), and
every department head reports up to the School.

Departments handle their own actions internally and generally do **not** relate
to Layer 1. Layer 3 and Layer 4 actions are handled within the department,
escalating only **up to Layer 2 (Department Head)**: Layer 4 is owned and
managed by each team lead, while Layer 3 is owned and managed by the Department
Head.

## Corrected level mapping

| Level Rank | Role |
|---|---|
| **4** | **Director** (Finance Director, HR Director) |
| **5** | **Senior Manager** / HR Manager |
| **9** | **Officer** (Finance Officer, HR Officer) |

## ITSO and HRO departments

The POC also seeds two larger departments that follow their own level
structures: **ITSO** (Information Technology Services Office, ~30 staff) and
**HRO** (Human Resources Office, ~20 staff). Staff are split across several
teams, each with its own reporting line up to the department head.

| Level | ITSO Position | HRO Position |
|---|---|---|
| 4 | Department Head | Department Head |
| 5 | Senior Manager (Team Lead) | Manager (Team Lead) |
| 6 | Manager | Assistant Manager |
| 7 | Systems Analyst | — |
| 8 | Analyst Programmer | Officer |
| 9 | Programmer | Assistant Officer |

- **ITSO teams:** Infrastructure, Applications, Service Desk
- **HRO teams:** Recruitment, Operations
- Each department has a top-level fallback approver and its own routing rules
  for Annual Leave, Sick Leave, and Training Request.

## Frontend POC

The browser UI is organized into eight tabs:

### Overview tab
- Inspect seed users showing level, rank, org-unit, and team-lead status
- Switch between department org charts (card-based, read-only)
- Scenario summary notes

### Diagram Editor tab
- **Visual SVG diagram** of the selected department's reporting hierarchy
- Choose **All Departments** to render every department in a single diagram
  (nodes are tagged with their department code)
- Users are displayed as nodes positioned by level (L4 at top, L9 at bottom)
- Solid lines show official primary reporting relationships
- Team leads are marked with ★; top-level (Director) nodes are dark-coloured
- **Click any node** to open the Edit Panel:
  - Edit name, email, level, org-unit, team-lead flag, and primary manager
  - Saves are immediately reflected in the diagram and simulation
  - Circular reporting lines are detected and blocked with a clear error

### Test Case Diagram tab
- Build a reporting-line diagram specifically to test a case
- **Click any node** to **temporarily** change who it reports to — edits here are
  **never saved** to the POC state (they are simulated in a rolled-back transaction)
- Choose **All Departments** to build the case across every department at once
- Click a person to select them as the **requester**; the resolved reporting
  line is shown as plain **wording under the diagram** (e.g. "Peter reports to
  Mary, who reports to Fiona … Fiona is at the top of this reporting line")
- **Apply overlays** to see how routing changes the selected person's resolved
  approver line: pick an **action** (and optional **project code** / **request
  date**) and add **acting**, **delegation**, or other overlay rows. Co-head and
  self-approval-blocked behaviour appear automatically for the chosen action.
  Each resolved step is tagged with its routing **source** (e.g. `acting`,
  `delegation`, `project`, `co_head`, `self_approval_redirect`). Overlays are
  simulated in the same rolled-back transaction and **never saved**
- Circular reporting lines created while editing are detected and reported
- **Reset diagram** restores the official reporting lines

### 30 Testcase Diagram tab
- Lists the enterprise test cases (acting & coverage, matrix & dual
  reporting, hierarchy anomalies & loops, temporal & effective dating, special
  entities, and the **Layer 1 corporate tier**) on the **left**; selecting one
  **bolds the target reporting line** on the combined **EXEC, ITSO & HRO**
  diagram on the **right**
- A **Focus** selector lets you manually pick any EXEC/ITSO/HRO person after
  choosing a case; the diagram then bolds that person's resolved reporting line
  (walking their manager chain) instead of the case default. Choose **Use case
  default** to restore the hardcoded scenario target
- The diagram is read-only; nothing here is saved

### Seed Data Editor tab
- Add / edit / remove **users**, **levels**, **departments**, **actions**, and
  **org units**, plus edit routing rules, fallback approvers, and reporting lines
- Deletions are guarded against referential integrity issues (e.g. a department
  with users or a level still assigned to a user cannot be removed)
- **Reset to default seed data** button restores original sample data
- Changes are immediately available in the Simulation and Scenario Lab tabs

### Simulation tab
- Submit action simulations (requester, action, date, optional project)
- Team-lead edit permission check
- One-click advanced scenario simulations:
  - official route, acting, peer coverage, delegation, handover overlap,
    cross-department project, co-head, and self-approval blocked

### Scenario Lab tab
- Build ad-hoc advanced test cases on top of the official reporting line:
  pick a requester, action, and one or more overlays
  (delegation, acting, peer coverage, handover)
- Runs the routing engine and shows the resolved **primary** and
  **second-level** approvers, plus the full approval chain
- Overlays are **simulated only** and never persisted, so the POC state is
  never mutated while testing cases

## Persistent state

POC state is stored in `/tmp/reporting_line_manual_test.db`.
Set the `REPORTING_LINE_DB` environment variable to use a different path.

## Key sample scenario

- **Fiona** is the **Finance Director** (Level 4, top level)
- **Mary** is a **Senior Manager** (Level 5) in Finance and team lead of Finance Team
- **Peter** is a **Finance Officer** (Level 9) reporting to Mary
- Mary can edit lower-level users (Level 9+) in Finance Team
- Mary cannot edit herself, same-level users, top-level users, or users outside Finance Team
- Finance Team has a co-head setup with Mary as primary and Nina as secondary
- Peter participates in the cross-department **UTP** project, where **Helen**
  can become the project approver for project-scoped actions

## Documentation

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for:

- schema summary
- corrected level mapping (Director=4, Senior Manager=5, Officer=9)
- layered routing business logic summary
- how to edit the visual diagram
- how to edit seed data from the POC page
- how changes affect scenario simulation
- full business/test case table (BC-01 through BC-30)
- local run instructions
