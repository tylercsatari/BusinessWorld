# Predictive Abstraction Lab

This folder builds the compact artifact used by the top-level Jarvis
**Principles** tab.

The lab does not assign a universal "principleness" score. It treats
abstraction depth as a multi-objective evidence problem:

- distinguishability,
- metric similarity,
- persistence under perturbation,
- prediction on data that could not select the abstraction,
- source and mechanism diversity,
- transformation survival, and
- description complexity.

Candidates are promoted only as far as their weakest failed or untested gate
allows. Pareto fronts are computed only within like-for-like visual-operation
candidates. Projected outcomes, retrospective folds, external diagnostics, and
strict-blind observed outcomes remain separate evidence types.

Build the snapshot with:

```bash
node buildings/jarvis/principles-lab/build-artifact.js
```

The builder records source hashes and quarantines older exploratory artifacts
instead of silently mixing them into the current evidence hierarchy.
