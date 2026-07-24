#!/usr/bin/env python3
"""Deterministic contracts for Operations principle transport validation."""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PATH = (
    ROOT
    / "buildings"
    / "jarvis"
    / "operations-lab"
    / "principles_transport.py"
)
SPEC = importlib.util.spec_from_file_location("operations_principles_transport", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def expect_value_error(function, message_fragment: str) -> None:
    try:
        function()
    except ValueError as exc:
        assert message_fragment in str(exc), (message_fragment, str(exc))
    else:
        raise AssertionError(f"expected ValueError containing {message_fragment!r}")


def unit_rows(values: np.ndarray) -> np.ndarray:
    return values / np.linalg.norm(values, axis=1, keepdims=True)


def fixture(observed_rows: int = 36) -> dict:
    rng = np.random.default_rng(419)
    dimensions = 4
    full_dimensions = 9
    centers = unit_rows(np.asarray([
        [4.0, 0.2, 0.1, 0.0],
        [0.1, 4.0, 0.2, 0.0],
        [0.1, 0.2, 4.0, 0.3],
    ]))

    saved_latent = np.repeat(np.arange(3), 12)
    broad_latent = np.repeat(np.arange(3), 24)
    observed_latent = np.resize(np.arange(3), observed_rows)
    saved = unit_rows(
        centers[saved_latent]
        + rng.normal(0, 0.035, size=(len(saved_latent), dimensions))
    )
    broad_shared = unit_rows(
        centers[broad_latent]
        + rng.normal(0, 0.045, size=(len(broad_latent), dimensions))
    )
    observed_shared = unit_rows(
        centers[observed_latent]
        + rng.normal(0, 0.050, size=(len(observed_latent), dimensions))
    )
    broad = np.hstack([
        broad_shared,
        rng.normal(0, 200, size=(len(broad_shared), full_dimensions - dimensions)),
    ])
    observed = np.hstack([
        observed_shared,
        rng.normal(0, 200, size=(len(observed_shared), full_dimensions - dimensions)),
    ])

    saved_keep = np.asarray([92.0, 74.0, 66.0])[saved_latent]
    broad_keep = np.asarray([91.0, 73.0, 64.0])[broad_latent]
    observed_keep = np.asarray([93.0, 72.0, 63.0])[observed_latent]
    broad_ids = [f"broad-{index:03d}" for index in range(len(broad))]
    projected_pairs = list(zip(broad_ids, broad_keep))
    rng.shuffle(projected_pairs)
    broad_projected = dict(projected_pairs[:-3])

    config = MODULE.TransportConfig(
        k_values=(2, 3, 4),
        seeds=(5, 19),
        bootstrap_repeats=100,
        min_effect_rows=4,
        min_threshold_events=2,
        fold_count=4,
        min_match_jaccard=0.25,
        min_match_rows=3,
    )
    return {
        "saved": saved,
        "savedKeep": saved_keep,
        "savedIds": [f"saved-{index:03d}" for index in range(len(saved))],
        "savedGroups": [f"lineage-{index // 2:03d}" for index in range(len(saved))],
        "broad": broad,
        "broadIds": broad_ids,
        "broadGroups": [f"channel-{index % 9}" for index in range(len(broad))],
        "broadProjected": broad_projected,
        "observed": observed,
        "observedKeep": observed_keep,
        "observedIds": [f"observed-{index:03d}" for index in range(len(observed))],
        "observedGroups": [f"account-{index // 6}" for index in range(len(observed))],
        "principles": {
            "alpha visual mechanism": np.where(saved_latent == 0)[0].tolist(),
            "beta visual mechanism": {
                "memberIds": [
                    f"saved-{index:03d}"
                    for index in np.where(saved_latent == 1)[0]
                ]
            },
        },
        "config": config,
    }


def run(data: dict) -> dict:
    return MODULE.validate_principle_transport(
        data["saved"],
        data["savedKeep"],
        data["savedGroups"],
        data["broad"],
        data["broadIds"],
        data["broadGroups"],
        data["observed"],
        data["observedKeep"],
        data["observedGroups"],
        data["principles"],
        broad_projected_keep_by_id=data["broadProjected"],
        saved_ids=data["savedIds"],
        observed_ids=data["observedIds"],
        config=data["config"],
    )


def geometry_projection(result: dict) -> dict:
    return result["geometry"]


def main() -> None:
    data = fixture()
    first = run(data)
    second = run(copy.deepcopy(data))
    assert first == second, "identical inputs must produce byte-equivalent structures"
    assert first["schemaVersion"] == MODULE.SCHEMA_VERSION
    assert first["outcomesAttachedAfterGeometry"] is True
    assert first["claims"] == {
        "causal": False,
        "projectedScoresAreIndependentValidation": False,
        "observedScoresAreExternalDiagnostics": True,
        "observedScoresAreExternalReplication": False,
    }

    geometry = first["geometry"]
    assert geometry["outcomeBlind"] is True
    assert geometry["sharedDimensions"] == data["saved"].shape[1]
    assert geometry["sources"]["saved"]["rows"] == len(data["saved"])
    assert geometry["sources"]["broad"]["rows"] == len(data["broad"])
    assert geometry["sources"]["observed"]["rows"] == len(data["observed"])
    tested = [
        row for row in geometry["partitionLedger"] if row["status"] == "tested"
    ]
    assert tested
    assert {
        row["algorithm"] for row in tested
    } == {"spherical_kmeans", "farthest_anchor_voronoi"}
    assert all(row["outcomeBlind"] is True for row in tested)
    for principle in geometry["principles"].values():
        assert principle["selectedMatch"]["jaccard"] > 0.70
        assert principle["selectedMatch"]["transportEligible"] is True
        assert principle["matchLedger"]
        assert principle["geometryPrevalence"]["broad"]["ci95GroupedBootstrap"]

    # Outcomes are never available to geometry. Permuting every outcome changes
    # associations, but the full partition and match structure remains exact.
    permuted = copy.deepcopy(data)
    permuted["savedKeep"] = permuted["savedKeep"][::-1].copy()
    projected_values = list(permuted["broadProjected"].values())[::-1]
    permuted["broadProjected"] = dict(zip(
        permuted["broadProjected"].keys(), projected_values
    ))
    permuted["observedKeep"] = permuted["observedKeep"][::-1].copy()
    permuted_result = run(permuted)
    assert geometry_projection(permuted_result) == geometry_projection(first)
    assert (
        permuted_result["principles"]["alpha visual mechanism"]
        ["observedActualKeep"]["continuous"]["meanDifference"]
        != first["principles"]["alpha visual mechanism"]
        ["observedActualKeep"]["continuous"]["meanDifference"]
    )

    # The unused raw tail cannot affect shared 48D-style geometry.
    changed_tail = copy.deepcopy(data)
    changed_tail["broad"][:, data["saved"].shape[1]:] *= -12345
    changed_tail["observed"][:, data["saved"].shape[1]:] += 987654
    tail_result = run(changed_tail)
    assert geometry_projection(tail_result) == geometry_projection(first)

    # Broad rows may arrive in any order. Exact IDs, not positions, govern the
    # projected score join and canonical geometry order.
    reordered = copy.deepcopy(data)
    permutation = np.random.default_rng(73).permutation(len(data["broad"]))
    reordered["broad"] = reordered["broad"][permutation]
    reordered["broadIds"] = [reordered["broadIds"][index] for index in permutation]
    reordered["broadGroups"] = [
        reordered["broadGroups"][index] for index in permutation
    ]
    reordered_result = run(reordered)
    assert reordered_result == first
    broad_source = first["outcomeSources"]["broadProjected"]
    assert broad_source["joinedByExactIdRows"] == len(data["broadProjected"])
    assert broad_source["missingBroadIds"] == 3
    assert broad_source["extraMappingIds"] == 0

    alpha = first["principles"]["alpha visual mechanism"]
    assert alpha["evidenceTier"] == "observed_directional_consistency"
    assert (
        alpha["broadProjectedSurrogate"]["evidenceTag"]
        == "circular_projected_surrogate_transport"
    )
    assert (
        alpha["observedActualKeep"]["evidenceTag"]
        == "observed_actual_keep_diagnostic"
    )
    assert alpha["broadProjectedSurrogate"]["causal"] is False
    assert alpha["observedActualKeep"]["causal"] is False
    assert alpha["observedActualKeep"]["continuous"]["meanDifference"] > 15
    assert (
        alpha["observedActualKeep"]["keepAtLeast85"]["riskDifference"] > 0.50
    )
    assert (
        alpha["broadProjectedSurrogate"]["continuous"]
        ["ci95GroupedBootstrap"] is not None
    )
    assert (
        alpha["observedActualKeep"]["continuous"]
        ["foldSignConsistency"]["consistentFraction"] == 1.0
    )
    assert (
        alpha["observedActualKeep"]["directionalConsistencyWithSaved"]["passes"]
        is True
    )
    assert (
        alpha["observedActualKeep"]["directionalConsistencyWithSaved"]
        ["replicationClaim"] is False
    )
    assert (
        alpha["observedActualKeep"]["continuous"]["bootstrapValidRepeats"]
        >= alpha["observedActualKeep"]["continuous"]["bootstrapRequiredRepeats"]
    )

    too_few_groups = copy.deepcopy(data)
    too_few_groups["observedGroups"] = [
        f"account-{index % 3}" for index in range(len(data["observed"]))
    ]
    too_few_result = run(too_few_groups)
    assert (
        too_few_result["principles"]["alpha visual mechanism"]
        ["observedActualKeep"]["directionalConsistencyWithSaved"]["passes"]
        is False
    )

    # Small observed samples remain a valid geometry result with an explicit
    # insufficient-support outcome, rather than an exception or inflated tier.
    sparse = fixture(observed_rows=5)
    sparse["config"] = MODULE.TransportConfig(
        k_values=(2, 3),
        seeds=(5, 19),
        bootstrap_repeats=60,
        min_effect_rows=4,
        min_threshold_events=2,
        fold_count=3,
        min_match_jaccard=0.20,
        min_match_rows=2,
    )
    sparse_result = run(sparse)
    sparse_alpha = sparse_result["principles"]["alpha visual mechanism"]
    assert sparse_alpha["observedActualKeep"]["status"] == "insufficient_support"
    assert sparse_alpha["evidenceTier"] == "circular_surrogate_transport"
    assert (
        sparse_alpha["observedActualKeep"]["keepAtLeast85"]["status"]
        == "insufficient_support"
    )

    # A weak best-of-many shared-space match cannot expose broad or observed
    # outcome diagnostics, even when those outcomes are strongly separated.
    ineligible = fixture()
    ineligible["config"] = MODULE.TransportConfig(
        k_values=(2, 3, 4),
        seeds=(5, 19),
        bootstrap_repeats=60,
        min_effect_rows=4,
        min_threshold_events=2,
        min_match_jaccard=0.99,
        min_match_rows=20,
        min_match_precision=0.99,
        min_match_recall=0.99,
        min_robust_partitions=6,
    )
    ineligible_result = run(ineligible)
    ineligible_alpha = ineligible_result["principles"]["alpha visual mechanism"]
    assert ineligible_alpha["evidenceTier"] == "geometry_only"
    assert (
        ineligible_alpha["broadProjectedSurrogate"]["status"]
        == "transport_ineligible"
    )
    assert (
        ineligible_alpha["observedActualKeep"]["status"]
        == "transport_ineligible"
    )

    # Alignment failures are loud: projected scores cannot be positional,
    # dimensions cannot be shorter than saved previews, and IDs cannot repeat.
    expect_value_error(
        lambda: MODULE.validate_principle_transport(
            data["saved"],
            data["savedKeep"],
            data["savedGroups"],
            data["broad"],
            data["broadIds"],
            data["broadGroups"],
            data["observed"],
            data["observedKeep"],
            data["observedGroups"],
            data["principles"],
            broad_projected_keep_by_id=np.asarray(
                list(data["broadProjected"].values())
            ),
            saved_ids=data["savedIds"],
            observed_ids=data["observedIds"],
            config=data["config"],
        ),
        "mapping joined by exact ID",
    )
    duplicate_ids = data["broadIds"].copy()
    duplicate_ids[-1] = duplicate_ids[0]
    broken = copy.deepcopy(data)
    broken["broadIds"] = duplicate_ids
    expect_value_error(lambda: run(broken), "broad IDs must be unique")
    short_dimensions = copy.deepcopy(data)
    short_dimensions["observed"] = short_dimensions["observed"][:, :2]
    expect_value_error(
        lambda: run(short_dimensions),
        "at least 4 are required",
    )
    overlapping_observed = copy.deepcopy(data)
    overlapping_observed["observedIds"][0] = overlapping_observed["savedIds"][0]
    expect_value_error(
        lambda: run(overlapping_observed),
        "exact-ID disjoint",
    )

    print(
        "operations principles transport tests passed: "
        f"{len(tested)} partitions, "
        f"{len(first['principles'])} principles, "
        "outcome-blind geometry and exact-ID joins verified"
    )


if __name__ == "__main__":
    main()
