#!/bin/bash
# Novelty-forced viral-idea discovery + RAFT loop. Discover diverse high-keep ideas (idea_train),
# then RAFT the model on its accepted discoveries, repeat with the improved model. Until 8h or dry.
set -o pipefail
cd /home/ubuntu/hookrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 8*3600 ))
PREV=/home/ubuntu/hookrl/models/qwen3-30b-a3b
N=1; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "8h deadline"; break; }
  BEFORE=$(wc -l < runs/discover1/accepted.jsonl 2>/dev/null || echo 0)
  if [ $N -eq 1 ]; then BUD=2500; else BUD=8000; fi
  log "=== round $N : discover with $(basename $PREV) (budget $BUD, novelty-gated) ==="
  RUN=discover1 MODEL=$PREV G=8 IMG_BUDGET=$BUD $V idea_train.py 2>&1 | grep -vE "Loading weights|it/s\]"
  AFTER=$(wc -l < runs/discover1/accepted.jsonl 2>/dev/null || echo 0); GOT=$(( AFTER - BEFORE ))
  log "round $N accepted $GOT new ideas (total $AFTER)"
  if [ "$GOT" -lt 4 ]; then STRIKES=$(( STRIKES + 1 )); log "round $N few new (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "viral landscape exhausted at this quality bar"; break; }; N=$(( N + 1 )); continue; fi
  STRIKES=0
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== round $N : RAFT -> idea_r$N ==="
  IDEA_ROUND=$N $V idea_update.py 2>&1 | grep -vE "Loading weights|it/s\]" || { log "RAFT$N failed, stopping"; break; }
  PREV=/home/ubuntu/hookrl/models/ideamerged_r$N
  N=$(( N + 1 ))
done
log "=== DISCOVER_OVERNIGHT_DONE (last: $(basename $PREV)) ==="
