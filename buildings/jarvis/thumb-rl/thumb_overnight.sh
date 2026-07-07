#!/bin/bash
# Long-form THUMBNAIL RL loop — vLLM harvest (full 1500-token reasoning) + RAFT LoRA update.
# Speed comes from the ENVIRONMENT: vLLM MoE kernels + batched generation + parallel rendering.
# Robust round counting via runs/thumbN/_produced (the wc -l diff broke on resume-seeding).
# Each round is its own run name (thumb1, thumb2, ...) so guesses never collide and every round's
# data is self-contained. Harvest value is banked BEFORE the update, so a training failure never
# throws away the guesses.
set -o pipefail
cd /home/ubuntu/thumbrl
V="venv/bin/python"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
DEADLINE=$(( $(date +%s) + 20*3600 ))
PREV=${START_MODEL:-/home/ubuntu/thumbrl/models/qwen3-30b-a3b}   # round 1 = base model (override to resume)
N=${START_ROUND:-1}; STRIKES=0
while true; do
  [ $(date +%s) -ge $DEADLINE ] && { log "20h deadline"; break; }
  # FAST-DPO cadence: small rounds (default 800 renders = ~400 titles x 2 proxy-picked renders) so the
  # policy iterates ~6-8x/day instead of 2. Proxy retrains from ALL rendered evidence each round.
  BUD=${ROUND_BUDGET:-800}
  rm -f runs/thumb$N/_produced
  log "=== round $N : proxy retrain (prompt-text -> pctile, r>=0.3 gate) ==="
  $V -u proxy_train.py 2>&1 | grep -aE 'proxy|PROXY' | tail -3 || log "proxy retrain failed — harvest falls back to render-all"
  log "=== round $N : vLLM harvest with $(basename $PREV) (budget $BUD, PROXY_G=${PROXY_G:-10}, full reasoning) ==="
  RUN=thumb$N MODEL=$PREV G=5 PROXY_G=${PROXY_G:-10} TBATCH=${TBATCH:-16} MAXNEW=1500 IMG_BUDGET=$BUD $V -u thumb_harvest.py 2>&1 \
    | grep -avE 'it/s|Adding requests|Processed prompts|Loading safetensors|Capturing|profile'
  GOT=$(cat runs/thumb$N/_produced 2>/dev/null || echo 0)
  log "round $N produced $GOT new groups (banked to R2)"
  if [ "$GOT" -lt 8 ]; then STRIKES=$((STRIKES+1)); log "thin round (strike $STRIKES/2)"; [ $STRIKES -ge 2 ] && { log "stopping"; break; }; N=$((N+1)); continue; fi
  STRIKES=0
  [ $(date +%s) -ge $DEADLINE ] && break
  # First RAFT_ROUNDS rounds = RAFT (imitate within-title winners); after that = DPO (best-vs-worst-per-title contrast)
  if [ $N -le ${RAFT_ROUNDS:-0} ]; then
    log "=== round $N : RAFT LoRA update -> thumb_r$N ==="
    THUMB_ROUND=$N $V thumb_update.py 2>&1 | grep -avE 'it/s|Loading'; RC=${PIPESTATUS[0]}
  else
    log "=== round $N : DPO preference update (best-vs-worst per title, recent rounds) -> thumb_r$N ==="
    THUMB_ROUND=$N DPO_INIT=$PREV DPO_RUNS="thumb$N,thumb$((N-1))" $V thumb_dpo.py 2>&1 | grep -avE 'it/s|Loading'; RC=${PIPESTATUS[0]}
  fi
  if [ "$RC" = "0" ] && [ -d /home/ubuntu/thumbrl/models/thumbmerged_r$N ]; then
    PREV=/home/ubuntu/thumbrl/models/thumbmerged_r$N; log "round $N trained -> $(basename $PREV)"
  else
    log "update$N failed/skipped (guesses are safe) — continuing on the SAME model"
    # surface it in the UI banner too — a broken training step must never be log-only
    $V -c "import harness_long as H; H.write_status('update-failed','round $N LoRA update failed — harvest continues on prior model; check overnight log')" 2>/dev/null || true
  fi
  N=$((N+1))
done
log "=== THUMB_OVERNIGHT_DONE (last model: $(basename $PREV)) ==="
