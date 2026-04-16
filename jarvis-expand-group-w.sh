#!/bin/bash
cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
claude --permission-mode bypassPermissions --print '
You are working on the Jarvis AutoResearch system in buildings/jarvis/.

## Situation
The autorun has stalled: last run had 200 failures, 0 completions. Root causes:

1. visual_proof_phrase_count/density cross-metrics (416 queue entries) all fail — they are in candidate_queue.json but NOT in INTERACTION_BASES, so processIndicator returns null.
2. emotional_peak_position_pct and revelation_pace_score are standalone queue entries that always fail (sparse coverage).
3. generateAutonomousCandidates() pool is nearly exhausted (only 13 unrun auto-candidates remain).

## Tasks

### Task 1: Add high-signal Group P metrics to INTERACTION_BASES

In buildings/jarvis/jarvis-metrics.js, append these to the INTERACTION_BASES array (all have n=370):
- visual_proof_phrase_count (r=0.148)
- visual_proof_phrase_density (r=0.097)
- zygarnik_score (r=0.099)
- zygarnik_buildup_ratio (r=0.092)
- unresolved_loop_count (r=0.147)
- pre_proof_tension_score (r=0.137)
- credential_signal_count (r=0.144)
- credential_signal_density (r=0.103)
- closure_gap_pct (r=-0.119)
- micro_reward_density (r=0.075)
- information_drip_ratio (r=0.090)

Add them near the end of INTERACTION_BASES, just before the closing ]; with comment "// Group P bases (full coverage, n=370)".

### Task 2: Add new Group W metric families

In buildings/jarvis/jarvis-metrics.js:

a) Add these to STATIC_KEYS and set STATIC_LAYER[key] = "pre" for each (find the section near "Group P" or "Group H" setup blocks that add to STATIC_KEYS and STATIC_LAYER):

Group W1 — Zygarnik tension gradient:
- zygarnik_gradient_pct
- zygarnik_front_load_ratio
- loop_to_closure_gap_s

Group W2 — Reference-to-gratification timing:
- ref_to_gratification_gap_pct
- gratification_density_first_quarter
- pre_payoff_tension_index

Group W3 — Early proof vs closure:
- early_proof_to_loop_ratio
- proof_arrival_delay_proxy
- closure_to_open_ratio_first10s

Group W4 — Visual credibility setup-to-payoff:
- credibility_setup_pct
- proof_density_hook
- visual_credibility_density_hook

Group W5 — Story-stake proxies:
- stakes_to_loop_ratio
- stake_loop_product
- consequence_front_weight

b) In processIndicator, add computation cases for each Group W key. Find where other custom metrics are computed (look for "if (key === ..." patterns). Add:

```javascript
// ── Group W: Zygarnik gradient / ref-to-gratification / proof-closure / credibility / story-stake ──
if (key === "zygarnik_gradient_pct") {
    const olFull = getVideoScalar(video, "open_loop_count") || 0;
    const ol20 = getVideoScalar(video, "open_loop_count_first20s") || 0;
    const ol5 = getVideoScalar(video, "open_loop_count_first5s") || 0;
    return Math.max(0, ol20 - ol5) / Math.max(olFull, 1);
}
if (key === "zygarnik_front_load_ratio") {
    const olFull = getVideoScalar(video, "open_loop_count") || 0;
    const ol10 = getVideoScalar(video, "open_loop_count_first10s") || 0;
    return ol10 / Math.max(olFull, 1);
}
if (key === "loop_to_closure_gap_s") {
    const dur = getVideoScalar(video, "duration_s") || 60;
    const cl5 = getVideoScalar(video, "closure_count_first5s") || 0;
    const ol5 = getVideoScalar(video, "open_loop_count_first5s") || 0;
    return cl5 > 0 ? 0 : dur * Math.min(ol5 / Math.max(ol5, 1), 1);
}
if (key === "ref_to_gratification_gap_pct") {
    const olQ1 = getVideoScalar(video, "open_loop_density_first_quarter") || 0;
    const cbDensity = getVideoScalar(video, "reference_callback_density") || 0;
    return olQ1 / Math.max(cbDensity, 0.001);
}
if (key === "gratification_density_first_quarter") {
    const mrd = getVideoScalar(video, "micro_reward_density") || 0;
    const sdp = getVideoScalar(video, "setup_duration_pct") || 0;
    return mrd * sdp;
}
if (key === "pre_payoff_tension_index") {
    const zs = getVideoScalar(video, "zygarnik_score") || 0;
    const sdp = getVideoScalar(video, "setup_duration_pct") || 0;
    return zs * (1 - sdp);
}
if (key === "early_proof_to_loop_ratio") {
    const vp10 = getVideoScalar(video, "visual_proof_phrase_count_first10s") || 0;
    const ol10 = getVideoScalar(video, "open_loop_count_first10s") || 0;
    return vp10 / Math.max(ol10, 1);
}
if (key === "proof_arrival_delay_proxy") {
    const vp10 = getVideoScalar(video, "visual_proof_phrase_count_first10s") || 0;
    const vpFull = getVideoScalar(video, "visual_proof_phrase_count") || 0;
    return 1 - (vp10 / Math.max(vpFull, 1));
}
if (key === "closure_to_open_ratio_first10s") {
    const cl10 = getVideoScalar(video, "closure_count_first10s") || 0;
    const ol10 = getVideoScalar(video, "open_loop_count_first10s") || 0;
    return cl10 / Math.max(ol10, 1);
}
if (key === "credibility_setup_pct") {
    const cs10 = getVideoScalar(video, "credential_signal_count_first10s") || 0;
    const csFull = getVideoScalar(video, "credential_signal_count") || 0;
    return cs10 / Math.max(csFull, 1);
}
if (key === "proof_density_hook") {
    const vp5 = getVideoScalar(video, "visual_proof_phrase_count_first5s") || 0;
    return vp5 / 5.0;
}
if (key === "visual_credibility_density_hook") {
    const cs5 = getVideoScalar(video, "credential_signal_count_first5s") || 0;
    return cs5 / 5.0;
}
if (key === "stakes_to_loop_ratio") {
    const sh = getVideoScalar(video, "stakes_density_hook") || 0;
    const ol5 = getVideoScalar(video, "open_loop_density_first5s") || 0;
    return sh / Math.max(ol5, 0.001);
}
if (key === "stake_loop_product") {
    const psd = getVideoScalar(video, "personal_stake_density") || 0;
    const old = getVideoScalar(video, "open_loop_density") || 0;
    return psd * old;
}
if (key === "consequence_front_weight") {
    const cdH = getVideoScalar(video, "consequence_density_first_half") || 0;
    const cdFull = getVideoScalar(video, "consequence_density") || 0;
    return cdH / Math.max(cdFull, 0.001);
}
```

c) Add Group W bases to INTERACTION_BASES with comment "// Group W bases (zygarnik-gradient/proof-closure/credibility/story-stake)":
- zygarnik_gradient_pct
- zygarnik_front_load_ratio
- loop_to_closure_gap_s
- ref_to_gratification_gap_pct
- pre_payoff_tension_index
- early_proof_to_loop_ratio
- proof_arrival_delay_proxy
- closure_to_open_ratio_first10s
- credibility_setup_pct
- proof_density_hook
- stakes_to_loop_ratio
- stake_loop_product

### Task 3: Update rebuild-candidate-queue.js

Open buildings/jarvis/rebuild-candidate-queue.js and add the Group W atomic keys to the baseAtomics array (near the end, after existing Group P/Q entries):
- All 15 Group W keys listed in Task 2a

Also verify the EXCLUDED set in rebuild-candidate-queue.js includes: emotional_peak_position_pct and revelation_pace_score. If not, add them.

### Task 4: Run rebuild

node buildings/jarvis/rebuild-candidate-queue.js

Check output for queue size — expect >15000 entries.

### Task 5: Commit

git add -A && git commit -m "Expand Jarvis metrics: Group W (zygarnik-gradient/ref-to-gratification/early-proof-closure/visual-credibility/story-stake) + Group P bases in INTERACTION_BASES + rebuild candidate queue"

### Task 6: Push

git push

### Task 7: Sync to R2

node sync-jarvis-to-r2.js

### Task 8: Launch autorun

node buildings/jarvis/launch-autorun.js

The first run output should show: "Candidate pool: XXXX unrun" with a large number and should NOT immediately fail.

### Task 9: Notify

When completely finished, run:
openclaw system event --text "Jarvis Group W expansion complete: pool rebuilt, autorun relaunched" --mode now

## Key constraints:
- Use defensive math (divide by Math.max(x, 1) or Math.max(x, 0.001) to avoid NaN/Inf)
- Group W processIndicator cases return a NUMBER (0 if missing data), never null — this is critical so cross-metrics work
- Do not remove existing metrics — only add new ones
- The processIndicator function computes values per-video (for a single video object), not across the whole dataset
'
