#!/usr/bin/env python3
"""Focused deterministic replay tests for raw_upload.py.

No network, Gemini, ffmpeg, or real R2 credentials are used. The fake score has the
same 21 canonical embedding outputs plus the universal frozen visual keep forecast.
The conditional creator forecast is represented in the manifest but is intentionally
unavailable without an explicit eligible creator profile.
"""
import base64
import importlib.util
import inspect
import io
import json
import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
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


def canonical_score(seed=1, creator_profile=None):
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
        'nov_vis_global': 0.1111 + seed,
        'nov_txt_global': 0.2222 + seed,
        'nov_tog_global': 0.3333 + seed,
    }
    assert len(steer) + len(indicators) == 21
    return {
        'indicators': indicators,
        'steer': steer,
        'visual_keep_forecast': {
            'coordinate_id': RAW.VISUAL_KEEP_COORDINATE_ID,
            'est': 65.0 + seed,
            'raw': 65.0 + seed,
            'pctile': None,
            'kind': 'keep_rate_percent',
            'unit': 'percent',
            'calibration_scope': 'pooled_global',
            'account_model': None,
            'model_artifact_sha256': f'visual-keep-artifact-{seed}',
            'model_artifact_key': f'raw/predictor-lab/visual-keep-model/by-sha256/{seed:064x}.json',
            'model_artifact_canonical_key': RAW.VISUAL_KEEP_MODEL_KEY,
            'model_manifest_key': RAW.VISUAL_KEEP_MODEL_MANIFEST_KEY,
        },
        'emb_preview': {
            'visual': [0.1] * 48,
            'text': [0.3] * 48,
            'together': [0.5] * 48,
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
        'creator_adaptive_keep_forecast': {
            'coordinate_id': RAW.CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
            'profile_account': creator_profile,
            'raw': 70.0 + seed,
        } if creator_profile else None,
    }


def score_once(fake_s3, calls, montage, transcript, used, duration, revision_state, seed=1, creator_profile=None):
    RAW.s3 = fake_s3
    replay = RAW._score_replay_prepare(
        montage, transcript, used, duration, creator_profile, revisions=revision_state)
    if replay['score'] is not None:
        return replay['score'], replay['meta']
    calls['embedding'] += 3
    score = canonical_score(seed, creator_profile)
    return score, RAW._score_replay_store(
        replay,
        score,
        creator_profile,
        used,
    )


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
        'This turned out better than expected.'), True, 12.3454, replay_score, replay_meta,
        None, 'five-frame-montage')
    manifest = output['input_manifest']
    assert manifest['cache_key'] == replay_meta['cache_key']
    assert manifest['cache_status'] == 'hit'
    assert manifest['input_fingerprint'] == replay_meta['input_fingerprint']
    assert manifest['score_input_fingerprint'] == replay_meta['input_fingerprint']
    assert manifest['embedding_input_fingerprint'] == replay_meta['embedding_input_fingerprint']
    assert manifest['revision_fingerprint'] == replay_meta['revision_fingerprint']
    assert manifest['output_fingerprint'] == replay_meta['output_fingerprint']
    assert manifest['scorer_revisions'] == revision_state
    assert manifest['canonical_output_contract']['canonical_embedding_outputs'] == 21
    assert manifest['canonical_output_contract']['universal_raw_scorer_total'] == 22
    assert manifest['canonical_output_contract']['creator_profile_enriched_maximum'] == 23
    assert manifest['canonical_output_contract']['derived_forecasts_total'] == 2
    assert manifest['canonical_output_contract']['frozen_model_forecasts'] == 1
    assert manifest['canonical_output_contract']['conditional_creator_forecasts'] == 1
    assert output['visual_keep_forecast'] == first_score['visual_keep_forecast']
    assert manifest['steer_artifact_archive_key'].endswith('steer-artifact-1.npz')
    assert manifest['steer_lineage_manifest_sha256'] == 'steer-lineage-1'
    assert manifest['steer_lineage_schema_version'] == 1
    assert manifest['source_mode'] == 'five-frame-montage'
    assert manifest['creator_profile'] is None
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
    score_once(fake_s3, calls, montage, 'same words', True, 8.0, rev_a, seed=6, creator_profile='tyler')

    assert calls['embedding'] == 18, 'duration, profile, channel state, revisions, or montage failed to invalidate replay'


def test_embedding_identity_is_independent_from_duration_and_creator_profile():
    montage = base64.b64encode(b'canonical-montage-bytes').decode()
    first_fingerprint, first = RAW._score_input_fingerprint(
        montage, 'same words', True, 8.0, 'tyler')
    second_fingerprint, second = RAW._score_input_fingerprint(
        montage, 'same words', True, 22.0, 'hafu')
    assert first_fingerprint != second_fingerprint
    assert first['embedding_input_fingerprint'] == second['embedding_input_fingerprint']
    assert first['embedding_input'] == second['embedding_input']
    assert first['duration_ms'] != second['duration_ms']
    assert first['creator_profile'] != second['creator_profile']


def test_source_image_encodings_converge_to_one_canonical_montage():
    image = RAW.Image.new('RGB', (400, 142), (12, 34, 56))
    for x in range(0, 400, 17):
        for y in range(0, 142, 13):
            image.putpixel((x, y), ((x * 7) % 256, (y * 11) % 256, ((x + y) * 5) % 256))
    png = io.BytesIO()
    bmp = io.BytesIO()
    image.save(png, format='PNG')
    image.save(bmp, format='BMP')
    canonical_png = RAW.canonicalize_montage_bytes(png.getvalue())
    canonical_bmp = RAW.canonicalize_montage_bytes(bmp.getvalue())
    assert canonical_png == canonical_bmp
    assert RAW.canonicalize_montage_bytes(canonical_png) == canonical_png
    png_state = RAW._embedding_input_state(
        base64.b64encode(canonical_png).decode(), 'same words', True)
    bmp_state = RAW._embedding_input_state(
        base64.b64encode(canonical_bmp).decode(), 'same words', True)
    assert png_state == bmp_state
    assert png_state['montage_sha256'] == RAW.hashlib.sha256(canonical_png).hexdigest()


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
    meta = RAW._score_replay_store(replay, score, None, True)
    assert meta['cache_write_status'] == 'stored'
    assert meta['output_fingerprint'] == RAW._score_output_fingerprint(score)

    write_failure = FakeS3()
    write_failure.fail_writes = True
    RAW.s3 = write_failure
    replay = RAW._score_replay_prepare(montage, 'hook', True, 5, revisions=revision_state)
    meta = RAW._score_replay_store(replay, score, None, True)
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


def test_incomplete_scores_are_never_cached():
    fake_s3 = FakeS3()
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    replay = RAW._score_replay_prepare(
        montage,
        'hook',
        True,
        5,
        revisions=revisions(),
    )
    score = canonical_score()
    del score['steer']['together_keep']
    try:
        RAW._score_replay_store(replay, score, None, True)
    except RuntimeError as error:
        assert 'together_keep' in str(error)
    else:
        raise AssertionError('incomplete score was accepted')
    assert replay['meta']['cache_key'] not in fake_s3.objects


def test_production_lookup_precedes_embedding():
    source = inspect.getsource(RAW._run)
    lookup = source.index('_score_replay_prepare(')
    return_on_hit = source.index("if replay.get('score') is not None:")
    first_embedding = source.index('ev = embed(')
    assert lookup < return_on_hit < first_embedding


def test_visual_keep_formula_replays_the_frozen_raw_coordinate():
    embedding = RAW.np.zeros(RAW.DIM, dtype=float)
    embedding[0] = 3
    embedding[1] = 4
    pooled_coefficients = [0.0] * RAW.DIM
    pooled_coefficients[0] = 10
    pooled_coefficients[1] = 20
    payload = {
        'coordinateId': RAW.VISUAL_KEEP_COORDINATE_ID,
        'generatedAt': 123456,
        'status': 'research_only_not_validated_for_pre_upload_decisions',
        'input': 'fixture visual embedding',
        'formula': {
            'scope': 'pooled_global',
            'pooled': {
                'intercept': 5,
                'coefficients': pooled_coefficients,
            },
        },
    }
    artifact_sha256 = 'a' * 64
    artifact_key = (
        'raw/predictor-lab/visual-keep-model/by-sha256/'
        f'{artifact_sha256}.json'
    )
    pooled = RAW._visual_keep_forecast_from_payload(
        embedding,
        payload,
        artifact_sha256,
        artifact_key,
        'b' * 64,
    )
    assert pooled['raw'] == 27.0
    assert pooled['calibration_scope'] == 'pooled_global'
    assert pooled['account_model'] is None
    replayed = RAW._visual_keep_forecast_from_payload(
        embedding,
        payload,
        artifact_sha256,
        artifact_key,
        'b' * 64,
    )
    assert replayed['raw'] == pooled['raw']
    assert replayed['coordinate_id'] == RAW.VISUAL_KEEP_COORDINATE_ID
    assert replayed['model_artifact_sha256'] == artifact_sha256
    assert replayed['model_artifact_key'] == artifact_key
    assert replayed['model_manifest_sha256'] == 'b' * 64


if __name__ == '__main__':
    original_s3 = RAW.s3
    try:
        test_cache_hit_skips_all_embedding_calls()
        test_input_and_revision_changes_invalidate_replay()
        test_embedding_identity_is_independent_from_duration_and_creator_profile()
        test_source_image_encodings_converge_to_one_canonical_montage()
        test_cache_failures_fall_through_without_hiding_scores()
        test_corrupt_cache_is_an_integrity_miss()
        test_incomplete_scores_are_never_cached()
        test_production_lookup_precedes_embedding()
        test_visual_keep_formula_replays_the_frozen_raw_coordinate()
    finally:
        RAW.s3 = original_s3
    print('raw_upload deterministic replay: PASS')
