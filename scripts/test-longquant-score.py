#!/usr/bin/env python3
"""Focused regression checks for channel-specific Long Quant scoring."""
import json
import os
import sys
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import longquant_score as scorer


def main():
    raw_map = {
        "id": ["a", "b", "c"],
        "title": ["A", "B", "C"],
        "views": [100, 1_000, 10_000],
        "outlier": [1, 2, 3],
        "proj": {
            "ctrviews": {"x": [100, 500, 900], "y": [120, 520, 920]},
            "ctr": {"est": [1, 2, 3]},
            "ret30": {"est": [10, 20, 30]},
            "realviews": {"est": [110, 1_100, 11_000]},
        },
    }
    neighbors = (
        np.asarray([0, 1]),
        np.asarray([0.9, 0.8]),
        np.asarray([2.0, 1.0]),
    )
    with patch.object(scorer, "top_neighbors", return_value=neighbors), patch.object(scorer, "load_map", return_value=raw_map):
        result = scorer.channel_score("together", np.ones(scorer.DIM, np.float32))

    ctrviews = result["metrics"]["ctrviews"]
    assert ctrviews["kind"] == "neighbor_axis_percentile"
    assert ctrviews["projection"] == "ctrviews"
    assert ctrviews["pctile"] is not None
    assert result["nn_cos"] == 0.9
    print(json.dumps({
        "ok": True,
        "channel": "together",
        "ctrviews": ctrviews,
        "metrics": sorted(result["metrics"]),
    }, indent=2))


if __name__ == "__main__":
    main()
