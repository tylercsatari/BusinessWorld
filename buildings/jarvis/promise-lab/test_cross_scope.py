import unittest

import numpy as np

from cross_scope import boundary_support_separation, compare_maps, consensus_agreement


class CrossScopeTests(unittest.TestCase):
    def test_identical_restricted_maps_have_perfect_persistence(self):
        candidate_maps = [{
            "id": "candidate", "representation": "raw",
            "labels": [0, 0, 1, 1], "qualityForBrowsing": 1,
        }]
        all_maps = [{
            "id": "all", "representation": "raw",
            "labels": [0, 2, 0, 2, 1, 3, 1, 3], "qualityForBrowsing": 1,
        }]
        projection = np.asarray([0, 2, 4, 6])
        groups = np.asarray(["a", "b", "c", "d"])
        rows = compare_maps(candidate_maps, all_maps, projection, groups,
                            sample_size=4, candidate_map_limit=1)
        self.assertAlmostEqual(rows[0]["bestARI"], 1.0)
        agreement = consensus_agreement(candidate_maps, all_maps, projection, pair_count=1000)
        self.assertAlmostEqual(agreement["spearman"], 1.0)
        self.assertAlmostEqual(agreement["meanAbsoluteDifference"], 0.0)

    def test_boundary_separation_is_postfit_summary_only(self):
        cluster_map = {"clusterSummaries": [
            {"size": 10, "boundarySupportedFraction": .8},
            {"size": 10, "boundarySupportedFraction": .2},
        ]}
        result = boundary_support_separation(cluster_map, .5)
        self.assertAlmostEqual(result["weightedAbsoluteEnrichment"], .3)
        self.assertAlmostEqual(result["maximumAbsoluteEnrichment"], .3)


if __name__ == "__main__":
    unittest.main()
