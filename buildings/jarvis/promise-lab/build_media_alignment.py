#!/usr/bin/env python3
"""Build deterministic 20-second acoustic alignments for the Promise Lab corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from media_alignment import (
    MEDIA_ALIGNMENT_HORIZON_SECONDS,
    MEDIA_ALIGNMENT_VERSION,
    canonical_hook_words,
    canonical_json,
    ctc_align_canonical_words,
    file_sha256,
    media_duration_seconds,
    parse_whisper_tsv,
    project_canonical_hook_to_reference,
    sha256_json,
    source_timeline_audit,
    spoken_atoms,
    timing_reference_audit,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = HERE / ".cache"
ALIGNMENT_DIR = CACHE / "media-alignment"
SOURCE_DIR = CACHE / "media-alignment-sources"
SUMMARY_PATH = CACHE / "media-alignment.json"
CLIP_SECONDS = 20.0
SAMPLE_RATE = 16000
HOOK_ALIGNMENT_METHOD_VERSION = "canonical-hook-acoustic-alignment-v7"


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ),
        encoding="ascii",
    )
    os.replace(temporary, path)


def load_corpus() -> list[dict]:
    return json.loads((CACHE / "corpus.json").read_text(encoding="utf-8"))["rows"]


def analysis_payload(video_id: str) -> tuple[Path, dict]:
    path = ROOT / "video_data" / video_id / "analysis.json"
    if not path.exists():
        raise FileNotFoundError(f"missing canonical analysis for {video_id}: {path}")
    return path, json.loads(path.read_text(encoding="utf-8"))


def local_media(video_id: str) -> Path | None:
    candidates = (
        ROOT / "video_data" / video_id / "video.wav",
        ROOT / "video_data" / video_id / "video.mp4",
        ROOT / "CrackedVideoAnalyzer6" / "downloads" / f"{video_id}.mp4",
        ROOT / "buildings" / "jarvis" / "tribe-analysis" / "videos" / f"{video_id}.mp4",
    )
    return next((path for path in candidates if path.exists()), None)


def cached_public_media(video_id: str) -> Path | None:
    directory = SOURCE_DIR / video_id
    candidates = sorted(
        path for path in directory.glob(f"{video_id}.*")
        if path.suffix.lower() not in {".json", ".json3", ".part", ".ytdl", ".wav"}
    )
    return candidates[0] if candidates else None


def fetch_public_media(source: dict, refresh: bool = False) -> tuple[str, Path, str]:
    video_id = str(source["id"])
    local = local_media(video_id)
    if local is not None:
        return video_id, local, "businessworld-local-media"
    cached = None if refresh else cached_public_media(video_id)
    if cached is not None:
        return video_id, cached, "public-youtube-audio-cache"
    directory = SOURCE_DIR / video_id
    directory.mkdir(parents=True, exist_ok=True)
    if refresh:
        for path in directory.glob(f"{video_id}.*"):
            path.unlink(missing_ok=True)
    executable = shutil.which("yt-dlp")
    if not executable:
        raise RuntimeError("yt-dlp is required to backfill public source audio")
    url = str(source.get("url") or f"https://www.youtube.com/watch?v={video_id}")
    command = [
        executable, "--no-playlist", "--retries", "5", "--fragment-retries", "5",
        "-f", "bestaudio[ext=webm]/bestaudio",
        "-o", str(directory / f"{video_id}.%(ext)s"), url,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(
            f"yt-dlp failed for {video_id}: {(result.stderr or result.stdout)[-1200:]}"
        )
    cached = cached_public_media(video_id)
    if cached is None:
        raise RuntimeError(f"yt-dlp returned no source audio for {video_id}")
    return video_id, cached, "public-youtube-audio-cache"


def extract_alignment_wave(video_id: str, source: Path, source_hash: str) -> Path:
    directory = SOURCE_DIR / video_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"first-{CLIP_SECONDS:g}s-{source_hash[:16]}.wav"
    if path.exists():
        return path
    for stale in directory.glob("first-*.wav"):
        stale.unlink(missing_ok=True)
    temporary = path.with_suffix(".wav.tmp")
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-t", f"{CLIP_SECONDS:g}", "-vn", "-ac", "1",
        "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1",
        "-f", "wav", str(temporary),
    ]
    subprocess.run(command, check=True)
    os.replace(temporary, path)
    return path


def canonical_words(payload: dict) -> list[dict]:
    output = []
    for canonical_index, row in enumerate(
        ((payload.get("transcript") or {}).get("words") or [])
    ):
        try:
            timestamp = float(row.get("timestamp"))
        except (TypeError, ValueError):
            continue
        text = str(row.get("word") or "").strip()
        if text and np.isfinite(timestamp) and 0 <= timestamp < MEDIA_ALIGNMENT_HORIZON_SECONDS:
            output.append({
                "canonicalIndex": canonical_index,
                "word": text,
                "timestamp": timestamp,
            })
    if not output:
        raise ValueError("canonical transcript contains no words before 20 seconds")
    return output


def numeric_error(values: list[float]) -> dict:
    array = np.asarray(values, float)
    return {
        "count": int(len(array)),
        "meanAbsoluteSeconds": float(np.mean(np.abs(array))),
        "medianAbsoluteSeconds": float(np.median(np.abs(array))),
        "p95AbsoluteSeconds": float(np.quantile(np.abs(array), 0.95)),
        "maximumAbsoluteSeconds": float(np.max(np.abs(array))),
        "signedMeanSeconds": float(np.mean(array)),
    }


def hook_alignment_input_key(source: dict, source_hash: str, model_hash: str) -> str:
    return sha256_json({
        "methodVersion": HOOK_ALIGNMENT_METHOD_VERSION,
        "sourceSha256": source_hash,
        "canonicalHookText": str(source.get("hookText") or ""),
        "modelSha256": model_hash,
        "clipSeconds": CLIP_SECONDS,
        "sampleRate": SAMPLE_RATE,
    })


def build_hook_alignment(source: dict, input_key: str,
                         reference_words: list[dict],
                         opening_confidence_band: str) -> dict:
    canonical = canonical_hook_words(
        str(source.get("hookText") or ""), source.get("hookEndSec"),
    )
    canonical_text = str(source.get("hookText") or "")
    legacy_end = float(source.get("hookEndSec") or 0)
    canonical_stream = "".join(
        "".join(spoken_atoms(row["word"])) for row in canonical
    )
    reference_stream = "".join(
        "".join(spoken_atoms(row["w"])) for row in reference_words
    )
    projection_is_prefix = bool(
        canonical_stream and reference_stream.startswith(canonical_stream)
    )
    words, projection_audit = project_canonical_hook_to_reference(
        canonical, reference_words,
    )
    aligned = {
        "projectionAudit": projection_audit,
        "alignmentStrategy": (
            "normalized-prefix projection onto opening CTC intervals"
            if projection_is_prefix else
            "edit-distance projection onto opening CTC intervals"
        ),
    }
    review_count = sum(word.get("status") == "review" for word in words)
    review_fraction = review_count / max(1, len(words))
    character_error = float(1.0 - np.mean([
        float(word.get("alignmentCharacterCoverage") or 0) for word in words
    ]))
    lexical_confidence = (
        "high" if review_fraction <= 0.2 and character_error <= 0.2
        else "moderate" if review_fraction <= 0.35 and character_error <= 0.35
        else "low"
    )
    confidence_order = {"high": 0, "moderate": 1, "low": 2}
    confidence = max(
        (lexical_confidence, str(opening_confidence_band)),
        key=lambda value: confidence_order.get(value, 2),
    )
    aligned_end = max(float(word["t"] + word["d"]) for word in words)
    return {
        **aligned,
        "methodVersion": HOOK_ALIGNMENT_METHOD_VERSION,
        "inputKey": input_key,
        "canonicalText": canonical_text,
        "words": words,
        "confidenceBand": confidence,
        "lexicalConfidenceBand": lexical_confidence,
        "openingAlignmentConfidenceBand": opening_confidence_band,
        "reviewWordFraction": review_fraction,
        "reviewWordCount": review_count,
        "alignmentCharacterErrorRate": character_error,
        "alignedEndSeconds": aligned_end,
        "legacyHookEndSeconds": legacy_end,
        "legacyEndpointUsedForPlacement": False,
        "legacyEndpointUsedAsAuditOnly": True,
        "hookEndCorrectionSeconds": aligned_end - legacy_end,
        "outcomesUsed": False,
        "semanticLabelsUsed": False,
        "legacyTimestampProposalUsedForPlacement": False,
        "claimBoundary": (
            "Canonical hook words use the unchanged opening CTC intervals. Normalized prefixes "
            "map directly; transcript variants use an outcome-blind character edit path whose "
            "endpoint is restricted to an acoustic opening-word boundary. Within-word boundaries "
            "are explicit estimates, not hand-labeled ground truth."
        ),
    }


def build_one(source: dict, source_path: Path, source_origin: str,
              model, labels: tuple[str, ...], model_hash: str,
              rebuild: bool = False) -> dict:
    video_id = str(source["id"])
    output_path = ALIGNMENT_DIR / f"{video_id}.json"
    analysis_path, analysis = analysis_payload(video_id)
    canonical = canonical_words(analysis)
    source_hash = file_sha256(source_path)
    timeline_audit = source_timeline_audit(source_path)
    if not timeline_audit["withinAlignmentTolerance"]:
        raise RuntimeError(
            f"audio and source timeline do not share time zero for {video_id}: "
            f"{timeline_audit['audioMinusReferenceStartSeconds']:.6f}s"
        )
    primary_input_key = sha256_json({
        "methodVersion": MEDIA_ALIGNMENT_VERSION,
        "sourceSha256": source_hash,
        "canonicalWords": canonical,
        "modelSha256": model_hash,
        "clipSeconds": CLIP_SECONDS,
        "sampleRate": SAMPLE_RATE,
    })
    hook_input_key = hook_alignment_input_key(source, source_hash, model_hash)
    input_key = sha256_json({
        "primaryInputKey": primary_input_key,
        "hookAlignmentInputKey": hook_input_key,
    })
    if output_path.exists() and not rebuild:
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        existing_primary_key = existing.get("primaryInputKey") or existing.get("inputKey")
        if existing_primary_key == primary_input_key:
            changed = False
            if existing.get("source", {}).get("timelineAudit") != timeline_audit:
                existing.setdefault("source", {})["timelineAudit"] = timeline_audit
                changed = True
            if (existing.get("hookAlignment") or {}).get("inputKey") != hook_input_key:
                existing["hookAlignment"] = build_hook_alignment(
                    source, hook_input_key,
                    existing["words"], existing["alignment"]["confidenceBand"],
                )
                changed = True
            if existing.get("primaryInputKey") != primary_input_key:
                existing["primaryInputKey"] = primary_input_key
                changed = True
            if existing.get("inputKey") != input_key:
                existing["inputKey"] = input_key
                changed = True
            if changed:
                existing.pop("outputSha256", None)
                existing["outputSha256"] = sha256_json(existing)
                atomic_json(output_path, existing)
            return existing

    wave_path = extract_alignment_wave(video_id, source_path, source_hash)
    aligned = ctc_align_canonical_words(wave_path, canonical, model, labels)
    words = aligned.pop("words")
    if len(words) != len(canonical):
        raise RuntimeError(
            f"CTC alignment lost canonical words for {video_id}: "
            f"{len(words)} != {len(canonical)}"
        )
    quantized_errors = [
        float(word["t"]) - float(word["sourceTimestamp"])
        for word in words
    ]
    reference_audits = {}
    tsv_path = ROOT / "video_data" / video_id / "video.tsv"
    if tsv_path.exists():
        reference_audits["localWhisperTsv"] = {
            **timing_reference_audit(words, parse_whisper_tsv(tsv_path)),
            "sourcePath": str(tsv_path.relative_to(ROOT)),
            "role": "independent model agreement; not ground truth",
        }
    hook_path = CACHE / "hook-timing" / f"{video_id}.json"
    if hook_path.exists():
        hook = json.loads(hook_path.read_text(encoding="utf-8"))
        reference_audits["existingHookTiming"] = {
            **timing_reference_audit(words, hook.get("words") or [], 12.0),
            "sourcePath": str(hook_path.relative_to(HERE)),
            "role": "backward-compatibility audit; not ground truth",
        }

    review_fraction = aligned["reviewWordCount"] / max(1, len(words))
    character_error = float(aligned["freeDecodeCharacterErrorRate"])
    confidence = (
        "high" if review_fraction <= 0.2 and character_error <= 0.2
        else "moderate" if review_fraction <= 0.35 and character_error <= 0.35
        else "low"
    )
    hook_alignment = build_hook_alignment(
        source, hook_input_key, words, confidence,
    )
    media_duration = media_duration_seconds(source_path)
    record = {
        "version": 1,
        "methodVersion": MEDIA_ALIGNMENT_VERSION,
        "videoId": video_id,
        "builtAt": time.time(),
        "inputKey": input_key,
        "primaryInputKey": primary_input_key,
        "source": {
            "origin": source_origin,
            "path": str(source_path.relative_to(ROOT)) if source_path.is_relative_to(ROOT) else str(source_path),
            "mediaDurationSeconds": media_duration,
            "analyticsDurationSeconds": float(source.get("duration_s") or 0),
            "durationDeltaSeconds": media_duration - float(source.get("duration_s") or 0),
            "timelineAudit": timeline_audit,
            "canonicalAnalysisPath": str(analysis_path.relative_to(ROOT)),
        },
        "alignment": {
            **aligned,
            "algorithm": "canonical CTC forced alignment on local PCM",
            "modelBundle": "torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H",
            "clipSeconds": CLIP_SECONDS,
            "confidenceBand": confidence,
            "reviewWordFraction": review_fraction,
            "quantizedStartComparison": numeric_error(quantized_errors),
            "referenceAudits": reference_audits,
            "outcomesUsed": False,
            "semanticLabelsUsed": False,
            "canonicalWordsChanged": False,
        },
        "timingContract": {
            "clock": "source media PCM sample 0",
            "sampleRate": SAMPLE_RATE,
            "mediaAligned": True,
            "timingExact": False,
            "claimBoundary": (
                "Word boundaries are deterministic acoustic model estimates on the source-media "
                "clock, not hand-labeled ground truth. Retention values remain interpolations "
                "of the native analytics curve."
            ),
        },
        "hookAlignment": hook_alignment,
        "words": words,
        "hashes": {
            "sourceSha256": source_hash,
            "alignmentWaveSha256": file_sha256(wave_path),
            "canonicalWordsSha256": hashlib.sha256(canonical_json(canonical)).hexdigest(),
            "modelSha256": model_hash,
        },
    }
    record["outputSha256"] = sha256_json(record)
    atomic_json(output_path, record)
    return record


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--download-workers", type=int, default=4)
    parser.add_argument("--refresh-downloads", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    corpus = load_corpus()
    if args.video_id:
        corpus = [row for row in corpus if str(row["id"]) == str(args.video_id)]
        if not corpus:
            raise SystemExit(f"video is not in the Promise Lab corpus: {args.video_id}")
    if args.limit:
        corpus = corpus[:args.limit]

    print(f"Resolving source media for {len(corpus)} videos...", flush=True)
    sources = {}
    failures = {}
    with ThreadPoolExecutor(max_workers=max(1, args.download_workers)) as pool:
        jobs = {
            pool.submit(fetch_public_media, row, args.refresh_downloads): row
            for row in corpus
        }
        for job in as_completed(jobs):
            row = jobs[job]
            video_id = str(row["id"])
            try:
                _, path, origin = job.result()
                sources[video_id] = (path, origin)
            except Exception as error:
                failures[video_id] = str(error)
                print(f"source error {video_id}: {error}", flush=True)
    if failures:
        atomic_json(SUMMARY_PATH, {
            "status": "source-failure", "failures": failures,
            "sourcesResolved": len(sources), "sourcesRequested": len(corpus),
        })
        raise RuntimeError(f"failed to resolve {len(failures)} source videos")

    import torch
    import torchaudio

    os.environ["PYTHONHASHSEED"] = "0"
    torch.manual_seed(0)
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    labels = tuple(bundle.get_labels())
    model = bundle.get_model().eval()
    checkpoint = Path(torch.hub.get_dir()) / "checkpoints" / Path(bundle._path).name
    model_hash = file_sha256(checkpoint)

    records = []
    started = time.time()
    for index, source in enumerate(corpus, 1):
        video_id = str(source["id"])
        path, origin = sources[video_id]
        record = build_one(
            source, path, origin, model, labels, model_hash, rebuild=args.rebuild,
        )
        records.append(record)
        alignment = record["alignment"]
        print(
            f"[{index}/{len(corpus)}] {video_id}: {len(record['words'])} words, "
            f"CER {alignment['freeDecodeCharacterErrorRate']:.3f}, "
            f"review {alignment['reviewWordFraction']:.1%}, "
            f"{alignment['confidenceBand']}",
            flush=True,
        )

    bands = Counter(record["alignment"]["confidenceBand"] for record in records)
    hook_bands = Counter(
        record["hookAlignment"]["confidenceBand"] for record in records
    )
    hook_lexical_bands = Counter(
        record["hookAlignment"]["lexicalConfidenceBand"] for record in records
    )
    origins = Counter(record["source"]["origin"] for record in records)
    summary = {
        "version": 1,
        "methodVersion": MEDIA_ALIGNMENT_VERSION,
        "status": "complete",
        "builtAt": time.time(),
        "elapsedSeconds": time.time() - started,
        "sourceVideos": len(records),
        "mediaAlignedVideos": sum(record["timingContract"]["mediaAligned"] for record in records),
        "canonicalWords": sum(len(record["words"]) for record in records),
        "canonicalHookAlignedVideos": sum(bool(record.get("hookAlignment")) for record in records),
        "canonicalHookWords": sum(
            len(record["hookAlignment"]["words"]) for record in records
        ),
        "canonicalHookAlignmentStrategies": dict(Counter(
            record["hookAlignment"]["alignmentStrategy"] for record in records
        )),
        "canonicalHookEstimatedBoundaryWords": sum(
            not bool(word.get("boundaryAcoustic"))
            for record in records for word in record["hookAlignment"]["words"]
        ),
        "canonicalHookConfidenceBands": dict(hook_bands),
        "canonicalHookLexicalConfidenceBands": dict(hook_lexical_bands),
        "canonicalHookMeanAlignmentCharacterErrorRate": float(np.mean([
            record["hookAlignment"]["alignmentCharacterErrorRate"]
            for record in records
        ])),
        "canonicalHookMeanReviewWordFraction": float(np.mean([
            record["hookAlignment"]["reviewWordFraction"] for record in records
        ])),
        "canonicalHookEndCorrectionSeconds": {
            "medianAbsolute": float(np.median(np.abs([
                record["hookAlignment"]["hookEndCorrectionSeconds"]
                for record in records
            ]))),
            "p95Absolute": float(np.quantile(np.abs([
                record["hookAlignment"]["hookEndCorrectionSeconds"]
                for record in records
            ]), 0.95)),
            "maximumAbsolute": float(np.max(np.abs([
                record["hookAlignment"]["hookEndCorrectionSeconds"]
                for record in records
            ]))),
        },
        "confidenceBands": dict(bands),
        "sourceOrigins": dict(origins),
        "meanCharacterErrorRate": float(np.mean([
            record["alignment"]["freeDecodeCharacterErrorRate"] for record in records
        ])),
        "meanReviewWordFraction": float(np.mean([
            record["alignment"]["reviewWordFraction"] for record in records
        ])),
        "timingResolutionSecondsMedian": float(np.median([
            record["alignment"]["secondsPerCtcFrame"] for record in records
        ])),
        "maximumAbsoluteAudioClockOffsetSeconds": float(max(
            abs(record["source"]["timelineAudit"]["audioMinusReferenceStartSeconds"])
            for record in records
        )),
        "outcomesUsed": False,
        "claimBoundary": (
            "All boundaries are deterministic CTC estimates on source-media PCM. They are "
            "validated against independent caption/Whisper clocks where available, but are "
            "not hand-labeled exact timestamps."
        ),
        "rows": [{
            "videoId": record["videoId"],
            "sourceOrigin": record["source"]["origin"],
            "mediaDurationSeconds": record["source"]["mediaDurationSeconds"],
            "analyticsDurationSeconds": record["source"]["analyticsDurationSeconds"],
            "confidenceBand": record["alignment"]["confidenceBand"],
            "characterErrorRate": record["alignment"]["freeDecodeCharacterErrorRate"],
            "reviewWordFraction": record["alignment"]["reviewWordFraction"],
            "wordCount": len(record["words"]),
            "canonicalHookAlignmentStrategy": record["hookAlignment"]["alignmentStrategy"],
            "canonicalHookConfidenceBand": record["hookAlignment"]["confidenceBand"],
            "canonicalHookLexicalConfidenceBand": record["hookAlignment"][
                "lexicalConfidenceBand"
            ],
            "canonicalHookOpeningAlignmentConfidenceBand": record[
                "hookAlignment"
            ]["openingAlignmentConfidenceBand"],
            "canonicalHookAlignmentCharacterErrorRate": record["hookAlignment"][
                "alignmentCharacterErrorRate"
            ],
            "canonicalHookReviewWordFraction": record["hookAlignment"][
                "reviewWordFraction"
            ],
            "canonicalHookWordCount": len(record["hookAlignment"]["words"]),
            "canonicalHookEstimatedBoundaryWords": sum(
                not bool(word.get("boundaryAcoustic"))
                for word in record["hookAlignment"]["words"]
            ),
            "canonicalHookEndSeconds": record["hookAlignment"]["alignedEndSeconds"],
            "legacyHookEndSeconds": record["hookAlignment"]["legacyHookEndSeconds"],
            "audioClockOffsetSeconds": record["source"]["timelineAudit"][
                "audioMinusReferenceStartSeconds"
            ],
        } for record in records],
    }
    atomic_json(SUMMARY_PATH, summary)
    print(json.dumps({key: summary[key] for key in (
        "status", "sourceVideos", "canonicalWords", "confidenceBands",
        "canonicalHookAlignedVideos", "canonicalHookWords",
        "canonicalHookAlignmentStrategies", "canonicalHookConfidenceBands",
        "sourceOrigins", "meanCharacterErrorRate", "meanReviewWordFraction",
        "timingResolutionSecondsMedian", "maximumAbsoluteAudioClockOffsetSeconds",
        "elapsedSeconds",
    )}, indent=2), flush=True)


if __name__ == "__main__":
    main()
