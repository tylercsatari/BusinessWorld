#!/usr/bin/env python3
"""Rebuild the current Promise Lab product in dependency order."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def run(script: str, extra: list[str] | None = None) -> None:
    command = [sys.executable, "-u", str(HERE / script), *(extra or [])]
    print("\n==>", " ".join(command), flush=True)
    subprocess.run(command, cwd=HERE, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-stage", choices=(
        "interventions", "discovery", "atlas", "all-spans", "verify-all-spans",
        "all-span-atlas", "manual-probe", "manual-projection",
        "verify-manual-projection", "media-alignment", "audit-media-alignment",
        "verify-media-alignment",
        "canonical-partitions", "verify-canonical-partitions",
        "opening-lattice", "verify-product-scorer", "opening-20s",
        "verify-opening-20s", "opening-predictor", "verify-opening-predictor", "ui",
    ),
                        default="interventions")
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    order = [
        ("interventions", "run_interventions.py"),
        ("discovery", "run_discovery.py"),
        ("atlas", "run_atlas.py"),
        ("all-spans", "run_all_spans.py"),
        ("verify-all-spans", "verify_all_span_store.py"),
        ("all-span-atlas", "run_all_span_atlas.py"),
        ("manual-probe", "run_manual_probe.py"),
        ("manual-projection", "run_manual_projection.py"),
        ("verify-manual-projection", "verify_manual_projection.py"),
        ("media-alignment", "build_media_alignment.py"),
        ("audit-media-alignment", "audit_media_alignment.py"),
        ("verify-media-alignment", "verify_media_alignment.py"),
        ("canonical-partitions", "run_canonical_partitions.py"),
        ("verify-canonical-partitions", "verify_canonical_partitions.py"),
        ("opening-lattice", "build_opening_lattice_model.py"),
        ("opening-20s", "run_opening_horizon.py"),
        ("verify-opening-20s", "verify_opening_horizon.py"),
        ("opening-predictor", "run_variable_opening_predictor.py"),
        ("verify-opening-predictor", "verify_opening_predictor.py"),
        ("verify-product-scorer", "verify_product_scorer.py"),
        ("ui", "build_ui.py"),
    ]
    start = next(index for index, item in enumerate(order) if item[0] == args.from_stage)
    for stage, script in order[start:]:
        supports_no_upload = stage not in {
            "verify-all-spans",
            "verify-manual-projection", "media-alignment", "audit-media-alignment",
            "verify-media-alignment",
            "verify-canonical-partitions", "verify-product-scorer",
            "verify-opening-20s", "verify-opening-predictor",
        }
        extra = ["--no-upload"] if args.no_upload and supports_no_upload else []
        run(script, extra)


if __name__ == "__main__":
    main()
