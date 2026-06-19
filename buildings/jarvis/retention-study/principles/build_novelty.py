#!/usr/bin/env python3
"""
NOVELTY GEOMETRY — turn the cached hook embeddings into 2D latent maps + the five
novelty geometries. Still NO labels/interpretation: only positions, distances, clusters.

Per modality (whole / concept / visual / scene) → a 2D map you can eyeball for clusters.
Then the five measurements as pure geometry over those embeddings:

  A global   : kNN distance to the whole corpus              (outliers = novel)
  B niche    : unsupervised clusters (emergent niches) + distance to own cluster centre
  C temporal : distance to hooks posted within ±45 days      (saturation)
  D combo    : concept co-occurrence graph from the script + per-hook combination rarity
  E coherent : novelty (x) vs visual-text coherence (y)      (the curiosity quadrant)

Output: novelty.json  (read by the Principles → Novelty tab).
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

STOP = set("the a an and or but to of in on for with at by from up about into over after is are was were be been being this that these those it its as it's i you he she they we my your his her their our me him them us so if then than too very can will just dont don't im it’s was had has have do does did not no yes get got make made go going went one two first my so out see saw look looking watch wanted want wants how what when why where who which actually really gonna let lets here there now today thing things something someone everyone people guy guys way back take took put thats that's youre you're were we're im i'm because just like more most much many also even still own new make making makes day life world's world".split())


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


def pct(v):                                            # 0..1 percentile rank (for colouring)
    r = np.argsort(np.argsort(v)).astype(float)
    return (r / (len(v) - 1 + 1e-9))


def niches(X, k=8):
    return KMeans(min(k, len(X)), n_init=10, random_state=7).fit_predict(L2(np.asarray(X, np.float32))).tolist()


def toks(t):
    ws = [w for w in re.findall(r"[a-zA-Z']+", (t or '').lower()) if len(w) >= 3 and w not in STOP]
    return list(dict.fromkeys(ws))


def read_scenes(vid):                                  # the already-interpreted per-frame analysis (first 5 s)
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


COMP_STOP = STOP | set("scene shows person people room background foreground frame image visible appears wearing standing sitting holding looking shot camera angle color colors lighting light bright dark natural warm tone text overlay screen left right center top bottom front behind large small white black blue red green clear likely seen various several".split())


def components(scenes):                                # mechanical object/component chips from the scene descriptions
    fr = {}
    for s in scenes:
        for w in [w.strip("'") for w in re.findall(r"[a-zA-Z']+", (s['desc'] or '').lower())]:
            if len(w) >= 4 and w not in COMP_STOP:
                fr[w] = fr.get(w, 0) + 1
    return [w for w, c in sorted(fr.items(), key=lambda x: (-x[1], x[0]))][:10]


def main():
    E = np.load(os.path.join(HERE, 'hooks_emb.npz'))
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))
    meta = M['meta']; n = len(meta)
    whole, concept, visual = E['whole'], E['concept'], E['visual']
    coh = E['coherence']
    ages = np.array([m['age_days'] if m['age_days'] is not None else np.nan for m in meta], float)

    out = {'meta': {'n': n, 'hook_seconds': M['hook_seconds'], 'models': M['models']},
           'videos': [{'id': m['id'], 'name': m['name'], 'views': m['views'], 'lv': m['lv'],
                       'url': m['url'], 'published': m['published'], 'age_days': m['age_days'],
                       'hook_text': m.get('hook_text', '')} for m in meta]}

    # 2D maps per modality
    out['proj'] = {'whole': project(whole), 'concept': project(concept), 'visual': project(visual)}
    # scene components: every hook frame as its own point (≈ n×5), coloured by owner video
    so, sf, sv = E['scene_owner'], E['scene_frame'], E['scene']
    sp = project(sv, perp=30)
    out['scene'] = {'pts': sp, 'owner': so.tolist(), 'frame': sf.tolist()}
    # per-hook scene spread = mean pairwise cosine dist among its 5 frames (visual dynamism)
    spread = []
    for vi in range(n):
        idx = np.where(so == vi)[0]
        if len(idx) > 1:
            F = L2(sv[idx]); D = 1 - F @ F.T
            spread.append(round(float(D[np.triu_indices(len(idx), 1)].mean()), 4))
        else:
            spread.append(0.0)
    out['scene']['spread'] = spread

    # A — global novelty (kNN distance), per modality, as percentile for colour
    out['global'] = {k: {'nov': [round(float(x), 4) for x in knn_nov(X)],
                         'pct': [round(float(x), 3) for x in pct(knn_nov(X))]}
                     for k, X in (('whole', whole), ('concept', concept), ('visual', visual))}

    # B — niche: emergent clusters per modality + distance to own centroid
    out['niche'] = {}
    for k, X in (('whole', whole), ('concept', concept), ('visual', visual)):
        lab = niches(X); Xn = L2(np.asarray(X, np.float32)); lab = np.array(lab)
        cents = {c: Xn[lab == c].mean(0) for c in set(lab.tolist())}
        dist = [round(float(1 - L2(Xn[i:i+1])[0] @ L2(cents[lab[i]][None])[0]), 4) for i in range(n)]
        out['niche'][k] = {'labels': lab.tolist(), 'k': len(cents), 'dist_to_centre': dist}

    # C — temporal novelty: distance to hooks within ±45 days (whole space)
    Wn = L2(whole); tnov = []
    for i in range(n):
        if not np.isfinite(ages[i]):
            tnov.append(None); continue
        nb = np.where(np.isfinite(ages) & (np.abs(ages - ages[i]) < 45))[0]
        nb = nb[nb != i]
        tnov.append(round(float((1 - Wn[i] @ Wn[nb].T).mean()), 4) if len(nb) else None)
    out['temporal'] = {'nov': tnov, 'window_days': 45}

    # D — combinatorial: concept co-occurrence graph from the hook script (broad vocab → fewer blanks)
    hooks = [toks(m['hook_text']) for m in meta]
    freq = {}
    for hs in hooks:
        for w in hs:
            freq[w] = freq.get(w, 0) + 1
    vocab = [w for w, c in sorted(freq.items(), key=lambda x: (-x[1], x[0])) if c >= 2][:100]
    vi = {w: i for i, w in enumerate(vocab)}
    co = np.zeros((len(vocab), len(vocab)))
    for hs in hooks:
        present = [vi[w] for w in hs if w in vi]
        for a in range(len(present)):
            for b in range(a + 1, len(present)):
                co[present[a], present[b]] += 1; co[present[b], present[a]] += 1
    pos = project(co + np.eye(len(vocab)) * 1e-3, perp=8) if len(vocab) > 6 else [[0, 0]] * len(vocab)
    edges = [{'a': a, 'b': b, 'w': int(co[a, b])} for a in range(len(vocab)) for b in range(a + 1, len(vocab)) if co[a, b] >= 2]
    # per-hook: its concepts, its concept pairs (with co-occurrence), and combination rarity
    rar, vconcepts, vpairs = [], [], []
    for hs in hooks:
        pr = [w for w in hs if w in vi]; vconcepts.append(pr)
        pairs, vals = [], []
        for a in range(len(pr)):
            for b in range(a + 1, len(pr)):
                c = int(co[vi[pr[a]], vi[pr[b]]]); pairs.append({'a': pr[a], 'b': pr[b], 'co': c}); vals.append(1.0 / (c + 1.0))
        vpairs.append(sorted(pairs, key=lambda p: p['co'])[:6])
        rar.append(round(float(np.mean(vals)), 4) if vals else None)
    out['combo'] = {'nodes': [{'w': w, 'freq': freq[w], 'pos': pos[i]} for i, w in enumerate(vocab)],
                    'edges': edges, 'rarity': rar}

    # per-hook interpreted breakdown: scene-by-scene analysis + extracted object/components
    for i, m in enumerate(meta):
        sc = read_scenes(m['id'])
        out['videos'][i]['scenes'] = sc
        out['videos'][i]['components'] = components(sc)
        out['videos'][i]['concepts'] = vconcepts[i]
        out['videos'][i]['pairs'] = vpairs[i]

    # E — coherent: novelty (whole kNN) vs visual↔text coherence
    out['coherent'] = {'novelty': [round(float(x), 4) for x in knn_nov(whole)],
                       'coherence': [round(float(x), 4) for x in coh],
                       'nov_pct': [round(float(x), 3) for x in pct(knn_nov(whole))],
                       'coh_pct': [round(float(x), 3) for x in pct(coh)]}

    json.dump(out, open(os.path.join(HERE, 'novelty.json'), 'w'))
    print(f"novelty.json · {n} hooks · {len(vocab)} concepts · {len(edges)} edges · {len(sp)} scene pts")


if __name__ == '__main__':
    main()
