#!/usr/bin/env python3
"""Publish the current Shorts Promise Lab product and no legacy score surfaces."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import time
from pathlib import Path

from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PRODUCT_VERSION = "shorts-promise-lab-v6-variable-horizon"

BROWSER_ARTIFACTS = {
    "openingPredictions": ("opening-predictions.json", "opening-predictions.json.gz"),
    "manualProjection": ("manual-projection.json", "manual-projection.json.gz"),
    "canonicalPartitions": ("canonical-partitions.json", "canonical-partitions.json.gz"),
}
MODEL_ARTIFACTS = (
    "canonical-partition-model.json",
    "opening-20s-model.json",
    "opening-retention-model.json",
    "opening-context-study.json",
)
API_ARTIFACTS = {
    "openingPredictions": "/api/shortsquant/promise-lab/opening-predictions",
    "manualProjection": "/api/shortsquant/promise-lab/manual-projection",
    "canonicalPartitions": "/api/shortsquant/promise-lab/canonical-partitions",
    "hookScore": "/api/shortsquant/promise-lab/hook-score",
}


def load_json(name: str) -> dict:
    path = CACHE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def load_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate(artifacts: dict[str, dict], models: dict[str, dict]) -> list[str]:
    errors = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    for key, (name, _) in BROWSER_ARTIFACTS.items():
        check(bool(artifacts.get(key)), f"missing product artifact: {name}")
        check((artifacts.get(key) or {}).get("status") == "complete",
              f"product artifact is not complete: {name}")
    for name in MODEL_ARTIFACTS:
        check(bool(models.get(name)), f"missing serving model: {name}")

    predictions = artifacts.get("openingPredictions") or {}
    projection = artifacts.get("manualProjection") or {}
    partitions = artifacts.get("canonicalPartitions") or {}
    retention_model = models.get("opening-retention-model.json") or {}
    context_study = models.get("opening-context-study.json") or {}
    measured_source = load_json("opening-20s.json")
    rows = predictions.get("rows") or []
    sources = int(predictions.get("sources") or 0)
    check(predictions.get("version") == retention_model.get("version") == 3,
          "the published predictor is not the variable-horizon v3 contract")
    check(sources == 208 and len(rows) == sources,
          "opening prediction summary does not contain the closed 208-video cohort")
    check(sources == int(measured_source.get("sourceVideos") or 0),
          "predictions and measured source cohort have different source counts")
    check(sources == int(retention_model.get("trainingSources") or 0),
          "browser predictions and serving model have different training sources")
    check(predictions.get("predictorVersion") == retention_model.get("predictorVersion"),
          "browser and serving predictor versions differ")
    check(predictions.get("featureVersion") == retention_model.get("featureVersion"),
          "browser and serving feature versions differ")

    method = retention_model.get("trainingMethod") or {}
    support = retention_model.get("support") or {}
    check(method.get("candidateStage") == "relationships",
          "the predeclared candidate is not the complete relationship stage")
    check(method.get("stageOrder") == ["timing", "semantic", "components", "relationships"],
          "the model stage ladder is incomplete or reordered")
    check(method.get("savedPredictionPolicy") ==
          "source-level out-of-fold at every supported second",
          "saved predictions are not source-level out of fold")
    check(method.get("typedPredictionPolicy") == "same frozen per-second full fits",
          "typed predictions are not pinned to the saved full fits")
    check(method.get("futureWordsUsedForEarlierPredictions") is False,
          "an earlier prediction can consume future words")
    check(method.get("boundaryOutcomesUsed") is False,
          "retention outcomes entered the component-boundary selector")
    check(method.get("externalIdeaContextUsed") is False,
          "external idea text entered the opening predictor")
    check(predictions.get("structurallyUncapped") is True and
          support.get("structurallyUncapped") is True and
          support.get("structuralInputTokenLimit") is None,
          "structural decomposition is not explicitly uncapped")
    check(float(support.get("meanWordsPerSecond") or 0) > 0,
          "serving model has no source-level mean speaking rate")
    check(int(support.get("speakingRateSourceCount") or 0) == sources,
          "mean speaking rate does not cover every source video")

    risk_rows = predictions.get("riskSetBySecond") or []
    risk_counts = [int(row.get("riskSetSources") or 0) for row in risk_rows]
    check(bool(risk_rows) and all(left >= right for left, right in zip(
        risk_counts, risk_counts[1:])),
        "duration-conditioned risk set is absent or increases over time")
    for family_name, family in (retention_model.get("families") or {}).items():
        temporal = family.get("temporalModels") or []
        promotion = family.get("promotion") or {}
        check(family.get("candidateStage") == "relationships" and
              family.get("selectedStage") in {"baseline", "relationships"} and
              family.get("selectedStage") == promotion.get("selectedStage") and
              promotion.get("stageShoppingAllowed") is False,
              f"{family_name} violates the predeclared promotion contract")
        check(bool(promotion.get("promoted")) or
              family.get("selectedStage") == "baseline",
              f"{family_name} serves an unpromoted sequence-specific model")
        check([int(row.get("second") or 0) for row in temporal] ==
              list(range(1, len(temporal) + 1)),
              f"{family_name} temporal models are not contiguous")
        check(all(row.get("prefixOnly") is True and
                  row.get("usesFutureWords") is False for row in temporal),
              f"{family_name} violates causal prefix timing")
        check(all(
            not row.get("headlineModelAvailable") or (
                row.get("fullNestedAblationAvailable") is True and
                set(row.get("stages") or {}) == {
                    "timing", "semantic", "components", "relationships"
                } and all((row["stages"][stage] or {}).get("model")
                          for stage in ("timing", "semantic", "components", "relationships"))
            ) for row in temporal
        ), f"{family_name} is missing a fitted stage in a supported second")

    check(context_study.get("status") == "complete" and
          context_study.get("categoryCount") == 4,
          "the four-category context study is unavailable")
    categories = context_study.get("categories") or []
    check({int(row.get("category", -1)) for row in categories} == {0, 1, 2, 3},
          "context experiments do not cover all four frozen categories")
    check(all((row.get("primaryOutcomePlane") or {}).get("points")
              for row in categories),
          "a frozen category has no outcome plane")
    check(all(set(row.get("outcomePlanesByLag") or {}) ==
              {str(value) for value in range(6)} for row in categories),
          "the 24 category-by-lag outcome planes are incomplete")
    check(partitions.get("outcomesUsed") is False,
          "canonical category map no longer has an outcome-blind contract")
    check(bool(projection.get("saved")) and bool(projection.get("mapId")),
          "saved four-cluster embedding is not persistent")
    check(set((projection.get("frozenPointIndex") or {}).get("labels") or []) ==
          {0, 1, 2, 3},
          "saved embedding does not contain exactly four frozen categories")

    check(all(int(row.get("componentCount") or 0) > 0 and
              len(row.get("components") or []) == int(row.get("componentCount") or 0)
              for row in rows),
          "the opening library summary does not expose every component")
    check(all((row.get("outputs") or {}).get("retainedAtForecastEndPercent") is not None
              for row in rows), "a saved opening has no supported endpoint prediction")

    ui_source = (HERE.parent / "promise-lab-ui.js").read_text(encoding="utf-8")
    for marker in (
        "function renderAnalysis(analysis, lattice)",
        "Where every served prediction movement comes from",
        "Selected component inside the saved four-cluster embedding",
        "Component evidence, viewer context, and response timing",
        "function riskSetPanel(analysis)",
        "function sequenceContextPanel(analysis)",
        "function outcomePlanesPanel(analysis)",
        "Analysis data ledger",
    ):
        check(marker in ui_source, f"shared analysis renderer is missing: {marker}")
    check("data-pl-score-duration" in ui_source and "maxlength=" not in ui_source,
          "scorer does not expose optional timing or still truncates text")
    check("blank = measured mean speaking rate" in ui_source,
          "scorer does not explain its inferred timing contract")

    channel_order = ["baseline", "timing", "semantic", "components", "relationships"]
    for row in rows:
        video_id = str(row.get("videoId") or "")
        detail_path = CACHE / "opening-predictions" / f"{video_id}.json.gz"
        check(detail_path.exists(), f"missing saved prediction detail: {video_id}")
        if not detail_path.exists():
            continue
        detail = load_gzip(detail_path)
        attribution = detail.get("temporalAttribution") or {}
        components = detail.get("components") or []
        steps = attribution.get("steps") or []
        times = attribution.get("timesSeconds") or []
        check(detail.get("version") == 3,
              f"saved detail is not variable-horizon v3: {video_id}")
        check(len(steps) == max(0, len(times) - 1),
              f"temporal ledger does not cover every emitted transition: {video_id}")
        check(attribution.get("fullStageLadderAvailable") is True and
              attribution.get("channelOrder") == channel_order,
              f"temporal channel ladder is incomplete: {video_id}")
        check(all(math.isclose(
            sum(float((step.get("channelDeltaPoints") or {}).get(name) or 0)
                for name in channel_order),
            float(step.get("predictedDeltaPoints") or 0), abs_tol=1e-4,
        ) for step in steps),
            f"temporal channels do not reconstruct the prediction: {video_id}")
        check(len(attribution.get("componentLedger") or []) == len(components),
              f"temporal ledger does not cover every component: {video_id}")
        check(bool(components) and int(components[0].get("startToken", -1)) == 0 and
              int(components[-1].get("endToken", -1)) == int(detail.get("tokenCount") or -2) and
              all(int(left.get("endToken", -1)) == int(right.get("startToken", -2))
                  for left, right in zip(components, components[1:])),
              f"components are not one contiguous exact cover: {video_id}")
        check(len(detail.get("relationships") or []) == max(0, len(components) - 1),
              f"sequence relationships do not connect adjacent components: {video_id}")
        check(all(len(component.get("categoryDistribution") or []) == 4
                  and len(component.get("categoryCoordinates4D") or []) == 4
                  and component.get("timelineAttribution") is not None
                  and component.get("outcomePlane") is not None
                  and set(component.get("outcomePlanesByLag") or {}) ==
                      {str(value) for value in range(6)}
                  and (component.get("viewerContext") or {}).get(
                      "usesFutureComponents") is False
                  for component in components),
              f"component evidence is incomplete: {video_id}")
        check((detail.get("orderSensitivity") or {}).get("available") is not None,
              f"saved order sensitivity is missing: {video_id}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    artifacts = {
        key: load_json(local_name) for key, (local_name, _) in BROWSER_ARTIFACTS.items()
    }
    models = {name: load_json(name) for name in MODEL_ARTIFACTS}
    errors = validate(artifacts, models)
    predictions = artifacts.get("openingPredictions") or {}
    projection = artifacts.get("manualProjection") or {}
    model = models.get("opening-retention-model.json") or {}
    context_study = models.get("opening-context-study.json") or {}
    status = "complete" if not errors else "error"
    manifest = {
        "version": 10,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "errors": errors,
        "builtAt": int(time.time() * 1000),
        "title": "Promise Lab",
        "description": (
            "One causal Shorts sequence scorer and its closed 208-video library. Structural "
            "decomposition is uncapped; retention is emitted only through seconds supported "
            "by the duration-conditioned source risk set."
        ),
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "surfaces": [
            {"id": "scorer", "label": "Score opening", "role": "gated duration-conditioned inference"},
            {"id": "library", "label": "Opening library", "role": "source-level out-of-fold temporal audit"},
            {"id": "saved", "label": "Saved embedding", "role": "outcome-blind categories plus descriptive response maps"},
        ],
        "scoringContract": {
            "primaryOutput": "predicted entry-indexed retention at the last supported second",
            "analysisHorizonSeconds": model.get("analysisHorizonSeconds"),
            "structuralInputTokenLimit": None,
            "structurallyUncapped": True,
            "predictorVersion": predictions.get("predictorVersion"),
            "featureVersion": predictions.get("featureVersion"),
            "selectedStages": {
                name: family.get("selectedStage")
                for name, family in (model.get("families") or {}).items()
            },
            "savedPredictionPolicy": "out-of-fold",
            "typedPredictionPolicy": "frozen full fit",
            "causalTemporalFormula": (
                "at second t, include only words and components whose causal evidence is complete; "
                "fit and apply the frozen model for the sources still at risk at t"
            ),
            "componentFormula": (
                "one outcome-blind, non-overlapping exact cover; every token has one owner; the "
                "same frozen four-category assignment is used for saved and typed sequences"
            ),
            "relationshipFormula": (
                "ordered adjacent transitions and strictly prior viewer context enter only the "
                "relationship stage; synthetic reorderings are sensitivity tests, not causal claims"
            ),
            "unvalidatedStagesAppliedToHeadline": False,
            "longFormReferenceUsed": False,
            "viewsRole": (model.get("viewsContract") or {}).get("promotionStatus") or "withheld",
        },
        "visualizationContract": {
            "sharedRenderer": "renderAnalysis(analysis, lattice)",
            "typedAndSavedUseSameRenderer": True,
            "temporalTransitionsVisible": True,
            "allFivePredictionChannelsVisible": True,
            "everySelectedComponentVisible": True,
            "savedEmbeddingIntegratedPerComponent": True,
            "componentMeasurementsVisibleWhenObserved": True,
            "priorViewerContextVisible": True,
            "orderingSensitivityVisible": True,
            "fourOutcomePlanesVisible": True,
            "durationConditionedRiskSetVisible": True,
            "validationBySecondVisible": True,
            "unavailableEvidenceIsExplicit": True,
        },
        "counts": {
            "openings": int(predictions.get("sources") or 0),
            "openingComponents": sum(
                int(row.get("componentCount") or 0)
                for row in predictions.get("rows") or []
            ),
            "sequenceRelationships": sum(
                max(0, int(row.get("componentCount") or 0) - 1)
                for row in predictions.get("rows") or []
            ),
            "contextCategories": int(context_study.get("categoryCount") or 0),
            "savedProjectionPoints": len((projection.get("frozenPointIndex") or {}).get("labels") or []),
        },
        "validation": predictions.get("validation"),
        "evidenceBoundary": predictions.get("evidenceBoundary"),
        "artifacts": API_ARTIFACTS,
        "artifactMetadata": {
            key: {
                "file": local_name,
                "status": artifacts[key].get("status"),
                "bytes": (CACHE / local_name).stat().st_size,
                "sha256": sha256(CACHE / local_name),
            }
            for key, (local_name, _) in BROWSER_ARTIFACTS.items()
        },
    }
    progress = {
        "version": 10,
        "productVersion": PRODUCT_VERSION,
        "status": status,
        "stage": "current Shorts Promise Lab published" if not errors else "product validation failed",
        "errors": errors,
        "openingsComplete": int(predictions.get("sources") or 0),
        "surfacesComplete": 3 if not errors else 0,
        "updatedAt": int(time.time() * 1000),
    }
    (CACHE / "manifest.json").write_text(
        json.dumps(json_ready(manifest), separators=(",", ":"), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    (CACHE / "progress.json").write_text(
        json.dumps(json_ready(progress), separators=(",", ":"), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    if errors:
        print(json.dumps({"status": status, "errors": errors}, indent=2))
        raise SystemExit(1)
    if args.no_upload:
        print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))
        return
    remote = R2Store()
    remote.put_json(f"{R2_PREFIX}/manifest.json", manifest)
    remote.put_json(f"{R2_PREFIX}/progress.json", progress)
    for key, (local_name, remote_name) in BROWSER_ARTIFACTS.items():
        remote.put_json(f"{R2_PREFIX}/{remote_name}", artifacts[key], gzip_payload=True)
    for name in MODEL_ARTIFACTS:
        remote.put_json(f"{R2_PREFIX}/{name}.gz", models[name], gzip_payload=True)
    print(json.dumps({"status": status, "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
