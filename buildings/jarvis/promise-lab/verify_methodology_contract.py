#!/usr/bin/env python3
"""Cross-artifact integrity, leakage, lineage, and claim-boundary verification."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from embedding_store import DIMENSIONS, MODEL
from interventions import INTERVENTION_VERSION, make_plan, plan_fingerprint
from run_all_spans import STORE_VERSION, corpus_fingerprint
from run_discovery import METHOD_VERSION as DISCOVERY_VERSION, cache_matches_source
from run_swaps import RECOMPOSITION_VERSION
from swaps import routing_input_signature


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(name: str):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def percentile_values(value, path: str = "root"):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if "percentile" in key.casefold() and isinstance(child, (int, float)):
                yield child_path, float(child)
            else:
                yield from percentile_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from percentile_values(child, f"{path}[{index}]")


def main() -> None:
    corpus_artifact = read("corpus.json")
    corpus = corpus_artifact["rows"]
    ids = [str(row["id"]) for row in corpus]
    texts = [" ".join(str(row["hookText"]).casefold().split()) for row in corpus]
    assert ids and len(ids) == len(set(ids))
    assert len(texts) == len(set(texts))
    assert corpus_artifact["embeddingModel"] == MODEL
    assert int(corpus_artifact["embeddingDimensions"]) == DIMENSIONS
    assert all(row.get("curve") and np.isfinite(np.asarray(row["curve"], float)).all()
               for row in corpus)

    id_set = set(ids)
    metadata_ids = {path.stem for path in (CACHE / "metadata").glob("*.json")}
    discovery_ids = {path.stem for path in (CACHE / "discovery").glob("*.json")}
    timing_ids = {path.stem for path in (CACHE / "hook-timing").glob("*.json")}
    assert metadata_ids == discovery_ids == timing_ids == id_set
    for row in corpus:
        video_id = str(row["id"])
        metadata = read(f"metadata/{video_id}.json")
        plan = make_plan(row["hookText"])
        assert metadata["videoId"] == video_id
        assert metadata["text"] == plan.text
        assert metadata["fingerprint"] == plan_fingerprint(plan)
        assert metadata["embeddingModel"] == MODEL
        assert int(metadata["embeddingDimensions"]) == DIMENSIONS
        assert metadata["interventionVersion"] == INTERVENTION_VERSION
        discovery = read(f"discovery/{video_id}.json")
        assert discovery["methodVersion"] == DISCOVERY_VERSION
        assert cache_matches_source(
            discovery, metadata, int(discovery["nullRepeats"]),
            int(discovery["bootstrapRepeats"]),
        )
        timing = read(f"hook-timing/{video_id}.json")
        assert " ".join(str(timing["hookText"]).casefold().split()) == texts[ids.index(video_id)]

    discovery_summary = read("discovery-summary.json")
    assert [str(row["videoId"]) for row in discovery_summary["rows"]] == ids
    manifest = read("all-span-manifest.json")
    state = read("all-span-vectors/state.json")
    assert [str(row["videoId"]) for row in manifest["hooks"]] == ids
    assert state["version"] == manifest["storeVersion"] == STORE_VERSION
    assert state["corpusFingerprint"] == corpus_fingerprint(corpus)
    assert state["embeddingModel"] == manifest["embeddingModel"] == MODEL
    assert int(state["embeddingDimensions"]) == int(manifest["embeddingDimensions"]) == DIMENSIONS
    assert state["interventionVersion"] == manifest["interventionVersion"] == INTERVENTION_VERSION
    expected_spans = sum(
        int(row["tokenCount"]) * (int(row["tokenCount"]) + 1) // 2
        for row in manifest["hooks"]
    )
    assert int(state["spanInstances"]) == int(manifest["spanInstances"]) == expected_spans

    atlas = read("atlas.json")
    all_atlas = read("all-span-atlas.json")
    manual = read("manual-projection.json")
    manual_map = next(row for row in all_atlas["maps"] if row["id"] == manual["mapId"])
    assert manual_map.get("pareto") is True
    assert manual["labelsChanged"] is False

    with np.load(CACHE / "candidate-vectors.npz", allow_pickle=True) as loaded:
        candidate_influence = np.asarray(loaded["influence"], np.float32)
    full_text = {int(row["hookIndex"]): row["text"] for row in all_atlas["hooks"]}
    spans = [{**row, "hookText": full_text[int(row["hookIndex"])]}
             for row in all_atlas["spans"]]
    all_influence = np.load(CACHE / "all-span-vectors" / "influence.npy", mmap_mode="r")
    expected_routing_signature = routing_input_signature(
        atlas["candidates"], atlas["maps"], candidate_influence,
        spans, all_atlas["maps"], all_influence,
        {
            "embeddingModel": MODEL,
            "embeddingDimensions": DIMENSIONS,
            "recompositionVersion": RECOMPOSITION_VERSION,
            "routingUniverse": "all-contiguous-spans",
        },
    )
    for artifact_name in (
        "swap-plan-summary.json", "swap-score-work/state.json", "swaps.json",
    ):
        artifact = read(artifact_name)
        assert artifact["inputSignature"] == expected_routing_signature

    axes = read("axes.json")
    assert int(axes.get("validatedCount") or 0) == 0
    assert all(
        "train-fold-only" in str((row.get("experiment") or {}).get("confoundPreprocessing") or "")
        for row in axes["maps"]
    )
    assert all(
        (row.get("experiment") or {}).get("status") != "validated"
        for row in axes["maps"]
    )

    outcomes = read("hook-outcomes.json")
    outcome_model = read("hook-outcome-model.json")
    assert outcomes["audit"]["hooks"] == len(corpus)
    assert outcomes["audit"]["postHookOutputPoints"] == 0
    assert outcomes["rewatchAudit"]["scope"]["postHookOutputPoints"] == 0
    assert all(
        abs(float(row["retentionForecast"]["timesSeconds"][-1])
            - float(row["retentionForecast"]["responseEndSeconds"])) < 1e-5
        for row in outcomes["hooks"]
    )
    attribution = outcome_model["localAttributionCalibration"]
    expected_components = sum(
        int(row["componentCount"]) for row in outcomes["hooks"]
    )
    expected_pairs = sum(
        int(row["componentCount"]) * (int(row["componentCount"]) - 1) // 2
        for row in outcomes["hooks"]
    )
    for metric in ("hook_hold", *outcome_model["targets"].keys()):
        component_rows = attribution["componentsByCategory"][metric]
        pair_rows = attribution["pairsByCategorySequence"][metric]
        assert sum(len(values) for values in component_rows.values()) == expected_components
        assert sum(len(values) for values in pair_rows.values()) == expected_pairs
        assert all(np.isfinite(np.asarray(values, float)).all()
                   for values in component_rows.values())
        assert all(np.isfinite(np.asarray(values, float)).all()
                   for values in pair_rows.values())

    checked_percentiles = 0
    for artifact_name in (
        "hook-quality.json", "hook-outcomes.json", "hook-example-results.json", "swaps.json",
    ):
        for path, value in percentile_values(read(artifact_name), artifact_name):
            assert math.isfinite(value), f"non-finite percentile at {path}"
            assert 0 <= value <= 100, f"out-of-range percentile at {path}: {value}"
            checked_percentiles += 1

    print(json.dumps({
        "status": "verified",
        "hooks": len(corpus),
        "spans": expected_spans,
        "sourceFingerprints": len(corpus),
        "routingInputSignature": expected_routing_signature,
        "axisConfounds": "train-fold-only",
        "chronologicallyValidatedLegacyAxes": 0,
        "postHookOutputPoints": 0,
        "headlineComponentAttributions": expected_components,
        "headlinePairInteractions": expected_pairs,
        "percentilesChecked": checked_percentiles,
    }, indent=2))


if __name__ == "__main__":
    main()
