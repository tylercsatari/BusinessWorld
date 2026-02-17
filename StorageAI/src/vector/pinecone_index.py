from __future__ import annotations

from typing import Any, Dict, List, Optional

try:
    from pinecone import Pinecone  # type: ignore
except Exception:  # ModuleNotFoundError or other import issues
    Pinecone = None  # type: ignore

from ..config import ConfigManager


class PineconeIndex:
    def __init__(self, config: ConfigManager | None = None) -> None:
        if Pinecone is None:
            raise RuntimeError("pinecone-client is not installed. Install it or disable vector search.")
        self.config = config or ConfigManager()
        settings = self.config.load()
        if not settings.pinecone_api_key:
            raise RuntimeError("Pinecone API key missing in settings")

        self.client = Pinecone(api_key=settings.pinecone_api_key)
        # If using serverless host (recommended): prefer provided host
        host = getattr(settings, "pinecone_host", "")
        index_name = getattr(settings, "pinecone_index", "inventory") or "inventory"
        if host:
            try:
                self.index = self.client.Index(host=host)
            except Exception:
                # Fallback to named index if host fails
                self.index = self.client.Index(index_name)
        else:
            # Prefer explicit index name to avoid ProtocolError
            self.index = self.client.Index(index_name)

    def upsert(self, ids: List[str], vectors: List[List[float]], metadatas: Optional[List[Dict[str, Any]]] = None, namespace: Optional[str] = None) -> None:
        items = []
        for i, v in zip(ids, vectors):
            items.append({"id": i, "values": v})
        if metadatas:
            for item, md in zip(items, metadatas):
                item["metadata"] = md
        self.index.upsert(vectors=items, namespace=namespace)

    def delete(self, ids: List[str], namespace: Optional[str] = None) -> None:
        self.index.delete(ids=ids, namespace=namespace)

    def query(self, vector: List[float], top_k: int = 10, namespace: Optional[str] = None, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        res = self.index.query(vector=vector, top_k=top_k, include_metadata=True, namespace=namespace, filter=filter)
        # normalize output
        return [
            {
                "id": m["id"],
                "score": m.get("score", 0.0),
                "metadata": m.get("metadata", {}),
            }
            for m in res.get("matches", [])
        ]


__all__ = ["PineconeIndex"]

