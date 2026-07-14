"""Shared media-clock alignment primitives for Promise Lab.

The semantic corpus intentionally keeps the canonical transcript already used by
the embedding pipeline. This module forces that unchanged opening transcript
onto source-media acoustic CTC frames, then projects every canonical hook onto
the resulting word intervals with deterministic ordered lexical alignment.
Independent Whisper/caption clocks are agreement audits only. Outcomes, legacy
hook endpoints, and semantic labels never participate in timestamp placement.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import subprocess
import unicodedata
import wave
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import numpy as np

from sequence import normalize_source, tokenize


MEDIA_ALIGNMENT_VERSION = "promise-media-clock-v2"
MEDIA_ALIGNMENT_HORIZON_SECONDS = 20.0
SOURCE_LOOKAHEAD_SECONDS = 2.0
MINIMUM_WORD_DURATION_SECONDS = 0.001
MAXIMUM_SOURCE_CLOCK_OFFSET_SECONDS = 0.03

ONES = {
    0: "ZERO", 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR",
    5: "FIVE", 6: "SIX", 7: "SEVEN", 8: "EIGHT", 9: "NINE",
    10: "TEN", 11: "ELEVEN", 12: "TWELVE", 13: "THIRTEEN",
    14: "FOURTEEN", 15: "FIFTEEN", 16: "SIXTEEN", 17: "SEVENTEEN",
    18: "EIGHTEEN", 19: "NINETEEN",
}
TENS = {
    20: "TWENTY", 30: "THIRTY", 40: "FORTY", 50: "FIFTY",
    60: "SIXTY", 70: "SEVENTY", 80: "EIGHTY", 90: "NINETY",
}
UNIT_ALIASES = {
    "MM": ["MILLIMETER"],
    "MMS": ["MILLIMETERS"],
}


def normalized_word(value: Any) -> str:
    return re.sub(
        r"[^a-z0-9]+", "", str(value or "").casefold().replace("’", "'")
    )


def canonical_hook_words(text: str, approximate_end_seconds: float | None = None) -> list[dict]:
    """Preserve hook wording while creating an outcome-blind CTC target.

    The approximate timestamps are audit references only. Torchaudio forced
    alignment receives the ordered character target and source-media emissions;
    it does not use these timestamp proposals to place words.
    """
    surfaces = [
        match.group(0) for match in re.finditer(r"\S+", str(text or ""))
        if spoken_atoms(match.group(0))
    ]
    if not surfaces:
        raise ValueError("canonical hook text has no CTC-compatible words")
    end = float(approximate_end_seconds or 0)
    step = end / len(surfaces) if np.isfinite(end) and end > 0 else 0.0
    return [{
        "canonicalIndex": index,
        "word": surface,
        "timestamp": index * step,
    } for index, surface in enumerate(surfaces)]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def integer_words(value: int) -> list[str]:
    if value < 20:
        return [ONES[value]]
    if value < 100:
        tens = value // 10 * 10
        return [TENS[tens]] + ([] if value == tens else [ONES[value - tens]])
    if value < 1000:
        remainder = value % 100
        return [ONES[value // 100], "HUNDRED"] + (
            [] if remainder == 0 else integer_words(remainder)
        )
    if value < 1_000_000:
        remainder = value % 1000
        return integer_words(value // 1000) + ["THOUSAND"] + (
            [] if remainder == 0 else integer_words(remainder)
        )
    if value < 1_000_000_000:
        remainder = value % 1_000_000
        return integer_words(value // 1_000_000) + ["MILLION"] + (
            [] if remainder == 0 else integer_words(remainder)
        )
    return [ONES[int(digit)] for digit in str(value)]


def spoken_atoms(surface: str) -> list[str]:
    value = unicodedata.normalize("NFKC", str(surface)).replace("\u2019", "'")
    value = re.sub(r"[^A-Z0-9']+", "", value.upper())
    if not value:
        return []
    if value.isdigit():
        return integer_words(int(value))
    if value in UNIT_ALIASES:
        return UNIT_ALIASES[value]
    value = re.sub(r"^'+|'+$", "", value)
    return [value] if value else []


def _edit_alignment(source: str, observed: str) -> tuple[int, set[int]]:
    """Unit-cost global edit alignment with deterministic exact tie breaks."""
    m, n = len(source), len(observed)
    costs = np.empty((m + 1, n + 1), dtype=np.int32)
    costs[:, 0] = np.arange(m + 1)
    costs[0, :] = np.arange(n + 1)
    for left in range(1, m + 1):
        for right in range(1, n + 1):
            substitution = costs[left - 1, right - 1] + (
                source[left - 1] != observed[right - 1]
            )
            costs[left, right] = min(
                substitution,
                costs[left - 1, right] + 1,
                costs[left, right - 1] + 1,
            )
    matched = set()
    left, right = m, n
    while left or right:
        if (
            left and right and source[left - 1] == observed[right - 1]
            and costs[left, right] == costs[left - 1, right - 1]
        ):
            matched.add(left - 1)
            left -= 1
            right -= 1
        elif (
            left and right
            and costs[left, right] == costs[left - 1, right - 1] + 1
        ):
            left -= 1
            right -= 1
        elif left and costs[left, right] == costs[left - 1, right] + 1:
            left -= 1
        else:
            right -= 1
    return int(costs[m, n]), matched


def read_pcm16_wave(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise ValueError(f"alignment audio must be mono PCM16: {path}")
        rate = int(handle.getframerate())
        samples = np.frombuffer(
            handle.readframes(handle.getnframes()), dtype="<i2",
        ).astype(np.float32) / 32768.0
    return samples, rate


def ctc_align_canonical_words(audio_path: Path, canonical_words: list[dict],
                              model, labels: tuple[str, ...],
                              maximum_audio_seconds: float | None = None) -> dict:
    """Force the canonical transcript onto local acoustic CTC frames.

    ``model`` is injected by the offline builder so importing serving code never
    imports Torch or TorchAudio.
    """
    import torch
    import torchaudio

    samples, sample_rate = read_pcm16_wave(audio_path)
    if sample_rate != 16000:
        raise ValueError(f"alignment audio must be 16 kHz: {audio_path}")
    if maximum_audio_seconds is not None:
        sample_limit = int(math.ceil(float(maximum_audio_seconds) * sample_rate))
        samples = samples[:max(1, sample_limit)]
    label_to_id = {label: index for index, label in enumerate(labels)}
    target_symbols = []
    target_owners = []
    canonical_stream = []
    character_owners = []
    prepared = []
    for word_index, source in enumerate(canonical_words):
        surface = normalize_source(source.get("word") or source.get("w") or "")
        atoms = spoken_atoms(surface)
        if not atoms:
            continue
        prepared_index = len(prepared)
        prepared.append({
            "canonicalIndex": int(source.get("canonicalIndex", word_index)),
            "surface": surface,
            "sourceTimestamp": float(source.get("timestamp", source.get("t", 0))),
            "spokenAtoms": atoms,
        })
        if prepared_index:
            target_symbols.append("|")
            target_owners.append(None)
            canonical_stream.append("|")
            character_owners.append(None)
        for atom_index, atom in enumerate(atoms):
            if atom_index:
                target_symbols.append("|")
                target_owners.append(prepared_index)
                canonical_stream.append("|")
                character_owners.append(prepared_index)
            for symbol in atom:
                if symbol not in label_to_id:
                    continue
                target_symbols.append(symbol)
                target_owners.append(prepared_index)
                canonical_stream.append(symbol)
                character_owners.append(prepared_index)
    if not prepared or not target_symbols:
        raise ValueError("canonical transcript has no CTC-compatible words")

    waveform = torch.from_numpy(samples).unsqueeze(0)
    with torch.inference_mode():
        emission, _ = model(waveform)
        log_probs = torch.log_softmax(emission, dim=-1).cpu()
    targets = torch.tensor(
        [[label_to_id[symbol] for symbol in target_symbols]], dtype=torch.int32,
    )
    aligned, path_scores = torchaudio.functional.forced_align(
        log_probs, targets, blank=label_to_id["-"],
    )
    spans = torchaudio.functional.merge_tokens(
        aligned[0], path_scores[0], blank=label_to_id["-"],
    )
    if len(spans) != len(target_symbols):
        raise RuntimeError(
            f"CTC span count {len(spans)} differs from target {len(target_symbols)}"
        )

    def greedy_stream_for(values) -> str:
        symbols = []
        previous = None
        for token_id in values:
            if token_id != previous and token_id != label_to_id["-"]:
                symbols.append(labels[token_id])
            previous = token_id
        return "".join(symbols).strip("|")

    greedy_ids = torch.argmax(log_probs[0], dim=-1).tolist()
    full_greedy_stream = greedy_stream_for(greedy_ids)
    aligned_end_frame = int(spans[-1].end)
    greedy_stream = greedy_stream_for(greedy_ids[:aligned_end_frame])
    canonical_text = "".join(canonical_stream)
    edit_distance, matched_positions = _edit_alignment(canonical_text, greedy_stream)
    full_edit_distance, _ = _edit_alignment(canonical_text, full_greedy_stream)

    matched_by_word = [0] * len(prepared)
    characters_by_word = [0] * len(prepared)
    for position, owner in enumerate(character_owners):
        if owner is not None and canonical_text[position] != "|":
            characters_by_word[owner] += 1
            matched_by_word[owner] += int(position in matched_positions)
    spans_by_word = [[] for _ in prepared]
    for target_index, (span, owner) in enumerate(zip(spans, target_owners)):
        if owner is not None and target_symbols[target_index] != "|":
            spans_by_word[owner].append(span)

    seconds_per_frame = (len(samples) / sample_rate) / log_probs.shape[1]
    words = []
    for index, (source, word_spans) in enumerate(zip(prepared, spans_by_word)):
        if not word_spans:
            raise RuntimeError(f"canonical word has no acoustic characters: {source}")
        start = float(word_spans[0].start * seconds_per_frame)
        end = float(word_spans[-1].end * seconds_per_frame)
        acoustic = float(math.exp(np.mean([span.score for span in word_spans])))
        lexical = matched_by_word[index] / max(1, characters_by_word[index])
        confidence = float(math.sqrt(max(0.0, acoustic * lexical)))
        words.append({
            "w": source["surface"],
            "t": start,
            "d": max(MINIMUM_WORD_DURATION_SECONDS, end - start),
            "canonicalIndex": source["canonicalIndex"],
            "sourceTimestamp": source["sourceTimestamp"],
            "spokenAtoms": source["spokenAtoms"],
            "acousticPosteriorGeometricMean": acoustic,
            "freeDecodeCharacterCoverage": float(lexical),
            "confidenceScore": confidence,
            "status": "supported" if lexical >= 0.8 else "review",
            "source": "local-wav2vec2-ctc-forced-alignment",
        })
    return {
        "words": validate_timed_words(words),
        "audioSamples": len(samples),
        "sampleRate": sample_rate,
        "emissionFrames": int(log_probs.shape[1]),
        "secondsPerCtcFrame": float(seconds_per_frame),
        "canonicalTargetCharacterCount": len(target_symbols),
        "freeDecodeText": greedy_stream.replace("|", " "),
        "freeDecodeCharacterEditDistance": edit_distance,
        "freeDecodeCharacterErrorRate": edit_distance / max(1, len(canonical_text)),
        "fullClipFreeDecodeText": full_greedy_stream.replace("|", " "),
        "fullClipFreeDecodeCharacterEditDistance": full_edit_distance,
        "fullClipFreeDecodeCharacterErrorRate": (
            full_edit_distance / max(1, len(canonical_text))
        ),
        "alignedTargetEndFrame": aligned_end_frame,
        "reviewWordCount": sum(row["status"] == "review" for row in words),
        "meanConfidenceScore": float(np.mean([row["confidenceScore"] for row in words])),
    }


def media_duration_seconds(path: Path) -> float:
    value = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    duration = float(value)
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError(f"invalid media duration for {path}: {value!r}")
    return duration


def source_timeline_audit(path: Path) -> dict:
    """Verify where decoded audio sample zero sits on the source timeline."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=start_time:stream=codec_type,start_time", "-of", "json",
            str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    payload = json.loads(result.stdout)
    format_start = float((payload.get("format") or {}).get("start_time") or 0.0)
    streams = payload.get("streams") or []
    audio = [row for row in streams if row.get("codec_type") == "audio"]
    video = [row for row in streams if row.get("codec_type") == "video"]
    if not audio:
        raise ValueError(f"source media has no audio stream: {path}")
    audio_start = float(audio[0].get("start_time") or 0.0)
    video_start = float(video[0].get("start_time") or 0.0) if video else None
    reference_start = video_start if video_start is not None else format_start
    offset = audio_start - reference_start
    return {
        "formatStartSeconds": format_start,
        "audioStreamStartSeconds": audio_start,
        "videoStreamStartSeconds": video_start,
        "referenceClock": "video stream" if video_start is not None else "container format",
        "audioMinusReferenceStartSeconds": offset,
        "audioStreamCount": len(audio),
        "videoStreamCount": len(video),
        "withinAlignmentTolerance": bool(
            abs(offset) <= MAXIMUM_SOURCE_CLOCK_OFFSET_SECONDS
        ),
        "maximumAllowedOffsetSeconds": MAXIMUM_SOURCE_CLOCK_OFFSET_SECONDS,
        "claimBoundary": (
            "CTC time zero is decoded audio sample zero. The measured audio/reference stream "
            "start delta must remain within the declared tolerance before retention and acoustic "
            "windows share one clock."
        ),
    }


def parse_whisper_tsv(path: Path) -> list[dict]:
    """Read the full local Whisper word table on its source-media clock."""
    output = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for source_index, row in enumerate(csv.DictReader(handle, delimiter="\t")):
            text = normalize_source(row.get("text") or row.get("word") or "")
            try:
                start = float(row.get("start"))
                duration = float(row.get("duration"))
            except (TypeError, ValueError):
                continue
            if (
                not text or not np.isfinite(start + duration)
                or start < 0 or duration <= 0
            ):
                continue
            output.append({
                "w": text,
                "t": start,
                "d": duration,
                "sourceIndex": source_index,
                "source": "local-whisper-tsv",
            })
    return validate_timed_words(output)


def parse_youtube_json3(path: Path) -> list[dict]:
    """Read YouTube ASR word starts and derive bounded, non-overlapping ends."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    provisional = []
    for event_index, event in enumerate(payload.get("events") or []):
        event_start = float(event.get("tStartMs") or 0) / 1000.0
        event_end = event_start + float(event.get("dDurationMs") or 0) / 1000.0
        for segment_index, segment in enumerate(event.get("segs") or []):
            text = normalize_source(segment.get("utf8") or "")
            if not text or not normalized_word(text):
                continue
            start = event_start + float(segment.get("tOffsetMs") or 0) / 1000.0
            provisional.append({
                "w": text,
                "t": start,
                "eventEnd": event_end,
                "sourceIndex": len(provisional),
                "eventIndex": event_index,
                "segmentIndex": segment_index,
                "asrConfidence": segment.get("acAsrConf"),
                "source": "youtube-auto-captions-json3",
            })
    provisional.sort(key=lambda row: (float(row["t"]), int(row["sourceIndex"])))
    positive_deltas = [
        float(right["t"] - left["t"])
        for left, right in zip(provisional, provisional[1:])
        if float(right["t"] - left["t"]) > 0
    ]
    fallback = float(np.median(positive_deltas)) if positive_deltas else 0.24
    output = []
    for index, row in enumerate(provisional):
        start = float(row["t"])
        next_start = (
            float(provisional[index + 1]["t"])
            if index + 1 < len(provisional) else float("inf")
        )
        event_end = float(row["eventEnd"])
        candidates = [value for value in (next_start, event_end) if value > start]
        end = min(candidates) if candidates else start + fallback
        if end - start > 1.5:
            end = start + min(fallback, 0.6)
        output.append({
            key: value for key, value in row.items() if key != "eventEnd"
        } | {"d": max(MINIMUM_WORD_DURATION_SECONDS, end - start)})
    return validate_timed_words(output)


def validate_timed_words(words: list[dict]) -> list[dict]:
    if not words:
        raise ValueError("media timing source contains no lexical words")
    cleaned = []
    for source_index, row in enumerate(words):
        text = normalize_source(row.get("w") or row.get("word") or "")
        try:
            start = float(row.get("t", row.get("start")))
            duration = float(row.get("d", row.get("duration")))
        except (TypeError, ValueError):
            continue
        if (
            not text or not normalized_word(text)
            or not np.isfinite(start + duration) or start < 0 or duration <= 0
        ):
            continue
        cleaned.append({
            **row,
            "w": text,
            "t": start,
            "d": duration,
            "sourceIndex": int(row.get("sourceIndex", source_index)),
        })
    if not cleaned:
        raise ValueError("media timing source contains no valid word intervals")
    if any(
        float(left["t"]) > float(right["t"]) + 1e-9
        for left, right in zip(cleaned, cleaned[1:])
    ):
        raise ValueError("media timing word starts are not monotonic")
    for index, row in enumerate(cleaned[:-1]):
        next_start = float(cleaned[index + 1]["t"])
        available = next_start - float(row["t"])
        if available <= 0:
            raise ValueError("media timing word intervals do not have positive ordered support")
        # An estimated canonical boundary can divide one short acoustic word
        # more finely than the display-duration floor. Preserve the projected
        # boundary and clamp to the next start; inflating it would overlap the
        # following token and falsely move text onto a later retention sample.
        row["d"] = min(float(row["d"]), available)
    return cleaned


def load_media_alignment(video_id: str, cache_dir: Path) -> dict:
    path = cache_dir / "media-alignment" / f"{video_id}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"missing media alignment for {video_id}; run build_media_alignment.py"
        )
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("methodVersion") != MEDIA_ALIGNMENT_VERSION:
        raise ValueError(
            f"stale media alignment for {video_id}: {payload.get('methodVersion')}"
        )
    payload["words"] = validate_timed_words(payload.get("words") or [])
    return payload


def apply_media_durations(corpus_rows: list[dict], cache_dir: Path) -> list[dict]:
    """Return corpus rows whose retention clock uses actual source duration."""
    output = []
    for source in corpus_rows:
        video_id = str(source["id"])
        alignment = load_media_alignment(video_id, cache_dir)
        analytics_duration = float(source.get("duration_s") or 0)
        media_duration = float(alignment["source"]["mediaDurationSeconds"])
        output.append({
            **source,
            "analytics_duration_s": analytics_duration,
            "duration_s": media_duration,
            "media_duration_s": media_duration,
            "duration_clock": "source-media-duration",
            "duration_delta_s": media_duration - analytics_duration,
        })
    return output


def _word_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    return float(SequenceMatcher(None, left, right, autojunk=False).ratio())


def _ordered_word_alignment(canonical: list[dict], timed: list[dict]) -> dict[int, dict]:
    """Needleman-Wunsch alignment using text and the pre-existing source clock."""
    m, n = len(canonical), len(timed)
    gap = 0.68
    costs = np.full((m + 1, n + 1), np.inf, np.float64)
    moves = np.zeros((m + 1, n + 1), np.int8)
    costs[:, 0] = np.arange(m + 1, dtype=float) * gap
    costs[0, :] = np.arange(n + 1, dtype=float) * gap
    moves[1:, 0] = 1
    moves[0, 1:] = 2
    for left in range(1, m + 1):
        canonical_atom = normalized_word(canonical[left - 1]["text"])
        canonical_start = float(canonical[left - 1]["sourceStartTimestampSeconds"])
        for right in range(1, n + 1):
            timed_atom = normalized_word(timed[right - 1]["w"])
            similarity = _word_similarity(canonical_atom, timed_atom)
            time_delta = abs(canonical_start - float(timed[right - 1]["t"]))
            substitution = (
                costs[left - 1, right - 1]
                + 2.0 * (1.0 - similarity)
                + 0.12 * min(2.0, time_delta)
            )
            deletion = costs[left - 1, right] + gap
            insertion = costs[left, right - 1] + gap
            choices = (substitution, deletion, insertion)
            move = int(np.argmin(choices))
            costs[left, right] = choices[move]
            moves[left, right] = move

    output = {}
    left, right = m, n
    while left > 0 or right > 0:
        move = int(moves[left, right])
        if left > 0 and right > 0 and move == 0:
            canonical_atom = normalized_word(canonical[left - 1]["text"])
            timed_atom = normalized_word(timed[right - 1]["w"])
            similarity = _word_similarity(canonical_atom, timed_atom)
            if similarity >= 0.45:
                output[left - 1] = {
                    "timedIndex": right - 1,
                    "similarity": similarity,
                    "kind": "exact" if similarity == 1.0 else "fuzzy",
                }
            left -= 1
            right -= 1
        elif left > 0 and (right == 0 or move == 1):
            left -= 1
        else:
            right -= 1
    return output


def _interpolated_offset(index: int, canonical: list[dict], matches: dict[int, dict],
                         timed: list[dict]) -> float:
    anchors = sorted(matches)
    if not anchors:
        return 0.0
    before = max((value for value in anchors if value < index), default=None)
    after = min((value for value in anchors if value > index), default=None)

    def offset(anchor: int) -> float:
        source = timed[int(matches[anchor]["timedIndex"])]
        return float(source["t"]) - float(
            canonical[anchor]["sourceStartTimestampSeconds"]
        )

    if before is None:
        return offset(after)
    if after is None:
        return offset(before)
    left_time = float(canonical[before]["sourceStartTimestampSeconds"])
    right_time = float(canonical[after]["sourceStartTimestampSeconds"])
    current = float(canonical[index]["sourceStartTimestampSeconds"])
    if right_time <= left_time:
        weight = (index - before) / max(1, after - before)
    else:
        weight = np.clip((current - left_time) / (right_time - left_time), 0.0, 1.0)
    return float((1.0 - weight) * offset(before) + weight * offset(after))


def align_canonical_words(canonical: list[dict], timed_words: list[dict],
                          horizon_seconds: float) -> tuple[list[dict], dict]:
    """Resolve canonical words onto media time without changing canonical text."""
    horizon = float(horizon_seconds)
    timed = [
        row for row in validate_timed_words(timed_words)
        if float(row["t"]) < horizon + SOURCE_LOOKAHEAD_SECONDS
    ]
    matches = _ordered_word_alignment(canonical, timed)
    target_starts = []
    for index, row in enumerate(canonical):
        match = matches.get(index)
        if match:
            target_starts.append(float(timed[int(match["timedIndex"])]["t"]))
        else:
            target_starts.append(
                float(row["sourceStartTimestampSeconds"])
                + _interpolated_offset(index, canonical, matches, timed)
            )

    count = len(target_starts)
    epsilon = MINIMUM_WORD_DURATION_SECONDS
    starts = np.asarray(target_starts, np.float64)
    for index in range(count):
        lower = 0.0 if index == 0 else starts[index - 1] + epsilon
        upper = horizon - epsilon * max(1, count - index)
        starts[index] = min(max(starts[index], lower), upper)
    for index in range(count - 2, -1, -1):
        starts[index] = min(starts[index], starts[index + 1] - epsilon)
    starts = np.maximum(starts, np.arange(count, dtype=float) * epsilon)

    resolved = []
    mapped_corrections = []
    for index, (row, start) in enumerate(zip(canonical, starts)):
        match = matches.get(index)
        next_start = starts[index + 1] if index + 1 < count else horizon
        if match:
            source = timed[int(match["timedIndex"])]
            source_end = float(source["t"]) + float(source["d"])
            end = min(float(next_start), source_end, horizon)
            method = f"media-aligned {match['kind']} lexical match"
            inferred_from = (
                "source media word interval clipped at the next canonical word"
            )
            mapped_corrections.append(
                float(start) - float(row["sourceStartTimestampSeconds"])
            )
            source_index = int(source.get("sourceIndex", match["timedIndex"]))
            similarity = float(match["similarity"])
        else:
            end = min(float(next_start), horizon)
            method = "anchor-corrected quantized fallback"
            inferred_from = (
                "piecewise media-clock correction between neighboring lexical matches"
            )
            source_index = None
            similarity = None
        if end <= start:
            end = min(horizon, float(start) + epsilon)
        resolved.append({
            **row,
            "resolvedStartSeconds": float(start),
            "resolvedEndSeconds": float(end),
            "start": float(start),
            "end": float(end),
            "startResolution": method,
            "timestampCollisionGroupSize": 1,
            "endInferredFrom": inferred_from,
            "mediaTimingWordIndex": source_index,
            "lexicalMatchSimilarity": similarity,
        })

    exact = sum(row["kind"] == "exact" for row in matches.values())
    fuzzy = sum(row["kind"] == "fuzzy" for row in matches.values())
    mapped = exact + fuzzy
    exact_coverage = exact / max(1, len(canonical))
    mapped_coverage = mapped / max(1, len(canonical))
    confidence = (
        "high" if mapped_coverage >= 0.9 and exact_coverage >= 0.8
        else "moderate" if mapped_coverage >= 0.75
        else "low"
    )
    corrections = np.asarray(mapped_corrections, float)
    audit = {
        "canonicalWords": len(canonical),
        "timedSourceWordsConsidered": len(timed),
        "exactMatchedWords": exact,
        "fuzzyMatchedWords": fuzzy,
        "anchorCorrectedFallbackWords": len(canonical) - mapped,
        "exactMatchCoverage": exact_coverage,
        "mappedCoverage": mapped_coverage,
        "alignmentConfidence": confidence,
        "medianAbsoluteStartCorrectionSeconds": (
            float(np.median(np.abs(corrections))) if len(corrections) else None
        ),
        "maximumAbsoluteStartCorrectionSeconds": (
            float(np.max(np.abs(corrections))) if len(corrections) else None
        ),
        "outcomesUsed": False,
        "canonicalWordsChanged": False,
        "sourceWordReuseAllowed": False,
    }
    return resolved, audit


def retime_word_records_to_media(words: list[dict], media_words: list[dict],
                                 maximum_seconds: float = 20.0) -> tuple[list[dict], dict]:
    """Move an existing ordered word record onto the acoustic media clock.

    This is shared by the curated-hook outcome pipeline and the opening-horizon
    hook-cut marker. Text and order remain unchanged. An unmatched trailing word
    keeps its original duration after the neighboring-anchor clock correction,
    rather than being stretched to the analysis horizon.
    """
    if not words:
        return [], {
            "canonicalWords": 0, "mappedCoverage": 0.0,
            "alignmentConfidence": "low", "alignedEndSeconds": None,
        }
    canonical = []
    source_durations = []
    for index, row in enumerate(words):
        start = float(row.get("t", row.get("timestamp", 0)) or 0)
        duration = float(row.get("d", row.get("duration", 0)) or 0)
        canonical.append({
            "sourceIndex": index,
            "text": str(row.get("w") or row.get("word") or ""),
            "sourceStartTimestampSeconds": start,
        })
        source_durations.append(max(MINIMUM_WORD_DURATION_SECONDS, duration))
    source_end = max(
        row["sourceStartTimestampSeconds"] + duration
        for row, duration in zip(canonical, source_durations)
    )
    horizon = min(float(maximum_seconds), max(0.25, source_end + 1.0))
    resolved, audit = align_canonical_words(canonical, media_words, horizon)
    output = []
    for index, row in enumerate(resolved):
        start = float(row["start"])
        end = float(row["end"])
        if row.get("mediaTimingWordIndex") is None:
            next_start = (
                float(resolved[index + 1]["start"])
                if index + 1 < len(resolved) else horizon
            )
            end = min(next_start, start + source_durations[index], horizon)
            end = max(start + MINIMUM_WORD_DURATION_SECONDS, end)
        output.append({
            "w": row["text"],
            "t": start,
            "d": end - start,
            "alignmentMethod": row["startResolution"],
            "mediaTimingWordIndex": row.get("mediaTimingWordIndex"),
            "lexicalMatchSimilarity": row.get("lexicalMatchSimilarity"),
        })
    output = validate_timed_words(output)
    audit = {
        **audit,
        "alignedEndSeconds": max(float(row["t"] + row["d"]) for row in output),
        "sourceEndSeconds": float(source_end),
        "horizonSeconds": float(horizon),
    }
    return output, audit


def canonical_word_records_from_text(text: str, reference_words: list[dict],
                                     maximum_seconds: float = 20.0) -> tuple[list[dict], dict]:
    """Give the lexical atoms in ``text`` the reference record's media clock.

    This repairs legacy hook records whose stored word surfaces differ from the
    canonical hook string. It is deterministic and outcome blind. A normalized
    character prefix can inherit reference intervals, including explicitly marked
    within-word estimates; other mismatches use the ordered lexical/media aligner.
    """
    surfaces = [
        token.text for token in tokenize(str(text or ""))
        if any(character.isalnum() or character == "_" for character in token.text)
    ]
    reference = validate_timed_words(reference_words)
    if not surfaces:
        raise ValueError("canonical hook text has no lexical atoms")
    source_atoms = [normalized_word(value) for value in surfaces]
    reference_atoms = [normalized_word(row["w"]) for row in reference]
    source_stream = "".join(source_atoms)
    reference_stream = "".join(reference_atoms)
    if source_stream and reference_stream.startswith(source_stream):
        character_starts = []
        character_ends = []
        for row, atom in zip(reference, reference_atoms):
            if not atom:
                continue
            start = float(row["t"])
            duration = float(row["d"])
            for position in range(len(atom)):
                character_starts.append(start + duration * position / len(atom))
                character_ends.append(start + duration * (position + 1) / len(atom))
        cursor = 0
        output = []
        for surface, atom in zip(surfaces, source_atoms):
            output.append({
                "w": surface,
                "t": character_starts[cursor],
                "d": character_ends[cursor + len(atom) - 1] - character_starts[cursor],
                "alignmentMethod": "normalized prefix projected onto reference intervals",
            })
            cursor += len(atom)
        return validate_timed_words(output), {
            "status": "normalized-reference-prefix-cover",
            "canonicalWords": len(surfaces),
            "referenceWords": len(reference),
            "mappedCoverage": 1.0,
            "canonicalWordsChanged": False,
            "outcomesUsed": False,
        }
    if [normalized_word(value) for value in surfaces] == [
        normalized_word(row["w"]) for row in reference
    ]:
        return reference, {
            "status": "canonical-reference-sequence-cover", "canonicalWords": len(surfaces),
            "referenceWords": len(reference), "mappedCoverage": 1.0,
            "canonicalWordsChanged": False, "outcomesUsed": False,
        }

    left = float(reference[0]["t"])
    right = float(reference[-1]["t"] + reference[-1]["d"])
    step = max(0.04, (right - left) / max(1, len(surfaces)))
    proposal = [{
        "w": surface,
        "t": left + index * step,
        "d": max(MINIMUM_WORD_DURATION_SECONDS, step * 0.8),
    } for index, surface in enumerate(surfaces)]
    resolved, audit = retime_word_records_to_media(
        proposal, reference, min(float(maximum_seconds), max(right + 1.0, 0.25)),
    )
    return resolved, {
        **audit,
        "status": "canonical-text-retimed-from-reference",
        "referenceWords": len(reference),
        "canonicalWordsChanged": False,
        "outcomesUsed": False,
    }


def project_canonical_hook_to_reference(canonical_words: list[dict],
                                        reference_words: list[dict]) -> tuple[list[dict], dict]:
    """Project a transcript-variant hook onto the best opening-word prefix.

    The hook and opening are compared as spoken-character streams so spelling,
    punctuation, number formatting, and word segmentation can differ. The best
    endpoint is selected only at an acoustically aligned reference-word boundary.
    Dynamic-programming edit paths place internal hook boundaries; boundaries
    inside an acoustic word are retained but explicitly marked as estimates.
    """
    reference = validate_timed_words(reference_words)
    source_surfaces = [str(row.get("word") or row.get("w") or "") for row in canonical_words]
    source_chunks = ["".join(spoken_atoms(surface)) for surface in source_surfaces]
    reference_chunks = ["".join(spoken_atoms(row["w"])) for row in reference]
    if not source_chunks or any(not chunk for chunk in source_chunks):
        raise ValueError("canonical hook contains an empty spoken-character unit")
    if not reference_chunks or any(not chunk for chunk in reference_chunks):
        raise ValueError("opening reference contains an empty spoken-character unit")

    source_stream = "".join(source_chunks)
    reference_stream = "".join(reference_chunks)
    m, n = len(source_stream), len(reference_stream)
    costs = np.zeros((m + 1, n + 1), dtype=np.int32)
    costs[:, 0] = np.arange(m + 1)
    costs[0, :] = np.arange(n + 1)
    for left in range(1, m + 1):
        substitution = np.fromiter(
            (source_stream[left - 1] != value for value in reference_stream),
            dtype=np.int32, count=n,
        )
        for right in range(1, n + 1):
            costs[left, right] = min(
                costs[left - 1, right - 1] + substitution[right - 1],
                costs[left - 1, right] + 1,
                costs[left, right - 1] + 1,
            )

    reference_boundaries = np.cumsum([len(chunk) for chunk in reference_chunks])
    candidates = []
    for word_count, boundary in enumerate(reference_boundaries, 1):
        distance = int(costs[m, int(boundary)])
        normalized_error = distance / max(1, m, int(boundary))
        candidates.append((normalized_error, distance, abs(int(boundary) - m), word_count))
    normalized_error, distance, _, selected_word_count = min(candidates)
    selected_reference = reference[:selected_word_count]
    selected_chunks = reference_chunks[:selected_word_count]
    selected_stream = "".join(selected_chunks)
    selected_length = len(selected_stream)

    operations = []
    left, right = m, selected_length
    while left or right:
        if left and right:
            penalty = int(source_stream[left - 1] != selected_stream[right - 1])
            if costs[left, right] == costs[left - 1, right - 1] + penalty:
                operations.append(("diagonal", left - 1, right - 1, penalty == 0))
                left -= 1
                right -= 1
                continue
        if left and costs[left, right] == costs[left - 1, right] + 1:
            operations.append(("delete", left - 1, right, False))
            left -= 1
        else:
            operations.append(("insert", left, right - 1, False))
            right -= 1
    operations.reverse()

    source_to_reference_boundary = np.full(m + 1, np.nan, float)
    source_to_reference_boundary[0] = 0.0
    source_position = 0
    reference_position = 0
    exact_source_characters = set()
    for operation, source_index, _, exact in operations:
        if operation == "insert":
            reference_position += 1
            source_to_reference_boundary[source_position] = reference_position
        elif operation == "delete":
            source_position += 1
            source_to_reference_boundary[source_position] = reference_position
        else:
            if exact:
                exact_source_characters.add(source_index)
            source_position += 1
            reference_position += 1
            source_to_reference_boundary[source_position] = reference_position
    if not np.isfinite(source_to_reference_boundary).all():
        raise RuntimeError("edit path did not map every canonical character boundary")

    source_boundaries = np.concatenate(([0], np.cumsum([len(chunk) for chunk in source_chunks])))
    raw_positions = source_to_reference_boundary[source_boundaries].astype(float)
    positions = raw_positions.copy()
    epsilon = min(0.05, selected_length / max(2.0, len(source_chunks) * 4.0))
    positions[0] = 0.0
    positions[-1] = float(selected_length)
    for index in range(1, len(positions) - 1):
        positions[index] = max(positions[index], positions[index - 1] + epsilon)
    for index in range(len(positions) - 2, 0, -1):
        positions[index] = min(positions[index], positions[index + 1] - epsilon)

    reference_starts = np.concatenate(([0], np.cumsum([len(chunk) for chunk in selected_chunks])[:-1]))
    reference_ends = np.cumsum([len(chunk) for chunk in selected_chunks])

    def position_seconds(position: float, side: str) -> float:
        tolerance = 1e-8
        if side == "start":
            matches = np.flatnonzero(np.isclose(reference_starts, position, atol=tolerance))
            if len(matches):
                return float(selected_reference[int(matches[0])]["t"])
        else:
            matches = np.flatnonzero(np.isclose(reference_ends, position, atol=tolerance))
            if len(matches):
                row = selected_reference[int(matches[-1])]
                return float(row["t"] + row["d"])
        word_index = int(np.searchsorted(reference_ends, position, side="right"))
        word_index = min(max(0, word_index), len(selected_reference) - 1)
        left = float(reference_starts[word_index])
        right = float(reference_ends[word_index])
        fraction = min(1.0, max(0.0, (position - left) / max(1e-9, right - left)))
        row = selected_reference[word_index]
        return float(row["t"] + row["d"] * fraction)

    words = []
    for index, (surface, chunk) in enumerate(zip(source_surfaces, source_chunks)):
        start_position = float(positions[index])
        end_position = float(positions[index + 1])
        start = position_seconds(start_position, "start")
        end = position_seconds(end_position, "end")
        start_acoustic = bool(np.any(np.isclose(
            reference_starts, start_position, atol=1e-8,
        )))
        end_acoustic = bool(np.any(np.isclose(
            reference_ends, end_position, atol=1e-8,
        )))
        source_left = int(source_boundaries[index])
        source_right = int(source_boundaries[index + 1])
        lexical = sum(
            character in exact_source_characters
            for character in range(source_left, source_right)
        ) / max(1, len(chunk))
        supporting_indices = [
            reference_index
            for reference_index, (left, right) in enumerate(
                zip(reference_starts, reference_ends)
            )
            if float(left) < end_position - 1e-9
            and float(right) > start_position + 1e-9
        ]
        posteriors = [
            float(selected_reference[reference_index].get(
                "acousticPosteriorGeometricMean", 0,
            ) or 0)
            for reference_index in supporting_indices
        ]
        acoustic = float(np.mean(posteriors)) if posteriors else 0.0
        words.append({
            "w": surface,
            "t": start,
            "d": max(MINIMUM_WORD_DURATION_SECONDS, end - start),
            "canonicalIndex": int(canonical_words[index].get("canonicalIndex", index)),
            "sourceTimestamp": float(canonical_words[index].get("timestamp", 0) or 0),
            "alignmentMethod": "edit-distance projection onto opening CTC word intervals",
            "boundaryAcoustic": bool(start_acoustic and end_acoustic),
            "startBoundaryAcoustic": start_acoustic,
            "endBoundaryAcoustic": end_acoustic,
            "acousticPosteriorGeometricMean": acoustic,
            "alignmentCharacterCoverage": float(lexical),
            "confidenceScore": float(math.sqrt(max(0.0, acoustic * lexical))),
            "status": "supported" if lexical >= 0.8 else "review",
            "source": "opening-ctc-edit-distance-projection",
        })
    words = validate_timed_words(words)
    words[0]["startBoundaryAcoustic"] = True
    words[-1]["endBoundaryAcoustic"] = True
    for row in {0: words[0], len(words) - 1: words[-1]}.values():
        row["boundaryAcoustic"] = bool(
            row["startBoundaryAcoustic"] and row["endBoundaryAcoustic"]
        )
    return words, {
        "status": "edit-distance-reference-prefix-cover",
        "canonicalWords": len(words),
        "referenceWords": len(reference),
        "selectedReferenceWords": selected_word_count,
        "canonicalCharacterCount": m,
        "selectedReferenceCharacterCount": selected_length,
        "characterEditDistance": distance,
        "normalizedCharacterErrorRate": float(normalized_error),
        "mappedCoverage": float(max(0.0, 1.0 - normalized_error)),
        "estimatedBoundaryWords": sum(not row["boundaryAcoustic"] for row in words),
        "outerBoundariesAcoustic": bool(
            words[0]["startBoundaryAcoustic"] and words[-1]["endBoundaryAcoustic"]
        ),
        "canonicalWordsChanged": False,
        "outcomesUsed": False,
    }


def prefix_audit(candidate_words: list[dict], reference_words: list[dict],
                 cutoff_seconds: float = 12.0) -> dict:
    candidate = [row for row in candidate_words if float(row["t"]) < cutoff_seconds]
    reference = [row for row in reference_words if float(row.get("t") or 0) < cutoff_seconds]
    compared = min(len(candidate), len(reference))
    if not compared:
        return {"comparedWords": 0, "lexicalAgreement": None, "startMaeSeconds": None}
    lexical = [
        normalized_word(candidate[index]["w"])
        == normalized_word(reference[index].get("w"))
        for index in range(compared)
    ]
    deltas = [
        abs(float(candidate[index]["t"]) - float(reference[index].get("t") or 0))
        for index in range(compared)
    ]
    return {
        "comparedWords": compared,
        "lexicalAgreement": float(np.mean(lexical)),
        "startMaeSeconds": float(np.mean(deltas)),
        "startMaxErrorSeconds": float(np.max(deltas)),
        "reference": "existing 12-second Promise Lab timing cache",
    }


def timing_reference_audit(candidate_words: list[dict], reference_words: list[dict],
                           cutoff_seconds: float = MEDIA_ALIGNMENT_HORIZON_SECONDS) -> dict:
    """Compare clocks after deterministic ordered lexical alignment."""
    candidate = [
        {
            "text": row.get("w"),
            "sourceStartTimestampSeconds": float(row.get("t") or 0),
            "sourceEndTimestampSeconds": (
                float(row.get("t") or 0) + float(row.get("d") or 0)
            ),
        }
        for row in candidate_words if float(row.get("t") or 0) < cutoff_seconds
    ]
    reference = [
        row for row in validate_timed_words(reference_words)
        if float(row.get("t") or 0) < cutoff_seconds
    ]
    matches = _ordered_word_alignment(candidate, reference)
    exact_deltas = []
    fuzzy_deltas = []
    end_deltas = []
    for candidate_index, match in matches.items():
        reference_word = reference[int(match["timedIndex"])]
        delta = abs(
            float(candidate[candidate_index]["sourceStartTimestampSeconds"])
            - float(reference_word["t"])
        )
        (exact_deltas if match["kind"] == "exact" else fuzzy_deltas).append(delta)
        end_deltas.append(abs(
            float(candidate[candidate_index]["sourceEndTimestampSeconds"])
            - (float(reference_word["t"]) + float(reference_word["d"]))
        ))
    all_deltas = exact_deltas + fuzzy_deltas
    final_match = matches.get(len(candidate) - 1)
    final_end_error = None
    if final_match is not None:
        final_reference = reference[int(final_match["timedIndex"])]
        final_end_error = abs(
            float(candidate[-1]["sourceEndTimestampSeconds"])
            - (float(final_reference["t"]) + float(final_reference["d"]))
        )
    return {
        "candidateWords": len(candidate),
        "referenceWords": len(reference),
        "exactLexicalMatches": len(exact_deltas),
        "fuzzyLexicalMatches": len(fuzzy_deltas),
        "mappedCoverage": len(all_deltas) / max(1, len(candidate)),
        "startMaeSeconds": float(np.mean(all_deltas)) if all_deltas else None,
        "startMedianAbsoluteErrorSeconds": (
            float(np.median(all_deltas)) if all_deltas else None
        ),
        "startP95AbsoluteErrorSeconds": (
            float(np.quantile(all_deltas, 0.95)) if all_deltas else None
        ),
        "startMaxAbsoluteErrorSeconds": (
            float(np.max(all_deltas)) if all_deltas else None
        ),
        "endMedianAbsoluteErrorSeconds": (
            float(np.median(end_deltas)) if end_deltas else None
        ),
        "endP95AbsoluteErrorSeconds": (
            float(np.quantile(end_deltas, 0.95)) if end_deltas else None
        ),
        "finalWordMatched": final_match is not None,
        "finalMatchedWordEndAbsoluteErrorSeconds": final_end_error,
        "referenceIsGroundTruth": False,
    }


def timing_endpoint_reference_audit(
    opening_words: list[dict], reference_words: list[dict],
    endpoint_source_index: int,
    cutoff_seconds: float = MEDIA_ALIGNMENT_HORIZON_SECONDS,
) -> dict:
    """Audit one endpoint after aligning the complete opening for context.

    Matching only a short hook can pair a repeated final word with a later
    occurrence. The full opening supplies the following lexical context needed
    to disambiguate that occurrence; the measured time is never used as an
    outcome or target.
    """
    candidate = [
        {
            "text": row.get("w"),
            "sourceStartTimestampSeconds": float(row.get("t") or 0),
            "sourceEndTimestampSeconds": (
                float(row.get("t") or 0) + float(row.get("d") or 0)
            ),
            "sourceIndex": int(row.get("sourceIndex", index)),
        }
        for index, row in enumerate(opening_words)
        if float(row.get("t") or 0) < cutoff_seconds
    ]
    reference = [
        row for row in validate_timed_words(reference_words)
        if float(row.get("t") or 0) < cutoff_seconds
    ]
    endpoint_candidate_index = next(
        (
            index for index, row in enumerate(candidate)
            if int(row["sourceIndex"]) == int(endpoint_source_index)
        ),
        None,
    )
    if endpoint_candidate_index is None:
        return {
            "endpointMatched": False,
            "endpointPairingMethod": "full-opening ordered lexical alignment",
            "endpointPairingStatus": "source word absent from opening alignment",
            "endpointSourceIndex": int(endpoint_source_index),
            "endpointAbsoluteErrorSeconds": None,
        }
    matches = _ordered_word_alignment(candidate, reference)
    match = matches.get(endpoint_candidate_index)
    pairing_status = "matched with full following context"
    if match is None:
        before = max(
            (index for index in matches if index < endpoint_candidate_index),
            default=None,
        )
        after = min(
            (index for index in matches if index > endpoint_candidate_index),
            default=None,
        )
        if before is not None and after is not None:
            candidate_gap = list(range(before + 1, after))
            reference_gap = list(range(
                int(matches[before]["timedIndex"]) + 1,
                int(matches[after]["timedIndex"]),
            ))
        else:
            candidate_gap = []
            reference_gap = []
        if (
            endpoint_candidate_index in candidate_gap
            and len(candidate_gap) == len(reference_gap)
            and reference_gap
        ):
            reference_index = reference_gap[
                candidate_gap.index(endpoint_candidate_index)
            ]
            similarity = _word_similarity(
                normalized_word(candidate[endpoint_candidate_index]["text"]),
                normalized_word(reference[reference_index].get("w")),
            )
            match = {
                "timedIndex": reference_index,
                "similarity": similarity,
                "kind": "contextual-substitution",
            }
            pairing_status = (
                "paired as a one-to-one substitution between matched neighbors"
            )
        else:
            return {
                "endpointMatched": False,
                "endpointPairingMethod": "full-opening ordered lexical alignment",
                "endpointPairingStatus": "source word unmatched in independent decode",
                "endpointSourceIndex": int(endpoint_source_index),
                "endpointAbsoluteErrorSeconds": None,
            }
    reference_index = int(match["timedIndex"])
    primary_end = float(candidate[endpoint_candidate_index]["sourceEndTimestampSeconds"])
    independent_end = float(reference[reference_index]["t"]) + float(
        reference[reference_index]["d"]
    )
    return {
        "endpointMatched": True,
        "endpointPairingMethod": "full-opening ordered lexical alignment",
        "endpointPairingStatus": pairing_status,
        "endpointSourceIndex": int(endpoint_source_index),
        "endpointCandidateIndex": int(endpoint_candidate_index),
        "endpointReferenceIndex": reference_index,
        "endpointPrimaryWord": candidate[endpoint_candidate_index]["text"],
        "endpointIndependentWord": reference[reference_index].get("w"),
        "endpointLexicalMatchKind": match["kind"],
        "endpointLexicalSimilarity": float(match["similarity"]),
        "endpointPrimaryEndSeconds": primary_end,
        "endpointIndependentEndSeconds": independent_end,
        "endpointAbsoluteErrorSeconds": abs(primary_end - independent_end),
    }
