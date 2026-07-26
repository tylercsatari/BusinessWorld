#!/usr/bin/env node
'use strict';

/*
 * Cluster invariance audit
 * ------------------------
 * A standalone, outcome-blind geometry audit followed by sealed outcome tests
 * for the six current Shorts/Long visual/text/together embedding maps.
 *
 * No UI or artifact builder imports this file. It reads the production R2
 * objects directly and writes one compact aggregate JSON result.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const {
    GetObjectCommand,
    HeadObjectCommand,
    S3Client,
} = require('@aws-sdk/client-s3');

require('dotenv').config({ quiet: true });

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_OUTPUT = path.join(__dirname, 'cluster-invariance.json');
const DEFAULT_SNAPSHOT_MANIFEST = path.join(__dirname, 'snapshot-manifest.json');
const DEFAULT_INTEGRITY_REPORT = path.join(__dirname, 'snapshot-integrity.json');
const MAP_SPECS = [
    { format: 'shorts', modality: 'visual', mapKey: 'raw/visual/map.json', embeddingKey: 'raw/visual/embeddings.npz' },
    { format: 'shorts', modality: 'text', mapKey: 'raw/text/map.json', embeddingKey: 'raw/text/embeddings.npz' },
    { format: 'shorts', modality: 'together', mapKey: 'raw/together/map.json', embeddingKey: 'raw/together/embeddings.npz' },
    { format: 'long', modality: 'visual', mapKey: 'raw-long/visual/map.json', embeddingKey: 'raw-long/visual/embeddings.npz' },
    { format: 'long', modality: 'text', mapKey: 'raw-long/text/map.json', embeddingKey: 'raw-long/text/embeddings.npz' },
    { format: 'long', modality: 'together', mapKey: 'raw-long/together/map.json', embeddingKey: 'raw-long/together/embeddings.npz' },
];
const RESOLUTIONS = [6, 10, 16, 24];
const MODALITY_PAIRS = [
    ['visual', 'text'],
    ['visual', 'together'],
    ['text', 'together'],
];
const PAIR_KEYS = [
    ['visual', 'text'],
    ['visual', 'together'],
    ['text', 'together'],
];

function parseArguments(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) continue;
        const separator = argument.indexOf('=');
        if (separator >= 0) {
            values.set(argument.slice(2, separator), argument.slice(separator + 1));
        } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
            values.set(argument.slice(2), argv[index + 1]);
            index += 1;
        } else {
            values.set(argument.slice(2), 'true');
        }
    }
    const quick = values.get('quick') === 'true';
    const integer = (name, fallback) => {
        const parsed = Number(values.get(name));
        return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
        seed: integer('seed', 20260726),
        bootstrapRuns: integer('bootstraps', quick ? 8 : 32),
        permutationRuns: integer('permutations', quick ? 9 : 49),
        deNovoRuns: integer('denovo-runs', quick ? 2 : 3),
        projectionDimensions: integer('projection-dimensions', quick ? 24 : 48),
        projectionSeeds: [0x9e3779b9, 0x85ebca6b],
        maximumTrainingSources: integer('training-sources', quick ? 800 : 3500),
        maximumEvaluationSources: integer('evaluation-sources', quick ? 300 : 900),
        rowsPerSource: integer('rows-per-source', quick ? 2 : 3),
        miniBatchSteps: integer('minibatch-steps', quick ? 30 : 80),
        miniBatchSize: integer('minibatch-size', quick ? 96 : 128),
        output: path.resolve(values.get('output') || DEFAULT_OUTPUT),
        cacheDirectory: path.resolve(
            values.get('cache')
            || path.join(os.tmpdir(), 'business-world-cluster-invariance-v1')
        ),
        noCache: values.get('no-cache') === 'true',
        snapshotManifest: path.resolve(
            values.get('snapshot-manifest') || DEFAULT_SNAPSHOT_MANIFEST
        ),
        integrityReport: path.resolve(
            values.get('integrity-report') || DEFAULT_INTEGRITY_REPORT
        ),
        strictPanel: values.get('strict-panel')
            ? path.resolve(values.get('strict-panel'))
            : null,
        exploratoryOutcomes: values.get('exploratory-outcomes') === 'true',
        allowLiveGeometry: values.get('allow-live-geometry') === 'true',
        quick,
    };
}

const CONFIG = parseArguments(process.argv.slice(2));

function finite(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
    return Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
}

function mean(values) {
    if (!values.length) return null;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
}

function quantile(values, probability) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    const position = Math.max(0, Math.min(
        sorted.length - 1,
        probability * (sorted.length - 1)
    ));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function summarize(values) {
    const clean = values.filter(Number.isFinite);
    return {
        n: clean.length,
        mean: round(mean(clean)),
        p05: round(quantile(clean, 0.05)),
        p50: round(quantile(clean, 0.5)),
        p95: round(quantile(clean, 0.95)),
        minimum: clean.length ? round(Math.min(...clean)) : null,
        maximum: clean.length ? round(Math.max(...clean)) : null,
    };
}

function weightedMean(values, weights) {
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < values.length; index += 1) {
        if (!Number.isFinite(values[index]) || !(weights[index] > 0)) continue;
        numerator += values[index] * weights[index];
        denominator += weights[index];
    }
    return denominator > 0 ? numerator / denominator : null;
}

function weightedCorrelation(left, right, weights) {
    if (left.length !== right.length || left.length !== weights.length) return null;
    const leftMean = weightedMean(left, weights);
    const rightMean = weightedMean(right, weights);
    if (!Number.isFinite(leftMean) || !Number.isFinite(rightMean)) return null;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const weight = weights[index];
        if (!(weight > 0)) continue;
        const a = left[index] - leftMean;
        const b = right[index] - rightMean;
        numerator += weight * a * b;
        leftVariance += weight * a * a;
        rightVariance += weight * b * b;
    }
    return leftVariance > 0 && rightVariance > 0
        ? numerator / Math.sqrt(leftVariance * rightVariance)
        : null;
}

function weightedRSquared(actual, predicted, weights) {
    const center = weightedMean(actual, weights);
    if (!Number.isFinite(center)) return null;
    let total = 0;
    let residual = 0;
    for (let index = 0; index < actual.length; index += 1) {
        const weight = weights[index];
        if (!(weight > 0)) continue;
        total += weight * ((actual[index] - center) ** 2);
        residual += weight * ((actual[index] - predicted[index]) ** 2);
    }
    return total > 0 ? 1 - (residual / total) : null;
}

function rank(values) {
    const order = Array.from(
        values,
        (value, index) => ({ value, index })
    )
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const output = new Float64Array(values.length);
    for (let start = 0; start < order.length;) {
        let end = start + 1;
        while (end < order.length && order[end].value === order[start].value) end += 1;
        const average = ((start + 1) + end) / 2;
        for (let index = start; index < end; index += 1) {
            output[order[index].index] = average;
        }
        start = end;
    }
    return output;
}

function weightedSpearman(left, right, weights) {
    return weightedCorrelation(rank(left), rank(right), weights);
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableHash32(value, seed = 0) {
    const text = String(value);
    let state = (2166136261 ^ seed) >>> 0;
    for (let index = 0; index < text.length; index += 1) {
        state ^= text.charCodeAt(index);
        state = Math.imul(state, 16777619);
    }
    state ^= state >>> 16;
    state = Math.imul(state, 0x7feb352d);
    state ^= state >>> 15;
    state = Math.imul(state, 0x846ca68b);
    state ^= state >>> 16;
    return state >>> 0;
}

function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle(values, rng) {
    for (let index = values.length - 1; index > 0; index -= 1) {
        const target = Math.floor(rng() * (index + 1));
        const swap = values[index];
        values[index] = values[target];
        values[target] = swap;
    }
    return values;
}

function empiricalTest(observed, nullValues, direction = 'greater') {
    const clean = nullValues.filter(Number.isFinite);
    if (!Number.isFinite(observed) || !clean.length) {
        return { observed: round(observed), null: summarize(clean), p: null, z: null };
    }
    const center = mean(clean);
    const variance = mean(clean.map(value => ((value - center) ** 2)));
    const exceedances = clean.filter(value => (
        direction === 'less' ? value <= observed : value >= observed
    )).length;
    return {
        observed: round(observed),
        null: summarize(clean),
        p: round((exceedances + 1) / (clean.length + 1)),
        z: variance > 0 ? round((observed - center) / Math.sqrt(variance)) : null,
        direction,
        monteCarloResolution: round(1 / (clean.length + 1)),
    };
}

function bhAdjust(rows, field = 'p') {
    const eligible = rows
        .map((row, index) => ({ row, index, p: finite(row[field]) }))
        .filter(item => item.p != null)
        .sort((left, right) => left.p - right.p);
    let running = 1;
    for (let index = eligible.length - 1; index >= 0; index -= 1) {
        const item = eligible[index];
        running = Math.min(running, (item.p * eligible.length) / (index + 1));
        item.row.q = round(running);
    }
    return rows;
}

function createS3Client() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required.');
    }
    return {
        client: new S3Client({
            region: 'auto',
            endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId, secretAccessKey },
        }),
        bucket: process.env.R2_BUCKET_NAME || 'business-world-videos',
    };
}

async function readObject(client, bucket, key) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    return {
        key,
        buffer,
        bytes: buffer.length,
        sha256: sha256(buffer),
        etag: String(response.ETag || '').replaceAll('"', ''),
        lastModified: response.LastModified?.toISOString() || null,
    };
}

async function readJsonObject(client, bucket, key) {
    const object = await readObject(client, bucket, key);
    return { ...object, value: JSON.parse(object.buffer.toString('utf8')) };
}

async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function ensureCachedObject(client, bucket, key, cacheDirectory, noCache = false) {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const etag = String(head.ETag || '').replaceAll('"', '');
    const safeName = `${key.replaceAll('/', '__')}__${etag || head.ContentLength}`;
    const filePath = path.join(cacheDirectory, safeName);
    fs.mkdirSync(cacheDirectory, { recursive: true });
    if (
        !noCache
        && fs.existsSync(filePath)
        && fs.statSync(filePath).size === Number(head.ContentLength)
    ) {
        return {
            key,
            filePath,
            bytes: Number(head.ContentLength),
            etag,
            lastModified: head.LastModified?.toISOString() || null,
            sha256: await hashFile(filePath),
            cacheHit: true,
        };
    }
    const temporary = `${filePath}.${process.pid}.partial`;
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(response.Body, fs.createWriteStream(temporary));
    fs.renameSync(temporary, filePath);
    return {
        key,
        filePath,
        bytes: fs.statSync(filePath).size,
        etag,
        lastModified: head.LastModified?.toISOString() || null,
        sha256: await hashFile(filePath),
        cacheHit: false,
    };
}

function loadSnapshotManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== 'quant-frozen-source-snapshot-v1') {
        throw new Error(`Unsupported snapshot manifest schema ${manifest.schema}`);
    }
    const protocol = manifest.protocol || {};
    if (
        protocol.completeReadsPerObject !== 2
        || protocol.metadataStableWithinEachRead !== true
        || protocol.metadataStableAcrossWholeCollection !== true
        || protocol.contentAddressedLocalObjects !== true
    ) {
        throw new Error('Snapshot manifest does not satisfy the two-read atomicity contract.');
    }
    const byRole = new Map();
    for (const object of manifest.objects || []) {
        const objectPath = path.resolve(path.dirname(manifestPath), object.localObject);
        if (!fs.existsSync(objectPath)) {
            throw new Error(`Frozen object missing: ${objectPath}`);
        }
        if (fs.statSync(objectPath).size !== Number(object.bytes)) {
            throw new Error(`Frozen object size mismatch: ${object.role}`);
        }
        const fileHash = path.basename(objectPath).split('.')[0];
        if (fileHash !== object.sha256) {
            throw new Error(`Frozen object path is not content-addressed: ${object.role}`);
        }
        byRole.set(object.role, { ...object, objectPath });
    }
    return { manifest, byRole, manifestPath };
}

function snapshotRole(format, modality, kind) {
    return modality
        ? `${format}:${modality}:${kind}`
        : `${format}:${kind}`;
}

async function createInputProvider() {
    const frozen = loadSnapshotManifest(CONFIG.snapshotManifest);
    if (frozen) {
        const readJson = role => {
            const object = frozen.byRole.get(role);
            if (!object) throw new Error(`Snapshot role missing: ${role}`);
            const buffer = fs.readFileSync(object.objectPath);
            const digest = sha256(buffer);
            if (digest !== object.sha256) {
                throw new Error(`Frozen JSON hash mismatch: ${role}`);
            }
            return {
                key: object.key,
                role,
                buffer,
                bytes: buffer.length,
                sha256: digest,
                etag: object.etag,
                lastModified: object.lastModified,
                value: JSON.parse(buffer.toString('utf8')),
                frozen: true,
            };
        };
        const embedding = role => {
            const object = frozen.byRole.get(role);
            if (!object) throw new Error(`Snapshot role missing: ${role}`);
            return {
                key: object.key,
                role,
                filePath: object.objectPath,
                bytes: object.bytes,
                sha256: object.sha256,
                etag: object.etag,
                lastModified: object.lastModified,
                cacheHit: true,
                frozen: true,
                hashVerification: 'Verified by two complete reads in the snapshot protocol; content-addressed filename and byte length rechecked here.',
            };
        };
        return {
            mode: 'frozen_content_addressed',
            atomic: true,
            runId: frozen.manifest.runId,
            identityHash: frozen.manifest.identityHash,
            acceptedAt: frozen.manifest.acceptedAt,
            manifestPath: frozen.manifestPath,
            readDatabase: format => readJson(snapshotRole(format, null, 'database')),
            readMap: (format, modality) => readJson(snapshotRole(format, modality, 'map')),
            readEmbedding: (format, modality) => embedding(
                snapshotRole(format, modality, 'vectors')
            ),
        };
    }
    if (!CONFIG.allowLiveGeometry) {
        throw new Error(
            `No frozen snapshot at ${CONFIG.snapshotManifest}. `
            + 'Wait for freeze-snapshot.js or pass --allow-live-geometry for explicitly exploratory geometry.'
        );
    }
    const { client, bucket } = createS3Client();
    return {
        mode: 'live_non_atomic_exploratory',
        atomic: false,
        runId: null,
        identityHash: null,
        acceptedAt: null,
        manifestPath: null,
        readDatabase: async format => readJsonObject(
            client,
            bucket,
            format === 'shorts' ? 'library/db.json' : 'longform/db.json'
        ),
        readMap: async (format, modality) => readJsonObject(
            client,
            bucket,
            format === 'shorts'
                ? `raw/${modality}/map.json`
                : `raw-long/${modality}/map.json`
        ),
        readEmbedding: async (format, modality) => ensureCachedObject(
            client,
            bucket,
            format === 'shorts'
                ? `raw/${modality}/embeddings.npz`
                : `raw-long/${modality}/embeddings.npz`,
            CONFIG.cacheDirectory,
            CONFIG.noCache
        ),
    };
}

function firstFinite(...values) {
    for (const value of values) {
        const parsed = finite(value);
        if (parsed != null) return parsed;
    }
    return null;
}

function loadStrictPanel(panelPath, snapshotRunId) {
    if (!panelPath) return null;
    if (!fs.existsSync(panelPath)) throw new Error(`Strict panel not found: ${panelPath}`);
    const payload = JSON.parse(fs.readFileSync(panelPath, 'utf8'));
    if (!Array.isArray(payload.rows)) {
        throw new Error('Strict panel must contain rows[].');
    }
    const panelRunId = payload.snapshotRunId || payload.runId || payload.snapshot?.runId;
    if (snapshotRunId && panelRunId !== snapshotRunId) {
        throw new Error(
            `Strict panel snapshot ${panelRunId || '<missing>'} does not match ${snapshotRunId}.`
        );
    }
    const byObservation = new Map();
    const rejection = {};
    const reject = reason => rejection[reason] = (rejection[reason] || 0) + 1;
    for (const row of payload.rows) {
        const format = String(row.format || '').toLowerCase();
        const videoId = String(row.videoId || row.id || '').trim();
        const strictEligible = (
            row.strictEligible === true
            || row.strict_eligible === true
            || row.eligibility?.strict === true
        );
        const sourceId = String(row.sourceId || row.channelId || '').trim();
        const publishedSeconds = firstFinite(
            row.publishedSeconds,
            row.timestamp,
            row.T_i
        );
        const observedSeconds = firstFinite(
            row.observedSeconds,
            row.storedAtSeconds,
            row.S_i,
            finite(row.storedAt) != null ? finite(row.storedAt) / 1000 : null
        );
        const latestPriorObservedSeconds = firstFinite(
            row.history?.latestObservedSeconds,
            row.latestPriorObservedSeconds,
            row.historyLatestS
        );
        const priorCount = firstFinite(
            row.history?.count,
            row.historicalPriorCount,
            row.priorCount
        );
        const target = firstFinite(
            row.outcomes?.opportunityResidual,
            row.outcomes?.creatorRelativeResidual,
            row.targets?.opportunityResidual,
            row.target?.opportunityResidual,
            row.opportunityResidual
        );
        if (!['shorts', 'long'].includes(format)) { reject('format'); continue; }
        if (!videoId) { reject('videoId'); continue; }
        if (!strictEligible) { reject('strictEligibilityFlag'); continue; }
        if (row.rechecked === true) { reject('rechecked'); continue; }
        if (row.stored === false) { reject('notStored'); continue; }
        if (!sourceId) { reject('sourceId'); continue; }
        if (!Number.isFinite(publishedSeconds) || !Number.isFinite(observedSeconds)) {
            reject('observationTimes');
            continue;
        }
        if (!(observedSeconds > publishedSeconds)) { reject('nonPositiveAge'); continue; }
        if (!(priorCount >= 1)) { reject('historicalPriorCount'); continue; }
        if (
            !Number.isFinite(latestPriorObservedSeconds)
            || latestPriorObservedSeconds > publishedSeconds
        ) {
            reject('historyNotObservableAtPublication');
            continue;
        }
        if (!Number.isFinite(target)) { reject('opportunityResidual'); continue; }
        byObservation.set(`${format}:${videoId}`, {
            ...row,
            format,
            videoId,
            sourceId,
            publishedSeconds,
            observedSeconds,
            latestPriorObservedSeconds,
            priorCount,
            target,
        });
    }
    const accepted = [...byObservation.values()];
    const publicationTimes = accepted
        .map(row => row.publishedSeconds)
        .filter(Number.isFinite);
    const observationTimes = accepted
        .map(row => row.observedSeconds)
        .filter(Number.isFinite);
    const formatCounts = {};
    const sources = new Set();
    for (const row of accepted) {
        formatCounts[row.format] = (formatCounts[row.format] || 0) + 1;
        sources.add(`${row.format}:${row.sourceId}`);
    }
    return {
        schema: payload.schema || 'unknown',
        snapshotRunId: panelRunId,
        byObservation,
        acceptedRows: byObservation.size,
        rejectedRows: payload.rows.length - byObservation.size,
        rejection,
        coverage: {
            formats: formatCounts,
            sources: sources.size,
            publicationStartIso: publicationTimes.length
                ? new Date(Math.min(...publicationTimes) * 1000).toISOString()
                : null,
            publicationEndIso: publicationTimes.length
                ? new Date(Math.max(...publicationTimes) * 1000).toISOString()
                : null,
            observationStartIso: observationTimes.length
                ? new Date(Math.min(...observationTimes) * 1000).toISOString()
                : null,
            observationEndIso: observationTimes.length
                ? new Date(Math.max(...observationTimes) * 1000).toISOString()
                : null,
        },
        target: 'Strict opportunity residual supplied by the rebuilt panel.',
        validity: 'strict_panel_eligible_for_holdout_testing',
        sourcePath: panelPath,
        sourceSha256: sha256(fs.readFileSync(panelPath)),
    };
}

function loadIntegrityReport(reportPath, snapshotRunId) {
    if (!fs.existsSync(reportPath)) {
        return {
            available: false,
            accepted: false,
            byChannel: new Map(),
            failures: ['Frozen map/vector exact ID-order report is missing.'],
            sourcePath: reportPath,
            sourceSha256: null,
        };
    }
    const buffer = fs.readFileSync(reportPath);
    const payload = JSON.parse(buffer.toString('utf8'));
    if (payload.schema !== 'quant-frozen-snapshot-integrity-v1') {
        throw new Error(`Unsupported integrity report schema ${payload.schema}`);
    }
    if (snapshotRunId && payload.snapshotRunId !== snapshotRunId) {
        throw new Error(
            `Integrity report snapshot ${payload.snapshotRunId} does not match ${snapshotRunId}.`
        );
    }
    const byChannel = new Map();
    for (const row of payload.channels || []) {
        byChannel.set(row.id, {
            ...row,
            accepted: (
                row.mapAndVectorRowCountMatch === true
                && row.mapAndVectorIdOrderMatch === true
                && row.duplicateMapIds === 0
                && row.duplicateVectorIds === 0
                && row.dimensions === 1536
                && row.sampleAllFinite === true
            ),
        });
    }
    return {
        available: true,
        accepted: payload.accepted === true,
        byChannel,
        failures: payload.failures || [],
        sourcePath: reportPath,
        sourceSha256: sha256(buffer),
        generatedAt: payload.generatedAt,
        contentHash: payload.contentHash,
    };
}

function findZipEntry(filePath, requestedName) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const fileSize = fs.fstatSync(descriptor).size;
        const tailSize = Math.min(fileSize, 65_557);
        const tail = Buffer.allocUnsafe(tailSize);
        fs.readSync(descriptor, tail, 0, tailSize, fileSize - tailSize);
        let eocd = -1;
        for (let index = tail.length - 22; index >= 0; index -= 1) {
            if (tail.readUInt32LE(index) === 0x06054b50) {
                eocd = index;
                break;
            }
        }
        if (eocd < 0) throw new Error(`ZIP end record missing in ${filePath}`);
        const centralSize = tail.readUInt32LE(eocd + 12);
        const centralOffset = tail.readUInt32LE(eocd + 16);
        const central = Buffer.allocUnsafe(centralSize);
        fs.readSync(descriptor, central, 0, centralSize, centralOffset);
        for (let cursor = 0; cursor < central.length;) {
            if (central.readUInt32LE(cursor) !== 0x02014b50) break;
            const method = central.readUInt16LE(cursor + 10);
            const compressedSize = central.readUInt32LE(cursor + 20);
            const uncompressedSize = central.readUInt32LE(cursor + 24);
            const nameLength = central.readUInt16LE(cursor + 28);
            const extraLength = central.readUInt16LE(cursor + 30);
            const commentLength = central.readUInt16LE(cursor + 32);
            const localOffset = central.readUInt32LE(cursor + 42);
            const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString();
            if (name === requestedName || name.endsWith(`/${requestedName}`)) {
                const localHeader = Buffer.allocUnsafe(30);
                fs.readSync(descriptor, localHeader, 0, 30, localOffset);
                if (localHeader.readUInt32LE(0) !== 0x04034b50) {
                    throw new Error(`Invalid ZIP local header for ${name}`);
                }
                const localNameLength = localHeader.readUInt16LE(26);
                const localExtraLength = localHeader.readUInt16LE(28);
                return {
                    name,
                    method,
                    compressedSize,
                    uncompressedSize,
                    dataOffset: localOffset + 30 + localNameLength + localExtraLength,
                };
            }
            cursor += 46 + nameLength + extraLength + commentLength;
        }
        throw new Error(`${requestedName} not found in ${filePath}`);
    } finally {
        fs.closeSync(descriptor);
    }
}

function extractZipEntry(filePath, requestedName) {
    const entry = findZipEntry(filePath, requestedName);
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const compressed = Buffer.allocUnsafe(entry.compressedSize);
        fs.readSync(descriptor, compressed, 0, entry.compressedSize, entry.dataOffset);
        if (entry.method === 0) return { entry, buffer: compressed };
        if (entry.method !== 8) throw new Error(`Unsupported ZIP method ${entry.method}`);
        const buffer = zlib.inflateRawSync(compressed, {
            maxOutputLength: entry.uncompressedSize + 1024,
        });
        return { entry, buffer };
    } finally {
        fs.closeSync(descriptor);
    }
}

function parseNpyFloat32(buffer) {
    if (buffer.subarray(0, 6).toString('binary') !== '\x93NUMPY') {
        throw new Error('Invalid NPY magic.');
    }
    const major = buffer[6];
    const headerLength = major <= 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
    const headerOffset = major <= 1 ? 10 : 12;
    const header = buffer
        .subarray(headerOffset, headerOffset + headerLength)
        .toString('latin1')
        .trim();
    const descriptor = /'descr':\s*'([^']+)'/.exec(header)?.[1];
    const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
    if (!descriptor || !shapeText) throw new Error(`Unsupported NPY header: ${header}`);
    if (!['<f4', '=f4', '|f4'].includes(descriptor)) {
        throw new Error(`Expected float32 vectors, received ${descriptor}`);
    }
    const shape = shapeText
        .split(',')
        .map(value => Number(value.trim()))
        .filter(Number.isFinite);
    if (shape.length !== 2) throw new Error(`Expected a 2-D vector matrix, received ${shape}`);
    const count = shape[0] * shape[1];
    const dataOffset = headerOffset + headerLength;
    let values;
    if ((buffer.byteOffset + dataOffset) % Float32Array.BYTES_PER_ELEMENT === 0) {
        values = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, count);
    } else {
        const copy = Buffer.from(buffer.subarray(dataOffset, dataOffset + (count * 4)));
        values = new Float32Array(copy.buffer, copy.byteOffset, count);
    }
    return {
        rows: shape[0],
        dimensions: shape[1],
        values,
        dataOffset,
        header,
    };
}

function parsePublishedSeconds(row) {
    const timestamp = finite(row?.timestamp);
    if (timestamp != null) return timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp;
    const uploadDate = String(row?.uploadDate || '');
    if (/^\d{8}$/.test(uploadDate)) {
        const parsed = Date.parse(
            `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`
        );
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    const publishedAt = Date.parse(String(row?.publishedAt || ''));
    return Number.isFinite(publishedAt) ? Math.floor(publishedAt / 1000) : null;
}

function quarterFromSeconds(seconds) {
    if (!Number.isFinite(seconds)) return 'unknown';
    const date = new Date(seconds * 1000);
    return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function buildMetadata(map, database, format) {
    const videos = database.videos || {};
    const rows = [];
    let databaseMatches = 0;
    let timestamps = 0;
    let canonicalSources = 0;
    for (let index = 0; index < map.id.length; index += 1) {
        const id = String(map.id[index]);
        const databaseRow = videos[id] || {};
        if (videos[id]) databaseMatches += 1;
        const sourceId = String(
            databaseRow.channelId
            || map.owner?.[index]
            || databaseRow.channelUrl
            || databaseRow.channel
            || `unknown:${id}`
        );
        if (databaseRow.channelId) canonicalSources += 1;
        const publishedSeconds = parsePublishedSeconds(databaseRow);
        if (Number.isFinite(publishedSeconds)) timestamps += 1;
        const views = Math.max(
            0,
            finite(map.views?.[index], finite(databaseRow.views, 0))
        );
        rows.push({
            index,
            id,
            format,
            sourceId,
            sourceName: String(databaseRow.channel || ''),
            publishedSeconds,
            quarter: quarterFromSeconds(publishedSeconds),
            views,
            logViews: Math.log10(views + 1),
            outlier: finite(map.outlier?.[index], finite(databaseRow.outlier)),
            silent: Boolean(map.silent?.[index]),
        });
    }
    const sourceGroups = groupIndices(rows, row => row.sourceId);
    const quarterGroups = groupIndices(rows, row => row.quarter);
    const sourceQuarterGroups = groupIndices(rows, row => `${row.sourceId}\u0000${row.quarter}`);
    const sourceWeights = equalGroupWeights(rows.length, sourceGroups);
    return {
        rows,
        sourceGroups,
        quarterGroups,
        sourceQuarterGroups,
        sourceWeights,
        coverage: {
            mapRows: rows.length,
            databaseMatches,
            databaseMatchFraction: round(databaseMatches / Math.max(1, rows.length)),
            timestampRows: timestamps,
            timestampFraction: round(timestamps / Math.max(1, rows.length)),
            canonicalSourceRows: canonicalSources,
            canonicalSourceFraction: round(canonicalSources / Math.max(1, rows.length)),
            sources: sourceGroups.size,
            quarters: quarterGroups.size,
        },
    };
}

function groupIndices(rows, keyFunction) {
    const groups = new Map();
    for (let index = 0; index < rows.length; index += 1) {
        const key = String(keyFunction(rows[index], index));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(index);
    }
    return groups;
}

function equalGroupWeights(length, groups) {
    const weights = new Float64Array(length);
    for (const indices of groups.values()) {
        const weight = 1 / indices.length;
        for (const index of indices) weights[index] = weight;
    }
    return weights;
}

function mobility(groups, totalRows) {
    let movableRows = 0;
    let movableGroups = 0;
    for (const indices of groups.values()) {
        if (indices.length > 1) {
            movableRows += indices.length;
            movableGroups += 1;
        }
    }
    return {
        groups: groups.size,
        movableGroups,
        movableRows,
        movableFraction: round(movableRows / Math.max(1, totalRows)),
    };
}

function permuteWithinGroups(values, groups, rng) {
    const output = Int32Array.from(values);
    for (const indices of groups.values()) {
        if (indices.length <= 1) continue;
        const shuffled = indices.map(index => output[index]);
        shuffle(shuffled, rng);
        for (let position = 0; position < indices.length; position += 1) {
            output[indices[position]] = shuffled[position];
        }
    }
    return output;
}

function bootstrapSourceWeights(length, sourceGroups, rng) {
    const sources = [...sourceGroups.keys()];
    const multiplicity = new Map();
    for (let draw = 0; draw < sources.length; draw += 1) {
        const source = sources[Math.floor(rng() * sources.length)];
        multiplicity.set(source, (multiplicity.get(source) || 0) + 1);
    }
    const weights = new Float64Array(length);
    for (const [source, count] of multiplicity.entries()) {
        const indices = sourceGroups.get(source);
        const weight = count / indices.length;
        for (const index of indices) weights[index] = weight;
    }
    return weights;
}

function categoryCodes(values) {
    const codeByValue = new Map();
    const codes = new Int32Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
        const value = String(values[index]);
        if (!codeByValue.has(value)) codeByValue.set(value, codeByValue.size);
        codes[index] = codeByValue.get(value);
    }
    return { codes, categories: codeByValue.size };
}

function entropyFromMass(masses, total) {
    if (!(total > 0)) return 0;
    let result = 0;
    for (const mass of masses) {
        if (mass > 0) {
            const probability = mass / total;
            result -= probability * Math.log(probability);
        }
    }
    return result;
}

function weightedContingency(labelsA, labelsB, weights, countA, countB) {
    const matrix = new Float64Array(countA * countB);
    const rows = new Float64Array(countA);
    const columns = new Float64Array(countB);
    let total = 0;
    for (let index = 0; index < labelsA.length; index += 1) {
        const left = labelsA[index];
        const right = labelsB[index];
        const weight = weights[index];
        if (
            !(weight > 0)
            || left < 0
            || left >= countA
            || right < 0
            || right >= countB
        ) continue;
        matrix[(left * countB) + right] += weight;
        rows[left] += weight;
        columns[right] += weight;
        total += weight;
    }
    return { matrix, rows, columns, total, countA, countB };
}

function contingencyMetrics(contingency) {
    const {
        matrix,
        rows,
        columns,
        total,
        countA,
        countB,
    } = contingency;
    const entropyA = entropyFromMass(rows, total);
    const entropyB = entropyFromMass(columns, total);
    let information = 0;
    let forwardPurityMass = 0;
    let reversePurityMass = 0;
    const rowMaximums = new Float64Array(countA);
    const columnMaximums = new Float64Array(countB);
    for (let left = 0; left < countA; left += 1) {
        for (let right = 0; right < countB; right += 1) {
            const mass = matrix[(left * countB) + right];
            if (!(mass > 0)) continue;
            information += (mass / total) * Math.log((mass * total) / (rows[left] * columns[right]));
            if (mass > rowMaximums[left]) rowMaximums[left] = mass;
            if (mass > columnMaximums[right]) columnMaximums[right] = mass;
        }
    }
    for (const value of rowMaximums) forwardPurityMass += value;
    for (const value of columnMaximums) reversePurityMass += value;
    return {
        nmi: entropyA > 0 && entropyB > 0
            ? information / Math.sqrt(entropyA * entropyB)
            : null,
        variationOfInformationBits: (
            entropyA + entropyB - (2 * information)
        ) / Math.log(2),
        forwardPurity: total > 0 ? forwardPurityMass / total : null,
        reversePurity: total > 0 ? reversePurityMass / total : null,
        entropyABits: entropyA / Math.log(2),
        entropyBBits: entropyB / Math.log(2),
    };
}

function partitionMetric(labelsA, labelsB, weights, countA, countB) {
    return contingencyMetrics(weightedContingency(
        labelsA,
        labelsB,
        weights,
        countA,
        countB
    ));
}

function topTransportEdges(contingency, limitPerOrigin = 3) {
    const {
        matrix,
        rows,
        columns,
        total,
        countA,
        countB,
    } = contingency;
    const output = [];
    for (let left = 0; left < countA; left += 1) {
        const candidates = [];
        let rowEntropy = 0;
        for (let right = 0; right < countB; right += 1) {
            const mass = matrix[(left * countB) + right];
            if (!(mass > 0)) continue;
            const share = mass / rows[left];
            rowEntropy -= share * Math.log(share);
            candidates.push({
                from: left,
                to: right,
                sourceBalancedMass: round(mass),
                globalShare: round(mass / total),
                fromShare: round(share),
                toShare: round(mass / columns[right]),
                weightedJaccard: round(mass / (rows[left] + columns[right] - mass)),
            });
        }
        candidates.sort((a, b) => b.sourceBalancedMass - a.sourceBalancedMass);
        const effectiveChildren = Math.exp(rowEntropy);
        for (const candidate of candidates.slice(0, limitPerOrigin)) {
            output.push({ ...candidate, effectiveChildren: round(effectiveChildren) });
        }
    }
    return output;
}

function clusterCorePaths(labelSets, sourceWeights) {
    const adjacent = [];
    for (let index = 0; index < labelSets.length - 1; index += 1) {
        const left = labelSets[index];
        const right = labelSets[index + 1];
        const contingency = weightedContingency(
            left.labels,
            right.labels,
            sourceWeights,
            left.k,
            right.k
        );
        const dominantChild = new Int32Array(left.k).fill(-1);
        const dominantParent = new Int32Array(right.k).fill(-1);
        for (let parent = 0; parent < left.k; parent += 1) {
            let bestMass = -1;
            for (let child = 0; child < right.k; child += 1) {
                const mass = contingency.matrix[(parent * right.k) + child];
                if (mass > bestMass) {
                    bestMass = mass;
                    dominantChild[parent] = child;
                }
            }
        }
        for (let child = 0; child < right.k; child += 1) {
            let bestMass = -1;
            for (let parent = 0; parent < left.k; parent += 1) {
                const mass = contingency.matrix[(parent * right.k) + child];
                if (mass > bestMass) {
                    bestMass = mass;
                    dominantParent[child] = parent;
                }
            }
        }
        adjacent.push({ dominantChild, dominantParent });
    }
    const stable = new Uint8Array(labelSets[0].labels.length);
    for (let row = 0; row < stable.length; row += 1) {
        let survives = true;
        for (let level = 0; level < adjacent.length; level += 1) {
            const parent = labelSets[level].labels[row];
            const child = labelSets[level + 1].labels[row];
            if (
                adjacent[level].dominantChild[parent] !== child
                || adjacent[level].dominantParent[child] !== parent
            ) {
                survives = false;
                break;
            }
        }
        stable[row] = survives ? 1 : 0;
    }
    const totalWeight = sourceWeights.reduce((sum, value) => sum + value, 0);
    let stableWeight = 0;
    for (let index = 0; index < stable.length; index += 1) {
        if (stable[index]) stableWeight += sourceWeights[index];
    }
    return {
        definition: 'An observation is in the strict lineage core only when every adjacent k transition follows both the parent’s dominant child and the child’s dominant parent under equal-source weights.',
        observations: stable.reduce((sum, value) => sum + value, 0),
        observationFraction: round(stable.reduce((sum, value) => sum + value, 0) / Math.max(1, stable.length)),
        sourceBalancedFraction: round(stableWeight / Math.max(Number.EPSILON, totalWeight)),
    };
}

function constrainedNulls({
    observed,
    labelsA,
    labelsB,
    weights,
    countA,
    countB,
    groups,
    seed,
}) {
    const results = [];
    for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
        const rng = createRng(seed + repetition);
        const permuted = permuteWithinGroups(labelsB, groups, rng);
        results.push(partitionMetric(
            labelsA,
            permuted,
            weights,
            countA,
            countB
        ).nmi);
    }
    return empiricalTest(observed, results);
}

function bootstrapPartition({
    labelsA,
    labelsB,
    metadata,
    countA,
    countB,
    seed,
}) {
    const nmi = [];
    const forwardPurity = [];
    const reversePurity = [];
    for (let repetition = 0; repetition < CONFIG.bootstrapRuns; repetition += 1) {
        const weights = bootstrapSourceWeights(
            labelsA.length,
            metadata.sourceGroups,
            createRng(seed + repetition)
        );
        const metrics = partitionMetric(labelsA, labelsB, weights, countA, countB);
        nmi.push(metrics.nmi);
        forwardPurity.push(metrics.forwardPurity);
        reversePurity.push(metrics.reversePurity);
    }
    return {
        resamplingUnit: 'source/channel',
        sourceContribution: 'Each sampled source contributes total weight one, independent of its number of videos.',
        runs: CONFIG.bootstrapRuns,
        nmi: summarize(nmi),
        forwardPurity: summarize(forwardPurity),
        reversePurity: summarize(reversePurity),
    };
}

function analyzeTransport({
    labelsA,
    labelsB,
    metadata,
    countA,
    countB,
    seed,
}) {
    const contingency = weightedContingency(
        labelsA,
        labelsB,
        metadata.sourceWeights,
        countA,
        countB
    );
    const observed = contingencyMetrics(contingency);
    return {
        sourceBalanced: Object.fromEntries(
            Object.entries(observed).map(([key, value]) => [key, round(value)])
        ),
        bootstrap: bootstrapPartition({
            labelsA,
            labelsB,
            metadata,
            countA,
            countB,
            seed: seed + 1000,
        }),
        nulls: {
            sourcePreserving: {
                mobility: mobility(metadata.sourceGroups, labelsA.length),
                ...constrainedNulls({
                    observed: observed.nmi,
                    labelsA,
                    labelsB,
                    weights: metadata.sourceWeights,
                    countA,
                    countB,
                    groups: metadata.sourceGroups,
                    seed: seed + 2000,
                }),
            },
            timePreserving: {
                mobility: mobility(metadata.quarterGroups, labelsA.length),
                ...constrainedNulls({
                    observed: observed.nmi,
                    labelsA,
                    labelsB,
                    weights: metadata.sourceWeights,
                    countA,
                    countB,
                    groups: metadata.quarterGroups,
                    seed: seed + 3000,
                }),
            },
            exactSourceTimeMobility: mobility(
                metadata.sourceQuarterGroups,
                labelsA.length
            ),
        },
        strongestEdges: topTransportEdges(contingency),
    };
}

function mix32(value) {
    let state = value >>> 0;
    state ^= state >>> 16;
    state = Math.imul(state, 0x7feb352d);
    state ^= state >>> 15;
    state = Math.imul(state, 0x846ca68b);
    state ^= state >>> 16;
    return state >>> 0;
}

function projectCountSketch(matrix, rows, dimensions, targetDimensions, seeds) {
    const mappings = seeds.map(seed => {
        const buckets = new Uint16Array(dimensions);
        const signs = new Int8Array(dimensions);
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            const hashed = mix32(dimension ^ seed);
            buckets[dimension] = hashed % targetDimensions;
            signs[dimension] = (hashed & 0x80000000) === 0 ? 1 : -1;
        }
        return { buckets, signs };
    });
    const outputs = seeds.map(() => new Float32Array(rows * targetDimensions));
    for (let row = 0; row < rows; row += 1) {
        const sourceOffset = row * dimensions;
        let squaredNorm = 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            const value = matrix[sourceOffset + dimension];
            squaredNorm += value * value;
        }
        const inverseNorm = squaredNorm > 0 ? 1 / Math.sqrt(squaredNorm) : 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            const value = matrix[sourceOffset + dimension] * inverseNorm;
            for (let projection = 0; projection < outputs.length; projection += 1) {
                const mapping = mappings[projection];
                outputs[projection][
                    (row * targetDimensions) + mapping.buckets[dimension]
                ] += value * mapping.signs[dimension];
            }
        }
        for (const output of outputs) {
            const offset = row * targetDimensions;
            let projectedNorm = 0;
            for (let dimension = 0; dimension < targetDimensions; dimension += 1) {
                const value = output[offset + dimension];
                projectedNorm += value * value;
            }
            const projectedInverse = projectedNorm > 0 ? 1 / Math.sqrt(projectedNorm) : 0;
            for (let dimension = 0; dimension < targetDimensions; dimension += 1) {
                output[offset + dimension] *= projectedInverse;
            }
        }
    }
    return outputs;
}

function selectSourceBalancedRows(metadata, seed) {
    const trainingSources = [];
    const evaluationSources = [];
    for (const source of metadata.sourceGroups.keys()) {
        if ((stableHash32(source, seed) % 5) === 0) evaluationSources.push(source);
        else trainingSources.push(source);
    }
    trainingSources.sort((left, right) => (
        stableHash32(left, seed + 1) - stableHash32(right, seed + 1)
    ));
    evaluationSources.sort((left, right) => (
        stableHash32(left, seed + 2) - stableHash32(right, seed + 2)
    ));
    const selectedTraining = trainingSources.slice(0, CONFIG.maximumTrainingSources);
    const selectedEvaluation = evaluationSources.slice(0, CONFIG.maximumEvaluationSources);
    const chooseRows = (sources, salt) => {
        const indices = [];
        const sourceByIndex = [];
        const weights = [];
        for (const source of sources) {
            const candidates = metadata.sourceGroups
                .get(source)
                .slice()
                .sort((left, right) => (
                    stableHash32(metadata.rows[left].id, salt)
                    - stableHash32(metadata.rows[right].id, salt)
                ))
                .slice(0, CONFIG.rowsPerSource);
            for (const index of candidates) {
                indices.push(index);
                sourceByIndex.push(source);
                weights.push(1 / candidates.length);
            }
        }
        return {
            indices,
            sources,
            sourceByIndex,
            weights: Float64Array.from(weights),
        };
    };
    return {
        training: chooseRows(selectedTraining, seed + 3),
        evaluation: chooseRows(selectedEvaluation, seed + 4),
        split: {
            policy: 'SHA-256-like deterministic 4/5 source training and 1/5 unseen-source evaluation; row caps are applied after the source split.',
            availableTrainingSources: trainingSources.length,
            availableEvaluationSources: evaluationSources.length,
            selectedTrainingSources: selectedTraining.length,
            selectedEvaluationSources: selectedEvaluation.length,
        },
    };
}

function computeCentroids(vectors, dimensions, labels, k, indices, weights = null) {
    const centroids = new Float64Array(k * dimensions);
    const mass = new Float64Array(k);
    for (let position = 0; position < indices.length; position += 1) {
        const row = indices[position];
        const cluster = labels[row];
        if (cluster < 0 || cluster >= k) continue;
        const weight = weights ? weights[position] : 1;
        mass[cluster] += weight;
        const sourceOffset = row * dimensions;
        const targetOffset = cluster * dimensions;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            centroids[targetOffset + dimension] += vectors[sourceOffset + dimension] * weight;
        }
    }
    const rawMeans = Float64Array.from(centroids);
    for (let cluster = 0; cluster < k; cluster += 1) {
        const offset = cluster * dimensions;
        if (mass[cluster] > 0) {
            for (let dimension = 0; dimension < dimensions; dimension += 1) {
                rawMeans[offset + dimension] /= mass[cluster];
            }
        }
        let norm = 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            norm += centroids[offset + dimension] ** 2;
        }
        const inverse = norm > 0 ? 1 / Math.sqrt(norm) : 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            centroids[offset + dimension] *= inverse;
        }
    }
    return { centroids, rawMeans, mass };
}

function assignToCentroids(vectors, dimensions, centroids, k, indices) {
    const labels = new Int32Array(indices.length);
    for (let position = 0; position < indices.length; position += 1) {
        const sourceOffset = indices[position] * dimensions;
        let bestCluster = 0;
        let bestSimilarity = -Infinity;
        for (let cluster = 0; cluster < k; cluster += 1) {
            const centroidOffset = cluster * dimensions;
            let similarity = 0;
            for (let dimension = 0; dimension < dimensions; dimension += 1) {
                similarity += (
                    vectors[sourceOffset + dimension]
                    * centroids[centroidOffset + dimension]
                );
            }
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestCluster = cluster;
            }
        }
        labels[position] = bestCluster;
    }
    return labels;
}

function subsetLabels(labels, indices) {
    return Int32Array.from(indices, index => labels[index]);
}

function localSourceGroups(selection) {
    const groups = new Map();
    for (let index = 0; index < selection.sourceByIndex.length; index += 1) {
        const source = selection.sourceByIndex[index];
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push(index);
    }
    return groups;
}

function localQuarterGroups(selection, metadata) {
    const groups = new Map();
    for (let position = 0; position < selection.indices.length; position += 1) {
        const quarter = metadata.rows[selection.indices[position]].quarter;
        if (!groups.has(quarter)) groups.set(quarter, []);
        groups.get(quarter).push(position);
    }
    return groups;
}

function adjustedRandIndex(left, right) {
    if (left.length !== right.length || left.length < 2) return null;
    const leftCodes = categoryCodes(left);
    const rightCodes = categoryCodes(right);
    const contingency = weightedContingency(
        leftCodes.codes,
        rightCodes.codes,
        new Float64Array(left.length).fill(1),
        leftCodes.categories,
        rightCodes.categories
    );
    const choose2 = value => value * (value - 1) / 2;
    let sumCells = 0;
    for (const value of contingency.matrix) sumCells += choose2(value);
    let sumRows = 0;
    for (const value of contingency.rows) sumRows += choose2(value);
    let sumColumns = 0;
    for (const value of contingency.columns) sumColumns += choose2(value);
    const pairs = choose2(left.length);
    if (!(pairs > 0)) return null;
    const expected = (sumRows * sumColumns) / pairs;
    const maximum = (sumRows + sumColumns) / 2;
    return maximum !== expected ? (sumCells - expected) / (maximum - expected) : 0;
}

function weightedAgreement(reference, predicted, weights, k) {
    const metrics = partitionMetric(reference, predicted, weights, k, k);
    return {
        nmi: metrics.nmi,
        ariDiagnosticUnweighted: adjustedRandIndex(reference, predicted),
        forwardPurity: metrics.forwardPurity,
        reversePurity: metrics.reversePurity,
    };
}

function sourceBootstrapTrainingWeights(selection, rng) {
    const sourceGroups = localSourceGroups(selection);
    const sourceNames = [...sourceGroups.keys()];
    const multiplicity = new Map();
    for (let draw = 0; draw < sourceNames.length; draw += 1) {
        const source = sourceNames[Math.floor(rng() * sourceNames.length)];
        multiplicity.set(source, (multiplicity.get(source) || 0) + 1);
    }
    const weights = new Float64Array(selection.indices.length);
    for (const [source, count] of multiplicity.entries()) {
        const positions = sourceGroups.get(source);
        for (const position of positions) weights[position] = count / positions.length;
    }
    return weights;
}

function weightedNmiNull(reference, predicted, weights, groups, k, seed) {
    const values = [];
    for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
        const permuted = permuteWithinGroups(
            reference,
            groups,
            createRng(seed + repetition)
        );
        values.push(partitionMetric(
            permuted,
            predicted,
            weights,
            k,
            k
        ).nmi);
    }
    return empiricalTest(
        partitionMetric(reference, predicted, weights, k, k).nmi,
        values
    );
}

function sampleWeightedIndex(weights, rng) {
    let total = 0;
    for (const weight of weights) total += Math.max(0, weight);
    if (!(total > 0)) return Math.floor(rng() * weights.length);
    let target = rng() * total;
    for (let index = 0; index < weights.length; index += 1) {
        target -= Math.max(0, weights[index]);
        if (target <= 0) return index;
    }
    return weights.length - 1;
}

function initializeKmeansPlusPlus(vectors, dimensions, indices, weights, k, rng) {
    const centroids = new Float64Array(k * dimensions);
    const firstPosition = sampleWeightedIndex(weights, rng);
    const copyPoint = (cluster, row) => {
        const sourceOffset = row * dimensions;
        const targetOffset = cluster * dimensions;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            centroids[targetOffset + dimension] = vectors[sourceOffset + dimension];
        }
    };
    copyPoint(0, indices[firstPosition]);
    const distances = new Float64Array(indices.length).fill(2);
    for (let cluster = 1; cluster < k; cluster += 1) {
        const previousOffset = (cluster - 1) * dimensions;
        for (let position = 0; position < indices.length; position += 1) {
            const sourceOffset = indices[position] * dimensions;
            let similarity = 0;
            for (let dimension = 0; dimension < dimensions; dimension += 1) {
                similarity += (
                    vectors[sourceOffset + dimension]
                    * centroids[previousOffset + dimension]
                );
            }
            distances[position] = Math.min(
                distances[position],
                Math.max(0, 1 - similarity)
            );
        }
        const samplingWeights = Float64Array.from(
            distances,
            (distance, position) => (
                weights[position] * distance * distance
            )
        );
        copyPoint(cluster, indices[sampleWeightedIndex(samplingWeights, rng)]);
    }
    return centroids;
}

function normalizeCentroid(centroids, dimensions, cluster) {
    const offset = cluster * dimensions;
    let norm = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
        norm += centroids[offset + dimension] ** 2;
    }
    const inverse = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
        centroids[offset + dimension] *= inverse;
    }
}

function miniBatchSphericalKmeans(vectors, dimensions, selection, k, seed) {
    const rng = createRng(seed);
    const centroids = initializeKmeansPlusPlus(
        vectors,
        dimensions,
        selection.indices,
        selection.weights,
        k,
        rng
    );
    const counts = new Float64Array(k);
    const sourceGroups = localSourceGroups(selection);
    const sources = [...sourceGroups.keys()];
    for (let step = 0; step < CONFIG.miniBatchSteps; step += 1) {
        const touched = new Set();
        for (let draw = 0; draw < CONFIG.miniBatchSize; draw += 1) {
            const source = sources[Math.floor(rng() * sources.length)];
            const positions = sourceGroups.get(source);
            const position = positions[Math.floor(rng() * positions.length)];
            const row = selection.indices[position];
            const sourceOffset = row * dimensions;
            let bestCluster = 0;
            let bestSimilarity = -Infinity;
            for (let cluster = 0; cluster < k; cluster += 1) {
                const centroidOffset = cluster * dimensions;
                let similarity = 0;
                for (let dimension = 0; dimension < dimensions; dimension += 1) {
                    similarity += (
                        vectors[sourceOffset + dimension]
                        * centroids[centroidOffset + dimension]
                    );
                }
                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestCluster = cluster;
                }
            }
            counts[bestCluster] += 1;
            const learningRate = 1 / counts[bestCluster];
            const centroidOffset = bestCluster * dimensions;
            for (let dimension = 0; dimension < dimensions; dimension += 1) {
                centroids[centroidOffset + dimension] += learningRate * (
                    vectors[sourceOffset + dimension]
                    - centroids[centroidOffset + dimension]
                );
            }
            touched.add(bestCluster);
        }
        for (const cluster of touched) normalizeCentroid(centroids, dimensions, cluster);
    }
    return centroids;
}

function analyzeProjectionStability({
    vectors,
    dimensions,
    metadata,
    productionLabels,
    k,
    selection,
    seed,
}) {
    const evaluationLabels = subsetLabels(productionLabels, selection.evaluation.indices);
    const evaluationWeights = selection.evaluation.weights;
    const trainingCentroids = computeCentroids(
        vectors,
        dimensions,
        productionLabels,
        k,
        selection.training.indices,
        selection.training.weights
    );
    const baselinePrediction = assignToCentroids(
        vectors,
        dimensions,
        trainingCentroids.centroids,
        k,
        selection.evaluation.indices
    );
    const baseline = weightedAgreement(
        evaluationLabels,
        baselinePrediction,
        evaluationWeights,
        k
    );
    const bootstrapNmi = [];
    const bootstrapAri = [];
    const bootstrapPurity = [];
    const sameClusterMass = new Float64Array(k);
    const totalClusterMass = new Float64Array(k);
    for (let repetition = 0; repetition < CONFIG.bootstrapRuns; repetition += 1) {
        const bootstrapWeights = sourceBootstrapTrainingWeights(
            selection.training,
            createRng(seed + 1000 + repetition)
        );
        const centroids = computeCentroids(
            vectors,
            dimensions,
            productionLabels,
            k,
            selection.training.indices,
            bootstrapWeights
        );
        const prediction = assignToCentroids(
            vectors,
            dimensions,
            centroids.centroids,
            k,
            selection.evaluation.indices
        );
        const agreement = weightedAgreement(
            evaluationLabels,
            prediction,
            evaluationWeights,
            k
        );
        bootstrapNmi.push(agreement.nmi);
        bootstrapAri.push(agreement.ariDiagnosticUnweighted);
        bootstrapPurity.push(agreement.forwardPurity);
        for (let index = 0; index < evaluationLabels.length; index += 1) {
            const cluster = evaluationLabels[index];
            totalClusterMass[cluster] += evaluationWeights[index];
            if (prediction[index] === cluster) sameClusterMass[cluster] += evaluationWeights[index];
        }
    }
    const deNovoAssignments = [];
    const deNovoProductionNmi = [];
    const deNovoProductionAri = [];
    for (let run = 0; run < CONFIG.deNovoRuns; run += 1) {
        const centroids = miniBatchSphericalKmeans(
            vectors,
            dimensions,
            selection.training,
            k,
            seed + 5000 + run
        );
        const prediction = assignToCentroids(
            vectors,
            dimensions,
            centroids,
            k,
            selection.evaluation.indices
        );
        const agreement = weightedAgreement(
            evaluationLabels,
            prediction,
            evaluationWeights,
            k
        );
        deNovoAssignments.push(prediction);
        deNovoProductionNmi.push(agreement.nmi);
        deNovoProductionAri.push(agreement.ariDiagnosticUnweighted);
    }
    const pairwiseDeNovoNmi = [];
    for (let left = 0; left < deNovoAssignments.length; left += 1) {
        for (let right = left + 1; right < deNovoAssignments.length; right += 1) {
            pairwiseDeNovoNmi.push(partitionMetric(
                deNovoAssignments[left],
                deNovoAssignments[right],
                evaluationWeights,
                k,
                k
            ).nmi);
        }
    }
    const sourceNull = weightedNmiNull(
        evaluationLabels,
        baselinePrediction,
        evaluationWeights,
        localSourceGroups(selection.evaluation),
        k,
        seed + 8000
    );
    const timeNull = weightedNmiNull(
        evaluationLabels,
        baselinePrediction,
        evaluationWeights,
        localQuarterGroups(selection.evaluation, metadata),
        k,
        seed + 9000
    );
    return {
        evaluation: {
            rows: evaluationLabels.length,
            sources: selection.evaluation.sources.length,
        },
        conditionalCentroidRecoverability: {
            definition: 'Production cluster memberships are fixed. Equal-source training centroids are recomputed, then unseen-source observations are assigned to their nearest centroid.',
            baseline: Object.fromEntries(
                Object.entries(baseline).map(([key, value]) => [key, round(value)])
            ),
            sourceBootstrap: {
                runs: CONFIG.bootstrapRuns,
                nmi: summarize(bootstrapNmi),
                ariDiagnosticUnweighted: summarize(bootstrapAri),
                forwardPurity: summarize(bootstrapPurity),
            },
            clusterCoreRecovery: Array.from({ length: k }, (_, cluster) => ({
                cluster,
                sourceBalancedEvaluationMass: round(
                    totalClusterMass[cluster] / CONFIG.bootstrapRuns
                ),
                bootstrapSameProductionClusterProbability: totalClusterMass[cluster] > 0
                    ? round(sameClusterMass[cluster] / totalClusterMass[cluster])
                    : null,
            })),
            nulls: {
                sourcePreserving: sourceNull,
                timePreserving: timeNull,
            },
        },
        deNovoOptimizationSensitivity: {
            definition: 'Independent spherical mini-batch k-means starts in the reduced, outcome-blind geometry. This tests optimizer/representation sensitivity without initializing from production labels.',
            runs: CONFIG.deNovoRuns,
            productionNmi: summarize(deNovoProductionNmi),
            productionAriDiagnosticUnweighted: summarize(deNovoProductionAri),
            pairwiseRunNmi: summarize(pairwiseDeNovoNmi),
        },
    };
}

function analyzeEmbeddingStability({
    projections,
    metadata,
    map,
    format,
    modality,
}) {
    const selection = selectSourceBalancedRows(
        metadata,
        CONFIG.seed + stableHash32(`${format}:${modality}`)
    );
    const partitions = [];
    const sharedCentroids = {};
    for (const k of RESOLUTIONS) {
        const labels = Int32Array.from(map.clusters[String(k)] || []);
        if (labels.length !== metadata.rows.length) continue;
        const projectionAudits = projections.map((vectors, projectionIndex) => (
            analyzeProjectionStability({
                vectors,
                dimensions: CONFIG.projectionDimensions,
                metadata,
                productionLabels: labels,
                k,
                selection,
                seed: CONFIG.seed
                    + stableHash32(`${format}:${modality}:${k}:${projectionIndex}`),
            })
        ));
        sharedCentroids[String(k)] = projections.map(vectors => computeCentroids(
            vectors,
            CONFIG.projectionDimensions,
            labels,
            k,
            metadata.rows.map(row => row.index),
            metadata.sourceWeights
        ));
        partitions.push({
            k,
            projections: projectionAudits.map((audit, index) => ({
                projection: `countsketch-${index + 1}`,
                seed: CONFIG.projectionSeeds[index],
                ...audit,
            })),
            projectionSensitivity: {
                conditionalBaselineNmiRange: summarize(projectionAudits.map(
                    audit => audit.conditionalCentroidRecoverability.baseline.nmi
                )),
                deNovoProductionNmiRange: summarize(projectionAudits.map(
                    audit => audit.deNovoOptimizationSensitivity.productionNmi.mean
                )),
            },
        });
    }
    return {
        method: {
            input: 'The exact production 1,536-dimensional embedding archive.',
            normalization: 'Each original vector is L2-normalized, projected through two independent signed CountSketch transforms, and L2-normalized again.',
            targetDimensions: CONFIG.projectionDimensions,
            projectionSeeds: CONFIG.projectionSeeds,
            sourceSplit: selection.split,
            bootstrapScope: 'Conditional centroid bootstrap plus separate de-novo optimization sensitivity. It is not a full re-embedding bootstrap.',
        },
        partitions,
        sharedCentroids,
    };
}

function weightedEtaSquared(labels, values, weights, k) {
    const center = weightedMean(values, weights);
    if (!Number.isFinite(center)) return null;
    const mass = new Float64Array(k);
    const sums = new Float64Array(k);
    let totalVariance = 0;
    for (let index = 0; index < labels.length; index += 1) {
        const weight = weights[index];
        const cluster = labels[index];
        if (!(weight > 0) || cluster < 0 || cluster >= k) continue;
        mass[cluster] += weight;
        sums[cluster] += weight * values[index];
        totalVariance += weight * ((values[index] - center) ** 2);
    }
    let between = 0;
    for (let cluster = 0; cluster < k; cluster += 1) {
        if (mass[cluster] > 0) {
            between += mass[cluster] * (((sums[cluster] / mass[cluster]) - center) ** 2);
        }
    }
    return totalVariance > 0 ? between / totalVariance : null;
}

function centerWithinGroups(values, groups) {
    const output = new Float64Array(values.length);
    for (const indices of groups.values()) {
        let total = 0;
        for (const index of indices) total += values[index];
        const center = total / indices.length;
        for (const index of indices) output[index] = values[index] - center;
    }
    return output;
}

function sourceConcentration(labels, metadata, k, seed) {
    const eligibleRows = [];
    const sourceSizes = new Map();
    for (const row of metadata.rows) {
        sourceSizes.set(row.sourceId, (sourceSizes.get(row.sourceId) || 0) + 1);
    }
    for (let index = 0; index < metadata.rows.length; index += 1) {
        if ((sourceSizes.get(metadata.rows[index].sourceId) || 0) >= 5) {
            eligibleRows.push(index);
        }
    }
    const eligibleSources = categoryCodes(
        eligibleRows.map(index => metadata.rows[index].sourceId)
    );
    const eligibleLabels = Int32Array.from(eligibleRows, index => labels[index]);
    const groups = groupIndices(
        eligibleRows.map(index => metadata.rows[index]),
        row => row.sourceId
    );
    const weights = equalGroupWeights(eligibleRows.length, groups);
    const observed = partitionMetric(
        eligibleLabels,
        eligibleSources.codes,
        weights,
        k,
        eligibleSources.categories
    );
    const quarterGroups = groupIndices(
        eligibleRows.map(index => metadata.rows[index]),
        row => row.quarter
    );
    const nullNmi = [];
    for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
        const permuted = permuteWithinGroups(
            eligibleLabels,
            quarterGroups,
            createRng(seed + repetition)
        );
        nullNmi.push(partitionMetric(
            permuted,
            eligibleSources.codes,
            weights,
            k,
            eligibleSources.categories
        ).nmi);
    }
    const sourceMassByCluster = Array.from({ length: k }, () => new Map());
    for (let index = 0; index < metadata.rows.length; index += 1) {
        const cluster = labels[index];
        const source = metadata.rows[index].sourceId;
        const current = sourceMassByCluster[cluster].get(source) || 0;
        sourceMassByCluster[cluster].set(source, current + 1);
    }
    const clusterDominance = sourceMassByCluster.map((sources, cluster) => {
        const counts = [...sources.values()];
        const total = counts.reduce((sum, value) => sum + value, 0);
        const probabilities = counts.map(value => value / Math.max(1, total));
        const entropy = -probabilities.reduce(
            (sum, probability) => sum + (probability > 0 ? probability * Math.log(probability) : 0),
            0
        );
        return {
            cluster,
            observations: total,
            sources: sources.size,
            largestSourceShare: round(counts.length ? Math.max(...counts) / total : null),
            effectiveSources: round(Math.exp(entropy)),
        };
    });
    return {
        eligibleMinimumVideosPerSource: 5,
        rows: eligibleRows.length,
        sources: eligibleSources.categories,
        sourceBalancedNmi: round(observed.nmi),
        timePreservingPermutation: empiricalTest(observed.nmi, nullNmi),
        clusterDominance,
        interpretationBoundary: 'Source NMI is a dependence diagnostic, not proof that source caused the partition. Restricting to sources with at least five mapped videos changes the estimand.',
    };
}

function clusterOutcomeDiagnostic(labels, metadata, k, outcomeValidity) {
    if (outcomeValidity === 'not_evaluated') {
        return {
            postHocOnly: true,
            validity: 'not_evaluated',
            reason: 'Legacy map/database outcomes are disabled. Supply a snapshot-matched strict panel for outcome testing or explicitly pass --exploratory-outcomes.',
        };
    }
    const logViews = Float64Array.from(metadata.rows, row => row.logViews);
    const sourceCentered = centerWithinGroups(logViews, metadata.sourceGroups);
    const quarterCentered = centerWithinGroups(logViews, metadata.quarterGroups);
    return {
        postHocOnly: true,
        validity: outcomeValidity,
        globalLogViewsEtaSquared: round(weightedEtaSquared(
            labels,
            logViews,
            metadata.sourceWeights,
            k
        )),
        withinSourceLogViewsEtaSquared: round(weightedEtaSquared(
            labels,
            sourceCentered,
            metadata.sourceWeights,
            k
        )),
        withinQuarterLogViewsEtaSquared: round(weightedEtaSquared(
            labels,
            quarterCentered,
            metadata.sourceWeights,
            k
        )),
        boundary: outcomeValidity === 'invalid_legacy_panel_exploratory_only'
            ? 'INVALID FOR CONFIRMATION: these map/database outcomes do not have atomic per-row observation time. Values are retained only as an explicitly exploratory diagnostic.'
            : 'Outcomes are attached only after the outcome-blind partition is frozen. Eta-squared is in-sample association and is not used as evidence of transport.',
    };
}

function analyzeMapGeometry(map, metadata, format, modality, outcomeValidity) {
    const labelSets = RESOLUTIONS
        .map(k => ({
            k,
            labels: Int32Array.from(map.clusters[String(k)] || []),
        }))
        .filter(row => row.labels.length === metadata.rows.length);
    const lineages = [];
    for (let index = 0; index < labelSets.length - 1; index += 1) {
        const left = labelSets[index];
        const right = labelSets[index + 1];
        lineages.push({
            fromK: left.k,
            toK: right.k,
            ...analyzeTransport({
                labelsA: left.labels,
                labelsB: right.labels,
                metadata,
                countA: left.k,
                countB: right.k,
                seed: CONFIG.seed + stableHash32(
                    `${format}:${modality}:${left.k}:${right.k}`
                ),
            }),
        });
    }
    return {
        partitions: labelSets.map(({ k, labels }) => ({
            k,
            observations: labels.length,
            sourceConcentration: sourceConcentration(
                labels,
                metadata,
                k,
                CONFIG.seed + stableHash32(`${format}:${modality}:${k}:source`)
            ),
            outcomeDiagnostic: clusterOutcomeDiagnostic(
                labels,
                metadata,
                k,
                outcomeValidity
            ),
        })),
        adjacentLineages: lineages,
        strictCrossResolutionCore: clusterCorePaths(labelSets, metadata.sourceWeights),
    };
}

function alignedMetadata(leftMap, rightMap, database, format) {
    const rightIndex = new Map(
        rightMap.id.map((id, index) => [String(id), index])
    );
    const leftIndices = [];
    const rightIndices = [];
    const pseudoMap = {
        id: [],
        views: [],
        outlier: [],
        owner: [],
        silent: [],
    };
    for (let left = 0; left < leftMap.id.length; left += 1) {
        const id = String(leftMap.id[left]);
        const right = rightIndex.get(id);
        if (right === undefined) continue;
        leftIndices.push(left);
        rightIndices.push(right);
        pseudoMap.id.push(id);
        pseudoMap.views.push(finite(leftMap.views?.[left], finite(rightMap.views?.[right], 0)));
        pseudoMap.outlier.push(finite(leftMap.outlier?.[left], finite(rightMap.outlier?.[right])));
        pseudoMap.owner.push(leftMap.owner?.[left] || rightMap.owner?.[right] || '');
        pseudoMap.silent.push(Boolean(leftMap.silent?.[left] || rightMap.silent?.[right]));
    }
    return {
        leftIndices,
        rightIndices,
        metadata: buildMetadata(pseudoMap, database, format),
    };
}

function analyzeCrossModal(format, maps, database, channelIntegrity) {
    const output = [];
    for (const [leftName, rightName] of MODALITY_PAIRS) {
        const leftIntegrity = channelIntegrity.get(`${format}:${leftName}`);
        const rightIntegrity = channelIntegrity.get(`${format}:${rightName}`);
        if (!leftIntegrity?.accepted || !rightIntegrity?.accepted) {
            output.push({
                format,
                left: leftName,
                right: rightName,
                status: 'rejected_identity_integrity_failure',
                reason: 'Cross-modal transport is not computed unless both frozen map/vector pairs pass exact ID-order verification.',
                failedInputs: [
                    !leftIntegrity?.accepted ? `${format}:${leftName}` : null,
                    !rightIntegrity?.accepted ? `${format}:${rightName}` : null,
                ].filter(Boolean),
                resolutions: [],
            });
            continue;
        }
        const leftMap = maps[leftName];
        const rightMap = maps[rightName];
        const alignment = alignedMetadata(leftMap, rightMap, database, format);
        const resolutions = [];
        for (const k of RESOLUTIONS) {
            const leftLabels = Int32Array.from(
                alignment.leftIndices,
                index => leftMap.clusters[String(k)]?.[index] ?? -1
            );
            const rightLabels = Int32Array.from(
                alignment.rightIndices,
                index => rightMap.clusters[String(k)]?.[index] ?? -1
            );
            const result = analyzeTransport({
                labelsA: leftLabels,
                labelsB: rightLabels,
                metadata: alignment.metadata,
                countA: k,
                countB: k,
                seed: CONFIG.seed + stableHash32(
                    `${format}:${leftName}:${rightName}:${k}`
                ),
            });
            const subsets = {};
            if (
                format === 'shorts'
                && [leftName, rightName].includes('visual')
                && [leftName, rightName].includes('together')
            ) {
                for (const [subsetName, expectedSilent] of [['silent', true], ['voiced', false]]) {
                    const selected = [];
                    for (let index = 0; index < alignment.metadata.rows.length; index += 1) {
                        if (alignment.metadata.rows[index].silent === expectedSilent) selected.push(index);
                    }
                    if (selected.length >= k * 2) {
                        const subsetMap = {
                            id: selected.map(index => alignment.metadata.rows[index].id),
                            views: selected.map(index => alignment.metadata.rows[index].views),
                            outlier: selected.map(index => alignment.metadata.rows[index].outlier),
                            owner: selected.map(() => ''),
                            silent: selected.map(() => expectedSilent),
                        };
                        const subsetMetadata = buildMetadata(subsetMap, database, format);
                        subsets[subsetName] = {
                            observations: selected.length,
                            ...analyzeTransport({
                                labelsA: Int32Array.from(selected, index => leftLabels[index]),
                                labelsB: Int32Array.from(selected, index => rightLabels[index]),
                                metadata: subsetMetadata,
                                countA: k,
                                countB: k,
                                seed: CONFIG.seed + stableHash32(
                                    `${format}:${leftName}:${rightName}:${k}:${subsetName}`
                                ),
                            }),
                        };
                    }
                }
            }
            resolutions.push({ k, ...result, subsets });
        }
        output.push({
            format,
            left: leftName,
            right: rightName,
            status: 'accepted_outcome_blind_geometry',
            commonObservations: alignment.metadata.rows.length,
            metadataCoverage: alignment.metadata.coverage,
            resolutions,
        });
    }
    return output;
}

function buildMechanismPanel(format, maps, database, strictPanel = null) {
    const textIndex = new Map(
        maps.text.id.map((id, index) => [String(id), index])
    );
    const togetherIndex = new Map(
        maps.together.id.map((id, index) => [String(id), index])
    );
    const visualIndices = [];
    const textIndices = [];
    const togetherIndices = [];
    const pseudoMap = {
        id: [],
        views: [],
        outlier: [],
        owner: [],
        silent: [],
    };
    const strictRows = [];
    let strictRawViewRows = 0;
    for (let visual = 0; visual < maps.visual.id.length; visual += 1) {
        const id = String(maps.visual.id[visual]);
        const text = textIndex.get(id);
        const together = togetherIndex.get(id);
        if (text === undefined || together === undefined) continue;
        const strictRow = strictPanel?.byObservation.get(`${format}:${id}`) || null;
        if (strictPanel && !strictRow) continue;
        visualIndices.push(visual);
        textIndices.push(text);
        togetherIndices.push(together);
        pseudoMap.id.push(id);
        const strictViews = strictRow
            ? firstFinite(strictRow.views, strictRow.outcomes?.views)
            : null;
        if (strictViews != null) strictRawViewRows += 1;
        pseudoMap.views.push(
            strictRow
                ? (strictViews ?? 0)
                : finite(maps.visual.views?.[visual], 0)
        );
        pseudoMap.outlier.push(finite(maps.visual.outlier?.[visual]));
        pseudoMap.owner.push(
            maps.visual.owner?.[visual]
            || maps.text.owner?.[text]
            || maps.together.owner?.[together]
            || ''
        );
        pseudoMap.silent.push(Boolean(maps.visual.silent?.[visual]));
        strictRows.push(strictRow);
    }
    const metadata = buildMetadata(pseudoMap, database, format);
    if (strictPanel) {
        for (let index = 0; index < metadata.rows.length; index += 1) {
            const strictRow = strictRows[index];
            metadata.rows[index].sourceId = strictRow.sourceId;
            metadata.rows[index].publishedSeconds = strictRow.publishedSeconds;
            metadata.rows[index].quarter = quarterFromSeconds(strictRow.publishedSeconds);
            metadata.rows[index].observedSeconds = strictRow.observedSeconds;
            metadata.rows[index].historicalPriorCount = strictRow.priorCount;
            metadata.rows[index].latestPriorObservedSeconds = strictRow.latestPriorObservedSeconds;
            metadata.rows[index].strictTarget = strictRow.target;
        }
        metadata.sourceGroups = groupIndices(metadata.rows, row => row.sourceId);
        metadata.quarterGroups = groupIndices(metadata.rows, row => row.quarter);
        metadata.sourceQuarterGroups = groupIndices(
            metadata.rows,
            row => `${row.sourceId}\u0000${row.quarter}`
        );
        metadata.sourceWeights = equalGroupWeights(
            metadata.rows.length,
            metadata.sourceGroups
        );
        metadata.coverage.sources = metadata.sourceGroups.size;
        metadata.coverage.quarters = metadata.quarterGroups.size;
    }
    const labels = {};
    for (const k of RESOLUTIONS) {
        labels[String(k)] = {
            visual: Int32Array.from(
                visualIndices,
                index => maps.visual.clusters[String(k)]?.[index] ?? -1
            ),
            text: Int32Array.from(
                textIndices,
                index => maps.text.clusters[String(k)]?.[index] ?? -1
            ),
            together: Int32Array.from(
                togetherIndices,
                index => maps.together.clusters[String(k)]?.[index] ?? -1
            ),
        };
    }
    return {
        format,
        metadata,
        labels,
        rows: metadata.rows,
        outcomeContract: strictPanel
            ? {
                validity: strictPanel.validity,
                target: strictPanel.target,
                snapshotRunId: strictPanel.snapshotRunId,
                strictPanelRows: strictPanel.acceptedRows,
                completeCaseRows: metadata.rows.length,
                rawViewRows: strictRawViewRows,
                rawViewCoverage: strictRawViewRows / Math.max(1, metadata.rows.length),
                sourcePath: strictPanel.sourcePath,
                sourceSha256: strictPanel.sourceSha256,
            }
            : {
                validity: 'invalid_legacy_panel_exploratory_only',
                target: 'Current-snapshot log views centered inside source.',
            },
    };
}

function selectionWeights(metadata, indices) {
    const groups = new Map();
    for (const index of indices) {
        const source = metadata.rows[index].sourceId;
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push(index);
    }
    const weights = new Float64Array(metadata.rows.length);
    for (const rows of groups.values()) {
        const weight = 1 / rows.length;
        for (const index of rows) weights[index] = weight;
    }
    return { weights, sources: groups.size, groups };
}

function selectedGroupMap(metadata, indices, keyFunction) {
    const localPosition = new Map(indices.map((index, position) => [index, position]));
    const groups = new Map();
    for (const index of indices) {
        const key = String(keyFunction(metadata.rows[index]));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(localPosition.get(index));
    }
    return groups;
}

function centerTargetWithinSelection(metadata, indices, values) {
    const groups = new Map();
    for (const index of indices) {
        const source = metadata.rows[index].sourceId;
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push(index);
    }
    const target = new Float64Array(values.length);
    for (const group of groups.values()) {
        const center = mean(group.map(index => values[index]));
        for (const index of group) target[index] = values[index] - center;
    }
    return target;
}

function fitClusterEffectModel({
    panel,
    k,
    indices,
    target,
    lambdaAdd,
    lambdaPair,
    includePairs,
}) {
    const labelSet = panel.labels[String(k)];
    const modalities = ['visual', 'text', 'together'];
    const weighting = selectionWeights(panel.metadata, indices);
    const base = weightedMean(
        indices.map(index => target[index]),
        indices.map(index => weighting.weights[index])
    ) || 0;
    const effects = Object.fromEntries(
        modalities.map(modality => [modality, new Float64Array(k)])
    );
    const masses = Object.fromEntries(
        modalities.map(modality => [modality, new Float64Array(k)])
    );
    for (let sweep = 0; sweep < 4; sweep += 1) {
        for (const modality of modalities) {
            const sums = new Float64Array(k);
            const mass = new Float64Array(k);
            for (const index of indices) {
                const weight = weighting.weights[index];
                const cluster = labelSet[modality][index];
                let residual = target[index] - base;
                for (const other of modalities) {
                    if (other !== modality) {
                        residual -= effects[other][labelSet[other][index]];
                    }
                }
                sums[cluster] += weight * residual;
                mass[cluster] += weight;
            }
            for (let cluster = 0; cluster < k; cluster += 1) {
                effects[modality][cluster] = sums[cluster] / (mass[cluster] + lambdaAdd);
                masses[modality][cluster] = mass[cluster];
            }
        }
    }
    const pairs = {};
    const pairMasses = {};
    const pairRawSupport = {};
    const pairSources = {};
    if (includePairs) {
        for (const [left, right] of PAIR_KEYS) {
            const key = `${left}+${right}`;
            const sums = new Float64Array(k * k);
            const mass = new Float64Array(k * k);
            const raw = new Uint32Array(k * k);
            const sources = Array.from({ length: k * k }, () => new Set());
            for (const index of indices) {
                const leftCluster = labelSet[left][index];
                const rightCluster = labelSet[right][index];
                const cell = (leftCluster * k) + rightCluster;
                const additive = base + (
                    effects.visual[labelSet.visual[index]]
                    + effects.text[labelSet.text[index]]
                    + effects.together[labelSet.together[index]]
                );
                const residual = target[index] - additive;
                const weight = weighting.weights[index];
                sums[cell] += weight * residual;
                mass[cell] += weight;
                raw[cell] += 1;
                sources[cell].add(panel.metadata.rows[index].sourceId);
            }
            const values = new Float64Array(k * k);
            for (let cell = 0; cell < values.length; cell += 1) {
                values[cell] = sums[cell] / (mass[cell] + lambdaPair);
            }
            pairs[key] = values;
            pairMasses[key] = mass;
            pairRawSupport[key] = raw;
            pairSources[key] = Uint32Array.from(sources, value => value.size);
        }
    }
    return {
        k,
        base,
        effects,
        masses,
        pairs,
        pairMasses,
        pairRawSupport,
        pairSources,
        lambdaAdd,
        lambdaPair,
        includePairs,
    };
}

function predictClusterEffectModel(model, panel, indices, includePairs = model.includePairs) {
    const labelSet = panel.labels[String(model.k)];
    const predictions = new Float64Array(indices.length);
    for (let position = 0; position < indices.length; position += 1) {
        const index = indices[position];
        let prediction = model.base + (
            model.effects.visual[labelSet.visual[index]]
            + model.effects.text[labelSet.text[index]]
            + model.effects.together[labelSet.together[index]]
        );
        if (includePairs) {
            let pairSum = 0;
            let pairCount = 0;
            for (const [left, right] of PAIR_KEYS) {
                const key = `${left}+${right}`;
                if (!model.pairs[key]) continue;
                pairSum += model.pairs[key][
                    (labelSet[left][index] * model.k) + labelSet[right][index]
                ];
                pairCount += 1;
            }
            if (pairCount) prediction += pairSum / pairCount;
        }
        predictions[position] = prediction;
    }
    return predictions;
}

function evaluatePredictions(panel, indices, target, predictions) {
    const weighting = selectionWeights(panel.metadata, indices);
    const actual = indices.map(index => target[index]);
    const weights = indices.map(index => weighting.weights[index]);
    return {
        rows: indices.length,
        sources: weighting.sources,
        pearson: round(weightedCorrelation(actual, predictions, weights)),
        spearman: round(weightedSpearman(actual, predictions, weights)),
        r2: round(weightedRSquared(actual, predictions, weights)),
        predictionSd: round(Math.sqrt(
            weightedMean(
                Array.from(predictions, value => (
                    (value - weightedMean(predictions, weights)) ** 2
                )),
                weights
            ) || 0
        )),
        actualSd: round(Math.sqrt(
            weightedMean(
                actual.map(value => (
                    (value - weightedMean(actual, weights)) ** 2
                )),
                weights
            ) || 0
        )),
    };
}

function tuneEffectModel(panel, k, indices, target, includePairs) {
    const innerTrain = [];
    const innerValidation = [];
    for (const index of indices) {
        const source = panel.metadata.rows[index].sourceId;
        if ((stableHash32(source, CONFIG.seed + k) % 5) === 0) {
            innerValidation.push(index);
        } else {
            innerTrain.push(index);
        }
    }
    if (innerValidation.length < 50 || innerTrain.length < 100) {
        return {
            lambdaAdd: 20,
            lambdaPair: includePairs ? 100 : null,
            tuningRows: 0,
            tuningScore: null,
        };
    }
    const additiveGrid = [1, 5, 20, 100];
    const pairGrid = includePairs ? [5, 20, 100, 500] : [null];
    let best = null;
    for (const lambdaAdd of additiveGrid) {
        for (const lambdaPair of pairGrid) {
            const model = fitClusterEffectModel({
                panel,
                k,
                indices: innerTrain,
                target,
                lambdaAdd,
                lambdaPair,
                includePairs,
            });
            const predictions = predictClusterEffectModel(
                model,
                panel,
                innerValidation
            );
            const evaluation = evaluatePredictions(
                panel,
                innerValidation,
                target,
                predictions
            );
            const score = Number.isFinite(evaluation.pearson)
                ? evaluation.pearson
                : -Infinity;
            if (
                !best
                || score > best.score
                || (
                    score === best.score
                    && (lambdaAdd + (lambdaPair || 0))
                        > (best.lambdaAdd + (best.lambdaPair || 0))
                )
            ) {
                best = { lambdaAdd, lambdaPair, score };
            }
        }
    }
    return {
        lambdaAdd: best.lambdaAdd,
        lambdaPair: best.lambdaPair,
        tuningRows: innerValidation.length,
        tuningScore: round(best.score),
        grid: { additive: additiveGrid, pair: pairGrid },
        tieBreak: 'Stronger shrinkage wins exact ties.',
    };
}

function predictionPermutationTest({
    panel,
    indices,
    target,
    predictions,
    groupKey,
    seed,
}) {
    const actual = indices.map(index => target[index]);
    const weighting = selectionWeights(panel.metadata, indices);
    const weights = indices.map(index => weighting.weights[index]);
    const groups = selectedGroupMap(panel.metadata, indices, groupKey);
    const observed = weightedCorrelation(actual, predictions, weights);
    const nullValues = [];
    for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
        const permuted = permuteNumericWithinGroups(
            actual,
            groups,
            createRng(seed + repetition)
        );
        nullValues.push(weightedCorrelation(permuted, predictions, weights));
    }
    return {
        mobility: mobility(groups, indices.length),
        ...empiricalTest(observed, nullValues),
    };
}

function permuteNumericWithinGroups(values, groups, rng) {
    const output = Float64Array.from(values);
    for (const indices of groups.values()) {
        if (indices.length <= 1) continue;
        const shuffled = indices.map(index => output[index]);
        shuffle(shuffled, rng);
        for (let position = 0; position < indices.length; position += 1) {
            output[indices[position]] = shuffled[position];
        }
    }
    return output;
}

function sourceFoldValidation(panel, k, target, targetDescription) {
    const predictions = {
        additive: new Float64Array(panel.rows.length),
        relationships: new Float64Array(panel.rows.length),
    };
    const tested = new Uint8Array(panel.rows.length);
    const foldDetails = [];
    const relationshipModels = [];
    for (let fold = 0; fold < 5; fold += 1) {
        const training = [];
        const testing = [];
        for (let index = 0; index < panel.rows.length; index += 1) {
            const sourceFold = stableHash32(
                panel.rows[index].sourceId,
                CONFIG.seed
            ) % 5;
            if (sourceFold === fold) testing.push(index);
            else training.push(index);
        }
        const additiveTuning = tuneEffectModel(panel, k, training, target, false);
        const relationshipTuning = tuneEffectModel(panel, k, training, target, true);
        const additiveModel = fitClusterEffectModel({
            panel,
            k,
            indices: training,
            target,
            ...additiveTuning,
            includePairs: false,
        });
        const relationshipModel = fitClusterEffectModel({
            panel,
            k,
            indices: training,
            target,
            ...relationshipTuning,
            includePairs: true,
        });
        const additivePrediction = predictClusterEffectModel(
            additiveModel,
            panel,
            testing
        );
        const relationshipPrediction = predictClusterEffectModel(
            relationshipModel,
            panel,
            testing
        );
        for (let position = 0; position < testing.length; position += 1) {
            const index = testing[position];
            predictions.additive[index] = additivePrediction[position];
            predictions.relationships[index] = relationshipPrediction[position];
            tested[index] = 1;
        }
        relationshipModels.push(relationshipModel);
        foldDetails.push({
            fold,
            trainingRows: training.length,
            testingRows: testing.length,
            additiveTuning,
            relationshipTuning,
            additive: evaluatePredictions(
                panel,
                testing,
                target,
                additivePrediction
            ),
            relationships: evaluatePredictions(
                panel,
                testing,
                target,
                relationshipPrediction
            ),
        });
    }
    const testing = [];
    for (let index = 0; index < tested.length; index += 1) {
        if (tested[index]) testing.push(index);
    }
    const additiveValues = Float64Array.from(
        testing,
        index => predictions.additive[index]
    );
    const relationshipValues = Float64Array.from(
        testing,
        index => predictions.relationships[index]
    );
    const additive = evaluatePredictions(
        panel,
        testing,
        target,
        additiveValues
    );
    const relationships = evaluatePredictions(
        panel,
        testing,
        target,
        relationshipValues
    );
    return {
        split: 'Five deterministic folds grouped by canonical channel ID.',
        target: targetDescription,
        folds: foldDetails,
        additive,
        relationships,
        relationshipDelta: {
            pearson: round(relationships.pearson - additive.pearson),
            spearman: round(relationships.spearman - additive.spearman),
            r2: round(relationships.r2 - additive.r2),
        },
        null: predictionPermutationTest({
            panel,
            indices: testing,
            target,
            predictions: relationshipValues,
            groupKey: row => row.sourceId,
            seed: CONFIG.seed + stableHash32(`${panel.format}:${k}:source-null`),
        }),
        relationshipModels,
    };
}

function historicalTarget(panel, training, testing) {
    const globalMean = mean(training.map(index => panel.rows[index].logViews));
    const sourceValues = new Map();
    for (const index of training) {
        const source = panel.rows[index].sourceId;
        if (!sourceValues.has(source)) sourceValues.set(source, []);
        sourceValues.get(source).push(panel.rows[index].logViews);
    }
    const sourceMeans = new Map(
        [...sourceValues.entries()].map(([source, values]) => [source, mean(values)])
    );
    const target = new Float64Array(panel.rows.length);
    for (const index of training) {
        target[index] = panel.rows[index].logViews
            - (sourceMeans.get(panel.rows[index].sourceId) ?? globalMean);
    }
    for (const index of testing) {
        target[index] = panel.rows[index].logViews
            - (sourceMeans.get(panel.rows[index].sourceId) ?? globalMean);
    }
    return {
        target,
        historicalSources: sourceMeans.size,
        testingSourcesSeenHistorically: new Set(
            testing
                .map(index => panel.rows[index].sourceId)
                .filter(source => sourceMeans.has(source))
        ).size,
        globalMean,
    };
}

function forwardValidation(
    panel,
    k,
    suppliedTarget,
    targetDescription,
    sourceFold = null
) {
    const strictTarget = panel.outcomeContract.validity
        === 'strict_panel_eligible_for_holdout_testing';
    const timed = panel.rows
        .map((row, index) => ({ index, time: row.publishedSeconds }))
        .filter(row => Number.isFinite(row.time))
        .sort((left, right) => left.time - right.time);
    const cutoff = timed[Math.floor(timed.length * 0.7)]?.time;
    const training = [];
    const testing = [];
    let unavailableTrainingTargets = 0;
    for (const row of timed) {
        const fold = stableHash32(
            panel.rows[row.index].sourceId,
            CONFIG.seed
        ) % 5;
        const targetObservedByCutoff = (
            !strictTarget
            || (
                Number.isFinite(panel.rows[row.index].observedSeconds)
                && panel.rows[row.index].observedSeconds <= cutoff
            )
        );
        if (
            row.time < cutoff
            && (sourceFold == null || fold !== sourceFold)
            && targetObservedByCutoff
        ) {
            training.push(row.index);
        } else if (row.time >= cutoff && (sourceFold == null || fold === sourceFold)) {
            testing.push(row.index);
        } else if (
            strictTarget
            && row.time < cutoff
            && (sourceFold == null || fold !== sourceFold)
        ) {
            unavailableTrainingTargets += 1;
        }
    }
    const trainingSourceSet = new Set(
        training.map(index => panel.rows[index].sourceId)
    );
    const maximumTrainingObservedSeconds = strictTarget && training.length
        ? Math.max(...training.map(index => panel.rows[index].observedSeconds))
        : null;
    const minimumTestingPublishedSeconds = testing.length
        ? Math.min(...testing.map(index => panel.rows[index].publishedSeconds))
        : null;
    const historical = strictTarget
        ? {
            target: suppliedTarget,
            historicalSources: trainingSourceSet.size,
            testingSourcesSeenHistorically: new Set(
                testing
                    .map(index => panel.rows[index].sourceId)
                    .filter(source => trainingSourceSet.has(source))
            ).size,
            globalMean: null,
        }
        : historicalTarget(panel, training, testing);
    const rawViewDiagnosticAvailable = (
        !strictTarget
        || panel.outcomeContract.rawViewRows === panel.rows.length
    );
    const sourceRelativeTarget = rawViewDiagnosticAvailable
        ? centerTargetWithinSelection(
            panel.metadata,
            testing,
            Float64Array.from(panel.rows, row => row.logViews)
        )
        : null;
    const additiveTuning = tuneEffectModel(
        panel,
        k,
        training,
        historical.target,
        false
    );
    const relationshipTuning = tuneEffectModel(
        panel,
        k,
        training,
        historical.target,
        true
    );
    const additiveModel = fitClusterEffectModel({
        panel,
        k,
        indices: training,
        target: historical.target,
        ...additiveTuning,
        includePairs: false,
    });
    const relationshipModel = fitClusterEffectModel({
        panel,
        k,
        indices: training,
        target: historical.target,
        ...relationshipTuning,
        includePairs: true,
    });
    const additivePrediction = predictClusterEffectModel(
        additiveModel,
        panel,
        testing
    );
    const relationshipPrediction = predictClusterEffectModel(
        relationshipModel,
        panel,
        testing
    );
    return {
        cutoffSeconds: cutoff,
        cutoffIso: Number.isFinite(cutoff) ? new Date(cutoff * 1000).toISOString() : null,
        sourceFold,
        trainingRows: training.length,
        testingRows: testing.length,
        unavailableTrainingTargets,
        trainingAvailabilityRule: strictTarget
            ? 'A pre-cutoff row enters training only when its focal outcome observation S_i is at or before the cutoff.'
            : 'Not historically executable: legacy exploratory outcomes have no per-row observation time.',
        trainingAvailabilityAudit: {
            maximumTrainingObservedSeconds,
            maximumTrainingObservedIso: Number.isFinite(maximumTrainingObservedSeconds)
                ? new Date(maximumTrainingObservedSeconds * 1000).toISOString()
                : null,
            minimumTestingPublishedSeconds,
            minimumTestingPublishedIso: Number.isFinite(minimumTestingPublishedSeconds)
                ? new Date(minimumTestingPublishedSeconds * 1000).toISOString()
                : null,
            allTrainingTargetsObservedByCutoff: strictTarget
                ? maximumTrainingObservedSeconds <= cutoff
                : null,
            allTestingRowsPublishedAtOrAfterCutoff: Number.isFinite(
                minimumTestingPublishedSeconds
            )
                ? minimumTestingPublishedSeconds >= cutoff
                : null,
        },
        historicalSources: historical.historicalSources,
        testingSourcesSeenHistorically: historical.testingSourcesSeenHistorically,
        target: strictTarget
            ? targetDescription
            : (
                sourceFold == null
                    ? 'INVALID/EXPLORATORY: later-video current-snapshot log views minus that source’s pre-cutoff current-snapshot mean.'
                    : 'INVALID/EXPLORATORY: later held-out-source current-snapshot log views minus a global/pre-cutoff current-snapshot baseline.'
            ),
        additiveTuning,
        relationshipTuning,
        historicalBaseline: {
            additive: evaluatePredictions(
                panel,
                testing,
                historical.target,
                additivePrediction
            ),
            relationships: evaluatePredictions(
                panel,
                testing,
                historical.target,
                relationshipPrediction
            ),
        },
        evaluationOnlySourceCentered: sourceRelativeTarget
            ? {
                validity: 'diagnostic_only',
                additive: evaluatePredictions(
                    panel,
                    testing,
                    sourceRelativeTarget,
                    additivePrediction
                ),
                relationships: evaluatePredictions(
                    panel,
                    testing,
                    sourceRelativeTarget,
                    relationshipPrediction
                ),
                boundary: 'The held-out source mean uses held-out outcomes and therefore only diagnoses within-source ordering; it is not available prospectively.',
            }
            : {
                validity: 'not_evaluated',
                reason: 'The strict panel contains opportunity residuals but no complete raw-view outcome. Zero placeholders are never analyzed or reported as a source-centered result.',
            },
        null: predictionPermutationTest({
            panel,
            indices: testing,
            target: historical.target,
            predictions: relationshipPrediction,
            groupKey: row => row.quarter,
            seed: CONFIG.seed + stableHash32(
                `${panel.format}:${k}:forward:${sourceFold ?? 'all'}`
            ),
        }),
        training,
        testing,
        historicalTarget: historical.target,
        sourceRelativeTarget,
        additiveModel,
        relationshipModel,
        additivePrediction,
        relationshipPrediction,
    };
}

function weightedCellEffect(values, weights, positions) {
    if (!positions.length) return null;
    return weightedMean(
        positions.map(position => values[position]),
        positions.map(position => weights[position])
    );
}

function validateRelationshipCandidates({
    panel,
    k,
    sourceValidation,
    forward,
}) {
    const candidates = [];
    for (const [left, right] of PAIR_KEYS) {
        const key = `${left}+${right}`;
        const effects = forward.relationshipModel.pairs[key];
        const rawSupport = forward.relationshipModel.pairRawSupport[key];
        const sourceSupport = forward.relationshipModel.pairSources[key];
        for (let cell = 0; cell < effects.length; cell += 1) {
            if (rawSupport[cell] < 20 || sourceSupport[cell] < 5) continue;
            candidates.push({
                relationship: key,
                leftCluster: Math.floor(cell / k),
                rightCluster: cell % k,
                cell,
                trainingEffect: effects[cell],
                trainingRows: rawSupport[cell],
                trainingSources: sourceSupport[cell],
            });
        }
    }
    candidates.sort((left, right) => (
        Math.abs(right.trainingEffect) - Math.abs(left.trainingEffect)
    ));
    const selected = candidates.slice(0, 30);
    const testWeightsGlobal = selectionWeights(
        panel.metadata,
        forward.testing
    ).weights;
    const testWeights = Float64Array.from(
        forward.testing,
        index => testWeightsGlobal[index]
    );
    const additiveResidual = Float64Array.from(
        forward.testing,
        (index, position) => (
            forward.historicalTarget[index] - forward.additivePrediction[position]
        )
    );
    const quarterGroups = selectedGroupMap(
        panel.metadata,
        forward.testing,
        row => row.quarter
    );
    const testLabels = panel.labels[String(k)];
    for (const candidate of selected) {
        const [left, right] = candidate.relationship.split('+');
        const positions = [];
        const sources = new Set();
        for (let position = 0; position < forward.testing.length; position += 1) {
            const index = forward.testing[position];
            if (
                testLabels[left][index] === candidate.leftCluster
                && testLabels[right][index] === candidate.rightCluster
            ) {
                positions.push(position);
                sources.add(panel.rows[index].sourceId);
            }
        }
        const testEffect = weightedCellEffect(additiveResidual, testWeights, positions);
        const nullEffects = [];
        for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
            const permuted = permuteNumericWithinGroups(
                additiveResidual,
                quarterGroups,
                createRng(
                    CONFIG.seed
                    + stableHash32(`${panel.format}:${k}:${candidate.relationship}:${candidate.cell}`)
                    + repetition
                )
            );
            nullEffects.push(weightedCellEffect(permuted, testWeights, positions));
        }
        const sameDirection = Number.isFinite(testEffect)
            && Math.sign(testEffect) === Math.sign(candidate.trainingEffect);
        const directionalObserved = sameDirection ? Math.abs(testEffect) : -Math.abs(testEffect || 0);
        const directionalNull = nullEffects.map(value => (
            Math.sign(value) === Math.sign(candidate.trainingEffect)
                ? Math.abs(value)
                : -Math.abs(value || 0)
        ));
        const foldSigns = [];
        for (const model of sourceValidation.relationshipModels) {
            const effect = model.pairs[candidate.relationship]?.[candidate.cell];
            const rows = model.pairRawSupport[candidate.relationship]?.[candidate.cell] || 0;
            const sourceCount = model.pairSources[candidate.relationship]?.[candidate.cell] || 0;
            if (rows >= 20 && sourceCount >= 5 && Number.isFinite(effect)) {
                foldSigns.push(Math.sign(effect));
            }
        }
        Object.assign(candidate, {
            testingRows: positions.length,
            testingSources: sources.size,
            testEffect: round(testEffect),
            sameDirection,
            sourceFoldModelsWithSupport: foldSigns.length,
            sourceFoldDirectionAgreement: foldSigns.length
                ? round(foldSigns.filter(sign => sign === Math.sign(candidate.trainingEffect)).length / foldSigns.length)
                : null,
            p: empiricalTest(directionalObserved, directionalNull).p,
        });
    }
    bhAdjust(selected);
    for (const candidate of selected) {
        candidate.survives = (
            candidate.sameDirection
            && candidate.testingRows >= 20
            && candidate.testingSources >= 5
            && candidate.sourceFoldModelsWithSupport >= 3
            && candidate.sourceFoldDirectionAgreement >= 0.8
            && candidate.q <= 0.1
        );
        candidate.trainingEffect = round(candidate.trainingEffect);
    }
    return {
        discovery: 'Pairwise visual/text/together cells are ranked by shrunken interaction residual on the pre-cutoff training period only.',
        validation: 'A candidate survives only with the same sign later, at least 20 later rows and five later sources, direction agreement in at least 80% of three or more unseen-source models, and forward-time BH q <= 0.10.',
        testedCandidates: selected.length,
        survivors: selected.filter(candidate => candidate.survives),
        candidates: selected,
        multiplicity: {
            correction: 'Benjamini-Hochberg',
            family: 'The top 30 training-selected pair cells within one format/resolution.',
            qThreshold: 0.1,
        },
    };
}

function stripForwardInternals(forward) {
    return {
        cutoffSeconds: forward.cutoffSeconds,
        cutoffIso: forward.cutoffIso,
        sourceFold: forward.sourceFold,
        trainingRows: forward.trainingRows,
        testingRows: forward.testingRows,
        unavailableTrainingTargets: forward.unavailableTrainingTargets,
        trainingAvailabilityRule: forward.trainingAvailabilityRule,
        trainingAvailabilityAudit: forward.trainingAvailabilityAudit,
        historicalSources: forward.historicalSources,
        testingSourcesSeenHistorically: forward.testingSourcesSeenHistorically,
        target: forward.target,
        additiveTuning: forward.additiveTuning,
        relationshipTuning: forward.relationshipTuning,
        historicalBaseline: forward.historicalBaseline,
        evaluationOnlySourceCentered: forward.evaluationOnlySourceCentered,
        null: forward.null,
    };
}

function stripSourceValidationInternals(validation) {
    return {
        split: validation.split,
        target: validation.target,
        folds: validation.folds,
        additive: validation.additive,
        relationships: validation.relationships,
        relationshipDelta: validation.relationshipDelta,
        null: validation.null,
    };
}

function analyzeMechanisms(panel) {
    const logViews = Float64Array.from(panel.rows, row => row.logViews);
    const strict = panel.outcomeContract.validity
        === 'strict_panel_eligible_for_holdout_testing';
    const target = strict
        ? Float64Array.from(panel.rows, row => row.strictTarget)
        : centerTargetWithinSelection(
            panel.metadata,
            panel.rows.map((_, index) => index),
            logViews
        );
    const targetDescription = strict
        ? panel.outcomeContract.target
        : 'INVALID/EXPLORATORY: current-snapshot log views centered using the held-out source’s own current outcomes.';
    const resolutions = [];
    for (const k of RESOLUTIONS) {
        console.log(`  mechanism ${panel.format} k=${k}`);
        const sourceValidation = sourceFoldValidation(
            panel,
            k,
            target,
            targetDescription
        );
        const forward = forwardValidation(
            panel,
            k,
            target,
            targetDescription
        );
        const unseenSourceAndTime = forwardValidation(
            panel,
            k,
            target,
            targetDescription,
            0
        );
        const candidates = validateRelationshipCandidates({
            panel,
            k,
            sourceValidation,
            forward,
        });
        resolutions.push({
            k,
            unseenSource: stripSourceValidationInternals(sourceValidation),
            forwardTime: stripForwardInternals(forward),
            unseenSourceAndForwardTime: stripForwardInternals(unseenSourceAndTime),
            relationshipCandidates: candidates,
        });
    }
    return {
        format: panel.format,
        status: panel.outcomeContract.validity,
        observations: panel.rows.length,
        metadataCoverage: panel.metadata.coverage,
        validity: panel.outcomeContract.validity,
        outcomeContract: panel.outcomeContract,
        estimand: {
            geometry: 'Frozen outcome-blind memberships in the three current modality maps.',
            sourceValidation: targetDescription,
            timeValidation: targetDescription,
            relationship: 'Incremental pair-cell residual beyond additive visual/text/together cluster effects.',
        },
        resolutions,
    };
}

function cosineRows(left, right, dimensions, leftRow, rightRow) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
        const leftValue = left[(leftRow * dimensions) + dimension];
        const rightValue = right[(rightRow * dimensions) + dimension];
        dot += leftValue * rightValue;
        leftNorm += leftValue * leftValue;
        rightNorm += rightValue * rightValue;
    }
    return leftNorm > 0 && rightNorm > 0
        ? dot / Math.sqrt(leftNorm * rightNorm)
        : 0;
}

function hungarianMaximum(matrix, size) {
    let maximum = -Infinity;
    for (const value of matrix) if (value > maximum) maximum = value;
    const u = new Float64Array(size + 1);
    const v = new Float64Array(size + 1);
    const p = new Int32Array(size + 1);
    const way = new Int32Array(size + 1);
    for (let row = 1; row <= size; row += 1) {
        p[0] = row;
        let column0 = 0;
        const minimum = new Float64Array(size + 1).fill(Infinity);
        const used = new Uint8Array(size + 1);
        do {
            used[column0] = 1;
            const row0 = p[column0];
            let delta = Infinity;
            let column1 = 0;
            for (let column = 1; column <= size; column += 1) {
                if (used[column]) continue;
                const cost = maximum - matrix[((row0 - 1) * size) + (column - 1)];
                const current = cost - u[row0] - v[column];
                if (current < minimum[column]) {
                    minimum[column] = current;
                    way[column] = column0;
                }
                if (minimum[column] < delta) {
                    delta = minimum[column];
                    column1 = column;
                }
            }
            for (let column = 0; column <= size; column += 1) {
                if (used[column]) {
                    u[p[column]] += delta;
                    v[column] -= delta;
                } else {
                    minimum[column] -= delta;
                }
            }
            column0 = column1;
        } while (p[column0] !== 0);
        do {
            const column1 = way[column0];
            p[column0] = p[column1];
            column0 = column1;
        } while (column0 !== 0);
    }
    const assignment = new Int32Array(size);
    for (let column = 1; column <= size; column += 1) {
        assignment[p[column] - 1] = column - 1;
    }
    return assignment;
}

function centroidSimilarityMatrix(left, right, k, dimensions) {
    const matrix = new Float64Array(k * k);
    for (let leftCluster = 0; leftCluster < k; leftCluster += 1) {
        for (let rightCluster = 0; rightCluster < k; rightCluster += 1) {
            matrix[(leftCluster * k) + rightCluster] = cosineRows(
                left,
                right,
                dimensions,
                leftCluster,
                rightCluster
            );
        }
    }
    return matrix;
}

function randomizedCentroids(centroids, k, dimensions, rng) {
    const order = shuffle(
        Array.from({ length: dimensions }, (_, index) => index),
        rng
    );
    const signs = Array.from(
        { length: dimensions },
        () => (rng() < 0.5 ? -1 : 1)
    );
    const output = new Float64Array(centroids.length);
    for (let cluster = 0; cluster < k; cluster += 1) {
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            output[(cluster * dimensions) + dimension] = (
                centroids[(cluster * dimensions) + order[dimension]]
                * signs[dimension]
            );
        }
    }
    return output;
}

function centeredClusterCentroids(model, k, dimensions) {
    const globalMean = new Float64Array(dimensions);
    let totalMass = 0;
    for (let cluster = 0; cluster < k; cluster += 1) {
        const mass = model.mass[cluster];
        totalMass += mass;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            globalMean[dimension] += (
                model.rawMeans[(cluster * dimensions) + dimension] * mass
            );
        }
    }
    if (totalMass > 0) {
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            globalMean[dimension] /= totalMass;
        }
    }
    const output = new Float64Array(k * dimensions);
    for (let cluster = 0; cluster < k; cluster += 1) {
        const offset = cluster * dimensions;
        let norm = 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            const value = model.rawMeans[offset + dimension] - globalMean[dimension];
            output[offset + dimension] = value;
            norm += value * value;
        }
        const inverse = norm > 0 ? 1 / Math.sqrt(norm) : 0;
        for (let dimension = 0; dimension < dimensions; dimension += 1) {
            output[offset + dimension] *= inverse;
        }
    }
    return output;
}

function clusterEffects(map, metadata, k) {
    const labels = map.clusters[String(k)];
    const values = centerWithinGroups(
        Float64Array.from(metadata.rows, row => row.logViews),
        metadata.sourceGroups
    );
    const sums = new Float64Array(k);
    const mass = new Float64Array(k);
    for (let index = 0; index < labels.length; index += 1) {
        const cluster = labels[index];
        const weight = metadata.sourceWeights[index];
        sums[cluster] += weight * values[index];
        mass[cluster] += weight;
    }
    return Float64Array.from(
        sums,
        (sum, cluster) => (mass[cluster] > 0 ? sum / mass[cluster] : 0)
    );
}

function crossFormatCentroidTransport({
    modality,
    shorts,
    long,
}) {
    const resolutions = [];
    for (const k of RESOLUTIONS) {
        const projectionRows = [];
        for (let projection = 0; projection < CONFIG.projectionSeeds.length; projection += 1) {
            const leftModel = shorts.embedding.sharedCentroids[String(k)]?.[projection];
            const rightModel = long.embedding.sharedCentroids[String(k)]?.[projection];
            if (!leftModel || !rightModel) continue;
            const left = centeredClusterCentroids(
                leftModel,
                k,
                CONFIG.projectionDimensions
            );
            const right = centeredClusterCentroids(
                rightModel,
                k,
                CONFIG.projectionDimensions
            );
            const matrix = centroidSimilarityMatrix(
                left,
                right,
                k,
                CONFIG.projectionDimensions
            );
            const assignment = hungarianMaximum(matrix, k);
            const similarities = Array.from(
                assignment,
                (rightCluster, leftCluster) => matrix[(leftCluster * k) + rightCluster]
            );
            const nullValues = [];
            for (let repetition = 0; repetition < CONFIG.permutationRuns; repetition += 1) {
                const randomized = randomizedCentroids(
                    right,
                    k,
                    CONFIG.projectionDimensions,
                    createRng(
                        CONFIG.seed
                        + stableHash32(`${modality}:${k}:${projection}`)
                        + repetition
                    )
                );
                const nullMatrix = centroidSimilarityMatrix(
                    left,
                    randomized,
                    k,
                    CONFIG.projectionDimensions
                );
                const nullAssignment = hungarianMaximum(nullMatrix, k);
                nullValues.push(mean(Array.from(
                    nullAssignment,
                    (rightCluster, leftCluster) => (
                        nullMatrix[(leftCluster * k) + rightCluster]
                    )
                )));
            }
            projectionRows.push({
                projection: `countsketch-${projection + 1}`,
                centering: 'Each cluster mean is centered by its map’s equal-source global embedding mean before L2 normalization and matching.',
                assignment: Array.from(assignment, (rightCluster, leftCluster) => ({
                    shortsCluster: leftCluster,
                    longCluster: rightCluster,
                    cosine: round(matrix[(leftCluster * k) + rightCluster]),
                })),
                matchedCosine: summarize(similarities),
                signedCoordinatePermutationNull: empiricalTest(
                    mean(similarities),
                    nullValues
                ),
                transportedWithinSourceOutcomeEffect: {
                    validity: 'not_evaluated',
                    reason: 'The legacy map/database outcome join has no valid per-row observation time. Strict-panel outcome transport belongs in the sealed mechanism analysis, not this geometry match.',
                },
            });
        }
        let assignmentAgreement = null;
        if (projectionRows.length === 2) {
            const first = projectionRows[0].assignment;
            const second = projectionRows[1].assignment;
            assignmentAgreement = round(
                first.filter((row, index) => row.longCluster === second[index].longCluster).length / k
            );
        }
        resolutions.push({
            k,
            projectionAssignmentAgreement: assignmentAgreement,
            projections: projectionRows,
        });
    }
    return {
        modality,
        inputComparability: 'All six archives use 1,536-dimensional Gemini embeddings, but Shorts and Long use different media constructions. Shared coordinates permit a transport diagnostic, not an ontology claim.',
        resolutions,
    };
}

function duplicateCount(values) {
    const seen = new Set();
    let duplicates = 0;
    for (const value of values) {
        const key = String(value);
        if (seen.has(key)) duplicates += 1;
        else seen.add(key);
    }
    return duplicates;
}

function summarizeConclusions({
    maps,
    crossModal,
    crossFormat,
    mechanisms,
}) {
    const lineageRows = maps.flatMap(map => (map.geometry?.adjacentLineages || []).map(row => ({
        map: map.id,
        fromK: row.fromK,
        toK: row.toK,
        nmi: row.sourceBalanced.nmi,
        sourceNullP: row.nulls.sourcePreserving.p,
        timeNullP: row.nulls.timePreserving.p,
    })));
    const coreRows = maps
        .filter(map => map.geometry?.strictCrossResolutionCore)
        .map(map => ({
            map: map.id,
            sourceBalancedFraction: map.geometry.strictCrossResolutionCore
                .sourceBalancedFraction,
            observationFraction: map.geometry.strictCrossResolutionCore
                .observationFraction,
        }));
    const centroidRows = maps.flatMap(map => (map.embedding?.partitions || []).flatMap(
        partition => partition.projections.map(projection => ({
            map: map.id,
            k: partition.k,
            projection: projection.projection,
            conditionalNmi: projection.conditionalCentroidRecoverability
                .sourceBootstrap.nmi.mean,
            deNovoNmi: projection.deNovoOptimizationSensitivity.productionNmi.mean,
            deNovoRunNmi: projection.deNovoOptimizationSensitivity.pairwiseRunNmi.mean,
        }))
    ));
    const modalRows = crossModal.flatMap(edge => edge.resolutions.map(row => ({
        edge: `${edge.format}:${edge.left}:${edge.right}`,
        k: row.k,
        nmi: row.sourceBalanced.nmi,
        sourceNullP: row.nulls.sourcePreserving.p,
        timeNullP: row.nulls.timePreserving.p,
    })));
    const formatRows = crossFormat.flatMap(edge => edge.resolutions.flatMap(
        resolution => resolution.projections.map(projection => ({
            modality: edge.modality,
            k: resolution.k,
            projection: projection.projection,
            matchedCosine: projection.matchedCosine.mean,
            geometryP: projection.signedCoordinatePermutationNull.p,
            outcomeEffectR: projection.transportedWithinSourceOutcomeEffect
                .pearsonAcrossMatchedClusters,
            outcomeP: projection.transportedWithinSourceOutcomeEffect
                .randomMatchingNull?.p,
        }))
    ));
    const mechanismRows = mechanisms.flatMap(format => format.resolutions.map(row => ({
        format: format.format,
        k: row.k,
        unseenSourceAdditiveR: row.unseenSource.additive.pearson,
        unseenSourceRelationshipR: row.unseenSource.relationships.pearson,
        unseenSourceDeltaR: row.unseenSource.relationshipDelta.pearson,
        unseenSourceP: row.unseenSource.null.p,
        forwardAdditiveR: row.forwardTime.historicalBaseline.additive.pearson,
        forwardRelationshipR: row.forwardTime.historicalBaseline.relationships.pearson,
        forwardP: row.forwardTime.null.p,
        unseenSourceTimeR: row.unseenSourceAndForwardTime.historicalBaseline
            .relationships.pearson,
        survivingRelationships: row.relationshipCandidates.survivors.length,
    })));
    return {
        geometry: {
            lineageNmi: summarize(lineageRows.map(row => row.nmi)),
            lineageEdgesAboveBothNulls: lineageRows.filter(row => (
                row.sourceNullP <= 0.05 && row.timeNullP <= 0.05
            )).length,
            conditionalCentroidBootstrapNmi: summarize(
                centroidRows.map(row => row.conditionalNmi)
            ),
            deNovoProductionNmi: summarize(
                centroidRows.map(row => row.deNovoNmi)
            ),
            deNovoPairwiseRunNmi: summarize(
                centroidRows.map(row => row.deNovoRunNmi)
            ),
            strictMutualLineageCoreSourceBalancedFraction: summarize(
                coreRows.map(row => row.sourceBalancedFraction)
            ),
            interpretation: 'Adjacent k maps share real structure, but conditional centroid recovery is partly anchored to production labels. De-novo agreement and the strict mutual lineage core are the stricter quantities; both indicate only partial taxonomy reproducibility.',
        },
        transport: {
            crossModalNmi: summarize(modalRows.map(row => row.nmi)),
            crossModalEdgesAboveBothNulls: modalRows.filter(row => (
                row.sourceNullP <= 0.05 && row.timeNullP <= 0.05
            )).length,
            crossFormatMatchedCosine: summarize(
                formatRows.map(row => row.matchedCosine)
            ),
            crossFormatGeometryMatchesAboveNull: formatRows.filter(
                row => row.geometryP <= 0.05
            ).length,
            crossFormatOutcomeEffectMatchesAboveNull: formatRows.filter(
                row => row.outcomeP <= 0.05
            ).length,
            acceptedCrossFormatModalities: [...new Set(
                crossFormat
                    .filter(row => row.status === 'accepted_outcome_blind_geometry')
                    .map(row => row.modality)
            )],
            rejectedCrossFormatModalities: crossFormat
                .filter(row => row.status !== 'accepted_outcome_blind_geometry')
                .map(row => row.modality),
            interpretation: 'A minimum Monte Carlo p-value shows structure beyond the chosen null, not a large effect. Cross-modal NMI magnitude remains low; cross-format evidence is restricted to identity-valid modalities.',
        },
        mechanisms: {
            tests: mechanismRows,
            unseenSourceRelationshipPearson: summarize(
                mechanismRows.map(row => row.unseenSourceRelationshipR)
            ),
            forwardRelationshipPearson: summarize(
                mechanismRows.map(row => row.forwardRelationshipR)
            ),
            unseenSourceAndTimeRelationshipPearson: summarize(
                mechanismRows.map(row => row.unseenSourceTimeR)
            ),
            incrementalRelationshipWins: mechanismRows.filter(row => (
                row.unseenSourceDeltaR > 0
                && row.forwardRelationshipR > row.forwardAdditiveR
            )).length,
            validatedPairRelationships: mechanismRows.reduce(
                (sum, row) => sum + row.survivingRelationships,
                0
            ),
            promotionRule: 'No relationship is promoted unless it improves the additive baseline, beats its constrained null, and its selected cell survives unseen-source recurrence plus forward-time BH control.',
        },
        claims: [
            {
                claim: 'The production partitions contain outcome-blind geometric cores.',
                status: centroidRows.some(row => row.deNovoNmi > 0.2)
                    ? 'partial_local_support'
                    : 'not_supported',
                basis: 'All accepted maps beat constrained nulls, but de-novo NMI is modest and strict mutual lineage cores contain only a minority of observations.',
            },
            {
                claim: 'A single natural cluster resolution exists.',
                status: 'not_testable_from_fixed_k_grid',
                basis: 'Only k=6,10,16,24 were produced. Stable split/merge lineages do not prove one true k.',
            },
            {
                claim: 'Modalities share one interchangeable ontology.',
                status: modalRows.every(row => row.nmi >= 0.8)
                    ? 'supported'
                    : 'rejected',
                basis: 'Equal-source cross-modal NMI and constrained nulls.',
            },
            {
                claim: 'Cluster semantics transport generally from Shorts to Long.',
                status: (
                    crossFormat.filter(row => row.status === 'accepted_outcome_blind_geometry').length
                    === crossFormat.length
                    && formatRows.filter(row => row.geometryP <= 0.05).length
                        >= Math.ceil(formatRows.length * 0.75)
                )
                    ? 'supported_geometrically'
                    : 'unresolved_together_only',
                basis: 'Only Long together passed frozen identity checks. Its centroid matches beat the coordinate null, but visual/text transport is rejected and projection assignment agreement varies by k.',
            },
            {
                claim: 'Cross-modal cluster relationships predict creator-relative views in unseen source and time.',
                status: !mechanismRows.length
                    ? 'not_evaluated_without_strict_panel'
                    : (
                        mechanismRows.some(row => (
                            row.survivingRelationships > 0
                            && row.unseenSourceP <= 0.05
                            && row.forwardP <= 0.05
                        ))
                            ? 'exploratory_support'
                            : 'not_supported'
                    ),
                basis: 'Nested training-only shrinkage, grouped source folds, chronological holdout, constrained permutations, and BH-controlled cell validation.',
            },
        ],
    };
}

function methodologicalLimitations() {
    return [
        'CRITICAL: db.updated is a database-level write time, not a per-row observation time. Any earlier outcome result built with it is invalid for confirmation and must remain exploratory.',
        'Rows marked rechecked can contain later-overwritten outcomes without a recheckedAt timestamp. They are forbidden from the strict outcome panel.',
        'A live sequence of database/map downloads is non-atomic. Confirmatory geometry requires the two-read, metadata-stable, content-addressed snapshot manifest; strict outcomes must name that same snapshotRunId.',
        'Historically observable creator history requires S_j <= T_i. A prior video’s later snapshot value cannot be used as if it were known when the focal video was published.',
        'The six maps are fixed outputs of one Gemini embedding model and one production MiniBatchKMeans recipe. Stability here cannot establish that the representation is ontologically correct.',
        'The Node analysis does not deserialize the NPZ object-typed ID array and never infers labels from position by itself. It consumes the frozen verifier’s exact map/vector ID-order report; a missing or failed channel audit is a falsification/integrity failure and rejects every dependent test.',
        'Full 1,536-D bootstrap refits would be computationally prohibitive. The script uses two independent signed CountSketch projections and reports projection sensitivity. Conditional centroid bootstraps do not reproduce the complete embedding and clustering pipeline.',
        'De-novo fits use a source-balanced spherical mini-batch implementation in reduced space, whereas production used scikit-learn MiniBatchKMeans in full normalized space. Disagreement can reflect either instability or this algorithmic approximation.',
        'Equal-source weighting changes the estimand: a channel with one mapped video receives the same aggregate weight as a channel with hundreds. Both source coverage and minimum-support diagnostics must be read with the scores.',
        'Canonical channel IDs are unavailable for some map rows. Those rows receive observation-unique fallback sources, which prevents false pooling but can overstate source diversity.',
        'Views are current lifetime snapshots, not age-matched outcomes measured at a common horizon. Publication age, language, geography, subscribers, recommendation exposure, deletion, and crawler selection remain confounded.',
        'Strict forward tests admit a pre-cutoff training row only when its focal target observation S_i was available by the cutoff. The report exposes rows censored by this rule.',
        'The production partitions were fitted outcome-blind on the full embedding corpus, including held-out feature rows. Outcome testing is therefore historically target-available but transductive in representation, not a fully prospective refit.',
        'The strict panel’s publication and observation windows are reported explicitly. A short frozen window cannot establish long-horizon temporal stability or regime invariance.',
        'Some timestamps can be missing, malformed, or revised by crawlers. Missing-time rows are excluded from chronological mechanism tests.',
        'Within-source centered held-out targets use the held-out source’s outcomes to define the evaluation target. They test relative ordering only and cannot produce prospective absolute-view forecasts.',
        'The pre-cutoff source-history target is more deployment-like, but new sources fall back to a global mean and opportunity drift remains unmodeled.',
        'Cross-modal analyses use only videos present in both maps. Text coverage is materially lower for Shorts, and that complete-case subset is selected rather than random.',
        'For silent Shorts, together embeddings can partially degenerate toward visual embeddings. Silent and voiced transport are therefore reported separately where applicable.',
        'Cross-format centroid transport is possible because all archives use 1,536 coordinates, but Shorts visual/text inputs and Long thumbnail/title inputs are different constructions. A centroid match is not proof of shared meaning.',
        'The coordinate-permutation null preserves centroid norms but not every dependency of the embedding distribution. It is one falsification control, not a complete null model.',
        'Source-preserving permutations have limited mobility for one-video channels; time-preserving permutations do not preserve exact source. Exact source-time mobility is reported to expose this tradeoff.',
        'The fixed k grid and adjacent lineage edges do not form a true hierarchical clustering. Split/merge language refers only to maximum-overlap transport between independently fitted partitions.',
        'Cluster IDs are arbitrary. Every comparison uses contingency, centroid matching, or co-assignment rather than numeric label equality.',
        'Outcome-blind means outcomes did not construct the k-means assignments. The same corpus was nevertheless inspected repeatedly elsewhere in the research program, so the analysis is not institutionally preregistered.',
        'The relationship search remains exploratory despite nested tuning, constrained nulls, and BH correction. The same six maps inspired the question, and no independently collected prospective corpus is available.',
        'Pairwise visual/text/together cells do not exhaust nonlinear mechanisms, higher-order interactions, temporal media structure, or causal audience response.',
        'Outlier ratios and subscriber-normalized values are descendants of views and are not treated as independent outcome replications.',
        'Permutation p-values have finite Monte Carlo resolution determined by the configured repetition count. Values at that floor should be read as bounded, not exact.',
        'No result in this file is causal. A mechanism candidate requires prospective intervention or a naturally exogenous test before it can be promoted beyond predictive association.',
    ];
}

async function main() {
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(CONFIG.output), { recursive: true });

    const input = await createInputProvider();
    const integrity = loadIntegrityReport(CONFIG.integrityReport, input.runId);
    const strictPanel = loadStrictPanel(CONFIG.strictPanel, input.runId);
    const runOutcomeTests = Boolean(strictPanel || CONFIG.exploratoryOutcomes);
    const mapOutcomeValidity = CONFIG.exploratoryOutcomes
        ? 'invalid_legacy_panel_exploratory_only'
        : 'not_evaluated';
    console.log(
        `Loading ${input.mode} databases and maps; outcomes: `
        + (
            strictPanel
                ? `strict panel (${strictPanel.acceptedRows} accepted rows)`
                : (CONFIG.exploratoryOutcomes ? 'legacy exploratory opt-in' : 'disabled')
        )
    );
    const shortsDatabaseObject = await input.readDatabase('shorts');
    const longDatabaseObject = await input.readDatabase('long');
    const databases = {
        shorts: shortsDatabaseObject.value,
        long: longDatabaseObject.value,
    };
    const provenance = [
        shortsDatabaseObject,
        longDatabaseObject,
    ].map(object => ({
        key: object.key,
        bytes: object.bytes,
        sha256: object.sha256,
        etag: object.etag,
        lastModified: object.lastModified,
    }));
    const mapObjects = {};
    const mapsByFormat = { shorts: {}, long: {} };
    for (const spec of MAP_SPECS) {
        const object = await input.readMap(spec.format, spec.modality);
        provenance.push({
            key: object.key,
            bytes: object.bytes,
            sha256: object.sha256,
            etag: object.etag,
            lastModified: object.lastModified,
        });
        mapObjects[`${spec.format}:${spec.modality}`] = object;
        mapsByFormat[spec.format][spec.modality] = object.value;
    }

    console.log('Running source-balanced fixed-label geometry and lineage tests...');
    const mapResults = [];
    const internalMaps = {};
    for (const spec of MAP_SPECS) {
        const id = `${spec.format}:${spec.modality}`;
        const map = mapObjects[id].value;
        const metadata = buildMetadata(map, databases[spec.format], spec.format);
        const channelIntegrity = integrity.byChannel.get(id);
        const channelAccepted = channelIntegrity?.accepted === true;
        const geometry = channelAccepted
            ? analyzeMapGeometry(
                map,
                metadata,
                spec.format,
                spec.modality,
                mapOutcomeValidity
            )
            : null;
        const result = {
            id,
            format: spec.format,
            modality: spec.modality,
            status: channelAccepted
                ? 'accepted_exact_frozen_identity'
                : 'rejected_identity_integrity_failure',
            integrity: channelIntegrity || {
                accepted: false,
                reason: 'No exact map/vector ID-order verification is available.',
            },
            mapKey: spec.mapKey,
            embeddingKey: spec.embeddingKey,
            observations: map.id.length,
            duplicateVideoIds: duplicateCount(map.id),
            metadataCoverage: metadata.coverage,
            production: {
                algorithm: 'scikit-learn MiniBatchKMeans',
                normalizedInput: true,
                k: RESOLUTIONS,
                randomState: 0,
                nInit: 3,
                batchSize: 1024,
                outcomeBlindAssignments: true,
            },
            geometry,
            embedding: null,
        };
        mapResults.push(result);
        internalMaps[id] = { map, metadata, result, embedding: null };
    }

    console.log('Running complete-case cross-modal transports...');
    const crossModal = [
        ...analyzeCrossModal(
            'shorts',
            mapsByFormat.shorts,
            databases.shorts,
            integrity.byChannel
        ),
        ...analyzeCrossModal(
            'long',
            mapsByFormat.long,
            databases.long,
            integrity.byChannel
        ),
    ];

    let mechanisms = [];
    if (runOutcomeTests) {
        console.log(
            strictPanel
                ? 'Running strict-panel sealed source/time mechanism tests...'
                : 'Running INVALID legacy-panel mechanism exploration by explicit opt-in...'
        );
        mechanisms = ['shorts', 'long'].map(format => {
            const failedInputs = ['visual', 'text', 'together']
                .filter(modality => !integrity.byChannel.get(`${format}:${modality}`)?.accepted)
                .map(modality => `${format}:${modality}`);
            if (failedInputs.length) {
                return {
                    format,
                    status: 'rejected_identity_integrity_failure',
                    failedInputs,
                    reason: 'Mechanism tests require exact identity-valid labels for all three modalities.',
                    resolutions: [],
                };
            }
            return analyzeMechanisms(buildMechanismPanel(
                format,
                mapsByFormat[format],
                databases[format],
                strictPanel
            ));
        });
    } else {
        console.log('Skipping all outcome tests until a strict panel is supplied.');
    }

    console.log('Loading exact embedding archives and auditing geometric reproducibility...');
    for (const spec of MAP_SPECS) {
        const id = `${spec.format}:${spec.modality}`;
        if (!integrity.byChannel.get(id)?.accepted) {
            console.log(`  ${id}: REJECTED by exact map/vector ID-order audit`);
            continue;
        }
        console.log(`  ${id}: archive`);
        const archive = await input.readEmbedding(spec.format, spec.modality);
        provenance.push({
            key: archive.key,
            bytes: archive.bytes,
            sha256: archive.sha256,
            etag: archive.etag,
            lastModified: archive.lastModified,
            cacheHit: archive.cacheHit,
        });
        console.log(`  ${id}: inflate vecs.npy`);
        const extracted = extractZipEntry(archive.filePath, 'vecs.npy');
        const matrix = parseNpyFloat32(extracted.buffer);
        const internal = internalMaps[id];
        const mapRows = internal.map.id.length;
        if (matrix.rows < mapRows) {
            throw new Error(
                `${id}: embedding archive has ${matrix.rows} rows but map has ${mapRows}`
            );
        }
        console.log(
            `  ${id}: project ${mapRows.toLocaleString()} x ${matrix.dimensions} `
            + `to 2 x ${CONFIG.projectionDimensions}`
        );
        const projections = projectCountSketch(
            matrix.values,
            mapRows,
            matrix.dimensions,
            CONFIG.projectionDimensions,
            CONFIG.projectionSeeds
        );
        console.log(`  ${id}: bootstrap and de-novo audits`);
        const embedding = analyzeEmbeddingStability({
            projections,
            metadata: internal.metadata,
            map: internal.map,
            format: spec.format,
            modality: spec.modality,
        });
        embedding.archiveContract = {
            archiveRows: matrix.rows,
            mapRows,
            extraArchiveRowsNotInMap: matrix.rows - mapRows,
            dimensions: matrix.dimensions,
            rowCountMatchesExactly: matrix.rows === mapRows,
            positionalIdentityAssumption: 'map.id[i] corresponds to embeddings.npz vecs[i], as written by raw_embed.py/raw_embed_long.py.',
        };
        internal.embedding = embedding;
        internal.result.embedding = {
            method: embedding.method,
            archiveContract: embedding.archiveContract,
            partitions: embedding.partitions,
        };
        // Let the decompressed 1,536-D archive be collected before the next map.
        extracted.buffer = null;
        if (global.gc) global.gc();
    }

    console.log('Running shared-coordinate Shorts/Long centroid transport...');
    const crossFormat = ['visual', 'text', 'together'].map(modality => {
        const shorts = internalMaps[`shorts:${modality}`];
        const long = internalMaps[`long:${modality}`];
        if (!shorts.embedding || !long.embedding) {
            return {
                modality,
                status: 'rejected_identity_integrity_failure',
                failedInputs: [
                    !shorts.embedding ? `shorts:${modality}` : null,
                    !long.embedding ? `long:${modality}` : null,
                ].filter(Boolean),
                reason: 'Cross-format centroid transport requires exact map/vector identity on both sides.',
                resolutions: [],
            };
        }
        return {
            status: 'accepted_outcome_blind_geometry',
            ...crossFormatCentroidTransport({ modality, shorts, long }),
        };
    });

    const conclusions = summarizeConclusions({
        maps: mapResults,
        crossModal,
        crossFormat,
        mechanisms,
    });
    const sourcePath = path.relative(ROOT, __filename);
    const sourceBuffer = fs.readFileSync(__filename);
    provenance.push({
        key: `local:${sourcePath}`,
        bytes: sourceBuffer.length,
        sha256: sha256(sourceBuffer),
        etag: null,
        lastModified: fs.statSync(__filename).mtime.toISOString(),
    });
    const output = {
        schema: 'business-world-cluster-invariance-v1',
        generatedAt: new Date().toISOString(),
        elapsedSeconds: round((Date.now() - startedAt) / 1000, 3),
        script: sourcePath,
        objective: 'Test whether outcome-blind cluster cores, split/merge lineages, cross-modal transports, and cluster relationships remain stable under source-balanced resampling and survive unseen source/time.',
        configuration: {
            ...CONFIG,
            output: path.relative(ROOT, CONFIG.output),
            cacheDirectory: '<local temporary cache>',
            snapshotManifest: path.relative(ROOT, CONFIG.snapshotManifest),
            strictPanel: CONFIG.strictPanel
                ? path.relative(ROOT, CONFIG.strictPanel)
                : null,
            integrityReport: path.relative(ROOT, CONFIG.integrityReport),
        },
        inputSnapshot: {
            mode: input.mode,
            atomic: input.atomic,
            runId: input.runId,
            identityHash: input.identityHash,
            acceptedAt: input.acceptedAt,
            manifestPath: input.manifestPath
                ? path.relative(ROOT, input.manifestPath)
                : null,
            confirmatoryGeometryEligible: input.atomic && integrity.available,
            integrity: {
                available: integrity.available,
                globallyAccepted: integrity.accepted,
                acceptedChannels: [...integrity.byChannel.values()]
                    .filter(row => row.accepted).length,
                rejectedChannels: [...integrity.byChannel.values()]
                    .filter(row => !row.accepted).length,
                failures: integrity.failures,
                sourcePath: path.relative(ROOT, integrity.sourcePath),
                sourceSha256: integrity.sourceSha256,
                contentHash: integrity.contentHash,
            },
        },
        outcomeAudit: {
            executed: runOutcomeTests,
            validity: strictPanel
                ? strictPanel.validity
                : (
                    CONFIG.exploratoryOutcomes
                        ? 'invalid_legacy_panel_exploratory_only'
                        : 'not_evaluated_without_strict_panel'
                ),
            criticalFinding: 'db.updated is not a row observation time; rechecked/non-stored rows and non-atomic map/database reads invalidate prior confirmatory outcome claims.',
            strictPanel: strictPanel
                ? {
                    schema: strictPanel.schema,
                    snapshotRunId: strictPanel.snapshotRunId,
                    acceptedRows: strictPanel.acceptedRows,
                    rejectedRows: strictPanel.rejectedRows,
                    rejection: strictPanel.rejection,
                    coverage: strictPanel.coverage,
                    sourcePath: path.relative(ROOT, strictPanel.sourcePath),
                    sourceSha256: strictPanel.sourceSha256,
                }
                : null,
            requiredStrictPanelContract: {
                snapshotRunId: 'Must equal inputSnapshot.runId.',
                rowGates: [
                    'strictEligible=true',
                    'stored=true',
                    'rechecked!=true',
                    'finite channelId/sourceId, publication T_i, observation S_i=storedAt/1000, and opportunity residual',
                    'S_i > T_i',
                    'at least one prior history row',
                    'latest prior S_j <= focal T_i',
                ],
                targetFieldsAccepted: [
                    'outcomes.opportunityResidual',
                    'outcomes.creatorRelativeResidual',
                    'targets.opportunityResidual',
                    'target.opportunityResidual',
                    'opportunityResidual',
                ],
            },
        },
        evidenceBoundary: {
            geometry: 'Embedding vectors and cluster assignments only; no outcomes enter stability, lineage, or transport discovery.',
            outcomes: strictPanel
                ? 'Only strict-panel opportunity residuals are used in sealed source/time tests.'
                : 'No outcome claim is confirmatory. Legacy map/database values are either skipped or explicitly marked invalid/exploratory.',
            independence: 'Views/log views/outlier variants from one video snapshot are one evidence event, not independent replications.',
            promotion: 'No cluster name or pooled association is called a mechanism. Survival requires unseen-source and forward-time evidence against constrained nulls.',
        },
        methodology: {
            sourceBalance: 'Every channel contributes aggregate weight one inside a tested sample.',
            bootstrap: 'Sources, not videos, are resampled with replacement.',
            lineage: 'Adjacent k partitions are linked by equal-source contingency; strict cores require mutual dominant parent/child transitions at every resolution.',
            geometricStability: 'Two independent CountSketch projections; conditional source-bootstrap centroid recovery; separate de-novo spherical mini-batch fits.',
            nulls: 'Labels are shuffled within source or within publication quarter. Exact source-quarter mobility is reported rather than hidden.',
            forwardAvailability: 'The strict forward training fold requires both T_i < cutoff and S_i <= cutoff; later-published rows form the test fold.',
            mechanismDiscovery: runOutcomeTests
                ? 'Additive cluster effects and pair-cell residuals use nested training-only shrinkage. Evaluation is grouped by source, chronological, and combined source/time.'
                : 'Deferred until a strict panel satisfying S_j <= T_i and the frozen snapshot identity is supplied.',
            multipleTesting: 'Forward pair candidates use a training-only top-30 family and Benjamini-Hochberg q <= 0.10.',
            predeclaredResolutions: RESOLUTIONS,
        },
        maps: mapResults,
        crossModal,
        crossFormat,
        mechanisms,
        conclusions,
        limitations: methodologicalLimitations(),
        provenance,
    };
    output.analysisHash = sha256(Buffer.from(JSON.stringify(output)));
    fs.writeFileSync(CONFIG.output, `${JSON.stringify(output)}\n`);
    const outputBytes = fs.statSync(CONFIG.output).size;
    console.log(JSON.stringify({
        output: path.relative(ROOT, CONFIG.output),
        bytes: outputBytes,
        megabytes: round(outputBytes / (1024 * 1024), 3),
        hash: output.analysisHash,
        elapsedSeconds: output.elapsedSeconds,
        maps: mapResults.map(map => ({
            id: map.id,
            status: map.status,
            observations: map.observations,
            sources: map.metadataCoverage.sources,
            vectorRowsMatch: map.embedding?.archiveContract?.rowCountMatchesExactly ?? false,
        })),
        claims: conclusions.claims,
        validatedRelationships: conclusions.mechanisms.validatedPairRelationships,
    }, null, 2));
}

main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
