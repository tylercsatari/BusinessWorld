from __future__ import annotations

from typing import Optional, Tuple, List

from ..config import ConfigManager
from ..domain.models import Item
from .embedder import OpenAIEmbedder
from .pinecone_index import PineconeIndex
from ..domain.canonicalize import CanonicalizeService


NAMESPACE = "inventory"
THRESHOLD: float = 0.80


class SemanticSearch:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        self.embedder = OpenAIEmbedder(self.config)
        self.index = PineconeIndex(self.config)
        # Single source of truth for threshold
        self.threshold = THRESHOLD
        self.canonicalizer = CanonicalizeService()

    # ------------------
    # Index Maintenance
    # ------------------
    def index_item(self, item: Item, box_name: str | None = None) -> None:
        vec = self.embedder.embed_texts([item.canonical_name])[0]
        md = {
            "name": item.name,
            "canonical_name": item.canonical_name,
            "box_id": item.box_id,
            "box_name": box_name or "",
        }
        self.index.upsert(ids=[item.id], vectors=[vec], metadatas=[md], namespace=NAMESPACE)

    def delete_item(self, item_id: str) -> None:
        self.index.delete(ids=[item_id], namespace=NAMESPACE)

    # ------------------
    # Query
    # ------------------
    def find_best_match(self, query_text: str, top_k_suggestions: int = 3) -> Tuple[Optional[Item], float, list[tuple[Item, float]]]:
        matches = self.top_k(query_text, k=top_k_suggestions + 1) # Get one extra to account for exact match possibly being in top_k

        best_match: Optional[Item] = None
        best_score: float = 0.0
        suggestions: list[tuple[Item, float]] = []

        if matches:
            best_match, best_score = matches[0]
            # Filter out the best match from suggestions if it's considered above threshold
            if best_score >= self.threshold:
                suggestions = matches[1:top_k_suggestions + 1]
            else:
                suggestions = matches[:top_k_suggestions]

        # Return None for best_match if score is below threshold
        if best_score < self.threshold:
            return None, best_score, suggestions
        return best_match, best_score, suggestions

    def find_all_above_threshold(self, query_text: str, k: int = 10, margin: float = 0.0) -> List[tuple[Item, float]]:
        """Return all matches with score >= threshold + margin (up to top-k).

        - margin allows requiring matches to be slightly above the global threshold (e.g., 0.05).
        - Results are sorted by score desc.
        """
        matches = self.top_k(query_text, k=k)
        cutoff = float(self.threshold) + float(margin)
        return [(it, sc) for it, sc in matches if sc >= cutoff]

    def find_top_match(self, query_text: str) -> Tuple[Optional[Item], float]:
        # This function is being deprecated in favor of find_best_match for more comprehensive results
        # Keeping it for backward compatibility, but it will now call find_best_match internally
        best_match, best_score, _ = self.find_best_match(query_text, top_k_suggestions=0)
        return best_match, best_score

    def top_k(self, query_text: str, k: int = 3) -> list[tuple[Item, float]]:
        if not (query_text or "").strip():
            return []
        qvec = self.embedder.embed_texts([self.canonicalizer.canonicalize(query_text)])[0]
        matches = self.index.query(vector=qvec, top_k=max(1, k), namespace=NAMESPACE)
        out: list[tuple[Item, float]] = []
        for m in matches:
            md = m.get("metadata", {})
            item = Item(
                id=m.get("id", ""),
                name=md.get("name", ""),
                canonical_name=md.get("canonical_name", ""),
                quantity=0,
                box_id=md.get("box_id", ""),
            )
            out.append((item, float(m.get("score", 0.0))))
        # Sort matches by score in descending order
        out.sort(key=lambda x: x[1], reverse=True)
        return out


__all__ = ["SemanticSearch", "NAMESPACE", "THRESHOLD"]

