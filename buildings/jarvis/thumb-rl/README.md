# Thumbnail-RL harness (long-form)

Trains an LLM "thumbnail director" (Qwen3-30B-A3B + LoRA) to write a single photographic thumbnail
prompt whose rendered 16:9 image embeds high on the **ctrviews** (CTR+views joint) axis through the
long-form thumbnail embedding space — while staying on-title. ReST/RAFT: best-of-G (G=5) per title ->
SFT-on-winners -> repeat. Runs on an ephemeral Lambda GPU; these scripts + R2 are the durable record.

## Pipeline
- `harness_long.py`  — core: FLUX-schnell render (Replicate, 16:9) -> Gemini embed (1536-D) -> score =
                       percentile on the frozen ctrviews `blend` direction (scorer_visual.npz), + nn_cos
                       density guard + kNN map neighbors for the Guesses map.
- `relevance.py`     — label-free leash: caption the thumbnail (gemini-3.5-flash), embed, cosine vs the
                       TITLE; `gated_reward = pctile − rel_pen − density_pen` (REL_FLOOR 0.35).
- `thumb_harvest.py` — per-title group: reason -> 1 prompt x G=5, render+score all, per-title advantage,
                       stream thumbnails+manifest+groups to R2 `longform/guesses/<run>/`, write winners.
- `thumb_update.py`  — LoRA-SFT the base on advantage>=0.05 winners (target = <think>+JSON{prompt}) ->
                       adapter to R2 `hooks/models/thumb_r<N>/` + a merged model.
- `thumb_overnight.sh` — deep loop: harvest -> update -> repeat until 11h / 2 dry rounds. Round1 from BASE.
- `launch_long.sh` / `setup_box_long.sh` / `terminate_long.py` — GPU lifecycle.

## Prerequisites (built off-box by build_thumb_assets.py, already on R2)
- `longform/thumb-rl/scorer_visual.npz`  — blend[1536] + ladder + p90 (the frozen reward)
- `longform/thumb-rl/titles.jsonl`       — diverse real long-form titles (one {"title":...}/line)
- `raw-long/visual/embeddings.npz`       — real-thumbnail manifold (density guard + map neighbors)
- `raw-long/visual/map.json`             — pulled at runtime for Guesses-map neighbor x/y

## Launch → provision → run → monitor → terminate
```bash
cd buildings/jarvis/thumb-rl
printf '%s' "$LAMBDA_API_KEY" > lambda_key.txt          # your Lambda key (gitignored)
bash launch_long.sh                                     # polls until a GPU lands -> instance_id.txt
IP=$(curl -s -H "Authorization: Bearer $(cat lambda_key.txt)" \
     https://cloud.lambda.ai/api/v1/instances/$(cat instance_id.txt) \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['ip'])")
SSH="ssh -o StrictHostKeyChecking=no -i ~/.ssh/quant_training_key ubuntu@$IP"
$SSH 'mkdir -p /home/ubuntu/thumbrl'
scp -i ~/.ssh/quant_training_key harness_long.py relevance.py thumb_harvest.py thumb_update.py \
    thumb_overnight.sh setup_box_long.sh ubuntu@$IP:/home/ubuntu/thumbrl/
scp -i ~/.ssh/quant_training_key ../../../.env ubuntu@$IP:/home/ubuntu/thumbrl/.env   # keys for R2/Gemini/Replicate
$SSH 'cd /home/ubuntu/thumbrl && bash setup_box_long.sh 2>&1 | tail -5'               # ~15-25 min (model dl)
$SSH 'cd /home/ubuntu/thumbrl && nohup bash thumb_overnight.sh > overnight.log 2>&1 &'
# monitor:
$SSH 'tail -f /home/ubuntu/thumbrl/overnight.log'      # look for "imgs=N $X.XX" spend + best_pct
# durable progress is in R2 longform/guesses/<run>/index.jsonl and the 🎰 Guesses tab.
# stop when done (STOPS BILLING):
scp -i ~/.ssh/quant_training_key terminate_long.py ubuntu@$IP:/home/ubuntu/thumbrl/  # (or run locally with instance_id.txt+lambda_key.txt)
python3 terminate_long.py
```

## Budget
$0.003/img flux-schnell. Round1 3000 imgs (validate) then ~10000/round; ~50000 total ≈ **$150 Replicate**
over ~11h. Gemini embed+caption ≈ $20, Lambda GH200 ≈ $18 — both on separate billing.

## Reuse the trained model (production)
base Qwen/Qwen3-30B-A3B + R2 adapter `hooks/models/thumb_r<N>` (peft load or merge). Serve like idea_r7
(Cog+vLLM on Replicate), swap render to flux-2-pro for final thumbnails.
