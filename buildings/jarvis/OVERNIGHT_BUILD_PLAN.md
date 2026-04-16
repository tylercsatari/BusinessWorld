# Jarvis — Overnight Build Plan

**Date:** 2026-04-15 → 2026-04-16 (overnight)
**Stance:** drive Jarvis materially forward against the meta-architecture in `JARVIS_META_ARCHITECTURE.md`. Do not claim the dream system is finished. Do produce concrete, inspectable artifacts at every layer that today is empty or stubbed.

This plan is sequential and operational. The orchestrator (`overnight_orchestrator.js`) reads `overnight_task_queue.json` and runs phases one at a time, writing live status to `overnight_status.json`. **A phase only starts after the previous phase's stop condition is met.** A phase failure halts the orchestrator with a recorded reason; the parent agent can resume by re-running the orchestrator (each phase is idempotent).

---

## State at start of run

What exists:
- Outcome metric: `views` (log10), wired through `jarvis-runner.js`.
- Post-upload indicators: hundreds, in `indicators.json` + `derived_experiments.json`.
- Pre-upload indicators: phrase-density / structural / frame-presence families in `jarvis-metrics.js` (Zygarnik, stakes, proof, urgency, callbacks, etc.).
- Resolution registry: `resolutions.json` with `r0` (global) plus video-window shelves.
- Deterministic discovery loop: `jarvis-runner.autoRun()` consumes `candidate_queue.json` (38k+ remaining), runs Pearson r against `views`, writes nodes/edges into `graph.json`.
- Video corpus on disk: ~2,473 dirs in `video_data/` (the "pen" + analyzed lab samples), each with `analysis.json` (transcript, AI segments, frame-level analyses, retention curve, daily views).
- R2 sync via `jarvis-store.js`.

What is empty / stubbed today (and what this overnight run will fill):
- **Mechanism layer**: no node type, no catalog. Today every "mechanism-shaped" thing lives as a flat phrase-density indicator. The architecture (§5) says mechanisms are the *moves* — distinct from indicators.
- **Component layer**: no emergent recurring sub-parts (§6). Empty.
- **Principle layer**: no candidate hypotheses attached to edges (§7). Empty.
- **Question registry / research_questions.json**: 97 lines, mostly placeholder.
- **indicator-registry.json / signals-dataset.json / experiments_log_compact.json**: all 0-byte.
- **Bridge validation**: no explicit pre→post→views chain check (§11 cond. 2–4 are unmeasured).

---

## Constraints (read before editing)

- **Sequential only.** Orchestrator advances to phase N+1 only after phase N writes `status: "completed"`.
- **Idempotent phases.** Each phase script can be re-run; it overwrites its own artifacts and never mutates files outside its declared output set.
- **No premature taxonomy.** Mechanism / component / principle catalogs are written as **observed shapes**, not as hand-chosen ontologies. We collect broadly (§10) and keep messy descriptions (§9). Categorization is left to later passes.
- **No destructive actions.** Phases never delete `indicators.json`, `graph.json`, `derived_experiments.json`, `candidate_queue.json`, or any historical run record. They write *new* artifacts beside them.
- **Outcome metric is sacred.** `views` (log10) is unchanged.
- **R2 sync is opt-in per phase**, not automatic, so a partial run cannot poison the cloud copy.

---

## Phase 1 — Architecture, contracts, registries

**Goal.** Lay the schema down for the layers the meta-architecture promises but the codebase does not yet have. Make the registries exist on disk so later phases write into known shapes.

**Inputs.**
- `JARVIS_META_ARCHITECTURE.md` (definition of layers).
- Existing `resolutions.json`, `indicator-registry.json` (currently empty), `research_questions.json`, `tools.json`.

**Outputs (new files, all under `buildings/jarvis/`):**
- `mechanisms.json` — `{ version, generated_at, mechanisms: [], schema: {...} }`
- `components.json` — `{ version, generated_at, components: [], schema: {...} }`
- `principles.json` — `{ version, generated_at, principles: [], schema: {...} }`
- `mechanism_observations.json` — per-video mechanism evidence (initialized empty).
- `bridge_validation.json` — initialized empty.
- `research_questions.json` — overwritten with a structured registry of open questions, one per layer × resolution × outcome edge gap.
- `indicator-registry.json` — backfilled from `indicators.json` + `derived_experiments.json` (was 0 bytes).

**Verification.**
- All seven files exist, parse as JSON, contain the expected top-level keys.
- `indicator-registry.json` has > 100 entries (it should pull every existing indicator key).

**Stop condition / gate before Phase 2.**
- Status writes `phase: 1, status: "completed"`, with byte-counts and key-counts of every output.
- If any write fails, orchestrator halts with `phase_1_failed` and records the file path + error.

**Risks.**
- Overwriting a non-empty `research_questions.json` could lose hand-curated questions. Mitigation: phase 1 reads the existing file, preserves unrecognized entries under a `legacy:` prefix, and only adds the new structured set.

---

## Phase 2 — Mechanism extraction over the existing video pool

**Goal.** Per the architecture (§5), mechanisms are *moves a creator did*, recorded in rough natural language, observed not invented. This phase walks every video in `video_data/` and extracts candidate mechanism observations from the signals already on disk: AI segment labels (Hook / Setup / Climax / Payoff / etc.), transcript phrase hits (the family detectors in `jarvis-metrics.js`), and frame-level engagement notes.

A *mechanism observation* is a triple `(video_id, mechanism_id, evidence)` where `mechanism_id` is a stable rough-language identifier like `open_with_curiosity_gap_first_5s` or `proof_signal_before_midpoint`, and `evidence` carries the matched phrase / segment / frame, plus position in the video (so resolution is preserved).

**Inputs.**
- All `video_data/*/analysis.json` (~2,473 videos).
- Phrase-set detectors in `jarvis-metrics.js` (Zygarnik, stakes, proof, urgency, callbacks, etc.).
- AI `segments` array per video (label + start/end + transcript).
- Frame `engagementAnalysis` strings (where present).

**Outputs.**
- `mechanism_observations.json` — array of observations: `{video_id, mechanism_id, position_pct, position_s, evidence_kind, evidence_text, source}`.
- `mechanisms.json` (rewritten) — for every distinct `mechanism_id`: `{id, label, rough_description, source_kinds, n_observations, n_videos, sample_evidence: [...up to 3], emergence_method}`.
- `mechanism_indicator_links.json` — for every (mechanism, indicator) pair where mechanism observation count vs indicator value across videos shows a non-zero rank correlation, write `{mechanism_id, indicator_key, rho, n}`. This is the seed of the mechanism→indicator graph (§12).

**Verification.**
- `mechanism_observations.json` has at least one observation per video for >70% of videos in the pool.
- `mechanisms.json` has between 30 and 500 mechanism IDs (anything outside that range is a sign the extraction is too coarse or too fine — phase logs the bracket and continues but flags it for review in `overnight_status.json`).
- `mechanism_indicator_links.json` is non-empty.

**Stop condition / gate before Phase 3.**
- Status writes counts: `n_videos_processed`, `n_observations`, `n_mechanism_ids`, `n_links`.

**Risks.**
- Over-categorization: it is tempting to invent a tidy taxonomy. The script must derive `mechanism_id` mechanically from the evidence kind + position bucket + phrase family — not from a hand-curated list of "the right mechanisms". Premature components are explicitly forbidden (§9).
- Wall time: 2,473 videos × ~6 segments × phrase scan is small; expect single-digit minutes.
- Memory: write streamingly, do not hold every observation in RAM if it grows past a few hundred MB.

---

## Phase 3 — Component emergence (recurring sub-parts of mechanisms)

**Goal.** Per §6, components are not declared up front. They are lifted out of the mechanism catalog after repeated observation. This phase scans the mechanisms produced in Phase 2 for shared sub-fragments — same phrase-family, same position bucket, same evidence kind — that recur across multiple distinct mechanism IDs, and lifts those into named components.

**Inputs.**
- `mechanisms.json` (from Phase 2).
- `mechanism_observations.json`.

**Outputs.**
- `components.json` — `{ id, label, fragment_kind, fragment_value, n_mechanisms_using, n_observations_total, mechanism_ids: [...] }`.
- `mechanism_components.json` — many-to-many map: `{ mechanism_id: [component_ids...] }`.

**Verification.**
- Every component is referenced by ≥ 2 distinct mechanism IDs (definition of "recurring").
- No component is hand-coded — each must trace back to a fragment that appeared in Phase 2 evidence.

**Stop condition / gate before Phase 4.**
- Status writes `n_components`, `n_mechanisms_decomposed`, `coverage_pct` (fraction of mechanisms that decompose into ≥1 component).

**Risks.**
- Over-lifting: if every fragment is a component, the layer adds no compression. The script enforces a minimum-recurrence threshold (default ≥3 mechanisms) before a fragment is lifted.

---

## Phase 4 — Principle candidate surfacing

**Goal.** Per §7, principles are causal hypotheses on edges in the graph. They are emergent, plural, and refinable. This phase surfaces *candidate* principles (not confirmed ones) for the strongest mechanism→indicator and indicator→outcome edges already observed.

A candidate principle is a textual hypothesis of the form:

> *Mechanism M tends to move indicator I in direction D because [rough explanation], and indicator I is correlated with the outcome at strength r=X.*

Phase 4 generates these mechanically from the data, not from creative writing — the explanation slot is filled by a templated rationale derived from the mechanism's evidence kind, position, and the indicator's family.

**Inputs.**
- `mechanism_indicator_links.json` (from Phase 2).
- `indicators.json` + `derived_experiments.json` (existing) for indicator → views correlations.
- `graph.json` for existing edge structure.

**Outputs.**
- `principles.json` — `{ id, edge: {from_mechanism, via_indicator, to_outcome}, hypothesis_text, supporting_n, mechanism_indicator_rho, indicator_outcome_r, status: "candidate", generated_at }`.
- `principle_gaps.json` — edges in the graph that have no candidate principle attached. This is the §12 "gaps as to-do list".

**Verification.**
- For every mechanism with ≥10 observations and a |rho| ≥ 0.05 link to any indicator, at least one candidate principle exists.
- Every principle's `hypothesis_text` is unique modulo the mechanism + indicator pair.

**Stop condition / gate before Phase 5.**
- Status writes `n_principles`, `n_unique_mechanisms_in_principles`, `n_gaps`.

**Risks.**
- False confidence: principles are *candidates*. The schema includes `status: "candidate"` and the orchestrator never promotes them. Promotion requires an explicit human pass.

---

## Phase 5 — Pre → post → views bridge validation

**Goal.** §11 distinguishes correlation from optimization-worthiness. A pre-upload mechanism is only useful if (a) it correlates with a post-upload indicator and (b) that post-upload indicator correlates with views. This phase walks the bridge for every candidate principle from Phase 4 and records whether the chain holds end-to-end on the existing pool, with first-10s and swipe-away targets called out explicitly because those are the publication-time leading indicators.

**Inputs.**
- `principles.json` (Phase 4).
- `indicators.json`, `derived_experiments.json`, `graph.json`.
- The 2,473 videos' retention curves and daily-view shapes.

**Outputs.**
- `bridge_validation.json` — for each principle:
  - `mechanism_id`, `via_indicator`, `to_outcome`
  - `pre_to_post_rho` (mechanism observation count vs the post-upload indicator across videos)
  - `post_to_views_r` (existing indicator correlation with views)
  - `chain_strength = sign-aware product of the two, ranked`
  - `first_10s_signal_strength` (correlation of mechanism count with `retention_pct_10`)
  - `swipe_away_signal_strength` (correlation with `swipe_away_rate`)
- `bridge_top_principles.json` — the top 25 principles by `chain_strength`, ranked, for inspection in the UI.

**Verification.**
- Every principle in `principles.json` has a row in `bridge_validation.json`.
- The top-25 list is non-empty.
- Sanity: at least one principle in the top 25 should already have a known-strong indicator on its right side (e.g., `hook_retention_pct`, `swipe_away_rate`, `final_5pct_retention`); if not, log a warning — likely a data-loading bug.

**Stop condition / gate before Phase 6.**
- Status writes `n_principles_validated`, `n_chains_with_both_legs_nonzero`, `top_chain_strength`.

**Risks.**
- Confounding: chain strength is observational, not causal. The output is for ranking what to look at, not for declaring a fact.
- The 100M+ "lab" pool is *not* fully on local disk — only ~2,473 videos are. Validation runs on the available pool; the artifact records `n_videos_used` so future runs against a larger pull are comparable.

---

## Phase 6 — Persist into Jarvis surfaces

**Goal.** Make every Phase 1–5 output inspectable by the existing UI without inventing new categorization. Per §14, views reflect the graph; if a view needs a category, the right move is to extend the graph, not hardcode it.

**Inputs.**
- All Phase 1–5 outputs.

**Outputs.**
- `findings-summary.json` — replaced/augmented with an overnight section: counts, top-25 principles, top mechanisms by support, biggest bridge gaps.
- `overnight_report.md` — human-readable summary of what changed overnight, ready for Tyler to skim in the morning.
- `graph.json` — *additively* extended with mechanism nodes and mechanism→indicator edges (using the existing node/edge schema; `type: "mechanism"` and `kind: "mechanism_to_indicator"`). No existing nodes or edges are removed.
- `overnight_status.json` — final state with `phase: 6, status: "completed"`, `finished_at`, totals.

**Verification.**
- `graph.json` parses and the existing UI loads it without crashing (a syntax check via `node -e "JSON.parse(...)"` is enough; full UI validation is out of overnight scope).
- `overnight_report.md` exists, is non-empty, and references each phase's artifact.

**Stop condition.**
- Orchestrator writes `overall_status: "completed"` and exits 0.

**Risks.**
- Adding nodes/edges to `graph.json` could push it over a size threshold for the UI loader. Mitigation: phase 6 logs the byte delta; if growth is > 25%, it writes the mechanism extension to `graph_mechanisms.json` instead of merging in-place, leaving the parent agent to merge in the morning.

---

## Realistic overnight priorities

In order of priority. If the orchestrator runs out of time, this is the order in which value is preserved:

1. **Phase 1 (must finish).** Without registries the rest has nowhere to write.
2. **Phase 2 (must finish).** Mechanisms are the highest-leverage missing layer.
3. **Phase 3 (should finish).** Components without mechanisms are useless; mechanisms without components are still useful.
4. **Phase 4 (should finish).** Principles are textual; cheap once 2 + 3 exist.
5. **Phase 5 (nice-to-have).** Bridge validation depends on Phase 4 but is the most likely to surface surprises.
6. **Phase 6 (cleanup).** Pure persistence — fast, but only valuable if 1–5 produced something to persist.

The orchestrator does not parallelize phases. It does not skip ahead. If Phase 2 fails, Phase 3 does not start.

---

## What this overnight run is **not**

- Not a claim that Jarvis now has a finished mechanism / component / principle catalog. It has a *first observed pass*, recorded with the architectural commitment (§9) that early vocabulary is rough and will be re-described.
- Not a re-run of the deterministic indicator pipeline (`jarvis-runner.autoRun`). That continues on its own cadence; this overnight run sits *on top of* its outputs.
- Not a destructive migration. Existing files are appended to or written beside, never deleted.
- Not a substitute for the human review pass. Every "candidate" tag in every output is honest — the system surfaces, the human refines.

---

## How to monitor

- `overnight_status.json` — live, updated after every phase transition and during long phases at least every 60s.
- `overnight_orchestrator.log` — text log of stdout + stderr of every phase script, in one file, append-only.
- `tail -F buildings/jarvis/overnight_orchestrator.log` is sufficient for real-time monitoring.
- The parent agent can poll `overnight_status.json` with `cat` to get current phase + counts without waking the orchestrator.

---

## How to resume after a failure

Each phase script is idempotent. To resume:

```sh
node buildings/jarvis/overnight_orchestrator.js --start-from phase_2
```

The orchestrator reads `overnight_task_queue.json`, finds the named phase, and runs from there. Status file is preserved with a `resumed_from` annotation.
