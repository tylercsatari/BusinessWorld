import unittest

import numpy as np

from hook_outcomes import (
    apply_duration_baseline,
    apply_terminal_conditioned_replay_correction,
    crossfit_linear,
    curve_validation,
    fit_duration_baseline,
    fit_full_linear,
    per_second_survival,
    terminal_conditioned_replay_correction,
)
from hook_score_core import apply_linear_model, outcome_prediction_payload


class HookOutcomeTests(unittest.TestCase):
    def test_compact_direct_model_matches_full_fit_predictions(self):
        rng = np.random.default_rng(41)
        features = rng.normal(size=(80, 24)).astype(np.float32)
        target = features[:, :3] @ np.asarray([1.2, -.7, .4])
        model = fit_full_linear(features, target, dimensions=8, alpha=1, include_map=True)
        direct = apply_linear_model(features, model)[:, 0]
        np.testing.assert_allclose(direct, model["trainingPrediction"][:, 0], atol=1e-5)
        payload = outcome_prediction_payload(features[0], {
            **model,
            "trainingPredictionSorted": np.sort(model["trainingPrediction"][:, 0]).tolist(),
        })
        self.assertTrue(np.isfinite(payload["prediction"]))
        self.assertTrue(np.isfinite(payload["mapY"]))

    def test_grouped_crossfit_keeps_complete_groups_in_one_fold(self):
        rng = np.random.default_rng(7)
        groups = np.repeat(np.arange(30), 4).astype(str)
        features = rng.normal(size=(len(groups), 18)).astype(np.float32)
        target = np.repeat(rng.normal(size=30), 4)
        result = crossfit_linear(features, target, groups=groups, dimensions=6)
        self.assertTrue(np.isfinite(result["prediction"]).all())
        self.assertEqual(len(result["foldModels"]), 5)
        for group in set(groups):
            self.assertEqual(len(set(result["foldIndex"][groups == group])), 1)

    def test_curve_validation_reports_a_real_baseline_comparison(self):
        target = np.asarray([[100, 90, 80], [110, 98, 89], [95, 85, 78]], float)
        prediction = target + np.asarray([[1, -1, 1], [-1, 1, -1], [1, 1, -1]])
        baseline = np.full_like(target, 92)
        result = curve_validation(
            prediction, target, baseline, np.asarray([0, .5, 1]), repeats=128,
        )
        self.assertLess(result["heldoutMAEPercentagePoints"], result["baselineMAEPercentagePoints"])
        self.assertGreater(result["maeImprovementFraction"], 0)
        self.assertEqual(len(result["residualP10ByTime"]), 3)

    def test_terminal_conditioned_correction_is_additive_and_endpoint_anchored(self):
        curves = np.asarray([
            [160, 145, 130, 110, 80],
            [130, 121, 105, 90, 60],
        ], float)
        terminal = np.asarray([80, 60], float)
        correction = terminal_conditioned_replay_correction(curves, terminal)
        adjusted = apply_terminal_conditioned_replay_correction(curves, terminal)
        np.testing.assert_allclose(adjusted, curves - correction, atol=1e-6)
        np.testing.assert_allclose(adjusted[:, 0], 100, atol=1e-6)
        np.testing.assert_allclose(correction[:, 0], [60, 30], atol=1e-6)
        np.testing.assert_allclose(correction[:, -1], 0, atol=1e-6)
        np.testing.assert_allclose(adjusted[:, -1], terminal, atol=1e-6)

    def test_correction_cannot_invent_a_retention_direction_reversal(self):
        curve = np.asarray([155, 138, 142, 118, 90, 70], float)
        adjusted = apply_terminal_conditioned_replay_correction(curve, 70)
        raw_delta = np.diff(curve)
        adjusted_delta = np.diff(adjusted)
        self.assertTrue(np.all(np.sign(raw_delta) == np.sign(adjusted_delta)))
        self.assertFalse(np.any((adjusted_delta > 0) & (raw_delta <= 0)))

    def test_terminal_anchor_changes_the_replay_envelope_without_time_kernel(self):
        curve = np.asarray([160, 140, 120, 100, 80], float)
        lower = terminal_conditioned_replay_correction(curve, 50)
        higher = terminal_conditioned_replay_correction(curve, 75)
        self.assertGreater(float(lower[2]), float(higher[2]))
        self.assertEqual(float(lower[0]), float(higher[0]))

    def test_duration_baseline_and_geometric_carry_are_replayable(self):
        seconds = np.asarray([2, 3, 5, 8, 12], float)
        end = 100 * (.96 ** seconds)
        carry = per_second_survival(end, seconds)
        np.testing.assert_allclose(carry, 96, atol=1e-5)
        model = fit_duration_baseline(seconds, carry)
        replay = apply_duration_baseline(seconds, model)
        self.assertTrue(np.isfinite(replay).all())


if __name__ == "__main__":
    unittest.main()
