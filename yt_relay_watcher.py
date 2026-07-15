#!/usr/bin/env python3
"""YouTube relay watcher — runs on Tyler's Mac (residential IP that YouTube trusts).

Render's datacenter IP is bot-blocked by YouTube, so the server can't download videos for
link-scoring. When it hits the block, it drops a request into R2 (shorts/yt-relay/requests/)
and this watcher — running here where YouTube is happy — downloads the video, runs the FULL
raw_upload.py scoring pipeline locally (frames + whisper transcript + embeds + steers), and
uploads the finished record to shorts/yt-relay/results/ for the server's job to return.

Installed as a launchd agent (com.businessworld.ytrelay) with KeepAlive — like the crawler,
it should always be running."""
import json, os, subprocess, sys, time

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

def log(m):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), m), flush=True)

def handle(key):
    rid = key.rsplit('/', 1)[-1][:-5]
    try:
        req = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except Exception:
        s3.delete_object(Bucket=BUCKET, Key=key)
        return
    url = str(req.get('url') or '')[:300]
    log('relay %s ← %s' % (rid, url))
    args = [PY, os.path.join(HERE, 'raw_upload.py'), '--youtube', url]
    if req.get('title'): args += ['--title', str(req['title'])[:80]]
    out = {'error': 'relay produced no output'}
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=420)
        line = [l for l in (r.stdout or '').strip().splitlines() if l.strip().startswith('{')]
        out = json.loads(line[-1]) if line else {'error': 'relay: no JSON — ' + (r.stderr or '')[-160:]}
    except subprocess.TimeoutExpired:
        out = {'error': 'relay: download + scoring exceeded 7 minutes'}
    except Exception as e:
        out = {'error': 'relay: ' + str(e)[:200]}
    out['relayedBy'] = 'mac'
    s3.put_object(Bucket=BUCKET, Key=RES + rid + '.json', Body=json.dumps(out).encode(), ContentType='application/json')
    s3.delete_object(Bucket=BUCKET, Key=key)
    log('relay %s → %s' % (rid, 'ERROR ' + out['error'][:80] if out.get('error') else 'ok'))

def main():
    log('yt relay watcher up — polling %s' % REQ)
    while True:
        try:
            keys = [o['Key'] for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=REQ).get('Contents', []) if o['Key'].endswith('.json')]
            for k in keys:
                handle(k)
        except Exception as e:
            log('poll err: ' + str(e)[:120])
        time.sleep(5)

if __name__ == '__main__':
    main()
