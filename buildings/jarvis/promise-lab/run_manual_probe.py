#!/usr/bin/env python3
"""Find the frozen Promise Lab map/cluster closest to a manual interpretation."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from embedding_store import R2_PREFIX, R2Store, json_ready
from manual_probe import align_phrases, describe_winner, score_frozen_maps


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
CONFIG = HERE / "manual-reference-probe.json"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    parser.add_argument("--bootstrap-repeats", type=int, default=256)
    args = parser.parse_args()
    started = time.time()
    config = read_json(CONFIG)
    corpus = read_json(CACHE / "corpus.json")
    all_span_atlas = read_json(CACHE / "all-span-atlas.json")
    candidate_atlas = read_json(CACHE / "atlas.json")
    atlases = {
        "all-contiguous-spans": all_span_atlas,
        "boundary-supported-candidates": candidate_atlas,
    }
    matches = align_phrases(
        config["phrases"], corpus["rows"], all_span_atlas["spans"],
        candidate_atlas["candidates"], config.get("matchOverrides"),
    )
    scored = score_frozen_maps(atlases, matches, args.bootstrap_repeats)
    detail = describe_winner(scored, atlases, matches)
    output = {
        "version": 1,
        "status": "complete",
        "probeId": config["id"],
        "name": config["name"],
        "description": config["description"],
        "builtAt": int(time.time() * 1000),
        "elapsedSeconds": time.time() - started,
        "policy": config["policy"],
        "method": {
            "matching": (
                "Corpus-order-constrained surface alignment with only the recorded "
                "transcription repairs; every result resolves to an observed contiguous span."
            ),
            "selection": (
                "The existing map/cluster pair with the largest equal-hook-weighted KL "
                "information contribution, multiplied by scope coverage. No map is refit."
            ),
            "inference": (
                "Descriptive post-hoc overfit only. Unlabeled spans define cluster base rates; "
                "they are not treated as verified negatives."
            ),
        },
        "counts": {
            "manualPhrases": len(matches),
            "manualHooks": len({row["videoId"] for row in matches}),
            "allSpanMatches": sum(row.get("allSpanIndex") is not None for row in matches),
            "candidateMatches": sum(row.get("candidateIndex") is not None for row in matches),
            "frozenMapsCompared": sum(len(atlas.get("maps") or []) for atlas in atlases.values()),
            "newMapsCreated": 0,
        },
        "alignment": {
            "meanMatchScore": sum(row["matchScore"] for row in matches) / len(matches),
            "minimumMatchScore": min(row["matchScore"] for row in matches),
            "overrideCount": sum(row.get("overrideReason") is not None for row in matches),
            "matches": matches,
        },
        "winner": scored["winner"],
        "winnerDetail": detail,
        "rankings": scored["rankings"],
    }
    CACHE.mkdir(parents=True, exist_ok=True)
    output_path = CACHE / "manual-probe.json"
    output_path.write_text(
        json.dumps(json_ready(output), separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    if not args.no_upload:
        R2Store().put_json(
            f"{R2_PREFIX}/manual-probe.json.gz", output, gzip_payload=True
        )
    print(json.dumps({
        "status": output["status"],
        "counts": output["counts"],
        "meanMatchScore": output["alignment"]["meanMatchScore"],
        "winner": output["winner"],
        "output": str(output_path),
    }, indent=2))


if __name__ == "__main__":
    main()
