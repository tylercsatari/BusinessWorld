# Promise Lab Research Program

## Objective

Determine whether the existing 208-hook corpus contains stable,
context-sensitive semantic structure that can eventually support a quantitative
measure of a video's promise or reference to gratification.

The study does not assume that such a structure exists. It does not define a
component taxonomy in advance. It does not treat a phrase supplied during
discussion as a label, template, boundary, or positive example.

## Frozen source

- 208 complete spoken hooks already stored under `longform/hook-embeds/`.
- Exact hook text is the only semantic input to discovery.
- Every vector uses `gemini-embedding-2` at 1,536 dimensions.
- `verify_embedding_parity.py` compares a fresh vector against the existing
  Long Quant pooled preview and must pass before downstream results are valid.
- Observed outcomes are frozen but unavailable to boundary and cluster fitting.

## Claim ladder

The pipeline separates claims that are often accidentally collapsed:

1. A sequence boundary is more geometrically supported than matched nulls.
2. Candidate spans form stable outcome-blind equivalence families.
3. A span transfers consistently across unrelated target contexts.
4. A semantic direction predicts a model-scored counterfactual outcome.
5. A semantic direction predicts an observed YouTube outcome on held-out videos.
6. The direction remains after surface, timing, and semantic-context confounds.
7. The result survives search-wide correction across the complete experiment family.

Only the final levels could justify interpreting a direction as part of a
quantitative promise model. Earlier levels are evidence, not names.

## Stage 1: Exhaustive sequence interventions

For every hook with `n` mechanical tokens, enumerate:

- every contiguous span: `n(n+1)/2`;
- every unordered token pair: `n(n-1)/2`;
- the full text and every exact deletion context.

Measured vectors:

- `D(S) = E(H) - E(H without S)`;
- `I(i,j) = E(H) - E(H-i) - E(H-j) + E(H-{i,j})`;
- `A(S) = D(S) - sum(D(token) for token in S)`.

Completed scale:

- 151,078 exact embedding texts under `exact-offset-v2`;
- 56,552 contiguous spans;
- 52,072 token-pair interactions;
- zero semantic rules.

## Stage 2: Outcome-blind boundary discovery

For every segment count from 1 through `n`, solve the complete contiguous
partition lattice under three independent geometries:

- within-segment deletion-effect SSE;
- within-segment pair-interaction cohesion;
- span non-additivity.

Each hook uses 64 matched sequence nulls and 16 random-projection bootstraps.
Selection subtracts the exact description-length penalty
`sqrt(2 log(C(n-1,k-1)))` and is calibrated against the maximum searched null.

Completed scale:

- 13,440 registered boundary experiments;
- 15,686 candidate span instances;
- 8 hooks with supported multi-unit evidence;
- 30 provisional hooks;
- 170 hooks returning no separable-component evidence.

The best nontrivial partition is retained only for downstream sensitivity. It
is never promoted to component truth when the selected result says no evidence.

## Stage 3: Outcome-blind component atlas

Every candidate is represented four ways:

- raw span embedding;
- deletion influence in its exact parent hook;
- non-additive residual beyond token effects;
- retained-context embedding.

Position and length are displayed but excluded from clustering. The sweep
crosses PCA dimensionality, Euclidean/spherical/whitened geometry, cluster
count, three seeds, held-out source videos, and a feature-permuted null.

Completed scale:

- 3,564 clustering configurations;
- 10,692 seeded experiments;
- 300 retained Pareto/sensitivity maps;
- all 15,686 candidates visible on every applicable map;
- zero outcomes used to fit the atlas.

## Stage 3B: Exhaustive multi-resolution semantic atlas

The candidate atlas is preserved as an evidence-supported scope. A second
scope embeds and clusters all 56,552 contiguous spans, so boundary selection
cannot hide a potentially useful language pattern.

The complete span universe is tested through twelve outcome-blind views:

- raw span, deletion influence, non-additivity, and retained context;
- raw-minus-influence contextualization;
- raw-minus-context contrast;
- raw-minus-full-hook relativity;
- raw semantics after exact token-count fixed-effect removal;
- raw semantics after source-hook fixed-effect removal;
- raw and influence after joint hook and length fixed-effect removal;
- equal-block concatenation of raw, influence, and non-additive views.

The design crosses nine PCA resolutions from 2 through 32 dimensions, three
geometries, 16 cluster counts from 2 through 64, and five seeds. It records
held-out-hook margin, feature-permuted null lift, seed ARI, entropy, cross-hook
generality, token-length NMI, and relative-position NMI. Length and position
are diagnostics or projected nuisances, never positive semantic labels. Seed
ARI is evaluated on one deterministic 4,096-span sample balanced across all
208 source hooks; fitting and map assignment still cover all 56,552 spans.

Every retained map exposes real cluster members, diverse source-hook
representatives, token-width ranges, and boundary-support enrichment computed
only after labels are frozen. A cross-scope audit compares candidate and
exhaustive co-association on 100,000 deterministic pairs and map-level ARI on
balanced candidate samples for all 300 x 300 = 90,000 retained-map pairs.

Completed scale and persistence indicators:

- 5,184 clustering configurations and 25,920 seeded experiments;
- 300 retained maps, exactly 25 from each of the twelve representations;
- all map label arrays cover all 56,552 spans;
- cross-scope co-association Spearman `0.519` on 100,000 deterministic pairs;
- 47 exhaustive maps with best candidate-atlas ARI at least `0.5`;
- maximum cross-scope ARI `0.840`;
- the strongest low-length/position-leakage persistence appears in the
  non-additive representation, while the strongest raw map has materially
  higher token-length leakage.

## Stage 4: Complete crossed transfer surface

Use the exploratory partition only as a sensitivity source set. For each source
span and each of the 208 target hooks:

1. Select a target span from the complete 56,552-span universe.
2. Compute quality-weighted co-association independently inside the
   evidence-supported and exhaustive atlases.
3. Average the two scope scores where both exist; use exhaustive consensus
   alone for spans not promoted by boundary discovery.
4. Use influence cosine only as a deterministic tie-breaker.
5. Replace the exact target span and re-embed the complete recomposed hook.
6. Place it in the frozen Long Quant text manifold.
7. Score CTR+views, CTR, retention, views, scaled views, realistic views, and
   the 10M-view class.
8. Store both scope scores, the target baseline, recomposed percentile, and
   signed delta.

Design scale:

- 3,686 exploratory source units;
- 208 target hooks;
- 766,688 crossed rows;
- 413,262 unique exact recomposed texts;
- 3,686 exact self-span identity controls.

Duplicate texts are embedded once and scattered back to every matching cell.
The decomposition reports source mean transfer, target effects, positive-context
rate, source-by-context interaction, and context sensitivity.

Completed integrity results:

- all 766,688 rows and all 413,262 unique texts were scored;
- all 3,686 per-source surfaces contain all 208 target contexts;
- ANN recall at 24 neighbors was `1.000` on every validation probe;
- all seven metric matrices contain zero non-finite values;
- every exact self-span control reproduced its target baseline with `0.0`
  maximum percentile error on every metric;
- zero rows used an outcome to choose a target location.

Aggregate model-predicted transfer indicators:

| Long Quant text metric | Mean percentile delta | Median delta | Sources above zero |
| --- | ---: | ---: | ---: |
| CTR + views | -0.242 | -0.179 | 1,523 / 3,686 |
| CTR | -0.269 | -0.240 | 1,381 / 3,686 |
| 30-second retention | +0.067 | +0.076 | 2,041 / 3,686 |
| views | +0.791 | +0.695 | 3,279 / 3,686 |
| scaled views | +1.730 | +1.613 | 3,615 / 3,686 |
| realistic views | -0.072 | -0.125 | 1,553 / 3,686 |
| 10M-view class | -0.119 | -0.087 | 1,383 / 3,686 |

These channels have different calibration and baseline geometry. Their raw
deltas are not interchangeable, and widespread positive movement in one
channel is not evidence of a universal semantic component. The UI therefore
keeps each channel separate and exposes source mean, positive-context rate,
context sensitivity, every target baseline, and every exact recomposed input.

## Stage 5: Outcome and confound matrix

Search semantic directions separately for two evidence channels.

Model-predicted counterfactual targets:

- all seven Long Quant transfer metrics.

Observed YouTube targets:

- keep rate, average retention, and log views;
- retention at fixed seconds and fixed duration fractions;
- early-window means and least-squares slopes;
- retention at the stored hook end;
- hook-bounded response windows at multiple forward offsets;
- entry rewatch, entry-to-hook drop, and early slope change.

Each target is crossed with:

- raw, influence, non-additive, and context representations;
- 4, 8, 16, 32, and 64 PCA dimensions;
- nine ridge penalties;
- no confounds, surface confounds, timing confounds, semantic-context
  confounds, initial rewatch/first-second-delivery/swipe confounds, and combined
  sets. Validation is selected only inside a predeclared required-confound
  family; a target is never residualized against an exact copy of itself.

All folds group by source video. Both features and targets are residualized
inside each training fold. Search-wide nulls use each configuration's own
foldwise residual target and 1,024 source-video-level sign flips. This gives a
minimum attainable p-value of 1/1,025 before correction across target families.

Completed scale and corrected indicators:

- 51,660 axis experiments across 41 target families;
- 41 required-confound selections, one per target;
- 12 selections survived the target-wide maximum null and FDR correction;
- all seven model-predicted transfer targets validated on the raw source-span
  embedding, with grouped held-out Spearman values from `0.456` to `0.583` and
  search-wide q-values of `0.0044`;
- five of 34 observed YouTube targets validated: retention at hook end,
  entry-to-hook-end drop, retention at five seconds, 0-to-5-second retention
  slope, and mean retention from three to eight seconds;
- the five observed directions all use the retained-context representation,
  with grouped held-out Spearman values from `0.259` to `0.369`;
- zero observed targets validated on raw source-span, deletion-influence, or
  non-additive source-span representations;
- every selected direction contains all 3,686 component instances, at least
  3,522 finite out-of-fold rows, and a normalized 1,536-dimensional tensor;
  maximum direction-norm error was `7.3e-8`.

The seven transfer results establish that the trained Long Quant model has
repeatable semantic directions for its own counterfactual rankings. They do not
independently establish human response. The observed results establish a
corrected early-retention signal in surrounding hook context, but not yet a
measured source-component direction that can honestly be named reference to
gratification. The five observed targets are also correlated views of early
retention, not five independent psychological constructs.

## Stage 8: Canonical forward-response metric

After the outcome-blind variable-count exact covers are frozen, a dedicated study
tests whether the audience response to each canonical component can be localized.
The corrected category-blind exact cover contains 324 mutually exclusive chunks.
The four category labels are applied afterward from the post-hoc selected map, so
all category-specific results are conditional diagnostics.

Selectable response windows are the source-media CTC interval shifted only forward
from zero through five seconds in half-second increments. Reverse-time windows
are controls. Lag selection happens inside each outer source-video fold, using
an equal-category Fisher mean of inner held-out correlations. The response
target is endpoint-normalized least-squares slope minus a text-free expected
natural drop fitted from timing, duration, entry, terminal, amplitude, and the
cross-fitted entry-to-terminal relationship.

Corrected evidence:

- nested category-balanced held-out Spearman is `-0.0515`, exact-statistic
  source-clustered `p=0.4825`;
- the fixed zero-second diagnostic has rho `0.0492`, `p=0.5570`;
- category correlations include negative values in both random and future folds;
- maximum reverse-time-control absolute rho is `0.2927`, larger than the forward
  diagnostic;
- chronological training-only selection chooses 0, 1, 2, and 5 seconds across
  folds rather than one stable lag;
- all 324 components and 175 local source pairs are stored with exact coverage;
- the equal component whole-hook aggregate fails and is not promoted;
- the selected relationship representation is exploratory because it was chosen
  across six representations on the same data.

The result is a falsification: no component-response lag or category response axis
currently validates. Whole-hook timing therefore uses the acoustically aligned
hook end with zero added lag.

## Required visual evidence

The UI must expose:

- exact hook input and mechanical tokens;
- selected and exploratory partitions with status and search-wide p-value;
- token-to-token inclusion-exclusion matrices;
- boundary observed-versus-null evidence;
- every candidate and exhaustive embedding plane with its exact formula;
- 300 clickable maps per atlas with null lift, held-out margin, ARI, entropy,
  nuisance leakage, persistence, and real cluster representatives;
- every source-by-target swap and its exact recomposed text;
- baseline-adjusted transfer bars for every Long Quant metric;
- semantic axis planes;
- grouped out-of-fold predicted-versus-observed plots;
- the forward-only lag curve, all maps for every canonical component, media-aligned spoken
  and response windows, observed-minus-expected slopes, and held-out predictions;
- the complete experiment registry.

## Falsification and stopping rules

The study must be allowed to fail.

- If one segment wins a hook's search-wide null, record no separable evidence.
- If cluster quality does not exceed its permuted null or is unstable across
  seeds, retain it only as a sensitivity map.
- If a source performs only in a narrow set of contexts, report interaction
  sensitivity rather than a universal lift.
- If an axis has non-positive held-out correlation, fails search-wide FDR, or
  disappears after confound control, do not call it validated.
- Model-predicted transfer never becomes observed human evidence by wording.
- A validated latent direction is a predictive geometric result, not yet a
  psychological causal mechanism.

## Multi-phase roadmap

### Phase A: Current corpus completion

- Complete and verify all five computational stages.
- Publish immutable manifests and per-hook/per-source details.
- Record all negative and provisional results, not only winners.

### Phase B: Stability audit

- Repeat atlas seeds and nulls at larger budgets.
- Bootstrap source videos, not individual spans.
- Measure family persistence under corpus subsampling and channel holdout.
- Audit tokenizer perturbations without introducing linguistic labels.

### Phase C: Counterfactual validation

- Generate controlled sets that hold the video idea fixed while changing only
  a discovered transferable unit.
- Pre-register candidate directions and score them before observing outcomes.
- Separate model-ranking agreement from actual audience response.

### Phase D: Prospective channel experiments

- Randomize validated variants on new videos or controlled title/hook tests.
- Estimate treatment effects with the original idea and production variables
  held constant.
- Refit only after the prospective holdout is closed.

### Phase E: Replicable promise scorer

- Freeze only directions that replicate across channels and time periods.
- Version the embedding model, corpus, transforms, confounds, and thresholds.
- Expose uncertainty and context sensitivity beside every score.
- Preserve the ability to return "unknown" when a new input is outside the
  validated manifold.

## Reproducibility checklist

- Source corpus count and IDs match the manifest.
- Embedding parity passes.
- Every hook has final null/bootstrap settings.
- Atlas labels match candidate count on all 300 maps.
- ANN recall at 24 neighbors is at least 0.95.
- Swap matrix dimensions equal source count by target count.
- Every source detail has all 208 target rows.
- Axis folds contain disjoint source videos.
- Registry counts equal generated experiment counts.
- Browser canvases are nonblank on desktop and mobile.
- Production APIs stream large gzip artifacts without buffering them in Render.
