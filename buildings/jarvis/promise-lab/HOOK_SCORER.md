# Deterministic Hook Diagnostics

Promise Lab converts hook text into reproducible semantic, partition, outcome,
component, and retention diagnostics. It now has one validated cross-source
local-retention **training proxy**, Market Hold. It still does not have a causal
or universal promise-quality truth. The full audit is in
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

After boundaries are fixed, components receive one of four labels from the
retained map recorded by `manual-projection.json`:

- representation: `raw-hook-residual`
- transform: whitened four-dimensional PCA
- clustering: frozen `k=4`

That map was selected post hoc using the manual reference probe. The labels are a
useful conditional vocabulary, not an independently discovered taxonomy. They
cannot move a boundary, may repeat, and may be absent.

## 4. Market Hold training reward

Market Hold deliberately copies the successful Long Quant thumbnail serving
contract: one fixed input, one frozen direction, one frozen percentile ladder,
and the exact same calculation in training, live scoring, component explanation,
and UI.

The direction is fitted on 5,353 non-owned first-five-second transcript
embeddings against `log10(views + 1)`. Videos sharing a channel or canonical
transcript are connected into one validation group. A fixed five-value ridge grid
is selected only inside each outer training fold. All five outer folds select
alpha 10; nested grouped OOF Spearman is 0.2500 and fold-direction median cosine
is 0.8574. No outcome from the 208 Promise Lab hooks enters direction or
hyperparameter selection.

For normalized complete-hook embedding `x`, frozen coefficient `w`, intercept
`b`, and the sorted 5,353-row external score ladder `L`:

`coordinate(x) = x @ w + b`

`MarketHold(x) = percentile(L, coordinate(x))`

The unchanged external coordinate transfers to owned outcomes:

- five-second retention: rho 0.2661, family q 0.00033, recent-half rho 0.1984
- viewed percentage: rho 0.2989, family q 0.00033
- average retention: rho 0.3443, family q 0.00033
- raw log views: rho 0.0760, not supported

Reward is `MarketHold / 100` only when the frozen model status passes and the
candidate is at least as close to the measured-hook manifold as the exact
observed leave-one-out minimum. The empirical 10th-percentile similarity is a
visible caution, not a hidden penalty. A seed-to-candidate topical cosine can be
required separately and never changes the Market Hold coordinate.

This is sufficient as a consistent model-training proxy for local hold. It is
not evidence that topic, production, or audience effects have been isolated, and
it cannot claim which exact rewrite causally wins without randomized same-topic
variants.

## 5. Retained-information diagnostic

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

## 6. Components and relationships

For each exact-cover component `i`, the frozen Market Hold model receives the
exact counterfactual text with that component removed. The primary attribution is:

`market_effect(i) = MarketHoldCoordinate(full) - MarketHoldCoordinate(without i)`

The value is reported in frozen external score standard deviations. For each
pair `(i,j)`, the primary relationship is:

`market_interaction(i,j) = full - without i - without j + without(i,j)`

Every whole, component, and pair therefore uses the same coordinate as model
training. Conditional cluster labels calibrate effect percentiles for display but
never enter the score. Hook Hold remains a separate future-free entry-indexed
diagnostic:

`hold_effect(i) = HookHold(full) - HookHold(without i)`

The same calculation is retained separately for viewed percentage, five-second
retention, average retention, log views, and all 41 within-hook retention
forecast positions. Effects are ranked only against model-relative training
effects from components in the same conditional category.

For each pair `(i,j)`, the headline relationship is:

`hold_interaction(i,j) = HookHold(full) - HookHold(without i) - HookHold(without j) + HookHold(without i,j)`

The older broad retained-information attribution remains a separate channel:

`effect(i) = value(full) - value(without i)`

For each pair `(i,j)`, the local second-order interaction is:

`interaction(i,j) = value(full) - value(without i) - value(without j) + value(without i,j)`

All are local deletion effects, not Shapley values. They do not claim global
additivity or causal contribution. A fixed-duration endpoint effect isolates the
semantic model change; a natural-duration endpoint effect is also reported when
the deletion leaves text, but it deliberately includes the duration change.

## 7. Component response and lag

The component study tests the shared source-media interval across 17 shifts from
-3 through +5 seconds in 0.5-second increments. Every canonical hook uses the
same deterministic character projection onto opening CTC word intervals. The
projection ends only at an acoustic word boundary; internal boundaries that fall
inside one acoustic word are explicitly estimated and are not eligible for a
timing outcome unless both component edges are acoustic. Negative shifts are
falsification controls and can never be selected.
Within each outer source fold, forward-lag
selection uses training videos only. Rows are weighted so each source video has
equal total influence.

The displayed statistic is the equal-category Fisher mean of category-specific
Spearman correlations. Its source-video wild null and source bootstrap operate on
that exact statistic.

The robustness family contains 816 declared cells: four retention
normalizations, four category-blind natural-drop baselines, three ridge strengths,
and 17 lags. Of these, 720 have at least eight independent source videos in every
category; unsupported cells are unavailable, not assigned a neutral score.

Corrected result:

- predeclared future-free zero-lag rho 0.0407, p 0.5658, 95% CI
  [-0.1080, 0.1863]
- its family-wide max-null p is 1.0
- exploratory +0.5-second rho 0.2160, but family-wide p is 0.8443
- on exactly matched rows, +0.5-second forward rho is 0.0331 and reverse rho is
  -0.0212; forward minus absolute reverse is 0.0119 with 95% CI
  [-0.3536, 0.1787]
- the fixed zero-lag chronological rho is 0.2747, p 0.0557, with one category
  negative and its confidence interval crossing zero

The nested exploratory selector prefers +0.5 seconds in three supported random
folds, but two folds lack sufficient independent category support. Only one of
four chronological selection folds is supportable. Those incomplete results do
not override the family and reverse controls. No response lag or component
response axis validates, so whole-hook timing uses the acoustically aligned hook
end with zero added lag. CTC boundaries are deterministic model estimates, not
hand-labeled timestamps.

## 8. Future-free Hook Hold and replay sensitivities

Hook Hold's primary measured target is entry-indexed:

`R_entry(t) = 100 * R(t) / R(0)`

At acoustically aligned hook end `T`, the duration-neutral target is:

`carry_entry = 100 * exp(log(R(T) / R(0)) / T)`

The train-fold duration-only expectation from `T`, `T^2`, and `log(T)` is
subtracted. No full-video endpoint enters this target. Random folds give rho
0.1346, p 0.0537, and 1.18% MAE improvement. Past-to-future validation gives rho
0.0383, p 0.6424, and -4.77% MAE improvement. It is therefore a diagnostic, not
the training reward.

For measured source curves, a separate terminal-conditioned replay sensitivity is:

`C(t) = max(R(0)-100, 0) * clip((R(t)-F)/(R(0)-F), 0, 1)`

`R_terminal(t) = R(t) - C(t)`

`F` is a robust terminal anchor from the end of the full video. This is an
observational sensitivity index, not identified replay counts and not a target
available from text alone.

At acoustically aligned hook end `T`, its retrospective carry is:

`carry = 100 * exp(log(R_terminal(T)/100) / T)`

It is not an estimate of replay counts or causal first-pass retention. The
terminal-conditioned and entry-indexed targets correlate only 0.0455, while their
model predictions correlate -0.3084. That disagreement is direct evidence that
normalization choice changes the semantic conclusion. Terminal replay and
endpoint-affine results are therefore retrospective sensitivities only and are
unavailable when scoring text without a measured curve.

## 9. Direct outcomes and retention curves

The complete hook embedding separately predicts viewed percentage, five-second
retention, average retention, and log views. Random-fold correlations are positive,
but none passes the multiplicity-corrected future-only gate. These planes remain
visible with both random and chronological validation.

The primary entry-indexed curve forecast uses 41 normalized positions from 0% to
100% of each source's analyzed hook. It has random-fold MAE 4.075 percentage
points versus 4.471 for the text-free baseline. Its chronological MAE is 4.532
versus 4.727, but the paired source bootstrap is not significant (p 0.0630 and a
95% interval crossing zero). Observed-absolute and terminal-conditioned curves
are fitted and reported separately. Each source maps the 41-position grid to its
own source-media acoustic hook endpoint; no value is emitted after that endpoint.

## 10. Live scorer output

Every scored hook returns:

- exact complete-hook and span embedding inputs
- Market Hold coordinate, percentile, reward eligibility, external validation,
  owned transfer evidence, and empirical domain support
- category-blind raw boundary posteriors
- one complete non-overlapping partition and its top-two score gap
- conditional category labels
- retained-information, future-free Hook Hold, and retrospective terminal
  sensitivity diagnostics
- four direct outcome predictions
- a diagnostic 41-position retention forecast bounded by the analyzed hook
- every component deletion and pair deletion input
- Market Hold component effects and pair interactions in the exact training
  coordinate, plus separate Hook Hold, direct-outcome, and curve diagnostics
- every available component and relationship map
- nearest-training-hook similarity
- token count relative to the measured 8-57-token training range; longer inputs
  are explicitly marked as extrapolations and are never silently truncated
- explicit random-fold, temporal, normalization, and domain status

The scorer is deterministic for a fixed model artifact and exact input text.

## 11. Promotion rule

A score can be used as a training proxy only when its fitting labels are isolated,
its hyperparameters are selected inside grouped folds, its frozen direction
transfers multiplicity-corrected to untouched owned local retention, and the
recent half remains positive and significant. Calling that score universal or
causal additionally requires randomized same-topic hook variants. Market Hold
passes the first gate and not the second.
