"""Unit tests for aws_instances module."""
import pytest
from agents.tools.aws_instances import (
    get_instance_specs,
    compute_efficiency_score,
    efficiency_label,
    suggest_right_sized_instance,
    CANDIDATE_FAMILIES_V1,
)


def test_get_instance_specs_known():
    specs = get_instance_specs("t3.xlarge")
    assert specs is not None
    assert specs["vcpu"] == 4
    assert specs["ram_gb"] == 16.0
    assert specs["family"] == "t3"


def test_get_instance_specs_unknown():
    assert get_instance_specs("z99.mega") is None


def test_compute_efficiency_score_normal():
    score = compute_efficiency_score(20.0, 30.0)
    assert score == 25  # (20*0.5 + 30*0.5) = 25


def test_compute_efficiency_score_none():
    assert compute_efficiency_score(None, 30.0) == 0
    assert compute_efficiency_score(20.0, None) == 0


def test_efficiency_label_over_provisioned():
    assert efficiency_label(20, 20.0, 20.0) == "over-provisioned"


def test_efficiency_label_right_sized():
    assert efficiency_label(50, 50.0, 50.0) == "right-sized"


def test_efficiency_label_under_provisioned():
    assert efficiency_label(80, 80.0, 80.0) == "under-provisioned"


def test_efficiency_label_unknown():
    assert efficiency_label(0, None, None) == "unknown"


def test_suggest_right_sized_already_optimal():
    # t3.nano is the smallest — should be already right-sized
    prices = {"t3.nano": 3.80, "t3.micro": 7.59, "t3.small": 15.18}
    result = suggest_right_sized_instance(5.0, 5.0, "t3.nano", prices)
    assert result["already_right_sized"] is True


def test_suggest_right_sized_downsizes():
    # r5.xlarge at 5% CPU and 5% RAM should suggest something much smaller
    # Build a minimal prices dict with a cheap small instance
    prices = {
        "t3.nano": 3.80,
        "t3.micro": 7.59,
        "t3.small": 15.18,
        "t3.medium": 30.37,
        "t3.large": 60.74,
        "t3.xlarge": 121.47,
        "r5.xlarge": 182.50,
    }
    result = suggest_right_sized_instance(5.0, 5.0, "r5.xlarge", prices)
    assert result["already_right_sized"] is False
    assert result["suggested"] != "r5.xlarge"


def test_candidate_families_v1():
    assert "t3" in CANDIDATE_FAMILIES_V1
    assert "m5" in CANDIDATE_FAMILIES_V1
    assert "r5" in CANDIDATE_FAMILIES_V1
    # v2 families should NOT be in v1
    assert "m6i" not in CANDIDATE_FAMILIES_V1
    assert "t4g" not in CANDIDATE_FAMILIES_V1
