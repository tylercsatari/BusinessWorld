#!/usr/bin/env python3
"""
RETENTION × SWIPE → VIEWS study · RV1 — extract the real per-% retention curves.

Source: video_data/<id>/analysis.json → `analytics`, which carries the FULL YouTube
audience-retention curve (100 points over 0–100% of duration), the real swipe metric
(swipedAwayRate / viewedRate), views, duration, sub/non-sub splits, engagement.

Filters (per the user):
  • keep ONLY videos that actually have the swipe metric saved (swipedAwayRate)
  • keep ONLY videos posted in the last 3 years (swipe-away was introduced then)

Output: retention_data.json — { meta, videos:[ { id, curve[100], swipe, stay, views,
log_views, avg_retention, duration_s, published, recency_yr, sub_frac, nonsub_ret,
likes/shares/comments } ] }. Curves resampled to a uniform 100-pt grid on [0,1].
"""
import os, json, datetime
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
VD = os.path.join(ROOT, 'video_data')
OUT = os.path.join(HERE, 'retention_data.json')
GRID = np.linspace(0.0, 1.0, 100)            # common normalized-position grid
TODAY = datetime.date(2026, 6, 17)
CUTOFF = TODAY - datetime.timedelta(days=365 * 3)   # last 3 years


def resample(curve):
    pts = [(float(p['second']), float(p['retention'])) for p in curve
           if isinstance(p.get('second'), (int, float)) and isinstance(p.get('retention'), (int, float))]
    if len(pts) < 20:
        return None
    pts.sort()
    xs = np.array([p[0] for p in pts]); ys = np.array([p[1] for p in pts])
    xs = xs / xs.max() if xs.max() > 1.5 else xs           # normalize x to [0,1] if it's % or seconds
    return np.interp(GRID, xs, ys).astype(float)


def main():
    dirs = [d for d in os.listdir(VD) if os.path.exists(os.path.join(VD, d, 'analysis.json'))]
    vids, skipped = [], {'no_swipe': 0, 'old': 0, 'no_curve': 0}
    for d in dirs:
        try:
            a = json.load(open(os.path.join(VD, d, 'analysis.json')))
        except Exception:
            continue
        an = a.get('analytics')
        if not an or not isinstance(an.get('swipedAwayRate'), (int, float)):
            skipped['no_swipe'] += 1; continue
        # publish date = first day with views
        dv = an.get('dailyViews') or []
        pub = dv[0]['date'] if dv and dv[0].get('date') else None
        try:
            pdt = datetime.date.fromisoformat(pub) if pub else None
        except Exception:
            pdt = None
        if not pdt or pdt < CUTOFF:
            skipped['old'] += 1; continue
        curve = resample(an.get('retentionCurve') or [])
        if curve is None:
            skipped['no_curve'] += 1; continue
        views = an.get('totalViews') or an.get('views')
        if not views or views <= 0:
            continue
        meta = a.get('metadata') or {}
        avg_ret = an.get('avgPercentViewed') if isinstance(an.get('avgPercentViewed'), (int, float)) else an.get('avgRetention')
        dur = meta.get('duration')
        if not dur and isinstance(an.get('avgViewDuration'), (int, float)) and avg_ret:
            dur = an['avgViewDuration'] / (avg_ret / 100.0)
        subv, nsubv = an.get('subscriberViews') or 0, an.get('nonSubscriberViews') or 0
        vids.append({
            'id': d, 'name': meta.get('title', d),
            'curve': [round(x, 4) for x in curve],
            'swipe': float(an['swipedAwayRate']),                 # swiped-away % (feed level)
            'stay': float(an.get('viewedRate', 100 - an['swipedAwayRate'])),  # stayed-to-watch %
            'views': int(views), 'log_views': float(np.log10(views)),
            'avg_retention': float(avg_ret) if avg_ret else None,
            'duration_s': float(dur) if dur else None,
            'published': pub, 'recency_yr': round((TODAY - pdt).days / 365.0, 3),
            'sub_frac': round(subv / (subv + nsubv), 4) if (subv + nsubv) else None,   # subscriber share of views
            'nonsub_ret': an.get('nonSubscriberAvgPercent'),       # cold-audience retention (less rewatch bias)
            'sub_ret': an.get('subscriberAvgPercent'),
            'likes': an.get('likes'), 'shares': an.get('shares'), 'comments': an.get('comments'),  # mediators (excluded from content model)
        })
    out = {'meta': {'n': len(vids), 'grid': 'normalized 0..1, 100 pts', 'today': str(TODAY),
                    'cutoff': str(CUTOFF), 'skipped': skipped,
                    'swipe_def': 'swipe = swipedAwayRate (feed swiped-away %); stay = viewedRate = 100 - swipe',
                    'curve_note': 'retention can exceed 1.0 at the start (replay/rewatch inflation)'},
           'videos': vids}
    json.dump(out, open(OUT, 'w'))
    sw = np.array([v['swipe'] for v in vids]); vw = np.array([v['log_views'] for v in vids])
    starts = np.array([v['curve'][0] for v in vids])
    print(f"kept {len(vids)} videos (last 3yr + has swipe) · skipped {skipped}")
    print(f"swipe %: {sw.min():.1f}–{sw.max():.1f} (median {np.median(sw):.1f}) · "
          f"log10 views: {vw.min():.2f}–{vw.max():.2f} · curve-start >1.0 (replay): {(starts>1).sum()}/{len(vids)}")


if __name__ == '__main__':
    main()
