#!/usr/bin/env python3
"""
Watcher: reset stale run, record to autonomous_runs.json, report local counts.
"""
import json, datetime, os, sys

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

# ── 1. Load autonomous_progress ──────────────────────────────────────────
ap = load('autonomous_progress.json')
run_id = ap.get('run_id','')
completed = ap.get('completed', 0)
attempted = ap.get('attempted', 0)
active = ap.get('active', False)

print(f'Current run: {run_id}')
print(f'  active={active} completed={completed} attempted={attempted}')

# ── 2. Check staleness ───────────────────────────────────────────────────
updated = ap.get('updated_at','')
stale = False
if updated:
    updated_dt = datetime.datetime.fromisoformat(updated.replace('Z','+00:00'))
    delta = (datetime.datetime.now(datetime.timezone.utc) - updated_dt).total_seconds()
    print(f'  stale_seconds: {delta:.0f}')
    if active and delta > 300:  # stale if no update for 5+ min
        stale = True
        print(f'  -> STALE (process died)')

# ── 3. Reset stale run in autonomous_progress ───────────────────────────
if stale or active:
    ap['active'] = False
    ap['finished_at'] = iso_now()
    ap['stop_reason'] = 'process_died'
    save('autonomous_progress.json', ap)
    print(f'  Reset {run_id} -> process_died')

# ── 4. Record to autonomous_runs.json ────────────────────────────────────
runs = load('autonomous_runs.json')
if isinstance(runs, list):
    # Check if run already recorded
    existing_ids = [r.get('id') for r in runs]
    if run_id and run_id not in existing_ids and completed > 0:
        # Count local derived_experiments
        try:
            dec = load('derived_experiments_compact.json')
            total_derived = len(dec) if isinstance(dec, list) else len(dec.get('experiments', []))
        except:
            total_derived = 0
        try:
            ind = load('indicators_compact.json')
            total_indicators = len(ind) if isinstance(ind, list) else len(ind.get('indicators', []))
        except:
            total_indicators = 0

        run_record = {
            'id': run_id,
            'started_at': ap.get('started_at'),
            'finished_at': ap.get('finished_at'),
            'mode': ap.get('mode','hybrid_auto'),
            'llm_proposed': ap.get('llm_proposed',0),
            'llm_completed': ap.get('llm_completed',0),
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
            'elapsed_minutes': round((
                datetime.datetime.fromisoformat(ap.get('finished_at','').replace('Z','+00:00')) -
                datetime.datetime.fromisoformat(ap.get('started_at','').replace('Z','+00:00'))
            ).total_seconds() / 60, 2) if ap.get('started_at') and ap.get('finished_at') else 0,
            'total_indicators_after': total_indicators,
            'total_derived_after': total_derived,
        }
        runs.append(run_record)
        save('autonomous_runs.json', runs)
        print(f'  Added run record to autonomous_runs.json (now {len(runs)} runs, total_derived={total_derived})')
    else:
        print(f'  Run {run_id} already recorded or no completions, skipping')

# ── 5. Report local counts ───────────────────────────────────────────────
try:
    dec = load('derived_experiments_compact.json')
    local_derived = len(dec) if isinstance(dec, list) else len(dec.get('experiments', []))
    print(f'local derived_experiments: {local_derived}')
except Exception as e:
    print(f'ERROR reading derived_experiments_compact: {e}')

try:
    elc = load('experiments_log_compact.json')
    local_log = len(elc) if isinstance(elc, list) else len(elc.get('experiments', []))
    print(f'local experiments_log: {local_log}')
except Exception as e:
    print(f'ERROR reading experiments_log_compact: {e}')

try:
    cq = load('candidate_queue.json')
    cq_count = len(cq) if isinstance(cq, list) else len(cq.get('candidates', []))
    print(f'candidate_queue remaining: {cq_count}')
except Exception as e:
    print(f'ERROR reading candidate_queue: {e}')

print('DONE')
