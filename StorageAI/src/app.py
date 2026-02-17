from __future__ import annotations

import threading
import time

from .config import ConfigManager
from .nlu.whisper_io import AudioRecorder, WhisperTranscriber
from .nlu.parse_intent import IntentParser
from .services.inventory import InventoryService
from .services.speech import TextToSpeech


class VoiceOrchestrator:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.rec = AudioRecorder(config=self.config)
        self.whisper = WhisperTranscriber(self.config)
        self.parser = IntentParser(self.config)
        self.inv = InventoryService(self.config)
        self.tts = TextToSpeech(self.config)
        self._lock = threading.Lock()

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def _on_wake(self) -> None:
        # serialize interactions to avoid overlapping
        if not self._lock.acquire(blocking=False):
            return
        try:
            wav = self.rec.record_until_silence()
            text = self.whisper.transcribe(wav)
            result = self.parser.parse(text)
            intent = (result.get("intent") or "").upper()
            response = "Sorry, I didn't get that."
            if intent == "ADD_BOX" and result.get("box_name"):
                box = self.inv.add_box(result["box_name"]) 
                response = f"Box {box.name} added."
            elif intent == "ADD" and result.get("object_name") and result.get("box_name"):
                qty = int(result.get("quantity") or 1)
                item = self.inv.add_item(result["object_name"], qty, result["box_name"]) 
                response = f"Added {qty} {item.name} to box {result['box_name']}."
            elif intent == "REMOVE" and result.get("object_name"):
                qty = int(result.get("quantity") or 1)
                updated = self.inv.remove_item(result["object_name"], qty)
                if updated is None:
                    response = f"I couldn't find {result['object_name']}."
                else:
                    response = f"Removed {qty}. New quantity is {updated.quantity}."
            elif intent == "FIND" and result.get("object_name"):
                item, score = self.inv.find_item_by_semantic(result["object_name"]) 
                if item is None:
                    response = f"I couldn't find {result['object_name']}."
                else:
                    from .storage.sheets import SheetsClient
                    sc = SheetsClient(self.config)
                    boxes = {b.id: b.name for b in sc.list_boxes()}
                    box_name = boxes.get(item.box_id, "unknown")
                    response = f"{item.name} is in box {box_name}."
            self.tts.speak(response)
        finally:
            self._lock.release()


__all__ = ["VoiceOrchestrator"]

