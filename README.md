# reporting-line-system

A proof-of-concept university reporting-line and approval-routing system built with Python and SQLite.

## Quick start

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

## Manual test frontend

Run the browser-based manual test console:

```bash
python -m src.manual_test_app
```

Then open <http://127.0.0.1:8000> and click either:
- **Run this case** on one scenario, or
- **Run all test cases** to execute all 8 routing cases.

## Documentation

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for:
- Architecture overview
- Database schema
- Routing workflow diagrams
- Full test-case table (8 scenarios)
- Manual frontend usage

## Structure

```
src/
├── models.py            ORM models (SQLAlchemy)
├── database.py          Engine / session helpers
├── manual_test_app.py   Standard-library manual test web server
└── services/
    ├── routing.py       Approval chain routing logic
    └── approval.py      Workflow: submit requests, record decisions

frontend/
├── index.html           Manual test console UI
├── app.js               Runs individual/all manual test cases
└── styles.css           Console styling

tests/
├── conftest.py          Fixtures and seed data
├── test_routing.py      28 tests covering all 8 test-case scenarios
└── test_manual_test_app.py Manual frontend scenario runner tests
```
