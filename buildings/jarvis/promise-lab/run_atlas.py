#!/usr/bin/env python3
"""Build component candidates and run the registered clustering sweep."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import time
from pathlib import Path

import numpy as np

from atlas import (REPRESENTATIONS, REPRESENTATION_VERSION, component_id,
                   representation_matrix, run_cluster_sweep)
from embedding_store import R2_PREFIX, R2Store, json_ready
from sequence import surface, tokenize, without_span


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
LEGACY_VECTOR_PATH = CACHE / "candidate-vectors-pre-exact-offset.npz"
EXACT_VECTOR_DIR = CACHE / "exact-candidate-vectors"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(json_ready(value), ensure_ascii=False, separators=(",", ":"),
                               allow_nan=False), encoding="utf-8")
    os.replace(temp, path)


def load_candidates(limit_hooks: int = 0):
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    discovery_paths = [CACHE / "discovery" / f"{row['id']}.json" for row in corpus]
    missing = [path.stem for path in discovery_paths if not path.exists()]
    if missing:
        raise RuntimeError(f"active corpus is missing discovery artifacts: {missing[:5]}")
    if limit_hooks:
        discovery_paths = discovery_paths[:limit_hooks]
    rows = []
    representation_rows = {name: [] for name in REPRESENTATIONS}
    groups = []
    all_span_index = {}
    all_span_matrices = {}
    all_span_manifest_path = CACHE / "all-span-manifest.json"
    if all_span_manifest_path.exists():
        all_span_manifest = json.loads(all_span_manifest_path.read_text(encoding="utf-8"))
        if all_span_manifest.get("representationVersion") != REPRESENTATION_VERSION:
            raise RuntimeError("authoritative all-span store uses a stale representation formula")
        all_span_index = {
            str(row["id"]): index for index, row in enumerate(all_span_manifest["rows"])
        }
        all_span_matrices = {
            name: np.load(CACHE / "all-span-vectors" / f"{name}.npy", mmap_mode="r")
            for name in REPRESENTATIONS
        }
    legacy_index = {}
    legacy_matrices = {}
    if LEGACY_VECTOR_PATH.exists():
        with np.load(LEGACY_VECTOR_PATH, allow_pickle=True) as loaded:
            legacy_ids = [str(value) for value in loaded["ids"]]
            legacy_index = {value: index for index, value in enumerate(legacy_ids)}
            legacy_matrices = {
                name: np.asarray(loaded[name], np.float32) for name in REPRESENTATIONS
            }
    for position, discovery_path in enumerate(discovery_paths, 1):
        video_id = discovery_path.stem
        discovery = json.loads(discovery_path.read_text(encoding="utf-8"))
        metadata = json.loads((CACHE / "metadata" / f"{video_id}.json").read_text(encoding="utf-8"))
        tensor_path = CACHE / "tensors" / f"{video_id}.npz"
        arrays = None
        lookup = {}
        matrices = {}
        exact_index = {}
        exact_matrices = {}
        if tensor_path.exists():
            with np.load(tensor_path, allow_pickle=False) as loaded:
                arrays = {name: loaded[name] for name in loaded.files}
            lookup = {(int(start), int(end)): index for index, (start, end) in
                      enumerate(zip(arrays["span_start"], arrays["span_end"]))}
            matrices = {name: representation_matrix(name, arrays) for name in REPRESENTATIONS}
        exact_path = EXACT_VECTOR_DIR / f"{video_id}.npz"
        if exact_path.exists():
            with np.load(exact_path, allow_pickle=True) as loaded:
                exact_ids = [str(value) for value in loaded["ids"]]
                exact_index = {value: index for index, value in enumerate(exact_ids)}
                exact_matrices = {
                    name: np.asarray(loaded[name], np.float32) for name in REPRESENTATIONS
                }
        token_text = [token["text"] for token in metadata["tokens"]]
        token_objects = tokenize(metadata["text"])
        selected_spans = {
            (int(start), int(end))
            for start, end in ((discovery.get("selectedSegmentation") or {}).get("partition") or [])
        }
        exploratory_spans = {
            (int(start), int(end))
            for start, end in ((discovery.get("exploratoryNontrivialSegmentation") or {}).get("partition") or [])
        }
        for candidate in discovery.get("candidates") or []:
            start, end = int(candidate["start"]), int(candidate["end"])
            candidate_id = component_id(video_id, start, end)
            all_span_position = all_span_index.get(candidate_id)
            span_index = lookup.get((start, end))
            exact_position = exact_index.get(candidate_id)
            legacy_position = legacy_index.get(candidate_id)
            if (all_span_position is None and span_index is None
                    and exact_position is None and legacy_position is None):
                raise RuntimeError(f"no exact tensor or verified legacy vector for {candidate_id}")
            row = {
                "id": candidate_id,
                "videoId": video_id,
                "start": start,
                "end": end,
                "tokenCount": end - start,
                "parentTokenCount": len(token_text),
                "startRatio": start / max(1, len(token_text)),
                "endRatio": end / max(1, len(token_text)),
                "text": surface(token_objects, start, end, source_text=metadata["text"]),
                "contextText": without_span(
                    token_objects, start, end, source_text=metadata["text"]
                ),
                "hookText": metadata["text"],
                "frequency": candidate["frequency"],
                "nullFrequency": candidate["nullFrequency"],
                "aboveNullFrequency": candidate["aboveNullFrequency"],
                "calibratedZ": candidate["calibratedZ"],
                "calibratedP": candidate["calibratedP"],
                "calibratedQ": candidate["calibratedQ"],
                "methods": candidate["methods"],
                "selectedPrimary": (start, end) in selected_spans,
                "selectedExploratory": (start, end) in exploratory_spans,
                "segmentationStatus": (discovery.get("selectedSegmentation") or {}).get("status", "provisional"),
                "segmentationSearchWideP": (discovery.get("selectedSegmentation") or {}).get("searchWideP"),
                "positionAndLengthUsedForClustering": False,
                "vectorSource": (
                    "authoritative-all-span-store"
                    if all_span_position is not None else
                    "per-hook-tensor" if span_index is not None else
                    "verified-exact-candidate-fallback" if exact_position is not None else
                    "verified-legacy-fallback"
                ),
            }
            rows.append(row)
            groups.append(video_id)
            for name in REPRESENTATIONS:
                # Copy the selected row so the list does not retain the entire
                # per-hook span matrix through a NumPy view.
                vector = (all_span_matrices[name][all_span_position]
                          if all_span_position is not None
                          else matrices[name][span_index] if span_index is not None
                          else exact_matrices[name][exact_position] if exact_position is not None
                          else legacy_matrices[name][legacy_position])
                representation_rows[name].append(vector.copy())
        print(f"[{position}/{len(discovery_paths)}] {video_id}: {len(discovery.get('candidates') or [])} candidates",
              flush=True)
    matrices = {name: np.asarray(values, np.float32) for name, values in representation_rows.items()}
    return rows, matrices, np.asarray(groups)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit-hooks", type=int, default=0)
    parser.add_argument("--max-dimension", type=int, default=12)
    parser.add_argument("--max-clusters", type=int, default=28)
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--fit-sample", type=int, default=2048)
    parser.add_argument("--eval-sample", type=int, default=768)
    parser.add_argument("--map-limit", type=int, default=300)
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument(
        "--upload-intermediates",
        action="store_true",
        help="Also publish candidate vectors and the raw experiment registry to R2",
    )
    args = parser.parse_args()
    started = time.time()
    rows, matrices, groups = load_candidates(args.limit_hooks)
    if len(rows) < 4:
        raise RuntimeError("not enough discovered component instances to build the atlas")

    vector_path = CACHE / "candidate-vectors.npz"
    np.savez_compressed(vector_path, ids=np.asarray([row["id"] for row in rows], object),
                        groups=groups, **matrices)
    r2 = None if args.no_upload else R2Store()
    last_progress = {"local": 0.0, "remote": 0.0, "printed": -1}

    def report_progress(value: dict) -> None:
        now = time.time()
        complete = int(value.get("configurationsComplete") or 0)
        total = int(value.get("configurationsTotal") or 0)
        payload = {
            "version": 4,
            "status": "running",
            "stage": "outcome-blind component atlas",
            "candidateInstances": len(rows),
            **value,
            "updatedAt": int(now * 1000),
        }
        if now - last_progress["local"] >= .5 or complete == total:
            atomic_json(CACHE / "progress.json", payload)
            last_progress["local"] = now
        if r2 and (now - last_progress["remote"] >= 5 or complete == total):
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)
            last_progress["remote"] = now
        if complete == total or complete // 100 != last_progress["printed"]:
            last_progress["printed"] = complete // 100
            print(f"atlas configurations {complete}/{total}; experiments {payload['experimentsComplete']}",
                  flush=True)

    sweep = run_cluster_sweep(
        matrices,
        groups,
        max_dimension=args.max_dimension,
        max_clusters=args.max_clusters,
        seeds=args.seeds,
        fit_sample=args.fit_sample,
        eval_sample=args.eval_sample,
        map_limit=args.map_limit,
        progress=report_progress,
        experiment_namespace=f"candidate-components:{REPRESENTATION_VERSION}",
    )
    atlas = {
        "version": 4,
        "status": "complete",
        "stage": "outcome-blind component atlas",
        "candidateInstances": len(rows),
        "hooks": len(set(groups)),
        "representations": list(matrices),
        "representationVersion": REPRESENTATION_VERSION,
        "authoritativeVectorSource": "all-span store when available",
        "geometries": ["euclidean", "spherical", "whitened"],
        "pcaDimensionsTested": [2, args.max_dimension],
        "clusterCountsTested": [2, args.max_clusters],
        "seedsPerConfiguration": args.seeds,
        "experimentCount": len(sweep.experiments),
        "mapCount": len(sweep.maps),
        "outcomesUsed": False,
        "positionAndLengthUsedForClustering": False,
        "computeBudget": {
            "maxPcaDimension": args.max_dimension,
            "maxClusterCount": args.max_clusters,
            "fitSample": args.fit_sample,
            "evalSample": args.eval_sample,
            "mapLimit": args.map_limit,
        },
        "elapsedSeconds": round(time.time() - started, 2),
        "pca": sweep.pca_meta,
        "candidates": rows,
        "projections": sweep.projections,
        "maps": sweep.maps,
    }
    atomic_json(CACHE / "atlas.json", atlas)
    registry_raw = "\n".join(json.dumps(row, separators=(",", ":"))
                              for row in sweep.experiments).encode()
    registry_path = CACHE / "cluster-experiments.jsonl.gz"
    registry_path.write_bytes(gzip.compress(registry_raw, compresslevel=6))

    if r2:
        r2.put_json(f"{R2_PREFIX}/atlas.json.gz", atlas, gzip_payload=True)
        if args.upload_intermediates:
            r2.put_bytes(f"{R2_PREFIX}/candidate-vectors.npz", vector_path.read_bytes(),
                         "application/octet-stream")
            r2.put_bytes(f"{R2_PREFIX}/cluster-experiments.jsonl.gz", registry_path.read_bytes(),
                         "application/gzip")
        r2.put_json(f"{R2_PREFIX}/progress.json", {
            "version": 4,
            "status": "running",
            "stage": "component atlas complete; discovered-family swaps next",
            "candidateInstances": len(rows),
            "clusterExperiments": len(sweep.experiments),
            "clusterMaps": len(sweep.maps),
            "updatedAt": int(time.time() * 1000),
        })
    print(json.dumps({key: atlas[key] for key in
                      ("candidateInstances", "hooks", "experimentCount", "mapCount", "elapsedSeconds")},
                     indent=2))


if __name__ == "__main__":
    main()
