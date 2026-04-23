#!/bin/bash
# Watch for run completion, then sync R2 and commit/push
# Run as background process by cron watcher

JARVIS_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis"
REPO_DIR="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
LOG="$JARVIS_DIR/watch-sync.log"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] watch-and-sync started" >> "$LOG"

STALE_MINUTES=3
RUN_STALLED=false

# Poll until run is no longer active or appears stalled
for i in $(seq 1 60); do
  sleep 30
  ACTIVE=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('active','false'))" 2>/dev/null)
  UPDATED=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('updated_at',''))" 2>/dev/null)
  COMPLETED=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('completed',0))" 2>/dev/null)
  RUN_PID=$(pgrep -f "node .*buildings/jarvis/launch-autorun.js" | head -n 1)
  STALE=$(python3 - <<PY 2>/dev/null
import json, datetime
try:
    d=json.load(open('$JARVIS_DIR/autonomous_progress.json'))
    updated=d.get('updated_at')
    if not updated:
        print('false')
    else:
        dt=datetime.datetime.fromisoformat(updated.replace('Z','+00:00'))
        age=(datetime.datetime.now(datetime.timezone.utc)-dt).total_seconds()/60
        print('true' if age > $STALE_MINUTES else 'false')
except Exception:
    print('false')
PY
)
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] active=$ACTIVE completed=$COMPLETED updated=$UPDATED stale=$STALE pid=${RUN_PID:-none}" >> "$LOG"

  if [ "$ACTIVE" = "False" ] || [ "$ACTIVE" = "false" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Run complete. Syncing R2..." >> "$LOG"
    break
  fi

  if [ "$STALE" = "true" ] && [ -z "$RUN_PID" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Detected stalled autorun (active=true but stale heartbeat and no launch-autorun pid). Marking run stalled and recovering..." >> "$LOG"
    python3 - <<PY >> "$LOG" 2>&1
import json, datetime
path='$JARVIS_DIR/autonomous_progress.json'
with open(path) as f:
    d=json.load(f)
now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
d['active']=False
if not d.get('finished_at'):
    d['finished_at']=now
d['updated_at']=now
d['stop_reason']='process_died_watchdog'
d['current_candidate']=None
with open(path,'w') as f:
    json.dump(d,f,indent=2)
    f.write('\n')
print(f"updated autonomous_progress stop_reason={d['stop_reason']}")
PY
    RUN_STALLED=true
    break
  fi
done

# Get final experiment count
EXP_COUNT=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/derived_experiments_compact.json')); print(len(d))" 2>/dev/null)
RUN_ID=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('run_id','unknown'))" 2>/dev/null)
DONE=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('completed',0))" 2>/dev/null)
STOP=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('stop_reason','?'))" 2>/dev/null)
CANDS=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/candidate_queue.json')); print(len(d))" 2>/dev/null)
TOP_R=$(python3 -c "import json; d=json.load(open('$JARVIS_DIR/autonomous_progress.json')); print(d.get('last_completed_r',0))" 2>/dev/null)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Syncing to R2... exp_count=$EXP_COUNT" >> "$LOG"

# Sync to R2
cd "$JARVIS_DIR"
node sync-to-r2.js >> "$LOG" 2>&1
R2_EXIT=$?
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] R2 sync exit=$R2_EXIT" >> "$LOG"

# Commit and push
cd "$REPO_DIR"
git add buildings/jarvis/autonomous_progress.json buildings/jarvis/graph.json buildings/jarvis/resolutions.json buildings/jarvis/derived_experiments.json buildings/jarvis/derived_experiments_compact.json buildings/jarvis/experiments_log.json buildings/jarvis/experiments_log_compact.json buildings/jarvis/indicators.json buildings/jarvis/indicators_compact.json buildings/jarvis/candidate_queue.json buildings/jarvis/autonomous_runs.json buildings/jarvis/indicator-registry.json 2>/dev/null

CHANGED=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] staged changed files=$CHANGED" >> "$LOG"

if [ "$CHANGED" -gt "0" ]; then
  COMMIT_MSG="Sync Jarvis state: run $RUN_ID complete ($DONE done, $STOP); $EXP_COUNT derived experiments; $CANDS candidates remain; R2 synced — pre-upload 0.70 bias, top new r=$TOP_R"
  git commit -m "$COMMIT_MSG" >> "$LOG" 2>&1
  git push origin master >> "$LOG" 2>&1
  PUSH_EXIT=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Committed and pushed. exit=$PUSH_EXIT" >> "$LOG"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] No staged changes to commit." >> "$LOG"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] watch-and-sync complete." >> "$LOG"

# Relaunch next bounded run
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Relaunching next autorun..." >> "$LOG"
nohup node "$JARVIS_DIR/launch-autorun.js" >> "$LOG" 2>&1 &
RL_PID=$!
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Relaunch pid=$RL_PID" >> "$LOG"

# Spawn a fresh watch-and-sync for the new run (give it 90s to initialize)
sleep 90
nohup bash "$JARVIS_DIR/watch-and-sync.sh" >> "$LOG" 2>&1 &
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] New watcher spawned." >> "$LOG"
