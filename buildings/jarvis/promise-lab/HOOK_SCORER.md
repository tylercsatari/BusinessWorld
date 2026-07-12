# Deterministic Hook Scorer

This is the deployable Promise Lab path from raw hook text to one quantitative
score, a variable number of non-overlapping component attributions, every local
pair interaction, and explicit uncertainty. It also reports four held-out complete-hook outcomes, a
rough 0-20 second retention forecast, predicted retention at each word-response
time, and a separately validated forward retention response for each component.
It uses the same `gemini-embedding-2` 1536-dimensional
text space as Long Quant. It does not ask a generative LLM to interpret, split,
rank, or rewrite the hook.

The primary score is deliberately named **Length-adjusted hook survival
percentile**, not virality. It predicts whether a hook loses less
endpoint-normalized retention than the ordinary loss for the same response
duration. The earlier retained-information direction remains visible as a
separate complete-hook plane and as the broad component deletion channel.

## 1. Frozen semantic categories

The category system comes from retained map `0042a54b685d55438242`:

- representation: `raw-hook-residual`
- transform: whitened four-dimensional PCA
- clustering: frozen `k=4`
- embedding model: `gemini-embedding-2`, 1536 dimensions

Category assignment happens only after boundaries are selected. Categories do
not vote on the boundaries, and the decoder does not force all four category
labels to appear in every hook.

## 2. Variable exact-cover partition

For a hook of `n` tokens, there are `n-1` possible internal cuts. Outcome-blind
discovery labels a gap positive only when all three geometric segmentation
families place it above their own token-gap permutation null. A 14-feature
semantic boundary model is fitted with grouped source-video holdout. Features
measure embedding contrast around the cut; they contain no outcomes, supplied
phrases, component count, token position, duration, or LLM labels.

The serving model gives each gap a cut probability `p_i`. For any contiguous
lexical exact cover, the decoder evaluates:

`log P(cover) = sum(cut gaps log(p_i)) + sum(uncut gaps log(1-p_i))`

The maximum-posterior cover wins. Every source token has exactly one owner,
coverage is 100%, overlap is zero, order is unchanged, and nothing is silently
dropped. There is no chosen `k`, maximum component count, duration rule,
significance threshold, or tuned split penalty. The four semantic categories
are assigned only after boundaries are fixed and may repeat or be absent.

On the 208-hook training corpus this yields 1,006 components: minimum 1, median
5, mean 4.84, and maximum 15. The count histogram is stored in the artifact and
displayed in the UI. Only 15 hooks use all four category labels. The grouped
held-out boundary model reaches ROC AUC 0.7053 and average precision 0.3683.
Saved training rows retain source-held-out probabilities; live serving averages
the grouped fold models. The top-two cover gap and every selected edge
probability remain visible as uncertainty.

## 3. Retained-information diagnostic

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

## 4. Frozen retained-information direction

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
retention score rather than a generic viral score.

## 4a. Primary length-adjusted survival score

The primary score is fitted in a fully nested five-fold procedure. For each
measured source, let `F` be the arithmetic mean of the final `max(3, 5%)`
retention samples and let the entry excess be `E = max(R(0)-100, 0)`. The
additive terminal-conditioned replay envelope is:

`C(t) = E * clip((R(t)-F) / (R(0)-F), 0, 1)`

`R_normalized(t) = R_observed(t) - C(t)`

This makes every corpus curve start at exactly 100 without fitting a shared
time-decay shape. Because both outputs are affine in the same observed value
between the entry and terminal anchors, the correction cannot create a
direction reversal absent from the observed curve. It remains an empirical
endpoint-conditioned index, not identified replay counts or a causal
first-pass curve. A measured curve and measured terminal anchor are required;
text alone cannot be normalized. The observed curve remains available in the
UI.

The rewatch hypothesis is supported observationally: terminal retention versus
entry inflation has Spearman `0.85546` (`p < 1e-60`), and entry inflation versus
the 0-3 second slope has Spearman `-0.92168` (`p < 1e-85`).

Let `T` be the exact spoken hook end plus the validated +1 second response lag.
The geometric percent carried through each second is:

`carry = 100 * exp(log(R_normalized(T) / 100) / T)`

A text-free ridge baseline predicts ordinary carry using `T`, `T^2`, and
`log(T)`. The semantic target is `carry - expected_carry`. Higher therefore
means less loss than normal at the same duration. The complete-hook Gemini
embedding predicts this target with nested held-out Spearman `0.30444`, Pearson
`0.31112`, MAE improvement `5.30%`, sign-flip `p=0.000244`, median fold-direction
cosine `0.73548`, and positive agreement for every fold pair.

The displayed percentile ranks the semantic prediction among the 208 training
hook predictions. Stored rows also expose a separate actual-target percentile;
the two are never conflated.

## 5. Components and relationships

Once the variable exact cover is frozen, each component receives one
full-context deletion effect on the retained-information axis:

`effect_i = v(full) - v(full without i)`

Each pair receives one exact local second-order deletion interaction:

`interaction_ij = v(full) - v(without i) - v(without j) + v(without i,j)`

This requires `n + n(n-1)/2` counterfactual states instead of an exponential
power set, so hooks with 1, 3, 10, or 15 components use the same method. Every
retained string preserves source order and source characters. These local
effects are deliberately not called Shapley values and make no completeness or
additivity claim. The UI exposes every deletion input, pair input, bootstrap
interval, and category-relative percentile.

A second value function measures local response. For each exact component,
the serving feature is an equal-energy concatenation of:

- its isolated unit embedding;
- its in-context deletion-influence unit embedding.

A different frozen 3072-dimensional direction is fitted for each of the four
outcome-blind categories. The relationship between components `i` and `j` is
the same local second-order deletion interaction on component `j`'s
category-specific forward-response direction. This keeps order and
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
category-balanced Spearman is `0.1433`; category values are `0.1434`, `0.1973`,
`0.1928`, and `0.0375`, all positive. The nested selection procedure is also
positive, and the fixed +1-second signal exceeds every reverse-time control.
Across 2,048 source bootstraps the median winning lag is 1.0 second; the 10th to
90th percentile range is 0 to 1.5 seconds, and +1 second wins 42.1%. The UI
shows that uncertainty rather than presenting one second as millisecond-level
certainty.

For interval `[start, end]`, the observed target is the least-squares slope over
`[start + 1, end + 1]` after endpoint normalization. A text-free ridge baseline
uses exact timing, duration, entry, terminal, amplitude, and the out-of-fold
entry expected from terminal retention. The modeled target is observed minus
expected slope. Higher means flatter loss or a rise beyond expectation.

The equal average across each hook's emergent component scores does not validate
as a new whole-hook score and is not promoted. The standalone relationship
residual is statistically predictive in source holdout, but remains a separate
descriptive relationship axis rather than a causal or headline hook score. The
headline survival score is fitted directly from the complete hook.

## 7. Outcome axes and retention forecast

The frozen variable-count boundaries are reused without refitting. Four direct linear
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

A second nested model predicts the endpoint-normalized training curve on the
same 41-point grid. Its held-out MAE is 3.834 percentage points versus 4.105 for
the text-free baseline, a `6.61%` improvement; mean timewise Spearman is
`0.29230`, and the
empirical 80% band covers `80.30%`. All 208 source videos are at least 22
seconds, so no 20-second target is extrapolated beyond an observed source
video. Spoken hooks end at median 4.99 seconds and maximum 12.76 seconds. The UI
marks hook end plus response lag and shades the remaining region as a whole-hook
continuation forecast: no words or component categories are invented there.
Stored hooks can toggle between the measured observed and normalized curves.
Live text inputs show only the rough observed-retention forecast; they never
claim to have a normalized curve without measured retention and a terminal
anchor.

## 8. Supplied example, held out from training

The four supplied sentences are evaluation-only. Scoring them twice produces
the identical JSON SHA-256
`7057d67914eac9de0fb2dbd18f1837976e14ebd20875e89d613e5b931a7eecfe`.

| Hook | Survival percentile | Predicted carry/second | Response end |
| --- | ---: | ---: | ---: |
| machine, unexpected use | 74.52 | 96.682% | 6.11s |
| machine, second feature | 62.50 | 96.360% | 5.34s |
| machine, mechanism question | 60.10 | 96.049% | 4.32s |
| Lego shoulder scenario | 53.37 | 96.261% | 5.34s |

The frozen main-axis order for the three machine variants is:

`unexpected use > second feature > mechanism question`

The 128-refit winner frequencies still belong to the separate retained-information
axis: unexpected use wins 67.97%, second feature 21.88%, and mechanism question
10.16%. They are displayed as retained-information sensitivity evidence, not as
confidence for the survival ranking.

All four examples are near the edge of the observed semantic domain: their
nearest-training similarity percentiles range from 0.96 to 4.33. The result is
objective and reproducible, but it is not high-confidence evidence that the
ordering will generalize to every unseen topic. Adding more diverse hooks with
retention outcomes is the honest path to tighter confidence.

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

The exhaustive span/context surface grows quadratically with token count. The
serving queue isolates each request and reports the exact number of embedded
span, context, component-deletion, and pair-deletion inputs. Component count is
never capped or forced by the training-corpus maximum.

Large artifacts are loaded from `longform/promise-lab-v4/` in R2 and cached in
`/tmp`; there is no resident GPU and no always-on model worker. The Promise Lab
**Hook scorer** tab renders six complete-hook planes, all six score planes for
every emergent component in horizontally scrollable strips, observed and endpoint-normalized retention curves,
word-response points, and the explicit post-hook continuation region,
stored example comparison, exact partition, component deletion effects, pair
interactions, local counterfactual inputs, domain evidence, and latency decision. The **Hook
library** renders all 208 source-held-out predictions beside actual viewed ratio,
retention, views, and curves; expanding a row reuses the same maps and inspectors
without recomputing or changing views.
