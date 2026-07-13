# Deterministic Hook Diagnostics

Promise Lab converts hook text into reproducible semantic, partition, outcome,
component, and retention diagnostics. It does not currently produce a validated
universal better/worse hook score. The full audit is in
[`METHODOLOGY_AUDIT.md`](METHODOLOGY_AUDIT.md).

The scorer uses `gemini-embedding-2` at 1536 dimensions, the same Long Quant text
space used by the source corpus. No generative LLM splits, labels, rewrites, or
ranks the input.

## 1. Input lattice

For a hook with `n` tokens, the scorer embeds all `n(n+1)/2` contiguous spans and
their retained contexts. For full hook embedding `E(H)` and span `S`:

`influence(S) = E(H) - E(H without S)`

`nonadditive(S) = influence(S) - sum(influence(token) for token in S)`

Exact counterfactual strings preserve source order and retained source
characters. Every embedded input is visible in the scorer.

## 2. Category-blind exact-cover partition

Every internal token gap receives eight semantic contrast features:

1. prefix/suffix raw contrast
2. prefix/suffix context contrast
3. prefix/suffix influence contrast
4. prefix/suffix nonadditive contrast
5. adjacent-token raw contrast
6. adjacent-token influence contrast
7. raw split reconstruction
8. influence split reconstruction

The positive training target is a gap supported above its own permutation null
by all three outcome-blind geometric segmentation families. A grouped logistic
model selects only L2 regularization inside training folds. The decoder uses raw
fold posteriors directly:

`log P(cover) = sum(cut gaps log(p)) + sum(uncut gaps log(1-p))`

There is no tuned cut threshold, posterior recentering, split penalty, required
component count, maximum count, duration rule, outcome, or category probability
in the boundary model.

Current corpus result:

- 208 hooks and 324 components
- minimum 1, median 1, mean 1.558, maximum 6
- 134 hooks remain one component
- zero missing tokens and zero overlap
- held-out boundary AUC 0.7056 and average precision 0.3672
- serving-versus-held-out count agreement 93.75%

## 3. Conditional category overlay

After boundaries are fixed, components receive one of four labels from retained
map `0042a54b685d55438242`:

- representation: `raw-hook-residual`
- transform: whitened four-dimensional PCA
- clustering: frozen `k=4`

That map was selected post hoc using the manual reference probe. The labels are a
useful conditional vocabulary, not an independently discovered taxonomy. They
cannot move a boundary, may repeat, and may be absent.

## 4. Retained-information diagnostic

The broad complete-hook target begins with six endpoint-normalized retention
measurements at 3, 5, 8, and 10 seconds, hook end, and hook end through +5 seconds.
Within each fold they are standardized and reduced to a positive-loading PC1.
Measured confounds are then removed: token count, duration, hook-end time, viewed
percentage, entry retention, terminal retention, and entry-to-terminal amplitude.

A nested PCA-plus-ridge model maps the full hook embedding to that residual. The
current random-fold result is:

- Spearman 0.2211
- rank-permutation p 0.00146
- selected 8 embedding dimensions and ridge alpha 0.1

Past-to-future sensitivity across 4, 5, 6, 8, and 10 blocks gives rho
0.039-0.076 with p 0.29-0.63. Therefore this coordinate and its component
deletion effects are diagnostic, not validated transfer.

## 5. Components and relationships

For each exact-cover component `i`, broad attribution is:

`effect(i) = value(full) - value(without i)`

For each pair `(i,j)`, the local second-order interaction is:

`interaction(i,j) = value(full) - value(without i) - value(without j) + value(without i,j)`

These are local deletion effects, not Shapley values. They do not claim global
additivity or causal contribution.

## 6. Component response and lag

The component study tests the exact spoken interval shifted from 0 through 5
seconds in 0.5-second increments. Negative shifts are falsification controls.
Within each outer source fold, lag selection uses training videos only.

The displayed statistic is the equal-category Fisher mean of category-specific
Spearman correlations. Its source-video wild null and source bootstrap operate on
that exact statistic.

Corrected result:

- nested selected-lag rho -0.0515, p 0.4825
- fixed 0-second rho 0.0492, p 0.5570
- reverse-time maximum absolute rho 0.2927
- future-fold lag choices span 0, 1, 2, and 5 seconds

No response lag or component response axis validates. The coordinates remain
visible as conditional diagnostics. Because lag is unvalidated, whole-hook timing
uses the exact spoken hook end with zero added lag.

## 7. Terminal-conditioned survival diagnostic

For measured source curves, terminal-conditioned replay correction is:

`C(t) = max(R(0)-100, 0) * clip((R(t)-F)/(R(0)-F), 0, 1)`

`R_terminal(t) = R(t) - C(t)`

`F` is a robust terminal anchor from the end of the full video. This is an
observational sensitivity index, not identified replay counts and not a target
available from text alone.

At exact spoken hook end `T`:

`carry = 100 * exp(log(R_terminal(T)/100) / T)`

A fold-fitted duration baseline using `T`, `T^2`, and `log(T)` is subtracted.
Random folds give rho 0.2557, p 0.00098, and 4.61% MAE improvement.

It is not promoted because:

- five-block future rho is -0.1742 with -5.33% MAE improvement;
- chronological sensitivity is not robust across 4-10 blocks;
- future-free entry normalization gives rho 0.1353, p 0.0517;
- terminal and entry-normalized model predictions correlate at -0.3081.

The displayed percentile is only the rank of this terminal-conditioned diagnostic
among the 208 training predictions.

## 8. Direct outcomes and retention curves

The complete hook embedding separately predicts viewed percentage, five-second
retention, average retention, and log views. Random-fold correlations are positive,
but none passes the multiplicity-corrected future-only gate. These planes remain
visible with both random and chronological validation.

The observed-absolute 0-20 second curve forecast uses 41 half-second points. All
208 sources are at least 22 seconds long, so the horizon is supported by measured
training curves. Random-fold MAE is 5.381 percentage points versus 5.813 for the
mean-curve baseline, a 7.43% improvement. The strict future test does not satisfy
the promotion rule, so the UI labels it diagnostic. Post-hook points use the
complete-hook embedding only; no unseen words or categories are invented.

## 9. Live scorer output

Every scored hook returns:

- exact complete-hook and span embedding inputs
- category-blind raw boundary posteriors
- one complete non-overlapping partition and its top-two score gap
- conditional category labels
- retained-information and terminal-conditioned diagnostics
- four direct outcome predictions
- a diagnostic 0-20 second retention forecast
- every component deletion and pair deletion input
- every available component and relationship map
- nearest-training-hook similarity
- explicit random-fold, temporal, normalization, and domain status

The scorer is deterministic for a fixed model artifact and exact input text.

## 10. Promotion rule

No score may be called validated unless it has positive multiplicity-corrected
random-fold association, positive future-only association, positive baseline
improvement, stability across chronological block counts, and robustness to
reasonable target normalizations. Randomized hook-variant evidence is still the
preferred final validation.
