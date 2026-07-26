#!/usr/bin/env python3
"""Verify structural coherence inside a frozen quant snapshot."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np


HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "snapshot-manifest.json"
OUTPUT_PATH = HERE / "snapshot-integrity.json"
CHANNELS = [
    ("shorts", "visual"),
    ("shorts", "text"),
    ("shorts", "together"),
    ("long", "visual"),
    ("long", "text"),
    ("long", "together"),
]


def rounded(value: float | None, digits: int = 6) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def object_path(payload: dict[str, Any]) -> Path:
    return (HERE / payload["localObject"]).resolve()


def verify_channel(
    format_name: str,
    modality: str,
    objects: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    map_object = objects[f"{format_name}:{modality}:map"]
    vector_object = objects[f"{format_name}:{modality}:vectors"]
    map_payload = json.loads(object_path(map_object).read_text())
    map_ids = np.asarray(map_payload.get("id") or [], dtype=str)
    with np.load(object_path(vector_object), allow_pickle=True) as archive:
        vector_ids = archive["ids"].astype(str)
        vectors = archive["vecs"].astype(np.float32, copy=False)
        row_match = len(map_ids) == len(vector_ids)
        order_match = row_match and bool(np.array_equal(map_ids, vector_ids))
        duplicate_map_ids = len(map_ids) - len(set(map_ids.tolist()))
        duplicate_vector_ids = len(vector_ids) - len(set(vector_ids.tolist()))
        sample_count = min(10_000, len(vectors))
        sample_index = np.linspace(
            0,
            max(0, len(vectors) - 1),
            sample_count,
            dtype=np.int64,
        )
        sample = vectors[sample_index]
        norms = np.linalg.norm(sample, axis=1)
        finite_sample = bool(np.isfinite(sample).all())
        return {
            "id": f"{format_name}:{modality}",
            "mapRows": len(map_ids),
            "vectorRows": len(vector_ids),
            "dimensions": int(vectors.shape[1]) if vectors.ndim == 2 else None,
            "mapAndVectorRowCountMatch": row_match,
            "mapAndVectorIdOrderMatch": order_match,
            "duplicateMapIds": duplicate_map_ids,
            "duplicateVectorIds": duplicate_vector_ids,
            "sampledVectors": sample_count,
            "sampleAllFinite": finite_sample,
            "sampleNorm": {
                "minimum": rounded(float(np.min(norms))) if len(norms) else None,
                "p10": rounded(float(np.quantile(norms, 0.1))) if len(norms) else None,
                "median": rounded(float(np.median(norms))) if len(norms) else None,
                "p90": rounded(float(np.quantile(norms, 0.9))) if len(norms) else None,
                "maximum": rounded(float(np.max(norms))) if len(norms) else None,
            },
            "mapHash": map_object["sha256"],
            "vectorHash": vector_object["sha256"],
        }


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text())
    objects = {item["role"]: item for item in manifest["objects"]}
    channels = [
        verify_channel(format_name, modality, objects)
        for format_name, modality in CHANNELS
    ]
    failures = []
    for channel in channels:
        if not channel["mapAndVectorRowCountMatch"]:
            failures.append(f"{channel['id']}: row count mismatch")
        if not channel["mapAndVectorIdOrderMatch"]:
            failures.append(f"{channel['id']}: ID order mismatch")
        if channel["duplicateMapIds"] or channel["duplicateVectorIds"]:
            failures.append(f"{channel['id']}: duplicate IDs")
        if channel["dimensions"] != 1536:
            failures.append(f"{channel['id']}: expected 1536 dimensions")
        if not channel["sampleAllFinite"]:
            failures.append(f"{channel['id']}: non-finite sampled vector")
    output = {
        "schema": "quant-frozen-snapshot-integrity-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "snapshotRunId": manifest["runId"],
        "snapshotIdentityHash": manifest["identityHash"],
        "channels": channels,
        "failures": failures,
        "accepted": not failures,
        "checks": [
            "map and raw-vector row counts match",
            "map and raw-vector IDs match in exact order",
            "IDs are unique",
            "raw vectors have 1536 dimensions",
            "a deterministic 10,000-row vector sample is finite",
        ],
    }
    serialized = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({
        "accepted": output["accepted"],
        "failures": failures,
        "channels": [
            {
                "id": channel["id"],
                "rows": channel["vectorRows"],
                "idOrderMatch": channel["mapAndVectorIdOrderMatch"],
            }
            for channel in channels
        ],
    }, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
