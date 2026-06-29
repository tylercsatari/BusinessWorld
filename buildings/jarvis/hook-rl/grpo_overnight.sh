#!/bin/bash
# GRPO loop: per-input group harvest (reason->5 frames x G, relevance-gated reward, per-input
# advantage) -> RAFT update -> repeat with the improved model. Until 8h or 2 dry rounds.
set -o pipefail
cd /home/ubuntu/hookrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 8*3600 ))
PREV=/home/ubuntu/hookrl/models/qwen3-30b-a3b
N=1; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "8h deadline"; break; }
  BEFORE=$(wc -l < runs/grpo$N/index.jsonl 2>/dev/null || echo 0)
  if [ $N -eq 1 ]; then BUD=2500; else BUD=8000; fi   # small first round to validate the cycle fast
  log "=== round $N : grpo_harvest with $(basename $PREV) (budget $BUD, G=8) ==="
  RUN=grpo$N MODEL=$PREV G=8 IMG_BUDGET=$BUD $V grpo_harvest.py 2>&1 | grep -vE "Loading weights|it/s\]"
  AFTER=$(wc -l < runs/grpo$N/index.jsonl 2>/dev/null || echo 0); GOT=$(( AFTER - BEFORE ))
  log "round $N got $GOT input-groups (total $AFTER)"
  if [ "$GOT" -lt 4 ]; then STRIKES=$(( STRIKES + 1 )); log "round $N ~0 groups (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$(( N + 1 )); continue; fi
  STRIKES=0
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== round $N : GRPO update -> grpo_r$N ==="
  GRPO_ROUND=$N $V grpo_update.py 2>&1 | grep -vE "Loading weights|it/s\]" || { log "update$N failed, stopping"; break; }
  PREV=/home/ubuntu/hookrl/models/grpomerged_r$N
  N=$(( N + 1 ))
done
log "=== GRPO_OVERNIGHT_DONE (last: $(basename $PREV)) ==="
