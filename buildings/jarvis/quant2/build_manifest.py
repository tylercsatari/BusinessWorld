#!/usr/bin/env python3
"""
QUANT 2 · Phase 1 — the unified manifest.

Joins three sources into one canonical record per video:
  • TRUE-LABEL reels (Pen): signals-dataset-expanded.json + qrd_targets.json (swipe)
    + qrd_dates.json (real publish date) → retention anchors, swipe, survival curve.
  • CORPUS (Research Center): shorts-db.json — 2,362 videos, all >100M views, with
    metadata and frames. Tier-4 unlabelled: teaches content STRUCTURE, not swipe.
  • Local frames: video_data/<id>/frames/*.jpg — the pixels the encoders consume.

Output: quant2/manifest.json  — { videos:[...], stats:{...} }.
Every record knows its tier, its targets (if any), and where its frames live.
No fabrication: a video with no frames is marked n_frames=0 and skipped by encoders.
"""
import os, json, glob, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
QRD = os.path.join(JARVIS, 'qrd')
VIDEO_DATA = os.path.join(ROOT, 'video_data')
OUT = os.path.join(HERE, 'manifest.json')

IMG_EXT = ('*.jpg', '*.jpeg', '*.png', '*.webp')


def frames_for(vid):
    d = os.path.join(VIDEO_DATA, vid, 'frames')
    if not os.path.isdir(d):
        return d, []
    files = []
    for e in IMG_EXT:
        files += glob.glob(os.path.join(d, e))
    files.sort()   # filename order ≈ time order (frame_000, frame_001, …)
    return d, files


def survival(rec):
    a = [rec.get('ret_25'), rec.get('ret_50'), rec.get('ret_75'), rec.get('ret_90')]
    if any(not isinstance(x, (int, float)) for x in a):
        return None
    S = [1.0]
    for x in a:
        S.append(min(S[-1], max(1e-3, min(1.0, float(x)))))
    return S


def main():
    # ── true labels ──
    sig = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    reels = sig if isinstance(sig, list) else (sig.get('rows') or sig.get('dataset') or [])
    tgt = json.load(open(os.path.join(QRD, 'qrd_targets.json'))) if os.path.exists(os.path.join(QRD, 'qrd_targets.json')) else {}
    dates = json.load(open(os.path.join(QRD, 'qrd_dates.json'))) if os.path.exists(os.path.join(QRD, 'qrd_dates.json')) else {}

    videos = {}
    for r in reels:
        vid = r.get('ytId')
        if not vid:
            continue
        d = (dates.get(vid) or {}).get('date')
        S = survival(r)
        sw = tgt.get(vid, {}).get('swipe') if isinstance(tgt.get(vid), dict) else None
        fdir, frames = frames_for(vid)
        videos[vid] = {
            'id': vid, 'tier': 'true_label', 'source': 'pen',
            'name': r.get('name', vid), 'views': r.get('views'), 'log_views': r.get('log_views'),
            'duration_s': r.get('duration_s'), 'published': d,
            'frame_dir': os.path.relpath(fdir, ROOT), 'n_frames': len(frames),
            'targets': {
                'keep3s': r.get('keep'),                       # % still watching at 3s
                'retention': r.get('retention'),               # avg % viewed
                'swipe': sw,                                    # swipe-away ratio
                'survival': S,                                 # [1, ret25, ret50, ret75, ret90]
                'ret_25': r.get('ret_25'), 'ret_50': r.get('ret_50'),
                'ret_75': r.get('ret_75'), 'ret_90': r.get('ret_90'),
            },
        }

    # ── corpus ──
    sdb = json.load(open(os.path.join(ROOT, 'shorts-db.json')))
    corpus = sdb.get('videos', {})
    items = corpus.values() if isinstance(corpus, dict) else corpus
    for c in items:
        vid = c.get('videoId') or c.get('_id')
        if not vid:
            continue
        fdir, frames = frames_for(vid)
        if vid in videos:
            # already a true-label video — just annotate corpus stats
            videos[vid]['in_corpus'] = True
            if videos[vid].get('views') is None:
                videos[vid]['views'] = c.get('views')
            continue
        videos[vid] = {
            'id': vid, 'tier': 'corpus', 'source': 'shorts_db',
            'name': c.get('title', vid), 'channel': c.get('channelTitle'),
            'views': c.get('views'), 'duration_s': c.get('duration'),
            'published': c.get('publishedAt'),                 # NOTE: relative ("3 years ago") — weak
            'frame_dir': os.path.relpath(fdir, ROOT), 'n_frames': len(frames),
            'r2_frames': c.get('framesR2Keys') or [],
            'targets': None,
        }

    vids = list(videos.values())
    n_true = sum(1 for v in vids if v['tier'] == 'true_label')
    n_corpus = sum(1 for v in vids if v['tier'] == 'corpus')
    n_true_frames = sum(1 for v in vids if v['tier'] == 'true_label' and v['n_frames'] > 0)
    n_corpus_frames = sum(1 for v in vids if v['tier'] == 'corpus' and v['n_frames'] > 0)
    total_frames = sum(v['n_frames'] for v in vids)

    out = {
        'generated': None,   # stamped by caller; Date.* unavailable here by policy
        'stats': {
            'n_videos': len(vids), 'n_true_label': n_true, 'n_corpus': n_corpus,
            'true_label_with_frames': n_true_frames, 'corpus_with_frames': n_corpus_frames,
            'total_local_frames': total_frames,
        },
        'videos': vids,
    }
    json.dump(out, open(OUT, 'w'))
    print(f"manifest: {len(vids)} videos  ·  true-label {n_true} ({n_true_frames} w/ frames)  ·  "
          f"corpus {n_corpus} ({n_corpus_frames} w/ frames)  ·  {total_frames} local frames")
    print(f"→ {os.path.relpath(OUT, ROOT)}")


if __name__ == '__main__':
    main()
