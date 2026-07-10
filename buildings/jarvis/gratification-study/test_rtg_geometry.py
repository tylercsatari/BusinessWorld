import math
import unittest

import numpy as np

from rtg_geometry import (
    build_geometry_atlas,
    constant_excess_corrected,
    first_crossing,
    ls_slope,
    ret_at,
    sample_window,
)


def row_from_function(function, duration=40.0, hook=5.0):
    times = np.linspace(0.0, duration, 100)
    curve = [function(float(t)) / 100.0 for t in times]
    return {
        "id": f"row-{id(function)}",
        "curve": curve,
        "duration_s": duration,
        "hookEndSec": hook,
        "keep_rate": 75.0,
        "avg_retention": float(np.mean(curve) * 100.0),
        "views": 1_000_000,
    }


class GeometryTests(unittest.TestCase):
    def test_interpolation_preserves_linear_curve(self):
        row = row_from_function(lambda t: 130.0 - t)
        self.assertAlmostEqual(ret_at(row, 7.25), 122.75, places=5)

    def test_window_slope_recovers_known_decline(self):
        row = row_from_function(lambda t: 120.0 - 1.5 * t)
        times, values = sample_window(row, 2.0, 12.0)
        self.assertAlmostEqual(ls_slope(times, values), -1.5, places=5)

    def test_crossing_is_anchor_relative(self):
        row = row_from_function(lambda t: 100.0 - t)
        crossing = first_crossing(row, 5.0, 0.9, 30.0)
        self.assertTrue(9.4 <= crossing <= 9.7)

    def test_constant_excess_correction_is_explicit(self):
        self.assertAlmostEqual(constant_excess_corrected(110.0, 120.0), 90.0)
        self.assertAlmostEqual(constant_excess_corrected(90.0, 100.0), 90.0)

    def test_atlas_contains_multiple_independent_families(self):
        rows = [
            row_from_function(lambda t, i=i: 130.0 - (0.4 + i * 0.01) * t + math.sin(t / (3 + i % 3)))
            for i in range(20)
        ]
        for i, row in enumerate(rows):
            row["id"] = str(i)
            row["views"] += i * 1000
            row["keep_rate"] += i * 0.1
        matrix, defs, bases, _ = build_geometry_atlas(rows, minimum_n=10)
        families = {definition.family for definition in defs}
        self.assertEqual(matrix.shape[0], len(rows))
        self.assertGreater(matrix.shape[1], 400)
        self.assertIn("hook_aligned_point", families)
        self.assertIn("flattening", families)
        self.assertIn("replay", families)
        self.assertIn("unsupervised_curve", families)
        self.assertTrue(bases)


if __name__ == "__main__":
    unittest.main()
