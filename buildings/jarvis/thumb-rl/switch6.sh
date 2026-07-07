#!/bin/bash
# waits for round-5 DPO to finish (never interrupts training), then relaunches the loop in G=6 render-all mode
cd /home/ubuntu/thumbrl
while true; do
  [ -d models/thumbmerged_r5 ] && { M=models/thumbmerged_r5; break; }
  grep -q 'update5 failed' overnight5.log 2>/dev/null && { M=models/thumbmerged_r1; break; }
  sleep 30
done
sleep 20
tmux kill-session -t main 2>/dev/null
pkill -9 -f 'thumb_[h]arvest' 2>/dev/null; pkill -9 -f 'thumb_[o]vernight' 2>/dev/null
sleep 3
tmux new-session -d -s main "START_ROUND=6 START_MODEL=/home/ubuntu/thumbrl/$M bash /home/ubuntu/thumbrl/start_main.sh"
