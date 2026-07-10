# Long Quant trained workers

One Replicate Cog model serves both finalized Long Quant LoRA adapters on the
shared `Qwen/Qwen3-30B-A3B` base:

- `task=idea` runs `idea_long_r26`.
- `task=thumb` runs `thumb_b10`.

The adapters are downloaded from R2 by the deployment workflow and baked into
the private Cog image. The public Qwen base downloads once when a Replicate
container starts. Long Quant must fail visibly if this worker is unavailable;
it must never substitute Fireworks, OpenAI, or another general-purpose LLM.
