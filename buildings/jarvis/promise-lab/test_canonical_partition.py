import unittest

import numpy as np

from canonical_partition import (
    BOUNDARY_FEATURE_NAMES,
    boundary_features,
    category_log_probabilities,
    fit_category_model,
    structural_features,
)
from hook_score_core import (
    decode_support_calibrated_chunks,
    decode_variable_chunks,
    support_calibrated_count_prior,
)


def span_rows(token_count):
    starts = np.asarray([
        start for start in range(token_count) for end in range(start + 1, token_count + 1)
    ])
    ends = np.asarray([
        end for start in range(token_count) for end in range(start + 1, token_count + 1)
    ])
    return starts, ends


class CanonicalPartitionTests(unittest.TestCase):
    def test_decoder_allows_one_component(self):
        starts, ends = span_rows(6)
        logp = np.log(np.full((len(starts), 4), .25, np.float32))
        result = decode_variable_chunks(
            starts, ends, np.full(5, .1), logp, np.ones(6, bool),
        )
        self.assertEqual(result["componentCount"], 1)
        self.assertEqual([(row["start"], row["end"]) for row in result["chunks"]], [(0, 6)])

    def test_decoder_selects_variable_boundaries_and_repeated_categories(self):
        starts, ends = span_rows(8)
        boundary = np.asarray([.05, .98, .05, .05, .97, .05, .05])
        logp = np.log(np.full((len(starts), 4), .01, np.float32))
        intended = [(0, 2), (2, 5), (5, 8)]
        for start, end in intended:
            index = int(np.flatnonzero((starts == start) & (ends == end))[0])
            logp[index, 2] = np.log(.97)
        result = decode_variable_chunks(starts, ends, boundary, logp, np.ones(8, bool))
        self.assertEqual(
            [(row["start"], row["end"], row["category"]) for row in result["chunks"]],
            [(0, 2, 2), (2, 5, 2), (5, 8, 2)],
        )
        owners = np.full(8, -1, int)
        for index, row in enumerate(result["chunks"]):
            owners[row["start"]:row["end"]] = index
        np.testing.assert_array_equal(owners, [0, 0, 1, 1, 1, 2, 2, 2])

    def test_decoder_cannot_create_punctuation_only_component(self):
        starts, ends = span_rows(5)
        boundary = np.asarray([.99, .99, .99, .99])
        lexical = np.asarray([True, False, False, True, True])
        logp = np.log(np.full((len(starts), 4), .25, np.float32))
        result = decode_variable_chunks(starts, ends, boundary, logp, lexical)
        for row in result["chunks"]:
            self.assertTrue(lexical[row["start"]:row["end"]].any())

    def test_long_horizon_count_uses_marginal_boundary_posterior_with_support(self):
        starts, ends = span_rows(12)
        logp = np.log(np.full((len(starts), 4), .25, np.float32))
        extension = {
            "maximumObservedComponentTokens": 3,
            "componentLengthDistribution": [
                {"tokens": 3, "probability": 1.0},
            ],
            "method": "test renewal",
            "activationTokenThreshold": 6,
            "trainingSources": 20,
            "trainingComponents": 40,
            "sourceEqualLengthWeights": True,
        }
        prior = support_calibrated_count_prior(12, extension)
        self.assertAlmostEqual(float(prior[4]), 1.0)
        boundary = np.full(11, .01)
        boundary[[2, 5, 8]] = .99
        result = decode_support_calibrated_chunks(
            starts, ends, boundary, logp, np.ones(12, bool), extension,
        )
        self.assertEqual(result["componentCount"], 4)
        self.assertEqual(
            [(row["start"], row["end"]) for row in result["chunks"]],
            [(0, 3), (3, 6), (6, 9), (9, 12)],
        )
        self.assertFalse(result["boundarySelectionUsesCategories"])
        self.assertFalse(result["boundarySelectionUsesOutcomes"])

    def test_category_probabilities_are_normalized(self):
        rng = np.random.default_rng(4)
        values = np.vstack([rng.normal(label * 3, .2, size=(20, 4)) for label in range(4)])
        labels = np.repeat(np.arange(4), 20)
        model = fit_category_model(values, labels)
        probabilities = np.exp(category_log_probabilities(values, model))
        np.testing.assert_allclose(probabilities.sum(axis=1), 1, atol=1e-5)
        self.assertGreater(np.mean(np.argmax(probabilities, axis=1) == labels), .95)

    def test_boundary_features_are_finite_and_length_free(self):
        rng = np.random.default_rng(8)
        dimension = 12
        starts, ends = span_rows(4)
        count = len(starts)
        full = rng.normal(size=dimension).astype(np.float32)
        arrays = [rng.normal(size=(count, dimension)).astype(np.float32) for _ in range(4)]
        logp = np.log(np.full((count, 4), .25, np.float32))
        features = boundary_features(full, *arrays, starts, ends, logp)
        self.assertEqual(features.shape, (3, len(BOUNDARY_FEATURE_NAMES)))
        self.assertTrue(np.isfinite(features).all())

    def test_boundary_features_cannot_depend_on_category_probabilities(self):
        rng = np.random.default_rng(81)
        dimension = 12
        starts, ends = span_rows(5)
        count = len(starts)
        full = rng.normal(size=dimension).astype(np.float32)
        arrays = [rng.normal(size=(count, dimension)).astype(np.float32) for _ in range(4)]
        uniform = np.log(np.full((count, 4), .25, np.float32))
        adversarial = np.log(np.maximum(
            rng.dirichlet(np.ones(4) * .01, size=count), 1e-12,
        )).astype(np.float32)
        left = boundary_features(full, *arrays, starts, ends, uniform)
        right = boundary_features(full, *arrays, starts, ends, adversarial)
        np.testing.assert_array_equal(left, right)

    def test_structural_features_remain_finite_as_audit(self):
        rng = np.random.default_rng(9)
        dimension = 12
        starts, ends = span_rows(4)
        count = len(starts)
        full = rng.normal(size=dimension).astype(np.float32)
        arrays = [rng.normal(size=(count, dimension)).astype(np.float32) for _ in range(4)]
        logp = np.log(np.full((count, 4), .25, np.float32))
        features = structural_features(full, *arrays, starts, ends, logp)
        self.assertEqual(features.shape, (count, 14))
        self.assertTrue(np.isfinite(features).all())


if __name__ == "__main__":
    unittest.main()
