import unittest

import numpy as np

from rtg_pairs import build_same_idea_pairs, pair_differences


class PairTests(unittest.TestCase):
    def test_pairs_remain_inside_semantic_groups(self):
        rows = [{"id": str(i)} for i in range(12)]
        title = np.vstack([
            np.asarray([1, 0, 0]) + np.random.default_rng(i).normal(scale=.03, size=3)
            if i < 4 else np.asarray([0, 1, 0]) + np.random.default_rng(i).normal(scale=.03, size=3)
            if i < 8 else np.asarray([0, 0, 1]) + np.random.default_rng(i).normal(scale=.03, size=3)
            for i in range(12)
        ])
        groups = np.asarray([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
        pairs, folds, meta = build_same_idea_pairs(rows, title, groups, neighbors_per_video=2)
        self.assertTrue(pairs)
        self.assertTrue(folds)
        self.assertTrue(all(groups[pair["a"]] == groups[pair["b"]] for pair in pairs))
        self.assertEqual(meta["semanticGroups"], 3)

    def test_pair_difference_uses_declared_orientation(self):
        values = np.asarray([[1, 4], [3, 2], [6, 9]], float)
        pairs = [{"a": 0, "b": 1}, {"a": 2, "b": 0}]
        np.testing.assert_allclose(pair_differences(values, pairs), [[-2, 2], [5, 5]])


if __name__ == "__main__":
    unittest.main()
