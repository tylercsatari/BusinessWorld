#!/usr/bin/env python3
"""
r7_harvest.py — Phase 1 of the idea_r7 run (hosted, no GPU box needed).

For each premise (a seed, or an idea the fine-tuned model invents) it:
  hosted idea_r5 → 5-frame opening → render 5 frames on Replicate (flux-schnell) →
  score with the SAME engine the Experiments tab uses (raw_upload.py: keep / views /
  every indicator) → GATE on predicted keep >= 0.80 OR scaled views >= 5,000,000 →
  save EVERY hook to the Guesses map (run discover7) and, if it clears the gate, ALSO
  to the Experiments "Saved hooks" bank. Text-embedding novelty prevents repeating an
  idea (or drifting onto one topic) as it goes.

Env (from repo .env): R2_*, GEMINI_API_KEY, REPLICATE_API_TOKEN.
  python r7_harvest.py --seeds
  python r7_harvest.py --invent --target 300   # keep inventing (novelty-gated) until 300 clear the gate
  python r7_harvest.py --seeds --limit 2       # quick validation on 2 seeds
"""
import os, sys, json, time, io, re, base64, subprocess, argparse, urllib.request, urllib.error, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from PIL import Image
import boto3

ROOT = Path(__file__).resolve().parents[3]
ENV = {}
for l in (ROOT / '.env').read_text().splitlines():
    if '=' in l and not l.strip().startswith('#'):
        k, v = l.split('=', 1); ENV[k] = v.strip().strip('"').strip("'")
GEMINI = ENV['GEMINI_API_KEY']
REPLICATE = ENV.get('REPLICATE_API_TOKEN') or ENV.get('REPLICATE_API_KEY')
MODAL_URL = 'https://tylercsatari--hook-idea-model-model-generate.modal.run'
MODAL_TOKEN = os.environ.get('HOOK_MODEL_TOKEN', '2f013c8ab6dcbd04a01480ab0ddd60bab7b2f42849430210')
RUN = os.environ.get('RUN', 'discover7')
KEEP_MIN = float(os.environ.get('KEEP_MIN', '80'))
VIEWS_MIN = float(os.environ.get('VIEWS_MIN', '5000000'))
NOV_FLOOR = float(os.environ.get('NOV_FLOOR', '0.14'))
PY = '/Users/tylercsatari/miniforge3/bin/python3'
HERE = Path(__file__).resolve().parent
RAW_UPLOAD = ROOT / 'raw_upload.py'
s3 = boto3.client('s3', endpoint_url='https://%s.r2.cloudflarestorage.com' % ENV['R2_ACCOUNT_ID'],
                  aws_access_key_id=ENV['R2_ACCESS_KEY_ID'], aws_secret_access_key=ENV['R2_SECRET_ACCESS_KEY'], region_name='auto')
BUCKET = ENV['R2_BUCKET_NAME']


def _post(url, body, headers, timeout=165):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={**headers, 'Content-Type': 'application/json'}, method='POST')
    return urllib.request.urlopen(req, timeout=timeout)


def gen_frames(premise, invent, count=1):
    body = {'premise': premise, 'invent': invent, 'count': count, 'token': MODAL_TOKEN}
    deadline = time.time() + 9 * 60
    try:
        r = _post(MODAL_URL, body, {}, timeout=165)
        return json.loads(r.read()).get('attempts', [])
    except urllib.error.HTTPError as e:
        if e.code not in (302, 303, 307): raise
        loc = e.headers.get('Location')
    while loc and time.time() < deadline:
        time.sleep(2)
        try:
            rr = urllib.request.urlopen(urllib.request.Request(loc, method='GET'), timeout=165)
            return json.loads(rr.read()).get('attempts', [])
        except urllib.error.HTTPError as e:
            nl = e.headers.get('Location')
            if e.code in (302, 303, 307):
                if nl and '__modal_function_call_id' in nl: loc = nl
                continue
            raise
    return []


# ── Frame rendering via the SAME director pipeline the app uses: a quality image model
#    (default flux-2-pro), with EDIT→Kontext and COMPOSE→multi-ref for cross-frame continuity. ──
MODEL = os.environ.get('IMG_MODEL', 'flux-2-pro')
STORY_MODELS = {
    'flux-2-pro':       ('black-forest-labs/flux-2-pro',       'input_images', True, 8),
    'seedream-4':       ('bytedance/seedream-4',               'image_input',  True, 10),
    'nano-banana':      ('google/nano-banana',                 'image_input',  True, 6),
    'nano-banana-pro':  ('google/nano-banana-pro',             'image_input',  True, 14),
    'flux-kontext-pro': ('black-forest-labs/flux-kontext-pro', 'input_image',  False, 1),
}
STORY_EDITOR = 'flux-kontext-pro'
DIRECTOR_SYS = ("You are the DIRECTOR of a short photographic storyboard (ordered frames). Maintain a WORLD STATE of "
    "every entity and how it evolves. For EACH frame decide: NEW (entirely new content), EDIT (SAME shot as exactly ONE "
    "prior frame with a small localized change — most pixels unchanged; phrase as an edit instruction), or COMPOSE (a NEW "
    "shot/scene that REUSES characters/objects from prior frames). Resolve every reference against world state; write each "
    "prompt in the user's own words, replacing only pronouns with the concrete noun. Default to COMPOSE when an entity "
    "carries into a new action/shot; EDIT only when the shot barely changes; NEW only for unrelated content. Return ONLY "
    'JSON: {"order":[indices, sources before dependents],"frames":[{"i":idx,"relation":"NEW|EDIT|COMPOSE","edit_of":idx or null,"compose_from":[idx],"prompt":"..."}]}.')


def replicate_run(slug, inp, timeout=300):
    """Create a prediction, then POLL until it succeeds (quality models exceed Prefer:wait). Returns image bytes."""
    r = _post('https://api.replicate.com/v1/models/%s/predictions' % slug, {'input': inp},
              {'Authorization': 'Bearer ' + REPLICATE, 'Prefer': 'wait'}, timeout=120)
    j = json.loads(r.read())
    deadline = time.time() + timeout
    while True:
        out, status = j.get('output'), j.get('status')
        if out:
            if isinstance(out, list): out = out[0] if out else None
            if out: return urllib.request.urlopen(out, timeout=60).read()
        if status in ('failed', 'canceled'): raise RuntimeError('replicate %s: %s' % (status, str(j.get('error'))[:100]))
        if time.time() > deadline: raise RuntimeError('replicate timeout (%ss)' % timeout)
        get_url = (j.get('urls') or {}).get('get') or ('https://api.replicate.com/v1/predictions/%s' % j.get('id'))
        time.sleep(2)
        rr = urllib.request.urlopen(urllib.request.Request(get_url, headers={'Authorization': 'Bearer ' + REPLICATE}), timeout=30)
        j = json.loads(rr.read())


def _datauri(b): return 'data:image/jpeg;base64,' + base64.b64encode(b).decode()


def gen_story_frame(prompt, refs, relation):
    key = STORY_EDITOR if relation == 'edit' else (MODEL if MODEL in STORY_MODELS else 'flux-2-pro')
    slug, field, arr, mx = STORY_MODELS[key]
    inp = {'prompt': prompt}
    if 'kontext' not in slug: inp['aspect_ratio'] = '9:16'
    if 'flux' in slug or 'nano' in slug: inp['output_format'] = 'jpg'
    if refs: inp[field] = refs[:mx] if arr else refs[0]
    return replicate_run(slug, inp)


def plan_frames(descs):
    idxs = [i for i, d in enumerate(descs) if (d or '').strip()]
    fb = {'order': idxs, 'frames': [{'i': i, 'relation': 'new', 'edit_of': None, 'compose_from': [], 'prompt': descs[i]} for i in idxs]}
    if len(idxs) < 2: return fb
    usr = 'Frames (in intended order):\n' + '\n'.join('[%d] %s' % (i, descs[i] or '(empty)') for i in range(len(descs)))
    try:
        r = _post('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
                  {'contents': [{'parts': [{'text': DIRECTOR_SYS + '\n\n' + usr}]}], 'generationConfig': {'responseMimeType': 'application/json'}},
                  {'x-goog-api-key': GEMINI}, timeout=45)
        txt = json.loads(r.read())['candidates'][0]['content']['parts'][0]['text']
        plan = json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
    except Exception:
        return fb
    byI = {}
    for f in (plan.get('frames') or []):
        if not isinstance(f, dict) or f.get('i') not in idxs: continue
        rel = str(f.get('relation', 'new')).lower()
        if rel not in ('new', 'edit', 'compose'): rel = 'new'
        eo = f.get('edit_of') if (rel == 'edit' and f.get('edit_of') in idxs and f.get('edit_of') != f.get('i')) else None
        cf = [x for x in (f.get('compose_from') or []) if x in idxs and x != f.get('i')] if rel == 'compose' else []
        if rel == 'edit' and eo is None: rel = 'compose' if cf else 'new'
        if rel == 'compose' and not cf: rel = 'new'
        byI[f['i']] = {'i': f['i'], 'relation': rel, 'edit_of': eo if rel == 'edit' else None,
                       'compose_from': cf if rel == 'compose' else [], 'prompt': str(f.get('prompt') or descs[f['i']])[:700]}
    frames = [byI.get(i, {'i': i, 'relation': 'new', 'edit_of': None, 'compose_from': [], 'prompt': descs[i]}) for i in idxs]
    order = [i for i in (plan.get('order') or []) if i in idxs]
    for i in idxs:
        if i not in order: order.append(i)
    return {'order': order, 'frames': frames}


def render_hook(descs):
    """Director plan → render the 5 frames in dependency order (EDIT/COMPOSE reuse prior frames)."""
    plan = plan_frames(descs)
    meta = {f['i']: f for f in plan['frames']}
    done = {}
    for i in plan['order']:
        f = meta.get(i, {'relation': 'new', 'prompt': descs[i]})
        rel = f.get('relation', 'new')
        if rel == 'edit':
            srcs = [f['edit_of']] if (f.get('edit_of') in done) else []
        elif rel == 'compose':
            srcs = [s for s in (f.get('compose_from') or []) if s in done]
        else:
            srcs = []
        if rel in ('edit', 'compose') and not srcs: rel = 'new'
        refs = [_datauri(done[s]) for s in srcs]
        done[i] = gen_story_frame(f.get('prompt') or descs[i], refs, rel)
    return [done[i] for i in sorted(done)]


def montage(frame_bytes):
    ims = [Image.open(io.BytesIO(b)).convert('RGB') for b in frame_bytes]
    h = 512; w = int(ims[0].width * h / ims[0].height)
    canvas = Image.new('RGB', (w * 5, h), (0, 0, 0))
    for i, im in enumerate(ims[:5]): canvas.paste(im.resize((w, h)), (i * w, 0))
    buf = io.BytesIO(); canvas.save(buf, 'JPEG', quality=90); return buf.getvalue()


_score_ctr = __import__('itertools').count()
_score_sema = threading.Semaphore(int(os.environ.get('SCORE_CONC', '4')))   # cap concurrent Gemini-heavy scoring
def score(montage_bytes, text, tries=4):
    tmp = HERE / ('_score_%d_%d.jpg' % (os.getpid(), next(_score_ctr)))     # UNIQUE per call (no cross-thread collision)
    tmp.write_bytes(montage_bytes)
    try:
        env = {**os.environ, **ENV}
        with _score_sema:
            for t in range(tries):
                out = subprocess.run([PY, str(RAW_UPLOAD), '--image', str(tmp), '--text', text[:2000], '--title', text[:60]],
                                     capture_output=True, text=True, timeout=150, env=env)
                if out.stdout.strip().startswith('{'):
                    j = json.loads(out.stdout)
                    st = j.get('steer') or {}
                    tk = (st.get('together_keep') or {}).get('est'); vk = (st.get('visual_keep') or {}).get('est')
                    if isinstance(tk, (int, float)) or isinstance(vk, (int, float)):   # a REAL numeric score
                        return j
                time.sleep(3 + 3 * t)   # back off (likely Gemini rate limit)
        return {'error': 'no usable steer after %d tries' % tries}
    finally:
        try: tmp.unlink()
        except Exception: pass


def embed_text(t):
    r = _post('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent',
              {'content': {'parts': [{'text': t}]}}, {'x-goog-api-key': GEMINI}, timeout=30)
    v = np.array(json.loads(r.read())['embedding']['values'], np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def gate(steer):
    # canonical channel = "together" (the full hook: frames + text). Fall back to visual
    # only when together is absent (e.g. a silent/text-less read).
    est = lambda k: (steer.get(k) or {}).get('est')
    keep = est('together_keep');  keep = est('visual_keep') if keep is None else keep
    views = est('together_views'); views = est('visual_views') if views is None else views
    ok = (keep is not None and keep >= KEEP_MIN) or (views is not None and views >= VIEWS_MIN)
    return ok, keep, views


# ── R2 map: place a hook at the similarity-weighted average of its neighbours ──
_MAPS = {}
def place_xy(neighbors, channel='visual'):
    m = _MAPS.get(channel)
    if m is None:
        try: m = json.loads(s3.get_object(Bucket=BUCKET, Key='raw/%s/map.json' % channel)['Body'].read())
        except Exception: m = {}
        _MAPS[channel] = m
    proj = (m.get('proj') or {}).get('visual') or (m.get('proj') or {}).get('together') or {}
    ids, xs, ys = m.get('id') or [], proj.get('x') or [], proj.get('y') or []
    pos = {ids[i]: (xs[i], ys[i]) for i in range(min(len(ids), len(xs), len(ys)))}
    num = [0.0, 0.0]; den = 0.0
    for nb in (neighbors or []):
        p = pos.get(nb.get('id')); w = max(0.0, nb.get('sim', 0))
        if p: num[0] += p[0] * w; num[1] += p[1] * w; den += w
    return (num[0] / den, num[1] / den) if den else (500, 500)


# ── shared state (thread-safe): sequential idx, counters, accepted-idea embeddings, manifest ──
_manifest = []
_lock = threading.Lock()
_state = {'idx': 0, 'gen': 0, 'kept': 0, 'accepted': [], 'dup': 0, 'fail': 0}


def load_manifest():
    global _manifest
    try:
        b = s3.get_object(Bucket=BUCKET, Key='hooks/grpo/%s/manifest.jsonl' % RUN)['Body'].read().decode().strip()
        _manifest = b.split('\n') if b else []
    except Exception:
        _manifest = []
    _state['idx'] = len(_manifest)


def flush_manifest():
    with _lock:
        body = '\n'.join(_manifest).encode()
    s3.put_object(Bucket=BUCKET, Key='hooks/grpo/%s/manifest.jsonl' % RUN, Body=body, ContentType='application/x-ndjson')


def save_hook(premise, spec, montage_bytes, sc, kept, keep, views):
    with _lock:
        idx = _state['idx']; _state['idx'] += 1
    gid = 'h%05d' % idx; hid = '%s_0' % gid
    s3.put_object(Bucket=BUCKET, Key='hooks/grpo/%s/montages/%s.jpg' % (RUN, hid), Body=montage_bytes, ContentType='image/jpeg')
    steer = sc.get('steer') or {}
    x, y = place_xy((sc.get('channels', {}).get('visual') or {}).get('neighbors'))
    pct = ((steer.get('together_keep') or steer.get('visual_keep') or {}).get('pctile') or 0) / 100.0
    row = {'id': hid, 'input_id': gid, 'k': 0, 'premise': premise, 'brief': premise, 'x': x, 'y': y,
           'pctile': pct, 'keep_pred': keep, 'views_pred': views, 'kept': kept,
           'cohesion_mode': spec.get('cohesion_mode', ''), 'frames': spec.get('frames', []),
           'reasoning': spec.get('reasoning', '')[:800], 'caption': premise}
    with _lock:
        _manifest.append(json.dumps(row))
    s3.put_object(Bucket=BUCKET, Key='hooks/grpo/%s/groups/%s.json' % (RUN, gid),
                  Body=json.dumps({'input_id': gid, 'premise': premise, 'n': 1, 'attempts': [row]}).encode(), ContentType='application/json')
    if kept:   # cleared the gate → Experiments "Saved hooks"
        sid = 'hk%s' % gid
        s3.put_object(Bucket=BUCKET, Key='raw/saved-hooks/%s.jpg' % sid, Body=montage_bytes, ContentType='image/jpeg')
        rec = {'id': sid, 'savedAt': int(time.time() * 1000), 'kind': 'scored', 'source': 'r7_harvest',
               'title': premise[:140], 'text': premise, 'frames': spec.get('frames', []), 'frame_imgs': [],
               'cohesion_mode': spec.get('cohesion_mode', ''), 'hasMontage': True,
               'indicators': sc.get('indicators'), 'steer': steer}
        s3.put_object(Bucket=BUCKET, Key='raw/saved-hooks/%s.json' % sid, Body=json.dumps(rec).encode(), ContentType='application/json')


def render_score_save(prem, spec, novelty=False):
    """Render (director) → score → gate → save. novelty=True runs the idea-text uniqueness gate first.
       Returns 'dup' | 'fail' | (kept, keep, views)."""
    if novelty:
        try: e = embed_text(prem)
        except Exception: return 'fail'
        with _lock:
            if _state['accepted'] and max(float(np.dot(e, a)) for a in _state['accepted']) > (1 - NOV_FLOOR):
                _state['dup'] += 1; return 'dup'
            _state['accepted'].append(e)
    frames = spec.get('frames') or []
    if len(frames) != 5: return 'fail'
    try:
        imgs = render_hook(frames)
        if len(imgs) != 5: return 'fail'
        mon = montage(imgs)
        sc = score(mon, prem)
        if sc.get('error'): return 'fail'
        kept, keep, views = gate(sc.get('steer') or {})     # gate takes the STEER dict, not the whole score object
        save_hook(prem, spec, mon, sc, kept, keep, views)
    except Exception as ex:
        print('  render/score err:', str(ex)[:120], flush=True); return 'fail'
    with _lock:
        _state['gen'] += 1
        if kept: _state['kept'] += 1
        n, k = _state['gen'], _state['kept']
    if n % 15 == 0: flush_manifest()
    print('[gen %d kept %d] keep=%s views=%s :: %s' % (n, k, keep, views, (prem or '')[:52]), flush=True)
    return (kept, keep, views)


def gen_retry(premise, invent, count, tries=3):
    for t in range(tries):
        try:
            specs = gen_frames(premise, invent, count)
            if specs: return specs
        except Exception as ex:
            print('  gen err:', str(ex)[:100], flush=True)
        time.sleep(2 + 3 * t)
    return []


# batched idea buffer for invent mode (Modal count=8 per call → workers consume)
_buffer = []; _buf_lock = threading.Lock()
def next_spec():
    with _buf_lock:
        if _buffer: return _buffer.pop()
    specs = gen_retry('INVENT', True, 8)
    with _buf_lock:
        _buffer.extend(specs)
        return _buffer.pop() if _buffer else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', action='store_true')
    ap.add_argument('--invent', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--max-gen', type=int, default=1700)     # budget cap (~$0.20/hook → ~$340)
    ap.add_argument('--workers', type=int, default=12)
    a = ap.parse_args()
    load_manifest()
    if a.seeds:
        seeds = json.loads((HERE / 'seed_hooks.json').read_text())['seeds']
        if a.limit: seeds = seeds[:a.limit]
        def do_seed(prem):
            specs = gen_retry(prem, False, 1)
            if not specs: return
            render_score_save(specs[0].get('premise') or prem, specs[0], novelty=False)
        with ThreadPoolExecutor(max_workers=min(6, a.workers)) as ex:
            list(ex.map(do_seed, seeds))
        flush_manifest()
        print('SEEDS DONE — kept %d / gen %d' % (_state['kept'], _state['gen']), flush=True)
    if a.invent:
        def worker():
            while True:
                with _lock:
                    if _state['gen'] >= a.max_gen: return
                spec = next_spec()
                if not spec: continue
                prem = spec.get('premise')
                if not prem: continue
                render_score_save(prem, spec, novelty=True)
        with ThreadPoolExecutor(max_workers=a.workers) as ex:
            futs = [ex.submit(worker) for _ in range(a.workers)]
            for f in futs: f.result()
        flush_manifest()
        print('INVENT DONE — kept %d, generated %d, novelty-rejects %d, fails %d' % (_state['kept'], _state['gen'], _state['dup'], _state['fail']), flush=True)


if __name__ == '__main__':
    main()
