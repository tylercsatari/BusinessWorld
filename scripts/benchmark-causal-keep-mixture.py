#!/usr/bin/env python3
"""Reproduce the preregistered four-account causal keep-rate mixture benchmark.

The benchmark is intentionally isolated from production scoring. It reads the
canonical retention tables and embedding archives through the Predictor Lab
loader, enumerates the exact 43,360-candidate research registry, selects every
stage using only each account's chronological 50%-80% window, locks the final
50/50 multimodal formula, and only then evaluates the final 20%.

Every supervised state transition is grouped by equal publication timestamp.
No row may consume an outcome from another row in its timestamp batch.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import platform
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "buildings/jarvis/predictor-lab/run_predictor_lab.py"
OUTPUT = (
    ROOT
    / "buildings/jarvis/predictor-lab/causal-keep-mixture-benchmark.json"
)
MIN_HISTORY = 8
EPSILON = 1e-9
BOOTSTRAP_SEED = 20_260_729
BOOTSTRAP_REPLICATES = 20_000
INTERVAL_COVERAGES = (0.8, 0.9, 0.95)
EXPECTED_CANDIDATE_COUNT = 43_360

HISTORY_NAMES = (
    "mean8",
    "mean12",
    "mean20",
    "mean30",
    "mean40",
    "meanAll",
    "last",
    "median12",
    "median30",
    "ewma2",
    "ewma4",
    "ewma8",
    "ewma16",
    "trend12",
    "trend20",
    "trend30",
)
KRR_SPECS = tuple(
    (modality, window, alpha)
    for modality in ("visual", "together", "combined")
    for window in (12, 30, 40)
    for alpha in (0.03, 0.1, 0.3, 1.0)
)
SAME_KNN_SPECS = tuple(
    (modality, neighbors, temperature)
    for modality in ("visual", "together", "combined")
    for neighbors in (3, 5, 8, 12)
    for temperature in (8.0, 20.0)
)
POOLED_MODALITIES = (
    "visual",
    "together",
    "combined",
    "centeredVisual",
    "centeredTogether",
    "centeredCombined",
)
POOLED_SPECS = tuple(
    (modality, neighbors, temperature, standardized, cross_only)
    for modality in POOLED_MODALITIES
    for neighbors in (12, 24, 48)
    for temperature in (6.0, 15.0)
    for standardized in (False, True)
    for cross_only in (False, True)
)

STAGE3_FEATURE_SETS = {
    "semanticCore": ("ct12", "ct24", "cc12", "cv12"),
    "semanticWide": (
        "ct12",
        "ct24",
        "ct48",
        "cc12",
        "cv12",
        "cv24",
        "krrTogether",
        "krrVisual",
    ),
    "semanticHistory": (
        "ct12",
        "ct24",
        "cc12",
        "cv12",
        "krrTogether",
        "krrVisual",
        "ewma4",
        "ewma8",
        "last",
        "trend20",
        "mean12",
        "mean40",
    ),
}
STAGE3_FIXED_SETS = {
    "ct12": ("ct12",),
    "pooledTogether": ("ct12", "ct24", "ct48"),
    "pooledModalities": ("ct12", "ct24", "cc12", "cv12"),
    "pooledAll": ("ct12", "ct24", "ct48", "cc12", "cv12", "cv24"),
    "semanticAll": (
        "ct12",
        "ct24",
        "ct48",
        "cc12",
        "cv12",
        "cv24",
        "krrTogether",
        "krrVisual",
    ),
}
STAGE3_ALIASES = {
    "ct12": "pooledKnn:centeredTogether:k12:t15:z:all",
    "ct24": "pooledKnn:centeredTogether:k24:t15:z:all",
    "ct48": "pooledKnn:centeredTogether:k48:t15:z:all",
    "cc12": "pooledKnn:centeredCombined:k12:t15:z:all",
    "cv12": "pooledKnn:centeredVisual:k12:t15:z:all",
    "cv24": "pooledKnn:centeredVisual:k24:t15:z:all",
    "krrTogether": "krr:together:w30:a0.1",
    "krrVisual": "krr:visual:w30:a0.1",
    "ewma4": "history:ewma4",
    "ewma8": "history:ewma8",
    "last": "history:last",
    "trend20": "history:trend20",
    "mean12": "history:mean12",
    "mean40": "history:mean40",
}


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def stable_hash(value: str) -> int:
    return int(hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16], 16)


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def normalized(vectors: np.ndarray) -> np.ndarray:
    values = np.asarray(vectors, dtype=np.float64)
    return values / (
        np.linalg.norm(values, axis=1, keepdims=True) + EPSILON
    )


def bootstrap_environment() -> None:
    candidates = [ROOT / ".env"]
    try:
        common = subprocess.check_output(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=ROOT,
            text=True,
        ).strip()
        common_path = Path(common)
        if not common_path.is_absolute():
            common_path = (ROOT / common_path).resolve()
        candidates.append(common_path.parent / ".env")
    except (OSError, subprocess.CalledProcessError):
        pass
    for path in candidates:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(
                key.strip(),
                value.strip().strip('"').strip("'"),
            )
        break


def load_predictor() -> Any:
    bootstrap_environment()
    spec = importlib.util.spec_from_file_location(
        "predictor_lab_causal_keep_mixture",
        SOURCE,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_canonical_data(
    predictor: Any,
) -> tuple[list[dict[str, Any]], np.ndarray, np.ndarray]:
    stores = predictor.load_raw()
    rows = [
        row
        for row in predictor.load_private_rows()
        if predictor.finite(row.get("keep"))
        and predictor.finite(row.get("publishedAt"))
        and row["id"] in stores["visual"]["index"]
        and row["id"] in stores["together"]["index"]
    ]
    rows.sort(
        key=lambda row: (
            str(row["account"]),
            float(row["publishedAt"]),
            stable_hash(str(row["id"])),
        )
    )
    visual = np.asarray(
        [
            stores["visual"]["vectors"][
                stores["visual"]["index"][row["id"]]
            ]
            for row in rows
        ],
        dtype=np.float64,
    )
    together = np.asarray(
        [
            stores["together"]["vectors"][
                stores["together"]["index"][row["id"]]
            ]
            for row in rows
        ],
        dtype=np.float64,
    )
    return rows, visual, together


def build_context(rows: list[dict[str, Any]]) -> dict[str, Any]:
    accounts = np.asarray([str(row["account"]) for row in rows])
    outcomes = np.asarray([float(row["keep"]) for row in rows])
    timestamps = np.asarray([float(row["publishedAt"]) for row in rows])
    orders: dict[str, np.ndarray] = {}
    positions = np.full(len(rows), -1, dtype=int)
    selection_start: dict[str, int] = {}
    evaluation_start: dict[str, int] = {}
    for account in sorted(set(accounts), key=stable_hash):
        order = np.asarray(
            sorted(
                np.flatnonzero(accounts == account),
                key=lambda index: (
                    timestamps[index],
                    stable_hash(str(rows[int(index)]["id"])),
                ),
            ),
            dtype=int,
        )
        orders[str(account)] = order
        positions[order] = np.arange(len(order))
        selection_start[str(account)] = min(
            len(order),
            max(MIN_HISTORY, math.floor(0.5 * len(order))),
        )
        evaluation_start[str(account)] = min(
            len(order),
            max(
                selection_start[str(account)] + 1,
                math.floor(0.8 * len(order)),
            ),
        )
    return {
        "accounts": accounts,
        "outcomes": outcomes,
        "timestamps": timestamps,
        "orders": orders,
        "positions": positions,
        "selectionStart": selection_start,
        "evaluationStart": evaluation_start,
    }


def timestamp_batches(
    indices: Iterable[int],
    timestamps: np.ndarray,
) -> list[np.ndarray]:
    grouped: dict[float, list[int]] = defaultdict(list)
    for raw_index in indices:
        index = int(raw_index)
        grouped[float(timestamps[index])].append(index)
    return [
        np.asarray(grouped[published_at], dtype=int)
        for published_at in sorted(grouped)
    ]


def phase_indices(context: dict[str, Any], phase: str) -> np.ndarray:
    selected: list[int] = []
    for account, order in context["orders"].items():
        if phase == "selection":
            start = context["selectionStart"][account]
            stop = context["evaluationStart"][account]
        elif phase == "final":
            start = context["evaluationStart"][account]
            stop = len(order)
        elif phase == "prefinal":
            start = MIN_HISTORY
            stop = context["evaluationStart"][account]
        else:
            raise ValueError(phase)
        selected.extend(int(index) for index in order[start:stop])
    return np.asarray(selected, dtype=int)


def strictly_earlier_history(
    index: int,
    context: dict[str, Any],
    freeze_final: bool,
) -> np.ndarray:
    account = str(context["accounts"][index])
    order = context["orders"][account]
    position = int(context["positions"][index])
    prior = order[:position]
    prior = prior[
        context["timestamps"][prior] < context["timestamps"][index]
    ]
    if freeze_final:
        prior = prior[
            context["positions"][prior]
            < context["evaluationStart"][account]
        ]
    return prior


def history_statistics(values: np.ndarray) -> dict[str, float]:
    result: dict[str, float] = {}
    for window in (8, 12, 20, 30, 40):
        sample = values[-min(window, len(values)) :]
        result[f"mean{window}"] = float(np.mean(sample))
    result["meanAll"] = float(np.mean(values))
    result["last"] = float(values[-1])
    for window in (12, 30):
        sample = values[-min(window, len(values)) :]
        result[f"median{window}"] = float(np.median(sample))
    for half_life in (2, 4, 8, 16):
        ages = np.arange(len(values) - 1, -1, -1, dtype=float)
        weights = np.exp2(-ages / half_life)
        result[f"ewma{half_life}"] = float(
            np.sum(weights * values) / np.sum(weights)
        )
    for window in (12, 20, 30):
        sample = values[-min(window, len(values)) :]
        x_values = np.arange(len(sample), dtype=float)
        slope = (
            float(np.polyfit(x_values, sample, 1)[0])
            if len(sample) > 1
            else 0.0
        )
        slope = float(np.clip(slope, -2.0, 2.0))
        result[f"trend{window}"] = float(
            np.mean(sample) + slope * (len(sample) + 1) / 2
        )
    result["std"] = float(
        max(np.std(values[-min(30, len(values)) :]), 4.0)
    )
    return result


def make_causal_centered(
    vectors: np.ndarray,
    context: dict[str, Any],
) -> np.ndarray:
    centered = np.zeros_like(vectors, dtype=np.float64)
    for order in context["orders"].values():
        running_sum = np.zeros(vectors.shape[1], dtype=np.float64)
        running_count = 0
        for batch in timestamp_batches(order, context["timestamps"]):
            prior_mean = (
                running_sum / running_count
                if running_count
                else np.zeros(vectors.shape[1], dtype=np.float64)
            )
            for index in batch:
                centered[index] = vectors[index] - prior_mean
            running_sum += np.sum(vectors[batch], axis=0)
            running_count += len(batch)
    return normalized(centered)


def kernel_ridge_prediction(
    gram: np.ndarray,
    outcomes: np.ndarray,
    history: np.ndarray,
    test_index: int,
    alpha: float,
) -> float:
    kernel = gram[np.ix_(history, history)]
    train_mean = float(np.mean(outcomes[history]))
    centered = outcomes[history] - train_mean
    system = kernel + float(alpha) * np.eye(len(history))
    try:
        weights = np.linalg.solve(system, centered)
    except np.linalg.LinAlgError:
        weights = np.linalg.lstsq(system, centered, rcond=None)[0]
    return float(
        train_mean + gram[test_index, history] @ weights
    )


def weighted_knn(
    similarity: np.ndarray,
    targets: np.ndarray,
    eligible: np.ndarray,
    test_index: int,
    neighbors: int,
    temperature: float,
) -> float:
    if not len(eligible):
        return float("nan")
    similarities = similarity[test_index, eligible]
    count = min(int(neighbors), len(eligible))
    local = np.argpartition(similarities, -count)[-count:]
    chosen = eligible[local]
    chosen_similarity = similarities[local]
    weights = np.exp(
        np.clip(
            float(temperature)
            * (chosen_similarity - np.max(chosen_similarity)),
            -60,
            0,
        )
    )
    return float(
        np.sum(weights * targets[chosen]) / (np.sum(weights) + EPSILON)
    )


def expert_name_history(name: str) -> str:
    return f"history:{name}"


def expert_name_krr(
    modality: str,
    window: int,
    alpha: float,
) -> str:
    return f"krr:{modality}:w{window}:a{alpha:g}"


def expert_name_same_knn(
    modality: str,
    neighbors: int,
    temperature: float,
) -> str:
    return f"sameKnn:{modality}:k{neighbors}:t{temperature:g}"


def expert_name_pooled(
    modality: str,
    neighbors: int,
    temperature: float,
    standardized: bool,
    cross_only: bool,
) -> str:
    suffix = "z" if standardized else "raw"
    scope = "cross" if cross_only else "all"
    return (
        f"pooledKnn:{modality}:k{neighbors}:t{temperature:g}:"
        f"{suffix}:{scope}"
    )


def expert_registry_names() -> tuple[str, ...]:
    names = [expert_name_history(name) for name in HISTORY_NAMES]
    names.extend(
        expert_name_krr(modality, window, alpha)
        for modality, window, alpha in KRR_SPECS
    )
    names.extend(
        expert_name_same_knn(modality, neighbors, temperature)
        for modality, neighbors, temperature in SAME_KNN_SPECS
    )
    names.extend(
        expert_name_pooled(
            modality,
            neighbors,
            temperature,
            standardized,
            cross_only,
        )
        for (
            modality,
            neighbors,
            temperature,
            standardized,
            cross_only,
        ) in POOLED_SPECS
    )
    return tuple(names)


def build_experts(
    rows: list[dict[str, Any]],
    visual: np.ndarray,
    together: np.ndarray,
    context: dict[str, Any],
    freeze_final: bool,
) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    accounts = context["accounts"]
    positions = context["positions"]
    n_rows = len(rows)
    experts = {
        name: np.full(n_rows, np.nan, dtype=np.float64)
        for name in expert_registry_names()
    }
    baseline = np.full(n_rows, np.nan, dtype=np.float64)
    history_scale = np.full(n_rows, np.nan, dtype=np.float64)
    source_valid = np.zeros(n_rows, dtype=bool)
    prior_cache: dict[int, np.ndarray] = {}

    visual_gram = visual @ visual.T
    together_gram = together @ together.T
    grams = {
        "visual": visual_gram,
        "together": together_gram,
        "combined": 0.5 * (visual_gram + together_gram),
    }
    centered_visual = make_causal_centered(visual, context)
    centered_together = make_causal_centered(together, context)
    centered_visual_gram = centered_visual @ centered_visual.T
    centered_together_gram = centered_together @ centered_together.T
    pooled_grams = {
        **grams,
        "centeredVisual": centered_visual_gram,
        "centeredTogether": centered_together_gram,
        "centeredCombined": 0.5
        * (centered_visual_gram + centered_together_gram),
    }

    for index in range(n_rows):
        prior = strictly_earlier_history(index, context, freeze_final)
        prior_cache[index] = prior
        if len(prior) < MIN_HISTORY:
            continue
        stats = history_statistics(outcomes[prior])
        baseline[index] = stats["mean30"]
        history_scale[index] = stats["std"]
        source_valid[index] = True
        for name in HISTORY_NAMES:
            experts[expert_name_history(name)][index] = stats[name]
        for modality, window, alpha in KRR_SPECS:
            history = prior[-min(window, len(prior)) :]
            experts[
                expert_name_krr(modality, window, alpha)
            ][index] = kernel_ridge_prediction(
                grams[modality],
                outcomes,
                history,
                index,
                alpha,
            )
        for modality, neighbors, temperature in SAME_KNN_SPECS:
            experts[
                expert_name_same_knn(
                    modality,
                    neighbors,
                    temperature,
                )
            ][index] = weighted_knn(
                grams[modality],
                outcomes,
                prior,
                index,
                neighbors,
                temperature,
            )

    residual = np.full(n_rows, np.nan, dtype=np.float64)
    standardized_residual = np.full(
        n_rows,
        np.nan,
        dtype=np.float64,
    )
    residual[source_valid] = (
        outcomes[source_valid] - baseline[source_valid]
    )
    standardized_residual[source_valid] = (
        residual[source_valid] / history_scale[source_valid]
    )
    global_order = np.asarray(
        sorted(
            range(n_rows),
            key=lambda index: (
                timestamps[index],
                stable_hash(str(rows[index]["id"])),
            ),
        ),
        dtype=int,
    )
    for index in global_order:
        if not source_valid[index]:
            continue
        eligible = np.flatnonzero(
            source_valid & (timestamps < timestamps[index])
        )
        if freeze_final:
            eligible = eligible[
                np.asarray(
                    [
                        positions[source]
                        < context["evaluationStart"][
                            str(accounts[source])
                        ]
                        for source in eligible
                    ],
                    dtype=bool,
                )
            ]
        for (
            modality,
            neighbors,
            temperature,
            standardized,
            cross_only,
        ) in POOLED_SPECS:
            local_eligible = eligible
            if cross_only:
                local_eligible = local_eligible[
                    accounts[local_eligible] != accounts[index]
                ]
            target = (
                standardized_residual
                if standardized
                else residual
            )
            estimate = weighted_knn(
                pooled_grams[modality],
                target,
                local_eligible,
                int(index),
                neighbors,
                temperature,
            )
            if not finite(estimate):
                continue
            if standardized:
                estimate *= history_scale[index]
            experts[
                expert_name_pooled(
                    modality,
                    neighbors,
                    temperature,
                    standardized,
                    cross_only,
                )
            ][index] = baseline[index] + estimate
    return experts, baseline, history_scale


def metrics(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    indices: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
) -> dict[str, Any]:
    outcomes = context["outcomes"]
    accounts = context["accounts"]
    usable = indices[
        np.isfinite(predicted[indices])
        & np.isfinite(baseline[indices])
    ]
    per_account = []
    for account in sorted(set(accounts[usable]), key=stable_hash):
        local = usable[accounts[usable] == account]
        errors = np.abs(outcomes[local] - predicted[local])
        baseline_errors = np.abs(
            outcomes[local] - baseline[local]
        )
        actual_range = (
            float(np.ptp(outcomes[local])) if len(local) else 0.0
        )
        predicted_range = (
            float(np.ptp(predicted[local])) if len(local) else 0.0
        )
        per_account.append(
            {
                "account": str(account),
                "name": next(
                    row["accountName"]
                    for row in rows
                    if str(row["account"]) == str(account)
                ),
                "n": int(len(local)),
                "mae": float(np.mean(errors)),
                "baselineMae": float(np.mean(baseline_errors)),
                "deltaMae": float(
                    np.mean(errors) - np.mean(baseline_errors)
                ),
                "within10Pct": float(100 * np.mean(errors <= 10)),
                "p90Error": float(np.quantile(errors, 0.9)),
                "actualRange": actual_range,
                "predictedRange": predicted_range,
                "rangeRatio": (
                    predicted_range / actual_range
                    if actual_range
                    else None
                ),
            }
        )
    errors = np.abs(outcomes[usable] - predicted[usable])
    baseline_errors = np.abs(
        outcomes[usable] - baseline[usable]
    )
    actual_range = float(np.ptp(outcomes[usable]))
    predicted_range = float(np.ptp(predicted[usable]))
    return {
        "n": int(len(usable)),
        "mae": float(np.mean(errors)),
        "baselineMae": float(np.mean(baseline_errors)),
        "deltaMae": float(
            np.mean(errors) - np.mean(baseline_errors)
        ),
        "within10Pct": float(100 * np.mean(errors <= 10)),
        "p90Error": float(np.quantile(errors, 0.9)),
        "actualRange": actual_range,
        "predictedRange": predicted_range,
        "rangeRatio": (
            predicted_range / actual_range if actual_range else None
        ),
        "maxAccountMae": max(
            item["mae"] for item in per_account
        ),
        "maxAccountDelta": max(
            item["deltaMae"] for item in per_account
        ),
        "macroMae": float(
            np.mean([item["mae"] for item in per_account])
        ),
        "macroDelta": float(
            np.mean([item["deltaMae"] for item in per_account])
        ),
        "allAccountsWithin10": all(
            item["mae"] <= 10 for item in per_account
        ),
        "allAccountsBeatBaseline": all(
            item["deltaMae"] < 0 for item in per_account
        ),
        "perAccount": per_account,
    }


def account_calibrated_prediction(
    raw: np.ndarray,
    baseline: np.ndarray,
    context: dict[str, Any],
    content_weight: float,
    bias_window: int,
    bias_weight: float,
    gate_window: int,
    gate_margin: float,
    freeze_final: bool,
) -> np.ndarray:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    result = np.full(len(raw), np.nan, dtype=np.float64)
    for account, order in context["orders"].items():
        expert_errors: list[float] = []
        baseline_errors: list[float] = []
        signed_errors: list[float] = []
        final_start = context["evaluationStart"][account]
        for batch in timestamp_batches(order, timestamps):
            valid_batch = [
                int(index)
                for index in batch
                if finite(raw[index]) and finite(baseline[index])
            ]
            if not valid_batch:
                continue
            gate = 1.0
            if gate_window:
                count = min(gate_window, len(expert_errors))
                if count < min(5, gate_window):
                    gate = 0.0
                else:
                    advantage = float(
                        np.mean(baseline_errors[-count:])
                        - np.mean(expert_errors[-count:])
                    )
                    gate = 1.0 if advantage > gate_margin else 0.0
            bias = (
                float(np.mean(signed_errors[-bias_window:]))
                if bias_window and signed_errors
                else 0.0
            )
            for index in valid_batch:
                result[index] = float(
                    np.clip(
                        baseline[index]
                        + gate
                        * content_weight
                        * (raw[index] - baseline[index])
                        + bias_weight * bias,
                        0,
                        100,
                    )
                )
            for index in valid_batch:
                position = int(context["positions"][index])
                if freeze_final and position >= final_start:
                    continue
                expert_errors.append(
                    abs(float(outcomes[index] - raw[index]))
                )
                baseline_errors.append(
                    abs(float(outcomes[index] - baseline[index]))
                )
                signed_errors.append(
                    float(outcomes[index] - result[index])
                )
    return result


def stage1_registry() -> list[dict[str, Any]]:
    entries = []
    expert_names = [
        name
        for name in expert_registry_names()
        if name != "history:mean30"
    ]
    for expert in expert_names:
        for content_weight in (0.5, 0.75, 1.0, 1.25, 1.5):
            for gate_window, gate_margin in (
                (0, 0.0),
                (8, 0.0),
                (12, 0.0),
                (20, 0.0),
                (20, 0.5),
                (30, 0.0),
            ):
                for bias_window, bias_weight in (
                    (0, 0.0),
                    (3, 0.5),
                    (5, 0.5),
                    (8, 0.5),
                    (8, 1.0),
                    (12, 0.5),
                ):
                    entries.append(
                        {
                            "expert": expert,
                            "contentWeight": content_weight,
                            "gateWindow": gate_window,
                            "gateMargin": gate_margin,
                            "biasWindow": bias_window,
                            "biasWeight": bias_weight,
                        }
                    )
    return entries


def stage1_sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    result = item["metrics"]
    return (
        not result["allAccountsWithin10"],
        not (result["rangeRatio"] >= 0.60),
        max(0.0, result["maxAccountDelta"]),
        result["maxAccountMae"],
        result["macroDelta"],
        result["mae"],
        -result["rangeRatio"],
        item["config"]["expert"],
        item["config"]["contentWeight"],
        item["config"]["gateWindow"],
        item["config"]["biasWindow"],
    )


def calibration_slope(
    mode: str,
    x_values: list[float],
    y_values: list[float],
    window: int,
    initial: float,
    ridge: float,
    maximum: float,
    reliability: str,
) -> float:
    if mode == "constant":
        return initial
    count = min(window, len(x_values)) if window else len(x_values)
    if count < 8:
        return initial
    x_array = np.asarray(x_values[-count:], dtype=np.float64)
    y_array = np.asarray(y_values[-count:], dtype=np.float64)
    if mode == "ols":
        slope = float(
            (
                x_array @ y_array + ridge * initial
            )
            / (x_array @ x_array + ridge)
        )
    elif mode == "variance":
        x_std = float(np.std(x_array))
        y_std = float(np.std(y_array))
        ratio = y_std / max(x_std, 0.25)
        corr = (
            float(np.corrcoef(x_array, y_array)[0, 1])
            if x_std > 0 and y_std > 0
            else 0.0
        )
        corr = (
            max(0.0, corr) if math.isfinite(corr) else 0.0
        )
        factors = {
            "none": 1.0,
            "sqrt": math.sqrt(corr),
            "linear": corr,
            "half": 0.5 + 0.5 * corr,
        }
        slope = ratio * factors[reliability]
    else:
        raise ValueError(mode)
    return float(np.clip(slope, 0.0, maximum))


def stage2_registry() -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = []
    bias_options = (
        (0, 0.0),
        (5, 0.5),
        (12, 0.5),
        (12, 1.0),
    )
    gate_options = (
        (0, 0.0),
        (12, 0.0),
        (20, 0.0),
        (30, 0.0),
    )
    for initial in (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0):
        for bias_window, bias_weight in bias_options:
            for gate_window, gate_margin in gate_options:
                configs.append(
                    {
                        "mode": "constant",
                        "window": 0,
                        "initial": initial,
                        "ridge": 0.0,
                        "maximum": initial,
                        "reliability": "none",
                        "biasWindow": bias_window,
                        "biasWeight": bias_weight,
                        "gateWindow": gate_window,
                        "gateMargin": gate_margin,
                    }
                )
    for mode in ("ols", "variance"):
        reliabilities = (
            ("none",)
            if mode == "ols"
            else ("none", "sqrt", "linear", "half")
        )
        for window in (12, 20, 30, 60, 10_000):
            for initial in (0.5, 1.0):
                ridges = (
                    (1.0, 10.0, 50.0)
                    if mode == "ols"
                    else (0.0,)
                )
                for ridge in ridges:
                    for maximum in (1.5, 2.5, 4.0):
                        for reliability in reliabilities:
                            for (
                                bias_window,
                                bias_weight,
                            ) in bias_options:
                                for (
                                    gate_window,
                                    gate_margin,
                                ) in gate_options:
                                    configs.append(
                                        {
                                            "mode": mode,
                                            "window": window,
                                            "initial": initial,
                                            "ridge": ridge,
                                            "maximum": maximum,
                                            "reliability": reliability,
                                            "biasWindow": bias_window,
                                            "biasWeight": bias_weight,
                                            "gateWindow": gate_window,
                                            "gateMargin": gate_margin,
                                        }
                                    )
    return configs


def stage2_prediction(
    raw: np.ndarray,
    baseline: np.ndarray,
    context: dict[str, Any],
    config: dict[str, Any],
    freeze_final: bool,
) -> np.ndarray:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    predicted = np.full(len(raw), np.nan, dtype=np.float64)
    for account, order in context["orders"].items():
        x_values: list[float] = []
        y_values: list[float] = []
        signed_errors: list[float] = []
        expert_errors: list[float] = []
        baseline_errors: list[float] = []
        final_start = context["evaluationStart"][account]
        for batch in timestamp_batches(order, timestamps):
            valid_batch = [
                int(index)
                for index in batch
                if finite(raw[index]) and finite(baseline[index])
            ]
            if not valid_batch:
                continue
            slope = calibration_slope(
                str(config["mode"]),
                x_values,
                y_values,
                int(config["window"]),
                float(config["initial"]),
                float(config["ridge"]),
                float(config["maximum"]),
                str(config["reliability"]),
            )
            gate_window = int(config["gateWindow"])
            if gate_window:
                count = min(gate_window, len(expert_errors))
                if count < 5:
                    gate = 0.0
                else:
                    advantage = float(
                        np.mean(baseline_errors[-count:])
                        - np.mean(expert_errors[-count:])
                    )
                    gate = (
                        1.0
                        if advantage > float(config["gateMargin"])
                        else 0.0
                    )
            else:
                gate = 1.0
            bias_window = int(config["biasWindow"])
            bias = (
                float(np.mean(signed_errors[-bias_window:]))
                if bias_window and signed_errors
                else 0.0
            )
            for index in valid_batch:
                x_value = float(raw[index] - baseline[index])
                predicted[index] = float(
                    np.clip(
                        baseline[index]
                        + gate * slope * x_value
                        + float(config["biasWeight"]) * bias,
                        0,
                        100,
                    )
                )
            for index in valid_batch:
                position = int(context["positions"][index])
                if freeze_final and position >= final_start:
                    continue
                x_value = float(raw[index] - baseline[index])
                y_value = float(outcomes[index] - baseline[index])
                x_values.append(x_value)
                y_values.append(y_value)
                signed_errors.append(
                    float(outcomes[index] - predicted[index])
                )
                expert_errors.append(
                    abs(float(outcomes[index] - raw[index]))
                )
                baseline_errors.append(
                    abs(float(outcomes[index] - baseline[index]))
                )
    return predicted


def stage2_accuracy_key(item: dict[str, Any]) -> tuple[Any, ...]:
    result = item["metrics"]
    return (
        not result["allAccountsWithin10"],
        max(0.0, result["maxAccountDelta"]),
        result["maxAccountMae"],
        result["macroDelta"],
        result["mae"],
        -result["rangeRatio"],
        canonical_bytes(item["config"]),
    )


def eligible_range_ratios(result: dict[str, Any]) -> list[float]:
    return [
        float(item["rangeRatio"])
        for item in result["perAccount"]
        if item["n"] >= 10 and item["rangeRatio"] is not None
    ]


def stage2_range_key(item: dict[str, Any]) -> tuple[Any, ...]:
    result = item["metrics"]
    ratios = eligible_range_ratios(result)
    minimum_ratio = min(ratios) if ratios else 0.0
    return (
        not result["allAccountsWithin10"],
        not result["allAccountsBeatBaseline"],
        minimum_ratio < 0.5,
        max(0.0, result["maxAccountDelta"]),
        -minimum_ratio,
        result["macroDelta"],
        result["mae"],
        canonical_bytes(item["config"]),
    )


def aliased_experts(
    experts: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    return {
        alias: experts[source]
        for alias, source in STAGE3_ALIASES.items()
    }


def feature_matrix(
    aliases: dict[str, np.ndarray],
    baseline: np.ndarray,
    feature_set: str,
) -> tuple[np.ndarray, tuple[str, ...]]:
    names = STAGE3_FEATURE_SETS[feature_set]
    matrix = np.column_stack(
        [aliases[name] - baseline for name in names]
    )
    return matrix, names


def ridge_residual(
    features: np.ndarray,
    target: np.ndarray,
    train: np.ndarray,
    test_index: int,
    alpha: float,
) -> float:
    if len(train) < MIN_HISTORY:
        return 0.0
    x_train = features[train]
    x_test = features[test_index]
    mean = np.mean(x_train, axis=0)
    std = np.maximum(np.std(x_train, axis=0), 0.5)
    standardized = (x_train - mean) / std
    test = (x_test - mean) / std
    y_values = target[train]
    y_mean = float(np.mean(y_values))
    centered_y = y_values - y_mean
    system = (
        standardized.T @ standardized
        + float(alpha) * np.eye(standardized.shape[1])
    )
    try:
        weights = np.linalg.solve(
            system,
            standardized.T @ centered_y,
        )
    except np.linalg.LinAlgError:
        weights = np.linalg.lstsq(
            system,
            standardized.T @ centered_y,
            rcond=None,
        )[0]
    weights = np.clip(weights, -3.0, 3.0)
    return float(y_mean + test @ weights)


def stacked_prediction(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    features: np.ndarray,
    baseline: np.ndarray,
    alpha: float,
    local_weight: float,
    freeze_final: bool,
) -> np.ndarray:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    accounts = context["accounts"]
    positions = context["positions"]
    residual = outcomes - baseline
    complete = (
        np.isfinite(baseline)
        & np.all(np.isfinite(features), axis=1)
    )
    predicted = np.full(len(rows), np.nan, dtype=np.float64)
    global_order = np.asarray(
        sorted(
            range(len(rows)),
            key=lambda index: (
                timestamps[index],
                stable_hash(str(rows[index]["id"])),
            ),
        ),
        dtype=int,
    )
    for batch in timestamp_batches(global_order, timestamps):
        for index in batch:
            if not complete[index]:
                continue
            eligible = np.flatnonzero(
                complete & (timestamps < timestamps[index])
            )
            if freeze_final:
                eligible = eligible[
                    np.asarray(
                        [
                            positions[source]
                            < context["evaluationStart"][
                                str(accounts[source])
                            ]
                            for source in eligible
                        ],
                        dtype=bool,
                    )
                ]
            global_residual = ridge_residual(
                features,
                residual,
                eligible,
                int(index),
                alpha,
            )
            local = eligible[
                accounts[eligible] == accounts[index]
            ]
            if len(local) >= MIN_HISTORY and local_weight:
                local_residual = ridge_residual(
                    features,
                    residual,
                    local,
                    int(index),
                    alpha,
                )
                estimate = (
                    (1 - local_weight) * global_residual
                    + local_weight * local_residual
                )
            else:
                estimate = global_residual
            predicted[index] = float(
                np.clip(baseline[index] + estimate, 0, 100)
            )
    return predicted


def fixed_ensemble(
    aliases: dict[str, np.ndarray],
    names: tuple[str, ...],
) -> np.ndarray:
    matrix = np.column_stack([aliases[name] for name in names])
    valid_count = np.sum(np.isfinite(matrix), axis=1)
    total = np.nansum(matrix, axis=1)
    output = np.full(len(matrix), np.nan, dtype=np.float64)
    valid = valid_count > 0
    output[valid] = total[valid] / valid_count[valid]
    return output


def stage3_base_registry() -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = []
    for name, members in STAGE3_FIXED_SETS.items():
        configs.append(
            {
                "family": "fixed",
                "name": name,
                "members": members,
            }
        )
    for feature_set, features in STAGE3_FEATURE_SETS.items():
        for alpha in (1.0, 10.0, 100.0, 1000.0):
            for local_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
                configs.append(
                    {
                        "family": "stack",
                        "featureSet": feature_set,
                        "features": features,
                        "alpha": alpha,
                        "localWeight": local_weight,
                    }
                )
    return configs


def stage3_registry() -> list[dict[str, Any]]:
    entries = []
    for base_config in stage3_base_registry():
        for bias_window, bias_weight in (
            (0, 0.0),
            (5, 0.5),
            (12, 0.5),
            (12, 1.0),
        ):
            entries.append(
                {
                    **base_config,
                    "biasWindow": bias_window,
                    "biasWeight": bias_weight,
                }
            )
    return entries


def stage3_raw_prediction(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    aliases: dict[str, np.ndarray],
    baseline: np.ndarray,
    base_config: dict[str, Any],
    freeze_final: bool,
) -> np.ndarray:
    if base_config["family"] == "fixed":
        return fixed_ensemble(
            aliases,
            tuple(base_config["members"]),
        )
    features, _ = feature_matrix(
        aliases,
        baseline,
        str(base_config["featureSet"]),
    )
    return stacked_prediction(
        rows,
        context,
        features,
        baseline,
        float(base_config["alpha"]),
        float(base_config["localWeight"]),
        freeze_final,
    )


def without_bias(config: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in config.items()
        if key not in ("biasWindow", "biasWeight")
    }


def generic_selection_key(
    item: dict[str, Any],
) -> tuple[Any, ...]:
    result = item["metrics"]
    return (
        not result["allAccountsWithin10"],
        max(0.0, result["maxAccountDelta"]),
        result["maxAccountMae"],
        result["macroDelta"],
        result["mae"],
        -result["rangeRatio"],
        canonical_bytes(item["config"]),
    )


def stage4_registry() -> list[dict[str, Any]]:
    output = [
        {
            "mode": "fixed",
            "window": 0,
            "minimum": 0,
            "initialWeights": weights,
            "eta": 0.0,
        }
        for weights in (
            (1.0, 0.0, 0.0),
            (0.0, 1.0, 0.0),
            (0.5, 0.5, 0.0),
            (0.5, 0.25, 0.25),
        )
    ]
    for mode in ("hard", "soft"):
        for window in (8, 12, 20, 30, 60, 0):
            for minimum in (5, 8, 12):
                if window and minimum > window:
                    continue
                for initial_weights in (
                    (1.0, 0.0, 0.0),
                    (0.5, 0.5, 0.0),
                    (0.5, 0.25, 0.25),
                ):
                    etas = (
                        (0.1, 0.3, 1.0)
                        if mode == "soft"
                        else (0.0,)
                    )
                    for eta in etas:
                        output.append(
                            {
                                "mode": mode,
                                "window": window,
                                "minimum": minimum,
                                "initialWeights": initial_weights,
                                "eta": eta,
                            }
                        )
    return output


def stage4_prediction(
    prediction_a: np.ndarray,
    prediction_b: np.ndarray,
    baseline: np.ndarray,
    context: dict[str, Any],
    config: dict[str, Any],
    freeze_final: bool,
) -> np.ndarray:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    output = np.full(len(baseline), np.nan, dtype=np.float64)
    for account, order in context["orders"].items():
        errors_a: list[float] = []
        errors_b: list[float] = []
        errors_baseline: list[float] = []
        final_start = context["evaluationStart"][account]
        for batch in timestamp_batches(order, timestamps):
            valid_batch = [
                int(index)
                for index in batch
                if finite(prediction_a[index])
                and finite(prediction_b[index])
                and finite(baseline[index])
            ]
            if not valid_batch:
                continue
            window = int(config["window"])
            count = (
                min(window, len(errors_a))
                if window
                else len(errors_a)
            )
            if (
                config["mode"] == "fixed"
                or count < int(config["minimum"])
            ):
                weights = np.asarray(
                    config["initialWeights"],
                    dtype=np.float64,
                )
            else:
                recent = np.asarray(
                    [
                        np.mean(errors_a[-count:]),
                        np.mean(errors_b[-count:]),
                        np.mean(errors_baseline[-count:]),
                    ],
                    dtype=np.float64,
                )
                if config["mode"] == "hard":
                    weights = np.zeros(3, dtype=np.float64)
                    weights[int(np.argmin(recent))] = 1.0
                elif config["mode"] == "soft":
                    logits = -float(config["eta"]) * (
                        recent - np.min(recent)
                    )
                    weights = np.exp(np.clip(logits, -60, 0))
                else:
                    raise ValueError(str(config["mode"]))
            weights /= np.sum(weights)
            for index in valid_batch:
                components = np.asarray(
                    [
                        prediction_a[index],
                        prediction_b[index],
                        baseline[index],
                    ],
                    dtype=np.float64,
                )
                output[index] = float(
                    np.clip(weights @ components, 0, 100)
                )
            for index in valid_batch:
                position = int(context["positions"][index])
                if freeze_final and position >= final_start:
                    continue
                truth = outcomes[index]
                errors_a.append(
                    abs(float(truth - prediction_a[index]))
                )
                errors_b.append(
                    abs(float(truth - prediction_b[index]))
                )
                errors_baseline.append(
                    abs(float(truth - baseline[index]))
                )
    return output


def full_candidate_registry() -> dict[str, Any]:
    stage_configs = {
        "stage1BroadExperts": stage1_registry(),
        "stage2RangeCalibration": stage2_registry(),
        "stage3SemanticStack": stage3_registry(),
        "stage4LockedMixture": stage4_registry(),
    }
    entries = []
    stage_counts = {}
    offset = 0
    for stage, configs in stage_configs.items():
        stage_counts[stage] = len(configs)
        prefix = f"s{len(stage_counts)}"
        for local_index, config in enumerate(configs):
            entries.append(
                {
                    "id": f"{prefix}-{local_index:05d}",
                    "stage": stage,
                    "config": config,
                }
            )
        offset += len(configs)
    if offset != EXPECTED_CANDIDATE_COUNT:
        raise AssertionError(
            f"candidate registry has {offset}, "
            f"expected {EXPECTED_CANDIDATE_COUNT}"
        )
    return {
        "count": offset,
        "stageCounts": stage_counts,
        "sha256": sha256_json(entries),
        "entries": entries,
    }


def result_digest(
    records: list[dict[str, Any]],
) -> str:
    compact = [
        {
            "id": record["id"],
            "config": record["config"],
            "metrics": record["metrics"],
        }
        for record in records
    ]
    return sha256_json(compact)


def run_selection_stages(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    experts: dict[str, np.ndarray],
    baseline: np.ndarray,
    registry: dict[str, Any],
) -> dict[str, Any]:
    selection = phase_indices(context, "selection")
    entries_by_stage: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in registry["entries"]:
        entries_by_stage[str(entry["stage"])].append(entry)

    stage1_records = []
    for entry in entries_by_stage["stage1BroadExperts"]:
        config = entry["config"]
        predicted = account_calibrated_prediction(
            experts[str(config["expert"])],
            baseline,
            context,
            float(config["contentWeight"]),
            int(config["biasWindow"]),
            float(config["biasWeight"]),
            int(config["gateWindow"]),
            float(config["gateMargin"]),
            freeze_final=True,
        )
        stage1_records.append(
            {
                "id": entry["id"],
                "config": config,
                "metrics": metrics(
                    rows,
                    context,
                    selection,
                    predicted,
                    baseline,
                ),
            }
        )
    stage1_records.sort(key=stage1_sort_key)
    stage1_selected = stage1_records[0]
    stage1_raw = experts[
        str(stage1_selected["config"]["expert"])
    ]

    stage2_records = []
    for entry in entries_by_stage["stage2RangeCalibration"]:
        config = entry["config"]
        predicted = stage2_prediction(
            stage1_raw,
            baseline,
            context,
            config,
            freeze_final=True,
        )
        stage2_records.append(
            {
                "id": entry["id"],
                "config": config,
                "metrics": metrics(
                    rows,
                    context,
                    selection,
                    predicted,
                    baseline,
                ),
            }
        )
    stage2_accuracy = min(
        stage2_records,
        key=stage2_accuracy_key,
    )
    stage2_range = min(
        stage2_records,
        key=stage2_range_key,
    )
    prediction_a = stage2_prediction(
        stage1_raw,
        baseline,
        context,
        stage2_accuracy["config"],
        freeze_final=True,
    )

    aliases = aliased_experts(experts)
    stage3_raw_cache: dict[bytes, np.ndarray] = {}
    stage3_records = []
    for entry in entries_by_stage["stage3SemanticStack"]:
        config = entry["config"]
        base_config = without_bias(config)
        cache_key = canonical_bytes(base_config)
        if cache_key not in stage3_raw_cache:
            stage3_raw_cache[cache_key] = stage3_raw_prediction(
                rows,
                context,
                aliases,
                baseline,
                base_config,
                freeze_final=True,
            )
        raw = stage3_raw_cache[cache_key]
        predicted = account_calibrated_prediction(
            raw,
            baseline,
            context,
            1.0,
            int(config["biasWindow"]),
            float(config["biasWeight"]),
            0,
            0.0,
            freeze_final=True,
        )
        stage3_records.append(
            {
                "id": entry["id"],
                "config": config,
                "metrics": metrics(
                    rows,
                    context,
                    selection,
                    predicted,
                    baseline,
                ),
            }
        )
    stage3_records.sort(key=generic_selection_key)
    stage3_selected = stage3_records[0]
    stage3_raw = stage3_raw_cache[
        canonical_bytes(without_bias(stage3_selected["config"]))
    ]
    prediction_b = account_calibrated_prediction(
        stage3_raw,
        baseline,
        context,
        1.0,
        int(stage3_selected["config"]["biasWindow"]),
        float(stage3_selected["config"]["biasWeight"]),
        0,
        0.0,
        freeze_final=True,
    )

    stage4_records = []
    stage4_prediction_cache: dict[bytes, np.ndarray] = {}
    for entry in entries_by_stage["stage4LockedMixture"]:
        config = entry["config"]
        predicted = stage4_prediction(
            prediction_a,
            prediction_b,
            baseline,
            context,
            config,
            freeze_final=True,
        )
        stage4_prediction_cache[canonical_bytes(config)] = predicted
        stage4_records.append(
            {
                "id": entry["id"],
                "config": config,
                "metrics": metrics(
                    rows,
                    context,
                    selection,
                    predicted,
                    baseline,
                ),
            }
        )
    stage4_records.sort(key=generic_selection_key)
    stage4_selected = stage4_records[0]
    winner = stage4_prediction_cache[
        canonical_bytes(stage4_selected["config"])
    ]

    expected = {
        "stage1Expert": (
            "pooledKnn:centeredTogether:k12:t15:z:all"
        ),
        "stage2": {
            "mode": "constant",
            "window": 0,
            "initial": 0.5,
            "ridge": 0.0,
            "maximum": 0.5,
            "reliability": "none",
            "biasWindow": 12,
            "biasWeight": 1.0,
            "gateWindow": 0,
            "gateMargin": 0.0,
        },
        "stage3": {
            "family": "stack",
            "featureSet": "semanticWide",
            "features": STAGE3_FEATURE_SETS["semanticWide"],
            "alpha": 1.0,
            "localWeight": 0.0,
            "biasWindow": 0,
            "biasWeight": 0.0,
        },
        "stage4": {
            "mode": "fixed",
            "window": 0,
            "minimum": 0,
            "initialWeights": (0.5, 0.5, 0.0),
            "eta": 0.0,
        },
    }
    if stage1_selected["config"]["expert"] != expected["stage1Expert"]:
        raise AssertionError(
            "equal-time replay changed the preregistered stage-1 expert: "
            f"{stage1_selected['config']['expert']}"
        )
    if stage2_accuracy["config"] != expected["stage2"]:
        raise AssertionError(
            "equal-time replay changed the preregistered stage-2 winner"
        )
    if stage3_selected["config"] != expected["stage3"]:
        raise AssertionError(
            "equal-time replay changed the preregistered stage-3 winner"
        )
    if stage4_selected["config"] != expected["stage4"]:
        raise AssertionError(
            "equal-time replay changed the preregistered 50/50 winner"
        )

    return {
        "selectionIndices": selection,
        "predictionA": prediction_a,
        "predictionB": prediction_b,
        "winnerPrediction": winner,
        "stage1": {
            "selected": stage1_selected,
            "leaderboard": stage1_records[:25],
            "selectionResultLedgerSha256": result_digest(
                sorted(stage1_records, key=lambda item: item["id"])
            ),
        },
        "stage2": {
            "accuracySelected": stage2_accuracy,
            "rangeSelected": stage2_range,
            "accuracyLeaderboard": sorted(
                stage2_records,
                key=stage2_accuracy_key,
            )[:20],
            "rangeLeaderboard": sorted(
                stage2_records,
                key=stage2_range_key,
            )[:20],
            "selectionResultLedgerSha256": result_digest(
                sorted(stage2_records, key=lambda item: item["id"])
            ),
        },
        "stage3": {
            "selected": stage3_selected,
            "leaderboard": stage3_records[:30],
            "selectionResultLedgerSha256": result_digest(
                sorted(stage3_records, key=lambda item: item["id"])
            ),
        },
        "stage4": {
            "selected": stage4_selected,
            "leaderboard": stage4_records[:20],
            "selectionResultLedgerSha256": result_digest(
                sorted(stage4_records, key=lambda item: item["id"])
            ),
        },
        "lockedFormula": {
            "coordinateId": "shorts.causal-keep-mixture.v1",
            "label": "Causal keep-rate mixture",
            "modalityClass": "multimodal",
            "inputs": [
                "Together embedding (visual plus text)",
                "Visual embedding",
                "Strictly earlier same-creator keep history",
            ],
            "formula": (
                "0.5 * stage2 centered-together pooled residual analog "
                "+ 0.5 * stage3 visual+together semantic stack"
            ),
            "stage1": stage1_selected["config"],
            "stage2": stage2_accuracy["config"],
            "stage3": stage3_selected["config"],
            "stage4": stage4_selected["config"],
        },
    }


def reconstruct_locked_predictions(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    experts: dict[str, np.ndarray],
    baseline: np.ndarray,
    locked: dict[str, Any],
    freeze_final: bool,
) -> dict[str, np.ndarray]:
    stage1_raw = experts[str(locked["stage1"]["expert"])]
    prediction_a = stage2_prediction(
        stage1_raw,
        baseline,
        context,
        locked["stage2"],
        freeze_final,
    )
    aliases = aliased_experts(experts)
    stage3_raw = stage3_raw_prediction(
        rows,
        context,
        aliases,
        baseline,
        without_bias(locked["stage3"]),
        freeze_final,
    )
    prediction_b = account_calibrated_prediction(
        stage3_raw,
        baseline,
        context,
        1.0,
        int(locked["stage3"]["biasWindow"]),
        float(locked["stage3"]["biasWeight"]),
        0,
        0.0,
        freeze_final,
    )
    winner = stage4_prediction(
        prediction_a,
        prediction_b,
        baseline,
        context,
        locked["stage4"],
        freeze_final,
    )
    return {
        "componentA": prediction_a,
        "componentB": prediction_b,
        "winner": winner,
    }


def custom_stack_prediction(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    aliases: dict[str, np.ndarray],
    baseline: np.ndarray,
    names: tuple[str, ...],
    locked_stage3: dict[str, Any],
    freeze_final: bool,
) -> np.ndarray:
    features = np.column_stack(
        [aliases[name] - baseline for name in names]
    )
    raw = stacked_prediction(
        rows,
        context,
        features,
        baseline,
        float(locked_stage3["alpha"]),
        float(locked_stage3["localWeight"]),
        freeze_final,
    )
    return account_calibrated_prediction(
        raw,
        baseline,
        context,
        1.0,
        int(locked_stage3["biasWindow"]),
        float(locked_stage3["biasWeight"]),
        0,
        0.0,
        freeze_final,
    )


def modality_predictions(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    experts: dict[str, np.ndarray],
    baseline: np.ndarray,
    locked: dict[str, Any],
    selected: dict[str, np.ndarray],
    freeze_final: bool,
) -> dict[str, dict[str, Any]]:
    aliases = aliased_experts(experts)
    visual_a = stage2_prediction(
        experts["pooledKnn:centeredVisual:k12:t15:z:all"],
        baseline,
        context,
        locked["stage2"],
        freeze_final,
    )
    visual_b = custom_stack_prediction(
        rows,
        context,
        aliases,
        baseline,
        ("cv12", "cv24", "krrVisual"),
        locked["stage3"],
        freeze_final,
    )
    visual = stage4_prediction(
        visual_a,
        visual_b,
        baseline,
        context,
        locked["stage4"],
        freeze_final,
    )

    together_a = stage2_prediction(
        experts[
            "pooledKnn:centeredTogether:k12:t15:z:all"
        ],
        baseline,
        context,
        locked["stage2"],
        freeze_final,
    )
    together_b = custom_stack_prediction(
        rows,
        context,
        aliases,
        baseline,
        ("ct12", "ct24", "ct48", "krrTogether"),
        locked["stage3"],
        freeze_final,
    )
    together_only = stage4_prediction(
        together_a,
        together_b,
        baseline,
        context,
        locked["stage4"],
        freeze_final,
    )
    return {
        "historyOnly": {
            "label": "History only",
            "modalityClass": "history-only",
            "formula": (
                "Mean keep rate of up to 30 strictly earlier "
                "same-creator uploads"
            ),
            "prediction": baseline.copy(),
        },
        "visualOnlyChallenger": {
            "label": "Visual-only challenger",
            "modalityClass": "visual-only",
            "formula": (
                "50/50 blend of the centered-visual pooled analog "
                "and visual-only semantic stack; selected "
                "hyperparameters held fixed"
            ),
            "prediction": visual,
        },
        "togetherOnlyChallenger": {
            "label": "Together-only challenger",
            "modalityClass": (
                "multimodal together embedding (visual plus text)"
            ),
            "formula": (
                "50/50 blend of the centered-together pooled analog "
                "and together-only semantic stack; selected "
                "hyperparameters held fixed"
            ),
            "prediction": together_only,
        },
        "multimodalSelected": {
            "label": "Selected visual+together mixture",
            "modalityClass": "multimodal",
            "formula": locked["formula"],
            "prediction": selected["winner"],
        },
    }


def modality_ablation_metrics(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    indices: np.ndarray,
    baseline: np.ndarray,
    predictions: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    output = {}
    for key, item in predictions.items():
        output[key] = {
            "label": item["label"],
            "modalityClass": item["modalityClass"],
            "formula": item["formula"],
            "metrics": metrics(
                rows,
                context,
                indices,
                item["prediction"],
                baseline,
            ),
        }
    return output


def conformal_radius(
    absolute_errors: list[float],
    coverage: float,
) -> float | None:
    if not absolute_errors:
        return None
    ordered = np.sort(np.asarray(absolute_errors, dtype=np.float64))
    rank = math.ceil((len(ordered) + 1) * coverage)
    index = min(len(ordered) - 1, max(0, rank - 1))
    return float(ordered[index])


def causal_prediction_intervals(
    predicted: np.ndarray,
    context: dict[str, Any],
    freeze_final: bool,
) -> list[dict[str, Any] | None]:
    outcomes = context["outcomes"]
    timestamps = context["timestamps"]
    accounts = context["accounts"]
    global_order = np.asarray(
        sorted(
            range(len(predicted)),
            key=lambda index: (
                timestamps[index],
                stable_hash(str(index)),
            ),
        ),
        dtype=int,
    )
    account_errors: dict[str, list[float]] = defaultdict(list)
    global_errors: list[float] = []
    intervals: list[dict[str, Any] | None] = [
        None for _ in range(len(predicted))
    ]
    for batch in timestamp_batches(global_order, timestamps):
        for index in batch:
            if not finite(predicted[index]):
                continue
            account = str(accounts[index])
            if len(account_errors[account]) >= MIN_HISTORY:
                calibration = account_errors[account]
                source = "same-account strictly earlier residuals"
            else:
                calibration = global_errors
                source = "pooled strictly earlier residuals"
            values: dict[str, Any] = {
                "calibrationSource": source,
                "calibrationN": len(calibration),
            }
            for coverage in INTERVAL_COVERAGES:
                radius = conformal_radius(calibration, coverage)
                key = f"p{int(coverage * 100)}"
                values[key] = (
                    {
                        "coverage": coverage,
                        "radius": radius,
                        "lower": float(
                            max(0.0, predicted[index] - radius)
                        ),
                        "upper": float(
                            min(100.0, predicted[index] + radius)
                        ),
                    }
                    if radius is not None
                    else None
                )
            intervals[index] = values
        batch_errors: list[tuple[str, float]] = []
        for index in batch:
            if not finite(predicted[index]):
                continue
            account = str(accounts[index])
            position = int(context["positions"][index])
            if (
                freeze_final
                and position >= context["evaluationStart"][account]
            ):
                continue
            batch_errors.append(
                (
                    account,
                    abs(float(outcomes[index] - predicted[index])),
                )
            )
        for account, error in batch_errors:
            account_errors[account].append(error)
            global_errors.append(error)
    return intervals


def interval_metrics(
    context: dict[str, Any],
    indices: np.ndarray,
    intervals: list[dict[str, Any] | None],
) -> dict[str, Any]:
    outcomes = context["outcomes"]
    accounts = context["accounts"]

    def summarize(local: np.ndarray) -> dict[str, Any]:
        output = {}
        for coverage in INTERVAL_COVERAGES:
            key = f"p{int(coverage * 100)}"
            usable = [
                int(index)
                for index in local
                if intervals[int(index)]
                and intervals[int(index)][key] is not None
            ]
            if not usable:
                output[key] = {
                    "n": 0,
                    "empiricalCoverage": None,
                    "meanWidth": None,
                }
                continue
            covered = [
                intervals[index][key]["lower"]
                <= outcomes[index]
                <= intervals[index][key]["upper"]
                for index in usable
            ]
            widths = [
                intervals[index][key]["upper"]
                - intervals[index][key]["lower"]
                for index in usable
            ]
            output[key] = {
                "n": len(usable),
                "empiricalCoverage": float(np.mean(covered)),
                "meanWidth": float(np.mean(widths)),
            }
        return output

    per_account = {}
    for account in sorted(set(accounts[indices]), key=stable_hash):
        local = indices[accounts[indices] == account]
        per_account[str(account)] = summarize(local)
    return {
        "method": (
            "Finite-sample symmetric conformal interval from absolute "
            "strictly earlier residuals; same-account after eight "
            "calibration points, otherwise pooled."
        ),
        "overall": summarize(indices),
        "perAccount": per_account,
    }


def build_points(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    indices: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
    components: dict[str, np.ndarray],
    intervals: list[dict[str, Any] | None],
    freeze_final: bool,
) -> dict[str, list[dict[str, Any]]]:
    outcomes = context["outcomes"]
    accounts = context["accounts"]
    output: dict[str, list[dict[str, Any]]] = {}
    for account in sorted(set(accounts[indices]), key=stable_hash):
        local = indices[accounts[indices] == account]
        local = np.asarray(
            sorted(
                (int(index) for index in local),
                key=lambda index: (
                    context["timestamps"][index],
                    stable_hash(str(rows[index]["id"])),
                ),
            ),
            dtype=int,
        )
        points = []
        for index in local:
            if not (
                finite(predicted[index])
                and finite(baseline[index])
            ):
                continue
            history = strictly_earlier_history(
                int(index),
                context,
                freeze_final,
            )
            history = history[-min(30, len(history)) :]
            points.append(
                {
                    "id": str(rows[index]["id"]),
                    "title": str(rows[index]["title"]),
                    "publishedAt": float(
                        context["timestamps"][index]
                    ),
                    "accountPosition": int(
                        context["positions"][index]
                    ),
                    "actualKeep": float(outcomes[index]),
                    "historyBaseline": float(baseline[index]),
                    "historyN": int(len(history)),
                    "historyVideoIds": [
                        str(rows[int(source)]["id"])
                        for source in history
                    ],
                    "componentA": (
                        float(components["componentA"][index])
                        if finite(components["componentA"][index])
                        else None
                    ),
                    "componentB": (
                        float(components["componentB"][index])
                        if finite(components["componentB"][index])
                        else None
                    ),
                    "predictedKeep": float(predicted[index]),
                    "absoluteError": abs(
                        float(outcomes[index] - predicted[index])
                    ),
                    "baselineAbsoluteError": abs(
                        float(outcomes[index] - baseline[index])
                    ),
                    "deltaAbsoluteError": float(
                        abs(outcomes[index] - predicted[index])
                        - abs(outcomes[index] - baseline[index])
                    ),
                    "predictionIntervals": intervals[index],
                }
            )
        output[str(account)] = points
    return output


def rolling_block_stability(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
    predicted: np.ndarray,
    baseline: np.ndarray,
) -> dict[str, Any]:
    accounts = context["accounts"]
    blocks: list[list[int]] = [[], [], [], []]
    account_assignments: dict[str, list[list[str]]] = {}
    for account, order in context["orders"].items():
        prefinal = order[
            MIN_HISTORY : context["evaluationStart"][account]
        ]
        prefinal = np.asarray(
            [
                int(index)
                for index in prefinal
                if finite(predicted[index])
                and finite(baseline[index])
            ],
            dtype=int,
        )
        chunks = np.array_split(prefinal, 4)
        account_assignments[account] = []
        for block_index, chunk in enumerate(chunks):
            blocks[block_index].extend(int(index) for index in chunk)
            account_assignments[account].append(
                [str(rows[int(index)]["id"]) for index in chunk]
            )
    results = []
    for block_index, raw_indices in enumerate(blocks):
        indices = np.asarray(raw_indices, dtype=int)
        results.append(
            {
                "block": block_index + 1,
                "label": f"prefinal chronological quartile {block_index + 1}",
                "metrics": metrics(
                    rows,
                    context,
                    indices,
                    predicted,
                    baseline,
                ),
                "perAccountVideoIds": {
                    account: account_assignments[account][block_index]
                    for account in sorted(
                        account_assignments,
                        key=stable_hash,
                    )
                },
            }
        )
    return {
        "status": "retrospective stability audit, not a blind claim",
        "formulaRetunedPerBlock": False,
        "matchedBaseline": (
            "The exact same recent-30 strictly earlier creator "
            "baseline used by the selected prediction at every point."
        ),
        "warning": (
            "The locked formula was selected on the 50%-80% window, "
            "which overlaps later prefinal blocks. These blocks test "
            "temporal stability only and are separate from the final-tail "
            "claim."
        ),
        "partition": (
            "For each account, all causally scorable rows from minimum "
            "history through the 80% boundary are split into four "
            "non-overlapping chronological chunks with numpy.array_split."
        ),
        "blocks": results,
    }


def circular_block_sample(
    values: np.ndarray,
    block_size: int,
    rng: np.random.Generator,
) -> np.ndarray:
    count = len(values)
    if count <= 3:
        return values[rng.integers(0, count, count)]
    pieces = []
    total = 0
    while total < count:
        start = int(rng.integers(0, count))
        indices = (start + np.arange(block_size)) % count
        piece = values[indices]
        pieces.append(piece)
        total += len(piece)
    return np.concatenate(pieces)[:count]


def quantile_interval(values: np.ndarray) -> list[float]:
    return [
        float(np.quantile(values, 0.025)),
        float(np.quantile(values, 0.975)),
    ]


def uncertainty_audit(
    context: dict[str, Any],
    indices: np.ndarray,
    predicted: np.ndarray,
    baseline: np.ndarray,
) -> dict[str, Any]:
    outcomes = context["outcomes"]
    accounts = context["accounts"]
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    per_account = []
    account_pairs: dict[str, np.ndarray] = {}
    for account in sorted(set(accounts[indices]), key=stable_hash):
        local = indices[accounts[indices] == account]
        model_error = np.abs(
            outcomes[local] - predicted[local]
        )
        baseline_error = np.abs(
            outcomes[local] - baseline[local]
        )
        paired = np.column_stack([model_error, baseline_error])
        account_pairs[str(account)] = paired
        block_size = max(1, round(len(local) ** (1 / 3)))
        model_means = np.empty(
            BOOTSTRAP_REPLICATES,
            dtype=np.float64,
        )
        deltas = np.empty(
            BOOTSTRAP_REPLICATES,
            dtype=np.float64,
        )
        for replicate in range(BOOTSTRAP_REPLICATES):
            sample = circular_block_sample(
                paired,
                block_size,
                rng,
            )
            model_means[replicate] = np.mean(sample[:, 0])
            deltas[replicate] = np.mean(
                sample[:, 0] - sample[:, 1]
            )
        per_account.append(
            {
                "account": str(account),
                "n": int(len(local)),
                "blockSize": block_size,
                "mae": float(np.mean(model_error)),
                "mae95": quantile_interval(model_means),
                "probabilityMaeAtMost10": float(
                    np.mean(model_means <= 10)
                ),
                "deltaMae": float(
                    np.mean(model_error - baseline_error)
                ),
                "deltaMae95": quantile_interval(deltas),
                "probabilityBeatsBaseline": float(
                    np.mean(deltas < 0)
                ),
            }
        )
    pooled_model = np.empty(
        BOOTSTRAP_REPLICATES,
        dtype=np.float64,
    )
    pooled_delta = np.empty(
        BOOTSTRAP_REPLICATES,
        dtype=np.float64,
    )
    for replicate in range(BOOTSTRAP_REPLICATES):
        samples = []
        for account in sorted(account_pairs, key=stable_hash):
            paired = account_pairs[account]
            block_size = max(1, round(len(paired) ** (1 / 3)))
            samples.append(
                circular_block_sample(paired, block_size, rng)
            )
        pooled = np.concatenate(samples)
        pooled_model[replicate] = np.mean(pooled[:, 0])
        pooled_delta[replicate] = np.mean(
            pooled[:, 0] - pooled[:, 1]
        )
    return {
        "seed": BOOTSTRAP_SEED,
        "replicates": BOOTSTRAP_REPLICATES,
        "method": (
            "Paired circular moving-block bootstrap within account; "
            "the three-row account uses ordinary paired resampling. "
            "The pooled interval resamples every account separately "
            "before concatenation."
        ),
        "overall": {
            "mae95": quantile_interval(pooled_model),
            "deltaMae95": quantile_interval(pooled_delta),
            "probabilityMaeAtMost10": float(
                np.mean(pooled_model <= 10)
            ),
            "probabilityBeatsBaseline": float(
                np.mean(pooled_delta < 0)
            ),
        },
        "perAccount": per_account,
    }


def equal_timestamp_audit(
    rows: list[dict[str, Any]],
    context: dict[str, Any],
) -> dict[str, Any]:
    batches = []
    for account, order in context["orders"].items():
        for batch in timestamp_batches(
            order,
            context["timestamps"],
        ):
            if len(batch) <= 1:
                continue
            batches.append(
                {
                    "account": account,
                    "publishedAt": float(
                        context["timestamps"][batch[0]]
                    ),
                    "videoIds": [
                        str(rows[int(index)]["id"])
                        for index in batch
                    ],
                }
            )
    return {
        "policy": (
            "All features may use rows with publishedAt strictly less "
            "than the target. Creator centering, rolling corrections, "
            "expert gates, mixture weights, and conformal residual "
            "stores update only after the entire equal-time batch is "
            "predicted."
        ),
        "batchCount": len(batches),
        "rowCount": sum(
            len(batch["videoIds"]) for batch in batches
        ),
        "batches": batches,
    }


def dataset_fingerprints(
    rows: list[dict[str, Any]],
    visual: np.ndarray,
    together: np.ndarray,
) -> dict[str, Any]:
    row_manifest = [
        {
            "id": str(row["id"]),
            "account": str(row["account"]),
            "accountName": str(row["accountName"]),
            "keep": float(row["keep"]),
            "publishedAt": float(row["publishedAt"]),
            "title": str(row["title"]),
        }
        for row in rows
    ]
    visual_hash = hashlib.sha256(
        np.asarray(visual, dtype="<f8").tobytes(order="C")
    ).hexdigest()
    together_hash = hashlib.sha256(
        np.asarray(together, dtype="<f8").tobytes(order="C")
    ).hexdigest()
    manifest_hash = sha256_json(row_manifest)
    combined = hashlib.sha256()
    combined.update(bytes.fromhex(manifest_hash))
    combined.update(bytes.fromhex(visual_hash))
    combined.update(bytes.fromhex(together_hash))
    return {
        "rowManifestSha256": manifest_hash,
        "visualMatrixSha256": visual_hash,
        "togetherMatrixSha256": together_hash,
        "combinedSha256": combined.hexdigest(),
        "visualShape": list(visual.shape),
        "togetherShape": list(together.shape),
    }


def serializable_selection(
    selection: dict[str, Any],
) -> dict[str, Any]:
    return {
        "stage1BroadExperts": selection["stage1"],
        "stage2RangeCalibration": selection["stage2"],
        "stage3SemanticStack": selection["stage3"],
        "stage4LockedMixture": selection["stage4"],
        "lockedFormula": selection["lockedFormula"],
    }


def main() -> None:
    predictor = load_predictor()
    rows, visual, together = load_canonical_data(predictor)
    context = build_context(rows)
    registry = full_candidate_registry()
    selection_indices = phase_indices(context, "selection")
    final_indices = phase_indices(context, "final")

    frozen_experts, frozen_baseline, _ = build_experts(
        rows,
        visual,
        together,
        context,
        freeze_final=True,
    )
    selection = run_selection_stages(
        rows,
        context,
        frozen_experts,
        frozen_baseline,
        registry,
    )
    locked = selection["lockedFormula"]
    frozen_predictions = reconstruct_locked_predictions(
        rows,
        context,
        frozen_experts,
        frozen_baseline,
        locked,
        freeze_final=True,
    )
    if not np.allclose(
        selection["winnerPrediction"],
        frozen_predictions["winner"],
        equal_nan=True,
    ):
        raise AssertionError(
            "locked formula did not reproduce its selection prediction"
        )

    selection_intervals = causal_prediction_intervals(
        frozen_predictions["winner"],
        context,
        freeze_final=True,
    )
    frozen_intervals = selection_intervals
    selection_modalities = modality_predictions(
        rows,
        context,
        frozen_experts,
        frozen_baseline,
        locked,
        frozen_predictions,
        freeze_final=True,
    )
    frozen_modalities = selection_modalities

    prequential_experts, prequential_baseline, _ = build_experts(
        rows,
        visual,
        together,
        context,
        freeze_final=False,
    )
    prequential_predictions = reconstruct_locked_predictions(
        rows,
        context,
        prequential_experts,
        prequential_baseline,
        locked,
        freeze_final=False,
    )
    prequential_intervals = causal_prediction_intervals(
        prequential_predictions["winner"],
        context,
        freeze_final=False,
    )
    prequential_modalities = modality_predictions(
        rows,
        context,
        prequential_experts,
        prequential_baseline,
        locked,
        prequential_predictions,
        freeze_final=False,
    )

    selection_metrics = metrics(
        rows,
        context,
        selection_indices,
        frozen_predictions["winner"],
        frozen_baseline,
    )
    frozen_metrics = metrics(
        rows,
        context,
        final_indices,
        frozen_predictions["winner"],
        frozen_baseline,
    )
    prequential_metrics = metrics(
        rows,
        context,
        final_indices,
        prequential_predictions["winner"],
        prequential_baseline,
    )

    account_counts = {
        account: int(np.sum(context["accounts"] == account))
        for account in sorted(
            set(context["accounts"]),
            key=stable_hash,
        )
    }
    source_provenance = {
        key: value
        for key, value in sorted(
            predictor.READ_PROVENANCE.items()
        )
    }
    payload = {
        "schemaVersion": 1,
        "benchmarkId": "shorts.causal-keep-mixture-benchmark.v1",
        "coordinate": {
            "id": "shorts.causal-keep-mixture.v1",
            "label": "Causal keep-rate mixture",
            "modalityClass": "multimodal",
            "warning": (
                "This coordinate uses the together visual+text "
                "embedding and must not be labeled visual-only."
            ),
        },
        "runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "floatDtype": "float64",
            "blasThreadsControlled": False,
        },
        "determinism": {
            "stableOrder": (
                "publishedAt ascending, then SHA-256(video id)"
            ),
            "candidateRegistryHashAlgorithm": (
                "SHA-256 of canonical sorted-key compact JSON"
            ),
            "bootstrapSeed": BOOTSTRAP_SEED,
            "bootstrapReplicates": BOOTSTRAP_REPLICATES,
            "randomizedModelSteps": [],
        },
        "sourceProvenance": source_provenance,
        "dataset": {
            "n": len(rows),
            "accounts": account_counts,
            "selectionN": int(len(selection_indices)),
            "finalN": int(len(final_indices)),
            "fingerprints": dataset_fingerprints(
                rows,
                visual,
                together,
            ),
        },
        "equalTimestampAudit": equal_timestamp_audit(
            rows,
            context,
        ),
        "protocol": {
            "minimumHistoryN": MIN_HISTORY,
            "historyBaseline": {
                "formula": (
                    "Arithmetic mean keep rate of at most the 30 "
                    "most recent same-account rows with publishedAt "
                    "strictly less than the target."
                ),
                "unit": "keep-rate percentage points",
            },
            "selectionWindow": (
                "Per-account chronological 50%-80% positions."
            ),
            "frozenFinalTail": (
                "Per-account final 20%. No outcome from any account's "
                "final segment may fit a model, rolling correction, "
                "mixture state, or interval before any frozen-tail "
                "prediction."
            ),
            "causalPrequentialTail": (
                "The same final 20%, allowing an outcome only after "
                "its equal-timestamp batch has been predicted, so it "
                "may inform strictly later uploads."
            ),
            "prelockedSelection": {
                "finalMetricsVisibleToSelection": False,
                "stageOrder": [
                    "stage1BroadExperts",
                    "stage2RangeCalibration",
                    "stage3SemanticStack",
                    "stage4LockedMixture",
                ],
                "candidateCount": EXPECTED_CANDIDATE_COUNT,
                "claimBoundary": (
                    "The final 20% was not read by this script's "
                    "candidate selection. Earlier repository research "
                    "had already inspected these historical rows, so "
                    "this is a retrospective holdout rather than a "
                    "virgin prospective cohort."
                ),
            },
        },
        "candidateRegistry": registry,
        "selection": {
            "metrics": selection_metrics,
            "stages": serializable_selection(selection),
            "modalityAblations": modality_ablation_metrics(
                rows,
                context,
                selection_indices,
                frozen_baseline,
                selection_modalities,
            ),
            "predictionIntervals": interval_metrics(
                context,
                selection_indices,
                selection_intervals,
            ),
            "pointsByAccount": build_points(
                rows,
                context,
                selection_indices,
                frozen_predictions["winner"],
                frozen_baseline,
                frozen_predictions,
                selection_intervals,
                freeze_final=True,
            ),
        },
        "rollingBlockStability": rolling_block_stability(
            rows,
            context,
            frozen_predictions["winner"],
            frozen_baseline,
        ),
        "final": {
            "frozenTail": {
                "metrics": frozen_metrics,
                "modalityAblations": modality_ablation_metrics(
                    rows,
                    context,
                    final_indices,
                    frozen_baseline,
                    frozen_modalities,
                ),
                "predictionIntervals": interval_metrics(
                    context,
                    final_indices,
                    frozen_intervals,
                ),
                "pointsByAccount": build_points(
                    rows,
                    context,
                    final_indices,
                    frozen_predictions["winner"],
                    frozen_baseline,
                    frozen_predictions,
                    frozen_intervals,
                    freeze_final=True,
                ),
                "uncertainty": uncertainty_audit(
                    context,
                    final_indices,
                    frozen_predictions["winner"],
                    frozen_baseline,
                ),
            },
            "causalPrequentialTail": {
                "metrics": prequential_metrics,
                "modalityAblations": modality_ablation_metrics(
                    rows,
                    context,
                    final_indices,
                    prequential_baseline,
                    prequential_modalities,
                ),
                "predictionIntervals": interval_metrics(
                    context,
                    final_indices,
                    prequential_intervals,
                ),
                "pointsByAccount": build_points(
                    rows,
                    context,
                    final_indices,
                    prequential_predictions["winner"],
                    prequential_baseline,
                    prequential_predictions,
                    prequential_intervals,
                    freeze_final=False,
                ),
            },
        },
    }
    payload["resultCoreSha256"] = sha256_json(
        {
            "dataset": payload["dataset"],
            "registrySha256": registry["sha256"],
            "selectionMetrics": selection_metrics,
            "frozenMetrics": frozen_metrics,
            "prequentialMetrics": prequential_metrics,
            "lockedFormula": locked,
        }
    )
    OUTPUT.write_bytes(canonical_bytes(payload) + b"\n")
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(OUTPUT),
                "candidateCount": registry["count"],
                "candidateRegistrySha256": registry["sha256"],
                "resultCoreSha256": payload["resultCoreSha256"],
                "selection": selection_metrics,
                "frozenTail": frozen_metrics,
                "causalPrequentialTail": prequential_metrics,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
