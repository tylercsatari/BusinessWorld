import unittest

import numpy as np

from projection_experiment import (
    canonical_qr,
    cluster_moments,
    maxmin_plane,
    plane_pair_ratios,
)


class ProjectionExperimentTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(17)
        centers = np.asarray([
            [-2.0, -1.0, 0.0, 0.0],
            [2.0, -1.0, 0.0, 0.0],
            [-0.2, 1.0, -2.0, 0.0],
            [0.2, 1.0, 2.0, 0.0],
        ])
        self.labels = np.repeat(np.arange(4), 120)
        self.values = np.vstack([
            rng.normal(center, [0.35, 0.35, 0.35, 0.7], size=(120, 4))
            for center in centers
        ])
        self.moments = cluster_moments(self.values, self.labels, 4)

    def test_canonical_qr_returns_orthonormal_plane(self):
        basis = canonical_qr(np.asarray([
            [1.0, 1.0], [0.0, 1.0], [1.0, 0.0], [0.5, -0.5]
        ]))
        np.testing.assert_allclose(basis.T @ basis, np.eye(2), atol=1e-12)

    def test_rigid_2d_rotation_cannot_change_pair_distinctness(self):
        basis = canonical_qr(np.eye(4)[:, :2])
        theta = 0.73
        rotation = np.asarray([
            [np.cos(theta), -np.sin(theta)],
            [np.sin(theta), np.cos(theta)],
        ])
        original = plane_pair_ratios(basis, self.moments)
        rotated = plane_pair_ratios(basis @ rotation, self.moments)
        np.testing.assert_allclose(original, rotated, atol=1e-12)

    def test_maxmin_plane_improves_or_matches_first_two_axes(self):
        baseline = canonical_qr(np.eye(4)[:, :2])
        optimized, audit = maxmin_plane(
            self.moments, random_planes=2_000, refinement_planes_per_scale=500
        )
        baseline_worst = plane_pair_ratios(baseline, self.moments).min()
        optimized_worst = plane_pair_ratios(optimized, self.moments).min()
        self.assertGreaterEqual(optimized_worst, baseline_worst)
        self.assertTrue(audit["orthonormalConstraint"])


if __name__ == "__main__":
    unittest.main()
