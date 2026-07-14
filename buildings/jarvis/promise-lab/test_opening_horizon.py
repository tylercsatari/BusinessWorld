import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from opening_horizon import (
    FORWARD_LAGS_SECONDS,
    METHOD_VERSION,
    OPENING_HORIZON_SECONDS,
    REVERSE_CONTROL_LAGS_SECONDS,
    component_measurements,
    curve_payload,
    extract_opening_timeline,
    load_local_opening,
)
from run_opening_horizon import (
    atomic_gzip_json,
    attach_length_support,
    attach_outcome_graph,
    attach_timing_precision,
    bounded_parallel_results,
    fit_horizon_partition_extension,
    load_cached_source_structures,
    measured_length_support,
    response_measurement,
)
from embedding_store import DIMENSIONS
from forward_response import ResponseCandidate
from deconfounding import retention_curve_families
from sequence import tokenize


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


class OpeningHorizonTest(unittest.TestCase):
    def test_response_only_cache_loader_validates_structure_and_vector_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            details = root / "details"
            vectors = root / "vectors"
            detail = {
                "videoId": "source-1",
                "openingAnalysisMethodVersion": METHOD_VERSION,
                "analysisHorizonSeconds": OPENING_HORIZON_SECONDS,
                "canonicalComponents": [{"text": "measured phrase"}],
                "partitionContract": {
                    "tokenOwnership": [1],
                    "exactNonoverlappingCover": True,
                },
                "spanCount": 1,
                "tokenCount": 1,
            }
            atomic_gzip_json(details / "source-1.json.gz", detail)
            vectors.mkdir(parents=True)
            np.savez_compressed(
                vectors / "source-1.npz",
                raw=np.zeros((1, DIMENSIONS), np.float16),
                influence=np.zeros((1, DIMENSIONS), np.float16),
                full=np.zeros(DIMENSIONS, np.float16),
            )
            loaded = load_cached_source_structures(
                [{"id": "source-1"}], details, vectors,
            )
            self.assertEqual(loaded["source-1"]["tokenCount"], 1)

            np.savez_compressed(
                vectors / "source-1.npz",
                raw=np.zeros((2, DIMENSIONS), np.float16),
                influence=np.zeros((1, DIMENSIONS), np.float16),
                full=np.zeros(DIMENSIONS, np.float16),
            )
            with self.assertRaisesRegex(RuntimeError, "vectors differ"):
                load_cached_source_structures(
                    [{"id": "source-1"}], details, vectors,
                )

    def test_parallel_source_scheduler_keeps_only_a_bounded_queue(self):
        submitted = 0

        class CountingPool:
            def __init__(self, pool):
                self.pool = pool

            def submit(self, function, value):
                nonlocal submitted
                submitted += 1
                return self.pool.submit(function, value)

        with ThreadPoolExecutor(max_workers=3) as real_pool:
            iterator = bounded_parallel_results(
                CountingPool(real_pool), range(50), lambda value: value, 3,
            )
            first = next(iterator)
            self.assertIn(first, range(50))
            self.assertLessEqual(submitted, 4)
            remaining = list(iterator)

        self.assertEqual(set([first, *remaining]), set(range(50)))

    def test_exact_timeline_clips_at_horizon_without_truncating_a_prior_word(self):
        result = extract_opening_timeline([
            {"word": "alpha", "timestamp": 0.2},
            {"word": "can't", "timestamp": 0.7},
            {"word": "stop", "timestamp": 19.8},
            {"word": "outside", "timestamp": 20.1},
        ])
        self.assertEqual(result["text"], "alpha can't stop")
        self.assertEqual(result["wordCount"], 3)
        self.assertEqual(result["spokenEndSeconds"], 20.0)
        self.assertFalse(result["timingExact"])
        self.assertTrue(result["wordStartsAuthentic"])
        self.assertTrue(result["sourceWordStartTimestampsObserved"])
        self.assertTrue(result["resolvedWordStartsObserved"])
        self.assertFalse(result["wordEndsObserved"])
        self.assertTrue(result["resolvedIntervalsNonoverlapping"])
        self.assertEqual(
            {row["tokenIndex"] for row in result["timingWords"]},
            {token.index for token in tokenize(result["text"])},
        )
        self.assertTrue(all(
            0 <= row["spokenStartSeconds"] <= row["spokenEndSeconds"] <= 20
            for row in result["timingWords"]
        ))

    def test_multi_atom_source_word_gets_deterministic_character_timing(self):
        result = extract_opening_timeline([
            {"word": "hello/world", "timestamp": 1.0},
            {"word": "next", "timestamp": 2.0},
            {"word": "after", "timestamp": 20.2},
        ])
        rows = result["timingWords"][:3]
        self.assertEqual([row["text"] for row in rows], ["hello", "world", "next"])
        self.assertAlmostEqual(rows[0]["spokenStartSeconds"], 1.0)
        self.assertAlmostEqual(rows[1]["spokenEndSeconds"], 2.0)
        self.assertAlmostEqual(rows[2]["spokenEndSeconds"], 20.0)

    def test_equal_quantized_timestamps_are_resolved_without_overlap(self):
        result = extract_opening_timeline([
            {"word": "and", "timestamp": 2.6},
            {"word": "I", "timestamp": 2.6},
            {"word": "bought", "timestamp": 2.8},
            {"word": "after", "timestamp": 3.2},
        ], horizon_seconds=3.0)
        first, second, third = result["sourceWords"]
        self.assertEqual(result["timestampCollisionGroups"], 1)
        self.assertEqual(result["timestampCollisionWords"], 2)
        self.assertFalse(result["resolvedWordStartsObserved"])
        self.assertEqual(first["sourceStartTimestampSeconds"], 2.6)
        self.assertEqual(second["sourceStartTimestampSeconds"], 2.6)
        self.assertAlmostEqual(first["resolvedStartSeconds"], 2.6)
        self.assertAlmostEqual(first["resolvedEndSeconds"], 2.75)
        self.assertAlmostEqual(second["resolvedStartSeconds"], 2.75)
        self.assertAlmostEqual(second["resolvedEndSeconds"], 2.8)
        self.assertAlmostEqual(third["resolvedStartSeconds"], 2.8)
        self.assertTrue(all(
            left["spokenEndSeconds"] <= right["spokenStartSeconds"] + 1e-9
            for left, right in zip(result["timingWords"], result["timingWords"][1:])
        ))
        self.assertTrue(all(
            row["spokenEndSeconds"] > row["spokenStartSeconds"]
            for row in result["timingWords"]
        ))

    def test_retention_payload_has_no_unobserved_values(self):
        curve = np.linspace(1.25, 0.55, 100).tolist()
        payload = curve_payload(curve, 40)
        self.assertEqual(payload["timesSeconds"][0], 0.0)
        self.assertEqual(payload["timesSeconds"][-1], 20.0)
        self.assertEqual(len(payload["timesSeconds"]), 201)
        self.assertEqual(payload["forecastValues"], 0)
        self.assertEqual(payload["primaryCurve"], "entry_indexed")
        self.assertTrue(payload["normalizationContracts"]["entry_indexed"]["futureFree"])
        self.assertFalse(payload["normalizationContracts"]["terminal_replay"]["futureFree"])

    def test_component_windows_use_forward_lags_and_keep_reverse_controls_separate(self):
        curve = np.linspace(1.2, 0.6, 100).tolist()
        result = component_measurements({
            "spokenStartSeconds": 4.0,
            "spokenEndSeconds": 5.0,
        }, curve, 40)
        self.assertEqual(
            [row["lagSeconds"] for row in result["forward"]],
            list(FORWARD_LAGS_SECONDS),
        )
        self.assertEqual(
            [row["lagSeconds"] for row in result["reverseControls"]],
            list(REVERSE_CONTROL_LAGS_SECONDS),
        )
        self.assertTrue(all(row["lagSeconds"] >= 0 for row in result["forward"]))
        self.assertTrue(all(row["lagSeconds"] < 0 for row in result["reverseControls"]))

    def test_current_corpus_has_exact_transcript_and_retention_support_through_20s(self):
        corpus = json.loads((HERE / ".cache" / "corpus.json").read_text())
        self.assertEqual(len(corpus["rows"]), 208)
        token_counts = []
        sources_with_collisions = 0
        for row in corpus["rows"]:
            opening = load_local_opening(row["id"], ROOT)
            token_counts.append(opening["tokenCount"])
            self.assertTrue(opening["wordStartsAuthentic"], row["id"])
            self.assertTrue(opening["sourceWordStartTimestampsObserved"], row["id"])
            self.assertFalse(opening["wordEndsObserved"], row["id"])
            self.assertTrue(opening["resolvedIntervalsNonoverlapping"], row["id"])
            self.assertTrue(all(
                left["spokenEndSeconds"] <= right["spokenStartSeconds"] + 1e-9
                for left, right in zip(
                    opening["timingWords"], opening["timingWords"][1:]
                )
            ), row["id"])
            self.assertTrue(all(
                timing["spokenEndSeconds"] > timing["spokenStartSeconds"]
                for timing in opening["timingWords"]
            ), row["id"])
            sources_with_collisions += int(opening["timestampCollisionGroups"] > 0)
            self.assertLessEqual(opening["spokenEndSeconds"], OPENING_HORIZON_SECONDS)
            self.assertGreaterEqual(float(row["duration_s"]), OPENING_HORIZON_SECONDS)
            self.assertGreaterEqual(len(row.get("curve") or []), 4)
        self.assertGreater(min(token_counts), 0)
        self.assertGreater(max(token_counts), min(token_counts))
        self.assertGreater(sources_with_collisions, 0)

    def test_length_extrapolation_is_derived_from_the_measured_hook_corpus(self):
        corpus = json.loads((HERE / ".cache" / "corpus.json").read_text())["rows"]
        expected = sorted(len(tokenize(row["hookText"])) for row in corpus)
        support = measured_length_support(corpus)
        self.assertEqual(support["fullHookTokenMinimum"], expected[0])
        self.assertEqual(support["fullHookTokenMaximum"], expected[-1])
        detail = {
            "tokenCount": expected[-1] + 1,
            "canonicalComponents": [{
                "startToken": 0,
                "endToken": expected[-1] + 1,
            }],
        }
        attach_length_support(detail, support)
        self.assertTrue(detail["lengthSupport"]["openingOutsideMeasuredHookRange"])
        self.assertTrue(
            detail["canonicalComponents"][0]["categoryLengthSupport"]["outsideMeasuredRange"]
        )

    def test_long_horizon_count_model_is_fitted_only_from_canonical_covers(self):
        corpus = json.loads((HERE / ".cache" / "corpus.json").read_text())["rows"]
        canonical = json.loads(
            (HERE / ".cache" / "canonical-partitions.json").read_text()
        )
        extension = fit_horizon_partition_extension(canonical, corpus)
        self.assertEqual(extension["trainingSources"], 208)
        self.assertEqual(extension["trainingComponents"], 324)
        self.assertAlmostEqual(sum(
            row["probability"] for row in extension["componentLengthDistribution"]
        ), 1.0)
        self.assertEqual(
            extension["activationTokenThreshold"],
            max(len(tokenize(row["hookText"])) for row in corpus),
        )
        self.assertFalse(extension["outcomesUsed"])
        self.assertFalse(extension["categoriesUsedToChooseBoundaries"])
        validation = extension["boundaryCountValidation"]
        self.assertLess(
            validation["marginalizedBoundaryCount"]["meanAbsoluteErrorComponents"],
            validation["oldJointMapCount"]["meanAbsoluteErrorComponents"],
        )
        self.assertGreater(
            validation["marginalizedBoundaryCount"]["withinOneComponentAccuracy"],
            validation["oldJointMapCount"]["withinOneComponentAccuracy"],
        )

    def test_timing_contract_does_not_call_inferred_word_ends_exact(self):
        detail = {"timingContract": {"exact": True}, "opening": {}}
        attach_timing_precision(detail)
        self.assertFalse(detail["timingContract"]["exact"])
        self.assertTrue(
            detail["timingContract"]["sourceWordStartTimestampsObserved"]
        )
        self.assertFalse(detail["timingContract"]["sourceWordEndsObserved"])
        self.assertEqual(detail["openingAnalysisMethodVersion"], METHOD_VERSION)
        self.assertEqual(detail["opening"]["methodVersion"], METHOD_VERSION)

    def test_outcome_graph_refreshes_detail_edge_count(self):
        detail = {
            "edges": [{"type": "sequence", "source": "a", "target": "b"}],
            "outcomeNodes": [],
            "graphContract": {},
            "canonicalComponents": [{
                "nodeId": "span:0:1",
                "opening20sResponse": {
                    "semanticPredictionPercentPerSecondOOF": 0.1,
                    "unexpectedObservedSlopePercentPerSecondOOF": 0.2,
                    "fold": 1,
                    "evaluationEligible": True,
                    "evaluationContract": "held out",
                },
            }],
        }
        attach_outcome_graph(detail)
        self.assertEqual(detail["edgeCount"], len(detail["edges"]))
        self.assertEqual(detail["edgeCounts"]["outcome"], 1)

    def test_reverse_control_baseline_never_reads_after_its_response_window(self):
        raw = np.linspace(1.2, .5, 100)
        families = retention_curve_families([raw], np.asarray([raw[-5:].mean()]))
        result = response_measurement(
            ResponseCandidate("reverse", "reverse", "phrase", None, -2.0),
            families, [raw], np.asarray([40.0]),
            np.asarray([4.0]), np.asarray([5.0]), np.asarray([0]),
            np.asarray([raw[0]]), np.asarray([raw[-5:].mean()]),
            np.asarray([raw[0] - raw[-5:].mean()]),
        )
        native_step = 40.0 / 99.0
        self.assertAlmostEqual(float(result["left"][0]), 2.0)
        self.assertAlmostEqual(float(result["natural"][0, -2]), 2.0 - native_step, places=5)


if __name__ == "__main__":
    unittest.main()
