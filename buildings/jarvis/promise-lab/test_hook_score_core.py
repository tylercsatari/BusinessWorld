import unittest

import numpy as np

from hook_score_core import local_counterfactual_texts
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


if __name__ == "__main__":
    unittest.main()
