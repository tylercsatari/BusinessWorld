#!/usr/bin/env python3
"""Fail closed when corpus/predictor lattice contracts drift."""

from __future__ import annotations

import gzip
import json
from collections import Counter
from pathlib import Path

from atlas import REPRESENTATION_VERSION


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
EDGE_TYPES = {"containment", "sequence", "semantic", "context", "title", "outcome"}
REPRESENTATIONS = {
    "componentIsolation", "deletedContext", "fullHook", "contextualMarginal",
    "nonadditiveInteraction",
    "componentOrthogonalContext", "fullOrthogonalIdea", "marginalOrthogonalIdea",
    "prefixBefore", "prefixAfter", "prefixTransition", "suffixAfter",
}
REQUIRED_RESOLUTIONS = {
    "full-hook", "token", "ngram-2", "ngram-3", "window-4-6", "window-7-10",
    "window-11-16", "prefix", "suffix", "clause", "timestamp", "change-point",
    "deletion", "canonical",
}
MAPS = {
    "raw", "context", "influence", "nonadditive", "globalTitleManifold",
    "componentOrthogonalContext", "fullOrthogonalIdea", "marginalOrthogonalIdea",
    "prefixBefore", "prefixAfter", "prefixTransition", "suffixAfter",
}


def main() -> None:
    summary = json.loads((CACHE / "component-lattice.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "component-lattice-model.json").read_text(encoding="utf-8"))
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))
    outcomes = json.loads((CACHE / "hook-outcomes.json").read_text(encoding="utf-8"))
    if summary.get("status") != "complete":
        raise RuntimeError("component lattice summary is not complete")
    if int(summary.get("hookCount") or 0) != len(corpus.get("rows") or []):
        raise RuntimeError("component lattice does not cover every measured hook")
    if not model.get("parityContract", {}).get("shared"):
        raise RuntimeError("corpus and predictor do not declare one shared lattice builder")
    if model.get("prefixTransitionNullOutcomesUsed") is not False:
        raise RuntimeError("prefix transition null must be outcome-blind")
    if model.get("allSpanRepresentationVersion") != REPRESENTATION_VERSION:
        raise RuntimeError("component lattice model uses a stale span representation formula")

    spans = 0; edges = 0; timing = Counter(); seen_resolutions = set()
    for row in summary["rows"]:
        path = CACHE / "component-lattice" / f"{row['videoId']}.json.gz"
        if not path.exists():
            raise RuntimeError(f"missing lattice detail for {row['videoId']}")
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            detail = json.load(handle)
        n = int(detail["tokenCount"]); expected = n * (n + 1) // 2
        if detail["spanCount"] != expected or len(detail["nodes"]) != expected:
            raise RuntimeError(f"incomplete contiguous span lattice for {row['videoId']}")
        if len(detail["tokens"]) != n or len(detail["rejectedCandidates"]["empty"]) != n + 1:
            raise RuntimeError(f"token/rejected-empty coverage differs for {row['videoId']}")
        node_ids = {node["id"] for node in detail["nodes"]}
        if len(node_ids) != expected:
            raise RuntimeError(f"duplicate span node for {row['videoId']}")
        for node in detail["nodes"]:
            if set(node["representations"]) != REPRESENTATIONS:
                raise RuntimeError(f"representation family missing from {row['videoId']} {node['id']}")
            if set(node.get("maps") or {}) != MAPS:
                raise RuntimeError(f"representation map missing from {row['videoId']} {node['id']}")
            if node["descriptiveAttention"].get("aggregate") is not None:
                raise RuntimeError("descriptive attention must not hide an arbitrary aggregate")
            if (int(node["end"]) - int(node["start"]) == 1
                    and node["maps"].get("nonadditive") is not None):
                raise RuntimeError("singleton nonadditive noise was projected as semantic signal")
            seen_resolutions.update(
                "timestamp" if value.startswith("timestamp-") else value
                for value in node["resolutions"]
            )
        edge_types = {edge["type"] for edge in detail["edges"]}
        if edge_types != EDGE_TYPES:
            raise RuntimeError(f"edge family coverage differs for {row['videoId']}: {edge_types}")
        if not detail["ideaAnchor"]["present"]:
            raise RuntimeError(f"published title anchor is missing for {row['videoId']}")
        for edge in detail["edges"]:
            if edge["type"] == "semantic" and edge["source"] == edge["target"]:
                raise RuntimeError(f"semantic self-edge in {row['videoId']}")
            if edge["type"] == "outcome" and (
                edge.get("evaluationEligible") is not True or edge.get("fold") is None
            ):
                raise RuntimeError(f"stored outcome edge is not source-held-out for {row['videoId']}")
        contract = detail["graphContract"]
        if any(contract.get(key) is not False for key in (
            "outcomeUsedForNodes", "outcomeUsedForContainment", "outcomeUsedForSequence",
            "outcomeUsedForSemanticEdges", "outcomeUsedForContextEdges", "outcomeUsedForTitleEdges",
        )):
            raise RuntimeError(f"structural graph leaked outcomes for {row['videoId']}")
        if detail["parityContract"].get("corpusAndPredictorShareCode") is not True:
            raise RuntimeError(f"shared-builder parity missing for {row['videoId']}")
        if detail["representationContract"].get("representationVersion") != REPRESENTATION_VERSION:
            raise RuntimeError(f"representation version missing for {row['videoId']}")
        if set(detail.get("mapDefinitions") or {}) != MAPS:
            raise RuntimeError(f"map-definition coverage missing for {row['videoId']}")
        partition_contract = detail.get("partitionContract") or {}
        if (partition_contract.get("exactNonoverlappingCover") is not True
                or partition_contract.get("selectionUsesOutcomes") is not False
                or partition_contract.get("tokenOwnership") != [1] * n):
            raise RuntimeError(f"predictor partition contract failed for {row['videoId']}")
        timing_contract = detail.get("timingContract") or {}
        if (
            timing_contract.get("source") != "source-media-ctc-estimated-intervals"
            or timing_contract.get("mediaAligned") is not True
            or timing_contract.get("exact") is not False
            or not timing_contract.get("boundaryEstimator")
            or not timing_contract.get("timingResolutionSeconds")
        ):
            raise RuntimeError(
                f"source-media timing provenance missing for {row['videoId']}"
            )
        spans += len(detail["nodes"]); edges += len(detail["edges"])
        timing[detail["timingContract"]["source"]] += 1
    if seen_resolutions != REQUIRED_RESOLUTIONS:
        raise RuntimeError(f"resolution family coverage differs: {seen_resolutions}")
    if spans != summary["spanCount"] or edges != summary["edgeCount"]:
        raise RuntimeError("summary lattice counts do not equal detail artifacts")
    expected_timing = Counter({"source-media-ctc-estimated-intervals": len(outcomes["hooks"])})
    if timing != expected_timing:
        raise RuntimeError(f"lattice timing provenance differs from source timing policy: {timing} != {expected_timing}")
    print(json.dumps({
        "hooks": summary["hookCount"], "spans": spans, "edges": edges,
        "timing": dict(timing), "edgeFamilies": sorted(EDGE_TYPES),
        "resolutionFamilies": sorted(seen_resolutions), "sharedBuilder": True,
    }, indent=2))


if __name__ == "__main__":
    main()
