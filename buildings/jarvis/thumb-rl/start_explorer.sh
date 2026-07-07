#!/bin/bash
# explorer launcher: continuous fresh-title harvesting on shard 1/2, restarts harvest if it exits
cd /home/ubuntu/thumbrl
while true; do
  RUN=thumb30 MODEL=${EXP_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_r1} TITLE_SHARD=1/2 \
  TBATCH=16 PROXY_G=10 IMG_BUDGET=60000 venv/bin/python -u thumb_harvest.py >> explorer.log 2>&1
  sleep 60
done
