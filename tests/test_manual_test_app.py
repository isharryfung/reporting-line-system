"""Tests for the manual test frontend scenario runner."""

from src.manual_test_app import public_test_cases, run_all_manual_test_cases, run_manual_test_case


def test_public_test_cases_contains_all_manual_cases():
    cases = public_test_cases()
    assert len(cases) == 8
    assert cases[0]["id"] == "TC-1"
    assert "setup_fn" not in cases[0]
    assert "expected" not in cases[0]


def test_each_manual_test_case_passes():
    results = run_all_manual_test_cases()
    assert len(results) == 8
    assert all(result["passed"] for result in results)


def test_manual_test_case_success_payload_contains_actual_steps():
    result = run_manual_test_case("TC-1")
    assert result["passed"] is True
    assert result["actual"]["status"] == "success"
    assert [step["approver"] for step in result["actual"]["steps"]] == [
        "Dr. Senior",
        "Dr. Head",
    ]


def test_manual_test_case_error_payload_contains_error_message():
    result = run_manual_test_case("TC-7")
    assert result["passed"] is True
    assert result["actual"]["status"] == "error"
    assert "primary manager" in result["actual"]["error"].lower()


def test_unknown_manual_test_case_returns_not_found():
    result = run_manual_test_case("TC-99")
    assert result["passed"] is False
    assert result["status"] == "not_found"
