#!/usr/bin/env python3
"""Focused regression checks for channel-specific Long Quant scoring."""
import copy
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
    class BrokenRevisionS3:
        def head_object(self, **_kwargs):
            raise RuntimeError("temporary HEAD failure")

    with patch.object(scorer, "s3", BrokenRevisionS3()):
        try:
            scorer.object_revision(
                "raw-long/visual/embeddings.npz"
            )
            raise AssertionError(
                "artifact revision failure was silently accepted"
            )
        except RuntimeError as error:
            assert "could not pin required R2 artifact revision" in str(
                error
            )

    with open(scorer.COORDINATE_GOVERNANCE_PATH, "rb") as handle:
        governance_bytes = handle.read()
    governance = json.loads(governance_bytes.decode("utf8"))
    expected_groups = tuple(governance["expansions"]["longGroups"])
    expected_metric_definitions = governance["expansions"]["longMetrics"]
    expected_metrics = tuple(metric["key"] for metric in expected_metric_definitions)
    expected_coordinates = tuple(
        governance["coordinates"]["longOutputPattern"]
        .replace("{group}", group)
        .replace("{metricKey}", metric)
        for group in expected_groups
        for metric in expected_metrics
    )
    projection_by_metric = {
        metric["key"]: metric["projectionKey"]
        for metric in expected_metric_definitions
    }
    assert expected_groups == ("visual", "text", "together")
    assert len(expected_metrics) == 7
    assert len(expected_coordinates) == len(set(expected_coordinates)) == 21
    assert scorer.LONG_GROUPS == expected_groups
    assert scorer.LONG_METRICS == expected_metrics
    assert scorer.LONG_OUTPUT_COORDINATES == expected_coordinates
    assert scorer.COORDINATE_GOVERNANCE_SHA256 == hashlib.sha256(
        governance_bytes
    ).hexdigest()

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
            "views": {"x": [180, 580, 980], "y": [100, 500, 900]},
            "outlier": {"x": [200, 600, 1000], "y": [100, 500, 900]},
            "hi10m": {"x": [220, 620, 1020], "y": [100, 500, 900]},
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
        text_result = scorer.channel_score(
            "text",
            np.ones(scorer.DIM, np.float32),
            query_input=query_input,
        )

    assert set(result["metrics"]) == set(expected_metrics)
    assert all(
        result["metrics"][name] is None
        for name in ("ctrviews", "ctr", "ret30", "realviews")
    )
    assert all(
        result["metrics"][name] is not None
        for name in ("views", "scaled_views", "gt10m")
    )
    assert set(result["map_placements"]) == set(expected_metrics)
    ctrviews_placement = result["map_placements"]["ctrviews"]
    assert ctrviews_placement["kind"] == "neighbor_axis_percentile"
    assert ctrviews_placement["projection"] == "ctrviews"
    assert ctrviews_placement["est"] is None
    assert ctrviews_placement["pctile"] is not None
    assert abs(ctrviews_placement["axis_x"] - 366.67) < 0.01
    assert all(
        placement["kind"] == "neighbor_axis_percentile"
        and placement["est"] is None
        for placement in result["map_placements"].values()
    )
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
        if metric is None:
            continue
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
    for metric_name, placement in result["map_placements"].items():
        provenance = placement["provenance"]
        projection = projection_by_metric[metric_name]
        expected_coordinate = (
            governance["coordinates"]["longMapPlacementPattern"]
            .replace("{group}", "together")
            .replace("{projectionKey}", projection)
        )
        assert provenance["coordinate"] == expected_coordinate
        assert provenance["coordinate"].startswith("long.map-placement.")
        assert not provenance["coordinate"].startswith("long.output.")
        assert placement["est"] is None
        assert provenance["query_input"]["fingerprint_sha256"] == query_input["fingerprint_sha256"]
    assert (
        visual_result["map_placements"]["ctrviews"]["provenance"]["coordinate"]
        == "long.map-placement.visual.ctrviews"
    )
    assert visual_result["metrics"]["ctrviews"] is None
    with patch.object(scorer, "visual_ctrviews_exact", return_value=None):
        try:
            scorer.require_visual_ctrviews_exact(np.ones(scorer.DIM, np.float32))
            raise AssertionError("missing frozen visual scorer must fail closed")
        except RuntimeError as error:
            assert "refusing to substitute the neighbor axis" in str(error)
    lineage = {
        "schemaVersion": 1,
        "producer": "build_thumb_assets.py",
        "producerSourceSha256": "8" * 64,
        "generatedAt": "2026-07-30T00:00:00+00:00",
        "embeddingModel": "gemini-embedding-2",
        "embeddingDimensions": scorer.DIM,
        "runtime": {"python": "fixture"},
        "algorithm": {"calibration": "fixture"},
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
    }
    lineage_text = json.dumps(
        lineage,
        sort_keys=True,
        separators=(",", ":"),
    )
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
    artifact_sha = hashlib.sha256(frozen_bytes).hexdigest()
    archive_key = (
        f"longform/thumb-rl/by-sha256/{artifact_sha}.npz"
    )
    immutable_manifest_key = (
        f"longform/thumb-rl/by-sha256/{artifact_sha}.manifest.json"
    )
    release_manifest = {
        **lineage,
        "lineageSha256": lineage_sha,
        "artifactSha256": artifact_sha,
        "canonicalKey": scorer.VISUAL_CTRVIEWS_ARTIFACT_KEY,
        "archiveKey": archive_key,
    }
    release_manifest_bytes = json.dumps(
        release_manifest,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    release_manifest_sha = hashlib.sha256(
        release_manifest_bytes
    ).hexdigest()
    release_objects = {
        scorer.VISUAL_CTRVIEWS_ARTIFACT_KEY: frozen_bytes,
        scorer.VISUAL_CTRVIEWS_MANIFEST_KEY: release_manifest_bytes,
        archive_key: frozen_bytes,
        immutable_manifest_key: release_manifest_bytes,
    }
    with (
        patch.object(
            scorer,
            "r2_get",
            side_effect=lambda key: release_objects.get(key),
        ),
        patch.object(
            scorer,
            "object_revision",
            side_effect=lambda key: {
                "key": key,
                "etag": "direct-etag",
                "version_id": "direct-version",
                "content_length": len(release_objects.get(key) or b""),
            },
        ),
    ):
        exact = scorer.visual_ctrviews_exact(np.ones(scorer.DIM, np.float32))
    assert exact["artifact"] == "longform/thumb-rl/scorer_visual.npz"
    assert exact["artifact_sha256"] == artifact_sha
    assert exact["artifact_archive_key"] == archive_key
    assert exact["release_manifest_key"] == scorer.VISUAL_CTRVIEWS_MANIFEST_KEY
    assert exact["release_manifest_sha256"] == release_manifest_sha
    assert exact["immutable_manifest_key"] == immutable_manifest_key
    assert exact["lineage_manifest_sha256"] == lineage_sha
    assert exact["lineage_schema_version"] == 1
    direct = scorer.attach_direct_query_provenance(exact, query_input)
    assert direct["provenance"]["query_input"]["fingerprint_sha256"] == query_input["fingerprint_sha256"]
    assert direct["provenance"]["artifact_revision"]["etag"] == "direct-etag"
    assert direct["provenance"]["artifact_revision"]["sha256"] == artifact_sha
    assert (
        direct["provenance"]["artifact_revision"]["manifest_sha256"]
        == release_manifest_sha
    )
    assert direct["provenance"]["dataset_lineage"]["frozen_ctr_fit_population"]["rowCount"] == 12
    assert direct["provenance"]["dataset_lineage"]["curated_views_fit_population"]["rowCount"] == 18
    assert (
        direct["provenance"]["dataset_lineage"]["release_manifest_sha256"]
        == release_manifest_sha
    )

    with patch.object(
        scorer,
        "r2_get",
        side_effect=lambda key: (
            frozen_bytes
            if key == scorer.VISUAL_CTRVIEWS_ARTIFACT_KEY
            else b'{"blend":[1],"ladder":[1]}'
            if key == "longform/thumb-rl/scorer_visual.json"
            else None
        ),
    ):
        try:
            scorer.visual_ctrviews_exact(
                np.ones(scorer.DIM, np.float32)
            )
            raise AssertionError(
                "legacy artifact without release manifest must fail closed"
            )
        except RuntimeError as error:
            assert "release manifest is missing" in str(error)

    mismatched_manifest = dict(release_manifest)
    mismatched_manifest["artifactSha256"] = "f" * 64
    bad_manifest_bytes = json.dumps(
        mismatched_manifest,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    bad_objects = {
        **release_objects,
        scorer.VISUAL_CTRVIEWS_MANIFEST_KEY: bad_manifest_bytes,
        immutable_manifest_key: bad_manifest_bytes,
    }
    with patch.object(
        scorer,
        "r2_get",
        side_effect=lambda key: bad_objects.get(key),
    ):
        try:
            scorer.visual_ctrviews_exact(
                np.ones(scorer.DIM, np.float32)
            )
            raise AssertionError("artifact hash mismatch must fail closed")
        except RuntimeError as error:
            assert "artifactSha256 mismatch" in str(error)

    substituted_manifest_objects = {
        **release_objects,
        immutable_manifest_key: release_manifest_bytes + b"\n",
    }
    with patch.object(
        scorer,
        "r2_get",
        side_effect=lambda key: substituted_manifest_objects.get(key),
    ):
        try:
            scorer.visual_ctrviews_exact(
                np.ones(scorer.DIM, np.float32)
            )
            raise AssertionError(
                "substituted immutable manifest must fail closed"
            )
        except RuntimeError as error:
            assert "immutable release manifest" in str(error)

    no_lineage_buffer = io.BytesIO()
    np.savez_compressed(
        no_lineage_buffer,
        blend=np.ones(scorer.DIM, np.float32),
        ladder=np.asarray([0.0, 1.0], np.float32),
    )
    no_lineage_bytes = no_lineage_buffer.getvalue()
    no_lineage_sha = hashlib.sha256(no_lineage_bytes).hexdigest()
    no_lineage_archive = (
        f"longform/thumb-rl/by-sha256/{no_lineage_sha}.npz"
    )
    no_lineage_manifest_key = (
        f"longform/thumb-rl/by-sha256/{no_lineage_sha}.manifest.json"
    )
    no_lineage_release = {
        **lineage,
        "lineageSha256": lineage_sha,
        "artifactSha256": no_lineage_sha,
        "canonicalKey": scorer.VISUAL_CTRVIEWS_ARTIFACT_KEY,
        "archiveKey": no_lineage_archive,
    }
    no_lineage_manifest = json.dumps(
        no_lineage_release,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    no_lineage_objects = {
        scorer.VISUAL_CTRVIEWS_ARTIFACT_KEY: no_lineage_bytes,
        scorer.VISUAL_CTRVIEWS_MANIFEST_KEY: no_lineage_manifest,
        no_lineage_archive: no_lineage_bytes,
        no_lineage_manifest_key: no_lineage_manifest,
    }
    with patch.object(
        scorer,
        "r2_get",
        side_effect=lambda key: no_lineage_objects.get(key),
    ):
        try:
            scorer.visual_ctrviews_exact(
                np.ones(scorer.DIM, np.float32)
            )
            raise AssertionError("artifact without lineage must fail closed")
        except RuntimeError as error:
            assert "lacks required lineage arrays" in str(error)

    pre_direct_ledger = scorer.build_long_score_ledger({
        "visual": visual_result,
        "together": result,
    })
    pre_direct_by_id = {
        entry["coordinate_id"]: entry
        for entry in pre_direct_ledger["entries"]
    }
    assert pre_direct_ledger["coordinate_ids"] == list(expected_coordinates)
    assert len(pre_direct_ledger["entries"]) == 21
    assert pre_direct_ledger["available_count"] == 6
    assert pre_direct_ledger["schema_complete"] is True
    assert pre_direct_ledger["all_values_available"] is False
    assert pre_direct_ledger["contract_valid"] is True
    assert pre_direct_ledger["producer_errors"] == []
    for metric_name in expected_metrics:
        entry = pre_direct_by_id[f"long.output.text.{metric_name}"]
        assert entry["available"] is False
        assert entry["value"] is None
        assert entry["unavailable_reason"] == "input_channel_not_scored"
    for group in ("visual", "together"):
        for metric_name in ("ctrviews", "ctr", "ret30", "realviews"):
            entry = pre_direct_by_id[f"long.output.{group}.{metric_name}"]
            assert entry["available"] is False
            assert entry["value"] is None
            assert entry["unavailable_reason"] == "scalar_estimate_not_materialized"
            assert metric_name in (
                visual_result if group == "visual" else result
            )["map_placements"]

    nonfinite_result = copy.deepcopy(result)
    nonfinite_result["metrics"]["ctr"] = {
        "est": None,
        "pctile": 88,
        "kind": "nonfinite-fixture",
        "provenance": {"coordinate": "long.output.together.ctr"},
    }
    nonfinite_ledger = scorer.build_long_score_ledger({
        "together": nonfinite_result,
    })
    nonfinite_entry = next(
        entry
        for entry in nonfinite_ledger["entries"]
        if entry["coordinate_id"] == "long.output.together.ctr"
    )
    assert nonfinite_entry["available"] is False
    assert nonfinite_entry["value"] is None
    assert nonfinite_entry["unavailable_reason"] == "scalar_estimate_not_finite"
    assert nonfinite_ledger["contract_valid"] is True

    invalid_result = copy.deepcopy(result)
    invalid_result["metrics"]["views"]["provenance"]["coordinate"] = (
        "long.map-placement.together.views"
    )
    invalid_ledger = scorer.build_long_score_ledger({
        "together": invalid_result,
    })
    assert invalid_ledger["contract_valid"] is False
    assert any(
        "provenance coordinate 'long.map-placement.together.views' does not match"
        in error
        for error in invalid_ledger["producer_errors"]
    )

    visual_result["metrics"]["ctrviews"] = direct
    canonical_ledger = scorer.build_long_score_ledger({
        "visual": visual_result,
        "together": result,
    })
    registered_pctile, registered_aliases = scorer.score_alias_contract(
        canonical_ledger,
        "long.output.visual.ctrviews",
        ("pctile", "visual_pctile", "thumbnail_potential"),
        "thumbnail_threshold_and_rewards",
        True,
    )
    assert registered_pctile == round(float(direct["pctile"]) / 100.0, 4)
    assert registered_aliases["schema"] == scorer.LONG_SCORE_ALIAS_SCHEMA
    assert (
        registered_aliases["canonical_coordinate_id"]
        == "long.output.visual.ctrviews"
    )
    assert set(registered_aliases["compatibility_aliases"]) == {
        "pctile",
        "visual_pctile",
        "thumbnail_potential",
    }
    invalid_alias_ledger = copy.deepcopy(canonical_ledger)
    invalid_alias_ledger["contract_valid"] = False
    assert scorer.score_alias_contract(
        invalid_alias_ledger,
        "long.output.visual.ctrviews",
        ("pctile",),
        "thumbnail_threshold_and_rewards",
        True,
    )[0] is None
    canonical_outputs = [
        entry
        for entry in canonical_ledger["entries"]
        if entry["available"]
    ]
    assert len(canonical_outputs) == canonical_ledger["available_count"] == 7
    assert canonical_ledger["expected_count"] == 21
    assert canonical_ledger["contract_valid"] is True
    assert canonical_ledger["all_values_available"] is False
    assert all(
        output["coordinate_id"].startswith("long.output.")
        and output["provenance"]["coordinate"] == output["coordinate_id"]
        and output["provenance"]["query_input"]["fingerprint_sha256"]
        == query_input["fingerprint_sha256"]
        for output in canonical_outputs
    )
    derived_outputs = [
        output
        for output in canonical_outputs
        if output["coordinate_id"] != "long.output.visual.ctrviews"
    ]
    assert len(derived_outputs) == 6
    assert all(output["provenance"].get("embedding_archive_revision") for output in derived_outputs)
    assert all(output["provenance"].get("map_revision") for output in derived_outputs)
    assert all(output["provenance"].get("video_id_alignment_population") for output in derived_outputs)
    assert all(output["provenance"].get("algorithm_generation") for output in derived_outputs)
    assert not any(
        coordinate.startswith("long.map-placement.")
        for coordinate in canonical_ledger["values_by_id"]
    )

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
            try:
                scorer.main()
            except TypeError as error:
                raise AssertionError(
                    "Long score output must be JSON serializable; "
                    "ledger availability flags must be native booleans"
                ) from error
        main_output = json.loads(stdout.getvalue())
    expected_main_query = scorer.query_input_manifest(
        image_bytes,
        "Main path exact title",
        "title",
    )
    assert main_output["input_manifest"]["query_input_fingerprint"] == expected_main_query["fingerprint_sha256"]
    assert main_output["input_manifest"]["thumbnail_sha256"] == expected_main_query["thumbnail"]["sha256"]
    assert main_output["input_manifest"]["score_text_sha256"] == expected_main_query["text"]["sha256"]
    assert (
        main_output["input_manifest"]["coordinate_governance_schema_version"]
        == governance["schemaVersion"]
    )
    assert (
        main_output["input_manifest"]["coordinate_governance_sha256"]
        == scorer.COORDINATE_GOVERNANCE_SHA256
    )
    assert (
        main_output["input_manifest"]["visual_ctrviews_release_manifest_key"]
        == scorer.VISUAL_CTRVIEWS_MANIFEST_KEY
    )
    assert (
        main_output["input_manifest"]["visual_ctrviews_release_manifest_sha256"]
        == release_manifest_sha
    )
    assert (
        main_output["input_manifest"]["visual_ctrviews_immutable_manifest_key"]
        == immutable_manifest_key
    )
    runtime_manifest = main_output["input_manifest"]["dataset_runtime_revision"]
    assert runtime_manifest["query_input_fingerprint"] == expected_main_query["fingerprint_sha256"]
    assert set(runtime_manifest["modalities"]) == {"visual", "text", "together"}
    for modality in ("visual", "text", "together"):
        modality_revision = runtime_manifest["modalities"][modality]
        assert modality_revision["embedding_archive_revision"]["sha256"] == "a" * 64
        assert modality_revision["map_revision"]["sha256"] == "b" * 64
        assert modality_revision["dataset_lineage"]["source_database_revision"]["sha256"] == "d" * 64
    main_ledger = main_output["long_score_ledger"]
    assert main_output["score_alias_contract"] == {
        "schema": scorer.LONG_SCORE_ALIAS_SCHEMA,
        "canonical_coordinate_id": "long.output.visual.ctrviews",
        "canonical_field": "percentile",
        "canonical_value": main_output["pctile"],
        "decision_use": "thumbnail_threshold_and_rewards",
        "decision_eligible": True,
        "compatibility_aliases": {
            alias: {
                "coordinate_id": "long.output.visual.ctrviews",
                "field": "percentile",
            }
            for alias in ("pctile", "visual_pctile", "thumbnail_potential")
        },
    }
    assert (
        main_output["pctile"]
        == main_output["visual_pctile"]
        == main_output["thumbnail_potential"]
        == main_output["score_alias_contract"]["canonical_value"]
    )
    assert main_ledger["coordinate_ids"] == list(expected_coordinates)
    assert len(main_ledger["entries"]) == 21
    assert main_ledger["expected_count"] == 21
    assert main_ledger["available_count"] == 10
    assert main_ledger["schema_complete"] is True
    assert main_ledger["all_values_available"] is False
    assert main_ledger["producer_errors"] == []
    assert main_ledger["contract_valid"] is True
    main_canonical_outputs = [
        entry for entry in main_ledger["entries"] if entry["available"]
    ]
    assert len(main_canonical_outputs) == 10
    assert all(
        output["provenance"]["query_input"]["fingerprint_sha256"]
        == expected_main_query["fingerprint_sha256"]
        for output in main_canonical_outputs
    )
    main_unavailable = [
        entry for entry in main_ledger["entries"] if not entry["available"]
    ]
    assert len(main_unavailable) == 11
    assert all(
        entry["value"] is None
        and entry["unavailable_reason"] == "scalar_estimate_not_materialized"
        for entry in main_unavailable
    )
    for group in expected_groups:
        channel_output = main_output["channels"][group]
        assert set(channel_output["metrics"]) == set(expected_metrics)
        assert set(channel_output["map_placements"]) == set(expected_metrics)
        for metric_name, placement in channel_output["map_placements"].items():
            projection = projection_by_metric[metric_name]
            assert placement["est"] is None
            assert (
                placement["provenance"]["coordinate"]
                == f"long.map-placement.{group}.{projection}"
            )
            assert placement["provenance"]["coordinate"] not in main_ledger["values_by_id"]
    print(json.dumps({
        "ok": True,
        "channel": "together",
        "ctrviews_map_placement": {
            key: value
            for key, value in ctrviews_placement.items()
            if key != "provenance"
        },
        "metrics": sorted(result["metrics"]),
        "scalar_ledger": {
            "expected": canonical_ledger["expected_count"],
            "available": canonical_ledger["available_count"],
            "main_available": main_ledger["available_count"],
        },
        "map_placements": len(result["map_placements"]),
        "derived_scalar_outputs": len(derived_outputs),
        "query_fingerprint": query_input["fingerprint_sha256"],
    }, indent=2))


if __name__ == "__main__":
    main()
