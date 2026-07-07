#!/bin/bash
# fast-box loop launcher (lives on the box so remote pkill patterns never appear in SSH cmdlines)
cd /home/ubuntu/thumbrl
START_ROUND=${START_ROUND:-5} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_r1} \
TITLE_SHARD=0/2 TBATCH=16 PROXY_G=10 ROUND_BUDGET=800 bash thumb_overnight.sh > overnight5.log 2>&1
