from __future__ import annotations

from typing import Any, Dict, List, Optional
import json
from urllib import request, parse, error
import re

import logging
from ..config import ConfigManager
from ..domain.models import Box, Item


class AirtableClient:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.log = logging.getLogger("AirtableClient")
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        token = self.settings.airtable_token or self.settings.airtable_api_key
        if not token or not self.settings.airtable_base_id:
            raise RuntimeError("Airtable token and Base ID are required in settings.")
        self.base_url = f"https://api.airtable.com/v0/{self.settings.airtable_base_id}"
        self.headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        # Two-table model
        self.boxes_table = getattr(self.settings, "airtable_boxes_table", "Boxes") or "Boxes"
        self.items_table = getattr(self.settings, "airtable_items_table", "Items") or "Items"
        self.items_link_field = getattr(self.settings, "airtable_items_link_field", "link_to_box") or "link_to_box"
        # Explicit primary/title fields (deterministic, no guessing)
        self.boxes_name_field = getattr(self.settings, "airtable_boxes_name_field", "Name") or "Name"
        self.items_name_field = getattr(self.settings, "airtable_items_name_field", "Name") or "Name"
        self.items_quantity_field = getattr(self.settings, "airtable_items_quantity_field", "quantity") or "quantity"

    def _table_url(self, table_name: str) -> str:
        # URL-encode table names like "Table 1" → "Table%201"
        table_segment = parse.quote(table_name, safe="")
        return f"{self.base_url}/{table_segment}"

    # -------------- Boxes --------------
    def list_boxes(self) -> List[Box]:
        # List boxes from Boxes table
        url = self._table_url(self.boxes_table)
        params: Dict[str, str] = {"pageSize": "100"}
        offset: Optional[str] = None
        names: Dict[str, str] = {}
        while True:
            if offset:
                params["offset"] = offset
            data = self._http_json("GET", url, params=params)
            for r in data.get("records", []):
                fields = r.get("fields", {})
                bname = str(fields.get(self.boxes_name_field, "")).strip()
                if bname and bname not in names:
                    names[bname] = r["id"]
            offset = data.get("offset")
            if not offset:
                break
        return [Box(id=rid, name=bn) for bn, rid in names.items()]

    def create_box(self, name: str) -> Box:
        # Create box record in Boxes table
        payload = {"fields": {self.boxes_name_field: name}}
        try:
            data = self._http_json("POST", self._table_url(self.boxes_table), body=payload)
        except RuntimeError:
            data = self._http_json("POST", self._table_url(self.boxes_table), body={"fields": {self.boxes_name_field: name}})
        return Box(id=data["id"], name=name)

    # -------------- Items --------------
    def list_items(self) -> List[Item]:
        out: List[Item] = []
        url = self._table_url(self.items_table)
        params: Dict[str, str] = {"pageSize": "100"}
        offset: Optional[str] = None
        while True:
            if offset:
                params["offset"] = offset
            data = self._http_json("GET", url, params=params)
            for r in data.get("records", []):
                f = r.get("fields", {})
                name = f.get(self.items_name_field) or ""
                canonical = f.get("canonical_name") or name
                qty = int(f.get(self.items_quantity_field, 0) or 0)
                link = f.get(self.items_link_field) or []
                box = link[0] if isinstance(link, list) and link else ""
                if not (name and box):
                    # try Notes JSON fallback
                    notes = f.get("Notes") or f.get("notes") or ""
                    try:
                        meta = json.loads(notes) if isinstance(notes, str) else notes
                        if meta:
                            box = box or meta.get("box_name", "")
                            name = name or meta.get("item_name", "")
                            canonical = canonical or meta.get("canonical_name", name)
                            qty = int(meta.get(self.items_quantity_field, qty) or 0)
                    except Exception:
                        pass
                # Skip placeholder rows (e.g., box-only rows) that don't represent an item
                if not name or not box:
                    continue
                out.append(Item(id=r["id"], name=str(name), canonical_name=str(canonical), quantity=int(qty), box_id=str(box)))
            offset = data.get("offset")
            if not offset:
                break
        return out

    def add_item(self, item: Item | None = None, *, name: Optional[str] = None, canonical: Optional[str] = None, quantity: Optional[int] = None, box_name: Optional[str] = None) -> Item:
        # Support both Item object and named args
        if item is None:
            item = Item(name=str(name or ""), canonical_name=str(canonical or (name or "")), quantity=int(quantity or 0), box_id=str(box_name or ""))
        # Deterministic write: title + link (+ quantity if field exists)
        fields: Dict[str, Any] = {self.items_name_field: item.name, self.items_link_field: [item.box_id]}
        # Try to include quantity; if Airtable rejects the field name, retry without it
        try:
            data = self._http_json("POST", self._table_url(self.items_table), body={"fields": {**fields, self.items_quantity_field: item.quantity}})
        except RuntimeError as e:
            if f'"{self.items_quantity_field}"' in str(e) and "Unknown field name" in str(e):
                data = self._http_json("POST", self._table_url(self.items_table), body={"fields": fields})
            else:
                raise
        item.id = data["id"]
        return item

    def update_item_quantity(self, item_id: str, new_qty: int) -> Optional[Item]:
        # Try to update quantity; if field doesn't exist, skip update gracefully
        try:
            # PATCH may return 204 with empty body; treat that as success and follow with GET
            _ = self._http_json("PATCH", f"{self._table_url(self.items_table)}/{item_id}", body={"fields": {self.items_quantity_field: new_qty}})
        except RuntimeError as e:
            if f'"{self.items_quantity_field}"' in str(e) and "Unknown field name" in str(e):
                # Field missing: read current record without change
                rec = self._http_json("GET", f"{self._table_url(self.items_table)}/{item_id}")
            else:
                raise
        else:
            # Successful PATCH (even with empty body) → read fresh record
            rec = self._http_json("GET", f"{self._table_url(self.items_table)}/{item_id}")

        f = rec.get("fields", {})
        name = f.get(self.items_name_field) or ""
        canonical = f.get("canonical_name") or name
        qty = int(f.get(self.items_quantity_field, 0) or 0)
        # link field
        link = f.get(self.items_link_field) or []
        box = link[0] if isinstance(link, list) and link else ""
        if not name or not box:
            return None
        return Item(id=item_id, name=str(name), canonical_name=str(canonical), quantity=int(qty), box_id=str(box))

    def move_item_to_box(self, item_id: str, new_box_id: str) -> Optional[Item]:
        """Update the item's link-to-box to a different box and return the updated item."""
        try:
            _ = self._http_json("PATCH", f"{self._table_url(self.items_table)}/{item_id}", body={"fields": {self.items_link_field: [new_box_id]}})
        except RuntimeError:
            # If PATCH returns empty, still fetch updated record
            pass
        rec = self._http_json("GET", f"{self._table_url(self.items_table)}/{item_id}")
        f = rec.get("fields", {})
        name = f.get(self.items_name_field) or ""
        canonical = f.get("canonical_name") or name
        qty = int(f.get(self.items_quantity_field, 0) or 0)
        link = f.get(self.items_link_field) or []
        box = link[0] if isinstance(link, list) and link else ""
        if not name or not box:
            return None
        return Item(id=item_id, name=str(name), canonical_name=str(canonical), quantity=int(qty), box_id=str(box))

    def get_item(self, item_id: str) -> Optional[Item]:
        try:
            rec = self._http_json("GET", f"{self._table_url(self.items_table)}/{item_id}")
        except Exception:
            return None
        f = rec.get("fields", {})
        name = f.get(self.items_name_field) or ""
        canonical = f.get("canonical_name") or name
        qty = int(f.get(self.items_quantity_field, 0) or 0)
        link = f.get(self.items_link_field) or []
        box = link[0] if isinstance(link, list) and link else ""
        if not name or not box:
            return None
        return Item(id=item_id, name=str(name), canonical_name=str(canonical), quantity=int(qty), box_id=str(box))

    def delete_item(self, item_id: str) -> bool:
        try:
            self._http_json("DELETE", f"{self._table_url(self.items_table)}/{item_id}")
            return True
        except Exception:
            return False

    # -------------- Box deletion --------------
    def delete_box(self, box_id: str) -> bool:
        try:
            self._http_json("DELETE", f"{self._table_url(self.boxes_table)}/{box_id}")
            return True
        except Exception:
            return False

    # -------------- HTTP helper --------------
    def _http_json(self, method: str, url: str, body: Optional[Dict[str, Any]] = None, params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        if params:
            qs = parse.urlencode(params)
            sep = '&' if ('?' in url) else '?'
            url = f"{url}{sep}{qs}"
        data_bytes = None
        headers = self.headers.copy()
        if body is not None:
            data_bytes = json.dumps(body).encode('utf-8')
        # log without secrets
        safe_url = re.sub(r"/v0/([^/]+)/", "/v0/BASE/", url)
        self.log.info("HTTP %s %s", method, safe_url)
        req = request.Request(url, data=data_bytes, method=method, headers=headers)
        try:
            with request.urlopen(req, timeout=20) as resp:
                resp_body = resp.read().decode('utf-8')
                if resp_body:
                    self.log.debug("HTTP %s %s -> %s", method, safe_url, resp.status)
                    return json.loads(resp_body)
                return {}
        except error.HTTPError as e:
            try:
                detail = e.read().decode('utf-8')
            except Exception:
                detail = str(e)
            self.log.error("HTTP error %s for %s: %s", e.code, safe_url, detail)
            raise RuntimeError(f"Airtable HTTP {e.code}: {detail}")


__all__ = ["AirtableClient"]

