#!/usr/bin/env python3
"""Train, cross-fit, decompose, and publish the deterministic hook-quality axis."""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from atlas import row_unit
from cluster_outcomes import (
    entry_terminal_diagnostic,
    exact_token_timings,
    span_interval,
)
from embedding_store import R2_PREFIX, EmbeddingStore, R2Store, json_ready
from hook_quality import (
    QUALITY_SEED,
    RETENTION_FEATURES,
    bootstrap_directions,
    fit_full_axis,
    nested_axis_validation,
    retention_inputs,
    select_full_configuration,
)
from hook_score_core import (
    pair_interactions, percentile, projection_scores, shapley_values,
    subset_texts as component_subset_texts,
)
from latency_study import (
    DEFAULT_LAGS,
    DEFAULT_WINDOWS,
    lag_family_inference,
    natural_baseline_oof,
    retention_slope_matrix,
    window_intervals,
)
from run_cluster_outcomes import load_timing_records
from sequence import tokenize, without


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
VECTOR_DIR = CACHE / "all-span-vectors"
MODEL_PATH = CACHE / "hook-quality-model.json"
SUMMARY_PATH = CACHE / "hook-quality.json"
METHOD_VERSION = "crossfit-retention-factor-axis-shapley-v1"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                   allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def leave_one_out_nearest(features: np.ndarray) -> np.ndarray:
    similarity = row_unit(features) @ row_unit(features).T
    np.fill_diagonal(similarity, -np.inf)
    return similarity.max(axis=1).astype(np.float32)


def deterministic_orthogonal(features: np.ndarray, direction: np.ndarray) -> np.ndarray:
    features = row_unit(features)
    direction = np.asarray(direction, np.float32)
    residual = features - (features @ direction)[:, None] * direction[None, :]
    reducer = PCA(n_components=1, svd_solver="full").fit(residual)
    second = reducer.components_[0].astype(np.float32)
    second -= float(second @ direction) * direction
    second /= np.linalg.norm(second) + 1e-9
    pivot = int(np.argmax(np.abs(second)))
    if second[pivot] < 0:
        second = -second
    return second


def component_latency(corpus: list[dict], hooks: list[dict], partitions: list[dict],
                      component_scores: np.ndarray, curve_inputs: dict,
                      timing_workers: int, repeats: int) -> dict:
    timing_records = load_timing_records(hooks, timing_workers)
    hook_by_id = {str(row["videoId"]): row for row in hooks}
    corpus_by_id = {str(row["id"]): row for row in corpus}
    starts = []
    ends = []
    groups = []
    hook_indices = []
    exact_sources = set()
    timing_status = defaultdict(int)
    for hook_index, partition in enumerate(partitions):
        video_id = str(partition["videoId"])
        record = timing_records.get(video_id) or {}
        timing = exact_token_timings(
            str(hook_by_id[video_id]["text"]), record.get("words") or [],
        ) if record.get("words") else {"status": "missing-words"}
        timing_status[str(timing.get("status"))] += 1
        if timing.get("status") == "exact":
            exact_sources.add(video_id)
        for chunk in partition["chunks"]:
            start, end = span_interval(timing, int(chunk["start"]), int(chunk["end"]))
            starts.append(start)
            ends.append(end)
            groups.append(video_id)
            hook_indices.append(hook_index)

    starts = np.asarray(starts, np.float32)
    ends = np.asarray(ends, np.float32)
    groups = np.asarray(groups).astype(str)
    hook_indices = np.asarray(hook_indices, int)
    durations = np.asarray([float(row.get("duration_s") or np.nan) for row in corpus], float)
    raw_curves = [np.asarray(row.get("curve") or [], float) for row in corpus]
    normalized_curves = [np.asarray(row, float) for row in curve_inputs["normalizedCurves"]]
    entries = np.asarray([row.get("entry", np.nan) for row in curve_inputs["curveMeta"]], float)
    terminals = np.asarray([row.get("terminal", np.nan) for row in curve_inputs["curveMeta"]], float)
    amplitudes = np.asarray([row.get("amplitude", np.nan) for row in curve_inputs["curveMeta"]], float)
    entry_diagnostic = entry_terminal_diagnostic(entries, terminals, durations)
    predicted_entries = np.asarray(entry_diagnostic["predictedEntryOOF"], float)
    row_durations = durations[hook_indices]
    row_entries = entries[hook_indices]
    row_terminals = terminals[hook_indices]
    row_amplitudes = amplitudes[hook_indices]
    row_predicted_entries = predicted_entries[hook_indices]
    lags = DEFAULT_LAGS.copy()
    residuals = {}
    measurement = {}
    natural_drop = {}
    for spec in DEFAULT_WINDOWS:
        normalized, audit = retention_slope_matrix(
            normalized_curves, durations, starts, ends, hook_indices, lags, spec,
        )
        raw, raw_audit = retention_slope_matrix(
            raw_curves, durations, starts, ends, hook_indices, lags, spec,
        )
        intervals = window_intervals(starts, ends, lags, spec)
        expected = natural_baseline_oof(
            normalized, intervals, groups, row_durations, row_entries, row_terminals,
            row_amplitudes, row_predicted_entries, include_endpoints=True,
            folds=5, per_group=4, seed=QUALITY_SEED,
        )
        residuals[spec.id] = normalized - expected
        zero_index = int(np.argmin(np.abs(lags)))
        valid = np.isfinite(normalized[:, zero_index] + expected[:, zero_index])
        natural_drop[spec.id] = {
            "matchedComponentsAtZeroLag": int(valid.sum()),
            "observedMeanSlopeAtZeroLag": float(np.mean(normalized[valid, zero_index])) if valid.any() else None,
            "expectedMeanSlopeAtZeroLag": float(np.mean(expected[valid, zero_index])) if valid.any() else None,
            "unexpectedMeanSlopeAtZeroLag": float(np.mean(residuals[spec.id][valid, zero_index])) if valid.any() else None,
        }
        measurement[spec.id] = {
            "definition": spec.definition,
            "normalizedMeasuredByLag": audit["measured"],
            "rawMeasuredByLag": raw_audit["measured"],
        }
    inference = lag_family_inference(
        component_scores, residuals, groups, lags, repeats=repeats,
        per_group=4, seed=QUALITY_SEED + 700,
    )
    all_rows = []
    negative_max = 0.0
    for window_id, rows in inference["rows"].items():
        for row in rows.values():
            compact = {"window": window_id, **row,
                       "measured": int(np.isfinite(residuals[window_id][:, int(round((row["lag"] - lags[0]) / .5))]).sum())}
            all_rows.append(compact)
            if float(row["lag"]) < 0:
                negative_max = max(negative_max, abs(float(row["rho"])))
    causal = [row for row in all_rows if float(row["lag"]) >= 0]
    peak = max(causal, key=lambda row: float(row.get("effect") or -np.inf)) if causal else None
    supported = bool(
        peak and float(peak.get("maxNullP") or 1) <= .05
        and float(peak.get("effectCiLow") or -1) > 0
        and float(peak.get("rho") or 0) > negative_max
    )
    return {
        "status": "complete",
        "lagsSeconds": lags.astype(float).tolist(),
        "windows": [{"id": spec.id, "label": spec.label, "definition": spec.definition}
                    for spec in DEFAULT_WINDOWS],
        "timingAudit": {
            "sources": len(partitions), "exactSources": len(exact_sources),
            "statusCounts": dict(timing_status),
            "componentsWithExactPositiveDuration": int(np.isfinite(starts + ends).sum()),
        },
        "naturalDrop": natural_drop,
        "measurement": measurement,
        "rows": all_rows,
        "peak": peak,
        "negativeControlMaxAbsRho": negative_max,
        "latencySupported": supported,
        "selectedLagSeconds": float(peak["lag"]) if supported else None,
        "decisionRule": (
            "positive-lag effect CI above zero, source-sign-flip family-wise max-null p <= 0.05, "
            "and held-out rho above every negative-lag control"
        ),
        "crossFitting": (
            "each component score uses an axis trained without its source video; the natural-drop "
            "baseline also predicts each source out of fold"
        ),
        "inference": inference,
        "entryDiagnostic": entry_diagnostic,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--bootstrap-repeats", type=int, default=128)
    parser.add_argument("--null-repeats", type=int, default=4096)
    parser.add_argument("--latency-repeats", type=int, default=1024)
    parser.add_argument("--timing-workers", type=int, default=16)
    args = parser.parse_args()
    started = time.time()

    corpus_payload = read_json(CACHE / "corpus.json")
    corpus = corpus_payload["rows"]
    manifest = read_json(CACHE / "all-span-manifest.json")
    partitions_payload = read_json(CACHE / "canonical-partitions.json")
    partitions = partitions_payload["rows"]
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in manifest["hooks"]]:
        raise RuntimeError("corpus and all-span hook order do not match")
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in partitions]:
        raise RuntimeError("canonical partition order does not match the corpus")

    features = row_unit(np.asarray(
        np.load(VECTOR_DIR / "full.npy", mmap_mode="r"), np.float32,
    ))
    token_counts = np.asarray([int(row["tokenCount"]) for row in manifest["hooks"]], int)
    curve_inputs = retention_inputs(corpus, token_counts)
    validation = nested_axis_validation(
        features, curve_inputs["retentionMatrix"], curve_inputs["confounds"],
        folds=5, null_repeats=args.null_repeats,
    )
    observed_log_views = np.log10(np.maximum(
        1, np.asarray([float(row.get("views") or 0) for row in corpus], float),
    ))[:, None]
    views_validation = nested_axis_validation(
        features, observed_log_views, curve_inputs["confounds"],
        folds=5, null_repeats=args.null_repeats,
    )
    joint_target = np.column_stack([curve_inputs["retentionMatrix"], observed_log_views])
    joint_validation = nested_axis_validation(
        features, joint_target, curve_inputs["confounds"],
        folds=5, null_repeats=args.null_repeats,
    )
    joint_selection = select_full_configuration(
        features, joint_target, curve_inputs["confounds"],
    )
    joint_fit = fit_full_axis(
        features, joint_target, curve_inputs["confounds"],
        joint_selection["selected"]["dimensions"], joint_selection["selected"]["alpha"],
    )
    falsification_audits = {
        "observedLogViewsOnly": {
            "heldoutSpearman": views_validation["heldoutSpearman"],
            "heldoutPearson": views_validation["heldoutPearson"],
            "signFlipP": views_validation["signFlipP"],
            "accepted": bool(views_validation["signFlipP"] <= .05 and views_validation["heldoutSpearman"] > 0),
        },
        "retentionPlusObservedLogViewsPca": {
            "heldoutSpearman": joint_validation["heldoutSpearman"],
            "signFlipP": joint_validation["signFlipP"],
            "factorLoadings": joint_fit["targetMeta"]["retentionFactorLoadings"],
            "observedLogViewsLoading": joint_fit["targetMeta"]["retentionFactorLoadings"][-1],
            "accepted": bool(joint_fit["targetMeta"]["retentionFactorLoadings"][-1] > 0),
        },
        "decision": (
            "reject a virality label: observed log views does not validate alone and enters the "
            "joint unsupervised factor with the opposite sign from retained information"
        ),
    }
    selection = select_full_configuration(
        features, curve_inputs["retentionMatrix"], curve_inputs["confounds"],
    )
    selected = selection["selected"]
    fitted = fit_full_axis(
        features, curve_inputs["retentionMatrix"], curve_inputs["confounds"],
        selected["dimensions"], selected["alpha"],
    )
    bootstrap = bootstrap_directions(
        features, curve_inputs["retentionMatrix"], curve_inputs["confounds"],
        selected["dimensions"], selected["alpha"], repeats=args.bootstrap_repeats,
    )
    direction = np.asarray(fitted["direction"], np.float32)
    second_direction = deterministic_orthogonal(features, direction)

    text_by_source = {
        str(row["videoId"]): component_subset_texts(
            row["text"], tokenize(row["text"]),
            np.asarray([int(token["owner"]) for token in row["tokens"]], int),
        ) for row in partitions
    }
    required = []
    for texts in text_by_source.values():
        required.extend(text for mask, text in texts.items() if mask != 15 and text)
    embedding_store = EmbeddingStore(CACHE / "hook-quality-embeddings.sqlite3")
    try:
        embedded = embedding_store.embed_many(required)
    finally:
        embedding_store.close()

    fold_directions = [np.asarray(row["direction"], np.float32) for row in validation["folds"]]
    fold_training = [np.asarray(row["trainingProjectionSorted"], float)
                     for row in validation["folds"]]
    component_rows = []
    source_rows = []
    component_oof_scores = []
    category_values = defaultdict(list)
    pair_values = defaultdict(list)
    sequence_values = defaultdict(list)
    for hook_index, (corpus_row, partition) in enumerate(zip(corpus, partitions)):
        fold_index = int(validation["foldIndex"][hook_index])
        oof_direction = fold_directions[fold_index]
        texts = text_by_source[str(partition["videoId"])]
        vectors = {}
        for mask, text in texts.items():
            vectors[mask] = features[hook_index] if mask == 15 else embedded[text]
        scores = projection_scores(vectors, oof_direction)
        shapley = shapley_values(scores, 4)
        interactions = pair_interactions(scores, 4)
        component_start = len(component_rows)
        for index, (chunk, value) in enumerate(zip(partition["chunks"], shapley)):
            category = int(chunk["category"])
            row = {
                "sourceIndex": hook_index,
                "videoId": partition["videoId"],
                "component": index,
                "category": category,
                "start": int(chunk["start"]), "end": int(chunk["end"]),
                "text": chunk["text"],
                "shapley": float(value),
                "singletonAxisCoordinate": float(scores[1 << index]),
                "deletionEffect": float(scores[15] - scores[15 ^ (1 << index)]),
            }
            component_rows.append(row)
            component_oof_scores.append(float(value))
            category_values[str(category)].append(float(value))
        for row in interactions:
            left = int(row["left"]); right = int(row["right"])
            pair_key = f"{partition['chunks'][left]['category']}->{partition['chunks'][right]['category']}"
            row["categoryPair"] = pair_key
            pair_values[pair_key].append(float(row["interaction"]))
        sequence_key = "-".join(str(row["category"]) for row in partition["chunks"])
        sequence_values[sequence_key].append(float(scores[15]))
        source_rows.append({
            "index": hook_index,
            "videoId": partition["videoId"],
            "title": corpus_row.get("title") or "",
            "text": partition["text"],
            "axisCoordinate": float(features[hook_index] @ direction),
            "axisPercentile": percentile(fitted["trainingProjections"], float(features[hook_index] @ direction)),
            "mapY": float(features[hook_index] @ second_direction),
            "oofAxisCoordinate": float(scores[15]),
            "oofAxisPercentile": percentile(fold_training[fold_index], float(scores[15])),
            "oofTargetResidual": float(validation["targets"][hook_index]),
            "fold": fold_index,
            "sequence": sequence_key,
            "componentOffset": component_start,
            "componentCount": 4,
            "partitionScoreGap": partition.get("scoreGap"),
            "partitionScoreGapPercentile": partition.get("scoreGapPercentile"),
            "pairInteractions": interactions,
            "subsetScores": {str(mask): float(value) for mask, value in sorted(scores.items())},
            "shapleyEfficiencyError": float(abs(shapley.sum() - scores[15])),
            "retentionFeatures": curve_inputs["retentionMatrix"][hook_index].astype(float).tolist(),
        })

    category_calibration = {key: np.sort(values).astype(float).tolist()
                            for key, values in category_values.items()}
    pair_calibration = {key: np.sort(values).astype(float).tolist()
                        for key, values in pair_values.items()}
    for row in component_rows:
        row["categoryPercentile"] = percentile(
            np.asarray(category_calibration[str(row["category"])]), row["shapley"]
        )
    latency = component_latency(
        corpus, manifest["hooks"], partitions, np.asarray(component_oof_scores, float),
        curve_inputs, args.timing_workers, args.latency_repeats,
    )

    full_projection = features @ direction
    bootstrap_training = bootstrap @ features.T
    loo_nearest = leave_one_out_nearest(features)
    model = {
        "version": 1,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "embeddingModel": manifest["embeddingModel"],
        "embeddingDimensions": manifest["embeddingDimensions"],
        "semanticRules": 0,
        "generativeLlmUsed": False,
        "trainingExamples": len(features),
        "qualityDirection": np.round(direction, 8).astype(float).tolist(),
        "mapOrthogonalDirection": np.round(second_direction, 8).astype(float).tolist(),
        "trainingProjectionsSorted": np.sort(full_projection).astype(float).tolist(),
        "bootstrapDirections": np.round(bootstrap, 8).astype(float).tolist(),
        "bootstrapTrainingProjectionsSorted": np.sort(bootstrap_training, axis=1).astype(float).tolist(),
        "trainingIds": [str(row["id"]) for row in corpus],
        "trainingTexts": [str(row["hookText"]) for row in corpus],
        "trainingFullEmbeddings": np.round(features, 7).astype(float).tolist(),
        "leaveOneOutNearestCosineSorted": np.sort(loo_nearest).astype(float).tolist(),
        "categoryShapleyCalibration": category_calibration,
        "pairInteractionCalibration": pair_calibration,
        "partitionModelArtifact": "canonical-partition-model.json.gz",
        "target": {
            "name": "endpoint-normalized retained-information factor",
            "features": list(RETENTION_FEATURES),
            "factorLoadings": fitted["targetMeta"]["retentionFactorLoadings"],
            "factorExplainedVariance": fitted["targetMeta"]["retentionFactorExplainedVariance"],
            "confoundsRemoved": curve_inputs["confoundNames"],
            "higherMeans": "more retained information than expected after measured confounds",
        },
        "selectedConfiguration": selected,
        "configurationSearch": selection["configurations"],
        "validation": {
            key: value for key, value in validation.items()
            if key not in {"predictions", "axisCoordinates", "axisPercentiles", "targets", "foldIndex"}
        },
        "falsificationAudits": falsification_audits,
        "latencyDecision": {
            "supported": latency["latencySupported"],
            "selectedLagSeconds": latency["selectedLagSeconds"],
            "decisionRule": latency["decisionRule"],
        },
        "scoreDefinition": (
            "cosine projection of a unit Gemini hook embedding onto the frozen quality direction; "
            "display score is its percentile among the 208 training hooks"
        ),
        "componentDefinition": (
            "exact four-player Shapley decomposition over all 16 subsets, with subset text preserving "
            "source order and every retained source character"
        ),
        "confidenceChannels": [
            "nested five-fold held-out association", "source bootstrap axis variation",
            "nearest-training-hook cosine", "canonical-partition top-two score gap",
        ],
    }
    summary = {
        "version": 1,
        "status": "complete",
        "stage": "deterministic hook-quality latent axis and exact component attribution",
        "methodVersion": METHOD_VERSION,
        "model": {
            "scoreLabel": "Hook retained-information percentile",
            "trainingHooks": len(features),
            "heldoutSpearman": validation["heldoutSpearman"],
            "heldoutPearson": validation["heldoutPearson"],
            "signFlipP": validation["signFlipP"],
            "foldDirectionMedianCosine": validation["foldDirectionMedianCosine"],
            "foldDirectionPositiveFraction": validation["foldDirectionPositiveFraction"],
            "targetFactorExplainedVariance": fitted["targetMeta"]["retentionFactorExplainedVariance"],
            "selectedDimensions": selected["dimensions"],
            "selectedAlpha": selected["alpha"],
            "generativeLlmUsed": False,
        },
        "axis": {
            "x": "quality-axis cosine coordinate; right is higher residual retained information",
            "y": "largest remaining semantic PCA direction after removing the quality axis",
            "color": "cross-fitted observed retained-information residual",
            "points": source_rows,
        },
        "components": component_rows,
        "calibration": {
            "categoryShapley": category_calibration,
            "pairInteraction": pair_calibration,
            "sequenceCounts": {key: len(values) for key, values in sequence_values.items()},
        },
        "latency": latency,
        "falsificationAudits": falsification_audits,
        "audit": {
            "subsetEmbeddings": len(set(required)),
            "componentRows": len(component_rows),
            "maximumShapleyEfficiencyError": max(row["shapleyEfficiencyError"] for row in source_rows),
            "partitionCoverageFailures": partitions_payload["validation"]["coverageFailures"],
            "partitionOverlaps": partitions_payload["validation"]["overlaps"],
            "elapsedSeconds": round(time.time() - started, 3),
        },
    }
    atomic_json(MODEL_PATH, model)
    atomic_json(SUMMARY_PATH, summary)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/hook-quality-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/hook-quality.json.gz", summary, gzip_payload=True)
    print(json.dumps({
        "heldoutSpearman": validation["heldoutSpearman"],
        "signFlipP": validation["signFlipP"],
        "selected": selected,
        "subsetEmbeddings": len(set(required)),
        "latencySupported": latency["latencySupported"],
        "elapsedSeconds": summary["audit"]["elapsedSeconds"],
    }, indent=2))


if __name__ == "__main__":
    main()
