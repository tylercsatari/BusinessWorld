#!/usr/bin/env python3
"""Build a compact, auditable operationalization of projected 85%+ hooks.

The Operations artifact supplies outcome-blind visual descriptions and semantic
embeddings. This worker first discovers stable components without receiving any
keep-rate target, freezes that geometry, and only then measures associations
with the existing projected keep estimates. English labels are selected by
nearest text-embedding geometry from deterministic phrases in the corpus.

Projected keep is a surrogate target. The artifact never presents it as an
observed YouTube swipe ratio or as causal evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import Ridge
from sklearn.mixture import GaussianMixture


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from principles_analysis import (  # noqa: E402
    PrinciplesConfig,
    analyze_component_outcomes,
    discover_components,
    normalize_rows,
)
from principles_transport import (  # noqa: E402
    TransportConfig,
    validate_principle_transport,
)


def _load_operations_module():
    path = HERE / "build_operations.py"
    spec = importlib.util.spec_from_file_location("operations_source", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load the canonical Operations builder")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


OPS = _load_operations_module()
R2 = OPS.R2
EmbeddingStore = OPS.EmbeddingStore

PRODUCT_VERSION = "shorts-hook-principles-v1"
ANALYSIS_VERSION = "operations-principles-85-v2"
R2_PREFIX = OPS.R2_PREFIX
ARTIFACT_KEY = f"{R2_PREFIX}/principles85.json"
LEDGER_KEY = f"{R2_PREFIX}/principles85-ledger.json"
STATUS_KEY = f"{R2_PREFIX}/principles85-status.json"
STAGING_PREFIX = f"{R2_PREFIX}/staging/principles85/"
LOCAL_ARTIFACT = HERE / ".cache" / "principles85.json"
LOCAL_LEDGER = HERE / ".cache" / "principles85-ledger.json"
LOCAL_STATUS = HERE / "principles85-status.json"
SEED = OPS.SEED
THRESHOLD = 85.0
REMOTE_STATUS_ENABLED = True

TOPIC_FAMILIES = ("subjects", "objects", "setting")
RAW_OPERATION_FAMILIES = (
    "full_visual",
    "action",
    "quantity_scale",
    "composition",
    "motion_progression",
    "transformation",
    "stakes_risk",
    "curiosity_gap",
    "novelty_incongruity",
    "proof_result",
    "emotion_reaction",
    "clarity_load",
    "on_screen_text",
)
RESIDUAL_FAMILIES = (
    "action",
    "quantity_scale",
    "motion_progression",
    "transformation",
    "stakes_risk",
    "curiosity_gap",
    "novelty_incongruity",
    "proof_result",
    "emotion_reaction",
    "clarity_load",
)
TARGET_KEYS = ("together_keep", "visual_keep", "text_keep")
GENERIC_LABEL_TERMS = {
    "visible",
    "visibly",
    "frame",
    "frames",
    "montage",
    "image",
    "sequence",
    "subject",
    "subjects",
    "object",
    "objects",
    "person",
    "people",
    "human",
    "thing",
    "things",
    "established",
    "shown",
    "showing",
    "depicted",
}
LABEL_STOP_TERMS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "there",
    "this",
    "to",
    "with",
}


def canonical_text(value: Any) -> str:
    return OPS.canonical_text(value)


def json_ready(value: Any) -> Any:
    return OPS.json_ready(value)


def stable_hash(value: Any) -> str:
    return OPS.stable_hash(value)


def file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def visual_preview48(values: np.ndarray) -> np.ndarray:
    """Project full scorer vectors into the exact persisted preview space."""

    matrix = np.asarray(values, dtype=np.float64)
    if matrix.ndim != 2:
        raise ValueError("visual vectors must be a two-dimensional matrix")
    if matrix.shape[1] == 48:
        return matrix
    if matrix.shape[1] != 1_536:
        raise ValueError(
            f"visual vectors have {matrix.shape[1]} dimensions; expected 48 or 1536"
        )
    return matrix.reshape(len(matrix), 48, 32).mean(axis=2)


def emit_status(stage: str, message: str, **extra: Any) -> None:
    payload = {
        "version": 1,
        "productVersion": PRODUCT_VERSION,
        "analysisVersion": ANALYSIS_VERSION,
        "stage": stage,
        "message": message,
        "updatedAt": int(time.time() * 1000),
        **json_ready(extra),
    }
    LOCAL_STATUS.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    if REMOTE_STATUS_ENABLED:
        try:
            R2.put_json(STATUS_KEY, payload)
        except Exception as exc:
            print(f"principles status write failed: {exc}", flush=True)


def load_vector_bundle(feature: str, expected_n: int) -> np.ndarray:
    payload = R2.get_bytes(f"{OPS.VECTOR_PREFIX}{feature}.npz")
    if not payload:
        raise RuntimeError(f"missing Operations vector bundle for {feature}")
    with np.load(io.BytesIO(payload), allow_pickle=False) as archive:
        values = np.asarray(archive["vectors"], np.float32)
    if values.shape != (expected_n, OPS.EMBED_DIMENSIONS):
        raise RuntimeError(
            f"{feature} vector shape is {values.shape}, expected "
            f"{(expected_n, OPS.EMBED_DIMENSIONS)}"
        )
    return normalize_rows(values)


def family_texts(
    artifact: Mapping[str, Any],
    family_key: str,
) -> list[str]:
    key = family_key.removeprefix("residual__")
    hooks = list(artifact.get("hooks") or [])
    if key == "full_visual":
        return [canonical_text(row.get("description") or "") for row in hooks]
    return [
        canonical_text((row.get("features") or {}).get(key) or "not visibly established")
        for row in hooks
    ]


class UnionFind:
    def __init__(self, size: int):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value: int) -> int:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1


def semantic_lineages(
    hooks: Sequence[Mapping[str, Any]],
    hook_language_vectors: np.ndarray,
) -> dict[str, Any]:
    """Create outcome-blind near-duplicate groups from language geometry.

    A two-component mixture finds the valley in each row's nearest-neighbor
    similarity. Only mutual two-nearest-neighbor edges above that data-derived
    boundary are joined. Exact normalized text is always kept together.
    """

    vectors = normalize_rows(hook_language_vectors)
    n_rows = len(vectors)
    similarity = vectors @ vectors.T
    np.fill_diagonal(similarity, -1.0)
    nearest_similarity = np.max(similarity, axis=1)
    mixture = GaussianMixture(
        n_components=2,
        covariance_type="full",
        n_init=10,
        random_state=SEED,
    ).fit(nearest_similarity.reshape(-1, 1))
    grid = np.linspace(
        float(np.min(nearest_similarity)),
        float(np.max(nearest_similarity)),
        20_001,
    )
    posterior = mixture.predict_proba(grid.reshape(-1, 1))
    boundary_index = int(np.argmin(np.abs(posterior[:, 0] - posterior[:, 1])))
    threshold = float(grid[boundary_index])

    neighbor_count = min(2, max(1, n_rows - 1))
    nearest = np.argsort(similarity, axis=1)[:, -neighbor_count:]
    nearest_sets = [set(int(value) for value in row) for row in nearest]
    union = UnionFind(n_rows)
    semantic_edges = 0
    for left in range(n_rows):
        for right in nearest[left]:
            right = int(right)
            if (
                left in nearest_sets[right]
                and similarity[left, right] >= threshold
            ):
                if union.find(left) != union.find(right):
                    semantic_edges += 1
                union.union(left, right)

    exact_text: dict[str, int] = {}
    exact_edges = 0
    for index, hook in enumerate(hooks):
        text = canonical_text(hook.get("text") or hook.get("title") or "").lower()
        key = re.sub(r"[^a-z0-9]+", " ", text).strip()
        if not key:
            continue
        if key in exact_text:
            if union.find(index) != union.find(exact_text[key]):
                exact_edges += 1
            union.union(index, exact_text[key])
        else:
            exact_text[key] = index

    roots = [union.find(index) for index in range(n_rows)]
    ordered_roots = sorted(
        set(roots),
        key=lambda root: min(index for index, value in enumerate(roots) if value == root),
    )
    root_to_id = {root: f"lineage-{position:04d}" for position, root in enumerate(ordered_roots)}
    ids = [root_to_id[root] for root in roots]
    sizes = Counter(ids)
    return {
        "ids": ids,
        "groupCount": len(sizes),
        "largestGroup": max(sizes.values()) if sizes else 0,
        "multiRowGroups": int(sum(size > 1 for size in sizes.values())),
        "similarityThreshold": threshold,
        "nearestNeighborMixture": {
            "means": [float(value) for value in mixture.means_.ravel()],
            "standardDeviations": [
                float(math.sqrt(value)) for value in mixture.covariances_.ravel()
            ],
            "weights": [float(value) for value in mixture.weights_.ravel()],
        },
        "mutualNeighborCount": neighbor_count,
        "semanticEdges": semantic_edges,
        "exactTextEdges": exact_edges,
        "creatorGroupingAvailable": False,
        "independenceBoundary": (
            "Saved-hook records do not persist creator identity. Groups capture exact "
            "and near-duplicate semantic lineages, not creator-held-out independence; "
            "all discovery-cohort inference is conditional on this saved bank."
        ),
        "method": (
            "Exact normalized text plus mutual two-nearest-neighbor language edges "
            "above the posterior-equality valley of a two-component nearest-similarity mixture."
        ),
    }


def grouped_time_folds(
    hooks: Sequence[Mapping[str, Any]],
    group_ids: Sequence[str],
    fold_count: int = 5,
) -> dict[str, Any]:
    grouped: dict[str, list[int]] = defaultdict(list)
    for index, group_id in enumerate(group_ids):
        grouped[str(group_id)].append(index)
    ordered = sorted(
        grouped.items(),
        key=lambda item: (
            min(float(hooks[index].get("savedAt") or 0) for index in item[1]),
            item[0],
        ),
    )
    count = max(2, min(int(fold_count), len(ordered)))
    assignments = np.zeros(len(hooks), dtype=int)
    totals = [0] * count
    cursor = 0
    for _, indices in ordered:
        while (
            cursor < count - 1
            and sum(totals[: cursor + 1]) >= math.ceil(len(hooks) * (cursor + 1) / count)
        ):
            cursor += 1
        assignments[indices] = cursor
        totals[cursor] += len(indices)
    return {
        "assignments": assignments,
        "foldCount": count,
        "foldSizes": [int(np.sum(assignments == fold)) for fold in range(count)],
        "method": (
            "Outcome-blind semantic lineages ordered by saved time and assigned to "
            "contiguous folds; a lineage never crosses folds. These are not "
            "creator-held-out folds because creator IDs are absent from saved hooks."
        ),
    }


def _pca_scores(values: np.ndarray, max_components: int = 24) -> tuple[np.ndarray, dict[str, Any]]:
    components = min(max_components, len(values) - 1, values.shape[1])
    model = PCA(
        n_components=components,
        svd_solver="randomized",
        random_state=SEED,
    )
    scores = model.fit_transform(values)
    return scores, {
        "components": int(components),
        "explainedVariance": float(np.sum(model.explained_variance_ratio_)),
    }


def residualize_operations(
    bundles: Mapping[str, np.ndarray],
    folds: np.ndarray,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    nuisance_parts = []
    nuisance_diagnostics = {}
    for key in TOPIC_FAMILIES:
        scores, diagnostics = _pca_scores(bundles[key])
        nuisance_parts.append(scores)
        nuisance_diagnostics[key] = diagnostics
    nuisance = np.column_stack(nuisance_parts)
    nuisance = (nuisance - np.mean(nuisance, axis=0)) / (
        np.std(nuisance, axis=0) + 1e-12
    )
    alphas = (0.1, 1.0, 10.0, 100.0, 1000.0)
    residuals: dict[str, np.ndarray] = {}
    family_diagnostics = {}
    for family in RESIDUAL_FAMILIES:
        target = normalize_rows(bundles[family])
        alpha_rows = []
        for alpha in alphas:
            fold_scores = []
            for fold in sorted(set(folds.tolist())):
                train = folds != fold
                test = folds == fold
                model = Ridge(alpha=alpha, solver="cholesky").fit(
                    nuisance[train],
                    target[train],
                )
                predicted = model.predict(nuisance[test])
                predicted_norm = np.linalg.norm(predicted, axis=1)
                valid = predicted_norm > 1e-12
                if np.any(valid):
                    fold_scores.extend(
                        np.sum(
                            normalize_rows(predicted[valid]) * target[test][valid],
                            axis=1,
                        ).tolist()
                    )
            alpha_rows.append({
                "alpha": alpha,
                "meanHeldOutCosine": (
                    float(np.mean(fold_scores)) if fold_scores else -1.0
                ),
            })
        selected = max(alpha_rows, key=lambda row: (row["meanHeldOutCosine"], -row["alpha"]))
        model = Ridge(
            alpha=float(selected["alpha"]),
            solver="cholesky",
        ).fit(nuisance, target)
        prediction = model.predict(nuisance)
        residual = target - prediction
        norms = np.linalg.norm(residual, axis=1)
        if np.any(norms <= 1e-10):
            raise RuntimeError(f"topic residualization collapsed at least one {family} row")
        residuals[f"residual__{family}"] = normalize_rows(residual)
        family_diagnostics[family] = {
            "selectedAlpha": selected["alpha"],
            "heldOutSelection": alpha_rows,
            "meanRemovedCosine": float(np.mean(np.sum(
                normalize_rows(prediction) * target,
                axis=1,
            ))),
        }
    return residuals, {
        "nuisanceFamilies": list(TOPIC_FAMILIES),
        "nuisancePca": nuisance_diagnostics,
        "nuisanceDimensions": int(nuisance.shape[1]),
        "familyModels": family_diagnostics,
        "outcomeBlind": True,
        "method": (
            "Each operation embedding is reconstructed from subject, object, and setting "
            "PCA scores. Ridge strength is selected by lineage-fold held-out cosine without "
            "access to keep; the normalized residual is clustered as a topic-adjusted view."
        ),
    }


def phrase_shortlist(
    texts: Sequence[str],
    member_indices: Sequence[int],
    limit: int = 32,
) -> list[str]:
    membership = np.zeros(len(texts), dtype=bool)
    membership[list(member_indices)] = True
    if not np.any(membership) or np.all(membership):
        return []
    try:
        vectorizer = TfidfVectorizer(
            lowercase=True,
            # Negation is semantically decisive here, so the stock English stop
            # list is intentionally not used.
            stop_words=None,
            ngram_range=(1, 6),
            min_df=2,
            max_features=12_000,
            sublinear_tf=True,
        )
        matrix = vectorizer.fit_transform(texts)
    except ValueError:
        return []
    names = np.asarray(vectorizer.get_feature_names_out())
    inside = np.asarray(matrix[membership].mean(axis=0)).ravel()
    outside = np.asarray(matrix[~membership].mean(axis=0)).ravel()
    scores = inside - outside
    ordered = np.argsort(scores)[::-1]
    output = []
    for index in ordered:
        phrase = str(names[index]).strip()
        tokens = phrase.split()
        if scores[index] <= 0:
            break
        if not tokens or all(
            token in GENERIC_LABEL_TERMS or token in LABEL_STOP_TERMS
            for token in tokens
        ):
            continue
        if any(phrase in existing or existing in phrase for existing in output):
            continue
        output.append(phrase)
        if len(output) >= limit:
            break
    return output


def _evidence_sort_key(row: Mapping[str, Any]) -> tuple[Any, ...]:
    effect = row.get("effect") or {}
    q_value = effect.get("q")
    risk = effect.get("riskDifference")
    ci = effect.get("ci95") or [None, None]
    if risk is None:
        direction_margin = -math.inf
    elif risk >= 0:
        direction_margin = ci[0] if ci[0] is not None else risk
    else:
        direction_margin = -(ci[1] if ci[1] is not None else risk)
    return (
        0 if q_value is not None and q_value <= 0.05 else
        1 if q_value is not None and q_value <= 0.10 else
        2,
        -direction_margin,
        -(effect.get("foldSignConsistency") or 0),
        -int(row.get("n") or 0),
        str(row.get("id") or ""),
    )


def choose_components(
    discovery: Mapping[str, Any],
    inference: Mapping[str, Any],
    maximum: int,
) -> list[dict[str, Any]]:
    components = {
        str(row["id"]): row for row in discovery.get("components") or []
    }
    effects = {
        str(row["componentId"]): row
        for row in (
            ((inference.get("targets") or {}).get("together_keep") or {}).get("components")
            or []
        )
        if row.get("status") == "tested"
    }
    rows = []
    for component_id, component in components.items():
        result = effects.get(component_id)
        if not result:
            continue
        binary = result.get("keepAtLeast85") or {}
        rows.append({
            **component,
            "effect": {
                "q": binary.get("q"),
                "p": binary.get("p"),
                "riskDifference": binary.get("riskDifference"),
                "ci95": binary.get("ci95GroupBootstrap"),
                "foldSignConsistency": (
                    (binary.get("foldValidation") or {}).get("signConsistency")
                ),
            },
        })

    positive = sorted(
        [row for row in rows if (row["effect"].get("riskDifference") or 0) >= 0],
        key=_evidence_sort_key,
    )
    negative = sorted(
        [row for row in rows if (row["effect"].get("riskDifference") or 0) < 0],
        key=_evidence_sort_key,
    )
    selected = []
    positive_limit = max(1, int(math.ceil(maximum * 2 / 3)))
    negative_limit = max(1, maximum - positive_limit)
    for candidates, limit in ((positive, positive_limit), (negative, negative_limit)):
        for row in candidates:
            members = set(row["memberIndices"])
            if any(
                len(members & set(existing["memberIndices"]))
                / max(1, len(members | set(existing["memberIndices"])))
                >= 0.70
                for existing in selected
            ):
                continue
            selected.append(row)
            if sum(
                (item["effect"].get("riskDifference") or 0) >= 0
                for item in selected
            ) >= positive_limit and candidates is positive:
                break
            if sum(
                (item["effect"].get("riskDifference") or 0) < 0
                for item in selected
            ) >= negative_limit and candidates is negative:
                break
    return selected


def embed_component_labels(
    selected: Sequence[Mapping[str, Any]],
    embeddings: Mapping[str, np.ndarray],
    texts_by_family: Mapping[str, list[str]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    candidates_by_family: dict[str, set[str]] = defaultdict(set)
    shortlists: dict[str, dict[str, dict[str, list[str]]]] = defaultdict(dict)
    for component in selected:
        component_id = str(component["id"])
        members = np.asarray(component["memberIndices"], dtype=int)
        for resolution in component.get("resolutions") or []:
            base = str(resolution).removeprefix("residual__")
            texts = texts_by_family[base]
            outside = np.setdiff1d(
                np.arange(len(texts)),
                members,
                assume_unique=True,
            )
            member_phrases = phrase_shortlist(texts, members)
            complement_phrases = phrase_shortlist(texts, outside)
            shortlists[component_id][str(resolution)] = {
                "member": member_phrases,
                "complement": complement_phrases,
            }
            candidates_by_family[str(resolution)].update(member_phrases)
            candidates_by_family[str(resolution)].update(complement_phrases)

    store = EmbeddingStore(
        HERE / ".cache" / "operations-embeddings.sqlite",
        model=OPS.EMBED_MODEL,
        dimensions=OPS.EMBED_DIMENSIONS,
        batch_size=100,
        workers=max(1, int(OPS.ENV.get("OPERATIONS_EMBED_WORKERS") or 2)),
    )
    vector_lookup: dict[str, dict[str, np.ndarray]] = {}
    embedding_counts = {}
    try:
        for resolution in sorted(candidates_by_family):
            base = resolution.removeprefix("residual__")
            prefix = OPS.FEATURE_BY_KEY[base]["label"]
            phrases = sorted(candidates_by_family[resolution])
            requests = [canonical_text(f"{prefix}: {phrase}") for phrase in phrases]
            if not requests:
                vector_lookup[resolution] = {}
                continue
            found = store.embed_many(requests)
            vector_lookup[resolution] = {
                phrase: normalize_rows(np.asarray(found[request]).reshape(1, -1))[0]
                for phrase, request in zip(phrases, requests)
            }
            embedding_counts[resolution] = len(requests)
    finally:
        store.close()

    labels: dict[str, Any] = {}
    for component in selected:
        component_id = str(component["id"])
        candidate_scores: dict[str, list[dict[str, float]]] = defaultdict(list)
        members = np.asarray(component["memberIndices"], dtype=int)
        for resolution in component.get("resolutions") or []:
            resolution = str(resolution)
            base = resolution.removeprefix("residual__")
            descriptor_resolution = (
                base if resolution.startswith("residual__") else resolution
            )
            values = embeddings[descriptor_resolution]
            center = normalize_rows(np.mean(values[members], axis=0).reshape(1, -1))[0]
            outside = np.setdiff1d(np.arange(len(values)), members, assume_unique=True)
            outside_center = normalize_rows(
                np.mean(values[outside], axis=0).reshape(1, -1)
            )[0]
            phrase_groups = shortlists[component_id].get(resolution) or {}
            phrases = sorted(set(
                phrase_groups.get("member") or []
            ) | set(
                phrase_groups.get("complement") or []
            ))
            for phrase in phrases:
                vector = vector_lookup.get(resolution, {}).get(phrase)
                if vector is None:
                    continue
                cosine = float(vector @ center)
                complement_cosine = float(vector @ outside_center)
                contrast = float(cosine - complement_cosine)
                candidate_scores[phrase].append({
                    "cosine": cosine,
                    "complementCosine": complement_cosine,
                    "contrast": contrast,
                    "membershipResolution": resolution,
                    "descriptorResolution": descriptor_resolution,
                })
        ranked = []
        for phrase, scores in candidate_scores.items():
            ranked.append({
                "text": phrase,
                "cosine": float(np.mean([row["cosine"] for row in scores])),
                "complementCosine": float(np.mean([
                    row["complementCosine"] for row in scores
                ])),
                "contrastiveCosine": float(np.mean([
                    row["contrast"] for row in scores
                ])),
                "resolutionSupport": len(scores),
                "membershipResolutions": sorted({
                    row["membershipResolution"] for row in scores
                }),
                "descriptorResolutions": sorted({
                    row["descriptorResolution"] for row in scores
                }),
            })
        ranked.sort(key=lambda row: (
            -row["contrastiveCosine"],
            -row["cosine"],
            -row["resolutionSupport"],
            row["text"],
        ))
        complement_ranked = sorted(ranked, key=lambda row: (
            row["contrastiveCosine"],
            -row["complementCosine"],
            -row["resolutionSupport"],
            row["text"],
        ))

        def nonredundant_rows(
            source: Sequence[Mapping[str, Any]],
        ) -> list[Mapping[str, Any]]:
            chosen = []
            for row in source:
                text = row["text"]
                if any(
                    text in existing["text"] or existing["text"] in text
                    for existing in chosen
                ):
                    continue
                chosen.append(row)
                if len(chosen) == 5:
                    break
            return chosen

        nonredundant = nonredundant_rows(ranked)
        complement_nonredundant = nonredundant_rows(complement_ranked)
        member_label = nonredundant[0]["text"] if nonredundant else None
        complement_label = (
            complement_nonredundant[0]["text"]
            if complement_nonredundant else None
        )
        labels[component_id] = {
            "label": member_label,
            "candidates": nonredundant,
            "complementLabel": complement_label,
            "complementCandidates": complement_nonredundant,
            "comparisonLabel": (
                f"{member_label} versus {complement_label}"
                if member_label and complement_label else member_label
            ),
            "method": (
                "Candidate phrases are deterministic contiguous corpus n-grams. "
                "Both sides of each region are labeled: member phrases rank by "
                "component-centroid cosine minus complement-centroid cosine, and "
                "complement phrases rank by the inverse contrast in the matching "
                "raw 1,536D Gemini descriptor space. Residualized "
                "memberships stay frozen, but labels use their raw family descriptor "
                "space so unadjusted phrase vectors are never compared to residual "
                "coordinates. No LLM assigned a category."
            ),
        }
    return labels, {
        "embeddedCandidateCounts": embedding_counts,
        "totalEmbeddedCandidates": int(sum(embedding_counts.values())),
    }


def build_transport_validation(
    operations: Mapping[str, Any],
    selected: Sequence[Mapping[str, Any]],
    lineage_ids: Sequence[str],
    *,
    quick: bool,
) -> dict[str, Any]:
    """Transport frozen semantic memberships through the shared visual space."""

    source_index = R2.get_json(OPS.SOURCE_INDEX_KEY)
    source_rows, _ = OPS.fetch_records(source_index)
    source_by_id = {str(row["id"]): row for row in source_rows}
    hooks = list(operations.get("hooks") or [])
    saved_rows = []
    original_to_transport_id: dict[int, str] = {}
    for index, hook in enumerate(hooks):
        row = source_by_id.get(str(hook["id"])) or {}
        preview = ((row.get("emb_preview") or {}).get("visual") or [])
        if len(preview) != 48 or not np.all(np.isfinite(preview)):
            continue
        transport_index = len(saved_rows)
        original_to_transport_id[index] = str(hook["id"])
        saved_rows.append({
            "id": str(hook["id"]),
            "vector": np.asarray(preview, dtype=np.float64),
            "group": str(lineage_ids[index]),
            "keep": float(
                ((hook.get("targets") or {}).get("together_keep") or {}).get("estimate")
            ),
            "transportIndex": transport_index,
        })
    if len(saved_rows) < 100:
        raise RuntimeError("too few saved hooks retain shared visual previews")

    raw_bytes = R2.get_bytes("raw/visual/embeddings.npz")
    if not raw_bytes:
        raise RuntimeError("raw visual embedding checkpoint is unavailable")
    raw_sha256 = hashlib.sha256(raw_bytes).hexdigest()
    with np.load(io.BytesIO(raw_bytes), allow_pickle=True) as archive:
        raw_ids = np.asarray([str(value) for value in archive["ids"]], dtype=object)
        raw_vectors = np.asarray(archive["vecs"], dtype=np.float64)
    if raw_vectors.ndim != 2 or len(raw_ids) != len(raw_vectors):
        raise RuntimeError("raw visual embedding checkpoint is misaligned")
    raw_preview_vectors = visual_preview48(raw_vectors)

    retention = R2.get_json("retention/all.json") or {}
    actual_rows = list(retention.get("videos") or [])
    actual_by_id = {
        str(row["id"]): row
        for row in actual_rows
        if row.get("id") and row.get("keep_rate") is not None
    }
    observed_indices = [
        index for index, video_id in enumerate(raw_ids)
        if str(video_id) in actual_by_id
    ]
    broad_indices = [
        index for index, video_id in enumerate(raw_ids)
        if str(video_id) not in actual_by_id
    ]
    if not observed_indices:
        raise RuntimeError("raw visual checkpoint has no overlap with actual keep labels")
    if not broad_indices:
        raise RuntimeError("raw visual checkpoint has no public geometry rows")

    library_path = ROOT / "library-db.json"
    if library_path.exists():
        library = json.loads(library_path.read_text(encoding="utf-8"))
    else:
        library = R2.get_json("library/db.json") or {}
    library_rows = library.get("videos") or {}
    library_by_id = {
        str(row.get("videoId") or key): row
        for key, row in library_rows.items()
        if isinstance(row, Mapping)
    }

    broad_ids = [str(raw_ids[index]) for index in broad_indices]
    broad_groups = [
        str(
            (library_by_id.get(video_id) or {}).get("channelId")
            or (library_by_id.get(video_id) or {}).get("channel")
            or "unknown-channel"
        )
        for video_id in broad_ids
    ]
    observed_ids = [str(raw_ids[index]) for index in observed_indices]
    observed_groups = [
        str(actual_by_id[video_id].get("_chan") or "unknown-channel")
        for video_id in observed_ids
    ]
    observed_keep = [
        float(actual_by_id[video_id]["keep_rate"]) for video_id in observed_ids
    ]

    projected_payload = R2.get_json("raw/visual/map.json") or {}
    projected_ids = [str(value) for value in projected_payload.get("id") or []]
    projected_keep = (projected_payload.get("proj") or {}).get("keep") or {}
    projected_values = (
        projected_keep.get("est")
        if isinstance(projected_keep, Mapping)
        else projected_keep
    ) or []
    broad_projected = {}
    rejected_projected_values = 0
    for video_id, value in zip(projected_ids, projected_values):
        try:
            number = float(value)
        except (TypeError, ValueError):
            rejected_projected_values += 1
            continue
        if not math.isfinite(number):
            rejected_projected_values += 1
            continue
        broad_projected[video_id] = number
    memberships = {}
    valid_saved_ids = {row["id"] for row in saved_rows}
    for component in selected:
        member_ids = [
            str(hooks[index]["id"])
            for index in component["memberIndices"]
            if str(hooks[index]["id"]) in valid_saved_ids
        ]
        if member_ids:
            memberships[str(component["id"])] = {"memberIds": member_ids}
    if not memberships:
        raise RuntimeError("no selected principle has shared-preview support")

    config = TransportConfig(
        k_values=(4, 8) if quick else (4, 8, 16, 32),
        seeds=(17,) if quick else (17, 53, 101),
        bootstrap_repeats=80 if quick else 800,
        min_match_jaccard=0.35,
        min_match_rows=8,
        min_match_precision=0.50,
        min_match_recall=0.50,
        min_robust_partitions=2,
        min_effect_rows=8,
        min_threshold_events=4,
        min_observed_groups=4,
        min_observed_folds=3,
        min_bootstrap_valid_fraction=0.80,
    )
    result = validate_principle_transport(
        np.vstack([row["vector"] for row in saved_rows]),
        [row["keep"] for row in saved_rows],
        [row["group"] for row in saved_rows],
        raw_preview_vectors[broad_indices],
        broad_ids,
        broad_groups,
        raw_preview_vectors[observed_indices],
        observed_keep,
        observed_groups,
        memberships,
        broad_projected_keep_by_id=broad_projected,
        saved_ids=[row["id"] for row in saved_rows],
        observed_ids=observed_ids,
        config=config,
    )
    result["sourceSnapshot"] = {
        "rawVisualKey": "raw/visual/embeddings.npz",
        "rawVisualSha256": raw_sha256,
        "rawVisualRows": int(len(raw_ids)),
        "sharedDimensions": 48,
        "sharedProjection": (
            "Each 1,536D Gemini visual vector is reshaped to 48 contiguous blocks "
            "of 32 dimensions and averaged exactly as raw_upload.py persists emb_preview."
        ),
        "embeddingContract": {
            "declaredModel": OPS.EMBED_MODEL,
            "previewBasis": "reshape(1536)->(48,32), mean over each 32-value block",
            "previewBasisHash": stable_hash(
                "gemini-embedding-2|reshape(1536,48,32)|mean(axis=2)"
            ),
            "currentRawUploadCodeSha256": file_sha256(ROOT / "raw_upload.py"),
            "currentRawEmbedCodeSha256": file_sha256(ROOT / "raw_embed.py"),
            "recordLevelModelVersionPersisted": False,
            "compatibilityBoundary": (
                "Both current code paths declare gemini-embedding-2 and the preview "
                "formula is exact, but legacy saved-hook rows do not persist an "
                "immutable per-record model/version hash."
            ),
        },
        "savedPreviewRows": len(saved_rows),
        "savedPreviewMissing": len(hooks) - len(saved_rows),
        "savedObservedExactIdOverlap": int(
            len(set(row["id"] for row in saved_rows) & set(observed_ids))
        ),
        "broadRows": len(broad_indices),
        "observedRows": len(observed_indices),
        "observedUniqueGroups": len(set(observed_groups)),
        "observedUnknownGroupRows": int(sum(
            group == "unknown-channel" for group in observed_groups
        )),
        "observedTailHits85": int(sum(value >= THRESHOLD for value in observed_keep)),
        "canonicalStoredShorts": int(sum(
            bool(row.get("stored")) for row in library_by_id.values()
        )),
        "projectedMapRows": len(projected_ids),
        "projectedMapRejectedValues": rejected_projected_values,
        "projectedExactIdOverlap": int(sum(
            video_id in broad_projected for video_id in broad_ids
        )),
        "joinContract": (
            "NPZ vectors and projected map scores are joined only by exact YouTube "
            "video ID. Mutable map and NPZ generations are never joined by position."
        ),
    }
    return result


def effect_payload(
    target_result: Mapping[str, Any] | None,
    conditional_effect: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not target_result or target_result.get("status") != "tested":
        return None
    continuous = target_result.get("continuous") or {}
    binary = target_result.get("keepAtLeast85") or {}
    hit_rate = binary.get("insideRisk")
    n_rows = int(target_result.get("n") or 0)
    return {
        "n": n_rows,
        "hits": int(round(float(hit_rate or 0) * n_rows)),
        "hitRate": hit_rate,
        "outsideHitRate": binary.get("outsideRisk"),
        "baseRate": binary.get("baseRisk"),
        "lift": binary.get("lift"),
        "riskRatio": binary.get("riskRatio"),
        "riskDifference": binary.get("riskDifference"),
        "ci95": binary.get("ci95GroupBootstrap"),
        "p": binary.get("p"),
        "q": binary.get("q"),
        "foldSignConsistency": (
            (binary.get("foldValidation") or {}).get("signConsistency")
        ),
        "eligibleFoldCount": (
            (binary.get("foldValidation") or {}).get("eligibleFoldCount")
        ),
        "meanKeep": continuous.get("insideMean"),
        "outsideMeanKeep": continuous.get("outsideMean"),
        "keepDelta": continuous.get("keepDelta"),
        "keepDeltaCi95": continuous.get("ci95GroupBootstrap"),
        "keepDeltaQ": continuous.get("q"),
        "standardizedEffect": continuous.get("standardizedEffect"),
        "conditionalLogOddsCoefficient": (
            (conditional_effect or {}).get("meanStandardizedLogOddsCoefficient")
        ),
        "conditionalFoldSignConsistency": (
            (conditional_effect or {}).get("foldSignConsistency")
        ),
        "thresholdSensitivity": target_result.get("thresholdSensitivity") or [],
    }


def evidence_level(effect: Mapping[str, Any] | None) -> str:
    if not effect:
        return "geometry_only"
    q_value = effect.get("q")
    consistency = effect.get("foldSignConsistency")
    ci = effect.get("ci95") or [None, None]
    risk = effect.get("riskDifference")
    interval_excludes_zero = (
        risk is not None
        and ci[0] is not None
        and ci[1] is not None
        and ((risk > 0 and ci[0] > 0) or (risk < 0 and ci[1] < 0))
    )
    if (
        q_value is not None
        and q_value <= 0.05
        and interval_excludes_zero
        and consistency is not None
        and consistency >= 0.80
    ):
        return "projected_fold_stable"
    if q_value is not None and q_value <= 0.10 and interval_excludes_zero:
        return "projected_associated"
    return "exploratory_projected"


def effect_direction(effect: Mapping[str, Any] | None) -> str:
    return (
        "positive"
        if effect and (effect.get("riskDifference") or 0) >= 0
        else "negative"
    )


def corrected_family_counts(
    inference: Mapping[str, Any],
    target_key: str,
) -> dict[str, int]:
    tested = [
        row
        for row in (
            ((inference.get("targets") or {}).get(target_key) or {})
            .get("components")
            or []
        )
        if row.get("status") == "tested"
    ]
    supported = []
    for row in tested:
        effect = effect_payload(row, None)
        if evidence_level(effect) in {
            "projected_associated",
            "projected_fold_stable",
        }:
            supported.append(effect)
    return {
        "testedComponents": len(tested),
        "correctedPositive": int(sum(
            effect_direction(effect) == "positive" for effect in supported
        )),
        "correctedNegative": int(sum(
            effect_direction(effect) == "negative" for effect in supported
        )),
    }


def scale_plane(values: np.ndarray) -> dict[str, list[int]]:
    model = PCA(n_components=2, svd_solver="randomized", random_state=SEED)
    plane = model.fit_transform(values)
    x, y = OPS.scale_plane(plane)
    return {"x": x, "y": y}


def build_principle_rows(
    selected: Sequence[Mapping[str, Any]],
    discovery: Mapping[str, Any],
    inference: Mapping[str, Any],
    labels: Mapping[str, Any],
    artifact: Mapping[str, Any],
    embeddings: Mapping[str, np.ndarray],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    candidate_lookup = {
        str(row["candidateId"]): row
        for row in discovery.get("candidateLedger") or []
    }
    target_lookup = {}
    conditional_lookup = {}
    for target_key in TARGET_KEYS:
        result = (inference.get("targets") or {}).get(target_key) or {}
        target_lookup[target_key] = {
            str(row["componentId"]): row for row in result.get("components") or []
        }
        conditional_lookup[target_key] = {
            str(row["componentId"]): row
            for row in ((result.get("conditionalModel") or {}).get("componentEffects") or [])
        }
    hooks = list(artifact.get("hooks") or [])
    rows = []
    planes = {}
    for component in selected:
        component_id = str(component["id"])
        effects = {
            target_key: effect_payload(
                target_lookup[target_key].get(component_id),
                conditional_lookup[target_key].get(component_id),
            )
            for target_key in TARGET_KEYS
        }
        directions = {
            target_key: effect_direction(effects[target_key])
            for target_key in TARGET_KEYS
        }
        evidence_levels = {
            target_key: evidence_level(effects[target_key])
            for target_key in TARGET_KEYS
        }
        resolutions = [str(value) for value in component.get("resolutions") or []]
        primary_resolution = (
            max(
                resolutions,
                key=lambda value: sum(
                    candidate_lookup[candidate_id]["resolution"] == value
                    for candidate_id in component.get("supportingCandidateIds") or []
                    if candidate_id in candidate_lookup
                ),
            )
            if resolutions else ""
        )
        if primary_resolution and primary_resolution not in planes:
            planes[primary_resolution] = scale_plane(embeddings[primary_resolution])
        values = embeddings[primary_resolution]
        center = normalize_rows(
            np.mean(values[component["memberIndices"]], axis=0).reshape(1, -1)
        )[0]
        similarities = values @ center
        representatives = sorted(
            component["memberIndices"],
            key=lambda index: (-float(similarities[index]), str(hooks[index]["id"])),
        )[:6]
        label = labels.get(component_id) or {}
        supporting = []
        for candidate_id in component.get("supportingCandidateIds") or []:
            candidate = candidate_lookup.get(str(candidate_id))
            if not candidate:
                continue
            supporting.append({
                "candidateId": candidate["candidateId"],
                "algorithm": candidate["algorithm"],
                "resolution": candidate["resolution"],
                "parameters": candidate["parameters"],
                "n": candidate["n"],
                "stability": candidate["stability"],
                "representative": candidate.get("representative"),
            })
        rows.append({
            "id": component_id,
            "label": label.get("label") or f"Unlabeled component {component_id[-6:]}",
            "complementLabel": label.get("complementLabel"),
            "comparisonLabel": label.get("comparisonLabel"),
            "direction": directions["together_keep"],
            "directions": directions,
            "familyKey": primary_resolution,
            "familyLabel": (
                ("Topic-adjusted " if primary_resolution.startswith("residual__") else "")
                + OPS.FEATURE_BY_KEY[
                    primary_resolution.removeprefix("residual__")
                ]["label"]
            ),
            "source": "visual_description",
            "memberIndices": list(component["memberIndices"]),
            "n": int(component["n"]),
            "prevalence": component["prevalence"],
            "effects": effects,
            "evidenceLevel": evidence_levels["together_keep"],
            "evidenceLevels": evidence_levels,
            "stability": component["stability"],
            "algorithmSupport": component["algorithmSupport"],
            "resolutionSupport": component["resolutionSupport"],
            "stabilitySupport": component["stabilitySupport"],
            "algorithms": component["algorithms"],
            "resolutions": resolutions,
            "supportingPartitions": supporting,
            "labelEvidence": label,
            "representativeHooks": [{
                "index": int(index),
                "id": hooks[index]["id"],
                "title": hooks[index].get("title"),
                "text": hooks[index].get("text"),
                "description": hooks[index].get("description"),
                "montage": hooks[index].get("montage"),
                "targets": hooks[index].get("targets"),
            } for index in representatives],
        })
    rows.sort(key=lambda row: (
        0 if row["direction"] == "positive" else 1,
        _evidence_sort_key({
            "id": row["id"],
            "n": row["n"],
            "effect": {
                "q": (row["effects"]["together_keep"] or {}).get("q"),
                "riskDifference": (
                    row["effects"]["together_keep"] or {}
                ).get("riskDifference"),
                "ci95": (row["effects"]["together_keep"] or {}).get("ci95"),
                "foldSignConsistency": (
                    row["effects"]["together_keep"] or {}
                ).get("foldSignConsistency"),
            },
        }),
    ))
    for index, row in enumerate(rows):
        row["rank"] = index + 1
    return rows, planes


def summarize_partitions(discovery: Mapping[str, Any]) -> dict[str, Any]:
    partitions = list(discovery.get("partitionLedger") or [])
    candidates = list(discovery.get("candidateLedger") or [])
    return {
        "partitionsTested": len(partitions),
        "partitionsValid": int(sum(row.get("status") == "tested" for row in partitions)),
        "partitionsInvalid": int(sum(row.get("status") != "tested" for row in partitions)),
        "rawCandidateComponents": len(candidates),
        "acceptedConsensusComponents": len(discovery.get("components") or []),
        "algorithms": dict(sorted(Counter(
            str(row.get("algorithm") or "unknown") for row in partitions
        ).items())),
        "resolutions": dict(sorted(Counter(
            str(row.get("resolution") or "unknown") for row in partitions
        ).items())),
        "candidateStatuses": dict(sorted(Counter(
            str(row.get("status") or "unknown") for row in candidates
        ).items())),
        "preOutcomeRejections": dict(sorted(Counter(
            reason
            for row in candidates
            for reason in row.get("preOutcomeRejectionReasons") or []
        ).items())),
    }


def build_artifacts(maximum_principles: int = 30, quick: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    emit_status("inventory", "Reading the frozen Operations artifact and vector bundles.")
    operations = R2.get_json(OPS.ARTIFACT_KEY)
    if not operations:
        raise RuntimeError("the canonical Operations artifact is unavailable")
    OPS.validate_artifact(operations)
    hooks = list(operations["hooks"])
    n_rows = len(hooks)
    needed = sorted(
        set(RAW_OPERATION_FAMILIES)
        | set(RESIDUAL_FAMILIES)
        | set(TOPIC_FAMILIES)
        | {"hook_language"}
    )
    bundles = {}
    for position, key in enumerate(needed, 1):
        emit_status(
            "loading_vectors",
            f"Loading outcome-blind semantic bundle {position} of {len(needed)}.",
            completed=position - 1,
            total=len(needed),
            feature=key,
        )
        bundles[key] = load_vector_bundle(key, n_rows)

    lineages = semantic_lineages(hooks, bundles["hook_language"])
    folds = grouped_time_folds(hooks, lineages["ids"])
    emit_status(
        "residualizing",
        "Removing topic geometry from operation families without using keep.",
        lineageGroups=lineages["groupCount"],
    )
    residuals, residualization = residualize_operations(
        bundles,
        folds["assignments"],
    )
    discovery_embeddings = {
        key: bundles[key] for key in RAW_OPERATION_FAMILIES
    }
    discovery_embeddings.update(residuals)
    if quick:
        quick_keys = {
            "action",
            "transformation",
            "clarity_load",
            "proof_result",
            "residual__action",
            "residual__transformation",
            "residual__clarity_load",
            "residual__proof_result",
        }
        discovery_embeddings = {
            key: values
            for key, values in discovery_embeddings.items()
            if key in quick_keys
        }
    config = PrinciplesConfig(
        k_values=(2, 3, 4) if quick else (2, 3, 4, 5),
        seeds=(SEED,) if quick else (SEED, SEED + 101, SEED + 307),
        stability_resamples=2 if quick else 4,
        bootstrap_repeats=80 if quick else 600,
        min_component_size=8,
        min_algorithm_support=2,
        min_resolution_support=1,
        keep_threshold=THRESHOLD,
        sensitivity_thresholds=(82.5, THRESHOLD, 87.5),
    )
    emit_status(
        "discovering",
        "Running outcome-blind multi-algorithm component discovery.",
        resolutions=len(discovery_embeddings),
    )
    discovery = discover_components(
        discovery_embeddings,
        lineages["ids"],
        config=config,
    )
    target_arrays = {
        target_key: np.asarray([
            ((row.get("targets") or {}).get(target_key) or {}).get("estimate", np.nan)
            for row in hooks
        ], dtype=float)
        for target_key in TARGET_KEYS
    }
    emit_status(
        "inference",
        "Geometry is frozen; measuring grouped projected-keep associations.",
        components=len(discovery.get("components") or []),
    )
    inference = analyze_component_outcomes(
        discovery,
        target_arrays,
        lineages["ids"],
        folds["assignments"],
        config=config,
    )
    selected = choose_components(
        discovery,
        inference,
        maximum=max(6, int(maximum_principles)),
    )
    emit_status(
        "transport",
        (
            "Transporting frozen semantic memberships into downloaded-video geometry "
            "and separately attaching projected and actual keep outcomes."
        ),
        selected=len(selected),
    )
    transport = build_transport_validation(
        operations,
        selected,
        lineages["ids"],
        quick=quick,
    )
    texts_by_family = {
        key: family_texts(operations, key)
        for key in RAW_OPERATION_FAMILIES
    }
    emit_status(
        "labeling",
        "Selecting plain-English labels by contrastive text-embedding geometry.",
        selected=len(selected),
    )
    labels, label_diagnostics = embed_component_labels(
        selected,
        discovery_embeddings,
        texts_by_family,
    )
    principles, planes = build_principle_rows(
        selected,
        discovery,
        inference,
        labels,
        operations,
        discovery_embeddings,
    )
    for principle in principles:
        transported = (transport.get("principles") or {}).get(principle["id"]) or {}
        principle["transportEvidenceTier"] = transported.get("evidenceTier")
        principle["broadCorpus"] = transported.get("broadProjectedSurrogate")
        principle["observedDiagnostic"] = transported.get("observedActualKeep")
        principle["transport"] = {
            "selectedMatch": (
                ((transport.get("geometry") or {}).get("principles") or {})
                .get(principle["id"], {})
                .get("selectedMatch")
            ),
            "matchRobustness": (
                ((transport.get("geometry") or {}).get("principles") or {})
                .get(principle["id"], {})
                .get("matchRobustness")
            ),
            "savedProjectedReference": transported.get("savedProjectedReference"),
            "interpretationBoundary": transported.get("interpretationBoundary"),
        }
    partition_summary = summarize_partitions(discovery)
    summary_targets = {
        target_key: {
            "n": int(np.sum(np.isfinite(values))),
            "positives85": int(np.sum(values[np.isfinite(values)] >= THRESHOLD)),
            "baseRate85": float(np.mean(values[np.isfinite(values)] >= THRESHOLD)),
            "mean": float(np.mean(values[np.isfinite(values)])),
        }
        for target_key, values in target_arrays.items()
    }
    together_model = (
        (inference.get("targets") or {}).get("together_keep") or {}
    ).get("conditionalModel") or {}
    target_summaries = {}
    for target_key in TARGET_KEYS:
        retained_supported_positive = [
            row for row in principles
            if row["directions"][target_key] == "positive"
            and row["evidenceLevels"][target_key]
            in {"projected_associated", "projected_fold_stable"}
        ]
        retained_supported_negative = [
            row for row in principles
            if row["directions"][target_key] == "negative"
            and row["evidenceLevels"][target_key]
            in {"projected_associated", "projected_fold_stable"}
        ]
        family_counts = corrected_family_counts(inference, target_key)
        corrected_positive = family_counts["correctedPositive"]
        corrected_negative = family_counts["correctedNegative"]
        if corrected_positive:
            sentence = (
                f"Across the complete globally corrected family, {corrected_positive} "
                "outcome-blind visual contrast"
                f"{'s' if corrected_positive != 1 else ''} cleared the positive "
                "projected 85%+ association contract."
            )
        else:
            sentence = (
                "No positive visual contrast yet clears corrected projected-"
                "association criteria for the 85% threshold."
            )
        if corrected_negative:
            sentence += (
                f" {corrected_negative} contrast"
                f"{'s' if corrected_negative != 1 else ''} cleared the "
                "corrected lower-association contract."
            )
        sentence += (
            f" The atlas shows {len(principles)} nonredundant retained contrasts, "
            f"including {len(retained_supported_positive)} corrected positive and "
            f"{len(retained_supported_negative)} corrected lower-association cards. "
            "Both embedding-derived sides and exploratory directions are visible; "
            "none is a causal recipe."
        )
        target_summaries[target_key] = {
            "oneSentence": sentence,
            "correctedHypothesisFamilyComponents": family_counts["testedComponents"],
            "correctedPositivePrinciples": corrected_positive,
            "correctedNegativePrinciples": corrected_negative,
            "retainedCorrectedPositivePrinciples": len(
                retained_supported_positive
            ),
            "retainedCorrectedNegativePrinciples": len(
                retained_supported_negative
            ),
            "positivePrinciples": int(sum(
                row["directions"][target_key] == "positive"
                for row in principles
            )),
            "negativePrinciples": int(sum(
                row["directions"][target_key] == "negative"
                for row in principles
            )),
            "evidenceLevels": dict(sorted(Counter(
                row["evidenceLevels"][target_key] for row in principles
            ).items())),
        }
    sentence = target_summaries["together_keep"]["oneSentence"]

    source_hash = stable_hash({
        "operationsArtifactHash": operations["artifactHash"],
        "vectorHashes": {
            key: OPS.array_hash(discovery_embeddings[key])
            for key in sorted(discovery_embeddings)
        },
        "lineages": lineages["ids"],
        "folds": folds["assignments"].tolist(),
        "config": discovery["config"],
    })
    ledger = {
        "version": 1,
        "productVersion": PRODUCT_VERSION,
        "analysisVersion": ANALYSIS_VERSION,
        "analysisMode": "quick_local" if quick else "full",
        "generatedAt": int(time.time() * 1000),
        "sourceHash": source_hash,
        "operationsArtifactHash": operations["artifactHash"],
        "lineages": lineages,
        "folds": {
            **folds,
            "assignments": folds["assignments"].astype(int).tolist(),
        },
        "residualization": residualization,
        "discovery": discovery,
        "inference": inference,
        "labels": labels,
        "labelDiagnostics": label_diagnostics,
        "transport": transport,
    }
    ledger["ledgerHash"] = stable_hash(ledger)
    transport_snapshot = transport.get("sourceSnapshot") or {}
    observed_rows = int(transport_snapshot.get("observedRows") or 0)
    observed_hits = int(transport_snapshot.get("observedTailHits85") or 0)
    canonical_shorts = int(
        transport_snapshot.get("canonicalStoredShorts") or 0
    )
    artifact = {
        "schema": "operations-principles-85-v1",
        "version": 1,
        "productVersion": PRODUCT_VERSION,
        "analysisVersion": ANALYSIS_VERSION,
        "generatedAt": ledger["generatedAt"],
        "source": {
            "n": n_rows,
            "threshold": THRESHOLD,
            "analysisMode": "quick_local" if quick else "full",
            "operationsArtifactHash": operations["artifactHash"],
            "sourceHash": source_hash,
            "targetSummaries": summary_targets,
            "selection": "The complete frozen 984-row Shorts Quant saved-hook Operations bank.",
            "broadCorpus": {
                **(transport.get("sourceSnapshot") or {}),
                "status": "geometry backfill is separate and resumable",
                "claim": (
                    f"The {canonical_shorts:,}-Short corpus may stabilize geometry, "
                    "but its keep values are projected from the same steer axes and "
                    "cannot validate 85% truth."
                ),
            },
        },
        "measurementBoundary": {
            "headline": "Projected keep, not observed YouTube swipe ratio",
            "projected": (
                f"The {n_rows:,} discovery outcomes are existing embedding estimates. They can "
                "rank surrogate associations but cannot prove real 85% keep or causality."
            ),
            "observed": (
                f"The observed diagnostic contains {observed_rows:,} private videos "
                f"that are exact-ID disjoint from the saved-hook discovery bank; only "
                f"{observed_hits:,} are at least 85%, across "
                f"{int(transport_snapshot.get('observedUniqueGroups') or 0):,} groups. "
                "It is separately labeled, low power, and not corrected replication."
            ),
            "grouping": (
                "Saved-hook records do not contain creator IDs. Discovery inference and "
                "fold stability are grouped by exact and near-duplicate semantic lineage, "
                "not held-out creator, and therefore apply only to this saved bank."
            ),
            "evidenceLevels": {
                "geometry_only": "Stable outcome-blind semantic region; no outcome claim.",
                "exploratory_projected": "Associated only with the projected keep surrogate.",
                "projected_associated": "BY-adjusted surrogate association with interval support.",
                "projected_fold_stable": (
                    "BY-adjusted surrogate association, group-bootstrap interval excluding "
                    "zero, and matching direction in at least 80% of eligible lineage folds. "
                    "This is internal fold stability, not independent replication."
                ),
                "observed_directional_consistency": (
                    "An eligible transported region has the same continuous-effect direction "
                    "in exact-ID-disjoint private keep data with interval and group-fold support. This "
                    "is not multiplicity-corrected replication."
                ),
            },
        },
        "method": {
            "analysisMode": "quick_local" if quick else "full",
            "operationalDefinition": (
                "A principle is a semantic region discovered without outcomes, reproduced "
                "by at least two clustering algorithms, stable under lineage-group resampling, "
                "and then measured against the frozen 85% projected-keep event."
            ),
            "discoveryFirst": True,
            "outcomeBlindClustering": True,
            "threshold": THRESHOLD,
            "partitionSummary": partition_summary,
            "lineages": {
                key: value for key, value in lineages.items() if key != "ids"
            },
            "folds": {
                key: (
                    value.astype(int).tolist()
                    if isinstance(value, np.ndarray)
                    else value
                )
                for key, value in folds.items()
                if key != "assignments"
            },
            "topicAdjustment": residualization,
            "multipleTesting": inference.get("multipleTesting"),
            "transport": {
                "schemaVersion": transport.get("schemaVersion"),
                "sourceSnapshot": transport.get("sourceSnapshot"),
                "claims": transport.get("claims"),
                "outcomesAttachedAfterGeometry": transport.get(
                    "outcomesAttachedAfterGeometry"
                ),
            },
            "labeling": (
                "No manual or LLM-assigned cluster labels. Deterministic corpus phrases "
                "are embedded with Gemini embedding-2 and ranked on both the member and "
                "complement sides by contrastive centroid cosine in a matching raw "
                "descriptor family. Residual membership is frozen first and never "
                "compared directly with an unadjusted phrase vector."
            ),
            "ledgerKey": LEDGER_KEY,
            "ledgerHash": ledger["ledgerHash"],
        },
        "summary": {
            "oneSentence": sentence,
            **target_summaries,
            "principlesRetained": len(principles),
            "positivePrinciples": target_summaries["together_keep"][
                "positivePrinciples"
            ],
            "negativePrinciples": target_summaries["together_keep"][
                "negativePrinciples"
            ],
            "evidenceLevels": target_summaries["together_keep"][
                "evidenceLevels"
            ],
            "conditionalModel": together_model,
        },
        "principles": principles,
        "planes": planes,
        "validation": {
            target_key: {
                "eventRate85": (
                    (inference.get("targets") or {}).get(target_key) or {}
                ).get("eventRate85"),
                "conditionalModel": (
                    (inference.get("targets") or {}).get(target_key) or {}
                ).get("conditionalModel"),
            }
            for target_key in TARGET_KEYS
        },
    }
    artifact["artifactHash"] = stable_hash(artifact)
    return json_ready(artifact), json_ready(ledger)


def validate_artifact(artifact: Mapping[str, Any], ledger: Mapping[str, Any]) -> None:
    if artifact.get("schema") != "operations-principles-85-v1":
        raise ValueError("principles artifact schema mismatch")
    if artifact.get("productVersion") != PRODUCT_VERSION:
        raise ValueError("principles artifact product version mismatch")
    if artifact.get("analysisVersion") != ANALYSIS_VERSION:
        raise ValueError("principles artifact analysis version mismatch")
    analysis_mode = str((artifact.get("source") or {}).get("analysisMode") or "")
    if analysis_mode not in {"full", "quick_local"}:
        raise ValueError("principles artifact analysis mode is missing")
    if analysis_mode != str(ledger.get("analysisMode") or ""):
        raise ValueError("principles artifact and ledger analysis modes differ")
    source_n = int((artifact.get("source") or {}).get("n") or 0)
    if source_n <= 0:
        raise ValueError("principles artifact source count is missing")
    if float((artifact.get("source") or {}).get("threshold") or 0) != THRESHOLD:
        raise ValueError("principles artifact threshold mismatch")
    if not (artifact.get("principles") or []):
        raise ValueError("principles artifact has no retained principles")
    ids = [str(row.get("id") or "") for row in artifact["principles"]]
    if not all(ids) or len(set(ids)) != len(ids):
        raise ValueError("principle IDs are empty or duplicated")
    for row in artifact["principles"]:
        member_indices = list(row.get("memberIndices") or [])
        if not member_indices:
            raise ValueError(f"{row['id']} has no visual members")
        if any(
            not isinstance(index, int) or index < 0 or index >= source_n
            for index in member_indices
        ):
            raise ValueError(f"{row['id']} has an out-of-range member index")
        if not row.get("label"):
            raise ValueError(f"{row['id']} has no embedding-derived label")
        if not row.get("complementLabel") or not row.get("comparisonLabel"):
            raise ValueError(f"{row['id']} has no two-sided embedding-derived label")
        label_evidence = row.get("labelEvidence") or {}
        if (
            not label_evidence.get("candidates")
            or not label_evidence.get("complementCandidates")
        ):
            raise ValueError(f"{row['id']} has incomplete two-sided label evidence")
        if set(row.get("effects") or {}) != set(TARGET_KEYS):
            raise ValueError(f"{row['id']} does not expose every keep target")
        if set(row.get("directions") or {}) != set(TARGET_KEYS):
            raise ValueError(f"{row['id']} does not expose target-specific directions")
        if set(row.get("evidenceLevels") or {}) != set(TARGET_KEYS):
            raise ValueError(
                f"{row['id']} does not expose target-specific evidence levels"
            )
        if row.get("evidenceLevel") not in (
            artifact.get("measurementBoundary") or {}
        ).get("evidenceLevels", {}):
            raise ValueError(f"{row['id']} has an undeclared evidence level")
        family_key = str(row.get("familyKey") or "")
        plane = (artifact.get("planes") or {}).get(family_key) or {}
        if (
            len(plane.get("x") or []) != source_n
            or len(plane.get("y") or []) != source_n
        ):
            raise ValueError(f"{row['id']} has no aligned semantic plane")
        selected_match = ((row.get("transport") or {}).get("selectedMatch") or {})
        if not selected_match.get("transportEligible"):
            for key in ("broadCorpus", "observedDiagnostic"):
                diagnostic = row.get(key) or {}
                if diagnostic.get("status") != "transport_ineligible":
                    raise ValueError(
                        f"{row['id']} exposes {key} despite ineligible transport"
                    )
    summary = artifact.get("summary") or {}
    if any(
        not isinstance(summary.get(target_key), Mapping)
        or not summary[target_key].get("oneSentence")
        for target_key in TARGET_KEYS
    ):
        raise ValueError("principles artifact lacks target-specific summaries")
    stored_hash = str(artifact.get("artifactHash") or "")
    unhashed = dict(artifact)
    unhashed.pop("artifactHash", None)
    if len(stored_hash) != 64 or stable_hash(unhashed) != stored_hash:
        raise ValueError("principles artifact hash does not match content")
    ledger_hash = str(ledger.get("ledgerHash") or "")
    unhashed_ledger = dict(ledger)
    unhashed_ledger.pop("ledgerHash", None)
    if len(ledger_hash) != 64 or stable_hash(unhashed_ledger) != ledger_hash:
        raise ValueError("principles ledger hash does not match content")
    if ledger_hash != (artifact.get("method") or {}).get("ledgerHash"):
        raise ValueError("principles ledger hash mismatch")


def publish(artifact: Mapping[str, Any], ledger: Mapping[str, Any]) -> None:
    validate_artifact(artifact, ledger)
    if (artifact.get("source") or {}).get("analysisMode") != "full":
        raise ValueError("quick/local principles artifacts cannot replace canonical R2")
    source_hash = str((artifact.get("source") or {}).get("sourceHash"))
    staged_artifact = f"{STAGING_PREFIX}{source_hash}.json"
    staged_ledger = f"{STAGING_PREFIX}{source_hash}-ledger.json"
    R2.put_json(staged_ledger, ledger)
    R2.put_json(staged_artifact, artifact)
    readback_artifact = R2.get_json(staged_artifact)
    readback_ledger = R2.get_json(staged_ledger)
    validate_artifact(readback_artifact, readback_ledger)
    R2.put_json(LEDGER_KEY, readback_ledger)
    R2.put_json(ARTIFACT_KEY, readback_artifact)
    canonical = R2.get_json(ARTIFACT_KEY)
    canonical_ledger = R2.get_json(LEDGER_KEY)
    validate_artifact(canonical, canonical_ledger)


def main() -> int:
    global REMOTE_STATUS_ENABLED
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--local-only", action="store_true")
    parser.add_argument("--maximum-principles", type=int, default=30)
    args = parser.parse_args()
    if args.quick and not args.local_only:
        parser.error("--quick is validation-only and requires --local-only")
    REMOTE_STATUS_ENABLED = not args.local_only
    started = time.time()
    try:
        artifact, ledger = build_artifacts(
            maximum_principles=args.maximum_principles,
            quick=args.quick,
        )
        validate_artifact(artifact, ledger)
        LOCAL_ARTIFACT.write_text(
            json.dumps(artifact, ensure_ascii=False, indent=2, allow_nan=False),
            encoding="utf-8",
        )
        LOCAL_LEDGER.write_text(
            json.dumps(ledger, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
        )
        if not args.local_only:
            emit_status("publishing", "Publishing verified principles and the complete audit ledger.")
            publish(artifact, ledger)
        emit_status(
            "complete",
            (
                f"Principles complete: {len(artifact['principles'])} retained from "
                f"{artifact['method']['partitionSummary']['partitionsTested']} "
                "outcome-blind partitions."
            ),
            artifactHash=artifact["artifactHash"],
            ledgerHash=ledger["ledgerHash"],
            principles=len(artifact["principles"]),
            elapsedSeconds=round(time.time() - started, 1),
        )
        print(json.dumps({
            "ok": True,
            "artifactHash": artifact["artifactHash"],
            "ledgerHash": ledger["ledgerHash"],
            "principles": len(artifact["principles"]),
            "partitionSummary": artifact["method"]["partitionSummary"],
            "elapsedSeconds": round(time.time() - started, 1),
        }, indent=2))
        return 0
    except Exception as exc:
        emit_status(
            "error",
            f"Principles build failed: {type(exc).__name__}: {exc}",
            error=f"{type(exc).__name__}: {exc}",
        )
        raise


if __name__ == "__main__":
    raise SystemExit(main())
