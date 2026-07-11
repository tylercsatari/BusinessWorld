import json
import unittest
from pathlib import Path

from manual_probe import align_phrases, score_frozen_maps
from sequence import all_spans, surface, tokenize


HERE = Path(__file__).resolve().parent


def span_rows(corpus):
    rows = []
    for hook_index, hook in enumerate(corpus):
        tokens = tokenize(hook["hookText"])
        for span in all_spans(len(tokens)):
            rows.append({
                "id": f"{hook['id']}:{span.start}:{span.end}",
                "videoId": hook["id"],
                "hookIndex": hook_index,
                "start": span.start,
                "end": span.end,
                "tokenCount": span.end - span.start,
                "text": surface(tokens, span.start, span.end, hook["hookText"]),
            })
    return rows


class ManualProbeTests(unittest.TestCase):
    def test_tracked_probe_is_explicitly_post_hoc(self):
        config = json.loads((HERE / "manual-reference-probe.json").read_text())
        self.assertEqual(len(config["phrases"]), 128)
        self.assertTrue(config["policy"]["postHocManualOverfit"])
        self.assertFalse(config["policy"]["entersDiscovery"])
        self.assertFalse(config["policy"]["createsNewMaps"])

    def test_ordered_alignment_resolves_observed_contiguous_spans(self):
        corpus = [
            {"id": "a", "hookText": "I built a device to see what happens."},
            {"id": "b", "hookText": "The test started and this got wild."},
        ]
        exhaustive = span_rows(corpus)
        candidates = [
            row for row in exhaustive
            if row["text"].lower() in {"to see what happens", "and this got wild"}
        ]
        matches = align_phrases(
            ["to see what happens", "and this got wild"], corpus,
            exhaustive, candidates,
        )
        self.assertEqual([row["videoId"] for row in matches], ["a", "b"])
        self.assertEqual(
            [row["observedSpanText"].lower() for row in matches],
            ["to see what happens", "and this got wild"],
        )
        self.assertTrue(all(row["candidateIndex"] is not None for row in matches))

    def test_information_contribution_selects_concentrated_frozen_cluster(self):
        rows = [
            {"id": str(index), "videoId": f"v{index}", "start": 0, "end": 1,
             "tokenCount": 1, "text": f"span {index}"}
            for index in range(8)
        ]
        atlas = {
            "spans": rows,
            "maps": [
                {"id": "concentrated", "representation": "raw", "geometry": "spherical",
                 "pcaDimensions": 2, "clusterCount": 2,
                 "labels": [0, 0, 0, 0, 1, 1, 1, 1]},
                {"id": "diffuse", "representation": "raw", "geometry": "spherical",
                 "pcaDimensions": 2, "clusterCount": 2,
                 "labels": [0, 1, 0, 1, 0, 1, 0, 1]},
            ],
        }
        matches = [
            {"phraseIndex": index, "videoId": f"v{index}", "allSpanIndex": index,
             "candidateIndex": None}
            for index in range(4)
        ]
        scored = score_frozen_maps(
            {"all-contiguous-spans": atlas}, matches, bootstrap_repeats=8
        )
        self.assertEqual(scored["winner"]["mapId"], "concentrated")
        self.assertEqual(scored["winner"]["cluster"], 0)
        self.assertAlmostEqual(scored["winner"]["manualRecall"], 1.0)
        self.assertEqual(scored["winner"]["atlasPopulation"], 8)
        self.assertAlmostEqual(scored["winner"]["atlasBaseRate"], 0.5)
        self.assertAlmostEqual(scored["winner"]["enrichment"], 2.0)


if __name__ == "__main__":
    unittest.main()
