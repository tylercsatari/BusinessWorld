import hashlib
import unittest

import numpy as np

from interventions import build_tensor, make_plan


def synthetic_vector(text, dim=24):
    seed = int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)
    rng = np.random.RandomState(seed)
    vector = rng.normal(size=dim)
    return vector / np.linalg.norm(vector)


class InterventionTests(unittest.TestCase):
    def test_tensor_contains_every_span_and_pair(self):
        plan = make_plan("Metal rings rotate while paper strips remain still.")
        vectors = {text: synthetic_vector(text) for text in plan.required_texts}
        arrays, metadata = build_tensor(plan, vectors)
        n = len(plan.tokens)
        self.assertEqual(len(arrays["span_start"]), n * (n + 1) // 2)
        self.assertEqual(metadata["pairCount"], n * (n - 1) // 2)
        self.assertEqual(arrays["pair_norms"].shape, (n, n))
        np.testing.assert_allclose(arrays["pair_norms"], arrays["pair_norms"].T)
        self.assertEqual(len(metadata["tokens"]), n)


if __name__ == "__main__":
    unittest.main()
