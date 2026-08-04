#!/usr/bin/env python3
"""Focused deterministic replay tests for raw_upload.py.

No network, Gemini, ffmpeg, or real R2 credentials are used. The fake score has the
same 21 canonical embedding outputs plus the four governed channel-free keep
outputs. Creator identity is intentionally absent from every scoring formula.
"""
import base64
import importlib.util
import inspect
import io
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from shorts_score_ledger import score_record_binding_sha256

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

    def _etag(self, payload):
        return hashlib.sha256(payload).hexdigest()

    def get_object(
        self,
        Bucket,
        Key,
        IfMatch=None,
        Range=None,
    ):
        if self.fail_reads:
            raise FakeS3Error('ServiceUnavailable', 'simulated R2 read outage')
        if Key not in self.objects:
            raise FakeS3Error('NoSuchKey', Key)
        payload = self.objects[Key]
        etag = self._etag(payload)
        if IfMatch and str(IfMatch).strip('"') != etag:
            raise FakeS3Error(
                'PreconditionFailed',
                'simulated conditional read mismatch',
            )
        if Range:
            match = RAW.re.fullmatch(r'bytes=(\d+)-(\d*)', Range)
            assert match
            start = int(match.group(1))
            end = (
                int(match.group(2))
                if match.group(2)
                else len(payload) - 1
            )
            payload = payload[start:end + 1]
        return {
            'Body': io.BytesIO(payload),
            'ETag': f'"{etag}"',
        }

    def head_object(self, Bucket, Key):
        if self.fail_reads:
            raise FakeS3Error(
                'ServiceUnavailable',
                'simulated R2 read outage',
            )
        if Key not in self.objects:
            raise FakeS3Error('NoSuchKey', Key)
        payload = self.objects[Key]
        return {
            'ETag': f'"{self._etag(payload)}"',
            'ContentLength': len(payload),
        }

    def put_object(self, Bucket, Key, Body, **kwargs):
        if self.fail_writes:
            raise FakeS3Error('ServiceUnavailable', 'simulated R2 write outage')
        self.objects[Key] = bytes(Body)
        return {
            'ETag': f'"{self._etag(self.objects[Key])}"',
        }


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


def channel_free_fixture(seed=1, transcript_used=True):
    outputs = {}
    for index, signal in enumerate(RAW.CHANNEL_FREE_SIGNALS):
        available = signal in ('visual', 'together') or transcript_used
        outputs[signal] = {
            'coordinate_id': f'shorts.channel-free.{signal}.keep',
            'signal': signal,
            'kind': 'channel_free_keep_rate_percent',
            'unit': 'percent',
            'percentile_unit': 'percentile_0_100',
            'input': f'fixture {signal} input',
            'channel_information': None,
            'calibration_scope': 'pooled_global_no_creator',
            'source': 'live_frozen_channel_free_model_score',
            'model_artifact_path': RAW.CHANNEL_FREE_MODEL_RELATIVE_PATH,
            'model_artifact_sha256': 'c' * 64,
            'model_run_id': 'channel-free-fixture-run',
            'selected': signal == 'concat',
            'oof_mae': 7.0 + index / 10,
            'oof_spearman': 0.5 + index / 100,
            'available': available,
            'est': float(60 + seed + index) if available else None,
            'raw': float(60 + seed + index) if available else None,
            'pctile': float(50 + seed + index) if available else None,
            'unavailable_reason': None if available else (
                'A coherent first-5-second transcript is required for this signal.'
            ),
        }
    return {
        'schema': 'shorts-channel-free-keep-forecasts-v1',
        'model_artifact_path': RAW.CHANNEL_FREE_MODEL_RELATIVE_PATH,
        'model_artifact_sha256': 'c' * 64,
        'model_run_id': 'channel-free-fixture-run',
        'selected_signal': 'concat',
        'source': 'live_frozen_channel_free_model_score',
        'channel_information': None,
        'outputs': outputs,
    }


def canonical_score(seed=1, creator_profile=None, transcript_used=True):
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
        'channel_free_keep_forecasts': channel_free_fixture(
            seed,
            transcript_used,
        ),
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
    }


def score_once(fake_s3, calls, montage, transcript, used, duration, revision_state, seed=1, creator_profile=None):
    RAW.s3 = fake_s3
    replay = RAW._score_replay_prepare(
        montage, transcript, used, duration, creator_profile, revisions=revision_state)
    if replay['score'] is not None:
        return replay['score'], replay['meta']
    calls['embedding'] += 3
    score = canonical_score(seed, creator_profile, used)
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
    assert manifest['canonical_output_contract']['universal_raw_scorer_total'] == 25
    assert manifest['canonical_output_contract']['channel_free_keep_outputs'] == 4
    assert manifest['canonical_output_contract']['complete_score_outputs'] == 25
    assert manifest['canonical_output_contract']['derived_forecasts_total'] == 4
    assert manifest['canonical_output_contract']['channel_free_creator_information'] is None
    assert output['channel_free_keep_forecasts'] == first_score['channel_free_keep_forecasts']
    assert manifest['steer_artifact_archive_key'].endswith('steer-artifact-1.npz')
    assert manifest['steer_lineage_manifest_sha256'] == 'steer-lineage-1'
    assert manifest['steer_lineage_schema_version'] == 1
    assert manifest['source_mode'] == 'five-frame-montage'
    assert manifest['creator_profile'] is None
    with open(os.path.join(ROOT, 'buildings', 'jarvis', 'saved-channel-feature-contract.json'), encoding='utf-8') as handle:
        contract = json.load(handle)
    assert manifest['display_contract_version'] == contract['version']
    assert (
        manifest['feature_contract_identity_schema_version']
        == RAW.FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION
    )
    assert manifest['feature_contract_sha256'] == RAW.FEATURE_CONTRACT_SHA256
    assert (
        manifest['feature_contract_document_sha256']
        == RAW.FEATURE_CONTRACT_DOCUMENT_SHA256
    )
    assert (
        output['score_ledger']['feature_contract_sha256']
        == manifest['feature_contract_sha256']
    )
    assert (
        output['score_ledger']['feature_contract_document_sha256']
        == manifest['feature_contract_document_sha256']
    )
    with open(
        os.path.join(ROOT, 'shorts_score_ledger.py'),
        'rb',
    ) as handle:
        expected_ledger_source_sha256 = hashlib.sha256(
            handle.read()
        ).hexdigest()
    assert (
        RAW._score_ledger_code_sha256()
        == expected_ledger_source_sha256
    )
    assert (
        "'score_ledger_module_sha256'" in inspect.getsource(
            RAW._score_revisions
        )
    ), 'replay identity must change when ledger materialization code changes'


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

    assert calls['embedding'] == 15, 'creator metadata changed a channel-free replay identity'


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
    assert 'creator_profile' not in first
    same_duration_a, state_a = RAW._score_input_fingerprint(
        montage, 'same words', True, 8.0, 'tyler')
    same_duration_b, state_b = RAW._score_input_fingerprint(
        montage, 'same words', True, 8.0, 'hafu')
    assert same_duration_a == same_duration_b
    assert state_a == state_b


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


def test_equivalent_ingress_modes_share_canonical_score_identity():
    fake_s3 = FakeS3()
    RAW.s3 = fake_s3
    image = RAW.Image.new('RGB', (400, 142), (25, 50, 75))
    source = io.BytesIO()
    image.save(source, format='PNG')
    montage = base64.b64encode(
        RAW.canonicalize_montage_bytes(source.getvalue())
    ).decode()
    transcript = RAW.normalize_transcript(
        '  This   machine does something impossible. \n'
    )
    replay = RAW._score_replay_prepare(
        montage,
        transcript,
        True,
        12.5,
        'tyler',
        revisions=revisions('cross-ingress'),
    )
    score = canonical_score(7, 'tyler')
    replay_meta = RAW._score_replay_store(
        replay,
        score,
        'tyler',
        True,
    )
    source_modes = (
        'device-upload',
        'youtube',
        'youtube-relay-acquisition',
        'five-frame-montage',
    )
    outputs = [
        RAW._score_output(
            {},
            'Equivalent ingress fixture',
            montage,
            transcript,
            True,
            12.5,
            json.loads(json.dumps(score)),
            dict(replay_meta),
            'tyler',
            source_mode,
        )
        for source_mode in source_modes
    ]
    first = outputs[0]
    first_manifest = first['input_manifest']
    first_binding = score_record_binding_sha256({
        'id': 'equivalent-ingress',
        'kind': 'scored',
        'title': first['title'],
        'score_ledger': first['score_ledger'],
        'steer': first['steer'],
        'features': first['features'],
        'channel_free_keep_forecasts':
            first['channel_free_keep_forecasts'],
        'input_manifest': first_manifest,
    })
    for output, source_mode in zip(outputs, source_modes):
        manifest = output['input_manifest']
        assert manifest['source_mode'] == source_mode
        assert (
            manifest['embedding_input_fingerprint']
            == first_manifest['embedding_input_fingerprint']
        )
        assert (
            manifest['score_input_fingerprint']
            == first_manifest['score_input_fingerprint']
        )
        assert (
            manifest['revision_fingerprint']
            == first_manifest['revision_fingerprint']
        )
        assert (
            manifest['output_fingerprint']
            == first_manifest['output_fingerprint']
        )
        assert output['score_ledger'] == first['score_ledger']
        assert (
            output['score_ledger']['ledger_sha256']
            == first['score_ledger']['ledger_sha256']
        )
        assert output['features'] == first['features']
        assert output['steer'] == first['steer']
        binding = score_record_binding_sha256({
            'id': 'equivalent-ingress',
            'kind': 'scored',
            'title': output['title'],
            'score_ledger': output['score_ledger'],
            'steer': output['steer'],
            'features': output['features'],
            'channel_free_keep_forecasts':
                output['channel_free_keep_forecasts'],
            'input_manifest': manifest,
        })
        assert binding == first_binding
    assert len({
        output['input_manifest']['source_mode']
        for output in outputs
    }) == len(source_modes)


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


def test_channel_free_outputs_fail_closed_and_silent_inputs_are_explicit():
    fake_s3 = FakeS3()
    RAW.s3 = fake_s3
    montage = base64.b64encode(b'exact-five-frame-jpeg-bytes').decode()
    replay = RAW._score_replay_prepare(
        montage,
        'hook',
        True,
        5,
        'tyler',
        revisions=revisions(),
    )
    missing = canonical_score(creator_profile='tyler')
    del missing['channel_free_keep_forecasts']['outputs']['concat']
    errors = RAW._score_completeness_errors(
        missing,
        'tyler',
        True,
    )
    assert 'channel-free concat keep forecast' in errors
    try:
        RAW._score_replay_store(replay, missing, 'tyler', True)
    except RuntimeError as error:
        assert 'channel-free concat keep forecast' in str(error)
    else:
        raise AssertionError('incomplete channel-free output set was cached')

    silent = canonical_score(
        creator_profile='tyler',
        transcript_used=False,
    )
    errors = RAW._score_completeness_errors(
        silent,
        'tyler',
        False,
    )
    assert not errors
    outputs = silent['channel_free_keep_forecasts']['outputs']
    assert outputs['visual']['available'] is True
    assert outputs['together']['available'] is True
    assert outputs['text']['available'] is False
    assert outputs['concat']['available'] is False


def test_production_lookup_precedes_embedding():
    source = inspect.getsource(RAW._run)
    lookup = source.index('_score_replay_prepare(')
    return_on_hit = source.index("if replay.get('score') is not None:")
    first_embedding = source.index('ev = embed(')
    assert lookup < return_on_hit < first_embedding


def test_channel_free_formula_replays_all_four_frozen_coordinates():
    with open(RAW.CHANNEL_FREE_MODEL_PATH, 'rb') as handle:
        payload_bytes = handle.read()
    payload = json.loads(payload_bytes)
    artifact_sha256 = hashlib.sha256(payload_bytes).hexdigest()
    embeddings = {}
    for index, signal in enumerate(('visual', 'text', 'together')):
        vector = RAW.np.zeros(RAW.DIM, dtype=float)
        vector[index] = 1.0
        embeddings[signal] = vector
    first = RAW._channel_free_keep_forecasts_from_payload(
        embeddings,
        payload,
        artifact_sha256,
    )
    replayed = RAW._channel_free_keep_forecasts_from_payload(
        embeddings,
        payload,
        artifact_sha256,
    )
    assert first == replayed
    assert first['channel_information'] is None
    assert first['selected_signal'] == 'concat'
    assert set(first['outputs']) == set(RAW.CHANNEL_FREE_SIGNALS)
    for signal, output in first['outputs'].items():
        assert output['available'] is True
        assert output['coordinate_id'] == f'shorts.channel-free.{signal}.keep'
        assert output['model_artifact_sha256'] == artifact_sha256
        assert output['channel_information'] is None
        assert 0 <= output['raw'] <= 100
        assert 0 <= output['pctile'] <= 100

    no_text = RAW._channel_free_keep_forecasts_from_payload(
        {
            'visual': embeddings['visual'],
            'text': None,
            'together': embeddings['together'],
        },
        payload,
        artifact_sha256,
    )
    assert no_text['outputs']['visual']['available'] is True
    assert no_text['outputs']['together']['available'] is True
    assert no_text['outputs']['text']['available'] is False
    assert no_text['outputs']['concat']['available'] is False


def test_revision_pinned_reads_fail_closed_on_mutation():
    fake_s3 = FakeS3()
    key = RAW.VISUAL_KEEP_MODEL_MANIFEST_KEY
    original = b'{"release":"one"}'
    fake_s3.objects[key] = original
    RAW.s3 = fake_s3
    revision = RAW._object_revision(key)
    assert revision['state'] == 'present'
    assert revision['sha256'] == hashlib.sha256(original).hexdigest()
    RAW._PINNED_ARTIFACT_REVISIONS = {key: revision}
    assert RAW.r2_get(key) == original
    fake_s3.objects[key] = b'{"release":"two"}'
    try:
        RAW.r2_get(key)
    except RAW.ScoreArtifactIntegrityError:
        pass
    else:
        raise AssertionError(
            'a mutated manifest was read under an older revision identity'
        )


if __name__ == '__main__':
    original_s3 = RAW.s3
    try:
        test_cache_hit_skips_all_embedding_calls()
        test_input_and_revision_changes_invalidate_replay()
        test_embedding_identity_is_independent_from_duration_and_creator_profile()
        test_source_image_encodings_converge_to_one_canonical_montage()
        test_equivalent_ingress_modes_share_canonical_score_identity()
        test_cache_failures_fall_through_without_hiding_scores()
        test_corrupt_cache_is_an_integrity_miss()
        test_incomplete_scores_are_never_cached()
        test_channel_free_outputs_fail_closed_and_silent_inputs_are_explicit()
        test_production_lookup_precedes_embedding()
        test_channel_free_formula_replays_all_four_frozen_coordinates()
        test_revision_pinned_reads_fail_closed_on_mutation()
    finally:
        RAW._PINNED_ARTIFACT_REVISIONS = {}
        RAW.s3 = original_s3
    print('raw_upload deterministic replay: PASS')
