#!/bin/bash
# GENTLE poller: ONE launch attempt every ~18s (≈3 req/min, safe under Cloudflare 1015), rotating
# through 80GB+ targets. Grabs the first that lands, writes instance_id.txt, exits 0.
# The Lambda API key is read from ./lambda_key.txt (NOT hardcoded) — put your key there first.
cd "$(dirname "$0")"
if [ ! -s lambda_key.txt ]; then echo "!! put your Lambda API key in lambda_key.txt first"; exit 2; fi
KEY=$(cat lambda_key.txt | tr -d '[:space:]')
# GH200 us-east-3 appears most often, so weight it; interleave H100 regions.
TARGETS=(
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 us-east-1"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 us-west-1"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 us-west-2"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 us-east-3"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 us-south-1"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_sxm5 asia-south-1"
  "gpu_1x_gh200 us-east-3" "gpu_1x_h100_pcie us-east-1"
)
DEADLINE=$(( $(date +%s) + 10800 ))   # poll up to 3h, then exit so it can be relaunched
i=0
while [ $(date +%s) -lt $DEADLINE ]; do
  set -- ${TARGETS[$(( i % ${#TARGETS[@]} ))]}; T=$1; R=$2; i=$(( i + 1 ))
  RESP=$(curl -s -m 25 -X POST https://cloud.lambda.ai/api/v1/instance-operations/launch \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"region_name\":\"$R\",\"instance_type_name\":\"$T\",\"ssh_key_names\":[\"Quant Training Key\"],\"name\":\"thumbrl-ctrviews\"}")
  ID=$(echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);x=d.get('data',{}).get('instance_ids',[]);print(x[0] if x else '')" 2>/dev/null)
  if [ -n "$ID" ]; then
    echo "$ID" > instance_id.txt; echo "$T $R" > launched_type.txt
    echo "=== LANDED $T in $R -> $ID ==="; exit 0
  fi
  CODE=$(echo "$RESP" | grep -oE 'insufficient-capacity|1015|invalid' | head -1)
  echo "[$(date +%H:%M:%S)] $T $R -> ${CODE:-?}"
  sleep 18
done
echo "=== poller hit 3h deadline with no capacity — relaunch to keep trying ==="; exit 1
