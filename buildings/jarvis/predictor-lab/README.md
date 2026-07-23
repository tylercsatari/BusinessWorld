# Shorts Quant Predictor Lab

This folder builds the persisted research artifact shown under **Shorts Quant →
Raw → Predictor Lab**.

## Targets

- **Keep rate:** private `stayedToWatch` / `keep_rate` labels. The operational
  interpolation test holds out complete videos from known accounts. Separate
  tests hold out one whole account and move forward through publication time.
  Keep- and ret5-aligned embedding axes, percentile references, feature
  selection, and regularization are rebuilt inside nested training-only folds.
- **Views:** the canonical 21 outputs saved for channels that were scored after
  the axes were frozen. The interpolation test holds out complete videos from
  known channels, while separate tests leave one whole channel out and move
  forward through publication time. Current views remain lifetime snapshots
  until fixed-horizon history exists, and the upstream scorer version is not
  yet persisted per video.

The runner evaluates exactly 50,000 deterministic input subsets during each
model-selection pass. Sparse regularization is chosen from the exhaustive
one- and two-input registry; the regularized all-input benchmark chooses its
own strength in the same training-only partitions. It stores both formulas,
held-out predictions, fully nested empirical tail calibration, fold results,
every single-feature relationship curve, source-level diagnostics, age-cohort
sensitivity, and corpus coverage in one JSON artifact. Video-level lift is
reported after centering predictions and outcomes within each account/channel,
so a creator baseline cannot masquerade as content signal. Atlas p-values use
within-source target permutations before FDR correction.

```bash
python3 buildings/jarvis/predictor-lab/run_predictor_lab.py
```

The web process never loads an embedding archive or fits a model. It serves
`raw/predictor-lab/results.json` and `raw/predictor-lab/status.json` from R2,
with the checked local result as a development fallback.

## Interpretation

The displayed downstream formula is fitted only after validation. It stores
its exact inputs, imputation, standardization, and weights, but a new raw video
still needs the matching frozen upstream feature generator. The current saved
channel rows also lack immutable per-video scorer-version provenance, so this
artifact is a research result rather than a standalone production scorer. Its
performance number always comes from outer held-out predictions, never from
the final in-sample fit.

Known-source video holdouts measure retrospective interpolation, not a
prospective forecast. Whole-source and forward-time tests are deliberately
separate. The time tests replay downstream fitting in publication order but
still reuse present-day frozen upstream representation artifacts, so they are
labeled partial backtests. A positive interpolation result cannot override a
negative time or unseen-source result.

Tail probabilities remain descriptive while the saved-channel sample contains
only a few independent channels and views are lifetime snapshots. The artifact
reports Brier skill against the base-rate null, but it does not frame the
current calibration as decision-grade financial risk.

Every source object read by a run is content-hashed. Raw arrays are rejected
when IDs, vectors, labels, metadata, or flags are misaligned, and a run aborts
if it observes two byte generations for the same source.

## Science Center backfill

The backfill streams only each stored Short's first five seconds from R2,
persists canonical visual/text/together vectors, reports a live heartbeat, and
reruns the predictor artifact after completion. It does not run on Render.

```bash
scripts/run-predictor-backfill.sh
```
