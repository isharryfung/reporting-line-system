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

Acting/delegation is intentionally not implemented and is documented as a
future enhancement.

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
- Nina — Senior Manager
- Peter — Finance Officer
- Quinn — Payroll Team Finance Officer

Example HR scenario:

- Henry — HR Director (top level)
- Helen — HR Manager and HR Advisory team lead
- Olivia — HR Officer

## Business logic summary

### Routing

1. Load the requester and action.
2. Find the department-specific routing rule for that action.
3. Validate that the requester has at most one active primary manager.
4. Detect circular reporting before building the chain.
5. If the requester is top-level, use the department fallback approver.
6. Otherwise:
   - step 1 = primary manager
   - step 2 = primary manager's primary manager when required
   - if step 2 is missing, use the department fallback approver
7. Reject missing rule, missing primary manager, missing fallback rule, inactive
   user, or inactive manager with explicit errors.

### Team-lead permissions

A team lead may edit reporting-line data only when all conditions are true:

- editor is an active team lead
- target is active
- editor and target share the same org-unit
- target is lower level than the editor
- target is not top-level/protected
- target is not the editor

### Unsupported scope

- acting manager approval
- delegation

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
| BC-01 | Finance staff Annual Leave routing | Requester Peter, action `annual_leave` | Finance Annual Leave requires primary + second-level approval; Peter → Mary → Fiona | Mary then Fiona | Two approval steps are returned in order and neither is fallback |
| BC-02 | Finance staff Sick Leave routing | Requester Peter, action `sick_leave` | Finance Sick Leave requires primary only; Peter → Mary | Mary only | One approval step is returned |
| BC-03 | HR department-specific Annual Leave routing | Requester Olivia, action `annual_leave` | HR Annual Leave is configured differently from Finance and requires primary only; Olivia → Helen | Helen only | HR routing result differs from Finance routing for the same action |
| BC-04 | Finance top-level fallback routing | Requester Fiona, action `annual_leave` | Fiona is Finance top-level user; Finance fallback approver is Henry | Henry as fallback approver | One fallback step is returned |
| BC-05 | Org chart display with org-units and team leads | Department `FIN` | Finance Team and Payroll Team exist; Mary is Finance Team lead | Org chart shows org-units, members, direct managers, and Mary as team lead | UI/API returns Finance Team with Mary in the `team_leads` list |
| BC-06 | Team lead edits lower-level user in same org-unit | Editor Mary, target Peter | Mary is Finance Team lead; Peter is lower-level Finance Team member | Allowed | Permission check returns `allowed = true` |
| BC-07 | Team lead edits same-level user | Editor Mary, target Nina | Mary and Nina are both Senior Managers in Finance Team | Denied | Permission check returns `allowed = false` with lower-level explanation |
| BC-08 | Team lead edits higher-level/protected user | Editor Mary, target Fiona | Fiona is top-level/protected and in Finance Team | Denied | Permission check returns `allowed = false` with protected-user explanation |
| BC-09 | Team lead edits user in another org-unit | Editor Mary, target Quinn | Quinn belongs to Payroll Team, not Finance Team | Denied | Permission check returns `allowed = false` with outside-org-unit explanation |
| BC-10 | Missing action routing rule | Requester Peter, action `training_request` | Action exists but no Finance routing rule exists | Error for missing routing rule | API/service raises clear routing-rule error |
| BC-11 | Missing primary manager | Requester Peter, action `annual_leave` | Peter's active reporting line is deactivated | Error for missing primary manager | API/service raises clear primary-manager error |
| BC-12 | Missing fallback rule | Requester Fiona, action `annual_leave` | Finance fallback rule is removed | Error for missing fallback rule | API/service raises clear fallback error |
| BC-13 | Circular reporting chain | Requester Peter, action `annual_leave` | Extra line Fiona → Peter creates a cycle | Error for circular reporting | API/service raises clear cycle error |
| BC-14 | Inactive manager/user | Requester Peter or inactive requester Peter, action `annual_leave` | Mary is inactive or Peter is inactive | Error for inactive manager/requester | API/service raises clear inactive-user error |
| BC-15 | Multiple active primary managers | Requester Peter, action `annual_leave` | Peter has two active primary reporting lines | Error for multiple active primary managers | API/service raises explicit single-primary-manager error |
| BC-16 | Acting/delegation unsupported | Any acting or delegation request | POC scope excludes acting/delegation | Not supported / future enhancement | No acting/delegation workflow is provided in UI or services |
