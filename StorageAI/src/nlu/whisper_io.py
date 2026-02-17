from __future__ import annotations

import io
import queue
import threading
from typing import Optional

import numpy as np
import sounddevice as sd
from openai import OpenAI

from ..config import ConfigManager


class AudioRecorder:
    def __init__(self, samplerate: int = 16000, silence_ms: int = 800, max_secs: int = 15, config: ConfigManager | None = None) -> None:
        self.samplerate = samplerate
        self.silence_ms = silence_ms
        self.max_secs = max_secs
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self._stream: Optional[sd.InputStream] = None
        self._frames: list[np.ndarray] = []
        self._queue: Optional[queue.Queue[np.ndarray]] = None

    def record_until_silence(self) -> bytes:
        q: queue.Queue[np.ndarray] = queue.Queue()
        frames: list[np.ndarray] = []
        silence_threshold = 200  # simple amplitude threshold
        silence_samples = int(self.samplerate * (self.silence_ms / 1000.0))
        silent_count = 0

        def callback(indata, frames_count, time_info, status):
            if status:
                pass
            q.put(indata.copy())

        with sd.InputStream(samplerate=self.samplerate, channels=1, dtype="int16", callback=callback):
            total_samples = 0
            while True:
                data = q.get()
                frames.append(data)
                total_samples += len(data)
                # simplistic silence detection
                if np.max(np.abs(data)) < silence_threshold:
                    silent_count += len(data)
                else:
                    silent_count = 0
                if silent_count >= silence_samples:
                    break
                if total_samples >= self.samplerate * self.max_secs:
                    break

        buf = io.BytesIO()
        # Write raw PCM 16-bit little endian into WAV header
        import wave

        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.samplerate)
            w.writeframes(b"".join([f.tobytes() for f in frames]))
        return buf.getvalue()

    # Manual start/stop capture (no silence detection)
    def start_stream(self) -> None:
        if self._stream is not None:
            return
        self._frames = []

        def callback(indata, frames_count, time_info, status):
            if status:
                pass
            self._frames.append(indata.copy())

        self._stream = sd.InputStream(samplerate=self.samplerate, channels=1, dtype="int16", callback=callback)
        self._stream.start()

    def stop_and_get_wav(self) -> bytes:
        if self._stream is None:
            return b""
        try:
            self._stream.stop()
            self._stream.close()
        finally:
            self._stream = None
        frames = self._frames
        self._frames = []
        if not frames:
            return b""
        import wave
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.samplerate)
            w.writeframes(b"".join([f.tobytes() for f in frames]))
        return buf.getvalue()


class WhisperTranscriber:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.client = OpenAI(api_key=self.settings.openai_api_key)

    def transcribe(self, wav_bytes: bytes) -> str:
        # Send as file-like to OpenAI audio transcription
        # openai>=1.0 client expects file-like in create with content_type
        file = ("audio.wav", wav_bytes, "audio/wav")
        result = self.client.audio.transcriptions.create(
            model=self.settings.openai_whisper_model,
            file=file,
        )
        # response shape may vary; handle common field
        text = getattr(result, "text", None)
        if text is None and hasattr(result, "data") and result.data:
            text = result.data[0].text
        return text or ""


__all__ = ["AudioRecorder", "WhisperTranscriber"]

