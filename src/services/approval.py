"""
Approval workflow service.

Provides a high-level API to submit requests and record approver decisions.
Internally delegates routing to the routing service.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from src.models import ApprovalAction, ApprovalRequest, ApprovalStep
from src.services.routing import ApprovalChain, RoutingError, build_approval_chain


def submit_request(
    session: Session,
    requester_id: int,
    action_code: str,
) -> ApprovalRequest:
    """
    Build an approval chain and persist an ApprovalRequest with its steps.

    Returns the persisted ApprovalRequest.

    Raises
    ------
    RoutingError  if the chain cannot be built (propagated from routing service).
    """
    chain: ApprovalChain = build_approval_chain(session, requester_id, action_code)

    request = ApprovalRequest(
        requester_id=requester_id,
        action_id=chain.action.id,
        status="pending",
    )
    session.add(request)
    session.flush()  # get request.id before adding steps

    for chain_step in chain.steps:
        step = ApprovalStep(
            request_id=request.id,
            step_order=chain_step.step_order,
            approver_id=chain_step.approver.id,
            status="pending",
            is_fallback=chain_step.is_fallback,
        )
        session.add(step)

    session.commit()
    return request


def record_decision(
    session: Session,
    step_id: int,
    action_taken: str,
    notes: str | None = None,
) -> ApprovalStep:
    """
    Record an approver's decision on an ApprovalStep.

    Parameters
    ----------
    step_id      : primary key of the ApprovalStep
    action_taken : 'approved' | 'rejected'
    notes        : optional comment

    Returns the updated ApprovalStep.

    Raises
    ------
    ValueError   if the step is not found or already decided.
    RoutingError is not raised here.
    """
    step: ApprovalStep | None = session.get(ApprovalStep, step_id)
    if step is None:
        raise ValueError(f"ApprovalStep id={step_id} not found.")
    if step.status != "pending":
        raise ValueError(
            f"ApprovalStep id={step_id} is already in status {step.status!r}."
        )

    step.status = action_taken

    decision = ApprovalAction(
        step_id=step.id,
        action_taken=action_taken,
        notes=notes,
    )
    session.add(decision)

    # Update parent request status if all steps are resolved
    request: ApprovalRequest = step.request
    all_steps = request.steps
    if all(s.status != "pending" for s in all_steps):
        if any(s.status == "rejected" for s in all_steps):
            request.status = "rejected"
        else:
            request.status = "approved"

    session.commit()
    return step
