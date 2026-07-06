"""GRPO/RAFT update: LoRA-SFT the policy on the positive-advantage thumbnail attempts (reasoning +
prompt) from thumb_data.jsonl. Each example's prompt is the video TITLE; the target completion is the
winning attempt's <think> reasoning + JSON {"prompt": ...} — so the model learns to REASON toward the
within-title winners (advantage = reward - per-title mean, label-free). Env: THUMB_ROUND."""
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from datasets import Dataset
import harness_long as H

MODELP = "/home/ubuntu/thumbrl/models/qwen3-30b-a3b"
ROUND = os.environ.get("THUMB_ROUND", "1")
OUT = "/home/ubuntu/thumbrl/models/thumb_r%s" % ROUND
SYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
       "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
       '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
       "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token

rows = []
for pf in glob.glob("/home/ubuntu/thumbrl/runs/thumb*/thumb_data.jsonl"):
    for l in open(pf):
        try:
            r = json.loads(l)
            if r.get("prompt") and r.get("advantage", 0) >= 0.05:   # clear within-title winners only
                rows.append(r)
        except Exception: pass
print("THUMB update round %s on %d above-average attempts" % (ROUND, len(rows)), flush=True)

def fmt(r):
    think = ("<think>%s</think>\n" % r["reasoning"]) if r.get("reasoning") else ""
    target = think + json.dumps({"prompt": r["prompt"]}, ensure_ascii=False)
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": r["title"]},
            {"role": "assistant", "content": target}]
    return {"text": tok.apply_chat_template(msgs, tokenize=False)}
ds = Dataset.from_list([fmt(r) for r in rows])

print("loading base bf16...", flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, torch_dtype=torch.bfloat16, device_map="cuda")   # transformers 4.53.2 uses torch_dtype (not dtype)
model.config.use_cache = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = SFTConfig(output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                num_train_epochs=2, learning_rate=1e-5, bf16=True, logging_steps=5, save_strategy="no",
                max_length=2000, gradient_checkpointing=False, report_to=[])
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(OUT); tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f): H.s3.upload_file(f, H.BUCKET, "hooks/models/thumb_r%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload()
merged.config.output_router_logits = False  # keep the merged model usable for generation (MoE aux-loss off)
MERGED = "/home/ubuntu/thumbrl/models/thumbmerged_r%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True); tok.save_pretrained(MERGED)
print("=== THUMB_UPDATE_DONE round %s -> merged %s ===" % (ROUND, MERGED), flush=True)
