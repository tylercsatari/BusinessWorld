"""Replicate Cog predictor for the fine-tuned idea model (idea_r7). Serves a MERGED Qwen3-30B-A3B
(base + idea_r7 LoRA) via vLLM. The 57GB merged model is pulled from R2 at startup (NOT baked into
the image — a single 57GB docker layer won't push). Needs R2_* env on the deployment.
No Modal, no spend cap — runs on the user's Replicate billing, scales to zero."""
from cog import BasePredictor, Input
import os, json, re

SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")
HOOK_SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
            "Think about the strongest opening for THIS specific video, then return ONLY JSON: "
            '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")


def _split(txt):
    m = re.search(r"<think>(.*?)</think>", txt, re.S)
    reasoning = m.group(1).strip() if m else ""
    rest = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try:
        spec = json.loads(j.group(0)) if j else None
    except Exception:
        spec = None
    return reasoning, spec


class Predictor(BasePredictor):
    def setup(self):
        import boto3
        from boto3.s3.transfer import TransferConfig
        # Replicate has no deployment env-var injection; R2 read creds are baked into the private
        # image via /src/r2creds.json (created on the build box, never committed to git).
        if not os.environ.get("R2_ACCOUNT_ID") and os.path.exists("/src/r2creds.json"):
            for k, v in json.load(open("/src/r2creds.json")).items():
                os.environ[k] = v
        merged = "/src/merged"
        os.makedirs(merged, exist_ok=True)
        s3 = boto3.client("s3", endpoint_url="https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"],
                          aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
        b = os.environ["R2_BUCKET_NAME"]
        cfg = TransferConfig(max_concurrency=16, multipart_chunksize=64 * 1024 * 1024)
        for o in s3.list_objects_v2(Bucket=b, Prefix="hooks/models/ideamerged_r7/").get("Contents", []):
            n = o["Key"].split("/")[-1]
            if n:
                s3.download_file(b, o["Key"], os.path.join(merged, n), Config=cfg)
        from vllm import LLM, SamplingParams
        self.llm = LLM(model=merged, max_model_len=6144, gpu_memory_utilization=0.90,
                       dtype="bfloat16", trust_remote_code=True, enforce_eager=True)
        self.SamplingParams = SamplingParams

    def predict(self,
                premise: str = Input(description="video idea; blank = the model invents one", default=""),
                invent: bool = Input(description="invent the idea", default=True),
                count: int = Input(description="how many hooks", default=4, ge=1, le=8)) -> str:
        inv = bool(invent) or not premise.strip()
        sp = self.SamplingParams(temperature=1.1 if inv else 1.0, top_p=0.95, max_tokens=4096, n=max(1, min(count, 8)))
        outs = self.llm.chat(
            [{"role": "system", "content": SYS if inv else HOOK_SYS},
             {"role": "user", "content": "Invent one now." if inv else premise}],
            sampling_params=sp, chat_template_kwargs={"enable_thinking": True})
        specs = []
        for comp in outs[0].outputs:
            reasoning, spec = _split(comp.text)
            if not spec:
                continue
            fr = spec.get("frames")
            if isinstance(fr, list) and len(fr) == 5:
                specs.append({"premise": (spec.get("premise") or premise or "").strip(),
                              "frames": [str(x) for x in fr], "cohesion_mode": spec.get("cohesion_mode", "?"),
                              "reasoning": reasoning[:2000]})
        if not inv:
            for s in specs:
                s["premise"] = premise
        return json.dumps({"model": "idea_r7", "attempts": specs})
