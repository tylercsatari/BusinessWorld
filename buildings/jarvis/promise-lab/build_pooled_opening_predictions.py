#!/usr/bin/env python3
"""Apply the frozen Promise Lab scorer to every pooled Shorts account.

The 208 model-cohort rows keep their saved source-level OOF predictions. Every
other row is inferred before its measured retention curve is joined. This file
never trains, refits, recalibrates, or promotes a model stage.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import json
import os
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from embedding_store import EmbeddingStore, R2_PREFIX, R2Store, json_ready
from pooled_opening_evaluation import (
    CAPTION_TIMING_SOURCE,
    EVALUATION_VERSION,
    account_balanced_metrics,
    analysis_transcript_to_timed_words,
    attach_observed_retention,
    baseline_only_analysis,
    blind_manifest_entry,
    candidate_leakage_sensitivity,
    candidate_vs_baseline,
    caption_json3_to_timed_words,
    compact_summary,
    content_fingerprint,
    evaluation_by_account,
    evaluation_metrics,
    model_fingerprint,
    outcome_blind_prediction,
    prediction_text,
    prediction_fingerprint,
    strict_blind_external_selection,
    token_clock_from_timed_words,
)
from score_hook import load_artifact, score_timed_text


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
DETAIL_DIR = CACHE / "pooled-opening-predictions"
BLIND_DETAIL_DIR = CACHE / "pooled-opening-blind-predictions"
CAPTION_DIR = CACHE / "pooled-captions"
SUMMARY_PATH = CACHE / "pooled-opening-predictions.json"
BLIND_MANIFEST_PATH = CACHE / "pooled-opening-blind-manifest.json"
PROGRESS_PATH = CACHE / "pooled-opening-progress.json"
LOCK_PATH = CACHE / "pooled-opening-build.lock"
CHANNELS_PATH = ROOT / "buildings/jarvis/retention-study/channels.json"
SAVED_SUMMARY_PATH = CACHE / "opening-predictions.json"
SAVED_DETAIL_DIR = CACHE / "opening-predictions"
MODEL_FILES = (
    "canonical-partition-model.json",
    "opening-20s-model.json",
    "opening-retention-model.json",
)
ISOLATION_POLICIES = (
    ("exact-only", "exact content only", None),
    ("near-0.90", "token-trigram Jaccard at least 0.90", 0.90),
    ("near-0.80", "token-trigram Jaccard at least 0.80 · primary", 0.80),
    ("near-0.70", "token-trigram Jaccard at least 0.70", 0.70),
)
PRIMARY_ISOLATION_POLICY = "near-0.80"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(
            json_ready(value), separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def write_gzip_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    payload = json.dumps(
        json_ready(value), separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    temporary.write_bytes(gzip.compress(payload, compresslevel=6))
    temporary.replace(path)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prediction_input_fingerprint(video: dict, transcript: dict | None) -> str:
    payload = {
        "evaluationVersion": EVALUATION_VERSION,
        "videoId": str(video["id"]),
        "mediaDurationSeconds": video.get("duration_s"),
        "transcript": None if transcript is None else {
            "text": transcript.get("text"),
            "words": [{
                "word": row.get("word"),
                "timestamp": row.get("timestamp"),
                "duration": row.get("duration"),
            } for row in transcript.get("words") or []],
        },
    }
    return sha256_bytes(json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8"))


def prediction_input_row(video: dict) -> dict:
    """Allowlist inference inputs so outcomes are inaccessible by construction."""
    return {
        key: video.get(key) for key in (
            "id", "title", "url", "duration_s", "published",
            "accountId", "accountName",
        )
    }


def load_pooled_rows() -> tuple[list[dict], list[dict]]:
    registry = read_json(CHANNELS_PATH)
    rows = []
    accounts = []
    seen = set()
    for account in registry.get("channels") or []:
        account_id = str(account["id"])
        path = ROOT / "buildings/jarvis/retention-study" / str(account["table"])
        table = read_json(path)
        account_rows = table.get("videos") or []
        accounts.append({
            "id": account_id,
            "name": account.get("name") or account_id,
            "videos": len(account_rows),
            "owner": bool(account.get("owner")),
        })
        for row in account_rows:
            video_id = str(row.get("id") or "")
            if not video_id:
                continue
            if video_id in seen:
                raise RuntimeError(f"duplicate pooled video id: {video_id}")
            seen.add(video_id)
            rows.append({
                **row,
                "accountId": account_id,
                "accountName": account.get("name") or account_id,
            })
    return rows, accounts


def caption_path(video_id: str) -> Path | None:
    candidates = sorted(
        CAPTION_DIR.glob(f"{video_id}.*.json3"),
        key=lambda path: ("en-orig" not in path.name, path.name),
    )
    return candidates[0] if candidates else None


def timed_transcript(video: dict) -> tuple[dict | None, str, str | None]:
    video_id = str(video["id"])
    local = ROOT / "video_data" / video_id / "analysis.json"
    if local.exists():
        analysis = read_json(local)
        result = analysis_transcript_to_timed_words(
            analysis.get("transcript") or {}, video.get("duration_s"),
        )
        if result.get("words"):
            return result, "local analysis.transcript.words", None
    caption = caption_path(video_id)
    if caption:
        result = caption_json3_to_timed_words(
            read_json(caption), video.get("duration_s"),
        )
        if result.get("words"):
            return result, f"YouTube automatic captions · {caption.name}", None
        return None, "caption unavailable", str(result.get("status") or "no caption words")
    return None, "caption unavailable", "no public timestamped transcript was recovered"


def metric_record(detail: dict) -> dict:
    return {
        "videoId": detail.get("videoId"),
        "accountId": detail.get("accountId"),
        "published": detail.get("published"),
        "evaluationKind": detail.get("evaluationKind"),
        "predictionFitKind": detail.get("predictionFitKind"),
        "text": prediction_text(detail),
        "contentFingerprint": detail.get("contentFingerprint"),
        "blindPredictionFingerprint": detail.get("blindPredictionFingerprint"),
        "blindEvaluationRole": detail.get("blindEvaluationRole"),
        "strictBlindEligible": bool(detail.get("strictBlindEligible")),
        "blindIsolationPrimary": detail.get("blindIsolationPrimary"),
        "blindIsolationPolicies": detail.get("blindIsolationPolicies"),
        "blindContentComponentId": detail.get("blindContentComponentId"),
        "blindContentComponentSize": detail.get("blindContentComponentSize"),
        "blindContentComponentWeight": detail.get("blindContentComponentWeight"),
        "curves": {
            family: {
                key: (detail.get("curves") or {}).get(family, {}).get(key)
                for key in (
                    "timesSeconds", "predicted", "predictionP10",
                    "predictionP90", "actual", "stages", "selectedStage",
                    "candidateStage",
                )
            }
            for family in ("entryIndexed", "observedAbsolute")
        },
    }


def seal_blind_isolation(predictions: list[dict], blind_detail_dir: Path) -> tuple[dict, dict]:
    """Seal every content-isolation policy before any outcome is available."""
    policy_results = {}
    for policy_key, label, threshold in ISOLATION_POLICIES:
        selected, audit = strict_blind_external_selection(
            predictions,
            near_duplicate_threshold=threshold,
            include_sensitivity=policy_key == PRIMARY_ISOLATION_POLICY,
        )
        selected_by_id = {
            str(row.get("videoId")): row for row in selected
        }
        exact_overlap = set(audit.get("exactTrainingContentOverlapVideoIds") or [])
        near_overlap = set(audit.get("nearTrainingContentOverlapVideoIds") or [])
        unverifiable = set(audit.get("identityUnverifiableVideoIds") or [])
        per_video = {}
        for prediction in predictions:
            video_id = str(prediction.get("videoId"))
            kind = str(prediction.get("evaluationKind") or "")
            if not kind.startswith("cross-account-"):
                continue
            selected_row = selected_by_id.get(video_id)
            if selected_row is not None:
                per_video[video_id] = {
                    "policyKey": policy_key,
                    "label": label,
                    "nearDuplicateThreshold": threshold,
                    "eligible": True,
                    "status": "strict-blind-content-component",
                    "contentComponentId": selected_row.get("blindContentComponentId"),
                    "contentComponentSize": selected_row.get("blindContentComponentSize"),
                    "contentComponentWeight": selected_row.get("blindContentComponentWeight"),
                    "contentComponentMemberIndex": selected_row.get(
                        "blindContentComponentMemberIndex"
                    ),
                    "contentComponentMatchKind": selected_row.get(
                        "blindContentComponentMatchKind"
                    ),
                }
            elif video_id in exact_overlap:
                per_video[video_id] = {
                    "policyKey": policy_key, "label": label,
                    "nearDuplicateThreshold": threshold, "eligible": False,
                    "status": "excluded-exact-training-content-overlap",
                }
            elif video_id in near_overlap:
                per_video[video_id] = {
                    "policyKey": policy_key, "label": label,
                    "nearDuplicateThreshold": threshold, "eligible": False,
                    "status": "excluded-near-training-content-overlap",
                }
            elif video_id in unverifiable:
                per_video[video_id] = {
                    "policyKey": policy_key, "label": label,
                    "nearDuplicateThreshold": threshold, "eligible": False,
                    "status": "excluded-identity-unverifiable",
                }
            else:
                raise RuntimeError(
                    f"outcome-free isolation left external row unclassified: {video_id}"
                )
        policy_results[policy_key] = {
            "label": label,
            "threshold": threshold,
            "audit": audit,
            "perVideo": per_video,
        }

    for prediction in predictions:
        video_id = str(prediction.get("videoId"))
        kind = str(prediction.get("evaluationKind") or "")
        prediction.pop("blindContentComponentId", None)
        prediction.pop("blindContentComponentSize", None)
        prediction.pop("blindContentComponentWeight", None)
        prediction.pop("blindContentComponentMemberIndex", None)
        prediction.pop("blindContentComponentMatchKind", None)
        if kind.startswith("cross-account-"):
            policies = {
                policy_key: policy_results[policy_key]["perVideo"][video_id]
                for policy_key, _, _ in ISOLATION_POLICIES
            }
            primary = policies[PRIMARY_ISOLATION_POLICY]
            prediction["blindIsolationPolicies"] = policies
            prediction["blindIsolationPrimary"] = primary
            if primary.get("eligible"):
                prediction["blindContentComponentId"] = primary.get(
                    "contentComponentId"
                )
                prediction["blindContentComponentSize"] = primary.get(
                    "contentComponentSize"
                )
                prediction["blindContentComponentWeight"] = primary.get(
                    "contentComponentWeight"
                )
                prediction["blindContentComponentMemberIndex"] = primary.get(
                    "contentComponentMemberIndex"
                )
                prediction["blindContentComponentMatchKind"] = primary.get(
                    "contentComponentMatchKind"
                )
        else:
            prediction["blindIsolationPolicies"] = {}
            prediction["blindIsolationPrimary"] = {
                "policyKey": PRIMARY_ISOLATION_POLICY,
                "eligible": False,
                "status": (
                    "development-source-level-oof"
                    if kind == "saved-source-level-oof"
                    else "not-account-external"
                ),
            }
        prediction.setdefault("provenance", {}).update({
            "blindIsolationSealedBeforeOutcomeJoin": True,
            "blindIsolationPrimaryPolicy": PRIMARY_ISOLATION_POLICY,
            "blindIsolationUsesOutcomeFields": False,
        })
        prediction["blindPredictionFingerprint"] = prediction_fingerprint(prediction)
        write_gzip_json(
            blind_detail_dir / f"{prediction['videoId']}.json.gz", prediction,
        )

    public_audits = {
        policy_key: {
            "policyKey": policy_key,
            "label": result["label"],
            **result["audit"],
        }
        for policy_key, result in policy_results.items()
    }
    return public_audits[PRIMARY_ISOLATION_POLICY], public_audits


def annotate_prediction(detail: dict, video: dict, evaluation_kind: str,
                        transcript_source: str, fingerprint: str, fit_kind: str,
                        input_fingerprint: str | None = None,
                        oof_artifact_fingerprint: str | None = None) -> dict:
    detail = outcome_blind_prediction(detail)
    spoken_text = detail.get("text") or ((detail.get("input") or {}).get("analyzedText"))
    detail.update({
        "videoId": str(video["id"]),
        "title": video.get("title") or str(video["id"]),
        "url": video.get("url") or f"https://www.youtube.com/shorts/{video['id']}",
        "accountId": video.get("accountId"),
        "accountName": video.get("accountName"),
        "published": video.get("published"),
        "evaluationKind": evaluation_kind,
        "transcriptSource": transcript_source,
        "pooledEvaluationVersion": EVALUATION_VERSION,
        "pooledModelFingerprint": fingerprint if fit_kind != "source-level-oof" else None,
        "referenceFullFitModelFingerprint": fingerprint,
        "predictionFitKind": fit_kind,
        "pooledInputFingerprint": input_fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "contentFingerprint": content_fingerprint(spoken_text),
    })
    detail.setdefault("provenance", {}).update({
        "pooledEvaluationVersion": EVALUATION_VERSION,
        "pooledModelFingerprint": fingerprint if fit_kind != "source-level-oof" else None,
        "referenceFullFitModelFingerprint": fingerprint,
        "predictionFitKind": fit_kind,
        "pooledInputFingerprint": input_fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "pooledEvaluationKind": evaluation_kind,
        "observedCurveUsedForPrediction": False,
        "pooledEvaluationRefit": False,
        "pooledEvaluationRecalibration": False,
    })
    detail["blindPredictionFingerprint"] = prediction_fingerprint(detail)
    return detail


def saved_prediction(video: dict, fingerprint: str,
                     oof_artifact_fingerprint: str, blind_detail_dir: Path) -> dict:
    path = SAVED_DETAIL_DIR / f"{video['id']}.json.gz"
    detail = read_gzip_json(path)
    detail = annotate_prediction(
        detail, video, "saved-source-level-oof",
        "canonical source-media transcript and timing", fingerprint,
        "source-level-oof", oof_artifact_fingerprint=oof_artifact_fingerprint,
    )
    write_gzip_json(blind_detail_dir / f"{video['id']}.json.gz", detail)
    return detail


def score_external_prediction(video: dict, models: dict, store: EmbeddingStore,
                              fingerprint: str, refresh: bool,
                              blind_detail_dir: Path) -> tuple[dict, bool]:
    path = blind_detail_dir / f"{video['id']}.json.gz"
    transcript, transcript_source, unavailable_reason = timed_transcript(video)
    input_fingerprint = prediction_input_fingerprint(video, transcript)
    if path.exists() and not refresh:
        existing = read_gzip_json(path)
        same_model = existing.get("pooledModelFingerprint") == fingerprint
        same_evaluation = existing.get("pooledEvaluationVersion") == EVALUATION_VERSION
        same_input = existing.get("pooledInputFingerprint") == input_fingerprint
        needs_transcript_upgrade = (
            transcript is not None
            and existing.get("sourceKind") == "pooled-duration-only-selected-baseline"
        )
        if same_model and same_evaluation and same_input and not needs_transcript_upgrade:
            expected = existing.get("blindPredictionFingerprint")
            existing = outcome_blind_prediction(existing)
            actual = prediction_fingerprint(existing)
            if expected and expected != actual:
                raise RuntimeError(f"sealed prediction cache hash mismatch: {video['id']}")
            existing["blindPredictionFingerprint"] = actual
            return existing, True
    if transcript is None:
        detail = baseline_only_analysis(
            video, models["retention"], unavailable_reason or "transcript unavailable",
        )
        evaluation_kind = (
            "main-withheld-duration-only-full-fit"
            if video.get("accountId") == "tyler" else
            "cross-account-duration-only-frozen-baseline"
        )
    else:
        clock = token_clock_from_timed_words(transcript["text"], transcript["words"])
        detail = score_timed_text(
            transcript["text"], clock, timing_source=CAPTION_TIMING_SOURCE,
            media_duration_seconds=float(video["duration_s"]),
            partition_model=models["partition"], opening_model=models["opening"],
            opening_retention_model=models["retention"], store=store,
        )
        detail["scorerSourceKind"] = detail.get("sourceKind")
        detail["sourceKind"] = (
            "pooled-main-withheld-frozen-full-fit"
            if video.get("accountId") == "tyler" else
            "pooled-cross-account-frozen-full-fit"
        )
        evaluation_kind = (
            "main-withheld-frozen-full-fit"
            if video.get("accountId") == "tyler" else
            "cross-account-frozen-full-fit"
        )
        detail["captionTiming"] = {
            key: transcript.get(key) for key in (
                "status", "captionSegments", "wordCount", "spokenEndSeconds",
            )
        }
    detail = annotate_prediction(
        detail, video, evaluation_kind, transcript_source, fingerprint,
        (
            "frozen-selected-baseline-no-transcript"
            if transcript is None or detail.get("sourceKind") == "pooled-duration-only-selected-baseline"
            else "frozen-full-fit"
        ),
        input_fingerprint=input_fingerprint,
    )
    write_gzip_json(path, detail)
    return detail, False


def evaluation_bundle(records: list[dict], isolation_audit: dict) -> dict:
    by_kind = defaultdict(list)
    for record in records:
        by_kind[str(record.get("evaluationKind") or "unknown")].append(record)
    external = [
        record for record in records
        if str(record.get("evaluationKind") or "").startswith("cross-account-")
    ]
    new_predictions = [
        record for record in records
        if record.get("evaluationKind") != "saved-source-level-oof"
    ]
    strict_external = [
        record for record in records if record.get("strictBlindEligible") is True
    ]
    identity_unverifiable = [
        record for record in records
        if ((record.get("blindIsolationPrimary") or {}).get("status")
            == "excluded-identity-unverifiable")
    ]
    strict_by_account = evaluation_by_account(strict_external)
    strict_transcript = [
        row for row in strict_external
        if row.get("predictionFitKind") == "frozen-full-fit"
    ]
    strict_missing_transcript = [
        row for row in strict_external
        if row.get("predictionFitKind") == "frozen-selected-baseline-no-transcript"
    ]
    return {
        "allPooled": evaluation_metrics(records),
        "newFrozenPredictions": evaluation_metrics(new_predictions),
        "externalAccounts": evaluation_metrics(external),
        "strictBlindExternal": evaluation_metrics(strict_external),
        "strictBlindByAccount": strict_by_account,
        "strictBlindAccountBalanced": account_balanced_metrics(strict_external),
        "strictBlindCandidateVsBaseline": candidate_vs_baseline(strict_external),
        "strictBlindCandidateLeakageSensitivity": candidate_leakage_sensitivity(
            records
        ),
        "strictBlindByTranscriptStatus": {
            "timestampedTranscript": evaluation_metrics(strict_transcript),
            "missingTranscript": evaluation_metrics(strict_missing_transcript),
        },
        "identityUnverifiableExternal": evaluation_metrics(identity_unverifiable),
        "blindIsolationAudit": isolation_audit,
        "byAccount": evaluation_by_account(records),
        "byEvaluationKind": {
            kind: evaluation_metrics(group) for kind, group in sorted(by_kind.items())
        },
        "claimBoundary": (
            "The 208 saved cohort rows are source-level out of fold. Other Main rows "
            "use the unchanged full fit. Other accounts are account-external frozen-model "
            "evaluations. Primary blind metrics exclude exact and conservative near "
            "training-content overlap. Exact or near external repost members remain "
            "inspectable but share one sealed content-component statistical vote. "
            "Near-duplicate sensitivity is outcome-free and reported at multiple "
            "thresholds. Outcomes are opened only after the "
            "prediction manifest is sealed; no pooled outcome refits, recalibrates, or "
            "promotes the scorer."
        ),
    }


def upload(summary: dict, detail_dir: Path, blind_manifest: dict) -> None:
    expected_paths = []
    fingerprint = summary["modelFingerprint"]
    for row in summary.get("rows") or []:
        path = detail_dir / f"{row['videoId']}.json.gz"
        if not path.exists():
            raise RuntimeError(f"cannot publish without detail artifact: {row['videoId']}")
        detail = read_gzip_json(path)
        if str(detail.get("videoId")) != str(row["videoId"]):
            raise RuntimeError(f"detail ID mismatch: {row['videoId']}")
        if detail.get("pooledEvaluationVersion") != EVALUATION_VERSION:
            raise RuntimeError(f"stale evaluation detail: {row['videoId']}")
        if detail.get("referenceFullFitModelFingerprint") != fingerprint:
            raise RuntimeError(f"detail model reference mismatch: {row['videoId']}")
        if detail.get("evaluationGenerationId") != summary.get("generationId"):
            raise RuntimeError(f"detail generation mismatch: {row['videoId']}")
        expected_paths.append(path)

    remote = R2Store()
    remote.put_json(
        f"{R2_PREFIX}/pooled-opening-blind-generations/"
        f"{blind_manifest['blindGenerationId']}.json.gz",
        blind_manifest, gzip_payload=True,
    )

    def put(path: Path) -> str:
        remote.put_bytes(
            f"{R2_PREFIX}/pooled-opening-generations/"
            f"{summary['generationId']}/{path.name}",
            path.read_bytes(), "application/json", "gzip",
        )
        return path.stem.split(".")[0]

    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(put, path) for path in expected_paths]
        for index, job in enumerate(as_completed(jobs), 1):
            job.result()
            if index % 25 == 0 or index == len(jobs):
                print(f"uploaded details {index}/{len(jobs)}", flush=True)
    remote.put_json(
        f"{R2_PREFIX}/pooled-opening-predictions.json.gz", summary,
        gzip_payload=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--video-id", action="append", default=[])
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    pooled_rows, accounts = load_pooled_rows()
    canonical_source_count = len(pooled_rows)
    selected_ids = set(args.video_id)
    filtered_run = bool(selected_ids or args.limit > 0)
    if args.upload and filtered_run:
        raise RuntimeError("filtered preview runs cannot publish the canonical pooled artifact")
    if selected_ids:
        pooled_rows = [row for row in pooled_rows if str(row["id"]) in selected_ids]
    if args.limit > 0:
        pooled_rows = pooled_rows[:args.limit]
    if not pooled_rows:
        raise RuntimeError("the selected pooled run has no videos")

    if filtered_run:
        preview_key = sha256_bytes(json.dumps({
            "videoIds": [str(row["id"]) for row in pooled_rows],
            "evaluationVersion": EVALUATION_VERSION,
        }, sort_keys=True).encode("utf-8"))[:12]
        run_dir = CACHE / "pooled-opening-previews" / preview_key
        detail_dir = run_dir / "details"
        blind_detail_dir = run_dir / "blind-details"
        summary_path = run_dir / "summary.json"
        blind_manifest_path = run_dir / "blind-manifest.json"
        progress_path = run_dir / "progress.json"
    else:
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        build_lock = LOCK_PATH.open("a+")
        try:
            fcntl.flock(build_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("another canonical pooled build is already running") from error
        detail_dir = DETAIL_DIR
        blind_detail_dir = BLIND_DETAIL_DIR
        summary_path = SUMMARY_PATH
        blind_manifest_path = BLIND_MANIFEST_PATH
        progress_path = PROGRESS_PATH
    saved_summary = read_json(SAVED_SUMMARY_PATH)
    saved_ids = {str(row["videoId"]) for row in saved_summary.get("rows") or []}
    models = {
        "partition": load_artifact(MODEL_FILES[0]),
        "opening": load_artifact(MODEL_FILES[1]),
        "retention": load_artifact(MODEL_FILES[2]),
    }
    fingerprint = model_fingerprint(
        models["partition"], models["opening"], models["retention"],
    )
    oof_artifact_fingerprint = sha256_file(SAVED_SUMMARY_PATH)
    detail_dir.mkdir(parents=True, exist_ok=True)
    blind_detail_dir.mkdir(parents=True, exist_ok=True)
    store = EmbeddingStore(CACHE / "pooled-hook-embeddings.sqlite3")
    predictions = []
    failures = []
    resumed = 0
    lock = threading.Lock()
    started = time.time()
    completed = 0

    def record_prediction(prediction: dict, was_resumed: bool = False) -> None:
        nonlocal completed, resumed
        with lock:
            predictions.append(prediction)
            completed += 1
            resumed += int(was_resumed)
            if completed % 5 == 0 or completed == len(pooled_rows):
                write_json(progress_path, {
                    "version": 1,
                    "status": "building" if completed < len(pooled_rows) else "complete",
                    "completed": completed,
                    "total": len(pooled_rows),
                    "resumed": resumed,
                    "failed": len(failures),
                    "elapsedSeconds": time.time() - started,
                    "modelFingerprint": fingerprint,
                })
                print(
                    f"pooled {completed}/{len(pooled_rows)} · resumed {resumed} · "
                    f"errors {len(failures)}", flush=True,
                )

    prediction_rows = [prediction_input_row(row) for row in pooled_rows]
    for video in prediction_rows:
        if str(video["id"]) not in saved_ids:
            continue
        record_prediction(saved_prediction(
            video, fingerprint, oof_artifact_fingerprint, blind_detail_dir,
        ))

    external_rows = [
        row for row in prediction_rows if str(row["id"]) not in saved_ids
    ]
    try:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            jobs = {
                pool.submit(
                    score_external_prediction, video, models, store, fingerprint,
                    args.refresh, blind_detail_dir,
                ): video
                for video in external_rows
            }
            for job in as_completed(jobs):
                video = jobs[job]
                try:
                    prediction, was_resumed = job.result()
                    record_prediction(prediction, was_resumed)
                except Exception as error:
                    failures.append({
                        "videoId": video.get("id"),
                        "accountId": video.get("accountId"),
                        "error": str(error),
                    })
                    print(f"ERROR {video.get('id')}: {error}", flush=True)
    finally:
        store.close()

    order = {str(row["id"]): index for index, row in enumerate(pooled_rows)}
    predictions.sort(key=lambda row: order.get(str(row.get("videoId")), 10**9))
    if not filtered_run and len(predictions) != canonical_source_count:
        raise RuntimeError(
            f"refusing canonical promotion: built {len(predictions)} of "
            f"{canonical_source_count} registered videos"
        )

    isolation_audit, isolation_policy_audits = seal_blind_isolation(
        predictions, blind_detail_dir,
    )

    # Seal every outcome-blind serving prediction before opening any measured curve.
    blind_entries = [blind_manifest_entry(row) for row in predictions]
    for prediction, entry in zip(predictions, blind_entries):
        if prediction.get("blindPredictionFingerprint") != entry["predictionFingerprint"]:
            raise RuntimeError(
                f"prediction seal mismatch before outcome join: {prediction.get('videoId')}"
            )
    input_manifest_fingerprint = sha256_bytes(json.dumps([{
        key: row.get(key) for key in (
            "videoId", "accountId", "predictionFitKind", "inputFingerprint",
            "contentFingerprint", "blindIsolationPrimary",
        )
    } for row in blind_entries], sort_keys=True, separators=(",", ":")).encode("utf-8"))
    prediction_manifest_fingerprint = sha256_bytes(json.dumps([{
        "videoId": row.get("videoId"),
        "predictionFingerprint": row.get("predictionFingerprint"),
    } for row in blind_entries], sort_keys=True, separators=(",", ":")).encode("utf-8"))
    blind_generation_id = sha256_bytes(json.dumps({
        "evaluationVersion": EVALUATION_VERSION,
        "modelFingerprint": fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "inputManifestFingerprint": input_manifest_fingerprint,
        "predictionManifestFingerprint": prediction_manifest_fingerprint,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8"))[:20]
    development_ids = sorted(saved_ids)
    non_development_ids = sorted(
        str(row["id"]) for row in prediction_rows if str(row["id"]) not in saved_ids
    )
    account_external_ids = sorted(
        str(row["id"]) for row in prediction_rows if row.get("accountId") != "tyler"
    )
    development_ids_fingerprint = sha256_bytes(json.dumps(
        development_ids, separators=(",", ":"),
    ).encode("utf-8"))
    blind_manifest = {
        "version": 2,
        "status": "sealed-before-outcome-join",
        "evaluationVersion": EVALUATION_VERSION,
        "blindGenerationId": blind_generation_id,
        "modelFingerprint": fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "inputManifestFingerprint": input_manifest_fingerprint,
        "predictionManifestFingerprint": prediction_manifest_fingerprint,
        "sources": len(blind_entries),
        "outcomeFieldsPresent": False,
        "predictionInputsExcludeOutcomeFields": True,
        "developmentCohortIdsFingerprint": development_ids_fingerprint,
        "developmentCohortVideos": len(development_ids),
        "nonDevelopmentVideos": len(non_development_ids),
        "nonDevelopmentIdsDisjoint": not bool(
            set(development_ids) & set(non_development_ids)
        ),
        "accountExternalVideos": len(account_external_ids),
        "externalHoldoutVideos": len(account_external_ids),
        "externalHoldoutIdsDisjoint": not bool(
            set(development_ids) & set(account_external_ids)
        ),
        "trainingMembershipBoundary": (
            "The 208 source-level OOF artifact IDs define the development cohort. "
            "The frozen model files do not contain an independent training-ID ledger."
        ),
        "blindIsolationPrimaryPolicy": PRIMARY_ISOLATION_POLICY,
        "blindIsolationComputedBeforeOutcomeJoin": True,
        "blindIsolationAudit": isolation_audit,
        "blindIsolationPolicyAudits": isolation_policy_audits,
        "entries": blind_entries,
        "sealedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_json(blind_manifest_path, blind_manifest)

    # Only this phase receives the audience-retention outcomes.
    outcomes_by_id = {str(row["id"]): row for row in pooled_rows}
    joined_details = [
        attach_observed_retention(prediction, outcomes_by_id[str(prediction["videoId"])])
        for prediction in predictions
    ]
    for detail in joined_details:
        kind = str(detail.get("evaluationKind") or "")
        if kind == "saved-source-level-oof":
            role = "development-source-level-oof"
        elif kind.startswith("cross-account-"):
            primary = detail.get("blindIsolationPrimary") or {}
            if primary.get("eligible"):
                role = "strict-blind-primary"
            else:
                role = str(primary.get("status") or "excluded-unclassified")
            if role == "excluded-unclassified":
                raise RuntimeError(
                    f"sealed external blind role is unclassified: {detail.get('videoId')}"
                )
        else:
            role = "main-withheld-frozen-evaluation"
        detail["blindEvaluationRole"] = role
        detail["strictBlindEligible"] = role == "strict-blind-primary"

    summaries = []
    metric_records = []
    for detail in joined_details:
        summaries.append(compact_summary(detail))
        metric_records.append(metric_record(detail))

    kind_counts = Counter(str(row.get("evaluationKind") or "unknown") for row in summaries)
    outcome_fingerprint = sha256_bytes(json.dumps([{
        "videoId": str(row["id"]),
        "accountId": row.get("accountId"),
        "durationSeconds": row.get("duration_s"),
        "views": row.get("views"),
        "curve": row.get("curve"),
    } for row in pooled_rows], sort_keys=True, separators=(",", ":")).encode("utf-8"))
    generation_id = sha256_bytes(json.dumps({
        "evaluationVersion": EVALUATION_VERSION,
        "modelFingerprint": fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "blindGenerationId": blind_generation_id,
        "predictionManifestFingerprint": prediction_manifest_fingerprint,
        "outcomeFingerprint": outcome_fingerprint,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8"))[:20]
    for detail in joined_details:
        detail["evaluationGenerationId"] = generation_id
        write_gzip_json(detail_dir / f"{detail['videoId']}.json.gz", detail)
    for row in summaries:
        row["evaluationGenerationId"] = generation_id
        row["detail"] = (
            f"/api/shortsquant/promise-lab/opening-prediction/{row['videoId']}"
            f"?scope=all&generation={generation_id}"
        )
    evaluation = evaluation_bundle(metric_records, isolation_audit)
    summary = {
        "version": 1,
        "status": "complete" if not failures else "complete-with-errors",
        "scope": "preview" if filtered_run else "all",
        "evaluationVersion": EVALUATION_VERSION,
        "predictorVersion": models["retention"].get("predictorVersion"),
        "featureVersion": models["retention"].get("featureVersion"),
        "modelFingerprint": fingerprint,
        "savedOofArtifactFingerprint": oof_artifact_fingerprint,
        "outcomeFingerprint": outcome_fingerprint,
        "generationId": generation_id,
        "blindValidation": {
            "status": "sealed-before-outcome-join",
            "blindGenerationId": blind_generation_id,
            "sealedPredictionCount": len(blind_entries),
            "inputManifestFingerprint": input_manifest_fingerprint,
            "predictionManifestFingerprint": prediction_manifest_fingerprint,
            "outcomeManifestFingerprint": outcome_fingerprint,
            "outcomeFieldsPresentInBlindManifest": False,
            "predictionInputsExcludeOutcomeFields": True,
            "blindIsolationComputedBeforeOutcomeJoin": True,
            "blindIsolationPrimaryPolicy": PRIMARY_ISOLATION_POLICY,
            "developmentCohortIdsFingerprint": development_ids_fingerprint,
            "developmentCohortVideos": len(development_ids),
            "nonDevelopmentVideos": len(non_development_ids),
            "nonDevelopmentIdsDisjoint": not bool(
                set(development_ids) & set(non_development_ids)
            ),
            "accountExternalVideos": len(account_external_ids),
            "externalHoldoutVideos": len(account_external_ids),
            "externalHoldoutIdsDisjoint": not bool(
                set(development_ids) & set(account_external_ids)
            ),
            "joinOrder": [
                "strip outcome fields from inference inputs",
                "run or load frozen predictions",
                "compute and seal all predeclared content-isolation policies",
                "write and fingerprint prediction-only manifest",
                "open measured retention curves",
                "join by video ID and evaluate",
            ],
            **isolation_audit,
        },
        "selectedStage": {
            family: (model.get("headlineStage") or model.get("selectedStage"))
            for family, model in (models["retention"].get("families") or {}).items()
        },
        "sources": len(summaries),
        "expectedSources": len(pooled_rows),
        "accounts": accounts,
        "evaluationKindCounts": dict(sorted(kind_counts.items())),
        "rows": summaries,
        "evaluation": evaluation,
        "failures": failures,
        "validation": saved_summary.get("validation"),
        "riskSetBySecond": saved_summary.get("riskSetBySecond"),
        "support": models["retention"].get("support"),
        "evidenceBoundary": models["retention"].get("evidenceBoundary"),
        "provenance": {
            "modelRefit": False,
            "modelRecalibrated": False,
            "modelStageChanged": False,
            "outcomesJoinedAfterInference": True,
            "savedCohortPredictionsRemainSourceLevelOOF": True,
            "externalRowsUseFrozenFullFit": True,
            "blindPredictionManifestSealedBeforeOutcomeJoin": True,
            "blindIsolationComputedAndSealedBeforeOutcomeJoin": True,
            "strictBlindMetricsExcludeExactTrainingContentOverlap": True,
            "strictBlindMetricsExcludeNearTrainingContentOverlap": True,
            "strictBlindMetricsWeightExactExternalRepostsAsOneComponent": True,
            "strictBlindMetricsWeightNearExternalRepostsAsOneComponent": True,
        },
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_json(summary_path, summary)
    write_json(progress_path, {
        "version": 1,
        "status": summary["status"],
        "completed": len(summaries),
        "total": len(pooled_rows),
        "resumed": resumed,
        "failed": len(failures),
        "elapsedSeconds": time.time() - started,
        "modelFingerprint": fingerprint,
    })
    if args.upload:
        upload(summary, detail_dir, blind_manifest)
    print(json.dumps({
        "status": summary["status"],
        "sources": summary["sources"],
        "expected": summary["expectedSources"],
        "details": len(list(detail_dir.glob("*.json.gz"))),
        "evaluationVideos": summary["evaluation"]["allPooled"]["videos"],
        "summary": str(summary_path),
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
