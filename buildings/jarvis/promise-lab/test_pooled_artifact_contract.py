import gzip
import json
import unittest
from collections import Counter
from pathlib import Path


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
        self.assertEqual(self.summary["provenance"], {
            "modelRefit": False,
            "modelRecalibrated": False,
            "modelStageChanged": False,
            "outcomesJoinedAfterInference": True,
            "savedCohortPredictionsRemainSourceLevelOOF": True,
            "externalRowsUseFrozenFullFit": True,
        })

        evaluation = self.summary["evaluation"]
        self.assertEqual(evaluation["allPooled"]["videos"], len(rows))
        self.assertEqual(
            evaluation["externalAccounts"]["videos"],
            sum(row["accountId"] != "tyler" for row in rows),
        )
        self.assertIsNotNone(evaluation["externalAccounts"]["fixed20Second"])

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
