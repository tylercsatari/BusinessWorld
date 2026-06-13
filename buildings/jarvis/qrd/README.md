# QRD — Quant Research Decoded pipeline

The full waveform-level implementation behind the Jarvis **🔬 Quant Decoder**
tab. Implements Stages 2–4 of `Tyler_Session_1_Overview.pdf` (feature
extraction → reduction → models → attribution) on the real reel corpus.

```
extract_features.py   Stage 2  — raw video_data/<id>/ → qrd_features.json
signatures.py         §6.2     — numpy level-2 path signatures (imported)
run_pipeline.py       Stage 3-4— qrd_features.json + targets → qrd_model.json
export_curves.py      §4-6 viz — full per-frame curves → qrd_curves.json
swipe_model.py        ★ trust  — trustworthy swipe model → qrd_swipe.json
qrd_features.json     output   — 213 reels × real atomic features
qrd_model.json        output   — reduction + model zoo + attribution results
qrd_curves.json       output   — 6 sample reels × time-series curves + mel + signature
qrd_targets.json      output   — real swipedAwayRate per reel
qrd_swipe.json        output   — swipe trust metrics, ROC, OOF preds, §12 validation
```

## Swipe-away trust (`swipe_model.py`)

Swipe-away is bimodal (most reels keep ~everyone; ~25% are "duds" losing ≥35%
in the hook), so the model is built and scored three ways under airtight nested
time-split CV (standardisation + L1 selection fit on the train fold only),
with bootstrap confidence bands:

* **Dud detection (classification)** — ROC-AUC **0.86** (90% CI 0.80–0.91)
* **Ranking (Spearman)** — ρ **0.61**
* **Regression (log1p)** — out-of-fold R² **0.34** (gap 0.15)

Verdict: **trustworthy** (5/5 bars), validated **10/10** against the §12 leakage
& causality checklist. Surfaced in the tab's **Swipe Trust** (★) section. The
one thing still owed per the doc: a matched-pair A/B test to promote each
dud-driver from hypothesis to rule.

The browser tab (`buildings/jarvis/jarvis-qrd.js`) fetches both JSON outputs,
merges the extracted atoms into its interactive in-browser model, and renders
the real Python results next to it. **Commit both JSON files** — they are
served to the browser and Render has no Python runtime.

## Re-running

Requires (all already present in the miniforge env): `numpy scipy librosa
opencv-python scikit-learn soundfile pillow pytesseract` + the `ffmpeg` and
`tesseract` binaries.

```bash
cd buildings/jarvis/qrd
python3 extract_features.py            # ~4 min, resumable (skips done reels)
python3 run_pipeline.py                # ~10 s
python3 export_curves.py               # ~30 s — time-series for §4-6 visuals
```

The tab visualises, from `qrd_curves.json`, the real mel-spectrogram and audio
descriptor channels over time (§4), the visual channels + scene cuts (§5), the
event-aligned multichannel bundle and the level-2 signature interaction matrix
(§6) — "keep the time axis." Commit `qrd_curves.json` too.

`extract_features.py` flags: `--limit N`, `--only <ytId>`, `--force`,
`--no-audio`. It is incremental — re-running only processes new reels and
checkpoints every 10.

## What gets extracted (first T=10s — where the hook lives)

| Group | Atoms | Tool | Coverage |
|-------|-------|------|----------|
| Audio | RMS loudness, spectral centroid, onset strength, ZCR, pitch (pyin), MFCC 1–4, mel low/high, voiced ratio | librosa | 109 reels w/ audio (mp4→wav via ffmpeg) |
| Visual | brightness, saturation, contrast, colour warmth, motion energy, cut rate, faces (present/size/centred), on-screen text @0s | opencv + Haar + tesseract | all 213 (frames) |
| Voice | speaking rate, time-to-first-word, word count, question-hook flag | transcript.words | all 213 |
| Sequence | event-aligned (§6.1) level-2 path signature, cross-channel interaction terms | signatures.py | all 213 |

Each per-frame curve is reduced to the §6.3 simple-baseline summary
(mean, std, slope, value@3s, first-3s-vs-rest ratio).

## What the model pipeline does

* **§7** standardise (train-only) → Marchenko–Pastur noise edge →
  Ledoit–Wolf shrinkage → PCA to the clean space.
* **§8** Elastic-Net, PLS, Gradient-boosted trees, Random forest, Gaussian
  Process, SVR — each scored by time-ordered nested CV (`TimeSeriesSplit`).
  A **feature-regime sweep** (llm-only / llm+extracted / all-raw / pca-clean)
  demonstrates the §7 "reduce before you fit" lesson on real numbers.
* **§9** Elastic-Net signed coefficients + GBM permutation importance, grouped
  by modality block, read underneath the confounds.
* Archetype clustering (KMeans + silhouette) on the PCA space.

Targets: T1 retention (primary), T1 keep (3-second hook), T3 log-views
(ranking check, read last). Strict leakage discipline throughout — split by
time, fit on train only, mediators excluded, bounded/log targets.
