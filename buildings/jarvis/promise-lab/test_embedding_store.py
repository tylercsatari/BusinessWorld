import unittest

from embedding_store import _retry_delay_seconds


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


if __name__ == "__main__":
    unittest.main()
