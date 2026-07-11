#!/usr/bin/env python3
"""Fit and publish outcome axes inside each cluster of the frozen k=4 map."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from atlas import row_unit
from cluster_outcomes import (
    AXIS_SEED,
    apply_family_fdr,
    balanced_group_positions,
    endpoint_normalize_curve,
    entry_terminal_diagnostic,
    exact_token_timings,
    fit_full_target_map,
    grouped_baseline_residual,
    grouped_splits,
    prepare_full_scores,
    prepare_representation_folds,
    prepare_target_folds,
    retention_at,
    retention_window_slope,
    search_target_axes,
    span_interval,
)
from embedding_store import R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
VECTOR_DIR = CACHE / "all-span-vectors"
TIMING_DIR = CACHE / "hook-timing"
MAP_ID = "0042a54b685d55438242"
DEFAULT_DIMENSIONS = [4, 8, 16, 32, 64]
DEFAULT_ALPHAS = [0.01, 0.1, 1.0, 10.0, 100.0, 1000.0]
OFFSETS = list(range(6))


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
        json_ready(value), separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(gzip.compress(raw, compresslevel=6))
    os.replace(temporary, path)


def parse_numbers(value: str, cast) -> list:
    return [cast(item.strip()) for item in value.split(",") if item.strip()]


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_timing_records(hooks: list[dict], workers: int = 16) -> dict[str, dict]:
    TIMING_DIR.mkdir(parents=True, exist_ok=True)
    output = {}
    missing = []
    for hook in hooks:
        video_id = str(hook["videoId"])
        path = TIMING_DIR / f"{video_id}.json"
        if path.exists():
            output[video_id] = read_json(path)
        else:
            missing.append(video_id)
    if not missing:
        return output

    store = R2Store()

    def fetch(video_id: str) -> tuple[str, dict]:
        record = store.get_json(f"longform/hook-embeds/{video_id}.json", {}) or {}
        compact = {
            "videoId": video_id,
            "hookText": record.get("hookText"),
            "words": record.get("words") or [],
            "transcriptSource": record.get("transcriptSource"),
        }
        if not compact["words"]:
            compact["error"] = "stored hook record has no caption words"
        atomic_json(TIMING_DIR / f"{video_id}.json", compact)
        return video_id, compact

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        jobs = [pool.submit(fetch, video_id) for video_id in missing]
        for job in as_completed(jobs):
            video_id, record = job.result()
            output[video_id] = record
    return output


def target_definitions() -> dict[str, dict]:
    definitions = {
        "views_raw": {
            "label": "Views raw",
            "family": "performance",
            "channel": "observed YouTube outcome",
            "unit": "views",
            "definition": "measured raw view count for the source Short",
        },
        "views_log": {
            "label": "Views log",
            "family": "performance",
            "channel": "observed YouTube outcome",
            "unit": "log10 views",
            "definition": "log10 measured view count for the source Short",
        },
        "realistic_views": {
            "label": "Realistic views",
            "family": "performance",
            "channel": "Long Quant text-model estimate",
            "unit": "estimated views",
            "definition": "Long Quant realistic-views estimate for the complete hook text",
        },
        "outlier": {
            "label": "Outlier",
            "family": "performance",
            "channel": "Long Quant text-model estimate",
            "unit": "scaled-view estimate",
            "definition": "Long Quant scaled-views/outlier estimate for the complete hook text",
        },
        "class_10m": {
            "label": "10M-view class",
            "family": "performance",
            "channel": "observed YouTube outcome",
            "unit": "binary class",
            "definition": "one when measured views are at least ten million, otherwise zero",
        },
        "swipe_ratio": {
            "label": "Swipe ratio",
            "family": "performance",
            "channel": "observed YouTube outcome",
            "unit": "viewed percentage",
            "definition": "measured viewed-versus-swiped percentage (the stored keep rate)",
        },
        "retention_5s": {
            "label": "5-second retention",
            "family": "performance",
            "channel": "observed YouTube outcome",
            "unit": "retained-viewer ratio",
            "definition": "measured retention curve interpolated at five seconds",
        },
    }
    for offset in OFFSETS:
        definitions[f"slope_raw_o{offset}"] = {
            "label": f"Raw phrase slope +{offset}s",
            "family": "raw-slope",
            "channel": "observed YouTube retention geometry",
            "unit": "retention ratio per second",
            "offsetSeconds": offset,
            "definition": (
                "least-squares slope over the exact spoken span interval after shifting both "
                f"boundaries forward by {offset} second(s)"
            ),
        }
        definitions[f"slope_normalized_o{offset}"] = {
            "label": f"Endpoint-normalized slope +{offset}s",
            "family": "normalized-slope",
            "channel": "normalized observed retention geometry",
            "unit": "endpoint-normalized retention per second",
            "offsetSeconds": offset,
            "definition": (
                "slope over the shifted spoken interval after mapping curve entry to one and "
                "mean terminal retention to zero"
            ),
        }
        definitions[f"slope_residual_o{offset}"] = {
            "label": f"Unexpected slope +{offset}s",
            "family": "residual-slope",
            "channel": "normalized observed retention geometry",
            "unit": "OOF residual normalized retention per second",
            "offsetSeconds": offset,
            "definition": (
                "endpoint-normalized slope minus its grouped out-of-fold expectation from "
                "span timing, phrase duration, video duration, entry, terminal retention, "
                "and entry-minus-expected-entry"
            ),
        }
    return definitions


def long_quant_estimate(row: dict, name: str) -> float:
    metric = ((row.get("longQuantMetrics") or {}).get(name) or {}).get("est")
    try:
        return float(metric)
    except (TypeError, ValueError):
        return float("nan")


def source_diverse_extremes(axis: np.ndarray, groups: np.ndarray,
                            global_indices: np.ndarray, span_rows: list[dict],
                            target: np.ndarray, limit: int = 12) -> dict[str, list[dict]]:
    output = {}
    for name, order in (
        ("high", np.argsort(-axis, kind="stable")),
        ("low", np.argsort(axis, kind="stable")),
    ):
        seen = set()
        rows = []
        for local_index in order:
            if not np.isfinite(axis[local_index]):
                continue
            video_id = str(groups[local_index])
            if video_id in seen:
                continue
            seen.add(video_id)
            global_index = int(global_indices[local_index])
            span = span_rows[global_index]
            rows.append({
                "globalIndex": global_index,
                "videoId": video_id,
                "text": span["text"],
                "axis": float(axis[local_index]),
                "target": float(target[local_index]) if np.isfinite(target[local_index]) else None,
            })
            if len(rows) >= limit:
                break
        output[name] = rows
    return output


def build_global_inputs(corpus_rows: list[dict], hooks: list[dict], span_rows: list[dict],
                        timing_records: dict[str, dict]) -> dict:
    corpus_by_id = {str(row["id"]): row for row in corpus_rows}
    hook_count = len(hooks)
    timing_by_hook = []
    normalized_curves = []
    entries = np.full(hook_count, np.nan, float)
    terminals = np.full(hook_count, np.nan, float)
    amplitudes = np.full(hook_count, np.nan, float)
    durations = np.full(hook_count, np.nan, float)
    exact_hook_ids = []
    mismatched_hook_ids = []
    missing_word_hook_ids = []

    for hook_index, hook in enumerate(hooks):
        video_id = str(hook["videoId"])
        corpus = corpus_by_id[video_id]
        record = timing_records.get(video_id) or {}
        words = record.get("words") or []
        if words:
            timing = exact_token_timings(str(hook.get("text") or corpus.get("hookText") or ""), words)
        else:
            timing = {"status": "missing-words", "tokenStarts": [], "tokenEnds": []}
        timing_by_hook.append(timing)
        if timing["status"] == "exact":
            exact_hook_ids.append(video_id)
        elif timing["status"] == "missing-words":
            missing_word_hook_ids.append(video_id)
        else:
            mismatched_hook_ids.append(video_id)

        curve = corpus.get("curve") or []
        duration = float(corpus.get("duration_s") or 0)
        durations[hook_index] = duration if duration > 0 else np.nan
        normalized, meta = endpoint_normalize_curve(curve)
        normalized_curves.append(normalized)
        if meta.get("status") == "complete":
            entries[hook_index] = float(meta["entry"])
            terminals[hook_index] = float(meta["terminal"])
            amplitudes[hook_index] = float(meta["amplitude"])

    entry_diagnostic = entry_terminal_diagnostic(entries, terminals, durations)
    predicted_entries = np.asarray(entry_diagnostic["predictedEntryOOF"], float)
    span_count = len(span_rows)
    starts = np.full(span_count, np.nan, np.float32)
    ends = np.full(span_count, np.nan, np.float32)
    hook_indices = np.asarray([int(row["hookIndex"]) for row in span_rows], np.int16)
    for index, row in enumerate(span_rows):
        start, end = span_interval(
            timing_by_hook[int(row["hookIndex"])], int(row["start"]), int(row["end"])
        )
        starts[index] = start
        ends[index] = end

    raw_slopes = np.full((len(OFFSETS), span_count), np.nan, np.float32)
    normalized_slopes = np.full_like(raw_slopes, np.nan)
    for index, row in enumerate(span_rows):
        hook_index = int(row["hookIndex"])
        start = float(starts[index])
        end = float(ends[index])
        duration = float(durations[hook_index])
        if not np.isfinite(start + end + duration):
            continue
        curve = corpus_by_id[str(row["videoId"])].get("curve") or []
        normalized = normalized_curves[hook_index]
        for offset in OFFSETS:
            shifted_start = start + offset
            shifted_end = end + offset
            raw_slopes[offset, index] = retention_window_slope(
                curve, duration, shifted_start, shifted_end
            )
            if len(normalized):
                normalized_slopes[offset, index] = retention_window_slope(
                    normalized, duration, shifted_start, shifted_end
                )

    return {
        "corpusById": corpus_by_id,
        "timingByHook": timing_by_hook,
        "normalizedCurves": normalized_curves,
        "entries": entries,
        "terminals": terminals,
        "amplitudes": amplitudes,
        "durations": durations,
        "predictedEntries": predicted_entries,
        "entryDiagnostic": entry_diagnostic,
        "spanStarts": starts,
        "spanEnds": ends,
        "hookIndices": hook_indices,
        "rawSlopes": raw_slopes,
        "normalizedSlopes": normalized_slopes,
        "timingAudit": {
            "hooks": hook_count,
            "exactHooks": len(exact_hook_ids),
            "exactHookIds": exact_hook_ids,
            "textMismatchHooks": len(mismatched_hook_ids),
            "textMismatchHookIds": mismatched_hook_ids,
            "missingWordHooks": len(missing_word_hook_ids),
            "missingWordHookIds": missing_word_hook_ids,
            "spansWithExactPositiveDuration": int(np.isfinite(starts + ends).sum()),
            "spanInstances": span_count,
            "policy": "no approximate timestamp is used; mismatches and zero-duration punctuation spans are missing",
        },
    }


def performance_targets(selected: np.ndarray, global_inputs: dict) -> dict[str, np.ndarray]:
    rows = [global_inputs["corpusById"][str(video_id)] for video_id in selected]
    views = np.asarray([float(row.get("views") or np.nan) for row in rows], float)
    return {
        "views_raw": views,
        "views_log": np.log10(np.maximum(1, views)),
        "realistic_views": np.asarray(
            [long_quant_estimate(row, "realviews") for row in rows], float
        ),
        "outlier": np.asarray(
            [long_quant_estimate(row, "scaled_views") for row in rows], float
        ),
        "class_10m": (views >= 10_000_000).astype(float),
        "swipe_ratio": np.asarray(
            [float(row.get("keep_rate") or np.nan) for row in rows], float
        ),
        "retention_5s": np.asarray([
            retention_at(row.get("curve") or [], float(row.get("duration_s") or 0), 5)
            for row in rows
        ], float),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--clusters", default="0,1,2,3")
    parser.add_argument("--targets", default="")
    parser.add_argument("--dimensions", default=",".join(map(str, DEFAULT_DIMENSIONS)))
    parser.add_argument("--alphas", default=",".join(map(str, DEFAULT_ALPHAS)))
    parser.add_argument("--null-repeats", type=int, default=1024)
    parser.add_argument("--timing-workers", type=int, default=16)
    parser.add_argument("--output-name", default="cluster-outcomes")
    args = parser.parse_args()

    started = time.time()
    clusters = parse_numbers(args.clusters, int)
    dimensions = parse_numbers(args.dimensions, int)
    alphas = parse_numbers(args.alphas, float)
    requested_targets = set(parse_numbers(args.targets, str)) if args.targets else None
    definitions = target_definitions()
    target_names = [name for name in definitions if not requested_targets or name in requested_targets]
    if not target_names:
        raise ValueError("no requested target names matched the declared target registry")

    atlas = read_json(CACHE / "all-span-atlas.json")
    manifest = read_json(CACHE / "all-span-manifest.json")
    corpus = read_json(CACHE / "corpus.json")
    manual_projection = read_json(CACHE / "manual-projection.json")
    map_row = next((row for row in atlas["maps"] if row["id"] == MAP_ID), None)
    if not map_row:
        raise RuntimeError(f"frozen map {MAP_ID} is missing")
    labels = np.asarray(map_row["labels"], np.int16)
    span_rows = manifest["rows"]
    hooks = manifest["hooks"]
    if len(labels) != len(span_rows):
        raise RuntimeError("frozen labels and all-span rows do not align")
    if manual_projection.get("mapId") != MAP_ID:
        raise RuntimeError("saved embedding does not point to the frozen outcome-axis map")

    timing_records = load_timing_records(hooks, args.timing_workers)
    global_inputs = build_global_inputs(corpus["rows"], hooks, span_rows, timing_records)
    hook_indices = global_inputs["hookIndices"]
    video_ids = np.asarray([str(row["videoId"]) for row in span_rows])
    raw_store = np.load(VECTOR_DIR / "raw.npy", mmap_mode="r")
    full_vectors = row_unit(np.asarray(
        np.load(VECTOR_DIR / "full.npy", mmap_mode="r"), np.float32
    ))
    context_dimensions = min(16, len(full_vectors) - 1)
    hook_context = PCA(
        n_components=context_dimensions, svd_solver="randomized", random_state=AXIS_SEED
    ).fit_transform(full_vectors).astype(np.float32)
    hook_means = np.zeros((len(hooks), raw_store.shape[1]), np.float32)
    for hook_index in range(len(hooks)):
        positions = np.flatnonzero(hook_indices == hook_index)
        hook_means[hook_index] = row_unit(
            np.asarray(raw_store[positions], np.float32)
        ).mean(axis=0)

    detail_root = CACHE / f"{args.output_name}-details"
    detail_root.mkdir(parents=True, exist_ok=True)
    remote = None if args.no_upload else R2Store()
    completed_targets = 0
    total_targets = len(clusters) * len(target_names)
    last_remote_progress = 0.0

    def progress(stage: str, cluster: int | None = None, target: str | None = None) -> None:
        nonlocal last_remote_progress
        now = time.time()
        value = {
            "version": 4,
            "status": "running",
            "stage": stage,
            "clusterOutcomeGroupsComplete": completed_targets,
            "clusterOutcomeGroupsTotal": total_targets,
            "experimentsComplete": completed_targets * len(dimensions) * len(alphas) * 2,
            "activeCluster": cluster,
            "activeTarget": target,
            "updatedAt": int(now * 1000),
        }
        atomic_json(CACHE / "progress.json", value)
        if remote and (now - last_remote_progress >= 8 or completed_targets == total_targets):
            remote.put_json(f"{R2_PREFIX}/progress.json", value)
            last_remote_progress = now

    all_experiments = []
    selected_rows = []
    cluster_summaries = []
    detail_paths = []

    for cluster in clusters:
        progress("preparing frozen cluster representations", cluster)
        global_indices = np.flatnonzero(labels == cluster)
        cluster_groups = video_ids[global_indices]
        cluster_hook_indices = hook_indices[global_indices]
        split_rows = grouped_splits(cluster_groups, folds=5)
        if not split_rows:
            raise RuntimeError(f"cluster {cluster} has fewer than two source videos")

        hook_lengths = np.asarray([
            int(hooks[int(index)]["tokenCount"]) for index in cluster_hook_indices
        ], float)
        span_start_tokens = np.asarray([span_rows[index]["start"] for index in global_indices], float)
        span_end_tokens = np.asarray([span_rows[index]["end"] for index in global_indices], float)
        token_counts = span_end_tokens - span_start_tokens
        span_start_seconds = global_inputs["spanStarts"][global_indices].astype(float)
        span_end_seconds = global_inputs["spanEnds"][global_indices].astype(float)
        phrase_seconds = span_end_seconds - span_start_seconds
        video_durations = global_inputs["durations"][cluster_hook_indices]
        entries = global_inputs["entries"][cluster_hook_indices]
        terminals = global_inputs["terminals"][cluster_hook_indices]
        amplitudes = global_inputs["amplitudes"][cluster_hook_indices]
        predicted_entries = global_inputs["predictedEntries"][cluster_hook_indices]
        surface = np.column_stack([
            token_counts,
            span_start_tokens / np.maximum(hook_lengths, 1),
            span_end_tokens / np.maximum(hook_lengths, 1),
            (span_start_tokens + span_end_tokens) / (2 * np.maximum(hook_lengths, 1)),
        ]).astype(np.float32)
        timing = np.column_stack([
            span_start_seconds,
            span_end_seconds,
            phrase_seconds,
            span_start_seconds / video_durations,
            span_end_seconds / video_durations,
            video_durations,
        ]).astype(np.float32)
        endpoints = np.column_stack([
            entries, terminals, amplitudes, predicted_entries,
            entries - predicted_entries,
        ]).astype(np.float32)
        context = hook_context[cluster_hook_indices]
        confound_sets = {
            "performance": np.column_stack([surface, timing, context]).astype(np.float32),
            "slope": np.column_stack([surface, timing, endpoints, context]).astype(np.float32),
        }

        raw_features = row_unit(np.asarray(raw_store[global_indices], np.float32))
        prepared = {
            "raw": prepare_representation_folds(
                raw_features, cluster_groups, confound_sets, split_rows,
                max_dimensions=max(dimensions),
            )
        }
        full_scores = {
            "raw": prepare_full_scores(
                raw_features, cluster_groups, confound_sets,
                max_dimensions=max(dimensions),
            )
        }
        residual_features = row_unit(
            raw_features - hook_means[cluster_hook_indices]
        )
        del raw_features
        prepared["raw-hook-residual"] = prepare_representation_folds(
            residual_features, cluster_groups, confound_sets, split_rows,
            max_dimensions=max(dimensions),
        )
        full_scores["raw-hook-residual"] = prepare_full_scores(
            residual_features, cluster_groups, confound_sets,
            max_dimensions=max(dimensions),
        )
        del residual_features

        cluster_targets = performance_targets(cluster_groups, global_inputs)
        baseline_audits = {}
        slope_baseline = np.column_stack([
            surface, timing, endpoints,
        ]).astype(np.float32)
        for offset in OFFSETS:
            raw_slope = global_inputs["rawSlopes"][offset, global_indices].astype(float)
            normalized_slope = global_inputs["normalizedSlopes"][offset, global_indices].astype(float)
            _, residual_slope, audit = grouped_baseline_residual(
                slope_baseline, normalized_slope, cluster_groups,
                folds=5, per_group=32,
                seed=AXIS_SEED + cluster * 101 + offset,
            )
            cluster_targets[f"slope_raw_o{offset}"] = raw_slope
            cluster_targets[f"slope_normalized_o{offset}"] = normalized_slope
            cluster_targets[f"slope_residual_o{offset}"] = residual_slope
            baseline_audits[str(offset)] = audit

        cluster_target_rows = []
        for target_name in target_names:
            completed_label = f"cluster {cluster} · {definitions[target_name]['label']}"
            progress(f"fitting {completed_label}", cluster, target_name)
            meta = definitions[target_name]
            target = np.asarray(cluster_targets[target_name], float)
            confound_name = "performance" if meta["family"] == "performance" else "slope"
            target_folds, target_oof = prepare_target_folds(
                target, cluster_groups, confound_sets[confound_name], split_rows,
                per_group=32,
                seed=AXIS_SEED + cluster * 101,
            )
            experiments, selected = search_target_axes(
                prepared, target, target_folds, target_oof, cluster_groups,
                confound_name, dimensions, alphas, target_name, cluster,
                null_repeats=args.null_repeats,
            )
            for row in experiments:
                row.update({
                    "targetLabel": meta["label"],
                    "targetFamily": meta["family"],
                    "targetChannel": meta["channel"],
                    "targetDefinition": meta["definition"],
                    "targetUnit": meta["unit"],
                    "offsetSeconds": meta.get("offsetSeconds"),
                    "outcomesUsed": True,
                    "frozenMapId": MAP_ID,
                    "frozenLabelsChanged": False,
                })
            selected_experiment = selected["experiment"]
            selected_rows.append(selected_experiment)
            all_experiments.extend(experiments)

            representation = selected_experiment["representation"]
            score_matrix = full_scores[representation][confound_name]
            axis_map = fit_full_target_map(
                score_matrix, target, cluster_groups, confound_sets[confound_name],
                selected_experiment["pcaDimensions"], selected_experiment["ridgeAlpha"],
                seed=AXIS_SEED + cluster * 101,
            )
            validation_local = balanced_group_positions(
                cluster_groups, per_group=4,
                seed=AXIS_SEED + cluster * 101 + int(meta.get("offsetSeconds") or 0),
            )
            detail = {
                "version": 1,
                "status": "complete",
                "mapId": MAP_ID,
                "cluster": cluster,
                "target": target_name,
                "targetMeta": meta,
                "selectedExperiment": dict(selected_experiment),
                "pointIndexSource": "manual-projection.frozenPointIndex",
                "points": {
                    "globalIndices": global_indices.astype(int).tolist(),
                    "x": np.round(axis_map["x"], 5).tolist(),
                    "y": np.round(axis_map["y"], 5).tolist(),
                    "target": np.round(target, 6).tolist(),
                    "targetResidual": np.round(axis_map["observedResidual"], 6).tolist(),
                    "spanStartSeconds": np.round(span_start_seconds, 4).tolist(),
                    "spanEndSeconds": np.round(span_end_seconds, 4).tolist(),
                },
                "validation": {
                    "policy": "five-fold source-video holdout; four fixed audit rows per source video",
                    "globalIndices": global_indices[validation_local].astype(int).tolist(),
                    "sourceVideoIds": cluster_groups[validation_local].tolist(),
                    "predictedOOF": np.round(
                        selected["predictionOOF"][validation_local], 6
                    ).tolist(),
                    "observedResidualOOF": np.round(
                        selected["observedResidualOOF"][validation_local], 6
                    ).tolist(),
                },
                "extremes": source_diverse_extremes(
                    axis_map["x"], cluster_groups, global_indices, span_rows, target
                ),
                "normalizationAudit": (
                    baseline_audits.get(str(meta.get("offsetSeconds")))
                    if meta["family"] in {"normalized-slope", "residual-slope", "raw-slope"}
                    else None
                ),
                "timingPolicy": {
                    "interval": "exact first-token start through exact last-token end",
                    "offset": meta.get("offsetSeconds"),
                    "mismatches": "excluded, never approximated",
                },
            }
            detail_path = detail_root / str(cluster) / f"{target_name}.json.gz"
            atomic_json_gz(detail_path, detail)
            detail_paths.append((detail_path, cluster, target_name, selected_experiment["id"]))
            selected_experiment["detailPath"] = (
                f"/api/longquant/promise-lab/cluster-outcome/{cluster}/{target_name}"
            )
            cluster_target_rows.append(selected_experiment)
            completed_targets += 1
            progress(f"completed {completed_label}", cluster, target_name)
            print(
                f"{completed_targets}/{total_targets} {completed_label}: "
                f"rho={selected_experiment['heldoutSpearman']:.4f} "
                f"p={selected_experiment['searchWideP']:.4g}",
                flush=True,
            )

        cluster_summaries.append({
            "label": cluster,
            "spanInstances": int(len(global_indices)),
            "sourceVideos": len(set(cluster_groups)),
            "targetCount": len(cluster_target_rows),
            "targets": cluster_target_rows,
            "slopeBaselineAudits": baseline_audits,
        })

    apply_family_fdr(selected_rows)
    selected_by_id = {row["id"]: row for row in selected_rows}
    for detail_path, cluster, target_name, experiment_id in detail_paths:
        with gzip.open(detail_path, "rt", encoding="utf-8") as handle:
            detail = json.load(handle)
        detail["selectedExperiment"] = selected_by_id[experiment_id]
        atomic_json_gz(detail_path, detail)
        if remote:
            remote.put_json(
                f"{R2_PREFIX}/cluster-outcomes/{cluster}/{target_name}.json.gz",
                detail,
                gzip_payload=True,
            )

    registry_raw = "\n".join(
        json.dumps(json_ready(row), separators=(",", ":"), allow_nan=False)
        for row in all_experiments
    ).encode("utf-8")
    registry_path = CACHE / f"{args.output_name}-experiments.jsonl.gz"
    registry_path.write_bytes(gzip.compress(registry_raw, compresslevel=6))
    selected_ranked = sorted(
        selected_rows,
        key=lambda row: (
            row.get("status") == "validated",
            float(row.get("heldoutSpearman") or 0),
        ),
        reverse=True,
    )
    summary = {
        "version": 1,
        "status": "complete",
        "stage": "frozen-cluster outcome and exact retention-slope axes",
        "mapId": MAP_ID,
        "savedEmbeddingName": manual_projection.get("savedName"),
        "clusters": cluster_summaries,
        "clusterCount": len(clusters),
        "targetDefinitions": definitions,
        "targetNames": target_names,
        "targetFamiliesPerCluster": len(target_names),
        "experimentCount": len(all_experiments),
        "selectedFamilyCount": len(selected_rows),
        "validatedFamilyCount": sum(row.get("status") == "validated" for row in selected_rows),
        "topIndicators": selected_ranked[:20],
        "timingAudit": global_inputs["timingAudit"],
        "normalization": {
            "endpointFormula": "(retention - mean last 5 percent) / (entry - mean last 5 percent)",
            "terminalWindow": "last 5 percent of curve points, minimum three",
            "minimumAmplitude": 0.02,
            "entryTerminalDiagnostic": global_inputs["entryDiagnostic"],
            "offsetsSeconds": OFFSETS,
            "humanProcessingLagPolicy": "0 second aligned control plus forward offsets 1 through 5 seconds",
        },
        "validation": {
            "folds": 5,
            "groupedBy": "source video",
            "equalSourceWeighting": "32 deterministic span observations per source video",
            "representations": ["raw", "raw-hook-residual"],
            "pcaDimensions": dimensions,
            "ridgeAlphas": alphas,
            "searchWideNull": (
                f"{args.null_repeats} source-video sign flips; maximum across representation, "
                "PCA dimensions, and ridge alpha"
            ),
            "familyFdr": "Benjamini-Hochberg across every selected cluster-target family",
            "labelsChanged": False,
            "newClusteringFit": False,
        },
        "builtAt": int(time.time() * 1000),
        "elapsedSeconds": time.time() - started,
    }
    summary_path = CACHE / f"{args.output_name}.json"
    atomic_json(summary_path, summary)
    if remote:
        remote.put_json(f"{R2_PREFIX}/cluster-outcomes.json.gz", summary, gzip_payload=True)
        remote.put_bytes(
            f"{R2_PREFIX}/cluster-outcome-experiments.jsonl.gz",
            registry_path.read_bytes(),
            "application/x-ndjson",
            "gzip",
        )
        remote.put_json(f"{R2_PREFIX}/progress.json", {
            "version": 4,
            "status": "complete",
            "stage": "four frozen clusters quantified against outcomes and exact phrase slopes",
            "clusterOutcomeGroupsComplete": total_targets,
            "clusterOutcomeGroupsTotal": total_targets,
            "experimentsComplete": len(all_experiments),
            "updatedAt": int(time.time() * 1000),
        })
    else:
        atomic_json(CACHE / "progress.json", {
            "version": 4,
            "status": "complete",
            "stage": "four frozen clusters quantified against outcomes and exact phrase slopes",
            "clusterOutcomeGroupsComplete": total_targets,
            "clusterOutcomeGroupsTotal": total_targets,
            "experimentsComplete": len(all_experiments),
            "updatedAt": int(time.time() * 1000),
        })
    print(json.dumps({
        "status": summary["status"],
        "mapId": summary["mapId"],
        "clusters": summary["clusterCount"],
        "targetFamilies": summary["selectedFamilyCount"],
        "experiments": summary["experimentCount"],
        "validated": summary["validatedFamilyCount"],
        "timingAudit": summary["timingAudit"],
        "topIndicators": [
            {key: row.get(key) for key in (
                "cluster", "target", "heldoutSpearman", "searchWideP", "searchWideQ", "status"
            )}
            for row in summary["topIndicators"][:8]
        ],
        "elapsedSeconds": summary["elapsedSeconds"],
        "output": str(summary_path),
    }, indent=2))


if __name__ == "__main__":
    main()
