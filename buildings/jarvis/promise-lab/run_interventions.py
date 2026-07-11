#!/usr/bin/env python3
"""Materialize exhaustive counterfactual tensors for the real hook corpus."""

from __future__ import annotations

import argparse
import io
import json
import os
import time
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, EmbeddingStore, R2Store
from interventions import INTERVENTION_VERSION, build_tensor, make_plan


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
TENSOR_DIR = CACHE / "tensors"
META_DIR = CACHE / "metadata"
PROGRESS_PATH = CACHE / "progress.json"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def save_npz(path: Path, arrays: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp.npz")
    np.savez_compressed(temp, **arrays)
    os.replace(temp, path)


def load_corpus(r2: R2Store) -> list[dict]:
    index = r2.get_json("longform/hook-embeds/index.json", {"rows": []}) or {"rows": []}
    detail_ids = {
        key.rsplit("/", 1)[-1][:-5]
        for key in r2.list_keys("longform/hook-embeds/")
        if key.endswith(".json") and not key.endswith("/index.json")
    }
    rows = []
    for row in index.get("rows") or []:
        video_id = str(row.get("id") or "")
        text = str(row.get("hookText") or "").strip()
        if not video_id or video_id not in detail_ids or not text:
            continue
        rows.append({
            "id": video_id,
            "hookText": text,
            "title": row.get("title") or "",
            "url": row.get("url") or "",
            "published": row.get("published"),
            "views": row.get("views"),
            "keep_rate": row.get("keep_rate"),
            "swiped": row.get("swiped"),
            "avg_retention": row.get("avg_retention"),
            "duration_s": row.get("duration_s"),
            "curve": row.get("curve") or [],
            "hookEndSec": row.get("hookEndSec"),
            "hookEndPct": row.get("hookEndPct"),
            "longQuantMetrics": row.get("metrics") or {},
            "longQuantTextPercentile": row.get("pctile"),
        })
    return rows


def publish_progress(r2: R2Store | None, progress: dict) -> None:
    progress = {**progress, "updatedAt": int(time.time() * 1000)}
    atomic_json(PROGRESS_PATH, progress)
    if r2 is not None:
        r2.put_json(f"{R2_PREFIX}/progress.json", progress)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument(
        "--upload-intermediates",
        action="store_true",
        help="Also publish local tensor/metadata intermediates to R2 (not required by the UI)",
    )
    parser.add_argument("--id", default="")
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    r2 = R2Store()
    corpus = load_corpus(r2)
    if args.id:
        corpus = [row for row in corpus if row["id"] == args.id]
    if args.limit:
        corpus = corpus[:args.limit]
    upload = None if args.no_upload else r2
    store = EmbeddingStore(CACHE / "embeddings.sqlite3")
    keep_embedding_cache = os.environ.get("PROMISE_LAB_KEEP_INTERVENTION_CACHE", "0") == "1"
    if not keep_embedding_cache and any(TENSOR_DIR.glob("*.npz")):
        store.clear_and_compact()

    corpus_artifact = {
        "version": 4,
        "status": "source-frozen",
        "source": "longform/hook-embeds/index.json intersected with complete per-video records",
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "n": len(corpus),
        "rows": corpus,
    }
    atomic_json(CACHE / "corpus.json", corpus_artifact)
    if upload:
        upload.put_json(f"{R2_PREFIX}/corpus.json.gz", corpus_artifact, gzip_payload=True)

    started = time.time()
    completed = 0
    skipped = 0
    total_requests = 0
    total_spans = 0
    total_pairs = 0
    publish_progress(upload, {
        "version": 4,
        "status": "running",
        "stage": "exhaustive context interventions",
        "hooksTotal": len(corpus),
        "hooksComplete": 0,
        "model": MODEL,
        "dimensions": DIMENSIONS,
        "semanticRules": 0,
    })

    try:
        for position, hook in enumerate(corpus, 1):
            video_id = hook["id"]
            tensor_path = TENSOR_DIR / f"{video_id}.npz"
            meta_path = META_DIR / f"{video_id}.json"
            existing_metadata = (json.loads(meta_path.read_text(encoding="utf-8"))
                                 if meta_path.exists() else {})
            if (tensor_path.exists() and meta_path.exists() and not args.force
                    and existing_metadata.get("interventionVersion") == INTERVENTION_VERSION):
                skipped += 1
                completed += 1
                metadata = existing_metadata
                total_requests += int(metadata.get("uniqueEmbeddingTexts") or 0)
                total_spans += len(metadata.get("spans") or [])
                total_pairs += int(metadata.get("pairCount") or 0)
                if upload and args.upload_intermediates:
                    upload.put_bytes(f"{R2_PREFIX}/tensors/{video_id}.npz", tensor_path.read_bytes(),
                                     "application/octet-stream")
                    upload.put_json(f"{R2_PREFIX}/metadata/{video_id}.json", metadata)
                print(f"[{position}/{len(corpus)}] {video_id}: resumed existing tensor", flush=True)
                continue

            plan = make_plan(hook["hookText"])
            vectors = store.embed_many(plan.required_texts)
            arrays, metadata = build_tensor(plan, vectors)
            metadata.update({
                "version": 4,
                "videoId": video_id,
                "sourceTitle": hook.get("title") or "",
                "embeddingModel": MODEL,
                "embeddingDimensions": DIMENSIONS,
                "uniqueEmbeddingTexts": len(plan.required_texts),
                "spanCount": len(plan.spans),
                "tokenPairCount": len(plan.pairs),
                "outcomesUsed": False,
                "interventionVersion": INTERVENTION_VERSION,
            })
            save_npz(tensor_path, arrays)
            atomic_json(meta_path, metadata)
            if upload and args.upload_intermediates:
                upload.put_bytes(f"{R2_PREFIX}/tensors/{video_id}.npz", tensor_path.read_bytes(),
                                 "application/octet-stream")
                upload.put_json(f"{R2_PREFIX}/metadata/{video_id}.json", metadata)
            if not keep_embedding_cache:
                store.delete_texts(plan.required_texts)

            completed += 1
            total_requests += len(plan.required_texts)
            total_spans += len(plan.spans)
            total_pairs += len(plan.pairs)
            elapsed = max(.001, time.time() - started)
            publish_progress(upload, {
                "version": 4,
                "status": "running",
                "stage": "exhaustive context interventions",
                "hooksTotal": len(corpus),
                "hooksComplete": completed,
                "currentHook": video_id,
                "currentPosition": position,
                "embeddingCacheVectors": store.count(),
                "designedEmbeddingTexts": total_requests,
                "spansMaterialized": total_spans,
                "tokenPairsMaterialized": total_pairs,
                "hooksPerMinute": round(completed / elapsed * 60, 3),
                "semanticRules": 0,
            })
            print(
                f"[{position}/{len(corpus)}] {video_id}: {len(plan.tokens)} atoms, "
                f"{len(plan.spans)} spans, {len(plan.pairs)} pairs, "
                f"{len(plan.required_texts)} unique texts, cache={store.count()}",
                flush=True,
            )

        summary = {
            "version": 4,
            "status": "complete",
            "stage": "interventions complete",
            "hooksTotal": len(corpus),
            "hooksComplete": completed,
            "hooksSkippedFromResume": skipped,
            "embeddingCacheVectors": store.count(),
            "embeddingTextsMaterialized": total_requests,
            "designedEmbeddingTexts": total_requests,
            "spansMaterialized": total_spans,
            "tokenPairsMaterialized": total_pairs,
            "semanticRules": 0,
            "elapsedSeconds": round(time.time() - started, 2),
        }
        publish_progress(upload, summary)
        atomic_json(CACHE / "intervention-summary.json", summary)
        if upload:
            upload.put_json(f"{R2_PREFIX}/intervention-summary.json", summary)
        if not keep_embedding_cache:
            store.clear_and_compact()
    except Exception as exc:
        publish_progress(upload, {
            "version": 4,
            "status": "error",
            "stage": "exhaustive context interventions",
            "hooksTotal": len(corpus),
            "hooksComplete": completed,
            "error": str(exc),
            "semanticRules": 0,
        })
        raise
    finally:
        store.close()


if __name__ == "__main__":
    main()
