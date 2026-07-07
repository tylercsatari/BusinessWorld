#!/bin/bash
# polls Replicate every 15 min with ONE real test render ($0.003 when funded); the moment billing works,
# relaunches the training loop at round 7 from thumb_r6 and exits.
cd /home/ubuntu/thumbrl
while true; do
  R=$(venv/bin/python -c "
import harness_long as H
try:
    img = H.flux_schnell('a plain gray square, test render', tries=1)
    print('OK' if img else 'FAIL')
except H.BillingHalt: print('BILL')
except Exception: print('FAIL')
" 2>/dev/null)
  if [ "$R" = "OK" ]; then
    venv/bin/python -c "import harness_long as H; H.write_status('running','Replicate refilled — resuming round 7 on thumb_r6')" 2>/dev/null
    tmux new-session -d -s main "START_ROUND=7 START_MODEL=/home/ubuntu/thumbrl/models/thumbmerged_r6 bash /home/ubuntu/thumbrl/start_main.sh"
    exit 0
  fi
  sleep 900
done
