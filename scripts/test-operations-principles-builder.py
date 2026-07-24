#!/usr/bin/env python3
"""Focused contracts for the Operations 85% principles orchestrator."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    ROOT
    / "buildings"
    / "jarvis"
    / "operations-lab"
    / "build_principles.py"
)
SPEC = importlib.util.spec_from_file_location("test_build_principles", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def synthetic_vectors(rows: int, dimensions: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    values = rng.normal(size=(rows, dimensions))
    values[: rows // 2, 0] += 2.5
    values[rows // 2 :, 1] += 2.5
    return MODULE.normalize_rows(values)


def test_lineages_and_folds() -> None:
    rows = 30
    vectors = synthetic_vectors(rows, 16, 7)
    vectors[1] = vectors[0]
    vectors[3] = vectors[2]
    hooks = [
        {
            "id": f"h{index}",
            "text": (
                "the same exact hook" if index in (0, 1)
                else f"independent hook {index}"
            ),
            "savedAt": index * 1000,
        }
        for index in range(rows)
    ]
    lineages = MODULE.semantic_lineages(hooks, vectors)
    assert len(lineages["ids"]) == rows
    assert lineages["ids"][0] == lineages["ids"][1]
    assert lineages["groupCount"] < rows
    assert 0 <= lineages["similarityThreshold"] <= 1
    assert lineages["creatorGroupingAvailable"] is False
    assert "not creator-held-out" in lineages["independenceBoundary"]

    folds = MODULE.grouped_time_folds(hooks, lineages["ids"])
    assert len(folds["assignments"]) == rows
    assert len(set(folds["assignments"].tolist())) == folds["foldCount"]
    lineage_folds = {}
    for group, fold in zip(lineages["ids"], folds["assignments"]):
        lineage_folds.setdefault(group, set()).add(int(fold))
    assert all(len(values) == 1 for values in lineage_folds.values())


def test_topic_residualization() -> None:
    rows = 40
    folds = np.asarray([index % 5 for index in range(rows)], dtype=int)
    bundles = {
        key: synthetic_vectors(rows, 18, 100 + index)
        for index, key in enumerate(
            set(MODULE.TOPIC_FAMILIES) | set(MODULE.RESIDUAL_FAMILIES)
        )
    }
    original = {key: values.copy() for key, values in bundles.items()}
    residuals, diagnostics = MODULE.residualize_operations(bundles, folds)
    assert set(residuals) == {
        f"residual__{key}" for key in MODULE.RESIDUAL_FAMILIES
    }
    assert diagnostics["outcomeBlind"] is True
    assert all(values.shape == (rows, 18) for values in residuals.values())
    assert all(
        np.allclose(np.linalg.norm(values, axis=1), 1.0)
        for values in residuals.values()
    )
    assert all(np.array_equal(bundles[key], original[key]) for key in bundles)


def test_effect_contract() -> None:
    target = {
        "status": "tested",
        "n": 20,
        "continuous": {
            "insideMean": 86.0,
            "outsideMean": 80.0,
            "keepDelta": 6.0,
            "ci95GroupBootstrap": [3.0, 8.0],
            "q": 0.01,
            "standardizedEffect": 0.8,
        },
        "keepAtLeast85": {
            "insideRisk": 0.50,
            "outsideRisk": 0.05,
            "baseRisk": 0.10,
            "lift": 5.0,
            "riskRatio": 10.0,
            "riskDifference": 0.45,
            "ci95GroupBootstrap": [0.20, 0.60],
            "p": 0.001,
            "q": 0.02,
            "foldValidation": {
                "signConsistency": 1.0,
                "eligibleFoldCount": 5,
            },
        },
    }
    effect = MODULE.effect_payload(
        target,
        {
            "meanStandardizedLogOddsCoefficient": 0.7,
            "foldSignConsistency": 0.8,
        },
    )
    assert effect["hits"] == 10
    assert effect["riskDifference"] == 0.45
    assert MODULE.evidence_level(effect) == "projected_fold_stable"

    inference = {
        "targets": {
            "together_keep": {
                "components": [
                    {"componentId": "positive", **target},
                    {
                        "componentId": "negative",
                        **{
                            **target,
                            "keepAtLeast85": {
                                **target["keepAtLeast85"],
                                "insideRisk": 0.05,
                                "outsideRisk": 0.50,
                                "riskDifference": -0.45,
                                "ci95GroupBootstrap": [-0.60, -0.20],
                            },
                        },
                    },
                ],
            },
        },
    }
    counts = MODULE.corrected_family_counts(inference, "together_keep")
    assert counts == {
        "testedComponents": 2,
        "correctedPositive": 1,
        "correctedNegative": 1,
    }


def test_quick_artifact_cannot_publish() -> None:
    original_validate = MODULE.validate_artifact
    MODULE.validate_artifact = lambda artifact, ledger: None
    try:
        try:
            MODULE.publish(
                {"source": {"analysisMode": "quick_local"}},
                {"analysisMode": "quick_local"},
            )
        except ValueError as exc:
            assert "cannot replace canonical R2" in str(exc)
        else:
            raise AssertionError("quick artifacts must never publish canonically")
    finally:
        MODULE.validate_artifact = original_validate


def test_shared_visual_projection_and_negation_labels() -> None:
    vectors = np.arange(2 * 1536, dtype=float).reshape(2, 1536)
    expected = vectors.reshape(2, 48, 32).mean(axis=2)
    projected = MODULE.visual_preview48(vectors)
    assert projected.shape == (2, 48)
    assert np.array_equal(projected, expected)
    assert np.array_equal(MODULE.visual_preview48(expected), expected)

    texts = [
        "not visibly established",
        "not visibly established",
        "a clear result appears",
        "a clear result appears",
    ]
    phrases = MODULE.phrase_shortlist(texts, [0, 1])
    assert "not visibly established" in phrases


if __name__ == "__main__":
    test_lineages_and_folds()
    test_topic_residualization()
    test_effect_contract()
    test_quick_artifact_cannot_publish()
    test_shared_visual_projection_and_negation_labels()
    print(
        "operations principles builder tests passed: semantic lineages, "
        "topic residualization, evidence contracts, and shared visual projection"
    )
