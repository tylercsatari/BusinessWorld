import unittest

from rtg_components import align_hook_words, build_components_for_row, tokenize


class ComponentTests(unittest.TestCase):
    def setUp(self):
        text = "I tested viral juggling gloves to see if they make me juggle without experience"
        tokens = tokenize(text)
        self.row = {
            "id": "juggle",
            "hookText": text,
            "hookEndSec": 6.5,
            "hookWordCount": len(tokens),
            "words": [
                {"w": token, "t": index * 0.5, "d": 0.4}
                for index, token in enumerate(tokens + ["then", "this", "happened"])
            ],
        }

    def test_exact_prefix_alignment(self):
        alignment = align_hook_words(self.row)
        self.assertEqual(alignment.method, "timed_prefix")
        self.assertEqual(alignment.exact_rate, 1.0)
        self.assertEqual(alignment.coverage, 1.0)

    def test_lattice_preserves_full_hook_and_context(self):
        records, _ = build_components_for_row(self.row)
        full = [record for record in records if record.isFullHook]
        self.assertEqual(len(full), 1)
        self.assertEqual(full[0].text, self.row["hookText"])
        token = next(record for record in records if record.startToken == 1 and record.endToken == 2)
        self.assertEqual(token.text, "tested")
        self.assertNotIn("tested", token.contextText.split())
        self.assertTrue(token.parentIds)

    def test_lattice_contains_multiple_unlabeled_resolutions(self):
        records, _ = build_components_for_row(self.row)
        modes = {mode for record in records for mode in record.modes}
        self.assertIn("ngram_1", modes)
        self.assertIn("window_4", modes)
        self.assertIn("prefix", modes)
        self.assertIn("suffix", modes)
        self.assertTrue(any(mode.startswith("time_window_") for mode in modes))


if __name__ == "__main__":
    unittest.main()
