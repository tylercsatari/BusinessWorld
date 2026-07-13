import unittest

import numpy as np

from market_reward import (
    ALPHA_CANDIDATES,
    connected_source_groups,
    fit_external_axis,
    local_market_effects,
    score_market_vector,
)
from score_market_hook import score_hook as score_market_hook


def tiny_model():
    return {
        "status": "validated-cross-source-local-retention-proxy",
        "embeddingModel": "test-embedding",
        "embeddingDimensions": 2,
        "coefficient": [1.0, 0.0],
        "intercept": 0.0,
        "ladder": [-1.0, 0.0, 1.0],
        "mapDirection": [0.0, 1.0],
        "scoreScale": {"predictionMean": 0.0, "predictionStd": 1.0},
        "domainReferenceEmbeddings": [[1.0, 0.0], [0.0, 1.0]],
        "domainReferenceIds": ["a", "b"],
        "domainReferenceTexts": ["alpha", "beta"],
        "domainGate": {"nearestCosineMinimum": 0.5, "nearestCosineP10": 0.75},
        "calibrations": {},
        "localCalibration": {
            "componentsByCategory": {"0": [-1.0, 0.0, 1.0], "1": [-1.0, 0.0, 1.0]},
            "pairsByCategorySequence": {"0->1": [-1.0, 0.0, 1.0]},
        },
        "rewardContract": {"name": "Market Hold"},
        "transferValidation": {"retention_5s": {"status": "supported"}},
    }


class MarketRewardTests(unittest.TestCase):
    def test_channel_and_duplicate_text_form_connected_leakage_groups(self):
        groups = connected_source_groups(
            ["channel-a", "channel-a", "channel-b", "channel-c"],
            ["one phrase", "different", "one phrase", "unrelated"],
        )
        self.assertEqual(groups[0], groups[1])
        self.assertEqual(groups[0], groups[2])
        self.assertNotEqual(groups[0], groups[3])

    def test_external_axis_selects_only_from_fixed_alpha_grid(self):
        rng = np.random.default_rng(20260712)
        groups = np.repeat(np.arange(30), 3).astype(str)
        features = rng.normal(size=(len(groups), 16)).astype(np.float32)
        target = features[:, 0] + 0.15 * rng.normal(size=len(groups))
        result = fit_external_axis(features, target, groups)
        self.assertIn(result["selectedAlpha"], ALPHA_CANDIDATES)
        self.assertEqual(len(result["selection"]), len(ALPHA_CANDIDATES))
        self.assertGreater(result["selectedValidation"]["heldoutSpearman"], 0.7)
        self.assertTrue(
            result["selectedValidation"]["hyperparametersSelectedInsideOuterTrain"]
        )
        self.assertEqual(len(result["selectedValidation"]["outerFolds"]), 5)
        np.testing.assert_allclose(
            np.linalg.norm(result["mapDirection"]), 1.0, atol=1e-5,
        )

    def test_training_reward_is_exact_percentile_with_a_separate_domain_gate(self):
        model = tiny_model()
        in_domain = score_market_vector(np.asarray([1.0, 0.0]), model)
        self.assertEqual(in_domain["percentile"], 100.0)
        self.assertEqual(in_domain["reward"], 1.0)
        self.assertTrue(in_domain["eligibleForTraining"])
        out_of_domain = score_market_vector(np.asarray([-1.0, 0.0]), model)
        self.assertEqual(out_of_domain["percentile"], 100 / 3)
        self.assertIsNone(out_of_domain["reward"])
        self.assertFalse(out_of_domain["eligibleForTraining"])

    def test_component_and_pair_effects_use_the_same_frozen_coordinate(self):
        result = local_market_effects(
            np.asarray([1.0, 0.0]),
            {
                0: np.asarray([0.0, 1.0]),
                1: np.asarray([1.0, 1.0]),
            },
            {(0, 1): np.zeros(2)},
            [0, 1],
            tiny_model(),
        )
        self.assertAlmostEqual(result["components"][0]["effectZ"], 1.0)
        expected = 1.0 - 0.0 - (1 / np.sqrt(2.0)) + 0.0
        relation = result["relationships"][0]
        self.assertAlmostEqual(relation["interactionZ"], expected, places=6)
        self.assertAlmostEqual(
            relation["interactionZ"],
            relation["fullCoordinate"]
            - relation["withoutLeftCoordinate"]
            - relation["withoutRightCoordinate"]
            + relation["withoutBothCoordinate"],
        )

    def test_fast_training_scorer_keeps_relevance_separate(self):
        class Store:
            def embed_many(self, texts):
                vectors = {
                    "candidate": np.asarray([1.0, 0.0]),
                    "different seed": np.asarray([0.0, 1.0]),
                }
                return {text: vectors[text] for text in texts}

        result = score_market_hook(
            "candidate", "different seed", minimum_relevance=0.5,
            model=tiny_model(), store=Store(),
        )
        self.assertEqual(result["trainingReward"]["percentile"], 100.0)
        self.assertIsNone(result["trainingReward"]["reward"])
        self.assertFalse(result["topicalRelevance"]["passes"])
        self.assertFalse(result["input"]["visualInputUsed"])


if __name__ == "__main__":
    unittest.main()
