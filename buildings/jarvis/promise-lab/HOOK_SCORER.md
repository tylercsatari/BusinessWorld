# Deterministic Hook Scorer

This is the deployable Promise Lab path from raw hook text to one quantitative
score, four non-overlapping component attributions, six pair interactions, and
explicit uncertainty. It uses the same `gemini-embedding-2` 1536-dimensional
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

## 6. Uncertainty and latency

The model stores 128 source-bootstrap refits. Each scored hook reports the 10th,
median, and 90th percentile under those refits, plus pairwise ordering frequency
when alternatives are compared. It also reports:

- nearest-training-hook cosine and its leave-one-out training percentile
- canonical partition top-two gap and its training percentile
- held-out model statistics

Latency is tested rather than assumed. The study evaluates 23 offsets from -3
through +8 seconds in 0.5-second steps across five retention windows, for 115
tests. Component scores and natural-drop baselines are cross-fitted by source,
then evaluated against a source-bootstrap family-wise max null. No positive lag
passes the predeclared rule, so production attribution uses no selected lag.

## 7. Supplied example, held out from training

The four supplied sentences are evaluation-only. Scoring them twice produces
the identical JSON SHA-256
`5429e521e26cefa248106516922dc744e8095a9c290227c36a9ab893e66551c5`.

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

## 8. Reproduction and serving

The orchestrated build sequence is:

```bash
python buildings/jarvis/promise-lab/build.py --from-stage canonical-partitions
```

The hard gates are:

```bash
python buildings/jarvis/promise-lab/verify_canonical_partitions.py
python buildings/jarvis/promise-lab/verify_hook_quality.py
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
**Hook scorer** tab renders the quality map, stored example comparison, exact
partition, component contributions, pair interactions, subset inputs, domain
evidence, latency decision, and nearest training hooks from these same artifacts.
