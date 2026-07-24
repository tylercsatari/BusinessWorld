#!/usr/bin/env python3
"""Deterministic edge-case contracts for Operations principles analysis."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PATH = (
    ROOT
    / "buildings"
    / "jarvis"
    / "operations-lab"
    / "principles_analysis.py"
)
SPEC = importlib.util.spec_from_file_location("operations_principles_analysis", PATH)
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


def synthetic_fixture():
    rng = np.random.default_rng(6174)
    n = 72
    latent = np.repeat(np.arange(3), n // 3)
    centers_a = np.asarray([
        [3.0, 0.0, 0.0, 0.0, 0.5, 0.0],
        [0.0, 3.0, 0.0, 0.0, 0.0, 0.5],
        [0.0, 0.0, 3.0, 0.5, 0.0, 0.0],
    ])
    centers_b = np.asarray([
        [2.5, 0.0, 0.5, 0.0, 0.0, 0.0, 0.3],
        [0.0, 2.5, 0.0, 0.5, 0.0, 0.0, 0.3],
        [0.0, 0.0, 2.5, 0.0, 0.5, 0.0, 0.3],
    ])
    family_a = MODULE.normalize_rows(
        centers_a[latent] + rng.normal(0, 0.10, size=(n, centers_a.shape[1]))
    )
    family_b = MODULE.normalize_rows(
        centers_b[latent] + rng.normal(0, 0.12, size=(n, centers_b.shape[1]))
    )
    keep = np.asarray([72.0, 82.0, 92.0])[latent] + rng.normal(0, 1.2, n)
    keep_secondary = keep * 0.90 + 8.0 + rng.normal(0, 0.8, n)
    groups = [f"group-{index // 2:02d}" for index in range(n)]
    folds = [f"fold-{(index // 2) % 4}" for index in range(n)]
    texts = [
        (
            "I tested the machine to see what happens"
            if value == 0
            else "This hidden machine changed everything"
            if value == 1
            else "The final result was better than expected"
        )
        for value in latent
    ]
    config = MODULE.PrinciplesConfig(
        k_values=(2, 3),
        seeds=(71, 89),
        min_component_size=6,
        stability_resamples=2,
        stability_fraction=0.80,
        min_stability=0.45,
        dedup_jaccard=0.82,
        min_algorithm_support=2,
        min_resolution_support=1,
        hdbscan_min_cluster_fractions=(0.08,),
        bootstrap_repeats=80,
        regularization_c=0.5,
        calibration_bins=6,
        phrase_min_tokens=1,
        phrase_max_tokens=4,
        phrase_min_document_frequency=2,
    )
    return {
        "embeddings": {"coarse": family_a, "fine": family_b},
        "latent": latent,
        "targets": {"together_keep": keep, "visual_keep": keep_secondary},
        "groups": groups,
        "folds": folds,
        "texts": texts,
        "config": config,
    }


def main() -> None:
    fixture = synthetic_fixture()
    original_embeddings = {
        key: value.copy() for key, value in fixture["embeddings"].items()
    }
    original_targets = {
        key: value.copy() for key, value in fixture["targets"].items()
    }

    discovery_a = MODULE.discover_components(
        fixture["embeddings"],
        fixture["groups"],
        config=fixture["config"],
    )
    discovery_b = MODULE.discover_components(
        fixture["embeddings"],
        fixture["groups"],
        config=fixture["config"],
    )
    assert discovery_a == discovery_b
    assert discovery_a["outcomeBlind"] is True
    assert discovery_a["components"], "clear synthetic structure produced no components"
    assert discovery_a["partitionLedger"]
    assert discovery_a["candidateLedger"]
    assert discovery_a["dedupeLedger"]

    algorithms = {
        row["algorithm"] for row in discovery_a["partitionLedger"]
    }
    assert {
        "spherical_kmeans",
        "gaussian_mixture",
        "agglomerative_cosine",
        "agglomerative_ward",
        "hdbscan",
    }.issubset(algorithms)
    assert all(row["status"] in {"tested", "invalid"} for row in discovery_a["partitionLedger"])
    assert len({
        row["candidateId"] for row in discovery_a["candidateLedger"]
    }) == len(discovery_a["candidateLedger"])
    assert all(
        row["status"] in {"accepted", "deduplicated", "rejected"}
        for row in discovery_a["candidateLedger"]
    )
    assert any(
        row["status"] == "deduplicated"
        for row in discovery_a["candidateLedger"]
    ), "repeated algorithms/seeds were not represented in the dedupe ledger"
    assert all(
        component["algorithmSupport"] >= fixture["config"].min_algorithm_support
        for component in discovery_a["components"]
    )
    assert all(
        candidate["preOutcomeRejectionReasons"] == candidate["rejectionReasons"]
        for candidate in discovery_a["candidateLedger"]
        if candidate["preOutcomeRejectionReasons"]
    )

    # Direct consensus cannot be inflated by transitive A≈B≈C chaining when
    # A and C do not themselves meet the Jaccard contract.
    chain_candidates = []
    for candidate_id, algorithm, members, stability in (
        ("a", "spherical_kmeans", list(range(0, 10)), 0.95),
        ("b", "gaussian_mixture", list(range(2, 12)), 0.90),
        ("c", "agglomerative_cosine", list(range(4, 14)), 0.85),
    ):
        chain_candidates.append({
            "candidateId": candidate_id,
            "resolution": "coarse",
            "algorithm": algorithm,
            "memberIndices": members,
            "membershipHash": candidate_id,
            "n": len(members),
            "prevalence": len(members) / 20,
            "stability": stability,
            "preOutcomeRejectionReasons": [],
        })
    chain_components, _ = MODULE._deduplicate_candidates(
        chain_candidates,
        {"coarse": synthetic_fixture()["embeddings"]["coarse"][:20]},
        20,
        MODULE.PrinciplesConfig(
            k_values=(2,),
            seeds=(1,),
            min_component_size=2,
            stability_resamples=2,
            min_stability=0.5,
            dedup_jaccard=0.60,
            min_algorithm_support=2,
            bootstrap_repeats=40,
        ),
    )
    assert len(chain_components) == 1
    assert chain_components[0]["supportingCandidateIds"] == ["a", "b"]
    assert next(row for row in chain_candidates if row["candidateId"] == "c")[
        "status"
    ] == "rejected"

    inference = MODULE.analyze_component_outcomes(
        discovery_a,
        fixture["targets"],
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    assert inference["multipleTesting"]["dependencySafe"] is True
    assert inference["multipleTesting"]["hypothesisCount"] > 0
    together = inference["targets"]["together_keep"]
    tested = [row for row in together["components"] if row["status"] == "tested"]
    assert tested
    assert any(abs(row["continuous"]["keepDelta"]) > 5 for row in tested)
    assert any(abs(row["keepAtLeast85"]["riskDifference"]) > 0.20 for row in tested)
    for row in tested:
        for section in (row["continuous"], row["keepAtLeast85"]):
            if section["p"] is not None:
                assert 0 <= section["q"] <= 1
            if section["ci95GroupBootstrap"] is not None:
                assert len(section["ci95GroupBootstrap"]) == 2
            consistency = section["foldValidation"]["signConsistency"]
            assert consistency is None or 0 <= consistency <= 1

    conditional = together["conditionalModel"]
    assert conditional["status"] == "ok"
    assert conditional["componentCount"] == len(discovery_a["components"])
    assert conditional["metrics"]["auc"] is not None
    assert conditional["metrics"]["auc"] > 0.80
    assert conditional["metrics"]["prAuc"] > together["eventRate85"]
    assert 0 <= conditional["metrics"]["brier"] <= 1
    assert conditional["metrics"]["logLoss"] >= 0
    assert conditional["metrics"]["calibration"]["bins"]
    discrimination = conditional["withinFoldDiscrimination"]
    assert discrimination["usableFolds"] >= 2
    assert discrimination["auc"] is not None
    assert discrimination["aucBaseline"] == 0.5
    assert np.isclose(
        conditional["incremental"]["auc"],
        discrimination["auc"] - discrimination["aucBaseline"],
    )
    assert len(conditional["oofProbability"]) == len(fixture["texts"])
    assert all(
        value is None or 0 < value < 1
        for value in conditional["oofProbability"]
    )
    assert {
        row["componentId"] for row in conditional["componentEffects"]
    } == {
        row["id"] for row in discovery_a["components"]
    }

    degenerate_difference, degenerate_se, degenerate_p = (
        MODULE._cluster_robust_difference(
            np.asarray([0.0, 0.0, 1.0, 1.0]),
            np.asarray([False, False, True, True]),
            np.asarray(["g0", "g1", "g2", "g3"], dtype=object),
        )
    )
    assert np.isclose(degenerate_difference, 1.0, rtol=0, atol=1e-12)
    assert degenerate_se is None
    assert degenerate_p is None

    reversed_targets = {
        key: value[::-1].copy()
        for key, value in fixture["targets"].items()
    }
    reversed_inference = MODULE.analyze_component_outcomes(
        discovery_a,
        reversed_targets,
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    assert (
        reversed_inference["discoveryFingerprint"]
        == inference["discoveryFingerprint"]
        == discovery_a["discoveryFingerprint"]
    )
    discovery_after_target_change = MODULE.discover_components(
        fixture["embeddings"],
        fixture["groups"],
        config=fixture["config"],
    )
    assert discovery_after_target_change == discovery_a

    by_rows = [{"p": 0.01}, {"p": 0.04}, {"p": 0.03}]
    MODULE.dependency_safe_by(by_rows)
    assert np.allclose(
        [row["q"] for row in by_rows],
        [0.055, 0.07333333333333333, 0.07333333333333333],
    )
    assert MODULE.jaccard_indices([1, 2, 3], [2, 3, 4]) == 0.5
    assert MODULE.jaccard_indices([], []) == 1.0

    phrase_rows_a = MODULE.extract_phrase_candidates(
        fixture["texts"],
        min_tokens=1,
        max_tokens=4,
        min_document_frequency=2,
    )
    phrase_rows_b = MODULE.extract_phrase_candidates(
        fixture["texts"],
        min_tokens=1,
        max_tokens=4,
        min_document_frequency=2,
    )
    assert phrase_rows_a == phrase_rows_b
    assert phrase_rows_a
    assert all(row["documentFrequency"] >= 2 for row in phrase_rows_a)
    assert any(row["text"] == "the machine" for row in phrase_rows_a)

    first_component = discovery_a["components"][0]
    label_phrases = ["unrelated phrase", "best matching phrase", "second match"]
    label_vectors = {}
    for resolution, centroid in first_component["centroidsByResolution"].items():
        center = np.asarray(centroid, dtype=float)
        unrelated = np.roll(center, 1)
        if abs(float(unrelated @ center)) > 0.95:
            unrelated = -center
        second = MODULE.normalize_rows(
            np.vstack([unrelated, center, center + 0.08 * unrelated])
        )
        label_vectors[resolution] = second
    labels = MODULE.select_component_labels(
        {
            **discovery_a,
            "components": [first_component],
        },
        label_phrases,
        label_vectors,
        top_n=2,
    )
    label = labels[first_component["id"]]
    assert label["label"] == "best matching phrase"
    assert len(label["candidates"]) == 2
    assert label["candidates"][0]["cosine"] >= label["candidates"][1]["cosine"]

    full = MODULE.run_principles_analysis(
        fixture["embeddings"],
        fixture["texts"],
        {"together_keep": fixture["targets"]["together_keep"]},
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    assert full["discovery"] == discovery_a
    assert full["phraseCandidates"] == phrase_rows_a
    assert full["inference"]["targets"]["together_keep"]["conditionalModel"]["status"] == "ok"

    constant_target = np.full(len(fixture["texts"]), 70.0)
    constant_result = MODULE.analyze_component_outcomes(
        discovery_a,
        {"constant": constant_target},
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    constant_model = constant_result["targets"]["constant"]["conditionalModel"]
    assert constant_model["status"] == "ok"
    assert constant_model["metrics"]["auc"] is None
    assert constant_model["metrics"]["prAuc"] is None
    assert constant_model["metrics"]["eventRate"] == 0.0
    assert all(
        row["keepAtLeast85"]["lift"] is None
        for row in constant_result["targets"]["constant"]["components"]
        if row["status"] == "tested"
    )

    null_target = np.random.default_rng(2026).permutation(
        fixture["targets"]["together_keep"]
    )
    null_result = MODULE.analyze_component_outcomes(
        discovery_a,
        {"null": null_target},
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    null_tests = [
        section
        for row in null_result["targets"]["null"]["components"]
        if row["status"] == "tested"
        for section in (row["continuous"], row["keepAtLeast85"])
        if section.get("q") is not None
    ]
    assert null_tests
    assert not any(section["q"] <= 0.05 for section in null_tests)

    nan_target = fixture["targets"]["together_keep"].copy()
    nan_target[::7] = np.nan
    nan_result = MODULE.analyze_component_outcomes(
        discovery_a,
        {"partial": nan_target},
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    assert nan_result["targets"]["partial"]["finiteN"] == len(nan_target) - len(nan_target[::7])

    flat = np.ones((24, 5), dtype=float)
    flat = MODULE.normalize_rows(flat)
    flat_config = MODULE.PrinciplesConfig(
        k_values=(2, 3),
        seeds=(11,),
        min_component_size=3,
        stability_resamples=2,
        min_stability=0.0,
        min_algorithm_support=1,
        hdbscan_min_cluster_fractions=(0.20,),
        bootstrap_repeats=40,
    )
    flat_discovery = MODULE.discover_components(
        {"flat": flat},
        [f"flat-{index}" for index in range(len(flat))],
        config=flat_config,
    )
    assert flat_discovery["partitionLedger"]
    assert any(row["status"] == "invalid" for row in flat_discovery["partitionLedger"])
    assert not flat_discovery["components"]

    expect_value_error(
        lambda: MODULE.discover_components(
            {"bad": fixture["embeddings"]["coarse"] * 2},
            fixture["groups"],
            config=fixture["config"],
        ),
        "must be normalized",
    )
    bad_nonfinite = fixture["embeddings"]["coarse"].copy()
    bad_nonfinite[0, 0] = np.nan
    expect_value_error(
        lambda: MODULE.discover_components(
            {"bad": bad_nonfinite},
            fixture["groups"],
            config=fixture["config"],
        ),
        "non-finite",
    )
    expect_value_error(
        lambda: MODULE.discover_components(
            fixture["embeddings"],
            fixture["groups"][:-1],
            config=fixture["config"],
        ),
        "group ID count",
    )
    crossing_folds = fixture["folds"].copy()
    crossing_folds[1] = "different-fold"
    expect_value_error(
        lambda: MODULE.analyze_component_outcomes(
            discovery_a,
            fixture["targets"],
            fixture["groups"],
            crossing_folds,
            config=fixture["config"],
        ),
        "crosses validation folds",
    )
    expect_value_error(
        lambda: MODULE.select_component_labels(
            discovery_a,
            ["duplicate", "duplicate"],
            {"coarse": np.ones((2, fixture["embeddings"]["coarse"].shape[1]))},
        ),
        "must be unique",
    )
    expect_value_error(
        lambda: MODULE.run_principles_analysis(
            fixture["embeddings"],
            fixture["texts"],
            fixture["targets"],
            fixture["groups"],
            fixture["folds"],
            config=fixture["config"],
            phrase_embedding_vectors={
                "coarse": np.ones((1, fixture["embeddings"]["coarse"].shape[1]))
            },
        ),
        "phrase_candidates are required",
    )

    for key, values in original_embeddings.items():
        assert np.array_equal(values, fixture["embeddings"][key])
    for key, values in original_targets.items():
        assert np.array_equal(values, fixture["targets"][key])

    ledger_snapshot = copy.deepcopy(discovery_a["candidateLedger"])
    MODULE.analyze_component_outcomes(
        discovery_a,
        {"different": fixture["targets"]["together_keep"] + 3.0},
        fixture["groups"],
        fixture["folds"],
        config=fixture["config"],
    )
    assert discovery_a["candidateLedger"] == ledger_snapshot

    print(json.dumps({
        "ok": True,
        "partitions": len(discovery_a["partitionLedger"]),
        "rawCandidates": len(discovery_a["candidateLedger"]),
        "components": len(discovery_a["components"]),
        "hypotheses": inference["multipleTesting"]["hypothesisCount"],
        "auc": conditional["metrics"]["auc"],
        "prAuc": conditional["metrics"]["prAuc"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
