import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

from score_hook import _score_local_attributions


def scalar_model(coefficient):
    return {
        "coefficient": coefficient,
        "intercept": [0.0],
        "mapDirection": [0.0, 1.0],
        "trainingPredictionSorted": [-1.0, 0.0, 1.0],
        "validation": {"status": "diagnostic"},
    }


class LocalAttributionTest(unittest.TestCase):
    def test_serving_import_does_not_require_sklearn(self):
        code = """
import builtins
real_import = builtins.__import__
def blocked_import(name, *args, **kwargs):
    if name == 'sklearn' or name.startswith('sklearn.'):
        raise ModuleNotFoundError('blocked serving-only dependency: ' + name)
    return real_import(name, *args, **kwargs)
builtins.__import__ = blocked_import
import score_hook
print(score_hook.SCORER_VERSION)
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("deterministic-variable-hook-scorer", result.stdout)

    def test_component_and_pair_effects_use_the_same_whole_hook_model(self):
        tokens = [
            {"index": 0, "text": "alpha"},
            {"index": 1, "text": "beta"},
        ]
        primitives = {"full": np.asarray([1.0, 0.0], np.float32)}
        partition = {
            "tokens": tokens,
            "owners": np.asarray([0, 1], int),
        }
        components = [
            {"index": 0, "text": "alpha", "category": 0},
            {"index": 1, "text": "beta", "category": 1},
        ]
        interactions = [{"left": 0, "right": 1}]
        counter_vectors = {
            "withoutOne": {
                0: np.asarray([0.0, 1.0], np.float32),
                1: np.asarray([1.0, 1.0], np.float32),
            },
            "withoutPair": {(0, 1): np.zeros(2, np.float32)},
        }
        survival = scalar_model([1.0, 0.0])
        survival.update({
            "scoreScale": {"predictionStd": 0.5},
            "lengthBaseline": {
                "coefficient": [0.0, 0.0, 0.0], "intercept": 90.0,
            },
        })
        curve = {
            "coefficient": [[1.0, 2.0], [0.0, 0.0]],
            "intercept": [100.0, 80.0],
            "progressFractions": [0.0, 1.0],
        }
        model = {
            "survivalModel": survival,
            "hookModels": {"viewed_percent": scalar_model([0.5, 0.0])},
            "curveModel": curve,
            "speakingRate": {"meanWordsPerSecond": 2.0},
            "responseLagSeconds": 0.0,
            "localAttributionCalibration": {
                "claimBoundary": "diagnostic",
                "method": "test calibration",
                "componentsByCategory": {
                    "hook_hold": {"0": [0.0, 1.0], "1": [0.0, 1.0]},
                    "viewed_percent": {"0": [0.0, 0.5], "1": [0.0, 0.5]},
                },
                "pairsByCategorySequence": {
                    "hook_hold": {"0->1": [0.0, 0.5]},
                    "viewed_percent": {"0->1": [0.0, 0.25]},
                },
            },
        }
        outcomes = {
            "survivalScore": {
                "holdZ": 2.0,
                "responseEndSeconds": 1.0,
                "validation": {"status": "diagnostic"},
            }
        }

        scorecard = _score_local_attributions(
            primitives, partition, counter_vectors, components, interactions,
            outcomes, model,
        )

        self.assertEqual(scorecard["coverage"]["componentsScored"], 2)
        self.assertEqual(scorecard["coverage"]["relationshipsScored"], 1)
        self.assertAlmostEqual(
            components[0]["hookHoldContribution"]["effectHoldZ"], 2.0,
        )
        expected_pair = 1.0 - 0.0 - (1 / np.sqrt(2.0))
        self.assertAlmostEqual(
            interactions[0]["hookHoldInteraction"]["interactionHoldZ"],
            expected_pair / 0.5, places=6,
        )
        self.assertIn(
            "viewed_percent", components[0]["wholeHookOutcomeContributions"],
        )


if __name__ == "__main__":
    unittest.main()
