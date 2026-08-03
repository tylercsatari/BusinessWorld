#!/usr/bin/env python3
"""Channel-free hook signal — canonical runner.

Regenerates BOTH artifacts of the channel-free keep signal from one deterministic
run, so every consumer stays consistent:

  channel-free-signal.json   validation record (metrics, protocol, limitations)
  channel-free-scores.json   per-video held-out (OOF) scores for the UI scatter

Both artifacts share a runId and dataIdentity hash. Downstream consumers:
  quant/promotion-ledger.js  -> findings.channelFreeKeepDirection (+ consistency check)
  build-artifact.js          -> artifact.json -> principles-lab-ui.js (Quant audit +
                                Evidence ledger tabs)
  jarvis-retention.js        -> Experiment-tab "Channel-free hook signal" card
                                (reads labels/metrics from channel-free-scores.json
                                summary — nothing hardcoded in the UI)

Regeneration order when data changes (new videos / embeddings):
  1. python3 run_channel_free_signal.py
  2. node ../principles-lab/quant/promotion-ledger.js --out .../promotion-ledger.json
  3. node ../principles-lab/build-artifact.js
  4. node ../../../scripts/test-channel-free-signal.js   (consistency gate)

Design rules (from the 2026-08-03 decision): ONE pooled ridge direction per signal,
no channel information of any kind (no offsets, refits, or centering). Deploy as
percentile/rank; absolute keep on unseen channels is structurally unavailable.
"""
from __future__ import annotations

import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_predictor_lab as P  # exact same loaders as the predictor lab

HERE = Path(__file__).resolve().parent
ALPHAS = [1.0, 10.0, 100.0, 1000.0, 10000.0]
SEEDS = [11, 22, 33, 44, 55]
MODALITIES = ["visual", "text", "together"]
SIGNALS = MODALITIES + ["concat"]
SIGNAL_LABELS = {
    "visual": "Visual (5-frame montage)",
    "text": "Text (spoken hook)",
    "together": "Together (montage + hook)",
    "concat": "Concat (visual+text+together)",
}


def inner_alpha(X: np.ndarray, y: np.ndarray, seed: int) -> float:
    best, best_mae = ALPHAS[0], np.inf
    inner = KFold(n_splits=4, shuffle=True, random_state=seed)
    for alpha in ALPHAS:
        errs = []
        for tr, te in inner.split(X):
            model = Ridge(alpha=alpha).fit(X[tr], y[tr])
            errs.append(np.mean(np.abs(np.clip(model.predict(X[te]), 0, 100) - y[te])))
        mae = float(np.mean(errs))
        if mae < best_mae:
            best, best_mae = alpha, mae
    return best


def metric_row(y: np.ndarray, p: np.ndarray) -> dict:
    ok = np.isfinite(y) & np.isfinite(p)
    y, p = y[ok], p[ok]
    mae = float(np.mean(np.abs(p - y)))
    rho = float(spearmanr(y, p).statistic) if len(y) > 2 else None
    ss = float(np.sum((y - np.mean(y)) ** 2))
    r2 = float(1 - np.sum((y - p) ** 2) / ss) if ss > 0 else None
    return {"n": int(len(y)), "mae": round(mae, 3),
            "spearman": None if rho is None else round(rho, 3),
            "r2": None if r2 is None else round(r2, 3)}


def main() -> int:
    rows = P.load_private_rows()
    stores = P.load_raw()
    eligible = [r for r in rows if P.finite(r.get("keep"))
                and all(r["id"] in stores[m]["index"] for m in MODALITIES)]
    y = np.asarray([float(r["keep"]) for r in eligible])
    acct = np.asarray([str(r["account"]) for r in eligible])
    identity = hashlib.sha256("|".join(sorted(
        f"{r['id']}:{float(r['keep']):.2f}" for r in eligible)).encode()).hexdigest()
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    run_id = hashlib.sha256(f"{identity}|{SEEDS}|{ALPHAS}".encode()).hexdigest()[:16]
    print(f"n={len(eligible)} identity={identity[:16]} runId={run_id}")

    feats: dict[str, np.ndarray] = {}
    for m in MODALITIES:
        idx = [stores[m]["index"][r["id"]] for r in eligible]
        feats[m] = stores[m]["vectors"][idx]
    feats["concat"] = np.hstack([feats[m] for m in MODALITIES])

    results: dict[str, dict] = {}
    mean_oof: dict[str, np.ndarray] = {}
    for name in SIGNALS:
        X = feats[name]
        runs, acc = [], np.zeros(len(y))
        acct_runs: dict[str, list] = defaultdict(list)
        for seed in SEEDS:
            oof = np.full(len(y), np.nan)
            for tr, te in KFold(n_splits=5, shuffle=True, random_state=seed).split(X):
                alpha = inner_alpha(X[tr], y[tr], seed)
                oof[te] = np.clip(Ridge(alpha=alpha).fit(X[tr], y[tr]).predict(X[te]), 0, 100)
            runs.append(metric_row(y, oof))
            acc += oof
            for a_name in np.unique(acct):
                mask = acct == a_name
                acct_runs[str(a_name)].append(metric_row(y[mask], oof[mask]))
        mean_oof[name] = acc / len(SEEDS)
        loao = {}
        for a_name in np.unique(acct):
            tr, te = acct != a_name, acct == a_name
            if te.sum() < 5:
                continue
            alpha = inner_alpha(feats[name][tr], y[tr], 7)
            pred = np.clip(Ridge(alpha=alpha).fit(feats[name][tr], y[tr]).predict(feats[name][te]), 0, 100)
            loao[str(a_name)] = metric_row(y[te], pred)
        maes = [r["mae"] for r in runs]
        results[name] = {
            "oof_5x5": {
                "mae_mean": round(float(np.mean(maes)), 3),
                "mae_sd": round(float(np.std(maes)), 3),
                "spearman_mean": round(float(np.mean([r["spearman"] for r in runs])), 3),
                "spearman_sd": round(float(np.std([r["spearman"] for r in runs])), 3),
                "r2_mean": round(float(np.mean([r["r2"] for r in runs])), 3),
                "r2_sd": round(float(np.std([r["r2"] for r in runs])), 3),
                "runs": runs,
            },
            "per_account_mae_mean": {a: round(float(np.mean([r["mae"] for r in rs])), 2)
                                     for a, rs in acct_runs.items()},
            "per_account_spearman_mean": {a: round(float(np.mean([r["spearman"] for r in rs
                                                                  if r["spearman"] is not None])), 3)
                                          for a, rs in acct_runs.items()},
            "leave_one_account_out": loao,
        }
        print(f"[{name}] MAE {results[name]['oof_5x5']['mae_mean']}"
              f"±{results[name]['oof_5x5']['mae_sd']}"
              f" rho {results[name]['oof_5x5']['spearman_mean']}")

    # baseline + data-driven selection (min mean OOF MAE — no hardcoding)
    base = []
    for seed in SEEDS:
        oof = np.full(len(y), np.nan)
        for tr, te in KFold(n_splits=5, shuffle=True, random_state=seed).split(y):
            oof[te] = np.mean(y[tr])
        base.append(float(np.mean(np.abs(oof - y))))
    baseline_mae = round(float(np.mean(base)), 3)
    selected = min(SIGNALS, key=lambda s: results[s]["oof_5x5"]["mae_mean"])

    acct_counts = {a: int((acct == a).sum()) for a in np.unique(acct)}
    signal_artifact = {
        "schema": "channel-free-keep-signal-v2",
        "runId": run_id,
        "generatedAt": generated,
        "generator": "predictor-lab/run_channel_free_signal.py",
        "question": "Best single signal, identical across all channels (no per-channel offsets, "
                    "refits, or centering), predicting raw stayedToWatch keep %, minimizing MAE.",
        "protocol": {
            "design": f"{len(SEEDS)} independent runs of 5-fold OOF (20% held back per fold, "
                      f"shuffle seeds {SEEDS}); every video predicted once per run by a model "
                      "that never saw it",
            "model": "ridge on L2-normalized Gemini hook embeddings; alpha by inner 4-fold MAE "
                     f"on training folds only (grid {ALPHAS})",
            "channelInformation": "none — no account feature, no offsets, no target centering, pooled fit",
            "additionalHoldout": "leave-one-account-out: train on 3 accounts, predict the 4th",
            "adaptiveSearchUniverse": {"candidatesEvaluated": len(SIGNALS), "candidates": SIGNALS,
                                       "note": "single selection pass (min mean OOF MAE); no further spec shopping"},
        },
        "dataIdentity": {"n": len(eligible), "accounts": acct_counts,
                         "target": "keep_rate (stayedToWatch, scraped from YouTube Studio)",
                         "identityHash": identity,
                         "embeddingSources": [f"raw/{m}/embeddings.npz" for m in MODALITIES],
                         "labelSources": ["retention-study/retention_table.json",
                                          "retention/<account>.json (R2)"]},
        "results": results,
        "baselineGlobalMeanMAE": baseline_mae,
        "selectedSignal": {"name": selected,
                           "label": SIGNAL_LABELS[selected],
                           "oofMAE": results[selected]["oof_5x5"]["mae_mean"],
                           "oofMAEsd": results[selected]["oof_5x5"]["mae_sd"],
                           "oofSpearman": results[selected]["oof_5x5"]["spearman_mean"],
                           "oofR2": results[selected]["oof_5x5"]["r2_mean"],
                           "selectionRule": "argmin mean OOF MAE across the declared candidate universe"},
        "scoresArtifact": {"path": "predictor-lab/channel-free-scores.json", "runId": run_id,
                           "rows": len(eligible)},
        "honestLimitations": [
            "No forward-time holdout: folds are random over publication time.",
            "Unseen-channel ABSOLUTE error is dominated by the unknown channel baseline; only the "
            "RANKING transfers (see leave_one_account_out).",
            "Pooled OOF Spearman partially reflects implicit channel recognition from visual style; "
            "the unseen-channel rho is the portable strength.",
            "Same private keep-labeled corpus as the retention/tribe/predictor evidence events — "
            "NOT an independent outcome event.",
            "Recommended deployment: percentile/rank on the frozen direction, not absolute keep.",
        ],
        "verdict": f"A single channel-free latent direction ({selected}) predicts keep at OOF MAE "
                   f"{results[selected]['oof_5x5']['mae_mean']}±{results[selected]['oof_5x5']['mae_sd']} "
                   f"(baseline {baseline_mae}); rank transfers to unseen channels, absolute level does not.",
    }
    (HERE / "channel-free-signal.json").write_text(json.dumps(signal_artifact, indent=1) + "\n")

    scores_artifact = {
        "schema": "channel-free-scores-v2",
        "runId": run_id,
        "generatedAt": generated,
        "generator": "predictor-lab/run_channel_free_signal.py",
        "note": "Per-video OOF predictions (mean of the seed runs; the model never saw the video). "
                "Consistent with channel-free-signal.json by shared runId.",
        "identityHash": identity,
        "signals": SIGNALS,
        "selected": selected,
        "summary": {name: {"label": SIGNAL_LABELS[name],
                           "mae": results[name]["oof_5x5"]["mae_mean"],
                           "rho": results[name]["oof_5x5"]["spearman_mean"],
                           "r2": results[name]["oof_5x5"]["r2_mean"],
                           "selected": name == selected} for name in SIGNALS},
        "rows": [{"id": r["id"], "title": r.get("title", ""), "account": str(r["account"]),
                  "keep": float(r["keep"]),
                  **{name: round(float(mean_oof[name][i]), 2) for name in SIGNALS}}
                 for i, r in enumerate(eligible)],
    }
    (HERE / "channel-free-scores.json").write_text(json.dumps(scores_artifact) + "\n")
    print(f"wrote channel-free-signal.json + channel-free-scores.json (runId {run_id}, selected {selected})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
