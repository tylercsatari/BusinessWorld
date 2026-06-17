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
        swipe = an.get('swipedAwayRate')
        viewed = an.get('viewedRate')
        avg_ret = an.get('avgPercentViewed') if isinstance(an.get('avgPercentViewed'), (int, float)) else an.get('avgRetention')
        dur = meta.get('duration')
        if not dur and isinstance(an.get('avgViewDuration'), (int, float)) and avg_ret:
            dur = an['avgViewDuration'] / (avg_ret / 100.0)
        try:
            yr = datetime.date.fromisoformat(pub).year if pub else None
        except Exception:
            yr = None
        rows.append({
            'id': d, 'url': a.get('url') or f'https://www.youtube.com/watch?v={d}',
            'title': meta.get('title', d),
            'published': pub,
            'swipe': round(float(swipe), 3) if isinstance(swipe, (int, float)) else None,
            'stayed': round(float(viewed), 3) if isinstance(viewed, (int, float)) else None,
            'avg_retention': round(float(avg_ret), 2) if isinstance(avg_ret, (int, float)) else None,
            'views': int(views),
            'engaged_views': int(an['engagedViews']) if isinstance(an.get('engagedViews'), (int, float)) else None,
            'duration_s': round(float(dur), 1) if dur else None,
            'likes': an.get('likes'), 'comments': an.get('comments'), 'shares': an.get('shares'),
            'swipe_tracked': bool(isinstance(swipe, (int, float)) and swipe > 0.05),   # real swipe vs pre-2023 zero
            'curve': curve,
        })
    rows.sort(key=lambda r: -(r['views'] or 0))
    out = {'meta': {'n': len(rows), 'generated_from': 'video_data/<id>/analysis.json analytics',
                    'columns': 'title, published, swipe (swipedAwayRate %), stayed (viewedRate %), avg_retention (avgPercentViewed %), views (totalViews), engaged_views, duration',
                    'note': 'swipe ~0 for pre-2023 videos = metric not tracked then (swipe_tracked=false), not zero swipes. Verify any row in YouTube Studio via its link.'},
           'videos': rows}
    json.dump(out, open(OUT, 'w'))
    tracked = sum(1 for r in rows if r['swipe_tracked'])
    print(f"{len(rows)} videos → retention_table.json · swipe actually tracked on {tracked} (rest are pre-2023 zeros)")


if __name__ == '__main__':
    main()
