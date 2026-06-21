#!/usr/bin/env python3
"""
RETENTION → VIEWS · auditable data table.

NO analysis. Just the raw, verifiable per-video numbers straight from each video's
analytics, so you can click any row, open it on YouTube, and confirm the figures in
your own YouTube Studio. If the data isn't accurate, nothing built on it can be.

Includes EVERY video that has a retention curve + views (swipe shown as stored —
which is ~0 for pre-2023 videos because YouTube didn't track Shorts swipe-away then;
the `swipe_tracked` flag marks that).

Output: retention_table.json — a flat list, one row per video.
"""
import os, json, datetime
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
VD = os.path.join(ROOT, 'video_data')
OUT = os.path.join(HERE, 'retention_table.json')
GRID = np.linspace(0, 1, 100)


def resample(curve):
    pts = [(float(p['second']), float(p['retention'])) for p in curve
           if isinstance(p.get('second'), (int, float)) and isinstance(p.get('retention'), (int, float))]
    if len(pts) < 20:
        return None
    pts.sort()
    xs = np.array([p[0] for p in pts]); ys = np.array([p[1] for p in pts])
    xs = xs / xs.max() if xs.max() > 1.5 else xs
    return [round(float(v), 4) for v in np.interp(GRID, xs, ys)]


def main():
    rows = []
    for d in os.listdir(VD):
        ap = os.path.join(VD, d, 'analysis.json')
        if not os.path.exists(ap):
            continue
        try:
            a = json.load(open(ap))
        except Exception:
            continue
        an = a.get('analytics')
        if not an:
            continue
        views = an.get('totalViews') or an.get('views')
        curve = resample(an.get('retentionCurve') or [])
        if not views or views <= 0 or curve is None:
            continue
        meta = a.get('metadata') or {}
        dv = an.get('dailyViews') or []
        pub = dv[0]['date'] if dv and dv[0].get('date') else None
        # REAL "Viewed vs Swiped Away" — scraped from YouTube Studio (swipe-scraper.js),
        # stored at analytics.swipeRatio.stayedToWatch/.swipedAway. NOT swipedAwayRate
        # (that's the engagedViews proxy = engagement rate, which is wrong).
        sr = an.get('swipeRatio') or {}
        if not (sr.get('scrapedAt') and isinstance(sr.get('stayedToWatch'), (int, float))):
            continue                                              # only videos with the REAL keep rate
        keep_rate = sr['stayedToWatch']                           # % who stayed to watch (the metric we want)
        swiped = sr.get('swipedAway') if isinstance(sr.get('swipedAway'), (int, float)) else round(100 - keep_rate, 1)
        avg_ret = an.get('avgPercentViewed') if isinstance(an.get('avgPercentViewed'), (int, float)) else an.get('avgRetention')
        dur = meta.get('duration')
        if not dur and isinstance(an.get('avgViewDuration'), (int, float)) and avg_ret:
            dur = an['avgViewDuration'] / (avg_ret / 100.0)
        try:
            yr = datetime.date.fromisoformat(pub).year if pub else None
        except Exception:
            yr = None
        # 5-second retention — two readings for verification against Studio:
        #   ret5      = absolute audience retention at the 5s mark (the raw point on the curve)
        #   ret5_surv = survival from the opening (5s ÷ first-3-points avg) — removes replay/loop inflation
        ret5 = ret5_surv = None
        if curve and dur and dur > 0:
            at5 = float(np.interp(min(1.0, 5.0 / dur), GRID, curve))
            base = (curve[0] + curve[1] + curve[2]) / 3.0
            ret5 = round(at5 * 100, 1)
            ret5_surv = round(at5 / base * 100, 1) if base else None
        rows.append({
            'id': d, 'url': a.get('url') or f'https://www.youtube.com/watch?v={d}',
            'title': meta.get('title', d),
            'published': pub,
            'keep_rate': round(float(keep_rate), 1),              # % STAYED to watch (Viewed vs Swiped Away)
            'swiped': round(float(swiped), 1),                    # % swiped away = 100 - keep_rate
            'sub_keep': sr.get('subscriberStayed'), 'nonsub_keep': sr.get('nonSubscriberStayed'),
            'avg_retention': round(float(avg_ret), 2) if isinstance(avg_ret, (int, float)) else None,
            'ret5': ret5, 'ret5_surv': ret5_surv,
            'views': int(views),
            'duration_s': round(float(dur), 1) if dur else None,
            'likes': an.get('likes'), 'comments': an.get('comments'), 'shares': an.get('shares'),
            'scraped_at': sr.get('scrapedAt'),
            'curve': curve,
        })
    rows.sort(key=lambda r: -(r['views'] or 0))
    out = {'meta': {'n': len(rows), 'metric': 'keep_rate = stayedToWatch (Viewed vs Swiped Away), scraped from YouTube Studio',
                    'columns': 'title, published, keep_rate (% stayed), swiped (%), avg_retention (% viewed), views, duration',
                    'note': 'keep_rate is the REAL scraped Viewed-vs-Swiped-Away (0<x<100). Verify any row in YouTube Studio via its link.'},
           'videos': rows}
    json.dump(out, open(OUT, 'w'))
    kr = [r['keep_rate'] for r in rows]
    print(f"{len(rows)} videos with REAL keep rate → retention_table.json · keep_rate {min(kr):.0f}-{max(kr):.0f}% (median {sorted(kr)[len(kr)//2]:.0f}%)")


if __name__ == '__main__':
    main()
