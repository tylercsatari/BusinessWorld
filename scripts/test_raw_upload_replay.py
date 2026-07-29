#!/usr/bin/env python3
"""Focused deterministic replay tests for raw_upload.py.

No network, Gemini, ffmpeg, or real R2 credentials are used. The fake score has the
same 18 steer + 3 novelty-coordinate inputs as the production 21-output contract.
"""
import base64
import importlib.util
import inspect
import io
import json
import os


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = importlib.util.spec_from_file_location('raw_upload_replay_test_subject', os.path.join(ROOT, 'raw_upload.py'))
RAW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RAW)


class FakeS3Error(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.response = {'Error': {'Code': code, 'Message': message}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.fail_reads = False
        self.fail_writes = False

    def get_object(self, Bucket, Key):
        if self.fail_reads:
            raise FakeS3Error('ServiceUnavailable', 'simulated R2 read outage')
        if Key not in self.objects:
            raise FakeS3Error('NoSuchKey', Key)
        return {'Body': io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, **kwargs):
        if self.fail_writes:
            raise FakeS3Error('ServiceUnavailable', 'simulated R2 write outage')
        self.objects[Key] = bytes(Body)
        return {'ETag': '"fake-cache-etag"'}


def revisions(suffix='a'):
    return {
        'schema': 'shorts-score-revisions-v1',
        'scorer': {'name': 'raw_upload.py', 'sha256': f'scorer-{suffix}'},
        'models': {
            'embedding': {'name': RAW.EMBEDDING_MODEL, 'dimensions': RAW.DIM, 'endpoint': RAW.EMB_URL},
            'transcription': {'name': RAW.TRANSCRIPTION_MODEL, 'decoding': 'temperature=0,topP=1,topK=1'},
        },
        'runtime': {'python': 'test', 'numpy': 'test'},
        'artifacts': {
            key: {'state': 'present', 'etag': f'{key}-{suffix}', 'version_id': '', 'size': 123}
            for key in RAW.SCORE_REVISION_KEYS
        },
    }


def canonical_score(seed=1):
    targets = ('keep', 'ret5', 'views', 'realviews', 'outlier', 'gt10M')
    steer = {}
    n = seed
    for modality in ('visual', 'text', 'together'):
        for target in targets:
            steer[f'{modality}_{target}'] = {
                'est': float(n),
                'pctile': float((n * 7) % 100),
                'kind': 'pct',
            }
            n += 1
    indicators = {
        'nov_visual_global_keep': 0.1111 + seed,
        'nov_visual_global_ret5': 0.2222 + seed,
        'nov_visual_global_views': 0.3333 + seed,
    }
    assert len(steer) + len(indicators) == 21
    return {
        'indicators': indicators,
        'steer': steer,
        'emb_preview': {
            'visual': [0.1, 0.2],
            'text': [0.3, 0.4],
            'together': [0.5, 0.6],
        },
        'steer_artifact_sha256': f'steer-artifact-{seed}',
        'steer_artifact_archive_key': f'raw/steer_models/by-sha256/steer-artifact-{seed}.npz',
        'steer_lineage_manifest_sha256': f'steer-lineage-{seed}',
        'steer_lineage_schema_version': 1,
        'channels': {
            'visual': {'neighbors': [{'id': 'visual-neighbor', 'sim': 0.9}]},
            'text': {'neighbors': [{'id': 'text-neighbor', 'sim': 0.8}]},
            'together': {'neighbors': [{'id': 'together-neighbor', 'sim': 0.85}]},
        },
    }


def score_once(fake_s3, calls, montage, transcript, used, duration, revision_state, seed=1):
    RAW.s3 = fake_s3
    replay = RAW._score_replay_prepare(montage, transcript, used, duration, revisions=revision_state)
    if replay['score'] is not None:
        return replay['score'], replay['meta']
    calls['embedding'] += 3
    score = canonical_score(seed)
    return score, RAW._score_replay_store(replay, score)


def test_cache_hit_skips_all_embedding_calls():
    fake_s3 = FakeS3()
    calls = {'embedding': 0}
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    revision_state = revisions()

    first_score, first_meta = score_once(
        fake_s3, calls, montage, 'This  turned\nout better than expected.', True, 12.3454, revision_state)
    assert calls['embedding'] == 3
    assert first_meta['cache_status'] == 'miss'
    assert first_meta['cache_write_status'] == 'stored'

    replay_score, replay_meta = score_once(
        fake_s3, calls, montage, '  This turned out better than expected.  ', True, 12.34539, revision_state)
    assert calls['embedding'] == 3, 'a replay hit invoked the embedding path'
    assert replay_meta['cache_status'] == 'hit'
    assert replay_meta['cache_write_status'] == 'not_attempted'
    assert replay_score == first_score
    assert replay_meta['input_fingerprint'] == first_meta['input_fingerprint']
    assert replay_meta['revision_fingerprint'] == first_meta['revision_fingerprint']
    assert replay_meta['output_fingerprint'] == first_meta['output_fingerprint']

    output = RAW._score_output({}, 'Replay test', montage, RAW.normalize_transcript(
        'This turned out better than expected.'), True, 12.3454, replay_score, replay_meta)
    manifest = output['input_manifest']
    assert manifest['cache_key'] == replay_meta['cache_key']
    assert manifest['cache_status'] == 'hit'
    assert manifest['input_fingerprint'] == replay_meta['input_fingerprint']
    assert manifest['revision_fingerprint'] == replay_meta['revision_fingerprint']
    assert manifest['output_fingerprint'] == replay_meta['output_fingerprint']
    assert manifest['scorer_revisions'] == revision_state
    assert manifest['canonical_output_contract']['total'] == 21
    assert manifest['steer_artifact_archive_key'].endswith('steer-artifact-1.npz')
    assert manifest['steer_lineage_manifest_sha256'] == 'steer-lineage-1'
    assert manifest['steer_lineage_schema_version'] == 1
    with open(os.path.join(ROOT, 'buildings', 'jarvis', 'saved-channel-feature-contract.json'), encoding='utf-8') as handle:
        contract = json.load(handle)
    assert manifest['display_contract_version'] == contract['version']


def test_input_and_revision_changes_invalidate_replay():
    fake_s3 = FakeS3()
    calls = {'embedding': 0}
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    rev_a = revisions('a')

    score_once(fake_s3, calls, montage, 'same words', True, 8.0, rev_a, seed=1)
    score_once(fake_s3, calls, montage, 'same words', True, 9.0, rev_a, seed=2)
    score_once(fake_s3, calls, montage, 'same words', False, 8.0, rev_a, seed=3)
    score_once(fake_s3, calls, montage, 'same words', True, 8.0, revisions('b'), seed=4)
    score_once(fake_s3, calls, base64.b64encode(b'different-montage').decode(), 'same words', True, 8.0, rev_a, seed=5)

    assert calls['embedding'] == 15, 'duration, channel state, revisions, or montage failed to invalidate replay'


def test_cache_failures_fall_through_without_hiding_scores():
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    revision_state = revisions()

    read_failure = FakeS3()
    read_failure.fail_reads = True
    RAW.s3 = read_failure
    replay = RAW._score_replay_prepare(montage, 'hook', True, 5, revisions=revision_state)
    assert replay['score'] is None
    assert replay['meta']['cache_status'] == 'read_error'
    score = canonical_score()
    meta = RAW._score_replay_store(replay, score)
    assert meta['cache_write_status'] == 'stored'
    assert meta['output_fingerprint'] == RAW._score_output_fingerprint(score)

    write_failure = FakeS3()
    write_failure.fail_writes = True
    RAW.s3 = write_failure
    replay = RAW._score_replay_prepare(montage, 'hook', True, 5, revisions=revision_state)
    meta = RAW._score_replay_store(replay, score)
    assert meta['cache_status'] == 'miss'
    assert meta['cache_write_status'] == 'write_error'
    assert 'simulated R2 write outage' in meta['cache_error']
    assert meta['output_fingerprint'] == RAW._score_output_fingerprint(score)


def test_corrupt_cache_is_an_integrity_miss():
    fake_s3 = FakeS3()
    calls = {'embedding': 0}
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    revision_state = revisions()
    _, stored_meta = score_once(fake_s3, calls, montage, 'hook', True, 5, revision_state)
    cached = bytearray(fake_s3.objects[stored_meta['cache_key']])
    cached[-10] = ord('x')
    fake_s3.objects[stored_meta['cache_key']] = bytes(cached)

    RAW.s3 = fake_s3
    replay = RAW._score_replay_prepare(montage, 'hook', True, 5, revisions=revision_state)
    assert replay['score'] is None
    assert replay['meta']['cache_status'] in ('invalid', 'read_error')


def test_production_lookup_precedes_embedding():
    source = inspect.getsource(RAW._run)
    lookup = source.index('_score_replay_prepare(')
    return_on_hit = source.index("if replay.get('score') is not None:")
    first_embedding = source.index('ev = embed(')
    assert lookup < return_on_hit < first_embedding


if __name__ == '__main__':
    original_s3 = RAW.s3
    try:
        test_cache_hit_skips_all_embedding_calls()
        test_input_and_revision_changes_invalidate_replay()
        test_cache_failures_fall_through_without_hiding_scores()
        test_corrupt_cache_is_an_integrity_miss()
        test_production_lookup_precedes_embedding()
    finally:
        RAW.s3 = original_s3
    print('raw_upload deterministic replay: PASS')
