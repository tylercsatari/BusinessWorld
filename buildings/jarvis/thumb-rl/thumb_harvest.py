"""GRPO-style harvest for long-form THUMBNAILS. For each real video TITLE, the policy REASONS then
emits ONE thumbnail prompt, G times. Each candidate is rendered (flux-schnell 16:9), embedded (Gemini),
scored on the ctrviews percentile, and relevance-gated vs the title. advantage = reward - per-title mean
(the baseline IS the title, so difficulty cancels — no labels). Stores EVERY candidate per title
(reasoning + thumbnail + scores) to R2 for the Guesses tab, and writes advantage-weighted training data.
Env: RUN, MODEL, G, IMG_BUDGET, TITLES."""
import json, os, re, random
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

print("loading %s for run=%s (G=%d)" % (MODEL, RUN, G), flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None: tok.pad_token = tok.eos_token
tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda"); model.eval()
model.config.output_router_logits = False  # SFT-merged Qwen3-MoE bakes this True -> aux-loss crash at generate; off for inference
print("model ready", flush=True)

def gen_batch(titles_list, temp=1.05):
    """G reasoning+prompt attempts for EACH title, all in ONE batched forward pass (the throughput win —
    at G=5 the 30B model barely uses the GPU). Returns a list (per title) of G attempt dicts."""
    prompts = []
    for t in titles_list:
        prompts += [tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": t}],
                                            tokenize=False, add_generation_prompt=True, enable_thinking=True)] * G
    ins = tok(prompts, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=MAXNEW, do_sample=True, temperature=temp, top_p=0.95, pad_token_id=tok.pad_token_id)
    groups = []
    for ti in range(len(titles_list)):
        grp = []
        for gi in range(G):
            full = tok.decode(out[ti * G + gi][ins.input_ids.shape[1]:], skip_special_tokens=True)
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
print("titles=%d resume=%d budget=%d" % (len(titles), len(done), IMG_BUDGET), flush=True)

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
                with open(TRAIN, "a") as f:
                    f.write(json.dumps({"input_id": iid, "title": title, "reasoning": s["reasoning"],
                        "prompt": s["prompt"], "advantage": round(adv, 4)}) + "\n")
            with open(MANIF, "a") as f:
                f.write(json.dumps({"id": "%s_%d" % (iid, k), "input_id": iid, "k": k, "title": title,
                    "x": s["x"], "y": s["y"], "nbr": s["nbr"], "pctile": round(s["pctile"], 4),
                    "nn_cos": round(s["nn_cos"], 4),
                    "relevance": round(s["relevance"], 4) if s["relevance"] is not None else None,
                    "advantage": round(adv, 4), "reward": round(s["reward"], 4),
                    "reasoning": s["reasoning"][:1800], "caption": s["caption"], "prompt": s["prompt"]}) + "\n")
    grp = {"input_id": gid, "title": title, "group_mean": round(base, 4),
           "best_reward": round(scored[0]["reward"], 4), "best_pctile": round(scored[0]["pctile"], 4),
           "spread": round(float(rewards.max() - rewards.min()), 4), "n": len(scored), "attempts": attempts_out,
           "model": os.path.basename(MODEL.rstrip("/"))}
    H.s3.put_object(Bucket=H.BUCKET, Key="longform/guesses/%s/groups/%s.json" % (run, gid),
                    Body=json.dumps(grp).encode(), ContentType="application/json")
    if run == RUN:
        with open(INDEX, "a") as f:
            f.write(json.dumps({"input_id": iid, "title": title, "best_pctile": grp["best_pctile"],
                "best_reward": grp["best_reward"], "group_mean": grp["group_mean"], "spread": grp["spread"], "n": grp["n"]}) + "\n")
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
            try: process_input({"title": title}, iid=rid, run="demo", gkey=rid)
            except Exception as e: print("[demo] err", str(e)[:80], flush=True)
    except Exception as e:
        print("[demo] poll err", str(e)[:80], flush=True)

# process titles in batches of TBATCH: ONE big generation per batch, then score each title's group
pending = [(ii, item) for ii, item in enumerate(titles) if ("t%05d" % ii) not in done]
print("pending after resume: %d (batch %d, maxnew %d)" % (len(pending), TBATCH, MAXNEW), flush=True)
bi = 0
while bi < len(pending):
    serve_requests()                       # answer user demo requests first (live model)
    if H.RENDERS[0] >= IMG_BUDGET: print("=== BUDGET REACHED ==="); break
    chunk = pending[bi:bi + TBATCH]; bi += TBATCH
    try:
        groups = gen_batch([(it.get("title") or "").strip() for _, it in chunk])
    except Exception as e:
        print("[%s] gen_batch err %s" % (RUN, str(e)[:90]), flush=True); continue
    for (ii, item), grp in zip(chunk, groups):
        if H.RENDERS[0] >= IMG_BUDGET: break
        iid = "t%05d" % ii
        try: process_input(item, iid, group=grp)
        except H.BillingHalt as e: print("=== BILLING HALT: %s ===" % str(e)[:80], flush=True); bi = len(pending); break
        except Exception as e: print("[%s] %s err %s" % (RUN, iid, str(e)[:90]), flush=True)
serve_requests()
print("=== THUMB_HARVEST_DONE ===", flush=True)
