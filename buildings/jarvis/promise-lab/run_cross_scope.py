#!/usr/bin/env python3
"""Validate which exhaustive families persist in the evidence-supported scope."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from cross_scope import boundary_support_separation, compare_maps, consensus_agreement
from embedding_store import R2_PREFIX, R2Store


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def atomic_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                         encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-size", type=int, default=4096)
    parser.add_argument("--candidate-map-limit", type=int, default=0,
                        help="0 compares every retained candidate map")
    parser.add_argument("--pair-count", type=int, default=100_000)
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    candidate_atlas = json.loads((CACHE / "atlas.json").read_text(encoding="utf-8"))
    all_atlas_path = CACHE / "all-span-atlas.json"
    all_atlas = json.loads(all_atlas_path.read_text(encoding="utf-8"))
    candidates = candidate_atlas["candidates"]
    spans = all_atlas["spans"]
    all_index = {row["id"]: index for index, row in enumerate(spans)}
    missing = [row["id"] for row in candidates if row["id"] not in all_index]
    if missing:
        raise RuntimeError(f"candidate spans missing from exhaustive atlas: {missing[:3]}")
    projection = np.asarray([all_index[row["id"]] for row in candidates], np.int32)
    groups = np.asarray([row["videoId"] for row in candidates])
    r2 = None if args.no_upload else R2Store()
    started = time.time()

    def progress(complete: int, total: int) -> None:
        payload = {
            "version": 4,
            "status": "running",
            "stage": "cross-scope family persistence validation",
            "mapsComplete": complete,
            "mapsTotal": total,
            "candidateInstances": len(candidates),
            "allSpanInstances": len(spans),
            "outcomesUsed": False,
            "updatedAt": int(time.time() * 1000),
        }
        if complete == total or complete % 10 == 0:
            atomic_json(CACHE / "progress.json", payload)
        if r2 and (complete == total or complete % 50 == 0):
            r2.put_json(f"{R2_PREFIX}/progress.json", payload)
        if complete == total or complete % 10 == 0:
            print(f"cross-scope maps {complete}/{total}", flush=True)

    comparisons = compare_maps(
        candidate_atlas["maps"], all_atlas["maps"], projection, groups,
        sample_size=args.sample_size, candidate_map_limit=args.candidate_map_limit,
        progress=progress,
    )
    agreement = consensus_agreement(
        candidate_atlas["maps"], all_atlas["maps"], projection,
        pair_count=args.pair_count,
    )
    global_support = float(np.mean([bool(row.get("boundarySupported")) for row in spans]))
    comparison_by_id = {row["allSpanMapId"]: row for row in comparisons}
    representation_rows = defaultdict(list)
    registry = []
    for cluster_map in all_atlas["maps"]:
        comparison = comparison_by_id[cluster_map["id"]]
        separation = boundary_support_separation(cluster_map, global_support)
        cluster_map["crossScopeBestARI"] = comparison["bestARI"]
        cluster_map["crossScopeBestMapId"] = comparison["bestCandidateMapId"]
        cluster_map["crossScopeBestRepresentation"] = comparison["bestCandidateRepresentation"]
        cluster_map["crossScopeSameRepresentationBestARI"] = comparison[
            "sameRepresentationBestARI"
        ]
        cluster_map["boundarySupportWeightedEnrichment"] = separation[
            "weightedAbsoluteEnrichment"
        ]
        cluster_map["boundarySupportMaximumEnrichment"] = separation[
            "maximumAbsoluteEnrichment"
        ]
        representation_rows[str(cluster_map.get("representation"))].append(comparison["bestARI"])
        registry.append({
            "id": hashlib.sha1(f"cross-scope:{cluster_map['id']}".encode()).hexdigest()[:20],
            "stage": "cross-scope-validation",
            "scope": "all-contiguous-spans",
            "representation": cluster_map.get("representation"),
            "pcaDimensions": cluster_map.get("pcaDimensions"),
            "geometry": cluster_map.get("geometry"),
            "clusterCount": cluster_map.get("clusterCount"),
            "bestCandidateMapId": comparison["bestCandidateMapId"],
            "bestCandidateRepresentation": comparison["bestCandidateRepresentation"],
            "crossScopeARI": comparison["bestARI"],
            "sameRepresentationARI": comparison["sameRepresentationBestARI"],
            "boundarySupportWeightedEnrichment": separation["weightedAbsoluteEnrichment"],
            "outcomesUsed": False,
        })

    values = np.asarray([row["bestARI"] for row in comparisons], float)
    artifact = {
        "version": 4,
        "status": "complete",
        "stage": "cross-scope family persistence validation",
        "candidateInstances": len(candidates),
        "allSpanInstances": len(spans),
        "candidateMaps": len(candidate_atlas["maps"]),
        "allSpanMaps": len(all_atlas["maps"]),
        "candidateMapsComparedPerAllSpanMap": (
            min(args.candidate_map_limit, len(candidate_atlas["maps"]))
            if args.candidate_map_limit else len(candidate_atlas["maps"])
        ),
        "instancesComparedPerMap": min(args.sample_size, len(candidates)),
        "outcomesUsed": False,
        "semanticRules": 0,
        "consensusAgreement": agreement,
        "bestARIDistribution": {
            "minimum": float(values.min()),
            "median": float(np.median(values)),
            "p75": float(np.percentile(values, 75)),
            "p90": float(np.percentile(values, 90)),
            "maximum": float(values.max()),
            "mapsAtLeast0_3": int(np.sum(values >= .3)),
            "mapsAtLeast0_5": int(np.sum(values >= .5)),
        },
        "byRepresentation": {
            name: {
                "maps": len(scores),
                "medianBestARI": float(np.median(scores)),
                "maximumBestARI": float(np.max(scores)),
            }
            for name, scores in sorted(representation_rows.items())
        },
        "globalBoundarySupportedFraction": global_support,
        "comparisons": comparisons,
        "elapsedSeconds": round(time.time() - started, 2),
    }
    atomic_json(CACHE / "cross-scope.json", artifact)
    atomic_json(all_atlas_path, all_atlas)
    registry_raw = "\n".join(json.dumps(row, separators=(",", ":")) for row in registry).encode()
    registry_path = CACHE / "cross-scope-experiments.jsonl.gz"
    registry_path.write_bytes(gzip.compress(registry_raw, compresslevel=6))
    complete = {
        "version": 4,
        "status": "running",
        "stage": "cross-scope validation complete; dual-atlas swaps next",
        "crossScopeMaps": len(comparisons),
        "consensusSpearman": agreement["spearman"],
        "outcomesUsed": False,
        "updatedAt": int(time.time() * 1000),
    }
    atomic_json(CACHE / "progress.json", complete)
    if r2:
        r2.put_json(f"{R2_PREFIX}/cross-scope.json.gz", artifact, gzip_payload=True)
        r2.put_json(f"{R2_PREFIX}/all-span-atlas.json.gz", all_atlas, gzip_payload=True)
        r2.put_bytes(f"{R2_PREFIX}/cross-scope-experiments.jsonl.gz",
                     registry_path.read_bytes(), "application/gzip")
        r2.put_json(f"{R2_PREFIX}/progress.json", complete)
    print(json.dumps({
        "consensusAgreement": agreement,
        "bestARIDistribution": artifact["bestARIDistribution"],
        "elapsedSeconds": artifact["elapsedSeconds"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
