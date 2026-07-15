"""Observed sequence-context experiments for the frozen four-category vocabulary."""

from __future__ import annotations

import math

import numpy as np

from context_scoring import context_vector, score_component_context, timing_vector
from hook_outcomes import (
    crossfit_linear,
    fit_full_linear,
    scalar_validation,
)
from hook_score_core import apply_linear_model
from hook_score_core import row_unit


CONTEXT_STUDY_VERSION = "four-cluster-sequence-context-v2"
CATEGORY_COUNT = 4
PRIMARY_LAG_SECONDS = 0
DEFAULT_LAGS = tuple(range(0, 6))
EPS = 1e-9


def _curve_at(record: dict, family: str, second: float) -> float:
    retention = record["retention"]
    times = np.asarray(retention["wholeSeconds"], float)
    values = np.asarray(retention["curvesPercent"][family], float)
    if second < times[0] - EPS or second > times[-1] + EPS:
        return float("nan")
    return float(np.interp(second, times, values))


def build_component_response_rows(records: list[dict],
                                  decompositions: dict[str, dict],
                                  family: str = "entry_indexed",
                                  lags: tuple[int, ...] = DEFAULT_LAGS) -> list[dict]:
    """Create observed response windows without assigning causal meaning."""
    rows = []
    for record in records:
        video_id = str(record["videoId"])
        decomposition = decompositions[video_id]
        duration = float(record["mediaDurationSeconds"])
        for component in decomposition.get("chunks") or []:
            start = float(component["spokenStartSeconds"])
            end = float(component["spokenEndSeconds"])
            if end <= start + EPS:
                continue
            coordinates = np.asarray(component["categoryCoordinates4D"], np.float32)
            if len(coordinates) != CATEGORY_COUNT:
                raise ValueError("component coordinates are not four-dimensional")
            timing = timing_vector(start, end, int(component["index"]))
            context = context_vector(component)
            response = {}
            for lag in lags:
                shifted_start = start + float(lag)
                shifted_end = end + float(lag)
                if shifted_end > duration + EPS:
                    response[str(lag)] = None
                    continue
                before = _curve_at(record, family, shifted_start)
                after = _curve_at(record, family, shifted_end)
                delta = after - before
                response[str(lag)] = {
                    "windowStartSeconds": shifted_start,
                    "windowEndSeconds": shifted_end,
                    "deltaPercentagePoints": float(delta),
                    "slopePercentagePointsPerSecond": float(delta / (end - start)),
                }
            rows.append({
                "videoId": video_id,
                "published": str(record.get("published") or video_id),
                "componentIndex": int(component["index"]),
                "text": str(component.get("text") or ""),
                "category": int(component["category"]),
                "startSeconds": start,
                "endSeconds": end,
                "timingFeatures": timing,
                "semanticFeatures": coordinates,
                "contextFeatures": context,
                "viewerContext": component.get("viewerContext") or {},
                "responseByLag": response,
            })
    return rows


def _grouped_forward_chain(features: np.ndarray, target: np.ndarray,
                           groups: np.ndarray, chronology: np.ndarray,
                           dimensions: int, alpha: float, seed: int,
                           blocks: int = 5) -> dict:
    """Past-to-future evaluation whose source videos never cross a split."""
    features = np.asarray(features, np.float32)
    target = np.asarray(target, np.float32)
    groups = np.asarray(groups).astype(str)
    chronology = np.asarray(chronology).astype(str)
    original_rows = np.arange(len(target))
    finite = np.isfinite(target) & np.all(np.isfinite(features), axis=1)
    features = features[finite]
    target = target[finite]
    groups = groups[finite]
    chronology = chronology[finite]
    original_rows = original_rows[finite]
    unique = sorted(
        set(groups),
        key=lambda group: (min(chronology[groups == group].tolist()), group),
    )
    chunks = [np.asarray(chunk, str) for chunk in np.array_split(unique, blocks) if len(chunk)]
    prediction = np.full(len(finite), np.nan, np.float32)
    baseline = np.full(len(finite), np.nan, np.float32)
    split_rows = []
    for fold in range(1, len(chunks)):
        train_groups = set(np.concatenate(chunks[:fold]).tolist())
        test_groups = set(chunks[fold].tolist())
        train = np.flatnonzero(np.asarray([group in train_groups for group in groups]))
        test = np.flatnonzero(np.asarray([group in test_groups for group in groups]))
        if len(train) < max(8, min(dimensions, features.shape[1]) + 2) or not len(test):
            continue
        model = fit_full_linear(
            features[train], target[train], dimensions=min(dimensions, len(train) - 2),
            alpha=alpha, seed=seed + fold * 101,
        )
        prediction[original_rows[test]] = apply_linear_model(features[test], model)[:, 0]
        baseline[original_rows[test]] = float(np.mean(target[train]))
        split_rows.append({
            "fold": fold - 1,
            "trainSources": len(train_groups),
            "testSources": len(test_groups),
            "trainRows": len(train),
            "testRows": len(test),
        })
    return {"prediction": prediction, "baseline": baseline, "splits": split_rows}


def _compact_validation(value: dict) -> dict:
    omitted = {"predictionOOF", "targetObserved", "baselineOOF"}
    return {key: row for key, row in value.items() if key not in omitted}


def _compact_model(value: dict) -> dict:
    coefficient = np.asarray(value["coefficient"], np.float32)
    if coefficient.ndim == 2 and coefficient.shape[1] == 1:
        coefficient = coefficient[:, 0]
    intercept = np.asarray(value["intercept"], np.float32).reshape(-1)
    return {
        "coefficient": coefficient.astype(float).tolist(),
        "intercept": float(intercept[0]) if len(intercept) == 1 else intercept.astype(float).tolist(),
    }


def _validation_or_unavailable(prediction: np.ndarray, target: np.ndarray,
                               baseline: np.ndarray, seed: int) -> dict:
    prediction = np.asarray(prediction, float)
    target = np.asarray(target, float)
    baseline = np.asarray(baseline, float)
    valid = np.isfinite(prediction + target + baseline)
    if not valid.any():
        return {
            "available": False,
            "rows": 0,
            "reason": "no valid held-out predictions under this split",
        }
    value = _compact_validation(scalar_validation(
        prediction[valid], target[valid], baseline[valid],
        repeats=1024, seed=seed,
    ))
    value.update({"available": True, "rows": int(valid.sum())})
    return value


def _validate_stage(features: np.ndarray, target: np.ndarray, groups: np.ndarray,
                    chronology: np.ndarray, seed: int) -> dict:
    dimensions = max(1, min(16, features.shape[1], len(set(groups)) - 2))
    random = crossfit_linear(
        features, target, groups=groups, folds=5, dimensions=dimensions,
        alpha=10.0, seed=seed,
    )
    random_validation = _validation_or_unavailable(
        random["prediction"], target, random["baselinePrediction"],
        seed + 10001,
    )
    chronological = _grouped_forward_chain(
        features, target, groups, chronology, dimensions, 10.0, seed + 20001,
    )
    chronological_validation = _validation_or_unavailable(
        chronological["prediction"], target, chronological["baseline"],
        seed + 30001,
    )
    full = fit_full_linear(
        features, target, dimensions=dimensions, alpha=10.0, seed=seed + 40001,
    )
    return {
        "random": random,
        "chronological": chronological,
        "full": full,
        "randomValidation": random_validation,
        "chronologicalValidation": chronological_validation,
    }


def _mae_gain(left: np.ndarray, right: np.ndarray, target: np.ndarray) -> float:
    valid = np.isfinite(left + right + target)
    if not valid.any():
        return float("nan")
    return float(
        np.mean(np.abs(left[valid] - target[valid]))
        - np.mean(np.abs(right[valid] - target[valid]))
    )


def _permutation_null(timing_semantic: np.ndarray, context: np.ndarray,
                      target: np.ndarray, groups: np.ndarray, observed_gain: float,
                      repeats: int, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    values = np.empty(repeats, np.float32)
    base = crossfit_linear(
        timing_semantic, target, groups=groups, folds=5,
        dimensions=min(16, timing_semantic.shape[1]), alpha=10.0, seed=seed + 1,
    )["prediction"]
    for repeat in range(repeats):
        shuffled = np.asarray(context, np.float32).copy()
        for group in set(groups.tolist()):
            selected = np.flatnonzero(groups == group)
            if len(selected) > 1:
                shuffled[selected] = shuffled[rng.permutation(selected)]
        combined = np.column_stack([timing_semantic, shuffled])
        prediction = crossfit_linear(
            combined, target, groups=groups, folds=5,
            dimensions=min(16, combined.shape[1]), alpha=10.0, seed=seed + 1,
        )["prediction"]
        values[repeat] = _mae_gain(base, prediction, target)
    return {
        "repeats": int(repeats),
        "observedMAEGainPercentagePointsPerSecond": float(observed_gain),
        "nullMeanMAEGainPercentagePointsPerSecond": float(np.mean(values)),
        "nullP95MAEGainPercentagePointsPerSecond": float(np.quantile(values, .95)),
        "oneSidedP": float((1 + np.sum(values >= observed_gain)) / (repeats + 1)),
        "shuffleUnit": "viewer-history rows permuted only within source video",
        "claimBoundary": "tests predictive ordering information, not causal effects of editing",
    }


def _outcome_plane(rows: list[dict], stage: dict, target: np.ndarray) -> dict:
    coordinates = np.asarray([row["semanticFeatures"] for row in rows], np.float32)
    full_coefficient = np.asarray(stage["full"]["coefficient"], np.float32)
    if full_coefficient.ndim == 2:
        full_coefficient = full_coefficient[:, 0]
    timing_width = len(rows[0]["timingFeatures"])
    direction = full_coefficient[timing_width:timing_width + CATEGORY_COUNT]
    norm = float(np.linalg.norm(direction))
    if norm <= EPS:
        direction = np.zeros(CATEGORY_COUNT, np.float32)
        direction[0] = 1.0
        direction_status = "degenerate fitted semantic direction; deterministic axis fallback"
    else:
        direction = direction / norm
        direction_status = (
            "full-cohort descriptive outcome direction conditional on timing and viewer history"
        )
    x = coordinates @ direction
    residual = coordinates - x[:, None] * direction[None, :]
    _, _, vh = np.linalg.svd(residual - residual.mean(axis=0), full_matrices=False)
    y_direction = vh[0].astype(np.float32)
    y = residual @ y_direction
    pivot = int(np.argmax(np.abs(y))) if len(y) else 0
    if len(y) and y[pivot] < 0:
        y_direction = -y_direction
        y = -y
    order = np.argsort(x, kind="stable")
    percentile = np.empty(len(x), np.float32)
    percentile[order] = np.linspace(0.0, 100.0, len(x), dtype=np.float32)
    prediction = np.asarray(stage["random"]["prediction"], float)
    return {
        "xAxis": "descriptive full-cohort retention-response direction; higher predicts less drop",
        "yAxis": "largest residual semantic direction orthogonal to the response axis",
        "directionStatus": direction_status,
        "orientationUsesOutcomes": True,
        "coordinatesOutOfFold": False,
        "pointPredictionsOutOfFold": True,
        "leakageBoundary": (
            "point predictions are source-grouped OOF; plane orientation and percentile "
            "calibration are full-cohort descriptive quantities and are not validation metrics"
        ),
        "xDirection4D": direction.astype(float).tolist(),
        "yDirection4D": y_direction.astype(float).tolist(),
        "xCalibrationSorted": np.sort(x).astype(float).tolist(),
        "points": [{
            "videoId": row["videoId"],
            "componentIndex": row["componentIndex"],
            "text": row["text"],
            "predecessorCategory": (row["viewerContext"] or {}).get("predecessorCategory"),
            "x": float(x[index]),
            "y": float(y[index]),
            "xPercentile": float(percentile[index]),
            "observedSlopePercentagePointsPerSecond": float(target[index]),
            "oofPredictedSlopePercentagePointsPerSecond": (
                float(prediction[index]) if math.isfinite(prediction[index]) else None
            ),
        } for index, row in enumerate(rows)],
    }


def run_sequence_context_study(response_rows: list[dict],
                               lags: tuple[int, ...] = DEFAULT_LAGS,
                               permutation_repeats: int = 64,
                               seed: int = 20260714) -> dict:
    """Fit all declared lag/category experiments with no semantic relabeling."""
    categories = []
    for category in range(CATEGORY_COUNT):
        category_rows = [row for row in response_rows if row["category"] == category]
        lag_results = []
        primary_plane = None
        for lag in lags:
            rows = []
            for row in category_rows:
                slope = (row["responseByLag"].get(str(lag)) or {}).get(
                    "slopePercentagePointsPerSecond"
                )
                if slope is not None and math.isfinite(float(slope)):
                    rows.append(row)
            if len(rows) < 20 or len(set(row["videoId"] for row in rows)) < 8:
                lag_results.append({
                    "lagSeconds": int(lag), "rows": len(rows),
                    "status": "insufficient source-grouped support",
                })
                continue
            timing = np.asarray([row["timingFeatures"] for row in rows], np.float32)
            semantic = np.asarray([row["semanticFeatures"] for row in rows], np.float32)
            context = np.asarray([row["contextFeatures"] for row in rows], np.float32)
            target = np.asarray([
                row["responseByLag"][str(lag)]["slopePercentagePointsPerSecond"]
                for row in rows
            ], np.float32)
            groups = np.asarray([row["videoId"] for row in rows], str)
            chronology = np.asarray([row["published"] for row in rows], str)
            stage_features = {
                "timing": timing,
                "semantic": np.column_stack([timing, semantic]),
                "viewerContext": np.column_stack([timing, semantic, context]),
            }
            fitted = {
                name: _validate_stage(
                    features, target, groups, chronology,
                    seed + category * 100003 + int(lag) * 1009 + index * 101,
                )
                for index, (name, features) in enumerate(stage_features.items())
            }
            semantic_gain = _mae_gain(
                fitted["timing"]["random"]["prediction"],
                fitted["semantic"]["random"]["prediction"], target,
            )
            context_gain = _mae_gain(
                fitted["semantic"]["random"]["prediction"],
                fitted["viewerContext"]["random"]["prediction"], target,
            )
            chronological_semantic_gain = _mae_gain(
                fitted["timing"]["chronological"]["prediction"],
                fitted["semantic"]["chronological"]["prediction"], target,
            )
            chronological_context_gain = _mae_gain(
                fitted["semantic"]["chronological"]["prediction"],
                fitted["viewerContext"]["chronological"]["prediction"], target,
            )
            context_replication = bool(
                math.isfinite(context_gain)
                and math.isfinite(chronological_context_gain)
                and context_gain > 0.0
                and chronological_context_gain > 0.0
            )
            result = {
                "lagSeconds": int(lag),
                "rows": len(rows),
                "sourceVideos": len(set(groups.tolist())),
                "status": "complete",
                "target": "entry-indexed retention slope over the component window shifted forward by lag",
                "stageValidation": {
                    name: {
                        "randomFold": value["randomValidation"],
                        "chronological": value["chronologicalValidation"],
                    }
                    for name, value in fitted.items()
                },
                "nestedRandomFoldMAEGain": {
                    "timingToSemantic": semantic_gain,
                    "semanticToViewerContext": context_gain,
                },
                "nestedChronologicalMAEGain": {
                    "timingToSemantic": chronological_semantic_gain,
                    "semanticToViewerContext": chronological_context_gain,
                },
                "incrementalViewerContextReplicated": context_replication,
                "replicationStatus": (
                    "positive incremental MAE gain in random and past-to-future folds"
                    if context_replication else
                    "incremental MAE gain did not reproduce in both split families"
                ),
                "viewerContextFullModel": _compact_model(
                    fitted["viewerContext"]["full"]
                ),
                "featureContract": {
                    "timingDimensions": int(timing.shape[1]),
                    "semanticDimensions": int(semantic.shape[1]),
                    "viewerContextDimensions": int(context.shape[1]),
                    "order": "timing, frozen category coordinates, accumulated viewer context",
                    "externalIdeaContextUsed": False,
                },
            }
            result["historyPermutationNull"] = _permutation_null(
                stage_features["semantic"], context, target, groups,
                context_gain, permutation_repeats,
                seed + category * 100003 + int(lag) * 1009 + 70001,
            )
            result["outcomePlane"] = _outcome_plane(
                rows, fitted["viewerContext"], target,
            )
            if lag == PRIMARY_LAG_SECONDS:
                primary_plane = result["outcomePlane"]
            lag_results.append(result)
        categories.append({
            "category": category,
            "frozenCategory": True,
            "componentRows": len(category_rows),
            "primaryLagSeconds": PRIMARY_LAG_SECONDS,
            "primaryOutcomePlane": primary_plane,
            "outcomePlanesByLag": {
                str(row["lagSeconds"]): row.get("outcomePlane")
                for row in lag_results
                if row.get("status") == "complete" and row.get("outcomePlane")
            },
            "lagExperiments": lag_results,
        })
    return {
        "version": CONTEXT_STUDY_VERSION,
        "status": "complete",
        "categoryCount": CATEGORY_COUNT,
        "categoriesChanged": False,
        "primaryLagSeconds": PRIMARY_LAG_SECONDS,
        "testedForwardLagsSeconds": [int(value) for value in lags],
        "categories": categories,
        "claimBoundary": (
            "Observed source-grouped prediction can support an ordering association. "
            "Synthetic swaps and shuffled-history controls are model sensitivity tests, "
            "not randomized causal evidence."
        ),
    }
