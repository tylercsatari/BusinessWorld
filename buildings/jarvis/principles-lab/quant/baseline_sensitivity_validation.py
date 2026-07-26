#!/usr/bin/env python3
"""Stress-test Shorts content signal across nuisance-baseline specifications.

This does not search for a winning target. Every predeclared age/history
combination is reported, and the content claim is considered stable only when
its sign and useful discrimination survive the full grid.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable

import numpy as np

import nested_outcome_validation as nested
from raw_embedding_validation import adjusted_pvalues


HERE = Path(__file__).resolve().parent
OUTPUT_PATH = HERE / "baseline-sensitivity-validation.json"
AGE_SPECS = ("log_linear", "log_quadratic", "hinge_spline")
HISTORY_SPECS = ("empirical_bayes", "unshrunk_prior_mean")
MODALITIES = ("visual", "together")
MINIMUM_HISTORY_GRID = (1, 2, 5, 10)


def age_feature_function(spec: str) -> Callable[[float], np.ndarray]:
    def features(age_days: float) -> np.ndarray:
        x = np.log1p(max(0.0, float(age_days)))
        if spec == "log_linear":
            values = [1.0, x]
        elif spec == "log_quadratic":
            values = [1.0, x, x * x]
        elif spec == "hinge_spline":
            values = [
                1.0,
                x,
                x * x,
                x * x * x,
                *[
                    max(0.0, x - np.log1p(days))
                    for days in nested.AGE_KNOT_DAYS
                ],
            ]
        else:
            raise ValueError(f"Unknown age specification: {spec}")
        return np.asarray(values, dtype=np.float64)

    return features


def history_function(
    spec: str,
) -> Callable[[list[dict[str, Any]], dict[str, float]], float]:
    def center(
        history: list[dict[str, Any]],
        components: dict[str, float],
    ) -> float:
        if spec == "empirical_bayes":
            precision = (
                (1.0 / components["sourceVariance"])
                + (len(history) / components["residualVariance"])
            )
            return (
                sum(row["residual"] for row in history)
                / components["residualVariance"]
            ) / precision
        if spec == "unshrunk_prior_mean":
            return float(np.mean([row["residual"] for row in history]))
        raise ValueError(f"Unknown history specification: {spec}")

    return center


def compact_metrics(result: dict[str, Any]) -> dict[str, Any]:
    pairwise = result["withinSourcePairwise"]
    source_macro = result["sourceMacro"]
    permutation = result["withinSourcePermutation"]
    return {
        "n": result["n"],
        "r2": result["r2"],
        "spearman": result["spearman"],
        "gaussianBitsPerObservation": result["gaussianBitsPerObservation"],
        "pairwiseMicroAccuracy": pairwise["microAccuracy"],
        "pairwiseEqualSourceAccuracy": pairwise["equalSourceMeanAccuracy"],
        "sourceMacroMeanSpearman": source_macro["meanSpearman"],
        "sourceMacroPositiveFraction": source_macro["positiveFraction"],
        "withinSourcePermutationP": permutation["spearmanOneSidedP"],
    }


def summarize(
    rows: list[dict[str, Any]],
    modality: str,
    split_key: str,
) -> dict[str, Any]:
    values = [
        row["results"][modality][split_key]
        for row in rows
    ]
    return {
        "specifications": len(values),
        "spearmanRange": [
            round(float(min(row["spearman"] for row in values)), 6),
            round(float(max(row["spearman"] for row in values)), 6),
        ],
        "bitsRange": [
            round(float(min(row["gaussianBitsPerObservation"] for row in values)), 6),
            round(float(max(row["gaussianBitsPerObservation"] for row in values)), 6),
        ],
        "pairwiseMicroAccuracyRange": [
            round(float(min(row["pairwiseMicroAccuracy"] for row in values)), 6),
            round(float(max(row["pairwiseMicroAccuracy"] for row in values)), 6),
        ],
        "sourceMacroMeanSpearmanRange": [
            round(float(min(row["sourceMacroMeanSpearman"] for row in values)), 6),
            round(float(max(row["sourceMacroMeanSpearman"] for row in values)), 6),
        ],
        "positiveSpearmanSpecifications": sum(
            row["spearman"] > 0 for row in values
        ),
        "positiveBitsSpecifications": sum(
            row["gaussianBitsPerObservation"] > 0 for row in values
        ),
        "aboveChancePairwiseSpecifications": sum(
            row["pairwiseMicroAccuracy"] > 0.5 for row in values
        ),
    }


def main() -> None:
    panel = nested.load_panel()
    embeddings = {
        modality: nested.load_embeddings("shorts", modality)
        for modality in MODALITIES
    }
    original_age_features = nested.age_features
    original_posterior_effect = nested.posterior_effect
    original_minimum_history = nested.MIN_HISTORY
    specifications = []
    history_support_specifications = []
    try:
        for age_spec in AGE_SPECS:
            for history_spec in HISTORY_SPECS:
                print(
                    f"baseline sensitivity {age_spec}:{history_spec}",
                    flush=True,
                )
                nested.age_features = age_feature_function(age_spec)
                nested.posterior_effect = history_function(history_spec)
                results = {}
                for modality, (ids, vectors) in embeddings.items():
                    results[modality] = {
                        "unseenCreator": compact_metrics(
                            nested.unseen_creator_validation(
                                panel["shorts"],
                                ids,
                                vectors,
                            )
                        ),
                        "laterVideo": compact_metrics(
                            nested.later_video_validation(
                                panel["shorts"],
                                ids,
                                vectors,
                            )
                        ),
                    }
                specifications.append(
                    {
                        "id": f"{age_spec}:{history_spec}",
                        "ageSpecification": age_spec,
                        "historySpecification": history_spec,
                        "results": results,
                    }
                )
        primary = next(
            row
            for row in specifications
            if row["id"] == "hinge_spline:empirical_bayes"
        )
        history_support_specifications.append(
            {
                "minimumHistory": 1,
                "results": primary["results"],
                "reusedPrimarySpecification": True,
            }
        )
        nested.age_features = age_feature_function("hinge_spline")
        nested.posterior_effect = history_function("empirical_bayes")
        for minimum_history in MINIMUM_HISTORY_GRID[1:]:
            print(
                f"history support sensitivity min={minimum_history}",
                flush=True,
            )
            nested.MIN_HISTORY = minimum_history
            results = {}
            for modality, (ids, vectors) in embeddings.items():
                results[modality] = {
                    "unseenCreator": compact_metrics(
                        nested.unseen_creator_validation(
                            panel["shorts"],
                            ids,
                            vectors,
                        )
                    ),
                    "laterVideo": compact_metrics(
                        nested.later_video_validation(
                            panel["shorts"],
                            ids,
                            vectors,
                        )
                    ),
                }
            history_support_specifications.append(
                {
                    "minimumHistory": minimum_history,
                    "results": results,
                    "reusedPrimarySpecification": False,
                }
            )
    finally:
        nested.age_features = original_age_features
        nested.posterior_effect = original_posterior_effect
        nested.MIN_HISTORY = original_minimum_history

    hypotheses = []
    for specification in specifications:
        for modality in MODALITIES:
            for split_key in ("unseenCreator", "laterVideo"):
                hypotheses.append(
                    specification["results"][modality][split_key]
                )
    for specification in history_support_specifications:
        if specification["reusedPrimarySpecification"]:
            continue
        for modality in MODALITIES:
            for split_key in ("unseenCreator", "laterVideo"):
                hypotheses.append(
                    specification["results"][modality][split_key]
                )
    corrections = adjusted_pvalues(
        [row["withinSourcePermutationP"] for row in hypotheses]
    )
    for row, correction in zip(hypotheses, corrections):
        row["multiplicity"] = {
            "family": (
                "all predeclared baseline/history-support-by-modality-by-split "
                "checks"
            ),
            "hypotheses": len(hypotheses),
            **correction,
        }

    manifest = json.loads(nested.MANIFEST_PATH.read_text())
    output = {
        "schema": "shorts-content-baseline-sensitivity-v1",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "estimand": (
            "Creator-relative log-view lift under six predeclared combinations "
            "of age maturity and historically observable creator baselines."
        ),
        "selectionRule": (
            "No specification is selected. Robustness requires the direction "
            "to survive the entire grid."
        ),
        "sourceLineage": {
            "snapshotRunId": manifest["runId"],
            "snapshotIdentityHash": manifest["identityHash"],
            "panelArtifactSha256": hashlib.sha256(
                nested.PANEL_PATH.read_bytes()
            ).hexdigest(),
            "semanticFamilyArtifactSha256": hashlib.sha256(
                nested.SEMANTIC_FAMILY_PATH.read_bytes()
            ).hexdigest(),
        },
        "grid": {
            "ageSpecifications": list(AGE_SPECS),
            "historySpecifications": list(HISTORY_SPECS),
            "modalities": list(MODALITIES),
            "validationSplits": ["unseenCreator", "laterVideo"],
            "minimumHistoryGrid": list(MINIMUM_HISTORY_GRID),
            "hypotheses": len(hypotheses),
        },
        "specifications": specifications,
        "historySupportSpecifications": history_support_specifications,
        "stability": {
            modality: {
                split_key: summarize(
                    specifications,
                    modality,
                    split_key,
                )
                for split_key in ("unseenCreator", "laterVideo")
            }
            for modality in MODALITIES
        },
        "historySupportStability": {
            modality: {
                split_key: summarize(
                    history_support_specifications,
                    modality,
                    split_key,
                )
                for split_key in ("unseenCreator", "laterVideo")
            }
            for modality in MODALITIES
        },
        "claimBoundary": [
            "This is a nuisance-model sensitivity grid, not six independent replications.",
            "The current corpus has one historically timed public view observation per video.",
            "A stable association remains observational until a prospective publishing intervention.",
        ],
    }
    serialized = json.dumps(
        output,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    output["contentHash"] = hashlib.sha256(serialized).hexdigest()
    OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
    print(
        json.dumps(
            {
                "output": str(OUTPUT_PATH),
                "stability": output["stability"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
