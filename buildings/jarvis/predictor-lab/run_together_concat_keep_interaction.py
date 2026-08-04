#!/usr/bin/env python3
"""Evaluate the stored Together keep score with channel-free concat.

The script consumes a previously materialized saved-channel validation artifact.
It never reads chart state and never lets an outer test row choose a formula.
Candidate selection happens in four training-only folds inside each of five
content-family-held-out outer folds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import pearsonr, spearmanr
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler


COORDINATE_ID = "shorts.interaction.together-channel-free-concat.keep.v1"
SOURCE_IDS = (
    "shorts.stored.together.keep",
    "shorts.channel-free.concat.keep",
)
SENSITIVITY_SOURCE_ID = "shorts.video-heldout.together.keep"
TARGET_ID = "shorts.observed.keep"
ALPHAS = (0.01, 0.1, 1.0, 10.0, 100.0, 1000.0)
CONVEX_WEIGHTS = tuple(round(value, 2) for value in np.linspace(0.1, 0.9, 9))
INTERACTION_FEATURES = (
    "together",
    "concat",
    "together_x_concat",
    "together_div_concat",
    "log_together_div_concat",
    "absolute_difference",
    "minimum",
    "maximum",
)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def identity_sha256(values: list[str]) -> str:
    return sha256_bytes(stable_json(sorted(str(value) for value in values)).encode())


def split_audit(
    rows: list[dict[str, Any]],
    train: np.ndarray,
    test: np.ndarray,
) -> dict[str, Any]:
    train_ids = [str(rows[index]["id"]) for index in train]
    test_ids = [str(rows[index]["id"]) for index in test]
    train_families = [content_family(rows[index]) for index in train]
    test_families = [content_family(rows[index]) for index in test]
    return {
        "trainingRowCount": len(train_ids),
        "testingRowCount": len(test_ids),
        "trainingVideoIdSha256": identity_sha256(train_ids),
        "testingVideoIdSha256": identity_sha256(test_ids),
        "trainingContentFamilySha256": identity_sha256(train_families),
        "testingContentFamilySha256": identity_sha256(test_families),
        "videoIdOverlapCount": len(set(train_ids) & set(test_ids)),
        "contentFamilyOverlapCount": len(set(train_families) & set(test_families)),
    }


def fnv1a_32(value: str) -> int:
    output = 2166136261
    for character in str(value):
        output ^= ord(character)
        output = (output * 16777619) & 0xFFFFFFFF
    return output


def content_family(row: dict[str, Any]) -> str:
    return str(row.get("contentFamilyId") or row.get("id") or "missing")


def assign_folds(rows: list[dict[str, Any]], requested: int, salt: str) -> np.ndarray:
    groups: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        groups.setdefault(content_family(row), []).append(index)
    fold_count = min(max(2, requested), len(groups))
    states = [0] * fold_count
    assignments = np.full(len(rows), -1, dtype=int)
    ordered = sorted(
        groups.items(),
        key=lambda item: (-len(item[1]), fnv1a_32(f"{salt}:{item[0]}"), item[0]),
    )
    for _, indices in ordered:
        fold = min(range(fold_count), key=lambda value: (states[value], value))
        assignments[indices] = fold
        states[fold] += len(indices)
    return assignments


def feature_matrix(values: np.ndarray, kind: str) -> np.ndarray:
    together, concat = values[:, 0], values[:, 1]
    if kind == "linear":
        return np.column_stack([together, concat])
    if kind == "interaction":
        safe_concat = np.clip(concat, 1e-6, None)
        return np.column_stack([
            together,
            concat,
            together * concat,
            together / safe_concat,
            np.log(np.clip(together, 1e-6, None) / safe_concat),
            np.abs(together - concat),
            np.minimum(together, concat),
            np.maximum(together, concat),
        ])
    if kind == "single_together":
        return together[:, None]
    if kind == "single_concat":
        return concat[:, None]
    raise ValueError(f"Unknown feature kind: {kind}")


def predict_config(
    config: dict[str, Any],
    train_x: np.ndarray,
    train_y: np.ndarray,
    test_x: np.ndarray,
) -> tuple[np.ndarray, dict[str, Any] | None]:
    kind = config["kind"]
    if kind == "mean":
        return np.mean(test_x, axis=1), None
    if kind == "geometric_mean":
        return np.sqrt(np.clip(test_x[:, 0] * test_x[:, 1], 0, None)), None
    if kind == "convex":
        weight = float(config["togetherWeight"])
        return weight * test_x[:, 0] + (1 - weight) * test_x[:, 1], None
    feature_kind = str(config["features"])
    train_features = feature_matrix(train_x, feature_kind)
    test_features = feature_matrix(test_x, feature_kind)
    scaler = StandardScaler().fit(train_features)
    model = Ridge(alpha=float(config["alpha"])).fit(
        scaler.transform(train_features), train_y
    )
    prediction = np.clip(model.predict(scaler.transform(test_features)), 0, 100)
    return prediction, {
        "featureKind": feature_kind,
        "featureMean": np.round(scaler.mean_, 10).tolist(),
        "featureScale": np.round(scaler.scale_, 10).tolist(),
        "coefficients": np.round(model.coef_, 10).tolist(),
        "intercept": round(float(model.intercept_), 10),
        "alpha": float(config["alpha"]),
    }


def metric_row(actual: np.ndarray, predicted: np.ndarray) -> dict[str, Any]:
    error = predicted - actual
    total = float(np.sum((actual - np.mean(actual)) ** 2))
    return {
        "n": int(len(actual)),
        "mae": round(float(np.mean(np.abs(error))), 4),
        "rmse": round(float(np.sqrt(np.mean(error ** 2))), 4),
        "r2": round(float(1 - np.sum(error ** 2) / total), 4) if total > 0 else None,
        "spearman": round(float(spearmanr(actual, predicted).statistic), 4),
        "pearson": round(float(pearsonr(actual, predicted).statistic), 4),
        "bias": round(float(np.mean(error)), 4),
        "predictionRange": round(float(np.ptp(predicted)), 4),
        "actualRange": round(float(np.ptp(actual)), 4),
        "within5pp": round(float(np.mean(np.abs(error) <= 5)), 4),
        "within10pp": round(float(np.mean(np.abs(error) <= 10)), 4),
    }


def combined_configs() -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = [
        {"id": "fixed.mean", "kind": "mean"},
        {"id": "fixed.geometric-mean", "kind": "geometric_mean"},
    ]
    configs.extend({
        "id": f"fixed.convex.{weight:.2f}",
        "kind": "convex",
        "togetherWeight": weight,
    } for weight in CONVEX_WEIGHTS)
    for features in ("linear", "interaction"):
        configs.extend({
            "id": f"ridge.{features}.alpha-{alpha:g}",
            "kind": "ridge",
            "features": features,
            "alpha": alpha,
        } for alpha in ALPHAS)
    return configs


def single_configs(feature_kind: str) -> list[dict[str, Any]]:
    return [{
        "id": f"ridge.{feature_kind}.alpha-{alpha:g}",
        "kind": "ridge",
        "features": feature_kind,
        "alpha": alpha,
    } for alpha in ALPHAS]


def select_config(
    rows: list[dict[str, Any]],
    values: np.ndarray,
    actual: np.ndarray,
    indices: np.ndarray,
    configs: list[dict[str, Any]],
    salt: str,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    subset_rows = [rows[index] for index in indices]
    folds = assign_folds(subset_rows, 4, salt)
    fold_audit = []
    for fold in sorted(set(folds.tolist())):
        inner_train = indices[folds != fold]
        inner_test = indices[folds == fold]
        fold_audit.append({
            "fold": int(fold),
            **split_audit(rows, inner_train, inner_test),
        })
    scores = []
    for config in configs:
        prediction = np.full(len(indices), np.nan)
        for fold in sorted(set(folds.tolist())):
            inner_train = indices[folds != fold]
            inner_test_positions = np.where(folds == fold)[0]
            inner_test = indices[inner_test_positions]
            predicted, _ = predict_config(
                config,
                values[inner_train],
                actual[inner_train],
                values[inner_test],
            )
            prediction[inner_test_positions] = predicted
        scores.append({
            "config": config,
            "metrics": metric_row(actual[indices], prediction),
        })
    scores.sort(key=lambda item: (item["metrics"]["mae"], item["config"]["id"]))
    return scores[0]["config"], scores, fold_audit


def nested_oof(
    rows: list[dict[str, Any]],
    values: np.ndarray,
    actual: np.ndarray,
    configs: list[dict[str, Any]],
    outer_folds: np.ndarray,
    label: str,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    predictions = np.full(len(rows), np.nan)
    selections = []
    for fold in sorted(set(outer_folds.tolist())):
        train = np.where(outer_folds != fold)[0]
        test = np.where(outer_folds == fold)[0]
        selected, scores, inner_fold_audit = select_config(
            rows, values, actual, train, configs, f"inner:{label}:{fold}"
        )
        predicted, _ = predict_config(
            selected, values[train], actual[train], values[test]
        )
        predictions[test] = predicted
        selections.append({
            "fold": int(fold),
            "trainRows": int(len(train)),
            "testRows": int(len(test)),
            "populationAudit": split_audit(rows, train, test),
            "innerFoldAudit": inner_fold_audit,
            "selected": selected,
            "innerTopFive": scores[:5],
        })
    return predictions, selections


def paired_bootstrap(
    actual: np.ndarray,
    candidate: np.ndarray,
    baseline: np.ndarray,
    draws: int = 20000,
) -> dict[str, Any]:
    rng = np.random.default_rng(20260804)
    difference = np.abs(baseline - actual) - np.abs(candidate - actual)
    sampled = np.empty(draws)
    for draw in range(draws):
        sampled[draw] = float(np.mean(difference[rng.integers(0, len(actual), len(actual))]))
    return {
        "definition": "baseline absolute error minus candidate absolute error; positive favors candidate",
        "meanImprovementPp": round(float(np.mean(difference)), 4),
        "ci95": [round(float(value), 4) for value in np.quantile(sampled, [0.025, 0.975])],
        "probabilityCandidateImproves": round(float(np.mean(sampled > 0)), 4),
        "draws": draws,
        "seed": 20260804,
    }


def quadrant_summary(
    values: np.ndarray,
    actual: np.ndarray,
    outer_folds: np.ndarray,
) -> dict[str, Any]:
    labels = [None] * len(actual)
    thresholds = []
    for fold in sorted(set(outer_folds.tolist())):
        train = outer_folds != fold
        test = np.where(outer_folds == fold)[0]
        low = np.quantile(values[train], 0.25, axis=0)
        high = np.quantile(values[train], 0.75, axis=0)
        thresholds.append({
            "fold": int(fold),
            "low": np.round(low, 4).tolist(),
            "high": np.round(high, 4).tolist(),
        })
        for index in test:
            if np.all(values[index] >= high):
                labels[index] = "both_high"
            elif np.all(values[index] <= low):
                labels[index] = "both_low"
            else:
                labels[index] = "mixed"
    groups = {}
    for label in ("both_high", "mixed", "both_low"):
        selected = np.asarray([value == label for value in labels])
        groups[label] = {
            "n": int(np.sum(selected)),
            "meanActualKeep": round(float(np.mean(actual[selected])), 4) if np.any(selected) else None,
            "medianActualKeep": round(float(np.median(actual[selected])), 4) if np.any(selected) else None,
        }
    return {
        "definition": "25th and 75th percentile thresholds are learned inside each outer training fold, then applied to that fold's unseen videos.",
        "thresholds": thresholds,
        "groups": groups,
    }


def fit_final_model(
    rows: list[dict[str, Any]],
    values: np.ndarray,
    actual: np.ndarray,
    configs: list[dict[str, Any]],
) -> dict[str, Any]:
    indices = np.arange(len(rows))
    selected, scores, fold_audit = select_config(
        rows, values, actual, indices, configs, "final-selection"
    )
    _, fitted = predict_config(selected, values, actual, values)
    return {
        "status": "prospective-candidate-not-canonical",
        "selected": selected,
        "selectionTopFive": scores[:5],
        "selectionFoldAudit": fold_audit,
        "fittedFormula": fitted,
        "warning": "This all-row fit is stored only so a future prospective test can freeze it. Historical ledger values use nested outer-fold predictions, not this reconstruction.",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation-artifact", required=True)
    parser.add_argument(
        "--output",
        default=str(Path(__file__).with_name("together-concat-keep-interaction.json")),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_path = Path(args.validation_artifact)
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    columns = (source.get("coordinateRegistry") or {}).get("columns") or []
    coordinate_ids = [column.get("id") for column in columns]
    required = [TARGET_ID, *SOURCE_IDS, SENSITIVITY_SOURCE_ID]
    missing = [coordinate_id for coordinate_id in required if coordinate_id not in coordinate_ids]
    if missing:
        raise RuntimeError(f"Validation artifact is missing: {', '.join(missing)}")
    indexes = {coordinate_id: coordinate_ids.index(coordinate_id) for coordinate_id in required}
    rows = []
    for row in source.get("rows") or []:
        if row.get("accountId") != "tyler":
            continue
        values = (row.get("scoreLedger") or {}).get("values") or []
        selected = [values[indexes[coordinate_id]] for coordinate_id in required]
        if all(value is not None and np.isfinite(float(value)) for value in selected):
            rows.append(row)
    if len(rows) < 40:
        raise RuntimeError("At least 40 complete Tyler rows are required")

    def ledger_values(coordinate_id: str) -> np.ndarray:
        index = indexes[coordinate_id]
        return np.asarray([float(row["scoreLedger"]["values"][index]) for row in rows])

    actual = ledger_values(TARGET_ID)
    values = np.column_stack([ledger_values(coordinate_id) for coordinate_id in SOURCE_IDS])
    sensitivity_values = np.column_stack([
        ledger_values(SENSITIVITY_SOURCE_ID),
        ledger_values(SOURCE_IDS[1]),
    ])
    outer_folds = assign_folds(rows, 5, "outer")
    configs = combined_configs()
    combined_prediction, selections = nested_oof(
        rows, values, actual, configs, outer_folds, "combined"
    )
    calibrated_together, together_selections = nested_oof(
        rows,
        values,
        actual,
        single_configs("single_together"),
        outer_folds,
        "together-only",
    )
    calibrated_concat, concat_selections = nested_oof(
        rows,
        values,
        actual,
        single_configs("single_concat"),
        outer_folds,
        "concat-only",
    )
    sensitivity_prediction, sensitivity_selections = nested_oof(
        rows,
        sensitivity_values,
        actual,
        configs,
        outer_folds,
        "video-heldout-sensitivity",
    )
    fixed_mean = np.mean(values, axis=1)

    together_residual = actual - Ridge(alpha=0.01).fit(
        values[:, :1], actual
    ).predict(values[:, :1])
    concat_residual = values[:, 1] - Ridge(alpha=0.01).fit(
        values[:, :1], values[:, 1]
    ).predict(values[:, :1])
    partial = pearsonr(together_residual, concat_residual)
    data_identity = sha256_bytes(stable_json([
        {
            "id": row["id"],
            "contentFamilyId": content_family(row),
            "actualKeep": float(actual[index]),
            "storedTogetherKeep": float(values[index, 0]),
            "channelFreeConcatKeep": float(values[index, 1]),
            "videoHeldoutTogetherKeep": float(sensitivity_values[index, 0]),
        }
        for index, row in enumerate(rows)
    ]).encode())
    generator_source_sha256 = sha256_bytes(Path(__file__).read_bytes())
    candidate_identity = sha256_bytes(stable_json({
        "candidates": configs,
        "interactionFeatures": INTERACTION_FEATURES,
        "generatorSourceSha256": generator_source_sha256,
    }).encode())
    run_id = sha256_bytes(stable_json({
        "dataIdentity": data_identity,
        "candidateIdentity": candidate_identity,
        "outerFolds": outer_folds.tolist(),
        "target": TARGET_ID,
    }).encode())[:16]
    artifact = {
        "schema": "together-concat-keep-interaction-v1",
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "predictor-lab/run_together_concat_keep_interaction.py",
        "generatorSourceSha256": generator_source_sha256,
        "coordinateId": COORDINATE_ID,
        "question": "Does combining the stored Together keep coordinate with channel-free concat improve Tyler stayed-to-watch prediction?",
        "source": {
            "validationArtifactSha256": sha256_bytes(source_bytes),
            "validationSourceFingerprint": source.get("sourceFingerprint"),
            "validationVersion": source.get("version"),
            "ledgerVersion": (source.get("coordinateRegistry") or {}).get("version"),
            "targetCoordinateId": TARGET_ID,
            "inputCoordinateIds": list(SOURCE_IDS),
            "sensitivityInputCoordinateId": SENSITIVITY_SOURCE_ID,
            "rowAccount": "tyler",
            "rows": len(rows),
            "dataIdentitySha256": data_identity,
        },
        "protocol": {
            "outer": "Five deterministic content-family-grouped folds. Each row is predicted once by a combination selected without that fold.",
            "inner": "Four deterministic content-family-grouped folds inside each outer training set select formula and Ridge alpha by minimum MAE.",
            "candidateRegistrySha256": candidate_identity,
            "candidateCount": len(configs),
            "candidates": configs,
            "interactionFeatures": list(INTERACTION_FEATURES),
            "selectionMetric": "mean absolute error in keep percentage points",
            "chartTrainingRowsRead": 0,
            "chartTrainingOutcomesRead": 0,
        },
        "results": {
            "nestedCombined": metric_row(actual, combined_prediction),
            "rawStoredTogether": metric_row(actual, values[:, 0]),
            "rawChannelFreeConcat": metric_row(actual, values[:, 1]),
            "fixedArithmeticMean": metric_row(actual, fixed_mean),
            "nestedCalibratedTogetherOnly": metric_row(actual, calibrated_together),
            "nestedCalibratedConcatOnly": metric_row(actual, calibrated_concat),
            "incrementalVsCalibratedTogether": paired_bootstrap(
                actual, combined_prediction, calibrated_together
            ),
            "incrementalVsRawTogether": paired_bootstrap(
                actual, combined_prediction, values[:, 0]
            ),
            "partialConcatAfterTogether": {
                "pearson": round(float(partial.statistic), 4),
                "pValue": round(float(partial.pvalue), 6),
                "definition": "Descriptive full-sample partial correlation between concat and keep after linear removal of stored Together. It is not the held-out selection result.",
            },
            "trainingFoldQuadrants": quadrant_summary(values, actual, outer_folds),
            "upstreamLeakageSensitivity": {
                "replacement": SENSITIVITY_SOURCE_ID,
                "nestedCombined": metric_row(actual, sensitivity_prediction),
                "nestedSelections": sensitivity_selections,
                "interpretation": "Replacing the target-fitted stored Together coordinate with its video-held-out reconstruction removes the apparent large gain. This is a sensitivity check, not a second canonical score.",
            },
        },
        "outerSelections": selections,
        "singleInputSelections": {
            "together": together_selections,
            "concat": concat_selections,
        },
        "prospectiveCandidate": fit_final_model(rows, values, actual, configs),
        "rows": [{
            "id": row["id"],
            "title": row.get("title") or "",
            "account": "tyler",
            "contentFamilyId": content_family(row),
            "fold": int(outer_folds[index]),
            "actualKeep": round(float(actual[index]), 4),
            "storedTogetherKeep": round(float(values[index, 0]), 4),
            "channelFreeConcatKeep": round(float(values[index, 1]), 4),
            "prediction": round(float(combined_prediction[index]), 4),
            "calibratedTogetherBaseline": round(float(calibrated_together[index]), 4),
            "absoluteError": round(float(abs(combined_prediction[index] - actual[index])), 4),
        } for index, row in enumerate(rows)],
        "claimBoundary": {
            "status": "research_diagnostic_not_predictor_eligible",
            "reason": "The outer combiner is held out, but shorts.stored.together.keep was originally fitted and calibrated with Tyler labels, including these historical rows. Outer-folding the combiner cannot undo that upstream leakage.",
            "portableClaim": "None. This experiment is Tyler-only and cannot establish unseen-creator transfer.",
            "decision": "Expose the requested combination for inspection, but do not replace either production score or call it added predictive signal unless a prospective frozen test or a fully nested upstream Together rebuild confirms it.",
        },
    }
    output = Path(args.output)
    output.write_text(json.dumps(artifact, indent=1) + "\n")
    print(json.dumps({
        "output": str(output),
        "runId": run_id,
        "rows": len(rows),
        "nestedCombined": artifact["results"]["nestedCombined"],
        "calibratedTogether": artifact["results"]["nestedCalibratedTogetherOnly"],
        "incremental": artifact["results"]["incrementalVsCalibratedTogether"],
        "claim": artifact["claimBoundary"]["status"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
