"""
modal_idea_server.py — Serverless host for the fine-tuned hook-idea model (idea_r5).

Pay-per-use, scale-to-zero: the GPU spins up on a request, generates, and spins
back to zero after `scaledown_window`. You are billed only for the seconds it runs
— never for idle time. NO Gemini, no fallback: this IS the fine-tune.

It loads base Qwen3-30B-A3B + the idea_r5 LoRA (from R2) and reproduces the EXACT
generation used in training (idea_train.py): same SYS / HOOK_SYS prompts,
enable_thinking, temperatures, and JSON parse.

────────────────────────────────────────────────────────────────────────────
ONE-TIME SETUP (you run these locally; I wrote all the code):

  pip install modal
  modal token new                      # opens browser, links your Modal account

  # R2 creds + a shared auth token, as a Modal secret named "hook-r2".
  # Pick any long random string for HOOK_MODEL_TOKEN — you'll paste the same one
  # into Render env later so only our server can call this endpoint.
  modal secret create hook-r2 \
      R2_ACCOUNT_ID=xxx \
      R2_ACCESS_KEY_ID=xxx \
      R2_SECRET_ACCESS_KEY=xxx \
      R2_BUCKET_NAME=business-world-videos \
      HOOK_MODEL_TOKEN=<pick-a-long-random-string>

  modal deploy modal_idea_server.py    # prints a URL like
                                        #   https://<you>--hook-idea-model-generate.modal.run
  # First call downloads the 57GB base into a cached Volume (slow once, ~minutes);
  # after that, cold start is ~30-60s and warm calls are fast.

Then tell me the URL + the token and I'll wire them into Render:
  HOOK_MODEL_URL   = the printed .modal.run URL
  HOOK_MODEL_TOKEN = the same random string
────────────────────────────────────────────────────────────────────────────
"""
import os, re, json, modal

APP = "hook-idea-model"
BASE = "Qwen/Qwen3-30B-A3B"          # open base; idea_r5 is a LoRA on top of this
ADAPTER_KEY = os.environ.get("ADAPTER", "idea_r5")   # which R2 LoRA round to serve
CACHE = "/cache"

# Same prompts the model was trained with (idea_train.py). Do not change — the
# fine-tune learned to answer THESE exact system messages.
SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")
HOOK_SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
            "Think about the strongest opening for THIS specific video, then return ONLY JSON: "
            '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.5.1", "transformers==4.51.3", "peft==0.13.2", "accelerate==1.1.1",
        "boto3==1.35.0", "huggingface_hub==0.30.2", "fastapi[standard]==0.115.5",
    )
)
app = modal.App(APP)
vol = modal.Volume.from_name("hook-model-cache", create_if_missing=True)


def _split(txt):
    """Strip the <think> block, parse the trailing JSON — exactly as idea_train.split()."""
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
    volumes={CACHE: vol},
    secrets=[modal.Secret.from_name("hook-r2")],
    scaledown_window=120,   # spin down 2 min after the last call → no idle billing
    timeout=600,
    max_containers=1,       # one GPU is plenty; caps spend
)
class Model:
    @modal.enter()
    def load(self):
        import torch, boto3
        from huggingface_hub import snapshot_download
        from transformers import AutoTokenizer, AutoModelForCausalLM
        from peft import PeftModel

        base_dir = os.path.join(CACHE, "base")
        adapter_dir = os.path.join(CACHE, ADAPTER_KEY)

        # 1) base weights → cached in the Volume (downloaded once, ever)
        if not os.path.isdir(base_dir) or not os.listdir(base_dir):
            print("downloading base", BASE, "→ volume (one-time)…", flush=True)
            snapshot_download(BASE, local_dir=base_dir, ignore_patterns=["*.pt", "*.bin.index.json.tmp"])
            vol.commit()

        # 2) idea_r5 LoRA adapter ← R2 (tiny; refresh each cold start so swaps take effect)
        os.makedirs(adapter_dir, exist_ok=True)
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
                s3.download_file(bucket, obj["Key"], os.path.join(adapter_dir, name))
        print("adapter", ADAPTER_KEY, "ready", flush=True)

        self.tok = AutoTokenizer.from_pretrained(base_dir)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.tok.padding_side = "left"
        model = AutoModelForCausalLM.from_pretrained(base_dir, torch_dtype=torch.bfloat16, device_map="cuda")
        model = PeftModel.from_pretrained(model, adapter_dir)
        model.config.output_router_logits = False   # MoE: required for generation
        model.eval()
        self.model = model
        self.torch = torch
        print("model + LoRA ready on GPU", flush=True)

    def _run(self, sys_msg, user_msg, n, temp):
        torch = self.torch
        text = self.tok.apply_chat_template(
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
            tokenize=False, add_generation_prompt=True, enable_thinking=True,
        )
        ins = self.tok([text] * n, return_tensors="pt", padding=True).to("cuda")
        with torch.no_grad():
            out = self.model.generate(
                **ins, max_new_tokens=2048, do_sample=True, temperature=temp,
                top_p=0.95, pad_token_id=self.tok.pad_token_id,
            )
        specs = []
        for i in range(n):
            reasoning, spec = _split(self.tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True))
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
        # auth — only callers with the shared token may spend GPU
        if data.get("token") != os.environ.get("HOOK_MODEL_TOKEN"):
            return {"error": "unauthorized"}
        premise = (data.get("premise") or "").strip()
        invent = bool(data.get("invent")) or not premise
        count = max(1, min(int(data.get("count") or 4), 8))
        if invent:
            specs = self._run(SYS, "Invent one now.", count, 1.1)
        else:
            specs = self._run(HOOK_SYS, premise, count, 1.0)
            for s in specs:              # premise is the user's input in hook mode
                s["premise"] = premise
        return {"model": ADAPTER_KEY, "attempts": specs}
