"""
Full test suite for the university reporting-line system POC.

Test Case Table
===============

| # | User Type   | Action          | Expected Approver Flow            | Pass Criteria                                    |
|---|-------------|-----------------|-----------------------------------|--------------------------------------------------|
| 1 | Staff       | Annual Leave    | Primary (senior_lect) + 2nd (dept_head) | 2 steps returned in correct order          |
| 2 | Staff       | Sick Leave      | Primary only (senior_lect)        | 1 step returned; no second-level approver        |
| 3 | Dept Head   | Annual Leave    | Fallback approver (hr_officer)    | 1 fallback step; is_fallback=True                |
| 4 | Dept Head   | Sick Leave      | Fallback approver (hr_officer)    | 1 fallback step; no crash for missing manager    |
| 5 | Staff       | Unknown Action  | Error — no routing rule found     | RoutingError raised with descriptive message     |
| 6 | Dept Head   | Annual Leave    | Error — no fallback configured    | RoutingError raised; system does not crash       |
| 7 | Staff       | Annual Leave    | Error — primary manager not found | RoutingError raised; "primary manager not found" |
| 8 | Staff       | Annual Leave    | Error — circular reporting        | RoutingError raised; cycle detected              |

All tests use an in-memory SQLite database and the seed fixture defined in
conftest.py.
"""

import pytest

from src.models import ActionFallbackRule, ReportingLine
from src.services.routing import RoutingError, build_approval_chain


# ---------------------------------------------------------------------------
# TC-1  Annual Leave for normal staff
# ---------------------------------------------------------------------------


class TestTC1AnnualLeaveNormalStaff:
    """
    TC-1 | Staff | Annual Leave | Expected: primary + second-level approver.

    Input
    -----
    - Requester : staff_a  (Lecturer, rank 3)
    - Action    : annual_leave

    Expected
    --------
    - 2 approval steps
    - Step 1 approver = senior_lect  (primary/direct manager)
    - Step 2 approver = dept_head    (second-level manager)
    - Neither step is a fallback

    Pass Criteria
    -------------
    - chain.steps has length 2
    - step[0].approver == senior_lect
    - step[1].approver == dept_head
    - step[0].is_fallback is False
    - step[1].is_fallback is False
    """

    def test_two_steps_returned(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        assert len(chain.steps) == 2

    def test_primary_approver_is_direct_manager(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        assert chain.steps[0].approver.id == seed["senior_lect"].id

    def test_second_level_approver_is_department_head(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        assert chain.steps[1].approver.id == seed["dept_head"].id

    def test_no_fallback_flags(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        assert chain.steps[0].is_fallback is False
        assert chain.steps[1].is_fallback is False

    def test_steps_ordered_correctly(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        assert chain.steps[0].step_order == 1
        assert chain.steps[1].step_order == 2


# ---------------------------------------------------------------------------
# TC-2  Sick Leave for normal staff
# ---------------------------------------------------------------------------


class TestTC2SickLeaveNormalStaff:
    """
    TC-2 | Staff | Sick Leave | Expected: primary approver only.

    Input
    -----
    - Requester : staff_a
    - Action    : sick_leave

    Expected
    --------
    - 1 approval step
    - Step 1 approver = senior_lect
    - No second-level approver

    Pass Criteria
    -------------
    - chain.steps has length 1
    - step[0].approver == senior_lect
    """

    def test_one_step_returned(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "sick_leave")
        assert len(chain.steps) == 1

    def test_approver_is_direct_manager(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "sick_leave")
        assert chain.steps[0].approver.id == seed["senior_lect"].id

    def test_no_second_level_approver(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["staff_a"].id, "sick_leave")
        assert all(s.step_order != 2 for s in chain.steps)


# ---------------------------------------------------------------------------
# TC-3  Annual Leave for department head (top-level user)
# ---------------------------------------------------------------------------


class TestTC3AnnualLeaveDeptHead:
    """
    TC-3 | Dept Head | Annual Leave | Expected: fallback approver (hr_officer).

    Input
    -----
    - Requester : dept_head  (rank 1 / is_top_level=True)
    - Action    : annual_leave

    Expected
    --------
    - 1 approval step
    - Step is a fallback step
    - Approver = hr_officer

    Pass Criteria
    -------------
    - chain.steps has length 1
    - step[0].is_fallback is True
    - step[0].approver == hr_officer
    """

    def test_one_step_returned(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["dept_head"].id, "annual_leave")
        assert len(chain.steps) == 1

    def test_step_is_fallback(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["dept_head"].id, "annual_leave")
        assert chain.steps[0].is_fallback is True

    def test_fallback_approver_is_hr_officer(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["dept_head"].id, "annual_leave")
        assert chain.steps[0].approver.id == seed["hr_officer"].id


# ---------------------------------------------------------------------------
# TC-4  Sick Leave for department head
# ---------------------------------------------------------------------------


class TestTC4SickLeaveDeptHead:
    """
    TC-4 | Dept Head | Sick Leave | Expected: fallback approver; no crash.

    Input
    -----
    - Requester : dept_head
    - Action    : sick_leave

    Expected
    --------
    - System routes to fallback approver
    - Does not raise an error because the top-level user has no manager

    Pass Criteria
    -------------
    - chain.steps has length 1
    - step[0].is_fallback is True
    - step[0].approver == hr_officer
    """

    def test_fallback_used_not_error(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["dept_head"].id, "sick_leave")
        assert len(chain.steps) == 1
        assert chain.steps[0].is_fallback is True

    def test_fallback_approver_is_hr(self, db_session, seed):
        chain = build_approval_chain(db_session, seed["dept_head"].id, "sick_leave")
        assert chain.steps[0].approver.id == seed["hr_officer"].id


# ---------------------------------------------------------------------------
# TC-5  Missing action rule (unknown action)
# ---------------------------------------------------------------------------


class TestTC5MissingActionRule:
    """
    TC-5 | Staff | Unknown Action | Expected: RoutingError — action not found.

    Input
    -----
    - Requester : staff_a
    - Action    : 'conference_travel'  (does not exist in DB)

    Expected
    --------
    - RoutingError is raised
    - Message mentions the missing action code

    Pass Criteria
    -------------
    - RoutingError raised
    - Error message contains action code or descriptive text
    """

    def test_routing_error_raised(self, db_session, seed):
        with pytest.raises(RoutingError):
            build_approval_chain(db_session, seed["staff_a"].id, "conference_travel")

    def test_error_message_mentions_action(self, db_session, seed):
        with pytest.raises(RoutingError, match="conference_travel"):
            build_approval_chain(db_session, seed["staff_a"].id, "conference_travel")


# ---------------------------------------------------------------------------
# TC-6  Missing fallback rule for top-level user
# ---------------------------------------------------------------------------


class TestTC6MissingFallbackRule:
    """
    TC-6 | Dept Head | Annual Leave | No fallback configured → RoutingError.

    Setup
    -----
    - Remove the annual_leave fallback rule from the CS department.

    Input
    -----
    - Requester : dept_head
    - Action    : annual_leave

    Expected
    --------
    - RoutingError is raised
    - System does not crash; clear error message is returned

    Pass Criteria
    -------------
    - RoutingError raised
    - Error message mentions 'fallback'
    """

    def test_routing_error_when_no_fallback(self, db_session, seed):
        # Remove the fallback rule
        db_session.delete(seed["fb_al"])
        db_session.commit()

        with pytest.raises(RoutingError, match="fallback"):
            build_approval_chain(
                db_session, seed["dept_head"].id, "annual_leave"
            )

    def test_system_does_not_crash(self, db_session, seed):
        db_session.delete(seed["fb_al"])
        db_session.commit()

        try:
            build_approval_chain(db_session, seed["dept_head"].id, "annual_leave")
        except RoutingError:
            pass  # expected — system handled gracefully
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"Unexpected exception type raised: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------------------
# TC-7  User without primary manager
# ---------------------------------------------------------------------------


class TestTC7MissingPrimaryManager:
    """
    TC-7 | Staff | Annual Leave | No active reporting line → RoutingError.

    Setup
    -----
    - Deactivate staff_a's reporting line (set is_active=False).

    Input
    -----
    - Requester : staff_a  (non-top-level, but no active manager)
    - Action    : annual_leave

    Expected
    --------
    - RoutingError raised
    - Error message says primary manager not found

    Pass Criteria
    -------------
    - RoutingError raised
    - Error message contains 'primary manager'
    """

    def test_routing_error_when_no_manager(self, db_session, seed):
        # Deactivate reporting line
        rl: ReportingLine = seed["rl_staff_to_senior"]
        rl.is_active = False
        db_session.commit()

        with pytest.raises(RoutingError, match="[Pp]rimary manager"):
            build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")

    def test_error_is_descriptive(self, db_session, seed):
        rl: ReportingLine = seed["rl_staff_to_senior"]
        rl.is_active = False
        db_session.commit()

        with pytest.raises(RoutingError) as exc_info:
            build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")

        assert "primary manager" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# TC-8  Circular reporting detection
# ---------------------------------------------------------------------------


class TestTC8CircularReporting:
    """
    TC-8 | Staff | Annual Leave | Circular reporting → RoutingError.

    Setup
    -----
    Introduce a cycle:
      staff_a → senior_lect → dept_head → staff_a  (cycle!)

    Input
    -----
    - Requester : staff_a
    - Action    : annual_leave

    Expected
    --------
    - RoutingError raised
    - Error message mentions 'circular' or 'cycle'

    Pass Criteria
    -------------
    - RoutingError raised before an infinite loop
    - Error message contains 'circular' or 'cycle' (case-insensitive)
    """

    def _create_cycle(self, db_session, seed):
        """Make dept_head report back to staff_a, creating a cycle."""
        cycle_rl = ReportingLine(
            user_id=seed["dept_head"].id,
            manager_id=seed["staff_a"].id,
            dept_id=seed["cs_dept"].id,
        )
        db_session.add(cycle_rl)
        db_session.commit()

    def test_routing_error_raised(self, db_session, seed):
        self._create_cycle(db_session, seed)
        with pytest.raises(RoutingError):
            build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")

    def test_error_message_mentions_cycle(self, db_session, seed):
        self._create_cycle(db_session, seed)
        with pytest.raises(RoutingError) as exc_info:
            build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        msg = str(exc_info.value).lower()
        assert "circular" in msg or "cycle" in msg

    def test_does_not_loop_forever(self, db_session, seed):
        """Verify detection terminates without hanging."""
        self._create_cycle(db_session, seed)
        # If this completes (does not timeout), cycle detection works.
        with pytest.raises(RoutingError):
            build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")


# ---------------------------------------------------------------------------
# Integration — submit_request workflow
# ---------------------------------------------------------------------------


class TestApprovalWorkflow:
    """Integration tests for the full submit → decide workflow."""

    def test_submit_annual_leave_creates_request(self, db_session, seed):
        from src.services.approval import submit_request

        req = submit_request(db_session, seed["staff_a"].id, "annual_leave")
        assert req.id is not None
        assert req.status == "pending"
        assert len(req.steps) == 2

    def test_submit_sick_leave_creates_one_step(self, db_session, seed):
        from src.services.approval import submit_request

        req = submit_request(db_session, seed["staff_a"].id, "sick_leave")
        assert len(req.steps) == 1

    def test_approving_all_steps_closes_request(self, db_session, seed):
        from src.services.approval import record_decision, submit_request

        req = submit_request(db_session, seed["staff_a"].id, "sick_leave")
        record_decision(db_session, req.steps[0].id, "approved")
        db_session.refresh(req)
        assert req.status == "approved"

    def test_rejecting_one_step_rejects_request(self, db_session, seed):
        from src.services.approval import record_decision, submit_request

        req = submit_request(db_session, seed["staff_a"].id, "annual_leave")
        record_decision(db_session, req.steps[0].id, "rejected", notes="On leave")
        record_decision(db_session, req.steps[1].id, "approved")
        db_session.refresh(req)
        assert req.status == "rejected"

    def test_fallback_step_is_persisted(self, db_session, seed):
        from src.services.approval import submit_request

        req = submit_request(db_session, seed["dept_head"].id, "annual_leave")
        assert req.steps[0].is_fallback is True

    def test_audit_log_created_on_chain_build(self, db_session, seed):
        from src.models import AuditLog

        build_approval_chain(db_session, seed["staff_a"].id, "annual_leave")
        logs = db_session.query(AuditLog).all()
        assert len(logs) >= 1
        assert any("chain_built" in log.action for log in logs)
