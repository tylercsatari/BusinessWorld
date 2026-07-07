#!/bin/bash
# POST-BOND SEQUENCE (invoked automatically when thumb_b1 training finishes):
#  1. A/B arm 1 — eval thumb_b1 (BOND, no-think) on ~150 fresh titles, render-all-6 (RUN=thumb31)
#  2. A/B arm 2 — resume the loop at round 7 on thumb_r6: its harvest IS the r6 arm on fresh titles
# Same mode, same metric, iid fresh titles → direct comparison; r1's 68.5th is the standing reference.
cd /home/ubuntu/thumbrl
R=$(venv/bin/python -c "
import harness_long as H
try: print('OK' if H.flux_schnell('gray square test', tries=2) else 'FAIL')
except Exception as e: print('FAIL')" 2>/dev/null)
if [ "$R" != "OK" ]; then
  venv/bin/python -c "import harness_long as H; H.write_status('halted-replicate','still no credits at eval time')" 2>/dev/null
  exec bash -c 'while true; do sleep 900; bash /home/ubuntu/thumbrl/replicate_watch.sh && break; done'
fi
venv/bin/python -c "import harness_long as H; H.write_status('running','A/B eval: thumb_b1 (BOND no-think) on fresh titles')" 2>/dev/null
RUN=thumb31 MODEL=/home/ubuntu/thumbrl/models/thumbmerged_b1 NOTHINK=1 TITLE_SHARD=1/2 \
  G=6 PROXY_G=0 TBATCH=26 MAXNEW=350 IMG_BUDGET=900 venv/bin/python -u thumb_harvest.py > evalb1.log 2>&1
venv/bin/python -c "import harness_long as H; H.write_status('running','b1 eval done — resuming round 7 on thumb_r6 (r6 arm of the A/B)')" 2>/dev/null
tmux new-session -d -s main "START_ROUND=7 START_MODEL=/home/ubuntu/thumbrl/models/thumbmerged_r6 bash /home/ubuntu/thumbrl/start_main.sh"
