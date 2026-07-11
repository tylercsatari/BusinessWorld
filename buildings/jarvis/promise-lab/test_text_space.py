import unittest

import numpy as np

from text_space import score_neighbor_tables, weighted_neighbor_average


class TextSpaceTests(unittest.TestCase):
    def test_weighted_neighbor_average_matches_explicit_formula(self):
        values = np.asarray([10, 20, 40], float)
        indices = np.asarray([[0, 2]])
        weights = np.asarray([[1, 3]], float)
        result = weighted_neighbor_average(values, indices, weights)
        self.assertAlmostEqual(result[0], 32.5)

    def test_all_long_quant_outputs_are_scored(self):
        mapping = {
            "views": [100, 1000, 10000],
            "outlier": [1, 2, 8],
            "proj": {
                "ctrviews": {"x": [10, 20, 30]},
                "ctr": {"est": [2, 4, 6]},
                "ret30": {"est": [30, 50, 70]},
                "realviews": {"est": [100, 500, 900]},
            },
        }
        result = score_neighbor_tables(mapping, np.asarray([[0, 1, 2]]),
                                       np.asarray([[.9, .8, .7]]))
        self.assertEqual(set(result), {"ctrviews", "ctr", "ret30", "views",
                                       "scaled_views", "realviews", "gt10m"})


if __name__ == "__main__":
    unittest.main()
