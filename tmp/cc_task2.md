Work in /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/

## DIAGNOSTIC TASK: Check why zygarnik count metrics have zero candidates

Run this first to understand what's happening with phrase match coverage:

```js
// tmp/check_phrase_coverage.js
const { computeIndicator } = require('./buildings/jarvis/jarvis-metrics.js');
const indicators = require('./buildings/jarvis/indicators.json');
const videos = Object.values(indicators);

const metrics = ['delayed_gratification_count','story_stake_count','hook_unresolved_density',
  'title_curiosity_gap_flag','delayed_gratification_peak_position_pct'];

for (const m of metrics) {
  const vals = videos.map(v => {
    try { const r = computeIndicator(m, v); return r && r[0] != null ? r[0] : null; }
    catch(e) { return null; }
  }).filter(v => v != null);
  const nonzero = vals.filter(v => v !== 0);
  console.log(`${m}: total=${vals.length} nonzero=${nonzero.length} mean=${nonzero.length ? (nonzero.reduce((a,b)=>a+b,0)/nonzero.length).toFixed(3) : 'N/A'}`);
}
```

Save this to tmp/check_phrase_coverage.js and run: node tmp/check_phrase_coverage.js

## FIX: Broaden phrase sets for sparse metrics

In jarvis-metrics.js, find the ZYGARNIK_PHRASE_SETS object. The `delayed_gratification` and `story_stake` phrase arrays may be too specific to match frequently. 

Expand them:

For `delayed_gratification` - add common YouTube phrases that signal withholding payoff:
Add: 'but first', 'wait for it', 'in a moment', 'before that', 'not yet', 'almost', 'soon', 'more on that later', 'we will get to', 'i will show you', 'hold that thought', 'remember this', 'keep that in mind'

For `story_stake` - add more common high-stakes signifiers:
Add: 'i had to', 'i needed to', 'had to figure out', 'or i would', 'changed everything', 'turned everything around', 'biggest risk', 'scary moment', 'nerve-wracking', 'was terrified', 'bet everything', 'could not afford to fail', 'what was at stake'

After adding phrases, rerun the coverage check to confirm nonzero count increases above 20 for both metrics.

## ADD: 3 new high-priority metrics

Add these 3 new metrics to the computeIndicator function in jarvis-metrics.js, following the existing pattern (look at how `hook_unresolved_density` is implemented as a model):

1. `zygarnik_completion_ratio` (pre layer):
   - loops_closed = count of closure phrase matches in full transcript
   - loops_opened = count of open_loop phrase matches in full transcript  
   - return [loops_closed / Math.max(loops_opened, 1), null]
   - Register in STATIC_KEYS with STATIC_LAYER = 'pre'
   - Add to ZYGARNIK_SPECIAL_KEYS array

2. `stakes_in_hook_flag` (pre layer):
   - Check first 10% of transcript for story_stake OR any of: 'on the line', 'last chance', 'must', 'need to', 'have to', 'or else', 'if i don', 'cost me'
   - return [1, null] if found, [0, null] if not
   - Register in STATIC_KEYS with STATIC_LAYER = 'pre'
   - Add to ZYGARNIK_SPECIAL_KEYS array

3. `payoff_before_midpoint_flag` (pre layer):
   - Find position of first payoff phrase in transcript: use ZYGARNIK_PHRASE_SETS.closure + ['result', 'proof', 'here it is', 'the answer', 'and it worked', 'look at this']
   - If payoff found before 50% of total words, return [1, null], else [0, null]
   - Register in STATIC_KEYS with STATIC_LAYER = 'pre'
   - Add to ZYGARNIK_SPECIAL_KEYS array

## WAIT for active run to complete, then rebuild queue

Check if autorun is still running:
  tail -3 buildings/jarvis/watch-sync.log

Wait until you see "watch-and-sync complete" before running:
  node buildings/jarvis/rebuild-candidate-queue.js

## COMMIT AND PUSH

  cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
  git add buildings/jarvis/jarvis-metrics.js buildings/jarvis/candidate_queue.json
  git add tmp/check_phrase_coverage.js
  git commit -m "Expand zygarnik phrases + add zygarnik_completion_ratio/stakes_in_hook_flag/payoff_before_midpoint_flag metrics, rebuild queue"
  git push

When done: openclaw system event --text "Done: zygarnik phrase expansion + 3 new metrics, queue rebuilt and pushed" --mode now
