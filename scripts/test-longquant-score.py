#!/usr/bin/env python3
"""Focused regression checks for channel-specific Long Quant scoring."""
import hashlib
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import longquant_score as scorer


def main():
    query_input = scorer.query_input_manifest(
        b"\xff\xd8immutable-thumbnail-bytes\xff\xd9",
        "Exact title / idea text",
        "title",
    )
    assert query_input["thumbnail"]["present"] is True
    assert query_input["thumbnail"]["sha256"] == hashlib.sha256(
        b"\xff\xd8immutable-thumbnail-bytes\xff\xd9"
    ).hexdigest()
    assert query_input["text"]["present"] is True
    assert query_input["text"]["sha256"] == hashlib.sha256(
        "Exact title / idea text".encode()
    ).hexdigest()
    assert query_input["title"]["present"] is True
    assert query_input["idea"]["present"] is False
    assert query_input["fingerprint_sha256"] != scorer.query_input_manifest(
        b"\xff\xd8immutable-thumbnail-bytes\xff\xd9",
        "Exact title / idea text",
        "idea",
    )["fingerprint_sha256"]
    assert query_input["fingerprint_sha256"] != scorer.query_input_manifest(
        b"\xff\xd8immutable-thumbnail-bytes\xff\xd9",
        "Exact title / idea text changed",
        "title",
    )["fingerprint_sha256"]

    map_ids = ["b", "a", "c"]
    archive_ids = ["a", "b", "c"]
    published_alignment = {
        "intersection": scorer.id_population(map_ids),
    }
    private_fit_lineage = {
        "account_metric_private_fit_populations": {
            "tyler": {
                "label_snapshot_revision": {
                    "sha256": "c" * 64,
                    "immutable_key": (
                        "longform/source-snapshots/private-labels/tyler/"
                        f"by-sha256/{'c' * 64}.json"
                    ),
                },
                "metrics": {
                    metric: {
                        "fit_population": scorer.id_population(map_ids),
                    }
                    for metric in ("ctr", "ret30", "realviews", "ctrviews")
                },
            },
        },
        "source_database_revision": {
            "sha256": "d" * 64,
            "immutable_key": (
                "longform/source-snapshots/database/"
                f"by-sha256/{'d' * 64}.json"
            ),
        },
    }
    raw_map = {
        # Deliberately differs from the embedding-archive order. The scorer
        # must join by video ID instead of applying archive row positions.
        "id": map_ids,
        "title": ["B", "A", "C"],
        "views": [1_000, 100, 10_000],
        "outlier": [2, 1, 3],
        "proj": {
            "ctrviews": {"x": [100, 500, 900], "y": [120, 520, 920]},
            "ctr": {"x": [120, 520, 920], "y": [100, 500, 900]},
            "ret30": {"x": [140, 540, 940], "y": [100, 500, 900]},
            "realviews": {"x": [160, 560, 960], "y": [100, 500, 900]},
        },
        "_provenance": {
            "generation_id": "map-generation-123",
            "algorithm_generation": {
                "id": "long-map-steering-v2",
                "generator": "add_steered_proj_long.py",
            },
        },
    }
    archive_revision = {
        "key": "raw-long/together/embeddings.npz",
        "etag": "embedding-etag",
        "version_id": "embedding-version",
        "content_length": 1234,
        "sha256": "a" * 64,
        "immutable_key": f"raw-long/together/embeddings/by-sha256/{'a' * 64}.npz",
        "video_id_population": scorer.id_population(archive_ids),
        "_video_ids": archive_ids,
    }
    map_revision = {
        "key": "raw-long/together/map.json",
        "etag": "map-etag",
        "version_id": "map-version",
        "content_length": 4321,
        "sha256": "b" * 64,
        "immutable_key": f"raw-long/together/maps/by-sha256/{'b' * 64}.json",
        "video_id_population": scorer.id_population(map_ids),
        "generation_id": "map-generation-123",
        "algorithm_generation": raw_map["_provenance"]["algorithm_generation"],
        "manifest_key": "raw-long/together/map.manifest.json",
        "published_embedding_archive": {
            "sha256": "a" * 64,
            "mutable_etag": "embedding-etag",
        },
        "published_alignment_population": published_alignment,
        "published_dataset_lineage": private_fit_lineage,
    }
    neighbors = (
        np.asarray([0, 1]),
        np.asarray([0.9, 0.8]),
        np.asarray([2.0, 1.0]),
        ["a", "b"],
        archive_revision,
    )
    with (
        patch.object(scorer, "top_neighbors", return_value=neighbors),
        patch.object(scorer, "load_map_with_revision", return_value=(raw_map, map_revision)),
    ):
        result = scorer.channel_score(
            "together",
            np.ones(scorer.DIM, np.float32),
            query_input=query_input,
        )
        visual_result = scorer.channel_score(
            "visual",
            np.ones(scorer.DIM, np.float32),
            query_input=query_input,
        )

    ctrviews = result["metrics"]["ctrviews"]
    assert ctrviews["kind"] == "neighbor_axis_percentile"
    assert ctrviews["projection"] == "ctrviews"
    assert ctrviews["pctile"] is not None
    assert abs(ctrviews["axis_x"] - 366.67) < 0.01
    assert all(result["metrics"][name]["kind"] == "neighbor_axis_percentile" for name in ("ctr", "ret30", "realviews"))
    assert result["nn_cos"] == 0.9
    assert result["neighbors"][0]["id"] == "a"
    assert result["alignment"]["method"] == "video_id"
    assert result["alignment"]["archive_neighbors"] == 2
    assert result["alignment"]["map_neighbors"] == 2
    assert result["alignment"]["population"]["embedding_archive"] == scorer.id_population(archive_ids)
    assert result["alignment"]["population"]["map"] == scorer.id_population(map_ids)
    assert result["alignment"]["population"]["intersection"] == scorer.id_population(map_ids)
    assert result["alignment"]["population"]["published_generation_match"] == {
        "embedding_sha256": True,
        "embedding_etag": True,
        "intersection_video_id_sha256": True,
    }
    for metric_name, metric in result["metrics"].items():
        provenance = metric["provenance"]
        assert provenance["coordinate"] == f"long.output.together.{metric_name}"
        assert provenance["query_input"]["fingerprint_sha256"] == query_input["fingerprint_sha256"]
        assert provenance["embedding_archive_revision"]["etag"] == "embedding-etag"
        assert provenance["embedding_archive_revision"]["sha256"] == "a" * 64
        assert provenance["embedding_archive_revision"]["immutable_key"].endswith(f"{'a' * 64}.npz")
        assert provenance["map_revision"]["etag"] == "map-etag"
        assert provenance["map_revision"]["sha256"] == "b" * 64
        assert provenance["map_revision"]["immutable_key"].endswith(f"{'b' * 64}.json")
        assert provenance["video_id_alignment_population"]["intersection"] == scorer.id_population(map_ids)
        assert provenance["algorithm_generation"]["scorer"] == scorer.NEIGHBOR_ALGORITHM_GENERATION
        assert provenance["algorithm_generation"]["scorer_source_sha256"] == scorer.SCORER_SOURCE_SHA256
        assert provenance["algorithm_generation"]["map"]["id"] == "long-map-steering-v2"
        assert provenance["dataset_lineage"]["source_database_revision"]["sha256"] == "d" * 64
    with patch.object(scorer, "visual_ctrviews_exact", return_value=None):
        try:
            scorer.require_visual_ctrviews_exact(np.ones(scorer.DIM, np.float32))
            raise AssertionError("missing frozen visual scorer must fail closed")
        except RuntimeError as error:
            assert "refusing to substitute the neighbor axis" in str(error)
    lineage_text = json.dumps({
        "schemaVersion": 1,
        "populations": {
            "embeddingStore": {"rowCount": 30},
            "privateCtrFit": {"rowCount": 12},
            "curatedViewsFit": {"rowCount": 18},
            "calibrationLadder": {"rowCount": 18},
        },
        "sourceRevisions": {
            "privateRetentionTables": {
                "tyler": {"sha256": "9" * 64},
            },
        },
    }, sort_keys=True)
    lineage_sha = hashlib.sha256(lineage_text.encode()).hexdigest()
    frozen_buffer = io.BytesIO()
    np.savez_compressed(
        frozen_buffer,
        blend=np.ones(scorer.DIM, np.float32) / np.sqrt(scorer.DIM),
        ladder=np.asarray([0.0, 0.5, 1.0], np.float32),
        p90=np.float32(0.9),
        LINEAGE_JSON=np.array(lineage_text),
        LINEAGE_SHA256=np.array(lineage_sha),
    )
    frozen_bytes = frozen_buffer.getvalue()
    with (
        patch.object(scorer, "r2_get", side_effect=lambda key: frozen_bytes if key.endswith("scorer_visual.npz") else None),
        patch.object(
            scorer,
            "object_revision",
            return_value={
                "key": "longform/thumb-rl/scorer_visual.npz",
                "etag": "direct-etag",
                "version_id": "direct-version",
                "content_length": len(frozen_bytes),
            },
        ),
    ):
        exact = scorer.visual_ctrviews_exact(np.ones(scorer.DIM, np.float32))
    artifact_sha = hashlib.sha256(frozen_bytes).hexdigest()
    assert exact["artifact"] == "longform/thumb-rl/scorer_visual.npz"
    assert exact["artifact_sha256"] == artifact_sha
    assert exact["artifact_archive_key"] == f"longform/thumb-rl/by-sha256/{artifact_sha}.npz"
    assert exact["lineage_manifest_sha256"] == lineage_sha
    assert exact["lineage_schema_version"] == 1
    direct = scorer.attach_direct_query_provenance(exact, query_input)
    assert direct["provenance"]["query_input"]["fingerprint_sha256"] == query_input["fingerprint_sha256"]
    assert direct["provenance"]["artifact_revision"]["etag"] == "direct-etag"
    assert direct["provenance"]["artifact_revision"]["sha256"] == artifact_sha
    assert direct["provenance"]["dataset_lineage"]["frozen_ctr_fit_population"]["rowCount"] == 12
    assert direct["provenance"]["dataset_lineage"]["curated_views_fit_population"]["rowCount"] == 18

    canonical_metric_names = ("ctrviews", "ctr", "ret30", "views", "realviews", "gt10m")
    visual_result["metrics"]["ctrviews"] = direct
    canonical_outputs = [
        visual_result["metrics"][metric_name]
        for metric_name in canonical_metric_names
    ] + [
        result["metrics"][metric_name]
        for metric_name in canonical_metric_names
    ]
    assert len(canonical_outputs) == 12
    derived_outputs = canonical_outputs[1:]
    assert len(derived_outputs) == 11
    assert all(output["provenance"]["query_input"]["fingerprint_sha256"] == query_input["fingerprint_sha256"] for output in canonical_outputs)
    assert all(output["provenance"].get("embedding_archive_revision") for output in derived_outputs)
    assert all(output["provenance"].get("map_revision") for output in derived_outputs)
    assert all(output["provenance"].get("video_id_alignment_population") for output in derived_outputs)
    assert all(output["provenance"].get("algorithm_generation") for output in derived_outputs)

    with tempfile.TemporaryDirectory() as directory:
        image_path = os.path.join(directory, "thumbnail.jpg")
        embedding_path = os.path.join(directory, "embedding.json")
        image_bytes = b"\xff\xd8main-path-thumbnail\xff\xd9"
        with open(image_path, "wb") as handle:
            handle.write(image_bytes)
        with open(embedding_path, "w", encoding="utf8") as handle:
            json.dump({
                "visual": np.ones(scorer.DIM, np.float32).tolist(),
                "text": np.ones(scorer.DIM, np.float32).tolist(),
                "together": np.ones(scorer.DIM, np.float32).tolist(),
            }, handle)
        stdout = io.StringIO()
        with (
            patch.object(scorer, "top_neighbors", return_value=neighbors),
            patch.object(scorer, "load_map_with_revision", return_value=(raw_map, map_revision)),
            patch.object(scorer, "require_visual_ctrviews_exact", return_value=dict(exact)),
            patch.object(
                sys,
                "argv",
                [
                    "longquant_score.py",
                    "--image", image_path,
                    "--title", "Main path exact title",
                    "--emb-json", embedding_path,
                ],
            ),
            redirect_stdout(stdout),
        ):
            scorer.main()
        main_output = json.loads(stdout.getvalue())
    expected_main_query = scorer.query_input_manifest(
        image_bytes,
        "Main path exact title",
        "title",
    )
    assert main_output["input_manifest"]["query_input_fingerprint"] == expected_main_query["fingerprint_sha256"]
    assert main_output["input_manifest"]["thumbnail_sha256"] == expected_main_query["thumbnail"]["sha256"]
    assert main_output["input_manifest"]["score_text_sha256"] == expected_main_query["text"]["sha256"]
    runtime_manifest = main_output["input_manifest"]["dataset_runtime_revision"]
    assert runtime_manifest["query_input_fingerprint"] == expected_main_query["fingerprint_sha256"]
    assert set(runtime_manifest["modalities"]) == {"visual", "text", "together"}
    for modality in ("visual", "text", "together"):
        modality_revision = runtime_manifest["modalities"][modality]
        assert modality_revision["embedding_archive_revision"]["sha256"] == "a" * 64
        assert modality_revision["map_revision"]["sha256"] == "b" * 64
        assert modality_revision["dataset_lineage"]["source_database_revision"]["sha256"] == "d" * 64
    main_canonical_outputs = [
        main_output["channels"]["visual"]["metrics"][metric_name]
        for metric_name in canonical_metric_names
    ] + [
        main_output["channels"]["together"]["metrics"][metric_name]
        for metric_name in canonical_metric_names
    ]
    assert len(main_canonical_outputs) == 12
    assert all(
        output["provenance"]["query_input"]["fingerprint_sha256"]
        == expected_main_query["fingerprint_sha256"]
        for output in main_canonical_outputs
    )
    print(json.dumps({
        "ok": True,
        "channel": "together",
        "ctrviews": {
            key: value
            for key, value in ctrviews.items()
            if key != "provenance"
        },
        "metrics": sorted(result["metrics"]),
        "canonical_outputs": len(canonical_outputs),
        "neighbor_map_outputs": len(derived_outputs),
        "query_fingerprint": query_input["fingerprint_sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
