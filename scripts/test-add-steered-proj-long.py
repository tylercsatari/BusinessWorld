#!/usr/bin/env python3
"""Focused publication test for immutable Long Quant map/model generations."""

import contextlib
import hashlib
import io
import json
import os
import runpy
import sys
from pathlib import Path
from unittest.mock import patch

import boto3
import numpy as np


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def canonical_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf8")


def sha256(value):
    return hashlib.sha256(value).hexdigest()


class MemoryS3:
    def __init__(self, objects):
        self.objects = dict(objects)
        self.metadata = {key: {} for key in objects}

    def _etag(self, key):
        return sha256(self.objects[key])[:32]

    def get_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise KeyError(Key)
        return {
            "Body": io.BytesIO(self.objects[Key]),
            "ETag": f'"{self._etag(Key)}"',
        }

    def head_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise KeyError(Key)
        return {
            "ETag": f'"{self._etag(Key)}"',
            "ContentLength": len(self.objects[Key]),
            "Metadata": self.metadata.get(Key, {}),
        }

    def put_object(self, Bucket, Key, Body, ContentType, Metadata):
        del Bucket, ContentType
        self.objects[Key] = bytes(Body)
        self.metadata[Key] = dict(Metadata or {})
        return {"ETag": f'"{self._etag(Key)}"'}

    def delete_object(self, Bucket, Key):
        del Bucket
        self.objects.pop(Key, None)
        self.metadata.pop(Key, None)


def fixture_objects():
    rng = np.random.default_rng(7)
    ids = [f"video-{index:02d}" for index in range(15)]
    views = [int(150_000 * (index + 1) ** 1.7) for index in range(len(ids))]
    videos = []
    database = {}
    for index, video_id in enumerate(ids):
        duration = 120 + index * 11
        videos.append({
            "id": video_id,
            "ctr": 3.5 + index * 0.23 + (index % 3) * 0.07,
            "ret30": 42 + index * 1.8 + (index % 4) * 0.4,
            "avg_retention": 55 + index,
            "duration_s": duration,
            "views": views[index],
        })
        database[video_id] = {
            "videoId": video_id,
            "durationSec": duration,
        }

    objects = {
        "longform/channels.json": canonical_bytes({
            "channels": [{"id": "tyler", "name": "Main"}],
        }),
        "longform/ret_tyler.json": canonical_bytes({"videos": videos}),
        "longform/db.json": canonical_bytes({"videos": database}),
        "longform/thumb-rl/scorer_visual.manifest.json": canonical_bytes({
            "schemaVersion": 1,
            "canonicalKey": "longform/thumb-rl/scorer_visual.npz",
            "artifactSha256": "f" * 64,
            "archiveKey": f"longform/thumb-rl/by-sha256/{'f' * 64}.npz",
            "lineageSha256": "e" * 64,
            "populations": {
                "embeddingStore": {"rowCount": 15, "videoIdSha256": "a" * 64},
                "privateCtrFit": {"rowCount": 15, "videoIdSha256": "b" * 64},
                "curatedViewsFit": {"rowCount": 12, "videoIdSha256": "c" * 64},
                "calibrationLadder": {"rowCount": 12, "videoIdSha256": "c" * 64},
            },
            "sourceRevisions": {
                "curatedIds": {"sha256": "d" * 64},
            },
        }),
    }
    base_x = [round(index * 1000 / (len(ids) - 1)) for index in range(len(ids))]
    base_y = list(reversed(base_x))
    for channel_index, channel in enumerate(("visual", "text", "together")):
        vectors = rng.normal(size=(len(ids), 8)).astype(np.float32)
        vectors += np.linspace(0, 1 + channel_index * 0.1, len(ids), dtype=np.float32)[:, None]
        archive = io.BytesIO()
        np.savez_compressed(
            archive,
            ids=np.asarray(ids, dtype=object),
            vecs=vectors,
        )
        objects[f"raw-long/{channel}/embeddings.npz"] = archive.getvalue()
        objects[f"raw-long/{channel}/map.json"] = canonical_bytes({
            "n": len(ids),
            "id": ids,
            "title": [f"Fixture {index}" for index in range(len(ids))],
            "views": views,
            "outlier": [round(value / 100_000, 3) for value in views],
            "proj": {
                "views": {"x": base_x, "y": base_y, "cv": 0.1, "co": 0.2},
                "hi10m": {"x": base_x, "y": base_y, "cv": 0.1, "co": 0.2},
                "outlier": {"x": base_x, "y": base_y, "cv": 0.1, "co": 0.2},
            },
        })
    return objects


def main():
    store = MemoryS3(fixture_objects())
    environment = {
        "R2_ACCOUNT_ID": "fixture-account",
        "R2_ACCESS_KEY_ID": "fixture-access",
        "R2_SECRET_ACCESS_KEY": "fixture-secret",
        "R2_BUCKET_NAME": "fixture-bucket",
    }
    with (
        patch.object(boto3, "client", return_value=store),
        patch.dict(os.environ, environment, clear=False),
        contextlib.redirect_stdout(io.StringIO()),
    ):
        runpy.run_path(str(ROOT / "add_steered_proj_long.py"), run_name="__main__")

    model_bytes = store.objects["raw-long/steer_models.npz"]
    model_sha256 = sha256(model_bytes)
    model_immutable_key = f"raw-long/models/by-sha256/{model_sha256}.npz"
    assert store.objects[model_immutable_key] == model_bytes
    model_pointer = json.loads(store.objects["raw-long/steer_models.manifest.json"])
    assert model_pointer["model_artifact"]["sha256"] == model_sha256
    assert model_pointer["model_artifact"]["immutable_key"] == model_immutable_key
    assert model_pointer["algorithm_generation"] == "long-map-steering-v2"
    immutable_model_manifest = store.objects[model_pointer["immutable_manifest_key"]]
    assert sha256(immutable_model_manifest) == model_pointer["manifest_sha256"]
    label_bytes = store.objects["longform/ret_tyler.json"]
    label_sha256 = sha256(label_bytes)
    label_immutable_key = (
        f"longform/source-snapshots/private-labels/tyler/by-sha256/"
        f"{label_sha256}.json"
    )
    assert store.objects[label_immutable_key] == label_bytes
    database_bytes = store.objects["longform/db.json"]
    database_sha256 = sha256(database_bytes)
    database_immutable_key = (
        f"longform/source-snapshots/database/by-sha256/"
        f"{database_sha256}.json"
    )
    assert store.objects[database_immutable_key] == database_bytes

    for channel in ("visual", "text", "together"):
        embedding_bytes = store.objects[f"raw-long/{channel}/embeddings.npz"]
        embedding_sha256 = sha256(embedding_bytes)
        embedding_immutable_key = (
            f"raw-long/{channel}/embeddings/by-sha256/{embedding_sha256}.npz"
        )
        assert store.objects[embedding_immutable_key] == embedding_bytes

        map_bytes = store.objects[f"raw-long/{channel}/map.json"]
        map_sha256 = sha256(map_bytes)
        map_immutable_key = f"raw-long/{channel}/maps/by-sha256/{map_sha256}.json"
        assert store.objects[map_immutable_key] == map_bytes
        mapping = json.loads(map_bytes)
        provenance = mapping["_provenance"]
        assert provenance["algorithm_generation"]["id"] == "long-map-steering-v2"
        assert len(provenance["algorithm_generation"]["generator_source_sha256"]) == 64
        assert provenance["embedding_archive"]["sha256"] == embedding_sha256
        assert provenance["embedding_archive"]["immutable_key"] == embedding_immutable_key
        assert provenance["model_artifact"]["sha256"] == model_sha256
        assert provenance["video_id_alignment_population"]["intersection"]["row_count"] == 15
        assert provenance["video_id_alignment_population"]["map_only"]["row_count"] == 0
        private_fits = provenance["account_metric_private_fit_populations"]["tyler"]
        assert private_fits["label_snapshot_revision"]["sha256"] == label_sha256
        assert private_fits["label_snapshot_revision"]["immutable_key"] == label_immutable_key
        assert private_fits["metrics"]["ctr"]["fit_population"]["row_count"] == 15
        assert private_fits["metrics"]["ret30"]["fit_population"]["row_count"] == 15
        assert private_fits["metrics"]["realviews"]["private_view_equation_fit_population"]["row_count"] == 15
        assert private_fits["metrics"]["realviews"]["projection_fit_population"]["row_count"] == 15
        assert private_fits["metrics"]["ctrviews"]["private_ctr_fit_population"]["row_count"] == 15
        assert private_fits["metrics"]["ctrviews"]["views_direction_fit_population"]["row_count"] == 15
        assert provenance["source_database_revision"]["sha256"] == database_sha256
        assert provenance["source_database_revision"]["immutable_key"] == database_immutable_key

        pointer = json.loads(store.objects[f"raw-long/{channel}/map.manifest.json"])
        assert pointer["map_artifact"]["sha256"] == map_sha256
        assert pointer["map_artifact"]["immutable_key"] == map_immutable_key
        assert pointer["embedding_archive"]["mutable_etag"]
        assert pointer["map_artifact"]["mutable_etag"]
        assert pointer["account_metric_private_fit_populations"] == provenance["account_metric_private_fit_populations"]
        assert pointer["label_snapshot_revisions"]["tyler"]["sha256"] == label_sha256
        assert pointer["source_database_revision"]["sha256"] == database_sha256
        assert pointer["source_database_revision"]["mutable_etag"]
        assert pointer["source_database_revision"]["immutable_key"] == database_immutable_key
        assert pointer["frozen_visual_ctrviews_lineage"]["frozen_ctr_fit_population"]["rowCount"] == 15
        assert pointer["frozen_visual_ctrviews_lineage"]["curated_views_fit_population"]["rowCount"] == 12
        immutable_manifest = store.objects[pointer["immutable_manifest_key"]]
        assert sha256(immutable_manifest) == pointer["manifest_sha256"]

    print(json.dumps({
        "ok": True,
        "channels": 3,
        "immutable_maps": 3,
        "immutable_embedding_archives": 3,
        "immutable_model": model_immutable_key,
    }))


if __name__ == "__main__":
    main()
