#!/bin/bash
# Watcher restart: mark run done, sync R2, git commit/push, start new run
set -e
ROOT="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
JARVIS="$ROOT/buildings/jarvis"
LOG="/tmp/jarvis_watcher_restart.log"
exec > >(tee -a "$LOG") 2>&1
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] === Watcher restart triggered ==="

# Mark active run as done (process died)
python3 - <<'EOF'
import json, os
p = os.path.join(os.environ.get('JARVIS', '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis'), 'autonomous_progress.json')
with open(p) as f:
    d = json.load(f)
if d.get('active'):
    import datetime
    d['active'] = False
    d['stop_reason'] = 'process_died_watchdog'
    d['finished_at'] = datetime.datetime.utcnow().isoformat() + 'Z'
    with open(p, 'w') as f:
        json.dump(d, f, indent=2)
    print(f"Marked run {d.get('run_id')} as done: {d.get('completed')} completed")
else:
    print("Run already inactive")
EOF

# Sync to R2
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Syncing to R2..."
cd "$ROOT"
node sync-jarvis-to-r2.js

# Git commit + push
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Committing and pushing..."
cd "$ROOT"
DERIVED_COUNT=$(python3 -c "import json; d=json.load(open('buildings/jarvis/derived_experiments.json')); print(len(d))" 2>/dev/null || echo "?")
RUN_ID=$(python3 -c "import json; d=json.load(open('buildings/jarvis/autonomous_progress.json')); print(d.get('run_id','unknown'))" 2>/dev/null || echo "unknown")
COMPLETED=$(python3 -c "import json; d=json.load(open('buildings/jarvis/autonomous_progress.json')); print(d.get('completed',0))" 2>/dev/null || echo "0")

git add -A buildings/jarvis/autonomous_progress.json \
         buildings/jarvis/derived_experiments.json \
         buildings/jarvis/derived_experiments_compact.json \
         buildings/jarvis/resolutions.json 2>/dev/null || true

git diff --staged --quiet || git commit -m "Sync Jarvis state: run ${RUN_ID} complete (${COMPLETED} done, process_died_watchdog); ${DERIVED_COUNT} derived experiments; R2 synced — pre-upload 0.70 bias, zygarnik/open-loop focused"

git push origin main

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Sync and push complete."
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting new autorun (5000 iter, 30min, pre=0.70)..."

# Start new run in background, log to autorun_overnight.log
nohup node "$JARVIS/run-autorun-now.js" >> "$JARVIS/autorun_overnight.log" 2>&1 &
AUTORUN_PID=$!
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] New autorun started: PID=$AUTORUN_PID"
echo $AUTORUN_PID > /tmp/jarvis_autorun.pid
