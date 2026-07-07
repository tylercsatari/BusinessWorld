#!/bin/bash
# ITERATED BOND loop v2: meatier rounds (400 titles), FULL 2-epoch re-distillation each cycle
# (1-epoch from-scratch BOND under-trained b8: 68.2 vs b1's 71.9 — the gate caught it).
cd /home/ubuntu/thumbrl
START_ROUND=${START_ROUND:-10} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_b1} \
UPDATER=bond BOND_EPOCHS=2 NOTHINK=1 MAXNEW=350 TITLE_SHARD=0/2 G=6 PROXY_G=0 TBATCH=26 ROUND_BUDGET=2400 \
bash thumb_overnight.sh > overnight10.log 2>&1
