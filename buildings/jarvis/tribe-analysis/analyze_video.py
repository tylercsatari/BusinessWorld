#!/usr/bin/env python3.11
"""
TRIBE v2 brain analysis for a video.
Uses audio-only mode — no HuggingFace token or Llama model required.

Usage:
    analyze_video.py <video_path> [--output <json_path>]
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def log(msg: str) -> None:
    print(f"[tribe] {msg}", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", type=str)
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--cache-folder", type=str,
                        default=str(Path.home() / ".cache" / "huggingface"))
    args = parser.parse_args()

    video_path = Path(args.video_path).resolve()
    if not video_path.exists():
        print(json.dumps({"error": f"Video not found: {video_path}"}))
        return 2

    log(f"Loading TRIBE v2 model…")
    t0 = time.time()

    import numpy as np
    import pandas as pd
    import torch
    # Force CPU — Mac MPS/CUDA not supported with this torch build
    torch.cuda.is_available = lambda: False
    from neuralset.events.utils import standardize_events
    from neuralset.events.transforms import (
        ExtractAudioFromVideo,
        ChunkEvents,
    )
    from tribev2.demo_utils import TribeModel

    # Force CPU (Mac Silicon doesn't support CUDA; MPS not in Pydantic schema)
    model = TribeModel.from_pretrained(
        "facebook/tribev2",
        cache_folder=args.cache_folder,
        device="cpu",
    )
    log(f"Model ready in {time.time() - t0:.1f}s")

    # Build events dataframe using audio-only mode (no Llama/text extractor needed)
    log(f"Extracting audio from {video_path.name}…")
    
    # Create initial events dataframe with the video
    initial_events = pd.DataFrame([{
        "type": "Video",
        "filepath": str(video_path),
        "start": 0.0,
        "duration": None,
        "timeline": "video_exp",
        "subject": "s01",
    }])
    
    transforms = [
        ExtractAudioFromVideo(),
        ChunkEvents(event_type_to_chunk="Audio", max_duration=60, min_duration=5),
        ChunkEvents(event_type_to_chunk="Video", max_duration=60, min_duration=5),
    ]
    
    events = standardize_events(initial_events)
    for t in transforms:
        log(f"  transform: {type(t).__name__}")
        events = t(events)
    events = standardize_events(events)
    
    # Keep only Audio events — Video encoding on CPU takes ~40s/chunk = hours
    if 'type' in events.columns:
        audio_events = events[events['type'] == 'Audio'].copy()
        if len(audio_events) == 0:
            # fallback: keep all events
            audio_events = events
    else:
        audio_events = events
    
    log(f"Events built: {len(audio_events)} audio rows (video rows dropped for speed)")

    log("Running TRIBE v2 inference (audio-only, ~30s on CPU)…")
    t1 = time.time()
    preds, segments = model.predict(events=audio_events)
    log(f"Inference done in {time.time() - t1:.1f}s — preds shape {preds.shape}")

    preds = np.asarray(preds, dtype=np.float32)
    n_steps, n_vert = preds.shape

    # Per-timestep mean activation across all cortical vertices
    per_step = preds.mean(axis=1)

    # Normalize to 0-1
    pmin, pmax = float(per_step.min()), float(per_step.max())
    norm = (per_step - pmin) / (pmax - pmin + 1e-9)

    def seg_second(i):
        try:
            seg = segments[i]
            for key in ("start", "t", "second", "time"):
                if isinstance(seg, dict) and key in seg:
                    return float(seg[key])
            if hasattr(seg, "start"):
                return float(seg.start)
        except Exception:
            pass
        return float(i)

    curve = [{"second": round(seg_second(i), 3), "activation": round(float(norm[i]), 4)}
             for i in range(n_steps)]

    # Top 10% peak moments
    k = max(1, int(round(n_steps * 0.10)))
    top_idx = np.argsort(norm)[-k:][::-1]
    sorted_vals = np.sort(per_step)
    peak_moments = []
    for idx in top_idx:
        rank = int(np.searchsorted(sorted_vals, per_step[idx], side="right"))
        pct = round(100.0 * rank / n_steps, 1)
        peak_moments.append({
            "second": round(seg_second(int(idx)), 3),
            "activation": round(float(norm[idx]), 4),
            "percentile": pct,
        })
    peak_moments.sort(key=lambda p: p["second"])

    max_idx = int(np.argmax(norm)) if n_steps else 0
    engagement_score = round(float(norm.mean()), 4) if n_steps else 0.0

    out = {
        "video_path": str(video_path),
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": round(seg_second(n_steps - 1) + 1, 3) if n_steps else 0.0,
        "n_timesteps": n_steps,
        "n_vertices": n_vert,
        "brain_engagement_curve": curve,
        "peak_moments": peak_moments,
        "mean_activation": round(float(per_step.mean()), 6),
        "max_activation_second": round(seg_second(max_idx), 3),
        "engagement_score": engagement_score,
        "mode": "audio_only",
    }

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, indent=2))
        log(f"Saved to {out_path}")

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        err = {"error": str(e), "type": type(e).__name__, "traceback": traceback.format_exc()[-500:]}
        print(json.dumps(err))
        log(f"FAILED: {e}")
        sys.exit(1)
