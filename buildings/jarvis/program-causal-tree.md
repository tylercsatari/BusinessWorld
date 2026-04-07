# AutoResearch Loop C — Causal Tree Construction

**Goal: Map the causal dependency tree from pre-upload controllable decisions → views.**

The question is not "what correlates with views?" but "what can Tyler control before shooting that causes the metrics that cause views?"

## The Tree Structure

```
GOAL: 100M+ Views
│
├── Swipe Rate (keep) — % who stay after seeing first frame
│   ├── Visual Hook Quality → R4 signals (first frame)
│   │   ├── hook_clarity (subject immediately obvious)
│   │   ├── visual_surprise (unexpected/impossible)
│   │   ├── action_intensity (motion/impact in frame)
│   │   └── scale_factor (dramatic subject size)
│   ├── Zeigarnik Effect → R3 signals
│   │   ├── vz_score (visual open loop strength)
│   │   └── vz_type (A/B/C/D/E mechanism)
│   └── Concept Type → R0/R1 signals
│       ├── pat_making_v2 (build/creation content)
│       └── cat_superhero (superhero build category)
│
├── Retention — % watched through video
│   ├── Pacing → R2 signals (second-by-second)
│   │   ├── deriv_entropy (varied rate of change)
│   │   ├── max_cliff (dramatic narrative turn)
│   │   └── segment_duration_cv (uneven segment lengths)
│   ├── Narrative Structure → R1 signals
│   │   ├── hook → conflict → escalation → payoff arc
│   │   ├── callback_count (does ending refer back to hook?)
│   │   └── tension_release_pattern (alternating intensity)
│   ├── Visual × Timestamp Mapping → R2/R4 intersection
│   │   └── [PLANNED] specific visual tactic at second X → retention delta seconds X to X+5
│   └── Audio × Timestamp → R5 signals
│       └── [PLANNED] music drop, silence, voice change at second X → retention effect
│
└── Shares — who spreads the video
    ├── Emotional Resonance → R0/R1 signals
    ├── Universality → R0 signals
    └── Surprise Intensity → R3 signals

```

## Your Mission

Work down this tree. For each leaf node that doesn't yet have a measured signal:

1. Propose a measurement method
2. Score on the 203-video dataset
3. Compute correlation with the parent metric (not views directly)
4. Log in results.tsv

This is DIFFERENT from other loops — you're measuring against intermediate metrics (keep, retention) not against views. The causal chain is:
controllable_signal → keep/retention/shares → views

## Key constraint: pre-upload only

A signal is only useful if it can be measured or predicted BEFORE posting.

PRE-UPLOAD (valid):
- First frame visual properties
- Transcript content and structure
- Narrative arc
- Concept category
- Duration choice
- Hook mechanism

POST-UPLOAD (invalid for pre-upload prediction, valid for understanding mechanism):
- Actual keep rate
- Actual day3Growth
- View trajectory

## Priority order for new signals

1. **Retention curve normalized to baseline** — subtract the average decay curve from all videos to find the "above baseline" retention at each second. Correlate per-second above-baseline with: what visual/audio/conceptual event is happening at that second?

2. **Visual tactic × second correlation** — for each video, align frame timestamps with retention curve dips/peaks. When there's a retention GAIN at second X, what does the frame at second X look like (LLM vision)?

3. **Segment concept quality** — using the transcript, label each 10-second segment with its conceptual function (hook, conflict intro, escalation, reveal, payoff). Does the label predict the local retention at that segment?

4. **Connector word density** — "so", "but", "however", "wait", "actually" = forward-momentum words. Count per 100 words. Correlate with retention.

5. **Callback detection** — does the transcript mention the hook concept again in the final 20%? Binary. Does it correlate with end-retention?

## Output format (same results.tsv)

```
loop_c_[n]  discovery:[signal_name]  parent_metric  r_vs_parent  r_partial  discovery  n_videos  notes
```

Log AGAINST PARENT METRIC (keep or retention or shares), not views.

## Never stop

After building the causal tree signals, build the TREE ITSELF as a data structure:
- Parent: views
- Children: keep (r=0.43), retention (r=0.32), shares (r=0.22)
- Grandchildren: per above tree

Save tree as /buildings/jarvis/causal-tree.json for the Jarvis UI to visualize.
