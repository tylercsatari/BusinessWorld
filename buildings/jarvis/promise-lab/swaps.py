"""Discovered-family consensus routing and crossed swap decomposition."""

from __future__ import annotations

from collections import defaultdict

import numpy as np

from sequence import replace_span, tokenize


EPS = 1e-9


def map_weight(row: dict) -> float:
    # Every retained map contributes. The weight uses only outcome-blind atlas
    # quality and is stored beside each routing decision.
    return max(0.0, float(row.get("qualityForBrowsing") or 0.0)) + EPS


def consensus_matrix(maps: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    labels = np.asarray([row["labels"] for row in maps], np.int16)
    weights = np.asarray([map_weight(row) for row in maps], float)
    weights /= weights.sum()
    return labels, weights


def coassociation_rows(labels: np.ndarray, weights: np.ndarray, source_indices: list[int],
                       progress=None) -> np.ndarray:
    """Accumulate exact weighted co-association for every source against every candidate."""
    source_indices = np.asarray(source_indices, int)
    output = np.zeros((len(source_indices), labels.shape[1]), np.float32)
    for map_index, (assignment, weight) in enumerate(zip(labels, weights), 1):
        source_assignment = assignment[source_indices]
        for cluster in np.unique(assignment):
            source_positions = np.flatnonzero(source_assignment == cluster)
            candidate_positions = np.flatnonzero(assignment == cluster)
            if len(source_positions) and len(candidate_positions):
                output[np.ix_(source_positions, candidate_positions)] += float(weight)
        if progress:
            progress({"routingMapsComplete": map_index, "routingMapsTotal": len(labels)})
    return output


def choose_target(source_index: int, target_indices: list[int], coassociation_row: np.ndarray,
                  influence: np.ndarray) -> tuple[int, float, float]:
    target = np.asarray(target_indices, int)
    if len(target) == 0:
        raise ValueError("target hook has no exploratory component candidates")
    coassociation = coassociation_row[target]
    source_vector = influence[source_index]
    cosine = influence[target] @ source_vector / (
        (np.linalg.norm(influence[target], axis=1) + EPS) * (np.linalg.norm(source_vector) + EPS)
    )
    order = np.lexsort((-cosine, -coassociation))
    selected_position = int(order[0])
    return int(target[selected_position]), float(coassociation[selected_position]), float(cosine[selected_position])


def build_swap_plan(candidates: list[dict], maps: list[dict], influence: np.ndarray,
                    progress=None) -> list[dict]:
    labels, weights = consensus_matrix(maps)
    exploratory = [index for index, row in enumerate(candidates) if row.get("selectedExploratory")]
    by_video = defaultdict(list)
    for index in exploratory:
        by_video[candidates[index]["videoId"]].append(index)
    target_videos = sorted(by_video)
    coassociation_table = coassociation_rows(labels, weights, exploratory, progress)
    rows = []
    for source_position, source_index in enumerate(exploratory):
        source = candidates[source_index]
        for target_video in target_videos:
            target_index, coassociation_score, cosine = choose_target(
                source_index, by_video[target_video], coassociation_table[source_position], influence
            )
            target = candidates[target_index]
            recomposed = replace_span(
                tokenize(target["hookText"]), target["start"], target["end"], source["text"],
                source_text=target["hookText"],
            )
            rows.append({
                "sourceIndex": source_index,
                "sourceId": source["id"],
                "sourceVideoId": source["videoId"],
                "sourceText": source["text"],
                "targetIndex": target_index,
                "targetId": target["id"],
                "targetVideoId": target_video,
                "targetText": target["text"],
                "targetHookText": target["hookText"],
                "recomposedText": recomposed,
                "atlasCoassociation": coassociation_score,
                "influenceCosine": cosine,
                "mapsContributing": len(maps),
                "identity": source["id"] == target["id"],
                "routingUsesOutcomes": False,
            })
        if progress and (source_position + 1 == len(exploratory) or (source_position + 1) % 25 == 0):
            progress({"routingSourcesComplete": source_position + 1,
                      "routingSourcesTotal": len(exploratory)})
    return rows


def build_dual_scope_swap_plan(candidates: list[dict], candidate_maps: list[dict],
                               candidate_influence: np.ndarray, spans: list[dict],
                               all_span_maps: list[dict], all_span_influence: np.ndarray,
                               progress=None) -> list[dict]:
    """Route selected sources into every span using two independent atlas scopes.

    Candidate-atlas consensus is available only for boundary-supported target spans.
    All-span consensus is available everywhere. Where both exist they receive equal
    scope weight; no outcome or hand-authored semantic rule participates.
    """
    candidate_labels, candidate_weights = consensus_matrix(candidate_maps)
    all_labels, all_weights = consensus_matrix(all_span_maps)
    candidate_by_id = {row["id"]: index for index, row in enumerate(candidates)}
    all_by_id = {row["id"]: index for index, row in enumerate(spans)}
    exploratory = [index for index, row in enumerate(candidates) if row.get("selectedExploratory")]
    missing_sources = [candidates[index]["id"] for index in exploratory
                       if candidates[index]["id"] not in all_by_id]
    if missing_sources:
        raise RuntimeError(f"selected sources missing from all-span atlas: {missing_sources[:3]}")
    source_all_indices = [all_by_id[candidates[index]["id"]] for index in exploratory]

    def map_progress(scope: str):
        return (lambda value: progress({
            **value,
            "routingScope": scope,
        })) if progress else None

    candidate_table = coassociation_rows(
        candidate_labels, candidate_weights, exploratory, map_progress("boundary-supported")
    )
    all_table = coassociation_rows(
        all_labels, all_weights, source_all_indices, map_progress("all-contiguous-spans")
    )
    by_video = defaultdict(list)
    for index, row in enumerate(spans):
        by_video[row["videoId"]].append(index)
    target_videos = sorted(by_video)
    all_span_influence = np.asarray(all_span_influence, np.float32)
    candidate_to_all = {all_by_id[row_id]: index for row_id, index in candidate_by_id.items()
                        if row_id in all_by_id}
    candidate_index_for_all = np.full(len(spans), -1, np.int32)
    for all_index, candidate_index in candidate_to_all.items():
        candidate_index_for_all[all_index] = candidate_index

    rows = []
    for source_position, source_candidate_index in enumerate(exploratory):
        source = candidates[source_candidate_index]
        source_all_index = source_all_indices[source_position]
        source_vector = all_span_influence[source_all_index]
        source_norm = np.linalg.norm(source_vector) + EPS
        for target_video in target_videos:
            target_indices = np.asarray(by_video[target_video], int)
            all_scores = all_table[source_position, target_indices]
            candidate_scores = np.full(len(target_indices), np.nan, np.float32)
            candidate_positions = candidate_index_for_all[target_indices]
            has_candidate = candidate_positions >= 0
            candidate_scores[has_candidate] = candidate_table[
                source_position, candidate_positions[has_candidate]
            ]
            combined = all_scores.copy()
            supported = np.isfinite(candidate_scores)
            combined[supported] = (combined[supported] + candidate_scores[supported]) / 2.0
            identity_control = target_video == source["videoId"]
            if identity_control:
                identity_positions = np.flatnonzero(target_indices == source_all_index)
                if len(identity_positions) != 1:
                    raise RuntimeError(f"identity span is not unique for {source['id']}")
                local = int(identity_positions[0])
                selected_cosine = 1.0
            else:
                best_consensus = float(np.max(combined))
                tied = np.flatnonzero(combined == best_consensus)
                tied_vectors = all_span_influence[target_indices[tied]]
                tied_cosine = tied_vectors @ source_vector / (
                    (np.linalg.norm(tied_vectors, axis=1) + EPS) * source_norm
                )
                tie_winner = int(np.argmax(tied_cosine))
                local = int(tied[tie_winner])
                selected_cosine = float(tied_cosine[tie_winner])
            target_index = int(target_indices[local])
            target = spans[target_index]
            candidate_score = candidate_scores[local]
            recomposed = replace_span(
                tokenize(target["hookText"]), int(target["start"]), int(target["end"]),
                source["text"], source_text=target["hookText"],
            )
            rows.append({
                "sourceIndex": source_candidate_index,
                "sourceId": source["id"],
                "sourceVideoId": source["videoId"],
                "sourceText": source["text"],
                "targetIndex": target_index,
                "targetId": target["id"],
                "targetVideoId": target_video,
                "targetText": target["text"],
                "targetHookText": target["hookText"],
                "recomposedText": recomposed,
                "atlasCoassociation": float(combined[local]),
                "allSpanAtlasCoassociation": float(all_scores[local]),
                "candidateAtlasCoassociation": (float(candidate_score)
                                                  if np.isfinite(candidate_score) else None),
                "consensusScopes": 2 if np.isfinite(candidate_score) else 1,
                "influenceCosine": selected_cosine,
                "mapsContributing": len(all_span_maps) + (
                    len(candidate_maps) if np.isfinite(candidate_score) else 0
                ),
                "identity": source["id"] == target["id"],
                "identityControl": identity_control,
                "routingUsesOutcomes": False,
                "routingUniverse": "all-contiguous-spans",
            })
        if progress and (source_position + 1 == len(exploratory)
                         or (source_position + 1) % 25 == 0):
            progress({
                "routingSourcesComplete": source_position + 1,
                "routingSourcesTotal": len(exploratory),
                "routingScope": "dual-atlas-consensus",
            })
    return rows


def crossed_effects(matrix: np.ndarray, baseline: np.ndarray) -> dict:
    matrix = np.asarray(matrix, float)
    baseline = np.asarray(baseline, float)
    grand = float(np.nanmean(matrix))
    source_mean = np.nanmean(matrix, axis=1)
    target_mean = np.nanmean(matrix, axis=0)
    interaction = matrix - source_mean[:, None] - target_mean[None, :] + grand
    delta = matrix - baseline[None, :]
    return {
        "grand": grand,
        "sourceEffect": source_mean - grand,
        "targetEffect": target_mean - grand,
        "interaction": interaction,
        "sourceTransferMeanDelta": np.nanmean(delta, axis=1),
        "sourcePositiveRate": np.nanmean(delta > 0, axis=1),
        "sourceContextSensitivity": np.nanstd(interaction, axis=1),
        "targetMeanDelta": np.nanmean(delta, axis=0),
    }
