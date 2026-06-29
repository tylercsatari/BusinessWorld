import json, os, time, urllib.request, numpy as np
import harness as H

MODEL = "gemini-2.5-flash"
GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % MODEL
RUNDIR = "/home/ubuntu/hookrl/runs/phase0"
os.makedirs(RUNDIR, exist_ok=True)
MANI = RUNDIR + "/manifest.jsonl"

def author_spec(brief, mode):
    prompt = (
        "You are a YouTube Shorts hook director. Given an idea, output the FIRST 5 SECONDS as 5 still frames "
        "(1 per second) that form the most scroll-stopping, high-retention opening possible.\n"
        f"IDEA: {brief}\nCOHESION_MODE: {mode}.\n"
        "Return ONLY JSON: {\"frames\":[\"detailed photographic prompt for frame 1\", ... 5 total]}. "
        "Each prompt: concrete, photorealistic, vertical 9:16, dramatic lighting. No on-screen text."
    )
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"responseMimeType": "application/json", "temperature": 1.0}}).encode()
    for a in range(3):
        try:
            req = urllib.request.Request(GEN_URL, data=body, method="POST",
                headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
            r = json.loads(urllib.request.urlopen(req, timeout=60).read())
            fr = json.loads(r["candidates"][0]["content"]["parts"][0]["text"])["frames"]
            if isinstance(fr, list) and len(fr) == 5: return fr
        except Exception:
            if a < 2: time.sleep(2); continue
    return None

BRIEFS = [
 ("Restoring a rusted antique axe head to mirror shine", "progression"),
 ("Pouring molten aluminum into an ant hill to make a cast", "reveal"),
 ("A chef plating an absurdly tall burger that towers over the camera", "progression"),
 ("Pressure-washing a filthy moldy driveway revealing clean concrete", "contrast"),
 ("Cutting open a giant geode to reveal crystals inside", "reveal"),
 ("A guy free-soloing a terrifying cliff edge over the ocean", "multi_shot"),
 ("Hydraulic press crushing a bowling ball", "reveal"),
 ("Time-lapse of a wilted plant springing back to life after watering", "progression"),
 ("Unboxing the most expensive gaming PC build, parts everywhere", "multi_shot"),
 ("A dog reacting in shock to a magic trick disappearing treat", "multi_shot"),
 ("Slicing into a perfectly cooked medium-rare steak, juices flowing", "reveal"),
 ("Restoring a trashed vintage sports car to showroom condition", "contrast"),
 ("A street artist spray-painting a hyperrealistic portrait fast", "progression"),
 ("Deep-cleaning the dirtiest carpet you've ever seen", "contrast"),
 ("Building a tiny house entirely out of cardboard", "progression"),
 ("A blacksmith forging a glowing knife from a railroad spike", "progression"),
 ("Dropping red-hot nickel ball onto random objects", "multi_shot"),
 ("Carving an intricate dragon into a watermelon", "progression"),
 ("A diver swimming face to face with a massive whale shark", "multi_shot"),
 ("Stacking 1000 dominoes then knocking them down", "reveal"),
 ("Making the gooiest chocolate lava cake, cut open oozing", "reveal"),
 ("A parkour athlete leaping between rooftops at sunset", "multi_shot"),
 ("Cleaning a century of grime off an old painting", "contrast"),
 ("Pulling a massive pizza out of a wood-fired oven, cheese bubbling", "progression"),
]

# --- resume: skip hooks already in the local manifest ---
done = set()
if os.path.exists(MANI):
    for ln in open(MANI):
        try: done.add(json.loads(ln)["id"])
        except Exception: pass
print("resuming: %d hooks already done" % len(done))

t0 = time.time(); halted = False
try:
    for i, (brief, mode) in enumerate(BRIEFS):
        hid = "p0_%02d" % i
        if hid in done:
            continue
        fr = author_spec(brief, mode)
        if not fr:
            print("%2d SKIP (no spec)  %s" % (i, brief[:38])); continue
        frames, mont, sc = H.render_score_hook(fr)   # may raise BillingHalt
        if sc is None:
            print("%2d SKIP (render)   %s" % (i, brief[:38])); continue
        H.s3.put_object(Bucket=H.BUCKET, Key="hooks/runs/phase0/montages/%s.jpg" % hid, Body=mont, ContentType="image/jpeg")
        row = {"id": hid, "brief": brief, "cohesion_mode": mode, "phase": 0, "iter": 0,
               "pred": round(sc["pred"], 3), "pctile": round(sc["pctile"], 3),
               "nn_cos": round(sc["nn_cos"], 3), "frames": fr}
        with open(MANI, "a") as f: f.write(json.dumps(row) + "\n")   # checkpoint
        print("%2d pctile=%5.1f%% pred=%.2f nn=%.3f  %s" % (i, sc["pctile"]*100, sc["pred"], sc["nn_cos"], brief[:36]))
except H.BillingHalt as e:
    halted = True
    print("\n!!! BILLING HALT: %s — stopping cleanly, progress saved. Re-run to resume." % e)

# upload whatever manifest exists (final or partial)
if os.path.exists(MANI):
    H.s3.upload_file(MANI, H.BUCKET, "hooks/runs/phase0/manifest.jsonl")
rows = [json.loads(l) for l in open(MANI)] if os.path.exists(MANI) else []
print("\n=== PHASE 0 (%d hooks total, +%.0fs, ~$%.2f rendered this run) ===" % (
    len(rows), time.time()-t0, H.RENDERS[0]*0.003))
if rows and not halted:
    P = np.array([r["pctile"] for r in rows]); NN = np.array([r["nn_cos"] for r in rows])
    print("pctile spread: min=%.0f%% p25=%.0f%% median=%.0f%% p75=%.0f%% max=%.0f%%" % (
        P.min()*100, np.percentile(P,25)*100, np.median(P)*100, np.percentile(P,75)*100, P.max()*100))
    print("in-distribution: %d/%d nn_cos>=0.724 | nn range %.3f-%.3f" % (
        int((NN>=0.724).sum()), len(NN), NN.min(), NN.max()))
