#!/usr/bin/env python3
import base64
import copy
import hashlib
import io
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import yt_relay_watcher as worker


def artifact(channel_id, updated_at):
    manifest = {
        'version': 1,
        'id': channel_id,
        'url': 'https://www.youtube.com/@' + channel_id,
        'name': 'Channel ' + channel_id,
        'status': 'running',
        'phase': 'scoring',
        'createdAt': 1000,
        'updatedAt': updated_at,
        'discovered': 2,
        'completed': 1,
        'failed': 0,
        'integrityFailures': 0,
        'queued': 1,
        'current': {
            'id': 'abcdefghijk',
            'title': 'Current video',
            'number': 2,
        },
        'error': None,
        'videos': [
            {
                'id': 'abcdefghijk',
                'status': 'done',
                'score_ledger': {
                    'values': [97.25, 55000000],
                    'ledger_sha256': 'a' * 64,
                },
            },
            {'id': 'lmnopqrstuv', 'status': 'queued'},
        ],
    }
    manifest_bytes = json.dumps(
        manifest, separators=(',', ':'), ensure_ascii=False
    ).encode('utf-8')
    return {
        'key': (
            'raw/saved-channels/' + channel_id + '/manifest.json'
        ),
        'manifest': manifest,
        'bytes': manifest_bytes,
    }


first = artifact('ch0000000000000001', 2000)
second = artifact('ch0000000000000002', 3000)
index = worker.build_channel_index(
    [first, second], updated_at=4000
)
assert worker.validate_channel_index(index)['valid'] is True
assert index['schema'] == worker.CHANNEL_INDEX_SCHEMA
assert index['version'] == worker.CHANNEL_INDEX_VERSION
assert index['authority'] == worker.CHANNEL_INDEX_AUTHORITY
assert [row['id'] for row in index['channels']] == [
    'ch0000000000000002',
    'ch0000000000000001',
]
serialized = worker.stable_json_bytes(index)
assert b'55000000' not in serialized
assert b'97.25' not in serialized
assert b'score_ledger' in serialized
assert b'manifest-row score_ledger' in serialized

duplicate = copy.deepcopy(first)
try:
    worker.build_channel_index(
        [first, duplicate], updated_at=4000
    )
    raise AssertionError('duplicate channel ID was accepted')
except RuntimeError as error:
    assert 'duplicate saved-channel IDs' in str(error)

injected = copy.deepcopy(index)
injected['channels'][0]['predictedKeep'] = 97.25
try:
    worker.validate_channel_index(injected)
    raise AssertionError('numeric score injection was accepted')
except RuntimeError as error:
    assert 'non-canonical fields' in str(error)

malformed = copy.deepcopy(index)
malformed['channels'] = [None]
try:
    worker.validate_channel_index(malformed)
    raise AssertionError('malformed channel entry was accepted')
except RuntimeError as error:
    assert 'non-canonical fields' in str(error)

node_input = {
    'updatedAt': 4000,
    'artifacts': [
        {
            'key': item['key'],
            'manifest': item['manifest'],
            'bytesBase64': base64.b64encode(
                item['bytes']
            ).decode('ascii'),
        }
        for item in [first, second]
    ],
}
node_source = r"""
const fs = require('fs');
const contract = require('./buildings/jarvis/saved-channel-index-contract');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const artifacts = input.artifacts.map(item => ({
  key: item.key,
  manifest: item.manifest,
  bytes: Buffer.from(item.bytesBase64, 'base64'),
}));
const index = contract.buildSavedChannelIndex(artifacts, {
  updatedAt: input.updatedAt,
});
process.stdout.write(contract.canonicalIndexBytes(index).toString('base64'));
"""
node_result = subprocess.run(
    ['node', '-e', node_source],
    cwd=ROOT,
    input=json.dumps(node_input).encode('utf-8'),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=True,
)
assert (
    base64.b64decode(node_result.stdout)
    == worker.stable_json_bytes(index)
), node_result.stderr.decode('utf-8')


class FakeS3:
    def __init__(
        self,
        artifacts,
        conflict_once=False,
        manifest_conflict_once=False,
        manifest_after_index_once=False,
    ):
        self.objects = {
            item['key']: item['bytes'] for item in artifacts
        }
        self.objects[worker.CHANNEL_INDEX] = b'{"legacy":true}'
        self.objects[
            worker.CHANNEL_INDEX_ARCHIVE_ROOT + 'old.json'
        ] = b'{}'
        self.puts = []
        self.conflict_once = conflict_once
        self.manifest_conflict_once = manifest_conflict_once
        self.manifest_after_index_once = (
            manifest_after_index_once
        )

    def etag(self, key):
        return '"' + hashlib.md5(
            self.objects[key],
            usedforsecurity=False,
        ).hexdigest() + '"'

    def list_objects_v2(self, **kwargs):
        prefix = kwargs.get('Prefix', '')
        return {
            'Contents': [
                {'Key': key}
                for key in sorted(self.objects)
                if key.startswith(prefix)
            ],
            'IsTruncated': False,
        }

    def get_object(self, **kwargs):
        key = kwargs['Key']
        if key not in self.objects:
            error = RuntimeError('not found')
            error.response = {
                'ResponseMetadata': {'HTTPStatusCode': 404},
                'Error': {'Code': 'NoSuchKey'},
            }
            raise error
        expected = kwargs.get('IfMatch')
        if expected is not None and self.etag(key) != expected:
            error = RuntimeError('precondition failed')
            error.response = {
                'ResponseMetadata': {'HTTPStatusCode': 412},
                'Error': {'Code': 'PreconditionFailed'},
            }
            raise error
        return {
            'Body': io.BytesIO(self.objects[key]),
            'ETag': self.etag(key),
        }

    def head_object(self, **kwargs):
        return {'ETag': self.etag(kwargs['Key'])}

    def put_object(self, **kwargs):
        key = kwargs['Key']
        if self.conflict_once and key == worker.CHANNEL_INDEX:
            self.objects[key] = b'{"concurrent":true}'
            self.conflict_once = False
        if (
            self.manifest_conflict_once
            and worker.CHANNEL_MANIFEST_KEY_RE.fullmatch(key)
        ):
            current = json.loads(self.objects[key])
            current.update({
                'controlRevision': 2,
                'controlIntent': 'stop',
                'controlUpdatedAt': 9999,
                'stopRequested': True,
                'status': 'stopping',
                'phase': 'stopping',
            })
            self.objects[key] = worker.stable_json_bytes(
                current
            )
            self.manifest_conflict_once = False
        expected = kwargs.get('IfMatch')
        create_only = kwargs.get('IfNoneMatch')
        if (
            (expected is not None and (
                key not in self.objects
                or self.etag(key) != expected
            ))
            or (create_only == '*' and key in self.objects)
        ):
            error = RuntimeError('precondition failed')
            error.response = {
                'ResponseMetadata': {'HTTPStatusCode': 412},
                'Error': {'Code': 'PreconditionFailed'},
            }
            raise error
        body = kwargs['Body']
        if hasattr(body, 'read'):
            body = body.read()
        self.objects[key] = bytes(body)
        self.puts.append(key)
        if (
            self.manifest_after_index_once
            and key == worker.CHANNEL_INDEX
        ):
            manifest_key = sorted(
                object_key
                for object_key in self.objects
                if worker.CHANNEL_MANIFEST_KEY_RE.fullmatch(
                    object_key
                )
            )[0]
            changed = json.loads(self.objects[manifest_key])
            changed['updatedAt'] = (
                int(changed.get('updatedAt') or 0) + 1
            )
            self.objects[manifest_key] = (
                worker.stable_json_bytes(changed)
            )
            self.manifest_after_index_once = False
        return {'ETag': self.etag(key)}


original_s3 = worker.s3
try:
    fake_s3 = FakeS3([first, second])
    worker.s3 = fake_s3
    rebuilt = worker.rebuild_channel_index_from_manifests(
        updated_at=5000
    )
finally:
    worker.s3 = original_s3

assert worker.validate_channel_index(rebuilt)['valid'] is True
assert len(fake_s3.puts) == 2
assert fake_s3.puts[0] == (
    worker.CHANNEL_INDEX_ARCHIVE_ROOT
    + hashlib.sha256(
        worker.stable_json_bytes(rebuilt)
    ).hexdigest()
    + '.json'
)
assert fake_s3.puts[1] == worker.CHANNEL_INDEX
assert fake_s3.objects[fake_s3.puts[0]] == (
    fake_s3.objects[worker.CHANNEL_INDEX]
)

try:
    conflict_s3 = FakeS3([first, second], conflict_once=True)
    worker.s3 = conflict_s3
    conflict_rebuilt = worker.rebuild_channel_index_from_manifests(
        updated_at=5001
    )
finally:
    worker.s3 = original_s3

assert worker.validate_channel_index(conflict_rebuilt)['valid'] is True
assert conflict_s3.objects[worker.CHANNEL_INDEX] == (
    worker.stable_json_bytes(conflict_rebuilt)
)
assert conflict_s3.puts.count(worker.CHANNEL_INDEX) == 1

try:
    post_write_s3 = FakeS3(
        [first, second],
        manifest_after_index_once=True,
    )
    worker.s3 = post_write_s3
    post_write_rebuilt = (
        worker.rebuild_channel_index_from_manifests(
            updated_at=5002
        )
    )
finally:
    worker.s3 = original_s3

assert post_write_s3.puts.count(worker.CHANNEL_INDEX) == 2
assert post_write_s3.objects[worker.CHANNEL_INDEX] == (
    worker.stable_json_bytes(post_write_rebuilt)
)
assert worker.validate_channel_index(
    post_write_rebuilt
)['valid'] is True

candidate = copy.deepcopy(first['manifest'])
candidate.update({
    'controlRevision': 1,
    'controlIntent': 'run',
    'controlUpdatedAt': 9000,
    'stopRequested': False,
    'status': 'running',
    'phase': 'scoring',
})
candidate['videos'][1]['status'] = 'scoring'
try:
    manifest_s3 = FakeS3(
        [first, second],
        manifest_conflict_once=True,
    )
    worker.s3 = manifest_s3
    saved_manifest = worker.save_manifest(candidate)
finally:
    worker.s3 = original_s3

assert saved_manifest['controlRevision'] == 2
assert saved_manifest['controlIntent'] == 'stop'
assert saved_manifest['stopRequested'] is True
assert saved_manifest['status'] == 'stopping'
assert saved_manifest['videos'][1]['status'] == 'scoring'
assert worker.validate_channel_index(
    json.loads(manifest_s3.objects[worker.CHANNEL_INDEX])
)['valid'] is True

candidate_authority = {
    'id': 'abcdefghijk',
    'videos': [{
        'id': 'abcdefghijk',
        'status': 'done',
        'title': 'Fresh discovery title',
        'views': 900,
        'viewsObservedAt': 9000,
        'score_ledger': {
            'ledger_sha256': 'a' * 64,
        },
        'score_record_sha256': 'a' * 64,
        'record_artifact_sha256': 'a' * 64,
        'record_byte_length': 100,
        'manifest_row_sha256': 'a' * 64,
    }],
}
current_authority = {
    'id': 'abcdefghijk',
    'videos': [{
        'id': 'abcdefghijk',
        'status': 'done',
        'title': 'Bound title',
        'views': 500,
        'viewsObservedAt': 5000,
        'score_ledger': {
            'ledger_sha256': 'b' * 64,
        },
        'score_record_sha256': 'b' * 64,
        'record_artifact_sha256': 'b' * 64,
        'record_byte_length': 200,
        'manifest_row_sha256': 'b' * 64,
    }],
}
original_canonical_done = worker._canonical_done_manifest_row
try:
    worker._canonical_done_manifest_row = (
        lambda video: bool(
            isinstance(video, dict)
            and video.get('score_record_sha256') == 'b' * 64
        )
    )
    merged_authority = worker._merge_newer_manifest_control(
        copy.deepcopy(candidate_authority),
        copy.deepcopy(current_authority),
    )
finally:
    worker._canonical_done_manifest_row = original_canonical_done

merged_row = merged_authority['videos'][0]
assert merged_row['score_ledger']['ledger_sha256'] == 'b' * 64
assert merged_row['score_record_sha256'] == 'b' * 64
assert merged_row['record_artifact_sha256'] == 'b' * 64
assert merged_row['record_byte_length'] == 200
assert merged_row['title'] == 'Fresh discovery title'
assert merged_row['views'] == 900
assert merged_row['viewsObservedAt'] == 9000
assert merged_row['manifest_row_sha256'] == (
    worker.manifest_row_binding_sha256(merged_row)
)

print(json.dumps({
    'ok': True,
    'schema': index['schema'],
    'channels': len(index['channels']),
    'payloadSha256': index['payloadSha256'],
    'crossLanguageCanonicalBytes': True,
    'readAfterWriteVerified': True,
    'compareAndSwapRetryVerified': True,
    'postWriteManifestRaceRetried': True,
    'manifestControlConflictPreserved': True,
    'canonicalScoreAuthorityPreserved': True,
}, separators=(',', ':')))
