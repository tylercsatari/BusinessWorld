# Jarvis Data Wiki
**Single source of truth for what data exists, where it lives, and what it contains.**

---

## Primary Corpus: Tyler's Videos (370 videos)

**Location:** `/video_data/{ytId}/analysis.json`

These are the only videos with full YouTube analytics (retention curves, engagement, revenue etc.). Every experiment runs against this corpus unless otherwise specified.

### What's available per video:

#### `metadata`
- `title`, `duration` (seconds), `viewCount`, `likeCount`, `commentCount`
- `uploadDate`, `isVertical`, `width`, `height`, `description`

#### `analytics` (YouTube Studio data)
- `avgRetention` — 0–1 scalar (e.g. 0.87 = 87%)
- `retentionVariation` — how much retention fluctuates
- `avgPercentViewed` — percent of video watched on average
- `avgViewDuration` — seconds
- `totalViews`, `engagedViews`
- `viewedRate`, `swipedAwayRate` (0–100%)
- `likes`, `shares`, `comments`, `subscribersGained`, `subscribersLost`
- `subscriberViews`, `nonSubscriberViews`
- `subscriberAvgPercent`, `nonSubscriberAvgPercent`
- `estimatedRevenue` (USD)
- **`retentionCurve`** — array of 100 `{second, retention}` objects mapping each 1% of video to normalized retention value (>1.0 means re-watches). This is the primary signal for all retention-based experiments.
- `dailyViews` — array of `{date, views, cumulative, watchMinutes}` — full day-by-day view history

#### `aiAnalysis`
- `videoIdea` — one-sentence concept
- `summary` — paragraph summary of the video
- `segments` — array of `{label, description, startTime, endTime, transcript}` — narrative segments (Hook, Setup, Climax, etc.), available for 284/370 videos

#### `transcript`
- Full spoken transcript text (available for 370/370 videos)

#### `frames`
- Array of per-second frame analysis objects (one per second of video)
- Each frame: `{index, timestamp, filename, analysis: {sceneDescription, visualTechniques, cinematography, engagementAnalysis, keyInsights, accessibilityNotes}}`
- Frame images: `/video_data/{ytId}/frames/frame_{NNNN}.jpg`
- All 370 videos have frame analysis (1 frame per second of video)

#### `video.mp4`
- Raw video file at `/video_data/{ytId}/video.mp4`

---

## Secondary Corpus: Research Center (2,020 viral videos)

**Location:** `shorts-db.json` (in-memory DB, served via `/api/shorts-db/videos`)

These are high-view YouTube Shorts from other creators, discovered by the crawler. They do NOT have YouTube Studio analytics (no retention curves, no engagement breakdowns).

**Available fields:** `videoId`, `title`, `channelTitle`, `views`, `publishedAt`, `thumbnail`, `duration`

**Use cases:**
- Experiments that only need title text, duration, or thumbnail analysis
- Comparative view count benchmarking
- Content category classification at scale
- Frame/visual analysis if frames get downloaded on-demand

**Not useful for:** Any experiment requiring retention curves, engagement metrics, or subscriber data.

---

## Data Available For Extraction (per video, per experiment)

When running an experiment, the agent can compute/extract ANY of the following from the raw data:

### From `retentionCurve` (100 data points, normalized 0–1 of video):
- Retention at any percentile (25%, 50%, 75%, 90%, etc.)
- Hook drop (retention at second 3–5 vs second 0)
- Max cliff (biggest single-second drop)
- Smoothed slope (linear regression of retention decline)
- Shannon entropy of the curve (information richness)
- Convexity/concavity (is the curve above or below a straight line?)
- Peak/drop events (local maxima/minima)
- Area above/below baseline
- Derivative at any point
- Retention at specific timestamps (absolute seconds)

### From `metadata`:
- Duration (seconds)
- View count (log-transformed recommended: log10(viewCount))
- Like count, comment count
- Upload date (day of week, recency)
- Is vertical, aspect ratio

### From `analytics` (scalars):
- Keep rate (avgRetention)
- Swipe-away rate
- Subs gained per view
- Non-subscriber view share
- Revenue per view
- 7-day view velocity (computable from dailyViews)
- Week1/week2 view ratio (computable from dailyViews)

### From `transcript`:
- Word count, speech rate (words per second)
- Question count
- Specific word/phrase presence
- Sentence length distribution
- Hook words (first 15 words)
- Action verbs, emotional words

### From `aiAnalysis.segments`:
- Hook duration (endTime of Hook segment)
- Number of segments
- Segment labels present (has climax? has callback?)
- Narrative arc completeness

### From `frames` (per-second visual analysis):
- Scene change frequency (cut rate)
- Visual complexity by segment
- Face presence
- Text overlay presence
- Visual technique variety

---

## Experiment Tools (Analytical Brain)

Reusable statistical tools. Each tool has defined parameters. When an experiment runs, it references a tool by name — the same tool definition appears in both Analytical Brain and the experiment card in Tactical Brain.

### Currently available (to verify/build):
- **Partial Correlation** — r_partial of indicator vs target controlling for confounds
- **Direct Correlation (Pearson r)** — simple bivariate r of indicator vs target
- **OLS Linear Regression** — R² contribution of adding indicator to model
- **Spearman Rank Correlation** — non-parametric rank-based correlation

Each tool stores: method name, formula, all parameters, which confounds were controlled, sample size, p-value if computed.

---

## Output Nodes (Comparison Targets)

These always exist as nodes in the Tactical Brain graph. Every indicator connects to at least one:

- **`views`** — log10(viewCount). Primary target. All experiments start here.
- **`keep`** — avgRetention (0–1). Keep rate.
- **`retention`** — avgPercentViewed (%). Slightly different from keep.

As the graph grows, indicators can connect to other indicator nodes (not just these three).

---

## Autonomous Candidate Generation (Hybrid Architecture)

The pipeline supports **hybrid autonomous discovery**:

### Phase 1: LLM Proposal (Upstream, Non-Deterministic)
- Claude CLI is invoked via `env -u ANTHROPIC_API_KEY claude --permission-mode bypassPermissions --print`
- The LLM receives current graph state, existing indicators, and top correlations
- It proposes novel candidate indicator keys following the valid pattern schema
- If the LLM call fails (timeout, bad output, etc.), the pipeline falls back gracefully to Phase 2

### Phase 2: Deterministic Template Generation
- `generate_autonomous_candidates()` produces all template-based keys:
  - `retention_pct_<N>` — retention at percentile N (1-99)
  - `retention_mean_<lo>_<hi>` — mean retention in a pct window
  - `retention_slope_<lo>_<hi>` — linear slope in a pct window
  - `retention_volatility_<lo>_<hi>` — std dev in a pct window
  - `views_log_days_<d0>_<d1>` — log10 views in a day window
  - `views_ratio_<name>_vs_<name>` — ratio of view windows
  - `<keyA>_x_<keyB>` — interaction (product) of two valid indicators

### Phase 3: Deterministic Pipeline Execution
Every step after candidate selection is fully deterministic:
Canonicalize → Validate → Quantify → Resolve → Dataset → Experiment → Result → Graph

### Canonicalization & Validation
All LLM-proposed keys are:
1. Lowercased and converted to snake_case
2. Validated against known patterns with range checks (e.g., pct 1-99, window lo < hi)
3. Rejected if not implementable by `extract_metric()`

### `autonomous_progress.json` (Live Progress Snapshot)
**Location:** `buildings/jarvis/autonomous_progress.json`

Updated continuously during an autonomous run. Represents the **current in-flight or last-finished** run state. The UI polls this file every 3 seconds for live progress.

Key fields: `active` (bool), `run_id`, `attempted`/`completed`/`failures`, `current_candidate`, `last_completed_candidate`, `last_completed_r`, `no_signal_streak`, `stop_reason`, `recent_events` (last 20 events with type, key, r value or failure reason).

When `active=true`, a run is in progress. When `active=false`, the file reflects the final state of the last run (with `finished_at` and `stop_reason` populated).

### `autonomous_runs.json` (Completed History Log)
**Location:** `buildings/jarvis/autonomous_runs.json`

Each entry records one completed autonomous run:
```json
{
  "id": "auto_20260409_153000",
  "started_at": "2026-04-09T15:30:00Z",
  "finished_at": "2026-04-09T15:35:42Z",
  "mode": "hybrid_auto",
  "llm_proposed": 25,
  "llm_completed": 12,
  "attempted": 30,
  "completed": 28,
  "failures": 2,
  "stop_reason": "max_iterations",
  "top_new_r_abs": 0.4231,
  "elapsed_minutes": 5.7,
  "total_indicators_after": 58
}
```

---

## Resolution System (Emergent)

Resolution describes WHERE in the video something is measured.

**Start:** R0 only = the entire video as one unit. One row per video.

**Future shelves** are created when an experiment measures something at a sub-video level:
- A 10-second window → new shelf if not seen before
- A specific percentile range → new shelf if not seen before
- A frame-level measurement → new shelf if not seen before

Shelves are NOT predefined. They emerge from experiments. Each shelf has:
- A label (e.g. "0–25% of video", "per second frame", "hook window 0–5s")
- A quantified boundary (start%, end% or absolute seconds)
- All indicator nodes that were measured at this resolution

---

## What Gets Stored Per Indicator (New Schema)

```json
{
  "key": "curve_entropy",
  "label": "Curve Entropy",
  "layer": "post",
  "resolution": { "id": "r0", "label": "Full Video", "description": "Entire video as one unit" },
  "depth": 1,
  "metric_definition": {
    "description": "Shannon entropy of the normalized retention curve",
    "formula": "H = -sum(p * log2(p)) where p = normalized retention values",
    "extraction_code": "compute_entropy(video.analytics.retentionCurve)"
  },
  "dataset": [
    { "ytId": "aE9jKLck_cI", "value": 3.42, "target_value": 8.455 },
    ...
  ],
  "experiment": {
    "id": "exp_001",
    "tool": "partial_correlation",
    "tool_version": "1.0",
    "parameters": { "confounds": ["keep"], "n": 370 },
    "r_partial": 0.48,
    "r_direct": null,
    "p_value": 0.003,
    "n_videos": 370,
    "target": "views"
  },
  "result": {
    "r_partial": 0.48,
    "r_direct": null,
    "status": "discovery",
    "conclusion": "Videos with information-rich retention curves (many peaks and valleys) outperform monotonically declining curves. Shannon entropy of +3.5 correlates with 2x more views."
  },
  "connections": ["views"]
}
```
