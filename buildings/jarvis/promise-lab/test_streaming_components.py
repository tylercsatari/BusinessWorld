import hashlib
import math
import unittest
from unittest.mock import patch

import numpy as np

from canonical_partition import BOUNDARY_FEATURE_NAMES
from hook_score_core import decode_support_calibrated_chunks
from sequence import tokenize
from streaming_components import build_streaming_components


DIMENSION = 16


class FakeStore:
    def __init__(self, dimensions=DIMENSION):
        self.dimensions = dimensions
        self.calls = []
        self.maximum_batch = 0
        self._cache = {}

    def embed_many(self, texts):
        ordered = list(dict.fromkeys(str(text) for text in texts if str(text)))
        self.calls.append(ordered)
        self.maximum_batch = max(self.maximum_batch, len(ordered))
        result = {}
        for text in ordered:
            if text not in self._cache:
                seed = int.from_bytes(
                    hashlib.sha256(text.encode("utf-8")).digest()[:8], "big",
                )
                self._cache[text] = np.random.default_rng(seed).normal(
                    size=self.dimensions,
                ).astype(np.float32)
            result[text] = self._cache[text]
        return result


def frozen_model():
    components = np.zeros((4, DIMENSION), float)
    components[:, :4] = np.eye(4)
    cluster_means = (
        [1.0, 0.0, 0.0, 0.0],
        [-1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, -1.0, 0.0, 0.0],
    )
    return {
        "methodVersion": "synthetic-frozen-partition-v1",
        "mapId": "synthetic-four-category-map",
        "categoryTransform": {
            "sourceRepresentation": (
                "unit(raw span) minus its source-hook span mean, then unit normalize"
            ),
            "pcaMean": [0.0] * DIMENSION,
            "pcaComponents": components.tolist(),
            "whiteningScale": [1.0] * 4,
        },
        "categoryModel": {
            "clusters": [{
                "label": label,
                "mean": list(mean),
                "inverseCovariance": np.eye(4).tolist(),
                "logDeterminant": 0.0,
                "prior": 0.25,
            } for label, mean in enumerate(cluster_means)],
        },
        "browseProjection": {
            "basis4x2": np.eye(4, dtype=float)[:, :2].tolist(),
        },
        "boundaryModel": {
            "featureNames": list(BOUNDARY_FEATURE_NAMES),
            "scalerMean": [0.0] * len(BOUNDARY_FEATURE_NAMES),
            "scalerScale": [1.0] * len(BOUNDARY_FEATURE_NAMES),
            "coefficients": [0.35, -0.2, 0.25, -0.1, 0.7, 0.4, 0.2, -0.3],
            "intercept": -0.1,
            "servingPolicy": "synthetic frozen Bernoulli posterior",
        },
        "partitionCalibration": {
            "scoreGapsSorted": [0.0, 0.1, 0.2, 0.3],
        },
    }


def extension(maximum_component_tokens):
    probability = 1.0 / maximum_component_tokens
    return {
        "method": "synthetic measured component support",
        "activationTokenThreshold": -1,
        "maximumObservedComponentTokens": maximum_component_tokens,
        "trainingSources": 12,
        "trainingComponents": 24,
        "sourceEqualLengthWeights": True,
        "componentLengthDistribution": [{
            "tokens": tokens,
            "probability": probability,
        } for tokens in range(1, maximum_component_tokens + 1)],
    }


def support(minimum, maximum):
    return {
        "source": "synthetic measured hook token counts",
        "fullHookTokenMinimum": minimum,
        "fullHookTokenMaximum": maximum,
    }


class StreamingComponentTests(unittest.TestCase):
    def test_short_fixture_uses_one_complete_decoder_block(self):
        text = "alpha beta gamma"
        model = frozen_model()
        horizon = extension(3)

        with patch(
            "streaming_components.decode_support_calibrated_chunks",
            wraps=decode_support_calibrated_chunks,
        ) as decoder:
            streamed = build_streaming_components(
                text, FakeStore(), model, horizon, support(2, 3),
            )

        decoder.assert_called_once()
        self.assertEqual(len(streamed["blocks"]), 1)
        self.assertEqual(len(streamed["blocks"][0]["boundaryPosteriors"]), 2)
        self.assertEqual(streamed["owners"], [
            next(row["index"] for row in streamed["chunks"]
                 if row["start"] <= token < row["end"])
            for token in range(3)
        ])
        self.assertTrue(all(len(row["categoryDistribution"]) == 4
                            for row in streamed["chunks"]))
        self.assertTrue(all(len(row["categoryCoordinates4D"]) == 4
                            for row in streamed["chunks"]))
        self.assertFalse(streamed["provenance"]["boundarySelectionUsesCategories"])
        self.assertEqual(streamed["frozenModel"]["categoryCount"], 4)
        self.assertFalse(streamed["frozenModel"]["categoryParametersChanged"])

    def test_streamed_blocks_form_one_deterministic_exact_cover(self):
        text = (
            "alpha, beta! gamma delta; epsilon zeta eta theta iota kappa "
            "lambda mu nu xi omicron pi rho sigma tau."
        )
        model = frozen_model()
        horizon = extension(4)
        measured = support(3, 8)
        first = build_streaming_components(
            text, FakeStore(), model, horizon, measured,
        )
        second = build_streaming_components(
            text, FakeStore(), model, horizon, measured,
        )

        self.assertGreater(len(first["blocks"]), 1)
        self.assertEqual(first["owners"], second["owners"])
        self.assertEqual(
            [(row["start"], row["end"], row["category"])
             for row in first["chunks"]],
            [(row["start"], row["end"], row["category"])
             for row in second["chunks"]],
        )
        cursor = 0
        lexical = np.asarray([
            any(character.isalnum() or character == "_" for character in token.text)
            for token in tokenize(text)
        ])
        for index, chunk in enumerate(first["chunks"]):
            self.assertEqual(chunk["index"], index)
            self.assertEqual(chunk["start"], cursor)
            self.assertGreater(chunk["end"], chunk["start"])
            self.assertTrue(lexical[chunk["start"]:chunk["end"]].any())
            self.assertIn(chunk["category"], range(4))
            self.assertEqual(len(chunk["_rawVector"]), DIMENSION)
            self.assertEqual(len(chunk["_influenceVector"]), DIMENSION)
            viewer_context = chunk["viewerContext"]
            self.assertEqual(viewer_context["position"], index)
            self.assertFalse(viewer_context["usesFutureComponents"])
            self.assertFalse(viewer_context["externalIdeaContextUsed"])
            if index == 0:
                self.assertIsNone(viewer_context["predecessorCategory"])
            else:
                self.assertEqual(
                    viewer_context["predecessorCategory"],
                    first["chunks"][index - 1]["category"],
                )
            cursor = chunk["end"]
        self.assertEqual(cursor, first["tokenCount"])
        self.assertEqual(first["coverage"], 1.0)
        self.assertEqual(first["overlapCount"], 0)
        self.assertEqual(set(first["owners"]), set(range(first["componentCount"])))

        for block in first["blocks"][:-1]:
            cut = block["cut"]
            expected = max(
                cut["candidates"],
                key=lambda row: (row["posterior"], row["localTokenGap"]),
            )
            self.assertEqual(cut["kind"], "posterior-selected")
            self.assertEqual(cut["selectedGlobalTokenGap"], block["endToken"])
            self.assertEqual(cut["selectedGlobalTokenGap"], expected["globalTokenGap"])
            self.assertAlmostEqual(cut["selectedPosterior"], expected["posterior"])
            self.assertLess(
                cut["selectedLocalTokenGap"], block["evidenceWindowTokenCount"],
            )

        graph = first["graph"]
        self.assertEqual(
            len([node for node in graph["nodes"] if node["type"] == "category"]), 4,
        )
        self.assertEqual(
            len([node for node in graph["nodes"] if node["type"] == "component"]),
            first["componentCount"],
        )
        self.assertEqual(
            len([edge for edge in graph["edges"] if edge["type"] == "next"]),
            first["componentCount"] - 1,
        )
        self.assertEqual(
            len([edge for edge in graph["edges"] if edge["type"] == "posterior-cut"]),
            len(first["blocks"]) - 1,
        )

    def test_long_input_keeps_embedding_and_decoder_work_bounded(self):
        text = " ".join(f"token{index}" for index in range(1200))
        store = FakeStore()
        result = build_streaming_components(
            text,
            store,
            frozen_model(),
            extension(5),
            support(4, 12),
        )
        work = result["work"]

        self.assertEqual(result["tokenCount"], 1200)
        self.assertGreater(work["blockCount"], 1)
        self.assertFalse(work["globalAllSpanRowsMaterialized"])
        self.assertLessEqual(
            work["peakEmbeddingBatchInputs"], work["embeddingBatchInputBound"],
        )
        self.assertEqual(store.maximum_batch, work["peakEmbeddingBatchInputs"])
        self.assertLessEqual(
            work["maximumCandidateSpanRows"], work["candidateSpanRowBound"],
        )
        self.assertLess(
            work["totalCandidateSpanRows"], result["tokenCount"] ** 2 // 20,
        )
        self.assertLessEqual(work["embeddingInputRequests"], 10 * result["tokenCount"])
        minimum_commit = work["blockTokenLimit"] - work["cutLookaheadTokens"]
        self.assertLessEqual(
            work["blockCount"], math.ceil(result["tokenCount"] / minimum_commit) + 1,
        )
        self.assertEqual(len(result["owners"]), result["tokenCount"])
        self.assertTrue(all(owner >= 0 for owner in result["owners"]))

    def test_fixed_causal_windows_do_not_overlap_or_look_past_window(self):
        measured = {**support(8, 8), "causalFixedWindow": True}
        result = build_streaming_components(
            " ".join(f"word{index}" for index in range(25)),
            FakeStore(), frozen_model(), extension(8), measured,
        )
        self.assertEqual(
            [row["tokenCount"] for row in result["blocks"]],
            [8, 8, 8, 1],
        )
        self.assertTrue(result["work"]["fixedCausalWindows"])
        self.assertTrue(all(
            row["cut"]["kind"] in {
                "measured-causal-window-end", "input-end",
            }
            for row in result["blocks"]
        ))

    def test_fixed_causal_windows_do_not_strand_terminal_punctuation(self):
        measured = {**support(8, 8), "causalFixedWindow": True}
        result = build_streaming_components(
            "one two three four five six seven eight nine ten eleven twelve "
            "thirteen fourteen fifteen sixteen .",
            FakeStore(), frozen_model(), extension(8), measured,
        )

        self.assertEqual(
            [row["tokenCount"] for row in result["blocks"]],
            [8, 7, 2],
        )
        self.assertEqual(
            result["blocks"][-2]["cut"]["kind"],
            "lexical-tail-preserving-causal-cut",
        )
        lexical = np.asarray([
            any(character.isalnum() or character == "_" for character in token.text)
            for token in tokenize(result["text"])
        ])
        self.assertTrue(all(
            lexical[row["start"]:row["end"]].any()
            for row in result["chunks"]
        ))
        self.assertEqual(result["owners"], sorted(result["owners"]))
        self.assertEqual(result["coverage"], 1.0)


if __name__ == "__main__":
    unittest.main()
