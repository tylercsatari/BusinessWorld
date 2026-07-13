#!/usr/bin/env python3
"""Run every Promise Lab stage in dependency order with resumable artifacts."""

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
        "all-span-atlas", "cross-scope", "swaps", "verify-swaps", "axes",
        "verify-axes", "manual-probe", "manual-projection",
        "verify-manual-projection", "cluster-outcomes",
        "verify-cluster-outcomes", "latency-study", "verify-latency-study",
        "canonical-partitions", "verify-canonical-partitions", "hook-quality",
        "verify-hook-quality", "forward-response", "verify-forward-response",
        "hook-outcomes", "verify-hook-outcomes", "market-reward",
        "verify-market-reward", "hook-examples", "verify-hook-examples",
        "verify-methodology", "ui",
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
        ("cross-scope", "run_cross_scope.py"),
        ("swaps", "run_swaps.py"),
        ("verify-swaps", "verify_swap_outputs.py"),
        ("axes", "run_axes.py"),
        ("verify-axes", "verify_axis_outputs.py"),
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
        ("hook-outcomes", "run_hook_outcomes.py"),
        ("verify-hook-outcomes", "verify_hook_outcomes.py"),
        ("market-reward", "run_market_reward.py"),
        ("verify-market-reward", "verify_market_reward.py"),
        ("hook-examples", "run_hook_examples.py"),
        ("verify-hook-examples", "verify_hook_examples.py"),
        ("verify-methodology", "verify_methodology_contract.py"),
        ("ui", "build_ui.py"),
    ]
    start = next(index for index, item in enumerate(order) if item[0] == args.from_stage)
    for stage, script in order[start:]:
        supports_no_upload = stage not in {
            "verify-all-spans", "verify-swaps", "verify-axes",
            "verify-manual-projection", "verify-cluster-outcomes",
            "verify-latency-study", "verify-canonical-partitions",
            "verify-hook-quality", "verify-forward-response",
            "verify-hook-outcomes", "verify-market-reward",
            "verify-hook-examples", "verify-methodology", "ui",
        }
        extra = ["--no-upload"] if args.no_upload and supports_no_upload else []
        if args.no_upload and stage == "ui":
            print("Skipping build_ui.py because it intentionally publishes browser artifacts.", flush=True)
            continue
        run(script, extra)


if __name__ == "__main__":
    main()
