#!/bin/bash
# Deep overnight ReST loop: harvest (fresh unique ideas) -> SFT base on ALL accumulated winners ->
# repeat, until 8.5h OR Replicate runs dry. Then terminate the H100 so it stops billing.
cd /home/ubuntu/hookrl
V="vllm_venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 8*3600 + 1800 ))   # 8.5 hours from launch
PREV=/home/ubuntu/hookrl/models/merged_r1     # start from the SFT1 model we already have
N=2
STRIKES=0

while true; do
  if [ $(date +%s) -ge $DEADLINE ]; then log "8.5h deadline reached"; break; fi
  BEFORE=$(wc -l < runs/phase$N/manifest.jsonl 2>/dev/null || echo 0)
  log "=== round $N : harvest phase$N with $(basename $PREV) (budget 10000 imgs) ==="
  RUN=phase$N MODEL=$PREV IMG_BUDGET=10000 PYTHONNOUSERSITE=1 $V harvest.py 2>&1 | grep -vE "Loading weights|it/s\]"
  HOOKS=$(wc -l < runs/phase$N/manifest.jsonl 2>/dev/null || echo 0)
  GAINED=$(( HOOKS - BEFORE ))
  log "round $N harvested $GAINED new hooks (total $HOOKS)"
  if [ "$GAINED" -lt 8 ]; then
    STRIKES=$(( STRIKES + 1 )); log "round $N added ~0 new hooks (strike $STRIKES/2 — Replicate dry or harvest error)"
    if [ $STRIKES -ge 2 ]; then log "2 empty rounds -> stopping loop"; break; fi
    N=$(( N + 1 )); continue
  fi
  STRIKES=0
  if [ $(date +%s) -ge $DEADLINE ]; then log "deadline during harvest"; break; fi
  log "=== round $N : SFT base on ALL accumulated winners -> merged_r$N ==="
  SFT_ROUND=$N SRC_RUN=all PCTILE_MIN=0.5 PYTHONNOUSERSITE=1 $V sft.py 2>&1 | grep -vE "Loading weights|it/s\]" || { log "SFT$N failed, stopping"; break; }
  PREV=/home/ubuntu/hookrl/models/merged_r$N
  N=$((N+1))
done

log "=== OVERNIGHT_DONE (last model: $(basename $PREV)) — terminating instance to stop GPU billing ==="
PYTHONNOUSERSITE=1 $V terminate.py
log "=== terminate.py returned; if still up, terminate manually in the Lambda dashboard ==="
