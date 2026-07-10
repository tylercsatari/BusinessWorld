"""Outcome-blind component/context clustering and video-level representations."""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Any

import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.decomposition import TruncatedSVD
from sklearn.metrics import adjusted_rand_score

from build_study import TitleCorpusBasis, normalize_rows
from rtg_embeddings import text_key


SEEDS = (1729, 2718, 3141)


def entropy(values: list[Any]) -> float:
    if not values:
        return float("nan")
    counts = np.asarray(list(Counter(values).values()), float)
    probabilities = counts / counts.sum()
    raw = -float(np.sum(probabilities * np.log(probabilities + 1e-12)))
    return raw / max(1e-12, math.log(max(2, len(counts))))


def project_vectors(keys: list[str], vectors: dict[str, np.ndarray], basis: TitleCorpusBasis, batch_size=2048) -> np.ndarray:
    output = np.zeros((len(keys), basis.components_.shape[0]), np.float32)
    for start in range(0, len(keys), batch_size):
        stop = min(len(keys), start + batch_size)
        batch = normalize_rows(np.stack([vectors[key] for key in keys[start:stop]]).astype(np.float32))
        output[start:stop] = basis.transform(batch)
    return output


def component_feature_channels(components, vectors, title_basis, hook_by_video) -> tuple[dict[str, np.ndarray], np.ndarray]:
    component_keys = [text_key(component.text) for component in components]
    isolated = project_vectors(component_keys, vectors, title_basis)
    context = np.zeros_like(isolated)
    marginal = np.zeros_like(isolated)
    valid_context = np.zeros(len(components), bool)
    context_indices = [idx for idx, component in enumerate(components) if component.contextText.strip()]
    if context_indices:
        keys = [text_key(components[idx].contextText) for idx in context_indices]
        projected = project_vectors(keys, vectors, title_basis)
        context[context_indices] = projected
        valid_context[context_indices] = True

    # Marginal vectors are calculated in the original 1,536-dimensional space
    # and only then projected into the fixed Long Quant title basis.
    for start in range(0, len(context_indices), 2048):
        indices = context_indices[start:start + 2048]
        full = np.stack([hook_by_video[components[idx].videoId] for idx in indices]).astype(np.float32)
        context_full = np.stack([vectors[text_key(components[idx].contextText)] for idx in indices]).astype(np.float32)
        delta = normalize_rows(full - context_full)
        marginal[indices] = title_basis.transform(delta)
    return {"isolated": isolated, "context": context, "marginal": marginal}, valid_context


def stable_kmeans(features: np.ndarray, clusters: int) -> tuple[MiniBatchKMeans, np.ndarray, dict[str, Any]]:
    primary = MiniBatchKMeans(
        n_clusters=clusters,
        random_state=SEEDS[0],
        n_init=10,
        batch_size=1024,
        reassignment_ratio=0.01,
    ).fit(features)
    labels = primary.labels_.astype(np.int16)
    seed_ari = []
    for seed in SEEDS[1:]:
        model = MiniBatchKMeans(
            n_clusters=clusters,
            random_state=seed,
            n_init=5,
            batch_size=1024,
            reassignment_ratio=0.01,
        ).fit(features)
        seed_ari.append(float(adjusted_rand_score(labels, model.labels_)))
    rng = np.random.default_rng(9191 + clusters)
    bootstrap_ari = []
    for _ in range(3):
        selected = rng.choice(len(features), size=max(clusters * 4, int(len(features) * 0.8)), replace=True)
        model = MiniBatchKMeans(
            n_clusters=clusters,
            random_state=int(rng.integers(1, 1_000_000)),
            n_init=3,
            batch_size=1024,
            reassignment_ratio=0.01,
        ).fit(features[selected])
        bootstrap_ari.append(float(adjusted_rand_score(labels, model.predict(features))))
    return primary, labels, {
        "seedAdjustedRand": [round(value, 5) for value in seed_ari],
        "bootstrapAdjustedRand": [round(value, 5) for value in bootstrap_ari],
        "meanSeedAdjustedRand": round(float(np.mean(seed_ari)), 5),
        "meanBootstrapAdjustedRand": round(float(np.mean(bootstrap_ari)), 5),
        "inertia": round(float(primary.inertia_), 5),
    }


def summarize_clusters(
    family_id: str,
    components,
    features: np.ndarray,
    model: MiniBatchKMeans,
    labels: np.ndarray,
    rows_by_id: dict[str, dict],
    semantic_group_by_video: dict[str, int],
) -> list[dict[str, Any]]:
    centers = model.cluster_centers_
    assigned_distance = np.linalg.norm(features - centers[labels], axis=1)
    output = []
    for cluster in range(model.n_clusters):
        indices = np.where(labels == cluster)[0]
        if not len(indices):
            continue
        ordered = indices[np.argsort(assigned_distance[indices])]
        exemplars = []
        seen_text = set()
        for idx in ordered:
            text = components[int(idx)].text
            if text.lower() in seen_text:
                continue
            seen_text.add(text.lower())
            exemplars.append({
                "componentId": components[int(idx)].id,
                "videoId": components[int(idx)].videoId,
                "text": text,
                "modes": components[int(idx)].modes,
                "distance": round(float(assigned_distance[int(idx)]), 5),
            })
            if len(exemplars) >= 6:
                break
        video_ids = [components[int(idx)].videoId for idx in indices]
        sources = [str(rows_by_id[video_id].get("transcriptSource") or "unknown") for video_id in video_ids]
        cuts = [str(rows_by_id[video_id].get("cutBy") or "unknown") for video_id in video_ids]
        semantic = [semantic_group_by_video.get(video_id, -1) for video_id in video_ids]
        modes = Counter(mode for idx in indices for mode in components[int(idx)].modes)
        output.append({
            "id": f"{family_id}-C{cluster:03d}",
            "numericCluster": int(cluster),
            "components": int(len(indices)),
            "videos": int(len(set(video_ids))),
            "medianPosition": round(float(np.median([components[int(idx)].relativeStart for idx in indices])), 5),
            "meanAssignedDistance": round(float(np.mean(assigned_distance[indices])), 5),
            "modes": dict(modes.most_common()),
            "semanticGroupEntropy": round(float(entropy(semantic)), 5),
            "transcriptSourceEntropy": round(float(entropy(sources)), 5),
            "cutMethodEntropy": round(float(entropy(cuts)), 5),
            "largestSemanticGroupShare": round(max(Counter(semantic).values()) / len(semantic), 5),
            "largestTranscriptSourceShare": round(max(Counter(sources).values()) / len(sources), 5),
            "largestCutMethodShare": round(max(Counter(cuts).values()) / len(cuts), 5),
            "exemplars": exemplars,
            "labelRule": "Numeric outcome-blind cluster; exemplar text is not the cluster definition or an RTG label.",
        })
    return output


def video_cluster_features(components, labels: np.ndarray, video_ids: list[str], clusters: int) -> np.ndarray:
    index = {video_id: idx for idx, video_id in enumerate(video_ids)}
    counts = np.zeros((len(video_ids), clusters), np.float32)
    presence = np.zeros_like(counts)
    position_sum = np.zeros_like(counts)
    for component, label in zip(components, labels):
        row = index[component.videoId]
        counts[row, int(label)] += 1.0
        presence[row, int(label)] = 1.0
        position_sum[row, int(label)] += float(component.relativeStart)
    totals = np.sum(counts, axis=1, keepdims=True)
    proportions = counts / np.maximum(totals, 1.0)
    mean_position = position_sum / np.maximum(counts, 1.0)
    return np.column_stack([presence, proportions, mean_position]).astype(np.float32)


def build_component_clusters(
    components,
    rows: list[dict],
    vectors: dict[str, np.ndarray],
    title_basis: TitleCorpusBasis,
    hook_vectors: np.ndarray,
    title_vectors: np.ndarray,
    semantic_groups: np.ndarray,
) -> tuple[dict[str, np.ndarray], dict[str, Any], dict[str, dict[str, int]]]:
    video_ids = [str(row["id"]) for row in rows]
    rows_by_id = {str(row["id"]): row for row in rows}
    hook_by_video = {video_id: hook_vectors[idx] for idx, video_id in enumerate(video_ids)}
    semantic_group_by_video = {video_id: int(semantic_groups[idx]) for idx, video_id in enumerate(video_ids)}
    channels, valid_context = component_feature_channels(components, vectors, title_basis, hook_by_video)

    family_specs = [
        ("isolated_k16", "isolated", 16),
        ("isolated_k32", "isolated", 32),
        ("isolated_k64", "isolated", 64),
        ("isolated_k128", "isolated", 128),
        ("context_k32", "context", 32),
        ("context_k64", "context", 64),
        ("marginal_k32", "marginal", 32),
        ("marginal_k64", "marginal", 64),
    ]
    video_features: dict[str, np.ndarray] = {}
    metadata: dict[str, Any] = {
        "rule": "All clusters are outcome-blind numeric structures. Exemplars are inspection aids, never labels.",
        "transductiveWarning": "Clusters are fit without outcomes across this corpus. They are exploratory until repeated with train-fold-only cluster fitting.",
        "families": {},
        "contextInteraction": {},
    }
    assignments: dict[str, dict[str, int]] = defaultdict(dict)
    fitted = {}
    for family_id, channel, clusters in family_specs:
        mask = np.ones(len(components), bool) if channel == "isolated" else valid_context
        selected_features = channels[channel][mask]
        model, selected_labels, stability = stable_kmeans(selected_features, clusters)
        labels = np.full(len(components), -1, np.int16)
        labels[mask] = selected_labels
        fitted[family_id] = (model, labels)
        selected_components = [component for idx, component in enumerate(components) if mask[idx]]
        summaries = summarize_clusters(
            family_id,
            selected_components,
            selected_features,
            model,
            selected_labels,
            rows_by_id,
            semantic_group_by_video,
        )
        metadata["families"][family_id] = {
            "id": family_id,
            "channel": channel,
            "clusters": clusters,
            "components": int(mask.sum()),
            "stability": stability,
            "clusterSummaries": summaries,
        }
        valid_components = [component for idx, component in enumerate(components) if mask[idx]]
        video_features[f"component_{family_id}"] = video_cluster_features(valid_components, selected_labels, video_ids, clusters)
        for component, label in zip(valid_components, selected_labels):
            assignments[component.id][family_id] = int(label)
        print(f"  clustered {family_id}: {int(mask.sum()):,} components into {clusters}", flush=True)

    # Co-occurrence of isolated and context clusters is a direct quantitative
    # component/context matrix. A low-rank video representation makes it usable
    # in grouped validation without 1,024 raw interaction columns.
    isolated_labels = fitted["isolated_k32"][1]
    context_labels = fitted["context_k32"][1]
    cooccurrence = np.zeros((32, 32), np.int32)
    video_tensor = np.zeros((len(video_ids), 32 * 32), np.float32)
    video_index = {video_id: idx for idx, video_id in enumerate(video_ids)}
    for component, isolated_label, context_label in zip(components, isolated_labels, context_labels):
        if isolated_label < 0 or context_label < 0:
            continue
        cooccurrence[int(isolated_label), int(context_label)] += 1
        video_tensor[video_index[component.videoId], int(isolated_label) * 32 + int(context_label)] += 1.0
    row_totals = np.sum(video_tensor, axis=1, keepdims=True)
    video_tensor /= np.maximum(row_totals, 1.0)
    svd = TruncatedSVD(n_components=min(32, len(video_ids) - 1), random_state=1729).fit(video_tensor)
    video_features["component_context_interaction"] = svd.transform(video_tensor).astype(np.float32)
    metadata["contextInteraction"] = {
        "componentFamily": "isolated_k32",
        "contextFamily": "context_k32",
        "matrix": cooccurrence.tolist(),
        "videoDimensions": int(svd.n_components),
        "explainedVariance": [round(float(value), 6) for value in svd.explained_variance_ratio_],
        "formula": "per-video isolated-cluster x context-cluster counts, row-normalized, then outcome-blind TruncatedSVD",
    }

    # Quantitative compatibility support for every observed base-title anchor x
    # isolated component cluster. These matrices deliberately do not contain a
    # performance prediction because composed combinations have no observed
    # retention outcome.
    isolated_model = fitted["isolated_k32"][0]
    title_features = title_basis.transform(normalize_rows(title_vectors))
    hook_features = title_basis.transform(normalize_rows(hook_vectors))
    title_unit = normalize_rows(title_features)
    hook_unit = normalize_rows(hook_features)
    center_unit = normalize_rows(isolated_model.cluster_centers_)
    semantic_cosine = title_unit @ center_unit.T
    presence = video_features["component_isolated_k32"][:, :32]
    empirical_support = np.zeros_like(semantic_cosine, np.float32)
    for index, group in enumerate(semantic_groups):
        peers = np.where(semantic_groups == group)[0]
        peers = peers[peers != index]
        if len(peers):
            empirical_support[index] = np.mean(presence[peers] > 0, axis=0)
    manifold_support = np.zeros_like(semantic_cosine, np.float32)
    for index in range(len(video_ids)):
        combined = normalize_rows(title_unit[index:index + 1] + center_unit)[0:32]
        similarity = combined @ hook_unit.T
        similarity[:, index] = -np.inf
        manifold_support[index] = np.max(similarity, axis=1)
    metadata["ideaCompatibility"] = {
        "videoIds": video_ids,
        "clusterIds": [f"isolated_k32-C{cluster:03d}" for cluster in range(32)],
        "semanticCosine": np.round(semantic_cosine, 5).tolist(),
        "empiricalWithinIdeaSupport": np.round(empirical_support, 5).tolist(),
        "composedHookManifoldSupport": np.round(manifold_support, 5).tolist(),
        "formula": {
            "semanticCosine": "cosine(global title-basis title coordinates, isolated component-cluster centroid)",
            "empiricalWithinIdeaSupport": "share of other videos in the same semantic idea cluster containing that component cluster",
            "composedHookManifoldSupport": "nearest observed full-hook cosine after adding normalized title coordinates to the component centroid",
        },
        "hardLimit": "Compatibility and observed support are not performance labels. Nonsensical combinations remain visible as low-support cells.",
    }
    return video_features, metadata, dict(assignments)
