#!/usr/bin/env python3
"""Verify the complete crossed swap design and every identity control."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    summary = json.loads((CACHE / "swaps.json").read_text(encoding="utf-8"))
    plan_summary = json.loads((CACHE / "swap-plan-summary.json").read_text(encoding="utf-8"))
    expected_rows = int(summary["sourceComponentCount"]) * int(summary["targetHookCount"])
    if int(summary["swapRows"]) != expected_rows:
        raise RuntimeError("swap summary is not a complete source-by-target crossing")
    if summary["planSignature"] != plan_summary["planSignature"]:
        raise RuntimeError("swap plan and summary signatures differ")

    rows = sources = identities = bad_identity = bad_outcome = bad_source = 0
    current = None
    targets = set()
    reference_targets = None
    source_identity = 0
    with gzip.open(CACHE / "swap-plan.jsonl.gz", "rt", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            source_id = row["sourceId"]
            if current is not None and source_id != current:
                sources += 1
                bad_source += len(targets) != summary["targetHookCount"] or source_identity != 1
                if reference_targets is None:
                    reference_targets = targets
                else:
                    bad_source += targets != reference_targets
                targets = set()
                source_identity = 0
            current = source_id
            rows += 1
            targets.add(row["targetVideoId"])
            is_identity = bool(row.get("identityControl"))
            identities += is_identity
            source_identity += is_identity
            bad_identity += is_identity and (
                not row.get("identity") or row["recomposedText"] != row["targetHookText"]
            )
            bad_outcome += bool(row.get("routingUsesOutcomes"))
        if current is not None:
            sources += 1
            bad_source += len(targets) != summary["targetHookCount"] or source_identity != 1
            if reference_targets is None:
                reference_targets = targets
            else:
                bad_source += targets != reference_targets
    if rows != expected_rows or sources != summary["sourceComponentCount"]:
        raise RuntimeError("plan row or source count differs from the summary")
    if identities != sources or bad_identity or bad_outcome or bad_source:
        raise RuntimeError("swap plan control invariants failed")

    with np.load(CACHE / "swap-matrices.npz", allow_pickle=True) as arrays:
        source_ids = [str(value) for value in arrays["source_ids"]]
        target_ids = [str(value) for value in arrays["target_ids"]]
        target_index = {value: index for index, value in enumerate(target_ids)}
        source_video = {row["sourceId"]: row["videoId"] for row in summary["sourceComponents"]}
        identity_error = {}
        nonfinite = {}
        for metric in summary["metricNames"]:
            matrix = np.asarray(arrays[f"{metric}_percentile"], np.float32)
            baseline = np.asarray(arrays[f"{metric}_baseline"], np.float32)
            if matrix.shape != (len(source_ids), len(target_ids)):
                raise RuntimeError(f"{metric} matrix has the wrong shape")
            nonfinite[metric] = int(np.size(matrix) - np.isfinite(matrix).sum())
            errors = [
                abs(float(matrix[index, target_index[source_video[source_id]]])
                    - float(baseline[target_index[source_video[source_id]]]))
                for index, source_id in enumerate(source_ids)
            ]
            identity_error[metric] = max(errors, default=0.0)
        if any(nonfinite.values()) or any(value > 1e-5 for value in identity_error.values()):
            raise RuntimeError("swap score matrices failed finiteness or identity checks")

    source_paths = list((CACHE / "swap-sources").glob("*.json.gz"))
    if len(source_paths) != sources or any(path.stat().st_size == 0 for path in source_paths):
        raise RuntimeError("per-source detail artifact count is incomplete")
    print(json.dumps({
        "status": "verified",
        "sources": sources,
        "targets": len(reference_targets or []),
        "rows": rows,
        "identityControls": identities,
        "identityMaximumErrorByMetric": identity_error,
        "nonfiniteByMetric": nonfinite,
        "sourceDetailArtifacts": len(source_paths),
        "outcomeRoutedRows": bad_outcome,
        "planSignature": summary["planSignature"],
    }, indent=2))


if __name__ == "__main__":
    main()
