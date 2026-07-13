import unittest

from run_discovery import attach_source_contract, cache_matches_source


class ArtifactContractTests(unittest.TestCase):
    def test_discovery_cache_tracks_exact_intervention_fingerprint(self):
        metadata = {
            "text": "same source",
            "fingerprint": "fingerprint-one",
            "interventionVersion": "intervention-one",
            "embeddingModel": "model-one",
            "embeddingDimensions": 1536,
        }
        cached = {
            "methodVersion": "exhaustive-delete-v4.3-exact-offset-mdl-search-null",
            "text": "same source",
            "interventionVersion": "intervention-one",
            "nullRepeats": 32,
            "bootstrapRepeats": 12,
        }
        self.assertTrue(cache_matches_source(cached, metadata, 32, 12))
        self.assertTrue(attach_source_contract(cached, metadata))
        self.assertTrue(cache_matches_source(cached, metadata, 32, 12))
        changed = {**metadata, "fingerprint": "fingerprint-two"}
        self.assertFalse(cache_matches_source(cached, changed, 32, 12))


if __name__ == "__main__":
    unittest.main()
