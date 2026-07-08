"""CHAIN STAGE A — idea generation. The IDEA model invents candidates (diversity anchors + novelty +
copy gates). The TEXT axis is now only a cheap PREFILTER (like the thumbnail proxy): candidates that pass
go to Stage B, where the TRAINED THUMBNAIL MODEL renders them and the VISUAL ctrviews score (the user's
curated axis) is the real validation — the architecture the user specified. Writes runs/<RUN>/candidates.jsonl.
Env: RUN, MODEL(idea model), GBATCH, IDEA_BUDGET, TEXT_GATE(0.55), NOV_FLOOR(0.22), COPY_MAX(0.92)."""
import os, json, re, time, random
import numpy as np
from concurrent.futures import ThreadPoolExecutor
os.environ.setdefault("STATUS_KEY", "longform/idea-rl/status.json")
import harness_long as H

RUN = os.environ.get("RUN", "idea20")
MODEL = os.environ.get("MODEL", "/home/ubuntu/thumbrl/models/qwen3-30b-a3b").strip()
GBATCH = int(os.environ.get("GBATCH", "64"))
IDEA_BUDGET = int(os.environ.get("IDEA_BUDGET", "1500"))
TEXT_GATE = float(os.environ.get("TEXT_GATE", "0.55"))
NOV_FLOOR = float(os.environ.get("NOV_FLOOR", "0.22"))
COPY_MAX = float(os.environ.get("COPY_MAX", "0.92"))
RUNDIR = "/home/ubuntu/thumbrl/runs/%s" % RUN; os.makedirs(RUNDIR, exist_ok=True)
CAND = RUNDIR + "/candidates.jsonl"

SYS = ("Invent ONE new viral long-form YouTube video idea (the kind of engineering/build/challenge/story "
       "video that earns millions of views). Be SPECIFIC and concrete — a real, filmable video. "
       'Return ONLY JSON: {"idea":"<the video title/concept, one line>"}')

from transformers import AutoTokenizer
from vllm import LLM, SamplingParams
print("STAGE A: loading idea model %s" % MODEL, flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
llm = LLM(model=MODEL, dtype="bfloat16", gpu_memory_utilization=0.92, max_model_len=2048, trust_remote_code=True)
SAMPLING = SamplingParams(temperature=1.15, top_p=0.97, max_tokens=200)

for k, dst in [("longform/idea-rl/scorer_text.npz", "data/scorer_text.npz"),
               ("longform/idea-rl/top_titles.json", "data/top_titles.json")]:
    H.s3.download_file(H.BUCKET, k, "/home/ubuntu/thumbrl/" + dst)
_sc = np.load("/home/ubuntu/thumbrl/data/scorer_text.npz", allow_pickle=True)
BLEND = np.asarray(_sc["blend"], np.float32); LADDER = np.asarray(_sc["ladder"], np.float32)
TOP = json.load(open("/home/ubuntu/thumbrl/data/top_titles.json"))
INSP = [json.loads(l)["title"] for l in open("/home/ubuntu/thumbrl/data/titles.jsonl") if l.strip()]
_tc = np.load("/home/ubuntu/thumbrl/data/text_corpus_embeddings.npz", allow_pickle=True)
CORPUS_V = np.asarray(_tc["vecs"], np.float32); CORPUS_V /= (np.linalg.norm(CORPUS_V, axis=1, keepdims=True) + 1e-9)
NONLATIN = re.compile(u'[぀-ヿ一-鿿가-힯Ѐ-ӿ؀-ۿ֐-׿ऀ-ॿ฀-๿]')

def embt(t): return H._embed_call(json.dumps({"content": {"parts": [{"text": t[:400]}]}, "outputDimensionality": 1536}).encode(), 4)
def make_prompt():
    ex = random.sample(TOP, 2); seed = random.choice(INSP)
    user = ("Style examples that PERFORM (match their energy, do NOT copy them):\n- %s\n- %s\n"
            "Topic inspiration (a different area, riff on it or ignore it): %s\n"
            "Now invent ONE completely NEW idea." % (ex[0], ex[1], seed))
    return tok.apply_chat_template([{"role": "system", "content": SYS}, {"role": "user", "content": user}],
                                   tokenize=False, add_generation_prompt=True, enable_thinking=False)
def parse(txt):
    m = re.search(r"\{.*\}", txt, re.S)
    try:
        j = json.loads(m.group(0)) if m else None
        s = (j or {}).get("idea")
        if not (isinstance(s, str) and 10 < len(s.strip()) < 180): return None
        s = s.strip()
        return None if NONLATIN.search(s) or not s.isascii() else s   # English-only ideas
    except Exception: return None

seen_vecs, n_gen, kept = [], 0, 0
open(CAND, "w").close()
while n_gen < IDEA_BUDGET:
    ok, msg = H.gemini_ok()
    while not ok:
        H.write_status("halted-gemini", msg); time.sleep(300); ok, msg = H.gemini_ok()
    outs = llm.generate([make_prompt() for _ in range(GBATCH)], SAMPLING)
    ideas = [t for t in (parse(o.outputs[0].text) for o in outs) if t]
    with ThreadPoolExecutor(max_workers=10) as ex:
        vecs = list(ex.map(embt, ideas))
    with open(CAND, "a") as f:
        for idea, v in zip(ideas, vecs):
            v = v / (np.linalg.norm(v) + 1e-9); n_gen += 1
            tpct = float(np.searchsorted(LADDER, float(v @ BLEND)) / len(LADDER))
            copy_sim = float(np.max(CORPUS_V @ v))
            nov = 1.0 if not seen_vecs else float(1 - max(float(v @ a) for a in seen_vecs))
            passed = tpct >= TEXT_GATE and nov >= NOV_FLOOR and copy_sim <= COPY_MAX
            if passed: seen_vecs.append(v); kept += 1
            f.write(json.dumps({"idea": idea, "text_pct": round(tpct, 4), "novelty": round(nov, 4),
                                "copy_sim": round(copy_sim, 4), "chain": bool(passed)}) + "\n")
    H.write_status("running", "stage A %s: %d generated, %d → chain" % (RUN, n_gen, kept))
    print("[A:%s] gen=%d chain=%d" % (RUN, n_gen, kept), flush=True)
print("=== IDEA_GEN_DONE gen=%d chain=%d ===" % (n_gen, kept), flush=True)
