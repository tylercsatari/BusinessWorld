from __future__ import annotations

from typing import Any, Dict, List, Optional

from openai import OpenAI

from ..config import ConfigManager


class GptService:
    """Unified wrapper around OpenAI for chat and TTS.

    Single place to configure the client and models. Other modules should depend
    on this service instead of instantiating OpenAI directly.
    """

    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.client = OpenAI(api_key=self.settings.openai_api_key)
        self.chat_model = getattr(self.settings, "openai_chat_model", "o3")
        self.tts_model = getattr(self.settings, "openai_tts_model", "gpt-4o-mini-tts")
        self.tts_voice = getattr(self.settings, "openai_tts_voice", "alloy")

    # -----------------
    # Chat Completions
    # -----------------
    def chat(self, prompt: str, *, temperature: float = 0) -> str:
        """Simple chat call with a single user message; returns content string."""
        resp = self.client.chat.completions.create(
            model=self.chat_model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )
        return (resp.choices[0].message.content or "").strip()

    def chat_messages(self, messages: List[Dict[str, Any]], *, temperature: float = 0) -> str:
        """Advanced chat call with explicit messages list; returns content string."""
        resp = self.client.chat.completions.create(
            model=self.chat_model,
            messages=messages,
            temperature=temperature,
        )
        return (resp.choices[0].message.content or "").strip()

    # --------
    #   TTS
    # --------
    def tts_bytes(self, text: str) -> bytes:
        """Synthesize speech from text and return audio bytes."""
        if not text:
            return b""
        result = self.client.audio.speech.create(
            model=self.tts_model,
            voice=self.tts_voice,
            input=text,
        )
        # Normalize common return types to raw bytes
        if hasattr(result, "content") and isinstance(result.content, (bytes, bytearray)):
            return bytes(result.content)
        if hasattr(result, "read"):
            return result.read()
        if hasattr(result, "getvalue"):
            return result.getvalue()
        return bytes(result)


__all__ = ["GptService"]

