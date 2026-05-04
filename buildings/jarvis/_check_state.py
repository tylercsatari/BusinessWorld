import json, sys, os

base = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld'

with open(f'{base}/buildings/jarvis/graph.json') as f:
    g = json.load(f)
with open(f'{base}/buildings/jarvis/resolutions.json') as f:
    r = json.load(f)
with open(f'{base}/buildings/jarvis/autonomous_progress.json') as f:
    ap = json.load(f)

edges = g.get('derived_edges', [])
print('local derived_edges:', len(edges))
print('local nodes:', len(g.get('nodes', [])))
print('resolutions:', len(r))
print('progress active:', ap.get('active'))
print('progress run_id:', ap.get('run_id'))
print('progress completed:', ap.get('completed'))
print('progress attempted:', ap.get('attempted'))
print('progress updated_at:', ap.get('updated_at'))
print('progress current_candidate:', ap.get('current_candidate'))

for e in edges[-5:]:
    if isinstance(e, dict):
        k = e.get('indicator') or e.get('key') or str(list(e.keys())[:2])
        r_val = e.get('r', '?')
        print(f'  last edge: {k} r={r_val}')
