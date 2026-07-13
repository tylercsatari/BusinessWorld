#!/usr/bin/env python3
"""Materialize every contiguous hook span into a resumable primitive vector store."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

import numpy as np

from atlas import (
    REPRESENTATIONS,
    REPRESENTATION_VERSION,
    component_id,
    representation_matrix,
)
from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, EmbeddingStore, R2Store
from interventions import INTERVENTION_VERSION, build_tensor, make_plan


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
STORE_DIR = CACHE / "all-span-vectors"
ROWS_DIR = STORE_DIR / "rows"
STATE_PATH = STORE_DIR / "state.json"
MANIFEST_PATH = CACHE / "all-span-manifest.json"
STORE_VERSION = "all-contiguous-spans-exact-offset-v2"
MIGRATABLE_STORE_VERSIONS = {"all-contiguous-spans-exact-offset-v1"}


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def corpus_fingerprint(rows: list[dict]) -> str:
    payload = "\n".join(f"{row['id']}\0{row['hookText']}" for row in rows)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def open_array(name: str, shape: tuple[int, ...], dtype) -> np.memmap:
    path = STORE_DIR / f"{name}.npy"
    mode = "r+" if path.exists() else "w+"
    return np.lib.format.open_memmap(path, mode=mode, dtype=dtype, shape=shape)


def migrate_primitive_store(state: dict, hook_specs: list[dict]) -> dict:
    """Repair derived views from persisted source vectors without new API calls."""
    if state.get("version") not in MIGRATABLE_STORE_VERSIONS:
        return state
    expected_ids = {str(spec["videoId"]) for spec in hook_specs}
    if set(state.get("completedVideoIds") or []) != expected_ids:
        raise RuntimeError("cannot migrate an incomplete all-span store")
    source_paths = [
        STORE_DIR / "full.npy", STORE_DIR / "context.npy",
        STORE_DIR / "span-start.npy", STORE_DIR / "span-end.npy",
    ]
    if any(not path.exists() for path in source_paths):
        raise RuntimeError("cannot migrate all-span store without persisted source vectors")

    full = np.load(STORE_DIR / "full.npy", mmap_mode="r")
    context = np.load(STORE_DIR / "context.npy", mmap_mode="r")
    starts = np.load(STORE_DIR / "span-start.npy", mmap_mode="r")
    ends = np.load(STORE_DIR / "span-end.npy", mmap_mode="r")
    temporary_paths = {
        name: STORE_DIR / f".{name}-{REPRESENTATION_VERSION}.npy"
        for name in ("influence", "nonadditive")
    }
    outputs = {
        name: np.lib.format.open_memmap(
            path, mode="w+", dtype=np.float16, shape=context.shape,
        )
        for name, path in temporary_paths.items()
    }
    for position, spec in enumerate(hook_specs, 1):
        begin = int(spec["spanOffset"])
        finish = begin + int(spec["spanCount"])
        local_starts = np.asarray(starts[begin:finish], int)
        local_ends = np.asarray(ends[begin:finish], int)
        lookup = {
            (int(start), int(end)): index
            for index, (start, end) in enumerate(zip(local_starts, local_ends))
        }
        hook_full = np.asarray(full[int(spec["hookIndex"])], np.float32)
        hook_context = np.asarray(context[begin:finish], np.float32)
        token_effects = np.asarray([
            hook_full - hook_context[lookup[(token, token + 1)]]
            for token in range(int(spec["tokenCount"]))
        ], np.float32)
        tensor = {
            "full": hook_full,
            "span_context": hook_context,
            "span_start": local_starts,
            "span_end": local_ends,
            "token_effects": token_effects,
        }
        for name, output in outputs.items():
            output[begin:finish] = representation_matrix(name, tensor).astype(np.float16)
        if position % 25 == 0 or position == len(hook_specs):
            print(
                f"migrated derived span representations {position}/{len(hook_specs)}",
                flush=True,
            )
    for output in outputs.values():
        output.flush()
    del outputs
    for name, temporary in temporary_paths.items():
        os.replace(temporary, STORE_DIR / f"{name}.npy")
    migrated = {
        **state,
        "version": STORE_VERSION,
        "representationVersion": REPRESENTATION_VERSION,
        "migratedFrom": state.get("version"),
        "migrationMethod": (
            "recomputed influence and nonadditive from persisted float16 full/context "
            "vectors using direct segment sums; no embedding API calls"
        ),
    }
    atomic_json(STATE_PATH, migrated)
    return migrated


def publish_progress(r2: R2Store | None, value: dict) -> None:
    payload = {**value, "updatedAt": int(time.time() * 1000)}
    atomic_json(CACHE / "progress.json", payload)
    if r2:
        r2.put_json(f"{R2_PREFIX}/progress.json", payload)


def candidate_lookup(video_id: str) -> dict[tuple[int, int], dict]:
    path = CACHE / "discovery" / f"{video_id}.json"
    if not path.exists():
        return {}
    discovery = json.loads(path.read_text(encoding="utf-8"))
    return {
        (int(row["start"]), int(row["end"])): row
        for row in discovery.get("candidates") or []
    }


def compact_support(row: dict | None) -> dict | None:
    if not row:
        return None
    fields = (
        "frequency", "nullFrequency", "aboveNullFrequency", "calibratedZ",
        "calibratedP", "calibratedQ", "methods",
    )
    return {field: row.get(field) for field in fields if field in row}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    if args.limit:
        corpus = corpus[:args.limit]
    fingerprint = corpus_fingerprint(corpus)
    hook_specs = []
    offset = 0
    for hook_index, hook in enumerate(corpus):
        plan = make_plan(hook["hookText"])
        count = len(plan.spans)
        hook_specs.append({
            "hookIndex": hook_index,
            "videoId": hook["id"],
            "title": hook.get("title") or "",
            "text": plan.text,
            "tokenCount": len(plan.tokens),
            "spanOffset": offset,
            "spanCount": count,
        })
        offset += count
    total_spans = offset

    if args.force and STORE_DIR.exists():
        shutil.rmtree(STORE_DIR)
    existing_state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.exists() else None
    if existing_state and existing_state.get("version") in MIGRATABLE_STORE_VERSIONS:
        migration_compatible = (
            existing_state.get("corpusFingerprint") == fingerprint
            and int(existing_state.get("spanInstances") or 0) == total_spans
            and existing_state.get("embeddingModel") == MODEL
            and int(existing_state.get("embeddingDimensions") or 0) == DIMENSIONS
            and existing_state.get("interventionVersion") == INTERVENTION_VERSION
        )
        if not migration_compatible:
            raise RuntimeError("legacy all-span store cannot be migrated for this corpus")
        existing_state = migrate_primitive_store(existing_state, hook_specs)
    if existing_state and (
        existing_state.get("version") != STORE_VERSION or
        existing_state.get("corpusFingerprint") != fingerprint or
        int(existing_state.get("spanInstances") or 0) != total_spans or
        existing_state.get("embeddingModel") != MODEL or
        int(existing_state.get("embeddingDimensions") or 0) != DIMENSIONS or
        existing_state.get("interventionVersion") != INTERVENTION_VERSION or
        existing_state.get("representationVersion") != REPRESENTATION_VERSION
    ):
        raise RuntimeError("all-span store does not match this corpus; rerun with --force")

    STORE_DIR.mkdir(parents=True, exist_ok=True)
    ROWS_DIR.mkdir(parents=True, exist_ok=True)
    arrays = {
        name: open_array(name, (total_spans, DIMENSIONS), np.float16)
        for name in REPRESENTATIONS
    }
    full = open_array("full", (len(corpus), DIMENSIONS), np.float16)
    hook_index_array = open_array("hook-index", (total_spans,), np.int16)
    span_start_array = open_array("span-start", (total_spans,), np.int16)
    span_end_array = open_array("span-end", (total_spans,), np.int16)

    state = existing_state or {
        "version": STORE_VERSION,
        "corpusFingerprint": fingerprint,
        "spanInstances": total_spans,
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "interventionVersion": INTERVENTION_VERSION,
        "representationVersion": REPRESENTATION_VERSION,
        "completedVideoIds": [],
        "embeddingTextsMaterialized": 0,
    }
    completed = set(state.get("completedVideoIds") or [])
    r2 = None if args.no_upload else R2Store()
    embedding_store = EmbeddingStore(CACHE / "embeddings.sqlite3")
    started = time.time()

    publish_progress(r2, {
        "version": 4,
        "status": "running",
        "stage": "embedding every contiguous span",
        "scope": "all-contiguous-spans",
        "hooksTotal": len(corpus),
        "hooksComplete": len(completed),
        "spanInstances": total_spans,
        "semanticRules": 0,
    })

    try:
        for spec, hook in zip(hook_specs, corpus):
            video_id = spec["videoId"]
            rows_path = ROWS_DIR / f"{video_id}.json"
            if video_id in completed and rows_path.exists():
                print(f"[{spec['hookIndex'] + 1}/{len(corpus)}] {video_id}: resumed", flush=True)
                continue

            plan = make_plan(hook["hookText"])
            vectors = embedding_store.embed_many(plan.required_texts)
            tensor, metadata = build_tensor(plan, vectors)
            begin = int(spec["spanOffset"])
            end = begin + int(spec["spanCount"])
            stored_full = np.asarray(tensor["full"], np.float16)
            stored_context = representation_matrix("context", tensor).astype(np.float16)
            arrays["raw"][begin:end] = representation_matrix("raw", tensor).astype(np.float16)
            arrays["context"][begin:end] = stored_context
            full[spec["hookIndex"]] = stored_full
            stored_full32 = np.asarray(stored_full, np.float32)
            stored_context32 = np.asarray(stored_context, np.float32)
            span_lookup = {
                (int(start), int(finish)): index
                for index, (start, finish) in enumerate(
                    zip(tensor["span_start"], tensor["span_end"])
                )
            }
            derived_tensor = {
                "full": stored_full32,
                "span_context": stored_context32,
                "span_start": tensor["span_start"],
                "span_end": tensor["span_end"],
                "token_effects": np.asarray([
                    stored_full32 - stored_context32[span_lookup[(token, token + 1)]]
                    for token in range(len(plan.tokens))
                ], np.float32),
            }
            for name in ("influence", "nonadditive"):
                arrays[name][begin:end] = representation_matrix(
                    name, derived_tensor,
                ).astype(np.float16)
            for array in arrays.values():
                array.flush()
            full.flush()
            hook_index_array[begin:end] = spec["hookIndex"]
            span_start_array[begin:end] = tensor["span_start"]
            span_end_array[begin:end] = tensor["span_end"]
            hook_index_array.flush()
            span_start_array.flush()
            span_end_array.flush()

            support = candidate_lookup(video_id)
            rows = []
            for span in metadata["spans"]:
                start = int(span["start"])
                finish = int(span["end"])
                support_row = support.get((start, finish))
                rows.append({
                    "id": component_id(video_id, start, finish),
                    "videoId": video_id,
                    "hookIndex": spec["hookIndex"],
                    "start": start,
                    "end": finish,
                    "tokenCount": finish - start,
                    "charStart": int(metadata["tokens"][start]["start"]),
                    "charEnd": int(metadata["tokens"][finish - 1]["end"]),
                    "text": span["text"],
                    "boundarySupported": bool(support_row),
                    "boundaryEvidence": compact_support(support_row),
                })
            atomic_json(rows_path, {
                "videoId": video_id,
                "spanOffset": begin,
                "spanCount": len(rows),
                "rows": rows,
            })

            completed.add(video_id)
            state["completedVideoIds"] = sorted(completed)
            state["embeddingTextsMaterialized"] = int(
                state.get("embeddingTextsMaterialized") or 0
            ) + len(plan.required_texts)
            atomic_json(STATE_PATH, state)
            embedding_store.delete_texts(plan.required_texts)
            elapsed = max(.001, time.time() - started)
            publish_progress(r2, {
                "version": 4,
                "status": "running",
                "stage": "embedding every contiguous span",
                "scope": "all-contiguous-spans",
                "hooksTotal": len(corpus),
                "hooksComplete": len(completed),
                "currentHook": video_id,
                "spanInstances": total_spans,
                "spansWritten": end,
                "embeddingTextsMaterialized": state["embeddingTextsMaterialized"],
                "hooksPerMinute": round((len(completed) / elapsed) * 60, 3),
                "semanticRules": 0,
            })
            print(
                f"[{spec['hookIndex'] + 1}/{len(corpus)}] {video_id}: "
                f"{len(plan.tokens)} atoms, {len(plan.spans)} contiguous spans, "
                f"{len(plan.required_texts)} exact inputs",
                flush=True,
            )

        all_rows = []
        for spec in hook_specs:
            rows_payload = json.loads(
                (ROWS_DIR / f"{spec['videoId']}.json").read_text(encoding="utf-8")
            )
            if int(rows_payload.get("spanCount") or 0) != int(spec["spanCount"]):
                raise RuntimeError(f"span row count mismatch for {spec['videoId']}")
            all_rows.extend(rows_payload["rows"])
        if len(all_rows) != total_spans:
            raise RuntimeError("compiled all-span manifest has the wrong row count")

        manifest = {
            "version": 4,
            "status": "complete",
            "scope": "all-contiguous-spans",
            "storeVersion": STORE_VERSION,
            "interventionVersion": INTERVENTION_VERSION,
            "representationVersion": REPRESENTATION_VERSION,
            "embeddingModel": MODEL,
            "embeddingDimensions": DIMENSIONS,
            "enumeration": "every contiguous interval in the observed token sequence",
            "semanticRules": 0,
            "outcomesUsed": False,
            "positionAndLengthUsedForEmbedding": False,
            "hooks": hook_specs,
            "hookCount": len(hook_specs),
            "spanInstances": total_spans,
            "boundarySupportedInstances": sum(bool(row["boundarySupported"]) for row in all_rows),
            "embeddingTextsMaterialized": state["embeddingTextsMaterialized"],
            "primitiveRepresentations": list(REPRESENTATIONS),
            "rows": all_rows,
        }
        atomic_json(MANIFEST_PATH, manifest)
        publish_progress(r2, {
            "version": 4,
            "status": "running",
            "stage": "all contiguous spans embedded; multi-resolution atlas next",
            "scope": "all-contiguous-spans",
            "hooksTotal": len(corpus),
            "hooksComplete": len(corpus),
            "spanInstances": total_spans,
            "boundarySupportedInstances": manifest["boundarySupportedInstances"],
            "embeddingTextsMaterialized": state["embeddingTextsMaterialized"],
            "semanticRules": 0,
        })
        if r2:
            r2.put_json(f"{R2_PREFIX}/all-span-manifest.json.gz", manifest, gzip_payload=True)
        embedding_store.clear_and_compact()
        print(json.dumps({
            "hooks": len(corpus),
            "spanInstances": total_spans,
            "boundarySupportedInstances": manifest["boundarySupportedInstances"],
            "embeddingTextsMaterialized": state["embeddingTextsMaterialized"],
        }, indent=2), flush=True)
    except Exception as exc:
        publish_progress(r2, {
            "version": 4,
            "status": "error",
            "stage": "embedding every contiguous span",
            "scope": "all-contiguous-spans",
            "hooksTotal": len(corpus),
            "hooksComplete": len(completed),
            "spanInstances": total_spans,
            "error": str(exc),
            "semanticRules": 0,
        })
        raise
    finally:
        embedding_store.close()


if __name__ == "__main__":
    main()
