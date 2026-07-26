#!/usr/bin/env node
'use strict';

/*
 * Freeze one internally consistent research snapshot from live R2 objects.
 *
 * Each object is streamed and hashed twice. Metadata is checked before and
 * after each read, then checked once more after the full collection finishes.
 * Accepted bytes are stored under their content hash and the vector cache is
 * hard-linked to those immutable local objects.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
    CopyObjectCommand,
    S3Client,
} = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

require('dotenv').config({ quiet: true });

const {
    getR2Stream,
    initR2,
    listR2Objects,
} = require('../../../../cloud-storage');

const HERE = __dirname;
const CACHE = path.join(HERE, '.cache');
const OBJECTS = path.join(CACHE, 'frozen', 'objects');
const TEMP = path.join(CACHE, 'frozen', 'tmp');
const MANIFEST_PATH = path.join(HERE, 'snapshot-manifest.json');
const SNAPSHOT_ID = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

const OBJECT_KEYS = [
    { role: 'shorts:database', key: 'library/db.json', kind: 'json' },
    { role: 'long:database', key: 'longform/db.json', kind: 'json' },
    { role: 'shorts:visual:map', key: 'raw/visual/map.json', kind: 'json' },
    { role: 'shorts:text:map', key: 'raw/text/map.json', kind: 'json' },
    { role: 'shorts:together:map', key: 'raw/together/map.json', kind: 'json' },
    { role: 'long:visual:map', key: 'raw-long/visual/map.json', kind: 'json' },
    { role: 'long:text:map', key: 'raw-long/text/map.json', kind: 'json' },
    { role: 'long:together:map', key: 'raw-long/together/map.json', kind: 'json' },
    { role: 'shorts:visual:vectors', key: 'raw/visual/embeddings.npz', kind: 'npz' },
    { role: 'shorts:text:vectors', key: 'raw/text/embeddings.npz', kind: 'npz' },
    { role: 'shorts:together:vectors', key: 'raw/together/embeddings.npz', kind: 'npz' },
    { role: 'long:visual:vectors', key: 'raw-long/visual/embeddings.npz', kind: 'npz' },
    { role: 'long:text:vectors', key: 'raw-long/text/embeddings.npz', kind: 'npz' },
    { role: 'long:together:vectors', key: 'raw-long/together/embeddings.npz', kind: 'npz' },
];

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sameMetadata(left, right) {
    return left
        && right
        && left.key === right.key
        && left.size === right.size
        && left.etag === right.etag
        && left.lastModified === right.lastModified;
}

async function metadata(key) {
    const found = (await listR2Objects(key)).find(object => object.key === key);
    if (!found) throw new Error(`Missing R2 object ${key}`);
    return found;
}

function snapshotClient() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error('R2 credentials are required.');
    }
    return new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        requestHandler: new NodeHttpHandler({
            connectionTimeout: 8000,
            requestTimeout: 120000,
            throwOnRequestTimeout: true,
            httpsAgent: new https.Agent({ family: 4 }),
        }),
    });
}

function copySource(bucket, key) {
    return encodeURIComponent(`${bucket}/${key}`).replace(/%2F/g, '/');
}

async function freezeSourceObject(client, bucket, item, sourceMetadata) {
    const frozenKey = `quant/snapshots/${SNAPSHOT_ID}/${item.key}`;
    await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: frozenKey,
        CopySource: copySource(bucket, item.key),
        CopySourceIfMatch: sourceMetadata.etag,
        MetadataDirective: 'COPY',
    }));
    const frozenMetadata = await metadata(frozenKey);
    if (frozenMetadata.size !== sourceMetadata.size) {
        throw new Error(`Server-side frozen copy size mismatch for ${item.key}`);
    }
    return frozenKey;
}

async function streamAndHash(key, outputPath) {
    const stream = await getR2Stream(key);
    if (!stream) throw new Error(`Missing R2 stream ${key}`);
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    stream.on('data', chunk => {
        digest.update(chunk);
        bytes += chunk.length;
    });
    await pipeline(stream, fs.createWriteStream(outputPath));
    return { sha256: digest.digest('hex'), bytes };
}

async function readStable(item, pass) {
    const before = await metadata(item.key);
    const safeName = item.role.replace(/[^a-z0-9]+/gi, '-');
    const outputPath = path.join(TEMP, `${safeName}.pass-${pass}.partial`);
    fs.rmSync(outputPath, { force: true });
    const content = await streamAndHash(item.key, outputPath);
    const after = await metadata(item.key);
    if (!sameMetadata(before, after)) {
        fs.rmSync(outputPath, { force: true });
        throw new Error(`${item.key} changed during pass ${pass}`);
    }
    if (content.bytes !== before.size) {
        fs.rmSync(outputPath, { force: true });
        throw new Error(`${item.key} size mismatch during pass ${pass}`);
    }
    return { before, after, outputPath, ...content };
}

function vectorCachePath(role) {
    const [format, modality, kind] = role.split(':');
    if (kind !== 'vectors') return null;
    return path.join(CACHE, 'embeddings', format, `${modality}.npz`);
}

function linkAcceptedVector(role, objectPath) {
    const destination = vectorCachePath(role);
    if (!destination) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { force: true });
    fs.linkSync(objectPath, destination);
}

async function freeze(item, frozenKey, sourceMetadata) {
    const frozenItem = { ...item, key: frozenKey };
    console.log(`pass 1/2 ${item.role} ${frozenKey}`);
    const first = await readStable(frozenItem, 1);
    console.log(`pass 2/2 ${item.role} ${frozenKey}`);
    const second = await readStable(frozenItem, 2);
    if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) {
        fs.rmSync(first.outputPath, { force: true });
        fs.rmSync(second.outputPath, { force: true });
        throw new Error(`${frozenKey} differed across the two complete reads`);
    }
    fs.rmSync(second.outputPath, { force: true });
    const extension = item.kind === 'json' ? '.json' : '.npz';
    const objectPath = path.join(OBJECTS, `${first.sha256}${extension}`);
    if (fs.existsSync(objectPath)) {
        fs.rmSync(first.outputPath, { force: true });
    } else {
        fs.renameSync(first.outputPath, objectPath);
    }
    linkAcceptedVector(item.role, objectPath);
    return {
        role: item.role,
        key: item.key,
        frozenKey,
        kind: item.kind,
        bytes: first.bytes,
        sha256: first.sha256,
        sourceEtag: sourceMetadata.etag,
        frozenEtag: first.after.etag,
        lastModified: new Date(first.after.lastModified).toISOString(),
        localObject: path.relative(HERE, objectPath),
        completeReads: 2,
    };
}

async function main() {
    if (!initR2()) throw new Error('R2 credentials are required.');
    const client = snapshotClient();
    const bucket = process.env.R2_BUCKET_NAME || 'business-world-videos';
    fs.mkdirSync(OBJECTS, { recursive: true });
    fs.mkdirSync(TEMP, { recursive: true });
    const initialMetadata = Object.fromEntries(
        await Promise.all(OBJECT_KEYS.map(async item => [item.key, await metadata(item.key)]))
    );
    const frozenKeys = {};
    for (const item of OBJECT_KEYS) {
        console.log(`freezing ${item.role} -> quant/snapshots/${SNAPSHOT_ID}/...`);
        frozenKeys[item.key] = await freezeSourceObject(
            client,
            bucket,
            item,
            initialMetadata[item.key],
        );
    }
    const objects = [];
    for (const item of OBJECT_KEYS) {
        objects.push(await freeze(
            item,
            frozenKeys[item.key],
            initialMetadata[item.key],
        ));
    }
    const finalMetadata = Object.fromEntries(
        await Promise.all(OBJECT_KEYS.map(async item => [item.key, await metadata(item.key)]))
    );
    const sourceObjectsChangedDuringFreeze = OBJECT_KEYS
        .filter(item => !sameMetadata(initialMetadata[item.key], finalMetadata[item.key]))
        .map(item => item.key);
    const identity = objects.map(object => ({
        role: object.role,
        key: object.key,
        sha256: object.sha256,
        sourceEtag: object.sourceEtag,
        frozenEtag: object.frozenEtag,
    }));
    const runId = sha256(JSON.stringify(identity)).slice(0, 24);
    const manifest = {
        schema: 'quant-frozen-source-snapshot-v1',
        runId,
        acceptedAt: new Date().toISOString(),
        protocol: {
            serverSideConditionalCopy: true,
            immutableR2Prefix: `quant/snapshots/${SNAPSHOT_ID}/`,
            completeReadsPerObject: 2,
            metadataStableWithinEachRead: true,
            metadataStableAcrossWholeCollection: true,
            contentAddressedLocalObjects: true,
            sourceObjectsChangedDuringFreeze,
        },
        objects,
        identityHash: sha256(JSON.stringify(identity)),
    };
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(TEMP, { recursive: true, force: true });
    console.log(JSON.stringify({
        runId,
        manifest: path.relative(process.cwd(), MANIFEST_PATH),
        objects: objects.length,
        bytesRead: objects.reduce((sum, object) => sum + (object.bytes * 2), 0),
        sourceObjectsChangedDuringFreeze,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
