"""Post-training demo server: loads the latest trained model and only answers Experiments-tab
'Generate hooks from an idea' requests (typed idea -> hooks, or blank -> invent idea+hook), so the
button keeps working after the discovery loop ends. Env: MODEL (defaults to models/LATEST)."""
import os, re, json, time
from concurrent.futures import ThreadPoolExecutor
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import harness as H

MODEL = os.environ.get("MODEL", "").strip() or (open("/home/ubuntu/hookrl/models/LATEST").read().strip()
        if os.path.exists("/home/ubuntu/hookrl/models/LATEST") else "/home/ubuntu/hookrl/models/qwen3-30b-a3b")
HOOK_SYS = ("Design the opening 5 seconds of this short video as 5 still frames (one per second). "
            "Think about the strongest opening for THIS specific video, then return ONLY JSON: "
            '{"cohesion_mode":"same_scene|progression|multi_shot|reveal|contrast","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")
IDEA_SYS = ("Invent a brand-new viral YouTube Short — first the IDEA, then its opening. Return ONLY JSON: "
            '{"premise":"the one-line video idea","cohesion_mode":"reveal","frames":["photographic prompt", x5]}. '
            "Each frame: concrete, photorealistic, vertical 9:16, no on-screen text.")

print("serve_only loading %s" % MODEL, flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
if tok.pad_token is None: tok.pad_token = tok.eos_token
tok.padding_side = "left"
model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cuda")
model.config.output_router_logits = False; model.eval()
print("serve_only ready", flush=True)

def split(txt):
    m = re.search(r"<think>(.*?)</think>", txt, re.S); reasoning = m.group(1).strip() if m else ""
    rest = re.sub(r"<think>.*?</think>", "", txt, flags=re.S).strip()
    j = re.search(r"\{.*\}", rest, re.S)
    try: spec = json.loads(j.group(0)) if j else None
    except Exception: spec = None
    return reasoning, spec

def generate(sys, user, n, want_premise):
    text = tok.apply_chat_template([{"role": "system", "content": sys}, {"role": "user", "content": user}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=True)
    ins = tok([text] * n, return_tensors="pt", padding=True).to("cuda")
    with torch.no_grad():
        out = model.generate(**ins, max_new_tokens=2200, do_sample=True, temperature=1.0, top_p=0.95, pad_token_id=tok.pad_token_id)
    sp = []
    for i in range(n):
        reasoning, spec = split(tok.decode(out[i][ins.input_ids.shape[1]:], skip_special_tokens=True))
        fr = spec.get("frames") if spec else None
        if isinstance(fr, list) and len(fr) == 5:
            d = {"cohesion_mode": spec.get("cohesion_mode", "?"), "frames": fr, "reasoning": reasoning}
            if want_premise: d["premise"] = (spec.get("premise") or "").strip()
            sp.append(d)
    return sp

def score(s):
    frames, mont, sc = H.render_score_keep(s["frames"])
    if sc is None: return None
    s.update({"mont": mont, "keep_pctile": sc["keep_pctile"], "nn_cos": sc["nn_cos"], "x": sc["x"], "y": sc["y"], "nbr": sc["nbr"]})
    return s

def _stat(rid, **kw): H.s3.put_object(Bucket=H.BUCKET, Key="hooks/grpo/demo/status/%s.json" % rid, Body=json.dumps(kw).encode(), ContentType="application/json")
_served = set()
def serve_once():
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
            specs = generate(IDEA_SYS, "Invent one now.", n, True) if invent else generate(HOOK_SYS, prem, n, False)
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
                "input_id": rid, "premise": prem or "💡 invented", "n": len(att), "best_keep": att[0]["keep_pctile"] if att else 0,
                "group_mean": 0, "best_reward": 0, "spread": 0, "model": os.path.basename(MODEL.rstrip("/")), "attempts": att}).encode(),
                ContentType="application/json")
            _stat(rid, stage="done")
    except Exception as e: print("[demo] err", str(e)[:90], flush=True)

print("=== SERVE_ONLY_RUNNING ===", flush=True)
while True:
    serve_once(); time.sleep(4)
