"""Self-contained idea_r7 trainer (runs on a Lambda H100). Downloads base Qwen3-30B-A3B + the R2
training set (974 winners), LoRA-SFTs it, uploads the idea_r7 adapter to R2. No harness dep.
Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME."""
import os
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
import json, glob, torch, boto3
from huggingface_hub import snapshot_download
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from datasets import Dataset

BASE = "Qwen/Qwen3-30B-A3B"
MODELP = os.path.expanduser("~/hookrl/models/qwen3-30b-a3b")
ROUND = "7"; ADP = os.path.expanduser("~/hookrl/models/idea_r7")
SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"],
                  aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
BUCKET = os.environ["R2_BUCKET_NAME"]

if not (os.path.isdir(MODELP) and os.listdir(MODELP)):
    print("downloading base…", flush=True); snapshot_download(BASE, local_dir=MODELP)
raft = os.path.expanduser("~/hookrl/runs/discover7/raft_data.jsonl")
os.makedirs(os.path.dirname(raft), exist_ok=True)
s3.download_file(BUCKET, "hooks/grpo/discover7/raft_data.jsonl", raft)

tok = AutoTokenizer.from_pretrained(MODELP)
if tok.pad_token is None: tok.pad_token = tok.eos_token
rows = []
for l in open(raft):
    try:
        r = json.loads(l)
        if r.get("premise") and r.get("frames") and r.get("keep", 0) >= 0.82: rows.append(r)
    except Exception: pass
print("idea_r7 RAFT on %d winners" % len(rows), flush=True)

def fmt(r):
    target = json.dumps({"premise": r["premise"], "cohesion_mode": r.get("cohesion_mode", "reveal"), "frames": r["frames"]}, ensure_ascii=False)
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": "Invent one now."}, {"role": "assistant", "content": target}]
    return {"text": tok.apply_chat_template(msgs, tokenize=False)}
ds = Dataset.from_list([fmt(r) for r in rows])

model = AutoModelForCausalLM.from_pretrained(MODELP, torch_dtype=torch.bfloat16, device_map="cuda")
model.config.use_cache = False; model.config.output_router_logits = False
model.gradient_checkpointing_enable(); model.enable_input_require_grads()
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
cfg = SFTConfig(output_dir=ADP, per_device_train_batch_size=1, gradient_accumulation_steps=16,
                num_train_epochs=2, learning_rate=1e-5, bf16=True, logging_steps=5, save_strategy="no",
                max_seq_length=2600, gradient_checkpointing=False, report_to=[])
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)
trainer.train()
trainer.model.save_pretrained(ADP); tok.save_pretrained(ADP)
for f in glob.glob(ADP + "/*"):
    if os.path.isfile(f): s3.upload_file(f, BUCKET, "hooks/models/idea_r7/%s" % os.path.basename(f))
print("=== TRAIN_R7_DONE — adapter uploaded to R2 hooks/models/idea_r7 ===", flush=True)
