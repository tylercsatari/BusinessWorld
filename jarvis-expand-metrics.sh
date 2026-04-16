#!/bin/bash
cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
claude --permission-mode bypassPermissions --print 'You are working on the Jarvis analytics research system in buildings/jarvis/jarvis-metrics.js.

## CONTEXT

This system runs phrase-matching correlations on YouTube video transcripts (~372 informal conversational videos) to find pre-upload signals that predict view performance. Transcripts are informal speech (not academic or data-heavy content).

## PROBLEM IDENTIFIED

Many Group T phrase families have ~0% coverage because the phrases are too formal/academic:

PROOF_ARRIVAL_PHRASES (around line 691):
- "here is the proof", "look at the numbers", "the data shows", "here are the results", "the analytics show"
- These hit 0 of 372 videos

But informal patterns DO have coverage:
- "early_proof" informal: "i tested", "i tried", "the result", "it actually", "it worked" hit 224/372 videos
- "social_proof": "million", "thousand", "viral", "subscribers", "views" hit 113/372 videos
- "look at this", "you can see", "right here" hit 110/372 videos

## YOUR TASK

In buildings/jarvis/jarvis-metrics.js, make these targeted changes:

### 1. Replace PROOF_ARRIVAL_PHRASES (around line 691)
Replace with conversational alternatives:
"look at this", "you can see", "right here", "see this", "watch this", "look how", "check this", "the result", "it worked", "it actually worked", "i tested", "i tried it", "here is what happened", "turns out", "it turns out", "and it actually", "this actually"

### 2. Add 3 NEW phrase const declarations after line ~730 (after CURIOSITY_ESCALATION_PHRASES or wherever Group U ends):

const EARLY_PROOF_PHRASES = [
    "i tested", "i tried", "i did this", "i spent", "i have been",
    "the result", "results were", "it worked", "it actually worked", "it does work",
    "it actually", "it really does", "this works", "and it worked",
    "after doing this", "after trying", "my experience", "what happened was",
    "what actually happened", "here is what happened",
];

const SOCIAL_PROOF_PHRASES = [
    "million", "thousand", "hundreds", "millions of", "thousands of",
    "viral", "went viral", "everyone", "people are saying", "everyone knows",
    "subscribers", "views", "comments", "likes", "my audience",
    "they told me", "people said", "the comments",
];

const PRE_UPLOAD_CREDIBILITY_PHRASES = [
    "i am", "i have", "i know", "trust me", "believe me", "i promise",
    "i can tell you", "from experience", "in my experience", "speaking from",
    "i have done this", "i have tried", "i have tested", "i know what",
    "let me show you", "let me tell you", "i will show you", "i will tell you",
    "here is the thing", "here is what", "the thing is",
];

### 3. Add these new families to the _gtFamilies object (around line 3930 where "proof_arrival": PROOF_ARRIVAL_PHRASES appears):
"early_proof": EARLY_PROOF_PHRASES,
"social_proof": SOCIAL_PROOF_PHRASES,
"pre_upload_credibility": PRE_UPLOAD_CREDIBILITY_PHRASES,

### 4. Add new indicator keys to INDICATOR_REGISTRY arrays

Find the section around lines 1252-1280 that lists "proof_arrival_count", "proof_arrival_density" etc. and add adjacent entries for the new families:
"early_proof_count", "early_proof_density", "early_proof_count_hook", "early_proof_front_load_ratio", "early_proof_count_first_half", "early_proof_position_pct",
"social_proof_count", "social_proof_density", "social_proof_count_hook", "social_proof_front_load_ratio",
"pre_upload_credibility_count", "pre_upload_credibility_density", "pre_upload_credibility_count_hook", "pre_upload_credibility_front_load_ratio", "pre_upload_credibility_position_pct",

### 5. Also add to PREUPLOAD_INDICATORS near line 4613 where "proof_arrival_count" appears - same keys as above.

### 6. After making all changes, attempt to rebuild the candidate queue:
node buildings/jarvis/rebuild-candidate-queue.js

If that fails with an error, just note it and continue.

### 7. Commit:
git add buildings/jarvis/jarvis-metrics.js
git add -f buildings/jarvis/candidate_queue.json 2>/dev/null || git add buildings/jarvis/candidate_queue.json
git commit -m "Expand Jarvis metrics: Group V (early_proof/social_proof/pre_upload_credibility) + fix zero-coverage PROOF_ARRIVAL phrases for informal transcripts"

### 8. Notify when done:
openclaw system event --text "Done: Jarvis Group V metrics added, PROOF_ARRIVAL phrases fixed for informal transcripts" --mode now

## CONSTRAINTS
- Do NOT modify jarvis-runner.js, sync-to-r2.js, server.js, or any other files
- Do NOT run npm install
- Preserve all existing metrics - only ADD new families and REPLACE phrase arrays
- Keep changes surgical - primarily jarvis-metrics.js and candidate_queue.json
'
