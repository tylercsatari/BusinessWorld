#!/bin/bash
# DPO loop on the KEEP-RATE axis: harvest best/worst pairs -> DPO -> repeat, until 8h or pairs dry.
cd /home/ubuntu/hookrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 8*3600 ))
PREV=/home/ubuntu/hookrl/models/qwen3-30b-a3b   # round 1 collects pairs from the BASE model
N=1; STRIKES=0
while true; do
  if [ $(date +%s) -ge $DEADLINE ]; then log "8h deadline"; break; fi
  BEFORE=$(wc -l < runs/keep$N/pairs.jsonl 2>/dev/null || echo 0)
  if [ $N -eq 1 ]; then BUD=3000; else BUD=10000; fi   # small first round to validate the harvest->DPO cycle fast
  log "=== round $N : harvest_dpo with $(basename $PREV) (budget $BUD) ==="
  RUN=keep$N MODEL=$PREV IMG_BUDGET=$BUD PYTHONNOUSERSITE=1 $V harvest_dpo.py 2>&1 | grep -vE "Loading weights|it/s\]"
  P=$(wc -l < runs/keep$N/pairs.jsonl 2>/dev/null || echo 0); G=$(( P - BEFORE ))
  log "round $N got $G new pairs (total $P)"
  if [ "$G" -lt 8 ]; then STRIKES=$(( STRIKES + 1 )); log "round $N ~0 new pairs (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$(( N + 1 )); continue; fi
  STRIKES=0
  if [ $(date +%s) -ge $DEADLINE ]; then break; fi
  log "=== round $N : DPO -> dpo_r$N ==="
  DPO_ROUND=$N PYTHONNOUSERSITE=1 $V dpo.py 2>&1 | grep -vE "Loading weights|it/s\]" || { log "DPO$N failed, stopping"; break; }
  PREV=/home/ubuntu/hookrl/models/dpomerged_r$N
  N=$(( N + 1 ))
done
log "=== OVERNIGHT_KEEP_DONE (last: $(basename $PREV)) — terminating ==="
PYTHONNOUSERSITE=1 $V terminate.py
log "=== terminate returned (if up, kill manually in dashboard) ==="
