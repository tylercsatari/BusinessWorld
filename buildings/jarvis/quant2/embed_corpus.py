#!/usr/bin/env python3
"""
QUANT 2 · Phase 3 (corpus lane) — embed the 100M-view corpus from R2 frames.

The 2,362-video corpus (all >100M views) has its frames in R2 (shorts/<id>/frame_*.jpg),
not on local disk. This pulls them via boto3 (S3-compatible) and runs the SAME frozen
DINOv2 encoder, caching mean⊕hook embeddings to quant2/emb/<id>.npy — so the corpus
lands in the same content space as the true-label set. These embeddings drive the
manifold (archetypes, novelty, saturation); the corpus carries NO swipe labels.

Idempotent + resumable: skips videos already embedded. Safe to re-run.
Usage:  python3 embed_corpus.py [--limit N]
"""
import os, json, io, argparse, warnings
warnings.filterwarnings('ignore')
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
EMB = os.path.join(HERE, 'emb'); os.makedirs(EMB, exist_ok=True)
MODEL_NAME = 'facebook/dinov2-small'
HOOK_FRAMES = 8


def load_env():
    p = os.path.join(ROOT, '.env')
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1); os.environ.setdefault(k.strip(), v.strip())


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--limit', type=int, default=0); args = ap.parse_args()
    load_env()
    import boto3, torch
    from PIL import Image
    from transformers import AutoModel
    torch.set_num_threads(max(1, os.cpu_count() - 1))

    acct = os.environ.get('R2_ACCOUNT_ID'); bucket = os.environ.get('R2_BUCKET_NAME', 'business-world-videos')
    s3 = boto3.client('s3', endpoint_url=f'https://{acct}.r2.cloudflarestorage.com',
                      aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
                      aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY'), region_name='auto')
    print(f'loading {MODEL_NAME} …', flush=True)
    model = AutoModel.from_pretrained(MODEL_NAME).eval()
    MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

    def prep(im):
        im = im.resize((224, 224), Image.BICUBIC)
        return ((np.asarray(im, np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)

    @torch.no_grad()
    def embed(arrs):
        px = torch.from_numpy(np.stack(arrs)).float()
        f = model(pixel_values=px).last_hidden_state[:, 0]
        return torch.nn.functional.normalize(f, dim=1).cpu().numpy().astype(np.float32)

    sdb = json.load(open(os.path.join(ROOT, 'shorts-db.json'))).get('videos', {})
    items = [(k, v) for k, v in (sdb.items() if isinstance(sdb, dict) else [(x.get('videoId'), x) for x in sdb])]
    items = [(vid, v) for vid, v in items if v.get('framesR2Keys') and not os.path.exists(os.path.join(EMB, vid + '.npy'))]
    if args.limit:
        items = items[:args.limit]
    print(f'{len(items)} corpus videos to embed from R2', flush=True)

    done = 0
    for vid, v in items:
        arrs = []
        for key in (v.get('framesR2Keys') or [])[:16]:
            try:
                b = s3.get_object(Bucket=bucket, Key=key)['Body'].read()
                arrs.append(prep(Image.open(io.BytesIO(b)).convert('RGB')))
            except Exception:
                pass
        if not arrs:
            continue
        Z = embed(arrs)
        np.save(os.path.join(EMB, vid + '.npy'),
                {'frame': Z, 'mean': Z.mean(0), 'hook': Z[:HOOK_FRAMES].mean(0), 'n': Z.shape[0], 'corpus': True},
                allow_pickle=True)
        done += 1
        if done % 25 == 0:
            print(f'  {done}/{len(items)} corpus embedded …', flush=True)
    print(f'DONE · embedded {done} corpus videos from R2', flush=True)


if __name__ == '__main__':
    main()
