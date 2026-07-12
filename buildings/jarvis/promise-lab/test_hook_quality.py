import unittest

import numpy as np

from hook_quality import pair_interactions, shapley_values


class HookQualityTests(unittest.TestCase):
    def test_shapley_efficiency_for_additive_score(self):
        weights = np.asarray([.2, -.1, .4, .05])
        scores = {
            mask: float(sum(weights[index] for index in range(4) if mask & (1 << index)))
            for mask in range(16)
        }
        observed = shapley_values(scores)
        np.testing.assert_allclose(observed, weights, atol=1e-9)
        self.assertAlmostEqual(float(observed.sum()), scores[15] - scores[0])
        for row in pair_interactions(scores):
            self.assertAlmostEqual(row["interaction"], 0.0, places=9)

    def test_shapley_allocates_interaction_symmetrically(self):
        scores = {}
        for mask in range(16):
            value = float(mask.bit_count())
            if mask & 1 and mask & 2:
                value += 2.0
            scores[mask] = value
        observed = shapley_values(scores)
        self.assertAlmostEqual(observed[0], 2.0)
        self.assertAlmostEqual(observed[1], 2.0)
        self.assertAlmostEqual(observed[2], 1.0)
        self.assertAlmostEqual(observed[3], 1.0)
        interaction = next(row for row in pair_interactions(scores)
                           if row["left"] == 0 and row["right"] == 1)
        self.assertAlmostEqual(interaction["interaction"], 1.0)


if __name__ == "__main__":
    unittest.main()
