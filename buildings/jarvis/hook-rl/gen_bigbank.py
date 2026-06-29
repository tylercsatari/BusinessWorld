"""Generate a big bank of DISTINCT short-form video ideas (Gemini brainstorm) so no prompt repeats."""
import json, time, urllib.request
import harness as H
GEN = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
NICHES = ["food", "restoration", "science", "challenge", "pets", "tech", "art", "stunts", "diy", "comedy",
          "fitness", "travel", "magic", "satisfying", "education", "sports", "music", "fashion", "gaming",
          "nature", "cars", "money", "psychology", "history", "survival", "crafts", "beauty", "pranks"]
TARGET = 2400
ideas, seen = [], set()
for rnd in range(120):
    niche = NICHES[rnd % len(NICHES)]
    prompt = ("Brainstorm 30 DISTINCT, specific, scroll-stopping YouTube Shorts video ideas in the '%s' niche. "
              "Each a concrete one-sentence premise (not generic, not repetitive). Return ONLY a JSON array of 30: "
              '{"premise":"...","niche":"%s","format":"reveal|transformation|challenge|tutorial|reaction|experiment|story"}.' % (niche, niche))
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"responseMimeType": "application/json", "temperature": 1.25}}).encode()
    try:
        req = urllib.request.Request(GEN, data=body, method="POST", headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
        arr = json.loads(json.loads(urllib.request.urlopen(req, timeout=90).read())["candidates"][0]["content"]["parts"][0]["text"])
        new = 0
        for b in arr:
            if isinstance(b, dict) and b.get("premise"):
                k = b["premise"].lower().strip()[:80]
                if k in seen: continue
                seen.add(k); b["source"] = "gen"; ideas.append(b); new += 1
    except Exception as e:
        print("round", rnd, "err", str(e)[:60])
    print("round %d [%s] +%d total %d" % (rnd, niche, new if 'new' in dir() else 0, len(ideas)), flush=True)
    if len(ideas) >= TARGET: break
    time.sleep(0.25)
# fold in the owned/competitor ideabank (keep their real ideas too)
try:
    for l in open("/home/ubuntu/hookrl/data/ideabank.jsonl"):
        b = json.loads(l); k = b["premise"].lower().strip()[:80]
        if k not in seen: seen.add(k); ideas.append(b)
except Exception: pass
with open("/home/ubuntu/hookrl/data/ideabank_big.jsonl", "w") as f:
    f.write("\n".join(json.dumps(x) for x in ideas))
H.s3.upload_file("/home/ubuntu/hookrl/data/ideabank_big.jsonl", H.BUCKET, "hooks/ideabank_big.jsonl")
print("=== BIGBANK_DONE %d unique ideas ===" % len(ideas), flush=True)
