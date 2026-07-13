"""Frozen cross-source market reward primitives for hook text.

The reward is deliberately simpler than the Promise Lab decomposition.  A
complete hook receives one Gemini text embedding, one linear projection, and
one percentile on a frozen external ladder.  Component and relationship values
are exact local counterfactuals from that same scalar model.
"""

from __future__ import annotations

import re

import numpy as np
from scipy.stats import spearmanr
from sklearn.decomposition import PCA
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.model_selection import GroupKFold, KFold

from hook_outcomes import (
    chronological_splits,
    rank_permutation_inference,
    scalar_validation,
)
from hook_score_core import percentile, row_unit


MARKET_SEED = 20260712
ALPHA_CANDIDATES = (0.1, 1.0, 10.0, 100.0, 1000.0)
EPS = 1e-9


def canonical_transcript(text: str) -> str:
    """Canonicalize only for leakage grouping, never for embedding."""
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def connected_source_groups(channels: list[str], transcripts: list[str]) -> np.ndarray:
    """Keep copies and videos from one channel in the same validation fold."""
    if len(channels) != len(transcripts):
        raise ValueError("channels and transcripts differ")
    parent = list(range(len(channels)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left = find(left)
        right = find(right)
        if left != right:
            parent[right] = left

    seen_channel: dict[str, int] = {}
    seen_text: dict[str, int] = {}
    for index, (channel, transcript) in enumerate(zip(channels, transcripts)):
        channel_key = str(channel or f"unknown-channel:{index}")
        text_key = canonical_transcript(transcript) or f"empty-transcript:{index}"
        for key, seen in ((channel_key, seen_channel), (text_key, seen_text)):
            if key in seen:
                union(index, seen[key])
            else:
                seen[key] = index
    return np.asarray([find(index) for index in range(len(parent))], np.int32)


def _direction_stability(directions: list[np.ndarray]) -> dict:
    cosines = [
        float(directions[left] @ directions[right])
        for left in range(len(directions))
        for right in range(left + 1, len(directions))
    ]
    return {
        "medianCosine": float(np.median(cosines)) if cosines else None,
        "positiveFraction": float(np.mean(np.asarray(cosines) > 0)) if cosines else None,
    }


def _selection_key(row: dict) -> tuple:
    return (
        row["heldoutSpearman"],
        float((row.get("directionStability") or {}).get("medianCosine") or -1),
        -row["alpha"],
    )


def _grouped_alpha_validation(features: np.ndarray, target: np.ndarray,
                              groups: np.ndarray, alpha: float,
                              folds: int) -> dict:
    prediction = np.full(len(target), np.nan, np.float32)
    directions = []
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    for train, test in splitter.split(features, target, groups):
        model = Ridge(alpha=float(alpha), solver="lsqr", tol=1e-5).fit(
            features[train], target[train],
        )
        prediction[test] = model.predict(features[test])
        direction = np.asarray(model.coef_, np.float32)
        directions.append(direction / (np.linalg.norm(direction) + EPS))
    rank = spearmanr(prediction, target)
    residual = target - prediction
    return {
        "alpha": float(alpha),
        "heldoutSpearman": float(rank.statistic),
        "heldoutSpearmanP": float(rank.pvalue),
        "heldoutMAELog10Views": float(np.mean(np.abs(residual))),
        "heldoutRMSELog10Views": float(np.sqrt(np.mean(residual ** 2))),
        "directionStability": _direction_stability(directions),
        "predictionOOF": prediction,
    }


def fit_external_axis(features: np.ndarray, target: np.ndarray,
                      groups: np.ndarray, folds: int = 5) -> dict:
    """Validate nested grouped selection, then freeze one external-only axis."""
    features = row_unit(np.asarray(features, np.float32))
    target = np.asarray(target, np.float32)
    groups = np.asarray(groups).astype(str)
    if len(features) != len(target) or len(target) != len(groups):
        raise ValueError("external features, targets, and groups differ")
    rows = [
        _grouped_alpha_validation(features, target, groups, alpha, folds)
        for alpha in ALPHA_CANDIDATES
    ]
    selected = max(rows, key=_selection_key)

    # The quoted validation never sees its own selected regularization. Each
    # outer test group is predicted after alpha selection on outer-train groups.
    nested_prediction = np.full(len(target), np.nan, np.float32)
    nested_directions = []
    selected_counts = {str(alpha): 0 for alpha in ALPHA_CANDIDATES}
    outer = GroupKFold(n_splits=min(folds, len(set(groups))))
    outer_rows = []
    for fold, (train, test) in enumerate(outer.split(features, target, groups)):
        train_groups = groups[train]
        inner_folds = min(folds, len(set(train_groups)))
        inner_rows = [
            _grouped_alpha_validation(
                features[train], target[train], train_groups, alpha, inner_folds,
            ) for alpha in ALPHA_CANDIDATES
        ]
        inner_selected = max(inner_rows, key=_selection_key)
        alpha = float(inner_selected["alpha"])
        selected_counts[str(alpha)] += 1
        model = Ridge(alpha=alpha, solver="lsqr", tol=1e-5).fit(
            features[train], target[train],
        )
        nested_prediction[test] = model.predict(features[test])
        direction = np.asarray(model.coef_, np.float32)
        nested_directions.append(direction / (np.linalg.norm(direction) + EPS))
        outer_rows.append({
            "fold": int(fold),
            "trainRows": int(len(train)),
            "testRows": int(len(test)),
            "trainGroups": int(len(set(train_groups))),
            "testGroups": int(len(set(groups[test]))),
            "selectedAlpha": alpha,
        })
    nested_rank = spearmanr(nested_prediction, target)
    nested_residual = target - nested_prediction
    nested_validation = {
        "heldoutSpearman": float(nested_rank.statistic),
        "heldoutSpearmanP": float(nested_rank.pvalue),
        "heldoutMAELog10Views": float(np.mean(np.abs(nested_residual))),
        "heldoutRMSELog10Views": float(np.sqrt(np.mean(nested_residual ** 2))),
        "directionStability": _direction_stability(nested_directions),
        "validationDesign": (
            "nested channel-and-duplicate-grouped five-fold validation; alpha is "
            "selected only inside each outer training fold"
        ),
        "hyperparametersSelectedInsideOuterTrain": True,
        "outerSelectedAlphaCounts": selected_counts,
        "outerFolds": outer_rows,
    }
    model = Ridge(
        alpha=float(selected["alpha"]), solver="lsqr", tol=1e-5,
    ).fit(features, target)
    coefficient = np.asarray(model.coef_, np.float32)
    prediction = model.predict(features).astype(np.float32)
    direction = coefficient / (np.linalg.norm(coefficient) + EPS)
    residual_features = features - (features @ direction)[:, None] * direction[None, :]
    map_direction = PCA(
        n_components=1, svd_solver="randomized", random_state=MARKET_SEED,
    ).fit(residual_features).components_[0].astype(np.float32)
    background = residual_features @ map_direction
    pivot = int(np.argmax(np.abs(background)))
    if background[pivot] < 0:
        map_direction = -map_direction
    return {
        "coefficient": coefficient,
        "intercept": float(model.intercept_),
        "trainingPrediction": prediction,
        "ladder": np.sort(prediction),
        "predictionMean": float(np.mean(prediction)),
        "predictionStd": float(np.std(prediction)),
        "mapDirection": map_direction,
        "selectedAlpha": float(selected["alpha"]),
        "selection": [{
            key: value for key, value in row.items() if key != "predictionOOF"
        } for row in rows],
        "fullDataSelectionValidation": {
            key: value for key, value in selected.items() if key != "predictionOOF"
        },
        "selectedValidation": nested_validation,
        "selectedPredictionOOF": nested_prediction,
    }


def leave_one_out_nearest(features: np.ndarray, block: int = 256) -> np.ndarray:
    features = row_unit(np.asarray(features, np.float32))
    nearest = np.full(len(features), -np.inf, np.float32)
    for start in range(0, len(features), block):
        stop = min(len(features), start + block)
        similarity = features[start:stop] @ features.T
        rows = np.arange(stop - start)
        similarity[rows, np.arange(start, stop)] = -np.inf
        nearest[start:stop] = np.max(similarity, axis=1)
    return nearest


def _compact_validation(validation: dict) -> dict:
    omit = {"predictionOOF", "targetObserved", "baselineOOF"}
    return {key: value for key, value in validation.items() if key not in omit}


def fixed_transfer_validation(score: np.ndarray, target: np.ndarray,
                              chronology: np.ndarray, seed: int) -> dict:
    """Evaluate a fully external score on owned outcomes without refitting it."""
    score = np.asarray(score, float)
    target = np.asarray(target, float)
    chronology = np.asarray(chronology).astype(str)
    rank = spearmanr(score, target)
    inference = rank_permutation_inference(score, target, repeats=4096, seed=seed)
    order = np.argsort(chronology, kind="stable")
    blocks = []
    for index, selected in enumerate(np.array_split(order, 5)):
        block_rank = spearmanr(score[selected], target[selected])
        dates = sorted(chronology[selected].tolist())
        blocks.append({
            "block": index,
            "rows": int(len(selected)),
            "from": dates[0],
            "through": dates[-1],
            "spearman": float(block_rank.statistic),
            "spearmanP": float(block_rank.pvalue),
        })
    recent = order[len(order) // 2:]
    recent_rank = spearmanr(score[recent], target[recent])
    return {
        "rows": int(len(target)),
        "heldoutSpearman": float(rank.statistic),
        "heldoutSpearmanP": float(rank.pvalue),
        "rankPermutationP": float(inference["p"]),
        "chronologicalBlocks": blocks,
        "positiveBlockFraction": float(np.mean([
            row["spearman"] > 0 for row in blocks
        ])),
        "recentHalfRows": int(len(recent)),
        "recentHalfSpearman": float(recent_rank.statistic),
        "recentHalfSpearmanP": float(recent_rank.pvalue),
        "claim": (
            "cross-source transfer of one frozen external score; no owned outcome "
            "was used to fit or select the score direction"
        ),
    }


def fit_monotone_calibration(score_z: np.ndarray, target: np.ndarray,
                             chronology: np.ndarray, seed: int) -> dict:
    """Map the fixed ranking to interpretable units without changing direction."""
    score_z = np.asarray(score_z, np.float32)
    target = np.asarray(target, np.float32)
    prediction = np.full(len(target), np.nan, np.float32)
    baseline = np.full(len(target), np.nan, np.float32)
    for train, test in KFold(
        n_splits=5, shuffle=True, random_state=seed,
    ).split(score_z):
        model = LinearRegression(positive=True).fit(score_z[train, None], target[train])
        prediction[test] = model.predict(score_z[test, None])
        baseline[test] = float(np.mean(target[train]))
    random_validation = scalar_validation(
        prediction, target, baseline, repeats=4096, seed=seed + 1,
    )
    future_prediction = np.full(len(target), np.nan, np.float32)
    future_baseline = np.full(len(target), np.nan, np.float32)
    split_rows = []
    for fold, (train, test) in enumerate(chronological_splits(chronology, 5)):
        model = LinearRegression(positive=True).fit(score_z[train, None], target[train])
        future_prediction[test] = model.predict(score_z[test, None])
        future_baseline[test] = float(np.mean(target[train]))
        split_rows.append({"fold": fold, "trainRows": len(train), "testRows": len(test)})
    future_validation = scalar_validation(
        future_prediction, target, future_baseline, repeats=4096, seed=seed + 2,
    )
    future_validation["splits"] = split_rows
    fitted = LinearRegression(positive=True).fit(score_z[:, None], target)
    residual = target - prediction
    return {
        "coefficient": float(fitted.coef_[0]),
        "intercept": float(fitted.intercept_),
        "residualP10": float(np.quantile(residual, .1)),
        "residualP90": float(np.quantile(residual, .9)),
        "validation": _compact_validation(random_validation),
        "chronologicalValidation": _compact_validation(future_validation),
        "predictionOOF": prediction,
    }


def score_market_vector(vector: np.ndarray, model: dict,
                        include_diagnostics: bool = True) -> dict:
    feature = row_unit(np.asarray(vector, np.float32))
    coefficient = np.asarray(model["coefficient"], np.float32)
    coordinate = float(feature @ coefficient + float(model["intercept"]))
    score_std = max(float(model["scoreScale"]["predictionStd"]), EPS)
    score_mean = float(model["scoreScale"]["predictionMean"])
    z = float((coordinate - score_mean) / score_std)
    ladder = np.asarray(model["ladder"], float)
    score_percentile = percentile(ladder, coordinate)
    references = row_unit(np.asarray(model["domainReferenceEmbeddings"], np.float32))
    similarities = references @ feature
    nearest_index = int(np.argmax(similarities))
    nearest = float(similarities[nearest_index])
    floor = float(model["domainGate"]["nearestCosineMinimum"])
    caution = float(model["domainGate"]["nearestCosineP10"])
    predictions = {}
    for target, calibration in (model.get("calibrations") or {}).items():
        prediction = (
            float(calibration["coefficient"]) * z
            + float(calibration["intercept"])
        )
        predictions[target] = {
            "prediction": prediction,
            "predictionP10": prediction + float(calibration["residualP10"]),
            "predictionP90": prediction + float(calibration["residualP90"]),
        }
        if include_diagnostics:
            predictions[target]["validation"] = calibration["validation"]
            predictions[target]["chronologicalValidation"] = calibration[
                "chronologicalValidation"
            ]
    domain_eligible = bool(nearest >= floor)
    model_eligible = model["status"] == "validated-cross-source-local-retention-proxy"
    eligible = bool(domain_eligible and model_eligible)
    result = {
        "status": model["status"],
        "label": "Market Hold",
        "coordinate": coordinate,
        "z": z,
        "percentile": score_percentile,
        "reward": score_percentile / 100.0 if eligible else None,
        "eligibleForTraining": eligible,
        "modelEligibleForTraining": model_eligible,
        "domainEligibleForTraining": domain_eligible,
        "domainNearestCosine": nearest,
        "domainFloor": floor,
        "domainCautionP10": caution,
        "domainBelowCautionP10": bool(nearest < caution),
        "domainReferenceVideoId": model["domainReferenceIds"][nearest_index],
        "domainReferenceText": model["domainReferenceTexts"][nearest_index],
        "mapX": coordinate,
        "mapY": float(feature @ np.asarray(model["mapDirection"], np.float32)),
        "calibratedOutcomes": predictions,
        "contract": model["rewardContract"],
    }
    if include_diagnostics:
        result["validation"] = model["transferValidation"]
    return result


def local_market_effects(full: np.ndarray, without_one: dict[int, np.ndarray],
                         without_pair: dict[tuple[int, int], np.ndarray],
                         categories: list[int], model: dict) -> dict:
    coefficient = np.asarray(model["coefficient"], np.float32)
    scale = max(float(model["scoreScale"]["predictionStd"]), EPS)
    full_coordinate = float(row_unit(full) @ coefficient + float(model["intercept"]))
    one_coordinate = {
        index: float(row_unit(value) @ coefficient + float(model["intercept"]))
        for index, value in without_one.items()
    }
    pair_coordinate = {
        key: float(row_unit(value) @ coefficient + float(model["intercept"]))
        for key, value in without_pair.items()
    }
    component_calibration = (model.get("localCalibration") or {}).get(
        "componentsByCategory", {}
    )
    pair_calibration = (model.get("localCalibration") or {}).get(
        "pairsByCategorySequence", {}
    )
    components = []
    for index in range(len(categories)):
        effect = (full_coordinate - one_coordinate[index]) / scale
        samples = np.asarray(component_calibration.get(str(categories[index])) or [], float)
        components.append({
            "component": index,
            "category": int(categories[index]),
            "effectZ": float(effect),
            "percentile": percentile(samples, effect) if len(samples) else None,
            "fullCoordinate": full_coordinate,
            "withoutCoordinate": one_coordinate[index],
            "definition": "MarketHold(full) - MarketHold(without component), in frozen score SD",
        })
    relationships = []
    for left in range(len(categories)):
        for right in range(left + 1, len(categories)):
            interaction = (
                full_coordinate - one_coordinate[left] - one_coordinate[right]
                + pair_coordinate[(left, right)]
            ) / scale
            sequence = f"{categories[left]}->{categories[right]}"
            samples = np.asarray(pair_calibration.get(sequence) or [], float)
            relationships.append({
                "left": left,
                "right": right,
                "categorySequence": sequence,
                "interactionZ": float(interaction),
                "percentile": percentile(samples, interaction) if len(samples) else None,
                "fullCoordinate": full_coordinate,
                "withoutLeftCoordinate": one_coordinate[left],
                "withoutRightCoordinate": one_coordinate[right],
                "withoutBothCoordinate": pair_coordinate[(left, right)],
                "definition": (
                    "full - without left - without right + without both, "
                    "in frozen Market Hold score SD"
                ),
            })
    return {"components": components, "relationships": relationships}
