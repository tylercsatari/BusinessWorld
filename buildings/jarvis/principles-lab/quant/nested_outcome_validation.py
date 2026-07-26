#!/usr/bin/env python3
"""Leakage-resistant embedding validation with fold-local outcome construction.

The earlier opportunity target is useful for exploration, but it is cross-fit
once and then reused. This stricter audit rebuilds the age curve and creator
history baseline inside every outer evaluation split before fitting PCA or the
content direction.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from raw_embedding_validation import (
    OUTER_FOLDS,
    adjusted_pvalues,
    fold_prediction,
    metrics,
    rounded,
    stable_fold,
)


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PANEL_PATH = CACHE / "unified-panel.json.gz"
SEMANTIC_FAMILY_PATH = CACHE / "semantic-families.json.gz"
OUTPUT_PATH = HERE / "nested-outcome-validation.json"
MANIFEST_PATH = HERE / "snapshot-manifest.json"
CHANNELS = [
    ("shorts", "visual"),
    ("shorts", "text"),
    ("shorts", "together"),
    ("long", "visual"),
    ("long", "text"),
    ("long", "together"),
]
AGE_KNOT_DAYS = [7, 30, 90, 180, 365, 730]
MIN_HISTORY = 1


def age_features(age_days: float) -> np.ndarray:
    value = np.log1p(max(0.0, float(age_days)))
    return np.asarray(
        [
            1.0,
            value,
            value * value,
            value * value * value,
            *[
                max(0.0, value - np.log1p(days))
                for days in AGE_KNOT_DAYS
            ],
        ],
        dtype=np.float64,
    )


def fit_age_model(rows: list[dict[str, Any]]) -> np.ndarray:
    design = np.vstack([age_features(row["ageDays"]) for row in rows])
    outcomes = np.asarray([row["logViews"] for row in rows], dtype=np.float64)
    gram = design.T @ design
    penalty = np.eye(design.shape[1], dtype=np.float64) * (0.001 * len(rows))
    penalty[0, 0] = 0.0
    return np.linalg.solve(gram + penalty, design.T @ outcomes)


def age_prediction(coefficients: np.ndarray, row: dict[str, Any]) -> float:
    return float(age_features(row["ageDays"]) @ coefficients)


def load_panel() -> dict[str, list[dict[str, Any]]]:
    with gzip.open(PANEL_PATH, "rt", encoding="utf-8") as source:
        payload = json.load(source)
    with gzip.open(SEMANTIC_FAMILY_PATH, "rt", encoding="utf-8") as source:
        semantic_payload = json.load(source)
    formats: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in payload["rows"]:
        outcomes = row.get("outcomes") or {}
        if (
            row.get("format") not in {"shorts", "long"}
            or not row.get("videoId")
            or not row.get("sourceId")
            or row.get("publishedSeconds") is None
            or row.get("ageDays") is None
            or outcomes.get("logViews") is None
        ):
            continue
        formats[row["format"]].append(
            {
                "videoId": row["videoId"],
                "sourceId": row["sourceId"],
                "contentFamilyId": (
                    semantic_payload["formats"]
                    .get(row["format"], {})
                    .get(row["videoId"], row["contentFamilyId"])
                ),
                "exactContentFamilyId": row["contentFamilyId"],
                "publishedSeconds": float(row["publishedSeconds"]),
                "observationSeconds": float(row["observationSeconds"]),
                "ageDays": float(row["ageDays"]),
                "logViews": float(outcomes["logViews"]),
            }
        )
    return formats


def load_embeddings(
    format_name: str,
    modality: str,
) -> tuple[np.ndarray, np.ndarray]:
    source = CACHE / "embeddings" / format_name / f"{modality}.npz"
    if not source.exists():
        raise FileNotFoundError(f"Missing {source}. Run cache-embeddings.js first.")
    with np.load(source, allow_pickle=True) as payload:
        return (
            payload["ids"].astype(str),
            payload["vecs"].astype(np.float32, copy=False),
        )


def group_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["sourceId"]].append(row)
    for source_rows in grouped.values():
        source_rows.sort(
            key=lambda row: (row["publishedSeconds"], row["videoId"])
        )
    return grouped


def variance_components(
    rows: list[dict[str, Any]],
    coefficients: np.ndarray,
) -> dict[str, float]:
    residuals = np.asarray(
        [row["logViews"] - age_prediction(coefficients, row) for row in rows],
        dtype=np.float64,
    )
    residual_variance = max(1e-6, float(np.var(residuals)))
    grouped: dict[str, list[float]] = defaultdict(list)
    for row, residual in zip(rows, residuals):
        grouped[row["sourceId"]].append(float(residual))
    groups = [values for values in grouped.values() if len(values) >= 2]
    source_means = np.asarray([np.mean(values) for values in groups], dtype=np.float64)
    sampling_variance = float(np.mean([
        residual_variance / len(values)
        for values in groups
    ]))
    source_variance = max(
        residual_variance * 1e-4,
        float(np.var(source_means)) - sampling_variance,
    )
    return {
        "residualVariance": residual_variance,
        "sourceVariance": source_variance,
    }


def posterior_effect(
    history: list[dict[str, Any]],
    components: dict[str, float],
) -> float:
    precision = (
        (1.0 / components["sourceVariance"])
        + (len(history) / components["residualVariance"])
    )
    return (
        sum(row["residual"] for row in history)
        / components["residualVariance"]
    ) / precision


def sequential_targets(
    grouped: dict[str, list[dict[str, Any]]],
    coefficients: np.ndarray,
    components: dict[str, float],
    source_filter: set[str],
) -> dict[str, float]:
    targets: dict[str, float] = {}
    for source_id in sorted(source_filter):
        history: list[dict[str, Any]] = []
        for row in grouped.get(source_id, []):
            baseline = age_prediction(coefficients, row)
            residual = row["logViews"] - baseline
            eligible = [
                previous
                for previous in history
                if (
                    previous["observationSeconds"] <= row["publishedSeconds"]
                    and previous["contentFamilyId"] != row["contentFamilyId"]
                )
            ]
            if len(eligible) >= MIN_HISTORY:
                center = posterior_effect(eligible, components)
                targets[row["videoId"]] = residual - center
            history.append({**row, "residual": residual})
    return targets


def fixed_origin_targets(
    grouped: dict[str, list[dict[str, Any]]],
    coefficients: np.ndarray,
    components: dict[str, float],
) -> tuple[dict[str, float], dict[str, float], set[str], set[str]]:
    train_targets: dict[str, float] = {}
    test_targets: dict[str, float] = {}
    train_ids: set[str] = set()
    test_ids: set[str] = set()
    for source_rows in grouped.values():
        split = max(1, int(len(source_rows) * 0.7))
        train_rows = source_rows[:split]
        test_rows = source_rows[split:]
        train_ids.update(row["videoId"] for row in train_rows)
        test_ids.update(row["videoId"] for row in test_rows)

        history: list[dict[str, Any]] = []
        for row in train_rows:
            baseline = age_prediction(coefficients, row)
            residual = row["logViews"] - baseline
            eligible = [
                previous
                for previous in history
                if (
                    previous["observationSeconds"] <= row["publishedSeconds"]
                    and previous["contentFamilyId"] != row["contentFamilyId"]
                )
            ]
            if len(eligible) >= MIN_HISTORY:
                center = posterior_effect(eligible, components)
                train_targets[row["videoId"]] = residual - center
            history.append({**row, "residual": residual})

        # The test baseline is frozen at the split. No test outcome updates the
        # creator history used by another test row.
        for row in test_rows:
            baseline = age_prediction(coefficients, row)
            residual = row["logViews"] - baseline
            eligible = [
                previous
                for previous in history
                if (
                    previous["observationSeconds"] <= row["publishedSeconds"]
                    and previous["contentFamilyId"] != row["contentFamilyId"]
                )
            ]
            if len(eligible) >= MIN_HISTORY:
                center = posterior_effect(eligible, components)
                test_targets[row["videoId"]] = residual - center
    return train_targets, test_targets, train_ids, test_ids


def select_embedding_rows(
    ids: np.ndarray,
    vectors: np.ndarray,
    metadata_by_id: dict[str, dict[str, Any]],
    target_map: dict[str, float],
    allowed_ids: set[str] | None = None,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    selected = [
        index
        for index, video_id in enumerate(ids)
        if (
            video_id in target_map
            and video_id in metadata_by_id
            and (allowed_ids is None or video_id in allowed_ids)
        )
    ]
    selected_index = np.asarray(selected, dtype=np.int64)
    selected_ids = ids[selected_index]
    return (
        vectors[selected_index],
        np.asarray([target_map[video_id] for video_id in selected_ids], dtype=np.float64),
        [metadata_by_id[video_id] for video_id in selected_ids],
    )


def evaluate_partition(
    train_vectors: np.ndarray,
    train_targets: np.ndarray,
    train_metadata: list[dict[str, Any]],
    test_vectors: np.ndarray,
    test_targets: np.ndarray,
    test_metadata: list[dict[str, Any]],
    seed: int,
) -> tuple[np.ndarray, np.ndarray, float, float, int]:
    vectors = np.concatenate([train_vectors, test_vectors], axis=0)
    targets = np.concatenate([train_targets, test_targets], axis=0)
    metadata = train_metadata + test_metadata
    train_index = np.arange(len(train_targets), dtype=np.int64)
    test_index = np.arange(
        len(train_targets),
        len(train_targets) + len(test_targets),
        dtype=np.int64,
    )
    return fold_prediction(
        vectors,
        targets,
        metadata,
        train_index,
        test_index,
        seed,
    )


def unseen_creator_validation(
    rows: list[dict[str, Any]],
    ids: np.ndarray,
    vectors: np.ndarray,
) -> dict[str, Any]:
    grouped = group_rows(rows)
    metadata_by_id = {row["videoId"]: row for row in rows}
    sources = set(grouped)
    all_actual = []
    all_prediction = []
    all_null = []
    all_metadata: list[dict[str, Any]] = []
    fold_audit = []

    for fold in range(OUTER_FOLDS):
        train_sources = {
            source_id
            for source_id in sources
            if stable_fold(source_id, OUTER_FOLDS) != fold
        }
        test_sources = sources - train_sources
        coefficients = fit_age_model(
            [
                row
                for source_id in train_sources
                for row in grouped[source_id]
            ]
        )
        components = variance_components(
            [
                row
                for source_id in train_sources
                for row in grouped[source_id]
            ],
            coefficients,
        )
        train_target_map = sequential_targets(
            grouped,
            coefficients,
            components,
            train_sources,
        )
        test_target_map = sequential_targets(
            grouped,
            coefficients,
            components,
            test_sources,
        )
        train_values, train_outcomes, train_metadata = select_embedding_rows(
            ids,
            vectors,
            metadata_by_id,
            train_target_map,
        )
        test_values, test_outcomes, test_metadata = select_embedding_rows(
            ids,
            vectors,
            metadata_by_id,
            test_target_map,
        )
        prediction, null_prediction, alpha, explained, train_count = evaluate_partition(
            train_values,
            train_outcomes,
            train_metadata,
            test_values,
            test_outcomes,
            test_metadata,
            45000 + fold,
        )
        all_actual.append(test_outcomes)
        all_prediction.append(prediction)
        all_null.append(null_prediction)
        all_metadata.extend(test_metadata)
        fold_audit.append(
            {
                "fold": fold,
                "trainSources": len(train_sources),
                "testSources": len(test_sources),
                "trainRowsAfterFamilyExclusion": train_count,
                "testRows": len(test_outcomes),
                "alpha": alpha,
                "pcaVarianceExplained": rounded(explained),
            }
        )

    actual = np.concatenate(all_actual)
    prediction = np.concatenate(all_prediction)
    null_prediction = np.concatenate(all_null)
    return {
        **metrics(actual, prediction, null_prediction, all_metadata, 62003),
        "split": "five source-held-out folds; outcome age curve and creator history target rebuilt inside each fold",
        "folds": fold_audit,
    }


def later_video_validation(
    rows: list[dict[str, Any]],
    ids: np.ndarray,
    vectors: np.ndarray,
) -> dict[str, Any]:
    grouped = group_rows(rows)
    metadata_by_id = {row["videoId"]: row for row in rows}
    preliminary_train_ids = {
        row["videoId"]
        for source_rows in grouped.values()
        for row in source_rows[: max(1, int(len(source_rows) * 0.7))]
    }
    coefficients = fit_age_model(
        [row for row in rows if row["videoId"] in preliminary_train_ids]
    )
    components = variance_components(
        [row for row in rows if row["videoId"] in preliminary_train_ids],
        coefficients,
    )
    train_target_map, test_target_map, train_ids, test_ids = fixed_origin_targets(
        grouped,
        coefficients,
        components,
    )
    train_values, train_outcomes, train_metadata = select_embedding_rows(
        ids,
        vectors,
        metadata_by_id,
        train_target_map,
        train_ids,
    )
    test_values, test_outcomes, test_metadata = select_embedding_rows(
        ids,
        vectors,
        metadata_by_id,
        test_target_map,
        test_ids,
    )
    prediction, null_prediction, alpha, explained, train_count = evaluate_partition(
        train_values,
        train_outcomes,
        train_metadata,
        test_values,
        test_outcomes,
        test_metadata,
        77003,
    )
    return {
        **metrics(
            test_outcomes,
            prediction,
            null_prediction,
            test_metadata,
            78007,
        ),
        "selectedAlpha": alpha,
        "pcaVarianceExplained": rounded(explained),
        "trainingRowsAfterFamilyExclusion": train_count,
        "split": "first 70% of each creator chronology trains; age model uses only training rows; creator history is frozen at the split; later 30% tests",
    }


def apply_multiplicity(channels: list[dict[str, Any]]) -> dict[str, Any]:
    hypotheses = []
    for channel in channels:
        for split_key in ("unseenCreator", "laterVideo"):
            hypotheses.append(
                {
                    "channel": channel,
                    "splitKey": split_key,
                    "p": channel[split_key]["withinSourcePermutation"][
                        "spearmanOneSidedP"
                    ],
                }
            )
    corrections = adjusted_pvalues([hypothesis["p"] for hypothesis in hypotheses])
    for hypothesis, correction in zip(hypotheses, corrections):
        hypothesis["channel"][hypothesis["splitKey"]]["multiplicity"] = {
            "family": "all nested 6 format-by-modality channels across both validation splits",
            "hypotheses": len(hypotheses),
            **correction,
        }
    return {
        "primaryStatistic": "within-creator Spearman association",
        "hypotheses": len(hypotheses),
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
    manifest = json.loads(MANIFEST_PATH.read_text())
    manifest_objects = {item["role"]: item for item in manifest["objects"]}
    formats = load_panel()
    channels = []
    for format_name, modality in CHANNELS:
        print(f"nested validation {format_name}:{modality}", flush=True)
        ids, vectors = load_embeddings(format_name, modality)
        channel = {
            "id": f"{format_name}:{modality}",
            "format": format_name,
            "modality": modality,
            "dimensions": int(vectors.shape[1]),
            "vectorHash": manifest_objects[
                f"{format_name}:{modality}:vectors"
            ]["sha256"],
            "model": "fold-local outcome baseline + PCA64 + nested source-grouped Ridge",
            "unseenCreator": unseen_creator_validation(
                formats[format_name],
                ids,
                vectors,
            ),
            "laterVideo": later_video_validation(
                formats[format_name],
                ids,
                vectors,
            ),
        }
        channels.append(channel)
        del vectors

    output = {
        "schema": "nested-outcome-embedding-validation-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "estimand": "historically timed log10 views minus a fold-local age expectation and a train-estimated empirical-Bayes creator effect built from outcomes observed before upload",
        "sourceLineage": {
            "snapshotRunId": manifest["runId"],
            "snapshotIdentityHash": manifest["identityHash"],
            "panelArtifactSha256": hashlib.sha256(PANEL_PATH.read_bytes()).hexdigest(),
            "semanticFamilyArtifactSha256": hashlib.sha256(
                SEMANTIC_FAMILY_PATH.read_bytes()
            ).hexdigest(),
        },
        "channels": channels,
        "multiplicity": apply_multiplicity(channels),
        "leakageControls": [
            "The age curve is rebuilt without outer-test outcomes.",
            "Unseen-creator target baselines use only prior videos from that creator and an age curve learned from training creators.",
            "The later-video target freezes creator history at the 70% chronology split; no later-test outcome updates another test target.",
            "A prior outcome contributes only when its per-video observation time is no later than the target publication time.",
            "Creator effects use empirical-Bayes shrinkage with variance components estimated only from outer training rows.",
            "PCA and Ridge are fit only on outer training rows.",
            "Exact content families present in a test partition are removed from content-model training.",
            "Outcome-free semantic near-copy families present in a test partition are removed from content-model training and creator history.",
            "Ridge alpha is selected only from outer-training sources.",
        ],
        "claimBoundary": [
            "Views are a single current lifetime snapshot, not fixed-age impressions.",
            "Prior-video outcomes are final snapshot values and therefore define retrospective creator opportunity, not a historically deployable real-time feature.",
            "The test is predictive and observational; it does not identify a causal content intervention.",
        ],
    }
    serialized = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "multiplicity": output["multiplicity"],
                "channels": [
                    {
                        "id": channel["id"],
                        "unseenRho": channel["unseenCreator"]["spearman"],
                        "unseenBits": channel["unseenCreator"][
                            "gaussianBitsPerObservation"
                        ],
                        "laterRho": channel["laterVideo"]["spearman"],
                        "laterBits": channel["laterVideo"][
                            "gaussianBitsPerObservation"
                        ],
                    }
                    for channel in channels
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
