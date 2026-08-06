#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const value = line.trim();
        if (!value || value.startsWith('#')) return;
        const equals = value.indexOf('=');
        if (equals > 0 && process.env[value.slice(0, equals).trim()] == null) {
            process.env[value.slice(0, equals).trim()] = value
                .slice(equals + 1)
                .trim();
        }
    });
}

const cloud = require('../cloud-storage');
const elite = require('../buildings/jarvis/elite-hook-explorer');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');

async function requiredJson(key) {
    const bytes = await cloud.downloadFromR2(key);
    if (!bytes) throw new Error(`R2 artifact is missing: ${key}`);
    let value;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`R2 artifact is not valid JSON: ${key}`);
    }
    return { key, bytes, value, sha256: sha256Bytes(bytes) };
}

async function main() {
    if (!cloud.initR2()) throw new Error('R2 credentials are required');
    const write = process.argv.includes('--write');
    const mapManifest = await requiredJson(elite.MAP_MANIFEST_KEY);
    const mapKey = mapManifest.value
        && mapManifest.value.publishedMap
        && mapManifest.value.publishedMap.archiveKey;
    if (!mapKey) throw new Error('Together map manifest has no published map');
    const map = await requiredJson(mapKey);
    const savedIndex = await requiredJson(elite.SAVED_CHANNEL_INDEX_KEY);
    const manifests = {};
    for (const channel of savedIndex.value.channels || []) {
        if (!channel || !channel.id || !channel.manifestKey) continue;
        const manifest = await requiredJson(channel.manifestKey);
        if (
            channel.manifestSha256
            && manifest.sha256 !== channel.manifestSha256
        ) {
            throw new Error(
                `Saved-channel manifest bytes changed for ${channel.id}`
            );
        }
        manifests[channel.id] = manifest.value;
    }
    const index = elite.buildIndex({
        map: map.value,
        mapManifest: mapManifest.value,
        mapBytesSha256: map.sha256,
        savedChannelIndex: savedIndex.value,
        savedChannelIndexBytesSha256: savedIndex.sha256,
        savedChannelManifests: manifests,
    });
    const validation = elite.validateIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    const bytes = canonicalJsonBytes(index);
    const artifactSha256 = sha256Bytes(bytes);
    const archiveKey = `hooks/elite-corpus/by-sha256/${artifactSha256}.json`;
    if (write) {
        await cloud.uploadToR2(
            archiveKey,
            bytes,
            'application/json'
        );
        await cloud.uploadToR2(
            elite.INDEX_KEY,
            bytes,
            'application/json'
        );
    }
    process.stdout.write(`${JSON.stringify({
        ok: true,
        wrote: write,
        key: elite.INDEX_KEY,
        archive_key: archiveKey,
        artifact_sha256: artifactSha256,
        content_sha256: index.content_sha256,
        corpus_rows: index.corpus.row_count,
        indexed_rows: index.corpus.indexed_row_count,
        metric_counts: index.metric_counts,
        channel_counts: index.channel_counts,
    }, null, 2)}\n`);
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
