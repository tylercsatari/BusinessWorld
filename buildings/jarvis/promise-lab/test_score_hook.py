import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

from opening_predictor import temporal_attribution
from score_hook import (
    _typed_token_clock,
    _validated_token_clock,
    _variable_curve_payload,
    _variable_prediction_scope,
)
from sequence import tokenize


HERE = Path(__file__).resolve().parent
STAGES = ("timing", "semantic", "components", "relationships")


def compact_model(intercept: float) -> dict:
    return {"coefficient": [0.0, 0.0], "intercept": [intercept]}


def temporal_row(second: int) -> dict:
    return {
        "second": float(second),
        "baselineMean": 100.0 - second,
        "headlineModelAvailable": True,
        "residualP10": -2.0,
        "residualP90": 2.0,
        "stages": {
            stage: {"model": compact_model(80.0 - second - index)}
            for index, stage in enumerate(STAGES)
        },
    }


class CurrentOpeningScorerTest(unittest.TestCase):
    def test_serving_import_does_not_require_sklearn(self):
        code = """
import builtins
real_import = builtins.__import__
def blocked(name, *args, **kwargs):
    if name == 'sklearn' or name.startswith('sklearn.'):
        raise ModuleNotFoundError(name)
    return real_import(name, *args, **kwargs)
builtins.__import__ = blocked
import score_hook
print(score_hook.PREDICTOR_VERSION)
"""
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=HERE, capture_output=True,
            text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("opening-retention-predictor-v3-variable-context", result.stdout)

    def test_scope_never_truncates_and_labels_empirical_forecast_limit(self):
        model = {
            "analysisHorizonSeconds": 94.0,
            "support": {
                "meanWordsPerSecond": 4.0,
                "speakingRateSourceCount": 208,
                "semanticModelHorizonSeconds": 94.0,
            },
        }
        text = " ".join(f"word{index}" for index in range(500))
        scope = _variable_prediction_scope(text, model, None)
        self.assertEqual(scope["analyzedText"], text)
        self.assertFalse(scope["inputWasTruncated"])
        self.assertEqual(scope["analyzedLexicalTokens"], 500)
        self.assertEqual(scope["structuralDurationSeconds"], 125.0)
        self.assertEqual(scope["forecastDurationSeconds"], 94.0)
        self.assertTrue(scope["structurallyUncapped"])
        self.assertIn("risk set", scope["forecastStopReason"])

    def test_one_word_uses_measured_mean_rate_without_duration_input(self):
        model = {
            "support": {
                "meanWordsPerSecond": 5.0,
                "speakingRateSourceCount": 208,
                "semanticModelHorizonSeconds": 94.0,
            },
        }
        scope = _variable_prediction_scope("word", model, None)
        self.assertAlmostEqual(scope["estimatedSpokenSeconds"], 0.2)
        self.assertIn("208 source videos", scope["timingSource"])

    def test_token_clock_assigns_every_lexical_token_once_in_order(self):
        tokens = tokenize("one, two three")
        clock = _typed_token_clock(tokens, 3.0)
        lexical = [row for row in clock if row["lexical"]]
        self.assertEqual(len(lexical), 3)
        self.assertEqual([row["startSeconds"] for row in lexical], [0.0, 1.0, 2.0])
        self.assertEqual([row["endSeconds"] for row in lexical], [1.0, 2.0, 3.0])
        self.assertTrue(all(left["endSeconds"] <= right["startSeconds"]
                            for left, right in zip(lexical, lexical[1:])))

    def test_observed_token_clock_must_cover_every_token_without_reversing(self):
        tokens = tokenize("one two")
        clock = _validated_token_clock(tokens, [
            {"startSeconds": 0.1, "endSeconds": 0.4, "lexical": True},
            {"startSeconds": 0.4, "endSeconds": 0.8, "lexical": True},
        ])
        self.assertEqual([row["index"] for row in clock], [0, 1])
        with self.assertRaisesRegex(ValueError, "cover every token"):
            _validated_token_clock(tokens, clock[:1])
        with self.assertRaisesRegex(ValueError, "moves backward"):
            _validated_token_clock(tokens, [
                {"startSeconds": 0.1, "endSeconds": 0.5, "lexical": True},
                {"startSeconds": 0.4, "endSeconds": 0.8, "lexical": True},
            ])

    def test_failed_promotion_serves_baseline_and_keeps_candidate_visible(self):
        family = {
            "timeZeroMean": 100.0,
            "temporalModels": [temporal_row(second) for second in range(1, 4)],
            "stageOrder": list(STAGES),
            "selectedStage": "baseline",
            "candidateStage": "relationships",
            "promotion": {"promoted": False},
        }
        features = {
            float(second): {stage: np.asarray([1.0, 0.0], np.float32)
                            for stage in STAGES}
            for second in range(1, 4)
        }
        curve = _variable_curve_payload(
            features, {"analysisHorizonSeconds": 3.0,
                       "families": {"entryIndexed": family}}, 3.0,
        )["entryIndexed"]
        self.assertEqual(curve["selectedStage"], "baseline")
        self.assertEqual(curve["predicted"], [100.0, 99.0, 98.0, 97.0])
        self.assertNotEqual(curve["stages"]["relationships"], curve["predicted"])

    def test_temporal_attribution_applies_only_selected_stage(self):
        curve = {
            "timesSeconds": [0.0, 1.0, 2.0],
            "predicted": [100.0, 92.0, 87.0],
            "actual": [100.0, 88.0, 83.0],
            "selectedStage": "baseline",
            "candidateStage": "relationships",
            "stages": {
                "baseline": [100.0, 92.0, 87.0],
                "timing": [100.0, 91.0, 86.0],
                "semantic": [100.0, 90.0, 85.0],
                "components": [100.0, 89.0, 84.0],
                "relationships": [100.0, 88.0, 83.0],
            },
        }
        trace = [
            {"second": 1.0, "endToken": 2, "tokenCount": 2,
             "prefixText": "one two"},
            {"second": 2.0, "endToken": 4, "tokenCount": 4,
             "prefixText": "one two three four"},
        ]
        components = [
            {"index": 0, "startToken": 0, "endToken": 2,
             "text": "one two", "category": 0},
            {"index": 1, "startToken": 2, "endToken": 4,
             "text": "three four", "category": 1},
        ]
        result = temporal_attribution(curve, trace, components)
        self.assertEqual(result["selectedStage"], "baseline")
        self.assertTrue(all(step["channelDeltaPoints"]["relationships"] == 0.0
                            for step in result["steps"]))
        self.assertNotEqual(
            result["summary"]["candidateTotalChannelDeltaPoints"]["relationships"],
            0.0,
        )


if __name__ == "__main__":
    unittest.main()
