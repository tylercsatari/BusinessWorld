"""Provider-neutral inference core for the finalized Long Quant adapters."""

import hashlib
import json
import os
import re


IDEA_MODEL = "idea_long_r26"
THUMB_MODEL = "thumb_b10"

IDEA_INVENT_SYSTEM = (
    "Invent ONE new viral long-form YouTube video idea (the kind of engineering/build/challenge/story "
    "video that earns millions of views). Be SPECIFIC and concrete - a real, filmable video. "
    'Return ONLY JSON: {"idea":"<the video title/concept, one line>"}'
)
IDEA_STEER_SYSTEM = (
    "Create ONE alternate title/idea angle for the SAME actual YouTube video. The video reality "
    "context is authoritative: preserve the specific object, people, setting, constraints, and "
    "outcome. Change the hook angle, stakes, framing, title language, or curiosity gap while obeying "
    'the requested semantic ring. Return ONLY JSON: {"idea":"<one-line title/concept>"}.'
)
THUMB_SYSTEM = (
    "Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
    "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
    '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
    "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image."
)


def _json_value(raw, fallback):
    try:
        return json.loads(raw or "")
    except (TypeError, ValueError):
        return fallback


def _extract_value(text, keys):
    clean = re.sub(r"<think>.*?</think>", "", str(text or ""), flags=re.S).strip()
    for raw in reversed(re.findall(r"\{.*?\}", clean, flags=re.S)):
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


class LongQuantEngine:
    def setup(self, base_dir, adapter_dirs, tensor_parallel_size=None, backend="vllm"):
        if not os.path.exists(os.path.join(base_dir, "model.safetensors.index.json")):
            raise RuntimeError(f"Qwen base is not available at {base_dir}")
        for name, adapter_dir in adapter_dirs.items():
            required = os.path.join(adapter_dir, "adapter_model.safetensors")
            if not os.path.exists(required):
                raise RuntimeError(f"missing trained adapter {name}: {required}")

        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch

        self.tokenizer = AutoTokenizer.from_pretrained(adapter_dirs["idea"])
        self.backend = backend
        if backend == "transformers":
            from peft import PeftModel

            base = AutoModelForCausalLM.from_pretrained(
                base_dir,
                torch_dtype=torch.bfloat16,
                device_map="cuda",
                low_cpu_mem_usage=True,
            )
            base.config.output_router_logits = False
            base.config.use_cache = True
            self.model = PeftModel.from_pretrained(
                base,
                adapter_dirs["idea"],
                adapter_name="idea",
                is_trainable=False,
            )
            self.model.load_adapter(adapter_dirs["thumb"], adapter_name="thumb", is_trainable=False)
            self.model.eval()
            self.torch = torch
            return

        from vllm import LLM, SamplingParams
        from vllm.lora.request import LoRARequest

        self.SamplingParams = SamplingParams
        gpu_count = max(1, torch.cuda.device_count())
        parallel = tensor_parallel_size or (2 if gpu_count >= 2 else 1)
        self.llm = LLM(
            model=base_dir,
            dtype="bfloat16",
            max_model_len=4096,
            gpu_memory_utilization=0.90,
            tensor_parallel_size=parallel,
            trust_remote_code=True,
            enforce_eager=True,
            enable_lora=True,
            max_loras=2,
            max_lora_rank=16,
        )
        self.loras = {
            "idea": LoRARequest(IDEA_MODEL, 1, adapter_dirs["idea"]),
            "thumb": LoRARequest(THUMB_MODEL, 2, adapter_dirs["thumb"]),
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
        max_tokens = 200 if task == "idea" else 350

        if self.backend == "transformers":
            self.model.set_adapter(task)
            encoded = self.tokenizer(prompt, return_tensors="pt")
            encoded = {key: value.to("cuda") for key, value in encoded.items()}
            prompt_tokens = encoded["input_ids"].shape[1]
            for round_index in range(2):
                needed = count - len(values)
                if needed <= 0:
                    break
                for candidate_index in range(needed):
                    request_seed = (seed + round_index * 1009 + candidate_index * 97) & 0x7FFFFFFF
                    self.torch.manual_seed(request_seed)
                    self.torch.cuda.manual_seed_all(request_seed)
                    with self.torch.inference_mode():
                        output = self.model.generate(
                            **encoded,
                            do_sample=True,
                            temperature=temperature,
                            top_p=top_p,
                            max_new_tokens=max_tokens,
                            pad_token_id=self.tokenizer.eos_token_id,
                        )
                    text = self.tokenizer.decode(output[0, prompt_tokens:], skip_special_tokens=True)
                    value = _extract_value(text, keys)
                    if value and value not in values:
                        values.append(value)
            if not values:
                raise RuntimeError(f"{task} adapter produced no valid JSON output")
            return values[:count]

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
        task="idea",
        premise="",
        idea="",
        context="",
        instruction="",
        avoid_json="[]",
        semantic_ring_json="{}",
        invent=False,
        attempt=0,
        count=1,
        seed=0,
    ):
        task = "thumb" if task == "thumb" else "idea"
        count = max(1, min(int(count), 8))
        context = re.sub(r"\s+", " ", context or "").strip()[:6000]
        premise = re.sub(r"\s+", " ", premise or "").strip()[:500]
        idea = re.sub(r"\s+", " ", idea or "").strip()[:500]

        if task == "idea":
            payload = {
                "seedTitle": premise or idea,
                "videoRealityContext": context,
                "attempt": int(attempt),
                "semanticRing": _json_value(semantic_ring_json, {}),
                "avoid": _json_value(avoid_json, []),
                "instruction": instruction[:1200],
            }
            seeded = bool(premise or idea) and not bool(invent)
            messages = [
                {"role": "system", "content": IDEA_STEER_SYSTEM if seeded else IDEA_INVENT_SYSTEM},
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=True) if seeded else "Invent a new idea now.",
                },
            ]
        else:
            if not idea and not premise:
                raise ValueError(f"{THUMB_MODEL} requires a video idea")
            payload = {
                "idea": idea or premise,
                "videoRealityContext": context,
                "attempt": int(attempt),
                "instruction": instruction[:1200],
            }
            thumb_input = idea or premise
            if context:
                thumb_input += "\n\nAuthoritative video context (depict this exact video): " + context
            messages = [
                {"role": "system", "content": THUMB_SYSTEM},
                {"role": "user", "content": thumb_input},
            ]

        request_seed = _stable_seed(task, payload, seed)
        values = self._generate(task, messages, count, request_seed)
        key = "ideas" if task == "idea" else "prompts"
        model = IDEA_MODEL if task == "idea" else THUMB_MODEL
        return {"model": model, key: values, "seed": request_seed}
