"""Backfill `nbr` (12 nearest library hooks) into phase2..phase8 manifests by re-embedding each
montage. Only needs the montage embedding vs the library vecs — NO views axis. Lets the Guesses tab
place every old guess in any projection (exactly like phase1/keep1). Safe to run beside the harvest:
only uses the Gemini embed API + CPU, not Replicate or the GPU."""
import json, os, numpy as np
import harness as H

H._load_map()                 # loads _NIDS (library ids aligned to the npz)
RV = H.real_vecs()            # normalized library embeddings
NIDS = H._NIDS[0]
RUNS = ["phase2", "phase3", "phase4", "phase5", "phase6", "phase7", "phase8"]

def nbr_of(mont):
    emb = H.embed_image(mont)
    if emb is None: return None
    en = emb / (np.linalg.norm(emb) + 1e-8)
    sims = RV @ en
    top = np.argsort(sims)[-12:][::-1]
    return [[NIDS[i], round(float(sims[i]), 4)] for i in top]

for RUN in RUNS:
    path = "/home/ubuntu/hookrl/runs/%s/manifest.jsonl" % RUN
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        buf = H.s3.get_object(Bucket=H.BUCKET, Key="hooks/runs/%s/manifest.jsonl" % RUN)["Body"].read()
        open(path, "wb").write(buf)
    except Exception as e:
        print(RUN, "no manifest:", str(e)[:60], flush=True); continue
    rows = [json.loads(l) for l in open(path) if l.strip()]
    done = 0
    for k, r in enumerate(rows):
        if r.get("nbr"): continue
        try:
            mont = H.s3.get_object(Bucket=H.BUCKET, Key="hooks/runs/%s/montages/%s.jpg" % (RUN, r["id"]))["Body"].read()
            nb = nbr_of(mont)
            if nb: r["nbr"] = nb; done += 1
        except Exception as e:
            print(RUN, r.get("id"), "err", str(e)[:50], flush=True)
        if k % 50 == 0: print(RUN, k, "/", len(rows), "(+%d nbr)" % done, flush=True)
    with open(path, "w") as f:
        f.write("\n".join(json.dumps(x) for x in rows))
    H.s3.upload_file(path, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
    print("=== %s backfilled: %d/%d now have nbr ===" % (RUN, sum(1 for x in rows if x.get('nbr')), len(rows)), flush=True)
print("=== NBR28_DONE ===", flush=True)
