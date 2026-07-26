#!/usr/bin/env python3
"""Fold-local raw-embedding validation against creator-relative lift.

This script deliberately ignores the supervised coordinates already stored in
the Raw maps. Every PCA and outcome direction is re-fit inside the applicable
outer split. Exact content families in a test split are removed from training.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import pearsonr, spearmanr
from sklearn.decomposition import PCA
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score, roc_auc_score


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
TARGET_PATH = CACHE / "opportunity-targets.json.gz"
OUTPUT_PATH = HERE / "raw-embedding-validation.json"
CHANNELS = [
    ("shorts", "visual"),
    ("shorts", "text"),
    ("shorts", "together"),
    ("long", "visual"),
    ("long", "text"),
    ("long", "together"),
]
ALPHAS = [0.1, 1.0, 10.0, 100.0, 1000.0]
PCA_COMPONENTS = 64
OUTER_FOLDS = 5
INNER_FOLDS = 3
BOOTSTRAP_REPLICATES = 300
PERMUTATION_REPLICATES = 499


def stable_fold(value: str, folds: int, salt: str = "") -> int:
    digest = hashlib.sha256(f"{salt}{value}".encode()).digest()
    return digest[0] % folds


def finite(value: float | None) -> float | None:
    if value is None:
        return None
    output = float(value)
    return output if np.isfinite(output) else None


def rounded(value: float | None, digits: int = 6) -> float | None:
    value = finite(value)
    return round(value, digits) if value is not None else None


def load_target_artifact() -> dict[str, Any]:
    with gzip.open(TARGET_PATH, "rt", encoding="utf-8") as source:
        return json.load(source)


def load_targets(artifact: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["videoId"]: row for row in artifact["rows"]}


def load_channel(
    format_name: str,
    modality: str,
    targets: dict[str, dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    source = CACHE / "embeddings" / format_name / f"{modality}.npz"
    if not source.exists():
        raise FileNotFoundError(f"Missing {source}. Run cache-embeddings.js first.")
    with np.load(source, allow_pickle=True) as payload:
        ids = payload["ids"].astype(str)
        vectors = payload["vecs"].astype(np.float32, copy=False)
        selected = [
            index
            for index, video_id in enumerate(ids)
            if video_id in targets and targets[video_id]["format"] == format_name
        ]
        metadata = [targets[ids[index]] for index in selected]
        return (
            vectors[np.asarray(selected, dtype=np.int64)],
            np.asarray([row["creatorRelativeLift"] for row in metadata], dtype=np.float64),
            metadata,
        )


def remove_test_families(
    train_index: np.ndarray,
    test_index: np.ndarray,
    metadata: list[dict[str, Any]],
) -> np.ndarray:
    test_families = {metadata[index]["contentFamilyId"] for index in test_index}
    return np.asarray(
        [
            index
            for index in train_index
            if metadata[index]["contentFamilyId"] not in test_families
        ],
        dtype=np.int64,
    )


def select_alpha(
    transformed: np.ndarray,
    targets: np.ndarray,
    metadata: list[dict[str, Any]],
    train_index: np.ndarray,
) -> tuple[float, dict[str, float]]:
    scores: dict[float, list[float]] = {alpha: [] for alpha in ALPHAS}
    for fold in range(INNER_FOLDS):
        inner_test = np.asarray(
            [
                index
                for index in train_index
                if stable_fold(metadata[index]["sourceId"], INNER_FOLDS, "inner") == fold
            ],
            dtype=np.int64,
        )
        inner_train = np.asarray(
            [
                index
                for index in train_index
                if stable_fold(metadata[index]["sourceId"], INNER_FOLDS, "inner") != fold
            ],
            dtype=np.int64,
        )
        inner_train = remove_test_families(inner_train, inner_test, metadata)
        if len(inner_train) < 100 or len(inner_test) < 30:
            continue
        for alpha in ALPHAS:
            model = Ridge(alpha=alpha)
            model.fit(transformed[inner_train], targets[inner_train])
            prediction = model.predict(transformed[inner_test])
            scores[alpha].append(float(np.mean((targets[inner_test] - prediction) ** 2)))
    mean_scores = {
        alpha: float(np.mean(values)) if values else math.inf
        for alpha, values in scores.items()
    }
    selected = min(ALPHAS, key=lambda alpha: (mean_scores[alpha], alpha))
    return selected, {str(alpha): rounded(value) for alpha, value in mean_scores.items()}


def transform_fold(
    vectors: np.ndarray,
    train_index: np.ndarray,
    test_index: np.ndarray,
    seed: int,
) -> tuple[np.ndarray, np.ndarray, PCA]:
    components = min(PCA_COMPONENTS, vectors.shape[1], len(train_index) - 1)
    pca = PCA(n_components=components, svd_solver="randomized", random_state=seed)
    train_values = pca.fit_transform(vectors[train_index])
    test_values = pca.transform(vectors[test_index])
    return train_values, test_values, pca


def fold_prediction(
    vectors: np.ndarray,
    targets: np.ndarray,
    metadata: list[dict[str, Any]],
    train_index: np.ndarray,
    test_index: np.ndarray,
    seed: int,
) -> tuple[np.ndarray, np.ndarray, float, float, float]:
    train_index = remove_test_families(train_index, test_index, metadata)
    train_values, test_values, pca = transform_fold(vectors, train_index, test_index, seed)

    combined = np.empty((len(metadata), train_values.shape[1]), dtype=np.float32)
    combined[train_index] = train_values
    combined[test_index] = test_values
    alpha, _ = select_alpha(combined, targets, metadata, train_index)
    model = Ridge(alpha=alpha)
    model.fit(train_values, targets[train_index])
    prediction = model.predict(test_values)
    null_prediction = np.full(len(test_index), float(np.mean(targets[train_index])))
    explained = float(np.sum(pca.explained_variance_ratio_))
    return prediction, null_prediction, alpha, explained, len(train_index)


def source_macro_spearman(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: list[dict[str, Any]],
) -> dict[str, float | int | None]:
    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        grouped.setdefault(row["sourceId"], []).append(index)
    coefficients = []
    for indices in grouped.values():
        if len(indices) < 4:
            continue
        coefficient = spearmanr(actual[indices], predicted[indices]).statistic
        if np.isfinite(coefficient):
            coefficients.append(float(coefficient))
    return {
        "sources": len(coefficients),
        "meanSpearman": rounded(float(np.mean(coefficients))) if coefficients else None,
        "medianSpearman": rounded(float(np.median(coefficients))) if coefficients else None,
        "standardDeviationSpearman": rounded(float(np.std(coefficients))) if coefficients else None,
        "positiveFraction": rounded(
            float(np.mean(np.asarray(coefficients) > 0))
        ) if coefficients else None,
    }


def within_source_pairwise_accuracy(
    actual: np.ndarray,
    predicted: np.ndarray,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        grouped.setdefault(row["sourceId"], []).append(index)
    correct = 0.0
    pairs = 0
    source_accuracies = []
    for indices in grouped.values():
        if len(indices) < 2:
            continue
        source_correct = 0.0
        source_pairs = 0
        for left_position, left in enumerate(indices):
            for right in indices[left_position + 1:]:
                actual_difference = actual[left] - actual[right]
                if actual_difference == 0:
                    continue
                predicted_difference = predicted[left] - predicted[right]
                if predicted_difference == 0:
                    score = 0.5
                else:
                    score = float(
                        np.sign(actual_difference) == np.sign(predicted_difference)
                    )
                source_correct += score
                source_pairs += 1
        if source_pairs:
            correct += source_correct
            pairs += source_pairs
            source_accuracies.append(source_correct / source_pairs)
    return {
        "sources": len(source_accuracies),
        "pairs": pairs,
        "microAccuracy": rounded(correct / pairs) if pairs else None,
        "equalSourceMeanAccuracy": rounded(
            float(np.mean(source_accuracies))
        ) if source_accuracies else None,
        "equalSourceMedianAccuracy": rounded(
            float(np.median(source_accuracies))
        ) if source_accuracies else None,
        "positiveSourceFraction": rounded(
            float(np.mean(np.asarray(source_accuracies) > 0.5))
        ) if source_accuracies else None,
    }


def calibration_summary(
    actual: np.ndarray,
    predicted: np.ndarray,
) -> dict[str, Any]:
    order = np.argsort(predicted, kind="stable")
    bins = []
    actual_top_threshold = float(np.quantile(actual, 0.9))
    for decile, indices in enumerate(np.array_split(order, 10), start=1):
        bins.append(
            {
                "decile": decile,
                "n": len(indices),
                "meanPrediction": rounded(float(np.mean(predicted[indices]))),
                "meanActualLift": rounded(float(np.mean(actual[indices]))),
                "medianActualLift": rounded(float(np.median(actual[indices]))),
                "positiveLiftRate": rounded(float(np.mean(actual[indices] > 0))),
                "actualTopDecileRate": rounded(
                    float(np.mean(actual[indices] >= actual_top_threshold))
                ),
            }
        )
    means = [row["meanActualLift"] for row in bins]
    monotonic_steps = sum(
        means[index] >= means[index - 1]
        for index in range(1, len(means))
    )
    top_indices = np.asarray(np.array_split(order, 10)[-1], dtype=np.int64)
    bottom_indices = np.asarray(np.array_split(order, 10)[0], dtype=np.int64)
    actual_top = actual >= actual_top_threshold
    selected_top = np.zeros(len(actual), dtype=bool)
    selected_top[top_indices] = True
    captured = int(np.sum(actual_top & selected_top))
    return {
        "bins": bins,
        "monotonicAdjacentSteps": monotonic_steps,
        "possibleAdjacentSteps": 9,
        "topMinusBottomMeanLift": rounded(
            float(np.mean(actual[top_indices]) - np.mean(actual[bottom_indices]))
        ),
        "topPredictedDecilePositiveLiftRate": rounded(
            float(np.mean(actual[top_indices] > 0))
        ),
        "topPredictedDecileActualTopDecilePrecision": rounded(
            float(np.mean(actual_top[top_indices]))
        ),
        "actualTopDecileRecall": rounded(
            captured / max(1, int(np.sum(actual_top)))
        ),
    }


def grouped_indices(rows: list[dict[str, Any]]) -> list[np.ndarray]:
    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        grouped.setdefault(row["sourceId"], []).append(index)
    return [
        np.asarray(indices, dtype=np.int64)
        for _, indices in sorted(grouped.items())
    ]


def gaussian_bits(
    actual: np.ndarray,
    predicted: np.ndarray,
    null_prediction: np.ndarray,
) -> float | None:
    mse = float(np.mean((actual - predicted) ** 2))
    null_mse = float(np.mean((actual - null_prediction) ** 2))
    if mse <= 0 or null_mse <= 0:
        return None
    return 0.5 * math.log2(null_mse / mse)


def percentile_interval(values: list[float]) -> dict[str, float | None]:
    finite_values = np.asarray([value for value in values if np.isfinite(value)])
    if not len(finite_values):
        return {"low": None, "median": None, "high": None}
    return {
        "low": rounded(float(np.quantile(finite_values, 0.025))),
        "median": rounded(float(np.quantile(finite_values, 0.5))),
        "high": rounded(float(np.quantile(finite_values, 0.975))),
    }


def source_block_bootstrap(
    actual: np.ndarray,
    predicted: np.ndarray,
    null_prediction: np.ndarray,
    rows: list[dict[str, Any]],
    seed: int,
) -> dict[str, Any]:
    groups = grouped_indices(rows)
    rng = np.random.default_rng(seed)
    rho_values: list[float] = []
    bits_values: list[float] = []
    mae_gain_values: list[float] = []
    for _ in range(BOOTSTRAP_REPLICATES):
        sampled = rng.integers(0, len(groups), size=len(groups))
        indices = np.concatenate([groups[index] for index in sampled])
        rho = spearmanr(actual[indices], predicted[indices]).statistic
        bits = gaussian_bits(
            actual[indices],
            predicted[indices],
            null_prediction[indices],
        )
        mae_gain = float(
            np.mean(np.abs(actual[indices] - null_prediction[indices]))
            - np.mean(np.abs(actual[indices] - predicted[indices]))
        )
        if np.isfinite(rho):
            rho_values.append(float(rho))
        if bits is not None and np.isfinite(bits):
            bits_values.append(float(bits))
        if np.isfinite(mae_gain):
            mae_gain_values.append(mae_gain)
    return {
        "unit": "creator/source",
        "replicates": BOOTSTRAP_REPLICATES,
        "sources": len(groups),
        "spearman95": percentile_interval(rho_values),
        "gaussianBitsPerObservation95": percentile_interval(bits_values),
        "maeImprovementLog10Lift95": percentile_interval(mae_gain_values),
    }


def within_source_permutation(
    actual: np.ndarray,
    predicted: np.ndarray,
    null_prediction: np.ndarray,
    rows: list[dict[str, Any]],
    seed: int,
) -> dict[str, Any]:
    groups = grouped_indices(rows)
    mutable_groups = [group for group in groups if len(group) > 1]
    rng = np.random.default_rng(seed)
    observed_rho = float(spearmanr(actual, predicted).statistic)
    observed_bits = gaussian_bits(actual, predicted, null_prediction)
    null_rhos: list[float] = []
    null_bits: list[float] = []
    for _ in range(PERMUTATION_REPLICATES):
        permuted = actual.copy()
        for group in mutable_groups:
            permuted[group] = actual[rng.permutation(group)]
        rho = spearmanr(permuted, predicted).statistic
        bits = gaussian_bits(permuted, predicted, null_prediction)
        if np.isfinite(rho):
            null_rhos.append(float(rho))
        if bits is not None and np.isfinite(bits):
            null_bits.append(float(bits))
    rho_exceedances = sum(value >= observed_rho for value in null_rhos)
    rho_abs_exceedances = sum(abs(value) >= abs(observed_rho) for value in null_rhos)
    bits_exceedances = (
        sum(value >= observed_bits for value in null_bits)
        if observed_bits is not None
        else len(null_bits)
    )
    return {
        "scheme": "shuffle outcomes only within each creator/source; predictions remain fixed",
        "replicates": PERMUTATION_REPLICATES,
        "mutableSources": len(mutable_groups),
        "observedSpearman": rounded(observed_rho),
        "spearmanOneSidedP": rounded(
            (rho_exceedances + 1) / (len(null_rhos) + 1)
        ),
        "spearmanTwoSidedP": rounded(
            (rho_abs_exceedances + 1) / (len(null_rhos) + 1)
        ),
        "nullSpearman95": percentile_interval(null_rhos),
        "observedGaussianBitsPerObservation": rounded(observed_bits),
        "gaussianBitsOneSidedP": rounded(
            (bits_exceedances + 1) / (len(null_bits) + 1)
        ),
        "nullGaussianBits95": percentile_interval(null_bits),
        "excessSpearmanOverNullMedian": rounded(
            observed_rho - float(np.median(null_rhos))
        ) if null_rhos else None,
        "excessGaussianBitsOverNullMedian": rounded(
            observed_bits - float(np.median(null_bits))
        ) if observed_bits is not None and null_bits else None,
    }


def metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    null_prediction: np.ndarray,
    rows: list[dict[str, Any]],
    seed: int,
) -> dict[str, Any]:
    mse = float(np.mean((actual - predicted) ** 2))
    null_mse = float(np.mean((actual - null_prediction) ** 2))
    threshold = float(np.quantile(actual, 0.9))
    binary = (actual >= threshold).astype(np.int8)
    auc = roc_auc_score(binary, predicted) if len(np.unique(binary)) == 2 else None
    return {
        "n": len(actual),
        "r2": rounded(r2_score(actual, predicted)),
        "pearson": rounded(pearsonr(actual, predicted).statistic),
        "spearman": rounded(spearmanr(actual, predicted).statistic),
        "maeLog10Lift": rounded(mean_absolute_error(actual, predicted)),
        "nullMaeLog10Lift": rounded(mean_absolute_error(actual, null_prediction)),
        "mse": rounded(mse),
        "nullMse": rounded(null_mse),
        "gaussianBitsPerObservation": rounded(0.5 * math.log2(null_mse / mse)) if mse > 0 else None,
        "topDecileAuc": rounded(auc),
        "predictionStandardDeviation": rounded(float(np.std(predicted))),
        "actualStandardDeviation": rounded(float(np.std(actual))),
        "sourceMacro": source_macro_spearman(actual, predicted, rows),
        "withinSourcePairwise": within_source_pairwise_accuracy(
            actual,
            predicted,
            rows,
        ),
        "calibration": calibration_summary(actual, predicted),
        "sourceBlockBootstrap": source_block_bootstrap(
            actual,
            predicted,
            null_prediction,
            rows,
            seed,
        ),
        "withinSourcePermutation": within_source_permutation(
            actual,
            predicted,
            null_prediction,
            rows,
            seed + 1,
        ),
    }


def unseen_source_validation(
    vectors: np.ndarray,
    targets: np.ndarray,
    metadata: list[dict[str, Any]],
) -> dict[str, Any]:
    predictions = np.empty(len(targets), dtype=np.float64)
    nulls = np.empty(len(targets), dtype=np.float64)
    selected_alphas = []
    explained = []
    training_rows = []
    for fold in range(OUTER_FOLDS):
        train_index = np.asarray(
            [
                index
                for index, row in enumerate(metadata)
                if stable_fold(row["sourceId"], OUTER_FOLDS) != fold
            ],
            dtype=np.int64,
        )
        test_index = np.asarray(
            [
                index
                for index, row in enumerate(metadata)
                if stable_fold(row["sourceId"], OUTER_FOLDS) == fold
            ],
            dtype=np.int64,
        )
        prediction, null_prediction, alpha, variance_explained, train_count = fold_prediction(
            vectors,
            targets,
            metadata,
            train_index,
            test_index,
            7300 + fold,
        )
        predictions[test_index] = prediction
        nulls[test_index] = null_prediction
        selected_alphas.append(alpha)
        explained.append(variance_explained)
        training_rows.append(train_count)
    return {
        **metrics(targets, predictions, nulls, metadata, 21701),
        "selectedAlphas": selected_alphas,
        "meanPcaVarianceExplained": rounded(float(np.mean(explained))),
        "meanTrainingRowsAfterFamilyExclusion": rounded(float(np.mean(training_rows)), 1),
        "split": "five deterministic source-held-out folds; exact test content families removed from training",
    }


def later_video_validation(
    vectors: np.ndarray,
    targets: np.ndarray,
    metadata: list[dict[str, Any]],
) -> dict[str, Any]:
    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(metadata):
        grouped.setdefault(row["sourceId"], []).append(index)
    train_index = []
    test_index = []
    for indices in grouped.values():
        indices.sort(key=lambda index: (
            metadata[index]["publishedSeconds"],
            metadata[index]["videoId"],
        ))
        split = max(1, int(len(indices) * 0.7))
        train_index.extend(indices[:split])
        test_index.extend(indices[split:])
    train_index = np.asarray(train_index, dtype=np.int64)
    test_index = np.asarray(test_index, dtype=np.int64)
    prediction, null_prediction, alpha, variance_explained, train_count = fold_prediction(
        vectors,
        targets,
        metadata,
        train_index,
        test_index,
        9107,
    )
    return {
        **metrics(
            targets[test_index],
            prediction,
            null_prediction,
            [metadata[index] for index in test_index],
            31417,
        ),
        "selectedAlpha": alpha,
        "pcaVarianceExplained": rounded(variance_explained),
        "trainingRowsAfterFamilyExclusion": train_count,
        "split": "first 70% of each creator chronology trains; later 30% tests; exact test content families removed from training",
    }


def run_channel(
    format_name: str,
    modality: str,
    targets: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    vectors, outcomes, metadata = load_channel(format_name, modality, targets)
    return {
        "id": f"{format_name}:{modality}",
        "format": format_name,
        "modality": modality,
        "observations": len(outcomes),
        "sources": len({row["sourceId"] for row in metadata}),
        "dimensions": vectors.shape[1],
        "model": f"fold-local PCA{PCA_COMPONENTS} + nested source-grouped Ridge",
        "unseenCreator": unseen_source_validation(vectors, outcomes, metadata),
        "laterVideo": later_video_validation(vectors, outcomes, metadata),
    }


def adjusted_pvalues(values: list[float]) -> list[dict[str, float]]:
    count = len(values)
    order = sorted(range(count), key=lambda index: values[index])
    holm = [1.0] * count
    running_holm = 0.0
    for rank, index in enumerate(order):
        running_holm = max(running_holm, values[index] * (count - rank))
        holm[index] = min(1.0, running_holm)
    bh = [1.0] * count
    running_bh = 1.0
    for reverse_rank in range(count - 1, -1, -1):
        index = order[reverse_rank]
        rank = reverse_rank + 1
        running_bh = min(running_bh, values[index] * count / rank)
        bh[index] = min(1.0, running_bh)
    return [
        {
            "bonferroniP": rounded(min(1.0, value * count)),
            "holmP": rounded(holm[index]),
            "benjaminiHochbergQ": rounded(bh[index]),
        }
        for index, value in enumerate(values)
    ]


def apply_multiplicity(channels: list[dict[str, Any]]) -> dict[str, Any]:
    hypotheses = []
    for channel in channels:
        for split_key in ("unseenCreator", "laterVideo"):
            result = channel[split_key]
            hypotheses.append({
                "channel": channel,
                "splitKey": split_key,
                "p": result["withinSourcePermutation"]["spearmanOneSidedP"],
            })
    corrections = adjusted_pvalues([hypothesis["p"] for hypothesis in hypotheses])
    for hypothesis, correction in zip(hypotheses, corrections):
        hypothesis["channel"][hypothesis["splitKey"]]["multiplicity"] = {
            "family": "all 6 format-by-modality channels across both predeclared validation splits",
            "hypotheses": len(hypotheses),
            **correction,
        }
    return {
        "primaryStatistic": "within-creator Spearman association",
        "hypotheses": len(hypotheses),
        "family": "6 channels x 2 validation splits",
        "passingHolm05": [
            f"{hypothesis['channel']['id']}:{hypothesis['splitKey']}"
            for hypothesis, correction in zip(hypotheses, corrections)
            if correction["holmP"] is not None and correction["holmP"] <= 0.05
        ],
        "passingFdr05": [
            f"{hypothesis['channel']['id']}:{hypothesis['splitKey']}"
            for hypothesis, correction in zip(hypotheses, corrections)
            if correction["benjaminiHochbergQ"] is not None
            and correction["benjaminiHochbergQ"] <= 0.05
        ],
    }


def main() -> None:
    target_artifact = load_target_artifact()
    targets = load_targets(target_artifact)
    channels = []
    for format_name, modality in CHANNELS:
        print(f"validating {format_name}:{modality}", flush=True)
        channels.append(run_channel(format_name, modality, targets))
    positive_unseen = [
        channel
        for channel in channels
        if (channel["unseenCreator"]["gaussianBitsPerObservation"] or 0) > 0
    ]
    positive_later = [
        channel
        for channel in channels
        if (channel["laterVideo"]["gaussianBitsPerObservation"] or 0) > 0
    ]
    multiplicity = apply_multiplicity(channels)
    output = {
        "schema": "raw-embedding-relative-lift-validation-v2",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "target": "creatorRelativeLift",
        "sourceLineage": {
            "snapshotRunId": target_artifact.get("snapshotRunId"),
            "targetSchema": target_artifact.get("schema"),
            "targetContentHash": target_artifact.get("contentHash"),
            "semanticFamilyHash": target_artifact.get("semanticFamilyHash"),
            "panelArtifactSha256": target_artifact.get("sourcePanelHash"),
            "targetArtifactSha256": hashlib.sha256(
                TARGET_PATH.read_bytes()
            ).hexdigest(),
        },
        "channels": channels,
        "positivePredictiveBits": {
            "unseenCreator": [channel["id"] for channel in positive_unseen],
            "laterVideo": [channel["id"] for channel in positive_later],
        },
        "uncertainty": {
            "sourceBlockBootstrapReplicates": BOOTSTRAP_REPLICATES,
            "withinSourcePermutationReplicates": PERMUTATION_REPLICATES,
            "multiplicity": multiplicity,
        },
        "claimBoundary": [
            "Raw embeddings, PCA, and Ridge are fit inside each outer evaluation split.",
            "Exact content families in test are removed from training.",
            "Alpha is selected only inside the outer training partition.",
            "The outcome remains a retrospective current-snapshot relative-lift proxy, not fixed-age impressions or causal content lift.",
            "This tests one linear algorithm family at one representation resolution; robustness requires independent algorithms and model versions.",
            "Bootstrap intervals resample creators rather than individual videos.",
            "The primary permutation null destroys within-creator ordering while retaining each creator's outcome distribution.",
            "Holm and Benjamini-Hochberg adjustments cover all twelve predeclared channel-by-split association tests.",
        ],
    }
    serialized = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({
        "output": str(OUTPUT_PATH.relative_to(HERE.parent.parent.parent.parent)),
        "channels": [
            {
                "id": channel["id"],
                "unseenR2": channel["unseenCreator"]["r2"],
                "unseenRho": channel["unseenCreator"]["spearman"],
                "unseenBits": channel["unseenCreator"]["gaussianBitsPerObservation"],
                "laterR2": channel["laterVideo"]["r2"],
                "laterRho": channel["laterVideo"]["spearman"],
                "laterBits": channel["laterVideo"]["gaussianBitsPerObservation"],
            }
            for channel in channels
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
