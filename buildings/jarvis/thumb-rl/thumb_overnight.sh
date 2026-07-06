#!/bin/bash
# Long-form THUMBNAIL RL loop: per-title group harvest (reason->1 thumbnail x G=5, relevance-gated
# ctrviews-percentile reward, per-title advantage) -> RAFT update -> repeat with the improved model.
# Round 1 starts from the BASE Qwen3-30B-A3B. Stops at ~11h or 2 dry rounds. Budget is sized so total
# renders ~= 50000 (the $150 Replicate budget at $0.003/img): round1 3000 to validate the cycle fast,
# then ~10000/round.
set -o pipefail
cd /home/ubuntu/thumbrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 11*3600 ))
PREV=/home/ubuntu/thumbrl/models/qwen3-30b-a3b   # round 1 = base model (no prior thumb LoRA yet)
N=1; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "11h deadline"; break; }
  BEFORE=$(wc -l < runs/thumb$N/index.jsonl 2>/dev/null || echo 0)
  if [ $N -eq 1 ]; then BUD=3000; else BUD=10000; fi   # small first round to validate the cycle fast
  log "=== round $N : thumb_harvest with $(basename $PREV) (budget $BUD, G=5) ==="
  RUN=thumb$N MODEL=$PREV G=5 IMG_BUDGET=$BUD $V thumb_harvest.py 2>&1 | grep -vE "Loading weights|it/s\]"
  AFTER=$(wc -l < runs/thumb$N/index.jsonl 2>/dev/null || echo 0); GOT=$(( AFTER - BEFORE ))
  log "round $N got $GOT title-groups (total $AFTER)"
  if [ "$GOT" -lt 4 ]; then STRIKES=$(( STRIKES + 1 )); log "round $N ~0 groups (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$(( N + 1 )); continue; fi
  STRIKES=0
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== round $N : THUMB update -> thumb_r$N ==="
  THUMB_ROUND=$N $V thumb_update.py 2>&1 | grep -vE "Loading weights|it/s\]" || { log "update$N failed, stopping"; break; }
  PREV=/home/ubuntu/thumbrl/models/thumbmerged_r$N
  N=$(( N + 1 ))
done
log "=== THUMB_OVERNIGHT_DONE (last: $(basename $PREV)) ==="
