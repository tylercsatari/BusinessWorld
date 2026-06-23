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
    {'metric': 'On-screen text (OCR)', 'type': 'detection', 'def': 'Tesseract OCR of each frame, filtered (conf≥60, len≥3, dictionary word/number). The text layer OWLv2 misses (captions, titles). Reliable on clean captions, weaker on stylized fonts.'},
    {'metric': 'Concept embedding', 'type': 'encoder', 'def': 'all-MiniLM-L6-v2 of the SPOKEN script + ON-SCREEN text combined. Text is semantic, so it joins concept novelty.'},
    {'metric': 'Text modality', 'type': 'encoder', 'def': 'all-MiniLM-L6-v2 of the on-screen text ONLY — its own embedding, its own map. Lets you see novelty carried by the caption layer alone.'},
    {'metric': 'Whole-hook embedding', 'type': 'encoder', 'def': 'mean(normalized CLIP image, normalized CLIP text of [spoken + on-screen]). Both speech and caption text feed the whole; visual does NOT include text.'},
    {'metric': 'Global novelty', 'type': 'geometry', 'def': 'mean cosine distance to the 8 nearest hooks in the embedding. Pure geometry over the vectors above.'},
    {'metric': 'Niche', 'type': 'geometry', 'def': 'k-means (k=8) clusters of the embeddings + cosine distance to the assigned cluster centre. k is a chosen parameter.'},
    {'metric': 'Temporal novelty', 'type': 'geometry', 'def': 'mean cosine distance to hooks published within ±45 days. Window (45d) is a chosen parameter.'},
    {'metric': 'Coherence', 'type': 'model-metric', 'def': 'cosine(CLIP image, CLIP text) of the hook. A defined scalar — how aligned the visuals are with the words per CLIP. Model-dependent but reproducible.'},
    {'metric': 'Concept (combinatorial)', 'type': 'defined', 'def': 'MMR keyphrase: 1-3 word n-gram of the script maximizing cos(phrase, hook) − redundancy. Multi-word, centrality-scored — filters throwaway words by construction.'},
    {'metric': 'Concept-cluster / combo rarity', 'type': 'geometry', 'def': 'concepts k-means-clustered corpus-wide; combo rarity = mean 1/(co-occurrence+1) over the concept-cluster PAIRS in the hook. Pure counting.'},
    {'metric': 'Component / object', 'type': 'detection', 'def': 'Grounding DINO open-vocabulary detection (more accurate than OWLv2): an object phrase is a component iff localized with score>0.30, returning a box. Non-objects ("setting","area") get no box and are excluded. Quantitative (score+box).'},
    {'metric': 'Scene spread', 'type': 'geometry', 'def': 'mean pairwise cosine distance among the 5 per-frame DINOv2 vectors — how much the hook visually changes (cut intensity).'},
    {'metric': 'Scene description / techniques / insights', 'type': 'interpreted', 'def': 'LLM-written per-frame prose (analysis.json). SUBJECTIVE — shown only as context, never fed into any score. Flagged orange in the panel.'},
]


def main():
    E = np.load(os.path.join(HERE, 'hooks_emb.npz'))
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))
    meta = M['meta']; n = len(meta)
    CON = json.load(open(os.path.join(HERE, 'concepts.json')))
    OBJ = json.load(open(os.path.join(HERE, 'objects.json'))) if os.path.exists(os.path.join(HERE, 'objects.json')) else {}
    so, sf, sv = E['scene_owner'], E['scene_frame'], E['scene']
    visual = E['visual']
    TX = np.load(os.path.join(HERE, 'text_emb.npz'))
    OCR = json.load(open(os.path.join(HERE, 'ocr.json'))) if os.path.exists(os.path.join(HERE, 'ocr.json')) else {}
    clip_img = E['clip_img']
    # fold on-screen TEXT into the semantic modalities (per spec): WHOLE & CONCEPT get text, VISUAL does not.
    whole = (L2(clip_img) + L2(TX['h_clip'])) / 2.0          # CLIP image + CLIP text(spoken+on-screen)
    concept = TX['h_mini']                                   # MiniLM(spoken+on-screen)
    text = TX['h_text']                                      # MiniLM(on-screen only) — standalone TEXT modality
    coh = (L2(clip_img) * L2(TX['h_clip'])).sum(1)           # coherence = image ↔ (spoken+on-screen) text
    ages = np.array([m['age_days'] if m['age_days'] is not None else np.nan for m in meta], float)

    out = {'meta': {'n': n, 'hook_seconds': M['hook_seconds'],
                    'models': {'visual': 'facebook/dinov2-large', 'whole': 'openai/clip-vit-base-patch16',
                               'concept': 'all-MiniLM-L6-v2', 'detector': 'IDEA-Research/grounding-dino-base', 'ocr': 'tesseract-5'},
                    'resolutions': ['hook', 'second']},
           'ledger': LEDGER, 'videos': []}

    for i, m in enumerate(meta):
        vid = m['id']; ob = OBJ.get(vid, {}); oc = OCR.get(vid, {})
        out['videos'].append({'id': vid, 'name': m['name'], 'views': m['views'], 'lv': m['lv'], 'url': m['url'],
                              'published': m['published'], 'age_days': m['age_days'], 'hook_text': m.get('hook_text', ''),
                              'onscreen_text': oc.get('hook', ''),
                              'concepts': CON['per_video'].get(vid, []), 'scenes': read_scenes(vid),
                              'objects_hook': ob.get('hook', []), 'objects_persec': ob.get('persec', [])})

    # ── HOOK resolution (4 modalities: whole, concept, visual, text) ──
    H = {'proj': {'whole': project(whole), 'concept': project(concept), 'visual': project(visual), 'text': project(text)}}
    for k, X in (('whole', whole), ('concept', concept), ('visual', visual), ('text', text)):
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

    # ── SECOND resolution — every second analysed exactly like the whole hook (4 modalities) ──
    P = np.load(os.path.join(HERE, 'persec_emb.npz'))
    po, ps, pimg = P['owner'], P['sec'], P['clip_img']
    # align text_emb second-rows to persec order by (owner, sec)
    tix = {(int(TX['s_owner'][r]), int(TX['s_sec'][r])): r for r in range(len(TX['s_owner']))}
    order = [tix.get((int(po[j]), int(ps[j])), 0) for j in range(len(po))]
    s_clip, s_mini, s_text = TX['s_clip'][order], TX['s_mini'][order], TX['s_text'][order]
    pwhole = (L2(pimg) + L2(s_clip)) / 2.0                  # per-second whole = CLIP image + CLIP text(spoken+on-screen)
    pconc, ptext = s_mini, s_text                          # per-second concept (spoken+on-screen) + text-only modality
    pcoh = (L2(pimg) * L2(s_clip)).sum(1)                  # per-second coherence
    gW, gC, gV, gT = geom(pwhole), geom(pconc), geom(sv), geom(ptext)
    cohp = pct(pcoh)
    Wp = L2(pwhole); agesP = ages[po]; tsec = []
    for j in range(len(po)):
        if not np.isfinite(agesP[j]):
            tsec.append(None); continue
        nb = np.where(np.isfinite(agesP) & (np.abs(agesP - agesP[j]) < 45) & (po != po[j]))[0]
        tsec.append(round(float((1 - Wp[j] @ Wp[nb].T).mean()), 4) if len(nb) else None)
    S = {'owner': po.tolist(), 'sec': ps.tolist(),
         'proj': {'whole': project(pwhole, perp=30), 'concept': project(pconc, perp=30), 'visual': project(sv, perp=30), 'text': project(ptext, perp=30)},
         'coherence': [round(float(x), 4) for x in pcoh], 'coh_pct': [round(float(x), 3) for x in cohp], 'temporal': tsec,
         'global': {k: {'nov': g['nov'], 'pct': g['pct']} for k, g in (('whole', gW), ('concept', gC), ('visual', gV), ('text', gT))},
         'niche': {k: {'labels': g['niche'], 'k': len(set(g['niche']))} for k, g in (('whole', gW), ('concept', gC), ('visual', gV), ('text', gT))}}
    out['second'] = S

    # nested per-video second-by-second analysis (full depth, incl. text novelty + on-screen text)
    by_owner = {}
    for j in range(len(po)):
        by_owner.setdefault(int(po[j]), []).append(j)
    for i, v in enumerate(out['videos']):
        objbyt = {p['t']: p['dets'] for p in v.get('objects_persec', [])}
        descbyt = {round(s['t']): s for s in v.get('scenes', [])}
        ocrbyt = {p['t']: p.get('text', '') for p in OCR.get(v['id'], {}).get('persec', [])}
        ana = []
        for j in sorted(by_owner.get(i, []), key=lambda j: ps[j]):
            sc = int(ps[j]); s = descbyt.get(sc, {})
            ana.append({'sec': sc,
                        'nov_pct': {'whole': round(float(gW['pct'][j]), 3), 'concept': round(float(gC['pct'][j]), 3), 'visual': round(float(gV['pct'][j]), 3), 'text': round(float(gT['pct'][j]), 3)},
                        'nov': {'whole': round(float(gW['nov'][j]), 4), 'concept': round(float(gC['nov'][j]), 4), 'visual': round(float(gV['nov'][j]), 4), 'text': round(float(gT['nov'][j]), 4)},
                        'niche': {'whole': int(gW['niche'][j]), 'concept': int(gC['niche'][j]), 'visual': int(gV['niche'][j]), 'text': int(gT['niche'][j])},
                        'temporal': tsec[j], 'coh': round(float(pcoh[j]), 4), 'coh_pct': round(float(cohp[j]), 3),
                        'objects': objbyt.get(sc, []), 'onscreen': ocrbyt.get(sc, ''), 'desc': s.get('desc', '')})
        v['persec'] = ana

    # ── combinatorial (concept-cluster level, from concepts.json) ──
    out['combo'] = {'clusters': CON['clusters'], 'edges': CON['edges'], 'rarity': CON['rarity'], 'k_clusters': CON['k_clusters']}

    json.dump(out, open(os.path.join(HERE, 'novelty.json'), 'w'))
    nobj = sum(len(v['objects_hook']) for v in out['videos'])
    print(f"novelty.json · {n} hooks · {len(po)} seconds · {len(CON['clusters'])} concept-clusters · {nobj} hook-objects · ledger {len(LEDGER)}")


if __name__ == '__main__':
    main()
