"""DPO on the accumulated keep-axis preference pairs (chosen=highest density-guarded keep reward,
rejected=lowest). bf16 + gradient checkpointing; PEFT LoRA = policy, frozen base = reference.
Env: DPO_ROUND. Saves adapter to R2 hooks/models/dpo_rN + a merged model for the next harvest."""
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import DPOTrainer, DPOConfig
from datasets import Dataset
import harness as H

MODELP = "/home/ubuntu/hookrl/models/qwen3-30b-a3b"
ROUND = os.environ.get("DPO_ROUND", "1")
OUT = "/home/ubuntu/hookrl/models/dpo_r%s" % ROUND
SYS = ("You are a YouTube Shorts hook director. Design the FIRST 5 SECONDS as 5 still frames (1/sec) "
       "forming the most scroll-stopping, high-retention opening so viewers DON'T swipe away. "
       "Choose a cohesion_mode: same_scene|progression|multi_shot|reveal|contrast. Return ONLY JSON: "
       '{"cohesion_mode":"...","frames":["detailed photographic prompt", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, dramatic lighting, no on-screen text. /no_think")

pairs = []
for pf in glob.glob("/home/ubuntu/hookrl/runs/keep*/pairs.jsonl"):
    for l in open(pf):
        try:
            p = json.loads(l)
            if p.get("chosen") and p.get("rejected") and p["chosen"] != p["rejected"] \
               and (p.get("chosen_reward", 0) - p.get("rejected_reward", 0)) >= 0.08:
                pairs.append(p)
        except Exception: pass
print("DPO round %s on %d preference pairs (margin>=0.08)" % (ROUND, len(pairs)), flush=True)

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token

def fmt(p):
    prompt = tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": p["brief"]}],
                                     tokenize=False, add_generation_prompt=True)
    return {"prompt": prompt, "chosen": p["chosen"], "rejected": p["rejected"]}
ds = Dataset.from_list([fmt(p) for p in pairs])

print("loading base bf16...", flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = DPOConfig(output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                num_train_epochs=1, learning_rate=5e-6, bf16=True, beta=0.1,
                max_length=1280, logging_steps=5, save_strategy="no",
                gradient_checkpointing=False, report_to=[])  # trl 1.7.0 DPOConfig dropped max_prompt_length
trainer = DPOTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(OUT); tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f):
        H.s3.upload_file(f, H.BUCKET, "hooks/models/dpo_r%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload()
MERGED = "/home/ubuntu/hookrl/models/dpomerged_r%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True); tok.save_pretrained(MERGED)
print("=== DPO_DONE round %s -> adapter %s (+R2) + merged %s ===" % (ROUND, OUT, MERGED), flush=True)
