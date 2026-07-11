"""Outcome-blind segmentation sweeps and null-calibrated boundary evidence."""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np


EPS = 1e-9
METHODS = ("effect_sse", "interaction_cohesion", "span_nonadditivity")


def bh_fdr(p_values: list[float]) -> list[float]:
    if not p_values:
        return []
    p = np.asarray(p_values, float)
    order = np.argsort(p)
    ranked = p[order]
    q = ranked * len(p) / (np.arange(len(p)) + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty_like(q)
    out[order] = np.clip(q, 0, 1)
    return out.tolist()


def span_index_map(span_start, span_end) -> dict[tuple[int, int], int]:
    return {(int(start), int(end)): index for index, (start, end) in enumerate(zip(span_start, span_end))}


def cost_matrices(token_effects: np.ndarray, pair_norms: np.ndarray,
                  span_start: np.ndarray, span_end: np.ndarray,
                  span_nonadditive_norm: np.ndarray) -> dict[str, np.ndarray]:
    n = len(token_effects)
    lookup = span_index_map(span_start, span_end)
    costs = {method: np.full((n + 1, n + 1), np.inf, float) for method in METHODS}
    for start in range(n):
        for end in range(start + 1, n + 1):
            block = np.asarray(token_effects[start:end], float)
            mean = block.mean(axis=0, keepdims=True)
            costs["effect_sse"][start, end] = float(np.square(block - mean).sum())
            if end - start <= 1:
                cohesion = 0.0
            else:
                sub = pair_norms[start:end, start:end]
                cohesion = float(sub[np.triu_indices(end - start, 1)].sum())
            costs["interaction_cohesion"][start, end] = -cohesion
            costs["span_nonadditivity"][start, end] = -float(span_nonadditive_norm[lookup[(start, end)]])
    return costs


def optimal_partition(cost: np.ndarray, segment_count: int) -> tuple[float, list[tuple[int, int]]]:
    return optimal_partitions(cost)[int(segment_count)]


def optimal_partitions(cost: np.ndarray) -> list[tuple[float, list[tuple[int, int]]] | None]:
    """Solve every segment count from one shared dynamic-programming lattice."""
    n = cost.shape[0] - 1
    dp = np.full((n + 1, n + 1), np.inf, float)
    prev = np.full((n + 1, n + 1), -1, int)
    dp[0, 0] = 0.0
    for groups in range(1, n + 1):
        for end in range(groups, n + 1):
            starts = np.arange(groups - 1, end)
            values = dp[groups - 1, starts] + cost[starts, end]
            best_index = int(np.argmin(values))
            dp[groups, end] = float(values[best_index])
            prev[groups, end] = int(starts[best_index])
    output = [None]
    for k in range(1, n + 1):
        if not np.isfinite(dp[k, n]):
            output.append((float("inf"), []))
            continue
        segments = []
        end = n
        for groups in range(k, 0, -1):
            start = int(prev[groups, end])
            segments.append((start, end))
            end = start
        output.append((float(dp[k, n]), list(reversed(segments))))
    return output


def _permute_inputs(token_effects, pair_norms, permutation):
    return token_effects[permutation], pair_norms[np.ix_(permutation, permutation)]


def discover_boundaries(arrays: dict, null_repeats: int = 32, bootstrap_repeats: int = 12,
                        seed: int = 1729) -> dict:
    token_effects = np.asarray(arrays["token_effects"], np.float32)
    pair_norms = np.asarray(arrays["pair_norms"], np.float32)
    span_start = np.asarray(arrays["span_start"])
    span_end = np.asarray(arrays["span_end"])
    nonadd = np.asarray(arrays["span_nonadditive_norm"])
    n = len(token_effects)
    if n < 2:
        return {"n": n, "experiments": [], "boundaries": [], "candidates": []}

    observed_costs = cost_matrices(token_effects, pair_norms, span_start, span_end, nonadd)
    observed = []
    for method in METHODS:
        partitions = optimal_partitions(observed_costs[method])
        for k in range(1, n + 1):
            objective, segments = partitions[k]
            observed.append({"method": method, "segments": k, "objective": objective,
                             "partition": segments})

    rng = np.random.RandomState(seed)
    null_values = {(method, k): [] for method in METHODS for k in range(1, n + 1)}
    null_boundary_counts = np.zeros((null_repeats, n - 1), float)
    null_boundary_by_method = {method: np.zeros((null_repeats, n - 1), float) for method in METHODS}
    null_span_counts = [defaultdict(int) for _ in range(null_repeats)]
    for repeat in range(null_repeats):
        permutation = rng.permutation(n)
        effects_null, pairs_null = _permute_inputs(token_effects, pair_norms, permutation)
        # Non-additivity values are permuted over the exhaustive span lattice,
        # preserving their marginal distribution while destroying sequence fit.
        shuffled_nonadd = rng.permutation(nonadd)
        costs = cost_matrices(effects_null, pairs_null, span_start, span_end, shuffled_nonadd)
        for method in METHODS:
            partitions = optimal_partitions(costs[method])
            for k in range(1, n + 1):
                value, partition = partitions[k]
                null_values[(method, k)].append(value)
                for start, end in partition:
                    null_span_counts[repeat][(start, end)] += 1
                for _, end in partition[:-1]:
                    null_boundary_counts[repeat, end - 1] += 1
                    null_boundary_by_method[method][repeat, end - 1] += 1

    for row in observed:
        null = np.asarray(null_values[(row["method"], row["segments"])], float)
        # Every objective is minimized. Lower than a permuted sequence is better.
        row["nullMean"] = float(null.mean()) if len(null) else None
        row["nullStd"] = float(null.std()) if len(null) else None
        row["p"] = float((1 + np.sum(null <= row["objective"])) / (len(null) + 1)) if len(null) else 1.0
        row["z"] = float((null.mean() - row["objective"]) / (null.std() + EPS)) if len(null) else 0.0
    q_values = bh_fdr([row["p"] for row in observed])
    for row, q_value in zip(observed, q_values):
        row["q"] = q_value

    for row in observed:
        partition_count = max(1, math.comb(n - 1, row["segments"] - 1))
        row["descriptionLengthPenalty"] = math.sqrt(2 * math.log(partition_count))
        row["selectionScore"] = row["z"] - row["descriptionLengthPenalty"]
    selected = max(observed, key=lambda row: (row["selectionScore"], -row["segments"], row["method"]))
    nontrivial = max((row for row in observed if row["segments"] > 1),
                     key=lambda row: (row["selectionScore"], -row["segments"], row["method"]))
    null_search_maxima = []
    for repeat in range(null_repeats):
        candidates_for_repeat = []
        for method in METHODS:
            for k in range(1, n + 1):
                values = np.asarray(null_values[(method, k)], float)
                if len(values) <= 1:
                    continue
                others = np.delete(values, repeat)
                z_value = float((others.mean() - values[repeat]) / (others.std() + EPS))
                partition_count = max(1, math.comb(n - 1, k - 1))
                candidates_for_repeat.append(z_value - math.sqrt(2 * math.log(partition_count)))
        null_search_maxima.append(max(candidates_for_repeat, default=0.0))
    search_p = float((1 + np.sum(np.asarray(null_search_maxima) >= selected["selectionScore"])) /
                     (len(null_search_maxima) + 1))

    observed_boundary_counts = np.zeros(n - 1, float)
    observed_boundary_by_method = {method: np.zeros(n - 1, float) for method in METHODS}
    for row in observed:
        for _, end in row["partition"][:-1]:
            observed_boundary_counts[end - 1] += 1
            observed_boundary_by_method[row["method"]][end - 1] += 1

    boundary_rows = []
    for boundary in range(1, n):
        containing = [row for row in observed if any(end == boundary for _, end in row["partition"][:-1])]
        by_method = {
            method: sum(1 for row in containing if row["method"] == method) / n
            for method in METHODS
        }
        null_counts = null_boundary_counts[:, boundary - 1]
        observed_count = observed_boundary_counts[boundary - 1]
        config_count = max(1, len(observed))
        null_probability = float((null_counts.sum() + 1) /
                                 (len(null_counts) * config_count + 2))
        observed_probability = float(observed_count / config_count)
        calibrated_z = float((observed_probability - null_probability) /
                             math.sqrt(null_probability * (1 - null_probability) /
                                       config_count + EPS))
        calibrated_p = float((1 + np.sum(null_counts >= observed_count)) / (len(null_counts) + 1))
        method_delta = {}
        for method in METHODS:
            method_null = null_boundary_by_method[method][:, boundary - 1]
            method_delta[method] = float((observed_boundary_by_method[method][boundary - 1] -
                                          method_null.mean()) / n)
        boundary_rows.append({
            "index": boundary,
            "frequency": len(containing) / max(1, len(observed)),
            "nullFrequency": float(null_counts.mean() / max(1, len(observed))),
            "aboveNullFrequency": float((observed_count - null_counts.mean()) / max(1, len(observed))),
            "calibratedZ": calibrated_z,
            "calibratedP": calibrated_p,
            "methodFrequency": by_method,
            "methodAboveNull": method_delta,
            "bestExperimentQ": min((row["q"] for row in containing), default=1.0),
        })
    boundary_q = bh_fdr([row["calibratedP"] for row in boundary_rows])
    for row, q_value in zip(boundary_rows, boundary_q):
        row["calibratedQ"] = q_value

    bootstrap_agreement = np.zeros(n - 1, float)
    bootstrap_total = np.zeros(n - 1, float)
    target_dim = min(64, token_effects.shape[1])
    for _ in range(bootstrap_repeats):
        projection = rng.normal(0, 1 / math.sqrt(target_dim),
                                size=(token_effects.shape[1], target_dim)).astype(np.float32)
        projected = token_effects @ projection
        costs = cost_matrices(projected, pair_norms, span_start, span_end, nonadd)
        for method in METHODS:
            partitions = optimal_partitions(costs[method])
            for k in range(2, n + 1):
                _, partition = partitions[k]
                base = next(row["partition"] for row in observed
                            if row["method"] == method and row["segments"] == k)
                current_boundaries = {end for _, end in partition[:-1]}
                base_boundaries = {end for _, end in base[:-1]}
                for boundary in range(1, n):
                    bootstrap_agreement[boundary - 1] += int((boundary in current_boundaries) ==
                                                             (boundary in base_boundaries))
                    bootstrap_total[boundary - 1] += 1
    for index, row in enumerate(boundary_rows):
        row["bootstrapAgreement"] = float(bootstrap_agreement[index] /
                                           max(1, bootstrap_total[index]))

    span_support = defaultdict(lambda: {"count": 0, "weighted": 0.0, "methods": set(), "ks": set()})
    for row in observed:
        for segment in row["partition"]:
            item = span_support[segment]
            item["count"] += 1
            item["weighted"] += max(0.0, row["z"])
            item["methods"].add(row["method"])
            item["ks"].add(row["segments"])
    candidates = []
    for (start, end), item in span_support.items():
        null_counts = np.asarray([rows.get((start, end), 0) for rows in null_span_counts], float)
        observed_count = float(item["count"])
        config_count = max(1, len(observed))
        null_probability = float((null_counts.sum() + 1) /
                                 (len(null_counts) * config_count + 2))
        observed_probability = float(observed_count / config_count)
        calibrated_z = float((observed_probability - null_probability) /
                             math.sqrt(null_probability * (1 - null_probability) /
                                       config_count + EPS))
        calibrated_p = float((1 + np.sum(null_counts >= observed_count)) / (len(null_counts) + 1))
        candidates.append({
            "start": start,
            "end": end,
            "count": item["count"],
            "frequency": item["count"] / len(observed),
            "nullFrequency": float(null_counts.mean() / len(observed)),
            "aboveNullFrequency": float((observed_count - null_counts.mean()) / len(observed)),
            "calibratedZ": calibrated_z,
            "calibratedP": calibrated_p,
            "methods": sorted(item["methods"]),
            "segmentCounts": sorted(item["ks"]),
        })
    candidate_q = bh_fdr([row["calibratedP"] for row in candidates])
    for row, q_value in zip(candidates, candidate_q):
        row["calibratedQ"] = q_value
    candidates.sort(key=lambda row: (-row["calibratedZ"], -row["aboveNullFrequency"],
                                     row["start"], row["end"]))

    serial_experiments = []
    for row in observed:
        serial_experiments.append({
            **{key: value for key, value in row.items() if key != "partition"},
            "partition": [[int(start), int(end)] for start, end in row["partition"]],
        })
    return {
        "n": n,
        "methodCount": len(METHODS),
        "segmentCountsTested": n,
        "nullRepeats": null_repeats,
        "bootstrapRepeats": bootstrap_repeats,
        "selectedSegmentation": {
            "selectionRule": "maximum null-standardized objective across every method and segment count",
            "method": selected["method"],
            "segmentCount": selected["segments"],
            "partition": [[int(start), int(end)] for start, end in selected["partition"]],
            "z": selected["z"],
            "descriptionLengthPenalty": selected["descriptionLengthPenalty"],
            "selectionScore": selected["selectionScore"],
            "experimentP": selected["p"],
            "experimentQ": selected["q"],
            "searchWideP": search_p,
            "status": ("supported" if selected["segments"] > 1 and search_p <= .05
                       else "no-separable-component-evidence" if selected["segments"] == 1
                       else "provisional"),
            "outcomesUsed": False,
        },
        "exploratoryNontrivialSegmentation": {
            "selectionRule": "best description-length-adjusted partition constrained to k > 1",
            "purpose": "downstream sensitivity and swap experiments; not accepted as component truth",
            "method": nontrivial["method"],
            "segmentCount": nontrivial["segments"],
            "partition": [[int(start), int(end)] for start, end in nontrivial["partition"]],
            "z": nontrivial["z"],
            "descriptionLengthPenalty": nontrivial["descriptionLengthPenalty"],
            "selectionScore": nontrivial["selectionScore"],
            "experimentP": nontrivial["p"],
            "experimentQ": nontrivial["q"],
            "status": "exploratory-only",
            "outcomesUsed": False,
        },
        "experiments": serial_experiments,
        "boundaries": boundary_rows,
        "candidates": candidates,
    }
