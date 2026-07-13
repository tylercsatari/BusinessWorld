import hashlib
import unittest

import numpy as np

from embedding_store import DIMENSIONS, MODEL
from interventions import INTERVENTION_VERSION, build_tensor, make_plan
from run_interventions import can_resume_tensor


def synthetic_vector(text, dim=24):
    seed = int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)
    rng = np.random.RandomState(seed)
    vector = rng.normal(size=dim)
    return vector / np.linalg.norm(vector)


class InterventionTests(unittest.TestCase):
    def test_resume_contract_rejects_changed_source_or_model(self):
        plan = make_plan("Metal rings rotate.")
        vectors = {text: synthetic_vector(text, dim=DIMENSIONS) for text in plan.required_texts}
        _, metadata = build_tensor(plan, vectors)
        metadata.update({
            "videoId": "video",
            "embeddingModel": MODEL,
            "embeddingDimensions": DIMENSIONS,
            "interventionVersion": INTERVENTION_VERSION,
            "spanCount": len(plan.spans),
            "tokenPairCount": len(plan.pairs),
        })
        self.assertTrue(can_resume_tensor(metadata, plan, "video"))
        self.assertFalse(can_resume_tensor(metadata, make_plan("Metal rings stop."), "video"))
        self.assertFalse(can_resume_tensor({**metadata, "embeddingModel": "other"}, plan, "video"))

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
