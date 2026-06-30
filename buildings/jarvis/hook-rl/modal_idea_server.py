"""
modal_idea_server.py — Serverless host for the fine-tuned hook-idea model (idea_r5).

Pay-per-use, scale-to-zero. NO Gemini, no fallback: this IS the fine-tune.

Engine: vLLM (fused-MoE kernels → seconds; HF transformers was ~7 tok/s and timed out).
vLLM 0.9.2 refuses to load a LoRA on Qwen3MoeForCausalLM ("does not support LoRA yet"),
so we MERGE idea_r5 into the base ONCE (W += BA, identical result) and serve the merged
plain checkpoint. Generation params + prompts match training (idea_train.py).

────────────────────────────────────────────────────────────────────────────
DEPLOY (two steps, the first is one-time):

  # 1) merge idea_r5 into Qwen3-30B-A3B → saved into a Modal Volume (~10 min, once)
  modal run buildings/jarvis/hook-rl/modal_idea_server.py::build_merged

  # 2) deploy the serving endpoint (reads the merged model from the Volume)
  modal deploy buildings/jarvis/hook-rl/modal_idea_server.py

Endpoint: https://tylercsatari--hook-idea-model-model-generate.modal.run
Render env: HOOK_MODEL_URL = that URL, HOOK_MODEL_TOKEN = the shared secret.
────────────────────────────────────────────────────────────────────────────
"""
import os, re, json, modal

APP = "hook-idea-model"
BASE = "Qwen/Qwen3-30B-A3B"
ADAPTER_KEY = os.environ.get("ADAPTER", "idea_r5")
BASE_DIR = "/models/base"
MERGED_DIR = "/merged/%s_merged" % ADAPTER_KEY     # lives in the hook-merged Volume

# Same prompts the model was trained with (idea_train.py). Do not change.
SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")
HOOK_SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
            "Think about the strongest opening for THIS specific video, then return ONLY JSON: "
            '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")


def _download_base():
    from huggingface_hub import snapshot_download
    snapshot_download(BASE, local_dir=BASE_DIR)


# Merge image: base baked in + transformers/peft (CPU/GPU merge). Cached download layer.
merge_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub==0.30.2", "hf_xet")
    .run_function(_download_base)
    .pip_install("torch==2.5.1", "transformers==4.53.2", "peft==0.16.0", "accelerate==1.1.1", "boto3==1.35.0")
)
# Serve image: vLLM only (loads the merged model from the Volume — no base bake needed).
serve_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "vllm==0.9.2", "transformers==4.53.2", "boto3==1.35.0", "fastapi[standard]==0.115.5"
)

app = modal.App(APP)
merged_vol = modal.Volume.from_name("hook-merged", create_if_missing=True)


def _split(txt):
    """Strip any <think> block, parse the trailing JSON — exactly as idea_train.split()."""
    m = re.search(r"<think>(.*?)</think>", txt, re.S)
    reasoning = m.group(1).strip() if m else ""
    rest = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try:
        spec = json.loads(j.group(0)) if j else None
    except Exception:
        spec = None
    return reasoning, spec


@app.function(image=merge_image, gpu="H100", volumes={"/merged": merged_vol},
              secrets=[modal.Secret.from_name("hook-r2")], timeout=1800)
def build_merged(force: bool = False):
    """One-time: merge idea_r5 into the base and persist the merged checkpoint to the Volume."""
    import torch, boto3
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel
    if os.path.isdir(MERGED_DIR) and os.listdir(MERGED_DIR) and not force:
        print("merged model already present at", MERGED_DIR, "— skipping", flush=True)
        return
    adir = "/tmp/adapter"; os.makedirs(adir, exist_ok=True)
    s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"],
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto")
    bucket = os.environ["R2_BUCKET_NAME"]
    for obj in s3.list_objects_v2(Bucket=bucket, Prefix="hooks/models/%s/" % ADAPTER_KEY).get("Contents", []):
        n = obj["Key"].split("/")[-1]
        if n:
            s3.download_file(bucket, obj["Key"], os.path.join(adir, n))
    print("merging", ADAPTER_KEY, "into", BASE, flush=True)
    tok = AutoTokenizer.from_pretrained(BASE_DIR)
    model = AutoModelForCausalLM.from_pretrained(BASE_DIR, torch_dtype=torch.bfloat16, device_map="cuda")
    model = PeftModel.from_pretrained(model, adir)
    model = model.merge_and_unload()
    model.config.output_router_logits = False
    os.makedirs(MERGED_DIR, exist_ok=True)
    model.save_pretrained(MERGED_DIR, safe_serialization=True)
    tok.save_pretrained(MERGED_DIR)
    merged_vol.commit()
    print("merged checkpoint saved to", MERGED_DIR, flush=True)


@app.cls(image=serve_image, gpu="H100", volumes={"/merged": merged_vol},
         secrets=[modal.Secret.from_name("hook-r2")], scaledown_window=120, timeout=600, max_containers=1)
class Model:
    @modal.enter()
    def load(self):
        from vllm import LLM, SamplingParams
        if not (os.path.isdir(MERGED_DIR) and os.listdir(MERGED_DIR)):
            raise RuntimeError("merged model missing — run `modal run …::build_merged` first")
        self.llm = LLM(model=MERGED_DIR, max_model_len=6144, gpu_memory_utilization=0.90,
                       dtype="bfloat16", trust_remote_code=True)
        self.SamplingParams = SamplingParams
        print("vLLM (merged idea_r5) ready on GPU", flush=True)

    def _run(self, sys_msg, user_msg, n, temp):
        sp = self.SamplingParams(temperature=temp, top_p=0.95, max_tokens=4096, n=n)
        outs = self.llm.chat(
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
            sampling_params=sp, chat_template_kwargs={"enable_thinking": True},
        )
        specs = []
        for comp in outs[0].outputs:
            reasoning, spec = _split(comp.text)
            if not spec:
                continue
            fr = spec.get("frames")
            if isinstance(fr, list) and len(fr) == 5:
                specs.append({
                    "premise": (spec.get("premise") or "").strip(),
                    "frames": [str(x) for x in fr],
                    "cohesion_mode": spec.get("cohesion_mode", "?"),
                    "reasoning": reasoning[:2000],
                })
        return specs

    @modal.fastapi_endpoint(method="POST")
    def generate(self, data: dict):
        if data.get("token") != os.environ.get("HOOK_MODEL_TOKEN"):
            return {"error": "unauthorized"}
        premise = (data.get("premise") or "").strip()
        invent = bool(data.get("invent")) or not premise
        count = max(1, min(int(data.get("count") or 4), 8))
        if invent:
            specs = self._run(SYS, "Invent one now.", count, 1.1)
        else:
            specs = self._run(HOOK_SYS, premise, count, 1.0)
            for s in specs:
                s["premise"] = premise
        return {"model": ADAPTER_KEY, "attempts": specs}
