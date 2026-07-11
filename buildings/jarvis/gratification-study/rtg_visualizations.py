"""Build the lazy visual evidence artifact for the RTG research program."""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler


SEED = 1729
VISUALIZATIONS_KEY = "longform/gratification/v2/visualizations.json.gz"
STRICT_ADJUSTMENTS = {"delivery_entry_idea", "full_pre_exposure"}
RESULT_FIELDS = (
    "id", "target", "targetFamily", "representation", "adjustment", "scope",
    "alpha", "n", "rho", "r2", "p", "q", "signStability", "foldRhos", "valid",
)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _finite(value: Any) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def _number(value: Any, digits=6) -> float | None:
    return round(float(value), digits) if _finite(value) else None


def _values(values: np.ndarray, digits=4) -> list[float | None]:
    return [_number(value, digits) for value in np.asarray(values).reshape(-1)]


def _compact_result(row: dict | None) -> dict | None:
    if not row:
        return None
    return {key: row.get(key) for key in RESULT_FIELDS if key in row}


def _result_score(row: dict | None) -> tuple[float, float, float]:
    if not row or not _finite(row.get("rho")):
        return (-1.0, -1e9, -1e9)
    q_pass = 1.0 if _finite(row.get("q")) and float(row["q"]) <= 0.05 else 0.0
    stability = float(row.get("signStability") or 0.0)
    rho = float(row["rho"])
    r2 = float(row["r2"]) if _finite(row.get("r2")) else -1e9
    return (q_pass, rho * (0.5 + 0.5 * stability), r2)


def _better(current: dict | None, candidate: dict) -> dict:
    return candidate if current is None or _result_score(candidate) > _result_score(current) else current


def _summary() -> dict[str, Any]:
    return {
        "tests": 0,
        "valid": 0,
        "fdr05": 0,
        "positiveR2": 0,
        "stable": 0,
        "qualified": 0,
        "aboveNull": 0,
        "bestAny": None,
        "bestQualified": None,
    }


def _update_summary(summary: dict, row: dict, null_threshold: float | None = None) -> None:
    summary["tests"] += 1
    if not row.get("valid") or not _finite(row.get("rho")):
        return
    summary["valid"] += 1
    if _finite(row.get("q")) and float(row["q"]) <= 0.05:
        summary["fdr05"] += 1
    if _finite(row.get("r2")) and float(row["r2"]) > 0:
        summary["positiveR2"] += 1
    if float(row.get("signStability") or 0.0) >= 0.6:
        summary["stable"] += 1
    qualified = (
        _finite(row.get("r2")) and float(row["r2"]) > 0
        and float(row.get("signStability") or 0.0) >= 0.6
    )
    if qualified:
        summary["qualified"] += 1
    if null_threshold is not None and float(row["rho"]) > null_threshold:
        summary["aboveNull"] += 1
    summary["bestAny"] = _better(summary["bestAny"], row)
    if qualified:
        summary["bestQualified"] = _better(summary["bestQualified"], row)


def _finish_summary(summary: dict, **identity: Any) -> dict[str, Any]:
    return {
        **identity,
        **{key: summary[key] for key in ("tests", "valid", "fdr05", "positiveR2", "stable", "qualified", "aboveNull")},
        "best": _compact_result(summary["bestQualified"] or summary["bestAny"]),
        "bestQualified": _compact_result(summary["bestQualified"]),
        "bestAny": _compact_result(summary["bestAny"]),
    }


def _null_max(report: dict, family: str) -> float:
    values = (((report.get("nullCalibration") or {}).get("maxRho") or {}).get(family) or [])
    finite_values = [float(value) for value in values if _finite(value)]
    return max(finite_values) if finite_values else float("nan")


def analyze_registry(
    report: dict,
    registry_path: Path,
    geometry: np.ndarray,
    metric_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Summarize every registered row without retaining the million-row registry."""
    metric_defs = (report.get("geometry") or {}).get("metrics") or []
    metric_lookup = {definition["id"]: definition for definition in metric_defs}
    representation_defs = report.get("representations") or []
    representation_lookup = {definition["id"]: definition for definition in representation_defs}
    adjustment_defs = report.get("adjustments") or {}
    global_null = _null_max(report, "global")
    within_null = _null_max(report, "withinIdea")

    best_unrestricted: dict[str, dict] = {}
    best_strict_any: dict[str, dict] = {}
    best_strict_qualified: dict[str, dict] = {}
    best_pair_any: dict[str, dict] = {}
    best_pair_qualified: dict[str, dict] = {}
    best_nuisance: dict[str, dict] = {}
    families = defaultdict(_summary)
    pair_families = defaultdict(_summary)
    representations = defaultdict(_summary)
    pair_representations = defaultdict(_summary)
    nuisance_representations = defaultdict(_summary)
    adjustments = defaultdict(_summary)
    heatmap = defaultdict(_summary)
    pair_heatmap = defaultdict(_summary)
    counts = defaultdict(int)
    unique_sets = defaultdict(set)

    with gzip.open(registry_path, "rt", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            counts["registryRows"] += 1
            scope = row.get("scope") or "video"
            counts[scope] += 1
            target = str(row.get("target") or "")
            family = str(row.get("targetFamily") or "")
            representation = str(row.get("representation") or "")
            adjustment = str(row.get("adjustment") or "")
            valid = bool(row.get("valid")) and _finite(row.get("rho"))
            qualified = valid and _finite(row.get("r2")) and float(row["r2"]) > 0 and float(row.get("signStability") or 0) >= 0.6

            if scope == "video":
                if valid:
                    best_unrestricted[target] = _better(best_unrestricted.get(target), row)
                _update_summary(adjustments[adjustment], row)
                if adjustment in STRICT_ADJUSTMENTS:
                    if valid:
                        best_strict_any[target] = _better(best_strict_any.get(target), row)
                    if qualified:
                        best_strict_qualified[target] = _better(best_strict_qualified.get(target), row)
                    _update_summary(families[family], row, global_null if _finite(global_null) else None)
                    _update_summary(representations[representation], row, global_null if _finite(global_null) else None)
                    _update_summary(heatmap[(representation, family)], row, global_null if _finite(global_null) else None)
                    if qualified:
                        unique_sets["strictQualifiedIndicators"].add(target)
                    if valid and _finite(row.get("q")) and float(row["q"]) <= 0.05:
                        unique_sets["strictFdrIndicators"].add(target)
                    if valid and _finite(global_null) and float(row["rho"]) > global_null:
                        unique_sets["strictAboveNullIndicators"].add(target)
            elif scope == "same_idea_difference" and adjustment in STRICT_ADJUSTMENTS:
                if valid:
                    best_pair_any[target] = _better(best_pair_any.get(target), row)
                if qualified:
                    best_pair_qualified[target] = _better(best_pair_qualified.get(target), row)
                _update_summary(pair_families[family], row, within_null if _finite(within_null) else None)
                _update_summary(pair_representations[representation], row, within_null if _finite(within_null) else None)
                _update_summary(pair_heatmap[(representation, family)], row, within_null if _finite(within_null) else None)
                if qualified:
                    unique_sets["pairQualifiedIndicators"].add(target)
                if valid and _finite(within_null) and float(row["rho"]) > within_null:
                    unique_sets["pairAboveNullIndicators"].add(target)
            elif scope == "nuisance_prediction":
                if valid:
                    best_nuisance[representation] = _better(best_nuisance.get(representation), row)
                _update_summary(nuisance_representations[representation], row)

    metric_index = {
        str(metric_id): index
        for index, metric_id in enumerate(metric_ids or [definition["id"] for definition in metric_defs])
    }
    indicators = []
    for definition in metric_defs:
        metric_id = definition["id"]
        strict_any = best_strict_any.get(metric_id)
        strict_qualified = best_strict_qualified.get(metric_id)
        strict = strict_qualified or strict_any
        pair = best_pair_qualified.get(metric_id) or best_pair_any.get(metric_id)
        index = metric_index.get(metric_id)
        column = geometry[:, index] if index is not None and index < geometry.shape[1] else np.asarray([], float)
        finite_column = column[np.isfinite(column)]
        selection_clear = bool(strict and _finite(global_null) and float(strict["rho"]) > global_null)
        pair_clear = bool(pair and _finite(within_null) and float(pair["rho"]) > within_null)
        if selection_clear:
            status = "null_clear"
        elif strict_qualified:
            status = "candidate"
        elif strict_any and _finite(strict_any.get("rho")) and float(strict_any["rho"]) > 0:
            status = "screening"
        else:
            status = "no_signal"
        if pair_clear:
            pair_status = "null_clear"
        elif best_pair_qualified.get(metric_id):
            pair_status = "candidate"
        elif best_pair_any.get(metric_id) and _finite(best_pair_any[metric_id].get("rho")) and float(best_pair_any[metric_id]["rho"]) > 0:
            pair_status = "screening"
        else:
            pair_status = "no_signal"
        indicators.append({
            **definition,
            "status": status,
            "pairStatus": pair_status,
            "selectionNullClear": selection_clear,
            "pairNullClear": pair_clear,
            "globalNullGap": round(float(strict["rho"]) - global_null, 6) if strict and _finite(global_null) else None,
            "withinIdeaNullGap": round(float(pair["rho"]) - within_null, 6) if pair and _finite(within_null) else None,
            "bestStrict": _compact_result(strict),
            "bestStrictQualified": _compact_result(strict_qualified),
            "bestStrictAny": _compact_result(strict_any),
            "bestPair": _compact_result(pair),
            "bestUnrestricted": _compact_result(best_unrestricted.get(metric_id)),
            "distribution": {
                "n": int(len(finite_column)),
                "min": _number(np.min(finite_column)) if len(finite_column) else None,
                "q25": _number(np.quantile(finite_column, 0.25)) if len(finite_column) else None,
                "median": _number(np.median(finite_column)) if len(finite_column) else None,
                "q75": _number(np.quantile(finite_column, 0.75)) if len(finite_column) else None,
                "max": _number(np.max(finite_column)) if len(finite_column) else None,
            },
        })

    family_rows = []
    family_ids = sorted({definition.get("family") for definition in metric_defs if definition.get("family")})
    for family in family_ids:
        row = _finish_summary(families[family], id=family, label=family.replace("_", " "))
        row["pair"] = _finish_summary(pair_families[family])
        family_rows.append(row)

    representation_rows = []
    for definition in representation_defs:
        representation_id = definition["id"]
        row = _finish_summary(representations[representation_id], **definition)
        row["pair"] = _finish_summary(pair_representations[representation_id])
        row["nuisance"] = _finish_summary(nuisance_representations[representation_id])
        strict_best = row.get("best") or {}
        nuisance_best = row["nuisance"].get("best") or {}
        row["specificityDiagnostic"] = (
            round(float(strict_best["rho"]) - float(nuisance_best["rho"]), 6)
            if _finite(strict_best.get("rho")) and _finite(nuisance_best.get("rho")) else None
        )
        representation_rows.append(row)

    adjustment_rows = [
        _finish_summary(adjustments[adjustment], id=adjustment, **(adjustment_defs.get(adjustment) or {}))
        for adjustment in adjustment_defs
    ]
    heatmap_rows = []
    for definition in representation_defs:
        representation = definition["id"]
        for family in family_ids:
            video = _finish_summary(heatmap[(representation, family)])
            pair = _finish_summary(pair_heatmap[(representation, family)])
            heatmap_rows.append({
                "representation": representation,
                "family": family,
                "video": video,
                "pair": pair,
            })

    strict_leader = max(best_strict_qualified.values(), key=_result_score) if best_strict_qualified else None
    pair_leader = max(best_pair_qualified.values(), key=_result_score) if best_pair_qualified else None
    unrestricted_leader = max(best_unrestricted.values(), key=_result_score) if best_unrestricted else None
    family_leader = max(family_rows, key=lambda row: _result_score(row.get("best"))) if family_rows else None
    findings = [
        {
            "id": "promotion_verdict",
            "status": "not_promoted",
            "title": "No RTG direction clears the current selection-wide null",
            "strictLeader": _compact_result(strict_leader),
            "pairLeader": _compact_result(pair_leader),
            "globalNullMax": _number(global_null),
            "withinIdeaNullMax": _number(within_null),
        },
        {
            "id": "adjusted_leader",
            "status": "candidate",
            "title": "Strongest fully adjusted video-level indicator",
            "result": _compact_result(strict_leader),
            "metric": metric_lookup.get((strict_leader or {}).get("target")),
        },
        {
            "id": "family_pattern",
            "status": "candidate",
            "title": "Strongest adjusted indicator family",
            "family": family_leader,
        },
        {
            "id": "same_idea_leader",
            "status": "observational",
            "title": "Strongest same-ish-idea difference indicator",
            "result": _compact_result(pair_leader),
            "metric": metric_lookup.get((pair_leader or {}).get("target")),
        },
        {
            "id": "unrestricted_warning",
            "status": "confounded",
            "title": "Strong unrestricted result rejected as construct evidence",
            "result": _compact_result(unrestricted_leader),
            "metric": metric_lookup.get((unrestricted_leader or {}).get("target")),
        },
    ]

    return {
        "nulls": {"globalMax": _number(global_null), "withinIdeaMax": _number(within_null)},
        "counts": {
            **dict(counts),
            **{
                key: len(unique_sets[key])
                for key in (
                    "strictQualifiedIndicators", "strictFdrIndicators", "strictAboveNullIndicators",
                    "pairQualifiedIndicators", "pairAboveNullIndicators",
                )
            },
            "indicators": len(metric_defs),
            "promotedIndicators": 0,
        },
        "findings": findings,
        "families": family_rows,
        "representations": representation_rows,
        "adjustments": adjustment_rows,
        "heatmap": heatmap_rows,
        "indicators": indicators,
        "bestStrictAny": {key: _compact_result(value) for key, value in best_strict_any.items()},
        "bestStrictQualified": {key: _compact_result(value) for key, value in best_strict_qualified.items()},
        "bestPair": {key: _compact_result(best_pair_qualified.get(key) or value) for key, value in best_pair_any.items()},
        "bestNuisanceByRepresentation": {key: _compact_result(value) for key, value in best_nuisance.items()},
        "rules": {
            "candidate": "Fully adjusted, positive held-out R2, at least 60% positive folds, but not selection-null promoted.",
            "screening": "A valid adjusted association that does not satisfy every candidate gate.",
            "nullClear": "Observed OOF rho exceeds the current finite selection-repeating null maximum; this alone is not construct promotion.",
            "promoted": "Always false until every emergence and controlled-variant gate is satisfied.",
        },
        "representationLookup": representation_lookup,
    }


def _clean_matrix(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, float)
    medians = np.nanmedian(values, axis=0)
    medians = np.where(np.isfinite(medians), medians, 0.0)
    return np.where(np.isfinite(values), values, medians)


def _scale_map(values: np.ndarray) -> list[float]:
    values = np.asarray(values, float)
    finite_values = values[np.isfinite(values)]
    if not len(finite_values):
        return [50.0] * len(values)
    low, high = np.quantile(finite_values, [0.02, 0.98])
    if high - low < 1e-9:
        low, high = float(np.min(finite_values)), float(np.max(finite_values))
    if high - low < 1e-9:
        return [50.0] * len(values)
    scaled = 100.0 * (np.clip(values, low, high) - low) / (high - low)
    return [round(float(value), 4) for value in scaled]


def _pca_projection(values: np.ndarray) -> tuple[dict[str, Any], np.ndarray]:
    clean = _clean_matrix(values)
    model = PCA(n_components=2, random_state=SEED).fit(clean)
    transformed = model.transform(clean)
    return ({
        "x": _scale_map(transformed[:, 0]),
        "y": _scale_map(transformed[:, 1]),
        "method": "PCA on centered representation values; no outcome used",
        "explainedVariance": [round(float(value), 6) for value in model.explained_variance_ratio_],
    }, transformed[:, 1])


def _umap_projection(values: np.ndarray, fallback: dict[str, Any], include_umap: bool) -> dict[str, Any]:
    if not include_umap:
        return {**fallback, "method": "PCA fallback used because UMAP was disabled"}
    try:
        from umap import UMAP

        clean = _clean_matrix(values)
        standardized = StandardScaler().fit_transform(clean)
        coordinates = UMAP(
            n_components=2,
            n_neighbors=min(15, max(2, len(clean) - 1)),
            min_dist=0.12,
            metric="cosine",
            random_state=SEED,
            n_jobs=1,
        ).fit_transform(standardized)
        return {
            "x": _scale_map(coordinates[:, 0]),
            "y": _scale_map(coordinates[:, 1]),
            "method": "UMAP of imputed, feature-standardized representation values; cosine metric; no outcome used",
            "nNeighbors": min(15, max(2, len(clean) - 1)),
            "minDist": 0.12,
            "seed": SEED,
        }
    except Exception as error:
        return {**fallback, "method": f"PCA fallback because UMAP was unavailable: {type(error).__name__}"}


def build_embedding_maps(report: dict, matrices: Any, include_umap=True) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    definitions = {definition["id"]: definition for definition in report.get("representations") or []}
    maps = {}
    pca_second = {}
    for representation_id, definition in definitions.items():
        key = f"representation_{representation_id}"
        if key not in matrices.files:
            continue
        values = np.asarray(matrices[key], float)
        pca, second = _pca_projection(values)
        maps[representation_id] = {
            **definition,
            "points": int(len(values)),
            "pca": pca,
            "umap": _umap_projection(values, pca, include_umap),
        }
        pca_second[representation_id] = second
    return maps, pca_second


def _standardize(values: np.ndarray) -> np.ndarray:
    clean = _clean_matrix(values)
    mean = np.mean(clean, axis=0)
    scale = np.std(clean, axis=0)
    scale = np.where(scale > 1e-9, scale, 1.0)
    return (clean - mean) / scale


def _ridge_axes(features: np.ndarray, targets: np.ndarray, columns: list[int], alpha: float, min_samples: int) -> dict[int, np.ndarray]:
    x = _standardize(features)
    groups: dict[bytes, list[int]] = defaultdict(list)
    for column in columns:
        groups[np.isfinite(targets[:, column]).tobytes()].append(column)
    output = {}
    for key, group_columns in groups.items():
        mask = np.frombuffer(key, dtype=bool, count=len(targets))
        if int(mask.sum()) < min_samples:
            continue
        x_train = x[mask]
        y_train = targets[np.ix_(mask, group_columns)]
        means = np.mean(y_train, axis=0)
        centered = y_train - means
        rows, dimensions = x_train.shape
        if dimensions <= rows:
            system = x_train.T @ x_train + alpha * np.eye(dimensions)
            try:
                weights = np.linalg.solve(system, x_train.T @ centered)
            except np.linalg.LinAlgError:
                weights = np.linalg.lstsq(system, x_train.T @ centered, rcond=None)[0]
        else:
            system = x_train @ x_train.T + alpha * np.eye(rows)
            try:
                dual = np.linalg.solve(system, centered)
            except np.linalg.LinAlgError:
                dual = np.linalg.lstsq(system, centered, rcond=None)[0]
            weights = x_train.T @ dual
        predictions = x @ weights + means
        for offset, column in enumerate(group_columns):
            output[column] = predictions[:, offset]
    return output


def build_indicator_axis_maps(
    report: dict,
    matrices: Any,
    result_summary: dict,
    pca_second: dict[str, np.ndarray],
    min_samples=30,
) -> dict[str, Any]:
    metric_ids = [str(value) for value in matrices["metric_ids"].tolist()]
    metric_index = {metric_id: index for index, metric_id in enumerate(metric_ids)}
    selected = result_summary.get("bestStrictAny") or {}
    grouped: dict[tuple[str, str, float], list[str]] = defaultdict(list)
    for metric_id, result in selected.items():
        if result and metric_id in metric_index:
            grouped[(result["representation"], result["adjustment"], float(result["alpha"]))].append(metric_id)
    output = {}
    for (representation, adjustment, alpha), target_ids in grouped.items():
        rep_key, adjusted_key = f"representation_{representation}", f"adjusted_{adjustment}"
        if rep_key not in matrices.files or adjusted_key not in matrices.files or representation not in pca_second:
            continue
        targets = np.asarray(matrices[adjusted_key], float)
        columns = [metric_index[target_id] for target_id in target_ids]
        axes = _ridge_axes(np.asarray(matrices[rep_key], float), targets, columns, alpha, min_samples)
        for target_id in target_ids:
            column = metric_index[target_id]
            if column not in axes:
                continue
            axis = axes[column]
            second = np.asarray(pca_second[representation], float)
            mask = np.isfinite(axis) & np.isfinite(second)
            centered_axis = axis - np.nanmean(axis[mask])
            beta = float(np.dot(centered_axis[mask], second[mask] - np.mean(second[mask])) / (np.dot(centered_axis[mask], centered_axis[mask]) + 1e-9))
            orthogonal = second - beta * centered_axis
            output[target_id] = {
                "experiment": selected[target_id],
                "x": _scale_map(axis),
                "y": _scale_map(orthogonal),
                "adjustedValues": _values(targets[:, column]),
                "method": "x = full-data descriptive ridge axis for the selected adjusted indicator; y = PCA2 residualized against x. OOF metrics, not these coordinates, are the evidence.",
            }
    return output


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_visualization_artifact(
    report: dict,
    matrices_path: Path,
    registry_path: Path,
    output_path: Path,
    *,
    include_umap=True,
    min_axis_samples=30,
) -> dict[str, Any]:
    with np.load(matrices_path, allow_pickle=False) as matrices:
        metric_ids = [str(value) for value in matrices["metric_ids"].tolist()]
        confound_ids = [str(value) for value in matrices["confound_ids"].tolist()]
        geometry = np.asarray(matrices["geometry"], float)
        confounds = np.asarray(matrices["confounds"], float)
        result_summary = analyze_registry(report, registry_path, geometry, metric_ids)
        maps, pca_second = build_embedding_maps(report, matrices, include_umap=include_umap)
        axis_maps = build_indicator_axis_maps(report, matrices, result_summary, pca_second, min_samples=min_axis_samples)
        payload = {
            "meta": {
                "version": 1,
                "builtAt": _now(),
                "videos": int(geometry.shape[0]),
                "representations": len(maps),
                "indicators": len(metric_ids),
                "confounds": len(confound_ids),
                "axisMaps": len(axis_maps),
                "registryRows": result_summary["counts"].get("registryRows", 0),
                "epistemicRule": "Outcome-blind maps show geometry. Candidate-axis maps are descriptive. Grouped OOF results and null comparisons determine evidence status.",
            },
            "videoIds": [str(value) for value in matrices["video_ids"].tolist()],
            "semanticGroups": [int(value) for value in matrices["semantic_groups"].tolist()],
            "maps": maps,
            "axisMaps": axis_maps,
            "indicatorValues": {
                metric_id: _values(geometry[:, index]) for index, metric_id in enumerate(metric_ids)
            },
            "confoundValues": {
                confound_id: _values(confounds[:, index]) for index, confound_id in enumerate(confound_ids)
            },
            "results": result_summary,
        }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output_path, "wt", encoding="utf-8", compresslevel=6) as handle:
        json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
    return {
        "key": VISUALIZATIONS_KEY,
        "sha256": _sha(output_path),
        "bytes": output_path.stat().st_size,
        "version": 1,
        "representations": len(maps),
        "indicators": len(metric_ids),
        "axisMaps": len(axis_maps),
    }
