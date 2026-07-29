import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))

import longquant_score


class _ArchiveStore:
    def __init__(self, archive: Path):
        self.archive = archive

    def head_object(self, **_kwargs):
        return {"ETag": '"test-revision"'}

    def download_file(self, _bucket, _key, destination):
        shutil.copyfile(self.archive, destination)


class _ObjectStore:
    def __init__(self, objects):
        self.objects = dict(objects)

    def _etag(self, key):
        return hashlib.sha256(self.objects[key]).hexdigest()[:32]

    def head_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise KeyError(Key)
        return {
            "ETag": f'"{self._etag(Key)}"',
            "ContentLength": len(self.objects[Key]),
        }

    def download_file(self, Bucket, Key, destination):
        del Bucket
        Path(destination).write_bytes(self.objects[Key])

    def get_object(self, Bucket, Key):
        del Bucket
        return {"Body": io.BytesIO(self.objects[Key])}


class LongQuantArchiveTests(unittest.TestCase):
    def write_archive(self, path: Path, *, view_count: int = 2) -> None:
        np.savez_compressed(
            path,
            ids=np.asarray(["video-a", "video-b"], dtype=object),
            vecs=np.asarray([[1, 0], [0, 1]], dtype=np.float32),
            views=np.asarray([100, 200][:view_count], dtype=np.float32),
        )

    def test_row_aligned_archive_supports_object_ids_and_numeric_memmaps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.npz"
            self.write_archive(archive)
            with (
                patch.object(longquant_score, "s3", _ArchiveStore(archive)),
                patch.object(longquant_score.tempfile, "gettempdir", return_value=directory),
            ):
                arrays, revision = longquant_score.cache_arrays_with_revision(
                    "text", ("vecs", "ids", "views"),
                )
            self.assertEqual(arrays["ids"].tolist(), ["video-a", "video-b"])
            self.assertIsInstance(arrays["vecs"], np.memmap)
            self.assertIsInstance(arrays["views"], np.memmap)
            archive_sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(revision["etag"], "test-revision")
            self.assertEqual(revision["sha256"], archive_sha256)
            self.assertEqual(
                revision["immutable_key"],
                f"raw-long/text/embeddings/by-sha256/{archive_sha256}.npz",
            )
            self.assertEqual(
                revision["video_id_population"],
                longquant_score.id_population(["video-a", "video-b"]),
            )

    def test_row_count_mismatch_fails_instead_of_truncating(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.npz"
            self.write_archive(archive, view_count=1)
            with (
                patch.object(longquant_score, "s3", _ArchiveStore(archive)),
                patch.object(longquant_score.tempfile, "gettempdir", return_value=directory),
            ):
                with self.assertRaisesRegex(RuntimeError, "row mismatch"):
                    longquant_score.cache_arrays("text", ("vecs", "ids", "views"))

    def test_map_revision_resolves_content_addressed_generation_manifest(self):
        mapping = {
            "id": ["video-a", "video-b"],
            "proj": {},
            "_provenance": {
                "generation_id": "generation-1",
                "algorithm_generation": {"id": "long-map-steering-v2"},
                "manifest_key": "raw-long/text/map.manifest.json",
                "embedding_archive": {"sha256": "a" * 64},
                "video_id_alignment_population": {
                    "intersection": longquant_score.id_population(["video-a", "video-b"]),
                },
                "account_metric_private_fit_populations": {
                    "tyler": {
                        "label_snapshot_revision": {"sha256": "d" * 64},
                        "metrics": {
                            "ctr": {
                                "fit_population": longquant_score.id_population(
                                    ["video-a", "video-b"]
                                ),
                            },
                        },
                    },
                },
                "source_database_revision": {"sha256": "e" * 64},
            },
        }
        map_bytes = json.dumps(
            mapping,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        map_sha256 = hashlib.sha256(map_bytes).hexdigest()
        manifest = {
            "generation_id": "generation-1",
            "manifest_sha256": "c" * 64,
            "immutable_manifest_key": f"raw-long/text/manifests/by-sha256/{'c' * 64}.json",
            "map_artifact": {
                "sha256": map_sha256,
                "immutable_key": f"raw-long/text/maps/by-sha256/{map_sha256}.json",
            },
            "account_metric_private_fit_populations": (
                mapping["_provenance"]["account_metric_private_fit_populations"]
            ),
            "source_database_revision": {"sha256": "e" * 64},
        }
        store = _ObjectStore({
            "raw-long/text/map.json": map_bytes,
            "raw-long/text/map.manifest.json": json.dumps(manifest).encode(),
        })
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(longquant_score, "s3", store),
                patch.object(longquant_score.tempfile, "gettempdir", return_value=directory),
            ):
                loaded, revision = longquant_score.load_map_with_revision("text")
        self.assertEqual(loaded["id"], ["video-a", "video-b"])
        self.assertEqual(revision["sha256"], map_sha256)
        self.assertEqual(
            revision["immutable_key"],
            f"raw-long/text/maps/by-sha256/{map_sha256}.json",
        )
        self.assertEqual(revision["algorithm_generation"]["id"], "long-map-steering-v2")
        self.assertTrue(revision["generation_manifest"]["matches_loaded_map"])
        self.assertEqual(
            revision["published_dataset_lineage"]["source_database_revision"]["sha256"],
            "e" * 64,
        )
        self.assertEqual(
            revision["published_dataset_lineage"][
                "account_metric_private_fit_populations"
            ]["tyler"]["label_snapshot_revision"]["sha256"],
            "d" * 64,
        )
        self.assertEqual(
            revision["generation_manifest"]["immutable_manifest_key"],
            manifest["immutable_manifest_key"],
        )


if __name__ == "__main__":
    unittest.main()
