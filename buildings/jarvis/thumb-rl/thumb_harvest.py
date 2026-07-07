"""GRPO-style harvest for long-form THUMBNAILS. For each real video TITLE, the policy REASONS then
emits ONE thumbnail prompt, G times. Each candidate is rendered (flux-schnell 16:9), embedded (Gemini),
scored on the ctrviews percentile, and relevance-gated vs the title. advantage = reward - per-title mean
(the baseline IS the title, so difficulty cancels — no labels). Stores EVERY candidate per title
(reasoning + thumbnail + scores) to R2 for the Guesses tab, and writes advantage-weighted training data.
Env: RUN, MODEL, G, IMG_BUDGET, TITLES."""
import json, os, re, random, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness_long as H
import relevance as REL

RUN = os.environ.get("RUN", "thumb1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/thumbrl/models/qwen3-30b-a3b").strip()
G = int(os.environ.get("G", "5"))                 # thumbnails per title (the GRPO group)
IMG_BUDGET = int(os.environ.get("IMG_BUDGET", "10000"))
TBATCH = int(os.environ.get("TBATCH", "8"))       # titles generated per batched forward pass (throughput — GPU is idle at G=5)
MAXNEW = int(os.environ.get("MAXNEW", "700"))     # cap reasoning length (1500 was overkill for a single prompt)
# PROXY MODE (measured: prompt text predicts rendered pctile at held-out r=0.85): generate PROXY_G
# candidates, score them ALL by text-embedding proxy (~free), render only proxy-BEST + proxy-WORST →
# 2 renders/title instead of G, with a deliberately wide DPO gap. Real rendered scores still decide the
# pair (proxy only filters — it can't be reward-hacked into training data).
PROXY_G = int(os.environ.get("PROXY_G", "0"))
_PX = [None]
def proxy_load():
    if _PX[0] is not None: return _PX[0]
    try:
        import joblib
        _PX[0] = joblib.load("/home/ubuntu/thumbrl/data/proxy_prompt.joblib")
        print("proxy loaded: r=%.3f n=%d" % (_PX[0].get("r", 0), _PX[0].get("n", 0)), flush=True)
    except Exception as e:
        print("no proxy (%s) — falling back to render-all-G" % str(e)[:60], flush=True); _PX[0] = False
    return _PX[0]
def proxy_pick(grp):
    """Return the (best, worst) attempts of a candidate group by proxy score, or None if proxy unavailable."""
    px = proxy_load()
    if not px: return None
    cands = [a for a in grp if a.get("prompt")]
    if len(cands) < 2: return None
    embs = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        embs = list(ex.map(lambda a: H._embed_call(json.dumps({"content": {"parts": [{"text": a["prompt"][:1800]}]}, "outputDimensionality": 1536}).encode(), 3), cands))
    X = np.array(embs, np.float32); X /= (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
    s = px["model"].predict(X).ravel()
    return [cands[int(np.argmax(s))], cands[int(np.argmin(s))]]
TITLES = os.environ.get("TITLES", "") or "/home/ubuntu/thumbrl/data/titles.jsonl"
RUNDIR = "/home/ubuntu/thumbrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
TRAIN = RUNDIR + "/thumb_data.jsonl"; INDEX = RUNDIR + "/index.jsonl"; MANIF = RUNDIR + "/manifest.jsonl"

# Minimal task framing ONLY — no creative priors. The model must reason its own way to a thumbnail
# that scores high on the ctrviews axis AND depicts the title; the reward teaches it.
SYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
       "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
       '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
       "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

def split_think(txt):
    m = re.search(r"<think>(.*?)</think>", txt, re.S)
    reasoning = m.group(1).strip() if m else ""
    rest = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try: spec = json.loads(j.group(0)) if j else None
    except Exception: spec = None
    return reasoning, spec

print("loading %s (vLLM) for run=%s (G=%d)" % (MODEL, RUN, G), flush=True)
from vllm import LLM, SamplingParams
tok = AutoTokenizer.from_pretrained(MODEL)
llm = LLM(model=MODEL, dtype="bfloat16", gpu_memory_utilization=0.92, max_model_len=4096, trust_remote_code=True)
SAMPLING = SamplingParams(temperature=1.05, top_p=0.95, max_tokens=MAXNEW)
print("model ready", flush=True)

def gen_batch(titles_list, temp=1.05, n=None):
    """n (default G) reasoning+prompt attempts for EACH title. vLLM continuous-batches ALL prompts with
    proper MoE kernels, so the FULL 1500-token reasoning generates ~15-40x faster than transformers (which
    is the slow-MoE bottleneck we hit). vLLM preserves prompt order. Returns a list (per title) of dicts."""
    n = n or G
    prompts = []
    for t in titles_list:
        prompts += [tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": t}],
                                            tokenize=False, add_generation_prompt=True, enable_thinking=True)] * n
    outs = llm.generate(prompts, SAMPLING)
    groups = []
    for ti in range(len(titles_list)):
        grp = []
        for gi in range(n):
            full = outs[ti * n + gi].outputs[0].text
            reasoning, spec = split_think(full)
            pr = spec.get("prompt") if spec else None
            grp.append({"reasoning": reasoning, "prompt": pr if (isinstance(pr, str) and len(pr.strip()) > 8) else None, "completion": full})
        groups.append(grp)
    return groups
def gen_group(title, n=G, temp=1.05):
    return gen_batch([title], temp)[0]

def score_attempt(att, title_vec):
    if not att["prompt"]: return None
    jpg, emb, sc = H.render_score(att["prompt"])
    if sc is None: return None
    rel, cap = REL.relevance(None, jpg, input_vec=title_vec)
    reward = REL.gated_reward(sc["pctile"], rel, sc["nn_cos"])
    return {**att, "jpg": jpg, "pctile": sc["pctile"], "nn_cos": sc["nn_cos"],
            "x": sc["x"], "y": sc["y"], "nbr": sc["nbr"], "relevance": rel, "caption": cap, "reward": reward}

# load + dedup titles so inputs are distinct
titles = []
for l in open(TITLES):
    l = l.strip()
    if l:
        try: titles.append(json.loads(l))
        except Exception: pass
random.Random(0).shuffle(titles)
def tkey(t): return re.sub(r"\W+", "", (t or "").lower())[:80]
uniq, seen = [], set()
for t in titles:
    k = tkey(t.get("title", ""))
    if k and k not in seen: seen.add(k); uniq.append(t)
titles = uniq
# seed local index+manifest from R2 so a restart resumes and ACCUMULATES (never overwrites prior rows)
for local, key in [(INDEX, "longform/guesses/%s/index.jsonl" % RUN), (MANIF, "longform/guesses/%s/manifest.jsonl" % RUN)]:
    if not os.path.exists(local):
        try: open(local, "wb").write(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read())
        except Exception: pass
done = set()
if os.path.exists(INDEX):
    for l in open(INDEX):
        try: done.add(json.loads(l)["input_id"])
        except Exception: pass
# FRESH INPUTS EVERY ROUND: also skip titles ANY previous round already used. The fixed shuffle seed makes
# input_ids stable across rounds, so each round continues into unseen titles instead of re-grinding the same
# ones — the model must generalize to new inputs, not memorize a fixed slice. (24k titles ≈ many rounds.)
for _n in range(1, 41):
    try:
        for l in H.s3.get_object(Bucket=H.BUCKET, Key="longform/guesses/thumb%d/index.jsonl" % _n)["Body"].read().decode().splitlines():
            try: done.add(json.loads(l)["input_id"])
            except Exception: pass
    except Exception: pass
print("cross-round resume: %d titles already used by ANY round -> this round gets fresh ones" % len(done), flush=True)
print("titles=%d resume=%d budget=%d" % (len(titles), len(done), IMG_BUDGET), flush=True)
import threading as _th
_WLOCK = _th.Lock(); PRODUCED = [0]   # lock guards the shared local jsonl files; PRODUCED = new groups THIS run (for the overnight loop)

def process_input(item, iid, group=None, run=RUN, gkey=None):
    """Generate G reasoned thumbnails for one title, render+score, store the group. For run==RUN it also
    feeds the trainer (thumb_data) + the map manifest; for run=='demo' it just stores the group so a
    demo tab can show the live model's thumbnails for a user-submitted title."""
    title = (item.get("title") or "").strip()
    title_vec = REL.embed_text(title)
    if group is None: group = gen_group(title)
    with ThreadPoolExecutor(max_workers=8) as ex:
        scored = [r for r in ex.map(lambda a: score_attempt(a, title_vec), group) if r]
    if len(scored) < 2: return False
    rewards = np.array([s["reward"] for s in scored], float)
    base = float(rewards.mean()); scored.sort(key=lambda s: -s["reward"])
    gid = gkey or iid; attempts_out = []
    for k, s in enumerate(scored):
        mk = "longform/guesses/%s/montages/%s_%d.jpg" % (run, gid, k)
        H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=s["jpg"], ContentType="image/jpeg")
        adv = s["reward"] - base
        attempts_out.append({"k": k, "reasoning": s["reasoning"][:2000], "prompt": s["prompt"],
            "montage_key": mk, "pctile": round(s["pctile"], 4),
            "relevance": round(s["relevance"], 4) if s["relevance"] is not None else None,
            "nn_cos": round(s["nn_cos"], 4), "reward": round(s["reward"], 4), "advantage": round(adv, 4),
            "caption": s["caption"], "x": s["x"], "y": s["y"], "nbr": s["nbr"]})
        if run == RUN:  # training run: feed the trainer + the Guesses-map manifest
            if adv > 0.02:
                with _WLOCK, open(TRAIN, "a") as f:
                    f.write(json.dumps({"input_id": iid, "title": title, "reasoning": s["reasoning"],
                        "prompt": s["prompt"], "advantage": round(adv, 4)}) + "\n")
            with _WLOCK, open(MANIF, "a") as f:
                f.write(json.dumps({"id": "%s_%d" % (iid, k), "input_id": iid, "k": k, "title": title,
                    "x": s["x"], "y": s["y"], "nbr": s["nbr"], "pctile": round(s["pctile"], 4),
                    "nn_cos": round(s["nn_cos"], 4),
                    "relevance": round(s["relevance"], 4) if s["relevance"] is not None else None,
                    "advantage": round(adv, 4), "reward": round(s["reward"], 4),
                    "reasoning": s["reasoning"], "caption": s["caption"], "prompt": s["prompt"]}) + "\n")   # FULL reasoning — truncated copies poisoned DPO (model learned to never close <think>)
    grp = {"input_id": gid, "title": title, "group_mean": round(base, 4),
           "best_reward": round(scored[0]["reward"], 4), "best_pctile": round(scored[0]["pctile"], 4),
           "spread": round(float(rewards.max() - rewards.min()), 4), "n": len(scored), "attempts": attempts_out,
           "model": os.path.basename(MODEL.rstrip("/"))}
    H.s3.put_object(Bucket=H.BUCKET, Key="longform/guesses/%s/groups/%s.json" % (run, gid),
                    Body=json.dumps(grp).encode(), ContentType="application/json")
    if run == RUN:
        with _WLOCK:
            with open(INDEX, "a") as f:
                f.write(json.dumps({"input_id": iid, "title": title, "best_pctile": grp["best_pctile"],
                    "best_reward": grp["best_reward"], "group_mean": grp["group_mean"], "spread": grp["spread"], "n": grp["n"]}) + "\n")
            PRODUCED[0] += 1
            H.s3.upload_file(INDEX, H.BUCKET, "longform/guesses/%s/index.jsonl" % RUN)
            H.s3.upload_file(MANIF, H.BUCKET, "longform/guesses/%s/manifest.jsonl" % RUN)
    print("[%s] %s n=%d best_pct=%.0f%% best_rew=%.2f mean=%.2f spread=%.2f imgs=%d $%.2f" % (
        run, gid, len(scored), grp["best_pctile"]*100, grp["best_reward"], base, grp["spread"], H.RENDERS[0], H.RENDERS[0]*0.003), flush=True)
    return True

_served = set()
def serve_requests():
    """On-demand demo: any user title queued at longform/guesses/requests/ gets thumbnails from the CURRENT
    (in-training) model, into run 'demo' — so you can use the working model while later rounds train."""
    try:
        r = H.s3.list_objects_v2(Bucket=H.BUCKET, Prefix="longform/guesses/requests/")
        for o in r.get("Contents", []):
            key = o["Key"]
            if not key.endswith(".json"): continue
            rid = key.rsplit("/", 1)[-1][:-5]
            if rid in _served: continue
            _served.add(rid)
            try: title = (json.loads(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read()).get("title") or "").strip()
            except Exception: title = ""
            H.s3.delete_object(Bucket=H.BUCKET, Key=key)
            if not title: continue
            print("[demo] serving %s: %s" % (rid, title[:60]), flush=True)
            # user-facing request: BEST-OF-N serving — generate DEMO_G candidates, render+score ALL,
            # return ranked (the way to hand back the best possible thumbnail for an arbitrary input)
            try: process_input({"title": title}, iid=rid, group=gen_group(title, n=int(os.environ.get("DEMO_G", "12"))), run="demo", gkey=rid)
            except Exception as e: print("[demo] err", str(e)[:80], flush=True)
    except Exception as e:
        print("[demo] poll err", str(e)[:80], flush=True)

# process titles in batches of TBATCH — PIPELINED: while the GPU generates batch N+1, batch N renders and
# scores in a background lane (these used to serialize: GPU idled during renders, renders idled during gen).
pending = [(ii, item) for ii, item in enumerate(titles) if ("t%05d" % ii) not in done]
SHARD = os.environ.get("TITLE_SHARD", "")   # "0/2" and "1/2" let TWO boxes harvest disjoint titles with zero coordination
if SHARD:
    _k, _m = (int(x) for x in SHARD.split("/"))
    pending = [(ii, it) for (ii, it) in pending if ii % _m == _k]
print("pending after resume: %d (batch %d, maxnew %d, pipelined%s)" % (len(pending), TBATCH, MAXNEW, (", shard " + SHARD) if SHARD else ""), flush=True)
def _do(pair):
    (ii, item), grp = pair
    if H.RENDERS[0] >= IMG_BUDGET: return
    try:
        if PROXY_G:
            g2 = proxy_pick(grp)           # text-proxy filters PROXY_G candidates → render only best+worst
            if g2: grp = g2
        process_input(item, "t%05d" % ii, group=grp)
    except (H.BillingHalt, H.GeminiHalt): raise
    except Exception as e: print("[%s] t%05d err %s" % (RUN, ii, str(e)[:90]), flush=True)
SCORE_EX = ThreadPoolExecutor(max_workers=16)   # background render+score lane (network-bound)
def _join(futs):
    """Drain a scoring batch; surface halts LOUDLY (BillingHalt stops the run, GeminiHalt waits + resumes)."""
    for f in futs:
        try: f.result()
        except H.BillingHalt as e:
            H.write_status("halted-replicate", str(e)); print("=== BILLING HALT: %s ===" % str(e)[:80], flush=True); return "stop"
        except H.GeminiHalt as e:
            H.write_status("halted-gemini", str(e))
            print("=== GEMINI HALT: %s — waiting 5 min, auto-resumes ===" % str(e)[:110], flush=True)
            ok2, m2 = H.gemini_ok()
            while not ok2: time.sleep(300); ok2, m2 = H.gemini_ok()
            H.write_status("running", "resumed after gemini halt")
    return None
bi = 0; prev_futs = []; halted = False
while bi < len(pending):
    serve_requests()                       # answer user demo requests first (live model)
    if H.RENDERS[0] >= IMG_BUDGET: print("=== BUDGET REACHED ==="); break
    chunk = pending[bi:bi + TBATCH]; bi += TBATCH
    try:
        groups = gen_batch([(it.get("title") or "").strip() for _, it in chunk], n=(PROXY_G or G))  # GPU lane
    except Exception as e:
        print("[%s] gen_batch err %s" % (RUN, str(e)[:90]), flush=True); continue
    if _join(prev_futs) == "stop": prev_futs = []; halted = True; break   # ≤1 scoring batch in flight behind the GPU
    # NEVER render while Gemini can't score (paying for unscoreable images) — gate before the render lane
    ok, msg = H.gemini_ok()
    while not ok:
        H.write_status("halted-gemini", msg)
        print("=== GEMINI HALT: %s — waiting 5 min, auto-resumes when credits are back ===" % msg[:110], flush=True)
        time.sleep(300); ok, msg = H.gemini_ok()
    H.write_status("running", "run %s · %d renders" % (RUN, H.RENDERS[0]))
    prev_futs = [SCORE_EX.submit(_do, p) for p in zip(chunk, groups)]
if not halted: _join(prev_futs)                 # drain the last in-flight batch
serve_requests()
try:
    with open(RUNDIR + "/_produced", "w") as fp: fp.write(str(PRODUCED[0]))   # overnight loop reads this (robust vs the wc -l resume bug)
except Exception: pass
H.write_status("done", "run %s produced %d groups" % (RUN, PRODUCED[0]))
print("=== THUMB_HARVEST_DONE produced=%d ===" % PRODUCED[0], flush=True)
