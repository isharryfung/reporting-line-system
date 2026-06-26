"""
Database setup helpers.

Usage (in-memory SQLite for tests / development):

    engine = create_engine("sqlite:///:memory:")
    init_db(engine)
    session = get_session(engine)
"""

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from src.models import Base


def create_engine_sqlite(path: str = ":memory:") -> Engine:
    """Return a SQLite engine.  path=':memory:' gives an in-memory database."""
    url = f"sqlite:///{path}"
    return create_engine(url, echo=False, connect_args={"check_same_thread": False})


def init_db(engine: Engine) -> None:
    """Create all tables defined in the ORM."""
    Base.metadata.create_all(engine)


def get_session(engine: Engine) -> Session:
    """Return a new SQLAlchemy Session bound to *engine*."""
    factory = sessionmaker(bind=engine)
    return factory()
