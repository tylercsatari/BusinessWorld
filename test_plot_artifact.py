import json
import unittest

from plot_artifact import (
    LONG_PROJECTIONS,
    MAX_SAMPLE_POINTS,
    SHORT_PROJECTIONS,
    build_plot_artifact,
    encode_plot_artifact,
)


def projection(n, offset=0, actual=None, estimated=None):
    result = {
        "x": [offset + index for index in range(n)],
        "y": [1000 - offset - index for index in range(n)],
        "cv": 0.321,
        "co": 0.123,
    }
    if actual is not None:
        result["actual"] = actual
    if estimated is not None:
        result["est"] = estimated
    return result


class PlotArtifactTest(unittest.TestCase):
    def make_map(self, names, n=500):
        ids = [f"video-{index:04d}" for index in range(n)]
        views = [100_000 + index * 10_000 for index in range(n)]
        outlier = [round(1 + index / 100, 2) for index in range(n)]
        plots = {}
        for offset, name in enumerate(names):
            actual = [None if index % 3 else 70 + index / 100 for index in range(n)]
            estimated = [60 + index / 100 for index in range(n)]
            plots[name] = projection(n, offset, actual, estimated)
        return {"n": n, "id": ids, "views": views, "outlier": outlier, "proj": plots}

    def test_short_artifact_exact_schema_and_color_sources(self):
        source = self.make_map(SHORT_PROJECTIONS)
        first = build_plot_artifact(source, "visual", SHORT_PROJECTIONS)
        second = build_plot_artifact(source, "visual", SHORT_PROJECTIONS)

        self.assertEqual(first, second)
        self.assertEqual(
            set(first),
            {"version", "channel", "n", "id", "plots"},
        )
        self.assertEqual(first["id"], source["id"])
        self.assertEqual(tuple(first["plots"]), SHORT_PROJECTIONS)

        for name, plot in first["plots"].items():
            self.assertEqual(
                set(plot),
                {"x", "y", "points", "zMin", "zMax", "colorKind", "cv", "co"},
            )
            self.assertEqual(len(plot["x"]), source["n"])
            self.assertEqual(len(plot["y"]), source["n"])
            self.assertEqual(len(plot["points"]), MAX_SAMPLE_POINTS)
            self.assertTrue(all(isinstance(value, int) for value in plot["x"] + plot["y"]))

        self.assertEqual(first["plots"]["keep"]["colorKind"], "actual/est")
        self.assertEqual(first["plots"]["views"]["colorKind"], "raw views")
        self.assertEqual(first["plots"]["hi10m"]["colorKind"], "raw views")
        self.assertEqual(first["plots"]["outlier"]["colorKind"], "outlier")
        self.assertEqual(first["plots"]["views"]["zMin"], min(source["views"]))
        self.assertEqual(first["plots"]["outlier"]["zMax"], max(source["outlier"]))

        encoded = encode_plot_artifact(first)
        decoded = json.loads(encoded)
        self.assertEqual(decoded, first)
        self.assertLess(len(encoded), len(json.dumps(source).encode("utf-8")))

    def test_long_ctrviews_falls_back_to_x_without_actual_or_est(self):
        source = self.make_map(LONG_PROJECTIONS, n=25)
        source["proj"]["ctrviews"].pop("actual")
        source["proj"]["ctrviews"].pop("est")
        artifact = build_plot_artifact(source, "together", LONG_PROJECTIONS)
        plot = artifact["plots"]["ctrviews"]

        self.assertEqual(plot["colorKind"], "x")
        self.assertEqual(len(plot["points"]), 25)
        self.assertEqual(
            [point[2] for point in plot["points"]],
            source["proj"]["ctrviews"]["x"],
        )

    def test_missing_individual_color_is_null_not_a_fabricated_outcome(self):
        source = self.make_map(SHORT_PROJECTIONS, n=3)
        source["proj"]["keep"]["actual"] = [81, None, None]
        source["proj"]["keep"]["est"] = [70, 72, None]
        source["views"] = [10, None, 30]
        artifact = build_plot_artifact(source, "visual", SHORT_PROJECTIONS)

        self.assertEqual(
            [point[2] for point in artifact["plots"]["keep"]["points"]],
            [81, 72, None],
        )
        self.assertEqual(
            [point[2] for point in artifact["plots"]["views"]["points"]],
            [10, None, 30],
        )

    def test_missing_or_misaligned_projection_fails_loudly(self):
        source = self.make_map(SHORT_PROJECTIONS, n=10)
        del source["proj"]["ret5"]
        with self.assertRaisesRegex(ValueError, "ret5.*missing"):
            build_plot_artifact(source, "text", SHORT_PROJECTIONS)

        source = self.make_map(SHORT_PROJECTIONS, n=10)
        source["proj"]["views"]["x"].pop()
        with self.assertRaisesRegex(ValueError, "views.x.*exactly 10"):
            build_plot_artifact(source, "text", SHORT_PROJECTIONS)


if __name__ == "__main__":
    unittest.main()
