import unittest

import numpy as np

from run_axes import retention_at, retention_window_mean, retention_window_slope


class OutcomeGeometryTests(unittest.TestCase):
    def test_fixed_time_outside_video_is_missing_not_clipped(self):
        self.assertTrue(np.isnan(retention_at([1.0, 0.5], 5.0, 8.0)))

    def test_window_mean_and_slope_follow_linear_curve(self):
        curve = np.linspace(1.0, 0.0, 101)
        self.assertAlmostEqual(retention_window_mean(curve, 10.0, 0.0, 5.0), 0.75, places=5)
        self.assertAlmostEqual(retention_window_slope(curve, 10.0, 0.0, 5.0), -0.1, places=5)


if __name__ == "__main__":
    unittest.main()
