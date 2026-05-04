#!/bin/bash
# Post-run sync: wait for active run to complete, then sync R2 + git commit
set -e
JARVIS_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis"
ROOT_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
LOG="/tmp/jarvis_post_run_sync.log"
exec >> "$LOG" 2>&1

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Post-run sync watcher started"

# Poll until run is inactive (completed/died) - max 30 min wait
MAX_WAIT=1800
ELAPSED=0
INTERVAL=15
while true; do
    ACTIVE=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('active','false'))" 2>/dev/null)
    if [ "$ACTIVE" = "False" ] || [ "$ACTIVE" = "false" ]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Run complete. Proceeding with sync."
        break
    fi
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Timeout waiting for run. Syncing anyway."
        break
    fi
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Run still active (elapsed=${ELAPSED}s)..."
done

# Sync to R2
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Syncing local → R2..."
cd "$ROOT_DIR"
node sync-jarvis-to-r2.js >> "$LOG" 2>&1 && echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 sync complete" || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 sync failed"

# Gather stats for commit message
RUN_ID=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('run_id','unknown'))" 2>/dev/null)
STOP_REASON=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('stop_reason','?'))" 2>/dev/null)
COMPLETED=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('completed',0))" 2>/dev/null)
LAST_R=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('last_completed_r','?'))" 2>/dev/null)
DERIVED_COUNT=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/derived_experiments.json')); print(len(d))" 2>/dev/null)
CANDIDATES=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/candidate_queue.json')); print(len(d))" 2>/dev/null)

cd "$ROOT_DIR"
git add -A buildings/jarvis/autonomous_progress.json \
         buildings/jarvis/derived_experiments.json \
         buildings/jarvis/derived_experiments_compact.json \
         buildings/jarvis/experiments_log.json \
         buildings/jarvis/experiments_log_compact.json \
         buildings/jarvis/graph.json \
         buildings/jarvis/indicators.json \
         buildings/jarvis/indicators_compact.json \
         buildings/jarvis/autonomous_runs.json \
         buildings/jarvis/candidate_queue.json \
         buildings/jarvis/jarvis-ui.js \
         buildings/jarvis/viral-idea-engine.js \
         2>/dev/null || true

git commit -m "Sync Jarvis state: run ${RUN_ID} complete (${COMPLETED} done, ${STOP_REASON}); ${DERIVED_COUNT} derived experiments; ${CANDIDATES} candidates remain; R2 synced — pre-upload 0.70 bias, top new r=${LAST_R}" \
    --allow-empty 2>/dev/null || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Nothing new to commit"

git push origin master >> "$LOG" 2>&1 && echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Git push complete" || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Git push failed"

# Relaunch next autorun immediately
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Relaunching autorun..."
nohup node "$JARVIS_DIR/launch-autorun.js" >> /tmp/jarvis_autorun_relaunch.log 2>&1 &
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Autorun relaunched (PID $!)."

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Post-run sync watcher done."

# Chain: start a new sync watcher for the relaunched run
sleep 5
nohup bash "$JARVIS_DIR/_cron_post_run_sync.sh" >> "$LOG" 2>&1 &
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Next sync watcher chained (PID $!)."
