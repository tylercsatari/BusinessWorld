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
        # The merged model is baked into the image at /model — downloaded shard-by-shard at BUILD
        # time (one docker layer each; a single 61GB layer won't push to the registry). No cold-start
        # download → fast, reliable boot on scale-from-zero.
        from vllm import LLM, SamplingParams
        self.llm = LLM(model="/model", max_model_len=6144, gpu_memory_utilization=0.90,
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
