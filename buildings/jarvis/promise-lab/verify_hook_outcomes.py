#!/usr/bin/env python3
"""Verify the stored hook outcome and retention forecast contract."""

import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def main() -> None:
    artifact = json.loads((CACHE / "hook-outcomes.json").read_text(encoding="utf-8"))
    model = json.loads((CACHE / "hook-outcome-model.json").read_text(encoding="utf-8"))
    assert artifact["status"] == model["status"] == "complete"
    assert artifact["methodVersion"] == model["methodVersion"]
    assert artifact["audit"]["hooks"] == 208
    assert artifact["audit"]["components"] == 832
    assert artifact["audit"]["relationships"] == 1248
    assert artifact["audit"]["componentCoverageFailures"] == 0
    assert len(artifact["targets"]) == 4
    assert len(artifact["hooks"]) == 208
    assert all(len(row["components"]) == 4 for row in artifact["hooks"])
    assert all(len(row["relationships"]) == 6 for row in artifact["hooks"])
    assert all(len(row["retentionForecast"]["timesSeconds"]) == 41
               for row in artifact["hooks"])
    assert all(len(row["outcomes"]) == 4 for row in artifact["hooks"])
    assert all(len(row["outcomes"]) == 4 for hook in artifact["hooks"]
               for row in hook["components"])
    assert artifact["curveModel"]["validation"]["maeImprovementFraction"] > 0
    assert artifact["curveModel"]["validation"]["pairedImprovementInference"]["p"] <= .05
    assert artifact["curveModel"]["speakingRate"]["exactTimedHooks"] >= 200
    print(json.dumps({
        "status": "verified",
        "hooks": artifact["audit"]["hooks"],
        "components": artifact["audit"]["components"],
        "relationships": artifact["audit"]["relationships"],
        "curveMAE": artifact["curveModel"]["validation"]["heldoutMAEPercentagePoints"],
        "curveBaselineMAE": artifact["curveModel"]["validation"]["baselineMAEPercentagePoints"],
        "speakingRate": artifact["curveModel"]["speakingRate"]["meanWordsPerSecond"],
    }, indent=2))


if __name__ == "__main__":
    main()
