#!/usr/bin/env python3
"""Select, fit, and publish the forward retention-response metric contract."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from axes import finite_correlation, spearman
from cluster_outcomes import (
    entry_terminal_diagnostic,
    exact_token_timings,
    retention_window_slope,
    span_interval,
)
from deconfounding import (
    build_deconfounding_audit,
    natural_baseline_features,
    retention_curve_families,
)
from embedding_store import R2_PREFIX, EmbeddingStore, R2Store, json_ready
from forward_response import (
    FIXED_BASELINE_ALPHA,
    FIXED_DIMENSIONS,
    FIXED_SEMANTIC_ALPHA,
    MIN_CATEGORY_SOURCES,
    ResponseCandidate,
    category_balanced_source_inference,
    category_balanced_spearman,
    candidate_intervals,
    combined_component_features,
    crossfit_axis,
    crossfit_category_axis,
    fit_full_axis,
    fit_full_category_axes,
    interaction_features,
    nested_select_candidate,
    response_candidates,
    row_unit,
    source_signflip,
)
from hook_quality import retention_inputs
from hook_score_core import local_counterfactual_texts, percentile
from run_cluster_outcomes import load_timing_records
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
VECTOR_DIR = CACHE / "all-span-vectors"
OUTPUT_PATH = CACHE / "forward-response.json"
MODEL_PATH = CACHE / "forward-response-model.json"
HOOK_QUALITY_PATH = CACHE / "hook-quality.json"
HOOK_MODEL_PATH = CACHE / "hook-quality-model.json"
METHOD_VERSION = "variable-component-forward-response-v5"


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


def axis_payload(model: dict) -> dict:
    return {
        "direction": np.round(model["direction"], 8).astype(float).tolist(),
        "trainingProjectionSorted": np.asarray(
            model["trainingProjectionSorted"], float
        ).tolist(),
        "fitSpearman": float(model["fitSpearman"]),
        "naturalModel": model["naturalModel"],
    }


def component_vector_rows(partitions: list[dict]) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    hook_index = np.asarray(np.load(VECTOR_DIR / "hook-index.npy", mmap_mode="r"), int)
    span_start = np.asarray(np.load(VECTOR_DIR / "span-start.npy", mmap_mode="r"), int)
    span_end = np.asarray(np.load(VECTOR_DIR / "span-end.npy", mmap_mode="r"), int)
    lookup = {
        (int(hook), int(start), int(end)): index
        for index, (hook, start, end) in enumerate(zip(hook_index, span_start, span_end))
    }
    raw_store = np.load(VECTOR_DIR / "raw.npy", mmap_mode="r")
    influence_store = np.load(VECTOR_DIR / "influence.npy", mmap_mode="r")
    raw = []
    influence = []
    rows = []
    for source_index, partition in enumerate(partitions):
        for component, chunk in enumerate(partition["chunks"]):
            key = (source_index, int(chunk["start"]), int(chunk["end"]))
            if key not in lookup:
                raise RuntimeError(f"canonical component is missing from all-span store: {key}")
            vector_index = lookup[key]
            raw.append(np.asarray(raw_store[vector_index], np.float32))
            influence.append(np.asarray(influence_store[vector_index], np.float32))
            rows.append({
                "sourceIndex": source_index,
                "videoId": str(partition["videoId"]),
                "component": component,
                "category": int(chunk["category"]),
                "startToken": int(chunk["start"]),
                "endToken": int(chunk["end"]),
                "text": str(chunk["text"]),
            })
    return row_unit(np.asarray(raw)), row_unit(np.asarray(influence)), rows


def timing_rows(hooks: list[dict], partitions: list[dict], workers: int) -> tuple[dict, dict]:
    records = load_timing_records(hooks, workers)
    hook_by_id = {str(row["videoId"]): row for row in hooks}
    starts = []
    ends = []
    status_counts = {}
    exact_sources = set()
    for partition in partitions:
        video_id = str(partition["videoId"])
        record = records.get(video_id) or {}
        timing = exact_token_timings(
            str(hook_by_id[video_id]["text"]), record.get("words") or [],
        ) if record.get("words") else {"status": "missing-words"}
        status = str(timing.get("status"))
        status_counts[status] = status_counts.get(status, 0) + 1
        if status == "exact":
            exact_sources.add(video_id)
        for chunk in partition["chunks"]:
            start, end = span_interval(timing, int(chunk["start"]), int(chunk["end"]))
            starts.append(start)
            ends.append(end)
    return {
        "starts": np.asarray(starts, np.float32),
        "ends": np.asarray(ends, np.float32),
    }, {
        "sources": len(partitions),
        "exactSources": len(exact_sources),
        "statusCounts": status_counts,
        "componentsWithExactPositiveDuration": int(
            np.isfinite(np.asarray(starts) + np.asarray(ends)).sum()
        ),
    }


def measurements(candidate: ResponseCandidate, normalized_curves: list[np.ndarray],
                 raw_curves: list[np.ndarray], durations: np.ndarray,
                 starts: np.ndarray, ends: np.ndarray,
                 source_indices: np.ndarray, entries: np.ndarray,
                 terminals: np.ndarray, amplitudes: np.ndarray,
                 baseline_mode: str = "past_trajectory") -> dict:
    left, right = candidate_intervals(starts, ends, candidate)
    target = np.full(len(starts), np.nan, np.float32)
    raw = np.full(len(starts), np.nan, np.float32)
    for index, source_index in enumerate(source_indices):
        if not np.isfinite(left[index] + right[index]):
            continue
        target[index] = retention_window_slope(
            normalized_curves[source_index], durations[source_index],
            float(left[index]), float(right[index]),
        )
        raw[index] = retention_window_slope(
            raw_curves[source_index], durations[source_index],
            float(left[index]), float(right[index]),
        )
    natural = natural_baseline_features(
        baseline_mode, normalized_curves, source_indices, left, right,
        durations, entries, terminals, amplitudes,
        history_starts=starts,
    )
    return {
        "target": target,
        "raw": raw,
        "natural": natural,
        "left": left.astype(np.float32),
        "right": right.astype(np.float32),
        "measured": int(np.isfinite(target).sum()),
    }


def candidate_payload(candidate: ResponseCandidate, result: dict,
                      measured: int, kind: str) -> dict:
    return {
        "id": candidate.id,
        "label": candidate.label,
        "kind": kind,
        "anchor": candidate.anchor,
        "lagSeconds": candidate.lag,
        "windowSeconds": candidate.width,
        "definition": candidate.definition,
        "measuredComponents": measured,
        "heldoutCategoryBalancedSpearman": result["heldoutSpearman"],
        "heldoutSpearmanByCategory": result["heldoutSpearmanByCategory"],
    }


def chronological_component_splits(corpus: list[dict], groups: np.ndarray,
                                   blocks: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    """Expand from older source videos into untouched newer source videos."""
    source_dates = {
        str(row["id"]): str(row.get("published") or "") for row in corpus
    }
    ordered_sources = np.asarray(sorted(
        source_dates, key=lambda source: (source_dates[source], source),
    ))
    chunks = [np.asarray(chunk).astype(str) for chunk in np.array_split(
        ordered_sources, blocks,
    ) if len(chunk)]
    output = []
    for index in range(1, len(chunks)):
        train_sources = set(np.concatenate(chunks[:index]).tolist())
        test_sources = set(chunks[index].tolist())
        train = np.flatnonzero(np.isin(groups, list(train_sources)))
        test = np.flatnonzero(np.isin(groups, list(test_sources)))
        output.append((train, test))
    return output


def lag_bootstrap(results: dict[str, dict], candidates: list[ResponseCandidate],
                  groups: np.ndarray, categories: np.ndarray,
                  repeats: int = 2048, seed: int = 20260717) -> dict:
    unique = np.asarray(sorted(set(groups)))
    group_rows = {group: np.flatnonzero(groups == group) for group in unique}
    by_id = {row.id: row for row in candidates}
    counts = {row.id: 0 for row in candidates}
    lags = np.empty(repeats, np.float32)
    rng = np.random.default_rng(seed)
    for repeat in range(repeats):
        sample = rng.choice(unique, size=len(unique), replace=True)
        positions = np.concatenate([group_rows[group] for group in sample])
        bootstrap_groups = np.concatenate([
            np.repeat(f"{draw}:{group}", len(group_rows[group]))
            for draw, group in enumerate(sample)
        ])
        scored = []
        for candidate in candidates:
            result = results[candidate.id]
            value, _ = category_balanced_spearman(
                np.asarray(result["prediction"])[positions],
                np.asarray(result["targetResidual"])[positions],
                categories[positions],
                bootstrap_groups,
                minimum_sources=MIN_CATEGORY_SOURCES,
                required_categories=tuple(sorted(set(categories))),
            )
            scored.append((float(value), candidate.id))
        scored.sort(key=lambda row: (-np.nan_to_num(row[0], nan=-1.0), row[1]))
        winner = scored[0][1]
        counts[winner] += 1
        lags[repeat] = by_id[winner].lag
    return {
        "repeats": repeats,
        "selectionCounts": {key: value for key, value in counts.items() if value},
        "medianLagSeconds": float(np.median(lags)),
        "p10LagSeconds": float(np.quantile(lags, .1)),
        "p90LagSeconds": float(np.quantile(lags, .9)),
        "selectedLagFraction": float(np.mean(lags == by_id[max(counts, key=counts.get)].lag)),
        "policy": "source-video bootstrap over frozen source-held-out predictions",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--timing-workers", type=int, default=16)
    parser.add_argument("--inference-repeats", type=int, default=4096)
    args = parser.parse_args()
    started = time.time()

    corpus = read_json(CACHE / "corpus.json")["rows"]
    manifest = read_json(CACHE / "all-span-manifest.json")
    partitions_payload = read_json(CACHE / "canonical-partitions.json")
    partitions = partitions_payload["rows"]
    if [str(row["id"]) for row in corpus] != [str(row["videoId"]) for row in partitions]:
        raise RuntimeError("canonical partitions do not match the Promise Lab corpus")

    raw_components, influence_components, component_rows = component_vector_rows(partitions)
    features = combined_component_features(raw_components, influence_components)
    timing, timing_audit = timing_rows(
        manifest["hooks"], partitions, args.timing_workers,
    )
    starts = timing["starts"]
    ends = timing["ends"]
    source_indices = np.asarray([row["sourceIndex"] for row in component_rows], int)
    groups = np.asarray([row["videoId"] for row in component_rows]).astype(str)
    categories = np.asarray([row["category"] for row in component_rows], int)
    hook_starts = np.full(len(corpus), np.nan, np.float32)
    hook_ends = np.full(len(corpus), np.nan, np.float32)
    for source_index in range(len(corpus)):
        selected = source_indices == source_index
        valid_starts = starts[selected][np.isfinite(starts[selected])]
        valid_ends = ends[selected][np.isfinite(ends[selected])]
        if len(valid_starts) and len(valid_ends):
            hook_starts[source_index] = valid_starts.min()
            hook_ends[source_index] = valid_ends.max()

    token_counts = np.asarray([int(row["tokenCount"]) for row in manifest["hooks"]], int)
    curve_inputs = retention_inputs(corpus, token_counts)
    raw_curves = [np.asarray(row.get("curve") or [], float) for row in corpus]
    durations = np.asarray([float(row.get("duration_s") or np.nan) for row in corpus], float)
    entries = np.asarray([float(row.get("entry", np.nan)) for row in curve_inputs["curveMeta"]], float)
    terminals = np.asarray([float(row.get("terminal", np.nan)) for row in curve_inputs["curveMeta"]], float)
    amplitudes = np.asarray([float(row.get("amplitude", np.nan)) for row in curve_inputs["curveMeta"]], float)
    entry_diagnostic = entry_terminal_diagnostic(entries, terminals, durations)
    curve_families = retention_curve_families(raw_curves, terminals)
    normalized_curves = curve_families["entry_indexed"]

    forward_candidates = [row for row in response_candidates() if row.anchor == "phrase"]
    forward_measurements = {
        row.id: measurements(
            row, normalized_curves, raw_curves, durations, starts, ends,
            source_indices, entries, terminals, amplitudes,
        ) for row in forward_candidates
    }
    targets = {key: value["target"] for key, value in forward_measurements.items()}
    naturals = {key: value["natural"] for key, value in forward_measurements.items()}
    selection = nested_select_candidate(
        features, targets, naturals, groups, categories,
        shared_natural_baseline=True,
    )
    chronological_selection = nested_select_candidate(
        features, targets, naturals, groups, categories,
        outer_splits=chronological_component_splits(corpus, groups),
        validation_design="expanding-window past-to-future with train-only lag selection",
        seed=20260730,
        shared_natural_baseline=True,
    )
    candidate_by_id = {row.id: row for row in forward_candidates}
    exploratory_selected_id = selection["selectedCandidate"]
    if exploratory_selected_id is None:
        raise RuntimeError("no forward lag had enough independent-video support")

    forward_rows = []
    forward_results = {}
    for candidate in forward_candidates:
        result = crossfit_category_axis(
            features, targets[candidate.id], naturals[candidate.id], groups, categories,
            shared_natural_baseline=True,
        )
        forward_results[candidate.id] = result
        forward_rows.append(candidate_payload(
            candidate, result, forward_measurements[candidate.id]["measured"], "forward candidate",
        ))
    lag_uncertainty = lag_bootstrap(
        forward_results, forward_candidates, groups, categories,
    )

    exploratory_candidate = candidate_by_id[exploratory_selected_id]
    preliminary_deconfounding = build_deconfounding_audit(
        semantic_prediction=forward_results[exploratory_selected_id]["prediction"],
        raw_curves=raw_curves, durations=durations, starts=starts, ends=ends,
        source_indices=source_indices, groups=groups, categories=categories,
        entries=entries, terminals=terminals, amplitudes=amplitudes,
        selected_lag=exploratory_candidate.lag, hook_ends=hook_ends,
        repeats=min(args.inference_repeats, 2048),
    )
    zero_id = next(row.id for row in forward_candidates if row.lag == 0)
    selected_id = (
        exploratory_selected_id
        if preliminary_deconfounding["processingLagSupported"] else zero_id
    )
    selected_candidate = candidate_by_id[selected_id]
    selected_measurement = forward_measurements[selected_id]
    fixed = forward_results[selected_id]
    deconfounding_audit = (
        preliminary_deconfounding
        if selected_id == exploratory_selected_id else
        build_deconfounding_audit(
            semantic_prediction=fixed["prediction"],
            raw_curves=raw_curves, durations=durations, starts=starts, ends=ends,
            source_indices=source_indices, groups=groups, categories=categories,
            entries=entries, terminals=terminals, amplitudes=amplitudes,
            selected_lag=selected_candidate.lag, hook_ends=hook_ends,
            repeats=min(args.inference_repeats, 2048),
        )
    )
    exploratory_primary = preliminary_deconfounding["primarySpecification"]
    exploratory_reverse = next((
        row for row in preliminary_deconfounding["matchedForwardReverse"]
        if np.isclose(
            float(row["absoluteLagSeconds"]), float(exploratory_candidate.lag),
        )
    ), None)
    exploratory_consensus = next((
        row for row in preliminary_deconfounding["futureFreeConsensusByLag"]
        if np.isclose(float(row["lagSeconds"]), float(exploratory_candidate.lag))
    ), None)
    failed_gates = []
    if not (exploratory_primary.get("familyMaxNullP", 1) <= .05):
        failed_gates.append("family-wide max-null p did not pass 0.05")
    if not exploratory_consensus or exploratory_consensus.get("minimumRho") is None \
            or exploratory_consensus["minimumRho"] <= 0:
        failed_gates.append("not every future-free specification was positive")
    if exploratory_candidate.lag <= 0:
        failed_gates.append("the exploratory winner was not a positive delay")
    elif not exploratory_reverse or exploratory_reverse.get("differenceCiLow") is None \
            or exploratory_reverse["differenceCiLow"] <= 0 \
            or exploratory_reverse.get("oneSidedBootstrapP", 1) > .05:
        failed_gates.append("forward lag did not beat its matched reverse-time control")
    deconfounding_audit["exploratoryLagGate"] = {
        "candidate": exploratory_selected_id,
        "lagSeconds": float(exploratory_candidate.lag),
        "supported": bool(preliminary_deconfounding["processingLagSupported"]),
        "heldoutCategoryBalancedSpearman": exploratory_primary.get(
            "heldoutCategoryBalancedSpearman"
        ),
        "familyMaxNullP": exploratory_primary.get("familyMaxNullP"),
        "futureFreeConsensus": exploratory_consensus,
        "matchedForwardReverse": exploratory_reverse,
        "failedGates": failed_gates,
        "decision": (
            "serve the exploratory lag"
            if preliminary_deconfounding["processingLagSupported"] else
            "reject the exploratory lag and serve the predeclared zero-delay fallback"
        ),
    }
    fixed_inference = category_balanced_source_inference(
        fixed["prediction"], fixed["targetResidual"], groups,
        categories,
        repeats=args.inference_repeats,
    )
    nested_inference = category_balanced_source_inference(
        selection["prediction"], selection["targetResidual"], groups,
        categories,
        repeats=args.inference_repeats, seed=20260713,
    )
    chronological_fixed = crossfit_category_axis(
        features, targets[selected_id], naturals[selected_id], groups, categories,
        outer_splits=chronological_component_splits(corpus, groups),
        validation_design="expanding-window past-to-future at the served lag",
        seed=20260801,
        shared_natural_baseline=True,
    )
    chronological_inference = category_balanced_source_inference(
        chronological_fixed["prediction"],
        chronological_fixed["targetResidual"], groups,
        categories,
        repeats=args.inference_repeats, seed=20260731,
    )

    control_candidates = [
        ResponseCandidate(
            f"phrase_control_m{str(abs(lag)).replace('.', 'p')}",
            f"reverse-time control {lag:g}s", "phrase", None, lag,
        ) for lag in np.arange(-3.0, -.4999, .5)
    ]
    control_rows = []
    control_max = 0.0
    for candidate in control_candidates:
        measured = measurements(
            candidate, normalized_curves, raw_curves, durations, starts, ends,
            source_indices, entries, terminals, amplitudes,
        )
        result = crossfit_category_axis(
            features, measured["target"], measured["natural"], groups, categories,
            shared_natural_baseline=True,
        )
        if np.isfinite(result["heldoutSpearman"]):
            control_max = max(control_max, abs(float(result["heldoutSpearman"])))
        control_rows.append(candidate_payload(
            candidate, result, measured["measured"], "reverse-time falsification control",
        ))

    endpoint_measurement = measurements(
        selected_candidate, curve_families["endpoint_affine"], raw_curves,
        durations, starts, ends, source_indices, entries, terminals, amplitudes,
        baseline_mode="endpoint_conditioned",
    )
    replay_measurement = measurements(
        selected_candidate, curve_families["terminal_replay"], raw_curves,
        durations, starts, ends, source_indices, entries, terminals, amplitudes,
        baseline_mode="endpoint_conditioned",
    )
    category_models = fit_full_category_axes(
        features, selected_measurement["target"], selected_measurement["natural"],
        categories, groups=groups, shared_natural_baseline=True,
    )
    component_axis = np.full(len(component_rows), np.nan, np.float32)
    component_map_y = np.full(len(component_rows), np.nan, np.float32)
    component_observed = np.full(len(component_rows), np.nan, np.float32)
    component_models = {}
    for category, fitted in category_models.items():
        row_indices = np.asarray(fitted["rowIndices"], int)
        component_axis[row_indices] = fitted["projection"][row_indices]
        direction = np.asarray(fitted["direction"], np.float32)
        category_features = features[row_indices]
        residual_geometry = category_features - (
            category_features @ direction
        )[:, None] * direction[None, :]
        background_reducer = PCA(n_components=1, svd_solver="full").fit(
            residual_geometry
        )
        background_direction = background_reducer.components_[0].astype(np.float32)
        background = residual_geometry @ background_direction
        pivot = int(np.argmax(np.abs(background)))
        if background[pivot] < 0:
            background = -background
            background_direction = -background_direction
        component_map_y[row_indices] = background.astype(np.float32)
        observed_positions = row_indices[np.asarray(fitted["observedPositions"], int)]
        component_observed[observed_positions] = fitted["observedResidual"]
        compact = axis_payload(fitted)
        compact["mapDirection"] = np.round(
            background_direction, 8
        ).astype(float).tolist()
        compact["validation"] = {
            "heldoutSpearman": fixed["heldoutSpearmanByCategory"].get(category),
            "foldDirectionStability": fixed["foldDirectionStability"].get(category),
            "rows": int(len(row_indices)),
        }
        component_models[category] = compact

    component_calibration = {
        category: np.asarray(model["trainingProjectionSorted"], float)
        for category, model in component_models.items()
    }
    for index, row in enumerate(component_rows):
        category = str(row["category"])
        row.update({
            "spokenStartSeconds": float(starts[index]) if np.isfinite(starts[index]) else None,
            "spokenEndSeconds": float(ends[index]) if np.isfinite(ends[index]) else None,
            "responseWindowStartSeconds": (
                float(selected_measurement["left"][index])
                if np.isfinite(selected_measurement["left"][index]) else None
            ),
            "responseWindowEndSeconds": (
                float(selected_measurement["right"][index])
                if np.isfinite(selected_measurement["right"][index]) else None
            ),
            "rawObservedSlope": (
                float(selected_measurement["raw"][index])
                if np.isfinite(selected_measurement["raw"][index]) else None
            ),
            "entryIndexedObservedSlope": (
                float(selected_measurement["target"][index])
                if np.isfinite(selected_measurement["target"][index]) else None
            ),
            "terminalConditionedReplayObservedSlope": (
                float(replay_measurement["target"][index])
                if np.isfinite(replay_measurement["target"][index]) else None
            ),
            "endpointAffineObservedSlope": (
                float(endpoint_measurement["target"][index])
                if np.isfinite(endpoint_measurement["target"][index]) else None
            ),
            "naturalExpectedSlopeOOF": (
                float(fixed["naturalBaselinePrediction"][index])
                if np.isfinite(fixed["naturalBaselinePrediction"][index]) else None
            ),
            "entryIndexedResidualSlope": (
                float(fixed["targetResidual"][index])
                if np.isfinite(fixed["targetResidual"][index]) else None
            ),
            "unexpectedObservedSlope": (
                float(component_observed[index]) if np.isfinite(component_observed[index]) else None
            ),
            "predictedUnexpectedSlopeOOF": (
                float(fixed["prediction"][index]) if np.isfinite(fixed["prediction"][index]) else None
            ),
            "axisCoordinate": float(component_axis[index]),
            "axisPercentile": percentile(component_calibration[category], component_axis[index]),
            "mapY": float(component_map_y[index]),
            "fold": int(fixed["foldIndex"][index]),
        })

    composite_oof_prediction = np.full(len(corpus), np.nan, np.float32)
    composite_oof_observed = np.full(len(corpus), np.nan, np.float32)
    composite_axis_coordinate = np.full(len(corpus), np.nan, np.float32)
    for source_index in range(len(corpus)):
        selected = source_indices == source_index
        predicted = np.asarray(fixed["prediction"])[selected]
        observed = np.asarray(fixed["targetResidual"])[selected]
        axis_percentiles = np.asarray([
            float(component_rows[index]["axisPercentile"])
            for index in np.flatnonzero(selected)
        ], float)
        if np.isfinite(predicted).all():
            composite_oof_prediction[source_index] = float(np.mean(predicted))
        if np.isfinite(observed).all():
            composite_oof_observed[source_index] = float(np.mean(observed))
        if np.isfinite(axis_percentiles).all():
            composite_axis_coordinate[source_index] = float(np.mean(axis_percentiles))
    composite_validation = {
        "heldoutSpearman": float(spearman(
            composite_oof_prediction, composite_oof_observed
        )),
        "heldoutPearson": float(finite_correlation(
            composite_oof_prediction, composite_oof_observed
        )),
    }
    composite_inference = source_signflip(
        composite_oof_prediction, composite_oof_observed,
        np.asarray([str(row["id"]) for row in corpus]),
        repeats=args.inference_repeats, seed=20260716,
    )
    composite_validation["sourceInference"] = composite_inference
    composite_training_sorted = np.sort(
        composite_axis_coordinate[np.isfinite(composite_axis_coordinate)]
    )

    hook_measurement = measurements(
        selected_candidate, normalized_curves, raw_curves, durations,
        hook_starts, hook_ends, np.arange(len(corpus)), entries, terminals,
        amplitudes,
    )
    hook_features = row_unit(np.asarray(
        np.load(VECTOR_DIR / "full.npy", mmap_mode="r"), np.float32,
    ))
    hook_groups = np.asarray([str(row["id"]) for row in corpus])
    hook_validation = crossfit_axis(
        hook_features, hook_measurement["target"], hook_measurement["natural"], hook_groups,
    )
    hook_inference = source_signflip(
        hook_validation["prediction"], hook_validation["targetResidual"], hook_groups,
        repeats=args.inference_repeats, seed=20260714,
    )
    hook_fitted = fit_full_axis(
        hook_features, hook_measurement["target"], hook_measurement["natural"],
    )
    hook_rows = []
    for index, corpus_row in enumerate(corpus):
        hook_rows.append({
            "sourceIndex": index,
            "videoId": str(corpus_row["id"]),
            "title": str(corpus_row.get("title") or ""),
            "text": str(corpus_row.get("hookText") or ""),
            "spokenStartSeconds": float(hook_starts[index]) if np.isfinite(hook_starts[index]) else None,
            "spokenEndSeconds": float(hook_ends[index]) if np.isfinite(hook_ends[index]) else None,
            "rawObservedSlope": (
                float(hook_measurement["raw"][index])
                if np.isfinite(hook_measurement["raw"][index]) else None
            ),
            "entryIndexedObservedSlope": (
                float(hook_measurement["target"][index])
                if np.isfinite(hook_measurement["target"][index]) else None
            ),
            "unexpectedObservedSlope": (
                float(composite_oof_observed[index])
                if np.isfinite(composite_oof_observed[index]) else None
            ),
            "predictedUnexpectedSlopeOOF": (
                float(composite_oof_prediction[index])
                if np.isfinite(composite_oof_prediction[index]) else None
            ),
            "axisCoordinate": float(composite_axis_coordinate[index]),
            "axisPercentile": percentile(
                composite_training_sorted, composite_axis_coordinate[index]
            ),
            "directFullEmbeddingFalsification": {
                "unexpectedObservedSlope": (
                    float(hook_validation["targetResidual"][index])
                    if np.isfinite(hook_validation["targetResidual"][index]) else None
                ),
                "predictedUnexpectedSlopeOOF": (
                    float(hook_validation["prediction"][index])
                    if np.isfinite(hook_validation["prediction"][index]) else None
                ),
                "axisCoordinate": float(hook_fitted["projection"][index]),
            },
        })

    text_by_source = {}
    required_counterfactuals = []
    for partition in partitions:
        owners = np.asarray([int(row["owner"]) for row in partition["tokens"]], int)
        count = int(partition["componentCount"])
        texts = local_counterfactual_texts(
            partition["text"], tokenize(partition["text"]), owners, count,
        )
        text_by_source[str(partition["videoId"])] = texts
        required_counterfactuals.extend(
            text for family in ("withoutOne", "withoutPair", "pairOnly")
            for text in texts[family].values() if text
        )
    store = EmbeddingStore(CACHE / "hook-quality-embeddings.sqlite3")
    try:
        embedded_counterfactuals = store.embed_many(required_counterfactuals)
    finally:
        store.close()

    pair_vectors = []
    pair_rows = []
    pair_targets = []
    pair_natural = []
    for source_index, partition in enumerate(partitions):
        component_indices = np.flatnonzero(source_indices == source_index)
        if len(component_indices) != int(partition["componentCount"]):
            raise RuntimeError(f"component offset mismatch for {partition['videoId']}")
        base = int(component_indices[0])
        component_count = len(component_indices)
        texts = text_by_source[str(partition["videoId"])]
        for left in range(component_count):
            for right in range(left + 1, component_count):
                pair_text = texts["pairOnly"][(left, right)]
                pair_vectors.append(embedded_counterfactuals[pair_text])
                later = base + right
                pair_targets.append(
                    fixed["targetResidual"][later] - fixed["prediction"][later]
                    if np.isfinite(fixed["targetResidual"][later] + fixed["prediction"][later])
                    else np.nan
                )
                time_gap = starts[later] - ends[base + left]
                pair_natural.append([
                    left, right, right - left,
                    float(time_gap) if np.isfinite(time_gap) else np.nan,
                    component_rows[base + left]["endToken"] - component_rows[base + left]["startToken"],
                    component_rows[later]["endToken"] - component_rows[later]["startToken"],
                    float(fixed["prediction"][later]) if np.isfinite(fixed["prediction"][later]) else np.nan,
                ])
                pair_rows.append({
                    "sourceIndex": source_index,
                    "videoId": str(partition["videoId"]),
                    "left": left,
                    "right": right,
                    "leftCategory": int(component_rows[base + left]["category"]),
                    "rightCategory": int(component_rows[later]["category"]),
                    "categoryPair": (
                        f"{component_rows[base + left]['category']}->"
                        f"{component_rows[later]['category']}"
                    ),
                    "leftText": component_rows[base + left]["text"],
                    "rightText": component_rows[later]["text"],
                    "pairEmbeddingInput": pair_text,
                })
    pair_embedding = row_unit(np.asarray(pair_vectors, np.float32))
    pair_left = np.asarray([
        raw_components[np.flatnonzero(source_indices == int(row["sourceIndex"]))[int(row["left"])]]
        for row in pair_rows
    ])
    pair_right = np.asarray([
        raw_components[np.flatnonzero(source_indices == int(row["sourceIndex"]))[int(row["right"])]]
        for row in pair_rows
    ])
    nonadditive_pair = interaction_features(pair_embedding, pair_left, pair_right)
    relationship_feature_candidates = {
        "ordered_pair": pair_embedding,
        "nonadditive_pair": nonadditive_pair,
        "left_context_added_to_right": row_unit(pair_embedding - row_unit(pair_right)),
        "right_context_added_to_left": row_unit(pair_embedding - row_unit(pair_left)),
        "ordered_pair_plus_nonadditive": combined_component_features(
            pair_embedding, nonadditive_pair,
        ),
        "ordered_singleton_blocks": combined_component_features(pair_left, pair_right),
    }
    pair_targets = np.asarray(pair_targets, np.float32)
    pair_natural = np.asarray(pair_natural, np.float32)
    pair_groups = np.asarray([row["videoId"] for row in pair_rows]).astype(str)
    relationship_search = {}
    for name, candidate_features in relationship_feature_candidates.items():
        relationship_search[name] = crossfit_axis(
            candidate_features, pair_targets, pair_natural, pair_groups,
        )
    relationship_representation = max(
        sorted(relationship_search),
        key=lambda name: float(relationship_search[name]["heldoutSpearman"]),
    )
    relation_features = relationship_feature_candidates[relationship_representation]
    relation_validation = relationship_search[relationship_representation]
    relation_inference = source_signflip(
        relation_validation["prediction"], relation_validation["targetResidual"], pair_groups,
        repeats=args.inference_repeats, seed=20260715,
    )
    relation_fitted = fit_full_axis(
        relation_features, pair_targets, pair_natural,
    )
    response_interaction_values = []
    pair_cursor = 0
    for source_index, partition in enumerate(partitions):
        full = hook_features[source_index]
        texts = text_by_source[str(partition["videoId"])]
        component_indices = np.flatnonzero(source_indices == source_index)
        base = int(component_indices[0])
        component_count = len(component_indices)
        full_feature = combined_component_features(
            full[None, :], full[None, :],
        )[0]
        for left in range(component_count):
            for right in range(left + 1, component_count):
                category = str(component_rows[base + right]["category"])
                direction = np.asarray(component_models[category]["direction"], np.float32)

                without_left_raw = row_unit(
                    embedded_counterfactuals[texts["withoutOne"][left]]
                )
                without_right_raw = row_unit(
                    embedded_counterfactuals[texts["withoutOne"][right]]
                )
                without_pair_text = texts["withoutPair"][(left, right)]
                without_pair_raw = (
                    row_unit(embedded_counterfactuals[without_pair_text])
                    if without_pair_text else np.zeros_like(full)
                )
                pair_raw = row_unit(
                    embedded_counterfactuals[texts["pairOnly"][(left, right)]]
                )
                without_left_feature = combined_component_features(
                    without_left_raw[None, :],
                    row_unit(full - raw_components[base + left])[None, :],
                )[0]
                without_right_feature = combined_component_features(
                    without_right_raw[None, :],
                    row_unit(full - raw_components[base + right])[None, :],
                )[0]
                without_pair_feature = combined_component_features(
                    without_pair_raw[None, :],
                    row_unit(full - pair_raw)[None, :],
                )[0]
                value = float(
                    full_feature @ direction
                    - without_left_feature @ direction
                    - without_right_feature @ direction
                    + without_pair_feature @ direction
                )
                response_interaction_values.append(value)
                pair_rows[pair_cursor]["responseAxisInteraction"] = value
                pair_rows[pair_cursor]["responseInteractionDefinition"] = (
                    "full - without left - without right + without both"
                )
                pair_cursor += 1
    if pair_cursor != len(pair_rows):
        raise RuntimeError("variable relationship counter did not consume every pair")

    response_interaction_values = np.asarray(response_interaction_values, np.float32)
    pair_calibration = {}
    response_interaction_calibration = {}
    for pair_key in sorted(set(row["categoryPair"] for row in pair_rows)):
        selected = np.asarray([row["categoryPair"] == pair_key for row in pair_rows])
        pair_calibration[pair_key] = np.sort(
            relation_fitted["projection"][selected]
        ).astype(float).tolist()
        response_interaction_calibration[pair_key] = np.sort(
            response_interaction_values[selected]
        ).astype(float).tolist()
    for index, row in enumerate(pair_rows):
        row.update({
            "unexpectedRelationshipTarget": (
                float(pair_targets[index]) if np.isfinite(pair_targets[index]) else None
            ),
            "predictedRelationshipOOF": (
                float(relation_validation["prediction"][index])
                if np.isfinite(relation_validation["prediction"][index]) else None
            ),
            "axisCoordinate": float(relation_fitted["projection"][index]),
            "axisPercentile": percentile(
                np.asarray(pair_calibration[row["categoryPair"]], float),
                relation_fitted["projection"][index],
            ),
            "responseInteractionPercentile": percentile(
                np.asarray(response_interaction_calibration[row["categoryPair"]], float),
                response_interaction_values[index],
            ),
        })

    resolution = []
    for row in corpus:
        duration = float(row.get("duration_s") or np.nan)
        count = len(row.get("curve") or [])
        if np.isfinite(duration) and count > 1:
            resolution.append(duration / (count - 1))
    metric_contract = {
        "name": "future-free unexpected retention slope",
        "unit": "entry-indexed retention fraction per second",
        "higherMeans": "the retention curve falls less, or rises more, than the text-free expectation",
        "selectedCandidate": selected_id,
        "selectedLagSeconds": selected_candidate.lag,
        "exploratorySelectedCandidate": exploratory_selected_id,
        "exploratorySelectedLagSeconds": exploratory_candidate.lag,
        "positiveProcessingLagSupported": deconfounding_audit["processingLagSupported"],
        "servedLagReason": (
            "the exploratory lag passed the full deconfounding and reverse-time gate"
            if deconfounding_audit["processingLagSupported"] else
            "no positive delay was identified, so the operational window has zero added lag"
        ),
        "anchor": selected_candidate.anchor,
        "windowDefinition": selected_candidate.definition,
        "selectionPolicy": (
            "within each outer source-video fold, choose only among 0s to 5s forward shifts "
            "of the same exact spoken interval using equal-weight Fisher-mean Spearman across "
            "the four frozen categories; a positive winner is served only after the complete "
            "normalization/baseline/lag max-null and matched reverse-time controls pass"
        ),
        "normalization": "R(t) / R(0); no terminal or post-response value enters the primary target",
        "naturalDropBaseline": (
            "one category-blind source-held-out ridge using exact timing, duration, and measured "
            "trajectory ending one source-native sample before the spoken component begins; "
            "every source video has equal total weight"
        ),
        "deployableInput": (
            "the saved semantic axis scores only the exact component embedding plus its deletion-influence "
            "embedding; measured past trajectory is used only to isolate the training outcome"
        ),
        "reverseTimePolicy": "negative lags are falsification controls and can never be selected",
        "nativeCurveMedianSampleSeconds": float(np.median(resolution)),
        "lagUncertainty": lag_uncertainty,
        "causalClaim": False,
    }
    random_fold_supported = bool(
        fixed_inference["p"] <= .05
        and fixed_inference["ciLow"] is not None
        and fixed_inference["ciLow"] > 0
        and fixed["heldoutSpearman"] > control_max
        and deconfounding_audit["primarySpecification"]["familyMaxNullP"] <= .05
    )
    future_supported = bool(
        chronological_inference["p"] <= .05
        and chronological_inference["ciLow"] is not None
        and chronological_inference["ciLow"] > 0
        and chronological_fixed["heldoutSpearman"] > 0
        and all(
            value > 0 for value in
            chronological_fixed["heldoutSpearmanByCategory"].values()
        )
    )
    validated = bool(random_fold_supported and future_supported)
    validation_status = (
        "validated-random-and-future"
        if validated else "deconfounded-but-unvalidated-diagnostic"
    )
    model = {
        "version": 2,
        "status": "complete",
        "methodVersion": METHOD_VERSION,
        "embeddingModel": manifest["embeddingModel"],
        "embeddingDimensions": manifest["embeddingDimensions"],
        "semanticRules": 0,
        "generativeLlmUsed": False,
        "metricContract": metric_contract,
        "validated": validated,
        "validationStatus": validation_status,
        "categoryClaimStatus": (
            "conditional on a post-hoc manual-probe-selected k=4 category map; "
            "the category labels are not an unlabeled discovery"
        ),
        "fixedConfiguration": {
            "featureBlocks": ["raw exact component embedding", "deletion-influence embedding"],
            "blockWeighting": "equal L2 energy",
            "pcaDimensions": FIXED_DIMENSIONS,
            "semanticRidgeAlpha": FIXED_SEMANTIC_ALPHA,
            "naturalBaselineRidgeAlpha": FIXED_BASELINE_ALPHA,
        },
        "component": {
            "modelsByCategory": component_models,
            "validation": {
                "heldoutCategoryBalancedSpearman": fixed["heldoutSpearman"],
                "heldoutSpearmanByCategory": fixed["heldoutSpearmanByCategory"],
                "sourceInference": fixed_inference,
                "chronologicalValidation": {
                    "heldoutCategoryBalancedSpearman": chronological_fixed["heldoutSpearman"],
                    "heldoutSpearmanByCategory": chronological_fixed["heldoutSpearmanByCategory"],
                    "sourceInference": chronological_inference,
                    "exploratorySelectionCounts": chronological_selection["selectionCounts"],
                    "exploratorySelectionFolds": chronological_selection["folds"],
                    "evaluatedRows": chronological_fixed["evaluatedRows"],
                    "unevaluatedWarmupRows": chronological_fixed["unevaluatedRows"],
                    "validationDesign": chronological_fixed["validationDesign"],
                },
            },
        },
        "deconfoundingAudit": deconfounding_audit,
        "wholeHook": {
            "accepted": False,
            "definition": (
                "equal mean of every evidence-selected category-calibrated component-axis "
                "percentile; each component has exactly one non-overlapping token owner"
            ),
            "trainingCompositeSorted": composite_training_sorted.astype(float).tolist(),
            "validation": composite_validation,
        },
        "directFullHookEmbeddingFalsification": {
            **axis_payload(hook_fitted),
            "accepted": False,
            "reason": "the complete-hook embedding did not predict the selected local response metric",
            "validation": {
                "heldoutSpearman": hook_validation["heldoutSpearman"],
                "heldoutPearson": hook_validation["heldoutPearson"],
                "foldDirectionMedianCosine": hook_validation["foldDirectionMedianCosine"],
                "sourceInference": hook_inference,
            },
        },
        "relationship": {
            "definition": (
                "exact local second-order deletion interaction (full - without left - without "
                "right + without both), measured on the later component's conditional "
                "category-specific forward-response diagnostic"
            ),
            "calibrationByCategoryPair": response_interaction_calibration,
            "validationSource": (
                "inherits the later component diagnostic status; no separate validation or causal claim"
            ),
            "standaloneObservedResidualAudit": {
                **axis_payload(relation_fitted),
                "accepted": False,
                "reason": (
                    "the representation was selected by maximum held-out correlation across six "
                    "candidates on the same data; its nominal inference is exploratory"
                ),
                "featureDefinition": (
                    f"selected predeclared geometry: {relationship_representation}; exact source order"
                ),
                "selectedRepresentation": relationship_representation,
                "representationSearch": {
                    name: {
                        "heldoutSpearman": result["heldoutSpearman"],
                        "heldoutPearson": result["heldoutPearson"],
                        "foldDirectionMedianCosine": result["foldDirectionMedianCosine"],
                    } for name, result in relationship_search.items()
                },
                "targetDefinition": (
                    "later component's unexpected forward slope minus its source-held-out singleton prediction"
                ),
                "calibrationByCategoryPair": pair_calibration,
                "validation": {
                    "heldoutSpearman": relation_validation["heldoutSpearman"],
                    "heldoutPearson": relation_validation["heldoutPearson"],
                    "foldDirectionMedianCosine": relation_validation["foldDirectionMedianCosine"],
                    "sourceInference": relation_inference,
                },
            },
        },
    }
    summary = {
        "version": 2,
        "status": "complete",
        "stage": "forward-only component response metric and latent axes",
        "methodVersion": METHOD_VERSION,
        "validated": validated,
        "validationStatus": validation_status,
        "categoryClaimStatus": model["categoryClaimStatus"],
        "metricContract": metric_contract,
        "deconfoundingAudit": deconfounding_audit,
        "selection": {
            "role": "exploratory lag search; the served lag is separately gated",
            "exploratorySelectedCandidate": exploratory_selected_id,
            "servedCandidate": selected_id,
            "servedLagSeconds": selected_candidate.lag,
            "nestedHeldoutCategoryBalancedSpearman": selection["heldoutSpearman"],
            "nestedHeldoutSpearmanByCategory": selection["heldoutSpearmanByCategory"],
            "sourceInference": nested_inference,
            "selectionCounts": selection["selectionCounts"],
            "selectedFraction": selection["selectedFraction"],
            "lagBootstrap": lag_uncertainty,
            "folds": selection["folds"],
            "fixedSelectedMetricHeldoutSpearman": fixed["heldoutSpearman"],
            "fixedSelectedMetricByCategory": fixed["heldoutSpearmanByCategory"],
            "fixedSelectedMetricInference": fixed_inference,
            "maximumReverseTimeControlAbsRho": control_max,
            "chronological": model["component"]["validation"]["chronologicalValidation"],
        },
        "forwardCandidates": forward_rows,
        "reverseTimeControls": control_rows,
        "componentModel": model["component"]["validation"],
        "wholeHookModel": model["wholeHook"]["validation"],
        "relationshipModel": {
            "definition": model["relationship"]["definition"],
            "validationSource": model["relationship"]["validationSource"],
            "standaloneObservedResidualAudit": (
                model["relationship"]["standaloneObservedResidualAudit"]["validation"]
            ),
        },
        "components": component_rows,
        "relationships": pair_rows,
        "hooks": hook_rows,
        "timingAudit": timing_audit,
        "entryDiagnostic": entry_diagnostic,
        "audit": {
            "hooks": len(corpus),
            "components": len(component_rows),
            "relationships": len(pair_rows),
            "forwardCandidates": len(forward_candidates),
            "reverseTimeControls": len(control_candidates),
            "partitionCoverageFailures": partitions_payload["validation"]["coverageFailures"],
            "partitionOverlaps": partitions_payload["validation"]["overlaps"],
            "elapsedSeconds": round(time.time() - started, 3),
        },
    }

    hook_quality = read_json(HOOK_QUALITY_PATH)
    hook_model = read_json(HOOK_MODEL_PATH)
    hook_quality["forwardResponse"] = summary
    hook_quality["model"]["scoreLabel"] = "Hook retained-information percentile"
    hook_quality["model"]["forwardResponseValidated"] = validated
    component_lookup = {
        (row["videoId"], int(row["component"])): row for row in component_rows
    }
    for row in hook_quality.get("components") or []:
        response = component_lookup.get((str(row["videoId"]), int(row["component"])))
        if response:
            row["forwardResponse"] = {
                key: response.get(key) for key in (
                    "spokenStartSeconds", "spokenEndSeconds", "responseWindowStartSeconds",
                    "responseWindowEndSeconds", "rawObservedSlope",
                    "entryIndexedObservedSlope", "terminalConditionedReplayObservedSlope",
                    "endpointAffineObservedSlope", "naturalExpectedSlopeOOF",
                    "entryIndexedResidualSlope", "unexpectedObservedSlope",
                    "predictedUnexpectedSlopeOOF", "axisCoordinate", "axisPercentile", "mapY", "fold",
                )
            }
    hook_lookup = {row["videoId"]: row for row in hook_rows}
    relationship_lookup = {
        (row["videoId"], int(row["left"]), int(row["right"])): row for row in pair_rows
    }
    for row in (hook_quality.get("axis") or {}).get("points") or []:
        if str(row["videoId"]) in hook_lookup:
            row["forwardResponse"] = hook_lookup[str(row["videoId"])]
        for pair in row.get("pairInteractions") or []:
            response = relationship_lookup.get((
                str(row["videoId"]), int(pair["left"]), int(pair["right"])
            ))
            if response:
                pair["forwardResponse"] = {
                    key: response.get(key) for key in (
                        "unexpectedRelationshipTarget", "predictedRelationshipOOF",
                        "axisCoordinate", "axisPercentile", "responseAxisInteraction",
                        "responseInteractionPercentile",
                    )
                }
    hook_model["forwardResponse"] = model
    if hook_model.get("primaryScore") == "forwardResponse.wholeHook":
        hook_model.pop("primaryScore", None)
    atomic_json(OUTPUT_PATH, summary)
    atomic_json(MODEL_PATH, model)
    atomic_json(HOOK_QUALITY_PATH, hook_quality)
    atomic_json(HOOK_MODEL_PATH, hook_model)
    if not args.no_upload:
        remote = R2Store()
        remote.put_json(f"{R2_PREFIX}/forward-response.json.gz", summary, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/forward-response-model.json.gz", model, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/hook-quality.json.gz", hook_quality, gzip_payload=True)
        remote.put_json(f"{R2_PREFIX}/hook-quality-model.json.gz", hook_model, gzip_payload=True)
    print(json.dumps({
        "selectedCandidate": selected_id,
        "selectedLagSeconds": selected_candidate.lag,
        "nestedHeldoutSpearman": selection["heldoutSpearman"],
        "fixedHeldoutSpearman": fixed["heldoutSpearman"],
        "maximumReverseTimeControlAbsRho": control_max,
        "wholeHookCompositeHeldoutSpearman": composite_validation["heldoutSpearman"],
        "directFullHookFalsificationSpearman": hook_validation["heldoutSpearman"],
        "standaloneRelationshipAuditSpearman": relation_validation["heldoutSpearman"],
        "validated": validated,
        "elapsedSeconds": summary["audit"]["elapsedSeconds"],
    }, indent=2))


if __name__ == "__main__":
    main()
