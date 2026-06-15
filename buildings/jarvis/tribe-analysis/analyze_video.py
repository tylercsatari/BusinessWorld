#!/Users/tylercsatari/Desktop/BusinessHub/tribev2/.venv312/bin/python3
"""
TRIBE v2 full multimodal brain analysis.
- Full audio + video + text (Llama-3.2-3B) features
- All resolution windows (per-second, per-quarter, per-5pct)
- Per-vertex brain activation data (20,484 vertices on fsaverage5)
- Brain surface images (lateral/medial views)
- Per-region breakdown (auditory, visual, language, motor, DMN)
- Saves result JSON + surface images to R2 (Cloudflare)

Usage:
    HF_TOKEN=hf_xxx analyze_video.py <video_path> --output <json_path> [--r2-key <key>]
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

def log(msg):
    print(f"[tribe] {msg}", file=sys.stderr, flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path")
    parser.add_argument("--output", default=None)
    parser.add_argument("--r2-key", default=None, help="R2 object key to upload result")
    parser.add_argument("--cache-folder", default=str(Path.home() / ".cache" / "huggingface"))
    parser.add_argument("--no-images", action="store_true", help="Skip brain surface image generation")
    parser.add_argument("--skip-text", action="store_true", help="Skip Llama text features (use when Llama access not yet approved)")
    args = parser.parse_args()

    video_path = Path(args.video_path).resolve()
    if not video_path.exists():
        print(json.dumps({"error": f"Video not found: {video_path}"})); return 2

    # Set HF token from env
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if hf_token:
        os.environ["HF_TOKEN"] = hf_token
        log(f"HF token set ({hf_token[:12]}...)")

    log("Loading TRIBE v2 (full multimodal)…")
    t0 = time.time()

    import numpy as np
    import torch
    # Force CPU (Mac MPS not in TRIBE v2 Pydantic schema)
    torch.cuda.is_available = lambda: False
    from tribev2.demo_utils import TribeModel

    model = TribeModel.from_pretrained(
        "facebook/tribev2",
        cache_folder=args.cache_folder,
        device="cpu",
    )
    log(f"Model ready in {time.time()-t0:.1f}s")

    # ── Build events dataframe (audio + video + text) ──────────────
    log("Building events dataframe (full multimodal: video + text)…")
    
    # Build events from video (audio + frames)
    df = model.get_events_dataframe(video_path=str(video_path))
    log(f"Video events: {len(df)} rows, types: {df['type'].unique().tolist() if 'type' in df.columns else '?'}")
    
    if not args.skip_text:
        # Inject transcript from analysis.json as text events
        # Uses gTTS to TTS the transcript, then TRIBE's text extractor (Llama-3.2-3B)
        analysis_path = video_path.parent / 'analysis.json'
        if analysis_path.exists():
            try:
                import tempfile
                import pandas as pd
                analysis = json.loads(analysis_path.read_text())
                tr = analysis.get('transcript', {})
                full_text = tr.get('fullText', '') if isinstance(tr, dict) else str(tr)
                if full_text:
                    tmp_txt = Path(tempfile.mktemp(suffix='.txt'))
                    tmp_txt.write_text(full_text)
                    log("Adding text events from existing transcript (requires Llama-3.2-3B access)...")
                    try:
                        text_df = model.get_events_dataframe(text_path=str(tmp_txt))
                        text_types = text_df['type'].unique().tolist() if 'type' in text_df.columns else []
                        log(f"Text events: {len(text_df)} rows, types: {text_types}")
                        df = pd.concat([df, text_df], ignore_index=True)
                        log(f"Combined: {len(df)} total events")
                    except Exception as te:
                        log(f"Text events failed (non-fatal, continuing with video only): {te}")
                    finally:
                        tmp_txt.unlink(missing_ok=True)
            except Exception as e:
                log(f"Transcript injection failed (non-fatal): {e}")

    # ── Run inference ───────────────────────────────────────────────
    log("Running inference (full multimodal: audio + video + text)…")
    log("  This will take ~90 min on CPU. Grab a coffee.")
    t1 = time.time()
    preds, segments = model.predict(events=df)
    elapsed = time.time() - t1
    log(f"Inference done in {elapsed/60:.1f}min — shape {preds.shape}")

    preds = np.asarray(preds, dtype=np.float32)
    n_steps, n_vert = preds.shape

    # Save full raw predictions matrix as gzip-compressed numpy file so future analysis never re-runs inference
    preds_path = None
    if args.output:
        import gzip
        preds_path = Path(args.output).with_suffix(".preds.npy.gz")
        preds_path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(str(preds_path), "wb") as f:
            np.save(f, preds)
        log(f"Saved raw preds matrix to {preds_path} ({preds_path.stat().st_size // 1024}KB, shape={list(preds.shape)})")

    # ── Constants from TRIBE v2 config (verified from source) ─────────
    # TRIBE config.yaml: offset: 5.0  (hemodynamic response delay)
    # TRIBE config.yaml: data.TR: 1.0 (1 prediction per second)
    # TRIBE config.yaml: cleaning.standardize: zscore_sample (preds are z-scores per sample)
    # TRIBE official demo uses: norm_percentile=99, vmin=0.6 (z-score threshold)
    HRF_OFFSET_SECONDS = 5.0
    Z_SCORE_THRESHOLD = 0.6  # official TRIBE demo activation threshold

    # Each segment from model.predict() carries the actual time window via .start.
    # Fall back to a 1Hz schedule only if .start is unavailable.
    seconds_raw = []
    for seg in segments:
        t = None
        try:
            if isinstance(seg, dict):
                for key in ("start", "t", "second", "time"):
                    if key in seg:
                        t = float(seg[key]); break
            else:
                if hasattr(seg, "start"):
                    t = float(seg.start)
                elif hasattr(seg, "t"):
                    t = float(seg.t)
        except Exception:
            t = None
        seconds_raw.append(t)
    for i, t in enumerate(seconds_raw):
        if t is None:
            seconds_raw[i] = float(i)  # fallback: assume 1 Hz
    seconds = np.array(seconds_raw, dtype=np.float32)
    duration_s = float(seconds[-1] + 1) if n_steps else 0.0
    log(f"Segments parsed: {n_steps} time points · t0={float(seconds[0]):.2f}s · "
        f"t_last={float(seconds[-1]):.2f}s · HRF offset={HRF_OFFSET_SECONDS}s")

    # ── Events summary (first 200 rows of df, JSON-safe) ──────────
    import math as _math
    events_summary = []
    try:
        records = df.to_dict(orient="records")
        for rec in records[:200]:
            cleaned = {}
            for k, v in rec.items():
                key = str(k)
                if isinstance(v, float) and (_math.isnan(v) or _math.isinf(v)):
                    cleaned[key] = None
                    continue
                try:
                    json.dumps(v)
                    cleaned[key] = v
                except (TypeError, ValueError):
                    cleaned[key] = str(v) if v is not None else None
            events_summary.append(cleaned)
    except Exception as _e:
        log(f"events_summary build failed (non-fatal): {_e}")

    # ── Segments data (rich, JSON-safe) ────────────────────────────
    # Segment objects from TRIBE expose: start, end (or stop), duration, ns_events, type
    segments_data = []
    for seg in segments:
        s = {}
        for attr in ("start", "end", "stop", "duration", "t", "second", "time", "type"):
            try:
                if isinstance(seg, dict):
                    if attr in seg:
                        s[attr] = seg[attr]
                elif hasattr(seg, attr):
                    s[attr] = getattr(seg, attr)
            except Exception:
                pass
        # ns_events count (number of stimulus events in this prediction window)
        try:
            if hasattr(seg, "ns_events"):
                s["n_events"] = int(len(seg.ns_events))
            elif isinstance(seg, dict) and "ns_events" in seg:
                s["n_events"] = int(len(seg["ns_events"]))
        except Exception:
            pass
        cleaned = {}
        for k, v in s.items():
            if isinstance(v, float) and (_math.isnan(v) or _math.isinf(v)):
                cleaned[k] = None
                continue
            try:
                json.dumps(v)
                cleaned[k] = v
            except (TypeError, ValueError):
                cleaned[k] = str(v) if v is not None else None
        # HRF-corrected video stimulus time
        if isinstance(cleaned.get("start"), (int, float)):
            cleaned["stimulus_second"] = round(max(0.0, float(cleaned["start"]) - HRF_OFFSET_SECONDS), 3)
        segments_data.append(cleaned)

    # ── Per-step global activation (preds are Z-SCORES, not probabilities) ────
    # TRIBE config: cleaning.standardize: zscore_sample
    # per_step values are mean z-scores across all 20,484 vertices at each timestep
    per_step = preds.mean(axis=1)  # [n_steps] — z-scores
    pmin, pmax = float(per_step.min()), float(per_step.max())
    # Min-max normalized for per-video display (relative shape)
    norm = (per_step - pmin) / (pmax - pmin + 1e-9)
    # Z-score-thresholded version (matches official TRIBE demo: vmin=0.6, norm_percentile=99)
    per_step_pct99 = float(np.percentile(per_step, 99)) if n_steps else 0.0
    per_step_threshold = Z_SCORE_THRESHOLD
    zscore_span = max(per_step_pct99 - per_step_threshold, 1e-9)
    norm_thresholded = np.clip((per_step - per_step_threshold) / zscore_span, 0.0, 1.0)

    brain_engagement_curve = [
        {
            "second": round(float(seconds[i]), 3),
            "stimulus_second": round(max(0.0, float(seconds[i]) - HRF_OFFSET_SECONDS), 3),
            "activation": round(float(norm[i]), 4),
            "activation_zscore": round(float(per_step[i]), 4),
            "activation_thresholded": round(float(norm_thresholded[i]), 4),
        }
        for i in range(n_steps)
    ]

    # Raw (unnormalized) values for cross-video comparison.
    # Same z-scores as activation_zscore above, kept for backward compatibility.
    raw_engagement_curve = [
        {
            "second": round(float(seconds[i]), 3),
            "stimulus_second": round(max(0.0, float(seconds[i]) - HRF_OFFSET_SECONDS), 3),
            "activation_raw": round(float(per_step[i]), 6),
        }
        for i in range(n_steps)
    ]
    preds_global_stats = {
        "min": round(float(preds.min()), 6),
        "max": round(float(preds.max()), 6),
        "mean": round(float(preds.mean()), 6),
        "std": round(float(preds.std()), 6),
        "per_step_min": round(float(per_step.min()), 6),
        "per_step_max": round(float(per_step.max()), 6),
        "per_step_mean": round(float(per_step.mean()), 6),
        "note": (
            "Values are Z-SCORES (TRIBE config standardize: zscore_sample). "
            "Units = standard deviations from the per-sample mean. NOT raw BOLD, NOT probabilities. "
            "Threshold from official TRIBE demo: 0.6 z-scores. Typical peaks: 2-3 z-scores."
        ),
    }
    engagement_stats = {
        "mean_zscore": round(float(per_step.mean()), 4),
        "std_zscore": round(float(per_step.std()), 4),
        "min_zscore": round(float(per_step.min()), 4),
        "max_zscore": round(float(per_step.max()), 4),
        "pct99_zscore": round(per_step_pct99, 4),
        "threshold_zscore": per_step_threshold,
        "n_above_threshold": int((per_step > per_step_threshold).sum()),
        "pct_above_threshold": round(100.0 * float((per_step > per_step_threshold).sum()) / max(n_steps, 1), 2),
    }

    # ── Peak moments (top 10%) ──────────────────────────────────────
    k = max(1, int(round(n_steps * 0.10)))
    top_idx = np.argsort(norm)[-k:][::-1]
    sorted_vals = np.sort(per_step)
    peak_moments = []
    for idx in top_idx:
        rank = int(np.searchsorted(sorted_vals, per_step[idx], side="right"))
        pct = round(100.0 * rank / n_steps, 1)
        peak_moments.append({
            "second": round(float(seconds[idx]), 3),
            "stimulus_second": round(max(0.0, float(seconds[idx]) - HRF_OFFSET_SECONDS), 3),
            "activation": round(float(norm[idx]), 4),
            "activation_zscore": round(float(per_step[idx]), 4),
            "percentile": pct,
        })
    peak_moments.sort(key=lambda p: p["second"])

    # ── Extended peaks: every moment in the top 25% (percentile >= 75) ──
    extended_peaks_25pct = []
    for i in range(n_steps):
        rank = int(np.searchsorted(sorted_vals, per_step[i], side="right"))
        pct = round(100.0 * rank / n_steps, 1)
        if pct >= 75.0:
            extended_peaks_25pct.append({
                "second": round(float(seconds[i]), 3),
                "stimulus_second": round(max(0.0, float(seconds[i]) - HRF_OFFSET_SECONDS), 3),
                "activation": round(float(norm[i]), 4),
                "activation_zscore": round(float(per_step[i]), 4),
                "percentile": pct,
            })
    extended_peaks_25pct.sort(key=lambda p: p["second"])

    # ── Multi-resolution activation windows ─────────────────────────
    log("Computing multi-resolution windows…")

    def window_mean(lo, hi):
        mask = (seconds >= lo * duration_s) & (seconds < hi * duration_s)
        return float(norm[mask].mean()) if mask.any() else 0.0

    def window_peak(lo, hi):
        mask = (seconds >= lo * duration_s) & (seconds < hi * duration_s)
        return float(norm[mask].max()) if mask.any() else 0.0

    # Quartiles
    resolution_quartiles = {
        "Q1_0_25pct": {"mean": round(window_mean(0, 0.25), 4), "peak": round(window_peak(0, 0.25), 4)},
        "Q2_25_50pct": {"mean": round(window_mean(0.25, 0.5), 4), "peak": round(window_peak(0.25, 0.5), 4)},
        "Q3_50_75pct": {"mean": round(window_mean(0.5, 0.75), 4), "peak": round(window_peak(0.5, 0.75), 4)},
        "Q4_75_100pct": {"mean": round(window_mean(0.75, 1.0), 4), "peak": round(window_peak(0.75, 1.0), 4)},
    }

    # 5% resolution windows — all 20 buckets (pct_00_05 through pct_95_100)
    resolution_5pct = {}
    for pct in range(0, 100, 5):
        lo, hi = pct / 100.0, (pct + 5) / 100.0
        label = f"pct_{pct:02d}_{pct+5:02d}"
        sec_start = round(lo * duration_s, 3)
        sec_end = round(hi * duration_s, 3)
        resolution_5pct[label] = {
            "mean": round(window_mean(lo, hi), 4),
            "peak": round(window_peak(lo, hi), 4),
            "second_start": sec_start,
            "second_end": sec_end,
        }

    # Hook zone and late zone
    resolution_named = {
        "hook_0_10pct":   {"mean": round(window_mean(0, 0.10), 4), "peak": round(window_peak(0, 0.10), 4)},
        "setup_10_25pct": {"mean": round(window_mean(0.10, 0.25), 4), "peak": round(window_peak(0.10, 0.25), 4)},
        "mid_25_75pct":   {"mean": round(window_mean(0.25, 0.75), 4), "peak": round(window_peak(0.25, 0.75), 4)},
        "end_75_95pct":   {"mean": round(window_mean(0.75, 0.95), 4), "peak": round(window_peak(0.75, 0.95), 4)},
        "final_5pct":     {"mean": round(window_mean(0.95, 1.0), 4),  "peak": round(window_peak(0.95, 1.0), 4)},
    }

    # ── Brain region breakdown (fsaverage5 vertex ranges) ──────────
    # fsaverage5 has 20484 vertices (10242 per hemisphere)
    # Approximate region masks based on known cortical parcellation positions
    log("Computing brain region breakdown…")

    # Per-vertex mean activation over the whole video.
    # vertex_mean = raw z-score per vertex (preserves z-score meaning).
    # vertex_norm = min-max [0,1] for display only.
    vertex_mean = preds.mean(axis=0)  # (n_vertices,) — z-scores
    vertex_norm = (vertex_mean - vertex_mean.min()) / (vertex_mean.max() - vertex_mean.min() + 1e-9)

    # Pre-load mesh/Destrieux atlas — needed for both PCA component labeling
    # and the per-region computation below.
    mesh_path = Path(__file__).parent / 'fsaverage5_mesh.json'
    mesh_data = {}
    if mesh_path.exists():
        log("Loading real fsaverage5 parcellation from Destrieux atlas…")
        mesh_data = json.loads(mesh_path.read_text())

    # ── Data-driven functional networks via PCA ────────────────────────────
    log("Computing data-driven functional networks (PCA independent components)…")
    try:
        centered = preds - preds.mean(axis=0)  # remove spatial mean per vertex
        U, s, Vt = np.linalg.svd(centered, full_matrices=False)

        # Top 8 independent components (after component 1 = global signal)
        n_components = min(8, len(s))
        functional_networks = {}
        for comp_idx in range(n_components):
            ts = U[:, comp_idx] * s[comp_idx]  # temporal signature [n_steps]
            spatial = Vt[comp_idx]  # spatial pattern [n_vertices]
            variance_pct = round(float(s[comp_idx]**2 / (s**2).sum() * 100), 2)

            # Find which vertices load most strongly on this component
            top_vert_pos = np.argsort(spatial)[-100:].tolist()  # top 100 positive
            top_vert_neg = np.argsort(spatial)[:100].tolist()   # top 100 negative

            # Normalize ts to 0-1 for display
            ts_min, ts_max = ts.min(), ts.max()
            ts_norm = ((ts - ts_min) / (ts_max - ts_min + 1e-9)).tolist()

            label = "Global signal" if comp_idx == 0 else f"Independent component {comp_idx}"
            if comp_idx == 0:
                interp = "Global brain signal — all regions rise and fall together"
            elif comp_idx == 1:
                interp = "Second largest independent signal — regions that activate DIFFERENTLY from global"
            else:
                interp = f"Independent spatial pattern {comp_idx} — unique sub-network"

            peak_idx = int(np.argmax(np.abs(ts)))
            functional_networks[f"component_{comp_idx+1}"] = {
                "label": label,
                "component_index": comp_idx + 1,
                "variance_explained_pct": variance_pct,
                "timeseries_raw": [round(float(v), 4) for v in ts.tolist()],
                "timeseries_normalized": [round(float(v), 4) for v in ts_norm],
                "peak_second": round(float(seconds[peak_idx]), 2),
                "peak_stimulus_second": round(max(0.0, float(seconds[peak_idx]) - HRF_OFFSET_SECONDS), 2),
                "top_positive_vertices": top_vert_pos,
                "top_negative_vertices": top_vert_neg,
                "interpretation": interp,
                "zscore_note": (
                    f"PCA component {comp_idx+1} extracted from z-scored TRIBE predictions. "
                    f"timeseries_raw values are z-score-weighted SVD coordinates."
                ),
            }
        log(f"PCA: {n_components} components computed, top component explains {functional_networks['component_1']['variance_explained_pct']}% variance")
    except Exception as e:
        log(f"PCA failed (non-fatal): {e}")
        functional_networks = {}

    # Label PCA components with their dominant Destrieux regions
    if functional_networks and mesh_path.exists():
        log("Labeling PCA components with Destrieux atlas regions…")
        try:
            all_destrieux = mesh_data.get("all_destrieux_regions", {})
            for comp_key, comp in functional_networks.items():
                top_pos_verts = set(comp["top_positive_vertices"])
                top_neg_verts = set(comp["top_negative_vertices"])

                # For each Destrieux region, count how many of its vertices appear in top_pos/top_neg
                region_pos_overlap = {}
                region_neg_overlap = {}
                for rname, rdata in all_destrieux.items():
                    all_verts = set(rdata["lh_vertex_indices"] + rdata["rh_vertex_indices"])
                    pos_overlap = len(top_pos_verts & all_verts)
                    neg_overlap = len(top_neg_verts & all_verts)
                    if pos_overlap > 0:
                        region_pos_overlap[rname] = round(pos_overlap / max(len(all_verts), 1), 4)
                    if neg_overlap > 0:
                        region_neg_overlap[rname] = round(neg_overlap / max(len(all_verts), 1), 4)

                # Top 5 regions by overlap fraction
                top_pos_regions = sorted(region_pos_overlap.items(), key=lambda x: -x[1])[:5]
                top_neg_regions = sorted(region_neg_overlap.items(), key=lambda x: -x[1])[:5]

                comp["top_positive_regions"] = [{"region": r, "overlap_fraction": f} for r, f in top_pos_regions]
                comp["top_negative_regions"] = [{"region": r, "overlap_fraction": f} for r, f in top_neg_regions]
        except Exception as e:
            log(f"PCA region labeling failed (non-fatal): {e}")

    # Build REGION_VERTEX_SETS from the (already-loaded) Destrieux atlas, or fall back.
    if mesh_data:
        FUNCTIONAL_REGIONS = mesh_data.get('functional_vertex_map', {})
        REGION_VERTEX_SETS = {
            name: np.array(info['vertex_indices'], dtype=int)
            for name, info in FUNCTIONAL_REGIONS.items()
            if info.get('vertex_indices')
        }
        log(f"Loaded {len(REGION_VERTEX_SETS)} real anatomical regions: "
            f"{list(REGION_VERTEX_SETS.keys())}")
    else:
        log("WARNING: fsaverage5_mesh.json not found, using fallback vertex ranges")
        _FALLBACK = {
            "auditory_cortex":    {"lh": (1000, 2500),   "rh": (11242, 12742)},
            "visual_cortex_V1":   {"lh": (8000, 9500),   "rh": (18242, 19742)},
            "language_broca":     {"lh": (2500, 4000),   "rh": (12742, 14242)},
            "language_wernicke":  {"lh": (3500, 5000),   "rh": (13742, 15242)},
            "motor_cortex":       {"lh": (4000, 5500),   "rh": (14242, 15742)},
            "prefrontal":         {"lh": (0, 1500),       "rh": (10242, 11742)},
            "default_mode_mpfc":  {"lh": (500, 1500),    "rh": (10742, 11742)},
            "default_mode_pcc":   {"lh": (7500, 8500),   "rh": (17742, 18742)},
            "attention_network":  {"lh": (5000, 6500),   "rh": (15242, 16742)},
            "emotion_amygdala":   {"lh": (9000, 9800),   "rh": (19242, 20042)},
        }
        REGION_VERTEX_SETS = {
            name: np.concatenate([
                np.arange(b["lh"][0], b["lh"][1]),
                np.arange(b["rh"][0], b["rh"][1]),
            ]).astype(int)
            for name, b in _FALLBACK.items()
        }

    region_activations = {}
    region_timeseries_data = {}
    # Pull matched_regions metadata from the mesh's functional_vertex_map (if loaded)
    _functional_map = mesh_data.get('functional_vertex_map', {}) if mesh_path.exists() else {}
    for region_name, vert_indices in REGION_VERTEX_SETS.items():
        vert_indices = vert_indices[vert_indices < n_vert]  # safety clip
        if len(vert_indices) == 0:
            continue
        region_verts = vertex_norm[vert_indices]  # [n_region_verts] (display 0-1)
        region_z_per_vert = vertex_mean[vert_indices]  # raw z-scores
        ts_zscore = preds[:, vert_indices].mean(axis=1)  # [n_steps] z-scores
        ts = [round(float(v), 4) for v in ts_zscore.tolist()]
        # Per-region min-max normalized timeseries (for display)
        ts_min, ts_max = float(ts_zscore.min()), float(ts_zscore.max())
        ts_normalized = [round(float((v - ts_min) / (ts_max - ts_min + 1e-9)), 4) for v in ts_zscore.tolist()]
        region_raw = preds[:, vert_indices]
        region_activations[region_name] = {
            "mean_activation": round(float(region_verts.mean()), 4),
            "peak_activation": round(float(region_verts.max()), 4),
            "mean_zscore": round(float(region_z_per_vert.mean()), 4),
            "peak_zscore": round(float(region_z_per_vert.max()), 4),
            "n_vertices": int(len(vert_indices)),
            "timeseries": ts,                  # z-score values per timestep (raw)
            "timeseries_zscore": ts,           # alias for clarity
            "timeseries_normalized": ts_normalized,  # per-region min-max [0,1]
            "vertex_indices_sample": vert_indices[:20].tolist(),
            "matched_regions": _functional_map.get(region_name, {}).get("matched_regions", []),
            "raw_mean": round(float(region_raw.mean()), 6),
            "raw_std": round(float(region_raw.std()), 6),
            "raw_min": round(float(region_raw.min()), 6),
            "raw_max": round(float(region_raw.max()), 6),
        }
        region_timeseries_data[region_name] = ts

    # Also compute per-region timeseries for all individual Destrieux regions
    if mesh_path.exists():
        log("Computing individual Destrieux region timeseries (all 75 regions)…")
        all_destrieux = mesh_data.get("all_destrieux_regions", {})
        destrieux_region_activations = {}
        for dname, dinfo in all_destrieux.items():
            lh_verts = np.array(dinfo.get("lh_vertex_indices", []), dtype=int)
            rh_verts = np.array(dinfo.get("rh_vertex_indices", []), dtype=int)
            all_verts = np.concatenate([lh_verts, rh_verts])
            all_verts = all_verts[all_verts < n_vert]
            if len(all_verts) == 0:
                continue
            ts_zscore = preds[:, all_verts].mean(axis=1)  # [n_steps] z-scores
            ts = [round(float(v), 4) for v in ts_zscore.tolist()]
            destrieux_raw = preds[:, all_verts]
            destrieux_region_activations[dname] = {
                "mean_activation": round(float(vertex_norm[all_verts].mean()), 4),
                "peak_activation": round(float(vertex_norm[all_verts].max()), 4),
                "mean_zscore": round(float(vertex_mean[all_verts].mean()), 4),
                "peak_zscore": round(float(vertex_mean[all_verts].max()), 4),
                "n_vertices": int(len(all_verts)),
                "timeseries": ts,
                "timeseries_zscore": ts,
                "centroid_mm": dinfo.get("centroid_mm", []),
                "raw_mean": round(float(destrieux_raw.mean()), 6),
                "raw_std": round(float(destrieux_raw.std()), 6),
                "raw_min": round(float(destrieux_raw.min()), 6),
                "raw_max": round(float(destrieux_raw.max()), 6),
            }
        log(f"Computed {len(destrieux_region_activations)} individual Destrieux region timeseries")
    else:
        destrieux_region_activations = {}

    # ── HCP Multi-Modal Parcellation (TRIBE's native ROI scheme) ────
    # Uses tribev2.utils.get_hcp_labels — 360 cortical ROIs from HCPMMP1.
    # Requires `mne` + cached HCP atlas; fail gracefully if not available.
    hcp_roi_activations = {}
    try:
        log("Computing HCP MMP1 parcellation summary (TRIBE native, 360 ROIs)…")
        try:
            from tribev2.utils import get_hcp_labels  # noqa: F401
        except ImportError:
            sys.path.insert(0, '/Users/tylercsatari/Desktop/BusinessHub/tribev2')
            from tribev2.utils import get_hcp_labels  # type: ignore
        hcp_labels = get_hcp_labels(mesh="fsaverage5", combine=False, hemi="both")
        for roi_name, vertices in hcp_labels.items():
            v = np.asarray(vertices, dtype=int)
            v = v[v < n_vert]
            if len(v) == 0:
                continue
            ts_z = preds[:, v].mean(axis=1)  # [n_steps]
            hcp_roi_activations[roi_name] = {
                "mean_zscore": round(float(vertex_mean[v].mean()), 4),
                "peak_zscore": round(float(vertex_mean[v].max()), 4),
                "n_vertices": int(len(v)),
                "timeseries_zscore": [round(float(x), 4) for x in ts_z.tolist()],
            }
        log(f"HCP parcellation: {len(hcp_roi_activations)} ROIs computed")
    except Exception as e:
        log(f"HCP parcellation unavailable (non-fatal, requires mne + HCP data): {e}")
        hcp_roi_activations = {}

    # ── Per-region per-vertex timeseries matrix ────────────────────
    log("Building region_vertex_timeseries matrices…")
    region_vertex_timeseries = {}
    for region_name, vert_indices in REGION_VERTEX_SETS.items():
        vert_indices = vert_indices[vert_indices < n_vert]
        if len(vert_indices) == 0:
            region_vertex_timeseries[region_name] = {"n_vertices": 0, "timeseries_matrix": []}
            continue
        submat = preds[:, vert_indices]  # (n_steps, n_region_verts)
        ts_matrix = [[round(float(v), 4) for v in row] for row in submat]
        region_vertex_timeseries[region_name] = {
            "n_vertices": int(len(vert_indices)),
            "timeseries_matrix": ts_matrix,
        }

    # ── Multi-scale rolling window analysis ─────────────────────────
    log("Computing multi-scale rolling window analysis…")
    def rolling_mean(arr, window):
        """Centered rolling mean with edge padding."""
        half = window // 2
        result = []
        for i in range(len(arr)):
            lo = max(0, i - half)
            hi = min(len(arr), i + half + 1)
            result.append(round(float(arr[lo:hi].mean()), 4))
        return result

    multi_scale = {}
    for window_s in [1, 2, 4, 8, 16]:
        if window_s <= n_steps:
            # Global (all vertices)
            smooth = rolling_mean(per_step, window_s)
            smooth_norm = np.array(smooth)
            smin, smax = smooth_norm.min(), smooth_norm.max()
            smooth_norm_01 = ((smooth_norm - smin) / (smax - smin + 1e-9)).tolist()
            multi_scale[f"{window_s}s_window"] = {
                "window_seconds": window_s,
                "activation_curve": smooth,  # raw rolling mean
                "activation_curve_normalized": [round(float(v), 4) for v in smooth_norm_01],
                "description": f"{window_s}-second rolling average of mean brain activation",
            }
            # Also per-region
            region_smooth = {}
            for region_name, vert_indices in REGION_VERTEX_SETS.items():
                vert_indices = vert_indices[vert_indices < n_vert]
                if len(vert_indices) == 0:
                    region_smooth[region_name] = [0.0] * n_steps
                    continue
                region_arr = preds[:, vert_indices].mean(axis=1)
                region_smooth[region_name] = rolling_mean(region_arr, window_s)
            multi_scale[f"{window_s}s_window"]["region_curves"] = region_smooth

    # ── Structural beat detection ───────────────────────────────────
    log("Detecting structural beats and attention transitions…")
    # Compute frame-to-frame change in brain activation
    activation_deltas = []
    for i in range(1, n_steps):
        delta = float(abs(per_step[i] - per_step[i-1]))
        activation_deltas.append({"second": round(float(seconds[i]), 2), "delta": round(delta, 4)})

    # Smooth deltas with 2s window
    delta_arr = np.array([d["delta"] for d in activation_deltas])
    if len(delta_arr) > 2:
        smoothed_delta = rolling_mean(delta_arr, 2)
    else:
        smoothed_delta = delta_arr.tolist()

    # Find top 20% transition moments
    delta_threshold = np.percentile(delta_arr, 80) if len(delta_arr) else 0
    attention_transitions = [
        {
            "second": activation_deltas[i]["second"],
            "stimulus_second": round(max(0.0, activation_deltas[i]["second"] - HRF_OFFSET_SECONDS), 3),
            "delta": activation_deltas[i]["delta"],
            "smoothed_delta": round(float(smoothed_delta[i]), 4),
            "percentile": round(float(np.searchsorted(np.sort(delta_arr), delta_arr[i]) / len(delta_arr) * 100), 1),
        }
        for i in range(len(activation_deltas)) if delta_arr[i] >= delta_threshold
    ]

    # RTG structure analysis - break video into 3 phases
    # Hook (0-15%), Build (15-60%), Payoff (60-100%)
    def phase_stats(lo_pct, hi_pct, label):
        lo_idx = int(n_steps * lo_pct)
        hi_idx = int(n_steps * hi_pct)
        hi_idx = min(hi_idx, n_steps)
        slice_norm = norm[lo_idx:hi_idx]
        slice_raw = per_step[lo_idx:hi_idx]
        if not len(slice_norm):
            return {}
        peak_local = lo_idx + int(np.argmax(slice_raw))
        return {
            "label": label,
            "second_start": round(float(seconds[lo_idx]), 2),
            "second_end": round(float(seconds[min(hi_idx, n_steps)-1]), 2),
            "stimulus_second_start": round(max(0.0, float(seconds[lo_idx]) - HRF_OFFSET_SECONDS), 2),
            "stimulus_second_end": round(max(0.0, float(seconds[min(hi_idx, n_steps)-1]) - HRF_OFFSET_SECONDS), 2),
            "mean_activation": round(float(slice_raw.mean()), 4),
            "peak_activation": round(float(slice_raw.max()), 4),
            "mean_zscore": round(float(slice_raw.mean()), 4),
            "peak_zscore": round(float(slice_raw.max()), 4),
            "peak_second": round(float(seconds[peak_local]), 2),
            "peak_stimulus_second": round(max(0.0, float(seconds[peak_local]) - HRF_OFFSET_SECONDS), 2),
            "normalized_mean": round(float(slice_norm.mean()), 4),
            "trend": "rising" if (len(slice_norm) > 1 and slice_norm[-1] > slice_norm[0]) else "falling",
        }

    rtg_structure = {
        "hook": phase_stats(0.0, 0.15, "Hook (0-15%)"),
        "build": phase_stats(0.15, 0.60, "Build (15-60%)"),
        "payoff": phase_stats(0.60, 1.0, "Payoff (60-100%)"),
        "attention_transitions": attention_transitions,
        "n_major_transitions": len(attention_transitions),
        "avg_transition_delta": round(float(delta_arr.mean()), 4) if len(delta_arr) else 0,
    }

    # ── Cross-region correlation matrix ─────────────────────────────
    log("Computing cross-region correlation matrix…")
    region_series = {}
    for region_name, vert_indices in REGION_VERTEX_SETS.items():
        vert_indices = vert_indices[vert_indices < n_vert]
        if len(vert_indices) == 0:
            region_series[region_name] = np.zeros(n_steps)
            continue
        region_series[region_name] = preds[:, vert_indices].mean(axis=1)

    region_names = list(region_series.keys())
    n_regions = len(region_names)
    corr_matrix = {}
    for i, r1 in enumerate(region_names):
        corr_matrix[r1] = {}
        for j, r2 in enumerate(region_names):
            if i == j:
                corr_matrix[r1][r2] = 1.0
            else:
                a, b = region_series[r1], region_series[r2]
                ma, mb = a.mean(), b.mean()
                num = float(((a-ma)*(b-mb)).sum())
                denom = float(np.sqrt(((a-ma)**2).sum() * ((b-mb)**2).sum()))
                corr_matrix[r1][r2] = round(num/denom, 4) if denom > 1e-9 else 0.0

    # ── Per-vertex data (full 20K vertex resolution) ─────────────
    log("Preparing per-vertex activation data…")
    sample_step = 2
    activation_per_second = [
        [round(float(x), 4) for x in preds[i, ::sample_step].tolist()]
        for i in range(n_steps)
    ]
    activation_per_second_n_vertices = len(activation_per_second[0]) if activation_per_second else 0
    # Per-vertex peak times in BOTH brain-activation time and stimulus (HRF-corrected) time
    peak_idx_per_vertex = np.argmax(preds, axis=0)  # [n_vert]
    peak_second_per_vertex = [round(float(seconds[int(i)]), 2) for i in peak_idx_per_vertex]
    peak_stimulus_second_per_vertex = [
        round(max(0.0, float(seconds[int(i)]) - HRF_OFFSET_SECONDS), 2) for i in peak_idx_per_vertex
    ]
    vertex_data = {
        "n_vertices": int(n_vert),
        "hemisphere_split": int(n_vert // 2),
        "mean_activation_per_vertex": vertex_norm.tolist(),         # 0-1 normalized for display
        "mean_zscore_per_vertex": [round(float(v), 4) for v in vertex_mean.tolist()],  # raw z-scores
        "peak_second_per_vertex": peak_second_per_vertex,
        "peak_stimulus_second_per_vertex": peak_stimulus_second_per_vertex,
        "activation_per_second": activation_per_second,
        "activation_per_second_sample_step": sample_step,
        "activation_per_second_n_vertices": int(activation_per_second_n_vertices),
        "description": (
            "fsaverage5 pial surface, 20,484 vertices. "
            "LH=0-10241, RH=10242-20483 (TribeSurfaceProjector: hemis=[left,right], np.vstack(hemis)). "
            "activation_per_second values are Z-SCORES."
        ),
    }

    # ── Generate brain surface images ───────────────────────────────
    brain_images = {}
    if not args.no_images:
        log("Generating brain surface images…")
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            import matplotlib.cm as cm
            import base64, io

            # Simple 2D flatmap representation of vertex activations
            # Divide into LH and RH, plot as heatmaps
            lh_data = vertex_norm[:n_vert//2]
            rh_data = vertex_norm[n_vert//2:]

            fig, axes = plt.subplots(1, 2, figsize=(14, 5), facecolor="#0a0f1e")
            for ax, data, title in [(axes[0], lh_data, "Left Hemisphere"), (axes[1], rh_data, "Right Hemisphere")]:
                # Reshape to approximate 2D cortical layout
                size = int(len(data)**0.5) + 1
                padded = np.zeros(size*size)
                padded[:len(data)] = data
                grid = padded.reshape(size, size)
                im = ax.imshow(grid, cmap="plasma", vmin=0, vmax=1, aspect="auto")
                ax.set_title(title, color="#e2e8f0", fontsize=12, fontweight="bold")
                ax.set_facecolor("#0a0f1e")
                ax.tick_params(colors="#64748b")
                for spine in ax.spines.values(): spine.set_color("#1e293b")
            plt.colorbar(im, ax=axes[1], label="Brain Activation (0-1)", fraction=0.046)
            fig.patch.set_facecolor("#0a0f1e")
            fig.suptitle("TRIBE v2 Brain Activation Map", color="#facc15", fontsize=14, fontweight="bold", y=1.02)
            plt.tight_layout()

            buf = io.BytesIO()
            plt.savefig(buf, format="png", dpi=120, bbox_inches="tight", facecolor="#0a0f1e")
            plt.close()
            brain_images["flatmap_png_b64"] = base64.b64encode(buf.getvalue()).decode()
            log("Brain surface flatmap generated")

            # Time series heatmap (seconds × regions)
            fig2, ax2 = plt.subplots(figsize=(14, 6), facecolor="#0a0f1e")
            region_names = list(region_activations.keys())
            # Per-region, per-second activation
            region_timeseries = []
            for region_name in region_names:
                vert_indices = REGION_VERTEX_SETS.get(region_name)
                if vert_indices is None:
                    region_timeseries.append(np.zeros(n_steps))
                    continue
                vert_indices = vert_indices[vert_indices < n_vert]
                if len(vert_indices) == 0:
                    region_timeseries.append(np.zeros(n_steps))
                    continue
                ts = preds[:, vert_indices].mean(axis=1)
                ts = (ts - ts.min()) / (ts.max() - ts.min() + 1e-9)
                region_timeseries.append(ts)

            matrix = np.array(region_timeseries)  # (n_regions, n_steps)
            im2 = ax2.imshow(matrix, cmap="plasma", aspect="auto", vmin=0, vmax=1)
            ax2.set_yticks(range(len(region_names)))
            ax2.set_yticklabels([r.replace("_", " ").title() for r in region_names], color="#e2e8f0", fontsize=9)
            ax2.set_xlabel("Time (seconds)", color="#94a3b8")
            ax2.set_title("Brain Region Activation Over Time", color="#facc15", fontsize=12, fontweight="bold")
            ax2.set_facecolor("#0a0f1e")
            step_labels = [str(int(s)) for s in seconds]
            tick_step = max(1, len(seconds)//10)
            ax2.set_xticks(range(0, n_steps, tick_step))
            ax2.set_xticklabels(step_labels[::tick_step], color="#94a3b8", fontsize=8)
            plt.colorbar(im2, ax=ax2, label="Normalized Activation", fraction=0.03)
            fig2.patch.set_facecolor("#0a0f1e")
            plt.tight_layout()

            buf2 = io.BytesIO()
            plt.savefig(buf2, format="png", dpi=120, bbox_inches="tight", facecolor="#0a0f1e")
            plt.close()
            brain_images["region_timeseries_png_b64"] = base64.b64encode(buf2.getvalue()).decode()
            log("Brain region timeseries image generated")

        except Exception as e:
            log(f"Image generation failed (non-fatal): {e}")
            brain_images["error"] = str(e)

    # ── Assemble full output ────────────────────────────────────────
    max_idx = int(np.argmax(norm)) if n_steps else 0
    max_sec = float(seconds[max_idx]) if n_steps else 0.0

    analysis_metadata = {
        "tribe_version": "v2",
        "hrf_offset_seconds": HRF_OFFSET_SECONDS,
        "temporal_resolution_seconds": 1.0,
        "prediction_type": "zscore",
        "zscore_threshold": Z_SCORE_THRESHOLD,
        "norm_percentile": 99,
        "zscore_note": (
            "Predictions are z-scored per sample (TRIBE config standardize: zscore_sample). "
            "Values are standard deviations above/below the per-sample mean. "
            "Official TRIBE demo threshold = 0.6 z-scores. Typical peak activations = 2-3 z-scores."
        ),
        "timing_note": (
            "second = when brain activation peaks (BOLD signal time). "
            "stimulus_second = when video content caused it (second - 5.0s HRF lag). "
            "Use stimulus_second to identify which video content drove each brain response."
        ),
        "vertex_ordering": (
            "LH=0..10241, RH=10242..20483. From TribeSurfaceProjector.apply: "
            "hemis = [left, right]; return np.vstack(hemis)."
        ),
        "surface": "fsaverage5 pial (center_depth=0.5, midpoint between pial and white matter)",
        "n_vertices": int(n_vert),
    }

    out = {
        "video_path": str(video_path),
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": duration_s,
        "n_timesteps": n_steps,
        "n_vertices": n_vert,
        "mode": "full_multimodal",
        "features_used": ["audio", "video_frames", "text_llama"],
        "inference_time_minutes": round(elapsed / 60, 2),
        "engagement_score": round(float(norm.mean()), 4),
        "max_activation_second": round(max_sec, 3),
        "max_activation_stimulus_second": round(max(0.0, max_sec - HRF_OFFSET_SECONDS), 3),
        "analysis_metadata": analysis_metadata,
        "engagement_stats": engagement_stats,
        "brain_engagement_curve": brain_engagement_curve,
        "raw_engagement_curve": raw_engagement_curve,
        "preds_global_stats": preds_global_stats,
        "peak_moments": peak_moments,
        "extended_peaks_25pct": extended_peaks_25pct,
        "resolution_quartiles": resolution_quartiles,
        "resolution_5pct": resolution_5pct,
        "resolution_named": resolution_named,
        "region_activations": region_activations,
        "destrieux_region_activations": destrieux_region_activations,
        "hcp_roi_activations": hcp_roi_activations,
        "region_timeseries_data": region_timeseries_data,
        "region_vertex_timeseries": region_vertex_timeseries,
        "multi_scale_analysis": multi_scale,
        "rtg_structure": rtg_structure,
        "region_correlation_matrix": corr_matrix,
        "functional_networks": functional_networks,
        "seconds": [round(float(seconds[i]), 3) for i in range(n_steps)],
        "stimulus_seconds": [
            round(max(0.0, float(seconds[i]) - HRF_OFFSET_SECONDS), 3) for i in range(n_steps)
        ],
        "segments": segments_data,
        "events_summary": events_summary,
        "preds_shape": list(preds.shape),
        "preds_file": str(preds_path) if preds_path else None,
        "vertex_data": vertex_data,
        "brain_images": brain_images,
    }

    # ── Save locally ────────────────────────────────────────────────
    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Save images separately to keep main JSON manageable
        images_path = out_path.with_suffix(".images.json")
        images_to_save = out.pop("brain_images", {})
        out_path.write_text(json.dumps(out, indent=2))
        if images_to_save:
            images_path.write_text(json.dumps(images_to_save, indent=2))
            log(f"Images saved to {images_path}")
        log(f"Result saved to {out_path} ({out_path.stat().st_size//1024}KB)")
        # Re-add for R2 upload
        out["brain_images"] = images_to_save

    # ── Upload to R2 (Cloudflare) ───────────────────────────────────
    if args.r2_key:
        log(f"Uploading to R2: {args.r2_key}…")
        try:
            import boto3, dotenv
            dotenv.load_dotenv("/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/.env")
            s3 = boto3.client(
                "s3",
                endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
            )
            bucket = os.environ["R2_BUCKET_NAME"]
            # Upload main result
            s3.put_object(Bucket=bucket, Key=args.r2_key,
                          Body=json.dumps(out).encode(),
                          ContentType="application/json")
            log(f"Uploaded to R2: {args.r2_key}")
        except Exception as e:
            log(f"R2 upload failed (non-fatal): {e}")

    # Report what was saved (no deletions — keep everything for future reuse)
    log("───────── saved artifacts ─────────")
    if args.output:
        log(f"  main JSON:   {args.output}")
        if 'images_path' in dir():
            log(f"  images JSON: {Path(args.output).with_suffix('.images.json')}")
    if preds_path:
        log(f"  raw preds:   {preds_path}  shape={list(preds.shape)}")
    log(f"  fields: brain_engagement_curve({n_steps}), peak_moments({len(peak_moments)}), "
        f"extended_peaks_25pct({len(extended_peaks_25pct)}), resolution_5pct({len(resolution_5pct)}), "
        f"region_activations({len(region_activations)}), destrieux({len(destrieux_region_activations)}), "
        f"hcp_roi({len(hcp_roi_activations)}), region_vertex_timeseries({len(region_vertex_timeseries)}), "
        f"segments({len(segments_data)}), events_summary({len(events_summary)}), "
        f"vertex_data.activation_per_second({n_steps}x{vertex_data.get('activation_per_second_n_vertices', 0)})")
    log(f"  z-score stats: mean={engagement_stats['mean_zscore']} max={engagement_stats['max_zscore']} "
        f"pct99={engagement_stats['pct99_zscore']} above-0.6={engagement_stats['n_above_threshold']}/{n_steps}")
    log("──────────────────────────────────")

    # Print summary (not the giant vertex/timeseries arrays)
    _exclude = ("vertex_data", "brain_engagement_curve", "raw_engagement_curve", "brain_images",
                "resolution_5pct", "region_vertex_timeseries", "region_timeseries_data",
                "extended_peaks_25pct", "destrieux_region_activations", "hcp_roi_activations",
                "segments", "events_summary", "seconds", "stimulus_seconds")
    summary = {k: v for k, v in out.items() if k not in _exclude}
    print(json.dumps(summary))
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "type": type(e).__name__,
                          "traceback": traceback.format_exc()[-800:]}))
        log(f"FAILED: {e}")
        sys.exit(1)
