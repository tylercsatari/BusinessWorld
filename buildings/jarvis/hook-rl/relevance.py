"""Label-free relevance leash for the GRPO reward. Caption a generated montage (gemini-3.5-flash),
embed the caption (gemini-embedding-2, text space), cosine vs the embedded INPUT idea. Validated:
own-input relevance ranks #1 with a ~0.2-0.3 margin over mismatched inputs (6/6). No niches/labels.

reward = keep_pctile  gated/penalized by relevance, so the policy must be viral AND stay on-input."""
import json, base64, urllib.request, time
import numpy as np
import harness as H  # reuses H.GEMINI, H.embed_image, H.s3, H.BUCKET

CAP_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"

def caption_montage(jpg_bytes, tries=4):
    body = json.dumps({"contents": [{"parts": [
        {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(jpg_bytes).decode()}},
        {"text": "These are the first 5 frames (1/sec) of a short video, tiled left-to-right. In ONE sentence, "
                 "describe the literal subject and action shown — what the video appears to be about. No preamble."}]}]}).encode()
    for a in range(tries):
        try:
            r = urllib.request.Request(CAP_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
            d = json.loads(urllib.request.urlopen(r, timeout=60).read())
            return d["candidates"][0]["content"]["parts"][0]["text"].strip()
        except Exception:
            if a < tries - 1: time.sleep(1.5 * (a + 1))
    return None

def embed_text(text, tries=4):
    body = json.dumps({"content": {"parts": [{"text": text}]}, "outputDimensionality": 1536}).encode()
    for a in range(tries):
        try:
            r = urllib.request.Request(EMB_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
            v = np.array(json.loads(urllib.request.urlopen(r, timeout=60).read())["embedding"]["values"], np.float32)
            return v / (np.linalg.norm(v) + 1e-8)
        except Exception:
            if a < tries - 1: time.sleep(1.5 * (a + 1))
    return None

def relevance(input_text, montage_jpg, input_vec=None):
    """Returns (relevance_cosine, caption). input_vec can be precomputed (embed_text(input_text)) to
    avoid re-embedding the same idea across a group."""
    cap = caption_montage(montage_jpg)
    if cap is None: return None, None
    cv = embed_text(cap)
    iv = input_vec if input_vec is not None else embed_text(input_text)
    if cv is None or iv is None: return None, cap
    return float(cv @ iv), cap

# Reward shaping (validated leash margins: on-topic ~0.5-0.75, off-topic ~0.25-0.45).
REL_FLOOR = 0.45   # below this the montage has drifted off the input idea
def gated_reward(keep_pctile, rel, nn_cos, density_floor=H.DENSITY_FLOOR):
    """Be viral (keep_pctile) AND on-input (rel) AND on the real-hook manifold (nn_cos).
    Hard relevance gate so off-topic 'cheats' can't win, plus the existing density guard."""
    if rel is None: return keep_pctile  # relevance unavailable -> fall back to keep only
    rel_pen = max(0.0, REL_FLOOR - rel) * 2.0          # steep penalty for drifting off-input
    dens_pen = max(0.0, density_floor - nn_cos) * 1.5  # off-manifold guard (from harness.reward_of)
    return keep_pctile - rel_pen - dens_pen
