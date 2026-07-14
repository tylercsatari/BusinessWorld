import gzip
import json
import re
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
UI_SOURCE = HERE.parent / "promise-lab-ui.js"
LONGQUANT_SOURCE = HERE.parent / "jarvis-longquant.js"
SERVER_SOURCE = HERE.parents[2] / "server.js"


def load_json(name):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


def load_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


class ProductVisualizationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.predictions = load_json("opening-predictions.json")
        cls.opening = load_json("opening-20s.json")
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
                "openingPredictions", "opening20s", "manualProjection",
                "canonicalPartitions", "hookScore",
            },
        )

    def test_one_renderer_serves_typed_and_saved_analyses(self):
        self.assertIn("function renderAnalysis(analysis, lattice)", self.ui)
        self.assertIn("renderAnalysis(result, result.componentLattice)", self.ui)
        self.assertIn("renderAnalysis(state.selectedPrediction, state.selectedLattice)", self.ui)
        self.assertEqual(self.ui.count("function renderAnalysis("), 1)
        self.assertIn("['scorer', 'Score opening']", self.ui)
        self.assertIn("['library', 'Opening library']", self.ui)
        self.assertIn("['saved', 'Saved embedding']", self.ui)

    def test_complete_evidence_surfaces_are_inside_shared_renderer(self):
        for function in (
            "temporalAttributionPanel", "componentEmbeddingPanel",
            "componentMeasurementPanel", "componentRawEvidencePanel",
            "componentLedgerTable", "relationshipPanel", "latticeInspector",
            "validationPanel", "dataCoveragePanel",
        ):
            self.assertIn(f"function {function}(", self.ui)
            self.assertGreaterEqual(self.ui.count(f"{function}("), 2)
        for phrase in (
            "Where every predicted drop comes from",
            "Selected component inside the saved four-cluster embedding",
            "Component evidence and response timing",
            "every phrase and value exposed",
            "Multi-resolution component lattice and edge graph",
            "Analysis data ledger",
        ):
            self.assertIn(phrase, self.ui)

    def test_every_emitted_canvas_has_a_draw_handler(self):
        emitted = set(re.findall(r'data-pl-canvas="([^"]+)"', self.ui))
        handled = set(re.findall(r"kind === '([^']+)'", self.ui))
        self.assertTrue(emitted)
        self.assertEqual(emitted - handled, set())
        self.assertTrue({
            "retention", "attribution", "component-map", "component-response",
            "contributions", "relationships", "lattice", "validation", "saved-map",
        }.issubset(emitted))

    def test_saved_details_emit_complete_shared_attribution_contract(self):
        self.assertEqual(len(self.predictions["rows"]), self.predictions["sources"])
        for summary in self.predictions["rows"]:
            detail = load_gzip(
                CACHE / "opening-predictions" / f"{summary['videoId']}.json.gz"
            )
            self.assertEqual(
                len(detail["temporalAttribution"]["steps"]),
                len(detail["curves"]["entryIndexed"]["timesSeconds"]) - 1,
            )
            ledger = detail["temporalAttribution"]["componentLedger"]
            self.assertEqual(len(ledger), detail["componentCount"])
            self.assertAlmostEqual(
                sum(row["predictedDeltaPoints"] for row in ledger)
                + detail["temporalAttribution"]["summary"]["unassignedTimeModelDeltaPoints"],
                detail["temporalAttribution"]["summary"]["totalPredictedDeltaPoints"],
                places=5,
            )
            for component in detail["components"]:
                self.assertEqual(len(component["categoryDistribution"]), 4)
                self.assertEqual(len(component["categoryCoordinates4D"]), 4)
                self.assertIsNotNone(component["mapX"])
                self.assertIsNotNone(component["mapY"])
                self.assertIn("timelineAttribution", component)
                self.assertEqual(
                    component["timelineAttribution"],
                    ledger[component["index"]],
                )

    def test_library_summary_exposes_exact_components_before_detail_load(self):
        for summary in self.predictions["rows"]:
            self.assertEqual(len(summary["components"]), summary["componentCount"])
            self.assertTrue(all(row["text"] for row in summary["components"]))
            self.assertTrue(all(row["category"] in {0, 1, 2, 3}
                                for row in summary["components"]))
        self.assertIn("exact components and clusters", self.ui)
        self.assertIn("componentLedgerTable(analysis)", self.ui)

    def test_saved_embedding_is_the_same_category_map_used_by_components(self):
        self.assertTrue(self.projection["saved"])
        self.assertEqual(self.projection["mapId"], self.partitions["mapId"])
        labels = self.projection["frozenPointIndex"]["labels"]
        self.assertEqual(len(labels), self.projection["reconstruction"]["rows"])
        self.assertLess(len(labels), self.opening["spanCount"])
        self.assertEqual(set(labels), {0, 1, 2, 3})
        self.assertIn("projectedComponentPoint(component, method)", self.ui)
        self.assertIn("basis4x2", self.ui)

    def test_lattice_visualization_exposes_every_edge_family(self):
        first = self.opening["rows"][0]["videoId"]
        detail = load_gzip(CACHE / "opening-20s" / f"{first}.json.gz")
        self.assertEqual(sum(detail["edgeCounts"].values()), len(detail["edges"]))
        self.assertEqual(set(detail["edgeCounts"]), {
            "containment", "sequence", "semantic", "context",
        })
        self.assertIn("data-pl-lattice-edge", self.ui)
        self.assertIn("edge.type !== state.latticeEdgeType", self.ui)

    def test_promise_lab_is_only_mounted_under_shorts_quant(self):
        self.assertIn("/api/shortsquant/promise-lab/", self.server)
        self.assertNotIn("/api/longquant/promise-lab/", self.server)
        self.assertNotIn("createShortsPromiseLab", self.longquant)


if __name__ == "__main__":
    unittest.main()
