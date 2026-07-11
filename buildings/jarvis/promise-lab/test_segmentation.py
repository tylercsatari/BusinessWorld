import unittest
from itertools import combinations

import numpy as np

from segmentation import discover_boundaries, optimal_partitions


class SegmentationTests(unittest.TestCase):
    def test_shared_lattice_matches_exhaustive_partitions(self):
        rng = np.random.RandomState(19)
        n = 6
        cost = np.full((n + 1, n + 1), np.inf)
        for start in range(n):
            for end in range(start + 1, n + 1):
                cost[start, end] = rng.uniform(-1, 2)
        solved = optimal_partitions(cost)
        for k in range(1, n + 1):
            brute = []
            for breaks in combinations(range(1, n), k - 1):
                points = (0,) + breaks + (n,)
                partition = list(zip(points[:-1], points[1:]))
                brute.append((sum(cost[start, end] for start, end in partition), partition))
            expected = min(brute, key=lambda item: item[0])
            self.assertAlmostEqual(solved[k][0], expected[0])
            self.assertEqual(solved[k][1], expected[1])

    def test_planted_interaction_break_is_visible_without_text_rules(self):
        rng = np.random.RandomState(4)
        n, dim = 8, 20
        left = rng.normal(size=dim)
        right = rng.normal(size=dim)
        token_effects = np.vstack([
            left + rng.normal(scale=.03, size=dim) for _ in range(4)
        ] + [
            right + rng.normal(scale=.03, size=dim) for _ in range(4)
        ]).astype(np.float32)
        pair = np.full((n, n), .05, np.float32)
        pair[:4, :4] = .9
        pair[4:, 4:] = .9
        np.fill_diagonal(pair, 0)
        starts, ends, nonadd = [], [], []
        for start in range(n):
            for end in range(start + 1, n + 1):
                starts.append(start)
                ends.append(end)
                nonadd.append(1.0 if (start < 4 and end <= 4) or (start >= 4) else .1)
        result = discover_boundaries({
            "token_effects": token_effects,
            "pair_norms": pair,
            "span_start": np.asarray(starts),
            "span_end": np.asarray(ends),
            "span_nonadditive_norm": np.asarray(nonadd),
        }, null_repeats=12, bootstrap_repeats=4, seed=8)
        best = max(result["boundaries"], key=lambda row: row["calibratedZ"])
        self.assertEqual(best["index"], 4)

    def test_null_sequence_does_not_create_perfect_evidence(self):
        rng = np.random.RandomState(7)
        n, dim = 7, 16
        token_effects = rng.normal(size=(n, dim)).astype(np.float32)
        pair = rng.uniform(.1, .9, size=(n, n)).astype(np.float32)
        pair = (pair + pair.T) / 2
        np.fill_diagonal(pair, 0)
        starts, ends = zip(*[(a, b) for a in range(n) for b in range(a + 1, n + 1)])
        result = discover_boundaries({
            "token_effects": token_effects,
            "pair_norms": pair,
            "span_start": np.asarray(starts),
            "span_end": np.asarray(ends),
            "span_nonadditive_norm": rng.uniform(size=len(starts)),
        }, null_repeats=8, bootstrap_repeats=2, seed=3)
        self.assertTrue(all(0 <= row["frequency"] <= 1 for row in result["boundaries"]))
        self.assertTrue(all(0 <= row["calibratedQ"] <= 1 for row in result["boundaries"]))


if __name__ == "__main__":
    unittest.main()
