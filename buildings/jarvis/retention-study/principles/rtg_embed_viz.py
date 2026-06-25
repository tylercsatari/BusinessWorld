#!/usr/bin/env python3
"""
RTG · visualize ALL the embeddings. Projects every second of every video — its frame (visual)
and its spoken utterance (concept), all in the shared Gemini multimodal space — to one GLOBAL 2D
map (PCA), with a global k-means colouring so you can SEE the whole geometry: where moments of
the same kind cluster, and where a given video's seconds live in it. Writes a compact
rtg_embedmap.json the UI scatter-plots (visual=dot, concept=square; the open video highlighted).
"""
import os, json
import numpy as np
from sklearn.cluster import MiniBatchKMeans

HERE = os.path.dirname(os.path.abspath(__file__))
z = np.load(os.path.join(HERE, 'rtg_tokens_gemini.npz'))
owner, sec, hasc = z['owner'].astype(int), z['sec'].astype(int), z['has_c'].astype(bool)
V = z['clip_img'].astype(np.float64); C = z['clip_txt'].astype(np.float64)
V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9); C /= (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)

# stack: every visual frame + every CONCEPT that actually has speech
Vmask = np.ones(len(V), bool); Cmask = hasc
X = np.vstack([V[Vmask], C[Cmask]])
mod = np.concatenate([np.zeros(Vmask.sum(), int), np.ones(Cmask.sum(), int)])
vid = np.concatenate([owner[Vmask], owner[Cmask]])
secs = np.concatenate([sec[Vmask], sec[Cmask]])
print(f"{len(X)} points ({Vmask.sum()} visual + {Cmask.sum()} concept) across {len(set(owner))} videos", flush=True)

# global PCA → 2D, plus a 50-d projection for stable clustering
Xc = X - X.mean(0)
P = np.linalg.svd(Xc, full_matrices=False)[2]
Y = Xc @ P[:2].T
K = 16
cl = MiniBatchKMeans(n_clusters=K, random_state=0, n_init=4, batch_size=2048).fit_predict(Xc @ P[:50].T)

# normalise to a 0..1000 grid (robust to outliers via 1/99 percentiles)
def grid(a):
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / ((hi - lo) or 1), 0, 1)
gx = (grid(Y[:, 0]) * 1000).round().astype(int)
gy = (grid(Y[:, 1]) * 1000).round().astype(int)

out = {'meta': {'n': int(len(X)), 'n_visual': int(Vmask.sum()), 'n_concept': int(Cmask.sum()),
                'k': K, 'n_videos': int(len(set(owner))), 'encoder': 'gemini'},
       'x': gx.tolist(), 'y': gy.tolist(), 'm': mod.tolist(), 'c': cl.tolist(),
       'v': vid.tolist(), 's': secs.tolist()}
json.dump(out, open(os.path.join(HERE, 'rtg_embedmap.json'), 'w'))
sz = os.path.getsize(os.path.join(HERE, 'rtg_embedmap.json')) / 1024
print(f"wrote rtg_embedmap.json · {len(X)} points · {K} clusters · {sz:.0f} KB", flush=True)
