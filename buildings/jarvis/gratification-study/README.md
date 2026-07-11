# Reference to Gratification Research Program

This directory contains an open-ended construct-discovery program. Reference
to gratification (RTG) is **not** a labeled phrase, title, hook, retention
metric, or embedding direction. The research question is whether a stable,
context-dependent promise-amplification construct can be discovered from the
existing Shorts hooks embedded in Long Quant's title space.

Read [`RESEARCH_PROGRAM.md`](./RESEARCH_PROGRAM.md) before changing the study.
It is the source-of-truth research contract and includes the component lattice,
retention geometry atlas, confound rules, relationship matrices, falsification
tests, emergence standard, and multi-month implementation plan.

## Data

- 211 Shorts are indexed; 208 currently have complete hooks and curves.
- Exact full hooks and titles use 1,536-dimensional `gemini-embedding-2`
  vectors.
- The latest fixed external basis is fit across 42,599 Long Quant title vectors
  and automatically rebuilds when that corpus version changes.
- Word-level timelines cover the opening delivery and anchor every component.
- The deterministic lattice currently contains 23,837 token, window, prefix,
  suffix, delivery-segment, and timestamp components.

Components are always stored with their deleted context. Numeric cluster IDs
and exemplars are inspection surfaces, not semantic RTG labels.

## Pipelines

`build_study.py` is the preliminary v1 whole-hook baseline. It compares four
whole-hook/title representations against 17 outcomes and must not be described
as having quantified RTG.

`build_research_v2.py` builds the registered research system:

- corpus and alignment audit,
- 603-branch retention geometry atlas,
- 23,837-component context-preserving lattice,
- content-addressed component/context embeddings,
- outcome-blind multi-resolution component clustering,
- 12 explicit adjustment regimes,
- grouped out-of-fold experiment sweep,
- complete outcome/confound relationship matrices,
- same-idea matched-difference experiments with semantic groups held out,
- idea x component compatibility/support matrices,
- FDR and selection-repeating null calibration,
- full experiment registry and component manifest.

Run the full research build:

```bash
/Users/tylercsatari/miniforge3/bin/python3 \
  buildings/jarvis/gratification-study/build_research_v2.py \
  --workers 4 --batch-size 40 --null-iterations 9
```

Run tests:

```bash
cd buildings/jarvis/gratification-study
/Users/tylercsatari/miniforge3/bin/python3 -m unittest \
  test_rtg_clusters.py \
  test_rtg_components.py \
  test_rtg_embeddings.py \
  test_rtg_experiments.py \
  test_rtg_geometry.py \
  test_rtg_pairs.py \
  test_rtg_visualizations.py
```

## V2 Artifacts

Local cache:

- `.cache/research_v2.json`
- `.cache/experiments_v2.jsonl.gz`
- `.cache/components_v2.json.gz`
- `.cache/matrices_v2.npz`
- `.cache/relationship_matrices_v2.json.gz`
- `.cache/visualizations_v2.json.gz`
- `.cache/component_embeddings_v2.sqlite3`
- `.cache/component_embeddings_v2.npz`
- `.cache/progress_v2.json`

R2:

- `longform/gratification/v2/report.json`
- `longform/gratification/v2/experiments.jsonl.gz`
- `longform/gratification/v2/components.json.gz`
- `longform/gratification/v2/matrices.npz`
- `longform/gratification/v2/relationship_matrices.json.gz`
- `longform/gratification/v2/visualizations.json.gz`
- `longform/gratification/v2/component_embeddings.npz`
- `longform/gratification/v2/progress.json`

The embedding cache is keyed by a SHA-256 hash of normalized exact text. The
SQLite cache commits after each batch and the final NPZ is published only after
every requested text is present.

## Evidence Language

The UI and reports use these levels:

1. **Measurement**: an explicit curve, component, confound, or relationship.
2. **Candidate relationship**: held-out association that has not passed every
   emergence gate.
3. **Promoted candidate construct**: replicated across geometry, resolution,
   idea isolation, adjustments, grouped folds, and selection-repeating nulls.
4. **Causal transformation evidence**: validated through same-idea controlled
   creative tests.

Nothing is called an RTG score before levels 3 and 4 are satisfied.

Rebuild the lazy embedding-map and complete-results artifact from the existing
matrices and experiment registry without rerunning the research sweep:

```bash
/Users/tylercsatari/miniforge3/bin/python3 \
  buildings/jarvis/gratification-study/refresh_visualizations_v2.py
```
