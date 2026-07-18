#!/usr/bin/env python3
import os, sys

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
assert "if 'ffmpeg exited with code 183' not in str(range_error)" in raw_upload_source
assert "fallback_opts.pop('download_ranges', None)" in raw_upload_source

view_record = {}
worker.append_view_snapshot(view_record, 100, 1000)
worker.append_view_snapshot(view_record, 120, 2000)
worker.append_view_snapshot(view_record, 120, 2000)
assert view_record['viewsHistory'] == [{'at': 1000, 'views': 100}, {'at': 2000, 'views': 120}]

steer = {}
for definition in worker.FEATURE_CONTRACT['features']:
    if definition.get('source') == 'steer':
        steer[definition['sourceKey']] = {'est': 73.5, 'pctile': 81.2}

registry = {'indicators': []}
indicators = {}
for target in ('keep', 'ret5', 'views'):
    name = 'nov_visual_global_' + target
    registry['indicators'].append({
        'name': name, 'kind': 'novelty', 'target': target, 'validated': True,
        'spearman': .4, 'pts': [[0.1, 10], [0.2, 20], [0.3, 30], [0.4, 40]],
    })
    indicators[name] = .31

features = worker.compact_features({'steer': steer, 'indicators': indicators}, registry)
assert len(features) == 21, len(features)
assert features['visual.keep'] == [73.5, 81.2]
assert features['novelty.keep'][1] == 75.0

manifest = {'id': 'chtest', 'videos': [
    {'id': 'a', 'status': 'done'}, {'id': 'b', 'status': 'queued'},
    {'id': 'c', 'status': 'scoring'}, {'id': 'd', 'status': 'error'},
]}
worker.recount_manifest(manifest)
assert (manifest['discovered'], manifest['completed'], manifest['queued'], manifest['failed']) == (4, 1, 2, 1)
print({'ok': True, 'features': len(features), 'counts': [manifest['completed'], manifest['queued'], manifest['failed']]})
