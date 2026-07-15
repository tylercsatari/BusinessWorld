import unittest

import numpy as np

from pooled_opening_evaluation import (
    attach_observed_retention,
    baseline_only_analysis,
    caption_json3_to_timed_words,
    evaluation_metrics,
    token_clock_from_timed_words,
)
from score_hook import _variable_curve_payload


STAGES = ("timing", "semantic", "components", "relationships")


def compact_model(intercept):
    return {"coefficient": [0.0], "intercept": [float(intercept)]}


def family(selected="baseline"):
    return {
        "timeZeroMean": 100.0,
        "headlineStage": selected,
        "selectedStage": selected,
        "candidateStage": "relationships",
        "stageOrder": list(STAGES),
        "temporalModels": [{
            "second": float(second),
            "baselineMean": 100.0 - 5.0 * second,
            "headlineModelAvailable": True,
            "residualP10": -2.0,
            "residualP90": 3.0,
            "stages": {
                stage: {"model": compact_model(80 - second - index)}
                for index, stage in enumerate(STAGES)
            },
        } for second in range(1, 6)],
    }


class PooledOpeningEvaluationTest(unittest.TestCase):
    def test_json3_caption_offsets_become_monotonic_exact_token_clock(self):
        payload = {"events": [
            {"tStartMs": 500, "segs": [
                {"utf8": "This"},
                {"utf8": " works", "tOffsetMs": 300},
            ]},
            {"tStartMs": 900, "aAppend": 1, "segs": [{"utf8": "\n"}]},
            {"tStartMs": 1100, "segs": [
                {"utf8": "very"},
                {"utf8": " well", "tOffsetMs": 250},
            ]},
        ]}
        transcript = caption_json3_to_timed_words(payload, media_duration=3.0)
        self.assertEqual(transcript["text"], "This works very well")
        clock = token_clock_from_timed_words(transcript["text"], transcript["words"])
        self.assertEqual(len(clock), 4)
        self.assertTrue(all(left["endSeconds"] <= right["startSeconds"]
                            for left, right in zip(clock, clock[1:])))

    def test_caption_words_never_extend_past_media_duration(self):
        payload = {"events": [
            {"tStartMs": 900, "segs": [{"utf8": "last"}]},
            {"tStartMs": 1200, "segs": [{"utf8": "outside"}]},
        ]}
        transcript = caption_json3_to_timed_words(payload, media_duration=1.0)
        self.assertEqual(transcript["text"], "last")
        self.assertLessEqual(transcript["spokenEndSeconds"], 1.0)

    def test_duration_only_curve_is_exact_selected_baseline(self):
        retention_model = {
            "version": 3,
            "analysisHorizonSeconds": 5.0,
            "support": {"semanticModelHorizonSeconds": 5.0},
            "families": {"entryIndexed": family(), "observedAbsolute": family()},
        }
        baseline = baseline_only_analysis(
            {"duration_s": 3.5}, retention_model, "private video",
        )
        features = {
            float(second): {
                stage: np.asarray([1.0], np.float32) for stage in STAGES
            }
            for second in range(1, 4)
        }
        features[3.5] = {
            stage: np.asarray([1.0], np.float32) for stage in STAGES
        }
        full = _variable_curve_payload(
            features, retention_model, 3.5,
        )["entryIndexed"]
        self.assertEqual(
            baseline["curves"]["entryIndexed"]["timesSeconds"],
            full["timesSeconds"],
        )
        np.testing.assert_allclose(
            baseline["curves"]["entryIndexed"]["predicted"], full["predicted"],
        )
        self.assertTrue(baseline["provenance"]["outcomesUsedForPrediction"] is False)

    def test_duration_only_fallback_refuses_a_promoted_semantic_stage(self):
        retention_model = {
            "analysisHorizonSeconds": 5.0,
            "support": {"semanticModelHorizonSeconds": 5.0},
            "families": {"entryIndexed": family("semantic")},
        }
        with self.assertRaisesRegex(RuntimeError, "duration-only fallback is invalid"):
            baseline_only_analysis({"duration_s": 3.0}, retention_model, "missing")

    def test_observed_curve_is_joined_after_prediction_and_scored(self):
        retention_model = {
            "analysisHorizonSeconds": 5.0,
            "support": {"semanticModelHorizonSeconds": 5.0},
            "families": {"entryIndexed": family(), "observedAbsolute": family()},
        }
        prediction = baseline_only_analysis(
            {"duration_s": 3.0}, retention_model, "missing",
        )
        detail = attach_observed_retention(prediction, {
            "duration_s": 3.0,
            "curve": [1.2, 1.0, 0.9, 0.8],
            "views": 1234,
        })
        self.assertTrue(detail["actual"]["joinedAfterInference"])
        self.assertFalse(detail["provenance"]["observedCurveUsedForPrediction"])
        self.assertEqual(detail["actual"]["curveSourcePoints"], 4)
        self.assertEqual(
            detail["observedCurves"]["entryIndexed"]["timesSeconds"],
            [0.0, 1.0, 2.0, 3.0],
        )
        self.assertEqual(len(detail["observedCurves"]["observedAbsolute"]["actual"]), 4)
        metrics = evaluation_metrics([detail])
        self.assertEqual(metrics["videos"], 1)
        self.assertGreaterEqual(metrics["cellWeightedCurveMAEPercentagePoints"], 0.0)
        self.assertTrue(metrics["contract"]["sameFrozenModelAsTypedScorer"])

    def test_unsupported_trailing_null_is_not_coerced_to_zero(self):
        prediction = {
            "curves": {
                "entryIndexed": {
                    "timesSeconds": [0.0, 1.0, 2.0],
                    "predicted": [100.0, 80.0, None],
                    "predictionP10": [100.0, 75.0, None],
                    "predictionP90": [100.0, 85.0, None],
                },
                "observedAbsolute": {
                    "timesSeconds": [0.0, 1.0, 2.0],
                    "predicted": [120.0, 96.0, None],
                    "predictionP10": [120.0, 90.0, None],
                    "predictionP90": [120.0, 102.0, None],
                },
            },
            "outputs": {"forecastEndSeconds": 1.0},
        }
        detail = attach_observed_retention(prediction, {
            "duration_s": 2.0, "curve": [1.0, 0.9, 0.8], "views": 10,
        })
        self.assertEqual(detail["actual"]["forecastEndSeconds"], 1.0)
        self.assertEqual(detail["predictionError"]["retainedAtForecastEndPoints"], -10.0)
        self.assertEqual(evaluation_metrics([detail])["videos"], 1)

    def test_accuracy_excludes_deterministic_time_zero_anchor(self):
        detail = {
            "evaluationKind": "cross-account-frozen-full-fit",
            "curves": {
                family_name: {
                    "timesSeconds": [0.0, 1.0],
                    "predicted": [100.0, 80.0],
                    "predictionP10": [100.0, 70.0],
                    "predictionP90": [100.0, 90.0],
                    "actual": [100.0, 70.0],
                }
                for family_name in ("entryIndexed", "observedAbsolute")
            },
        }
        metrics = evaluation_metrics([detail])
        self.assertEqual(metrics["sourceEqualCurveMAEPercentagePoints"], 10.0)
        self.assertTrue(metrics["contract"]["timeZeroExcludedFromAccuracy"])
        self.assertEqual(metrics["families"]["observedAbsolute"]["metricFamily"],
                         "observedAbsolute")
        self.assertIsNone(metrics["endpointPearson"])


if __name__ == "__main__":
    unittest.main()
