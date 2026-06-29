"""GRPO-style harvest. For each INPUT idea, the policy REASONS then emits 5 frames, G times.
Each attempt scored on a relevance-gated keep reward; advantage = reward - per-input mean (the
baseline IS the input, so niche/cluster/difficulty all cancel — no labels anywhere). Stores EVERY
attempt per input (reasoning + montage + scores) to R2 for the UI, and writes advantage-weighted
training data for the update. Env: RUN, MODEL, G, IMG_BUDGET, IDEABANK."""
import json, os, re, random
from concurrent.futures import ThreadPoolExecutor
import numpy as np, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness as H
import relevance as REL

RUN = os.environ.get("RUN", "grpo1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/hookrl/models/qwen3-30b-a3b").strip()
G = int(os.environ.get("G", "8"))                 # attempts per input (the GRPO group)
IMG_BUDGET = int(os.environ.get("IMG_BUDGET", "8000"))
IDEABANK = os.environ.get("IDEABANK", "") or "/home/ubuntu/hookrl/data/ideabank_big.jsonl"
RUNDIR = "/home/ubuntu/hookrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
TRAIN = RUNDIR + "/grpo_data.jsonl"; INDEX = RUNDIR + "/index.jsonl"

# Minimal task framing ONLY — no creative priors (no "close-up", niche, tease, "scroll-stopping").
# The model must reason its own way to what holds attention; the reward teaches it.
SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
       "Think about the strongest possible opening for THIS specific video, then return ONLY JSON: "
       '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
       "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

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
print("model ready", flush=True)

def gen_group(brief, n=G, temp=1.05):
    """G reasoning+frame attempts for ONE input. Thinking ON so we capture the reasoning trace."""
    text = tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": brief}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=True)
    ins = tok([text] * n, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=2200, do_sample=True, temperature=temp, top_p=0.95, pad_token_id=tok.pad_token_id)
    res = []
    for i in range(n):
        full = tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True)
        reasoning, spec = split_think(full)
        fr = spec.get("frames") if spec else None
        cm = spec.get("cohesion_mode", "?") if spec else "?"
        res.append({"reasoning": reasoning, "cohesion_mode": cm,
                    "frames": fr if (isinstance(fr, list) and len(fr) == 5) else None,
                    "completion": full})
    return res

def score_attempt(att, input_vec):
    if not att["frames"]: return None
    frames, mont, sc = H.render_score_keep(att["frames"])
    if sc is None: return None
    rel, cap = REL.relevance(None, mont, input_vec=input_vec)
    reward = REL.gated_reward(sc["keep_pctile"], rel, sc["nn_cos"])
    return {**att, "mont": mont, "keep_pctile": sc["keep_pctile"], "nn_cos": sc["nn_cos"],
            "x": sc["x"], "y": sc["y"], "nbr": sc["nbr"], "relevance": rel, "caption": cap, "reward": reward}

# load + dedup ideas (reuse harvest_dpo's premise-key dedup so inputs are distinct)
ideas = []
for l in open(IDEABANK):
    l = l.strip()
    if l:
        try: ideas.append(json.loads(l))
        except Exception: pass
random.Random(0).shuffle(ideas)
_STOP = set("a an the of to and or for with in on at into out from by as is are be do does this that".split())
def pkey(p):
    ws = [w for w in re.findall(r"[a-z]+", (p or "").lower()) if w not in _STOP and len(w) > 2]
    return " ".join(sorted(set(ws))[:8])
uniq, seen = [], set()
for i in ideas:
    k = pkey(i.get("premise", ""))
    if k and k not in seen: seen.add(k); uniq.append(i)
ideas = uniq
done = set()
if os.path.exists(INDEX):
    for l in open(INDEX):
        try: done.add(json.loads(l)["input_id"])
        except Exception: pass
print("inputs=%d resume=%d budget=%d" % (len(ideas), len(done), IMG_BUDGET), flush=True)

for ii, idea in enumerate(ideas):
    iid = "i%04d" % ii
    if iid in done: continue
    if H.RENDERS[0] >= IMG_BUDGET: print("=== BUDGET REACHED ==="); break
    premise = idea.get("premise", "")
    brief = premise
    input_vec = REL.embed_text(premise)
    group = gen_group(brief)
    with ThreadPoolExecutor(max_workers=8) as ex:
        scored = [r for r in ex.map(lambda a: score_attempt(a, input_vec), group) if r]
    if len(scored) < 2: continue
    rewards = np.array([s["reward"] for s in scored], float)
    base = float(rewards.mean())
    scored.sort(key=lambda s: -s["reward"])
    attempts_out = []
    for k, s in enumerate(scored):
        mk = "hooks/grpo/%s/montages/%s_%d.jpg" % (RUN, iid, k)
        H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=s["mont"], ContentType="image/jpeg")
        adv = s["reward"] - base
        attempts_out.append({"k": k, "reasoning": s["reasoning"][:2000], "cohesion_mode": s["cohesion_mode"],
            "frames": s["frames"], "montage_key": mk, "keep_pctile": round(s["keep_pctile"], 4),
            "relevance": round(s["relevance"], 4) if s["relevance"] is not None else None,
            "nn_cos": round(s["nn_cos"], 4), "reward": round(s["reward"], 4), "advantage": round(adv, 4),
            "caption": s["caption"], "x": s["x"], "y": s["y"], "nbr": s["nbr"]})
        # advantage-weighted training signal: positive-advantage attempts are imitation targets
        if adv > 0.02:
            with open(TRAIN, "a") as f:
                f.write(json.dumps({"input_id": iid, "brief": brief, "reasoning": s["reasoning"],
                    "cohesion_mode": s["cohesion_mode"], "frames": s["frames"], "advantage": round(adv, 4)}) + "\n")
    grp = {"input_id": iid, "premise": premise, "niche_hint": idea.get("niche", ""), "group_mean": round(base, 4),
           "best_reward": round(scored[0]["reward"], 4), "best_keep": round(scored[0]["keep_pctile"], 4),
           "spread": round(float(rewards.max() - rewards.min()), 4), "n": len(scored), "attempts": attempts_out}
    H.s3.put_object(Bucket=H.BUCKET, Key="hooks/grpo/%s/groups/%s.json" % (RUN, iid),
                    Body=json.dumps(grp).encode(), ContentType="application/json")
    with open(INDEX, "a") as f:
        f.write(json.dumps({"input_id": iid, "premise": premise, "best_keep": grp["best_keep"],
            "best_reward": grp["best_reward"], "group_mean": grp["group_mean"], "spread": grp["spread"], "n": grp["n"]}) + "\n")
    H.s3.upload_file(INDEX, H.BUCKET, "hooks/grpo/%s/index.jsonl" % RUN)
    print("[%s] %s n=%d best_keep=%.0f%% best_rew=%.2f mean=%.2f spread=%.2f imgs=%d $%.2f" % (
        RUN, iid, len(scored), grp["best_keep"]*100, grp["best_reward"], base, grp["spread"], H.RENDERS[0], H.RENDERS[0]*0.003), flush=True)
print("=== GRPO_HARVEST_DONE ===", flush=True)
