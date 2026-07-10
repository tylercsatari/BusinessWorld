"""Cog wrapper for the shared finalized Long Quant inference core."""

import json

from cog import BasePredictor, Input

from worker_core import LongQuantEngine


BASE_DIR = "/weights/qwen3-30b-a3b"
ADAPTER_DIRS = {
    "idea": "/src/adapters/idea_long_r26",
    "thumb": "/src/adapters/thumb_b10",
}


class Predictor(BasePredictor):
    def setup(self):
        self.engine = LongQuantEngine()
        self.engine.setup(BASE_DIR, ADAPTER_DIRS)

    def predict(
        self,
        task: str = Input(description="trained adapter to run", choices=["idea", "thumb"], default="idea"),
        premise: str = Input(description="seed title or premise", default=""),
        idea: str = Input(description="video idea for thumbnail direction", default=""),
        context: str = Input(description="authoritative video/transcript context", default=""),
        instruction: str = Input(description="additional generation constraint", default=""),
        avoid_json: str = Input(description="prior ideas to avoid, encoded as JSON", default="[]"),
        semantic_ring_json: str = Input(description="semantic distance constraints, encoded as JSON", default="{}"),
        invent: bool = Input(description="invent an unseeded idea", default=False),
        attempt: int = Input(description="exploration iteration", default=0, ge=0, le=10000),
        count: int = Input(description="number of outputs", default=1, ge=1, le=8),
        seed: int = Input(description="deterministic request seed", default=0, ge=0, le=2147483647),
    ) -> str:
        return json.dumps(self.engine.predict(
            task=task,
            premise=premise,
            idea=idea,
            context=context,
            instruction=instruction,
            avoid_json=avoid_json,
            semantic_ring_json=semantic_ring_json,
            invent=invent,
            attempt=attempt,
            count=count,
            seed=seed,
        ))
