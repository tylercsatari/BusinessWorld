#!/usr/bin/env python3
"""Run and publish the Promise Lab held-out latency and natural-drop study."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from pathlib import Path

import numpy as np

from atlas import row_unit
from axes import spearman
from cluster_outcomes import balanced_group_positions
from embedding_store import R2_PREFIX, R2Store, json_ready
from latency_study import (
    AXIS_SEED,
    DEFAULT_LAGS,
    DEFAULT_WINDOWS,
    baseline_audit,
    lag_family_inference,
    natural_baseline_oof,
    retention_slope_matrix,
    shared_lag_semantic_oof,
    source_equal_curve_baseline,
    transfer_correlation_matrix,
    window_intervals,
)
from run_cluster_outcomes import load_or_build_global_inputs, load_timing_records
from media_alignment import apply_media_durations


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
VECTOR_DIR = CACHE / "all-span-vectors"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(json_ready(value), separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def atomic_json_gz(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(
        json_ready(value), separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(gzip.compress(raw, compresslevel=6))
    os.replace(temporary, path)


def matrix_json(values: np.ndarray, digits: int = 6) -> list:
    return np.round(np.asarray(values, float), digits).tolist()


def vector_json(values: np.ndarray, digits: int = 6) -> list:
    return np.round(np.asarray(values, float), digits).tolist()


def mean_finite(values: np.ndarray) -> float | None:
    values = np.asarray(values, float)
    values = values[np.isfinite(values)]
    return float(np.mean(values)) if len(values) else None


def paired_means(observed: np.ndarray, predicted: np.ndarray) -> dict:
    observed = np.asarray(observed, float)
    predicted = np.asarray(predicted, float)
    valid = np.isfinite(observed) & np.isfinite(predicted)
    if not valid.any():
        return {"observed": None, "predicted": None, "residual": None, "n": 0}
    return {
        "observed": float(np.mean(observed[valid])),
        "predicted": float(np.mean(predicted[valid])),
        "residual": float(np.mean(observed[valid] - predicted[valid])),
        "n": int(valid.sum()),
    }


def source_diverse_extremes(score: np.ndarray, groups: np.ndarray,
                            global_indices: np.ndarray, span_rows: list[dict],
                            limit: int = 20) -> dict:
    output = {}
    for name, order in (("high", np.argsort(-score)), ("low", np.argsort(score))):
        seen = set()
        rows = []
        for local_index in order:
            if not np.isfinite(score[local_index]):
                continue
            video_id = str(groups[local_index])
            if video_id in seen:
                continue
            seen.add(video_id)
            global_index = int(global_indices[local_index])
            rows.append({
                "globalIndex": global_index,
                "videoId": video_id,
                "text": span_rows[global_index]["text"],
                "score": float(score[local_index]),
            })
            if len(rows) >= limit:
                break
        output[name] = rows
    return output


def score_rank_diagnostic(scores: np.ndarray, lags: np.ndarray,
                          groups: np.ndarray) -> dict:
    lags = np.asarray(lags, float)
    zero = int(np.argmin(np.abs(lags - 0)))
    one = int(np.argmin(np.abs(lags - 1)))
    selected = balanced_group_positions(groups, per_group=32, seed=AXIS_SEED + 90)
    left = np.asarray(scores[zero, selected], float)
    right = np.asarray(scores[one, selected], float)
    valid = np.isfinite(left + right)
    left = left[valid]
    right = right[valid]
    if len(left) < 10:
        return {"status": "insufficient"}
    threshold_left = np.quantile(left, .9)
    threshold_right = np.quantile(right, .9)
    high_left = left >= threshold_left
    high_right = right >= threshold_right
    union = int(np.sum(high_left | high_right))
    return {
        "status": "complete",
        "lagA": float(lags[zero]),
        "lagB": float(lags[one]),
        "scoreSpearman": spearman(left, right),
        "topDecileJaccard": float(np.sum(high_left & high_right) / max(1, union)),
        "rows": int(len(left)),
        "meaning": (
            "low agreement means the independently fitted lag-specific rulers reorder the same spans; "
            "it does not by itself prove viewer response reversed"
        ),
    }


def summarize_window(window_id: str, raw: np.ndarray, normalized: np.ndarray,
                     semantic: dict, inference: dict, lags: np.ndarray,
                     groups: np.ndarray, raw_expected: np.ndarray | None = None,
                     raw_time_only: np.ndarray | None = None) -> dict:
    rows = []
    inference_rows = (inference["rows"] or {}).get(window_id, {})
    baseline = semantic["baseline"][window_id]
    time_only = semantic["timeOnlyBaseline"][window_id]
    residual = semantic["residuals"][window_id]
    for lag_index, lag in enumerate(lags):
        row = dict(inference_rows.get(str(lag_index), {"lag": float(lag)}))
        endpoint_audit = baseline_audit(
            normalized[:, lag_index], baseline[:, lag_index], groups,
            seed=AXIS_SEED + lag_index,
        )
        time_audit = baseline_audit(
            normalized[:, lag_index], time_only[:, lag_index], groups,
            seed=AXIS_SEED + 100 + lag_index,
        )
        normalized_means = paired_means(
            normalized[:, lag_index], baseline[:, lag_index],
        )
        row.update({
            "lag": float(lag),
            "measuredSpans": int(np.isfinite(normalized[:, lag_index]).sum()),
            "observedRawMean": mean_finite(raw[:, lag_index]),
            "baselineMatchedSpans": normalized_means["n"],
            "observedNormalizedMean": normalized_means["observed"],
            "expectedNormalizedMean": normalized_means["predicted"],
            "unexpectedNormalizedMean": normalized_means["residual"],
            "endpointBaseline": endpoint_audit,
            "timeOnlyBaseline": time_audit,
        })
        if raw_expected is not None:
            raw_means = paired_means(raw[:, lag_index], raw_expected[:, lag_index])
            row.update({
                "rawBaselineMatchedSpans": raw_means["n"],
                "observedRawMean": raw_means["observed"],
                "expectedRawMean": raw_means["predicted"],
                "unexpectedRawMean": raw_means["residual"],
                "rawEndpointBaseline": baseline_audit(
                    raw[:, lag_index], raw_expected[:, lag_index], groups,
                    seed=AXIS_SEED + 200 + lag_index,
                ),
            })
        if raw_time_only is not None:
            row["rawTimeOnlyBaseline"] = baseline_audit(
                raw[:, lag_index], raw_time_only[:, lag_index], groups,
                seed=AXIS_SEED + 300 + lag_index,
            )
        rows.append(row)

    causal = [row for row in rows if row["lag"] >= 0 and row.get("effect") is not None]
    negative = [row for row in rows if row["lag"] < 0 and row.get("rho") is not None]
    peak = max(causal, key=lambda row: row.get("effect", -np.inf)) if causal else {}
    negative_max = max((abs(row.get("rho", 0)) for row in negative), default=0.0)
    peak_bootstrap = (inference.get("peakBootstrap") or {}).get(window_id, {})
    latency_supported = bool(
        peak
        and peak.get("maxNullP", 1) <= .05
        and peak.get("effectCiLow", -1) > 0
        and peak.get("rho", 0) > negative_max
    )
    return {
        "id": window_id,
        "rows": rows,
        "peak": {
            **peak_bootstrap,
            "lag": peak.get("lag"),
            "effect": peak.get("effect"),
            "effectCiLow": peak.get("effectCiLow"),
            "effectCiHigh": peak.get("effectCiHigh"),
            "rho": peak.get("rho"),
            "maxNullP": peak.get("maxNullP"),
            "negativeControlMaxAbsRho": negative_max,
            "latencySupported": latency_supported,
            "decisionRule": (
                "positive-lag effect CI above zero, family-wise max-null p <= 0.05, "
                "and held-out rho above every negative-lag control"
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--clusters", default="0,1,2,3")
    parser.add_argument("--dimensions", type=int, default=32)
    parser.add_argument("--semantic-alpha", type=float, default=1.0)
    parser.add_argument("--baseline-alpha", type=float, default=.1)
    parser.add_argument("--null-repeats", type=int, default=512)
    parser.add_argument("--bootstrap-repeats", type=int, default=512)
    parser.add_argument("--timing-workers", type=int, default=16)
    args = parser.parse_args()
    clusters = [int(value) for value in args.clusters.split(",") if value.strip()]
    lags = DEFAULT_LAGS.copy()

    atlas = read_json(CACHE / "all-span-atlas.json")
    manifest = read_json(CACHE / "all-span-manifest.json")
    corpus = read_json(CACHE / "corpus.json")
    corpus["rows"] = apply_media_durations(corpus["rows"], CACHE)
    manual_projection = read_json(CACHE / "manual-projection.json")
    map_id = str(manual_projection.get("mapId") or "")
    if not map_id:
        raise RuntimeError("saved embedding does not declare a frozen map")
    frozen = next((row for row in atlas["maps"] if row["id"] == map_id), None)
    if not frozen:
        raise RuntimeError(f"saved frozen map {map_id} is missing from the current atlas")
    labels = np.asarray(frozen["labels"], np.int16)
    span_rows = manifest["rows"]
    hooks = manifest["hooks"]
    timing_records = load_timing_records(hooks, args.timing_workers)
    global_inputs = load_or_build_global_inputs(
        corpus["rows"], hooks, span_rows, timing_records,
    )
    hook_indices = global_inputs["hookIndices"].astype(int)
    video_ids = np.asarray([str(row["videoId"]) for row in span_rows])
    durations = global_inputs["durations"].astype(float)
    curves = [
        np.asarray(global_inputs["corpusById"][str(hook["videoId"])].get("curve") or [], float)
        for hook in hooks
    ]
    normalized_curves = [np.asarray(row, float) for row in global_inputs["normalizedCurves"]]

    progress_path = CACHE / "progress.json"
    remote = None if args.no_upload else R2Store()

    def progress(stage: str, cluster: int | None = None) -> None:
        value = {
            "version": 4, "status": "running", "stage": stage,
            "latencyStudyCluster": cluster,
            "latencyStudyClustersTotal": len(clusters),
            "updatedAt": int(time.time() * 1000),
        }
        atomic_json(progress_path, value)
        if remote:
            remote.put_json(f"{R2_PREFIX}/progress.json", value)

    progress("building -3s to +8s exact response windows")
    raw_by_window = {}
    normalized_by_window = {}
    intervals_by_window = {}
    measurement_audit = {}
    for spec in DEFAULT_WINDOWS:
        raw, raw_audit = retention_slope_matrix(
            curves, durations, global_inputs["spanStarts"], global_inputs["spanEnds"],
            hook_indices, lags, spec,
        )
        normalized, normalized_audit = retention_slope_matrix(
            normalized_curves, durations, global_inputs["spanStarts"],
            global_inputs["spanEnds"], hook_indices, lags, spec,
        )
        raw_by_window[spec.id] = raw
        normalized_by_window[spec.id] = normalized
        intervals_by_window[spec.id] = window_intervals(
            global_inputs["spanStarts"], global_inputs["spanEnds"], lags, spec,
        )
        measurement_audit[spec.id] = {
            "rawMeasuredByLag": raw_audit["measured"],
            "normalizedMeasuredByLag": normalized_audit["measured"],
        }

    curve_resolution = np.asarray([
        duration / max(1, len(curve) - 1)
        for curve, duration in zip(curves, durations)
        if len(curve) >= 2 and np.isfinite(duration)
    ], float)
    natural_curve = source_equal_curve_baseline(
        curves, normalized_curves, durations, np.arange(0.0, 16.0001, .5), 1.0,
    )

    raw_store = np.load(VECTOR_DIR / "raw.npy", mmap_mode="r")
    hook_means = np.zeros((len(hooks), raw_store.shape[1]), np.float32)
    for hook_index in range(len(hooks)):
        positions = np.flatnonzero(hook_indices == hook_index)
        hook_means[hook_index] = row_unit(
            np.asarray(raw_store[positions], np.float32)
        ).mean(axis=0)

    cluster_summaries = []
    detail_paths = []
    window_meta = {spec.id: {
        "id": spec.id, "label": spec.label, "anchor": spec.anchor,
        "widthSeconds": spec.width, "definition": spec.definition,
    } for spec in DEFAULT_WINDOWS}

    for cluster in clusters:
        progress(f"fitting one shared held-out semantic ruler for cluster {cluster}", cluster)
        global_indices = np.flatnonzero(labels == cluster)
        cluster_hook_indices = hook_indices[global_indices]
        groups = video_ids[global_indices]
        semantic_features = row_unit(
            row_unit(np.asarray(raw_store[global_indices], np.float32))
            - hook_means[cluster_hook_indices]
        )
        row_durations = durations[cluster_hook_indices]
        entries = global_inputs["entries"][cluster_hook_indices]
        terminals = global_inputs["terminals"][cluster_hook_indices]
        amplitudes = global_inputs["amplitudes"][cluster_hook_indices]
        predicted_entries = global_inputs["predictedEntries"][cluster_hook_indices]
        cluster_normalized = {
            name: values[global_indices] for name, values in normalized_by_window.items()
        }
        cluster_raw = {
            name: values[global_indices] for name, values in raw_by_window.items()
        }
        cluster_intervals = {
            name: (left[global_indices], right[global_indices])
            for name, (left, right) in intervals_by_window.items()
        }
        semantic = shared_lag_semantic_oof(
            semantic_features, groups, cluster_normalized, cluster_intervals, lags,
            row_durations, entries, terminals, amplitudes, predicted_entries,
            dimensions=args.dimensions, semantic_alpha=args.semantic_alpha,
            baseline_alpha=args.baseline_alpha,
        )
        inference = lag_family_inference(
            semantic["score"], semantic["residuals"], groups, lags,
            repeats=max(args.null_repeats, args.bootstrap_repeats),
            seed=AXIS_SEED + cluster * 1009,
        )
        phrase_raw_expected = natural_baseline_oof(
            cluster_raw["phrase"], cluster_intervals["phrase"], groups,
            row_durations, entries, terminals, amplitudes, predicted_entries,
            include_endpoints=True, alpha=args.baseline_alpha,
            seed=AXIS_SEED + cluster * 101,
        )
        phrase_raw_time = natural_baseline_oof(
            cluster_raw["phrase"], cluster_intervals["phrase"], groups,
            row_durations, entries, terminals, amplitudes, predicted_entries,
            include_endpoints=False, alpha=args.baseline_alpha,
            seed=AXIS_SEED + cluster * 101 + 50_000,
        )
        windows = []
        for spec in DEFAULT_WINDOWS:
            summary = summarize_window(
                spec.id, cluster_raw[spec.id], cluster_normalized[spec.id],
                semantic, inference, lags, groups,
                phrase_raw_expected if spec.id == "phrase" else None,
                phrase_raw_time if spec.id == "phrase" else None,
            )
            summary.update(window_meta[spec.id])
            windows.append(summary)
        transfer = transfer_correlation_matrix(
            semantic["transferScores"], semantic["residuals"]["phrase"], groups,
            seed=AXIS_SEED + cluster * 313,
        )
        fold_energy = [row["firstModeEnergy"] for row in semantic["folds"]]
        cluster_summaries.append({
            "label": cluster,
            "spanInstances": int(len(global_indices)),
            "sourceVideos": len(set(groups)),
            "sharedAxis": {
                "definition": (
                    "first left singular mode of fold-trained semantic coefficients across every "
                    "window and lag; one score is frozen for each held-out span"
                ),
                "representation": "raw span embedding minus source-hook mean",
                "pcaDimensions": args.dimensions,
                "ridgeAlpha": args.semantic_alpha,
                "firstModeEnergyMean": float(np.mean(fold_energy)),
                "firstModeEnergyByFold": fold_energy,
                "foldAxisMedianCosine": semantic["foldAxisMedianCosine"],
                "foldAxisMedianAbsoluteCosine": semantic["foldAxisMedianAbsoluteCosine"],
                "foldAxisPositivePairFraction": semantic["foldAxisPositivePairFraction"],
                "allFoldDirectionsAgree": semantic["allFoldDirectionsAgree"],
                "foldAxisCosines": semantic["foldAxisCosines"],
                "extremes": source_diverse_extremes(
                    semantic["score"], groups, global_indices, span_rows,
                ),
            },
            "windows": windows,
            "axisTransfer": {
                "window": "phrase",
                "rowsAreAxisTrainedAtLag": True,
                "columnsAreResponseMeasuredAtLag": True,
                "values": matrix_json(transfer, 5),
                "rankDiagnostic0to1": score_rank_diagnostic(
                    semantic["transferScores"], lags, groups,
                ),
                "interpretation": (
                    "each row freezes the held-out semantic ruler trained for that row lag, then "
                    "tests it against every response lag; sign changes off the diagonal are true "
                    "cross-lag reversals, while disagreement between row rulers is model instability"
                ),
            },
            "validation": {
                "outerFolds": semantic["folds"],
                "groupedBy": "source video",
                "equalRowsPerSource": 32,
                "outcomesInClustering": False,
                "clusterLabelsChanged": False,
                "lagFamilyInference": {
                    key: inference[key] for key in (
                        "nullRepeats", "equalRowsPerSource", "sourceVideos", "nullPolicy"
                    )
                },
            },
        })
        detail = {
            "version": 1, "status": "complete", "mapId": map_id,
            "cluster": cluster, "lagsSeconds": lags.astype(float).tolist(),
            "globalIndices": global_indices.astype(int).tolist(),
            "sharedSemanticScoreOOF": vector_json(semantic["score"], 5),
            "spanStartSeconds": vector_json(global_inputs["spanStarts"][global_indices], 4),
            "spanEndSeconds": vector_json(global_inputs["spanEnds"][global_indices], 4),
            "phrase": {
                "observedRaw": matrix_json(cluster_raw["phrase"], 6),
                "expectedRawOOF": matrix_json(phrase_raw_expected, 6),
                "unexpectedRaw": matrix_json(
                    cluster_raw["phrase"] - phrase_raw_expected, 6,
                ),
                "observedNormalized": matrix_json(cluster_normalized["phrase"], 6),
                "expectedNormalizedOOF": matrix_json(semantic["baseline"]["phrase"], 6),
                "unexpectedNormalized": matrix_json(semantic["residuals"]["phrase"], 6),
            },
        }
        detail_path = CACHE / "latency-study-details" / f"{cluster}.json.gz"
        atomic_json_gz(detail_path, detail)
        detail_paths.append((detail_path, cluster))
        if remote:
            remote.put_json(
                f"{R2_PREFIX}/latency-study/{cluster}.json.gz", detail,
                gzip_payload=True,
            )
        del semantic_features, semantic, phrase_raw_expected, phrase_raw_time

    source_curves = []
    for hook_index, hook in enumerate(hooks):
        source_curves.append({
            "hookIndex": hook_index,
            "videoId": str(hook["videoId"]),
            "title": hook.get("title"),
            "durationSeconds": float(durations[hook_index]),
            "curveSampleSeconds": float(
                durations[hook_index] / max(1, len(curves[hook_index]) - 1)
            ),
            "curve": np.round(curves[hook_index], 5).astype(float).tolist(),
        })
    summary = {
        "version": 1,
        "status": "complete",
        "stage": "held-out fixed-ruler latency and natural-drop study",
        "mapId": map_id,
        "clusterCount": len(cluster_summaries),
        "lagsSeconds": lags.astype(float).tolist(),
        "lagRange": {"minimum": float(lags.min()), "maximum": float(lags.max()), "step": .5},
        "negativeControlPolicy": "lags below zero are falsification controls, never candidate response lags",
        "windows": list(window_meta.values()),
        "clusters": cluster_summaries,
        "sourceEqualNaturalDrop": natural_curve,
        "sourceCurves": source_curves,
        "measurementAudit": measurement_audit,
        "curveResolution": {
            "curvePointsPerVideo": 100,
            "minimumSampleSeconds": float(np.min(curve_resolution)),
            "medianSampleSeconds": float(np.median(curve_resolution)),
            "p90SampleSeconds": float(np.quantile(curve_resolution, .9)),
            "maximumSampleSeconds": float(np.max(curve_resolution)),
            "videosAtOrFinerThanHalfSecond": int(np.sum(curve_resolution <= .5)),
            "videos": int(len(curve_resolution)),
            "warning": (
                "the 0.5-second lag grid is descriptive interpolation; adjacent lags are not "
                "independent when a source curve's native sample interval is coarser"
            ),
        },
        "method": {
            "semanticInput": "exact contiguous span text in the frozen Long Quant embedding space",
            "semanticRuler": (
                "one fold-trained SVD mode shared across all five alignments and all 23 lags"
            ),
            "naturalDropInput": (
                "time, normalized time, window width, video duration, entry, terminal, amplitude, "
                "and out-of-fold expected entry; no text or embedding"
            ),
            "outerValidation": "five source-video-held-out folds",
            "uncertainty": (
                "source-video bootstrap intervals plus source-video sign-flip max-null correction "
                "across all 115 window-lag tests per cluster"
            ),
            "causalClaim": False,
        },
        "timingAudit": global_inputs["timingAudit"],
        "builtAt": int(time.time() * 1000),
    }
    output_path = CACHE / "latency-study.json"
    atomic_json(output_path, summary)
    if remote:
        remote.put_json(f"{R2_PREFIX}/latency-study.json.gz", summary, gzip_payload=True)
    complete = {
        "version": 4, "status": "complete",
        "stage": "held-out latency and natural-drop study complete",
        "latencyStudyClustersComplete": len(clusters),
        "latencyStudyClustersTotal": len(clusters),
        "updatedAt": int(time.time() * 1000),
    }
    atomic_json(progress_path, complete)
    if remote:
        remote.put_json(f"{R2_PREFIX}/progress.json", complete)
    print(json.dumps({
        "status": "complete",
        "clusters": len(cluster_summaries),
        "lags": len(lags),
        "windows": len(DEFAULT_WINDOWS),
        "summary": str(output_path),
        "details": [str(path) for path, _ in detail_paths],
    }, indent=2))


if __name__ == "__main__":
    main()
