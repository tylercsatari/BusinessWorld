import gzip
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from rtg_visualizations import build_visualization_artifact


class VisualizationArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        rng = np.random.default_rng(12)
        self.video_ids = [f"v{i}" for i in range(8)]
        self.geometry = np.column_stack([
            np.linspace(0, 1, 8),
            np.linspace(1, 0, 8) + rng.normal(0, 0.03, 8),
        ])
        np.savez_compressed(
            self.root / "matrices.npz",
            geometry=self.geometry,
            metric_ids=np.asarray(["m1", "m2"]),
            confounds=np.linspace(0, 1, 8).reshape(-1, 1),
            confound_ids=np.asarray(["c1"]),
            semantic_groups=np.asarray([0, 0, 1, 1, 2, 2, 3, 3]),
            video_ids=np.asarray(self.video_ids),
            representation_hook=rng.normal(size=(8, 3)),
            representation_title=rng.normal(size=(8, 3)),
            adjusted_delivery_entry_idea=self.geometry,
            adjusted_full_pre_exposure=self.geometry * 0.9,
        )
        self.report = {
            "geometry": {"metrics": [
                {"id": "m1", "label": "Metric one", "family": "shape", "formula": "f1", "coordinate": "hook", "unit": "%"},
                {"id": "m2", "label": "Metric two", "family": "timing", "formula": "f2", "coordinate": "video", "unit": "s"},
            ]},
            "representations": [
                {"id": "hook", "label": "Hook", "formula": "E(hook)", "dimensions": 3},
                {"id": "title", "label": "Title", "formula": "E(title)", "dimensions": 3},
            ],
            "adjustments": {
                "delivery_entry_idea": {"families": ["delivery", "entry", "idea"], "controls": ["c1"]},
                "full_pre_exposure": {"families": ["all"], "controls": ["c1"]},
            },
            "nullCalibration": {"maxRho": {"global": [0.4], "withinIdea": [0.42]}},
        }
        rows = [
            self.row("m1", "shape", "hook", "raw", "video", 0.82, 0.3, 1.0),
            self.row("m1", "shape", "hook", "delivery_entry_idea", "video", 0.50, 0.2, 0.8),
            self.row("m1", "shape", "title", "full_pre_exposure", "video", 0.35, 0.1, 0.8),
            self.row("m2", "timing", "title", "delivery_entry_idea", "video", 0.30, 0.15, 0.8),
            self.row("m1", "shape", "hook", "delivery_entry_idea", "same_idea_difference", 0.45, 0.1, 0.8),
            self.row("m2", "timing", "title", "delivery_entry_idea", "same_idea_difference", 0.20, 0.1, 0.8),
            self.row("nuisance_duration", "duration", "hook", "raw", "nuisance_prediction", 0.18, 0.05, 0.8),
        ]
        with gzip.open(self.root / "registry.jsonl.gz", "wt", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def row(target, family, representation, adjustment, scope, rho, r2, stability):
        return {
            "id": f"{scope}-{target}-{representation}-{adjustment}",
            "target": target,
            "targetFamily": family,
            "representation": representation,
            "adjustment": adjustment,
            "scope": scope,
            "alpha": 1.0,
            "n": 8,
            "rho": rho,
            "r2": r2,
            "p": 0.01,
            "q": 0.02,
            "signStability": stability,
            "foldRhos": [rho, rho],
            "valid": True,
        }

    def build(self, filename):
        path = self.root / filename
        manifest = build_visualization_artifact(
            self.report,
            self.root / "matrices.npz",
            self.root / "registry.jsonl.gz",
            path,
            include_umap=False,
            min_axis_samples=4,
        )
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return manifest, json.load(handle)

    def test_builds_maps_axes_and_complete_result_summary(self):
        manifest, payload = self.build("visualizations.json.gz")
        self.assertEqual(manifest["representations"], 2)
        self.assertEqual(manifest["indicators"], 2)
        self.assertEqual(payload["meta"]["registryRows"], 7)
        self.assertEqual(len(payload["maps"]["hook"]["pca"]["x"]), 8)
        self.assertIn("m1", payload["axisMaps"])
        self.assertIn("m2", payload["axisMaps"])
        indicators = {row["id"]: row for row in payload["results"]["indicators"]}
        self.assertEqual(indicators["m1"]["status"], "null_clear")
        self.assertTrue(indicators["m1"]["pairNullClear"])
        self.assertEqual(indicators["m1"]["pairStatus"], "null_clear")
        self.assertEqual(indicators["m2"]["status"], "candidate")
        self.assertEqual(indicators["m2"]["pairStatus"], "candidate")
        self.assertEqual(payload["results"]["counts"]["promotedIndicators"], 0)
        self.assertEqual(payload["results"]["findings"][0]["status"], "not_promoted")

    def test_projection_coordinates_are_deterministic(self):
        _, first = self.build("first.json.gz")
        _, second = self.build("second.json.gz")
        self.assertEqual(first["maps"], second["maps"])
        self.assertEqual(first["axisMaps"], second["axisMaps"])


if __name__ == "__main__":
    unittest.main()
