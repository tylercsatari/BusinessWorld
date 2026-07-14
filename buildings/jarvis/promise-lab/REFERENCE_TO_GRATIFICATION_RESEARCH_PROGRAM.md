# Reference to Gratification Research Program

## 1. Mission

The objective is not to assign a hand-written definition to "reference to
gratification" (RTG). The objective is to discover whether a reproducible,
quantifiable construct exists that distinguishes:

1. the underlying video idea,
2. the way that idea is initially communicated,
3. the additional promise, question, stake, consequence, constraint, social
   outcome, transformation, uncertainty, or other framing added around it,
4. the context required for that addition to make sense, and
5. the measured audience behavior that follows.

The desired end state is a model that can compare multiple intros expressing
the same underlying idea and estimate which transformation of the promise is
more likely to produce the audience behavior associated with a strong promise.
For example, it should eventually distinguish among:

- testing viral juggling gloves,
- testing them to see whether they enable juggling without experience,
- testing them to impress a friend,
- testing them to get a circus job, and
- testing them while going undercover as a professional juggler.

The program must discover the relevant dimensions from data. None of those
examples may be encoded as the definition or as privileged labels.

## 2. Non-Negotiable Research Rules

### 2.1 The construct is unknown

RTG is not a title, a hook, a phrase, a semantic neighbor, a retention metric,
or an embedding direction by definition. Each of those can be an input,
measurement, control, representation, or candidate mechanism. None is ground
truth.

### 2.2 The existing hooks and embeddings are primary raw data

The hooks have already been extracted and embedded in Long Quant's long-form
text space. Those exact hook texts and 1,536-dimensional vectors must remain
available as an untouched analysis channel. New component representations may
be derived from them, but the source hook vectors are never replaced.

### 2.3 Clusters remain unlabeled until independently characterized

An unlabeled cluster is identified by a stable numeric ID, its geometry, and
its members. Exemplars are displayed to help inspect it, but an exemplar such
as "world's smallest burger cube" is not a discovered RTG and must never be
presented as one. A semantic name is a later interpretation layer and cannot be
used to train or validate the discovery that produced the cluster.

### 2.4 Idea removal is an experiment, not an assumption

The published title is a useful but noisy anchor for the base idea. `hook -
title` is one candidate representation, not a factual decomposition. The study
must compare multiple idea anchors and multiple methods of removing or
conditioning on idea information.

### 2.5 Context cannot be discarded

A component can be ineffective in isolation and effective after the necessary
context. Every atomic component analysis therefore needs paired context-aware
analyses: component alone, context alone, whole hook, deletion from the whole,
insertion into context, and component-context interaction.

### 2.6 Outcome discovery is also unlabeled

No retention statistic is declared the RTG target in advance. Fixed-time
retention, hook-relative retention, flattening, persistence, rewatch, curve
shape, views, keep rate, and learned curve components are candidate
measurements. The useful outcome geometry must emerge through replication
across measurement families.

### 2.7 Observational prediction is not causal transformation

The current 208-video corpus can discover associations and candidate latent
directions. It cannot by itself prove that moving a phrase along a direction
causes better retention. Same-idea counterfactual tests and later randomized
creative experiments are required before the final system can make causal
claims.

### 2.8 Every reported result must be traceable

Every cell in every matrix must resolve to:

- source video IDs,
- exact hook text,
- exact component token span and timestamps,
- embedding model and content hash,
- retention curve and coordinate system,
- outcome formula and parameters,
- confound set,
- estimator and hyperparameters,
- train/test grouping,
- random seed,
- null family and multiple-testing family,
- out-of-fold predictions, and
- uncertainty/stability results.

## 3. Current Data Inventory and Audit

The current source is `longform/hook-embeds/index.json` plus one detail record
per video in `longform/hook-embeds/<video-id>.json`.

At the start of this program:

- 211 videos are indexed.
- 208 have hooks and retention curves complete enough for the current study.
- Each complete video has an exact canonical hook text and a deterministic
  source-media hook endpoint with an explicit confidence/audit record. Every
  hook is projected onto the same opening CTC intervals: normalized zero-edit
  prefixes and lexical variants use one character-edit algorithm, and the
  endpoint must be an acoustic opening-word boundary. Internal within-word cuts
  remain visible estimates and are excluded from timing-sensitive outcomes when
  a component lacks acoustic support at either outer edge.
- Each exact hook has a 1,536-dimensional `gemini-embedding-2` vector in the
  same text space used by Long Quant.
- Published titles have vectors in the same space.
- The latest global title basis contains 42,599 Long Quant title vectors and is
  content-versioned so corpus growth automatically invalidates stale geometry.
- Retention curves contain 100 normalized samples across video duration.
- Word-level transcript timelines contain 20 to 60 words and generally cover
  the first 3.8 to 12.7 seconds, with a median near 12.1 seconds.
- Source audio is resolved for all 208 videos: 133 from BusinessWorld media and
  75 from a public YouTube audio cache. Canonical transcript text is unchanged;
  Wav2Vec2 CTC supplies timing and Whisper-base independently audits all 208
  openings. Full-opening lexical context pairs 204 final hook endpoints without
  confusing repeated words; median endpoint disagreement is 0.046 seconds and
  p95 is 0.146 seconds. Unpaired endpoints remain unavailable.
- 189 hook cuts were selected by a model and 19 were selected by Tyler.
- 45 stored hook-word counts disagree with the actual hook text; discrepancies
  reach 31 words. Word counts must be recomputed from source text, while the
  stored count remains visible as an audit field.

This audit must be generated automatically on every run. Records must not
quietly disappear. The three incomplete records need explicit exclusion
reasons in the report.

## 4. Formal Research Object

For video `i`:

- `H_i` is the canonical hook transcript; its word intervals are deterministic
  source-media CTC estimates and are never described as hand-labeled exact time.
- `E(H_i)` is its existing Long Quant text embedding.
- `T_i` is the published title and `E(T_i)` its embedding.
- `W_i = {w_i1 ... w_im}` is the timestamped word sequence.
- `R_i(t)` is the observed retention curve.
- `V_i` is the set of traditional video outcomes and Long Quant placements.
- `C_i` is the measured confound vector.
- `I_i` is the unknown underlying idea representation.
- `S_i[a:b]` is a contiguous component span of the hook.
- `K_i[a:b]` is the complementary context after removing that span.

The broad observational question is whether a representation `Z` derived from
`H`, its components, and its context predicts a reproducible aspect `Y` of
retention geometry after an explicit adjustment set `A`:

`Y_i = f(Z_i, A_i) + error_i`

The transformation question is stricter. For two hooks with approximately the
same idea, does the difference in their promise representation explain the
difference in their retention geometry:

`Delta Y_(i,j) = g(Delta Z_(i,j), shared idea, Delta A_(i,j)) + error_(i,j)`

The final causal question requires controlled variants of the same produced
video and is outside what the observational corpus alone can prove.

## 5. Multi-Resolution Component Lattice

The program will not ask one extractor to guess "the gratification phrase."
It will construct a deterministic lattice containing all reasonable units and
let stability across resolutions reveal which units matter.

### 5.1 Source-preserving resolutions

1. Full hook.
2. Every token.
3. Every contiguous 2-token and 3-token span.
4. Every contiguous window of 4-6, 7-10, and 11-16 tokens.
5. Every prefix and suffix at each token boundary.
6. Every clause-like span split by punctuation, pauses, and conjunctions.
7. Every timestamp window at 0.5, 1, 2, 3, and 5 seconds.
8. Every data-driven change-point segment in the prefix embedding trajectory.
9. Every leave-one-span-out deletion from the full hook.
10. Selected pairs and triples of non-overlapping spans.

Stop-word-only and empty spans remain in the manifest as rejected candidates
with deterministic rejection reasons. They are not silently filtered.

### 5.2 Representations for every component

For each component span `S` with context `K`, create:

- `E(S)`: component in isolation,
- `E(K)`: context with the component deleted,
- `E(H)`: full hook,
- `E(H) - E(K)`: contextual marginal vector,
- component orthogonal to context,
- full hook orthogonal to the current idea anchor,
- marginal vector orthogonal to the current idea anchor,
- prefix-state before the component,
- prefix-state after the component,
- prefix transition vector,
- suffix-state after the component,
- component/context cosine and distance,
- component/title and context/title relations,
- component/global-title-manifold coordinates, and
- interaction features between component and context coordinates.

No one representation is privileged. The representation is a registered axis
of the experiment matrix.

### 5.3 Attention-like relational graph

Each hook becomes a graph rather than a bag of phrases:

- nodes are components at multiple resolutions,
- containment edges link spans to parents and children,
- sequence edges encode order and temporal distance,
- semantic edges encode embedding similarity,
- context edges encode how much a component changes the full-hook embedding,
- title edges encode relation to candidate idea anchors, and
- outcome edges are learned only inside training folds.

Attention-like scores must be descriptive unless learned out of fold. A score
that used an outcome to select a component cannot be evaluated on that same
video.

### 5.4 Context dependency tests

For each component cluster and each context cluster, test:

- component alone,
- context alone,
- additive component + context,
- multiplicative interaction,
- full hook,
- deletion effect,
- prefix transition effect,
- order-sensitive versus order-scrambled component sets, and
- compatibility or out-of-distribution distance.

This is how a promising component that only works after setup can be separated
from a phrase that appears effective in isolation.

## 6. Unlabeled Component Discovery

Component discovery is performed independently of performance outcomes first.

### 6.1 Geometry families

- K-means across a broad range of `k`.
- Agglomerative clustering across distance thresholds.
- Spectral clustering on component-context graphs.
- Density clustering when the installed runtime supports a stable method.
- PCA and global-title-basis projections.
- Diffusion/spectral coordinates for nonlinear manifold structure.
- Co-clustering of components and contexts.

### 6.2 Stability requirements

For every cluster family, record:

- bootstrap adjusted Rand stability,
- split-half matching,
- seed stability,
- resolution consistency,
- cluster size and entropy,
- semantic idea concentration,
- transcript-source concentration,
- duration/hook-length concentration, and
- nearest exemplar diversity.

Clusters dominated by one topic, one source, one duration band, or one cut
method are flagged as likely confounded. They are not removed automatically.

### 6.3 Cluster presentation

The UI may show:

- numeric cluster ID,
- medoid components,
- nearest and farthest members,
- parent/child clusters across resolutions,
- context distributions,
- outcome profiles with uncertainty, and
- confound profiles.

The UI may not present a member string as the cluster's discovered concept.

## 7. Candidate Idea Isolation Matrix

The base idea is itself latent. The study must compare these anchors:

1. Published title vector.
2. Full-hook vector.
3. Global Long Quant neighbors of the title.
4. Global Long Quant neighbors of the hook.
5. Shared title/hook subspace.
6. First clause or early prefix.
7. Topic centroid from unsupervised title clusters.
8. Multi-view latent factor shared by title and hook.
9. Nearest same-topic corpus medoid.
10. No idea removal.

For each anchor, compare:

- subtraction,
- orthogonal projection,
- cross-fitted residualization,
- conditional matching,
- within-cluster centering,
- pairwise differencing among nearest ideas, and
- multi-view partial least squares or canonical correlation.

The title anchor is therefore one row in a matrix, not the definition of the
idea.

## 8. Retention Geometry Atlas

The retention curve must be measured in multiple coordinate systems because a
good delayed promise and a good immediate transition can generate different
shapes.

### 8.1 Coordinate systems

1. Absolute seconds from video start.
2. Fraction of full video duration.
3. Seconds relative to the acoustically aligned hook end.
4. Fraction of video relative to hook end.
5. Seconds relative to each component's beginning and end.
6. Word index relative to each component.
7. Retention normalized to `R(0)`.
8. Retention normalized to `R(hook end)`.
9. Retention with initial rewatch excess removed.
10. Rank-normalized curves for shape-only comparison.

### 8.2 Point and hold measurements

Generate point values and ratios on dense parameter grids:

- fixed seconds from 0 through the available duration,
- fixed duration fractions,
- offsets before and after hook end,
- offsets before and after every component boundary,
- retention relative to start, hook end, and component boundary,
- cumulative hold from each anchor, and
- time to cross 99%, 97.5%, 95%, 90%, 85%, 80%, 75%, and 50% of an anchor.

### 8.3 Slope measurements

For windows of 0.5, 1, 2, 3, 5, 8, 10, 15, and 20 seconds:

- endpoint slope,
- least-squares slope,
- robust median slope,
- maximum decline,
- minimum decline,
- mean absolute slope,
- slope variance,
- pre/post-anchor slope difference,
- slope ratio, and
- sustained near-zero slope duration.

### 8.4 Curvature and flattening

For multiple smoothing bandwidths:

- first and second derivatives,
- first flattening time under each slope threshold,
- longest flat interval,
- flattest interval and its start time,
- time to stable flattening,
- number of flattening reversals,
- maximum convex and concave change,
- hook-boundary change in curvature,
- component-boundary change in curvature, and
- piecewise-linear change points.

### 8.5 Rewatch and replay measurements

- starting retention above 100%,
- peak retention above 100%,
- area above 100%,
- duration above 100%,
- early excess decay rate,
- normalized curve after subtracting start excess,
- normalized curve after subtracting early replay area,
- rebound count and rebound area, and
- sensitivity of every key result with and without these corrections.

### 8.6 Persistence and payoff-horizon measurements

- area under retention for every start/end window,
- post-hook area at all horizons,
- component-aligned area at all horizons,
- short, medium, and long hold composites,
- early-hold versus late-hold contrast,
- fraction of video before the next large drop,
- longest interval without a material drop,
- tail retention conditional on early retention,
- full-duration retention conditional on hook-end retention, and
- candidate immediate, delayed, and sustained gratification profiles.

These profiles are descriptive families, not RTG labels.

### 8.7 Unsupervised curve representations

- Functional PCA on raw curves.
- Functional PCA on start-normalized curves.
- Functional PCA on hook-aligned curves.
- PCA on first derivatives.
- PCA on second derivatives.
- Discrete cosine coefficients.
- Wavelet-like multi-scale differences.
- Piecewise-linear segment parameters.
- Curve-shape clusters across multiple resolutions.
- Joint embeddings of level, slope, and curvature channels.

Every unsupervised curve component must publish its loading curve and explained
variance. It may not be described only as "shape 1."

## 9. Traditional Outcomes as Diagnostics

The following remain in the matrix but are not privileged RTG truth:

- Viewed versus swiped away,
- average retention,
- views and log views,
- age-adjusted views,
- Long Quant CTR,
- Long Quant CTR + views,
- Long Quant 30-second retention,
- Long Quant views,
- Long Quant realistic views,
- Long Quant scaled views,
- Long Quant 10M-class placement, and
- existing raw-map coordinates and percentiles.

Keep rate is especially important as a visual/opening diagnostic and potential
confound. It is not assumed to measure the spoken promise.

## 10. Confound Atlas

### 10.1 Timing and language delivery

- acoustically aligned hook duration,
- hook duration uncertainty,
- hook endpoint selection method,
- actual token count,
- stored token count discrepancy,
- speech rate,
- pause structure,
- transcript source,
- caption confidence when available,
- component start/end time,
- component position,
- full video duration, and
- hook duration as a fraction of video duration.

### 10.2 Entry and replay

- starting retention,
- early retention at dense fixed times,
- area above 100%,
- initial drop magnitude,
- initial drop speed,
- keep rate,
- swipe rate, and
- early curve PCs.

### 10.3 Idea and semantic content

- title embedding PCs,
- hook embedding PCs,
- global-title-basis coordinates,
- semantic idea cluster,
- nearest-neighbor density,
- title/hook cosine,
- topic rarity,
- title length, and
- existing Long Quant text placements.

### 10.4 Distribution and historical exposure

- upload age,
- total views,
- log views,
- channel era,
- posting cadence when available,
- repeat topic/series indicators,
- duration era, and
- any available impression/distribution signals.

### 10.5 Data quality

- curve completeness,
- transcript source,
- manual versus machine hook cut,
- hook-word mismatch,
- component timestamp coverage,
- missing metric indicators, and
- outlier influence.

## 11. Adjustment Sets and Causal Discipline

Blindly controlling everything can erase a real mechanism or create collider
bias. Each adjustment regime therefore has an explicit purpose:

1. `raw`: observed relationship only.
2. `delivery`: hook length, token count, speech rate, position, pauses.
3. `entry`: start retention, keep, initial drop, replay excess.
4. `idea`: cross-fitted idea coordinates and semantic group.
5. `distribution`: age, views-era, available distribution proxies.
6. `quality`: transcript/cut/data-quality indicators.
7. `delivery_entry`.
8. `delivery_idea`.
9. `entry_idea`.
10. `delivery_entry_idea`.
11. `full_pre_exposure`: all defensible pre-exposure confounds.
12. `sensitivity`: alternative sets that include questionable mediators.

Every outcome defines which variables are illegal self-controls. For example,
keep cannot control an experiment whose outcome is keep, and post-hook
retention cannot control a later-hold outcome unless the experiment explicitly
asks for conditional persistence.

Residualization must be cross-fitted. The same fold cannot fit a confound model
and score the residual on its own observations.

## 12. Exhaustive Relationship Matrices

The report must provide, at minimum:

1. Component × component similarity and co-occurrence.
2. Component × context compatibility.
3. Component cluster × context cluster interaction.
4. Component × idea-anchor relationship.
5. Component × retention metric relationship.
6. Component × traditional outcome relationship.
7. Component × confound relationship.
8. Retention metric × retention metric relationship.
9. Retention metric × traditional outcome relationship.
10. Retention metric × confound relationship.
11. Confound × confound relationship.
12. Representation × outcome performance.
13. Resolution × outcome performance.
14. Idea-removal method × outcome performance.
15. Adjustment set × outcome performance.
16. Estimator × outcome performance.
17. Validation split × experiment stability.
18. Same-idea pair × component difference × outcome difference.
19. Hook component order × outcome.
20. Negative-control family × false discovery rate.

Each matrix supports raw, partial, and nonlinear association views where the
sample size allows them.

## 13. Estimator Families

Because the current sample is only 208 videos, complexity is tightly
regularized. Candidate estimators include:

- Spearman and Pearson association,
- partial Spearman after cross-fitted residualization,
- distance correlation,
- mutual information with permutation calibration,
- ridge regression,
- elastic-net paths,
- centroid/prototype directions,
- partial least squares,
- canonical correlation between component and curve representations,
- kernel ridge on low-dimensional coordinates,
- shallow random forests as a nonlinear diagnostic,
- shallow gradient boosting as a nonlinear diagnostic,
- low-rank component-context interaction models,
- matched-pair difference models, and
- graph/spectral coordinates learned without outcomes.

Any nonlinear estimator must beat a matched-capacity null and demonstrate
stability. It is not allowed to win merely through in-sample flexibility.

## 14. Experiment Registry

Every experiment is generated from a structured specification:

`representation × component resolution × idea anchor × target geometry ×`
`adjustment set × estimator × fold design × seed × null family`

The registry assigns a deterministic experiment ID and content hash. It stores
status, runtime, memory, dependencies, and artifact locations. Results are
append-only by version; a changed formula creates a new experiment version.

The first broad sweep should contain tens of thousands of inexpensive linear
and association tests. Expensive nonlinear, bootstrap, and permutation tests
are promoted in stages using only training-fold evidence. The final lockbox is
never used for promotion.

## 15. Validation and Multiple Testing

### 15.1 Outer validation

- Five-fold leave-semantic-idea-clusters-out.
- Repeated grouped folds across several cluster resolutions.
- Leave-one-large-topic-cluster-out sensitivity.
- Manual-cut versus machine-cut split sensitivity.
- Whisper versus YouTube-caption split sensitivity.
- Era split and duration split sensitivity.

### 15.2 Nested selection

Component selection, cluster selection, hyperparameter selection, and axis
rotation occur inside training data. The outer test fold receives only the
frozen transformation.

### 15.3 Uncertainty

- grouped bootstrap intervals,
- fold-level sign stability,
- seed stability,
- influence diagnostics,
- leave-one-video-out sensitivity for top candidates,
- leave-one-semantic-cluster-out sensitivity, and
- paired uncertainty for matched-idea comparisons.

### 15.4 Multiple testing

- Benjamini-Hochberg within clearly declared families,
- hierarchical FDR across representation/outcome families,
- max-statistic permutation across every searched candidate in a promotion
  stage,
- family-level permutation that repeats selection itself, and
- an untouched final confirmation set when corpus growth makes that viable.

A low p-value from one selected axis is never enough.

## 16. Negative and Falsification Controls

The engine must run null analyses that are structurally similar to the real
search:

1. Outcomes shuffled globally.
2. Outcomes shuffled within semantic idea clusters.
3. Curves assigned to different hooks within duration bands.
4. Hook endpoints shifted randomly.
5. Random spans matched for length and position.
6. Token order scrambled while preserving the token set.
7. Titles assigned within topic clusters.
8. Random orthogonal embedding directions.
9. Synthetic noise embeddings with matching covariance.
10. Pre-hook and impossible future component alignments.
11. Transcript-source prediction as a nuisance target.
12. Hook-cut-method prediction as a nuisance target.
13. Duration prediction as a nuisance target.
14. Topic-cluster prediction as a nuisance target.

If an alleged RTG direction predicts source, cut method, duration, or topic
more strongly than retention geometry, it is flagged as a likely artifact.

## 17. Same-Idea and Counterfactual Program

### 17.1 Existing-corpus approximation

- Find nearest pairs under each candidate idea anchor.
- Require similarity thresholds and common support.
- Compare component differences against retention-geometry differences.
- Repeat with propensity/matching weights.
- Publish every pair and reject low-support pairs visibly.

### 17.2 Combinatorial compatibility map

For every base-idea anchor and discovered component cluster:

- compose or retrieve candidate combinations,
- embed the combination in the same Long Quant space,
- measure distance to the observed hook manifold,
- measure context compatibility,
- map predicted candidate axes without claiming observed performance, and
- retain nonsensical combinations as quantitative incompatibility evidence.

This supports examples such as applying a "public reaction" component to a
cardboard object. A combination that does not make semantic/contextual sense
should be represented as low support or out of distribution, not manually
deleted.

### 17.3 Controlled creative dataset

The observational corpus needs a later controlled extension:

- select base ideas,
- generate many promise transformations while preserving the idea,
- generate neutral and deliberately incompatible controls,
- collect blinded pairwise judgments without using RTG labels,
- deploy selected variants in randomized or sequential creative tests when
  feasible, and
- use observed within-idea differences as the causal validation set.

Synthetic generation creates candidate stimuli, not performance labels.

## 18. Emergence Standard for a Candidate RTG Construct

A candidate construct is promoted only if it satisfies all of the following:

1. Predicts more than one independently defined retention-geometry family.
2. Replicates across at least two component resolutions.
3. Replicates across at least two idea-isolation methods.
4. Survives defensible delivery, entry, idea, and data-quality adjustments.
5. Holds in grouped out-of-fold prediction.
6. Has stable sign and useful magnitude across folds and seeds.
7. Beats family-level selection permutations.
8. Is not primarily a topic, duration, transcript-source, or hook-cut axis.
9. Appears in same-idea matched differences.
10. Has interpretable component/context support without relying on a single
    exemplar.
11. Maintains performance under rewatch-corrected and uncorrected curves.
12. Specifies whether its effect is immediate, delayed, sustained, or
    context-dependent.

Until then the UI must say "candidate relationship," never "RTG score."

## 19. Required UI Surfaces

The Long Quant Gratification tab becomes a research console with:

- corpus integrity and exclusions,
- source hook browser with exact canonical words and model-estimated acoustic
  timestamps,
- multi-resolution component lattice,
- component/context graph,
- unlabeled cluster explorer with numeric IDs,
- retention geometry atlas,
- all relationship matrices,
- experiment registry and live progress,
- result promotion funnel,
- null and falsification dashboard,
- confound audit for every selected cell,
- matched same-idea pair browser,
- exact out-of-fold predictions,
- full provenance drawer,
- current evidence statement, and
- explicit hard limits and next data requirements.

The user must be able to click any matrix cell, point, component, or candidate
axis and reach the exact source data and formula.

## 20. Implementation Program

### Phase 0: Specification and integrity, Week 1

- Freeze this document as the research contract.
- Version the existing 816-experiment report as a preliminary baseline.
- Build automatic corpus/data-quality audit.
- Correct derived word counts without overwriting source fields.
- Add deterministic experiment schemas and hashes.
- Add unit tests for retention interpolation and geometry formulas.

Exit criterion: every input and exclusion is visible and reproducible.

### Phase 1: Retention geometry atlas, Weeks 1-2

- Resample curves in all coordinate systems.
- Generate point, slope, curvature, flattening, persistence, replay, hazard,
  AUC, spectral, PCA, and change-point families.
- Register formulas and parameter grids.
- Build outcome × outcome and outcome × confound matrices.
- Run synthetic curve tests with known geometry.

Exit criterion: every intuitive curve claim can be selected as an explicit,
tested measurement rather than prose.

### Phase 2: Component lattice, Weeks 2-4

- Generate token, n-gram, window, prefix, suffix, clause, timestamp, and
  change-point spans.
- Build content-addressed span embedding cache.
- Generate deletion/context/prefix-transition representations.
- Build containment and relational graph.
- Validate span timing and coverage.

Exit criterion: every part of every hook can be inspected at several
resolutions with its context preserved.

### Phase 3: Unlabeled structure, Weeks 4-5

- Fit cluster/manifold families without outcomes.
- Quantify stability and nuisance concentration.
- Build parent/child cluster mappings across resolutions.
- Populate component × component and component × context matrices.

Exit criterion: stable numeric component families exist without semantic or
performance labels.

### Phase 4: Idea isolation, Weeks 5-6

- Build and compare every candidate idea anchor.
- Implement subtraction, orthogonalization, residualization, matching, and
  shared-factor methods.
- Quantify idea leakage and nuisance predictability.

Exit criterion: the system reports how much result variance depends on the
idea-removal assumption.

### Phase 5: Broad registered sweep, Weeks 6-8

- Generate tens of thousands of association and low-capacity predictive tests.
- Use grouped nested validation.
- Persist results incrementally and resume safely.
- Run global and within-cluster null families.
- Create promotion rules without reading the final holdout.

Exit criterion: the broad matrix is complete, reproducible, and false-positive
calibrated.

### Phase 6: Context and attention interactions, Weeks 8-10

- Test component × context effects.
- Test order, deletion, and prefix transitions.
- Fit low-rank interaction and graph-based models.
- Compare isolated versus contextual component efficacy.

Exit criterion: the study can distinguish a component that works only after
setup from a universally useful component.

### Phase 7: Same-idea differences, Weeks 10-12

- Build strict matching and common-support diagnostics.
- Run pairwise difference models.
- Build the combinatorial compatibility map.
- Identify where the current corpus cannot answer the transformation question.

Exit criterion: observational evidence for promise amplification is separated
from topic association.

### Phase 8: Confirmation and productization, Weeks 12-16

- Run hierarchical and max-statistic corrections on promoted families.
- Perform influence, source, era, duration, and cut-method sensitivity.
- Freeze any surviving candidate axes.
- Add scoring only for candidates that meet the emergence standard.
- Design the controlled creative validation dataset and randomized test plan.

Exit criterion: either a defensible candidate construct is produced with its
limits, or the program precisely states what additional data is required.

## 21. Immediate Build Order

Implementation begins with the portions that reduce the largest current risk:

1. Preserve the v1 report as a baseline and stop describing its best axis as a
   discovered RTG construct.
2. Generate a machine-readable research registry from this specification.
3. Build the corpus integrity report and fix derived-count usage.
4. Build a parameterized retention geometry atlas with synthetic tests.
5. Build the inexpensive matrix engine and execute the first large sweep over
   existing full-hook embeddings.
6. Add component spans and their content-addressed embeddings.
7. Expand the sweep to component/context/idea representations.
8. Replace the current exemplar-first UI with matrix-first research surfaces.

## 22. What the Previous 816-Experiment Baseline Did and Did Not Establish

The baseline compared four whole-hook/title representations, 17 outcomes,
three adjustment sets, and four linear rotation methods. It correctly showed
that full hook wording contains held-out retention-shape signal. It did not:

- decompose hooks into components,
- model component context or order,
- test multiple idea anchors,
- provide a full retention geometry atlas,
- compare every metric against every other metric,
- run tens of thousands of registered hypotheses,
- calibrate component discovery against comprehensive negative controls,
- establish same-idea transformation evidence, or
- quantify RTG.

It remains useful only as a preliminary whole-hook baseline.

## 23. Definition of Done

This research program is not done because a projection looks coherent. It is
done only when:

- the complete component, context, outcome, and confound matrices exist,
- every result is traceable and out-of-fold,
- the broad search is calibrated against equivalent null searches,
- a candidate construct meets the emergence standard or is honestly rejected,
- same-idea transformations can be compared with known support and
  uncertainty,
- the UI distinguishes observation, candidate mechanism, and causal evidence,
  and
- future data can be appended and reprocessed without changing definitions or
  duplicating logic.

The likely outcome is not one magic phrase score. It may be a small set of
context-conditioned dimensions describing immediate uncertainty, delayed
payoff, sustained stakes, transformation, social consequence, or entirely
different structures that emerge from the data. The system must remain capable
of discovering that the construct is multidimensional or that the current
corpus is insufficient.
