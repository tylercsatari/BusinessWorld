#!/usr/bin/env python3
"""YouTube relay watcher — runs on Tyler's Mac (residential IP that YouTube trusts).

Render's datacenter IP is bot-blocked by YouTube, so the server can't download videos for
link-scoring. When it hits the block, it drops a request into R2 (shorts/yt-relay/requests/)
and this watcher — running here where YouTube is happy — acquires the source video and
uploads it to R2. Render then runs the same canonical raw_upload.py scorer used by device
uploads, so one-off link scoring cannot drift with the Mac's Python or model environment.

Installed as a launchd agent (com.businessworld.ytrelay) with KeepAlive — like the crawler,
it should always be running."""
import base64, hashlib, json, os, re, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import boto3
import raw_upload as raw_scorer
from shorts_score_ledger import (
    FEATURE_CONTRACT,
    feature_bundle_from_ledger,
    materialize_score_bundle,
    saved_channel_manifest_row_binding_payload,
    saved_channel_manifest_row_binding_sha256,
    score_record_binding_sha256,
    select_novelty_feature,
    stable_json_bytes,
)

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
CHANNEL_RECORD_ARTIFACT_ROOT = 'video-artifacts/by-sha256/'
CHANNEL_INDEX = CHANNEL_ROOT + 'index.json'
CHANNEL_INDEX_SCHEMA = 'saved-channel-navigation-index-v1'
CHANNEL_INDEX_VERSION = 1
CHANNEL_INDEX_ARCHIVE_ROOT = (
    CHANNEL_ROOT + 'indexes/by-artifact-sha256/'
)
CHANNEL_MANIFEST_KEY_RE = re.compile(
    r'^raw/saved-channels/(ch[a-f0-9]{16})/manifest\.json$'
)
CHANNEL_INDEX_AUTHORITY = {
    'artifactRole': 'non_authoritative_navigation',
    'canonicalManifestPattern':
        'raw/saved-channels/{channel_id}/manifest.json',
    'scoreAuthority': 'manifest-row score_ledger',
    'scoreAuthorityPath': 'manifest.videos[].score_ledger',
    'indexAuthoritative': False,
    'scoreValuesPresent': False,
}
CHANNEL_INDEX_KEYS = {
    'schema', 'version', 'updatedAt', 'authority', 'channels',
    'payloadSha256',
}
CHANNEL_INDEX_ENTRY_KEYS = {
    'id', 'manifestKey', 'manifestSha256', 'manifestBytes', 'url',
    'name', 'status', 'phase', 'createdAt', 'updatedAt', 'discovered',
    'completed', 'failed', 'integrityFailures', 'queued', 'current',
    'error',
}
CHANNEL_INDEX_CURRENT_KEYS = {'id', 'title', 'number'}
INDICATOR_REGISTRY_KEY = 'raw/indicators/registry.json'
_index_lock = threading.Lock()

def log(m):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), m), flush=True)

def get_json(key, default=None):
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except Exception:
        return default

def put_json(key, value):
    payload = stable_json_bytes(value)
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=payload,
        ContentType='application/json',
    )
    return payload


def saved_channel_record_artifact_key(channel_id, artifact_sha256):
    if not re.fullmatch(r'ch[a-f0-9]{16}', str(channel_id or '')):
        raise ValueError('saved-channel artifact channel ID is invalid')
    if not re.fullmatch(r'[a-f0-9]{64}', str(artifact_sha256 or '')):
        raise ValueError('saved-channel record artifact SHA-256 is invalid')
    return (
        CHANNEL_ROOT + channel_id + '/'
        + CHANNEL_RECORD_ARTIFACT_ROOT
        + artifact_sha256 + '.json'
    )


def put_immutable_bytes(key, payload, content_type='application/json'):
    body = bytes(payload)
    try:
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=body,
            ContentType=content_type,
            IfNoneMatch='*',
        )
    except Exception as exc:
        if not _r2_precondition_failed(exc):
            raise
    response = s3.get_object(Bucket=BUCKET, Key=key)
    readback = response['Body'].read()
    if readback != body:
        raise RuntimeError(
            'immutable saved-channel record artifact collision: ' + key
        )
    return body

def list_json(prefix):
    out, token = [], None
    while True:
        args = {'Bucket': BUCKET, 'Prefix': prefix}
        if token: args['ContinuationToken'] = token
        page = s3.list_objects_v2(**args)
        out += [obj['Key'] for obj in page.get('Contents', []) if obj['Key'].endswith('.json')]
        token = page.get('NextContinuationToken') if page.get('IsTruncated') else None
        if not token: return out

def score_link(url, title='', stop_check=None, creator_profile=''):
    args = [PY, os.path.join(HERE, 'raw_upload.py'), '--youtube', url]
    if title: args += ['--title', str(title)[:80]]
    profile = re.sub(r'[^a-z0-9_-]', '', str(creator_profile or '').lower())[:40]
    if profile:
        args += ['--creator-profile', profile]
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

def acquire_link(url, request_id):
    match = (
        re.search(
            r'(?:v=|youtu\.be/|/shorts/|/live/)([\w-]{11})',
            str(url or ''),
        )
        or re.search(r'^([\w-]{11})$', str(url or '').strip())
    )
    if not match:
        return {'error': 'relay: could not find a YouTube video id'}
    video_id = match.group(1)
    folder = tempfile.mkdtemp(prefix='rawyt_relay_')
    try:
        info, path, acquisition = raw_scorer.download_youtube_hook(
            video_id,
            folder,
        )
        extension = os.path.splitext(path)[1].lower() or '.mp4'
        if not re.fullmatch(r'\.[a-z0-9]{2,5}', extension):
            extension = '.mp4'
        video_key = (
            f'shorts/yt-relay/videos/{request_id}{extension}'
        )
        s3.upload_file(
            path,
            BUCKET,
            video_key,
            ExtraArgs={'ContentType': 'video/mp4'},
        )
        return {
            'relayVideoKey': video_key,
            'videoId': video_id,
            'sourceUrl': (
                f'https://www.youtube.com/watch?v={video_id}'
            ),
            'sourceTitle': str(info.get('title') or '')[:120],
            'sourceViews': info.get('view_count'),
            'sourceChannel': str(
                info.get('channel') or info.get('uploader') or ''
            )[:80],
            'sourcePublished': (
                info.get('upload_date') or info.get('timestamp')
            ),
            'sourceSubscribers': info.get('channel_follower_count'),
            'sourceDuration': info.get('duration'),
            'sourceAcquisition': acquisition,
        }
    except Exception as exc:
        return {'error': 'relay acquisition: ' + str(exc)[:240]}
    finally:
        import shutil
        shutil.rmtree(folder, ignore_errors=True)

def handle(key):
    rid = key.rsplit('/', 1)[-1][:-5]
    try:
        req = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except Exception:
        s3.delete_object(Bucket=BUCKET, Key=key)
        return
    url = str(req.get('url') or '')[:300]
    log('relay %s ← %s' % (rid, url))
    out = acquire_link(url, rid)
    out['expectedRevisionFingerprint'] = (
        req.get('expectedRevisionFingerprint') or None
    )
    out['relayedBy'] = 'mac'
    s3.put_object(Bucket=BUCKET, Key=RES + rid + '.json', Body=json.dumps(out).encode(), ContentType='application/json')
    s3.delete_object(Bucket=BUCKET, Key=key)
    log('relay %s → %s' % (rid, 'ERROR ' + out['error'][:80] if out.get('error') else 'ok'))

canonical_json_bytes = stable_json_bytes

def load_indicator_registry():
    response = s3.get_object(Bucket=BUCKET, Key=INDICATOR_REGISTRY_KEY)
    registry_bytes = response['Body'].read()
    registry_sha256 = hashlib.sha256(registry_bytes).hexdigest()
    registry = json.loads(registry_bytes)
    if not isinstance(registry, dict) or not isinstance(registry.get('indicators'), list):
        raise RuntimeError('indicator registry is malformed')
    revision = {
        'source': INDICATOR_REGISTRY_KEY,
        'sha256': registry_sha256,
        'bytes': len(registry_bytes),
    }
    etag = str(response.get('ETag') or '').strip('"')
    if etag: revision['etag'] = etag
    version_id = str(response.get('VersionId') or '')
    if version_id: revision['versionId'] = version_id
    last_modified = response.get('LastModified')
    if last_modified is not None:
        revision['lastModified'] = (
            last_modified.isoformat()
            if hasattr(last_modified, 'isoformat')
            else str(last_modified)
        )
    return registry, revision

def novelty_feature(record, registry, target):
    selected = select_novelty_feature(record, registry, target)
    if selected['value'] is None:
        return None
    return [selected['value'], selected['percentile']]

def compact_feature_bundle(record, registry, registry_revision):
    bundle = materialize_score_bundle(record, registry, registry_revision)
    return bundle['features'], bundle['novelty_provenance']

def compact_features(record, registry):
    return compact_feature_bundle(record, registry, None)[0]

manifest_row_binding_payload = (
    saved_channel_manifest_row_binding_payload
)
manifest_row_binding_sha256 = (
    saved_channel_manifest_row_binding_sha256
)

def scored_video_update(record, video, channel_name, montage_saved,
                        novelty_provenance, scored_at=None,
                        score_ledger=None,
                        record_artifact_sha256=None,
                        record_byte_length=None):
    input_manifest = record.get('input_manifest')
    canonical_montage = (
        input_manifest.get('canonical_montage')
        if isinstance(input_manifest, dict)
        else None
    )
    canonical_evidence = bool(
        montage_saved
        and isinstance(canonical_montage, dict)
        and canonical_montage.get('montage_sha256')
    )
    update = {
        'id': video.get('id'),
        'status': 'done',
        'error': None,
        'title': str(record.get('sourceTitle') or record.get('title') or video.get('title') or video['id'])[:160],
        'views': record.get('sourceViews') if record.get('sourceViews') is not None else video.get('views'),
        'viewsObservedAt': video.get('viewsObservedAt') or int(time.time() * 1000),
        'duration': record.get('dur_s') or video.get('duration'),
        'sourceUrl': record.get('sourceUrl') or video.get('sourceUrl'),
        'sourceChannel': record.get('sourceChannel') or channel_name,
        'silent': bool(record.get('silent')),
        'published': record.get('sourcePublished') or video.get('published'),
        'subscribers': record.get('sourceSubscribers') if record.get('sourceSubscribers') is not None else video.get('subscribers'),
        'transcript': str(record.get('transcript') or '')[:300],
        'hasMontage': montage_saved,
        'score_ledger': score_ledger or record.get('score_ledger'),
        'score_record_sha256': record.get('score_record_sha256'),
        'record_artifact_sha256': record_artifact_sha256,
        'record_byte_length': record_byte_length,
        'input_manifest': input_manifest,
        'novelty_provenance': novelty_provenance,
        'scoredAt': int(time.time() * 1000) if scored_at is None else int(scored_at),
        'evidence_state': (
            'canonical_bound'
            if canonical_evidence
            else 'historical_unbound_input'
        ),
        'canonical': canonical_evidence,
        'predictor_eligible': canonical_evidence,
        'evidence_warning': (
            None
            if canonical_evidence
            else (
                'The exact montage was not durably stored, so this '
                'score is display-only and excluded from fitting.'
            )
        ),
    }
    update['manifest_row_sha256'] = manifest_row_binding_sha256(update)
    return update

def _navigation_string(value, limit):
    if value is None or value == '':
        return None
    return value[:limit] if isinstance(value, str) else None


def _navigation_integer(value, fallback=0):
    if value is None or value == '' or isinstance(value, bool):
        return fallback
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if (
        not numeric.is_integer()
        or numeric < 0
        or numeric > 9007199254740991
    ):
        return fallback
    return int(numeric)


def _is_navigation_integer(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9007199254740991
    )


def _manifest_status_count(videos, statuses):
    accepted = set(statuses)
    return sum(
        1 for video in videos
        if isinstance(video, dict) and video.get('status') in accepted
    )


def _navigation_current(value):
    if not isinstance(value, dict):
        return None
    current = {
        'id': _navigation_string(value.get('id'), 80),
        'title': _navigation_string(value.get('title'), 200),
        'number': _navigation_integer(value.get('number')),
    }
    if (
        current['id'] is None
        and current['title'] is None
        and current['number'] == 0
    ):
        return None
    return current


def compact_channel(manifest, manifest_key=None, manifest_bytes=None):
    channel_id = str(manifest.get('id') or '')
    canonical_key = (
        manifest_key
        or CHANNEL_ROOT + channel_id + '/manifest.json'
    )
    match = CHANNEL_MANIFEST_KEY_RE.fullmatch(canonical_key)
    if not match:
        raise RuntimeError(
            'non-canonical saved-channel manifest key: ' + canonical_key
        )
    if channel_id != match.group(1):
        raise RuntimeError(
            'saved-channel manifest ID does not match its key: '
            + canonical_key
        )
    videos = manifest.get('videos')
    if not isinstance(videos, list):
        raise RuntimeError(
            'saved-channel manifest has no videos array: ' + canonical_key
        )
    if not isinstance(manifest_bytes, bytes) or not manifest_bytes:
        raise RuntimeError(
            'saved-channel manifest has no immutable bytes: ' + canonical_key
        )
    return {
        'id': channel_id,
        'manifestKey': canonical_key,
        'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'manifestBytes': len(manifest_bytes),
        'url': _navigation_string(manifest.get('url'), 500),
        'name': _navigation_string(manifest.get('name'), 200),
        'status': _navigation_string(manifest.get('status'), 80),
        'phase': _navigation_string(manifest.get('phase'), 80),
        'createdAt': _navigation_integer(manifest.get('createdAt')),
        'updatedAt': _navigation_integer(manifest.get('updatedAt')),
        'discovered': _navigation_integer(
            manifest.get('discovered'), len(videos)
        ),
        'completed': _navigation_integer(
            manifest.get('completed'),
            _manifest_status_count(videos, ('done',)),
        ),
        'failed': _navigation_integer(
            manifest.get('failed'),
            _manifest_status_count(videos, ('error',)),
        ),
        'integrityFailures': _navigation_integer(
            manifest.get('integrityFailures')
        ),
        'queued': _navigation_integer(
            manifest.get('queued'),
            _manifest_status_count(videos, ('queued', 'scoring')),
        ),
        'current': _navigation_current(manifest.get('current')),
        'error': _navigation_string(manifest.get('error'), 500),
    }


def _channel_index_payload(index):
    return {
        'schema': index.get('schema'),
        'version': index.get('version'),
        'updatedAt': index.get('updatedAt'),
        'authority': index.get('authority'),
        'channels': index.get('channels'),
    }


def build_channel_index(manifest_artifacts, updated_at=None):
    channels = [
        compact_channel(
            artifact['manifest'],
            artifact['key'],
            artifact['bytes'],
        )
        for artifact in manifest_artifacts
    ]
    channels.sort(key=lambda channel: (
        -channel['updatedAt'], channel['id']
    ))
    ids = [channel['id'] for channel in channels]
    duplicates = sorted({
        channel_id for channel_id in ids
        if ids.count(channel_id) > 1
    })
    if duplicates:
        raise RuntimeError(
            'duplicate saved-channel IDs: ' + ', '.join(duplicates)
        )
    generated_at = int(time.time() * 1000)
    index = {
        'schema': CHANNEL_INDEX_SCHEMA,
        'version': CHANNEL_INDEX_VERSION,
        'updatedAt': _navigation_integer(
            generated_at if updated_at is None else updated_at,
            generated_at,
        ),
        'authority': dict(CHANNEL_INDEX_AUTHORITY),
        'channels': channels,
        'payloadSha256': None,
    }
    index['payloadSha256'] = hashlib.sha256(
        stable_json_bytes(_channel_index_payload(index))
    ).hexdigest()
    validate_channel_index(index)
    return index


def validate_channel_index(index):
    errors = []
    if not isinstance(index, dict) or set(index) != CHANNEL_INDEX_KEYS:
        errors.append('index has non-canonical top-level fields')
    if not isinstance(index, dict):
        raise RuntimeError('; '.join(errors))
    if index.get('schema') != CHANNEL_INDEX_SCHEMA:
        errors.append('index schema is invalid')
    if index.get('version') != CHANNEL_INDEX_VERSION:
        errors.append('index version is invalid')
    if not _is_navigation_integer(index.get('updatedAt')):
        errors.append('index updatedAt is invalid')
    if index.get('authority') != CHANNEL_INDEX_AUTHORITY:
        errors.append(
            'index authority is not manifest-row score_ledger'
        )
    channels = index.get('channels')
    if not isinstance(channels, list):
        errors.append('index channels is not an array')
        channels = []
    ids = []
    manifest_keys = []
    for position, channel in enumerate(channels):
        prefix = 'channels[%d]' % position
        if (
            not isinstance(channel, dict)
            or set(channel) != CHANNEL_INDEX_ENTRY_KEYS
        ):
            errors.append(prefix + ' has non-canonical fields')
            continue
        channel_id = channel.get('id')
        if not re.fullmatch(r'ch[a-f0-9]{16}', str(channel_id or '')):
            errors.append(prefix + '.id is invalid')
        expected_key = (
            CHANNEL_ROOT + str(channel_id or '') + '/manifest.json'
        )
        if channel.get('manifestKey') != expected_key:
            errors.append(prefix + '.manifestKey is invalid')
        if not re.fullmatch(
            r'[a-f0-9]{64}', str(channel.get('manifestSha256') or '')
        ):
            errors.append(prefix + '.manifestSha256 is invalid')
        if (
            not _is_navigation_integer(channel.get('manifestBytes'))
            or channel.get('manifestBytes') <= 0
        ):
            errors.append(prefix + '.manifestBytes is invalid')
        for field in ('url', 'name', 'status', 'phase', 'error'):
            if (
                channel.get(field) is not None
                and not isinstance(channel.get(field), str)
            ):
                errors.append(prefix + '.' + field + ' is invalid')
        for field in (
            'createdAt', 'updatedAt', 'discovered', 'completed', 'failed',
            'integrityFailures', 'queued',
        ):
            if not _is_navigation_integer(channel.get(field)):
                errors.append(prefix + '.' + field + ' is invalid')
        current = channel.get('current')
        if (
            current is not None
            and (
                not isinstance(current, dict)
                or set(current) != CHANNEL_INDEX_CURRENT_KEYS
            )
        ):
            errors.append(prefix + '.current is invalid')
        elif current is not None:
            if (
                current.get('id') is not None
                and not isinstance(current.get('id'), str)
            ):
                errors.append(prefix + '.current.id is invalid')
            if (
                current.get('title') is not None
                and not isinstance(current.get('title'), str)
            ):
                errors.append(prefix + '.current.title is invalid')
            if not _is_navigation_integer(current.get('number')):
                errors.append(prefix + '.current.number is invalid')
        ids.append(channel_id)
        manifest_keys.append(channel.get('manifestKey'))
    duplicate_ids = sorted({
        channel_id for channel_id in ids
        if ids.count(channel_id) > 1
    })
    if duplicate_ids:
        errors.append(
            'duplicate channel IDs: ' + ', '.join(duplicate_ids)
        )
    duplicate_keys = sorted({
        key for key in manifest_keys if manifest_keys.count(key) > 1
    })
    if duplicate_keys:
        errors.append(
            'duplicate manifest keys: ' + ', '.join(duplicate_keys)
        )
    expected_order = sorted(
        channels,
        key=lambda channel: (
            -_navigation_integer(
                channel.get('updatedAt')
                if isinstance(channel, dict) else None
            ),
            str(
                (channel.get('id') or '')
                if isinstance(channel, dict) else ''
            ),
        ),
    )
    if channels != expected_order:
        errors.append('channels are not in canonical order')
    computed_sha256 = hashlib.sha256(
        stable_json_bytes(_channel_index_payload(index))
    ).hexdigest()
    if (
        not re.fullmatch(
            r'[a-f0-9]{64}', str(index.get('payloadSha256') or '')
        )
        or index.get('payloadSha256') != computed_sha256
    ):
        errors.append('payloadSha256 does not match canonical payload')
    if errors:
        raise RuntimeError('; '.join(errors))
    return {
        'valid': True,
        'channelCount': len(channels),
        'computedPayloadSha256': computed_sha256,
    }


def _load_channel_manifest_artifacts():
    artifacts = []
    for key in sorted(list_json(CHANNEL_ROOT)):
        if not CHANNEL_MANIFEST_KEY_RE.fullmatch(key):
            continue
        response = s3.get_object(Bucket=BUCKET, Key=key)
        manifest_bytes = response['Body'].read()
        if not manifest_bytes:
            raise RuntimeError(
                'canonical saved-channel manifest is empty: ' + key
            )
        try:
            manifest = json.loads(manifest_bytes)
        except Exception as exc:
            raise RuntimeError(
                'canonical saved-channel manifest is invalid: '
                + key + ': ' + str(exc)
            )
        artifacts.append({
            'key': key,
            'bytes': manifest_bytes,
            'manifest': manifest,
            'etag': response.get('ETag'),
        })
    return artifacts


def _r2_precondition_failed(exc):
    response = getattr(exc, 'response', {}) or {}
    metadata = response.get('ResponseMetadata') or {}
    code = str((response.get('Error') or {}).get('Code') or '')
    return (
        metadata.get('HTTPStatusCode') == 412
        or code in ('PreconditionFailed', 'ConditionalRequestConflict')
    )


def _r2_missing(exc):
    response = getattr(exc, 'response', {}) or {}
    metadata = response.get('ResponseMetadata') or {}
    code = str((response.get('Error') or {}).get('Code') or '')
    return (
        metadata.get('HTTPStatusCode') == 404
        or code in ('NoSuchKey', 'NotFound', '404')
    )


def _read_index_pointer_revision():
    try:
        response = s3.get_object(Bucket=BUCKET, Key=CHANNEL_INDEX)
        return response.get('ETag')
    except Exception as exc:
        response = getattr(exc, 'response', {}) or {}
        metadata = response.get('ResponseMetadata') or {}
        code = str((response.get('Error') or {}).get('Code') or '')
        if (
            metadata.get('HTTPStatusCode') == 404
            or code in ('NoSuchKey', 'NotFound', '404')
        ):
            return None
        raise


def _manifest_snapshot_is_current(artifacts):
    expected_keys = sorted(
        artifact['key'] for artifact in artifacts
    )
    current_keys = sorted(
        key
        for key in list_json(CHANNEL_ROOT)
        if CHANNEL_MANIFEST_KEY_RE.fullmatch(key)
    )
    if current_keys != expected_keys:
        return False
    for artifact in artifacts:
        response = s3.head_object(
            Bucket=BUCKET,
            Key=artifact['key'],
        )
        if response.get('ETag') != artifact.get('etag'):
            return False
    return True


def _put_immutable_channel_index(key, index_bytes):
    try:
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=index_bytes,
            ContentType='application/json',
            IfNoneMatch='*',
        )
    except Exception as exc:
        if not _r2_precondition_failed(exc):
            raise
    readback = s3.get_object(
        Bucket=BUCKET, Key=key
    )['Body'].read()
    if readback != index_bytes:
        raise RuntimeError(
            'saved-channel index read-after-write mismatch: ' + key
        )
    validate_channel_index(json.loads(readback))


def _put_channel_index_pointer(index_bytes, expected_etag):
    options = {
        'Bucket': BUCKET,
        'Key': CHANNEL_INDEX,
        'Body': index_bytes,
        'ContentType': 'application/json',
    }
    if expected_etag is None:
        options['IfNoneMatch'] = '*'
    else:
        options['IfMatch'] = expected_etag
    s3.put_object(**options)
    readback = s3.get_object(
        Bucket=BUCKET, Key=CHANNEL_INDEX
    )['Body'].read()
    if readback != index_bytes:
        raise RuntimeError(
            'saved-channel index read-after-write mismatch: '
            + CHANNEL_INDEX
        )
    validate_channel_index(json.loads(readback))


def rebuild_channel_index_from_manifests(updated_at=None, max_attempts=8):
    for attempt in range(max_attempts):
        expected_pointer_etag = _read_index_pointer_revision()
        artifacts = _load_channel_manifest_artifacts()
        index = build_channel_index(artifacts, updated_at=updated_at)
        index_bytes = stable_json_bytes(index)
        archive_key = (
            CHANNEL_INDEX_ARCHIVE_ROOT
            + hashlib.sha256(index_bytes).hexdigest()
            + '.json'
        )
        _put_immutable_channel_index(archive_key, index_bytes)
        if not _manifest_snapshot_is_current(artifacts):
            continue
        try:
            _put_channel_index_pointer(
                index_bytes,
                expected_pointer_etag,
            )
            if not _manifest_snapshot_is_current(artifacts):
                continue
            return index
        except Exception as exc:
            if not _r2_precondition_failed(exc):
                raise
        time.sleep(min(0.05 * (2 ** attempt), 1.0))
    raise RuntimeError(
        'saved-channel index changed repeatedly during compare-and-swap'
    )


def update_channel_index(manifest):
    with _index_lock:
        index = rebuild_channel_index_from_manifests()
        expected_id = str(manifest.get('id') or '')
        if not any(
            channel['id'] == expected_id
            for channel in index['channels']
        ):
            raise RuntimeError(
                'saved manifest is absent from rebuilt navigation index: '
                + expected_id
            )

def recount_manifest(manifest):
    videos = manifest.get('videos') or []
    manifest['discovered'] = len(videos)
    canonical_done = []
    integrity_failures = 0
    for video in videos:
        if video.get('status') != 'done':
            continue
        if _canonical_done_manifest_row(video):
            canonical_done.append(video)
        else:
            integrity_failures += 1
    manifest['completed'] = len(canonical_done)
    manifest['integrityFailures'] = integrity_failures
    manifest['failed'] = sum(1 for video in videos if video.get('status') == 'error')
    manifest['queued'] = sum(1 for video in videos if video.get('status') in ('queued', 'scoring'))
    manifest['updatedAt'] = int(time.time() * 1000)
    return manifest

def _read_manifest_revision(key):
    try:
        response = s3.get_object(Bucket=BUCKET, Key=key)
    except Exception as exc:
        if _r2_missing(exc):
            return None, None
        raise
    manifest_bytes = response['Body'].read()
    if not manifest_bytes:
        raise RuntimeError('saved-channel manifest is empty: ' + key)
    try:
        manifest = json.loads(manifest_bytes)
    except Exception as exc:
        raise RuntimeError(
            'saved-channel manifest is invalid: '
            + key + ': ' + str(exc)
        )
    return manifest, response.get('ETag')


def _manifest_control_revision(manifest):
    value = manifest.get('controlRevision') if isinstance(manifest, dict) else 0
    return value if isinstance(value, int) and value >= 0 else 0


def _canonical_done_manifest_row(video):
    if not isinstance(video, dict) or video.get('status') != 'done':
        return False
    try:
        feature_bundle_from_ledger(video.get('score_ledger'))
        binding = video.get('manifest_row_sha256')
        return bool(
            isinstance(binding, str)
            and binding == manifest_row_binding_sha256(video)
            and isinstance(video.get('score_record_sha256'), str)
            and re.fullmatch(
                r'[a-f0-9]{64}',
                video['score_record_sha256'],
            )
            and isinstance(
                video.get('record_artifact_sha256'),
                str,
            )
            and re.fullmatch(
                r'[a-f0-9]{64}',
                video['record_artifact_sha256'],
            )
            and isinstance(video.get('record_byte_length'), int)
            and video['record_byte_length'] > 0
        )
    except Exception:
        return False


def _merge_current_video_authority(candidate, current):
    """Keep canonical done rows from the newest manifest revision."""
    candidate_videos = (
        candidate.get('videos')
        if isinstance(candidate.get('videos'), list)
        else []
    )
    current_videos = (
        current.get('videos')
        if isinstance(current.get('videos'), list)
        else []
    )
    current_by_id = {
        str(video.get('id')): video
        for video in current_videos
        if isinstance(video, dict) and video.get('id')
    }
    merged = []
    seen = set()
    discovery_fields = (
        'title',
        'views',
        'viewsObservedAt',
        'viewsHistory',
        'duration',
        'published',
        'sourceUrl',
    )
    for candidate_video in candidate_videos:
        if not isinstance(candidate_video, dict):
            continue
        video_id = str(candidate_video.get('id') or '')
        if not video_id:
            continue
        current_video = current_by_id.get(video_id)
        if _canonical_done_manifest_row(current_video):
            next_video = json.loads(json.dumps(current_video))
            for field in discovery_fields:
                if field in candidate_video:
                    next_video[field] = candidate_video[field]
            next_video['manifest_row_sha256'] = (
                manifest_row_binding_sha256(next_video)
            )
        else:
            next_video = json.loads(json.dumps(candidate_video))
        merged.append(next_video)
        seen.add(video_id)
    merged.extend(
        json.loads(json.dumps(video))
        for video in current_videos
        if (
            isinstance(video, dict)
            and str(video.get('id') or '')
            and str(video.get('id')) not in seen
        )
    )
    candidate['videos'] = merged
    return candidate


def _merge_newer_manifest_control(candidate, current):
    if not isinstance(current, dict):
        return candidate
    if current.get('id') != candidate.get('id'):
        raise RuntimeError('saved-channel manifest ID changed during write')
    candidate = _merge_current_video_authority(
        candidate,
        current,
    )
    current_revision = _manifest_control_revision(current)
    candidate_revision = _manifest_control_revision(candidate)
    if current_revision <= candidate_revision:
        return candidate
    for field in (
        'controlRevision',
        'controlIntent',
        'controlUpdatedAt',
        'stopRequested',
        'resumeRequestedAt',
        'status',
        'phase',
        'current',
        'error',
    ):
        if field in current:
            candidate[field] = current[field]
        else:
            candidate.pop(field, None)
    return candidate


def save_manifest(manifest, max_attempts=8):
    key = CHANNEL_ROOT + manifest['id'] + '/manifest.json'
    candidate = json.loads(json.dumps(manifest))
    for attempt in range(max_attempts):
        current, expected_etag = _read_manifest_revision(key)
        next_manifest = _merge_newer_manifest_control(
            json.loads(json.dumps(candidate)),
            current,
        )
        recount_manifest(next_manifest)
        manifest_bytes = stable_json_bytes(next_manifest)
        options = {
            'Bucket': BUCKET,
            'Key': key,
            'Body': manifest_bytes,
            'ContentType': 'application/json',
        }
        if expected_etag is None:
            options['IfNoneMatch'] = '*'
        else:
            options['IfMatch'] = expected_etag
        try:
            written = s3.put_object(**options)
        except Exception as exc:
            if not _r2_precondition_failed(exc):
                raise
            time.sleep(min(0.05 * (2 ** attempt), 1.0))
            continue
        written_etag = written.get('ETag')
        try:
            verified = s3.get_object(
                Bucket=BUCKET,
                Key=key,
                IfMatch=written_etag,
            )
            verified_bytes = verified['Body'].read()
        except Exception as exc:
            if _r2_precondition_failed(exc):
                latest, _ = _read_manifest_revision(key)
                update_channel_index(latest)
                return latest
            raise
        if verified_bytes != manifest_bytes:
            raise RuntimeError(
                'saved-channel manifest failed exact read-after-write '
                + 'verification: ' + key
            )
        update_channel_index(next_manifest)
        return next_manifest
    raise RuntimeError(
        'saved-channel manifest changed repeatedly during compare-and-swap: '
        + key
    )

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
        manifest = save_manifest(manifest)
        log('channel %s discovering %s' % (channel_id, url))
        name, discovered = discover_channel(url)
        old = {video.get('id'): video for video in (manifest.get('videos') or [])}
        merged = []
        for video in discovered:
            previous = old.pop(video['id'], None)
            if previous:
                prior_manifest_binding = previous.get('manifest_row_sha256')
                prior_manifest_binding_valid = (
                    isinstance(prior_manifest_binding, str)
                    and prior_manifest_binding
                    == manifest_row_binding_sha256(previous)
                )
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
                if prior_manifest_binding_valid:
                    previous['manifest_row_sha256'] = (
                        manifest_row_binding_sha256(previous)
                    )
                merged.append(previous)
            else:
                append_view_snapshot(video, video.get('views'), video.get('viewsObservedAt'))
                merged.append(video)
        merged.extend(old.values())
        manifest.update({'name': name or manifest.get('name'), 'videos': merged, 'phase': 'scoring'})
        manifest = save_manifest(manifest)
        log(
            'channel %s found %d Shorts (%d canonical scores, %d integrity failures)'
            % (
                channel_id,
                len(merged),
                manifest.get('completed', 0),
                manifest.get('integrityFailures', 0),
            )
        )

        registry, registry_revision = load_indicator_registry()
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
                manifest = save_manifest(manifest)
                log('channel %s stopped at %d/%d' % (channel_id, manifest.get('completed', 0), manifest.get('discovered', 0)))
                s3.delete_object(Bucket=BUCKET, Key=key)
                return
            video = next((item for item in manifest.get('videos', []) if item.get('id') == candidate.get('id')), None)
            if not video or video.get('status') == 'done': continue
            video['status'] = 'scoring'; video['attempts'] = int(video.get('attempts') or 0) + 1; video['error'] = None
            if isinstance(video.get('ledgerRepair'), dict):
                video['ledgerRepair']['status'] = 'scoring'
            manifest.update({'status': 'running', 'phase': 'scoring', 'current': {'id': video['id'], 'title': video.get('title'), 'number': manifest.get('completed', 0) + manifest.get('failed', 0) + 1}})
            manifest = save_manifest(manifest)
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
                manifest = save_manifest(manifest)
                log('channel %s stopped during %s' % (channel_id, video['id']))
                s3.delete_object(Bucket=BUCKET, Key=key)
                return
            if record.get('error'):
                video.update({'status': 'error', 'error': str(record['error'])[:300]})
                if video['attempts'] < 3:
                    video['status'] = 'queued'
                manifest = save_manifest(manifest)
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
                manifest = save_manifest(manifest)
                if video['status'] == 'queued': time.sleep(min(20, video['attempts'] * 5))
                continue
            record.update({
                'id': video['id'],
                'savedChannelVideoId': video['id'],
                'savedChannelId': channel_id,
                'savedAt': int(time.time() * 1000),
                'hasMontage': montage_saved,
            })
            if record.get('score_ledger'):
                persisted_bundle = feature_bundle_from_ledger(
                    record['score_ledger']
                )
                features = persisted_bundle['features']
                novelty_provenance = (
                    record.get('novelty_provenance')
                    or persisted_bundle['novelty_provenance']
                )
            else:
                generated_bundle = materialize_score_bundle(
                    record,
                    registry,
                    registry_revision,
                )
                features = generated_bundle['features']
                novelty_provenance = generated_bundle[
                    'novelty_provenance'
                ]
                record['steer'] = generated_bundle['addressed_steer']
                record['score_ledger'] = generated_bundle['score_ledger']
            record['novelty_provenance'] = novelty_provenance
            # The canonical ledger owns persisted scalar scores. The scorer's
            # denormalized caches are checked before this boundary and then
            # discarded so saved-channel records cannot drift into two truths.
            record.pop('steer', None)
            record.pop('features', None)
            record['score_record_sha256'] = score_record_binding_sha256(
                record
            )
            record_bytes = stable_json_bytes(record)
            record_artifact_sha256 = hashlib.sha256(
                record_bytes
            ).hexdigest()
            put_immutable_bytes(
                saved_channel_record_artifact_key(
                    channel_id,
                    record_artifact_sha256,
                ),
                record_bytes,
            )
            video.update(scored_video_update(
                record,
                video,
                manifest.get('name'),
                montage_saved,
                novelty_provenance,
                score_ledger=record.get('score_ledger'),
                record_artifact_sha256=record_artifact_sha256,
                record_byte_length=len(record_bytes),
            ))
            if isinstance(video.get('ledgerRepair'), dict):
                video['ledgerRepair']['status'] = 'completed'
                video['ledgerRepair']['completedAt'] = int(time.time() * 1000)
            append_view_snapshot(video, video.get('views'), video.get('viewsObservedAt'))
            manifest['name'] = record.get('sourceChannel') or manifest.get('name')
            manifest = save_manifest(manifest)

        manifest = get_json(manifest_key, manifest) or manifest
        recount_manifest(manifest)
        terminal_status = 'done' if manifest.get('completed', 0) >= manifest.get('discovered', 0) else 'partial'
        manifest.update({'status': terminal_status, 'phase': terminal_status, 'current': None, 'stopRequested': False})
        manifest = save_manifest(manifest)
        try: s3.delete_object(Bucket=BUCKET, Key=CHANNEL_ROOT + channel_id + '/analysis.json')
        except Exception: pass
        log('channel %s %s: %d scored, %d unfinished' % (channel_id, terminal_status, manifest.get('completed', 0), manifest.get('failed', 0) + manifest.get('queued', 0)))
    except Exception as exc:
        manifest = get_json(manifest_key, manifest) or manifest
        manifest.update({'status': 'error', 'phase': 'error', 'current': None, 'error': str(exc)[:400]})
        manifest = save_manifest(manifest)
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
