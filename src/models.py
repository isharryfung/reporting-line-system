"""
SQLAlchemy ORM models for the university reporting-line system.

Tables
------
departments                — department master data
dept_levels                — hierarchy levels within a department
org_units                  — teams / org-units owned by a department
org_unit_memberships       — user membership and team-lead assignments in org-units
users                      — staff members assigned to a department and level
reporting_lines            — direct reporting relationships
actions                    — action types such as Annual Leave and Sick Leave
action_routing_rules       — department-specific routing rules for each action
department_fallback_rules  — department-level fallback approvers
approval_requests          — submitted workflow requests
approval_steps             — generated approval steps
approval_actions           — approver decisions
audit_logs                 — append-only audit trail
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


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(20), nullable=False, unique=True)

    levels: Mapped[list[DeptLevel]] = relationship(
        "DeptLevel", back_populates="department", cascade="all, delete-orphan"
    )
    org_units: Mapped[list[OrgUnit]] = relationship(
        "OrgUnit", back_populates="department", cascade="all, delete-orphan"
    )
    users: Mapped[list[User]] = relationship("User", back_populates="department")
    fallback_rules: Mapped[list[DepartmentFallbackRule]] = relationship(
        "DepartmentFallbackRule",
        back_populates="department",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Department {self.code!r}>"


class DeptLevel(Base):
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


class OrgUnit(Base):
    __tablename__ = "org_units"
    __table_args__ = (UniqueConstraint("dept_id", "code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)

    department: Mapped[Department] = relationship("Department", back_populates="org_units")
    memberships: Mapped[list[OrgUnitMembership]] = relationship(
        "OrgUnitMembership",
        back_populates="org_unit",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<OrgUnit {self.code!r}>"


class User(Base):
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
    dept_level: Mapped[DeptLevel] = relationship("DeptLevel", back_populates="users")
    org_unit_memberships: Mapped[list[OrgUnitMembership]] = relationship(
        "OrgUnitMembership",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    reporting_lines: Mapped[list[ReportingLine]] = relationship(
        "ReportingLine",
        foreign_keys="ReportingLine.user_id",
        back_populates="user",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email!r}>"


class OrgUnitMembership(Base):
    __tablename__ = "org_unit_memberships"
    __table_args__ = (UniqueConstraint("org_unit_id", "user_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_unit_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("org_units.id"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    is_team_lead: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    org_unit: Mapped[OrgUnit] = relationship("OrgUnit", back_populates="memberships")
    user: Mapped[User] = relationship("User", back_populates="org_unit_memberships")

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<OrgUnitMembership org_unit={self.org_unit_id} user={self.user_id} "
            f"team_lead={self.is_team_lead}>"
        )


class ReportingLine(Base):
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
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
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
        return (
            f"<ReportingLine user={self.user_id} → manager={self.manager_id} "
            f"primary={self.is_primary} active={self.is_active}>"
        )


class Action(Base):
    __tablename__ = "actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)

    routing_rules: Mapped[list[ActionRoutingRule]] = relationship(
        "ActionRoutingRule", back_populates="action", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Action {self.code!r}>"


class ActionRoutingRule(Base):
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


class DepartmentFallbackRule(Base):
    __tablename__ = "department_fallback_rules"
    __table_args__ = (UniqueConstraint("dept_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dept_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=False
    )
    fallback_user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    fallback_label: Mapped[str] = mapped_column(String(120), nullable=False)

    department: Mapped[Department] = relationship(
        "Department", back_populates="fallback_rules"
    )
    fallback_user: Mapped[User] = relationship("User")

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<DepartmentFallbackRule dept={self.dept_id} "
            f"fallback_user={self.fallback_user_id}>"
        )


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requester_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    action_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("actions.id"), nullable=False
    )
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
    __tablename__ = "approval_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    request_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_requests.id"), nullable=False
    )
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    approver_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
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
    __tablename__ = "approval_actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    step_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_steps.id"), nullable=False
    )
    action_taken: Mapped[str] = mapped_column(String(40), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    taken_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )

    step: Mapped[ApprovalStep] = relationship(
        "ApprovalStep", back_populates="approval_actions"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ApprovalAction step={self.step_id} action={self.action_taken!r}>"


class AuditLog(Base):
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
        return f"<AuditLog {self.entity_type}/{self.entity_id} {self.action!r}>"
