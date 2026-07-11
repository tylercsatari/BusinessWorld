import unittest

import numpy as np

from cluster_outcomes import retention_window_slope
from latency_study import (
    WindowSpec,
    baseline_audit,
    lag_family_inference,
    natural_drop_features,
    natural_baseline_oof,
    retention_slope_matrix,
    shared_lag_semantic_oof,
    transfer_correlation_matrix,
    window_intervals,
)


class LatencyStudyTests(unittest.TestCase):
    def test_window_alignment_keeps_phrase_onset_and_offset_distinct(self):
        starts = np.asarray([2.0, 5.0])
        ends = np.asarray([4.0, 8.0])
        lags = np.asarray([-1.0, 0.0, 2.0])
        phrase = WindowSpec("phrase", "phrase", "phrase", None, "")
        onset = WindowSpec("onset", "onset", "onset", 1.0, "")
        offset = WindowSpec("offset", "offset", "offset", 1.0, "")
        phrase_start, phrase_end = window_intervals(starts, ends, lags, phrase)
        onset_start, onset_end = window_intervals(starts, ends, lags, onset)
        offset_start, offset_end = window_intervals(starts, ends, lags, offset)
        np.testing.assert_allclose(phrase_start[0], [1, 2, 4])
        np.testing.assert_allclose(phrase_end[0], [3, 4, 6])
        np.testing.assert_allclose(onset_end[0] - onset_start[0], 1)
        np.testing.assert_allclose(offset_start[0], [3, 4, 6])
        np.testing.assert_allclose(offset_end[0], [4, 5, 7])

    def test_vectorized_slopes_match_existing_exact_window_primitive(self):
        duration = 12.0
        curve = np.linspace(1.4, .8, 100) ** 1.1
        starts = np.asarray([1.0, 3.0, 8.0])
        ends = np.asarray([2.5, 5.0, 10.0])
        lags = np.asarray([0.0, 1.0])
        spec = WindowSpec("phrase", "phrase", "phrase", None, "")
        actual, audit = retention_slope_matrix(
            [curve], np.asarray([duration]), starts, ends,
            np.zeros(3, int), lags, spec, samples=21,
        )
        for row, (start, end) in enumerate(zip(starts, ends)):
            for column, lag in enumerate(lags):
                expected = retention_window_slope(
                    curve, duration, start + lag, end + lag, samples=21,
                )
                self.assertAlmostEqual(actual[row, column], expected, places=6)
        self.assertEqual(audit["measured"], [3, 3])

    def test_natural_drop_basis_is_text_free_and_endpoint_optional(self):
        starts = np.asarray([1.0, 2.0])
        ends = np.asarray([2.0, 4.0])
        duration = np.asarray([20.0, 40.0])
        endpoints = [np.asarray([1.4, 1.5]), np.asarray([.7, .8]),
                     np.asarray([.7, .7]), np.asarray([1.3, 1.45])]
        time_only = natural_drop_features(
            starts, ends, duration, *endpoints, include_endpoints=False,
        )
        adjusted = natural_drop_features(
            starts, ends, duration, *endpoints, include_endpoints=True,
        )
        self.assertEqual(time_only.shape, (2, 17))
        self.assertEqual(adjusted.shape, (2, 25))
        np.testing.assert_allclose(adjusted[:, :17], time_only)

    def test_shared_axis_recovers_planted_latency_without_refitting_each_lag(self):
        rng = np.random.default_rng(812)
        groups = np.asarray([f"video-{index // 4}" for index in range(240)])
        features = rng.normal(size=(240, 14)).astype(np.float32)
        starts = rng.uniform(1.5, 7.0, size=240)
        ends = starts + rng.uniform(.7, 1.7, size=240)
        lags = np.asarray([-1.0, 0.0, 1.0, 2.0, 3.0])
        spec = WindowSpec("phrase", "phrase", "phrase", None, "")
        window_start, window_end = window_intervals(starts, ends, lags, spec)
        durations = np.full(240, 20.0)
        entries = rng.normal(1.4, .05, size=240)
        terminals = rng.normal(.7, .04, size=240)
        amplitudes = entries - terminals
        predicted_entries = entries + rng.normal(0, .02, size=240)
        natural = -.08 + .012 * window_start + .02 * (entries - 1.4)[:, None]
        kernel = np.asarray([0.0, .08, .85, .22, .02])
        targets = natural + features[:, [0]] * kernel[None, :] + rng.normal(
            0, .035, size=(240, len(lags))
        )
        result = shared_lag_semantic_oof(
            features, groups, {"phrase": targets.astype(np.float32)},
            {"phrase": (window_start, window_end)}, lags,
            durations, entries, terminals, amplitudes, predicted_entries,
            dimensions=10, folds=5, per_group=4,
        )
        score = result["score"]
        self.assertGreater(abs(np.corrcoef(score, features[:, 0])[0, 1]), .75)
        inference = lag_family_inference(
            score, result["residuals"], groups, lags,
            repeats=64, per_group=4,
        )
        rows = inference["rows"]["phrase"]
        correlations = [rows[str(index)]["rho"] for index in range(len(lags))]
        effects = [rows[str(index)]["effect"] for index in range(len(lags))]
        self.assertEqual(int(np.argmax(effects)), 2)
        self.assertEqual(inference["peakBootstrap"]["phrase"]["observedPeakLag"], 1.0)
        self.assertGreater(correlations[2], .65)
        self.assertLess(abs(correlations[0]), .2)
        self.assertGreater(np.nanmedian(result["foldAxisCosines"]), .5)
        self.assertGreater(result["foldAxisPositivePairFraction"], .8)

        transfer = transfer_correlation_matrix(
            result["transferScores"], result["residuals"]["phrase"],
            groups, per_group=4,
        )
        self.assertEqual(transfer.shape, (5, 5))
        self.assertGreater(transfer[2, 2], .7)

        audit = baseline_audit(
            targets[:, 0], result["baseline"]["phrase"][:, 0], groups,
            per_group=4,
        )
        self.assertEqual(audit["status"], "complete")
        self.assertGreater(audit["spearman"], .05)
        direct_baseline = natural_baseline_oof(
            targets.astype(np.float32), (window_start, window_end), groups,
            durations, entries, terminals, amplitudes, predicted_entries,
            folds=5, per_group=4,
        )
        direct_audit = baseline_audit(
            targets[:, 0], direct_baseline[:, 0], groups, per_group=4,
        )
        self.assertEqual(direct_audit["sourceVideos"], 60)


if __name__ == "__main__":
    unittest.main()
