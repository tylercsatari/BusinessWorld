#!/usr/bin/env python3
"""Build the shared component lattice for every measured hook."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import time
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

from component_lattice import (
    LATTICE_VERSION,
    RESOLUTION_DEFINITIONS,
    build_component_lattice,
    prefix_transition_distances,
)
from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, EmbeddingStore, R2Store, json_ready
from media_alignment import load_media_alignment
from sequence import tokenize


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE = CACHE / "all-span-vectors"
DETAILS = CACHE / "component-lattice"
SUMMARY_PATH = CACHE / "component-lattice.json"
MODEL_PATH = CACHE / "component-lattice-model.json"


def load(name: str) -> dict:
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(json_ready(value), separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def atomic_gzip_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    raw = json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                     allow_nan=False).encode("utf-8")
    temporary.write_bytes(gzip.compress(raw, compresslevel=6))
    os.replace(temporary, path)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fit_title_manifold() -> dict:
    vector_path = CACHE / "raw-long-text" / "vectors-unit.npy"
    map_path = CACHE / "raw-long-text" / "map.json"
    vectors = np.load(vector_path, mmap_mode="r")
    mapping = json.loads(map_path.read_text(encoding="utf-8"))
    source_hash = hashlib.sha256(
        (file_hash(vector_path) + "\0" + str(mapping.get("updated"))
         + "\0" + str(vectors.shape)).encode("utf-8")
    ).hexdigest()
    if MODEL_PATH.exists():
        current = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
        title = current.get("titleManifold") or {}
        if title.get("sourceHash") == source_hash:
            return title
    model = PCA(n_components=8, svd_solver="randomized", random_state=1729,
                iterated_power=4)
    model.fit(np.asarray(vectors, np.float32))
    return {
        "method": "randomized PCA over every current unit-normalized Long Quant title vector",
        "randomState": 1729,
        "dimensions": 8,
        "sourceRows": int(vectors.shape[0]),
        "sourceDimensions": int(vectors.shape[1]),
        "sourceHash": source_hash,
        "sourceUpdated": mapping.get("updated"),
        "mean": model.mean_.astype(float).tolist(),
        "components": model.components_.astype(float).tolist(),
        "scale": np.sqrt(np.maximum(model.explained_variance_, 1e-9)).astype(float).tolist(),
        "explainedVarianceRatio": model.explained_variance_ratio_.astype(float).tolist(),
        "outcomesUsed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    manifest = load("all-span-manifest.json")
    store_state = load("all-span-vectors/state.json")
    corpus = load("corpus.json")
    partition_artifact = load("canonical-partitions.json")
    partition_model = load("canonical-partition-model.json")
    outcomes_artifact = load("hook-outcomes.json")
    outcome_model = load("hook-outcome-model.json")
    corpus_by_id = {row["id"]: row for row in corpus["rows"]}
    partition_by_id = {row["videoId"]: row for row in partition_artifact["rows"]}
    outcome_by_id = {row["videoId"]: row for row in outcomes_artifact["hooks"]}
    specs = manifest["hooks"][:args.limit or None]
    manifest_rows = manifest["rows"]

    arrays = {
        name: np.load(STORE / f"{name}.npy", mmap_mode="r")
        for name in ("raw", "context", "influence", "nonadditive")
    }
    full = np.load(STORE / "full.npy", mmap_mode="r")
    title_manifold = fit_title_manifold()

    transition_null = []
    for spec in manifest["hooks"]:
        begin = int(spec["spanOffset"]); end = begin + int(spec["spanCount"])
        rows = manifest_rows[begin:end]
        transition_null.extend(prefix_transition_distances(
            np.asarray(arrays["raw"][begin:end], np.float32),
            np.asarray([row["start"] for row in rows], int),
            np.asarray([row["end"] for row in rows], int),
            int(spec["tokenCount"]),
        ).astype(float).tolist())
    transition_null = np.sort(np.asarray(transition_null, np.float32))
    transition_null_hash = hashlib.sha256(transition_null.tobytes()).hexdigest()
    partition_model_hash = hashlib.sha256(json.dumps(
        partition_model, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()

    titles = [str(corpus_by_id[spec["videoId"]].get("title") or "").strip() for spec in specs]
    embedding_store = EmbeddingStore(CACHE / "hook-live-embeddings.sqlite3")
    try:
        title_vectors = embedding_store.embed_many([value for value in titles if value])
    finally:
        embedding_store.close()

    model_artifact = {
        "version": 1, "status": "complete", "methodVersion": LATTICE_VERSION,
        "embeddingModel": MODEL, "embeddingDimensions": DIMENSIONS,
        "titleManifold": title_manifold,
        "prefixTransitionNullSorted": transition_null.astype(float).tolist(),
        "prefixTransitionNullRows": int(len(transition_null)),
        "prefixTransitionNullHash": transition_null_hash,
        "prefixTransitionNullOutcomesUsed": False,
        "allSpanStoreVersion": store_state.get("version"),
        "allSpanRepresentationVersion": store_state.get("representationVersion"),
        "allSpanCorpusFingerprint": store_state.get("corpusFingerprint"),
        "partitionModelHash": partition_model_hash,
        "speakingRate": outcome_model.get("speakingRate"),
        "resolutionDefinitions": RESOLUTION_DEFINITIONS,
        "parityContract": {
            "builder": "component_lattice.build_component_lattice",
            "corpusRunner": "run_component_lattice.py",
            "predictor": "score_hook.py",
            "shared": True,
            "representationVersion": store_state.get("representationVersion"),
            "trainingVectorStorageDtype": "float16",
            "predictorQuantizesBeforeDerivedRepresentations": True,
        },
    }
    atomic_json(MODEL_PATH, model_artifact)

    started = time.time()
    r2 = None if args.no_upload else R2Store()
    rows = []
    edge_totals = Counter(); resolution_totals = Counter(); rejected_total = 0
    map_definitions = {}
    DETAILS.mkdir(parents=True, exist_ok=True)
    for position, spec in enumerate(specs):
        video_id = spec["videoId"]
        detail_path = DETAILS / f"{video_id}.json.gz"
        begin = int(spec["spanOffset"]); finish = begin + int(spec["spanCount"])
        source_rows = manifest_rows[begin:finish]
        partition = partition_by_id[video_id]
        outcome = outcome_by_id[video_id]
        source = corpus_by_id[video_id]
        media_alignment = load_media_alignment(video_id, CACHE)
        alignment_contract = {
            "mediaAligned": True,
            "timingExact": False,
            "boundaryEstimator": media_alignment.get("methodVersion"),
            "alignmentConfidence": (media_alignment.get("alignment") or {}).get(
                "confidenceBand"
            ),
            "timingResolutionSeconds": (media_alignment.get("alignment") or {}).get(
                "secondsPerCtcFrame"
            ),
            "claimBoundary": (media_alignment.get("timingContract") or {}).get(
                "claimBoundary"
            ),
        }
        title = str(source.get("title") or "").strip()
        content_key = hashlib.sha256(json.dumps({
            "version": LATTICE_VERSION,
            "embeddingModel": MODEL,
            "text": partition["text"],
            "title": title,
            "titleManifoldSourceHash": title_manifold["sourceHash"],
            "allSpanStoreVersion": store_state.get("version"),
            "allSpanRepresentationVersion": store_state.get("representationVersion"),
            "allSpanCorpusFingerprint": store_state.get("corpusFingerprint"),
            "partitionModelHash": partition_model_hash,
            "partition": partition,
            "timing": {
                "policy": (outcome.get("retentionForecast") or {}).get("wordTimingPolicy"),
                "words": (outcome.get("retentionForecast") or {}).get("words"),
                "mediaAlignmentInputKey": media_alignment.get("inputKey"),
                "contract": alignment_contract,
            },
            "storedOutcome": outcome,
            "prefixTransitionNullHash": transition_null_hash,
        }, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
        detail = None
        if detail_path.exists() and not args.rebuild:
            with gzip.open(detail_path, "rt", encoding="utf-8") as handle:
                existing = json.load(handle)
            if existing.get("buildContentKey") == content_key:
                detail = existing
        if detail is None:
            detail = build_component_lattice(
                text=partition["text"], tokens=tokenize(partition["text"]),
                starts=np.asarray([row["start"] for row in source_rows], int),
                ends=np.asarray([row["end"] for row in source_rows], int),
                raw=np.asarray(arrays["raw"][begin:finish], np.float32),
                context=np.asarray(arrays["context"][begin:finish], np.float32),
                influence=np.asarray(arrays["influence"][begin:finish], np.float32),
                nonadditive=np.asarray(arrays["nonadditive"][begin:finish], np.float32),
                full=np.asarray(full[int(spec["hookIndex"])], np.float32),
                partition=partition, partition_model=partition_model,
                timing_words=(outcome.get("retentionForecast") or {}).get("words"),
                timing_policy=(outcome.get("retentionForecast") or {}).get("wordTimingPolicy"),
                timing_metadata=alignment_contract,
                words_per_second=float((outcome_model.get("speakingRate") or {}).get("meanWordsPerSecond") or 1),
                prefix_transition_null=transition_null,
                idea_text=title, idea_vector=title_vectors.get(title),
                title_manifold=title_manifold, stored_outcome=outcome,
                source_kind="stored-corpus", video_id=video_id, global_span_offset=begin,
            )
            detail["title"] = title
            detail["url"] = source.get("url")
            detail["buildContentKey"] = content_key
            detail["sourceRecord"] = {
                "views": source.get("views"), "keepRate": source.get("keep_rate"),
                "averageRetention": source.get("avg_retention"),
                "hookEndSeconds": source.get("hookEndSec"),
            }
            atomic_gzip_json(detail_path, detail)
        edge_totals.update(detail["edgeCounts"])
        map_definitions = map_definitions or detail.get("mapDefinitions") or {}
        resolution_totals.update(detail["resolutionCounts"])
        rejected_total += int((detail.get("rejectedCandidates") or {}).get("total") or 0)
        row = {
            "videoId": video_id, "title": title, "text": partition["text"],
            "tokenCount": detail["tokenCount"], "spanCount": detail["spanCount"],
            "edgeCount": len(detail["edges"]), "edgeCounts": detail["edgeCounts"],
            "resolutionCounts": detail["resolutionCounts"],
            "rejectedCandidates": detail["rejectedCandidates"]["total"],
            "timingSource": detail["timingContract"]["source"],
            "ideaAnchorPresent": detail["ideaAnchor"]["present"],
            "detail": f"/api/longquant/promise-lab/component-lattice/{video_id}",
            "contentHash": detail["contentHash"],
        }
        rows.append(row)
        if r2:
            r2.put_bytes(
                f"{R2_PREFIX}/component-lattice/{video_id}.json.gz",
                detail_path.read_bytes(), "application/json", "gzip",
            )
        print(f"[{position + 1}/{len(specs)}] {video_id}: {row['spanCount']} nodes, {row['edgeCount']} edges", flush=True)

    summary = {
        "version": 1, "status": "complete", "stage": "multi-resolution component lattice",
        "methodVersion": LATTICE_VERSION, "hookCount": len(rows),
        "spanCount": sum(row["spanCount"] for row in rows),
        "edgeCount": sum(row["edgeCount"] for row in rows),
        "edgeCounts": dict(edge_totals), "resolutionCounts": dict(resolution_totals),
        "rejectedCandidateCount": rejected_total,
        "embeddingModel": MODEL, "embeddingDimensions": DIMENSIONS,
        "representationVersion": store_state.get("representationVersion"),
        "titleManifold": {
            key: title_manifold[key] for key in (
                "method", "dimensions", "sourceRows", "sourceDimensions", "sourceHash",
                "explainedVarianceRatio", "outcomesUsed",
            )
        },
        "prefixTransitionNullRows": int(len(transition_null)),
        "prefixTransitionOutcomesUsed": False,
        "resolutionDefinitions": RESOLUTION_DEFINITIONS,
        "mapDefinitions": map_definitions,
        "parityContract": model_artifact["parityContract"],
        "graphContract": {
            "edgeFamilies": ["containment", "sequence", "semantic", "context", "title", "outcome"],
            "structuralEdgeOutcomesUsed": False,
            "storedOutcomeEdges": "source-held-out only",
            "liveOutcomeEdges": "inference-only; never self-evaluated",
        },
        "rows": rows,
        "elapsedSeconds": round(time.time() - started, 2),
    }
    atomic_json(SUMMARY_PATH, summary)
    if r2:
        r2.put_json(f"{R2_PREFIX}/component-lattice.json.gz", summary, gzip_payload=True)
        r2.put_json(f"{R2_PREFIX}/component-lattice-model.json.gz", model_artifact, gzip_payload=True)
    print(json.dumps({
        "hooks": summary["hookCount"], "spans": summary["spanCount"],
        "edges": summary["edgeCount"], "elapsedSeconds": summary["elapsedSeconds"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
