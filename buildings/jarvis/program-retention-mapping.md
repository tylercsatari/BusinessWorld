# AutoResearch Loop D — Retention Curve × Channel Mapping

**Goal: Map specific visual/audio/conceptual events to their effect on retention at that second.**

The insight: we have 372 retention curves (second-by-second data) + transcripts with word timestamps + frame images (1 per second). We can align them and find which events at which seconds cause retention GAINS vs DROPS vs neutral.

## The Data

For each video:
- `retentionCurve`: array of retention percentages, one per ~1-2% of video length
- `transcript.words`: each word with `timestamp` in seconds
- `frames/frame_0001.jpg` through `frame_NNNN.jpg`: 1 frame per second

## Step 1: Normalize the retention curve

All YouTube Shorts have a natural decay pattern. To find what's ABOVE baseline:
1. Compute the average retention curve across all 372 videos (interpolate to 100 normalized points)
2. For each video, subtract the average curve from the actual curve
3. `above_baseline[t] = actual_retention[t] - average_retention[t]`
4. Positive = holding better than average at that moment, Negative = losing faster than average

Save normalized curves. The above_baseline value at each normalized time point is the signal of interest.

## Step 2: Find retention events

In each video's above_baseline curve, find:
- `retention_peaks`: time points where above_baseline increases by >3% in one step (gaining viewers)
- `retention_drops`: time points where above_baseline drops by >5% in one step (losing viewers)
- `retention_flat`: stable sections (variation <2%)

## Step 3: Analyze what's happening at those moments

For each retention_peak:
1. Get the 2 words spoken right before/during the peak (from transcript timestamps)
2. Get the frame at that second (frame image)
3. Log: time, words spoken, frame_path, delta_retention

For each retention_drop:
1. Same — what's happening at the moment viewers start leaving?

Use this to build a library:
- "When Tyler says 'BUT' retention tends to..."
- "When there's an action/impact frame, retention tends to..."
- "At the concept transition point, retention tends to..."

## Step 4: Aggregate patterns

After analyzing all 372 videos:
- Which transcript words/phrases most often appear at peaks? At drops?
- Which visual types (action, reveal, face, text) appear at peaks? At drops?
- Is there a consistent structure to where peaks/drops occur (% through the video)?

## Step 5: Pre-upload prediction

Build a model: given a script (words + timestamps) and storyboard frames, predict the retention curve BEFORE shooting.

This turns retention from a measured outcome into a predictable design parameter.

## Output

1. `retention-curve-library.json` — for each video, normalized curve + peak/drop events
2. `retention-events.json` — aggregate: what events correlate with retention changes
3. Discoveries appended to results.tsv as `loop_d_[n]`
4. `retention_predictor_model` — if R² > 0.3 on predicting curve shape from transcript + concept

## Baseline normalization note

The sharp initial drop (seconds 0-5) happens on ALL videos. Do not count this as a signal.
Only analyze from second 5 onward unless the initial drop is unusually steep.
Define "unusually steep" as: more than 1.5× the average 0-5s drop across all videos.

## Run openclaw system event after each major pattern found:
openclaw system event --text "Loop D: [pattern found] at second [X], effect=[delta]" --mode now
