# Promise Lab

Promise Lab asks a discovery question: does the embedded hook corpus contain
stable, context-sensitive semantic units whose transfer across video ideas
predicts stronger outcomes?

It does not begin with a definition of a promise, gratification, component,
slot, phrase family, or boundary. The pipeline enumerates the observable
sequence lattice, measures counterfactual influence in the exact Long Quant
text space, discovers candidate boundaries without outcomes, and keeps every
method and parameter choice in an experiment registry.

The source corpus is the existing `longform/hook-embeds/` collection. All text
vectors use `gemini-embedding-2` at 1536 dimensions, matching Long Quant.

Stages:

1. `run_interventions.py`: exhaustive span and token-pair counterfactuals.
2. `run_discovery.py`: boundary ensembles, nulls, and component candidates.
3. `run_atlas.py`: clustering sweeps over boundary-supported candidates.
4. `run_all_spans.py`: exact, resumable materialization of every contiguous span.
5. `run_all_span_atlas.py`: twelve primitive, contrast, residual, and joint
   multiview sweeps over the complete span lattice, with no semantic labels.
6. `run_cross_scope.py`: candidate-versus-exhaustive family persistence,
   consensus agreement, and post-fit boundary-enrichment audits.
7. `run_swaps.py`: evidence-supported sources routed into the complete target
   span universe using equal-scope outcome-blind atlas consensus.
8. `run_axes.py`: held-out directions for model-predicted transfer plus observed
   views, keep rate, retention levels, windows, slopes, and hook-end hold.
9. `run_manual_probe.py`: a separated post-hoc comparison of manual selections
   against already-retained map and cluster IDs; it creates no new maps.
10. `run_manual_projection.py`: reconstruct the winning map's exact four
   clustering coordinates, freeze its labels, and compare three 2D viewing planes.
11. `run_canonical_partitions.py`: one outcome-blind, variable-count, contiguous
   exact cover per hook; the four frozen categories are assigned only after
   source-held-out boundary selection and may repeat or be absent.
12. `run_hook_quality.py`: nested held-out retention-information direction,
   source bootstraps, full-context component deletions, O(n²) local pair
   interactions, domain checks, and latency falsification.
13. `run_forward_response.py`: nested forward-only lag selection, text-free
   natural-drop adjustment, conditional category-specific component diagnostics,
   exact-statistic source inference, and chronological lag-selection validation.
14. `run_hook_outcomes.py`: grouped out-of-fold whole-hook and category-specific
   component predictions for viewed percentage, five-second retention, average
   retention, and log views; a nested endpoint-normalized, duration-neutral hook
   terminal-conditioned survival diagnostic, normalization sensitivity,
   chronological validation, and observed plus normalized 41-position forecasts
   bounded by each source's analyzed hook endpoint.
15. `run_hook_examples.py`: deterministic evaluation of the supplied example
   problem, kept entirely out of training and model selection.
16. `build_ui.py`: browser artifacts, cluster representatives, findings, the
   complete experiment registry, and the interactive Hook scorer.

The deterministic diagnostic architecture is documented in
[`HOOK_SCORER.md`](HOOK_SCORER.md). Corrected claim boundaries and remaining
limitations are recorded in [`METHODOLOGY_AUDIT.md`](METHODOLOGY_AUDIT.md).

`verify_all_span_store.py`, `verify_swap_outputs.py`, and
`verify_axis_outputs.py` are hard gates in the orchestrated build. The manual
projection also has `verify_manual_projection.py`, which checks the frozen-label
hash, all coordinate shapes and finiteness, basis orthonormality, and the declared
winner. `verify_forward_response.py` checks exact-statistic grouped inference,
future-only lag selection, reverse-time controls, timing windows, every component
and pair, and rejected aggregate audits. `verify_hook_outcomes.py` checks all 208
source-held-out predictions, 324 components, 175 relationships, curve shape,
timing coverage, replay-envelope geometry, normalization and temporal sensitivity,
uncertainty arrays, and improvement over the text-free baselines. Together these
gates check exact character slices, complete variable-cover and local-deletion identity, vector finiteness and
normalization, crossed-design completeness, per-source artifacts, zero-error
self-span controls, one predeclared-confound selection per target, and exact
agreement among the axis registry, maps, out-of-fold rows, and direction tensors.

Every expensive stage is resumable. The exhaustive span store preallocates
float16 primitive matrices and processes one hook at a time, so API volume does
not become resident application memory. Swap scoring deduplicates the complete
crossed surface by exact recomposed text, embeds each unique string once, and
scatters the result back to every matching source-by-target cell. Generated
data lives in `.cache/`; browser-facing artifacts are mirrored to
`longform/promise-lab-v4/` in R2. Large binary intermediates are local unless
`--upload-intermediates` is explicitly requested.

The pipeline is invoked on demand and has no resident GPU or always-on model
worker. Its defaults use eight concurrent Gemini requests, the API's 100-text
batch size, and resumable 8,192-text scoring checkpoints; environment variables
can lower those values when an account has tighter request quotas. Successful
requests inside an interrupted checkpoint remain in the exact-text cache and
are reused on restart; a completed pass clears that transient cache.

`verify_embedding_parity.py` compares a local full-hook tensor with the pooled
48-coordinate preview stored by the existing Long Quant scorer. Tests use
planted numerical structure and do not contain phrases from the user's
examples.

## Manual overfit probe

`manual-reference-probe.json` is a deliberately post-hoc interpretation layer.
`run_manual_probe.py` aligns the dictated phrases to observed contiguous spans,
then compares all already-retained maps and clusters using equal-hook-weighted KL
information contribution. It creates no embeddings, clusters, maps, or outcome
axes. The output is `.cache/manual-probe.json` and is published separately as
`manual-probe.json.gz`, so the discovery artifacts remain unchanged. Its winning
map does supply the conditional four-label overlay used by later category-specific
diagnostics; those labels are therefore disclosed as post-hoc conditioned.

`manual-projection.json.gz` contains the current PCA plane, an orthonormalized
Fisher plane, and an orthonormal max-min plane for the same frozen `k=4` labels.
The max-min search optimizes the weakest of all six pairwise standardized
cluster separations. It is a post-hoc visualization experiment: it never refits
k-means, changes membership, or enters scientific discovery evidence. The
artifact also carries its frozen labels and exact span IDs so the dedicated
Saved embedding tab can render independently of the full 82 MB atlas. Compact
span text, source-hook, and offset arrays keep point inspection inline as well,
so clicking the graph neither changes views nor fetches the full atlas.
