#!/usr/bin/env python3
"""Verify the complete held-out axis registry and every published map."""

from __future__ import annotations

import gzip
import json
from collections import Counter
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def load_registry() -> list[dict]:
    with gzip.open(CACHE / "axis-experiments.jsonl.gz", "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def finite_values(values) -> np.ndarray:
    return np.asarray([value for value in values if value is not None], float)


def main() -> None:
    summary = json.loads((CACHE / "axes.json").read_text(encoding="utf-8"))
    swaps = json.loads((CACHE / "swaps.json").read_text(encoding="utf-8"))
    registry = load_registry()
    maps = summary.get("maps") or []
    source_count = int(summary["componentInstances"])
    target_names = set(summary.get("targets") or {})

    if summary.get("status") != "complete":
        raise RuntimeError("axis summary is not complete")
    if len(registry) != int(summary.get("experimentCount") or -1):
        raise RuntimeError("axis registry count differs from its summary")
    if source_count != int(swaps.get("sourceComponentCount") or -1):
        raise RuntimeError("axis and swap source counts differ")

    selected = [row for row in registry if row.get("selectedForTarget")]
    selected_counts = Counter(row.get("target") for row in selected)
    if set(selected_counts) != target_names or any(count != 1 for count in selected_counts.values()):
        raise RuntimeError("every target must have exactly one selected experiment")
    for row in selected:
        if row.get("confounds") != row.get("validationConfoundsRequired"):
            raise RuntimeError(f"selected axis {row.get('id')} used the wrong confound family")
        if row.get("status") not in {
            "multiplicity-controlled-random-fold-association",
            "target-selected-not-supported",
        }:
            raise RuntimeError(f"selected axis {row.get('id')} has an invalid status")
        if "train-fold-only" not in str(row.get("confoundPreprocessing") or ""):
            raise RuntimeError(f"selected axis {row.get('id')} has an unsafe confound contract")
        for field in ("heldoutSpearman", "heldoutPearson", "heldoutR2", "searchWideP", "searchWideQ"):
            if not np.isfinite(float(row.get(field))):
                raise RuntimeError(f"selected axis {row.get('id')} has non-finite {field}")

    selected_by_id = {row["id"]: row for row in selected}
    if len(maps) != len(target_names):
        raise RuntimeError("axis map count differs from target count")
    map_ids = [((row.get("experiment") or {}).get("id")) for row in maps]
    if len(set(map_ids)) != len(map_ids) or set(map_ids) != set(selected_by_id):
        raise RuntimeError("axis maps do not match the selected registry experiments")

    valid_oof = {}
    for row in maps:
        experiment = row["experiment"]
        if experiment != selected_by_id[experiment["id"]]:
            raise RuntimeError(f"map metadata differs from registry for {experiment['id']}")
        for field in ("x", "y", "observed", "predictedOOF", "observedResidualOOF"):
            values = row.get(field) or []
            if len(values) != source_count:
                raise RuntimeError(f"{experiment['id']} {field} has the wrong row count")
            finite = finite_values(values)
            if field in {"x", "y"} and len(finite) != source_count:
                raise RuntimeError(f"{experiment['id']} {field} contains missing values")
            if len(finite) and not np.isfinite(finite).all():
                raise RuntimeError(f"{experiment['id']} {field} contains non-finite values")
        prediction = np.asarray([
            np.nan if value is None else value for value in row["predictedOOF"]
        ], float)
        observed = np.asarray([
            np.nan if value is None else value for value in row["observedResidualOOF"]
        ], float)
        valid = np.isfinite(prediction) & np.isfinite(observed)
        if int(valid.sum()) != int(experiment["n"]):
            raise RuntimeError(f"{experiment['id']} OOF count differs from the registry")
        valid_oof[experiment["id"]] = int(valid.sum())

    with np.load(CACHE / "axis-directions.npz", allow_pickle=False) as directions:
        if set(directions.files) != set(selected_by_id):
            raise RuntimeError("direction tensors do not match selected experiments")
        direction_norm_error = {}
        for experiment_id in directions.files:
            vector = np.asarray(directions[experiment_id], float)
            if vector.shape != (1536,) or not np.isfinite(vector).all():
                raise RuntimeError(f"{experiment_id} direction is malformed")
            direction_norm_error[experiment_id] = abs(float(np.linalg.norm(vector)) - 1.0)
        if any(error > 1e-5 for error in direction_norm_error.values()):
            raise RuntimeError("one or more direction tensors are not normalized")

    supported = [
        row for row in selected
        if row["status"] == "multiplicity-controlled-random-fold-association"
    ]
    if int(summary.get("validatedCount") or 0) != 0:
        raise RuntimeError("random-fold-only axes must not be called validated")
    if len(supported) != int(summary.get("randomFoldSupportedCount") or 0):
        raise RuntimeError("supported axis count differs from its summary")
    print(json.dumps({
        "status": "verified",
        "experiments": len(registry),
        "targets": len(target_names),
        "selected": len(selected),
        "validated": 0,
        "randomFoldSupported": len(supported),
        "componentInstances": source_count,
        "minimumOOFRows": min(valid_oof.values(), default=0),
        "maximumDirectionNormError": max(direction_norm_error.values(), default=0),
    }, indent=2))


if __name__ == "__main__":
    main()
