"""CHAIN STAGE B — the validation the user specified: each candidate idea goes to the TRAINED THUMBNAIL
MODEL (thumb_b10), which writes K thumbnail prompts; those are RENDERED (flux), image-embedded, and scored
on the VISUAL ctrviews axis (the curated one). The idea's score = its best thumbnail's percentile, with a
relevance leash (idea-text ↔ image cosine) so an idea can't win with an off-topic pretty picture.
Every validated idea stores its real thumbnails → the 💡 Ideas tab shows clickable images.
Env: RUN, THUMB_MODEL, K(2), VIS_FLOOR(0.70), CHAIN_MAX(400), REL_FLOOR(0.35)."""
import os, json, time
import numpy as np
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("STATUS_KEY", "longform/idea-rl/status.json")
import harness_long as H

RUN = os.environ.get("RUN", "idea20")
THUMB_MODEL = os.environ.get("THUMB_MODEL", "/home/ubuntu/thumbrl/models/thumbmerged_b10").strip()
K = int(os.environ.get("K", "2"))
VIS_FLOOR = float(os.environ.get("VIS_FLOOR", "0.70"))
CHAIN_MAX = int(os.environ.get("CHAIN_MAX", "400"))
REL_FLOOR = float(os.environ.get("REL_FLOOR", "0.35"))
RUNDIR = "/home/ubuntu/thumbrl/runs/%s" % RUN
CAND = RUNDIR + "/candidates.jsonl"; INDEX = RUNDIR + "/index.jsonl"; ACCEPTED = RUNDIR + "/accepted.jsonl"

TSYS = ("Design the single most click-worthy YouTube thumbnail for a long-form video with the given title. "
        "Think about the strongest possible thumbnail concept for THIS specific title, then return ONLY JSON: "
        '{"prompt":"<one detailed photorealistic thumbnail description>"}. '
        "The prompt: concrete, photorealistic, horizontal 16:9, no on-screen text, describes one striking image.")

from transformers import AutoTokenizer
from vllm import LLM, SamplingParams
print("STAGE B: loading THUMBNAIL model %s" % THUMB_MODEL, flush=True)
tok = AutoTokenizer.from_pretrained(THUMB_MODEL)
llm = LLM(model=THUMB_MODEL, dtype="bfloat16", gpu_memory_utilization=0.92, max_model_len=2048, trust_remote_code=True)
SAMPLING = SamplingParams(temperature=1.0, top_p=0.95, max_tokens=350)

import re
def parse_prompt(txt):
    m = re.search(r"\{.*\}", txt, re.S)
    try:
        j = json.loads(m.group(0)) if m else None
        p = (j or {}).get("prompt")
        return p.strip() if isinstance(p, str) and len(p.strip()) > 8 else None
    except Exception: return None
def embt(t): return H._embed_call(json.dumps({"content": {"parts": [{"text": t[:400]}]}, "outputDimensionality": 1536}).encode(), 4)

cands = [json.loads(l) for l in open(CAND) if l.strip()]
chain = [c for c in cands if c.get("chain")][:CHAIN_MAX]
print("validating %d chain candidates (of %d generated) — K=%d renders each" % (len(chain), len(cands), K), flush=True)

n_done, n_acc = 0, 0
open(INDEX, "w").close(); open(ACCEPTED, "w").close()
BATCH = 16
for bi in range(0, len(chain), BATCH):
    group = chain[bi:bi + BATCH]
    ok, msg = H.gemini_ok()
    while not ok:
        H.write_status("halted-gemini", msg); time.sleep(300); ok, msg = H.gemini_ok()
    prompts = []
    for c in group:
        text = tok.apply_chat_template([{"role": "system", "content": TSYS}, {"role": "user", "content": c["idea"]}],
                                       tokenize=False, add_generation_prompt=True, enable_thinking=False)
        prompts += [text] * K
    outs = llm.generate(prompts, SAMPLING)
    def validate(args):
        gi, c = args
        tprompts = [parse_prompt(outs[gi * K + k].outputs[0].text) for k in range(K)]
        tprompts = [p for p in tprompts if p]
        if not tprompts: return None
        ivec = embt(c["idea"]); ivec = ivec / (np.linalg.norm(ivec) + 1e-9)
        best = None; thumbs = []
        for k, tp in enumerate(tprompts):
            jpg, emb, sc = H.render_score(tp)
            if sc is None: continue
            rel = float((emb / (np.linalg.norm(emb) + 1e-9)) @ ivec)
            eff = sc["pctile"] - max(0.0, REL_FLOOR - rel) * 2.0
            iid = "%s_%05d" % (RUN, bi + gi)
            mk = "longform/ideas/%s/montages/%s_%d.jpg" % (RUN, iid, k)
            H.s3.put_object(Bucket=H.BUCKET, Key=mk, Body=jpg, ContentType="image/jpeg")
            thumbs.append({"k": k, "prompt": tp, "pctile": round(sc["pctile"], 4), "rel": round(rel, 4), "montage_key": mk})
            if best is None or eff > best: best = eff
        if not thumbs: return None
        return (c, best, thumbs)
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = [r for r in ex.map(validate, list(enumerate(group))) if r]
    with open(INDEX, "a") as f, open(ACCEPTED, "a") as g:
        for c, best, thumbs in results:
            n_done += 1
            accepted = best >= VIS_FLOOR
            iid = thumbs[0]["montage_key"].rsplit("/", 1)[-1].rsplit("_", 1)[0]
            row = {"id": iid, "idea": c["idea"], "pctile": round(best, 4), "text_pct": c["text_pct"],
                   "novelty": c["novelty"], "copy_sim": c.get("copy_sim"), "accepted": bool(accepted),
                   "thumbs": [{"k": t["k"], "pctile": t["pctile"], "rel": t["rel"]} for t in thumbs],
                   "ts": int(time.time() * 1000)}
            f.write(json.dumps(row) + "\n")
            H.s3.put_object(Bucket=H.BUCKET, Key="longform/ideas/%s/groups/%s.json" % (RUN, iid),
                            Body=json.dumps({"idea": c["idea"], "vis_pctile": round(best, 4), "thumbs": thumbs}).encode(),
                            ContentType="application/json")
            if accepted:
                n_acc += 1
                g.write(json.dumps({"idea": c["idea"], "pctile": round(best, 4), "novelty": c["novelty"]}) + "\n")
    H.s3.upload_file(INDEX, H.BUCKET, "longform/ideas/%s/index.jsonl" % RUN)
    H.s3.upload_file(ACCEPTED, H.BUCKET, "longform/ideas/%s/accepted.jsonl" % RUN)
    H.write_status("running", "stage B %s: %d validated, %d accepted (vis floor %.2f) · %d renders $%.2f"
                   % (RUN, n_done, n_acc, VIS_FLOOR, H.RENDERS[0], H.RENDERS[0] * 0.003))
    print("[B:%s] validated=%d accepted=%d imgs=%d" % (RUN, n_done, n_acc, H.RENDERS[0]), flush=True)
try:
    with open(RUNDIR + "/_produced", "w") as fp: fp.write(str(n_acc))
except Exception: pass
H.write_status("done", "chain %s: %d validated, %d accepted" % (RUN, n_done, n_acc))
print("=== IDEA_VALIDATE_DONE validated=%d accepted=%d ===" % (n_done, n_acc), flush=True)
