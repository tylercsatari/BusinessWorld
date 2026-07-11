"""Mechanical sequence primitives with no semantic boundary rules."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


# Unicode word runs, internal apostrophes/hyphens, or one non-space symbol.
# This is a surface atomizer. It contains no vocabulary or phrase patterns.
ATOM_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*|_+|[^\w\s]", re.UNICODE)
RIGHT_ATTACH = frozenset(",.;:!?%)]}")
LEFT_ATTACH = frozenset("([{#$")


@dataclass(frozen=True)
class Token:
    index: int
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Span:
    start: int
    end: int


def normalize_source(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())


def tokenize(text: str) -> list[Token]:
    text = normalize_source(text)
    return [Token(i, match.group(0), match.start(), match.end())
            for i, match in enumerate(ATOM_RE.finditer(text))]


def join_surfaces(parts: list[str]) -> str:
    out = ""
    for raw in parts:
        part = str(raw or "").strip()
        if not part:
            continue
        if not out:
            out = part
        elif part[0] in RIGHT_ATTACH or out[-1] in LEFT_ATTACH:
            out += part
        else:
            out += " " + part
    return out.strip()


def surface(tokens: list[Token], start: int, end: int,
            source_text: str | None = None) -> str:
    if source_text is not None:
        if start < 0 or end > len(tokens) or start >= end:
            raise ValueError("surface span is outside the observed token sequence")
        original = normalize_source(source_text)
        return original[tokens[start].start:tokens[end - 1].end].strip()
    return join_surfaces([token.text for token in tokens[start:end]])


def without(tokens: list[Token], removed: set[int] | tuple[int, ...] | list[int],
            source_text: str | None = None) -> str:
    removed_set = set(removed)
    if source_text is not None:
        original = normalize_source(source_text)
        ranges = sorted(
            (tokens[index].start, tokens[index].end)
            for index in removed_set if 0 <= index < len(tokens)
        )
        cursor = 0
        kept = []
        for start, end in ranges:
            kept.append(original[cursor:start])
            cursor = max(cursor, end)
        kept.append(original[cursor:])
        return normalize_source("".join(kept))
    return join_surfaces([token.text for token in tokens if token.index not in removed_set])


def without_span(tokens: list[Token], start: int, end: int,
                 source_text: str | None = None) -> str:
    return without(tokens, range(start, end), source_text=source_text)


def replace_span(tokens: list[Token], start: int, end: int, replacement: str,
                 source_text: str | None = None) -> str:
    if source_text is not None:
        if start < 0 or end > len(tokens) or start >= end:
            raise ValueError("replacement span is outside the observed token sequence")
        original = normalize_source(source_text)
        if replacement == surface(tokens, start, end, source_text=original):
            return original
        return join_surfaces([
            original[:tokens[start].start],
            replacement,
            original[tokens[end - 1].end:],
        ])
    return join_surfaces([
        *[token.text for token in tokens[:start]],
        replacement,
        *[token.text for token in tokens[end:]],
    ])


def all_spans(n: int) -> list[Span]:
    return [Span(start, end) for start in range(n) for end in range(start + 1, n + 1)]


def all_pairs(n: int) -> list[tuple[int, int]]:
    return [(left, right) for left in range(n) for right in range(left + 1, n)]


def text_key(text: str) -> str:
    return hashlib.sha256(normalize_source(text).encode("utf-8")).hexdigest()


def sequence_fingerprint(text: str) -> str:
    atoms = tokenize(text)
    payload = "\n".join(f"{t.index}:{t.start}:{t.end}:{t.text}" for t in atoms)
    return hashlib.sha256((normalize_source(text) + "\0" + payload).encode("utf-8")).hexdigest()
