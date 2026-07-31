#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contract = require('../buildings/jarvis/saved-channel-index-contract');

const root = path.join(__dirname, '..');
const watcher = fs.readFileSync(
    path.join(root, 'yt_relay_watcher.py'),
    'utf8'
);
const migration = fs.readFileSync(
    path.join(root, 'scripts', 'rebuild-saved-channel-index.js'),
    'utf8'
);
const casSource = fs.readFileSync(
    path.join(
        root,
        'buildings',
        'jarvis',
        'r2-json-cas.js'
    ),
    'utf8'
);
const contractSource = fs.readFileSync(
    path.join(
        root,
        'buildings',
        'jarvis',
        'saved-channel-index-contract.js'
    ),
    'utf8'
);
const server = fs.readFileSync(
    path.join(root, 'server.js'),
    'utf8'
);

assert.strictEqual(
    watcher.includes('get_json(CHANNEL_INDEX'),
    false,
    'the worker must not merge against the navigation index'
);
assert.strictEqual(
    watcher.includes('channels.append(compact_channel(manifest))'),
    false,
    'the worker must rebuild from canonical manifests'
);
assert.match(
    watcher,
    /def rebuild_channel_index_from_manifests\(/
);
assert.match(
    watcher,
    /_put_immutable_channel_index\(archive_key, index_bytes\)[\s\S]*_manifest_snapshot_is_current\(artifacts\)[\s\S]*_put_channel_index_pointer\([\s\S]*index_bytes,[\s\S]*expected_pointer_etag/
);
assert.match(
    watcher,
    /def _put_immutable_channel_index\([\s\S]*IfNoneMatch='\*'/
);
assert.match(
    watcher,
    /def _put_channel_index_pointer\([\s\S]*options\['IfNoneMatch'\] = '\*'[\s\S]*options\['IfMatch'\] = expected_etag/
);
assert.match(
    watcher,
    /def rebuild_channel_index_from_manifests\(updated_at=None, max_attempts=8\):[\s\S]*for attempt in range\(max_attempts\):[\s\S]*_r2_precondition_failed\(exc\)/
);
assert.match(
    watcher,
    /def save_manifest\(manifest, max_attempts=8\):[\s\S]*for attempt in range\(max_attempts\):[\s\S]*options\['IfNoneMatch'\] = '\*'[\s\S]*options\['IfMatch'\] = expected_etag[\s\S]*s3\.put_object\(\*\*options\)[\s\S]*update_channel_index\(next_manifest\)/,
    'the canonical manifest must use CAS and publish before deriving the index'
);
assert.match(
    watcher,
    /def _merge_newer_manifest_control\([\s\S]*current_revision <= candidate_revision[\s\S]*'controlRevision'[\s\S]*'stopRequested'[\s\S]*'status'/
);
assert.match(
    server,
    /const savedChannelIndexCas = createR2JsonCasMutator\(\{[\s\S]*key: SAVED_CHANNEL_INDEX_KEY[\s\S]*canonicalIndexBytes/
);
assert.match(
    server,
    /const savedChannelManifestCasById = new Map\(\);[\s\S]*createR2JsonCasMutator\(\{[\s\S]*saved-channel manifest/
);
assert.match(
    server,
    /function advanceSavedChannelControl\([\s\S]*controlRevision[\s\S]*controlIntent/
);
assert.match(
    server,
    /action === 'stop'[\s\S]*mutateSavedChannelManifest\([\s\S]*action === 'resume'[\s\S]*mutateSavedChannelManifest\(/
);
assert.strictEqual(
    server.includes('function writeSavedChannelManifest('),
    false,
    'server controls must mutate the current canonical manifest with CAS'
);

assert.match(
    migration,
    /\.filter\(isCanonicalManifestKey\)/
);
assert.match(
    migration,
    /createR2JsonCasMutator\([\s\S]*assertManifestSnapshotCurrent\(storage, artifacts\)/
);
assert.match(
    migration,
    /by-artifact-sha256/
);
assert.match(
    migration,
    /putImmutableIndexArtifact\([\s\S]*ifNoneMatch: '\*'/
);
assert.match(
    casSource,
    /ifMatch: revision\.etag[\s\S]*ifNoneMatch: '\*'[\s\S]*failed exact read-after-write verification/
);
assert.match(
    casSource,
    /canonicalJsonBytes/
);

assert.strictEqual(
    contract.SCORE_AUTHORITY.scoreAuthority,
    'manifest-row score_ledger'
);
assert.strictEqual(
    contract.SCORE_AUTHORITY.indexAuthoritative,
    false
);
assert.strictEqual(
    contract.SCORE_AUTHORITY.scoreValuesPresent,
    false
);
for (const forbidden of [
    'views',
    'features',
    'score_ledger',
    'score',
    'percentile',
    'prediction',
    'keep',
    'retention',
]) {
    assert.strictEqual(
        contract.CHANNEL_KEYS.includes(forbidden),
        false,
        `${forbidden} must not be an index-entry field`
    );
}
assert.strictEqual(
    /require\(['"].*server/.test(contractSource),
    false
);
assert.strictEqual(
    /jarvis-retention/.test(
        `${contractSource}\n${migration}`
    ),
    false
);

process.stdout.write(JSON.stringify({
    ok: true,
    workerRebuildsFromManifests: true,
    migrationReadAfterWrite: true,
    navigationFields: contract.CHANNEL_KEYS.length,
    scoreAuthority:
        contract.SCORE_AUTHORITY.scoreAuthority,
}) + '\n');
