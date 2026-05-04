#!/usr/bin/env python3
import json, sys
from datetime import datetime, timezone

path = 'buildings/jarvis/autonomous_progress.json'
with open(path) as f:
    d = json.load(f)

if d.get('active'):
    d['active'] = False
    d['finished_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    d['stop_reason'] = 'process_died_watchdog'
    with open(path, 'w') as f:
        json.dump(d, f, indent=2)
    print(f"Reset run {d.get('run_id')} → inactive (process_died_watchdog)")
else:
    print("Run already inactive, no change needed")
