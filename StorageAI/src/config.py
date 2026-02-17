from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field, ValidationError


class AppSettings(BaseModel):
    """Serializable application settings persisted to api_keys.json.

    Note: These include API keys and IDs needed by the app. This file replaces
    environment variable usage so the user only enters keys once.
    """

    # Core API keys
    openai_api_key: str = ""
    pinecone_api_key: str = ""

    # Airtable
    airtable_api_key: str = ""  # deprecated naming; kept for compat
    airtable_token: str = ""  # preferred Personal Access Token
    airtable_base_id: str = ""
    # Two-table linked model (best practice)
    airtable_boxes_table: str = "Boxes"
    airtable_items_table: str = "Items"
    airtable_items_link_field: str = "link_to_box"  # Name of linked-record field in Items pointing to Boxes
    # Explicit title fields (Airtable primary field label) for each table
    airtable_boxes_name_field: str = "Name"
    airtable_items_name_field: str = "Name"
    # Optional additional fields
    airtable_items_quantity_field: str = "quantity"

    # Vector DB/Embedding config
    pinecone_host: str = ""  # e.g. https://your-index.svc.region.pinecone.io
    openai_embedding_dimensions: int = 512  # must match your Pinecone index dimension

    # Models and voice defaults
    openai_chat_model: str = "gpt-4o-mini"
    openai_whisper_model: str = "whisper-1"
    openai_tts_voice: str = "alloy"
    openai_tts_model: str = "gpt-4o-mini-tts"

    # Search thresholds
    semantic_match_threshold: float = 0.75

    # Metadata
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ConfigManager:
    """Handles load/save of `api_keys.json` at the project root.

    The config file is created if missing with default values. On POSIX systems,
    permissions are set to 600 to limit access.
    """

    def __init__(self, root_dir: Optional[Path] = None) -> None:
        self.root_dir: Path = root_dir or Path(__file__).resolve().parents[1]
        self.config_path: Path = self.root_dir / "api_keys.json"

    def ensure_exists(self) -> None:
        if not self.config_path.exists():
            self.save(AppSettings())

    def load(self) -> AppSettings:
        if not self.config_path.exists():
            self.ensure_exists()
        try:
            content = self.config_path.read_text(encoding="utf-8")
            data: Dict[str, Any] = json.loads(content or "{}")
            return AppSettings(**data)
        except (json.JSONDecodeError, ValidationError):
            # If file is corrupt or invalid, back it up and reset
            backup_path = self.config_path.with_suffix(".bak")
            try:
                self.config_path.replace(backup_path)
            except Exception:
                pass
            settings = AppSettings()
            self.save(settings)
            return settings

    def save(self, settings: AppSettings) -> None:
        # update timestamp
        settings.updated_at = datetime.now(timezone.utc).isoformat()
        payload = settings.model_dump()
        tmp_path = self.config_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp_path, self.config_path)
        self._harden_permissions()

    def get(self, key: str, default: Optional[Any] = None) -> Any:
        settings = self.load()
        return getattr(settings, key, default)

    def set(self, key: str, value: Any) -> AppSettings:
        settings = self.load()
        if not hasattr(settings, key):
            raise KeyError(f"Unknown config key: {key}")
        setattr(settings, key, value)
        self.save(settings)
        return settings

    def _harden_permissions(self) -> None:
        # Best-effort permission hardening on POSIX
        try:
            if os.name == "posix":
                os.chmod(self.config_path, 0o600)
        except Exception:
            pass


def get_config_manager() -> ConfigManager:
    return ConfigManager()


__all__ = ["AppSettings", "ConfigManager", "get_config_manager"]

