import unittest

import numpy as np

from forward_response import (
    ResponseCandidate,
    candidate_intervals,
    category_balanced_source_inference,
    category_balanced_spearman,
    combined_component_features,
    crossfit_category_axis,
    interaction_features,
    nested_select_candidate,
    response_candidates,
    source_equal_weights,
    weighted_spearman,
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

    def test_category_balance_refuses_a_tiny_cluster(self):
        prediction = np.arange(24, dtype=float)
        target = prediction.copy()
        categories = np.repeat([0, 1], [20, 4])
        groups = np.arange(24).astype(str)
        value, by_category = category_balanced_spearman(
            prediction, target, categories, groups,
            minimum_sources=8, required_categories=(0, 1),
        )
        self.assertTrue(np.isnan(value))
        self.assertIsNone(by_category["1"])

    def test_inference_refuses_a_missing_declared_category(self):
        prediction = np.arange(40, dtype=float)
        target = prediction.copy()
        categories = np.repeat([0, 1], 20)
        categories[-20:] = 1
        target[categories == 1] = np.nan
        inference = category_balanced_source_inference(
            prediction, target, np.arange(40).astype(str), categories,
            repeats=16,
        )
        self.assertIsNone(inference["rho"])
        self.assertIsNone(inference["ciLow"])
        self.assertEqual(inference["p"], 1.0)

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
        inference = category_balanced_source_inference(
            result["prediction"], result["targetResidual"], groups, categories,
            repeats=512,
        )
        self.assertLess(inference["p"], .01)
        self.assertGreater(inference["ciLow"], 0)
        self.assertAlmostEqual(
            inference["rho"], result["heldoutSpearman"], places=6,
        )

    def test_control_candidate_can_be_constructed_but_not_selected(self):
        control = ResponseCandidate("control", "control", "phrase", None, -1.0)
        left, _ = candidate_intervals(np.asarray([2.0]), np.asarray([3.0]), control)
        self.assertEqual(float(left[0]), 1.0)
        self.assertTrue(all(row.lag >= 0 for row in response_candidates()))

    def test_shared_baseline_is_category_blind_and_source_equal(self):
        rng = np.random.default_rng(19)
        groups = np.repeat(np.arange(48).astype(str), 4)
        categories = np.tile(np.arange(4), 48)
        natural = rng.normal(size=(len(groups), 3)).astype(np.float32)
        features = rng.normal(size=(len(groups), 20)).astype(np.float32)
        target = natural[:, 0] + .4 * features[:, 0] + rng.normal(
            scale=.1, size=len(groups),
        )
        result = crossfit_category_axis(
            features, target, natural, groups, categories,
            dimensions=8, semantic_alpha=1.0,
            shared_natural_baseline=True,
        )
        self.assertTrue(result["naturalBaselineCategoryBlind"])
        self.assertTrue(all(
            row["categoryBlind"] for row in result["naturalBaselineFolds"]
        ))
        weights = source_equal_weights(np.asarray(["a", "b", "b", "b"]))
        self.assertAlmostEqual(float(weights[:1].sum()), float(weights[1:].sum()))

    def test_source_duplication_does_not_move_weighted_rank_correlation(self):
        base = weighted_spearman(
            np.asarray([0.0, 1.0, 2.0]), np.asarray([0.0, 1.0, 2.0]),
            np.asarray(["a", "b", "c"]),
        )
        duplicated = weighted_spearman(
            np.asarray([0.0, 1.0, 1.0, 1.0, 2.0]),
            np.asarray([0.0, 1.0, 1.0, 1.0, 2.0]),
            np.asarray(["a", "b", "b", "b", "c"]),
        )
        self.assertAlmostEqual(base, duplicated, places=7)

    def test_nested_selection_returns_row_level_heldout_provenance(self):
        rng = np.random.default_rng(31)
        groups = np.repeat(np.arange(80).astype(str), 4)
        categories = np.tile(np.arange(4), 80)
        features = rng.normal(size=(len(groups), 24)).astype(np.float32)
        signal = features[:, 0] + rng.normal(scale=.1, size=len(groups))
        targets = {
            "lag_0": signal,
            "lag_1": rng.normal(size=len(groups)),
        }
        naturals = {
            key: rng.normal(size=(len(groups), 4)).astype(np.float32)
            for key in targets
        }
        result = nested_select_candidate(
            features, targets, naturals, groups, categories,
            folds=4, inner_folds=3, shared_natural_baseline=True,
        )
        evaluated = np.isfinite(result["prediction"] + result["targetResidual"])
        self.assertTrue(evaluated.any())
        self.assertTrue(np.all(result["foldIndex"][evaluated] >= 0))
        self.assertTrue(np.all(result["selectedCandidateByRow"][evaluated] != ""))
        self.assertTrue(np.isfinite(result["naturalBaselinePrediction"][evaluated]).all())


if __name__ == "__main__":
    unittest.main()
