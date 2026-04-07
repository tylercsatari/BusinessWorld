# AutoResearch Loop B — Tactical Signal Discovery

**Goal: Find new measurable indicators of video virality that don't exist in the current dataset.**

This loop discovers WHAT to measure — not how to model it. The outputs of this loop become new entries in hypothesis-queue.json for Loop A to test.

## Current signals (already have these)

- keep (in-video keep rate %)
- retention (avg % viewed)
- duration_s (video length in seconds)
- retention_per_sec (retention / duration)
- vz_score (visual Zeigarnik, 1-10, first 3s frames)
- vz_type (visual Zeigarnik type A/B/C/D/E)
- z_score (text Zeigarnik, 1-10)
- z_type (text Zeigarnik type)
- novelty (concept novelty 1-10)
- cognitive_load (cognitive load 1-10)
- net_novelty (novelty - cognitive_load)

## Data available to analyze

- `buildings/jarvis/signals-dataset.json` — 203 videos with all current signals
- `video_data/[ytId]/analysis.json` — raw analytics: retentionCurve, dailyViews, subscribersGained, engagedViews, etc.
- `video_data/[ytId]/frames/` — extracted frames (1 per second per video)
- Transcript words with timestamps in analysis.json

## Discovery methods

### Method 1: Correlation mining on existing analytics fields

The analysis.json files contain many fields not yet in the model:
- `engagedViews` — views that exceeded a watch time threshold
- `subscribersGained` — subs gained from this video
- `subscriberAvgPercent` vs `nonSubscriberAvgPercent` — subscriber vs non-subscriber retention
- `dailyViews` — view count trajectory over time
- `retentionVariation` — how much retention varies across the video

For each video, extract these fields and correlate with log10(views). Report top findings.

### Method 2: RetentionCurve analysis (R2-level signals)

The retentionCurve is a time series of percent retention at each point in the video.
Analyze all 372 videos' retention curves:
- What second does the biggest single drop occur? (hook failure point)
- What % retention remains at the 3-second mark? (early hook hold)
- What % retention remains at the 10-second mark? (mid-hook hold)
- What is the slope from second 3 to second 10? (recovery or continued drop)
- Is there a bump (re-engagement) at any point?

Compute these derived signals and correlate each with:
1. Total views (log10)
2. Keep rate
3. Avg retention

Report which retention curve features are most predictive.

### Method 3: Combinatorial signal ratios

Test these ratios as new signals:
- keep × retention (combined hook+body signal)
- vz_score × novelty (curiosity × freshness)
- keep / cognitive_load (accessibility-adjusted hook)
- (retention - 70) × duration_s (engagement-minutes above baseline)

For each: compute for all videos, run Pearson vs log10(views), report r value.

### Method 4: Content category clustering

Using title text + vz_type + z_type, group the 203 videos into content categories.
Identify which categories outperform others.
Are there specific content patterns (build + challenge + physical) that consistently hit 10M+?

### Method 5: Outlier analysis

Find the videos in each tier (100M+, 10-50M, 1-5M, sub-1M) and identify what makes each tier distinctive.
Look at the FULL signal profile of Tyler's top 10 videos vs bottom 10.
What signals are consistently different? These are strong candidates for new hypotheses.

## Output

For each discovery, create an entry in hypothesis-queue.json:
```json
{
  "id": "h_new_X",
  "signal": "signal_name",
  "hypothesis": "...",
  "expected_signal": "r > 0.X vs log(views)",
  "method": "how to score/extract this signal",
  "status": "queued",
  "resolution": "R2/R3/R4",
  "discovered_by": "loop_b",
  "correlation_found": 0.XX
}
```

Also append a summary to results.tsv with format:
```
loop_b_[n]	discovery: signal_name	—	—	—	discovery	203	r=X.XX vs log(views). Method: ...
```

## Never stop

Keep finding signals. Explore the retentionCurve data deeply — there are 372 videos worth of second-by-second data. Find patterns.
Then look at the daily view trajectory (dailyViews) — does a fast start predict total views?
Then look at subscriber gain rate — which videos convert viewers to subscribers at the highest rate?
Each finding becomes a new hypothesis for Loop A to validate.
