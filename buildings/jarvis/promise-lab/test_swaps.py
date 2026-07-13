import unittest

import numpy as np

from swaps import (
    build_dual_scope_swap_plan, build_swap_plan, coassociation_rows, crossed_effects,
    routing_input_signature,
)


class SwapTests(unittest.TestCase):
    def test_routing_signature_changes_with_every_routing_input_family(self):
        candidates = [{
            "id": "a", "videoId": "v", "text": "alpha", "hookText": "alpha beta",
            "start": 0, "end": 1, "selectedExploratory": True,
        }]
        spans = [{
            "id": "a", "videoId": "v", "text": "alpha", "hookText": "alpha beta",
            "start": 0, "end": 1,
        }]
        maps = [{"id": "m", "labels": [0], "qualityForBrowsing": 1.0}]
        influence = np.asarray([[1.0, 0.0]], np.float32)
        contract = {"version": "one"}
        baseline = routing_input_signature(
            candidates, maps, influence, spans, maps, influence, contract,
        )
        changed_text = routing_input_signature(
            [{**candidates[0], "text": "changed"}], maps, influence,
            spans, maps, influence, contract,
        )
        changed_map = routing_input_signature(
            candidates, [{**maps[0], "qualityForBrowsing": 2.0}], influence,
            spans, maps, influence, contract,
        )
        changed_vector = routing_input_signature(
            candidates, maps, np.asarray([[0.0, 1.0]], np.float32),
            spans, maps, influence, contract,
        )
        self.assertEqual(len({baseline, changed_text, changed_map, changed_vector}), 4)

    def test_vectorized_coassociation_matches_direct_weighted_comparison(self):
        labels = np.asarray([
            [0, 0, 1, 1, 2],
            [0, 1, 1, 2, 0],
            [2, 2, 1, 0, 0],
        ])
        weights = np.asarray([.2, .3, .5])
        sources = [1, 4]
        actual = coassociation_rows(labels, weights, sources)
        expected = np.asarray([
            [sum(weight for row, weight in zip(labels, weights) if row[source] == row[target])
             for target in range(labels.shape[1])]
            for source in sources
        ])
        np.testing.assert_allclose(actual, expected)

    def test_routing_uses_discovered_maps_not_position(self):
        candidates = [
            {"id": "a", "videoId": "v1", "text": "alpha", "hookText": "alpha beta",
             "start": 0, "end": 1, "selectedExploratory": True},
            {"id": "b", "videoId": "v1", "text": "beta", "hookText": "alpha beta",
             "start": 1, "end": 2, "selectedExploratory": True},
            {"id": "c", "videoId": "v2", "text": "gamma", "hookText": "gamma delta",
             "start": 0, "end": 1, "selectedExploratory": True},
            {"id": "d", "videoId": "v2", "text": "delta", "hookText": "gamma delta",
             "start": 1, "end": 2, "selectedExploratory": True},
        ]
        maps = [{"labels": [0, 1, 1, 0], "qualityForBrowsing": .5}]
        influence = np.eye(4, dtype=np.float32)
        plan = build_swap_plan(candidates, maps, influence)
        routed = next(row for row in plan if row["sourceId"] == "a" and row["targetVideoId"] == "v2")
        self.assertEqual(routed["targetId"], "d")
        self.assertFalse(routed["routingUsesOutcomes"])
        self.assertTrue(all(row["recomposedText"] == row["targetHookText"]
                            for row in plan if row["identity"]))

    def test_crossed_decomposition_recovers_source_delta(self):
        matrix = np.asarray([[10, 20, 30], [12, 22, 32]], float)
        result = crossed_effects(matrix, np.asarray([10, 20, 30], float))
        np.testing.assert_allclose(result["sourceTransferMeanDelta"], [0, 2])

    def test_dual_scope_routing_can_select_non_boundary_span(self):
        candidates = [
            {"id": "a", "videoId": "v1", "text": "alpha", "hookText": "alpha beta",
             "start": 0, "end": 1, "selectedExploratory": True},
            {"id": "c", "videoId": "v2", "text": "gamma", "hookText": "gamma delta",
             "start": 0, "end": 1, "selectedExploratory": True},
        ]
        spans = [
            {"id": "a", "videoId": "v1", "text": "alpha", "hookText": "alpha beta",
             "start": 0, "end": 1},
            {"id": "ab", "videoId": "v1", "text": "alpha beta", "hookText": "alpha beta",
             "start": 0, "end": 2},
            {"id": "c", "videoId": "v2", "text": "gamma", "hookText": "gamma delta",
             "start": 0, "end": 1},
            {"id": "cd", "videoId": "v2", "text": "gamma delta", "hookText": "gamma delta",
             "start": 0, "end": 2},
        ]
        candidate_maps = [{"labels": [0, 1], "qualityForBrowsing": 1.0}]
        all_maps = [{"labels": [0, 1, 1, 0], "qualityForBrowsing": 1.0}]
        candidate_influence = np.eye(2, dtype=np.float32)
        all_influence = np.eye(4, dtype=np.float32)
        plan = build_dual_scope_swap_plan(
            candidates, candidate_maps, candidate_influence,
            spans, all_maps, all_influence,
        )
        routed = next(row for row in plan if row["sourceId"] == "a"
                      and row["targetVideoId"] == "v2")
        self.assertEqual(routed["targetId"], "cd")
        self.assertEqual(routed["routingUniverse"], "all-contiguous-spans")
        self.assertIsNone(routed["candidateAtlasCoassociation"])
        self.assertFalse(routed["routingUsesOutcomes"])
        identity = next(row for row in plan if row["sourceId"] == "a"
                        and row["targetVideoId"] == "v1")
        self.assertEqual(identity["targetId"], "a")
        self.assertTrue(identity["identityControl"])
        self.assertEqual(identity["recomposedText"], identity["targetHookText"])


if __name__ == "__main__":
    unittest.main()
