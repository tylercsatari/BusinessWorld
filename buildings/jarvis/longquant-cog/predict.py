"""Replicate worker for the two trained Long Quant LoRA adapters.

The clean Qwen3-30B-A3B base is loaded once. Each request explicitly selects
idea_long_r26 or thumb_b10, so both models share one scale-to-zero GPU without
substituting a general-purpose LLM.
"""

from cog import BasePredictor, Input
import hashlib
import json
import os
import re


BASE_MODEL = "Qwen/Qwen3-30B-A3B"
BASE_DIR = "/weights/qwen3-30b-a3b"
ADAPTER_DIRS = {
    "idea": "/src/adapters/idea_long_r26",
    "thumb": "/src/adapters/thumb_b10",
}

IDEA_INVENT_SYSTEM = (
    "Invent ONE new viral long-form YouTube video idea, especially an engineering, build, "
    "challenge, experiment, or documentary story that could earn millions of views. Be specific, "
    'concrete, and filmable. Return ONLY JSON: {"idea":"<one-line title/concept>"}.'
)
IDEA_STEER_SYSTEM = (
    "Create ONE alternate title/idea angle for the SAME actual YouTube video. The video reality "
    "context is authoritative: preserve the specific object, people, setting, constraints, and "
    "outcome. Change the hook angle, stakes, framing, title language, or curiosity gap while obeying "
    'the requested semantic ring. Return ONLY JSON: {"idea":"<one-line title/concept>"}.'
)
THUMB_SYSTEM = (
    "Design the single most click-worthy YouTube thumbnail for the supplied long-form video. The "
    "video reality context is authoritative; never invent a different object, build, challenge, "
    "person, setting, or outcome. Think about the strongest visual concept, then return ONLY JSON: "
    '{"prompt":"<one detailed photorealistic horizontal 16:9 thumbnail description>"}. '
    "Use one striking image with no on-screen text, logo, watermark, or fake interface."
)


def _json_value(raw, fallback):
    try:
        value = json.loads(raw or "")
        return value
    except (TypeError, ValueError):
        return fallback


def _extract_value(text, keys):
    clean = re.sub(r"<think>.*?</think>", "", str(text or ""), flags=re.S).strip()
    matches = re.findall(r"\{.*?\}", clean, flags=re.S)
    for raw in reversed(matches):
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        for key in keys:
            value = obj.get(key)
            if isinstance(value, str) and len(value.strip()) >= 8:
                return re.sub(r"\s+", " ", value).strip()
    return None


def _stable_seed(task, payload, requested):
    if requested and requested > 0:
        return int(requested) & 0x7FFFFFFF
    blob = json.dumps({"task": task, **payload}, sort_keys=True, ensure_ascii=True)
    return int(hashlib.sha256(blob.encode("utf-8")).hexdigest()[:8], 16) & 0x7FFFFFFF


class Predictor(BasePredictor):
    def setup(self):
        os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
        from huggingface_hub import snapshot_download

        if not os.path.exists(os.path.join(BASE_DIR, "model.safetensors.index.json")):
            os.makedirs(BASE_DIR, exist_ok=True)
            snapshot_download(BASE_MODEL, local_dir=BASE_DIR, max_workers=16)

        for name, adapter_dir in ADAPTER_DIRS.items():
            required = os.path.join(adapter_dir, "adapter_model.safetensors")
            if not os.path.exists(required):
                raise RuntimeError(f"missing trained adapter {name}: {required}")

        from transformers import AutoTokenizer
        import torch
        from vllm import LLM, SamplingParams
        from vllm.lora.request import LoRARequest

        self.tokenizer = AutoTokenizer.from_pretrained(BASE_DIR)
        gpu_count = max(1, torch.cuda.device_count())
        self.llm = LLM(
            model=BASE_DIR,
            dtype="bfloat16",
            max_model_len=4096,
            gpu_memory_utilization=0.90,
            tensor_parallel_size=2 if gpu_count >= 2 else 1,
            trust_remote_code=True,
            enforce_eager=True,
            enable_lora=True,
            max_loras=2,
            max_lora_rank=16,
        )
        self.SamplingParams = SamplingParams
        self.loras = {
            "idea": LoRARequest("idea_long_r26", 1, ADAPTER_DIRS["idea"]),
            "thumb": LoRARequest("thumb_b10", 2, ADAPTER_DIRS["thumb"]),
        }

    def _generate(self, task, messages, count, seed):
        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        values = []
        keys = ("idea", "title", "premise") if task == "idea" else ("prompt", "thumbnail_prompt")
        temperature = 1.15 if task == "idea" else 1.0
        top_p = 0.97 if task == "idea" else 0.95
        max_tokens = 220 if task == "idea" else 420

        for round_index in range(2):
            needed = count - len(values)
            if needed <= 0:
                break
            params = self.SamplingParams(
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                n=needed,
                seed=(seed + round_index * 1009) & 0x7FFFFFFF,
            )
            result = self.llm.generate([prompt], params, lora_request=self.loras[task])
            for completion in result[0].outputs:
                value = _extract_value(completion.text, keys)
                if value and value not in values:
                    values.append(value)

        if not values:
            raise RuntimeError(f"{task} adapter produced no valid JSON output")
        return values[:count]

    def predict(
        self,
        task: str = Input(description="trained adapter to run", choices=["idea", "thumb"], default="idea"),
        premise: str = Input(description="seed title or premise", default=""),
        idea: str = Input(description="video idea for thumbnail direction", default=""),
        context: str = Input(description="authoritative video/transcript context", default=""),
        instruction: str = Input(description="additional generation constraint", default=""),
        avoid_json: str = Input(description="prior ideas to avoid, encoded as JSON", default="[]"),
        semantic_ring_json: str = Input(description="semantic distance constraints, encoded as JSON", default="{}"),
        invent: bool = Input(description="invent an unseeded idea", default=False),
        attempt: int = Input(description="exploration iteration", default=0, ge=0, le=10000),
        count: int = Input(description="number of outputs", default=1, ge=1, le=8),
        seed: int = Input(description="deterministic request seed", default=0, ge=0, le=2147483647),
    ) -> str:
        task = "thumb" if task == "thumb" else "idea"
        count = max(1, min(int(count), 8))
        context = re.sub(r"\s+", " ", context or "").strip()[:6000]
        premise = re.sub(r"\s+", " ", premise or "").strip()[:500]
        idea = re.sub(r"\s+", " ", idea or "").strip()[:500]

        if task == "idea":
            avoid = _json_value(avoid_json, [])
            ring = _json_value(semantic_ring_json, {})
            seeded = bool(premise or idea) and not bool(invent)
            payload = {
                "seedTitle": premise or idea,
                "videoRealityContext": context,
                "attempt": int(attempt),
                "semanticRing": ring,
                "avoid": avoid,
                "instruction": instruction[:1200],
            }
            messages = [
                {"role": "system", "content": IDEA_STEER_SYSTEM if seeded else IDEA_INVENT_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=True)},
            ]
        else:
            if not idea and not premise:
                raise ValueError("thumb_b10 requires a video idea")
            payload = {
                "idea": idea or premise,
                "videoRealityContext": context,
                "attempt": int(attempt),
                "instruction": instruction[:1200],
            }
            messages = [
                {"role": "system", "content": THUMB_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=True)},
            ]

        request_seed = _stable_seed(task, payload, seed)
        values = self._generate(task, messages, count, request_seed)
        if task == "idea":
            return json.dumps({"model": "idea_long_r26", "ideas": values, "seed": request_seed})
        return json.dumps({"model": "thumb_b10", "prompts": values, "seed": request_seed})
