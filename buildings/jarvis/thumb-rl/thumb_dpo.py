"""DPO preference update for long-form THUMBNAILS. Where thumb_update.py (RAFT) only imitates the winning
sibling, DPO uses the LOSERS too: for each title it forms a (chosen=best, rejected=worst) pair from the 5
thumbnails generated for THAT title, and trains the policy to prefer the higher-scoring sibling over the
lower one. This teaches "for THIS input, what makes the better thumbnail" directly from within-input
contrast — the sharpest signal in the 5-per-title structure. Starts from the latest RAFT-merged model
(DPO_INIT) so it builds on those gains. Reads every attempt from the manifests (RAFT's thumb_data has
winners only). Env: THUMB_ROUND, DPO_INIT (model to start from), DPO_MINGAP (min reward gap for a pair)."""
import os, json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import DPOTrainer, DPOConfig
from datasets import Dataset
import harness_long as H

ROUND = os.environ.get("THUMB_ROUND", "d1")
MODELP = os.environ.get("DPO_INIT") or "/home/ubuntu/thumbrl/models/qwen3-30b-a3b"
OUT = "/home/ubuntu/thumbrl/models/thumb_r%s" % ROUND
MINGAP = float(os.environ.get("DPO_MINGAP", "0.12"))   # min reward gap so a pair is a CLEAR preference, not noise
# MUST match thumb_harvest.py's system prompt so the prompt formatting lines up with what generated the data
SYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
       "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
       '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
       "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token

# ── build (chosen, rejected) preference pairs: best vs worst thumbnail PER TITLE ──
groups = {}
for pf in glob.glob("/home/ubuntu/thumbrl/runs/thumb*/manifest.jsonl"):   # manifest has EVERY attempt (winners + losers)
    for l in open(pf):
        try:
            r = json.loads(l)
            if r.get("prompt") and r.get("input_id") is not None and r.get("reward") is not None:
                groups.setdefault(r["input_id"], []).append(r)
        except Exception: pass
def completion(r):
    think = ("<think>%s</think>\n" % r.get("reasoning", "")) if r.get("reasoning") else ""
    return think + json.dumps({"prompt": r["prompt"]}, ensure_ascii=False)
def prompt_text(title):
    return tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": title}],
                                   tokenize=False, add_generation_prompt=True)
pairs, seen = [], set()
for iid, atts in groups.items():
    atts = [a for a in atts if a.get("prompt")]
    if len(atts) < 2: continue
    atts.sort(key=lambda a: a["reward"])
    lo, hi = atts[0], atts[-1]
    if (hi["reward"] - lo["reward"]) < MINGAP: continue          # too close = no clear winner
    key = (hi.get("title", ""), hi["prompt"][:60], lo["prompt"][:60])
    if key in seen: continue
    seen.add(key)
    pairs.append({"prompt": prompt_text(hi.get("title", "")), "chosen": completion(hi), "rejected": completion(lo)})
print("THUMB DPO round %s on %d best-vs-worst-per-title pairs (gap>=%.2f) from %d titles" % (ROUND, len(pairs), MINGAP, len(groups)), flush=True)
if len(pairs) < 16:
    print("=== too few clear pairs (%d) — skipping DPO this round ===" % len(pairs), flush=True); raise SystemExit(0)
ds = Dataset.from_list(pairs)

print("loading %s (bf16)..." % os.path.basename(MODELP.rstrip("/")), flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, torch_dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = DPOConfig(output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                num_train_epochs=1, learning_rate=5e-6, bf16=True, logging_steps=10, save_strategy="no",
                beta=0.1, max_length=1536, max_prompt_length=400, report_to=[])
# peft_config → the frozen base (adapter disabled) is the implicit DPO reference, so no second model copy
trainer = DPOTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(OUT); tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f): H.s3.upload_file(f, H.BUCKET, "hooks/models/thumb_r%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload()
MERGED = "/home/ubuntu/thumbrl/models/thumbmerged_r%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True); tok.save_pretrained(MERGED)
print("=== THUMB_UPDATE_DONE round %s (DPO) -> merged %s ===" % (ROUND, MERGED), flush=True)
