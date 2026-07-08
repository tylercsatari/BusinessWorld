#!/bin/bash
# IDEA-MODEL CHAIN loop (the user's specified architecture):
#   Stage A: IDEA model invents candidates (text axis = cheap prefilter only)
#   Stage B: THUMBNAIL model (thumb_b10) writes prompts → REAL renders → VISUAL ctrviews score = the reward
#   Update : RAFT the idea model on chain-validated winners. Repeat with rising visual floor.
# Two sequential vLLM loads per round (clean GPU handoff between models).
set -o pipefail
cd /home/ubuntu/thumbrl
export STATUS_KEY=longform/idea-rl/status.json
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 20*3600 ))
PREV=${START_MODEL:-/home/ubuntu/thumbrl/models/qwen3-30b-a3b}
PREV2=$PREV
N=${START_ROUND:-20}; VFLOOR=${VIS_FLOOR:-0.70}; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "deadline"; break; }
  rm -f runs/idea$N/_produced
  log "=== chain round $N · STAGE A: ideas from $(basename $PREV) ==="
  RUN=idea$N MODEL=$PREV GBATCH=${GBATCH:-64} IDEA_BUDGET=${IDEA_BUDGET:-1500} TEXT_GATE=${TEXT_GATE:-0.55} \
    $V -u idea_gen_stage.py 2>&1 | grep -avE 'it/s|Adding requests|Processed prompts|Loading safetensors|Capturing|profile'
  log "=== chain round $N · STAGE B: validate through thumb_b10 + renders (floor $VFLOOR) ==="
  RUN=idea$N THUMB_MODEL=${THUMB_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_b10} K=${K:-2} VIS_FLOOR=$VFLOOR CHAIN_MAX=${CHAIN_MAX:-400} \
    $V -u idea_validate_stage.py 2>&1 | grep -avE 'it/s|Adding requests|Processed prompts|Loading safetensors|Capturing|profile'
  GOT=$(cat runs/idea$N/_produced 2>/dev/null || echo 0)
  log "round $N chain-accepted $GOT ideas"
  if [ "$GOT" -lt 25 ]; then STRIKES=$((STRIKES+1)); log "thin round (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$((N+1)); continue; fi
  STRIKES=0
  GATE=$($V -c "
import json
def avg(p):
    try:
        xs=[json.loads(l)['pctile'] for l in open(p) if l.strip()]
        return sum(xs)/len(xs) if len(xs)>=50 else None
    except Exception: return None
cur=avg('runs/idea$N/index.jsonl'); prev=avg('runs/idea$((N-1))/index.jsonl')
print(('REVERT' if (cur is not None and prev is not None and cur < prev-0.03) else 'OK'), (round(cur*100,1) if cur is not None else '?'), (round(prev*100,1) if prev is not None else '?'))" 2>/dev/null)
  set -- $GATE; VERDICT=${1:-OK}; CURAVG=${2:-?}; PREVAVG=${3:-?}
  log "gate: round $N chain-avg ${CURAVG}th vs prev ${PREVAVG}th -> $VERDICT"
  if [ "$VERDICT" = "REVERT" ]; then
    log "REGRESSION — reverting to $(basename $PREV2)"
    $V -c "import os; os.environ['STATUS_KEY']='longform/idea-rl/status.json'; import harness_long as H; H.write_status('reverted','idea round $N ${CURAVG}th < ${PREVAVG}th')" 2>/dev/null || true
    PREV=$PREV2
  fi
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== chain round $N · UPDATE: RAFT idea model on chain-validated winners ==="
  IDEA_ROUND=$N EPOCHS=2 $V idea_update.py 2>&1 | grep -avE 'it/s|Loading'; RC=${PIPESTATUS[0]}
  if [ "$RC" = "0" ] && [ -d /home/ubuntu/thumbrl/models/ideamerged_long_r$N ]; then
    PREV2=$PREV; PREV=/home/ubuntu/thumbrl/models/ideamerged_long_r$N; log "round $N -> $(basename $PREV)"
  else
    log "update$N failed (ideas safe) — continuing on SAME model"
    $V -c "import os; os.environ['STATUS_KEY']='longform/idea-rl/status.json'; import harness_long as H; H.write_status('update-failed','idea round $N SFT failed')" 2>/dev/null || true
  fi
  VFLOOR=$($V -c "print(min(0.85, $VFLOOR + 0.02))")
  N=$((N+1))
done
log "=== IDEA_CHAIN_DONE (last: $(basename $PREV)) ==="
