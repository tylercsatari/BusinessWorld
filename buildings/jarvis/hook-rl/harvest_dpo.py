"""Best-of-N harvest for DPO on the KEEP-RATE axis. Qwen drafts N specs -> render+score each on
the density-guarded keep reward -> keep BEST (chosen) + WORST (rejected) as a preference pair.
Streams winner montages + manifest to R2 (run keepN, placed on the keep projection in the Guesses
tab) and writes pairs.jsonl for DPO. Env: RUN, MODEL, IDEABANK, IMG_BUDGET, N."""
import json, os, re, time, random
from concurrent.futures import ThreadPoolExecutor
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness as H

RUN = os.environ.get("RUN", "keep1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/hookrl/models/qwen3-30b-a3b").strip()
IDEABANK = os.environ.get("IDEABANK", "")
if not IDEABANK:
    big = "/home/ubuntu/hookrl/data/ideabank_big.jsonl"
    IDEABANK = big if os.path.exists(big) else "/home/ubuntu/hookrl/data/ideabank.jsonl"
IMG_BUDGET = int(os.environ.get("IMG_BUDGET", "10000"))
N = int(os.environ.get("N", "16")); RENDER_WORKERS = 8
RUNDIR = "/home/ubuntu/hookrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
MANI = RUNDIR + "/manifest.jsonl"; PAIRS = RUNDIR + "/pairs.jsonl"
STYLES = ["oneliner", "breakdown", "hookonly", "hedged"]
SYS = ("You are a YouTube Shorts hook director. Design the FIRST 5 SECONDS as 5 still frames (1/sec) "
       "forming the most scroll-stopping, high-retention opening so viewers DON'T swipe away. "
       "Choose a cohesion_mode: same_scene|progression|multi_shot|reveal|contrast. Return ONLY JSON: "
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

print("loading %s for run=%s" % (MODEL, RUN), flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None: tok.pad_token = tok.eos_token
tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda"); model.eval()
print("model ready", flush=True)

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
    frames, mont, sc = H.render_score_keep(fr)
    if sc is None: return None
    return {"cm": cm, "fr": fr, "mont": mont, "sc": sc, "reward": H.reward_of(sc)}

ideas = []
for l in open(IDEABANK):
    l = l.strip()
    if l:
        try: ideas.append(json.loads(l))
        except Exception: pass
random.Random(0).shuffle(ideas)
import re as _re
_STOP = set("a an the of to and or for with in on at into out from by as is are be do does this that their his her your you i we they it them then so very more most".split())
_BOIL = _re.compile(r"^\s*(the |a |an )?(creator|person|guy|girl|man|woman|youtuber|participants?|someone|narrator|host)\s+\w+\s+", _re.I)
def pkey(p):
    p = _BOIL.sub("", (p or "").lower()); ws = [w for w in _re.findall(r"[a-z]+", p) if w not in _STOP and len(w) > 2]
    return " ".join(sorted(set(ws))[:8])
consumed = set()
import glob as _g
for mf in _g.glob("/home/ubuntu/hookrl/runs/keep*/manifest.jsonl"):
    if "/%s/" % RUN in mf: continue
    for l in open(mf):
        try: consumed.add(pkey(json.loads(l).get("premise", "")))
        except Exception: pass
uniq, seen = [], set(consumed)
for i in ideas:
    k = pkey(i.get("premise", ""))
    if k and k not in seen: seen.add(k); uniq.append(i)
ideas = uniq
done = set()
if os.path.exists(MANI):
    for l in open(MANI):
        try: done.add(json.loads(l)["brief_id"])
        except Exception: pass
print("ideas=%d (dropped %d used) resume=%d budget=%d" % (len(ideas), len(consumed), len(done), IMG_BUDGET), flush=True)

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
        if len(cands) < 2: continue
        cands.sort(key=lambda z: -z["reward"])
        win, los = cands[0], cands[-1]
        hid = bid + "_0"; sc = win["sc"]
        H.s3.put_object(Bucket=H.BUCKET, Key="hooks/runs/%s/montages/%s.jpg" % (RUN, hid), Body=win["mont"], ContentType="image/jpeg")
        with open(MANI, "a") as f:
            f.write(json.dumps({"id": hid, "brief_id": bid, "brief": brief, "premise": idea["premise"],
                "niche": idea.get("niche", ""), "source": idea.get("source", ""), "phase": RUN, "iter": bi, "rank": 0,
                "cohesion_mode": win["cm"], "keep_pred": sc["keep_pred"], "pctile": sc["keep_pctile"],
                "nn_cos": sc["nn_cos"], "x": sc["x"], "y": sc["y"], "nbr": sc["nbr"], "frames": win["fr"]}) + "\n")
        with open(PAIRS, "a") as f:
            f.write(json.dumps({"brief": brief,
                "chosen": json.dumps({"cohesion_mode": win["cm"], "frames": win["fr"]}, ensure_ascii=False),
                "rejected": json.dumps({"cohesion_mode": los["cm"], "frames": los["fr"]}, ensure_ascii=False),
                "chosen_reward": round(win["reward"], 4), "rejected_reward": round(los["reward"], 4)}) + "\n")
        if bi % 3 == 0: H.s3.upload_file(MANI, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
        print("[%s] b%4d keep_best=%.0f%% gap=%.2f imgs=%d $%.2f" % (RUN, bi, win["sc"]["keep_pctile"]*100,
            win["reward"] - los["reward"], H.RENDERS[0], H.RENDERS[0]*0.003), flush=True)
except H.BillingHalt as e:
    halted = True; print("\n!!! BILLING HALT: %s" % e, flush=True)

if os.path.exists(MANI): H.s3.upload_file(MANI, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
np = sum(1 for _ in open(PAIRS)) if os.path.exists(PAIRS) else 0
print("=== HARVEST_DPO %s %s — %d pairs, %d imgs ($%.2f), %.0fmin ===" % (
    RUN, "HALTED" if halted else "DONE", np, H.RENDERS[0], H.RENDERS[0]*0.003, (time.time()-t0)/60), flush=True)
