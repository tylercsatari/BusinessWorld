import unittest

import numpy as np

from pooled_opening_evaluation import (
    attach_observed_retention,
    baseline_only_analysis,
    candidate_vs_baseline,
    caption_json3_to_timed_words,
    content_fingerprint,
    evaluation_metrics,
    outcome_blind_prediction,
    prediction_fingerprint,
    strict_blind_external_selection,
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
    @staticmethod
    def synthetic_detail(video_id, account_id, evaluation_kind, text,
                         actual_end=48.0, baseline_end=50.0,
                         candidate_end=55.0):
        curves = {}
        for family_name in ("entryIndexed", "observedAbsolute"):
            curves[family_name] = {
                "timesSeconds": [0.0, 20.0],
                "predicted": [100.0, baseline_end],
                "predictionP10": [100.0, baseline_end - 8.0],
                "predictionP90": [100.0, baseline_end + 8.0],
                "actual": [100.0, actual_end],
                "stages": {
                    "baseline": [100.0, baseline_end],
                    "relationships": [100.0, candidate_end],
                },
                "selectedStage": "baseline",
                "candidateStage": "relationships",
            }
        return {
            "videoId": video_id,
            "accountId": account_id,
            "evaluationKind": evaluation_kind,
            "predictionFitKind": "frozen-full-fit",
            "contentFingerprint": content_fingerprint(text),
            "curves": curves,
        }

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

    def test_prediction_seal_is_invariant_to_every_target_outcome_field(self):
        prediction = self.synthetic_detail(
            "external", "account", "cross-account-frozen-full-fit",
            "this is a sealed spoken opening",
        )
        prediction.update({
            "actual": {"views": 10},
            "predictionError": {"retainedAt20sPoints": 2.0},
            "observedCurves": {"entryIndexed": {"actual": [100.0, 48.0]}},
            "components": [{
                "text": "sealed spoken opening",
                "measurements": {"0": {"deltaPercentagePoints": -9.0}},
                "outcomePlane": {
                    "predictedRetentionSlopePercentagePointsPerSecond": -2.0,
                    "observedSlopePercentagePointsPerSecond": -99.0,
                },
                "timelineAttribution": {
                    "predictedDeltaPoints": -2.0,
                    "observedDeltaPoints": -99.0,
                },
            }],
            "support": {"fullObservedDurationSeconds": 99.0},
            "temporalAttribution": {
                "summary": {"totalObservedDeltaPoints": -99.0},
            },
        })
        poisoned = dict(prediction)
        poisoned["actual"] = {"views": 999999999}
        poisoned["predictionError"] = {"retainedAt20sPoints": -999.0}
        poisoned["curves"] = {
            name: {**curve, "actual": [100.0, 1.0]}
            for name, curve in prediction["curves"].items()
        }
        self.assertEqual(
            prediction_fingerprint(prediction), prediction_fingerprint(poisoned),
        )
        blind = outcome_blind_prediction(prediction)
        serialized = str(blind)
        for forbidden in (
            "observedSlopePercentagePointsPerSecond", "observedDeltaPoints",
            "totalObservedDeltaPoints", "fullObservedDurationSeconds",
            "measurements", "predictionError", "observedCurves",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertNotIn("actual", blind)
        self.assertNotIn("actual", blind["curves"]["entryIndexed"])

    def test_strict_blind_selection_excludes_training_overlap_and_reposts(self):
        rows = [
            self.synthetic_detail(
                "train", "main", "saved-source-level-oof", "same exact spoken text",
            ),
            self.synthetic_detail(
                "overlap", "a", "cross-account-frozen-full-fit",
                "same exact spoken text",
            ),
            self.synthetic_detail(
                "duplicate-b", "b", "cross-account-frozen-full-fit",
                "external repost text here",
            ),
            self.synthetic_detail(
                "duplicate-a", "a", "cross-account-frozen-full-fit",
                "external repost text here",
            ),
            self.synthetic_detail(
                "unique", "a", "cross-account-frozen-full-fit",
                "a wholly unique opening",
            ),
        ]
        selected, audit = strict_blind_external_selection(rows)
        self.assertEqual([row["videoId"] for row in selected], ["duplicate-a", "unique"])
        self.assertEqual(audit["trainingContentOverlapExcluded"], 1)
        self.assertEqual(audit["externalDuplicateGroupsCollapsed"], 1)
        self.assertEqual(audit["externalDuplicateVideosCollapsed"], 1)

    def test_fixed_horizon_reports_uncertainty_and_no_constant_ranking(self):
        rows = [
            self.synthetic_detail(
                f"v{index}", "a", "cross-account-frozen-full-fit",
                f"unique opening number {index}", actual_end=actual,
            )
            for index, actual in enumerate((42.0, 48.0, 54.0, 60.0))
        ]
        metrics = evaluation_metrics(rows)
        fixed = metrics["fixed20Second"]
        self.assertEqual(fixed["discriminationStatus"],
                         "unavailable-constant-prediction")
        self.assertEqual(fixed["predictedStandardDeviationPercent"], 0.0)
        self.assertIsNotNone(fixed["maeConfidence95"])
        self.assertIsNotNone(fixed["predictionBandCoverageWilson95"])
        self.assertIsNotNone(metrics["sourceEqualCurveMAEConfidence95"])

    def test_candidate_diagnostic_never_promotes_the_candidate(self):
        rows = [
            self.synthetic_detail(
                f"v{index}", "a", "cross-account-frozen-full-fit",
                f"candidate diagnostic text {index}", actual_end=48.0,
                baseline_end=50.0, candidate_end=70.0,
            )
            for index in range(4)
        ]
        result = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        self.assertLess(result["pairedImprovementPercentagePoints"], 0.0)
        self.assertFalse(result["modelStageChanged"])
        self.assertEqual(result["candidateWinFraction"], 0.0)


if __name__ == "__main__":
    unittest.main()
