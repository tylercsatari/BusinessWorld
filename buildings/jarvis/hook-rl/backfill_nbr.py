"""Add `nbr` (12 nearest library hooks) to phase0 + phase1 manifests by re-embedding the montages,
so the tab can place each guess in ANY projection (exactly like Raw places uploads).
Waits for the phase1 harvest to finish first so we don't race its appends."""
import json, os, time, subprocess
import harness as H

# wait for phase1 harvest to stop appending
while subprocess.run(["pgrep", "-f", "phase1_local.py"], capture_output=True).returncode == 0:
    print("waiting for phase1 harvest to finish before backfilling nbr...", flush=True)
    time.sleep(30)

for RUN in ["phase0", "phase1"]:
    path = "/home/ubuntu/hookrl/runs/%s/manifest.jsonl" % RUN
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        try:
            buf = H.s3.get_object(Bucket=H.BUCKET, Key="hooks/runs/%s/manifest.jsonl" % RUN)["Body"].read()
            open(path, "wb").write(buf)
        except Exception as e:
            print(RUN, "no manifest:", str(e)[:50]); continue
    rows = [json.loads(l) for l in open(path)]
    out = []
    for k, r in enumerate(rows):
        if r.get("nbr"):
            out.append(r); continue
        try:
            mont = H.s3.get_object(Bucket=H.BUCKET, Key="hooks/runs/%s/montages/%s.jpg" % (RUN, r["id"]))["Body"].read()
            sc = H.score(H.embed_image(mont))
            r["nbr"] = sc["nbr"]; r["x"] = sc["x"]; r["y"] = sc["y"]
        except Exception as e:
            print(RUN, r.get("id"), "err", str(e)[:50])
        out.append(r)
        if k % 50 == 0: print(RUN, k, "/", len(rows), flush=True)
    with open(path, "w") as f:
        f.write("\n".join(json.dumps(x) for x in out))
    H.s3.upload_file(path, H.BUCKET, "hooks/runs/%s/manifest.jsonl" % RUN)
    print("backfilled nbr -> %s: %d rows" % (RUN, len(out)), flush=True)
print("=== NBR_BACKFILL_DONE ===", flush=True)
