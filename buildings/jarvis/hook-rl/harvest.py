"""Generalized best-of-N harvest. Env: RUN, LORA (adapter dir or ''), IDEABANK, IMG_BUDGET.
Writes runs/{RUN}/manifest.jsonl + montages to R2 live; billing-halt + resume + budget cap."""
import json, os, re, time, random
from concurrent.futures import ThreadPoolExecutor
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness as H

RUN = os.environ.get("RUN", "phase1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/hookrl/models/qwen3-30b-a3b").strip()  # a merged fine-tuned model, or the base
IDEABANK = os.environ.get("IDEABANK", "")
if not IDEABANK:
    big = "/home/ubuntu/hookrl/data/ideabank_big.jsonl"
    IDEABANK = big if os.path.exists(big) else "/home/ubuntu/hookrl/data/ideabank.jsonl"
IMG_BUDGET = int(os.environ.get("IMG_BUDGET", "30000"))
N = int(os.environ.get("N", "16")); KEEP = 4; RENDER_WORKERS = 8
MODELP = "/home/ubuntu/hookrl/models/qwen3-30b-a3b"
RUNDIR = "/home/ubuntu/hookrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
MANI = RUNDIR + "/manifest.jsonl"
STYLES = ["oneliner", "breakdown", "hookonly", "hedged"]
SYS = ("You are a YouTube Shorts hook director. Design the FIRST 5 SECONDS as 5 still frames (1/sec) "
       "forming the most scroll-stopping, high-retention opening. Choose a cohesion_mode: "
       "same_scene|progression|multi_shot|reveal|contrast. Return ONLY JSON: "
       '{"cohesion_mode":"...","frames":["detailed photographic prompt", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, dramatic lighting, no on-screen text. /no_think")

def brief_text(idea, style):
    p = idea["premise"]; niche = idea.get("niche", "")
    if style == "oneliner": return p
    if style == "hookonly": return "Write the opening hook for this video: %s" % p
    if style == "hedged": return "Maybe something like: %s — not sure on the angle, you decide." % p
    return "Video idea: %s. Niche: %s. Plan the strongest possible 5-second opening." % (p, niche)

def parse_json(txt):
    txt = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    m = re.search(r"\{.*\}", txt, re.S)
    try: return json.loads(m.group(0)) if m else None
    except Exception: return None

print("loading model %s for run=%s budget=%d" % (MODEL, RUN, IMG_BUDGET), flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None: tok.pad_token = tok.eos_token
tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda")
model.eval()
print("model ready.", flush=True)

def gen_specs(brief, n=N, temp=1.05):
    text = tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": brief}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=False)
    ins = tok([text] * n, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=1100, do_sample=True, temperature=temp, top_p=0.95, pad_token_id=tok.pad_token_id)
    specs = []
    for i in range(n):
        g = tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True)
        j = parse_json(g); fr = j.get("frames") if j else None
        specs.append((j.get("cohesion_mode", "?") if j else "?", fr) if (isinstance(fr, list) and len(fr) == 5) else (None, None))
    return specs

def render_one(cm_fr):
    cm, fr = cm_fr
    if not fr: return None
    frames, mont, sc = H.render_score_hook(fr)
    if sc is None: return None
    return {"cm": cm, "fr": fr, "mont": mont, "sc": sc}

ideas = []  # robust to the live idea-generator appending concurrently (skip half-written/bad lines)
for l in open(IDEABANK):
    l = l.strip()
    if not l: continue
    try: ideas.append(json.loads(l))
    except Exception: pass
random.Random(0).shuffle(ideas)
# UNIQUE PROMPTS: content-signature dedup so reworded near-duplicates collapse, and no
# premise repeats within the bank OR across phases (prevents overfitting on a repeated idea).
import re as _re, glob as _glob
_STOP = set("a an the of to and or for with in on at into out up from by as is are be do does this that their his her your you i we they it his her them then so very more most into onto over under after before how why what when".split())
_BOILER = _re.compile(r"^\s*(the |a |an )?(creator|person|guy|girl|man|woman|youtuber|participants?|someone|narrator|host)\s+(attempts? to|tries? to|documents?|tests?|creates?|builds?|makes?|transforms?|trains?|presents?|sets? out to|decides? to|shows?|reviews?)\s+", _re.I)
def pkey(p):
    p = _BOILER.sub("", (p or "").lower())
    ws = [w for w in _re.findall(r"[a-z]+", p) if w not in _STOP and len(w) > 2]
    return " ".join(sorted(set(ws))[:8])
consumed = set()
for mf in _glob.glob("/home/ubuntu/hookrl/runs/*/manifest.jsonl"):
    if "/%s/" % RUN in mf: continue
    for l in open(mf):
        try: consumed.add(pkey(json.loads(l).get("premise", "")))
        except Exception: pass
uniq, seen = [], set(consumed)
for i in ideas:
    k = pkey(i.get("premise", ""))
    if not k or k in seen: continue
    seen.add(k); uniq.append(i)
ideas = uniq
done = set()
if os.path.exists(MANI):
    for ln in open(MANI):
        try: done.add(json.loads(ln)["brief_id"])
        except Exception: pass
print("ideabank=%s n=%d (after dropping %d already-used premises) resume=%d" % (
    os.path.basename(IDEABANK), len(ideas), len(consumed), len(done)), flush=True)

halted = False; t0 = time.time()
try:
    for bi, idea in enumerate(ideas):
        bid = "b%04d" % bi
        if bid in done: continue
        if H.RENDERS[0] >= IMG_BUDGET: print("=== BUDGET REACHED ==="); break
        brief = brief_text(idea, STYLES[bi % len(STYLES)])
        valid = [s for s in gen_specs(brief) if s[1]]
        cands = []
        with ThreadPoolExecutor(max_workers=RENDER_WORKERS) as ex:
            for r in ex.map(render_one, valid):
                if r: cands.append(r)
        if not cands: continue
        cands.sort(key=lambda z: -z["sc"]["pctile"])
        for rank, c in enumerate(cands[:KEEP]):
            hid = "%s_%d" % (bid, rank); sc = c["sc"]
            H.s3.put_object(Bucket=H.BUCKET, Key="hooks/runs/%s/montages/%s.jpg" % (RUN, hid), Body=c["mont"], ContentType="image/jpeg")
            row = {"id": hid, "brief_id": bid, "brief": brief, "premise": idea["premise"], "niche": idea.get("niche", ""),
                   "source": idea.get("source", ""), "phase": RUN, "iter": bi, "rank": rank, "cohesion_mode": c["cm"],
                   "pred": round(sc["pred"], 3), "pctile": round(sc["pctile"], 3), "nn_cos": round(sc["nn_cos"], 3),
                   "x": sc["x"], "y": sc["y"], "frames": c["fr"]}
            with open(MANI, "a") as f: f.write(json.dumps(row) + "\n")
        if bi % 3 == 0: H.s3.upload_file(MANI, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
        print("[%s] brief %4d [%-8s] best=%.0f%% kept=%d valid=%d imgs=%d $%.2f" % (
            RUN, bi, idea.get("niche", "")[:8], cands[0]["sc"]["pctile"]*100, min(KEEP, len(cands)), len(valid),
            H.RENDERS[0], H.RENDERS[0]*0.003), flush=True)
except H.BillingHalt as e:
    halted = True; print("\n!!! BILLING HALT: %s — saved, re-run to resume." % e, flush=True)

if os.path.exists(MANI): H.s3.upload_file(MANI, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
rows = [json.loads(l) for l in open(MANI)] if os.path.exists(MANI) else []
pcs = sorted(r["pctile"] for r in rows) if rows else [0]
print("=== HARVEST %s %s — %d hooks, %d imgs ($%.2f), median %.0fth best %.0fth, %.0fmin ===" % (
    RUN, "HALTED" if halted else "DONE", len(rows), H.RENDERS[0], H.RENDERS[0]*0.003,
    pcs[len(pcs)//2]*100, pcs[-1]*100, (time.time()-t0)/60), flush=True)
