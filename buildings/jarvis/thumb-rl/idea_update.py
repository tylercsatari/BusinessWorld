"""RAFT/BOND update for the LONG-FORM IDEA model: SFT the base on ALL accepted ideas (high-score + novel),
no-think JSON targets (all gradient on reward-relevant tokens — the proven thumbnail recipe, 2 epochs).
Env: IDEA_ROUND, EPOCHS(2). Adapter -> R2 hooks/models/idea_long_r<N>; merged -> models/ideamerged_long_r<N>."""
import os, json, glob, torch
os.environ.setdefault("STATUS_KEY", "longform/idea-rl/status.json")
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from datasets import Dataset
import harness_long as H

ROUND = os.environ.get("IDEA_ROUND", "1")
MODELP = "/home/ubuntu/thumbrl/models/qwen3-30b-a3b"
OUT = "/home/ubuntu/thumbrl/models/idea_long_r%s" % ROUND
SYS = ("Invent ONE new viral long-form YouTube video idea (the kind of engineering/build/challenge/story "
       "video that earns millions of views). Be SPECIFIC and concrete — a real, filmable video. "
       'Return ONLY JSON: {"idea":"<the video title/concept, one line>"}')

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token
rows, seen = [], set()
for pf in glob.glob("/home/ubuntu/thumbrl/runs/idea2*/accepted.jsonl"):
    for l in open(pf):
        try:
            r = json.loads(l)
            k = r["idea"].lower()[:70]
            if r.get("idea") and k not in seen: seen.add(k); rows.append(r)
        except Exception: pass
print("IDEA update r%s on %d accepted ideas" % (ROUND, len(rows)), flush=True)
assert len(rows) >= 100, "too few accepted ideas to train"
def fmt(r):
    target = "<think>\n\n</think>\n\n" + json.dumps({"idea": r["idea"]}, ensure_ascii=False)
    return {"text": tok.apply_chat_template([{"role": "system", "content": SYS},
        {"role": "user", "content": "Invent a new idea now."}, {"role": "assistant", "content": target}], tokenize=False)}
ds = Dataset.from_list([fmt(r) for r in rows])
print("loading base bf16...", flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, torch_dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = SFTConfig(output_dir=OUT, per_device_train_batch_size=2, gradient_accumulation_steps=8,
                num_train_epochs=int(os.environ.get("EPOCHS", "2")), learning_rate=1e-5, bf16=True,
                logging_steps=20, save_strategy="no", max_length=400, report_to=[])
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(OUT); tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f): H.s3.upload_file(f, H.BUCKET, "hooks/models/idea_long_r%s/%s" % (ROUND, os.path.basename(f)))
merged = trainer.model.merge_and_unload()
MERGED = "/home/ubuntu/thumbrl/models/ideamerged_long_r%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True); tok.save_pretrained(MERGED)
print("=== IDEA_UPDATE_DONE r%s -> %s ===" % (ROUND, MERGED), flush=True)
