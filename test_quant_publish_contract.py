from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent


class QuantPublishContractTest(unittest.TestCase):
    def test_unsteered_maps_are_never_written_to_live_keys(self):
        shorts = (ROOT / "raw_embed.py").read_text()
        longform = (ROOT / "raw_embed_long.py").read_text()

        self.assertIn("raw/{c}/map.pending.json", shorts)
        self.assertNotIn("r2_put(f'raw/{c}/map.json'", shorts)
        self.assertIn("raw-long/{c}/map.pending.json", longform)
        self.assertNotIn("r2_put(f'raw-long/{c}/map.json'", longform)

    def test_enrichment_validates_pending_maps_before_live_publish(self):
        cases = [
            ("add_steered_proj.py", "raw/{ch}"),
            ("add_steered_proj_long.py", "raw-long/{ch}"),
        ]
        for filename, prefix in cases:
            source = (ROOT / filename).read_text()
            pending = f"{prefix}/map.pending.json"
            live = f"{prefix}/map.json"
            self.assertIn(pending, source)
            self.assertIn(live, source)
            self.assertLess(
                source.index(f"map_key = f'{pending}'"),
                source.index(f"r2_put(f'{live}'"),
            )
            self.assertIn("build_plot_artifact(mp, ch,", source)
            self.assertIn("refusing to replace the last complete map", source)

    def test_supervisor_publishes_the_staged_bundle(self):
        source = (ROOT / "embed-accounts-supervisor.sh").read_text()
        self.assertIn("RAW_STEER_USE_PENDING=1 python3 add_steered_proj.py", source)


if __name__ == "__main__":
    unittest.main()
