# Discovery Contract

## What is unknown

The existence, number, location, meaning, and performance value of semantic
components are unknown. "Promise" and "reference to gratification" are names
for the research target, not labels available to the algorithms.

## What may enter discovery

- Exact hook text already stored by Long Quant.
- Mechanical token and character offsets.
- `gemini-embedding-2` vectors in the same 1536-dimensional text space used by
  Long Quant.
- Counterfactual vectors produced by deleting every possible contiguous span
  and every possible token pair.
- Sequence order.

## What may not enter discovery

- Example phrases, connector lists, linguistic templates, or manually chosen
  clause boundaries.
- Outcome values, retention geometry, views, keep rate, or Long Quant scores.
- A preferred prefix, suffix, terminal slot, or assumed number of components.
- A semantic name assigned before held-out evidence exists.

## Exhaustive primitive

For a hook with `n` observed tokens, the lattice contains all `n(n+1)/2`
contiguous spans and all `n(n-1)/2` token pairs. No span length or position is
preferred. A tokenization is a mechanical surface representation, and its
exact regex and output are stored with each hook.

For full hook embedding `E(H)`:

- span influence: `D(S) = E(H) - E(H without S)`
- token interaction: `I(i,j) = E(H) - E(H-i) - E(H-j) + E(H-{i,j})`
- span non-additivity: `A(S) = D(S) - sum(D(token) for token in S)`

These are observable counterfactual geometries. They are not called attention,
promise, or gratification unless later validation supports that interpretation.

## How numerical choices are handled

No computational method is choice-free. Promise Lab therefore registers and
sweeps choices instead of hiding them. Segment counts are enumerated from one
through `n`. Boundary methods, projection dimensions, cluster counts,
algorithms, seeds, nulls, and confound sets are stored per experiment. The UI
shows sensitivity and Pareto fronts rather than promoting one hand-picked run.
The exhaustive atlas also registers algebraic contrasts and categorical
fixed-effect residuals. Those transforms are defined without language labels.
Token length and relative position are measured as leakage diagnostics; they
may be projected out as nuisances but never enter as positive cluster features.

## Discovery before outcomes

Boundary and component discovery are outcome-blind. The boundary-supported
candidate atlas and complete contiguous-span atlas are both retained, and
cross-scope persistence is measured without outcomes. Outcomes are joined only
after candidate structures and held-out folds have been frozen. Null-calibrated
evidence, bootstrap stability, cross-method persistence, and held-out transfer
must all be visible.

A provisional single partition is selected only for downstream sensitivity
analysis. It maximizes null-standardized fit minus the universal description
length `sqrt(2 log(C(n-1,k-1)))`, where `C(n-1,k-1)` is the exact count of
possible contiguous `k`-segment partitions. A search-wide permutation test
calibrates the final selection. If one segment wins, the recorded result is
"no separable component evidence"; the system does not force a phrase.

## Swaps

Swaps may begin only after both outcome-blind atlases are frozen. Exploratory
source spans come from the boundary sensitivity partition. Target locations
come from every contiguous span and are selected by equal-scope,
quality-weighted co-association across the candidate and exhaustive atlases,
with influence cosine used only as a deterministic tie-breaker. Incompatible
swaps remain in the data. Every
source is crossed with every target hook. Source, target, and
source-by-context effects are reported separately, and each detail row stores
the target baseline, recomposed percentile, and signed delta.

## Claims

Counterfactual Long Quant scores are model predictions, not observed human
behavior. Measured YouTube outcomes and model-scored recompositions are shown
as separate evidence channels. No "promise axis" is declared unless it
generalizes on held-out videos, survives confound residualization, beats a
search-wide null, and transfers across target contexts.
