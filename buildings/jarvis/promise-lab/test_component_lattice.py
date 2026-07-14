import unittest
import hashlib
import copy

import numpy as np

from atlas import representation_matrix
from component_lattice import build_component_lattice, exact_or_estimated_timing
from hook_score_core import row_unit
from interventions import build_tensor, make_plan
from score_hook import build_span_primitives
from sequence import all_spans, tokenize


def fixture():
    text = "alpha and beta works"
    tokens = tokenize(text)
    spans = all_spans(len(tokens))
    starts = np.asarray([row.start for row in spans], int)
    ends = np.asarray([row.end for row in spans], int)
    rng = np.random.RandomState(1729)
    raw = rng.normal(size=(len(spans), 6)).astype(np.float32)
    context = rng.normal(size=(len(spans), 6)).astype(np.float32)
    influence = rng.normal(size=(len(spans), 6)).astype(np.float32)
    nonadditive = rng.normal(size=(len(spans), 6)).astype(np.float32)
    full = raw[-1]
    model = {
        "categoryTransform": {
            "pcaMean": [0.0] * 6,
            "pcaComponents": np.eye(6, dtype=float)[:4].tolist(),
            "whiteningScale": [1.0] * 4,
        },
        "categoryModel": {
            "clusters": [{
                "mean": (np.eye(4)[index] * 0.5).tolist(),
                "inverseCovariance": np.eye(4).tolist(),
                "logDeterminant": 0.0, "prior": 0.25,
            } for index in range(4)],
        },
        "browseProjection": {"basis4x2": np.eye(4)[:, :2].tolist()},
    }
    partition = {"chunks": [
        {"start": 0, "end": 2, "category": 0},
        {"start": 2, "end": len(tokens), "category": 1},
    ]}
    return text, tokens, starts, ends, raw, context, influence, nonadditive, full, model, partition


class ComponentLatticeTest(unittest.TestCase):
    def test_predictor_primitives_match_persisted_training_formula(self):
        class FakeStore:
            @staticmethod
            def embed_many(texts):
                result = {}
                for text in dict.fromkeys(texts):
                    seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "big")
                    result[text] = row_unit(
                        np.random.RandomState(seed).normal(size=24).astype(np.float32)
                    )
                return result

        text = "alpha beta, gamma works"
        store = FakeStore()
        live = build_span_primitives(text, store)
        plan = make_plan(text)
        tensor, _ = build_tensor(plan, store.embed_many(plan.required_texts))
        stored_full = np.asarray(tensor["full"], np.float16).astype(np.float32)
        stored_raw = representation_matrix("raw", tensor).astype(np.float16).astype(np.float32)
        stored_context = representation_matrix("context", tensor).astype(np.float16).astype(np.float32)
        lookup = {
            (int(start), int(end)): index
            for index, (start, end) in enumerate(zip(tensor["span_start"], tensor["span_end"]))
        }
        derived = {
            "full": stored_full, "span_context": stored_context,
            "span_start": tensor["span_start"], "span_end": tensor["span_end"],
            "token_effects": np.asarray([
                stored_full - stored_context[lookup[(token, token + 1)]]
                for token in range(len(plan.tokens))
            ], np.float32),
        }
        expected = {
            "full": row_unit(stored_full),
            "raw": row_unit(stored_raw),
            "context": row_unit(stored_context),
            "influence": row_unit(
                representation_matrix("influence", derived).astype(np.float16).astype(np.float32)
            ),
            "nonadditive": row_unit(
                representation_matrix("nonadditive", derived).astype(np.float16).astype(np.float32)
            ),
        }
        for name, values in expected.items():
            self.assertTrue(np.array_equal(live[name], values), name)
        singleton = np.flatnonzero(live["ends"] - live["starts"] == 1)
        self.assertTrue(np.array_equal(
            live["nonadditive"][singleton],
            np.zeros_like(live["nonadditive"][singleton]),
        ))

    def test_live_and_corpus_share_complete_outcome_safe_graph(self):
        (text, tokens, starts, ends, raw, context, influence, nonadditive,
         full, model, partition) = fixture()
        lattice = build_component_lattice(
            text=text, tokens=tokens, starts=starts, ends=ends, raw=raw,
            context=context, influence=influence, nonadditive=nonadditive,
            full=full, partition=partition, partition_model=model,
            prefix_transition_null=np.linspace(0, 1, 500),
            idea_text="a machine test", idea_vector=np.ones(6, np.float32),
            inference_outcomes={"hook": {"keep": {"prediction": 71.0}}},
        )
        expected = len(tokens) * (len(tokens) + 1) // 2
        self.assertEqual(lattice["spanCount"], expected)
        self.assertEqual(len({row["id"] for row in lattice["nodes"]}), expected)
        self.assertEqual(len(lattice["rejectedCandidates"]["empty"]), len(tokens) + 1)
        self.assertTrue({
            "containment", "sequence", "semantic", "context", "title", "outcome",
        }.issubset(lattice["edgeCounts"]))
        self.assertTrue(all(
            edge["evaluationEligible"] is False
            for edge in lattice["edges"] if edge["type"] == "outcome"
        ))
        self.assertTrue(all(
            edge["source"] != edge["target"]
            for edge in lattice["edges"] if edge["type"] == "semantic"
        ))
        self.assertTrue(all(
            node["descriptiveAttention"]["semanticCentrality"] > 0
            for node in lattice["nodes"]
        ))
        self.assertTrue(all(
            node["descriptiveAttention"]["aggregate"] is None
            for node in lattice["nodes"]
        ))
        self.assertTrue(lattice["parityContract"]["corpusAndPredictorShareCode"])
        self.assertTrue(lattice["partitionContract"]["exactNonoverlappingCover"])
        self.assertFalse(lattice["partitionContract"]["selectionUsesOutcomes"])
        self.assertEqual(lattice["partitionContract"]["tokenOwnership"], [1] * len(tokens))
        self.assertTrue(all(
            edge["source"] == f"span:0:{len(tokens)}"
            for edge in lattice["edges"]
            if edge["type"] == "outcome"
        ))
        self.assertEqual(len(lattice["mapDefinitions"]), 12)
        self.assertTrue(all(
            set(node["maps"]) == set(lattice["mapDefinitions"])
            for node in lattice["nodes"]
        ))

    def test_supplied_estimated_timing_is_not_mislabeled_exact(self):
        (text, tokens, starts, ends, raw, context, influence, nonadditive,
         full, model, partition) = fixture()
        words = [{
            "tokenIndex": index, "spokenStartSeconds": index / 4,
            "spokenEndSeconds": (index + 1) / 4,
        } for index in range(len(tokens))]
        lattice = build_component_lattice(
            text=text, tokens=tokens, starts=starts, ends=ends, raw=raw,
            context=context, influence=influence, nonadditive=nonadditive,
            full=full, partition=partition, partition_model=model,
            timing_words=words, timing_policy="library-average speaking rate",
        )
        self.assertFalse(lattice["timingContract"]["exact"])
        self.assertEqual(lattice["timingContract"]["source"], "corpus-mean-speaking-rate")

    def test_content_hash_covers_vectors_not_only_source_text(self):
        (text, tokens, starts, ends, raw, context, influence, nonadditive,
         full, model, partition) = fixture()
        first = build_component_lattice(
            text=text, tokens=tokens, starts=starts, ends=ends, raw=raw,
            context=context, influence=influence, nonadditive=nonadditive,
            full=full, partition=partition, partition_model=model,
        )
        changed = raw.copy()
        changed[0, 0] += 0.2
        second = build_component_lattice(
            text=text, tokens=tokens, starts=starts, ends=ends, raw=changed,
            context=context, influence=influence, nonadditive=nonadditive,
            full=full, partition=partition, partition_model=model,
        )
        self.assertEqual(first["sourceIdentityHash"], second["sourceIdentityHash"])
        self.assertNotEqual(first["contentHash"], second["contentHash"])

    def test_content_hash_accepts_live_numpy_model_values(self):
        (text, tokens, starts, ends, raw, context, influence, nonadditive,
         full, model, partition) = fixture()
        live_model = copy.deepcopy(model)
        live_model["categoryTransform"]["pcaMean"] = np.asarray(
            live_model["categoryTransform"]["pcaMean"], np.float32,
        )
        live_model["categoryTransform"]["pcaComponents"] = np.asarray(
            live_model["categoryTransform"]["pcaComponents"], np.float32,
        )
        live_model["browseProjection"]["basis4x2"] = np.asarray(
            live_model["browseProjection"]["basis4x2"], np.float32,
        )
        result = build_component_lattice(
            text=text, tokens=tokens, starts=starts, ends=ends, raw=raw,
            context=context, influence=influence, nonadditive=nonadditive,
            full=full, partition=partition, partition_model=live_model,
            inference_outcomes={"hook": {"keep": {"prediction": np.float32(71)}}},
        )
        self.assertEqual(result["spanCount"], len(tokens) * (len(tokens) + 1) // 2)

    def test_exact_caption_indices_allow_unspoken_punctuation_only(self):
        tokens = tokenize("alpha, beta.")
        words = [
            {"tokenIndex": 0, "text": "alpha", "spokenStartSeconds": 0.1,
             "spokenEndSeconds": 0.4},
            {"tokenIndex": 2, "text": "beta", "spokenStartSeconds": 0.5,
             "spokenEndSeconds": 0.9},
        ]
        timing, contract = exact_or_estimated_timing(
            tokens, words, timing_policy="exact captions",
        )
        self.assertTrue(contract["exact"])
        self.assertEqual(timing[1]["spokenStartSeconds"], 0.4)
        self.assertEqual(timing[1]["spokenEndSeconds"], 0.4)
        self.assertEqual(timing[3]["spokenStartSeconds"], 0.9)
        self.assertEqual(timing[3]["spokenEndSeconds"], 0.9)

    def test_source_aligned_inferred_intervals_are_not_called_exact(self):
        tokens = tokenize("alpha beta")
        words = [
            {"tokenIndex": 0, "text": "alpha", "spokenStartSeconds": 0.1,
             "spokenEndSeconds": 0.4, "sourceStartTimestampSeconds": 0.1},
            {"tokenIndex": 1, "text": "beta", "spokenStartSeconds": 0.4,
             "spokenEndSeconds": 0.8, "sourceStartTimestampSeconds": 0.4},
        ]
        timing, contract = exact_or_estimated_timing(
            tokens, words,
            timing_policy="observed quantized starts with inferred word ends",
        )
        self.assertFalse(contract["exact"])
        self.assertTrue(contract["sourceAlignmentTokenCover"])
        self.assertTrue(contract["wordIntervalsInferred"])
        self.assertEqual(contract["source"], "source-aligned-inferred-intervals")
        self.assertEqual(timing[0]["sourceStartTimestampSeconds"], 0.1)

    def test_media_aligned_intervals_carry_estimator_provenance(self):
        tokens = tokenize("alpha beta")
        words = [
            {"tokenIndex": 0, "text": "alpha", "spokenStartSeconds": 0.1,
             "spokenEndSeconds": 0.4, "alignmentStatus": "ctc-forced"},
            {"tokenIndex": 1, "text": "beta", "spokenStartSeconds": 0.4,
             "spokenEndSeconds": 0.8, "alignmentStatus": "ctc-forced"},
        ]
        timing, contract = exact_or_estimated_timing(
            tokens, words, timing_policy="source-media CTC alignment",
            timing_metadata={
                "mediaAligned": True,
                "timingExact": False,
                "boundaryEstimator": "promise-media-clock-v1",
                "alignmentConfidence": "high",
                "timingResolutionSeconds": 0.02,
                "claimBoundary": "estimated acoustic boundaries",
            },
        )
        self.assertFalse(contract["exact"])
        self.assertTrue(contract["mediaAligned"])
        self.assertEqual(contract["source"], "source-media-ctc-estimated-intervals")
        self.assertEqual(contract["boundaryEstimator"], "promise-media-clock-v1")
        self.assertEqual(timing[0]["alignmentStatus"], "ctc-forced")

    def test_missing_spoken_token_forces_estimated_timing(self):
        tokens = tokenize("alpha beta")
        timing, contract = exact_or_estimated_timing(
            tokens,
            [{"tokenIndex": 0, "text": "alpha", "spokenStartSeconds": 0.1,
              "spokenEndSeconds": 0.4}],
            timing_policy="exact captions",
        )
        self.assertFalse(contract["exact"])
        self.assertEqual(timing[0]["spokenStartSeconds"], 0.0)


if __name__ == "__main__":
    unittest.main()
