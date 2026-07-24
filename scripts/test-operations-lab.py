#!/usr/bin/env python3
"""Deterministic contracts for the Shorts Hook Operations builder."""

from __future__ import annotations

import importlib.util
import inspect
import json
import re
import tempfile
import threading
import time
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "buildings" / "jarvis" / "operations-lab" / "build_operations.py"
SPEC = importlib.util.spec_from_file_location("operations_builder", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def main() -> None:
    assert len(MODULE.FEATURES) >= 10
    assert len({item["key"] for item in MODULE.FEATURES}) == len(MODULE.FEATURES)
    assert {"full_visual", "hook_language", "combined_semantics"}.issubset(MODULE.FEATURE_BY_KEY)
    assert set(MODULE.EXTRACTED_FEATURE_KEYS).isdisjoint(
        {"full_visual", "hook_language", "combined_semantics"}
    )

    describe_source = inspect.getsource(MODULE.GeminiVisionClient.describe)
    assert "hook_text" not in describe_source
    assert '"parts": [' in describe_source
    assert '"text": PROMPT' in describe_source
    assert MODULE.VISION_MAX_OUTPUT_TOKENS >= 8192
    assert '"output_truncated"' in describe_source
    prompt_flat = re.sub(r"\s+", " ", MODULE.PROMPT).lower()
    assert "keep estimates" in prompt_flat
    assert "you do not receive" in prompt_flat

    fixture = {
        "visual_description": " ".join(["visible"] * 70),
        "sequence": [f"Frame {index} contains a visible object" for index in range(5)],
        "features": {
            key: f"A concrete visible measurement for {key}"
            for key in MODULE.EXTRACTED_FEATURE_KEYS
        },
    }
    clean = MODULE.validate_description(fixture)
    assert len(clean["sequence"]) == 5
    assert set(clean["features"]) == set(MODULE.EXTRACTED_FEATURE_KEYS)

    with tempfile.TemporaryDirectory() as temp_dir:
        local_payload = {
            "id": "local-cache-contract",
            "visual_description": fixture["visual_description"],
            "sequence": fixture["sequence"],
            "features": fixture["features"],
        }
        local_directory = Path(temp_dir)
        MODULE.save_local_description(local_payload, local_directory)
        local_loaded = MODULE.load_local_description_cache(local_directory)
        assert local_loaded["local-cache-contract"]["id"] == "local-cache-contract"

    error = MODULE.classify_provider_error(429, "quota exhausted key=secret-value")
    assert error["kind"] == "credits_or_quota_exhausted"
    assert "secret-value" not in error["message"]
    assert error["retrySeconds"] == MODULE.RETRY_SECONDS
    embedded_error = MODULE.classify_provider_exception(
        "RESOURCE_EXHAUSTED: Gemini billing quota has been reached"
    )
    assert embedded_error["kind"] == "credits_or_quota_exhausted"
    assert embedded_error["httpStatus"] == 429

    retry_events = []
    with tempfile.TemporaryDirectory() as temp_dir:
        store = MODULE.EmbeddingStore(
            Path(temp_dir) / "vectors.sqlite",
            on_retry=retry_events.append,
        )
        store._notify_retry(429, "quota exhausted", 12.5, 3)
        store.api_key = ""
        try:
            store._post_batch(["configuration contract"])
            raise AssertionError("missing Gemini configuration did not fail")
        except Exception as exc:
            assert getattr(exc, "retryable", True) is False
        store.close()
    assert retry_events == [{
        "status": 429,
        "message": "quota exhausted",
        "delay": 12.5,
        "attempt": 3,
    }]

    original_put_json = MODULE.R2.put_json
    original_local_status = MODULE.LOCAL_STATUS
    status_started = threading.Event()
    status_release = threading.Event()
    try:
        MODULE.LOCAL_STATUS = MODULE.CACHE_DIR / "test-status.json"
        MODULE.STATUS_STATE = {}
        MODULE.STATUS_PENDING = None
        MODULE.STATUS_UPLOAD_THREAD = None
        MODULE.LAST_STATUS_WRITE = 0.0

        def slow_status_upload(_key, _value):
            status_started.set()
            status_release.wait(2)

        MODULE.R2.put_json = slow_status_upload
        started = time.monotonic()
        MODULE.emit_status("test_status", force=True, message="status lock contract")
        elapsed = time.monotonic() - started
        assert elapsed < 0.25, f"emit_status blocked on R2 for {elapsed:.3f}s"
        assert status_started.wait(1), "status uploader never received the snapshot"
        status_release.set()
        MODULE.flush_status(2)
    finally:
        status_release.set()
        MODULE.flush_status(2)
        MODULE.R2.put_json = original_put_json
        MODULE.LOCAL_STATUS = original_local_status

    base = {"id": "hk1", "savedAt": 1, "text": "first text"}
    changed = {**base, "text": "different text"}
    assert MODULE.source_hash(base, "etag") == MODULE.source_hash(changed, "etag")

    rng = np.random.default_rng(MODULE.SEED)
    vectors = np.vstack([
        rng.normal(-2, 0.18, size=(30, 10)),
        rng.normal(2, 0.18, size=(30, 10)),
    ])
    vectors = MODULE.normalize_rows(vectors)
    labels_a, selection_a, plane_a = MODULE.candidate_clusters(vectors, 0)
    labels_b, selection_b, plane_b = MODULE.candidate_clusters(vectors, 0)
    assert np.array_equal(labels_a, labels_b)
    assert selection_a == selection_b
    assert np.allclose(plane_a, plane_b)
    assert selection_a["chosenK"] >= 2
    assert len(selection_a["candidates"]) >= 2
    assert "one resampling standard deviation" in selection_a["rule"]
    assert selection_a["resamples"] == 10
    assert all("silhouetteSd" in row for row in selection_a["candidates"])

    small_vectors = MODULE.normalize_rows(rng.normal(size=(10, 12)))
    _, small_selection, _ = MODULE.candidate_clusters(small_vectors, 1)
    assert small_selection["chosenK"] >= 2

    adjusted = [{"p": 0.01}, {"p": 0.04}, {"p": 0.03}]
    MODULE.bh_adjust(adjusted, output_key="globalQ")
    assert all(0 <= row["globalQ"] <= 1 for row in adjusted)
    assert all("q" not in row for row in adjusted)

    family_fixture = [
        {
            "clusters": [
                {
                    "outcomes": {
                        key: {"p": 0.01, "q": 0.02}
                        for key in MODULE.TARGETS
                    },
                },
            ],
        },
        {
            "clusters": [
                {
                    "outcomes": {
                        key: {"p": 0.04, "q": 0.04}
                        for key in MODULE.TARGETS
                    },
                },
            ],
        },
    ]
    MODULE.apply_global_cluster_adjustment(family_fixture)
    for family in family_fixture:
        for outcome in family["clusters"][0]["outcomes"].values():
            assert outcome["qWithinFamily"] in {0.02, 0.04}
            assert 0 <= outcome["q"] <= 1

    interaction_families = [
        {
            "key": "left",
            "assignments": [0] * 5 + [1] * 5,
            "clusters": [{"id": 0, "label": "left zero"}, {"id": 1, "label": "left one"}],
        },
        {
            "key": "right",
            "assignments": [0] * 5 + [1] * 5,
            "clusters": [{"id": 0, "label": "right zero"}, {"id": 1, "label": "right one"}],
        },
    ]
    interaction_outcomes = {"target": np.asarray([90.0] * 5 + [70.0] * 5)}
    interactions = MODULE.build_interactions(interaction_families, interaction_outcomes)["target"]
    assert interactions
    assert all({"p80", "q80", "p85", "q85"}.issubset(row) for row in interactions)
    assert all(0 <= row["q80"] <= 1 and 0 <= row["q85"] <= 1 for row in interactions)

    sparse_validation = MODULE.validate_family(
        MODULE.normalize_rows(rng.normal(size=(4, 6))),
        {"target": np.asarray([70.0, 80.0, 90.0, np.nan])},
        0,
    )["target"]
    assert sparse_validation["n"] == 3
    assert sparse_validation["r2"] is None

    gate_client = object.__new__(MODULE.GeminiVisionClient)
    gate_client._gate = threading.Condition()
    gate_client._active_error = {"kind": "credits_or_quota_exhausted"}
    gate_client._blocked_until = time.monotonic() + 60
    gate_client._clear_error()
    assert gate_client._active_error is not None
    assert gate_client._blocked_until > time.monotonic()

    print(json.dumps({
        "ok": True,
        "features": len(MODULE.FEATURES),
        "extractedFeatures": len(MODULE.EXTRACTED_FEATURE_KEYS),
        "promptHash": MODULE.PROMPT_HASH,
        "chosenK": selection_a["chosenK"],
        "candidateK": [row["k"] for row in selection_a["candidates"]],
    }))


if __name__ == "__main__":
    main()
