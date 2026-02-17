from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, PositiveInt, field_validator

from ..util.idgen import new_ulid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Box(BaseModel):
    id: str = Field(default_factory=new_ulid)
    name: str
    created_at: str = Field(default_factory=_now_iso)

    @field_validator("name")
    @classmethod
    def _name_not_empty(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Box name cannot be empty")
        return v


class Item(BaseModel):
    id: str = Field(default_factory=new_ulid)
    name: str
    canonical_name: str
    quantity: int = 0
    box_id: str
    created_at: str = Field(default_factory=_now_iso)

    @field_validator("name", "canonical_name")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Item fields cannot be empty")
        return v

    @field_validator("quantity")
    @classmethod
    def _non_negative(cls, v: int) -> int:
        if v < 0:
            raise ValueError("Quantity cannot be negative")
        return v


class Query(BaseModel):
    raw_text: str
    normalized_text: str


class InventoryChange(BaseModel):
    id: str = Field(default_factory=new_ulid)
    change_type: Literal["ADD", "REMOVE", "MOVE"]
    item_id: str
    delta: int = 0  # +n for add, -n for remove, 0 for move
    from_box_id: Optional[str] = None
    to_box_id: Optional[str] = None
    timestamp: str = Field(default_factory=_now_iso)


__all__ = [
    "Box",
    "Item",
    "Query",
    "InventoryChange",
]

