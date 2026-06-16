#!/usr/bin/env python3
"""
QUANT 2 (pure rebuild) · QP1 — manifest.

One record per video. Tracks the THREE raw-sensory sources the pure pipeline needs:
  • frames   (vision DINOv2 + visual DSP + motion)  — video_data/<id>/frames/
  • mp4      (audio wav2vec2 + audio DSP)            — video_data/<id>/video.mp4
True labels (Pen reels) carry retention anchors → swipe-hazard targets. Corpus
(100M-view shorts-db) carries NO labels — used only for the content manifold.

NO LLM-rated fields are read or stored anywhere. Output: manifest.json.
"""
import os, json, glob

HERE = os.path.dirname(os.path.abspath(__file__))
JARVIS = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(JARVIS))
QRD = os.path.join(JARVIS, 'qrd')
VIDEO_DATA = os.path.join(ROOT, 'video_data')
OUT = os.path.join(HERE, 'manifest.json')


def frames_for(vid):
    d = os.path.join(VIDEO_DATA, vid, 'frames')
    if not os.path.isdir(d):
        return d, []
    fs = []
    for e in ('*.jpg', '*.jpeg', '*.png', '*.webp'):
        fs += glob.glob(os.path.join(d, e))
    return d, sorted(fs)


def mp4_for(vid):
    for name in ('video.mp4', 'source.mp4', f'{vid}.mp4'):
        p = os.path.join(VIDEO_DATA, vid, name)
        if os.path.exists(p):
            return p
    return None


def survival(r):
    a = [r.get('ret_25'), r.get('ret_50'), r.get('ret_75'), r.get('ret_90')]
    if any(not isinstance(x, (int, float)) for x in a):
        return None
    S = [1.0]
    for x in a:
        S.append(min(S[-1], max(1e-3, min(1.0, float(x)))))
    return S


def main():
    sig = json.load(open(os.path.join(JARVIS, 'signals-dataset-expanded.json')))
    reels = sig if isinstance(sig, list) else (sig.get('rows') or sig.get('dataset') or [])
    tgt = json.load(open(os.path.join(QRD, 'qrd_targets.json'))) if os.path.exists(os.path.join(QRD, 'qrd_targets.json')) else {}
    dates = json.load(open(os.path.join(QRD, 'qrd_dates.json'))) if os.path.exists(os.path.join(QRD, 'qrd_dates.json')) else {}

    videos = {}
    for r in reels:
        vid = r.get('ytId')
        if not vid:
            continue
        fdir, frames = frames_for(vid); mp4 = mp4_for(vid)
        S = survival(r)
        videos[vid] = {
            'id': vid, 'tier': 'true_label', 'name': r.get('name', vid),
            'duration_s': r.get('duration_s'), 'published': (dates.get(vid) or {}).get('date'),
            'frame_dir': os.path.relpath(fdir, ROOT), 'n_frames': len(frames),
            'mp4': os.path.relpath(mp4, ROOT) if mp4 else None,
            'targets': {
                'keep3s': r.get('keep'), 'retention': r.get('retention'),
                'swipe': (tgt.get(vid) or {}).get('swipe') if isinstance(tgt.get(vid), dict) else None,
                'survival': S,
            } if S else None,
        }

    sdb = json.load(open(os.path.join(ROOT, 'shorts-db.json'))).get('videos', {})
    for c in (sdb.values() if isinstance(sdb, dict) else sdb):
        vid = c.get('videoId') or c.get('_id')
        if not vid or vid in videos:
            continue
        fdir, frames = frames_for(vid)
        videos[vid] = {
            'id': vid, 'tier': 'corpus', 'name': c.get('title', vid), 'channel': c.get('channelTitle'),
            'views': c.get('views'), 'duration_s': c.get('duration'), 'published': c.get('publishedAt'),
            'frame_dir': os.path.relpath(fdir, ROOT), 'n_frames': len(frames),
            'r2_frames': c.get('framesR2Keys') or [], 'mp4': None, 'targets': None,
        }

    vids = list(videos.values())
    tl = [v for v in vids if v['tier'] == 'true_label']
    out = {'stats': {
        'n_videos': len(vids), 'n_true_label': len(tl),
        'n_corpus': sum(1 for v in vids if v['tier'] == 'corpus'),
        'true_label_with_mp4': sum(1 for v in tl if v['mp4']),
        'true_label_with_frames': sum(1 for v in tl if v['n_frames'] > 0),
    }, 'videos': vids}
    json.dump(out, open(OUT, 'w'))
    s = out['stats']
    print(f"manifest: {s['n_videos']} videos · true-label {s['n_true_label']} "
          f"(frames {s['true_label_with_frames']}, mp4/audio {s['true_label_with_mp4']}) · corpus {s['n_corpus']}")


if __name__ == '__main__':
    main()
