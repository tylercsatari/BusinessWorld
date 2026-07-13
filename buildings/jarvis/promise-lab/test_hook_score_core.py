import unittest

import numpy as np

from hook_score_core import (
    component_response_windows,
    enrich_word_semantics,
    local_counterfactual_texts,
)
from sequence import tokenize


class HookScoreCoreTest(unittest.TestCase):
    def test_variable_counterfactuals_preserve_source_order(self):
        text = "one two, three four five"
        tokens = tokenize(text)
        owners = np.asarray([0, 0, 1, 1, 2, 2], int)
        values = local_counterfactual_texts(text, tokens, owners, 3)
        self.assertEqual(values["componentCount"], 3)
        self.assertEqual(values["withoutOne"][1], "one two four five")
        self.assertEqual(values["pairOnly"][(0, 2)], "one two four five")
        self.assertEqual(len(values["withoutPair"]), 3)

    def test_one_component_has_no_pairs(self):
        text = "one complete thought"
        tokens = tokenize(text)
        owners = np.zeros(len(tokens), int)
        values = local_counterfactual_texts(text, tokens, owners, 1)
        self.assertEqual(values["withoutOne"][0], "")
        self.assertEqual(values["withoutPair"], {})
        self.assertEqual(values["pairOnly"], {})

    def test_word_semantics_preserve_singleton_and_owner_categories(self):
        words = [{"tokenIndex": 0, "component": 0,
                  "spokenStartSeconds": 0, "spokenEndSeconds": .2}]
        tokens = [{"index": 0, "text": "word", "semantic": {
            "category": 1, "frozenAtlasCategory": 1, "categoryProbability": .9,
            "categoryDistribution": [.03, .9, .05, .02],
            "categoryCoordinates4D": [1, 2, 3, 4], "mapX": .2, "mapY": -.1,
            "globalSpanIndex": 7, "categorySource": "test",
        }}]
        chunks = [{"index": 0, "category": 3, "text": "word"}]
        enrich_word_semantics(words, tokens, chunks)
        self.assertEqual(words[0]["singletonCategory"], 1)
        self.assertEqual(words[0]["componentCategory"], 3)
        windows = component_response_windows(words, 1, .5)
        self.assertEqual(windows[0]["category"], 3)


if __name__ == "__main__":
    unittest.main()
