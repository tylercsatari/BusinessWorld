# AutoResearch Loop A — Prediction Model Improvement

**Goal: Find the minimum combination of measurable signals that consistently predicts 100M+ view videos.**

Current model R² = 0.147. Target: R² > 0.50.

## Data files (read the files before starting)

- `buildings/jarvis/signals-dataset.json` — 203 videos, each with: views, keep, retention, duration_s, retention_per_sec, z_score, vz_score, novelty, cognitive_load, net_novelty, vz_type, z_type
- `buildings/jarvis/prediction-model.json` — current model weights and R²
- `buildings/jarvis/hypothesis-queue.json` — signals to test
- `buildings/jarvis/results.tsv` — experiment log (APPEND, do not overwrite)
- `video_data/[ytId]/analysis.json` — raw analytics per video (retentionCurve, etc.)

## Known confound to fix FIRST (do this before anything else)

Retention % without duration context is misleading. 80% retention on a 15s video = 12s watched. 80% on a 55s video = 44s watched. The model needs `retention_per_sec` (already computed in dataset) as a replacement or companion to raw retention %.

**Experiment 0 (run first):** Compare R² using raw retention vs retention_per_sec. If retention_per_sec improves R², swap it in.

## Regression evaluation standard

Always use: **Multiple linear regression, 80/20 holdout split (random_seed=42), metric = R² on holdout set**

All correlations should use log10(views) as the target (to normalize the power-law distribution).

A new signal is KEPT if it improves holdout R² by more than 0.01. DISCARDED otherwise.

## Hypothesis queue (run in this order)

### H0: retention_per_sec (free — data exists)
Signal: retention_per_sec = retention / duration_s
Expected: improves on raw retention since it removes the duration confound
Method: already in dataset, just swap into regression

### H1: retention_slope_3s (free — data exists)
Signal: slope of retentionCurve in first 10 data points
Method: read retentionCurve array from video_data/[ytId]/analysis.json for each video
Compute: fit a line to the first 10 retention curve values, extract slope (negative = fast drop)
Expected: early retention slope r > 0.3 vs total retention

### H2: hook_clarity (LLM vision, costs ~$0.20 total)
Signal: how immediately clear is the subject of the video in the first frame? (1-10)
Method: Load frame_0001.jpg from video_data/[ytId]/frames/ for each video
Send to GPT-4o-mini vision: "Score 1-10 how immediately obvious the video subject is in this frame. 1=completely unclear, 10=instantly obvious what this video is about."
Batch 15 videos per API call. Delay 1s between calls.
Expected: r > 0.25 vs keep rate

### H3: visual_surprise (LLM vision)
Signal: does the first frame show something unexpected, impossible, or never-seen-before? (1-10)
Method: same frame scoring approach as H2
Expected: r > 0.20 vs vz_score

### H4: face_presence (LLM vision)
Signal: is a human face prominently visible in the first frame? (binary 0/1)
Method: LLM vision score
Expected: type distribution differs by face presence

### H5: duration_bucket (free — data exists)
Signal: categorical: SHORT (≤30s), MEDIUM (31-55s), LONG (56s+)
Method: bin duration_s from dataset
Expected: different prediction equations per bucket — may need separate models

## After each hypothesis

1. Score the signal on all 203 videos
2. Run multiple regression: current signals + new signal → log10(views)
3. Record: experiment_id, new_signal, r2_before, r2_after, delta_r2, status, notes
4. Append to results.tsv (tab-separated, do NOT overwrite)
5. If kept: update prediction-model.json — bump version, add signal to weights
6. If discarded: note why in results.tsv and move on

## When you're done with the queue

Generate new hypotheses from what you found. Consider:
- Interactions between signals (keep × vz_score composite)
- Duration-stratified models (separate regressions for SHORT vs MEDIUM vs LONG)
- Resolution R2 signals from retentionCurve (what second does the biggest drop happen?)
- Any unexpected finding from the experiments

## Output format

results.tsv:
```
experiment_id	new_signal	r2_before	r2_after	delta_r2	status	n_videos	notes
```

## Never stop

Once you start, keep running experiments until the human stops you.
If you run out of LLM-scorable signals, analyze the retentionCurve data in depth — there are 372 videos worth of second-by-second retention curves. Find the pattern.
