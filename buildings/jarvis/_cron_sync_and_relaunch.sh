#!/bin/bash
# Cron watcher sync + relaunch script
# Commits pending Jarvis artifacts, syncs R2, launches new autorun, spawns new watcher

JARVIS_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis"
REPO_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
LOG="$JARVIS_DIR/watch-sync.log"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cron_sync_and_relaunch started" >> "$LOG"

# Collect stats for commit message
EXP_COUNT=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/derived_experiments_compact.json')); print(len(d))" 2>/dev/null)
RUN_ID=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('run_id','unknown'))" 2>/dev/null)
DONE=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('completed',0))" 2>/dev/null)
STOP=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('stop_reason','?'))" 2>/dev/null)
CANDS=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/candidate_queue.json')); print(len(d))" 2>/dev/null)
TOP_R=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('last_completed_r',0))" 2>/dev/null)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Stats: exp=$EXP_COUNT run=$RUN_ID done=$DONE stop=$STOP cands=$CANDS top_r=$TOP_R" >> "$LOG"

# Sync to R2
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Syncing R2..." >> "$LOG"
cd "$JARVIS_DIR"
node sync-to-r2.js >> "$LOG" 2>&1
R2_EXIT=$?
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 sync exit=$R2_EXIT" >> "$LOG"

# Commit and push
cd "$REPO_DIR"
git add buildings/jarvis/autonomous_progress.json \
        buildings/jarvis/graph.json \
        buildings/jarvis/resolutions.json \
        buildings/jarvis/derived_experiments.json \
        buildings/jarvis/derived_experiments_compact.json \
        buildings/jarvis/experiments_log.json \
        buildings/jarvis/experiments_log_compact.json \
        buildings/jarvis/indicators.json \
        buildings/jarvis/indicators_compact.json \
        buildings/jarvis/candidate_queue.json \
        buildings/jarvis/autonomous_runs.json \
        buildings/jarvis/indicator-registry.json \
        buildings/jarvis/autorun_overnight.log 2>/dev/null

CHANGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] staged=$CHANGED" >> "$LOG"

if [ "$CHANGED" -gt "0" ]; then
  R2_STATUS="R2 synced (exit=$R2_EXIT)"
  COMMIT_MSG="Sync Jarvis: run $RUN_ID complete ($DONE done, $STOP); $EXP_COUNT derived; $CANDS candidates remain; $R2_STATUS — zygarnik/open-loop/pre-upload 0.70 bias; top recent r=$TOP_R"
  git commit -m "$COMMIT_MSG" >> "$LOG" 2>&1
  git push origin master >> "$LOG" 2>&1
  PUSH_EXIT=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Committed and pushed exit=$PUSH_EXIT" >> "$LOG"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] No changes to commit." >> "$LOG"
fi

# Launch next bounded zygarnik/open-loop/pre-upload run (25 min, 3000 iterations, 0.70 pre-upload bias)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Launching next autorun..." >> "$LOG"
cd "$JARVIS_DIR"
nohup node launch-autorun.js >> "$LOG" 2>&1 &
RL_PID=$!
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Autorun launched pid=$RL_PID" >> "$LOG"

# Give it 90s to start, then spawn the watch-and-sync watcher
sleep 90
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Spawning watch-and-sync watcher..." >> "$LOG"
nohup bash "$JARVIS_DIR/watch-and-sync.sh" >> "$LOG" 2>&1 &
W_PID=$!
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Watcher spawned pid=$W_PID" >> "$LOG"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cron_sync_and_relaunch done." >> "$LOG"
