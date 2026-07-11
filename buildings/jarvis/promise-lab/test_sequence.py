import unittest

from sequence import (all_pairs, all_spans, normalize_source, replace_span, surface,
                      tokenize, without_span)


class SequenceTests(unittest.TestCase):
    def test_exhaustive_lattice_has_closed_form_size(self):
        tokens = tokenize("Copper plates bend; glass plates break.")
        n = len(tokens)
        self.assertEqual(len(all_spans(n)), n * (n + 1) // 2)
        self.assertEqual(len(all_pairs(n)), n * (n - 1) // 2)

    def test_delete_and_replace_use_exact_observed_boundaries(self):
        tokens = tokenize("Copper plates bend; glass plates break.")
        self.assertEqual(surface(tokens, 0, 2), "Copper plates")
        self.assertNotIn("Copper plates", without_span(tokens, 0, 2))
        replaced = replace_span(tokens, 0, 2, "Rubber sheets")
        self.assertTrue(replaced.startswith("Rubber sheets"))
        self.assertTrue(replaced.endswith("break."))

    def test_every_identity_replacement_preserves_the_exact_normalized_source(self):
        text = "I spent $200 on X-Shot shoes, then walked 50,000 steps (twice)."
        tokens = tokenize(text)
        for span in all_spans(len(tokens)):
            replaced = replace_span(
                tokens,
                span.start,
                span.end,
                surface(tokens, span.start, span.end, source_text=text),
                source_text=text,
            )
            self.assertEqual(replaced, normalize_source(text), (span.start, span.end))

    def test_exact_offset_deletion_does_not_reformat_untouched_text(self):
        text = "I walked 50,000 steps in X-Shot shoes."
        tokens = tokenize(text)
        walked = next(token.index for token in tokens if token.text == "walked")
        self.assertEqual(
            without_span(tokens, walked, walked + 1, source_text=text),
            "I 50,000 steps in X-Shot shoes.",
        )
        self.assertEqual(
            surface(tokens, 0, len(tokens), source_text=text),
            normalize_source(text),
        )


if __name__ == "__main__":
    unittest.main()
