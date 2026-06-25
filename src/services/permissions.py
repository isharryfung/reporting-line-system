"""Team-lead permission checks."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from src.models import OrgUnitMembership, User


@dataclass
class PermissionDecision:
    allowed: bool
    reason: str


def validate_team_lead_edit_permission(
    session: Session,
    editor_id: int,
    target_user_id: int,
) -> PermissionDecision:
    editor = session.get(User, editor_id)
    target = session.get(User, target_user_id)

    if editor is None or not editor.is_active:
        return PermissionDecision(False, "Editor not found or inactive.")
    if target is None or not target.is_active:
        return PermissionDecision(False, "Target user not found or inactive.")
    if editor.id == target.id:
        return PermissionDecision(False, "Team leads cannot edit themselves.")

    lead_memberships = (
        session.query(OrgUnitMembership)
        .filter(
            OrgUnitMembership.user_id == editor.id,
            OrgUnitMembership.is_team_lead.is_(True),
            OrgUnitMembership.is_active.is_(True),
        )
        .all()
    )
    if not lead_memberships:
        return PermissionDecision(False, "Editor is not an active team lead.")

    target_memberships = (
        session.query(OrgUnitMembership)
        .filter(
            OrgUnitMembership.user_id == target.id,
            OrgUnitMembership.is_active.is_(True),
        )
        .all()
    )
    lead_org_unit_ids = {membership.org_unit_id for membership in lead_memberships}
    if not any(
        membership.org_unit_id in lead_org_unit_ids for membership in target_memberships
    ):
        return PermissionDecision(
            False, "Target user is outside the team lead's org-unit."
        )

    if target.dept_level.is_top_level:
        return PermissionDecision(
            False, "Protected highest-level users cannot be edited."
        )

    if target.dept_level.level_rank <= editor.dept_level.level_rank:
        return PermissionDecision(
            False,
            "Team leads may edit only lower-level users in the same org-unit.",
        )

    return PermissionDecision(
        True,
        "Allowed: editor is the team lead of the same org-unit and the target is lower level.",
    )
