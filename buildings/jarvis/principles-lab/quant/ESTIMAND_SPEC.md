# Creator-Relative Pre-Upload Lift: Estimand and Validation Specification

Status: research specification, not a performance claim  
Audit time: 2026-07-26T17:02:29Z  
Scope: canonical Shorts and Long public databases, raw embedding archives, raw map artifacts, their producers, and their R2 serving paths

This document starts from the bytes and producer code that exist today. It does
not accept any existing Principles, Predictor, Operations, or Promise summary as
ground truth.

The central conclusion is:

> The current corpus can support an out-of-fold estimate of **creator-relative,
> age-adjusted performance among query-selected videos**. It cannot identify
> causal content lift, a YouTube-wide hit probability, fixed-horizon views, or
> the effect of changing one package while holding the underlying video fixed.

The distinction is not semantic. It determines which labels, folds, and claims
are valid.

## 1. Canonical Sources Audited

The application accesses Cloudflare R2 through the S3-compatible client in
`cloud-storage.js`. The canonical objects are downloaded with `GetObject` and
are overwritten in place by their producers.

### 1.1 Frozen bytes used for this audit

These are content hashes of the exact bytes downloaded for this audit. R2 is
live and mutable, so counts below are properties of these hashes, not promises
about the next request.

| Object | Bytes | SHA-256 |
|---|---:|---|
| `library/db.json` | 47,202,005 | `cd59f7ee04c29b2989f58dad39a4fa5f18f9d25413dd156788f585ad7817cf14` |
| `longform/db.json` | 68,873,820 | `b6cd5530c621eb640dd7db80c39f029815b82d8e71b24990c86f60b675999ed0` |
| `raw/visual/map.json` | 15,364,906 | `c42d6525c3553e3a02683f285f3b5bfc33b2f2db4d5c336b05f1f71cbf877a12` |
| `raw/text/map.json` | 6,465,704 | `7c01ff360e493edc8d0dc4afa3530fd3a674da8720fdfde0924bc7959b42c13e` |
| `raw/together/map.json` | 15,478,968 | `0baef73330cfccfe3dc3c51ff514364aa307ef5bf1eabe8add26aed3fc689c8f` |
| `raw-long/visual/map.json` | 11,639,808 | `113e9039c49f2f0ef34aee29d655025d03178363f822048ad3c5296f02006c1f` |
| `raw-long/text/map.json` | 24,545,986 | `ce47e99cc887c067d151836f7391812031fa2d8ccf0ca2e42b6f657cc128dd64` |
| `raw-long/together/map.json` | 24,543,201 | `35ce146ee4d0ebbd19a7873c1dcb9fb0c930d3e0b5b274113bda1bd13c444ad7` |

The corresponding raw vector archives exist at:

| Object | Observed size |
|---|---:|
| `raw/visual/embeddings.npz` | 381,500,031 bytes |
| `raw/text/embeddings.npz` | 133,625,306 bytes |
| `raw/together/embeddings.npz` | 381,445,624 bytes |
| `raw-long/visual/embeddings.npz` | 240,169,045 bytes |
| `raw-long/text/embeddings.npz` | 240,234,761 bytes |
| `raw-long/together/embeddings.npz` | 240,471,836 bytes |

### 1.2 R2 consistency finding

There is no transactional snapshot across these objects.

During this audit:

- `raw-long/text/map.json` changed from a 24,545,986-byte steered map to an
  11,773,445-byte base map.
- `raw-long/visual/map.json` changed from 11,639,808 to 11,769,505 bytes.
- Shorts text and together map ETags also changed.
- Base map generation and steered-projection injection are separate writes.
- Each modality archive and map is checkpointed independently.

The HTTP routes `/api/raw/map` and `/api/raw-long/map` add another layer: each
map is held in a five-minute in-memory gzip cache, and a stale cached copy may
continue to be served after an R2 source error.

Therefore a research run MUST:

1. Download directly from R2, not from the UI route.
2. Record byte length, SHA-256, ETag, and `LastModified` for every object.
3. Read all required objects twice.
4. Accept the snapshot only if every ETag is unchanged across both reads.
5. Copy accepted bytes to immutable, content-addressed experiment keys.
6. Write one manifest that binds all object hashes to one run ID.

No model may mix a database from one generation with a map or vector archive
from another without explicitly declaring that as a new join.

## 2. Exact Database Schemas

Both databases have the top-level shape:

```json
{
  "videos": {
    "<youtube-video-id>": { "...": "record" }
  },
  "updated": 1785084505029
}
```

`updated` is the time the entire database object was last saved. It is **not**
the time every record's views were observed.

### 2.1 Shorts: `library/db.json`

Frozen snapshot:

- 81,762 discovered rows
- 65,661 currently stored, non-removed vertical Shorts
- 33,272 distinct `channelId` values among those stored rows
- discovery rule in `library-crawler.js`: query/search surfaced, at least 10,000
  views at discovery, YouTube "this year" filter, then vertical and at most 185
  seconds during acquisition
- raw embedding eligibility is stricter: vertical and at most 180 seconds

| Field | Non-null in all 81,762 rows | Definition from producer |
|---|---:|---|
| `videoId` | 81,762 | YouTube video ID |
| `title` | 81,762 | Title at most recent metadata write |
| `channel` | 81,762 | Human-readable channel title |
| `views` | 81,762 | Public current view count at that record's last metadata write |
| `publishedAt` | 81,753 | Relative discovery string such as `"10 months ago"` |
| `duration` | 81,762 | Discovery display duration such as `"0:42"` |
| `stored` | 81,762 | Whether the video asset is currently marked stored |
| `addedAt` | 81,762 | Discovery time, milliseconds |
| `sizeBytes` | 65,684 | Stored MP4 byte size; includes rows later removed |
| `r2Key` | 65,684 | Stored MP4 object key |
| `storedAt` | 65,684 | Storage completion time, milliseconds |
| `channelId` | 66,145 | Stable YouTube channel ID from `yt-dlp` |
| `channelUrl` | 66,145 | Channel URL |
| `subs` | 65,290 | Channel followers at that record's metadata pull |
| `uploadDate` | 66,145 | `YYYYMMDD` string |
| `timestamp` | 64,354 | Publication Unix time, seconds |
| `likes` | 59,828 | Public likes at metadata pull |
| `comments` | 60,693 | Public comments at metadata pull |
| `durationSec` | 66,145 | Duration in seconds |
| `width` / `height` | 66,145 each | Video dimensions |
| `url` | 66,145 | Watch URL |
| `outlier` | 64,948 | Rounded `views / current subscribers` |
| `rechecked` | 10,285 | Metadata was rewritten by a later recheck |
| `nonVertical` | 2,808 | Rejected geometry flag |
| `removed` | 23 | Stored asset was later removed |
| `skip` | 2,798 | Do not retry |
| `failed` | 15,489 | Failure counter |
| `lastError` | 15,489 | Last acquisition error |

Among the 65,661 usable stored Shorts:

- exact `channelId`: 65,661
- exact `timestamp`: 63,921
- positive `subs`: 64,814
- `likes`: 59,382
- `comments`: 60,249
- `outlier`: 64,472
- five rows are now below the 10,000-view discovery floor

For 64,465 of 64,472 recomputable rows, `outlier` exactly equals
`round((views / subs), 1)`. It is not a historical channel baseline.

### 2.2 Long: `longform/db.json`

Frozen snapshot:

- 104,649 discovered rows
- 100,006 currently stored horizontal videos
- 44,970 distinct `channelId` values among stored rows
- discovery rule in `longform-crawler.js`: query/search surfaced, at least 1,000
  views at discovery, YouTube "this year" filter, then horizontal geometry

| Field | Non-null in all 104,649 rows | Definition from producer |
|---|---:|---|
| `videoId` | 104,649 | YouTube video ID |
| `title` | 104,649 | Title at most recent metadata write |
| `channel` | 104,649 | Human-readable channel title |
| `views` | 104,649 | Public current view count at that record's last metadata write |
| `publishedAt` | 103,697 | Relative discovery string |
| `duration` | 104,276 | Discovery display duration |
| `stored` | 104,649 | Thumbnail is marked stored |
| `addedAt` | 104,649 | Discovery time, milliseconds |
| `channelId` / `channelUrl` | 100,007 each | Stable channel identity and URL |
| `subs` | 96,270 | Channel followers at metadata pull |
| `uploadDate` | 100,007 | `YYYYMMDD` |
| `timestamp` | 99,894 | Publication Unix time |
| `likes` | 98,635 | Public likes at metadata pull |
| `comments` | 95,320 | Public comments at metadata pull |
| `durationSec` | 99,684 | Duration in seconds |
| `width` / `height` | 100,007 each | Video dimensions |
| `url` | 100,007 | Watch URL |
| `outlier` | 96,270 | Rounded `views / current subscribers` |
| `thumbBytes` | 100,006 | Stored thumbnail bytes |
| `thumbRes` | 100,006 | Thumbnail source resolution |
| `thumbKey` | 100,006 | R2 thumbnail key |
| `storedAt` | 100,006 | Storage completion time, milliseconds |
| `rechecked` | 6,272 | Metadata was later rewritten |
| `nonHorizontal` / `skip` | 4,319 each | Rejected geometry / no retry |
| `failed` / `lastError` | 3,497 each | Acquisition failure state |

Among the 100,006 usable stored Long rows:

- exact `channelId`: 100,006
- exact `timestamp`: 99,893
- positive `subs`: 96,269
- `likes`: 98,634
- `comments`: 95,319
- `outlier`: 96,269
- four rows are now below the 1,000-view discovery floor

For 96,262 of 96,269 recomputable rows, `outlier` exactly equals
`round((views / subs), 1)`.

### 2.3 What the timestamps actually mean

The producer calls `yt-dlp -J`, writes current metadata into the row, stores the
asset, and then sets `storedAt`. For a row that has never been rechecked,
`storedAt` is a useful proxy for `viewsObservedAt`.

Observed discovery-to-storage lag:

| Format | Median | p90 | Maximum |
|---|---:|---:|---:|
| Shorts | 0.026 hours | 0.138 hours | 1.152 hours |
| Long | 0.216 hours | 11.049 hours | 18.274 hours |

The metadata pull occurs near the end of that interval, immediately before the
asset fetch, so `storedAt` is conservative but usable at daily horizons.

For `rechecked=true`, current fields may have been overwritten later and there
is no `recheckedAt`. Those rows do not have an identifiable observation time
and are excluded from the primary estimand.

It is invalid to assign `db.updated` as the observation time of every video.
The current `principles-lab/quant/core.js` does exactly that and also includes
non-stored discovered rows. Its cached unified panel must not be used for the
estimands in this document.

## 3. Exact Raw Embedding and Map Schemas

### 3.1 Raw vectors

The vector archives are compressed NPZ files written by `raw_embed.py` and
`raw_embed_long.py`.

Shorts arrays:

```text
ids, vecs, views, outlier, subs, title, txt, mine, silent
```

Long arrays:

```text
ids, vecs, views, outlier, subs, title, txt, mine, owner
```

`vecs` contains 1,536-dimensional `float32` Gemini embeddings. The code uses
the slug `gemini-embedding-2` with `outputDimensionality=1536`.

The archives do not contain:

- per-row embedding time
- immutable embedding-model revision
- input hash
- vector schema version
- metadata observation time
- the R2 database hash from which row metadata was copied

The `views`, `subs`, and `outlier` arrays are copied once when a row is embedded
and are not refreshed on archive resume. They are stale labels, not canonical
outcomes.

Shorts inputs:

- `visual`: one 5-wide montage made from one frame per second in the first five
  seconds
- `text`: Whisper-tiny transcript of the first five seconds, only when the
  confidence and English coherence gate passes
- `together`: montage and accepted transcript in one multimodal request
- silent Shorts: `together` is re-embedded image-only

Long inputs:

- `visual`: stored thumbnail
- `text`: title
- `together`: thumbnail plus title

### 3.2 Map fields

Every base map contains:

```text
n, channel, updated, proj, heldout_auc10m, heldout_rviews,
views, outlier, subs, id, title, txt, mine, silent,
clusters, nmine, nsilent
```

Long maps additionally contain `owner`. Steered Long maps may contain
`ctr*`, `ret30*`, `realviews*`, `ctrviews*`, and `rawviews` projections.

Important truncation:

- map `title` is truncated to 60 characters
- map `txt` is truncated to 200 characters
- projection coordinates are integer-quantized to `[0,1000]` after clipping at
  the full sample's first and 99th percentiles

Base `proj` fields:

| Key | Construction |
|---|---|
| `pca` | PCA of all normalized vectors |
| `umap` | UMAP of all normalized vectors |
| `views` | two-component PLS fitted to log views on a random 70% row split |
| `outlier` | two-component PLS fitted to log outlier on a random 70% row split |
| `both` | PLS fitted jointly to log views and log outlier |
| `hi10m` | LDA fitted to current `views > 10M` on a random 70% row split |
| `hiout` | LDA fitted to the current top 15% of outlier |

`clusters["6"|"10"|"16"|"24"]` are MiniBatchKMeans labels fitted on all
normalized vectors. They are not out-of-fold and they are not content families.

`heldout_auc10m` and `heldout_rviews` use one deterministic random row split.
The split is not chronological, channel-grouped, or content-family-grouped.
They do not estimate creator-relative deployment performance.

The map projections are visualization artifacts. The supervised maps are
outcome-derived and MUST NOT be used as model inputs in a validation claiming
pre-upload performance.

### 3.3 Frozen map coverage

| Format | Modality | Map rows | DB overlap | Map-only owned | Stored DB coverage |
|---|---|---:|---:|---:|---:|
| Shorts | visual | 66,157 | 65,535 | 622 | 99.81% |
| Shorts | text | 23,183 | 22,606 | 577 | 34.43% |
| Shorts | together | 66,142 | 65,520 | 622 | 99.79% |
| Long | visual | 41,084 | 41,049 | 35 | 41.05% |
| Long | text | 40,587 | 40,552 | 35 | 40.55% |
| Long | together | 40,587 | 40,552 | 35 | 40.55% |

The map-only rows are owned-account additions. They lack canonical public
database `channelId` in these two databases and are excluded until joined to a
separately frozen owned-account table.

### 3.4 Metadata drift inside maps

Comparing map arrays to the frozen databases by exact video ID:

| Map | DB rows with different views | Map lower than DB | Largest DB/map ratio |
|---|---:|---:|---:|
| Shorts visual | 4,381 | 4,374 | 66.03x |
| Shorts text | 4,329 | 4,324 | 153.56x |
| Shorts together | 10 | 5 | 1.04x |
| Long visual | 1 | 1 | 1.07x |
| Long text | 1 | 1 | 1.07x |
| Long together | 1 | 1 | 1.07x |

This is direct evidence that the modality maps can carry different outcome
generations. Canonical outcomes must be rejoined from the frozen database.
Existing supervised axes cannot be repaired by merely replacing their displayed
view counts; the axes themselves were trained on the stale labels.

## 4. Availability and Leakage Classes

Every field must carry one of these classes:

| Class | Meaning | Fields |
|---|---|---|
| `P0` | known before production | planned title, planned thumbnail, script, intended duration, scheduled publish time |
| `P1` | known after production but before upload | actual thumbnail, actual title, first-five-second montage, transcript, media dimensions |
| `H` | historical and available at decision time | a prior video's outcome only when its observation time is no later than the candidate's publish time |
| `O` | target outcome | views at a recorded observation time |
| `O+` | downstream post-outcome | likes, comments, current subscribers |
| `Q` | derived using outcomes | views/outlier/10M projections, steered estimates, cluster outcome summaries |

Only `P0`, `P1`, and valid `H` fields may enter a pre-upload predictor.

`subs` is not subscribers at upload. It is current subscribers at each video's
metadata pull, varies across records of the same channel, and may have been
affected by the focal video itself. Among channels with at least two stored
records:

- 79.5% of Shorts channels have multiple observed subscriber counts
- 51.1% of Long channels have multiple observed subscriber counts

`subs`, `views/subs`, likes, and comments are prohibited features. They may be
used only as outcomes, sensitivity diagnostics, or explicit leakage controls.

## 5. Sampling and the Target Population

Let \(D_i=1\) mean the crawler included video \(i\).

Inclusion is not random. It depends on:

- one of a manually constructed query set
- YouTube search ranking
- view-sort or date-sort mode
- a "this year" search filter
- at least 10,000 discovered views for Shorts or 1,000 for Long
- successful metadata and asset acquisition
- geometry filters

The database does not store discovery query, result rank, sort mode, retrieval
time for the search result, or inclusion probability.

Therefore neither inverse-probability weighting nor a YouTube-wide base rate is
available. All current-data estimands are conditional on \(D_i=1\):

\[
\mathcal P_{\text{audit}}
=
\{i: D_i=1,\ \text{stored},\ \text{valid geometry},\ \text{quality gates}\}.
\]

The phrase "creator-relative lift" in this document always means relative
performance **inside this selected population** unless a future panel is named.

## 6. Notation

For video \(i\):

- \(f_i\): format, Shorts or Long
- \(c_i\): exact `channelId`
- \(g_i\): outcome-free content-family ID
- \(T_i\): publication Unix time
- \(S_i\): metadata observation time
- \(A_i=(S_i-T_i)/86400\): age in days at observation
- \(V_i(S_i)\): views observed at \(S_i\)
- \(Y_i=\log(1+V_i(S_i))\)
- \(X_i^m\): unit-normalized raw 1,536-D embedding for modality \(m\)
- \(Z_i\): pre-upload opportunity controls
- \(H_i\): channel history genuinely observable before \(T_i\)

The observed data are generated by at least:

\[
Y_i
=
\underbrace{O(c_i,T_i,A_i,\text{platform})}_{\text{opportunity and age}}
+
\underbrace{Q(X_i,\text{execution})}_{\text{content/package association}}
+
\underbrace{U_i}_{\text{unobserved distribution and noise}}.
\]

Impressions are absent, so \(O\) cannot be separated into actual exposure,
recommendation supply, and audience size. It is an opportunity proxy.

## 7. Strict Analysis Universe

### 7.1 Primary row gates

A row is primary-eligible only when:

```text
stored == true
removed != true
rechecked != true
videoId is present
channelId is present
timestamp is finite
storedAt is finite
views > 0
geometry matches format
Shorts: 0 < durationSec <= 180
Long: width > height
0 < storedAt/1000 - timestamp <= 366 days
```

Set:

\[
S_i=\texttt{storedAt}_i/1000.
\]

Rows with only `uploadDate` are interval-censored by up to 24 hours. They are
excluded from the primary result and may enter a declared sensitivity run.

Strict primary support:

| Format | Rows | Channels | Channels with >=5 rows | Median observed age |
|---|---:|---:|---:|---:|
| Shorts | 53,651 | 28,985 | 1,834 | 7.63 days |
| Long | 93,671 | 43,485 | 3,684 | 72.62 days |

### 7.2 Historically observable channel baselines

For a historical target \(i\), valid prior history is:

\[
H_i
=
\{j:
c_j=c_i,\;
T_j<T_i,\;
S_j\le T_i,\;
g_j\ne g_i
\}.
\]

The \(S_j\le T_i\) condition matters. A prior video's 2026 current views were
not available when a 2025 target was uploaded.

Exact strict support with at least one historically observable prior:

| Format | Targets | Channels | Median prior count | Target publish range | Median target age |
|---|---:|---:|---:|---|---:|
| Shorts | 11,175 | 4,469 | 3 | 2026-06-28 to 2026-07-26 | 1.31 days |
| Long | 9,818 | 5,008 | 3 | 2026-07-05 to 2026-07-15 | 1.31 days |

Embedding coverage on these strict targets:

| Format | visual | text | together | all three |
|---|---:|---:|---:|---:|
| Shorts | 11,158 | 3,087 | 11,157 | 3,087 |
| Long | 159 | 152 | 152 | 152 |

Consequences:

- Shorts currently has enough rows for a real rolling-origin visual/together
  experiment.
- Long does not currently have enough embedded, historically observable targets
  for a credible prospective content result.
- A Long result built from the current map must remain exploratory until vector
  coverage catches up and the same protocol is rerun.

## 8. Estimands

Four estimands must be kept separate.

### 8.1 E1: selected-corpus whole-package relative performance

This asks whether a complete package is associated with more views than the
creator's opportunity baseline at the same observed age.

Define an opportunity prediction \(\mu_i^{O}\) using no focal content and no
focal outcome:

\[
R_i^{\text{whole}}
=
Y_i-\mu_i^{O}.
\]

The multiplicative descriptive lift is:

\[
L_i^{\text{whole}}
=
\exp(R_i^{\text{whole}}).
\]

For large \(V\), \(L=2\) means approximately twice the selected-corpus expected
views for that creator/opportunity/age. It does not mean the package caused a
doubling.

The pre-upload content model estimates:

\[
q_f(x)=
\mathbb E[
R_i^{\text{whole}}
\mid X_i=x,\ f_i=f,\ D_i=1
].
\]

This estimand includes topic, idea, hook, thumbnail, title, and execution
differences represented by \(X\).

### 8.2 E2: selected-corpus within-family packaging performance

This asks whether a package performs better than other observed packages from a
similar semantic content family.

Let \(d_{g_i}^{\text{prior}}\) be a shrunk family effect estimated without the
focal outcome and only from observations available before the decision.

\[
R_i^{\text{package}}
=
Y_i-\mu_i^{O}-d_{g_i}^{\text{prior}}.
\]

This removes part of the idea/topic opportunity and is closer to a packaging
estimand. It is still observational because creators do not randomly receive
titles, hooks, and thumbnails within families.

Both E1 and E2 must be reported. They answer different product questions.

### 8.3 E3: within-creator ordering

For valid matched pairs \(i,j\) from the same creator:

\[
C_{ij}
=
\mathbb 1[
(\hat q_i-\hat q_j)(R_i-R_j)>0
].
\]

The pairwise estimand is:

\[
\theta_{\text{pair}}
=
\Pr(C_{ij}=1).
\]

Pairs must be close in log age and observation calendar time, and must not share
a leakage family. This estimand is less dependent on absolute view calibration
and is the strongest current-data answer to "which candidate is better for this
creator?"

### 8.4 E4: current-state threshold classification

For threshold \(v\):

\[
B_i(v)=\mathbb 1[V_i(S_i)\ge v].
\]

A model may estimate:

\[
\Pr(B_i(v)=1\mid A_i,X_i,Z_i,D_i=1).
\]

This is the probability that a selected video has crossed \(v\) by its
particular observed age. It is not:

- eventual probability of crossing \(v\)
- YouTube-wide probability
- probability for an unselected upload

The current `>10M` maps estimate this weaker current-state target with a random
row split. They do not estimate a deployment hit probability.

## 9. Opportunity Adjustment

Opportunity adjustment is fitted separately by format.

### 9.1 Global age/time component

Primary form:

\[
g_f(A_i,S_i,W_i)
=
\beta_{0f}
+
I_f(\log(1+A_i))^\top\beta_{Af}
+
\gamma_{f,\operatorname{obsweek}(S_i)}
+
h_f(\operatorname{dow}(T_i),\operatorname{hour}(T_i)),
\]

where:

- \(I_f\) is a monotone I-spline
- \(\beta_{Af}\ge0\)
- observation-week effects are ridge-shrunk
- publish day/hour terms are cyclic and ridge-shrunk
- all knots, penalties, and effective degrees of freedom are selected inside
  the training fold

The current snapshot cannot cleanly separate video aging from upload-cohort
effects because:

\[
T_i=S_i-A_i.
\]

The collection window is narrow, making age and publication cohort nearly
collinear. Therefore every result must survive three specifications:

1. `AGE`: monotone age + observation week
2. `COHORT`: monotone age + ridge-shrunk publication week
3. `MATCH`: no global extrapolation; nearest-neighbor matching in log age and
   observation date

A content claim fails if its direction changes across these specifications.
No fitted age curve may be described as the true view-growth curve.

### 9.2 Channel shrinkage

First calculate training-only global residuals:

\[
u_j=Y_j-\hat g_f(A_j,S_j,W_j).
\]

For target \(i\), use only \(j\in H_i\). Recency weights are:

\[
w_{ij}(h)
=
\exp\left[-\frac{T_i-S_j}{h}\right],
\]

where \(h\) is selected by inner-fold predictive log likelihood.

Allow age-dependent residual variance \(\sigma_f^2(A_j)\). With
\(b_c\sim N(0,\tau_f^2)\), the empirical-Bayes posterior channel effect is:

\[
\hat b_{c_i,i}
=
\frac{
\sum_{j\in H_i}
w_{ij}u_j/\sigma_f^2(A_j)
}{
\tau_f^{-2}
+
\sum_{j\in H_i}w_{ij}/\sigma_f^2(A_j)
}.
\]

Posterior variance:

\[
\operatorname{Var}(\hat b_{c_i,i})
=
\left[
\tau_f^{-2}
+
\sum_{j\in H_i}w_{ij}/\sigma_f^2(A_j)
\right]^{-1}.
\]

\(\tau_f^2\), the variance curve, and \(h\) are estimated only on training
observations. With no valid prior history, \(\hat b=0\) and uncertainty expands
to the pooled creator variance.

The opportunity prediction is:

\[
\mu_i^{O}
=
\hat g_f(A_i,S_i,W_i)
+
\hat b_{c_i,i}.
\]

Do not use current subscribers in the primary opportunity equation.

### 9.3 Family shrinkage for E2

Using prior observations from the same outcome-free content family:

\[
G_i
=
\{j:g_j=g_i,\ c_j\ne c_i,\ S_j\le T_i\},
\]

estimate \(d_g\sim N(0,\omega_f^2)\) with the same posterior form as channel
shrinkage.

The cross-creator restriction prevents one creator's recurring series from
making "family" another name for channel.

For a novel family, \(d_g=0\) with large posterior uncertainty. The scorer must
display that uncertainty rather than silently treating the pooled mean as
precise.

### 9.4 Standardized residual

For comparisons across ages:

\[
Z_i^{\text{lift}}
=
\frac{
Y_i-\mu_i^O-d_{g_i}
}{
\sqrt{
\sigma_f^2(A_i)
+
\operatorname{Var}(\hat b_{c_i,i})
+
\operatorname{Var}(\hat d_{g_i,i})
}
}.
\]

Report both:

- raw log residual, which has a multiplicative interpretation
- standardized residual, which expresses surprise relative to uncertainty

## 10. Content-Family Grouping

Content-family grouping is a nuisance-control and leakage-control operation. It
is not a semantic truth label.

### 10.1 Inputs

Use full raw vectors from NPZ, not map coordinates.

Primary family representation:

- Shorts voiced: `together`
- Shorts silent: `visual`; do not count image-only `together` as an independent
  second sensor
- Long: `together`

Sensitivity representations:

- visual only
- text only where available
- equal-weight late intersection of visual and text neighborhoods

Never use views, outlier, likes, comments, map projection coordinates, or
existing KMeans labels.

### 10.2 Exact-duplicate layer

Before semantic grouping, create deterministic exact/near-exact blocks from:

1. exact video ID
2. normalized full title
3. normalized full first-five-second transcript for voiced Shorts
4. token 5-gram MinHash
5. perceptual hashes computed from the stored montage or thumbnail

The frozen database contains:

| Input | Duplicate groups | Rows in duplicate groups | Largest group |
|---|---:|---:|---:|
| Shorts normalized stored title | 1,390 | 5,678 | 158 |
| Shorts normalized coherent first-5s text | 414 | 1,516 | 65 |
| Long normalized stored title | 821 | 2,042 | 24 |

These are minimum leakage blocks. Semantic families must go beyond them.

### 10.3 Semantic distance

For normalized vectors:

\[
s_{ij}^{m}=\langle X_i^m,X_j^m\rangle.
\]

When multiple independent modalities are available, define:

\[
d_{ij}
=
\operatorname{median}_{m\in M_{ij}}
(1-s_{ij}^{m}).
\]

For silent Shorts, \(M_{ij}\) contains only visual. `together` and visual are
not independent observations in that branch.

### 10.4 Outcome-free threshold

Construct an empirical null \(F_{0,f,m}\) from deterministic random pairs that:

- are from different exact channels
- are not exact lexical/perceptual duplicates
- are stratified by format and speech availability

For a candidate pair:

\[
p_{ij}
=
1-F_{0,f,m}(s_{ij}).
\]

Create a semantic edge only when its Benjamini-Hochberg adjusted pairwise
\(q\)-value is below the preregistered family FDR.

Run at least three outcome-free FDR levels, for example
\(10^{-4},10^{-3},10^{-2}\). Conclusions must be stable across them. No FDR is
selected based on view performance.

### 10.5 Scalable deterministic search

For each point:

1. Query an ANN index for 64 neighbors.
2. If the last neighbor still passes the edge threshold, double the requested
   neighbors.
3. Continue until the boundary neighbor fails or all candidates are exhausted.
4. On a deterministic 10,000-row sample, compare against exact search.
5. Require at least 99% recall for all threshold-passing edges.

Use deterministic complete-linkage inside candidate connected components. A
family is accepted only if every member remains within the threshold of every
other member. This prevents single-link chaining from merging unrelated topics.

### 10.6 Stability

Rebuild families across:

- each FDR level
- each modality sensitivity
- five deterministic bootstrap resamples

Record pairwise co-assignment probability. A "stable family" requires a
preregistered co-assignment threshold. Results must also be reported with all
unstable rows treated as singletons.

### 10.7 Existing clusters are not family IDs

The current `k=6/10/16/24` KMeans partitions are broad geometry summaries fit
on the full corpus. They may be visualized as exploratory covariates, but they
cannot define leakage groups, semantic content families, or fold identities.

## 11. Predictor Construction

### 11.1 Allowed features

Candidate feature sets:

1. `META`: intended duration, UTC publish day/hour, speech-availability flag
2. `VISUAL`: raw visual vector
3. `TEXT`: raw text vector, with explicit missingness branch
4. `TOGETHER`: raw together vector
5. `LATE`: out-of-fold predictions from `VISUAL` and `TEXT`, combined by a
   train-only ridge

Do not concatenate all three embeddings and call them independent evidence.
`together` is constructed from visual and text inputs and silent Shorts make
`together` nearly identical to visual.

### 11.2 Train-only transformations

Within every training fold:

1. unit-normalize vectors
2. fit any centering, whitening, PCA, PLS, ridge, or nonlinear model
3. select hyperparameters in an inner grouped/time-aware fold
4. transform validation/test rows only after fitting

Saved `proj.views`, `proj.hi10m`, `proj.outlier`, `proj.both`, steered
projections, and map `clusters` are prohibited.

### 11.3 Baseline models

Every candidate is compared against:

- `B0`: age/time only
- `B1`: age/time plus valid channel shrinkage
- `B2`: `B1` plus allowed scalar pre-upload metadata
- `B3`: `B2` plus raw content representation

The research question is the incremental value:

\[
\Delta \mathcal M
=
\mathcal M(B3)-\mathcal M(B2),
\]

not the raw fit of \(B3\).

### 11.4 Initial model class

The first confirmatory model should be regularized and auditable:

\[
\hat R_i
=
\alpha+\theta^\top X_i,
\qquad
\theta
=
\arg\min_\theta
\sum_{i\in train}(R_i-\theta^\top X_i)^2
+\lambda\|\theta\|_2^2.
\]

Use ridge on raw unit vectors, with \(\lambda\) selected in the inner fold.
Nonlinear models may be challenged later, but they must beat this baseline on
the same untouched outer lockbox.

## 12. Fold Structure

One random video split is not acceptable.

### 12.1 Outer Track A: rolling-origin known-creator deployment

This is the primary current-data track.

For cutoff \(C_k\):

- training labels require \(S_i\le C_k\)
- test candidates require \(T_i>C_k\)
- target outcomes may be read only after their recorded \(S_i\)
- channel history for a target uses only \(H_i\)
- transformations and opportunity models are refit from scratch
- no test outcome participates in feature selection

Choose cutoffs from date counts, not outcomes, while satisfying a
power-determined minimum test size. Include an embargo between train observation
time and test publication time.

Two subtracks:

- `A-operational`: a previously seen family may contribute only genuinely prior
  family history
- `A-family-OOD`: purge every training row whose family appears in test

### 12.2 Outer Track B: unseen-creator portability

Assign exact `channelId` values to deterministic hash folds. For fold \(k\):

- all focal creator rows are excluded from content-model fitting
- any training row in a test content family is purged for the OOD subtrack
- time ordering still requires training labels to have been observed before the
  test cutoff

Two reports:

- `B-zero-shot`: no outcome from the test creator enters prediction
- `B-known-history`: the global content model has never seen the creator, but
  the opportunity baseline may use that creator's valid \(H_i\), which is
  available at deployment

### 12.3 Outer Track C: content-family OOD

Hold entire stable families out. A creator may appear on both sides only when
the held-out family is absent from that creator's training rows.

This tests whether the score transfers beyond memorizing topic/template
families.

### 12.4 Weak retrospective track

A larger exploratory track may use all non-rechecked rows and cross-fitted
channel effects even when historical outcomes were not available at the target
upload date.

It must be labeled:

> retrospective selected-corpus association; not a historical deployment
> backtest

It cannot promote a model by itself.

### 12.5 Inner folds

All feature selection and hyperparameter tuning occur inside the outer training
set using:

- chronological validation blocks
- channel grouping for portability candidates
- content-family grouping

No outer test result may choose:

- modality
- age curve
- family threshold
- cluster count
- regularization
- score orientation
- operating threshold

## 13. Null Experiments

Every confirmatory run executes all nulls.

| Null | Construction | What it detects |
|---|---|---|
| `N1 within-channel` | Permute residual labels inside creator and coarse log-age strata | content signal that is actually creator/age |
| `N2 family-block` | Permute outcomes at whole-family level | duplicate/template leakage |
| `N3 time-block` | Circularly shift outcome blocks across publication weeks | platform/cohort leakage |
| `N4 wrong-video` | Pair each input with another video from the same creator and nearby observation age | channel identity masquerading as content |
| `N5 random-vector` | Replace vectors with seeded Gaussian vectors of equal dimension | high-dimensional search optimism |
| `N6 orthogonal-axis` | Compare selected axis against equal-complexity random orthogonal axes | axis-mining bias |
| `N7 leakage positive control` | Add likes/comments/current subscribers in a quarantined run | verifies that the harness can detect forbidden leakage |
| `N8 duplicate purge` | Remove exact and semantic train/test family overlap | memorization dependence |
| `N9 speech missingness` | Evaluate voiced and silent Shorts separately | fusion score driven by the voice gate |
| `N10 metadata generation` | Refit after replacing map labels with frozen DB labels | stale-map target dependence |

Permutation distributions are generated inside each outer fold. P-values across
model families and targets are corrected with Benjamini-Hochberg FDR.

## 14. Metrics and Uncertainty

### 14.1 Continuous lift

Report:

- out-of-fold \(R^2\)
- incremental \(\Delta R^2\) over `B2`
- Spearman and Kendall rank correlation
- mean absolute log error
- calibration intercept and slope
- pairwise concordance

\[
R^2
=
1-
\frac{\sum_i(R_i-\hat R_i)^2}
{\sum_i(R_i-\bar R_{train(i)})^2}.
\]

The denominator uses the appropriate training-fold mean, never the global test
mean for deployment calibration.

### 14.2 Threshold decisions

For a threshold defined from the training residual distribution, report:

- PR-AUC and ROC-AUC
- precision and recall at preregistered action rates
- lift over the fold base rate
- Brier score
- reliability curve

Raw accuracy is not useful for rare hits.

### 14.3 Economic decision metric

If execution cost is \(C\), payoff for success is \(G\), and predicted success
probability is \(p_i\):

\[
\operatorname{EV}_i=p_iG-(1-p_i)C.
\]

The operating rule is chosen on training/validation data and then frozen. Test
utility is reported with the cost/payoff assumptions shown explicitly.

### 14.4 Confidence intervals

Use a two-way block bootstrap:

1. resample creators
2. within selected creators, resample content families

Do not bootstrap individual videos as independent rows.

Report:

- 95% confidence intervals
- fold-level values
- source-size strata
- age strata
- voiced/silent strata for Shorts
- creator concentration of gains

## 15. Power and Failure Criteria

### 15.1 Power

For a target detectable correlation \(\rho_\star\), approximate minimum
independent sample size with Fisher's transform:

\[
n_{\min}
=
3+
\frac{(z_{1-\alpha/2}+z_{1-\beta})^2}
{\operatorname{atanh}(\rho_\star)^2}.
\]

At \(\alpha=0.05\), power \(0.8\), and \(\rho_\star=0.05\), this is about 3,140
independent observations before design-effect inflation. The effective sample
is lower than row count because videos share creators and families.

The run must calculate its cluster design effect and either meet the powered
sample or label the result underpowered.

### 15.2 Hard data failures

A confirmatory run is invalid when any of these occur:

- source ETags change during extraction
- database/vector/map ID hashes are not recorded
- duplicate IDs exist within an archive
- vector dimension differs within a modality
- more than 0.1% of vectors are non-finite or zero
- a map coordinate is used in place of a raw vector
- a `rechecked` row enters the primary outcome
- `db.updated` is used as per-row observation time
- current subscribers, likes, or comments enter a pre-upload feature set
- map-stored views are used as canonical outcomes
- Long confirmatory analysis proceeds with the present 152 all-modality strict
  historical targets

### 15.3 Identification failures

The claim must be narrowed or rejected when:

- no strict historically observable channel baseline exists for the target
- age and cohort specifications reverse the content coefficient
- the result exists only in the retrospective weak track
- family identity was selected using outcomes
- fixed-horizon language is used without a fixed-horizon observation
- an eventual hit probability is inferred from current-state threshold data
- YouTube-wide language is used for the query-selected corpus

### 15.4 Statistical promotion failures

A model does not promote when any applies:

1. cluster-bootstrap 95% CI for incremental \(\Delta R^2\) includes zero
2. cluster-bootstrap 95% CI for rank correlation includes zero
3. the sign is positive in fewer than 80% of eligible temporal folds
4. performance does not exceed the 99th percentile of all matched null runs
5. corrected \(q>0.05\)
6. family-OOD performance is non-positive for a portability claim
7. the apparent gain is concentrated in one creator or one family
8. calibration slope is outside `[0.8,1.2]` in two consecutive outer folds
9. an 80% predictive interval covers less than 75% or more than 90% of test rows
10. result orientation or threshold was chosen after viewing the outer test

The 80% temporal-fold criterion is a stability rule, not a substitute for the
confidence interval.

## 16. Claims Identifiable Today

### 16.1 Identifiable, with the stated conditioning

The current data can estimate:

1. schema, coverage, missingness, and metadata drift for a frozen R2 snapshot
2. association between a frozen pre-upload representation and current log views
   conditional on format, observed age, opportunity proxy, and \(D=1\)
3. incremental predictive value over age/time/channel baselines under genuine
   out-of-fold evaluation
4. within-creator ordering on the strict historically observable subset
5. transfer to unseen creators and unseen semantic families, if powered
6. current-state threshold probability at the row's observed age inside the
   selected corpus
7. the degree to which existing random-row map scores collapse under
   time/channel/family folds

### 16.2 Not identifiable

The current data cannot identify:

1. causal lift from changing a hook, title, or thumbnail
2. the counterfactual performance of the same video with another package
3. YouTube-wide probability of reaching 10M, 50M, or any threshold
4. fixed 1-day, 7-day, 30-day, or eventual views
5. a true view-growth curve from one observation per video
6. impressions, recommendation opportunity, or conversion from impression to
   view
7. subscribers at upload
8. unbiased creator baseline performance across all uploads
9. separate causal age and upload-cohort effects from the narrow snapshot
10. public keep rate, swipe ratio, CTR, or retention
11. independent evidence from visual, text, and together embeddings
12. a stable ontology from current KMeans cluster IDs
13. deterministic parity across time because the embedding API revision and
    per-row input hashes are not stored

## 17. Required Research Artifacts

An implementation conforming to this specification writes immutable artifacts,
not UI-only summaries.

### 17.1 Snapshot manifest

```json
{
  "runId": "...",
  "createdAt": "...",
  "sources": [
    {
      "key": "library/db.json",
      "etag": "...",
      "lastModified": "...",
      "bytes": 47202005,
      "sha256": "..."
    }
  ],
  "producerCommits": {
    "libraryCrawler": "...",
    "rawEmbedShorts": "...",
    "longformCrawler": "...",
    "rawEmbedLong": "..."
  }
}
```

### 17.2 Observation panel

One row per `format:videoId`:

```text
video_id
format
channel_id
published_at
observed_at
age_days
views
log_views
rechecked
strict_eligible
history_count
content_family_id
family_stability
modality_mask
input_hash_visual
input_hash_text
input_hash_together
embedding_model_revision
snapshot_run_id
```

Post-outcome fields are stored in a separate namespace so feature construction
cannot accidentally select them.

### 17.3 Fold ledger

For every row and every experiment:

```text
outer_track
outer_fold
inner_fold
train_or_test
decision_cutoff
family_purged
creator_held_out
label_observed_before_cutoff
```

### 17.4 Prediction ledger

For each OOF prediction:

```text
baseline_prediction
channel_effect
family_effect
content_prediction
predicted_log_views
predicted_lift
prediction_interval
actual_log_views
raw_residual
standardized_residual
```

Every displayed number must be reconstructable from this ledger.

## 18. Minimum Acquisition Needed for Stronger Claims

The most valuable next data is not another map projection. It is a longitudinal
outcome panel.

For every monitored video, append rather than overwrite:

```text
videoId
channelId
observedAt
views
likes
comments
channelSubscribers
title
thumbnailHash
```

Collect at fixed post-upload horizons:

```text
1h, 6h, 24h, 72h, 7d, 14d, 30d
```

Also collect:

- complete channel upload lists, including low-view videos
- discovery query/rank for research-corpus rows
- private impressions, CTR, keep rate, and retention where authorized
- title/thumbnail revisions with timestamps
- randomized or platform A/B package assignments
- exact embedding input hashes and immutable model revision

With fixed-horizon outcomes and known inclusion, the target can become:

\[
\log(1+V_i(7d))
-
\mathbb E[
\log(1+V_i(7d))
\mid c_i,\text{prior channel state},\text{calendar}
].
\]

With randomized package variants, a causal estimand becomes identifiable:

\[
\tau
=
\mathbb E[
Y_i(\text{package A})-Y_i(\text{package B})
].
\]

That is the point at which "lift" can be used without the selected-corpus
qualification.

## 19. Implementable Decision

The rigorous path using today's bytes is:

1. Freeze one atomic R2 snapshot.
2. Build the strict non-rechecked panel using `storedAt`, never `db.updated`.
3. Join raw NPZ vectors by exact video ID.
4. Define outcome-free exact and semantic content families.
5. Build age/time opportunity models inside each outer training fold.
6. Build shrunk channel baselines from outcomes genuinely observed before each
   target upload.
7. Estimate E1 and E2 separately.
8. Validate Shorts first with rolling-origin, creator, and family lockboxes.
9. Treat Long as under-covered until the strict historical target vectors are
   present.
10. Run every null and publish failures alongside successes.
11. Output a creator-relative log-lift distribution with uncertainty, not an
    unsupported absolute hit probability.

The strongest defensible current claim is not "we predict virality before
upload." It is:

> For videos surfaced by this crawler, this frozen pre-upload representation
> may contain incremental information about age-adjusted, creator-relative
> current views. The amount and portability of that information must be
> established by the rolling, creator-held-out, family-held-out protocol above.

Anything stronger requires the longitudinal and experimental data listed in
Section 18.
