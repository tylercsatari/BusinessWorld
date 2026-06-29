"""Continuous UNBOUNDED idea generator — runs all night, appends only NEW (content-signature
deduped) premises to ideabank_big.jsonl. Gemini brainstorm + combinatorial templates so the
bank never runs dry and no idea ever repeats (prevents idea-overfit)."""
import json, time, random, re, urllib.request
import harness as H
GEN = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
BANK = "/home/ubuntu/hookrl/data/ideabank_big.jsonl"
NICHES = ["food", "restoration", "science", "challenge", "pets", "tech", "art", "stunts", "diy", "comedy",
          "fitness", "travel", "magic", "satisfying", "education", "sports", "music", "fashion", "gaming",
          "nature", "cars", "money", "psychology", "history", "survival", "crafts", "beauty", "pranks"]
SUBJ = ["a chef", "a dog", "a robot", "a grandmother", "a kid", "a blacksmith", "a diver", "a street artist",
        "a mechanic", "a scientist", "a farmer", "a pro gamer", "an athlete", "a magician", "a builder",
        "a barber", "a tattoo artist", "a baker", "a welder", "a janitor", "a sculptor", "a fisherman"]
ACT = ["restores", "races against", "builds", "destroys", "transforms", "reveals", "stress-tests", "deep-cleans",
       "cooks", "carves", "melts", "freezes", "repaints", "rebuilds", "grows", "stacks", "launches",
       "disassembles", "customizes", "reviews", "shrinks", "supersizes"]
OBJ = ["a rusty knife", "a supercar", "a giant cake", "an abandoned house", "a fish tank", "a vending machine",
       "a mechanical keyboard", "a pair of sneakers", "a watermelon", "an engine", "a guitar", "a drone",
       "a fireplace", "a luxury watch", "a katana", "a pizza oven", "an aquarium", "a chandelier",
       "a motorcycle", "a treehouse", "a 3D printer", "a violin"]
TWIST = ["blindfolded", "in 60 seconds", "underwater", "using only trash", "at 3am", "for charity", "with no tools",
         "against the clock", "in reverse", "on a $1 budget", "in extreme cold", "with one hand", "upside down",
         "in front of a huge crowd", "for the very first time", "while being judged by experts"]

_STOP = set("a an the of to and or for with in on at into out from by as is are be do does this that their his her your you i we they it them then so very more most over under after before how why what when only just".split())
_BOILER = re.compile(r"^\s*(the |a |an )?(creator|person|guy|girl|man|woman|youtuber|participants?|someone|narrator|host)\s+(attempts? to|tries? to|documents?|tests?|creates?|builds?|makes?|transforms?|trains?|presents?|sets? out to|decides? to|shows?|reviews?)\s+", re.I)
def sig(p):
    p = _BOILER.sub("", (p or "").lower())
    ws = [w for w in re.findall(r"[a-z]+", p) if w not in _STOP and len(w) > 2]
    return " ".join(sorted(set(ws))[:8])

def gem_batch(niche):
    prompt = ("Brainstorm 30 DISTINCT, specific, never-before-seen YouTube Shorts video ideas in '%s'. "
              "Each a concrete one-sentence premise (no repeats, no generic). Return ONLY a JSON array of 30: "
              '{"premise":"...","niche":"%s","format":"reveal|transformation|challenge|tutorial|reaction|experiment|story"}.' % (niche, niche))
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"responseMimeType": "application/json", "temperature": 1.3}}).encode()
    req = urllib.request.Request(GEN, data=body, method="POST", headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
    return json.loads(json.loads(urllib.request.urlopen(req, timeout=90).read())["candidates"][0]["content"]["parts"][0]["text"])

def combo():
    return "%s %s %s %s." % (random.choice(SUBJ).capitalize(), random.choice(ACT), random.choice(OBJ), random.choice(TWIST))

seen = set()
try:
    for l in open(BANK): seen.add(sig(json.loads(l).get("premise", "")))
except Exception: pass
print("idea generator starting; bank has ~%d" % len(seen), flush=True)

while True:
    batch = []
    try:
        batch += [b for b in gem_batch(random.choice(NICHES)) if isinstance(b, dict) and b.get("premise")]
    except Exception as e:
        print("gem err", str(e)[:50], flush=True)
    for _ in range(25):
        batch.append({"premise": combo(), "niche": "mixed", "format": "experiment", "source": "combo"})
    new = 0
    with open(BANK, "a") as f:
        for b in batch:
            k = sig(b.get("premise", ""))
            if not k or k in seen: continue
            seen.add(k); b.setdefault("source", "gen"); f.write(json.dumps(b) + "\n"); new += 1
    print("ideas +%d  bank~%d" % (new, len(seen)), flush=True)
    time.sleep(8)
