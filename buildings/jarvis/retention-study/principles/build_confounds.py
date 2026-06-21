#!/usr/bin/env python3
"""
CONFOUND FALSIFICATION AUDIT — does any metadata actually move retention / swipe?

Tests every metadata / context factor (posting time, cadence, account-growth proxies,
audience composition, engagement counts, format) against the RATE targets we care about:
  swipe ratio (keep), retention@5s, avg retention, cold (non-subscriber) retention.

Includes a POSITIVE CONTROL: the same factors tested against VOLUME (24h views, total views).
If metadata is ~0 for the rates but real for volume, that PROVES the test has power and that
confounds hit volume, not the rate — so no confound control is needed for retention/swipe.

It only measures (Spearman r, p, joint CV-R²); it never alters the data, so it can't skew anything.
Output: confounds.json  (aligned to novelty.json video order so the tab can reuse scatters).
"""
import os, json, datetime
import numpy as np
from scipy.stats import spearmanr
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold
from sklearn.metrics import r2_score

HERE = os.path.dirname(os.path.abspath(__file__))
RS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(RS)))
VD = os.path.join(ROOT, 'video_data')
TODAY = datetime.date(2026, 6, 20)
np.random.seed(7)


def cvr(X, y, a=1.0, k=5):
    m = np.array([yy is not None and np.isfinite(yy) for yy in y])
    X = X[m]; y = np.array([y[i] for i in range(len(y)) if m[i]], float)
    if len(y) < 20 or X.shape[1] == 0:
        return 0.0
    mu = np.nanmedian(X, 0); X = np.where(np.isfinite(X), X, mu)
    kf = KFold(k, shuffle=True, random_state=7); oof = np.full(len(y), np.nan)
    for tr, te in kf.split(X):
        m2, s2 = X[tr].mean(0), X[tr].std(0) + 1e-9
        oof[te] = Ridge(a).fit((X[tr] - m2) / s2, y[tr]).predict((X[te] - m2) / s2)
    return round(float(r2_score(y, oof)), 3)


def main():
    N = json.load(open(os.path.join(HERE, 'novelty.json')))
    T = json.load(open(os.path.join(RS, 'retention_table.json')))
    tby = {v['id']: v for v in T['videos']}
    V = N['videos']; n = len(V)
    grid = np.linspace(0, 1, 100)

    def analysis(vid):
        try:
            return json.load(open(os.path.join(VD, vid, 'analysis.json')))
        except Exception:
            return {}
    AN = [analysis(v['id']) for v in V]

    # ---- targets ----
    keep, ret, ret5, nonsub, day1, total = [], [], [], [], [], []
    for i, v in enumerate(V):
        t = tby.get(v['id'], {}); an = AN[i].get('analytics', {})
        keep.append(t.get('keep_rate')); ret.append(t.get('avg_retention'))
        cv, d = t.get('curve'), t.get('duration_s')
        ret5.append(float(np.interp(min(1.0, 5.0 / d), grid, cv) / (sum(cv[:3]) / 3) * 100) if cv and d else None)  # 5s survival from opening
        nonsub.append(an.get('nonSubscriberAvgPercent'))
        dv = an.get('dailyViews') or []
        day1.append(dv[0].get('views') if dv and isinstance(dv[0], dict) else None)
        total.append(t.get('views'))
    targets = {'keep_rate': keep, 'ret_5s': ret5, 'retention': ret, 'nonsub_ret': nonsub, 'day1_views': day1, 'total_views': total}
    TLAB = {'keep_rate': ('Swipe ratio (keep)', 'rate'), 'ret_5s': ('Retention @ 5s', 'rate'), 'retention': ('Avg retention', 'rate'),
            'nonsub_ret': ('Cold (non-sub) retention', 'rate'), 'day1_views': ('24h views', 'volume'), 'total_views': ('Total views', 'volume')}

    # ---- confound / metadata features ----
    pub = []
    for v in V:
        try:
            pub.append(datetime.date.fromisoformat(v['published']) if v.get('published') else None)
        except Exception:
            pub.append(None)
    order = sorted([i for i in range(n) if pub[i]], key=lambda i: pub[i])
    timeline = {i: r for r, i in enumerate(order)}
    prev_gap = {}
    for k, i in enumerate(order):
        prev_gap[i] = (pub[i] - pub[order[k - 1]]).days if k > 0 else None

    feats = {}                          # name -> (role, array)
    # role: external = exogenous context (the real confounds) · downstream = consequence of the video
    #       · audience = who it was served to · content = intrinsic to the video itself

    def add(name, role, arr):
        feats[name] = (role, arr)

    add('post_day_of_week', 'external', [pub[i].weekday() if pub[i] else None for i in range(n)])
    add('post_month', 'external', [pub[i].month if pub[i] else None for i in range(n)])
    add('timeline_position', 'external', [timeline.get(i) for i in range(n)])      # account-growth stage
    add('days_since_prev_post', 'external', [prev_gap.get(i) for i in range(n)])   # posting frequency
    add('video_age_days', 'external', [(TODAY - pub[i]).days if pub[i] else None for i in range(n)])
    add('subscribers_gained', 'downstream', [AN[i].get('analytics', {}).get('subscribersGained') for i in range(n)])
    add('subscribers_lost', 'downstream', [AN[i].get('analytics', {}).get('subscribersLost') for i in range(n)])
    add('subscriber_view_fraction', 'audience', [(lambda a: (a.get('subscriberViews') / a['totalViews']) if a.get('totalViews') and a.get('subscriberViews') is not None else None)(AN[i].get('analytics', {})) for i in range(n)])
    likes = [tby.get(V[i]['id'], {}).get('likes') for i in range(n)]
    comments = [tby.get(V[i]['id'], {}).get('comments') for i in range(n)]
    shares = [tby.get(V[i]['id'], {}).get('shares') for i in range(n)]
    add('likes', 'downstream', likes); add('comments', 'downstream', comments); add('shares', 'downstream', shares)
    add('like_rate', 'downstream', [(likes[i] / total[i] * 1000) if likes[i] is not None and total[i] else None for i in range(n)])
    add('comment_rate', 'downstream', [(comments[i] / total[i] * 1000) if comments[i] is not None and total[i] else None for i in range(n)])
    add('share_rate', 'downstream', [(shares[i] / total[i] * 1000) if shares[i] is not None and total[i] else None for i in range(n)])
    add('duration', 'content', [tby.get(V[i]['id'], {}).get('duration_s') for i in range(n)])
    add('aspect_ratio', 'content', [(lambda m: (m.get('height') / m['width']) if m.get('width') and m.get('height') else None)(AN[i].get('metadata', {})) for i in range(n)])
    add('is_vertical', 'content', [1.0 if AN[i].get('metadata', {}).get('isVertical') else 0.0 for i in range(n)])

    def corr(a, b):
        p = [(x, y) for x, y in zip(a, b) if x is not None and y is not None and np.isfinite(x) and np.isfinite(y)]
        if len(p) < 12:
            return None
        xa, ya = zip(*p)
        if len(set(xa)) < 2 or len(set(ya)) < 2:
            return None
        r, pv = spearmanr(xa, ya)
        return {'r': round(float(r), 3), 'p': float(pv), 'n': len(p)}

    out_feats, pvals = [], []
    for name, (role, arr) in feats.items():
        cd = {}
        for tk, tv in targets.items():
            c = corr(arr, tv)
            if c:
                cd[tk] = c; pvals.append(c['p'])
        out_feats.append({'name': name, 'role': role, 'corr': cd,
                          'values': [round(float(x), 4) if x is not None and np.isfinite(x) else None for x in arr]})

    # joint CV-R² per role group (the headline: do the EXTERNAL confounds explain the rate at all?)
    def Xof(names):
        return np.array([[(feats[nm][1][i] if feats[nm][1][i] is not None else np.nan) for nm in names] for i in range(n)], float)
    roles = ['external', 'downstream', 'audience', 'content']
    role_names = {r: [nm for nm in feats if feats[nm][0] == r] for r in roles}
    role_joint = {r: {tk: cvr(Xof(role_names[r]), tv) for tk, tv in targets.items()} for r in roles if role_names[r]}
    joint = {tk: cvr(Xof(list(feats)), tv) for tk, tv in targets.items()}

    pvals.sort(); m_tests = len(pvals); fdr_p = 0.0
    for k, p in enumerate(pvals, 1):
        if p <= 0.10 * k / m_tests:
            fdr_p = p
    bonf = 0.05 / m_tests if m_tests else 0
    json.dump({'meta': {'n': n, 'n_features': len(out_feats), 'n_tests': m_tests, 'bonferroni_p': bonf, 'fdr_p': round(fdr_p, 5)},
               'targets': [{'key': k, 'label': TLAB[k][0], 'kind': TLAB[k][1]} for k in targets],
               'joint_r2': joint, 'role_joint_r2': role_joint, 'roles': roles,
               'target_values': {k: [round(float(x), 3) if x is not None and np.isfinite(x) else None for x in v] for k, v in targets.items()},
               'features': out_feats},
              open(os.path.join(HERE, 'confounds.json'), 'w'))

    print(f"confounds.json · {len(out_feats)} metadata factors × {len(targets)} targets")
    print("joint CV-R² (does metadata explain the target at all?):")
    for tk in targets:
        print(f"  {TLAB[tk][0]:26} [{TLAB[tk][1]:6}] {joint[tk]:+.3f}")
    print("\nstrongest metadata correlations per RATE target:")
    for tk in ['keep_rate', 'ret_5s', 'retention', 'nonsub_ret']:
        best = sorted([(abs(f['corr'][tk]['r']), f['name'], f['corr'][tk]) for f in out_feats if tk in f['corr']], reverse=True)[:3]
        print(f"  {TLAB[tk][0]}: " + ", ".join(f"{nm} r={c['r']:+.2f} p={c['p']:.3f}" for _, nm, c in best))


if __name__ == '__main__':
    main()
