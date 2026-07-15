"""Lightweight frozen inference for the four-category sequence-context study."""

from __future__ import annotations

import math

import numpy as np

from hook_score_core import apply_linear_model


CATEGORY_COUNT = 4
EPS = 1e-9


def context_vector(component: dict) -> np.ndarray:
    context = component.get("viewerContext") or {}
    predecessor = np.zeros(CATEGORY_COUNT + 1, np.float32)
    previous = context.get("predecessorCategory")
    predecessor[CATEGORY_COUNT if previous is None else int(previous)] = 1.0
    distribution = np.asarray(
        context.get("categoryDistributionBefore") or [0.0] * CATEGORY_COUNT,
        np.float32,
    )
    if len(distribution) != CATEGORY_COUNT:
        raise ValueError("viewer context category distribution is not four-dimensional")
    predecessor_similarity = context.get("predecessorSemanticSimilarity")
    history_similarity = context.get("historySemanticSimilarity")
    history_change = context.get("historySemanticChange")
    return np.concatenate([
        predecessor,
        distribution,
        np.asarray([
            float(context.get("componentsPreviouslyDelivered") or 0),
            0.0 if predecessor_similarity is None else float(predecessor_similarity),
            0.0 if history_similarity is None else float(history_similarity),
            0.0 if history_change is None else float(history_change),
            float(previous is None),
        ], np.float32),
    ])


def timing_vector(start: float, end: float, position: int) -> np.ndarray:
    duration = max(EPS, end - start)
    return np.asarray([
        start, math.sqrt(max(0.0, start)), math.log1p(max(0.0, start)),
        duration, math.sqrt(duration), math.log1p(duration),
        float(position), math.log1p(max(0, int(position))),
    ], np.float32)


def score_component_context(component: dict, study: dict) -> dict | None:
    """Apply one frozen category-specific context model to a component."""
    category = int(component.get("category", -1))
    category_rows = {
        int(row["category"]): row for row in study.get("categories") or []
    }
    category_study = category_rows.get(category)
    if category_study is None:
        return None
    start = float(component.get("spokenStartSeconds") or 0.0)
    end = float(component.get("spokenEndSeconds") or start)
    timing = timing_vector(start, end, int(component.get("index") or 0))
    semantic = np.asarray(component.get("categoryCoordinates4D") or [], np.float32)
    if len(semantic) != CATEGORY_COUNT:
        return None
    context = context_vector(component)
    features = np.concatenate([timing, semantic, context]).astype(np.float32)
    by_lag = {}
    for experiment in category_study.get("lagExperiments") or []:
        if experiment.get("status") != "complete":
            continue
        lag = int(experiment.get("lagSeconds", 0))
        plane = experiment.get("outcomePlane") or (
            category_study.get("primaryOutcomePlane") or {}
            if lag == int(study.get("primaryLagSeconds", 0)) else {}
        )
        if not plane or not experiment.get("viewerContextFullModel"):
            continue
        prediction = float(apply_linear_model(
            features[None, :], experiment["viewerContextFullModel"],
        )[0, 0])
        x_direction = np.asarray(plane["xDirection4D"], np.float32)
        y_direction = np.asarray(plane["yDirection4D"], np.float32)
        x = float(semantic @ x_direction)
        residual = semantic - x * x_direction
        y = float(residual @ y_direction)
        calibration = np.asarray(plane.get("xCalibrationSorted") or [], float)
        by_lag[str(lag)] = {
            "category": category,
            "lagSeconds": lag,
            "predictedRetentionSlopePercentagePointsPerSecond": prediction,
            "x": x,
            "y": y,
            "xPercentile": (
                float(np.searchsorted(calibration, x, side="right") / len(calibration) * 100.0)
                if len(calibration) else None
            ),
            "xAxis": plane.get("xAxis"),
            "yAxis": plane.get("yAxis"),
            "externalIdeaContextUsed": False,
            "claimBoundary": (
                "frozen observational context model; a prediction is not a causal claim "
                "about moving or rewriting this component"
            ),
        }
    primary = by_lag.get(str(int(study.get("primaryLagSeconds", 0))))
    if primary is None:
        return None
    return {**primary, "predictionsByLag": by_lag}
