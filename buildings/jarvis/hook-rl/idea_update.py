"""RAFT update for the idea model: LoRA-SFT on the ACCEPTED (high-keep + novel) ideas it discovered,
so it gets better at inventing DIVERSE viral ideas over rounds. Diversity is preserved because the
training set itself is novelty-filtered. Env: IDEA_ROUND."""
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from datasets import Dataset
import harness as H

MODELP = "/home/ubuntu/hookrl/models/qwen3-30b-a3b"
ROUND = os.environ.get("IDEA_ROUND", "1")
OUT = "/home/ubuntu/hookrl/models/ideamerged_r%s" % ROUND
ADP = "/home/ubuntu/hookrl/models/idea_r%s" % ROUND
SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token
rows = []
for pf in glob.glob("/home/ubuntu/hookrl/runs/discover*/raft_data.jsonl"):
    for l in open(pf):
        try:
            r = json.loads(l)
            if r.get("premise") and r.get("frames") and r.get("keep", 0) >= 0.82: rows.append(r)  # train on the better half -> lifts the average
        except Exception: pass
print("IDEA RAFT round %s on %d accepted ideas" % (ROUND, len(rows)), flush=True)

def fmt(r):
    think = ("<think>%s</think>\n" % r["reasoning"]) if r.get("reasoning") else ""
    target = think + json.dumps({"premise": r["premise"], "cohesion_mode": r.get("cohesion_mode", "reveal"), "frames": r["frames"]}, ensure_ascii=False)
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": "Invent one now."}, {"role": "assistant", "content": target}]
    return {"text": tok.apply_chat_template(msgs, tokenize=False)}
ds = Dataset.from_list([fmt(r) for r in rows])

model = AutoModelForCausalLM.from_pretrained(MODELP, dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False; model.config.output_router_logits = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = SFTConfig(output_dir=ADP, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                num_train_epochs=2, learning_rate=1e-5, bf16=True, logging_steps=5, save_strategy="no",
                max_length=2600, gradient_checkpointing=False, report_to=[])
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(ADP); tok.save_pretrained(ADP)
for f in glob.glob(ADP + "/*"):
    if os.path.isfile(f): H.s3.upload_file(f, H.BUCKET, "hooks/models/idea_r%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload(); merged.config.output_router_logits = False
merged.save_pretrained(OUT, safe_serialization=True); tok.save_pretrained(OUT)
print("=== IDEA_UPDATE_DONE round %s -> %s ===" % (ROUND, OUT), flush=True)
