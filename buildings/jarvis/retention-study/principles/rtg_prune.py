#!/usr/bin/env python3
"""
RTG · prune to the PRESENCE-VALIDATED signal set. The within-video shuffle test (rtg_shuffle_test)
showed real directed reference structure only in RAW, concept-anchored, forward-directed matches
(cc/cAny/vc/anyAny · entail). cv ("promise→proof") and every double-centred operator FAIL the
shuffle null, and the old set-cover ensemble was built mostly from failing operators. Keep only
the passers + the direct-perception graphics (counter/progress, validated by Gemini Vision, not
geometry). Everything else is removed so the system is solid.
"""
import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
PASS = re.compile(r'^(cc|cAny|vc|anyAny)_entail_g\d+$')
VISION = {'counter', 'progress'}
CHAMP = 'cAny_entail_g4'

old = d['meta'].get('signals', [])
keep = [s for s in old if PASS.match(s) or s in VISION]
removed = [s for s in old if s not in keep]
if CHAMP not in keep and CHAMP in old:
    keep.insert(0, CHAMP)
print(f"keeping {len(keep)}: {keep}")
print(f"removing {len(removed)}: {removed}")

for v in d['videos']:
    sg = v.get('signals', {})
    for k in list(sg):
        if k not in keep:
            del sg[k]

m = d['meta']
m['signals'] = keep
m['signal_default'] = CHAMP if CHAMP in keep else (keep[0] if keep else None)
m['signal_labels'] = {k: v for k, v in m.get('signal_labels', {}).items() if k in keep}
rv = m.get('retention_validation', {})
if 'by_signal' in rv:
    rv['by_signal'] = {k: v for k, v in rv['by_signal'].items() if k in keep}
# drop sweep metadata that referenced removed operators
for k in ['sweep', 'sweep_n', 'signal_scores']:
    m.pop(k, None)
m['presence'] = {'method': 'within-video time-shuffle null (rtg_shuffle_test)', 'kept': keep,
                 'removed': removed, 'rule': 'raw concept-anchored forward-directed (cc/cAny/vc/anyAny·entail) + Gemini-Vision graphics; cv + double-centred operators failed'}
json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
print(f"\ndefault = {m['signal_default']} · {len(keep)} presence-validated signals kept")
