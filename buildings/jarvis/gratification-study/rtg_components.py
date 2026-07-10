"""Deterministic, unlabeled multi-resolution hook component lattice."""

from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np


TOKEN_RE = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)?")
STRUCTURAL_BREAKS = {
    "and", "but", "because", "however", "so", "then", "until", "unless",
    "while", "although", "though", "yet", "after", "before",
}


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(str(text or ""))


def normalized_token(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower().replace("’", "'"))


def content_id(*parts: Any) -> str:
    payload = "\x1f".join(str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


@dataclass
class Alignment:
    tokens: list[str]
    starts: list[float]
    ends: list[float]
    exact_matches: int
    mapped_tokens: int
    edit_cost: float
    method: str

    @property
    def exact_rate(self) -> float:
        return self.exact_matches / max(1, len(self.tokens))

    @property
    def coverage(self) -> float:
        return self.mapped_tokens / max(1, len(self.tokens))


@dataclass
class ComponentRecord:
    id: str
    videoId: str
    startToken: int
    endToken: int
    text: str
    contextText: str
    prefixText: str
    suffixText: str
    startSec: float
    endSec: float
    durationSec: float
    relativeStart: float
    relativeEnd: float
    modes: list[str]
    parentIds: list[str]
    childIds: list[str]
    previousId: str | None
    nextId: str | None
    isFullHook: bool
    alignmentExactRate: float
    alignmentCoverage: float

    def json(self) -> dict[str, Any]:
        return asdict(self)


def _match_cost(a: str, b: str) -> float:
    a, b = normalized_token(a), normalized_token(b)
    if not a or not b:
        return 1.0
    if a == b:
        return 0.0
    if a.rstrip("s") == b.rstrip("s") and min(len(a), len(b)) >= 3:
        return 0.25
    if a in b or b in a:
        return 0.4
    return 1.0


def align_hook_words(row: dict) -> Alignment:
    tokens = tokenize(row.get("hookText") or "")
    hook_end = float(row.get("hookEndSec") or 0.0)
    timed = []
    for word in row.get("words") or []:
        start = float(word.get("t") or 0.0)
        duration = max(0.0, float(word.get("d") or 0.0))
        if start <= hook_end + 1.5:
            timed.append((str(word.get("w") or ""), start, start + duration))
    timed = timed[:len(tokens) + 12]

    if tokens and len(timed) >= len(tokens):
        prefix_costs = [_match_cost(tokens[i], timed[i][0]) for i in range(len(tokens))]
        if sum(cost == 0 for cost in prefix_costs) / len(tokens) >= 0.9:
            return Alignment(
                tokens,
                [timed[i][1] for i in range(len(tokens))],
                [timed[i][2] for i in range(len(tokens))],
                sum(cost == 0 for cost in prefix_costs),
                len(tokens),
                float(sum(prefix_costs)),
                "timed_prefix",
            )

    n, m = len(tokens), len(timed)
    if not n:
        return Alignment([], [], [], 0, 0, 0.0, "empty")
    if not m:
        width = max(hook_end, 0.5) / n
        starts = [i * width for i in range(n)]
        return Alignment(tokens, starts, [(i + 1) * width for i in range(n)], 0, 0, float(n), "uniform_fallback")

    # Global sequence alignment. Timed-word insertions are cheaper than losing
    # a source hook token because the transcript timeline often extends beyond
    # the selected hook boundary.
    dp = np.full((n + 1, m + 1), np.inf, float)
    back = np.zeros((n + 1, m + 1), np.int8)
    dp[0, :] = np.arange(m + 1) * 0.35
    dp[:, 0] = np.arange(n + 1) * 1.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            choices = (
                dp[i - 1, j - 1] + _match_cost(tokens[i - 1], timed[j - 1][0]),
                dp[i - 1, j] + 1.0,
                dp[i, j - 1] + 0.35,
            )
            decision = int(np.argmin(choices))
            dp[i, j] = choices[decision]
            back[i, j] = decision

    mapping: dict[int, int] = {}
    i, j = n, int(np.argmin(dp[n, :]))
    final_cost = float(dp[i, j])
    while i > 0 or j > 0:
        decision = int(back[i, j]) if i > 0 and j > 0 else (1 if i > 0 else 2)
        if decision == 0:
            mapping[i - 1] = j - 1
            i -= 1
            j -= 1
        elif decision == 1:
            i -= 1
        else:
            j -= 1

    starts = [np.nan] * n
    ends = [np.nan] * n
    exact = 0
    for token_index, timed_index in mapping.items():
        starts[token_index] = timed[timed_index][1]
        ends[token_index] = timed[timed_index][2]
        exact += int(_match_cost(tokens[token_index], timed[timed_index][0]) == 0)

    # Deterministically interpolate missing positions between observed word
    # times. This is marked as non-mapped coverage in the audit.
    known = [idx for idx, value in enumerate(starts) if np.isfinite(value)]
    if known:
        xp = np.asarray(known, float)
        starts_arr = np.interp(np.arange(n), xp, np.asarray([starts[idx] for idx in known], float))
        ends_arr = np.interp(np.arange(n), xp, np.asarray([ends[idx] for idx in known], float))
        typical = np.median(np.maximum(0.04, ends_arr[known] - starts_arr[known]))
        for idx in range(n):
            if not np.isfinite(starts[idx]):
                starts[idx] = float(starts_arr[idx])
                ends[idx] = float(max(ends_arr[idx], starts_arr[idx] + typical))
    else:
        width = max(hook_end, 0.5) / n
        starts = [idx * width for idx in range(n)]
        ends = [(idx + 1) * width for idx in range(n)]
    return Alignment(tokens, [float(x) for x in starts], [float(x) for x in ends], exact, len(mapping), final_cost, "sequence_alignment")


def _add_span(spans: dict[tuple[int, int], set[str]], start: int, end: int, mode: str, n: int) -> None:
    start, end = max(0, int(start)), min(n, int(end))
    if end > start:
        spans[(start, end)].add(mode)


def candidate_spans(alignment: Alignment) -> dict[tuple[int, int], set[str]]:
    n = len(alignment.tokens)
    spans: dict[tuple[int, int], set[str]] = defaultdict(set)
    if not n:
        return spans
    _add_span(spans, 0, n, "full_hook", n)

    for length in (1, 2, 3):
        for start in range(0, n - length + 1):
            _add_span(spans, start, start + length, f"ngram_{length}", n)

    for length in (4, 6, 8, 12, 16):
        if length > n:
            continue
        starts = list(range(0, n - length + 1, max(1, length // 2)))
        starts.append(n - length)
        for start in sorted(set(starts)):
            _add_span(spans, start, start + length, f"window_{length}", n)

    for boundary in range(2, n):
        _add_span(spans, 0, boundary, "prefix", n)
        _add_span(spans, boundary, n, "suffix", n)

    # Clause candidates use delivery structure only. They remain numeric spans;
    # the break words are not semantic RTG labels.
    boundaries = {0, n}
    for idx, token in enumerate(alignment.tokens):
        if normalized_token(token) in STRUCTURAL_BREAKS and 0 < idx < n:
            boundaries.add(idx)
        if idx + 1 < n and normalized_token(token) == "to" and normalized_token(alignment.tokens[idx + 1]) == "see":
            boundaries.add(idx)
    for idx in range(n - 1):
        gap = alignment.starts[idx + 1] - alignment.ends[idx]
        if gap >= 0.22:
            boundaries.add(idx + 1)
    ordered = sorted(boundaries)
    for left, right in zip(ordered[:-1], ordered[1:]):
        _add_span(spans, left, right, "delivery_segment", n)
    for idx in range(len(ordered) - 2):
        _add_span(spans, ordered[idx], ordered[idx + 2], "adjacent_segments", n)

    # Timestamp windows provide a segmentation independent of word count.
    hook_end = max(alignment.ends[-1], 0.5)
    for width in (0.5, 1.0, 2.0, 3.0, 5.0):
        if width > hook_end + 0.25:
            continue
        starts = np.arange(0.0, max(0.001, hook_end - width + 0.001), max(0.25, width / 2.0))
        if len(starts) == 0:
            starts = np.asarray([0.0])
        for window_start in starts:
            window_end = float(window_start + width)
            selected = [
                idx for idx, (start, end) in enumerate(zip(alignment.starts, alignment.ends))
                if end > window_start and start < window_end
            ]
            if selected:
                _add_span(spans, min(selected), max(selected) + 1, f"time_window_{width:g}s", n)
    return spans


def build_components_for_row(row: dict) -> tuple[list[ComponentRecord], Alignment]:
    alignment = align_hook_words(row)
    spans = candidate_spans(alignment)
    n = len(alignment.tokens)
    video_id = str(row.get("id"))
    span_ids = {(start, end): f"cmp_{content_id(video_id, start, end)}" for start, end in spans}
    records = []
    ordered_keys = sorted(spans, key=lambda key: (key[0], key[1] - key[0], key[1]))

    for start, end in ordered_keys:
        tokens = alignment.tokens[start:end]
        before = alignment.tokens[:start]
        after = alignment.tokens[end:]
        text = " ".join(tokens)
        context = " ".join(before + after)
        parents = []
        children = []
        containing = [key for key in spans if key != (start, end) and key[0] <= start and key[1] >= end]
        if containing:
            parent_size = min(right - left for left, right in containing)
            parents = [span_ids[key] for key in containing if key[1] - key[0] == parent_size]
        contained = [key for key in spans if key != (start, end) and key[0] >= start and key[1] <= end]
        if contained:
            child_size = max(right - left for left, right in contained)
            children = [span_ids[key] for key in contained if key[1] - key[0] == child_size]

        same_size = [key for key in ordered_keys if key[1] - key[0] == end - start]
        same_size.sort()
        position = same_size.index((start, end))
        previous_id = span_ids[same_size[position - 1]] if position > 0 else None
        next_id = span_ids[same_size[position + 1]] if position + 1 < len(same_size) else None
        start_sec = alignment.starts[start]
        end_sec = alignment.ends[end - 1]
        records.append(ComponentRecord(
            id=span_ids[(start, end)],
            videoId=video_id,
            startToken=start,
            endToken=end,
            text=text,
            contextText=context,
            prefixText=" ".join(alignment.tokens[:end]),
            suffixText=" ".join(alignment.tokens[start:]),
            startSec=round(float(start_sec), 4),
            endSec=round(float(end_sec), 4),
            durationSec=round(float(max(0.0, end_sec - start_sec)), 4),
            relativeStart=round(float(start / max(1, n)), 5),
            relativeEnd=round(float(end / max(1, n)), 5),
            modes=sorted(spans[(start, end)]),
            parentIds=sorted(parents),
            childIds=sorted(children),
            previousId=previous_id,
            nextId=next_id,
            isFullHook=start == 0 and end == n,
            alignmentExactRate=round(alignment.exact_rate, 4),
            alignmentCoverage=round(alignment.coverage, 4),
        ))
    return records, alignment


def build_component_lattice(rows: list[dict]) -> tuple[list[ComponentRecord], dict[str, Any]]:
    components = []
    alignments = {}
    mode_counts = Counter()
    source_counts = Counter()
    cut_counts = Counter()
    mismatch_records = []
    for row in rows:
        records, alignment = build_components_for_row(row)
        components.extend(records)
        alignments[str(row["id"])] = alignment
        for record in records:
            mode_counts.update(record.modes)
        source_counts[str(row.get("transcriptSource") or "unknown")] += 1
        cut_counts[str(row.get("cutBy") or "unknown")] += 1
        actual = len(alignment.tokens)
        stored = row.get("hookWordCount")
        if stored is not None and int(stored) != actual:
            mismatch_records.append({
                "id": row.get("id"),
                "stored": int(stored),
                "actual": actual,
                "delta": int(stored) - actual,
            })

    exact_rates = np.asarray([alignment.exact_rate for alignment in alignments.values()], float)
    coverages = np.asarray([alignment.coverage for alignment in alignments.values()], float)
    methods = Counter(alignment.method for alignment in alignments.values())
    by_video = Counter(component.videoId for component in components)
    audit = {
        "videos": len(rows),
        "components": len(components),
        "componentsPerVideo": {
            "min": min(by_video.values()) if by_video else 0,
            "median": round(float(np.median(list(by_video.values()))), 2) if by_video else 0,
            "max": max(by_video.values()) if by_video else 0,
        },
        "modes": dict(sorted(mode_counts.items())),
        "alignment": {
            "methods": dict(sorted(methods.items())),
            "medianExactRate": round(float(np.median(exact_rates)), 4),
            "minimumExactRate": round(float(np.min(exact_rates)), 4),
            "medianCoverage": round(float(np.median(coverages)), 4),
            "minimumCoverage": round(float(np.min(coverages)), 4),
        },
        "transcriptSources": dict(sorted(source_counts.items())),
        "hookCutBy": dict(sorted(cut_counts.items())),
        "wordCountMismatches": {
            "count": len(mismatch_records),
            "records": mismatch_records,
        },
        "rules": {
            "labels": "No component is labeled as RTG; modes describe only deterministic segmentation.",
            "context": "Every component stores the full hook with that token span deleted.",
            "timing": "Token timestamps use aligned source words; interpolated positions remain visible through alignment coverage.",
        },
    }
    return components, audit
