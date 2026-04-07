# AutoResearch — Video Virality Prediction

Autonomous research loop for improving prediction of YouTube Shorts viral success.
Inspired by Karpathy's autoresearch framework (github.com/karpathy/autoresearch).

## Goal

Get the lowest prediction error (highest R²) on the video success prediction model.
The model predicts log10(views) from measurable video signals.

**Current baseline: R² = 0.147 (v1)**
**Target: R² > 0.50**

## The files (do not modify prepare.js or signals-dataset.json directly)

- `signals-dataset.json` — 203 videos with all scored signals. READ ONLY.
- `prediction-model.json` — current model weights, R², version history. UPDATED each experiment.
- `hypothesis-queue.json` — list of hypotheses to test. UPDATED each experiment.
- `results.tsv` — experiment log (tab-separated). APPEND ONLY.
- `program.md` — these instructions. You can update to reflect learnings.

## What you CAN do

- Score new signals on the 203 videos via LLM (vision + text)
- Run experiments combining signals to improve R²
- Add new signals to prediction-model.json when R² improves
- Update hypothesis-queue.json with new ideas
- Analyze retentionCurve data (in video_data/[ytId]/analysis.json) for R2-level signals

## What you CANNOT do

- Modify video_data/ or signals-dataset.json directly
- Remove existing signals from the model (only add)
- Change the evaluation metric (R² on 80/20 holdout, 203 videos)

## The metric

The ground truth is: **R² on 80/20 holdout split, predicting log10(views)**

Current signal set:
- keep (keep rate %, YouTube Analytics)
- retention (avg % viewed, YouTube Analytics)
- vz_score (visual Zeigarnik, LLM vision 3s)
- z_score (text Zeigarnik, LLM text)
- novelty (concept novelty, LLM text)
- cognitive_load (cognitive load, LLM text)
- net_novelty (derived: novelty - cognitive_load)

## Hypotheses to test (priority order)

See hypothesis-queue.json for full list. Priority signals:

1. **hook_clarity** (R4: first frame) — subject clarity in first frame
   - Method: LLM vision score frame_0001.jpg per video (1-10)
   - Expected: r > +0.25 vs keep

2. **visual_surprise** (R4: first frame) — unexpected/impossible visual
   - Method: LLM vision score frame_0001.jpg per video (1-10)
   - Expected: r > +0.2 vs vz_score

3. **retention_slope_3s** (R2: second-by-second) — drop in first 10 seconds
   - Method: read retentionCurve from analysis.json, compute slope of points 0-10
   - Expected: r > +0.4 vs total retention
   - NOTE: data already exists, no LLM scoring needed

4. **face_presence** (R4: first frame) — human face visible (binary 0/1)
   - Method: LLM vision score frame_0001.jpg
   - Expected: face videos have different Zeigarnik type distribution

5. **text_overlay** (R4: first frame) — on-screen text in first frame (binary)
   - Method: LLM vision score
   - Expected: r > +0.15 vs keep

## Experiment loop

LOOP FOREVER:

1. Pick the highest-priority untested hypothesis from hypothesis-queue.json
2. Score that signal on all 203 videos (or subset if LLM cost is high)
3. Run multiple regression: add new signal to current feature set, compute R² on holdout
4. Compare new R² to current R²
5. If R² improves by > 0.01: **keep** — add signal to prediction-model.json, update model weights
6. If R² improves by ≤ 0.01: **discard** — log as "no significant gain"
7. Either way: append result to results.tsv
8. Update hypothesis-queue.json (mark tested, add any new hypotheses discovered)
9. Repeat

## Logging format

results.tsv columns (tab-separated):
```
experiment_id	new_signal	r2_before	r2_after	delta_r2	status	n_videos	notes
```

Status: keep | discard | error

## Resolution tracking

Each experiment maps to a resolution level in resolution-registry.json:
- R2 signals (retentionCurve) → resolution level 2
- R3 signals (first 3s LLM) → resolution level 3
- R4 signals (first frame) → resolution level 4

When a signal is kept, update resolution-registry.json to increment the `depth` of its resolution level.

## Depth tracking

Depth = number of active signals at a given resolution.
- R0: currently depth=7 (keep, retention, z_score, novelty, cog_load, net_novelty, share_rate)
- R3: currently depth=3 (vz_score, vz_type, z_score from 3s text)
- R4: currently depth=0 (no first-frame signals yet)

Goal: increase depth at R4 to 4+ and increase R2 depth to 2+.

## Constraint: cost awareness

Each LLM vision scoring call costs ~$0.001. 203 videos × 1 frame = $0.20 per new signal.
Batch calls: score 15 videos per API call with vision to stay under rate limits.
Prefer R2 signals first (free — data already exists).
