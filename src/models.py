"""
SQLAlchemy ORM models for the university reporting-line system.

Tables
------
departments         — academic/admin departments
dept_levels         — hierarchy levels within a department (rank 1 = highest)
users               — staff members, each assigned to a dept + level
reporting_lines     — direct manager relationships
actions             — leave / workflow action types (e.g. Annual Leave)
action_routing_rules— per-action approval level configuration
action_fallback_rules—approver used when the requester is the top-level user
approval_requests   — a submitted request for an action
approval_steps      — individual approver nodes in an approval chain
approval_actions    — record of each approver's decision
audit_logs          — append-only audit trail
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Department & levels
# ---------------------------------------------------------------------------


class Department(Base):
    """One department in the university (e.g. Computer Science, HR)."""

    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)

    levels: Mapped[list[DeptLevel]] = relationship(
        "DeptLevel", back_populates="department", cascade="all, delete-orphan"
    )
    users: Mapped[list[User]] = relationship("User", back_populates="department")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Department {self.code!r}>"


class DeptLevel(Base):
    """
    A seniority level within a department.

    level_rank = 1  →  highest level (department head / protected)
    level_rank = 2  →  one level below, etc.

    Only users with level_rank > 1 may be edited / removed by department
    admins. The top level (rank 1) is system-protected.
    """

    __tablename__ = "dept_levels"
    __table_args__ = (UniqueConstraint("dept_id", "level_rank"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    level_rank: Mapped[int] = mapped_column(Integer, nullable=False)
    level_name: Mapped[str] = mapped_column(String(80), nullable=False)
    is_top_level: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    department: Mapped[Department] = relationship("Department", back_populates="levels")
    users: Mapped[list[User]] = relationship("User", back_populates="dept_level")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<DeptLevel dept={self.dept_id} rank={self.level_rank}>"


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


class User(Base):
    """A university staff member."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    dept_level_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("dept_levels.id"), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    department: Mapped[Department] = relationship("Department", back_populates="users")
    dept_level: Mapped[DeptLevel] = relationship(
        "DeptLevel", back_populates="users"
    )
    # reporting lines where this user is the subordinate
    reporting_lines: Mapped[list[ReportingLine]] = relationship(
        "ReportingLine",
        foreign_keys="ReportingLine.user_id",
        back_populates="user",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email!r}>"


# ---------------------------------------------------------------------------
# Reporting lines
# ---------------------------------------------------------------------------


class ReportingLine(Base):
    """
    Represents a direct reporting relationship: user reports to manager.

    is_active = False means the relationship has ended (for history).
    """

    __tablename__ = "reporting_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    manager_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    effective_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    user: Mapped[User] = relationship(
        "User", foreign_keys=[user_id], back_populates="reporting_lines"
    )
    manager: Mapped[User] = relationship("User", foreign_keys=[manager_id])

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ReportingLine user={self.user_id} → manager={self.manager_id}>"


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


class Action(Base):
    """A workflow action type, e.g. Annual Leave, Sick Leave."""

    __tablename__ = "actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)

    routing_rules: Mapped[list[ActionRoutingRule]] = relationship(
        "ActionRoutingRule", back_populates="action", cascade="all, delete-orphan"
    )
    fallback_rules: Mapped[list[ActionFallbackRule]] = relationship(
        "ActionFallbackRule", back_populates="action", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Action {self.code!r}>"


class ActionRoutingRule(Base):
    """
    Defines which approval levels are required for an action within a
    department.

    requires_primary      — must always be True for any real action.
    requires_second_level — True for Annual Leave, False for Sick Leave.
    """

    __tablename__ = "action_routing_rules"
    __table_args__ = (UniqueConstraint("action_id", "dept_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("actions.id"), nullable=False
    )
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    requires_primary: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    requires_second_level: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    action: Mapped[Action] = relationship("Action", back_populates="routing_rules")
    department: Mapped[Department] = relationship("Department")

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ActionRoutingRule action={self.action_id} dept={self.dept_id} "
            f"primary={self.requires_primary} second={self.requires_second_level}>"
        )


class ActionFallbackRule(Base):
    """
    When the requester is the top-level user in the department (no higher
    manager exists), route the approval to this fallback approver instead.

    fallback_user_id — a specific user (e.g. HR Officer, Dean, Central Admin).
    fallback_label   — human-readable label for display / audit.
    """

    __tablename__ = "action_fallback_rules"
    __table_args__ = (UniqueConstraint("action_id", "dept_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    action_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("actions.id"), nullable=False
    )
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    fallback_user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    fallback_label: Mapped[str] = mapped_column(String(120), nullable=False)

    action: Mapped[Action] = relationship("Action", back_populates="fallback_rules")
    department: Mapped[Department] = relationship("Department")
    fallback_user: Mapped[User] = relationship("User")

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ActionFallbackRule action={self.action_id} dept={self.dept_id} "
            f"fallback_user={self.fallback_user_id}>"
        )


# ---------------------------------------------------------------------------
# Approval workflow
# ---------------------------------------------------------------------------


class ApprovalRequest(Base):
    """A staff member's submitted request (e.g. an annual leave application)."""

    __tablename__ = "approval_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requester_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    action_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("actions.id"), nullable=False
    )
    # pending | approved | rejected | error
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    requester: Mapped[User] = relationship("User")
    action: Mapped[Action] = relationship("Action")
    steps: Mapped[list[ApprovalStep]] = relationship(
        "ApprovalStep",
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="ApprovalStep.step_order",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ApprovalRequest id={self.id} requester={self.requester_id} "
            f"action={self.action_id} status={self.status!r}>"
        )


class ApprovalStep(Base):
    """One node in an approval chain (one approver)."""

    __tablename__ = "approval_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_requests.id"), nullable=False
    )
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    approver_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    # pending | approved | rejected
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    is_fallback: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    request: Mapped[ApprovalRequest] = relationship(
        "ApprovalRequest", back_populates="steps"
    )
    approver: Mapped[User] = relationship("User")
    approval_actions: Mapped[list[ApprovalAction]] = relationship(
        "ApprovalAction",
        back_populates="step",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ApprovalStep request={self.request_id} order={self.step_order} "
            f"approver={self.approver_id} status={self.status!r}>"
        )


class ApprovalAction(Base):
    """Records an approver's decision on an ApprovalStep."""

    __tablename__ = "approval_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    step_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_steps.id"), nullable=False
    )
    # approved | rejected | delegated (future extension)
    action_taken: Mapped[str] = mapped_column(String(40), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    taken_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    step: Mapped[ApprovalStep] = relationship(
        "ApprovalStep", back_populates="approval_actions"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ApprovalAction step={self.step_id} action={self.action_taken!r}>"
        )


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------


class AuditLog(Base):
    """Append-only audit trail for all significant system events."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<AuditLog {self.entity_type}/{self.entity_id} {self.action!r}>"
        )
