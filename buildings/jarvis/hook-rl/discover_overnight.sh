#!/bin/bash
# OVERNIGHT: push the AVERAGE accepted-idea keep toward the 90th percentile via a rising-floor
# curriculum (ReST). Each round: discover high-keep + novel ideas at the current floor, RAFT the
# model on the best of them, raise the floor, repeat. The model's typical output climbs over rounds.
# Demo stays served throughout (idea_train.serve_requests). Saves each round's adapter to R2.
set -o pipefail
cd /home/ubuntu/hookrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 9*3600 ))     # ~9h training window
PREV=/home/ubuntu/hookrl/models/qwen3-30b-a3b
N=1
while [ $(date +%s) -lt $DEADLINE ]; do
  FLOOR=$($V -c "print('%.2f'%min(0.90, 0.76 + 0.02*($N-1)))")   # 0.76 -> 0.90 over ~8 rounds
  BUD=1600   # ~1h discover/round -> many RAFT rounds in the window so the floor ratchets to 90
  BEFORE=$(wc -l < runs/discover1/accepted.jsonl 2>/dev/null || echo 0)
  log "=== round $N : discover with $(basename $PREV) (budget $BUD, KEEP_FLOOR=$FLOOR) ==="
  RUN=discover1 MODEL=$PREV G=8 IMG_BUDGET=$BUD KEEP_FLOOR=$FLOOR NOV_FLOOR=0.18 $V idea_train.py 2>&1 | grep -vE "Loading weights|it/s\]"
  AFTER=$(wc -l < runs/discover1/accepted.jsonl 2>/dev/null || echo 0)
  log "round $N accepted $(( AFTER - BEFORE )) new (total $AFTER)"
  [ $(date +%s) -ge $DEADLINE ] && break
  log "=== round $N : RAFT -> idea_r$N (train on best accepted) ==="
  if IDEA_ROUND=$N $V idea_update.py 2>&1 | grep -vE "Loading weights|it/s\]"; then
    PREV=/home/ubuntu/hookrl/models/ideamerged_r$N
    echo "$PREV" > /home/ubuntu/hookrl/models/LATEST
    log "round $N model -> $(basename $PREV)"
  else
    log "RAFT$N failed — keep discovering with $(basename $PREV)"
  fi
  N=$(( N + 1 ))
done
log "=== DISCOVER_DONE (last model: $(basename $PREV)). Serving demo until terminated. ==="
MODEL=$PREV $V serve_only.py     # keep the Experiments demo live with the trained model
