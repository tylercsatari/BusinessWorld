#!/usr/bin/env python3
"""
RTG · the JEPA predictor HEAD (frontier recipe: frozen encoder + small latent predictor,
à la DINO-world / ThinkJEPA). Probabilistic (Var-JEPA-style) so it yields expectation
SHARPNESS directly — which is exactly reference-ness.

Frozen encoder = SigLIP2 contextual tokens (rtg_tokens_ctx.npz) — swap for Qwen3-VL /
Gemini embeddings by pointing TOKENS at a different npz; nothing else changes.

Per second the head sees [visual ; contextual-concept] (so the spoken idea drives the
VISUAL expectation — the cross-modal-context case) and predicts the future visual
embedding mean μ_t plus a log-variance (its confidence):

  expectation(t) = μ_t            (what it expects to come)
  sharpness(t)   = exp(-logvar)   (a SPECIFIC future, not diffuse — the probabilistic part)
  forwardness(t) = 1 - cos(μ_t, content(t))   (points to something NOT present now)
  reference-ness(t) = sharpness × forwardness        (intrinsic, causal, real — not a proxy)
  link(i→j) = cos(μ_i, visual_j) ;  payoff-ness(j) = max_i refness_i · link(i→j)

Overwrites refness/payoff/links in rtg_field.json with these real predictive fields.
"""
import os, json
import numpy as np, torch, torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
DEV = 'mps' if torch.backends.mps.is_available() else 'cpu'
torch.manual_seed(7); np.random.seed(7)
TOKENS = next((f for f in ['rtg_tokens_gemini.npz', 'rtg_tokens_ctx.npz', 'rtg_tokens_siglip.npz'] if os.path.exists(os.path.join(HERE, f))), 'rtg_tokens_siglip.npz')
PCA_D = 256; H = 256; K = 8; EPOCHS = 45; LR = 1e-3


class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.gru = nn.GRU(2 * PCA_D, H, batch_first=True)
        self.kemb = nn.Embedding(K + 1, 32)
        self.mu = nn.Sequential(nn.Linear(H + 32, H), nn.GELU(), nn.Linear(H, PCA_D))
        self.lv = nn.Sequential(nn.Linear(H + 32, H), nn.GELU(), nn.Linear(H, 1))

    def ctx(self, x):
        return self.gru(x.unsqueeze(0))[0].squeeze(0)

    def pred(self, c, k):
        h = torch.cat([c, self.kemb(k)], -1)
        m = self.mu(h)
        return m / (m.norm(dim=-1, keepdim=True) + 1e-9), self.lv(h).squeeze(-1)


def main():
    z = np.load(os.path.join(HERE, TOKENS)); print('tokens:', TOKENS, flush=True)
    owner, sec = z['owner'], z['sec']
    V = z['clip_img'].astype(np.float32); C = z['clip_txt'].astype(np.float32)

    def pca(X):
        mu = X.mean(0); Xc = X - mu
        P = np.linalg.svd(Xc, full_matrices=False)[2][:PCA_D].T
        Y = Xc @ P; Y /= (np.linalg.norm(Y, 1, keepdims=True).T + 1e-9) if False else (np.linalg.norm(Y, axis=1, keepdims=True) + 1e-9)
        return Y.astype(np.float32)
    Vp, Cp = pca(V), pca(C)
    t = lambda a: torch.tensor(a, device=DEV)
    seq = {}
    for r in range(len(owner)):
        seq.setdefault(int(owner[r]), []).append(r)
    vids = [np.array(sorted(seq[vi], key=lambda r: sec[r])) for vi in sorted(seq)]

    SRC = {}; TGT = {}; pairs = {}
    for i, rows in enumerate(vids):
        n = len(rows)
        SRC[i] = t(np.concatenate([Vp[rows], Cp[rows]], 1))   # [visual ; concept]
        TGT[i] = t(Vp[rows])                                   # predict future VISUAL
        ii = [a for a in range(n - 1) for k in range(1, min(K, n - 1 - a) + 1)]
        kk = [k for a in range(n - 1) for k in range(1, min(K, n - 1 - a) + 1)]
        jj = [a + k for a in range(n - 1) for k in range(1, min(K, n - 1 - a) + 1)]
        if ii:
            pairs[i] = (ii, t(np.array(kk, np.int64)), jj)

    net = Head().to(DEV); opt = torch.optim.Adam(net.parameters(), LR)
    keys = list(pairs)
    for ep in range(EPOCHS):
        net.train(); tot = 0.0; nb = 0
        for i in np.random.permutation(keys):
            ii, kk, jj = pairs[i]
            c = net.ctx(SRC[i])
            mu, lv = net.pred(c[ii], kk)
            tgt = TGT[i][jj]
            e = 1 - (mu * tgt).sum(-1)                         # cosine error
            loss = (0.5 * (e ** 2) * torch.exp(-lv) + 0.5 * lv).mean()   # Gaussian NLL on cosine error
            opt.zero_grad(); loss.backward(); opt.step()
            tot += float(loss) * len(ii); nb += len(ii)
        if ep % 15 == 0:
            print(f"  epoch {ep:2d}  loss {tot/max(1,nb):.4f}", flush=True)
    net.eval()

    # ---- per video: TWO predictive signals, ADDED to the zoo (never clobbering ensemble) ----
    try:
        LBL = {k: v for k, v in json.load(open(os.path.join(HERE, 'rtg_labels.json'))).items() if isinstance(v, dict) and v.get('pairs')}
    except Exception:
        LBL = {}
    d = json.load(open(os.path.join(HERE, 'rtg_field.json')))
    byid = {v['id']: v for v in d['videos']}
    meta = json.load(open(os.path.join(HERE, 'rtg_meta.json')))['videos']
    order = sorted(seq)

    def peaks(ref, n):
        return [a for a in range(n - 1) if ref[a] > 0.12 and (a == 0 or ref[a] >= ref[a - 1]) and (a == n - 1 or ref[a] >= ref[a + 1])]
    jepa_links, anti_links = {}, {}
    with torch.no_grad():
        for i, rows in enumerate(vids):
            n = len(rows); vid = meta[order[i]]['id']; rec = byid.get(vid)
            if rec is None or n < 3:
                continue
            c = net.ctx(SRC[i]); Vn = TGT[i].cpu().numpy()
            mus = np.zeros((K, n, PCA_D), np.float32); lvs = np.zeros((K, n), np.float32)
            for k in range(1, K + 1):
                m, lv = net.pred(c, t(np.full(n, k, np.int64))); mus[k - 1] = m.cpu().numpy(); lvs[k - 1] = lv.cpu().numpy()
            # (1) CONCRETE predictive reference-ness: a SHARP expectation pointing forward
            mu1, lv1 = mus[0], lvs[0]
            sharp = 1.0 / (1.0 + np.exp(lv1 - lv1.mean()))
            ref = sharp * np.clip(1 - np.sum(mu1 * Vn, 1), 0, None); ref = ref / (ref.max() + 1e-9)
            L = mu1 @ Vn.T
            pay = np.zeros(n)
            for j in range(1, n):
                pay[j] = max((ref[a] * L[a, j] for a in range(j)), default=0.0)
            pay = np.clip(pay, 0, None); pay = pay / (pay.max() + 1e-9)
            jl = sorted([{'i': a, 'j': int(max(range(a + 1, n), key=lambda j: L[a, j])), 's': round(float(ref[a]), 3),
                          'p': round(float(pay[int(max(range(a + 1, n), key=lambda j: L[a, j]))]), 3)} for a in peaks(ref, n)], key=lambda l: -l['s'])[:16]
            rec.setdefault('signals', {})['jepa'] = {'refness': [round(float(x), 3) for x in ref], 'payoff': [round(float(x), 3) for x in pay], 'links': jl}
            jepa_links[vid] = jl
            # (2) IMPLICIT anticipation ("where is this going"): the model is sure the scene will
            # CHANGE (high forwardness over the horizon) but UNCERTAIN which future (high variance).
            uncert = np.exp(lvs).mean(0); uncert = uncert - uncert.min(); uncert = uncert / (uncert.max() + 1e-9)
            fwdh = np.clip(np.mean([1 - np.sum(mus[k] * Vn, 1) for k in range(K)], 0), 0, None)
            anti = uncert * fwdh; anti = anti / (anti.max() + 1e-9)
            # resolution = a later moment where that open-ended uncertainty COLLAPSES (the reveal)
            runmax = np.maximum.accumulate(uncert)
            res = np.clip(np.concatenate([[0.0], runmax[:-1]]) - uncert, 0, None); res = res / (res.max() + 1e-9)
            al = []
            for a in peaks(anti, n):
                bj = next((j for j in range(a + 2, n) if uncert[j] < 0.5 * uncert[a]), None)
                if bj is None and a + 2 < n:
                    bj = int(min(range(a + 2, n), key=lambda j: uncert[j]))
                if bj is not None:
                    al.append({'i': a, 'j': int(bj), 's': round(float(anti[a]), 3), 'p': round(float(res[int(bj)]), 3)})
            al = sorted(al, key=lambda l: -l['s'])[:16]
            rec['signals']['jepa_anticip'] = {'refness': [round(float(x), 3) for x in anti], 'payoff': [round(float(x), 3) for x in res], 'links': al}
            anti_links[vid] = al

    def recall(lm):
        cap = tot = 0
        for vid, Lb in LBL.items():
            lk = lm.get(vid, [])
            for p in Lb['pairs']:
                tot += 1; cap += any(abs(l['i'] - p['r']) <= 3 and abs(l['j'] - p['g']) <= 3 for l in lk)
        return cap, tot
    jc, jt = recall(jepa_links); ac, at = recall(anti_links)
    print(f"jepa recall {jc}/{jt}={jc/max(1,jt)*100:.0f}% · anticip recall {ac}/{at}={ac/max(1,at)*100:.0f}% (vs ensemble 87%)", flush=True)

    sigs = d['meta'].get('signals', [])
    for s in ['jepa', 'jepa_anticip']:
        if s not in sigs:
            sigs.append(s)
    d['meta']['signals'] = sigs            # default stays 'ensemble' — these are added, not promoted
    d['meta'].setdefault('signal_labels', {}).update({'jepa': '🧠 JEPA predictor', 'jepa_anticip': '❓ implicit anticipation'})
    d['meta']['jepa_encoder'] = TOKENS.replace('rtg_tokens_', '').replace('.npz', '')
    json.dump(d, open(os.path.join(HERE, 'rtg_field.json'), 'w'))
    print(f"added jepa + jepa_anticip signals · encoder {d['meta']['jepa_encoder']}", flush=True)


if __name__ == '__main__':
    main()
