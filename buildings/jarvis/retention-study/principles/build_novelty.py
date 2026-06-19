#!/usr/bin/env python3
"""
NOVELTY GEOMETRY v2 — multi-resolution, quantitative.

Two consistent resolutions for every modality:
  HOOK   = the whole 5 s pooled (one point per video)
  SECOND = each second on its own (one point per video-second, ≈ n×5)

Inputs (all already computed):
  hooks_emb.npz   whole / concept / visual / coherence + per-frame DINOv2 (scene)
  persec_emb.npz  per-second CLIP-image / CLIP-text / MiniLM / coherence
  concepts.json   quantitative concepts (MMR keyphrases) + concept-clusters + combo rarity
  objects.json    OWLv2 detections per second + per hook (boxes + scores)

Everything here is geometry/counting — no new interpretation. A ledger records, for every
metric, its exact definition and whether it is geometry / a model metric / detection / LLM-interpreted.

Output: novelty.json
"""
import os, json, re
import numpy as np
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.neighbors import NearestNeighbors
from sklearn.cluster import KMeans

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
np.random.seed(7)


def L2(X):
    return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)


def project(X, perp=15):
    Xn = L2(np.asarray(X, np.float32))
    if Xn.shape[1] > 50:
        Xn = PCA(50, random_state=7).fit_transform(Xn)
    p = max(5, min(perp, (len(Xn) - 1) // 3))
    Y = TSNE(2, perplexity=p, init='pca', random_state=7, metric='cosine').fit_transform(Xn)
    Y = Y - Y.mean(0); Y = Y / (np.abs(Y).max() + 1e-9)
    return [[round(float(a), 4), round(float(b), 4)] for a, b in Y]


def knn_nov(X, k=8):
    Xn = L2(np.asarray(X, np.float32))
    nn = NearestNeighbors(n_neighbors=min(k + 1, len(Xn)), metric='cosine').fit(Xn)
    d, _ = nn.kneighbors(Xn)
    return d[:, 1:].mean(1)


def pct(v):
    r = np.argsort(np.argsort(v)).astype(float)
    return (r / (len(v) - 1 + 1e-9))


def niches(X, k=8):
    return KMeans(min(k, len(X)), n_init=10, random_state=7).fit_predict(L2(np.asarray(X, np.float32))).tolist()


def read_scenes(vid):                                  # LLM-interpreted per-frame analysis (flagged in the ledger)
    try:
        a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
    except Exception:
        return []
    out = []
    for f in (a.get('frames') or []):
        t = f.get('timestamp'); an = f.get('analysis') or {}
        if not isinstance(t, (int, float)) or t >= 5 or not an.get('sceneDescription'):
            continue
        ki = an.get('keyInsights'); ki = ki if isinstance(ki, list) else ([ki] if ki else [])
        out.append({'t': round(float(t), 1), 'desc': (an.get('sceneDescription') or '')[:380],
                    'visual': (an.get('visualTechniques') or '')[:300], 'cinema': (an.get('cinematography') or '')[:300],
                    'engage': (an.get('engagementAnalysis') or '')[:300], 'insights': [str(x)[:160] for x in ki][:3]})
    out.sort(key=lambda x: x['t'])
    return out[:5]


def geom(X):                                           # global novelty + emergent niches for a set of points
    nv = knn_nov(X)
    return {'nov': [round(float(x), 4) for x in nv], 'pct': [round(float(x), 3) for x in pct(nv)],
            'niche': niches(X), 'dist_to_centre': centre_dist(X)}


def centre_dist(X):
    Xn = L2(np.asarray(X, np.float32)); lab = np.array(niches(X))
    cents = {c: Xn[lab == c].mean(0) for c in set(lab.tolist())}
    return [round(float(1 - L2(Xn[i:i + 1])[0] @ L2(cents[lab[i]][None])[0]), 4) for i in range(len(Xn))]


LEDGER = [
    {'metric': 'Visual embedding', 'type': 'encoder', 'def': 'DINOv2-small CLS token of each frame (224², ImageNet-normalized). Deterministic; the "interpretation" is the pretrained net, identical for every video.'},
    {'metric': 'Concept embedding', 'type': 'encoder', 'def': 'all-MiniLM-L6-v2 sentence embedding of the hook script (or per-second text). Deterministic.'},
    {'metric': 'Whole-hook embedding', 'type': 'encoder', 'def': 'mean(normalized CLIP image, normalized CLIP text) in the shared CLIP space. Low-resolution by design (averages everything).'},
    {'metric': 'Global novelty', 'type': 'geometry', 'def': 'mean cosine distance to the 8 nearest hooks in the embedding. Pure geometry over the vectors above.'},
    {'metric': 'Niche', 'type': 'geometry', 'def': 'k-means (k=8) clusters of the embeddings + cosine distance to the assigned cluster centre. k is a chosen parameter.'},
    {'metric': 'Temporal novelty', 'type': 'geometry', 'def': 'mean cosine distance to hooks published within ±45 days. Window (45d) is a chosen parameter.'},
    {'metric': 'Coherence', 'type': 'model-metric', 'def': 'cosine(CLIP image, CLIP text) of the hook. A defined scalar — how aligned the visuals are with the words per CLIP. Model-dependent but reproducible.'},
    {'metric': 'Concept (combinatorial)', 'type': 'defined', 'def': 'MMR keyphrase: 1-3 word n-gram of the script maximizing cos(phrase, hook) − redundancy. Multi-word, centrality-scored — filters throwaway words by construction.'},
    {'metric': 'Concept-cluster / combo rarity', 'type': 'geometry', 'def': 'concepts k-means-clustered corpus-wide; combo rarity = mean 1/(co-occurrence+1) over the concept-cluster PAIRS in the hook. Pure counting.'},
    {'metric': 'Component / object', 'type': 'detection', 'def': 'OWLv2 open-vocabulary detection: an object phrase is a component iff localized with score>0.15, returning a box. Non-objects ("setting","area") get no box and are excluded. Quantitative (score+box).'},
    {'metric': 'Scene spread', 'type': 'geometry', 'def': 'mean pairwise cosine distance among the 5 per-frame DINOv2 vectors — how much the hook visually changes (cut intensity).'},
    {'metric': 'Scene description / techniques / insights', 'type': 'interpreted', 'def': 'LLM-written per-frame prose (analysis.json). SUBJECTIVE — shown only as context, never fed into any score. Flagged orange in the panel.'},
]


def main():
    E = np.load(os.path.join(HERE, 'hooks_emb.npz'))
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))
    meta = M['meta']; n = len(meta)
    CON = json.load(open(os.path.join(HERE, 'concepts.json')))
    OBJ = json.load(open(os.path.join(HERE, 'objects.json'))) if os.path.exists(os.path.join(HERE, 'objects.json')) else {}
    whole, concept, visual, coh = E['whole'], E['concept'], E['visual'], E['coherence']
    so, sf, sv = E['scene_owner'], E['scene_frame'], E['scene']
    ages = np.array([m['age_days'] if m['age_days'] is not None else np.nan for m in meta], float)

    out = {'meta': {'n': n, 'hook_seconds': M['hook_seconds'],
                    'models': {'visual': 'facebook/dinov2-small', 'whole': 'openai/clip-vit-base-patch16',
                               'concept': 'all-MiniLM-L6-v2', 'detector': 'google/owlv2-base-patch16-ensemble'},
                    'resolutions': ['hook', 'second']},
           'ledger': LEDGER, 'videos': []}

    for i, m in enumerate(meta):
        vid = m['id']; ob = OBJ.get(vid, {})
        out['videos'].append({'id': vid, 'name': m['name'], 'views': m['views'], 'lv': m['lv'], 'url': m['url'],
                              'published': m['published'], 'age_days': m['age_days'], 'hook_text': m.get('hook_text', ''),
                              'concepts': CON['per_video'].get(vid, []), 'scenes': read_scenes(vid),
                              'objects_hook': ob.get('hook', []), 'objects_persec': ob.get('persec', [])})

    # ── HOOK resolution ──
    H = {'proj': {'whole': project(whole), 'concept': project(concept), 'visual': project(visual)}}
    for k, X in (('whole', whole), ('concept', concept), ('visual', visual)):
        g = geom(X); H.setdefault('global', {})[k] = {'nov': g['nov'], 'pct': g['pct']}
        H.setdefault('niche', {})[k] = {'labels': g['niche'], 'k': len(set(g['niche'])), 'dist_to_centre': g['dist_to_centre']}
    Wn = L2(whole); tnov = []
    for i in range(n):
        if not np.isfinite(ages[i]):
            tnov.append(None); continue
        nb = np.where(np.isfinite(ages) & (np.abs(ages - ages[i]) < 45))[0]; nb = nb[nb != i]
        tnov.append(round(float((1 - Wn[i] @ Wn[nb].T).mean()), 4) if len(nb) else None)
    H['temporal'] = {'nov': tnov, 'window_days': 45}
    H['coherent'] = {'novelty': [round(float(x), 4) for x in knn_nov(whole)], 'coherence': [round(float(x), 4) for x in coh],
                     'nov_pct': [round(float(x), 3) for x in pct(knn_nov(whole))], 'coh_pct': [round(float(x), 3) for x in pct(coh)]}
    spread = []
    for vi in range(n):
        idx = np.where(so == vi)[0]
        if len(idx) > 1:
            F = L2(sv[idx]); D = 1 - F @ F.T; spread.append(round(float(D[np.triu_indices(len(idx), 1)].mean()), 4))
        else:
            spread.append(0.0)
    H['scene'] = {'pts': project(sv, perp=30), 'owner': so.tolist(), 'frame': sf.tolist(), 'spread': spread}
    out['hook'] = H

    # ── SECOND resolution ──
    P = np.load(os.path.join(HERE, 'persec_emb.npz'))
    po, ps, pimg, ptxt, pconc, pcoh = P['owner'], P['sec'], P['clip_img'], P['clip_txt'], P['concept'], P['coherence']
    S = {'owner': po.tolist(), 'sec': ps.tolist(),
         'proj': {'visual': project(sv, perp=30), 'clip': project(pimg, perp=30), 'concept': project(pconc, perp=30)},
         'coherence': [round(float(x), 4) for x in pcoh], 'coh_pct': [round(float(x), 3) for x in pct(pcoh)]}
    for k, X in (('visual', sv), ('clip', pimg), ('concept', pconc)):
        g = geom(X); S.setdefault('global', {})[k] = {'nov': g['nov'], 'pct': g['pct']}
        S.setdefault('niche', {})[k] = {'labels': g['niche'], 'k': len(set(g['niche']))}
    out['second'] = S

    # ── combinatorial (concept-cluster level, from concepts.json) ──
    out['combo'] = {'clusters': CON['clusters'], 'edges': CON['edges'], 'rarity': CON['rarity'], 'k_clusters': CON['k_clusters']}

    json.dump(out, open(os.path.join(HERE, 'novelty.json'), 'w'))
    nobj = sum(len(v['objects_hook']) for v in out['videos'])
    print(f"novelty.json · {n} hooks · {len(po)} seconds · {len(CON['clusters'])} concept-clusters · {nobj} hook-objects · ledger {len(LEDGER)}")


if __name__ == '__main__':
    main()
