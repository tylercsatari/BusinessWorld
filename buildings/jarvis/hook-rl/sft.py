"""LoRA SFT (ReST) on the high-percentile winners — bf16 (no 4-bit; bnb doesn't engage on this
CUDA stack), gradient checkpointing + expandable segments so the 30B fits the 80GB H100.
Env: SFT_ROUND, SRC_RUN, PCTILE_MIN. Saves adapter to models/lora_r{ROUND} + R2 hooks/models/."""
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, glob, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model
from datasets import Dataset
import harness as H

MODELP = "/home/ubuntu/hookrl/models/qwen3-30b-a3b"
ROUND = os.environ.get("SFT_ROUND", "1")
SRC_RUN = os.environ.get("SRC_RUN", "phase1")
PCTILE_MIN = float(os.environ.get("PCTILE_MIN", "0.5"))
OUT = "/home/ubuntu/hookrl/models/lora_r%s" % ROUND
SYS = ("You are a YouTube Shorts hook director. Design the FIRST 5 SECONDS as 5 still frames (1/sec) "
       "forming the most scroll-stopping, high-retention opening. Choose a cohesion_mode: "
       "same_scene|progression|multi_shot|reveal|contrast. Return ONLY JSON: "
       '{"cohesion_mode":"...","frames":["detailed photographic prompt", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, dramatic lighting, no on-screen text. /no_think")

import glob as _g
if SRC_RUN == "all":
    rows = []
    for mf in _g.glob("/home/ubuntu/hookrl/runs/phase*/manifest.jsonl"):
        for l in open(mf):
            try: rows.append(json.loads(l))
            except Exception: pass
else:
    rows = []
    for l in open("/home/ubuntu/hookrl/runs/%s/manifest.jsonl" % SRC_RUN):
        try: rows.append(json.loads(l))
        except Exception: pass
good = [r for r in rows if r.get("pctile", 0) >= PCTILE_MIN and r.get("frames")]
if len(good) < 40:
    rows.sort(key=lambda r: -r.get("pctile", 0))
    good = [r for r in rows if r.get("frames")][:max(40, int(len(rows) * 0.4))]
good.sort(key=lambda r: -r.get("pctile", 0))
# ANTI-OVERFIT: at most 2 specs per unique idea-signature, so a repeated/near-duplicate premise
# (e.g. from the old phase1 bank) can never dominate the SFT set.
import re as _re
_STOP = set("a an the of to and or for with in on at into out from by as is are be do does this that their his her your you i we they it them then so very more most".split())
_BOIL = _re.compile(r"^\s*(the |a |an )?(creator|person|guy|girl|man|woman|youtuber|participants?|someone|narrator|host)\s+\w+\s+", _re.I)
def _sig(p):
    p = _BOIL.sub("", (p or "").lower()); ws = [w for w in _re.findall(r"[a-z]+", p) if w not in _STOP and len(w) > 2]
    return " ".join(sorted(set(ws))[:8])
_cnt, _dd = {}, []
for r in good:
    k = _sig(r.get("premise", ""))
    if _cnt.get(k, 0) >= 2: continue
    _cnt[k] = _cnt.get(k, 0) + 1; _dd.append(r)
good = _dd[:1500]   # cap so SFT stays fast as winners accumulate over many rounds
print("SFT round %s on %s: %d winners (pctile>=%.2f, <=2/idea) of %d total, %d unique ideas" % (
    ROUND, SRC_RUN, len(good), PCTILE_MIN, len(rows), len(_cnt)), flush=True)

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token

def to_text(r):
    spec = json.dumps({"cohesion_mode": r.get("cohesion_mode", "reveal"), "frames": r["frames"]}, ensure_ascii=False)
    return tok.apply_chat_template(
        [{"role": "system", "content": SYS}, {"role": "user", "content": r["brief"]}, {"role": "assistant", "content": spec}],
        tokenize=False)

ds = Dataset.from_dict({"text": [to_text(r) for r in good]})
def tok_fn(ex):
    o = tok(ex["text"], truncation=True, max_length=896)
    o["labels"] = o["input_ids"].copy()
    return o
tds = ds.map(tok_fn, remove_columns=["text"])

print("loading base bf16...", flush=True)
model = AutoModelForCausalLM.from_pretrained(MODELP, dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
model = get_peft_model(model, lora)
model.print_trainable_parameters()

args = TrainingArguments(output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                         num_train_epochs=2, learning_rate=2e-4, logging_steps=5, bf16=True,
                         gradient_checkpointing=False, save_strategy="no", report_to=[], optim="adamw_torch")
trainer = Trainer(model=model, args=args, train_dataset=tds,
                  data_collator=DataCollatorForLanguageModeling(tok, mlm=False))
trainer.train()
os.makedirs(OUT, exist_ok=True)
model.save_pretrained(OUT)
tok.save_pretrained(OUT)
for f in glob.glob(OUT + "/*"):
    if os.path.isfile(f):
        H.s3.upload_file(f, H.BUCKET, "hooks/models/lora_r%s/%s" % (ROUND, os.path.basename(f)))
# Merge the adapter into the base NOW (in-memory — avoids peft's broken adapter-reload on
# transformers 5.x) and save a full merged model the harvest can load plainly.
merged = model.merge_and_unload()
MERGED = "/home/ubuntu/hookrl/models/merged_r%s" % ROUND
merged.save_pretrained(MERGED, safe_serialization=True)
tok.save_pretrained(MERGED)
print("=== SFT_DONE round %s -> adapter %s (+R2) + merged %s ===" % (ROUND, OUT, MERGED), flush=True)
