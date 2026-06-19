#!/usr/bin/env python3
"""
CONCEPTS — quantitative definition (replaces frequency word-picking).

Definition of a CONCEPT (objective, reproducible):
  Candidate phrases = all 1-3 word n-grams in the hook script minus English stopwords.
  Embed each candidate and the whole hook with MiniLM.
    relevance(p)   = cos( E(p), E(hook) )                         # how central the phrase is
  Select concepts by Maximal Marginal Relevance (KeyBERT):
    MMR(p) = λ·relevance(p) − (1−λ)·max_{q∈chosen} cos(E(p),E(q)) # central AND non-redundant
  → "show", "good" score low (not central); "indestructible armour", "crossword puzzle" win.
  Each concept carries a scalar centrality score. Single throwaway words are filtered by the math.

COMBINATORIAL is then defined at the CONCEPT-CLUSTER level (so combinations recur and are countable):
  Cluster every concept embedding corpus-wide (k-means). A concept-cluster = a recurring idea.
  N_combo(hook) = mean rarity (1/(co-occurrence+1)) of the cluster PAIRS present in the hook.

Output: concepts.json
"""
import os, json, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
np.random.seed(7)


def main():
    from sklearn.feature_extraction.text import CountVectorizer
    from sklearn.cluster import KMeans
    from sentence_transformers import SentenceTransformer
    M = json.load(open(os.path.join(HERE, 'hooks_meta.json')))['meta']
    st = SentenceTransformer('all-MiniLM-L6-v2')

    def L2(x):
        return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-9)

    def cand_phrases(text):
        try:
            cv = CountVectorizer(ngram_range=(1, 3), stop_words='english').fit([text])
            return [g for g in cv.get_feature_names_out().tolist() if re.search(r'[a-z]{3}', g)]
        except Exception:
            return []

    def mmr(doc, cembs, cands, k=6, lam=0.6):
        if not cands:
            return []
        sd = cembs @ doc; scc = cembs @ cembs.T
        sel = [int(np.argmax(sd))]; rest = [i for i in range(len(cands)) if i != sel[0]]
        while len(sel) < min(k, len(cands)) and rest:
            best = None
            for c in rest:
                red = max(scc[c, s] for s in sel)
                sc = lam * sd[c] - (1 - lam) * red
                if best is None or sc > best[1]:
                    best = (c, sc)
            sel.append(best[0]); rest.remove(best[0])
        return [(cands[i], round(float(sd[i]), 3)) for i in sel]

    per = {}
    all_phrases = []
    for m in M:
        txt = (m.get('hook_text') or '').strip()
        cands = cand_phrases(txt)
        if not cands or len(txt) < 4:
            per[m['id']] = []
            continue
        cemb = L2(st.encode(cands)); demb = L2(st.encode(txt))
        chosen = mmr(demb, cemb, cands, k=6, lam=0.6)
        per[m['id']] = chosen
        all_phrases += [p for p, _ in chosen]

    # cluster concepts corpus-wide → concept-clusters (recurring ideas)
    uniq = sorted(set(all_phrases))
    pe = L2(st.encode(uniq)) if uniq else np.zeros((0, 384))
    K = max(2, min(28, len(uniq) // 4)) if len(uniq) > 8 else max(1, len(uniq))
    km = KMeans(K, n_init=10, random_state=7).fit(pe) if len(uniq) >= K and K > 1 else None
    lab = km.labels_ if km is not None else np.zeros(len(uniq), int)
    phrase_cluster = {p: int(lab[i]) for i, p in enumerate(uniq)}
    # cluster label = phrase nearest its centroid
    clus_label = {}
    if km is not None:
        for c in range(K):
            idx = np.where(lab == c)[0]
            if len(idx):
                d = pe[idx] @ km.cluster_centers_[c] / (np.linalg.norm(km.cluster_centers_[c]) + 1e-9)
                clus_label[c] = uniq[idx[int(np.argmax(d))]]
    else:
        for i, p in enumerate(uniq):
            clus_label[int(lab[i])] = p

    # per-hook cluster sets + co-occurrence + rarity
    hook_clusters = {m['id']: sorted(set(phrase_cluster[p] for p, _ in per[m['id']])) for m in M}
    nC = (max(phrase_cluster.values()) + 1) if phrase_cluster else 1
    co = np.zeros((nC, nC))
    cfreq = np.zeros(nC)
    for cs in hook_clusters.values():
        for c in cs:
            cfreq[c] += 1
        for a in range(len(cs)):
            for b in range(a + 1, len(cs)):
                co[cs[a], cs[b]] += 1; co[cs[b], cs[a]] += 1
    rarity = []
    for m in M:
        cs = hook_clusters[m['id']]; vals = []
        for a in range(len(cs)):
            for b in range(a + 1, len(cs)):
                vals.append(1.0 / (co[cs[a], cs[b]] + 1.0))
        rarity.append(round(float(np.mean(vals)), 4) if vals else None)

    # cluster graph layout (2D) from co-occurrence
    from sklearn.decomposition import PCA
    pos = [[0.0, 0.0]] * nC
    if nC > 2:
        Y = PCA(2, random_state=7).fit_transform(co + np.eye(nC) * 1e-3)
        Y = Y - Y.mean(0); Y = Y / (np.abs(Y).max() + 1e-9)
        pos = [[round(float(a), 4), round(float(b), 4)] for a, b in Y]
    edges = [{'a': int(a), 'b': int(b), 'w': int(co[a, b])} for a in range(nC) for b in range(a + 1, nC) if co[a, b] >= 2]

    json.dump({'per_video': {vid: [{'phrase': p, 'score': s, 'cluster': phrase_cluster[p]} for p, s in cc] for vid, cc in per.items()},
               'clusters': [{'id': c, 'label': clus_label.get(c, str(c)), 'freq': int(cfreq[c]), 'pos': pos[c]} for c in range(nC)],
               'edges': edges, 'rarity': rarity, 'k_clusters': int(nC)},
              open(os.path.join(HERE, 'concepts.json'), 'w'))
    print(f"concepts.json · {len(uniq)} unique phrases · {nC} concept-clusters · {sum(1 for r in rarity if r is not None)}/{len(M)} hooks with combos")


if __name__ == '__main__':
    main()
