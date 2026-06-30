"""Novelty-forced viral-IDEA discovery + training (the 'map the viral landscape' approach).
The model INVENTS a video idea AND its 5-frame opening hook in one shot. Reward = keep-percentile of
the rendered hook, GATED BY NOVELTY: an idea too semantically close (TEXT embedding) to an already-
accepted idea is rejected — forcing the model to keep finding NEW high-keep regions instead of
collapsing onto the single attractor. Accepted (high-keep AND novel) ideas (a) train the model via
RAFT and (b) stream to the Guesses map. Env: RUN, MODEL, G, IMG_BUDGET, KEEP_FLOOR, NOV_FLOOR."""
import json, os, re, random
from concurrent.futures import ThreadPoolExecutor
import numpy as np, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness as H
import relevance as REL

RUN = os.environ.get("RUN", "discover1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/hookrl/models/qwen3-30b-a3b").strip()
G = int(os.environ.get("G", "8"))                       # candidate ideas per generation step
IMG_BUDGET = int(os.environ.get("IMG_BUDGET", "8000"))
KEEP_FLOOR = float(os.environ.get("KEEP_FLOOR", "0.70"))   # accept only genuinely high-keep ideas
NOV_FLOOR = float(os.environ.get("NOV_FLOOR", "0.22"))     # 1-cos; accept only if >=this far from EVERY accepted idea
RUNDIR = "/home/ubuntu/hookrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
TRAIN = RUNDIR + "/raft_data.jsonl"; MANIF = RUNDIR + "/manifest.jsonl"; ACC = RUNDIR + "/accepted.jsonl"

# No input, no anchor: the model invents the idea too. Novelty (not a tether) prevents collapse.
SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Think about what would "
       "make people NOT swipe away, then return ONLY JSON: "
       '{"premise":"the one-line video idea","cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast",'
       '"frames":["photographic prompt for second 1", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

def split(txt):
    m = re.search(r"<think>(.*?)</think>", txt, re.S); reasoning = m.group(1).strip() if m else ""
    rest = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try: spec = json.loads(j.group(0)) if j else None
    except Exception: spec = None
    return reasoning, spec

print("loading %s for run=%s (novelty discovery)" % (MODEL, RUN), flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None: tok.pad_token = tok.eos_token
tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda")
model.config.output_router_logits = False; model.eval()
print("model ready", flush=True)

def gen(n=G, temp=1.1):
    text = tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": "Invent one now."}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=True)
    ins = tok([text] * n, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=2200, do_sample=True, temperature=temp, top_p=0.95, pad_token_id=tok.pad_token_id)
    res = []
    for i in range(n):
        reasoning, spec = split(tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True))
        if not spec: continue
        prem = (spec.get("premise") or "").strip(); fr = spec.get("frames")
        if prem and isinstance(fr, list) and len(fr) == 5:
            res.append({"premise": prem, "cohesion_mode": spec.get("cohesion_mode", "?"), "frames": fr, "reasoning": reasoning})
    return res

def score(c):
    frames, mont, sc = H.render_score_keep(c["frames"])
    if sc is None: return None
    c.update({"mont": mont, "keep_pctile": sc["keep_pctile"], "nn_cos": sc["nn_cos"], "x": sc["x"], "y": sc["y"], "nbr": sc["nbr"]})
    return c

# ── Experiments-tab demo: serve user "idea -> N hooks" requests with this same model, between steps ──
HOOK_SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
            "Think about the strongest opening for THIS specific video, then return ONLY JSON: "
            '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")
_served = set()
def _stat(rid, **kw): H.s3.put_object(Bucket=H.BUCKET, Key="hooks/grpo/demo/status/%s.json" % rid, Body=json.dumps(kw).encode(), ContentType="application/json")
def gen_hooks_for(premise, n):
    text = tok.apply_chat_template([{"role": "system", "content": HOOK_SYS}, {"role": "user", "content": premise}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=True)
    ins = tok([text] * n, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=2200, do_sample=True, temperature=1.0, top_p=0.95, pad_token_id=tok.pad_token_id)
    sp = []
    for i in range(n):
        reasoning, spec = split(tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True))
        fr = spec.get("frames") if spec else None
        if isinstance(fr, list) and len(fr) == 5: sp.append({"cohesion_mode": spec.get("cohesion_mode", "?"), "frames": fr, "reasoning": reasoning})
    return sp
def serve_requests():
    try:
        for o in H.s3.list_objects_v2(Bucket=H.BUCKET, Prefix="hooks/grpo/requests/").get("Contents", []):
            key = o["Key"]
            if not key.endswith(".json"): continue
            rid = key.rsplit("/", 1)[-1][:-5]
            if rid in _served: continue
            _served.add(rid)
            try: req = json.loads(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read())
            except Exception: req = {}
            prem = (req.get("premise") or "").strip(); n = max(1, min(int(req.get("count", 4)), 8))
            invent = bool(req.get("invent")) or not prem
            H.s3.delete_object(Bucket=H.BUCKET, Key=key)
            print("[demo] %s x%d invent=%s: %s" % (rid, n, invent, prem[:50]), flush=True)
            _stat(rid, stage="reasoning", premise=prem or "(inventing an idea…)")
            if invent:
                invented = gen(n)                       # model dreams up idea+hook
                specs = [{"cohesion_mode": c["cohesion_mode"], "frames": c["frames"], "reasoning": c["reasoning"], "premise": c["premise"]} for c in invented]
                prem = prem or "💡 invented by the model"
            else:
                specs = gen_hooks_for(prem, n)
            _stat(rid, stage="rendering", premise=prem, n=len(specs))
            with ThreadPoolExecutor(max_workers=8) as ex:
                sc = [r for r in ex.map(score, specs) if r]
            sc.sort(key=lambda z: -z["keep_pctile"]); att = []
            for k, s in enumerate(sc):
                mk = "hooks/grpo/demo/montages/%s_%d.jpg" % (rid, k)
                H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=s["mont"], ContentType="image/jpeg")
                att.append({"k": k, "reasoning": s["reasoning"][:2000], "cohesion_mode": s["cohesion_mode"], "frames": s["frames"],
                    "montage_key": mk, "keep_pctile": round(s["keep_pctile"], 4), "relevance": None, "nn_cos": round(s["nn_cos"], 4),
                    "reward": round(s["keep_pctile"], 4), "advantage": 0, "caption": s.get("premise", prem), "x": s["x"], "y": s["y"], "nbr": s["nbr"]})
            H.s3.put_object(Bucket=H.BUCKET, Key="hooks/grpo/demo/groups/%s.json" % rid, Body=json.dumps({
                "input_id": rid, "premise": prem, "n": len(att), "best_keep": att[0]["keep_pctile"] if att else 0,
                "group_mean": 0, "best_reward": 0, "spread": 0, "model": os.path.basename(MODEL.rstrip("/")), "attempts": att}).encode(),
                ContentType="application/json")
            _stat(rid, stage="done")
    except Exception as e: print("[demo] err", str(e)[:80], flush=True)

# --- accepted set (the growing diverse map of viral ideas); seed from R2 for resume ---
acc_prem, acc_emb = [], []   # premise text + its text-embedding
for local, key in [(MANIF, "hooks/grpo/%s/manifest.jsonl" % RUN), (TRAIN, "hooks/grpo/%s/raft_data.jsonl" % RUN), (ACC, "hooks/grpo/%s/accepted.jsonl" % RUN)]:
    if not os.path.exists(local):
        try: open(local, "wb").write(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read())
        except Exception: pass
if os.path.exists(ACC):
    for l in open(ACC):
        try:
            p = json.loads(l)["premise"]; e = REL.embed_text(p)
            if e is not None: acc_prem.append(p); acc_emb.append(e)
        except Exception: pass
print("seeded %d accepted ideas" % len(acc_prem), flush=True)
def novelty(emb):
    if not acc_emb: return 1.0
    return 1.0 - float(np.max(np.array(acc_emb) @ emb))   # 1 = brand new, 0 = duplicate of an accepted idea

step = 0
while H.RENDERS[0] < IMG_BUDGET:
    step += 1
    serve_requests()          # answer Experiments-tab demo requests first, with the live model
    cands = gen()
    with ThreadPoolExecutor(max_workers=8) as ex:
        scored = [r for r in ex.map(score, cands) if r]
    for c in scored:
        if c["keep_pctile"] < KEEP_FLOOR: continue                 # not viral enough (per proxy)
        emb = REL.embed_text(c["premise"])
        if emb is None: continue
        nov = novelty(emb)
        if nov < NOV_FLOOR:                                        # too close to an accepted idea -> ban, keep searching
            print("  [dup] %.2f keep | %s" % (c["keep_pctile"], c["premise"][:50]), flush=True); continue
        # ACCEPT: new high-keep region
        acc_prem.append(c["premise"]); acc_emb.append(emb)
        iid = "a%05d" % (len(acc_prem) - 1)
        mk = "hooks/grpo/%s/montages/%s_0.jpg" % (RUN, iid)
        H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=c["mont"], ContentType="image/jpeg")
        row = {"id": "%s_0" % iid, "input_id": iid, "k": 0, "premise": c["premise"], "brief": c["premise"],
               "x": c["x"], "y": c["y"], "nbr": c["nbr"], "pctile": round(c["keep_pctile"], 4),
               "keep_pred": c["keep_pctile"], "nn_cos": round(c["nn_cos"], 4), "novelty": round(nov, 3),
               "advantage": round(nov, 3), "relevance": None, "reward": round(c["keep_pctile"], 4),
               "cohesion_mode": c["cohesion_mode"], "reasoning": c["reasoning"][:1800], "caption": c["premise"], "frames": c["frames"]}
        for f, obj in [(MANIF, row), (ACC, {"premise": c["premise"], "keep": c["keep_pctile"], "novelty": nov}),
                       (TRAIN, {"premise": c["premise"], "reasoning": c["reasoning"], "cohesion_mode": c["cohesion_mode"], "frames": c["frames"], "keep": c["keep_pctile"]})]:
            open(f, "a").write(json.dumps(obj) + "\n")
        # group json + index for the per-idea detail view
        H.s3.put_object(Bucket=H.BUCKET, Key="hooks/grpo/%s/groups/%s.json" % (RUN, iid),
            Body=json.dumps({"input_id": iid, "premise": c["premise"], "group_mean": c["keep_pctile"], "best_reward": c["keep_pctile"],
                "best_keep": c["keep_pctile"], "spread": 0.0, "n": 1, "model": os.path.basename(MODEL.rstrip("/")),
                "attempts": [{"k": 0, "reasoning": c["reasoning"][:2000], "cohesion_mode": c["cohesion_mode"], "frames": c["frames"],
                    "montage_key": mk, "keep_pctile": round(c["keep_pctile"], 4), "relevance": None, "nn_cos": round(c["nn_cos"], 4),
                    "reward": round(c["keep_pctile"], 4), "advantage": round(nov, 3), "caption": c["premise"], "x": c["x"], "y": c["y"], "nbr": c["nbr"]}]}).encode(),
            ContentType="application/json")
        print("  [ACCEPT #%d] keep=%.0f%% nov=%.2f | %s" % (len(acc_prem), c["keep_pctile"] * 100, nov, c["premise"][:60]), flush=True)
    # stream the map + accepted set to R2 every step
    for f, key in [(MANIF, "manifest.jsonl"), (ACC, "accepted.jsonl"), (TRAIN, "raft_data.jsonl")]:
        if os.path.exists(f): H.s3.upload_file(f, H.BUCKET, "hooks/grpo/%s/%s" % (RUN, key))
    # lightweight index for the run-picker / list
    with open(RUNDIR + "/index.jsonl", "w") as f:
        for i, p in enumerate(acc_prem):
            f.write(json.dumps({"input_id": "a%05d" % i, "premise": p, "best_keep": 0, "best_reward": 0, "group_mean": 0, "spread": 0, "n": 1}) + "\n")
    H.s3.upload_file(RUNDIR + "/index.jsonl", H.BUCKET, "hooks/grpo/%s/index.jsonl" % RUN)
    print("[%s] step %d | accepted=%d | imgs=%d $%.2f" % (RUN, step, len(acc_prem), H.RENDERS[0], H.RENDERS[0] * 0.003), flush=True)
print("=== IDEA_DISCOVER_DONE accepted=%d ===" % len(acc_prem), flush=True)
