#!/bin/bash
# LONG-FORM IDEA model loop: invent -> text-score (r=0.68 axis) + novelty gate -> RAFT accepted -> repeat.
# Score floor rises +0.02/round (curriculum, cap 0.85) so the bar climbs with the model. Text-only: no
# render spend. Gate: a round's GENERATED avg pctile must not drop >3pts vs the previous round.
set -o pipefail
cd /home/ubuntu/thumbrl
export STATUS_KEY=longform/idea-rl/status.json
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 20*3600 ))
PREV=${START_MODEL:-/home/ubuntu/thumbrl/models/qwen3-30b-a3b}
PREV2=$PREV
N=${START_ROUND:-1}; FLOOR=${SCORE_FLOOR:-0.70}; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "deadline"; break; }
  rm -f runs/idea$N/_produced
  log "=== idea round $N : harvest with $(basename $PREV) (floor $FLOOR, nov ${NOV_FLOOR:-0.22}) ==="
  RUN=idea$N MODEL=$PREV GBATCH=${GBATCH:-64} IDEA_BUDGET=${IDEA_BUDGET:-2000} SCORE_FLOOR=$FLOOR NOV_FLOOR=${NOV_FLOOR:-0.22} \
    $V -u idea_harvest.py 2>&1 | grep -avE 'it/s|Adding requests|Processed prompts|Loading safetensors|Capturing|profile'
  GOT=$(cat runs/idea$N/_produced 2>/dev/null || echo 0)
  log "round $N accepted $GOT new ideas"
  if [ "$GOT" -lt 30 ]; then STRIKES=$((STRIKES+1)); log "thin round (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$((N+1)); continue; fi
  STRIKES=0
  GATE=$($V -c "
import json
def avg(p):
    try:
        xs=[json.loads(l)['pctile'] for l in open(p) if l.strip()]
        return sum(xs)/len(xs) if len(xs)>=100 else None
    except Exception: return None
cur=avg('runs/idea$N/index.jsonl'); prev=avg('runs/idea$((N-1))/index.jsonl')
print(('REVERT' if (cur is not None and prev is not None and cur < prev-0.03) else 'OK'), (round(cur*100,1) if cur is not None else '?'), (round(prev*100,1) if prev is not None else '?'))" 2>/dev/null)
  set -- $GATE; VERDICT=${1:-OK}; CURAVG=${2:-?}; PREVAVG=${3:-?}
  log "gate: round $N generated-avg ${CURAVG}th vs prev ${PREVAVG}th -> $VERDICT"
  if [ "$VERDICT" = "REVERT" ]; then
    log "REGRESSION — reverting to $(basename $PREV2)"
    $V -c "import os; os.environ['STATUS_KEY']='longform/idea-rl/status.json'; import harness_long as H; H.write_status('reverted','idea round $N ${CURAVG}th < ${PREVAVG}th')" 2>/dev/null || true
    PREV=$PREV2
  fi
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== idea round $N : RAFT update -> idea_long_r$N ==="
  IDEA_ROUND=$N EPOCHS=2 $V idea_update.py 2>&1 | grep -avE 'it/s|Loading'; RC=${PIPESTATUS[0]}
  if [ "$RC" = "0" ] && [ -d /home/ubuntu/thumbrl/models/ideamerged_long_r$N ]; then
    PREV2=$PREV; PREV=/home/ubuntu/thumbrl/models/ideamerged_long_r$N; log "round $N -> $(basename $PREV)"
  else
    log "update$N failed (ideas safe) — continuing on SAME model"
    $V -c "import os; os.environ['STATUS_KEY']='longform/idea-rl/status.json'; import harness_long as H; H.write_status('update-failed','idea round $N SFT failed')" 2>/dev/null || true
  fi
  FLOOR=$($V -c "print(min(0.85, $FLOOR + 0.02))")
  N=$((N+1))
done
log "=== IDEA_OVERNIGHT_DONE (last: $(basename $PREV)) ==="
