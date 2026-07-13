import json
import math
import re
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
UI_SOURCE = HERE.parent / "promise-lab-ui.js"


def load_json(name):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


class VisualizationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.partitions = load_json("canonical-partitions.json")
        cls.outcomes = load_json("hook-outcomes.json")
        cls.axes = load_json("axes.json")
        cls.findings = load_json("findings.json")
        cls.ui = UI_SOURCE.read_text(encoding="utf-8")

    def test_every_candidate_gap_is_stored_and_visualizable(self):
        for row in self.partitions["rows"]:
            trace = row.get("boundaryTrace") or {}
            expected_gaps = max(0, int(row["tokenCount"]) - 1)
            probabilities = trace.get("gapCutProbabilitiesOOF") or []
            serving = trace.get("gapCutProbabilitiesServing") or []
            labels = trace.get("gapAboveNullLabels") or []
            self.assertEqual(len(probabilities), expected_gaps, row["videoId"])
            self.assertEqual(len(serving), expected_gaps, row["videoId"])
            self.assertEqual(len(labels), expected_gaps, row["videoId"])
            self.assertTrue(all(math.isfinite(value) and 0 <= value <= 1
                                for value in probabilities))
            self.assertTrue(all(math.isfinite(value) and 0 <= value <= 1
                                for value in serving))
            expected_cuts = sorted(int(chunk["end"])
                                   for chunk in row["chunks"][:-1])
            self.assertEqual(trace.get("selectedCutTokenOffsets"), expected_cuts)

    def test_hook_forecasts_end_at_exact_semantic_evidence(self):
        for row in self.outcomes["hooks"]:
            forecast = row["retentionForecast"]
            endpoint = float(forecast["responseEndSeconds"])
            self.assertEqual(len(forecast["timesSeconds"]), 41)
            self.assertEqual(len(forecast["progressFractions"]), 41)
            self.assertAlmostEqual(float(forecast["timesSeconds"][-1]), endpoint, places=5)
            self.assertAlmostEqual(float(forecast["progressFractions"][-1]), 1.0, places=8)
            self.assertTrue(all(float(word["responseSeconds"]) <= endpoint + 1e-6
                                for word in forecast["words"]))
            self.assertTrue(all(
                float(window["responseWindowEndSeconds"]) <= endpoint + 1e-6
                for window in forecast["componentWindows"]
            ))
        self.assertEqual(self.outcomes["audit"]["postHookOutputPoints"], 0)

    def test_every_axis_has_separate_input_and_target_horizon(self):
        contract = self.findings["visualizationContract"]
        lineage = contract["axisTargetLineage"]
        targets = [row["experiment"]["target"] for row in self.axes["maps"]]
        self.assertEqual(contract["status"], "complete")
        self.assertEqual(contract["errors"], [])
        self.assertEqual(set(lineage), set(targets))
        for target in targets:
            row = lineage[target]
            self.assertEqual(row["semanticInputHorizon"],
                             "the exact analyzed source hook only")
            self.assertTrue((row.get("outcomeWindow") or {}).get("label"))
        twenty = lineage["measured_retention_20s"]
        self.assertEqual(twenty["outcomeWindow"]["kind"],
                         "absolute-video-second-point")
        self.assertEqual(twenty["outcomeWindow"]["endSeconds"], 20.0)
        self.assertEqual(
            twenty["sourceHooksWhoseSemanticInputEndsBeforeOutcomeWindow"],
            twenty["sourceHooks"],
        )
        self.assertLess(
            contract["semanticInputHorizon"]["maximumResponseEndSeconds"], 20.0
        )

    def test_every_declared_visual_channel_has_ui_and_draw_contract(self):
        expected_channels = {
            "partition-boundaries", "complete-hook-planes", "market-transfer",
            "long-title-transfer", "retention-forecast", "word-semantics",
            "component-planes", "relationship-matrices", "legacy-outcome-axes",
        }
        channels = self.findings["visualizationContract"]["channels"]
        self.assertEqual({row["id"] for row in channels}, expected_channels)
        self.assertTrue(all(int(row["graphs"]) > 0 for row in channels))
        required_ui_markers = (
            'data-pl-visualization-contract',
            'data-pl-horizon-lineage',
            'data-pl-boundary-trace',
            'data-pl-market-transfer',
            'data-pl-long-title-transfer',
            'kind === \'boundary-trace\'',
            'kind === \'market-transfer\'',
            'kind === \'long-title-transfer\'',
            'kind === \'axis-horizon\'',
            'analysis stops',
            '% hook',
        )
        for marker in required_ui_markers:
            self.assertIn(marker, self.ui)
        self.assertNotIn("Retention-curve error by second", self.ui)
        emitted = set(re.findall(r'data-pl-canvas="([^"]+)"', self.ui))
        handled = set(re.findall(r"kind === '([^']+)'", self.ui))
        self.assertEqual(emitted - handled, set(),
                         "every emitted canvas kind needs a draw handler")
        self.assertIn("SUPPORTED TRANSFER", self.ui)


if __name__ == "__main__":
    unittest.main()
