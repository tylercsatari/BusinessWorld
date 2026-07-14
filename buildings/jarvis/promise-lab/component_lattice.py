"""Shared, outcome-safe multi-resolution component lattice for corpus and live hooks."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from itertools import combinations

import numpy as np

from atlas import REPRESENTATION_VERSION
from scipy.spatial import cKDTree

from hook_score_core import apply_category_transform, category_log_probabilities
from sequence import surface


EPS = 1e-9
LATTICE_VERSION = "multi-resolution-component-lattice-v4"
FDR_ALPHA = 0.05
TIMESTAMP_WINDOWS = (0.5, 1.0, 2.0, 3.0, 5.0)
WINDOW_BANDS = ((4, 6), (7, 10), (11, 16))

# This list is used only to retain and explain rejected candidates. It never
# chooses a boundary, category, graph edge, score, or training example.
FUNCTION_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "had", "has", "have",
    "he", "her", "hers", "him", "his", "how", "i", "if", "in", "into", "is",
    "it", "its", "me", "my", "nor", "not", "of", "on", "or", "our", "ours",
    "she", "so", "than", "that", "the", "their", "theirs", "them", "then",
    "there", "these", "they", "this", "those", "through", "to", "too", "up",
    "us", "was", "we", "were", "what", "when", "where", "which", "while",
    "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
})
CONJUNCTIONS = frozenset({
    "and", "but", "or", "nor", "for", "so", "yet", "although", "because",
    "before", "even", "if", "once", "since", "than", "though", "unless",
    "until", "when", "whenever", "where", "whereas", "wherever", "whether",
    "while",
})
PUNCTUATION_BOUNDARIES = frozenset(",.;:!?—–-")

RESOLUTION_DEFINITIONS = {
    "full-hook": "the exact complete normalized source hook",
    "token": "one surface atom from the deterministic Unicode atomizer",
    "ngram-2": "every contiguous two-token span",
    "ngram-3": "every contiguous three-token span",
    "window-4-6": "every contiguous span containing four through six tokens",
    "window-7-10": "every contiguous span containing seven through ten tokens",
    "window-11-16": "every contiguous span containing eleven through sixteen tokens",
    "prefix": "every source prefix ending at a token boundary",
    "suffix": "every source suffix beginning at a token boundary",
    "clause": "segments induced by punctuation, conjunction, or outcome-blind pause boundaries",
    "timestamp": "token-aligned windows covering 0.5, 1, 2, 3, or 5 spoken seconds",
    "change-point": "segments split at prefix-transition outliers passing corpus-calibrated BH FDR",
    "deletion": "every leave-one-contiguous-span-out counterfactual",
    "canonical": "the frozen source-held-out variable exact cover used by the hook scorer",
}


def _unit(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, np.float32)
    if values.ndim == 1:
        return values / (float(np.linalg.norm(values)) + EPS)
    return values / (np.linalg.norm(values, axis=1, keepdims=True) + EPS)


def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    return float(_unit(left) @ _unit(right)) if np.any(left) and np.any(right) else 0.0


def _orthogonal(vector: np.ndarray, anchor: np.ndarray | None) -> np.ndarray:
    value = np.asarray(vector, np.float32)
    if anchor is None:
        return np.zeros_like(value)
    if not np.any(anchor):
        return value.copy()
    base = _unit(anchor)
    return value - float(value @ base) * base


def _percentile(values: np.ndarray, value: float) -> float:
    ordered = np.sort(np.asarray(values, float))
    return float(100 * np.searchsorted(ordered, value, side="right") / max(1, len(ordered)))


def _json_ready(value):
    """Return one canonical JSON-safe view without changing the live payload."""
    if isinstance(value, np.ndarray):
        return _json_ready(value.tolist())
    if isinstance(value, np.generic):
        return _json_ready(value.item())
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_ready(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("lattice content hash cannot contain non-finite model values")
    return value


def _bh_fdr(p_values: list[float]) -> list[float]:
    if not p_values:
        return []
    values = np.asarray(p_values, float)
    order = np.argsort(values, kind="stable")
    ranked = values[order]
    adjusted = ranked * len(values) / np.arange(1, len(values) + 1)
    adjusted = np.minimum.accumulate(adjusted[::-1])[::-1]
    output = np.empty_like(adjusted)
    output[order] = np.clip(adjusted, 0, 1)
    return output.tolist()


def _token_dict(token) -> dict:
    if isinstance(token, dict):
        return {
            "index": int(token["index"]), "text": str(token["text"]),
            "start": int(token["start"]), "end": int(token["end"]),
        }
    return {
        "index": int(token.index), "text": str(token.text),
        "start": int(token.start), "end": int(token.end),
    }


def exact_or_estimated_timing(tokens: list, words: list[dict] | None = None,
                              words_per_second: float = 3.9175191560311324,
                              timing_policy: str | None = None,
                              timing_metadata: dict | None = None) -> tuple[list[dict], dict]:
    """Return one auditable timing row per source atom without changing tokenization."""
    token_rows = [_token_dict(token) for token in tokens]
    supplied = {int(row.get("tokenIndex", -1)): row for row in (words or [])}
    lexical_indices = [
        token["index"] for token in token_rows
        if any(character.isalnum() or character == "_" for character in token["text"])
    ]
    policy_text = str(timing_policy or "").lower()
    policy_uses_source_timing = policy_text not in {
        "library-average speaking rate", "estimated", "corpus-mean-speaking-rate",
    }
    source_aligned = policy_uses_source_timing and all(
        index in supplied for index in lexical_indices
    )
    if source_aligned:
        source_aligned = all(
            str(supplied[index].get("text") or "").casefold()
            == str(token_rows[index]["text"]).casefold()
            for index in lexical_indices
        )
    declared = timing_metadata or {}
    media_aligned = bool(source_aligned and declared.get("mediaAligned"))
    if timing_metadata is not None:
        timing_exact = bool(source_aligned and declared.get("timingExact"))
        inferred_intervals = bool(source_aligned and not timing_exact)
    else:
        inferred_intervals = source_aligned and any(
            marker in policy_text for marker in ("quantized", "inferred", "resolved")
        )
        timing_exact = source_aligned and not inferred_intervals
    timing_source = (
        "source-media-ctc-estimated-intervals"
        if media_aligned else
        "source-aligned-inferred-intervals"
        if source_aligned and inferred_intervals else
        "source-caption-token-cover"
        if source_aligned else
        "corpus-mean-speaking-rate"
    )
    output = []
    lexical_seen = 0
    for token in token_rows:
        index = token["index"]
        provenance = {}
        start_boundary_acoustic = False
        end_boundary_acoustic = False
        timing_estimated_inside_word = False
        if source_aligned and index in supplied:
            source = supplied[index]
            start = float(source.get("spokenStartSeconds") or 0)
            end = float(source.get("spokenEndSeconds") or start)
            start_boundary_acoustic = bool(
                source.get("spokenStartBoundaryAcoustic")
            )
            end_boundary_acoustic = bool(
                source.get("spokenEndBoundaryAcoustic")
            )
            timing_estimated_inside_word = bool(
                source.get("timingEstimatedInsideAcousticWord")
            )
            provenance = {
                key: source[key] for key in (
                    "sourceWordIndex", "sourceWord", "sourceStartTimestampSeconds",
                    "resolvedSourceWordStartSeconds", "resolvedSourceWordEndSeconds",
                    "startResolution", "timestampCollisionGroupSize",
                    "timingSource", "alignmentStatus", "alignmentConfidenceScore",
                    "acousticPosteriorGeometricMean", "freeDecodeCharacterCoverage",
                ) if key in source
            }
        elif source_aligned:
            previous = next((
                supplied[candidate] for candidate in range(index - 1, -1, -1)
                if candidate in supplied
            ), None)
            following = next((
                supplied[candidate] for candidate in range(index + 1, len(token_rows))
                if candidate in supplied
            ), None)
            boundary = (
                float(previous.get("spokenEndSeconds") or previous.get("spokenStartSeconds") or 0)
                if previous is not None else
                float(following.get("spokenStartSeconds") or 0)
            )
            start = end = boundary
            if previous is not None:
                start_boundary_acoustic = end_boundary_acoustic = bool(
                    previous.get("spokenEndBoundaryAcoustic")
                )
            elif following is not None:
                start_boundary_acoustic = end_boundary_acoustic = bool(
                    following.get("spokenStartBoundaryAcoustic")
                )
        else:
            lexical = any(character.isalnum() or character == "_" for character in token["text"])
            start = lexical_seen / max(words_per_second, EPS)
            lexical_seen += int(lexical)
            end = lexical_seen / max(words_per_second, EPS)
        output.append({
            **token, "spokenStartSeconds": start, "spokenEndSeconds": end,
            "spokenStartBoundaryAcoustic": start_boundary_acoustic,
            "spokenEndBoundaryAcoustic": end_boundary_acoustic,
            "timingEstimatedInsideAcousticWord": timing_estimated_inside_word,
            "timingSource": timing_source, **provenance,
        })
    return output, {
        "source": timing_source,
        "exact": timing_exact,
        "sourceAlignmentTokenCover": source_aligned,
        "wordIntervalsInferred": inferred_intervals,
        "mediaAligned": media_aligned,
        "boundaryEstimator": declared.get("boundaryEstimator"),
        "alignmentConfidence": declared.get("alignmentConfidence"),
        "timingResolutionSeconds": declared.get("timingResolutionSeconds"),
        "lexicalStartBoundariesAcoustic": sum(
            row["spokenStartBoundaryAcoustic"]
            and any(character.isalnum() or character == "_" for character in row["text"])
            for row in output
        ),
        "lexicalEndBoundariesAcoustic": sum(
            row["spokenEndBoundaryAcoustic"]
            and any(character.isalnum() or character == "_" for character in row["text"])
            for row in output
        ),
        "wordsPerSecond": None if source_aligned else float(words_per_second),
        "claimBoundary": (
            str(declared.get("claimBoundary"))
            if declared.get("claimBoundary") else
            "Stored source intervals are used when every lexical atom aligns; a supplied policy "
            "declares whether those intervals are observed or inferred. Unspoken punctuation gets "
            "a zero-duration adjacent boundary. Live or incomplete text uses the frozen corpus mean "
            "speaking rate and is explicitly an estimate."
        ),
    }


def span_timing_interval(timing: list[dict], start: int, end: int) -> dict:
    selected = timing[int(start):int(end)]
    lexical = [
        row for row in selected
        if any(character.isalnum() or character == "_" for character in row["text"])
    ]
    measured = lexical or selected
    if not measured:
        raise ValueError("component has no timed source tokens")
    first = measured[0]
    last = measured[-1]
    start_seconds = float(first["spokenStartSeconds"])
    end_seconds = float(last["spokenEndSeconds"])
    start_acoustic = bool(first.get("spokenStartBoundaryAcoustic"))
    end_acoustic = bool(last.get("spokenEndBoundaryAcoustic"))
    return {
        "startSeconds": start_seconds,
        "endSeconds": end_seconds,
        "startBoundaryAcoustic": start_acoustic,
        "endBoundaryAcoustic": end_acoustic,
        "outcomeTimingEligible": bool(
            start_acoustic and end_acoustic and end_seconds > start_seconds
        ),
    }


def prefix_transition_distances(raw: np.ndarray, starts: np.ndarray,
                                ends: np.ndarray, token_count: int) -> np.ndarray:
    lookup = {
        (int(start), int(end)): index
        for index, (start, end) in enumerate(zip(starts, ends))
    }
    prefixes = np.asarray([raw[lookup[(0, end)]] for end in range(1, token_count + 1)], np.float32)
    if len(prefixes) < 2:
        return np.zeros(0, np.float32)
    return (1 - np.sum(_unit(prefixes[:-1]) * _unit(prefixes[1:]), axis=1)).astype(np.float32)


def change_point_segments(distances: np.ndarray, null_sorted: np.ndarray | None,
                          token_count: int) -> tuple[list[tuple[int, int]], list[dict]]:
    """Select prefix changes with one corpus-frozen, outcome-free FDR rule."""
    distances = np.asarray(distances, float)
    null = np.sort(np.asarray(null_sorted if null_sorted is not None else distances, float))
    if not len(distances):
        return ([(0, token_count)] if token_count else []), []
    p_values = [
        float((1 + len(null) - np.searchsorted(null, value, side="left")) / (len(null) + 1))
        for value in distances
    ]
    q_values = _bh_fdr(p_values)
    boundaries = [index + 1 for index, q_value in enumerate(q_values) if q_value <= FDR_ALPHA]
    points = [0, *boundaries, token_count]
    segments = [(left, right) for left, right in zip(points[:-1], points[1:]) if right > left]
    evidence = [{
        "boundary": index + 1, "cosineDistance": float(value),
        "empiricalTailP": p_values[index], "bhQ": q_values[index],
        "selected": q_values[index] <= FDR_ALPHA,
    } for index, value in enumerate(distances)]
    return segments, evidence


def _pause_boundaries(timing: list[dict]) -> list[int]:
    if len(timing) < 2:
        return []
    gaps = np.asarray([
        max(0.0, float(timing[index]["spokenStartSeconds"])
            - float(timing[index - 1]["spokenEndSeconds"]))
        for index in range(1, len(timing))
    ], float)
    if not np.any(gaps > 0):
        return []
    median = float(np.median(gaps)); mad = float(np.median(np.abs(gaps - median)))
    robust_scale = max(EPS, 1.4826 * mad)
    return [index + 1 for index, gap in enumerate(gaps) if (gap - median) / robust_scale > 3.0]


def _clause_segments(tokens: list[dict], timing: list[dict]) -> tuple[list[tuple[int, int]], list[dict]]:
    boundary_reasons: dict[int, set[str]] = defaultdict(set)
    n = len(tokens)
    for index, token in enumerate(tokens):
        text = token["text"].lower()
        if any(character in PUNCTUATION_BOUNDARIES for character in text):
            boundary_reasons[min(n, index + 1)].add("punctuation")
        if text in CONJUNCTIONS and index > 0:
            boundary_reasons[index].add("conjunction")
    for boundary in _pause_boundaries(timing):
        boundary_reasons[boundary].add("pause-robust-z>3")
    boundaries = sorted(value for value in boundary_reasons if 0 < value < n)
    points = [0, *boundaries, n]
    segments = [(left, right) for left, right in zip(points[:-1], points[1:]) if right > left]
    evidence = [{"boundary": value, "reasons": sorted(boundary_reasons[value])}
                for value in boundaries]
    return segments, evidence


def _timestamp_memberships(timing: list[dict]) -> dict[tuple[int, int], list[str]]:
    memberships: dict[tuple[int, int], list[str]] = defaultdict(list)
    n = len(timing)
    for start in range(n):
        origin = float(timing[start]["spokenStartSeconds"])
        for seconds in TIMESTAMP_WINDOWS:
            end = start + 1
            while end < n and float(timing[end - 1]["spokenEndSeconds"]) - origin < seconds:
                end += 1
            covered = float(timing[end - 1]["spokenEndSeconds"]) - origin
            if covered + 1e-6 >= seconds:
                memberships[(start, end)].append(f"timestamp-{seconds:g}s")
    return memberships


def resolution_memberships(tokens: list[dict], timing: list[dict],
                           canonical_chunks: list[dict], change_segments: list[tuple[int, int]]) -> tuple[dict, dict]:
    n = len(tokens)
    clause_segments, clause_evidence = _clause_segments(tokens, timing)
    timestamp = _timestamp_memberships(timing)
    canonical = {(int(row["start"]), int(row["end"])) for row in canonical_chunks}
    clauses = set(clause_segments); changes = set(change_segments)
    output: dict[tuple[int, int], list[str]] = {}
    for start in range(n):
        for end in range(start + 1, n + 1):
            length = end - start
            values = ["deletion"]
            if start == 0 and end == n: values.append("full-hook")
            if length == 1: values.append("token")
            if length in (2, 3): values.append(f"ngram-{length}")
            for lower, upper in WINDOW_BANDS:
                if lower <= length <= upper: values.append(f"window-{lower}-{upper}")
            if start == 0: values.append("prefix")
            if end == n: values.append("suffix")
            if (start, end) in clauses: values.append("clause")
            values.extend(timestamp.get((start, end), []))
            if (start, end) in changes: values.append("change-point")
            if (start, end) in canonical: values.append("canonical")
            output[(start, end)] = values
    return output, {
        "clauseBoundaries": clause_evidence,
        "clauseSegments": [list(value) for value in clause_segments],
        "timestampDurationsSeconds": list(TIMESTAMP_WINDOWS),
        "changePointSegments": [list(value) for value in change_segments],
    }


def _candidate_status(text: str) -> tuple[str, list[str]]:
    lexical = re.findall(r"[^\W_]+(?:['’-][^\W_]+)*", text.lower(), re.UNICODE)
    reasons = []
    if not lexical: reasons.append("punctuation-only")
    elif all(value in FUNCTION_WORDS for value in lexical): reasons.append("stop-word-only")
    return ("rejected" if reasons else "accepted"), reasons


def _hash_vector(vector: np.ndarray) -> str:
    return hashlib.sha256(np.asarray(vector, np.float32).tobytes()).hexdigest()


def _project_title(vector: np.ndarray, title_manifold: dict | None) -> list[float] | None:
    values = _project_title_matrix(np.asarray(vector, np.float32)[None, :], title_manifold)
    return values[0].astype(float).tolist() if values is not None else None


def _project_title_matrix(vectors: np.ndarray,
                          title_manifold: dict | None) -> np.ndarray | None:
    if not title_manifold:
        return None
    mean = np.asarray(title_manifold.get("mean") or [], np.float32)
    components = np.asarray(title_manifold.get("components") or [], np.float32)
    scale = np.asarray(title_manifold.get("scale") or [], np.float32)
    values = np.asarray(vectors, np.float32)
    if components.ndim != 2 or values.ndim != 2 or mean.shape != values.shape[1:]:
        return None
    return ((values - mean) @ components.T / np.maximum(scale, EPS)).astype(np.float32)


def _affine_combination_coordinates(
        terms: list[tuple[np.ndarray | None, float]], norm: float,
        zero: np.ndarray | None) -> list[float] | None:
    """Project a normalized linear combination from affine source coordinates."""
    if zero is None or norm <= EPS or any(value is None for value, _ in terms):
        return None
    linear = np.zeros_like(zero)
    for value, coefficient in terms:
        linear += float(coefficient) * (np.asarray(value, np.float32) - zero)
    return (zero + linear / float(norm)).astype(float).tolist()


def _representation_map(values: np.ndarray, transform: dict, browse_basis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    coordinates = apply_category_transform(values, transform)
    points = coordinates @ browse_basis
    return coordinates, points


def _semantic_edges(nodes: list[dict], coordinates: np.ndarray, neighbors: int = 3) -> tuple[list[dict], np.ndarray]:
    if len(nodes) < 2:
        return [], np.zeros(len(nodes), np.float32)
    standardized = np.asarray(coordinates, np.float32)
    standardized = (standardized - standardized.mean(axis=0, keepdims=True)) / (
        standardized.std(axis=0, keepdims=True) + EPS
    )
    tree = cKDTree(standardized)
    distances, indices = tree.query(standardized, k=min(len(nodes), neighbors + 1))
    edges = []
    centrality = np.zeros(len(nodes), np.float32)
    seen = set()
    for source in range(len(nodes)):
        local = []
        for distance, target in zip(np.atleast_1d(distances[source]), np.atleast_1d(indices[source])):
            target = int(target)
            if target == source:
                continue
            local.append(float(distance))
            pair = tuple(sorted((source, target)))
            if pair not in seen:
                seen.add(pair)
                edges.append({
                    "type": "semantic", "source": nodes[source]["id"], "target": nodes[target]["id"],
                    "distance": float(distance),
                    "formula": "Euclidean kNN after z-scoring frozen 4D category coordinates; outcomes unused",
                })
            if len(local) >= neighbors:
                break
        centrality[source] = 1 / (1 + float(np.mean(local))) if local else 0
    return edges, centrality


def _structural_combinations(nodes: list[dict]) -> list[dict]:
    eligible = [row for row in nodes if row["candidateStatus"] == "accepted" and any(
        value in row["resolutions"] for value in ("canonical", "clause", "change-point")
    )]
    output = []
    seen = set()
    for size in (2, 3):
        for rows in combinations(eligible, size):
            spans = sorted((int(row["start"]), int(row["end"]), row["id"]) for row in rows)
            if any(spans[index][1] > spans[index + 1][0] for index in range(len(spans) - 1)):
                continue
            key = tuple(value[2] for value in spans)
            if key in seen: continue
            seen.add(key)
            output.append({
                "id": hashlib.sha256("|".join(key).encode()).hexdigest()[:20],
                "size": size, "nodeIds": list(key),
                "selection": "all non-overlapping pairs/triples among canonical, clause, and change-point segments; outcomes unused",
            })
    return output


def _outcome_edges(stored_outcome: dict | None, inference_outcomes: dict | None,
                   canonical_nodes: dict[tuple[int, int], str]) -> tuple[list[dict], list[dict]]:
    edges = []
    targets: dict[str, dict] = {}
    if stored_outcome:
        full_source = max(canonical_nodes.items(), key=lambda item: item[0][1] - item[0][0])[1]
        for name, row in (stored_outcome.get("outcomes") or {}).items():
            target_id = f"outcome:{name}"
            targets[target_id] = {"id": target_id, "type": "outcome", "name": name}
            edges.append({
                "type": "outcome", "source": full_source,
                "target": target_id, "prediction": row.get("predictedOOF"), "actual": row.get("actual"),
                "fold": row.get("fold"), "evaluationEligible": row.get("fold") is not None,
                "provenance": "stored source-held-out prediction; component selection did not use this outcome",
            })
        for component in stored_outcome.get("components") or []:
            source = canonical_nodes.get((int(component["startToken"]), int(component["endToken"])))
            if not source: continue
            for name, row in (component.get("outcomes") or {}).items():
                target_id = f"outcome:{name}"
                targets[target_id] = {"id": target_id, "type": "outcome", "name": name}
                edges.append({
                    "type": "outcome", "source": source, "target": target_id,
                    "prediction": row.get("predictedOOF"), "actual": row.get("actual"),
                    "fold": row.get("fold"), "evaluationEligible": row.get("fold") is not None,
                    "provenance": "stored source-held-out conditional component prediction",
                })
            response = component.get("forwardResponse") or {}
            if response.get("fold") is not None:
                target_id = "outcome:unexpected-forward-slope"
                targets[target_id] = {"id": target_id, "type": "outcome", "name": "unexpected-forward-slope"}
                edges.append({
                    "type": "outcome", "source": source, "target": target_id,
                    "prediction": response.get("predictedUnexpectedSlopeOOF"),
                    "actual": response.get("unexpectedObservedSlope"), "fold": response.get("fold"),
                    "evaluationEligible": True,
                    "provenance": "source-held-out forward-response prediction at the registered zero-second lag",
                })
    elif inference_outcomes:
        full = max(
            canonical_nodes.items(), key=lambda item: item[0][1] - item[0][0]
        )[1]
        for name, row in ((inference_outcomes.get("hook") or {}).items()):
            target_id = f"outcome:{name}"
            targets[target_id] = {"id": target_id, "type": "outcome", "name": name}
            edges.append({
                "type": "outcome", "source": full, "target": target_id,
                "prediction": row.get("prediction"), "actual": None, "fold": None,
                "evaluationEligible": False,
                "provenance": "new-text inference from a frozen model; no observed outcome exists for self-evaluation",
            })
    return edges, list(targets.values())


def build_component_lattice(*, text: str, tokens: list, starts: np.ndarray, ends: np.ndarray,
                            raw: np.ndarray, context: np.ndarray, influence: np.ndarray,
                            nonadditive: np.ndarray, full: np.ndarray, partition: dict,
                            partition_model: dict, timing_words: list[dict] | None = None,
                            timing_policy: str | None = None,
                            timing_metadata: dict | None = None,
                            words_per_second: float = 3.9175191560311324,
                            prefix_transition_null: np.ndarray | None = None,
                            idea_text: str | None = None, idea_vector: np.ndarray | None = None,
                            title_manifold: dict | None = None,
                            stored_outcome: dict | None = None,
                            inference_outcomes: dict | None = None,
                            source_kind: str = "live-predictor", video_id: str | None = None,
                            global_span_offset: int | None = None) -> dict:
    """Construct the exact same inspectable lattice for stored and typed hooks."""
    starts = np.asarray(starts, int); ends = np.asarray(ends, int)
    raw = _unit(raw); context = _unit(context); influence = _unit(influence); nonadditive = _unit(nonadditive)
    full = _unit(full)
    context_valid = np.linalg.norm(context, axis=1) > EPS
    nonadditive_valid = np.linalg.norm(nonadditive, axis=1) > EPS
    token_rows = [_token_dict(token) for token in tokens]
    n = len(token_rows)
    timing, timing_contract = exact_or_estimated_timing(
        token_rows, timing_words, words_per_second, timing_policy, timing_metadata,
    )
    lookup = {(int(start), int(end)): index for index, (start, end) in enumerate(zip(starts, ends))}
    expected = n * (n + 1) // 2
    if len(lookup) != expected or any((start, end) not in lookup for start in range(n) for end in range(start + 1, n + 1)):
        raise ValueError("the lattice requires every contiguous non-empty source span exactly once")

    transform = partition_model["categoryTransform"]
    browse_basis = np.asarray(partition_model["browseProjection"]["basis4x2"], np.float32)
    raw_4d, raw_2d = _representation_map(raw, transform, browse_basis)
    context_4d, context_2d = _representation_map(context, transform, browse_basis)
    influence_4d, influence_2d = _representation_map(influence, transform, browse_basis)
    nonadditive_4d, nonadditive_2d = _representation_map(nonadditive, transform, browse_basis)
    category_logp = category_log_probabilities(raw_4d, partition_model["categoryModel"])

    transition_distances = prefix_transition_distances(raw, starts, ends, n)
    changes, change_evidence = change_point_segments(transition_distances, prefix_transition_null, n)
    memberships, resolution_evidence = resolution_memberships(
        token_rows, timing, partition.get("chunks") or [], changes,
    )
    resolution_evidence["prefixChangePoints"] = change_evidence
    resolution_evidence["changePointFdrAlpha"] = FDR_ALPHA
    resolution_evidence["changePointNull"] = (
        "empirical prefix-transition distance distribution frozen from the 208-hook corpus"
        if prefix_transition_null is not None else "same-hook descriptive fallback"
    )

    idea = _unit(idea_vector) if idea_vector is not None and np.any(idea_vector) else None
    full_orthogonal = _orthogonal(full, idea)
    title_raw = _project_title_matrix(raw, title_manifold)
    title_context = _project_title_matrix(context, title_manifold)
    title_full_matrix = _project_title_matrix(full[None, :], title_manifold)
    title_idea_matrix = _project_title_matrix(idea[None, :], title_manifold) if idea is not None else None
    title_zero_matrix = _project_title_matrix(np.zeros_like(full)[None, :], title_manifold)
    title_full = title_full_matrix[0] if title_full_matrix is not None else None
    title_idea = title_idea_matrix[0] if title_idea_matrix is not None else None
    title_zero = title_zero_matrix[0] if title_zero_matrix is not None else None
    full_idea_scalar = float(full @ idea) if idea is not None else 0.0
    full_orthogonal_title = _affine_combination_coordinates(
        [(title_full, 1.0), (title_idea, -full_idea_scalar)],
        float(np.linalg.norm(full_orthogonal)), title_zero,
    ) if idea is not None else None
    nodes = []
    context_change = np.linalg.norm(full[None, :] - context, axis=1)
    max_memberships = max(len(set(value)) for value in memberships.values())
    for start in range(n):
        for end in range(start + 1, n + 1):
            index = lookup[(start, end)]
            span_text = surface(tokens, start, end, source_text=text)
            status, rejection = _candidate_status(span_text)
            before = raw[lookup[(0, start)]] if start > 0 else np.zeros_like(full)
            after = raw[lookup[(0, end)]]
            suffix = raw[lookup[(end, n)]] if end < n else np.zeros_like(full)
            marginal = full - context[index]
            component_orthogonal = _orthogonal(raw[index], context[index])
            marginal_orthogonal = _orthogonal(marginal, idea)
            prefix_transition = after - before
            probability = np.exp(category_logp[index])
            category = int(np.argmax(probability))
            title_coordinates = (
                title_raw[index].astype(float).tolist() if title_raw is not None else None
            )
            before_title = (
                title_raw[lookup[(0, start)]] if title_raw is not None and start > 0
                else title_zero
            )
            after_title = title_raw[lookup[(0, end)]] if title_raw is not None else None
            suffix_title = (
                title_raw[lookup[(end, n)]] if title_raw is not None and end < n
                else title_zero
            )
            context_scalar = float(raw[index] @ context[index]) if context_valid[index] else 0.0
            component_orthogonal_title = _affine_combination_coordinates(
                [(title_raw[index] if title_raw is not None else None, 1.0),
                 (title_context[index] if title_context is not None else None, -context_scalar)],
                float(np.linalg.norm(component_orthogonal)), title_zero,
            )
            marginal_idea_scalar = float(marginal @ idea) if idea is not None else 0.0
            marginal_orthogonal_title = _affine_combination_coordinates(
                [(title_full, 1.0),
                 (title_context[index] if title_context is not None else None, -1.0),
                 (title_idea, -marginal_idea_scalar)],
                float(np.linalg.norm(marginal_orthogonal)), title_zero,
            ) if idea is not None else None
            prefix_transition_title = _affine_combination_coordinates(
                [(after_title, 1.0), (before_title, -1.0)],
                float(np.linalg.norm(prefix_transition)), title_zero,
            )
            resolutions = memberships[(start, end)]
            timing_interval = span_timing_interval(timing, start, end)
            node_maps = {
                "raw": raw_2d[index].astype(float).tolist(),
                "context": context_2d[index].astype(float).tolist() if context_valid[index] else None,
                "influence": influence_2d[index].astype(float).tolist(),
                "nonadditive": nonadditive_2d[index].astype(float).tolist() if nonadditive_valid[index] else None,
            }
            if title_manifold:
                node_maps.update({
                    "globalTitleManifold": title_coordinates[:2] if title_coordinates else None,
                    "componentOrthogonalContext": component_orthogonal_title[:2] if component_orthogonal_title else None,
                    "fullOrthogonalIdea": full_orthogonal_title[:2] if full_orthogonal_title else None,
                    "marginalOrthogonalIdea": marginal_orthogonal_title[:2] if marginal_orthogonal_title else None,
                    "prefixBefore": before_title[:2].astype(float).tolist() if start > 0 and before_title is not None else None,
                    "prefixAfter": after_title[:2].astype(float).tolist() if after_title is not None else None,
                    "prefixTransition": prefix_transition_title[:2] if prefix_transition_title else None,
                    "suffixAfter": suffix_title[:2].astype(float).tolist() if end < n and suffix_title is not None else None,
                })
            node = {
                "id": f"span:{start}:{end}", "type": "component", "index": index,
                "globalSpanIndex": (global_span_offset + index) if global_span_offset is not None else None,
                "start": start, "end": end, "tokenCount": end - start, "text": span_text,
                "charStart": token_rows[start]["start"], "charEnd": token_rows[end - 1]["end"],
                "spokenStartSeconds": timing_interval["startSeconds"],
                "spokenEndSeconds": timing_interval["endSeconds"],
                "spokenStartBoundaryAcoustic": timing_interval[
                    "startBoundaryAcoustic"
                ],
                "spokenEndBoundaryAcoustic": timing_interval[
                    "endBoundaryAcoustic"
                ],
                "outcomeTimingEligible": timing_interval["outcomeTimingEligible"],
                "timingSource": timing_contract["source"],
                "resolutions": resolutions, "candidateStatus": status,
                "rejectionReasons": rejection,
                "category": category, "categoryProbability": float(probability[category]),
                "categoryDistribution": probability.astype(float).tolist(),
                "maps": node_maps,
                "coordinates": {
                    "rawCategory4D": raw_4d[index].astype(float).tolist(),
                    "contextCategory4D": context_4d[index].astype(float).tolist() if context_valid[index] else None,
                    "influenceCategory4D": influence_4d[index].astype(float).tolist(),
                    "nonadditiveCategory4D": nonadditive_4d[index].astype(float).tolist() if nonadditive_valid[index] else None,
                    "globalTitleManifold": title_coordinates,
                },
                "representations": {
                    "componentIsolation": {"formula": "E(S)", "vectorHash": _hash_vector(raw[index])},
                    "deletedContext": {"formula": "E(K)", "vectorHash": _hash_vector(context[index])},
                    "fullHook": {"formula": "E(H)", "vectorHash": _hash_vector(full)},
                    "contextualMarginal": {"formula": "E(H) - E(K)", "norm": float(np.linalg.norm(marginal)), "vectorHash": _hash_vector(marginal)},
                    "nonadditiveInteraction": {
                        "formula": "unit((E(H)-E(K)) - direct sum of singleton deletion effects)",
                        "norm": float(np.linalg.norm(nonadditive[index])),
                        "vectorHash": _hash_vector(nonadditive[index]),
                        "degenerate": not bool(nonadditive_valid[index]),
                    },
                    "componentOrthogonalContext": {"formula": "E(S) - proj_E(K)(E(S))", "norm": float(np.linalg.norm(component_orthogonal)), "vectorHash": _hash_vector(component_orthogonal)},
                    "fullOrthogonalIdea": {"formula": "E(H) - proj_E(I)(E(H))", "norm": float(np.linalg.norm(full_orthogonal)) if idea is not None else None, "vectorHash": _hash_vector(full_orthogonal) if idea is not None else None},
                    "marginalOrthogonalIdea": {"formula": "(E(H)-E(K)) - proj_E(I)(E(H)-E(K))", "norm": float(np.linalg.norm(marginal_orthogonal)) if idea is not None else None, "vectorHash": _hash_vector(marginal_orthogonal) if idea is not None else None},
                    "prefixBefore": {"formula": "E(H[0:a])", "vectorHash": _hash_vector(before)},
                    "prefixAfter": {"formula": "E(H[0:b])", "vectorHash": _hash_vector(after)},
                    "prefixTransition": {"formula": "E(H[0:b]) - E(H[0:a])", "norm": float(np.linalg.norm(prefix_transition)), "vectorHash": _hash_vector(prefix_transition)},
                    "suffixAfter": {"formula": "E(H[b:n])", "vectorHash": _hash_vector(suffix)},
                },
                "relations": {
                    "componentContextCosine": _cosine(raw[index], context[index]),
                    "componentContextDistance": float(np.linalg.norm(raw[index] - context[index])),
                    "componentIdeaCosine": _cosine(raw[index], idea) if idea is not None else None,
                    "contextIdeaCosine": _cosine(context[index], idea) if idea is not None else None,
                    "contextChangeNorm": float(context_change[index]),
                    "rawContextCoordinateDot4D": float(raw_4d[index] @ context_4d[index]) if context_valid[index] else None,
                    "rawMinusContextCoordinates4D": (raw_4d[index] - context_4d[index]).astype(float).tolist() if context_valid[index] else None,
                },
                "descriptiveAttention": {
                    "outcomesUsed": False, "aggregate": None,
                    "contextChangePercentileWithinHook": _percentile(context_change, context_change[index]),
                    "resolutionSupportFraction": len(set(resolutions)) / max(1, max_memberships),
                    "categoryCertainty": float(probability[category]),
                    "claimBoundary": "Separate outcome-blind descriptive channels; no weighted aggregate and no role in scoring, selection, or evaluation.",
                },
            }
            nodes.append(node)

    semantic_edges, centrality = _semantic_edges(nodes, raw_4d)
    for node, value in zip(nodes, centrality):
        node["descriptiveAttention"]["semanticCentrality"] = float(value)
        node["descriptiveAttention"]["semanticCentralityPercentileWithinHook"] = _percentile(centrality, value)

    node_lookup = {(int(node["start"]), int(node["end"])): node for node in nodes}
    edges = []
    for node in nodes:
        start = int(node["start"]); end = int(node["end"])
        for parent_span in ((start - 1, end), (start, end + 1)):
            parent = node_lookup.get(parent_span)
            if parent:
                edges.append({
                    "type": "containment", "source": parent["id"], "target": node["id"],
                    "tokenDelta": 1, "formula": "immediate one-token lattice containment",
                })
        if start + 1 < end + 1 and (start + 1, end + 1) in node_lookup:
            target = node_lookup[(start + 1, end + 1)]
            edges.append({
                "type": "sequence", "source": node["id"], "target": target["id"],
                "tokenDistance": 1,
                "temporalDistanceSeconds": float(target["spokenStartSeconds"] - node["spokenStartSeconds"]),
                "formula": "next equal-length contiguous window",
            })
    full_node = node_lookup[(0, n)]
    for node in nodes:
        if node["id"] == full_node["id"]: continue
        edges.append({
            "type": "context", "source": node["id"], "target": full_node["id"],
            "changeNorm": node["relations"]["contextChangeNorm"],
            "formula": "norm(E(H) - E(H without S))",
        })
        if idea is not None:
            edges.append({
                "type": "title", "source": node["id"], "target": "anchor:idea",
                "cosine": node["relations"]["componentIdeaCosine"],
                "formula": "cosine(E(S), E(candidate idea anchor))",
            })
    edges.extend(semantic_edges)

    canonical_nodes = {
        (int(row["start"]), int(row["end"])): node_lookup[(int(row["start"]), int(row["end"]))]["id"]
        for row in partition.get("chunks") or []
    }
    canonical_cover = np.zeros(n, np.int16)
    for start, end in canonical_nodes:
        canonical_cover[start:end] += 1
    if len(canonical_nodes) < 1 or np.any(canonical_cover != 1):
        raise ValueError("canonical partition must own every token exactly once")
    canonical_nodes[(0, n)] = full_node["id"]
    outcome_edges, outcome_nodes = _outcome_edges(stored_outcome, inference_outcomes, canonical_nodes)
    edges.extend(outcome_edges)
    anchor_nodes = ([{
        "id": "anchor:idea", "type": "idea-anchor", "text": idea_text,
        "embeddingModel": "gemini-embedding-2", "vectorHash": _hash_vector(idea),
    }] if idea is not None else [])

    rejected_empty = [{
        "id": f"empty:{boundary}", "start": boundary, "end": boundary,
        "candidateStatus": "rejected", "rejectionReasons": ["empty-span"],
    } for boundary in range(n + 1)]
    rejected_nonempty = [node["id"] for node in nodes if node["candidateStatus"] == "rejected"]
    edge_counts = {name: sum(row["type"] == name for row in edges)
                   for name in ("containment", "sequence", "semantic", "context", "title", "outcome")}
    resolution_counts = defaultdict(int)
    for node in nodes:
        for resolution in node["resolutions"]:
            resolution_counts[resolution] += 1
    source_identity_hash = hashlib.sha256(
        (LATTICE_VERSION + "\0" + text + "\0" + str(idea_text or "")).encode("utf-8")
    ).hexdigest()
    payload_digest = hashlib.sha256()
    payload_digest.update(json.dumps(_json_ready({
        "methodVersion": LATTICE_VERSION,
        "representationVersion": REPRESENTATION_VERSION,
        "text": text, "ideaText": idea_text, "partition": partition,
        "partitionModel": partition_model,
        "timing": timing, "timingPolicy": timing_policy,
        "titleManifold": title_manifold,
        "storedOutcome": stored_outcome,
        "inferenceOutcomes": inference_outcomes,
        "sourceKind": source_kind, "videoId": video_id,
    }), sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False).encode("utf-8"))
    for values in (raw, context, influence, nonadditive, full,
                   np.asarray(
                       prefix_transition_null if prefix_transition_null is not None else [],
                       np.float32,
                   )):
        array = np.asarray(values, np.float32)
        payload_digest.update(str(array.shape).encode("ascii"))
        payload_digest.update(array.tobytes())
    payload_hash = payload_digest.hexdigest()
    map_definitions = {
        "raw": {"formula": "E(S)", "basis": "frozen four-category browse plane"},
        "context": {"formula": "E(K)", "basis": "frozen four-category browse plane"},
        "influence": {"formula": "unit(E(H)-E(K))", "basis": "frozen four-category browse plane"},
        "nonadditive": {"formula": "unit((E(H)-E(K))-sum token effects)", "basis": "frozen four-category browse plane"},
    }
    if title_manifold:
        map_definitions.update({
            "globalTitleManifold": {"formula": "E(S)", "basis": "first two coordinates of the supplied title manifold"},
            "componentOrthogonalContext": {"formula": "unit(E(S)-proj_E(K)(E(S)))", "basis": "first two coordinates of the supplied title manifold"},
            "fullOrthogonalIdea": {"formula": "unit(E(H)-proj_E(I)(E(H)))", "basis": "first two coordinates of the supplied title manifold"},
            "marginalOrthogonalIdea": {"formula": "unit((E(H)-E(K))-proj_E(I)(E(H)-E(K)))", "basis": "first two coordinates of the supplied title manifold"},
            "prefixBefore": {"formula": "E(H[0:a])", "basis": "first two coordinates of the supplied title manifold"},
            "prefixAfter": {"formula": "E(H[0:b])", "basis": "first two coordinates of the supplied title manifold"},
            "prefixTransition": {"formula": "unit(E(H[0:b])-E(H[0:a]))", "basis": "first two coordinates of the supplied title manifold"},
            "suffixAfter": {"formula": "E(H[b:n])", "basis": "first two coordinates of the supplied title manifold"},
        })
    return {
        "version": 1, "status": "complete", "methodVersion": LATTICE_VERSION,
        "id": payload_hash[:20], "contentHash": payload_hash,
        "sourceIdentityHash": source_identity_hash,
        "sourceKind": source_kind, "videoId": video_id, "text": text,
        "ideaAnchor": {
            "text": idea_text, "present": idea is not None,
            "role": "candidate idea/title relation only; never assumed to be ground-truth idea",
        },
        "tokenCount": n, "spanCount": len(nodes), "expectedContiguousSpanCount": expected,
        "tokens": timing, "timingContract": timing_contract,
        "resolutionDefinitions": RESOLUTION_DEFINITIONS,
        "mapDefinitions": map_definitions,
        "resolutionCounts": dict(sorted(resolution_counts.items())),
        "resolutionEvidence": resolution_evidence,
        "rejectedCandidates": {
            "empty": rejected_empty, "nonemptyNodeIds": rejected_nonempty,
            "total": len(rejected_empty) + len(rejected_nonempty),
            "policy": "retained with deterministic reason; never silently filtered",
        },
        "nodes": nodes, "anchorNodes": anchor_nodes, "outcomeNodes": outcome_nodes,
        "edges": edges, "edgeCounts": edge_counts,
        "selectedCombinations": _structural_combinations(nodes),
        "partitionContract": {
            "candidateNodes": len(nodes),
            "canonicalComponentNodeIds": [
                node_lookup[(int(row["start"]), int(row["end"]))]["id"]
                for row in partition.get("chunks") or []
            ],
            "canonicalComponentCount": len(partition.get("chunks") or []),
            "tokenOwnership": canonical_cover.astype(int).tolist(),
            "exactNonoverlappingCover": True,
            "selectionUsesOutcomes": False,
            "selectionMode": partition.get("boundaryEvidenceMode") or (
                "frozen serving ensemble over outcome-blind boundary evidence"
                if source_kind == "live-predictor" else
                "stored outcome-blind canonical partition"
            ),
            "scoringRole": (
                "The predictor builds the exhaustive lattice first, then scores the full hook "
                "and this exact non-overlapping partition. Overlapping lattice nodes remain "
                "visible analysis candidates and are not double-counted in the headline score."
            ),
        },
        "representationContract": {
            "embeddingModel": "gemini-embedding-2", "embeddingDimensions": int(raw.shape[1]),
            "representationVersion": REPRESENTATION_VERSION,
            "nonadditiveFormula": (
                "unit((E(H)-E(K)) - direct ordered sum of singleton deletion effects)"
            ),
            "singletonNonadditiveInvariant": "exact zero before storage quantization",
            "sourceEmbeddingsUntouched": True,
            "vectorsInPayload": False,
            "vectorAccess": "content hashes and all-span row references; browser plots frozen 2D/4D coordinates without duplicating 1536D vectors",
            "allRequiredFamiliesPresent": True,
        },
        "graphContract": {
            "outcomeUsedForNodes": False, "outcomeUsedForContainment": False,
            "outcomeUsedForSequence": False, "outcomeUsedForSemanticEdges": False,
            "outcomeUsedForContextEdges": False, "outcomeUsedForTitleEdges": False,
            "outcomeEdgePolicy": "stored edges require a source-held-out fold; live edges are inference-only and evaluation-ineligible",
            "descriptiveAttentionUsedForScore": False,
        },
        "parityContract": {
            "sharedBuilder": "component_lattice.build_component_lattice",
            "corpusAndPredictorShareCode": True,
            "allowedDifferences": ["exact stored timing versus estimated live timing", "stored OOF evaluation versus live inference", "optional candidate idea anchor"],
        },
    }
