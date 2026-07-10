import unittest

import numpy as np

from rtg_experiments import (
    build_grouped_folds,
    oof_ridge_multi,
    pairwise_rank_correlation,
    spearman_fast,
)


class ExperimentEngineTests(unittest.TestCase):
    def test_grouped_oof_recovers_known_axis(self):
        rng = np.random.default_rng(1729)
        n, dimensions = 160, 18
        features = rng.normal(size=(n, dimensions))
        title = rng.normal(size=(n, 32))
        axis = rng.normal(size=dimensions)
        targets = (features @ axis + rng.normal(scale=0.35, size=n))[:, None]
        _, folds, _ = build_grouped_folds(title)
        predicted = oof_ridge_multi(features, targets, folds, alpha=10.0)
        rho, _, count = spearman_fast(targets[:, 0], predicted[:, 0])
        self.assertEqual(count, n)
        self.assertGreater(rho, 0.8)

    def test_pairwise_rank_matrix_has_identity_diagonal(self):
        rng = np.random.default_rng(22)
        values = rng.normal(size=(80, 5))
        values[:10, 2] = np.nan
        correlation, count = pairwise_rank_correlation(values, values)
        np.testing.assert_allclose(np.diag(correlation), np.ones(5), atol=1e-5)
        self.assertEqual(int(count[2, 2]), 70)


if __name__ == "__main__":
    unittest.main()
