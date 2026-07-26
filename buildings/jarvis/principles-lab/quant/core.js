'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

require('dotenv').config({ quiet: true });

const MAP_KEYS = [
    ['shorts', 'visual', 'raw/visual/map.json'],
    ['shorts', 'text', 'raw/text/map.json'],
    ['shorts', 'together', 'raw/together/map.json'],
    ['long', 'visual', 'raw-long/visual/map.json'],
    ['long', 'text', 'raw-long/text/map.json'],
    ['long', 'together', 'raw-long/together/map.json'],
];
const SNAPSHOT_MANIFEST_PATH = path.join(__dirname, 'snapshot-manifest.json');
const SNAPSHOT_INTEGRITY_PATH = path.join(__dirname, 'snapshot-integrity.json');
const GEOMETRY_DIR = path.join(__dirname, '.cache', 'reconstructed-geometry');

function finite(value, fallback = null) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function round(value, digits = 6) {
    return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * probability));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function variance(values, center = mean(values)) {
    if (!values.length || !Number.isFinite(center)) return null;
    return values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / values.length;
}

function standardDeviation(values, center = mean(values)) {
    const value = variance(values, center);
    return Number.isFinite(value) ? Math.sqrt(value) : null;
}

function rank(values) {
    const order = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const output = Array(values.length);
    for (let start = 0; start < order.length;) {
        let end = start + 1;
        while (end < order.length && order[end].value === order[start].value) end += 1;
        const averageRank = ((start + 1) + end) / 2;
        for (let index = start; index < end; index += 1) output[order[index].index] = averageRank;
        start = end;
    }
    return output;
}

function correlation(left, right) {
    if (left.length !== right.length || left.length < 3) return null;
    const leftMean = mean(left);
    const rightMean = mean(right);
    let numerator = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index] - leftMean;
        const b = right[index] - rightMean;
        numerator += a * b;
        leftSum += a * a;
        rightSum += b * b;
    }
    return leftSum > 0 && rightSum > 0
        ? numerator / Math.sqrt(leftSum * rightSum)
        : null;
}

function spearman(left, right) {
    return correlation(rank(left), rank(right));
}

function rSquared(actual, predicted) {
    if (actual.length !== predicted.length || actual.length < 3) return null;
    const center = mean(actual);
    let total = 0;
    let residual = 0;
    for (let index = 0; index < actual.length; index += 1) {
        total += (actual[index] - center) ** 2;
        residual += (actual[index] - predicted[index]) ** 2;
    }
    return total > 0 ? 1 - (residual / total) : null;
}

function mae(actual, predicted) {
    if (actual.length !== predicted.length || !actual.length) return null;
    return mean(actual.map((value, index) => Math.abs(value - predicted[index])));
}

function hash(value) {
    return crypto.createHash('sha256').update(
        Buffer.isBuffer(value) ? value : String(value)
    ).digest('hex');
}

function deterministicFold(value, folds = 5) {
    return crypto.createHash('sha256').update(String(value)).digest()[0] % folds;
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function exactContentFamily(row, transcript) {
    const normalizedTranscript = normalizeText(transcript);
    const normalizedTitle = normalizeText(row.title);
    const content = normalizedTranscript.length >= 20 ? normalizedTranscript : normalizedTitle;
    const durationBucket = Math.round(finite(row.durationSec, 0));
    return `exact:${hash(`${content}\u0000${durationBucket}`).slice(0, 20)}`;
}

function loadFrozenObjects() {
    if (!fs.existsSync(SNAPSHOT_MANIFEST_PATH)) {
        throw new Error(
            `Missing ${path.relative(process.cwd(), SNAPSHOT_MANIFEST_PATH)}. `
            + 'Run quant/freeze-snapshot.js before building a research panel.'
        );
    }
    const manifest = JSON.parse(fs.readFileSync(SNAPSHOT_MANIFEST_PATH, 'utf8'));
    if (
        manifest.schema !== 'quant-frozen-source-snapshot-v1'
        || manifest.protocol?.completeReadsPerObject !== 2
        || manifest.protocol?.metadataStableAcrossWholeCollection !== true
    ) {
        throw new Error('The quant snapshot manifest does not satisfy the strict freeze protocol.');
    }
    const byRole = new Map();
    for (const object of manifest.objects || []) {
        const objectPath = path.resolve(__dirname, object.localObject);
        if (!fs.existsSync(objectPath)) {
            throw new Error(`Frozen object missing for ${object.role}: ${objectPath}`);
        }
        const stat = fs.statSync(objectPath);
        if (stat.size !== object.bytes) {
            throw new Error(`Frozen object integrity failure for ${object.role}`);
        }
        const buffer = object.kind === 'json' ? fs.readFileSync(objectPath) : null;
        if (buffer && hash(buffer) !== object.sha256) {
            throw new Error(`Frozen object hash failure for ${object.role}`);
        }
        byRole.set(object.role, {
            ...object,
            objectPath,
            buffer,
            value: buffer ? JSON.parse(buffer.toString('utf8')) : null,
        });
    }
    return { manifest, byRole };
}

function indexMap(map) {
    return new Map((map.id || []).map((id, index) => [String(id), index]));
}

function loadReconstructedGeometries() {
    const output = { shorts: {}, long: {} };
    for (const [format, modality] of MAP_KEYS) {
        const geometryPath = path.join(GEOMETRY_DIR, `${format}-${modality}.json.gz`);
        if (!fs.existsSync(geometryPath)) {
            throw new Error(
                `Missing ${path.relative(process.cwd(), geometryPath)}. `
                + 'Run quant/reconstruct_geometry.py before building the panel.'
            );
        }
        const compressed = fs.readFileSync(geometryPath);
        const geometry = gunzipJson(compressed);
        output[format][modality] = {
            geometry,
            index: new Map(geometry.ids.map((id, index) => [String(id), index])),
            path: geometryPath,
            compressedSha256: hash(compressed),
        };
    }
    return output;
}

function projectionAt(map, index) {
    return Object.fromEntries(Object.entries(map.proj || {}).map(([name, projection]) => [
        name,
        {
            x: finite(projection.x?.[index]),
            y: finite(projection.y?.[index]),
            estimate: finite(projection.est?.[index]),
        },
    ]));
}

function clustersAt(map, index) {
    return Object.fromEntries(Object.entries(map.clusters || {}).map(([count, labels]) => [
        count,
        finite(labels?.[index]),
    ]));
}

function channelId(row) {
    return String(row.channelId || '').trim();
}

function strictRowGate(format, source) {
    const publishedSeconds = finite(source.timestamp);
    const storedMilliseconds = finite(source.storedAt);
    const width = finite(source.width);
    const height = finite(source.height);
    const durationSeconds = finite(source.durationSec);
    if (
        source.stored !== true
        || source.removed === true
        || source.rechecked === true
        || !channelId(source)
        || publishedSeconds == null
        || storedMilliseconds == null
        || finite(source.views, 0) <= 0
    ) return false;
    const observedAgeSeconds = (storedMilliseconds / 1000) - publishedSeconds;
    if (!(observedAgeSeconds > 0 && observedAgeSeconds <= 366 * 86_400)) return false;
    if (format === 'shorts') {
        return (
            durationSeconds != null
            && durationSeconds > 0
            && durationSeconds <= 180
            && width != null
            && height != null
            && height > width
        );
    }
    return width != null && height != null && width > height;
}

function rowFromDatabase(format, id, source, maps, geometries) {
    const publishedSeconds = finite(source.timestamp);
    const observationSeconds = Math.floor(finite(source.storedAt) / 1000);
    const views = Math.max(0, finite(source.views, 0));
    const subscribers = Math.max(0, finite(source.subs, 0));
    const modalityRows = {};
    let transcript = '';
    for (const payload of Object.values(maps)) {
        if (!payload.coherent) continue;
        const index = payload.index.get(String(id));
        if (index === undefined) continue;
        const map = payload.map;
        transcript ||= String(map.txt?.[index] || '');
    }
    for (const [modality, payload] of Object.entries(geometries)) {
        const index = payload.index.get(String(id));
        if (index === undefined) continue;
        const geometry = payload.geometry;
        const native = maps[modality];
        const nativeIndex = native?.coherent ? native.index.get(String(id)) : undefined;
        modalityRows[modality] = {
            available: true,
            silent: nativeIndex === undefined
                ? false
                : Boolean(native.map.silent?.[nativeIndex]),
            projections: {
                pca: {
                    x: finite(geometry.pca?.x?.[index]),
                    y: finite(geometry.pca?.y?.[index]),
                    estimate: null,
                },
            },
            clusters: clustersAt(geometry, index),
            geometrySource: 'outcome-blind-reconstructed-geometry-v1',
        };
    }
    const ageDays = (observationSeconds - publishedSeconds) / 86_400;
    return {
        observationId: `${format}:${id}`,
        videoId: String(id),
        format,
        sourceId: channelId(source),
        sourceName: String(source.channel || ''),
        contentFamilyId: exactContentFamily(source, transcript),
        publishedSeconds,
        observationSeconds,
        snapshotSeconds: observationSeconds,
        observationTimeSource: 'storedAt',
        ageDays,
        durationSeconds: finite(source.durationSec),
        title: String(source.title || ''),
        transcript,
        outcomes: {
            views,
            logViews: Math.log10(views + 1),
            subscribers,
            rawOutlier: finite(source.outlier),
            logSubscriberOutlier: subscribers > 0 ? Math.log10((views / subscribers) + 1) : null,
            likes: finite(source.likes),
            comments: finite(source.comments),
        },
        availability: {
            sourceHistory: 'A0-historically-observable-only',
            packaging: 'A1',
            transcript: transcript ? 'A2-opening' : null,
            views: 'A4-unrechecked-views-near-storedAt',
            likes: finite(source.likes) != null ? 'A5-post-outcome' : null,
        },
        modalities: modalityRows,
    };
}

async function loadUnifiedPanel() {
    const { manifest, byRole } = loadFrozenObjects();
    if (!fs.existsSync(SNAPSHOT_INTEGRITY_PATH)) {
        throw new Error('Missing snapshot-integrity.json. Run quant/verify_snapshot.py first.');
    }
    const integrity = JSON.parse(fs.readFileSync(SNAPSHOT_INTEGRITY_PATH, 'utf8'));
    if (integrity.snapshotRunId !== manifest.runId) {
        throw new Error('Snapshot integrity report does not match the frozen manifest.');
    }
    const coherence = new Map(
        (integrity.channels || []).map(channel => [
            channel.id,
            Boolean(channel.mapAndVectorIdOrderMatch),
        ])
    );
    const shorts = byRole.get('shorts:database');
    const long = byRole.get('long:database');
    if (!shorts || !long) throw new Error('Frozen snapshot is missing a canonical database.');
    const databaseByFormat = {
        shorts: shorts.value,
        long: long.value,
    };
    const mapsByFormat = { shorts: {}, long: {} };
    for (const [format, modality] of MAP_KEYS) {
        const loadedMap = byRole.get(`${format}:${modality}:map`);
        if (!loadedMap) throw new Error(`Frozen snapshot is missing ${format}:${modality}:map`);
        mapsByFormat[format][modality] = {
            map: loadedMap.value,
            index: indexMap(loadedMap.value),
            key: loadedMap.key,
            coherent: coherence.get(`${format}:${modality}`) === true,
        };
    }
    const geometriesByFormat = loadReconstructedGeometries();
    const rows = [];
    for (const format of ['shorts', 'long']) {
        const database = databaseByFormat[format];
        for (const [id, source] of Object.entries(database.videos || {})) {
            if (!source || !strictRowGate(format, source)) continue;
            rows.push(rowFromDatabase(
                format,
                id,
                source,
                mapsByFormat[format],
                geometriesByFormat[format]
            ));
        }
    }
    return {
        rows,
        provenance: (manifest.objects || []).map(item => ({
            role: item.role,
            key: item.key,
            frozenKey: item.frozenKey,
            bytes: item.bytes,
            sha256: item.sha256,
            sourceEtag: item.sourceEtag,
            frozenEtag: item.frozenEtag,
            lastModified: item.lastModified,
            completeReads: item.completeReads,
        })),
        snapshotRunId: manifest.runId,
        snapshotIdentityHash: manifest.identityHash,
        nativeMapIntegrity: integrity.channels,
        reconstructedGeometry: MAP_KEYS.map(([format, modality]) => {
            const payload = geometriesByFormat[format][modality];
            return {
                id: `${format}:${modality}`,
                vectorHash: payload.geometry.vectorHash,
                geometryContentHash: payload.geometry.contentHash,
                geometrySha256: payload.compressedSha256,
                rows: payload.geometry.ids.length,
                outcomesUsed: false,
            };
        }),
        mapKeys: MAP_KEYS,
    };
}

function gzipJson(value) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 });
}

function gunzipJson(buffer) {
    return JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
}

module.exports = {
    MAP_KEYS,
    finite,
    round,
    mean,
    median,
    quantile,
    variance,
    standardDeviation,
    rank,
    correlation,
    spearman,
    rSquared,
    mae,
    hash,
    deterministicFold,
    normalizeText,
    loadFrozenObjects,
    loadReconstructedGeometries,
    loadUnifiedPanel,
    gzipJson,
    gunzipJson,
};
