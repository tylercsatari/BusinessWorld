#!/bin/bash
# fast-box loop: G=6 RENDER-ALL (real within-group signal — proxy-2 was proven no better than random
# within a title), DAPO-style low-spread filtering happens in thumb_dpo via MINGAP.
cd /home/ubuntu/thumbrl
START_ROUND=${START_ROUND:-6} START_MODEL=${START_MODEL:-/home/ubuntu/thumbrl/models/thumbmerged_r5} \
TITLE_SHARD=0/2 G=6 PROXY_G=0 TBATCH=26 ROUND_BUDGET=1800 MAXNEW=1500 bash thumb_overnight.sh > overnight6.log 2>&1
