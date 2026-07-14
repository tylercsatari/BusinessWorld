import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

from score_hook import (
    _prediction_text_scope,
    _typed_curve_payload,
    _typed_prefix_features,
)
from sequence import all_spans, tokenize


HERE = Path(__file__).resolve().parent


def scalar_row(second: int) -> dict:
    return {
        "second": float(second),
        "baselineMean": 100.0 - second,
        "model": {
            "coefficient": [1.0, 0.0],
            "intercept": [80.0 - second],
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
        self.assertIn("opening-retention-predictor-v2", result.stdout)

    def test_each_second_uses_only_its_completed_prefix(self):
        text = "one two three four five six seven eight"
        tokens = tokenize(text)
        spans = all_spans(len(tokens))
        starts = np.asarray([span.start for span in spans], int)
        ends = np.asarray([span.end for span in spans], int)
        raw = np.asarray([
            [float(span.end), float(span.end - span.start)] for span in spans
        ], np.float32)
        scope = {
            "plannedSpokenSeconds": 8.0,
            "wordsPerSecond": 1.0,
            "timingSource": "test clock",
        }
        features, trace = _typed_prefix_features({
            "tokens": tokens, "starts": starts, "ends": ends,
            "raw": raw, "text": text,
        }, scope, 8.0)
        self.assertEqual([row["tokenCount"] for row in trace[:8]], list(range(1, 9)))
        self.assertEqual(trace[0]["prefixText"], "one")
        self.assertEqual(trace[7]["prefixText"], text)
        self.assertTrue(all(row["usesWordsAfterThisSecond"] is False for row in trace))
        self.assertEqual(features[1][0], 1.0)
        self.assertEqual(features[8][0], 8.0)

    def test_curve_stops_at_supplied_text_and_has_full_20_second_support(self):
        model = {
            "predictionTimesSeconds": list(range(21)),
            "families": {
                "entryIndexed": {
                    "timeZeroMean": 100.0,
                    "temporalModels": [scalar_row(second) for second in range(1, 21)],
                    "residualP10": [0.0] * 21,
                    "residualP90": [0.0] * 21,
                }
            },
        }
        features = {second: np.asarray([second, 1.0], np.float32) for second in range(1, 21)}
        short = _typed_curve_payload(features, model, 7.5)["entryIndexed"]
        full = _typed_curve_payload(features, model, 20.0)["entryIndexed"]
        self.assertEqual(short["timesSeconds"][-1], 7.5)
        self.assertEqual(len(full["timesSeconds"]), 21)
        self.assertEqual(full["timesSeconds"][-1], 20.0)
        self.assertTrue(full["causalPrefixOnly"])

    def test_duration_scope_is_explicit_and_never_forecasts_missing_words(self):
        model = {
            "analysisHorizonSeconds": 20.0,
            "support": {
                "medianWordsPerSecond": 4.0,
                "measuredWordsPerSecondP10": 3.0,
                "measuredWordsPerSecondP90": 5.0,
            },
        }
        scope = _prediction_text_scope(" ".join(f"w{i}" for i in range(100)), model, 25.0)
        self.assertEqual(scope["estimatedSpokenSeconds"], 20.0)
        self.assertTrue(scope["inputWasLongerThan20Seconds"])
        self.assertIsNotNone(scope["excludedAfter20Seconds"])
        self.assertLess(scope["analyzedLexicalTokens"], scope["inputLexicalTokens"])


if __name__ == "__main__":
    unittest.main()
