#!/bin/bash
# CHAIN launcher: idea model (latest) + thumb_b10 validator. Rounds start at 20 to separate from the
# text-only era (runs idea1-11).
cd /home/ubuntu/thumbrl
export STATUS_KEY=longform/idea-rl/status.json
START_ROUND=${START_ROUND:-20} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/ideamerged_long_r11} \
GBATCH=64 IDEA_BUDGET=1500 TEXT_GATE=0.55 CHAIN_MAX=400 K=2 VIS_FLOOR=0.70 \
bash idea_overnight.sh > ideachain.log 2>&1
