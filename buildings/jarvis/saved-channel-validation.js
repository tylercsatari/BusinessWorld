'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contract = require('./saved-channel-feature-contract.json');

const VERSION = 5;
const LEDGER_VERSION = 2;
const CURVE_SECONDS = Object.freeze(Array.from({ length: 21 }, (_, second) => second));
const SUPPORTED_CHANNELS = Object.freeze([
    { channelId: 'chd3f5a3dae83f3382', accountId: 'tyler', accountName: 'Tyler Csatari' },
    { channelId: 'ch87ccaa3dd3383515', accountId: 'hafu', accountName: 'Hafu Go' },
]);

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 5) => finite(value) ? Number(Number(value).toFixed(digits)) : null;

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${stableJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

function sha256Json(value) {
    return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    const position = clamp(probability, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position), upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function ranks(values) {
    const sorted = values.map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const output = new Array(values.length);
    for (let start = 0; start < sorted.length;) {
        let end = start + 1;
        while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
        const rank = (start + end - 1) / 2;
        for (let index = start; index < end; index++) output[sorted[index].index] = rank;
        start = end;
    }
    return output;
}

function pearson(actual, predicted) {
    if (actual.length < 3 || actual.length !== predicted.length) return null;
    const actualMean = average(actual), predictedMean = average(predicted);
    let numerator = 0, actualSquare = 0, predictedSquare = 0;
    for (let index = 0; index < actual.length; index++) {
        const actualDelta = actual[index] - actualMean;
        const predictedDelta = predicted[index] - predictedMean;
        numerator += actualDelta * predictedDelta;
        actualSquare += actualDelta * actualDelta;
        predictedSquare += predictedDelta * predictedDelta;
    }
    return actualSquare > 0 && predictedSquare > 0
        ? numerator / Math.sqrt(actualSquare * predictedSquare)
        : null;
}

function spearman(actual, predicted) {
    return pearson(ranks(actual), ranks(predicted));
}

function calibration(actual, predicted) {
    if (actual.length < 3) return { slope: null, intercept: null };
    const predictedMean = average(predicted), actualMean = average(actual);
    const denominator = predicted.reduce((sum, value) => sum + (value - predictedMean) ** 2, 0);
    if (denominator <= 0) return { slope: null, intercept: actualMean };
    const slope = predicted.reduce(
        (sum, value, index) => sum + (value - predictedMean) * (actual[index] - actualMean),
        0
    ) / denominator;
    return { slope, intercept: actualMean - slope * predictedMean };
}

function regressionMetrics(points, options = {}) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted))
        .map(point => ({
            actual: Number(point.actual),
            predicted: Number(point.predicted),
            baseline: finite(point.baseline) ? Number(point.baseline) : null,
            id: point.id,
            accountId: point.accountId,
        }));
    if (!observed.length) return { n: 0 };
    const actual = observed.map(point => point.actual);
    const predicted = observed.map(point => point.predicted);
    const residual = predicted.map((value, index) => value - actual[index]);
    const actualMean = average(actual);
    const sse = residual.reduce((sum, value) => sum + value * value, 0);
    const baselineSse = observed.reduce((sum, point) => {
        const baseline = finite(point.baseline) ? point.baseline : actualMean;
        return sum + (point.actual - baseline) ** 2;
    }, 0);
    const fit = calibration(actual, predicted);
    const metrics = {
        n: observed.length,
        coverage: options.total ? observed.length / options.total : null,
        r2: baselineSse > 0 ? 1 - sse / baselineSse : null,
        pearson: pearson(actual, predicted),
        spearman: spearman(actual, predicted),
        mae: average(residual.map(Math.abs)),
        rmse: Math.sqrt(sse / observed.length),
        bias: average(residual),
        calibrationSlope: fit.slope,
        calibrationIntercept: fit.intercept,
        residualP10: quantile(residual, 0.1),
        residualP50: quantile(residual, 0.5),
        residualP90: quantile(residual, 0.9),
        actualMin: Math.min(...actual),
        actualMax: Math.max(...actual),
        predictedMin: Math.min(...predicted),
        predictedMax: Math.max(...predicted),
    };
    if (options.logScale) {
        const factors = residual.map(value => 10 ** Math.abs(value));
        metrics.medianFactorError = quantile(factors, 0.5);
        metrics.geometricMeanFactorError = 10 ** average(residual.map(Math.abs));
    }
    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
        key,
        typeof value === 'number' ? round(value) : value,
    ]));
}

function rocAuc(actual, scores) {
    const positives = actual.filter(Boolean).length;
    const negatives = actual.length - positives;
    if (!positives || !negatives) return null;
    const scoreRanks = ranks(scores);
    let positiveRankSum = 0;
    actual.forEach((value, index) => { if (value) positiveRankSum += scoreRanks[index]; });
    return (positiveRankSum - positives * (positives - 1) / 2) / (positives * negatives);
}

function aucInference(points, stratified) {
    const groups = new Map();
    for (const point of points) {
        const key = stratified ? point.accountId : 'all';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(point);
    }
    let weightedAuc = 0, totalPairs = 0, weightedVariance = 0;
    for (const group of groups.values()) {
        const actual = group.map(point => Number(point.actual) >= 0.5 ? 1 : 0);
        const predicted = group.map(point => Number(point.predicted));
        const positives = actual.filter(Boolean).length;
        const negatives = actual.length - positives;
        const pairCount = positives * negatives;
        const auc = rocAuc(actual, predicted);
        if (!pairCount || !finite(auc)) continue;
        const q1 = auc / (2 - auc);
        const q2 = 2 * auc * auc / (1 + auc);
        const variance = (
            auc * (1 - auc)
            + (positives - 1) * (q1 - auc * auc)
            + (negatives - 1) * (q2 - auc * auc)
        ) / pairCount;
        weightedAuc += auc * pairCount;
        weightedVariance += Math.max(0, variance) * pairCount * pairCount;
        totalPairs += pairCount;
    }
    if (!totalPairs) return { auc: null, p: null, ci95: [null, null], pairs: 0 };
    const auc = weightedAuc / totalPairs;
    const standardError = Math.sqrt(weightedVariance) / totalPairs;
    const z = standardError > 0 ? Math.abs((auc - 0.5) / standardError) : null;
    const low = standardError > 0 ? clamp(auc - 1.959963984540054 * standardError, 0, 1) : auc;
    const high = standardError > 0 ? clamp(auc + 1.959963984540054 * standardError, 0, 1) : auc;
    return {
        auc,
        p: z == null ? null : round(2 * (1 - normalCdf(z)), 8),
        ci95: [round((low - 0.5) * 2), round((high - 0.5) * 2)],
        pairs: totalPairs,
    };
}

function binaryMetrics(points, total) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted))
        .map(point => ({
            actual: Number(point.actual) >= 0.5 ? 1 : 0,
            predicted: clamp(Number(point.predicted), 0, 1),
        }));
    if (!observed.length) return { n: 0 };
    const actual = observed.map(point => point.actual);
    const predicted = observed.map(point => point.predicted);
    const baseRate = average(actual);
    const brier = average(actual.map((value, index) => (value - predicted[index]) ** 2));
    const baselineBrier = average(actual.map(value => (value - baseRate) ** 2));
    return {
        n: observed.length,
        coverage: total ? round(observed.length / total) : null,
        positives: actual.filter(Boolean).length,
        baseRate: round(baseRate),
        auc: round(rocAuc(actual, predicted)),
        brier: round(brier),
        brierSkill: baselineBrier > 0 ? round(1 - brier / baselineBrier) : null,
    };
}

function rankMetrics(points, total) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted));
    if (!observed.length) return { n: 0 };
    return {
        n: observed.length,
        coverage: total ? round(observed.length / total) : null,
        spearman: round(spearman(
            observed.map(point => Number(point.actual)),
            observed.map(point => Number(point.predicted))
        )),
        note: 'Percentile coordinates are ranks, so calibration error in the outcome unit is not defined.',
    };
}

function featureCell(video, key) {
    const cell = video && video.features && video.features[key];
    if (Array.isArray(cell)) {
        return {
            raw: number(cell[0]),
            percentile: number(cell[1]),
        };
    }
    if (cell && typeof cell === 'object') {
        return {
            raw: number(cell.v != null ? cell.v : cell.value),
            percentile: number(cell.p != null ? cell.p : cell.percentile),
        };
    }
    return { raw: null, percentile: null };
}

function actualKeep(video) {
    return number(video && (video.keep_rate != null ? video.keep_rate : video.stayedToWatch));
}

function parseDate(value) {
    if (value == null || value === '') return null;
    const text = String(value);
    if (/^\d{8}$/.test(text)) {
        const timestamp = Date.UTC(
            Number(text.slice(0, 4)),
            Number(text.slice(4, 6)) - 1,
            Number(text.slice(6, 8))
        );
        return Number.isFinite(timestamp) ? timestamp : null;
    }
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function retentionCurveValues(value) {
    let source = value;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) { return []; }
    }
    if (source && !Array.isArray(source) && typeof source === 'object') {
        source = source.values || source.curve || source.retention || [];
    }
    if (!Array.isArray(source)) return [];
    const values = source.map(item => {
        if (item && typeof item === 'object') {
            return number(item.retention != null ? item.retention : (item.value != null ? item.value : item.y));
        }
        return number(item);
    });
    if (values.filter(finite).length < 2) return [];
    const finiteValues = values.filter(finite);
    const scale = Math.max(...finiteValues.map(Math.abs)) <= 3 ? 100 : 1;
    return values.map(item => finite(item) ? Number(item) * scale : null);
}

function interpolate(values, position) {
    if (!values.length || !finite(position) || position < 0 || position > values.length - 1) return null;
    const low = Math.floor(position), high = Math.ceil(position);
    const left = values[low], right = values[high];
    if (!finite(left) || !finite(right)) return null;
    if (low === high) return Number(left);
    const weight = position - low;
    return Number(left) + (Number(right) - Number(left)) * weight;
}

function retentionCurveSnapshot(curve, duration) {
    const values = retentionCurveValues(curve);
    if (values.length < 2 || !finite(duration) || Number(duration) <= 0) return null;
    const seconds = CURVE_SECONDS.slice();
    const observed = seconds.map(second => {
        if (second > Number(duration)) return null;
        return round(interpolate(values, second / Number(duration) * (values.length - 1)), 4);
    });
    const opening = observed[0];
    if (!finite(opening) || Number(opening) <= 0) return null;
    const normalized = observed.map(value => finite(value) ? round(Number(value) / Number(opening) * 100, 4) : null);
    const drop = observed.map(value => finite(value) ? round(Number(opening) - Number(value), 4) : null);
    return {
        seconds,
        observed,
        normalized,
        drop,
        opening: round(opening, 4),
        sourcePoints: values.length,
        sourceDuration: round(duration, 4),
    };
}

function curveValue(row, field, second) {
    const curve = row && row.actual && row.actual.retentionCurve;
    const index = curve && Array.isArray(curve.seconds) ? curve.seconds.indexOf(Number(second)) : -1;
    return index >= 0 && Array.isArray(curve[field]) ? number(curve[field][index]) : null;
}

const OUTCOME_DEFINITIONS = Object.freeze([
    { key: 'keep', label: 'Stayed to watch', unit: 'percent', accessor: row => row.actual.keep },
    { key: 'swipe', label: 'Swiped away', unit: 'percent', accessor: row => finite(row.actual.keep) ? 100 - Number(row.actual.keep) : null, derived: '100 - stayed to watch' },
    { key: 'ret5', label: 'YouTube 5s retention', unit: 'percent', accessor: row => row.actual.ret5 },
    { key: 'averageRetention', label: 'Average percentage viewed', unit: 'percent', accessor: row => row.actual.averageRetention },
    { key: 'views', label: 'Current lifetime views', unit: 'views', accessor: row => row.actual.viewsCurrent, transform: 'log10(views + 1)' },
    { key: 'outlier', label: 'Views / subscribers', unit: 'number', accessor: row => row.actual.outlierCurrent, transform: 'log10(value + 1)' },
    { key: 'hit10M', label: 'Over 10M views', unit: 'binary', accessor: row => row.actual.hit10MCurrent },
    { key: 'survival5', label: 'Retention surviving to 5s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 5), derived: 'observed retention at 5s / observed opening retention x 100' },
    { key: 'survival10', label: 'Retention surviving to 10s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 10), derived: 'observed retention at 10s / observed opening retention x 100' },
    { key: 'survival20', label: 'Retention surviving to 20s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 20), derived: 'observed retention at 20s / observed opening retention x 100' },
    { key: 'drop5', label: 'Observed drop by 5s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 5), derived: 'observed opening retention - observed retention at 5s' },
    { key: 'drop10', label: 'Observed drop by 10s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 10), derived: 'observed opening retention - observed retention at 10s' },
    { key: 'drop20', label: 'Observed drop by 20s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 20), derived: 'observed opening retention - observed retention at 20s' },
]);

const LONG_QUANT_METRICS = Object.freeze(
    (contract.crossDomainInventory && contract.crossDomainInventory.longQuant
        && contract.crossDomainInventory.longQuant.metrics || []).map(metric => Object.freeze({ ...metric }))
);

const LEGACY_DIAGNOSTIC_COORDINATES = Object.freeze([
    {
        key: 'keep-video-heldout-model',
        label: 'Legacy multi-input keep forecast · video held out',
        target: 'keep',
        unit: 'percent',
        path: ['predictions', 'keepVideoHeldOut'],
        replacement: 'shorts.video-forecast.keep',
    },
    {
        key: 'keep-account-heldout-model',
        label: 'Legacy multi-input keep forecast · account held out',
        target: 'keep',
        unit: 'percent',
        path: ['predictions', 'keepAccountHeldOut'],
        replacement: 'shorts.account-forecast.keep',
    },
    {
        key: 'keep-forward-time-model',
        label: 'Legacy multi-input keep forecast · forward time',
        target: 'keep',
        unit: 'percent',
        path: ['predictions', 'keepForwardTime'],
    },
    {
        key: 'views-public-axis-ensemble',
        label: 'Creator-excluded visual + text + both views-axis ensemble',
        target: 'views',
        unit: 'views',
        path: ['predictions', 'viewsPublicAxisEnsemble'],
        replacement: 'shorts.video-forecast.views',
    },
    {
        key: 'views-video-heldout-model',
        label: 'Legacy multi-input views forecast · video held out',
        target: 'views',
        unit: 'views',
        path: ['predictions', 'viewsVideoHeldOut'],
        replacement: 'shorts.video-forecast.views',
    },
    {
        key: 'views-account-heldout-model',
        label: 'Legacy multi-input views forecast · account held out',
        target: 'views',
        unit: 'views',
        path: ['predictions', 'viewsChannelHeldOut'],
        replacement: 'shorts.account-forecast.views',
    },
    {
        key: 'views-forward-time-model',
        label: 'Legacy multi-input views forecast · forward time',
        target: 'views',
        unit: 'views',
        path: ['predictions', 'viewsForwardTime'],
    },
]);

function displayTargetForOutcome(key) {
    if (key === 'hit10M') return 'gt10M';
    if (key === 'views') return 'views';
    if (key === 'outlier') return 'outlier';
    return key;
}

function sha256Ids(ids) {
    return crypto.createHash('sha256').update(
        (ids || []).map(String).sort().join('\n')
    ).digest('hex');
}

function featureContractFileSha256() {
    return crypto.createHash('sha256').update(
        fs.readFileSync(path.join(__dirname, 'saved-channel-feature-contract.json'))
    ).digest('hex');
}

function validationProducerSourceSha256() {
    return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
}

function lineagePopulationSnapshot(rows, accountAccessor) {
    const ids = (rows || []).map(row => String(row.id)).filter(Boolean);
    const byAccount = {};
    for (const row of rows || []) {
        const account = String(accountAccessor(row) || 'unknown');
        if (!byAccount[account]) byAccount[account] = [];
        byAccount[account].push(String(row.id));
    }
    const accountById = new Map((rows || []).map(row => [
        String(row.id),
        String(accountAccessor(row) || 'unknown'),
    ]));
    const idsByAccount = Object.fromEntries(Object.keys(byAccount).map(account => [
        account,
        byAccount[account].slice(),
    ]));
    const videoFoldById = new Map();
    for (const accountIds of Object.values(idsByAccount)) {
        accountIds.sort((left, right) => {
            const leftHash = crypto.createHash('sha256').update(String(left)).digest('hex').slice(0, 16);
            const rightHash = crypto.createHash('sha256').update(String(right)).digest('hex').slice(0, 16);
            return leftHash.localeCompare(rightHash) || String(left).localeCompare(String(right));
        });
        accountIds.forEach((id, index) => videoFoldById.set(id, index % 5));
    }
    const videoFolds = Array.from({ length: 5 }, (_, fold) => {
        const testingIds = ids.filter(id => videoFoldById.get(id) === fold);
        const trainingIds = ids.filter(id => videoFoldById.get(id) !== fold);
        return {
            fold,
            trainingRowCount: trainingIds.length,
            trainingVideoIdSha256: trainingIds.length ? sha256Ids(trainingIds) : null,
            testingRowCount: testingIds.length,
            testingVideoIdSha256: testingIds.length ? sha256Ids(testingIds) : null,
        };
    });
    const accountHoldouts = Object.keys(byAccount).sort().map(account => {
        const testingIds = ids.filter(id => accountById.get(id) === account);
        const trainingIds = ids.filter(id => accountById.get(id) !== account);
        return {
            excludedAccountId: account,
            trainingRowCount: trainingIds.length,
            trainingVideoIdSha256: trainingIds.length ? sha256Ids(trainingIds) : null,
            testingRowCount: testingIds.length,
            testingVideoIdSha256: testingIds.length ? sha256Ids(testingIds) : null,
        };
    });
    return {
        count: ids.length,
        idSha256: ids.length ? sha256Ids(ids) : null,
        byAccount: Object.fromEntries(Object.entries(byAccount).map(([account, accountIds]) => [
            account,
            { count: accountIds.length, idSha256: sha256Ids(accountIds) },
        ])),
        videoFolds,
        accountHoldouts,
    };
}

function lineageRuntimeContext(
    rows,
    predictorProvenance,
    predictorPrivateRows,
    forecastModel,
    validationSourceFingerprint,
    validationGeneratedAt
) {
    const joinedEvaluationPopulation = lineagePopulationSnapshot(
        rows || [],
        row => row.accountId
    );
    const privateBlindArtifactPopulation = lineagePopulationSnapshot(
        predictorPrivateRows || [],
        row => row.account || row.accountId || row.accountName
    );
    const publicAxisPopulations = predictorProvenance.publicAxisPopulations
        && typeof predictorProvenance.publicAxisPopulations === 'object'
        ? predictorProvenance.publicAxisPopulations
        : null;
    const modalityTargetPopulations = {};
    for (const modality of ['visual', 'text', 'together']) {
        modalityTargetPopulations[modality] = {};
        for (const target of ['views', 'outlier', 'gt10M']) {
            const persisted = publicAxisPopulations
                && publicAxisPopulations[modality]
                && publicAxisPopulations[modality][target];
            const persistedExact = persisted
                && Number.isInteger(Number(persisted.rowCount))
                && Number(persisted.rowCount) >= 0
                && /^[a-f0-9]{64}$/i.test(String(persisted.videoIdSha256 || ''));
            modalityTargetPopulations[modality][target] = persistedExact
                ? {
                    ...persisted,
                    exact: true,
                }
                : {
                    rowCount: null,
                    videoIdSha256: null,
                    exact: false,
                    status: 'unknown in historical artifact',
                    rawStoreShape: predictorProvenance.rawStoreShape
                        && predictorProvenance.rawStoreShape[modality] || null,
                };
        }
    }
    return {
        joinedEvaluationPopulation,
        privateBlindArtifactPopulation,
        blindPublicAxisPopulation: {
            candidateUnionCount: number(predictorProvenance.rawAxisCorpusVideoCount),
            candidateUnionIdSha256: predictorProvenance.rawAxisCorpusIdHash || null,
            excludedCount: number(predictorProvenance.publicAxisExcludedVideoCount),
            excludedIdSha256: predictorProvenance.publicAxisExcludedVideoIdHash || null,
            validationCreatorCount: number(predictorProvenance.validationCreatorVideoCountExcluded),
            validationCreatorChannelIds: Array.isArray(predictorProvenance.validationCreatorChannelIds)
                ? predictorProvenance.validationCreatorChannelIds.slice()
                : [],
            modalityTargetPopulations,
            exactFitPopulationsPersisted: Object.values(modalityTargetPopulations)
                .every(targets => Object.values(targets).every(population => population.exact)),
            disclosure: Object.values(modalityTargetPopulations)
                .every(targets => Object.values(targets).every(population => population.exact))
                ? 'Exact eligible row count and video-ID hash are persisted separately for every modality/target fit.'
                : 'This historical artifact persisted only the deduplicated candidate-union count/hash and raw store shapes. Exact modality/target fit populations are unknown and are not inferred from the union.',
        },
        embeddingStores: predictorProvenance.rawStoreShape || null,
        forecastModel: forecastModel || null,
        runtimeVersions: predictorProvenance.runtime || null,
        runtimeManifests: predictorProvenance.runtimeManifests || {},
        predictorArtifact: {
            artifactSha256: predictorProvenance.artifactSha256 || null,
            archiveKey: predictorProvenance.artifactArchiveKey || null,
            manifestKey: predictorProvenance.artifactManifestKey || null,
            manifestSha256: predictorProvenance.artifactManifestSha256 || null,
            generatedAt: number(predictorProvenance.artifactGeneratedAt),
            producerSourceSha256: predictorProvenance.producerSourceSha256 || null,
            sourceArtifacts: predictorProvenance.sourceArtifacts || null,
        },
        validationArtifact: {
            sourceFingerprint: validationSourceFingerprint || null,
            generatedAt: number(validationGeneratedAt),
            producerSourceSha256: validationProducerSourceSha256(),
        },
        featureContractVersion: contract.version,
        featureContractSha256: predictorProvenance.featureContractSha256 || null,
        artifactFeatureContractVersion: number(predictorProvenance.featureContractVersion),
        artifactFeatureContractSha256: predictorProvenance.featureContractSha256 || null,
        currentFeatureContractVersion: contract.version,
        currentFeatureContractSha256: featureContractFileSha256(),
    };
}

function buildLineageCatalog(runtime) {
    const catalog = {
        schemaVersion: 1,
        rawInputs: {
            'input.shorts.visual-first5': {
                label: 'Shorts visual opening',
                domain: 'shorts',
                value: 'Five frames sampled across seconds 0-5 and stitched left to right.',
                sourceCode: ['raw_upload.py:hook_inputs'],
            },
            'input.shorts.transcript-first5': {
                label: 'Shorts spoken opening',
                domain: 'shorts',
                value: 'Normalized voiceover transcript recovered from seconds 0-5; absent when coherent speech is unavailable.',
                sourceCode: ['raw_upload.py:hook_inputs', 'raw_upload.py:normalize_transcript'],
            },
            'input.shorts.visual-and-transcript-first5': {
                label: 'Shorts visual + spoken opening',
                domain: 'shorts',
                value: 'The same five-frame montage and first-five-second transcript in one multimodal request.',
                sourceCode: ['raw_upload.py:_run'],
            },
            'input.shorts.duration': {
                label: 'Full Short duration',
                domain: 'shorts',
                value: 'Full-video duration from the client or ffprobe; 30 seconds is visibly marked when assumed.',
                sourceCode: ['raw_upload.py:_run'],
            },
            'input.shorts.private-outcomes': {
                label: 'Private YouTube Studio outcomes',
                domain: 'shorts',
                value: 'Stayed-to-watch, five-second retention, average percentage viewed, duration, and retention curve joined by video ID.',
                sourceCode: ['buildings/jarvis/retention-study/retention_table.json', 'retention/{account}.json'],
            },
            'input.shorts.public-outcomes': {
                label: 'Public Shorts outcomes',
                domain: 'shorts',
                value: 'Lifetime public views and subscriber snapshot-derived outlier ratio joined by video ID.',
                sourceCode: ['library/db.json', 'raw/{modality}/map.json'],
            },
            'input.shorts.retention-curve': {
                label: 'Observed retention curve',
                domain: 'shorts',
                value: 'Native private retention samples interpolated to exact seconds 0-20 and normalized only where named.',
                sourceCode: ['buildings/jarvis/saved-channel-validation.js:retentionCurveSnapshot'],
            },
            'input.shorts.nine-blind-axes': {
                label: 'Nine creator-excluded public axes',
                domain: 'shorts',
                value: 'Visual, text, and together x public views, outlier, and over-10M direct coordinates.',
                sourceCode: ['buildings/jarvis/saved-channel-validation.js:attachScore21Forecasts'],
            },
            'input.shorts.persisted-score': {
                label: 'Persisted historical score cell',
                domain: 'shorts',
                value: 'The exact raw estimate and percentile saved by the channel worker at analysis time.',
                sourceCode: ['buildings/jarvis/saved-channel-feature-contract.json'],
            },
            'input.long.thumbnail': {
                label: 'Long-form thumbnail',
                domain: 'long',
                value: 'Thumbnail image only.',
                sourceCode: ['longquant_score.py'],
            },
            'input.long.title': {
                label: 'Long-form title',
                domain: 'long',
                value: 'Candidate video title text only.',
                sourceCode: ['longquant_score.py'],
            },
            'input.long.thumbnail-and-title': {
                label: 'Long-form thumbnail + title',
                domain: 'long',
                value: 'Thumbnail and title embedded together.',
                sourceCode: ['longquant_score.py'],
            },
            'input.long.performance-outcomes': {
                label: 'Long-form performance outcomes',
                domain: 'long',
                value: 'Private CTR/30-second retention and public views/reference-neighbor outcomes.',
                sourceCode: ['add_steered_proj_long.py', 'longquant_score.py'],
            },
        },
        representations: {
            'representation.shorts.visual-gemini1536': {
                label: 'Gemini visual embedding',
                model: 'gemini-embedding-2',
                dimensions: 1536,
                normalization: 'L2 before projection',
                inputIds: ['input.shorts.visual-first5'],
            },
            'representation.shorts.text-gemini1536': {
                label: 'Gemini text embedding',
                model: 'gemini-embedding-2',
                dimensions: 1536,
                normalization: 'L2 before projection',
                inputIds: ['input.shorts.transcript-first5'],
            },
            'representation.shorts.together-gemini1536': {
                label: 'Gemini multimodal embedding',
                model: 'gemini-embedding-2',
                dimensions: 1536,
                normalization: 'L2 before projection',
                inputIds: ['input.shorts.visual-and-transcript-first5'],
            },
            'representation.shorts.novelty-primitives': {
                label: 'Novelty primitive vector',
                model: 'Deterministic functions of L2-normalized Gemini embeddings',
                dimensions: null,
                normalization: 'Cosine distances and PCA residual are evaluated in the normalized embedding space.',
                inputIds: [
                    'input.shorts.visual-first5',
                    'input.shorts.transcript-first5',
                    'input.shorts.visual-and-transcript-first5',
                ],
            },
            'representation.shorts.nine-axis-vector': {
                label: 'Nine-axis blind feature vector',
                model: 'Nine registered creator-excluded public coordinates',
                dimensions: 9,
                normalization: 'Training-fold mean imputation and standardization',
                inputIds: ['input.shorts.nine-blind-axes'],
            },
            'representation.long.visual-gemini1536': {
                label: 'Long visual embedding',
                model: 'gemini-embedding-2',
                dimensions: 1536,
                normalization: 'L2 before projection or cosine-neighbor lookup',
                inputIds: ['input.long.thumbnail'],
            },
            'representation.long.together-gemini1536': {
                label: 'Long thumbnail + title embedding',
                model: 'gemini-embedding-2',
                dimensions: 1536,
                normalization: 'L2 before projection or cosine-neighbor lookup',
                inputIds: ['input.long.thumbnail-and-title'],
            },
        },
        fitDatasets: {
            'dataset.shorts.production-tyler-private': {
                label: 'Production Tyler private labels',
                population: 'Exact target- and modality-specific Tyler rows with finite observed keep/ret5 labels',
                count: null,
                idSha256: null,
                disclosure: 'Read the exact per-target count and sorted-ID hash from the production steer manifest; no global constant is substituted.',
                sourceCode: ['buildings/jarvis/retention-study/retention_table.json', 'add_steered_proj.py'],
            },
            'dataset.shorts.production-public': {
                label: 'Production public Shorts corpus',
                population: 'Materialized global raw map corpus available when raw/steer_models.npz was generated; owned rows are merged and may be included',
                count: null,
                idSha256: null,
                disclosure: 'Historical production artifacts did not persist a corpus count/hash per saved video.',
                sourceCode: ['library/db.json', 'add_steered_proj.py'],
            },
            'dataset.shorts.production-novelty': {
                label: 'Production novelty reference corpus',
                population: 'Saved visual/text/together embedding stores, recent centroid, k-means centroids, and PCA basis',
                count: null,
                idSha256: null,
                disclosure: 'Historical target-calibration rows are persisted as scores, not as a reconstructible per-video fit manifest.',
                sourceCode: ['raw/novelty_models.npz', 'raw/indicators/weights.npz', 'raw_upload.py'],
            },
            'dataset.shorts.blind-private-video-fold': {
                label: 'Private labels with evaluated within-account fold excluded',
                population: 'Matched private Tyler/Hafu rows; deterministic five-fold assignment within each account',
                count: runtime.privateValidationPopulation.count,
                idSha256: runtime.privateValidationPopulation.idSha256,
                byAccount: runtime.privateValidationPopulation.byAccount,
                disclosure: 'Each score is fit on four folds and evaluated on the omitted fold; the registry count is the pre-split population.',
                sourceCode: ['buildings/jarvis/predictor-lab/run_predictor_lab.py:private_fold_oof'],
            },
            'dataset.shorts.blind-private-account': {
                label: 'Private labels with evaluated account excluded',
                population: 'Matched private rows from every account except the evaluated creator',
                count: runtime.privateValidationPopulation.count,
                idSha256: runtime.privateValidationPopulation.idSha256,
                byAccount: runtime.privateValidationPopulation.byAccount,
                disclosure: 'The selected row determines which complete account is omitted.',
                sourceCode: ['buildings/jarvis/predictor-lab/run_predictor_lab.py:private_inner_oof'],
            },
            'dataset.shorts.blind-public-excluded': {
                label: 'Creator-excluded public Shorts corpus',
                population: 'Public corpus after removing all private rows, saved-channel rows, and every video from both validation creators',
                count: runtime.blindPublicAxisPopulation.count,
                idSha256: runtime.blindPublicAxisPopulation.idSha256,
                excludedCount: runtime.blindPublicAxisPopulation.excludedCount,
                excludedIdSha256: runtime.blindPublicAxisPopulation.excludedIdSha256,
                validationCreatorChannelIds: runtime.blindPublicAxisPopulation.validationCreatorChannelIds,
                sourceCode: ['buildings/jarvis/predictor-lab/run_predictor_lab.py:fit_public_axes'],
            },
            'dataset.shorts.observed-joined': {
                label: 'Joined observed outcomes',
                population: 'Saved-channel rows that match a private/public outcome row by video ID',
                count: runtime.privateValidationPopulation.count,
                idSha256: runtime.privateValidationPopulation.idSha256,
                sourceCode: ['buildings/jarvis/saved-channel-validation.js:buildValidation'],
            },
            'dataset.shorts.legacy-mixed': {
                label: 'Legacy diagnostic populations',
                population: 'Historical model-specific populations; inspect the replacement coordinate for canonical use',
                count: null,
                idSha256: null,
                disclosure: 'Legacy diagnostics do not satisfy the new immutable lineage contract.',
                sourceCode: ['buildings/jarvis/saved-channel-validation.js'],
            },
            'dataset.long.private-channel': {
                label: 'Long-form private channel labels',
                population: 'Owned long-form videos with CTR and/or 30-second-retention labels',
                count: null,
                idSha256: null,
                sourceCode: ['add_steered_proj_long.py'],
            },
            'dataset.long.public-reference': {
                label: 'Long-form public reference corpus',
                population: 'Long-form title/thumbnail embedding corpus with public views and outlier labels',
                count: null,
                idSha256: null,
                sourceCode: ['add_steered_proj_long.py', 'longquant_score.py'],
            },
        },
        algorithms: {
            'algorithm.identity-observed': {
                label: 'Observed identity / named deterministic derivation',
                formula: 'Return the joined measurement, or the explicitly named arithmetic/curve transform.',
            },
            'algorithm.shorts.production-pls2-private': {
                label: 'Production private target rotation',
                formula: 'PLSRegression(n_components=2) fits the target-aligned plane; scalar = L2(embedding) dot coefficient + intercept.',
                rotation: 'Two-component PLS; the first displayed axis is sign-aligned with the private target.',
            },
            'algorithm.shorts.production-pls1-public': {
                label: 'Production public target direction',
                formula: 'PLSRegression(n_components=1); scalar = L2(embedding) dot coefficient + intercept.',
                rotation: 'One target-supervised latent direction.',
            },
            'algorithm.shorts.production-realviews': {
                label: 'Production channel-scale views equation',
                formula: '10 ** (b_keep * projected_keep + b_ret5 * projected_ret5 + b_duration * log10(duration + 1) + intercept) - 1.',
            },
            'algorithm.shorts.production-novelty': {
                label: 'Production target-calibrated novelty output',
                formula: 'Persisted worker output derived from global nearest-neighbor distance, centroid distance, recent-centroid distance, PCA reconstruction residual, and multimodal coherence as available.',
            },
            'algorithm.shorts.blind-ridge100': {
                label: 'Blind private target direction',
                formula: 'Ridge(alpha=100, solver=lsqr, tol=1e-4) on L2-normalized 1536D embeddings.',
                rotation: 'One scalar supervised ridge direction; video-fold or account exclusion is applied before fitting.',
            },
            'algorithm.shorts.blind-public-pls1': {
                label: 'Creator-excluded public target direction',
                formula: 'PLSRegression(n_components=1) on the creator-excluded public embedding corpus.',
                rotation: 'One target-supervised latent direction, rebuilt independently for visual, text, and together.',
            },
            'algorithm.shorts.blind-realviews-ridge1': {
                label: 'Blind channel-scale views equation',
                formula: 'Ridge(alpha=1) maps out-of-fold predicted keep, out-of-fold predicted ret5, and log10(duration + 1) to log10(views + 1).',
            },
            'algorithm.shorts.combined-nested-ridge': {
                label: 'Combined nine-axis forecast',
                formula: 'Standardized multi-target ridge over exactly nine creator-excluded public axes; lambda is selected inside each outer holdout from [0.01, 0.1, 1, 10, 100, 1000].',
            },
            'algorithm.shorts.legacy': {
                label: 'Legacy diagnostic algorithm',
                formula: 'Historical implementation retained only for audit comparison; never substituted for a canonical coordinate.',
            },
            'algorithm.long.private-pls2': {
                label: 'Long private target plane',
                formula: 'PLSRegression(n_components=2) fit to owned CTR or 30-second-retention labels, with rank-to-outcome calibration.',
            },
            'algorithm.long.public-neighbor': {
                label: 'Long reference-neighbor score',
                formula: 'Cosine-neighbor placement in the raw Long manifold; outcomes are weighted from the matching registered reference axis.',
            },
            'algorithm.long.ctrviews': {
                label: 'Long CTR + views direction',
                formula: 'Visual uses the frozen 30% CTR + 70% views direction and immutable percentile ladder; other stored origins disclose projection/neighbor provenance.',
            },
            'algorithm.long.realviews': {
                label: 'Long channel-scale views equation',
                formula: 'CTR, 30-second retention, and duration are mapped to channel-scale log views using the stored long projection equation.',
            },
        },
        calibrations: {
            'calibration.none': {
                label: 'No model calibration',
                formula: 'The value is measured or deterministically derived from measurements.',
            },
            'calibration.shorts.private-quantile': {
                label: 'Tyler private rank-to-outcome calibration',
                formula: 'Rank the scalar against production psort, then select the same quantile from sorted Tyler outcomes.',
            },
            'calibration.shorts.public-quantile': {
                label: 'Public rank-to-outcome calibration',
                formula: 'Rank the scalar against the public fitted-score distribution, then select the same quantile from sorted log outcome values.',
            },
            'calibration.shorts.public-local-rate': {
                label: 'Public local over-10M rate',
                formula: 'Mean observed over-10M label in a +/-5% rank neighborhood around the scalar.',
            },
            'calibration.shorts.persisted-novelty': {
                label: 'Persisted target-specific novelty calibration',
                formula: 'Read the target-calibrated novelty estimate saved by the worker; exact historical held-out reconstruction is unavailable.',
            },
            'calibration.shorts.fold-output': {
                label: 'Outer-fold output scale',
                formula: 'Fit and evaluate only within the named outer protocol; no test-fold outcome is used to calibrate its own score.',
            },
            'calibration.shorts.crossfit-reference': {
                label: 'Cross-fitted training reference',
                formula: 'Raw scores are ranked only against cross-fitted predictions from the training population.',
            },
            'calibration.legacy': {
                label: 'Legacy / model-specific',
                formula: 'See historical implementation; not canonical.',
            },
            'calibration.long.registered-output': {
                label: 'Long registered output scale',
                formula: 'Use the stored projection estimate, frozen percentile ladder, or weighted reference outcome identified by the score origin.',
            },
        },
        validationProtocols: {
            'validation.observed': {
                label: 'Observed measurement',
                rule: 'No predictive fit. This value is evaluation truth.',
            },
            'validation.stored-diagnostic': {
                label: 'Stored production diagnostic',
                rule: 'Exact persisted score; not blind evidence. Tyler keep/ret5 are in-sample and historical rows may lack immutable scorer revisions.',
            },
            'validation.video-fivefold': {
                label: 'Known-account video-fold holdout',
                rule: 'Five deterministic within-account hash folds; the entire evaluated fold is excluded from target-aligned fitting and calibration.',
            },
            'validation.account-holdout': {
                label: 'Whole-account holdout',
                rule: 'Every row from the evaluated account is excluded from target-aligned fitting, selection, and calibration.',
            },
            'validation.public-creators-excluded': {
                label: 'Public axes with validation creators excluded',
                rule: 'All private IDs, all saved-channel IDs, and all videos from Tyler and Hafu are removed before public target axes are fit.',
            },
            'validation.nested-video-fivefold': {
                label: 'Nested video-fold forecast',
                rule: 'Outer deterministic video folds estimate performance; ridge penalty selection occurs only inside each outer training fold.',
            },
            'validation.nested-account-holdout': {
                label: 'Nested account-transfer forecast',
                rule: 'The evaluated account is excluded from the outer fit and all inner model selection.',
            },
            'validation.legacy': {
                label: 'Legacy diagnostic',
                rule: 'Retained for traceability; does not satisfy the canonical blind contract.',
            },
            'validation.long-stored': {
                label: 'Long stored production output',
                rule: 'Historical output; exact origin must be read from its stored production/neighbor provenance when available.',
            },
        },
        artifacts: {
            'artifact.shorts.steer-models': {
                label: 'Shorts production steer model',
                location: 'R2 raw/steer_models.npz',
                revisionPath: 'row.inputManifest.steer_artifact_sha256',
                disclosure: 'New rows persist SHA-256. Older saved rows can be missing it and are visibly marked non-replayable.',
            },
            'artifact.shorts.novelty-models': {
                label: 'Shorts novelty models and indicator registry',
                location: 'R2 raw/novelty_models.npz + raw/indicators/weights.npz',
                revisionPath: 'row.inputManifest.scorer_revisions',
            },
            'artifact.shorts.blind-predictor': {
                label: 'Blind predictor artifact',
                location: 'R2 predictor-lab result consumed by saved-channel-validation.js',
                contractSha256: runtime.featureContractSha256,
                runtimeVersions: runtime.runtimeVersions,
            },
            'artifact.shorts.validation-runtime': {
                label: 'Saved-channel validation runtime',
                location: 'buildings/jarvis/saved-channel-validation.js',
                registryVersion: LEDGER_VERSION,
            },
            'artifact.shorts.legacy': {
                label: 'Legacy diagnostic state',
                location: 'Historical prediction fields in the saved validation artifact',
            },
            'artifact.long.projections': {
                label: 'Long projection and score artifacts',
                location: 'R2 raw-long maps + longform/thumb-rl/scorer_visual.npz',
            },
        },
        visualizations: {
            'visualization.none': {
                label: 'No embedding plane',
                rule: 'A scalar outcome or forecast may be charted against another registered coordinate, but it has no standalone embedding plane.',
            },
            'visualization.shorts.private-pls2-grid': {
                label: 'Private target-aligned PLS plane',
                rule: 'PLSRegression(n_components=2) transforms every normalized corpus embedding. The first component is sign-aligned to the private target. Each component is clipped to its 1st/99th percentiles and independently scaled to integer coordinates 0-1000.',
                sourceCode: ['add_steered_proj.py:steer_metric', 'add_steered_proj.py:grid'],
            },
            'visualization.shorts.public-pls2-grid': {
                label: 'Public target-aligned PLS plane',
                rule: 'The public views or outlier map uses a two-component PLS transform for x/y display, clipped at the 1st/99th percentiles and scaled independently to 0-1000. This 2D display fit is distinct from the persisted one-component scalar steer model.',
                sourceCode: ['raw_embed.py', 'add_steered_proj.py:grid'],
            },
            'visualization.shorts.gt10m-lda-pca-grid': {
                label: 'Over-10M class plane',
                rule: 'The class-aligned map combines a one-dimensional LDA class direction with the first PCA direction for the second display axis, then applies 1st/99th-percentile clipping and 0-1000 scaling. The scalar probability still comes from the registered PLS-rank local class rate.',
                sourceCode: ['raw_embed.py'],
            },
            'visualization.shorts.realviews-pls2-grid': {
                label: 'Channel-scale views PLS plane',
                rule: 'A two-component PLS display is fit from embeddings to the duration-aware channel-scale log-view equation, sign-aligned to that target, clipped at the 1st/99th percentiles, and scaled to 0-1000.',
                sourceCode: ['add_steered_proj.py'],
            },
            'visualization.shorts.novelty-score': {
                label: 'Novelty score without a target-specific 2D plane',
                rule: 'The persisted target-calibrated novelty scalar can be charted, but it must not be represented as a fourth raw Gemini embedding plane.',
                sourceCode: ['raw_upload.py'],
            },
            'visualization.shorts.score-cell': {
                label: 'Shorts scalar score cell',
                rule: 'The estimate and percentile are two displays of the same registered coordinate.',
            },
            'visualization.long.registered-map': {
                label: 'Long registered 2D map',
                rule: 'The displayed Long plane is an alternate visualization; inspect score origin before equating neighbor-derived and frozen direct projections.',
                sourceCode: ['add_steered_proj_long.py', 'longquant_score.py'],
            },
        },
        runtime,
    };
    // Stable aliases keep the machine contract readable to older consumers while
    // the UI uses the more explicit rawInputs / fitDatasets names.
    catalog.inputSets = catalog.rawInputs;
    catalog.datasets = catalog.fitDatasets;
    return catalog;
}

function buildCanonicalLineageCatalog(runtime) {
    const lineageContract = contract.lineageContract;
    if (!lineageContract || !lineageContract.registries) return buildLineageCatalog(runtime);
    const registries = lineageContract.registries;
    const clone = value => JSON.parse(JSON.stringify(value || {}));
    const inputSets = clone(registries.rawInputSets);
    const representations = clone(registries.representations);
    const datasets = clone(registries.fitDatasets);
    const algorithms = clone(registries.algorithms);
    const calibrations = clone(registries.calibrations);
    const artifacts = clone(registries.artifacts);
    const visualizations = clone(registries.visualizationMaps);
    const runtimeManifest = name => runtime.runtimeManifests
        && runtime.runtimeManifests[name] || null;
    const runtimeManifestValue = name => {
        const record = runtimeManifest(name);
        return record && record.value || null;
    };
    const shortsSteerRecord = runtimeManifest('shortsSteer');
    const shortsSteerManifest = runtimeManifestValue('shortsSteer');
    const humanize = id => String(id)
        .replace(/^(input|representation|dataset|algorithm|calibration|artifact|map)\./, '')
        .replace(/\.v\d+$/, '')
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, character => character.toUpperCase());
    const decorate = (registry, descriptionFields) => {
        for (const [id, entry] of Object.entries(registry)) {
            entry.label = entry.label || humanize(id);
            entry.description = entry.description || descriptionFields
                .map(field => entry[field])
                .find(value => typeof value === 'string' && value.trim()) || '';
        }
    };
    decorate(inputSets, ['construction', 'selectionRule']);
    decorate(representations, ['construction', 'scoringNormalization']);
    decorate(datasets, ['selectionRule', 'representationPopulation']);
    decorate(algorithms, ['scalarFormula', 'fit', 'mapFormula']);
    decorate(calibrations, ['formula', 'mapping']);
    decorate(artifacts, ['location', 'path', 'contains']);
    decorate(visualizations, ['coordinateRelationship']);
    datasets['dataset.shorts.creator-excluded-public.v1'].label = 'Shared creator-excluded public axis corpus';
    algorithms['algorithm.shorts.public-heldout-pls1-quantile.v1'].label = 'Creator-excluded public PLS + rank-to-outcome direction';
    algorithms['algorithm.shorts.public-heldout-pls1-binary.v1'].label = 'Creator-excluded public PLS + local 10M class-rate direction';
    calibrations['calibration.identity-target-units.v1'].label = 'No second calibration: algorithm already returns target units';
    const families = Object.fromEntries((lineageContract.coordinateFamilies || []).map(family => [
        family.id,
        {
            ...family,
            label: family.id,
            selectionRule: (
                datasets[family.fitDatasetId]
                || datasets[(family.fitDatasetIds || [])[0]]
                || {}
            ).selectionRule || 'No additional fit split beyond the registered family definition.',
        },
    ]));

    inputSets['input.runtime.shorts.nine-blind-axes.v1'] = {
        domain: 'shorts',
        kind: 'registered-coordinate-vector',
        members: [
            'shorts.{video|account}-heldout.{visual|text|together}.{views|outlier|gt10M}',
        ],
        construction: 'Exactly nine creator-excluded direct public coordinates, never private-label-aligned keep/ret5/realviews or stored novelty.',
        sourceCode: 'buildings/jarvis/saved-channel-validation.js',
    };
    for (const protocol of ['video', 'account']) {
        const inputId = `input.runtime.shorts.${protocol}-nine-public-axes.v1`;
        inputSets[inputId] = {
            domain: 'shorts',
            kind: 'registered-coordinate-vector',
            members: ['visual', 'text', 'together'].flatMap(modality => (
                ['views', 'outlier', 'gt10M'].map(target => (
                    `shorts.${protocol}-heldout.${modality}.${target}`
                ))
            )),
            construction: `Exactly nine concrete ${protocol}-view ledger references. The video/account public-axis members point to the same nine underlying fitted axes, but the concrete IDs preserve which evaluation view fed this forecast.`,
            sourceCode: 'buildings/jarvis/saved-channel-validation.js:STRICT_FORECAST_RAW_FEATURES',
        };
    }
    representations['representation.runtime.shorts.novelty-primitives.v1'] = {
        domain: 'shorts',
        kind: 'derived embedding representation',
        queryRepresentationIds: [
            'representation.shorts.visual.gemini1536.v1',
            'representation.shorts.text.live-gemini1536.v1',
            'representation.shorts.together.live-gemini1536.v1',
        ],
        referenceRepresentationIds: [
            'representation.shorts.visual.gemini1536.v1',
            'representation.shorts.text.gemini1536.v1',
            'representation.shorts.together.gemini1536.v1',
        ],
        construction: 'Derive query primitives from the live visual/text/together embeddings, but compare neighbor, centroid, temporal, and PCA terms against corpus embeddings built by raw_embed.py. The live text path may use Gemini transcription fallback; the corpus text path does not.',
    };
    representations['representation.runtime.shorts.nine-axis-vector.v1'] = {
        domain: 'shorts',
        kind: 'combined registered-coordinate representation',
        dimensions: 9,
        construction: 'For each outer training fold, subtract each coordinate mean and divide by its training standard deviation. A missing coordinate is encoded as standardized zero, which is exactly training-mean imputation.',
    };
    for (const protocol of ['video', 'account']) {
        representations[`representation.runtime.shorts.${protocol}-nine-axis-vector.v1`] = {
            domain: 'shorts',
            kind: 'combined registered-coordinate representation',
            dimensions: 9,
            rawInputSetIds: [`input.runtime.shorts.${protocol}-nine-public-axes.v1`],
            construction: `Read the nine concrete ${protocol}-view public coordinates. Within each outer forecast fold, standardize with training-only means and standard deviations; encode missing coordinates as standardized zero (training-mean imputation).`,
        };
    }
    representations['representation.runtime.shorts.three-public-view-axes.v1'] = {
        domain: 'shorts',
        kind: 'derived registered-coordinate representation',
        dimensions: 3,
        rawInputSetIds: ['input.shorts.public-view-axis-trio.v1'],
        construction: 'Read the visual, text, and together shared creator-excluded public log-view coordinates without refitting them.',
    };
    datasets['dataset.runtime.shorts.observed-joined.v1'] = {
        domain: 'shorts',
        role: 'evaluation truth',
        selectionRule: 'Join saved-channel and private/public outcome snapshots by exact video ID.',
        rowCount: runtime.joinedEvaluationPopulation.count,
        videoIdHash: runtime.joinedEvaluationPopulation.idSha256,
        byAccount: runtime.joinedEvaluationPopulation.byAccount,
    };
    datasets['dataset.runtime.shorts.legacy.v1'] = {
        domain: 'shorts',
        role: 'legacy diagnostic',
        selectionRule: 'Historical mixed populations; canonical use is prohibited.',
        runtimeProvenanceRequired: ['historicalModelRevision'],
    };
    const privateRuntime = {
        rowCount: runtime.privateBlindArtifactPopulation.count,
        videoIdHash: runtime.privateBlindArtifactPopulation.idSha256,
        byAccount: runtime.privateBlindArtifactPopulation.byAccount,
        videoFolds: runtime.privateBlindArtifactPopulation.videoFolds,
        accountHoldouts: runtime.privateBlindArtifactPopulation.accountHoldouts,
        artifactRevision: runtime.predictorArtifact.artifactSha256,
        source: 'predictor.targets.keep.blindInputs.rows',
    };
    for (const id of [
        'dataset.shorts.private-blind-population.v1',
        'dataset.shorts.video-heldout-private.v1',
        'dataset.shorts.account-heldout-private.v1',
    ]) {
        if (datasets[id]) datasets[id].runtimeSnapshot = privateRuntime;
    }
    const joinedForecastRuntime = {
        baseRowCount: runtime.joinedEvaluationPopulation.count,
        baseVideoIdHash: runtime.joinedEvaluationPopulation.idSha256,
        byAccount: runtime.joinedEvaluationPopulation.byAccount,
        source: 'Exact-ID joined rows materialized by buildValidation()',
        bundles: {
            scalar: ['keep', 'ret5', 'averageRetention', 'logViews', 'logOutlier', 'hit10M'],
            checkpoints: ['survival5', 'survival10', 'survival20', 'drop5', 'drop10', 'drop20'],
            curve: Array.from({ length: 20 }, (_, index) => `second${index + 1}`),
        },
    };
    for (const [id, protocol] of [
        ['dataset.shorts.video-forecast-folds.v1', 'video'],
        ['dataset.shorts.account-forecast-folds.v1', 'account'],
    ]) {
        if (datasets[id]) {
            datasets[id].runtimeSnapshot = {
                ...joinedForecastRuntime,
                protocol,
                materializedEligibility: runtime.forecastModel
                    && runtime.forecastModel.protocols
                    && runtime.forecastModel.protocols[protocol] || null,
                artifactRevision: runtime.validationArtifact.sourceFingerprint,
            };
        }
    }
    const publicRuntime = {
        candidateUnionRowCount: runtime.blindPublicAxisPopulation.candidateUnionCount,
        candidateUnionVideoIdHash: runtime.blindPublicAxisPopulation.candidateUnionIdSha256,
        modalityTargetPopulations: runtime.blindPublicAxisPopulation.modalityTargetPopulations,
        exactFitPopulationsPersisted: runtime.blindPublicAxisPopulation.exactFitPopulationsPersisted,
        disclosure: runtime.blindPublicAxisPopulation.disclosure,
        excludedVideoCount: runtime.blindPublicAxisPopulation.excludedCount,
        excludedVideoIdHash: runtime.blindPublicAxisPopulation.excludedIdSha256,
        validationCreatorChannelIds: runtime.blindPublicAxisPopulation.validationCreatorChannelIds,
        rawStoreShapes: runtime.embeddingStores,
        artifactRevision: runtime.predictorArtifact.artifactSha256,
    };
    if (datasets['dataset.shorts.creator-excluded-public.v1']) {
        datasets['dataset.shorts.creator-excluded-public.v1'].runtimeSnapshot = publicRuntime;
    }
    if (datasets['dataset.shorts.tyler-private-retention.v1']) {
        const modalityTargetPopulations = {};
        for (const modality of ['visual', 'text', 'together']) {
            const axes = shortsSteerManifest && shortsSteerManifest.modalities
                && shortsSteerManifest.modalities[modality]
                && shortsSteerManifest.modalities[modality].axes || {};
            modalityTargetPopulations[modality] = {
                keep: axes.keep && axes.keep.fitPopulation || null,
                ret5: axes.ret5 && axes.ret5.fitPopulation || null,
            };
        }
        datasets['dataset.shorts.tyler-private-retention.v1'].runtimeSnapshot = shortsSteerManifest ? {
            modalityTargetPopulations,
            viewEquationFitPopulations: shortsSteerManifest.viewEquationFitPopulations || null,
            labelSnapshotRevision: shortsSteerManifest.sourceRevisions
                && shortsSteerManifest.sourceRevisions.tyler
                && shortsSteerManifest.sourceRevisions.tyler.sha256 || null,
            artifactRevision: shortsSteerManifest.artifactSha256 || null,
            manifestRevision: shortsSteerRecord && shortsSteerRecord.artifactSha256 || null,
            disclosure: 'Exact fit populations are target- and modality-specific; no single hard-coded row count is substituted for them.',
        } : {
            modalityTargetPopulations: null,
            viewEquationFitPopulations: null,
            labelSnapshotRevision: null,
            artifactRevision: null,
            status: 'unknown in historical artifact',
            disclosure: 'The current score artifact predates an exact fit manifest. No row count or ID hash is inferred.',
        };
    }
    if (datasets['dataset.shorts.public-corpus.v1']) {
        const modalityTargetPopulations = {};
        for (const modality of ['visual', 'text', 'together']) {
            const axes = shortsSteerManifest && shortsSteerManifest.modalities
                && shortsSteerManifest.modalities[modality]
                && shortsSteerManifest.modalities[modality].axes || {};
            modalityTargetPopulations[modality] = Object.fromEntries(
                ['views', 'outlier', 'gt10M'].map(target => [
                    target,
                    axes[target] && axes[target].fitPopulation || null,
                ])
            );
        }
        datasets['dataset.shorts.public-corpus.v1'].runtimeSnapshot = shortsSteerManifest ? {
            modalityTargetPopulations,
            outcomeSnapshotRevision: shortsSteerManifest.sourceRevisions
                && shortsSteerManifest.sourceRevisions.public_library
                && shortsSteerManifest.sourceRevisions.public_library.sha256 || null,
            artifactRevision: shortsSteerManifest.artifactSha256 || null,
            disclosure: 'Exact public scalar-fit populations are persisted separately by modality and target.',
        } : {
            modalityTargetPopulations: null,
            outcomeSnapshotRevision: null,
            artifactRevision: null,
            status: 'unknown in historical artifact',
            disclosure: 'The historical production steer artifact did not persist exact public scalar-fit populations.',
        };
    }
    if (datasets['dataset.shorts.map-manifold.v1']) {
        const modalityPopulations = {};
        for (const modality of ['visual', 'text', 'together']) {
            const manifest = runtimeManifestValue(`shorts${modality[0].toUpperCase()}${modality.slice(1)}Map`);
            modalityPopulations[modality] = manifest ? {
                rowCount: manifest.publishedMap && manifest.publishedMap.rowCount,
                uniqueVideoCount: manifest.publishedMap && manifest.publishedMap.uniqueVideoCount,
                videoIdHash: manifest.publishedMap && manifest.publishedMap.videoIdSha256,
                mapRevision: manifest.publishedMap && manifest.publishedMap.artifactSha256,
                mapArchiveKey: manifest.publishedMap && manifest.publishedMap.archiveKey,
                plotRevision: manifest.publishedPlot && manifest.publishedPlot.artifactSha256,
                embeddingRevision: manifest.embeddingStore && manifest.embeddingStore.artifactSha256,
            } : null;
        }
        datasets['dataset.shorts.map-manifold.v1'].runtimeSnapshot = {
            modalityPopulations,
            exact: Object.values(modalityPopulations).every(Boolean),
            disclosure: Object.values(modalityPopulations).every(Boolean)
                ? 'Each modality identifies its final published map, plot, aligned embedding archive, row count, and sorted-ID hash.'
                : 'At least one map predates the immutable final-map manifest; absent revisions remain unknown.',
        };
    }
    if (datasets['dataset.shorts.novelty-reference.v1']) {
        const noveltyModels = runtimeManifest('noveltyModels');
        datasets['dataset.shorts.novelty-reference.v1'].runtimeSnapshot = noveltyModels ? {
            artifactRevision: noveltyModels.artifactSha256,
            artifactKey: noveltyModels.key,
            artifactBytes: noveltyModels.bytes,
            rowCount: null,
            videoIdHash: null,
            disclosure: 'The novelty-model byte revision is exact. Its historical reference-row ID hash was not persisted and remains unknown.',
        } : {
            artifactRevision: null,
            rowCount: null,
            videoIdHash: null,
            status: 'unknown in historical artifact',
        };
    }
    if (datasets['dataset.shorts.novelty-indicator-calibration.v1']) {
        const indicatorRecord = runtimeManifest('indicatorRegistry');
        const registryValue = runtimeManifestValue('indicatorRegistry');
        const indicators = Array.isArray(registryValue && registryValue.indicators)
            ? registryValue.indicators : [];
        const candidateIndicatorKeysByTarget = Object.fromEntries(
            ['keep', 'ret5', 'views'].map(target => [
                target,
                indicators
                    .filter(indicator => String(indicator && indicator.target || '') === target)
                    .map(indicator => String(indicator.name || indicator.key || ''))
                    .filter(Boolean)
                    .sort(),
            ])
        );
        const calibrationPointCountsByIndicator = Object.fromEntries(
            indicators
                .map(indicator => [
                    String(indicator && (indicator.name || indicator.key) || ''),
                    Array.isArray(indicator && indicator.pts) ? indicator.pts.length : 0,
                ])
                .filter(([key]) => key)
        );
        datasets['dataset.shorts.novelty-indicator-calibration.v1'].runtimeSnapshot = indicatorRecord ? {
            registryRevision: indicatorRecord.artifactSha256,
            registryKey: indicatorRecord.key,
            indicatorCount: indicators.length,
            candidateIndicatorKeysByTarget,
            calibrationPointCountsByIndicator,
            calibrationPopulationHash: null,
            disclosure: 'The registry bytes fix every candidate and calibration array. New rows additionally pin the exact selected key and calibration metadata because primitive availability is query-dependent.',
        } : {
            registryRevision: null,
            candidateIndicatorKeysByTarget: null,
            calibrationPointCountsByIndicator: null,
            calibrationPopulationHash: null,
            status: 'unknown in historical artifact',
        };
    }
    const longMapRecords = Object.fromEntries(
        ['visual', 'text', 'together'].map(modality => [
            modality,
            runtimeManifest(`long${modality[0].toUpperCase()}${modality.slice(1)}Map`),
        ])
    );
    const longMapValues = Object.fromEntries(
        Object.entries(longMapRecords).map(([modality, record]) => [
            modality,
            record && record.value || null,
        ])
    );
    const normalizePopulation = population => {
        if (!population || typeof population !== 'object') return null;
        return {
            rowCount: population.rowCount != null ? population.rowCount : population.row_count,
            uniqueVideoCount: population.uniqueVideoCount != null
                ? population.uniqueVideoCount
                : population.unique_video_id_count,
            duplicateVideoCount: population.duplicateVideoCount != null
                ? population.duplicateVideoCount
                : population.duplicate_video_id_count,
            videoIdSha256: population.videoIdSha256 || population.video_id_sha256 || null,
        };
    };
    const longModalityPopulations = Object.fromEntries(
        Object.entries(longMapValues).map(([modality, manifest]) => {
            const alignment = manifest && (
                manifest.video_id_alignment_population
                || manifest.videoIdAlignmentPopulation
            );
            const intersection = alignment && alignment.intersection;
            const embedding = manifest && (manifest.embedding_archive || manifest.embeddingArchive);
            const mapArtifact = manifest && (manifest.map_artifact || manifest.mapArtifact);
            const plotArtifact = manifest && (manifest.plot_artifact || manifest.plotArtifact);
            const record = longMapRecords[modality];
            return [modality, manifest && intersection ? {
                ...normalizePopulation(intersection),
                mapRevision: mapArtifact && (mapArtifact.sha256 || mapArtifact.artifactSha256),
                mapArchiveKey: mapArtifact && (mapArtifact.immutable_key || mapArtifact.archiveKey),
                plotRevision: plotArtifact && (plotArtifact.sha256 || plotArtifact.artifactSha256),
                embeddingRevision: embedding && (embedding.sha256 || embedding.artifactSha256),
                embeddingArchiveKey: embedding && (embedding.immutable_key || embedding.archiveKey),
                manifestRevision: record && record.artifactSha256,
                manifestArchiveKey: manifest.immutable_manifest_key || manifest.immutableManifestKey,
                alignmentMethod: alignment.method,
            } : null];
        })
    );
    if (datasets['dataset.long.raw-manifold.v1']) {
        datasets['dataset.long.raw-manifold.v1'].runtimeSnapshot = {
            modalityPopulations: longModalityPopulations,
            disclosure: Object.values(longModalityPopulations).every(Boolean)
                ? 'Every Long modality identifies the exact map/archive intersection, final map bytes, embedding bytes, immutable keys, and manifest revision.'
                : 'At least one Long modality predates the immutable map/archive manifest and remains unknown.',
        };
    }
    const populationTree = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        if ((value.rowCount != null || value.row_count != null)
            && (value.videoIdSha256 || value.video_id_sha256)) {
            return value;
        }
        const nested = Object.fromEntries(
            Object.entries(value)
                .map(([key, child]) => [key, populationTree(child)])
                .filter(([, child]) => child)
        );
        return Object.keys(nested).length ? nested : null;
    };
    const longPrivateMetricPopulations = Object.fromEntries(
        Object.entries(longMapValues).map(([modality, manifest]) => [
            modality,
            populationTree(manifest && (
                manifest.account_metric_private_fit_populations
                || manifest.accountMetricPrivateFitPopulations
                || manifest.account_metric_populations
                || manifest.accountMetricPopulations
                || manifest.private_fit_populations
                || manifest.privateFitPopulations
            )),
        ])
    );
    const longSteerRecord = runtimeManifest('longSteer');
    const longSteerManifest = runtimeManifestValue('longSteer');
    const longLabelSnapshotRevisions = (
        longSteerManifest
        && (longSteerManifest.label_snapshot_revisions || longSteerManifest.labelSnapshotRevisions)
    ) || Object.values(longMapValues).map(manifest => (
        manifest && (manifest.label_snapshot_revisions || manifest.labelSnapshotRevisions)
    )).find(Boolean) || null;
    const longMapManifestRevisions = Object.values(longMapRecords)
        .map(record => record && record.artifactSha256)
        .filter(Boolean)
        .sort();
    const longProjectionRevision = longMapManifestRevisions.length
        ? crypto.createHash('sha256').update(longMapManifestRevisions.join('\n')).digest('hex')
        : null;
    if (datasets['dataset.long.tyler-private-performance.v1']) {
        datasets['dataset.long.tyler-private-performance.v1'].runtimeSnapshot = {
            baseAccountId: 'tyler',
            accountMetricPopulations: longPrivateMetricPopulations,
            labelSnapshotRevisions: longLabelSnapshotRevisions,
            artifactRevision: longProjectionRevision,
            disclosure: 'Populations are persisted independently by modality, account, and private target. The base aliases use Tyler; no global row count is substituted.',
        };
    }
    const longVisualScorerRecord = runtimeManifest('longVisualScorer');
    const longVisualScorer = runtimeManifestValue('longVisualScorer');
    const longFrozenPopulations = longVisualScorer && longVisualScorer.populations || {};
    if (datasets['dataset.long.visual-ctr-private.v1']) {
        const population = longFrozenPopulations.privateCtrFit;
        datasets['dataset.long.visual-ctr-private.v1'].runtimeSnapshot = {
            ctrRowCount: population && population.rowCount,
            ctrVideoIdHash: population && population.videoIdSha256,
            artifactRevision: longVisualScorer && longVisualScorer.artifactSha256,
            labelSourceRevisions: longVisualScorer && longVisualScorer.sourceRevisions,
        };
    }
    if (datasets['dataset.long.curated-visual-views.v1']) {
        const population = longFrozenPopulations.curatedViewsFit;
        datasets['dataset.long.curated-visual-views.v1'].runtimeSnapshot = {
            curatedRowCount: population && population.rowCount,
            curatedVideoIdHash: population && population.videoIdSha256,
            artifactRevision: longVisualScorer && longVisualScorer.artifactSha256,
            curatedSourceRevision: longVisualScorer
                && longVisualScorer.sourceRevisions
                && longVisualScorer.sourceRevisions.curatedIds,
        };
    }
    artifacts['artifact.runtime.shorts.blind-predictor.v1'] = {
        domain: 'shorts',
        location: 'predictor-lab artifact consumed by saved-channel-validation.js',
        artifactSha256: runtime.predictorArtifact.artifactSha256,
        archiveKey: runtime.predictorArtifact.archiveKey,
        manifestKey: runtime.predictorArtifact.manifestKey,
        manifestSha256: runtime.predictorArtifact.manifestSha256,
        generatedAt: runtime.predictorArtifact.generatedAt,
        producerSourceSha256: runtime.predictorArtifact.producerSourceSha256,
        sourceArtifacts: runtime.predictorArtifact.sourceArtifacts,
        scoredWithContractVersion: runtime.artifactFeatureContractVersion,
        scoredWithContractSha256: runtime.artifactFeatureContractSha256,
        displayedLineageContractVersion: runtime.currentFeatureContractVersion,
        displayedLineageContractSha256: runtime.currentFeatureContractSha256,
        contractAlignment: runtime.artifactFeatureContractSha256
            ? (runtime.artifactFeatureContractSha256 === runtime.currentFeatureContractSha256
                ? 'exact feature-contract file hash match'
                : 'different revisions; algorithm lineage is source-audited, but the historical score artifact remains pinned to its recorded contract')
            : 'unknown; artifact did not record a feature-contract hash',
        runtimeVersions: runtime.runtimeVersions,
        embeddingStores: runtime.embeddingStores,
        runtimeRevisionRequired: true,
        runtimeRevisionRequiredFields: [
            'artifactSha256',
            'manifestSha256',
            'producerSourceSha256',
        ],
        runtimeRevision: {
            artifactSha256: runtime.predictorArtifact.artifactSha256,
            archiveKey: runtime.predictorArtifact.archiveKey,
            manifestSha256: runtime.predictorArtifact.manifestSha256,
            producerSourceSha256: runtime.predictorArtifact.producerSourceSha256,
            sourceArtifacts: runtime.predictorArtifact.sourceArtifacts,
        },
    };
    artifacts['artifact.runtime.saved-channel-validation.v2'] = {
        domain: 'shorts',
        location: 'buildings/jarvis/saved-channel-validation.js',
        coordinateRegistryVersion: LEDGER_VERSION,
        artifactRevision: runtime.validationArtifact.sourceFingerprint,
        generatedAt: runtime.validationArtifact.generatedAt,
        producerSourceSha256: runtime.validationArtifact.producerSourceSha256,
        revisionMeaning: 'SHA-256 over every source artifact consumed by buildSavedChannelValidationBuffer(), including predictor, manifests, private tables, saved-channel manifests, contract, and this producer source.',
        runtimeRevisionRequired: true,
        runtimeRevisionRequiredFields: [
            'artifactRevision',
            'producerSourceSha256',
        ],
        runtimeRevision: {
            artifactRevision: runtime.validationArtifact.sourceFingerprint,
            producerSourceSha256: runtime.validationArtifact.producerSourceSha256,
        },
    };
    for (const modality of ['visual', 'text', 'together']) {
        const manifestRecord = runtimeManifest(`shorts${modality[0].toUpperCase()}${modality.slice(1)}Map`);
        const manifest = manifestRecord && manifestRecord.value;
        const artifactId = `artifact.shorts.embeddings.${modality}.v1`;
        if (!artifacts[artifactId]) continue;
        artifacts[artifactId].runtimeRevision = manifest ? {
            artifactSha256: manifest.embeddingStore && manifest.embeddingStore.artifactSha256,
            sourceKey: manifest.embeddingStore && manifest.embeddingStore.source,
            rowCount: manifest.embeddingStore && manifest.embeddingStore.rowCount,
            videoIdSha256: manifest.embeddingStore && manifest.embeddingStore.videoIdSha256,
            manifestSha256: manifestRecord.artifactSha256,
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.shorts.steer-models.v1']) {
        artifacts['artifact.shorts.steer-models.v1'].runtimeRevision = shortsSteerManifest ? {
            artifactSha256: shortsSteerManifest.artifactSha256 || null,
            archiveKey: shortsSteerManifest.archiveKey || null,
            manifestSha256: shortsSteerRecord && shortsSteerRecord.artifactSha256 || null,
            generatedAt: shortsSteerManifest.generatedAt || null,
            producerSourceSha256: shortsSteerManifest.producerSourceSha256 || null,
            runtime: shortsSteerManifest.runtime || null,
        } : {
            status: 'unknown in historical artifact',
        };
    }
    if (artifacts['artifact.shorts.maps.v1']) {
        artifacts['artifact.shorts.maps.v1'].runtimeRevision = Object.fromEntries(
            ['visual', 'text', 'together'].map(modality => {
                const record = runtimeManifest(`shorts${modality[0].toUpperCase()}${modality.slice(1)}Map`);
                const value = record && record.value;
                return [modality, value ? {
                    manifestSha256: record.artifactSha256,
                    mapSha256: value.publishedMap && value.publishedMap.artifactSha256,
                    mapArchiveKey: value.publishedMap && value.publishedMap.archiveKey,
                    plotSha256: value.publishedPlot && value.publishedPlot.artifactSha256,
                    embeddingSha256: value.embeddingStore && value.embeddingStore.artifactSha256,
                    producerSourceSha256: value.producerSourceSha256,
                } : { status: 'unknown in historical artifact' }];
            })
        );
    }
    if (artifacts['artifact.shorts.novelty-models.v1']) {
        const noveltyModels = runtimeManifest('noveltyModels');
        artifacts['artifact.shorts.novelty-models.v1'].runtimeRevision = noveltyModels ? {
            artifactSha256: noveltyModels.artifactSha256,
            artifactKey: noveltyModels.key,
            bytes: noveltyModels.bytes,
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.shorts.indicator-registry.v1']) {
        const indicatorRecord = runtimeManifest('indicatorRegistry');
        const weightsRecord = runtimeManifest('indicatorWeights');
        artifacts['artifact.shorts.indicator-registry.v1'].runtimeRevision = indicatorRecord ? {
            registrySha256: indicatorRecord.artifactSha256,
            registryKey: indicatorRecord.key,
            weightsSha256: weightsRecord && weightsRecord.artifactSha256,
            weightsKey: weightsRecord && weightsRecord.key,
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.shorts.live-score-runtime.v1']) {
        const scorer = runtimeManifest('shortsLiveScoreSource');
        const worker = runtimeManifest('shortsChannelWorkerSource');
        artifacts['artifact.shorts.live-score-runtime.v1'].runtimeRevision = scorer ? {
            scorerSourceSha256: scorer.artifactSha256,
            scorerSourceKey: scorer.key,
            savedChannelWorkerSourceSha256: worker && worker.artifactSha256,
            savedChannelWorkerSourceKey: worker && worker.key,
            rowRevisionPath: 'row.inputManifest.scorer_revisions',
            rowInputFingerprintPath: 'row.inputManifest.input_fingerprint',
        } : { status: 'unknown in historical artifact' };
    }
    for (const modality of ['visual', 'text', 'together']) {
        const manifestRecord = longMapRecords[modality];
        const manifest = longMapValues[modality];
        const embedding = manifest && (manifest.embedding_archive || manifest.embeddingArchive);
        const artifactId = `artifact.long.embeddings.${modality}.v1`;
        if (!artifacts[artifactId]) continue;
        artifacts[artifactId].runtimeRevision = embedding ? {
            artifactSha256: embedding.sha256 || embedding.artifactSha256,
            archiveKey: embedding.immutable_key || embedding.archiveKey,
            sourceKey: embedding.mutable_key || embedding.source,
            population: normalizePopulation(embedding.video_id_population || embedding.videoIdPopulation),
            manifestSha256: manifestRecord && manifestRecord.artifactSha256,
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.long.maps.v1']) {
        artifacts['artifact.long.maps.v1'].runtimeRevision = Object.fromEntries(
            Object.entries(longMapValues).map(([modality, manifest]) => {
                const record = longMapRecords[modality];
                const mapArtifact = manifest && (manifest.map_artifact || manifest.mapArtifact);
                const plotArtifact = manifest && (manifest.plot_artifact || manifest.plotArtifact);
                return [modality, mapArtifact ? {
                    mapSha256: mapArtifact.sha256 || mapArtifact.artifactSha256,
                    mapArchiveKey: mapArtifact.immutable_key || mapArtifact.archiveKey,
                    plotSha256: plotArtifact && (plotArtifact.sha256 || plotArtifact.artifactSha256),
                    plotArchiveKey: plotArtifact && (plotArtifact.immutable_key || plotArtifact.archiveKey),
                    manifestSha256: record && record.artifactSha256,
                    manifestArchiveKey: manifest.immutable_manifest_key || manifest.immutableManifestKey,
                    generatorSourceSha256: manifest.algorithm_generation
                        && manifest.algorithm_generation.generator_source_sha256,
                } : { status: 'unknown in historical artifact' }];
            })
        );
    }
    if (artifacts['artifact.long.steer-models.v1']) {
        const modelArtifact = longSteerManifest
            && (longSteerManifest.model_artifact || longSteerManifest.modelArtifact);
        artifacts['artifact.long.steer-models.v1'].runtimeRevision = modelArtifact ? {
            artifactSha256: modelArtifact.sha256 || modelArtifact.artifactSha256,
            archiveKey: modelArtifact.immutable_key || modelArtifact.archiveKey,
            manifestSha256: longSteerRecord && longSteerRecord.artifactSha256,
            manifestArchiveKey: longSteerManifest.immutable_manifest_key
                || longSteerManifest.immutableManifestKey,
            producerSourceSha256: longSteerManifest.generator_source_sha256
                || longSteerManifest.producerSourceSha256,
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.long.live-score-runtime.v1']) {
        const source = runtimeManifest('longScoreSource');
        artifacts['artifact.long.live-score-runtime.v1'].runtimeRevision = source ? {
            scorerSourceSha256: source.artifactSha256,
            scorerSourceKey: source.key,
            queryFingerprintGeneration: 'longquant-query-input-v1',
            rowRevisionPath: 'score.input_manifest',
        } : { status: 'unknown in historical artifact' };
    }
    if (artifacts['artifact.long.visual-ctrviews-ladder.v1']) {
        const longVisualRecord = runtimeManifest('longVisualScorer');
        const longVisualManifest = runtimeManifestValue('longVisualScorer');
        artifacts['artifact.long.visual-ctrviews-ladder.v1'].runtimeRevision = longVisualManifest ? {
            artifactSha256: longVisualManifest.artifactSha256,
            archiveKey: longVisualManifest.archiveKey,
            manifestSha256: longVisualRecord && longVisualRecord.artifactSha256,
            generatedAt: longVisualManifest.generatedAt,
            producerSourceSha256: longVisualManifest.producerSourceSha256,
            runtime: longVisualManifest.runtime,
        } : { status: 'unknown in historical artifact' };
    }
    artifacts['artifact.runtime.shorts.legacy.v1'] = {
        domain: 'shorts',
        location: 'Historical fields retained in the validation artifact',
        canonicalUse: false,
    };
    visualizations['map.runtime.none.v1'] = {
        domain: 'cross-domain',
        mapKey: null,
        coordinateRelationship: 'No standalone 2D embedding plane is registered for this scalar. Pairwise charts may use the scalar without creating a new coordinate.',
    };
    decorate(inputSets, ['construction', 'selectionRule']);
    decorate(representations, ['construction', 'scoringNormalization']);
    decorate(datasets, ['selectionRule', 'representationPopulation']);
    decorate(artifacts, ['location', 'path']);
    decorate(visualizations, ['coordinateRelationship']);
    return {
        schemaVersion: lineageContract.schemaVersion,
        contractId: lineageContract.contractId,
        identityRules: lineageContract.identityRules,
        inventorySemantics: lineageContract.inventorySemantics,
        inputSets,
        rawInputs: inputSets,
        representations,
        datasets,
        fitDatasets: datasets,
        algorithms,
        calibrations,
        artifacts,
        visualizations,
        validationProtocols: families,
        coordinateFamilies: clone(lineageContract.coordinateFamilies),
        runtime,
    };
}

function groupInputIds(group) {
    if (group === 'visual') return ['input.shorts.first5-montage.v1'];
    if (group === 'text') return ['input.shorts.first5-transcript.v1'];
    if (group === 'together') return ['input.shorts.first5-montage-transcript.v1'];
    return [
        'input.shorts.first5-montage.v1',
        'input.shorts.first5-transcript.v1',
        'input.shorts.first5-montage-transcript.v1',
    ];
}

function groupRepresentationId(group) {
    if (group === 'visual') return 'representation.shorts.visual.gemini1536.v1';
    if (group === 'text') return 'representation.shorts.text.gemini1536.v1';
    if (group === 'together') return 'representation.shorts.together.gemini1536.v1';
    return 'representation.runtime.shorts.novelty-primitives.v1';
}

function storedGroupInputIds(group) {
    if (group === 'text') return ['input.shorts.first5-live-transcript.v1'];
    if (group === 'together') return ['input.shorts.first5-live-montage-transcript.v1'];
    if (group === 'visual') return ['input.shorts.first5-montage.v1'];
    return [
        'input.shorts.first5-montage.v1',
        'input.shorts.first5-live-transcript.v1',
        'input.shorts.first5-live-montage-transcript.v1',
    ];
}

function storedGroupRepresentationId(group) {
    if (group === 'text') return 'representation.shorts.text.live-gemini1536.v1';
    if (group === 'together') return 'representation.shorts.together.live-gemini1536.v1';
    return groupRepresentationId(group);
}

function storedRepresentationStages(group) {
    const queryId = storedGroupRepresentationId(group);
    const fitId = groupRepresentationId(group);
    if (queryId === fitId || group === 'novelty') return [{ id: queryId, role: 'Query and fit representation.' }];
    return [
        {
            id: queryId,
            role: 'Live query representation used to score this uploaded or linked Short.',
        },
        {
            id: fitId,
            role: 'Corpus representation used to fit the stored axis. Its transcript comes from Whisper tiny without the live Gemini fallback.',
        },
    ];
}

function storedVisualizationId(definition) {
    if (definition.group === 'novelty') return 'map.runtime.none.v1';
    if (definition.target === 'keep' || definition.target === 'ret5') {
        return `map.shorts.${definition.target}.v1`;
    }
    if (definition.target === 'views' || definition.target === 'outlier') {
        return `map.shorts.${definition.target}.v1`;
    }
    if (definition.target === 'gt10M') return 'map.shorts.hi10m.v1';
    if (definition.target === 'realviews') return 'map.shorts.realviews.v1';
    return 'map.runtime.none.v1';
}

function storedFamilyId(definition) {
    if (definition.group === 'novelty') return 'family.shorts.stored.novelty.v1';
    if (definition.target === 'realviews') return 'family.shorts.stored.realviews.v1';
    if (definition.target === 'gt10M') return 'family.shorts.stored.10m-axis.v1';
    if (definition.target === 'keep' || definition.target === 'ret5') {
        return 'family.shorts.stored.private-axis.v1';
    }
    return 'family.shorts.stored.public-axis.v1';
}

function lineageForStored(definition) {
    const common = {
        rawInputIds: storedGroupInputIds(definition.group),
        representationId: storedGroupRepresentationId(definition.group),
        representation: storedRepresentationStages(definition.group),
        targetField: definition.target,
        validationProtocolId: storedFamilyId(definition),
        visualizationId: storedVisualizationId(definition),
        sourceCode: ['raw_upload.py:_run', 'raw_upload.py:_score_input_manifest'],
        usesEmbedding: true,
        reproducibility: {
            status: 'row-dependent',
            revisionPath: 'row.inputManifest',
            missingMeans: 'Historical score is still preserved, but it cannot be claimed as deterministic replay of the current artifact.',
        },
    };
    if (definition.group === 'novelty') {
        return {
            ...common,
            fitDatasetId: 'dataset.shorts.novelty-indicator-calibration.v1',
            fitDataset: [
                {
                    id: 'dataset.shorts.novelty-reference.v1',
                    role: 'Unsupervised neighbor, centroid, temporal, and PCA reference population.',
                },
                {
                    id: 'dataset.shorts.novelty-indicator-calibration.v1',
                    role: 'Supervised target selector, direction, and calibration-point population.',
                },
            ],
            algorithmId: 'algorithm.shorts.novelty.target-selector.v1',
            algorithm: [
                'algorithm.shorts.novelty.target-selector.v1',
                'algorithm.shorts.novelty.global-knn13.v1',
                'algorithm.shorts.novelty.niche-centroid.v1',
                'algorithm.shorts.novelty.temporal-centroid.v1',
                'algorithm.shorts.novelty.pca-residual.v1',
                'algorithm.shorts.novelty.cross-modal-coherence.v1',
                'algorithm.shorts.novelty.fusion-residual.v1',
            ],
            scalarProjection: 'The worker selects the strongest available target-matched novelty primitive, directionally rank-calibrates it, and persists the resulting target-unit value. It is not always global kNN13 and is not a fourth Gemini embedding.',
            calibrationId: 'calibration.shorts.novelty-target-worker.v1',
            artifactId: 'artifact.shorts.novelty-models.v1',
            artifact: [
                {
                    id: 'artifact.shorts.novelty-models.v1',
                    role: 'Centroids, recent centroid, and PCA reconstruction state.',
                },
                {
                    id: 'artifact.shorts.indicator-registry.v1',
                    role: 'Target labels, validation flags, selection strengths, signs, calibration points, and optional probe weights.',
                },
                {
                    id: 'artifact.shorts.embeddings.visual.v1',
                    role: 'Visual corpus used for global nearest-neighbor novelty.',
                },
                {
                    id: 'artifact.shorts.embeddings.text.v1',
                    role: 'Text corpus used for global nearest-neighbor novelty when speech is present.',
                },
                {
                    id: 'artifact.shorts.embeddings.together.v1',
                    role: 'Multimodal corpus used for global nearest-neighbor novelty.',
                },
                {
                    id: 'artifact.shorts.live-score-runtime.v1',
                    role: 'Exact scorer source and query-input fingerprint construction used for this persisted row.',
                },
            ],
            sourceCode: [
                ...common.sourceCode,
                'raw_upload.py:novelty primitives',
                'yt_relay_watcher.py:novelty_feature',
            ],
        };
    }
    if (definition.target === 'realviews') {
        return {
            ...common,
            rawInputIds: [...common.rawInputIds, 'input.shorts.duration.v1'],
            rawInputs: [
                ...common.rawInputIds.map(id => ({
                    id,
                    role: 'Query-time modality input used to produce this saved embedding.',
                })),
                {
                    id: 'input.shorts.duration.v1',
                    role: 'Query video duration used directly by the channel-scale view equation.',
                },
                {
                    id: 'input.shorts.private-outcomes.v1',
                    role: 'Upstream Tyler keep, ret5, duration, and views labels used to fit the two component scores and view equation.',
                },
            ],
            fitDatasetId: 'dataset.shorts.tyler-private-retention.v1',
            fitDataset: [{
                id: 'dataset.shorts.tyler-private-retention.v1',
                role: 'Fits the stored keep and ret5 PLS estimates and the duration-deconfounded view equation.',
            }],
            algorithmId: 'algorithm.shorts.realviews-equation.v1',
            algorithm: [
                {
                    id: 'algorithm.shorts.private-pls2-axis.v1',
                    role: 'Produces the stored keep and ret5 estimates for this modality.',
                },
                {
                    id: 'algorithm.shorts.realviews-equation.v1',
                    role: 'Combines keep, ret5, and query duration into channel-scale views.',
                },
            ],
            scalarProjection: 'Projected keep + projected ret5 + log10(full duration + 1) enter the Tyler channel-scale log-views equation.',
            calibrationId: 'calibration.identity-target-units.v1',
            calibration: [
                {
                    id: 'calibration.shorts.private-rank-to-outcome.v1',
                    role: 'Maps the keep and ret5 embedding projections into observed target units before the view equation.',
                },
                {
                    id: 'calibration.identity-target-units.v1',
                    role: 'The calibrated view equation already returns ordinary predicted views.',
                },
            ],
            artifactId: 'artifact.shorts.steer-models.v1',
            artifact: [
                {
                    id: 'artifact.shorts.steer-models.v1',
                    role: 'Target axes, calibration ladders, and the duration-aware realistic-views equation.',
                },
                {
                    id: 'artifact.shorts.live-score-runtime.v1',
                    role: 'Exact scorer source and query-input fingerprint construction used for this persisted row.',
                },
            ],
            sourceCode: [...common.sourceCode, 'raw_upload.py:PSCOPE'],
        };
    }
    const privateTarget = definition.target === 'keep' || definition.target === 'ret5';
    return {
        ...common,
        fitDatasetId: privateTarget
            ? 'dataset.shorts.tyler-private-retention.v1'
            : 'dataset.shorts.public-corpus.v1',
        algorithmId: privateTarget
            ? 'algorithm.shorts.private-pls2-axis.v1'
            : 'algorithm.shorts.public-pls1-axis.v1',
        scalarProjection: 'L2-normalized 1536D embedding dot the persisted target coefficient vector plus its intercept; rank is computed against persisted psort and quantile-mapped to the registered outcome distribution.',
        calibrationId: definition.target === 'gt10M'
            ? 'calibration.shorts.local-10m-rate.v1'
            : (privateTarget
                ? 'calibration.shorts.private-rank-to-outcome.v1'
                : 'calibration.shorts.public-rank-to-log-outcome.v1'),
        artifactId: 'artifact.shorts.steer-models.v1',
        artifact: [
            {
                id: 'artifact.shorts.steer-models.v1',
                role: 'Target coefficient, intercept, fitted-score ladder, and output calibration.',
            },
            {
                id: 'artifact.shorts.live-score-runtime.v1',
                role: 'Exact scorer source and query-input fingerprint construction used for this persisted row.',
            },
        ],
        sourceCode: [...common.sourceCode, 'raw_upload.py:steer'],
    };
}

function heldoutFamilyId(definition, protocol) {
    const prefix = protocol === 'video' ? 'video-heldout' : 'account-heldout';
    if (definition.target === 'realviews') return `family.shorts.${prefix}.realviews.v1`;
    if (definition.target === 'gt10M') return `family.shorts.${prefix}.10m-axis.v1`;
    if (definition.target === 'keep' || definition.target === 'ret5') {
        return `family.shorts.${prefix}.private-axis.v1`;
    }
    return `family.shorts.${prefix}.public-axis.v1`;
}

function lineageForHeldout(definition, protocol) {
    const privateTarget = definition.target === 'keep' || definition.target === 'ret5';
    const validationProtocolId = heldoutFamilyId(definition, protocol);
    if (definition.target === 'realviews') {
        const fitDatasetId = protocol === 'video'
            ? 'dataset.shorts.video-heldout-private.v1'
            : 'dataset.shorts.account-heldout-private.v1';
        return {
            rawInputIds: [...groupInputIds(definition.group), 'input.shorts.duration.v1'],
            rawInputs: [
                ...groupInputIds(definition.group).map(id => ({
                    id,
                    role: 'Query-time modality input used to create the held-out representation.',
                })),
                {
                    id: 'input.shorts.duration.v1',
                    role: 'Query video duration supplied to the held-out log-views model.',
                },
                {
                    id: 'input.shorts.private-outcomes.v1',
                    role: 'Training labels only; the evaluated outer fold or entire account is excluded.',
                },
            ],
            representationId: groupRepresentationId(definition.group),
            fitDatasetId,
            fitDataset: [{
                id: fitDatasetId,
                role: 'Fits held-out keep, ret5, and log-view stages without the evaluated outer population.',
            }],
            targetField: 'log10(views + 1)',
            algorithmId: 'algorithm.shorts.heldout-realviews-ridge.v1',
            algorithm: [
                {
                    id: 'algorithm.shorts.private-heldout-ridge.v1',
                    role: 'Creates outer-held-out keep and ret5 predictions with Ridge(alpha=100).',
                },
                {
                    id: 'algorithm.shorts.heldout-realviews-ridge.v1',
                    role: 'Fits Ridge(alpha=1) on those training-only component predictions plus log duration.',
                },
            ],
            scalarProjection: 'Out-of-fold Ridge-100 keep and ret5 predictions plus log10(duration + 1) enter a Ridge(alpha=1) log-views model.',
            calibrationId: 'calibration.inverse-log10-nonnegative.v1',
            validationProtocolId,
            artifactId: 'artifact.runtime.shorts.blind-predictor.v1',
            sourceCode: ['buildings/jarvis/predictor-lab/run_predictor_lab.py:private_raw_features'],
            visualizationId: 'map.runtime.none.v1',
            usesEmbedding: true,
            reproducibility: { status: 'blind-artifact-pinned' },
        };
    }
    const publicTargetKey = definition.target === 'gt10M' ? 'gt10M' : definition.target;
    const fitDatasetId = privateTarget
        ? (protocol === 'video'
            ? 'dataset.shorts.video-heldout-private.v1'
            : 'dataset.shorts.account-heldout-private.v1')
        : 'dataset.shorts.creator-excluded-public.v1';
    const publicAxis = !privateTarget;
    return {
        rawInputIds: groupInputIds(definition.group),
        representationId: groupRepresentationId(definition.group),
        fitDatasetId,
        fitDataset: [{
            id: fitDatasetId,
            role: publicAxis
                ? `Shared fit reused by both protocol views. Exact eligible population key: ${definition.group}.${publicTargetKey}; historical artifacts without that key are explicitly unknown.`
                : `Private ${protocol === 'video' ? 'within-account outer-fold' : 'whole-account'} fit from the artifact-persisted blind population.`,
        }],
        targetField: definition.target === 'views'
            ? 'log10(public lifetime views + 1)'
            : (definition.target === 'outlier'
                ? 'log10(public views/subscribers + 1)'
                : definition.target),
        algorithmId: privateTarget
            ? 'algorithm.shorts.private-heldout-ridge.v1'
            : (definition.target === 'gt10M'
                ? 'algorithm.shorts.public-heldout-pls1-binary.v1'
                : 'algorithm.shorts.public-heldout-pls1-quantile.v1'),
        scalarProjection: privateTarget
            ? 'L2-normalized 1536D embedding enters Ridge(alpha=100); the named outer holdout population is absent from fitting.'
            : (definition.target === 'gt10M'
                ? 'L2-normalized 1536D embedding enters a one-component public PLS axis rebuilt after all validation creators were excluded; the displayed probability is the local observed 10M rate near its fitted rank.'
                : 'L2-normalized 1536D embedding enters a one-component public PLS axis rebuilt after all validation creators were excluded; its fitted rank is quantile-mapped to the sorted public outcome distribution.'),
        calibrationId: definition.target === 'views' || definition.target === 'outlier'
            ? 'calibration.inverse-log10-nonnegative.v1'
            : 'calibration.identity-target-units.v1',
        validationProtocolId,
        artifactId: 'artifact.runtime.shorts.blind-predictor.v1',
        sourceCode: [
            privateTarget
                ? 'buildings/jarvis/predictor-lab/run_predictor_lab.py:private_raw_features'
                : 'buildings/jarvis/predictor-lab/run_predictor_lab.py:fit_public_axes',
        ],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        underlyingAxisId: publicAxis
            ? `axis.shorts.creator-excluded.${definition.group}.${publicTargetKey}`
            : `axis.shorts.${protocol}-heldout.${definition.group}.${definition.target}`,
        computationReuse: publicAxis
            ? 'The video-held-out and account-held-out ledger columns are aliases of this one fitted public axis; they do not trigger separate fits.'
            : 'This private target axis is fitted under the named exclusion protocol.',
        reproducibility: { status: 'blind-artifact-pinned' },
    };
}

function lineageForForecast(definition, protocol) {
    const viewsLike = definition.key === 'views' || definition.key === 'outlier';
    const swipe = definition.key === 'swipe';
    const binary = definition.key === 'hit10M';
    const checkpoint = /^(survival|drop)/.test(definition.key);
    const bundle = checkpoint ? 'retention checkpoints' : 'scalar outcomes';
    const calibrationId = viewsLike
        ? 'calibration.inverse-log10-nonnegative.v1'
        : (swipe
            ? 'calibration.one-minus-percent.v1'
            : (binary
                ? 'calibration.clamp-probability.v1'
                : 'calibration.identity-target-units.v1'));
    const targetField = definition.key === 'views'
        ? 'log10(current lifetime views + 1)'
        : (definition.key === 'outlier'
            ? 'log10(current views / subscribers + 1)'
            : (swipe ? 'keep' : definition.key));
    const axisInputId = `input.runtime.shorts.${protocol}-nine-public-axes.v1`;
    const axisRepresentationId = `representation.runtime.shorts.${protocol}-nine-axis-vector.v1`;
    return {
        rawInputIds: [axisInputId],
        representationId: axisRepresentationId,
        fitDatasetId: protocol === 'video'
            ? 'dataset.shorts.video-forecast-folds.v1'
            : 'dataset.shorts.account-forecast-folds.v1',
        fitDataset: [{
            id: protocol === 'video'
                ? 'dataset.shorts.video-forecast-folds.v1'
                : 'dataset.shorts.account-forecast-folds.v1',
            role: `Uses the ${bundle} complete-outcome bundle. Feature missingness is outer-training-mean imputed after standardization.`,
        }],
        targetField,
        algorithmId: 'algorithm.shorts.nested-multitarget-ridge.v1',
        scalarProjection: swipe
            ? 'Nine public axes -> nested Ridge prediction of keep percent -> 100 minus predicted keep.'
            : (viewsLike
                ? `Nine public axes -> nested Ridge prediction of ${targetField} -> inverse log10 display transform.`
                : (binary
                    ? 'Nine public axes -> nested continuous Ridge prediction of the binary over-10M label -> clamp to [0, 1].'
                    : `Nine public axes -> nested target-specific Ridge prediction of ${targetField}.`)),
        calibrationId,
        validationProtocolId: protocol === 'video'
            ? 'family.shorts.video-forecast.v1'
            : 'family.shorts.account-forecast.v1',
        artifactId: 'artifact.runtime.saved-channel-validation.v2',
        sourceCode: ['buildings/jarvis/saved-channel-validation.js:attachScore21Forecasts'],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        forecastBundle: checkpoint ? 'checkpoints' : 'scalar',
        reproducibility: { status: 'deterministic-from-blind-artifact' },
    };
}

function lineageForObserved(definition) {
    const curveOutcome = /^(survival|drop)/.test(definition.key);
    return {
        rawInputIds: [
            curveOutcome ? 'input.shorts.private-outcomes.v1' : (
                ['views', 'outlier', 'hit10M'].includes(definition.key)
                    ? 'input.shorts.public-outcomes.v1'
                    : 'input.shorts.private-outcomes.v1'
            ),
        ],
        representationId: null,
        fitDatasetId: 'dataset.runtime.shorts.observed-joined.v1',
        targetField: definition.key,
        algorithmId: 'algorithm.identity-observed.v1',
        scalarProjection: definition.derived || definition.transform || 'Identity: return the joined observed value.',
        calibrationId: 'calibration.identity-target-units.v1',
        validationProtocolId: 'family.shorts.observed.v1',
        artifactId: 'artifact.runtime.saved-channel-validation.v2',
        sourceCode: ['buildings/jarvis/saved-channel-validation.js:OUTCOME_DEFINITIONS'],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: false,
        reproducibility: { status: 'deterministic-from-observed-snapshot' },
    };
}

function lineageForLegacy(definition) {
    if (definition.key === 'views-public-axis-ensemble') {
        return {
            rawInputIds: ['input.shorts.public-view-axis-trio.v1'],
            representationId: 'representation.runtime.shorts.three-public-view-axes.v1',
            fitDatasetId: 'dataset.shorts.creator-excluded-public.v1',
            targetField: 'log10(public lifetime views + 1)',
            algorithmId: 'algorithm.shorts.legacy-public-axis-ensemble.v1',
            scalarProjection: 'Average the visual, text, and together creator-excluded log-view axes to one raw log10(views + 1) score; the registered calibration converts it to ordinary views.',
            calibrationId: 'calibration.inverse-log10-nonnegative.v1',
            validationProtocolId: 'family.shorts.legacy.v1',
            artifactId: 'artifact.runtime.shorts.blind-predictor.v1',
            sourceCode: ['buildings/jarvis/saved-channel-validation.js:buildValidation'],
            visualizationId: 'map.runtime.none.v1',
            usesEmbedding: true,
            underlyingAxisIds: [
                'axis.shorts.creator-excluded.visual.views',
                'axis.shorts.creator-excluded.text.views',
                'axis.shorts.creator-excluded.together.views',
            ],
            reproducibility: { status: 'legacy-derived-from-blind-artifact' },
        };
    }
    return {
        rawInputIds: ['input.shorts.private-outcomes.v1'],
        representationId: null,
        fitDatasetId: 'dataset.runtime.shorts.legacy.v1',
        targetField: definition.target,
        algorithmId: 'algorithm.legacy-diagnostic.v1',
        scalarProjection: 'Read the registered historical prediction field without substituting it for a canonical coordinate.',
        calibrationId: 'calibration.identity-target-units.v1',
        validationProtocolId: 'family.shorts.legacy.v1',
        artifactId: 'artifact.runtime.shorts.legacy.v1',
        sourceCode: ['buildings/jarvis/saved-channel-validation.js:LEGACY_DIAGNOSTIC_COORDINATES'],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: false,
        reproducibility: { status: 'legacy-not-replayable' },
    };
}

function longLineage(group, metric) {
    const rawInputId = group === 'visual'
        ? 'input.long.thumbnail.v1'
        : 'input.long.thumbnail-title.v1';
    const representationId = group === 'visual'
        ? 'representation.long.visual.gemini1536.v1'
        : 'representation.long.together.gemini1536.v1';
    const realviews = metric.key === 'realviews';
    const frozenVisual = metric.key === 'ctrviews' && group === 'visual';
    const queryInput = {
        id: rawInputId,
        role: 'Query-time input embedded for this score.',
    };
    const privateOutcomes = {
        id: 'input.long.private-outcomes.v1',
        role: 'Upstream fit labels only; no outcome from the scored query is read.',
    };
    const publicOutcomes = {
        id: 'input.long.public-outcomes.v1',
        role: 'Upstream reference labels only; no public outcome from the scored query is read.',
    };
    const referenceDuration = {
        id: 'input.long.duration.v1',
        role: 'Reference-row duration used while materializing the realviews map. Candidate/query duration is not an input to channel_score().',
    };
    const rawInputs = [queryInput];
    const fitDataset = [];
    const algorithm = [];
    const calibration = [];
    const artifact = [];
    const familyId = frozenVisual
        ? 'family.long.visual.ctrviews-frozen.v1'
        : (metric.key === 'ctrviews'
            ? 'family.long.together.ctrviews-neighbor.v1'
            : (metric.key === 'ctr' || metric.key === 'ret30'
                ? 'family.long.ctr-ret30-neighbor.v1'
                : (metric.key === 'views'
                    ? 'family.long.views-neighbor.v1'
                    : (metric.key === 'realviews'
                        ? 'family.long.realviews-neighbor.v1'
                        : 'family.long.gt10m-neighbor.v1'))));
    if (frozenVisual) {
        rawInputs.push(privateOutcomes, publicOutcomes);
        fitDataset.push(
            {
                id: 'dataset.long.visual-ctr-private.v1',
                role: 'Fits the 30% private CTR direction on every embedded row with finite private CTR; this subfit is not curated-only.',
            },
            {
                id: 'dataset.long.curated-visual-views.v1',
                role: 'Fits the 70% public log-views direction and immutable final-blend percentile ladder on curated visual IDs.',
            },
        );
        algorithm.push({
            id: 'algorithm.long.ctrviews-blend.v1',
            role: 'Direct query projection onto the normalized 30% CTR + 70% log-views blend.',
        });
        calibration.push({
            id: 'calibration.long.frozen-visual-ctrviews-ladder.v1',
            role: 'Ranks the direct projection against the frozen curated visual ladder.',
        });
        artifact.push({
            id: 'artifact.long.visual-ctrviews-ladder.v1',
            role: 'Required scorer_visual.npz artifact produced by build_thumb_assets.py; legacy JSON is read only for backward compatibility. The scorer fails closed rather than substituting a neighbor coordinate.',
        });
        artifact.push({
            id: 'artifact.long.live-score-runtime.v1',
            role: 'Exact query-input fingerprint and direct frozen-scorer implementation.',
        });
    } else {
        fitDataset.push({
            id: 'dataset.long.raw-manifold.v1',
            role: 'ID-aligned Gemini embedding archive and materialized map used for cosine-neighbor lookup.',
        });
        algorithm.push({
            id: 'algorithm.long.neighbor-placement.v1',
            role: 'Selects up to 24 cosine neighbors in the embedding archive, joins their IDs to the map, retains the 1-24 matched rows without refilling, and applies max(similarity, 0)^8 weights.',
        });
        algorithm.push({
            id: 'algorithm.long.neighbor-metric-resolution.v1',
            role: `Resolves the ${metric.key} reference array and returns its weighted value or axis percentile.`,
        });
        artifact.push({
            id: 'artifact.long.maps.v1',
            role: 'Persisted map IDs, map coordinates, derived estimate arrays when available, and public outcomes. It does not contain embedding vectors.',
        });
        artifact.push({
            id: group === 'visual'
                ? 'artifact.long.embeddings.visual.v1'
                : 'artifact.long.embeddings.together.v1',
            role: 'Separately persisted reference vectors and archive IDs used for cosine-neighbor selection before map-ID alignment.',
        });
        artifact.push({
            id: 'artifact.long.live-score-runtime.v1',
            role: 'Exact query-input fingerprint, archive/map revision checks, and ID-aligned neighbor implementation.',
        });
        calibration.push({
            id: metric.key === 'gt10m'
                ? 'calibration.identity-target-units.v1'
                : 'calibration.long.neighbor-array-percentile.v1',
            role: metric.key === 'gt10m'
                ? 'The weighted strict-over-10M reference rate is already a probability.'
                : 'Ranks the weighted reference value inside the same materialized map array.',
        });
    }
    if (metric.key === 'ctr' || metric.key === 'ret30') {
        rawInputs.push(privateOutcomes);
        fitDataset.unshift({
            id: 'dataset.long.tyler-private-performance.v1',
            role: `Fits per-reference-row ${metric.key} estimates before neighbor aggregation.`,
        });
        algorithm.unshift({
            id: 'algorithm.long.private-pls2-axis.v1',
            role: `Fits the private ${metric.key} direction and quantile-maps every reference row to account outcome units.`,
        });
        calibration.unshift({
            id: 'calibration.long.account-rank-to-outcome.v1',
            role: `Creates the per-reference-row ${metric.key} estimates stored in the map.`,
        });
    } else if (realviews) {
        rawInputs.push(privateOutcomes, referenceDuration);
        fitDataset.unshift({
            id: 'dataset.long.tyler-private-performance.v1',
            role: 'Fits CTR, ret30, and the duration-deconfounded view equation.',
        });
        algorithm.unshift(
            {
                id: 'algorithm.long.private-pls2-axis.v1',
                role: 'Creates per-reference-row CTR and ret30 estimates.',
            },
            {
                id: 'algorithm.long.realviews-equation.v1',
                role: 'Combines reference CTR, ret30, and reference duration into per-row realistic-view estimates.',
            },
        );
    } else if (metric.key === 'ctrviews' && !frozenVisual) {
        rawInputs.push(privateOutcomes, publicOutcomes);
        fitDataset.unshift({
            id: 'dataset.long.tyler-private-performance.v1',
            role: 'Fits the private CTR direction; the raw manifold supplies public log views for the second direction.',
        });
        algorithm.unshift({
            id: 'algorithm.long.ctrviews-blend.v1',
            role: 'Builds the reference map x axis from 30% private CTR direction and 70% public log-views direction.',
        });
    } else if (metric.key === 'views' || metric.key === 'gt10m') {
        rawInputs.push(publicOutcomes);
    }
    return {
        rawInputIds: [rawInputId],
        rawInputs,
        representationId,
        representation: [{
            id: representationId,
            role: 'The scored query representation used for direct projection or cosine-neighbor placement.',
        }],
        fitDatasetId: frozenVisual
            ? 'dataset.long.visual-ctr-private.v1'
            : 'dataset.long.raw-manifold.v1',
        fitDataset,
        targetField: metric.target,
        algorithmId: frozenVisual
            ? 'algorithm.long.ctrviews-blend.v1'
            : 'algorithm.long.neighbor-metric-resolution.v1',
        algorithm,
        scalarProjection: realviews
            ? 'L2-normalize the query; select up to 24 archive neighbors; retain the 1-24 IDs present in the map; weight by max(sim, 0)^8; average their stored realistic-view estimates. Each reference estimate was built from that reference row\'s CTR, ret30, and duration. The query duration is never read.'
            : (frozenVisual
                ? 'L2 visual embedding dot the frozen 30% CTR + 70% views direction, ranked on its immutable ladder.'
                : (metric.key === 'ctrviews'
                    ? 'L2-normalize the query; select up to 24 archive neighbors; retain the 1-24 IDs present in the together ctrviews map; weight their display-scaled map x coordinates by max(sim, 0)^8; rank that weighted x value inside the map x array. The current producer writes no ctrviews est array.'
                    : (metric.key === 'gt10m'
                        ? 'L2-normalize the query; select up to 24 archive neighbors; retain the 1-24 IDs present in the map; weight by max(sim, 0)^8; return the weighted mean of the strict views > 10,000,000 indicator.'
                        : `L2-normalize the query; select up to 24 archive neighbors; retain the 1-24 IDs present in the map; weight by max(sim, 0)^8; resolve the stored ${metric.key} reference values and rank the weighted value inside that same array.`))),
        calibrationId: frozenVisual
            ? 'calibration.long.frozen-visual-ctrviews-ladder.v1'
            : (metric.key === 'gt10m'
                ? 'calibration.identity-target-units.v1'
                : 'calibration.long.neighbor-array-percentile.v1'),
        calibration,
        validationProtocolId: familyId,
        artifactId: frozenVisual
            ? 'artifact.long.visual-ctrviews-ladder.v1'
            : 'artifact.long.maps.v1',
        artifact,
        sourceCode: frozenVisual
            ? ['build_thumb_assets.py', 'longquant_score.py']
            : ['longquant_score.py', 'add_steered_proj_long.py'],
        visualizationId: metric.key === 'gt10m'
            ? 'map.long.hi10m.v1'
            : `map.long.${metric.key}.v1`,
        visualization: [{
            id: metric.key === 'gt10m'
                ? 'map.long.hi10m.v1'
                : `map.long.${metric.key}.v1`,
            role: frozenVisual
                ? 'Related target display only; it is not the frozen scalar ladder used by the score.'
                : (metric.key === 'ctrviews'
                    ? 'This map x coordinate is the explicit source for the together CTR+views output because the producer persists no separate est array.'
                    : 'Registered display map for the same named reference metric; map x/y are not silently substituted for scalar estimates.'),
        }],
        usesEmbedding: true,
        reproducibility: {
            status: frozenVisual ? 'frozen-artifact-required' : 'origin-dependent',
            disclosure: frozenVisual
                ? 'The direct visual coordinate is available only when the frozen scorer_visual.npz artifact (or its legacy JSON serialization) is present.'
                : 'Long historical rows must retain stored-production versus derived-neighbor-axis origin; those origins are never silently merged.',
        },
    };
}

function canonicalizeLineage(lineage) {
    const inputId = lineage.rawInputIds && lineage.rawInputIds.length
        ? lineage.rawInputIds[0]
        : null;
    return {
        ...lineage,
        inputId,
        datasetId: lineage.fitDatasetId,
        scalarTransform: lineage.scalarProjection,
        calibration: lineage.calibration == null ? lineage.calibrationId : lineage.calibration,
        holdout: lineage.validationProtocolId,
        mapView: lineage.visualizationId,
    };
}

function lineageReferenceIds(value) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value.flatMap(lineageReferenceIds);
    if (typeof value === 'object') {
        if (Array.isArray(value.refs)) return value.refs.flatMap(lineageReferenceIds);
        if (Array.isArray(value.ids)) return value.ids.flatMap(lineageReferenceIds);
        return [value.id || value.ref || value.referenceId || value.catalogId].filter(Boolean);
    }
    return [String(value)];
}

function buildCoordinateIdentity(column, catalog) {
    const lineage = column.lineage || {};
    const ids = values => [...new Set(
        (Array.isArray(values) ? values : [values]).flatMap(lineageReferenceIds).filter(Boolean),
    )].sort();
    const rawInputIds = ids([lineage.rawInputIds, lineage.rawInputs]);
    const representationIds = ids([lineage.representationId, lineage.representation]);
    const fitDatasetIds = ids([lineage.fitDatasetId, lineage.fitDatasetIds, lineage.fitDataset]);
    const algorithmIds = ids([lineage.algorithmId, lineage.algorithmIds, lineage.algorithm]);
    const calibrationIds = ids([lineage.calibrationId, lineage.calibration]);
    const artifactIds = ids([lineage.artifactId, lineage.artifactIds, lineage.artifact]);
    const validationProtocolIds = ids(lineage.validationProtocolId);
    const fitDatasetSnapshotSha256ById = Object.fromEntries(fitDatasetIds.map(id => {
        const dataset = (catalog.fitDatasets || {})[id] || {};
        return [id, dataset.runtimeSnapshot ? sha256Json(dataset.runtimeSnapshot) : null];
    }));
    const artifactRevisionSha256ById = Object.fromEntries(artifactIds.map(id => {
        const artifact = (catalog.artifacts || {})[id] || {};
        return [id, artifact.runtimeRevision ? sha256Json(artifact.runtimeRevision) : null];
    }));
    const axisTuple = {
        rawInputIds,
        representationIds,
        fitDatasetIds,
        fitDatasetSnapshotSha256ById,
        targetField: lineage.targetField,
        algorithmIds,
        scalarProjection: lineage.scalarProjection,
        calibrationIds,
        artifactIds,
        artifactRevisionSha256ById,
        sourceCode: ids(lineage.sourceCode),
        usesEmbedding: lineage.usesEmbedding,
    };
    const coordinateTuple = {
        coordinateId: column.id,
        ...axisTuple,
        validationProtocolIds,
    };
    return {
        schemaVersion: 1,
        axisFingerprint: sha256Json(axisTuple),
        coordinateFingerprint: sha256Json(coordinateTuple),
        axisTuple,
        validationProtocolIds,
        meaning: 'The axis fingerprint changes when any query input, representation, fit population snapshot, target, fitted transform, calibration, frozen artifact revision, or producer source changes. The coordinate fingerprint additionally pins the public coordinate ID and evaluation protocol.',
    };
}

function buildLineageAudit(columns, longColumns, catalog) {
    const required = [
        'rawInputIds',
        'fitDatasetId',
        'targetField',
        'algorithmId',
        'scalarProjection',
        'calibrationId',
        'validationProtocolId',
        'artifactId',
        'sourceCode',
        'visualizationId',
        'usesEmbedding',
    ];
    const all = [...columns, ...longColumns];
    const missing = [];
    const brokenReferences = [];
    const catalogReferenceErrors = [];
    const duplicateLineageIds = [];
    const seenLineageIds = new Set();
    const referenceIds = value => {
        if (value == null || value === '') return [];
        if (Array.isArray(value)) return value.flatMap(referenceIds);
        if (typeof value === 'object') {
            if (Array.isArray(value.refs)) return value.refs.flatMap(referenceIds);
            if (Array.isArray(value.ids)) return value.ids.flatMap(referenceIds);
            return [value.id || value.ref || value.referenceId || value.catalogId].filter(Boolean);
        }
        return [String(value)];
    };
    const objectValues = value => (
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.values(value)
            : []
    );
    const auditCatalogReference = (context, registry, values) => {
        for (const id of new Set(referenceIds(values))) {
            if (id && !(catalog[registry] || {})[id]) {
                catalogReferenceErrors.push(`${context}:${registry}:${id}`);
            }
        }
    };
    for (const [id, input] of Object.entries(catalog.rawInputs || {})) {
        auditCatalogReference(
            id,
            'rawInputs',
            referenceIds(input.members).filter(memberId => memberId.startsWith('input.')),
        );
    }
    for (const [id, representation] of Object.entries(catalog.representations || {})) {
        auditCatalogReference(id, 'rawInputs', representation.rawInputSetIds);
        auditCatalogReference(id, 'artifacts', representation.artifactId);
        auditCatalogReference(id, 'representations', [
            representation.queryRepresentationIds,
            representation.referenceRepresentationIds,
            referenceIds(representation.members).filter(memberId => memberId.startsWith('representation.')),
        ]);
    }
    for (const [id, dataset] of Object.entries(catalog.fitDatasets || {})) {
        auditCatalogReference(id, 'rawInputs', [
            dataset.labelInputSetId,
            dataset.labelInputSetIds,
            dataset.baseInputSetId,
        ]);
        auditCatalogReference(id, 'fitDatasets', dataset.baseDatasetId);
        auditCatalogReference(id, 'representations', [
            dataset.fitRepresentationId,
            dataset.fitRepresentationIds,
            objectValues(dataset.fitRepresentationIdsByModality),
            objectValues(dataset.fitRepresentationIdsByGroup),
        ]);
    }
    for (const [id, calibration] of Object.entries(catalog.calibrations || {})) {
        auditCatalogReference(id, 'artifacts', calibration.artifactId);
    }
    for (const [id, visualization] of Object.entries(catalog.visualizations || {})) {
        auditCatalogReference(id, 'fitDatasets', [
            visualization.fitDatasetId,
            visualization.fitDatasetIds,
            visualization.fitDatasets,
            visualization.transformDatasetId,
        ]);
        auditCatalogReference(id, 'algorithms', visualization.algorithmId);
        auditCatalogReference(id, 'calibrations', visualization.calibrationId);
        auditCatalogReference(id, 'artifacts', visualization.artifactId);
    }
    for (const [id, family] of Object.entries(catalog.validationProtocols || {})) {
        auditCatalogReference(id, 'rawInputs', [
            family.rawInputSetIds,
            family.upstreamRawInputSets,
        ]);
        auditCatalogReference(id, 'representations', [
            family.representationId,
            family.representationIds,
            objectValues(family.representationIdByModality),
            objectValues(family.representationIdByGroup),
            family.fitRepresentationId,
            family.fitRepresentationIds,
            objectValues(family.fitRepresentationIdByModality),
            objectValues(family.fitRepresentationIdByGroup),
        ]);
        auditCatalogReference(id, 'fitDatasets', [
            family.fitDatasetId,
            family.fitDatasetIds,
        ]);
        auditCatalogReference(id, 'algorithms', [
            family.algorithmId,
            family.algorithmIds,
        ]);
        auditCatalogReference(id, 'calibrations', [
            family.calibrationId,
            family.calibrationIds,
            family.alternateCalibrationId,
        ]);
        auditCatalogReference(id, 'artifacts', [
            family.artifactId,
            family.artifactIds,
        ]);
        auditCatalogReference(id, 'visualizations', [
            family.visualizationMapId,
            family.visualizationMapIds,
            objectValues(family.visualizationMapIdByTarget),
            objectValues(family.visualizationMapIdByGroup),
        ]);
    }
    for (const column of all) {
        if (!column.lineageId || !column.lineage) {
            missing.push(`${column.id}:lineage`);
            continue;
        }
        if (seenLineageIds.has(column.lineageId)) duplicateLineageIds.push(column.lineageId);
        seenLineageIds.add(column.lineageId);
        for (const key of required) {
            if (column.lineage[key] === undefined || column.lineage[key] === '') {
                missing.push(`${column.id}:${key}`);
            }
        }
        if (column.lineage.usesEmbedding && !column.lineage.representationId) {
            missing.push(`${column.id}:representationId`);
        }
        for (const inputId of new Set([
            ...referenceIds(column.lineage.rawInputIds),
            ...referenceIds(column.lineage.rawInputs),
        ])) {
            if (!catalog.rawInputs[inputId]) brokenReferences.push(`${column.id}:rawInputs:${inputId}`);
        }
        const references = [
            ['representations', [
                ...referenceIds(column.lineage.representationId),
                ...referenceIds(column.lineage.representation),
            ]],
            ['fitDatasets', [
                ...referenceIds(column.lineage.fitDatasetId),
                ...referenceIds(column.lineage.fitDatasetIds),
                ...referenceIds(column.lineage.fitDataset),
            ]],
            ['algorithms', [
                ...referenceIds(column.lineage.algorithmId),
                ...referenceIds(column.lineage.algorithmIds),
                ...referenceIds(column.lineage.algorithm),
            ]],
            ['calibrations', [
                ...referenceIds(column.lineage.calibrationId),
                ...referenceIds(column.lineage.calibration),
            ]],
            ['validationProtocols', [
                ...referenceIds(column.lineage.validationProtocolId),
                ...referenceIds(column.lineage.validation),
            ]],
            ['artifacts', [
                ...referenceIds(column.lineage.artifactId),
                ...referenceIds(column.lineage.artifactIds),
                ...referenceIds(column.lineage.artifact),
            ]],
            ['visualizations', [
                ...referenceIds(column.lineage.visualizationId),
                ...referenceIds(column.lineage.visualization),
            ]],
        ];
        for (const [registry, ids] of references) {
            for (const id of new Set(ids)) {
                if (id && !catalog[registry][id]) brokenReferences.push(`${column.id}:${registry}:${id}`);
            }
        }
    }
    const runtimeDatasetIds = new Set();
    const runtimeArtifactIds = new Set();
    const runtimeRepresentationIds = new Set();
    const runtimeVisualizationIds = new Set();
    const runtimeCalibrationIds = new Set();
    const runtimeProtocolIds = new Set();
    const addAll = (target, values) => {
        for (const id of referenceIds(values)) {
            if (id) target.add(id);
        }
    };
    for (const column of all.filter(candidate => candidate.valueClass !== 'legacy_diagnostic')) {
        const lineage = column.lineage || {};
        addAll(runtimeRepresentationIds, [lineage.representationId, lineage.representation]);
        addAll(runtimeDatasetIds, [lineage.fitDatasetId, lineage.fitDatasetIds, lineage.fitDataset]);
        addAll(runtimeArtifactIds, [lineage.artifactId, lineage.artifactIds, lineage.artifact]);
        addAll(runtimeVisualizationIds, [lineage.visualizationId, lineage.visualization]);
        addAll(runtimeCalibrationIds, [lineage.calibrationId, lineage.calibration]);
        addAll(runtimeProtocolIds, lineage.validationProtocolId);
    }
    let closureChanged = true;
    while (closureChanged) {
        const before = [
            runtimeDatasetIds.size,
            runtimeArtifactIds.size,
            runtimeRepresentationIds.size,
            runtimeVisualizationIds.size,
            runtimeCalibrationIds.size,
            runtimeProtocolIds.size,
        ].join(':');
        for (const id of [...runtimeRepresentationIds]) {
            const value = (catalog.representations || {})[id] || {};
            addAll(runtimeArtifactIds, value.artifactId);
            addAll(runtimeRepresentationIds, [
                value.queryRepresentationIds,
                value.referenceRepresentationIds,
                referenceIds(value.members).filter(memberId => memberId.startsWith('representation.')),
            ]);
        }
        for (const id of [...runtimeDatasetIds]) {
            const value = (catalog.fitDatasets || {})[id] || {};
            addAll(runtimeDatasetIds, value.baseDatasetId);
            addAll(runtimeRepresentationIds, [
                value.fitRepresentationId,
                value.fitRepresentationIds,
                objectValues(value.fitRepresentationIdsByModality),
                objectValues(value.fitRepresentationIdsByGroup),
            ]);
        }
        for (const id of [...runtimeVisualizationIds]) {
            const value = (catalog.visualizations || {})[id] || {};
            addAll(runtimeDatasetIds, [
                value.fitDatasetId,
                value.fitDatasetIds,
                value.fitDatasets,
                value.transformDatasetId,
            ]);
            addAll(runtimeArtifactIds, value.artifactId);
            addAll(runtimeCalibrationIds, value.calibrationId);
        }
        for (const id of [...runtimeCalibrationIds]) {
            const value = (catalog.calibrations || {})[id] || {};
            addAll(runtimeArtifactIds, value.artifactId);
        }
        for (const id of [...runtimeProtocolIds]) {
            const value = (catalog.validationProtocols || {})[id] || {};
            addAll(runtimeDatasetIds, [value.fitDatasetId, value.fitDatasetIds]);
            addAll(runtimeArtifactIds, [value.artifactId, value.artifactIds]);
            addAll(runtimeRepresentationIds, [
                value.representationId,
                value.representationIds,
                objectValues(value.representationIdByModality),
                objectValues(value.representationIdByGroup),
                value.fitRepresentationId,
                value.fitRepresentationIds,
                objectValues(value.fitRepresentationIdByModality),
                objectValues(value.fitRepresentationIdByGroup),
            ]);
            addAll(runtimeVisualizationIds, [
                value.visualizationMapId,
                value.visualizationMapIds,
                objectValues(value.visualizationMapIdByTarget),
                objectValues(value.visualizationMapIdByGroup),
            ]);
            addAll(runtimeCalibrationIds, [value.calibrationId, value.calibrationIds]);
        }
        const after = [
            runtimeDatasetIds.size,
            runtimeArtifactIds.size,
            runtimeRepresentationIds.size,
            runtimeVisualizationIds.size,
            runtimeCalibrationIds.size,
            runtimeProtocolIds.size,
        ].join(':');
        closureChanged = before !== after;
    }
    const exactHash = value => /^[a-f0-9]{64}$/i.test(String(value || ''));
    const unknownText = value => /unknown|not persisted|unavailable|row-specific/i.test(String(value || ''));
    const populationComplete = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (value.exact === false || unknownText(value.status)) return false;
        const rowCount = value.rowCount != null
            ? value.rowCount
            : (value.row_count != null ? value.row_count : value.count);
        const videoIdHash = value.videoIdSha256
            || value.videoIdHash
            || value.video_id_sha256
            || value.idSha256;
        return Number.isInteger(Number(rowCount))
            && Number(rowCount) >= 0
            && exactHash(videoIdHash);
    };
    const populationCollectionComplete = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const members = Object.values(value);
        if (!members.length) return false;
        return members.every(member => (
            populationComplete(member)
            || populationCollectionComplete(member)
        ));
    };
    const foldCollectionComplete = value => (
        Array.isArray(value)
        && value.length > 0
        && value.every(fold => (
            fold
            && Number.isInteger(Number(fold.trainingRowCount))
            && Number(fold.trainingRowCount) >= 0
            && exactHash(fold.trainingVideoIdSha256)
            && Number.isInteger(Number(fold.testingRowCount))
            && Number(fold.testingRowCount) >= 0
            && exactHash(fold.testingVideoIdSha256)
        ))
    );
    const runtimeFieldComplete = (field, value) => {
        if (value == null || value === '' || unknownText(value && value.status)) return false;
        if ([
            'artifactRevision',
            'labelSnapshotRevision',
            'outcomeSnapshotRevision',
            'registryRevision',
            'mapRevision',
            'embeddingRevision',
            'videoIdHash',
            'excludedVideoIdHash',
            'ctrVideoIdHash',
            'curatedVideoIdHash',
        ].includes(field)) return exactHash(value);
        if (field === 'rowCount' || field.endsWith('RowCount')) {
            return Number.isInteger(Number(value)) && Number(value) >= 0;
        }
        if (field === 'accountId' || field === 'baseAccountId') {
            return typeof value === 'string' && value.trim().length > 0;
        }
        if (field === 'byAccount'
            || field === 'viewEquationFitPopulations'
            || field === 'accountMetricPopulations') {
            return populationCollectionComplete(value);
        }
        if (field === 'labelSnapshotRevisions') {
            const revisions = value && typeof value === 'object' ? Object.values(value) : [];
            return revisions.length > 0 && revisions.every(revision => exactHash(revision && revision.sha256));
        }
        if (field === 'modalityTargetPopulations') return populationCollectionComplete(value);
        if (field === 'modalityPopulations') {
            if (!populationCollectionComplete(value)) return false;
            return Object.values(value).every(population => (
                exactHash(population.mapRevision)
                && exactHash(population.embeddingRevision)
            ));
        }
        if (field === 'videoFolds' || field === 'accountHoldouts') {
            return foldCollectionComplete(value);
        }
        if (field === 'materializedEligibility') {
            return value
                && Number.isInteger(Number(value.scalarEligible))
                && exactHash(value.scalarEligibleVideoIdSha256)
                && Array.isArray(value.scalarFolds)
                && value.scalarFolds.length > 0
                && foldCollectionComplete(value.scalarFoldPopulations);
        }
        if (field === 'candidateIndicatorKeysByTarget') {
            return value
                && ['keep', 'ret5', 'views'].every(target => (
                    Array.isArray(value[target]) && value[target].length > 0
                ));
        }
        if (field === 'calibrationPointCountsByIndicator') {
            const counts = value && typeof value === 'object' ? Object.values(value) : [];
            return counts.length > 0 && counts.some(count => Number(count) > 0);
        }
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') {
            return !unknownText(value.status)
                && Object.keys(value).length > 0;
        }
        return !unknownText(value);
    };
    const runtimeProvenanceMissing = [];
    for (const id of [...runtimeDatasetIds].sort()) {
        const dataset = (catalog.fitDatasets || {})[id];
        if (!dataset || !Array.isArray(dataset.runtimeProvenanceRequired)) continue;
        const snapshot = dataset.runtimeSnapshot;
        for (const field of dataset.runtimeProvenanceRequired) {
            if (!runtimeFieldComplete(field, snapshot && snapshot[field])) {
                runtimeProvenanceMissing.push(`${id}:runtimeSnapshot.${field}`);
            }
        }
    }
    const collectExactHashes = value => {
        if (value == null) return [];
        if (typeof value === 'string') return exactHash(value) ? [value] : [];
        if (Array.isArray(value)) return value.flatMap(collectExactHashes);
        if (typeof value !== 'object') return [];
        if (unknownText(value.status)) return [];
        return Object.entries(value).flatMap(([key, nested]) => (
            /sha256|revision/i.test(key) ? (exactHash(nested) ? [nested] : []) : collectExactHashes(nested)
        ));
    };
    const valueAtPath = (value, path) => String(path || '').split('.').reduce(
        (current, key) => (
            current && typeof current === 'object' ? current[key] : undefined
        ),
        value,
    );
    const runtimeRevisionMissing = [];
    for (const id of [...runtimeArtifactIds].sort()) {
        const artifact = (catalog.artifacts || {})[id];
        if (!artifact || !artifact.runtimeRevisionRequired) continue;
        const requiredFields = Array.isArray(artifact.runtimeRevisionRequiredFields)
            ? artifact.runtimeRevisionRequiredFields
            : [];
        if (requiredFields.length) {
            for (const field of requiredFields) {
                if (!exactHash(valueAtPath(artifact.runtimeRevision, field))) {
                    runtimeRevisionMissing.push(`${id}:runtimeRevision.${field}`);
                }
            }
        } else if (!collectExactHashes(artifact.runtimeRevision).length) {
            runtimeRevisionMissing.push(`${id}:runtimeRevision`);
        }
    }
    const blindArtifact = catalog.artifacts
        && catalog.artifacts['artifact.runtime.shorts.blind-predictor.v1'];
    const contractAlignment = blindArtifact && blindArtifact.contractAlignment
        || 'unknown; blind predictor artifact was not supplied';
    const contractRevisionAligned = contractAlignment === 'exact feature-contract file hash match';
    const structuralPassed = !missing.length
        && !brokenReferences.length
        && !catalogReferenceErrors.length
        && !duplicateLineageIds.length;
    const runtimeProvenancePassed = !runtimeProvenanceMissing.length
        && !runtimeRevisionMissing.length;
    return {
        passed: structuralPassed && contractRevisionAligned && runtimeProvenancePassed,
        structuralPassed,
        contractRevisionAligned,
        runtimeProvenancePassed,
        contractAlignment,
        columns: all.length,
        columnsChecked: columns.length,
        shortsColumns: columns.length,
        longColumns: longColumns.length,
        longColumnsChecked: longColumns.length,
        missing,
        brokenReferences,
        catalogReferenceErrors,
        duplicateLineageIds,
        runtimeDatasetsChecked: [...runtimeDatasetIds].sort(),
        runtimeArtifactsChecked: [...runtimeArtifactIds].sort(),
        runtimeProvenanceMissing,
        runtimeRevisionMissing,
        unclassifiedColumns: columns.filter(column => !column.valueClass).map(column => column.id),
        incompleteLineages: missing,
        unresolvedReferences: [
            ...brokenReferences,
            ...catalogReferenceErrors,
            ...runtimeProvenanceMissing,
            ...runtimeRevisionMissing,
        ],
        rule: 'A coordinate is invalid unless every input, representation, exact fit population, algorithm, calibration, validation protocol, artifact byte/source revision, and visualization reference resolves, and the blind score artifact records the exact current feature-contract hash.',
    };
}

function buildCoordinateRegistry(options = {}) {
    const predictorProvenance = options.predictorProvenance || options.provenance || {};
    const runtime = lineageRuntimeContext(
        options.rows || [],
        predictorProvenance,
        options.predictorPrivateRows || [],
        options.forecastModel || null,
        options.sourceFingerprint || null,
        options.generatedAt || null
    );
    const lineageCatalog = buildCanonicalLineageCatalog(runtime);
    const observed = OUTCOME_DEFINITIONS.map(definition => ({
        id: `shorts.observed.${definition.key}`,
        family: 'observed',
        protocol: 'observed',
        group: 'outcome',
        key: definition.key,
        target: displayTargetForOutcome(definition.key),
        label: definition.label,
        unit: definition.unit,
        transform: definition.transform || null,
        derived: definition.derived || null,
        status: 'canonical',
        valueClass: 'observed_outcome',
        lineageId: `lineage.shorts.observed.${definition.key}`,
        lineage: lineageForObserved(definition),
        description: 'Measured outcome joined to the scored video. This is truth on the X axis, not an embedding score.',
    }));
    const stored = contract.features.map(definition => ({
        id: `shorts.stored.${definition.key}`,
        family: 'stored',
        protocol: 'stored',
        group: definition.group,
        key: definition.key,
        target: definition.target,
        label: `${definition.group === 'together' ? 'Both' : definition.group} · ${definition.label}`,
        unit: definition.displayUnit || definition.unit,
        storageUnit: definition.unit,
        sourceKey: definition.sourceKey || definition.key,
        percentileAvailable: definition.target !== 'realviews',
        status: 'canonical',
        valueClass: definition.group === 'novelty' || definition.target === 'realviews'
            ? 'embedding_derived_transform'
            : 'direct_embedding_axis',
        lineageId: `lineage.shorts.stored.${definition.key}`,
        lineage: lineageForStored(definition),
        description: 'Exact production score persisted when the video was analyzed. The estimate and percentile are one registered coordinate.',
    }));
    const direct = ['video', 'account'].flatMap(protocol => (
        contract.features.filter(definition => definition.group !== 'novelty').map(definition => ({
            id: `shorts.${protocol}-heldout.${definition.key}`,
            family: `${protocol}Heldout`,
            protocol,
            group: definition.group,
            key: definition.key,
            target: definition.target,
            label: `${protocol === 'video' ? 'Video-held-out' : 'Account-held-out'} ${definition.group === 'together' ? 'Both' : definition.group} · ${definition.label}`,
            unit: definition.displayUnit || definition.unit,
            storageUnit: 'blind_model_coordinate',
            sourceKey: `${definition.key}.raw`,
            percentileAvailable: false,
            status: 'canonical',
            valueClass: definition.target === 'realviews'
                ? 'embedding_derived_transform'
                : 'direct_embedding_axis',
            lineageId: `lineage.shorts.${protocol}-heldout.${definition.key}`,
            lineage: lineageForHeldout(definition, protocol),
            description: protocol === 'video'
                ? 'The evaluated video and every row in its deterministic within-account outer fold were excluded from the target-aligned reconstruction.'
                : 'The evaluated creator account was excluded from the target-aligned reconstruction.',
        }))
    ));
    const forecasts = ['video', 'account'].flatMap(protocol => (
        OUTCOME_DEFINITIONS.map(definition => ({
            id: `shorts.${protocol}-forecast.${definition.key}`,
            family: `${protocol}Forecast`,
            protocol,
            group: 'combined',
            key: definition.key,
            target: displayTargetForOutcome(definition.key),
            label: `${protocol === 'video' ? 'Video-held-out' : 'Account-held-out'} combined forecast · ${definition.label}`,
            unit: definition.key === 'hit10M' ? 'probability' : definition.unit,
            percentileAvailable: false,
            status: 'canonical',
            valueClass: 'combined_forecast',
            lineageId: `lineage.shorts.${protocol}-forecast.${definition.key}`,
            lineage: lineageForForecast(definition, protocol),
            description: 'Fold-fitted forecast from the nine creator-excluded public views, outlier, and 10M coordinates. It is not an additional embedding axis.',
        }))
    ));
    const legacy = LEGACY_DIAGNOSTIC_COORDINATES.map(definition => ({
        id: `shorts.legacy.${definition.key}`,
        family: 'legacy',
        protocol: 'legacy',
        group: 'legacy',
        key: definition.key,
        target: definition.target,
        label: definition.label,
        unit: definition.unit,
        percentileAvailable: false,
        status: 'legacy_diagnostic',
        replacement: definition.replacement || null,
        valueClass: 'legacy_diagnostic',
        lineageId: `lineage.shorts.legacy.${definition.key}`,
        lineage: lineageForLegacy(definition),
        description: 'Registered for audit compatibility. It is not used as the canonical score-card value.',
    }));
    const columns = [...observed, ...stored, ...direct, ...forecasts, ...legacy];
    const familyMeta = [
        ['observed', 'Observed outcomes', 'Measured truth; never an embedding.'],
        ['stored', 'Stored production scores', 'The exact 21 score-card coordinates.'],
        ['videoHeldout', 'Video-held-out scores', '15 direct axes plus 3 derived realistic-views transforms rebuilt without the evaluated video.'],
        ['accountHeldout', 'Account-held-out scores', '15 direct axes plus 3 derived realistic-views transforms rebuilt without the evaluated account.'],
        ['videoForecast', 'Video-held-out combined forecasts', '13 outcomes forecast from nine creator-excluded public axes.'],
        ['accountForecast', 'Account-held-out combined forecasts', '13 account-transfer outcome forecasts.'],
        ['legacy', 'Legacy diagnostics', 'Registered for traceability, visibly deprecated, and never substituted for a production score.'],
    ].map(([key, label, description]) => ({
        key,
        label,
        description,
        count: columns.filter(column => column.family === key).length,
    }));
    const longQuantColumns = ['visual', 'together'].flatMap(group => LONG_QUANT_METRICS.map(metric => ({
        id: `long.output.${group}.${metric.key}`,
        family: 'longStored',
        protocol: 'stored',
        group,
        key: `${group}.${metric.key}`,
        target: metric.target,
        label: `${group === 'together' ? 'Both' : 'Visual'} · ${metric.label}`,
        unit: metric.unit,
        status: 'canonical',
        valueClass: group === 'visual' && metric.key === 'ctrviews'
            ? 'direct_embedding_axis'
            : 'embedding_derived_transform',
        lineageId: `lineage.long.output.${group}.${metric.key}`,
        lineage: longLineage(group, metric),
        description: 'Current Long Quant score output. Historical rows can identify stored-production or derived-neighbor-axis origin separately.',
    })));
    for (const column of [...columns, ...longQuantColumns]) {
        column.lineage = canonicalizeLineage(column.lineage);
        column.coordinateIdentity = buildCoordinateIdentity(column, lineageCatalog);
    }
    const lineageAudit = buildLineageAudit(columns, longQuantColumns, lineageCatalog);
    const valueClassCounts = columns.reduce((counts, column) => {
        counts[column.valueClass] = (counts[column.valueClass] || 0) + 1;
        return counts;
    }, {});
    const directAxisColumns = columns.filter(column => column.valueClass === 'direct_embedding_axis');
    const distinctDirectAxisCount = new Set(
        directAxisColumns.map(column => column.coordinateIdentity.axisFingerprint),
    ).size;
    const blindColumns = columns.filter(column => (
        column.family === 'videoHeldout'
        || column.family === 'accountHeldout'
        || column.family === 'videoForecast'
        || column.family === 'accountForecast'
    ));
    const blindUniquePredictionCount = new Set(
        blindColumns.map(column => column.coordinateIdentity.axisFingerprint),
    ).size;
    const diagnosticColumns = columns.filter(column => (
        column.family === 'stored' || column.family === 'legacy'
    ));
    const outcomeColumns = columns.filter(column => column.family === 'observed');
    return {
        version: LEDGER_VERSION,
        contractVersion: contract.version,
        rules: [
            'Every displayed scalar must resolve to one coordinate ID in this registry.',
            'A relationship graph pairs one score-coordinate ID with one observed-outcome ID; it never creates a new score.',
            'Stored production, held-out reconstruction, combined forecast, and observed truth are different families and may not substitute for one another.',
            'Percentiles belong to their coordinate cell; they are not new estimates.',
            'Re-scoring parity is defined by identical input fingerprint plus scorer, model, and artifact revisions.',
            'The 103 Shorts row columns are not 103 embedding spaces: 45 are direct-axis columns representing 36 distinct fitted axes because nine shared public axes appear under both protocol views; transforms, forecasts, observations, and legacy diagnostics are counted separately.',
        ],
        columns,
        families: familyMeta,
        classification: {
            blind: {
                columns: blindColumns.length,
                uniquePredictions: blindUniquePredictionCount,
                aliasColumns: blindColumns.length - blindUniquePredictionCount,
                families: ['videoHeldout', 'accountHeldout', 'videoForecast', 'accountForecast'],
                meaning: 'Coordinates eligible for blind validation. Nine creator-excluded public direct axes appear in both protocol views but identify the same fitted prediction.',
            },
            diagnostics: {
                columns: diagnosticColumns.length,
                families: ['stored', 'legacy'],
                meaning: 'Stored production outputs and legacy comparisons. They can be evaluated but are not promoted to strict blind evidence.',
            },
            outcomes: {
                columns: outcomeColumns.length,
                families: ['observed'],
                meaning: 'Measured truth. These columns are audit-visible but always excluded from predictor ranking.',
            },
        },
        lineageCatalog,
        lineageAudit,
        totals: {
            shortsRowColumns: columns.length,
            shortsCanonicalColumns: columns.filter(column => column.status === 'canonical').length,
            shortsLegacyDiagnostics: legacy.length,
            shortsStoredProduction: stored.length,
            shortsDirectHeldout: direct.length,
            shortsCombinedForecasts: forecasts.length,
            shortsObservedOutcomes: observed.length,
            longStoredOutputs: longQuantColumns.length,
            shortsDirectEmbeddingAxes: distinctDirectAxisCount,
            shortsDirectAxisColumns: valueClassCounts.direct_embedding_axis || 0,
            shortsDistinctDirectEmbeddingAxes: distinctDirectAxisCount,
            shortsDirectAxisAliasColumns: directAxisColumns.length - distinctDirectAxisCount,
            shortsBlindColumns: blindColumns.length,
            shortsBlindUniquePredictions: blindUniquePredictionCount,
            shortsBlindAliasColumns: blindColumns.length - blindUniquePredictionCount,
            shortsDiagnosticColumns: diagnosticColumns.length,
            shortsOutcomeColumns: outcomeColumns.length,
            shortsEmbeddingDerivedTransforms: valueClassCounts.embedding_derived_transform || 0,
            shortsForecastColumns: valueClassCounts.combined_forecast || 0,
            shortsObservedColumns: valueClassCounts.observed_outcome || 0,
            shortsLegacyColumns: valueClassCounts.legacy_diagnostic || 0,
        },
        curves: {
            seconds: CURVE_SECONDS.slice(),
            series: [
                { id: 'shorts.curve.observed.raw', label: 'Raw observed YouTube retention', type: 'measured' },
                { id: 'shorts.curve.observed.normalized', label: 'Observed retention normalized to its opening value', type: 'derived_observed' },
                { id: 'shorts.curve.video-forecast', label: 'Video-held-out normalized retention forecast', type: 'forecast' },
                { id: 'shorts.curve.video-baseline', label: 'Video-fold training mean', type: 'evaluation_reference' },
                { id: 'shorts.curve.account-forecast', label: 'Account-held-out normalized retention forecast', type: 'forecast' },
                { id: 'shorts.curve.account-baseline', label: 'Account-fold training mean', type: 'evaluation_reference' },
            ],
        },
        longQuant: {
            columns: longQuantColumns,
            scalarOutputCount: longQuantColumns.length,
            mapProjections: contract.crossDomainInventory.longQuant.mapProjections.slice(),
            note: 'Map projections are alternate visualizations of registered data. They do not create additional per-video scores.',
        },
        shortsMapProjections: {
            keys: contract.crossDomainInventory.shorts.mapProjections.slice(),
            note: 'Map projections are alternate visualizations of registered data. They do not create additional per-video scores.',
        },
    };
}

function transformOutcome(value, definition) {
    if (!finite(value)) return null;
    if (definition && definition.transform === 'log10(views + 1)') return Math.log10(Math.max(0, Number(value)) + 1);
    if (definition && definition.transform === 'log10(value + 1)') return Math.log10(Math.max(0, Number(value)) + 1);
    return Number(value);
}

function erf(value) {
    const sign = value < 0 ? -1 : 1;
    const x = Math.abs(value);
    const t = 1 / (1 + 0.3275911 * x);
    const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
    return 0.5 * (1 + erf(Number(value) / Math.sqrt(2)));
}

function correlationInference(correlation, n) {
    if (!finite(correlation) || n < 4 || Math.abs(Number(correlation)) >= 1) {
        return { p: correlation === 1 || correlation === -1 ? 0 : null, ci95: [null, null] };
    }
    const r = clamp(Number(correlation), -0.999999, 0.999999);
    const z = Math.atanh(r), standardError = 1 / Math.sqrt(n - 3);
    const test = Math.abs(z / standardError);
    return {
        p: round(2 * (1 - normalCdf(test)), 8),
        ci95: [
            round(Math.tanh(z - 1.959963984540054 * standardError), 5),
            round(Math.tanh(z + 1.959963984540054 * standardError), 5),
        ],
    };
}

function centeredCorrelation(points, rankFirst) {
    const groups = new Map();
    for (const point of points) {
        if (!groups.has(point.accountId)) groups.set(point.accountId, []);
        groups.get(point.accountId).push(point);
    }
    const actual = [], predicted = [];
    for (const group of groups.values()) {
        const x = rankFirst ? ranks(group.map(point => point.actual)) : group.map(point => point.actual);
        const y = rankFirst ? ranks(group.map(point => point.predicted)) : group.map(point => point.predicted);
        const xMean = average(x), yMean = average(y);
        x.forEach((value, index) => {
            actual.push(value - xMean);
            predicted.push(y[index] - yMean);
        });
    }
    return pearson(actual, predicted);
}

function pointMap(points, sourceKey, sourceValue) {
    return new Map((points || [])
        .filter(point => !sourceKey || String(point[sourceKey]) === String(sourceValue))
        .map(point => [String(point.id), point]));
}

function predictorStress(target, label) {
    return ((target && target.stressTests) || []).find(test => test.label === label) || {};
}

function toViewsFromFeature(value, definition) {
    if (!finite(value)) return null;
    if (definition && definition.unit === 'log10_views') return Math.max(0, 10 ** Number(value) - 1);
    return Math.max(0, Number(value));
}

function blindFeatureValue(row, featureName, protocol) {
    const index = row.blindFeatureNames.indexOf(featureName);
    if (index < 0) return null;
    const values = protocol === 'account' ? row.blindAccountHeldOut : row.blindVideoHeldOut;
    return values && finite(values[index]) ? Number(values[index]) : null;
}

function featureDisplayValue(row, definition, protocol) {
    if (!row || !definition) return null;
    if (protocol === 'stored') {
        const index = contract.features.findIndex(feature => feature.key === definition.key);
        const value = index >= 0 ? number(row.storedRaw[index]) : null;
        return definition.unit === 'log10_views' && finite(value)
            ? Math.max(0, 10 ** Number(value) - 1)
            : value;
    }
    const value = blindFeatureValue(row, `${definition.key}.raw`, protocol);
    if (!finite(value)) return null;
    return ['views', 'realviews', 'outlier'].includes(definition.target)
        ? Math.max(0, 10 ** Number(value) - 1)
        : Number(value);
}

function readPath(value, path) {
    return path.reduce((current, key) => current == null ? null : current[key], value);
}

function ledgerValue(row, column) {
    if (column.family === 'observed') {
        const definition = OUTCOME_DEFINITIONS.find(outcome => outcome.key === column.key);
        return definition ? number(definition.accessor(row)) : null;
    }
    if (column.family === 'stored') {
        return featureDisplayValue(row, contract.features.find(feature => feature.key === column.key), 'stored');
    }
    if (column.family === 'videoHeldout' || column.family === 'accountHeldout') {
        const definition = contract.features.find(feature => feature.key === column.key);
        return featureDisplayValue(row, definition, column.family === 'videoHeldout' ? 'video' : 'account');
    }
    if (column.family === 'videoForecast' || column.family === 'accountForecast') {
        const protocol = column.family === 'videoForecast' ? 'video' : 'account';
        return number(row.predictions && row.predictions.score21 && row.predictions.score21[protocol]
            && row.predictions.score21[protocol][column.key]);
    }
    if (column.family === 'legacy') {
        const definition = LEGACY_DIAGNOSTIC_COORDINATES.find(item => item.key === column.key);
        return definition ? number(readPath(row, definition.path)) : null;
    }
    return null;
}

function ledgerPercentile(row, column) {
    if (column.family !== 'stored') return null;
    const index = contract.features.findIndex(feature => feature.key === column.key);
    return index >= 0 ? number(row.storedPercentile[index]) : null;
}

function attachCoordinateLedger(rows, registry) {
    for (const row of rows) {
        const values = registry.columns.map(column => number(ledgerValue(row, column)));
        const percentiles = registry.columns.map(column => number(ledgerPercentile(row, column)));
        row.scoreLedger = {
            version: registry.version,
            values,
            percentiles,
            available: values.filter(finite).length,
        };
    }
    const ids = registry.columns.map(column => column.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const rowLengthMismatches = rows.filter(row => (
        !row.scoreLedger
        || row.scoreLedger.values.length !== registry.columns.length
        || row.scoreLedger.percentiles.length !== registry.columns.length
    )).map(row => row.id);
    const storedParityMismatches = [];
    const storedColumns = registry.columns.filter(column => column.family === 'stored');
    for (const row of rows) {
        for (const column of storedColumns) {
            const ledgerIndex = registry.columns.findIndex(item => item.id === column.id);
            const featureIndex = contract.features.findIndex(feature => feature.key === column.key);
            const definition = contract.features[featureIndex];
            const expected = definition && definition.unit === 'log10_views' && finite(row.storedRaw[featureIndex])
                ? Math.max(0, 10 ** Number(row.storedRaw[featureIndex]) - 1)
                : number(row.storedRaw[featureIndex]);
            const actual = row.scoreLedger.values[ledgerIndex];
            if (finite(expected) !== finite(actual)
                || (finite(expected) && Math.abs(Number(expected) - Number(actual)) > Math.max(1e-4, Math.abs(Number(expected)) * 1e-5))) {
                storedParityMismatches.push(`${row.id}:${column.key}`);
            }
        }
    }
    const exactHash = value => /^[a-f0-9]{64}$/i.test(String(value || ''));
    const exactRowManifests = [];
    const historicalRowManifests = [];
    const exactNoveltyRows = [];
    const historicalNoveltyRows = [];
    for (const row of rows) {
        const manifest = row.inputManifest || {};
        const scorer = manifest.scorer_revisions && manifest.scorer_revisions.scorer || {};
        const exactScorerManifest = exactHash(manifest.input_fingerprint)
            && exactHash(manifest.revision_fingerprint)
            && exactHash(manifest.output_fingerprint)
            && exactHash(scorer.sha256)
            && exactHash(manifest.steer_artifact_sha256 || manifest.steerArtifactSha256);
        (exactScorerManifest ? exactRowManifests : historicalRowManifests).push(row.id);
        const novelty = row.noveltyProvenance || {};
        const noveltyTargets = novelty.targets || {};
        const exactNoveltyManifest = exactHash(
            novelty.registryRevision
            && (novelty.registryRevision.sha256 || novelty.registryRevision.artifactSha256)
        ) && ['keep', 'ret5', 'views'].every(target => {
            const selection = noveltyTargets[target] || {};
            const calibration = selection.calibration || {};
            return selection.status === 'selected'
                && !!selection.selectedIndicatorKey
                && Number(calibration.calibrationPointCount) > 0
                && exactHash(
                    calibration.calibrationPopulationHash
                    || calibration.calibrationPointsSha256
                );
        });
        (exactNoveltyManifest ? exactNoveltyRows : historicalNoveltyRows).push(row.id);
    }
    return {
        passed: duplicateIds.length === 0
            && rowLengthMismatches.length === 0
            && storedParityMismatches.length === 0
            && (!registry.lineageAudit || registry.lineageAudit.passed),
        registryVersion: registry.version,
        columns: registry.columns.length,
        rows: rows.length,
        duplicateIds,
        rowLengthMismatches,
        storedParityMismatches: storedParityMismatches.slice(0, 50),
        lineagePassed: !registry.lineageAudit || registry.lineageAudit.passed,
        lineageMissing: registry.lineageAudit ? registry.lineageAudit.missing : [],
        lineageBrokenReferences: registry.lineageAudit ? registry.lineageAudit.unresolvedReferences : [],
        rowProvenance: {
            exactScorerManifestRows: exactRowManifests.length,
            historicalOrIncompleteScorerManifestRows: historicalRowManifests.length,
            exactNoveltySelectionRows: exactNoveltyRows.length,
            historicalOrIncompleteNoveltySelectionRows: historicalNoveltyRows.length,
            historicalScorerRowIds: historicalRowManifests.slice(0, 50),
            historicalNoveltyRowIds: historicalNoveltyRows.slice(0, 50),
            disclosure: 'Historical rows remain visible but are never described as deterministic replay. Newly scored rows persist exact query, scorer, artifact, output, registry, selected-indicator, and calibration fingerprints.',
        },
        relationshipRule: 'A plot is identified by scoreCoordinateId + observedOutcomeId. Its point value must be read from that exact ledger column.',
    };
}

function actualForTarget(row, target) {
    if (target === 'keep') return row.actual.keep;
    if (target === 'ret5') return row.actual.ret5;
    if (target === 'views' || target === 'realviews') return row.actual.viewsCurrent;
    if (target === 'outlier') return row.actual.outlierCurrent;
    if (target === 'gt10M') return row.actual.hit10MCurrent;
    return null;
}

function normalizePrediction(value, target, definition) {
    if (!finite(value)) return null;
    if (target === 'views' || target === 'realviews') return toViewsFromFeature(value, definition);
    return Number(value);
}

const LEDGER_OUTCOME_METRIC_KEYS = Object.freeze([
    'spearman',
    'withinAccountSpearman',
    'auc',
    'oofR2',
    'oofSpearman',
    'oofMae',
    'oofMedianFactorError',
    'oofAuc',
    'oofBrier',
    'n',
    'oofN',
    'qValue',
    'evidence',
]);

function coordinateModelValue(row, column) {
    const value = ledgerValue(row, column);
    if (!finite(value)) return null;
    if (column.unit === 'views' || column.target === 'views' || column.target === 'realviews') {
        return Math.log10(Math.max(0, Number(value)) + 1);
    }
    if (column.target === 'outlier') {
        return Math.log10(Math.max(0, Number(value)) + 1);
    }
    return Number(value);
}

function coordinateFoldMode(column) {
    if (!column || column.valueClass === 'observed_outcome') return 'outcome_not_predictor';
    if (column.protocol === 'account'
        || column.family === 'accountHeldout'
        || column.family === 'accountForecast') {
        return 'leave_account_out';
    }
    return 'video_5fold';
}

function coordinateValidationTier(column) {
    if (!column || column.valueClass === 'observed_outcome') return 'outcome_not_predictor';
    if (column.family === 'accountHeldout') return 'account_held_out_coordinate_plus_leave_account_out_calibration';
    if (column.family === 'accountForecast') return 'account_held_out_forecast_plus_leave_account_out_calibration';
    if (column.family === 'videoHeldout') return 'video_held_out_coordinate_plus_video_5fold_calibration';
    if (column.family === 'videoForecast') return 'video_held_out_forecast_plus_video_5fold_calibration';
    if (column.family === 'stored') return 'stored_coordinate_plus_video_5fold_calibration';
    if (column.family === 'legacy') return 'legacy_diagnostic_plus_video_5fold_calibration';
    return 'video_5fold_calibration';
}

function coordinatePlainEnglish(column, outcome) {
    if (column.valueClass === 'observed_outcome') {
        return `${column.label} is measured truth, not a candidate predictor. It is present so every score-ledger column remains auditable, but it is excluded from ranking and calibration against ${outcome.label}.`;
    }
    const protocol = coordinateFoldMode(column) === 'leave_account_out'
        ? 'The one-coordinate calibration is trained on other creator accounts and then tested on the creator account that was left out.'
        : 'The one-coordinate calibration is trained on four deterministic video folds and tested on the fifth, so a video outcome never calibrates its own prediction.';
    const upstream = column.family === 'stored'
        ? 'This is the exact production value stored with the scored video; the calibration is held out, but the upstream production axis may still be in-sample for its original training account.'
        : (column.family === 'legacy'
            ? 'This is a legacy diagnostic retained only for comparison and is never promoted to a canonical production score.'
            : column.description);
    return `${upstream} This cell tests whether that exact coordinate predicts ${outcome.label}. ${protocol}`;
}

function fitLinearSingleCalibration(points) {
    if (!points.length) return null;
    const xMean = average(points.map(point => point.predicted));
    const yMean = average(points.map(point => point.actual));
    const denominator = points.reduce(
        (sum, point) => sum + (point.predicted - xMean) ** 2,
        0,
    );
    const slope = denominator > 1e-12
        ? points.reduce(
            (sum, point) => sum + (point.predicted - xMean) * (point.actual - yMean),
            0,
        ) / denominator
        : 0;
    const intercept = yMean - slope * xMean;
    return {
        baseline: yMean,
        predict(value) {
            return intercept + slope * Number(value);
        },
    };
}

function fitLogisticSingleCalibration(points) {
    if (!points.length) return null;
    const xMean = average(points.map(point => point.predicted));
    const variance = average(points.map(point => (point.predicted - xMean) ** 2));
    const xScale = finite(variance) && Number(variance) > 1e-12 ? Math.sqrt(variance) : 1;
    const positives = points.reduce((sum, point) => sum + (point.actual >= 0.5 ? 1 : 0), 0);
    const baseline = (positives + 0.5) / (points.length + 1);
    let intercept = Math.log(baseline / (1 - baseline));
    let slope = 0;
    for (let iteration = 0; iteration < 50; iteration++) {
        let gradientIntercept = 0, gradientSlope = 0;
        let hessianIntercept = 1e-8, hessianCross = 0, hessianSlope = 1e-6;
        for (const point of points) {
            const x = (point.predicted - xMean) / xScale;
            const y = point.actual >= 0.5 ? 1 : 0;
            const linear = clamp(intercept + slope * x, -30, 30);
            const probability = 1 / (1 + Math.exp(-linear));
            const residual = y - probability;
            const weight = Math.max(1e-8, probability * (1 - probability));
            gradientIntercept += residual;
            gradientSlope += residual * x;
            hessianIntercept += weight;
            hessianCross += weight * x;
            hessianSlope += weight * x * x;
        }
        const determinant = hessianIntercept * hessianSlope - hessianCross * hessianCross;
        if (Math.abs(determinant) < 1e-12) break;
        const interceptStep = (
            gradientIntercept * hessianSlope - gradientSlope * hessianCross
        ) / determinant;
        const slopeStep = (
            gradientSlope * hessianIntercept - gradientIntercept * hessianCross
        ) / determinant;
        intercept += interceptStep;
        slope += slopeStep;
        if (Math.max(Math.abs(interceptStep), Math.abs(slopeStep)) < 1e-8) break;
    }
    return {
        baseline,
        predict(value) {
            const x = (Number(value) - xMean) / xScale;
            return 1 / (1 + Math.exp(-clamp(intercept + slope * x, -30, 30)));
        },
    };
}

function singleCoordinateOof(points, outcome, foldMode) {
    const eligible = (points || []).filter(point => (
        point && point.id && point.accountId
        && finite(point.actual) && finite(point.predicted)
    )).map(point => ({
        id: String(point.id),
        accountId: String(point.accountId),
        actual: Number(point.actual),
        predicted: Number(point.predicted),
    }));
    const mode = foldMode === 'leave_account_out' ? 'leave_account_out' : 'video_5fold';
    const folds = mode === 'leave_account_out'
        ? [...new Set(eligible.map(point => point.accountId))].sort()
        : [0, 1, 2, 3, 4];
    const predictions = [];
    const foldAudit = [];
    for (const fold of folds) {
        const inTest = point => mode === 'leave_account_out'
            ? point.accountId === fold
            : stableHash(`ledger-oof:${point.id}`) % 5 === fold;
        const training = eligible.filter(point => !inTest(point));
        const testing = eligible.filter(inTest);
        if (!testing.length || !training.length) continue;
        const calibrator = outcome.unit === 'binary'
            ? fitLogisticSingleCalibration(training)
            : fitLinearSingleCalibration(training);
        if (!calibrator) continue;
        const trainingIds = new Set(training.map(point => point.id));
        const testingIds = new Set(testing.map(point => point.id));
        const overlap = [...testingIds].filter(id => trainingIds.has(id));
        const trainingAccounts = [...new Set(training.map(point => point.accountId))].sort();
        const testingAccounts = [...new Set(testing.map(point => point.accountId))].sort();
        foldAudit.push({
            fold: String(fold),
            trainingN: training.length,
            testingN: testing.length,
            trainingVideoIdSha256: sha256Ids(training.map(point => point.id)),
            testingVideoIdSha256: sha256Ids(testing.map(point => point.id)),
            trainingTestOverlapN: overlap.length,
            trainingAccounts,
            testingAccounts,
            heldOutAccountLeakageN: mode === 'leave_account_out'
                ? testingAccounts.filter(account => trainingAccounts.includes(account)).length
                : null,
        });
        for (const point of testing) {
            predictions.push({
                ...point,
                baseline: calibrator.baseline,
                calibrated: calibrator.predict(point.predicted),
                fold: String(fold),
            });
        }
    }
    const predictionCounts = predictions.reduce((counts, point) => {
        counts[point.id] = (counts[point.id] || 0) + 1;
        return counts;
    }, {});
    return {
        mode,
        eligibleN: eligible.length,
        predictions,
        audit: {
            mode,
            requestedFolds: folds.length,
            completedFolds: foldAudit.length,
            folds: foldAudit,
            trainingTestOverlapN: foldAudit.reduce((sum, fold) => sum + fold.trainingTestOverlapN, 0),
            heldOutAccountLeakageN: mode === 'leave_account_out'
                ? foldAudit.reduce((sum, fold) => sum + fold.heldOutAccountLeakageN, 0)
                : null,
            duplicateTestPredictionN: Object.values(predictionCounts).filter(count => count !== 1).length,
            predictedN: predictions.length,
        },
    };
}

function rawCoordinateAssociation(points, outcome, scopeKey) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted))
        .map(point => ({
            id: point.id,
            accountId: point.accountId,
            actual: Number(point.actual),
            predicted: Number(point.predicted),
        }));
    const actual = observed.map(point => point.actual);
    const predicted = observed.map(point => point.predicted);
    const rawSpearman = observed.length >= 3 ? spearman(actual, predicted) : null;
    const within = observed.length >= 3 ? centeredCorrelation(observed, true) : null;
    const rawAuc = outcome.unit === 'binary' && observed.length >= 3
        ? rocAuc(actual.map(value => value >= 0.5 ? 1 : 0), predicted)
        : null;
    const primary = outcome.unit === 'binary'
        ? rawAuc
        : (scopeKey === 'pooled' && finite(within) ? within : rawSpearman);
    const inference = outcome.unit === 'binary'
        ? aucInference(observed, false)
        : correlationInference(primary, observed.length);
    return {
        n: observed.length,
        spearman: round(rawSpearman),
        withinAccountSpearman: round(within),
        auc: round(rawAuc),
        pValue: inference.p,
    };
}

function oofCoordinateMetrics(oof, outcome) {
    if (!oof || !oof.predictions.length) {
        return {
            oofR2: null,
            oofSpearman: null,
            oofMae: null,
            oofMedianFactorError: null,
            oofAuc: null,
            oofBrier: null,
            oofN: 0,
        };
    }
    if (outcome.unit === 'binary') {
        const binary = binaryMetrics(oof.predictions.map(point => ({
            actual: point.actual,
            predicted: point.calibrated,
        })), oof.eligibleN);
        return {
            oofR2: null,
            oofSpearman: null,
            oofMae: null,
            oofMedianFactorError: null,
            oofAuc: number(binary.auc),
            oofBrier: number(binary.brier),
            oofN: binary.n || 0,
        };
    }
    const transformedOutcome = !!outcome.transform;
    const regression = regressionMetrics(oof.predictions.map(point => ({
        id: point.id,
        accountId: point.accountId,
        actual: point.actual,
        predicted: point.calibrated,
        baseline: point.baseline,
    })), {
        total: oof.eligibleN,
        logScale: transformedOutcome,
    });
    return {
        oofR2: number(regression.r2),
        oofSpearman: number(regression.spearman),
        oofMae: transformedOutcome ? null : number(regression.mae),
        oofMedianFactorError: transformedOutcome ? number(regression.medianFactorError) : null,
        oofAuc: null,
        oofBrier: null,
        oofN: regression.n || 0,
    };
}

function ledgerEvidence(metrics, column) {
    if (column.valueClass === 'observed_outcome') return 'outcome_not_predictor';
    if (!metrics || metrics.n < 20 || metrics.oofN < 20) return 'insufficient_evidence';
    const diagnosticOnly = column.family === 'stored' || column.family === 'legacy';
    if (finite(metrics.oofAuc)) {
        if (finite(metrics.qValue) && metrics.qValue <= 0.05 && metrics.oofAuc >= 0.65) {
            return diagnosticOnly ? 'strong_diagnostic_signal_not_blind' : 'strong_blind_signal';
        }
        if (metrics.oofAuc >= 0.6) {
            return diagnosticOnly ? 'directional_diagnostic_signal_not_blind' : 'directional_blind_signal';
        }
        return 'not_predictive';
    }
    const rank = Math.abs(number(metrics.oofSpearman) || 0);
    if (finite(metrics.qValue) && metrics.qValue <= 0.05 && rank >= 0.3 && number(metrics.oofR2) > 0) {
        return diagnosticOnly ? 'strong_diagnostic_signal_not_blind' : 'strong_blind_signal';
    }
    if (rank >= 0.2) {
        return diagnosticOnly ? 'directional_diagnostic_signal_not_blind' : 'directional_blind_signal';
    }
    return 'not_predictive';
}

function adjustLedgerQValues(entries) {
    const eligible = entries.filter(entry => finite(entry._pValue))
        .sort((left, right) => left._pValue - right._pValue);
    let running = 1;
    for (let index = eligible.length - 1; index >= 0; index--) {
        running = Math.min(running, eligible[index]._pValue * eligible.length / (index + 1));
        eligible[index].metrics.qValue = round(running, 8);
    }
    entries.forEach(entry => { delete entry._pValue; });
}

function buildLedgerOutcomeMatrix(rows, coordinateRegistry, scopeKey, calibrationRows = rows) {
    const matrix = {};
    for (const outcome of OUTCOME_DEFINITIONS) {
        const outcomeRows = rows.filter(row => finite(outcome.accessor(row))).length;
        const coordinates = coordinateRegistry.columns.map(column => {
            const points = rows.map(row => ({
                id: row.id,
                accountId: row.accountId,
                actual: transformOutcome(outcome.accessor(row), outcome),
                predicted: coordinateModelValue(row, column),
                validationSource: row.validationSource || 'saved_channel_join',
            }));
            const raw = rawCoordinateAssociation(points, outcome, scopeKey);
            const foldMode = coordinateFoldMode(column);
            const isOutcome = column.valueClass === 'observed_outcome';
            const evaluationIds = new Set(points.map(point => point.id));
            const calibrationPoints = calibrationRows.map(row => ({
                id: row.id,
                accountId: row.accountId,
                actual: transformOutcome(outcome.accessor(row), outcome),
                predicted: coordinateModelValue(row, column),
                validationSource: row.validationSource || 'saved_channel_join',
            }));
            const fullOof = isOutcome
                ? null
                : singleCoordinateOof(calibrationPoints, outcome, foldMode);
            const oof = fullOof ? {
                ...fullOof,
                eligibleN: raw.n,
                predictions: fullOof.predictions.filter(point => evaluationIds.has(point.id)),
            } : null;
            const oofMetrics = oofCoordinateMetrics(oof, outcome);
            const coordinateRows = points.filter(point => finite(point.predicted)).length;
            const pairedRows = raw.n;
            const pairedBlindOnlyRows = points.filter(point => (
                point.validationSource === 'predictor_blind_inputs_only'
                && finite(point.actual) && finite(point.predicted)
            )).length;
            const available = !isOutcome && pairedRows >= 3;
            let availabilityNote = null;
            if (isOutcome) {
                availabilityNote = 'outcome_not_predictor: measured outcomes are never ranked or calibrated as predictors.';
            } else if (!pairedRows) {
                availabilityNote = 'No row has both this coordinate and this observed outcome.';
            } else if (pairedRows < 3) {
                availabilityNote = 'Fewer than three paired rows; association and calibration are not estimable.';
            } else if (!oofMetrics.oofN) {
                availabilityNote = foldMode === 'leave_account_out'
                    ? 'Raw association is available, but this scope does not contain another creator account for leave-account-out calibration.'
                    : 'Raw association is available, but no complete held-out calibration fold could be fit.';
            }
            const metrics = {
                spearman: isOutcome ? null : raw.spearman,
                withinAccountSpearman: isOutcome ? null : raw.withinAccountSpearman,
                auc: isOutcome ? null : raw.auc,
                oofR2: isOutcome ? null : oofMetrics.oofR2,
                oofSpearman: isOutcome ? null : oofMetrics.oofSpearman,
                oofMae: isOutcome ? null : oofMetrics.oofMae,
                oofMedianFactorError: isOutcome ? null : oofMetrics.oofMedianFactorError,
                oofAuc: isOutcome ? null : oofMetrics.oofAuc,
                oofBrier: isOutcome ? null : oofMetrics.oofBrier,
                n: pairedRows,
                oofN: isOutcome ? 0 : oofMetrics.oofN,
                qValue: null,
                evidence: null,
            };
            const entry = {
                coordinateId: column.id,
                label: column.label,
                family: column.family,
                protocol: column.protocol,
                valueClass: column.valueClass,
                target: column.target,
                group: column.group,
                unit: column.unit,
                available,
                availabilityNote,
                validationTier: coordinateValidationTier(column),
                plainEnglish: coordinatePlainEnglish(column, outcome),
                coverage: {
                    cohortRows: rows.length,
                    outcomeRows,
                    coordinateRows,
                    pairedRows,
                    pairedFraction: rows.length ? round(pairedRows / rows.length) : 0,
                    pairedBlindOnlyRows,
                    accountCount: new Set(points.filter(point => (
                        finite(point.actual) && finite(point.predicted)
                    )).map(point => point.accountId)).size,
                    calibrationMode: foldMode,
                    requestedFolds: oof ? oof.audit.requestedFolds : 0,
                    completedFolds: oof ? oof.audit.completedFolds : 0,
                    trainingTestOverlapN: oof ? oof.audit.trainingTestOverlapN : 0,
                    heldOutAccountLeakageN: oof ? oof.audit.heldOutAccountLeakageN : null,
                    duplicateTestPredictionN: oof ? oof.audit.duplicateTestPredictionN : 0,
                },
                metrics,
                _pValue: isOutcome ? null : raw.pValue,
            };
            return entry;
        });
        matrix[outcome.key] = {
            outcome: {
                ...Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'accessor')),
                observedRows: outcomeRows,
                cohortRows: rows.length,
                plainEnglish: `Measured ${outcome.label}. Every canonical score-ledger coordinate is tested against this same outcome definition.`,
            },
            coordinates,
        };
    }
    const columnsById = new Map(coordinateRegistry.columns.map(column => [column.id, column]));
    const globalFamily = Object.values(matrix).flatMap(result => result.coordinates);
    adjustLedgerQValues(globalFamily);
    const globallyEligibleTests = globalFamily.filter(entry => finite(entry.metrics.qValue)).length;
    Object.values(matrix).forEach(result => {
        result.outcome.qValueFamily = 'global_all_eligible_103x13';
        result.outcome.qValueEligibleTests = globallyEligibleTests;
    });
    globalFamily.forEach(entry => {
        entry.metrics.evidence = ledgerEvidence(
            entry.metrics,
            columnsById.get(entry.coordinateId),
        );
        assertLedgerMetricSchema(entry.metrics);
    });
    return matrix;
}

function assertLedgerMetricSchema(metrics) {
    const keys = Object.keys(metrics);
    if (keys.length !== LEDGER_OUTCOME_METRIC_KEYS.length
        || LEDGER_OUTCOME_METRIC_KEYS.some(key => !Object.prototype.hasOwnProperty.call(metrics, key))) {
        throw new Error(`Ledger outcome metric schema mismatch: ${keys.join(', ')}`);
    }
}

function indicatorMetrics(rows, definition, accessor) {
    const target = definition.target;
    const rawPoints = rows.map(row => ({
        id: row.id,
        accountId: row.accountId,
        actual: actualForTarget(row, target),
        predicted: normalizePrediction(accessor(row, 'raw'), target, definition),
    }));
    const percentilePoints = rows.map(row => ({
        id: row.id,
        accountId: row.accountId,
        actual: actualForTarget(row, target),
        predicted: accessor(row, 'percentile'),
    })).filter(point => finite(point.actual) && finite(point.predicted));
    if (target === 'gt10M') {
        return {
            raw: binaryMetrics(rawPoints, rows.length),
            percentileSpearman: percentilePoints.length
                ? round(spearman(
                    percentilePoints.map(point => point.actual),
                    percentilePoints.map(point => point.predicted)
                ))
                : null,
        };
    }
    if (target === 'views' || target === 'realviews' || target === 'outlier') {
        const positive = rawPoints.filter(point => finite(point.actual) && point.actual >= 0 && finite(point.predicted) && point.predicted >= 0)
            .map(point => ({
                ...point,
                actual: Math.log10(point.actual + 1),
                predicted: Math.log10(point.predicted + 1),
            }));
        return {
            raw: regressionMetrics(positive, { total: rows.length, logScale: true }),
            percentileSpearman: percentilePoints.length
                ? round(spearman(
                    percentilePoints.map(point => Math.log10(Math.max(0, point.actual) + 1)),
                    percentilePoints.map(point => point.predicted)
                ))
                : null,
        };
    }
    return {
        raw: regressionMetrics(rawPoints, { total: rows.length }),
        percentileSpearman: percentilePoints.length
            ? round(spearman(
                percentilePoints.map(point => point.actual),
                percentilePoints.map(point => point.predicted)
            ))
            : null,
    };
}

function blindDefinition(featureName) {
    const match = String(featureName).match(/^(visual|text|together)\.(keep|ret5|views|realviews|outlier|gt10M)\.(raw|percentile)$/);
    if (!match) return null;
    const stored = contract.features.find(feature => feature.key === `${match[1]}.${match[2]}`);
    return {
        key: featureName,
        group: match[1],
        target: match[2],
        variant: match[3],
        unit: match[2] === 'views' || match[2] === 'realviews' ? 'log10_views' : (stored && stored.unit),
        label: `${match[1]} ${match[2]} ${match[3]}`,
    };
}

function buildBlindIndicatorMetrics(rows, protocol) {
    const names = rows[0] ? rows[0].blindFeatureNames : [];
    return names.map(blindDefinition).filter(Boolean).map(definition => {
        const points = rows.map(row => ({
            id: row.id,
            accountId: row.accountId,
            actual: actualForTarget(row, definition.target),
            predicted: blindFeatureValue(row, definition.key, protocol),
        }));
        let metrics;
        if (definition.variant === 'percentile' && definition.target !== 'gt10M') {
            metrics = rankMetrics(points, rows.length);
        } else if (definition.target === 'gt10M') {
            metrics = binaryMetrics(points, rows.length);
        } else if (definition.target === 'views' || definition.target === 'realviews' || definition.target === 'outlier') {
            const transformed = points.filter(point => finite(point.actual) && point.actual >= 0 && finite(point.predicted))
                .map(point => ({
                    ...point,
                    actual: Math.log10(point.actual + 1),
                    predicted: Number(point.predicted),
                }));
            metrics = regressionMetrics(transformed, { total: rows.length, logScale: true });
        } else {
            metrics = regressionMetrics(points, { total: rows.length });
        }
        return { ...definition, metrics };
    });
}

function modelMetrics(rows, actualPath, predictedPath, logScale) {
    const read = (row, path) => path.split('.').reduce((value, key) => value == null ? null : value[key], row);
    const points = rows.map(row => {
        let actual = read(row, actualPath), predicted = read(row, predictedPath);
        if (logScale && finite(actual) && finite(predicted)) {
            actual = Math.log10(Math.max(0, Number(actual)) + 1);
            predicted = Math.log10(Math.max(0, Number(predicted)) + 1);
        }
        return { id: row.id, accountId: row.accountId, actual, predicted };
    });
    return regressionMetrics(points, { total: rows.length, logScale: !!logScale });
}

const DIRECT_BLIND_RAW_FEATURES = Object.freeze(
    contract.features.filter(feature => feature.group !== 'novelty').map(feature => `${feature.key}.raw`)
);
const STRICT_FORECAST_RAW_FEATURES = Object.freeze(
    contract.features.filter(feature => (
        feature.group !== 'novelty' && ['views', 'outlier', 'gt10M'].includes(feature.target)
    )).map(feature => `${feature.key}.raw`)
);
const RIDGE_LAMBDAS = Object.freeze([0.01, 0.1, 1, 10, 100, 1000]);

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function solveLinearSystem(matrix, rightHandSide) {
    const size = matrix.length;
    if (!size || rightHandSide.length !== size) return null;
    const columns = rightHandSide[0] ? rightHandSide[0].length : 0;
    const augmented = matrix.map((row, index) => row.slice().concat(rightHandSide[index]));
    for (let column = 0; column < size; column++) {
        let pivot = column;
        for (let row = column + 1; row < size; row++) {
            if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
        }
        if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
        if (pivot !== column) [augmented[pivot], augmented[column]] = [augmented[column], augmented[pivot]];
        const divisor = augmented[column][column];
        for (let index = column; index < size + columns; index++) augmented[column][index] /= divisor;
        for (let row = 0; row < size; row++) {
            if (row === column) continue;
            const factor = augmented[row][column];
            if (factor === 0) continue;
            for (let index = column; index < size + columns; index++) {
                augmented[row][index] -= factor * augmented[column][index];
            }
        }
    }
    return augmented.map(row => row.slice(size));
}

function fitRidgeMulti(rows, protocol, targets, lambda) {
    if (rows.length < 8 || !targets.length) return null;
    const featureMeans = STRICT_FORECAST_RAW_FEATURES.map(name => {
        const values = rows.map(row => blindFeatureValue(row, name, protocol)).filter(finite);
        return values.length ? average(values) : 0;
    });
    const featureScales = STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
        const values = rows.map(row => blindFeatureValue(row, name, protocol)).filter(finite);
        const variance = values.length
            ? average(values.map(value => (Number(value) - featureMeans[index]) ** 2))
            : 0;
        return variance > 1e-12 ? Math.sqrt(variance) : 1;
    });
    const targetMeans = targets.map(target => average(rows.map(row => Number(target.accessor(row)))));
    const targetScales = targets.map((target, index) => {
        const variance = average(rows.map(row => (Number(target.accessor(row)) - targetMeans[index]) ** 2));
        return variance > 1e-12 ? Math.sqrt(variance) : 1;
    });
    const parameterCount = STRICT_FORECAST_RAW_FEATURES.length + 1;
    const left = Array.from({ length: parameterCount }, () => Array(parameterCount).fill(0));
    const right = Array.from({ length: parameterCount }, () => Array(targets.length).fill(0));
    for (const row of rows) {
        const x = [1, ...STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
            const value = blindFeatureValue(row, name, protocol);
            return finite(value) ? (Number(value) - featureMeans[index]) / featureScales[index] : 0;
        })];
        const y = targets.map((target, index) => (
            (Number(target.accessor(row)) - targetMeans[index]) / targetScales[index]
        ));
        for (let first = 0; first < parameterCount; first++) {
            for (let second = 0; second < parameterCount; second++) left[first][second] += x[first] * x[second];
            for (let target = 0; target < targets.length; target++) right[first][target] += x[first] * y[target];
        }
    }
    for (let index = 1; index < parameterCount; index++) left[index][index] += Number(lambda);
    left[0][0] += 1e-9;
    const coefficients = solveLinearSystem(left, right);
    if (!coefficients) return null;
    return {
        lambda: Number(lambda),
        targetMeans,
        targetScales,
        predict(row) {
            const x = [1, ...STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
                const value = blindFeatureValue(row, name, protocol);
                return finite(value) ? (Number(value) - featureMeans[index]) / featureScales[index] : 0;
            })];
            return targets.map((target, targetIndex) => {
                const standardized = x.reduce(
                    (sum, value, featureIndex) => sum + value * coefficients[featureIndex][targetIndex],
                    0
                );
                return standardized * targetScales[targetIndex] + targetMeans[targetIndex];
            });
        },
    };
}

function selectRidgeLambda(rows, protocol, targets, salt) {
    const foldCount = rows.length >= 80 ? 4 : 3;
    let best = { lambda: RIDGE_LAMBDAS[0], error: Infinity };
    for (const lambda of RIDGE_LAMBDAS) {
        let error = 0, count = 0;
        for (let fold = 0; fold < foldCount; fold++) {
            const training = rows.filter(row => stableHash(`${salt}:${row.id}`) % foldCount !== fold);
            const testing = rows.filter(row => stableHash(`${salt}:${row.id}`) % foldCount === fold);
            const model = fitRidgeMulti(training, protocol, targets, lambda);
            if (!model || !testing.length) continue;
            for (const row of testing) {
                const predicted = model.predict(row);
                targets.forEach((target, index) => {
                    const scale = model.targetScales[index] || 1;
                    const residual = (predicted[index] - Number(target.accessor(row))) / scale;
                    error += residual * residual;
                    count++;
                });
            }
        }
        const meanError = count ? error / count : Infinity;
        if (meanError < best.error - 1e-12 || (Math.abs(meanError - best.error) <= 1e-12 && lambda > best.lambda)) {
            best = { lambda, error: meanError };
        }
    }
    return best;
}

function crossValidatedMulti(rows, protocol, targets, foldMode) {
    const eligible = rows.filter(row => targets.every(target => finite(target.accessor(row))));
    const predictions = new Map(), baselines = new Map(), selected = [];
    const outerFoldPopulations = [];
    const folds = foldMode === 'account'
        ? [...new Set(eligible.map(row => row.accountId))]
        : [0, 1, 2, 3, 4];
    for (const fold of folds) {
        const inFold = row => foldMode === 'account'
            ? row.accountId === fold
            : stableHash(`outer:${row.id}`) % 5 === fold;
        const training = eligible.filter(row => !inFold(row));
        const testing = eligible.filter(inFold);
        if (!testing.length || training.length < 8) continue;
        outerFoldPopulations.push({
            fold: String(fold),
            trainingRowCount: training.length,
            trainingVideoIdSha256: sha256Ids(training.map(row => row.id)),
            testingRowCount: testing.length,
            testingVideoIdSha256: sha256Ids(testing.map(row => row.id)),
        });
        const choice = selectRidgeLambda(training, protocol, targets, `inner:${foldMode}:${fold}`);
        const model = fitRidgeMulti(training, protocol, targets, choice.lambda);
        if (!model) continue;
        selected.push({ fold: String(fold), lambda: choice.lambda, innerStandardizedMse: round(choice.error) });
        for (const row of testing) {
            predictions.set(row.id, model.predict(row));
            baselines.set(row.id, model.targetMeans.slice());
        }
    }
    return {
        eligible: eligible.length,
        eligibleVideoIdSha256: eligible.length ? sha256Ids(eligible.map(row => row.id)) : null,
        outerFoldPopulations,
        predictions,
        baselines,
        selected,
        featureNames: STRICT_FORECAST_RAW_FEATURES.slice(),
        targetKeys: targets.map(target => target.key),
    };
}

function forecastValue(row, protocol, key) {
    return row && row.predictions && row.predictions.score21
        && row.predictions.score21[protocol] && row.predictions.score21[protocol][key];
}

function forecastBaseline(row, protocol, key) {
    return row && row.predictions && row.predictions.score21Baseline
        && row.predictions.score21Baseline[protocol] && row.predictions.score21Baseline[protocol][key];
}

function attachScore21Forecasts(rows) {
    const scalarTargets = [
        { key: 'keep', accessor: row => row.actual.keep },
        { key: 'ret5', accessor: row => row.actual.ret5 },
        { key: 'averageRetention', accessor: row => row.actual.averageRetention },
        { key: 'logViews', accessor: row => finite(row.actual.viewsCurrent) ? Math.log10(Math.max(0, Number(row.actual.viewsCurrent)) + 1) : null },
        { key: 'logOutlier', accessor: row => finite(row.actual.outlierCurrent) ? Math.log10(Math.max(0, Number(row.actual.outlierCurrent)) + 1) : null },
        { key: 'hit10M', accessor: row => row.actual.hit10MCurrent },
    ];
    const checkpointTargets = [
        { key: 'survival5', accessor: row => curveValue(row, 'normalized', 5) },
        { key: 'survival10', accessor: row => curveValue(row, 'normalized', 10) },
        { key: 'survival20', accessor: row => curveValue(row, 'normalized', 20) },
        { key: 'drop5', accessor: row => curveValue(row, 'drop', 5) },
        { key: 'drop10', accessor: row => curveValue(row, 'drop', 10) },
        { key: 'drop20', accessor: row => curveValue(row, 'drop', 20) },
    ];
    const curveTargets = CURVE_SECONDS.slice(1).map(second => ({
        key: `second${second}`,
        accessor: row => curveValue(row, 'normalized', second),
    }));
    const runs = {
        video: {
            scalar: crossValidatedMulti(rows, 'video', scalarTargets, 'video'),
            checkpoints: crossValidatedMulti(rows, 'video', checkpointTargets, 'video'),
            curve: crossValidatedMulti(rows, 'video', curveTargets, 'video'),
        },
        account: {
            scalar: crossValidatedMulti(rows, 'account', scalarTargets, 'account'),
            checkpoints: crossValidatedMulti(rows, 'account', checkpointTargets, 'account'),
            curve: crossValidatedMulti(rows, 'account', curveTargets, 'account'),
        },
    };
    for (const row of rows) {
        row.predictions.score21 = {};
        row.predictions.score21Baseline = {};
        for (const protocol of ['video', 'account']) {
            const scalar = runs[protocol].scalar.predictions.get(row.id);
            const scalarBaseline = runs[protocol].scalar.baselines.get(row.id);
            const checkpoints = runs[protocol].checkpoints.predictions.get(row.id);
            const checkpointBaseline = runs[protocol].checkpoints.baselines.get(row.id);
            const curve = runs[protocol].curve.predictions.get(row.id);
            const curveBaseline = runs[protocol].curve.baselines.get(row.id);
            const assign = (values, checkpointValues, curveValues) => {
                if (!values) return null;
                const byKey = Object.fromEntries(scalarTargets.map((target, index) => [target.key, values[index]]));
                const checkpointsByKey = checkpointValues
                    ? Object.fromEntries(checkpointTargets.map((target, index) => [target.key, checkpointValues[index]]))
                    : {};
                return {
                    keep: round(byKey.keep),
                    swipe: round(100 - byKey.keep),
                    ret5: round(byKey.ret5),
                    averageRetention: round(byKey.averageRetention),
                    views: round(Math.max(0, 10 ** byKey.logViews - 1), 2),
                    outlier: round(Math.max(0, 10 ** byKey.logOutlier - 1)),
                    hit10M: round(clamp(byKey.hit10M, 0, 1)),
                    survival5: round(checkpointsByKey.survival5),
                    survival10: round(checkpointsByKey.survival10),
                    survival20: round(checkpointsByKey.survival20),
                    drop5: round(checkpointsByKey.drop5),
                    drop10: round(checkpointsByKey.drop10),
                    drop20: round(checkpointsByKey.drop20),
                    retentionCurve: curveValues ? [100, ...curveValues.map(value => round(value))] : null,
                };
            };
            row.predictions.score21[protocol] = assign(scalar, checkpoints, curve);
            row.predictions.score21Baseline[protocol] = assign(scalarBaseline, checkpointBaseline, curveBaseline);
        }
    }
    return {
        inputs: {
            count: STRICT_FORECAST_RAW_FEATURES.length,
            featureNames: STRICT_FORECAST_RAW_FEATURES.slice(),
            directScoresAvailableForAssociation: DIRECT_BLIND_RAW_FEATURES.length,
            excludedPrivateLabelAlignedScores: DIRECT_BLIND_RAW_FEATURES.filter(name => !STRICT_FORECAST_RAW_FEATURES.includes(name)),
            excludedStoredNovelty: contract.features.filter(feature => feature.group === 'novelty').map(feature => feature.key),
            note: 'Every direct score remains in the association matrix. The combined forecast uses only the nine Visual/Text/Both public views, outlier, and 10M axes because they were rebuilt after excluding both validation creators. Private-label-aligned keep, ret5, and realistic-views axes are not stacked into a second model, which avoids cross-fit leakage.',
        },
        protocols: Object.fromEntries(Object.entries(runs).map(([protocol, run]) => [protocol, {
            scalarEligible: run.scalar.eligible,
            scalarEligibleVideoIdSha256: run.scalar.eligibleVideoIdSha256,
            checkpointEligible: run.checkpoints.eligible,
            checkpointEligibleVideoIdSha256: run.checkpoints.eligibleVideoIdSha256,
            curveEligibleThrough20s: run.curve.eligible,
            curveEligibleVideoIdSha256: run.curve.eligibleVideoIdSha256,
            scalarFolds: run.scalar.selected,
            scalarFoldPopulations: run.scalar.outerFoldPopulations,
            checkpointFolds: run.checkpoints.selected,
            checkpointFoldPopulations: run.checkpoints.outerFoldPopulations,
            curveFolds: run.curve.selected,
            curveFoldPopulations: run.curve.outerFoldPopulations,
        }])),
    };
}

function score21ForecastMetrics(rows, protocol) {
    const continuous = [
        ['keep', 'keep', false],
        ['swipe', 'keep', false],
        ['ret5', 'ret5', false],
        ['averageRetention', 'averageRetention', false],
        ['views', 'viewsCurrent', true],
        ['outlier', 'outlierCurrent', true],
        ['survival5', 'survival5', false],
        ['survival10', 'survival10', false],
        ['survival20', 'survival20', false],
        ['drop5', 'drop5', false],
        ['drop10', 'drop10', false],
        ['drop20', 'drop20', false],
    ];
    const metrics = {};
    for (const [key, actualKey, logScale] of continuous) {
        const points = rows.map(row => {
            let actual = key === 'swipe'
                ? (finite(row.actual.keep) ? 100 - Number(row.actual.keep) : null)
                : (String(actualKey).startsWith('survival')
                    ? curveValue(row, 'normalized', Number(actualKey.replace('survival', '')))
                    : String(actualKey).startsWith('drop')
                        ? curveValue(row, 'drop', Number(actualKey.replace('drop', '')))
                        : row.actual[actualKey]);
            let predicted = forecastValue(row, protocol, key);
            let baseline = forecastBaseline(row, protocol, key);
            if (logScale && finite(actual) && finite(predicted)) {
                actual = Math.log10(Math.max(0, Number(actual)) + 1);
                predicted = Math.log10(Math.max(0, Number(predicted)) + 1);
                baseline = finite(baseline) ? Math.log10(Math.max(0, Number(baseline)) + 1) : null;
            }
            return { id: row.id, accountId: row.accountId, actual, predicted, baseline };
        });
        metrics[key] = regressionMetrics(points, { total: rows.length, logScale });
    }
    metrics.hit10M = binaryMetrics(rows.map(row => ({
        actual: row.actual.hit10MCurrent,
        predicted: forecastValue(row, protocol, 'hit10M'),
    })), rows.length);
    return metrics;
}

function retentionForecastMetrics(rows, protocol) {
    const bySecond = CURVE_SECONDS.map((second, index) => {
        const points = rows.map(row => ({
            id: row.id,
            accountId: row.accountId,
            actual: curveValue(row, 'normalized', second),
            predicted: index === 0 ? 100 : (
                forecastValue(row, protocol, 'retentionCurve')
                && forecastValue(row, protocol, 'retentionCurve')[index]
            ),
            baseline: index === 0 ? 100 : (
                forecastBaseline(row, protocol, 'retentionCurve')
                && forecastBaseline(row, protocol, 'retentionCurve')[index]
            ),
        }));
        return { second, metrics: regressionMetrics(points, { total: rows.length }) };
    });
    const allResiduals = [];
    for (const row of rows) {
        const predicted = forecastValue(row, protocol, 'retentionCurve');
        if (!Array.isArray(predicted)) continue;
        CURVE_SECONDS.slice(1).forEach((second, offset) => {
            const actual = curveValue(row, 'normalized', second);
            const estimate = predicted[offset + 1];
            if (finite(actual) && finite(estimate)) allResiduals.push(Number(estimate) - Number(actual));
        });
    }
    return {
        seconds: CURVE_SECONDS.slice(),
        bySecond,
        curves: rows.filter(row => Array.isArray(forecastValue(row, protocol, 'retentionCurve'))).length,
        pointComparisons: allResiduals.length,
        meanAbsolutePointError: round(average(allResiduals.map(Math.abs))),
        medianAbsolutePointError: round(quantile(allResiduals.map(Math.abs), 0.5)),
        bias: round(average(allResiduals)),
        actualDefinition: 'Observed YouTube retention at each second divided by that video\'s observed opening retention, so every curve starts at 100 without inventing a post-hook tail.',
    };
}

function buildScope(rows, validationRows, key, coordinateRegistry) {
    const scoped = key === 'pooled' ? rows : rows.filter(row => row.accountId === key);
    const validationScoped = key === 'pooled'
        ? validationRows
        : validationRows.filter(row => row.accountId === key);
    const score21Forecasts = {
        video: score21ForecastMetrics(scoped, 'video'),
        account: score21ForecastMetrics(scoped, 'account'),
    };
    const retentionForecasts = {
        video: retentionForecastMetrics(scoped, 'video'),
        account: retentionForecastMetrics(scoped, 'account'),
    };
    const storedIndicators = contract.features.map((definition, index) => ({
        key: definition.key,
        group: definition.group,
        target: definition.target,
        label: definition.label,
        unit: definition.unit,
        validationTier: 'stored_diagnostic',
        warning: (
            definition.target === 'keep' || definition.target === 'ret5'
                ? (key === 'hafu'
                    ? 'The stored upload scorer was trained on Tyler labels, so Hafu is account-external; scorer generation is still not persisted per row.'
                    : 'The stored upload scorer used Tyler labels. Tyler rows are in-sample and the pooled result mixes contaminated and external rows.')
                : 'The saved row does not persist the exact upstream axis-training IDs or scorer generation. Treat this as retrospective diagnostics, not blind evidence.'
        ),
        metrics: indicatorMetrics(scoped, definition, (row, variant) => (
            variant === 'raw' ? row.storedRaw[index] : row.storedPercentile[index]
        )),
    }));
    const blindVideo = buildBlindIndicatorMetrics(scoped, 'video');
    const blindAccount = buildBlindIndicatorMetrics(scoped, 'account');
    const ledgerOutcomeMatrix = buildLedgerOutcomeMatrix(
        validationScoped,
        coordinateRegistry,
        key,
        validationRows,
    );
    return {
        key,
        n: scoped.length,
        validationN: validationScoped.length,
        accounts: [...new Set(scoped.map(row => row.accountId))],
        validationAccounts: [...new Set(validationScoped.map(row => row.accountId))],
        joinedCoverage: {
            privateRows: scoped.length,
            storedRows: scoped.filter(row => row.storedRaw.some(finite)).length,
            blindRows: validationScoped.filter(row => row.blindVideoHeldOut.some(finite)).length,
            blindOnlyRows: validationScoped.filter(
                row => row.validationSource === 'predictor_blind_inputs_only'
            ).length,
        },
        models: {
            score21KeepVideoHeldOut: {
                label: 'Keep · 9 creator-excluded public axes · video held out',
                tier: 'retrospective_video_oof',
                kind: 'score21_forecast',
                metrics: score21Forecasts.video.keep,
            },
            score21KeepAccountHeldOut: {
                label: 'Keep · 9 creator-excluded public axes · account held out',
                tier: 'strict_account_transfer',
                kind: 'score21_forecast',
                metrics: score21Forecasts.account.keep,
            },
            score21Ret5VideoHeldOut: {
                label: '5s retention · 9 creator-excluded public axes · video held out',
                tier: 'retrospective_video_oof',
                kind: 'score21_forecast',
                metrics: score21Forecasts.video.ret5,
            },
            score21AverageRetentionVideoHeldOut: {
                label: 'Average retention · 9 creator-excluded public axes · video held out',
                tier: 'retrospective_video_oof',
                kind: 'score21_forecast',
                metrics: score21Forecasts.video.averageRetention,
            },
            score21ViewsVideoHeldOut: {
                label: 'Views · 9 creator-excluded public axes · video held out',
                tier: 'retrospective_video_oof',
                kind: 'score21_forecast',
                metrics: score21Forecasts.video.views,
            },
            score21Hit10MVideoHeldOut: {
                label: '10M class · 9 creator-excluded public axes · video held out',
                tier: 'retrospective_video_oof',
                kind: 'score21_forecast',
                metrics: score21Forecasts.video.hit10M,
            },
            keepVideoHeldOut: {
                label: 'Keep · video held out',
                tier: 'retrospective_video_oof',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.keep', 'predictions.keepVideoHeldOut', false),
            },
            keepAccountHeldOut: {
                label: 'Keep · entire account held out',
                tier: 'strict_account_transfer',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.keep', 'predictions.keepAccountHeldOut', false),
            },
            keepForwardTime: {
                label: 'Keep · partial forward-time',
                tier: 'partial_forward_backtest',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.keep', 'predictions.keepForwardTime', false),
            },
            viewsPublicAxisEnsemble: {
                label: 'Views · validation creators excluded from public axes',
                tier: 'strict_external_axis',
                kind: 'axis_ensemble',
                metrics: modelMetrics(scoped, 'actual.viewsCurrent', 'predictions.viewsPublicAxisEnsemble', true),
            },
            viewsVideoHeldOut: {
                label: 'Views · video held out',
                tier: 'diagnostic_upstream_unversioned',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.viewsCurrent', 'predictions.viewsVideoHeldOut', true),
            },
            viewsChannelHeldOut: {
                label: 'Views · entire channel held out',
                tier: 'diagnostic_upstream_unversioned',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.viewsCurrent', 'predictions.viewsChannelHeldOut', true),
            },
            viewsForwardTime: {
                label: 'Views · partial forward-time',
                tier: 'partial_forward_backtest',
                kind: 'multi_input_forecast',
                metrics: modelMetrics(scoped, 'actual.viewsCurrent', 'predictions.viewsForwardTime', true),
            },
        },
        storedIndicators,
        blindVideoIndicators: blindVideo,
        blindAccountIndicators: blindAccount,
        ledgerOutcomeMatrix,
        score21Forecasts,
        retentionForecasts,
    };
}

function buildValidationCohort(joinedRows, blindInputs, blindFeatureNames) {
    const joinedIds = new Set(joinedRows.map(row => String(row.id)));
    const blindOnlyRows = [];
    for (const source of (blindInputs && blindInputs.rows) || []) {
        const id = String(source && source.id || '');
        if (!id || joinedIds.has(id)) continue;
        const keep = number(source.actualKeep);
        const views = number(source.actualViews);
        blindOnlyRows.push({
            id,
            channelId: null,
            accountId: String(source.account || source.accountId || 'unknown'),
            accountName: String(source.accountName || source.account || 'Unknown account'),
            title: String(source.title || id),
            publishedAt: number(source.publishedAt),
            duration: number(source.duration),
            subscribers: null,
            transcript: '',
            inputManifest: null,
            noveltyProvenance: null,
            storedRaw: contract.features.map(() => null),
            storedPercentile: contract.features.map(() => null),
            blindFeatureNames,
            blindVideoHeldOut: Array.isArray(source.videoHeldOut) ? source.videoHeldOut : [],
            blindAccountHeldOut: Array.isArray(source.accountHeldOut) ? source.accountHeldOut : [],
            validationSource: 'predictor_blind_inputs_only',
            actual: {
                keep,
                swipe: finite(keep) ? round(100 - Number(keep)) : null,
                ret5: number(source.actualRet5),
                averageRetention: null,
                retentionCurve: null,
                viewsPrivateSnapshot: views,
                viewsCurrent: views,
                outlierCurrent: null,
                hit10MCurrent: finite(views) ? (Number(views) > 10000000 ? 1 : 0) : null,
                privateObservedAt: null,
                currentObservedAt: null,
            },
            predictions: {},
        });
    }
    const cohort = [...joinedRows, ...blindOnlyRows];
    cohort.sort((left, right) => (
        (right.publishedAt || 0) - (left.publishedAt || 0)
        || left.id.localeCompare(right.id)
    ));
    return {
        rows: cohort,
        joinedRows: joinedRows.length,
        blindOnlyRows: blindOnlyRows.length,
        totalRows: cohort.length,
        byAccount: Object.fromEntries(
            [...new Set(cohort.map(row => row.accountId))].sort().map(accountId => [
                accountId,
                cohort.filter(row => row.accountId === accountId).length,
            ]),
        ),
        availableOutcomes: {
            keep: cohort.filter(row => finite(row.actual.keep)).length,
            ret5: cohort.filter(row => finite(row.actual.ret5)).length,
            views: cohort.filter(row => finite(row.actual.viewsCurrent)).length,
            averageRetention: cohort.filter(row => finite(row.actual.averageRetention)).length,
            outlier: cohort.filter(row => finite(row.actual.outlierCurrent)).length,
            retentionCurve: cohort.filter(row => row.actual.retentionCurve).length,
        },
        rule: 'Blind-only rows contribute only outcomes actually persisted in predictor.targets.keep.blindInputs.rows: keep, ret5, views, duration, and the directly derived swipe and over-10M labels. Stored coordinates, average retention, outlier, and retention curves remain null.',
    };
}

function buildValidation({ channels, predictor, generatedAt = Date.now(), sourceFingerprint = null }) {
    if (!predictor || !predictor.targets || !predictor.targets.keep) {
        throw new Error('Predictor artifact is missing the keep target.');
    }
    const keepTarget = predictor.targets.keep || {};
    const viewsTarget = predictor.targets.views || {};
    const keepKnown = pointMap(keepTarget.points);
    const keepUnseen = pointMap(predictorStress(keepTarget, 'Unseen-account transfer').points);
    const keepForward = pointMap(predictorStress(keepTarget, 'Forward-time keep-rate transfer').points);
    const viewsKnown = pointMap(viewsTarget.points);
    const viewsUnseen = pointMap(predictorStress(viewsTarget, 'Unseen-channel transfer').points);
    const viewsForward = pointMap(predictorStress(viewsTarget, 'Forward-time public-views transfer').points);
    const blindInputs = keepTarget.blindInputs || {};
    const blindFeatureNames = Array.isArray(blindInputs.featureNames) ? blindInputs.featureNames : [];
    const blindById = new Map((blindInputs.rows || []).map(row => [String(row.id), row]));
    const rows = [];
    const joinSummary = [];

    for (const source of channels || []) {
        const privateVideos = (source.privateTable && source.privateTable.videos) || [];
        const savedVideos = (source.manifest && source.manifest.videos) || [];
        const savedById = new Map(savedVideos.map(video => [String(video.id), video]));
        let matched = 0;
        for (const privateVideo of privateVideos) {
            const id = String(privateVideo.id || privateVideo.videoId || '');
            const saved = savedById.get(id);
            if (!id || !saved || saved.status !== 'done') continue;
            matched++;
            const blind = blindById.get(id) || {};
            const knownKeep = keepKnown.get(id) || {};
            const unseenKeep = keepUnseen.get(id) || {};
            const forwardKeep = keepForward.get(id) || {};
            const knownViews = viewsKnown.get(id) || {};
            const unseenViews = viewsUnseen.get(id) || {};
            const forwardViews = viewsForward.get(id) || {};
            const storedCells = contract.features.map(definition => featureCell(saved, definition.key));
            const blindVideoHeldOut = Array.isArray(blind.videoHeldOut) ? blind.videoHeldOut : [];
            const blindAccountHeldOut = Array.isArray(blind.accountHeldOut) ? blind.accountHeldOut : [];
            const duration = number(privateVideo.duration_s != null ? privateVideo.duration_s : saved.duration);
            const keep = actualKeep(privateVideo);
            const row = {
                id,
                channelId: source.channelId,
                accountId: source.accountId,
                accountName: source.accountName,
                title: String(saved.title || privateVideo.title || id),
                publishedAt: parseDate(privateVideo.published || saved.published),
                duration,
                subscribers: number(saved.subscribers),
                transcript: String(saved.transcript || ''),
                inputManifest: saved.input_manifest && typeof saved.input_manifest === 'object'
                    ? saved.input_manifest
                    : null,
                noveltyProvenance: saved.novelty_provenance && typeof saved.novelty_provenance === 'object'
                    ? saved.novelty_provenance
                    : null,
                storedRaw: storedCells.map(cell => cell.raw),
                storedPercentile: storedCells.map(cell => cell.percentile),
                blindFeatureNames,
                blindVideoHeldOut,
                blindAccountHeldOut,
                actual: {
                    keep,
                    swipe: finite(privateVideo.swiped)
                        ? number(privateVideo.swiped)
                        : (finite(keep) ? round(100 - Number(keep)) : null),
                    ret5: number(privateVideo.ret5),
                    averageRetention: number(privateVideo.avg_retention),
                    retentionCurve: retentionCurveSnapshot(privateVideo.curve, duration),
                    viewsPrivateSnapshot: number(privateVideo.views),
                    viewsCurrent: number(saved.views),
                    outlierCurrent: finite(saved.views) && finite(saved.subscribers) && Number(saved.subscribers) > 0
                        ? Number(saved.views) / Number(saved.subscribers)
                        : null,
                    hit10MCurrent: finite(saved.views) ? (Number(saved.views) > 10000000 ? 1 : 0) : null,
                    privateObservedAt: parseDate(privateVideo.scraped_at || privateVideo.scrapedAt),
                    currentObservedAt: number(saved.viewsObservedAt || saved.scoredAt),
                },
                predictions: {
                    keepVideoHeldOut: number(knownKeep.predicted),
                    keepAccountHeldOut: number(unseenKeep.predicted),
                    keepForwardTime: number(forwardKeep.predicted),
                    viewsVideoHeldOut: number(knownViews.predictedViews),
                    viewsChannelHeldOut: number(unseenViews.predictedViews),
                    viewsForwardTime: number(forwardViews.predictedViews),
                },
            };
            const externalViewLogs = ['visual.views.raw', 'text.views.raw', 'together.views.raw']
                .map(name => blindFeatureValue(row, name, 'video')).filter(finite);
            row.predictions.viewsPublicAxis = {
                visual: finite(blindFeatureValue(row, 'visual.views.raw', 'video'))
                    ? Math.max(0, 10 ** blindFeatureValue(row, 'visual.views.raw', 'video') - 1)
                    : null,
                text: finite(blindFeatureValue(row, 'text.views.raw', 'video'))
                    ? Math.max(0, 10 ** blindFeatureValue(row, 'text.views.raw', 'video') - 1)
                    : null,
                together: finite(blindFeatureValue(row, 'together.views.raw', 'video'))
                    ? Math.max(0, 10 ** blindFeatureValue(row, 'together.views.raw', 'video') - 1)
                    : null,
            };
            row.predictions.viewsPublicAxisCount = externalViewLogs.length;
            row.predictions.viewsPublicAxisEnsemble = externalViewLogs.length === 3
                ? Math.max(0, 10 ** average(externalViewLogs) - 1)
                : null;
            rows.push(row);
        }
        joinSummary.push({
            channelId: source.channelId,
            accountId: source.accountId,
            accountName: source.accountName,
            privateRows: privateVideos.length,
            savedRows: savedVideos.filter(video => video.status === 'done').length,
            matchedRows: matched,
            unmatchedPrivateRows: privateVideos.length - matched,
        });
    }

    rows.sort((left, right) => (right.publishedAt || 0) - (left.publishedAt || 0) || left.id.localeCompare(right.id));
    const score21Model = attachScore21Forecasts(rows);
    const validationCohort = buildValidationCohort(rows, blindInputs, blindFeatureNames);
    const predictorProvenance = predictor.provenance || {};
    const coordinateRegistry = buildCoordinateRegistry({
        rows,
        predictorProvenance,
        predictorPrivateRows: blindInputs.rows || [],
        forecastModel: score21Model,
        sourceFingerprint,
        generatedAt,
    });
    if (!coordinateRegistry.lineageAudit || !coordinateRegistry.lineageAudit.passed) {
        const audit = coordinateRegistry.lineageAudit || {};
        const error = new Error(
            `Coordinate lineage contract mismatch; refusing to expose or export score values (${audit.contractAlignment || 'lineage audit failed'}).`
        );
        error.code = 'SCORE_LINEAGE_CONTRACT_MISMATCH';
        error.lineageAudit = audit;
        throw error;
    }
    const ledgerAudit = attachCoordinateLedger(validationCohort.rows, coordinateRegistry);
    const scopes = {
        pooled: buildScope(rows, validationCohort.rows, 'pooled', coordinateRegistry),
        tyler: buildScope(rows, validationCohort.rows, 'tyler', coordinateRegistry),
        hafu: buildScope(rows, validationCohort.rows, 'hafu', coordinateRegistry),
    };
    const privateAxisTrainingIdOverlap = number(predictorProvenance.privateAxisTrainingIdOverlap);
    const savedAxisTrainingIdOverlap = number(predictorProvenance.savedAxisTrainingIdOverlap);
    const validationCreatorAxisTrainingIdOverlap = number(predictorProvenance.validationCreatorAxisTrainingIdOverlap);
    const blindFeatureRowsComplete = validationCohort.rows.length > 0
        && validationCohort.rows.every(row => row.blindVideoHeldOut.length === blindFeatureNames.length)
        && validationCohort.rows.every(row => row.blindAccountHeldOut.length === blindFeatureNames.length);
    const publicAxisLeakageChecksPassed = privateAxisTrainingIdOverlap === 0
        && savedAxisTrainingIdOverlap === 0
        && validationCreatorAxisTrainingIdOverlap === 0;
    const validationAccountCount = new Set(
        validationCohort.rows.filter(row => finite(row.actual.keep)).map(row => row.accountId)
    ).size;
    const savedDrilldownAccountCount = new Set(rows.map(row => row.accountId)).size;
    const validationRows = validationCohort.rows.map(row => ({
        id: row.id,
        channelId: row.channelId,
        accountId: row.accountId,
        accountName: row.accountName,
        title: row.title,
        publishedAt: row.publishedAt,
        duration: row.duration,
        validationSource: row.validationSource || 'saved_channel_join',
        actual: row.actual,
        scoreLedger: row.scoreLedger,
    }));
    return {
        version: VERSION,
        generatedAt,
        sourceFingerprint,
        featureContract: contract,
        channels: SUPPORTED_CHANNELS,
        joinSummary,
        rows,
        validationRows,
        validationCohort: Object.fromEntries(
            Object.entries(validationCohort).filter(([key]) => key !== 'rows')
        ),
        scopes,
        score21Model,
        coordinateRegistry,
        ledgerAudit,
        outcomeDefinitions: OUTCOME_DEFINITIONS.map(definition => (
            Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'accessor'))
        )),
        validationContract: {
            stored: 'Exact 21 values persisted by the channel scorer. They are shown for diagnosis, never promoted to blind evidence.',
            videoHeldOut: `${blindInputs.videoHeldOutProtocol || 'The evaluated video is excluded from every target-aligned fit.'} In the canonical validation matrix, a separate deterministic five-fold calibration trains on four video folds and predicts the fifth. The test video's outcome is never used to fit its own calibration.`,
            accountHeldOut: `${blindInputs.accountHeldOutProtocol || 'The evaluated account is excluded from every target-aligned fit.'} In the canonical validation matrix, leave-account-out calibration trains on every other creator and predicts the omitted creator. No outcome from the test creator enters that fold's calibration.`,
            publicViewsAxis: 'The production one-component PLS direction and rank-to-outcome calibration are refit on public corpus videos after excluding private rows, saved rows, and every video from each validation creator.',
            forwardTime: 'Training labels precede test labels, but the present-day representation remains fixed; this is a partial backtest.',
            ledgerOutcomeMatrix: 'The single canonical 103-coordinate by 13-outcome validation matrix. Coordinates remain in score-ledger order and are never renamed or re-created for a chart.',
            retentionCurve: 'Observed YouTube retention is interpolated from its native percent-of-duration curve to exact seconds 0 through 20, then divided by that video\'s observed opening value. Forecasts use only nine public axes rebuilt after both validation creators were excluded.',
            coordinateLedger: 'Every displayed scalar is resolved by canonical coordinate ID. A relationship graph is only a score-coordinate/outcome pairing and cannot mint a new score.',
            glossary: {
                rawAssociation: 'Spearman measures whether higher coordinate values generally accompany higher outcomes without fitting a calibration. withinAccountSpearman removes each creator\'s level before measuring that rank relationship. AUC is the analogous ranking measure for the binary over-10M outcome.',
                video5Fold: 'Videos are deterministically assigned to five folds by video ID. For each fold, the one-coordinate calibration is fit on the other four folds and then frozen before it predicts the held-out fold.',
                leaveAccountOut: 'One creator account is the complete test fold. The calibration sees outcomes from other creators only, then predicts every eligible video from the omitted creator.',
                oof: 'Out-of-fold. Every reported OOF prediction was made by a calibration that did not train on that test video outcome; account-held-out OOF also excludes every outcome from the test creator.',
                oofR2: 'Improvement over the training-fold mean on the held-out rows. Zero matches that baseline; negative is worse; positive is better.',
                oofMae: 'Average absolute held-out error in the outcome unit, such as percentage points.',
                oofMedianFactorError: 'For log-scaled views or outlier outcomes, the median multiplicative miss. 1.0 is perfect; 2.0 means a typical two-fold error.',
                oofSpearman: 'Rank agreement between calibrated held-out predictions and outcomes. 1 is perfect ordering, 0 is no monotonic ordering, and -1 is reversed.',
                oofAuc: 'For over-10M classification, the chance that a randomly selected hit receives a higher held-out prediction than a miss. 0.5 is chance.',
                oofBrier: 'Mean squared probability error for held-out over-10M predictions. Lower is better; zero is perfect.',
                qValue: 'Global Benjamini-Hochberg false-discovery-rate adjustment across the full eligible 103-coordinate by 13-outcome exploratory family. Evidence and ranking use this global q-value because the UI can surface the best result across outcomes.',
                outcomeNotPredictor: 'The 13 measured-outcome columns stay in the ledger for traceability but are excluded from predictive rankings, calibration, and evidence claims.',
                coverage: 'Counts are explicit because not every artifact contains every truth field. Blind-only rows add real keep, ret5, and views labels, but never receive fabricated stored scores, average retention, outlier, or retention curves.',
            },
        },
        leakageAudit: {
            passedForBlindInputs: blindFeatureRowsComplete && publicAxisLeakageChecksPassed,
            coordinateLedgerPassed: ledgerAudit.passed,
            coordinateLedgerVersion: coordinateRegistry.version,
            privateRowsExcludedFromPublicAxis: privateAxisTrainingIdOverlap === 0,
            savedRowsExcludedFromPublicAxis: savedAxisTrainingIdOverlap === 0,
            validationCreatorsExcludedFromPublicAxis: validationCreatorAxisTrainingIdOverlap === 0,
            validationAccountCount,
            savedDrilldownAccountCount,
            privateAxisTrainingIdOverlapReported: privateAxisTrainingIdOverlap,
            savedAxisTrainingIdOverlapReported: savedAxisTrainingIdOverlap,
            validationCreatorAxisTrainingIdOverlapReported: validationCreatorAxisTrainingIdOverlap,
            savedAxisCandidateOverlapRemoved: number(predictorProvenance.savedAxisCandidateOverlapRemoved),
            validationCreatorVideoCountExcluded: number(predictorProvenance.validationCreatorVideoCountExcluded),
            validationCreatorChannelIds: Array.isArray(predictorProvenance.validationCreatorChannelIds)
                ? predictorProvenance.validationCreatorChannelIds
                : [],
            scorerVersionPersistedPerVideo: !!predictorProvenance.featureScorerVersionPersistedPerVideo,
            predictorGeneratedAt: number(predictor.generatedAt),
            featureContractVersion: contract.version,
            warnings: [
                'Tyler stored keep/ret5 values are in-sample because the upload scorer was fit on Tyler labels.',
                'Stored saved-channel rows do not persist an immutable scorer generation, so their 21 values remain diagnostics even when the video ID was excluded later.',
                'Current public views are lifetime snapshots, not fixed-horizon outcomes; publication age can still confound view error.',
                `${validationAccountCount} creator account${validationAccountCount === 1 ? '' : 's'} contribute persisted blind-input truth to the expanded matrix; ${savedDrilldownAccountCount} have joined saved score cards and richer private outcomes. Creator-level confidence is bounded by the former count, while original-card drilldown is bounded by the latter.`,
                'Swipe-away is the exact inverse of stayed-to-watch and is not a second independent label.',
                'The combined forecasts use only nine creator-excluded public views/outlier/10M axes. Private-label-aligned keep, ret5, and realistic-views coordinates remain visible in the single-score matrix but are not stacked into the forecast.',
                'The 20-second curve forecast is evaluated only where the observed video and retention curve reach that second.',
            ],
        },
    };
}

module.exports = {
    VERSION,
    SUPPORTED_CHANNELS,
    contract,
    buildValidation,
    regressionMetrics,
    binaryMetrics,
    featureCell,
    buildCoordinateRegistry,
    _singleCoordinateOof: singleCoordinateOof,
};
