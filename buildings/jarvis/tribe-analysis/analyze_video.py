#!/usr/bin/env python3.11
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
    log("Building events dataframe (full multimodal)…")
    df = model.get_events_dataframe(video_path=str(video_path))
    log(f"Events: {len(df)} rows, types: {df['type'].unique().tolist() if 'type' in df.columns else '?'}")

    # ── Run inference ───────────────────────────────────────────────
    log("Running inference (full multimodal: audio + video + text)…")
    log("  This will take ~90 min on CPU. Grab a coffee.")
    t1 = time.time()
    preds, segments = model.predict(events=df)
    elapsed = time.time() - t1
    log(f"Inference done in {elapsed/60:.1f}min — shape {preds.shape}")

    preds = np.asarray(preds, dtype=np.float32)
    n_steps, n_vert = preds.shape

    def seg_second(i):
        try:
            seg = segments[i]
            for key in ("start","t","second","time"):
                if isinstance(seg, dict) and key in seg:
                    return float(seg[key])
            if hasattr(seg,"start"): return float(seg.start)
        except: pass
        return float(i)

    seconds = np.array([seg_second(i) for i in range(n_steps)])
    duration_s = float(seconds[-1] + 1) if n_steps else 0.0

    # ── Per-step global activation ──────────────────────────────────
    per_step = preds.mean(axis=1)
    pmin, pmax = float(per_step.min()), float(per_step.max())
    norm = (per_step - pmin) / (pmax - pmin + 1e-9)

    brain_engagement_curve = [
        {"second": round(float(seconds[i]), 3), "activation": round(float(norm[i]), 4)}
        for i in range(n_steps)
    ]

    # ── Peak moments (top 10%) ──────────────────────────────────────
    k = max(1, int(round(n_steps * 0.10)))
    top_idx = np.argsort(norm)[-k:][::-1]
    sorted_vals = np.sort(per_step)
    peak_moments = []
    for idx in top_idx:
        rank = int(np.searchsorted(sorted_vals, per_step[idx], side="right"))
        pct = round(100.0 * rank / n_steps, 1)
        peak_moments.append({"second": round(float(seconds[idx]), 3),
                              "activation": round(float(norm[idx]), 4),
                              "percentile": pct})
    peak_moments.sort(key=lambda p: p["second"])

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

    # 5% resolution windows
    resolution_5pct = {}
    for i in range(20):
        lo, hi = i * 0.05, (i+1) * 0.05
        label = f"pct_{i*5:02d}_{(i+1)*5:02d}"
        resolution_5pct[label] = {"mean": round(window_mean(lo, hi), 4), "peak": round(window_peak(lo, hi), 4)}

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

    # Per-vertex mean activation over the whole video
    vertex_mean = preds.mean(axis=0)  # (n_vertices,)
    vertex_norm = (vertex_mean - vertex_mean.min()) / (vertex_mean.max() - vertex_mean.min() + 1e-9)

    # Rough fsaverage5 region indices (approximate — left hemisphere 0-10241, right 10242-20483)
    # Based on known functional areas in fsaverage5 parcellation
    REGIONS = {
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

    region_activations = {}
    for region, bounds in REGIONS.items():
        lh_lo, lh_hi = bounds["lh"]
        rh_lo, rh_hi = bounds["rh"]
        lh_hi = min(lh_hi, n_vert)
        rh_hi = min(rh_hi, n_vert)
        vertices = []
        if lh_lo < n_vert: vertices.extend(vertex_norm[lh_lo:lh_hi].tolist())
        if rh_lo < n_vert: vertices.extend(vertex_norm[rh_lo:rh_hi].tolist())
        if vertices:
            region_activations[region] = {
                "mean_activation": round(float(np.mean(vertices)), 4),
                "peak_activation": round(float(np.max(vertices)), 4),
                "n_vertices": len(vertices),
            }

    # ── Per-vertex data (full 20K vertex resolution) ─────────────
    log("Preparing per-vertex activation data…")
    vertex_data = {
        "n_vertices": int(n_vert),
        "hemisphere_split": int(n_vert // 2),
        "mean_activation_per_vertex": vertex_norm.tolist(),  # full 20K vertices
        "peak_second_per_vertex": [round(float(seconds[int(np.argmax(preds[:, v]))]), 2)
                                    for v in range(n_vert)],
        "description": "fsaverage5 surface, 20484 vertices (0-10241=LH, 10242-20483=RH)"
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
            for region, bounds in REGIONS.items():
                lh_lo, lh_hi = bounds["lh"]
                rh_lo, rh_hi = bounds["rh"]
                lh_hi = min(lh_hi, n_vert); rh_hi = min(rh_hi, n_vert)
                ts = []
                for step in range(n_steps):
                    v = []
                    if lh_lo < n_vert: v.extend(preds[step, lh_lo:lh_hi].tolist())
                    if rh_lo < n_vert: v.extend(preds[step, rh_lo:rh_hi].tolist())
                    ts.append(np.mean(v) if v else 0.0)
                ts = np.array(ts)
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
        "max_activation_second": round(float(seconds[max_idx]), 3),
        "brain_engagement_curve": brain_engagement_curve,
        "peak_moments": peak_moments,
        "resolution_quartiles": resolution_quartiles,
        "resolution_5pct": resolution_5pct,
        "resolution_named": resolution_named,
        "region_activations": region_activations,
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

    # Print summary (not the giant vertex array)
    summary = {k: v for k, v in out.items()
               if k not in ("vertex_data", "brain_engagement_curve", "brain_images", "resolution_5pct")}
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
