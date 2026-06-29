import json, time, urllib.request, urllib.parse
from collections import Counter
import harness as H

def envv(k):
    for line in open("/home/ubuntu/hookrl/.env"):
        if line.startswith(k + "="): return line.split("=", 1)[1].strip()
# YouTube creds aren't in the box .env (only R2/Gemini/Replicate were copied) -> read from passed file
CRED = json.load(open("/home/ubuntu/hookrl/yt_creds.json"))
MODEL = "gemini-2.5-flash"
GEN = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % MODEL

def access_token():
    data = urllib.parse.urlencode({"client_id": CRED["client_id"], "client_secret": CRED["client_secret"],
        "refresh_token": CRED["refresh_token"], "grant_type": "refresh_token"}).encode()
    r = json.loads(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=data), timeout=30).read())
    return r["access_token"]

TOK = access_token()
def yt(path, **params):
    url = "https://www.googleapis.com/youtube/v3/" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + TOK})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

CHANNELS = ["MrBeast", "MarkRober", "NickDiGiovanni", "JoshuaWeissman", "ZachKing", "airrack",
            "RyanTrahan", "DanielLaBelle", "TopperGuild", "StokesTwins", "brodiethatdood",
            "Hingaflips", "IShowSpeed", "mrwhosetheboss", "ZHC", "MyMechanics"]

def channel_titles(handle, n=40):
    try:
        ch = yt("channels", part="contentDetails", forHandle=handle)
        up = ch["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
        titles, page = [], None
        while len(titles) < n:
            kw = {"part": "snippet", "playlistId": up, "maxResults": 50}
            if page: kw["pageToken"] = page
            r = yt("playlistItems", **kw)
            titles += [it["snippet"]["title"] for it in r.get("items", [])]
            page = r.get("nextPageToken")
            if not page: break
        return titles[:n]
    except Exception as e:
        print("  yt fail", handle, str(e)[:60]); return []

def distill(titles):
    prompt = ("For each YouTube Shorts title, infer the underlying VIDEO IDEA as a brief. Return ONLY a JSON array "
        '(one object per title in order): {"premise":"one concrete sentence","niche":"food|restoration|science|challenge|pets|tech|art|stunts|diy|comedy|fitness|other","format":"reveal|transformation|challenge|tutorial|reaction|experiment|story"}.\nTitles:\n'
        + "\n".join("%d. %s" % (i + 1, t) for i, t in enumerate(titles)))
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.7}}).encode()
    for a in range(3):
        try:
            req = urllib.request.Request(GEN, data=body, method="POST", headers={"Content-Type": "application/json", "x-goog-api-key": H.GEMINI})
            arr = json.loads(json.loads(urllib.request.urlopen(req, timeout=90).read())["candidates"][0]["content"]["parts"][0]["text"])
            if isinstance(arr, list): return arr
        except Exception:
            if a < 2: time.sleep(2); continue
    return []

ideas = []
for ch in CHANNELS:
    ts = channel_titles(ch)
    print("%-18s %d titles" % (ch, len(ts)), flush=True)
    for i in range(0, len(ts), 20):
        for b in distill(ts[i:i + 20]):
            if isinstance(b, dict) and b.get("premise"):
                b["source"] = ch; ideas.append(b)
        time.sleep(0.3)

# merge with existing owned ideabank, dedup
existing = []
try: existing = [json.loads(l) for l in open("/home/ubuntu/hookrl/data/ideabank.jsonl")]
except Exception: pass
seen = set(); merged = []
for b in existing + ideas:
    k = b["premise"].lower().strip()[:80]
    if k in seen: continue
    seen.add(k); merged.append(b)
with open("/home/ubuntu/hookrl/data/ideabank_full.jsonl", "w") as f:
    f.write("\n".join(json.dumps(x) for x in merged))
H.s3.upload_file("/home/ubuntu/hookrl/data/ideabank_full.jsonl", H.BUCKET, "hooks/ideabank_full.jsonl")
print("FULL IDEABANK: %d (%d competitor + %d owned); sources:" % (len(merged), len(ideas), len(existing)),
      dict(Counter(b.get("source", "?") for b in merged).most_common(20)), flush=True)
