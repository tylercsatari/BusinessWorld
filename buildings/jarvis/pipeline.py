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
import re
import time
import subprocess
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.stats import pearsonr, spearmanr

# HTTP bridge for R2 persistence (when spawned by server)
JARVIS_API_URL = os.environ.get("JARVIS_API_URL")  # e.g. http://localhost:8002

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
    # ── NEW PRE-UPLOAD: Transcript / language ────────────────────────────
    "transcript_char_count": {
        "description": "Total character count of the transcript — raw verbosity signal.",
        "formula": "len(transcript)",
        "expected_range": "0 to 5000",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "avg_word_length": {
        "description": "Average word length in the transcript — vocabulary complexity proxy.",
        "formula": "mean(len(word) for word in transcript.split())",
        "expected_range": "2 to 10",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "unique_word_ratio": {
        "description": "Ratio of unique words to total words — lexical diversity.",
        "formula": "len(set(words)) / len(words)",
        "expected_range": "0 to 1",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "sentence_count": {
        "description": "Approximate sentence count — number of sentence-ending punctuation marks.",
        "formula": "count('.') + count('!') + count('?') in transcript",
        "expected_range": "0 to 100",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "exclamation_count": {
        "description": "Number of exclamation marks in the transcript — excitement / emphasis signal.",
        "formula": "transcript.count('!')",
        "expected_range": "0 to 30",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "uppercase_word_ratio": {
        "description": "Fraction of all-uppercase words (len>=2) in transcript — shouting / emphasis.",
        "formula": "count(uppercase words len>=2) / total words",
        "expected_range": "0 to 0.5",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "hook_question_count": {
        "description": "Number of questions in the hook segment — curiosity-gap opening.",
        "formula": "hook_transcript.count('?')",
        "expected_range": "0 to 5",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_word_ratio": {
        "description": "Fraction of total transcript words spoken in the hook — front-loading signal.",
        "formula": "hook_word_count / total_word_count",
        "expected_range": "0 to 1",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_char_count": {
        "description": "Character count of hook segment transcript — hook verbosity.",
        "formula": "len(hook_transcript)",
        "expected_range": "0 to 200",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "transcript_number_count": {
        "description": "Count of numeric tokens in transcript — data / specificity signal.",
        "formula": "count(re.findall(r'\\d+', transcript))",
        "expected_range": "0 to 30",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    # ── NEW PRE-UPLOAD: Structure / AI segments ──────────────────────────
    "hook_duration_pct": {
        "description": "Hook duration as percentage of total video duration.",
        "formula": "(hook_end - hook_start) / duration * 100",
        "expected_range": "0 to 50",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "avg_segment_duration_s": {
        "description": "Average segment duration in seconds — pacing uniformity.",
        "formula": "mean(seg.endTime - seg.startTime for seg in segments)",
        "expected_range": "0 to 60",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "longest_segment_duration_s": {
        "description": "Duration of the longest narrative segment — identifies dragging sections.",
        "formula": "max(seg.endTime - seg.startTime)",
        "expected_range": "0 to 60",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "shortest_segment_duration_s": {
        "description": "Duration of the shortest narrative segment — identifies rapid transitions.",
        "formula": "min(seg.endTime - seg.startTime)",
        "expected_range": "0 to 30",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "hook_position_s": {
        "description": "Start time of the hook segment in seconds — 0 means immediate hook.",
        "formula": "hook_segment.startTime",
        "expected_range": "0 to 10",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "climax_position_pct": {
        "description": "Position of climax segment as percentage of video duration — story arc shape.",
        "formula": "climax_segment.startTime / duration * 100",
        "expected_range": "0 to 100",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "has_climax_segment": {
        "description": "Whether AI identified a Climax segment (1=yes, 0=no) — presence of peak moment.",
        "formula": "int(any(label.lower() in ('climax', 'peak', 'payoff', 'reveal') for s in segments))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "hook_to_climax_gap_s": {
        "description": "Time gap from hook end to climax start — tension-building duration.",
        "formula": "climax.startTime - hook.endTime",
        "expected_range": "0 to 60",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    # ── NEW PRE-UPLOAD: Metadata ─────────────────────────────────────────
    "duration_s": {
        "description": "Raw video duration in seconds — untransformed length signal.",
        "formula": "metadata.duration",
        "expected_range": "1 to 600",
        "data_sources": ["metadata.duration"],
        "layer": "pre",
    },
    "title_char_count": {
        "description": "Character count of the video title — title length signal.",
        "formula": "len(metadata.title)",
        "expected_range": "0 to 200",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_word_count": {
        "description": "Word count of the video title.",
        "formula": "len(metadata.title.split())",
        "expected_range": "0 to 30",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_question_flag": {
        "description": "Whether the title contains a question mark (1=yes, 0=no).",
        "formula": "int('?' in title)",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_exclamation_flag": {
        "description": "Whether the title contains an exclamation mark (1=yes, 0=no).",
        "formula": "int('!' in title)",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_number_flag": {
        "description": "Whether the title contains a digit (1=yes, 0=no) — specificity / listicle signal.",
        "formula": "int(any(c.isdigit() for c in title))",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    # ── NEW PRE-UPLOAD: Visual / frame-derived ───────────────────────────
    "scene_change_rate": {
        "description": "Scene changes per second — edit pace normalized by duration.",
        "formula": "scene_change_count / duration_s",
        "expected_range": "0 to 2",
        "data_sources": ["frames[*].analysis.sceneDescription", "metadata.duration"],
        "layer": "pre",
    },
    "unique_scene_ratio": {
        "description": "Ratio of unique scene descriptions to total frames — visual variety.",
        "formula": "len(set(scene_descriptions)) / len(frames)",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "visual_technique_count_mean": {
        "description": "Average number of visual techniques mentioned per frame.",
        "formula": "mean(count_techniques(frame) for frame in frames)",
        "expected_range": "0 to 10",
        "data_sources": ["frames[*].analysis.visualTechniques"],
        "layer": "pre",
    },
    "close_up_frame_pct": {
        "description": "Percentage of frames with close-up shots — intimacy / focus signal.",
        "formula": "count(frames with 'close' in description or techniques) / total",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription", "frames[*].analysis.visualTechniques"],
        "layer": "pre",
    },
    "hand_presence_frame_pct": {
        "description": "Percentage of frames mentioning hands — gestural / demo content signal.",
        "formula": "count(frames with 'hand' in sceneDescription) / total",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "motion_word_frame_pct": {
        "description": "Percentage of frames with motion-related keywords — dynamism signal.",
        "formula": "count(frames with motion keywords in description) / total",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    # ── NEW: Speech Pacing (timed words) ─────────────────────────────────
    "opening_speech_rate_3s": {
        "description": "Words per second in the first 3 seconds. Optimal ~7.5 words in first 3s.",
        "formula": "count(words where timestamp < 3.0) / 3.0",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "opening_speech_rate_5s": {
        "description": "Words per second in the first 5 seconds — wider hook window.",
        "formula": "count(words where timestamp < 5.0) / 5.0",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "closing_speech_rate_5s": {
        "description": "Words per second in the final 5 seconds — deliberate delivery at climax.",
        "formula": "count(words where timestamp > duration - 5.0) / 5.0",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "speech_rate_q1": {
        "description": "Words per second in the first quarter of the video.",
        "formula": "count(words where timestamp < duration*0.25) / (duration*0.25)",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "speech_rate_q4": {
        "description": "Words per second in the final quarter of the video.",
        "formula": "count(words in last 25%) / (duration*0.25)",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "speech_rate_ratio_q4_q1": {
        "description": "Ending pace / opening pace. <1 means slowing down (good for climax).",
        "formula": "speech_rate_q4 / (speech_rate_q1 + 0.01)",
        "expected_range": "0 to 3",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "speech_acceleration": {
        "description": "Slope of speech rate over video — positive=speeding up, negative=slowing down.",
        "formula": "linregress of windowed speech rates over time",
        "expected_range": "-0.1 to 0.1",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "max_silence_gap_s": {
        "description": "Longest gap between consecutive words. Gaps >1.5s predict retention drops r=-0.73.",
        "formula": "max(words[i+1].timestamp - words[i].timestamp)",
        "expected_range": "0 to 10",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "silence_gap_count": {
        "description": "Number of inter-word gaps exceeding 1 second — dead air frequency.",
        "formula": "count(gaps > 1.0)",
        "expected_range": "0 to 20",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "silence_total_pct": {
        "description": "Total silence time (gaps >0.5s) as fraction of video duration.",
        "formula": "sum(gaps where gap > 0.5) / duration",
        "expected_range": "0 to 0.5",
        "data_sources": ["transcript.words", "metadata.duration"],
        "layer": "pre",
    },
    "opening_word_latency_s": {
        "description": "Seconds before the first word is spoken. Immediate speech = strong hook.",
        "formula": "words[0].timestamp",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "peak_speech_rate_3s": {
        "description": "Maximum words/sec in any 3-second sliding window — burst intensity.",
        "formula": "max(count(words in [t, t+3]) / 3 for all t)",
        "expected_range": "0 to 8",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "speech_tempo_range": {
        "description": "Max speech rate minus min speech rate across 5s windows — dynamic range.",
        "formula": "max(rate) - min(rate) across 5s windows",
        "expected_range": "0 to 6",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "avg_word_gap_s": {
        "description": "Mean time between consecutive words — overall delivery pace.",
        "formula": "mean(words[i+1].timestamp - words[i].timestamp)",
        "expected_range": "0 to 2",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    "word_density_variance": {
        "description": "Variance in words-per-second across 5s windows — pacing consistency.",
        "formula": "var(words_per_5s_windows)",
        "expected_range": "0 to 5",
        "data_sources": ["transcript.words"],
        "layer": "pre",
    },
    # ── NEW: Sensory & Technical Language ─────────────────────────────────
    "sensory_word_density": {
        "description": "Fraction of transcript words that are sensory/body words. Strongest positive language signal.",
        "formula": "count(sensory_words) / total_words",
        "expected_range": "0 to 0.15",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "technical_word_density": {
        "description": "Fraction of transcript words that are technical/material words. Strongest negative language signal.",
        "formula": "count(technical_words) / total_words",
        "expected_range": "0 to 0.15",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "sensory_technical_ratio": {
        "description": "Ratio of sensory words to technical words. Higher = more engaging language.",
        "formula": "count(sensory_words) / (count(technical_words) + 1)",
        "expected_range": "0 to 20",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "hook_sensory_word_count": {
        "description": "Number of sensory/body words in the hook segment.",
        "formula": "count(sensory_words in hook_transcript)",
        "expected_range": "0 to 10",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "body_sensation_word_pct": {
        "description": "Percentage of words related to body sensations.",
        "formula": "count(body_words) / total_words * 100",
        "expected_range": "0 to 10",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    # ── NEW: Pivot & Transition Words ────────────────────────────────────
    "pivot_word_count": {
        "description": "Count of pivot/transition words (but, however, wait, instead, etc). r=+0.26 vs keep.",
        "formula": "count(pivot_words in transcript)",
        "expected_range": "0 to 15",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "pivot_word_density": {
        "description": "Pivot words per 100 transcript words — normalized for length.",
        "formula": "count(pivot_words) / total_words * 100",
        "expected_range": "0 to 8",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "hook_pivot_word_flag": {
        "description": "Whether the hook contains at least one pivot word (1=yes, 0=no).",
        "formula": "int(any(pivot_word in hook_transcript))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    # ── NEW: Vocabulary Features ─────────────────────────────────────────
    "short_word_ratio": {
        "description": "Fraction of words with 1-3 characters — simplicity signal. Vocab universality r=+0.323.",
        "formula": "count(words where len <= 3) / total_words",
        "expected_range": "0 to 0.8",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "long_word_ratio": {
        "description": "Fraction of words with 8+ characters — complexity/jargon signal.",
        "formula": "count(words where len >= 8) / total_words",
        "expected_range": "0 to 0.3",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "hapax_legomena_ratio": {
        "description": "Fraction of words appearing exactly once — vocabulary uniqueness.",
        "formula": "count(words appearing once) / total_words",
        "expected_range": "0 to 1",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "first_person_ratio": {
        "description": "Fraction of first-person pronouns (I, me, my, mine, myself).",
        "formula": "count(first_person_words) / total_words",
        "expected_range": "0 to 0.15",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "second_person_ratio": {
        "description": "Fraction of second-person pronouns (you, your, yours). Research shows 'you' may hurt keep.",
        "formula": "count(second_person_words) / total_words",
        "expected_range": "0 to 0.1",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "action_verb_density": {
        "description": "Fraction of words that are action/physical verbs.",
        "formula": "count(action_verbs) / total_words",
        "expected_range": "0 to 0.1",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "superlative_count": {
        "description": "Number of superlative words — intensity signal.",
        "formula": "count(superlatives in transcript)",
        "expected_range": "0 to 10",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    "comparison_word_count": {
        "description": "Count of comparison words (vs, than, better, worse, more, less).",
        "formula": "count(comparison_words)",
        "expected_range": "0 to 15",
        "data_sources": ["transcript"],
        "layer": "pre",
    },
    # ── NEW: Hook Advanced ───────────────────────────────────────────────
    "hook_speech_rate_wps": {
        "description": "Words per second within the hook segment — hook delivery pace.",
        "formula": "hook_word_count / hook_duration_s",
        "expected_range": "0 to 6",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_unique_word_ratio": {
        "description": "Lexical diversity within the hook segment.",
        "formula": "len(set(hook_words)) / len(hook_words)",
        "expected_range": "0 to 1",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_action_verb_count": {
        "description": "Number of action verbs in the hook — immediate activity signal.",
        "formula": "count(action_verbs in hook_transcript)",
        "expected_range": "0 to 5",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_sentence_count": {
        "description": "Number of sentences in the hook segment.",
        "formula": "count(sentence_endings in hook_transcript)",
        "expected_range": "0 to 5",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_avg_word_length": {
        "description": "Average word length in hook — vocabulary complexity.",
        "formula": "mean(len(word) for word in hook_words)",
        "expected_range": "2 to 10",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    "hook_number_count": {
        "description": "Number of numeric tokens in the hook — specificity in opening.",
        "formula": "count(re.findall(r'\\d+', hook_transcript))",
        "expected_range": "0 to 5",
        "data_sources": ["aiAnalysis.segments", "transcript"],
        "layer": "pre",
    },
    # ── NEW: Narrative Structure Advanced ─────────────────────────────────
    "segment_duration_variance": {
        "description": "Variance in segment durations — pacing uniformity.",
        "formula": "var(segment_durations)",
        "expected_range": "0 to 500",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "segment_count_per_minute": {
        "description": "Segments per minute — structural density normalized by length.",
        "formula": "segment_count / (duration / 60)",
        "expected_range": "0 to 20",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "has_setup_segment": {
        "description": "Whether AI identified a Setup segment (1=yes, 0=no).",
        "formula": "int(any(label.lower() == 'setup'))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "has_conclusion_segment": {
        "description": "Whether AI identified a Conclusion segment (1=yes, 0=no).",
        "formula": "int(any(label.lower() == 'conclusion'))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "segment_type_count": {
        "description": "Number of unique segment labels — narrative complexity.",
        "formula": "len(set(labels))",
        "expected_range": "1 to 8",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "narrative_arc_completeness": {
        "description": "Count of canonical arc elements present (hook, setup, main, climax, conclusion). 3/4=13M avg.",
        "formula": "count(canonical_labels present)",
        "expected_range": "0 to 5",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "climax_late_flag": {
        "description": "Whether climax starts in the last 30% of the video (1=yes, 0=no).",
        "formula": "int(climax_start > duration * 0.7)",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "last_segment_duration_pct": {
        "description": "Final segment as percentage of total duration — ending weight.",
        "formula": "last_segment_duration / duration * 100",
        "expected_range": "0 to 50",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "first_segment_duration_pct": {
        "description": "First segment as percentage of total duration — opening weight.",
        "formula": "first_segment_duration / duration * 100",
        "expected_range": "0 to 50",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    "segment_length_ratio_max_min": {
        "description": "Longest segment / shortest — pacing imbalance.",
        "formula": "max(durations) / (min(durations) + 0.1)",
        "expected_range": "1 to 20",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "body_segment_count": {
        "description": "Segments that are not Hook or Conclusion — middle content density.",
        "formula": "count(segments not hook/conclusion)",
        "expected_range": "0 to 8",
        "data_sources": ["aiAnalysis.segments"],
        "layer": "pre",
    },
    "hook_conclusion_combined_pct": {
        "description": "Hook and conclusion combined as percentage of total duration.",
        "formula": "(hook_dur + conclusion_dur) / duration * 100",
        "expected_range": "0 to 60",
        "data_sources": ["aiAnalysis.segments", "metadata.duration"],
        "layer": "pre",
    },
    # ── NEW: Title & Metadata Advanced ───────────────────────────────────
    "title_all_caps_word_count": {
        "description": "Number of ALL CAPS words in the title.",
        "formula": "count(title words where isupper and len>=2)",
        "expected_range": "0 to 10",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_emoji_flag": {
        "description": "Whether the title contains any emoji character (1=yes, 0=no).",
        "formula": "int(has_emoji(title))",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_contains_making": {
        "description": "Whether the title contains 'making' or 'made'. Strongest concept keyword ($24M avg).",
        "formula": "int('making' in title.lower() or 'made' in title.lower())",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_avg_word_length": {
        "description": "Average word length in the title.",
        "formula": "mean(len(word) for word in title_words)",
        "expected_range": "2 to 12",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "title_starts_with_action": {
        "description": "Whether the title starts with an action/gerund word (1=yes, 0=no).",
        "formula": "int(title_words[0] ends with 'ing' or is action verb)",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.title"],
        "layer": "pre",
    },
    "duration_optimal_flag": {
        "description": "Whether duration falls in the 40-55 second sweet spot.",
        "formula": "int(40 <= duration_s <= 55)",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.duration"],
        "layer": "pre",
    },
    "duration_sweetspot_distance": {
        "description": "Absolute seconds away from 52s sweet spot. Lower = better.",
        "formula": "abs(duration_s - 52)",
        "expected_range": "0 to 60",
        "data_sources": ["metadata.duration"],
        "layer": "pre",
    },
    "description_word_count": {
        "description": "Word count of video description.",
        "formula": "len(description.split())",
        "expected_range": "0 to 500",
        "data_sources": ["metadata.description"],
        "layer": "pre",
    },
    "is_vertical": {
        "description": "Whether the video is vertical format (1=yes, 0=no).",
        "formula": "int(metadata.isVertical)",
        "expected_range": "0 or 1",
        "data_sources": ["metadata.isVertical"],
        "layer": "pre",
    },
    "upload_month": {
        "description": "Month of upload (1-12) — seasonal effects.",
        "formula": "int(uploadDate[4:6])",
        "expected_range": "1 to 12",
        "data_sources": ["metadata.uploadDate"],
        "layer": "pre",
    },
    # ── NEW: Visual Frame Advanced ───────────────────────────────────────
    "opening_frame_has_text": {
        "description": "Whether the first frame has a text overlay (1=yes, 0=no).",
        "formula": "int('text' in frames[0].visualTechniques.lower())",
        "expected_range": "0 or 1",
        "data_sources": ["frames[0].analysis.visualTechniques"],
        "layer": "pre",
    },
    "opening_frame_has_face": {
        "description": "Whether the first frame shows a face (1=yes, 0=no).",
        "formula": "int('face' in frames[0].sceneDescription.lower())",
        "expected_range": "0 or 1",
        "data_sources": ["frames[0].analysis.sceneDescription"],
        "layer": "pre",
    },
    "action_frame_pct": {
        "description": "Percentage of frames with action/physical activity. Action frames enriched 1.9x at peaks.",
        "formula": "count(frames with action keywords) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "workshop_frame_pct": {
        "description": "Percentage of frames showing workshop/tools setting.",
        "formula": "count(frames with workshop keywords) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "outdoor_frame_pct": {
        "description": "Percentage of frames showing outdoor scenes. Outdoor 0.68x at peaks.",
        "formula": "count(frames with outdoor keywords) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "face_alone_pct": {
        "description": "Frames with face but NO action — talking head trap signal.",
        "formula": "count(face AND NOT action frames) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "face_with_action_pct": {
        "description": "Frames with BOTH face AND action — positive signal.",
        "formula": "count(face AND action frames) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "object_focus_pct": {
        "description": "Frames focused on objects rather than people.",
        "formula": "count(frames without face) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    "text_overlay_early_pct": {
        "description": "Text overlay presence in first 25% of frames.",
        "formula": "count(first_25pct with text) / count(first_25pct)",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.visualTechniques"],
        "layer": "pre",
    },
    "dramatic_frame_pct": {
        "description": "Frames with dramatic/intense descriptions. Dramatic enriched 1.8x at peaks.",
        "formula": "count(dramatic frames) / total_frames",
        "expected_range": "0 to 1",
        "data_sources": ["frames[*].analysis.sceneDescription"],
        "layer": "pre",
    },
    # ── NEW: AI Analysis Features ────────────────────────────────────────
    "idea_word_count": {
        "description": "Word count of the AI-generated video idea.",
        "formula": "len(videoIdea.split())",
        "expected_range": "1 to 30",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    "idea_char_count": {
        "description": "Character count of the video idea.",
        "formula": "len(videoIdea)",
        "expected_range": "1 to 200",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    "summary_word_count": {
        "description": "Word count of the AI-generated video summary.",
        "formula": "len(summary.split())",
        "expected_range": "10 to 300",
        "data_sources": ["aiAnalysis.summary"],
        "layer": "pre",
    },
    "idea_question_flag": {
        "description": "Whether the video idea contains a question mark (1=yes, 0=no).",
        "formula": "int('?' in videoIdea)",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    "idea_number_flag": {
        "description": "Whether the video idea contains a digit.",
        "formula": "int(any(c.isdigit() for c in videoIdea))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    "idea_contains_making": {
        "description": "Whether the idea contains 'making'/'build' concept keywords.",
        "formula": "int(any(w in idea.lower() for w in making_words))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    "idea_contains_indestructible": {
        "description": "Whether the idea contains indestructible/unbreakable keywords.",
        "formula": "int(any(w in idea.lower() for w in indestructible_words))",
        "expected_range": "0 or 1",
        "data_sources": ["aiAnalysis.videoIdea"],
        "layer": "pre",
    },
    # ── CRAZY Pre-Upload Indicators ────────────────────────────────────
    "tension_word_density": {
        "description": "Density of tension/conflict words (but, suddenly, impossible) per 100 words.",
        "formula": "count(tension_words) / word_count * 100",
        "expected_range": "0 to 5", "data_sources": ["transcript"], "layer": "pre",
    },
    "resolution_word_density": {
        "description": "Density of resolution/payoff words (finally, turns out, worked) per 100 words.",
        "formula": "count(resolution_words) / word_count * 100",
        "expected_range": "0 to 5", "data_sources": ["transcript"], "layer": "pre",
    },
    "tension_resolution_ratio": {
        "description": "Ratio of tension to resolution words — narrative arc quality.",
        "formula": "tension_count / (resolution_count + 1)",
        "expected_range": "0 to 10", "data_sources": ["transcript"], "layer": "pre",
    },
    "emotional_arc_swing": {
        "description": "Max tension-resolution swing across transcript quarters — emotional range.",
        "formula": "max(quarter_tension_scores) - min(quarter_tension_scores)",
        "expected_range": "0 to 20", "data_sources": ["transcript"], "layer": "pre",
    },
    "hook_tension_density": {
        "description": "Tension word density specifically in the hook — immediate conflict signal.",
        "formula": "count(hook_tension_words) / hook_word_count * 100",
        "expected_range": "0 to 15", "data_sources": ["transcript", "aiAnalysis.segments"], "layer": "pre",
    },
    "repeated_phrase_count": {
        "description": "Number of bigrams repeated 3+ times — verbal callbacks and catchphrases.",
        "formula": "count(bigrams with freq >= 3)",
        "expected_range": "0 to 20", "data_sources": ["transcript"], "layer": "pre",
    },
    "vocabulary_richness_yule_k": {
        "description": "Yule's K vocabulary richness measure. Lower = richer, more diverse vocabulary.",
        "formula": "10000 * (M2 - N) / N^2",
        "expected_range": "0 to 500", "data_sources": ["transcript"], "layer": "pre",
    },
    "question_early_ratio": {
        "description": "Fraction of questions appearing in first 25% of transcript — front-loaded curiosity.",
        "formula": "early_questions / (total_questions + 1)",
        "expected_range": "0 to 1", "data_sources": ["transcript"], "layer": "pre",
    },
    "open_loop_count": {
        "description": "Count of open loops: questions + suspense phrases (but first, what if, wait).",
        "formula": "question_marks + suspense_phrase_count",
        "expected_range": "0 to 30", "data_sources": ["transcript"], "layer": "pre",
    },
    "cliffhanger_density": {
        "description": "Suspense/cliffhanger phrases per 100 words.",
        "formula": "cliffhanger_phrases / word_count * 100",
        "expected_range": "0 to 3", "data_sources": ["transcript"], "layer": "pre",
    },
    "visual_monotony_score": {
        "description": "Fraction of consecutive frames with same scene — visual repetitiveness.",
        "formula": "consecutive_same_frames / (total_frames - 1)",
        "expected_range": "0 to 1", "data_sources": ["frames"], "layer": "pre",
    },
    "visual_variety_entropy": {
        "description": "Shannon entropy of scene descriptions — visual information richness.",
        "formula": "H = -sum(p_i * log2(p_i)) for scene types",
        "expected_range": "0 to 6", "data_sources": ["frames"], "layer": "pre",
    },
    "face_intro_delay_frames": {
        "description": "Number of frames before first face appears — immediate vs slow face reveal.",
        "formula": "index of first face frame",
        "expected_range": "0 to 600", "data_sources": ["frames"], "layer": "pre",
    },
    "visual_pacing_variance": {
        "description": "Variance of scene run lengths — chaotic vs steady visual pacing.",
        "formula": "var(consecutive_same_scene_runs)",
        "expected_range": "0 to 100", "data_sources": ["frames"], "layer": "pre",
    },
    "golden_ratio_segment_flag": {
        "description": "Whether any segment boundary falls at the golden ratio (61.8%) of video.",
        "formula": "int(any segment start within 5% of 61.8% mark)",
        "expected_range": "0 or 1", "data_sources": ["aiAnalysis.segments", "metadata.duration"], "layer": "pre",
    },
    "hook_to_body_word_overlap": {
        "description": "Word overlap between hook and body — semantic coherence/foreshadowing.",
        "formula": "len(hook_words & body_words) / len(hook_words)",
        "expected_range": "0 to 1", "data_sources": ["transcript", "aiAnalysis.segments"], "layer": "pre",
    },
    "title_uniqueness_score": {
        "description": "Number of uncommon (>6 char) words in title.",
        "formula": "count(title words with len > 6)",
        "expected_range": "0 to 10", "data_sources": ["metadata.title"], "layer": "pre",
    },
    "title_curiosity_gap_score": {
        "description": "Curiosity triggers in title: this, what, numbers, ellipsis, how.",
        "formula": "count(curiosity_triggers) + count(digits)",
        "expected_range": "0 to 10", "data_sources": ["metadata.title"], "layer": "pre",
    },
    "title_power_word_count": {
        "description": "Count of proven viral power words in title (insane, impossible, extreme, etc).",
        "formula": "count(power_words in title)",
        "expected_range": "0 to 5", "data_sources": ["metadata.title"], "layer": "pre",
    },
    "words_per_scene": {
        "description": "Average transcript words per visual scene — information-per-scene density.",
        "formula": "word_count / scene_count",
        "expected_range": "10 to 500", "data_sources": ["transcript", "frames"], "layer": "pre",
    },
    "speech_silence_ratio": {
        "description": "Ratio of speaking time to silence time — pacing.",
        "formula": "speech_time / (silence_time + 0.1)",
        "expected_range": "0 to 50", "data_sources": ["transcript.words", "metadata.duration"], "layer": "pre",
    },
    "transcript_readability": {
        "description": "Flesch reading ease score — how accessible is the language?",
        "formula": "206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)",
        "expected_range": "-50 to 120", "data_sources": ["transcript"], "layer": "pre",
    },
    "energy_word_density": {
        "description": "High-energy/intensity words per 100 words (insane, epic, destroy, etc).",
        "formula": "count(energy_words) / word_count * 100",
        "expected_range": "0 to 5", "data_sources": ["transcript"], "layer": "pre",
    },
    "concept_density": {
        "description": "Unique capitalized words (nouns/names) per sentence — information density.",
        "formula": "unique_capitalized_words / sentence_count",
        "expected_range": "0 to 20", "data_sources": ["transcript"], "layer": "pre",
    },
    "frame_text_variety": {
        "description": "Number of unique visual techniques mentioned across all frames.",
        "formula": "len(unique_techniques_set)",
        "expected_range": "0 to 50", "data_sources": ["frames"], "layer": "pre",
    },
    "description_link_count": {
        "description": "Number of URLs in video description — promotion effort proxy.",
        "formula": "count(urls in description)",
        "expected_range": "0 to 20", "data_sources": ["metadata.description"], "layer": "pre",
    },
    "description_hashtag_count": {
        "description": "Number of hashtags in video description.",
        "formula": "count(#tags in description)",
        "expected_range": "0 to 30", "data_sources": ["metadata.description"], "layer": "pre",
    },
    # ── NEW: Retention Curve Advanced ────────────────────────────────────
    "hook_payoff_gap": {
        "description": "Final 5% retention minus hook retention. NEGATIVE = over-delivery = 9x views.",
        "formula": "mean(curve[95:100]) - curve[10].retention",
        "expected_range": "-1 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "end_recovery_score": {
        "description": "Mean retention above linear baseline at 80-95%. Ending is 8.5x more important than hook.",
        "formula": "mean(curve[80:95] - baseline[80:95])",
        "expected_range": "-0.3 to 0.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "momentum_zone_length": {
        "description": "Longest consecutive run above baseline — sustained engagement. Consistency beats spikes.",
        "formula": "max(consecutive_above_baseline_runs)",
        "expected_range": "0 to 100",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_recovery_count": {
        "description": "Number of times retention rises after a drop — resilience signal.",
        "formula": "count(rises after drops)",
        "expected_range": "0 to 20",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "above_baseline_area": {
        "description": "Total area between retention curve and linear decay above baseline.",
        "formula": "sum(max(0, curve[i] - baseline[i]))",
        "expected_range": "0 to 50",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "below_baseline_area": {
        "description": "Total area below the linear decay baseline.",
        "formula": "sum(max(0, baseline[i] - curve[i]))",
        "expected_range": "0 to 50",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "late_drop_severity": {
        "description": "Average drop magnitude in the last 40%. Late drops are fatal.",
        "formula": "mean(drops in curve[60:100])",
        "expected_range": "0 to 0.1",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_concavity": {
        "description": "Mean second derivative — concave up (decelerating loss) vs concave down.",
        "formula": "mean(curve[i+1]+curve[i-1]-2*curve[i])",
        "expected_range": "-0.01 to 0.01",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "retention_quartile_spread": {
        "description": "Mean retention Q4 / mean retention Q1 — how much retention degrades.",
        "formula": "mean(curve[75:100]) / (mean(curve[0:25]) + 0.01)",
        "expected_range": "0 to 1.5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    "early_late_drop_ratio": {
        "description": "Drop magnitude first 30% vs last 30%. Later drops 2.15x steeper.",
        "formula": "mean_drop_late / (mean_drop_early + 0.001)",
        "expected_range": "0 to 5",
        "data_sources": ["analytics.retentionCurve"],
        "layer": "post",
    },
    # ── NEW: Post-Upload Analytics Advanced ──────────────────────────────
    "engagement_rate": {
        "description": "Total engagements per 1000 views. WARNING: may be partially circular.",
        "formula": "(likes + comments + shares) / totalViews * 1000",
        "expected_range": "0 to 500",
        "data_sources": ["analytics.likes", "analytics.comments", "analytics.shares", "analytics.totalViews"],
        "layer": "post",
    },
    "like_to_comment_ratio": {
        "description": "Likes / comments — passive vs active engagement balance.",
        "formula": "likes / (comments + 1)",
        "expected_range": "0 to 1000",
        "data_sources": ["analytics.likes", "analytics.comments"],
        "layer": "post",
    },
    "sub_nonsub_retention_gap": {
        "description": "Subscriber avg% viewed minus non-subscriber — subscriber advantage.",
        "formula": "subscriberAvgPercent - nonSubscriberAvgPercent",
        "expected_range": "-20 to 20",
        "data_sources": ["analytics.subscriberAvgPercent", "analytics.nonSubscriberAvgPercent"],
        "layer": "post",
    },
    "retention_variation_raw": {
        "description": "Direct analytics.retentionVariation value.",
        "formula": "analytics.retentionVariation",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.retentionVariation"],
        "layer": "post",
    },
    "avg_percent_viewed": {
        "description": "Direct analytics.avgPercentViewed — completion proxy.",
        "formula": "analytics.avgPercentViewed",
        "expected_range": "0 to 100",
        "data_sources": ["analytics.avgPercentViewed"],
        "layer": "post",
    },
    "engaged_view_rate": {
        "description": "Engaged views / total views — quality viewer signal.",
        "formula": "engagedViews / totalViews",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.engagedViews", "analytics.totalViews"],
        "layer": "post",
    },
    "sub_view_fraction": {
        "description": "Subscriber views / total views — base audience dependence.",
        "formula": "subscriberViews / totalViews",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.subscriberViews", "analytics.totalViews"],
        "layer": "post",
    },
    "view_day1_share": {
        "description": "Day 1 views as fraction of first 7 days — initial push strength.",
        "formula": "dailyViews[0] / sum(dailyViews[0:7])",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "view_week3_week1_ratio": {
        "description": "Week 3 / Week 1 views — long tail signal.",
        "formula": "sum(dailyViews[14:21]) / (sum(dailyViews[0:7]) + 1)",
        "expected_range": "0 to 2",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "daily_views_entropy": {
        "description": "Shannon entropy of daily views distribution — concentrated vs spread.",
        "formula": "entropy(daily_views_normalized)",
        "expected_range": "0 to 8",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "daily_views_gini": {
        "description": "Gini coefficient of daily views — inequality of distribution over time.",
        "formula": "gini(daily_views)",
        "expected_range": "0 to 1",
        "data_sources": ["analytics.dailyViews"],
        "layer": "post",
    },
    "stayed_to_watch_rate": {
        "description": "Direct swipeRatio.stayedToWatch — initial hook conversion.",
        "formula": "analytics.swipeRatio.stayedToWatch",
        "expected_range": "0 to 100",
        "data_sources": ["analytics.swipeRatio"],
        "layer": "post",
    },
    "avg_view_duration_s": {
        "description": "Direct analytics.avgViewDuration — raw watch time.",
        "formula": "analytics.avgViewDuration",
        "expected_range": "0 to 300",
        "data_sources": ["analytics.avgViewDuration"],
        "layer": "post",
    },
}

# ── Word lists for language-based indicators ─────────────────────────────
SENSORY_WORDS = {
    "curious", "painful", "bigger", "stomach", "numb", "skin", "impact", "foot",
    "sleep", "feel", "touch", "hot", "cold", "heavy", "loud", "sharp", "soft",
    "hard", "wet", "taste", "smell", "burn", "sting", "freeze", "warm", "squeeze",
    "pull", "push", "press", "crush", "stretch", "bend", "twist", "crack", "snap",
    "pop", "rip", "tear", "bite", "chew", "swallow", "grab", "hold", "lift",
    "drop", "throw", "hit", "punch", "kick", "slap", "hurt", "pain", "ache",
    "tingle", "scratch", "poke", "stab", "smash", "slam", "bang", "explode",
    "shatter", "melt", "boil", "sizzle", "crunch", "squish", "sticky",
}
TECHNICAL_WORDS = {
    "plastic", "solid", "fiber", "materials", "carbon", "bulletproof", "structure",
    "engineering", "design", "mechanism", "component", "assembly", "specification",
    "measurement", "calibration", "dimensional", "tolerance", "composite", "polymer",
    "alloy", "tensile", "modulus", "density", "coefficient", "thermal", "conductivity",
    "molecular", "chemical", "substrate", "laminate", "resin", "epoxy", "filament",
    "hydraulic", "pneumatic", "electrode", "circuit", "voltage", "amperage",
}
PIVOT_WORDS = {
    "but", "however", "wait", "instead", "actually", "except", "although",
    "surprisingly", "unfortunately", "problem", "twist", "unless", "though",
    "yet", "suddenly", "imagine", "honestly", "crazy", "insane",
}
ACTION_VERBS = {
    "making", "building", "testing", "breaking", "cutting", "crushing", "shooting",
    "hitting", "throwing", "dropping", "smashing", "creating", "crafting",
    "assembling", "installing", "removing", "destroying", "eating", "drinking",
    "cooking", "baking", "mixing", "pouring", "filling", "emptying", "opening",
    "closing", "turning", "spinning", "rolling", "flipping", "jumping", "running",
    "climbing", "lifting", "carrying", "pulling", "pushing", "digging", "drilling",
}
BODY_SENSATION_WORDS = {
    "feel", "touch", "hurt", "pain", "taste", "smell", "burn", "sting", "itch",
    "tingle", "numb", "ache", "sore", "warm", "cold", "hot", "freeze", "sweat",
    "shiver", "pulse", "throb", "cramp", "dizzy", "sick", "stomach", "skin",
    "muscle", "bone", "blood", "breath", "heartbeat",
}
FIRST_PERSON = {"i", "me", "my", "mine", "myself"}
SECOND_PERSON = {"you", "your", "yours", "yourself", "yourselves"}
SUPERLATIVES = {
    "biggest", "smallest", "fastest", "slowest", "strongest", "weakest",
    "hardest", "softest", "heaviest", "lightest", "longest", "shortest",
    "tallest", "thickest", "thinnest", "loudest", "quietest", "hottest",
    "coldest", "best", "worst", "most", "least", "maximum", "minimum",
    "ultimate", "extreme", "insane", "impossible", "unbelievable",
}
COMPARISON_WORDS = {"vs", "versus", "than", "better", "worse", "more", "less", "compared", "difference", "between"}
MAKING_CONCEPT_WORDS = {"making", "made", "build", "built", "creating", "created", "craft", "crafted", "construct"}
INDESTRUCTIBLE_CONCEPT_WORDS = {"indestructible", "unbreakable", "bulletproof", "strongest", "invincible", "impenetrable"}

AUTONOMOUS_RUNS_FILE = JARVIS_DIR / "autonomous_runs.json"
AUTONOMOUS_PROGRESS_FILE = JARVIS_DIR / "autonomous_progress.json"
DERIVED_EXPERIMENTS_FILE = JARVIS_DIR / "derived_experiments.json"

# Map local file paths to R2-bridged data names (used by HTTP bridge)
_FILE_TO_R2_NAME = None  # lazily built after all paths are defined

def _get_r2_name(filepath):
    """Map a local Jarvis JSON path to its canonical R2 name, or None."""
    global _FILE_TO_R2_NAME
    if _FILE_TO_R2_NAME is None:
        _FILE_TO_R2_NAME = {
            str(TOOLS_FILE): "tools",
            str(RESOLUTIONS_FILE): "resolutions",
            str(GRAPH_FILE): "graph",
            str(INDICATORS_FILE): "indicators",
            str(EXPERIMENTS_FILE): "experiments_log",
            str(QUEUE_FILE): "candidate_queue",
            str(AUTONOMOUS_RUNS_FILE): "autonomous_runs",
            str(AUTONOMOUS_PROGRESS_FILE): "autonomous_progress",
            str(DERIVED_EXPERIMENTS_FILE): "derived_experiments",
        }
    return _FILE_TO_R2_NAME.get(str(filepath))


def _init_progress(run_id, requested_iterations, llm_candidates):
    """Initialize the live progress snapshot file."""
    prog = {
        "active": True,
        "run_id": run_id,
        "mode": "hybrid_auto",
        "started_at": now_iso(),
        "updated_at": now_iso(),
        "finished_at": None,
        "requested_iterations": requested_iterations,
        "attempted": 0,
        "completed": 0,
        "failures": 0,
        "llm_proposed": 0,
        "llm_completed": 0,
        "no_signal_streak": 0,
        "stop_reason": None,
        "current_candidate": None,
        "last_completed_candidate": None,
        "last_completed_r": None,
        "recent_events": [],
    }
    save_json(AUTONOMOUS_PROGRESS_FILE, prog)
    return prog


def _update_progress(prog, **kwargs):
    """Update progress snapshot fields and write to disk."""
    prog.update(kwargs)
    prog["updated_at"] = now_iso()
    try:
        save_json(AUTONOMOUS_PROGRESS_FILE, prog)
    except Exception:
        pass  # best-effort, don't crash the run


def _append_progress_event(prog, event):
    """Append an event to recent_events, keeping last 20."""
    event["ts"] = now_iso()
    prog.setdefault("recent_events", []).append(event)
    prog["recent_events"] = prog["recent_events"][-20:]


def _finish_progress(prog, stop_reason):
    """Mark the progress file as finished."""
    _update_progress(prog,
                     active=False,
                     finished_at=now_iso(),
                     stop_reason=stop_reason,
                     current_candidate=None)

# ── Autonomous candidate generation ───────────────────────────────────────
# Candidate families: each produces a list of (key, definition) pairs.
# Keys follow patterns that extract_metric can parse via regex.

RETENTION_POINTS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95]
RETENTION_WINDOWS = [
    (0, 5), (0, 10), (5, 15), (10, 20), (20, 30), (30, 40), (40, 50),
    (50, 60), (60, 70), (70, 80), (80, 90), (90, 100), (95, 100),
]
DAILY_VIEWS_WINDOWS = [(0, 1), (0, 3), (0, 7), (7, 14), (14, 30)]
DAILY_VIEWS_RATIOS = [
    ("week2", "week1", 7, 14, 0, 7),
    ("month1", "week1", 0, 30, 0, 7),
    ("week3", "week2", 14, 21, 7, 14),
]


def generate_autonomous_candidates():
    """Generate all template-based candidate keys deterministically."""
    candidates = []

    # 1. Retention point: retention at a specific percentile
    for pct in RETENTION_POINTS:
        candidates.append(f"retention_pct_{pct}")

    # 2. Retention window mean
    for lo, hi in RETENTION_WINDOWS:
        candidates.append(f"retention_mean_{lo}_{hi}")

    # 3. Retention window slope
    for lo, hi in RETENTION_WINDOWS:
        if hi - lo >= 5:  # need at least 5 points for slope
            candidates.append(f"retention_slope_{lo}_{hi}")

    # 4. Retention window volatility (std dev)
    for lo, hi in RETENTION_WINDOWS:
        if hi - lo >= 3:
            candidates.append(f"retention_volatility_{lo}_{hi}")

    # 5. Daily views log windows
    for d0, d1 in DAILY_VIEWS_WINDOWS:
        candidates.append(f"views_log_days_{d0}_{d1}")

    # 6. Daily views ratios
    for name_num, name_den, n0, n1, d0, d1 in DAILY_VIEWS_RATIOS:
        candidates.append(f"views_ratio_{name_num}_vs_{name_den}")

    # 7. Transcript features (static — already in METRIC_DEFINITIONS but ensure coverage)
    for k in ["transcript_word_count", "question_count", "speech_rate_wps"]:
        candidates.append(k)

    # 7b. NEW pre-upload: transcript / language
    for k in ["transcript_char_count", "avg_word_length", "unique_word_ratio",
              "sentence_count", "exclamation_count", "uppercase_word_ratio",
              "hook_question_count", "hook_word_ratio", "hook_char_count",
              "transcript_number_count"]:
        candidates.append(k)

    # 8. Frame features
    for k in ["face_frame_pct", "text_overlay_frame_pct", "scene_change_count"]:
        candidates.append(k)

    # 8b. NEW pre-upload: visual / frame-derived
    for k in ["scene_change_rate", "unique_scene_ratio", "visual_technique_count_mean",
              "close_up_frame_pct", "hand_presence_frame_pct", "motion_word_frame_pct"]:
        candidates.append(k)

    # 8c. NEW pre-upload: structure / AI segments
    for k in ["hook_duration_pct", "avg_segment_duration_s", "longest_segment_duration_s",
              "shortest_segment_duration_s", "hook_position_s", "climax_position_pct",
              "has_climax_segment", "hook_to_climax_gap_s"]:
        candidates.append(k)

    # 8d. NEW pre-upload: metadata
    for k in ["duration_s", "title_char_count", "title_word_count",
              "title_question_flag", "title_exclamation_flag", "title_number_flag"]:
        candidates.append(k)

    # 9. NEW: Speech pacing (timed words)
    for k in ["opening_speech_rate_3s", "opening_speech_rate_5s", "closing_speech_rate_5s",
              "speech_rate_q1", "speech_rate_q4", "speech_rate_ratio_q4_q1",
              "speech_acceleration", "max_silence_gap_s", "silence_gap_count",
              "silence_total_pct", "opening_word_latency_s", "peak_speech_rate_3s",
              "speech_tempo_range", "avg_word_gap_s", "word_density_variance"]:
        candidates.append(k)

    # 10. NEW: Sensory & technical language
    for k in ["sensory_word_density", "technical_word_density", "sensory_technical_ratio",
              "hook_sensory_word_count", "body_sensation_word_pct"]:
        candidates.append(k)

    # 11. NEW: Pivot & transition words
    for k in ["pivot_word_count", "pivot_word_density", "hook_pivot_word_flag"]:
        candidates.append(k)

    # 12. NEW: Vocabulary features
    for k in ["short_word_ratio", "long_word_ratio", "hapax_legomena_ratio",
              "first_person_ratio", "second_person_ratio", "action_verb_density",
              "superlative_count", "comparison_word_count"]:
        candidates.append(k)

    # 13. NEW: Hook advanced
    for k in ["hook_speech_rate_wps", "hook_unique_word_ratio", "hook_action_verb_count",
              "hook_sentence_count", "hook_avg_word_length", "hook_number_count"]:
        candidates.append(k)

    # 14. NEW: Narrative structure advanced
    for k in ["segment_duration_variance", "segment_count_per_minute",
              "has_setup_segment", "has_conclusion_segment", "segment_type_count",
              "narrative_arc_completeness", "climax_late_flag",
              "last_segment_duration_pct", "first_segment_duration_pct",
              "segment_length_ratio_max_min", "body_segment_count",
              "hook_conclusion_combined_pct"]:
        candidates.append(k)

    # 15. NEW: Title & metadata advanced
    for k in ["title_all_caps_word_count", "title_emoji_flag", "title_contains_making",
              "title_avg_word_length", "title_starts_with_action",
              "duration_optimal_flag", "duration_sweetspot_distance",
              "description_word_count", "is_vertical", "upload_month"]:
        candidates.append(k)

    # 16. NEW: Visual frame advanced
    for k in ["opening_frame_has_text", "opening_frame_has_face",
              "action_frame_pct", "workshop_frame_pct", "outdoor_frame_pct",
              "face_alone_pct", "face_with_action_pct", "object_focus_pct",
              "text_overlay_early_pct", "dramatic_frame_pct"]:
        candidates.append(k)

    # 17. NEW: AI analysis features
    for k in ["idea_word_count", "idea_char_count", "summary_word_count",
              "idea_question_flag", "idea_number_flag",
              "idea_contains_making", "idea_contains_indestructible"]:
        candidates.append(k)

    # 18. CRAZY pre-upload: emotional arc, verbal patterns, visual rhythm, title power
    for k in ["tension_word_density", "resolution_word_density", "tension_resolution_ratio",
              "emotional_arc_swing", "hook_tension_density",
              "repeated_phrase_count", "vocabulary_richness_yule_k",
              "question_early_ratio", "open_loop_count", "cliffhanger_density",
              "visual_monotony_score", "visual_variety_entropy",
              "face_intro_delay_frames", "visual_pacing_variance",
              "golden_ratio_segment_flag", "hook_to_body_word_overlap",
              "title_uniqueness_score", "title_curiosity_gap_score", "title_power_word_count",
              "words_per_scene", "speech_silence_ratio", "transcript_readability",
              "energy_word_density", "concept_density", "frame_text_variety",
              "description_link_count", "description_hashtag_count"]:
        candidates.append(k)

    # 19. NEW: Retention curve advanced
    for k in ["hook_payoff_gap", "end_recovery_score", "momentum_zone_length",
              "retention_recovery_count", "above_baseline_area", "below_baseline_area",
              "late_drop_severity", "retention_concavity", "retention_quartile_spread",
              "early_late_drop_ratio"]:
        candidates.append(k)

    # 19. NEW: Post-upload analytics advanced
    for k in ["engagement_rate", "like_to_comment_ratio", "sub_nonsub_retention_gap",
              "retention_variation_raw", "avg_percent_viewed", "engaged_view_rate",
              "sub_view_fraction", "view_day1_share", "view_week3_week1_ratio",
              "daily_views_entropy", "daily_views_gini", "stayed_to_watch_rate",
              "avg_view_duration_s"]:
        candidates.append(k)

    # 20. Interaction terms (expanded with new indicator families)
    interaction_bases = [
        "retention_pct_50", "retention_pct_25", "speech_rate_wps",
        "face_frame_pct", "retention_entropy", "hook_drop_rate",
        "non_sub_view_share", "swipe_away_rate", "like_rate",
        # pre-upload additions for richer interactions
        "unique_word_ratio", "scene_change_rate", "hook_duration_pct",
        "title_word_count", "avg_segment_duration_s", "close_up_frame_pct",
        # NEW: high-signal indicators for cross-family interactions
        "sensory_word_density", "pivot_word_count", "max_silence_gap_s",
        "opening_speech_rate_3s", "action_frame_pct", "final_5pct_retention",
        "hook_payoff_gap", "end_recovery_score", "narrative_arc_completeness",
    ]
    seen_pairs = set()
    for i, a in enumerate(interaction_bases):
        for b in interaction_bases[i + 1:]:
            pair_key = f"{a}_x_{b}"
            if pair_key not in seen_pairs:
                seen_pairs.add(pair_key)
                candidates.append(pair_key)

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


# ── LLM candidate proposal (upstream, non-deterministic) ─────────────────
# Only this step may use an LLM.  Everything downstream stays deterministic.

VALID_KEY_PATTERNS = [
    re.compile(r'^retention_pct_(\d+)$'),
    re.compile(r'^retention_mean_(\d+)_(\d+)$'),
    re.compile(r'^retention_slope_(\d+)_(\d+)$'),
    re.compile(r'^retention_volatility_(\d+)_(\d+)$'),
    re.compile(r'^views_log_days_(\d+)_(\d+)$'),
    re.compile(r'^views_ratio_(\w+)_vs_(\w+)$'),
    re.compile(r'^(.+)_x_(.+)$'),
]

# Static keys that are always valid
STATIC_VALID_KEYS = set(METRIC_DEFINITIONS.keys())


def canonicalize_key(raw_key):
    """Normalise an LLM-proposed key to snake_case, strip whitespace."""
    k = raw_key.strip().lower()
    k = re.sub(r'[^a-z0-9_]', '_', k)
    k = re.sub(r'_+', '_', k).strip('_')
    return k


def validate_candidate(key):
    """Return True if key is implementable: either in METRIC_DEFINITIONS or
    matches one of the generated patterns with sensible parameters."""
    if key in STATIC_VALID_KEYS:
        return True
    # retention_pct_N — pct must be 1-99
    m = re.match(r'^retention_pct_(\d+)$', key)
    if m:
        pct = int(m.group(1))
        return 1 <= pct <= 99
    # retention_mean/slope/volatility — valid window
    m = re.match(r'^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return 0 <= lo < hi <= 100
    # views_log_days
    m = re.match(r'^views_log_days_(\d+)_(\d+)$', key)
    if m:
        d0, d1 = int(m.group(1)), int(m.group(2))
        return 0 <= d0 < d1 <= 365
    # views_ratio
    m = re.match(r'^views_ratio_(\w+)_vs_(\w+)$', key)
    if m:
        return any(r[0] == m.group(1) and r[1] == m.group(2) for r in DAILY_VIEWS_RATIOS)
    # Interaction terms
    m = re.match(r'^(.+)_x_(.+)$', key)
    if m:
        a, b = m.group(1), m.group(2)
        return get_metric_definition(a) is not None and get_metric_definition(b) is not None
    return False


def llm_propose_candidates(n_candidates, existing_keys, indicators, graph,
                            preupload_ratio=None):
    """Ask Claude (via CLI) to propose new candidate indicator keys.
    Returns a list of canonicalized, validated keys.  Falls back to [] on error."""
    # Build context for the prompt
    n_ind = len(indicators)
    n_nodes = len(graph.get("nodes", []))
    n_edges = len(graph.get("edges", []))

    # Top indicators by |r|
    sorted_inds = sorted(indicators, key=lambda i: abs(i.get("result", {}).get("primary_r", 0)), reverse=True)
    top_lines = []
    for ind in sorted_inds[:15]:
        r = ind["result"]["primary_r"]
        top_lines.append(f"  {ind['key']}  r={r:+.3f}")
    top_str = "\n".join(top_lines) if top_lines else "  (none yet)"

    existing_str = ", ".join(sorted(existing_keys)[:80])

    # Pre-upload bias instruction
    pre_upload_focus = ""
    if preupload_ratio is not None and preupload_ratio > 0.5:
        n_pre = max(1, round(n_candidates * preupload_ratio))
        pre_upload_focus = f"""
IMPORTANT: Strongly favor PRE-UPLOAD indicators (at least {n_pre} of {n_candidates}).
Pre-upload indicators use ONLY data available before publishing: transcript text, AI segments, video metadata (title, duration), and frame analysis (sceneDescription, visualTechniques).
Pre-upload static keys include: transcript_word_count, transcript_char_count, avg_word_length, unique_word_ratio, sentence_count, exclamation_count, uppercase_word_ratio, question_count, hook_question_count, hook_word_count, hook_word_ratio, hook_char_count, transcript_number_count, speech_rate_wps, segment_count, has_hook_segment, hook_duration_s, hook_duration_pct, avg_segment_duration_s, longest_segment_duration_s, shortest_segment_duration_s, hook_position_s, climax_position_pct, has_climax_segment, hook_to_climax_gap_s, duration_log, duration_s, title_char_count, title_word_count, title_question_flag, title_exclamation_flag, title_number_flag, face_frame_pct, text_overlay_frame_pct, scene_change_count, scene_change_rate, unique_scene_ratio, visual_technique_count_mean, close_up_frame_pct, hand_presence_frame_pct, motion_word_frame_pct.
Propose interaction terms (<preA>_x_<preB>) combining these pre-upload keys, as well as novel pre-upload static keys.
"""

    prompt = f"""You are a research assistant for a YouTube analytics pipeline.
The pipeline discovers which measurable indicators predict video views (log10 viewCount).
The corpus is 370 YouTube Shorts with full retention curves (100 points), daily view history, transcripts, and frame analysis.

Current state:
- {n_ind} indicators tested, {n_nodes} graph nodes, {n_edges} edges
- Existing keys: {existing_str}

Top indicators by |r|:
{top_str}
{pre_upload_focus}
Propose exactly {n_candidates} NEW candidate indicator keys (not already tested).
Each key must follow one of these patterns:
- retention_pct_<N>  (N = 1-99, retention at that percentile)
- retention_mean_<lo>_<hi>  (mean retention in pct window)
- retention_slope_<lo>_<hi>  (slope in pct window)
- retention_volatility_<lo>_<hi>  (std dev in pct window)
- views_log_days_<d0>_<d1>  (log10 views in day window)
- views_ratio_<name>_vs_<name>  (ratio of view windows, must use: week2/week1, month1/week1, week3/week2)
- <keyA>_x_<keyB>  (interaction of two valid keys)
- Any key from the static set: hook_retention_pct, final_5pct_retention, retention_entropy, etc.

Focus on unexplored regions: mid-video retention windows, tail retention, early-vs-late slopes, and interaction terms with the strongest known indicators.

Respond ONLY with a JSON array of strings. No explanation, no markdown fences.
Example: ["retention_slope_40_60", "retention_pct_33", "retention_entropy_x_face_frame_pct"]"""

    try:
        result = subprocess.run(
            ["env", "-u", "ANTHROPIC_API_KEY",
             "claude", "--permission-mode", "bypassPermissions", "--print", "-p", prompt],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            print(f"  [LLM] Claude CLI returned code {result.returncode}")
            return []
        raw = result.stdout.strip()
        # Try to parse JSON from the output — handle markdown fences
        json_match = re.search(r'\[.*\]', raw, re.DOTALL)
        if not json_match:
            print(f"  [LLM] No JSON array found in response")
            return []
        proposals = json.loads(json_match.group())
        if not isinstance(proposals, list):
            return []

        # Canonicalize, validate, deduplicate
        accepted = []
        seen = set(existing_keys)
        for raw_key in proposals:
            if not isinstance(raw_key, str):
                continue
            key = canonicalize_key(raw_key)
            if not key or key in seen:
                continue
            if validate_candidate(key):
                accepted.append(key)
                seen.add(key)
        print(f"  [LLM] Proposed {len(proposals)} keys, accepted {len(accepted)} after validation")
        return accepted

    except subprocess.TimeoutExpired:
        print(f"  [LLM] Claude CLI timed out")
        return []
    except Exception as e:
        print(f"  [LLM] Error calling Claude CLI: {e}")
        return []


def get_metric_definition(key):
    """Look up metric definition — checks static METRIC_DEFINITIONS first,
    then generates definitions for pattern-based autonomous keys."""
    if key in METRIC_DEFINITIONS:
        return METRIC_DEFINITIONS[key]

    # retention_pct_N
    m = re.match(r'^retention_pct_(\d+)$', key)
    if m:
        pct = int(m.group(1))
        return {
            "description": f"Retention at {pct}% into the video.",
            "formula": f"retentionCurve[{pct}].retention",
            "expected_range": "0 to 2.0",
            "data_sources": ["analytics.retentionCurve"],
            "layer": "post",
        }

    # retention_mean_LO_HI
    m = re.match(r'^retention_mean_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return {
            "description": f"Mean retention in the {lo}-{hi}% window of the video.",
            "formula": f"mean(retentionCurve[{lo}:{hi}].retention)",
            "expected_range": "0 to 2.0",
            "data_sources": ["analytics.retentionCurve"],
            "layer": "post",
        }

    # retention_slope_LO_HI
    m = re.match(r'^retention_slope_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return {
            "description": f"Linear regression slope of retention in the {lo}-{hi}% window.",
            "formula": f"linregress(retentionCurve[{lo}:{hi}].retention).slope",
            "expected_range": "-0.05 to 0.05",
            "data_sources": ["analytics.retentionCurve"],
            "layer": "post",
        }

    # retention_volatility_LO_HI
    m = re.match(r'^retention_volatility_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return {
            "description": f"Std deviation of retention in the {lo}-{hi}% window (volatility).",
            "formula": f"std(retentionCurve[{lo}:{hi}].retention)",
            "expected_range": "0 to 0.5",
            "data_sources": ["analytics.retentionCurve"],
            "layer": "post",
        }

    # views_log_days_D0_D1
    m = re.match(r'^views_log_days_(\d+)_(\d+)$', key)
    if m:
        d0, d1 = int(m.group(1)), int(m.group(2))
        return {
            "description": f"Log10 of total views in days {d0}-{d1} after upload.",
            "formula": f"log10(sum(dailyViews[{d0}:{d1}].views) + 1)",
            "expected_range": "0 to 8",
            "data_sources": ["analytics.dailyViews"],
            "layer": "post",
        }

    # views_ratio_X_vs_Y
    m = re.match(r'^views_ratio_(\w+)_vs_(\w+)$', key)
    if m:
        num_name, den_name = m.group(1), m.group(2)
        ratio_info = next(
            (r for r in DAILY_VIEWS_RATIOS if r[0] == num_name and r[1] == den_name), None
        )
        if ratio_info:
            _, _, n0, n1, d0, d1 = ratio_info
            return {
                "description": f"View ratio: days {n0}-{n1} / days {d0}-{d1} — sustained vs early virality.",
                "formula": f"sum(dailyViews[{n0}:{n1}].views) / (sum(dailyViews[{d0}:{d1}].views) + 1)",
                "expected_range": "0 to 5",
                "data_sources": ["analytics.dailyViews"],
                "layer": "post",
            }

    # Interaction terms: keyA_x_keyB
    m = re.match(r'^(.+)_x_(.+)$', key)
    if m:
        a, b = m.group(1), m.group(2)
        def_a = get_metric_definition(a)
        def_b = get_metric_definition(b)
        if def_a and def_b:
            # Inherit 'pre' layer if both components are pre-upload
            layer_a = def_a.get("layer", "post")
            layer_b = def_b.get("layer", "post")
            interaction_layer = "pre" if (layer_a == "pre" and layer_b == "pre") else "post"
            return {
                "description": f"Interaction: {a} multiplied by {b}.",
                "formula": f"{a} * {b}",
                "expected_range": "varies",
                "data_sources": list(set(def_a.get("data_sources", []) + def_b.get("data_sources", []))),
                "layer": interaction_layer,
            }

    return None


def get_resolution_for_key(key):
    """Determine resolution info for any key (static or generated).
    Returns (resolution_id, start_pct, end_pct, start_day, end_day)."""
    if key in INDICATOR_RESOLUTION_MAP:
        return INDICATOR_RESOLUTION_MAP[key]

    # retention_pct_N → point shelf at N%
    m = re.match(r'^retention_pct_(\d+)$', key)
    if m:
        n = int(m.group(1))
        if n <= 10:
            return ('r_hook', 0, 10, None, None)
        if n >= 95:
            return ('r_last5pct', 95, 100, None, None)
        return (f'r_pct_{n}_{n}', n, n, None, None)

    # retention_mean/slope/volatility windows
    m = re.match(r'^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo == 0 and hi == 100:
            return ('r0', 0, 100, None, None)
        if hi <= 10:
            return ('r_hook', 0, 10, None, None)
        if lo >= 95:
            return ('r_last5pct', 95, 100, None, None)
        res_id = f"r_pct_{lo}_{hi}"
        return (res_id, lo, hi, None, None)

    # views_log_days_D0_D1
    m = re.match(r'^views_log_days_(\d+)_(\d+)$', key)
    if m:
        d0, d1 = int(m.group(1)), int(m.group(2))
        res_id = f"r_days_{d0}_{d1}"
        return (res_id, None, None, d0, d1)

    # views_ratio
    m = re.match(r'^views_ratio_(\w+)_vs_(\w+)$', key)
    if m:
        ratio_info = next(
            (r for r in DAILY_VIEWS_RATIOS if r[0] == m.group(1) and r[1] == m.group(2)), None
        )
        if ratio_info:
            _, _, n0, n1, d0, d1 = ratio_info
            end_day = max(n1, d1)
            return (f"r_days_0_{end_day}", None, None, 0, end_day)

    # Interaction or other → r0
    return ('r0', 0, 100, None, None)


# ── JSON helpers (R2-aware via HTTP bridge) ────────────────────────────────
def load_json(path, default=None):
    fb = default if default is not None else []
    name = _get_r2_name(path)
    if JARVIS_API_URL and name:
        try:
            import requests as _req
            resp = _req.get(f"{JARVIS_API_URL}/api/jarvis/v2/data/{name}", timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                if data is not None:
                    return data
        except Exception as e:
            print(f"[R2-bridge] load {name} failed, falling back to local: {e}")
    # Local fallback
    p = Path(path)
    if p.exists():
        with open(p) as f:
            return json.load(f)
    return fb


def save_json(path, data):
    name = _get_r2_name(path)
    if JARVIS_API_URL and name:
        try:
            import requests as _req
            resp = _req.put(
                f"{JARVIS_API_URL}/api/jarvis/v2/data/{name}",
                json=data,
                timeout=60,
            )
            if resp.status_code == 200:
                return  # server wrote R2 + local
            print(f"[R2-bridge] save {name} got {resp.status_code}, writing local")
        except Exception as e:
            print(f"[R2-bridge] save {name} failed, writing local: {e}")
    # Local fallback
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
        total = analytics.get("totalViews", 0) or 0
        non_sub = analytics.get("nonSubscriberViews", 0) or 0
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
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float((analytics.get("likes", 0) or 0) / total * 1000), None)

    if key == "comment_rate":
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float((analytics.get("comments", 0) or 0) / total * 1000), None)

    if key == "share_rate":
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float((analytics.get("shares", 0) or 0) / total * 1000), None)

    if key == "subs_gained_per_view":
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float((analytics.get("subscribersGained", 0) or 0) / total * 1000), None)

    if key == "subs_per_like":
        likes = analytics.get("likes", 0) or 0
        subs = analytics.get("subscribersGained", 0) or 0
        return (float(subs / (likes + 1)), None)

    if key == "revenue_per_view":
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float((analytics.get("estimatedRevenue", 0) or 0) / total * 1000), None)

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
        total = analytics.get("totalViews", 0) or 0
        non_sub = analytics.get("nonSubscriberViews", 0) or 0
        if keep is None or not total:
            return (None, "missing data")
        return (float(keep * (non_sub / total)), None)

    # ── NEW PRE-UPLOAD: Transcript / language ────────────────────────────
    if key == "transcript_char_count":
        if not transcript:
            return (None, "no transcript")
        return (float(len(transcript)), None)

    if key == "avg_word_length":
        if not transcript:
            return (None, "no transcript")
        words = transcript.split()
        if not words:
            return (None, "empty transcript")
        return (float(sum(len(w) for w in words) / len(words)), None)

    if key == "unique_word_ratio":
        if not transcript:
            return (None, "no transcript")
        words = transcript.lower().split()
        if not words:
            return (None, "empty transcript")
        return (float(len(set(words)) / len(words)), None)

    if key == "sentence_count":
        if not transcript:
            return (None, "no transcript")
        count = transcript.count('.') + transcript.count('!') + transcript.count('?')
        return (float(count), None)

    if key == "exclamation_count":
        if not transcript:
            return (None, "no transcript")
        return (float(transcript.count('!')), None)

    if key == "uppercase_word_ratio":
        if not transcript:
            return (None, "no transcript")
        words = transcript.split()
        if not words:
            return (None, "empty transcript")
        upper_ct = sum(1 for w in words if w.isupper() and len(w) >= 2)
        return (float(upper_ct / len(words)), None)

    if key == "hook_question_count":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        hook_text = ""
        if hook_seg and hook_seg.get("transcript"):
            hook_text = hook_seg["transcript"]
        elif transcript:
            dur = meta.get("duration", 1)
            words = transcript.split()
            hook_est = max(1, int(len(words) * 5 / dur))
            hook_text = " ".join(words[:hook_est])
        if not hook_text:
            return (None, "no hook text")
        return (float(hook_text.count("?")), None)

    if key == "hook_word_ratio":
        if not transcript:
            return (None, "no transcript")
        total_words = len(transcript.split())
        if total_words == 0:
            return (None, "empty transcript")
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            hw = len(hook_seg["transcript"].split())
        else:
            dur = meta.get("duration", 1)
            words = transcript.split()
            hook_est = max(1, int(len(words) * 5 / dur))
            hw = len(words[:hook_est])
        return (float(hw / total_words), None)

    if key == "hook_char_count":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            return (float(len(hook_seg["transcript"])), None)
        if transcript:
            dur = meta.get("duration", 1)
            chars_per_sec = len(transcript) / dur
            return (float(chars_per_sec * 5), None)  # estimate first 5s
        return (None, "no hook text")

    if key == "transcript_number_count":
        if not transcript:
            return (None, "no transcript")
        return (float(len(re.findall(r'\d+', transcript))), None)

    # ── NEW PRE-UPLOAD: Structure / AI segments ──────────────────────────
    if key == "hook_duration_pct":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if not hook_seg:
            return (0.0, None)
        hook_dur = hook_seg.get("endTime", 0) - hook_seg.get("startTime", 0)
        return (float(hook_dur / dur * 100), None)

    if key == "avg_segment_duration_s":
        if not segments:
            return (None, "no segments")
        durs = [s.get("endTime", 0) - s.get("startTime", 0) for s in segments]
        return (float(np.mean(durs)), None)

    if key == "longest_segment_duration_s":
        if not segments:
            return (None, "no segments")
        durs = [s.get("endTime", 0) - s.get("startTime", 0) for s in segments]
        return (float(max(durs)), None)

    if key == "shortest_segment_duration_s":
        if not segments:
            return (None, "no segments")
        durs = [s.get("endTime", 0) - s.get("startTime", 0) for s in segments]
        return (float(min(durs)), None)

    if key == "hook_position_s":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if not hook_seg:
            return (None, "no hook segment")
        return (float(hook_seg.get("startTime", 0)), None)

    if key == "climax_position_pct":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        climax_labels = {"climax", "peak", "payoff", "reveal"}
        climax_seg = next((s for s in segments if s.get("label", "").lower() in climax_labels), None)
        if not climax_seg:
            return (None, "no climax segment")
        return (float(climax_seg.get("startTime", 0) / dur * 100), None)

    if key == "has_climax_segment":
        climax_labels = {"climax", "peak", "payoff", "reveal"}
        has = any(s.get("label", "").lower() in climax_labels for s in segments)
        return (float(int(has)), None)

    if key == "hook_to_climax_gap_s":
        climax_labels = {"climax", "peak", "payoff", "reveal"}
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        climax_seg = next((s for s in segments if s.get("label", "").lower() in climax_labels), None)
        if not hook_seg or not climax_seg:
            return (None, "missing hook or climax segment")
        gap = climax_seg.get("startTime", 0) - hook_seg.get("endTime", 0)
        return (float(max(0, gap)), None)

    # ── NEW PRE-UPLOAD: Metadata ─────────────────────────────────────────
    if key == "duration_s":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (float(dur), None)

    if key == "title_char_count":
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        return (float(len(title)), None)

    if key == "title_word_count":
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        return (float(len(title.split())), None)

    if key == "title_question_flag":
        title = meta.get("title", "")
        return (float(int("?" in title)), None)

    if key == "title_exclamation_flag":
        title = meta.get("title", "")
        return (float(int("!" in title)), None)

    if key == "title_number_flag":
        title = meta.get("title", "")
        return (float(int(any(c.isdigit() for c in title))), None)

    # ── NEW PRE-UPLOAD: Visual / frame-derived ───────────────────────────
    if key == "scene_change_rate":
        if not frames:
            return (None, "no frames")
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        changes, prev = 0, ""
        for frame in frames:
            desc = str(frame.get("analysis", {}).get("sceneDescription", ""))
            if prev and desc[:60] != prev[:60]:
                changes += 1
            prev = desc
        return (float(changes / dur), None)

    if key == "unique_scene_ratio":
        if not frames:
            return (None, "no frames")
        descs = [str(f.get("analysis", {}).get("sceneDescription", ""))[:60] for f in frames]
        return (float(len(set(descs)) / len(descs)), None)

    if key == "visual_technique_count_mean":
        if not frames:
            return (None, "no frames")
        counts = []
        for f in frames:
            vt = str(f.get("analysis", {}).get("visualTechniques", ""))
            # Count sentences as proxy for technique count
            ct = len([s for s in re.split(r'[.;]', vt) if s.strip()])
            counts.append(ct)
        return (float(np.mean(counts)), None)

    if key == "close_up_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if
                 "close" in str(f.get("analysis", {}).get("sceneDescription", "")).lower() or
                 "close" in str(f.get("analysis", {}).get("visualTechniques", "")).lower() or
                 "close" in str(f.get("analysis", {}).get("cinematography", "")).lower())
        return (float(ct / len(frames)), None)

    if key == "hand_presence_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if "hand" in str(f.get("analysis", {}).get("sceneDescription", "")).lower())
        return (float(ct / len(frames)), None)

    if key == "motion_word_frame_pct":
        if not frames:
            return (None, "no frames")
        motion_kw = {"moving", "motion", "walking", "running", "jumping", "dancing",
                      "gesture", "action", "dynamic", "swinging", "waving", "shaking"}
        ct = sum(1 for f in frames if
                 any(kw in str(f.get("analysis", {}).get("sceneDescription", "")).lower() for kw in motion_kw))
        return (float(ct / len(frames)), None)

    # ── Pattern-based autonomous keys ─────────────────────────────────────

    # retention_pct_N
    m = re.match(r'^retention_pct_(\d+)$', key)
    if m:
        idx = int(m.group(1))
        v = curve_val(idx)
        return (v, None) if v is not None else (None, "no curve")

    # retention_mean_LO_HI
    m = re.match(r'^retention_mean_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if len(curve) < hi:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[lo:hi]]
        if not vals:
            return (None, "empty window")
        return (float(np.mean(vals)), None)

    # retention_slope_LO_HI
    m = re.match(r'^retention_slope_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if len(curve) < hi:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[lo:hi]]
        if len(vals) < 2:
            return (None, "window too small")
        slope, _, _, _, _ = stats.linregress(range(len(vals)), vals)
        return (float(slope), None)

    # retention_volatility_LO_HI
    m = re.match(r'^retention_volatility_(\d+)_(\d+)$', key)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if len(curve) < hi:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[lo:hi]]
        if len(vals) < 2:
            return (None, "window too small")
        return (float(np.std(vals)), None)

    # views_log_days_D0_D1
    m = re.match(r'^views_log_days_(\d+)_(\d+)$', key)
    if m:
        d0, d1 = int(m.group(1)), int(m.group(2))
        if not daily:
            return (None, "no daily views")
        total_v = sum(d.get("views", 0) for d in daily[d0:d1])
        return (float(math.log10(total_v + 1)), None)

    # views_ratio_X_vs_Y
    m = re.match(r'^views_ratio_(\w+)_vs_(\w+)$', key)
    if m:
        ratio_info = next(
            (r for r in DAILY_VIEWS_RATIOS if r[0] == m.group(1) and r[1] == m.group(2)), None
        )
        if ratio_info and daily:
            _, _, n0, n1, d0, d1 = ratio_info
            num = sum(d.get("views", 0) for d in daily[n0:n1])
            den = sum(d.get("views", 0) for d in daily[d0:d1])
            return (float(num / (den + 1)), None)
        return (None, "no daily views or unknown ratio")

    # ── NEW: Speech Pacing (timed words) ────────────────────────────────
    _tw = analysis.get("transcript", {})
    timed_words = (_tw.get("words", []) if isinstance(_tw, dict) else []) or []
    dur_s = (meta.get("duration", 0) or 0)

    def _words_in_window(t0, t1):
        return [w for w in timed_words if t0 <= w.get("timestamp", -1) < t1]

    def _rate_in_window(t0, t1):
        span = t1 - t0
        if span <= 0:
            return None
        return len(_words_in_window(t0, t1)) / span

    def _get_hook_text():
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            return hook_seg["transcript"]
        if transcript and dur_s:
            words_list = transcript.split()
            hook_est = max(1, int(len(words_list) * 5 / dur_s))
            return " ".join(words_list[:hook_est])
        return ""

    if key == "opening_speech_rate_3s":
        if not timed_words:
            return (None, "no timed words")
        r = _rate_in_window(0, 3.0)
        return (float(r), None) if r is not None else (None, "no duration")

    if key == "opening_speech_rate_5s":
        if not timed_words:
            return (None, "no timed words")
        r = _rate_in_window(0, 5.0)
        return (float(r), None) if r is not None else (None, "no duration")

    if key == "closing_speech_rate_5s":
        if not timed_words or not dur_s:
            return (None, "no timed words or duration")
        r = _rate_in_window(max(0, dur_s - 5.0), dur_s)
        return (float(r), None) if r is not None else (None, "bad window")

    if key == "speech_rate_q1":
        if not timed_words or not dur_s:
            return (None, "no timed words or duration")
        r = _rate_in_window(0, dur_s * 0.25)
        return (float(r), None) if r is not None else (None, "bad window")

    if key == "speech_rate_q4":
        if not timed_words or not dur_s:
            return (None, "no timed words or duration")
        r = _rate_in_window(dur_s * 0.75, dur_s)
        return (float(r), None) if r is not None else (None, "bad window")

    if key == "speech_rate_ratio_q4_q1":
        if not timed_words or not dur_s:
            return (None, "no timed words or duration")
        q1 = _rate_in_window(0, dur_s * 0.25)
        q4 = _rate_in_window(dur_s * 0.75, dur_s)
        if q1 is None or q4 is None:
            return (None, "bad windows")
        return (float(q4 / (q1 + 0.01)), None)

    if key == "speech_acceleration":
        if not timed_words or not dur_s or dur_s < 5:
            return (None, "insufficient data")
        n_wins = max(2, int(dur_s / 5))
        rates = []
        for i in range(n_wins):
            t0 = dur_s * i / n_wins
            t1 = dur_s * (i + 1) / n_wins
            r = _rate_in_window(t0, t1)
            if r is not None:
                rates.append(r)
        if len(rates) < 2:
            return (None, "not enough windows")
        slope, _, _, _, _ = stats.linregress(range(len(rates)), rates)
        return (float(slope), None)

    if key == "max_silence_gap_s":
        if len(timed_words) < 2:
            return (None, "need 2+ timed words")
        gaps = [timed_words[i+1]["timestamp"] - timed_words[i]["timestamp"]
                for i in range(len(timed_words)-1)
                if "timestamp" in timed_words[i] and "timestamp" in timed_words[i+1]]
        return (float(max(gaps)), None) if gaps else (None, "no gaps")

    if key == "silence_gap_count":
        if len(timed_words) < 2:
            return (None, "need 2+ timed words")
        gaps = [timed_words[i+1]["timestamp"] - timed_words[i]["timestamp"]
                for i in range(len(timed_words)-1)
                if "timestamp" in timed_words[i] and "timestamp" in timed_words[i+1]]
        return (float(sum(1 for g in gaps if g > 1.0)), None)

    if key == "silence_total_pct":
        if len(timed_words) < 2 or not dur_s:
            return (None, "need timed words + duration")
        gaps = [timed_words[i+1]["timestamp"] - timed_words[i]["timestamp"]
                for i in range(len(timed_words)-1)
                if "timestamp" in timed_words[i] and "timestamp" in timed_words[i+1]]
        silence = sum(g for g in gaps if g > 0.5)
        return (float(silence / dur_s), None)

    if key == "opening_word_latency_s":
        if not timed_words:
            return (None, "no timed words")
        return (float(timed_words[0].get("timestamp", 0)), None)

    if key == "peak_speech_rate_3s":
        if not timed_words or not dur_s:
            return (None, "no timed words")
        max_rate = 0
        for t in range(0, int(dur_s)):
            r = len(_words_in_window(t, t + 3)) / 3.0
            if r > max_rate:
                max_rate = r
        return (float(max_rate), None)

    if key == "speech_tempo_range":
        if not timed_words or not dur_s or dur_s < 10:
            return (None, "insufficient data")
        rates = []
        for t in range(0, int(dur_s) - 4, 2):
            r = len(_words_in_window(t, t + 5)) / 5.0
            rates.append(r)
        if len(rates) < 2:
            return (None, "not enough windows")
        return (float(max(rates) - min(rates)), None)

    if key == "avg_word_gap_s":
        if len(timed_words) < 2:
            return (None, "need 2+ timed words")
        gaps = [timed_words[i+1]["timestamp"] - timed_words[i]["timestamp"]
                for i in range(len(timed_words)-1)
                if "timestamp" in timed_words[i] and "timestamp" in timed_words[i+1]]
        return (float(np.mean(gaps)), None) if gaps else (None, "no gaps")

    if key == "word_density_variance":
        if not timed_words or not dur_s or dur_s < 10:
            return (None, "insufficient data")
        rates = []
        for t in range(0, int(dur_s) - 4, 5):
            rates.append(len(_words_in_window(t, t + 5)) / 5.0)
        if len(rates) < 2:
            return (None, "not enough windows")
        return (float(np.var(rates)), None)

    # ── NEW: Sensory & Technical Language ─────────────────────────────────
    if key == "sensory_word_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in SENSORY_WORDS)
        return (float(ct / len(words_lower)), None)

    if key == "technical_word_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in TECHNICAL_WORDS)
        return (float(ct / len(words_lower)), None)

    if key == "sensory_technical_ratio":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        s_ct = sum(1 for w in words_lower if w in SENSORY_WORDS)
        t_ct = sum(1 for w in words_lower if w in TECHNICAL_WORDS)
        return (float(s_ct / (t_ct + 1)), None)

    if key == "hook_sensory_word_count":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_lower = hook_text.lower().split()
        return (float(sum(1 for w in words_lower if w in SENSORY_WORDS)), None)

    if key == "body_sensation_word_pct":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in BODY_SENSATION_WORDS)
        return (float(ct / len(words_lower) * 100), None)

    # ── NEW: Pivot & Transition Words ────────────────────────────────────
    if key == "pivot_word_count":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        return (float(sum(1 for w in words_lower if w in PIVOT_WORDS)), None)

    if key == "pivot_word_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in PIVOT_WORDS)
        return (float(ct / len(words_lower) * 100), None)

    if key == "hook_pivot_word_flag":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_lower = hook_text.lower().split()
        has = any(w in PIVOT_WORDS for w in words_lower)
        return (float(int(has)), None)

    # ── NEW: Vocabulary Features ─────────────────────────────────────────
    if key == "short_word_ratio":
        if not transcript:
            return (None, "no transcript")
        words_list = transcript.split()
        if not words_list:
            return (None, "empty transcript")
        ct = sum(1 for w in words_list if len(w) <= 3)
        return (float(ct / len(words_list)), None)

    if key == "long_word_ratio":
        if not transcript:
            return (None, "no transcript")
        words_list = transcript.split()
        if not words_list:
            return (None, "empty transcript")
        ct = sum(1 for w in words_list if len(w) >= 8)
        return (float(ct / len(words_list)), None)

    if key == "hapax_legomena_ratio":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        from collections import Counter
        freq = Counter(words_lower)
        hapax = sum(1 for v in freq.values() if v == 1)
        return (float(hapax / len(words_lower)), None)

    if key == "first_person_ratio":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in FIRST_PERSON)
        return (float(ct / len(words_lower)), None)

    if key == "second_person_ratio":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in SECOND_PERSON)
        return (float(ct / len(words_lower)), None)

    if key == "action_verb_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in ACTION_VERBS)
        return (float(ct / len(words_lower)), None)

    if key == "superlative_count":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        return (float(sum(1 for w in words_lower if w in SUPERLATIVES)), None)

    if key == "comparison_word_count":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        return (float(sum(1 for w in words_lower if w in COMPARISON_WORDS)), None)

    # ── NEW: Hook Advanced ───────────────────────────────────────────────
    if key == "hook_speech_rate_wps":
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg:
            h_dur = hook_seg.get("endTime", 0) - hook_seg.get("startTime", 0)
            h_text = hook_seg.get("transcript", "")
            if h_dur > 0 and h_text:
                return (float(len(h_text.split()) / h_dur), None)
        if transcript and dur_s:
            words_list = transcript.split()
            hook_est = max(1, int(len(words_list) * 5 / dur_s))
            h_words = len(words_list[:hook_est])
            return (float(h_words / 5.0), None) if 5.0 > 0 else (None, "no duration")
        return (None, "no hook data")

    if key == "hook_unique_word_ratio":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_lower = hook_text.lower().split()
        if not words_lower:
            return (None, "empty hook")
        return (float(len(set(words_lower)) / len(words_lower)), None)

    if key == "hook_action_verb_count":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_lower = hook_text.lower().split()
        return (float(sum(1 for w in words_lower if w in ACTION_VERBS)), None)

    if key == "hook_sentence_count":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        ct = hook_text.count('.') + hook_text.count('!') + hook_text.count('?')
        return (float(max(ct, 1)), None)

    if key == "hook_avg_word_length":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_list = hook_text.split()
        if not words_list:
            return (None, "empty hook")
        return (float(sum(len(w) for w in words_list) / len(words_list)), None)

    if key == "hook_number_count":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        return (float(len(re.findall(r'\d+', hook_text))), None)

    # ── NEW: Narrative Structure Advanced ─────────────────────────────────
    if key == "segment_duration_variance":
        if not segments or len(segments) < 2:
            return (None, "need 2+ segments")
        durs = [s.get("endTime", 0) - s.get("startTime", 0) for s in segments]
        return (float(np.var(durs)), None)

    if key == "segment_count_per_minute":
        if not segments or not dur_s:
            return (None, "no segments or duration")
        return (float(len(segments) / (dur_s / 60)), None)

    if key == "has_setup_segment":
        has = any(s.get("label", "").lower() == "setup" for s in segments)
        return (float(int(has)), None)

    if key == "has_conclusion_segment":
        has = any(s.get("label", "").lower() == "conclusion" for s in segments)
        return (float(int(has)), None)

    if key == "segment_type_count":
        if not segments:
            return (0.0, None)
        labels = set(s.get("label", "").lower() for s in segments)
        return (float(len(labels)), None)

    if key == "narrative_arc_completeness":
        if not segments:
            return (0.0, None)
        labels = set(s.get("label", "").lower() for s in segments)
        canonical = {"hook", "setup", "main point", "climax", "conclusion",
                     "payoff", "reveal", "peak", "body", "main"}
        # Map similar labels
        found = set()
        for lbl in labels:
            if lbl == "hook": found.add("hook")
            elif lbl == "setup": found.add("setup")
            elif lbl in ("main point", "main", "body"): found.add("main")
            elif lbl in ("climax", "peak", "payoff", "reveal"): found.add("climax")
            elif lbl == "conclusion": found.add("conclusion")
        return (float(len(found)), None)

    if key == "climax_late_flag":
        if not segments or not dur_s:
            return (None, "no segments or duration")
        climax_labels = {"climax", "peak", "payoff", "reveal"}
        climax_seg = next((s for s in segments if s.get("label", "").lower() in climax_labels), None)
        if not climax_seg:
            return (0.0, None)
        return (float(int(climax_seg.get("startTime", 0) > dur_s * 0.7)), None)

    if key == "last_segment_duration_pct":
        if not segments or not dur_s:
            return (None, "no segments or duration")
        last = segments[-1]
        d = last.get("endTime", 0) - last.get("startTime", 0)
        return (float(d / dur_s * 100), None)

    if key == "first_segment_duration_pct":
        if not segments or not dur_s:
            return (None, "no segments or duration")
        first = segments[0]
        d = first.get("endTime", 0) - first.get("startTime", 0)
        return (float(d / dur_s * 100), None)

    if key == "segment_length_ratio_max_min":
        if not segments or len(segments) < 2:
            return (None, "need 2+ segments")
        durs = [s.get("endTime", 0) - s.get("startTime", 0) for s in segments]
        mn = min(durs)
        return (float(max(durs) / (mn + 0.1)), None)

    if key == "body_segment_count":
        if not segments:
            return (0.0, None)
        bookends = {"hook", "conclusion"}
        ct = sum(1 for s in segments if s.get("label", "").lower() not in bookends)
        return (float(ct), None)

    if key == "hook_conclusion_combined_pct":
        if not segments or not dur_s:
            return (None, "no segments or duration")
        total = 0
        for s in segments:
            if s.get("label", "").lower() in ("hook", "conclusion"):
                total += s.get("endTime", 0) - s.get("startTime", 0)
        return (float(total / dur_s * 100), None)

    # ── NEW: Title & Metadata Advanced ───────────────────────────────────
    if key == "title_all_caps_word_count":
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        return (float(sum(1 for w in title.split() if w.isupper() and len(w) >= 2)), None)

    if key == "title_emoji_flag":
        title = meta.get("title", "")
        import unicodedata
        has_emoji = any(unicodedata.category(c).startswith(('So',)) for c in title) if title else False
        return (float(int(has_emoji)), None)

    if key == "title_contains_making":
        title = meta.get("title", "").lower()
        has = "making" in title or "made" in title
        return (float(int(has)), None)

    if key == "title_avg_word_length":
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        words_list = title.split()
        if not words_list:
            return (None, "empty title")
        return (float(sum(len(w) for w in words_list) / len(words_list)), None)

    if key == "title_starts_with_action":
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        first = title.split()[0].lower() if title.split() else ""
        is_action = first.endswith("ing") or first in ACTION_VERBS
        return (float(int(is_action)), None)

    if key == "duration_optimal_flag":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (float(int(40 <= dur <= 55)), None)

    if key == "duration_sweetspot_distance":
        dur = meta.get("duration", 0)
        if not dur:
            return (None, "no duration")
        return (float(abs(dur - 52)), None)

    if key == "description_word_count":
        desc = meta.get("description", "")
        return (float(len(desc.split())), None)

    if key == "is_vertical":
        vert = meta.get("isVertical")
        if vert is not None:
            return (float(int(vert)), None)
        w = meta.get("width", 0)
        h = meta.get("height", 0)
        if w and h:
            return (float(int(h > w)), None)
        return (None, "no size data")

    if key == "upload_month":
        date_str = meta.get("uploadDate", "")
        if len(date_str) >= 6:
            try:
                return (float(int(date_str[4:6])), None)
            except ValueError:
                pass
        return (None, "no upload date")

    # ── NEW: Visual Frame Advanced ───────────────────────────────────────
    _action_kw = {"action", "doing", "building", "making", "cutting", "testing",
                  "breaking", "hitting", "throwing", "pouring", "mixing", "crafting",
                  "pressing", "crushing", "drilling", "hammering", "welding",
                  "assembling", "pulling", "pushing", "lifting", "physical"}
    _workshop_kw = {"workshop", "workbench", "tools", "tool", "bench", "garage",
                    "lab", "laboratory", "studio", "workspace", "machinery"}
    _outdoor_kw = {"outdoor", "outside", "nature", "sky", "forest", "field",
                   "garden", "street", "road", "park", "beach", "mountain"}
    _dramatic_kw = {"dramatic", "intense", "powerful", "explosive", "impact",
                    "destruction", "fire", "explosion", "crash", "collision",
                    "shatter", "break", "smash", "burst"}

    def _frame_desc(f):
        return str(f.get("analysis", {}).get("sceneDescription", "")).lower()
    def _frame_vt(f):
        return str(f.get("analysis", {}).get("visualTechniques", "")).lower()
    def _has_face(f):
        return "face" in _frame_desc(f)
    def _has_action(f):
        desc = _frame_desc(f)
        return any(kw in desc for kw in _action_kw)
    def _has_text(f):
        return "text overlay" in _frame_vt(f) or "text overlay" in _frame_desc(f) or "text" in _frame_vt(f)

    if key == "opening_frame_has_text":
        if not frames:
            return (None, "no frames")
        return (float(int(_has_text(frames[0]))), None)

    if key == "opening_frame_has_face":
        if not frames:
            return (None, "no frames")
        return (float(int(_has_face(frames[0]))), None)

    if key == "action_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if _has_action(f))
        return (float(ct / len(frames)), None)

    if key == "workshop_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if any(kw in _frame_desc(f) for kw in _workshop_kw))
        return (float(ct / len(frames)), None)

    if key == "outdoor_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if any(kw in _frame_desc(f) for kw in _outdoor_kw))
        return (float(ct / len(frames)), None)

    if key == "face_alone_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if _has_face(f) and not _has_action(f))
        return (float(ct / len(frames)), None)

    if key == "face_with_action_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if _has_face(f) and _has_action(f))
        return (float(ct / len(frames)), None)

    if key == "object_focus_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if not _has_face(f))
        return (float(ct / len(frames)), None)

    if key == "text_overlay_early_pct":
        if not frames:
            return (None, "no frames")
        quarter = max(1, len(frames) // 4)
        early = frames[:quarter]
        ct = sum(1 for f in early if _has_text(f))
        return (float(ct / len(early)), None)

    if key == "dramatic_frame_pct":
        if not frames:
            return (None, "no frames")
        ct = sum(1 for f in frames if any(kw in _frame_desc(f) for kw in _dramatic_kw))
        return (float(ct / len(frames)), None)

    # ── NEW: AI Analysis Features ────────────────────────────────────────
    if key == "idea_word_count":
        idea = (ai.get("videoIdea", "") if isinstance(ai, dict) else "") or ""
        if not idea:
            return (None, "no video idea")
        return (float(len(idea.split())), None)

    if key == "idea_char_count":
        idea = (ai.get("videoIdea", "") if isinstance(ai, dict) else "") or ""
        if not idea:
            return (None, "no video idea")
        return (float(len(idea)), None)

    if key == "summary_word_count":
        summary = (ai.get("summary", "") if isinstance(ai, dict) else "") or ""
        if not summary:
            return (None, "no summary")
        return (float(len(summary.split())), None)

    if key == "idea_question_flag":
        idea = (ai.get("videoIdea", "") if isinstance(ai, dict) else "") or ""
        return (float(int("?" in idea)), None)

    if key == "idea_number_flag":
        idea = (ai.get("videoIdea", "") if isinstance(ai, dict) else "") or ""
        return (float(int(any(c.isdigit() for c in idea))), None)

    if key == "idea_contains_making":
        idea = ((ai.get("videoIdea", "") if isinstance(ai, dict) else "") or "").lower()
        has = any(w in idea for w in MAKING_CONCEPT_WORDS)
        return (float(int(has)), None)

    if key == "idea_contains_indestructible":
        idea = ((ai.get("videoIdea", "") if isinstance(ai, dict) else "") or "").lower()
        has = any(w in idea for w in INDESTRUCTIBLE_CONCEPT_WORDS)
        return (float(int(has)), None)

    # ── NEW: Crazy Pre-Upload Indicators ────────────────────────────────
    # Emotional/tension arc from transcript
    _tension_up = {"but", "however", "suddenly", "except", "until", "although",
                   "unfortunately", "surprisingly", "shocking", "insane", "crazy",
                   "impossible", "never", "worst", "hardest", "dangerous"}
    _tension_down = {"finally", "actually", "turns out", "so", "anyway",
                     "worked", "success", "easy", "simple", "done", "finished"}

    if key == "tension_word_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in _tension_up)
        return (float(ct / len(words_lower) * 100), None)

    if key == "resolution_word_density":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        ct = sum(1 for w in words_lower if w in _tension_down)
        return (float(ct / len(words_lower) * 100), None)

    if key == "tension_resolution_ratio":
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        t_ct = sum(1 for w in words_lower if w in _tension_up)
        r_ct = sum(1 for w in words_lower if w in _tension_down)
        return (float(t_ct / (r_ct + 1)), None)

    if key == "emotional_arc_swing":
        """Max tension buildup then release across transcript quarters."""
        if not transcript:
            return (None, "no transcript")
        words = transcript.lower().split()
        if len(words) < 20:
            return (None, "transcript too short")
        q_size = len(words) // 4
        quarters = [words[i*q_size:(i+1)*q_size] for i in range(4)]
        scores = []
        for q in quarters:
            t = sum(1 for w in q if w in _tension_up)
            r = sum(1 for w in q if w in _tension_down)
            scores.append(t - r)
        swing = max(scores) - min(scores)
        return (float(swing), None)

    if key == "hook_tension_density":
        hook_text = _get_hook_text()
        if not hook_text:
            return (None, "no hook text")
        words_lower = hook_text.lower().split()
        if not words_lower:
            return (None, "empty hook")
        ct = sum(1 for w in words_lower if w in _tension_up)
        return (float(ct / len(words_lower) * 100), None)

    # Verbal callback / repetition patterns
    if key == "repeated_phrase_count":
        if not transcript:
            return (None, "no transcript")
        words = transcript.lower().split()
        if len(words) < 10:
            return (None, "transcript too short")
        bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words)-1)]
        from collections import Counter
        freq = Counter(bigrams)
        repeated = sum(1 for v in freq.values() if v >= 3)
        return (float(repeated), None)

    if key == "vocabulary_richness_yule_k":
        """Yule's K measure — lower = richer vocabulary."""
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if len(words_lower) < 20:
            return (None, "transcript too short")
        from collections import Counter
        freq = Counter(words_lower)
        n = len(words_lower)
        freq_of_freq = Counter(freq.values())
        m2 = sum(i * i * fi for i, fi in freq_of_freq.items())
        k = 10000 * (m2 - n) / (n * n) if n > 0 else 0
        return (float(k), None)

    if key == "question_early_ratio":
        """Fraction of questions in first 25% of transcript."""
        if not transcript:
            return (None, "no transcript")
        sentences = re.split(r'[.!?]+', transcript)
        if len(sentences) < 4:
            return (None, "too few sentences")
        q1_end = len(sentences) // 4
        early_q = sum(1 for s in sentences[:q1_end] if '?' in s)
        total_q = transcript.count('?')
        return (float(early_q / (total_q + 1)), None)

    if key == "open_loop_count":
        """Count potential open loops: questions, 'but first', 'before that'."""
        if not transcript:
            return (None, "no transcript")
        t_lower = transcript.lower()
        patterns = ['but first', 'before that', 'before we', 'but before',
                    'first though', "here's the thing", 'the problem is',
                    'what if', "let's see", "wait", "hold on"]
        ct = sum(t_lower.count(p) for p in patterns)
        ct += transcript.count('?')
        return (float(ct), None)

    if key == "cliffhanger_density":
        """Phrases that create suspense per 100 words."""
        if not transcript:
            return (None, "no transcript")
        words = transcript.split()
        if not words:
            return (None, "empty transcript")
        t_lower = transcript.lower()
        cliff_phrases = ['you won\'t believe', 'wait for it', 'what happens next',
                        'and then', 'turns out', 'plot twist', 'but here\'s',
                        'the crazy thing', 'this is where', 'watch what happens']
        ct = sum(t_lower.count(p) for p in cliff_phrases)
        return (float(ct / len(words) * 100), None)

    # Visual rhythm and composition
    if key == "visual_monotony_score":
        """How repetitive are the frames? Lower unique scene ratio = more monotonous."""
        if not frames or len(frames) < 5:
            return (None, "too few frames")
        descs = [str(f.get("analysis", {}).get("sceneDescription", ""))[:40] for f in frames]
        consecutive_same = sum(1 for i in range(1, len(descs)) if descs[i] == descs[i-1])
        return (float(consecutive_same / (len(descs) - 1)), None)

    if key == "visual_variety_entropy":
        """Shannon entropy of scene types across frames."""
        if not frames or len(frames) < 5:
            return (None, "too few frames")
        descs = [str(f.get("analysis", {}).get("sceneDescription", ""))[:40] for f in frames]
        from collections import Counter
        freq = Counter(descs)
        total = len(descs)
        probs = [c / total for c in freq.values()]
        entropy = -sum(p * math.log2(p) for p in probs if p > 0)
        return (float(entropy), None)

    if key == "face_intro_delay_frames":
        """How many frames before first face appears."""
        if not frames:
            return (None, "no frames")
        for i, f in enumerate(frames):
            if "face" in str(f.get("analysis", {}).get("sceneDescription", "")).lower():
                return (float(i), None)
        return (float(len(frames)), None)

    if key == "visual_pacing_variance":
        """Variance of scene durations (consecutive same-scene runs)."""
        if not frames or len(frames) < 5:
            return (None, "too few frames")
        descs = [str(f.get("analysis", {}).get("sceneDescription", ""))[:60] for f in frames]
        run_lengths = []
        cur_run = 1
        for i in range(1, len(descs)):
            if descs[i] == descs[i-1]:
                cur_run += 1
            else:
                run_lengths.append(cur_run)
                cur_run = 1
        run_lengths.append(cur_run)
        if len(run_lengths) < 2:
            return (0.0, None)
        return (float(np.var(run_lengths)), None)

    # Golden ratio positioning
    if key == "golden_ratio_segment_flag":
        """Whether any segment boundary falls near 61.8% of video."""
        if not segments or not dur_s:
            return (None, "no segments or duration")
        golden = dur_s * 0.618
        for s in segments:
            if abs(s.get("startTime", 0) - golden) < dur_s * 0.05:
                return (1.0, None)
        return (0.0, None)

    if key == "hook_to_body_word_overlap":
        """Word overlap between hook and rest of transcript (semantic coherence)."""
        if not transcript or not dur_s:
            return (None, "no transcript")
        words = transcript.lower().split()
        if len(words) < 20:
            return (None, "transcript too short")
        hook_seg = next((s for s in segments if s.get("label", "").lower() == "hook"), None)
        if hook_seg and hook_seg.get("transcript"):
            hook_words = set(hook_seg["transcript"].lower().split())
        else:
            est = max(1, int(len(words) * 5 / dur_s))
            hook_words = set(words[:est])
        body_words = set(words) - hook_words
        if not hook_words or not body_words:
            return (0.0, None)
        overlap = len(hook_words & body_words) / len(hook_words)
        return (float(overlap), None)

    # Title creativity metrics
    if key == "title_uniqueness_score":
        """Number of uncommon words in title (>6 chars)."""
        title = meta.get("title", "")
        if not title:
            return (None, "no title")
        words = title.split()
        long_words = sum(1 for w in words if len(w) > 6)
        return (float(long_words), None)

    if key == "title_curiosity_gap_score":
        """Curiosity triggers: 'this', 'what', numbers, ellipsis, 'how'."""
        title = meta.get("title", "").lower()
        if not title:
            return (None, "no title")
        triggers = ['this', 'what', 'how', 'why', '...', 'secret', 'truth',
                    'never', 'impossible', 'insane', 'crazy']
        ct = sum(1 for t in triggers if t in title)
        ct += sum(1 for c in title if c.isdigit())
        return (float(ct), None)

    if key == "title_power_word_count":
        """Count of proven power words in title."""
        title = meta.get("title", "").lower()
        if not title:
            return (None, "no title")
        power_words = {"ultimate", "insane", "impossible", "indestructible",
                      "epic", "extreme", "massive", "strongest", "biggest",
                      "deadliest", "dangerous", "unbreakable", "world",
                      "challenge", "experiment", "test", "survive", "destroy"}
        words = set(title.split())
        return (float(len(words & power_words)), None)

    # Pacing and rhythm
    if key == "words_per_scene":
        """Average transcript words per visual scene."""
        if not transcript or not frames or len(frames) < 3:
            return (None, "missing data")
        descs = [str(f.get("analysis", {}).get("sceneDescription", ""))[:60] for f in frames]
        scene_count = 1 + sum(1 for i in range(1, len(descs)) if descs[i] != descs[i-1])
        word_count = len(transcript.split())
        return (float(word_count / scene_count), None)

    if key == "speech_silence_ratio":
        """Ratio of speaking time to silence time."""
        if len(timed_words) < 2 or not dur_s:
            return (None, "need timed words + duration")
        gaps = [timed_words[i+1]["timestamp"] - timed_words[i]["timestamp"]
                for i in range(len(timed_words)-1)
                if "timestamp" in timed_words[i] and "timestamp" in timed_words[i+1]]
        silence = sum(g for g in gaps if g > 0.5)
        speech = dur_s - silence
        return (float(speech / (silence + 0.1)), None)

    if key == "transcript_readability":
        """Approximate Flesch reading ease: 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)."""
        if not transcript:
            return (None, "no transcript")
        words = transcript.split()
        if len(words) < 10:
            return (None, "transcript too short")
        sentences = max(1, transcript.count('.') + transcript.count('!') + transcript.count('?'))
        # Approximate syllables: count vowel groups
        syllables = sum(max(1, len(re.findall(r'[aeiouy]+', w.lower()))) for w in words)
        score = 206.835 - 1.015 * (len(words) / sentences) - 84.6 * (syllables / len(words))
        return (float(score), None)

    if key == "energy_word_density":
        """Words conveying high energy/intensity per 100 words."""
        if not transcript:
            return (None, "no transcript")
        words_lower = transcript.lower().split()
        if not words_lower:
            return (None, "empty transcript")
        energy_words = {"insane", "crazy", "extreme", "intense", "massive",
                       "epic", "incredible", "amazing", "unbelievable", "powerful",
                       "explode", "destroy", "smash", "crush", "obliterate",
                       "launch", "blast", "fire", "wild", "huge"}
        ct = sum(1 for w in words_lower if w in energy_words)
        return (float(ct / len(words_lower) * 100), None)

    if key == "concept_density":
        """Unique nouns (capitalized words) per sentence — information density."""
        if not transcript:
            return (None, "no transcript")
        sentences = max(1, transcript.count('.') + transcript.count('!') + transcript.count('?'))
        words = transcript.split()
        caps = set(w for w in words if w[0].isupper() and len(w) > 1) if words else set()
        return (float(len(caps) / sentences), None)

    if key == "frame_text_variety":
        """Number of unique visual techniques mentioned across frames."""
        if not frames:
            return (None, "no frames")
        techniques = set()
        for f in frames:
            vt = str(f.get("analysis", {}).get("visualTechniques", ""))
            for part in re.split(r'[,;.]', vt):
                part = part.strip().lower()
                if part and len(part) > 3:
                    techniques.add(part)
        return (float(len(techniques)), None)

    if key == "description_link_count":
        """Number of URLs in video description."""
        desc = meta.get("description", "")
        if not desc:
            return (0.0, None)
        urls = re.findall(r'https?://\S+', desc)
        return (float(len(urls)), None)

    if key == "description_hashtag_count":
        desc = meta.get("description", "")
        if not desc:
            return (0.0, None)
        return (float(len(re.findall(r'#\w+', desc))), None)

    # ── NEW: Retention Curve Advanced ────────────────────────────────────
    if key == "hook_payoff_gap":
        if len(curve) < 95:
            return (None, "curve too short")
        hook_val = curve[10]["retention"] if len(curve) > 10 else None
        end_val = float(np.mean([p["retention"] for p in curve[95:]]))
        if hook_val is None:
            return (None, "no hook value")
        return (float(end_val - hook_val), None)

    if key == "end_recovery_score":
        if len(curve) < 95:
            return (None, "curve too short")
        n = len(curve)
        vals = [curve[i]["retention"] for i in range(80, min(95, n))]
        baseline = [1.0 - i / max(n - 1, 1) for i in range(80, min(95, n))]
        above = [vals[j] - baseline[j] for j in range(len(vals))]
        return (float(np.mean(above)), None)

    if key == "momentum_zone_length":
        if not curve:
            return (None, "no curve")
        n = len(curve)
        vals = [curve[i]["retention"] for i in range(n)]
        baseline = [1.0 - i / max(n - 1, 1) for i in range(n)]
        max_run, cur_run = 0, 0
        for i in range(n):
            if vals[i] >= baseline[i]:
                cur_run += 1
                max_run = max(max_run, cur_run)
            else:
                cur_run = 0
        return (float(max_run), None)

    if key == "retention_recovery_count":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        ct = sum(1 for i in range(2, len(vals))
                 if vals[i] > vals[i-1] and vals[i-1] < vals[i-2])
        return (float(ct), None)

    if key == "above_baseline_area":
        if not curve:
            return (None, "no curve")
        n = len(curve)
        vals = [curve[i]["retention"] for i in range(n)]
        baseline = [1.0 - i / max(n - 1, 1) for i in range(n)]
        area = sum(max(0, vals[i] - baseline[i]) for i in range(n))
        return (float(area), None)

    if key == "below_baseline_area":
        if not curve:
            return (None, "no curve")
        n = len(curve)
        vals = [curve[i]["retention"] for i in range(n)]
        baseline = [1.0 - i / max(n - 1, 1) for i in range(n)]
        area = sum(max(0, baseline[i] - vals[i]) for i in range(n))
        return (float(area), None)

    if key == "late_drop_severity":
        if len(curve) < 60:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve[60:]]
        drops = [vals[i-1] - vals[i] for i in range(1, len(vals)) if vals[i] < vals[i-1]]
        return (float(np.mean(drops) if drops else 0.0), None)

    if key == "retention_concavity":
        if len(curve) < 3:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        second_deriv = [vals[i+1] + vals[i-1] - 2*vals[i] for i in range(1, len(vals)-1)]
        return (float(np.mean(second_deriv)), None)

    if key == "retention_quartile_spread":
        if len(curve) < 100:
            return (None, "curve too short")
        q1_mean = np.mean([p["retention"] for p in curve[:25]])
        q4_mean = np.mean([p["retention"] for p in curve[75:]])
        return (float(q4_mean / (q1_mean + 0.01)), None)

    if key == "early_late_drop_ratio":
        if len(curve) < 60:
            return (None, "curve too short")
        vals = [p["retention"] for p in curve]
        early_drops = [vals[i-1] - vals[i] for i in range(1, 30) if vals[i] < vals[i-1]]
        late_drops = [vals[i-1] - vals[i] for i in range(70, len(vals)) if vals[i] < vals[i-1]]
        early_mean = np.mean(early_drops) if early_drops else 0.001
        late_mean = np.mean(late_drops) if late_drops else 0.0
        return (float(late_mean / (early_mean + 0.001)), None)

    # ── NEW: Post-Upload Analytics Advanced ──────────────────────────────
    if key == "engagement_rate":
        total = analytics.get("totalViews", 0) or 0
        if not total:
            return (None, "no views")
        likes = analytics.get("likes", 0) or 0
        comments = analytics.get("comments", 0) or 0
        shares = analytics.get("shares", 0) or 0
        return (float((likes + comments + shares) / total * 1000), None)

    if key == "like_to_comment_ratio":
        likes = analytics.get("likes", 0) or 0
        comments = analytics.get("comments", 0) or 0
        return (float(likes / (comments + 1)), None)

    if key == "sub_nonsub_retention_gap":
        sub_pct = analytics.get("subscriberAvgPercent")
        nonsub_pct = analytics.get("nonSubscriberAvgPercent")
        if sub_pct is None or nonsub_pct is None:
            return (None, "missing sub/nonsub retention")
        return (float(sub_pct - nonsub_pct), None)

    if key == "retention_variation_raw":
        v = analytics.get("retentionVariation")
        return (float(v), None) if v is not None else (None, "no retentionVariation")

    if key == "avg_percent_viewed":
        v = analytics.get("avgPercentViewed")
        return (float(v), None) if v is not None else (None, "no avgPercentViewed")

    if key == "engaged_view_rate":
        total = analytics.get("totalViews", 0) or 0
        engaged = analytics.get("engagedViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float(engaged / total), None)

    if key == "sub_view_fraction":
        total = analytics.get("totalViews", 0) or 0
        sub_v = analytics.get("subscriberViews", 0) or 0
        if not total:
            return (None, "no views")
        return (float(sub_v / total), None)

    if key == "view_day1_share":
        if not daily or len(daily) < 7:
            return (None, "insufficient daily views")
        w1 = sum(d.get("views", 0) for d in daily[:7])
        d1 = daily[0].get("views", 0)
        if w1 == 0:
            return (None, "no week 1 views")
        return (float(d1 / w1), None)

    if key == "view_week3_week1_ratio":
        if len(daily) < 21:
            return (None, "insufficient daily views")
        w1 = sum(d.get("views", 0) for d in daily[:7])
        w3 = sum(d.get("views", 0) for d in daily[14:21])
        return (float(w3 / (w1 + 1)), None)

    if key == "daily_views_entropy":
        if not daily or len(daily) < 7:
            return (None, "insufficient daily views")
        views_30 = [d.get("views", 0) for d in daily[:30]]
        total_v = sum(views_30)
        if total_v == 0:
            return (0.0, None)
        probs = [v / total_v for v in views_30 if v > 0]
        entropy = -sum(p * math.log2(p) for p in probs)
        return (float(entropy), None)

    if key == "daily_views_gini":
        if not daily or len(daily) < 7:
            return (None, "insufficient daily views")
        views_30 = sorted([d.get("views", 0) for d in daily[:30]])
        n = len(views_30)
        total_v = sum(views_30)
        if total_v == 0:
            return (0.0, None)
        cumulative = 0
        gini_sum = 0
        for i, v in enumerate(views_30):
            cumulative += v
            gini_sum += (2 * (i + 1) - n - 1) * v
        gini = gini_sum / (n * total_v)
        return (float(gini), None)

    if key == "stayed_to_watch_rate":
        sr = analytics.get("swipeRatio", {})
        if isinstance(sr, dict):
            v = sr.get("stayedToWatch")
            if v is not None:
                return (float(v), None)
        return (None, "no swipeRatio data")

    if key == "avg_view_duration_s":
        v = analytics.get("avgViewDuration")
        return (float(v), None) if v is not None else (None, "no avgViewDuration")

    # Interaction terms: keyA_x_keyB
    m = re.match(r'^(.+)_x_(.+)$', key)
    if m:
        a_key, b_key = m.group(1), m.group(2)
        # Verify both are real keys
        if get_metric_definition(a_key) and get_metric_definition(b_key):
            va, skip_a = extract_metric(a_key, analysis)
            vb, skip_b = extract_metric(b_key, analysis)
            if va is not None and vb is not None:
                return (float(va * vb), None)
            return (None, skip_a or skip_b or "missing component")

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
    """Step 3: Look up metric definition (static or generated)."""
    return get_metric_definition(key)


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
    # New pre-upload: transcript / language → r0
    'transcript_char_count':  ('r0',         0,   100,  None,  None),
    'avg_word_length':        ('r0',         0,   100,  None,  None),
    'unique_word_ratio':      ('r0',         0,   100,  None,  None),
    'sentence_count':         ('r0',         0,   100,  None,  None),
    'exclamation_count':      ('r0',         0,   100,  None,  None),
    'uppercase_word_ratio':   ('r0',         0,   100,  None,  None),
    'transcript_number_count':('r0',         0,   100,  None,  None),
    # New pre-upload: hook-specific → r_hook
    'hook_question_count':    ('r_hook',     0,   10,   None,  None),
    'hook_word_ratio':        ('r_hook',     0,   10,   None,  None),
    'hook_char_count':        ('r_hook',     0,   10,   None,  None),
    'hook_duration_pct':      ('r_hook',     0,   10,   None,  None),
    'hook_position_s':        ('r_hook',     0,   10,   None,  None),
    # New pre-upload: structure → r0
    'avg_segment_duration_s': ('r0',         0,   100,  None,  None),
    'longest_segment_duration_s': ('r0',     0,   100,  None,  None),
    'shortest_segment_duration_s': ('r0',    0,   100,  None,  None),
    'climax_position_pct':    ('r0',         0,   100,  None,  None),
    'has_climax_segment':     ('r0',         0,   100,  None,  None),
    'hook_to_climax_gap_s':   ('r0',         0,   100,  None,  None),
    # New pre-upload: metadata → r0
    'duration_s':             ('r0',         0,   100,  None,  None),
    'title_char_count':       ('r0',         0,   100,  None,  None),
    'title_word_count':       ('r0',         0,   100,  None,  None),
    'title_question_flag':    ('r0',         0,   100,  None,  None),
    'title_exclamation_flag': ('r0',         0,   100,  None,  None),
    'title_number_flag':      ('r0',         0,   100,  None,  None),
    # New pre-upload: visual → r0
    'scene_change_rate':      ('r0',         0,   100,  None,  None),
    'unique_scene_ratio':     ('r0',         0,   100,  None,  None),
    'visual_technique_count_mean': ('r0',    0,   100,  None,  None),
    'close_up_frame_pct':     ('r0',         0,   100,  None,  None),
    'hand_presence_frame_pct':('r0',         0,   100,  None,  None),
    'motion_word_frame_pct':  ('r0',         0,   100,  None,  None),
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
    # Look up the correct resolution for this indicator (static or generated)
    res_info = get_resolution_for_key(key)
    resolution_id = res_info[0]
    exists = any(r["id"] == resolution_id for r in resolutions)
    if not exists:
        # Create the shelf from static map or generate dynamically
        defn = DEFAULT_RESOLUTION_DEFS.get(resolution_id)
        if not defn:
            _, sp, ep, sd, ed = res_info
            if sp is not None and ep is not None:
                if sp == ep:
                    label = f"{sp}% Point"
                    desc = f"Single-point measurement at {sp}% through the video."
                    gran = "video_window"
                else:
                    label = f"{sp}-{ep}% of Video"
                    desc = f"Retention window from {sp}% to {ep}% of video."
                    gran = "whole" if (sp == 0 and ep == 100) else "video_window"
            elif sd is not None and ed is not None:
                label = f"Days {sd}-{ed}"
                desc = f"View data from day {sd} to day {ed} after upload."
                gran = "time_window"
            else:
                label = resolution_id
                desc = "Auto-generated resolution shelf."
                gran = "whole"
            defn = {
                "id": resolution_id, "label": label, "description": desc,
                "start_pct": sp, "end_pct": ep, "start_day": sd, "end_day": ed,
                "granularity": gran,
            }
        new_shelf = {
            **defn,
            "created_from": "pipeline",
            "created_at": now_iso(),
            "indicator_keys": [],
            "depth_in_hierarchy": 0 if resolution_id == 'r0' else 1,
        }
        resolutions.append(new_shelf)
        # Sort by start_pct (video-position shelves first, then time-based)
        resolutions.sort(key=lambda r: (r.get('start_pct') if r.get('start_pct') is not None else 999, r['id']))
        print(f"  [RESOLVE]    *** New resolution shelf created: {resolution_id} ({defn['label']}) ***")
    for r in resolutions:
        if r["id"] == resolution_id:
            if key not in r.get("indicator_keys", []):
                r.setdefault("indicator_keys", []).append(key)
            break
    # Gap check (skip time-based resolutions where start_pct is None)
    video_res = [r for r in resolutions if r.get("start_pct") is not None and r.get("end_pct") is not None]
    sorted_res = sorted(video_res, key=lambda r: r.get("start_pct", 0))
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

    defn = get_metric_definition(key) or {}
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


# ── Graph helpers ─────────────────────────────────────────────────────────
def _rebuild_connections(graph):
    """Rebuild node.connections from edges + derived_edges (mirrors JS rebuildConnections)."""
    conn = {}
    for e in graph.get("edges", []):
        conn.setdefault(e["from"], set()).add(e["to"])
        conn.setdefault(e["to"], set()).add(e["from"])
    for de in graph.get("derived_edges", []):
        conn.setdefault(de["from"], set()).add(de["to"])
        conn.setdefault(de["to"], set()).add(de["from"])
        if de.get("target"):
            conn.setdefault(de["from"], set()).add(de["target"])
            conn.setdefault(de["to"], set()).add(de["target"])
        for ck in de.get("component_keys", []):
            conn.setdefault(ck, set())
            for ck2 in de.get("component_keys", []):
                if ck2 != ck:
                    conn[ck].add(ck2)
    for node in graph.get("nodes", []):
        node["connections"] = list(conn.get(node["key"], set()))


# ── New experiment families ───────────────────────────────────────────────

def _extract_two_vectors(key_a, key_b, videos, target="views"):
    """Extract paired float vectors for two indicator keys across all videos.
    Returns (xa, xb, y_views, n) where y_views is log10(viewCount).
    Any video missing either value is skipped."""
    xa_list, xb_list, y_list = [], [], []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        vb, _ = extract_metric(key_b, vid)
        if va is None or vb is None:
            continue
        if isinstance(va, float) and (math.isnan(va) or math.isinf(va)):
            continue
        if isinstance(vb, float) and (math.isnan(vb) or math.isinf(vb)):
            continue
        xa_list.append(float(va))
        xb_list.append(float(vb))
        y_list.append(float(math.log10(vc)))
    xa = np.array(xa_list, dtype=float)
    xb = np.array(xb_list, dtype=float)
    y = np.array(y_list, dtype=float)
    return xa, xb, y, len(xa)


def run_pair_correlation(key_a, key_b, videos):
    """Pair correlation: Pearson + Spearman between indicator A and indicator B
    (not vs views). Returns a derived experiment dict or None."""
    xa, xb, _, n = _extract_two_vectors(key_a, key_b, videos)
    if n < 50:
        print(f"  [PAIR_CORR] SKIP: n={n} < 50 for {key_a} <-> {key_b}")
        return None
    mask = ~(np.isnan(xa) | np.isnan(xb) | np.isinf(xa) | np.isinf(xb))
    xa, xb = xa[mask], xb[mask]
    n = len(xa)
    if n < 50:
        return None

    r, p = pearsonr(xa, xb)
    rho, p_rho = spearmanr(xa, xb)
    z = 0.5 * math.log((1 + r + 1e-10) / (1 - r + 1e-10))
    se = 1.0 / math.sqrt(max(n - 3, 1))
    ci_low = math.tanh(z - 1.96 * se)
    ci_high = math.tanh(z + 1.96 * se)

    abs_r = abs(r)
    direction = "positive" if r >= 0 else "negative"
    strength = ("strong" if abs_r >= 0.5 else "moderate" if abs_r >= 0.3
                else "weak" if abs_r >= 0.1 else "none")

    exp_id = f"exp_pair_{key_a}__{key_b}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer_a = (get_metric_definition(key_a) or {}).get("layer", "post")
    layer_b = (get_metric_definition(key_b) or {}).get("layer", "post")
    bridge = (layer_a != layer_b)

    print(f"  [PAIR_CORR] {key_a} <-> {key_b}: r={r:+.3f}, rho={rho:+.3f}, n={n}, bridge={bridge}")

    return {
        "id": exp_id,
        "key": f"pair_corr__{key_a}__{key_b}",
        "kind": "pair_correlation",
        "component_keys": [key_a, key_b],
        "target": None,  # symmetric pair, no target
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "pearson_r",
            "tool_name": "Pair Correlation",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "r": float(r), "p_value": float(p), "n": int(n),
                "ci_low": float(ci_low), "ci_high": float(ci_high),
                "rho": float(rho), "p_rho": float(p_rho),
            },
        },
        "result": {
            "primary_r": float(r),
            "rho": float(rho),
            "p_value": float(p),
            "ci_low": float(ci_low),
            "ci_high": float(ci_high),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "bridge": bridge,
        "layer_a": layer_a,
        "layer_b": layer_b,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_conditional_delta(key_a, key_b, videos):
    """Conditional delta to views: split by median(B), compute r(A, views) in
    each bucket, store delta_r. Deterministic, no ML."""
    xa, xb, y, n = _extract_two_vectors(key_a, key_b, videos)
    if n < 80:  # need ~40 per bucket
        print(f"  [COND_DELTA] SKIP: n={n} < 80 for {key_a}|{key_b}")
        return None
    mask = ~(np.isnan(xa) | np.isnan(xb) | np.isnan(y) | np.isinf(xa) | np.isinf(xb) | np.isinf(y))
    xa, xb, y = xa[mask], xb[mask], y[mask]
    n = len(xa)
    if n < 80:
        return None

    median_b = float(np.median(xb))
    hi_mask = xb >= median_b
    lo_mask = ~hi_mask
    n_hi, n_lo = int(hi_mask.sum()), int(lo_mask.sum())
    if n_hi < 25 or n_lo < 25:
        print(f"  [COND_DELTA] SKIP: bucket too small (hi={n_hi}, lo={n_lo})")
        return None

    r_hi, _ = pearsonr(xa[hi_mask], y[hi_mask])
    r_lo, _ = pearsonr(xa[lo_mask], y[lo_mask])
    delta_r = float(r_hi - r_lo)

    abs_delta = abs(delta_r)
    direction = "amplified_high" if delta_r > 0 else "amplified_low"
    strength = ("strong" if abs_delta >= 0.3 else "moderate" if abs_delta >= 0.15
                else "weak" if abs_delta >= 0.05 else "none")

    exp_id = f"exp_cond_{key_a}_given_{key_b}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer_a = (get_metric_definition(key_a) or {}).get("layer", "post")
    layer_b = (get_metric_definition(key_b) or {}).get("layer", "post")

    print(f"  [COND_DELTA] {key_a}|{key_b}: r_hi={r_hi:+.3f}, r_lo={r_lo:+.3f}, "
          f"delta={delta_r:+.3f} [{strength}]")

    return {
        "id": exp_id,
        "key": f"cond_delta__{key_a}__given__{key_b}",
        "kind": "conditional_delta_to_views",
        "component_keys": [key_a, key_b],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "conditional_split",
            "tool_name": "Conditional Delta",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "r_high_bucket": float(r_hi),
                "r_low_bucket": float(r_lo),
                "delta_r": float(delta_r),
                "median_b": float(median_b),
                "n_high": n_hi,
                "n_low": n_lo,
            },
        },
        "result": {
            "delta_r": float(delta_r),
            "r_high_bucket": float(r_hi),
            "r_low_bucket": float(r_lo),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer_a": layer_a,
        "layer_b": layer_b,
        "bridge": (layer_a != layer_b),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_depth3_interaction(key_a, key_b, key_c, videos, tools):
    """Depth-3 interaction: a*b*c → views. Bounded, only called for pre-selected triples."""
    xa, xb, y, n_ab = _extract_two_vectors(key_a, key_b, videos)
    if n_ab < 50:
        return None
    # Also need key_c
    xc_list = []
    y_list = []
    xa_list = []
    xb_list = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        vb, _ = extract_metric(key_b, vid)
        v_c, _ = extract_metric(key_c, vid)
        if va is None or vb is None or v_c is None:
            continue
        vals = [float(va), float(vb), float(v_c)]
        if any(math.isnan(v) or math.isinf(v) for v in vals):
            continue
        xa_list.append(vals[0])
        xb_list.append(vals[1])
        xc_list.append(vals[2])
        y_list.append(float(math.log10(vc)))

    n = len(xa_list)
    if n < 50:
        print(f"  [DEPTH3] SKIP: n={n} < 50")
        return None

    interaction_vals = np.array(xa_list) * np.array(xb_list) * np.array(xc_list)
    y_arr = np.array(y_list)
    mask = ~(np.isnan(interaction_vals) | np.isinf(interaction_vals))
    interaction_vals, y_arr = interaction_vals[mask], y_arr[mask]
    n = len(interaction_vals)
    if n < 50:
        return None

    r, p = pearsonr(interaction_vals, y_arr)
    rho, p_rho = spearmanr(interaction_vals, y_arr)
    z = 0.5 * math.log((1 + r + 1e-10) / (1 - r + 1e-10))
    se = 1.0 / math.sqrt(max(n - 3, 1))
    ci_low = math.tanh(z - 1.96 * se)
    ci_high = math.tanh(z + 1.96 * se)

    abs_r = abs(r)
    direction = "positive" if r >= 0 else "negative"
    strength = ("strong" if abs_r >= 0.5 else "moderate" if abs_r >= 0.3
                else "weak" if abs_r >= 0.1 else "none")

    ikey = f"{key_a}_x_{key_b}_x_{key_c}"
    exp_id = f"exp_d3_{key_a}__{key_b}__{key_c}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"

    print(f"  [DEPTH3] {ikey}: r={r:+.3f}, rho={rho:+.3f}, n={n} [{strength}]")

    return {
        "id": exp_id,
        "key": ikey,
        "kind": "depth3_interaction_to_views",
        "component_keys": [key_a, key_b, key_c],
        "target": "views",
        "depth": 3,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "pearson_r",
            "tool_name": "Depth-3 Interaction",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "r": float(r), "p_value": float(p), "n": int(n),
                "ci_low": float(ci_low), "ci_high": float(ci_high),
                "rho": float(rho), "p_rho": float(p_rho),
            },
        },
        "result": {
            "primary_r": float(r),
            "rho": float(rho),
            "p_value": float(p),
            "ci_low": float(ci_low),
            "ci_high": float(ci_high),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


# ── Non-linear experiment families ───────────────────────────────────────

def run_rank_pair_correlation(key_a, key_b, videos):
    """Rank-based (Spearman) pair correlation between A and B.
    Captures monotonic non-linear relationships that Pearson misses.
    Primary metric is rho (Spearman), with Pearson for comparison."""
    xa, xb, _, n = _extract_two_vectors(key_a, key_b, videos)
    if n < 50:
        return None
    mask = ~(np.isnan(xa) | np.isnan(xb) | np.isinf(xa) | np.isinf(xb))
    xa, xb = xa[mask], xb[mask]
    n = len(xa)
    if n < 50:
        return None

    rho, p_rho = spearmanr(xa, xb)
    r, p_r = pearsonr(xa, xb)

    # Fisher z-transform for Spearman CI
    z = 0.5 * math.log((1 + rho + 1e-10) / (1 - rho + 1e-10))
    se = 1.0 / math.sqrt(max(n - 3, 1))
    ci_low = math.tanh(z - 1.96 * se)
    ci_high = math.tanh(z + 1.96 * se)

    # Nonlinearity gap: how much rank-based exceeds linear
    nonlinearity_gap = abs(rho) - abs(r)

    abs_rho = abs(rho)
    direction = "positive" if rho >= 0 else "negative"
    strength = ("strong" if abs_rho >= 0.5 else "moderate" if abs_rho >= 0.3
                else "weak" if abs_rho >= 0.1 else "none")

    exp_id = f"exp_rank_pair_{key_a}__{key_b}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer_a = (get_metric_definition(key_a) or {}).get("layer", "post")
    layer_b = (get_metric_definition(key_b) or {}).get("layer", "post")
    bridge = (layer_a != layer_b)

    print(f"  [RANK_PAIR] {key_a} <-> {key_b}: rho={rho:+.3f}, r={r:+.3f}, "
          f"gap={nonlinearity_gap:+.3f}, n={n}, bridge={bridge}")

    return {
        "id": exp_id,
        "key": f"rank_pair__{key_a}__{key_b}",
        "kind": "rank_pair_correlation",
        "component_keys": [key_a, key_b],
        "target": None,
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "spearman_rho",
            "tool_name": "Rank Pair Correlation",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "rho": float(rho), "p_rho": float(p_rho),
                "r": float(r), "p_value": float(p_r),
                "ci_low": float(ci_low), "ci_high": float(ci_high),
                "nonlinearity_gap": float(nonlinearity_gap),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(rho),  # primary metric is rho for rank-based
            "rho": float(rho),
            "pearson_r": float(r),
            "nonlinearity_gap": float(nonlinearity_gap),
            "p_value": float(p_rho),
            "ci_low": float(ci_low),
            "ci_high": float(ci_high),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "bridge": bridge,
        "layer_a": layer_a,
        "layer_b": layer_b,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_bucketed_curve(key_a, videos):
    """Bucketed curve analysis: split indicator A into quantile buckets,
    compute mean views per bucket, derive monotonicity score and bucket span.
    Captures non-linear staircase/threshold relationships with views."""
    vals = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        if va is None:
            continue
        fv = float(va)
        if math.isnan(fv) or math.isinf(fv):
            continue
        vals.append((fv, math.log10(vc)))
    n = len(vals)
    if n < 60:
        print(f"  [BUCKET] SKIP: n={n} < 60 for {key_a}")
        return None

    vals.sort(key=lambda x: x[0])
    N_BUCKETS = 5
    bucket_size = n // N_BUCKETS
    if bucket_size < 10:
        return None

    bucket_means = []
    bucket_ranges = []
    for i in range(N_BUCKETS):
        start = i * bucket_size
        end = start + bucket_size if i < N_BUCKETS - 1 else n
        bucket = vals[start:end]
        mean_views = sum(v for _, v in bucket) / len(bucket)
        bucket_means.append(mean_views)
        bucket_ranges.append((bucket[0][0], bucket[-1][0]))

    # Monotonicity score: fraction of consecutive bucket pairs that are monotonic
    mono_up = sum(1 for i in range(len(bucket_means) - 1)
                  if bucket_means[i + 1] > bucket_means[i])
    mono_down = sum(1 for i in range(len(bucket_means) - 1)
                    if bucket_means[i + 1] < bucket_means[i])
    mono_score = max(mono_up, mono_down) / (N_BUCKETS - 1)
    mono_direction = "positive" if mono_up >= mono_down else "negative"

    # Bucket span: range of mean views across buckets
    bucket_span = max(bucket_means) - min(bucket_means)

    # Effect size via correlation of bucket index vs mean views (for strength)
    from scipy.stats import pearsonr as _pr
    idx = np.arange(N_BUCKETS, dtype=float)
    bm = np.array(bucket_means, dtype=float)
    r_bucket, p_bucket = _pr(idx, bm)

    abs_r = abs(r_bucket)
    strength = ("strong" if abs_r >= 0.9 else "moderate" if abs_r >= 0.7
                else "weak" if abs_r >= 0.4 else "none")

    exp_id = f"exp_bucket_{key_a}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer = (get_metric_definition(key_a) or {}).get("layer", "post")

    print(f"  [BUCKET] {key_a}: mono={mono_score:.2f} ({mono_direction}), "
          f"span={bucket_span:.3f}, r_bucket={r_bucket:+.3f}, n={n}")

    return {
        "id": exp_id,
        "key": f"bucket_curve__{key_a}",
        "kind": "bucketed_curve_to_views",
        "component_keys": [key_a],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "bucketed_curve",
            "tool_name": "Bucketed Curve to Views",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "n_buckets": N_BUCKETS,
                "bucket_means": [round(m, 4) for m in bucket_means],
                "bucket_ranges": [[round(lo, 4), round(hi, 4)] for lo, hi in bucket_ranges],
                "monotonic_score": round(mono_score, 4),
                "mono_direction": mono_direction,
                "bucket_span": round(bucket_span, 4),
                "r_bucket": float(r_bucket),
                "p_bucket": float(p_bucket),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(r_bucket),
            "monotonic_score": round(mono_score, 4),
            "bucket_span": round(bucket_span, 4),
            "direction": mono_direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer": layer,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_piecewise_to_views(key_a, videos):
    """Piecewise linearity test: compare slope of A→views in lower half vs upper half.
    Detects threshold/saturation effects where the relationship changes shape."""
    vals = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        if va is None:
            continue
        fv = float(va)
        if math.isnan(fv) or math.isinf(fv):
            continue
        vals.append((fv, math.log10(vc)))
    n = len(vals)
    if n < 60:
        print(f"  [PIECEWISE] SKIP: n={n} < 60 for {key_a}")
        return None

    vals.sort(key=lambda x: x[0])
    mid = n // 2
    lo_x = np.array([v[0] for v in vals[:mid]])
    lo_y = np.array([v[1] for v in vals[:mid]])
    hi_x = np.array([v[0] for v in vals[mid:]])
    hi_y = np.array([v[1] for v in vals[mid:]])

    if len(lo_x) < 20 or len(hi_x) < 20:
        return None

    r_lo, p_lo = pearsonr(lo_x, lo_y)
    r_hi, p_hi = pearsonr(hi_x, hi_y)
    nonlinearity_delta = float(r_hi - r_lo)

    # Full correlation for reference
    all_x = np.array([v[0] for v in vals])
    all_y = np.array([v[1] for v in vals])
    r_full, p_full = pearsonr(all_x, all_y)

    abs_delta = abs(nonlinearity_delta)
    if nonlinearity_delta > 0:
        direction = "stronger_high"  # relationship strengthens for higher values
    else:
        direction = "stronger_low"   # relationship strengthens for lower values

    strength = ("strong" if abs_delta >= 0.3 else "moderate" if abs_delta >= 0.15
                else "weak" if abs_delta >= 0.05 else "none")

    exp_id = f"exp_piecewise_{key_a}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer = (get_metric_definition(key_a) or {}).get("layer", "post")

    print(f"  [PIECEWISE] {key_a}: r_lo={r_lo:+.3f}, r_hi={r_hi:+.3f}, "
          f"delta={nonlinearity_delta:+.3f}, r_full={r_full:+.3f}, n={n}")

    return {
        "id": exp_id,
        "key": f"piecewise__{key_a}",
        "kind": "piecewise_to_views",
        "component_keys": [key_a],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "piecewise_split",
            "tool_name": "Piecewise to Views",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "r_lower_half": float(r_lo),
                "r_upper_half": float(r_hi),
                "p_lower": float(p_lo),
                "p_upper": float(p_hi),
                "nonlinearity_delta": float(nonlinearity_delta),
                "r_full": float(r_full),
                "p_full": float(p_full),
                "split_point": float(vals[mid][0]),
                "n_lower": len(lo_x),
                "n_upper": len(hi_x),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(r_full),
            "r_lower_half": float(r_lo),
            "r_upper_half": float(r_hi),
            "nonlinearity_delta": float(nonlinearity_delta),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer": layer,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_threshold_delta(key_a, videos):
    """Threshold delta: split indicator into quartiles, measure views correlation
    per segment. Identifies which quartile transition shows the biggest effect change."""
    vals = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        if va is None:
            continue
        fv = float(va)
        if math.isnan(fv) or math.isinf(fv):
            continue
        vals.append((fv, math.log10(vc)))
    n = len(vals)
    if n < 80:
        print(f"  [THRESH] SKIP: n={n} < 80 for {key_a}")
        return None

    vals.sort(key=lambda x: x[0])
    q1_idx = n // 4
    q2_idx = n // 2
    q3_idx = 3 * n // 4
    segments = [vals[:q1_idx], vals[q1_idx:q2_idx], vals[q2_idx:q3_idx], vals[q3_idx:]]

    seg_r = []
    for seg in segments:
        if len(seg) < 15:
            return None
        x = np.array([v[0] for v in seg])
        y = np.array([v[1] for v in seg])
        if np.std(x) < 1e-10:
            seg_r.append(0.0)
        else:
            r_s, _ = pearsonr(x, y)
            seg_r.append(float(r_s))

    deltas = [seg_r[i + 1] - seg_r[i] for i in range(3)]
    max_delta_idx = max(range(3), key=lambda i: abs(deltas[i]))
    max_quartile_delta = deltas[max_delta_idx]
    breakpoint_label = ["Q1_Q2", "Q2_Q3", "Q3_Q4"][max_delta_idx]

    all_x = np.array([v[0] for v in vals])
    all_y = np.array([v[1] for v in vals])
    r_full, p_full = pearsonr(all_x, all_y)

    abs_delta = abs(max_quartile_delta)
    direction = "threshold_up" if max_quartile_delta > 0 else "threshold_down"
    strength = ("strong" if abs_delta >= 0.3 else "moderate" if abs_delta >= 0.15
                else "weak" if abs_delta >= 0.05 else "none")

    exp_id = f"exp_thresh_{key_a}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer = (get_metric_definition(key_a) or {}).get("layer", "post")

    print(f"  [THRESH] {key_a}: max_delta={max_quartile_delta:+.3f} at {breakpoint_label}, "
          f"r_full={r_full:+.3f}, n={n}")

    return {
        "id": exp_id,
        "key": f"thresh_delta__{key_a}",
        "kind": "threshold_delta_to_views",
        "component_keys": [key_a],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "threshold_delta",
            "tool_name": "Threshold Delta to Views",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "segment_r": [round(r, 4) for r in seg_r],
                "quartile_deltas": [round(d, 4) for d in deltas],
                "max_quartile_delta": round(max_quartile_delta, 4),
                "breakpoint_label": breakpoint_label,
                "r_full": float(r_full),
                "p_full": float(p_full),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(r_full),
            "max_quartile_delta": round(max_quartile_delta, 4),
            "breakpoint_label": breakpoint_label,
            "segment_r": [round(r, 4) for r in seg_r],
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer": layer,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_quantile_gap(key_a, videos):
    """Top/bottom quantile gap: compare mean log_views in top 25% vs bottom 25%
    of indicator A. Simple, inspectable effect size measure."""
    vals = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        if va is None:
            continue
        fv = float(va)
        if math.isnan(fv) or math.isinf(fv):
            continue
        vals.append((fv, math.log10(vc)))
    n = len(vals)
    if n < 60:
        print(f"  [QGAP] SKIP: n={n} < 60 for {key_a}")
        return None

    vals.sort(key=lambda x: x[0])
    q_size = n // 4
    if q_size < 10:
        return None

    bottom_q = vals[:q_size]
    top_q = vals[-q_size:]
    bottom_mean = sum(v[1] for v in bottom_q) / len(bottom_q)
    top_mean = sum(v[1] for v in top_q) / len(top_q)
    gap = top_mean - bottom_mean

    mid_views = [v[1] for v in vals[q_size:-q_size]]
    mid_mean = sum(mid_views) / len(mid_views) if mid_views else (top_mean + bottom_mean) / 2

    all_x = np.array([v[0] for v in vals])
    all_y = np.array([v[1] for v in vals])
    r_full, p_full = pearsonr(all_x, all_y)

    abs_gap = abs(gap)
    direction = "top_higher" if gap > 0 else "bottom_higher"
    strength = ("strong" if abs_gap >= 0.5 else "moderate" if abs_gap >= 0.25
                else "weak" if abs_gap >= 0.1 else "none")

    exp_id = f"exp_qgap_{key_a}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer = (get_metric_definition(key_a) or {}).get("layer", "post")

    print(f"  [QGAP] {key_a}: gap={gap:+.3f} ({direction}), top={top_mean:.3f}, "
          f"bottom={bottom_mean:.3f}, n={n}")

    return {
        "id": exp_id,
        "key": f"quantile_gap__{key_a}",
        "kind": "quantile_gap_to_views",
        "component_keys": [key_a],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "quantile_gap",
            "tool_name": "Top/Bottom Quantile Gap",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "gap": round(gap, 4),
                "top_mean": round(top_mean, 4),
                "bottom_mean": round(bottom_mean, 4),
                "mid_mean": round(mid_mean, 4),
                "r_full": float(r_full),
                "p_full": float(p_full),
                "n": int(n),
                "q_size": q_size,
            },
        },
        "result": {
            "primary_r": float(r_full),
            "gap": round(gap, 4),
            "top_mean": round(top_mean, 4),
            "bottom_mean": round(bottom_mean, 4),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer": layer,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_residual_pair(key_a, key_b, videos):
    """Residual pair: after removing A's linear effect on views, does B still
    have signal in the residuals? Tests incremental predictive value."""
    xa, xb, y, n = _extract_two_vectors(key_a, key_b, videos)
    if n < 60:
        print(f"  [RESID] SKIP: n={n} < 60 for {key_a},{key_b}")
        return None
    mask = ~(np.isnan(xa) | np.isnan(xb) | np.isnan(y) |
             np.isinf(xa) | np.isinf(xb) | np.isinf(y))
    xa, xb, y = xa[mask], xb[mask], y[mask]
    n = len(xa)
    if n < 60:
        return None

    r_a_views, _ = pearsonr(xa, y)
    r_b_views, _ = pearsonr(xb, y)

    slope_a = np.polyfit(xa, y, 1)[0] if np.std(xa) > 1e-10 else 0
    intercept_a = np.mean(y) - slope_a * np.mean(xa)
    residuals = y - (slope_a * xa + intercept_a)

    if np.std(residuals) < 1e-10:
        return None
    r_residual, p_residual = pearsonr(xb, residuals)
    incremental = abs(r_residual)

    abs_r = abs(r_residual)
    direction = "positive_residual" if r_residual >= 0 else "negative_residual"
    strength = ("strong" if abs_r >= 0.3 else "moderate" if abs_r >= 0.15
                else "weak" if abs_r >= 0.05 else "none")

    exp_id = f"exp_resid_{key_a}__{key_b}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer_a = (get_metric_definition(key_a) or {}).get("layer", "post")
    layer_b = (get_metric_definition(key_b) or {}).get("layer", "post")
    bridge = (layer_a != layer_b)

    print(f"  [RESID] {key_b} after removing {key_a}: r_resid={r_residual:+.3f}, "
          f"r_raw_b={r_b_views:+.3f}, n={n}, bridge={bridge}")

    return {
        "id": exp_id,
        "key": f"resid_pair__{key_a}__{key_b}",
        "kind": "residual_pair_to_views",
        "component_keys": [key_a, key_b],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "residual_pair",
            "tool_name": "Residual Pair to Views",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "r_residual": float(r_residual),
                "p_residual": float(p_residual),
                "r_a_views": float(r_a_views),
                "r_b_views": float(r_b_views),
                "incremental_signal": round(incremental, 4),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(r_residual),
            "r_residual": float(r_residual),
            "r_a_views": float(r_a_views),
            "r_b_views": float(r_b_views),
            "incremental_signal": round(incremental, 4),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "bridge": bridge,
        "layer_a": layer_a,
        "layer_b": layer_b,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_monotonic_consistency(key_a, videos):
    """Monotonic bucket consistency: test if the bucket curve holds across
    3, 5, and 7 bucket resolutions. High consistency = robust signal."""
    vals = []
    for vid in videos:
        vc = vid.get("metadata", {}).get("viewCount", 0)
        if not vc:
            continue
        va, _ = extract_metric(key_a, vid)
        if va is None:
            continue
        fv = float(va)
        if math.isnan(fv) or math.isinf(fv):
            continue
        vals.append((fv, math.log10(vc)))
    n = len(vals)
    if n < 70:
        print(f"  [MONOCON] SKIP: n={n} < 70 for {key_a}")
        return None

    vals.sort(key=lambda x: x[0])

    def _bucket_mono(n_buckets):
        bsize = n // n_buckets
        if bsize < 8:
            return None
        means = []
        for i in range(n_buckets):
            start = i * bsize
            end = start + bsize if i < n_buckets - 1 else n
            bucket = vals[start:end]
            means.append(sum(v[1] for v in bucket) / len(bucket))
        up = sum(1 for i in range(len(means) - 1) if means[i + 1] > means[i])
        down = sum(1 for i in range(len(means) - 1) if means[i + 1] < means[i])
        return max(up, down) / (n_buckets - 1)

    mono_scores = {}
    for nb in [3, 5, 7]:
        score = _bucket_mono(nb)
        if score is None:
            return None
        mono_scores[nb] = score

    consistency = min(mono_scores.values())
    avg_mono = sum(mono_scores.values()) / len(mono_scores)

    all_x = np.array([v[0] for v in vals])
    all_y = np.array([v[1] for v in vals])
    r_full, p_full = pearsonr(all_x, all_y)

    direction = "consistent_positive" if r_full >= 0 else "consistent_negative"
    strength = ("strong" if consistency >= 0.9 else "moderate" if consistency >= 0.7
                else "weak" if consistency >= 0.5 else "none")

    exp_id = f"exp_monocon_{key_a}_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    layer = (get_metric_definition(key_a) or {}).get("layer", "post")

    print(f"  [MONOCON] {key_a}: consistency={consistency:.2f}, "
          f"avg_mono={avg_mono:.2f}, r_full={r_full:+.3f}, n={n}")

    return {
        "id": exp_id,
        "key": f"mono_consist__{key_a}",
        "kind": "monotonic_bucket_consistency",
        "component_keys": [key_a],
        "target": "views",
        "depth": 2,
        "resolution_id": "r0",
        "experiment": {
            "id": exp_id,
            "tool_id": "monotonic_consistency",
            "tool_name": "Monotonic Bucket Consistency",
            "ran_at": now_iso(),
            "n_videos": int(n),
            "outputs": {
                "mono_3": round(mono_scores[3], 4),
                "mono_5": round(mono_scores[5], 4),
                "mono_7": round(mono_scores[7], 4),
                "consistency": round(consistency, 4),
                "avg_mono": round(avg_mono, 4),
                "r_full": float(r_full),
                "p_full": float(p_full),
                "n": int(n),
            },
        },
        "result": {
            "primary_r": float(r_full),
            "consistency": round(consistency, 4),
            "avg_mono": round(avg_mono, 4),
            "mono_3": round(mono_scores[3], 4),
            "mono_5": round(mono_scores[5], 4),
            "mono_7": round(mono_scores[7], 4),
            "direction": direction,
            "strength_label": strength,
            "status": "discovery",
        },
        "layer": layer,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def _add_derived_edge(graph, derived_exp):
    """Add a derived_edge to graph from a derived experiment result."""
    if "derived_edges" not in graph:
        graph["derived_edges"] = []
    kind = derived_exp["kind"]
    exp_key = derived_exp["key"]

    # Remove any prior edge with same key
    graph["derived_edges"] = [e for e in graph["derived_edges"]
                               if e.get("experiment_key") != exp_key
                               and e.get("interaction_key") != exp_key]

    ck = derived_exp["component_keys"]
    # For single-component families (bucketed_curve, piecewise), edge goes A → views
    target = derived_exp.get("target")
    if len(ck) == 1:
        edge_from, edge_to = ck[0], target or "views"
    else:
        edge_from, edge_to = ck[0], ck[1]

    base_edge = {
        "from": edge_from,
        "to": edge_to,
        "kind": kind,
        "depth": derived_exp["depth"],
        "target": target,
        "experiment_key": exp_key,
        "experiment_id": derived_exp["experiment"]["id"],
        "component_keys": ck,
        "added_at": now_iso(),
    }

    if kind == "pair_correlation":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["rho"] = derived_exp["result"]["rho"]
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
        base_edge["bridge"] = derived_exp.get("bridge", False)
    elif kind == "rank_pair_correlation":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["rho"] = derived_exp["result"]["rho"]
        base_edge["pearson_r"] = derived_exp["result"].get("pearson_r")
        base_edge["nonlinearity_gap"] = derived_exp["result"].get("nonlinearity_gap", 0)
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
        base_edge["bridge"] = derived_exp.get("bridge", False)
    elif kind == "interaction_to_views":
        base_edge["interaction_key"] = exp_key
        base_edge["interaction_r"] = derived_exp["result"]["primary_r"]
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "conditional_delta_to_views":
        base_edge["delta_r"] = derived_exp["result"]["delta_r"]
        base_edge["r_high_bucket"] = derived_exp["result"]["r_high_bucket"]
        base_edge["r_low_bucket"] = derived_exp["result"]["r_low_bucket"]
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "bucketed_curve_to_views":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["monotonic_score"] = derived_exp["result"].get("monotonic_score")
        base_edge["bucket_span"] = derived_exp["result"].get("bucket_span")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "piecewise_to_views":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["r_lower_half"] = derived_exp["result"].get("r_lower_half")
        base_edge["r_upper_half"] = derived_exp["result"].get("r_upper_half")
        base_edge["nonlinearity_delta"] = derived_exp["result"].get("nonlinearity_delta")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "depth3_interaction_to_views":
        base_edge["to"] = ck[1]  # connect first two, third in component_keys
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "threshold_delta_to_views":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["max_quartile_delta"] = derived_exp["result"].get("max_quartile_delta")
        base_edge["breakpoint_label"] = derived_exp["result"].get("breakpoint_label")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "quantile_gap_to_views":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["gap"] = derived_exp["result"].get("gap")
        base_edge["top_mean"] = derived_exp["result"].get("top_mean")
        base_edge["bottom_mean"] = derived_exp["result"].get("bottom_mean")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
    elif kind == "residual_pair_to_views":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["r_residual"] = derived_exp["result"].get("r_residual")
        base_edge["r_a_views"] = derived_exp["result"].get("r_a_views")
        base_edge["r_b_views"] = derived_exp["result"].get("r_b_views")
        base_edge["incremental_signal"] = derived_exp["result"].get("incremental_signal")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]
        base_edge["bridge"] = derived_exp.get("bridge", False)
    elif kind == "monotonic_bucket_consistency":
        base_edge["primary_r"] = derived_exp["result"]["primary_r"]
        base_edge["consistency"] = derived_exp["result"].get("consistency")
        base_edge["avg_mono"] = derived_exp["result"].get("avg_mono")
        base_edge["strength_label"] = derived_exp["result"]["strength_label"]
        base_edge["direction"] = derived_exp["result"]["direction"]

    graph["derived_edges"].append(base_edge)
    _rebuild_connections(graph)
    graph["updated_at"] = now_iso()


# ── Bounded candidate generation for new experiment families ──────────────

def _get_top_indicators(indicators, n=25):
    """Return top-N indicators by |r|, preferring bridge (cross-layer) diversity."""
    sorted_inds = sorted(indicators,
                         key=lambda i: abs(i.get("result", {}).get("primary_r") or 0),
                         reverse=True)
    # Filter to atomic only (no _x_ keys)
    atomic = [i for i in sorted_inds if "_x_" not in i["key"]]
    return atomic[:n]


def _get_bridge_pairs(indicators, max_pairs=60):
    """Generate pre<->post indicator pairs, biased toward strongest signals."""
    pre = [i for i in indicators if i.get("layer") == "pre"
           and "_x_" not in i["key"]
           and abs(i.get("result", {}).get("primary_r") or 0) >= 0.05]
    post = [i for i in indicators if i.get("layer") == "post"
            and "_x_" not in i["key"]
            and abs(i.get("result", {}).get("primary_r") or 0) >= 0.05]
    # Sort both by |r| descending
    pre.sort(key=lambda i: abs(i["result"].get("primary_r") or 0), reverse=True)
    post.sort(key=lambda i: abs(i["result"].get("primary_r") or 0), reverse=True)
    pairs = []
    # Top pre × top post, bounded
    for p in pre[:15]:
        for q in post[:15]:
            pairs.append((p["key"], q["key"]))
            if len(pairs) >= max_pairs:
                return pairs
    return pairs


def _get_resolution_diverse_top(indicators, n=30):
    """Return top indicators with resolution diversity: mix of R0, R1, R2, R3.
    Ensures we don't over-represent one resolution shelf."""
    atomic = [i for i in indicators if "_x_" not in i["key"]
              and abs(i.get("result", {}).get("primary_r") or 0) >= 0.05]
    atomic.sort(key=lambda i: abs(i["result"].get("primary_r") or 0), reverse=True)
    # Group by resolution
    by_res = {}
    for i in atomic:
        res = i.get("resolution_id", "r0")
        by_res.setdefault(res, []).append(i)
    # Round-robin from each resolution shelf
    result = []
    seen = set()
    round_idx = 0
    while len(result) < n:
        added_this_round = False
        for res in sorted(by_res.keys()):
            if round_idx < len(by_res[res]):
                ind = by_res[res][round_idx]
                if ind["key"] not in seen:
                    result.append(ind)
                    seen.add(ind["key"])
                    added_this_round = True
                if len(result) >= n:
                    break
        round_idx += 1
        if not added_this_round:
            break
    return result


def generate_derived_candidates(indicators, existing_derived_keys):
    """Generate bounded deterministic candidates for all experiment families.
    Returns dict: {kind: [(key_a, key_b, ...), ...]}"""
    candidates = {
        "pair_correlation": [],
        "conditional_delta_to_views": [],
        "depth3_interaction_to_views": [],
        "rank_pair_correlation": [],
        "bucketed_curve_to_views": [],
        "piecewise_to_views": [],
        "threshold_delta_to_views": [],
        "quantile_gap_to_views": [],
        "residual_pair_to_views": [],
        "monotonic_bucket_consistency": [],
    }

    top = _get_top_indicators(indicators, n=40)
    top_keys = [i["key"] for i in top]
    top_diverse = _get_resolution_diverse_top(indicators, n=50)

    # ── pair_correlation: among top indicators + cross-layer bridge pairs ──
    bridge_pairs = _get_bridge_pairs(indicators, max_pairs=100)
    seen_pc = set()
    for a, b in bridge_pairs:
        pk = f"pair_corr__{a}__{b}"
        rpk = f"pair_corr__{b}__{a}"
        if pk not in existing_derived_keys and rpk not in existing_derived_keys:
            if (a, b) not in seen_pc and (b, a) not in seen_pc:
                candidates["pair_correlation"].append((a, b))
                seen_pc.add((a, b))

    for i, a in enumerate(top_keys):
        for b in top_keys[i + 1:]:
            pk = f"pair_corr__{a}__{b}"
            rpk = f"pair_corr__{b}__{a}"
            if pk not in existing_derived_keys and rpk not in existing_derived_keys:
                if (a, b) not in seen_pc and (b, a) not in seen_pc:
                    candidates["pair_correlation"].append((a, b))
                    seen_pc.add((a, b))
            if len(candidates["pair_correlation"]) >= 100:
                break
        if len(candidates["pair_correlation"]) >= 100:
            break

    # ── conditional_delta: bridge pairs + top cross-family ──
    seen_cd = set()
    for a, b in bridge_pairs[:40]:
        ck = f"cond_delta__{a}__given__{b}"
        if ck not in existing_derived_keys and (a, b) not in seen_cd:
            candidates["conditional_delta_to_views"].append((a, b))
            seen_cd.add((a, b))
        ck2 = f"cond_delta__{b}__given__{a}"
        if ck2 not in existing_derived_keys and (b, a) not in seen_cd:
            candidates["conditional_delta_to_views"].append((b, a))
            seen_cd.add((b, a))
        if len(candidates["conditional_delta_to_views"]) >= 80:
            break

    # ── depth3: only from top 15 strongest, bounded to 40 triples ──
    # Prefer triples with at least one bridge (cross-layer) indicator
    d3_keys = [i["key"] for i in top[:15]]
    d3_layers = {i["key"]: i.get("layer", "post") for i in top[:15]}
    seen_d3 = set()
    # First pass: triples with cross-layer members
    for i, a in enumerate(d3_keys):
        for j, b in enumerate(d3_keys[i + 1:], start=i + 1):
            for c in d3_keys[j + 1:]:
                layers = {d3_layers.get(a), d3_layers.get(b), d3_layers.get(c)}
                if len(layers) < 2:
                    continue  # skip same-layer triples in first pass
                triple = tuple(sorted([a, b, c]))
                tk = f"{triple[0]}_x_{triple[1]}_x_{triple[2]}"
                if tk not in existing_derived_keys and triple not in seen_d3:
                    candidates["depth3_interaction_to_views"].append((a, b, c))
                    seen_d3.add(triple)
                if len(candidates["depth3_interaction_to_views"]) >= 30:
                    break
            if len(candidates["depth3_interaction_to_views"]) >= 30:
                break
        if len(candidates["depth3_interaction_to_views"]) >= 30:
            break
    # Second pass: fill remaining with any triples
    if len(candidates["depth3_interaction_to_views"]) < 40:
        for i, a in enumerate(d3_keys):
            for j, b in enumerate(d3_keys[i + 1:], start=i + 1):
                for c in d3_keys[j + 1:]:
                    triple = tuple(sorted([a, b, c]))
                    tk = f"{triple[0]}_x_{triple[1]}_x_{triple[2]}"
                    if tk not in existing_derived_keys and triple not in seen_d3:
                        candidates["depth3_interaction_to_views"].append((a, b, c))
                        seen_d3.add(triple)
                    if len(candidates["depth3_interaction_to_views"]) >= 40:
                        break
                if len(candidates["depth3_interaction_to_views"]) >= 40:
                    break
            if len(candidates["depth3_interaction_to_views"]) >= 40:
                break

    # ── rank_pair_correlation: bridge pairs where non-linear signal likely ──
    # Prioritize pairs where existing Pearson pair_corr has |r| < 0.3
    # (monotonic non-linear relationships are most interesting when Pearson is weak)
    seen_rpc = set()
    for a, b in bridge_pairs:
        pk = f"rank_pair__{a}__{b}"
        rpk = f"rank_pair__{b}__{a}"
        if pk not in existing_derived_keys and rpk not in existing_derived_keys:
            if (a, b) not in seen_rpc and (b, a) not in seen_rpc:
                candidates["rank_pair_correlation"].append((a, b))
                seen_rpc.add((a, b))
        if len(candidates["rank_pair_correlation"]) >= 60:
            break
    # Also add top-indicator same-layer pairs
    for i, a in enumerate(top_keys):
        for b in top_keys[i + 1:]:
            pk = f"rank_pair__{a}__{b}"
            rpk = f"rank_pair__{b}__{a}"
            if pk not in existing_derived_keys and rpk not in existing_derived_keys:
                if (a, b) not in seen_rpc and (b, a) not in seen_rpc:
                    candidates["rank_pair_correlation"].append((a, b))
                    seen_rpc.add((a, b))
            if len(candidates["rank_pair_correlation"]) >= 80:
                break
        if len(candidates["rank_pair_correlation"]) >= 80:
            break

    # ── bucketed_curve_to_views: top indicators + resolution-diverse set ──
    seen_bc = set()
    for ind in top_diverse:
        k = ind["key"]
        bk = f"bucket_curve__{k}"
        if bk not in existing_derived_keys and k not in seen_bc:
            candidates["bucketed_curve_to_views"].append((k,))
            seen_bc.add(k)
        if len(candidates["bucketed_curve_to_views"]) >= 50:
            break

    # ── piecewise_to_views: top indicators, prioritize those with |r| 0.1-0.4 ──
    # (piecewise is most interesting for moderate correlations that might be non-linear)
    piecewise_pool = [i for i in top_diverse
                      if 0.05 <= abs(i.get("result", {}).get("primary_r") or 0) <= 0.5]
    seen_pw = set()
    for ind in piecewise_pool:
        k = ind["key"]
        pk = f"piecewise__{k}"
        if pk not in existing_derived_keys and k not in seen_pw:
            candidates["piecewise_to_views"].append((k,))
            seen_pw.add(k)
        if len(candidates["piecewise_to_views"]) >= 40:
            break

    # ── threshold_delta_to_views: single-indicator quartile threshold analysis ──
    seen_td = set()
    for ind in top_diverse:
        k = ind["key"]
        tk = f"thresh_delta__{k}"
        if tk not in existing_derived_keys and k not in seen_td:
            candidates["threshold_delta_to_views"].append((k,))
            seen_td.add(k)
        if len(candidates["threshold_delta_to_views"]) >= 50:
            break

    # ── quantile_gap_to_views: top/bottom 25% mean views gap ──
    seen_qg = set()
    for ind in top_diverse:
        k = ind["key"]
        qk = f"quantile_gap__{k}"
        if qk not in existing_derived_keys and k not in seen_qg:
            candidates["quantile_gap_to_views"].append((k,))
            seen_qg.add(k)
        if len(candidates["quantile_gap_to_views"]) >= 50:
            break

    # ── residual_pair_to_views: bridge pairs, test incremental value of B over A ──
    seen_rp = set()
    for a, b in bridge_pairs:
        rk = f"resid_pair__{a}__{b}"
        if rk not in existing_derived_keys and (a, b) not in seen_rp:
            candidates["residual_pair_to_views"].append((a, b))
            seen_rp.add((a, b))
        rk2 = f"resid_pair__{b}__{a}"
        if rk2 not in existing_derived_keys and (b, a) not in seen_rp:
            candidates["residual_pair_to_views"].append((b, a))
            seen_rp.add((b, a))
        if len(candidates["residual_pair_to_views"]) >= 80:
            break

    # ── monotonic_bucket_consistency: multi-resolution consistency check ──
    seen_mc = set()
    for ind in top_diverse:
        k = ind["key"]
        mk = f"mono_consist__{k}"
        if mk not in existing_derived_keys and k not in seen_mc:
            candidates["monotonic_bucket_consistency"].append((k,))
            seen_mc.add(k)
        if len(candidates["monotonic_bucket_consistency"]) >= 50:
            break

    total = sum(len(v) for v in candidates.values())
    parts = ", ".join(f"{k}={len(v)}" for k, v in candidates.items())
    print(f"  [DERIVED CANDIDATES] {parts} (total={total})")
    return candidates


# ── Derived experiment runner ─────────────────────────────────────────────

def cmd_derived_run(max_per_kind=None, kinds=None):
    """Run new experiment families: pair_correlation, conditional_delta, depth3.
    Also retroactively tags existing interaction_to_views experiments."""
    indicators = load_json(INDICATORS_FILE, [])
    derived = load_json(DERIVED_EXPERIMENTS_FILE, [])
    tools = load_json(TOOLS_FILE, [])
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": [], "derived_edges": []})
    videos = load_videos()
    if not videos:
        print("ERROR: No videos loaded")
        return

    existing_derived_keys = {d["key"] for d in derived}
    all_kinds = kinds or ["pair_correlation", "conditional_delta_to_views",
                          "depth3_interaction_to_views",
                          "rank_pair_correlation", "bucketed_curve_to_views",
                          "piecewise_to_views",
                          "threshold_delta_to_views", "quantile_gap_to_views",
                          "residual_pair_to_views", "monotonic_bucket_consistency"]
    limit = max_per_kind or 50

    print(f"\n{'=' * 60}")
    print(f"DERIVED EXPERIMENT RUN")
    print(f"  kinds={all_kinds}, max_per_kind={limit}")
    print(f"  existing derived: {len(derived)}")
    print(f"{'=' * 60}")

    # ── Step 0: normalize depth + kind for all derived experiments ──
    # Depth rules:
    #   atomic → views = depth 1
    #   pair_correlation A↔B = depth 2
    #   interaction_to_views A×B→views = depth 2
    #   conditional_delta_to_views A|B→views = depth 2
    #   rank_pair_correlation A↔B = depth 2
    #   bucketed_curve_to_views A→views = depth 2
    #   piecewise_to_views A→views = depth 2
    #   depth3_interaction_to_views A×B×C→views = depth 3
    DEPTH_BY_KIND = {
        "interaction_to_views": 2,
        "pair_correlation": 2,
        "conditional_delta_to_views": 2,
        "rank_pair_correlation": 2,
        "bucketed_curve_to_views": 2,
        "piecewise_to_views": 2,
        "depth3_interaction_to_views": 3,
        "threshold_delta_to_views": 2,
        "quantile_gap_to_views": 2,
        "residual_pair_to_views": 2,
        "monotonic_bucket_consistency": 2,
    }
    upgraded = 0
    depth_fixed = 0
    for d in derived:
        changed = False
        # Legacy kind migration
        if d.get("kind") == "interaction" or (not d.get("kind") and "_x_" in d.get("key", "")):
            d["kind"] = "interaction_to_views"
            changed = True
        if "component_keys" not in d:
            m = re.match(r'^(.+)_x_(.+)$', d.get("key", ""))
            if m:
                d["component_keys"] = [m.group(1), m.group(2)]
                changed = True
        # Enforce correct depth for all kinds
        correct_depth = DEPTH_BY_KIND.get(d.get("kind"), 2)
        if d.get("depth") != correct_depth:
            d["depth"] = correct_depth
            depth_fixed += 1
            changed = True
        if changed:
            upgraded += 1
    # Also normalize graph derived_edges
    for de in graph.get("derived_edges", []):
        if de.get("kind") == "interaction":
            de["kind"] = "interaction_to_views"
        correct_depth = DEPTH_BY_KIND.get(de.get("kind"), 2)
        if de.get("depth") != correct_depth:
            de["depth"] = correct_depth
    if upgraded:
        print(f"  Normalized {upgraded} derived experiments ({depth_fixed} depth fixes)")
        save_json(DERIVED_EXPERIMENTS_FILE, derived)
        save_json(GRAPH_FILE, graph)
        existing_derived_keys = {d["key"] for d in derived}

    candidates = generate_derived_candidates(indicators, existing_derived_keys)

    completed = {k: 0 for k in all_kinds}

    # ── pair_correlation ──
    if "pair_correlation" in all_kinds:
        print(f"\n--- pair_correlation ({len(candidates.get('pair_correlation', []))} candidates) ---")
        for key_a, key_b in candidates.get("pair_correlation", []):
            if completed["pair_correlation"] >= limit:
                break
            result = run_pair_correlation(key_a, key_b, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["pair_correlation"] += 1

    # ── conditional_delta_to_views ──
    if "conditional_delta_to_views" in all_kinds:
        print(f"\n--- conditional_delta_to_views ({len(candidates.get('conditional_delta_to_views', []))} candidates) ---")
        for key_a, key_b in candidates.get("conditional_delta_to_views", []):
            if completed["conditional_delta_to_views"] >= limit:
                break
            result = run_conditional_delta(key_a, key_b, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["conditional_delta_to_views"] += 1

    # ── depth3_interaction_to_views ──
    if "depth3_interaction_to_views" in all_kinds:
        print(f"\n--- depth3_interaction_to_views ({len(candidates.get('depth3_interaction_to_views', []))} candidates) ---")
        for key_a, key_b, key_c in candidates.get("depth3_interaction_to_views", []):
            if completed["depth3_interaction_to_views"] >= limit:
                break
            result = run_depth3_interaction(key_a, key_b, key_c, videos, tools)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["depth3_interaction_to_views"] += 1

    # ── rank_pair_correlation ──
    if "rank_pair_correlation" in all_kinds:
        print(f"\n--- rank_pair_correlation ({len(candidates.get('rank_pair_correlation', []))} candidates) ---")
        for key_a, key_b in candidates.get("rank_pair_correlation", []):
            if completed["rank_pair_correlation"] >= limit:
                break
            result = run_rank_pair_correlation(key_a, key_b, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["rank_pair_correlation"] += 1

    # ── bucketed_curve_to_views ──
    if "bucketed_curve_to_views" in all_kinds:
        print(f"\n--- bucketed_curve_to_views ({len(candidates.get('bucketed_curve_to_views', []))} candidates) ---")
        for (key_a,) in candidates.get("bucketed_curve_to_views", []):
            if completed["bucketed_curve_to_views"] >= limit:
                break
            result = run_bucketed_curve(key_a, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["bucketed_curve_to_views"] += 1

    # ── piecewise_to_views ──
    if "piecewise_to_views" in all_kinds:
        print(f"\n--- piecewise_to_views ({len(candidates.get('piecewise_to_views', []))} candidates) ---")
        for (key_a,) in candidates.get("piecewise_to_views", []):
            if completed["piecewise_to_views"] >= limit:
                break
            result = run_piecewise_to_views(key_a, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["piecewise_to_views"] += 1

    # ── threshold_delta_to_views ──
    if "threshold_delta_to_views" in all_kinds:
        print(f"\n--- threshold_delta_to_views ({len(candidates.get('threshold_delta_to_views', []))} candidates) ---")
        for (key_a,) in candidates.get("threshold_delta_to_views", []):
            if completed["threshold_delta_to_views"] >= limit:
                break
            result = run_threshold_delta(key_a, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["threshold_delta_to_views"] += 1

    # ── quantile_gap_to_views ──
    if "quantile_gap_to_views" in all_kinds:
        print(f"\n--- quantile_gap_to_views ({len(candidates.get('quantile_gap_to_views', []))} candidates) ---")
        for (key_a,) in candidates.get("quantile_gap_to_views", []):
            if completed["quantile_gap_to_views"] >= limit:
                break
            result = run_quantile_gap(key_a, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["quantile_gap_to_views"] += 1

    # ── residual_pair_to_views ──
    if "residual_pair_to_views" in all_kinds:
        print(f"\n--- residual_pair_to_views ({len(candidates.get('residual_pair_to_views', []))} candidates) ---")
        for key_a, key_b in candidates.get("residual_pair_to_views", []):
            if completed["residual_pair_to_views"] >= limit:
                break
            result = run_residual_pair(key_a, key_b, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["residual_pair_to_views"] += 1

    # ── monotonic_bucket_consistency ──
    if "monotonic_bucket_consistency" in all_kinds:
        print(f"\n--- monotonic_bucket_consistency ({len(candidates.get('monotonic_bucket_consistency', []))} candidates) ---")
        for (key_a,) in candidates.get("monotonic_bucket_consistency", []):
            if completed["monotonic_bucket_consistency"] >= limit:
                break
            result = run_monotonic_consistency(key_a, videos)
            if result:
                derived.append(result)
                _add_derived_edge(graph, result)
                completed["monotonic_bucket_consistency"] += 1

    # ── Save all ──
    save_json(DERIVED_EXPERIMENTS_FILE, derived)
    save_json(GRAPH_FILE, graph)

    total = sum(completed.values())
    print(f"\n{'=' * 60}")
    print(f"DERIVED RUN COMPLETE")
    for k, v in completed.items():
        if v > 0:
            print(f"  {k}: {v}")
    print(f"  total new: {total}")
    print(f"  derived experiments now: {len(derived)}")
    print(f"  graph derived_edges now: {len(graph.get('derived_edges', []))}")
    print(f"{'=' * 60}")
    return completed


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

    # Check if this is an interaction/composite key (a_x_b)
    m = re.match(r'^(.+)_x_(.+)$', key)
    if m:
        # Composite: add derived edge, no fake atomic node
        a_key, b_key = m.group(1), m.group(2)
        if "derived_edges" not in graph:
            graph["derived_edges"] = []
        graph["derived_edges"] = [e for e in graph["derived_edges"]
                                   if e.get("interaction_key") != key]
        graph["derived_edges"].append({
            "from": a_key,
            "to": b_key,
            "kind": "interaction_to_views",
            "target": target,
            "depth": 2,
            "interaction_key": key,
            "interaction_r": indicator["result"]["primary_r"],
            "component_keys": [a_key, b_key],
            "experiment_id": indicator["experiment"]["id"],
            "strength_label": indicator["result"]["strength_label"],
            "direction": indicator["result"]["direction"],
            "added_at": now_iso(),
        })
        _rebuild_connections(graph)
        graph["updated_at"] = now_iso()
        save_json(GRAPH_FILE, graph)
        print(f"  [GRAPH]     Derived edge: {a_key} × {b_key} → '{target}', depth=2")
        return

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
    _rebuild_connections(graph)
    graph["updated_at"] = now_iso()
    save_json(GRAPH_FILE, graph)
    print(f"  [GRAPH]     Node added, depth={depth}, connected to '{target}'")


def step_get_comparison_target(graph):
    """Step 9 (EXPAND): views is the only graph root — all indicators correlate to views."""
    n_ind = sum(1 for n in graph["nodes"] if n["type"] == "indicator")
    target = "views"
    print(f"  [EXPAND]    target='views' ({n_ind} indicator nodes in graph)")
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

    is_interaction = bool(re.match(r'^(.+)_x_(.+)$', key))
    depth = 2 if is_interaction else 1

    indicator = {
        "key": key,
        "label": key.replace("_", " ").title(),
        "layer": metric_def.get("layer", "post"),
        "status": result["status"],
        "resolution_id": resolution_id,
        "depth": depth,
        "target": target,
        "metric_definition": metric_def,
        "dataset": dataset,
        "experiment": exp,
        "result": result,
        "connections": [target],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    # Add interaction-specific fields
    if is_interaction:
        m = re.match(r'^(.+)_x_(.+)$', key)
        indicator["kind"] = "interaction_to_views"
        indicator["component_keys"] = [m.group(1), m.group(2)]

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
        sorted_inds = sorted(indicators, key=lambda i: abs(i.get("result", {}).get("primary_r") or 0), reverse=True)
        for ind in sorted_inds[:15]:
            r = ind["result"].get("primary_r") or 0
            sl = ind["result"].get("strength_label", "?")
            print(f"    {ind['key']:40s} r={r:+.3f}  [{sl}]")


def cmd_graph():
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": [], "derived_edges": []})
    de = graph.get("derived_edges", [])
    kinds = {}
    for e in de:
        k = e.get("kind", "unknown")
        kinds[k] = kinds.get(k, 0) + 1
    print(f"\nGraph: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
          f"{len(de)} derived_edges")
    if kinds:
        print(f"  Derived edge kinds: {kinds}")
    print("\nNodes:")
    for n in sorted(graph["nodes"], key=lambda n: (n.get("depth", 0), n.get("key", ""))):
        r = n.get("r_partial")
        r_str = f"r={r:+.3f}" if r is not None else "r=N/A"
        print(f"  [{n.get('type', '?'):10s}] depth={n.get('depth', 0)}  {n['key']:40s} {r_str}")
    print("\nEdges:")
    for e in graph["edges"]:
        r = e.get('r') or 0
        print(f"  {e['from']:40s} → {e['to']}  (r={r:+.3f})")
    if de:
        print(f"\nDerived Edges (showing last 10):")
        for e in de[-10:]:
            kind = e.get("kind", "?")
            depth = e.get("depth", "?")
            r = e.get("primary_r") or e.get("interaction_r") or e.get("delta_r") or 0
            ck = e.get("component_keys", [e["from"], e["to"]])
            print(f"  [{kind:30s}] d{depth}  {' × '.join(ck):50s} r={r:+.3f}")


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
            if result.get("kind") == "interaction_to_views":
                derived = load_json(DERIVED_EXPERIMENTS_FILE, [])
                derived.append(result)
                save_json(DERIVED_EXPERIMENTS_FILE, derived)
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
        if result.get("kind") == "interaction_to_views":
            derived = load_json(DERIVED_EXPERIMENTS_FILE, [])
            derived.append(result)
            save_json(DERIVED_EXPERIMENTS_FILE, derived)
        print("Saved.")


def _get_candidate_layer(key):
    """Determine whether a candidate key is pre-upload or post-upload."""
    defn = get_metric_definition(key)
    if defn:
        return defn.get("layer", "post")
    return "post"


def _bias_pool(pool, preupload_ratio):
    """Reorder pool to interleave pre/post candidates at the desired ratio.
    If not enough pre candidates exist, include all pre and fill remainder with post."""
    if preupload_ratio is None:
        return pool
    pre = [k for k in pool if _get_candidate_layer(k) == "pre"]
    post = [k for k in pool if _get_candidate_layer(k) != "pre"]
    if not pre:
        return pool
    if not post or preupload_ratio >= 1.0:
        return pre + post
    if preupload_ratio <= 0.0:
        return post + pre

    # Interleave: for every batch of N, pick ceil(N*ratio) pre and rest post
    result = []
    pi, qi = 0, 0
    batch = 10
    while pi < len(pre) or qi < len(post):
        n_pre_batch = round(batch * preupload_ratio)
        n_post_batch = batch - n_pre_batch
        added = 0
        while added < n_pre_batch and pi < len(pre):
            result.append(pre[pi]); pi += 1; added += 1
        added = 0
        while added < n_post_batch and qi < len(post):
            result.append(post[qi]); qi += 1; added += 1
        # If one side is exhausted, drain the other
        if pi >= len(pre) and qi < len(post):
            result.extend(post[qi:]); break
        if qi >= len(post) and pi < len(pre):
            result.extend(pre[pi:]); break
    return result


def cmd_auto_run(max_iterations, max_minutes=None, max_failures=None,
                  max_no_signal=None, llm_candidates=25, preupload_ratio=None):
    """Hybrid autonomous run: LLM proposes candidates upstream (may fail gracefully),
    then everything downstream is deterministic template generation + pipeline."""
    start_time = time.time()
    run_id = f"auto_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
    print(f"\n{'=' * 60}")
    print(f"AUTONOMOUS RUN: {run_id}")
    print(f"  max_iterations={max_iterations}, max_minutes={max_minutes}, "
          f"max_failures={max_failures}, max_no_signal={max_no_signal}, "
          f"llm_candidates={llm_candidates}, preupload_ratio={preupload_ratio}")
    print(f"{'=' * 60}")

    # Initialize live progress tracking
    prog = _init_progress(run_id, max_iterations, llm_candidates)

    indicators = load_json(INDICATORS_FILE, [])
    tools = load_json(TOOLS_FILE, [])
    resolutions = load_json(RESOLUTIONS_FILE, [])
    graph = load_json(GRAPH_FILE, {"nodes": [], "edges": []})
    existing_keys = {i["key"] for i in indicators}

    # ── Phase 1: LLM-proposed candidates (upstream, non-deterministic) ────
    llm_keys = []
    if llm_candidates > 0:
        print(f"\n[PHASE 1] Asking Claude for {llm_candidates} candidate proposals...")
        llm_keys = llm_propose_candidates(llm_candidates, existing_keys, indicators, graph,
                                           preupload_ratio=preupload_ratio)
        if llm_keys:
            print(f"  LLM contributed {len(llm_keys)} validated keys")
        else:
            print(f"  LLM proposal failed or returned 0 valid keys — falling back to deterministic only")

    _update_progress(prog, llm_proposed=len(llm_keys))

    # ── Phase 2: Deterministic candidate pool ─────────────────────────────
    auto_candidates = generate_autonomous_candidates()
    queue_candidates = load_json(QUEUE_FILE, DEFAULT_CANDIDATES)
    # Merge: LLM first (novel ideas), then auto-generated, then legacy queue
    seen = set()
    merged = []
    for k in llm_keys + auto_candidates:
        if k not in seen:
            seen.add(k)
            merged.append(k)
    for k in queue_candidates:
        if k not in seen:
            seen.add(k)
            merged.append(k)

    pool = [k for k in merged if k not in existing_keys]

    # Apply pre-upload bias if requested
    if preupload_ratio is not None:
        pre_ct = sum(1 for k in pool if _get_candidate_layer(k) == "pre")
        post_ct = len(pool) - pre_ct
        print(f"Pool before bias: {pre_ct} pre-upload, {post_ct} post-upload")
        pool = _bias_pool(pool, preupload_ratio)

    print(f"Candidate pool: {len(pool)} unrun ({len(llm_keys)} LLM + "
          f"{len(auto_candidates)} generated + {len(queue_candidates)} legacy, "
          f"{len(existing_keys)} already done)")

    # ── Phase 3: Deterministic pipeline execution ─────────────────────────
    videos = load_videos()
    if not videos:
        print("ERROR: No videos loaded")
        return

    attempted = 0
    completed = 0
    failures = 0
    consecutive_failures = 0
    no_signal_streak = 0
    stop_reason = "exhausted_candidates"
    processed_keys = []
    top_r_abs = 0.0
    llm_accepted_count = 0
    # Pre/post tracking
    pre_attempted = 0
    pre_completed = 0
    post_attempted = 0
    post_completed = 0

    try:
        for key in pool:
            # Check cutoffs
            if attempted >= max_iterations:
                stop_reason = "max_iterations"
                break
            if max_minutes and (time.time() - start_time) / 60 >= max_minutes:
                stop_reason = "max_minutes"
                break
            if max_failures and consecutive_failures >= max_failures:
                stop_reason = "max_failures"
                break
            if max_no_signal and no_signal_streak >= max_no_signal:
                stop_reason = "max_no_signal"
                break

            attempted += 1
            is_llm = key in llm_keys
            key_layer = _get_candidate_layer(key)
            is_pre = key_layer == "pre"
            if is_pre:
                pre_attempted += 1
            else:
                post_attempted += 1
            _update_progress(prog,
                             current_candidate=key,
                             attempted=attempted,
                             completed=completed,
                             failures=failures,
                             no_signal_streak=no_signal_streak,
                             llm_completed=llm_accepted_count,
                             pre_attempted=pre_attempted,
                             pre_completed=pre_completed,
                             post_attempted=post_attempted,
                             post_completed=post_completed)
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
                    "source": "llm" if is_llm else "deterministic",
                })
                save_json(EXPERIMENTS_FILE, exp_log)
                save_json(INDICATORS_FILE, indicators)
                # Also persist interactions to derived_experiments.json
                if result.get("kind") == "interaction_to_views":
                    derived = load_json(DERIVED_EXPERIMENTS_FILE, [])
                    derived.append(result)
                    save_json(DERIVED_EXPERIMENTS_FILE, derived)
                existing_keys.add(key)
                completed += 1
                if is_pre:
                    pre_completed += 1
                else:
                    post_completed += 1
                consecutive_failures = 0
                processed_keys.append(key)
                if is_llm:
                    llm_accepted_count += 1

                r_val = result["result"]["primary_r"]
                r_abs = abs(r_val)
                if r_abs > top_r_abs:
                    top_r_abs = r_abs
                if r_abs < 0.05:
                    no_signal_streak += 1
                else:
                    no_signal_streak = 0

                _append_progress_event(prog, {
                    "type": "completed",
                    "key": key,
                    "r": round(r_val, 4),
                    "resolution_id": result.get("resolution_id", "r0"),
                    "target": result.get("target", "views"),
                    "layer": key_layer,
                })
                _update_progress(prog,
                                 completed=completed,
                                 failures=failures,
                                 no_signal_streak=no_signal_streak,
                                 llm_completed=llm_accepted_count,
                                 last_completed_candidate=key,
                                 last_completed_r=round(r_val, 4),
                                 pre_attempted=pre_attempted,
                                 pre_completed=pre_completed,
                                 post_attempted=post_attempted,
                                 post_completed=post_completed)
            else:
                failures += 1
                consecutive_failures += 1
                processed_keys.append(f"FAIL:{key}")
                _append_progress_event(prog, {
                    "type": "failed",
                    "key": key,
                    "reason": "process_indicator returned None",
                    "layer": key_layer,
                })
                _update_progress(prog,
                                 failures=failures,
                                 no_signal_streak=no_signal_streak,
                                 pre_attempted=pre_attempted,
                                 pre_completed=pre_completed,
                                 post_attempted=post_attempted,
                                 post_completed=post_completed)
    except Exception as exc:
        _finish_progress(prog, f"crashed: {str(exc)[:200]}")
        raise

    _finish_progress(prog, stop_reason)

    elapsed = (time.time() - start_time) / 60

    # Save run log
    run_record = {
        "id": run_id,
        "started_at": datetime.datetime.utcfromtimestamp(start_time).isoformat() + "Z",
        "finished_at": now_iso(),
        "mode": "hybrid_auto",
        "llm_proposed": len(llm_keys),
        "llm_completed": llm_accepted_count,
        "attempted": attempted,
        "completed": completed,
        "failures": failures,
        "pre_attempted": pre_attempted,
        "pre_completed": pre_completed,
        "post_attempted": post_attempted,
        "post_completed": post_completed,
        "preupload_ratio_requested": preupload_ratio,
        "no_signal_streak_end": no_signal_streak,
        "stop_reason": stop_reason,
        "candidate_keys_processed": processed_keys[:200],
        "top_new_r_abs": round(top_r_abs, 4),
        "elapsed_minutes": round(elapsed, 2),
        "total_indicators_after": len(indicators),
    }
    runs = load_json(AUTONOMOUS_RUNS_FILE, [])
    runs.append(run_record)
    save_json(AUTONOMOUS_RUNS_FILE, runs)

    print(f"\n{'=' * 60}")
    print(f"AUTONOMOUS RUN COMPLETE: {run_id}")
    print(f"  Attempted: {attempted}, Completed: {completed}, Failures: {failures}")
    print(f"  Pre-upload:  attempted={pre_attempted}, completed={pre_completed}")
    print(f"  Post-upload: attempted={post_attempted}, completed={post_completed}")
    print(f"  LLM proposed: {len(llm_keys)}, LLM completed: {llm_accepted_count}")
    print(f"  Stop reason: {stop_reason}")
    print(f"  Top |r|: {top_r_abs:.4f}")
    print(f"  Elapsed: {elapsed:.1f} minutes")
    print(f"  Total indicators now: {len(indicators)}")
    print(f"{'=' * 60}")


# ── Entry point ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jarvis Pipeline")
    parser.add_argument("--run", type=int, metavar="N", help="Run N indicators from queue")
    parser.add_argument("--single", type=str, metavar="KEY", help="Run one indicator by key")
    parser.add_argument("--status", action="store_true", help="Show current status")
    parser.add_argument("--graph", action="store_true", help="Print graph nodes and edges")
    parser.add_argument("--auto-run", type=int, metavar="N", help="Autonomous run: process up to N candidates")
    parser.add_argument("--max-minutes", type=float, metavar="M", help="Autonomous: max runtime in minutes")
    parser.add_argument("--max-failures", type=int, metavar="K", help="Autonomous: stop after K consecutive failures")
    parser.add_argument("--max-no-signal", type=int, metavar="K", help="Autonomous: stop after K consecutive |r|<0.05")
    parser.add_argument("--llm-candidates", type=int, metavar="N", default=25, help="Autonomous: ask Claude for N candidate proposals (0 to disable)")
    parser.add_argument("--preupload-ratio", type=float, metavar="R", default=None, help="Autonomous: target fraction of pre-upload candidates (0.0-1.0, e.g. 0.8)")
    parser.add_argument("--derived-run", action="store_true", help="Run derived experiment families (pair_correlation, conditional_delta, depth3)")
    parser.add_argument("--derived-max", type=int, metavar="N", default=25, help="Derived: max experiments per kind (default 25)")
    parser.add_argument("--derived-kinds", type=str, metavar="K", default=None, help="Derived: comma-separated kinds (pair_correlation,conditional_delta_to_views,depth3_interaction_to_views)")
    args = parser.parse_args()

    if args.status:
        cmd_status()
    elif args.run:
        cmd_run(args.run)
    elif args.single:
        cmd_single(args.single)
    elif args.graph:
        cmd_graph()
    elif args.auto_run:
        cmd_auto_run(args.auto_run, args.max_minutes, args.max_failures,
                     args.max_no_signal, args.llm_candidates, args.preupload_ratio)
    elif args.derived_run:
        dk = args.derived_kinds.split(",") if args.derived_kinds else None
        cmd_derived_run(max_per_kind=args.derived_max, kinds=dk)
    else:
        parser.print_help()
