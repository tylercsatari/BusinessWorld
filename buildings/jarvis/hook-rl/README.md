# Hook-RL harness

Trains an LLM "hook director" (Qwen3-30B-A3B) to write 5-frame Shorts-hook specs whose
rendered montage embeds far along a supervised axis through the library embedding space.
Ran on a Lambda H100; the GPU box is ephemeral, so these scripts + R2 are the durable record.

## Pipeline
- `harness.py`   — core: FLUX render (Replicate) -> 5x1 montage -> Gemini embed (1536-D) ->
                   score = percentile position on the reward axis + kNN neighbors for the map.
- `fit_axis.py`  — fits the reward axis (PLS embedding->log10(views)); saves axis_views.joblib + R2.
- `gen_bigbank.py` / `gen_ideas_loop.py` — unbounded, content-signature-deduped idea generation.
- `build_ideabank_yt.py` — competitor ideas via the YouTube Data API (OAuth).
- `harvest.py`   — best-of-N harvest: Qwen drafts N specs -> render+score all -> keep top-k ->
                   stream montages+manifest to R2 (RUN/MODEL/IMG_BUDGET via env; unique-prompt dedup).
- `sft.py`       — QLoRA ReST: SFT the base on accumulated high-percentile winners (<=2/idea) ->
                   adapter to R2 hooks/models/lora_rN + a merged model.
- `overnight.sh` — deep loop: harvest -> SFT -> repeat until deadline / Replicate-dry, then terminate.
- `terminate.py` — self-terminate the Lambda instance (NOTE: had an API host/IP bug overnight; fix before reuse).
- `trend.py`     — per-phase median/p75/best percentile.

## Result (overnight run)
8 ReST rounds. Median percentile: base 39th -> ~45th plateau (reached round 3, flat-within-noise).
Idea bank ~57k unique premises, zero repeats. Adapters lora_r1..r8 + runs phase1..8 in R2.

## To reuse the trained model
base Qwen/Qwen3-30B-A3B + R2 adapter `hooks/models/lora_r8` (peft load or merge). r3..r8 equivalent.

## To beat the ~45th plateau
(1) cleaner reward axis (LDA max-separation of the >10M class, not PLS-on-log-views) + an
    in-distribution/density guard so "further right" can't be gamed off-manifold;
(2) DPO or GRPO instead of ReST-SFT;
(3) optionally anchor the axis to 5s-retention/keep-rate (causal, hook-controlled) vs the views axis.
