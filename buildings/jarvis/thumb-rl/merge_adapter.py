"""Rebuild a merged model on a fresh box from base + the R2-uploaded LoRA adapter (no box-to-box 57GB copy).
Env: ROUND (e.g. 3) -> downloads hooks/models/thumb_r<ROUND>/ from R2, merges into base, saves
models/thumbmerged_r<ROUND>. Run after setup_box_long.sh."""
import os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
import harness_long as H

ROUND = os.environ.get("ROUND", "3")
ADIR = "/home/ubuntu/thumbrl/models/thumb_r%s" % ROUND
os.makedirs(ADIR, exist_ok=True)
resp = H.s3.list_objects_v2(Bucket=H.BUCKET, Prefix="hooks/models/thumb_r%s/" % ROUND)
keys = [o["Key"] for o in resp.get("Contents", [])]
assert keys, "no adapter for round %s on R2" % ROUND
for k in keys:
    H.s3.download_file(H.BUCKET, k, ADIR + "/" + k.rsplit("/", 1)[-1]); print("dl", k.rsplit("/", 1)[-1], flush=True)
print("loading base bf16...", flush=True)
base = AutoModelForCausalLM.from_pretrained("/home/ubuntu/thumbrl/models/qwen3-30b-a3b", torch_dtype=torch.bfloat16, device_map="cpu")
tok = AutoTokenizer.from_pretrained("/home/ubuntu/thumbrl/models/qwen3-30b-a3b")
m = PeftModel.from_pretrained(base, ADIR)
merged = m.merge_and_unload()
OUT = "/home/ubuntu/thumbrl/models/thumbmerged_r%s" % ROUND
merged.save_pretrained(OUT, safe_serialization=True); tok.save_pretrained(OUT)
print("=== MERGE_DONE -> %s ===" % OUT, flush=True)
