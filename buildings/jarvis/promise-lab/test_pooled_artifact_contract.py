import gzip
import json
import unittest
from collections import Counter
from copy import deepcopy
from pathlib import Path

from pooled_opening_evaluation import prediction_fingerprint


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip_json(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


class PooledArtifactContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = read_json(
            ROOT / "buildings/jarvis/retention-study/channels.json"
        )
        cls.summary = read_json(CACHE / "pooled-opening-predictions.json")
        cls.blind = read_json(CACHE / "pooled-opening-blind-manifest.json")
        cls.saved = read_json(CACHE / "opening-predictions.json")

    def test_exactly_one_row_per_registered_video(self):
        expected = {}
        for account in self.registry["channels"]:
            table = read_json(
                ROOT / "buildings/jarvis/retention-study" / account["table"]
            )
            for video in table["videos"]:
                video_id = str(video["id"])
                self.assertNotIn(video_id, expected)
                expected[video_id] = account["id"]

        rows = self.summary["rows"]
        actual = {str(row["videoId"]): row["accountId"] for row in rows}
        self.assertEqual(len(actual), len(rows), "pooled rows contain duplicate IDs")
        self.assertEqual(expected, actual)
        self.assertEqual(self.summary["status"], "complete")
        self.assertEqual(self.summary["sources"], len(expected))
        self.assertEqual(self.summary["expectedSources"], len(expected))
        self.assertEqual(self.summary["failures"], [])
        self.assertRegex(self.summary["generationId"], r"^[a-f0-9]{20}$")

    def test_evaluation_provenance_and_account_counts(self):
        rows = self.summary["rows"]
        expected_accounts = Counter(row["accountId"] for row in rows)
        reported_accounts = {
            account["id"]: account["videos"] for account in self.summary["accounts"]
        }
        self.assertEqual(dict(expected_accounts), reported_accounts)

        saved_ids = {str(row["videoId"]) for row in self.saved["rows"]}
        pooled_ids = {str(row["videoId"]) for row in rows}
        self.assertTrue(saved_ids <= pooled_ids)
        self.assertEqual(
            sum(row["evaluationKind"] == "saved-source-level-oof" for row in rows),
            len(saved_ids),
        )
        expected_provenance = {
            "modelRefit": False,
            "modelRecalibrated": False,
            "modelStageChanged": False,
            "outcomesJoinedAfterInference": True,
            "savedCohortPredictionsRemainSourceLevelOOF": True,
            "externalRowsUseFrozenFullFit": True,
            "blindPredictionManifestSealedBeforeOutcomeJoin": True,
            "blindIsolationComputedAndSealedBeforeOutcomeJoin": True,
            "strictBlindMetricsExcludeExactTrainingContentOverlap": True,
            "strictBlindMetricsExcludeNearTrainingContentOverlap": True,
            "strictBlindMetricsWeightExactExternalRepostsAsOneComponent": True,
            "strictBlindMetricsWeightNearExternalRepostsAsOneComponent": True,
        }
        for key, value in expected_provenance.items():
            self.assertEqual(self.summary["provenance"].get(key), value)

        evaluation = self.summary["evaluation"]
        self.assertEqual(evaluation["allPooled"]["videos"], len(rows))
        self.assertEqual(
            evaluation["externalAccounts"]["videos"],
            sum(row["accountId"] != "tyler" for row in rows),
        )
        self.assertIsNotNone(evaluation["externalAccounts"]["fixed20Second"])

    def test_prediction_only_manifest_is_sealed_before_outcomes(self):
        blind = self.blind
        summary_blind = self.summary["blindValidation"]
        self.assertEqual(blind["status"], "sealed-before-outcome-join")
        self.assertEqual(blind["version"], 2)
        self.assertTrue(blind["blindIsolationComputedBeforeOutcomeJoin"])
        self.assertEqual(blind["sources"], len(self.summary["rows"]))
        self.assertEqual(len(blind["entries"]), blind["sources"])
        self.assertFalse(blind["outcomeFieldsPresent"])
        self.assertTrue(blind["predictionInputsExcludeOutcomeFields"])
        self.assertTrue(summary_blind["blindIsolationComputedBeforeOutcomeJoin"])
        self.assertTrue(blind["externalHoldoutIdsDisjoint"])
        self.assertEqual(
            blind["predictionManifestFingerprint"],
            summary_blind["predictionManifestFingerprint"],
        )
        self.assertEqual(blind["blindGenerationId"], summary_blind["blindGenerationId"])
        self.assertEqual(summary_blind["sealedPredictionCount"], 636)
        self.assertEqual(summary_blind["developmentCohortVideos"], 208)
        self.assertEqual(summary_blind["nonDevelopmentVideos"], 428)
        self.assertTrue(summary_blind["nonDevelopmentIdsDisjoint"])
        self.assertEqual(summary_blind["accountExternalVideos"], 425)
        self.assertEqual(summary_blind["externalHoldoutVideos"], 425)

        forbidden = {
            "actual", "predictionError", "observedCurves", "comparisons",
            "comparisonsByFamily", "measurements",
            "observedSlopePercentagePointsPerSecond", "observedDeltaPoints",
            "totalObservedDeltaPoints", "fullObservedDurationSeconds",
            "candidateComparisons", "candidateComparisonsByFamily",
            "candidateAudit",
        }

        def assert_outcome_free(value, path="root"):
            if isinstance(value, dict):
                for key, child in value.items():
                    self.assertNotIn(key, forbidden, f"{path}.{key}")
                    assert_outcome_free(child, f"{path}.{key}")
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    assert_outcome_free(child, f"{path}[{index}]")

        entries = {str(entry["videoId"]): entry for entry in blind["entries"]}
        for entry in entries.values():
            assert_outcome_free(entry)
            self.assertIn("blindIsolationPrimary", entry)
            self.assertIn("blindIsolationPolicies", entry)
        for video_id, entry in entries.items():
            detail = read_gzip_json(
                CACHE / "pooled-opening-blind-predictions" / f"{video_id}.json.gz"
            )
            assert_outcome_free(detail, f"blind-detail[{video_id}]")
            self.assertEqual(
                prediction_fingerprint(detail), entry["predictionFingerprint"],
            )

    def test_primary_blind_cohort_is_component_weighted_and_training_overlap_free(self):
        validation = self.summary["blindValidation"]
        self.assertEqual(validation["nonDevelopmentVideos"], 428)
        self.assertEqual(validation["accountExternalVideos"], 425)
        self.assertEqual(validation["externalHoldoutVideos"], 425)
        self.assertEqual(
            validation["strictBlindEligibleVideos"]
            + validation["trainingContentOverlapExcluded"]
            + validation["identityUnverifiableVideos"],
            validation["externalHoldoutVideos"],
        )
        self.assertEqual(
            validation["strictBlindEligibleVideos"]
            - validation["externalDuplicateVideosCollapsed"],
            validation["strictBlindContentComponents"],
        )
        self.assertIn("Wdvnci3Ucpg", validation["exactTrainingContentOverlapVideoIds"])
        self.assertTrue({"7fspdjqNvxQ", "UbuibdBqUVQ"} <= set(
            validation["nearTrainingContentOverlapVideoIds"]
        ))
        self.assertGreater(validation["identityUnverifiableVideos"], 0)
        self.assertGreater(validation["externalDuplicateGroupsCollapsed"], 0)
        roles = Counter(row["blindEvaluationRole"] for row in self.summary["rows"])
        self.assertEqual(
            roles["strict-blind-primary"], validation["strictBlindEligibleVideos"],
        )
        self.assertEqual(
            roles["excluded-exact-training-content-overlap"],
            validation["exactTrainingContentOverlapExcluded"],
        )
        self.assertEqual(
            roles["excluded-near-training-content-overlap"],
            validation["nearTrainingContentOverlapExcluded"],
        )
        self.assertEqual(
            roles["excluded-identity-unverifiable"],
            validation["identityUnverifiableVideos"],
        )
        self.assertEqual(roles["main-withheld-frozen-evaluation"], 3)

        component_weights = {}
        for row in self.summary["rows"]:
            if not row.get("strictBlindEligible"):
                continue
            component_id = row.get("blindContentComponentId")
            self.assertIsNotNone(component_id)
            component_weights.setdefault(component_id, 0.0)
            component_weights[component_id] += float(
                row.get("blindContentComponentWeight") or 0.0
            )
        self.assertEqual(len(component_weights), validation["strictBlindContentComponents"])
        for component_id, weight in component_weights.items():
            self.assertAlmostEqual(weight, 1.0, msg=component_id)

    def test_strict_blind_metrics_report_uncertainty_and_account_transport(self):
        evaluation = self.summary["evaluation"]
        strict = evaluation["strictBlindExternal"]
        validation = self.summary["blindValidation"]
        self.assertEqual(strict["videos"], validation["strictBlindEligibleVideos"])
        self.assertEqual(
            strict["contentComponents"], validation["strictBlindContentComponents"],
        )
        for family_name, metrics in strict["families"].items():
            with self.subTest(family=family_name):
                self.assertIsNotNone(metrics["sourceEqualCurveMAEConfidence95"])
                self.assertEqual(
                    metrics["contract"]["uncertaintyMethod"],
                    "deterministic 2,000-resample bootstrap; sealed outcome-free "
                    "content components are the resampling unit",
                )
                for horizon in ("5", "10", "20", "30"):
                    fixed = metrics["fixedHorizons"][horizon]
                    self.assertIsNotNone(fixed)
                    self.assertIsNotNone(fixed["maeConfidence95"])
                fixed20 = metrics["fixed20Second"]
                self.assertEqual(
                    fixed20["discriminationStatus"],
                    "unavailable-constant-prediction",
                )
                self.assertEqual(fixed20["predictedStandardDeviationPercent"], 0.0)
                self.assertIsNotNone(fixed20["predictionBandCoverageWilson95"])

        balanced = evaluation["strictBlindAccountBalanced"]
        self.assertEqual(balanced["accountCount"], 3)
        for family in balanced["families"].values():
            self.assertEqual(len(family["accounts"]), 3)
            self.assertGreaterEqual(
                family["worstAccountCurveMAEPercentagePoints"],
                family["macroSourceEqualCurveMAEPercentagePoints"],
            )
        diagnostic = evaluation["strictBlindCandidateVsBaseline"]
        candidate = diagnostic["families"]["entryIndexed"]
        self.assertFalse(candidate["modelStageChanged"])
        self.assertEqual(
            candidate["contentComponents"], validation["strictBlindContentComponents"],
        )
        self.assertIn("equalAccountMacro", candidate)
        for horizon in ("5", "10", "20", "30"):
            fixed = candidate["fixedHorizons"][horizon]
            self.assertIn("pairedImprovementSignFlipP", fixed)
            self.assertIn("pairedImprovementSignFlipHolmAdjustedP", fixed)
            self.assertIn(
                "accountStratifiedPositivePearsonPermutationHolmAdjustedP", fixed,
            )

    def test_every_row_has_comparable_prediction_and_actual(self):
        for row in self.summary["rows"]:
            with self.subTest(video_id=row["videoId"]):
                self.assertIsNotNone(row.get("outputs"))
                self.assertIsNotNone(row.get("actual"))
                self.assertIsNotNone(row.get("predictionError"))
                self.assertIn("?scope=all&generation=", row.get("detail", ""))
                self.assertTrue(row["detail"].endswith(self.summary["generationId"]))
                if float(row.get("forecastHorizonSeconds") or 0) >= 20:
                    self.assertIn("20", row.get("comparisons") or {})

    def test_details_record_fit_provenance_and_join_outcomes_late(self):
        saved_ids = {str(row["videoId"]) for row in self.saved["rows"]}
        fingerprint = self.summary["modelFingerprint"]
        for row in self.summary["rows"]:
            video_id = str(row["videoId"])
            path = CACHE / "pooled-opening-predictions" / f"{video_id}.json.gz"
            self.assertTrue(path.exists(), video_id)
            detail = read_gzip_json(path)
            provenance = detail.get("provenance") or {}
            self.assertEqual(
                detail.get("referenceFullFitModelFingerprint"), fingerprint,
            )
            if video_id in saved_ids:
                self.assertEqual(detail.get("predictionFitKind"), "source-level-oof")
                self.assertIsNone(detail.get("pooledModelFingerprint"))
            else:
                self.assertIn(detail.get("predictionFitKind"), {
                    "frozen-full-fit", "frozen-selected-baseline-no-transcript",
                })
                self.assertEqual(detail.get("pooledModelFingerprint"), fingerprint)
            self.assertFalse(provenance.get("observedCurveUsedForPrediction"))
            self.assertTrue(provenance.get("observedCurveJoinedAfterInference"))
            self.assertFalse(provenance.get("pooledEvaluationRefit"))
            self.assertFalse(provenance.get("pooledEvaluationRecalibration"))
            self.assertEqual(
                detail.get("evaluationGenerationId"), self.summary["generationId"],
            )
            self.assertRegex(detail.get("blindPredictionFingerprint", ""), r"^[a-f0-9]{64}$")
            self.assertEqual(
                prediction_fingerprint(detail), detail["blindPredictionFingerprint"],
            )
            poisoned = deepcopy(detail)
            poisoned["actual"] = {"views": 10**15, "retainedAt20sPercent": -500.0}
            poisoned["predictionError"] = {"retainedAt20sPoints": 999.0}
            for family in poisoned["curves"].values():
                family["actual"] = [-999.0 for _ in family["timesSeconds"]]
            self.assertEqual(
                prediction_fingerprint(poisoned), detail["blindPredictionFingerprint"],
            )
            self.assertEqual(
                len(detail["observedCurves"]["entryIndexed"]["timesSeconds"]),
                detail["actual"]["curveSourcePoints"],
            )
            for family in ("entryIndexed", "observedAbsolute"):
                curve = detail["curves"][family]
                length = len(curve["timesSeconds"])
                self.assertEqual(len(curve["predicted"]), length)
                self.assertEqual(len(curve["actual"]), length)


if __name__ == "__main__":
    unittest.main()
