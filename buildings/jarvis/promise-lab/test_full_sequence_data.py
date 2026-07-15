import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path

from full_sequence_data import (
    NORMALIZATION_IDS,
    build_full_timeline,
    coverage_summary,
    extract_full_sequence_dataset,
    extract_full_sequence_record,
    load_opening_video_ids,
    prefix_text_at_second,
)


class FullSequenceDataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        (self.cache / "opening-20s").mkdir(parents=True)
        (self.cache / "media-alignment").mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def retention_curve(offset: float = 0.0) -> list[dict]:
        return [
            {"second": (index + 1) / 100, "retention": 1.25 + offset - index * .006}
            for index in range(100)
        ]

    def write_fixture(self, video_id: str, duration: float = 23.4,
                      suffix: list[dict] | None = None) -> None:
        suffix = suffix or [
            {"word": "after", "timestamp": 20.2},
            {"word": "tail!", "timestamp": min(22.8, duration - .4)},
        ]
        transcript_words = [
            {"word": "Alpha", "timestamp": 0.0},
            {"word": "beta", "timestamp": 19.0},
            *suffix,
        ]
        analysis = {
            "videoId": video_id,
            "metadata": {"duration": duration, "viewCount": 999999999},
            "transcript": {
                "fullText": " ".join(row["word"] for row in transcript_words),
                "words": transcript_words,
            },
            "aiAnalysis": {
                "semanticLabel": "must never affect timing",
                "inventedOutcomeTimestamp": 0.001,
            },
            "analytics": {
                "totalViews": 999999999,
                "retentionCurve": self.retention_curve(),
            },
        }
        detail = {
            "videoId": video_id,
            "text": "Alpha beta",
            "tokens": [
                {
                    "index": 0, "text": "Alpha", "start": 0, "end": 5,
                    "spokenStartSeconds": .12, "spokenEndSeconds": .42,
                    "sourceWordIndex": 0, "timingSource": "acoustic-fixture",
                    "spokenStartBoundaryAcoustic": True,
                    "spokenEndBoundaryAcoustic": True,
                },
                {
                    "index": 1, "text": "beta", "start": 6, "end": 10,
                    "spokenStartSeconds": 19.3, "spokenEndSeconds": 19.7,
                    "sourceWordIndex": 1, "timingSource": "acoustic-fixture",
                    "spokenStartBoundaryAcoustic": True,
                    "spokenEndBoundaryAcoustic": True,
                },
            ],
        }
        alignment = {
            "videoId": video_id,
            "methodVersion": "fixture-alignment",
            "source": {
                "mediaDurationSeconds": duration,
                "analyticsDurationSeconds": duration,
            },
            "words": [
                {
                    "w": "Alpha", "t": .12, "d": .30, "canonicalIndex": 0,
                    "source": "acoustic-fixture", "startBoundaryAcoustic": True,
                    "endBoundaryAcoustic": True,
                },
                {
                    "w": "beta", "t": 19.3, "d": .40, "canonicalIndex": 1,
                    "source": "acoustic-fixture", "startBoundaryAcoustic": True,
                    "endBoundaryAcoustic": True,
                },
            ],
        }
        analysis_path = self.root / "video_data" / video_id / "analysis.json"
        analysis_path.parent.mkdir(parents=True)
        analysis_path.write_text(json.dumps(analysis), encoding="utf-8")
        with gzip.open(
            self.cache / "opening-20s" / f"{video_id}.json.gz", "wt",
            encoding="utf-8",
        ) as handle:
            json.dump(detail, handle)
        (self.cache / "media-alignment" / f"{video_id}.json").write_text(
            json.dumps(alignment), encoding="utf-8",
        )

    def write_summary(self, video_ids: list[str]) -> None:
        (self.cache / "opening-20s.json").write_text(json.dumps({
            "sourceVideos": len(video_ids),
            "rows": [{"videoId": video_id} for video_id in video_ids],
        }), encoding="utf-8")

    def test_preserves_acoustic_prefix_and_appends_after_canonical_index(self):
        self.write_fixture("one")
        record = extract_full_sequence_record("one", self.root, self.cache)
        self.assertEqual(record["text"], "Alpha beta after tail!")
        self.assertEqual(record["alignedCanonicalEndIndex"], 1)
        self.assertEqual([row["canonicalIndex"] for row in record["words"]], [0, 1, 2, 3])
        self.assertEqual(record["words"][0]["startSeconds"], .12)
        self.assertEqual(record["words"][1]["endSeconds"], 19.7)
        self.assertEqual(record["tokens"][0]["spokenStartSeconds"], .12)
        self.assertEqual(record["tokens"][1]["spokenEndSeconds"], 19.7)
        self.assertTrue(record["tokens"][0]["acousticallyAlignedPrefix"])
        self.assertFalse(record["tokens"][2]["acousticallyAlignedPrefix"])
        self.assertEqual(record["timingAudit"]["appendedWordCount"], 2)
        self.assertTrue(record["timingAudit"]["openingTokenPrefixPreserved"])
        self.assertEqual(prefix_text_at_second(record, 19.7), "Alpha beta")
        self.assertEqual(prefix_text_at_second(record, 23.4), "Alpha beta after tail!")

    def test_timing_is_independent_of_outcomes_labels_and_declared_full_text(self):
        self.write_fixture("one")
        analysis_path = self.root / "video_data" / "one" / "analysis.json"
        first = extract_full_sequence_record("one", self.root, self.cache)
        changed = json.loads(analysis_path.read_text(encoding="utf-8"))
        changed["transcript"]["fullText"] = "a semantic outcome label with no timestamps"
        changed["aiAnalysis"] = {"semanticLabel": "opposite", "timestamp": 18.0}
        changed["analytics"]["totalViews"] = 1
        changed["analytics"]["retentionCurve"] = self.retention_curve(offset=.15)
        analysis_path.write_text(json.dumps(changed), encoding="utf-8")
        second = extract_full_sequence_record("one", self.root, self.cache)
        word_timing = lambda value: [
            (row["startSeconds"], row["endSeconds"]) for row in value["words"]
        ]
        token_timing = lambda value: [
            (row["spokenStartSeconds"], row["spokenEndSeconds"])
            for row in value["tokens"]
        ]
        self.assertEqual(word_timing(first), word_timing(second))
        self.assertEqual(token_timing(first), token_timing(second))
        self.assertEqual(second["text"], "Alpha beta after tail!")
        self.assertFalse(second["timingAudit"]["declaredFullTextMatchesTimestampedWords"])
        self.assertFalse(second["timingContract"]["outcomesUsed"])
        self.assertFalse(second["timingContract"]["semanticLabelsUsed"])

    def test_backward_suffix_timestamp_is_resolved_without_reordering(self):
        self.write_fixture("one", suffix=[
            {"word": "later", "timestamp": 21.5},
            {"word": "back", "timestamp": 20.9},
        ])
        record = extract_full_sequence_record("one", self.root, self.cache)
        suffix = record["words"][2:]
        self.assertEqual([row["text"] for row in suffix], ["later", "back"])
        self.assertEqual(suffix[1]["sourceStartTimestampSeconds"], 20.9)
        self.assertGreaterEqual(suffix[1]["startSeconds"], suffix[0]["endSeconds"])
        self.assertEqual(record["timingAudit"]["backwardTimestampCorrections"], 1)
        self.assertEqual(record["timingAudit"]["timestampCollisionGroups"], 1)

    def test_preserves_zero_duration_aligned_punctuation_tokens(self):
        self.write_fixture("one")
        analysis_path = self.root / "video_data" / "one" / "analysis.json"
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
        analysis["transcript"]["words"][0]["word"] = "Alpha,"
        analysis["transcript"]["fullText"] = "Alpha, beta after tail!"
        analysis_path.write_text(json.dumps(analysis), encoding="utf-8")

        detail_path = self.cache / "opening-20s" / "one.json.gz"
        with gzip.open(detail_path, "rt", encoding="utf-8") as handle:
            detail = json.load(handle)
        detail["text"] = "Alpha, beta"
        detail["tokens"] = [
            {**detail["tokens"][0]},
            {
                "index": 1, "text": ",", "start": 5, "end": 6,
                "spokenStartSeconds": .42, "spokenEndSeconds": .42,
                "timingSource": "acoustic-fixture",
                "spokenStartBoundaryAcoustic": True,
                "spokenEndBoundaryAcoustic": True,
            },
            {
                **detail["tokens"][1], "index": 2, "start": 7, "end": 11,
            },
        ]
        with gzip.open(detail_path, "wt", encoding="utf-8") as handle:
            json.dump(detail, handle)

        alignment_path = self.cache / "media-alignment" / "one.json"
        alignment = json.loads(alignment_path.read_text(encoding="utf-8"))
        alignment["words"][0]["w"] = "Alpha,"
        alignment_path.write_text(json.dumps(alignment), encoding="utf-8")

        record = extract_full_sequence_record("one", self.root, self.cache)
        punctuation = record["tokens"][1]
        self.assertEqual(punctuation["text"], ",")
        self.assertEqual(punctuation["spokenStartSeconds"], .42)
        self.assertEqual(punctuation["spokenEndSeconds"], .42)
        self.assertEqual(punctuation["wordIndex"], 0)
        self.assertTrue(punctuation["acousticallyAlignedPrefix"])

    def test_samples_all_families_only_at_at_risk_whole_seconds(self):
        self.write_fixture("one", duration=23.4)
        record = extract_full_sequence_record("one", self.root, self.cache)
        retention = record["retention"]
        self.assertEqual(retention["wholeSeconds"], list(range(24)))
        self.assertEqual(tuple(retention["curvesPercent"]), NORMALIZATION_IDS)
        self.assertTrue(all(
            row["allNormalizationFamiliesObserved"]
            for row in retention["perSecond"]
        ))
        self.assertEqual(retention["firstWholeSecondCensored"], 24)
        self.assertNotIn(24, retention["wholeSeconds"])
        self.assertAlmostEqual(retention["curvesPercent"]["entry_indexed"][0], 100.0)

    def test_dataset_reports_risk_set_coverage_and_threshold_horizons(self):
        self.write_fixture("short", duration=21.4, suffix=[
            {"word": "after", "timestamp": 20.2},
            {"word": "tail", "timestamp": 20.8},
        ])
        self.write_fixture("long", duration=23.4)
        self.write_summary(["short", "long"])
        dataset = extract_full_sequence_dataset(
            self.root, self.cache, expected_source_count=2,
            thresholds={
                "minimumRiskSetSources": 2,
                "minimumChronologicalRiskSetSources": 2,
            },
        )
        coverage = dataset["coverage"]
        by_second = {row["second"]: row for row in coverage["perSecond"]}
        self.assertEqual(dataset["videoIds"], ["short", "long"])
        self.assertEqual(by_second[21]["riskSetSources"], 2)
        self.assertEqual(by_second[22]["riskSetSources"], 1)
        self.assertEqual(by_second[22]["censoredSources"], 1)
        self.assertEqual(by_second[22]["riskSetVideoIds"], ["long"])
        self.assertEqual(by_second[22]["censoredVideoIds"], ["short"])
        self.assertEqual(by_second[22]["allNormalizationFamiliesSources"], 1)
        self.assertEqual(coverage["lastSecondMeetingMinimumRiskSetSources"], 21)
        self.assertEqual(coverage["lastSecondMeetingChronologicalRiskSetSources"], 21)
        self.assertEqual(coverage["lastSecondMeetingAllCoverageThresholds"], 21)
        self.assertEqual(
            coverage["lastSecondMeetingAllChronologicalCoverageThresholds"], 21,
        )
        self.assertEqual(coverage["lastWholeSecondWithAnySourceAtRisk"], 23)
        self.assertTrue(coverage["allSourceThresholdsMet"])
        self.assertEqual(dataset["contract"]["modelsTrained"], 0)
        self.assertEqual(dataset["contract"]["artifactsWritten"], 0)
        json.dumps(dataset, allow_nan=False)

    def test_opening_id_loader_rejects_duplicates_and_wrong_count(self):
        self.write_summary(["one", "one"])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            load_opening_video_ids(self.cache, expected_count=2)
        self.write_summary(["one"])
        with self.assertRaisesRegex(ValueError, "expected 2"):
            load_opening_video_ids(self.cache, expected_count=2)


if __name__ == "__main__":
    unittest.main()
