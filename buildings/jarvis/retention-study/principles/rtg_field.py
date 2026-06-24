#!/usr/bin/env python3
"""
RTG · EMERGENCE (not labelling). No thresholds, no "this is a reference / this is a
gratification". Just the raw continuous field + clusters that emerge on their own —
the same way we first *looked* at novelty's geometry before scoring anything.

Per video, from the SigLIP2 tokens (shared vision-language space):
  field[i,j] = ⟨text_i, visual_j⟩  (double-centred)         — the full continuous M-field
  threads    = k-means over ALL second-tokens (visual + spoken) in the shared space —
               a spoken word and the later frame that depicts it land in the SAME cluster,
               so a "thread" emerges spanning both tracks across time. Nothing is labelled
               reference vs gratification; you just SEE the same colour appear on the
               concept track, then later on the visual track.
  map        = 2D PCA of those tokens, coloured by emergent thread (the cluster geometry).

Output: rtg_field.json
"""
import os, json
import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
VD = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(RS))), 'video_data')
MAT_SCALE = 0.12
np.random.seed(7)


def words_by_sec(vid, n):
    out = ['' for _ in range(n)]
    try:
        a = json.load(open(os.path.join(VD, vid, 'analysis.json')))
        w = (a.get('transcript') or {}).get('words') or []
    except Exception:
        return out
    b = {t: [] for t in range(n)}
    for x in w:
        ts = x.get('timestamp')
        if isinstance(ts, (int, float)) and 0 <= int(ts) < n:
            b[int(ts)].append(x.get('word', ''))
    return [' '.join(z for z in b[t] if z).strip() for t in range(n)]


def main():
    z = np.load(os.path.join(HERE, 'rtg_tokens_siglip.npz'))
    owner, sec = z['owner'], z['sec']
    V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
    hasc = z['has_c'].astype(bool)
    V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    try:
        NOV = {v['id']: v for v in json.load(open(os.path.join(HERE, 'novelty.json')))['videos']}
    except Exception:
        NOV = {}

    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)

    out = []
    for vi in sorted(seq):
        rows = np.array(sorted(seq[vi], key=lambda r: sec[r]))
        n = len(rows); info = meta[vi]; vid = info['id']; nov = NOV.get(vid, {})
        Vv = V[rows]; Cc = C[rows]; hc = hasc[rows]
        rec = {'id': vid, 'title': nov.get('title') or vid, 'published': nov.get('published'),
               'n_sec': int(n), 'duration': info.get('duration'),
               'has_c': hc.astype(int).tolist(), 'words': words_by_sec(vid, n)}
        if n >= 3:
            # ---- full continuous field (declared: concept_i -> visual_j), double-centred ----
            M = Cc @ Vv.T
            Mc = M - M.mean(1, keepdims=True) - M.mean(0, keepdims=True) + M.mean()
            rec['field'] = [int(np.clip(round(v / MAT_SCALE * 127), -127, 127)) for v in Mc.flatten()]
            # ---- emergent threads: cluster ALL tokens in the shared space ----
            toks, trk, secs = [], [], []
            for t in range(n):
                toks.append(Vv[t]); trk.append(0); secs.append(t)
            for t in range(n):
                if hc[t]:
                    toks.append(Cc[t]); trk.append(1); secs.append(t)
            X = np.array(toks)
            k = int(min(8, max(3, round(n / 5))))
            k = min(k, len(X) - 1)
            lab = KMeans(k, n_init=5, random_state=7).fit_predict(X) if len(X) > k else np.zeros(len(X), int)
            P = PCA(2, random_state=7).fit_transform(X)
            P = (P - P.min(0)) / (np.ptp(P, axis=0) + 1e-9)     # 0..1 for rendering
            threadV = [-1] * n; threadC = [-1] * n; toklist = []
            for i in range(len(X)):
                (threadV if trk[i] == 0 else threadC)[secs[i]] = int(lab[i])
                toklist.append({'s': int(secs[i]), 'tr': int(trk[i]), 'th': int(lab[i]),
                                'x': round(float(P[i, 0]), 3), 'y': round(float(P[i, 1]), 3)})
            rec['threadV'] = threadV; rec['threadC'] = threadC
            rec['n_threads'] = int(k); rec['tokens'] = toklist
            # ---- continuous surprise (visual change) — not a label, just the signal ----
            rec['vsurp'] = [0.0] + [round(float(1 - Vv[t - 1] @ Vv[t]), 4) for t in range(1, n)]
        out.append(rec)
        if (vi + 1) % 40 == 0:
            print(f"  {vi+1} videos", flush=True)

    json.dump({'meta': {'n': len(out), 'mat_scale': MAT_SCALE,
                        'note': 'emergence — full continuous M-field + k-means threads in shared SigLIP2 space; nothing thresholded or labelled reference/gratification'},
               'videos': out},
              open(os.path.join(HERE, 'rtg_field.json'), 'w'))
    print(f"rtg_field.json · {len(out)} videos", flush=True)


if __name__ == '__main__':
    main()
