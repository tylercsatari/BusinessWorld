"""LONG-FORM IDEA discovery (the shorts idea-model recipe, modernized with this week's lessons).
The model INVENTS long-form video ideas (no input). Each idea is text-embedded and scored on the
TEXT ctrviews-style axis (scorer_text.npz: title-embedding -> log-views percentile, held-out r=0.68).
Anti-overfit exactly as specified: novelty = 1 - max cosine vs ALL previously ACCEPTED ideas — an idea
must be BOTH high-scoring (pctile >= SCORE_FLOOR) AND semantically new (novelty >= NOV_FLOOR) to enter
training. EVERY generated idea is logged to longform/ideas/<run>/index.jsonl for the 💡 Ideas tab.
No renders — text-only (vLLM gen + Gemini embeds): fast and cheap. No-think mode (BOND lesson: all
gradient on reward-relevant tokens). Env: RUN, MODEL, GBATCH(64), IDEA_BUDGET(2000), SCORE_FLOOR(0.70),
NOV_FLOOR(0.22), STATUS_KEY=longform/idea-rl/status.json."""
import os, json, re, time
import numpy as np
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("STATUS_KEY", "longform/idea-rl/status.json")
import harness_long as H

RUN = os.environ.get("RUN", "idea1")
MODEL = os.environ.get("MODEL", "/home/ubuntu/thumbrl/models/qwen3-30b-a3b").strip()
GBATCH = int(os.environ.get("GBATCH", "64"))
IDEA_BUDGET = int(os.environ.get("IDEA_BUDGET", "2000"))
SCORE_FLOOR = float(os.environ.get("SCORE_FLOOR", "0.70"))
NOV_FLOOR = float(os.environ.get("NOV_FLOOR", "0.22"))
RUNDIR = "/home/ubuntu/thumbrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
INDEX = RUNDIR + "/index.jsonl"; ACCEPTED = RUNDIR + "/accepted.jsonl"

SYS = ("Invent ONE new viral long-form YouTube video idea (the kind of engineering/build/challenge/story "
       "video that earns millions of views). Be SPECIFIC and concrete — a real, filmable video. "
       'Return ONLY JSON: {"idea":"<the video title/concept, one line>"}')

from transformers import AutoTokenizer
from vllm import LLM, SamplingParams
print("loading %s (vLLM) for %s" % (MODEL, RUN), flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
llm = LLM(model=MODEL, dtype="bfloat16", gpu_memory_utilization=0.92, max_model_len=2048, trust_remote_code=True)
SAMPLING = SamplingParams(temperature=1.15, top_p=0.97, max_tokens=200)
print("model ready", flush=True)

# frozen text scorer
H.s3.download_file(H.BUCKET, "longform/idea-rl/scorer_text.npz", "/home/ubuntu/thumbrl/data/scorer_text.npz")
_sc = np.load("/home/ubuntu/thumbrl/data/scorer_text.npz", allow_pickle=True)
BLEND = np.asarray(_sc["blend"], np.float32); LADDER = np.asarray(_sc["ladder"], np.float32)
def score_pct(v): return float(np.searchsorted(LADDER, float(v @ BLEND)) / len(LADDER))

def embt(t):
    return H._embed_call(json.dumps({"content": {"parts": [{"text": t[:400]}]}, "outputDimensionality": 1536}).encode(), 4)

# resume: accepted bank (embeddings for the novelty gate) + counts, seeded from R2
for local, key in [(INDEX, "longform/ideas/%s/index.jsonl" % RUN), (ACCEPTED, "longform/ideas/%s/accepted.jsonl" % RUN)]:
    if not os.path.exists(local):
        try: open(local, "wb").write(H.s3.get_object(Bucket=H.BUCKET, Key=key)["Body"].read())
        except Exception: pass
acc_vecs, n_gen, n_acc = [], 0, 0
if os.path.exists(ACCEPTED):
    prev = [json.loads(l) for l in open(ACCEPTED) if l.strip()]
    n_acc = len(prev)
    if prev:
        print("re-embedding %d accepted for the novelty gate..." % len(prev), flush=True)
        with ThreadPoolExecutor(max_workers=10) as ex:
            acc_vecs = [v / (np.linalg.norm(v) + 1e-9) for v in ex.map(lambda r: embt(r["idea"]), prev)]
if os.path.exists(INDEX): n_gen = sum(1 for _ in open(INDEX))
print("resume: %d generated, %d accepted" % (n_gen, n_acc), flush=True)

prompt = tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": "Invent a new idea now."}],
                                 tokenize=False, add_generation_prompt=True, enable_thinking=False)
def parse(txt):
    m = re.search(r"\{.*\}", txt, re.S)
    try:
        j = json.loads(m.group(0)) if m else None
        s = (j or {}).get("idea")
        return s.strip() if isinstance(s, str) and 10 < len(s.strip()) < 180 else None
    except Exception: return None

PRODUCED = [0]
while n_gen < IDEA_BUDGET:
    ok, msg = H.gemini_ok()
    while not ok:
        H.write_status("halted-gemini", msg); print("GEMINI HALT: %s" % msg[:90], flush=True)
        time.sleep(300); ok, msg = H.gemini_ok()
    outs = llm.generate([prompt] * GBATCH, SAMPLING)
    ideas = [parse(o.outputs[0].text) for o in outs]
    ideas = [(i, t) for i, t in enumerate(ideas) if t]
    with ThreadPoolExecutor(max_workers=10) as ex:
        vecs = list(ex.map(lambda p: embt(p[1]), ideas))
    rows = []
    for (k, (gi, idea)) in enumerate(ideas):
        v = vecs[k] / (np.linalg.norm(vecs[k]) + 1e-9)
        pct = score_pct(v)
        nov = 1.0 if not acc_vecs else float(1 - max(float(v @ a) for a in acc_vecs))
        accepted = pct >= SCORE_FLOOR and nov >= NOV_FLOOR
        n_gen += 1
        row = {"id": "%s_%06d" % (RUN, n_gen), "idea": idea, "pctile": round(pct, 4),
               "novelty": round(nov, 4), "accepted": bool(accepted), "ts": int(time.time() * 1000)}
        rows.append(row)
        if accepted:
            acc_vecs.append(v); n_acc += 1; PRODUCED[0] += 1
            with open(ACCEPTED, "a") as f:
                f.write(json.dumps({"idea": idea, "pctile": round(pct, 4), "novelty": round(nov, 4)}) + "\n")
    with open(INDEX, "a") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    H.s3.upload_file(INDEX, H.BUCKET, "longform/ideas/%s/index.jsonl" % RUN)
    H.s3.upload_file(ACCEPTED, H.BUCKET, "longform/ideas/%s/accepted.jsonl" % RUN)
    H.write_status("running", "run %s · %d generated · %d accepted (floors %.2f/%.2f)" % (RUN, n_gen, n_acc, SCORE_FLOOR, NOV_FLOOR))
    best = max((r["pctile"] for r in rows), default=0)
    print("[%s] gen=%d acc=%d batch_best=%.0f%%" % (RUN, n_gen, n_acc, best * 100), flush=True)
try:
    with open(RUNDIR + "/_produced", "w") as fp: fp.write(str(PRODUCED[0]))
except Exception: pass
H.write_status("done", "run %s: %d generated, %d accepted" % (RUN, n_gen, n_acc))
print("=== IDEA_HARVEST_DONE gen=%d acc=%d ===" % (n_gen, n_acc), flush=True)
