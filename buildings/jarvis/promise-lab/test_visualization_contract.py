import json
import gzip
import hashlib
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
        cls.lattice = load_json("component-lattice.json")
        cls.research_contract = load_json("research-contract.json")
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
            "multi-resolution-lattice", "attention-relational-graph",
            "opening-20s", "research-contract",
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
            'kind === \'deconfounding-curves\'',
            'kind === \'deconfounding-heatmap\'',
            'kind === \'deconfounding-lag\'',
            'kind === \'deconfounding-reverse\'',
            'kind === \'deconfounding-baselines\'',
            'data-pl-retention-mode="entry"',
            'data-pl-retention-mode="absolute"',
            'data-pl-retention-mode="terminal"',
            'data-pl-canvas="lattice-embedding"',
            'data-pl-canvas="lattice-spans"',
            'data-pl-canvas="lattice-graph"',
            'data-pl-canvas="opening20s-retention"',
            'data-pl-canvas="opening20s-lag"',
            'data-pl-opening20s-component-measurements',
            'opening20sDetailCache',
            'data-pl-auxiliary-node',
            'data-pl-reveal-inspector',
            'plInterpolationPoints',
            'nativeObservedTimesSeconds || []).length',
            'EXPLORATORY RESPONSE AXIS WITHHELD',
            'class="pl-lattice-controls"',
            'SCORED EXACT COVER',
            'partition.canonicalComponentNodeIds',
            "kind === 'lattice-embedding'",
            "kind === 'lattice-spans'",
            "kind === 'lattice-graph'",
            "kind === 'opening20s-retention'",
            "kind === 'opening20s-lag'",
            'latticeEdgeMeasurement(edge)',
            "renderStoredLattice(row)",
            "function opening20sScorerLattice(result)",
            "state.hookScoreOpeningLattice || result.componentLattice",
            "typed 20-second response cover",
            "observed start timestamps",
            "timestampCollisionGroups",
            "sourceStartTimestampSeconds",
            "resolvedIntervalsNonoverlapping",
            "canonicalComponentNodeIds: [...canonicalIds]",
            "lattice: renderLattice",
            "contract: renderResearchContract",
            "opening20s: renderOpening20s",
            "['multi-resolution-lattice', 'attention-relational-graph'].includes(row.id) ? 'lattice'",
            "row.id === 'research-contract' ? 'contract'",
            'data-pl-research-contract-table',
            'analysis stops',
            '% hook',
        )
        for marker in required_ui_markers:
            self.assertIn(marker, self.ui)
        self.assertNotIn("Retention-curve error by second", self.ui)
        self.assertNotIn("response.selectedLagSeconds || 0", self.ui)
        emitted = set(re.findall(r'data-pl-canvas="([^"]+)"', self.ui))
        handled = set(re.findall(r"kind === '([^']+)'", self.ui))
        self.assertEqual(emitted - handled, set(),
                         "every emitted canvas kind needs a draw handler")
        self.assertIn("SUPPORTED TRANSFER", self.ui)
        self.assertNotIn("retained map 0042", self.ui)
        self.assertIn("state.data.canonicalPartitions || {}).mapId", self.ui)

    def test_lattice_and_research_contract_cover_the_real_corpus(self):
        hooks = self.outcomes["hooks"]
        expected_spans = sum(
            int(row["tokenCount"]) * (int(row["tokenCount"]) + 1) // 2
            for row in self.lattice["rows"]
        )
        self.assertEqual(self.lattice["hookCount"], len(hooks))
        self.assertEqual(self.lattice["spanCount"], expected_spans)
        self.assertEqual(len(self.lattice["rows"]), len(hooks))
        self.assertTrue(all(
            int(row["spanCount"])
            == int(row["tokenCount"]) * (int(row["tokenCount"]) + 1) // 2
            for row in self.lattice["rows"]
        ))
        self.assertEqual(len(self.lattice["mapDefinitions"]), 12)
        self.assertTrue(self.lattice["parityContract"]["shared"])
        self.assertFalse(self.lattice["graphContract"]["structuralEdgeOutcomesUsed"])
        first = self.lattice["rows"][0]
        with gzip.open(CACHE / "component-lattice" / f"{first['videoId']}.json.gz", "rt") as handle:
            detail = json.load(handle)
        self.assertTrue(detail["partitionContract"]["exactNonoverlappingCover"])
        self.assertFalse(detail["partitionContract"]["selectionUsesOutcomes"])
        self.assertEqual(
            detail["partitionContract"]["tokenOwnership"],
            [1] * detail["tokenCount"],
        )
        source = HERE / "REFERENCE_TO_GRATIFICATION_RESEARCH_PROGRAM.md"
        contract = self.research_contract
        self.assertEqual(len(contract["rows"]), 66)
        self.assertEqual(contract["contract"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertFalse(contract["definitionOfDone"]["met"])
        self.assertNotIn("contract-only", {row["status"] for row in contract["rows"]})


if __name__ == "__main__":
    unittest.main()
