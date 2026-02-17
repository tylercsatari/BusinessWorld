from __future__ import annotations

from typing import List

from ..services.gpt_service import GptService

from ..config import ConfigManager


MODEL_DIMENSIONS = {
    # Only used if we need to check dimension; config overrides
    "text-embedding-3-small": 1536,
}


class OpenAIEmbedder:
    def __init__(self, config: ConfigManager | None = None) -> None:
        self.config = config or ConfigManager()
        self.settings = self.config.load()
        # If Pinecone handles embeddings, this class may be unused. Provide a default if called.
        self.model = getattr(self.settings, "openai_embedding_model", "text-embedding-3-small")
        self.gpt = GptService(self.config)

    def embedding_dimension(self) -> int:
        # honor configured dimension to match Pinecone index
        dim = int(getattr(self.settings, "openai_embedding_dimensions", 1536) or 1536)
        return dim

    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        response = self.gpt.client.embeddings.create(model=self.model, input=texts)
        vectors = [d.embedding for d in response.data]
        # if Pinecone index expects smaller dim, truncate vectors to match
        target_dim = self.embedding_dimension()
        if vectors and len(vectors[0]) != target_dim:
            vectors = [v[:target_dim] if len(v) > target_dim else v + [0.0] * (target_dim - len(v)) for v in vectors]
        return vectors


__all__ = ["OpenAIEmbedder", "MODEL_DIMENSIONS"]

