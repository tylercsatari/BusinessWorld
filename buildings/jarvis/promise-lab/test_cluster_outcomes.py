import unittest

import numpy as np
from scipy.stats import rankdata

from cluster_outcomes import (
    _signflip_pvalues,
    endpoint_normalize_curve,
    exact_token_timings,
    grouped_baseline_residual,
    grouped_splits,
    prepare_representation_folds,
    prepare_target_folds,
    retention_window_slope,
    search_target_axes,
    span_interval,
)
from sequence import tokenize


class ClusterOutcomeTests(unittest.TestCase):
    def test_exact_timing_maps_split_number_tokens_inside_one_caption_word(self):
        text = "I walked 10,000 steps."
        words = [
            {"w": "I", "t": 0.0, "d": 0.2},
            {"w": "walked", "t": 0.2, "d": 0.4},
            {"w": "10000", "t": 0.6, "d": 0.5},
            {"w": "steps", "t": 1.1, "d": 0.4},
        ]
        timing = exact_token_timings(text, words)
        tokens = tokenize(text)
        self.assertEqual(timing["status"], "exact")
        number_start = next(token.index for token in tokens if token.text == "10")
        number_end = next(token.index for token in tokens if token.text == "000")
        self.assertAlmostEqual(timing["tokenStarts"][number_start], 0.6, places=5)
        self.assertAlmostEqual(timing["tokenEnds"][number_end], 1.1, places=5)
        start, end = span_interval(timing, number_start, number_end + 1)
        self.assertAlmostEqual(start, 0.6, places=5)
        self.assertAlmostEqual(end, 1.1, places=5)

    def test_mismatched_caption_is_excluded_instead_of_approximated(self):
        timing = exact_token_timings(
            "a completely different hook", [{"w": "not", "t": 0, "d": .2}]
        )
        self.assertEqual(timing["status"], "text-mismatch")
        start, end = span_interval(timing, 0, 1)
        self.assertTrue(np.isnan(start))
        self.assertTrue(np.isnan(end))

    def test_punctuation_only_interval_is_missing(self):
        timing = exact_token_timings(
            "hello, world", [
                {"w": "hello", "t": 0.0, "d": .5},
                {"w": "world", "t": .6, "d": .4},
            ]
        )
        comma = next(token.index for token in tokenize("hello, world") if token.text == ",")
        start, end = span_interval(timing, comma, comma + 1)
        self.assertTrue(np.isnan(start))
        self.assertTrue(np.isnan(end))

    def test_endpoint_normalization_has_unit_entry_and_zero_terminal(self):
        curve = np.linspace(1.6, .6, 101)
        normalized, meta = endpoint_normalize_curve(curve)
        self.assertEqual(meta["status"], "complete")
        self.assertAlmostEqual(normalized[0], 1.0, places=7)
        self.assertAlmostEqual(np.mean(normalized[-6:]), 0.0, places=7)
        self.assertLess(retention_window_slope(normalized, 10, 0, 5), 0)

    def test_grouped_baseline_removes_planted_timing_effect_without_group_leakage(self):
        rng = np.random.default_rng(41)
        groups = np.asarray([f"video-{index // 4}" for index in range(160)])
        timing = rng.normal(size=(160, 3)).astype(np.float32)
        target = timing[:, 0] * 2.5 - timing[:, 1] + rng.normal(scale=.03, size=160)
        prediction, residual, audit = grouped_baseline_residual(
            timing, target, groups, folds=5, per_group=4
        )
        valid = np.isfinite(prediction)
        self.assertEqual(audit["status"], "complete")
        self.assertGreater(audit["oofSpearman"], .95)
        self.assertLess(abs(np.corrcoef(residual[valid], timing[valid, 0])[0, 1]), .15)

    def test_grouped_splits_never_mix_source_video(self):
        groups = np.asarray([f"video-{index // 3}" for index in range(60)])
        splits = grouped_splits(groups, folds=5)
        self.assertEqual(len(splits), 5)
        for train, test in splits:
            self.assertFalse(set(groups[train]) & set(groups[test]))
        self.assertEqual(grouped_splits(np.asarray(["only", "only"])), [])

    def test_axis_grid_recovers_a_planted_group_heldout_direction(self):
        rng = np.random.default_rng(73)
        groups = np.asarray([f"video-{index // 3}" for index in range(180)])
        features = rng.normal(size=(180, 12)).astype(np.float32)
        target = features[:, 0] * 1.7 - features[:, 1] * .9 + rng.normal(
            scale=.08, size=180
        )
        splits = grouped_splits(groups, folds=5)
        confounds = {"none": np.empty((180, 0), np.float32)}
        prepared = {
            "raw": prepare_representation_folds(
                features, groups, confounds, splits, max_dimensions=8, per_group=3
            )
        }
        target_folds, target_oof = prepare_target_folds(
            target, groups, confounds["none"], splits, per_group=3
        )
        experiments, selected = search_target_axes(
            prepared, target, target_folds, target_oof, groups, "none",
            [4, 8], [.1, 1], "planted", 0, null_repeats=16
        )
        self.assertEqual(len(experiments), 4)
        self.assertGreater(selected["experiment"]["heldoutSpearman"], .8)

    def test_group_aggregated_sign_flip_matches_direct_row_calculation(self):
        rng = np.random.default_rng(17)
        predictions = rng.normal(size=(3, 48))
        residual = rng.normal(size=48)
        groups = np.asarray([f"video-{index // 4}" for index in range(48)])
        repeats, seed = 32, 91
        actual_p, actual_observed, actual_median = _signflip_pvalues(
            predictions, residual, groups, repeats=repeats, seed=seed
        )
        prediction_rank = np.apply_along_axis(rankdata, 1, predictions)
        prediction_rank = (
            prediction_rank - prediction_rank.mean(axis=1, keepdims=True)
        ) / prediction_rank.std(axis=1, keepdims=True)
        residual_rank = rankdata(residual)
        residual_rank = (residual_rank - residual_rank.mean()) / residual_rank.std()
        expected_observed = np.abs(prediction_rank @ residual_rank / len(residual_rank))
        unique = sorted(set(groups))
        lookup = {group: index for index, group in enumerate(unique)}
        group_positions = np.asarray([lookup[group] for group in groups])
        null_max = []
        null_rng = np.random.default_rng(seed)
        for _ in range(repeats):
            signs = null_rng.choice((-1.0, 1.0), size=len(unique))[group_positions]
            null_y = signs * residual_rank
            null_y = (null_y - null_y.mean()) / null_y.std()
            null_max.append(np.max(np.abs(prediction_rank @ null_y / len(null_y))))
        null_max = np.asarray(null_max)
        expected_p = (
            1 + np.sum(null_max[None, :] >= expected_observed[:, None], axis=1)
        ) / (repeats + 1)
        np.testing.assert_allclose(actual_observed, expected_observed, atol=1e-12)
        np.testing.assert_allclose(actual_p, expected_p, atol=1e-12)
        self.assertAlmostEqual(actual_median, float(np.median(null_max)), places=9)


if __name__ == "__main__":
    unittest.main()
