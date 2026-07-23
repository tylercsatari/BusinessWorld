#!/usr/bin/env python3
"""Focused contract tests for the leakage-safe Predictor Lab artifact."""

from __future__ import annotations

import hashlib
import importlib.util
import inspect
import itertools
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "buildings" / "jarvis" / "predictor-lab" / "run_predictor_lab.py"
RESULT_PATH = ROOT / "buildings" / "jarvis" / "predictor-lab" / "results.json"

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
spec = importlib.util.spec_from_file_location("predictor_lab_under_test", RUNNER_PATH)
assert spec and spec.loader, f"could not load {RUNNER_PATH}"
predictor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(predictor)


def assert_formula(formula: dict) -> None:
    assert isinstance(formula.get("intercept"), (int, float))
    assert formula.get("targetUnit")
    assert formula.get("plainEnglish")
    terms = formula.get("terms")
    assert isinstance(terms, list) and terms, "the deployable formula must persist at least one term"
    for term in terms:
        assert set(("feature", "weight", "median", "mean", "scale")) <= set(term)
        assert term["feature"]
        for key in ("weight", "median", "mean", "scale"):
            assert isinstance(term[key], (int, float)), f"{term['feature']} is missing numeric {key}"
        assert term["scale"] > 0, f"{term['feature']} has a non-positive training scale"


def assert_target_contract(target: dict, target_name: str) -> None:
    required = {
        "label",
        "population",
        "primaryValidation",
        "prospectiveValidation",
        "prospectiveMetrics",
        "decisionStatus",
        "n",
        "metrics",
        "contentOnlyMetrics",
        "withinSourceMetrics",
        "sourceSummary",
        "calibration",
        "folds",
        "points",
        "formula",
        "allInputsMetrics",
        "allInputsFormula",
        "stressTests",
        "warning",
    }
    assert required <= set(target), f"{target_name} is missing {sorted(required - set(target))}"
    assert "retrospective" in target["primaryValidation"].lower()
    assert "published earlier" in target["prospectiveValidation"].lower()
    assert isinstance(target["prospectiveMetrics"], dict)
    assert target["decisionStatus"] in {
        "not prospectively validated",
        "positive partial forward-time evidence",
    }
    assert isinstance(target["metrics"], dict)
    assert "within each observed source" in target["withinSourceMetrics"]["method"]
    assert isinstance(target["folds"], list)
    assert isinstance(target["points"], list)
    assert_formula(target["formula"])
    assert isinstance(target["allInputsMetrics"], dict)
    assert_formula(target["allInputsFormula"])
    assert isinstance(target["allInputsFormula"].get("alpha"), (int, float))

    stress_tests = target["stressTests"]
    assert isinstance(stress_tests, list) and len(stress_tests) >= 1
    expected_label = "Unseen-account transfer" if target_name == "keep" else "Unseen-channel transfer"
    expected_fold_key = "heldOutAccount" if target_name == "keep" else "heldOutChannel"
    stress = next((item for item in stress_tests if item.get("label") == expected_label), None)
    assert stress is not None
    assert stress.get("label") == expected_label
    assert "entire" in stress.get("description", "").lower()
    assert isinstance(stress.get("metrics"), dict)
    assert isinstance(stress.get("folds"), list)

    for fold in target["folds"]:
        assert "heldOutFold" in fold, "operational folds must hold out videos within known groups"
        assert expected_fold_key not in fold, "operational folds must not masquerade as transfer folds"
    for fold in stress["folds"]:
        assert expected_fold_key in fold, "transfer stress folds must name the wholly unseen group"
        assert "heldOutFold" not in fold, "unseen-group stress folds must stay separate from operational folds"


def assert_result_contract(result: dict, candidate_hash: str) -> None:
    top_level = {
        "version",
        "generatedAt",
        "elapsedSeconds",
        "coverage",
        "artifactState",
        "provenance",
        "experimentRegistry",
        "validationRules",
        "targets",
        "corpusBenchmark",
        "excludedInputs",
    }
    assert top_level <= set(result), f"result is missing {sorted(top_level - set(result))}"

    coverage = result["coverage"]
    coverage_keys = {
        "scienceCenterStoredShorts",
        "embedded",
        "embeddedTotalIncludingPrivate",
        "visualCoverage",
        "remainingVisual",
        "privateRetentionRows",
        "savedChannelRows",
        "savedChannels",
    }
    assert coverage_keys <= set(coverage)
    assert set(coverage["embedded"]) == {"visual", "text", "together"}
    assert set(coverage["embeddedTotalIncludingPrivate"]) == {"visual", "text", "together"}
    assert 0 <= coverage["visualCoverage"] <= 1
    assert coverage["remainingVisual"] >= 0
    assert (
        coverage["embeddedTotalIncludingPrivate"]["visual"] >= coverage["embedded"]["visual"]
    ), "private/non-Science embeddings must not inflate Science Center coverage"
    artifact_state = result["artifactState"]
    assert artifact_state["state"] in {"partial", "complete"}
    assert artifact_state["complete"] is (artifact_state["state"] == "complete")
    assert isinstance(artifact_state["corpusBenchmarkPresent"], bool)
    assert isinstance(artifact_state["canonicalBackfillComplete"], bool)

    registry = result["experimentRegistry"]
    assert registry["evaluatedPerSelection"] == 50_000
    assert registry["candidateHash"] == candidate_hash
    assert registry["featureCount"] == 45
    assert registry["subsetSizes"] == {
        "1": 45,
        "2": 990,
        "3": 14190,
        "4": 34775,
    }
    assert registry["targets"]["keep"]["featureCount"] == 45
    assert registry["targets"]["views"]["featureCount"] == 45
    assert registry["targets"]["keep"]["candidateHash"] == candidate_hash
    assert sum(registry["targets"]["views"]["subsetSizes"].values()) == 50_000

    provenance = result["provenance"]
    assert provenance["savedAxisTrainingIdOverlap"] == 0
    assert len(provenance["featureContractSha256"]) == 64
    assert len(provenance["savedVideoIdHash"]) == 64
    assert len(provenance["rawAxisCorpusIdHash"]) == 64
    assert provenance["featureScorerVersionPersistedPerVideo"] is False
    assert "scorer/model version" in provenance["warning"]
    assert provenance["sourceArtifacts"]
    assert set(provenance["rawStoreShape"]) == {"visual", "text", "together"}
    assert provenance["runtime"]["scikitLearn"]

    rules = result["validationRules"]
    assert isinstance(rules, list) and len(rules) >= 8
    joined_rules = "\n".join(rules).lower()
    for required_rule in (
        "no target-aligned keep or ret5 score",
        "retrospective interpolation",
        "forward-time and whole-source tests",
        "creator-group training folds",
        "outer-training empirical residual",
        "likes and comments are excluded",
        "missing speech is never silently treated",
        "current snapshots",
    ):
        assert required_rule in joined_rules, f"missing leakage/provenance rule: {required_rule}"

    assert set(result["targets"]) == {"keep", "views"}
    assert_target_contract(result["targets"]["keep"], "keep")
    assert_target_contract(result["targets"]["views"], "views")


# The candidate search is hash-locked, unique, exhaustive through three inputs,
# and deterministically sampled at four inputs to reach exactly 50,000.
first_registry = predictor.candidate_registry(len(predictor.PRIVATE_FEATURE_NAMES))
second_registry = predictor.candidate_registry(len(predictor.PRIVATE_FEATURE_NAMES))
assert len(predictor.PRIVATE_FEATURE_NAMES) == 45
assert len(first_registry) == predictor.EXPERIMENT_COUNT == 50_000
assert first_registry == second_registry
assert len(set(first_registry)) == 50_000
assert all(tuple(sorted(candidate)) == candidate for candidate in first_registry)
assert all(len(set(candidate)) == len(candidate) for candidate in first_registry)
assert all(0 <= index < 45 for candidate in first_registry for index in candidate)
subset_sizes = Counter(map(len, first_registry))
assert subset_sizes == {1: 45, 2: 990, 3: 14190, 4: 34775}
assert set(first_registry[:45]) == set(itertools.combinations(range(45), 1))
candidate_hash = hashlib.sha256(json.dumps(first_registry).encode()).hexdigest()[:16]
assert candidate_hash == "a3d4ad284c40c669", "the deterministic experiment registry changed"


# Coverage counts only stored vertical Science Center Shorts, while totals retain
# private/non-Science rows so an accidental denominator change is caught.
library_fixture = {
    "science-a": {
        "videoId": "science-a",
        "stored": True,
        "width": 1080,
        "height": 1920,
        "durationSec": 30,
    },
    "science-b": {
        "videoId": "science-b",
        "stored": True,
        "width": 720,
        "height": 1280,
        "durationSec": 180,
    },
    "horizontal": {
        "videoId": "horizontal",
        "stored": True,
        "width": 1920,
        "height": 1080,
        "durationSec": 30,
    },
    "too-long": {
        "videoId": "too-long",
        "stored": True,
        "width": 1080,
        "height": 1920,
        "durationSec": 181,
    },
    "not-stored": {
        "videoId": "not-stored",
        "stored": False,
        "width": 1080,
        "height": 1920,
        "durationSec": 30,
    },
}
stores_fixture = {
    "visual": {
        "ids": ["science-a", "private-only"],
        "mine": [False, True],
        "vectors": predictor.np.zeros((2, 8), dtype=float),
    },
    "text": {
        "ids": ["science-a", "science-b", "private-only"],
        "mine": [False, False, True],
        "vectors": predictor.np.zeros((3, 8), dtype=float),
    },
    "together": {
        "ids": ["science-b"],
        "mine": [False],
        "vectors": predictor.np.zeros((1, 8), dtype=float),
    },
}
coverage = predictor.coverage_payload(
    stores_fixture,
    library_fixture,
    [{"id": "p1"}, {"id": "p2"}],
    [{"channel": "c1"}, {"channel": "c1"}, {"channel": "c2"}],
)
assert coverage == {
    "scienceCenterStoredShorts": 2,
    "embedded": {"visual": 1, "text": 2, "together": 1},
    "embeddedTotalIncludingPrivate": {"visual": 2, "text": 3, "together": 1},
    "visualCoverage": 0.5,
    "remainingVisual": 1,
    "privateRetentionRows": 2,
    "savedChannelRows": 3,
    "savedChannels": 2,
}


# A production formula must include every value needed to replay its exact
# training-time imputation and standardization, not only a feature list.
formula = predictor.make_formula(
    {
        "indices": [0, 2],
        "intercept": 7.125,
        "coefficients": [0.75, -1.5],
        "medians": [11.0, 22.0],
        "means": [12.0, 23.0],
        "scales": [2.0, 4.0],
    },
    ["visual.keep", "text.present", "together.views"],
    "synthetic target",
)
assert formula == {
    "targetUnit": "synthetic target",
    "intercept": 7.125,
    "terms": [
        {
            "feature": "visual.keep",
            "weight": 0.75,
            "median": 11.0,
            "mean": 12.0,
            "scale": 2.0,
        },
        {
            "feature": "together.views",
            "weight": -1.5,
            "median": 22.0,
            "mean": 23.0,
            "scale": 4.0,
        },
    ],
    "plainEnglish": "intercept + sum(weight × standardized feature); missing values use the training-fold median",
}
assert_formula(formula)


# Factor error and tail probability names must match the statistics actually
# stored in the artifact.
factor_metrics = predictor.log_view_metrics(
    predictor.np.asarray([0.0, 0.0, 0.0]),
    predictor.np.asarray([0.0, 1.0, 2.0]),
)
assert factor_metrics["medianFactorError"] == 10.0
assert factor_metrics["geometricMeanFactorError"] == 10.0

tail_rows = predictor.threshold_diagnostics(
    predictor.np.asarray([50_000, 250_000, 2_000_000, 20_000_000], dtype=float),
    predictor.np.log10(
        predictor.np.asarray([60_000, 200_000, 1_500_000, 15_000_000], dtype=float) + 1
    ),
    [
        predictor.np.asarray([-0.2, 0.0, 0.2], dtype=float),
        predictor.np.asarray([-0.3, 0.0, 0.3], dtype=float),
        predictor.np.asarray([-0.1, 0.0, 0.1], dtype=float),
        predictor.np.asarray([-0.2, 0.0, 0.2], dtype=float),
    ],
)
assert len(tail_rows) == 5
for tail in tail_rows:
    assert tail["method"] == "fully nested outer-training empirical residual CDF with Laplace smoothing"
    assert isinstance(tail["brier"], float)
    assert isinstance(tail["logLoss"], float)
    assert isinstance(tail["expectedCalibrationError"], float)
    assert "brierSkillVsBaseRate" in tail
    assert tail["brierSkillVsBaseRate"] is None or isinstance(
        tail["brierSkillVsBaseRate"], float
    )
    for bucket in tail["calibration"]:
        assert 0 <= bucket["observedLow95"] <= bucket["observedHitRate"]
        assert bucket["observedHitRate"] <= bucket["observedHigh95"] <= 1
try:
    predictor.threshold_diagnostics(
        predictor.np.asarray([100_000.0]),
        predictor.np.asarray([5.0]),
    )
except ValueError as error:
    assert "separate outer-training calibration" in str(error)
else:
    raise AssertionError("tail diagnostics accepted evaluation-outcome residuals")

source_summary = predictor.source_level_summary(
    [
        {
            "heldOutName": "one",
            "metrics": {"n": 10, "r2": 0.4, "spearman": 0.5, "mae": 3.0},
        },
        {
            "heldOutName": "two",
            "metrics": {"n": 30, "r2": -0.2, "spearman": 0.1, "mae": 7.0},
        },
    ]
)
assert source_summary["independentSources"] == 2
assert source_summary["macroR2"] == 0.1
assert source_summary["macroSpearman"] == 0.3
assert source_summary["macroMae"] == 5.0

within_metrics = predictor.within_source_metrics(
    predictor.np.asarray([10.0, 12.0, 80.0, 84.0]),
    predictor.np.asarray([9.0, 13.0, 79.0, 85.0]),
    ["a", "a", "b", "b"],
)
assert within_metrics["groups"] == 2
assert within_metrics["r2"] > 0
rank_statistic, permutation_p = predictor.within_source_rank_test(
    predictor.np.asarray([1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 20.0, 22.0, 24.0]),
    predictor.np.asarray([2.0, 3.0, 4.0, 9.0, 12.0, 13.0, 18.0, 24.0, 26.0]),
    ["a", "a", "a", "b", "b", "b", "c", "c", "c"],
    "contract-fixture",
    permutations=99,
)
assert isinstance(rank_statistic, float)
assert 0 < permutation_p <= 1


# Verify the operational and unseen-group tracks are assembled from different
# functions and are never merged under one headline metric.
keep_source = inspect.getsource(predictor.run_keep_track)
views_source = inspect.getsource(predictor.run_views_track)
assert "operational = run_keep_known_video" in keep_source
assert '"label": "Unseen-account transfer"' in keep_source
assert '"metrics": operational["metrics"]' in keep_source
assert '"folds": operational["folds"]' in keep_source
assert '"stressTests": [transfer_stress]' in keep_source
assert '"warning":' in keep_source

assert "operational = run_views_known_video" in views_source
assert '"label": "Unseen-channel transfer"' in views_source
assert 'predicted = operational["prediction"]' in views_source
assert "metrics = log_view_metrics(y_valid, predicted_valid)" in views_source
assert "threshold_diagnostics(" in views_source
assert "residual_samples" in views_source
assert '"folds": operational["folds"]' in views_source
assert '"formula": operational["formula"]' in views_source
assert '"stressTests": [transfer_stress]' in views_source
assert '"warning":' in views_source

fold_source = inspect.getsource(predictor.private_fold_oof)
assert "folds[index] != fold" in fold_source
assert "folds[index] == fold" in fold_source
assert "private_base_features(train, evaluated" in fold_source
selection_source = inspect.getsource(predictor.private_selection_datasets)
assert "train_features = private_fold_oof(" in selection_source
assert "test_features = private_base_features(" in selection_source
assert "train_rows,\n            test_rows" in selection_source
known_keep_source = inspect.getsource(predictor.run_keep_known_video)
assert "selection_datasets = private_selection_datasets(" in known_keep_source
assert "search_datasets_with_sparse_alpha(" in known_keep_source
tail_source = inspect.getsource(predictor.views_nested_calibration_predictions)
assert "selection_folds = within_group_folds(" in tail_source
assert "search_with_sparse_alpha(" in tail_source
runner_doc = predictor.__doc__ or ""
assert "Existing\nin-sample steered keep/ret5 estimates are never used as validation features." in runner_doc


# Exercise the real main-result assembly without touching production data or R2.
def synthetic_target(kind: str) -> dict:
    group_key = "heldOutAccount" if kind == "keep" else "heldOutChannel"
    stress_label = "Unseen-account transfer" if kind == "keep" else "Unseen-channel transfer"
    return {
        "label": kind,
        "population": "synthetic",
        "primaryValidation": "Retrospective five-fold interpolation within known group",
        "prospectiveValidation": "Synthetic test rows are published earlier than later rows.",
        "prospectiveMetrics": {"n": 2, "r2": -0.1},
        "decisionStatus": "not prospectively validated",
        "n": 2,
        "metrics": {"n": 2, "r2": 0.1},
        "contentOnlyMetrics": {"n": 2, "r2": 0.08},
        "withinSourceMetrics": {
            "n": 2,
            "r2": 0.02,
            "groups": 2,
            "method": "OOF predictions and outcomes centered within each observed source; descriptive video-level lift after removing source means",
        },
        "sourceSummary": {
            "independentSources": 2,
            "macroSpearman": 0.1,
            "intervalCaveat": "Synthetic descriptive source summary.",
            "perSource": [],
        },
        "allInputsMetrics": {"n": 2, "r2": 0.05},
        "calibration": [],
        "folds": [{"heldOutFold": 1, "trainN": 1, "testN": 1}],
        "points": [],
        "formula": formula,
        "allInputsFormula": {**formula, "alpha": 10.0},
        "stressTests": [
            {
                "label": stress_label,
                "description": "An entire synthetic group is absent.",
                "metrics": {"n": 2, "r2": -0.2},
                "folds": [{group_key: "group-a", "trainN": 1, "testN": 1}],
            }
        ],
        "warning": "Synthetic contract fixture.",
    }


with tempfile.TemporaryDirectory() as temporary_directory:
    temporary_result = Path(temporary_directory) / "results.json"
    with (
        mock.patch.object(predictor, "LOCAL_RESULT", temporary_result),
        mock.patch.object(predictor, "update_status", lambda *args, **kwargs: None),
        mock.patch.object(predictor, "load_library", lambda: library_fixture),
        mock.patch.object(predictor, "load_raw", lambda: stores_fixture),
        mock.patch.object(
            predictor,
            "load_private_rows",
            lambda: [{"id": "p1"}, {"id": "p2"}],
        ),
        mock.patch.object(
            predictor,
            "load_saved_channel_rows",
            lambda contract: [
                {"id": "saved-1", "channel": "c1"},
                {"id": "saved-2", "channel": "c1"},
                {"id": "saved-3", "channel": "c2"},
            ],
        ),
        mock.patch.object(predictor, "load_novelty_models", lambda: {}),
        mock.patch.object(predictor, "fit_public_axes", lambda *args, **kwargs: {}),
        mock.patch.object(
            predictor,
            "run_keep_track",
            lambda *args, **kwargs: synthetic_target("keep"),
        ),
        mock.patch.object(
            predictor,
            "run_views_track",
            lambda *args, **kwargs: synthetic_target("views"),
        ),
        mock.patch.object(
            sys,
            "argv",
            [str(RUNNER_PATH), "--local-only", "--skip-corpus-benchmark"],
        ),
    ):
        assert predictor.main() == 0
    assembled_result = json.loads(temporary_result.read_text(encoding="utf-8"))
    assert_result_contract(assembled_result, candidate_hash)


# When a local production artifact exists, validate its complete live target
# payload too. The test remains portable because the main assembly above is the
# required contract source of truth.
validated_live_artifact = False
if RESULT_PATH.exists():
    live_result = json.loads(RESULT_PATH.read_text(encoding="utf-8"))
    assert_result_contract(live_result, candidate_hash)
    validated_live_artifact = True

print(
    json.dumps(
        {
            "ok": True,
            "candidates": len(first_registry),
            "candidateHash": candidate_hash,
            "coverageFixture": coverage,
            "liveArtifactValidated": validated_live_artifact,
        },
        separators=(",", ":"),
    )
)
