import json
import tempfile
import unittest
import wave
from pathlib import Path

from media_alignment import (
    MEDIA_ALIGNMENT_VERSION,
    align_canonical_words,
    apply_media_durations,
    canonical_hook_words,
    canonical_word_records_from_text,
    project_canonical_hook_to_reference,
    timing_endpoint_reference_audit,
    timing_reference_audit,
    source_timeline_audit,
    validate_timed_words,
)
from audit_media_alignment import cached_reference, flatten_whisper_words, store_reference


class MediaAlignmentTests(unittest.TestCase):
    def test_canonical_hook_words_preserve_phrase_units_for_direct_ctc(self):
        words = canonical_hook_words("I walked 10,000 steps.", 4.0)
        self.assertEqual(
            [row["word"] for row in words],
            ["I", "walked", "10,000", "steps."],
        )
        self.assertEqual([row["timestamp"] for row in words], [0.0, 1.0, 2.0, 3.0])

    def test_independent_whisper_words_are_clipped_to_the_analysis_horizon(self):
        rows = flatten_whisper_words({"segments": [{"words": [
            {"word": " alpha ", "start": 19.8, "end": 20.2, "probability": .9},
            {"word": "later", "start": 20.1, "end": 20.3, "probability": .8},
        ]}]})
        self.assertEqual([row["w"] for row in rows], ["alpha"])
        self.assertAlmostEqual(rows[0]["t"] + rows[0]["d"], 20.0)

    def test_independent_decode_cache_is_keyed_by_source_and_model_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference.json"
            words = [{"w": "alpha", "t": 0.1, "d": 0.2}]
            store_reference(path, "source-a", "base", "model-a", words, "alpha")
            self.assertEqual(
                cached_reference(path, "source-a", "base", "model-a"),
                (words, "alpha"),
            )
            self.assertIsNone(
                cached_reference(path, "source-b", "base", "model-a")
            )

    def test_decoded_audio_origin_matches_wave_container_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.wav"
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(b"\x00\x00" * 1600)
            audit = source_timeline_audit(path)
            self.assertEqual(audit["referenceClock"], "container format")
            self.assertEqual(audit["audioMinusReferenceStartSeconds"], 0.0)
            self.assertTrue(audit["withinAlignmentTolerance"])

    def test_validation_clips_intervals_at_next_word(self):
        rows = validate_timed_words([
            {"w": "one", "t": 0.0, "d": 2.0},
            {"w": "two", "t": 0.4, "d": 0.2},
        ])
        self.assertEqual(rows[0]["d"], 0.4)
        self.assertEqual(rows[1]["d"], 0.2)

    def test_subword_display_floor_never_overlaps_the_next_boundary(self):
        rows = validate_timed_words([
            {"w": "eight", "t": 5.4054054054, "d": 0.001},
            {"w": "foot", "t": 5.4059059059, "d": 0.0195},
        ])
        self.assertGreater(rows[0]["d"], 0)
        self.assertLessEqual(rows[0]["t"] + rows[0]["d"], rows[1]["t"])

    def test_alignment_preserves_canonical_text_and_order(self):
        canonical = [
            {"text": "The", "sourceStartTimestampSeconds": 0.0},
            {"text": "machine", "sourceStartTimestampSeconds": 0.5},
            {"text": "works", "sourceStartTimestampSeconds": 1.0},
        ]
        timed = [
            {"w": "the", "t": 0.12, "d": 0.18},
            {"w": "machine", "t": 0.44, "d": 0.42},
            {"w": "works", "t": 0.97, "d": 0.31},
        ]
        resolved, audit = align_canonical_words(canonical, timed, 2.0)
        self.assertEqual([row["text"] for row in resolved], ["The", "machine", "works"])
        self.assertEqual(audit["mappedCoverage"], 1.0)
        self.assertFalse(audit["outcomesUsed"])
        for left, right in zip(resolved, resolved[1:]):
            self.assertLessEqual(left["resolvedEndSeconds"], right["resolvedStartSeconds"])

    def test_canonical_hook_resegmentation_has_one_interval_per_word(self):
        reference = [
            {"w": "cannot", "t": 0.1, "d": 0.4},
            {"w": "spill", "t": 0.6, "d": 0.3},
        ]
        rows, audit = canonical_word_records_from_text("can not spill", reference)
        self.assertEqual([row["w"] for row in rows], ["can", "not", "spill"])
        self.assertEqual(audit["mappedCoverage"], 1.0)
        self.assertFalse(audit["canonicalWordsChanged"])
        self.assertEqual(len(rows), 3)
        self.assertLessEqual(rows[0]["t"] + rows[0]["d"], rows[1]["t"])
        self.assertLessEqual(rows[1]["t"] + rows[1]["d"], rows[2]["t"])

    def test_transcript_variant_hook_uses_an_acoustic_reference_endpoint(self):
        canonical = canonical_hook_words(
            "This is a shock collar if I run too slow", 5.0,
        )
        reference = [
            {
                "w": word, "t": index * 0.5, "d": 0.35,
                "acousticPosteriorGeometricMean": 0.9,
            }
            for index, word in enumerate(
                "shock collar if I run too slow".split()
            )
        ]
        rows, audit = project_canonical_hook_to_reference(canonical, reference)
        self.assertEqual(len(rows), len(canonical))
        self.assertEqual(audit["status"], "edit-distance-reference-prefix-cover")
        self.assertEqual(audit["selectedReferenceWords"], len(reference))
        self.assertTrue(audit["outerBoundariesAcoustic"])
        self.assertAlmostEqual(rows[0]["t"], reference[0]["t"])
        self.assertAlmostEqual(
            rows[-1]["t"] + rows[-1]["d"],
            reference[-1]["t"] + reference[-1]["d"],
        )
        self.assertTrue(rows[0]["startBoundaryAcoustic"])
        self.assertTrue(rows[-1]["endBoundaryAcoustic"])

    def test_media_duration_replaces_only_the_timing_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            alignment_dir = cache / "media-alignment"
            alignment_dir.mkdir()
            (alignment_dir / "video.json").write_text(json.dumps({
                "methodVersion": MEDIA_ALIGNMENT_VERSION,
                "source": {"mediaDurationSeconds": 12.345},
                "words": [{"w": "hello", "t": 0.1, "d": 0.2}],
            }))
            source = {"id": "video", "duration_s": 12.0, "curve": [1, .8, .6, .5]}
            result = apply_media_durations([source], cache)[0]
            self.assertEqual(result["analytics_duration_s"], 12.0)
            self.assertEqual(result["duration_s"], 12.345)
            self.assertEqual(result["media_duration_s"], 12.345)
            self.assertIs(result["curve"], source["curve"])

    def test_reference_audit_is_independent_and_ordered(self):
        candidate = [
            {"w": "alpha", "t": 0.1, "d": 0.2},
            {"w": "beta", "t": 0.5, "d": 0.2},
        ]
        reference = [
            {"w": "alpha", "t": 0.12, "d": 0.2},
            {"w": "beta", "t": 0.47, "d": 0.2},
        ]
        audit = timing_reference_audit(candidate, reference)
        self.assertEqual(audit["exactLexicalMatches"], 2)
        self.assertEqual(audit["mappedCoverage"], 1.0)
        self.assertFalse(audit["referenceIsGroundTruth"])
        self.assertAlmostEqual(audit["startMedianAbsoluteErrorSeconds"], 0.025)

    def test_endpoint_audit_uses_full_opening_context_for_repeated_words(self):
        opening = [
            {"w": "make", "t": 0.0, "d": 0.2, "sourceIndex": 0},
            {"w": "me", "t": 0.2, "d": 0.2, "sourceIndex": 1},
            {"w": "float", "t": 0.4, "d": 0.3, "sourceIndex": 2},
            {"w": "then", "t": 0.8, "d": 0.2, "sourceIndex": 3},
            {"w": "later", "t": 1.0, "d": 0.2, "sourceIndex": 4},
            {"w": "float", "t": 5.0, "d": 0.3, "sourceIndex": 5},
        ]
        independent = [
            {"w": "make", "t": 0.01, "d": 0.2},
            {"w": "me", "t": 0.21, "d": 0.2},
            {"w": "glow", "t": 0.41, "d": 0.3},
            {"w": "then", "t": 0.81, "d": 0.2},
            {"w": "later", "t": 1.01, "d": 0.2},
            {"w": "float", "t": 5.01, "d": 0.3},
        ]
        audit = timing_endpoint_reference_audit(opening, independent, 2)
        self.assertTrue(audit["endpointMatched"])
        self.assertEqual(audit["endpointIndependentWord"], "glow")
        self.assertAlmostEqual(audit["endpointAbsoluteErrorSeconds"], 0.01)


if __name__ == "__main__":
    unittest.main()
