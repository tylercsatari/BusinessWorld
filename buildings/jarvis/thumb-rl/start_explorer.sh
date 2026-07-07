#!/bin/bash
# explorer: same G=6 render-all mode, disjoint shard, feeds pairs into every DPO
cd /home/ubuntu/thumbrl
while true; do
  RUN=thumb30 MODEL=${EXP_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_r1} TITLE_SHARD=1/2 \
  G=6 PROXY_G=0 TBATCH=26 MAXNEW=1500 IMG_BUDGET=60000 venv/bin/python -u thumb_harvest.py >> explorer.log 2>&1
  sleep 60
done
