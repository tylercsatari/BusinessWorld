import unittest

import numpy as np

from rtg_clusters import stable_kmeans, video_cluster_features


class DummyComponent:
    def __init__(self, video_id, position):
        self.videoId = video_id
        self.relativeStart = position


class ClusterTests(unittest.TestCase):
    def test_stable_kmeans_reports_seed_and_bootstrap_stability(self):
        rng = np.random.default_rng(7)
        values = np.vstack([
            rng.normal(loc=-3, scale=.2, size=(100, 4)),
            rng.normal(loc=3, scale=.2, size=(100, 4)),
        ])
        _, labels, stability = stable_kmeans(values, 2)
        self.assertEqual(len(labels), 200)
        self.assertGreater(stability["meanSeedAdjustedRand"], .9)
        self.assertGreater(stability["meanBootstrapAdjustedRand"], .9)

    def test_video_features_include_presence_proportion_and_position(self):
        components = [DummyComponent("a", .1), DummyComponent("a", .7), DummyComponent("b", .4)]
        labels = np.asarray([0, 1, 1])
        features = video_cluster_features(components, labels, ["a", "b"], 2)
        self.assertEqual(features.shape, (2, 6))
        self.assertEqual(features[0, 0], 1)
        self.assertEqual(features[0, 1], 1)
        self.assertAlmostEqual(features[0, 2] + features[0, 3], 1.0)


if __name__ == "__main__":
    unittest.main()
