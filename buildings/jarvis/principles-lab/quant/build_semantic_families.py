#!/usr/bin/env python3
"""Build outcome-free exact and near-copy leakage blocks from raw vectors."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import faiss
import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
PANEL_PATH = CACHE / "unified-panel.json.gz"
MANIFEST_PATH = HERE / "snapshot-manifest.json"
FAMILY_PATH = CACHE / "semantic-families.json.gz"
OUTPUT_PATH = HERE / "semantic-family-summary.json"
FORMATS = ["shorts", "long"]
NEIGHBORS = 20
RANDOM_PAIRS = 250_000
NULL_QUANTILE = 0.9999
MIN_COSINE = 0.90
SEED = 20260726


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = np.arange(size, dtype=np.int64)
        self.rank = np.zeros(size, dtype=np.int8)

    def find(self, value: int) -> int:
        parent = int(self.parent[value])
        if parent != value:
            self.parent[value] = self.find(parent)
        return int(self.parent[value])

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1


def rounded(value: float | None, digits: int = 6) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def load_panel() -> dict[str, dict[str, dict[str, Any]]]:
    with gzip.open(PANEL_PATH, "rt", encoding="utf-8") as source:
        payload = json.load(source)
    output: dict[str, dict[str, dict[str, Any]]] = {
        format_name: {} for format_name in FORMATS
    }
    for row in payload["rows"]:
        output[row["format"]][row["videoId"]] = {
            "videoId": row["videoId"],
            "exactFamilyId": row["contentFamilyId"],
        }
    return output


def vector_path(format_name: str, objects: dict[str, dict[str, Any]]) -> Path:
    payload = objects[f"{format_name}:together:vectors"]
    return (HERE / payload["localObject"]).resolve()


def duplicate_similarities(
    vectors: np.ndarray,
    exact_families: list[str],
    limit_per_family: int = 50,
) -> np.ndarray:
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, family in enumerate(exact_families):
        grouped[family].append(index)
    values = []
    for indices in grouped.values():
        if len(indices) < 2:
            continue
        indices = indices[:limit_per_family]
        for left_position, left in enumerate(indices):
            for right in indices[left_position + 1:]:
                values.append(float(vectors[left] @ vectors[right]))
    return np.asarray(values, dtype=np.float32)


def random_similarities(vectors: np.ndarray, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    output = np.empty(RANDOM_PAIRS, dtype=np.float32)
    batch_size = 10_000
    for start in range(0, RANDOM_PAIRS, batch_size):
        end = min(RANDOM_PAIRS, start + batch_size)
        left = rng.integers(0, len(vectors), size=end - start)
        right = rng.integers(0, len(vectors), size=end - start)
        right = np.where(right == left, (right + 1) % len(vectors), right)
        output[start:end] = np.einsum(
            "ij,ij->i",
            vectors[left],
            vectors[right],
        )
    return output


def family_identifier(format_name: str, members: list[str]) -> str:
    digest = hashlib.sha256(
        f"{format_name}\0".encode() + "\0".join(sorted(members)).encode()
    ).hexdigest()
    return f"semantic:{format_name}:{digest[:20]}"


def build_format(
    format_name: str,
    panel: dict[str, dict[str, dict[str, Any]]],
    objects: dict[str, dict[str, Any]],
) -> tuple[dict[str, str], dict[str, Any]]:
    print(f"semantic families {format_name}", flush=True)
    with np.load(vector_path(format_name, objects), allow_pickle=True) as archive:
        all_ids = archive["ids"].astype(str)
        all_vectors = archive["vecs"].astype(np.float32, copy=False)
        selected = np.asarray(
            [
                index
                for index, video_id in enumerate(all_ids)
                if video_id in panel[format_name]
            ],
            dtype=np.int64,
        )
        ids = all_ids[selected]
        vectors = np.ascontiguousarray(all_vectors[selected])
    exact_families = [panel[format_name][video_id]["exactFamilyId"] for video_id in ids]
    duplicates = duplicate_similarities(vectors, exact_families)
    random_values = random_similarities(vectors, SEED + (0 if format_name == "shorts" else 1))
    null_cutoff = float(np.quantile(random_values, NULL_QUANTILE))
    threshold = max(MIN_COSINE, null_cutoff)

    index = faiss.IndexHNSWFlat(
        vectors.shape[1],
        32,
        faiss.METRIC_INNER_PRODUCT,
    )
    index.hnsw.efConstruction = 96
    index.hnsw.efSearch = 160
    index.add(vectors)
    similarities, neighbors = index.search(vectors, NEIGHBORS + 1)
    neighbor_sets = [
        set(int(value) for value in row[1:] if value >= 0)
        for row in neighbors
    ]
    union = UnionFind(len(ids))
    exact_groups: dict[str, list[int]] = defaultdict(list)
    for row_index, family in enumerate(exact_families):
        exact_groups[family].append(row_index)
    exact_edges = 0
    for indices in exact_groups.values():
        if len(indices) < 2:
            continue
        anchor = indices[0]
        for candidate in indices[1:]:
            union.union(anchor, candidate)
            exact_edges += 1

    semantic_edges = 0
    for left in range(len(ids)):
        for position, right in enumerate(neighbors[left, 1:], start=1):
            right = int(right)
            if right <= left or right < 0:
                continue
            similarity = float(similarities[left, position])
            if similarity < threshold or left not in neighbor_sets[right]:
                continue
            union.union(left, right)
            semantic_edges += 1

    components: dict[int, list[int]] = defaultdict(list)
    for index_value in range(len(ids)):
        components[union.find(index_value)].append(index_value)
    family_by_video: dict[str, str] = {}
    for indices in components.values():
        members = [ids[index_value] for index_value in indices]
        family_id = family_identifier(format_name, members)
        for video_id in members:
            family_by_video[video_id] = family_id
    for video_id, row in panel[format_name].items():
        family_by_video.setdefault(video_id, row["exactFamilyId"])

    sizes = sorted((len(indices) for indices in components.values()), reverse=True)
    duplicate_recall = (
        float(np.mean(duplicates >= threshold))
        if len(duplicates)
        else None
    )
    empirical_null_exceedance = float(np.mean(random_values >= threshold))
    return family_by_video, {
        "format": format_name,
        "strictPanelRows": len(panel[format_name]),
        "rowsWithPrimaryTogetherEmbedding": len(ids),
        "threshold": rounded(threshold),
        "thresholdRule": (
            f"max({MIN_COSINE:.2f}, random-pair q{NULL_QUANTILE})"
        ),
        "randomPairs": RANDOM_PAIRS,
        "randomPairQuantile": rounded(null_cutoff),
        "empiricalRandomPairExceedance": rounded(empirical_null_exceedance),
        "exactDuplicatePairComparisons": len(duplicates),
        "exactDuplicateRecallAtThreshold": rounded(duplicate_recall),
        "nearestNeighbors": NEIGHBORS,
        "semanticEdgeRule": "mutual top-20 neighbor and cosine at or above threshold",
        "exactEdges": exact_edges,
        "semanticEdges": semantic_edges,
        "componentsAmongEmbeddedRows": len(components),
        "multirowComponents": sum(size > 1 for size in sizes),
        "rowsInMultirowComponents": sum(size for size in sizes if size > 1),
        "largestComponent": sizes[0] if sizes else 0,
        "componentSizeP99": rounded(float(np.quantile(sizes, 0.99))) if sizes else None,
    }


def main() -> None:
    panel = load_panel()
    manifest = json.loads(MANIFEST_PATH.read_text())
    objects = {item["role"]: item for item in manifest["objects"]}
    families: dict[str, dict[str, str]] = {}
    summaries = []
    for format_name in FORMATS:
        families[format_name], summary = build_format(
            format_name,
            panel,
            objects,
        )
        summaries.append(summary)
    artifact = {
        "schema": "outcome-free-semantic-leakage-families-v1",
        "snapshotRunId": manifest["runId"],
        "formats": families,
    }
    serialized = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()
    artifact["contentHash"] = hashlib.sha256(serialized).hexdigest()
    with gzip.open(FAMILY_PATH, "wt", encoding="utf-8", compresslevel=9) as target:
        json.dump(artifact, target, separators=(",", ":"))
    output = {
        "schema": "outcome-free-semantic-family-summary-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "snapshotRunId": manifest["runId"],
        "familyArtifact": str(FAMILY_PATH.relative_to(HERE)),
        "familyContentHash": artifact["contentHash"],
        "formats": summaries,
        "outcomesUsed": False,
        "claimBoundary": [
            "Families are leakage blocks, not semantic truth labels.",
            "Exact normalized input families are always joined.",
            "Near-copy edges require mutual nearest-neighbor support and an outcome-free cosine threshold.",
            "Videos without the primary together embedding retain their exact input family.",
        ],
    }
    output_serialized = json.dumps(
        output,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    output["contentHash"] = hashlib.sha256(output_serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
