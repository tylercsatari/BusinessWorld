#!/usr/bin/env python3
"""Search and publish measured and counterfactual semantic outcome directions."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from axes import fit_direction, search_axes
from embedding_store import R2_PREFIX, R2Store, json_ready


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(json_ready(value), separators=(",", ":"),
                                    allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def retention_at(curve, duration, seconds):
    curve = np.asarray(curve if curve is not None else [], float)
    if len(curve) < 2 or not duration or duration <= 0 or seconds < 0 or seconds > duration:
        return float("nan")
    position = np.clip(seconds / duration * (len(curve) - 1), 0, len(curve) - 1)
    lower = int(math.floor(position))
    upper = min(len(curve) - 1, lower + 1)
    return float(curve[lower] + (curve[upper] - curve[lower]) * (position - lower))


def retention_window(curve, duration, start, end, samples=21):
    if not duration or start < 0 or end <= start or end > duration:
        return np.asarray([]), np.asarray([])
    seconds = np.linspace(start, end, samples)
    values = np.asarray([retention_at(curve, duration, second) for second in seconds], float)
    valid = np.isfinite(values)
    return seconds[valid], values[valid]


def retention_window_mean(curve, duration, start, end):
    _, values = retention_window(curve, duration, start, end)
    return float(values.mean()) if len(values) else float("nan")


def retention_window_slope(curve, duration, start, end):
    seconds, values = retention_window(curve, duration, start, end)
    if len(values) < 3 or np.std(seconds) == 0:
        return float("nan")
    return float(np.polyfit(seconds, values, 1)[0])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dimensions", default="4,8,16,32,64")
    parser.add_argument("--alphas", default="0.0001,0.001,0.01,0.1,1,10,100,1000,10000")
    parser.add_argument("--null-repeats", type=int, default=1024)
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument(
        "--upload-intermediates",
        action="store_true",
        help="Also publish fitted direction tensors and the raw axis registry to R2",
    )
    args = parser.parse_args()
    dimensions = [int(value) for value in args.dimensions.split(",")]
    alphas = [float(value) for value in args.alphas.split(",")]
    started = time.time()

    atlas = json.loads((CACHE / "atlas.json").read_text(encoding="utf-8"))
    swaps = json.loads((CACHE / "swaps.json").read_text(encoding="utf-8"))
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))
    candidates = atlas["candidates"]
    candidate_index = {row["id"]: index for index, row in enumerate(candidates)}
    source_rows = swaps["sourceComponents"]
    source_indices = np.asarray([candidate_index[row["sourceId"]] for row in source_rows], int)
    groups = np.asarray([row["videoId"] for row in source_rows])
    with np.load(CACHE / "candidate-vectors.npz", allow_pickle=True) as loaded:
        representations = {
            name: np.asarray(loaded[name][source_indices], np.float32)
            for name in ("raw", "influence", "nonadditive", "context")
        }
    corpus_by_id = {row["id"]: row for row in corpus["rows"]}

    surface = []
    timing = []
    entry_delivery = []
    targets = {}
    for row in source_rows:
        candidate = candidates[candidate_index[row["sourceId"]]]
        hook = corpus_by_id[row["videoId"]]
        surface.append([candidate["startRatio"], candidate["endRatio"], candidate["tokenCount"],
                        candidate["parentTokenCount"]])
        timing.append([float(hook.get("hookEndSec") or 0), float(hook.get("duration_s") or 0)])
        curve = hook.get("curve") or []
        duration = float(hook.get("duration_s") or 0)
        entry = float(curve[0]) if curve else float("nan")
        entry_delivery.append([
            entry - 1 if np.isfinite(entry) else np.nan,
            retention_at(curve, duration, 1),
            float(hook.get("keep_rate") or np.nan),
        ])
    surface = np.asarray(surface, np.float32)
    timing = np.asarray(timing, np.float32)
    entry_delivery = np.asarray(entry_delivery, np.float32)

    for metric in swaps["metricNames"]:
        targets[f"transfer_{metric}"] = {
            "values": np.asarray([row["metrics"][metric]["meanDeltaAcrossContexts"] for row in source_rows]),
            "channel": "Long Quant model-predicted counterfactual",
            "definition": f"mean {metric} percentile delta when this component is transferred across every target hook",
            "targetUnit": "discovered component instance",
            "requiredConfounds": "surface_timing_context_entry_delivery_swipe",
        }

    measured = defaultdict(list)
    for row in source_rows:
        hook = corpus_by_id[row["videoId"]]
        curve = hook.get("curve") or []
        duration = float(hook.get("duration_s") or 0)
        end = float(hook.get("hookEndSec") or 0)
        r5 = retention_at(curve, duration, 5)
        rh = retention_at(curve, duration, end)
        entry = float(curve[0]) if curve else float("nan")
        measured["keep_rate"].append(float(hook.get("keep_rate") or np.nan))
        measured["avg_retention"].append(float(hook.get("avg_retention") or np.nan))
        measured["log_views"].append(math.log10(max(1, float(hook.get("views") or 0))))
        measured["retention_5s"].append(r5)
        measured["retention_hook_end"].append(rh)
        measured["entry_rewatch"].append(entry - 1 if np.isfinite(entry) else np.nan)
        measured["drop_entry_to_hook_end"].append(entry - rh if np.isfinite(entry + rh) else np.nan)
        for second in (1, 2, 3, 8, 10, 15, 20, 30):
            measured[f"retention_{second}s"].append(retention_at(curve, duration, second))
        for fraction in (.1, .2, .3, .5):
            measured[f"retention_{int(fraction * 100)}pct_duration"].append(
                retention_at(curve, duration, duration * fraction)
            )
        for start, stop in ((0, 3), (0, 5), (0, 10), (3, 8), (5, 10)):
            measured[f"retention_mean_{start}_{stop}s"].append(
                retention_window_mean(curve, duration, start, stop)
            )
            measured[f"retention_slope_{start}_{stop}s"].append(
                retention_window_slope(curve, duration, start, stop)
            )
        for offset in (1, 3, 5, 10):
            after = retention_at(curve, duration, end + offset)
            measured[f"hold_after_hook_{offset}s"].append(
                after - rh if np.isfinite(after + rh) else np.nan
            )
        early_slope = retention_window_slope(curve, duration, 0, 3)
        later_slope = retention_window_slope(curve, duration, 3, 8)
        measured["early_slope_change_0_3_to_3_8s"].append(
            later_slope - early_slope if np.isfinite(early_slope + later_slope) else np.nan
        )
    definitions = {
        "keep_rate": "measured viewed-versus-swiped percentage",
        "avg_retention": "measured average percentage viewed",
        "log_views": "log10 measured views",
        "retention_5s": "measured retention curve interpolated at 5 seconds",
        "retention_hook_end": "measured retention when the stored hook ends",
        "entry_rewatch": "measured curve entry above 100 percent",
        "drop_entry_to_hook_end": "measured entry retention minus retention at hook end",
        "hold_after_hook_5s": "measured retention five seconds after hook end minus retention at hook end",
    }
    for second in (1, 2, 3, 8, 10, 15, 20, 30):
        definitions[f"retention_{second}s"] = (
            f"measured retention curve interpolated at {second} seconds"
        )
    for fraction in (.1, .2, .3, .5):
        definitions[f"retention_{int(fraction * 100)}pct_duration"] = (
            f"measured retention at {int(fraction * 100)} percent of video duration"
        )
    for start, stop in ((0, 3), (0, 5), (0, 10), (3, 8), (5, 10)):
        definitions[f"retention_mean_{start}_{stop}s"] = (
            f"mean measured retention from {start} to {stop} seconds"
        )
        definitions[f"retention_slope_{start}_{stop}s"] = (
            f"least-squares measured retention slope from {start} to {stop} seconds"
        )
    for offset in (1, 3, 5, 10):
        definitions[f"hold_after_hook_{offset}s"] = (
            f"measured retention {offset} seconds after hook end minus retention at hook end"
        )
    definitions["early_slope_change_0_3_to_3_8s"] = (
        "measured 3-to-8-second retention slope minus the 0-to-3-second slope"
    )
    for name, values in measured.items():
        directly_overlapping_entry_confound = name in {"keep_rate", "retention_1s", "entry_rewatch"}
        targets[f"measured_{name}"] = {
            "values": np.asarray(values, float),
            "channel": "observed YouTube outcome",
            "definition": definitions[name],
            "targetUnit": "source-video outcome repeated across component instances; folds and nulls group by video",
            "requiredConfounds": (
                "surface_timing_context" if directly_overlapping_entry_confound
                else "surface_timing_context_entry_delivery_swipe"
            ),
        }

    context_source = representations["context"]
    empty = np.empty((len(source_rows), 0), np.float32)
    context_spec = lambda fixed: {
        "fixed": np.asarray(fixed, np.float32),
        "pcaSource": context_source,
        "pcaDimensions": min(16, len(source_rows) - 1),
    }
    confounds = {
        "none": empty,
        "surface": surface,
        "timing": timing,
        "semantic_context": context_spec(empty),
        "entry_delivery_swipe": entry_delivery,
        "surface_timing_context": context_spec(np.column_stack([surface, timing])),
        "surface_timing_context_entry_delivery_swipe": context_spec(np.column_stack([
            surface, timing, entry_delivery,
        ])),
    }
    r2 = None if args.no_upload else R2Store()
    last_progress = {"local": 0.0, "remote": 0.0, "printed": -1}

    def report_progress(value: dict) -> None:
        now = time.time()
        complete = int(value.get("axisGroupsComplete") or 0)
        total = int(value.get("axisGroupsTotal") or 0)
        payload = {
            "version": 4,
            "status": "running",
            "stage": "grouped held-out latent-axis search",
            **value,
            "updatedAt": int(now * 1000),
        }
        if now - last_progress["local"] >= .5 or complete == total:
            atomic_json(CACHE / "progress.json", payload)
            last_progress["local"] = now
        if r2 and (now - last_progress["remote"] >= 5 or complete == total):
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)
            last_progress["remote"] = now
        if complete == total or complete // 20 != last_progress["printed"]:
            last_progress["printed"] = complete // 20
            print(f"axis groups {complete}/{total}; experiments {payload['experimentsComplete']}",
                  flush=True)

    experiments, prediction_lookup = search_axes(
        representations, targets, groups, confounds, dimensions, alphas, args.null_repeats,
        progress=report_progress,
    )
    best_by_target = {}
    for target_name in targets:
        rows = [row for row in experiments if row["target"] == target_name]
        if rows:
            best_by_target[target_name] = next(row for row in rows if row["selectedForTarget"])

    directions = {}
    maps = []
    for target_name, experiment in best_by_target.items():
        target = targets[target_name]["values"]
        confound = confounds[experiment["confounds"]]
        direction, scores = fit_direction(
            representations[experiment["representation"]], target, confound,
            experiment["pcaDimensions"], experiment["ridgeAlpha"]
        )
        directions[experiment["id"]] = direction
        background = PCA(n_components=1, svd_solver="randomized", random_state=991).fit_transform(
            representations[experiment["representation"]]
        )[:, 0]
        maps.append({
            "experiment": experiment,
            "x": np.round(scores, 5).tolist(),
            "y": np.round(background, 5).tolist(),
            "observed": np.round(target, 5).tolist(),
            "predictedOOF": np.round(
                prediction_lookup[experiment["id"]]["prediction"], 5
            ).tolist(),
            "observedResidualOOF": np.round(
                prediction_lookup[experiment["id"]]["observed"], 5
            ).tolist(),
        })

    registry_path = CACHE / "axis-experiments.jsonl.gz"
    registry_path.write_bytes(gzip.compress(
        "\n".join(json.dumps(json_ready(row), separators=(",", ":"), allow_nan=False)
                  for row in experiments).encode(),
        compresslevel=6,
    ))
    directions_path = CACHE / "axis-directions.npz"
    np.savez_compressed(directions_path, **directions)
    summary = {
        "version": 4,
        "status": "complete",
        "stage": "held-out latent-axis search",
        "componentInstances": len(source_rows),
        "sourceVideos": len(set(groups)),
        "representations": list(representations),
        "confoundSets": list(confounds),
        "targets": {name: {key: value for key, value in meta.items() if key != "values"}
                    for name, meta in targets.items()},
        "experimentCount": len(experiments),
        "nullRepeats": args.null_repeats,
        "minimumAttainableP": 1 / (args.null_repeats + 1),
        "validatedCount": 0,
        "randomFoldSupportedCount": sum(
            row["status"] == "multiplicity-controlled-random-fold-association"
            for row in experiments
        ),
        "bestByTarget": best_by_target,
        "maps": maps,
        "elapsedSeconds": round(time.time() - started, 2),
    }
    (CACHE / "axes.json").write_text(
        json.dumps(json_ready(summary), separators=(",", ":"), allow_nan=False), encoding="utf-8"
    )
    complete_progress = {
        "version": 4,
        "status": "complete",
        "stage": "all Promise Lab v4 analyses complete",
        "axisExperiments": len(experiments),
        "validatedAxes": 0,
        "randomFoldSupportedAxes": summary["randomFoldSupportedCount"],
        "updatedAt": int(time.time() * 1000),
    }
    atomic_json(CACHE / "progress.json", complete_progress)
    if r2:
        r2.put_json(f"{R2_PREFIX}/axes.json.gz", summary, gzip_payload=True)
        if args.upload_intermediates:
            r2.put_bytes(f"{R2_PREFIX}/axis-experiments.jsonl.gz", registry_path.read_bytes(),
                         "application/gzip")
            r2.put_bytes(f"{R2_PREFIX}/axis-directions.npz", directions_path.read_bytes(),
                         "application/octet-stream")
        r2.put_json(f"{R2_PREFIX}/progress.json", complete_progress)
    print(json.dumps({key: summary[key] for key in
                      ("componentInstances", "sourceVideos", "experimentCount", "validatedCount",
                       "elapsedSeconds")}, indent=2))


if __name__ == "__main__":
    main()
