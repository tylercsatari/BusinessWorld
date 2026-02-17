from __future__ import annotations

from typing import Any, Dict, List, Optional, Callable, Tuple
import json

from PyQt5.QtWidgets import QApplication

from ..config import ConfigManager
from ..services.inventory import InventoryService
from ..services.speech import TextToSpeech
from ..nlu.parse_intent import IntentParser
from ..nlu.multi_intent import MultiIntentExtractor
from ..nlu.answer_align import AnswerAligner
from ..nlu.whisper_io import AudioRecorder, WhisperTranscriber

import difflib
import re
import logging
from ..storage.airtable_client import AirtableClient
from ..services.inventory import Item


class SortingLogic:
    """Encapsulates voice intent handling and batch operation execution.

    UI concerns (painting, widgets) are delegated to callbacks provided by the caller.

    Expected callbacks passed to handle_voice_intent:
    - set_mic_state(str): 'idle' | 'recording' | 'processing'
    - log_step(title: str, detail: str): append to UI log
    - format_op_pretty(op: dict) -> str: pretty printer for terminal output
    """

    def __init__(
        self,
        config: ConfigManager | None = None,
        *,
        inv: InventoryService,
        tts: TextToSpeech,
        intent: IntentParser,
        multi: MultiIntentExtractor,
        align: AnswerAligner,
        recorder: AudioRecorder,
        transcriber: WhisperTranscriber,
    ) -> None:
        self.config = config or ConfigManager()
        self.inv = inv
        self.tts = tts
        self.intent = intent
        self.multi = multi
        self.align = align
        self.recorder = recorder
        self.transcriber = transcriber

        # No caching of UI callbacks here; they are passed per-call

    # -------------------------
    # Public entry
    # -------------------------
    def handle_voice_intent(
        self,
        text: str,
        *,
        set_mic_state: Callable[[str], None],
        log_step: Callable[[str, str], None],
        format_op_pretty: Callable[[dict], str],
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> Optional[Dict[str, Any]]: # Returns op to re-process if suggestion selected
        ops = self.multi.extract(text)
        if not ops:
            parsed = self.intent.parse(text)
            log_step("Intent Parse", str(parsed))
            ops = [parsed] if parsed.get("intent") else []
        else:
            log_step("Intent Parse", f"{ops}")

        # Print raw LLM + parsed ops
        if len(ops) >= 1:
            try:
                raw = getattr(self.multi, "last_raw", None)
                if raw:
                    print("\n--- Raw LLM extraction ---\n")
                    print(raw)
                    print("\n--- Parsed operations ---\n")
                else:
                    print("Planned operations (from MultiIntentExtractor):\n")
                print(f"Multi-intent detected: {'YES' if len(ops) > 1 else 'NO'}\n")
                for i, op in enumerate(ops, start=1):
                    print(f"  {i}. {format_op_pretty(op)}\n")
            except Exception:
                pass

        if not ops:
            self.tts.speak("Sorry, I didn't understand that.")
            log_step("Result", "Unknown intent")
            # Ensure mic is idle after unknown intent
            set_mic_state("idle")
            return None

        CHUNK = 5
        start = 0
        while start < len(ops):
            batch = ops[start:start+CHUNK]
            ok, spoken, suggestions, suggestion_ctx = self._process_ops_batch(
                batch,
                set_mic_state=set_mic_state,
                log_step=log_step,
                critical_message=critical_message,
                info_message=info_message,
                mirror_airtable_to_boxes=mirror_airtable_to_boxes,
            )
            if not ok:
                if suggestions:
                    # If there are suggestions, prompt the user via voice and get their selection.
                    # Use the context provided by the batch processor for the op that generated suggestions
                    original_intent = (suggestion_ctx or {}).get("intent", "").upper()
                    original_obj_name = (suggestion_ctx or {}).get("object_name", "")
                    if not original_intent or not original_obj_name:
                        # Fallback: keep prior behavior
                        original_op = batch[0]
                        original_intent = (original_op.get("intent") or "").upper()
                        original_obj_name = original_op.get("object_name") or ""

                    # Do not run interactive suggestions for ADD; skip gracefully
                    if original_intent == "ADD":
                        self.tts.speak(f"Skipping suggestions for {original_obj_name}.")
                        log_step("Result", f"Skipped suggestions for ADD '{original_obj_name}'.")
                        continue
                    # For FIND: be conclusive, not inquisitive → just print the top 3 and stop
                    if original_intent == "FIND":
                        top3 = ", ".join([f"{it.name} (score: {sc:.2f})" for it, sc in suggestions[:3]])
                        log_step("Result", f"Closest to '{original_obj_name}': {top3}")
                        # Do not prompt or re-run; proceed to next batch chunk
                        continue

                    selected_item = self._ask_for_suggestion(
                        original_intent,
                        original_obj_name,
                        suggestions,
                        set_mic_state,
                        log_step,
                    )

                    if selected_item:
                        # Build an op to re-process using the selected concrete item
                        new_op = {
                            "intent": original_intent,
                            "object_name": selected_item.name,
                            "quantity": "1",
                            "to_box": None,
                            "from_box": None,
                            "remove_all": False,
                            "resolved_item": selected_item,
                        }
                        # If the item has a box, prefer that for MOVE/FIND display context where relevant
                        if selected_item.box_id:
                            boxes = self.inv.store.list_boxes()
                            box_name_map = {b.id: b.name for b in boxes}
                            inferred_box = box_name_map.get(selected_item.box_id)
                            if inferred_box:
                                new_op["to_box"] = inferred_box
                        return new_op
                    else:
                        # If no suggestion was selected or user cancelled.
                        self.tts.speak("Operation cancelled.")
                        log_step("Result", "Operation cancelled by user.")
                        set_mic_state("idle")
                        return None
                else:
                    self.tts.speak("I couldn't get all the details. Cancelling this group.")
                    log_step("Result", "Batch cancelled due to missing info")
                    # Ensure mic is idle after cancelled batch
                    set_mic_state("idle")
                    return None
            if spoken:
                set_mic_state("processing")
                QApplication.processEvents()
                self.tts.speak(spoken)
            start += CHUNK
        
        # After all operations, set mic to idle and refresh UI
        set_mic_state("idle")
        mirror_airtable_to_boxes()
        return None

    def handle_add_item_action(
        self, name: str, qty: int, box_name: str,
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> None:
        if not self.config or not self.inv:
            critical_message("Initialization Error", "Services not initialized.")
            return
        try:
            self.inv.add_item(name.strip(), qty, box_name.strip())
            info_message("Added", f"Added {qty}x '{name}' to box '{box_name}'.")
            mirror_airtable_to_boxes()
        except Exception as exc:
            logging.getLogger("UI").exception("Add item failed")
            critical_message("Add Failed", str(exc))

    def handle_remove_item_action(
        self, name: str, qty: int,
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> None:
        if not self.config or not self.inv:
            critical_message("Initialization Error", "Services not initialized.")
            return
        try:
            updated = self.inv.remove_item(name.strip(), qty)
            if updated is None:
                info_message("Not Found", f"No item similar to '{name}' found.")
            else:
                info_message("Removed", f"Removed {qty}; new quantity: {updated.quantity}")
            mirror_airtable_to_boxes()
        except Exception as exc:
            logging.getLogger("UI").exception("Remove item failed")
            critical_message("Remove Failed", str(exc))

    def handle_find_item_action(
        self, name: str,
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
    ) -> None:
        if not self.config or not self.inv:
            critical_message("Initialization Error", "Services not initialized.")
            return
        try:
            item, score = self.inv.find_item_by_semantic(name.strip())
            if not item:
                info_message("Not Found", f"Could not find '{name}'.")
                return
            sc = AirtableClient(self.config)
            boxes = {b.id: b.name for b in sc.list_boxes()}
            box_name = boxes.get(item.box_id, "?")
            info_message("Found", f"{item.name} -> Box '{box_name}' (score {score:.2f})")
        except Exception as exc:
            logging.getLogger("UI").exception("Find item failed")
            critical_message("Find Failed", str(exc))

    def handle_add_box_action(
        self, box_name: str,
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> None:
        if not self.config or not self.inv:
            critical_message("Initialization Error", "Services not initialized.")
            return
        try:
            self.inv.add_box(box_name.strip())
            info_message("Added", f"Box '{box_name}' is ready.")
            mirror_airtable_to_boxes()
        except Exception as exc:
            logging.getLogger("UI").exception("Add box failed")
            critical_message("Add Box Failed", str(exc))

    def handle_sync_airtable_action(
        self,
        critical_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> None:
        if not self.config or not self.inv:
            critical_message("Initialization Error", "Services not initialized.")
            return
        try:
            store_boxes = self.inv.store.list_boxes()
            items = self.inv.store.list_items()
            box_id_to_name = {b.id: b.name for b in store_boxes}
            for it in items:
                self.inv.search.index_item(it, box_name=box_id_to_name.get(it.box_id, ""))
            mirror_airtable_to_boxes()
        except Exception as exc:
            logging.getLogger("UI").exception("Sync failed")
            critical_message("Sync Failed", str(exc))

    # -------------------------
    # Internals
    # -------------------------
    def _process_ops_batch(
        self,
        batch: List[dict],
        set_mic_state: Callable[[str], None],
        log_step: Callable[[str, str], None],
        critical_message: Callable[[str, str], None],
        info_message: Callable[[str, str], None],
        mirror_airtable_to_boxes: Callable[[], None],
    ) -> Tuple[bool, str, Optional[List[Tuple[Any, float]]], Optional[Dict[str, Any]]]:
        missing_prompts: List[tuple[int, str, str]] = []
        normalized: List[dict] = []
        for i, op in enumerate(batch):
            intent = (op.get("intent") or "").upper()
            obj = (op.get("object_name") or "").strip()
            qty = (op.get("quantity") or "").strip()
            to_box = (op.get("to_box") or op.get("box_name") or "").strip()
            from_box = (op.get("from_box") or "").strip()
            remove_all = bool(op.get("remove_all"))
            everything = bool(op.get("everything"))
            # Transform REMOVE-all-from-box into CLEAR_BOX to avoid item prompts
            if (intent == "REMOVE" and remove_all and to_box and not obj) or (intent == "REMOVE" and everything and to_box and not obj):
                intent = "CLEAR_BOX"
                obj = ""
                qty = ""
                remove_all = False
                everything = False
            normalized.append({
                "intent": intent,
                "object_name": obj,
                "quantity": qty,
                "to_box": to_box,
                "from_box": from_box,
                "remove_all": remove_all,
                "everything": everything,
            })
            if intent in ("ADD", "REMOVE"):
                if not obj and not (intent == "REMOVE" and to_box and everything):
                    missing_prompts.append((i, "object_name", "What item?"))
                if intent == "REMOVE" and not remove_all and not qty:
                    missing_prompts.append((i, "quantity", "How many?"))
            elif intent == "MOVE":
                if everything:
                    if not from_box:
                        missing_prompts.append((i, "from_box", "Move everything from which box?"))
                    if not to_box:
                        missing_prompts.append((i, "to_box", "Move to which box?"))
                else:
                    if not obj:
                        missing_prompts.append((i, "object_name", "What item to move?"))
                    if not to_box:
                        missing_prompts.append((i, "to_box", "Move to which box?"))
            elif intent in ("FIND",):
                if not obj and not (everything and to_box):
                    missing_prompts.append((i, "object_name", "What item?"))
            elif intent == "CLEAR_BOX":
                if not to_box:
                    missing_prompts.append((i, "to_box", "Which box should I clear?"))
            elif intent == "ADD_BOX":
                if not to_box:
                    missing_prompts.append((i, "to_box", "What should I name the new box?"))
            elif intent == "REMOVE_BOX":
                if not to_box:
                    missing_prompts.append((i, "to_box", "Which box should I remove?"))

        if missing_prompts:
            def _parse_quantity(ans: str) -> Optional[str]:
                try:
                    ans = (ans or "").strip().lower()
                    if not ans:
                        return None
                    m = re.search(r"\b(\d+)\b", ans)
                    if m:
                        return m.group(1)
                    word_map = {
                        "one":1, "two":2, "three":3, "four":4, "five":5,
                        "six":6, "seven":7, "eight":8, "nine":9, "ten":10,
                        "eleven":11, "twelve":12, "thirteen":13, "fourteen":14,
                        "fifteen":15, "sixteen":16, "seventeen":17, "eighteen":18,
                        "nineteen":19, "twenty":20,
                        "a":1, "an":1, "some":1,
                        "pair":2, "couple":2
                    }
                    pattern = r"\b(" + "|".join(map(re.escape, word_map.keys())) + r")\b"
                    mw = re.search(pattern, ans)
                    if mw:
                        return str(word_map[mw.group(1)])
                    return None
                except Exception:
                    return None

            retries_per_field = max(2, len(batch))

            def _required_fields(opn: dict) -> List[str]:
                if opn["intent"] == "ADD":
                    # Do not require to_box up-front; semantic search runs first and only then we may ask
                    return ["object_name"]
                if opn["intent"] == "REMOVE":
                    return ["object_name", "quantity"]
                if opn["intent"] == "MOVE":
                    if opn.get("everything"):
                        return ["from_box", "to_box"]
                    return ["object_name", "to_box"]
                if opn["intent"] == "FIND":
                    return ["object_name"]
                if opn["intent"] == "CLEAR_BOX":
                    return ["to_box"]
                if opn["intent"] == "ADD_BOX":
                    return ["to_box"]
                if opn["intent"] == "REMOVE_BOX":
                    return ["to_box"]
                return []

            for idx, opn in enumerate(normalized):
                for field in _required_fields(opn):
                    if field == "object_name" and opn.get("object_name"):
                        continue
                    if field == "quantity" and opn.get("quantity"):
                        continue
                    if field == "to_box" and opn.get("to_box"):
                        continue
                    intent = opn["intent"]
                    item = opn.get("object_name") or "the item"
                    if field == "to_box" and intent == "ADD":
                        q = f"Which box should I add {item} to?"
                    elif field == "quantity" and intent == "ADD":
                        q = f"How many {item} should I add?"
                    elif field == "quantity" and intent == "REMOVE":
                        try:
                            concrete = self.inv.resolve_semantic_to_store_item(item)
                            if concrete is not None and int(getattr(concrete, "quantity", 0)) <= 1:
                                opn["quantity"] = "1"
                                continue
                        except Exception:
                            pass
                        q = f"How many {item} should I remove? You can say 'all'."
                    elif field == "to_box" and intent == "MOVE":
                        q = f"Move {item} to which box?"
                    elif field == "from_box" and intent == "MOVE":
                        q = "Move everything from which box?"
                    elif field == "object_name" and intent in ("ADD","REMOVE","FIND"):
                        q = "What item?"
                    elif field == "to_box" and intent == "CLEAR_BOX":
                        q = "Which box should I clear?"
                    elif field == "to_box" and intent == "REMOVE_BOX":
                        q = "Which box should I remove?"
                    elif field == "to_box" and intent == "ADD_BOX":
                        q = "What should I name the new box?"
                    else:
                        q = f"Provide {field} for {intent}."

                    filled = False
                    for attempt in range(retries_per_field):
                        ans = self._ask_slot(q, set_mic_state, log_step)
                        if not ans:
                            continue
                        ctx = {"intent": intent, "object_name": item}
                        norm = self.align.normalize(field, ans, context=ctx)
                        if norm.get("remove_all"):
                            opn["remove_all"] = True
                            filled = True
                            break
                        if field in ("to_box",) and norm.get("box_name"):
                            mapped = self._extract_box_name_from_reply(str(norm["box_name"]))
                            if mapped:
                                opn["to_box"] = mapped
                                filled = True
                                break
                            opn["to_box"] = str(norm["box_name"]).strip()
                            filled = True
                            break
                        if field == "quantity" and norm.get("quantity") is not None:
                            opn[field] = str(int(norm["quantity"]))
                            filled = True
                            break
                        if field == "object_name" and norm.get("object_name"):
                            opn[field] = str(norm["object_name"]).strip()
                            filled = True
                            break
                        if field in ("to_box",):
                            val = self._extract_box_name_from_reply(ans)
                            if val:
                                opn["to_box"] = val
                                filled = True
                                break
                        if field in ("from_box",):
                            val = self._extract_box_name_from_reply(ans)
                            if val:
                                opn["from_box"] = val
                                filled = True
                                break
                        elif field == "quantity":
                            lo = (ans or "").strip().lower()
                            if any(tok in lo for tok in ("all", "everything", "all of them")):
                                opn["remove_all"] = True
                                filled = True
                                break
                            val = _parse_quantity(ans)
                            if val:
                                opn[field] = val
                                filled = True
                                break
                        elif field == "object_name":
                            opn[field] = (ans or "").strip()
                            filled = True
                            break
                    if not filled:
                        return False, "", [], None

        # Execute
        summary_parts: List[str] = []
        suggestions: List[Tuple[Any, float]] = []
        suggestion_ctx: Optional[Dict[str, Any]] = None
        multi_mode = len(normalized) > 1
        for op in normalized:
            intent = op["intent"]
            obj = op.get("object_name") or ""
            qty_str = op.get("quantity") or None
            to_box = op.get("to_box") or op.get("box_name") or ""
            everything = bool(op.get("everything"))
            
            if intent == "ADD":
                item_to_process = op.get("resolved_item")
                qty = int(qty_str or 1)
                final_to_box = to_box # Use initial to_box or prompt if needed

                # First, try to add the item directly. This will either increment quantity of an existing item
                # or attempt to add a new one. The crucial part is that semantic search for existing items
                # is handled within add_item itself, *before* any box prompting logic here.
                try:
                    if item_to_process:
                        item, is_new_item = self.inv.add_item(item_to_process.name, qty, final_to_box)
                    else:
                        item, is_new_item = self.inv.add_item(obj, qty, final_to_box)
                    
                    # If it was an existing item (is_new_item is False), we are done, no box prompt needed.
                    if not is_new_item:
                        sc = AirtableClient(self.config)
                        boxes = {b.id: b.name for b in sc.list_boxes()}
                        actual_box = boxes.get(item.box_id, final_to_box or "?")
                        log_step("Done", f"Incremented {qty} {item.name} in box {actual_box} (id={item.id})")
                        summary_parts.append(f"incremented {qty} {item.name} in box {actual_box}")
                    else:
                        # It was a new item, and it was successfully added (use actual box from returned item).
                        sc = AirtableClient(self.config)
                        boxes = {b.id: b.name for b in sc.list_boxes()}
                        actual_box = boxes.get(item.box_id, final_to_box or "?")
                        log_step("Done", f"Added {qty} {item.name} to box {actual_box} (id={item.id})")
                        summary_parts.append(f"added {qty} {item.name} to box {actual_box}")
                except ValueError as ve:
                    # This ValueError would typically be "Box X not found for new item."
                    # We only prompt for a box if it's a new item and the box was missing/invalid.
                    # is_new_item check is critical here to ensure we don't prompt for existing items.
                    if (
                        "Box '' not found" in str(ve)
                        or "Box 'None' not found" in str(ve)
                        or "Box '' not found for new item." in str(ve)
                        or (str(ve).startswith("Box '") and "not found" in str(ve))
                    ):
                        # This means we tried to add a new item, but the box was missing/invalid.
                        q = f"Which box should I add {obj} to?"
                        raw_box_ans = self._ask_slot(q, set_mic_state, log_step)
                        if not raw_box_ans:
                            self.tts.speak("Skipping this item due to missing box information.")
                            log_step("Result", f"Skipped adding {obj}: missing box.")
                            # Continue with remaining operations
                            continue
                        # Normalize the spoken answer using LLM and robust mapping to single-letter box names.
                        try:
                            ctx = {"intent": "ADD", "object_name": obj}
                            norm = self.align.normalize("to_box", raw_box_ans, context=ctx) or {}
                        except Exception:
                            norm = {}
                        mapped_box = None
                        if norm.get("box_name"):
                            mapped_box = self._extract_box_name_from_reply(str(norm["box_name"]))
                            log_step("Box Resolve", f"'{raw_box_ans}' → '{mapped_box}' (LLM)")
                        else:
                            mapped_box = self._extract_box_name_from_reply(raw_box_ans)
                            if mapped_box != raw_box_ans:
                                log_step("Box Resolve", f"'{raw_box_ans}' → '{mapped_box}'")

                        # Validate against existing boxes; try fuzzy/phonetic resolution if needed
                        try:
                            sc = AirtableClient(self.config)
                            existing_names = [b.name.strip() for b in sc.list_boxes()]
                        except Exception:
                            existing_names = []
                        if mapped_box and mapped_box not in existing_names:
                            fallback = self._resolve_spoken_box_name(mapped_box, existing_names)
                            if fallback:
                                log_step("Box Resolve", f"'{mapped_box}' → '{fallback}' (match)")
                                mapped_box = fallback
                        if not mapped_box or (existing_names and mapped_box not in existing_names):
                            log_step("Error", f"Box '{raw_box_ans}' not found. Heard '{mapped_box or raw_box_ans}'.")
                            try:
                                self.tts.speak(f"I couldn't find box {raw_box_ans}.")
                            except Exception:
                                pass
                            continue

                        # Re-attempt add_item with the normalized/validated box. This time, it should work or re-raise.
                        try:
                            item, _ = self.inv.add_item(obj, qty, mapped_box)
                            log_step("Done", f"Added {qty} {item.name} to box {mapped_box} (id={item.id})")
                            summary_parts.append(f"added {qty} {item.name} to box {mapped_box}")
                        except ValueError as inner_ve:
                            log_step("Error", f"Failed to add {obj} to box {mapped_box}: {inner_ve}")
                            try:
                                self.tts.speak(f"Skipping {obj}. {inner_ve}")
                            except Exception:
                                pass
                            # Continue with remaining operations
                            continue
                    else:
                        # Other ValueErrors (e.g., actual database error, non-box related validation)
                        log_step("Error", f"Failed to add {obj}: {ve}")
                        self.tts.speak(f"Skipping {obj}. {ve}")
                        # Continue with remaining operations
                        continue
            elif intent == "REMOVE":
                item_to_process = op.get("resolved_item")
                if item_to_process:
                    if op.get("remove_all"):
                        updated, _ = self.inv.remove_item_all(item_to_process.name, resolved_item=item_to_process)
                    else:
                        qty = int(qty_str or 1)
                        updated, _ = self.inv.remove_item(item_to_process.name, qty, resolved_item=item_to_process)
                else:
                    if op.get("remove_all"):
                        updated, suggestions_for_remove = self.inv.remove_item_all(obj)
                    else:
                        if not qty_str:
                            try:
                                concrete = self.inv.resolve_semantic_to_store_item(obj)
                                if concrete is not None and int(getattr(concrete, "quantity", 0)) <= 1:
                                    qty_str = "1"
                            except Exception:
                                pass
                        qty = int(qty_str or 1)
                        updated, suggestions_for_remove = self.inv.remove_item(obj, qty)

                if updated is None:
                    log_step("Result", f"No matching item found for {obj}")
                    if suggestions_for_remove:
                        if multi_mode:
                            log_step("Result", f"Skipped REMOVE '{obj}' due to ambiguity.")
                            continue
                        return False, "", suggestions_for_remove, {"intent": intent, "object_name": obj}
                    # No suggestions; in multi-mode, skip; else return failure
                    if multi_mode:
                        log_step("Result", f"Skipped REMOVE '{obj}' (no match).")
                        continue
                    return False, "", [], None
                else:
                    if updated.quantity == 0:
                        log_step("Done", f"Removed all of {obj}")
                        summary_parts.append(f"removed all of {obj}")
                    else:
                        log_step("Done", f"Removed {qty} from {obj}")
                        summary_parts.append(f"removed {qty} from {obj}")
            elif intent == "MOVE":
                item_to_process = op.get("resolved_item")
                if bool(op.get("everything")) and from_box and to_box:
                    try:
                        moved = self.inv.move_all_items_between_boxes(from_box, to_box)
                    except ValueError as ve:
                        log_step("Error", str(ve))
                        continue
                    count = len(moved)
                    log_step("Done", f"Moved {count} item(s) from box {from_box} to box {to_box}")
                    try:
                        self.tts.speak(f"Moved {count} items from box {from_box} to box {to_box}.")
                    except Exception:
                        pass
                    if count:
                        summary_parts.append(f"moved {count} items from box {from_box} to box {to_box}")
                    continue
                if item_to_process:
                    updated, _ = self.inv.move_item(item_to_process.name, to_box, from_box, resolved_item=item_to_process)
                else:
                    updated, suggestions_for_move = self.inv.move_item(obj, to_box, from_box)
                if updated is None:
                    log_step("Result", f"Move failed for {obj}")
                    if suggestions_for_move:
                        if multi_mode:
                            log_step("Result", f"Skipped MOVE '{obj}' due to ambiguity.")
                            continue
                        return False, "", suggestions_for_move, {"intent": intent, "object_name": obj}
                    if multi_mode:
                        log_step("Result", f"Skipped MOVE '{obj}' (no match).")
                        continue
                    return False, "", [], None
                else:
                    log_step("Done", f"Moved {obj} to box {to_box}")
                    summary_parts.append(f"moved {obj} to box {to_box}")
            elif intent == "FIND":
                item_to_process = op.get("resolved_item")
                if everything and to_box:
                    # List all items in the specified box
                    sc = AirtableClient(self.config)
                    boxes = {b.name: b.id for b in sc.list_boxes()}
                    box_id = boxes.get(to_box)
                    if not box_id:
                        log_step("Result", f"Box {to_box} not found")
                        continue
                    items_in_box = [it for it in self.inv.store.list_items() if it.box_id == box_id]
                    if not items_in_box:
                        log_step("Result", f"No items in box {to_box}")
                        try:
                            self.tts.speak(f"No items in box {to_box}.")
                        except Exception:
                            pass
                        continue
                    names = ", ".join(sorted({it.name for it in items_in_box}))
                    log_step("Result", f"Items in box {to_box}: {names}")
                    try:
                        self.tts.speak(f"Items in box {to_box}: {names}.")
                    except Exception:
                        pass
                    continue
                if item_to_process:
                    item = item_to_process
                    score = 1.0
                else:
                    item, score, suggestions_for_find = self.inv.find_item_by_semantic(obj)

                if item is None:
                    log_step("Result", f"Couldn't find {obj}")
                    if suggestions_for_find:
                        # Conclusive: print top 3 and do not prompt
                        top3 = ", ".join([f"{it.name} (score: {sc:.2f})" for it, sc in suggestions_for_find[:3]])
                        log_step("Result", f"Closest to '{obj}': {top3}")
                        # Speak the outcome even when not found
                        try:
                            self.tts.speak(f"I couldn't find {obj}. Closest matches are: {top3}.")
                        except Exception:
                            pass
                        # In multi-mode, continue to next op; in single-op, just return success with no spoken summary
                        if multi_mode:
                            continue
                        return True, "", [], None
                    if multi_mode:
                        log_step("Result", f"Skipped FIND '{obj}' (no match).")
                        try:
                            self.tts.speak(f"I couldn't find {obj}.")
                        except Exception:
                            pass
                        continue
                    try:
                        self.tts.speak(f"I couldn't find {obj}.")
                    except Exception:
                        pass
                    return True, "", [], None
                else:
                    sc = AirtableClient(self.config)
                    boxes = {b.id: b.name for b in sc.list_boxes()}
                    # New: list all similar items above threshold
                    try:
                        all_hits = self.inv.search.find_all_above_threshold(obj, k=10, margin=0.0)
                    except Exception:
                        all_hits = []
                    if all_hits and len(all_hits) > 1:
                        details = []
                        for it, scv in all_hits:
                            bname = boxes.get(it.box_id, "?")
                            details.append(f"{it.name} in box {bname} (score {scv:.2f})")
                        joined = "; ".join(details)
                        log_step("Result", f"Similar items: {joined}")
                        try:
                            self.tts.speak(f"I found related items: {joined}.")
                        except Exception:
                            pass
                    # Always report the best hit as well
                    box_name = boxes.get(item.box_id, "?")
                    log_step("Result", f"Found {item.name} in box {box_name} (score {score:.2f})")
                    summary_parts.append(f"found {item.name} in box {box_name}")
            elif intent == "CLEAR_BOX":
                boxn = (op.get("to_box") or op.get("box_name") or "").strip()
                if not boxn:
                    return False, "", [], None
                deleted = self.inv.clear_box_items(boxn)
                log_step("Done", f"Cleared {deleted} items from box {boxn}")
                summary_parts.append(f"cleared {deleted} items from box {boxn}")
            elif intent == "ADD_BOX":
                name = (op.get("to_box") or op.get("box_name") or "").strip()
                if not name:
                    return False, "", []
                try:
                    box = self.inv.add_box(name)
                except Exception as exc:
                    log_step("Error", f"Failed to add box '{name}': {exc}")
                    continue
                # Speak and log a consistent message regardless of whether it already existed
                log_step("Done", f"Box '{box.name}' is ready.")
                try:
                    self.tts.speak(f"Box {box.name} is ready.")
                except Exception:
                    pass
                summary_parts.append(f"box '{box.name}' ready")
            elif intent == "REMOVE_BOX":
                name = (op.get("to_box") or op.get("box_name") or "").strip()
                if not name:
                    return False, "", []
                try:
                    removed = self.inv.remove_box_if_empty(name)
                except Exception as exc:
                    log_step("Error", f"Failed to remove box '{name}': {exc}")
                    try:
                        self.tts.speak(f"Failed to remove box {name}. {exc}")
                    except Exception:
                        pass
                    continue
                if removed:
                    log_step("Done", f"Removed box '{name}'")
                    try:
                        self.tts.speak(f"Removed box {name}.")
                    except Exception:
                        pass
                    summary_parts.append(f"removed box '{name}'")
                else:
                    log_step("Result", f"Box '{name}' not removed because it is not empty.")
                    try:
                        self.tts.speak(f"Box {name} is not empty. I didn't remove it.")
                    except Exception:
                        pass
        # refresh boxes grid handled by UI after return, but we can speak summary
        spoken = "; ".join(summary_parts).rstrip("; ")
        if spoken:
            spoken = spoken[0].upper() + spoken[1:]
        return True, spoken, suggestions, suggestion_ctx

    # -------------------------
    # Helpers used internally
    # -------------------------
    def _ask_slot(
        self,
        prompt: str,
        set_mic_state: Callable[[str], None],
        log_step: Callable[[str, str], None],
    ) -> str:
        try:
            for attempt in range(2):
                if not log_step or not set_mic_state:
                    raise ValueError("UI callbacks not set for _ask_slot")
                log_step("Ask", prompt)
                set_mic_state("processing")
                QApplication.processEvents()
                self.tts.speak(prompt)
                set_mic_state("recording")
                QApplication.processEvents()
                wav = self.recorder.record_until_silence()
                set_mic_state("processing")
                QApplication.processEvents()
                text = (self.transcriber.transcribe(wav) or "").strip()
                log_step("Heard", text or "<empty>")
                if not self._is_bad_transcript(text):
                    set_mic_state("idle")
                    return text
                log_step("Retry", f"Slot capture got noisy transcript '{text}'. Asking again.")
                prompt = f"Sorry, I didn't catch that. {prompt}"
            set_mic_state("idle")
            return ""
        except Exception:
            set_mic_state("idle")
            return ""

    def _is_bad_transcript(self, text: str) -> bool:
        t = (text or "").strip().lower()
        if not t:
            return True
        # Known spurious phrase observed when mic is silent
        if "mbc 뉴스" in t:
            return True
        return False

    def _extract_box_name_from_reply(self, reply: str) -> str:
        r = (reply or "").strip()
        # Strip conversational filler words from the beginning
        r = re.sub(r"^(?:also|and|then|just|put(?: it)? in|it'?s in|into)\s+", "", r, flags=re.IGNORECASE)
        # Handle patterns like "R as in Romeo" or spoken forms like "are as in Romeo"
        m_asin = re.search(r"^\s*([a-z])\s+as\s+in\b", r, flags=re.IGNORECASE)
        if m_asin:
            return m_asin.group(1).upper()
        m_asin_spoken = re.search(r"^\s*(are|ar)\s+as\s+in\b", r, flags=re.IGNORECASE)
        if m_asin_spoken:
            return "R"
        # Prefer trailing token after intent phrases
        m = re.search(r"(?:call(?:\s+it)?|called|name(?:\s+it)?)\s+(.+)$", r, flags=re.IGNORECASE)
        if m:
            r = m.group(1).strip()
        # Strip trailing punctuation
        r = re.sub(r"[\.,!?]+$", "", r)
        # Break into tokens and pick the first plausible box token
        tokens = re.split(r"[^a-zA-Z0-9]+", r)
        tokens = [t for t in tokens if t]
        if tokens:
            # Map spoken letters and common misinterpretations
            spoken_map = {
                "bee": "B", "be": "B", "b": "B",
                "cee": "C", "see": "C", "c": "C", "sea": "C",
                "dee": "D", "d": "D",
                "ay": "A", "a": "A",
                "ar": "R", "are": "R", "r": "R",
                "boxie": "C", "boxy": "C",
            }
            low0 = tokens[0].lower()
            if low0 in spoken_map:
                print(f"[DEBUG] Box name '{tokens[0]}' mapped to '{spoken_map[low0]}'.")
                return spoken_map[low0]
            # If the first token is a single letter, treat as box
            if len(tokens[0]) == 1 and tokens[0].isalpha():
                return tokens[0].upper()
        # Remove leading 'box '
        if r.lower().startswith("box "):
            r = r[4:].strip()
        # Map spoken letters and common misinterpretations
        spoken_map = {
            "bee": "B", "be": "B", "b": "B",
            "cee": "C", "see": "C", "c": "C", "sea": "C", # Added 'sea'
            "dee": "D", "d": "D",
            "ay": "A", "a": "A",
            "boxie": "C", "boxy": "C", # Added 'boxie' and 'boxy' for 'C'
        }
        low = r.lower()
        if low in spoken_map:
            print(f"[DEBUG] Box name '{r}' mapped to '{spoken_map[low]}'.") # Debug print
            return spoken_map[low]
        print(f"[DEBUG] Box name '{r}' not mapped. Using as is.") # Debug print
        return r

    def _resolve_spoken_box_name(self, spoken: str, existing: list[str]) -> str | None:
        """Resolve a spoken box name against existing names.

        - Strips leading 'box ' or 'box' and trailing punctuation.
        - Tries exact, then case-insensitive, then fuzzy match with a high cutoff.
        """
        original_spoken = spoken # For debug logging
        s = (spoken or "").strip()
        s = re.sub(r"[\.,!?]+$", "", s)
        s_lower = s.lower()

        # First, try _extract_box_name_from_reply for robust single-token resolution
        extracted = self._extract_box_name_from_reply(original_spoken) # Use original_spoken for full context
        if extracted and extracted in existing:
            print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{extracted}' via _extract_box_name_from_reply.")
            return extracted
        
        # Fallback to existing logic if _extract_box_name_from_reply didn't resolve it perfectly
        print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' not perfectly resolved by _extract_box_name_from_reply, falling back to other strategies.")

        # Early extraction: look anywhere for pattern 'box <letter/word>'
        # Map spoken letter words to single letters
        spoken_map = {
            "ay": "a", "a": "a",
            "bee": "b", "be": "b", "b": "b",
            "cee": "c", "see": "c", "c": "c", "sea": "c",
            "dee": "d", "d": "d",
            "ee": "e", "e": "e",
            "ef": "f", "f": "f",
            "gee": "g", "g": "g",
            "aitch": "h", "h": "h",
            "i": "i",
            "jay": "j", "j": "j",
            "kay": "k", "k": "k",
            "el": "l", "ell": "l", "l": "l",
            "em": "m", "m": "m",
            "en": "n", "n": "n",
            "o": "o",
            "pee": "p", "p": "p",
            "cue": "q", "queue": "q", "q": "q",
            "ar": "r", "are": "r", "r": "r",
            "ess": "s", "s": "s",
            "tee": "t", "t": "t",
            "you": "u", "u": "u",
            "vee": "v", "v": "v",
            "double u": "w", "w": "w",
            "x": "x",
            "why": "y", "y": "y",
            "zee": "z", "zed": "z", "z": "z",
            "boxie": "c", "boxy": "c",
        }
        existing_map = {name.lower(): name for name in existing}
        # 1) If the phrase contains 'box <token>' anywhere, try to extract
        m = re.search(r"\bbox\s+([a-z]+)\b", s_lower)
        if m:
            tok = m.group(1)
            # direct single letter
            if len(tok) == 1 and tok in existing_map:
                print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{existing_map[tok]}' via 'box <token>' match.")
                return existing_map[tok]
            # spoken word to letter
            if tok in spoken_map:
                letter = spoken_map[tok]
                if letter in existing_map:
                    print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{existing_map[letter]}' via spoken word to letter mapping.")
                    return existing_map[letter]
        # Strip leading 'box ' if present for subsequent checks
        if s_lower.startswith("box "):
            s = s[4:].strip()
            s_lower = s.lower()
            print(f"[DEBUG] _resolve_spoken_box_name: Stripped 'box ' prefix from '{original_spoken}' resulting in '{s}'.")
        elif s_lower == "box" and len(existing) == 1:
            print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{existing[0]}' as single existing box.")
            return existing[0]
        # 2) If there is any standalone single-letter token that exists, prefer it
        for tok in re.findall(r"\b[a-z]\b", s_lower):
            if tok in existing_map:
                print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{existing_map[tok]}' via standalone single letter token.")
                return existing_map[tok]
        # 3) If any existing short name appears as a substring token, prefer it
        for name in existing:
            if re.search(rf"\b{re.escape(name)}\b", s, flags=re.IGNORECASE):
                print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{name}' via substring token match.")
                return name
        # 1) exact
        if s in existing:
            print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{s}' via exact match.")
            return s
        # 2) case-insensitive exact
        for name in existing:
            if name.lower() == s.lower():
                print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{name}' via case-insensitive exact match.")
                return name
        # 3) fuzzy close match (lower cutoff when existing are single letters)
        cutoff = 0.8
        if all(len(n) == 1 for n in existing if n):
            cutoff = 0.5
        cand = difflib.get_close_matches(s, existing, n=1, cutoff=cutoff)
        if cand:
            print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' resolved to '{cand[0]}' via fuzzy match.")
            return cand[0]
        print(f"[DEBUG] _resolve_spoken_box_name: '{original_spoken}' could not be resolved.")
        return None

    def _prompt_select_candidate(
        self,
        candidates: List[Tuple[Any, float]],
        set_mic_state: Callable[[str], None],
        log_step: Callable[[str, str], None],
    ) -> Any | None:
        try:
            if not log_step or not set_mic_state:
                    raise ValueError("UI callbacks not set for _prompt_select_candidate")
            options_text = ", ".join([f"{idx+1}: {it.name} ({sc:.2f})" for idx, (it, sc) in enumerate(candidates)])
            say_text = f"I couldn't find an exact match. Options are: {options_text}. Say a number or the name."
            log_step("Ask", say_text)
            self.tts.speak(say_text)
        except Exception:
            pass
        # Capture reply
        reply_prompt = "Which one? Say a number or the name."
        log_step("Ask", reply_prompt)
        reply = self._ask_slot(reply_prompt, set_mic_state, log_step)
        if not reply:
            return None
        r = reply.strip().lower()
        # Number selection (digits, spelled, ordinals)
        word_to_num = {
            "one": 1, "first": 1, "1st": 1,
            "two": 2, "second": 2, "2nd": 2,
            "three": 3, "third": 3, "3rd": 3,
        }
        r_clean = re.sub(r"[\.,!?]+$", "", r)
        if r_clean.isdigit():
            idx = int(r_clean) - 1
            if 0 <= idx < len(candidates):
                return candidates[idx][0]
            return None
        if r_clean in word_to_num:
            idx = word_to_num[r_clean] - 1
            if 0 <= idx < len(candidates):
                return candidates[idx][0]
            return None
        # Extract first digit anywhere in the string
        m = re.search(r"\b(\d)\b", r_clean)
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(candidates):
                return candidates[idx][0]
            return None
        # Name selection: pick highest score whose name contains reply (case-insensitive)
        best = None
        best_score = -1.0
        for it, sc in candidates:
            if r in (it.name or "").lower():
                if sc > best_score:
                    best = it
                    best_score = sc
        return best

    def _ask_for_suggestion(
        self,
        op_intent: str, # Original intent (e.g., "REMOVE")
        original_object_name: str, # Original object name spoken by user
        suggestions: List[Tuple[Any, float]],
        set_mic_state: Callable[[str], None],
        log_step: Callable[[str, str], None],
    ) -> Optional[Item]: # Returns the selected Item object or None
        try:
            options_text = ", ".join([f'{idx+1}: {it.name} (score: {sc:.2f})' for idx, (it, sc) in enumerate(suggestions)])
            say_text = f"I couldn't find an exact match for '{original_object_name}'. Options are: {options_text}. Say a number or the name to proceed with the {op_intent} operation, or say nothing to cancel."
            log_step("Ask", say_text)
            self.tts.speak(say_text)

            reply_prompt = "Which one? Say a number or the name."
            log_step("Ask", reply_prompt)
            reply = self._ask_slot(reply_prompt, set_mic_state, log_step)
            if not reply:
                log_step("Suggestion Selection", "No suggestion selected. Operation cancelled.")
                self.tts.speak("Operation cancelled.")
                return None

            r = reply.strip().lower()
            word_to_num = {
                "one": 1, "first": 1, "1st": 1,
                "two": 2, "second": 2, "2nd": 2,
                "three": 3, "third": 3, "3rd": 3,
            }
            r_clean = re.sub(r"[\.,!?]+$", "", r)

            # Try to match by number
            if r_clean.isdigit():
                idx = int(r_clean) - 1
                if 0 <= idx < len(suggestions):
                    selected_item = suggestions[idx][0]
                    log_step("Suggestion Selection", f"Selected: {selected_item.name}")
                    return selected_item
            if r_clean in word_to_num:
                idx = word_to_num[r_clean] - 1
                if 0 <= idx < len(suggestions):
                    selected_item = suggestions[idx][0]
                    log_step("Suggestion Selection", f"Selected: {selected_item.name}")
                    return selected_item

            # Try to extract first digit anywhere in the string
            m = re.search(r"\b(\d)\b", r_clean)
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(suggestions):
                    selected_item = suggestions[idx][0]
                    log_step("Suggestion Selection", f"Selected: {selected_item.name}")
                    return selected_item

            # Try to match by name (case-insensitive, partial match)
            best_match_item = None
            best_score = -1.0
            for it, sc in suggestions:
                if r in (it.name or "").lower() or (it.canonical_name or "").lower():
                    if sc > best_score:
                        best_match_item = it
                        best_score = sc
            if best_match_item:
                log_step("Suggestion Selection", f"Selected: {best_match_item.name}")
                return best_match_item

            log_step("Suggestion Selection", "Invalid selection. Operation cancelled.")
            self.tts.speak("I didn't understand your selection. Operation cancelled.")
            return None
        except Exception as e:
            logging.getLogger("Logic").exception("Error during suggestion prompting")
            self.tts.speak("An error occurred while processing suggestions. Operation cancelled.")
            return None

__all__ = ["SortingLogic"]

