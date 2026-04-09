#!/usr/bin/env python3
"""
Jarvis Pipeline — Full Architecture
Steps: THEORIZE → QUALIFY → QUANTIFY → RESOLVE → DATASET → EXPERIMENT → RESULT → GRAPH → EXPAND
"""

import argparse
import json
import os
import math
import datetime
import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.stats import pearsonr, spearmanr

# ── Paths ──────────────────────────────────────────────────────────────────
JARVIS_DIR = Path(__file__).parent
VIDEO_DATA_DIR = JARVIS_DIR.parent.parent / "video_data"

TOOLS_FILE       = JARVIS_DIR / "tools.json"
RESOLUTIONS_FILE = JARVIS_DIR / "resolutions.json"
GRAPH_FILE       = JARVIS_DIR / "graph.json"
INDICATORS_FILE  = JARVIS_DIR / "indicators.json"
EXPERIMENTS_FILE = JARVIS_DIR / "experiments_log.json"
QUEUE_FILE       = JARVIS_DIR / "candidate_queue.json"

# ── Candidate queue ────────────────────────────────────────────────────────
DEFAULT_CANDIDATES = [
    "hook_retention_pct", "final_5pct_retention", "mid_video_cliff",
    "retention_entropy", "hook_drop_rate", "early_momentum",
    "retention_25pct", "retention_50pct", "retention_75pct", "retention_90pct",
    "above_baseline_mean", "peak_count", "drop_count", "max_peak_delta",
    "max_drop_delta", "retention_variance", "retention_skew",
    "view_accel_7day", "week1_week2_ratio", "non_sub_view_share",
    "swipe_away_rate", "daily_view_peak_day",
    "like_rate", "comment_rate", "share_rate", "subs_gained_per_view",
    "subs_per_like", "revenue_per_view",
    "duration_log", "transcript_word_count", "speech_rate_wps",
    "hook_word_count", "question_count", "segment_count",
    "has_hook_segment", "hook_duration_s",
    "face_frame_pct", "text_overlay_frame_pct", "scene_change_count",
    "keep_x_non_sub_share",
]

# ── Metric definitions ─────────────────────────────────────────────────────
METRIC_DEFINITIONS = {
    "hook_retention_pct": {
        "description": "Retention at 10% into the video — measures hook strength. How many people are still watching 1/10 of the way through?",
        "what_to_extract": "retentionCurve[10].retention — the retention value at index 10 (= 10% through video)",
        "formula": "retentionCurve[10].retention",
        "expected_range": "0 to 2.0 (>1.0 means re-watches)",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "final_5pct_retention": {
        "description": "Average retention in the final 5% of the video — end-completion signal. Videos that hold viewers to the very end.",
        "what_to_extract": "mean of retentionCurve[-5:].retention",
        "formula": "mean(retentionCurve[95:100].retention)",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "mid_video_cliff": {
        "description": "Largest single-step drop in retention anywhere in the video — the worst moment of viewer loss.",
        "what_to_extract": "max(|curve[i] - curve[i-1]|) for all consecutive pairs",
        "formula": "max(abs(diff(retentionCurve.retention)))",
        "expected_range": "0 to 1.0 (higher = steeper cliff)",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_entropy": {
        "description": "Shannon entropy of the retention curve — information richness. High entropy means many peaks/valleys vs monotonic decline.",
        "what_to_extract": "Shannon entropy H = -sum(p*log2(p)) where p = |val|/sum(|vals|)",
        "formula": "H = -sum(p_i * log2(p_i)) where p_i = |curve[i].retention| / sum(|curve[*].retention|)",
        "expected_range": "0 to ~6 bits",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "hook_drop_rate": {
        "description": "Slope of retention in the first 10% of video. More negative = viewers dropping faster right after start.",
        "what_to_extract": "linear regression slope of retentionCurve[0:10].retention",
        "formula": "linregress(range(10), retentionCurve[:10].retention).slope",
        "expected_range": "-0.05 to 0.02",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "early_momentum": {
        "description": "Change in retention from 10% to 25% mark — does the video gain or lose viewers after the hook?",
        "what_to_extract": "retentionCurve[25].retention - retentionCurve[10].retention",
        "formula": "curve[25] - curve[10]",
        "expected_range": "-0.5 to 0.3",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_25pct": {
        "description": "Retention value at exactly 25% into the video.",
        "what_to_extract": "retentionCurve[25].retention",
        "formula": "curve[25].retention",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_50pct": {
        "description": "Retention value at exactly 50% into the video (midpoint).",
        "what_to_extract": "retentionCurve[50].retention",
        "formula": "curve[50].retention",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_75pct": {
        "description": "Retention value at exactly 75% into the video.",
        "what_to_extract": "retentionCurve[75].retention",
        "formula": "curve[75].retention",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_90pct": {
        "description": "Retention value at exactly 90% into the video.",
        "what_to_extract": "retentionCurve[90].retention",
        "formula": "curve[90].retention",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "above_baseline_mean": {
        "description": "Mean amount by which retention exceeds a perfectly linear decay baseline.",
        "what_to_extract": "mean(curve[i].retention - (1 - i/99)) for i in 0..99",
        "formula": "mean(actual_retention[i] - linear_baseline[i])",
        "expected_range": "-0.3 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "peak_count": {
        "description": "Number of local peaks (momentary increases) in the retention curve — how many times viewers reengaged.",
        "what_to_extract": "count of indices where curve[i] > curve[i-1] and curve[i] > curve[i+1]",
        "formula": "count(local_maxima in retentionCurve.retention)",
        "expected_range": "0 to 20",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "drop_count": {
        "description": "Number of drops greater than 3% in the retention curve — how many significant viewer-loss moments.",
        "what_to_extract": "count of consecutive decreases > 0.03 in retention values",
        "formula": "count(curve[i-1] - curve[i] > 0.03 for i in 1..99)",
        "expected_range": "0 to 15",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "max_peak_delta": {
        "description": "Size of the largest momentary increase in retention — the strongest re-engagement moment.",
        "what_to_extract": "max positive consecutive difference in retention values",
        "formula": "max(curve[i] - curve[i-1] for i where curve[i] > curve[i-1])",
        "expected_range": "0 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "max_drop_delta": {
        "description": "Size of the largest single drop in retention — the worst viewer-loss moment.",
        "what_to_extract": "max negative consecutive difference (as positive number)",
        "formula": "max(curve[i-1] - curve[i] for i where curve[i] < curve[i-1])",
        "expected_range": "0 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_variance": {
        "description": "Statistical variance of all retention curve values — how much retention fluctuates.",
        "what_to_extract": "np.var([p['retention'] for p in retentionCurve])",
        "formula": "var(retentionCurve.retention)",
        "expected_range": "0 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_skew": {
        "description": "Skewness of retention distribution. Negative = back-heavy (holds well). Positive = front-heavy.",
        "what_to_extract": "scipy.stats.skew([p['retention'] for p in retentionCurve])",
        "formula": "skewness(retentionCurve.retention)",
        "expected_range": "-3 to 3",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "view_accel_7day": {
        "description": "Log10 of total views in the first 7 days — measures early algorithmic push strength.",
        "what_to_extract": "log10(sum of dailyViews[0:7].views + 1)",
        "formula": "log10(week1_views + 1)",
        "expected_range": "0 to 8",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "week1_week2_ratio": {
        "description": "Week 2 views divided by Week 1 views — sustained virality vs spike-and-die.",
        "what_to_extract": "sum(dailyViews[7:14].views) / (sum(dailyViews[0:7].views) + 1)",
        "formula": "week2_views / (week1_views + 1)",
        "expected_range": "0 to 3",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "non_sub_view_share": {
        "description": "Fraction of views from non-subscribers — measures algorithmic reach beyond existing audience.",
        "what_to_extract": "analytics.nonSubscriberViews / analytics.totalViews",
        "formula": "nonSubscriberViews / totalViews",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.nonSubscriberViews", "analytics.totalViews"],
        "layer": "post",
    },
    "swipe_away_rate": {
        "description": "Percent of impressions that swiped away immediately — direct measure of hook failure.",
        "what_to_extract": "analytics.swipedAwayRate",
        "formula": "swipedAwayRate (0-100%)",
        "expected_range": "0 to 100",
        "data_sources": ["analytics.swipedAwayRate"],
        "layer": "post",
    },
    "daily_view_peak_day": {
        "description": "Day number from upload when daily views peaked. Day 0-2 = algo push. Day 30+ = long tail.",
        "what_to_extract": "index of max value in dailyViews[*].views",
        "formula": "argmax(dailyViews.views)",
        "expected_range": "0 to 365",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "like_rate": {
        "description": "Likes per 1000 views — engagement quality signal.",
        "what_to_extract": "analytics.likes / analytics.totalViews * 1000",
        "formula": "likes / totalViews * 1000",
        "expected_range": "0 to 500",
        "data_sources": ["analytics.likes", "analytics.totalViews"],
        "layer": "post",
    },
    "comment_rate": {
        "description": "Comments per 1000 views — discussion / emotional engagement signal.",
        "what_to_extract": "analytics.comments / analytics.totalViews * 1000",
        "formula": "comments / totalViews * 1000",
        "expected_range": "0 to 20",
        "data_sources": ["analytics.comments", "analytics.totalViews"],
        "layer": "post",
    },
    "share_rate": {
        "description": "Shares per 1000 views — organic spread signal.",
        "what_to_extract": "analytics.shares / analytics.totalViews * 1000",
        "formula": "shares / totalViews * 1000",
        "expected_range": "0 to 10",
        "data_sources": ["analytics.shares", "analytics.totalViews"],
        "layer": "post",
    },
    "subs_gained_per_view": {
        "description": "Subscribers gained per 1000 views — channel growth efficiency.",
        "what_to_extract": "analytics.subscribersGained / analytics.totalViews * 1000",
        "formula": "subscribersGained / totalViews * 1000",
        "expected_range": "0 to 10",
        "data_sources": ["analytics.subscribersGained", "analytics.totalViews"],
        "layer": "post",
    },
    "subs_per_like": {
        "description": "Subscribers gained per like — quality of viewer engagement (highly engaged vs casual).",
        "what_to_extract": "analytics.subscribersGained / (analytics.likes + 1)",
        "formula": "subscribersGained / (likes + 1)",
        "expected_range": "0 to 0.5",
        "data_sources": ["analytics.subscribersGained", "analytics.likes"],
        "layer": "post",
    },
    "revenue_per_view": {
        "description": "Estimated revenue per 1000 views (RPM proxy) — monetization signal.",
        "what_to_extract": "analytics.estimatedRevenue / analytics.totalViews * 1000",
        "formula": "estimatedRevenue / totalViews * 1000",
        "expected_range": "0 to 10",
        "data_sources": ["analytics.estimatedRevenue", "analytics.totalViews"],
        "layer": "post",
    },
    "duration_log": {
        "description": "Log10 of video duration in seconds — tests whether length predicts views.",
        "what_to_extract": "log10(metadata.duration)",
        "formula": "log10(duration_seconds)",
        "expected_range": "1 to 3",
        "data_sources": ["metadata.duration"],
        "layer": "pre",
    },
    "transcript_word_count": {
        "description": "Total word count of the video transcript — proxy for how much was said.",
        "what_to_extract": "len(transcript.split())",
        "formula": "word_count = len(transcript.split())",
        "expected_range": "0 to 1000",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "speech_rate_wps": {
        "description": "Words spoken per second — pacing signal. Fast = dense info, slow = deliberate.",
        "what_to_extract": "len(transcript.split()) / metadata.duration",
        "formula": "word_count / duration_seconds",
        "expected_range": "0 to 5",
        "data_sources": ["transcript", "metadata.duration"],
        "layer": "pre",
    },
    "hook_word_count": {
        "description": "Words spoken in the hook segment — how much is said upfront.",
        "what_to_extract": "len(hook_segment.transcript.split()) or estimate from full transcript",
        "formula": "len(hook_transcript.split())",
        "expected_range": "0 to 40",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "question_count": {
        "description": "Number of questions asked in the transcript — curiosity-gap and engagement signal.",
        "what_to_extract": "transcript.count('?')",
        "formula": "count('?' in transcript)",
        "expected_range": "0 to 20",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "segment_count": {
        "description": "Number of narrative segments identified by AI analysis — structural complexity.",
        "what_to_extract": "len(aiAnalysis.segments)",
        "formula": "len(segments)",
        "expected_range": "0 to 10",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "has_hook_segment": {
        "description": "Whether AI identified a distinct Hook segment (1=yes, 0=no) — presence of intentional hook.",
        "what_to_extract": "1 if any segment.label.lower() == 'hook' else 0",
        "formula": "int(any(s['label'].lower() == 'hook' for s in segments))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "hook_duration_s": {
        "description": "Duration of the hook segment in seconds — how long the hook lasts.",
        "what_to_extract": "hook_segment.endTime - hook_segment.startTime if exists else 0",
        "formula": "hook_end - hook_start",
        "expected_range": "0 to 15",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "face_frame_pct": {
        "description": "Percentage of frames that contain a human face — presence of person on screen.",
        "what_to_extract": "count(frames where 'face' in sceneDescription.lower()) / len(frames)",
        "formula": "face_frames / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "text_overlay_frame_pct": {
        "description": "Percentage of frames with visible text overlay — use of on-screen text.",
        "what_to_extract": "count(frames where 'text overlay' in visualTechniques or sceneDescription) / len(frames)",
        "formula": "text_frames / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.visualTechniques", "frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "scene_change_count": {
        "description": "Total number of scene changes detected across all frames — edit pace / cut rate.",
        "what_to_extract": "count(frame i where frame[i].sceneDescription[:60] != frame[i-1].sceneDescription[:60])",
        "formula": "count(scene_change_detected for consecutive frame pairs)",
        "expected_range": "0 to duration_seconds",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "keep_x_non_sub_share": {
        "description": "Keep rate multiplied by non-subscriber view share — interaction of retention quality and algorithmic reach.",
        "what_to_extract": "analytics.avgRetention * (analytics.nonSubscriberViews / analytics.totalViews)",
        "formula": "avgRetention * non_sub_fraction",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.avgRetention", "analytics.nonSubscriberViews", "analytics.totalViews"],
        "layer": "post",
    },
}


# ── JSON helpers ───────────────────────────────────────────────────────────
def load_json(path, default=None):
    p = Path(path)
    if p.exists():
        with open(p) as f:
            return json.load(f)
    return default if default is not None else []


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


# ── extract_metric ─────────────────────────────────────────────────────────
def extract_metric(key, analysis):
    """Extract float value from video analysis.json. Returns (value, skip_reason)."""
    meta = analysis.get("metadata", {}) or {}
    analytics = analysis.get("analytics", {}) or {}
    _t = analysis.get("transcript") or ""
    transcript = (_t.get("fullText", "") if isinstance(_t, dict) else _t).strip()
    ai = analysis.get("aiAnalysis", {}) or {}
    frames = analysis.get("frames", []) or []
    segments = (ai.get("segments", []) or []) if isinstance(ai, dict) else []
    curve = analytics.get("retentionCurve", []) or []
    daily = analytics.get("dailyViews", []) or []

    def curve_val(idx):
        if len(curve) <= idx:
            return None
        return curve[idx]["retention"]

    if key == "hook_retention_pct":
        v = curve_val(10)
        return (v, None) if v is not None else (None, "no curve")

    if key == "final_5pct_retention":
        if len(curve) < 5:
            return (None, "curve too short")
        return (float(np.mean([p["retention"] for p in curve[-5:]])), None)

    if key == "mid_video_cliff":
        if len(curve) < 2:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        return (float(max(abs(vals[i] - vals[i - 1]) for i in range(1, len(vals)))), None)

    if key == "retention_entropy":
        if not curve:
            return (None, "no curve")
        vals = [abs(p["retention"]) for p in curve]
        total = sum(vals)
        if total == 0:
            return (0.0, None)
        probs = [v / total for v in vals if v > 0]
        return (float(-sum(p * math.log2(p) for p in probs)), None)

    if key == "hook_drop_rate":
        if len(curve) < 10:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[:10]]
        slope, _, _, _, _ = stats.linregress(range(10), vals)
        return (float(slope), None)

    if key == "early_momentum":
        v25, v10 = curve_val(25), curve_val(10)
        if v25 is None or v10 is None:
            return (None, "no curve")
        return (float(v25 - v10), None)

    if key == "retention_25pct":
        v = curve_val(25)
        return (v, None) if v is not None else (None, "no curve")

    if key == "retention_50pct":
        v = curve_val(50)
        return (v, None) if v is not None else (None, "no curve")

    if key == "retention_75pct":
        v = curve_val(75)
        return (v, None) if v is not None else (None, "no curve")

    if key == "retention_90pct":
        v = curve_val(90)
        return (v, None) if v is not None else (None, "no curve")

    if key == "above_baseline_mean":
        if not curve:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        n = len(vals)
        above = [vals[i] - (1.0 - i / max(n - 1, 1)) for i in range(n)]
        return (float(np.mean(above)), None)

    if key == "peak_count":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        peaks = sum(1 for i in range(1, len(vals) - 1) if vals[i] > vals[i - 1] and vals[i] > vals[i + 1])
        return (float(peaks), None)

    if key == "drop_count":
        if len(curve) < 2:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        drops = sum(1 for i in range(1, len(vals)) if (vals[i - 1] - vals[i]) > 0.03)
        return (float(drops), None)

    if key == "max_peak_delta":
        if len(curve) < 2:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        increases = [vals[i] - vals[i - 1] for i in range(1, len(vals)) if vals[i] > vals[i - 1]]
        return (float(max(increases)) if increases else 0.0, None)

    if key == "max_drop_delta":
        if len(curve) < 2:
            return (None, "no curve")
        vals = [p["retention"] for p in curve]
        drops = [vals[i - 1] - vals[i] for i in range(1, len(vals)) if vals[i] < vals[i - 1]]
        return (float(max(drops)) if drops else 0.0, None)

    if key == "retention_variance":
        if not curve:
            return (None, "no curve")
        return (float(np.var([p["retention"] for p in curve])), None)

    if key == "retention_skew":
        if len(curve) < 3:
            return (None, "curve too short")
        return (float(stats.skew([p["retention"] for p in curve])), None)

    if key == "view_accel_7day":
        if not daily:
            return (None, "no daily views")
        week1 = sum(d.get("views", 0) for d in daily[:7])
        return (float(math.log10(week1 + 1)), None)

    if key == "week1_week2_ratio":
        if len(daily) < 7:
            return (None, "insufficient daily views")
        w1 = sum(d.get("views", 0) for d in daily[:7])
        w2 = sum(d.get("views", 0) for d in daily[7:14])
        return (float(w2 / (w1 + 1)), None)

    if key == "non_sub_view_share":
        total = analytics.get("totalViews", 0)
        non_sub = analytics.get("nonSubscriberViews", 0)
        if not total:
            return (None, "no views")
        return (float(non_sub / total), None)

    if key == "swipe_away_rate":
        v = analytics.get("swipedAwayRate")
        return (float(v), None) if v is not None else (None, "no swipe data")

    if key == "daily_view_peak_day":
        if not daily:
            return (None, "no daily views")
        return (float(int(np.argmax([d.get("views", 0) for d in daily]))), None)

    if key == "like_rate":
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (float(analytics.get("likes", 0) / total * 1000), None)

    if key == "comment_rate":
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (float(analytics.get("comments", 0) / total * 1000), None)

    if key == "share_rate":
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (float(analytics.get("shares", 0) / total * 1000), None)

    if key == "subs_gained_per_view":
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (float(analytics.get("subscribersGained", 0) / total * 1000), None)

    if key == "subs_per_like":
        likes = analytics.get("likes", 0)
        subs = analytics.get("subscribersGained", 0)
        return (float(subs / (likes + 1)), None)

    if key == "revenue_per_view":
        total = analytics.get("totalViews", 0)
        if not total:
            return (None, "no views")
        return (float(analytics.get("estimatedRevenue", 0) / total * 1000), None)

    if key == "duration_log":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (float(math.log10(dur)), None)

    if key == "transcript_word_count":
        if not transcript:
            return (None, "no transcript")
        return (float(len(transcript.split())), None)

    if key == "speech_rate_wps":
        if not transcript:
            return (None, "no transcript")
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (float(len(transcript.split()) / dur), None)

    if key == "hook_word_count":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            return (float(len(hook_seg["transcript"].split())), None)
        if not transcript:
            return (None, "no transcript")
        dur = meta.get("duration", 1)
        words = transcript.split()
        hook_est = max(1, int(len(words) * 5 / dur))
        return (float(len(words[:hook_est])), None)

    if key == "question_count":
        if not transcript:
            return (None, "no transcript")
        return (float(transcript.count("?")), None)

    if key == "segment_count":
        return (float(len(segments)), None)

    if key == "has_hook_segment":
        has = any(s.get("label", "").lower() == "hook" for s in segments)
        return (float(int(has)), None)

    if key == "hook_duration_s":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg:
            return (float(hook_seg.get("endTime", 0) - hook_seg.get("startTime", 0)), None)
        return (0.0, None)

    if key == "face_frame_pct":
        if not frames:
            return (None, "no frames")
        face_ct = sum(1 for f in frames if "face" in str(f.get("analysis", {}).get("sceneDescription", "")).lower())
        return (float(face_ct / len(frames)), None)

    if key == "text_overlay_frame_pct":
        if not frames:
            return (None, "no frames")
        txt_ct = sum(1 for f in frames if
                     "text overlay" in str(f.get("analysis", {}).get("visualTechniques", "")).lower() or
                     "text overlay" in str(f.get("analysis", {}).get("sceneDescription", "")).lower())
        return (float(txt_ct / len(frames)), None)

    if key == "scene_change_count":
        if not frames:
            return (None, "no frames")
        changes, prev = 0, ""
        for frame in frames:
            desc = str(frame.get("analysis", {}).get("sceneDescription", ""))
            if prev and desc[:60] != prev[:60]:
                changes += 1
            prev = desc
        return (float(changes), None)

    if key == "keep_x_non_sub_share":
        keep = analytics.get("avgRetention")
        total = analytics.get("totalViews", 0)
        non_sub = analytics.get("nonSubscriberViews", 0)
        if keep is None or not total:
            return (None, "missing data")
        return (float(keep * (non_sub / total)), None)

    return (None, f"unknown key: {key}")


# ── PIPELINE STEPS ─────────────────────────────────────────────────────────

def step_theorize(queue, existing_keys):
    """Step 1: Get next candidate not yet processed."""
    for key in queue:
        if key not in existing_keys:
            return key
    return None


def step_qualify(key, existing_keys):
    """Step 2: Check if indicator already exists."""
    return key not in existing_keys


def step_quantify(key):
    """Step 3: Look up metric definition."""
    return METRIC_DEFINITIONS.get(key)


# ── Resolution map: what each indicator actually measures ─────────────────
INDICATOR_RESOLUTION_MAP = {
    # Whole-video aggregates → r0
    'mid_video_cliff':        ('r0',         0,   100,  None,  None),
    'retention_entropy':      ('r0',         0,   100,  None,  None),
    'above_baseline_mean':    ('r0',         0,   100,  None,  None),
    'peak_count':             ('r0',         0,   100,  None,  None),
    'drop_count':             ('r0',         0,   100,  None,  None),
    'max_peak_delta':         ('r0',         0,   100,  None,  None),
    'max_drop_delta':         ('r0',         0,   100,  None,  None),
    'retention_variance':     ('r0',         0,   100,  None,  None),
    'retention_skew':         ('r0',         0,   100,  None,  None),
    'non_sub_view_share':     ('r0',         0,   100,  None,  None),
    'swipe_away_rate':        ('r0',         0,   100,  None,  None),
    'daily_view_peak_day':    ('r0',         0,   100,  None,  None),
    'duration_log':           ('r0',         0,   100,  None,  None),
    'transcript_word_count':  ('r0',         0,   100,  None,  None),
    'speech_rate_wps':        ('r0',         0,   100,  None,  None),
    'segment_count':          ('r0',         0,   100,  None,  None),
    'scene_change_count':     ('r0',         0,   100,  None,  None),
    'like_rate':              ('r0',         0,   100,  None,  None),
    'comment_rate':           ('r0',         0,   100,  None,  None),
    'share_rate':             ('r0',         0,   100,  None,  None),
    'subs_gained_per_view':   ('r0',         0,   100,  None,  None),
    'subs_per_like':          ('r0',         0,   100,  None,  None),
    'revenue_per_view':       ('r0',         0,   100,  None,  None),
    'keep_x_non_sub_share':   ('r0',         0,   100,  None,  None),
    'face_frame_pct':         ('r0',         0,   100,  None,  None),
    'text_overlay_frame_pct': ('r0',         0,   100,  None,  None),
    # Single-point measurements (a point on the curve, not a window) → r0
    'hook_retention_pct':     ('r0',         0,   100,  None,  None),
    'retention_25pct':        ('r0',         0,   100,  None,  None),
    'retention_50pct':        ('r0',         0,   100,  None,  None),
    'retention_75pct':        ('r0',         0,   100,  None,  None),
    'retention_90pct':        ('r0',         0,   100,  None,  None),
    # Sub-video windows
    'final_5pct_retention':   ('r_last5pct', 95,  100,  None,  None),
    'hook_drop_rate':         ('r_hook',     0,   10,   None,  None),
    'hook_word_count':        ('r_hook',     0,   10,   None,  None),
    'has_hook_segment':       ('r_hook',     0,   10,   None,  None),
    'hook_duration_s':        ('r_hook',     0,   10,   None,  None),
    'early_momentum':         ('r_early',    10,  25,   None,  None),
    # Time-based (days, not video position)
    'view_accel_7day':        ('r_week1',    None, None, 0,    7),
    'week1_week2_ratio':      ('r_week1_2',  None, None, 0,    14),
}

DEFAULT_RESOLUTION_DEFS = {
    'r0':         {'id': 'r0',         'label': 'Full Video',          'description': 'Entire video analyzed as one unit. One scalar per video.',            'start_pct': 0,   'end_pct': 100, 'start_day': None, 'end_day': None, 'granularity': 'whole'},
    'r_last5pct': {'id': 'r_last5pct', 'label': 'Last 5% of Video',    'description': 'Final 5 percent of video. Measures end-completion signals.',          'start_pct': 95,  'end_pct': 100, 'start_day': None, 'end_day': None, 'granularity': 'video_window'},
    'r_hook':     {'id': 'r_hook',     'label': 'Hook Window (0-10%)', 'description': 'First 10 percent of video. Hook and opening retention behavior.',       'start_pct': 0,   'end_pct': 10,  'start_day': None, 'end_day': None, 'granularity': 'video_window'},
    'r_early':    {'id': 'r_early',    'label': 'Early Window (10-25%)','description': 'Second quarter of video. Post-hook momentum and engagement signal.',  'start_pct': 10,  'end_pct': 25,  'start_day': None, 'end_day': None, 'granularity': 'video_window'},
    'r_week1':    {'id': 'r_week1',    'label': 'First 7 Days',        'description': 'First 7 days post-upload. Early algorithmic distribution window.',      'start_pct': None,'end_pct': None,'start_day': 0,   'end_day': 7,   'granularity': 'time_window'},
    'r_week1_2':  {'id': 'r_week1_2',  'label': 'Days 0-14',           'description': 'First two weeks post-upload. Week-over-week virality pattern.',         'start_pct': None,'end_pct': None,'start_day': 0,   'end_day': 14,  'granularity': 'time_window'},
}


def step_resolve(key, resolutions):
    """Step 4: Assign resolution based on what the indicator actually measures."""
    # Look up the correct resolution for this indicator
    res_info = INDICATOR_RESOLUTION_MAP.get(key, ('r0', 0, 100, None, None))
    resolution_id = res_info[0]
    exists = any(r["id"] == resolution_id for r in resolutions)
    if not exists:
        # Create the shelf from the definition map
        defn = DEFAULT_RESOLUTION_DEFS.get(resolution_id, DEFAULT_RESOLUTION_DEFS['r0'])
        new_shelf = {
            **defn,
            "created_from": "pipeline",
            "created_at": now_iso(),
            "indicator_keys": [],
            "depth_in_hierarchy": 0 if resolution_id == 'r0' else 1,
        }
        resolutions.append(new_shelf)
        # Sort by start_pct (video-position shelves first, then time-based)
        resolutions.sort(key=lambda r: (r.get('start_pct') or 999, r['id']))
        print(f"  [RESOLVE]    *** New resolution shelf created: {resolution_id} ({defn['label']}) ***")
    for r in resolutions:
        if r["id"] == resolution_id:
            if key not in r.get("indicator_keys", []):
                r.setdefault("indicator_keys", []).append(key)
            break
    # Gap check
    sorted_res = sorted(resolutions, key=lambda r: r.get("start_pct", 0))
    for i in range(1, len(sorted_res)):
        gap = sorted_res[i]["start_pct"] - sorted_res[i - 1]["end_pct"]
        if gap > 25:
            print(f"  [RESOLVE] Gap: {sorted_res[i-1]['id']} ends at {sorted_res[i-1]['end_pct']}%, "
                  f"{sorted_res[i]['id']} starts at {sorted_res[i]['start_pct']}%")
    save_json(RESOLUTIONS_FILE, resolutions)
    return resolution_id


def step_prep_dataset(key, videos):
    """Step 5: Extract per-video values. Store full dataset."""
    dataset, skip_counts = [], {}
    for vid in videos:
        view_count = vid.get("metadata", {}).get("viewCount", 0)
        if not view_count:
            skip_counts["no viewCount"] = skip_counts.get("no viewCount", 0) + 1
            continue
        value, skip_reason = extract_metric(key, vid)
        if value is None or (isinstance(value, float) and (math.isnan(value) or math.isinf(value))):
            r = skip_reason or "invalid value"
            skip_counts[r] = skip_counts.get(r, 0) + 1
            continue
        dataset.append({
            "ytId": vid["_ytId"],
            "value": float(value),
            "target_value": float(math.log10(view_count)),
        })
    skipped = sum(skip_counts.values())
    print(f"  [DATASET]   {len(dataset)} videos included, {skipped} skipped {skip_counts if skipped else ''}")
    return dataset


def step_run_experiment(key, dataset, tools, tool_id="pearson_r"):
    """Step 6: Pick tool from Analytical Brain registry and run it."""
    tool = next((t for t in tools if t["id"] == tool_id), None)
    if not tool:
        print(f"  [EXPERIMENT] ERROR: Tool '{tool_id}' not in registry")
        return None

    min_n = 50
    if len(dataset) < min_n:
        print(f"  [EXPERIMENT] SKIP: {len(dataset)} videos < min_n={min_n}")
        return None

    x = np.array([d["value"] for d in dataset], dtype=float)
    y = np.array([d["target_value"] for d in dataset], dtype=float)
    mask = ~(np.isnan(x) | np.isnan(y) | np.isinf(x) | np.isinf(y))
    x, y = x[mask], y[mask]
    n = len(x)

    # Pearson r + 95% CI via Fisher z-transform
    r, p = pearsonr(x, y)
    z = 0.5 * math.log((1 + r + 1e-10) / (1 - r + 1e-10))
    se = 1.0 / math.sqrt(max(n - 3, 1))
    ci_low = math.tanh(z - 1.96 * se)
    ci_high = math.tanh(z + 1.96 * se)

    # Spearman rho (always run as sanity check)
    rho, p_rho = spearmanr(x, y)

    exp_id = f"exp_{key}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    outputs = {
        "r": float(r), "p_value": float(p), "n": int(n),
        "ci_low": float(ci_low), "ci_high": float(ci_high),
        "rho": float(rho), "p_rho": float(p_rho),
    }

    print(f"  [EXPERIMENT] {tool['name']} — r={r:+.3f}, rho={rho:+.3f}, p={p:.4f}, n={n}")
    return {
        "id": exp_id,
        "tool_id": tool_id,
        "tool_version": tool.get("version", "1.0"),
        "tool_name": tool["name"],
        "parameters": {
            "target": "views",
            "transform_target": "log10",
            "confounds": [],
            "min_n": min_n,
        },
        "ran_at": now_iso(),
        "n_videos": n,
        "outputs": outputs,
    }


def step_build_result(key, exp):
    """Step 7: Build mathematical result + plain-English conclusion."""
    r = exp["outputs"]["r"]
    rho = exp["outputs"]["rho"]
    n = exp["outputs"]["n"]
    p = exp["outputs"]["p_value"]
    ci_low = exp["outputs"]["ci_low"]
    ci_high = exp["outputs"]["ci_high"]

    abs_r = abs(r)
    direction = "positive" if r >= 0 else "negative"
    strength_label = ("strong" if abs_r >= 0.5 else
                      "moderate" if abs_r >= 0.3 else
                      "weak" if abs_r >= 0.1 else "none")

    defn = METRIC_DEFINITIONS.get(key, {})
    desc = defn.get("description", key)
    short_desc = desc.split("—")[0].strip()

    if strength_label == "none":
        conclusion = (
            f"No meaningful linear relationship found between {key} and views "
            f"(r={r:+.3f}, 95% CI [{ci_low:+.3f}, {ci_high:+.3f}], p={p:.4f}, n={n}). "
            f"Spearman rho={rho:+.3f} also confirms no rank-order relationship. "
            f"This indicator does not predict view count in Tyler's corpus of {n} videos."
        )
        practical_insight = f"{short_desc} does not meaningfully predict views. Safe to deprioritize."
    else:
        dir_word = "positively" if direction == "positive" else "negatively"
        linear_note = "linear" if abs(abs_r - abs(rho)) < 0.1 else "partially non-linear"
        conclusion = (
            f"{desc} "
            f"Is {strength_label}ly {dir_word} correlated with views "
            f"(r={r:+.3f}, 95% CI [{ci_low:+.3f}, {ci_high:+.3f}], p={p:.4f}, n={n}). "
            f"Spearman rho={rho:+.3f} confirms a {linear_note} relationship. "
            f"{'Higher' if direction == 'positive' else 'Lower'} {key} values predict more views."
        )
        if direction == "positive":
            practical_insight = f"Maximize {short_desc.lower()} to increase views."
        else:
            practical_insight = f"Minimize {short_desc.lower()} to increase views."

    print(f"  [RESULT]    {strength_label} {direction}: {practical_insight}")
    return {
        "primary_r": float(r),
        "rho": float(rho),
        "p_value": float(p),
        "ci_low": float(ci_low),
        "ci_high": float(ci_high),
        "direction": direction,
        "strength_label": strength_label,
        "status": "discovery",
        "conclusion": conclusion,
        "practical_insight": practical_insight,
    }


def step_update_graph(indicator, graph):
    """Step 8: Add node + edge to graph.json."""
    key = indicator["key"]
    target = indicator["target"]
    target_nodes = {"views", "keep", "retention"}

    if target in target_nodes:
        depth = 1
    else:
        t_node = next((n for n in graph["nodes"] if n["key"] == target), None)
        depth = (t_node["depth"] if t_node else 1) + 1

    node = {
        "key": key,
        "label": indicator["label"],
        "type": "indicator",
        "layer": indicator["layer"],
        "depth": depth,
        "r_partial": indicator["result"]["primary_r"],
        "resolution_id": indicator["resolution_id"],
        "connections": [target],
        "description": indicator["metric_definition"]["description"],
        "experiment_id": indicator["experiment"]["id"],
        "status": indicator["result"]["status"],
        "strength_label": indicator["result"]["strength_label"],
    }

    graph["nodes"] = [n for n in graph["nodes"] if n["key"] != key]
    graph["nodes"].append(node)

    edge = {
        "from": key, "to": target,
        "r": indicator["result"]["primary_r"],
        "experiment_id": indicator["experiment"]["id"],
        "added_at": now_iso(),
    }
    graph["edges"] = [e for e in graph["edges"] if not (e["from"] == key and e["to"] == target)]
    graph["edges"].append(edge)
    graph["updated_at"] = now_iso()
    save_json(GRAPH_FILE, graph)
    print(f"  [GRAPH]     Node added, depth={depth}, connected to '{target}'")


def step_get_comparison_target(graph):
    """Step 9 (EXPAND): Choose comparison target based on graph size."""
    import random
    n_ind = sum(1 for n in graph["nodes"] if n["type"] == "indicator")
    if n_ind < 10:
        target = "views"
        phase = "1"
    elif n_ind < 30:
        if random.random() < 0.8:
            target = "views"
        else:
            cands = [n["key"] for n in graph["nodes"] if n["type"] == "indicator"]
            target = random.choice(cands) if cands else "views"
        phase = "2"
    else:
        cands = [n for n in graph["nodes"] if n["type"] == "indicator"]
        if not cands or random.random() < 0.5:
            target = "views"
        else:
            weights = [abs(n.get("r_partial", 0.1)) for n in cands]
            total_w = sum(weights)
            rv = random.random() * total_w
            cumsum, target = 0, "views"
            for n, w in zip(cands, weights):
                cumsum += w
                if cumsum >= rv:
                    target = n["key"]
                    break
        phase = "3"
    print(f"  [EXPAND]    target='{target}' (Phase {phase}, {n_ind} indicator nodes in graph)")
    return target


# ── Main process_indicator ─────────────────────────────────────────────────
def load_videos():
    """Load all 370 Tyler videos with full analytics."""
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
            analytics = data.get("analytics", {}) or {}
            if analytics.get("retentionCurve") and analytics.get("avgRetention") is not None:
                data["_ytId"] = vid_dir.name
                videos.append(data)
        except Exception:
            pass
    print(f"Loaded {len(videos)} Tyler videos")
    return videos


def process_indicator(key, videos, existing_keys, resolutions, graph, tools):
    """Run all 9 pipeline steps for one candidate."""
    print(f"\n{'=' * 60}")
    print(f"INDICATOR: {key}")
    print(f"{'=' * 60}")

    print(f"  [STEP 1 THEORIZE]    Candidate: {key}")

    if not step_qualify(key, existing_keys):
        print(f"  [STEP 2 QUALIFY]     Already exists — skip")
        return None
    print(f"  [STEP 2 QUALIFY]     New indicator, proceeding")

    metric_def = step_quantify(key)
    if not metric_def:
        print(f"  [STEP 3 QUANTIFY]    No metric definition — skip")
        return None
    print(f"  [STEP 3 QUANTIFY]    {metric_def['description'][:80]}...")

    resolution_id = step_resolve(key, resolutions)
    res_label = next((r["label"] for r in resolutions if r["id"] == resolution_id), resolution_id)
    print(f"  [STEP 4 RESOLVE]     {resolution_id} ({res_label})")

    dataset = step_prep_dataset(key, videos)
    if len(dataset) < 50:
        print(f"  [STEP 5 DATASET]     Only {len(dataset)} videos — skip (need 50+)")
        return None

    # Step 9 (EXPAND) determines the target before running the experiment
    target = step_get_comparison_target(graph)

    exp = step_run_experiment(key, dataset, tools, tool_id="pearson_r")
    if not exp:
        return None

    result = step_build_result(key, exp)

    indicator = {
        "key": key,
        "label": key.replace("_", " ").title(),
        "layer": metric_def.get("layer", "post"),
        "status": result["status"],
        "resolution_id": resolution_id,
        "depth": 1,
        "target": target,
        "metric_definition": metric_def,
        "dataset": dataset,
        "experiment": exp,
        "result": result,
        "connections": [target],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    step_update_graph(indicator, graph)

    print(f"  [DONE ✓]    r={result['primary_r']:+.3f} ({result['strength_label']} {result['direction']})")
    return indicator


# ── CLI commands ───────────────────────────────────────────────────────────
def cmd_status():
    indicators = load_json(INDICATORS_FILE, [])
    queue = load_json(QUEUE_FILE, DEFAULT_CANDIDATES)
    existing = {i["key"] for i in indicators}
    remaining = [k for k in queue if k not in existing]
    print(f"\nJarvis Pipeline Status")
    print(f"  Indicators completed : {len(indicators)}")
    print(f"  Queue remaining      : {len(remaining)} / {len(queue)}")
    if indicators:
        print(f"\n  Top 15 by |r|:")
        sorted_inds = sorted(indicators, key=lambda i: abs(i.get("result", {}).get("primary_r", 0)), reverse=True)
        for ind in sorted_inds[:15]:
            r = ind["result"]["primary_r"]
            sl = ind["result"]["strength_label"]
            print(f"    {ind['key']:40s} r={r:+.3f}  [{sl}]")


def cmd_graph():
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": []})
    print(f"\nGraph: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges")
    print("\nNodes:")
    for n in sorted(graph["nodes"], key=lambda n: (n.get("depth", 0), n.get("key", ""))):
        r = n.get("r_partial")
        r_str = f"r={r:+.3f}" if r is not None else "r=N/A"
        print(f"  [{n.get('type', '?'):10s}] depth={n.get('depth', 0)}  {n['key']:40s} {r_str}")
    print("\nEdges:")
    for e in graph["edges"]:
        print(f"  {e['from']:40s} → {e['to']}  (r={e['r']:+.3f})")


def cmd_run(n_to_run):
    indicators = load_json(INDICATORS_FILE, [])
    tools = load_json(TOOLS_FILE, [])
    resolutions = load_json(RESOLUTIONS_FILE, [])
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": []})
    queue = load_json(QUEUE_FILE, DEFAULT_CANDIDATES)
    existing_keys = {i["key"] for i in indicators}

    if not QUEUE_FILE.exists():
        save_json(QUEUE_FILE, DEFAULT_CANDIDATES)

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

        result = process_indicator(key, videos, existing_keys, resolutions, graph, tools)
        if result:
            indicators.append(result)
            exp_log = load_json(EXPERIMENTS_FILE, [])
            exp_log.append({
                "id": result["experiment"]["id"],
                "indicator_key": key,
                "tool_id": result["experiment"]["tool_id"],
                "tool_name": result["experiment"]["tool_name"],
                "target": result["target"],
                "parameters": result["experiment"]["parameters"],
                "outputs": result["experiment"]["outputs"],
                "n_videos": result["experiment"]["n_videos"],
                "status": result["result"]["status"],
                "ran_at": result["experiment"]["ran_at"],
            })
            save_json(EXPERIMENTS_FILE, exp_log)
            save_json(INDICATORS_FILE, indicators)
            existing_keys.add(key)
            ran += 1

    print(f"\n{'=' * 60}")
    print(f"RUN COMPLETE: {ran} indicators processed")
    cmd_status()


def cmd_single(key):
    indicators = load_json(INDICATORS_FILE, [])
    tools = load_json(TOOLS_FILE, [])
    resolutions = load_json(RESOLUTIONS_FILE, [])
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": []})
    existing_keys = {i["key"] for i in indicators}
    videos = load_videos()
    result = process_indicator(key, videos, existing_keys, resolutions, graph, tools)
    if result:
        indicators.append(result)
        exp_log = load_json(EXPERIMENTS_FILE, [])
        exp_log.append({
            "id": result["experiment"]["id"],
            "indicator_key": key,
            "tool_id": result["experiment"]["tool_id"],
            "tool_name": result["experiment"]["tool_name"],
            "target": result["target"],
            "parameters": result["experiment"]["parameters"],
            "outputs": result["experiment"]["outputs"],
            "n_videos": result["experiment"]["n_videos"],
            "status": result["result"]["status"],
            "ran_at": result["experiment"]["ran_at"],
        })
        save_json(EXPERIMENTS_FILE, exp_log)
        save_json(INDICATORS_FILE, indicators)
        print("Saved.")


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jarvis Pipeline")
    parser.add_argument("--run", type=int, metavar="N", help="Run N indicators from queue")
    parser.add_argument("--single", type=str, metavar="KEY", help="Run one indicator by key")
    parser.add_argument("--status", action="store_true", help="Show current status")
    parser.add_argument("--graph", action="store_true", help="Print graph nodes and edges")
    args = parser.parse_args()

    if args.status:
        cmd_status()
    elif args.run:
        cmd_run(args.run)
    elif args.single:
        cmd_single(args.single)
    elif args.graph:
        cmd_graph()
    else:
        parser.print_help()
