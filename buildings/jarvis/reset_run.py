#!/usr/bin/env python3
"""Reset stale run and record to autonomous_runs.json."""
import json, datetime, os

JARVIS_DIR = os.path.dirname(os.path.abspath(__file__))

def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')

def load(fname):
    with open(os.path.join(JARVIS_DIR, fname)) as f:
        return json.load(f)

def save(fname, data):
    with open(os.path.join(JARVIS_DIR, fname), 'w') as f:
        json.dump(data, f, separators=(',',':'))
    print(f'  saved {fname}')

ap = load('autonomous_progress.json')
run_id = ap.get('run_id','')
completed = ap.get('completed', 0)
attempted = ap.get('attempted', 0)
active = ap.get('active', False)

print(f'Current run: {run_id}')
print(f'  active={active} completed={completed} attempted={attempted}')

updated = ap.get('updated_at','')
if updated:
    updated_dt = datetime.datetime.fromisoformat(updated.replace('Z','+00:00'))
    delta = (datetime.datetime.now(datetime.timezone.utc) - updated_dt).total_seconds()
    print(f'  stale_seconds: {delta:.0f}')

if active:
    ap['active'] = False
    ap['finished_at'] = iso_now()
    ap['stop_reason'] = 'process_died'
    save('autonomous_progress.json', ap)
    print(f'  Reset {run_id} -> process_died')

runs = load('autonomous_runs.json')
if isinstance(runs, list):
    existing_ids = [r.get('id') for r in runs]
    if run_id and run_id not in existing_ids and completed > 0:
        dec = load('derived_experiments_compact.json')
        total_derived = len(dec) if isinstance(dec, list) else 0
        try:
            ind = load('indicators_compact.json')
            total_indicators = len(ind) if isinstance(ind, list) else 0
        except:
            total_indicators = 0
        cq = load('candidate_queue.json')
        cq_count = len(cq) if isinstance(cq, list) else 0

        run_record = {
            'id': run_id,
            'started_at': ap.get('started_at'),
            'finished_at': ap.get('finished_at'),
            'mode': ap.get('mode','hybrid_auto'),
            'attempted': attempted,
            'completed': completed,
            'failures': ap.get('failures',0),
            'pre_attempted': ap.get('pre_attempted',0),
            'pre_completed': ap.get('pre_completed',0),
            'post_attempted': ap.get('post_attempted',0),
            'post_completed': ap.get('post_completed',0),
            'preupload_ratio_requested': 0.70,
            'no_signal_streak_end': ap.get('no_signal_streak',0),
            'stop_reason': 'process_died',
            'top_new_r_abs': abs(ap.get('last_completed_r') or 0),
            'total_indicators_after': total_indicators,
            'total_derived_after': total_derived,
            'queue_remaining_after': cq_count,
        }
        runs.append(run_record)
        save('autonomous_runs.json', runs)
        print(f'  Added run record (now {len(runs)} runs, total_derived={total_derived}, queue_remaining={cq_count})')
    else:
        print(f'  Run already recorded or no completions, skipping')

print()
dec = load('derived_experiments_compact.json')
print(f'local derived_experiments: {len(dec)}')
cq = load('candidate_queue.json')
print(f'candidate_queue remaining: {len(cq)}')
print('DONE')
