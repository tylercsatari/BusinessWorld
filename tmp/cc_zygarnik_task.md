You are working on the Jarvis autonomous research engine in buildings/jarvis/. A live autorun may be running — check `tail -10 buildings/jarvis/watch-sync.log` before touching any data files. Do NOT modify candidate_queue.json, derived_experiments.json, experiments_log.json, graph.json, or autonomous_progress.json while an autorun is active.

## CONTEXT
- jarvis-metrics.js: defines all metric computations for each video
- rebuild-candidate-queue.js: rebuilds the candidate queue after metrics are updated
- The runner picks candidates from candidate_queue.json using 70% pre-upload bias

## TASK 1: Fix early_proof_position_pct null in post-layer
The runner logs show "processIndicator returned null" for ALL experiments where early_proof_position_pct is crossed with post-layer metrics. This wastes 430+ candidate slots.
- Find the early_proof_position_pct implementation in jarvis-metrics.js
- Understand WHY it returns null for post-layer
- Either fix it so it works for post-layer, OR mark it as pre-only so the candidate generator never pairs it with post-layer metrics
- Check rebuild-candidate-queue.js for a pre-only exclusion mechanism

## TASK 2: Fix 7 untested zygarnik metric keys
These keys appear in ZYGARNIK_SPECIAL_KEYS in jarvis-metrics.js but have ZERO experiments:
- gratification_delay_word_idx
- hook_unresolved_density
- title_curiosity_gap_flag
- open_loop_before_first_third_flag
- delayed_gratification_count
- story_stake_count
- delayed_gratification_peak_position_pct

For each: verify it has a working implementation. If missing or broken, implement it. These should return numeric values from transcript/video analysis data.

## TASK 3: Add new zygarnik metric families to jarvis-metrics.js

Add NEW metrics that have NOT been tested yet. Follow the existing code patterns (look at how hook_open_loop_density is implemented as a model).

**A. Setup-to-Payoff Gap metrics:**
- setup_payoff_gap_s: seconds between final setup mention and first payoff/proof mention
- setup_payoff_gap_pct: above normalized to video length
- payoff_before_midpoint_flag: 1 if main payoff appears before 50% of video
- front_loaded_payoff_ratio: fraction of payoffs in first half vs total

**B. Story-Stake proxy metrics:**
- explicit_stakes_count: count of phrases establishing consequences ("if you don't", "or else", "the problem is", "what happens when")
- stakes_in_hook_flag: 1 if stakes are established in first 10% of video
- stakes_urgency_density: count of urgency phrases (deadline, limited, now, today, before) / total words

**C. Visual Credibility timing metrics:**
- credential_mention_position_pct: position of first credential mention as % of video
- social_proof_front_density: social proof phrase density in first 25% of video

**D. Zygarnik completion gap:**
- zygarnik_completion_ratio: loops closed / loops opened (0 = all open, 1 = all closed)
- completion_gap_pct: 1 - zygarnik_completion_ratio
- open_loop_peak_position_pct: position of maximum open loop density in video

## TASK 4: Rebuild candidate queue (WAIT for run to finish first)
After implementing the fixes and new metrics, check if the run is still active:
```
tail -5 buildings/jarvis/watch-sync.log
```
Wait until you see "watch-and-sync complete" before running:
```
node buildings/jarvis/rebuild-candidate-queue.js
```

## TASK 5: Commit and push
After all changes:
```
cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
git add buildings/jarvis/jarvis-metrics.js buildings/jarvis/rebuild-candidate-queue.js buildings/jarvis/candidate_queue.json
git commit -m "Expand zygarnik metric families: fix early_proof_position_pct post-layer, add setup-payoff/story-stake/visual-credibility/completion-gap metrics, rebuild queue"
git push
```

## RULES
1. Do NOT modify data files (candidate_queue.json, derived_experiments.json, etc.) while autorun is active
2. Focus on pre-upload layer metrics
3. Follow existing code patterns exactly
4. If rebuild-candidate-queue.js takes more than 5 minutes, something is wrong — check it

When completely finished, run:
openclaw system event --text "Done: Zygarnik metric expansion complete — fixed early_proof_position_pct, added setup-payoff/story-stake/completion-gap families, rebuilt queue" --mode now
