#!/bin/bash
set -e
cd /home/ubuntu/thumbrl
echo "=== venv + deps ==="
python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q --index-url https://download.pytorch.org/whl/cu124 torch   # CUDA 12.x to match Lambda's driver (default pip grabs cu130 → cuda=False)
venv/bin/pip install -q "numpy<2.3" "transformers==4.53.2" peft "trl==0.19.1" bitsandbytes accelerate datasets boto3 pillow hf_transfer huggingface_hub scipy scikit-learn joblib
venv/bin/pip install -q "vllm==0.9.2"                     # fast MoE inference (installs its own torch cu126 — fine)
venv/bin/pip install -q --no-deps "trl==0.19.1" "transformers==4.53.2"   # re-pin after vllm's resolver
echo DEPS_DONE
echo "=== download Qwen3-30B-A3B ==="
HF_HUB_ENABLE_HF_TRANSFER=1 venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-30B-A3B', local_dir='/home/ubuntu/thumbrl/models/qwen3-30b-a3b')"
echo QWEN_DONE
echo "=== pull data from R2 (needs .env already scp'd) ==="
mkdir -p /home/ubuntu/thumbrl/data
venv/bin/python - <<'PY'
import boto3
from pathlib import Path
e={}
for l in Path('/home/ubuntu/thumbrl/.env').read_text().splitlines():
    if '=' in l and not l.strip().startswith('#'): k,v=l.split('=',1); e[k]=v.strip().strip('"').strip("'")
s=boto3.client('s3',endpoint_url='https://%s.r2.cloudflarestorage.com'%e['R2_ACCOUNT_ID'],aws_access_key_id=e['R2_ACCESS_KEY_ID'],aws_secret_access_key=e['R2_SECRET_ACCESS_KEY'],region_name='auto')
b=e['R2_BUCKET_NAME']
s.download_file(b,'longform/thumb-rl/scorer_visual.npz','/home/ubuntu/thumbrl/data/scorer_visual.npz'); print('scorer ok')
s.download_file(b,'longform/thumb-rl/titles.jsonl','/home/ubuntu/thumbrl/data/titles.jsonl'); print('titles ok')
s.download_file(b,'raw-long/visual/embeddings.npz','/home/ubuntu/thumbrl/data/visual_long_embeddings.npz'); print('embeds ok')
import os
for n in range(1, 20):   # seed every round's index+manifest so proxy_train + cross-round resume work on a fresh box
    for f in ('index.jsonl','manifest.jsonl'):
        try:
            os.makedirs('/home/ubuntu/thumbrl/runs/thumb%d'%n, exist_ok=True)
            s.download_file(b,'longform/guesses/thumb%d/%s'%(n,f),'/home/ubuntu/thumbrl/runs/thumb%d/%s'%(n,f))
            print('seeded thumb%d/%s'%(n,f))
        except Exception: pass
print('DATA_DONE')
PY
echo "=== SETUP_DONE ==="
