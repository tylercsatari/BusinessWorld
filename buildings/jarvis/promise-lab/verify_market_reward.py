#!/usr/bin/env python3
"""Verify the frozen Market Hold reward, leakage boundary, and score parity."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from market_reward import ALPHA_CANDIDATES, leave_one_out_nearest, score_market_vector


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
TOLERANCE = 2e-5


def close(left, right, tolerance=TOLERANCE):
    return abs(float(left) - float(right)) <= tolerance


def main() -> None:
    model = json.loads((CACHE / "market-reward-model.json").read_text(encoding="utf-8"))
    browser = json.loads((CACHE / "market-reward.json").read_text(encoding="utf-8"))
    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]
    partitions = json.loads(
        (CACHE / "canonical-partitions.json").read_text(encoding="utf-8")
    )["rows"]
    audit = model["audit"]
    external = model["externalTraining"]
    transfer = model["transferValidation"]

    assert model["version"] == 2
    assert "hooks" not in model
    for key in (
        "status", "methodVersion", "embeddingModel", "embeddingDimensions",
        "scoreScale", "externalTraining", "transferValidation", "domainGate",
        "rewardContract", "audit",
    ):
        assert browser[key] == model[key]
    assert model["embeddingDimensions"] == 1536
    assert len(model["coefficient"]) == 1536
    assert len(model["mapDirection"]) == 1536
    assert len(model["ladder"]) == external["nonOwnedTrainingRows"] == 5353
    assert np.all(np.diff(np.asarray(model["ladder"], float)) >= 0)
    assert external["ownedOutcomeLabelsUsedToFitOrSelectAxis"] is False
    assert external["selectedAlpha"] in ALPHA_CANDIDATES
    assert [row["alpha"] for row in external["selection"]] == list(ALPHA_CANDIDATES)
    selected = max(external["selection"], key=lambda row: (
        row["heldoutSpearman"],
        (row.get("directionStability") or {}).get("medianCosine") or -1,
        -row["alpha"],
    ))
    assert selected["alpha"] == external["selectedAlpha"]
    assert selected == external["fullDataSelectionValidation"]
    nested = external["selectedValidation"]
    assert nested["hyperparametersSelectedInsideOuterTrain"] is True
    assert len(nested["outerFolds"]) == 5
    assert sum(nested["outerSelectedAlphaCounts"].values()) == 5

    assert audit["ownedHooks"] == len(corpus) == len(partitions) == 208
    assert audit["ownedHooksExcludedFromExternalTraining"] == len(corpus)
    assert audit["promiseIdsPresentInExternalTraining"] == 0
    assert audit["promiseIdsMissingOwnedFlag"] == 0
    assert [str(row["id"]) for row in corpus] == [
        str(row["videoId"]) for row in partitions
    ]

    local = transfer["retention_5s"]
    expected_status = (
        "validated-cross-source-local-retention-proxy"
        if external["selectedValidation"]["heldoutSpearman"] > 0
        and external["selectedValidation"]["heldoutSpearmanP"] <= .05
        and local["status"] == "cross-source-transfer-supported"
        and local["recentHalfSpearman"] > 0
        and local["recentHalfSpearmanP"] <= .05
        else "not-ready-for-training"
    )
    assert model["status"] == expected_status
    assert transfer["viewed_percent"]["status"] == "cross-source-transfer-supported"
    assert transfer["retention_5s"]["status"] == "cross-source-transfer-supported"
    assert transfer["average_retention"]["status"] == "cross-source-transfer-supported"
    assert transfer["log_views"]["status"] == "not-supported"
    assert all(row["rows"] == len(corpus) for row in transfer.values())

    references = np.asarray(model["domainReferenceEmbeddings"], np.float32)
    assert references.shape == (len(corpus), 1536)
    nearest = leave_one_out_nearest(references)
    assert close(np.min(nearest), model["domainGate"]["nearestCosineMinimum"])
    assert close(np.quantile(nearest, .1), model["domainGate"]["nearestCosineP10"])
    assert model["domainGate"]["penaltyWeight"] is None
    contract = model["rewardContract"]
    assert contract["visualInputUsed"] is False
    assert contract["titleInputUsed"] is False
    assert contract["categoriesUsed"] is False
    assert contract["retentionCurveUsedAtInference"] is False

    hooks = browser["hooks"]
    assert len(hooks) == len(corpus)
    by_id = {str(row["videoId"]): row for row in hooks}
    component_count = 0
    relationship_count = 0
    for index, (source, partition) in enumerate(zip(corpus, partitions)):
        row = by_id[str(source["id"])]
        replay = score_market_vector(
            references[index], model, include_diagnostics=False,
        )
        for key in ("coordinate", "z", "percentile", "reward", "mapX", "mapY"):
            assert close(row["score"][key], replay[key])
        assert row["score"]["eligibleForTraining"] is True
        assert close(row["score"]["reward"], row["score"]["percentile"] / 100)
        assert "validation" not in row["score"]

        components = row["components"]
        relationships = row["relationships"]
        categories = [int(chunk["category"]) for chunk in partition["chunks"]]
        assert len(components) == int(partition["componentCount"])
        assert [int(value["category"]) for value in components] == categories
        assert len(relationships) == len(components) * (len(components) - 1) // 2
        for component in components:
            expected = (
                float(component["fullCoordinate"])
                - float(component["withoutCoordinate"])
            ) / float(model["scoreScale"]["predictionStd"])
            assert close(component["effectZ"], expected)
        for relation in relationships:
            expected = (
                float(relation["fullCoordinate"])
                - float(relation["withoutLeftCoordinate"])
                - float(relation["withoutRightCoordinate"])
                + float(relation["withoutBothCoordinate"])
            ) / float(model["scoreScale"]["predictionStd"])
            assert close(relation["interactionZ"], expected)
        component_count += len(components)
        relationship_count += len(relationships)

    assert component_count == audit["components"] == 324
    assert relationship_count == audit["relationships"] == 175
    print(json.dumps({
        "status": "verified",
        "rewardStatus": model["status"],
        "externalRows": external["nonOwnedTrainingRows"],
        "externalNestedGroupedOOFSpearman": external["selectedValidation"]["heldoutSpearman"],
        "retention5sTransferSpearman": transfer["retention_5s"]["heldoutSpearman"],
        "recentHalfRetention5sSpearman": transfer["retention_5s"]["recentHalfSpearman"],
        "rawViewsTransferStatus": transfer["log_views"]["status"],
        "hooks": len(hooks),
        "components": component_count,
        "relationships": relationship_count,
    }, indent=2))


if __name__ == "__main__":
    main()
