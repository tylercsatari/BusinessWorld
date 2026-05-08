#!/usr/bin/env python3.11
"""
TRIBE v2 brain analysis for a video.

Usage:
    analyze_video.py <video_path> [--output <json_path>]

Outputs JSON to stdout (and optionally writes it to disk).
Stderr carries progress lines so the parent can stream them if desired.
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


def _maybe_patch_whisperx(video_path: Path) -> Path | None:
    """Bypass TRIBE's `uvx whisperx` step by reusing our pre-built transcript.

    Looks for `video_data/<ytId>/analysis.json` in the parent BusinessWorld tree
    and, if found, monkey-patches ExtractWordsFromAudio._get_transcript_from_audio
    to return a DataFrame built from the existing word-level timestamps.

    Why: TRIBE's uvx-spawned whisperx env hits a torchaudio/pyannote.audio
    incompatibility on Python 3.14. The transcript is already on disk for every
    video we care about, so this is both faster and more reliable.

    Returns the analysis.json path if patching happened, else None.
    """
    # Walk up to find a sibling video_data directory containing this video's id.
    yt_id = video_path.parent.name  # video_data/<ytId>/video.mp4
    analysis_path = video_path.parent / "analysis.json"
    if not analysis_path.exists():
        return None
    try:
        data = json.loads(analysis_path.read_text())
    except Exception as e:
        log(f"Could not load {analysis_path}: {e}; falling back to whisperx")
        return None
    transcript = data.get("transcript") or {}
    words = transcript.get("words") or []
    full_text = transcript.get("fullText") or ""
    if not words:
        log("analysis.json has no transcript.words; falling back to whisperx")
        return None

    import re
    import pandas as pd  # noqa: E402

    # Split fullText into sentences (rough). AddSentenceToWords only needs words
    # plus a Text event; sentences are recomputed downstream.
    sent_strs = [s.strip() for s in re.split(r"[.!?]+", full_text) if s.strip()]
    if not sent_strs:
        sent_strs = [full_text or "transcript"]
    chunk = max(1, len(words) // max(1, len(sent_strs)))

    rows = []
    for i, w in enumerate(words):
        text = str(w.get("word", "")).strip().replace('"', "")
        if not text:
            continue
        ts = float(w.get("timestamp", w.get("start", 0)) or 0)
        nxt_ts = float(words[i + 1].get("timestamp", ts + 0.3)) if i + 1 < len(words) else ts + 0.3
        duration = max(0.05, min(2.0, nxt_ts - ts))
        sent_idx = min(i // chunk, len(sent_strs) - 1)
        rows.append({
            "text": text,
            "start": ts,
            "duration": duration,
            "sequence_id": int(sent_idx),
            "sentence": sent_strs[sent_idx],
        })
    if not rows:
        log("Pre-built transcript yielded no usable words; falling back to whisperx")
        return None

    fixed_df = pd.DataFrame(rows)
    log(f"[transcript] reusing {len(rows)} words from {analysis_path.name} (yt={yt_id})")

    from tribev2 import eventstransforms  # noqa: E402

    def _patched(wav_filename, language):  # signature must match original
        return fixed_df.copy()

    eventstransforms.ExtractWordsFromAudio._get_transcript_from_audio = staticmethod(_patched)
    return analysis_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", type=str)
    parser.add_argument("--output", type=str, default=None,
                        help="Optional path to also write the JSON result to disk")
    parser.add_argument("--cache-folder", type=str,
                        default=str(Path(__file__).resolve().parent / "cache"))
    parser.add_argument("--no-prebuilt-transcript", action="store_true",
                        help="Disable the analysis.json transcript bypass and force whisperx.")
    args = parser.parse_args()

    video_path = Path(args.video_path).resolve()
    if not video_path.exists():
        print(json.dumps({"error": f"Video not found: {video_path}"}))
        return 2

    cache_folder = Path(args.cache_folder)
    cache_folder.mkdir(parents=True, exist_ok=True)

    log(f"Loading TRIBE v2 (cache={cache_folder})…")
    t0 = time.time()
    # Imports are slow; keep them inside main so --help is snappy.
    import numpy as np  # noqa: E402
    from tribev2.demo_utils import TribeModel  # noqa: E402

    model = TribeModel.from_pretrained(
        "facebook/tribev2",
        cache_folder=cache_folder,
    )
    log(f"Model ready in {time.time() - t0:.1f}s")

    if not args.no_prebuilt_transcript:
        _maybe_patch_whisperx(video_path)

    log(f"Building events dataframe for {video_path.name}…")
    df = model.get_events_dataframe(video_path=str(video_path))

    log("Running inference (this is the slow part)…")
    t1 = time.time()
    preds, segments = model.predict(events=df)
    log(f"Inference done in {time.time() - t1:.1f}s — preds shape {preds.shape}")

    # preds shape: (n_timesteps, n_vertices); 1 TR = 1 second.
    preds = np.asarray(preds, dtype=np.float32)
    n_steps, n_vert = preds.shape

    # Per-second aggregate brain activation (mean across all cortical vertices).
    per_step = preds.mean(axis=1)

    # Normalize to a 0–1 engagement curve, matching the retention_curve format
    # used elsewhere in BusinessWorld. Use min-max so the loudest moment = 1.
    pmin = float(per_step.min())
    pmax = float(per_step.max())
    if pmax - pmin > 1e-9:
        norm = (per_step - pmin) / (pmax - pmin)
    else:
        norm = np.zeros_like(per_step)

    # Pull a per-step `second` from the segment metadata when possible; otherwise
    # fall back to integer seconds (1 TR = 1 s in TRIBE v2).
    def _seg_second(i: int) -> float:
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

    curve = [
        {"second": round(_seg_second(i), 3),
         "activation": round(float(norm[i]), 4)}
        for i in range(n_steps)
    ]

    # Peak moments: top 10% activation timestamps.
    if n_steps > 0:
        k = max(1, int(round(n_steps * 0.10)))
        top_idx = np.argsort(norm)[-k:][::-1]
        # Percentile rank of each step's raw activation.
        sorted_vals = np.sort(per_step)
        peak_moments = []
        for idx in top_idx:
            rank = int(np.searchsorted(sorted_vals, per_step[idx], side="right"))
            pct = round(100.0 * rank / n_steps, 1)
            peak_moments.append({
                "second": round(_seg_second(int(idx)), 3),
                "activation": round(float(norm[idx]), 4),
                "percentile": pct,
            })
        peak_moments.sort(key=lambda p: p["second"])
    else:
        peak_moments = []

    max_idx = int(np.argmax(norm)) if n_steps else 0
    max_second = round(_seg_second(max_idx), 3) if n_steps else 0.0

    # Engagement score: mean of the normalized curve (0–1). Higher = the brain
    # stays activated more consistently across the whole clip.
    engagement_score = round(float(norm.mean()), 4) if n_steps else 0.0
    mean_activation = round(float(per_step.mean()), 6) if n_steps else 0.0

    duration_s = round(_seg_second(n_steps - 1) + 1, 3) if n_steps else 0.0

    out = {
        "video_path": str(video_path),
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": duration_s,
        "n_timesteps": n_steps,
        "n_vertices": n_vert,
        "brain_engagement_curve": curve,
        "peak_moments": peak_moments,
        "mean_activation": mean_activation,
        "max_activation_second": max_second,
        "engagement_score": engagement_score,
    }

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, indent=2))
        log(f"Wrote {out_path}")

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Ensure the parent always sees a JSON payload even on hard failure.
        err = {"error": str(e), "type": type(e).__name__}
        print(json.dumps(err))
        log(f"FAILED: {e}")
        sys.exit(1)
