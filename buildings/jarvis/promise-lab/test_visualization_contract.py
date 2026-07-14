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


def load_json(name):
    return json.loads((CACHE / name).read_text(encoding="utf-8"))


class ProductVisualizationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.partitions = load_json("canonical-partitions.json")
        cls.outcomes = load_json("hook-outcomes.json")
        cls.market = load_json("market-reward.json")
        cls.lattice = load_json("component-lattice.json")
        cls.opening = load_json("opening-20s.json")
        cls.projection = load_json("manual-projection.json")
        cls.manifest = load_json("manifest.json")
        cls.ui = UI_SOURCE.read_text(encoding="utf-8")
        cls.longquant = LONGQUANT_SOURCE.read_text(encoding="utf-8")
        cls.server = SERVER_SOURCE.read_text(encoding="utf-8")

    def test_product_manifest_contains_only_current_surfaces(self):
        self.assertEqual(self.manifest["status"], "complete")
        self.assertEqual(self.manifest["errors"], [])
        self.assertEqual(
            [row["id"] for row in self.manifest["surfaces"]],
            ["scorer", "library", "saved", "opening20s"],
        )
        self.assertEqual(
            set(self.manifest["artifacts"]),
            {
                "componentLattice", "opening20s", "manualProbe",
                "manualProjection", "clusterOutcomes", "latencyStudy",
                "canonicalPartitions", "hookQuality", "hookOutcomes",
                "marketReward", "hookExamples", "hookScore",
            },
        )
        self.assertTrue(self.manifest["validation"]["allProductChecksPassed"])
        self.assertEqual(
            self.manifest["scoringContract"]["sharedBy"],
            ["typed hook scorer", "stored hook library"],
        )

    def test_ui_has_four_views_and_no_legacy_navigation(self):
        self.assertIn("['scorer', 'Hook scorer']", self.ui)
        self.assertIn("['library', 'Hook library']", self.ui)
        self.assertIn("['saved', 'Saved embedding']", self.ui)
        self.assertIn("['opening20s', '20s analysis']", self.ui)
        self.assertIn("scorer: renderHookScorer", self.ui)
        self.assertIn("library: renderHookLibrary", self.ui)
        self.assertIn("saved: renderSavedProjection", self.ui)
        self.assertIn("opening20s: renderOpening20s", self.ui)
        for legacy in (
            "renderOverview", "renderHooks", "renderBoundaries",
            "renderComponents", "renderClusters", "renderSwaps", "renderAxes",
            "renderRegistry", "renderResearchContract", "function renderLattice(",
            "Claude RTG", "claudertg",
        ):
            self.assertNotIn(legacy, self.ui + self.longquant)

    def test_scorer_and_library_render_one_explicit_score_contract(self):
        self.assertIn("function sharedScoringContractPanel(surface)", self.ui)
        self.assertIn("sharedScoringContractPanel('scorer')", self.ui)
        self.assertIn("sharedScoringContractPanel('library')", self.ui)
        self.assertIn("data-pl-shared-score-contract", self.ui)
        self.assertIn("score(full) − score(without component)", self.ui)
        self.assertIn(
            "score(full) − score(without A) − score(without B) + score(without A+B)",
            self.ui,
        )
        self.assertNotIn("result.score ||", self.ui)
        self.assertNotIn("result.trainingReward", self.ui)

    def test_every_emitted_canvas_has_a_draw_handler(self):
        emitted = set(re.findall(r'data-pl-canvas="([^"]+)"', self.ui))
        handled = set(re.findall(r"kind === '([^']+)'", self.ui))
        self.assertTrue(emitted)
        self.assertEqual(emitted - handled, set())

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
            expected_cuts = sorted(int(chunk["end"]) for chunk in row["chunks"][:-1])
            self.assertEqual(trace.get("selectedCutTokenOffsets"), expected_cuts)

    def test_hook_forecasts_stop_at_their_measured_hook_endpoint(self):
        for row in self.outcomes["hooks"]:
            forecast = row["retentionForecast"]
            endpoint = float(forecast["responseEndSeconds"])
            self.assertEqual(len(forecast["timesSeconds"]), 41)
            self.assertAlmostEqual(float(forecast["timesSeconds"][-1]), endpoint, places=5)
            self.assertTrue(all(float(word["responseSeconds"]) <= endpoint + 1e-6
                                for word in forecast["words"]))
        self.assertEqual(self.outcomes["audit"]["postHookOutputPoints"], 0)

    def test_lattice_and_20_second_analysis_cover_the_library(self):
        hooks = len(self.outcomes["hooks"])
        expected_spans = sum(
            int(row["tokenCount"]) * (int(row["tokenCount"]) + 1) // 2
            for row in self.lattice["rows"]
        )
        self.assertEqual(self.lattice["hookCount"], hooks)
        self.assertEqual(self.lattice["spanCount"], expected_spans)
        self.assertTrue(self.lattice["parityContract"]["shared"])
        self.assertEqual(self.opening["sourceVideos"], hooks)
        self.assertEqual(
            self.opening["sourceVideosWithNonoverlappingResolvedIntervals"], hooks,
        )
        first = self.lattice["rows"][0]
        with gzip.open(CACHE / "component-lattice" / f"{first['videoId']}.json.gz", "rt") as handle:
            detail = json.load(handle)
        self.assertTrue(detail["partitionContract"]["exactNonoverlappingCover"])
        self.assertFalse(detail["partitionContract"]["selectionUsesOutcomes"])
        self.assertEqual(detail["partitionContract"]["tokenOwnership"],
                         [1] * detail["tokenCount"])

    def test_saved_embedding_is_the_canonical_category_map(self):
        self.assertTrue(self.projection["saved"])
        self.assertEqual(self.projection["mapId"], self.partitions["mapId"])
        labels = self.projection["frozenPointIndex"]["labels"]
        self.assertEqual(len(labels), self.lattice["spanCount"])
        self.assertEqual(set(labels), {0, 1, 2, 3})

    def test_server_exposes_no_deleted_promise_lab_routes(self):
        for route in (
            "findings", "corpus", "discovery", "atlas", "all-span-atlas",
            "research-contract", "forward-response", "cross-scope", "swaps",
            "axes", "registry", "swap-source",
        ):
            self.assertNotIn(f"promise-lab/{route}", self.server)
        self.assertNotIn("claudertg", self.server.lower())


if __name__ == "__main__":
    unittest.main()
