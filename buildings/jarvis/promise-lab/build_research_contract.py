#!/usr/bin/env python3
"""Compile the frozen RTG specification into an evidence-backed implementation ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path

from atlas import REPRESENTATION_VERSION
from embedding_store import R2_PREFIX, R2Store


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
CONTRACT = HERE / "REFERENCE_TO_GRATIFICATION_RESEARCH_PROGRAM.md"
OUTPUT = CACHE / "research-contract.json"


STATUS = {
    "1": ("active", "The mission remains an observational candidate-discovery goal; no causal RTG construct has been promoted."),
    "2": ("partial", "The rules are enforced by artifact contracts, but complete cell-level traceability and all registered null families are not yet universal."),
    "2.1": ("implemented", "UI and models use candidate relationship, diagnostic, or training reward language rather than declaring RTG truth."),
    "2.2": ("implemented", "Exact hook text and untouched 1,536D source vectors remain the primary channel; derived vectors are separate."),
    "2.3": ("implemented", "Clusters retain numeric IDs and exemplars; labels are explicitly post-hoc inspection only."),
    "2.4": ("partial", "Title, hook-relative, deletion, orthogonal title-anchor, and no-anchor views exist; the full ten-anchor matrix does not."),
    "2.5": ("implemented", "Every span carries isolation, context, whole-hook, deletion, prefix, suffix, and interaction traces."),
    "2.6": ("partial", "Many retention families and learned curve channels exist, but the full registered outcome family matrix is incomplete."),
    "2.7": ("implemented", "All observational and inference surfaces state that causal transformation requires new controlled data."),
    "2.8": ("partial", "Core artifacts are hashed and OOF folds are exposed; some older matrix rows do not yet resolve every provenance field."),
    "3": ("implemented", "The corpus audit preserves 211 indexed records, 208 measured hooks, explicit exclusions, recomputed token counts, source counts, and current title-corpus drift."),
    "4": ("implemented", "The formal hook/span/context/outcome object is represented directly in corpus, lattice, and scorer payloads."),
    "5": ("implemented", "One shared builder now materializes and visualizes the lattice for every stored hook and typed prediction."),
    "5.1": ("implemented", "All ten source-preserving resolution families are enumerated; empty, punctuation-only, and stop-word-only candidates remain auditable."),
    "5.2": ("implemented", "Every non-empty span exposes all listed representation families, hashes, relations, and twelve labeled frozen plotting planes."),
    "5.3": ("implemented", "Containment, sequence, semantic, context, title, and fold-safe outcome edges are built and visualized from the same graph contract."),
    "5.4": ("partial", "Deletion, additive, pair interaction, order, and compatibility diagnostics exist; exhaustive component-cluster by context-cluster tests remain pending."),
    "6": ("partial", "The all-span atlas covers 56,552 spans, twelve representations, and 300 retained maps; not every requested clustering family is implemented."),
    "6.1": ("partial", "K-means, PCA, spherical/whitened geometries, and multiple residual views exist; agglomerative, spectral graph, density, and co-clustering families remain."),
    "6.2": ("partial", "Seed stability, nuisance concentration, cross-hook generality, and bootstrap diagnostics exist; complete split-half and cross-resolution lineage do not."),
    "6.3": ("implemented", "Numeric IDs, maps, members, medoids/exemplars, outcome colors, and confound explanations are inspectable without semantic ground-truth names."),
    "7": ("partial", "Published-title, full-hook, hook-relative, orthogonal-title, and no-anchor views exist; the exhaustive anchor-by-removal matrix is not complete."),
    "8": ("partial", "A broad retention/deconfounding atlas exists, but not every dense parameter cell specified in Sections 8.1 through 8.7 has been materialized."),
    "8.1": ("partial", "Absolute, duration-relative, hook-relative, component-relative, entry-indexed, terminal-conditioned, replay-corrected, and rank views exist; coverage is not yet exhaustive."),
    "8.2": ("partial", "Fixed-time, hook-end, response-end, carry, and component-boundary holds exist; every crossing threshold and dense ratio grid does not."),
    "8.3": ("implemented", "Raw, entry-indexed, replay sensitivity, endpoint sensitivity, expected, residual, robust, and lagged slopes are registered and visualized."),
    "8.4": ("partial", "Derivative, flattening, and change-point diagnostics exist, but the full smoothing-bandwidth grid is not complete."),
    "8.5": ("implemented", "Start excess, terminal relation, replay correction, entry indexing, sensitivity curves, and leakage audits are published."),
    "8.6": ("partial", "Hook Hold, carry, AUC, and short-horizon persistence exist; the complete start/end payoff-horizon grid is pending."),
    "8.7": ("partial", "PCA/curve and derivative representations exist; full DCT, wavelet, and joint multi-channel families remain."),
    "9": ("implemented", "Keep rate, retention, views, log views, and Long Quant diagnostics remain visible and are not called RTG truth."),
    "10": ("partial", "The deconfounding audit covers timing, entry, replay, terminal retention, duration, source, and quality channels; some semantic/exposure variables are unavailable."),
    "10.1": ("implemented", "Hook duration, actual token count, speech rate, source, component timing/position, and video duration are available."),
    "10.2": ("implemented", "Start level, early drop, replay area, keep/swipe rate, terminal retention, and correction sensitivity are available."),
    "10.3": ("partial", "Title/hook embeddings and cluster/topic diagnostics exist; visual-opening and broad channel-history controls are incomplete."),
    "10.4": ("partial", "Published date, views, age/outlier proxies, and creator identity exist; recommendation-distribution history is unavailable."),
    "10.5": ("implemented", "Transcript source, cut method, mismatch, alignment/timing provenance, and exclusions are visible."),
    "11": ("partial", "Unadjusted, delivery, entry/replay, combined, and residualized specifications exist; sensitivity bounds and all propensity variants remain."),
    "12": ("partial", "Large outcome/representation/cluster/axis registries exist, but the complete tensor product of all seven matrix families is not finished."),
    "13": ("partial", "Correlation, ridge, PCA, residualization, clustering, low-rank and nearest-neighbor families exist; splines, forests, CCA/PLS, and graph models are incomplete."),
    "14": ("partial", "A deterministic 816-spec audit and large experiment registry are persisted; several new lattice cells still need registry-row expansion."),
    "15": ("partial", "Grouped/source-held-out, random-fold, chronological, bootstrap, permutation, and family inference exist, but no untouched final confirmation set exists."),
    "15.1": ("partial", "Source-held-out and chronological diagnostics exist; creator/era/duration leave-group-outs are not exhaustive."),
    "15.2": ("implemented", "Promoted linear axes use inner selection and outer predictions; scorer displays validation scope."),
    "15.3": ("partial", "Bootstrap bands and prediction intervals exist; cluster-membership and matched-pair uncertainty are incomplete."),
    "15.4": ("partial", "BH/FDR, permutation, and family-level inference exist for core families; the full hierarchical search tree is incomplete."),
    "16": ("partial", "Token/order permutations, reversed-lag checks, outcome-free boundaries, and normalization falsifications exist; synthetic grammar-preserving nulls and all placebo families remain."),
    "17": ("blocked-data", "The current corpus has sparse same-idea overlap and no randomized creative variants; causal transformation claims cannot be completed from it."),
    "17.1": ("partial", "Nearest-idea and cross-scope diagnostics exist, but strict common-support matching is insufficient for broad claims."),
    "17.2": ("partial", "Pair deletion, swaps, and compatibility diagnostics exist; exhaustive cluster-pair insertion with independent scoring is unfinished."),
    "17.3": ("blocked-data", "Controlled same-video variants, randomized assignment, and subsequent audience outcomes have not been collected."),
    "18": ("not-met", "No candidate currently satisfies all twelve promotion requirements; the UI must not call the present scores RTG."),
    "19": ("partial", "The console now adds lattice, graph, contract, provenance, and exact scorer parity; matched-pair and final promotion dashboards remain partial."),
    "20": ("active", "The implementation program is tracked phase by phase; observational engineering cannot substitute for future data collection."),
    "phase-0": ("implemented", "Specification, baseline, integrity, deterministic schemas, hashes, and synthetic/unit tests exist."),
    "phase-1": ("partial", "Core geometry and deconfounding families exist; the full dense atlas remains."),
    "phase-2": ("implemented", "All span resolutions, representation traces, graph edges, timing validation, cache references, UI, and scorer parity exist."),
    "phase-3": ("partial", "Large unlabeled atlas and nuisance/stability diagnostics exist; all manifold families and lineage maps do not."),
    "phase-4": ("partial", "Several idea views exist; the complete ten-anchor experiment matrix does not."),
    "phase-5": ("partial", "Thousands of persisted configurations exist; comprehensive null-calibrated tensor coverage and final holdout remain."),
    "phase-6": ("partial", "Context deletions, interactions, order and graph structure exist; exhaustive graph/context modeling remains."),
    "phase-7": ("blocked-data", "The corpus lacks enough strict same-idea support for the requested transformation evidence."),
    "phase-8": ("blocked-data", "Confirmation requires a frozen candidate plus controlled creative variants and audience outcomes."),
    "21": ("partial", "Immediate build items 1 through 6 and matrix-first UI are materially implemented; matrix/idea expansion remains."),
    "22": ("implemented", "The 816-experiment report is preserved and explicitly presented as a preliminary whole-hook baseline."),
    "23": ("not-met", "The complete matrices, comprehensive null calibration, emergence standard, same-idea support, and controlled causal evidence are not all present."),
}


def heading_key(title: str) -> str:
    phase = re.match(r"Phase\s+(\d+):", title, re.I)
    if phase:
        return f"phase-{phase.group(1)}"
    numbered = re.match(r"(\d+(?:\.\d+)?)\.?(?:\s|$)", title)
    return numbered.group(1) if numbered else title.lower().replace(" ", "-")


def headings(lines: list[str]) -> list[dict]:
    found = []
    for index, line in enumerate(lines, 1):
        match = re.match(r"^(#{2,4})\s+(.+?)\s*$", line)
        if not match:
            continue
        title = match.group(2)
        found.append({
            "key": heading_key(title), "level": len(match.group(1)),
            "title": title, "lineStart": index,
        })
    for index, row in enumerate(found):
        row["lineEnd"] = (found[index + 1]["lineStart"] - 1 if index + 1 < len(found) else len(lines))
    return found


def evidence_for(key: str) -> list[str]:
    if key.startswith("5") or key == "phase-2":
        return ["component-lattice.json", "component-lattice/<videoId>.json.gz", "component-lattice-model.json"]
    if key.startswith("8") or key.startswith("10") or key in {"11", "phase-1"}:
        return ["hook-outcomes.json", "hook-outcome-model.json", "latency-study.json", "cluster-outcomes.json"]
    if key.startswith("6") or key == "phase-3":
        return ["all-span-atlas.json", "atlas.json", "manual-projection.json", "cross-scope.json"]
    if key.startswith("15") or key.startswith("16"):
        return ["hook-quality.json", "hook-outcomes.json", "market-reward.json", "registry.json"]
    if key.startswith("17") or key in {"18", "23", "phase-7", "phase-8"}:
        return ["research-contract.json", "hook-outcomes.json", "cross-scope.json"]
    return ["manifest.json", "registry.json"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    raw = CONTRACT.read_bytes()
    lines = raw.decode("utf-8").splitlines()
    rows = []
    for row in headings(lines):
        status, statement = STATUS.get(row["key"], ("contract-only", "No automated implementation claim is registered for this heading."))
        rows.append({**row, "status": status, "statement": statement,
                     "evidenceArtifacts": evidence_for(row["key"])})
    missing = sorted(row["key"] for row in rows if row["key"] not in STATUS)
    if missing:
        raise RuntimeError(f"research contract headings have no explicit status: {missing}")

    corpus = json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))
    lattice = json.loads((CACHE / "component-lattice.json").read_text(encoding="utf-8"))
    lattice_model = json.loads(
        (CACHE / "component-lattice-model.json").read_text(encoding="utf-8")
    )
    title_map = json.loads((CACHE / "raw-long-text" / "map.json").read_text(encoding="utf-8"))
    if (int(lattice.get("hookCount") or 0) != len(corpus.get("rows") or [])
            or not (lattice.get("parityContract") or {}).get("shared")
            or (lattice.get("graphContract") or {}).get("structuralEdgeOutcomesUsed") is not False
            or lattice_model.get("allSpanRepresentationVersion") != REPRESENTATION_VERSION):
        raise RuntimeError("Section 5 cannot be marked implemented without corpus-wide shared-lattice evidence")
    counts = Counter(row["status"] for row in rows)
    artifact = {
        "version": 1, "status": "complete", "stage": "frozen research-contract audit",
        "contract": {
            "path": "buildings/jarvis/promise-lab/REFERENCE_TO_GRATIFICATION_RESEARCH_PROGRAM.md",
            "sha256": hashlib.sha256(raw).hexdigest(), "lines": len(lines),
            "frozen": True,
        },
        "implementationStatusCounts": dict(counts),
        "currentInventory": {
            "measuredHooks": len(corpus.get("rows") or []),
            "componentLatticeHooks": lattice.get("hookCount"),
            "componentSpanNodes": lattice.get("spanCount"),
            "componentGraphEdges": lattice.get("edgeCount"),
            "currentLongQuantTitleVectors": len(title_map.get("title") or []),
            "contractInitialLongQuantTitleVectors": 42599,
            "titleCorpusDriftVisible": len(title_map.get("title") or []) != 42599,
        },
        "section5Audit": {
            "status": "implemented",
            "storedHooks": lattice.get("hookCount"),
            "storedSpans": lattice.get("spanCount"),
            "storedGraphEdges": lattice.get("edgeCount"),
            "registeredRepresentationPlanes": len(lattice.get("mapDefinitions") or {}),
            "sharedCorpusAndPredictorBuilder": (lattice.get("parityContract") or {}).get("shared"),
            "representationVersion": REPRESENTATION_VERSION,
            "structuralEdgesUseOutcomes": (
                lattice.get("graphContract") or {}
            ).get("structuralEdgeOutcomesUsed"),
            "claimBoundary": (
                "The exhaustive lattice is engineering-complete. Only the outcome-blind exact "
                "cover is scored; the broader research program remains scientifically incomplete."
            ),
        },
        "rows": rows,
        "definitionOfDone": {
            "met": False,
            "reason": STATUS["23"][1],
            "languageRule": "Current scores are candidate relationships, diagnostics, or frozen training rewards; none is a causal RTG score.",
        },
        "blockedDataRequirements": [
            "multiple produced hooks for the same underlying idea with adequate common support",
            "controlled variants attached to the same finished video",
            "randomized audience assignment and measured retention outcomes",
            "an untouched confirmation set frozen before candidate promotion",
        ],
        "claimBoundary": (
            "Engineering completeness is reported separately from scientific emergence. "
            "A complete lattice does not complete the causal RTG research program."
        ),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(json.dumps(artifact, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, OUTPUT)
    if not args.no_upload:
        R2Store().put_json(f"{R2_PREFIX}/research-contract.json.gz", artifact, gzip_payload=True)
    print(json.dumps({
        "contractHash": artifact["contract"]["sha256"], "headings": len(rows),
        "statuses": artifact["implementationStatusCounts"],
        "definitionOfDone": artifact["definitionOfDone"]["met"],
    }, indent=2))


if __name__ == "__main__":
    main()
