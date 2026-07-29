#!/usr/bin/env python3
"""Focused contract tests for the leakage-safe Predictor Lab artifact."""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import inspect
import io
import itertools
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
from collections import Counter
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "buildings" / "jarvis" / "predictor-lab" / "run_predictor_lab.py"
RESULT_PATH = ROOT / "buildings" / "jarvis" / "predictor-lab" / "results.json"
RAW_EMBED_PATH = ROOT / "raw_embed.py"
RAW_UPLOAD_PATH = ROOT / "raw_upload.py"
SHORT_STEER_PATH = ROOT / "add_steered_proj.py"
LONG_STEER_PATH = ROOT / "add_steered_proj_long.py"

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
spec = importlib.util.spec_from_file_location("predictor_lab_under_test", RUNNER_PATH)
assert spec and spec.loader, f"could not load {RUNNER_PATH}"
predictor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(predictor)

CREATOR_ADAPTIVE_BENCHMARK_ID = "shorts.causal-keep-mixture-benchmark.v1"
CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID = "shorts.causal-keep-mixture.v1"
CREATOR_ADAPTIVE_CANDIDATE_COUNT = 43_360
CREATOR_ADAPTIVE_CANDIDATE_SHA256 = (
    "bc7ae80a7afeac82a40648c3ff07e066"
    "cc238d3b27918d5f82bf3bbbd04de3ff"
)
CREATOR_ADAPTIVE_OUTPUT_TRANSFORM = (
    "clip(0.5 * centered-together residual analog + "
    "0.5 * visual+together semantic stack, 0, 100)"
)
CREATOR_ADAPTIVE_LOCKED_FORMULA = {
    "coordinateId": CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID,
    "formula": (
        "0.5 * stage2 centered-together pooled residual analog + "
        "0.5 * stage3 visual+together semantic stack"
    ),
    "inputs": [
        "Together embedding (visual plus text)",
        "Visual embedding",
        "Strictly earlier same-creator keep history",
    ],
    "label": "Causal keep-rate mixture",
    "modalityClass": "multimodal",
    "stage1": {
        "biasWeight": 0.5,
        "biasWindow": 12,
        "contentWeight": 0.5,
        "expert": "pooledKnn:centeredTogether:k12:t15:z:all",
        "gateMargin": 0.0,
        "gateWindow": 0,
    },
    "stage2": {
        "biasWeight": 1.0,
        "biasWindow": 12,
        "gateMargin": 0.0,
        "gateWindow": 0,
        "initial": 0.5,
        "maximum": 0.5,
        "mode": "constant",
        "reliability": "none",
        "ridge": 0.0,
        "window": 0,
    },
    "stage3": {
        "alpha": 1.0,
        "biasWeight": 0.0,
        "biasWindow": 0,
        "family": "stack",
        "featureSet": "semanticWide",
        "features": [
            "ct12",
            "ct24",
            "ct48",
            "cc12",
            "cv12",
            "cv24",
            "krrTogether",
            "krrVisual",
        ],
        "localWeight": 0.0,
    },
    "stage4": {
        "eta": 0.0,
        "initialWeights": [0.5, 0.5, 0.0],
        "minimum": 0,
        "mode": "fixed",
        "window": 0,
    },
}

assert predictor.CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION == 3
assert predictor.CREATOR_ADAPTIVE_KEEP_V1_SPEC == {
    "benchmarkId": CREATOR_ADAPTIVE_BENCHMARK_ID,
    "benchmarkCoordinateId": CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID,
    "candidateCount": CREATOR_ADAPTIVE_CANDIDATE_COUNT,
    "candidateRegistrySha256": CREATOR_ADAPTIVE_CANDIDATE_SHA256,
    "benchmarkArtifactSha256": (
        "c82a290cd4180974d754e6b1c0afec8"
        "d456d08d0434794925936ffb11ea82747"
    ),
    "resultCoreSha256": (
        "a8dc76db007bc1b158c1e9a04775d1a"
        "e7f32656c19b44e733b0523256a42391a"
    ),
    "historyWindow": 30,
    "minimumHistoryN": 8,
}


# Execute only the pure Gemini-error classifier from raw_embed.py. Importing the
# whole worker would start network and R2 work, so the AST keeps this unit test
# deterministic and side-effect free.
raw_tree = ast.parse(RAW_EMBED_PATH.read_text(encoding="utf-8"))
classifier_node = next(
    node for node in raw_tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "classify_embed_error"
)
classifier_namespace = {
    "json": json,
    "re": re,
    "time": time,
    "urllib": __import__("urllib"),
    "KEY": "test-secret-key",
    "CREDIT_RETRY_SECONDS": 60,
}
exec(compile(ast.Module(body=[classifier_node], type_ignores=[]), str(RAW_EMBED_PATH), "exec"), classifier_namespace)
quota_body = io.BytesIO(json.dumps({
    "error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": "Quota exhausted for key=test-secret-key; check billing.",
    }
}).encode())
quota_error = urllib.error.HTTPError("https://example.invalid", 429, "quota", {}, quota_body)
quota_classification = classifier_namespace["classify_embed_error"](quota_error)
assert quota_classification["kind"] == "credits_or_quota_exhausted"
assert quota_classification["httpStatus"] == 429
assert quota_classification["retrySeconds"] == 60
assert "test-secret-key" not in quota_classification["diagnostic"]
assert "[redacted]" in quota_classification["diagnostic"]


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
    if target_name == "keep":
        blind = target.get("blindInputs")
        assert isinstance(blind, dict), "keep target must persist row-level leakage-safe inputs"
        assert blind.get("featureNames") == predictor.PRIVATE_FEATURE_NAMES
        assert "evaluated video" in blind.get("videoHeldOutProtocol", "")
        assert "evaluated account" in blind.get("accountHeldOutProtocol", "")
        assert isinstance(blind.get("rows"), list)
        for row in blind["rows"]:
            assert len(row.get("videoHeldOut", [])) == len(predictor.PRIVATE_FEATURE_NAMES)
            assert len(row.get("accountHeldOut", [])) == len(predictor.PRIVATE_FEATURE_NAMES)
        visual_study = target.get("visualOnlyStudy")
        if visual_study is not None:
            assert visual_study.get("schemaVersion") == 2
            assert visual_study.get("coordinateId") == predictor.VISUAL_KEEP_COORDINATE_ID
            assert set(visual_study.get("protocols", {})) == {
                "videoHoldout",
                "forwardTime",
                "accountHoldout",
            }
            assert visual_study.get("promotion", {}).get("status")
            assert visual_study.get("formula", {}).get("input")
            production = visual_study.get("production")
            assert isinstance(production, dict)
            assert production.get("coordinateId") == predictor.VISUAL_KEEP_COORDINATE_ID
            assert production.get("fitPopulation", {}).get("n") == visual_study["population"]["n"]
            assert len(production.get("fitPopulation", {}).get("videoIdSha256", "")) == 64
            assert sum(
                int(account.get("rowCount") or 0)
                for account in production.get("fitPopulation", {}).get("byAccount", {}).values()
            ) == visual_study["population"]["n"]
            assert len(production.get("points", [])) == visual_study["population"]["n"]
            assert all(
                point.get("calibrationScope") == "pooled_global"
                and point.get("predicted") == point.get("pooledPrediction")
                for point in production.get("points", [])
            )
            model_artifact = visual_study.get("modelArtifact")
            assert isinstance(model_artifact, dict)
            assert len(model_artifact.get("artifactSha256", "")) == 64
            assert model_artifact.get("canonicalKey") == predictor.R2_VISUAL_KEEP_MODEL_KEY
            for protocol in visual_study["protocols"].values():
                assert isinstance(protocol.get("metrics"), dict)
                assert isinstance(protocol.get("points"), list)
                assert "rangeRatio" in protocol["metrics"]
                assert "protocolBaselineR2" in protocol["metrics"]
        creator_adaptive = target.get("creatorAdaptiveStudy")
        assert isinstance(
            creator_adaptive,
            dict,
        ), "keep target must persist the creator-adaptive study"
        assert (
            creator_adaptive.get("coordinateId")
            == predictor.CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
        )
        assert (
            creator_adaptive.get("schemaVersion")
            == predictor.CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION
        )
        creator_selection = creator_adaptive.get("selection") or {}
        creator_selected = creator_selection.get("selected") or {}
        assert creator_selection["candidateCount"] == CREATOR_ADAPTIVE_CANDIDATE_COUNT
        assert (
            creator_selection["candidateCountWithAllAccounts"]
            == CREATOR_ADAPTIVE_CANDIDATE_COUNT
        )
        assert (
            creator_selection["candidateRegistrySha256"]
            == CREATOR_ADAPTIVE_CANDIDATE_SHA256
        )
        assert creator_selected["benchmarkId"] == CREATOR_ADAPTIVE_BENCHMARK_ID
        assert creator_selected["modalityClass"] == "multimodal"
        assert (
            creator_selected["formula"]
            == CREATOR_ADAPTIVE_LOCKED_FORMULA["formula"]
        )
        for stage in ("stage1", "stage2", "stage3", "stage4"):
            assert creator_selected[stage] == CREATOR_ADAPTIVE_LOCKED_FORMULA[stage]
        assert creator_adaptive.get("evaluation", {}).get("points")
        creator_formula = creator_adaptive.get("formula") or {}
        assert creator_formula.get("accounts")
        assert creator_formula["modalityClass"] == "multimodal"
        assert creator_formula["historyWindow"] == 30
        assert creator_formula["minimumHistoryN"] == 8
        assert creator_formula["lockedFormula"] == CREATOR_ADAPTIVE_LOCKED_FORMULA
        assert creator_formula["outputBounds"] == [0, 100]
        assert (
            creator_formula["outputTransform"]
            == CREATOR_ADAPTIVE_OUTPUT_TRANSFORM
        )
        for point in creator_adaptive["evaluation"]["points"]:
            assert isinstance(point["componentA"], (int, float))
            assert isinstance(point["componentB"], (int, float))
            assert abs(
                point["predicted"]
                - 0.5 * (point["componentA"] + point["componentB"])
            ) <= 1e-5
            assert 8 <= point["historyN"] <= 30
            assert len(point["historyVideoIds"]) == point["historyN"]
            assert len(set(point["historyVideoIds"])) == point["historyN"]
            assert point["historyEnd"] < point["publishedAt"]
        for profile in creator_formula["accounts"].values():
            assert 8 <= profile["historyN"] <= 30
            assert profile["historyWindow"] == 30
            assert len(profile["historyVideoIds"]) == profile["historyN"]
            assert len(set(profile["historyVideoIds"])) == profile["historyN"]
        creator_target = creator_adaptive["evaluation"]["target"]
        assert creator_target["allPopulationAccountsEvaluated"]
        assert creator_target["allAccountsPassPointEstimate"]
        assert (
            creator_target["pointEstimatePassCount"]
            == creator_target["accountCount"]
            == creator_target["evaluatedAccountCount"]
        )
        assert all(
            float(account["mae"]) <= 10
            for account in creator_adaptive["evaluation"]["metrics"]["perAccount"]
        )
        creator_metrics = creator_adaptive["evaluation"]["metrics"]
        assert "baselineMae" in creator_metrics
        assert "maeImprovementVsBaseline" in creator_metrics
        assert "protocolBaselineR2" in creator_metrics
        assert all(
            "baselineMae" in account
            and "maeImprovementVsBaseline" in account
            and "protocolBaselineR2" in account
            for account in creator_metrics["perAccount"]
        )
        creator_status = creator_adaptive.get("status") or {}
        assert creator_status.get("state", "").startswith("research_only_")
        assert creator_status.get("absoluteTargetMet") is True
        assert creator_status.get("promoted") is False
        assert creator_status.get("predictorEligible") is False
        assert creator_target["baseline"]
        assert isinstance(
            creator_target.get("beatsHonestBaselineOverall"),
            bool,
        )
        assert isinstance(
            creator_target.get("allAccountsBeatHonestBaseline"),
            bool,
        )
        if not (
            creator_target["beatsHonestBaselineOverall"]
            and creator_target["allAccountsBeatHonestBaseline"]
        ):
            assert "baseline" in creator_status.get("plainEnglish", "").lower()
        model_artifact = creator_adaptive.get("modelArtifact")
        assert isinstance(model_artifact, dict)
        assert len(model_artifact.get("artifactSha256", "")) == 64
        assert (
            model_artifact.get("canonicalKey")
            == predictor.R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY
        )
    else:
        assert isinstance(stress.get("points"), list), "unseen-channel stress must persist every held-out prediction"


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
    assert provenance["privateAxisTrainingIdOverlap"] == 0
    assert provenance["savedAxisTrainingIdOverlap"] == 0
    assert provenance["validationCreatorAxisTrainingIdOverlap"] == 0
    assert isinstance(provenance["validationCreatorChannelIds"], list)
    assert provenance["validationCreatorChannelIds"]
    assert len(provenance["validationCreatorChannelIdHash"]) == 64
    assert provenance["validationCreatorVideoCountExcluded"] >= 0
    assert provenance["publicAxisExcludedVideoCount"] >= coverage["privateRetentionRows"]
    assert len(provenance["publicAxisExcludedVideoIdHash"]) == 64
    assert len(provenance["savedAxisCandidateOverlapRemovedIdsHash"]) == 64
    assert len(provenance["featureContractSha256"]) == 64
    assert len(provenance["savedVideoIdHash"]) == 64
    assert len(provenance["rawAxisCorpusIdHash"]) == 64
    assert provenance["featureScorerVersionPersistedPerVideo"] is False
    assert "rank quantile-mapped" in provenance["publicAxisEstimator"]
    assert "scorer/model version" in provenance["warning"]
    assert provenance["sourceArtifacts"]
    assert set(provenance["rawStoreShape"]) == {"visual", "text", "together"}
    assert provenance["runtime"]["scikitLearn"]
    assert len(provenance["visualKeepModelArtifact"]["artifactSha256"]) == 64
    assert (
        provenance["visualKeepModelArtifact"]["canonicalKey"]
        == predictor.R2_VISUAL_KEEP_MODEL_KEY
    )
    assert len(
        provenance["creatorAdaptiveKeepModelArtifact"]["artifactSha256"]
    ) == 64
    assert (
        provenance["creatorAdaptiveKeepModelArtifact"]["canonicalKey"]
        == predictor.R2_CREATOR_ADAPTIVE_KEEP_MODEL_KEY
    )

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


# The visual-only study preserves three genuinely different claims. Its plotted
# point predictions and range diagnostics are persisted rather than recomputed
# by the browser.
visual_rows = []
visual_vectors = []
for account_index, account in enumerate(("alpha", "beta", "gamma", "delta")):
    for video_index in range(20):
        phase = video_index / 19
        vector = predictor.np.asarray([
            phase,
            predictor.math.sin(video_index / 3),
            predictor.math.cos(video_index / 4),
            account_index / 3,
            phase * phase,
            (video_index % 3) / 2,
            (account_index + video_index % 2) / 4,
            1,
        ], dtype=float)
        visual_vectors.append(vector)
        visual_rows.append({
            "id": f"{account}-{video_index}",
            "title": f"{account} fixture {video_index}",
            "account": account,
            "accountName": account.title(),
            "publishedAt": 1_700_000_000_000 + account_index * 10_000_000 + video_index * 86_400_000,
            "keep": 48 + 24 * phase + 4 * predictor.math.sin(video_index / 3) + account_index,
        })
visual_store = {
    "vectors": predictor.np.asarray(visual_vectors, dtype=float),
    "index": {row["id"]: index for index, row in enumerate(visual_rows)},
}
visual_study_fixture = predictor.run_visual_keep_study(
    visual_rows,
    {"visual": visual_store},
)
assert visual_study_fixture["population"]["n"] == len(visual_rows)
assert visual_study_fixture["schemaVersion"] == 2
assert visual_study_fixture["coordinateId"] == predictor.VISUAL_KEEP_COORDINATE_ID
assert visual_study_fixture["population"]["embeddingDimensions"] == 8
assert len(visual_study_fixture["formula"]["pooled"]["coefficients"]) == 8
assert len(visual_study_fixture["production"]["points"]) == len(visual_rows)
assert all(
    point["calibrationScope"] == "pooled_global"
    and point["predicted"] == point["pooledPrediction"]
    for point in visual_study_fixture["production"]["points"]
)
assert visual_study_fixture["production"]["fitPopulation"]["n"] == len(visual_rows)
assert len(visual_study_fixture["production"]["fitPopulation"]["videoIdSha256"]) == 64
assert sum(
    int(account["rowCount"])
    for account in visual_study_fixture["production"]["fitPopulation"]["byAccount"].values()
) == len(visual_rows)
assert set(visual_study_fixture["protocols"]) == {
    "videoHoldout",
    "forwardTime",
    "accountHoldout",
}
for visual_protocol in visual_study_fixture["protocols"].values():
    assert visual_protocol["points"]
    assert visual_protocol["metrics"]["actualRange"] > 0
    assert visual_protocol["metrics"]["predictedRange"] >= 0
    assert visual_protocol["metrics"]["rangeRatio"] is not None
    assert visual_protocol["metrics"]["protocolBaselineR2"] is not None

def creator_adaptive_benchmark_fixture(
    rows: list[dict],
    stores: dict[str, dict],
) -> dict:
    ordered, fingerprints = predictor.creator_adaptive_benchmark_fingerprints(
        rows,
        stores,
    )
    rows_by_account = {
        account: sorted(
            [row for row in ordered if row["account"] == account],
            key=lambda row: (row["publishedAt"], row["id"]),
        )
        for account in sorted({row["account"] for row in ordered})
    }

    def point(row: dict, account_rows: list[dict]) -> dict:
        position = next(
            index
            for index, candidate in enumerate(account_rows)
            if candidate["id"] == row["id"]
        )
        history = account_rows[max(0, position - 30):position]
        assert len(history) >= 8
        component_a = float(row["keep"]) + 0.25
        component_b = float(row["keep"]) + 0.75
        return {
            "id": row["id"],
            "title": row["title"],
            "accountPosition": position,
            "publishedAt": float(row["publishedAt"]),
            "actualKeep": float(row["keep"]),
            "predictedKeep": 0.5 * (component_a + component_b),
            "historyBaseline": (
                sum(float(item["keep"]) for item in history) / len(history)
            ),
            "componentA": component_a,
            "componentB": component_b,
            "historyN": len(history),
            "historyVideoIds": [item["id"] for item in history],
            "predictionIntervals": None,
        }

    selection_points = {}
    final_points = {}
    for account, account_rows in rows_by_account.items():
        assert len(account_rows) == 20
        selection_points[account] = [
            point(row, account_rows) for row in account_rows[10:16]
        ]
        final_points[account] = [
            point(row, account_rows) for row in account_rows[16:20]
        ]

    final_metrics = {
        "allAccountsWithin10": True,
        "allAccountsBeatBaseline": True,
    }
    return {
        "schemaVersion": 1,
        "benchmarkId": CREATOR_ADAPTIVE_BENCHMARK_ID,
        "coordinate": {
            "id": CREATOR_ADAPTIVE_BENCHMARK_COORDINATE_ID,
            "modalityClass": "multimodal",
        },
        "candidateRegistry": {
            "count": CREATOR_ADAPTIVE_CANDIDATE_COUNT,
            "sha256": CREATOR_ADAPTIVE_CANDIDATE_SHA256,
        },
        "dataset": {
            "n": len(ordered),
            "fingerprints": fingerprints,
        },
        "selection": {
            "pointsByAccount": selection_points,
            "metrics": {},
            "modalityAblations": {},
            "stages": {
                "lockedFormula": CREATOR_ADAPTIVE_LOCKED_FORMULA,
            },
        },
        "final": {
            "causalPrequentialTail": {
                "pointsByAccount": final_points,
                "metrics": final_metrics,
                "modalityAblations": {},
                "predictionIntervals": {},
            },
            "frozenTail": {
                "pointsByAccount": final_points,
                "metrics": final_metrics,
                "modalityAblations": {},
                "predictionIntervals": {},
                "uncertainty": {"perAccount": []},
            },
        },
        "rollingBlockStability": {},
        "equalTimestampAudit": {"passed": True},
        "resultCoreSha256": hashlib.sha256(
            b"creator-adaptive-schema3-fixture-core"
        ).hexdigest(),
    }


creator_benchmark = creator_adaptive_benchmark_fixture(
    visual_rows,
    {"visual": visual_store, "together": visual_store},
)
with tempfile.TemporaryDirectory() as creator_benchmark_directory:
    creator_benchmark_root = Path(creator_benchmark_directory)
    creator_benchmark_path = creator_benchmark_root / "benchmark.json"
    creator_benchmark_bytes = json.dumps(
        creator_benchmark,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    creator_benchmark_path.write_bytes(creator_benchmark_bytes)
    creator_benchmark_spec = {
        **predictor.CREATOR_ADAPTIVE_KEEP_V1_SPEC,
        "benchmarkArtifactSha256": hashlib.sha256(
            creator_benchmark_bytes
        ).hexdigest(),
        "resultCoreSha256": creator_benchmark["resultCoreSha256"],
    }
    with (
        mock.patch.object(predictor, "ROOT", creator_benchmark_root),
        mock.patch.object(
            predictor,
            "CAUSAL_KEEP_MIXTURE_BENCHMARK",
            creator_benchmark_path,
        ),
        mock.patch.object(
            predictor,
            "CREATOR_ADAPTIVE_KEEP_V1_SPEC",
            creator_benchmark_spec,
        ),
    ):
        creator_adaptive_fixture = predictor.run_creator_adaptive_keep_study(
            visual_rows,
            {
                "visual": visual_store,
                "together": visual_store,
            },
        )
        assert (
            creator_adaptive_fixture["coordinateId"]
            == predictor.CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
        )
        assert creator_adaptive_fixture["schemaVersion"] == 3
        assert (
            creator_adaptive_fixture["selection"]["candidateCount"]
            == CREATOR_ADAPTIVE_CANDIDATE_COUNT
        )
        assert (
            creator_adaptive_fixture["selection"][
                "candidateRegistrySha256"
            ]
            == CREATOR_ADAPTIVE_CANDIDATE_SHA256
        )
        assert (
            creator_adaptive_fixture["selection"][
                "candidateCountWithAllAccounts"
            ]
            == CREATOR_ADAPTIVE_CANDIDATE_COUNT
        )
        assert (
            creator_adaptive_fixture["selection"]["selected"]
            == {
                "benchmarkId": CREATOR_ADAPTIVE_BENCHMARK_ID,
                "modalityClass": "multimodal",
                "formula": CREATOR_ADAPTIVE_LOCKED_FORMULA["formula"],
                **{
                    stage: CREATOR_ADAPTIVE_LOCKED_FORMULA[stage]
                    for stage in ("stage1", "stage2", "stage3", "stage4")
                },
            }
        )
        assert creator_adaptive_fixture["evaluation"]["points"]
        assert all(
            point["historyN"] >= 8
            and point["historyN"] <= 30
            and len(point["historyVideoIds"]) == point["historyN"]
            and point["historyEnd"] < point["publishedAt"]
            and abs(
                point["predicted"]
                - 0.5 * (point["componentA"] + point["componentB"])
            ) < 1e-9
            for point in creator_adaptive_fixture["evaluation"]["points"]
        )
        assert creator_adaptive_fixture["evaluation"]["target"][
            "allPopulationAccountsEvaluated"
        ]
        assert not creator_adaptive_fixture["evaluation"]["target"][
            "missingEvaluationAccounts"
        ]
        assert set(creator_adaptive_fixture["formula"]["accounts"]) == {
            row["account"] for row in visual_rows
        }
        assert creator_adaptive_fixture["formula"]["modalityClass"] == "multimodal"
        assert creator_adaptive_fixture["formula"]["historyWindow"] == 30
        assert creator_adaptive_fixture["formula"]["minimumHistoryN"] == 8
        assert (
            creator_adaptive_fixture["formula"]["lockedFormula"]
            == CREATOR_ADAPTIVE_LOCKED_FORMULA
        )
        assert creator_adaptive_fixture["formula"]["outputBounds"] == [0, 100]
        assert (
            creator_adaptive_fixture["formula"]["outputTransform"]
            == CREATOR_ADAPTIVE_OUTPUT_TRANSFORM
        )
        assert creator_adaptive_fixture["status"]["promoted"] is False
        assert creator_adaptive_fixture["status"]["predictorEligible"] is False
        assert creator_adaptive_fixture["status"]["state"].startswith(
            "research_only_"
        )

        # Schema 3 is bound to exact labels and embedding matrices. Changing
        # only final-tail outcomes must invalidate the registered benchmark.
        mutated_rows = [dict(row) for row in visual_rows]
        for account in {row["account"] for row in mutated_rows}:
            account_rows = sorted(
                (row for row in mutated_rows if row["account"] == account),
                key=lambda row: row["publishedAt"],
            )
            for index, row in enumerate(account_rows[-4:]):
                row["keep"] = 5 + index * 30
        try:
            predictor.run_creator_adaptive_keep_study(
                mutated_rows,
                {"visual": visual_store, "together": visual_store},
            )
        except RuntimeError as error:
            assert "does not match the current dataset" in str(error)
        else:
            raise AssertionError(
                "mutated final-tail labels bypassed the frozen benchmark fingerprint"
            )

        # A changed creator population is also refused rather than silently
        # disappearing from the all-account denominator or triggering a refit.
        undersized_rows = visual_rows + [
            {
                "id": f"undersized-{index}",
                "title": f"undersized fixture {index}",
                "account": "undersized",
                "accountName": "Undersized",
                "publishedAt": 1_800_000_000_000 + index * 86_400_000,
                "keep": 60 + index,
            }
            for index in range(7)
        ]
        undersized_vectors = predictor.np.concatenate(
            (
                visual_store["vectors"],
                predictor.np.asarray(
                    [
                        [index / 7, 0, 0, 0, 0, 0, 0, 1]
                        for index in range(7)
                    ],
                    dtype=float,
                ),
            ),
            axis=0,
        )
        undersized_store = {
            "vectors": undersized_vectors,
            "index": {
                row["id"]: index
                for index, row in enumerate(undersized_rows)
            },
        }
        try:
            predictor.run_creator_adaptive_keep_study(
                undersized_rows,
                {
                    "visual": undersized_store,
                    "together": undersized_store,
                },
            )
        except RuntimeError as error:
            assert "does not match the current dataset" in str(error)
        else:
            raise AssertionError(
                "a changed creator population bypassed the frozen benchmark fingerprint"
            )

assert predictor.creator_adaptive_bootstrap_interval(
    predictor.np.asarray([1, 2, 3, 4], dtype=float),
    "bootstrap-fixture",
) == predictor.creator_adaptive_bootstrap_interval(
    predictor.np.asarray([1, 2, 3, 4], dtype=float),
    "bootstrap-fixture",
)


# Coverage counts only stored vertical Science Center Shorts, while totals retain
# private/non-Science rows so an accidental denominator change is caught.
library_fixture = {
    "science-a": {
        "videoId": "science-a",
        "channel": "Tyler Csatari",
        "channelId": "UCfixtureCreatorA",
        "stored": True,
        "width": 1080,
        "height": 1920,
        "durationSec": 30,
    },
    "science-b": {
        "videoId": "science-b",
        "channel": "Hafu Go",
        "channelId": "UCfixtureCreatorB",
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

# A direct high-dimensional regression shrinks view predictions toward the mean.
# The production scorer instead uses latent rank and maps that rank back onto the
# observed outcome distribution. The blind refit must preserve that output scale
# without seeing any validation-row outcomes.
axis_features = predictor.np.column_stack(
    [
        predictor.np.linspace(-2, 2, 80),
        predictor.np.linspace(-2, 2, 80) ** 2,
        predictor.np.sin(predictor.np.linspace(-2, 2, 80)),
    ]
)
axis_outcomes = predictor.np.linspace(4.7, 8.1, 80)
quantile_axis = predictor.QuantileMappedRegressor.fit(axis_features, axis_outcomes)
axis_prediction = quantile_axis.predict(axis_features)
assert axis_prediction.min() == axis_outcomes.min()
assert axis_prediction.max() == axis_outcomes.max()
assert predictor.np.all((quantile_axis.ranks(axis_features) >= 0) & (quantile_axis.ranks(axis_features) <= 1))

binary_outcomes = (axis_outcomes >= 7).astype(int)
binary_axis = predictor.RankCalibratedBinaryAxis.fit(axis_features, binary_outcomes)
binary_probability = binary_axis.predict_proba(axis_features)
assert binary_probability.shape == (len(axis_features), 2)
assert predictor.np.allclose(binary_probability.sum(axis=1), 1)
assert predictor.np.all((binary_probability >= 0) & (binary_probability <= 1))

# An excluded validation outcome must have zero influence on every rebuilt
# public axis. This catches accidental inclusion more directly than checking
# only array lengths or provenance labels.
rng = predictor.np.random.default_rng(17)
leak_ids = [f"public-{index}" for index in range(120)] + ["validation-video"]
leak_vectors = predictor.normalized(rng.normal(size=(len(leak_ids), 12)))
leak_views = predictor.np.geomspace(25_000, 120_000_000, len(leak_ids))
leak_outlier = predictor.np.geomspace(0.05, 50, len(leak_ids))

def leakage_store(validation_views: float) -> dict:
    views = leak_views.copy()
    views[-1] = validation_views
    return {
        "ids": leak_ids,
        "index": {video_id: index for index, video_id in enumerate(leak_ids)},
        "vectors": leak_vectors,
        "views": views,
        "outlier": leak_outlier,
        "subs": predictor.np.ones(len(leak_ids)),
        "titles": leak_ids,
        "texts": leak_ids,
        "mine": predictor.np.zeros(len(leak_ids), dtype=bool),
        "silent": predictor.np.zeros(len(leak_ids), dtype=bool),
    }

axes_before = predictor.fit_public_axes(
    {modality: leakage_store(1) for modality in predictor.MODALITIES},
    {"validation-video"},
    {},
)
axes_after = predictor.fit_public_axes(
    {modality: leakage_store(1_000_000_000_000) for modality in predictor.MODALITIES},
    {"validation-video"},
    {},
)
probe = leak_vectors[-1:]
for modality in predictor.MODALITIES:
    assert predictor.np.array_equal(
        axes_before[modality]["views"].predict(probe),
        axes_after[modality]["views"].predict(probe),
    ), f"excluded {modality} validation outcome changed the blind views axis"
    assert predictor.np.array_equal(
        axes_before[modality]["hit10m"].predict_proba(probe),
        axes_after[modality]["hit10m"].predict_proba(probe),
    ), f"excluded {modality} validation outcome changed the blind 10M axis"

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
main_source = inspect.getsource(predictor.main)
public_axis_source = inspect.getsource(predictor.fit_public_axes)
assert "excluded_axis_ids = private_ids | saved_ids | validation_creator_video_ids" in main_source
assert "fit_public_axes(stores, excluded_axis_ids" in main_source
assert "QuantileMappedRegressor.fit" in public_axis_source
assert "RankCalibratedBinaryAxis.fit" in public_axis_source
assert "(views > 10_000_000).astype(int)" in public_axis_source
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

# All three serving/training paths fit log10(value + 1), so inversion must
# subtract one exactly once. A raw view count must never drift between the score
# card and validation graph.
raw_upload_source = RAW_UPLOAD_PATH.read_text(encoding="utf-8")
short_steer_source = SHORT_STEER_PATH.read_text(encoding="utf-8")
long_steer_source = LONG_STEER_PATH.read_text(encoding="utf-8")
assert "10 ** yv - 1" in raw_upload_source
assert re.search(r"10 \*\* \(PS\[0\].*PS\[3\]\) - 1", raw_upload_source)
assert "np.maximum(0.0, np.power(10.0, rvlog) - 1)" in short_steer_source
assert "np.maximum(0.0, np.power(10.0, rvlog) - 1)" in long_steer_source


# Exercise the real main-result assembly without touching production data or R2.
def synthetic_target(kind: str) -> dict:
    group_key = "heldOutAccount" if kind == "keep" else "heldOutChannel"
    stress_label = "Unseen-account transfer" if kind == "keep" else "Unseen-channel transfer"
    target = {
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
                "points": [],
            }
        ],
        "warning": "Synthetic contract fixture.",
    }
    if kind == "keep":
        target["visualOnlyStudy"] = json.loads(json.dumps(visual_study_fixture))
        target["creatorAdaptiveStudy"] = json.loads(
            json.dumps(creator_adaptive_fixture)
        )
        target["blindInputs"] = {
            "featureNames": predictor.PRIVATE_FEATURE_NAMES,
            "videoHeldOutProtocol": "The evaluated video is excluded from this synthetic fit.",
            "accountHeldOutProtocol": "The evaluated account is excluded from this synthetic fit.",
            "rows": [],
        }
    return target


with tempfile.TemporaryDirectory() as temporary_directory:
    temporary_result = Path(temporary_directory) / "results.json"
    temporary_visual_model = Path(temporary_directory) / "visual-keep-model-v1.json"
    temporary_creator_adaptive_model = (
        Path(temporary_directory) / "creator-adaptive-keep-model-v1.json"
    )
    with (
        mock.patch.object(predictor, "LOCAL_RESULT", temporary_result),
        mock.patch.object(
            predictor,
            "LOCAL_VISUAL_KEEP_MODEL",
            temporary_visual_model,
        ),
        mock.patch.object(
            predictor,
            "LOCAL_CREATOR_ADAPTIVE_KEEP_MODEL",
            temporary_creator_adaptive_model,
        ),
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
                {"id": "saved-1", "channel": "c1", "channelName": "Tyler Csatari"},
                {"id": "saved-2", "channel": "c1", "channelName": "Tyler Csatari"},
                {"id": "saved-3", "channel": "c2", "channelName": "Hafu Go"},
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
    assembled_visual_model = json.loads(
        temporary_visual_model.read_text(encoding="utf-8")
    )
    assert assembled_visual_model["coordinateId"] == predictor.VISUAL_KEEP_COORDINATE_ID
    assert assembled_visual_model["formula"]["scope"] == "pooled_global"
    assert "accounts" not in assembled_visual_model["formula"]
    assert len(assembled_visual_model["trainingPredictions"]) == len(visual_rows)
    assert all(
        point["calibrationScope"] == "pooled_global"
        and point["predicted"] == point["pooledPrediction"]
        for point in assembled_visual_model["trainingPredictions"]
    )
    assert len(assembled_visual_model["formula"]["pooled"]["coefficients"]) == 8
    assert (
        assembled_result["targets"]["keep"]["visualOnlyStudy"]["modelArtifact"][
            "artifactSha256"
        ]
        == hashlib.sha256(temporary_visual_model.read_bytes()).hexdigest()
    )
    assembled_creator_adaptive_model = json.loads(
        temporary_creator_adaptive_model.read_text(encoding="utf-8")
    )
    assert (
        assembled_creator_adaptive_model["coordinateId"]
        == predictor.CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
    )
    assert (
        assembled_creator_adaptive_model["schemaVersion"]
        == predictor.CREATOR_ADAPTIVE_KEEP_SCHEMA_VERSION
    )
    assert (
        assembled_creator_adaptive_model["selection"]["candidateCount"]
        == CREATOR_ADAPTIVE_CANDIDATE_COUNT
    )
    assert (
        assembled_creator_adaptive_model["selection"][
            "candidateRegistrySha256"
        ]
        == CREATOR_ADAPTIVE_CANDIDATE_SHA256
    )
    assert (
        assembled_creator_adaptive_model["selection"]["selected"][
            "benchmarkId"
        ]
        == CREATOR_ADAPTIVE_BENCHMARK_ID
    )
    assert (
        assembled_creator_adaptive_model["formula"]["outputTransform"]
        == CREATOR_ADAPTIVE_OUTPUT_TRANSFORM
    )
    assert assembled_creator_adaptive_model["status"]["promoted"] is False
    assert assembled_creator_adaptive_model["status"]["predictorEligible"] is False
    assert assembled_creator_adaptive_model["formula"]["accounts"]
    assert (
        assembled_result["targets"]["keep"]["creatorAdaptiveStudy"][
            "modelArtifact"
        ]["artifactSha256"]
        == hashlib.sha256(
            temporary_creator_adaptive_model.read_bytes()
        ).hexdigest()
    )


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
