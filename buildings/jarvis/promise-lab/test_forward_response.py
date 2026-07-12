import unittest

import numpy as np

from forward_response import (
    ResponseCandidate,
    candidate_intervals,
    category_balanced_spearman,
    combined_component_features,
    crossfit_category_axis,
    interaction_features,
    response_candidates,
    source_signflip,
)


class ForwardResponseTests(unittest.TestCase):
    def test_candidates_are_forward_only_and_shift_the_same_phrase(self):
        candidates = [row for row in response_candidates() if row.anchor == "phrase"]
        self.assertEqual([row.lag for row in candidates], list(np.arange(0, 5.0001, .5)))
        starts = np.asarray([1.0, 3.0])
        ends = np.asarray([2.5, 4.0])
        left, right = candidate_intervals(starts, ends, candidates[2])
        np.testing.assert_allclose(left, starts + 1.0)
        np.testing.assert_allclose(right, ends + 1.0)
        np.testing.assert_allclose(right - left, ends - starts)

    def test_category_balance_gives_each_category_one_vote(self):
        prediction = np.asarray([1, 2, 3, 4, 4, 3, 2, 1], float)
        target = np.asarray([1, 2, 3, 4, 4, 3, 2, 1], float)
        categories = np.asarray([0, 0, 0, 0, 1, 1, 1, 1])
        value, by_category = category_balanced_spearman(
            prediction, target, categories,
        )
        self.assertAlmostEqual(value, 1.0, places=5)
        self.assertEqual(set(by_category), {"0", "1"})

    def test_component_features_preserve_equal_block_energy(self):
        raw = np.asarray([[3.0, 0.0], [0.0, 4.0]])
        influence = np.asarray([[0.0, 5.0], [6.0, 0.0]])
        values = combined_component_features(raw, influence)
        np.testing.assert_allclose(np.linalg.norm(values[:, :2], axis=1), 1 / np.sqrt(2))
        np.testing.assert_allclose(np.linalg.norm(values[:, 2:], axis=1), 1 / np.sqrt(2))

    def test_pair_interaction_removes_additive_singletons(self):
        left = np.asarray([[1.0, 0.0]])
        right = np.asarray([[0.0, 1.0]])
        pair = (left + right) / np.sqrt(2)
        values = interaction_features(pair, left, right)
        self.assertLess(float(np.linalg.norm(values)), 1e-5)

    def test_grouped_crossfit_recovers_category_specific_signal(self):
        rng = np.random.default_rng(7)
        groups = np.repeat(np.arange(80).astype(str), 4)
        categories = np.tile(np.arange(4), 80)
        features = rng.normal(size=(len(groups), 24)).astype(np.float32)
        directions = rng.normal(size=(4, 24))
        directions /= np.linalg.norm(directions, axis=1, keepdims=True)
        target = np.asarray([
            features[index] @ directions[category]
            for index, category in enumerate(categories)
        ]) + rng.normal(scale=.15, size=len(groups))
        natural = rng.normal(size=(len(groups), 5)).astype(np.float32)
        result = crossfit_category_axis(
            features, target, natural, groups, categories,
            dimensions=16, semantic_alpha=1.0,
        )
        self.assertGreater(result["heldoutSpearman"], .65)
        self.assertTrue(all(value > .6 for value in result["heldoutSpearmanByCategory"].values()))
        inference = source_signflip(
            result["prediction"], result["targetResidual"], groups, repeats=512,
        )
        self.assertLess(inference["p"], .01)
        self.assertGreater(inference["ciLow"], 0)

    def test_control_candidate_can_be_constructed_but_not_selected(self):
        control = ResponseCandidate("control", "control", "phrase", None, -1.0)
        left, _ = candidate_intervals(np.asarray([2.0]), np.asarray([3.0]), control)
        self.assertEqual(float(left[0]), 1.0)
        self.assertTrue(all(row.lag >= 0 for row in response_candidates()))


if __name__ == "__main__":
    unittest.main()
