#!/usr/bin/env python3
"""Test candidate content as a deviation from the creator's prior content."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

from nested_outcome_validation import (
    CHANNELS,
    MANIFEST_PATH,
    PANEL_PATH,
    SEMANTIC_FAMILY_PATH,
    adjusted_pvalues,
    later_video_validation,
    load_embeddings,
    load_panel,
    unseen_creator_validation,
)


HERE = Path(__file__).resolve().parent
OUTPUT_PATH = HERE / "within-creator-delta-validation.json"


def rounded(value: float | None, digits: int = 6) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def creator_delta_vectors(
    rows: list[dict[str, Any]],
    ids: np.ndarray,
    vectors: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    vector_index = {video_id: index for index, video_id in enumerate(ids)}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["sourceId"]].append(row)
    output_ids = []
    output_vectors = []
    history_counts = []
    for source_rows in grouped.values():
        source_rows.sort(
            key=lambda row: (row["publishedSeconds"], row["videoId"])
        )
        history: list[dict[str, Any]] = []
        for row in source_rows:
            target_index = vector_index.get(row["videoId"])
            if target_index is not None:
                eligible = [
                    previous
                    for previous in history
                    if (
                        previous["observationSeconds"] <= row["publishedSeconds"]
                        and previous["contentFamilyId"] != row["contentFamilyId"]
                    )
                ]
                if eligible:
                    baseline = np.mean(
                        vectors[
                            np.asarray(
                                [previous["vectorIndex"] for previous in eligible],
                                dtype=np.int64,
                            )
                        ],
                        axis=0,
                    )
                    delta = vectors[target_index] - baseline
                    norm = float(np.linalg.norm(delta))
                    if np.isfinite(norm) and norm > 1e-12:
                        output_ids.append(row["videoId"])
                        output_vectors.append(delta / norm)
                        history_counts.append(len(eligible))
                history.append({**row, "vectorIndex": target_index})
    selected_id_set = set(output_ids)
    return (
        np.asarray(output_ids, dtype=str),
        np.asarray(output_vectors, dtype=np.float32),
        {
            "rows": len(output_ids),
            "sources": len({
                row["sourceId"]
                for row in rows
                if row["videoId"] in selected_id_set
            }),
            "historyCount": {
                "minimum": int(np.min(history_counts)) if history_counts else None,
                "median": rounded(float(np.median(history_counts))) if history_counts else None,
                "p90": rounded(float(np.quantile(history_counts, 0.9))) if history_counts else None,
                "maximum": int(np.max(history_counts)) if history_counts else None,
            },
        },
    )


def subset_absolute(
    ids: np.ndarray,
    vectors: np.ndarray,
    selected_ids: np.ndarray,
) -> np.ndarray:
    vector_index = {video_id: index for index, video_id in enumerate(ids)}
    return vectors[
        np.asarray([vector_index[video_id] for video_id in selected_ids], dtype=np.int64)
    ]


def comparison(
    absolute: dict[str, Any],
    delta: dict[str, Any],
) -> dict[str, float | None]:
    return {
        "absoluteR2": absolute["r2"],
        "creatorDeltaR2": delta["r2"],
        "r2DifferenceDeltaMinusAbsolute": rounded(delta["r2"] - absolute["r2"]),
        "absoluteSpearman": absolute["spearman"],
        "creatorDeltaSpearman": delta["spearman"],
        "spearmanDifferenceDeltaMinusAbsolute": rounded(
            delta["spearman"] - absolute["spearman"]
        ),
        "absoluteGaussianBitsPerObservation":
            absolute["gaussianBitsPerObservation"],
        "creatorDeltaGaussianBitsPerObservation":
            delta["gaussianBitsPerObservation"],
        "gaussianBitsDifferenceDeltaMinusAbsolute": rounded(
            delta["gaussianBitsPerObservation"]
            - absolute["gaussianBitsPerObservation"]
        ),
        "absoluteMaeLog10Lift": absolute["maeLog10Lift"],
        "creatorDeltaMaeLog10Lift": delta["maeLog10Lift"],
        "maeDifferenceDeltaMinusAbsolute": rounded(
            delta["maeLog10Lift"] - absolute["maeLog10Lift"]
        ),
        "creatorDeltaPairwiseMicroAccuracy":
            delta["withinSourcePairwise"]["microAccuracy"],
        "creatorDeltaPairwiseEqualSourceAccuracy":
            delta["withinSourcePairwise"]["equalSourceMeanAccuracy"],
        "absoluteSourceMacroMeanSpearman": absolute["sourceMacro"]["meanSpearman"],
        "creatorDeltaSourceMacroMeanSpearman": delta["sourceMacro"]["meanSpearman"],
        "absoluteSourceMacroPositiveFraction": absolute["sourceMacro"]["positiveFraction"],
        "creatorDeltaSourceMacroPositiveFraction": delta["sourceMacro"]["positiveFraction"],
    }


def apply_multiplicity(channels: list[dict[str, Any]]) -> dict[str, Any]:
    hypotheses = []
    for channel in channels:
        for split_key in ("unseenCreator", "laterVideo"):
            hypotheses.append({
                "channel": channel,
                "splitKey": split_key,
                "p": channel["creatorDelta"][split_key]["withinSourcePermutation"][
                    "spearmanOneSidedP"
                ],
            })
    corrections = adjusted_pvalues([row["p"] for row in hypotheses])
    for hypothesis, correction in zip(hypotheses, corrections):
        hypothesis["channel"]["creatorDelta"][hypothesis["splitKey"]][
            "multiplicity"
        ] = {
            "family": "all creator-delta channels across both validation splits",
            "hypotheses": len(hypotheses),
            **correction,
        }
    return {
        "hypotheses": len(hypotheses),
        "passingHolm05": [
            f"{row['channel']['id']}:{row['splitKey']}"
            for row, correction in zip(hypotheses, corrections)
            if correction["holmP"] is not None and correction["holmP"] <= 0.05
        ],
        "passingFdr05": [
            f"{row['channel']['id']}:{row['splitKey']}"
            for row, correction in zip(hypotheses, corrections)
            if correction["benjaminiHochbergQ"] is not None
            and correction["benjaminiHochbergQ"] <= 0.05
        ],
    }


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text())
    manifest_objects = {item["role"]: item for item in manifest["objects"]}
    formats = load_panel()
    channels = []
    for format_name, modality in CHANNELS:
        print(f"creator-delta {format_name}:{modality}", flush=True)
        ids, vectors = load_embeddings(format_name, modality)
        delta_ids, delta_vectors, support = creator_delta_vectors(
            formats[format_name],
            ids,
            vectors,
        )
        absolute_vectors = subset_absolute(ids, vectors, delta_ids)
        absolute = {
            "unseenCreator": unseen_creator_validation(
                formats[format_name],
                delta_ids,
                absolute_vectors,
            ),
            "laterVideo": later_video_validation(
                formats[format_name],
                delta_ids,
                absolute_vectors,
            ),
        }
        delta = {
            "unseenCreator": unseen_creator_validation(
                formats[format_name],
                delta_ids,
                delta_vectors,
            ),
            "laterVideo": later_video_validation(
                formats[format_name],
                delta_ids,
                delta_vectors,
            ),
        }
        channels.append({
            "id": f"{format_name}:{modality}",
            "format": format_name,
            "modality": modality,
            "vectorHash": manifest_objects[
                f"{format_name}:{modality}:vectors"
            ]["sha256"],
            "support": support,
            "absoluteHistoryMatched": absolute,
            "creatorDelta": delta,
            "incremental": {
                "unseenCreator": comparison(
                    absolute["unseenCreator"],
                    delta["unseenCreator"],
                ),
                "laterVideo": comparison(
                    absolute["laterVideo"],
                    delta["laterVideo"],
                ),
            },
        })
        del vectors, absolute_vectors, delta_vectors

    output = {
        "schema": "within-creator-content-delta-validation-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "feature": "unit-normalized candidate embedding minus the mean embedding of same-creator, non-duplicate outcomes observed before candidate publication",
        "sourceLineage": {
            "snapshotRunId": manifest["runId"],
            "snapshotIdentityHash": manifest["identityHash"],
            "panelArtifactSha256": hashlib.sha256(PANEL_PATH.read_bytes()).hexdigest(),
            "semanticFamilyArtifactSha256": hashlib.sha256(
                SEMANTIC_FAMILY_PATH.read_bytes()
            ).hexdigest(),
        },
        "channels": channels,
        "multiplicity": apply_multiplicity(channels),
        "claimBoundary": [
            "Creator-delta features use only content representations and historically observable prior videos.",
            "Absolute and creator-delta models are compared on exactly the same rows.",
            "The creator baseline is an unweighted mean; recency weighting is not selected from evaluation outcomes.",
            "Positive pooled discrimination is insufficient unless source-macro ordering and later-video performance also improve.",
            "Long remains underpowered because very few historically observable targets overlap the current vector archives.",
        ],
    }
    serialized = json.dumps(output, sort_keys=True, separators=(",", ":")).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({
        "output": str(OUTPUT_PATH),
        "multiplicity": output["multiplicity"],
        "channels": [
            {
                "id": channel["id"],
                "rows": channel["support"]["rows"],
                "unseen": channel["incremental"]["unseenCreator"],
                "later": channel["incremental"]["laterVideo"],
            }
            for channel in channels
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
