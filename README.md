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

## Frontend POC

The browser UI lets you:

- inspect seed users for Finance and HR
- switch between department org charts with layered Level 1-9 graph labels
- view ownership boundaries (Own by HRO / Own by Each Dept. / Own by Each Team Lead)
- view grouped team regions (Team A / Team B / Team C) with graph nodes and solid official lines
- edit graph nodes via side panel (position/level, department, org-unit/team, primary manager, team lead)
- update action routing rules and department fallback approvers
- run scenario builder with requester/action/department/org-unit/level/date/approval-level inputs
- simulate action submission and see generated approval chain, overlays, audit explanations, and dashed approval route overlay
- run predefined advanced reporting-line scenarios
- validate team-lead edit permission decisions and invalid graph edits

## Key sample scenario

- **Mary** is a **Senior Manager** in **Finance**
- Mary is also the **team lead of Team A**
- Mary can edit lower-level users in Team A
- Mary cannot edit herself, same-level users, protected top-level users, or users outside Team A
- Team A also has a co-head approval setup with Mary as primary co-head and
  Nina as secondary co-head for Finance Team Plan requests
- Peter participates in the cross-department **UTP** project, where **Helen**
  can become the project approver for project-scoped actions

## Documentation

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for:

- schema summary
- layered routing business logic summary
- full business/test case table
- local run instructions
