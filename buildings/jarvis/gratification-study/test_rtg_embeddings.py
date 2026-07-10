import tempfile
import unittest
from pathlib import Path

import numpy as np

from rtg_embeddings import _connect, export_npz, normalize_text, text_key


class EmbeddingCacheTests(unittest.TestCase):
    def test_key_is_whitespace_stable(self):
        self.assertEqual(text_key("a  promise\n here"), text_key("a promise here"))
        self.assertEqual(normalize_text(" a  promise\n here "), "a promise here")

    def test_sqlite_export_is_content_addressed(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            db = _connect(directory / "cache.sqlite3")
            wanted = {text_key("one"): "one", text_key("two"): "two"}
            for key, text in wanted.items():
                vector = np.zeros(1536, np.float32)
                vector[0 if text == "one" else 1] = 1.0
                db.execute(
                    "INSERT INTO embeddings VALUES (?,?,?,?,?)",
                    (key, text, "gemini-embedding-2", 1536, vector.tobytes()),
                )
            db.commit()
            path = export_npz(db, wanted, directory / "cache.npz")
            payload = np.load(path, allow_pickle=False)
            self.assertEqual(len(payload["keys"]), 2)
            self.assertEqual(payload["vecs"].shape, (2, 1536))
            db.close()


if __name__ == "__main__":
    unittest.main()
