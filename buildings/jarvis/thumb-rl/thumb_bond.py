"""BOND-style best-of-N distillation (arXiv 2407.14622): train the policy to DIRECTLY emit its
best-of-N-quality prompt. Training set = every banked title's BEST rendered attempt (we already paid for
5-6 real scores per title across ~8k titles — the sunk render cost IS the dataset). Targets are
PROMPT-ONLY in Qwen3 no-think format: ~150 tokens/target instead of ~1150, so 100% of the gradient lands
on tokens that determine the reward (fixes the CoT dilution that made DPO flat; cf. SparsePO/TPO).
Env: BOND_ROUND (default b1), MIN_N (>=4 attempts), MIN_PCT (winner must be >=0.70 percentile)."""
import os, json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from datasets import Dataset
import harness_long as H

ROUND = os.environ.get("BOND_ROUND", "b1")
MIN_N = int(os.environ.get("MIN_N", "4"))
MIN_PCT = float(os.environ.get("MIN_PCT", "0.70"))
MODELP = "/home/ubuntu/thumbrl/models/qwen3-30b-a3b"
OUT = "/home/ubuntu/thumbrl/models/thumb_%s" % ROUND
SYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
       "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
       '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
       "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token

groups = {}
for pf in glob.glob("/home/ubuntu/thumbrl/runs/thumb*/manifest.jsonl"):
    for l in open(pf):
        try:
            r = json.loads(l)
            if r.get("prompt") and r.get("pctile") is not None and r.get("title"):
                groups.setdefault(r["input_id"] + "|" + r["title"][:40], []).append(r)
        except Exception: pass
rows, skipped_small, skipped_weak = [], 0, 0
for k, atts in groups.items():
    if len(atts) < MIN_N: skipped_small += 1; continue
    best = max(atts, key=lambda a: a["pctile"])
    if best["pctile"] < MIN_PCT: skipped_weak += 1; continue   # only distill genuinely good winners
    rows.append({"title": best["title"], "prompt": best["prompt"], "pctile": best["pctile"]})
print("BOND %s: %d winners (>=%d attempts, best>=%.0fth) · skipped %d small groups, %d weak winners"
      % (ROUND, len(rows), MIN_N, MIN_PCT * 100, skipped_small, skipped_weak), flush=True)
assert len(rows) >= 500, "too few winners to distill"

# Qwen3 no-think target: empty think block + JSON — matches enable_thinking=False generation EXACTLY
def fmt(r):
    target = "<think>\n\n</think>\n\n" + json.dumps({"prompt": r["prompt"]}, ensure_ascii=False)
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": r["title"]},
            {"role": "assistant", "content": target}]
    return {"text": tok.apply_chat_template(msgs, tokenize=False)}
ds = Dataset.from_list([fmt(r) for r in rows])

print("loading base bf16...", flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, torch_dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = SFTConfig(output_dir=OUT, per_device_train_batch_size=2, gradient_accumulation_steps=8,
                num_train_epochs=int(os.environ.get("EPOCHS","2")), learning_rate=1e-5, bf16=True, logging_steps=20, save_strategy="no",
                max_length=700, report_to=[])   # targets are short — big batches, fast steps
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(OUT); tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f): H.s3.upload_file(f, H.BUCKET, "hooks/models/thumb_%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload()
MERGED = "/home/ubuntu/thumbrl/models/thumbmerged_%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True); tok.save_pretrained(MERGED)
print("=== THUMB_UPDATE_DONE round %s (BOND) -> merged %s ===" % (ROUND, MERGED), flush=True)
