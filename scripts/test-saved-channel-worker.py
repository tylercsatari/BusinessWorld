#!/usr/bin/env python3
import ast, copy, hashlib, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import yt_relay_watcher as worker

with open(os.path.join(ROOT, 'yt_relay_watcher.py'), encoding='utf-8') as source_file:
    worker_source = source_file.read()
assert "'viewsObservedAt': views_observed_at" in worker_source
assert "previous['published'] = video.get('published')" in worker_source
assert "terminal_status = 'done' if" in worker_source
assert "montage_saved = False" in worker_source
assert "if not montage_saved:" in worker_source
assert "'stored image failed: ' + montage_error" in worker_source
assert 'def migrate_done_record_bindings' not in worker_source
assert 'def requeue_invalid_done_ledgers' not in worker_source
assert 'queued for ledger repair' not in worker_source

with open(os.path.join(ROOT, 'raw_upload.py'), encoding='utf-8') as raw_upload_file:
    raw_upload_source = raw_upload_file.read()
assert "should_try_full = 'ffmpeg exited with code 183' in message or bool(auth_options)" in raw_upload_source
assert "_youtube_download_options(folder, auth_options, ranged=False)" in raw_upload_source

with open(
    os.path.join(
        ROOT,
        'buildings',
        'jarvis',
        'quant-coordinate-governance.json',
    ),
    encoding='utf-8',
) as governance_file:
    governance = json.load(governance_file)
predictor_path = os.path.join(
    ROOT,
    'buildings',
    'jarvis',
    'predictor-lab',
    'run_predictor_lab.py',
)
with open(predictor_path, encoding='utf-8') as predictor_file:
    predictor_source = predictor_file.read()
predictor_tree = ast.parse(predictor_source, predictor_path)


def predictor_literal(name):
    for node in predictor_tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            continue
        if (
            isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == 'frozenset'
        ):
            return frozenset(ast.literal_eval(node.value.args[0]))
        return ast.literal_eval(node.value)
    raise AssertionError(f'predictor constant is missing: {name}')


predictor_modalities = tuple(predictor_literal('MODALITIES'))
predictor_view_targets = tuple(
    predictor_literal('VIEWS_VALIDATION_AXIS_TARGETS')
)
predictor_forbidden_targets = frozenset(
    predictor_literal('VIEWS_VALIDATION_FORBIDDEN_TARGETS')
)
assert predictor_modalities == tuple(governance['expansions']['modalities'])
assert (
    predictor_view_targets
    == tuple(governance['expansions']['creatorExcludedPublicTargets'])
)
assert predictor_forbidden_targets == frozenset(
    governance['expansions']['privateHeldoutTargets']
)

prediction_inventory_function = next(
    (
        node
        for node in predictor_tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == 'leakage_safe_views_feature_names'
    ),
    None,
)
assert prediction_inventory_function is not None
prediction_namespace = {
    'MODALITIES': predictor_modalities,
    'VIEWS_VALIDATION_AXIS_TARGETS': predictor_view_targets,
}
prediction_module = ast.Module(
    body=[copy.deepcopy(prediction_inventory_function)],
    type_ignores=[],
)
ast.fix_missing_locations(prediction_module)
exec(
    compile(prediction_module, predictor_path, 'exec'),
    prediction_namespace,
)
prediction_features = prediction_namespace[
    'leakage_safe_views_feature_names'
]()
expected_prediction_features = [
    f'{modality}.{target}.{variant}'
    for modality in governance['expansions']['modalities']
    for target in governance['expansions'][
        'creatorExcludedPublicTargets'
    ]
    for variant in ('raw', 'percentile')
]
assert prediction_features == expected_prediction_features
assert len(prediction_features) == 18
assert len(set(prediction_features)) == 18
assert not any(
    f'.{forbidden_target}.' in feature
    for feature in prediction_features
    for forbidden_target in predictor_forbidden_targets
)

view_record = {}
worker.append_view_snapshot(view_record, 100, 1000)
worker.append_view_snapshot(view_record, 120, 2000)
worker.append_view_snapshot(view_record, 120, 2000)
assert view_record['viewsHistory'] == [{'at': 1000, 'views': 100}, {'at': 2000, 'views': 120}]

steer = {}
fixture_value_by_unit = {
    'percent': 73.5,
    'retention_percent_rewatch_capable': 108.5,
    'views': 1_234_567,
    'number': 2.5,
    'probability': 0.735,
}
for definition in worker.FEATURE_CONTRACT['features']:
    if definition.get('source') == 'steer':
        steer[definition['sourceKey']] = {
            'est': fixture_value_by_unit[definition['unit']],
            'pctile': 81.2,
        }

registry = {'meta': {'n': 1200, 'n_owned': 211, 'created': '2026-07-28'}, 'indicators': []}
indicators = {}
novelty_values_by_target = {
    'keep': [10, 20, 30, 40],
    'ret5': [80, 95, 110, 130],
    'views': [3, 4, 5, 6],
}
for target in ('keep', 'ret5', 'views'):
    name = 'nov_visual_global_' + target
    registry['indicators'].append({
        'name': name, 'kind': 'novelty', 'target': target, 'validated': True,
        'spearman': -.4 if target == 'ret5' else .4,
        'n': 900, 'n_owned': 180,
        'pts': [
            [score, value]
            for score, value in zip(
                (0.1, 0.2, 0.3, 0.4),
                novelty_values_by_target[target],
            )
        ],
    })
    indicators[name] = .31
registry['indicators'].append({
    'name': 'nov_unvalidated_stronger_keep',
    'kind': 'novelty',
    'target': 'keep',
    'validated': False,
    'spearman': .99,
    'n': 1000,
    'n_owned': 190,
    'pts': [[0.1, 1], [0.2, 2], [0.3, 3], [0.4, 4]],
})
indicators['nov_unvalidated_stronger_keep'] = .31

registry_revision = {
    'source': worker.INDICATOR_REGISTRY_KEY,
    'sha256': 'registry-sha256',
    'bytes': 1234,
    'etag': 'registry-etag',
}
visual_keep_forecast = {
    'coordinate_id': 'shorts.visual-keep-forecast.v1',
    'raw': 72.345,
    'est': 72.345,
    'calibration_scope': 'pooled_global',
    'model_artifact_sha256': 'visual-keep-model-sha256',
}
record = {
    'steer': steer,
    'indicators': indicators,
    'visual_keep_forecast': visual_keep_forecast,
}
features, novelty_provenance = worker.compact_feature_bundle(
    record, registry, registry_revision
)
canonical_bundle = worker.materialize_score_bundle(
    record, registry, registry_revision
)
canonical_ledger = canonical_bundle['score_ledger']
stored_feature_definitions = worker.FEATURE_CONTRACT['features']
stored_feature_keys = [
    definition['key']
    for definition in stored_feature_definitions
]
stored_coordinate_ids = [
    governance['coordinates']['storedPattern'].replace(
        '{featureKey}',
        feature_key,
    )
    for feature_key in stored_feature_keys
]
assert len(stored_feature_keys) == 21
assert len(set(stored_feature_keys)) == 21
assert len(stored_coordinate_ids) == 21
assert len(set(stored_coordinate_ids)) == 21
assert len(features) == 21, len(features)
assert list(features) == stored_feature_keys
assert len(canonical_ledger['entries']) == 21
assert canonical_ledger['expected_coordinate_ids'] == stored_coordinate_ids
assert [
    entry['coordinate_id']
    for entry in canonical_ledger['entries']
] == stored_coordinate_ids
assert set(canonical_ledger['values_by_id']) == set(stored_coordinate_ids)
assert set(canonical_ledger['percentiles_by_id']) == set(
    stored_coordinate_ids
)
assert canonical_ledger['available_count'] == 21
assert canonical_ledger['schema_complete'] is True
assert canonical_ledger['all_values_available'] is True
assert canonical_ledger['unavailable'] == []
assert features['visual.keep'] == [73.5, 81.2]
assert features['visual.gt10M'] == [0.735, 81.2]
assert features['novelty.keep'][1] == 75.0
assert features['novelty.ret5'][1] == 25.0
assert features['novelty.views'] == [5.0, 75.0]
persisted_bundle = worker.feature_bundle_from_ledger(canonical_ledger)
assert persisted_bundle['features'] == features
assert (
    persisted_bundle['novelty_provenance']
    == canonical_bundle['novelty_provenance']
)
assert novelty_provenance['registryRevision'] == registry_revision
assert novelty_provenance['registryMeta'] == registry['meta']
assert set(novelty_provenance['targets']) == {'keep', 'ret5', 'views'}
keep_provenance = novelty_provenance['targets']['keep']
assert keep_provenance['selectedIndicatorKey'] == 'nov_visual_global_keep'
assert keep_provenance['candidateIndicatorCount'] == 2
assert keep_provenance['validatedCandidateCount'] == 1
assert keep_provenance['sign'] == 1
assert keep_provenance['calibration']['calibrationPointCount'] == 4
assert keep_provenance['calibration']['registeredPopulationCount'] == 900
assert keep_provenance['calibration']['registeredOwnedPopulationCount'] == 180
expected_points_hash = hashlib.sha256(
    worker.canonical_json_bytes(registry['indicators'][0]['pts'])
).hexdigest()
assert keep_provenance['calibration']['calibrationPointsSha256'] == expected_points_hash
assert keep_provenance['calibration']['calibrationPopulationHash'] == expected_points_hash
assert novelty_provenance['targets']['ret5']['sign'] == -1

raw_input_manifest = {
    'input_fingerprint': 'input-sha256',
    'revision_fingerprint': 'revision-sha256',
    'scorer_revisions': {'scorer': {'sha256': 'raw-upload-sha256'}},
    'canonical_montage': {
        'montage_sha256': 'a' * 64,
    },
}
record['input_manifest'] = raw_input_manifest
record['id'] = 'video123456'
record['savedChannelVideoId'] = 'video123456'
record['score_ledger'] = copy.deepcopy(canonical_ledger)
record['score_record_sha256'] = worker.score_record_binding_sha256(record)
record_bytes = worker.stable_json_bytes(record)
record_artifact_sha256 = hashlib.sha256(record_bytes).hexdigest()
record_artifact_key = worker.saved_channel_record_artifact_key(
    'ch0000000000000001',
    record_artifact_sha256,
)
assert record_artifact_key == (
    'raw/saved-channels/ch0000000000000001/video-artifacts/'
    f'by-sha256/{record_artifact_sha256}.json'
)


class ImmutableRecordS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, **kwargs):
        key = kwargs['Key']
        if kwargs.get('IfNoneMatch') == '*' and key in self.objects:
            error = RuntimeError('precondition failed')
            error.response = {
                'ResponseMetadata': {'HTTPStatusCode': 412},
                'Error': {'Code': 'PreconditionFailed'},
            }
            raise error
        self.objects[key] = bytes(kwargs['Body'])
        return {'ETag': '"artifact"'}

    def get_object(self, **kwargs):
        return {
            'Body': io.BytesIO(self.objects[kwargs['Key']]),
            'ETag': '"artifact"',
        }


immutable_s3 = ImmutableRecordS3()
real_s3 = worker.s3
worker.s3 = immutable_s3
try:
    worker.put_immutable_bytes(record_artifact_key, record_bytes)
    worker.put_immutable_bytes(record_artifact_key, record_bytes)
finally:
    worker.s3 = real_s3
assert immutable_s3.objects[record_artifact_key] == record_bytes

video_update = worker.scored_video_update(
    record,
    {
        'id': 'video123456',
        'title': 'Original',
        'views': 1234567,
        'viewsObservedAt': 1000,
        'published': '20260729',
    },
    'Test channel',
    True,
    novelty_provenance,
    scored_at=2000,
    record_artifact_sha256=record_artifact_sha256,
    record_byte_length=len(record_bytes),
)
assert 'features' not in video_update
assert video_update['input_manifest'] is raw_input_manifest
assert video_update['novelty_provenance'] is novelty_provenance
assert 'visual_keep_forecast' not in video_update
assert video_update['scoredAt'] == 2000
assert video_update['evidence_state'] == 'canonical_bound'
assert video_update['canonical'] is True
assert video_update['predictor_eligible'] is True
assert video_update['evidence_warning'] is None
assert record['id'] == 'video123456'
assert record['savedChannelVideoId'] == 'video123456'
assert (
    record['score_record_sha256']
    == worker.score_record_binding_sha256(record)
    == video_update['score_record_sha256']
)
assert (
    video_update['manifest_row_sha256']
    == worker.manifest_row_binding_sha256(video_update)
)
assert worker.manifest_row_binding_payload(video_update) == {
    'schema': 'saved-channel-manifest-row-binding-v3',
    'id': 'video123456',
    'title': 'Original',
    'status': 'done',
    'views': 1234567,
    'published': '20260729',
    'viewsObservedAt': 1000,
    'scoredAt': 2000,
    'score_record_sha256': record['score_record_sha256'],
    'record_artifact_sha256': record_artifact_sha256,
    'record_byte_length': len(record_bytes),
    'score_ledger': {
        'ledger_sha256': canonical_ledger['ledger_sha256'],
    },
    'input_manifest': {
        'revision_fingerprint': 'revision-sha256',
    },
    'evidence': {
        'state': 'canonical_bound',
        'canonical': True,
        'predictor_eligible': True,
        'warning': None,
    },
}
manifest_tamper_cases = {
    'id': 'different-video',
    'title': 'Tampered title',
    'status': 'queued',
    'views': 7654321,
    'published': '20260730',
    'viewsObservedAt': 1001,
    'scoredAt': 2001,
    'score_record_sha256': 'f' * 64,
    'record_artifact_sha256': 'e' * 64,
    'record_byte_length': len(record_bytes) + 1,
    'score_ledger.ledger_sha256': 'e' * 64,
    'input_manifest.revision_fingerprint': 'tampered-revision',
    'evidence.state': 'historical_unbound_input',
}
for bound_field, tampered_value in manifest_tamper_cases.items():
    tampered_row = copy.deepcopy(video_update)
    if bound_field == 'score_ledger.ledger_sha256':
        tampered_row['score_ledger']['ledger_sha256'] = tampered_value
    elif bound_field == 'input_manifest.revision_fingerprint':
        tampered_row['input_manifest']['revision_fingerprint'] = tampered_value
    elif bound_field == 'evidence.state':
        tampered_row['evidence_state'] = tampered_value
    else:
        tampered_row[bound_field] = tampered_value
    assert (
        worker.manifest_row_binding_sha256(tampered_row)
        != video_update['manifest_row_sha256']
    ), bound_field
unbound_tamper = copy.deepcopy(video_update)
unbound_tamper['transcript'] = 'This field is intentionally outside the compact binding.'
assert (
    worker.manifest_row_binding_sha256(unbound_tamper)
    == video_update['manifest_row_sha256']
)
persisted_video_update = json.loads(json.dumps(video_update))
assert persisted_video_update['input_manifest'] == raw_input_manifest
assert persisted_video_update['novelty_provenance'] == novelty_provenance
assert 'visual_keep_forecast' not in persisted_video_update
assert (
    persisted_video_update['score_record_sha256']
    == record['score_record_sha256']
)
assert (
    persisted_video_update['manifest_row_sha256']
    == worker.manifest_row_binding_sha256(persisted_video_update)
)

registry_bytes = json.dumps(registry, separators=(',', ':')).encode()
class FakeS3:
    def __init__(self):
        self.calls = []

    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        return {
            'Body': io.BytesIO(registry_bytes),
            'ETag': '"registry-etag"',
            'VersionId': 'registry-version',
            'LastModified': '2026-07-28T00:00:00Z',
        }

fake_s3 = FakeS3()
real_s3 = worker.s3
worker.s3 = fake_s3
try:
    loaded_registry, loaded_revision = worker.load_indicator_registry()
finally:
    worker.s3 = real_s3
assert loaded_registry == registry
assert len(fake_s3.calls) == 1
assert loaded_revision == {
    'source': worker.INDICATOR_REGISTRY_KEY,
    'sha256': hashlib.sha256(registry_bytes).hexdigest(),
    'bytes': len(registry_bytes),
    'etag': 'registry-etag',
    'versionId': 'registry-version',
    'lastModified': '2026-07-28T00:00:00Z',
}

missing_ledger = {
    'id': 'missing-ledger',
    'status': 'done',
    'features': {'visual.keep': [99, 99]},
}
hash_tampered_ledger = copy.deepcopy(canonical_ledger)
hash_tampered_ledger['ledger_sha256'] = '0' * 64
hash_tampered = {
    'id': 'hash-tampered',
    'status': 'done',
    'features': {'visual.keep': [98, 98]},
    'score_ledger': hash_tampered_ledger,
}
identity_tampered_ledger = copy.deepcopy(canonical_ledger)
identity_tampered_ledger['entries'][0]['feature_key'] = 'visual.not-keep'
identity_tampered_ledger['ledger_sha256'] = hashlib.sha256(
    worker.canonical_json_bytes({
        key: value
        for key, value in identity_tampered_ledger.items()
        if key != 'ledger_sha256'
    })
).hexdigest()
identity_tampered = {
    'id': 'identity-tampered',
    'status': 'done',
    'features': {'visual.keep': [97, 97]},
    'score_ledger': identity_tampered_ledger,
}
valid_done = {
    'id': 'valid-ledger',
    'status': 'done',
    'score_ledger': copy.deepcopy(canonical_ledger),
    'score_record_sha256': 'e' * 64,
    'record_artifact_sha256': 'f' * 64,
    'record_byte_length': 100,
}
valid_done['manifest_row_sha256'] = worker.manifest_row_binding_sha256(
    valid_done
)
repair_manifest = {
    'id': 'repair-test',
    'videos': [
        valid_done,
        missing_ledger,
        hash_tampered,
        identity_tampered,
    ],
}
before_integrity_check = copy.deepcopy(repair_manifest)
worker.recount_manifest(repair_manifest)
assert repair_manifest['videos'] == before_integrity_check['videos']
assert (
    repair_manifest['completed'],
    repair_manifest['queued'],
    repair_manifest['failed'],
) == (1, 0, 0)
assert repair_manifest['integrityFailures'] == 3

counted_done = {
    'id': 'a',
    'status': 'done',
    'score_ledger': copy.deepcopy(canonical_ledger),
    'score_record_sha256': 'd' * 64,
    'record_artifact_sha256': 'c' * 64,
    'record_byte_length': 100,
}
counted_done['manifest_row_sha256'] = (
    worker.manifest_row_binding_sha256(counted_done)
)
manifest = {'id': 'chtest', 'videos': [
    counted_done, {'id': 'b', 'status': 'queued'},
    {'id': 'c', 'status': 'scoring'}, {'id': 'd', 'status': 'error'},
]}
worker.recount_manifest(manifest)
assert (manifest['discovered'], manifest['completed'], manifest['queued'], manifest['failed']) == (4, 1, 2, 1)
print({
    'ok': True,
    'storedCoordinates': len(stored_coordinate_ids),
    'availableStoredFeatures': len(features),
    'viewsPredictionFeatures': len(prediction_features),
    'noveltyTargets': sorted(novelty_provenance['targets']),
    'counts': [manifest['completed'], manifest['queued'], manifest['failed']],
    'integrityFailures': repair_manifest['integrityFailures'],
})
