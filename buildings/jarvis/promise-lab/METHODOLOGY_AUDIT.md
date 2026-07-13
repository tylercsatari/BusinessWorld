# Promise Lab Methodology Audit

Date: 2026-07-12

This audit covers the complete path from exhaustive hook-span embeddings through
canonical partitions, category-conditioned component analyses, whole-hook outcome
axes, retention forecasts, and live scoring. The governing rule is simple: a
useful visualization may remain available as a diagnostic, but it is not promoted
to a better/worse hook score unless it survives every declared validation gate.

## Current conclusion

Promise Lab has useful semantic geometry, several reproducible diagnostics, and
one validated cross-source local-retention training proxy. It does **not** yet
have a causal or universal hook-quality or promise-quality score.

The two owned-outcome candidate axes fail the required generalization tests:

| Candidate | Random-fold result | Future-only result | Decision |
| --- | --- | --- | --- |
| Retained-information axis | rho 0.2211, permutation p 0.00146 | rho 0.039-0.076 across 4-10 chronological blocks, all p >= 0.29 | diagnostic |
| Terminal-conditioned survival | rho 0.2557, permutation p 0.00098, MAE gain 4.61% | five-block rho -0.1742, MAE gain -5.33%; not robust across block counts | diagnostic |

The terminal-conditioned survival result is also normalization-sensitive. A
future-free entry-normalized target gives rho 0.1353 with p 0.0517. The two model
predictions correlate at -0.3081, so they are not interchangeable measurements of
one stable latent property.

Market Hold takes a different route. It is selected on 5,353 non-owned
first-five-second transcript embeddings, with channel and duplicate text held
together and ridge strength selected inside nested outer folds. The frozen score
then transfers without refitting to the 208 owned hooks:

| Frozen external score | External nested OOF | Untouched owned transfer | Decision |
| --- | --- | --- | --- |
| Market Hold | log-views rho 0.2500; all five outer folds select alpha 10 | 5s retention rho 0.2661, recent-half rho 0.1984; viewed rho 0.2989; average retention rho 0.3443; raw views unsupported | local-retention training proxy |

This promotion is deliberately narrower than "hook virality." It supports a
consistent optimization reward, not a causal claim about exact rewrites.

## Fixed problems

### 1. Manual category information entered boundary features

The retained `k=4` map was selected post hoc using the manual reference probe.
Six boundary features were derived from probabilities under those selected
categories. That contradicted the outcome-blind boundary claim and let supplied
interpretation influence where hooks were cut.

Fix:

- The boundary model now has eight category-blind semantic contrast features.
- Category probabilities cannot affect boundary features; a regression test
  changes them adversarially and requires bit-identical boundary features.
- The four category labels are applied only after boundaries are fixed.
- Artifacts and UI disclose that these labels are a manual-probe-conditioned
  overlay, not an independently discovered taxonomy.

### 2. A tuned operating threshold silently controlled component count

The logistic posterior was recentered around a learned threshold near 0.29 before
exact-cover decoding. This changed the implied cut prior and could fragment live
examples into many one-word components even though no explicit component count
was declared.

Fix:

- The decoder uses the raw grouped-fold Bernoulli posterior.
- No cut threshold, prevalence match, posterior recentering, split penalty,
  maximum component count, or required category count enters decoding.
- L2 regularization is selected inside grouped training folds.

Corrected partition result:

- 208 hooks
- 324 components
- minimum 1, median 1, mean 1.558, maximum 6
- 134 hooks remain one component
- zero missing tokens and zero overlap
- held-out boundary AUC 0.7056 and average precision 0.3672
- serving-versus-source-held-out component-count agreement 93.75%

This conservative result is intentional. Moderate ranking ability does not imply
enough posterior certainty to force a semantic cut.

### 3. Inference did not match the displayed statistic

Component response displayed an equal-category Fisher-mean Spearman, but its p
value came from a global component correlation. Unequal category sizes can make
those disagree.

Fix:

- The wild source-video null and source bootstrap now operate on the exact
  equal-category Fisher-mean statistic.
- The artifact stores the per-category and balanced statistics together.

Corrected component-response result:

- nested selected-lag rho -0.0515, p 0.4825
- fixed 0-second rho 0.0492, p 0.5570
- maximum reverse-time control absolute rho 0.2927
- future-only lag choices vary across 0, 1, 2, and 5 seconds
- no component lag or category response axis is promoted

### 4. Random folds were treated as temporal generalization

Random folds mix eras of the channel. They answer whether the model can interpolate
among similar source videos, not whether it transfers to videos published later.

Fix:

- Complete-hook outcome axes now include expanding-window past-to-future tests.
- Retained information and survival include sensitivity across 4, 5, 6, 8, and
  10 chronological blocks.
- A model cannot be promoted unless random-fold and future-only results are both
  positive, significant, and better than their baseline.

Of the four direct complete-hook outcomes, none survives cross-target correction
in the future-only test. Log views is the strongest temporal hint at rho 0.1695
with nominal p 0.0310, but its four-target future q is 0.1240.

### 5. One endpoint-conditioned normalization was treated as ground truth

The replay envelope uses terminal retention from the end of the full video. It is
a deterministic observational normalization, but it is not available from the
hook alone and does not identify replay counts or first-pass viewers.

Fix:

- Terminal-conditioned, future-free entry-normalized, and observed-absolute
  targets are fitted and reported separately.
- Promotion requires agreement with the future-free normalization.
- The UI shows target and prediction correlations across normalizations.
- The terminal-conditioned percentile remains available only as a diagnostic.

### 6. An unvalidated component lag entered the whole-hook target

The whole-hook response endpoint inherited the selected component lag even when
the component study itself failed.

Fix:

- A component lag enters whole-hook timing only after random-fold and future-only
  validation.
- Otherwise the response endpoint is the exact spoken hook end with zero added
  lag.
- The fallback and its reason are stored in `responseLagContract`.

### 7. Tests required the preferred conclusion

Several verifiers asserted `status == validated`, all four category correlations
positive, or lag exactly +1 second. Those tests failed when the science produced
a negative result, encouraging the code to preserve a desired conclusion.

Fix:

- Verifiers now enforce data integrity, exact coverage, deterministic replay,
  leakage barriers, matching inference statistics, and honest status propagation.
- Negative or nonsignificant empirical results are valid verified outputs.

### 8. Legacy exploratory searches were presented as current evidence

The original exhaustive boundary search produced several nominally supported
partitions with 31-37 segments, most only one token long. That is a recognizable
degenerate optimum, not a plausible semantic decomposition. The older semantic
axis search also used the word `validated` for grouped-source random holdout even
though observed outcomes had no later-video replication.

Fix:

- The legacy partitions remain inspectable only as superseded provenance.
- Current scoring and libraries use only the category-blind canonical exact cover.
- Older model-transfer axes are labeled source-grouped supported.
- Older observed-outcome axes are labeled random-fold diagnostics.
- Category-specific component outcome planes are conditional diagnostics even
  when their grouped-random p values pass FDR, because the category map was
  selected post hoc and chronological component replication has not been run.

### 9. Learned context confounds saw held-out rows

The legacy axis search projected semantic context through a PCA basis fitted on
the complete component matrix before grouped folds were created. Outcomes did
not enter that PCA, but held-out feature geometry still influenced the training
representation, making the result transductive rather than strictly held out.

Fix:

- Semantic-context imputation and PCA are fitted independently inside every
  training fold and only then applied to held-out source videos.
- The final descriptive direction may fit the full training corpus, but it is
  stored separately from out-of-fold predictions.
- Axis artifacts record train-fold-only preprocessing and use
  `multiplicity-controlled-random-fold-association`, never `validated`, for
  grouped-random support.

### 10. Resume checkpoints were not fully bound to their inputs

Several expensive stages previously checked only a method version or row count.
A changed hook under the same video ID, or changed atlas assignments with the
same dimensions, could therefore reuse stale downstream arrays.

Fix:

- Tensor resumes require exact text, atom fingerprint, model, dimensions, span
  count, pair count, and intervention version.
- Discovery inherits the tensor fingerprint and model contract.
- The all-span store requires corpus, model, dimensions, and intervention
  identity.
- Swap routing hashes every routing-relevant row, map label/weight, influence
  matrix, and recomposition setting.
- Published aggregates iterate active corpus IDs instead of globbing every file
  left in a cache directory.

### 11. Atlas fit-excluded margins were labeled as held out

K-means excluded a subset of source hooks per seed, but atlas PCA was fitted once
on the complete outcome-blind corpus. Calling the resulting centroid margin
"held-out" overstated its independence. Retained-map ranking also combines
several outcome-blind diagnostics with fixed exponents for browsing convenience.

Fix:

- The UI labels it `fit-excluded margin (full-corpus PCA)` and states that it is
  descriptive.
- The exact `qualityForBrowsing` formula, 300-map retention limit,
  representation quotas, and conditional manual selection are exposed.
- The manual k=4 map remains a saved Pareto-front visualization, not evidence
  that four categories are universally correct.

### 12. Verifiers encoded the current empirical conclusion

Some checks required exactly 208 rows, positive correlations, a failed future
test, or current Long Quant corpus counts. Legitimate new data could therefore
fail solely because the scientific result changed.

Fix:

- Counts now derive from the active corpus and linked artifacts.
- Empirical signs and p-values are checked for finiteness and correct status
  propagation, not for a preferred conclusion.
- A cross-artifact methodology verifier checks source lineage, cache signatures,
  train-fold-only axes, percentile bounds, and zero post-hook output.

### 13. Component scores were disconnected from the headline metric

The live scorer exposed whole-hook coordinates, but component cards primarily
showed a separate category-conditioned response axis. That did not
answer the operational question "how much does this component change this hook's
headline score?" Pair relationships had the same mismatch.

Fix:

- Every exact component is deleted from the literal input and rescored with the
  same frozen whole-hook Market Hold model used by training.
- Every component pair receives that same model's local second-order interaction.
- Hook Hold is retained as a clearly separate terminal-conditioned diagnostic.
- The identical operation is retained separately for viewed percentage,
  five-second retention, average retention, log views, and the 41-position
  within-hook curve forecast.
- Effects are calibrated against frozen-model effects from training components
  in the same conditional category or category sequence.
- The UI keeps these model-relative effects separate from the older
  category-response and retained-information diagnostics. They remain local
  counterfactual model explanations, not causal or additive Shapley values.
- Live input length is never silently truncated. Token count and measured
  training-length support are returned with every score.

### 14. The owned corpus could not validate its own training score

The 208-hook direct models looked useful in shuffled folds but did not transfer
reliably to later videos. Reusing those axes as a training reward would optimize
an interpolation artifact. The existing Shorts reward also uses a nearest-neighbor
estimate over extrapolated labels, while the thumbnail blend was chosen on the
same full-data geometry used to describe it.

Fix:

- The hook reward direction and hyperparameter selection use only non-owned rows.
- Channel and canonical-transcript duplicates are inseparable validation groups.
- Hyperparameter evidence is nested; each outer test fold is predicted after
  alpha selection only on its outer training groups.
- All 208 current Promise IDs are asserted owned and absent from external fitting.
- One rounded coefficient, intercept, ladder, score scale, and domain policy are
  frozen into the runtime artifact.
- The fast trainer, full scorer, component deletions, pair interactions, saved
  library, example evaluation, and UI replay that exact artifact.
- Visuals, titles, cluster labels, retention curves, and topical relevance do not
  enter the primary reward. Topical relevance is an explicit separate constraint.

## What remains valid

- The exhaustive contiguous-span and token-pair embedding lattice is mechanical.
- Counterfactual text inputs preserve source order and characters.
- Outcome-blind atlases remain separate from outcome axes.
- The saved four-cluster map is a valid frozen visualization.
- Random-fold predictions are genuinely out of fold.
- The observed-absolute curve forecast is measured at 41 normalized positions
  inside each source's analyzed hook. Its random-fold and strict future metrics
  are reported separately, and it remains diagnostic unless both promotion gates
  pass.
- Supplied example sentences remain evaluation-only and deterministic.

## Claim levels

The UI and artifacts use three levels:

1. **Outcome-blind structure**: geometry or clustering produced without outcomes.
2. **Conditional diagnostic**: an association tied to a selected category map,
   normalization, random-fold design, or exploratory representation.
3. **Validated transfer**: positive, baseline-improving, multiplicity-corrected,
   future-replicated, and robust to reasonable target definitions.

Market Hold reaches validated transfer only as a cross-source local-retention
training proxy. No current score reaches causal or universal promise-quality
status. Its component and pair values are exact model explanations, not separately
validated causal effects.

## Remaining limitations

- Only 208 videos from one channel are available. Channel-era and content-strategy
  drift are inseparable from calendar time.
- Retention curves are observational aggregates, not randomized outcomes.
- The manual probe conditions downstream category interpretation.
- Gemini embedding geometry may encode topic, wording, and production era together.
- Component response is weak and unstable after conservative partitioning.
- The available exact timing records end with the extracted hooks; none reaches
  22 seconds. The current model therefore emits nothing after each analyzed hook
  endpoint. Extending the same algorithm requires transcript and timing data for
  the additional words first.
- Percentiles are ranks against this 208-hook corpus, not calibrated probabilities.
- Market Hold percentiles are ranks against 5,353 external transcript scores, not
  probabilities. The direction can still encode topic, channel style, language,
  and transcription quality alongside promise structure.

## Promotion gate for a future hook score

A new score may be promoted to a training proxy only if all of the following are true:

1. Its target can be computed without information from after the claimed response
   window, or that future conditioning is explicitly part of the estimand.
2. Hyperparameters and target variants are selected inside training folds.
3. Random-fold association is positive and multiplicity-corrected.
4. Expanding-window future association and baseline improvement are positive.
5. The result is stable across declared chronological block counts.
6. Reasonable normalization alternatives produce positively aligned targets and
   predictions.
7. The fitting labels and evaluation labels are isolated, or the result replicates
   on a new frozen batch.

Promotion from proxy to a causal better/worse hook score additionally requires a
randomized same-topic hook-variant experiment.

Until then, Promise Lab supplies a deterministic optimization proxy and a much
richer instrument panel, not an oracle for which exact hook will win.
