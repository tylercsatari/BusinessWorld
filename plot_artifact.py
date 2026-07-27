"""Build the compact, server-side projection artifact shared by both Quant maps."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Iterable, Mapping, Sequence


PLOT_VERSION = 1
MAX_SAMPLE_POINTS = 360

SHORT_PROJECTIONS = ("keep", "ret5", "views", "realviews", "outlier", "hi10m")
LONG_PROJECTIONS = ("ctrviews", "ctr", "ret30", "views", "realviews", "hi10m", "outlier")

_RAW_VIEWS_PROJECTIONS = frozenset(("views", "hi10m"))
_OUTLIER_PROJECTIONS = frozenset(("outlier",))
_OUTCOME_PROJECTIONS = frozenset(("keep", "ret5", "realviews", "ctrviews", "ctr", "ret30"))


def _finite_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    return value


def _integer_coordinates(values: Any, projection: str, axis: str, n: int) -> list[int]:
    if not isinstance(values, list) or len(values) != n:
        size = len(values) if isinstance(values, list) else "missing"
        raise ValueError(
            f"{projection}.{axis} must contain exactly {n} coordinates; found {size}"
        )

    coordinates = []
    for index, value in enumerate(values):
        number = _finite_number(value)
        if number is None or not float(number).is_integer():
            raise ValueError(
                f"{projection}.{axis}[{index}] must be a finite integer coordinate"
            )
        coordinates.append(int(number))
    return coordinates


def _aligned_values(values: Any, n: int) -> list[Any] | None:
    return values if isinstance(values, list) and len(values) == n else None


def _outcome_colors(projection: Mapping[str, Any], x: Sequence[int], n: int) -> tuple[list[Any], str]:
    actual = _aligned_values(projection.get("actual"), n)
    estimated = _aligned_values(projection.get("est"), n)
    if actual is None and estimated is None:
        return list(x), "x"

    colors = []
    for index in range(n):
        value = _finite_number(actual[index]) if actual is not None else None
        if value is None and estimated is not None:
            value = _finite_number(estimated[index])
        colors.append(value)
    return colors, "actual/est"


def _color_values(
    name: str,
    projection: Mapping[str, Any],
    full_map: Mapping[str, Any],
    x: Sequence[int],
    n: int,
) -> tuple[list[Any], str]:
    if name in _RAW_VIEWS_PROJECTIONS:
        views = _aligned_values(full_map.get("views"), n)
        if views is not None:
            return [_finite_number(value) for value in views], "raw views"
    elif name in _OUTLIER_PROJECTIONS:
        outlier = _aligned_values(full_map.get("outlier"), n)
        if outlier is not None:
            return [_finite_number(value) for value in outlier], "outlier"
    elif name in _OUTCOME_PROJECTIONS:
        return _outcome_colors(projection, x, n)
    return list(x), "x"


def _sample_indices(ids: Sequence[Any], channel: str, limit: int) -> list[int]:
    if len(ids) <= limit:
        return list(range(len(ids)))

    ranked = []
    for index, exact_id in enumerate(ids):
        encoded_id = json.dumps(
            exact_id, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        digest = hashlib.sha256(
            f"{channel}\0{index}\0{encoded_id}".encode("utf-8")
        ).digest()
        ranked.append((digest, index))
    return sorted(index for _, index in sorted(ranked)[:limit])


def _range(values: Iterable[Any]) -> tuple[int | float | None, int | float | None]:
    finite = [value for value in values if _finite_number(value) is not None]
    return (min(finite), max(finite)) if finite else (None, None)


def build_plot_artifact(
    full_map: Mapping[str, Any],
    channel: str,
    projection_names: Sequence[str],
    sample_limit: int = MAX_SAMPLE_POINTS,
) -> dict[str, Any]:
    """Return the deterministic version-1 plot artifact for one enriched channel map."""
    if not isinstance(channel, str) or not channel:
        raise ValueError("channel must be a non-empty string")
    if not isinstance(sample_limit, int) or not 0 < sample_limit <= MAX_SAMPLE_POINTS:
        raise ValueError(f"sample_limit must be between 1 and {MAX_SAMPLE_POINTS}")

    ids = full_map.get("id")
    if not isinstance(ids, list):
        raise ValueError("map.id must be a list")
    n = len(ids)
    if full_map.get("n") is not None and full_map.get("n") != n:
        raise ValueError(f"map.n is {full_map.get('n')}, but map.id contains {n} ids")

    source_plots = full_map.get("proj")
    if not isinstance(source_plots, dict):
        raise ValueError("map.proj must be an object")

    sample = _sample_indices(ids, channel, sample_limit)
    plots = {}
    for name in projection_names:
        projection = source_plots.get(name)
        if not isinstance(projection, dict):
            raise ValueError(f"required experiment projection {name!r} is missing")
        x = _integer_coordinates(projection.get("x"), name, "x", n)
        y = _integer_coordinates(projection.get("y"), name, "y", n)
        colors, color_kind = _color_values(name, projection, full_map, x, n)
        z_min, z_max = _range(colors)
        plots[name] = {
            "x": x,
            "y": y,
            "points": [[x[index], y[index], colors[index]] for index in sample],
            "zMin": z_min,
            "zMax": z_max,
            "colorKind": color_kind,
            "cv": _finite_number(projection.get("cv")),
            "co": _finite_number(projection.get("co")),
        }

    return {
        "version": PLOT_VERSION,
        "channel": channel,
        "n": n,
        "id": list(ids),
        "plots": plots,
    }


def encode_plot_artifact(artifact: Mapping[str, Any]) -> bytes:
    """Serialize without whitespace or non-standard NaN/Infinity JSON values."""
    return json.dumps(
        artifact,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
