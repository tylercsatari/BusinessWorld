#!/usr/bin/env python3
"""Verify every Promise Lab media-clock alignment and its provenance contract."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np

from media_alignment import (
    MEDIA_ALIGNMENT_HORIZON_SECONDS,
    MEDIA_ALIGNMENT_VERSION,
    MAXIMUM_SOURCE_CLOCK_OFFSET_SECONDS,
    canonical_hook_words,
    canonical_json,
    normalized_word,
    sha256_json,
    source_timeline_audit,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
ALIGNMENTS = CACHE / "media-alignment"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def expected_words(video_id: str) -> list[dict]:
    analysis = load(ROOT / "video_data" / video_id / "analysis.json")
    output = []
    for canonical_index, row in enumerate(
        ((analysis.get("transcript") or {}).get("words") or [])
    ):
        try:
            timestamp = float(row.get("timestamp"))
        except (TypeError, ValueError):
            continue
        text = str(row.get("word") or "").strip()
        if text and np.isfinite(timestamp) and 0 <= timestamp < MEDIA_ALIGNMENT_HORIZON_SECONDS:
            output.append({
                "canonicalIndex": canonical_index,
                "word": text,
                "timestamp": timestamp,
            })
    return output


def main() -> None:
    corpus = load(CACHE / "corpus.json")["rows"]
    summary = load(CACHE / "media-alignment.json")
    assert summary["status"] == "complete"
    assert summary["methodVersion"] == MEDIA_ALIGNMENT_VERSION
    assert len(corpus) > 0
    assert int(summary["sourceVideos"]) == len(corpus)
    assert int(summary["mediaAlignedVideos"]) == len(corpus)
    assert summary["outcomesUsed"] is False

    bands = Counter()
    hook_bands = Counter()
    hook_lexical_bands = Counter()
    origins = Counter()
    model_hashes = set()
    total_words = 0
    total_hook_words = 0
    hook_estimated_boundary_words = 0
    hook_end_corrections = []
    reference_errors = []
    independent_whisper_audits = []
    independent_whisper_hook_audits = []
    source_clock_offsets = []
    for index, source in enumerate(corpus, 1):
        video_id = str(source["id"])
        path = ALIGNMENTS / f"{video_id}.json"
        record = load(path)
        assert record["videoId"] == video_id
        assert record["methodVersion"] == MEDIA_ALIGNMENT_VERSION
        assert record["alignment"]["outcomesUsed"] is False
        assert record["alignment"]["semanticLabelsUsed"] is False
        assert record["alignment"]["canonicalWordsChanged"] is False
        assert record["timingContract"]["mediaAligned"] is True
        assert record["timingContract"]["timingExact"] is False
        assert record["timingContract"]["clock"] == "source media PCM sample 0"
        hook_alignment = record["hookAlignment"]
        assert hook_alignment["outcomesUsed"] is False
        assert hook_alignment["semanticLabelsUsed"] is False
        assert hook_alignment["legacyTimestampProposalUsedForPlacement"] is False
        assert hook_alignment["confidenceBand"] in {"high", "moderate", "low"}
        assert hook_alignment["lexicalConfidenceBand"] in {"high", "moderate", "low"}
        assert hook_alignment["openingAlignmentConfidenceBand"] == record["alignment"][
            "confidenceBand"
        ]
        confidence_order = {"high": 0, "moderate": 1, "low": 2}
        assert confidence_order[hook_alignment["confidenceBand"]] == max(
            confidence_order[hook_alignment["lexicalConfidenceBand"]],
            confidence_order[hook_alignment["openingAlignmentConfidenceBand"]],
        )
        expected_hook = canonical_hook_words(
            str(source.get("hookText") or ""), source.get("hookEndSec"),
        )
        hook_words = hook_alignment["words"]
        assert len(hook_words) == len(expected_hook) > 0
        assert [normalized_word(row["w"]) for row in hook_words] == [
            normalized_word(row["word"]) for row in expected_hook
        ]
        assert all(
            all(key in row for key in (
                "startBoundaryAcoustic", "endBoundaryAcoustic", "boundaryAcoustic",
            )) for row in hook_words
        )
        assert hook_words[0]["startBoundaryAcoustic"] is True
        assert hook_words[-1]["endBoundaryAcoustic"] is True
        hook_starts = np.asarray([row["t"] for row in hook_words], float)
        hook_ends = hook_starts + np.asarray([row["d"] for row in hook_words], float)
        assert np.isfinite(hook_starts).all() and np.isfinite(hook_ends).all()
        assert (hook_starts >= 0).all() and (hook_ends > hook_starts).all()
        assert (hook_ends <= MEDIA_ALIGNMENT_HORIZON_SECONDS + 1e-9).all()
        assert (hook_ends[:-1] <= hook_starts[1:] + 1e-9).all()
        expected = expected_words(video_id)
        words = record["words"]
        assert len(words) == len(expected) > 0
        assert [row["canonicalIndex"] for row in words] == [
            row["canonicalIndex"] for row in expected
        ]
        assert [normalized_word(row["w"]) for row in words] == [
            normalized_word(row["word"]) for row in expected
        ]
        starts = np.asarray([row["t"] for row in words], float)
        ends = starts + np.asarray([row["d"] for row in words], float)
        assert np.isfinite(starts).all() and np.isfinite(ends).all()
        assert (starts >= 0).all() and (ends > starts).all()
        assert (ends <= MEDIA_ALIGNMENT_HORIZON_SECONDS + 1e-9).all()
        assert (ends[:-1] <= starts[1:] + 1e-9).all()
        assert float(record["source"]["mediaDurationSeconds"]) >= 20.0
        source_path = Path(record["source"]["path"])
        if not source_path.is_absolute():
            source_path = ROOT / source_path
        independent_timeline = source_timeline_audit(source_path)
        assert record["source"].get("timelineAudit", independent_timeline) == independent_timeline
        source_clock_offset = float(
            independent_timeline["audioMinusReferenceStartSeconds"]
        )
        assert abs(source_clock_offset) <= MAXIMUM_SOURCE_CLOCK_OFFSET_SECONDS
        source_clock_offsets.append(source_clock_offset)
        assert 0 < float(record["alignment"]["secondsPerCtcFrame"]) < 0.03
        assert record["alignment"]["confidenceBand"] in {"high", "moderate", "low"}
        canonical_hash = hashlib.sha256(canonical_json(expected)).hexdigest()
        assert record["hashes"]["canonicalWordsSha256"] == canonical_hash
        output_hash = record.pop("outputSha256")
        assert output_hash == sha256_json(record)
        record["outputSha256"] = output_hash
        bands[record["alignment"]["confidenceBand"]] += 1
        hook_bands[hook_alignment["confidenceBand"]] += 1
        hook_lexical_bands[hook_alignment["lexicalConfidenceBand"]] += 1
        origins[record["source"]["origin"]] += 1
        model_hashes.add(record["hashes"]["modelSha256"])
        total_words += len(words)
        total_hook_words += len(hook_words)
        hook_end_corrections.append(float(hook_alignment["hookEndCorrectionSeconds"]))
        hook_estimated_boundary_words += sum(
            not bool(row["boundaryAcoustic"]) for row in hook_words
        )
        for audit in record["alignment"]["referenceAudits"].values():
            value = audit.get("startMedianAbsoluteErrorSeconds")
            if value is not None:
                reference_errors.append(float(value))
        audit = record["alignment"]["referenceAudits"].get(
            "independentWhisperBaseWords"
        )
        assert audit
        assert audit["forcedCanonicalTextUsed"] is False
        assert audit["outcomesUsed"] is False
        assert audit["semanticLabelsUsed"] is False
        assert audit["referenceIsGroundTruth"] is False
        assert audit["referenceWordIntervals"]
        assert 0 < float(audit["mappedCoverage"]) <= 1
        independent_whisper_audits.append(audit)
        hook_audit = (hook_alignment.get("referenceAudits") or {}).get(
            "independentWhisperBaseWords"
        )
        assert hook_audit
        assert hook_audit["forcedCanonicalTextUsed"] is False
        assert hook_audit["outcomesUsed"] is False
        assert hook_audit["semanticLabelsUsed"] is False
        assert hook_audit["referenceIsGroundTruth"] is False
        assert hook_audit["referenceWordIntervals"]
        assert 0 < float(hook_audit["mappedCoverage"]) <= 1
        independent_whisper_hook_audits.append(hook_audit)
        print(f"[{index}/{len(corpus)}] verified {video_id}", flush=True)

    assert dict(bands) == summary["confidenceBands"]
    assert dict(hook_bands) == summary["canonicalHookConfidenceBands"]
    assert dict(hook_lexical_bands) == summary["canonicalHookLexicalConfidenceBands"]
    assert dict(origins) == summary["sourceOrigins"]
    assert total_words == int(summary["canonicalWords"])
    assert total_hook_words == int(summary["canonicalHookWords"])
    assert hook_estimated_boundary_words == int(
        summary["canonicalHookEstimatedBoundaryWords"]
    )
    assert int(summary["canonicalHookAlignedVideos"]) == len(corpus)
    endpoint_summary = summary["canonicalHookEndCorrectionSeconds"]
    absolute_endpoint_corrections = np.abs(np.asarray(hook_end_corrections, float))
    assert np.isclose(
        endpoint_summary["medianAbsolute"],
        np.median(absolute_endpoint_corrections), atol=1e-12,
    )
    assert np.isclose(
        endpoint_summary["p95Absolute"],
        np.quantile(absolute_endpoint_corrections, 0.95), atol=1e-12,
    )
    assert np.isclose(
        endpoint_summary["maximumAbsolute"],
        np.max(absolute_endpoint_corrections), atol=1e-12,
    )
    assert len(model_hashes) == 1
    assert reference_errors
    independent_summary = summary.get("independentWhisperAudit") or {}
    assert len(independent_whisper_audits) == len(corpus)
    assert int(independent_summary["auditedVideos"]) == len(corpus)
    assert int(independent_summary["auditedLowConfidenceVideos"]) == int(
        summary["confidenceBands"].get("low") or 0
    )
    assert independent_summary["outcomesUsed"] is False
    assert independent_summary["forcedCanonicalTextUsed"] is False
    assert independent_summary["referenceIsGroundTruth"] is False
    assert "per-video 95th-percentile" in independent_summary["p95Aggregation"]
    independent_hook_summary = summary.get("independentWhisperHookAudit") or {}
    assert len(independent_whisper_hook_audits) == len(corpus)
    assert int(independent_hook_summary["auditedVideos"]) == len(corpus)
    assert int(independent_hook_summary["auditedLowConfidenceVideos"]) == int(
        summary["canonicalHookConfidenceBands"].get("low") or 0
    )
    assert int(independent_hook_summary["auditedEditDistanceProjectionVideos"]) == sum(
        record.get("canonicalHookAlignmentStrategy")
        == "edit-distance projection onto opening CTC intervals"
        for record in summary["rows"]
    )
    assert independent_hook_summary["outcomesUsed"] is False
    assert independent_hook_summary["forcedCanonicalTextUsed"] is False
    assert independent_hook_summary["referenceIsGroundTruth"] is False
    assert "per-video 95th-percentile" in independent_hook_summary["p95Aggregation"]
    endpoint_agreement_errors = [
        float(audit["finalMatchedWordEndAbsoluteErrorSeconds"])
        for audit in independent_whisper_hook_audits
        if audit.get("finalMatchedWordEndAbsoluteErrorSeconds") is not None
    ]
    assert int(independent_hook_summary["auditedFinalHookEndpoints"]) == len(
        endpoint_agreement_errors
    )
    assert 0 < len(endpoint_agreement_errors) <= len(corpus)
    assert np.isclose(
        float(independent_hook_summary["medianFinalHookEndpointAgreementSeconds"]),
        float(np.median(endpoint_agreement_errors)), atol=1e-12,
    )
    assert np.isclose(
        float(independent_hook_summary["p95FinalHookEndpointAgreementSeconds"]),
        float(np.quantile(endpoint_agreement_errors, 0.95)), atol=1e-12,
    )
    print(json.dumps({
        "status": "verified",
        "videos": len(corpus),
        "canonicalWords": total_words,
        "canonicalHookWords": total_hook_words,
        "canonicalHookEstimatedBoundaryWords": hook_estimated_boundary_words,
        "canonicalHookConfidenceBands": dict(hook_bands),
        "confidenceBands": dict(bands),
        "sourceOrigins": dict(origins),
        "modelHashes": len(model_hashes),
        "allStoredReferenceAudits": len(reference_errors),
        "independentWhisperAudits": len(independent_whisper_audits),
        "independentWhisperHookAudits": len(independent_whisper_hook_audits),
        "medianIndependentWhisperStartAgreementSeconds": float(
            independent_summary["medianStartAgreementSeconds"]
        ),
        "p95IndependentWhisperStartAgreementSeconds": float(
            independent_summary["p95StartAgreementSeconds"]
        ),
        "independentWhisperHookEndpoints": len(endpoint_agreement_errors),
        "medianIndependentWhisperHookEndAgreementSeconds": float(
            independent_hook_summary["medianFinalHookEndpointAgreementSeconds"]
        ),
        "p95IndependentWhisperHookEndAgreementSeconds": float(
            independent_hook_summary["p95FinalHookEndpointAgreementSeconds"]
        ),
        "maximumAbsoluteAudioClockOffsetSeconds": float(
            np.max(np.abs(source_clock_offsets))
        ),
    }, indent=2))


if __name__ == "__main__":
    main()
