#!/usr/bin/env python3
"""Run outcome-blind segmentation and boundary nulls over built tensors."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np

from embedding_store import R2_PREFIX, R2Store
from segmentation import discover_boundaries


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
TENSOR_DIR = CACHE / "tensors"
META_DIR = CACHE / "metadata"
DISCOVERY_DIR = CACHE / "discovery"
METHOD_VERSION = "exhaustive-delete-v4.3-exact-offset-mdl-search-null"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def experiment_id(video_id: str, method: str, segments: int) -> str:
    return hashlib.sha1(f"boundary:{video_id}:{method}:{segments}".encode()).hexdigest()[:20]


def cache_matches_source(cached: dict, metadata: dict, null_repeats: int,
                         bootstrap_repeats: int) -> bool:
    """Require boundary results to identify the exact intervention source."""
    fingerprint = metadata.get("fingerprint")
    cached_fingerprint = cached.get("sourceFingerprint")
    fingerprint_matches = (
        cached_fingerprint == fingerprint
        if cached_fingerprint is not None
        else cached.get("text") == metadata.get("text")
    )
    return bool(
        cached.get("methodVersion") == METHOD_VERSION
        and cached.get("interventionVersion") == metadata.get("interventionVersion")
        and cached.get("text") == metadata.get("text")
        and fingerprint_matches
        and int(cached.get("nullRepeats") or 0) == null_repeats
        and int(cached.get("bootstrapRepeats") or 0) == bootstrap_repeats
        and (
            cached.get("embeddingModel") in (None, metadata.get("embeddingModel"))
        )
        and int(cached.get("embeddingDimensions") or metadata.get("embeddingDimensions") or 0)
        == int(metadata.get("embeddingDimensions") or 0)
    )


def attach_source_contract(result: dict, metadata: dict) -> bool:
    """Backfill identity fields on legacy results without changing their analysis."""
    contract = {
        "sourceFingerprint": metadata.get("fingerprint"),
        "embeddingModel": metadata.get("embeddingModel"),
        "embeddingDimensions": metadata.get("embeddingDimensions"),
    }
    changed = any(result.get(key) != value for key, value in contract.items())
    result.update(contract)
    return changed


def collect_result(registry: list[dict], hook_summaries: list[dict],
                   video_id: str, result: dict) -> None:
    for row in result.get("experiments") or []:
        registry.append({
            "id": experiment_id(video_id, row["method"], row["segments"]),
            "stage": "boundary",
            "videoId": video_id,
            "method": row["method"],
            "segmentCount": row["segments"],
            "objective": row["objective"],
            "nullMean": row["nullMean"],
            "nullStd": row["nullStd"],
            "z": row["z"],
            "p": row["p"],
            "q": row["q"],
            "partition": row["partition"],
            "outcomesUsed": False,
        })
    hook_summaries.append({
        "videoId": video_id,
        "text": result.get("text"),
        "tokens": result.get("tokens"),
        "boundaries": result.get("boundaries"),
        "candidates": result.get("candidates"),
        "selectedSegmentation": result.get("selectedSegmentation"),
        "exploratoryNontrivialSegmentation": result.get("exploratoryNontrivialSegmentation"),
        "experimentCount": len(result.get("experiments") or []),
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--null-repeats", type=int, default=32)
    parser.add_argument("--bootstrap-repeats", type=int, default=12)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    r2 = None if args.no_upload else R2Store()
    tensor_paths = sorted(TENSOR_DIR.glob("*.npz"))
    if args.limit:
        tensor_paths = tensor_paths[:args.limit]
    registry = []
    hook_summaries = []
    started = time.time()

    for position, tensor_path in enumerate(tensor_paths, 1):
        video_id = tensor_path.stem
        output_path = DISCOVERY_DIR / f"{video_id}.json"
        cached = json.loads(output_path.read_text(encoding="utf-8")) if output_path.exists() else None
        metadata = json.loads((META_DIR / f"{video_id}.json").read_text(encoding="utf-8"))
        if (cached and not args.force and cache_matches_source(
                cached, metadata, args.null_repeats, args.bootstrap_repeats)):
            result = cached
            if attach_source_contract(result, metadata):
                atomic_json(output_path, result)
        else:
            with np.load(tensor_path, allow_pickle=False) as loaded:
                arrays = {name: loaded[name] for name in loaded.files}
            result = discover_boundaries(
                arrays,
                null_repeats=args.null_repeats,
                bootstrap_repeats=args.bootstrap_repeats,
                seed=int(hashlib.sha1(video_id.encode()).hexdigest()[:8], 16),
            )
            result.update({
                "version": 4,
                "methodVersion": METHOD_VERSION,
                "videoId": video_id,
                "text": metadata["text"],
                "tokens": metadata["tokens"],
                "outcomesUsed": False,
                "interventionVersion": metadata.get("interventionVersion"),
                "sourceFingerprint": metadata.get("fingerprint"),
                "embeddingModel": metadata.get("embeddingModel"),
                "embeddingDimensions": metadata.get("embeddingDimensions"),
                "candidateCount": len(result.get("candidates") or []),
                "interactionMatrix": np.round(arrays["pair_norms"], 5).tolist(),
                "tokenInfluenceNorm": np.round(
                    np.linalg.norm(arrays["token_effects"], axis=1), 5
                ).tolist(),
            })
            atomic_json(output_path, result)
        if r2:
            r2.put_json(f"{R2_PREFIX}/discovery/{video_id}.json.gz", result, gzip_payload=True)

        collect_result(registry, hook_summaries, video_id, result)
        progress = {
            "version": 4,
            "status": "running",
            "stage": "outcome-blind boundary discovery",
            "hooksTotal": len(tensor_paths),
            "hooksComplete": position,
            "boundaryExperiments": len(registry),
            "candidateInstances": sum(len(row.get("candidates") or [])
                                      for row in hook_summaries),
            "updatedAt": int(time.time() * 1000),
        }
        atomic_json(CACHE / "progress.json", progress)
        if r2 and (position == len(tensor_paths) or position % 5 == 0):
            r2.put_json(f"{R2_PREFIX}/progress.json", progress)
        print(f"[{position}/{len(tensor_paths)}] {video_id}: {len(result.get('experiments') or [])} runs, "
              f"{len(result.get('candidates') or [])} candidate spans", flush=True)

    # Incremental runs process only rebuilt tensors, but the published summary
    # and registry always come from the complete per-hook artifact set.
    registry = []
    hook_summaries = []
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    active_ids = [str(row["id"]) for row in corpus]
    missing = [video_id for video_id in active_ids
               if not (DISCOVERY_DIR / f"{video_id}.json").exists()]
    if missing:
        raise RuntimeError(f"active corpus is missing discovery artifacts: {missing[:5]}")
    for video_id in active_ids:
        discovery_path = DISCOVERY_DIR / f"{video_id}.json"
        result = json.loads(discovery_path.read_text(encoding="utf-8"))
        metadata = json.loads((META_DIR / f"{video_id}.json").read_text(encoding="utf-8"))
        stored_null_repeats = int(result.get("nullRepeats") or 0)
        stored_bootstrap_repeats = int(result.get("bootstrapRepeats") or 0)
        if not cache_matches_source(
                result, metadata, stored_null_repeats, stored_bootstrap_repeats):
            raise RuntimeError(f"stale discovery artifact for active hook {video_id}")
        if attach_source_contract(result, metadata):
            atomic_json(discovery_path, result)
        collect_result(registry, hook_summaries, video_id, result)
        if r2:
            r2.put_json(
                f"{R2_PREFIX}/discovery/{video_id}.json.gz",
                result,
                gzip_payload=True,
            )

    null_budgets = sorted({int(row.get("nullRepeats") or 0) for row in (
        json.loads((DISCOVERY_DIR / f"{video_id}.json").read_text(encoding="utf-8"))
        for video_id in active_ids
    )})
    bootstrap_budgets = sorted({int(row.get("bootstrapRepeats") or 0) for row in (
        json.loads((DISCOVERY_DIR / f"{video_id}.json").read_text(encoding="utf-8"))
        for video_id in active_ids
    )})
    summary = {
        "version": 4,
        "status": "complete",
        "stage": "outcome-blind boundary discovery",
        "hooks": len(hook_summaries),
        "experiments": len(registry),
        "candidateInstances": sum(len(row.get("candidates") or []) for row in hook_summaries),
        "nullRepeats": null_budgets[0] if len(null_budgets) == 1 else None,
        "nullRepeatBudgets": null_budgets,
        "bootstrapRepeats": bootstrap_budgets[0] if len(bootstrap_budgets) == 1 else None,
        "bootstrapRepeatBudgets": bootstrap_budgets,
        "outcomesUsed": False,
        "elapsedSeconds": round(time.time() - started, 2),
        "rows": hook_summaries,
    }
    atomic_json(CACHE / "discovery-summary.json", summary)
    registry_raw = "\n".join(json.dumps(row, separators=(",", ":")) for row in registry).encode()
    registry_path = CACHE / "boundary-experiments.jsonl.gz"
    registry_path.write_bytes(gzip.compress(registry_raw, compresslevel=6))
    if r2:
        r2.put_json(f"{R2_PREFIX}/discovery-summary.json.gz", summary, gzip_payload=True)
        r2.put_bytes(f"{R2_PREFIX}/boundary-experiments.jsonl.gz", registry_path.read_bytes(),
                     "application/gzip")
        r2.put_json(f"{R2_PREFIX}/progress.json", {
            "version": 4,
            "status": "running",
            "stage": "boundary discovery complete; component atlas next",
            "hooksComplete": len(hook_summaries),
            "boundaryExperiments": len(registry),
            "candidateInstances": summary["candidateInstances"],
            "updatedAt": int(time.time() * 1000),
        })


if __name__ == "__main__":
    main()
