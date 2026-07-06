#!/usr/bin/env python3
"""
Rebuild longform/thumb-rl/titles.jsonl as an ENGLISH-ONLY pool that also includes every title from a set
of similar long-form creators (Hacksmith, Mark Rober, Nick DiGiovanni, ...). The trainer samples a fresh
title each step, so an on-distribution, same-lane pool teaches thumbnails that fit the user's style.
Run: python3 build_creator_titles.py
"""
import io, json, re, subprocess, boto3
from langdetect import detect, DetectorFactory, LangDetectException
DetectorFactory.seed = 0
def env(k):
    for ln in open('.env'):
        if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
B = 'business-world-videos'

# user's list + a few clearly in the same build/engineering/challenge/stunt lane
CREATORS = ['theHacksmith', 'Engineezy', 'jakelaser', 'MarkRober', 'StokesTwins', 'presidentchay',
            'NickDiGiovanni', 'PrestonGoes', 'LawByMike', 'colinfurze', 'WilliamOsman', 'MichelleKhare',
            'ryantrahan', 'Airrack', 'ZHC', 'WhistlinDiesel', 'DIYPerks', 'Ididathing', 'BeastReacts']

NONLATIN = re.compile(r'[぀-ヿ一-鿿가-힯Ѐ-ӿ؀-ۿ֐-׿ऀ-ॿ฀-๿]')
def is_english(t):
    if NONLATIN.search(t): return False                 # CJK/Cyrillic/Arabic/Hebrew/Devanagari/Thai → reject fast
    letters = re.sub(r'[^A-Za-z]', '', t)
    if len(letters) < 3: return False                   # numbers/emoji only
    try:
        if detect(t) == 'en': return True
    except LangDetectException:
        pass
    # langdetect is unreliable on short titles — keep short all-ASCII ones with an English stopword
    words = re.findall(r"[A-Za-z']+", t.lower())
    STOP = {'the', 'a', 'an', 'i', 'you', 'my', 'how', 'to', 'of', 'in', 'is', 'on', 'for', 'with', 'vs',
            'best', 'worst', 'top', 'this', 'we', 'he', 'she', 'they', 'and', 'or', 'but', 'can', 'do',
            'did', 'me', 'your', 'our', 'why', 'what', 'when', 'first', 'last', 'new', 'world', 'ever'}
    return len(words) <= 6 and t.isascii() and any(w in STOP for w in words)

def scrape(handle):
    for url in (f"https://www.youtube.com/@{handle}/videos", f"https://www.youtube.com/c/{handle}/videos"):
        try:
            out = subprocess.run(['yt-dlp', '--flat-playlist', '--no-warnings', '--ignore-errors',
                                  '--extractor-args', 'youtube:player_client=web_safari,mweb',
                                  '--playlist-end', '800', '--print', '%(title)s', url],
                                 capture_output=True, text=True, timeout=180)
            ts = [l.strip() for l in out.stdout.splitlines() if l.strip() and l.strip() != 'NA']
            if ts: return ts
        except Exception:
            continue
    return []

titles, seen = [], set()
def add(t, src):
    t = (t or '').strip()
    if not t or len(t) < 8 or len(t) > 160 or not is_english(t): return False
    key = re.sub(r'\W+', '', t.lower())[:80]
    if key in seen: return False
    seen.add(key); titles.append(t); return True

# 1) creator titles
for h in CREATORS:
    ts = scrape(h); kept = sum(add(t, h) for t in ts)
    print(f"  @{h}: scraped {len(ts)} → kept {kept} english", flush=True)
# 2) existing library pool, re-filtered to english
try:
    old = [json.loads(l)['title'] for l in s3.get_object(Bucket=B, Key='longform/thumb-rl/titles.jsonl')['Body'].read().decode().splitlines() if l.strip()]
    keptlib = sum(add(t, 'lib') for t in old)
    print(f"  library: {len(old)} existing → kept {keptlib} english (new, deduped)", flush=True)
except Exception as e:
    print('  (no existing titles.jsonl)', e)

s3.put_object(Bucket=B, Key='longform/thumb-rl/titles.jsonl',
              Body='\n'.join(json.dumps({'title': t}) for t in titles).encode(), ContentType='application/x-ndjson')
print(f"\nTOTAL english title pool: {len(titles)}  → longform/thumb-rl/titles.jsonl")
print('sample:', titles[:5])
