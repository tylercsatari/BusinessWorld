#!/usr/bin/env python3
"""YouTube relay watcher — runs on Tyler's Mac (residential IP that YouTube trusts).

Render's datacenter IP is bot-blocked by YouTube, so the server can't download videos for
link-scoring. When it hits the block, it drops a request into R2 (shorts/yt-relay/requests/)
and this watcher — running here where YouTube is happy — downloads the video, runs the FULL
raw_upload.py scoring pipeline locally (frames + whisper transcript + embeds + steers), and
uploads the finished record to shorts/yt-relay/results/ for the server's job to return.

Installed as a launchd agent (com.businessworld.ytrelay) with KeepAlive — like the crawler,
it should always be running."""
import base64, json, os, re, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import boto3

def env(k):
    v = os.environ.get(k)
    if v: return v
    try:
        for ln in open(os.path.join(HERE, '.env')):
            if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception: pass
    return None

BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
PY = os.environ.get('RELAY_PYTHON') or '/Users/tylercsatari/miniforge3/bin/python3'
REQ, RES = 'shorts/yt-relay/requests/', 'shorts/yt-relay/results/'
CHANNEL_REQ = 'shorts/channel-import/requests/'
CHANNEL_ROOT = 'raw/saved-channels/'
CHANNEL_INDEX = CHANNEL_ROOT + 'index.json'
FEATURE_CONTRACT = json.load(open(os.path.join(HERE, 'buildings', 'jarvis', 'saved-channel-feature-contract.json')))
_index_lock = threading.Lock()

def log(m):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), m), flush=True)

def get_json(key, default=None):
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except Exception:
        return default

def put_json(key, value):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(value, separators=(',', ':')).encode(), ContentType='application/json')

def list_json(prefix):
    out, token = [], None
    while True:
        args = {'Bucket': BUCKET, 'Prefix': prefix}
        if token: args['ContinuationToken'] = token
        page = s3.list_objects_v2(**args)
        out += [obj['Key'] for obj in page.get('Contents', []) if obj['Key'].endswith('.json')]
        token = page.get('NextContinuationToken') if page.get('IsTruncated') else None
        if not token: return out

def score_link(url, title='', stop_check=None):
    args = [PY, os.path.join(HERE, 'raw_upload.py'), '--youtube', url]
    if title: args += ['--title', str(title)[:80]]
    try:
        # File-backed streams cannot fill a PIPE and deadlock while yt-dlp/ffmpeg run.
        # They also keep a channel import's memory constant across hundreds of Shorts.
        with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as stdout_file, \
                tempfile.TemporaryFile(mode='w+', encoding='utf-8') as stderr_file:
            process = subprocess.Popen(args, stdout=stdout_file, stderr=stderr_file, text=True)
            started = time.time()
            while process.poll() is None:
                if stop_check and stop_check():
                    process.kill(); process.wait()
                    return {'error': 'stopped by user', 'stopped': True}
                if time.time() - started > 420:
                    process.kill(); process.wait()
                    return {'error': 'relay: opening download + scoring exceeded 7 minutes'}
                time.sleep(.5)
            stdout_file.seek(0); stderr_file.seek(0)
            stdout, stderr = stdout_file.read(), stderr_file.read()
        lines = [line for line in (stdout or '').strip().splitlines() if line.strip().startswith('{')]
        return json.loads(lines[-1]) if lines else {'error': 'relay: no JSON - ' + (stderr or '')[-240:]}
    except Exception as exc:
        return {'error': 'relay: ' + str(exc)[:240]}

def handle(key):
    rid = key.rsplit('/', 1)[-1][:-5]
    try:
        req = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except Exception:
        s3.delete_object(Bucket=BUCKET, Key=key)
        return
    url = str(req.get('url') or '')[:300]
    log('relay %s ← %s' % (rid, url))
    out = score_link(url, req.get('title') or '')
    out['relayedBy'] = 'mac'
    s3.put_object(Bucket=BUCKET, Key=RES + rid + '.json', Body=json.dumps(out).encode(), ContentType='application/json')
    s3.delete_object(Bucket=BUCKET, Key=key)
    log('relay %s → %s' % (rid, 'ERROR ' + out['error'][:80] if out.get('error') else 'ok'))

def indicator_strength(indicator):
    if indicator.get('auc') is not None:
        return abs(float(indicator.get('auc') or .5) - .5) * 2
    return abs(float(indicator.get('spearman') or 0))

def novelty_feature(record, registry, target):
    values = record.get('indicators') or {}
    pool = [indicator for indicator in (registry.get('indicators') or [])
            if indicator.get('kind') == 'novelty' and indicator.get('target') == target
            and values.get(indicator.get('name')) is not None]
    if not pool: return None
    validated = sorted([indicator for indicator in pool if indicator.get('validated')], key=indicator_strength, reverse=True)
    indicator = (validated or sorted(pool, key=indicator_strength, reverse=True))[0]
    score = float(values[indicator['name']])
    points = indicator.get('pts') or []
    if not points: return None
    percentile = sum(1 for point in points if float(point[0]) <= score) / float(len(points))
    if float(indicator.get('spearman') or 0) < 0: percentile = 1 - percentile
    actual = sorted(float(point[1]) for point in points)
    at = max(0, min(len(actual) - 1, int(round(percentile * (len(actual) - 1)))))
    return [round(actual[at], 4), round(percentile * 100, 2)]

def compact_features(record, registry):
    steer = record.get('steer') or {}
    features = {}
    for definition in FEATURE_CONTRACT['features']:
        if definition.get('source') == 'steer':
            value = steer.get(definition.get('sourceKey'))
            if value and value.get('est') is not None:
                features[definition['key']] = [value.get('est'), value.get('pctile')]
        else:
            value = novelty_feature(record, registry, definition.get('target'))
            if value is not None: features[definition['key']] = value
    return features

def compact_channel(manifest):
    return {
        'id': manifest.get('id'), 'url': manifest.get('url'), 'name': manifest.get('name'),
        'status': manifest.get('status'), 'phase': manifest.get('phase'),
        'createdAt': manifest.get('createdAt'), 'updatedAt': manifest.get('updatedAt'),
        'discovered': manifest.get('discovered', 0), 'completed': manifest.get('completed', 0),
        'failed': manifest.get('failed', 0), 'queued': manifest.get('queued', 0),
        'current': manifest.get('current'), 'error': manifest.get('error'),
    }

def update_channel_index(manifest):
    with _index_lock:
        index = get_json(CHANNEL_INDEX, {'version': 1, 'channels': []}) or {'version': 1, 'channels': []}
        channels = [channel for channel in (index.get('channels') or []) if channel.get('id') != manifest.get('id')]
        channels.append(compact_channel(manifest))
        channels.sort(key=lambda channel: channel.get('updatedAt') or 0, reverse=True)
        index.update({'version': 1, 'updatedAt': int(time.time() * 1000), 'channels': channels})
        put_json(CHANNEL_INDEX, index)

def recount_manifest(manifest):
    videos = manifest.get('videos') or []
    manifest['discovered'] = len(videos)
    manifest['completed'] = sum(1 for video in videos if video.get('status') == 'done')
    manifest['failed'] = sum(1 for video in videos if video.get('status') == 'error')
    manifest['queued'] = sum(1 for video in videos if video.get('status') in ('queued', 'scoring'))
    manifest['updatedAt'] = int(time.time() * 1000)
    return manifest

def save_manifest(manifest):
    recount_manifest(manifest)
    put_json(CHANNEL_ROOT + manifest['id'] + '/manifest.json', manifest)
    update_channel_index(manifest)

def discover_channel(url):
    import yt_dlp
    target = url.rstrip('/') + '/shorts'
    options = {
        'quiet': True, 'no_warnings': True, 'skip_download': True,
        'extract_flat': 'in_playlist', 'lazy_playlist': False,
        'socket_timeout': 30,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(target, download=False)
    entries = []
    views_observed_at = int(time.time() * 1000)
    for raw in (info.get('entries') or []):
        video_id = str((raw or {}).get('id') or '')
        if not re.match(r'^[\w-]{11}$', video_id): continue
        entries.append({
            'id': video_id,
            'title': str(raw.get('title') or video_id)[:160],
            'views': raw.get('view_count'),
            'viewsObservedAt': views_observed_at,
            'duration': raw.get('duration'),
            'published': raw.get('upload_date') or raw.get('timestamp'),
            'sourceUrl': 'https://www.youtube.com/watch?v=' + video_id,
            'status': 'queued', 'attempts': 0,
        })
    name = str(info.get('channel') or info.get('uploader') or info.get('title') or url.rsplit('/', 1)[-1])[:100]
    return name, entries

def interactive_relay_waiting():
    try: return bool(list_json(REQ))
    except Exception: return False

def append_view_snapshot(video, views, observed_at):
    if views is None or observed_at is None: return
    try: numeric_views = int(views)
    except Exception: return
    history = list(video.get('viewsHistory') or [])
    snapshot = {'at': int(observed_at), 'views': numeric_views}
    if not history or history[-1].get('at') != snapshot['at'] or history[-1].get('views') != snapshot['views']:
        history.append(snapshot)
    video['viewsHistory'] = history[-64:]

def process_channel_request(key):
    request = get_json(key, {}) or {}
    channel_id = str(request.get('id') or '')
    url = str(request.get('url') or '')[:300]
    manifest_key = CHANNEL_ROOT + channel_id + '/manifest.json'
    if not re.match(r'^ch[a-f0-9]{16}$', channel_id) or not url:
        s3.delete_object(Bucket=BUCKET, Key=key)
        return
    manifest = get_json(manifest_key, {}) or {}
    if not manifest:
        manifest = {'version': 1, 'id': channel_id, 'url': url, 'name': url.rsplit('/', 1)[-1],
                    'createdAt': int(time.time() * 1000), 'videos': []}
    try:
        manifest.update({'status': 'running', 'phase': 'discovering', 'stopRequested': False,
                         'error': None, 'current': None, 'featureContractVersion': FEATURE_CONTRACT['version']})
        save_manifest(manifest)
        log('channel %s discovering %s' % (channel_id, url))
        name, discovered = discover_channel(url)
        old = {video.get('id'): video for video in (manifest.get('videos') or [])}
        merged = []
        for video in discovered:
            previous = old.pop(video['id'], None)
            if previous:
                if request.get('retryErrors') and previous.get('status') == 'error':
                    previous.update({'status': 'queued', 'error': None, 'attempts': 0})
                previous['title'] = video.get('title') or previous.get('title')
                if video.get('views') is not None:
                    if not previous.get('viewsHistory') and previous.get('views') is not None:
                        append_view_snapshot(previous, previous.get('views'), previous.get('viewsObservedAt') or previous.get('scoredAt'))
                    append_view_snapshot(previous, video.get('views'), video.get('viewsObservedAt'))
                    previous['views'] = video.get('views')
                    previous['viewsObservedAt'] = video.get('viewsObservedAt')
                if video.get('duration') is not None: previous['duration'] = video.get('duration')
                if video.get('published') is not None: previous['published'] = video.get('published')
                merged.append(previous)
            else:
                append_view_snapshot(video, video.get('views'), video.get('viewsObservedAt'))
                merged.append(video)
        merged.extend(old.values())
        manifest.update({'name': name or manifest.get('name'), 'videos': merged, 'phase': 'scoring'})
        save_manifest(manifest)
        log('channel %s found %d Shorts (%d already scored)' % (channel_id, len(merged), manifest.get('completed', 0)))

        registry = get_json('raw/indicators/registry.json', {}) or {}
        while True:
            candidate = next((video for video in (manifest.get('videos') or [])
                              if video.get('status') != 'done'
                              and not (video.get('status') == 'error' and int(video.get('attempts') or 0) >= 3)), None)
            if not candidate: break
            while interactive_relay_waiting():
                fresh = get_json(manifest_key, manifest) or manifest
                if fresh.get('stopRequested'): break
                time.sleep(3)
            manifest = get_json(manifest_key, manifest) or manifest
            if manifest.get('stopRequested'):
                manifest.update({'status': 'stopped', 'phase': 'stopped', 'current': None})
                save_manifest(manifest)
                log('channel %s stopped at %d/%d' % (channel_id, manifest.get('completed', 0), manifest.get('discovered', 0)))
                s3.delete_object(Bucket=BUCKET, Key=key)
                return
            video = next((item for item in manifest.get('videos', []) if item.get('id') == candidate.get('id')), None)
            if not video or video.get('status') == 'done': continue
            video['status'] = 'scoring'; video['attempts'] = int(video.get('attempts') or 0) + 1; video['error'] = None
            manifest.update({'status': 'running', 'phase': 'scoring', 'current': {'id': video['id'], 'title': video.get('title'), 'number': manifest.get('completed', 0) + manifest.get('failed', 0) + 1}})
            save_manifest(manifest)
            log('channel %s %d/%d score %s' % (channel_id, manifest.get('completed', 0) + 1, manifest.get('discovered', 0), video['id']))
            stop_state = {'checked': 0, 'value': False}
            def should_stop():
                if time.time() - stop_state['checked'] > 2:
                    stop_state['checked'] = time.time()
                    stop_state['value'] = bool((get_json(manifest_key, {}) or {}).get('stopRequested'))
                return stop_state['value']
            record = score_link(video.get('sourceUrl') or video['id'], video.get('title') or '', should_stop)
            manifest = get_json(manifest_key, manifest) or manifest
            video = next((item for item in manifest.get('videos', []) if item.get('id') == candidate.get('id')), None)
            if not video: continue
            if record.get('stopped'):
                video.update({'status': 'queued', 'error': None})
                manifest.update({'status': 'stopped', 'phase': 'stopped', 'current': None})
                save_manifest(manifest)
                log('channel %s stopped during %s' % (channel_id, video['id']))
                s3.delete_object(Bucket=BUCKET, Key=key)
                return
            if record.get('error'):
                video.update({'status': 'error', 'error': str(record['error'])[:300]})
                if video['attempts'] < 3:
                    video['status'] = 'queued'
                save_manifest(manifest)
                if video['status'] == 'queued': time.sleep(min(20, video['attempts'] * 5))
                continue

            montage = record.pop('montage', None)
            montage_saved = False
            montage_error = 'scorer did not return a montage'
            if montage:
                for upload_attempt in range(3):
                    try:
                        s3.put_object(Bucket=BUCKET, Key=CHANNEL_ROOT + channel_id + '/montages/' + video['id'] + '.jpg',
                                      Body=base64.b64decode(montage), ContentType='image/jpeg')
                        montage_saved = True
                        break
                    except Exception as exc:
                        montage_error = str(exc)[:220]
                        log('channel %s montage upload %s attempt %d: %s' % (channel_id, video['id'], upload_attempt + 1, str(exc)[:100]))
                        if upload_attempt < 2: time.sleep(2 ** upload_attempt)
            if not montage_saved:
                video.update({'status': 'error', 'error': 'stored image failed: ' + montage_error})
                if video['attempts'] < 3: video['status'] = 'queued'
                save_manifest(manifest)
                if video['status'] == 'queued': time.sleep(min(20, video['attempts'] * 5))
                continue
            record.update({'savedChannelId': channel_id, 'savedAt': int(time.time() * 1000), 'hasMontage': montage_saved})
            put_json(CHANNEL_ROOT + channel_id + '/videos/' + video['id'] + '.json', record)
            features = compact_features(record, registry)
            video.update({
                'status': 'done', 'error': None, 'title': str(record.get('sourceTitle') or record.get('title') or video.get('title') or video['id'])[:160],
                'views': record.get('sourceViews') if record.get('sourceViews') is not None else video.get('views'),
                'viewsObservedAt': video.get('viewsObservedAt') or int(time.time() * 1000),
                'duration': record.get('dur_s') or video.get('duration'), 'sourceUrl': record.get('sourceUrl') or video.get('sourceUrl'),
                'sourceChannel': record.get('sourceChannel') or manifest.get('name'), 'silent': bool(record.get('silent')),
                'published': record.get('sourcePublished') or video.get('published'),
                'subscribers': record.get('sourceSubscribers') if record.get('sourceSubscribers') is not None else video.get('subscribers'),
                'transcript': str(record.get('transcript') or '')[:300], 'hasMontage': montage_saved,
                'features': features, 'scoredAt': int(time.time() * 1000),
            })
            append_view_snapshot(video, video.get('views'), video.get('viewsObservedAt'))
            manifest['name'] = record.get('sourceChannel') or manifest.get('name')
            save_manifest(manifest)

        manifest = get_json(manifest_key, manifest) or manifest
        recount_manifest(manifest)
        terminal_status = 'done' if manifest.get('completed', 0) >= manifest.get('discovered', 0) else 'partial'
        manifest.update({'status': terminal_status, 'phase': terminal_status, 'current': None, 'stopRequested': False})
        save_manifest(manifest)
        try: s3.delete_object(Bucket=BUCKET, Key=CHANNEL_ROOT + channel_id + '/analysis.json')
        except Exception: pass
        log('channel %s %s: %d scored, %d unfinished' % (channel_id, terminal_status, manifest.get('completed', 0), manifest.get('failed', 0) + manifest.get('queued', 0)))
    except Exception as exc:
        manifest = get_json(manifest_key, manifest) or manifest
        manifest.update({'status': 'error', 'phase': 'error', 'current': None, 'error': str(exc)[:400]})
        save_manifest(manifest)
        log('channel %s ERROR %s' % (channel_id, str(exc)[:180]))
    finally:
        try: s3.delete_object(Bucket=BUCKET, Key=key)
        except Exception: pass

def channel_loop():
    log('saved-channel watcher up - polling %s' % CHANNEL_REQ)
    while True:
        try:
            keys = list_json(CHANNEL_REQ)
            if keys: process_channel_request(sorted(keys)[0])
        except Exception as exc:
            log('channel poll err: ' + str(exc)[:160])
        time.sleep(5)

def main():
    log('yt relay watcher up — polling %s' % REQ)
    threading.Thread(target=channel_loop, name='saved-channel-import', daemon=True).start()
    while True:
        try:
            keys = list_json(REQ)
            for k in keys:
                handle(k)
        except Exception as e:
            log('poll err: ' + str(e)[:120])
        time.sleep(5)

if __name__ == '__main__':
    main()
