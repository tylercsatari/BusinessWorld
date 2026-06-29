#!/bin/bash
set -e
cd /home/ubuntu/hookrl
echo "=== venv + deps ==="
python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q "numpy<2.3" torch transformers peft trl bitsandbytes accelerate datasets boto3 pillow hf_transfer huggingface_hub scipy scikit-learn
echo DEPS_DONE
echo "=== download Qwen3-30B-A3B ==="
HF_HUB_ENABLE_HF_TRANSFER=1 venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-30B-A3B', local_dir='/home/ubuntu/hookrl/models/qwen3-30b-a3b')"
echo QWEN_DONE
echo "=== pull data from R2 (needs .env already scp'd) ==="
venv/bin/python - <<'PY'
import boto3
from pathlib import Path
e={}
for l in Path('/home/ubuntu/hookrl/.env').read_text().splitlines():
    if '=' in l and not l.strip().startswith('#'): k,v=l.split('=',1); e[k]=v.strip()
s=boto3.client('s3',endpoint_url='https://%s.r2.cloudflarestorage.com'%e['R2_ACCOUNT_ID'],aws_access_key_id=e['R2_ACCESS_KEY_ID'],aws_secret_access_key=e['R2_SECRET_ACCESS_KEY'],region_name='auto')
b=e['R2_BUCKET_NAME']
s.download_file(b,'raw/visual/embeddings.npz','/home/ubuntu/hookrl/data/visual_embeddings.npz')
try: s.download_file(b,'hooks/ideabank_big.jsonl','/home/ubuntu/hookrl/data/ideabank_big.jsonl'); print('ideabank ok')
except Exception as ex: print('ideabank dl fail:',str(ex)[:60])
print('DATA_DONE')
PY
echo "=== SETUP_DONE ==="
