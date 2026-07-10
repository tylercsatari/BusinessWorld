# Long Quant trained workers

One Replicate Cog model serves both finalized Long Quant LoRA adapters on the
shared `Qwen/Qwen3-30B-A3B` base:

- `task=idea` runs `idea_long_r26`.
- `task=thumb` runs `thumb_b10`.

The adapters are downloaded from R2 by the deployment workflow and baked into
the private Cog image. The clean Qwen base is pinned to Hugging Face commit
`ad44e777bcd18fa416d9da3bd8f70d33ebb85d39` and published through Cog managed
weights, so Replicate mounts cached weight layers instead of downloading 58 GB
inside every cold container. Long Quant must fail visibly if this worker is
unavailable; it must never substitute Fireworks, OpenAI, or another
general-purpose LLM.
