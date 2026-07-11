"""Post-hoc manual probes over frozen Promise Lab clustering maps."""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from typing import Any

import numpy as np

from sequence import surface, tokenize


INSERTION_COST = 0.55
BOOTSTRAP_SEED = 20260711


def _word_rows(text: str) -> list[tuple[int, str, str]]:
    rows = []
    for token in tokenize(text):
        if any(character.isalnum() for character in token.text):
            normalized = token.text.lower().replace("’", "'")
            rows.append((token.index, normalized, token.text))
    return rows


def _normalized_text(words: list[tuple[int, str, str]]) -> str:
    return " ".join(row[1] for row in words)


def local_alignment(phrase: str, hook_text: str) -> dict[str, Any]:
    """Align a dictated phrase to one contiguous observed hook region."""
    phrase_words = _word_rows(phrase)
    hook_words = _word_rows(hook_text)
    m, n = len(phrase_words), len(hook_words)
    if not m or not n:
        return {"score": 0.0, "wordStart": 0, "wordEnd": 0, "cost": float(m)}

    costs = np.full((m + 1, n + 1), np.inf, dtype=np.float64)
    moves = np.zeros((m + 1, n + 1), dtype=np.int8)
    costs[0, :] = 0.0
    costs[:, 0] = np.arange(m + 1, dtype=np.float64)
    for left in range(1, m + 1):
        for right in range(1, n + 1):
            choices = (
                costs[left - 1, right - 1]
                + (0.0 if phrase_words[left - 1][1] == hook_words[right - 1][1] else 1.0),
                costs[left - 1, right] + 1.0,
                costs[left, right - 1] + INSERTION_COST,
            )
            move = int(np.argmin(choices))
            costs[left, right] = choices[move]
            moves[left, right] = move

    end = int(np.argmin(costs[m, 1:])) + 1
    left, right = m, end
    consumed: list[int] = []
    while left > 0:
        move = int(moves[left, right]) if right > 0 else 1
        if move == 0:
            consumed.append(right - 1)
            left -= 1
            right -= 1
        elif move == 1:
            left -= 1
        else:
            consumed.append(right - 1)
            right -= 1
    word_start = min(consumed) if consumed else max(0, end - 1)
    word_end = max(consumed) + 1 if consumed else end
    observed = hook_words[word_start:word_end]
    cost = float(costs[m, end])
    token_score = max(0.0, 1.0 - cost / max(1, m))
    character_score = SequenceMatcher(
        None, _normalized_text(phrase_words), _normalized_text(observed)
    ).ratio()
    return {
        "score": float(0.7 * token_score + 0.3 * character_score),
        "tokenScore": float(token_score),
        "characterScore": float(character_score),
        "cost": cost,
        "wordStart": int(word_start),
        "wordEnd": int(word_end),
    }


def _exact_word_span(needle: str, hook_text: str) -> tuple[int, int]:
    wanted = [row[1] for row in _word_rows(needle)]
    available = [row[1] for row in _word_rows(hook_text)]
    for start in range(0, len(available) - len(wanted) + 1):
        if available[start:start + len(wanted)] == wanted:
            return start, start + len(wanted)
    raise ValueError(f"override span is not present in observed hook: {needle!r}")


def align_phrases(
    phrases: list[str], corpus_rows: list[dict[str, Any]],
    all_span_rows: list[dict[str, Any]], candidate_rows: list[dict[str, Any]],
    overrides: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Use corpus order plus surface similarity to recover each literal span."""
    overrides_by_index = {int(row["phraseIndex"]): row for row in (overrides or [])}
    hook_count = len(corpus_rows)
    scores = np.empty((len(phrases), hook_count), dtype=np.float64)
    alignments: list[list[dict[str, Any]]] = []
    video_to_index = {str(row["id"]): index for index, row in enumerate(corpus_rows)}

    for phrase_index, phrase in enumerate(phrases):
        phrase_alignments = [
            local_alignment(phrase, str(row.get("hookText") or ""))
            for row in corpus_rows
        ]
        alignments.append(phrase_alignments)
        scores[phrase_index] = [row["score"] for row in phrase_alignments]
        override = overrides_by_index.get(phrase_index)
        if override:
            forced = video_to_index[str(override["videoId"])]
            scores[phrase_index, :] = -1e12
            scores[phrase_index, forced] = 1.0

    back = np.zeros((len(phrases), hook_count), dtype=np.int32)
    previous = scores[0].copy()
    for phrase_index in range(1, len(phrases)):
        best_value = -np.inf
        best_index = 0
        current = np.empty(hook_count, dtype=np.float64)
        for hook_index in range(hook_count):
            if previous[hook_index] > best_value:
                best_value = previous[hook_index]
                best_index = hook_index
            current[hook_index] = scores[phrase_index, hook_index] + best_value
            back[phrase_index, hook_index] = best_index
        previous = current

    assigned = np.zeros(len(phrases), dtype=np.int32)
    assigned[-1] = int(np.argmax(previous))
    for phrase_index in range(len(phrases) - 1, 0, -1):
        assigned[phrase_index - 1] = back[phrase_index, assigned[phrase_index]]

    all_span_index = {
        (str(row["videoId"]), int(row["start"]), int(row["end"])): index
        for index, row in enumerate(all_span_rows)
    }
    candidate_index = {
        (str(row["videoId"]), int(row["start"]), int(row["end"])): index
        for index, row in enumerate(candidate_rows)
    }
    output = []
    for phrase_index, phrase in enumerate(phrases):
        hook_index = int(assigned[phrase_index])
        hook = corpus_rows[hook_index]
        hook_text = str(hook.get("hookText") or "")
        hook_words = _word_rows(hook_text)
        alignment = dict(alignments[phrase_index][hook_index])
        override = overrides_by_index.get(phrase_index)
        if override:
            word_start, word_end = _exact_word_span(
                str(override["observedSpanText"]), hook_text
            )
            alignment["wordStart"] = word_start
            alignment["wordEnd"] = word_end
            alignment["method"] = "explicit transcription repair"
        else:
            word_start = int(alignment["wordStart"])
            word_end = int(alignment["wordEnd"])
            alignment["method"] = "ordered surface alignment"
        token_start = int(hook_words[word_start][0])
        token_end = int(hook_words[word_end - 1][0]) + 1
        key = (str(hook["id"]), token_start, token_end)
        if key not in all_span_index:
            raise ValueError(f"manual phrase did not resolve to an exhaustive span: {phrase!r} {key}")
        span_index = all_span_index[key]
        observed = all_span_rows[span_index]
        output.append({
            "phraseIndex": phrase_index,
            "manualPhrase": phrase,
            "videoId": str(hook["id"]),
            "hookIndex": hook_index,
            "hookText": hook_text,
            "observedSpanText": str(observed["text"]),
            "start": token_start,
            "end": token_end,
            "spanId": str(observed["id"]),
            "allSpanIndex": span_index,
            "candidateIndex": candidate_index.get(key),
            "matchScore": float(alignment["score"]),
            "tokenScore": float(alignment["tokenScore"]),
            "characterScore": float(alignment["characterScore"]),
            "matchingMethod": alignment["method"],
            "overrideReason": override.get("reason") if override else None,
        })
    return output


def _phrase_weights(matches: list[dict[str, Any]]) -> np.ndarray:
    counts = Counter(str(row["videoId"]) for row in matches)
    return np.asarray([1.0 / counts[str(row["videoId"])] for row in matches], dtype=np.float64)


def _scope_evaluations(
    scope: str, atlas: dict[str, Any], matches: list[dict[str, Any]],
    total_hook_weight: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    index_field = "allSpanIndex" if scope == "all-contiguous-spans" else "candidateIndex"
    scoped = [row for row in matches if row.get(index_field) is not None]
    weights = _phrase_weights(matches)
    scoped_positions = [index for index, row in enumerate(matches) if row.get(index_field) is not None]
    scoped_weights = weights[scoped_positions]
    scoped_mass = float(scoped_weights.sum())
    coverage = scoped_mass / total_hook_weight if total_hook_weight else 0.0
    row_indices = np.asarray([int(row[index_field]) for row in scoped], dtype=np.int64)
    evaluations = []
    runtime = []
    rows = atlas.get("spans") or atlas.get("candidates") or []
    for map_index, map_row in enumerate(atlas.get("maps") or []):
        labels = np.asarray(map_row.get("labels") or [], dtype=np.int32)
        cluster_count = int(map_row.get("clusterCount") or (labels.max() + 1))
        base_counts = np.bincount(labels, minlength=cluster_count).astype(np.float64)
        base = base_counts / max(1.0, float(len(labels)))
        assignments = labels[row_indices]
        selected_counts = np.bincount(
            assignments, weights=scoped_weights, minlength=cluster_count
        ).astype(np.float64)
        selected = selected_counts / max(scoped_mass, 1e-12)
        contribution = np.zeros(cluster_count, dtype=np.float64)
        present = (selected > 0) & (base > 0)
        contribution[present] = selected[present] * np.log2(selected[present] / base[present])
        winning_cluster = int(np.argmax(contribution))
        in_cluster = assignments == winning_cluster
        raw_hits = int(in_cluster.sum())
        hit_hooks = len({
            str(row["videoId"]) for row, hit in zip(scoped, in_cluster) if bool(hit)
        })
        map_kl = float(contribution.sum())
        pair_score = float(coverage * contribution[winning_cluster])
        evaluation = {
            "scope": scope,
            "mapIndex": map_index,
            "mapId": str(map_row.get("id") or ""),
            "representation": str(map_row.get("representation") or ""),
            "geometry": str(map_row.get("geometry") or ""),
            "pcaDimensions": int(map_row.get("pcaDimensions") or 0),
            "clusterCount": cluster_count,
            "cluster": winning_cluster,
            "manualPhrasesAvailable": len(scoped),
            "manualHooksAvailableWeight": scoped_mass,
            "scopeCoverage": coverage,
            "manualPhrasesInCluster": raw_hits,
            "manualHooksInCluster": hit_hooks,
            "manualWeightInCluster": float(selected_counts[winning_cluster]),
            "manualRecall": float(selected[winning_cluster]),
            "atlasClusterSize": int(base_counts[winning_cluster]),
            "atlasPopulation": int(len(labels)),
            "atlasBaseRate": float(base[winning_cluster]),
            "enrichment": float(selected[winning_cluster] / base[winning_cluster]),
            "informationContributionBits": float(contribution[winning_cluster]),
            "globalInformationContributionBits": pair_score,
            "mapKLDivergenceBits": map_kl,
            "seedStabilityARI": map_row.get("seedStabilityARI"),
            "marginAboveNull": map_row.get("marginAboveNull"),
            "heldoutHookMargin": map_row.get("heldoutHookMargin"),
            "lengthNMI": map_row.get("lengthNMI"),
            "positionNMI": map_row.get("positionNMI"),
            "crossHookGenerality": map_row.get("crossHookGenerality"),
        }
        evaluations.append(evaluation)
        runtime.append({
            "evaluation": evaluation,
            "assignments": assignments,
            "base": base,
            "scopedPositions": np.asarray(scoped_positions, dtype=np.int32),
            "scopedWeights": scoped_weights,
        })
    return evaluations, runtime


def score_frozen_maps(
    atlases: dict[str, dict[str, Any]], matches: list[dict[str, Any]],
    bootstrap_repeats: int = 256,
) -> dict[str, Any]:
    """Rank existing map/cluster pairs without fitting or changing a map."""
    total_hook_weight = float(len({str(row["videoId"]) for row in matches}))
    evaluations: list[dict[str, Any]] = []
    runtime: list[dict[str, Any]] = []
    for scope, atlas in atlases.items():
        scope_evaluations, scope_runtime = _scope_evaluations(
            scope, atlas, matches, total_hook_weight
        )
        evaluations.extend(scope_evaluations)
        runtime.extend(scope_runtime)
    order = sorted(
        range(len(evaluations)),
        key=lambda index: (
            float(evaluations[index]["globalInformationContributionBits"]),
            float(evaluations[index]["manualRecall"]),
            float(evaluations[index]["enrichment"]),
        ),
        reverse=True,
    )
    winner_index = order[0]
    winner = dict(evaluations[winner_index])

    hook_ids = sorted({str(row["videoId"]) for row in matches})
    hook_position = {video_id: index for index, video_id in enumerate(hook_ids)}
    phrase_hook_positions = np.asarray(
        [hook_position[str(row["videoId"])] for row in matches], dtype=np.int32
    )
    base_phrase_weights = _phrase_weights(matches)
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    exact_pair_count = 0
    winning_cluster_count = 0
    fixed_recall = []
    fixed_contribution = []
    pair_counts: Counter[str] = Counter()
    representation_counts: Counter[str] = Counter()
    for _ in range(bootstrap_repeats):
        sampled = rng.integers(0, len(hook_ids), size=len(hook_ids))
        hook_counts = np.bincount(sampled, minlength=len(hook_ids)).astype(np.float64)
        phrase_weights = base_phrase_weights * hook_counts[phrase_hook_positions]
        best_score = -np.inf
        best_runtime_index = 0
        best_cluster = 0
        for runtime_index, row in enumerate(runtime):
            positions = row["scopedPositions"]
            weights = phrase_weights[positions]
            mass = float(weights.sum())
            if mass <= 0:
                continue
            selected_counts = np.bincount(
                row["assignments"], weights=weights, minlength=len(row["base"])
            ).astype(np.float64)
            selected = selected_counts / mass
            contribution = np.zeros(len(row["base"]), dtype=np.float64)
            present = (selected > 0) & (row["base"] > 0)
            contribution[present] = (
                selected[present] * np.log2(selected[present] / row["base"][present])
            )
            cluster = int(np.argmax(contribution))
            coverage = mass / len(hook_ids)
            score = float(coverage * contribution[cluster])
            if score > best_score:
                best_score = score
                best_runtime_index = runtime_index
                best_cluster = cluster
        chosen = evaluations[best_runtime_index]
        pair_key = f"{chosen['scope']}:{chosen['mapId']}:{best_cluster}"
        pair_counts[pair_key] += 1
        representation_counts[f"{chosen['scope']}:{chosen['representation']}"] += 1
        if best_runtime_index == winner_index and best_cluster == int(winner["cluster"]):
            exact_pair_count += 1

        fixed = runtime[winner_index]
        weights = phrase_weights[fixed["scopedPositions"]]
        mass = float(weights.sum())
        counts = np.bincount(
            fixed["assignments"], weights=weights, minlength=len(fixed["base"])
        ).astype(np.float64)
        selected = counts / max(mass, 1e-12)
        cluster = int(winner["cluster"])
        contribution = (
            selected[cluster] * math.log2(selected[cluster] / fixed["base"][cluster])
            if selected[cluster] > 0 and fixed["base"][cluster] > 0 else 0.0
        )
        fixed_recall.append(float(selected[cluster]))
        fixed_contribution.append(float(contribution))
        fixed_cluster_contributions = np.zeros_like(selected)
        present = (selected > 0) & (fixed["base"] > 0)
        fixed_cluster_contributions[present] = (
            selected[present] * np.log2(selected[present] / fixed["base"][present])
        )
        if int(np.argmax(fixed_cluster_contributions)) == cluster:
            winning_cluster_count += 1

    winner["bootstrap"] = {
        "method": "equal-hook grouped bootstrap over the manual post-hoc selections",
        "seed": BOOTSTRAP_SEED,
        "repeats": bootstrap_repeats,
        "exactMapAndClusterSelectionRate": exact_pair_count / bootstrap_repeats,
        "sameClusterWithinWinningMapRate": winning_cluster_count / bootstrap_repeats,
        "fixedClusterRecallP10": float(np.quantile(fixed_recall, 0.10)),
        "fixedClusterRecallMedian": float(np.quantile(fixed_recall, 0.50)),
        "fixedClusterRecallP90": float(np.quantile(fixed_recall, 0.90)),
        "fixedClusterContributionP10Bits": float(np.quantile(fixed_contribution, 0.10)),
        "fixedClusterContributionMedianBits": float(np.quantile(fixed_contribution, 0.50)),
        "fixedClusterContributionP90Bits": float(np.quantile(fixed_contribution, 0.90)),
        "mostSelectedPairs": [
            {"pair": key, "selectionRate": count / bootstrap_repeats}
            for key, count in pair_counts.most_common(10)
        ],
        "mostSelectedScopeRepresentations": [
            {"scopeRepresentation": key, "selectionRate": count / bootstrap_repeats}
            for key, count in representation_counts.most_common(10)
        ],
    }
    return {
        "winner": winner,
        "rankings": [evaluations[index] for index in order[:30]],
        "evaluations": evaluations,
    }


def describe_winner(
    scored: dict[str, Any], atlases: dict[str, dict[str, Any]],
    matches: list[dict[str, Any]], member_limit: int = 250,
) -> dict[str, Any]:
    winner = scored["winner"]
    scope = str(winner["scope"])
    atlas = atlases[scope]
    rows = atlas.get("spans") or atlas.get("candidates") or []
    map_row = (atlas.get("maps") or [])[int(winner["mapIndex"])]
    labels = np.asarray(map_row["labels"], dtype=np.int32)
    cluster = int(winner["cluster"])
    index_field = "allSpanIndex" if scope == "all-contiguous-spans" else "candidateIndex"
    scoped = [row for row in matches if row.get(index_field) is not None]
    for row in scoped:
        row["winningMapCluster"] = int(labels[int(row[index_field])])
        row["insideWinningCluster"] = row["winningMapCluster"] == cluster
    inside = [row for row in scoped if row["insideWinningCluster"]]
    outside = [row for row in scoped if not row["insideWinningCluster"]]

    points = np.asarray((atlas.get("projections") or {})[map_row["representation"]], dtype=np.float64)
    cluster_indices = np.flatnonzero(labels == cluster)
    centroid = np.median(points[cluster_indices], axis=0)
    distances = np.linalg.norm(points[cluster_indices] - centroid, axis=1)
    ordered_indices = cluster_indices[np.argsort(distances)]
    manual_by_row: dict[int, list[int]] = defaultdict(list)
    for row in inside:
        manual_by_row[int(row[index_field])].append(int(row["phraseIndex"]))

    diverse = []
    seen_hooks: set[str] = set()
    for row_index in ordered_indices:
        video_id = str(rows[int(row_index)]["videoId"])
        if video_id not in seen_hooks:
            diverse.append(int(row_index))
            seen_hooks.add(video_id)
        if len(diverse) >= member_limit:
            break
    if len(diverse) < member_limit:
        used = set(diverse)
        for row_index in ordered_indices:
            index = int(row_index)
            if index not in used:
                diverse.append(index)
                used.add(index)
            if len(diverse) >= member_limit:
                break
    nearest = []
    for row_index in diverse:
        row = rows[row_index]
        nearest.append({
            "rowIndex": row_index,
            "id": row.get("id"),
            "videoId": row.get("videoId"),
            "text": row.get("text"),
            "start": row.get("start"),
            "end": row.get("end"),
            "tokenCount": row.get("tokenCount"),
            "boundarySupported": row.get("boundarySupported"),
            "distanceToDisplayedCentroid": float(np.linalg.norm(points[row_index] - centroid)),
            "manualPhraseIndices": manual_by_row.get(row_index, []),
        })
    return {
        "map": {
            key: map_row.get(key) for key in (
                "id", "representation", "geometry", "pcaDimensions", "clusterCount",
                "seedStabilityARI", "marginAboveNull", "heldoutHookMargin", "lengthNMI",
                "positionNMI", "crossHookGenerality", "scope",
            )
        },
        "cluster": cluster,
        "clusterSize": int(cluster_indices.size),
        "matches": inside,
        "misses": outside,
        "nearestMembers": nearest,
        "nearestMemberMethod": (
            "distance to the cluster median in the retained displayed projection, "
            "with source-hook diversity first"
        ),
    }
