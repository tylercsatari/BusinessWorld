#!/usr/bin/env python3
"""Freeze an independent Long Quant title-market prior for Promise Lab hooks."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.stats import pearsonr, spearmanr
from sklearn.linear_model import Ridge
from sklearn.metrics import r2_score


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))

from longquant_score import cache_vecs, load_map, r2_get  # noqa: E402
from embedding_store import R2_PREFIX, R2Store, json_ready  # noqa: E402


OUTPUT = HERE / ".cache" / "long-title-prior.json"
SEED = 20260712
ALPHA = 1.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()

    vectors = cache_vecs("text")
    mapping = load_map("text")
    views = np.asarray(mapping.get("views") or [], np.float32)
    valid = np.flatnonzero(np.isfinite(views) & (views > 0))
    if len(valid) != len(vectors):
        raise RuntimeError("Long Quant text vectors and observed view labels differ")
    target = np.log10(views[valid]).astype(np.float32)
    rng = np.random.default_rng(SEED)
    order = rng.permutation(valid)
    cut = int(round(len(order) * .7))
    train, test = order[:cut], order[cut:]

    heldout_model = Ridge(alpha=ALPHA, solver="lsqr", tol=1e-5).fit(
        vectors[train], target[train],
    )
    prediction = heldout_model.predict(vectors[test]).astype(np.float32)
    residual = target[test] - prediction
    full_model = Ridge(alpha=ALPHA, solver="lsqr", tol=1e-5).fit(
        vectors[valid], target,
    )
    training_prediction = full_model.predict(vectors[valid]).astype(np.float32)

    stats = {}
    stats_payload = r2_get("longform/stats.json")
    if stats_payload:
        try:
            stats = json.loads(stats_payload)
        except (TypeError, ValueError):
            stats = {}
    stored = int(stats.get("stored") or len(vectors))
    artifact = {
        "version": 1,
        "status": "complete-independent-prior",
        "methodVersion": "long-quant-title-log-views-prior-v1",
        "embeddingInput": "complete hook text embedded in the same Gemini 1536D text space as Long Quant titles",
        "target": "log10 observed long-form views",
        "coefficient": np.round(np.asarray(full_model.coef_, np.float32), 8),
        "intercept": float(full_model.intercept_),
        "trainingPredictionMean": float(np.mean(training_prediction)),
        "trainingPredictionStd": float(np.std(training_prediction)),
        "trainingPredictionP10": float(np.quantile(training_prediction, .1)),
        "trainingPredictionP90": float(np.quantile(training_prediction, .9)),
        "corpus": {
            "storedLongFormRecords": stored,
            "embeddedTitleRecords": int(len(vectors)),
            "embeddedCoverageFraction": float(len(vectors) / max(stored, 1)),
            "mapReportedRecords": int(mapping.get("n") or len(vectors)),
            "mapUpdated": mapping.get("updated"),
        },
        "validation": {
            "policy": "one deterministic 70/30 random holdout; not chronological",
            "trainRows": int(len(train)),
            "testRows": int(len(test)),
            "heldoutSpearman": float(spearmanr(prediction, target[test]).statistic),
            "heldoutPearson": float(pearsonr(prediction, target[test]).statistic),
            "heldoutR2": float(r2_score(target[test], prediction)),
            "heldoutRMSELog10Views": float(np.sqrt(np.mean(residual ** 2))),
            "absoluteErrorP50Log10Views": float(np.quantile(np.abs(residual), .5)),
            "absoluteErrorP80Log10Views": float(np.quantile(np.abs(residual), .8)),
            "absoluteErrorP90Log10Views": float(np.quantile(np.abs(residual), .9)),
        },
        "claimBoundary": (
            "This is an independent long-form title-market prior. It is never blended into "
            "the Shorts retention-hold score unless transfer to held-out Shorts retention is "
            "positive and replicated. Missing Long Quant titles are not represented by the model."
        ),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(json_ready(artifact), separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )
    if not args.no_upload:
        R2Store().put_json(
            f"{R2_PREFIX}/long-title-prior.json.gz", artifact, gzip_payload=True,
        )
    print(json.dumps(json_ready({
        "status": artifact["status"],
        "corpus": artifact["corpus"],
        "validation": artifact["validation"],
    }), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
