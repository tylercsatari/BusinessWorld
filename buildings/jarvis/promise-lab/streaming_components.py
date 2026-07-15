"""Bounded-work streaming decomposition with the frozen Promise Lab models.

The source text, token owners, and returned components are necessarily linear in
the input length.  Transient embedding and decoder state is bounded by measured
hook support; this module never materializes or embeds the global all-span
lattice.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from atlas import span_additive_effects
from canonical_partition import (
    BOUNDARY_FEATURE_NAMES,
    boundary_features,
    boundary_probabilities,
)
from hook_score_core import (
    apply_category_transform,
    category_log_probabilities,
    decode_support_calibrated_chunks,
    row_unit,
)
from sequence import normalize_source, surface, tokenize, without_span


STREAMING_COMPONENT_VERSION = "bounded-streaming-components-v1"
CATEGORY_COUNT = 4


def _lexical(token: Any) -> bool:
    return any(character.isalnum() or character == "_" for character in token.text)


def _stored_raw(vector: np.ndarray) -> np.ndarray:
    source = row_unit(np.asarray(vector, np.float32))
    return row_unit(np.asarray(source, np.float16).astype(np.float32))


def _embedding_batch(store: Any, texts: list[str], work: dict, kind: str) -> dict:
    ordered = list(dict.fromkeys(str(text) for text in texts if str(text)))
    if not ordered:
        return {}
    work["embeddingCalls"] += 1
    work["embeddingInputRequests"] += len(ordered)
    work["peakEmbeddingBatchInputs"] = max(
        work["peakEmbeddingBatchInputs"], len(ordered),
    )
    work[kind] += len(ordered)
    vectors = store.embed_many(ordered)
    missing = [text for text in ordered if text not in vectors]
    if missing:
        raise RuntimeError(f"embedding store omitted {len(missing)} requested inputs")
    return vectors


def _boundary_intervals(token_count: int) -> list[tuple[int, int]]:
    intervals = {(0, token_count)}
    intervals.update((index, index + 1) for index in range(token_count))
    intervals.update((0, boundary) for boundary in range(1, token_count))
    intervals.update((boundary, token_count) for boundary in range(1, token_count))
    return sorted(intervals)


def _boundary_evidence(window_text: str, store: Any, work: dict) -> dict:
    """Reproduce the frozen boundary features without the all-span lattice."""
    window_text = normalize_source(window_text)
    tokens = tokenize(window_text)
    token_count = len(tokens)
    if token_count < 1:
        raise ValueError("a streaming block needs at least one token")

    intervals = _boundary_intervals(token_count)
    span_text = {
        interval: surface(tokens, *interval, source_text=window_text)
        for interval in intervals
    }
    context_text = {
        interval: without_span(tokens, *interval, source_text=window_text)
        for interval in intervals
    }
    required = [
        window_text,
        *[span_text[interval] for interval in intervals],
        *[context_text[interval] for interval in intervals if context_text[interval]],
    ]
    vectors = _embedding_batch(
        store, required, work, "boundaryEvidenceInputRequests",
    )

    full_source = row_unit(vectors[window_text])
    stored_full = np.asarray(full_source, np.float16).astype(np.float32)
    raw_source = np.asarray([
        row_unit(vectors[span_text[interval]]) for interval in intervals
    ], np.float32)
    context_source = np.asarray([
        row_unit(vectors[context_text[interval]])
        if context_text[interval] else np.zeros_like(full_source)
        for interval in intervals
    ], np.float32)
    stored_raw = np.asarray(raw_source, np.float16).astype(np.float32)
    stored_context = np.asarray(context_source, np.float16).astype(np.float32)

    starts = np.asarray([start for start, _ in intervals], int)
    ends = np.asarray([end for _, end in intervals], int)
    lookup = {interval: index for index, interval in enumerate(intervals)}
    influence_source = row_unit(stored_full[None, :] - stored_context)
    token_effects = np.asarray([
        stored_full - stored_context[lookup[(index, index + 1)]]
        for index in range(token_count)
    ], np.float32)
    additive = span_additive_effects(token_effects, starts, ends)
    nonadditive_source = row_unit(
        (stored_full[None, :] - stored_context) - additive,
    )

    raw = row_unit(stored_raw)
    context = row_unit(stored_context)
    influence = row_unit(
        np.asarray(influence_source, np.float16).astype(np.float32),
    )
    nonadditive = row_unit(
        np.asarray(nonadditive_source, np.float16).astype(np.float32),
    )
    full = row_unit(stored_full)
    if token_count == 1:
        probabilities = np.empty(0, np.float32)
    else:
        features = boundary_features(
            full, raw, context, influence, nonadditive, starts, ends,
            np.zeros((len(intervals), CATEGORY_COUNT), np.float32),
        )
        probabilities = boundary_probabilities(features, work["boundaryModel"])
    work["maximumBoundaryEvidenceRows"] = max(
        work["maximumBoundaryEvidenceRows"], len(intervals),
    )
    return {
        "text": window_text,
        "tokens": tokens,
        "intervals": intervals,
        "spanTexts": span_text,
        "rawByInterval": {
            interval: raw[index] for index, interval in enumerate(intervals)
        },
        "contextByInterval": {
            interval: context[index] for index, interval in enumerate(intervals)
        },
        "fullVector": full,
        "probabilities": probabilities,
        "inputCount": len(set(value for value in required if value)),
    }


def _candidate_spans(token_count: int, maximum_span: int) -> tuple[np.ndarray, np.ndarray]:
    pairs = [
        (start, end)
        for start in range(token_count)
        for end in range(start + 1, min(token_count, start + maximum_span) + 1)
    ]
    return (
        np.asarray([start for start, _ in pairs], int),
        np.asarray([end for _, end in pairs], int),
    )


def _assign_categories(selected: list[tuple[int, int]], evidence: dict,
                       store: Any, partition_model: dict, work: dict) -> dict:
    """Apply the unchanged four-category model after boundaries are frozen."""
    raw_by_interval = dict(evidence["rawByInterval"])
    missing = [interval for interval in selected if interval not in raw_by_interval]
    missing_text = {
        interval: surface(
            evidence["tokens"], *interval, source_text=evidence["text"],
        )
        for interval in missing
    }
    vectors = _embedding_batch(
        store, list(missing_text.values()), work, "selectedCategoryInputRequests",
    )
    for interval in missing:
        raw_by_interval[interval] = _stored_raw(vectors[missing_text[interval]])

    context_by_interval = dict(evidence["contextByInterval"])
    missing_context = [
        interval for interval in selected if interval not in context_by_interval
    ]
    missing_context_text = {
        interval: without_span(
            evidence["tokens"], *interval, source_text=evidence["text"],
        )
        for interval in missing_context
    }
    context_vectors = _embedding_batch(
        store,
        [value for value in missing_context_text.values() if value],
        work,
        "selectedContextInputRequests",
    )
    for interval in missing_context:
        value = missing_context_text[interval]
        context_by_interval[interval] = (
            _stored_raw(context_vectors[value])
            if value else np.zeros_like(evidence["fullVector"])
        )

    # The frozen transform subtracts a source-level span mean.  Use the complete
    # bounded boundary-evidence population plus any selected interior spans, with
    # no additional category-only lattice expansion.
    reference_intervals = sorted(set(evidence["intervals"]) | set(selected))
    reference_raw = np.asarray([
        raw_by_interval[interval] for interval in reference_intervals
    ], np.float32)
    values = apply_category_transform(
        reference_raw, partition_model["categoryTransform"],
    )
    logp = category_log_probabilities(values, partition_model["categoryModel"])
    basis = np.asarray(
        (partition_model.get("browseProjection") or {}).get("basis4x2") or [],
        np.float32,
    )
    if basis.shape != (CATEGORY_COUNT, 2):
        raise RuntimeError("canonical semantic browse projection is unavailable")
    points = values @ basis
    lookup = {interval: index for index, interval in enumerate(reference_intervals)}
    work["maximumCategoryReferenceRows"] = max(
        work["maximumCategoryReferenceRows"], len(reference_intervals),
    )
    return {
        interval: {
            "category": int(np.argmax(logp[lookup[interval]])),
            "distribution": np.exp(logp[lookup[interval]]).astype(float),
            "coordinates": values[lookup[interval]].astype(float),
            "point": points[lookup[interval]].astype(float),
            "raw": row_unit(raw_by_interval[interval]).astype(np.float32),
            "influence": row_unit(
                np.asarray(evidence["fullVector"], np.float32)
                - np.asarray(context_by_interval[interval], np.float32)
            ).astype(np.float32),
        }
        for interval in selected
    }


def _support_contract(horizon_extension: dict,
                      measured_token_support: dict | None) -> tuple[dict, dict]:
    envelope = dict(horizon_extension or {})
    extension = dict(envelope.get("partitionExtension") or envelope)
    support = dict(
        measured_token_support
        or envelope.get("lengthSupport")
        or extension.get("lengthSupport")
        or {}
    )
    maximum_component = int(extension.get("maximumObservedComponentTokens") or 0)
    if maximum_component < 1:
        raise ValueError("measured maximum component-token support is required")
    maximum_block = int(
        support.get("fullHookTokenMaximum")
        or support.get("tokenCountMaximum")
        or maximum_component
    )
    minimum_block = int(
        support.get("fullHookTokenMinimum")
        or support.get("tokenCountMinimum")
        or min(
            (int(row["tokens"]) for row in extension.get("componentLengthDistribution") or []),
            default=1,
        )
    )
    if maximum_block < 1 or minimum_block < 1 or minimum_block > maximum_block:
        raise ValueError("measured full-hook token support is inconsistent")
    return extension, {
        "fullHookTokenMinimum": minimum_block,
        "fullHookTokenMaximum": maximum_block,
        "maximumObservedComponentTokens": maximum_component,
        "causalFixedWindow": bool(support.get("causalFixedWindow")),
        "source": support.get("source") or (
            "maximum observed component tokens fallback"
            if not support else "provided measured token support"
        ),
    }


def _validate_frozen_model(partition_model: dict) -> None:
    clusters = (partition_model.get("categoryModel") or {}).get("clusters") or []
    if len(clusters) != CATEGORY_COUNT:
        raise ValueError("streaming decomposition requires the frozen four-category model")
    feature_names = tuple(
        (partition_model.get("boundaryModel") or {}).get("featureNames")
        or BOUNDARY_FEATURE_NAMES
    )
    if feature_names != tuple(BOUNDARY_FEATURE_NAMES):
        raise ValueError("boundary model feature contract does not match the frozen model")


def _choose_cut(cursor: int, token_count: int, window_count: int,
                lookahead: int, probabilities: np.ndarray,
                lexical_prefix: np.ndarray) -> tuple[int, dict]:
    first = max(1, window_count - lookahead)
    last = window_count - 1
    candidates = []
    for local_cut in range(first, last + 1):
        global_cut = cursor + local_cut
        left_lexical = int(lexical_prefix[global_cut] - lexical_prefix[cursor]) > 0
        right_lexical = int(lexical_prefix[token_count] - lexical_prefix[global_cut]) > 0
        if left_lexical and right_lexical:
            candidates.append({
                "localTokenGap": local_cut,
                "globalTokenGap": global_cut,
                "posterior": float(probabilities[local_cut - 1]),
            })
    if not candidates:
        raise ValueError(
            "no posterior-selected measured-support block cut preserves lexical coverage",
        )
    selected = max(
        candidates, key=lambda row: (row["posterior"], row["localTokenGap"]),
    )
    return int(selected["localTokenGap"]), {
        "kind": "posterior-selected",
        "policy": "maximum frozen boundary posterior in the measured-support trailing band",
        "tieBreak": "later token gap",
        "candidateLocalStart": first,
        "candidateLocalEnd": last,
        "selectedLocalTokenGap": int(selected["localTokenGap"]),
        "selectedGlobalTokenGap": int(selected["globalTokenGap"]),
        "selectedPosterior": float(selected["posterior"]),
        "candidates": candidates,
    }


def _fixed_causal_cut(cursor: int, token_count: int, window_count: int,
                      probabilities: np.ndarray,
                      lexical_prefix: np.ndarray) -> tuple[int, dict]:
    """End at the measured window unless that strands punctuation at input end."""
    default_end = cursor + window_count
    suffix_lexical = int(
        lexical_prefix[token_count] - lexical_prefix[default_end]
    )
    if default_end == token_count or suffix_lexical > 0:
        return window_count, {
            "kind": (
                "input-end" if default_end == token_count
                else "measured-causal-window-end"
            ),
            "policy": (
                "the final measured-support window ends at the input boundary"
                if default_end == token_count else
                "non-overlapping causal window sized by measured minimum hook support"
            ),
            "selectedLocalTokenGap": window_count,
            "selectedGlobalTokenGap": default_end,
            "selectedPosterior": None,
            "candidates": [],
        }

    # The default cut would leave only punctuation. Move the latest possible
    # lexical token into the suffix so both exact-cover blocks remain lexical.
    candidates = []
    for local_cut in range(1, window_count):
        global_cut = cursor + local_cut
        left_lexical = int(
            lexical_prefix[global_cut] - lexical_prefix[cursor]
        ) > 0
        right_lexical = int(
            lexical_prefix[token_count] - lexical_prefix[global_cut]
        ) > 0
        if left_lexical and right_lexical:
            candidates.append({
                "localTokenGap": local_cut,
                "globalTokenGap": global_cut,
                "posterior": float(probabilities[local_cut - 1]),
            })
    if not candidates:
        raise ValueError(
            "no fixed causal block cut preserves lexical coverage at input end",
        )
    selected = max(candidates, key=lambda row: row["localTokenGap"])
    return int(selected["localTokenGap"]), {
        "kind": "lexical-tail-preserving-causal-cut",
        "policy": (
            "latest outcome-blind cut that moves a lexical token into an otherwise "
            "punctuation-only final block"
        ),
        "tieBreak": "latest valid token gap",
        "selectedLocalTokenGap": int(selected["localTokenGap"]),
        "selectedGlobalTokenGap": int(selected["globalTokenGap"]),
        "selectedPosterior": float(selected["posterior"]),
        "candidates": candidates,
    }


def _lightweight_graph(blocks: list[dict], chunks: list[dict]) -> dict:
    nodes = [
        {"id": f"category:{category}", "type": "category", "category": category}
        for category in range(CATEGORY_COUNT)
    ]
    nodes.extend({
        "id": f"block:{block['index']}", "type": "block",
        "startToken": block["startToken"], "endToken": block["endToken"],
    } for block in blocks)
    nodes.extend({
        "id": f"component:{chunk['index']}", "type": "component",
        "startToken": chunk["start"], "endToken": chunk["end"],
        "category": chunk["category"],
    } for chunk in chunks)
    edges = []
    for chunk in chunks:
        edges.extend([
            {"source": f"block:{chunk['blockIndex']}",
             "target": f"component:{chunk['index']}", "type": "contains"},
            {"source": f"component:{chunk['index']}",
             "target": f"category:{chunk['category']}", "type": "assigned-category"},
        ])
    edges.extend({
        "source": f"component:{left['index']}",
        "target": f"component:{right['index']}", "type": "next",
        "transition": f"{left['category']}->{right['category']}",
        "semanticSimilarity": right.get("viewerContext", {}).get(
            "predecessorSemanticSimilarity"
        ),
    } for left, right in zip(chunks, chunks[1:]))
    for left, right in zip(blocks, blocks[1:]):
        edges.append({
            "source": f"block:{left['index']}",
            "target": f"block:{right['index']}",
            "type": "posterior-cut",
            "tokenGap": left["cut"]["selectedGlobalTokenGap"],
            "posterior": left["cut"]["selectedPosterior"],
        })
    return {
        "version": "streaming-component-graph-v1",
        "directed": True,
        "nodes": nodes,
        "edges": edges,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
    }


def attach_viewer_context(chunks: list[dict]) -> list[dict]:
    """Attach the accumulated, strictly prior information state in place."""
    category_counts = np.zeros(CATEGORY_COUNT, np.float32)
    history_raw = []
    for index, chunk in enumerate(chunks):
        raw = row_unit(np.asarray(chunk["_rawVector"], np.float32))
        predecessor = chunks[index - 1] if index else None
        predecessor_raw = (
            row_unit(np.asarray(predecessor["_rawVector"], np.float32))
            if predecessor is not None else None
        )
        history_mean = (
            row_unit(np.mean(np.asarray(history_raw, np.float32), axis=0))
            if history_raw else None
        )
        seen = float(category_counts.sum())
        chunk["viewerContext"] = {
            "definition": "information state formed only by components delivered earlier",
            "position": int(index),
            "predecessorComponentIndex": (
                int(predecessor["index"]) if predecessor is not None else None
            ),
            "predecessorCategory": (
                int(predecessor["category"]) if predecessor is not None else None
            ),
            "transition": (
                f"{predecessor['category']}->{chunk['category']}"
                if predecessor is not None else f"START->{chunk['category']}"
            ),
            "componentsPreviouslyDelivered": int(index),
            "categoryCountsBefore": category_counts.astype(int).tolist(),
            "categoryDistributionBefore": (
                (category_counts / seen).astype(float).tolist()
                if seen else [0.0] * CATEGORY_COUNT
            ),
            "predecessorSemanticSimilarity": (
                float(raw @ predecessor_raw) if predecessor_raw is not None else None
            ),
            "historySemanticSimilarity": (
                float(raw @ history_mean) if history_mean is not None else None
            ),
            "historySemanticChange": (
                float(1.0 - raw @ history_mean) if history_mean is not None else None
            ),
            "usesFutureComponents": False,
            "externalIdeaContextUsed": False,
        }
        history_raw.append(raw)
        category_counts[int(chunk["category"])] += 1.0
    return chunks


def build_streaming_components(text: str, store: Any, partition_model: dict,
                               horizon_extension: dict,
                               measured_token_support: dict | None = None) -> dict:
    """Build one exact cover with bounded embedding and decoder working sets.

    ``horizon_extension`` may be the partition extension itself or an opening
    model containing ``partitionExtension`` and ``lengthSupport``.
    """
    _validate_frozen_model(partition_model)
    extension, support = _support_contract(
        horizon_extension, measured_token_support,
    )
    source_text = normalize_source(text)
    tokens = tokenize(source_text)
    token_count = len(tokens)
    lexical = np.asarray([_lexical(token) for token in tokens], bool)
    if token_count < 1 or not lexical.any():
        raise ValueError("an opening needs at least one lexical atom")

    block_limit = int(support["fullHookTokenMaximum"])
    if token_count > 1 and block_limit < 2:
        raise ValueError("measured support has no boundary-bearing block")
    lookahead = min(
        max(1, int(support["fullHookTokenMinimum"])),
        max(1, block_limit - 1),
    )
    maximum_component = int(support["maximumObservedComponentTokens"])
    work = {
        "boundaryModel": partition_model["boundaryModel"],
        "embeddingCalls": 0,
        "embeddingInputRequests": 0,
        "boundaryEvidenceInputRequests": 0,
        "selectedCategoryInputRequests": 0,
        "selectedContextInputRequests": 0,
        "peakEmbeddingBatchInputs": 0,
        "maximumBoundaryEvidenceRows": 0,
        "maximumCategoryReferenceRows": 0,
        "maximumCandidateSpanRows": 0,
        "totalCandidateSpanRows": 0,
    }
    lexical_prefix = np.concatenate([[0], np.cumsum(lexical.astype(int))])
    owners = np.full(token_count, -1, int)
    owner_counts = np.zeros(token_count, int)
    chunks = []
    blocks = []
    cut_by_gap = {}
    cursor = 0

    while cursor < token_count:
        window_end = min(token_count, cursor + block_limit)
        window_text = surface(tokens, cursor, window_end, source_text=source_text)
        evidence = _boundary_evidence(window_text, store, work)
        window_count = window_end - cursor
        fixed_causal_window = bool(support.get("causalFixedWindow"))
        if fixed_causal_window:
            commit_count, cut = _fixed_causal_cut(
                cursor, token_count, window_count,
                evidence["probabilities"], lexical_prefix,
            )
            if cut["kind"] == "lexical-tail-preserving-causal-cut":
                cut_by_gap[cursor + commit_count] = cut
        elif window_end == token_count:
            commit_count = window_count
            cut = {
                "kind": "input-end",
                "policy": "the final measured-support window ends at the input boundary",
                "selectedLocalTokenGap": commit_count,
                "selectedGlobalTokenGap": cursor + commit_count,
                "selectedPosterior": None,
                "candidates": [],
            }
        else:
            commit_count, cut = _choose_cut(
                cursor, token_count, window_count, lookahead,
                evidence["probabilities"], lexical_prefix,
            )
            cut_by_gap[cursor + commit_count] = cut

        block_end = cursor + commit_count
        starts, ends = _candidate_spans(commit_count, maximum_component)
        work["maximumCandidateSpanRows"] = max(
            work["maximumCandidateSpanRows"], len(starts),
        )
        work["totalCandidateSpanRows"] += len(starts)
        dummy_logp = np.full(
            (len(starts), CATEGORY_COUNT), np.log(1 / CATEGORY_COUNT), np.float32,
        )
        block_probabilities = np.asarray(
            evidence["probabilities"][:max(0, commit_count - 1)], np.float32,
        )
        decoded = decode_support_calibrated_chunks(
            starts, ends, block_probabilities, dummy_logp,
            lexical[cursor:block_end], extension,
        )
        selected = [
            (int(chunk["start"]), int(chunk["end"]))
            for chunk in decoded["chunks"]
        ]
        categories = _assign_categories(
            selected, evidence, store, partition_model, work,
        )
        block_component_indices = []
        for local_chunk in decoded["chunks"]:
            local_start = int(local_chunk["start"])
            local_end = int(local_chunk["end"])
            global_start = cursor + local_start
            global_end = cursor + local_end
            interval = (local_start, local_end)
            category = categories[interval]
            index = len(chunks)
            if owner_counts[global_start:global_end].any():
                raise RuntimeError("streaming decoder produced overlapping components")
            owner_counts[global_start:global_end] += 1
            owners[global_start:global_end] = index
            left_cut = cut_by_gap.get(global_start)
            right_cut = cut_by_gap.get(global_end)
            left_probability = (
                float(block_probabilities[local_start - 1]) if local_start > 0
                else None if global_start == 0 or left_cut is None
                or left_cut.get("selectedPosterior") is None
                else float(left_cut["selectedPosterior"])
            )
            right_probability = (
                float(block_probabilities[local_end - 1]) if local_end < commit_count
                else None if global_end == token_count or right_cut is None
                or right_cut.get("selectedPosterior") is None
                else float(right_cut["selectedPosterior"])
            )
            distribution = category["distribution"]
            chunks.append({
                "index": index,
                "blockIndex": len(blocks),
                "start": global_start,
                "end": global_end,
                "text": surface(tokens, global_start, global_end, source_text=source_text),
                "category": int(category["category"]),
                "categoryProbability": float(distribution[category["category"]]),
                "categoryDistribution": distribution.tolist(),
                "categoryCoordinates4D": category["coordinates"].tolist(),
                "mapX": float(category["point"][0]),
                "mapY": float(category["point"][1]),
                "categorySource": (
                    "unchanged frozen four-category transform and Gaussian assignment "
                    "after boundary selection"
                ),
                "_rawVector": category["raw"].astype(float).tolist(),
                "_influenceVector": category["influence"].astype(float).tolist(),
                "leftBoundaryProbability": left_probability,
                "rightBoundaryProbability": right_probability,
                "leftBoundarySource": (
                    "input edge" if global_start == 0 else
                    "posterior-selected block cut" if local_start == 0 else
                    "frozen boundary model"
                ),
                "rightBoundarySource": (
                    "input edge" if global_end == token_count else
                    "posterior-selected block cut" if local_end == commit_count else
                    "frozen boundary model"
                ),
            })
            block_component_indices.append(index)

        blocks.append({
            "index": len(blocks),
            "startToken": cursor,
            "endToken": block_end,
            "tokenCount": commit_count,
            "evidenceWindowStartToken": cursor,
            "evidenceWindowEndToken": window_end,
            "evidenceWindowTokenCount": window_count,
            "boundaryPosteriors": block_probabilities.astype(float).tolist(),
            "boundaryEvidenceSpanRows": len(evidence["intervals"]),
            "boundaryEvidenceEmbeddingInputs": evidence["inputCount"],
            "componentIndices": block_component_indices,
            "cut": cut,
            "decoder": {
                "name": "decode_support_calibrated_chunks",
                "score": decoded.get("score"),
                "runnerUpScore": decoded.get("runnerUpScore"),
                "scoreGap": decoded.get("scoreGap"),
                "componentCount": decoded["componentCount"],
                "partitionsCompared": decoded.get("partitionsCompared"),
                "selectedCountBoundaryPosteriorProbability": decoded.get(
                    "selectedCountBoundaryPosteriorProbability",
                ),
                "countPrior": decoded.get("countPrior"),
                "maximumComponentTokens": decoded.get("maximumComponentTokens"),
            },
        })
        cursor = block_end

    if not np.all(owner_counts == 1) or (owners < 0).any():
        raise RuntimeError("streaming decoder did not produce one exact owner per token")
    if any(not lexical[chunk["start"]:chunk["end"]].any() for chunk in chunks):
        raise RuntimeError("streaming decoder produced a punctuation-only component")

    attach_viewer_context(chunks)

    del work["boundaryModel"]
    work.update({
        "blockCount": len(blocks),
        "blockTokenLimit": block_limit,
        "cutLookaheadTokens": lookahead,
        "fixedCausalWindows": bool(support.get("causalFixedWindow")),
        "maximumComponentTokens": maximum_component,
        "embeddingBatchInputBound": 4 * block_limit,
        "candidateSpanRowBound": block_limit * min(block_limit, maximum_component),
        "globalAllSpanRowsMaterialized": False,
        "transientMemoryContract": (
            "embedding batches are O(measured block support); decoder rows are "
            "O(measured block support x measured component support)"
        ),
    })
    graph = _lightweight_graph(blocks, chunks)
    return {
        "version": STREAMING_COMPONENT_VERSION,
        "text": source_text,
        "tokenCount": token_count,
        "categoryCount": CATEGORY_COUNT,
        "frozenModel": {
            "methodVersion": partition_model.get("methodVersion"),
            "mapId": partition_model.get("mapId"),
            "categoryCount": CATEGORY_COUNT,
            "categoryParametersChanged": False,
            "boundaryParametersChanged": False,
        },
        "support": support,
        "blocks": blocks,
        "chunks": chunks,
        "componentCount": len(chunks),
        "owners": owners.tolist(),
        "coverage": 1.0,
        "overlapCount": 0,
        "graph": graph,
        "work": work,
        "provenance": {
            "boundaryDecoder": "hook_score_core.decode_support_calibrated_chunks",
            "boundaryFeatureNames": list(BOUNDARY_FEATURE_NAMES),
            "boundarySelectionUsesCategories": False,
            "boundarySelectionUsesOutcomes": False,
            "boundaryEvidence": (
                "full, every prefix, every suffix, every singleton, and their "
                "required deletion contexts"
            ),
            "blockCutPolicy": (
                "non-overlapping windows sized by measured minimum hook support"
                if support.get("causalFixedWindow") else
                "highest frozen boundary posterior in a trailing band derived from "
                "measured minimum and maximum hook-token support"
            ),
            "categoryEmbeddingPolicy": (
                "embed selected spans only after boundaries are fixed; reuse boundary "
                "evidence vectors when the selected span is already present"
            ),
            "categoryReferencePopulation": (
                "bounded boundary-evidence spans plus selected component spans"
            ),
            "exactNonoverlappingCover": True,
        },
    }


stream_components = build_streaming_components
