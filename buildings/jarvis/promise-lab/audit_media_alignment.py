#!/usr/bin/env python3
"""Add an independent ASR word-clock audit to every CTC alignment."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

from media_alignment import (
    MEDIA_ALIGNMENT_HORIZON_SECONDS,
    file_sha256,
    sha256_json,
    timing_endpoint_reference_audit,
    timing_reference_audit,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
ALIGNMENT_DIR = CACHE / "media-alignment"
REFERENCE_CACHE_DIR = CACHE / "media-alignment-whisper-reference"
SUMMARY_PATH = CACHE / "media-alignment.json"
AUDIT_KEY = "independentWhisperBaseWords"
AUDIT_ALGORITHM_VERSION = "independent-whisper-word-clock-v3"


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ),
        encoding="ascii",
    )
    os.replace(temporary, path)


def flatten_whisper_words(result: dict) -> list[dict]:
    words = []
    for segment in result.get("segments") or []:
        for source in segment.get("words") or []:
            text = str(source.get("word") or "").strip()
            start = float(source.get("start") or 0)
            end = float(source.get("end") or start)
            if not text or start >= MEDIA_ALIGNMENT_HORIZON_SECONDS or end <= start:
                continue
            words.append({
                "w": text,
                "t": start,
                "d": max(0.001, min(end, MEDIA_ALIGNMENT_HORIZON_SECONDS) - start),
                "probability": (
                    float(source["probability"])
                    if source.get("probability") is not None else None
                ),
            })
    if not words:
        raise RuntimeError("independent Whisper audit returned no word intervals")
    return words


def resolve_source(record: dict) -> Path:
    path = Path(record["source"]["path"])
    return path if path.is_absolute() else ROOT / path


def audit_payload(candidate_words: list[dict], reference_words: list[dict],
                  input_key: str, model_name: str, model_hash: str,
                  free_decode_text: str,
                  endpoint_audit: dict | None = None) -> dict:
    payload = {
        **timing_reference_audit(candidate_words, reference_words),
        "auditInputKey": input_key,
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "algorithm": "independent Whisper free-decode word timestamps",
        "model": model_name,
        "modelSha256": model_hash,
        "forcedCanonicalTextUsed": False,
        "outcomesUsed": False,
        "semanticLabelsUsed": False,
        "role": "independent acoustic boundary agreement; not ground truth",
        "freeDecodeText": free_decode_text,
        "referenceWordIntervals": reference_words,
    }
    if endpoint_audit is not None:
        payload["finalWordMatched"] = bool(endpoint_audit["endpointMatched"])
        payload["finalMatchedWordEndAbsoluteErrorSeconds"] = endpoint_audit[
            "endpointAbsoluteErrorSeconds"
        ]
        payload["finalEndpointAudit"] = endpoint_audit
    return payload


def reference_cache_path(video_id: str, source_hash: str,
                         model_hash: str) -> Path:
    return REFERENCE_CACHE_DIR / (
        f"{video_id}-{source_hash[:16]}-{model_hash[:16]}.json"
    )


def cached_reference(path: Path, source_hash: str, model_name: str,
                     model_hash: str) -> tuple[list[dict], str] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        payload.get("sourceSha256") != source_hash
        or payload.get("model") != model_name
        or payload.get("modelSha256") != model_hash
        or float(payload.get("horizonSeconds") or 0)
        != MEDIA_ALIGNMENT_HORIZON_SECONDS
    ):
        return None
    words = payload.get("referenceWordIntervals") or []
    if not words:
        return None
    return words, str(payload.get("freeDecodeText") or "")


def store_reference(path: Path, source_hash: str, model_name: str,
                    model_hash: str, words: list[dict], text: str) -> None:
    atomic_json(path, {
        "sourceSha256": source_hash,
        "model": model_name,
        "modelSha256": model_hash,
        "horizonSeconds": MEDIA_ALIGNMENT_HORIZON_SECONDS,
        "parameters": {
            "language": "en", "temperature": 0,
            "conditionOnPreviousText": False, "device": "cpu",
        },
        "freeDecodeText": text,
        "referenceWordIntervals": words,
        "outcomesUsed": False,
        "forcedCanonicalTextUsed": False,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id")
    parser.add_argument("--bands", default="high,moderate,low")
    parser.add_argument("--model", default="base")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    selected_bands = {value.strip() for value in args.bands.split(",") if value.strip()}
    paths = sorted(ALIGNMENT_DIR.glob("*.json"))
    records = []
    for path in paths:
        record = json.loads(path.read_text(encoding="utf-8"))
        if args.video_id and str(record["videoId"]) != str(args.video_id):
            continue
        if (
            record["alignment"]["confidenceBand"] in selected_bands
            or (record.get("hookAlignment") or {}).get("confidenceBand") in selected_bands
            or (record.get("hookAlignment") or {}).get("alignmentStrategy")
            == "edit-distance projection onto opening CTC intervals"
        ):
            records.append((path, record))
    if not records:
        raise RuntimeError("no media alignments match the requested independent-audit scope")

    import torch
    import whisper

    os.environ["PYTHONHASHSEED"] = "0"
    torch.manual_seed(0)
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    model = whisper.load_model(args.model, device="cpu")
    checkpoint = Path.home() / ".cache" / "whisper" / f"{args.model}.pt"
    if not checkpoint.exists():
        raise FileNotFoundError(f"Whisper checkpoint is unavailable: {checkpoint}")
    model_hash = file_sha256(checkpoint)

    started = time.time()
    completed = []
    for index, (path, record) in enumerate(records, 1):
        source = resolve_source(record)
        source_hash = record["hashes"]["sourceSha256"]
        free_decode_cache = reference_cache_path(
            str(record["videoId"]), source_hash, model_hash,
        )
        common_audit_input = {
            "algorithmVersion": AUDIT_ALGORITHM_VERSION,
            "sourceSha256": source_hash,
            "primaryAlignmentInputKey": record.get("inputKey"),
            "model": args.model,
            "modelSha256": model_hash,
            "horizonSeconds": MEDIA_ALIGNMENT_HORIZON_SECONDS,
            "parameters": {
                "language": "en", "temperature": 0,
                "conditionOnPreviousText": False, "device": "cpu",
            },
        }
        audit_input_key = sha256_json({
            **common_audit_input,
            "scope": "opening-20s",
            "alignedWordsSha256": sha256_json(record.get("words") or []),
        })
        hook_input_key = sha256_json({
            **common_audit_input,
            "scope": "canonical-hook",
            "openingAlignedWordsSha256": sha256_json(record.get("words") or []),
            "alignedWordsSha256": sha256_json(
                (record.get("hookAlignment") or {}).get("words") or []
            ),
        })
        current = (record["alignment"].get("referenceAudits") or {}).get(AUDIT_KEY)
        hook_current = (
            (record.get("hookAlignment") or {}).get("referenceAudits") or {}
        ).get(AUDIT_KEY)
        main_current = bool(
            current and current.get("auditInputKey") == audit_input_key
        )
        hook_current_valid = bool(
            hook_current and hook_current.get("auditInputKey") == hook_input_key
        )
        reusable_reference = None if args.rebuild else cached_reference(
            free_decode_cache, source_hash, args.model, model_hash,
        )
        if reusable_reference is None and current and current.get(
            "referenceWordIntervals"
        ) and not args.rebuild:
            reusable_reference = (
                current["referenceWordIntervals"],
                str(current.get("freeDecodeText") or ""),
            )
            store_reference(
                free_decode_cache, source_hash, args.model, model_hash,
                reusable_reference[0], reusable_reference[1],
            )
        if main_current and hook_current_valid and not args.rebuild:
            audit = current
            hook_audit = hook_current
        else:
            if reusable_reference is not None:
                reference_words, free_decode_text = reusable_reference
            else:
                result = model.transcribe(
                    str(source), language="en", temperature=0,
                    word_timestamps=True, fp16=False,
                    clip_timestamps=f"0,{MEDIA_ALIGNMENT_HORIZON_SECONDS:g}",
                    condition_on_previous_text=False, verbose=False,
                )
                reference_words = flatten_whisper_words(result)
                free_decode_text = str(result.get("text") or "").strip()
                store_reference(
                    free_decode_cache, source_hash, args.model, model_hash,
                    reference_words, free_decode_text,
                )
            audit = audit_payload(
                record["words"], reference_words, audit_input_key,
                args.model, model_hash, free_decode_text,
            )
            hook_audit = audit_payload(
                record["hookAlignment"]["words"], reference_words, hook_input_key,
                args.model, model_hash, free_decode_text,
                endpoint_audit=timing_endpoint_reference_audit(
                    record["words"], reference_words,
                    int(record["hookAlignment"]["words"][-1]["sourceIndex"]),
                ),
            )
            record["alignment"].setdefault("referenceAudits", {})[AUDIT_KEY] = audit
            record["hookAlignment"].setdefault("referenceAudits", {})[
                AUDIT_KEY
            ] = hook_audit
            record.pop("outputSha256", None)
            record["outputSha256"] = sha256_json(record)
            atomic_json(path, record)
        completed.append(audit)
        print(
            f"[{index}/{len(records)}] {record['videoId']}: "
            f"coverage {float(audit['mappedCoverage']):.1%}, "
            f"median {float(audit['startMedianAbsoluteErrorSeconds']):.3f}s, "
            f"p95 {float(audit['startP95AbsoluteErrorSeconds']):.3f}s; "
            f"hook coverage {float(hook_audit['mappedCoverage']):.1%}, "
            f"median {float(hook_audit['startMedianAbsoluteErrorSeconds']):.3f}s",
            flush=True,
        )

    all_records = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    all_audits = [
        (record["alignment"].get("referenceAudits") or {}).get(AUDIT_KEY)
        for record in all_records
    ]
    all_audits = [audit for audit in all_audits if audit]
    all_hook_audits = [
        ((record.get("hookAlignment") or {}).get("referenceAudits") or {}).get(
            AUDIT_KEY
        ) for record in all_records
    ]
    all_hook_audits = [audit for audit in all_hook_audits if audit]
    hook_endpoint_errors = [
        float(audit["finalMatchedWordEndAbsoluteErrorSeconds"])
        for audit in all_hook_audits
        if audit.get("finalMatchedWordEndAbsoluteErrorSeconds") is not None
    ]
    summary = json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))
    summary["independentWhisperAudit"] = {
        "method": "Whisper free-decode word timestamps compared by ordered lexical alignment",
        "model": args.model,
        "modelSha256": model_hash,
        "auditedVideos": len(all_audits),
        "auditedLowConfidenceVideos": sum(
            record["alignment"]["confidenceBand"] == "low"
            and AUDIT_KEY in (record["alignment"].get("referenceAudits") or {})
            for record in all_records
        ),
        "medianMappedCoverage": float(np.median([
            audit["mappedCoverage"] for audit in all_audits
        ])),
        "medianStartAgreementSeconds": float(np.median([
            audit["startMedianAbsoluteErrorSeconds"] for audit in all_audits
        ])),
        "p95StartAgreementSeconds": float(np.quantile([
            audit["startP95AbsoluteErrorSeconds"] for audit in all_audits
        ], 0.95)),
        "p95Aggregation": (
            "95th percentile across per-video 95th-percentile absolute word-start errors"
        ),
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "outcomesUsed": False,
        "forcedCanonicalTextUsed": False,
        "referenceIsGroundTruth": False,
        "updatedAt": time.time(),
    }
    summary["independentWhisperHookAudit"] = {
        "method": "Whisper free-decode word timestamps compared by ordered lexical alignment",
        "model": args.model,
        "modelSha256": model_hash,
        "auditedVideos": len(all_hook_audits),
        "auditedLowConfidenceVideos": sum(
            record["hookAlignment"]["confidenceBand"] == "low"
            and AUDIT_KEY in (
                record["hookAlignment"].get("referenceAudits") or {}
            ) for record in all_records
        ),
        "auditedEditDistanceProjectionVideos": sum(
            record["hookAlignment"].get("alignmentStrategy")
            == "edit-distance projection onto opening CTC intervals"
            and AUDIT_KEY in (
                record["hookAlignment"].get("referenceAudits") or {}
            ) for record in all_records
        ),
        "medianMappedCoverage": float(np.median([
            audit["mappedCoverage"] for audit in all_hook_audits
        ])),
        "medianStartAgreementSeconds": float(np.median([
            audit["startMedianAbsoluteErrorSeconds"] for audit in all_hook_audits
        ])),
        "p95StartAgreementSeconds": float(np.quantile([
            audit["startP95AbsoluteErrorSeconds"] for audit in all_hook_audits
        ], 0.95)),
        "p95Aggregation": (
            "95th percentile across per-video 95th-percentile absolute word-start errors"
        ),
        "algorithmVersion": AUDIT_ALGORITHM_VERSION,
        "auditedFinalHookEndpoints": len(hook_endpoint_errors),
        "medianFinalHookEndpointAgreementSeconds": (
            float(np.median(hook_endpoint_errors)) if hook_endpoint_errors else None
        ),
        "p95FinalHookEndpointAgreementSeconds": (
            float(np.quantile(hook_endpoint_errors, 0.95))
            if hook_endpoint_errors else None
        ),
        "outcomesUsed": False,
        "forcedCanonicalTextUsed": False,
        "referenceIsGroundTruth": False,
        "updatedAt": time.time(),
    }
    atomic_json(SUMMARY_PATH, summary)
    print(json.dumps({
        **summary["independentWhisperAudit"],
        "elapsedSeconds": time.time() - started,
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
