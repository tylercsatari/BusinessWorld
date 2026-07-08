"""Post-training Long Quant demo server.

Loads the trained long-form thumbnail model and ONLY answers BusinessWorld
Experiment-tab requests from longform/guesses/requests/. It does not harvest,
train, update, or advance rounds.

Typed title/idea -> thumbnail prompts -> render -> score -> longform/guesses/demo.
Blank request     -> sample from the trained idea model's accepted idea bank,
                     then do the same thumbnail flow.
"""
import json, os, random, re, time
from concurrent.futures import ThreadPoolExecutor

from transformers import AutoTokenizer
from vllm import LLM, SamplingParams

import harness_long as H
import relevance as REL

MODEL = os.environ.get("MODEL", "/home/ubuntu/thumbrl/models/thumbmerged_b10").strip()
COUNT_DEFAULT = int(os.environ.get("DEMO_G", "5"))
MAXNEW = int(os.environ.get("MAXNEW", "450"))
RUN = "demo"

SYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
       "Return ONLY JSON: "
       '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
       "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

print("serve_only_long loading %s" % MODEL, flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
llm = LLM(model=MODEL, dtype="bfloat16", gpu_memory_utilization=0.92, max_model_len=2048, trust_remote_code=True)
SAMPLING = SamplingParams(temperature=1.0, top_p=0.95, max_tokens=MAXNEW)
print("serve_only_long ready", flush=True)

_IDEAS = None
def r2_jsonl(key):
    try:
        b = H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read().decode()
        return [json.loads(l) for l in b.splitlines() if l.strip()]
    except Exception:
        return []

def idea_bank():
    global _IDEAS
    if _IDEAS is not None:
        return _IDEAS
    rows = []
    for n in range(30, 19, -1):
        for key in ("longform/ideas/idea%d/accepted.jsonl" % n, "longform/ideas/idea%d/index.jsonl" % n):
            xs = r2_jsonl(key)
            if xs:
                rows.extend(xs)
                break
        if rows:
            break
    clean = []
    seen = set()
    for r in rows:
        idea = str(r.get("idea") or r.get("title") or "").strip()
        if len(idea) < 8:
            continue
        k = re.sub(r"\W+", "", idea.lower())[:90]
        if k in seen:
            continue
        seen.add(k)
        clean.append({"idea": idea, "pctile": float(r.get("pctile") or r.get("vis_pctile") or 0), "novelty": r.get("novelty")})
    clean.sort(key=lambda x: -x["pctile"])
    _IDEAS = clean[:500] if clean else [{"idea": "I Built a Real Working Superhero Gadget and Tested It Until It Broke", "pctile": 0.0}]
    print("idea bank loaded: %d ideas" % len(_IDEAS), flush=True)
    return _IDEAS

def sample_idea():
    bank = idea_bank()
    top = bank[:min(len(bank), 120)]
    return random.choice(top)["idea"] if top else bank[0]["idea"]

def split_prompt(txt):
    rest = re.sub(r"<think>.*?</think>", "", txt or "", flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try:
        spec = json.loads(j.group(0)) if j else None
    except Exception:
        spec = None
    p = spec.get("prompt") if isinstance(spec, dict) else None
    return p.strip() if isinstance(p, str) and len(p.strip()) > 8 else None

def gen_group(title, n):
    prompts = [tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": title}],
                                       tokenize=False, add_generation_prompt=True, enable_thinking=False)] * n
    outs = llm.generate(prompts, SAMPLING)
    rows = []
    for o in outs:
        p = split_prompt(o.outputs[0].text)
        if p:
            rows.append({"reasoning": "", "prompt": p, "completion": o.outputs[0].text})
    return rows

def score_attempt(att, title_vec):
    if not att.get("prompt"):
        return None
    jpg, emb, sc = H.render_score(att["prompt"])
    if sc is None:
        return None
    rel, cap = REL.relevance_emb(emb, title_vec)
    reward = REL.gated_reward(sc["pctile"], rel, sc["nn_cos"])
    return {**att, "jpg": jpg, "pctile": sc["pctile"], "nn_cos": sc["nn_cos"], "x": sc["x"], "y": sc["y"],
            "nbr": sc["nbr"], "relevance": rel, "caption": cap, "reward": reward}

def status(rid, **kw):
    H.s3.put_object(Bucket=H.BUCKET, Key="longform/guesses/demo/status/%s.json" % rid,
                    Body=json.dumps({**kw, "ts": int(time.time() * 1000)}).encode(), ContentType="application/json")

def process_request(rid, title, count, invented=False):
    title_vec = REL.embed_text(title)
    status(rid, stage="reasoning", title=title, note="trained thumbnail model is writing candidates", n=count, done=0)
    group = gen_group(title, count)
    status(rid, stage="rendering", title=title, note="rendering and scoring thumbnails", n=len(group), done=0)
    with ThreadPoolExecutor(max_workers=8) as ex:
        scored = []
        for i, r in enumerate(ex.map(lambda a: score_attempt(a, title_vec), group)):
            if r:
                scored.append(r)
            status(rid, stage="rendering", title=title, note="rendering and scoring thumbnails", n=len(group), done=i + 1)
    if not scored:
        H.s3.put_object(Bucket=H.BUCKET, Key="longform/guesses/demo/groups/%s.json" % rid,
                        Body=json.dumps({"input_id": rid, "title": title, "attempts": [], "done": True,
                                         "error": "no thumbnails rendered"}).encode(), ContentType="application/json")
        status(rid, stage="done", title=title, error="no thumbnails rendered")
        return
    rewards = [s["reward"] for s in scored]
    base = sum(rewards) / max(1, len(rewards))
    scored.sort(key=lambda s: -s["reward"])
    attempts = []
    for k, s in enumerate(scored):
        mk = "longform/guesses/%s/montages/%s_%d.jpg" % (RUN, rid, k)
        H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=s["jpg"], ContentType="image/jpeg")
        attempts.append({"k": k, "reasoning": s.get("reasoning", "")[:2000], "prompt": s["prompt"], "montage_key": mk,
                         "pctile": round(s["pctile"], 4), "relevance": round(s["relevance"], 4) if s["relevance"] is not None else None,
                         "nn_cos": round(s["nn_cos"], 4), "reward": round(s["reward"], 4), "advantage": round(s["reward"] - base, 4),
                         "caption": s.get("caption"), "x": s["x"], "y": s["y"], "nbr": s["nbr"]})
    H.s3.put_object(Bucket=H.BUCKET, Key="longform/guesses/%s/groups/%s.json" % (RUN, rid),
                    Body=json.dumps({"input_id": rid, "title": title, "invented": invented, "n": len(attempts),
                                     "best_pctile": attempts[0]["pctile"], "group_mean": round(base, 4),
                                     "best_reward": attempts[0]["reward"], "spread": round(max(rewards) - min(rewards), 4),
                                     "model": os.path.basename(MODEL.rstrip("/")), "attempts": attempts, "done": True}).encode(),
                    ContentType="application/json")
    status(rid, stage="done", title=title, n=len(attempts), done=len(attempts), best=attempts[0]["pctile"])
    print("[demo] %s n=%d best=%.0f%% title=%s" % (rid, len(attempts), attempts[0]["pctile"] * 100, title[:80]), flush=True)

_served = set()
def serve_once():
    try:
        r = H.s3.list_objects_v2(Bucket=H.BUCKET, Prefix="longform/guesses/requests/")
        for o in r.get("Contents", []):
            key = o["Key"]
            if not key.endswith(".json"):
                continue
            rid = key.rsplit("/", 1)[-1][:-5]
            if rid in _served:
                continue
            _served.add(rid)
            try:
                req = json.loads(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read())
            except Exception:
                req = {}
            H.s3.delete_object(Bucket=H.BUCKET, Key=key)
            title = str(req.get("title") or req.get("idea") or req.get("premise") or "").strip()
            invented = False
            if not title:
                title = sample_idea()
                invented = True
            count = max(1, min(12, int(req.get("count") or COUNT_DEFAULT)))
            print("[demo] serving %s x%d invented=%s" % (rid, count, invented), flush=True)
            process_request(rid, title, count, invented)
    except Exception as e:
        print("[demo] poll err", str(e)[:120], flush=True)

print("=== SERVE_ONLY_LONG_RUNNING ===", flush=True)
while True:
    serve_once()
    time.sleep(3)
