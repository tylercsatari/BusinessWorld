#!/usr/bin/env python3
"""
Prep the two assets the long-form thumbnail trainer needs:
 1. longform/thumb-rl/scorer_visual.npz — the frozen reward: ctrviews blend direction (1536-d) + the
    curated-set score ladder + the 90th-pctile target. The box scores a new thumbnail embedding by
    projecting onto `blend` and reading its percentile off `ladder`. (No refit on the box.)
 2. longform/thumb-rl/titles.jsonl — a diverse pool of real long-form titles (from the crawled library +
    our own), one {"title": ...} per line. The trainer samples a fresh title each step so it can't overfit
    to one output.
Run: python3 build_thumb_assets.py
"""
import io, json, re, hashlib, os, platform, numpy as np, boto3, sklearn, scipy
from datetime import datetime, timezone
from sklearn.cross_decomposition import PLSRegression
HERE = os.path.dirname(os.path.abspath(__file__))
def env(k):
    value = os.environ.get(k)
    if value:
        return value
    for ln in open(os.path.join(HERE, '.env')):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
B = 'business-world-videos'
def r2(k): return s3.get_object(Bucket=B, Key=k)['Body'].read()
def put(k, b, ct): s3.put_object(Bucket=B, Key=k, Body=b, ContentType=ct)
def nrm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def sha256_bytes(data): return hashlib.sha256(data).hexdigest()
def population_snapshot(values):
    rows = [str(value) for value in values if str(value)]
    unique = sorted(set(rows))
    return {
        'rowCount': len(rows),
        'uniqueVideoCount': len(unique),
        'duplicateVideoCount': len(rows) - len(unique),
        'videoIdSha256': sha256_bytes('\n'.join(unique).encode()),
        'orderedVideoIdSha256': sha256_bytes(
            json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
        ),
    }
def pls_dir(X, y):
    w = np.asarray(PLSRegression(1).fit(X, y).coef_).reshape(-1); return w / (np.linalg.norm(w) + 1e-9)

# ---- 1. scorer artifact (same math as score_thumb_long.py, frozen to R2) ----
curated_bytes = r2('longform/curated/all_visual.json')
CUR = json.loads(curated_bytes); kept = set(CUR['keptIds'])
channels_bytes = r2('longform/channels.json')
channels = json.loads(channels_bytes)['channels']
CTR = {}
retention_revisions = {}
for c in channels:
    try:
        source_key = f"longform/ret_{c['id']}.json"
        retention_bytes = r2(source_key)
        retention_revisions[c['id']] = {
            'source': source_key,
            'sha256': sha256_bytes(retention_bytes),
        }
        for v in json.loads(retention_bytes).get('videos', []):
            if v.get('id') and v.get('ctr') is not None:
                ctr = float(v['ctr'])
                if np.isfinite(ctr): CTR[str(v['id'])] = ctr
    except Exception: pass
embedding_bytes = r2('raw-long/visual/embeddings.npz')
z = np.load(io.BytesIO(embedding_bytes), allow_pickle=True)
ids = [str(x) for x in z['ids']]; V = nrm(np.asarray(z['vecs'], np.float32)); views = np.asarray(z['views'], float)
pos = {v: i for i, v in enumerate(ids)}
ci = np.array([
    pos[k] for k in sorted(kept)
    if k in pos and np.isfinite(views[pos[k]]) and views[pos[k]] > 0
])
Vc = V[ci]; lvc = np.log10(views[ci] + 1)
oi = np.array([i for i, v in enumerate(ids) if v in CTR and np.all(np.isfinite(V[i]))])
w_ctr = pls_dir(V[oi], np.array([CTR[ids[i]] for i in oi])); w_views = pls_dir(Vc, lvc)
blend = 0.3 * w_ctr + 0.7 * w_views; blend /= np.linalg.norm(blend)
ladder = np.sort(Vc @ blend).astype(np.float32)
p90 = float(np.quantile(ladder, 0.90))
lineage = {
    'schemaVersion': 1,
    'producer': 'build_thumb_assets.py',
    'producerSourceSha256': sha256_bytes(open(__file__, 'rb').read()),
    'generatedAt': datetime.now(timezone.utc).isoformat(),
    'embeddingModel': 'gemini-embedding-2',
    'embeddingDimensions': int(V.shape[1]),
    'runtime': {
        'python': platform.python_version(),
        'numpy': np.__version__,
        'scikitLearn': sklearn.__version__,
        'scipy': scipy.__version__,
    },
    'algorithm': {
        'ctrDirection': 'PLSRegression(n_components=1) on normalized visual embeddings and private CTR',
        'viewsDirection': 'PLSRegression(n_components=1) on normalized curated visual embeddings and log10(views + 1)',
        'blend': 'L2-normalize(0.3 * unit_ctr_direction + 0.7 * unit_logviews_direction)',
        'calibration': 'rank direct query projection against the sorted curated blend-projection ladder',
    },
    'populations': {
        'embeddingStore': {
            'source': 'raw-long/visual/embeddings.npz',
            'artifactSha256': sha256_bytes(embedding_bytes),
            **population_snapshot(ids),
        },
        'privateCtrFit': population_snapshot([ids[i] for i in oi]),
        'curatedViewsFit': population_snapshot([ids[i] for i in ci]),
        'calibrationLadder': population_snapshot([ids[i] for i in ci]),
    },
    'sourceRevisions': {
        'curatedIds': {
            'source': 'longform/curated/all_visual.json',
            'sha256': sha256_bytes(curated_bytes),
        },
        'channels': {
            'source': 'longform/channels.json',
            'sha256': sha256_bytes(channels_bytes),
        },
        'privateRetentionTables': retention_revisions,
    },
}
lineage_bytes = json.dumps(lineage, sort_keys=True, separators=(',', ':')).encode()
lineage_sha256 = sha256_bytes(lineage_bytes)
buf = io.BytesIO()
np.savez_compressed(
    buf,
    blend=blend.astype(np.float32),
    ladder=ladder,
    p90=np.float32(p90),
    n_curated=np.int32(len(ci)),
    LINEAGE_JSON=np.array(lineage_bytes.decode()),
    LINEAGE_SHA256=np.array(lineage_sha256),
)
artifact_bytes = buf.getvalue()
artifact_sha256 = sha256_bytes(artifact_bytes)
archive_key = f'longform/thumb-rl/by-sha256/{artifact_sha256}.npz'
manifest = {
    **lineage,
    'lineageSha256': lineage_sha256,
    'artifactSha256': artifact_sha256,
    'canonicalKey': 'longform/thumb-rl/scorer_visual.npz',
    'archiveKey': archive_key,
}
manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
put('longform/thumb-rl/scorer_visual.npz', artifact_bytes, 'application/octet-stream')
put(archive_key, artifact_bytes, 'application/octet-stream')
put('longform/thumb-rl/scorer_visual.manifest.json', manifest_bytes, 'application/json')
put(f'longform/thumb-rl/by-sha256/{artifact_sha256}.manifest.json', manifest_bytes, 'application/json')
print(f"scorer_visual.npz: blend[{blend.shape[0]}] · ladder[{len(ladder)}] · p90={p90:.3f} → R2")

# ---- 2. title corpus (diverse real long-form titles) ----
titles, seen = [], set()
def add(t):
    t = (t or '').strip()
    if not t or len(t) < 8 or len(t) > 160: return
    key = re.sub(r'\W+', '', t.lower())[:80]
    if key in seen: return
    seen.add(key); titles.append(t)
db = json.loads(r2('longform/db.json')).get('videos', {})
for v in db.values(): add(v.get('title'))
for c in channels:
    try:
        for v in json.loads(r2(f"longform/ret_{c['id']}.json")).get('videos', []): add(v.get('title'))
    except Exception: pass
out = '\n'.join(json.dumps({'title': t}) for t in titles)
put('longform/thumb-rl/titles.jsonl', out.encode(), 'application/x-ndjson')
print(f"titles.jsonl: {len(titles)} unique long-form titles → R2  (sample: {titles[:3]})")
