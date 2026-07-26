#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ quiet: true });

const {
    initR2,
    downloadFromR2,
} = require('../../../cloud-storage');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_PATH = path.join(__dirname, 'system-analysis.json');
const MAP_KEYS = [
    ['shorts', 'visual', 'raw/visual/map.json'],
    ['shorts', 'text', 'raw/text/map.json'],
    ['shorts', 'together', 'raw/together/map.json'],
    ['long', 'visual', 'raw-long/visual/map.json'],
    ['long', 'text', 'raw-long/text/map.json'],
    ['long', 'together', 'raw-long/together/map.json'],
];

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function finite(value, fallback = null) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function round(value, digits = 6) {
    if (!Number.isFinite(Number(value))) return null;
    return Number(Number(value).toFixed(digits));
}

function hashFold(value, folds = 5) {
    return crypto.createHash('sha256').update(String(value)).digest()[0] % folds;
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, center = mean(values)) {
    if (!values.length || !Number.isFinite(center)) return null;
    return values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / values.length;
}

function correlation(a, b) {
    if (a.length !== b.length || a.length < 3) return null;
    const am = mean(a);
    const bm = mean(b);
    let numerator = 0;
    let aa = 0;
    let bb = 0;
    for (let index = 0; index < a.length; index += 1) {
        const da = a[index] - am;
        const db = b[index] - bm;
        numerator += da * db;
        aa += da * da;
        bb += db * db;
    }
    return aa > 0 && bb > 0 ? numerator / Math.sqrt(aa * bb) : null;
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

function etaSquared(labels, values) {
    if (labels.length !== values.length || !values.length) return null;
    const center = mean(values);
    const groups = new Map();
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        total += (value - center) ** 2;
        const key = String(labels[index]);
        const current = groups.get(key) || { sum: 0, count: 0 };
        current.sum += value;
        current.count += 1;
        groups.set(key, current);
    }
    let between = 0;
    for (const group of groups.values()) {
        between += group.count * ((group.sum / group.count) - center) ** 2;
    }
    return total > 0 ? between / total : null;
}

function entropy(counts, total) {
    let output = 0;
    for (const count of counts.values()) {
        const probability = count / total;
        if (probability > 0) output -= probability * Math.log(probability);
    }
    return output;
}

function normalizedMutualInformation(a, b) {
    if (a.length !== b.length || !a.length) return null;
    const countA = new Map();
    const countB = new Map();
    const countAB = new Map();
    for (let index = 0; index < a.length; index += 1) {
        const left = String(a[index]);
        const right = String(b[index]);
        countA.set(left, (countA.get(left) || 0) + 1);
        countB.set(right, (countB.get(right) || 0) + 1);
        const pair = `${left}\u0000${right}`;
        countAB.set(pair, (countAB.get(pair) || 0) + 1);
    }
    const total = a.length;
    const entropyA = entropy(countA, total);
    const entropyB = entropy(countB, total);
    let information = 0;
    for (const [pair, count] of countAB.entries()) {
        const separator = pair.indexOf('\u0000');
        const left = pair.slice(0, separator);
        const right = pair.slice(separator + 1);
        const probability = count / total;
        const independent = (countA.get(left) / total) * (countB.get(right) / total);
        information += probability * Math.log(probability / independent);
    }
    return entropyA > 0 && entropyB > 0
        ? information / Math.sqrt(entropyA * entropyB)
        : null;
}

function partitionTransport(a, b) {
    if (a.length !== b.length || !a.length) return {
        observations: 0,
        nmi: null,
        variationOfInformationBits: null,
        links: [],
    };
    const countA = new Map();
    const countB = new Map();
    const pairs = new Map();
    for (let index = 0; index < a.length; index += 1) {
        const left = String(a[index]);
        const right = String(b[index]);
        countA.set(left, (countA.get(left) || 0) + 1);
        countB.set(right, (countB.get(right) || 0) + 1);
        const key = `${left}\u0000${right}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
    }
    const total = a.length;
    let information = 0;
    for (const [pair, count] of pairs.entries()) {
        const separator = pair.indexOf('\u0000');
        const left = pair.slice(0, separator);
        const right = pair.slice(separator + 1);
        const probability = count / total;
        const independent = (countA.get(left) / total) * (countB.get(right) / total);
        information += probability * Math.log(probability / independent);
    }
    const entropyA = entropy(countA, total);
    const entropyB = entropy(countB, total);
    const linksByLeft = new Map();
    for (const [pair, count] of pairs.entries()) {
        const separator = pair.indexOf('\u0000');
        const left = pair.slice(0, separator);
        const right = pair.slice(separator + 1);
        const leftTotal = countA.get(left);
        const rightTotal = countB.get(right);
        const link = {
            from: Number(left),
            to: Number(right),
            overlap: count,
            fromShare: round(count / leftTotal, 5),
            toShare: round(count / rightTotal, 5),
            jaccard: round(count / (leftTotal + rightTotal - count), 5),
        };
        if (!linksByLeft.has(left)) linksByLeft.set(left, []);
        linksByLeft.get(left).push(link);
    }
    const links = [];
    for (const rows of linksByLeft.values()) {
        rows.sort((left, right) => right.overlap - left.overlap);
        links.push(...rows.slice(0, 3));
    }
    return {
        observations: total,
        nmi: round(normalizedMutualInformation(a, b)),
        variationOfInformationBits: round(
            (entropyA + entropyB - (2 * information)) / Math.log(2)
        ),
        links: links.sort((left, right) => (
            left.from - right.from
            || right.overlap - left.overlap
        )),
        boundary: 'Links are descriptive maximum-overlap transports. A shared number or overlap does not make two clusters the same ontology.',
    };
}

function tailProfile(labels, views) {
    const groups = new Map();
    let totalHits = 0;
    for (let index = 0; index < labels.length; index += 1) {
        const key = String(labels[index]);
        const current = groups.get(key) || {
            cluster: Number(labels[index]),
            n: 0,
            hits10m: 0,
            logViews: [],
        };
        const value = Math.max(0, finite(views[index], 0));
        current.n += 1;
        current.hits10m += value >= 10_000_000 ? 1 : 0;
        current.logViews.push(Math.log10(value + 1));
        totalHits += value >= 10_000_000 ? 1 : 0;
        groups.set(key, current);
    }
    const baseRate = totalHits / labels.length;
    const rows = [...groups.values()].map(group => {
        const hitRate = group.hits10m / group.n;
        return {
            cluster: group.cluster,
            n: group.n,
            meanLogViews: round(mean(group.logViews), 4),
            hitRate10m: round(hitRate, 5),
            lift10m: baseRate > 0 ? round(hitRate / baseRate, 4) : null,
        };
    }).sort((a, b) => a.cluster - b.cluster);
    return {
        baseRate10m: round(baseRate, 5),
        maximumLift10m: round(Math.max(...rows.map(row => row.lift10m || 0)), 4),
        minimumLift10m: round(Math.min(...rows.map(row => row.lift10m || 0)), 4),
        clusters: rows,
    };
}

function sourceTransfer(map, labels, channelById) {
    const sourceCounts = new Map();
    const rows = [];
    for (let index = 0; index < map.id.length; index += 1) {
        const source = channelById.get(String(map.id[index]))
            || String(map.owner?.[index] || '');
        const views = finite(map.views[index], 0);
        if (!source || views <= 0) continue;
        sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
        rows.push({
            source,
            cluster: Number(labels[index]),
            logViews: Math.log10(views + 1),
        });
    }

    const eligible = rows.filter(row => (sourceCounts.get(row.source) || 0) >= 5);
    const sourceMeans = new Map();
    for (const row of eligible) {
        const current = sourceMeans.get(row.source) || { sum: 0, count: 0 };
        current.sum += row.logViews;
        current.count += 1;
        sourceMeans.set(row.source, current);
    }
    for (const row of eligible) {
        const source = sourceMeans.get(row.source);
        row.centeredLogViews = row.logViews - (source.sum / source.count);
    }

    const predicted = [];
    const actual = [];
    const sources = [];
    for (let fold = 0; fold < 5; fold += 1) {
        const training = eligible.filter(row => hashFold(row.source) !== fold);
        const testing = eligible.filter(row => hashFold(row.source) === fold);
        const globalMean = mean(training.map(row => row.centeredLogViews)) || 0;
        const clusterMeans = new Map();
        for (const row of training) {
            const current = clusterMeans.get(row.cluster) || { sum: 0, count: 0 };
            current.sum += row.centeredLogViews;
            current.count += 1;
            clusterMeans.set(row.cluster, current);
        }
        for (const row of testing) {
            const cluster = clusterMeans.get(row.cluster);
            predicted.push(cluster ? cluster.sum / cluster.count : globalMean);
            actual.push(row.centeredLogViews);
            sources.push(row.source);
        }
    }

    return {
        rows: eligible.length,
        sources: sourceMeans.size,
        minimumVideosPerSource: 5,
        globalClusterEtaSquared: round(etaSquared(
            eligible.map(row => row.cluster),
            eligible.map(row => row.logViews)
        )),
        sourceCenteredClusterEtaSquared: round(etaSquared(
            eligible.map(row => row.cluster),
            eligible.map(row => row.centeredLogViews)
        )),
        creatorFoldR: round(correlation(actual, predicted)),
        creatorFoldR2: round(rSquared(actual, predicted)),
        foldPolicy: 'Cluster effects fit on four deterministic channel folds and evaluated on the fifth; outcomes are centered within each held-out channel only for the diagnostic ranking test.',
        sourceIdentity: 'YouTube channel title joined by exact video ID from the corresponding Library database.',
        predictions: {
            n: predicted.length,
            mean: round(mean(predicted)),
            standardDeviation: round(Math.sqrt(variance(predicted) || 0)),
        },
        actual: {
            mean: round(mean(actual)),
            standardDeviation: round(Math.sqrt(variance(actual) || 0)),
        },
    };
}

function partitionSummary(format, modality, map, clusterCount, channelById) {
    const labels = map.clusters[String(clusterCount)] || [];
    const logViews = map.views.map(value => Math.log10(Math.max(0, finite(value, 0)) + 1));
    const logOutlier = map.outlier.map(value => Math.log10(Math.max(0, finite(value, 0)) + 1));
    return {
        id: `${format}:${modality}:k${clusterCount}`,
        format,
        modality,
        clusterCount,
        observations: labels.length,
        outcomeBlindGeometry: true,
        global: {
            viewsEtaSquared: round(etaSquared(labels, logViews)),
            outlierEtaSquared: round(etaSquared(labels, logOutlier)),
            ...tailProfile(labels, map.views),
        },
        sourceTransfer: sourceTransfer(map, labels, channelById),
    };
}

function stableNumber(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function atlasSample(map, channelById, limit = 2400) {
    const total = finite(map.n, map.id?.length || 0);
    if (!total) return [];

    const selected = new Set();
    const owned = [];
    const ranked = [];
    for (let index = 0; index < total; index += 1) {
        if (map.mine?.[index]) owned.push(index);
        ranked.push({
            index,
            views: finite(map.views?.[index], 0),
            hash: stableNumber(map.id?.[index] ?? index),
        });
    }
    owned.slice(0, 800).forEach(index => selected.add(index));
    ranked
        .slice()
        .sort((left, right) => right.views - left.views || left.hash - right.hash)
        .slice(0, 120)
        .forEach(row => selected.add(row.index));
    ranked
        .slice()
        .sort((left, right) => left.hash - right.hash)
        .slice(0, Math.max(0, limit - selected.size))
        .forEach(row => selected.add(row.index));

    const projectionNames = Object.keys(map.proj || {});
    const clusterCounts = Object.keys(map.clusters || {}).sort((a, b) => Number(a) - Number(b));
    return [...selected]
        .slice(0, limit)
        .map(index => {
            const id = String(map.id?.[index] || index);
            return {
                id,
                title: String(map.title?.[index] || ''),
                transcript: String(map.txt?.[index] || ''),
                source: channelById.get(id) || 'unknown source',
                views: finite(map.views?.[index], 0),
                outlier: finite(map.outlier?.[index], 0),
                subscribers: finite(map.subs?.[index], 0),
                owned: Boolean(map.mine?.[index]),
                silent: Boolean(map.silent?.[index]),
                clusters: Object.fromEntries(clusterCounts.map(clusterCount => [
                    clusterCount,
                    finite(map.clusters?.[clusterCount]?.[index]),
                ])),
                projections: Object.fromEntries(projectionNames.map(name => [
                    name,
                    {
                        x: finite(map.proj?.[name]?.x?.[index]),
                        y: finite(map.proj?.[name]?.y?.[index]),
                        estimate: finite(map.proj?.[name]?.est?.[index]),
                    },
                ])),
            };
        });
}

function mapSummary(format, modality, key, map, channelById, status) {
    const partitions = Object.keys(map.clusters || {})
        .map(Number)
        .sort((a, b) => a - b)
        .map(clusterCount => partitionSummary(format, modality, map, clusterCount, channelById));
    const resolutionEdges = [];
    for (let left = 0; left < partitions.length; left += 1) {
        for (let right = left + 1; right < partitions.length; right += 1) {
            const a = partitions[left].clusterCount;
            const b = partitions[right].clusterCount;
            resolutionEdges.push({
                from: a,
                to: b,
                ...partitionTransport(
                    map.clusters[String(a)],
                    map.clusters[String(b)]
                ),
            });
        }
    }
    const complete = finite(status?.complete?.[modality], map.n);
    return {
        id: `${format}:${modality}`,
        format,
        modality,
        key,
        endpoint: format === 'shorts'
            ? `/api/raw/map?channel=${modality}`
            : `/api/raw-long/map?channel=${modality}`,
        mapRows: finite(map.n, 0),
        embeddedRows: complete,
        mapCoverageOfCurrentEmbeddings: complete > 0 ? round(map.n / complete, 5) : null,
        stale: complete > finite(map.n, 0),
        updatedAt: Number.isFinite(Number(map.updated))
            ? new Date(Number(map.updated) * 1000).toISOString()
            : null,
        heldout: {
            auc10m: finite(map.heldout_auc10m),
            viewsCorrelation: finite(map.heldout_rviews),
            split: 'one deterministic random 70/30 split by video, not grouped by channel and not chronological',
        },
        ownedRows: finite(map.nmine, 0),
        silentRows: finite(map.nsilent, 0),
        silentFraction: map.n > 0 ? round(finite(map.nsilent, 0) / map.n, 5) : 0,
        projections: Object.fromEntries(Object.entries(map.proj || {}).map(([name, projection]) => [
            name,
            {
                viewsCorrelation: finite(projection.cv),
                outlierCorrelation: finite(projection.co),
                supervised: !['pca', 'umap'].includes(name),
                projectedTarget: Array.isArray(projection.est),
            },
        ])),
        atlasSample: atlasSample(map, channelById),
        atlasSampling: {
            method: 'all owned observations, highest-view tail, then deterministic ID-hash sample',
            limit: 2400,
            sampledRows: Math.min(finite(map.n, 0), 2400),
            overviewOnly: true,
            fullMapEndpoint: format === 'shorts'
                ? `/api/raw/map?channel=${modality}`
                : `/api/raw-long/map?channel=${modality}`,
        },
        partitions,
        resolutionEdges,
    };
}

function modalityAgreement(format, left, right) {
    const rightIndex = new Map(right.map.id.map((id, index) => [String(id), index]));
    const pairs = [];
    for (let index = 0; index < left.map.id.length; index += 1) {
        const match = rightIndex.get(String(left.map.id[index]));
        if (match !== undefined) pairs.push([index, match]);
    }
    const clusterCounts = [...new Set([
        ...Object.keys(left.map.clusters || {}),
        ...Object.keys(right.map.clusters || {}),
    ])].filter(key => left.map.clusters[key] && right.map.clusters[key])
        .map(Number)
        .sort((a, b) => a - b);
    const byResolution = clusterCounts.map(clusterCount => ({
        clusterCount,
        ...partitionTransport(
            pairs.map(([index]) => left.map.clusters[String(clusterCount)][index]),
            pairs.map(([, index]) => right.map.clusters[String(clusterCount)][index])
        ),
    }));
    const output = {
        id: `${format}:${left.modality}:${right.modality}`,
        format,
        left: left.modality,
        right: right.modality,
        commonObservations: pairs.length,
        byResolution,
        meanNmi: round(mean(byResolution.map(row => row.nmi))),
    };
    if (format === 'shorts' && [left.modality, right.modality].sort().join(':') === 'together:visual') {
        const visual = left.modality === 'visual' ? left : right;
        const together = left.modality === 'together' ? left : right;
        const togetherIndex = new Map(together.map.id.map((id, index) => [String(id), index]));
        for (const subset of ['silent', 'voiced']) {
            const subsetPairs = [];
            for (let index = 0; index < visual.map.id.length; index += 1) {
                const match = togetherIndex.get(String(visual.map.id[index]));
                if (match === undefined) continue;
                const isSilent = Boolean(visual.map.silent?.[index]);
                if ((subset === 'silent') === isSilent) subsetPairs.push([index, match]);
            }
            output[subset] = {
                observations: subsetPairs.length,
                byResolution: clusterCounts.map(clusterCount => ({
                    clusterCount,
                    nmi: round(normalizedMutualInformation(
                        subsetPairs.map(([index]) => visual.map.clusters[String(clusterCount)][index]),
                        subsetPairs.map(([, index]) => together.map.clusters[String(clusterCount)][index])
                    )),
                })),
            };
        }
    }
    return output;
}

async function loadR2Json(key, provenance) {
    const bytes = await downloadFromR2(key);
    if (!bytes) throw new Error(`Missing R2 source: ${key}`);
    provenance.push({
        id: `r2:${key}`,
        location: 'r2',
        key,
        bytes: bytes.length,
        sha256: sha256(bytes),
    });
    return JSON.parse(bytes.toString('utf8'));
}

function databaseSummary(format, database) {
    const rows = Object.values(database.videos || {});
    const stored = rows.filter(row => row?.stored && !row?.failed && !row?.removed);
    const channels = new Set(rows.map(row => String(row?.channelId || row?.channel || '')).filter(Boolean));
    return {
        format,
        records: rows.length,
        stored: stored.length,
        channels: channels.size,
        withViews: rows.filter(row => finite(row?.views, 0) > 0).length,
        withPublishedTime: rows.filter(row => row?.timestamp || row?.uploadDate || row?.publishedAt).length,
        updatedAt: finite(database.updated)
            ? new Date(finite(database.updated) > 1e12 ? finite(database.updated) : finite(database.updated) * 1000).toISOString()
            : null,
    };
}

async function main() {
    if (!initR2()) throw new Error('R2 credentials are required for the whole-system analysis refresh.');
    const provenance = [];
    const shortsDatabase = await loadR2Json('library/db.json', provenance);
    const longDatabase = await loadR2Json('longform/db.json', provenance);
    const shortsChannels = new Map(Object.entries(shortsDatabase.videos || {}).map(([id, row]) => [
        String(id),
        String(row?.channel || row?.channelId || ''),
    ]));
    const longChannels = new Map(Object.entries(longDatabase.videos || {}).map(([id, row]) => [
        String(id),
        String(row?.channel || row?.channelId || ''),
    ]));

    const statuses = {
        shorts: await loadR2Json('raw/predictor-lab/embed-status.json', provenance),
        long: null,
        predictor: await loadR2Json('raw/predictor-lab/status.json', provenance),
        predictorMetadata: await loadR2Json('raw/predictor-lab/metadata-status.json', provenance),
    };

    const maps = [];
    const loadedMaps = [];
    for (const [format, modality, key] of MAP_KEYS) {
        const map = await loadR2Json(key, provenance);
        const channelById = format === 'shorts' ? shortsChannels : longChannels;
        const status = format === 'shorts' ? statuses.shorts : null;
        maps.push(mapSummary(format, modality, key, map, channelById, status));
        loadedMaps.push({ format, modality, map });
    }

    const modalityEdges = [];
    for (const format of ['shorts', 'long']) {
        const formatMaps = loadedMaps.filter(row => row.format === format);
        for (const [left, right] of [
            ['visual', 'text'],
            ['visual', 'together'],
            ['text', 'together'],
        ]) {
            modalityEdges.push(modalityAgreement(
                format,
                formatMaps.find(row => row.modality === left),
                formatMaps.find(row => row.modality === right)
            ));
        }
    }

    const sourcePath = path.relative(ROOT, __filename);
    const sourceBytes = fs.readFileSync(__filename);
    provenance.push({
        id: `local:${sourcePath}`,
        location: 'local',
        path: sourcePath,
        bytes: sourceBytes.length,
        sha256: sha256(sourceBytes),
    });

    const output = {
        schema: 'whole-system-cluster-analysis-v2',
        generatedAt: new Date().toISOString(),
        contract: 'DISCOVERY_CONTRACT.md',
        databases: [
            databaseSummary('shorts', shortsDatabase),
            databaseSummary('long', longDatabase),
        ],
        liveStatus: {
            shortsEmbedding: statuses.shorts,
            predictor: statuses.predictor,
            predictorMetadata: statuses.predictorMetadata,
        },
        rawMaps: maps,
        modalityEdges,
        provenance,
    };
    output.analysisHash = sha256(Buffer.from(JSON.stringify(output)));
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
    console.log(JSON.stringify({
        output: path.relative(ROOT, OUTPUT_PATH),
        hash: output.analysisHash,
        databases: output.databases,
        maps: maps.map(map => ({
            id: map.id,
            rows: map.mapRows,
            embedded: map.embeddedRows,
            stale: map.stale,
        })),
        partitions: maps.reduce((sum, map) => sum + map.partitions.length, 0),
        modalityEdges: modalityEdges.length,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
