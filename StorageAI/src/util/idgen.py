from __future__ import annotations

import uuid


def new_ulid() -> str:
    """Generate a unique identifier (UUID4-based fallback)."""
    # Kept function name for compatibility; uses stdlib UUID to avoid external dep
    return str(uuid.uuid4())


__all__ = ["new_ulid"]

