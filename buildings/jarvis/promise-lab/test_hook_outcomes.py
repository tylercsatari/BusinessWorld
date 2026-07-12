import unittest

import numpy as np

from hook_outcomes import (
    apply_duration_baseline,
    apply_rewatch_kernel,
    crossfit_linear,
    curve_validation,
    fit_duration_baseline,
    fit_rewatch_kernel,
    fit_full_linear,
    per_second_survival,
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

    def test_rewatch_kernel_starts_at_one_and_never_increases(self):
        rng = np.random.default_rng(17)
        times = np.arange(0, 5.5, .5)
        inflation = rng.uniform(0, 35, 60)
        kernel = np.exp(-times)
        base = 100 - 2.2 * times
        curves = base[None, :] + inflation[:, None] * kernel[None, :]
        terminal = rng.uniform(25, 70, 60)
        duration = rng.uniform(25, 70, 60)
        fitted = fit_rewatch_kernel(curves, terminal, duration, times)
        values = np.asarray(fitted["kernel"])
        self.assertAlmostEqual(float(values[0]), 1.0)
        self.assertTrue((np.diff(values) <= 1e-8).all())
        adjusted = apply_rewatch_kernel(curves, values)
        np.testing.assert_allclose(adjusted[:, 0], 100, atol=1e-5)

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
