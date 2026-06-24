# University Reporting-Line System — POC

## Overview

This proof-of-concept implements an action-based approval routing system for a
university that shares a single reporting-line platform across multiple
departments.  Each department owns its own reporting-line structure.  The
system routes approval requests (e.g. Annual Leave, Sick Leave) through the
correct chain of approvers based on configurable routing rules and, where
needed, fallback approvers.

---

## Architecture

```
src/
├── models.py            ORM models (SQLAlchemy, SQLite by default)
├── database.py          Engine / session factory helpers
└── services/
    ├── routing.py       Core routing logic → builds ApprovalChain
    └── approval.py      Workflow layer → persists requests and records decisions

tests/
├── conftest.py          Shared fixtures and seed data
└── test_routing.py      All 8 test cases + integration tests

docs/
└── WORKFLOW.md          This file
```

---

## Database Schema

| Table                 | Purpose                                                   |
|-----------------------|-----------------------------------------------------------|
| `departments`         | Academic / admin departments (e.g. Computer Science, HR)  |
| `dept_levels`         | Hierarchy levels within a dept; rank 1 = top (protected)  |
| `users`               | Staff members, each assigned to a dept + level            |
| `reporting_lines`     | Direct manager relationships (user → manager)             |
| `actions`             | Workflow action types (Annual Leave, Sick Leave, …)       |
| `action_routing_rules`| Per-action, per-dept approval level configuration         |
| `action_fallback_rules`| Approver used when the requester is the top-level user   |
| `approval_requests`   | A submitted request                                       |
| `approval_steps`      | Individual approver nodes in an approval chain            |
| `approval_actions`    | Each approver's recorded decision                         |
| `audit_logs`          | Append-only audit trail                                   |

### Key design decisions

* **`dept_levels.is_top_level = True`** marks the protected highest level.
  Department administrators may not edit or remove users at this level.
* **`reporting_lines.is_active`** allows historical line data to be retained
  without affecting live routing.
* **`action_routing_rules`** is a separate table so routing behaviour can be
  configured per-department without changing code.
* **`action_fallback_rules`** enables a configured HR / Dean / Central Admin
  user to receive requests from top-level users who have no higher manager.

---

## Workflow

### Normal staff (non-top-level)

```
Submit request
    │
    ▼
Load action routing rule for (action, dept)
    │
    ▼
Detect circular reporting ──── cycle detected ──► RoutingError
    │
    ▼
requester.dept_level.is_top_level == False
    │
    ▼
Get primary manager (active reporting_line)
    │  no active line ──────────────────────────► RoutingError
    ▼
rule.requires_second_level?
    │ Yes                 │ No
    ▼                     ▼
Get manager's manager   Return [primary]
    │ found
    ▼
Return [primary, second-level]
```

### Top-level user (department head)

```
Submit request
    │
    ▼
requester.dept_level.is_top_level == True
    │
    ▼
Look up action_fallback_rules for (action, dept)
    │  no fallback ─────────────────────────────► RoutingError
    ▼
Return [fallback approver]   (is_fallback=True)
```

---

## Routing Rules

| Action       | `requires_primary` | `requires_second_level` | Result               |
|-------------|-------------------|------------------------|----------------------|
| Annual Leave | ✓                 | ✓                      | Primary + 2nd level  |
| Sick Leave   | ✓                 | ✗                      | Primary only         |

> Rules are stored per-department in `action_routing_rules` so each
> department can have different approval requirements for the same action.

---

## Fallback Rules

When a top-level user (department head) submits a request, no in-department
manager exists.  The `action_fallback_rules` table maps each
`(action, department)` pair to a specific fallback user (HR Officer, Dean,
Central Admin, etc.).

If no fallback rule is configured, `RoutingError` is raised — the system does
not silently lose the request.

---

## Test Case Table

| TC# | User Type   | Action          | Setup                          | Expected Approver Flow                | Pass Criteria                                               |
|-----|-------------|-----------------|--------------------------------|---------------------------------------|-------------------------------------------------------------|
| 1   | Staff       | Annual Leave    | Normal hierarchy               | Primary (senior_lect) + 2nd (dept_head) | 2 steps; step 1 = senior_lect; step 2 = dept_head; no fallback |
| 2   | Staff       | Sick Leave      | Normal hierarchy               | Primary only (senior_lect)            | 1 step; approver = senior_lect; no second-level step        |
| 3   | Dept Head   | Annual Leave    | Fallback rule configured       | Fallback approver (hr_officer)        | 1 step; is_fallback=True; approver = hr_officer             |
| 4   | Dept Head   | Sick Leave      | Fallback rule configured       | Fallback approver (hr_officer)        | 1 step; is_fallback=True; no crash for missing manager      |
| 5   | Staff       | Unknown Action  | Action code does not exist     | Error — action not found              | RoutingError raised; message contains action code           |
| 6   | Dept Head   | Annual Leave    | Fallback rule removed from DB  | Error — no fallback configured        | RoutingError raised; message contains 'fallback'            |
| 7   | Staff       | Annual Leave    | Reporting line deactivated     | Error — primary manager not found     | RoutingError raised; message contains 'primary manager'     |
| 8   | Staff       | Annual Leave    | A→B→C→A cycle in reporting lines | Error — circular reporting          | RoutingError raised; message contains 'circular' or 'cycle' |

---

## Seed Data (used in tests)

```
Department: Computer Science (CS)
  Level 1 — Head of Department  (is_top_level=True)  →  Dr. Head
  Level 2 — Senior Lecturer                           →  Dr. Senior
  Level 3 — Lecturer                                  →  Staff A

Department: Human Resources (HR)
  Level 1 — HR Officer  (fallback approver)           →  HR Officer

Reporting lines (CS):
  Staff A  → Dr. Senior  → Dr. Head  (no further manager)

Actions:
  annual_leave  →  requires_primary=True, requires_second_level=True
  sick_leave    →  requires_primary=True, requires_second_level=False

Fallback rules (CS):
  annual_leave  →  HR Officer
  sick_leave    →  HR Officer
```

---

## Running the Tests

```bash
# Install dependencies
pip install -e ".[dev]"

# Run all tests
python -m pytest tests/ -v

# Run with coverage
python -m pytest tests/ --cov=src --cov-report=term-missing
```

---

## Extensibility Notes

The following features are **not** included in this POC but have been
deliberately kept out of scope (and out of the schema):

* Acting / delegation support
* Project-account leave routing
* Multi-department dual-reporting

The schema and service layer are designed to accommodate these without
breaking changes — adding optional foreign keys and new routing rule rows is
sufficient for most extensions.
