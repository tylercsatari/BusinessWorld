from __future__ import annotations

import io
from typing import Optional

import numpy as np
import sounddevice as sd
from .gpt_service import GptService

from ..config import ConfigManager


class TextToSpeech:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.gpt = GptService(self.config)

    def synthesize(self, text: str) -> bytes:
        if not text:
            return b""
        # OpenAI TTS (audio.speech) returns audio bytes; use mp3 for compatibility
        return self.gpt.tts_bytes(text)

    def speak(self, text: str) -> None:
        audio_bytes = self.synthesize(text)
        if not audio_bytes:
            return
        import soundfile as sf

        data, samplerate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        sd.play(data, samplerate=samplerate)
        sd.wait()


__all__ = ["TextToSpeech"]

