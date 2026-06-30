"""
modal_idea_server.py — Serverless host for the fine-tuned hook-idea model (idea_r5).

Pay-per-use, scale-to-zero: the GPU spins up on a request, generates, and spins
back to zero after `scaledown_window`. Billed only for the seconds it runs — never
for idle time. NO Gemini, no fallback: this IS the fine-tune.

Engine: vLLM. Qwen3-30B-A3B is a Mixture-of-Experts model — HuggingFace transformers
generates it at ~7 tok/s (loops over 128 experts in Python), which timed out. vLLM
uses fused-MoE kernels → seconds. idea_r5 only adapts attention (q/k/v/o_proj), so
vLLM serves the LoRA directly. Generation params + prompts match training (idea_train.py).

Base Qwen3-30B-A3B is baked into the image at build time; the tiny idea_r5 LoRA is
pulled from R2 at cold start.

────────────────────────────────────────────────────────────────────────────
DEPLOY:  modal deploy buildings/jarvis/hook-rl/modal_idea_server.py
Endpoint: https://tylercsatari--hook-idea-model-model-generate.modal.run
Render env: HOOK_MODEL_URL = that URL, HOOK_MODEL_TOKEN = the shared secret.
────────────────────────────────────────────────────────────────────────────
"""
import os, re, json, modal

APP = "hook-idea-model"
BASE = "Qwen/Qwen3-30B-A3B"
ADAPTER_KEY = os.environ.get("ADAPTER", "idea_r5")
BASE_DIR = "/models/base"
ADAPTER_DIR = "/tmp/adapter"

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
    """Runs at IMAGE BUILD time: bake the full base snapshot into the image layer."""
    from huggingface_hub import snapshot_download
    snapshot_download(BASE, local_dir=BASE_DIR)


# Layer order: hub (+xet) → bake 57GB → vLLM. Changing the vLLM layer does NOT
# re-trigger the model download (that layer is cached).
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub==0.30.2", "hf_xet")
    .run_function(_download_base)
    # transformers pinned <4.54 — newer ones register 'aimv2', which vllm 0.9.2 also
    # registers → "already used" import crash. 4.53.x is what vllm 0.9.2 targets.
    .pip_install("vllm==0.9.2", "transformers==4.53.2", "boto3==1.35.0", "fastapi[standard]==0.115.5")
)
app = modal.App(APP)


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


@app.cls(
    gpu="H100",
    image=image,
    secrets=[modal.Secret.from_name("hook-r2")],
    scaledown_window=120,   # spin down 2 min after the last call → no idle billing
    timeout=600,
    max_containers=1,
)
class Model:
    @modal.enter()
    def load(self):
        import boto3
        from vllm import LLM, SamplingParams
        from vllm.lora.request import LoRARequest

        # idea_r5 LoRA ← R2 (tiny; pulled fresh each cold start)
        os.makedirs(ADAPTER_DIR, exist_ok=True)
        s3 = boto3.client(
            "s3",
            endpoint_url="https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        bucket = os.environ["R2_BUCKET_NAME"]
        for obj in s3.list_objects_v2(Bucket=bucket, Prefix="hooks/models/%s/" % ADAPTER_KEY).get("Contents", []):
            name = obj["Key"].split("/")[-1]
            if name:
                s3.download_file(bucket, obj["Key"], os.path.join(ADAPTER_DIR, name))
        print("adapter", ADAPTER_KEY, "ready", flush=True)

        self.llm = LLM(
            model=BASE_DIR, enable_lora=True, max_loras=1, max_lora_rank=16,
            max_model_len=4096, gpu_memory_utilization=0.90, dtype="bfloat16",
            trust_remote_code=True,
        )
        self.SamplingParams = SamplingParams
        self.lora = LoRARequest(ADAPTER_KEY, 1, ADAPTER_DIR)
        print("vLLM + LoRA ready on GPU", flush=True)

    def _run(self, sys_msg, user_msg, n, temp):
        sp = self.SamplingParams(temperature=temp, top_p=0.95, max_tokens=2048, n=n)
        outs = self.llm.chat(
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
            sampling_params=sp, lora_request=self.lora,
            chat_template_kwargs={"enable_thinking": True},
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
