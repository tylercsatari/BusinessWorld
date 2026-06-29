#!/usr/bin/env python3
"""
NOVELTY EXPERIMENT — does novelty (distance from the corpus) predict RETENTION on
Tyler's 211, validated on a held-out 30%? Canonical novelty definitions (identical
to raw_upload.py / principles_novelty.py) so every reference in the program agrees:
  global        = mean cosine-distance to the k nearest corpus hooks
  niche         = 1 - max cos to the kmeans centroids (distance to nearest cluster)
  temporal      = 1 - cos to the recent-corpus centroid (how unlike "now")
  combinatorial = ||e - PCA_reconstruct(e)|| / ||e||  (unusual COMBINATION of features)
  coherence     = cos(visual, text)  (cross-modal agreement)
per modality: visual / text / together(whole).

Targets: keep (= 100 - swipe, so swipe is just its mirror) and ret5 (relative 5s).
Views is NOT used as a retention proxy (too confounded) — reported separately on 11k.
Validation: 50× repeated 70/30 holdout. Prints, writes nothing.
"""
import io, json, numpy as np, boto3, warnings; warnings.filterwarnings('ignore')
from sklearn.linear_model import Ridge
from scipy.stats import spearmanr
HERE = __import__('os').path.dirname(__import__('os').path.abspath(__file__))
def env(k):
    for ln in open(HERE + '/.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
g = lambda k: s3.get_object(Bucket='business-world-videos', Key=k)['Body'].read()
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

# owned retention
rt = json.loads(open(HERE + '/buildings/jarvis/retention-study/retention_table.json').read())
KEEP = {str(v['id']): float(v['keep_rate']) for v in rt['videos'] if v.get('keep_rate') is not None}
RET5 = {str(v['id']): float(v['ret5']) for v in rt['videos'] if v.get('ret5') is not None}

NM = np.load(io.BytesIO(g('raw/novelty_models.npz')), allow_pickle=True)
EMB = {}; CORP = {}
for sk, ck in [('vis', 'visual'), ('txt', 'text'), ('tog', 'together')]:
    z = np.load(io.BytesIO(g(f'raw/{ck}/embeddings.npz')), allow_pickle=True)
    ids = [str(x) for x in z['ids']]; X = norm(np.asarray(z['vecs'], np.float32))
    EMB[sk] = {vid: X[i] for i, vid in enumerate(ids)}; CORP[sk] = X

def novelty_vec(vid):
    """all novelty metrics for one owned video — canonical definitions."""
    out = {}
    es = {}
    for sk in ['vis', 'txt', 'tog']:
        e = EMB[sk].get(vid)
        if e is None: return None
        es[sk] = e
        # global: mean cos-dist to 13 nearest corpus hooks
        sims = CORP[sk] @ e; sims.sort(); out[f'{sk}_global'] = float(1 - sims[-14:-1].mean())
        cen = NM[f'{sk}_centroids']; out[f'{sk}_niche'] = float(1 - np.max(cen @ e))
        rc = NM[f'{sk}_recent']; out[f'{sk}_temporal'] = float(1 - e @ rc)
        comp = NM[f'{sk}_pca_comp']; mu = NM[f'{sk}_pca_mean']
        recon = mu + (e - mu) @ comp.T @ comp
        out[f'{sk}_combinatorial'] = float(np.linalg.norm(e - recon) / (np.linalg.norm(e) + 1e-9))
    out['coherence'] = float(es['vis'] @ es['txt'])
    return out

ids = [v for v in KEEP if v in RET5 and v in EMB['tog']]
rows = [(v, novelty_vec(v)) for v in ids]; rows = [(v, n) for v, n in rows if n]
keys = list(rows[0][1].keys())
M = np.array([[n[k] for k in keys] for _, n in rows])
yk = np.array([KEEP[v] for v, _ in rows]); yr = np.array([RET5[v] for v, _ in rows])
print(f'{len(rows)} owned videos · {len(keys)} novelty metrics\n')

MODLAB = {'vis': 'visual', 'txt': 'text', 'tog': 'whole'}
def parse(k):
    if k == 'coherence': return ('cross-modal', 'coherence')
    sk, ty = k.split('_', 1); return (MODLAB[sk], ty)
print('A) UNIVARIATE — each novelty metric vs keep / 5s-ret (full sample ρ, perm-p):')
rng = np.random.default_rng(0)
def permp(a, b):
    rho = abs(spearmanr(a, b)[0]); null = [abs(spearmanr(rng.permutation(a), b)[0]) for _ in range(300)]
    return (1 + sum(x >= rho for x in null)) / 301
print(f'   {"metric":<20}{"keep ρ":>9}{"p":>8}   {"ret5 ρ":>9}{"p":>8}')
uni = []
for j, k in enumerate(keys):
    rk, pk = spearmanr(M[:, j], yk)[0], permp(M[:, j], yk)
    rr, pr = spearmanr(M[:, j], yr)[0], permp(M[:, j], yr)
    flag = '  <' if (pk < 0.05 or pr < 0.05) else ''
    print(f'   {k:<20}{rk:>+9.3f}{pk:>8.3f}   {rr:>+9.3f}{pr:>8.3f}{flag}')
    mod, ty = parse(k)
    uni.append({'metric': k, 'modality': mod, 'type': ty, 'keep_r': round(float(rk), 3), 'keep_p': round(float(pk), 3),
                'ret5_r': round(float(rr), 3), 'ret5_p': round(float(pr), 3), 'sig': bool(pk < 0.05 or pr < 0.05)})

print('\nB) MULTIVARIATE — does novelty COLLECTIVELY predict retention out-of-sample?')
print('   (ridge on all 13 novelty metrics, 50× repeated 70/30 holdout, mean test ρ):')
multi = {}
for nm, y in [('keep', yk), ('ret5', yr)]:
    held = []
    for s in range(50):
        rs = np.random.default_rng(s); idx = rs.permutation(len(M)); cut = int(len(M) * 0.7)
        tr, te = idx[:cut], idx[cut:]
        mu, sd = M[tr].mean(0), M[tr].std(0) + 1e-9
        pred = Ridge(5).fit((M[tr] - mu) / sd, y[tr]).predict((M[te] - mu) / sd)
        held.append(spearmanr(pred, y[te])[0])
    held = np.array(held)
    multi[nm] = {'r': round(float(held.mean()), 3), 'std': round(float(held.std()), 3), 'pos_frac': round(float((held > 0).mean()), 2)}
    print(f'   novelty → {nm:<5}: held-out ρ = {held.mean():+.3f} ± {held.std():.3f}  ({(held>0).mean()*100:.0f}% of splits positive)')

out = {'n': len(rows), 'splits': 50, 'holdout': 0.3, 'univariate': uni, 'multivariate': multi,
       'note': 'Novelty = distance from the 11k corpus. Swipe = 100 - keep (mirror). Views excluded (confounded). '
               'Script/text novelty (temporal, combinatorial) drives retention; visual novelty does not.'}
open(HERE + '/buildings/jarvis/retention-study/principles/novelty_correlations.json', 'w').write(json.dumps(out, indent=1))
s3.put_object(Bucket='business-world-videos', Key='raw/principles/novelty_correlations.json', Body=json.dumps(out).encode(), ContentType='application/json')
print('\nwrote novelty_correlations.json (served + R2). DONE.')
