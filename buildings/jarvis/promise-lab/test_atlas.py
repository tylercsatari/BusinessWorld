import unittest

import numpy as np

from atlas import (MatrixSource, cross_group_generality, normalized_mutual_information,
                   run_cluster_sweep, summarize_map_clusters)


class AtlasTests(unittest.TestCase):
    def test_sweep_is_outcome_blind_and_returns_maps(self):
        rng = np.random.RandomState(12)
        left = rng.normal(loc=-1, scale=.1, size=(18, 10))
        right = rng.normal(loc=1, scale=.1, size=(18, 10))
        matrix = np.vstack([left, right]).astype(np.float32)
        groups = np.asarray([f"v{i // 3}" for i in range(len(matrix))])
        result = run_cluster_sweep({"raw": matrix}, groups, max_dimension=3,
                                   max_clusters=3, seeds=2, fit_sample=30,
                                   eval_sample=24, map_limit=10)
        self.assertGreater(len(result.experiments), 0)
        self.assertGreater(len(result.maps), 0)
        self.assertTrue(all(row["outcomesUsed"] is False for row in result.experiments))
        self.assertTrue(any(row["clusterCount"] == 2 for row in result.maps))

    def test_lazy_multiresolution_sweep_reports_nuisance_diagnostics(self):
        rng = np.random.RandomState(19)
        matrix = rng.normal(size=(48, 12)).astype(np.float32)
        groups = np.asarray([f"hook-{index // 4}" for index in range(len(matrix))])
        lengths = np.tile(np.arange(1, 5), 12)
        positions = np.tile(np.arange(4), 12)
        source = MatrixSource(matrix.shape, lambda: matrix.copy())
        result = run_cluster_sweep(
            {"lazy": source}, groups, max_dimension=4, max_clusters=4,
            dimensions=[2, 4], cluster_counts=[2, 4], seeds=2,
            fit_sample=40, eval_sample=32, nuisance={
                "length": lengths, "position": positions,
            }, experiment_namespace="test-all-spans",
        )
        self.assertEqual(len(result.experiments), 2 * 2 * 3 * 2)
        self.assertTrue(all("lengthNMI" in row for row in result.maps))
        self.assertEqual(sum("lengthNMI" in row for row in result.experiments), 2 * 2 * 3)
        self.assertTrue(all(len(row["labels"]) == len(matrix) for row in result.maps))
        self.assertTrue(all("test-all-spans" not in row["id"] for row in result.experiments))

    def test_unlabeled_diagnostics_are_bounded(self):
        left = np.asarray([0, 0, 1, 1, 2, 2])
        same = np.asarray([0, 0, 1, 1, 2, 2])
        mixed = np.asarray([0, 1, 0, 1, 0, 1])
        self.assertAlmostEqual(normalized_mutual_information(left, same), 1.0, places=6)
        self.assertLess(normalized_mutual_information(left, mixed), .01)
        self.assertGreater(cross_group_generality(mixed, same), 0.0)
        self.assertLessEqual(cross_group_generality(mixed, same), 1.0)

    def test_cluster_summaries_are_postfit_and_traceable(self):
        rows = [
            {"videoId": "a", "tokenCount": 1, "boundarySupported": True},
            {"videoId": "b", "tokenCount": 2, "boundarySupported": False},
            {"videoId": "c", "tokenCount": 3, "boundarySupported": True},
            {"videoId": "d", "tokenCount": 4, "boundarySupported": False},
        ]
        cluster_map = {"labels": [0, 0, 1, 1]}
        projection = [[0, 0], [.1, .1], [2, 2], [2.1, 2.1]]
        summaries = summarize_map_clusters(rows, cluster_map, projection, 2)
        self.assertEqual([row["size"] for row in summaries], [2, 2])
        self.assertEqual([row["hookCount"] for row in summaries], [2, 2])
        self.assertTrue(all(row["boundarySupportedFraction"] == .5 for row in summaries))
        self.assertTrue(all(len(row["representativeIndices"]) == 2 for row in summaries))
        self.assertTrue(all(row["browseOnly"] for row in summaries))

    def test_map_browser_retains_each_unlabeled_representation(self):
        rng = np.random.RandomState(44)
        first = rng.normal(size=(36, 8)).astype(np.float32)
        second = rng.normal(size=(36, 8)).astype(np.float32)
        groups = np.asarray([f"h{index // 3}" for index in range(36)])
        result = run_cluster_sweep(
            {"first": first, "second": second}, groups,
            dimensions=[2], cluster_counts=[2], seeds=1,
            fit_sample=30, eval_sample=24, map_limit=2,
        )
        self.assertEqual({row["representation"] for row in result.maps}, {"first", "second"})


if __name__ == "__main__":
    unittest.main()
