import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from build_pooled_opening_predictions import seal_blind_isolation
from pooled_opening_evaluation import (
    account_balanced_metrics,
    attach_observed_retention,
    baseline_only_analysis,
    blind_manifest_entry,
    candidate_leakage_sensitivity,
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
FIXED_HORIZONS = (5.0, 10.0, 20.0, 30.0)


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
            "text": text,
            "contentFingerprint": content_fingerprint(text),
            "curves": curves,
        }

    @staticmethod
    def synthetic_horizon_detail(video_id, account_id, text, actual,
                                 baseline, candidate):
        if not all(len(values) == len(FIXED_HORIZONS)
                   for values in (actual, baseline, candidate)):
            raise ValueError("fixed-horizon fixtures require 5/10/20/30 values")
        times = [0.0, *FIXED_HORIZONS]
        actual_curve = [100.0, *[float(value) for value in actual]]
        baseline_curve = [100.0, *[float(value) for value in baseline]]
        candidate_curve = [100.0, *[float(value) for value in candidate]]
        curves = {}
        for family_name in ("entryIndexed", "observedAbsolute"):
            curves[family_name] = {
                "timesSeconds": list(times),
                "predicted": list(baseline_curve),
                "predictionP10": [value - 8.0 for value in baseline_curve],
                "predictionP90": [value + 8.0 for value in baseline_curve],
                "actual": list(actual_curve),
                "stages": {
                    "baseline": list(baseline_curve),
                    "relationships": list(candidate_curve),
                },
                "selectedStage": "baseline",
                "candidateStage": "relationships",
            }
        return {
            "videoId": video_id,
            "accountId": account_id,
            "evaluationKind": "cross-account-frozen-full-fit",
            "predictionFitKind": "frozen-full-fit",
            "text": text,
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
            "candidateComparisons": {
                "20": {
                    "actualPercent": 48.0,
                    "candidateErrorPoints": 7.0,
                    "baselineErrorPoints": 2.0,
                },
            },
            "candidateComparisonsByFamily": {
                "entryIndexed": {
                    "20": {
                        "actualPercent": 48.0,
                        "candidateErrorPoints": 7.0,
                    },
                },
            },
        })
        poisoned = dict(prediction)
        poisoned["actual"] = {"views": 999999999}
        poisoned["predictionError"] = {"retainedAt20sPoints": -999.0}
        poisoned["candidateComparisons"] = {
            "20": {
                "actualPercent": 1.0,
                "candidateErrorPoints": 999.0,
                "baselineErrorPoints": -999.0,
            },
        }
        poisoned["candidateComparisonsByFamily"] = {
            "entryIndexed": {
                "20": {
                    "actualPercent": 1.0,
                    "candidateErrorPoints": 999.0,
                },
            },
        }
        poisoned["curves"] = {
            name: {**curve, "actual": [100.0, 1.0]}
            for name, curve in prediction["curves"].items()
        }
        self.assertEqual(
            prediction_fingerprint(prediction), prediction_fingerprint(poisoned),
        )
        blind = outcome_blind_prediction(prediction)
        serialized = json.dumps(blind, sort_keys=True)
        for forbidden in (
            "observedSlopePercentagePointsPerSecond", "observedDeltaPoints",
            "totalObservedDeltaPoints", "fullObservedDurationSeconds",
            "measurements", "predictionError", "observedCurves",
            "candidateComparisons", "candidateComparisonsByFamily",
            "actualPercent", "candidateErrorPoints", "baselineErrorPoints",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertNotIn("actual", blind)
        self.assertNotIn("actual", blind["curves"]["entryIndexed"])
        manifest = json.dumps(blind_manifest_entry(prediction), sort_keys=True)
        for forbidden in (
            "candidateComparisons", "candidateComparisonsByFamily",
            "actualPercent", "candidateErrorPoints", "baselineErrorPoints",
            "pairedImprovementPercentagePoints", "pairedImprovementSignFlipP",
        ):
            self.assertNotIn(forbidden, manifest)

    def test_strict_blind_selection_excludes_training_overlap_and_retains_reposts(self):
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
        self.assertEqual(
            [row["videoId"] for row in selected],
            ["duplicate-a", "duplicate-b", "unique"],
        )
        self.assertEqual(audit["trainingContentOverlapExcluded"], 1)
        self.assertEqual(audit["externalDuplicateGroupsCollapsed"], 1)
        self.assertEqual(audit["externalDuplicateVideosCollapsed"], 1)
        self.assertEqual(audit["strictBlindEligibleVideos"], 3)
        self.assertEqual(audit["strictBlindUniqueComponents"], 2)
        duplicate_rows = [
            row for row in selected if row["videoId"].startswith("duplicate-")
        ]
        self.assertEqual(len(duplicate_rows), 2)
        self.assertEqual(
            len({row["blindContentComponentId"] for row in duplicate_rows}), 1,
        )
        self.assertEqual(
            {row["blindContentComponentSize"] for row in duplicate_rows}, {2},
        )
        self.assertEqual(
            {row["blindContentComponentMemberIndex"] for row in duplicate_rows},
            {0, 1},
        )
        self.assertAlmostEqual(sum(
            row["blindContentComponentWeight"] for row in duplicate_rows
        ), 1.0)

    def test_strict_blind_selection_excludes_transcription_near_duplicates(self):
        training_text = (
            "this high powered laser can cut through metal so today I will test "
            "exactly how dangerous it becomes when the power reaches maximum output "
            "using three materials while every camera records the complete experiment"
        )
        near_training = training_text.replace("today", "now")
        external_a = (
            "a customer ordered this unusual silver ring and making the hidden "
            "mechanism required every tool in my workshop before sunrise today "
            "because each moving part had to fit inside one impossibly small space"
        )
        external_b = external_a.replace("unusual", "strange")
        rows = [
            self.synthetic_detail(
                "train", "main", "saved-source-level-oof", training_text,
            ),
            self.synthetic_detail(
                "near-train", "a", "cross-account-frozen-full-fit", near_training,
            ),
            self.synthetic_detail(
                "near-external-b", "b", "cross-account-frozen-full-fit", external_b,
            ),
            self.synthetic_detail(
                "near-external-a", "a", "cross-account-frozen-full-fit", external_a,
            ),
            self.synthetic_detail(
                "unique", "a", "cross-account-frozen-full-fit",
                "a completely separate opening about painting only with reflected light",
            ),
        ]
        selected, audit = strict_blind_external_selection(rows)
        self.assertEqual(
            [row["videoId"] for row in selected],
            ["near-external-a", "near-external-b", "unique"],
        )
        self.assertEqual(audit["nearTrainingContentOverlapExcluded"], 1)
        self.assertEqual(audit["nearExternalDuplicateVideosCollapsed"], 1)
        self.assertEqual(audit["nearDuplicateThreshold"], 0.8)
        self.assertEqual(
            [row["threshold"] for row in audit["nearDuplicateThresholdSensitivity"]],
            [0.7, 0.8, 0.9],
        )
        near_rows = [
            row for row in selected if row["videoId"].startswith("near-external-")
        ]
        self.assertEqual(
            len({row["blindContentComponentId"] for row in near_rows}), 1,
        )
        self.assertAlmostEqual(sum(
            row["blindContentComponentWeight"] for row in near_rows
        ), 1.0)

    def test_unified_near_duplicate_graph_excludes_a_training_connected_chain(self):
        training_tokens = [f"token{index}" for index in range(29)]
        bridge_tokens = list(training_tokens)
        bridge_tokens[5] = "bridgechange"
        tail_tokens = list(bridge_tokens)
        tail_tokens[20] = "tailchange"
        rows = [
            self.synthetic_detail(
                "development", "main", "saved-source-level-oof",
                " ".join(training_tokens),
            ),
            self.synthetic_detail(
                "external-bridge", "a", "cross-account-frozen-full-fit",
                " ".join(bridge_tokens),
            ),
            self.synthetic_detail(
                "external-tail", "b", "cross-account-frozen-full-fit",
                " ".join(tail_tokens),
            ),
            self.synthetic_detail(
                "clean", "c", "cross-account-frozen-full-fit",
                "an unrelated clean opening about restoring a century old clock",
            ),
        ]
        selected, audit = strict_blind_external_selection(rows)
        self.assertEqual([row["videoId"] for row in selected], ["clean"])
        self.assertEqual(
            audit["nearTrainingContentOverlapVideoIds"],
            ["external-bridge", "external-tail"],
        )
        self.assertEqual(audit["nearTrainingContentOverlapExcluded"], 2)
        matches = {
            row["videoId"]: row for row in audit["nearTrainingMatches"]
        }
        self.assertEqual(matches["external-bridge"]["connection"], "direct")
        self.assertEqual(matches["external-tail"]["connection"], "component-chain")
        self.assertLess(matches["external-tail"]["trigramJaccard"], 0.8)

    def test_identity_unverifiable_external_rows_are_excluded(self):
        rows = [
            self.synthetic_detail(
                "too-short", "a", "cross-account-frozen-full-fit", "two words",
            ),
            self.synthetic_detail(
                "clean", "a", "cross-account-frozen-full-fit",
                "this opening has enough distinct words to verify its identity",
            ),
        ]
        selected, audit = strict_blind_external_selection(rows)
        self.assertEqual([row["videoId"] for row in selected], ["clean"])
        self.assertEqual(audit["identityUnverifiableVideos"], 1)
        self.assertEqual(audit["identityUnverifiableVideoIds"], ["too-short"])
        self.assertNotIn("too-short", audit["primaryVideoIds"])

    def test_outcome_free_component_metadata_is_sealed_with_blind_predictions(self):
        rows = [
            self.synthetic_detail(
                video_id, account_id, "cross-account-frozen-full-fit",
                "the same clean external opening is reposted word for word",
                actual_end=actual,
            )
            for video_id, account_id, actual in (
                ("repost-a", "a", 10.0),
                ("repost-b", "b", 90.0),
            )
        ]
        selected, _ = strict_blind_external_selection(rows)
        isolation_keys = (
            "blindContentComponentId", "blindContentComponentSize",
            "blindContentComponentWeight", "blindContentComponentMemberIndex",
        )
        blind_predictions = [outcome_blind_prediction(row) for row in rows]
        with TemporaryDirectory() as temporary_directory:
            seal_blind_isolation(blind_predictions, Path(temporary_directory))
        for row in blind_predictions:
            blind = outcome_blind_prediction(row)
            manifest = blind_manifest_entry(row)
            primary = row["blindIsolationPrimary"]
            self.assertTrue(primary["eligible"])
            self.assertEqual(primary["status"], "strict-blind-content-component")
            self.assertFalse(row["provenance"]["blindIsolationUsesOutcomeFields"])
            self.assertTrue(
                row["provenance"]["blindIsolationSealedBeforeOutcomeJoin"]
            )
            for key in isolation_keys:
                self.assertEqual(blind[key], row[key])
            for key in isolation_keys[:3]:
                self.assertEqual(manifest[key], row[key])
            self.assertEqual(
                manifest["blindIsolationPrimary"], row["blindIsolationPrimary"],
            )
            self.assertEqual(
                manifest["blindIsolationPolicies"], row["blindIsolationPolicies"],
            )
            self.assertEqual(
                primary["contentComponentMemberIndex"],
                row["blindContentComponentMemberIndex"],
            )

        poisoned_rows = [{
            **row,
            "actual": {"views": index * 999999},
            "candidateComparisons": {
                "20": {"actualPercent": index, "candidateErrorPoints": -index},
            },
        } for index, row in enumerate(rows, start=1)]
        poisoned_selected, _ = strict_blind_external_selection(poisoned_rows)
        metadata = lambda values: {
            row["videoId"]: tuple(row[key] for key in isolation_keys)
            for row in values
        }
        self.assertEqual(metadata(selected), metadata(poisoned_selected))

    def test_evaluation_and_candidate_diagnostics_use_component_weights(self):
        rows = [
            self.synthetic_detail(
                video_id, "a", "cross-account-frozen-full-fit", text,
                actual_end=actual, baseline_end=50.0, candidate_end=actual,
            )
            for video_id, text, actual in (
                ("duplicate-a", "shared duplicate opening words", 50.0),
                ("duplicate-b", "shared duplicate opening words", 30.0),
                ("unique", "a separate clean opening with other words", 10.0),
            )
        ]
        for row, (component_id, size, weight, member_index) in zip(rows, (
            ("duplicate-component", 2, 0.5, 0),
            ("duplicate-component", 2, 0.5, 1),
            ("unique-component", 1, 1.0, 0),
        )):
            row.update({
                "blindContentComponentId": component_id,
                "blindContentComponentSize": size,
                "blindContentComponentWeight": weight,
                "blindContentComponentMemberIndex": member_index,
            })

        metrics = evaluation_metrics(rows)
        self.assertEqual(metrics["videos"], 3)
        self.assertAlmostEqual(
            metrics["sourceEqualCurveMAEPercentagePoints"], 25.0,
        )
        self.assertAlmostEqual(
            metrics["cellWeightedCurveMAEPercentagePoints"], 25.0,
        )
        self.assertAlmostEqual(metrics["fixed20Second"]["maePercentagePoints"], 25.0)
        self.assertAlmostEqual(metrics["fixed20Second"]["biasPercentagePoints"], 25.0)

        candidate = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        self.assertAlmostEqual(
            candidate["baselineCurveMAEPercentagePoints"], 25.0,
        )
        self.assertAlmostEqual(candidate["candidateCurveMAEPercentagePoints"], 0.0)
        self.assertAlmostEqual(candidate["pairedImprovementPercentagePoints"], 25.0)
        self.assertEqual(candidate["contentComponents"], 2)
        self.assertEqual(
            candidate["statisticalUnit"], "outcome-free content component",
        )
        self.assertAlmostEqual(candidate["candidateWinFraction"], 0.75)
        self.assertAlmostEqual(
            candidate["fixed20Second"]["pairedImprovementPercentagePoints"], 25.0,
        )
        self.assertEqual(candidate["fixed20Second"]["contentComponents"], 2)

    def test_component_loss_is_averaged_before_components_so_errors_cannot_cancel(self):
        rows = [
            self.synthetic_detail(
                "repost-low", "a", "cross-account-frozen-full-fit",
                "the same reposted opening has enough words", actual_end=30.0,
                baseline_end=50.0, candidate_end=40.0,
            ),
            self.synthetic_detail(
                "repost-high", "b", "cross-account-frozen-full-fit",
                "the same reposted opening has enough words", actual_end=70.0,
                baseline_end=50.0, candidate_end=60.0,
            ),
        ]
        for index, row in enumerate(rows):
            row.update({
                "blindContentComponentId": "one-repost-component",
                "blindContentComponentSize": 2,
                "blindContentComponentWeight": 0.5,
                "blindContentComponentMemberIndex": index,
            })

        metrics = evaluation_metrics(rows)["fixed20Second"]
        self.assertEqual(metrics["contentComponents"], 1)
        self.assertAlmostEqual(metrics["predictedMeanPercent"], 50.0)
        self.assertAlmostEqual(metrics["actualMeanPercent"], 50.0)
        self.assertAlmostEqual(metrics["maePercentagePoints"], 20.0)

        candidate = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        fixed = candidate["fixed20Second"]
        self.assertAlmostEqual(fixed["baselineMAEPercentagePoints"], 20.0)
        self.assertAlmostEqual(fixed["candidateMAEPercentagePoints"], 10.0)
        self.assertAlmostEqual(fixed["pairedImprovementPercentagePoints"], 10.0)

    def test_account_balanced_diagnostics_are_equal_account_macros(self):
        rows = [
            self.synthetic_detail(
                "account-a-only", "a", "cross-account-frozen-full-fit",
                "one clean opening for account a", actual_end=50.0,
                candidate_end=40.0,
            ),
            *[
                self.synthetic_detail(
                    f"account-b-{index}", "b", "cross-account-frozen-full-fit",
                    f"clean opening number {index} for account b", actual_end=40.0,
                    candidate_end=40.0,
                )
                for index in range(3)
            ],
        ]
        pooled = evaluation_metrics(rows)
        diagnostics = account_balanced_metrics(rows)
        family_metrics = diagnostics["families"]["entryIndexed"]
        self.assertEqual(diagnostics["accountCount"], 2)
        self.assertEqual(
            [(row["accountId"], row["videos"])
             for row in family_metrics["accounts"]],
            [("a", 1), ("b", 3)],
        )
        self.assertAlmostEqual(
            pooled["sourceEqualCurveMAEPercentagePoints"], 7.5,
        )
        self.assertAlmostEqual(
            family_metrics["macroSourceEqualCurveMAEPercentagePoints"], 5.0,
        )
        self.assertAlmostEqual(
            family_metrics["macroFixed20MAEPercentagePoints"], 5.0,
        )
        candidate = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        self.assertAlmostEqual(candidate["pairedImprovementPercentagePoints"], 5.0)
        self.assertAlmostEqual(
            candidate["equalAccountMacro"]["baselineCurveMAEPercentagePoints"],
            5.0,
        )
        self.assertAlmostEqual(
            candidate["equalAccountMacro"]["candidateCurveMAEPercentagePoints"],
            5.0,
        )
        self.assertAlmostEqual(
            candidate["equalAccountMacro"]["pairedImprovementPercentagePoints"],
            0.0,
        )

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
                f"candidate diagnostic text {index}", actual_end=45.0 + index,
                baseline_end=50.0, candidate_end=70.0 - index,
            )
            for index in range(4)
        ]
        result = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        self.assertLess(result["pairedImprovementPercentagePoints"], 0.0)
        self.assertFalse(result["modelStageChanged"])
        self.assertEqual(result["candidateWinFraction"], 0.0)
        fixed = result["fixed20Second"]
        self.assertEqual(fixed["blindSkillStatus"], "no-confirmed-positive-skill")
        self.assertIsNotNone(
            fixed["accountStratifiedPositivePearsonPermutationP"]
        )
        self.assertFalse(fixed["modelStageChanged"])

    def test_candidate_uses_separate_tests_with_holm_adjustment_by_horizon(self):
        rows = []
        for index in range(8):
            actual = [40.0 + index] * len(FIXED_HORIZONS)
            reverse_rank_candidate = [47.0 - index] * len(FIXED_HORIZONS)
            rows.append(self.synthetic_horizon_detail(
                f"v{index}", "one-account",
                f"unique fixed horizon candidate opening {index}",
                actual=actual,
                baseline=[80.0] * len(FIXED_HORIZONS),
                candidate=reverse_rank_candidate,
            ))

        result = candidate_vs_baseline(rows)["families"]["entryIndexed"]
        self.assertEqual(set(result["fixedHorizons"]), {"5", "10", "20", "30"})
        sign_flip_raw = []
        sign_flip_adjusted = []
        for horizon in ("5", "10", "20", "30"):
            fixed = result["fixedHorizons"][horizon]
            raw_sign_flip = fixed["pairedPositiveSignFlipP"]
            adjusted_sign_flip = fixed["holmAdjustedPairedPositiveSignFlipP"]
            raw_rank = fixed[
                "accountStratifiedPositivePearsonPermutationP"
            ]
            adjusted_rank = fixed["holmAdjustedPositivePearsonPermutationP"]
            self.assertIsNotNone(raw_sign_flip)
            self.assertIsNotNone(raw_rank)
            self.assertGreaterEqual(adjusted_sign_flip + 1e-12, raw_sign_flip)
            self.assertGreaterEqual(adjusted_rank + 1e-12, raw_rank)
            self.assertLessEqual(adjusted_sign_flip, 1.0)
            self.assertLessEqual(adjusted_rank, 1.0)
            sign_flip_raw.append(raw_sign_flip)
            sign_flip_adjusted.append(adjusted_sign_flip)
        self.assertTrue(any(
            adjusted > raw + 1e-12
            for raw, adjusted in zip(sign_flip_raw, sign_flip_adjusted)
        ))

        fixed_20 = result["fixed20Second"]
        self.assertLess(fixed_20["pairedPositiveSignFlipP"], 0.05)
        self.assertGreater(
            fixed_20["accountStratifiedPositivePearsonPermutationP"], 0.05,
        )
        self.assertEqual(
            fixed_20["equalAccountMacro"]["pairedPositiveSignFlipP"],
            fixed_20["pairedPositiveSignFlipP"],
        )
        self.assertTrue(fixed_20["passesErrorGate"])
        self.assertFalse(fixed_20["passesRankingGate"])
        self.assertEqual(fixed_20["blindSkillStatus"], "no-confirmed-positive-skill")

    def test_candidate_leakage_sensitivity_reports_every_policy_without_promotion(self):
        rows = [
            self.synthetic_detail(
                "train", "main", "saved-source-level-oof",
                "one development opening with enough distinct words for trigram matching",
            ),
            *[
                self.synthetic_detail(
                    f"v{index}", "a", "cross-account-frozen-full-fit",
                    f"blind candidate opening number {index} has unique spoken details",
                    actual_end=45.0 + index,
                )
                for index in range(4)
            ],
        ]
        blind_predictions = [outcome_blind_prediction(row) for row in rows]
        with TemporaryDirectory() as temporary_directory:
            seal_blind_isolation(blind_predictions, Path(temporary_directory))
        outcomes_by_id = {row["videoId"]: row["curves"] for row in rows}
        for row in blind_predictions:
            row["curves"] = outcomes_by_id[row["videoId"]]
        result = candidate_leakage_sensitivity(blind_predictions)
        policies = result["families"]["entryIndexed"]["policies"]
        self.assertEqual(
            [row["label"] for row in policies],
            ["exact only", "near 0.90", "near 0.80 · primary", "near 0.70"],
        )
        self.assertTrue(all(row["strictBlindVideos"] == 4 for row in policies))
        self.assertTrue(all(
            row["strictBlindContentComponents"] == 4 for row in policies
        ))
        self.assertTrue(all(row["candidateVideos"] == 4 for row in policies))
        self.assertTrue(all(row["modelStageChanged"] is False for row in policies))
        self.assertFalse(result["modelStageChanged"])

    def test_ui_contract_wires_candidate_horizon_and_leakage_canvases(self):
        source = (
            Path(__file__).resolve().parents[1] / "promise-lab-ui.js"
        ).read_text(encoding="utf-8")
        for canvas, renderer in (
            ("pooled-candidate-horizon", "drawPooledCandidateHorizon"),
            ("pooled-candidate-leakage", "drawPooledCandidateLeakage"),
        ):
            self.assertIn(f'data-pl-canvas="{canvas}"', source)
            self.assertIn(f"function {renderer}(canvas)", source)
            self.assertIn(
                f"kind === '{canvas}') {renderer}(canvas)", source,
            )


if __name__ == "__main__":
    unittest.main()
