from __future__ import annotations

from typing import Dict, List, Optional
import re
import json

from ..services.gpt_service import GptService
from ..config import ConfigManager


class MultiIntentExtractor:
    """Simplified LLM-first extractor that returns a list of independent ops.

    Each op: { intent, object_name, quantity, to_box, from_box }
    - Quantities default to 1 for ADD/REMOVE if omitted.
    - Destination for ADD and CLEAR_BOX must be in to_box (single-letter when present).
    - MOVE uses to_box (destination) and optional from_box (source).
    """

    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.gpt = GptService(self.config)

    def extract(self, text: str) -> List[Dict[str, Optional[str]]]:
        t = (text or "").strip()
        if not t:
            return []
        prompt = (
            "You are an information extraction agent for an inventory app.\n"
            "Return a STRICT JSON array (no commentary, no code fences). Each element must be an object with keys:\n"
            "intent, object_name, quantity, to_box, from_box, box_name (ONLY for ADD_BOX/REMOVE_BOX), remove_all, everything.\n"
            "- intent ∈ [ADD, REMOVE, FIND, ADD_BOX, REMOVE_BOX, CLEAR_BOX, MOVE]\n"
            "- object_name: string or null\n"
            "- quantity: integer or null (default 1 for ADD/REMOVE if missing)\n"
            "- to_box: destination box name as a string or null. If the phrasing uses a letter (e.g., 'box B'), map spoken letters to the uppercase letter; otherwise keep the full name (e.g., 'escape room 1').\n"
            "- from_box: source box name as a string or null (MOVE only)\n"
            "- box_name: string or null ONLY when the user is naming a box for ADD_BOX or REMOVE_BOX\n"
            "- remove_all: boolean or null (true when removing all quantity of a named item)\n"
            "- everything: boolean or null. If user says 'everything' or 'all items', set everything=true to indicate the operation targets all items within the specified scope (e.g., a box).\n"
            "Rules:\n"
            "- Treat declarative and imperative forms as the same intent.\n"
            "- In 'add A and B and C into box X', set to_box='X' (or the full name) for A, B, and C.\n"
            "- If later '... and D and E into box Y', apply 'Y' only to D and E.\n"
            "- Items without a stated destination must have to_box=null.\n"
            "- Map spoken letters to their uppercase letter (bee→B, see/cee/sea→C).\n"
            "- If phrasing is 'remove all <item>' or 'remove all of the <item>' or 'remove everything <item>', set remove_all=true for that REMOVE op and set quantity=null.\n"
            "- If phrasing is 'remove everything from box A and box B' (or similar with multiple boxes), produce SEPARATE ops per box with everything=true; do not combine into an array field.\n"
            "- For FIND with 'everything' and a box, interpret as listing all items in that box (everything=true).\n"
            f"Text: {t!r}"
        )
        content = self.gpt.chat(prompt, temperature=0)
        # Save raw content for debugging/terminal printing
        try:
            self.last_raw = content
        except Exception:
            pass
        # Some models may include code fences; strip them to recover raw JSON
        def _strip_fences(s: str) -> str:
            s = s.strip()
            if s.startswith("```") and s.endswith("```"):
                s = s[3:-3].strip()
                if s.lower().startswith("json"):
                    s = s[4:].strip()
            return s
        try:
            arr = json.loads(_strip_fences(content))
            out: List[Dict[str, Optional[str]]] = []
            for el in arr if isinstance(arr, list) else []:
                try:
                    intent = (el.get("intent") or "").upper() or None
                    obj = el.get("object_name")
                    qty = el.get("quantity")
                    # normalize qty to string for downstream code
                    if isinstance(qty, int):
                        qty = str(qty)
                    # Prefer unified fields; allow fallback from legacy 'box_name' into 'to_box' for ADD/CLEAR_BOX
                    to_box = el.get("to_box") or el.get("box_name")
                    from_box = el.get("from_box")
                    # propagate remove_all if provided
                    remove_all = bool(el.get("remove_all")) if isinstance(el.get("remove_all"), bool) else False
                    everything = bool(el.get("everything")) if isinstance(el.get("everything"), bool) else False
                    out.append({
                        "intent": intent,
                        "object_name": obj,
                        "quantity": qty,
                        "to_box": to_box,
                        "from_box": from_box,
                        "remove_all": remove_all,
                        "everything": everything,
                    })
                except Exception as e:
                    # Log the error and continue to the next element
                    print(f"Error processing multi-intent element: {el}. Error: {e}")
                    pass  # Skip this element and continue processing others
            # Fallback: if the text clearly says 'remove all' or 'remove everything',
            # mark REMOVE ops with missing qty as remove_all.
            low = t.lower()
            if re.search(r"\bremove\s+(?:all|everything)\b", low):
                for op in out:
                    if op.get("intent") == "REMOVE" and not op.get("quantity"):
                        op["remove_all"] = True
                        # If phrasing was clearly about 'everything', also mark everything
                        op["everything"] = True
            # If exactly one destination box is present among ADD ops, propagate it to ADD ops missing to_box
            try:
                add_boxes = { (op.get("to_box") or "").strip(): 1 for op in out if (op.get("intent") == "ADD" and (op.get("to_box") or "").strip()) }
                unique_add_boxes = [b for b in add_boxes.keys() if b]
                if len(unique_add_boxes) == 1:
                    only_box = unique_add_boxes[0]
                    for op in out:
                        if op.get("intent") == "ADD" and not (op.get("to_box") or "").strip():
                            op["to_box"] = only_box
            except Exception:
                pass
            return out
        except Exception:
            return []


__all__ = ["MultiIntentExtractor"]


