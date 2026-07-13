import unittest

import numpy as np
from sklearn.model_selection import GroupKFold

from deconfounding import (
    crossfit_natural_baseline,
    family_max_null,
    natural_baseline_features,
    past_trajectory_features,
    retention_curve_families,
    source_equal_weights,
)


class DeconfoundingTests(unittest.TestCase):
    def test_source_weight_is_equal_despite_unequal_component_counts(self):
        groups = np.asarray(["a", "b", "b", "b", "c", "c"])
        weights = source_equal_weights(groups)
        totals = [float(weights[groups == group].sum()) for group in ("a", "b", "c")]
        np.testing.assert_allclose(totals, np.repeat(totals[0], 3), atol=1e-7)

    def test_past_features_cannot_see_a_future_curve_edit(self):
        duration = np.asarray([10.0])
        source = np.asarray([0])
        start = np.asarray([5.0])
        curve = np.linspace(1.2, 0.4, 101)
        edited = curve.copy()
        edited[51:] = np.linspace(0.9, 0.1, 50)
        before = past_trajectory_features([curve], duration, source, start)
        after = past_trajectory_features([edited], duration, source, start)
        np.testing.assert_allclose(before, after, equal_nan=True)

    def test_positive_lag_baseline_still_stops_before_utterance(self):
        duration = np.asarray([10.0])
        source = np.asarray([0])
        curve = np.linspace(1.2, 0.4, 101)
        edited = curve.copy()
        edited[51:] = np.linspace(1.5, 0.1, 50)
        args = (
            source, np.asarray([6.0]), np.asarray([7.0]), duration,
            np.asarray([1.2]), np.asarray([0.4]), np.asarray([0.8]),
        )
        before = natural_baseline_features(
            "past_trajectory", [curve], *args,
            history_starts=np.asarray([5.0]),
        )
        after = natural_baseline_features(
            "past_trajectory", [edited], *args,
            history_starts=np.asarray([5.0]),
        )
        np.testing.assert_allclose(before, after, equal_nan=True)

    def test_missing_past_is_encoded_instead_of_imputed_as_available(self):
        curve = np.linspace(1.2, 0.4, 101)
        features = past_trajectory_features(
            [curve], np.asarray([10.0]), np.asarray([0]), np.asarray([0.05]),
        )
        self.assertEqual(float(features[0, -1]), 0.0)
        self.assertTrue(np.isnan(features[0, 0]))

    def test_normalization_roles_have_declared_entry_behavior(self):
        curve = np.asarray([1.25, 1.0, 0.8, 0.6, 0.5])
        families = retention_curve_families([curve], np.asarray([0.5]))
        self.assertAlmostEqual(float(families["entry_indexed"][0][0]), 1.0)
        self.assertAlmostEqual(float(families["terminal_replay"][0][0]), 1.0)
        self.assertAlmostEqual(float(families["endpoint_affine"][0][0]), 1.0)
        self.assertAlmostEqual(float(families["observed_absolute"][0][0]), 1.25)

    def test_natural_baseline_is_source_grouped_and_category_blind(self):
        rng = np.random.default_rng(14)
        groups = np.repeat(np.arange(24).astype(str), [1, 2, 3, 4] * 6)
        natural = rng.normal(size=(len(groups), 5))
        target = 2 * natural[:, 0] - natural[:, 1] + rng.normal(scale=.05, size=len(groups))
        splits = list(GroupKFold(n_splits=4).split(np.arange(len(groups)), groups=groups))
        result = crossfit_natural_baseline(target, natural, groups, splits)
        self.assertGreater(result["audit"]["sourceMeanSpearman"], .95)
        self.assertTrue(result["audit"]["categoryBlind"])
        for fold, (train, test) in zip(result["audit"]["folds"], splits):
            self.assertTrue(set(groups[train]).isdisjoint(set(groups[test])))
            self.assertEqual(fold["trainSources"], len(set(groups[train])))

    def test_family_null_excludes_unsupported_cells(self):
        rng = np.random.default_rng(31)
        groups = np.repeat(np.arange(40).astype(str), 4)
        categories = np.tile(np.arange(4), 40)
        prediction = rng.normal(size=len(groups))
        supported = rng.normal(size=len(groups))
        unsupported = supported.copy()
        unsupported[categories == 0] = np.nan
        result = family_max_null(
            prediction, [supported, unsupported], groups, categories,
            repeats=32,
        )
        self.assertEqual(result["supportedSpecificationCount"], 1)
        self.assertEqual(result["pvalues"][1], 1.0)


if __name__ == "__main__":
    unittest.main()
