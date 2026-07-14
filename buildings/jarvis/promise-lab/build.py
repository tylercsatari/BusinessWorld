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
        "verify-manual-projection", "cluster-outcomes",
        "verify-cluster-outcomes", "latency-study", "verify-latency-study",
        "canonical-partitions", "verify-canonical-partitions", "hook-quality",
        "verify-hook-quality", "forward-response", "verify-forward-response",
        "long-title-prior", "hook-outcomes", "verify-hook-outcomes", "market-reward",
        "verify-market-reward", "hook-examples", "verify-hook-examples",
        "verify-product-scorer", "component-lattice", "verify-component-lattice", "opening-20s",
        "verify-opening-20s", "ui",
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
        ("cluster-outcomes", "run_cluster_outcomes.py"),
        ("verify-cluster-outcomes", "verify_cluster_outcomes.py"),
        ("latency-study", "run_latency_study.py"),
        ("verify-latency-study", "verify_latency_study.py"),
        ("canonical-partitions", "run_canonical_partitions.py"),
        ("verify-canonical-partitions", "verify_canonical_partitions.py"),
        ("hook-quality", "run_hook_quality.py"),
        ("verify-hook-quality", "verify_hook_quality.py"),
        ("forward-response", "run_forward_response.py"),
        ("verify-forward-response", "verify_forward_response.py"),
        ("long-title-prior", "run_long_title_prior.py"),
        ("hook-outcomes", "run_hook_outcomes.py"),
        ("verify-hook-outcomes", "verify_hook_outcomes.py"),
        ("market-reward", "run_market_reward.py"),
        ("verify-market-reward", "verify_market_reward.py"),
        ("hook-examples", "run_hook_examples.py"),
        ("verify-hook-examples", "verify_hook_examples.py"),
        ("verify-product-scorer", "verify_product_scorer.py"),
        ("component-lattice", "run_component_lattice.py"),
        ("verify-component-lattice", "verify_component_lattice.py"),
        ("opening-20s", "run_opening_horizon.py"),
        ("verify-opening-20s", "verify_opening_horizon.py"),
        ("ui", "build_ui.py"),
    ]
    start = next(index for index, item in enumerate(order) if item[0] == args.from_stage)
    for stage, script in order[start:]:
        supports_no_upload = stage not in {
            "verify-all-spans",
            "verify-manual-projection", "verify-cluster-outcomes",
            "verify-latency-study", "verify-canonical-partitions",
            "verify-hook-quality", "verify-forward-response",
            "verify-hook-outcomes", "verify-market-reward",
            "verify-hook-examples", "verify-product-scorer", "verify-component-lattice",
            "verify-opening-20s",
        }
        extra = ["--no-upload"] if args.no_upload and supports_no_upload else []
        run(script, extra)


if __name__ == "__main__":
    main()
