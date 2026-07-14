#!/usr/bin/env python3
"""Move cached 20-second semantic lattices onto the shared media clock."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from collections import Counter
from pathlib import Path

from component_lattice import (
    _structural_combinations,
    exact_or_estimated_timing,
    resolution_memberships,
    span_timing_interval,
)
from embedding_store import json_ready
from opening_horizon import (
    METHOD_VERSION,
    component_interval,
    component_boundary_support,
    component_measurements,
    curve_payload,
    load_local_opening,
)
from run_opening_horizon import (
    content_key,
    fit_horizon_partition_extension,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
DETAILS = CACHE / "opening-20s"


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def atomic_gzip_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as handle:
        json.dump(
            json_ready(value), handle, separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        )
    os.replace(temporary, path)


def retime_detail(source: dict, detail: dict, opening: dict,
                  current_build_key: str | None = None) -> dict:
    if str(detail.get("text") or "") != str(opening.get("text") or ""):
        raise RuntimeError(f"canonical text changed for {source['id']}")
    existing_tokens = detail.get("tokens") or []
    if len(existing_tokens) != int(opening.get("tokenCount") or 0):
        raise RuntimeError(f"canonical token count changed for {source['id']}")
    timing_metadata = {
        "mediaAligned": opening.get("mediaAligned"),
        "timingExact": opening.get("timingExact"),
        "boundaryEstimator": opening.get("mediaAlignmentMethodVersion"),
        "alignmentConfidence": opening.get("alignmentConfidence"),
        "timingResolutionSeconds": opening.get("timingResolutionSeconds"),
        "claimBoundary": opening.get("timingExactScope"),
    }
    timing, timing_contract = exact_or_estimated_timing(
        existing_tokens, opening.get("timingWords") or [],
        timing_policy=opening.get("timingPolicy"), timing_metadata=timing_metadata,
    )
    if [row["text"] for row in timing] != [row["text"] for row in existing_tokens]:
        raise RuntimeError(f"canonical token surfaces changed for {source['id']}")

    chunks = [{
        "start": int(row["startToken"]), "end": int(row["endToken"]),
    } for row in detail.get("canonicalComponents") or []]
    old_evidence = detail.get("resolutionEvidence") or {}
    change_segments = [
        (int(row[0]), int(row[1]))
        for row in old_evidence.get("changePointSegments") or []
    ]
    memberships, resolution_evidence = resolution_memberships(
        timing, timing, chunks, change_segments,
    )
    for key in ("prefixChangePoints", "changePointFdrAlpha", "changePointNull"):
        if key in old_evidence:
            resolution_evidence[key] = old_evidence[key]

    nodes = detail.get("nodes") or []
    maximum_memberships = max(
        (len(set(values)) for values in memberships.values()), default=1,
    )
    node_lookup = {}
    for node in nodes:
        start = int(node["start"]); end = int(node["end"])
        node_lookup[(start, end)] = node
        interval = span_timing_interval(timing, start, end)
        node["spokenStartSeconds"] = interval["startSeconds"]
        node["spokenEndSeconds"] = interval["endSeconds"]
        node["spokenStartBoundaryAcoustic"] = interval["startBoundaryAcoustic"]
        node["spokenEndBoundaryAcoustic"] = interval["endBoundaryAcoustic"]
        node["outcomeTimingEligible"] = interval["outcomeTimingEligible"]
        node["timingSource"] = timing_contract["source"]
        node["resolutions"] = memberships[(start, end)]
        attention = node.get("descriptiveAttention") or {}
        attention["resolutionSupportFraction"] = (
            len(set(node["resolutions"])) / max(1, maximum_memberships)
        )
        node["descriptiveAttention"] = attention

    node_by_id = {node["id"]: node for node in nodes}
    for edge in detail.get("edges") or []:
        if edge.get("type") != "sequence":
            continue
        left = node_by_id.get(edge.get("source"))
        right = node_by_id.get(edge.get("target"))
        if left is None or right is None:
            raise RuntimeError(f"sequence edge references a missing node for {source['id']}")
        edge["temporalDistanceSeconds"] = float(
            right["spokenStartSeconds"] - left["spokenStartSeconds"]
        )

    media_duration = float(
        opening.get("mediaDurationSeconds") or source.get("duration_s")
    )
    hook_end_seconds = float(
        opening.get("alignedHookEndSeconds")
        or source.get("hookEndSec") or 0
    )
    for component in detail.get("canonicalComponents") or []:
        start, end = component_interval(
            timing, int(component["startToken"]), int(component["endToken"]),
        )
        boundary_support = component_boundary_support(
            timing, int(component["startToken"]), int(component["endToken"]),
        )
        component["spokenStartSeconds"] = start
        component["spokenEndSeconds"] = end
        component.update(boundary_support)
        component["insideOriginalHook"] = bool(
            end <= hook_end_seconds + 1e-9
        )
        component["crossesOriginalHookCut"] = bool(
            start < hook_end_seconds < end
        )
        component["measurements"] = component_measurements(
            component, source.get("curve") or [], media_duration,
        )
        component.pop("opening20sResponse", None)

    opening_keys = (
        "horizonSeconds", "wordCount", "tokenCount", "lexicalTokenCount",
        "spokenStartSeconds", "spokenEndSeconds", "timingPolicy", "timingExact",
        "wordEndPolicy", "sourcePath", "sourceRecord",
        "sourceMediaOrigin", "sourceMediaPath", "sourceTimelineAudit",
        "sourceWordStartTimestampsObserved", "resolvedWordStartsObserved",
        "timestampCollisionGroups", "timestampCollisionWords",
        "resolvedIntervalsNonoverlapping", "wordEndsObserved",
        "tokenToSourceWordSequenceCover", "timingExactScope", "mediaAligned",
        "mediaAlignedWordCount", "wordStartsMediaAligned", "wordEndsMediaAligned",
        "mediaAlignmentMethodVersion", "mediaDurationSeconds",
        "analyticsDurationSeconds", "durationDeltaSeconds", "alignmentConfidence",
        "alignmentCharacterErrorRate", "alignmentReviewWordFraction",
        "timingResolutionSeconds", "alignmentReferenceAudits",
        "alignedHookEndSeconds", "hookMediaAlignmentAudit",
        "hookCanonicalTextTimingAudit", "hookAlignmentMethodVersion",
    )
    detail["tokens"] = timing
    detail["timingContract"] = timing_contract
    detail["opening"] = {key: opening.get(key) for key in opening_keys}
    detail["retention"] = curve_payload(
        source.get("curve") or [], media_duration,
    )
    detail["originalHookEndSeconds"] = hook_end_seconds
    detail["resolutionEvidence"] = resolution_evidence
    counts = Counter(
        resolution for node in nodes for resolution in node.get("resolutions") or []
    )
    detail["resolutionCounts"] = dict(sorted(counts.items()))
    detail["selectedCombinations"] = _structural_combinations(nodes)
    detail["openingAnalysisMethodVersion"] = METHOD_VERSION
    detail["sourceRecord"].update({
        "durationSeconds": media_duration,
        "mediaDurationSeconds": media_duration,
        "analyticsDurationSeconds": float(source.get("duration_s") or 0),
        "originalHookEndSeconds": source.get("hookEndSec"),
        "mediaAlignedHookEndSeconds": hook_end_seconds,
    })
    detail["horizonContract"].update({
        "semanticInput": (
            "the unchanged canonical transcript forced onto source-media acoustic frames "
            "through 20.0 seconds"
        ),
        "outcomeInput": (
            "the measured analytics retention curve mapped to the actual source-media duration "
            "and interpolated only through 20.0 seconds"
        ),
        "forecastBeyondSourceText": False,
        "forecastBeyond20Seconds": False,
    })
    previous_hash = str(
        detail.get("semanticContentHashBeforeRetiming")
        or detail.get("contentHash") or ""
    )
    alignment_hash = hashlib.sha256(json.dumps(
        opening.get("timingWords") or [], sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")).hexdigest()
    stable_build_key = str(current_build_key or detail.get("buildContentKey") or "")
    content_hash = hashlib.sha256(
        f"{stable_build_key}\0{METHOD_VERSION}\0{alignment_hash}\0{hook_end_seconds:.9f}".encode(
            "utf-8"
        )
    ).hexdigest()
    detail.setdefault("semanticContentHashBeforeRetiming", previous_hash)
    detail["contentHash"] = content_hash
    detail["id"] = content_hash[:20]
    detail["buildContentKey"] = stable_build_key
    detail["edgeCount"] = len(detail.get("edges") or [])
    detail["edgeCounts"] = {
        name: sum(edge.get("type") == name for edge in detail.get("edges") or [])
        for name in ("containment", "sequence", "semantic", "context", "title", "outcome")
    }
    return detail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    if args.video_id:
        corpus = [row for row in corpus if str(row["id"]) == str(args.video_id)]
    if args.limit:
        corpus = corpus[:args.limit]
    if not corpus:
        raise SystemExit("no matching Promise Lab sources")

    full_corpus = json.loads(
        (CACHE / "corpus.json").read_text(encoding="utf-8")
    )["rows"]
    partition_model = json.loads(
        (CACHE / "canonical-partition-model.json").read_text(encoding="utf-8")
    )
    lattice_model = json.loads(
        (CACHE / "component-lattice-model.json").read_text(encoding="utf-8")
    )
    canonical_partitions = json.loads(
        (CACHE / "canonical-partitions.json").read_text(encoding="utf-8")
    )
    horizon_extension = fit_horizon_partition_extension(
        canonical_partitions, full_corpus,
    )

    for index, source in enumerate(corpus, 1):
        video_id = str(source["id"])
        path = DETAILS / f"{video_id}.json.gz"
        if not path.exists():
            raise FileNotFoundError(f"missing cached opening detail: {path}")
        opening = load_local_opening(video_id, ROOT)
        if not opening.get("mediaAligned"):
            raise RuntimeError(f"source is not media aligned: {video_id}")
        build_key = content_key(
            source, opening, partition_model, lattice_model, horizon_extension,
        )
        detail = retime_detail(
            source, read_gzip_json(path), opening, build_key,
        )
        atomic_gzip_json(path, detail)
        print(
            f"[{index}/{len(corpus)}] {video_id}: {detail['tokenCount']} tokens, "
            f"{len(detail.get('canonicalComponents') or [])} components, "
            f"{opening.get('alignmentConfidence')} alignment",
            flush=True,
        )


if __name__ == "__main__":
    main()
