import unittest

import numpy as np

from opening_predictor import build_causal_sequence_feature_stages


class CausalSequenceFeatureTests(unittest.TestCase):
    def component(self, index, category, predecessor=None):
        coordinates = np.zeros(4, np.float32)
        coordinates[category] = 1.0
        return {
            "index": index,
            "startToken": index * 2,
            "endToken": index * 2 + 2,
            "category": category,
            "categoryProbability": 0.8,
            "categoryCoordinates4D": coordinates.tolist(),
            "viewerContext": {
                "predecessorCategory": predecessor,
                "predecessorSemanticSimilarity": None if predecessor is None else 0.3,
                "historySemanticSimilarity": None if predecessor is None else 0.2,
                "usesFutureComponents": False,
                "externalIdeaContextUsed": False,
            },
        }

    def test_stage_dimensions_stay_fixed_when_context_grows(self):
        prefix = np.arange(12, dtype=np.float32) + 1
        empty = build_causal_sequence_feature_stages(prefix, [], 1, 2, 2.0)
        one = build_causal_sequence_feature_stages(
            prefix, [self.component(0, 2)], 2, 4, 2.0,
        )
        two = build_causal_sequence_feature_stages(
            prefix,
            [self.component(0, 2), self.component(1, 1, predecessor=2)],
            3, 6, 2.0,
        )
        for stage in ("timing", "semantic", "components", "relationships"):
            self.assertEqual(len(empty[stage]), len(one[stage]))
            self.assertEqual(len(one[stage]), len(two[stage]))
            self.assertTrue(np.isfinite(two[stage]).all())
        self.assertFalse(np.allclose(one["relationships"], two["relationships"]))

    def test_invalid_category_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside 0..3"):
            build_causal_sequence_feature_stages(
                np.ones(8), [{
                    **self.component(0, 3),
                    "category": 4,
                }], 1, 1, 1.0,
            )


if __name__ == "__main__":
    unittest.main()
