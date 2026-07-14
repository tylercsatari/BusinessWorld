#!/usr/bin/env python3
"""Canary the frozen serving scorer against one measured library hook."""

from __future__ import annotations

import json
from pathlib import Path

from score_hook import score_text
from sequence import normalize_source


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(name: str) -> dict:
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def close(left, right, tolerance: float = 1e-7) -> bool:
    if left is None or right is None:
        return left is right
    return abs(float(left) - float(right)) <= tolerance


def main() -> None:
    outcomes = read("hook-outcomes.json")
    market = read("market-reward.json")
    partitions = read("canonical-partitions.json")

    source = min(
        outcomes["hooks"],
        key=lambda row: (len(str(row["text"]).split()), str(row["videoId"])),
    )
    video_id = str(source["videoId"])
    stored_market = next(row for row in market["hooks"] if str(row["videoId"]) == video_id)
    stored_partition = next(
        row for row in partitions["rows"] if str(row["videoId"]) == video_id
    )
    live = score_text(source["text"])

    assert normalize_source(source["text"]) == live["input"]["hookText"]
    assert "score" not in live
    assert "trainingReward" not in live
    assert live["primaryScore"] is not live["hookHoldDiagnostic"]
    for key in ("z", "percentile", "reward", "domainNearestCosine"):
        assert close(live["primaryScore"].get(key), stored_market["score"].get(key)), key
    assert live["primaryScore"]["eligibleForTraining"] == stored_market["score"][
        "eligibleForTraining"
    ]

    components = live["components"]
    ownership = [0] * int(live["input"]["tokenCount"])
    for component in components:
        for token in range(int(component["start"]), int(component["end"])):
            ownership[token] += 1
    assert ownership == [1] * len(ownership)
    serving_boundaries = [int(value) for value in (
        (stored_partition.get("servingEnsembleAudit") or {}).get("boundaries") or []
    )]
    live_boundaries = [int(row["end"]) for row in components[:-1]]
    assert live_boundaries == serving_boundaries

    print(json.dumps({
        "status": "verified",
        "videoId": video_id,
        "text": source["text"],
        "marketHoldPercentile": live["primaryScore"]["percentile"],
        "components": len(components),
        "servingBoundaries": live_boundaries,
        "legacyScoreKeysPresent": [],
    }, indent=2))


if __name__ == "__main__":
    main()
