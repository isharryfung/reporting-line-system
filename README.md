# reporting-line-system

A proof-of-concept university reporting-line and approval-routing system built with Python and SQLite.

## Quick start

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

## Documentation

See [docs/WORKFLOW.md](docs/WORKFLOW.md) for:
- Architecture overview
- Database schema
- Routing workflow diagrams
- Full test-case table (8 scenarios)

## Structure

```
src/
├── models.py            ORM models (SQLAlchemy)
├── database.py          Engine / session helpers
└── services/
    ├── routing.py       Approval chain routing logic
    └── approval.py      Workflow: submit requests, record decisions

tests/
├── conftest.py          Fixtures and seed data
└── test_routing.py      28 tests covering all 8 test-case scenarios
```
