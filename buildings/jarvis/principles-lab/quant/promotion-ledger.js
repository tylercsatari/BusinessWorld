#!/usr/bin/env node
'use strict';

/*
 * Multiplicity-aware research promotion ledger.
 *
 * This is deliberately separate from every UI and analysis builder. It audits
 * the artifacts those programs emitted, distinguishes observations from their
 * many transformed views, and places a ceiling on claims that the available
 * evidence can support.
 *
 * Usage:
 *   node promotion-ledger.js
 *   node promotion-ledger.js --json
 *   node promotion-ledger.js --out /tmp/promotion-ledger.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const JARVIS_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ALPHA = 0.05;
const REQUIRED_SNAPSHOT_ROLES = [
    'shorts:database',
    'long:database',
    'shorts:visual:map',
    'shorts:text:map',
    'shorts:together:map',
    'long:visual:map',
    'long:text:map',
    'long:together:map',
    'shorts:visual:vectors',
    'shorts:text:vectors',
    'shorts:together:vectors',
    'long:visual:vectors',
    'long:text:vectors',
    'long:together:vectors',
];

const FILES = {
    operations: path.join(JARVIS_ROOT, 'operations-lab', '.cache', 'principles85-ledger.json'),
    promiseSummary: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'discovery-summary.json'),
    promiseClusters: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'cluster-experiments.jsonl.gz'),
    promiseBoundaries: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'boundary-experiments.jsonl.gz'),
    promiseAllSpans: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'all-span-cluster-experiments.jsonl.gz'),
    promiseOutcomeRows: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'cluster-outcomes-experiments.jsonl.gz'),
    promiseOutcomes: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'cluster-outcomes.json'),
    promiseForward: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'forward-response.json'),
    promiseQuality: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'hook-quality.json'),
    promiseMarket: path.join(JARVIS_ROOT, 'promise-lab', '.cache', 'market-reward.json'),
    retention: path.join(JARVIS_ROOT, 'retention-study', 'retention_study.json'),
    tribe: path.join(JARVIS_ROOT, 'retention-study', 'tribe-corr.json'),
    legacyRegistry: path.join(JARVIS_ROOT, 'indicator-registry.json'),
    legacyIndicators: path.join(JARVIS_ROOT, 'indicators_compact.json'),
    legacyExperiments: path.join(JARVIS_ROOT, 'experiments_log_compact.json'),
    legacyDerived: path.join(JARVIS_ROOT, 'derived_experiments_compact.json'),
    legacyGraph: path.join(JARVIS_ROOT, 'graph_compact.json'),
    legacyQuestions: path.join(JARVIS_ROOT, 'research_questions.json'),
    unifiedPanel: path.join(__dirname, '.cache', 'unified-panel.json.gz'),
    opportunityTargets: path.join(__dirname, '.cache', 'opportunity-targets.json.gz'),
    panelSummary: path.join(__dirname, 'panel-summary.json'),
    snapshotManifest: path.join(__dirname, 'snapshot-manifest.json'),
    snapshotIntegrity: path.join(__dirname, 'snapshot-integrity.json'),
    reconstructedGeometry: path.join(__dirname, 'reconstructed-geometry-summary.json'),
    semanticFamilies: path.join(__dirname, 'semantic-family-summary.json'),
    clusterInvariance: path.join(__dirname, 'cluster-invariance.json'),
    estimandSpec: path.join(__dirname, 'ESTIMAND_SPEC.md'),
    opportunityAdjustment: path.join(__dirname, 'opportunity-adjustment.json'),
    clusterOutcomesAdjusted: path.join(__dirname, 'cluster-outcomes-adjusted.json'),
    nestedOutcomeValidation: path.join(__dirname, 'nested-outcome-validation.json'),
    rawEmbeddingValidation: path.join(__dirname, 'raw-embedding-validation.json'),
    withinCreatorDeltaValidation:
        path.join(__dirname, 'within-creator-delta-validation.json'),
    baselineSensitivityValidation:
        path.join(__dirname, 'baseline-sensitivity-validation.json'),
    factorizedValidation: path.join(__dirname, 'factorized-validation.json'),
};

const TRIBE_FEATURES = ['mean', 'slope', 'peak', 'argmax', 'delta'];
const TRIBE_TARGETS = [
    'keep',
    'ret5_surv',
    'swiped',
    'avgRetention',
    'logviews',
    'views',
    'realviews',
    'ret5',
    'likes',
    'comments',
    'shares',
];
const TRIBE_CORE_TARGETS = new Set(['keep', 'ret5_surv', 'avgRetention', 'logviews']);

function requiredJson(file) {
    if (!fs.existsSync(file)) throw new Error(`Required artifact is missing: ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 9) {
    return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
    return values.length ? sum(values) / values.length : null;
}

function tally(rows, getter) {
    const output = {};
    for (const row of rows) {
        const key = String(getter(row) ?? 'missing');
        output[key] = (output[key] || 0) + 1;
    }
    return output;
}

function overlapSize(left, right) {
    let count = 0;
    const smaller = left.size <= right.size ? left : right;
    const larger = smaller === left ? right : left;
    for (const value of smaller) if (larger.has(value)) count += 1;
    return count;
}

function rank(values) {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const output = Array(values.length);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
        const averageRank = ((start + 1) + end) / 2;
        for (let index = start; index < end; index += 1) {
            output[ordered[index].index] = averageRank;
        }
        start = end;
    }
    return output;
}

function correlation(left, right) {
    if (left.length !== right.length || left.length < 3) return null;
    const leftMean = mean(left);
    const rightMean = mean(right);
    let numerator = 0;
    let leftSquare = 0;
    let rightSquare = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index] - leftMean;
        const b = right[index] - rightMean;
        numerator += a * b;
        leftSquare += a * a;
        rightSquare += b * b;
    }
    return leftSquare > 0 && rightSquare > 0
        ? numerator / Math.sqrt(leftSquare * rightSquare)
        : null;
}

function residualizeLinear(values, control) {
    const controlMean = mean(control);
    const valueMean = mean(values);
    let cross = 0;
    let square = 0;
    for (let index = 0; index < values.length; index += 1) {
        cross += (control[index] - controlMean) * (values[index] - valueMean);
        square += (control[index] - controlMean) ** 2;
    }
    const slope = square > 0 ? cross / square : 0;
    return values.map((value, index) => (
        value - (valueMean + slope * (control[index] - controlMean))
    ));
}

// Lanczos log-gamma and incomplete beta support an actual Student-t tail.
// The Tribe UI currently substitutes a normal tail for a t statistic.
function logGamma(value) {
    const coefficients = [
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];
    if (value < 0.5) {
        return Math.log(Math.PI)
            - Math.log(Math.sin(Math.PI * value))
            - logGamma(1 - value);
    }
    let shifted = value - 1;
    let series = coefficients[0];
    for (let index = 1; index < coefficients.length; index += 1) {
        series += coefficients[index] / (shifted + index);
    }
    const scale = shifted + 7.5;
    return 0.5 * Math.log(2 * Math.PI)
        + (shifted + 0.5) * Math.log(scale)
        - scale
        + Math.log(series);
}

function betaContinuedFraction(a, b, x) {
    const maxIterations = 300;
    const epsilon = 3e-14;
    const floor = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x / qap);
    if (Math.abs(d) < floor) d = floor;
    d = 1 / d;
    let result = d;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const doubled = 2 * iteration;
        let adjustment = iteration * (b - iteration) * x
            / ((qam + doubled) * (a + doubled));
        d = 1 + adjustment * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + adjustment / c;
        if (Math.abs(c) < floor) c = floor;
        d = 1 / d;
        result *= d * c;
        adjustment = -(a + iteration) * (qab + iteration) * x
            / ((a + doubled) * (qap + doubled));
        d = 1 + adjustment * d;
        if (Math.abs(d) < floor) d = floor;
        c = 1 + adjustment / c;
        if (Math.abs(c) < floor) c = floor;
        d = 1 / d;
        const delta = d * c;
        result *= delta;
        if (Math.abs(delta - 1) < epsilon) break;
    }
    return result;
}

function regularizedIncompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(
        logGamma(a + b)
        - logGamma(a)
        - logGamma(b)
        + a * Math.log(x)
        + b * Math.log1p(-x)
    );
    if (x < (a + 1) / (a + b + 2)) {
        return front * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function correlationPValue(r, n, controls = 0) {
    const degrees = n - controls - 2;
    if (!Number.isFinite(r) || degrees <= 0) return 1;
    if (Math.abs(r) >= 1) return 0;
    const tSquared = r * r * degrees / (1 - r * r);
    const x = degrees / (degrees + tSquared);
    return Math.max(0, Math.min(1, regularizedIncompleteBeta(x, degrees / 2, 0.5)));
}

function harmonicNumber(count) {
    let value = 0;
    for (let index = 1; index <= count; index += 1) value += 1 / index;
    return value;
}

function adjustPValues(values, method = 'BY') {
    const count = values.length;
    if (!count) return [];
    const dependencyFactor = method.toUpperCase() === 'BY' ? harmonicNumber(count) : 1;
    const ordered = values
        .map((value, index) => ({ value: Math.max(0, Math.min(1, finite(value, 1))), index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const adjusted = Array(count);
    let running = 1;
    for (let index = count - 1; index >= 0; index -= 1) {
        running = Math.min(
            running,
            ordered[index].value * count * dependencyFactor / (index + 1)
        );
        adjusted[ordered[index].index] = Math.max(0, Math.min(1, running));
    }
    return adjusted;
}

function familyGateP(values) {
    return values.length ? Math.min(1, Math.min(...values) * values.length) : 1;
}

async function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function provenance(file) {
    const stat = fs.statSync(file);
    return {
        path: path.relative(JARVIS_ROOT, file),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sha256: await sha256File(file),
    };
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function hasAllModalities(row) {
    return ['visual', 'text', 'together'].every(
        modality => row.modalities?.[modality]?.available === true
    );
}

function parseStrictSupportContract() {
    const text = fs.readFileSync(FILES.estimandSpec, 'utf8');
    const coverageSection = text
        .split('Embedding coverage on these strict targets:')[1]
        ?.split('Consequences:')[0] || '';
    const supportSection = text
        .split('Exact strict support with at least one historically observable prior:')[1]
        ?.split('Embedding coverage on these strict targets:')[0] || '';
    const coverage = {};
    for (const format of ['Shorts', 'Long']) {
        const match = coverageSection.match(new RegExp(
            `\\| ${format} \\|\\s*([\\d,]+)\\s*\\|\\s*([\\d,]+)\\s*`
            + '\\|\\s*([\\d,]+)\\s*\\|\\s*([\\d,]+)\\s*\\|'
        ));
        coverage[format.toLowerCase()] = match ? {
            visual: Number(match[1].replaceAll(',', '')),
            text: Number(match[2].replaceAll(',', '')),
            together: Number(match[3].replaceAll(',', '')),
            allThree: Number(match[4].replaceAll(',', '')),
        } : null;
    }
    const historicalTargets = {};
    for (const format of ['Shorts', 'Long']) {
        const match = supportSection.match(new RegExp(
            `\\| ${format} \\|\\s*([\\d,]+)\\s*\\|\\s*([\\d,]+)\\s*`
            + '\\|\\s*([\\d,]+)'
        ));
        historicalTargets[format.toLowerCase()] = match ? {
            targets: Number(match[1].replaceAll(',', '')),
            channels: Number(match[2].replaceAll(',', '')),
            medianPriorCount: Number(match[3].replaceAll(',', '')),
        } : null;
    }
    const powerMatch = text.match(/this is about ([\d,]+)\s+independent observations/i);
    return {
        source: path.relative(JARVIS_ROOT, FILES.estimandSpec),
        exactStrictHistoricalTargets: historicalTargets,
        exactStrictHistoricalAllModalitySupport: coverage,
        minimumIndependentRowsBeforeDesignEffect:
            powerMatch ? Number(powerMatch[1].replaceAll(',', '')) : null,
        historicalRule: 'prior j may enter target i only when S_j = storedAt_j / 1000 <= T_i',
    };
}

async function auditFrozenSnapshotManifest() {
    const immutableRoot = path.resolve(__dirname, '.cache', 'frozen', 'objects');
    const failures = [];
    if (!fs.existsSync(FILES.snapshotManifest)) {
        return {
            report: {
                exists: false,
                pass: false,
                requiredRoles: REQUIRED_SNAPSHOT_ROLES.length,
                objectCount: 0,
                failures: ['snapshot-manifest.json is missing'],
            },
            objectPaths: new Map(),
            objectRecords: new Map(),
        };
    }

    let manifest;
    try {
        manifest = requiredJson(FILES.snapshotManifest);
    } catch (error) {
        return {
            report: {
                exists: true,
                pass: false,
                requiredRoles: REQUIRED_SNAPSHOT_ROLES.length,
                objectCount: 0,
                failures: [`manifest parse failed: ${error.message}`],
            },
            objectPaths: new Map(),
            objectRecords: new Map(),
        };
    }

    if (manifest.schema !== 'quant-frozen-source-snapshot-v1') {
        failures.push(`unexpected manifest schema ${manifest.schema || 'missing'}`);
    }
    if (manifest.protocol?.completeReadsPerObject !== 2) {
        failures.push('manifest does not require two complete reads per object');
    }
    if (manifest.protocol?.metadataStableWithinEachRead !== true) {
        failures.push('within-read metadata stability is not certified');
    }
    if (manifest.protocol?.metadataStableAcrossWholeCollection !== true) {
        failures.push('whole-collection metadata stability is not certified');
    }
    if (manifest.protocol?.contentAddressedLocalObjects !== true) {
        failures.push('content-addressed local storage is not certified');
    }

    const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
    const byRole = new Map();
    const duplicateRoles = [];
    let verifiedLocalObjects = 0;
    let verifiedBytes = 0;
    for (const object of objects) {
        if (byRole.has(object.role)) duplicateRoles.push(object.role);
        byRole.set(object.role, object);
    }
    if (duplicateRoles.length) {
        failures.push(`duplicate manifest roles: ${[...new Set(duplicateRoles)].join(', ')}`);
    }
    const missingRoles = REQUIRED_SNAPSHOT_ROLES.filter(role => !byRole.has(role));
    if (missingRoles.length) failures.push(`missing required roles: ${missingRoles.join(', ')}`);

    const objectPaths = new Map();
    for (const object of objects) {
        if (object.completeReads !== 2) {
            failures.push(`${object.role || 'unknown role'} does not record exactly two reads`);
        }
        if (!(object.etag || (object.sourceEtag && object.frozenEtag)) || !object.lastModified) {
            failures.push(`${object.role || 'unknown role'} lacks immutable source metadata`);
        }
        if (manifest.protocol?.serverSideConditionalCopy === true) {
            const prefix = String(manifest.protocol?.immutableR2Prefix || '');
            if (!prefix || !String(object.frozenKey || '').startsWith(prefix)) {
                failures.push(`${object.role || 'unknown role'} is not bound to the immutable R2 prefix`);
            }
        }
        const objectPath = path.resolve(__dirname, String(object.localObject || ''));
        const relativeToImmutableRoot = path.relative(immutableRoot, objectPath);
        const contentAddressed = (
            relativeToImmutableRoot
            && !relativeToImmutableRoot.startsWith('..')
            && !path.isAbsolute(relativeToImmutableRoot)
            && path.basename(objectPath).startsWith(String(object.sha256 || 'missing'))
        );
        if (!contentAddressed) {
            failures.push(`${object.role || 'unknown role'} is not content-addressed under frozen/objects`);
            continue;
        }
        if (!fs.existsSync(objectPath)) {
            failures.push(`${object.role || 'unknown role'} frozen object is missing`);
            continue;
        }
        const stat = fs.statSync(objectPath);
        if (stat.size !== finite(object.bytes)) {
            failures.push(`${object.role || 'unknown role'} frozen byte count changed`);
            continue;
        }
        const localSha256 = await sha256File(objectPath);
        if (localSha256 !== object.sha256) {
            failures.push(`${object.role || 'unknown role'} frozen hash changed`);
            continue;
        }
        verifiedLocalObjects += 1;
        verifiedBytes += stat.size;
        objectPaths.set(object.role, objectPath);
    }

    const identity = objects.map(object => {
        const row = {
            role: object.role,
            key: object.key,
            sha256: object.sha256,
        };
        if (object.sourceEtag || object.frozenEtag) {
            row.sourceEtag = object.sourceEtag;
            row.frozenEtag = object.frozenEtag;
        } else {
            row.etag = object.etag;
        }
        return row;
    });
    const computedIdentityHash = sha256(JSON.stringify(identity));
    if (manifest.identityHash !== computedIdentityHash) {
        failures.push('snapshot identity hash does not match the object manifest');
    }
    if (manifest.runId !== computedIdentityHash.slice(0, 24)) {
        failures.push('snapshot runId does not match the identity hash');
    }
    const freezeFailures = failures.slice();
    let representationIntegrity = {
        exists: false,
        accepted: false,
        snapshotRunIdMatches: false,
        snapshotIdentityHashMatches: false,
        acceptedChannels: 0,
        rejectedChannels: REQUIRED_SNAPSHOT_ROLES.filter(role => role.endsWith(':vectors')).length,
        failures: ['snapshot-integrity.json is missing'],
    };
    if (fs.existsSync(FILES.snapshotIntegrity)) {
        const integrity = requiredJson(FILES.snapshotIntegrity);
        const channels = Array.isArray(integrity.channels) ? integrity.channels : [];
        representationIntegrity = {
            exists: true,
            accepted: integrity.accepted === true,
            snapshotRunIdMatches: integrity.snapshotRunId === manifest.runId,
            snapshotIdentityHashMatches:
                integrity.snapshotIdentityHash === manifest.identityHash,
            acceptedChannels: channels.filter(row => (
                row.mapAndVectorRowCountMatch === true
                && row.mapAndVectorIdOrderMatch === true
            )).length,
            rejectedChannels: channels.filter(row => (
                row.mapAndVectorRowCountMatch !== true
                || row.mapAndVectorIdOrderMatch !== true
            )).length,
            failures: integrity.failures || [],
            channels: channels.map(row => ({
                id: row.id,
                mapRows: row.mapRows,
                vectorRows: row.vectorRows,
                dimensions: row.dimensions,
                rowCountMatch: row.mapAndVectorRowCountMatch,
                idOrderMatch: row.mapAndVectorIdOrderMatch,
                duplicateMapIds: row.duplicateMapIds,
                duplicateVectorIds: row.duplicateVectorIds,
                sampledVectors: row.sampledVectors,
                sampleAllFinite: row.sampleAllFinite,
            })),
        };
    }
    if (!representationIntegrity.accepted) {
        failures.push(
            `snapshot representation integrity rejected: ${
                representationIntegrity.failures.join('; ') || 'unspecified failure'
            }`
        );
    }
    if (!representationIntegrity.snapshotRunIdMatches) {
        failures.push('snapshot integrity runId does not match the source manifest');
    }
    if (!representationIntegrity.snapshotIdentityHashMatches) {
        failures.push('snapshot integrity identity hash does not match the source manifest');
    }

    return {
        report: {
            exists: true,
            pass: freezeFailures.length === 0,
            freezePass: freezeFailures.length === 0,
            allSnapshotIntegrityPass: failures.length === 0,
            schema: manifest.schema,
            runId: manifest.runId,
            identityHash: manifest.identityHash,
            requiredRoles: REQUIRED_SNAPSHOT_ROLES.length,
            objectCount: objects.length,
            verifiedLocalObjects,
            verifiedBytes,
            completeReadsPerObject: manifest.protocol?.completeReadsPerObject,
            metadataStableAcrossWholeCollection:
                manifest.protocol?.metadataStableAcrossWholeCollection === true,
            contentAddressedLocalObjects:
                manifest.protocol?.contentAddressedLocalObjects === true,
            serverSideConditionalCopy:
                manifest.protocol?.serverSideConditionalCopy === true,
            immutableR2Prefix: manifest.protocol?.immutableR2Prefix || null,
            mutableSourcesChangedAfterConditionalCopy:
                manifest.protocol?.sourceObjectsChangedDuringFreeze || [],
            representationIntegrity,
            missingRoles,
            freezeFailures,
            allFailures: failures,
        },
        objectPaths,
        objectRecords: byRole,
    };
}

function makePanelFormatAudit() {
    return {
        rows: 0,
        uniqueObservationIds: 0,
        duplicateObservationIds: 0,
        currentAllModalityRows: 0,
        storedFieldPresent: 0,
        recheckedFieldPresent: 0,
        storedAtFieldPresent: 0,
        observationSecondsPresent: 0,
        observationTimeSourceStoredAt: 0,
        snapshotSecondsPresent: 0,
        uniqueSnapshotSeconds: 0,
        sourceCrosscheck: null,
        historicallyObservableSupport: null,
    };
}

function auditPanelHistory(rows) {
    const byFormatAndSource = new Map();
    for (const row of rows) {
        const key = `${row.format}\u0000${row.sourceId}`;
        if (!byFormatAndSource.has(key)) byFormatAndSource.set(key, []);
        byFormatAndSource.get(key).push(row);
    }
    const output = {
        shorts: {
            targetsWithPrior: 0,
            allModalityTargetsWithPrior: 0,
            priorComparisonsUsed: 0,
            observabilityViolationsInComputedHistory: 0,
            unobservablePublishedPriorsExcluded: 0,
        },
        long: {
            targetsWithPrior: 0,
            allModalityTargetsWithPrior: 0,
            priorComparisonsUsed: 0,
            observabilityViolationsInComputedHistory: 0,
            unobservablePublishedPriorsExcluded: 0,
        },
    };
    for (const sourceRows of byFormatAndSource.values()) {
        sourceRows.sort((left, right) => (
            left.publishedSeconds - right.publishedSeconds
            || left.videoId.localeCompare(right.videoId)
        ));
        const history = [];
        for (const row of sourceRows) {
            const validHistory = history.filter(previous => (
                previous.publishedSeconds < row.publishedSeconds
                && previous.observationSeconds <= row.publishedSeconds
                && previous.contentFamilyId !== row.contentFamilyId
            ));
            if (validHistory.length) {
                output[row.format].targetsWithPrior += 1;
                output[row.format].priorComparisonsUsed += validHistory.length;
                if (hasAllModalities(row)) {
                    output[row.format].allModalityTargetsWithPrior += 1;
                }
            }
            output[row.format].unobservablePublishedPriorsExcluded += history.filter(previous => (
                previous.publishedSeconds < row.publishedSeconds
                && previous.observationSeconds > row.publishedSeconds
            )).length;
            history.push(row);
        }
    }
    return output;
}

async function auditUnifiedPanelIntegrity() {
    if (!fs.existsSync(FILES.unifiedPanel)) {
        throw new Error(`Required artifact is missing: ${FILES.unifiedPanel}`);
    }
    const strictContract = parseStrictSupportContract();
    const frozenSnapshot = await auditFrozenSnapshotManifest();
    const reconstructed = fs.existsSync(FILES.reconstructedGeometry)
        ? requiredJson(FILES.reconstructedGeometry)
        : null;
    const reconstructedFailures = [];
    const expectedReconstructedChannels = REQUIRED_SNAPSHOT_ROLES
        .filter(role => role.endsWith(':vectors'))
        .map(role => role.replace(/:vectors$/, ''));
    const reconstructedById = new Map(
        (reconstructed?.channels || []).map(channel => [channel.id, channel])
    );
    if (!reconstructed) {
        reconstructedFailures.push('reconstructed-geometry-summary.json is missing');
    } else {
        if (reconstructed.schema !== 'outcome-blind-reconstructed-geometry-summary-v1') {
            reconstructedFailures.push(`unexpected reconstructed geometry schema ${
                reconstructed.schema || 'missing'
            }`);
        }
        if (reconstructed.snapshotRunId !== frozenSnapshot.report.runId) {
            reconstructedFailures.push('reconstructed geometry snapshot runId mismatch');
        }
        if (reconstructed.snapshotIdentityHash !== frozenSnapshot.report.identityHash) {
            reconstructedFailures.push('reconstructed geometry snapshot identity mismatch');
        }
        if (reconstructed.method?.outcomesUsed !== false) {
            reconstructedFailures.push('reconstructed geometry is not certified outcome-blind');
        }
        for (const id of expectedReconstructedChannels) {
            const channel = reconstructedById.get(id);
            const vector = frozenSnapshot.objectRecords.get(`${id}:vectors`);
            if (!channel) {
                reconstructedFailures.push(`missing reconstructed channel ${id}`);
                continue;
            }
            if (!vector || channel.vectorSha256 !== vector.sha256) {
                reconstructedFailures.push(`${id} vector hash does not match the frozen manifest`);
            }
            const geometryPath = path.resolve(__dirname, channel.geometryPath || '');
            if (!fs.existsSync(geometryPath)) {
                reconstructedFailures.push(`${id} reconstructed geometry file is missing`);
                continue;
            }
            const geometryHash = await sha256File(geometryPath);
            if (geometryHash !== channel.geometrySha256) {
                reconstructedFailures.push(`${id} reconstructed geometry hash mismatch`);
            }
        }
    }
    const reconstructedGeometryAudit = {
        pass: reconstructedFailures.length === 0,
        schema: reconstructed?.schema || null,
        snapshotRunId: reconstructed?.snapshotRunId || null,
        outcomesUsed: reconstructed?.method?.outcomesUsed,
        expectedChannels: expectedReconstructedChannels.length,
        verifiedChannels: expectedReconstructedChannels.filter(
            id => reconstructedById.has(id)
        ).length,
        nativeRejectedChannels:
            frozenSnapshot.report.representationIntegrity?.rejectedChannels || [],
        remediation:
            'All analysis geometry is rebuilt from frozen raw vectors. Native maps remain rejected '
            + 'where their ID order does not match, and are not used as analytic coordinates.',
        failures: reconstructedFailures,
    };
    const compressed = fs.readFileSync(FILES.unifiedPanel);
    const panel = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    const summary = requiredJson(FILES.panelSummary);
    const rows = Array.isArray(panel.rows) ? panel.rows : [];
    const formats = {
        shorts: makePanelFormatAudit(),
        long: makePanelFormatAudit(),
    };
    const observationIds = {
        shorts: new Set(),
        long: new Set(),
    };
    const snapshotSeconds = {
        shorts: new Set(),
        long: new Set(),
    };

    for (const row of rows) {
        if (!formats[row.format]) continue;
        const report = formats[row.format];
        report.rows += 1;
        if (observationIds[row.format].has(row.observationId)) {
            report.duplicateObservationIds += 1;
        }
        observationIds[row.format].add(row.observationId);
        if (hasAllModalities(row)) report.currentAllModalityRows += 1;
        if (hasOwn(row, 'stored')) report.storedFieldPresent += 1;
        if (hasOwn(row, 'rechecked')) report.recheckedFieldPresent += 1;
        if (hasOwn(row, 'storedAt')) report.storedAtFieldPresent += 1;
        if (finite(row.observationSeconds) !== null) report.observationSecondsPresent += 1;
        if (row.observationTimeSource === 'storedAt') {
            report.observationTimeSourceStoredAt += 1;
        }
        if (finite(row.snapshotSeconds) !== null) {
            report.snapshotSecondsPresent += 1;
            snapshotSeconds[row.format].add(Number(row.snapshotSeconds));
        }
    }
    for (const format of ['shorts', 'long']) {
        formats[format].uniqueObservationIds = observationIds[format].size;
        formats[format].uniqueSnapshotSeconds = snapshotSeconds[format].size;
    }

    const provenanceRows = Array.isArray(panel.provenance) ? panel.provenance : [];
    const provenanceByKey = tally(provenanceRows, row => row.key);
    const panelSourceByKey = new Map(provenanceRows.map(row => [row.key, row]));
    const panelGenerationComparisons = REQUIRED_SNAPSHOT_ROLES
        .filter(role => !role.endsWith(':vectors'))
        .map(role => {
            const frozen = frozenSnapshot.objectRecords.get(role);
            const current = frozen ? panelSourceByKey.get(frozen.key) : null;
            return {
                role,
                key: frozen?.key || null,
                panelSha256: current?.sha256 || null,
                frozenSha256: frozen?.sha256 || null,
                matches: Boolean(
                    current?.sha256
                    && frozen?.sha256
                    && current.sha256 === frozen.sha256
                ),
            };
        });
    const panelGenerationBinding = {
        panelSnapshotRunId: panel.snapshotRunId || null,
        frozenSnapshotRunId: frozenSnapshot.report.runId || null,
        runIdMatches: Boolean(
            panel.snapshotRunId
            && frozenSnapshot.report.runId
            && panel.snapshotRunId === frozenSnapshot.report.runId
        ),
        panelSnapshotIdentityHash: panel.snapshotIdentityHash || null,
        frozenSnapshotIdentityHash: frozenSnapshot.report.identityHash || null,
        identityHashMatches: Boolean(
            panel.snapshotIdentityHash
            && frozenSnapshot.report.identityHash
            && panel.snapshotIdentityHash === frozenSnapshot.report.identityHash
        ),
        directSourceComparisons: panelGenerationComparisons,
        matchingDirectSources:
            panelGenerationComparisons.filter(row => row.matches).length,
        requiredDirectSources: panelGenerationComparisons.length,
    };
    panelGenerationBinding.pass = (
        frozenSnapshot.report.freezePass
        && panelGenerationBinding.runIdMatches
        && panelGenerationBinding.identityHashMatches
        && panelGenerationBinding.matchingDirectSources
            === panelGenerationBinding.requiredDirectSources
    );

    let rowSourceAuditAvailable = false;
    let everyPanelRowStrict = false;
    let everyObservationTimeMatchesStoredAt = false;
    let everyPanelRowStored = false;
    let everyPanelRowUnrechecked = false;
    let history = null;
    if (frozenSnapshot.report.freezePass) {
        const databases = {};
        for (const format of ['shorts', 'long']) {
            const databasePath = frozenSnapshot.objectPaths.get(`${format}:database`);
            databases[format] = databasePath
                ? JSON.parse(fs.readFileSync(databasePath, 'utf8'))
                : null;
        }
        rowSourceAuditAvailable = Boolean(databases.shorts && databases.long);
        const eligibleRows = [];
        for (const format of ['shorts', 'long']) {
            const crosscheck = {
                sameGenerationAsPanel: panelGenerationBinding.pass,
                sourceRowsFound: 0,
                storedTrue: 0,
                storedFalse: 0,
                removedFalse: 0,
                removedTrue: 0,
                recheckedFalse: 0,
                recheckedTrue: 0,
                finiteStoredAt: 0,
                observationTimeMatchesStoredAt: 0,
                strictRows: 0,
            };
            for (const row of rows.filter(value => value.format === format)) {
                const source = databases[format]?.videos?.[row.videoId];
                if (!source) continue;
                crosscheck.sourceRowsFound += 1;
                if (source.stored === true) crosscheck.storedTrue += 1;
                else crosscheck.storedFalse += 1;
                if (source.removed !== true) crosscheck.removedFalse += 1;
                else crosscheck.removedTrue += 1;
                if (source.rechecked !== true) crosscheck.recheckedFalse += 1;
                else crosscheck.recheckedTrue += 1;
                const storedAt = finite(source.storedAt);
                if (storedAt !== null) crosscheck.finiteStoredAt += 1;
                const expectedObservationSeconds = storedAt === null
                    ? null
                    : Math.floor(storedAt / 1000);
                if (
                    expectedObservationSeconds !== null
                    && finite(row.observationSeconds) === expectedObservationSeconds
                    && row.observationTimeSource === 'storedAt'
                ) crosscheck.observationTimeMatchesStoredAt += 1;
                const publishedSeconds = finite(row.publishedSeconds);
                const strict = (
                    source.stored === true
                    && source.removed !== true
                    && source.rechecked !== true
                    && storedAt !== null
                    && expectedObservationSeconds !== null
                    && finite(row.observationSeconds) === expectedObservationSeconds
                    && row.observationTimeSource === 'storedAt'
                    && publishedSeconds !== null
                    && expectedObservationSeconds > publishedSeconds
                    && expectedObservationSeconds - publishedSeconds <= 366 * 86_400
                );
                if (strict) {
                    crosscheck.strictRows += 1;
                    eligibleRows.push({
                        ...row,
                        observationSeconds: expectedObservationSeconds,
                    });
                }
            }
            formats[format].sourceCrosscheck = crosscheck;
        }
        everyPanelRowStored = ['shorts', 'long'].every(
            format => formats[format].sourceCrosscheck.storedTrue === formats[format].rows
        );
        everyPanelRowUnrechecked = ['shorts', 'long'].every(
            format => formats[format].sourceCrosscheck.recheckedFalse === formats[format].rows
        );
        everyObservationTimeMatchesStoredAt = ['shorts', 'long'].every(
            format => (
                formats[format].sourceCrosscheck.observationTimeMatchesStoredAt
                === formats[format].rows
            )
        );
        everyPanelRowStrict = eligibleRows.length === rows.length;
        if (panelGenerationBinding.pass && everyPanelRowStrict) {
            history = auditPanelHistory(eligibleRows);
            for (const format of ['shorts', 'long']) {
                formats[format].historicallyObservableSupport = history[format];
            }
        }
    }

    const currentPanelHash = {
        compressedBytesSha256: sha256(compressed),
        builderCompatibilityStringHash: sha256(String(compressed)),
    };
    const strictLongSupport =
        strictContract.exactStrictHistoricalAllModalitySupport.long?.allThree ?? null;
    const minimumPoweredRows = strictContract.minimumIndependentRowsBeforeDesignEffect;
    const auditedLongSupport = history?.long?.allModalityTargetsWithPrior ?? null;
    const conservativeLongSupport = auditedLongSupport ?? strictLongSupport;
    const supportDeficit = (
        conservativeLongSupport !== null
        && minimumPoweredRows !== null
    ) ? Math.max(0, minimumPoweredRows - conservativeLongSupport) : null;

    const gates = {
        twoReadImmutableSourceSnapshot: {
            pass: frozenSnapshot.report.freezePass && panelGenerationBinding.pass,
            required:
                'Two complete byte reads per DB, map, and vector object; stable metadata across '
                + 'the collection; content-addressed local copies; one snapshot identity; the '
                + 'panel must bind to that exact run and every direct source hash.',
            evidence: {
                frozenSnapshot: frozenSnapshot.report,
                panelGenerationBinding,
            },
        },
        mapVectorGenerationCoherence: {
            pass: reconstructedGeometryAudit.pass,
            required:
                'Every analysis channel must be rebuilt outcome-blind from the exact frozen raw '
                + 'vector archive. Native maps with mismatched row order must remain rejected.',
            evidence: {
                nativeMapVectorIntegrity:
                    frozenSnapshot.report.representationIntegrity,
                reconstructedOutcomeBlindGeometry: reconstructedGeometryAudit,
            },
        },
        storedRowsOnly: {
            pass: panelGenerationBinding.pass && rowSourceAuditAvailable && everyPanelRowStored,
            required: 'Every panel row must resolve to stored === true in the frozen source DB.',
            evidence: rowSourceAuditAvailable
                ? Object.fromEntries(['shorts', 'long'].map(format => [
                    format,
                    formats[format].sourceCrosscheck,
                ]))
                : 'No frozen source DB is available for row-level verification.',
        },
        storedAtObservationTime: {
            pass:
                panelGenerationBinding.pass
                && everyPanelRowStrict
                && everyObservationTimeMatchesStoredAt,
            required:
                'observationSeconds must equal floor(source.storedAt / 1000); db.updated and '
                + 'one format-wide snapshot timestamp are forbidden.',
            evidence: Object.fromEntries(['shorts', 'long'].map(format => [
                format,
                {
                    rows: formats[format].rows,
                    observationSecondsPresent: formats[format].observationSecondsPresent,
                    observationTimeSourceStoredAt:
                        formats[format].observationTimeSourceStoredAt,
                    snapshotSecondsPresent: formats[format].snapshotSecondsPresent,
                    uniqueSnapshotSeconds: formats[format].uniqueSnapshotSeconds,
                },
            ])),
        },
        recheckedExcluded: {
            pass:
                panelGenerationBinding.pass
                && rowSourceAuditAvailable
                && everyPanelRowUnrechecked,
            required:
                'Every panel row must resolve to rechecked !== true in the same frozen source DB.',
            evidence: rowSourceAuditAvailable
                ? Object.fromEntries(['shorts', 'long'].map(format => [
                    format,
                    formats[format].sourceCrosscheck.recheckedFalse,
                ]))
                : 'The current panel omits rechecked and has no frozen DB crosscheck.',
        },
        historicalObservability: {
            pass:
                panelGenerationBinding.pass
                && everyPanelRowStrict
                && history !== null
                && history.shorts.observabilityViolationsInComputedHistory === 0
                && history.long.observabilityViolationsInComputedHistory === 0,
            required:
                'Each prior outcome j used for target i must have S_j = storedAt_j / 1000 <= T_i.',
            evidence: history || {
                auditable: false,
                reason:
                    'Per-row storedAt observation times cannot be established from the current panel.',
            },
        },
        longStrictAllModalitySupport: {
            pass:
                panelGenerationBinding.pass
                && everyPanelRowStrict
                && history !== null
                && conservativeLongSupport >= minimumPoweredRows,
            required:
                'Long promotion requires strict historical support in visual, text, and together '
                + 'modalities and must meet the uninflated power floor before creator design effects.',
            evidence: {
                exactCurrentStrictCountFromEstimandSpec: strictLongSupport,
                auditableCountFromCurrentPanel: auditedLongSupport,
                currentFrozenPanelCountUsedForPromotion: conservativeLongSupport,
                countDifference:
                    auditedLongSupport === null || strictLongSupport === null
                        ? null
                        : auditedLongSupport - strictLongSupport,
                minimumIndependentRowsBeforeDesignEffect: minimumPoweredRows,
                deficitBeforeDesignEffect: supportDeficit,
                supportFractionOfUninflatedMinimum: (
                    conservativeLongSupport !== null
                    && minimumPoweredRows
                ) ? round(conservativeLongSupport / minimumPoweredRows, 6) : null,
            },
        },
    };
    const baseIntegrityGateNames = [
        'twoReadImmutableSourceSnapshot',
        'mapVectorGenerationCoherence',
        'storedRowsOnly',
        'storedAtObservationTime',
        'recheckedExcluded',
        'historicalObservability',
    ];
    const baseIntegrityGatesPass = baseIntegrityGateNames.every(name => gates[name].pass);
    const allHardGatesPass = Object.values(gates).every(gate => gate.pass);
    const promotionEligibleRowsByFormat = {
        shorts: baseIntegrityGatesPass ? formats.shorts.rows : 0,
        long: allHardGatesPass ? formats.long.rows : 0,
    };
    const failedHardGates = Object.entries(gates)
        .filter(([, gate]) => !gate.pass)
        .map(([name]) => name);

    const directArtifacts = [
        {
            id: 'opportunity-targets',
            file: FILES.opportunityTargets,
            dependency: 'direct outcome transform from the governed panel',
            declaredPanelHash:
                fs.existsSync(FILES.opportunityAdjustment)
                    ? requiredJson(FILES.opportunityAdjustment).sourcePanelHash
                    : null,
        },
        {
            id: 'opportunity-adjustment',
            file: FILES.opportunityAdjustment,
            dependency: 'direct outcome transform from the governed panel',
            declaredPanelHash:
                fs.existsSync(FILES.opportunityAdjustment)
                    ? requiredJson(FILES.opportunityAdjustment).sourcePanelHash
                    : null,
        },
        {
            id: 'cluster-outcomes-adjusted',
            file: FILES.clusterOutcomesAdjusted,
            dependency: 'direct panel and opportunity-target analysis',
            declaredPanelHash:
                fs.existsSync(FILES.clusterOutcomesAdjusted)
                    ? requiredJson(FILES.clusterOutcomesAdjusted).sourcePanelHash
                    : null,
        },
        {
            id: 'nested-outcome-validation',
            file: FILES.nestedOutcomeValidation,
            dependency: 'loads unified-panel.json.gz directly with immutable panel lineage',
            declaredPanelHash:
                fs.existsSync(FILES.nestedOutcomeValidation)
                    ? requiredJson(FILES.nestedOutcomeValidation)
                        .sourceLineage?.panelArtifactSha256 || null
                    : null,
        },
        {
            id: 'raw-embedding-validation',
            file: FILES.rawEmbeddingValidation,
            dependency:
                'loads opportunity-targets.json.gz with immutable panel and target lineage',
            declaredPanelHash:
                fs.existsSync(FILES.rawEmbeddingValidation)
                    ? requiredJson(FILES.rawEmbeddingValidation)
                        .sourceLineage?.panelArtifactSha256 || null
                    : null,
        },
        {
            id: 'within-creator-delta-validation',
            file: FILES.withinCreatorDeltaValidation,
            dependency:
                'loads unified-panel.json.gz and frozen vectors with immutable lineage',
            declaredPanelHash:
                fs.existsSync(FILES.withinCreatorDeltaValidation)
                    ? requiredJson(FILES.withinCreatorDeltaValidation)
                        .sourceLineage?.panelArtifactSha256 || null
                    : null,
        },
        {
            id: 'baseline-sensitivity-validation',
            file: FILES.baselineSensitivityValidation,
            dependency:
                'rebuilds fold-local targets across the predeclared nuisance-baseline grid',
            declaredPanelHash:
                fs.existsSync(FILES.baselineSensitivityValidation)
                    ? requiredJson(FILES.baselineSensitivityValidation)
                        .sourceLineage?.panelArtifactSha256 || null
                    : null,
        },
    ];
    const invalidatedConfirmatoryArtifacts = directArtifacts
        .filter(artifact => fs.existsSync(artifact.file))
        .map(artifact => {
            const declaredHashMatchesCurrentPanel = artifact.declaredPanelHash === null
                ? null
                : [
                    currentPanelHash.compressedBytesSha256,
                    currentPanelHash.builderCompatibilityStringHash,
                ].includes(artifact.declaredPanelHash);
            let status;
            if (artifact.declaredPanelHash === null) {
                status = 'untraceable_panel_generation';
            } else if (!declaredHashMatchesCurrentPanel) {
                status = 'stale_panel_generation';
            } else if (!baseIntegrityGatesPass) {
                status = 'invalid_source_panel';
            } else if (!gates.longStrictAllModalitySupport.pass) {
                status = 'shorts_data_gate_pass_long_blocked';
            } else {
                status = 'data_integrity_gates_pass_pending_multiplicity';
            }
            return {
                id: artifact.id,
                path: path.relative(JARVIS_ROOT, artifact.file),
                dependency: artifact.dependency,
                declaredPanelHash: artifact.declaredPanelHash,
                declaredHashMatchesCurrentPanel,
                formatDataGate: {
                    shorts:
                        declaredHashMatchesCurrentPanel === true
                        && baseIntegrityGatesPass,
                    long:
                        declaredHashMatchesCurrentPanel === true
                        && allHardGatesPass,
                },
                confirmatoryUseValid: (
                    declaredHashMatchesCurrentPanel === true
                    && allHardGatesPass
                ),
                shortsConfirmatoryDataUseValid: (
                    declaredHashMatchesCurrentPanel === true
                    && baseIntegrityGatesPass
                ),
                longConfirmatoryDataUseValid: (
                    declaredHashMatchesCurrentPanel === true
                    && allHardGatesPass
                ),
                status,
            };
        });
    const clusterInvariance = fs.existsSync(FILES.clusterInvariance)
        ? requiredJson(FILES.clusterInvariance)
        : null;
    const clusterInvarianceAudit = clusterInvariance ? {
        schema: clusterInvariance.schema,
        generatedAt: clusterInvariance.generatedAt,
        snapshotRunId: clusterInvariance.inputSnapshot?.runId,
        atomicSnapshot: clusterInvariance.inputSnapshot?.atomic === true,
        representationIntegrityAccepted:
            clusterInvariance.inputSnapshot?.integrity?.globallyAccepted === true,
        acceptedRepresentationChannels:
            clusterInvariance.inputSnapshot?.integrity?.acceptedChannels,
        rejectedRepresentationChannels:
            clusterInvariance.inputSnapshot?.integrity?.rejectedChannels,
        outcomeAuditExecuted: clusterInvariance.outcomeAudit?.executed === true,
        outcomeAuditValidity: clusterInvariance.outcomeAudit?.validity,
        mechanismTests:
            clusterInvariance.conclusions?.mechanisms?.tests?.length || 0,
        validatedPairRelationships:
            clusterInvariance.conclusions?.mechanisms?.validatedPairRelationships || 0,
        claimStatus: tally(
            clusterInvariance.conclusions?.claims || [],
            row => row.status
        ),
        promotionCeiling: 'outcome_blind_geometry_only',
    } : null;

    return {
        report: {
            schema: panel.schema || null,
            summarySchema: summary.schema,
            rows: rows.length,
            formats,
            currentPanelHash,
            panelProvenance: {
                entries: provenanceRows.length,
                sourceKeys: Object.keys(provenanceByKey).length,
                readsPerMutableKey: provenanceByKey,
                entriesWithCompleteReadCount:
                    provenanceRows.filter(row => finite(row.completeReads) !== null).length,
                entriesWithEtag: provenanceRows.filter(row => Boolean(row.etag)).length,
                entriesWithLastModified:
                    provenanceRows.filter(row => Boolean(row.lastModified)).length,
                snapshotRunId: panel.snapshotRunId || null,
                snapshotIdentityHash: panel.snapshotIdentityHash || null,
            },
            panelGenerationBinding,
            strictContract,
            gates,
            baseIntegrityGatesPass,
            allHardGatesPass,
            failedHardGates,
            integrityEligibleRows: baseIntegrityGatesPass ? rows.length : 0,
            promotionEligibleRowsByFormat,
            promotionEligibleRows:
                promotionEligibleRowsByFormat.shorts + promotionEligibleRowsByFormat.long,
            confirmatoryVerdict:
                allHardGatesPass
                    ? 'The source-data gates pass. Statistical promotion still requires complete '
                        + 'family accounting, valid null replay, and independent validation.'
                    : baseIntegrityGatesPass
                        ? 'Shorts pass the frozen-source and representation-lineage gates. Long is '
                            + 'blocked by insufficient strict all-modality support. Statistical '
                            + 'promotion still requires complete family accounting, valid null '
                            + 'replay, and independent prospective validation.'
                        : `BLOCKED: no unified-panel claim can promote. Failed hard gates: ${
                            failedHardGates.join(', ')
                        }. Stale or untraceable descendants remain invalid.`,
            invalidatedConfirmatoryArtifacts,
            clusterInvariance: clusterInvarianceAudit,
            explicitlyNotInvalidatedByThisPanelGate: [
                'Operations projected-score analysis',
                'Promise owned-retention analysis',
                'Retention private analytics',
                'Tribe private analytics',
                'Market Hold external-transfer analysis',
                'legacy registry diagnostics',
                'factorized-validation branches that do not consume unified-panel or opportunity-targets',
            ],
        },
        artifactFiles: [
            FILES.unifiedPanel,
            FILES.opportunityTargets,
            FILES.panelSummary,
            FILES.snapshotManifest,
            FILES.snapshotIntegrity,
            FILES.reconstructedGeometry,
            FILES.semanticFamilies,
            FILES.clusterInvariance,
            FILES.estimandSpec,
            FILES.opportunityAdjustment,
            FILES.clusterOutcomesAdjusted,
            FILES.nestedOutcomeValidation,
            FILES.rawEmbeddingValidation,
            FILES.withinCreatorDeltaValidation,
            FILES.baselineSensitivityValidation,
        ].filter(file => fs.existsSync(file)),
    };
}

async function auditJsonLinesGzip(file) {
    let rows = 0;
    let parsedRows = 0;
    let outcomesUsedTrue = 0;
    let outcomesUsedFalse = 0;
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim()) continue;
        rows += 1;
        const value = JSON.parse(line);
        parsedRows += 1;
        if (value.outcomesUsed === true) outcomesUsedTrue += 1;
        if (value.outcomesUsed === false) outcomesUsedFalse += 1;
    }
    return { rows, parsedRows, outcomesUsedTrue, outcomesUsedFalse };
}

/*
 * Streams objects from the first JSON array in a file. This supports both a
 * root array and indicator-registry.json, whose first array is `entries`.
 */
async function streamFirstJsonArray(file, visitor) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        let targetArrayStarted = false;
        let targetArrayFinished = false;
        let arrayDepth = 0;
        let objectDepth = 0;
        let arrayBaseObjectDepth = null;
        let inString = false;
        let escaping = false;
        let capture = null;
        let count = 0;
        let failed = false;

        const fail = error => {
            if (failed) return;
            failed = true;
            stream.destroy();
            reject(error);
        };

        stream.on('data', chunk => {
            if (failed || targetArrayFinished) return;
            try {
                for (const character of chunk) {
                    if (capture !== null) capture += character;
                    if (inString) {
                        if (escaping) escaping = false;
                        else if (character === '\\') escaping = true;
                        else if (character === '"') inString = false;
                        continue;
                    }
                    if (character === '"') {
                        inString = true;
                        continue;
                    }
                    if (character === '[') {
                        if (!targetArrayStarted) {
                            targetArrayStarted = true;
                            arrayBaseObjectDepth = objectDepth;
                        }
                        if (targetArrayStarted) arrayDepth += 1;
                        continue;
                    }
                    if (character === ']') {
                        if (targetArrayStarted) {
                            arrayDepth -= 1;
                            if (arrayDepth === 0) targetArrayFinished = true;
                        }
                        continue;
                    }
                    if (character === '{') {
                        if (
                            targetArrayStarted
                            && arrayDepth === 1
                            && objectDepth === arrayBaseObjectDepth
                        ) {
                            capture = '{';
                        }
                        objectDepth += 1;
                        continue;
                    }
                    if (character === '}') {
                        objectDepth -= 1;
                        if (
                            capture !== null
                            && objectDepth === arrayBaseObjectDepth
                            && arrayDepth === 1
                        ) {
                            const value = JSON.parse(capture);
                            capture = null;
                            visitor(value, count);
                            count += 1;
                        }
                    }
                }
            } catch (error) {
                fail(error);
            }
        });
        stream.on('error', fail);
        stream.on('end', () => {
            if (failed) return;
            if (!targetArrayStarted || capture !== null || inString) {
                reject(new Error(`Incomplete JSON array while reading ${file}`));
                return;
            }
            resolve(count);
        });
    });
}

async function countNeedle(file, needle) {
    return new Promise((resolve, reject) => {
        let count = 0;
        let carry = '';
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        stream.on('data', chunk => {
            const text = carry + chunk;
            let offset = 0;
            while ((offset = text.indexOf(needle, offset)) !== -1) {
                count += 1;
                offset += needle.length;
            }
            carry = text.slice(Math.max(0, text.length - needle.length + 1));
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(count));
    });
}

function auditOperations(artifact, alpha) {
    const discovery = artifact.discovery;
    const inference = artifact.inference;
    const targetReports = {};
    const pValues = [];
    for (const [target, payload] of Object.entries(inference.targets || {})) {
        const components = payload.components || [];
        const continuous = components.filter(row => row.continuous);
        const threshold = components.filter(row => row.keepAtLeast85);
        pValues.push(...continuous.map(row => finite(row.continuous.p, 1)));
        pValues.push(...threshold.map(row => finite(row.keepAtLeast85.p, 1)));
        targetReports[target] = {
            testedComponents: components.length,
            continuousBySurvivors: continuous.filter(row => row.continuous.q <= alpha).length,
            thresholdBySurvivors: threshold.filter(row => row.keepAtLeast85.q <= alpha).length,
            withinFoldAuc: round(payload.conditionalModel?.withinFoldDiscrimination?.auc),
            outcomeClass: 'projected_target',
        };
    }
    const source = artifact.transport?.sourceSnapshot || {};
    return {
        report: {
            evidenceRows: discovery.n,
            semanticLineages: artifact.lineages?.groupCount,
            creatorGroupingAvailable: Boolean(artifact.lineages?.creatorGroupingAvailable),
            outcomeBlindResolutions: Object.keys(discovery.inputHashes || {}).length,
            partitionConfigurations: discovery.partitionLedger.length,
            partitionStatus: tally(discovery.partitionLedger, row => row.status),
            partitionAlgorithms: tally(discovery.partitionLedger, row => row.algorithm),
            rawCandidates: discovery.candidateLedger.length,
            candidateStatus: tally(discovery.candidateLedger, row => row.status),
            consensusComponents: discovery.dedupeLedger.length,
            acceptedComponents: discovery.components.length,
            outcomeHypotheses: inference.multipleTesting?.hypothesisCount,
            nativeCorrection: inference.multipleTesting?.method,
            targetReports,
            transport: {
                frozenPrinciples: Object.keys(artifact.transport?.principles || {}).length,
                savedProjectedRows: artifact.transport?.outcomeSources?.savedProjected?.rows,
                broadProjectedRows: source.broadRows,
                observedRows: source.observedRows,
                observedGroups: source.observedUniqueGroups,
                observedHitsAt85: source.observedTailHits85,
                savedObservedExactIdOverlap: source.savedObservedExactIdOverlap,
                projectedExactIdOverlap: source.projectedExactIdOverlap,
                recordLevelEmbeddingVersionPersisted:
                    source.embeddingContract?.recordLevelModelVersionPersisted,
            },
            correctionVerdict:
                'The 138-test BY correction is dependency-safe for the reported supplied-score effects. '
                + 'Every target is projected keep, so survivors measure agreement with another model, '
                + 'not observed audience keep.',
            promotionCeiling: 'surrogate_association',
        },
        pValues,
    };
}

function auditPromise({
    summary,
    clusterRows,
    boundaryRows,
    allSpanRows,
    outcomeRows,
    outcomes,
    forward,
    quality,
    market,
    alpha,
}) {
    const transferEntries = Object.entries(market.transferValidation || {});
    const transferP = transferEntries.map(([, value]) => finite(value.rankPermutationP, 1));
    const transferBy = adjustPValues(transferP, 'BY');
    const marketTests = transferEntries.map(([target, value], index) => ({
        target,
        n: value.rows,
        spearman: round(value.heldoutSpearman),
        parametricP: finite(value.heldoutSpearmanP),
        rankPermutationP: finite(value.rankPermutationP),
        recomputedDependencySafeQ: round(transferBy[index]),
        chronologicalPositiveBlockFraction: value.positiveBlockFraction,
        recentHalfSpearman: round(value.recentHalfSpearman),
        survivesNativeFourEndpointBy: transferBy[index] <= alpha,
    }));
    const nativeMarketSurvivors = marketTests.filter(row => row.survivesNativeFourEndpointBy);
    const hookQualityP = [
        finite(quality.model?.rankPermutationP, 1),
        finite(quality.model?.chronologicalRankPermutationP, 1),
    ];
    const outcomeSearchExecutions = outcomeRows.rows
        + (forward.deconfoundingAudit?.specificationRows?.length || 0)
        + (quality.latency?.rows?.length || 0)
        + transferEntries.length
        + (market.externalTraining?.selection?.length || 0)
        + hookQualityP.length;
    return {
        report: {
            hooks: summary.hooks || quality.model?.trainingHooks || market.audit?.ownedHooks,
            candidateSpanInstances:
                summary.candidateInstances
                || summary.spanInstances
                || summary.allContiguousSpans,
            geometry: {
                clusterRows: clusterRows.rows,
                boundaryRows: boundaryRows.rows,
                allSpanRows: allSpanRows.rows,
                totalOutcomeBlindRows: clusterRows.rows + boundaryRows.rows + allSpanRows.rows,
                allRowsDeclareOutcomeBlind:
                    clusterRows.outcomesUsedFalse === clusterRows.rows
                    && boundaryRows.outcomesUsedFalse === boundaryRows.rows
                    && allSpanRows.outcomesUsedFalse === allSpanRows.rows,
            },
            clusterOutcomeSearch: {
                rows: outcomeRows.rows,
                artifactExperimentCount: outcomes.experimentCount,
                selectedFamilies: outcomes.selectedFamilyCount,
                randomFoldSupportedFamilies: outcomes.randomFoldSupportedFamilyCount,
                chronologicallyValidatedFamilies: outcomes.validatedFamilyCount,
                withinFamilyCorrection:
                    outcomes.validation?.searchWideNull,
                acrossFamilyCorrection: outcomes.validation?.familyFdr,
                claimBoundary: outcomes.claimBoundary,
            },
            timingSearch: {
                specificationRows: forward.deconfoundingAudit?.specificationRows?.length,
                maxStatisticNullRepeats: forward.deconfoundingAudit?.familyInference?.repeats,
                primaryFamilyMaxP:
                    forward.deconfoundingAudit?.primarySpecification?.familyMaxNullP,
                exploratoryLagFamilyMaxP:
                    forward.deconfoundingAudit?.exploratoryLagGate?.familyMaxNullP,
                processingLagSupported: forward.deconfoundingAudit?.processingLagSupported,
                fixedMetricP: forward.componentModel?.sourceInference?.p,
                chronologicalP:
                    forward.componentModel?.chronologicalValidation?.sourceInference?.p,
                wholeHookP: forward.wholeHookModel?.sourceInference?.p,
            },
            hookQuality: {
                randomFoldSpearman: round(quality.model?.heldoutSpearman),
                randomFoldPermutationP: quality.model?.rankPermutationP,
                chronologicalSpearman: round(quality.model?.chronologicalHeldoutSpearman),
                chronologicalPermutationP: quality.model?.chronologicalRankPermutationP,
                temporalRobust: Boolean(quality.model?.temporalRobustAcrossBlockCounts),
                latencyRows: quality.latency?.rows?.length,
                latencySupported: Boolean(quality.latency?.latencySupported),
            },
            marketHold: {
                externalRows: market.externalTraining?.nonOwnedTrainingRows,
                externalGroups: market.externalTraining?.sourceGroups,
                alphaCandidates: market.externalTraining?.selection?.length,
                ownedRowsUsedToFitAxis:
                    Boolean(market.externalTraining?.ownedOutcomeLabelsUsedToFitOrSelectAxis),
                ownedTransferRows: market.audit?.ownedHooks,
                tests: marketTests,
                nativeBySurvivorCount: nativeMarketSurvivors.length,
            },
            outcomeSearchExecutionsVisible: outcomeSearchExecutions,
            correctionVerdict:
                'Cluster and lag searches have internal max-stat controls, but the four-category map '
                + 'was selected post hoc and no cluster-outcome family validated chronologically. '
                + 'Market Hold is the one frozen external direction with an outcome-independent owned transfer.',
            promotionCeiling: 'regional_retrospective_candidate',
        },
        marketTests,
        pValues: [
            ...outcomes.topIndicators.map(row => finite(row.searchWideP, 1)),
            ...hookQualityP,
            ...marketTests.map(row => finite(row.parametricP, 1)),
            finite(forward.deconfoundingAudit?.primarySpecification?.familyMaxNullP, 1),
            finite(forward.deconfoundingAudit?.exploratoryLagGate?.familyMaxNullP, 1),
        ],
        outcomeSearchExecutions,
    };
}

function retentionGreedyEvaluationCount(poolSize, acceptedCount, maxAccepted = 7) {
    const scans = Math.min(
        poolSize,
        acceptedCount + (acceptedCount < Math.min(poolSize, maxAccepted) ? 1 : 0)
    );
    let evaluations = 0;
    for (let scan = 0; scan < scans; scan += 1) evaluations += poolSize - scan;
    return evaluations;
}

function auditRetention(artifact) {
    const usablePool = artifact.corr_matrix?.keys?.length || 0;
    const fullAccepted = artifact.selection?.full?.path?.length || 0;
    const interpretableAccepted = artifact.selection?.interp?.path?.length || 0;
    // analyze.py marks five covered fields as slider-eligible in this artifact:
    // keep, retention, duration, hook, and tail.
    const interpretablePool = 5;
    const fullGreedyEvaluations = retentionGreedyEvaluationCount(usablePool, fullAccepted);
    const interpretableGreedyEvaluations = retentionGreedyEvaluationCount(
        interpretablePool,
        interpretableAccepted
    );
    const subsetEvaluations = Object.keys(artifact.predictor?.subsets || {}).length;
    const visibleSelectionEvaluations =
        fullGreedyEvaluations + interpretableGreedyEvaluations + subsetEvaluations;
    return {
        report: {
            evidenceRows: artifact.meta?.n,
            cohortCaveat: artifact.meta?.caveat,
            target: artifact.meta?.target,
            reportedIndicators: artifact.indicators?.length,
            usableCandidatePool: usablePool,
            outcomeSideIndicators:
                (artifact.indicators || []).filter(row => row.usable === false).length,
            adaptiveSelection: {
                fullGreedyEvaluations,
                interpretableGreedyEvaluations,
                subsetEvaluations,
                visibleSelectionEvaluations,
                lowerBoundOnly: true,
                reason:
                    'Q1-Q4, PCA construction, interaction design, and prior iterations are not '
                    + 'represented as a complete candidate-execution ledger.',
            },
            selectedResults: {
                baselineKeepRetentionCvR2: artifact.selection?.baseline_cv_r2,
                adaptivelySelectedFullCvR2: artifact.selection?.full?.cv_r2,
                interpretableCvR2: artifact.selection?.interp?.cv_r2,
                keepFromRetentionCvR2: artifact.Q3?.keep_from_retention_cv_r2,
            },
            correctionVerdict:
                'The same cross-validation scores chose and described the feature path. There is no '
                + 'nested outer test, source holdout, chronological lockbox, or family p-value.',
            promotionCeiling: 'retrospective_mechanism',
        },
        outcomeSearchExecutions: visibleSelectionEvaluations,
    };
}

function buildTribeTests(artifact) {
    const tests = [];
    for (const indicator of artifact.indicatorIds || []) {
        for (const feature of TRIBE_FEATURES) {
            for (const target of TRIBE_TARGETS) {
                const input = [];
                const output = [];
                const logDuration = [];
                for (const row of artifact.rows || []) {
                    const x = finite(row.tribe?.[indicator]?.[feature]);
                    const y = finite(row.metrics?.[target]);
                    const duration = finite(row.metrics?.duration);
                    if (x === null || y === null || !(duration > 0)) continue;
                    input.push(x);
                    output.push(y);
                    logDuration.push(Math.log(duration));
                }
                if (input.length < 8) continue;
                const raw = correlation(input, output);
                const deconfounded = correlation(
                    rank(residualizeLinear(input, logDuration)),
                    rank(residualizeLinear(output, logDuration))
                );
                tests.push({
                    indicator,
                    feature,
                    target,
                    mode: 'raw',
                    n: input.length,
                    r: raw,
                    p: correlationPValue(raw, input.length, 0),
                    family: `${target}|${feature}|raw`,
                });
                tests.push({
                    indicator,
                    feature,
                    target,
                    mode: 'duration_partial_spearman',
                    n: input.length,
                    r: deconfounded,
                    p: correlationPValue(deconfounded, input.length, 1),
                    family: `${target}|${feature}|duration_partial_spearman`,
                });
            }
        }
    }
    return tests;
}

function auditTribe(artifact, alpha) {
    const tests = buildTribeTests(artifact);
    const globalBh = adjustPValues(tests.map(row => row.p), 'BH');
    const globalBy = adjustPValues(tests.map(row => row.p), 'BY');
    tests.forEach((row, index) => {
        row.globalBh = globalBh[index];
        row.globalBy = globalBy[index];
    });

    const families = new Map();
    for (const row of tests) {
        if (!families.has(row.family)) families.set(row.family, []);
        families.get(row.family).push(row);
    }
    const familyRows = [...families.entries()].map(([family, rows]) => ({
        family,
        rows,
        gateP: familyGateP(rows.map(row => row.p)),
    }));
    const familyGateBy = adjustPValues(familyRows.map(row => row.gateP), 'BY');
    familyRows.forEach((family, familyIndex) => {
        family.gateQ = familyGateBy[familyIndex];
        const withinBh = adjustPValues(family.rows.map(row => row.p), 'BH');
        const withinBy = adjustPValues(family.rows.map(row => row.p), 'BY');
        family.rows.forEach((row, rowIndex) => {
            row.withinFamilyBh = withinBh[rowIndex];
            row.withinFamilyBy = withinBy[rowIndex];
            row.hierarchicalPass =
                family.gateQ <= alpha
                && row.withinFamilyBy <= alpha;
        });
    });

    const globalBySurvivors = tests.filter(row => row.globalBy <= alpha);
    const hierarchicalSurvivors = tests.filter(row => row.hierarchicalPass);
    const coreDeconfounded = globalBySurvivors.filter(row => (
        row.mode === 'duration_partial_spearman'
        && TRIBE_CORE_TARGETS.has(row.target)
    ));
    const topCore = coreDeconfounded
        .slice()
        .sort((left, right) => left.globalBy - right.globalBy || left.p - right.p)
        .slice(0, 20)
        .map(row => ({
            indicator: row.indicator,
            feature: row.feature,
            target: row.target,
            n: row.n,
            partialSpearman: round(row.r),
            p: row.p,
            globalBy: row.globalBy,
            hierarchicalPass: row.hierarchicalPass,
        }));
    return {
        report: {
            evidenceRows: artifact.rows?.length,
            account: artifact.account,
            indicatorCount: artifact.indicatorIds?.length,
            indicatorFamilies: artifact.families,
            features: TRIBE_FEATURES.length,
            targets: TRIBE_TARGETS.length,
            modes: 2,
            exactBrowsableTests: tests.length,
            currentUiFamilyCount: familyRows.length,
            currentUiCorrection:
                'BH separately inside each target x feature x mode family of 282 indicators',
            exactStudentTReanalysis: {
                rawPAt05: tests.filter(row => row.p <= alpha).length,
                globalBhSurvivors: tests.filter(row => row.globalBh <= alpha).length,
                globalBySurvivors: globalBySurvivors.length,
                globalByByMode: tally(globalBySurvivors, row => row.mode),
                globalByByTarget: tally(globalBySurvivors, row => row.target),
                dependencySafeHierarchicalSurvivors: hierarchicalSurvivors.length,
                coreDeconfoundedGlobalBySurvivors: coreDeconfounded.length,
                topCore,
            },
            invalidReplicationSignals: {
                foldStability:
                    'The UI uses five overlapping 80% hold-ins; these are sensitivity checks, not replications.',
                targetDuplicates: [
                    'swiped is the deterministic inverse of keep',
                    'views and logviews are monotone views transforms',
                    'realviews is derived from keep and ret5',
                ],
                postOutcomeTargets: ['likes', 'comments', 'shares'],
                loopInflatedTarget: 'ret5',
            },
            maxStatisticRequirement:
                'For promotion, permute outcomes in synchronized account x time blocks and rerun '
                + 'all 31,020 indicator/feature/target/mode choices, retaining the maximum absolute '
                + 'statistic per permutation. This artifact has one account and no sealed time blocks, '
                + 'so exchangeable maxT promotion is unavailable.',
            correctionVerdict:
                'Some associations remain numerically small after global BY, but all 130 rows are one '
                + 'Tyler cohort and no source/time lockbox exists. They remain same-account diagnostics.',
            promotionCeiling: 'local_diagnostic',
        },
        tests,
        outcomeSearchExecutions: tests.length,
    };
}

async function auditLegacy(alpha) {
    const registryCounts = {
        entries: 0,
        uniqueKeys: 0,
        kind: {},
        layer: {},
        target: {},
    };
    const registryKeys = new Set();
    registryCounts.entries = await streamFirstJsonArray(FILES.legacyRegistry, row => {
        registryKeys.add(row.key);
        const kind = String(row.kind ?? 'missing');
        const layer = String(row.layer ?? 'missing');
        const target = String(row.target ?? 'missing');
        registryCounts.kind[kind] = (registryCounts.kind[kind] || 0) + 1;
        registryCounts.layer[layer] = (registryCounts.layer[layer] || 0) + 1;
        registryCounts.target[target] = (registryCounts.target[target] || 0) + 1;
    });
    registryCounts.uniqueKeys = registryKeys.size;
    registryKeys.clear();

    const compact = requiredJson(FILES.legacyIndicators);
    const compactTests = [];
    for (const row of compact) {
        const outputs = row.experiment?.outputs || {};
        if (Number.isFinite(outputs.p_value)) {
            compactTests.push({
                key: row.key,
                layer: row.layer,
                method: 'pearson',
                r: finite(outputs.r),
                n: finite(outputs.n),
                p: outputs.p_value,
            });
        }
        if (Number.isFinite(outputs.p_rho)) {
            compactTests.push({
                key: row.key,
                layer: row.layer,
                method: 'spearman',
                r: finite(outputs.rho),
                n: finite(outputs.n),
                p: outputs.p_rho,
            });
        }
    }
    const compactBh = adjustPValues(compactTests.map(row => row.p), 'BH');
    const compactBy = adjustPValues(compactTests.map(row => row.p), 'BY');
    compactTests.forEach((row, index) => {
        row.bh = compactBh[index];
        row.by = compactBy[index];
    });

    let experimentRows = 0;
    let experimentIdSet = new Set();
    const nByKey = new Map();
    const experimentKinds = {};
    const experimentStatus = {};
    let experimentNMin = Infinity;
    let experimentNMax = -Infinity;
    experimentRows = await streamFirstJsonArray(FILES.legacyExperiments, row => {
        experimentIdSet.add(row.id);
        const kind = String(row.kind ?? 'missing');
        const status = String(row.status ?? 'missing');
        experimentKinds[kind] = (experimentKinds[kind] || 0) + 1;
        experimentStatus[status] = (experimentStatus[status] || 0) + 1;
        const n = finite(row.n_videos);
        if (n !== null) {
            experimentNMin = Math.min(experimentNMin, n);
            experimentNMax = Math.max(experimentNMax, n);
            const current = nByKey.get(row.indicator_key);
            if (current === undefined || n > current) nByKey.set(row.indicator_key, n);
        }
    });
    const uniqueExperimentIds = experimentIdSet.size;
    const uniqueExperimentKeys = nByKey.size;
    experimentIdSet = null;

    const derivedTests = [];
    const derivedKeys = new Set();
    const derivedCounts = {
        rows: 0,
        layer: {},
        status: {},
        kind: {},
        target: {},
        matchedSampleSize: 0,
    };
    derivedCounts.rows = await streamFirstJsonArray(FILES.legacyDerived, row => {
        derivedKeys.add(row.key);
        for (const [name, value] of [
            ['layer', row.layer],
            ['status', row.status],
            ['kind', row.kind],
            ['target', row.target],
        ]) {
            const key = String(value ?? 'missing');
            derivedCounts[name][key] = (derivedCounts[name][key] || 0) + 1;
        }
        const n = nByKey.get(row.key);
        const r = finite(row.r);
        if (Number.isFinite(n) && Number.isFinite(r) && n >= 4 && Math.abs(r) <= 1) {
            derivedCounts.matchedSampleSize += 1;
            derivedTests.push({
                key: row.key,
                layer: row.layer ?? 'missing',
                kind: row.kind ?? 'missing',
                r,
                n,
                p: correlationPValue(r, n),
            });
        }
    });
    derivedCounts.uniqueKeys = derivedKeys.size;
    derivedCounts.duplicateRows = derivedCounts.rows - derivedCounts.uniqueKeys;
    derivedKeys.clear();
    nByKey.clear();

    const derivedBy = adjustPValues(derivedTests.map(row => row.p), 'BY');
    derivedTests.forEach((row, index) => {
        row.by = derivedBy[index];
    });
    const derivedBySurvivors = derivedTests.filter(row => row.by <= alpha);

    const graph = requiredJson(FILES.legacyGraph);
    const archivedSnapshots = await countNeedle(FILES.legacyQuestions, '"legacy":');
    const compactBySurvivors = compactTests.filter(row => row.by <= alpha);
    return {
        report: {
            registry: registryCounts,
            compactIndicators: {
                rows: compact.length,
                kind: tally(compact, row => row.kind || 'atomic'),
                layer: tally(compact, row => row.layer),
                pValueTests: compactTests.length,
                rawPAt05: compactTests.filter(row => row.p <= alpha).length,
                bhSurvivors: compactTests.filter(row => row.bh <= alpha).length,
                bySurvivors: compactBySurvivors.length,
                byPreUploadSurvivors:
                    compactBySurvivors.filter(row => row.layer === 'pre').length,
                byPostOutcomeSurvivors:
                    compactBySurvivors.filter(row => row.layer === 'post').length,
            },
            experimentLog: {
                rows: experimentRows,
                uniqueExperimentIds,
                uniqueIndicatorKeys: uniqueExperimentKeys,
                status: experimentStatus,
                kind: experimentKinds,
                sampleSizeMin: experimentNMin,
                sampleSizeMax: experimentNMax,
            },
            derivedCompact: {
                ...derivedCounts,
                reconstructedParametricTests: derivedTests.length,
                reconstructedBySurvivors: derivedBySurvivors.length,
                reconstructedByPreUploadSurvivors:
                    derivedBySurvivors.filter(row => row.layer === 'pre').length,
                reconstructedByPostOutcomeSurvivors:
                    derivedBySurvivors.filter(row => row.layer === 'post').length,
                topReconstructed: derivedTests
                    .slice()
                    .sort((left, right) => left.p - right.p)
                    .slice(0, 12)
                    .map(row => ({
                        key: row.key,
                        layer: row.layer,
                        kind: row.kind,
                        n: row.n,
                        r: round(row.r),
                        p: row.p,
                        by: row.by,
                    })),
            },
            graph: {
                nodes: graph.nodes?.length,
                baseEdges: graph.edges?.length,
                returnedDerivedEdges: graph.derived_edges?.length,
                declaredTotalDerivedEdges: graph._meta?.total_derived_edges,
            },
            archivedResearchSnapshots: archivedSnapshots,
            generationMismatches: {
                registryDerivedMinusDerivedCompactRows:
                    (registryCounts.kind.derived || 0) - derivedCounts.rows,
                registryDerivedMinusDerivedCompactUnique:
                    (registryCounts.kind.derived || 0) - derivedCounts.uniqueKeys,
                registryDerivedMinusGraphDeclaredEdges:
                    (registryCounts.kind.derived || 0)
                    - finite(graph._meta?.total_derived_edges, 0),
                registryEntriesMinusExperimentRows:
                    registryCounts.entries - experimentRows,
            },
            correctionVerdict:
                'The compact p-values and reconstructed Pearson tails can be corrected numerically, '
                + 'but the registry is one adaptively generated search with generation mismatches, '
                + 'mixed post-outcome descendants, no complete null replay, and no source/time lockbox. '
                + 'Archived snapshots are not replications.',
            promotionCeiling: 'discovery_only',
        },
        compactTests,
        derivedTests,
        outcomeSearchExecutions: experimentRows,
    };
}

function promotionCeiling(checks) {
    if (checks.dependsOnUnifiedPanel && !checks.panelIntegrityPassed) {
        return 'discovery_only_invalid_panel';
    }
    if (checks.evidenceClass === 'projected_target') return 'surrogate_association';
    if (!checks.completeFamilyAccounted || !checks.validNullReplay) return 'discovery_only';
    if (!checks.outOfFold) return 'retrospective_mechanism';
    if (!checks.sourceHoldout && !checks.timeHoldout) return 'local_invariant';
    if (!checks.formatHoldout) return 'regional_invariant';
    if (!checks.prospective) return 'domain_invariant';
    return 'prospectively_supported_invariant';
}

function summarizeFlatSensitivity({
    threshold,
    operations,
    promise,
    tribe,
    legacy,
}) {
    const countUnder = tests => tests.filter(row => {
        const p = typeof row === 'number' ? row : row.p;
        return Number.isFinite(p) && p <= threshold;
    }).length;
    return {
        threshold,
        operationsProjectedScoreTestsBelowThreshold: countUnder(operations.pValues),
        promiseReportedTestsBelowThreshold: countUnder(promise.pValues),
        tribeTestsBelowThreshold: countUnder(tribe.tests),
        tribeCoreDeconfoundedTestsBelowThreshold: countUnder(
            tribe.tests.filter(row => (
                row.mode === 'duration_partial_spearman'
                && TRIBE_CORE_TARGETS.has(row.target)
            ))
        ),
        legacyCompactTestsBelowThreshold: countUnder(legacy.compactTests),
        legacyReconstructedDerivedTestsBelowThreshold: countUnder(legacy.derivedTests),
        interpretation:
            'This Bonferroni screen is a sensitivity bound over visible search executions, not a '
            + 'substitute for replaying each adaptive algorithm under a synchronized null.',
    };
}

function conciseFindingLedger({ operations, promise, tribe, legacy, alpha }) {
    const operationsTargets = Object.entries(operations.report.targetReports).map(([target, row]) => ({
        target,
        continuousBySurvivors: row.continuousBySurvivors,
        thresholdBySurvivors: row.thresholdBySurvivors,
        evidenceClass: 'projected_target',
        promotable: false,
    }));
    const market = promise.marketTests
        .filter(row => row.survivesNativeFourEndpointBy)
        .map(row => ({
            finding: `Frozen external Market Hold score associates with ${row.target}`,
            n: row.n,
            spearman: row.spearman,
            permutationP: row.rankPermutationP,
            nativeFourEndpointBy: row.recomputedDependencySafeQ,
            evidenceClass: 'observed_outcome_cross_source_transfer',
            ceiling: 'regional_retrospective_candidate',
            promotableNow: false,
            blocker:
                'No program-wide sealed family or prospective same-topic intervention; one owned account.',
        }));
    const tribeCore = tribe.report.exactStudentTReanalysis.topCore.map(row => ({
        finding: `${row.indicator}.${row.feature} associates with ${row.target}`,
        n: row.n,
        partialSpearman: row.partialSpearman,
        globalBy: row.globalBy,
        evidenceClass: 'same_account_observed_association',
        ceiling: 'local_diagnostic',
        promotableNow: false,
        blocker: 'No independent account/time lockbox or synchronized maxT replay.',
    }));
    return {
        nativeFamilyStatisticalSurvivors: {
            operationsProjectedTargets: operationsTargets,
            promiseMarketHold: market,
            tribeCoreDeconfounded: tribeCore,
            legacyCompactByCount: legacy.report.compactIndicators.bySurvivors,
            legacyReconstructedDerivedByCount:
                legacy.report.derivedCompact.reconstructedBySurvivors,
        },
        falsificationsThatCurrentlyHold: [
            {
                finding: 'No Promise cluster-outcome family validates chronologically.',
                count: promise.report.clusterOutcomeSearch.chronologicallyValidatedFamilies,
            },
            {
                finding: 'No positive processing delay survives the 816-specification max-stat null.',
                supported: promise.report.timingSearch.processingLagSupported,
            },
            {
                finding: 'Hook-quality random-fold signal fails chronological replication.',
                randomP: promise.report.hookQuality.randomFoldPermutationP,
                chronologicalP: promise.report.hookQuality.chronologicalPermutationP,
            },
        ],
        promotedFindings: [],
        wholeProgramVerdict:
            `At alpha ${alpha}, several numbers survive their native retrospective families, but no `
            + 'candidate survives multiplicity, evidence-class, independent-source/time, and '
            + 'prospective gates simultaneously. There is currently no promoted principle.',
    };
}

async function buildPromotionLedger(options = {}) {
    const alpha = finite(options.alpha, DEFAULT_ALPHA);

    const unifiedPanel = await auditUnifiedPanelIntegrity();
    const operationsArtifact = requiredJson(FILES.operations);
    const promiseSummary = requiredJson(FILES.promiseSummary);
    const promiseOutcomes = requiredJson(FILES.promiseOutcomes);
    const promiseForward = requiredJson(FILES.promiseForward);
    const promiseQuality = requiredJson(FILES.promiseQuality);
    const promiseMarket = requiredJson(FILES.promiseMarket);
    const retentionArtifact = requiredJson(FILES.retention);
    const tribeArtifact = requiredJson(FILES.tribe);

    const [
        promiseClusterRows,
        promiseBoundaryRows,
        promiseAllSpanRows,
        promiseOutcomeRows,
    ] = await Promise.all([
        auditJsonLinesGzip(FILES.promiseClusters),
        auditJsonLinesGzip(FILES.promiseBoundaries),
        auditJsonLinesGzip(FILES.promiseAllSpans),
        auditJsonLinesGzip(FILES.promiseOutcomeRows),
    ]);

    const operations = auditOperations(operationsArtifact, alpha);
    const promise = auditPromise({
        summary: promiseSummary,
        clusterRows: promiseClusterRows,
        boundaryRows: promiseBoundaryRows,
        allSpanRows: promiseAllSpanRows,
        outcomeRows: promiseOutcomeRows,
        outcomes: promiseOutcomes,
        forward: promiseForward,
        quality: promiseQuality,
        market: promiseMarket,
        alpha,
    });
    const retention = auditRetention(retentionArtifact);
    const tribe = auditTribe(tribeArtifact, alpha);
    const legacy = await auditLegacy(alpha);
    const baselineSensitivity = requiredJson(FILES.baselineSensitivityValidation);
    const creatorDeltaValidation = requiredJson(FILES.withinCreatorDeltaValidation);
    const adjustedClusterValidation = requiredJson(FILES.clusterOutcomesAdjusted);

    const promiseIds = new Set((promiseMarket.hooks || []).map(row => String(row.videoId)));
    const retentionIds = new Set(
        (retentionArtifact.scatter || []).map(row => String(row.id ?? row.videoId))
    );
    const tribeIds = new Set((tribeArtifact.rows || []).map(row => String(row.id)));
    const overlap = {
        promiseRetention: overlapSize(promiseIds, retentionIds),
        promiseTribe: overlapSize(promiseIds, tribeIds),
        retentionTribe: overlapSize(retentionIds, tribeIds),
    };

    const knownOutcomeSearchExecutions =
        operations.report.outcomeHypotheses
        + promise.outcomeSearchExecutions
        + retention.outcomeSearchExecutions
        + tribe.outcomeSearchExecutions
        + legacy.outcomeSearchExecutions;
    const visibleBonferroniThreshold = alpha / knownOutcomeSearchExecutions;

    const sourceFiles = [...new Set([
        FILES.operations,
        FILES.promiseSummary,
        FILES.promiseClusters,
        FILES.promiseBoundaries,
        FILES.promiseAllSpans,
        FILES.promiseOutcomeRows,
        FILES.promiseOutcomes,
        FILES.promiseForward,
        FILES.promiseQuality,
        FILES.promiseMarket,
        FILES.retention,
        FILES.tribe,
        FILES.legacyRegistry,
        FILES.legacyIndicators,
        FILES.legacyExperiments,
        FILES.legacyDerived,
        FILES.legacyGraph,
        FILES.legacyQuestions,
        ...unifiedPanel.artifactFiles,
    ])];
    const artifacts = [];
    for (const file of sourceFiles) artifacts.push(await provenance(file));

    const flatSensitivity = summarizeFlatSensitivity({
        threshold: visibleBonferroniThreshold,
        operations,
        promise,
        tribe,
        legacy,
    });
    const findings = conciseFindingLedger({ operations, promise, tribe, legacy, alpha });
    const sensitivityRows = [
        ...(baselineSensitivity.specifications || []),
        ...(baselineSensitivity.historySupportSpecifications || [])
            .filter(row => row.reusedPrimarySpecification !== true),
    ].flatMap(specification => (
        ['visual', 'together'].flatMap(modality => (
            ['unseenCreator', 'laterVideo'].map(
                split => specification.results?.[modality]?.[split]
            )
        ))
    )).filter(Boolean);
    const shortsDelta = Object.fromEntries(
        (creatorDeltaValidation.channels || [])
            .filter(row => (
                row.format === 'shorts'
                && ['visual', 'text', 'together'].includes(row.modality)
            ))
            .map(row => [row.modality, {
                unseenCreator: {
                    spearman: row.creatorDelta?.unseenCreator?.spearman,
                    bitsPerObservation:
                        row.creatorDelta?.unseenCreator?.gaussianBitsPerObservation,
                    pairwiseAccuracy:
                        row.creatorDelta?.unseenCreator
                            ?.withinSourcePairwise?.microAccuracy,
                },
                laterVideo: {
                    spearman: row.creatorDelta?.laterVideo?.spearman,
                    bitsPerObservation:
                        row.creatorDelta?.laterVideo?.gaussianBitsPerObservation,
                    pairwiseAccuracy:
                        row.creatorDelta?.laterVideo
                            ?.withinSourcePairwise?.microAccuracy,
                },
            }])
    );
    findings.strictQuantAudit = {
        clusterOutcomeFamily: {
            tests: finite(
                adjustedClusterValidation.tests,
                adjustedClusterValidation.tests?.length || 0
            ),
            familyWiseSignificant:
                adjustedClusterValidation.familyWiseSignificantTests || 0,
            bestLaterVideo: adjustedClusterValidation.bestLaterVideo,
        },
        nuisanceBaselineFamily: {
            hypotheses: baselineSensitivity.grid?.hypotheses,
            holm05Survivors: sensitivityRows.filter(
                row => finite(row.multiplicity?.holmP, 1) <= alpha
            ).length,
            fdr05Survivors: sensitivityRows.filter(
                row => finite(row.multiplicity?.benjaminiHochbergQ, 1) <= alpha
            ).length,
            interpretation:
                'No nuisance-baseline result survives family-wise Holm control. Several survive '
                + 'FDR, but within-creator pairwise accuracy crosses chance across reasonable '
                + 'baselines and history support thresholds.',
        },
        creatorRelativeDecisionSignal: shortsDelta,
    };
    findings.invalidatedUnifiedPanelArtifacts =
        unifiedPanel.report.invalidatedConfirmatoryArtifacts;
    findings.wholeProgramVerdict = (
        `At alpha ${alpha}, several numbers survive their native retrospective families, but no `
        + 'candidate survives multiplicity, evidence-class, independent-source/time, and '
        + 'prospective gates simultaneously. Shorts pass the frozen-source and reconstructed-'
        + 'geometry lineage gates; Long remains underpowered. The two incoherent native Long maps '
        + 'remain rejected and are not used by the rebuilt geometry. There is currently no '
        + 'promoted principle.'
    );

    return {
        schema: 'jarvis-multiplicity-aware-promotion-ledger-v2',
        generatedAt: new Date().toISOString(),
        alpha,
        governingContract: path.relative(
            JARVIS_ROOT,
            path.join(JARVIS_ROOT, 'principles-lab', 'DISCOVERY_CONTRACT.md')
        ),
        observationIdentity:
            'platform + format + video_id + outcome_snapshot + representation_contract',
        evidenceEvents: [
            {
                id: 'unified_public_panel_current_generation',
                rows: unifiedPanel.report.rows,
                class: 'format-gated_retrospective_panel',
                independentOutcomeEvent: false,
                promotionEligibleRows: unifiedPanel.report.promotionEligibleRows,
                promotionEligibleRowsByFormat:
                    unifiedPanel.report.promotionEligibleRowsByFormat,
                hardGatePass: unifiedPanel.report.allHardGatesPass,
                invalidatedArtifacts:
                    unifiedPanel.report.invalidatedConfirmatoryArtifacts.map(row => row.id),
                reason: unifiedPanel.report.baseIntegrityGatesPass
                    ? 'The current panel is bound to the two-read immutable snapshot and passes '
                        + 'storedAt, stored-only, unrechecked, reconstructed-geometry, and S_j <= T_i '
                        + 'gates. Shorts descendants with matching lineage are admissible for '
                        + 'retrospective validation. Long remains blocked by strict all-modality '
                        + 'support.'
                    : 'The current panel fails one or more immutable snapshot, storedAt, stored-only, '
                        + 'unrechecked, or S_j <= T_i gates.',
            },
            {
                id: 'operations_saved_projected_keep',
                rows: operations.report.evidenceRows,
                class: 'projected_target',
                independentOutcomeEvent: false,
                transformedBy: ['23 resolutions', '782 partitions', '2,590 raw candidates'],
            },
            {
                id: 'operations_private_observed_transport',
                rows: operations.report.transport.observedRows,
                groups: operations.report.transport.observedGroups,
                class: 'observed_outcome',
                identityStatus:
                    'IDs are not persisted in the transport artifact; conservatively assume overlap '
                    + 'with the private Retention/Tribe corpus.',
            },
            {
                id: 'promise_retention_owned_private_analytics',
                rows: retention.report.evidenceRows,
                class: 'observed_outcome',
                nestedViews: {
                    promise: promise.report.hooks,
                    retention: retention.report.evidenceRows,
                    tribe: tribe.report.evidenceRows,
                    exactIdOverlap: overlap,
                },
                independentOutcomeEventsCounted: 1,
            },
            {
                id: 'market_hold_external_public_text',
                rows: promise.report.marketHold.externalRows,
                groups: promise.report.marketHold.externalGroups,
                class: 'observed_input_plus_public_views',
                promiseIdsInTraining:
                    promiseMarket.audit?.promiseIdsPresentInExternalTraining,
                independentFromOwnedPromiseOutcomes: true,
            },
            {
                id: 'legacy_mixed_video_snapshots',
                rowsRange: [
                    legacy.report.experimentLog.sampleSizeMin,
                    legacy.report.experimentLog.sampleSizeMax,
                ],
                class: 'mixed_pre_and_post_outcome',
                identityStatus:
                    'Compact artifacts omit video IDs and outcome-snapshot identity; assume overlap '
                    + 'with every compatible owned/public corpus until proven otherwise.',
            },
        ],
        adaptiveSearchUniverse: {
            knownOutcomeOrientedSearchExecutionsLowerBound: knownOutcomeSearchExecutions,
            exactVisibleBonferroniThreshold: visibleBonferroniThreshold,
            note:
                'This is a count of artifact-visible search executions, not independent evidence. '
                + 'It excludes unlogged analyst choices and does not add duplicate registry views.',
            outcomeBlindGeometry: {
                operationsPartitionConfigurations:
                    operations.report.partitionConfigurations,
                operationsRawCandidates: operations.report.rawCandidates,
                promiseRows: promise.report.geometry.totalOutcomeBlindRows,
            },
            outcomeOrientedExecutions: {
                operations: operations.report.outcomeHypotheses,
                promise: promise.outcomeSearchExecutions,
                retention: retention.outcomeSearchExecutions,
                tribe: tribe.outcomeSearchExecutions,
                legacyExperimentLog: legacy.outcomeSearchExecutions,
            },
            transformedOutputsNotAddedAsNewEvidence: {
                legacyRegistryEntries: legacy.report.registry.entries,
                legacyDerivedCompactRows: legacy.report.derivedCompact.rows,
                legacyGraphDerivedEdges: legacy.report.graph.declaredTotalDerivedEdges,
                archivedResearchSnapshots: legacy.report.archivedResearchSnapshots,
            },
        },
        multiplicityPolicy: {
            dataIntegrityPrecondition:
                'Panel integrity gates are logically prior to multiplicity. A maxT p-value or FDR '
                + 'q-value computed from an inadmissible panel remains inadmissible; correction '
                + 'cannot repair source timing, recheck leakage, or mixed generations.',
            preferredSharedEventNull:
                'For overlapping Promise, Retention, and Tribe claims, permute one shared video-level '
                + 'outcome assignment inside predeclared account x chronological blocks. Rerun every '
                + 'boundary, cluster, lag, feature, model, and endpoint choice. Save the maximum '
                + 'studentized statistic from each permutation.',
            familyHierarchy: [
                'Gate each evidence event with a max-stat permutation p-value.',
                'Apply BY across event/family gates because arbitrary dependence is expected.',
                'Inside a passed family, apply maxT or BY across every candidate and endpoint.',
                'Require an untouched source/time or prospective lockbox for promotion.',
            ],
            currentFallback:
                'Where replayable row-level statistics exist, this ledger reports global BY and a '
                + 'Bonferroni-min-p family gate followed by BY across families. Missing search history '
                + 'is a blocker, never permission to use an unadjusted p-value.',
            evidenceClassRule:
                'Multiplicity correction controls false discoveries; it cannot turn a projected score, '
                + 'post-outcome descendant, generated candidate, or manual probe into observed validation.',
            promotionRule:
                'ceiling = minimum(family accounting, valid null, out-of-fold, source/time transfer, '
                + 'format transfer, prospective seal)',
        },
        audits: {
            unifiedPanel: unifiedPanel.report,
            operations: operations.report,
            promise: promise.report,
            retention: retention.report,
            tribe: tribe.report,
            legacy: legacy.report,
        },
        promotionCeilings: {
            unifiedPanelDerivedClaims: promotionCeiling({
                dependsOnUnifiedPanel: true,
                panelIntegrityPassed: unifiedPanel.report.allHardGatesPass,
                completeFamilyAccounted: false,
                validNullReplay: false,
            }),
            operations: operations.report.promotionCeiling,
            promiseClusters: 'random_fold_conditional_diagnostic',
            promiseTiming: 'falsified_processing_lag',
            promiseMarketHold: promise.report.promotionCeiling,
            retention: retention.report.promotionCeiling,
            tribe: tribe.report.promotionCeiling,
            legacy: legacy.report.promotionCeiling,
            wholeProgram: 'no_promoted_invariant',
        },
        flatKnownUniverseSensitivity: flatSensitivity,
        findings,
        integrityFindings: [
            {
                severity: 'critical',
                finding:
                    `Unified-panel promotion is blocked by: ${
                        unifiedPanel.report.failedHardGates.join(', ')
                    }.`,
                gates: unifiedPanel.report.gates,
                invalidatedArtifacts:
                    unifiedPanel.report.invalidatedConfirmatoryArtifacts.map(row => row.id),
            },
            {
                severity: 'high',
                finding:
                    'Promise (208), Retention (211), and Tribe (130) are nested views of one owned cohort.',
                exactOverlap: overlap,
            },
            {
                severity: 'high',
                finding:
                    'Legacy generations disagree, so no single immutable candidate universe can be replayed.',
                counts: legacy.report.generationMismatches,
            },
            {
                severity: 'high',
                finding:
                    'Retention feature selection quotes the same CV surface used to choose its path.',
                visibleSelectionEvaluations:
                    retention.report.adaptiveSelection.visibleSelectionEvaluations,
            },
            {
                severity: 'medium',
                finding:
                    'Tribe uses one account, 31,020 browsable tests, and overlapping hold-in stability checks.',
            },
            {
                severity: 'medium',
                finding:
                    'Operations saved rows lack creator identity and immutable per-record embedding versions.',
            },
        ],
        candidateRecordSchema: {
            required: [
                'candidateId',
                'familyId',
                'evidenceEventIds',
                'selectionFrozenAt',
                'sourceSnapshotRunId',
                'sourceSnapshotIdentityHash',
                'sourceObjectHashes',
                'representationHash',
                'outcomeSnapshotHash',
                'observationTimeSource',
                'storedRowVerified',
                'recheckedExcluded',
                'historicalObservabilityRule',
                'strictSupportCount',
                'rawStatistic',
                'familyAdjustedP',
                'acrossFamilyQ',
                'effectSize',
                'confidenceInterval',
                'sourceHoldout',
                'timeHoldout',
                'prospectiveSeal',
                'promotionCeiling',
            ],
            prohibition:
                'A transformed output may point to its parent evidence event but may not create a new event ID.',
        },
        artifacts,
    };
}

function formatCount(value) {
    return Number(value).toLocaleString('en-US');
}

function printSummary(ledger) {
    const universe = ledger.adaptiveSearchUniverse;
    const panel = ledger.audits.unifiedPanel;
    const promise = ledger.audits.promise;
    const tribe = ledger.audits.tribe;
    const legacy = ledger.audits.legacy;
    console.log('Multiplicity-aware promotion ledger');
    console.log(
        `  Unified panel integrity gate: ${panel.baseIntegrityGatesPass ? 'PASS' : 'FAIL'}; `
        + `${formatCount(panel.rows)} cached rows; `
        + `Shorts ${formatCount(panel.promotionEligibleRowsByFormat.shorts)} eligible; `
        + `Long ${formatCount(panel.promotionEligibleRowsByFormat.long)} eligible`
    );
    console.log(
        `  Frozen-source + map/vector + storedAt + unrechecked + history gates: `
        + `${panel.baseIntegrityGatesPass ? 'PASS' : 'FAIL'}`
    );
    console.log(
        `  Long strict historical all-modality support: `
        + `${formatCount(
            panel.gates.longStrictAllModalitySupport.evidence
                .currentFrozenPanelCountUsedForPromotion
        )} / ${formatCount(
            panel.gates.longStrictAllModalitySupport.evidence
                .minimumIndependentRowsBeforeDesignEffect
        )} minimum before design effect`
    );
    console.log(
        `  Panel-derived artifacts with valid Shorts lineage: `
        + `${panel.invalidatedConfirmatoryArtifacts.filter(
            row => row.shortsConfirmatoryDataUseValid
        ).length}; valid Long lineage + support: ${
            panel.invalidatedConfirmatoryArtifacts.filter(
                row => row.longConfirmatoryDataUseValid
            ).length
        }`
    );
    console.log(`  Visible outcome-search executions: ${formatCount(
        universe.knownOutcomeOrientedSearchExecutionsLowerBound
    )}`);
    console.log(`  Flat sensitivity threshold: ${universe.exactVisibleBonferroniThreshold}`);
    console.log(
        `  Owned event overlap: Promise ${promise.hooks} / Retention `
        + `${ledger.audits.retention.evidenceRows} / Tribe ${tribe.evidenceRows}`
    );
    console.log(
        `  Promise geometry/outcomes: ${formatCount(promise.geometry.totalOutcomeBlindRows)} / `
        + `${formatCount(promise.clusterOutcomeSearch.rows)}`
    );
    console.log(
        `  Tribe: ${formatCount(tribe.exactBrowsableTests)} tests; `
        + `${tribe.exactStudentTReanalysis.globalBySurvivors} global-BY numerical survivors; `
        + `${tribe.exactStudentTReanalysis.coreDeconfoundedGlobalBySurvivors} core deconfounded`
    );
    console.log(
        `  Legacy: ${formatCount(legacy.experimentLog.rows)} logged executions; `
        + `${formatCount(legacy.registry.entries)} registry outputs; `
        + `${formatCount(legacy.derivedCompact.rows)} derived rows`
    );
    console.log(
        `  Market Hold native four-endpoint BY survivors: `
        + `${promise.marketHold.nativeBySurvivorCount}`
    );
    console.log('  Promoted principles after all gates: 0');
    console.log(`  Verdict: ${ledger.findings.wholeProgramVerdict}`);
}

function parseArguments(argv) {
    const output = { json: false, out: null, alpha: DEFAULT_ALPHA };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json') output.json = true;
        else if (argument === '--out') output.out = argv[++index];
        else if (argument.startsWith('--out=')) output.out = argument.slice('--out='.length);
        else if (argument === '--alpha') output.alpha = Number(argv[++index]);
        else if (argument.startsWith('--alpha=')) {
            output.alpha = Number(argument.slice('--alpha='.length));
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!(output.alpha > 0 && output.alpha < 1)) {
        throw new Error(`alpha must be between zero and one; received ${output.alpha}`);
    }
    return output;
}

if (require.main === module) {
    (async () => {
        const options = parseArguments(process.argv.slice(2));
        const ledger = await buildPromotionLedger(options);
        if (options.out) {
            const destination = path.resolve(options.out);
            fs.writeFileSync(destination, `${JSON.stringify(ledger, null, 2)}\n`);
            console.log(`Wrote ${destination}`);
        }
        if (options.json) console.log(JSON.stringify(ledger, null, 2));
        else printSummary(ledger);
    })().catch(error => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
    });
}

module.exports = {
    adjustPValues,
    auditUnifiedPanelIntegrity,
    buildPromotionLedger,
    correlationPValue,
    promotionCeiling,
};
