from __future__ import annotations

from typing import Any, Dict, Optional

from ..services.gpt_service import GptService

from ..config import ConfigManager


class AnswerAligner:
    """LLM-powered normalizer for slot-filling answers.

    Given a field we are asking for (e.g., quantity, to_box, object_name)
    and the raw user answer, return a normalized JSON dict with keys:
      - remove_all: bool
      - quantity: int | null
      - box_name: str | null   (single letter if applicable; used as input alias but we output into to_box at callsite)
      - object_name: str | null
    Only fill the field being asked (and remove_all when implied). Others may be null.
    """

    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.gpt = GptService(self.config)

    def normalize(self, field: str, answer: str, context: Dict[str, Any] | None = None) -> Dict[str, Optional[str | int | bool]]:
        ctx = context or {}
        # Build strict instruction to minimize drift
        prompt = (
            "You are an information extraction agent for inventory voice UI.\n"
            "Extract ONLY the requested field from the user's answer, plus remove_all when implied.\n"
            "Return STRICT JSON with keys: remove_all(boolean), quantity(integer|null), box_name(string|null), object_name(string|null).\n"
            "Rules:\n"
            "- If the answer indicates all items (e.g., 'all', 'all of them', 'everything'), set remove_all=true and other fields null.\n"
            "- If asking for quantity, return quantity as an integer when present; map number words (one..twenty) to ints.\n"
            "- If asking for a box (box letter), map spoken letters to single letters (bee->b, see->c, etc.).\n"
            "- If asking for object_name, return a concise item name without articles.\n"
            "- Do NOT invent values. If not present, set the field to null.\n"
            "- Do not include any commentary.\n"
            f"Field: {field}\n"
            f"Context: {ctx}\n"
            f"Answer: {answer!r}"
        )
        try:
            content = self.gpt.chat(prompt, temperature=0)
            import json

            data = json.loads(content)
            out: Dict[str, Optional[str | int | bool]] = {
                "remove_all": bool(data.get("remove_all")) if isinstance(data.get("remove_all"), bool) else False,
                "quantity": None,
                "box_name": None,
                "object_name": None,
            }
            q = data.get("quantity")
            if isinstance(q, int):
                out["quantity"] = q
            elif isinstance(q, str) and q.isdigit():
                out["quantity"] = int(q)
            b = data.get("box_name")
            if isinstance(b, str) and b:
                out["box_name"] = b.strip()
            o = data.get("object_name")
            if isinstance(o, str) and o:
                out["object_name"] = o.strip()
            return out
        except Exception:
            # On any failure, return empty normalization so caller can fallback
            return {"remove_all": False, "quantity": None, "box_name": None, "object_name": None}


__all__ = ["AnswerAligner"]

