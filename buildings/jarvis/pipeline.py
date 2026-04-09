#!/usr/bin/env python3
"""
Jarvis Pipeline — Phase 1
Runs the full indicator discovery flow:
  THEORIZE → QUALIFY → QUANTIFY → RESOLVE → DATASET → EXPERIMENT → RESULT → SAVE

Usage:
  python3 buildings/jarvis/pipeline.py --run 5
  python3 buildings/jarvis/pipeline.py --single hook_retention_pct
  python3 buildings/jarvis/pipeline.py --status
"""

import argparse
import json
import os
import math
import re
import datetime
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.stats import pearsonr, spearmanr

# ── Paths ──────────────────────────────────────────────────────────────────────
JARVIS_DIR = Path(__file__).parent
VIDEO_DATA_DIR = Path(__file__).parent.parent.parent / "video_data"

INDICATORS_FILE = JARVIS_DIR / "indicators.json"
EXPERIMENTS_FILE = JARVIS_DIR / "experiments.json"
TOOLS_FILE = JARVIS_DIR / "tools.json"
RESOLUTIONS_FILE = JARVIS_DIR / "resolutions.json"
CANDIDATE_QUEUE_FILE = JARVIS_DIR / "candidate_queue.json"

# ── Load/Save helpers ──────────────────────────────────────────────────────────
def load_json(path, default=None):
    if Path(path).exists():
        with open(path) as f:
            return json.load(f)
    return default if default is not None else []

def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"

# ── Action word lists ──────────────────────────────────────────────────────────
ACTION_VERBS = {"run","make","build","fight","break","jump","climb","create","destroy","survive",
                "escape","attack","defend","win","lose","beat","smash","crush","lift","carry",
                "throw","catch","shoot","hit","punch","kick","race","fly","swim","dive","forge",
                "cut","slice","weld","drill","bend","stretch","push","pull","hold","grab","drop"}

EMOTIONAL_WORDS = {"pain","amazing","incredible","shocking","unbelievable","extreme","insane",
                   "impossible","dangerous","terrifying","beautiful","perfect","horrible","disgusting",
                   "awesome","scary","brutal","epic","legendary","ultimate","deadly","powerful",
                   "heartbreaking","hilarious","mind-blowing","jaw-dropping","breathtaking"}

# ── Metric extraction functions ────────────────────────────────────────────────
def get_retention_at_pct(curve, pct):
    """Get retention value at pct% into the video (0-100)."""
    if not curve:
        return None
    idx = min(int(pct), len(curve) - 1)
    return curve[idx]["retention"] if idx < len(curve) else None

def compute_entropy(curve):
    """Shannon entropy of normalized retention curve."""
    if not curve:
        return None
    values = [p["retention"] for p in curve]
    # Normalize to probabilities (sum to 1)
    total = sum(abs(v) for v in values)
    if total == 0:
        return 0
    probs = [abs(v) / total for v in values]
    probs = [p for p in probs if p > 0]
    return -sum(p * math.log2(p) for p in probs)

def linear_baseline(n):
    """Generate linear decay baseline from 1 to 0 over n points."""
    return [1 - i / (n - 1) for i in range(n)]

def extract_metric(key, analysis):
    """
    Extract indicator value from a single video's analysis.json dict.
    Returns (value, skip_reason) where skip_reason is None on success.
    """
    meta = analysis.get("metadata", {})
    analytics = analysis.get("analytics", {})
    transcript = analysis.get("transcript", "") or ""
    ai = analysis.get("aiAnalysis", {}) or {}
    frames = analysis.get("frames", []) or []
    segments = ai.get("segments", []) or []
    curve = analytics.get("retentionCurve", []) or []
    daily = analytics.get("dailyViews", []) or []

    if key == "hook_retention_pct":
        v = get_retention_at_pct(curve, 10)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "final_5pct_retention":
        if len(curve) < 5:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[-5:]]
        return (np.mean(vals), None)

    elif key == "mid_video_cliff":
        if len(curve) < 2:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        diffs = [vals[i] - vals[i-1] for i in range(1, len(vals))]
        return (max(abs(d) for d in diffs), None)

    elif key == "retention_entropy":
        v = compute_entropy(curve)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "hook_drop_rate":
        if len(curve) < 10:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[:10]]
        x = np.arange(10)
        slope, _, _, _, _ = stats.linregress(x, vals)
        return (slope, None)

    elif key == "early_momentum":
        v25 = get_retention_at_pct(curve, 25)
        v10 = get_retention_at_pct(curve, 10)
        if v25 is None or v10 is None:
            return (None, "no curve")
        return (v25 - v10, None)

    elif key == "view_accel_7day":
        if not daily:
            return (None, "no daily views")
        week1 = sum(d.get("views", 0) for d in daily[:7])
        return (math.log10(week1 + 1), None)

    elif key == "week1_week2_ratio":
        if len(daily) < 7:
            return (None, "insufficient daily views")
        week1 = sum(d.get("views", 0) for d in daily[:7])
        week2 = sum(d.get("views", 0) for d in daily[7:14])
        return (week2 / (week1 + 1), None)

    elif key == "subs_gained_per_view":
        total_views = analytics.get("totalViews", 0)
        subs = analytics.get("subscribersGained", 0)
        if not total_views:
            return (None, "no views")
        return (subs / total_views * 1000, None)

    elif key == "non_sub_view_share":
        total = analytics.get("totalViews", 0)
        non_sub = analytics.get("nonSubscriberViews", 0)
        if not total:
            return (None, "no views")
        return (non_sub / total, None)

    elif key == "swipe_away_rate":
        v = analytics.get("swipedAwayRate")
        return (v, None) if v is not None else (None, "no data")

    elif key == "like_rate":
        total = analytics.get("totalViews", 0)
        likes = analytics.get("likes", 0)
        if not total:
            return (None, "no views")
        return (likes / total * 1000, None)

    elif key == "comment_rate":
        total = analytics.get("totalViews", 0)
        comments = analytics.get("comments", 0)
        if not total:
            return (None, "no views")
        return (comments / total * 1000, None)

    elif key == "share_rate":
        total = analytics.get("totalViews", 0)
        shares = analytics.get("shares", 0)
        if not total:
            return (None, "no views")
        return (shares / total * 1000, None)

    elif key == "duration_log":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (math.log10(dur), None)

    elif key == "retention_25pct":
        v = get_retention_at_pct(curve, 25)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "retention_50pct":
        v = get_retention_at_pct(curve, 50)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "retention_75pct":
        v = get_retention_at_pct(curve, 75)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "retention_90pct":
        v = get_retention_at_pct(curve, 90)
        return (v, None) if v is not None else (None, "no curve")

    elif key == "above_baseline_mean":
        if not curve:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        n = len(vals)
        baseline = linear_baseline(n)
        above = [vals[i] - baseline[i] for i in range(n)]
        return (np.mean(above), None)

    elif key == "peak_count":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        peaks = sum(1 for i in range(1, len(vals)-1) if vals[i] > vals[i-1] and vals[i] > vals[i+1])
        return (peaks, None)

    elif key == "drop_count":
        if len(curve) < 2:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        drops = sum(1 for i in range(1, len(vals)) if (vals[i-1] - vals[i]) > 0.03)
        return (drops, None)

    elif key == "max_peak_delta":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        peak_deltas = [vals[i] - vals[i-1] for i in range(1, len(vals)) if vals[i] > vals[i-1]]
        return (max(peak_deltas) if peak_deltas else 0, None)

    elif key == "max_drop_delta":
        if len(curve) < 2:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        drop_deltas = [vals[i-1] - vals[i] for i in range(1, len(vals)) if vals[i] < vals[i-1]]
        return (max(drop_deltas) if drop_deltas else 0, None)

    elif key == "transcript_word_count":
        if not transcript.strip():
            return (None, "no transcript")
        return (len(transcript.split()), None)

    elif key == "speech_rate_wps":
        if not transcript.strip():
            return (None, "no transcript")
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (len(transcript.split()) / dur, None)

    elif key == "hook_word_count":
        # Use first hook segment transcript if available, else first 5s of transcript estimated
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            return (len(hook_seg["transcript"].split()), None)
        if not transcript.strip():
            return (None, "no transcript")
        # Estimate: first 15% of words
        words = transcript.split()
        dur = meta.get("duration", 1)
        hook_words = max(1, int(len(words) * 5 / dur))
        return (len(words[:hook_words]), None)

    elif key == "question_count":
        if not transcript.strip():
            return (None, "no transcript")
        return (transcript.count("?"), None)

    elif key == "segment_count":
        return (len(segments), None)

    elif key == "has_hook_segment":
        has = any(s.get("label", "").lower() == "hook" for s in segments)
        return (int(has), None)

    elif key == "hook_duration_s":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg:
            return (hook_seg.get("endTime", 0) - hook_seg.get("startTime", 0), None)
        return (0, None)

    elif key == "face_frame_pct":
        if not frames:
            return (None, "no frames")
        face_count = sum(1 for f in frames
                        if "face" in str(f.get("analysis", {}).get("sceneDescription", "")).lower())
        return (face_count / len(frames), None)

    elif key == "text_overlay_frame_pct":
        if not frames:
            return (None, "no frames")
        text_count = sum(1 for f in frames
                        if "text overlay" in str(f.get("analysis", {}).get("visualTechniques", "")).lower()
                        or "text overlay" in str(f.get("analysis", {}).get("sceneDescription", "")).lower())
        return (text_count / len(frames), None)

    elif key == "scene_change_count":
        if not frames:
            return (None, "no frames")
        changes = 0
        prev_desc = ""
        for frame in frames:
            desc = str(frame.get("analysis", {}).get("sceneDescription", ""))
            if prev_desc and desc and desc[:50] != prev_desc[:50]:
                changes += 1
            prev_desc = desc
        return (changes, None)

    elif key == "log_like_count":
        likes = meta.get("likeCount", 0)
        return (math.log10(likes + 1), None)

    elif key == "retention_variance":
        if not curve:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        return (float(np.var(vals)), None)

    elif key == "retention_skew":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        return (float(stats.skew(vals)), None)

    elif key == "keep_x_non_sub_share":
        keep = analytics.get("avgRetention")
        total = analytics.get("totalViews", 0)
        non_sub = analytics.get("nonSubscriberViews", 0)
        if keep is None or not total:
            return (None, "missing data")
        return (keep * (non_sub / total), None)

    elif key == "subs_per_like":
        subs = analytics.get("subscribersGained", 0)
        likes = analytics.get("likes", 0)
        return (subs / (likes + 1), None)

    elif key == "revenue_per_view":
        rev = analytics.get("estimatedRevenue", 0)
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (rev / total * 1000, None)

    elif key == "daily_view_peak_day":
        if not daily:
            return (None, "no daily views")
        views_list = [d.get("views", 0) for d in daily]
        return (int(np.argmax(views_list)), None)

    else:
        return (None, f"unknown key: {key}")


# ── Metric definitions ─────────────────────────────────────────────────────────
METRIC_DEFINITIONS = {
    "hook_retention_pct": {
        "description": "Retention at 10% into the video — measures hook strength",
        "what_to_extract": "retentionCurve[index 10].retention",
        "formula": "retentionCurve[10].retention",
        "expected_range": "0 to 2.0 (>1 means rewatches)"
    },
    "final_5pct_retention": {
        "description": "Average retention in the final 5% of the video — end-completion signal",
        "what_to_extract": "mean of last 5 retentionCurve values",
        "formula": "mean(retentionCurve[-5:])",
        "expected_range": "0 to 1.5"
    },
    "mid_video_cliff": {
        "description": "Largest single-step drop in retention anywhere in the video",
        "what_to_extract": "max absolute diff between consecutive retentionCurve values",
        "formula": "max(|curve[i] - curve[i-1]|) for all i",
        "expected_range": "0 to 1.0 (higher = steeper cliff)"
    },
    "retention_entropy": {
        "description": "Shannon entropy of the retention curve — information richness. High entropy = many peaks/valleys, not monotonic.",
        "what_to_extract": "Shannon entropy of normalized retentionCurve values",
        "formula": "H = -sum(p * log2(p)) where p = |curve[i]| / sum(|curve|)",
        "expected_range": "0 to ~6 bits"
    },
    "hook_drop_rate": {
        "description": "Slope of retention in first 10% of video. Negative = dropping. More negative = worse hook hold.",
        "what_to_extract": "linear regression slope of retentionCurve[:10]",
        "formula": "linregress(range(10), retentionCurve[:10]).slope",
        "expected_range": "-0.05 to 0.02"
    },
    "early_momentum": {
        "description": "Change in retention from 10% to 25% into the video — does the video gain or lose viewers after the hook?",
        "what_to_extract": "retentionCurve[25] - retentionCurve[10]",
        "formula": "curve[25].retention - curve[10].retention",
        "expected_range": "-0.5 to 0.3"
    },
    "view_accel_7day": {
        "description": "Log10 of total views in first 7 days — early algorithmic push strength",
        "what_to_extract": "log10(sum of dailyViews[0:7].views)",
        "formula": "log10(sum(dailyViews[:7]['views']) + 1)",
        "expected_range": "0 to 8"
    },
    "week1_week2_ratio": {
        "description": "Week 2 views / Week 1 views — does virality sustain or spike-and-die?",
        "what_to_extract": "sum(dailyViews[7:14]) / sum(dailyViews[0:7])",
        "formula": "week2_views / (week1_views + 1)",
        "expected_range": "0 to 3"
    },
    "subs_gained_per_view": {
        "description": "Subscribers gained per 1000 views — channel growth efficiency per view",
        "what_to_extract": "analytics.subscribersGained / analytics.totalViews * 1000",
        "formula": "subscribersGained / totalViews * 1000",
        "expected_range": "0 to 10"
    },
    "non_sub_view_share": {
        "description": "Fraction of views from non-subscribers — measures algorithmic reach beyond existing audience",
        "what_to_extract": "analytics.nonSubscriberViews / analytics.totalViews",
        "formula": "nonSubscriberViews / totalViews",
        "expected_range": "0 to 1"
    },
    "swipe_away_rate": {
        "description": "Percent of impressions that swiped away immediately — inverse hook quality",
        "what_to_extract": "analytics.swipedAwayRate",
        "formula": "swipedAwayRate (0-100)",
        "expected_range": "0 to 100"
    },
    "like_rate": {
        "description": "Likes per 1000 views — engagement signal",
        "what_to_extract": "analytics.likes / analytics.totalViews * 1000",
        "formula": "likes / totalViews * 1000",
        "expected_range": "0 to 500"
    },
    "comment_rate": {
        "description": "Comments per 1000 views — discussion signal",
        "what_to_extract": "analytics.comments / analytics.totalViews * 1000",
        "formula": "comments / totalViews * 1000",
        "expected_range": "0 to 20"
    },
    "share_rate": {
        "description": "Shares per 1000 views — organic spread signal",
        "what_to_extract": "analytics.shares / analytics.totalViews * 1000",
        "formula": "shares / totalViews * 1000",
        "expected_range": "0 to 10"
    },
    "duration_log": {
        "description": "Log10 of video duration in seconds — tests whether length predicts views",
        "what_to_extract": "log10(metadata.duration)",
        "formula": "log10(duration_seconds)",
        "expected_range": "1 to 3"
    },
    "retention_25pct": {
        "description": "Retention value at 25% into the video",
        "what_to_extract": "retentionCurve[25].retention",
        "formula": "curve[25].retention",
        "expected_range": "0 to 1.5"
    },
    "retention_50pct": {
        "description": "Retention value at 50% into the video (midpoint)",
        "what_to_extract": "retentionCurve[50].retention",
        "formula": "curve[50].retention",
        "expected_range": "0 to 1.5"
    },
    "retention_75pct": {
        "description": "Retention value at 75% into the video",
        "what_to_extract": "retentionCurve[75].retention",
        "formula": "curve[75].retention",
        "expected_range": "0 to 1.5"
    },
    "retention_90pct": {
        "description": "Retention value at 90% into the video",
        "what_to_extract": "retentionCurve[90].retention",
        "formula": "curve[90].retention",
        "expected_range": "0 to 1.5"
    },
    "above_baseline_mean": {
        "description": "Mean amount by which retention exceeds a linear decay baseline. Positive = beats the straight-line average.",
        "what_to_extract": "mean(curve[i] - linear_baseline[i]) for all i",
        "formula": "mean(curve[i].retention - (1 - i/99)) for i in 0..99",
        "expected_range": "-0.3 to 0.5"
    },
    "peak_count": {
        "description": "Number of local peaks (momentary increases) in the retention curve",
        "what_to_extract": "count of local maxima in retentionCurve",
        "formula": "count(curve[i] > curve[i-1] and curve[i] > curve[i+1])",
        "expected_range": "0 to 20"
    },
    "drop_count": {
        "description": "Number of drops greater than 3% in the retention curve",
        "what_to_extract": "count of consecutive decreases > 0.03 in retentionCurve",
        "formula": "count(curve[i-1] - curve[i] > 0.03 for i in 1..99)",
        "expected_range": "0 to 15"
    },
    "max_peak_delta": {
        "description": "Size of the largest momentary increase in retention",
        "what_to_extract": "max positive consecutive difference in retentionCurve",
        "formula": "max(curve[i] - curve[i-1] for i where curve[i] > curve[i-1])",
        "expected_range": "0 to 0.5"
    },
    "max_drop_delta": {
        "description": "Size of the largest momentary drop in retention (absolute value)",
        "what_to_extract": "max negative consecutive difference in retentionCurve",
        "formula": "max(curve[i-1] - curve[i] for i where curve[i] < curve[i-1])",
        "expected_range": "0 to 0.5"
    },
    "transcript_word_count": {
        "description": "Total word count of the video transcript — proxy for how much was said",
        "what_to_extract": "len(transcript.split())",
        "formula": "word_count = len(transcript.split())",
        "expected_range": "0 to 1000"
    },
    "speech_rate_wps": {
        "description": "Words spoken per second — pacing signal",
        "what_to_extract": "len(transcript.split()) / metadata.duration",
        "formula": "word_count / duration_seconds",
        "expected_range": "0 to 5"
    },
    "hook_word_count": {
        "description": "Words spoken in the hook segment (or first 5 estimated seconds)",
        "what_to_extract": "len(hook_segment.transcript.split()) or estimated from full transcript",
        "formula": "len(hook_transcript.split())",
        "expected_range": "0 to 40"
    },
    "question_count": {
        "description": "Number of questions asked in the transcript — curiosity-gap signal",
        "what_to_extract": "count of '?' in transcript",
        "formula": "transcript.count('?')",
        "expected_range": "0 to 20"
    },
    "segment_count": {
        "description": "Number of narrative segments identified by AI analysis",
        "what_to_extract": "len(aiAnalysis.segments)",
        "formula": "len(segments)",
        "expected_range": "0 to 10"
    },
    "has_hook_segment": {
        "description": "Whether the AI identified a distinct Hook segment (1=yes, 0=no)",
        "what_to_extract": "1 if any segment labeled 'Hook' else 0",
        "formula": "int(any(s.label.lower() == 'hook' for s in segments))",
        "expected_range": "0 or 1"
    },
    "hook_duration_s": {
        "description": "Duration of the hook segment in seconds",
        "what_to_extract": "hook_segment.endTime - hook_segment.startTime",
        "formula": "hook_end - hook_start if hook exists else 0",
        "expected_range": "0 to 15"
    },
    "face_frame_pct": {
        "description": "Percentage of frames that contain a human face",
        "what_to_extract": "count frames where sceneDescription mentions 'face' / total frames",
        "formula": "face_frames / total_frames",
        "expected_range": "0 to 1"
    },
    "text_overlay_frame_pct": {
        "description": "Percentage of frames with visible text overlay",
        "what_to_extract": "count frames where visualTechniques or sceneDescription mentions 'text overlay'",
        "formula": "text_frames / total_frames",
        "expected_range": "0 to 1"
    },
    "scene_change_count": {
        "description": "Total number of scene changes detected across all frames (by comparing scene descriptions)",
        "what_to_extract": "count frames where scene description changes significantly from previous frame",
        "formula": "sum(1 for i where frames[i].sceneDescription[:50] != frames[i-1].sceneDescription[:50])",
        "expected_range": "0 to duration_seconds"
    },
    "log_like_count": {
        "description": "Log10 of like count — scale-adjusted engagement",
        "what_to_extract": "log10(metadata.likeCount + 1)",
        "formula": "log10(likeCount + 1)",
        "expected_range": "0 to 8"
    },
    "retention_variance": {
        "description": "Statistical variance of retention curve values — how much retention fluctuates across the video",
        "what_to_extract": "np.var([p.retention for p in retentionCurve])",
        "formula": "var(retentionCurve values)",
        "expected_range": "0 to 0.5"
    },
    "retention_skew": {
        "description": "Skewness of retention distribution — negative skew = back-heavy, positive = front-heavy",
        "what_to_extract": "scipy.stats.skew([p.retention for p in retentionCurve])",
        "formula": "skewness(retentionCurve values)",
        "expected_range": "-3 to 3"
    },
    "keep_x_non_sub_share": {
        "description": "Keep rate multiplied by non-subscriber view share — interaction of retention quality and algo reach",
        "what_to_extract": "avgRetention * (nonSubscriberViews / totalViews)",
        "formula": "avgRetention * non_sub_fraction",
        "expected_range": "0 to 1"
    },
    "subs_per_like": {
        "description": "Subscribers gained per like — quality of likers (highly engaged vs casual)",
        "what_to_extract": "subscribersGained / (likes + 1)",
        "formula": "subscribersGained / (likes + 1)",
        "expected_range": "0 to 0.5"
    },
    "revenue_per_view": {
        "description": "Estimated revenue per 1000 views (RPM proxy)",
        "what_to_extract": "analytics.estimatedRevenue / analytics.totalViews * 1000",
        "formula": "estimatedRevenue / totalViews * 1000",
        "expected_range": "0 to 10"
    },
    "daily_view_peak_day": {
        "description": "Day number from upload when daily views peaked — early peak = algo push, late peak = word-of-mouth",
        "what_to_extract": "argmax(dailyViews.views)",
        "formula": "index_of_max(dailyViews[*].views)",
        "expected_range": "0 to 365"
    }
}


# ── Experiment runner ──────────────────────────────────────────────────────────
def run_experiment(indicator_values, target_values, tool_id="pearson_r"):
    """Run the specified tool and return results dict."""
    x = np.array(indicator_values, dtype=float)
    y = np.array(target_values, dtype=float)

    # Filter NaN
    mask = ~(np.isnan(x) | np.isnan(y))
    x, y = x[mask], y[mask]
    n = len(x)

    if n < 10:
        return {"error": f"insufficient data: {n} points"}

    result = {"n": n, "tool_id": tool_id, "ran_at": now_iso()}

    if tool_id in ("pearson_r", "partial_correlation"):
        r, p = pearsonr(x, y)
        result["r_partial"] = float(r)
        result["r_direct"] = float(r)
        result["p_value"] = float(p)

    rho, p_rho = spearmanr(x, y)
    result["rho"] = float(rho)
    result["p_rho"] = float(p_rho)

    return result


def generate_conclusion(key, r, n, direction):
    """Generate plain-English conclusion from correlation result."""
    abs_r = abs(r)
    dir_word = "positively" if direction == "positive" else "negatively"

    if abs_r >= 0.5:
        strength = "strongly"
    elif abs_r >= 0.3:
        strength = "moderately"
    elif abs_r >= 0.1:
        strength = "weakly"
    else:
        return f"No meaningful relationship found between {key} and views (r={r:.3f}, n={n})."

    defn = METRIC_DEFINITIONS.get(key, {})
    desc = defn.get("description", key)

    return (f"{desc} is {strength} {dir_word} correlated with views "
            f"(r={r:.3f}, n={n}). "
            f"{'Higher' if direction == 'positive' else 'Lower'} {key} predicts more views.")


def generate_insight(key, r, direction):
    """Generate one actionable sentence."""
    if abs(r) < 0.1:
        return f"{key} does not appear to meaningfully affect views. Consider deprioritizing."
    defn = METRIC_DEFINITIONS.get(key, {})
    desc = defn.get("description", key).split("—")[0].strip()
    if direction == "positive":
        return f"Maximize {desc.lower()} to increase views."
    else:
        return f"Minimize or avoid high {desc.lower()} to increase views."


# ── Main pipeline ──────────────────────────────────────────────────────────────
def load_videos():
    """Load all Tyler videos from video_data directory."""
    videos = []
    if not VIDEO_DATA_DIR.exists():
        print(f"ERROR: video_data dir not found: {VIDEO_DATA_DIR}")
        return videos
    for vid_dir in VIDEO_DATA_DIR.iterdir():
        analysis_path = vid_dir / "analysis.json"
        if not analysis_path.exists():
            continue
        try:
            with open(analysis_path) as f:
                data = json.load(f)
            analytics = data.get("analytics", {})
            if analytics.get("retentionCurve") and analytics.get("avgRetention") is not None:
                data["_ytId"] = vid_dir.name
                videos.append(data)
        except Exception as e:
            pass
    print(f"Loaded {len(videos)} Tyler videos")
    return videos


def process_indicator(key, videos, existing_keys):
    """Run full pipeline for one indicator. Returns indicator dict or None."""
    if key in existing_keys:
        print(f"  SKIP {key} — already exists")
        return None

    if key not in METRIC_DEFINITIONS:
        print(f"  SKIP {key} — no metric definition")
        return None

    defn = METRIC_DEFINITIONS[key]
    print(f"  Processing: {key}")

    # ── Build dataset ──
    dataset = []
    skip_counts = {}
    for vid in videos:
        meta = vid.get("metadata", {})
        view_count = meta.get("viewCount", 0)
        if not view_count:
            skip_counts["no views"] = skip_counts.get("no views", 0) + 1
            continue

        value, skip_reason = extract_metric(key, vid)
        if value is None or (isinstance(value, float) and math.isnan(value)):
            skip_counts[skip_reason] = skip_counts.get(skip_reason, 0) + 1
            continue

        dataset.append({
            "ytId": vid["_ytId"],
            "value": float(value),
            "target_value": math.log10(view_count)
        })

    n = len(dataset)
    if n < 50:
        print(f"  SKIP {key} — only {n} valid videos (need 50+). Skips: {skip_counts}")
        return None

    print(f"  Dataset: {n} videos (skipped: {sum(skip_counts.values())} — {skip_counts})")

    # ── Run experiment ──
    indicator_vals = [d["value"] for d in dataset]
    target_vals = [d["target_value"] for d in dataset]
    exp_result = run_experiment(indicator_vals, target_vals, tool_id="pearson_r")

    if "error" in exp_result:
        print(f"  EXPERIMENT ERROR: {exp_result['error']}")
        return None

    r = exp_result.get("r_partial", 0)
    direction = "positive" if r >= 0 else "negative"
    status = "discovery"

    exp_id = f"exp_{key}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    conclusion = generate_conclusion(key, r, n, direction)
    insight = generate_insight(key, r, direction)

    print(f"  r={r:.3f}, rho={exp_result.get('rho', 0):.3f}, p={exp_result.get('p_value', 1):.4f}, n={n}")
    print(f"  Conclusion: {conclusion}")

    indicator = {
        "key": key,
        "label": key.replace("_", " ").title(),
        "layer": "post",
        "status": status,
        "resolution_id": "r0",
        "depth": 1,
        "target": "views",
        "metric_definition": defn,
        "dataset": dataset,
        "experiment": {
            "id": exp_id,
            "tool_id": "pearson_r",
            "tool_version": "1.0",
            "parameters": {
                "target": "views",
                "transform_target": "log10",
                "confounds": []
            },
            "ran_at": exp_result["ran_at"],
            "n_videos": n,
            "r_partial": exp_result.get("r_partial"),
            "r_direct": exp_result.get("r_direct"),
            "rho": exp_result.get("rho"),
            "p_value": exp_result.get("p_value"),
            "p_rho": exp_result.get("p_rho"),
            "r2_before": None,
            "r2_after": None,
            "delta_r2": None
        },
        "result": {
            "strength": round(abs(r), 4),
            "direction": direction,
            "status": status,
            "conclusion": conclusion,
            "practical_insight": insight
        },
        "connections": ["views"],
        "created_at": now_iso(),
        "updated_at": now_iso()
    }

    return indicator


def cmd_status():
    indicators = load_json(INDICATORS_FILE, [])
    queue = load_json(CANDIDATE_QUEUE_FILE, [])
    existing = {i["key"] for i in indicators}
    print(f"Indicators completed: {len(indicators)}")
    print(f"Candidate queue: {len(queue)} total, {len(queue) - len(existing & set(queue))} remaining")
    if indicators:
        print("\nTop by |r|:")
        sorted_inds = sorted(indicators, key=lambda i: abs(i.get("result", {}).get("strength", 0)), reverse=True)
        for ind in sorted_inds[:10]:
            r = ind.get("result", {}).get("strength", 0)
            direction = ind.get("result", {}).get("direction", "?")
            sign = "+" if direction == "positive" else "-"
            print(f"  {ind['key']:40s} r={sign}{r:.3f} n={ind['experiment']['n_videos']}")


def cmd_run(n_to_run):
    indicators = load_json(INDICATORS_FILE, [])
    experiments = load_json(EXPERIMENTS_FILE, [])
    queue = load_json(CANDIDATE_QUEUE_FILE, [])
    existing_keys = {i["key"] for i in indicators}

    videos = load_videos()
    if not videos:
        print("ERROR: No videos loaded")
        return

    ran = 0
    for key in queue:
        if ran >= n_to_run:
            break
        if key in existing_keys:
            continue
        print(f"\n[{ran+1}/{n_to_run}] {key}")
        result = process_indicator(key, videos, existing_keys)
        if result:
            indicators.append(result)
            experiments.append({
                "id": result["experiment"]["id"],
                "indicator_key": key,
                "tool_id": result["experiment"]["tool_id"],
                "r_partial": result["experiment"]["r_partial"],
                "rho": result["experiment"]["rho"],
                "n_videos": result["experiment"]["n_videos"],
                "status": result["result"]["status"],
                "ran_at": result["experiment"]["ran_at"]
            })
            existing_keys.add(key)
            save_json(INDICATORS_FILE, indicators)
            save_json(EXPERIMENTS_FILE, experiments)
            ran += 1

    print(f"\n=== DONE: {ran} indicators processed ===")
    cmd_status()


def cmd_single(key):
    indicators = load_json(INDICATORS_FILE, [])
    experiments = load_json(EXPERIMENTS_FILE, [])
    existing_keys = {i["key"] for i in indicators}
    videos = load_videos()
    print(f"\nRunning single: {key}")
    result = process_indicator(key, videos, existing_keys)
    if result:
        indicators.append(result)
        experiments.append({
            "id": result["experiment"]["id"],
            "indicator_key": key,
            "tool_id": result["experiment"]["tool_id"],
            "r_partial": result["experiment"]["r_partial"],
            "n_videos": result["experiment"]["n_videos"],
            "status": result["result"]["status"],
            "ran_at": result["experiment"]["ran_at"]
        })
        save_json(INDICATORS_FILE, indicators)
        save_json(EXPERIMENTS_FILE, experiments)
        print("Saved.")
    else:
        print("Indicator not created.")


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jarvis Pipeline")
    parser.add_argument("--run", type=int, metavar="N", help="Run N indicators")
    parser.add_argument("--single", type=str, metavar="KEY", help="Run one indicator by key")
    parser.add_argument("--status", action="store_true", help="Show current status")
    args = parser.parse_args()

    if args.status:
        cmd_status()
    elif args.run:
        cmd_run(args.run)
    elif args.single:
        cmd_single(args.single)
    else:
        parser.print_help()
