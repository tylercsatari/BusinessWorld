#!/usr/bin/env python3
"""Adversarial tests for the production visual keep methodology."""

from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "run_predictor_lab",
    HERE / "run_predictor_lab.py",
)
assert SPEC and SPEC.loader
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)


def rows_for_signal(
    rng: np.random.Generator,
) -> tuple[list[dict[str, object]], np.ndarray, np.ndarray, np.ndarray]:
    rows = []
    accounts = []
    for account_index in range(4):
        account = f"account-{account_index}"
        for sequence in range(24):
            rows.append(
                {
                    "id": f"{account}-video-{sequence}",
                    "title": f"signal opening {account_index} {sequence}",
                    "account": account,
                    "accountName": f"Account {account_index}",
                    "publishedAt": float(
                        1_700_000_000_000 + sequence * 86_400_000
                        + account_index
                    ),
                    "contentFamilyId": (
                        f"declared:signal-{account_index}-{sequence}"
                    ),
                }
            )
            accounts.append(account)
    features = LAB.normalized(rng.normal(size=(len(rows), 8)))
    outcomes = np.clip(
        68.0 + 13.0 * features[:, 0] - 8.0 * features[:, 1],
        0,
        100,
    )
    return rows, features, outcomes, np.asarray(accounts)


def rows_for_account_drift(
    rng: np.random.Generator,
) -> tuple[list[dict[str, object]], np.ndarray, np.ndarray, np.ndarray]:
    rows = []
    outcomes = []
    accounts = []
    for account_index in range(4):
        account = f"drift-{account_index}"
        for sequence in range(48):
            rows.append(
                {
                    "id": f"{account}-video-{sequence}",
                    "title": f"drift opening {account_index} {sequence}",
                    "account": account,
                    "accountName": f"Drift {account_index}",
                    "publishedAt": float(
                        1_710_000_000_000 + sequence * 86_400_000
                        + account_index
                    ),
                    "contentFamilyId": (
                        f"declared:drift-{account_index}-{sequence}"
                    ),
                }
            )
            accounts.append(account)
            outcomes.append(35.0 + account_index * 15.0 + sequence * 0.25)
    features = LAB.normalized(rng.normal(size=(len(rows), 8)))
    return (
        rows,
        features,
        np.asarray(outcomes, dtype=float),
        np.asarray(accounts),
    )


def assert_rejected(artifact: dict[str, object], reason: str) -> None:
    status = LAB.visual_keep_artifact_status(artifact)
    assert status["state"] == "stale", reason
    assert status["validationEligible"] is False, reason
    try:
        LAB.require_current_visual_keep_artifact(artifact)
    except RuntimeError:
        pass
    else:
        raise AssertionError(reason)


def main() -> None:
    rng = np.random.default_rng(20260730)
    rows, features, outcomes, accounts = rows_for_signal(rng)
    protocol, formula = LAB.run_visual_keep_video_holdout(
        rows,
        features,
        outcomes,
        accounts,
        LAB.visual_keep_pooled_candidate_registry(),
    )
    assert protocol["exactFormulaReplayVerified"] is True
    LAB.assert_visual_keep_protocol_formula_parity(
        rows,
        features,
        protocol,
    )
    for fold in protocol["folds"]:
        assert fold["selected"]["estimatorId"] == (
            LAB.VISUAL_KEEP_POOLED_ESTIMATOR_ID
        )
        assert fold["selected"]["accountWeight"] == 0
        replayed = [
            point
            for point in protocol["points"]
            if point["fold"] == fold["foldKey"]
        ]
        assert replayed
    try:
        LAB.validate_visual_keep_candidate({
            "estimatorId": LAB.VISUAL_KEEP_POOLED_ESTIMATOR_ID,
            "pooledAlpha": 100.0,
            "accountWeight": 0.0,
        })
    except ValueError:
        pass
    else:
        raise AssertionError(
            "validation accepted an alpha absent from production"
        )

    evidence = {
        "producerSourceSha256": LAB.current_predictor_source_sha256(),
        "formula": formula,
        "protocols": {
            "videoHoldout": protocol,
            "forwardTime": copy.deepcopy(protocol),
            "accountHoldout": copy.deepcopy(protocol),
        },
    }
    assert LAB.visual_keep_artifact_status(evidence)["current"] is True

    stale_source = copy.deepcopy(evidence)
    stale_source["producerSourceSha256"] = "0" * 64
    assert_rejected(
        stale_source,
        "an artifact from different predictor source was accepted",
    )
    with tempfile.TemporaryDirectory() as directory:
        artifact_path = Path(directory) / "stale.json"
        artifact_path.write_text(
            json.dumps(stale_source),
            encoding="utf-8",
        )
        loaded = LAB.load_current_visual_keep_artifact(artifact_path)
        assert loaded["status"]["state"] == "stale"
        assert loaded["artifact"] is None

    creator_blend_formula = copy.deepcopy(evidence)
    creator_blend_formula["formula"]["selected"]["accountWeight"] = 0.75
    assert_rejected(
        creator_blend_formula,
        "creator-blended serving formula was accepted as pooled evidence",
    )
    try:
        LAB.score_visual_keep_formula(
            features[0],
            creator_blend_formula["formula"],
        )
    except ValueError:
        pass
    else:
        raise AssertionError("serving formula accepted creator-specific blending")

    creator_blend_fold = copy.deepcopy(evidence)
    creator_blend_fold["protocols"]["videoHoldout"]["folds"][0]["selected"][
        "accountWeight"
    ] = 0.75
    assert_rejected(
        creator_blend_fold,
        "creator-blended evidence was accepted as pooled production evidence",
    )

    tampered_protocol = copy.deepcopy(protocol)
    tampered_protocol["points"][0]["predicted"] += 0.01
    try:
        LAB.assert_visual_keep_protocol_formula_parity(
            rows,
            features,
            tampered_protocol,
        )
    except RuntimeError:
        pass
    else:
        raise AssertionError("tampered OOF evidence passed exact formula replay")

    drift_rows, drift_features, drift_outcomes, drift_accounts = (
        rows_for_account_drift(rng)
    )
    forward = LAB.run_visual_keep_forward_time(
        drift_rows,
        drift_features,
        drift_outcomes,
        drift_accounts,
        LAB.visual_keep_pooled_candidate_registry(),
    )
    mean_diagnostic = forward["diagnostics"]["trailingAccountMean"]
    assert mean_diagnostic["promotionEligible"] is False
    assert mean_diagnostic["beatsProductionByRmse"] is True
    assert mean_diagnostic["metrics"]["rmse"] < forward["metrics"]["rmse"]
    assert forward["metrics"]["protocolBaselineR2"] <= 0

    otherwise_positive = copy.deepcopy(forward)
    otherwise_positive["metrics"]["protocolBaselineR2"] = 0.5
    assert LAB.visual_keep_promotion_decision(
        forward,
        otherwise_positive,
    ) is False, (
        "a winning trailing mean promoted the pooled visual Ridge despite "
        "negative same-class forward evidence"
    )
    study_rows = [
        {
            **row,
            "keep": float(outcome),
        }
        for row, outcome in zip(rows, outcomes)
    ]
    study = LAB.run_visual_keep_study(
        study_rows,
        {
            "visual": {
                "vectors": features,
                "index": {
                    str(row["id"]): index
                    for index, row in enumerate(study_rows)
                },
            },
        },
    )
    assert study["promotion"]["promoted"] is False
    assert study["promotion"]["predictorEligible"] is False
    assert isinstance(
        study["promotion"]["retrospectiveMetricThresholdPassed"],
        bool,
    )

    print(
        {
            "passed": True,
            "checks": 29,
            "signalOofPoints": len(protocol["points"]),
            "driftForwardPoints": len(forward["points"]),
            "driftMeanRmse": mean_diagnostic["metrics"]["rmse"],
            "driftPooledRidgeRmse": forward["metrics"]["rmse"],
            "driftProtocolBaselineR2": (
                forward["metrics"]["protocolBaselineR2"]
            ),
        }
    )


if __name__ == "__main__":
    main()
