import unittest

import numpy as np

from variable_horizon_predictor import (
    _predeclared_candidate_gate,
    fit_variable_stage_family,
    fit_variable_temporal_family,
    risk_set_validation,
)


class VariableHorizonPredictorTests(unittest.TestCase):
    def fixture(self):
        rng = np.random.default_rng(9)
        sources = 50
        seconds = np.arange(6, dtype=np.float32)
        chronology = np.asarray([f"2024-{index + 1:03d}" for index in range(sources)])
        base = rng.normal(size=(sources, 8)).astype(np.float32)
        direction = rng.normal(size=8).astype(np.float32)
        signal = base @ direction
        target = np.full((sources, len(seconds)), np.nan, np.float32)
        target[:, 0] = 100.0
        counts = {1: 50, 2: 45, 3: 30, 4: 12, 5: 5}
        features = {}
        for second, count in counts.items():
            selected = np.arange(count)
            target[selected, second] = (
                100.0 - second * 2.0 + signal[selected] * 1.4
                + rng.normal(scale=.15, size=count)
            )
            features[second] = (selected, base[selected])
        return features, target, chronology, seconds

    def test_models_follow_the_at_risk_set_and_never_fill_censored_cells(self):
        features, target, chronology, seconds = self.fixture()
        fitted = fit_variable_temporal_family(
            features, target, chronology, seconds,
            maximum_dimensions=6, minimum_semantic_sources=10,
            minimum_chronological_sources=40, seed=33,
        )
        by_second = {int(row["second"]): row for row in fitted["temporalModels"]}
        self.assertEqual(by_second[1]["supportTier"], "random-and-chronological")
        self.assertEqual(by_second[2]["supportTier"], "random-and-chronological")
        self.assertEqual(by_second[3]["supportTier"], "random-fold-exploratory")
        self.assertEqual(by_second[4]["supportTier"], "random-fold-exploratory")
        self.assertEqual(by_second[5]["supportTier"], "empirical-only")
        self.assertEqual(fitted["semanticModelHorizonSeconds"], 4.0)
        self.assertEqual(fitted["chronologicalValidationHorizonSeconds"], 2.0)
        self.assertTrue(np.isnan(fitted["prediction"][45:, 2]).all())
        self.assertTrue(np.isnan(fitted["prediction"][30:, 3]).all())
        self.assertTrue(np.isnan(fitted["prediction"][:, 5]).all())
        self.assertEqual(by_second[5]["riskSetSources"], 5)

    def test_irregular_validation_is_source_equal_and_reports_every_second(self):
        features, target, chronology, seconds = self.fixture()
        fitted = fit_variable_temporal_family(
            features, target, chronology, seconds,
            maximum_dimensions=6, minimum_semantic_sources=10,
            minimum_chronological_sources=40, seed=44,
        )
        validation = fitted["randomFoldValidation"]
        self.assertEqual(len(validation["perSecond"]), len(seconds))
        self.assertEqual(validation["evaluatedSources"], 50)
        self.assertGreater(validation["evaluatedObservationCells"], 100)
        self.assertEqual(validation["lastEvaluatedSecond"], 4.0)
        self.assertIsNotNone(validation["sourceEqualMAEPercentagePoints"])
        self.assertEqual(
            validation["pairedSourceImprovementInference"]["unit"],
            "one source-level mean absolute error across its observable seconds",
        )

    def test_validation_does_not_require_a_complete_rectangular_curve(self):
        target = np.asarray([[100, 90, np.nan], [100, 80, 70]], float)
        prediction = np.asarray([[100, 88, np.nan], [100, 82, 72]], float)
        baseline = np.asarray([[100, 85, np.nan], [100, 85, 75]], float)
        result = risk_set_validation(
            prediction, target, baseline, np.asarray([0, 1, 2]),
            repeats=32, seed=2,
        )
        self.assertEqual(result["evaluatedObservationCells"], 5)
        self.assertEqual(result["perSecond"][2]["evaluatedSources"], 1)
        self.assertEqual(result["lastEvaluatedSecond"], 2.0)

    def test_fixed_four_cluster_stage_ladder_falls_back_when_gate_fails(self):
        rng = np.random.default_rng(91)
        sources = 50
        seconds = np.arange(0, 4, dtype=np.float32)
        chronology = np.asarray([f"2024-{index:03d}" for index in range(sources)])
        target = np.full((sources, len(seconds)), np.nan, np.float32)
        target[:, 0] = 100.0
        features = {}
        for second in range(1, 4):
            count = 50 if second < 3 else 25
            indices = np.arange(count)
            semantic = rng.normal(size=(count, 6)).astype(np.float32)
            components = np.concatenate([
                semantic, rng.normal(size=(count, 4)).astype(np.float32),
            ], axis=1)
            relationships = np.concatenate([
                components, rng.normal(size=(count, 16)).astype(np.float32),
            ], axis=1)
            timing = np.asarray([
                [second, row + 1] for row in range(count)
            ], np.float32)
            features[second] = (indices, {
                "timing": timing,
                "semantic": semantic,
                "components": components,
                "relationships": relationships,
            })
            target[indices, second] = (
                100.0 - 2.0 * second + relationships[:, -1] * 0.5
            )
        result = fit_variable_stage_family(
            features, target, chronology, seconds,
            minimum_semantic_sources=10,
            minimum_chronological_sources=40,
            seed=33,
        )
        self.assertEqual(result["candidateStage"], "relationships")
        self.assertEqual(result["headlineStage"], "baseline")
        self.assertEqual(result["selectedStage"], "baseline")
        self.assertFalse(result["promotion"]["promoted"])
        self.assertEqual(result["stageOrder"], [
            "timing", "semantic", "components", "relationships",
        ])
        self.assertEqual(result["temporalModels"][0]["categories"], 4)
        self.assertEqual(
            result["temporalModels"][2]["supportTier"],
            "random-fold-exploratory",
        )
        self.assertTrue(np.isfinite(result["prediction"][:, 1]).all())
        self.assertTrue(np.isnan(result["prediction"][25:, 3]).all())
        self.assertIn("components", result["stageValidations"])

    def test_predeclared_candidate_requires_both_positive_lower_bounds(self):
        passed = {
            "sourceEqualMAEImprovementFraction": 0.1,
            "pairedSourceImprovementInference": {
                "meanMAEImprovement": 0.3, "ciLow": 0.05,
            },
        }
        failed = {
            "sourceEqualMAEImprovementFraction": 0.1,
            "pairedSourceImprovementInference": {
                "meanMAEImprovement": 0.3, "ciLow": -0.01,
            },
        }
        self.assertTrue(_predeclared_candidate_gate(
            "relationships", passed, passed,
        )["promoted"])
        self.assertFalse(_predeclared_candidate_gate(
            "relationships", passed, failed,
        )["promoted"])


if __name__ == "__main__":
    unittest.main()
