"""Build exact sequence counterfactual tensors from cached text embeddings."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import numpy as np

from sequence import all_pairs, all_spans, normalize_source, surface, tokenize, without, without_span


EPS = 1e-9
INTERVENTION_VERSION = "exact-offset-v2"


def unit(vector) -> np.ndarray:
    arr = np.asarray(vector, np.float32)
    return arr / (float(np.linalg.norm(arr)) + EPS)


@dataclass
class InterventionPlan:
    text: str
    tokens: list
    spans: list
    pairs: list
    required_texts: list[str]


def make_plan(text: str) -> InterventionPlan:
    text = normalize_source(text)
    tokens = tokenize(text)
    spans = all_spans(len(tokens))
    pairs = all_pairs(len(tokens))
    required = [text]
    for span in spans:
        required.append(surface(tokens, span.start, span.end, source_text=text))
        context = without_span(tokens, span.start, span.end, source_text=text)
        if context:
            required.append(context)
    for left, right in pairs:
        context = without(tokens, (left, right), source_text=text)
        if context:
            required.append(context)
    return InterventionPlan(text, tokens, spans, pairs, list(dict.fromkeys(required)))


def _lookup(vectors: dict[str, np.ndarray], text: str, dim: int) -> np.ndarray:
    if not text:
        return np.zeros(dim, np.float32)
    if text not in vectors:
        raise KeyError(f"missing embedding for {text!r}")
    return unit(vectors[text])


def build_tensor(plan: InterventionPlan, vectors: dict[str, np.ndarray]) -> tuple[dict, dict]:
    dim = int(next(iter(vectors.values())).size)
    full = _lookup(vectors, plan.text, dim)
    n = len(plan.tokens)

    token_effects = np.zeros((n, dim), np.float32)
    deleted_single = []
    for index in range(n):
        text = without(plan.tokens, (index,), source_text=plan.text)
        context = _lookup(vectors, text, dim)
        deleted_single.append(context)
        token_effects[index] = full - context

    pair_norms = np.zeros((n, n), np.float32)
    for left, right in plan.pairs:
        text = without(plan.tokens, (left, right), source_text=plan.text)
        both_deleted = _lookup(vectors, text, dim)
        interaction = full - deleted_single[left] - deleted_single[right] + both_deleted
        denominator = np.linalg.norm(token_effects[left]) + np.linalg.norm(token_effects[right]) + EPS
        score = float(np.linalg.norm(interaction) / denominator)
        pair_norms[left, right] = pair_norms[right, left] = score

    span_start = np.asarray([span.start for span in plan.spans], np.int16)
    span_end = np.asarray([span.end for span in plan.spans], np.int16)
    span_raw = np.zeros((len(plan.spans), dim), np.float32)
    span_context = np.zeros_like(span_raw)
    span_nonadditive_norm = np.zeros(len(plan.spans), np.float32)
    span_surface = []

    for index, span in enumerate(plan.spans):
        raw_text = surface(plan.tokens, span.start, span.end, source_text=plan.text)
        context_text = without_span(plan.tokens, span.start, span.end, source_text=plan.text)
        raw = _lookup(vectors, raw_text, dim)
        context = _lookup(vectors, context_text, dim)
        effect = full - context
        additive = token_effects[span.start:span.end].sum(axis=0)
        residual = effect - additive
        span_raw[index] = raw
        span_context[index] = context
        span_nonadditive_norm[index] = float(np.linalg.norm(residual) /
                                              (np.linalg.norm(effect) + np.linalg.norm(additive) + EPS))
        span_surface.append(raw_text)

    fingerprint = hashlib.sha256(
        (plan.text + "\0" + "\n".join(token.text for token in plan.tokens)).encode("utf-8")
    ).hexdigest()
    arrays = {
        "full": full,
        "token_effects": token_effects,
        "pair_norms": pair_norms,
        "span_start": span_start,
        "span_end": span_end,
        "span_raw": span_raw,
        "span_context": span_context,
        "span_nonadditive_norm": span_nonadditive_norm,
    }
    metadata = {
        "fingerprint": fingerprint,
        "interventionVersion": INTERVENTION_VERSION,
        "counterfactualTextConstruction": "exact normalized source offsets; untouched characters are preserved",
        "text": plan.text,
        "tokenizer": "unicode word runs with internal apostrophe/hyphen plus every non-space symbol",
        "tokens": [
            {"index": token.index, "text": token.text, "start": token.start, "end": token.end}
            for token in plan.tokens
        ],
        "spans": [
            {"index": index, "start": span.start, "end": span.end, "text": span_surface[index]}
            for index, span in enumerate(plan.spans)
        ],
        "pairCount": len(plan.pairs),
        "emptyContextConvention": "zero vector; Gemini rejects empty content",
        "formulae": {
            "spanInfluence": "unit(E(full)) - unit(E(full without span))",
            "pairInteraction": "E(full) - E(full-i) - E(full-j) + E(full-{i,j})",
            "spanNonadditivity": "span influence - sum(single-token influences)",
        },
    }
    return arrays, metadata


def metadata_json(metadata: dict) -> bytes:
    return json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
