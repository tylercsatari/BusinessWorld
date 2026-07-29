#!/usr/bin/env python3
import hashlib, io, json, os, sys

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

with open(os.path.join(ROOT, 'raw_upload.py'), encoding='utf-8') as raw_upload_file:
    raw_upload_source = raw_upload_file.read()
assert "should_try_full = 'ffmpeg exited with code 183' in message or bool(auth_options)" in raw_upload_source
assert "_youtube_download_options(folder, auth_options, ranged=False)" in raw_upload_source

view_record = {}
worker.append_view_snapshot(view_record, 100, 1000)
worker.append_view_snapshot(view_record, 120, 2000)
worker.append_view_snapshot(view_record, 120, 2000)
assert view_record['viewsHistory'] == [{'at': 1000, 'views': 100}, {'at': 2000, 'views': 120}]

steer = {}
for definition in worker.FEATURE_CONTRACT['features']:
    if definition.get('source') == 'steer':
        steer[definition['sourceKey']] = {'est': 73.5, 'pctile': 81.2}

registry = {'meta': {'n': 1200, 'n_owned': 211, 'created': '2026-07-28'}, 'indicators': []}
indicators = {}
for target in ('keep', 'ret5', 'views'):
    name = 'nov_visual_global_' + target
    registry['indicators'].append({
        'name': name, 'kind': 'novelty', 'target': target, 'validated': True,
        'spearman': -.4 if target == 'ret5' else .4,
        'n': 900, 'n_owned': 180,
        'pts': [[0.1, 10], [0.2, 20], [0.3, 30], [0.4, 40]],
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
record = {'steer': steer, 'indicators': indicators}
features, novelty_provenance = worker.compact_feature_bundle(
    record, registry, registry_revision
)
assert len(features) == 21, len(features)
assert features['visual.keep'] == [73.5, 81.2]
assert features['novelty.keep'][1] == 75.0
assert features['novelty.ret5'][1] == 25.0
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
}
record['input_manifest'] = raw_input_manifest
video_update = worker.scored_video_update(
    record,
    {'id': 'video123456', 'title': 'Original', 'viewsObservedAt': 1000},
    'Test channel',
    True,
    features,
    novelty_provenance,
    scored_at=2000,
)
assert video_update['input_manifest'] is raw_input_manifest
assert video_update['novelty_provenance'] is novelty_provenance
assert video_update['scoredAt'] == 2000
persisted_video_update = json.loads(json.dumps(video_update))
assert persisted_video_update['input_manifest'] == raw_input_manifest
assert persisted_video_update['novelty_provenance'] == novelty_provenance

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

manifest = {'id': 'chtest', 'videos': [
    {'id': 'a', 'status': 'done'}, {'id': 'b', 'status': 'queued'},
    {'id': 'c', 'status': 'scoring'}, {'id': 'd', 'status': 'error'},
]}
worker.recount_manifest(manifest)
assert (manifest['discovered'], manifest['completed'], manifest['queued'], manifest['failed']) == (4, 1, 2, 1)
print({
    'ok': True,
    'features': len(features),
    'noveltyTargets': sorted(novelty_provenance['targets']),
    'counts': [manifest['completed'], manifest['queued'], manifest['failed']],
})
