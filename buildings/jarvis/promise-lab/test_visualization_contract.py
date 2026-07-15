import gzip
import json
import math
import re
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
UI_SOURCE = HERE.parent / "promise-lab-ui.js"
LONGQUANT_SOURCE = HERE.parent / "jarvis-longquant.js"
SERVER_SOURCE = HERE.parents[2] / "server.js"
CHANNEL_ORDER = ["baseline", "timing", "semantic", "components", "relationships"]


def load_json(name):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def load_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


class ProductVisualizationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.predictions = load_json("opening-predictions.json")
        cls.model = load_json("opening-retention-model.json")
        cls.context = load_json("opening-context-study.json")
        cls.projection = load_json("manual-projection.json")
        cls.partitions = load_json("canonical-partitions.json")
        cls.manifest = load_json("manifest.json")
        cls.ui = UI_SOURCE.read_text(encoding="utf-8")
        cls.longquant = LONGQUANT_SOURCE.read_text(encoding="utf-8")
        cls.server = SERVER_SOURCE.read_text(encoding="utf-8")

    def test_product_manifest_contains_only_current_surfaces(self):
        self.assertEqual(self.manifest["status"], "complete")
        self.assertEqual(self.manifest["errors"], [])
        self.assertEqual(
            [row["id"] for row in self.manifest["surfaces"]],
            ["scorer", "library", "saved"],
        )
        self.assertEqual(
            set(self.manifest["artifacts"]),
            {
                "openingPredictions", "manualProjection",
                "canonicalPartitions", "hookScore",
            },
        )
        contract = self.manifest["scoringContract"]
        self.assertTrue(contract["structurallyUncapped"])
        self.assertIsNone(contract["structuralInputTokenLimit"])
        self.assertIn("last supported second", contract["primaryOutput"])

    def test_one_renderer_serves_typed_and_saved_analyses(self):
        self.assertIn("function renderAnalysis(analysis, lattice)", self.ui)
        self.assertIn("renderAnalysis(result, result.componentLattice)", self.ui)
        self.assertIn(
            "renderAnalysis(state.selectedPrediction, state.selectedLattice)", self.ui,
        )
        self.assertEqual(self.ui.count("function renderAnalysis("), 1)
        for tab in (
            "['scorer', 'Score opening']",
            "['library', 'Opening library']",
            "['saved', 'Saved embedding']",
        ):
            self.assertIn(tab, self.ui)

    def test_interactive_scorer_has_optional_timing_and_no_text_cap(self):
        self.assertIn("data-pl-score-duration", self.ui)
        self.assertIn("JSON.stringify({ text, durationSeconds, async: true })", self.ui)
        self.assertNotIn("maxlength=", self.ui)
        self.assertIn("blank = measured mean speaking rate", self.ui)
        self.assertNotIn("idea context", self.ui.lower())
        self.assertIn("type at least one word to score", self.server)
        self.assertIn("4 * 1024 * 1024", self.server)

    def test_complete_evidence_surfaces_are_inside_shared_renderer(self):
        for function in (
            "temporalAttributionPanel", "componentEmbeddingPanel",
            "componentMeasurementPanel", "componentRawEvidencePanel",
            "componentLedgerTable", "relationshipPanel", "validationPanel",
            "dataCoveragePanel", "riskSetPanel", "sequenceContextPanel",
            "outcomePlanesPanel", "chronologicalStagePanel",
        ):
            self.assertIn(f"function {function}(", self.ui)
            self.assertGreaterEqual(self.ui.count(f"{function}("), 2)
        for phrase in (
            "Where every served prediction movement comes from",
            "Selected component inside the saved four-cluster embedding",
            "Component evidence, viewer context, and response timing",
            "Analysis data ledger",
        ):
            self.assertIn(phrase, self.ui)

    def test_every_emitted_canvas_has_a_draw_handler(self):
        emitted = set(re.findall(r'data-pl-canvas="([^"]+)"', self.ui))
        handled = set(re.findall(r"kind === '([^']+)'", self.ui))
        self.assertTrue(emitted)
        self.assertEqual(emitted - handled, set())
        self.assertTrue({
            "retention-predicted", "retention-actual", "retention-overlay",
            "attribution", "component-map", "component-response",
            "contributions", "relationships", "validation", "saved-map",
            "risk-set", "outcome-plane", "pooled-mean", "pooled-accuracy",
            "pooled-scatter",
        }.issubset(emitted))

    def test_pooled_scope_uses_same_renderer_and_shows_prediction_accuracy(self):
        self.assertIn("getScope", self.ui)
        self.assertIn("openingPredictions:${scope || state.scope}", self.ui)
        self.assertIn("?scope=${encodeURIComponent(state.scope)}", self.ui)
        self.assertIn("Frozen prediction beside measured retention", self.ui)
        self.assertIn("Frozen prediction accuracy against actual retention", self.ui)
        self.assertIn("account-external holdout rows", self.ui)
        self.assertIn("opening-context-study", self.ui)
        self.assertIn("state.data.openingContextStudy", self.ui)
        self.assertIn("Duration-conditioned baseline only", self.ui)
        self.assertIn("startsWith('cross-account-')", self.ui)
        self.assertIn("actual 20-second retention %", self.ui)
        self.assertGreaterEqual(
            self.ui.count("load('manualProjection', api('manual-projection'))"), 3,
        )
        self.assertEqual(self.ui.count("function renderAnalysis("), 1)

    def test_variable_horizon_summary_and_context_are_visible(self):
        self.assertEqual(self.predictions["version"], 3)
        self.assertTrue(self.predictions["structurallyUncapped"])
        self.assertEqual(self.predictions["sources"], 208)
        self.assertEqual(len(self.predictions["rows"]), 208)
        risk = self.predictions["riskSetBySecond"]
        self.assertTrue(risk)
        counts = [row["riskSetSources"] for row in risk]
        self.assertTrue(all(left >= right for left, right in zip(counts, counts[1:])))
        self.assertEqual(self.context["categoryCount"], 4)
        self.assertEqual(
            {row["category"] for row in self.context["categories"]},
            {0, 1, 2, 3},
        )
        self.assertTrue(all(
            row["primaryOutcomePlane"]["points"]
            for row in self.context["categories"]
        ))
        self.assertTrue(all(
            set(row["outcomePlanesByLag"]) == {str(value) for value in range(6)}
            for row in self.context["categories"]
        ))

    def test_saved_details_emit_complete_shared_contract(self):
        for summary in self.predictions["rows"]:
            detail = load_gzip(
                CACHE / "opening-predictions" / f"{summary['videoId']}.json.gz"
            )
            self.assertEqual(detail["version"], 3)
            self.assertGreaterEqual(
                detail["analysisHorizonSeconds"], detail["forecastHorizonSeconds"],
            )
            self.assertTrue(detail["support"]["structurallyUncapped"])
            components = detail["components"]
            self.assertEqual(len(components), detail["componentCount"])
            self.assertEqual(components[0]["startToken"], 0)
            self.assertEqual(components[-1]["endToken"], detail["tokenCount"])
            self.assertTrue(all(
                left["endToken"] == right["startToken"]
                for left, right in zip(components, components[1:])
            ))
            self.assertEqual(
                len(detail["relationships"]), max(0, len(components) - 1),
            )

            attribution = detail["temporalAttribution"]
            self.assertTrue(attribution["fullStageLadderAvailable"])
            self.assertEqual(attribution["channelOrder"], CHANNEL_ORDER)
            self.assertEqual(
                len(attribution["steps"]), len(attribution["timesSeconds"]) - 1,
            )
            self.assertEqual(
                len(attribution["componentLedger"]), detail["componentCount"],
            )
            for step in attribution["steps"]:
                self.assertTrue(math.isclose(
                    sum(step["channelDeltaPoints"][name] for name in CHANNEL_ORDER),
                    step["predictedDeltaPoints"], abs_tol=1e-4,
                ))
            self.assertTrue(math.isclose(
                sum(attribution["summary"]["totalChannelDeltaPoints"].values()),
                attribution["summary"]["totalPredictedDeltaPoints"], abs_tol=1e-4,
            ))

            for component in components:
                self.assertEqual(len(component["categoryDistribution"]), 4)
                self.assertEqual(len(component["categoryCoordinates4D"]), 4)
                self.assertIsNotNone(component["timelineAttribution"])
                self.assertIsNotNone(component["outcomePlane"])
                self.assertEqual(
                    set(component["outcomePlanesByLag"]),
                    {str(value) for value in range(6)},
                )
                self.assertFalse(component["viewerContext"]["usesFutureComponents"])
                self.assertFalse(component["viewerContext"]["externalIdeaContextUsed"])
            self.assertIn("orderSensitivity", detail)

    def test_library_summary_exposes_exact_components_before_detail_load(self):
        for summary in self.predictions["rows"]:
            self.assertEqual(len(summary["components"]), summary["componentCount"])
            self.assertTrue(all(row["text"] for row in summary["components"]))
            self.assertTrue(all(row["category"] in {0, 1, 2, 3}
                                for row in summary["components"]))
            self.assertGreaterEqual(
                summary["analysisHorizonSeconds"], summary["forecastHorizonSeconds"],
            )
        self.assertIn("exact components and clusters", self.ui)
        self.assertIn("componentLedgerTable(analysis)", self.ui)

    def test_saved_embedding_is_the_same_frozen_category_map(self):
        self.assertTrue(self.projection["saved"])
        self.assertEqual(self.projection["mapId"], self.partitions["mapId"])
        labels = self.projection["frozenPointIndex"]["labels"]
        self.assertEqual(len(labels), self.projection["reconstruction"]["rows"])
        self.assertEqual(set(labels), {0, 1, 2, 3})
        self.assertIn("projectedComponentPoint(component, method)", self.ui)
        self.assertIn("basis4x2", self.ui)

    def test_promise_lab_is_only_mounted_under_shorts_quant(self):
        self.assertIn("/api/shortsquant/promise-lab/", self.server)
        self.assertNotIn("/api/longquant/promise-lab/", self.server)
        self.assertNotIn("promise-lab/opening-20s", self.server)
        self.assertNotIn("createShortsPromiseLab", self.longquant)


if __name__ == "__main__":
    unittest.main()
