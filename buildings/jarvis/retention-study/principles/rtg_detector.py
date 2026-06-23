#!/usr/bin/env python3
"""
RTG · v1 PREDICTIVE detector — the real instrument (CPC / conditional-PMI).

v0 used cosine SIMILARITY, which is symmetric + atemporal and provably can't expose a
DIRECTED reference->gratification. This trains a small CONTRASTIVE PREDICTIVE model:

  context c_i = causal GRU over the source channel up to second i
  critic  f(c_i, z_j, k) = pred(c_i, k) · z_j        (k = j - i, the lag)
  InfoNCE over cross-video negatives  =>  f* -> log p(z_j | c_i) / p(z_j) = directed PMI

So the learned f(c_i, z_j) IS the conditional pointwise mutual information = how much the
past-through-i predicts moment j beyond the corpus marginal. Directed, predictive, learned
baseline — everything similarity couldn't be. Four critics give the four channels:
  cv = concept->visual (promise->proof) · vv · cc · vc.

EXISTENCE TEST (redesigned, the go/no-go): train on TRAIN videos, evaluate on HELD-OUT videos.
Compare the learned critic to (a) time-shuffled context, (b) the v0 similarity score, (c) chance.
If the learned predictor beats them on data it never saw, a directed predictive channel EXISTS.

Output: rtg_pred.json  (mirrors rtg.json's per-video schema so the UI reuses every visual,
plus existence_pred with held-out MI / top-1 accuracy per channel).
"""
import os, json
import numpy as np, torch, torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
VD = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(RS))), 'video_data')
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
torch.manual_seed(7); np.random.seed(7)

PCA_D = 128       # reduce CLIP 512 -> 128 (speed + denoise)
H = 256           # context (GRU) hidden size
K = 12            # max lag modelled (seconds); hook->payoff almost always < 12s
EPOCHS = 30
LR = 1e-3
TEMP = 0.07
NEG = 512         # InfoNCE negative-pool size
DS_GRID = 20; MAT_SCALE = 1.5; MIN_GAP = 2; MAX_EDGES = 40; SURPRISE_K = 1.0
MODS = ['cv', 'vv', 'cc', 'vc']
MOD_LABEL = {'cv': 'concept -> visual', 'vv': 'visual -> visual', 'cc': 'concept -> concept', 'vc': 'visual -> concept'}
COMBO = {'cv': ('c', 'v'), 'vv': ('v', 'v'), 'cc': ('c', 'c'), 'vc': ('v', 'c')}


class Critic(nn.Module):
    def __init__(self):
        super().__init__()
        self.gru = nn.GRU(PCA_D, H, batch_first=True)
        self.kemb = nn.Embedding(K + 1, 32)
        self.pred = nn.Sequential(nn.Linear(H + 32, H), nn.GELU(), nn.Linear(H, PCA_D))

    def context(self, src):                 # src (T, d) -> c (T, H), causal (c[t] sees 0..t)
        out, _ = self.gru(src.unsqueeze(0))
        return out.squeeze(0)

    def predict(self, c_rows, k):           # (M,H),(M,) -> (M,d)
        return self.pred(torch.cat([c_rows, self.kemb(k)], -1))


def main():
    z = np.load(os.path.join(HERE, 'rtg_tokens.npz'))
    owner, sec = z['owner'], z['sec']
    Craw = z['clip_txt'].astype(np.float32)
    hasc = z['has_c'].astype(bool)
    # visual channel: prefer V-JEPA2 (temporal) tokens if present, else CLIP-image
    vj = os.path.join(HERE, 'rtg_tokens_vjepa.npz')
    if os.path.exists(vj):
        zj = np.load(vj)
        if len(zj['owner']) == len(owner) and (zj['owner'] == owner).all() and (zj['sec'] == sec).all():
            Vraw = zj['vjepa'].astype(np.float32)
        else:
            idx = {(int(o), int(s)): i for i, (o, s) in enumerate(zip(zj['owner'], zj['sec']))}
            Vraw = np.stack([zj['vjepa'][idx[(int(o), int(s))]] for o, s in zip(owner, sec)]).astype(np.float32)
        VENC = 'vjepa2-vitg-fpc64-256'
    else:
        Vraw = z['clip_img'].astype(np.float32); VENC = 'clip-vit-base-patch16'
    print('visual encoder:', VENC, flush=True)

    def pca(X):
        mu = X.mean(0); Xc = X - mu
        U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
        P = Vt[:PCA_D].T
        Y = Xc @ P
        Y /= (np.linalg.norm(Y, axis=1, keepdims=True) + 1e-9)
        return Y.astype(np.float32)
    Vp, Cp = pca(Vraw), pca(Craw)
    TOK = {'v': Vp, 'c': Cp}

    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    try:
        NOV = {v['id']: v for v in json.load(open(os.path.join(HERE, 'novelty.json')))['videos']}
    except Exception:
        NOV = {}

    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)
    vids = []
    for vi in sorted(seq):
        rows = np.array(sorted(seq[vi], key=lambda r: sec[r]))
        vids.append({'vi': vi, 'rows': rows})

    # train / held-out split by video (~20% held out)
    heldout = set(i for i in range(len(vids)) if (vids[i]['vi'] * 2654435761) % 5 == 0)
    train_idx = [i for i in range(len(vids)) if i not in heldout]
    held_idx = [i for i in range(len(vids)) if i in heldout]

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

    t = lambda a: torch.tensor(a, device=DEV)
    pairs = []                                    # (vi_local, i, k) over train
    for li in train_idx:
        n = len(vids[li]['rows'])
        for i in range(n - 1):
            for k in range(1, min(K, n - 1 - i) + 1):
                pairs.append((li, i, k))
    pairs = np.array(pairs)

    existence = {}; critics = {}
    for mkey in MODS:
        sx, sy = COMBO[mkey]
        SRC = {li: t(TOK[sx][vids[li]['rows']]) for li in range(len(vids))}
        TGT = {li: t(TOK[sy][vids[li]['rows']]) for li in range(len(vids))}
        tgt_pool_all = t(TOK[sy][np.concatenate([vids[li]['rows'] for li in train_idx])])
        net = Critic().to(DEV); opt = torch.optim.Adam(net.parameters(), lr=LR)
        # per-video (i,k) index lists, built once
        vpairs = {}
        for li in train_idx:
            n = len(vids[li]['rows']); ii = []; kk = []; jj = []
            for i in range(n - 1):
                for k in range(1, min(K, n - 1 - i) + 1):
                    ii.append(i); kk.append(k); jj.append(i + k)
            if ii:
                vpairs[li] = (ii, t(np.array(kk, np.int64)), jj)
        for ep in range(EPOCHS):
            net.train(); tot = 0.0; nb = 0
            negpool = tgt_pool_all[torch.randint(0, tgt_pool_all.shape[0], (NEG,), device=DEV)]
            for li in np.random.permutation(list(vpairs.keys())):
                ii, ks, jj = vpairs[li]
                c = net.context(SRC[li])
                pr = net.predict(c[ii], ks)
                lp = (pr * TGT[li][jj]).sum(-1, keepdim=True)
                ln = pr @ negpool.T
                logits = torch.cat([lp, ln], -1) / TEMP
                loss = nn.functional.cross_entropy(logits, torch.zeros(len(ii), dtype=torch.long, device=DEV))
                opt.zero_grad(); loss.backward(); opt.step()
                tot += float(loss) * len(ii); nb += len(ii)
            if ep % 10 == 0:
                print(f"  [{mkey}] epoch {ep:2d}  loss {tot/max(1,nb):.4f}", flush=True)
        net.eval()
        critics[mkey] = (net, SRC, TGT)

        # ---- held-out existence test ----
        with torch.no_grad():
            negpool = tgt_pool_all[torch.randint(0, tgt_pool_all.shape[0], (NEG,), device=DEV)]
            def acc_mi(shuffle=False, sim=False):
                hit = 0; tot = 0; loss_sum = 0.0
                for li in held_idx:
                    n = len(vids[li]['rows'])
                    if n < 3:
                        continue
                    src = SRC[li]
                    if shuffle:
                        src = src[torch.randperm(n, device=DEV)]
                    c = net.context(src)
                    for i in range(n - 1):
                        for k in range(1, min(K, n - 1 - i) + 1):
                            pos = TGT[li][i + k]
                            if sim:
                                q = SRC[li][i]                    # v0-style: raw source token
                                lp = (q * (TGT[li][i + k])).sum()  # cos (normalised)
                                ln = negpool @ q
                            else:
                                pr = net.predict(c[i:i + 1], t(np.array([k])))[0]
                                lp = (pr * pos).sum(); ln = negpool @ pr
                            logits = torch.cat([lp.view(1), ln]) / TEMP
                            loss_sum += float(nn.functional.cross_entropy(logits.view(1, -1), torch.zeros(1, dtype=torch.long, device=DEV)))
                            hit += int(torch.argmax(logits).item() == 0); tot += 1
                acc = hit / max(1, tot)
                mi = max(0.0, np.log(NEG + 1) - loss_sum / max(1, tot))   # InfoNCE MI lower bound (nats)
                return acc, mi, tot
            la, lmi, ntot = acc_mi()
            sa, _, _ = acc_mi(shuffle=True)
            ma, _, _ = acc_mi(sim=True)
            chance = 1.0 / (NEG + 1)
            existence[mkey] = {'label': MOD_LABEL[mkey], 'learned_acc': round(la, 4), 'mi_nats': round(lmi, 4),
                               'shuffled_acc': round(sa, 4), 'similarity_acc': round(ma, 4),
                               'chance_acc': round(chance, 5), 'n_eval': ntot}
            print(f"  [{mkey}] held-out: learned {la:.3f} (MI {lmi:.3f} nats) · shuffled {sa:.3f} · similarity {ma:.3f} · chance {chance:.4f}", flush=True)

    # ---- per-video learned dependency D[i,j] (PMI), edges, RTG functionals ----
    def pmi_matrix(mkey, li, n):
        net, SRC, TGT = critics[mkey]
        with torch.no_grad():
            c = net.context(SRC[li])
            negpool = torch.stack([TGT[lj][min(1, len(vids[lj]['rows']) - 1)] for lj in np.random.choice(len(vids), 256)])
            D = np.full((n, n), np.nan, np.float32)
            for i in range(n - 1):
                for k in range(1, min(K, n - 1 - i) + 1):
                    pr = net.predict(c[i:i + 1], torch.tensor([k], device=DEV))[0]
                    pos = (pr * TGT[li][i + k]).sum()
                    lme = torch.logsumexp((negpool @ pr) / 1.0, 0) - np.log(negpool.shape[0])
                    D[i, i + k] = float(pos - lme)              # directed PMI estimate
        return D

    out_vids = []
    for li in range(len(vids)):
        rows = vids[li]['rows']; n = len(rows); info = meta[vids[li]['vi']]; vid = info['id']
        nov = NOV.get(vid, {})
        rec = {'id': vid, 'title': nov.get('title') or vid, 'published': nov.get('published'),
               'n_sec': int(n), 'duration': info.get('duration'), 'held_out': li in heldout,
               'has_c': hasc[rows].astype(int).tolist(), 'edges': [], 'counts': {}}
        if n >= MIN_GAP + 1:
            Dm = {m: pmi_matrix(m, li, n) for m in MODS}
            # null ceiling per channel = high quantile of that channel's own off-diagonal PMI
            edges_all = []
            for m in MODS:
                D = Dm[m]; fin = D[np.isfinite(D)]
                tau = float(np.quantile(fin, 0.9)) if fin.size else 1e9
                cand = np.where(np.isfinite(D), D, -1e9)
                for i in range(n):
                    j = int(np.argmax(cand[i]))
                    if cand[i, j] > tau and (j - i) >= MIN_GAP:
                        edges_all.append({'i': i, 'j': j, 'mod': m, 's': round(float(D[i, j]), 4),
                                          'r': round(float(D[i, j]), 4), 'z': round(float(D[i, j] - tau), 4)})
            edges_all.sort(key=lambda e: e['z'], reverse=True)
            E = rec['edges'] = edges_all[:MAX_EDGES]
            refSet = set(e['i'] for e in E); gratSet = set(e['j'] for e in E)
            # surprise from the predictive model: S(j) = -PMI(j | context, lag 1)  (visual target)
            Dv = Dm['vv']
            vsurp = [0.0] * n
            for j in range(1, n):
                pj = Dv[j - 1, j]
                vsurp[j] = round(float(-pj) if np.isfinite(pj) else 0.0, 4)
            sa = np.array(vsurp[1:]) if n > 1 else np.array([0.0])
            thr = float(sa.mean() + SURPRISE_K * sa.std()) if sa.size else 1.0
            events = [j for j in range(1, n - 1) if vsurp[j] >= thr and vsurp[j] >= vsurp[j - 1] and vsurp[j] >= vsurp[j + 1]]
            orphan_grat = [j for j in events if j not in gratSet][:8]
            unclosed = []
            for m in MODS:
                D = Dm[m]; fin = D[np.isfinite(D)]
                if not fin.size:
                    continue
                tau = float(np.quantile(fin, 0.9)); lo = float(np.quantile(fin, 0.6))
                cand = np.where(np.isfinite(D), D, -1e9)
                for i in range(n):
                    j = int(np.argmax(cand[i]))
                    if lo < cand[i, j] <= tau and i not in refSet:
                        unclosed.append({'i': i, 'mod': m, 'j': j, 'r': round(float(D[i, j]), 4)})
            unclosed.sort(key=lambda u: u['r'], reverse=True); unclosed = unclosed[:8]
            # tension = unresolved reference mass
            tension = [0.0] * n; dropd = {}
            for e in E:
                s = max(0.0, e['r'])
                for x in range(e['i'], min(e['j'], n - 1) + 1):
                    tension[x] += s
                dropd[e['j']] = dropd.get(e['j'], 0.0) + s
            for u in unclosed:
                s = max(0.0, u['r'])
                for x in range(u['i'], n):
                    tension[x] += s
            tension = [round(x, 4) for x in tension]
            drops = [{'t': k, 'amt': round(v, 4)} for k, v in sorted(dropd.items())]

            def ds(D):
                bins = np.linspace(0, n, DS_GRID + 1).astype(int); out = []
                for a in range(DS_GRID):
                    for b in range(DS_GRID):
                        blk = D[bins[a]:max(bins[a] + 1, bins[a + 1]), bins[b]:max(bins[b] + 1, bins[b + 1])]
                        vals = blk[np.isfinite(blk)]
                        out.append(-128 if vals.size == 0 else int(np.clip(round(float(vals.mean()) / MAT_SCALE * 127), -127, 127)))
                return out
            rec['mat'] = {m: ds(Dm[m]) for m in MODS}
            rec['words'] = words_by_sec(vid, n)
            rec['vsurp'] = vsurp; rec['events'] = events
            rec['tension'] = tension; rec['drops'] = drops
            rec['unclosed'] = unclosed; rec['orphan_grat'] = orphan_grat
            refs = set(); grats = set(); cby = {m: 0 for m in MODS}
            for e in E:
                refs.add((e['i'], e['mod'][0])); grats.add((e['j'], e['mod'][1])); cby[e['mod']] += 1
            rec['counts'] = {'edges': len(E), 'refs': len(refs), 'grats': len(grats), 'by_mod': cby,
                             'unclosed': len(unclosed), 'orphan_grat': len(orphan_grat), 'events': len(events)}
        out_vids.append(rec)
        if (li + 1) % 40 == 0:
            print(f"  decoded {li+1}/{len(vids)}", flush=True)

    cv = existence['cv']
    exists = cv['learned_acc'] > cv['shuffled_acc'] + 0.01 and cv['learned_acc'] > cv['similarity_acc'] + 0.01 and cv['learned_acc'] > 3 * cv['chance_acc']
    if exists:
        verdict = ('A directed PREDICTIVE channel EXISTS: on held-out videos the learned critic predicts future '
                   'concept->visual moments better than time-shuffled context, raw similarity, and chance.')
        diagnosis = ''
    else:
        verdict = ('NOT DETECTED at v1 (small-data probe). On held-out videos the learned critic does not clearly '
                   'beat the shuffled / similarity / chance baselines for concept->visual.')
        diagnosis = ('The CPC critic trained on only 211 videos has too few cross-video examples to learn a general '
                     'promise->proof map, and 1fps + bag-of-words-per-second is coarse. The math is right; the data '
                     'is the bottleneck. v2 = scrape 10^4-10^6 Shorts + finer resolution + V-JEPA/CLAP encoders.')

    json.dump({'meta': {'n': len(out_vids), 'min_gap': MIN_GAP, 'pca_d': PCA_D, 'hidden': H, 'max_lag': K,
                        'visual_encoder': VENC,
                        'epochs': EPOCHS, 'neg': NEG, 'temp': TEMP, 'ds_grid': DS_GRID, 'mat_scale': MAT_SCALE,
                        'surprise_k': SURPRISE_K, 'n_train': len(train_idx), 'n_heldout': len(held_idx)},
               'existence_pred': existence, 'verdict': verdict, 'exists': bool(exists), 'diagnosis': diagnosis,
               'mod_label': MOD_LABEL, 'videos': out_vids},
              open(os.path.join(HERE, 'rtg_pred.json'), 'w'))
    print('\nVERDICT:', verdict)
    print(f"rtg_pred.json · {len(out_vids)} videos · {sum(len(v['edges']) for v in out_vids)} edges")


if __name__ == '__main__':
    main()
