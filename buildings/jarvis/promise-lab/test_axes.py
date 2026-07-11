import unittest

import numpy as np

from axes import foldwise_prediction, search_axes


class AxisTests(unittest.TestCase):
    def test_grouped_axis_generalizes_on_planted_direction(self):
        rng = np.random.RandomState(31)
        groups = np.asarray([f"g{i // 2}" for i in range(80)])
        x = rng.normal(size=(80, 18)).astype(np.float32)
        y = x[:, 0] * 1.4 - x[:, 1] * .8 + rng.normal(scale=.08, size=80)
        experiments, prediction_lookup = search_axes(
            {"raw": x},
            {"target": {"values": y, "channel": "synthetic", "definition": "planted"}},
            groups,
            {"none": np.empty((80, 0), np.float32)},
            dimensions=[8, 16],
            alphas=[.1, 1],
            null_repeats=12,
        )
        self.assertGreater(max(row["heldoutSpearman"] for row in experiments), .7)
        self.assertTrue(all(row["groupedBy"] == "source video" for row in experiments))
        self.assertEqual(sum(bool(row["selectedForTarget"]) for row in experiments), 1)
        self.assertEqual(set(prediction_lookup), {
            row["id"] for row in experiments if row["selectedForTarget"]
        })
        self.assertTrue(all("source-video cluster sign-flip" in row["searchWideNull"]
                            for row in experiments))

    def test_foldwise_confound_removal_blocks_surface_only_signal(self):
        rng = np.random.RandomState(8)
        groups = np.asarray([f"g{i // 2}" for i in range(60)])
        surface = rng.normal(size=(60, 2)).astype(np.float32)
        features = np.column_stack([surface, rng.normal(size=(60, 8))]).astype(np.float32)
        target = surface[:, 0] * 2 + rng.normal(scale=.02, size=60)
        prediction, residual = foldwise_prediction(features, target, groups, surface, 6, 1)
        valid = np.isfinite(prediction)
        self.assertLess(abs(np.corrcoef(prediction[valid], residual[valid])[0, 1]), .5)

    def test_foldwise_confound_imputation_is_train_only_and_finite(self):
        rng = np.random.RandomState(19)
        groups = np.asarray([f"g{i // 2}" for i in range(60)])
        confounds = rng.normal(size=(60, 3)).astype(np.float32)
        confounds[::7, 0] = np.nan
        confounds[::11, 2] = np.inf
        features = rng.normal(size=(60, 12)).astype(np.float32)
        target = features[:, 0] + rng.normal(scale=.1, size=60)
        prediction, residual = foldwise_prediction(
            features, target, groups, confounds, dimensions=8, alpha=1
        )
        self.assertTrue(np.isfinite(prediction).all())
        self.assertTrue(np.isfinite(residual).all())

    def test_validation_selection_stays_in_required_confound_family(self):
        rng = np.random.RandomState(27)
        groups = np.asarray([f"g{i // 2}" for i in range(80)])
        confound = rng.normal(size=(80, 1)).astype(np.float32)
        features = np.column_stack([confound, rng.normal(size=(80, 9))]).astype(np.float32)
        target = confound[:, 0] * 3 + rng.normal(scale=.05, size=80)
        experiments, lookup = search_axes(
            {"raw": features},
            {"target": {
                "values": target,
                "channel": "synthetic",
                "definition": "confounded",
                "requiredConfounds": "full",
            }},
            groups,
            {"none": np.empty((80, 0), np.float32), "full": confound},
            dimensions=[6],
            alphas=[1],
            null_repeats=8,
        )
        selected = [row for row in experiments if row["selectedForTarget"]]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["confounds"], "full")
        self.assertEqual(set(lookup), {selected[0]["id"]})
        self.assertIsNotNone(selected[0]["searchWideQ"])
        self.assertTrue(all(row["searchWideQ"] is None for row in experiments
                            if not row["selectedForTarget"]))


if __name__ == "__main__":
    unittest.main()
