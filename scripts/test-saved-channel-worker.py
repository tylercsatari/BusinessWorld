#!/usr/bin/env python3
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import yt_relay_watcher as worker

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
