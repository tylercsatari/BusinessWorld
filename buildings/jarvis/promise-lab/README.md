# Promise Lab

Promise Lab turns spoken openings into one deterministic product contract:

1. partition the exact text into a variable number of non-overlapping components;
2. assign each component to the frozen four-category saved embedding;
3. score the complete text on the frozen external Market Hold direction;
4. explain each component and pair with exact local deletion counterfactuals; and
5. show retention and outcome models as diagnostics, never blended into the headline score.

The source corpus is the existing `longform/hook-embeds/` collection. Text
vectors use `gemini-embedding-2` at 1536 dimensions, matching Long Quant.

## Product Surfaces

- **Hook scorer** scores new text with the frozen serving models.
- **Hook library** audits the same formula on measured source hooks.
- **Saved embedding** preserves the selected four-category map and its outcome
  and latency validation.
- **20s analysis** applies the same variable exact cover, categories, lattice,
  graph, and retention normalization through 20 seconds. Canonical words are
  forced onto deterministic local Wav2Vec2 CTC boundaries from the downloaded
  source media; analytics retention is mapped with actual media duration.

The media clock is a required build input, not a fallback. The current corpus
resolves 133 videos from BusinessWorld media and caches public YouTube audio for
the remaining 75. All 17,315 canonical opening words have deterministic acoustic
intervals. The verifier independently checks source hashes, interval ordering,
the decoded audio/video start origin, actual duration, transcript-clock
agreement, and the claim boundary that CTC times are model estimates rather than
hand-labeled truth. All 4,142 canonical hook words are projected onto those same
opening intervals: 158 hooks are zero-edit normalized prefixes and 50 use the
same deterministic edit-distance projection to an acoustic word endpoint. No
legacy hook endpoint, outcome, semantic label, or anchor interpolation chooses a
timestamp. Estimated within-word boundaries stay visible but are ineligible for
timing-sensitive outcomes unless both outer edges are acoustic boundaries.
Every video also has an independent Whisper-base free-decode audit. Current
median per-video ordered-word start disagreement is 0.100 seconds; the 95th
percentile across per-video p95 disagreements is 0.289 seconds; and median
lexical coverage is 97.59%. These are agreement diagnostics, not hand-labeled
accuracy claims. Final hook endpoints are independently paired with the full
20-second opening as lexical context, which prevents a repeated final word from
matching a later occurrence. Whisper independently pairs 204 of 208 hook
endpoints; median end disagreement is 0.046 seconds and p95 is 0.146 seconds.
The four unpaired endpoints remain visibly unavailable rather than inferred.

The component lattice is embedded inside the scorer and library. It is not a
separate product tab. Results, Hooks, Boundaries, Embeddings, Cluster atlas,
Swaps, Outcome axes, Registry, Research contract, and Claude RTG were legacy
browsing surfaces and are no longer published.

## Shared Score Contract

The scorer and library use the same model artifacts and formulas:

```text
headline       = frozen Market Hold coordinate and percentile
component      = score(full) - score(without component)
relationship   = score(full) - score(without A) - score(without B)
                 + score(without A+B)
```

`Hook Hold`, direct viewed/retention/views forecasts, retention curves,
component-response lag, and 20-second response geometry remain visible
diagnostics. They are not alternate headline scores.

## Build

`build.py` is the single orchestrated rebuild. Its current stages are:

1. `run_interventions.py`
2. `run_discovery.py`
3. `run_atlas.py`
4. `run_all_spans.py` and `verify_all_span_store.py`
5. `run_all_span_atlas.py`
6. `run_manual_probe.py`
7. `run_manual_projection.py` and `verify_manual_projection.py`
8. `build_media_alignment.py`, `audit_media_alignment.py`, and
   `verify_media_alignment.py`
9. `run_cluster_outcomes.py` and `verify_cluster_outcomes.py`
10. `run_latency_study.py` and `verify_latency_study.py`
11. `run_canonical_partitions.py` and `verify_canonical_partitions.py`
12. `run_hook_quality.py` and `verify_hook_quality.py`
13. `run_forward_response.py` and `verify_forward_response.py`
14. `run_long_title_prior.py`
15. `run_hook_outcomes.py` and `verify_hook_outcomes.py`
16. `run_market_reward.py` and `verify_market_reward.py`
17. `run_hook_examples.py` and `verify_hook_examples.py`
18. `verify_product_scorer.py`, a measured-library serving canary
19. `run_component_lattice.py` and `verify_component_lattice.py`
20. `run_opening_horizon.py` and `verify_opening_horizon.py`
21. `build_ui.py`, which validates and publishes only the four current surfaces.

Use `python build.py --no-upload` for a complete local rebuild and validation.
Use `--from-stage` to resume from a named stage. `build_ui.py --no-upload`
validates the current cached product without publishing.

Discovery, atlas, all-span, and outcome/deconfounding code remains internal
because current models consume it. Swap experiments, cross-scope browsing,
generic outcome-axis publication, generated findings/registry artifacts, and
the generated research-contract implementation have been removed.

## Verification

- `verify_market_reward.py` replays every stored Market Hold score, component
  deletion, and pair interaction.
- `verify_component_lattice.py` checks exact live/stored primitive parity,
  complete token ownership, and graph contracts.
- `verify_hook_outcomes.py` checks every held-out source prediction, component,
  relationship, curve, timing window, uncertainty array, and normalization.
- `verify_opening_horizon.py` checks every 20-second detail, observed retention
  horizon, media-aligned word timing, exact cover, graph edge family, and
  fold-safe response candidate.
- `verify_media_alignment.py` checks every current corpus media source, canonical words,
  acoustic interval ordering, hashes, quality bands, and independent
  Whisper free-decode agreement without treating either model as hand-labeled truth.
  It also hard-fails when decoded audio time zero differs from the video/container
  reference clock by more than 30 ms.
- Cluster outcome and latency stages share one content-addressed timing/slope
  matrix. Its key covers source duration, retention curves, hook text, spans,
  retimed words, and the timing algorithms, so reuse removes duplicate work
  without permitting stale measurements.
- `test_visualization_contract.py` enforces the four-surface product, one shared
  scorer/library contract, complete canvas handlers, and absence of legacy APIs.

Generated data lives in `.cache/`; only current browser artifacts and serving
models are mirrored to `longform/promise-lab-v4/` in R2. Expensive stages are
resumable and no resident GPU or always-on worker is required.

## Saved Embedding

`run_manual_probe.py` is a separated post-hoc interpretation layer. It compares
manual selections against already retained maps and creates no embeddings,
clusters, maps, or outcome axes. Its selected map supplies the conditional
four-label overlay used downstream.

`manual-projection.json` contains three 2D views of that same frozen map and a
self-contained point index. Clicking a point never changes views or fetches the
full atlas. The projection does not refit k-means or change membership.

The deterministic scorer architecture is documented in
[`HOOK_SCORER.md`](HOOK_SCORER.md). Corrected claim boundaries are in
[`METHODOLOGY_AUDIT.md`](METHODOLOGY_AUDIT.md), and the Shorts/Long Quant
comparison is in [`QUANT_TRANSFER_AUDIT.md`](QUANT_TRANSFER_AUDIT.md).
