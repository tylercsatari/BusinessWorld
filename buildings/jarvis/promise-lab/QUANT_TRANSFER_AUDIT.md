# Quant Reward Transfer Audit

Date: 2026-07-12

This audit compares the score contracts used by Shorts Quant, Long Quant
thumbnails, and Promise Lab. The goal is not to make the systems cosmetically
similar. It is to preserve the parts that make a model-training reward stable and
remove the parts that only looked validated because fitting and evaluation were
mixed.

## Existing systems

| System | Scored object | Frozen serving score | Useful property | Validation debt |
| --- | --- | --- | --- | --- |
| Shorts raw visual | five 1 fps frames from the first five seconds, tiled into one montage | current RL path uses cosine-weighted 12-nearest-neighbor extrapolated keep estimates, then a percentile | input extraction is exact and inspectable; visual/text/together modalities are separate | reward is not one fitted frozen axis, the fixed 0.72 density floor and 1.5 penalty are hand-set, and shuffled folds do not prove later-video transfer |
| Long thumbnail | one 16:9 image-only Gemini embedding | `0.3 * CTR direction + 0.7 * log-views direction`, normalized, projected, and ranked on one curated ladder | training and serving use the same projection and ladder; title/together scores stay diagnostic | the 0.3 blend was selected from full-data alignment and then described on that same geometry; it is not a nested held-out estimate |
| Previous Promise score | one complete-hook text embedding | terminal-conditioned Hook Hold or direct owned-outcome axes | all inputs, normalization, and temporal failure are visible | random-fold association collapses or reverses later; it is not a defensible training reward |

## Contract retained for hooks

The thumbnail system's strongest idea is the serving contract:

1. Define exactly one scored object.
2. Embed it once with the same model used to build the reference corpus.
3. Project it onto one frozen direction.
4. Convert the projection through one frozen empirical ladder.
5. Use that exact scalar in training, batch scoring, UI, and explanations.
6. Keep topical relevance and domain support as explicit constraints, never
   hidden weighted terms.

Market Hold implements that contract for text. The scored object is complete hook
text. The embedding is `gemini-embedding-2`, 1,536 dimensions. The direction is a
ridge coefficient fitted against external first-five-second transcript log views.
The percentile ladder contains the 5,353 external fitted coordinates.

## Isolation and validation

- 5,939 raw text rows were audited.
- 586 owned rows were excluded before fitting.
- 5,353 non-owned rows remained in 3,818 connected groups.
- Rows sharing either channel or canonical transcript remain in one fold.
- The alpha grid is fixed at `0.1, 1, 10, 100, 1000`.
- Alpha is selected inside every outer grouped fold. All five choose 10.
- Nested external OOF Spearman is 0.2500.
- Median cosine among outer-fold directions is 0.8574.
- All 208 Promise Lab IDs are proven absent from fitting.

The final external direction is then frozen and evaluated once on owned labels.
It transfers to five-second retention (`rho=0.2661`, family `q=0.00033`), viewed
percentage (`rho=0.2989`), and average retention (`rho=0.3443`). It does not
transfer to raw views (`rho=0.0760`), so the implementation does not claim it.

## Training formula

For normalized text embedding `x`:

`coordinate = x @ coefficient + intercept`

`percentile = rank(coordinate on frozen external ladder)`

`reward = percentile / 100`

Reward is withheld when the model-level validation gate is not current or the
candidate falls below the exact observed leave-one-out support minimum of the 208
measured hooks. The observed support 10th percentile is displayed as a caution but
never changes reward. A requested seed constraint is a separate cosine pass/fail.

## Components and relationships

The outcome-blind exact-cover partition remains the explanation layer. It does
not change reward. For component `i`:

`effect(i) = coordinate(full) - coordinate(without i)`

For components `i,j`:

`interaction(i,j) = coordinate(full) - coordinate(without i) - coordinate(without j) + coordinate(without i,j)`

Both are divided by the frozen external coordinate standard deviation. These are
local model counterfactuals, not causal effects or Shapley values. Cluster-specific
reference distributions only turn them into inspectable percentiles.

## What this enables

`score_market_hook.py` is the model-training endpoint. It requires one embedding
for an unseeded candidate and returns the exact reward, domain status, calibrated
owned-outcome estimates, and contract. `--diagnostics` adds validation provenance;
the compact default avoids copying it into every training step. `score_hook.py` adds the
full variable component partition and exact local effects without changing the
primary score.

This reaches the same operational maturity as the thumbnail score: one
deterministic reward can be replicated everywhere. It does not solve the harder
causal question. The next decisive experiment is randomized, same-topic hook
variants with predeclared Market Hold predictions and measured five-second
retention. That experiment can either promote the proxy to a causal rewrite score
or falsify it without changing the historical artifacts.
