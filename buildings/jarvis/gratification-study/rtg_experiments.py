"""Registered high-throughput experiment engine for RTG construct discovery."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from scipy.stats import rankdata, t as student_t
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.model_selection import GroupKFold

from build_study import TitleCorpusBasis, normalize_rows
from rtg_components import align_hook_words, tokenize
from rtg_geometry import MetricDef, finite, ret_at, safe_float


EPS = 1e-9
RIDGE_ALPHAS = (0.1, 1.0, 10.0, 100.0)


@dataclass(frozen=True)
class ConfoundDef:
    id: str
    label: str
    family: str
    formula: str
    sourceMetric: str | None = None
    questionableMediator: bool = False

    def json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RepresentationDef:
    id: str
    label: str
    dimensions: int
    formula: str
    ideaAssumption: str
    basis: str = "global_long_quant_title_basis"

    def json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ExperimentResult:
    id: str
    hash: str
    target: str
    targetFamily: str
    representation: str
    adjustment: str
    estimator: str
    scope: str
    alpha: float
    n: int
    rho: float
    r2: float
    p: float
    q: float | None
    signStability: float
    foldRhos: tuple[float, ...]
    valid: bool

    def json(self) -> dict[str, Any]:
        value = asdict(self)
        value["foldRhos"] = list(self.foldRhos)
        for key in ("rho", "r2", "p", "q"):
            if value[key] is not None and not finite(value[key]):
                value[key] = None
        return value


ADJUSTMENT_FAMILIES = {
    "raw": (),
    "delivery": ("delivery",),
    "entry": ("entry",),
    "idea": ("idea",),
    "distribution": ("distribution",),
    "quality": ("quality",),
    "delivery_entry": ("delivery", "entry"),
    "delivery_idea": ("delivery", "idea"),
    "entry_idea": ("entry", "idea"),
    "delivery_entry_idea": ("delivery", "entry", "idea"),
    "full_pre_exposure": ("delivery", "entry", "idea", "distribution", "quality"),
    "sensitivity": ("delivery", "entry", "idea", "distribution", "quality", "post_exposure"),
}


def metric_percentile(metric: Any) -> float:
    value = metric.get("pctile") if isinstance(metric, dict) else metric
    value = safe_float(value)
    if finite(value) and value <= 1.0:
        value *= 100.0
    return value


def build_grouped_folds(title_vectors: np.ndarray, seeds=(1729, 2718, 3141)) -> tuple[np.ndarray, list[tuple[np.ndarray, np.ndarray]], dict]:
    n = len(title_vectors)
    coordinates = PCA(n_components=min(32, n - 1), random_state=seeds[0]).fit_transform(title_vectors)
    n_groups = max(12, min(24, n // 8))
    groups = KMeans(n_clusters=n_groups, random_state=seeds[0], n_init=30).fit_predict(coordinates)
    folds = list(GroupKFold(n_splits=5).split(np.arange(n), groups=groups))
    return groups, folds, {
        "semanticClusters": int(n_groups),
        "clusterSizes": {str(group): int(np.sum(groups == group)) for group in np.unique(groups)},
        "folds": 5,
        "primarySeed": seeds[0],
        "sensitivitySeeds": list(seeds[1:]),
        "rule": "Every supervised prediction is out-of-fold with semantic title clusters held together.",
    }


def build_confound_matrix(
    rows: list[dict],
    hook_vectors: np.ndarray,
    title_vectors: np.ndarray,
    title_basis: TitleCorpusBasis,
) -> tuple[np.ndarray, list[ConfoundDef], dict[str, list[float]]]:
    definitions: list[ConfoundDef] = []
    columns: dict[str, list[float]] = {}

    def add(definition: ConfoundDef, values: list[float]) -> None:
        definitions.append(definition)
        columns[definition.id] = values

    alignments = [align_hook_words(row) for row in rows]
    today = dt.date.today()

    duration = [safe_float(row.get("duration_s")) for row in rows]
    hook_seconds = [safe_float(row.get("hookEndSec")) for row in rows]
    actual_words = [float(len(alignment.tokens)) for alignment in alignments]
    stored_words = [safe_float(row.get("hookWordCount"), len(alignment.tokens)) for row, alignment in zip(rows, alignments)]
    speech_rate = [count / max(0.25, seconds) if finite(seconds) else np.nan for count, seconds in zip(actual_words, hook_seconds)]
    pause_counts, pause_means, pause_maxes, word_duration_means = [], [], [], []
    for alignment in alignments:
        gaps = np.maximum(0.0, np.asarray(alignment.starts[1:]) - np.asarray(alignment.ends[:-1])) if len(alignment.tokens) > 1 else np.asarray([], float)
        durations = np.maximum(0.0, np.asarray(alignment.ends) - np.asarray(alignment.starts))
        pause_counts.append(float(np.sum(gaps >= 0.22)))
        pause_means.append(float(np.mean(gaps)) if len(gaps) else 0.0)
        pause_maxes.append(float(np.max(gaps)) if len(gaps) else 0.0)
        word_duration_means.append(float(np.mean(durations)) if len(durations) else np.nan)

    delivery = [
        ("duration", "Video duration", duration, "duration_s"),
        ("log_duration", "Log video duration", [math.log(max(1.0, x)) if finite(x) else np.nan for x in duration], "log(max(duration_s,1))"),
        ("hook_seconds", "Hook endpoint", hook_seconds, "hookEndSec"),
        ("hook_fraction", "Hook fraction of video", [s / d if finite(s) and finite(d) and d > 0 else np.nan for s, d in zip(hook_seconds, duration)], "hookEndSec/duration_s"),
        ("actual_word_count", "Actual hook token count", actual_words, "tokenize(hookText)"),
        ("stored_word_count", "Stored hook word count", stored_words, "source hookWordCount"),
        ("word_count_mismatch", "Stored minus actual words", [s - a for s, a in zip(stored_words, actual_words)], "stored_word_count-actual_word_count"),
        ("speech_rate", "Hook speech rate", speech_rate, "actual_word_count/hook_seconds"),
        ("pause_count", "Hook pause count", pause_counts, "count aligned gaps >= .22s"),
        ("pause_mean", "Mean hook gap", pause_means, "mean aligned inter-word gap"),
        ("pause_max", "Maximum hook gap", pause_maxes, "max aligned inter-word gap"),
        ("word_duration_mean", "Mean word duration", word_duration_means, "mean aligned word duration"),
    ]
    for metric_id, label, values, formula in delivery:
        add(ConfoundDef(metric_id, label, "delivery", formula), values)

    entry_specs = [
        ("entry_keep", "Viewed versus swiped", [safe_float(row.get("keep_rate")) for row in rows], "source keep_rate", "traditional_keep"),
        ("entry_swiped", "Swiped away", [safe_float(row.get("swiped"), 100 - safe_float(row.get("keep_rate"), 50)) for row in rows], "source swiped", None),
        ("entry_ret0", "Starting retention", [ret_at(row, 0.0) for row in rows], "R(0)", "abs_raw_p0"),
        ("entry_ret0d5", "Retention at .5s", [ret_at(row, 0.5) for row in rows], "R(.5)", "abs_raw_p0d5"),
        ("entry_ret1", "Retention at 1s", [ret_at(row, 1.0) for row in rows], "R(1)", "abs_raw_p1"),
        ("entry_ret3", "Retention at 3s", [ret_at(row, 3.0) for row in rows], "R(3)", "abs_raw_p3"),
        ("entry_ret5", "Retention at 5s", [ret_at(row, 5.0) for row in rows], "R(5)", "abs_raw_p5"),
        ("entry_start_excess", "Starting excess above 100", [max(0.0, ret_at(row, 0.0) - 100.0) for row in rows], "max(R(0)-100,0)", "replay_start_excess"),
        ("entry_drop_1", "Entry drop by 1s", [ret_at(row, 0.0) - ret_at(row, 1.0) for row in rows], "R(0)-R(1)", "entry_drop_1s"),
        ("entry_drop_3", "Entry drop by 3s", [ret_at(row, 0.0) - ret_at(row, 3.0) for row in rows], "R(0)-R(3)", "entry_drop_3s"),
    ]
    for metric_id, label, values, formula, source in entry_specs:
        add(ConfoundDef(metric_id, label, "entry", formula, sourceMetric=source), values)

    title_features = title_basis.transform(title_vectors)
    for idx in range(min(24, title_features.shape[1])):
        add(
            ConfoundDef(f"idea_title_pc{idx + 1}", f"External title-basis coordinate {idx + 1}", "idea", "published title projected into global Long Quant title basis"),
            title_features[:, idx].astype(float).tolist(),
        )
    add(
        ConfoundDef("idea_title_hook_cosine", "Title/hook cosine", "idea", "cos(E(title),E(hook))"),
        np.sum(normalize_rows(title_vectors) * normalize_rows(hook_vectors), axis=1).astype(float).tolist(),
    )
    add(
        ConfoundDef("idea_neighbor_density", "Long Quant nearest-title cosine", "idea", "source nn_cos"),
        [safe_float(row.get("nn_cos")) for row in rows],
    )

    published_dates, years = [], []
    for row in rows:
        try:
            date = dt.date.fromisoformat(str(row.get("published"))[:10])
            published_dates.append(float((today - date).days))
            years.append(float(date.year + (date.timetuple().tm_yday - 1) / 365.25))
        except Exception:
            published_dates.append(np.nan)
            years.append(np.nan)
    add(ConfoundDef("distribution_age_days", "Upload age", "distribution", "today-published date"), published_dates)
    add(ConfoundDef("distribution_era", "Publication year", "distribution", "fractional publication year"), years)

    add(ConfoundDef("quality_local_whisper", "Local Whisper transcript", "quality", "1[transcriptSource=local-whisper]"), [float(row.get("transcriptSource") == "local-whisper") for row in rows])
    add(ConfoundDef("quality_manual_cut", "Tyler-selected hook cut", "quality", "1[cutBy=tyler]"), [float(row.get("cutBy") == "tyler") for row in rows])
    add(ConfoundDef("quality_alignment_exact", "Word alignment exact rate", "quality", "exact aligned hook tokens / hook tokens"), [alignment.exact_rate for alignment in alignments])
    add(ConfoundDef("quality_alignment_coverage", "Word alignment coverage", "quality", "mapped hook tokens / hook tokens"), [alignment.coverage for alignment in alignments])
    add(ConfoundDef("quality_curve_samples", "Retention curve samples", "quality", "len(curve)"), [float(len(row.get("curve") or [])) for row in rows])

    add(ConfoundDef("post_log_views", "Observed log views", "post_exposure", "log10(max(views,1))", sourceMetric="traditional_log_views", questionableMediator=True), [math.log10(max(1.0, safe_float(row.get("views"), 1))) for row in rows])
    for metric in ("ctrviews", "ctr", "ret30", "views", "realviews", "scaled_views", "gt10m"):
        add(
            ConfoundDef(f"post_longquant_{metric}", f"Long Quant {metric} placement", "post_exposure", f"source metrics.{metric}.pctile", questionableMediator=True),
            [metric_percentile((row.get("metrics") or {}).get(metric)) for row in rows],
        )

    matrix = np.column_stack([np.asarray(columns[definition.id], float) for definition in definitions])
    return matrix, definitions, columns


def build_representations(
    hook_vectors: np.ndarray,
    title_vectors: np.ndarray,
    title_basis: TitleCorpusBasis,
) -> tuple[dict[str, np.ndarray], list[RepresentationDef]]:
    hook = normalize_rows(hook_vectors)
    title = normalize_rows(title_vectors)
    delta = normalize_rows(hook - title)
    dot = np.sum(hook * title, axis=1, keepdims=True)
    orthogonal = normalize_rows(hook - dot * title)
    hook_f = title_basis.transform(hook)
    title_f = title_basis.transform(title)
    delta_f = title_basis.transform(delta)
    orthogonal_f = title_basis.transform(orthogonal)

    representations = {
        "hook": hook_f,
        "title": title_f,
        "hook_minus_title": delta_f,
        "hook_orthogonal_title": orthogonal_f,
        "shared_mean": (hook_f + title_f) / 2.0,
        "hook_title_concat": np.column_stack([hook_f, title_f]),
        "hook_delta_concat": np.column_stack([hook_f, delta_f]),
        "relation": np.column_stack([hook_f * title_f, np.abs(hook_f - title_f), np.sum(hook * title, axis=1)]),
    }
    definitions = [
        RepresentationDef("hook", "Exact full hook", hook_f.shape[1], "global_basis(E(hook))", "none; preserves idea and framing"),
        RepresentationDef("title", "Published title anchor", title_f.shape[1], "global_basis(E(title))", "title is observed packaging, not true idea"),
        RepresentationDef("hook_minus_title", "Hook minus title", delta_f.shape[1], "global_basis(normalize(E(hook)-E(title)))", "title approximates idea"),
        RepresentationDef("hook_orthogonal_title", "Hook orthogonal to title", orthogonal_f.shape[1], "global_basis(normalize(E(hook)-proj_title(E(hook))))", "title direction approximates idea"),
        RepresentationDef("shared_mean", "Shared hook/title mean", hook_f.shape[1], "(global_basis(E(hook))+global_basis(E(title)))/2", "shared coordinates emphasize common packaging"),
        RepresentationDef("hook_title_concat", "Hook and title jointly", hook_f.shape[1] * 2, "concat(global_basis(E(hook)),global_basis(E(title)))", "estimator may learn shared and differing content"),
        RepresentationDef("hook_delta_concat", "Hook plus hook-title delta", hook_f.shape[1] * 2, "concat(hook coordinates,delta coordinates)", "title approximates one idea anchor"),
        RepresentationDef("relation", "Hook/title relational features", hook_f.shape[1] * 2 + 1, "concat(hook*title,abs(hook-title),cosine)", "title relation is modeled without subtraction alone"),
    ]
    return {key: np.asarray(value, float) for key, value in representations.items()}, definitions


def _impute_standardize(train: np.ndarray, test: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    median = np.nanmedian(train, axis=0)
    median = np.where(np.isfinite(median), median, 0.0)
    train = np.where(np.isfinite(train), train, median)
    test = np.where(np.isfinite(test), test, median)
    mean = np.mean(train, axis=0)
    scale = np.std(train, axis=0)
    scale = np.where(scale > EPS, scale, 1.0)
    return (train - mean) / scale, (test - mean) / scale


def _ridge_predict(x_train: np.ndarray, y_train: np.ndarray, x_test: np.ndarray, alpha: float) -> np.ndarray:
    y_mean = np.mean(y_train, axis=0)
    centered = y_train - y_mean
    rows, cols = x_train.shape
    if cols <= rows:
        weights = np.linalg.solve(x_train.T @ x_train + alpha * np.eye(cols), x_train.T @ centered)
    else:
        weights = x_train.T @ np.linalg.solve(x_train @ x_train.T + alpha * np.eye(rows), centered)
    return x_test @ weights + y_mean


def oof_ridge_multi(features: np.ndarray, targets: np.ndarray, folds, alpha: float) -> np.ndarray:
    targets = np.asarray(targets, float)
    predictions = np.full_like(targets, np.nan, dtype=float)
    for train, test in folds:
        x_train, x_test = _impute_standardize(features[train], features[test])
        groups: dict[bytes, list[int]] = {}
        for column in range(targets.shape[1]):
            mask = np.isfinite(targets[train, column])
            groups.setdefault(mask.tobytes(), []).append(column)
        for key, columns in groups.items():
            mask = np.frombuffer(key, dtype=bool, count=len(train))
            if int(mask.sum()) < max(30, min(80, features.shape[1] // 2 + 5)):
                continue
            y_train = targets[train[mask]][:, columns]
            if y_train.ndim == 1:
                y_train = y_train[:, None]
            predictions[np.ix_(test, columns)] = _ridge_predict(x_train[mask], y_train, x_test, alpha)
    return predictions


def r2_columns(actual: np.ndarray, predicted: np.ndarray) -> np.ndarray:
    output = np.full(actual.shape[1], np.nan, float)
    for column in range(actual.shape[1]):
        mask = np.isfinite(actual[:, column]) & np.isfinite(predicted[:, column])
        if mask.sum() < 10:
            continue
        values = actual[mask, column]
        pred = predicted[mask, column]
        output[column] = 1.0 - np.sum((values - pred) ** 2) / (np.sum((values - np.mean(values)) ** 2) + EPS)
    return output


def crossfit_adjustments(
    outcomes: np.ndarray,
    target_defs: list[MetricDef],
    confounds: np.ndarray,
    confound_defs: list[ConfoundDef],
    folds,
    alpha=10.0,
) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
    adjusted = {"raw": np.asarray(outcomes, float)}
    metadata: dict[str, Any] = {
        "raw": {"families": [], "controls": [], "invalidSelfControls": [], "controlR2": {}},
    }
    for adjustment, families in ADJUSTMENT_FAMILIES.items():
        if adjustment == "raw":
            continue
        indices = [idx for idx, definition in enumerate(confound_defs) if definition.family in families]
        control_defs = [confound_defs[idx] for idx in indices]
        predictions = oof_ridge_multi(confounds[:, indices], outcomes, folds, alpha) if indices else np.zeros_like(outcomes)
        residuals = outcomes - predictions
        invalid = []
        for target_index, target in enumerate(target_defs):
            collisions = [definition.id for definition in control_defs if definition.sourceMetric == target.id]
            if collisions:
                residuals[:, target_index] = np.nan
                invalid.append({"target": target.id, "controls": collisions})
        scores = r2_columns(outcomes, predictions)
        adjusted[adjustment] = residuals
        metadata[adjustment] = {
            "families": list(families),
            "controls": [definition.id for definition in control_defs],
            "invalidSelfControls": invalid,
            "controlR2": {
                target.id: round(float(scores[idx]), 5) if finite(scores[idx]) else None
                for idx, target in enumerate(target_defs)
            },
        }
    return adjusted, metadata


def spearman_fast(actual: np.ndarray, predicted: np.ndarray) -> tuple[float, float, int]:
    mask = np.isfinite(actual) & np.isfinite(predicted)
    n = int(mask.sum())
    if n < 8 or np.std(predicted[mask]) <= EPS or np.std(actual[mask]) <= EPS:
        return float("nan"), float("nan"), n
    left = rankdata(actual[mask])
    right = rankdata(predicted[mask])
    rho = float(np.corrcoef(left, right)[0, 1])
    statistic = abs(rho) * math.sqrt(max(0.0, (n - 2) / max(EPS, 1.0 - rho ** 2)))
    p = float(2.0 * student_t.sf(statistic, n - 2))
    return rho, p, n


def experiment_identity(target: str, representation: str, adjustment: str, alpha: float, scope="video") -> tuple[str, str]:
    spec = {
        "target": target,
        "representation": representation,
        "adjustment": adjustment,
        "estimator": "ridge",
        "scope": scope,
        "alpha": float(alpha),
        "validation": "5-fold-semantic-group-oof",
    }
    encoded = json.dumps(spec, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return f"rtg2_{digest[:20]}", digest


def bh_qvalues(results: list[ExperimentResult]) -> None:
    valid = [(idx, result.p) for idx, result in enumerate(results) if finite(result.p)]
    if not valid:
        return
    valid.sort(key=lambda item: item[1])
    running = 1.0
    count = len(valid)
    for rank in range(count, 0, -1):
        index, pvalue = valid[rank - 1]
        running = min(running, float(pvalue) * count / rank)
        results[index].q = min(1.0, running)


def run_experiment_sweep(
    representations: dict[str, np.ndarray],
    adjusted: dict[str, np.ndarray],
    target_defs: list[MetricDef],
    folds,
    alphas=RIDGE_ALPHAS,
    keep_prediction_rho=0.18,
    scope="video",
    progress_callback=None,
) -> tuple[list[ExperimentResult], dict[str, list[float]]]:
    results: list[ExperimentResult] = []
    prediction_cache: dict[str, list[float]] = {}
    total_batches = len(representations) * len(adjusted) * len(alphas)
    batch_index = 0
    for representation_id, features in representations.items():
        for adjustment_id, targets in adjusted.items():
            for alpha in alphas:
                batch_index += 1
                predictions = oof_ridge_multi(features, targets, folds, float(alpha))
                for target_index, target in enumerate(target_defs):
                    rho, pvalue, n = spearman_fast(targets[:, target_index], predictions[:, target_index])
                    fold_rhos = []
                    for _, test in folds:
                        fold_rho, _, fold_n = spearman_fast(targets[test, target_index], predictions[test, target_index])
                        if fold_n >= 5 and finite(fold_rho):
                            fold_rhos.append(float(fold_rho))
                    r2 = r2_columns(targets[:, [target_index]], predictions[:, [target_index]])[0]
                    experiment_id, digest = experiment_identity(target.id, representation_id, adjustment_id, float(alpha), scope)
                    result = ExperimentResult(
                        id=experiment_id,
                        hash=digest,
                        target=target.id,
                        targetFamily=target.family,
                        representation=representation_id,
                        adjustment=adjustment_id,
                        estimator="ridge",
                        scope=scope,
                        alpha=float(alpha),
                        n=n,
                        rho=round(float(rho), 6) if finite(rho) else float("nan"),
                        r2=round(float(r2), 6) if finite(r2) else float("nan"),
                        p=float(pvalue) if finite(pvalue) else float("nan"),
                        q=None,
                        signStability=round(float(np.mean(np.asarray(fold_rhos) > 0)), 4) if fold_rhos else 0.0,
                        foldRhos=tuple(round(value, 5) for value in fold_rhos),
                        valid=finite(rho) and n >= 80,
                    )
                    results.append(result)
                    if result.valid and result.rho >= keep_prediction_rho and result.signStability >= 0.6:
                        prediction_cache[result.id] = [round(float(value), 6) if finite(value) else None for value in predictions[:, target_index]]
                if batch_index == total_batches or batch_index % 16 == 0:
                    print(f"  experiment batches {batch_index}/{total_batches} ({len(results):,} tests)", flush=True)
                if progress_callback and (batch_index == total_batches or batch_index % 64 == 0):
                    progress_callback(batch_index, total_batches, len(results))
    bh_qvalues(results)
    return results, prediction_cache


def rank_matrix(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    values = np.asarray(values, float)
    ranked = np.zeros_like(values, float)
    mask = np.isfinite(values)
    for column in range(values.shape[1]):
        valid = mask[:, column]
        if valid.sum() < 3:
            continue
        ranked[valid, column] = rankdata(values[valid, column])
    return ranked, mask.astype(float)


def pairwise_rank_correlation(left: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pair-overlap Pearson correlation of columnwise ranks.

    Column ranks are computed once, then exact pairwise overlap moments are
    calculated with matrix multiplication. This is deterministic and scalable
    for the full 603x603 relationship atlas.
    """
    x, xm = rank_matrix(left)
    y, ym = rank_matrix(right)
    count = xm.T @ ym
    sum_x = x.T @ ym
    sum_y = (y.T @ xm).T
    sum_x2 = (x ** 2).T @ ym
    sum_y2 = ((y ** 2).T @ xm).T
    sum_xy = x.T @ y
    covariance = sum_xy - sum_x * sum_y / np.maximum(count, 1.0)
    variance_x = sum_x2 - sum_x ** 2 / np.maximum(count, 1.0)
    variance_y = sum_y2 - sum_y ** 2 / np.maximum(count, 1.0)
    correlation = covariance / np.sqrt(np.maximum(variance_x * variance_y, EPS))
    correlation[count < 8] = np.nan
    return correlation.astype(np.float32), count.astype(np.int16)


def aggregate_experiments(results: list[ExperimentResult], target_defs: list[MetricDef]) -> dict[str, Any]:
    target_lookup = {definition.id: definition for definition in target_defs}
    valid = [result for result in results if result.valid and finite(result.rho)]
    observed_top = sorted(
        valid,
        key=lambda result: (result.q is not None and result.q <= 0.05, result.rho * (0.5 + 0.5 * result.signStability), result.r2),
        reverse=True,
    )
    strict_top = sorted(
        [
            result for result in valid
            if result.adjustment in ("delivery_entry_idea", "full_pre_exposure")
            and result.r2 > 0
            and result.signStability >= 0.6
        ],
        key=lambda result: (result.q is not None and result.q <= 0.05, result.rho * (0.5 + 0.5 * result.signStability), result.r2),
        reverse=True,
    )
    top = strict_top or observed_top
    per_target = {}
    for result in top:
        per_target.setdefault(result.target, result.json())

    cells: dict[tuple[str, str, str], list[ExperimentResult]] = {}
    for result in valid:
        key = (result.representation, result.adjustment, result.targetFamily)
        cells.setdefault(key, []).append(result)
    matrix_cells = []
    for (representation, adjustment, family), items in sorted(cells.items()):
        best = max(items, key=lambda item: item.rho * (0.5 + 0.5 * item.signStability))
        matrix_cells.append({
            "representation": representation,
            "adjustment": adjustment,
            "targetFamily": family,
            "tests": len(items),
            "medianAbsRho": round(float(np.median([abs(item.rho) for item in items])), 5),
            "maxRho": round(float(max(item.rho for item in items)), 5),
            "fdr05": sum(item.q is not None and item.q <= 0.05 for item in items),
            "best": best.json(),
        })
    return {
        "top": [result.json() for result in top[:2000]],
        "topObservedUnrestricted": [result.json() for result in observed_top[:250]],
        "topSelectionRule": "delivery+entry+idea or full-pre-exposure adjustment, positive held-out R2, and at least 60% positive folds; unrestricted observed leaders are kept separately for confound diagnosis",
        "perTargetBest": per_target,
        "matrixCells": matrix_cells,
        "targetFamilies": sorted({target_lookup[result.target].family for result in valid}),
    }


def within_group_permutation(groups: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    order = np.arange(len(groups))
    for group in np.unique(groups):
        indices = np.where(groups == group)[0]
        order[indices] = rng.permutation(indices)
    return order


def run_null_sweeps(
    representations: dict[str, np.ndarray],
    adjusted: dict[str, np.ndarray],
    folds,
    groups: np.ndarray,
    iterations=9,
    alphas=RIDGE_ALPHAS,
) -> dict[str, Any]:
    # These families repeat a broad but computationally bounded promotion
    # search. Larger family-level permutations are a later promotion gate.
    rep_ids = list(representations)
    adjustment_ids = [key for key in ("raw", "delivery_entry_idea", "full_pre_exposure") if key in adjusted]
    observed_max = -np.inf
    for rep_id in rep_ids:
        for adjustment_id in adjustment_ids:
            targets = adjusted[adjustment_id]
            for alpha in alphas:
                predictions = oof_ridge_multi(representations[rep_id], targets, folds, float(alpha))
                for column in range(targets.shape[1]):
                    rho, _, n = spearman_fast(targets[:, column], predictions[:, column])
                    if n >= 80 and finite(rho):
                        observed_max = max(observed_max, rho)

    rng = np.random.default_rng(8819)
    nulls = {"global": [], "withinIdea": []}
    for family in nulls:
        for iteration in range(iterations):
            if family == "global":
                order = rng.permutation(len(groups))
            else:
                order = within_group_permutation(groups, rng)
            maximum = -np.inf
            for rep_id in rep_ids:
                for adjustment_id in adjustment_ids:
                    targets = adjusted[adjustment_id][order]
                    for alpha in alphas:
                        predictions = oof_ridge_multi(representations[rep_id], targets, folds, float(alpha))
                        for column in range(targets.shape[1]):
                            rho, _, n = spearman_fast(targets[:, column], predictions[:, column])
                            if n >= 80 and finite(rho):
                                maximum = max(maximum, rho)
            nulls[family].append(round(float(maximum), 6))
            print(f"  null {family} {iteration + 1}/{iterations}: max rho {maximum:.4f}", flush=True)
    return {
        "searchedRepresentations": rep_ids,
        "searchedAdjustments": adjustment_ids,
        "alphas": list(alphas),
        "targetsPerCell": int(next(iter(adjusted.values())).shape[1]),
        "observedMaxRho": round(float(observed_max), 6),
        "iterationsPerFamily": iterations,
        "maxRho": nulls,
        "globalP": round((1 + sum(value >= observed_max for value in nulls["global"])) / (1 + len(nulls["global"])), 6),
        "withinIdeaP": round((1 + sum(value >= observed_max for value in nulls["withinIdea"])) / (1 + len(nulls["withinIdea"])), 6),
        "status": "selection-repeating calibration across every current representation; promotion requires at least 99 repetitions",
    }
