# Deterministic Hook Scorer

This is the deployable Promise Lab path from raw hook text to one quantitative
score, four non-overlapping component attributions, six pair interactions, and
explicit uncertainty. It also reports four held-out complete-hook outcomes, a
rough 0-20 second retention forecast, predicted retention at each word-response
time, and a separately validated forward retention response for each component.
It uses the same `gemini-embedding-2` 1536-dimensional
text space as Long Quant. It does not ask a generative LLM to interpret, split,
rank, or rewrite the hook.

The score is deliberately named **Hook retained-information percentile**, not
virality. On this 208-hook corpus, the retention-derived direction survives
held-out validation; observed views do not. Calling the current direction a
views or virality predictor would overstate the evidence.

## 1. Frozen semantic categories

The category system comes from retained map `0042a54b685d55438242`:

- representation: `raw-hook-residual`
- transform: whitened four-dimensional PCA
- clustering: frozen `k=4`
- embedding model: `gemini-embedding-2`, 1536 dimensions

Category assignment happens only after boundaries are selected. Categories do
not vote on the boundaries, and the decoder does not force all four category
labels to appear in every hook.

## 2. Exact four-part partition

For a hook of `n` tokens, the decoder enumerates every triple of cuts
`0 < b1 < b2 < b3 < n`. A candidate is valid only when each of its four
contiguous chunks contains at least one lexical token. This produces one exact
cover:

`[0:b1), [b1:b2), [b2:b3), [b3:n)`

Every source token therefore has exactly one owner. Coverage is 100%, overlap
is zero, order is unchanged, and nothing is silently dropped.

For chunk `j`, let `e_j` be its isolated unit embedding, `d_j` its unit
in-context deletion-influence embedding, and `h` the full-hook unit embedding.
The outcome-blind partition objective is:

`partition_score = 0.5 * cos(h, sum_j e_j) + 0.5 * cos(h, sum_j d_j)`

The highest-scoring exact cover wins. The gap to the runner-up is retained as
partition uncertainty. On the training corpus there are 0 coverage failures
and 0 overlapping tokens across 208 hooks and 832 canonical chunks. A held-out
boundary audit reaches ROC AUC 0.817621 and average precision 0.748050. The
median top-two score gap is only 0.002210, so the UI exposes that uncertainty
instead of pretending every boundary is certain.

## 3. Outcome definition

The learning target starts with six endpoint-normalized retention measurements:

1. retention at 3 seconds
2. retention at 5 seconds
3. retention at 8 seconds
4. retention at 10 seconds
5. retention at the measured hook end
6. mean retention from hook end through hook end plus 5 seconds

Within each training fold, these six values are imputed, standardized, and
reduced to PC1. Its sign is fixed so all loadings are positive. The factor
explains 90.1888% of their variance, with loadings from 0.3958 to 0.4161.

A ridge model then removes seven measured confounds from that target:

- token count
- video duration
- hook-end time
- viewed percentage
- entry retention
- terminal retention
- entry-to-terminal amplitude

The residual is the amount of retained information above or below what those
measured conditions predict. It is observational and does not prove causality.

## 4. Frozen quality direction

Inside each training fold, normalized hook embeddings are reduced by PCA and a
ridge model predicts the residual retention factor. Dimension count and ridge
alpha are selected only inside the training portion of each outer fold. The
deployable fit selected 8 dimensions and ridge alpha 0.1.

The ridge coefficients are mapped back into the original 1536-dimensional
embedding space and normalized to one vector `q`. For a new unit hook embedding
`x`:

`axis_coordinate = x dot q`

`display_percentile = percentile(axis_coordinate among 208 training hooks)`

Nested five-fold validation of the same held-out coordinate gives Spearman
0.221148, Pearson 0.235324, and a 4,096-repeat sign-flip p-value of 0.001220.
Median cosine agreement among fold directions is 0.516642 and every fold-pair
direction has the same sign. These values are the current evidence level; the
UI does not replace them with an invented confidence label.

Observed log views alone fail the same held-out test (Spearman 0.0152,
p=0.8204). A joint retention-plus-views target also gives views the opposite
sign from retention. That falsification is why the production label remains a
retention-information score rather than a generic viral score.

## 5. Components and relationships

Once the four exact-cover chunks are fixed, the scorer constructs all 16 subset
states. Mask 0 is the declared additive origin because an empty string cannot
be embedded. Masks 1 through 15 preserve the original characters and order of
their retained chunks; each unique text is embedded once.

For subset-value function `v(S) = unit_embedding(S) dot q`, each component gets
the exact four-player Shapley value:

`phi_i = sum over S not containing i of |S|!(4-|S|-1)!/4! * [v(S+i)-v(S)]`

The four values sum exactly to the full hook coordinate. Six Shapley interaction
indices measure whether each component pair performs above or below the sum of
its isolated effects while averaging over every remaining context. The UI shows
all 15 real embedding inputs, singleton effects, deletion effects, component
bootstrap intervals, pair intervals, and category-relative percentiles.

The broad Shapley values above decompose the complete-hook retained-information
axis. A second value function measures local response. For each exact component,
the serving feature is an equal-energy concatenation of:

- its isolated unit embedding;
- its in-context deletion-influence unit embedding.

A different frozen 3072-dimensional direction is fitted for each of the four
outcome-blind categories. The relationship between components `i` and `j` is
the exact second-order interaction across all 16 subset states on component
`j`'s category-specific forward-response direction. This keeps order and
context in the calculation instead of averaging isolated phrase scores.

## 6. Uncertainty and latency

The model stores 128 source-bootstrap refits. Each scored hook reports the 10th,
median, and 90th percentile under those refits, plus pairwise ordering frequency
when alternatives are compared. It also reports:

- nearest-training-hook cosine and its leave-one-out training percentile
- canonical partition top-two gap and its training percentile
- held-out model statistics

Latency is tested rather than assumed. The earlier study asked whether one
whole-hook semantic direction could be reused unchanged at every lag; that
fixed-direction hypothesis did not validate and remains visible as a negative
result. The production component study asks the relevant different question:
which forward shift lets category-specific component semantics predict their
own local retention response?

The selectable candidates are the exact spoken interval shifted forward from
0 through 5 seconds in 0.5-second increments. Reverse-time shifts from -3 to
-0.5 seconds are falsification controls and can never win. Within every outer
source-video fold, the lag is selected using only the training videos and an
equal-category Fisher mean of held-out rank correlations. The selected ruler is
then tested once on untouched videos.

The selected production ruler is **+1.0 second**. Its fixed held-out
category-balanced Spearman is `0.2050`; category values are `0.2125`, `0.2445`,
`0.2346`, and `0.1267`, all positive. The nested selection procedure is also
positive, and the fixed +1-second signal exceeds every reverse-time control.
Across 2,048 source bootstraps the median winning lag is 1.0 second; the 10th to
90th percentile range is 0.5 to 4.0 seconds, and +1 second wins 42.3%. The UI
shows that uncertainty rather than presenting one second as millisecond-level
certainty.

For interval `[start, end]`, the observed target is the least-squares slope over
`[start + 1, end + 1]` after endpoint normalization. A text-free ridge baseline
uses exact timing, duration, entry, terminal, amplitude, and the out-of-fold
entry expected from terminal retention. The modeled target is observed minus
expected slope. Higher means flatter loss or a rise beyond expectation.

Two attempted extensions fail their own held-out gates and are not promoted:
the equal average of four component scores does not validate as a new whole-hook
score, and a standalone pair-residual model is only borderline. The original
complete-hook retained-information axis remains the overall hook score; pair
cells are exact interactions on the validated later-component axis and make no
separate causal claim.

## 7. Outcome axes and retention forecast

The frozen four-part boundaries are reused without refitting. Four direct linear
serving axes are trained from the complete 1536D hook embedding with grouped
out-of-fold validation:

- viewed-versus-swiped percentage: rho 0.2858, q 0.00033
- five-second retention: rho 0.3462, q 0.00033
- average retention: rho 0.2748, q 0.00049
- log10 observed views: rho 0.2542, q 0.00033

Each displayed training prediction is out of fold. Live inputs use the final
frozen direction and retain empirical 10th-to-90th residual intervals. Views are
modeled in log10 space and converted back to counts only for display.

The same exact component plus deletion-influence feature is fitted separately
inside each frozen category. Source-aggregated component predictions validate
for five-second and average retention, but component-only viewed percentage and
views do not. More importantly, none of the individual category outcome axes
passes its own family-corrected gate. The UI therefore renders every component
plane for inspection but marks those outcome maps **diagnostic**, never as a
validated replacement hook score.

A multi-output ridge model predicts absolute audience retention every 0.5
seconds from 0 through 20 seconds. Source-held-out MAE is 5.381 percentage
points versus 5.813 for the text-free mean-curve baseline, a 7.43% improvement;
mean timewise rho is 0.3836 and the empirical 80% band covers 79.81%. Exact
caption timings are used for 203 of 208 stored hooks. A live hook uses the
source-equal mean speaking rate of 3.9175 lexical words/second, then shifts each
word response forward by the measured +1.0-second lag. This is a rough
observational forecast, not a causal audience simulator.

## 8. Supplied example, held out from training

The four supplied sentences are evaluation-only. Scoring them twice produces
the identical JSON SHA-256
`0b3f77a1750241534952fa3596245374cb9da933b9d446015b5c063b6812f89a`.

| Hook | Percentile | Bootstrap P10-P90 |
| --- | ---: | ---: |
| machine, unexpected use | 49.52 | 32.21-74.13 |
| machine, second feature | 37.02 | 28.89-69.18 |
| machine, mechanism question | 35.10 | 22.93-66.15 |
| Lego shoulder scenario | 22.12 | 14.90-58.61 |

The frozen main-axis order for the three machine variants is:

`unexpected use > second feature > mechanism question`

Across 128 source-bootstrap refits, the unexpected-use version wins 67.97%, the
second-feature version 21.88%, and the mechanism question 10.16%. Unexpected use
beats mechanism question in 83.59% of refits and beats second feature in 71.09%.

All four examples are near the edge of the observed semantic domain: their
nearest-training similarity percentiles range from 0.96 to 4.33. Consequently,
the intervals are broad. The result is objective and reproducible, but it is not
high-confidence evidence that the ordering will generalize to every unseen
topic. Adding more diverse hooks with retention outcomes is the honest path to
tighter confidence.

## 9. Reproduction and serving

The orchestrated build sequence is:

```bash
python buildings/jarvis/promise-lab/build.py --from-stage canonical-partitions
```

The hard gates are:

```bash
python buildings/jarvis/promise-lab/verify_canonical_partitions.py
python buildings/jarvis/promise-lab/verify_hook_quality.py
python buildings/jarvis/promise-lab/verify_forward_response.py
python buildings/jarvis/promise-lab/verify_hook_outcomes.py
python buildings/jarvis/promise-lab/verify_hook_examples.py
```

The on-demand scorer is dependency-light and shared by training and serving:

```bash
printf '%s' '{"text":"A complete hook"}' \
  | python buildings/jarvis/promise-lab/score_hook.py --stdin
```

`POST /api/longquant/promise-lab/hook-score` invokes that same scorer. The UI
submits it through BusinessWorld's shared asynchronous Long Quant job lane, so
the POST returns immediately, interactive work jumps ahead of queued background
scores, completed results persist in R2, and a server restart triggers bounded
resubmission instead of a silent timeout. The browser stores only the pending job
ID, submitted hook text, and timestamp; reloading the page reattaches to that job,
while the text and evaluation examples stay locked until the matching result
arrives. The synchronous form remains available for local verification.

Live input is capped at 64 tokens before any embedding request. The exhaustive
span/context surface grows quadratically, and 64 already covers the training
corpus maximum of 57 without allowing an accidental paragraph to create an
unbounded API and memory job.

Large artifacts are loaded from `longform/promise-lab-v4/` in R2 and cached in
`/tmp`; there is no resident GPU and no always-on model worker. The Promise Lab
**Hook scorer** tab renders five complete-hook planes, all six score planes for
each of four components, the rough retention curve and word-response points,
stored example comparison, exact partition, component contributions, pair
interactions, subset inputs, domain evidence, and latency decision. The **Hook
library** renders all 208 source-held-out predictions beside actual viewed ratio,
retention, views, and curves; expanding a row reuses the same maps and inspectors
without recomputing or changing views.
