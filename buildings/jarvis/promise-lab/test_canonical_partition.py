import unittest

import numpy as np

from canonical_partition import (
    category_log_probabilities,
    decode_compositional_four_chunks,
    decode_structural_four_chunks,
    decode_with_constraint_audit,
    fit_category_model,
    structural_features,
)


class CanonicalPartitionTests(unittest.TestCase):
    def test_decoder_returns_exact_nonoverlapping_cover(self):
        starts = np.asarray([start for start in range(8) for end in range(start + 1, 9)])
        ends = np.asarray([end for start in range(8) for end in range(start + 1, 9)])
        probability = np.full(len(starts), .05, np.float32)
        logp = np.full((len(starts), 4), np.log(.01), np.float32)
        intended = [(0, 1, 0), (1, 4, 1), (4, 6, 2), (6, 8, 3)]
        for start, end, category in intended:
            index = int(np.flatnonzero((starts == start) & (ends == end))[0])
            probability[index] = .98
            logp[index] = np.log([.003, .003, .003, .003])
            logp[index, category] = np.log(.991)
        result = decode_with_constraint_audit(starts, ends, probability, logp)
        observed = [(row["start"], row["end"], row["category"]) for row in result["chunks"]]
        self.assertEqual(observed, intended)
        owners = np.full(8, -1, int)
        for index, row in enumerate(result["chunks"]):
            owners[row["start"]:row["end"]] = index
        self.assertTrue(np.all(owners >= 0))
        self.assertEqual(sorted(row["category"] for row in result["chunks"]), [0, 1, 2, 3])

    def test_category_probabilities_are_normalized(self):
        rng = np.random.default_rng(4)
        values = np.vstack([rng.normal(label * 3, .2, size=(20, 4)) for label in range(4)])
        labels = np.repeat(np.arange(4), 20)
        model = fit_category_model(values, labels)
        probabilities = np.exp(category_log_probabilities(values, model))
        np.testing.assert_allclose(probabilities.sum(axis=1), 1, atol=1e-5)
        self.assertGreater(np.mean(np.argmax(probabilities, axis=1) == labels), .95)

    def test_structural_decoder_does_not_move_boundaries_for_category_quota(self):
        starts = np.asarray([start for start in range(8) for end in range(start + 1, 9)])
        ends = np.asarray([end for start in range(8) for end in range(start + 1, 9)])
        probability = np.full(len(starts), .02, np.float32)
        logp = np.log(np.tile([.97, .01, .01, .01], (len(starts), 1))).astype(np.float32)
        intended = [(0, 2), (2, 4), (4, 6), (6, 8)]
        for start, end in intended:
            index = int(np.flatnonzero((starts == start) & (ends == end))[0])
            probability[index] = .99
        result = decode_structural_four_chunks(starts, ends, probability, logp)
        self.assertEqual([(row["start"], row["end"]) for row in result["chunks"]], intended)
        self.assertEqual([row["category"] for row in result["chunks"]], [0, 0, 0, 0])

    def test_compositional_decoder_uses_reconstructive_nonoverlapping_units(self):
        starts = np.asarray([start for start in range(8) for end in range(start + 1, 9)])
        ends = np.asarray([end for start in range(8) for end in range(start + 1, 9)])
        raw = np.tile([0.0, 1.0], (len(starts), 1)).astype(np.float32)
        influence = raw.copy()
        intended = [(0, 2), (2, 4), (4, 6), (6, 8)]
        for start, end in intended:
            index = int(np.flatnonzero((starts == start) & (ends == end))[0])
            raw[index] = [1.0, 0.0]
            influence[index] = [1.0, 0.0]
        result = decode_compositional_four_chunks(
            starts, ends, raw, influence, np.asarray([1.0, 0.0]),
            np.log(np.full((len(starts), 4), .25)), np.ones(8, bool),
        )
        self.assertEqual([(row["start"], row["end"]) for row in result["chunks"]], intended)
        self.assertAlmostEqual(result["rawReconstructionCosine"], 1.0, places=6)

    def test_structural_features_are_finite_and_length_free(self):
        rng = np.random.default_rng(8)
        dimension = 12
        starts = np.asarray([start for start in range(4) for end in range(start + 1, 5)])
        ends = np.asarray([end for start in range(4) for end in range(start + 1, 5)])
        count = len(starts)
        full = rng.normal(size=dimension).astype(np.float32)
        arrays = [rng.normal(size=(count, dimension)).astype(np.float32) for _ in range(4)]
        logp = np.log(np.full((count, 4), .25, np.float32))
        features = structural_features(full, *arrays, starts, ends, logp)
        self.assertEqual(features.shape, (count, 14))
        self.assertTrue(np.isfinite(features).all())


if __name__ == "__main__":
    unittest.main()
