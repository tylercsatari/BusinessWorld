# PHASE 2 PLAN (written 2026-07-08 ~04:30, executing overnight — user asleep, full autonomy granted)

## User directive (verbatim intent)
1. Elite round (b13 + round-14 verdict) is the LAST thumbnail phase. Wrap the thumbnail model completely.
2. Build the thumbnail experience into BusinessWorld → Long Quant, modeled on the shorts Experiment:
   - 🧪 Experiment section: type an idea/title → choose # outputs → trained model generates thumbnails →
     rendered + scored → save-able. Also: score an UPLOADED thumbnail (embeds → ctrviews percentile;
     optional title text → relevance).
3. Then IMMEDIATELY switch the GPU box to training the IDEA MODEL (long-form), like the shorts idea model:
   - Model invents long-form video ideas; quantifiable score = TEXT-embedding axis (title→views/CTR);
   - anti-overfit: embedding-distance novelty gate vs all accepted ideas (semantic dedup);
   - ALL generated ideas stored in guesses; ideas ≥80th percentile ALSO surfaced in the Experiments tab.
4. Morning goal: thumbnail model wrapped + built into BusinessWorld; idea model training with solid progress.

## Execution stages
- [x] S0 This plan + memory update.
- [ ] S1 Assets: text-side idea scorer (longform/idea-rl/scorer_text.{npz,json}) = PLS raw-long/text →
      log-views percentile ladder; export scorer_visual.json (blend+ladder as JSON) for Node scoring.
- [ ] S2 UI+server build (delegated to subagent): Long Quant 🧪 Experiment section + 💡 Ideas section,
      routes /api/longquant/exp/{generate,status,score-upload}, /api/longquant/thumbs/{save,list,delete},
      /api/longquant/ideas/*. Generation uses the existing request queue (longform/guesses/requests/,
      count param) — served whenever a thumb-model process polls; UI says "queued" when unserved.
- [ ] S3 Idea pipeline scripts (idea-rl/): idea_train_long.py (gen G ideas no-input → text-embed → score
      percentile + novelty=1−max cos vs accepted bank → accept score≥FLOOR & nov≥NOV → RAFT SFT rounds),
      launcher, loud-fail + status → longform/idea-rl/status.json, guesses → longform/ideas/<run>/.
- [ ] S4 Thumbnail wrap on round-14 verdict (monitor notifies): pick winner (b13 vs b10 by round-14 avg),
      record FINAL model in memory + status; adapters already on R2 hooks/models/.
- [ ] S5 Switchover: stop thumb loop on the box; scp idea-rl; launch idea training (tmux). Thumb DEMO
      serving pauses during idea era (request queue holds; revisit hosting via Replicate cog later).

## Key facts for whoever resumes
- Box: H100 SXM5 us-southeast-1, IP in thumb-rl/box_ip_fast.txt, ssh ~/.ssh/id_ed25519, ALL work in tmux.
- Thumbnail curve: base 68.5 → b1 70.9 → b10 72.5 (plateau ~72 with ≥70th winners) → elite ≥78th bar in flight.
- Thumb recipe (proven): no-think BOND, 2 epochs, G=6 render-all, gate + length audit (memory: thumb-rl-training).
- Idea score axis: raw-long/text embeddings → log-views (held-out r≈0.59 from steering data); own-channel
  CTR joins later. Novelty floor start 0.22 (shorts used 0.22), score floor start 0.70 → curriculum up.
- Replicate topped up by user; Gemini healthy. Idea training uses NO renders (text only: gen+embed) — cheap.
