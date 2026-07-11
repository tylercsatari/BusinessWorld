#!/usr/bin/env python3
"""Score the complete discovered-component by target-context swap surface."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL, R2_PREFIX, EmbeddingStore, R2Store, json_ready
from swaps import build_dual_scope_swap_plan, crossed_effects
from text_space import METRICS, LongQuantTextSpace


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
RECOMPOSITION_VERSION = "offset-preserving-v2"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(json_ready(value), ensure_ascii=False, separators=(",", ":"),
                                    allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


def rank_percentiles(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, float)
    order = np.argsort(np.argsort(np.where(np.isfinite(values), values, -np.inf)))
    return 100 * order / max(1, len(values) - 1)


def write_gzip_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    raw = json.dumps(json_ready(value), separators=(",", ":"), ensure_ascii=False,
                     allow_nan=False).encode("utf-8")
    temporary.write_bytes(gzip.compress(raw, compresslevel=6))
    os.replace(temporary, path)


def plan_signature(plan: list[dict]) -> str:
    digest = hashlib.sha256()
    for row in plan:
        digest.update(str(row["sourceId"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(row["targetId"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(row["recomposedText"]).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def open_score_arrays(work_dir: Path, row_count: int, signature: str,
                      mode: str, unit_count: int):
    work_dir.mkdir(parents=True, exist_ok=True)
    state_path = work_dir / "state.json"
    state = {}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    resumable = (
        state.get("planSignature") == signature
        and int(state.get("rowCount") or -1) == row_count
        and state.get("mode") == mode
        and int(state.get("unitCount") or -1) == unit_count
        and all((work_dir / f"{metric}-{field}.npy").exists()
                for metric in METRICS for field in ("estimate", "percentile"))
    )
    if not resumable:
        for path in work_dir.glob("*.npy"):
            path.unlink()
        state = {
            "version": 4,
            "planSignature": signature,
            "rowCount": row_count,
            "mode": mode,
            "unitCount": unit_count,
            "nextUnit": 0,
            "uniqueTextsEmbedded": 0,
        }
        atomic_json(state_path, state)
    arrays = {}
    for metric in METRICS:
        for field in ("estimate", "percentile"):
            path = work_dir / f"{metric}-{field}.npy"
            if resumable:
                array = np.load(path, mmap_mode="r+")
            else:
                array = np.lib.format.open_memmap(path, mode="w+", dtype=np.float32,
                                                  shape=(row_count,))
                array[:] = np.nan
                array.flush()
            arrays[(metric, field)] = array
    return arrays, state, state_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit-sources", type=int, default=0)
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--skip-recall-check", action="store_true")
    parser.add_argument("--score-batch", type=int, default=8192)
    parser.add_argument(
        "--upload-intermediates",
        action="store_true",
        help="Also publish the raw plan, matrices, and row-level result archive to R2",
    )
    args = parser.parse_args()
    started = time.time()
    r2 = None if args.no_upload else R2Store()

    atlas = json.loads((CACHE / "atlas.json").read_text(encoding="utf-8"))
    candidates = atlas.get("candidates") or []
    maps = atlas.get("maps") or []
    if not candidates or not maps:
        raise RuntimeError("the outcome-blind atlas must be complete before swaps can run")
    all_span_atlas = json.loads((CACHE / "all-span-atlas.json").read_text(encoding="utf-8"))
    all_span_maps = all_span_atlas.get("maps") or []
    hook_text_by_index = {
        int(row["hookIndex"]): row["text"] for row in all_span_atlas.get("hooks") or []
    }
    all_spans = [
        {**row, "hookText": hook_text_by_index[int(row["hookIndex"])]}
        for row in all_span_atlas.get("spans") or []
    ]
    if not all_spans or not all_span_maps:
        raise RuntimeError("the all-contiguous-span atlas must be complete before swaps can run")
    with np.load(CACHE / "candidate-vectors.npz", allow_pickle=True) as loaded:
        influence = np.asarray(loaded["influence"], np.float32)
    all_span_influence = np.load(
        CACHE / "all-span-vectors" / "influence.npy", mmap_mode="r"
    )
    routing_state = {}
    routing_clock = {"remote": 0.0, "printedMaps": -1, "printedSources": -1}

    def routing_progress(value: dict) -> None:
        routing_state.update(value)
        now = time.time()
        payload = {
            "version": 4,
            "status": "running",
            "stage": "outcome-blind atlas consensus routing",
            **routing_state,
            "updatedAt": int(now * 1000),
        }
        atomic_json(CACHE / "progress.json", payload)
        if r2 and (now - routing_clock["remote"] >= 5
                   or routing_state.get("routingSourcesComplete") == routing_state.get("routingSourcesTotal")):
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)
            routing_clock["remote"] = now
        maps_done = int(routing_state.get("routingMapsComplete") or 0)
        sources_done = int(routing_state.get("routingSourcesComplete") or 0)
        if maps_done and maps_done // 25 != routing_clock["printedMaps"]:
            routing_clock["printedMaps"] = maps_done // 25
            print(f"routing consensus maps {maps_done}/{routing_state.get('routingMapsTotal', 0)}", flush=True)
        if sources_done and sources_done // 100 != routing_clock["printedSources"]:
            routing_clock["printedSources"] = sources_done // 100
            print(f"routing source components {sources_done}/{routing_state.get('routingSourcesTotal', 0)}",
                  flush=True)

    cached_summary_path = CACHE / "swap-plan-summary.json"
    cached_plan_path = CACHE / "swap-plan.jsonl.gz"
    score_state_path = CACHE / "swap-score-work" / "state.json"
    cached_summary = (json.loads(cached_summary_path.read_text(encoding="utf-8"))
                      if cached_summary_path.exists() else {})
    score_state = (json.loads(score_state_path.read_text(encoding="utf-8"))
                   if score_state_path.exists() else {})
    can_resume_plan = (
        cached_plan_path.exists()
        and cached_summary.get("planSignature")
        and cached_summary.get("planSignature") == score_state.get("planSignature")
        and int(cached_summary.get("swapRows") or 0) == int(score_state.get("rowCount") or -1)
        and cached_summary.get("embeddingModel") == MODEL
        and int(cached_summary.get("embeddingDimensions") or 0) == DIMENSIONS
        and int(cached_summary.get("atlasMapsContributing") or 0) == len(maps)
        and int(cached_summary.get("allSpanAtlasMapsContributing") or 0) == len(all_span_maps)
        and cached_summary.get("routingUniverse") == "all-contiguous-spans"
        and cached_summary.get("recompositionVersion") == RECOMPOSITION_VERSION
    )
    if can_resume_plan:
        with gzip.open(cached_plan_path, "rt", encoding="utf-8") as handle:
            plan = [json.loads(line) for line in handle if line.strip()]
        if len(plan) != int(score_state["rowCount"]):
            raise RuntimeError("cached swap plan row count does not match its score checkpoint")
        print(f"resumed validated swap plan with {len(plan)} rows", flush=True)
    else:
        plan = build_dual_scope_swap_plan(
            candidates, maps, influence, all_spans, all_span_maps,
            all_span_influence, progress=routing_progress,
        )
    source_ids = list(dict.fromkeys(row["sourceId"] for row in plan))
    if args.limit_sources:
        allowed = set(source_ids[:args.limit_sources])
        plan = [row for row in plan if row["sourceId"] in allowed]
        source_ids = [source_id for source_id in source_ids if source_id in allowed]
    target_ids = sorted(set(row["targetVideoId"] for row in plan))
    source_lookup = {row["id"]: row for row in candidates}
    target_hook_text = {}
    for row in plan:
        target_hook_text[row["targetVideoId"]] = row["targetHookText"]

    unique_texts = []
    unique_positions = {}
    row_to_unique = np.empty(len(plan), np.int32)
    for row_index, row in enumerate(plan):
        text = row["recomposedText"]
        position = unique_positions.get(text)
        if position is None:
            position = len(unique_texts)
            unique_positions[text] = position
            unique_texts.append(text)
        row_to_unique[row_index] = position
    del unique_positions

    expected = len(source_ids) * len(target_ids)
    if len(plan) != expected:
        raise RuntimeError(f"incomplete source-by-target design: {len(plan)} rows, expected {expected}")
    signature = plan_signature(plan)
    plan_meta = {
        "version": 4,
        "status": "planned" if args.plan_only else "running",
        "sourceComponentCount": len(source_ids),
        "targetHookCount": len(target_ids),
        "swapRows": len(plan),
        "uniqueRecomposedTexts": len(unique_texts),
        "identityControlRows": sum(bool(row.get("identityControl")) for row in plan),
        "atlasMapsContributing": len(maps),
        "allSpanAtlasMapsContributing": len(all_span_maps),
        "routingUniverse": "all-contiguous-spans",
        "routingUsesOutcomes": False,
        "sourceSelection": "best nontrivial description-length-adjusted segmentation per hook; exploratory only",
        "targetSelection": "exact self-span identity control for the source video; otherwise equal-scope consensus across evidence-supported and all-contiguous-span atlases with influence cosine only for exact ties",
        "embeddingModel": MODEL,
        "embeddingDimensions": DIMENSIONS,
        "recompositionVersion": RECOMPOSITION_VERSION,
        "planSignature": signature,
    }

    def publish_progress(stage: str, **counts) -> None:
        payload = {
            **plan_meta,
            "status": "running",
            "stage": stage,
            **counts,
            "updatedAt": int(time.time() * 1000),
        }
        atomic_json(CACHE / "progress.json", payload)
        if r2:
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)

    atomic_json(CACHE / "swap-plan-summary.json", plan_meta)
    plan_path = CACHE / "swap-plan.jsonl.gz"
    if not can_resume_plan:
        with gzip.open(plan_path, "wt", encoding="utf-8", compresslevel=6) as handle:
            for row in plan:
                handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
                handle.write("\n")
    print(json.dumps(plan_meta, indent=2), flush=True)
    if args.plan_only:
        return

    scoring_progress = {
        **plan_meta,
        "status": "running",
        "stage": "embedding and scoring discovered-family swaps",
        "uniqueTextsScored": 0,
        "uniqueTextsTotal": len(unique_texts),
        "swapRowsScored": 0,
        "updatedAt": int(time.time() * 1000),
    }
    atomic_json(CACHE / "progress.json", scoring_progress)
    if r2:
        r2.put_json(f"{R2_PREFIX}/progress.json", scoring_progress)
        if args.upload_intermediates:
            r2.put_bytes(f"{R2_PREFIX}/swaps/plan.jsonl.gz", plan_path.read_bytes(),
                         "application/gzip")

    space = LongQuantTextSpace(CACHE / "raw-long-text")
    recall = {"status": "skipped"} if args.skip_recall_check else space.validate_recall()
    if not args.skip_recall_check and recall["recallAt24"] < .95:
        space.index.hnsw.efSearch = 1024
        recall = space.validate_recall()
    if not args.skip_recall_check and recall["recallAt24"] < .95:
        raise RuntimeError(f"Long Quant ANN recall is below the required 0.95: {recall}")
    score_mode = "unique-recomposed-text-v1"
    score_arrays, score_state, score_state_path = open_score_arrays(
        CACHE / "swap-score-work", len(plan), signature, score_mode, len(unique_texts)
    )
    next_unit = min(len(unique_texts), max(0, int(score_state.get("nextUnit") or 0)))
    unique_texts_embedded = int(score_state.get("uniqueTextsEmbedded") or 0)
    store = EmbeddingStore(CACHE / "embeddings.sqlite3")
    scoring_complete = False
    try:
        baseline_texts = [target_hook_text[target] for target in target_ids]
        baseline_vectors = store.embed_many(baseline_texts)
        baseline_query = np.vstack([baseline_vectors[text] for text in baseline_texts]).astype(np.float32)
        baseline_scores = space.score(baseline_query)
        store.delete_texts(baseline_texts)

        for start in range(next_unit, len(unique_texts), max(1, args.score_batch)):
            end = min(len(unique_texts), start + max(1, args.score_batch))
            chunk_texts = unique_texts[start:end]
            vectors = store.embed_many(chunk_texts)
            query = np.vstack([vectors[text] for text in chunk_texts]).astype(np.float32)
            scored = space.score(query)
            row_indices = np.flatnonzero((row_to_unique >= start) & (row_to_unique < end))
            local_positions = row_to_unique[row_indices] - start
            for metric in METRICS:
                for field in ("estimate", "percentile"):
                    score_arrays[(metric, field)][row_indices] = scored[metric][field][local_positions]
                    score_arrays[(metric, field)].flush()
            unique_texts_embedded += len(chunk_texts)
            store.delete_texts(chunk_texts)
            rows_scored = int(np.count_nonzero(row_to_unique < end))
            score_state = {
                "version": 4,
                "planSignature": signature,
                "rowCount": len(plan),
                "mode": score_mode,
                "unitCount": len(unique_texts),
                "nextUnit": end,
                "uniqueTextsEmbedded": unique_texts_embedded,
            }
            atomic_json(score_state_path, score_state)
            scoring_progress = {
                **plan_meta,
                "status": "running",
                "stage": "embedding and scoring discovered-family swaps",
                "swapRowsScored": rows_scored,
                "uniqueTextsScored": end,
                "uniqueTextsTotal": len(unique_texts),
                "updatedAt": int(time.time() * 1000),
            }
            atomic_json(CACHE / "progress.json", scoring_progress)
            if r2:
                r2.put_json(f"{R2_PREFIX}/progress.json", scoring_progress)
            print(f"swap scoring {end}/{len(unique_texts)} unique texts covering "
                  f"{rows_scored}/{len(plan)} rows; transient cache={store.count()}", flush=True)
        scoring_complete = True
    finally:
        if scoring_complete:
            store.clear_and_compact()
        store.close()

    swap_scores = {
        metric: {
            "estimate": score_arrays[(metric, "estimate")],
            "percentile": score_arrays[(metric, "percentile")],
            "source": baseline_scores[metric]["source"],
        }
        for metric in METRICS
    }
    publish_progress(
        "decomposing complete crossed swap matrix",
        swapRowsScored=len(plan),
        swapRows=len(plan),
        uniqueTextsScored=len(unique_texts),
        uniqueTextsTotal=len(unique_texts),
    )

    source_position = {source_id: index for index, source_id in enumerate(source_ids)}
    target_position = {target_id: index for index, target_id in enumerate(target_ids)}
    matrix_arrays = {}
    source_summaries = [{
        "sourceId": source_id,
        "videoId": source_lookup[source_id]["videoId"],
        "text": source_lookup[source_id]["text"],
        "contextText": source_lookup[source_id]["contextText"],
        "segmentationStatus": source_lookup[source_id].get("segmentationStatus"),
        "metrics": {},
    } for source_id in source_ids]
    target_summaries = [{"videoId": target_id, "hookText": target_hook_text[target_id], "metrics": {}}
                        for target_id in target_ids]

    decomposition_by_metric = {}
    for metric in METRICS:
        values = np.full((len(source_ids), len(target_ids)), np.nan, np.float32)
        estimates = np.full_like(values, np.nan)
        for row_index, row in enumerate(plan):
            source_index = source_position[row["sourceId"]]
            target_index = target_position[row["targetVideoId"]]
            values[source_index, target_index] = swap_scores[metric]["percentile"][row_index]
            estimates[source_index, target_index] = swap_scores[metric]["estimate"][row_index]
        baseline = np.asarray(baseline_scores[metric]["percentile"], np.float32)
        decomposition = crossed_effects(values, baseline)
        source_percentiles = rank_percentiles(decomposition["sourceTransferMeanDelta"])
        decomposition_by_metric[metric] = decomposition
        matrix_arrays[f"{metric}_percentile"] = values
        matrix_arrays[f"{metric}_estimate"] = estimates
        matrix_arrays[f"{metric}_baseline"] = baseline
        matrix_arrays[f"{metric}_interaction"] = decomposition["interaction"].astype(np.float32)
        for index, row in enumerate(source_summaries):
            row["metrics"][metric] = {
                "meanDeltaAcrossContexts": float(decomposition["sourceTransferMeanDelta"][index]),
                "transferPercentile": float(source_percentiles[index]),
                "positiveContextRate": float(decomposition["sourcePositiveRate"][index]),
                "contextSensitivity": float(decomposition["sourceContextSensitivity"][index]),
                "sourceEffect": float(decomposition["sourceEffect"][index]),
            }
        for index, row in enumerate(target_summaries):
            row["metrics"][metric] = {
                "baselinePercentile": float(baseline[index]),
                "meanSwapDelta": float(decomposition["targetMeanDelta"][index]),
                "targetEffect": float(decomposition["targetEffect"][index]),
            }

    matrices_path = CACHE / "swap-matrices.npz"
    np.savez_compressed(
        matrices_path,
        source_ids=np.asarray(source_ids, object),
        target_ids=np.asarray(target_ids, object),
        **matrix_arrays,
    )
    detail_path = CACHE / "swap-results.jsonl.gz"
    source_detail_dir = CACHE / "swap-sources"
    source_detail_dir.mkdir(parents=True, exist_ok=True)
    source_summary_lookup = {row["sourceId"]: row for row in source_summaries}
    source_paths = []

    def publish_source(source_id: str, rows: list[dict]) -> None:
        artifact = {
            "version": 4,
            "source": source_summary_lookup[source_id],
            "targets": rows,
            "metricNames": list(METRICS),
        }
        source_path = source_detail_dir / f"{source_id}.json.gz"
        write_gzip_json(source_path, artifact)
        source_paths.append(source_path)
        if len(source_paths) == len(source_ids) or len(source_paths) % 100 == 0:
            publish_progress(
                "materializing per-source swap surfaces",
                sourceDetailsBuilt=len(source_paths),
                sourceDetailsTotal=len(source_ids),
                swapRows=len(plan),
            )

    current_source = None
    current_rows = []
    with gzip.open(detail_path, "wt", encoding="utf-8", compresslevel=6) as detail_file:
        for row_index, row in enumerate(plan):
            detail = {
                **row,
                "scores": {
                    metric: {
                        "estimate": float(swap_scores[metric]["estimate"][row_index]),
                        "percentile": float(swap_scores[metric]["percentile"][row_index]),
                        "baselinePercentile": float(
                            baseline_scores[metric]["percentile"][target_position[row["targetVideoId"]]]
                        ),
                        "deltaFromBaseline": float(
                            swap_scores[metric]["percentile"][row_index]
                            - baseline_scores[metric]["percentile"][target_position[row["targetVideoId"]]]
                        ),
                        "source": swap_scores[metric]["source"],
                    }
                    for metric in METRICS
                },
            }
            detail_file.write(json.dumps(json_ready(detail), separators=(",", ":"),
                                         ensure_ascii=False, allow_nan=False))
            detail_file.write("\n")
            if current_source is not None and row["sourceId"] != current_source:
                publish_source(current_source, current_rows)
                current_rows = []
            current_source = row["sourceId"]
            current_rows.append(detail)
        if current_source is not None:
            publish_source(current_source, current_rows)

    if r2 and source_paths:
        def upload_source(path: Path) -> str:
            source_id = path.name[:-len(".json.gz")]
            r2.put_bytes(f"{R2_PREFIX}/swaps/by-source/{source_id}.json.gz",
                         path.read_bytes(), "application/json", "gzip")
            return source_id

        with ThreadPoolExecutor(max_workers=8) as pool:
            for uploaded, _ in enumerate(pool.map(upload_source, source_paths), 1):
                if uploaded == len(source_paths) or uploaded % 100 == 0:
                    print(f"uploaded source swap details {uploaded}/{len(source_paths)}", flush=True)
                    publish_progress(
                        "publishing per-source swap surfaces",
                        sourceDetailsPublished=uploaded,
                        sourceDetailsTotal=len(source_paths),
                        swapRows=len(plan),
                    )

    summary = {
        **plan_meta,
        "status": "complete",
        "stage": "crossed discovered-family swap surface",
        "embeddingCacheVectors": 0,
        "uniqueRecomposedTextsEmbedded": unique_texts_embedded,
        "longQuantPlacement": {
            "channel": "text",
            "neighbors": space.neighbors,
            "weighting": "positive cosine to the eighth power, matching longquant_score.py",
            "index": "FAISS HNSW inner product over unit-normalized raw-long text vectors",
            "recallValidation": recall,
        },
        "metricNames": list(METRICS),
        "sourceComponents": source_summaries,
        "targetHooks": target_summaries,
        "elapsedSeconds": round(time.time() - started, 2),
    }
    atomic_json(CACHE / "swaps.json", summary)
    if r2:
        r2.put_json(f"{R2_PREFIX}/swaps/summary.json.gz", summary, gzip_payload=True)
        if args.upload_intermediates:
            r2.put_bytes(f"{R2_PREFIX}/swaps/matrices.npz", matrices_path.read_bytes(),
                         "application/octet-stream")
            r2.put_bytes(f"{R2_PREFIX}/swaps/results.jsonl.gz", detail_path.read_bytes(),
                         "application/gzip")
        r2.put_json(f"{R2_PREFIX}/progress.json", {
            "version": 4,
            "status": "running",
            "stage": "swap surface complete; latent-axis search next",
            "sourceComponentCount": len(source_ids),
            "targetHookCount": len(target_ids),
            "swapRows": len(plan),
            "updatedAt": int(time.time() * 1000),
        })
    print(json.dumps({"status": "complete", "swapRows": len(plan), "recall": recall,
                      "elapsedSeconds": summary["elapsedSeconds"]}, indent=2))


if __name__ == "__main__":
    main()
