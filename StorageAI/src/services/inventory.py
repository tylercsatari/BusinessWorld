from __future__ import annotations

from typing import Optional, Tuple, List, Any
import re
import difflib

from ..config import ConfigManager
from ..domain.models import Box, Item
from ..storage.airtable_client import AirtableClient
from ..vector.search import SemanticSearch
from ..domain.canonicalize import CanonicalizeService


class InventoryService:
    """Business logic for inventory operations.

    Note: Semantic search will be layered in using the vector pipeline later.
    """

    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.store = AirtableClient(self.config)
        self.search = SemanticSearch(self.config)
        self.canonicalizer = CanonicalizeService()

    # ----------------------
    # Boxes
    # ----------------------
    def add_box(self, box_name: str) -> Box:
        # Try to find existing; GAS may not provide search by name, so scan
        target = (box_name or "").strip()
        for box in self.store.list_boxes():
            if box.name.strip().lower() == target.lower():
                return box
        # Create with uppercase canonical display
        return self.store.create_box(target.upper())

    def remove_box_if_empty(self, box_name: str) -> bool:
        box = self._find_box_by_name(box_name)
        if box is None:
            raise ValueError(f"Box '{box_name}' not found")
        # Check if any items link to this box
        for it in self.store.list_items():
            if it.box_id == box.id:
                # Not empty
                return False
        # Safe to delete
        try:
            return self.store.delete_box(box.id)  # type: ignore[attr-defined]
        except Exception:
            return False

    def clear_box_items(self, box_name: str) -> int:
        """Delete all item rows linked to a given box. Returns count deleted."""
        box = self._find_box_by_name(box_name)
        if box is None:
            raise ValueError(f"Box '{box_name}' not found")
        count = 0
        for it in list(self.store.list_items()):
            if it.box_id == box.id:
                if self.store.delete_item(it.id):
                    try:
                        self.search.delete_item(it.id)
                    except Exception:
                        pass
                    count += 1
        return count

    # ----------------------
    # Items
    # ----------------------
    def add_item(self, name: str, quantity: int, box_name: str) -> Tuple[Item, bool]:
        # Normalize both for search and storage: singularized canonical
        canonical = self.canonicalizer.normalize_to_singular(name)
        display_name = self.canonicalizer.normalize_to_singular_display(name)
        
        # Always perform semantic search to see if the item exists anywhere
        existing_match, score, suggestions = self.search.find_best_match(canonical)
        print(f"[DEBUG] Semantic search for ADD '{canonical}' returned score: {score} (Threshold: {self.search.threshold})")
        if suggestions:
            print(f"[DEBUG] Closest matches: {', '.join([f'{s.name} (score: {sc:.2f})' for s, sc in suggestions[:3]])}")

        if existing_match is not None and score >= self.search.threshold:
            full_item = self._get_item_by_id(existing_match.id)
            if full_item is not None:
                # If found, update its quantity in its existing box.
                new_qty = int(full_item.quantity) + int(quantity)
                updated = self.store.update_item_quantity(full_item.id, new_qty)
                print(f"[INFO] Item '{full_item.name}' exists in box '{self._get_box_name_by_id(full_item.box_id)}'. Incrementing quantity.")
                self.search.index_item(updated or full_item, box_name=self._get_box_name_by_id(full_item.box_id))
                return updated or full_item, False # False indicates not a new item
        
        # If item was not found or not above threshold, add it as a new item to the specified box.
        box = self._find_box_by_name(box_name)
        if box is None:
            # If box_name is not found, it means the client provided a non-existent box for a new item.
            # We should not create it automatically here for ADD. Upstream should handle new box creation.
            raise ValueError(f"Box '{box_name}' not found for new item.")
        
        item = self.store.add_item(name=display_name, canonical=canonical, quantity=quantity, box_name=box.id)
        self.search.index_item(item, box_name=box.name)
        return item, True # True indicates a new item was added

    def add_item_to_box_id(self, name: str, quantity: int, box_id: str) -> Tuple[Item, bool]:
        """Add an item directly to a known box ID. No semantic search for merging here.

        Used for voice flows when a concrete box ID is provided.
        """
        canonical = self.canonicalizer.normalize_to_singular(name)
        display_name = self.canonicalizer.normalize_to_singular_display(name)
        # No semantic search for merging here; assume intent is to add directly.
        item = self.store.add_item(name=display_name, canonical=canonical, quantity=quantity, box_name=box_id)
        box_name_map = {b.id: b.name for b in self.store.list_boxes()}
        self.search.index_item(item, box_name=box_name_map.get(box_id, ""))
        return item, True # Always a new item when calling this direct function

    def increment_item_quantity(self, item_id: str, delta: int) -> Optional[Item]:
        """Increase quantity for an existing item by delta (>=1)."""
        # Read from items listing to avoid per-record GET permission issues
        current = None
        for it in self.store.list_items():
            if it.id == item_id:
                current = it
                break
        if current is None:
            raise RuntimeError(f"Cannot increment: item {item_id} not found in Airtable list.")
        new_qty = int(current.quantity) + int(delta)
        updated = self.store.update_item_quantity(current.id, new_qty)
        if updated is None:
            raise RuntimeError("Airtable did not return the updated item after quantity change.")
        return updated

    def remove_item(self, name: str, quantity: int, resolved_item: Optional[Item] = None) -> Tuple[Optional[Item], List[Tuple[Any, float]]]:
        """Remove quantity from an item resolved via semantic search.

        Behavior mirrors ADD: resolve the Airtable row concretely, then update or delete.
        """
        if resolved_item:
            cand = resolved_item
            suggestions = []
            score = 1.0 # Assuming a perfect match if resolved directly
        else:
            cand, score, suggestions = self.find_item_by_semantic(name)
        
        print(f"[DEBUG] Semantic search for REMOVE '{name}' returned score: {score} (Threshold: {self.search.threshold})")
        
        if cand is None:
            return None, suggestions
        
        # Resolve candidate to concrete Airtable row (handles vector id drift)
        concrete = self._get_item_by_id(cand.id) # Use the ID from the candidate item
        if concrete is None:
            # As a last resort, try exact name equality against Airtable only if not resolved_item
            if not resolved_item:
                concrete = self.find_item_by_exact_name(cand.name)
            else:
                return None, suggestions # If resolved_item but no concrete match by ID, return suggestions
        if concrete is None:
            return None, suggestions # Return suggestions if still no concrete item
        
        new_qty = int(concrete.quantity) - int(quantity)
        if new_qty <= 0:
            # delete record entirely from Airtable and vector index
            self.store.delete_item(concrete.id)
            try:
                self.search.delete_item(concrete.id)
            except Exception:
                pass
            return Item(id=concrete.id, name=concrete.name, canonical_name=concrete.canonical_name, quantity=0, box_id=concrete.box_id), []
        updated = self.store.update_item_quantity(concrete.id, new_qty)
        return updated, []

    def remove_item_all(self, name: str, resolved_item: Optional[Item] = None) -> Tuple[Optional[Item], List[Tuple[Any, float]]]:
        """Remove all quantity of an item by deleting the Airtable row and vector entry."""
        if resolved_item:
            cand = resolved_item
            suggestions = []
            score = 1.0
        else:
            cand, score, suggestions = self.find_item_by_semantic(name)
        
        print(f"[DEBUG] Semantic search for REMOVE ALL '{name}' returned score: {score} (Threshold: {self.search.threshold})")
        
        if cand is None:
            return None, suggestions
        
        concrete = self._get_item_by_id(cand.id)
        if concrete is None:
            if not resolved_item:
                concrete = self.find_item_by_exact_name(cand.name)
            else:
                return None, suggestions
        if concrete is None:
            return None, suggestions
        
        self.store.delete_item(concrete.id)
        try:
            self.search.delete_item(concrete.id)
        except Exception:
            pass
        return Item(id=concrete.id, name=concrete.name, canonical_name=concrete.canonical_name, quantity=0, box_id=concrete.box_id), []

    def move_item(self, item_name: str, to_box_name: str, from_box_name: Optional[str] = None, resolved_item: Optional[Item] = None) -> Tuple[Optional[Item], List[Tuple[Any, float]]]:
        """Move an existing item to a different box.

        Requirements:
        - item_name must resolve to an existing item
        - to_box_name must resolve to an existing box
        - from_box_name is optional; if provided, it is used to disambiguate; otherwise we infer current box
        Returns updated Item or None if not found, plus suggestions.
        """
        if resolved_item:
            cand = resolved_item
            suggestions = []
            score = 1.0
        else:
            # Resolve item by name (semantic) and optionally constrain by from_box
            cand, score, suggestions = self.find_item_by_semantic(item_name)
        
        print(f"[DEBUG] Semantic search for MOVE '{item_name}' returned score: {score} (Threshold: {self.search.threshold})")
        
        # Resolve destination box first
        dest_box = self._find_box_by_name(to_box_name)
        if dest_box is None:
            raise ValueError(f"Destination box '{to_box_name}' not found")
        
        if cand is None:
            return None, suggestions
        else:
            concrete = self._get_item_by_id(cand.id)
            if concrete is None:
                if not resolved_item:
                    concrete = self.find_item_by_exact_name(cand.name)
                else:
                    return None, suggestions
        if concrete is None:
            return None, suggestions
        # If caller specified a from_box, enforce it
        if from_box_name:
            src_box = self._find_box_by_name(from_box_name)
            if not src_box or concrete.box_id != src_box.id:
                return None, suggestions
        # No-op if already in destination
        if concrete.box_id == dest_box.id:
            return concrete, []
        # Update Airtable link
        updated = self.store.move_item_to_box(concrete.id, dest_box.id)
        if updated is None:
            return None, suggestions
        # Update vector index metadata with new box info
        try:
            # Before updating, check the current score for debugging.
            current_item_name = concrete.name  # Use the original name for clarity in debug message
            _, current_score, _ = self.search.find_best_match(self.canonicalizer.canonicalize(current_item_name)) # Ignore suggestions
            print(f"[DEBUG] Before move, semantic search for '{current_item_name}' returned score: {current_score}")

            self.search.index_item(updated, box_name=dest_box.name)

            # After updating, check the new score to confirm index update.
            _, updated_score, _ = self.search.find_best_match(self.canonicalizer.canonicalize(current_item_name)) # Ignore suggestions
            print(f"[DEBUG] After move, semantic search for '{current_item_name}' returned score: {updated_score}")

        except Exception:
            pass
        return updated, []

    def move_all_items_between_boxes(self, from_box_name: str, to_box_name: str) -> List[Item]:
        """Move all items from one box to another.

        Returns the list of updated items now in the destination box.
        """
        src_box = self._find_box_by_name(from_box_name)
        if src_box is None:
            raise ValueError(f"Source box '{from_box_name}' not found")
        dest_box = self._find_box_by_name(to_box_name)
        if dest_box is None:
            raise ValueError(f"Destination box '{to_box_name}' not found")
        if src_box.id == dest_box.id:
            return []

        items_to_move = [it for it in self.store.list_items() if it.box_id == src_box.id]
        updated_items: List[Item] = []
        for it in items_to_move:
            updated = self.store.move_item_to_box(it.id, dest_box.id)
            if updated is None:
                continue
            # Update vector index metadata
            try:
                self.search.index_item(updated, box_name=dest_box.name)
            except Exception:
                pass
            updated_items.append(updated)
        return updated_items

    def find_item_exact(self, name: str) -> Optional[Item]:
        # Backward-compatible alias to exact name lookup
        return self.find_item_by_exact_name(name)

    def find_item_by_semantic(self, name: str) -> Tuple[Optional[Item], float, list[tuple[Item, float]]]:
        # Use semantic search via embeddings + pinecone
        item, score, suggestions = self.search.find_best_match(self.canonicalizer.normalize_to_singular(name))
        print(f"[DEBUG] Semantic search for FIND '{name}' returned score: {score} (Threshold: {self.search.threshold})")
        return item, score, suggestions

    def find_item_by_exact_name(self, name: str) -> Optional[Item]:
        target = (name or "").strip().lower()
        for it in self.store.list_items():
            if it.name.strip().lower() == target:
                return it
        return None

    # ----------------------
    # Helpers
    # ----------------------
    def _get_item_by_id(self, item_id: str) -> Optional[Item]:
        for it in self.store.list_items():
            if it.id == item_id:
                return it
        return None

    def _find_box_by_name(self, box_name: str) -> Optional[Box]:
        """Robustly resolve a box by name.

        - Strips punctuation and a leading 'box ' prefix
        - Maps spoken-letter forms (e.g., 'bee', 'cee', 'sea') to single-letter names
        - Tries exact, case-insensitive, then fuzzy match
        """
        target_raw = (box_name or "").strip()
        # Strip trailing punctuation like 'E.' -> 'E'
        target = re.sub(r"[\.,!?]+$", "", target_raw).strip().lower()
        # Remove a leading 'box '
        if target.startswith("box "):
            target = target[4:].strip()
        # Map spoken forms to letters
        spoken_to_letter = {
            "a": "a", "ay": "a",
            "b": "b", "be": "b", "bee": "b",
            "c": "c", "cee": "c", "see": "c", "sea": "c",
            "d": "d", "dee": "d",
            "e": "e", "ee": "e",
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
            "q": "q", "cue": "q", "queue": "q",
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
        if target in spoken_to_letter:
            target = spoken_to_letter[target]
        # Build maps of existing boxes
        boxes = self.store.list_boxes()
        name_to_box = {b.name.strip().lower(): b for b in boxes}
        # 1) Exact (case-insensitive) match
        if target in name_to_box:
            return name_to_box[target]
        # 2) If single-letter target, try uppercase key
        if len(target) == 1:
            for b in boxes:
                if b.name.strip().lower() == target:
                    return b
        # 3) Fuzzy match as a last resort (use a low cutoff if all boxes are single letters)
        existing_names = [b.name.strip() for b in boxes]
        cutoff = 0.8
        if all(len(n) == 1 for n in existing_names if n):
            cutoff = 0.5
        candidates = difflib.get_close_matches(target, [n.lower() for n in existing_names], n=1, cutoff=cutoff)
        if candidates:
            return name_to_box.get(candidates[0])
        return None

    def _get_box_name_by_id(self, box_id: str) -> str:
        """Helper to get box name by its ID."""
        for box in self.store.list_boxes():
            if box.id == box_id:
                return box.name
        return "Unknown Box"

    # ----------------------
    # Cross-index resolution
    # ----------------------
    def resolve_semantic_to_store_item(self, name: str) -> Optional[Item]:
        """Wrapper: resolve by name via semantic candidate, then reuse candidate-based resolver."""
        cand, _, _ = self.find_item_by_semantic(name)
        if not cand:
            return None
        return self.resolve_semantic_candidate_to_store_item(cand)

    def resolve_semantic_candidate_to_store_item(self, cand: Item) -> Optional[Item]:
        """Resolve using the exact candidate returned by semantic search.

        Uses id (if still valid), else matches by (box_id AND normalized name).
        """
        exact = self._get_item_by_id(cand.id)
        if exact is not None:
            return exact
        target_canon = self.canonicalizer.normalize_for_match(cand.canonical_name or cand.name)
        for it in self.store.list_items():
            if it.box_id != cand.box_id:
                continue
            if (
                self.canonicalizer.normalize_for_match(it.canonical_name) == target_canon
                or self.canonicalizer.normalize_for_match(it.name) == target_canon
            ):
                return it
        return None


__all__ = ["InventoryService"]

