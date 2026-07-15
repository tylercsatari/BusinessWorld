import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from embedding_store import EmbeddingStore, _retry_delay_seconds


class FakeResponse:
    def __init__(self, payload=None, headers=None):
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self):
        return self._payload


class EmbeddingStoreRetryTest(unittest.TestCase):
    def test_retry_after_header_wins(self):
        response = FakeResponse(headers={"retry-after": "7.5"})
        self.assertEqual(_retry_delay_seconds(response, 0), 7.5)

    def test_google_retry_info_is_parsed(self):
        response = FakeResponse({
            "error": {"details": [{"retryDelay": "41.25s"}]},
        })
        self.assertEqual(_retry_delay_seconds(response, 0), 41.25)

    def test_google_message_delay_is_parsed(self):
        response = FakeResponse({
            "error": {"message": "Quota exceeded. Please retry in 19.75s."},
        })
        self.assertEqual(_retry_delay_seconds(response, 0), 19.75)

    def test_fallback_is_bounded(self):
        response = FakeResponse()
        self.assertEqual(_retry_delay_seconds(response, 20), 60.0)

    def test_parallel_cached_reads_share_the_connection_safely(self):
        with TemporaryDirectory() as directory:
            store = EmbeddingStore(
                Path(directory) / "vectors.sqlite3", dimensions=4,
            )
            texts = [f"cached text {index}" for index in range(12)]
            vectors = [np.full(4, index, np.float32) for index in range(12)]
            store._save(texts, vectors)
            try:
                with ThreadPoolExecutor(max_workers=8) as pool:
                    results = list(pool.map(
                        lambda _: store.embed_many(texts), range(80),
                    ))
                self.assertTrue(all(len(result) == len(texts) for result in results))
                self.assertTrue(all(
                    np.array_equal(result[texts[7]], vectors[7])
                    for result in results
                ))
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
