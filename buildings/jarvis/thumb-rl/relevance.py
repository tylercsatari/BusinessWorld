"""Label-free relevance leash for the thumbnail reward. Caption a generated thumbnail (gemini-3.5-flash),
embed the caption (gemini-embedding-2, text space), cosine vs the embedded video TITLE. The thumbnail
must be viral (ctrviews percentile) AND actually depict the title's subject — so the model can't win by
generating the same high-scoring image for every title. Mirrors the shorts relevance.py."""
import json, base64, urllib.request, time
import numpy as np
import harness_long as H  # reuses H.GEMINI, H.s3, H.BUCKET, H.DENSITY_FLOOR helpers

CAP_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
EMB_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"

_CAPFAILS = [0]   # consecutive caption failures — a systemic outage must HALT, never silently drop the leash
def caption_thumb(jpg_bytes, tries=4):
    body = json.dumps({"contents": [{"parts": [
        {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(jpg_bytes).decode()}},
        {"text": "This is a YouTube video thumbnail. In ONE sentence, describe the literal subject and "
                 "scene shown — what the video appears to be about. No preamble."}]}]}).encode()
    for a in range(tries):
        try:
            r = urllib.request.Request(CAP_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
            d = json.loads(urllib.request.urlopen(r, timeout=60).read())
            _CAPFAILS[0] = 0
            return d["candidates"][0]["content"]["parts"][0]["text"].strip()
        except urllib.error.HTTPError as e:
            try: msg = e.read().decode()[:250]
            except Exception: msg = "HTTP %s" % e.code
            if "depleted" in msg or "RESOURCE_EXHAUSTED" in msg:
                raise H.GeminiHalt("Gemini credits depleted (caption): " + msg[:100])
            if a < tries - 1: time.sleep(1.5 * (a + 1))
        except H.GeminiHalt:
            raise
        except Exception:
            if a < tries - 1: time.sleep(1.5 * (a + 1))
    # ONE image failing to caption (e.g. safety block) is tolerable — but a STREAK means the API is down,
    # and continuing would silently strip the relevance leash from every reward. Halt instead.
    _CAPFAILS[0] += 1
    if _CAPFAILS[0] >= 8: raise H.GeminiHalt("%d consecutive caption failures — systemic outage" % _CAPFAILS[0])
    return None

def embed_text(text, tries=4):
    # routes through the harness's loud embed (raises GeminiHalt on depletion/persistent failure — never None)
    v = H._embed_call(json.dumps({"content": {"parts": [{"text": text}]}, "outputDimensionality": 1536}).encode(), tries)
    return v / (np.linalg.norm(v) + 1e-8)

def relevance(title_text, thumb_jpg, input_vec=None):
    """Returns (relevance_cosine, caption). input_vec can be precomputed (embed_text(title)) to avoid
    re-embedding the same title across a group."""
    cap = caption_thumb(thumb_jpg)
    if cap is None: return None, None
    cv = embed_text(cap)
    iv = input_vec if input_vec is not None else embed_text(title_text)
    if cv is None or iv is None: return None, cap
    return float(cv @ iv), cap

# Reward shaping. Thumbnail<->title captions are looser than short-hook montages, so a slightly lower
# floor than shorts (0.45); tune from the observed on/off-title margins on the first run.
REL_FLOOR = 0.35   # below this the thumbnail has drifted off the title
def gated_reward(pctile, rel, nn_cos):
    """Be viral (ctrviews pctile) AND on-title (rel) AND on the real-thumbnail manifold (nn_cos)."""
    if rel is None: return pctile  # relevance unavailable -> fall back to percentile only
    rel_pen = max(0.0, REL_FLOOR - rel) * 2.0                 # steep penalty for drifting off-title
    dens_pen = max(0.0, H._density_floor() - nn_cos) * 1.5    # off-manifold guard (from harness.reward_of)
    return pctile - rel_pen - dens_pen
