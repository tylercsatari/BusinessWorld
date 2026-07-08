#!/bin/bash
# IDEA-MODEL loop launcher (long-form): invent -> text-score -> novelty gate -> RAFT -> repeat.
cd /home/ubuntu/thumbrl
export STATUS_KEY=longform/idea-rl/status.json
START_ROUND=${START_ROUND:-1} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/qwen3-30b-a3b} \
GBATCH=64 IDEA_BUDGET=2000 SCORE_FLOOR=0.70 NOV_FLOOR=0.22 \
bash idea_overnight.sh > idea1.log 2>&1
