import unittest

import numpy as np

from hook_score_core import pair_interactions, projection_scores, shapley_values, subset_texts
from score_hook import MAX_HOOK_TOKENS, build_span_primitives
from sequence import tokenize


class HookScoreCoreTest(unittest.TestCase):
    def test_live_scorer_rejects_quadratic_input_before_embedding(self):
        class StoreThatMustNotRun:
            def embed_many(self, _texts):
                raise AssertionError("oversized input reached the embedding API")

        text = " ".join(f"token{index}" for index in range(MAX_HOOK_TOKENS + 1))
        with self.assertRaisesRegex(ValueError, "at most 64 tokens"):
            build_span_primitives(text, StoreThatMustNotRun())

    def test_subsets_never_duplicate_source_atoms(self):
        text = "one two three four"
        tokens = tokenize(text)
        values = subset_texts(text, tokens, np.asarray([0, 1, 2, 3]))
        self.assertEqual(values[15], text)
        self.assertEqual(values[5], "one three")
        self.assertEqual(values[8], "four")

    def test_shapley_and_pairs_share_one_projection_function(self):
        direction = np.asarray([1.0, 0.0], np.float32)
        vectors = {mask: np.asarray([float(mask), 1.0], np.float32) for mask in range(1, 16)}
        scores = projection_scores(vectors, direction)
        values = shapley_values(scores, 4)
        self.assertAlmostEqual(float(values.sum()), scores[15], places=8)
        self.assertEqual(len(pair_interactions(scores, 4)), 6)


if __name__ == "__main__":
    unittest.main()
