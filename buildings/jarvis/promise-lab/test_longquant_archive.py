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
                arrays = longquant_score.cache_arrays(
                    "text", ("vecs", "ids", "views"),
                )
            self.assertEqual(arrays["ids"].tolist(), ["video-a", "video-b"])
            self.assertIsInstance(arrays["vecs"], np.memmap)
            self.assertIsInstance(arrays["views"], np.memmap)

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


if __name__ == "__main__":
    unittest.main()
