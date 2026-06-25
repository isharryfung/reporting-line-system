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
- switch between department org charts
- simulate action submission and see the generated approval chain
- run predefined advanced reporting-line scenarios
- simulate team-lead edit permission decisions

## Key sample scenario

- **Mary** is a **Senior Manager** in **Finance**
- Mary is also the **team lead of Finance Team**
- Mary can edit lower-level users in Finance Team
- Mary cannot edit herself, same-level users, protected top-level users, or users outside Finance Team
- Finance Team also has a co-head approval setup with Mary as primary co-head and
  Nina as secondary co-head for Finance Team Plan requests
- Peter participates in the cross-department **UTP** project, where **Helen**
  can become the project approver for project-scoped actions

## Documentation

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for:

- schema summary
- layered routing business logic summary
- full business/test case table
- local run instructions
