"""Registered retention-curve measurements for the RTG research program.

Nothing in this module is called a reference-to-gratification score. It builds
many explicit, independently inspectable measurements of audience behavior so
later experiments can discover which geometry, if any, is consistently related
to promise framing.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
from scipy.fft import dct
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler


EPS = 1e-9


@dataclass(frozen=True)
class MetricDef:
    id: str
    label: str
    family: str
    coordinate: str
    unit: str
    formula: str
    parameters: dict[str, Any]
    role: str = "candidate_outcome"

    def json(self) -> dict[str, Any]:
        return asdict(self)


def finite(value: Any) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def safe_float(value: Any, default=np.nan) -> float:
    return float(value) if finite(value) else float(default)


def metric_token(value: float) -> str:
    sign = "m" if value < 0 else "p"
    absolute = abs(float(value))
    text = f"{absolute:.3f}".rstrip("0").rstrip(".").replace(".", "d")
    return sign + text


def curve_percent(row: dict) -> np.ndarray:
    values = np.asarray(row.get("curve") or [], float)
    return values * 100.0


def ret_at(row: dict, seconds: float) -> float:
    curve = curve_percent(row)
    duration = safe_float(row.get("duration_s"))
    if len(curve) < 2 or not finite(duration) or duration <= 0 or seconds < 0 or seconds > duration:
        return float("nan")
    position = seconds / duration * (len(curve) - 1)
    lo = int(math.floor(position))
    hi = min(len(curve) - 1, lo + 1)
    return float(curve[lo] + (curve[hi] - curve[lo]) * (position - lo))


def ret_at_fraction(row: dict, fraction: float) -> float:
    duration = safe_float(row.get("duration_s"))
    if not finite(duration) or duration <= 0:
        return float("nan")
    return ret_at(row, float(fraction) * duration)


def sample_window(row: dict, start: float, end: float, step=0.25) -> tuple[np.ndarray, np.ndarray]:
    duration = safe_float(row.get("duration_s"))
    if not finite(duration) or duration <= 0:
        return np.asarray([], float), np.asarray([], float)
    start = max(0.0, float(start))
    end = min(float(end), duration)
    if end <= start:
        return np.asarray([], float), np.asarray([], float)
    count = max(3, int(math.ceil((end - start) / step)) + 1)
    times = np.linspace(start, end, count)
    values = np.asarray([ret_at(row, float(t)) for t in times], float)
    mask = np.isfinite(values)
    return times[mask], values[mask]


def ls_slope(times: np.ndarray, values: np.ndarray) -> float:
    if len(times) < 3 or np.ptp(times) <= EPS:
        return float("nan")
    centered = times - np.mean(times)
    return float(np.sum(centered * (values - np.mean(values))) / (np.sum(centered ** 2) + EPS))


def endpoint_slope(times: np.ndarray, values: np.ndarray) -> float:
    if len(times) < 2 or times[-1] <= times[0]:
        return float("nan")
    return float((values[-1] - values[0]) / (times[-1] - times[0]))


def mean_area(times: np.ndarray, values: np.ndarray) -> float:
    if len(times) < 2 or times[-1] <= times[0]:
        return float("nan")
    return float(np.trapezoid(values, times) / (times[-1] - times[0]))


def normalized(value: float, anchor: float) -> float:
    return float(100.0 * value / anchor) if finite(value) and finite(anchor) and anchor > EPS else float("nan")


def constant_excess_corrected(value: float, start: float) -> float:
    """Sensitivity view that subtracts a constant initial excess above 100.

    This is deliberately not presented as a replay model. It asks how a result
    changes under one transparent correction and is compared with uncorrected
    and start-normalized views.
    """
    if not finite(value) or not finite(start):
        return float("nan")
    excess = max(0.0, start - 100.0)
    denominator = max(EPS, start - excess)
    return float(100.0 * (value - excess) / denominator)


def first_crossing(row: dict, anchor_time: float, ratio: float, horizon: float) -> float:
    anchor = ret_at(row, anchor_time)
    duration = safe_float(row.get("duration_s"))
    if not finite(anchor) or anchor <= 0 or not finite(duration) or anchor_time >= duration:
        return float("nan")
    stop = min(duration, anchor_time + horizon)
    times = np.linspace(anchor_time, stop, max(5, int((stop - anchor_time) * 8) + 1))[1:]
    for value_time in times:
        if ret_at(row, float(value_time)) < anchor * ratio:
            return float(value_time - anchor_time)
    return float(stop - anchor_time)


def flat_interval_metrics(row: dict, width: float) -> tuple[float, float, float]:
    duration = safe_float(row.get("duration_s"))
    if not finite(duration) or duration < width:
        return float("nan"), float("nan"), float("nan")
    starts = np.arange(0.0, duration - width + 1e-6, max(0.25, width / 8.0))
    slopes = []
    for start in starts:
        times, values = sample_window(row, float(start), float(start + width))
        slopes.append(ls_slope(times, values))
    slopes = np.asarray(slopes, float)
    mask = np.isfinite(slopes)
    if not mask.any():
        return float("nan"), float("nan"), float("nan")
    valid_idx = np.where(mask)[0]
    best = int(valid_idx[np.argmin(np.abs(slopes[mask]))])
    return float(starts[best]), float(slopes[best]), float(np.nanmedian(np.abs(slopes)))


def first_flat_time(row: dict, width: float, threshold: float) -> float:
    duration = safe_float(row.get("duration_s"))
    if not finite(duration) or duration < width:
        return float("nan")
    for start in np.arange(0.0, duration - width + 1e-6, 0.25):
        times, values = sample_window(row, float(start), float(start + width))
        slope = ls_slope(times, values)
        if finite(slope) and abs(slope) <= threshold:
            return float(start)
    return float(duration)


def longest_flat_duration(row: dict, threshold: float, step=0.25) -> float:
    duration = safe_float(row.get("duration_s"))
    if not finite(duration) or duration <= step:
        return float("nan")
    times, values = sample_window(row, 0.0, duration, step=step)
    if len(times) < 4:
        return float("nan")
    slopes = np.diff(values) / np.maximum(np.diff(times), EPS)
    good = np.abs(slopes) <= threshold
    longest = current = 0
    for flag in good:
        current = current + 1 if flag else 0
        longest = max(longest, current)
    return float(longest * np.median(np.diff(times)))


def flat_profiles(row: dict, widths: list[float]) -> tuple[dict[float, tuple[np.ndarray, np.ndarray]], np.ndarray, float]:
    """Compute all sliding-window slopes once for one curve."""
    duration = safe_float(row.get("duration_s"))
    profiles: dict[float, tuple[np.ndarray, np.ndarray]] = {}
    if not finite(duration) or duration <= 0:
        return profiles, np.asarray([], float), 0.25
    for width in widths:
        if duration < width:
            continue
        starts = np.arange(0.0, duration - width + 1e-6, max(0.25, width / 8.0))
        slopes = []
        for start in starts:
            times, window_values = sample_window(row, float(start), float(start + width))
            slopes.append(ls_slope(times, window_values))
        profiles[float(width)] = (starts, np.asarray(slopes, float))
    times, values = sample_window(row, 0.0, duration, step=0.25)
    local_step = float(np.median(np.diff(times))) if len(times) > 1 else 0.25
    local_slopes = np.diff(values) / np.maximum(np.diff(times), EPS) if len(values) > 1 else np.asarray([], float)
    return profiles, local_slopes, local_step


def shape_descriptors(row: dict) -> dict[str, float]:
    duration = safe_float(row.get("duration_s"))
    times, values = sample_window(row, 0.0, duration, step=max(0.1, duration / 250.0))
    if len(values) < 6:
        return {}
    delta = np.diff(values)
    slopes = delta / np.maximum(np.diff(times), EPS)
    curvature = np.diff(slopes) / np.maximum(np.diff(times[:-1]), EPS)
    positive = np.maximum(delta, 0.0)
    negative = np.maximum(-delta, 0.0)
    sign = np.sign(delta)
    rebound_count = int(np.sum((sign[1:] > 0) & (sign[:-1] <= 0))) if len(sign) > 1 else 0
    largest_change_idx = int(np.argmax(np.abs(curvature))) if len(curvature) else 0
    weights = np.abs(delta)
    weights = weights / (np.sum(weights) + EPS)
    entropy = -float(np.sum(weights * np.log(weights + EPS))) / max(EPS, math.log(max(2, len(weights))))
    return {
        "curve_total_variation": float(np.sum(np.abs(delta))),
        "curve_net_drop": float(values[0] - values[-1]),
        "curve_positive_area": float(np.sum(positive)),
        "curve_negative_area": float(np.sum(negative)),
        "curve_rebound_count": float(rebound_count),
        "curve_slope_sd": float(np.std(slopes)),
        "curve_curvature_sd": float(np.std(curvature)) if len(curvature) else np.nan,
        "curve_max_drop_rate": float(np.min(slopes)),
        "curve_max_rebound_rate": float(np.max(slopes)),
        "curve_largest_change_time": float(times[min(largest_change_idx + 1, len(times) - 1)]),
        "curve_change_entropy": entropy,
    }


def replay_descriptors(row: dict) -> dict[str, float]:
    duration = safe_float(row.get("duration_s"))
    stop = min(10.0, duration) if finite(duration) else 0.0
    times, values = sample_window(row, 0.0, stop, step=0.1)
    if len(values) < 3:
        return {}
    above = np.maximum(values - 100.0, 0.0)
    first_five = times <= min(5.0, stop)
    return {
        "replay_start_excess": float(max(0.0, values[0] - 100.0)),
        "replay_peak_excess": float(np.max(above)),
        "replay_area_above_100_5s": float(np.trapezoid(above[first_five], times[first_five])) if first_five.sum() > 1 else np.nan,
        "replay_area_above_100_10s": float(np.trapezoid(above, times)),
        "replay_duration_above_100_10s": float(np.sum(above[:-1] > 0) * np.median(np.diff(times))),
        "replay_excess_decay_slope_5s": ls_slope(times[first_five], above[first_five]) if first_five.sum() > 2 else np.nan,
        "entry_drop_1s": float(values[0] - ret_at(row, 1.0)),
        "entry_drop_3s": float(values[0] - ret_at(row, 3.0)),
        "entry_drop_5s": float(values[0] - ret_at(row, 5.0)),
    }


def base_metric_defs() -> list[MetricDef]:
    defs: list[MetricDef] = []

    def add(metric_id, label, family, coordinate, unit, formula, **parameters):
        defs.append(MetricDef(metric_id, label, family, coordinate, unit, formula, parameters))

    add("traditional_keep", "Viewed versus swiped", "traditional", "video", "%", "source keep_rate")
    add("traditional_avg_retention", "Average retention", "traditional", "video", "%", "source average percentage viewed")
    add("traditional_log_views", "Log views", "traditional", "video", "log10", "log10(max(views, 1))")

    absolute_seconds = np.arange(0.0, 20.0001, 0.5)
    for second in absolute_seconds:
        token = metric_token(second)
        add(f"abs_raw_{token}", f"Retention at {second:g}s", "point", "absolute_seconds", "%", "R(t)", seconds=float(second), normalization="raw")
        add(f"abs_startnorm_{token}", f"Start-normalized retention at {second:g}s", "point", "absolute_seconds", "% of start", "100 * R(t) / R(0)", seconds=float(second), normalization="start")
        add(f"abs_excesssens_{token}", f"Initial-excess sensitivity at {second:g}s", "replay_sensitivity", "absolute_seconds", "%", "100 * (R(t) - max(R(0)-100,0)) / (R(0)-max(R(0)-100,0))", seconds=float(second), normalization="constant_initial_excess")

    fractions = np.arange(0.0, 1.0001, 0.025)
    for fraction in fractions:
        token = metric_token(fraction)
        add(f"frac_raw_{token}", f"Retention at {fraction:.1%} duration", "point", "duration_fraction", "%", "R(fraction * duration)", fraction=float(fraction), normalization="raw")
        add(f"frac_startnorm_{token}", f"Start-normalized retention at {fraction:.1%}", "point", "duration_fraction", "% of start", "100 * R(fraction * duration) / R(0)", fraction=float(fraction), normalization="start")

    hook_offsets = np.arange(-5.0, 20.0001, 0.5)
    for offset in hook_offsets:
        token = metric_token(offset)
        add(f"hook_raw_{token}", f"Retention {offset:+g}s from hook end", "hook_aligned_point", "hook_relative_seconds", "%", "R(hook_end + offset)", offset=float(offset), normalization="raw")
        add(f"hook_startnorm_{token}", f"Start-normalized retention {offset:+g}s from hook", "hook_aligned_point", "hook_relative_seconds", "% of start", "100 * R(hook_end + offset) / R(0)", offset=float(offset), normalization="start")
        add(f"hook_hooknorm_{token}", f"Hook-normalized retention {offset:+g}s", "hook_aligned_point", "hook_relative_seconds", "% of hook end", "100 * R(hook_end + offset) / R(hook_end)", offset=float(offset), normalization="hook_end")

    widths = [0.5, 1, 2, 3, 5, 8, 10, 15, 20]
    for anchor in ("start", "hook"):
        for width in widths:
            token = metric_token(width)
            prefix = f"{anchor}_window_{token}"
            add(f"{prefix}_ls_slope", f"{anchor.title()} {width:g}s least-squares slope", "slope", f"{anchor}_window", "pp/s", "least-squares slope over anchor..anchor+width", anchor=anchor, width=float(width), estimator="least_squares")
            add(f"{prefix}_endpoint_slope", f"{anchor.title()} {width:g}s endpoint slope", "slope", f"{anchor}_window", "pp/s", "(R(end)-R(anchor))/width", anchor=anchor, width=float(width), estimator="endpoints")
            add(f"{prefix}_raw_auc", f"{anchor.title()} {width:g}s retention area", "area", f"{anchor}_window", "%", "mean area under R(t)", anchor=anchor, width=float(width), normalization="raw")
            add(f"{prefix}_anchornorm_auc", f"{anchor.title()} {width:g}s normalized area", "area", f"{anchor}_window", "% of anchor", "100 * mean area / R(anchor)", anchor=anchor, width=float(width), normalization="anchor")

    for width in [1, 2, 3, 5, 8, 10]:
        token = metric_token(width)
        add(f"hook_slope_change_{token}", f"Slope change around hook over {width:g}s", "curvature", "hook_boundary", "pp/s", "post-hook LS slope - pre-hook LS slope", width=float(width))
        add(f"hook_slope_ratio_{token}", f"Slope ratio around hook over {width:g}s", "curvature", "hook_boundary", "ratio", "post-hook absolute slope / pre-hook absolute slope", width=float(width))

    for anchor in ("start", "hook"):
        for ratio in [0.99, 0.975, 0.95, 0.90, 0.85, 0.80, 0.75, 0.50]:
            token = metric_token(ratio)
            add(f"{anchor}_cross_{token}", f"Time below {ratio:.1%} of {anchor}", "persistence", f"{anchor}_relative_seconds", "seconds", "first t where R(anchor+t) < ratio * R(anchor)", anchor=anchor, ratio=float(ratio), horizon=30.0)

    for width in [1, 2, 3, 5, 8, 10]:
        token = metric_token(width)
        add(f"flat_best_start_{token}", f"Flattest {width:g}s interval start", "flattening", "absolute_seconds", "seconds", "argmin_start abs(LS slope over width)", width=float(width))
        add(f"flat_best_slope_{token}", f"Flattest {width:g}s interval slope", "flattening", "absolute_seconds", "pp/s", "signed LS slope of flattest interval", width=float(width))
        add(f"flat_median_abs_slope_{token}", f"Median absolute {width:g}s slope", "flattening", "absolute_seconds", "pp/s", "median_start abs(LS slope over width)", width=float(width))

    for width in [1, 2, 3, 5]:
        for threshold in [0.05, 0.1, 0.25, 0.5, 1.0]:
            wt, tt = metric_token(width), metric_token(threshold)
            add(f"flat_first_w{wt}_t{tt}", f"First {width:g}s flat interval at {threshold:g} pp/s", "flattening", "absolute_seconds", "seconds", "first start with abs(LS slope)<=threshold", width=float(width), threshold=float(threshold))
    for threshold in [0.05, 0.1, 0.25, 0.5, 1.0]:
        token = metric_token(threshold)
        add(f"flat_longest_{token}", f"Longest locally flat run at {threshold:g} pp/s", "flattening", "absolute_seconds", "seconds", "longest consecutive local derivative run within threshold", threshold=float(threshold))

    replay_formulas = {
        "replay_start_excess": ("Starting retention above 100", "%", "max(R(0)-100,0)"),
        "replay_peak_excess": ("Peak early retention above 100", "%", "max_t<=10 max(R(t)-100,0)"),
        "replay_area_above_100_5s": ("Area above 100 in first 5s", "pp*s", "integral_0^5 max(R(t)-100,0)"),
        "replay_area_above_100_10s": ("Area above 100 in first 10s", "pp*s", "integral_0^10 max(R(t)-100,0)"),
        "replay_duration_above_100_10s": ("Duration above 100 in first 10s", "seconds", "measure{t<=10:R(t)>100}"),
        "replay_excess_decay_slope_5s": ("Replay-excess decay slope", "pp/s", "LS slope of max(R(t)-100,0), t<=5"),
        "entry_drop_1s": ("Entry drop by 1s", "pp", "R(0)-R(1)"),
        "entry_drop_3s": ("Entry drop by 3s", "pp", "R(0)-R(3)"),
        "entry_drop_5s": ("Entry drop by 5s", "pp", "R(0)-R(5)"),
    }
    for metric_id, (label, unit, formula) in replay_formulas.items():
        add(metric_id, label, "replay", "entry", unit, formula)

    shape_formulas = {
        "curve_total_variation": ("Curve total variation", "pp", "sum abs(delta R)"),
        "curve_net_drop": ("Curve net drop", "pp", "R(0)-R(duration)"),
        "curve_positive_area": ("Total rebound magnitude", "pp", "sum max(delta R,0)"),
        "curve_negative_area": ("Total decline magnitude", "pp", "sum max(-delta R,0)"),
        "curve_rebound_count": ("Rebound count", "count", "negative-to-positive first-difference sign changes"),
        "curve_slope_sd": ("Slope variability", "pp/s", "SD of local slopes"),
        "curve_curvature_sd": ("Curvature variability", "pp/s2", "SD of local second derivative"),
        "curve_max_drop_rate": ("Maximum local drop rate", "pp/s", "minimum local slope"),
        "curve_max_rebound_rate": ("Maximum local rebound rate", "pp/s", "maximum local slope"),
        "curve_largest_change_time": ("Largest slope-change time", "seconds", "argmax abs(local second derivative)"),
        "curve_change_entropy": ("Curve-change entropy", "0-1", "normalized entropy of abs first differences"),
    }
    for metric_id, (label, unit, formula) in shape_formulas.items():
        add(metric_id, label, "global_shape", "full_curve", unit, formula)

    return defs


def compute_base_metrics(row: dict, defs: list[MetricDef]) -> dict[str, float]:
    out: dict[str, float] = {
        "traditional_keep": safe_float(row.get("keep_rate")),
        "traditional_avg_retention": safe_float(row.get("avg_retention")),
        "traditional_log_views": math.log10(max(1.0, safe_float(row.get("views"), 1.0))),
    }
    start = ret_at(row, 0.0)
    hook = safe_float(row.get("hookEndSec"))
    hook_ret = ret_at(row, hook)
    window_cache: dict[tuple[str, float], tuple[np.ndarray, np.ndarray]] = {}
    for anchor in ("start", "hook"):
        anchor_time = 0.0 if anchor == "start" else hook
        for width in [0.5, 1, 2, 3, 5, 8, 10, 15, 20]:
            window_cache[(anchor, float(width))] = sample_window(row, anchor_time, anchor_time + width)
    boundary_cache = {}
    for width in [1, 2, 3, 5, 8, 10]:
        pre_t, pre_v = sample_window(row, hook - width, hook)
        post_t, post_v = sample_window(row, hook, hook + width)
        boundary_cache[float(width)] = (ls_slope(pre_t, pre_v), ls_slope(post_t, post_v))
    profiles, local_slopes, local_step = flat_profiles(row, [1, 2, 3, 5, 8, 10])

    for definition in defs:
        metric_id = definition.id
        if metric_id in out:
            continue
        params = definition.parameters
        if metric_id.startswith("abs_raw_"):
            out[metric_id] = ret_at(row, params["seconds"])
        elif metric_id.startswith("abs_startnorm_"):
            out[metric_id] = normalized(ret_at(row, params["seconds"]), start)
        elif metric_id.startswith("abs_excesssens_"):
            out[metric_id] = constant_excess_corrected(ret_at(row, params["seconds"]), start)
        elif metric_id.startswith("frac_raw_"):
            out[metric_id] = ret_at_fraction(row, params["fraction"])
        elif metric_id.startswith("frac_startnorm_"):
            out[metric_id] = normalized(ret_at_fraction(row, params["fraction"]), start)
        elif metric_id.startswith("hook_raw_"):
            out[metric_id] = ret_at(row, hook + params["offset"])
        elif metric_id.startswith("hook_startnorm_"):
            out[metric_id] = normalized(ret_at(row, hook + params["offset"]), start)
        elif metric_id.startswith("hook_hooknorm_"):
            out[metric_id] = normalized(ret_at(row, hook + params["offset"]), hook_ret)
        elif "_window_" in metric_id:
            anchor_time = 0.0 if params["anchor"] == "start" else hook
            times, values = window_cache[(params["anchor"], float(params["width"]))]
            if metric_id.endswith("_ls_slope"):
                out[metric_id] = ls_slope(times, values)
            elif metric_id.endswith("_endpoint_slope"):
                out[metric_id] = endpoint_slope(times, values)
            elif metric_id.endswith("_raw_auc"):
                out[metric_id] = mean_area(times, values)
            elif metric_id.endswith("_anchornorm_auc"):
                out[metric_id] = normalized(mean_area(times, values), ret_at(row, anchor_time))
        elif metric_id.startswith("hook_slope_change_") or metric_id.startswith("hook_slope_ratio_"):
            width = params["width"]
            pre, post = boundary_cache[float(width)]
            if metric_id.startswith("hook_slope_change_"):
                out[metric_id] = post - pre if finite(pre) and finite(post) else np.nan
            else:
                out[metric_id] = abs(post) / (abs(pre) + EPS) if finite(pre) and finite(post) else np.nan
        elif "_cross_" in metric_id:
            anchor_time = 0.0 if params["anchor"] == "start" else hook
            out[metric_id] = first_crossing(row, anchor_time, params["ratio"], params["horizon"])
        elif metric_id.startswith("flat_best_") or metric_id.startswith("flat_median_"):
            starts, slopes = profiles.get(float(params["width"]), (np.asarray([], float), np.asarray([], float)))
            mask = np.isfinite(slopes)
            if mask.any():
                valid_indices = np.where(mask)[0]
                best_index = int(valid_indices[np.argmin(np.abs(slopes[mask]))])
                best_start = float(starts[best_index])
                best_slope = float(slopes[best_index])
                median_abs = float(np.nanmedian(np.abs(slopes)))
            else:
                best_start = best_slope = median_abs = np.nan
            if metric_id.startswith("flat_best_start_"):
                out[metric_id] = best_start
            elif metric_id.startswith("flat_best_slope_"):
                out[metric_id] = best_slope
            else:
                out[metric_id] = median_abs
        elif metric_id.startswith("flat_first_"):
            starts, slopes = profiles.get(float(params["width"]), (np.asarray([], float), np.asarray([], float)))
            valid = np.where(np.isfinite(slopes) & (np.abs(slopes) <= params["threshold"]))[0]
            out[metric_id] = float(starts[valid[0]]) if len(valid) else safe_float(row.get("duration_s"))
        elif metric_id.startswith("flat_longest_"):
            longest = current = 0
            for flag in np.abs(local_slopes) <= params["threshold"]:
                current = current + 1 if flag else 0
                longest = max(longest, current)
            out[metric_id] = float(longest * local_step) if len(local_slopes) else np.nan

    out.update(replay_descriptors(row))
    out.update(shape_descriptors(row))
    return out


def standardized_curve_matrix(rows: list[dict], coordinate: str) -> tuple[np.ndarray, np.ndarray]:
    if coordinate == "fraction_raw":
        grid = np.linspace(0.0, 1.0, 101)
        matrix = [[ret_at_fraction(row, float(x)) for x in grid] for row in rows]
    elif coordinate == "fraction_startnorm":
        grid = np.linspace(0.0, 1.0, 101)
        matrix = []
        for row in rows:
            start = ret_at(row, 0.0)
            matrix.append([normalized(ret_at_fraction(row, float(x)), start) for x in grid])
    elif coordinate == "hook_hooknorm":
        grid = np.linspace(-5.0, 20.0, 101)
        matrix = []
        for row in rows:
            hook = safe_float(row.get("hookEndSec"))
            anchor = ret_at(row, hook)
            matrix.append([normalized(ret_at(row, hook + float(x)), anchor) for x in grid])
    else:
        raise ValueError(coordinate)
    values = np.asarray(matrix, float)
    medians = np.nanmedian(values, axis=0)
    medians = np.where(np.isfinite(medians), medians, 0.0)
    values = np.where(np.isfinite(values), values, medians)
    return grid, values


def add_unsupervised_geometry(rows: list[dict], values: dict[str, dict[str, float]], defs: list[MetricDef], components=6) -> dict[str, Any]:
    bases: dict[str, Any] = {}
    coordinates = ["fraction_raw", "fraction_startnorm", "hook_hooknorm"]
    for coordinate in coordinates:
        grid, matrix = standardized_curve_matrix(rows, coordinate)
        channels = {
            "level": matrix,
            "slope": np.gradient(matrix, grid, axis=1),
            "curvature": np.gradient(np.gradient(matrix, grid, axis=1), grid, axis=1),
        }
        for channel, channel_matrix in channels.items():
            scaled = StandardScaler().fit_transform(channel_matrix)
            n_components = min(components, len(rows) - 1, scaled.shape[1])
            pca = PCA(n_components=n_components, random_state=1729).fit(scaled)
            scores = pca.transform(scaled)
            for idx in range(n_components):
                loading = pca.components_[idx].copy()
                pivot = int(np.argmax(np.abs(loading)))
                if loading[pivot] < 0:
                    loading *= -1
                    scores[:, idx] *= -1
                metric_id = f"unsup_{coordinate}_{channel}_pc{idx + 1}"
                defs.append(MetricDef(
                    metric_id,
                    f"{coordinate} {channel} PC {idx + 1}",
                    "unsupervised_curve",
                    coordinate,
                    "PC score",
                    "PCA score learned without text or performance labels",
                    {"channel": channel, "component": idx + 1},
                ))
                for row_idx, row in enumerate(rows):
                    values[str(row["id"])][metric_id] = float(scores[row_idx, idx])
                bases[metric_id] = {
                    "grid": [round(float(x), 4) for x in grid],
                    "loading": [round(float(x), 6) for x in loading],
                    "explainedVariance": round(float(pca.explained_variance_ratio_[idx]), 6),
                    "channel": channel,
                    "coordinate": coordinate,
                }

    # DCT descriptors provide a second, non-PCA multi-scale shape family.
    for coordinate in ("fraction_startnorm", "hook_hooknorm"):
        grid, matrix = standardized_curve_matrix(rows, coordinate)
        for channel, channel_matrix in {
            "level": matrix,
            "slope": np.gradient(matrix, grid, axis=1),
        }.items():
            coefficients = dct(channel_matrix, type=2, norm="ortho", axis=1)
            for idx in range(1, 9):
                metric_id = f"spectral_{coordinate}_{channel}_dct{idx}"
                defs.append(MetricDef(
                    metric_id,
                    f"{coordinate} {channel} DCT {idx}",
                    "spectral_curve",
                    coordinate,
                    "coefficient",
                    "Discrete cosine transform coefficient",
                    {"channel": channel, "coefficient": idx},
                ))
                for row_idx, row in enumerate(rows):
                    values[str(row["id"])][metric_id] = float(coefficients[row_idx, idx])
                bases[metric_id] = {
                    "grid": [round(float(x), 4) for x in grid],
                    "channel": channel,
                    "coordinate": coordinate,
                    "coefficient": idx,
                }
    return bases


def build_geometry_atlas(rows: list[dict], minimum_n=120) -> tuple[np.ndarray, list[MetricDef], dict[str, Any], dict[str, dict[str, float]]]:
    defs = base_metric_defs()
    values: dict[str, dict[str, float]] = {}
    for row in rows:
        values[str(row["id"])] = compute_base_metrics(row, defs)
    bases = add_unsupervised_geometry(rows, values, defs)

    kept_defs = []
    columns = []
    for definition in defs:
        column = np.asarray([safe_float(values[str(row["id"])].get(definition.id)) for row in rows], float)
        if int(np.isfinite(column).sum()) >= minimum_n and np.nanstd(column) > EPS:
            kept_defs.append(definition)
            columns.append(column)
    matrix = np.column_stack(columns) if columns else np.zeros((len(rows), 0), float)
    kept_ids = {definition.id for definition in kept_defs}
    bases = {key: value for key, value in bases.items() if key in kept_ids}
    for row_values in values.values():
        for metric_id in list(row_values):
            if metric_id not in kept_ids:
                row_values.pop(metric_id, None)
    return matrix, kept_defs, bases, values
