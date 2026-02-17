from __future__ import annotations

import re
from typing import Dict, Literal, Optional

from ..services.gpt_service import GptService

from ..config import ConfigManager


Intent = Literal["ADD", "REMOVE", "FIND", "ADD_BOX", "REMOVE_BOX", "CLEAR_BOX", "MOVE"]


class IntentParser:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.gpt = GptService(self.config)

    def parse(self, text: str) -> Dict[str, Optional[str]]:
        t = (text or "").strip().lower()
        # helpers
        def _normalize_box_name(name: str) -> str:
            n = (name or "").strip().lower()
            n = re.sub(r"[\.,!?]+$", "", n)
            if n.startswith("box "):
                n = n[4:].strip()
            spoken_to_letter = {
                "a": "a", "ay": "a",
                "b": "b", "be": "b", "bee": "b",
                "c": "c", "see": "c", "cee": "c",
                "d": "d", "dee": "d",
                "e": "e",
                "f": "f", "ef": "f",
                "g": "g", "gee": "g",
                "h": "h", "aitch": "h",
                "i": "i",
                "j": "j", "jay": "j",
                "k": "k", "kay": "k",
                "l": "l", "el": "l", "ell": "l",
                "m": "m", "em": "m",
                "n": "n", "en": "n",
                "o": "o",
                "p": "p", "pee": "p",
                "q": "q", "queue": "q", "cue": "q",
                "r": "r", "ar": "r", "are": "r",
                "s": "s", "ess": "s",
                "t": "t", "tee": "t",
                "u": "u", "you": "u",
                "v": "v", "vee": "v",
                "w": "w", "double u": "w",
                "x": "x",
                "y": "y", "why": "y",
                "z": "z", "zee": "z", "zed": "z",
            }
            if n in spoken_to_letter:
                return spoken_to_letter[n]
            return n
        def _normalize_item(name: str) -> str:
            name = (name or "").strip().lower()
            # Remove trailing punctuation
            name = re.sub(r"[\.,!?]+$", "", name)
            # strip leading determiners/modifiers
            for art in ("a ", "an ", "the ", "some ", "any ", "more ", "another ", "additional ", "extra "):
                if name.startswith(art):
                    name = name[len(art):]
                    break
            # Remove common quantity/measure phrases e.g. 'sticks of', 'pieces of', 'bottles of'
            name = re.sub(r"^(?:\d+\s+)?(?:sticks|pieces|bottles|packs|boxes|bags|rolls|sets|cups|slices|loaves|cans|bunches|pairs|bars|tubes|tubs|cartons|cases|batches)\s+of\s+", "", name)
            # Remove plural descriptors at start like 'more', 'extra'
            name = re.sub(r"^(?:more|extra|additional)\s+", "", name)
            # Remove trailing descriptive plurals like 'items', 'pieces'
            name = re.sub(r"\b(items|pieces|units)$", "", name)
            name = name.strip()
            # Basic singularization rules (lightweight):
            # - irregulars we care about
            irregulars = {
                "children": "child",
                "men": "man",
                "women": "woman",
                "people": "person",
                "teeth": "tooth",
                "feet": "foot",
                "mice": "mouse",
                "geese": "goose",
                "hangers": "hanger",
                "coat hangers": "coat hanger",
            }
            if name in irregulars:
                name = irregulars[name]
            else:
                # compound like 'coat hangers' → singularize last token
                tokens = name.split()
                if tokens:
                    last = tokens[-1]
                    if re.search(r"ies$", last):
                        last = re.sub(r"ies$", "y", last)
                    elif re.search(r"ses$", last):
                        last = re.sub(r"es$", "", last)
                    elif re.search(r"xes$|zes$|ches$|shes$", last):
                        last = re.sub(r"es$", "", last)
                    elif re.search(r"s$", last) and not re.search(r"ss$", last):
                        last = re.sub(r"s$", "", last)
                    tokens[-1] = last
                    name = " ".join(tokens)
            # collapse spaces
            name = re.sub(r"\s+", " ", name)
            return name.strip()

        def _qty_from_token(tok: Optional[str]) -> Optional[str]:
            if tok is None:
                return None
            tok = tok.strip().lower()
            word_map = {
                "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
                "a": 1, "an": 1,
            }
            if tok.isdigit():
                return tok
            if tok in word_map:
                return str(word_map[tok])
            return None

        def _postprocess(intent: Optional[str], obj: Optional[str], qty: Optional[str], box: Optional[str], to_box: Optional[str] = None, from_box: Optional[str] = None) -> Dict[str, Optional[str]]:
            # Default quantity to 1 if intent is ADD/REMOVE and not provided
            if (intent in ("ADD", "REMOVE")) and not qty:
                # Heuristics: presence of tokens implies 1
                if re.search(r"\b(one|a|an|another)\b", t):
                    qty = "1"
            # Infer intent from language if missing
            if not intent:
                if re.search(r"\b(add|adding|added|put|place|more|another|additional|extra)\b", t):
                    intent = "ADD"
                elif re.search(r"\b(remove|removing|removed|take|grab|less|fewer)\b", t):
                    intent = "REMOVE"
                elif re.search(r"\b(where is|find|do i have)\b", t):
                    intent = "FIND"
                elif re.search(r"\b(move|moving|relocate|relocating)\b", t):
                    intent = "MOVE"
            # Final normalized object
            obj = _normalize_item(obj or "") if obj else None
            # Unify destination: prefer to_box; allow legacy callers to read box_name only for box-level intents
            return {"intent": intent, "object_name": obj, "quantity": qty, "box_name": None, "to_box": to_box or box, "from_box": from_box}
        # MOVE item: "move <item> to box <X>" (source optional)
        m = re.search(r"(?:move|moving|put|place|relocate|relocating)\s+([a-z0-9 \-/]+?)\s+(?:from\s+(?:box\s+)?([a-z0-9_-]+)\s+)?(?:to|into|in)\s+(?:box\s+)?([a-z0-9_-]+)", t)
        if m:
            name = _normalize_item(m.group(1))
            from_box = _normalize_box_name(m.group(2)) if m.group(2) else None
            to_box = _normalize_box_name(m.group(3)) if m.group(3) else None
            return _postprocess("MOVE", name, None, None, to_box=to_box, from_box=from_box)

        # MOVE item without destination: prompt later for box
        # e.g., "can you move the pre-workout?"
        if re.search(r"\b(move|moving|relocate|relocating)\b", t) and not re.search(r"\b(to|into|in)\b", t):
            m = re.search(r"(?:move|moving|relocate|relocating|put|place)\s+([a-z0-9 \-/]+?)(?:\s*[\.!?]*)$", t)
            if m:
                name = _normalize_item(m.group(1))
                return _postprocess("MOVE", name, None, None, to_box=None, from_box=None)
        # Rule-first quick paths
        # ADD BOX (prefer explicit naming anywhere after the word 'box')
        m = re.search(r"(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box.*?(?:named|called|call(?:\s+it)?)\s+([a-z0-9_-]+)", t)
        if m:
            return {"intent": "ADD_BOX", "box_name": _normalize_box_name(m.group(1))}

        # ADD BOX (simple form immediately after 'box', but skip filler words like 'and')
        m = re.search(r"(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box\s+([a-z0-9_-]+)", t)
        if m:
            candidate = m.group(1)
            if candidate not in {"and", "then", "please", "named", "called", "call", "it"}:
                return {"intent": "ADD_BOX", "box_name": _normalize_box_name(candidate)}

        # ADD BOX (no name provided) → intent only; UI will slot-fill name
        if re.search(r"(?:add|create|make)\s+(?:a\s+)?(?:new\s+)?box\b", t):
            return {"intent": "ADD_BOX", "box_name": None}

        # REMOVE BOX (delete box if empty)
        m = re.search(r"(?:remove|delete)\s+(?:the\s+)?box\s+([a-z0-9_-]+)", t)
        if m:
            return {"intent": "REMOVE_BOX", "box_name": _normalize_box_name(m.group(1))}

        # CLEAR BOX (remove all items/everything from a box)
        m = re.search(r"(?:remove|removing|delete|clear)\s+(?:(?:all\s+)?(?:the\s+)?items?|everything)\s+(?:from|in|inside)\s+(?:box\s+)?([a-z0-9_-]+)", t)
        if m:
            return {"intent": "CLEAR_BOX", "to_box": _normalize_box_name(m.group(1)), "box_name": None}
        # CLEAR BOX fallback phrasing (e.g., "I'm removing everything from box D")
        m = re.search(r"(?:i\s*'?m\s+)?(?:going\s+to\s+)?(?:remove|removing|clear|delete)[^a-z0-9]+(?:everything|all)\s+(?:from|in|inside)\s+(?:box\s+)?([a-z0-9_-]+)", t)
        if m:
            return {"intent": "CLEAR_BOX", "to_box": _normalize_box_name(m.group(1)), "box_name": None}

        # ADD item (supports numeric or word quantities and strips leading articles from item name)
        m = re.search(
            r"(?:add(?:ing|ed)?|put|place)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?([a-z0-9 \-/]+?)\s+(?:to|into|in)\s+box\s+([a-z0-9_-]+)",
            t,
        )
        if m:
            qty = _qty_from_token(m.group(1)) or "1"
            name = _normalize_item(m.group(2))
            box = _normalize_box_name(m.group(3))
            return _postprocess("ADD", name, qty, box)

        # ADD item without explicit box ("add six coat hangers" / "add more coat hangers")
        m = re.search(
            r"(?:add(?:ing|ed)?|put|place)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?([a-z0-9 \-/]+?)(?:\s*[\.?!]*)$",
            t,
        )
        if m:
            qty = _qty_from_token(m.group(1)) or "1"
            name = _normalize_item(m.group(2))
            return _postprocess("ADD", name, qty, None)

        # REMOVE ALL
        m = re.search(r"(?:remove|removing|removed|take|grab)\s+all(?:\s+of\s+the)?\s+([a-z0-9 \-/]+)", t)
        if m:
            name = _normalize_item(m.group(1))
            return _postprocess("REMOVE", name, None, None) | {"remove_all": True}

        # REMOVE item (supports numeric or word quantities)
        m = re.search(r"(?:remove(?:ing|ed)?|take|grab)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|some)\s+)?([a-z0-9 \-/]+)", t)
        if m:
            qty = _qty_from_token(m.group(1)) or "1"
            name = _normalize_item(m.group(2))
            return _postprocess("REMOVE", name, qty, None)

        # Declarative REMOVE fallback (e.g., "i'm removing <item>.")
        m = re.search(r"(?:i\s*(?:am|\'m|’m)\s+)?remove(?:ing|ed)?\s+([a-z0-9 \-/]+)(?:\s*[\.!?]*)$", t)
        if m:
            name = _normalize_item(m.group(1))
            return _postprocess("REMOVE", name, None, None)

        # FIND item
        m = re.search(r"(?:do i have|where is|find)\s+([a-z0-9 \-/]+)\??", t)
        if m:
            name = m.group(1).strip()
            return _postprocess("FIND", name, None, None)

        # Fallback to LLM for structured extraction
        prompt = (
            "Extract inventory intent as strict JSON with keys: intent(one of ADD,REMOVE,FIND,ADD_BOX,REMOVE_BOX,CLEAR_BOX,MOVE), "
            "object_name(optional string), quantity(optional int), box_name(optional string), remove_all(optional bool), to_box(optional string), from_box(optional string). "
            "Rules:\n"
            "- If the user is naming a box (ADD_BOX), box_name must be the intended name: usually a single letter.\n"
            "- If they say 'box B' or 'call it C', set box_name='B' or 'C' (letter), not words like 'bee'/'see'.\n"
            "- Ignore filler words like 'and', 'then', 'please' as names.\n"
            "- For REMOVE ALL, set remove_all=true.\n"
            "- For object_name, return the core singular item name: strip phrases like 'sticks of', 'pieces of', 'bottles of', and convert common plurals to singular (e.g., 'coat hangers' → 'coat hanger', 'batteries' → 'battery').\n"
            "MOVE rules: item and to_box are required; from_box is optional and should be omitted if not provided; do not hallucinate boxes. "
            f"Text: {text!r}"
        )
        content = self.gpt.chat(prompt, temperature=0)
        # naive JSON extraction
        try:
            import json

            data = json.loads(content)
            obj = _normalize_item(str(data.get("object_name") or "")) or None
            qty_raw = data.get("quantity")
            qty = None
            if qty_raw is not None:
                qty = _qty_from_token(str(qty_raw)) or None
            out = _postprocess((data.get("intent") or None), obj, qty, data.get("box_name"), to_box=data.get("to_box"), from_box=data.get("from_box"))
            # heuristic: if user said 'all' and intent REMOVE, set remove_all
            if out.get("intent") == "REMOVE" and re.search(r"\ball\b|\beverything\b", t):
                out["remove_all"] = True
            return out
        except Exception:
            return {"intent": None}


__all__ = ["IntentParser", "Intent"]

