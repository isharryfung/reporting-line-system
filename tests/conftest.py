import os

import pytest
from sqlalchemy.orm import Session

from src.database import create_engine_sqlite, get_session, init_db
from src.sample_data import seed_sample_data

# Point the manual_test_app singleton at an in-memory DB so tests are isolated
os.environ.setdefault("REPORTING_LINE_DB", ":memory:")


@pytest.fixture()
def db_session() -> Session:
    engine = create_engine_sqlite(":memory:")
    init_db(engine)
    session = get_session(engine)
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def seed(db_session: Session):
    return seed_sample_data(db_session)
