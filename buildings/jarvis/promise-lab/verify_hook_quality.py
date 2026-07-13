#!/usr/bin/env python3
"""Hard checks for the deployable retained-information axis and decomposition."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    summary = json.loads((CACHE / "hook-quality.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "hook-quality-model.json").read_text(encoding="utf-8"))
    partitions = json.loads((CACHE / "canonical-partitions.json").read_text(encoding="utf-8"))
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    training_count = len(corpus)
    dimensions = int(model["embeddingDimensions"])
    assert summary["status"] == model["status"] == "complete"
    assert model["generativeLlmUsed"] is False and model["semanticRules"] == 0
    assert model["trainingExamples"] == training_count
    direction = np.asarray(model["qualityDirection"], float)
    orthogonal = np.asarray(model["mapOrthogonalDirection"], float)
    assert direction.shape == orthogonal.shape == (dimensions,)
    assert np.isclose(np.linalg.norm(direction), 1, atol=2e-5)
    assert np.isclose(np.linalg.norm(orthogonal), 1, atol=2e-5)
    assert abs(float(direction @ orthogonal)) < 2e-5
    bootstrap = np.asarray(model["bootstrapDirections"], float)
    bootstrap_training = np.asarray(model["bootstrapTrainingProjectionsSorted"], float)
    training = np.asarray(model["trainingFullEmbeddings"], float)
    bootstrap_count = len(bootstrap)
    assert bootstrap.shape == (bootstrap_count, dimensions) and bootstrap_count > 0
    assert bootstrap_training.shape == (bootstrap_count, training_count)
    assert training.shape == (training_count, dimensions)
    assert np.all(np.diff(np.asarray(model["trainingProjectionsSorted"], float)) >= 0)
    assert np.all(np.diff(bootstrap_training, axis=1) >= 0)
    validation = model["validation"]
    assert np.isfinite(float(validation["heldoutSpearman"]))
    assert 0 <= float(validation["rankPermutationP"]) <= 1
    expected_status = (
        "validated-random-and-future"
        if validation["rankPermutationP"] <= .05
        and validation["heldoutSpearman"] > 0
        and validation["chronologicalValidation"]["rankPermutationP"] <= .05
        and validation["chronologicalValidation"]["heldoutSpearman"] > 0
        and validation["temporalRobustAcrossBlockCounts"]
        else "random-fold-only-diagnostic"
    )
    assert validation["status"] == expected_status
    assert len(validation["chronologicalBlockSensitivity"]) == 5
    assert 0 <= float(validation["foldDirectionPositiveFraction"]) <= 1
    target = model["target"]
    assert 0 <= float(target["factorExplainedVariance"]) <= 1
    assert len(target["factorLoadings"]) == 6
    assert all(np.isfinite(float(value)) for value in target["factorLoadings"])
    points = summary["axis"]["points"]
    components = summary["components"]
    assert len(points) == training_count and len(components) == partitions["chunks"]
    for row in points:
        vector = training[int(row["index"])]
        expected = float(vector @ direction)
        assert np.isclose(expected, float(row["axisCoordinate"]), atol=2e-6)
        assert 0 <= float(row["axisPercentile"]) <= 100
        count = int(row["componentCount"])
        assert count == int(partitions["rows"][int(row["index"])]["componentCount"])
        assert len(row["pairInteractions"]) == count * (count - 1) // 2
    assert all(np.isfinite(float(row["deletionEffect"])) for row in components)
    latency = summary["latency"]
    assert len(latency["lagsSeconds"]) == 23
    assert len(latency["windows"]) == 5
    assert len(latency["rows"]) == 115
    assert 0 <= latency["timingAudit"]["exactSources"] <= training_count
    assert (latency["selectedLagSeconds"] is not None) == bool(latency["latencySupported"])
    print(json.dumps({
        "status": "verified",
        "heldoutSpearman": validation["heldoutSpearman"],
        "rankPermutationP": validation["rankPermutationP"],
        "chronologicalSpearman": validation["chronologicalValidation"]["heldoutSpearman"],
        "validationStatus": validation["status"],
        "targetVariance": target["factorExplainedVariance"],
        "components": len(components),
        "latencySupported": latency["latencySupported"],
    }, indent=2))


if __name__ == "__main__":
    main()
