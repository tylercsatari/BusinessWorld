#!/bin/bash
# ITERATED BOND loop: no-think fast harvest (G=6 render-all) -> re-distill ALL banked winners -> repeat.
cd /home/ubuntu/thumbrl
START_ROUND=${START_ROUND:-8} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_b1} \
UPDATER=bond NOTHINK=1 MAXNEW=350 TITLE_SHARD=0/2 G=6 PROXY_G=0 TBATCH=26 ROUND_BUDGET=1800 \
bash thumb_overnight.sh > overnight8.log 2>&1
