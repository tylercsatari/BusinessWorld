import unittest

import numpy as np

from sequence_context_experiments import (
    _grouped_forward_chain,
    _validation_or_unavailable,
    build_component_response_rows,
    run_sequence_context_study,
)


class SequenceContextStudyTests(unittest.TestCase):
    def test_empty_chronological_holdout_is_explicitly_unavailable(self):
        result = _validation_or_unavailable(
            np.asarray([np.nan, np.nan]),
            np.asarray([1.0, 2.0]),
            np.asarray([np.nan, np.nan]),
            seed=1,
        )
        self.assertEqual(result, {
            "available": False,
            "rows": 0,
            "reason": "no valid held-out predictions under this split",
        })

    def test_chronological_split_ignores_nonfinite_response_rows(self):
        features = np.arange(60, dtype=np.float32).reshape(30, 2)
        target = np.linspace(-2.0, 1.0, 30, dtype=np.float32)
        target[[2, 11, 22]] = np.nan
        groups = np.asarray([f"video-{index:02d}" for index in range(30)])
        chronology = np.asarray([f"2024-{index:03d}" for index in range(30)])
        result = _grouped_forward_chain(
            features, target, groups, chronology,
            dimensions=1, alpha=10.0, seed=7,
        )
        valid = np.isfinite(result["prediction"] + result["baseline"] + target)
        self.assertGreater(int(valid.sum()), 0)
        self.assertTrue(np.isnan(result["prediction"][[2, 11, 22]]).all())

    def fixture(self):
        records = []
        decompositions = {}
        for source in range(20):
            video_id = f"video-{source:02d}"
            seconds = list(range(31))
            curve = [100.0 - 0.8 * second - (source % 3) * 0.1 for second in seconds]
            records.append({
                "videoId": video_id,
                "published": f"2024-{source + 1:03d}",
                "mediaDurationSeconds": 30.0,
                "retention": {
                    "wholeSeconds": seconds,
                    "curvesPercent": {"entry_indexed": curve},
                },
            })
            chunks = []
            counts = np.zeros(4, int)
            for index in range(8):
                category = index % 4
                previous = None if index == 0 else (index - 1) % 4
                coordinates = np.zeros(4, float)
                coordinates[category] = 1.0 + source * 0.01
                chunks.append({
                    "index": index,
                    "text": f"component {index}",
                    "category": category,
                    "categoryCoordinates4D": coordinates.tolist(),
                    "spokenStartSeconds": float(1 + index * 2),
                    "spokenEndSeconds": float(2 + index * 2),
                    "viewerContext": {
                        "predecessorCategory": previous,
                        "componentsPreviouslyDelivered": index,
                        "categoryDistributionBefore": (
                            (counts / max(1, counts.sum())).astype(float).tolist()
                        ),
                        "predecessorSemanticSimilarity": None if previous is None else 0.2,
                        "historySemanticSimilarity": None if previous is None else 0.1,
                        "historySemanticChange": None if previous is None else 0.9,
                    },
                })
                counts[category] += 1
            decompositions[video_id] = {"chunks": chunks}
        return records, decompositions

    def test_component_windows_use_only_forward_response(self):
        records, decompositions = self.fixture()
        rows = build_component_response_rows(
            records, decompositions, lags=(0, 1),
        )
        self.assertEqual(len(rows), 160)
        first = rows[0]
        self.assertAlmostEqual(
            first["responseByLag"]["0"]["slopePercentagePointsPerSecond"],
            -0.8,
        )
        self.assertEqual(len(first["semanticFeatures"]), 4)
        self.assertEqual(len(first["contextFeatures"]), 14)

    def test_four_planes_and_grouped_validation_are_retained(self):
        records, decompositions = self.fixture()
        rows = build_component_response_rows(records, decompositions, lags=(0, 1))
        study = run_sequence_context_study(
            rows, lags=(0, 1), permutation_repeats=4, seed=71,
        )
        self.assertEqual(study["categoryCount"], 4)
        self.assertFalse(study["categoriesChanged"])
        self.assertEqual(len(study["categories"]), 4)
        for category in study["categories"]:
            self.assertIsNotNone(category["primaryOutcomePlane"])
            self.assertEqual(len(category["primaryOutcomePlane"]["xDirection4D"]), 4)
            self.assertEqual(set(category["outcomePlanesByLag"]), {"0", "1"})
            for experiment in category["lagExperiments"]:
                self.assertEqual(experiment["status"], "complete")
                self.assertIn("historyPermutationNull", experiment)
                self.assertIn("nestedChronologicalMAEGain", experiment)
                self.assertIn("incrementalViewerContextReplicated", experiment)
                self.assertTrue(experiment["outcomePlane"]["points"])


if __name__ == "__main__":
    unittest.main()
