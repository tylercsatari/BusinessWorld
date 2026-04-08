#!/usr/bin/env python3
"""Build indicator-registry.json from results.tsv discovery rows."""

import csv
import json
import re
import os
from datetime import datetime, timezone

DIR = os.path.dirname(os.path.abspath(__file__))
TSV_PATH = os.path.join(DIR, "results.tsv")
OUT_PATH = os.path.join(DIR, "indicator-registry.json")

# ── Layer classification ──
PRE_PATTERNS = re.compile(
    r"word|phrase|language|script|text|title|concept|idea|hook|novelty|cognitive"
    r"|zeigarnik|vz_|z_score|z_type|pat_|indestructible|making|face|visual_surprise"
    r"|cut_|pivot|connector|action_word|bigram|starts_with_i|thumbnail|content_type"
    r"|hook_clarity|text_overlay|net_novelty|idea_length|superhero|challenge"
    r"|narrative_arc|has_callback|three_channel|action_intensity|total_word"
    r"|speech_rate|pacing|duration_sweet",
    re.IGNORECASE,
)


def classify_layer(key):
    if key in ("views", "log_views"):
        return "views"
    if PRE_PATTERNS.search(key):
        return "pre"
    return "post"


# ── Resolution classification ──
R3_PAT = re.compile(r"frame|word|bigram|phrase|rc_\d", re.I)
R2_PAT = re.compile(
    r"10s|3s|5s|20pct|75pct|50pct|retention_at_|pct|mid|early_drop|slope_3_10",
    re.I,
)
R1_PAT = re.compile(
    r"hook|mid|end|body|75|baseline|above_baseline|peak|cliff", re.I
)


def classify_resolution(key):
    if R3_PAT.search(key):
        return "R3"
    if R2_PAT.search(key):
        return "R2"
    if R1_PAT.search(key):
        return "R1"
    return "R0"


# ── Depth bootstrap ──
COMPLEX_PAT = re.compile(r"_x_|ratio|composite|combined|optimal_|triple|double", re.I)


def estimate_depth(key):
    if COMPLEX_PAT.search(key):
        tokens = key.split("_")
        return max(len(tokens) - 1, 2)
    return 1


# ── Parse r values from notes ──
R_PARTIAL_RE = re.compile(r"r_partial\s*=\s*([+-]?\d+\.?\d*)", re.I)
R_DIRECT_RE = re.compile(r"\br\s*=\s*([+-]?\d+\.?\d*)", re.I)


def parse_r_values(notes):
    r_partial = None
    r_direct = None
    target = "views"

    m = R_PARTIAL_RE.search(notes)
    if m:
        r_partial = float(m.group(1))

    m = R_DIRECT_RE.search(notes)
    if m:
        r_direct = float(m.group(1))

    if "vs keep" in notes.lower():
        target = "keep"
    elif "vs retention" in notes.lower():
        target = "retention"

    return r_partial, r_direct, target


def make_label(key):
    """Convert underscore_key to Title Case label."""
    return key.replace("_", " ").title()


def main():
    # Read all rows
    rows = []
    with open(TSV_PATH, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            rows.append(row)

    # Extract unique discovery indicators from loop_b rows
    by_key = {}
    for row in rows:
        exp_id = (row.get("experiment_id") or "").strip()
        new_signal = (row.get("new_signal") or "").strip()
        if not exp_id.startswith("loop_b"):
            continue
        if not new_signal.startswith("discovery:"):
            continue

        key = new_signal.replace("discovery:", "").strip()
        if not key:
            continue

        notes = (row.get("notes") or "").strip()

        # Keep entry with longest notes for dedup
        if key not in by_key or len(notes) > len(by_key[key]["notes"]):
            r_partial, r_direct, target = parse_r_values(notes)
            by_key[key] = {
                "key": key,
                "notes": notes,
                "r_partial": r_partial,
                "r_direct": r_direct,
                "target": target,
                "exp_id": exp_id,
            }

    # Build connections: for each indicator, find ALL rows where key appears
    # in new_signal field (with or without discovery: prefix)
    for key, entry in by_key.items():
        connections = []
        for row in rows:
            new_signal = (row.get("new_signal") or "").strip()
            signal_key = new_signal.replace("discovery:", "").strip()
            if signal_key == key:
                conn = {
                    "experiment": (row.get("experiment_id") or "").strip(),
                    "status": (row.get("status") or "").strip(),
                    "delta_r2": (row.get("delta_r2") or "").strip(),
                }
                connections.append(conn)
        entry["connections"] = connections

    # Build final indicators list
    indicators = []
    for key, entry in by_key.items():
        layer = classify_layer(key)
        if layer == "views":
            continue  # skip views itself

        resolution = classify_resolution(key)
        depth = estimate_depth(key)

        indicators.append({
            "key": key,
            "label": make_label(key),
            "layer": layer,
            "resolution": resolution,
            "depth": depth,
            "r_partial": entry["r_partial"],
            "r_direct": entry["r_direct"],
            "target": entry["target"],
            "notes": entry["notes"],
            "connections": entry["connections"],
        })

    # Sort by |r_partial| descending
    indicators.sort(key=lambda x: abs(x["r_partial"] or 0), reverse=True)

    registry = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "total": len(indicators),
        "indicators": indicators,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)

    # Print summary
    pre_count = sum(1 for i in indicators if i["layer"] == "pre")
    post_count = sum(1 for i in indicators if i["layer"] == "post")
    res_counts = {}
    for i in indicators:
        res_counts[i["resolution"]] = res_counts.get(i["resolution"], 0) + 1

    print(f"Indicator Registry Built")
    print(f"  Total: {len(indicators)}")
    print(f"  Pre-upload: {pre_count}")
    print(f"  Post-upload: {post_count}")
    print(f"  Resolution breakdown:")
    for r in sorted(res_counts.keys()):
        print(f"    {r}: {res_counts[r]}")
    print(f"  Output: {OUT_PATH}")


if __name__ == "__main__":
    main()
