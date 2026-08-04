'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contract = require('./saved-channel-feature-contract.json');
const coordinateGovernance = require('./quant-coordinate-governance.json');
const {
    validateVisualKeepForecast,
} = require('./visual-keep-forecast-contract');
const {
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    scoreRecordBindingSha256,
    scoreFeatureCell,
    scoreLedgerValidationSummary,
} = require('./shorts-score-ledger');
const {
    validateManifestRowBinding,
} = require('./saved-channel-manifest-binding');

const VERSION = 16;
const LEDGER_VERSION = coordinateGovernance.ledgerVersion;

// ── Channel-free keep signals (ledger finding: channelFreeKeepDirection) ──
// Per-video held-out OOF scores from predictor-lab/run_channel_free_signal.py:
// one pooled direction per signal, fitted with zero creator information.
// Tolerant load — without the artifact the four channelFree coordinates simply
// report no value; nothing else in the registry depends on it.
const CHANNEL_FREE_SIGNALS = ['visual', 'text', 'together', 'concat'];
let CHANNEL_FREE_SCORES = null;
try {
    CHANNEL_FREE_SCORES = require('./predictor-lab/channel-free-scores.json');
} catch (error) {
    CHANNEL_FREE_SCORES = null;
}
const CHANNEL_FREE_BY_ID = new Map(
    ((CHANNEL_FREE_SCORES && CHANNEL_FREE_SCORES.rows) || []).map(row => [String(row.id), row])
);
const CHANNEL_FREE_RUN_ID = (CHANNEL_FREE_SCORES && CHANNEL_FREE_SCORES.runId) || null;
const CHANNEL_FREE_SUMMARY = (CHANNEL_FREE_SCORES && CHANNEL_FREE_SCORES.summary) || {};
const VISUAL_KEEP_COORDINATE_ID =
    coordinateGovernance.coordinates.visualKeepForecast.id;
const VISUAL_KEEP_PROTOCOL_COORDINATES = Object.freeze(Object.fromEntries(
    Object.entries(coordinateGovernance.coordinates.visualKeepProtocols).map(
        ([key, value]) => [key, Object.freeze({ ...value })]
    )
));
const CREATOR_ADAPTIVE_KEEP_MODEL_COORDINATE_ID =
    coordinateGovernance.coordinates.creatorAdaptiveKeepForecast.id;
const CREATOR_ADAPTIVE_KEEP_PREQUENTIAL_COORDINATE_ID =
    coordinateGovernance.coordinates.forecastPattern
        .replace('{protocol}', 'creator-prequential')
        .replace('{outcomeKey}', 'keep');
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
    const totalSumSquares = observed.reduce(
        (sum, point) => sum + (point.actual - actualMean) ** 2,
        0
    );
    const hasProtocolBaseline = observed.every(point => finite(point.baseline));
    const baselineSse = hasProtocolBaseline
        ? observed.reduce(
            (sum, point) => sum + (point.actual - point.baseline) ** 2,
            0
        )
        : null;
    const baselineAbsoluteErrors = hasProtocolBaseline
        ? observed.map(point => Math.abs(point.actual - point.baseline))
        : [];
    const modelMae = average(residual.map(Math.abs));
    const baselineMae = hasProtocolBaseline
        ? average(baselineAbsoluteErrors)
        : null;
    const fit = calibration(actual, predicted);
    const metrics = {
        n: observed.length,
        coverage: options.total ? observed.length / options.total : null,
        r2: totalSumSquares > 0 ? 1 - sse / totalSumSquares : null,
        pearson: pearson(actual, predicted),
        spearman: spearman(actual, predicted),
        mae: modelMae,
        baselineMae,
        maeImprovementVsBaseline: finite(modelMae) && finite(baselineMae)
            ? baselineMae - modelMae
            : null,
        protocolBaselineR2: finite(baselineSse) && baselineSse > 0
            ? 1 - sse / baselineSse
            : null,
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
    let contributingRows = 0;
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
        contributingRows += group.length;
    }
    if (!totalPairs) {
        return {
            auc: null,
            p: null,
            ci95: [null, null],
            pairs: 0,
            n: 0,
        };
    }
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
        n: contributingRows,
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
    const cell = scoreFeatureCell(video, key);
    return {
        raw: cell.value,
        percentile: cell.percentile,
    };
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

function retentionCurveSeries(value, duration) {
    let source = value;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) {
            return { points: [], timebase: 'invalid-json' };
        }
    }
    if (source && !Array.isArray(source) && typeof source === 'object') {
        source = source.values || source.curve || source.retention || [];
    }
    if (!Array.isArray(source)) {
        return { points: [], timebase: 'missing' };
    }
    const rows = source.map((item, index) => {
        if (item && typeof item === 'object') {
            const explicitSecond = number(
                item.second != null ? item.second
                    : item.seconds != null ? item.seconds
                        : item.elapsedSeconds != null ? item.elapsedSeconds
                            : item.elapsed_s != null ? item.elapsed_s
                                : item.timeSeconds
            );
            const fraction = number(
                item.fraction != null ? item.fraction
                    : item.progress != null ? item.progress
                        : item.percentOfDuration != null
                            ? Number(item.percentOfDuration) / 100
                            : null
            );
            return {
                index,
                second: finite(explicitSecond)
                    ? Number(explicitSecond)
                    : (
                        finite(fraction) && finite(duration)
                            ? Number(fraction) * Number(duration)
                            : null
                    ),
                value: number(
                    item.retention != null ? item.retention
                        : item.value != null ? item.value
                            : item.y
                ),
            };
        }
        return { index, second: null, value: number(item) };
    });
    const finiteRows = rows.filter(row => finite(row.value));
    if (finiteRows.length < 2) {
        return { points: [], timebase: 'insufficient' };
    }
    const finiteValues = finiteRows.map(row => Number(row.value));
    const scale = Math.max(...finiteValues.map(Math.abs)) <= 3 ? 100 : 1;
    const allTimed = finiteRows.every(row => finite(row.second));
    const points = finiteRows.map(row => ({
        second: allTimed
            ? Number(row.second)
            : (
                finite(duration) && rows.length > 1
                    ? row.index / (rows.length - 1) * Number(duration)
                    : null
            ),
        value: Number(row.value) * scale,
    })).filter(point => finite(point.second))
        .sort((left, right) => left.second - right.second);
    return {
        points,
        timebase: allTimed ? 'explicit-seconds' : 'declared-uniform-grid',
    };
}

function interpolateTimed(points, second) {
    if (!points.length || !finite(second)) return null;
    if (Number(second) < points[0].second
        || Number(second) > points[points.length - 1].second) {
        return null;
    }
    const exact = points.find(point => point.second === Number(second));
    if (exact) return exact.value;
    let upper = points.findIndex(point => point.second > Number(second));
    if (upper <= 0) return null;
    const left = points[upper - 1], right = points[upper];
    const span = right.second - left.second;
    if (!(span > 0)) return null;
    const weight = (Number(second) - left.second) / span;
    return left.value + (right.value - left.value) * weight;
}

function retentionCurveSnapshot(curve, duration) {
    const series = retentionCurveSeries(curve, duration);
    if (series.points.length < 2 || !finite(duration) || Number(duration) <= 0) return null;
    const seconds = CURVE_SECONDS.slice();
    const observed = seconds.map(second => {
        if (second > Number(duration)) return null;
        return round(interpolateTimed(series.points, second), 4);
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
        sourcePoints: series.points.length,
        sourceDuration: round(duration, 4),
        sourceTimebase: series.timebase,
    };
}

function curveValue(row, field, second) {
    const curve = row && row.actual && row.actual.retentionCurve;
    const index = curve && Array.isArray(curve.seconds) ? curve.seconds.indexOf(Number(second)) : -1;
    return index >= 0 && Array.isArray(curve[field]) ? number(curve[field][index]) : null;
}

const outcomeSelectionRepresentativeByFamily = new Map();
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
].map(definition => {
    const hypothesisFamily =
        coordinateGovernance.inference.outcomeHypothesisFamilies[definition.key];
    const selectionDuplicateOf =
        outcomeSelectionRepresentativeByFamily.get(hypothesisFamily) || null;
    if (!selectionDuplicateOf) {
        outcomeSelectionRepresentativeByFamily.set(
            hypothesisFamily,
            definition.key
        );
    }
    return Object.freeze({
        ...definition,
        hypothesisFamily,
        selectionRepresentative: !selectionDuplicateOf,
        selectionDuplicateOf,
    });
}));

const MIN_CONFIRMATORY_ACCOUNT_COUNT = Math.max(
    1,
    Number(
        coordinateGovernance.inference
            .minimumIndependentAccountsForConfirmatoryClaim
    ) || 5
);
const MIN_CONFIRMATORY_ROWS_PER_ACCOUNT = 20;

function nestedValue(value, pathParts) {
    return pathParts.reduce(
        (current, key) => current == null ? null : current[key],
        value
    );
}

function evaluatedAccounts(study, studyKind) {
    if (!study) return [];
    const candidates = studyKind === 'visual_keep'
        ? [
            {
                rows: nestedValue(study, ['validationSummary', 'accountHoldout', 'metrics', 'perAccount']),
                kind: 'per_account_metrics',
            },
            {
                rows: nestedValue(study, ['protocols', 'accountHoldout', 'metrics', 'perAccount']),
                kind: 'per_account_metrics',
            },
            {
                rows: nestedValue(study, ['validationSummary', 'accountHoldout', 'points']),
                kind: 'prediction_points',
            },
            {
                rows: nestedValue(study, ['protocols', 'accountHoldout', 'points']),
                kind: 'prediction_points',
            },
        ]
        : [
            {
                rows: nestedValue(study, ['evaluation', 'metrics', 'perAccount']),
                kind: 'per_account_metrics',
            },
            {
                rows: nestedValue(study, ['evaluation', 'points']),
                kind: 'prediction_points',
            },
        ];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate.rows) || !candidate.rows.length) continue;
        const counts = new Map();
        for (const entry of candidate.rows) {
            if (!entry) continue;
            const id = String(
                entry.channelId || entry.accountId || entry.account || entry.id || ''
            );
            if (!id) continue;
            if (candidate.kind === 'per_account_metrics') {
                if (!finite(entry.n) || Number(entry.n) <= 0) continue;
                counts.set(id, Math.max(counts.get(id) || 0, Number(entry.n)));
            } else if (finite(entry.actual) && finite(entry.predicted)) {
                counts.set(id, (counts.get(id) || 0) + 1);
            }
        }
        if (counts.size) {
            return [...counts.entries()].map(([id, n]) => ({
                id,
                n,
                meetsMinimumRows: n >= MIN_CONFIRMATORY_ROWS_PER_ACCOUNT,
            })).sort((left, right) => left.id.localeCompare(right.id));
        }
    }
    return [];
}

function prospectiveEvidenceFlags(study) {
    if (!study) return [];
    return [
        ['evaluation.target.prospectiveValidated',
            nestedValue(study, ['evaluation', 'target', 'prospectiveValidated'])],
        ['promotion.prospectiveValidated',
            nestedValue(study, ['promotion', 'prospectiveValidated'])],
        ['prospectiveValidation.confirmed',
            nestedValue(study, ['prospectiveValidation', 'confirmed'])],
        ['status.prospectiveValidated',
            nestedValue(study, ['status', 'prospectiveValidated'])],
    ].filter(([, value]) => typeof value === 'boolean')
        .map(([field, value]) => ({ field, value }));
}

function exactSha256(value) {
    return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function canonicalYoutubeChannelId(value) {
    const candidate = String(value || '').trim();
    return /^UC[A-Za-z0-9_-]{22}$/.test(candidate)
        ? candidate
        : null;
}

function immutableJsonEvidenceAudit(record, label, requiredFields) {
    const blockers = [];
    const artifactSha256 = String(
        record && record.artifactSha256 || ''
    ).toLowerCase();
    const archiveKey = record && record.archiveKey;
    const bytesText = record && record.artifactBytes;
    const bytesBase64 = record && record.artifactBytesBase64;
    let bytes = null;
    let encoding = null;
    if (typeof bytesText === 'string' && bytesText.length) {
        bytes = Buffer.from(bytesText, 'utf8');
        encoding = 'utf8';
    } else if (typeof bytesBase64 === 'string' && bytesBase64.length) {
        const normalized = bytesBase64.replace(/\s+/g, '');
        const decoded = Buffer.from(normalized, 'base64');
        if (
            decoded.length
            && decoded.toString('base64').replace(/=+$/, '')
                === normalized.replace(/=+$/, '')
        ) {
            bytes = decoded;
            encoding = 'base64';
        } else {
            blockers.push(`${label} artifactBytesBase64 is malformed.`);
        }
    } else {
        blockers.push(
            `${label} has no immutable evidence bytes; hash-shaped metadata alone is not evidence.`
        );
    }
    if (!exactSha256(artifactSha256)) {
        blockers.push(`${label} artifactSha256 is missing or malformed.`);
    }
    const computedSha256 = bytes
        ? crypto.createHash('sha256').update(bytes).digest('hex')
        : null;
    if (
        computedSha256
        && exactSha256(artifactSha256)
        && computedSha256 !== artifactSha256
    ) {
        blockers.push(`${label} evidence bytes do not match artifactSha256.`);
    }
    if (
        typeof archiveKey !== 'string'
        || !exactSha256(artifactSha256)
        || !archiveKey.includes(artifactSha256)
    ) {
        blockers.push(
            `${label} archiveKey is not content-addressed by the verified artifact hash.`
        );
    }
    let payload = null;
    if (bytes) {
        try {
            payload = JSON.parse(bytes.toString('utf8'));
        } catch (_) {
            blockers.push(`${label} evidence bytes are not valid JSON.`);
        }
    }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        if (bytes) blockers.push(`${label} evidence payload is not a JSON object.`);
    } else {
        for (const field of requiredFields) {
            if (!Object.prototype.hasOwnProperty.call(payload, field)) {
                blockers.push(`${label} evidence payload omits ${field}.`);
            } else if (stableJson(payload[field]) !== stableJson(record[field])) {
                blockers.push(
                    `${label} mutable ${field} does not match its immutable evidence bytes.`
                );
            }
        }
    }
    return {
        passed: blockers.length === 0,
        artifactSha256: exactSha256(artifactSha256)
            ? artifactSha256
            : null,
        computedSha256,
        archiveKey: typeof archiveKey === 'string' ? archiveKey : null,
        encoding,
        byteLength: bytes ? bytes.length : 0,
        payload,
        blockers,
    };
}

function visualKeepModelOutputAudit(visualKeepStudy) {
    const formula = visualKeepStudy
        && visualKeepStudy.formula
        && typeof visualKeepStudy.formula === 'object'
        ? visualKeepStudy.formula
        : {};
    const outputBounds = formula.outputBounds;
    const selected = formula.selected
        && typeof formula.selected === 'object'
        ? formula.selected
        : {};
    const accounts = formula.accounts;
    const blockers = [];
    if (formula.scope !== 'pooled_global') {
        blockers.push('active visual keep model is not pooled_global');
    }
    if (
        formula.outputTransform
            !== 'clip(linear_prediction, 0, 100)'
        || !Array.isArray(outputBounds)
        || outputBounds.length !== 2
        || Number(outputBounds[0]) !== 0
        || Number(outputBounds[1]) !== 100
    ) {
        blockers.push(
            'active visual keep model does not declare the exact [0,100] clipping contract'
        );
    }
    const accountFormulaCount = accounts == null
        ? 0
        : Array.isArray(accounts)
            ? accounts.length
            : typeof accounts === 'object'
                ? Object.keys(accounts).length
                : 1;
    if (accountFormulaCount > 0) {
        blockers.push(
            'active visual keep model contains creator-specific account formulas'
        );
    }
    if (
        finite(selected.accountWeight)
        && Number(selected.accountWeight) !== 0
    ) {
        blockers.push(
            'active visual keep model selected a nonzero creator-account weight'
        );
    }
    return {
        valid: blockers.length === 0,
        scope: formula.scope || null,
        outputTransform: formula.outputTransform || null,
        outputBounds: Array.isArray(outputBounds)
            ? outputBounds.map(Number)
            : null,
        selectedAccountWeight: number(selected.accountWeight),
        blockers,
    };
}

function persistedVisualKeepForecastAudit(
    record,
    expectedArtifactSha256,
    expectedManifestSha256,
    visualKeepStudy,
    expectedFeatureContractVersion,
    expectedFeatureContractSha256
) {
    const forecast = record
        && record.visual_keep_forecast
        && typeof record.visual_keep_forecast === 'object'
        ? record.visual_keep_forecast
        : null;
    const manifest = record
        && record.input_manifest
        && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : null;
    const blockers = [];
    const requireExact = (value, message) => {
        if (!exactSha256(value)) blockers.push(message);
    };
    if (!forecast) {
        blockers.push('no persisted visual keep score-time forecast exists');
    } else {
        const modelArtifact = visualKeepStudy
            && visualKeepStudy.modelArtifact || {};
        const audit = validateVisualKeepForecast(
            forecast,
            {
                coordinateId: VISUAL_KEEP_COORDINATE_ID,
                modelArtifactSha256: expectedArtifactSha256,
                modelManifestSha256: expectedManifestSha256,
                producerSourceSha256:
                    modelArtifact.producerSourceSha256,
                featureContractVersion:
                    expectedFeatureContractVersion,
                featureContractSha256:
                    expectedFeatureContractSha256,
            }
        );
        blockers.push(...audit.errors.map(
            error => `forecast ${error}`
        ));
    }
    if (!manifest) {
        blockers.push('score input manifest is missing');
    } else {
        requireExact(
            manifest.input_fingerprint,
            'score input fingerprint is missing or malformed'
        );
        requireExact(
            manifest.score_input_fingerprint,
            'exact score_input_fingerprint is missing or malformed'
        );
        requireExact(
            manifest.embedding_input_fingerprint,
            'embedding input fingerprint is missing or malformed'
        );
        requireExact(
            manifest.revision_fingerprint,
            'input revision fingerprint is missing or malformed'
        );
        requireExact(
            manifest.canonical_montage
                && manifest.canonical_montage.montage_sha256,
            'canonical montage SHA is missing or malformed'
        );
        if (
            exactSha256(manifest.input_fingerprint)
            && exactSha256(manifest.score_input_fingerprint)
            && manifest.input_fingerprint
                !== manifest.score_input_fingerprint
        ) {
            blockers.push(
                'input_fingerprint and score_input_fingerprint disagree'
            );
        }
    }
    const recordedScoreRecordSha256 =
        record && record.score_record_sha256;
    requireExact(
        recordedScoreRecordSha256,
        'score-record binding SHA is missing or malformed'
    );
    const calculatedScoreRecordSha256 = record
        ? scoreRecordBindingSha256(record)
        : null;
    if (
        exactSha256(recordedScoreRecordSha256)
        && recordedScoreRecordSha256
            !== calculatedScoreRecordSha256
    ) {
        blockers.push(
            'score-record binding does not bind this forecast to this exact input manifest'
        );
    }
    const outputAudit = visualKeepModelOutputAudit(visualKeepStudy);
    blockers.push(...outputAudit.blockers);
    return {
        valid: blockers.length === 0,
        state: blockers.length
            ? forecast
                ? 'rejected_persisted_forecast'
                : 'missing_persisted_forecast'
            : 'canonical_persisted_score_time_forecast',
        coordinateId: forecast && forecast.coordinate_id || null,
        source: forecast && forecast.source || null,
        modelArtifactSha256:
            forecast && forecast.model_artifact_sha256 || null,
        modelManifestSha256:
            forecast && forecast.model_manifest_sha256 || null,
        inputFingerprint:
            manifest && manifest.score_input_fingerprint || null,
        inputRevisionFingerprint:
            manifest && manifest.revision_fingerprint || null,
        recordedScoreRecordSha256:
            exactSha256(recordedScoreRecordSha256)
                ? recordedScoreRecordSha256
                : null,
        calculatedScoreRecordSha256,
        outputAudit,
        blockers: [...new Set(blockers)],
    };
}

function timestampMilliseconds(value) {
    if (finite(value)) return Number(value);
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function prospectiveRegistrationAudit(study) {
    const prospective = study && study.prospectiveValidation;
    const registration = prospective && prospective.registrationArtifact;
    const result = prospective && prospective.result;
    const modelArtifact = study && study.modelArtifact;
    const blockers = [];
    if (!registration || typeof registration !== 'object') {
        blockers.push('No immutable prospective registration artifact is recorded.');
    }
    if (!result || typeof result !== 'object') {
        blockers.push('No prospective result linked to a registration artifact is recorded.');
    }
    const registrationArtifactSha256 = registration && registration.artifactSha256;
    const registeredAt = timestampMilliseconds(registration && registration.registeredAt);
    const completedAt = timestampMilliseconds(result && result.completedAt);
    const modelGeneratedAt = timestampMilliseconds(modelArtifact && modelArtifact.generatedAt);
    const lockedFields = [
        'modelArtifactSha256',
        'protocolSha256',
        'outcomeDefinitionSha256',
        'evaluationPopulationSha256',
    ];
    const registrationEvidenceAudit = immutableJsonEvidenceAudit(
        registration,
        'Prospective registration',
        ['registeredAt', ...lockedFields]
    );
    const resultEvidenceAudit = immutableJsonEvidenceAudit(
        result,
        'Prospective result',
        ['completedAt', 'registrationArtifactSha256', ...lockedFields]
    );
    blockers.push(
        ...registrationEvidenceAudit.blockers,
        ...resultEvidenceAudit.blockers
    );
    for (const field of lockedFields) {
        if (registration && !exactSha256(registration[field])) {
            blockers.push(`Prospective registration ${field} is missing or malformed.`);
        }
        if (registration && result && result[field] !== registration[field]) {
            blockers.push(`Prospective result ${field} does not match the preregistered value.`);
        }
    }
    if (!modelArtifact || !exactSha256(modelArtifact.artifactSha256)) {
        blockers.push('The evaluated model artifact has no immutable artifact hash.');
    } else if (registration
        && registration.modelArtifactSha256 !== modelArtifact.artifactSha256) {
        blockers.push('The preregistered model hash does not match the evaluated model artifact.');
    }
    if (result && result.registrationArtifactSha256 !== registrationArtifactSha256) {
        blockers.push('The prospective result is not linked to the immutable registration artifact.');
    }
    if (!finite(registeredAt)) {
        blockers.push('Prospective registration has no valid registration timestamp.');
    }
    if (!finite(modelGeneratedAt)) {
        blockers.push('The frozen model artifact has no valid generation timestamp.');
    }
    if (!finite(completedAt) || (finite(registeredAt) && completedAt <= registeredAt)) {
        blockers.push('Prospective evaluation completion must be later than registration.');
    }
    if (finite(modelGeneratedAt) && finite(registeredAt)
        && registeredAt < modelGeneratedAt) {
        blockers.push('Prospective registration predates the frozen model artifact.');
    }
    return {
        passed: blockers.length === 0,
        registrationArtifactSha256:
            exactSha256(registrationArtifactSha256)
                ? registrationArtifactSha256
                : null,
        resultArtifactSha256:
            resultEvidenceAudit.artifactSha256,
        registeredAt,
        completedAt,
        lockedFields,
        immutableEvidencePassed:
            registrationEvidenceAudit.passed
            && resultEvidenceAudit.passed,
        registrationEvidenceAudit,
        resultEvidenceAudit,
        blockers,
    };
}

function promotionEligibilityAudit(study, studyKind) {
    if (!study) return null;
    const evaluated = evaluatedAccounts(study, studyKind);
    const qualifyingAccounts = evaluated.filter(account => account.meetsMinimumRows);
    const accountIds = qualifyingAccounts.map(account => account.id);
    const flags = prospectiveEvidenceFlags(study);
    const registrationAudit = prospectiveRegistrationAudit(study);
    const prospectiveConfirmed = flags.length > 0
        && flags.every(flag => flag.value === true)
        && registrationAudit.passed;
    const creatorDiversityPassed =
        accountIds.length >= MIN_CONFIRMATORY_ACCOUNT_COUNT;
    const status = study.status && typeof study.status === 'object'
        ? study.status
        : {};
    const promotion = study.promotion && typeof study.promotion === 'object'
        ? study.promotion
        : {};
    const promotionClaimFlags = [
        ['status.promoted', status.promoted],
        ['promotion.promoted', promotion.promoted],
    ].filter(([, value]) => typeof value === 'boolean')
        .map(([field, value]) => ({ field, value }));
    const artifactClaimsPromoted =
        promotionClaimFlags.some(flag => flag.value === true);
    const artifactClaimsPredictorEligible =
        status.predictorEligible === true;
    const evidenceBlockers = [];
    if (promotionClaimFlags.length > 1
        && !promotionClaimFlags.every(
            flag => flag.value === promotionClaimFlags[0].value
        )) {
        evidenceBlockers.push(
            'Artifact promotion claims are internally inconsistent.'
        );
    }
    if (!creatorDiversityPassed) {
        evidenceBlockers.push(
            `Only ${accountIds.length} independently evaluated creator account${
                accountIds.length === 1 ? '' : 's'
            } have at least ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} evaluation rows; at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} are required.`
        );
    }
    if (!prospectiveConfirmed) {
        evidenceBlockers.push(flags.length
            ? 'Prospective confirmation is false, internally inconsistent, or lacks immutable preregistration evidence.'
            : 'No explicit prospective confirmation is recorded.');
        evidenceBlockers.push(...registrationAudit.blockers);
    }
    const evidenceGatePassed = evidenceBlockers.length === 0;
    return {
        failClosed: true,
        studyKind,
        minimumIndependentAccounts: MIN_CONFIRMATORY_ACCOUNT_COUNT,
        minimumRowsPerIndependentAccount:
            MIN_CONFIRMATORY_ROWS_PER_ACCOUNT,
        evaluatedAccounts: evaluated,
        independentlyEvaluatedAccounts: accountIds,
        independentAccountCount: accountIds.length,
        creatorDiversityPassed,
        prospectiveEvidenceFlags: flags,
        prospectiveConfirmed,
        prospectiveRegistrationAudit: registrationAudit,
        evidenceGatePassed,
        artifactClaimsPromoted,
        promotionClaimFlags,
        artifactClaimsPredictorEligible,
        effectivePromoted: artifactClaimsPromoted && evidenceGatePassed,
        effectivePredictorEligible:
            artifactClaimsPromoted
            && artifactClaimsPredictorEligible
            && evidenceGatePassed,
        evidenceBlockers,
        rule: `Promotion requires the artifact to mark itself promoted, at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} independent creators with at least ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} evaluation rows each, and a prospectively completed result whose immutable result and preregistration bytes reproduce their declared hashes and lock the model, protocol, outcome, and evaluation population. Hash-shaped strings without the corresponding evidence bytes cannot promote. Predictor ranking additionally requires the artifact to mark itself predictor-eligible. Missing or conflicting evidence fails closed.`,
    };
}

const LONG_QUANT_METRICS = Object.freeze(
    (coordinateGovernance.expansions.longMetrics || []).map(
        metric => Object.freeze({ ...metric })
    )
);
const LONG_QUANT_GROUPS = Object.freeze(
    (coordinateGovernance.expansions.longGroups || []).slice()
);

function displayTargetForOutcome(key) {
    if (key === 'hit10M') return 'gt10M';
    if (key === 'views') return 'views';
    if (key === 'outlier') return 'outlier';
    return key;
}

function coordinatePattern(pattern, replacements) {
    return Object.entries(replacements).reduce(
        (value, [key, replacement]) => value.replace(
            `{${key}}`,
            String(replacement)
        ),
        String(pattern)
    );
}

function buildCoordinateAliases() {
    const aliases = [];
    const patterns = coordinateGovernance.compatibility.aliasPatterns || [];
    for (const definition of contract.features) {
        if (definition.group === 'novelty') continue;
        for (const alias of patterns) {
            if (!(alias.targets || []).includes(definition.target)) continue;
            aliases.push({
                id: coordinatePattern(alias.from, { featureKey: definition.key }),
                canonicalId: coordinatePattern(alias.to, {
                    featureKey: definition.key,
                }),
                status: 'compatibility_alias',
                reason: alias.reason,
            });
        }
    }
    return aliases;
}

function resolveCoordinateId(registry, coordinateId) {
    const activeIds = new Set(
        ((registry && registry.columns) || []).map(column => column.id)
    );
    let current = String(coordinateId || '');
    const visited = new Set();
    while (current && !activeIds.has(current)) {
        if (visited.has(current)) return null;
        visited.add(current);
        current = registry && registry.aliasMap
            && registry.aliasMap[current] || '';
    }
    return activeIds.has(current) ? current : null;
}

function sha256Ids(ids) {
    return crypto.createHash('sha256').update(
        (ids || []).map(String).sort().join('\n')
    ).digest('hex');
}

function normalizedContentText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizedContentEvidence(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function validationContentFamilyEvidence(row) {
    const manifest = row && (row.inputManifest || row.input_manifest) || {};
    const explicitFamily = row && (
        row.contentFamilyId || row.content_family_id
    );
    const explicitSource = row && (
        row.sourceContentId || row.source_content_id
    ) || manifest.source_content_id
        || manifest.sourceContentId
        || manifest.source_video_id
        || manifest.sourceVideoId;
    const montageSha256 = row && (
        row.montageSha256 || row.montage_sha256
    ) || manifest.canonical_montage
        && manifest.canonical_montage.montage_sha256;
    const perceptualHash = row && (
        row.perceptualHash || row.perceptual_hash
    ) || manifest.perceptual_hash
        || manifest.perceptualHash;
    const normalizedFamily = normalizedContentEvidence(explicitFamily);
    if (normalizedFamily && !normalizedFamily.startsWith('title:')) {
        const identityOnly = normalizedFamily.startsWith('video:');
        return {
            familyId: identityOnly
                ? normalizedFamily
                : normalizedFamily.startsWith('declared:')
                    ? normalizedFamily
                    : `declared:${normalizedFamily}`,
            source: identityOnly
                ? 'explicit_video_identity'
                : 'explicit_content_family',
            strength: identityOnly ? 'identity_only' : 'strong',
            duplicateProtection: identityOnly
                ? 'same declared video identity only; reuploads are not protected'
                : 'explicit source-family lineage',
            fallback: identityOnly,
            strongEvidencePresent: !identityOnly,
        };
    }
    const normalizedSource = normalizedContentEvidence(explicitSource);
    if (normalizedSource) {
        return {
            familyId: normalizedSource.startsWith('declared:')
                ? normalizedSource
                : `declared:${normalizedSource}`,
            source: 'explicit_source_content',
            strength: 'strong',
            duplicateProtection: 'exact source-content lineage',
            fallback: false,
            strongEvidencePresent: true,
        };
    }
    if (exactSha256(montageSha256)) {
        return {
            familyId: `declared:${String(montageSha256).toLowerCase()}`,
            source: 'canonical_montage_sha256',
            strength: 'strong',
            duplicateProtection: 'byte-identical canonical montage',
            fallback: false,
            strongEvidencePresent: true,
        };
    }
    const normalizedPerceptualHash =
        normalizedContentEvidence(perceptualHash);
    if (normalizedPerceptualHash) {
        return {
            familyId: `declared:${normalizedPerceptualHash}`,
            source: 'perceptual_hash',
            strength: 'moderate',
            duplicateProtection: 'exact perceptual-hash equality only; no near-hash radius is inferred',
            fallback: false,
            strongEvidencePresent: false,
        };
    }
    const title = normalizedFamily.startsWith('title:')
        ? normalizedContentText(normalizedFamily.slice(6))
        : normalizedContentText(row && row.title);
    if (title) {
        return {
            familyId: `title:${title}`,
            source: 'normalized_title_fallback',
            strength: 'weak',
            duplicateProtection: 'weak title equality only; this is not duplicate-content protection',
            fallback: true,
            strongEvidencePresent: false,
        };
    }
    return {
        familyId: `video:${String(row && row.id || '')}`,
        source: 'row_identity_fallback',
        strength: 'none',
        duplicateProtection: 'none; each row is treated as unrelated',
        fallback: true,
        strongEvidencePresent: false,
    };
}

function validationContentFamilyId(row) {
    return validationContentFamilyEvidence(row).familyId;
}

function contentFamilyEvidenceAudit(rows) {
    const evidence = (rows || []).map(row => (
        row && row.contentFamilyEvidence
        && row.contentFamilyEvidence.familyId
            ? row.contentFamilyEvidence
            : validationContentFamilyEvidence(row)
    ));
    const countBy = field => Object.fromEntries(
        [...new Set(evidence.map(item => item[field]))].sort().map(value => [
            value,
            evidence.filter(item => item[field] === value).length,
        ])
    );
    const weakRows = (rows || []).filter((row, index) => (
        evidence[index].strength === 'weak'
    )).map(row => String(row && row.id || '')).filter(Boolean);
    const noProtectionRows = (rows || []).filter((row, index) => (
        evidence[index].strength === 'none'
        || evidence[index].strength === 'identity_only'
    )).map(row => String(row && row.id || '')).filter(Boolean);
    const strongRows = evidence.filter(item => item.strength === 'strong').length;
    const moderateRows = evidence.filter(item => item.strength === 'moderate').length;
    const fallbackRows = evidence.filter(item => item.fallback).length;
    return {
        rows: evidence.length,
        bySource: countBy('source'),
        byStrength: countBy('strength'),
        strongRows,
        moderateRows,
        fallbackRows,
        titleFallbackRows: weakRows.length,
        identityOnlyOrMissingRows: noProtectionRows.length,
        strongOrPerceptualCoverage: evidence.length
            ? round((strongRows + moderateRows) / evidence.length, 6)
            : null,
        strongDuplicateProtectionPassed:
            evidence.length > 0 && strongRows === evidence.length,
        strongOrPerceptualProtectionPassed:
            evidence.length > 0
            && strongRows + moderateRows === evidence.length,
        fallbackStrength: weakRows.length
            ? 'weak_title_equality_not_duplicate_protection'
            : noProtectionRows.length
                ? 'identity_only_or_missing'
                : null,
        weakFallbackExamples: weakRows.slice(0, 25),
        missingProtectionExamples: noProtectionRows.slice(0, 25),
        warning: fallbackRows
            ? 'Some rows lack source lineage, canonical montage SHA, or perceptual hash. Title/row-identity fallbacks preserve deterministic folds but do not provide strong duplicate-content protection.'
            : null,
    };
}

function contentFamilyFoldAssignments(rows, requested = 5, salt = 'outer') {
    const evidence = (rows || []).map(validationContentFamilyEvidence);
    const families = new Set(evidence.map(item => item.familyId));
    const foldCount = Math.max(0, Math.min(
        Number(requested) || 5,
        5,
        families.size
    ));
    if (foldCount < 2) {
        return {
            folds: 0,
            assignments: new Array((rows || []).length).fill(null),
            contentFamilies: families.size,
            evidenceAudit: contentFamilyEvidenceAudit(rows),
        };
    }
    const groups = new Map();
    (rows || []).forEach((row, index) => {
        const familyId = evidence[index].familyId;
        if (!groups.has(familyId)) {
            groups.set(familyId, {
                familyId,
                indices: [],
                accounts: new Map(),
                hash: stableHash(`${salt}:${familyId}`),
            });
        }
        const group = groups.get(familyId);
        const accountId = String(
            row && (row.accountId || row.account) || 'unknown'
        );
        group.indices.push(index);
        group.accounts.set(
            accountId,
            (group.accounts.get(accountId) || 0) + 1
        );
    });
    const assignments = new Array((rows || []).length);
    const states = Array.from(
        { length: foldCount },
        () => ({ rows: 0, accounts: new Map() })
    );
    [...groups.values()].sort((left, right) => (
        right.indices.length - left.indices.length
        || left.hash - right.hash
        || left.familyId.localeCompare(right.familyId)
    )).forEach(group => {
        let selected = 0, selectedCost = Infinity;
        for (let fold = 0; fold < foldCount; fold++) {
            const state = states[fold];
            const accountCost = [...group.accounts.entries()].reduce(
                (sum, [accountId, count]) => (
                    sum + (state.accounts.get(accountId) || 0) + count
                ),
                0
            );
            const cost = state.rows + group.indices.length + accountCost;
            if (cost < selectedCost
                || (cost === selectedCost
                    && state.rows < states[selected].rows)
                || (cost === selectedCost
                    && state.rows === states[selected].rows
                    && fold < selected)) {
                selected = fold;
                selectedCost = cost;
            }
        }
        group.indices.forEach(index => { assignments[index] = selected; });
        states[selected].rows += group.indices.length;
        for (const [accountId, count] of group.accounts) {
            states[selected].accounts.set(
                accountId,
                (states[selected].accounts.get(accountId) || 0) + count
            );
        }
    });
    return {
        folds: foldCount,
        assignments,
        contentFamilies: groups.size,
        evidenceAudit: contentFamilyEvidenceAudit(rows),
    };
}

function blindFoldManifestRows(rows) {
    return (rows || []).map(row => ({
        id: String(row && row.id || ''),
        accountId: String(
            row && (row.account || row.accountId) || ''
        ),
        contentFamilyId: validationContentFamilyId(row),
        videoFold: number(row && row.videoFold),
    })).sort((left, right) => (
        left.id.localeCompare(right.id)
        || left.accountId.localeCompare(right.accountId)
    ));
}

function auditBlindFoldLineage(blindInputs) {
    const rows = blindInputs && Array.isArray(blindInputs.rows)
        ? blindInputs.rows
        : [];
    const assignment = contentFamilyFoldAssignments(rows, 5, 'outer');
    const mismatches = [];
    rows.forEach((row, index) => {
        const recorded = number(row && row.videoFold);
        const expected = assignment.assignments[index];
        if (!finite(recorded) || Number(recorded) !== Number(expected)) {
            mismatches.push(String(row && row.id || index));
        }
    });
    const manifestRows = blindFoldManifestRows(rows);
    const computedSha256 = sha256Json(manifestRows);
    const recordedSha256 = String(
        blindInputs && blindInputs.rowFoldManifestSha256 || ''
    ).toLowerCase();
    const contentAddressed = /^[a-f0-9]{64}$/.test(recordedSha256)
        && recordedSha256 === computedSha256;
    return {
        passed: rows.length > 0
            && assignment.folds >= 2
            && mismatches.length === 0
            && contentAddressed
            && assignment.evidenceAudit
                .strongDuplicateProtectionPassed,
        rows: rows.length,
        contentFamilies: assignment.contentFamilies,
        foldAlgorithm: 'content-family-grouped-balanced-v1',
        contentFamilyEvidenceAudit: assignment.evidenceAudit,
        strongDuplicateProtectionPassed:
            assignment.evidenceAudit.strongDuplicateProtectionPassed,
        recordedSha256: recordedSha256 || null,
        computedSha256,
        mismatches: mismatches.slice(0, 50),
        contentAddressed,
        warning: assignment.evidenceAudit.warning,
        rule: 'A blind fold is valid only when every row has strong duplicate-family evidence, the deterministic grouped assignment matches every recorded fold, and the exact row/fold manifest hash verifies. Title equality, row identity, and exact perceptual hashes remain visible diagnostics but cannot promote a fold audit.',
    };
}

function validationCreatorChannelIdentityAudit(
    channels,
    predictorProvenance
) {
    const rawMappings = predictorProvenance
        && predictorProvenance.validationCreatorChannelMappings;
    const explicitMappings = new Map();
    const addExplicitMapping = (key, value) => {
        if (key == null || !String(key)) return;
        const normalizedKey = String(key);
        if (!explicitMappings.has(normalizedKey)) {
            explicitMappings.set(normalizedKey, []);
        }
        explicitMappings.get(normalizedKey).push(
            value == null ? '' : String(value)
        );
    };
    if (Array.isArray(rawMappings)) {
        for (const mapping of rawMappings) {
            if (!mapping || typeof mapping !== 'object') continue;
            const youtubeChannelId =
                mapping.youtubeChannelId
                || mapping.youtube_channel_id
                || mapping.channelId
                || mapping.channel_id;
            for (const key of [
                mapping.accountId,
                mapping.account_id,
                mapping.internalChannelId,
                mapping.internal_channel_id,
            ]) {
                addExplicitMapping(key, youtubeChannelId);
            }
        }
    } else if (
        rawMappings
        && typeof rawMappings === 'object'
    ) {
        for (const [key, value] of Object.entries(rawMappings)) {
            const candidate = value && typeof value === 'object'
                ? value.youtubeChannelId
                    || value.youtube_channel_id
                    || value.channelId
                    || value.channel_id
                : value;
            addExplicitMapping(key, candidate);
        }
    }
    const resolved = (channels || []).map(source => {
        const manifest = source
            && source.manifest
            && typeof source.manifest === 'object'
            ? source.manifest
            : {};
        const candidates = [
            ['source.youtubeChannelId', source && source.youtubeChannelId],
            ['source.youtube_channel_id', source && source.youtube_channel_id],
            ['manifest.youtubeChannelId', manifest.youtubeChannelId],
            ['manifest.youtube_channel_id', manifest.youtube_channel_id],
            ['manifest.channelId', manifest.channelId],
            ['manifest.channel_id', manifest.channel_id],
            ...(explicitMappings.get(
                String(source && source.accountId || '')
            ) || []).map(value => ['mapping.accountId', value]),
            ...(explicitMappings.get(
                String(source && source.channelId || '')
            ) || []).map(value => ['mapping.internalChannelId', value]),
        ].map(([field, value]) => ({
            field,
            original: value == null ? null : String(value),
            canonical: canonicalYoutubeChannelId(value),
        })).filter(candidate => candidate.original);
        const canonicalIds = [...new Set(
            candidates.map(candidate => candidate.canonical).filter(Boolean)
        )];
        const invalidCandidates = candidates.filter(
            candidate => !candidate.canonical
        );
        return {
            accountId: String(source && source.accountId || ''),
            internalChannelId: String(source && source.channelId || ''),
            youtubeChannelId:
                canonicalIds.length === 1 ? canonicalIds[0] : null,
            sources: candidates,
            invalidCandidates,
            conflict: canonicalIds.length > 1,
            resolved: canonicalIds.length === 1
                && invalidCandidates.length === 0,
        };
    });
    const declaredRaw = predictorProvenance
        && predictorProvenance.validationCreatorChannelIds;
    const declared = Array.isArray(declaredRaw)
        ? declaredRaw.map(value => ({
            original: String(value || ''),
            canonical: canonicalYoutubeChannelId(value),
        }))
        : [];
    const invalidDeclared = declared.filter(item => !item.canonical);
    const declaredIds = [...new Set(
        declared.map(item => item.canonical).filter(Boolean)
    )].sort();
    const resolvedIds = [...new Set(
        resolved.map(item => item.youtubeChannelId).filter(Boolean)
    )].sort();
    const mappingsComplete = resolved.length > 0
        && resolved.every(item => item.resolved);
    const declaredSetMatches = declaredIds.length > 0
        && stableJson(declaredIds) === stableJson(resolvedIds);
    const blockers = [];
    for (const item of resolved) {
        if (!item.youtubeChannelId) {
            blockers.push(
                `${item.accountId || item.internalChannelId || 'unknown creator'} has no unambiguous canonical YouTube channel ID mapping.`
            );
        }
        for (const invalid of item.invalidCandidates) {
            blockers.push(
                `${item.accountId || item.internalChannelId || 'unknown creator'} ${invalid.field} uses a non-YouTube channel-ID namespace (${invalid.original}).`
            );
        }
        if (item.conflict) {
            blockers.push(
                `${item.accountId || item.internalChannelId || 'unknown creator'} resolves to conflicting canonical YouTube channel IDs.`
            );
        }
    }
    if (!declared.length) {
        blockers.push(
            'Predictor provenance does not declare the canonical validationCreatorChannelIds exclusion set.'
        );
    }
    if (invalidDeclared.length) {
        blockers.push(
            'Predictor provenance validationCreatorChannelIds contains non-canonical YouTube channel IDs.'
        );
    }
    if (declared.length && !declaredSetMatches) {
        blockers.push(
            'Predictor exclusion channel IDs do not exactly match the canonical IDs resolved from explicit mappings or manifest metadata.'
        );
    }
    return {
        passed: mappingsComplete
            && invalidDeclared.length === 0
            && declaredSetMatches
            && blockers.length === 0,
        mappingsComplete,
        declaredSetMatches,
        canonicalChannelIds: resolvedIds,
        declaredCanonicalChannelIds: declaredIds,
        resolved,
        invalidDeclaredChannelIds: invalidDeclared.map(
            item => item.original
        ),
        blockers: [...new Set(blockers)],
        rule: 'Validation creators are compared only in the canonical YouTube UC… channel-ID namespace. IDs must resolve from explicit account/internal-ID mappings or channel manifest metadata, and must exactly match the producer-declared exclusion set. Internal ch… IDs and unknown mappings fail closed.',
    };
}

function canonicalFitManifestRows(rows) {
    return (rows || []).map(row => ({
        id: String(row && row.id || ''),
        channelId: String(
            row && (row.channelId || row.channel_id) || ''
        ),
    })).sort((left, right) => (
        left.id.localeCompare(right.id)
        || left.channelId.localeCompare(right.channelId)
    ));
}

function auditPublicAxisOverlap(
    predictorProvenance,
    privateEvaluationIds,
    savedEvaluationIds,
    validationCreatorChannelIdentity
) {
    const manifests = predictorProvenance
        && predictorProvenance.publicAxisFitManifests;
    const populations = predictorProvenance
        && predictorProvenance.publicAxisFitPopulations;
    const expectedKeys = STRICT_FORECAST_RAW_FEATURES.map(name => (
        name.replace(/\.raw$/, '')
    ));
    const privateIds = new Set((privateEvaluationIds || []).map(String));
    const savedIds = new Set((savedEvaluationIds || []).map(String));
    const creatorIdentityAudit = validationCreatorChannelIdentity
        && typeof validationCreatorChannelIdentity === 'object'
        ? validationCreatorChannelIdentity
        : {
            passed: false,
            canonicalChannelIds: [],
            blockers: [
                'Canonical validation-creator channel identity audit is missing.',
            ],
        };
    const validationChannels = new Set(
        (creatorIdentityAudit.canonicalChannelIds || []).map(String)
    );
    const results = expectedKeys.map(key => {
        const manifest = manifests && manifests[key];
        const populationSha256 = String(
            manifest && (
                manifest.populationSha256
                || manifest.rowsSha256
            ) || ''
        ).toLowerCase();
        const population = populations && populations[populationSha256];
        const usesPopulation = !!(
            manifest
            && manifest.populationSha256
        );
        const populationHashValid = !usesPopulation || !!(
            population
            && String(population.rowsSha256 || '').toLowerCase()
                === populationSha256
        );
        const rows = canonicalFitManifestRows(
            manifest && manifest.rows
                || population && population.rows
        );
        const computedSha256 = sha256Json(rows);
        const recordedSha256 = String(
            manifest && manifest.rowsSha256 || ''
        ).toLowerCase();
        const hashValid = /^[a-f0-9]{64}$/.test(recordedSha256)
            && recordedSha256 === computedSha256
            && (
                !populationSha256
                || populationSha256 === recordedSha256
            )
            && populationHashValid
            && (
                !manifest
                || !finite(manifest.rowCount)
                || Number(manifest.rowCount) === rows.length
            );
        const privateOverlap = rows.filter(row => privateIds.has(row.id));
        const savedOverlap = rows.filter(row => savedIds.has(row.id));
        const invalidChannelIdentityRows = rows.filter(
            row => !canonicalYoutubeChannelId(row.channelId)
        );
        const creatorOverlap = rows.filter(
            row => validationChannels.has(row.channelId)
        );
        return {
            key,
            rows: rows.length,
            computedSha256,
            recordedSha256: recordedSha256 || null,
            populationSha256: populationSha256 || null,
            populationHashValid,
            hashValid,
            privateOverlap: privateOverlap.map(row => row.id),
            savedOverlap: savedOverlap.map(row => row.id),
            validationCreatorOverlap: creatorOverlap.map(row => row.id),
            invalidChannelIdentityRows:
                invalidChannelIdentityRows.map(row => row.id),
        };
    });
    const privateOverlap = [...new Set(results.flatMap(
        result => result.privateOverlap
    ))];
    const savedOverlap = [...new Set(results.flatMap(
        result => result.savedOverlap
    ))];
    const validationCreatorOverlap = [...new Set(results.flatMap(
        result => result.validationCreatorOverlap
    ))];
    const invalidFitChannelIdentityRows = [...new Set(results.flatMap(
        result => result.invalidChannelIdentityRows
    ))];
    const manifestsComplete = results.every(
        result => result.rows > 0
            && result.hashValid
            && result.invalidChannelIdentityRows.length === 0
    );
    const referencedPopulationSha256 = new Set(results.map(
        result => result.populationSha256
    ).filter(Boolean));
    const orphanPopulationSha256 = Object.keys(populations || {}).filter(
        sha256 => !referencedPopulationSha256.has(sha256)
    );
    return {
        passed: manifestsComplete
            && creatorIdentityAudit.passed === true
            && privateOverlap.length === 0
            && savedOverlap.length === 0
            && validationCreatorOverlap.length === 0
            && orphanPopulationSha256.length === 0,
        manifestsComplete,
        expectedManifestCount: expectedKeys.length,
        validManifestCount: results.filter(
            result => result.rows > 0 && result.hashValid
        ).length,
        privateOverlap,
        savedOverlap,
        validationCreatorOverlap,
        invalidFitChannelIdentityRows,
        validationCreatorChannelIdentityAudit:
            creatorIdentityAudit,
        uniqueFitPopulations: referencedPopulationSha256.size,
        orphanPopulationSha256,
        manifests: results,
        rule: 'Every creator-excluded public coordinate must resolve to one exact content-addressed fit population whose rows use canonical YouTube channel IDs. Validation creators resolve from explicit mappings or manifest metadata in that same namespace. Identical populations are stored once and referenced by hash. Train/evaluation overlap is recomputed locally; caller-supplied overlap counters and unknown ID mappings are rejected.',
    };
}

function featureContractFileSha256() {
    return crypto.createHash('sha256').update(
        fs.readFileSync(path.join(__dirname, 'saved-channel-feature-contract.json'))
    ).digest('hex');
}

function coordinateGovernanceFileSha256() {
    return crypto.createHash('sha256').update(
        fs.readFileSync(path.join(__dirname, 'quant-coordinate-governance.json'))
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
    const foldAssignment = contentFamilyFoldAssignments(
        rows || [],
        5,
        'outer'
    );
    const videoFolds = Array.from(
        { length: foldAssignment.folds },
        (_, fold) => {
        const testingIds = ids.filter(
            (_, index) => foldAssignment.assignments[index] === fold
        );
        const trainingIds = ids.filter(
            (_, index) => foldAssignment.assignments[index] !== fold
        );
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
        contentFamilyCount: foldAssignment.contentFamilies,
        foldAlgorithm: 'content-family-grouped-balanced-v1',
        videoFolds,
        accountHoldouts,
    };
}

function lineageRuntimeContext(
    rows,
    predictorProvenance,
    predictorPrivateRows,
    forecastModel,
    visualKeepStudy,
    creatorAdaptiveStudy,
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
    const visualKeepPromotionAudit = promotionEligibilityAudit(
        visualKeepStudy,
        'visual_keep'
    );
    const creatorAdaptivePromotionAudit = promotionEligibilityAudit(
        creatorAdaptiveStudy,
        'creator_adaptive_keep'
    );
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
        visualKeepModel: visualKeepStudy ? {
            coordinateId: visualKeepStudy.coordinateId || VISUAL_KEEP_COORDINATE_ID,
            fitPopulation: visualKeepStudy.production
                && visualKeepStudy.production.fitPopulation || null,
            selected: visualKeepStudy.formula
                && visualKeepStudy.formula.selected || null,
            population: visualKeepStudy.population || null,
            promotion: visualKeepStudy.promotion || null,
            promotionAudit: visualKeepPromotionAudit,
            artifact: {
                ...(visualKeepStudy.modelArtifact
                    || predictorProvenance.visualKeepModelArtifact
                    || {}),
                manifestKey: predictorProvenance.runtimeManifests
                    && predictorProvenance.runtimeManifests.visualKeepModelRelease
                    && predictorProvenance.runtimeManifests.visualKeepModelRelease.key
                    || null,
                manifestSha256: predictorProvenance.runtimeManifests
                    && predictorProvenance.runtimeManifests.visualKeepModelRelease
                    && predictorProvenance.runtimeManifests.visualKeepModelRelease.manifestSha256
                    || null,
            },
        } : null,
        creatorAdaptiveKeepModel: creatorAdaptiveStudy ? {
            coordinateId: creatorAdaptiveStudy.coordinateId
                || CREATOR_ADAPTIVE_KEEP_MODEL_COORDINATE_ID,
            selected: creatorAdaptiveStudy.selection
                && creatorAdaptiveStudy.selection.selected || null,
            candidateRegistrySha256: creatorAdaptiveStudy.selection
                && creatorAdaptiveStudy.selection.candidateRegistrySha256 || null,
            candidateCountWithAllAccounts: creatorAdaptiveStudy.selection
                && creatorAdaptiveStudy.selection.candidateCountWithAllAccounts || null,
            population: creatorAdaptiveStudy.population || null,
            formula: creatorAdaptiveStudy.formula || null,
            status: creatorAdaptiveStudy.status || null,
            evaluationTarget: creatorAdaptiveStudy.evaluation
                && creatorAdaptiveStudy.evaluation.target || null,
            honestHistoryBaseline: creatorAdaptiveStudy.evaluation
                && creatorAdaptiveStudy.evaluation.target
                && creatorAdaptiveStudy.evaluation.target.baseline || null,
            predictorEligibility: creatorAdaptiveStudy.status
                && {
                    state: creatorAdaptiveStudy.status.state || null,
                    promoted: creatorAdaptiveStudy.status.promoted === true,
                    predictorEligible:
                        creatorAdaptiveStudy.status.predictorEligible === true,
                    effectivePromoted:
                        creatorAdaptivePromotionAudit.effectivePromoted,
                    effectivePredictorEligible:
                        creatorAdaptivePromotionAudit
                            .effectivePredictorEligible,
                    promotionBlocker:
                        creatorAdaptiveStudy.status.promotionBlocker || null,
                },
            promotionAudit: creatorAdaptivePromotionAudit,
            artifact: {
                ...(creatorAdaptiveStudy.modelArtifact
                    || predictorProvenance.creatorAdaptiveKeepModelArtifact
                    || {}),
                manifestKey: predictorProvenance.runtimeManifests
                    && predictorProvenance.runtimeManifests.creatorAdaptiveKeepModelRelease
                    && predictorProvenance.runtimeManifests.creatorAdaptiveKeepModelRelease.key
                    || null,
                manifestSha256: predictorProvenance.runtimeManifests
                    && predictorProvenance.runtimeManifests.creatorAdaptiveKeepModelRelease
                    && predictorProvenance.runtimeManifests.creatorAdaptiveKeepModelRelease.manifestSha256
                    || null,
            },
        } : null,
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
        coordinateGovernanceVersion: coordinateGovernance.schemaVersion,
        coordinateGovernanceSha256: coordinateGovernanceFileSha256(),
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
                formula: 'A separate standardized Ridge is fit for each outcome over exactly nine creator-excluded public axes. Each target keeps its own eligible population. Lambda is selected inside each outer holdout from [0.01, 0.1, 1, 10, 100, 1000] by 75% creator-macro standardized MSE plus 25% worst-creator standardized MSE.',
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
                rule: 'Outer deterministic video folds estimate performance; ridge penalty selection occurs only inside each outer training fold and gives each outcome family equal total selection weight.',
            },
            'validation.nested-account-holdout': {
                label: 'Nested account-transfer forecast',
                rule: 'The evaluated account is excluded from the outer fit and all inner model selection; correlated outcomes cannot gain extra hyperparameter-selection weight by appearing under multiple labels.',
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
    // Channel-free lineage entries are registered at runtime rather than in the
    // contract document: the predictor-lab atomic release pointer pins the exact
    // contract-file sha256, so editing the document would fail closed until a new
    // model release is cut. These additions never enter the canonical contract
    // identity or the stored-score coordinate universe.
    representations['representation.shorts.concat.gemini4608.v1'] = {
        domain: 'shorts', modality: 'concat',
        rawInputSetIds: ['input.shorts.first5-montage.v1', 'input.shorts.first5-transcript.v1', 'input.shorts.first5-montage-transcript.v1'],
        model: 'gemini-embedding-2 (three modality vectors concatenated)',
        dimensions: 4608,
        scoringNormalization: 'each 1536-D modality embedding is L2-normalized independently, then concatenated visual+text+together',
        artifactId: 'artifact.repo.shorts.channel-free-scores.v1',
    };
    datasets['dataset.shorts.channel-free-private-keep.v1'] = {
        domain: 'shorts', role: 'channel-free pooled research fit',
        representationPopulation: 'The 584 private keep-labeled videos across all four owned accounts with visual, text, and together embeddings present.',
        labelInputSetId: 'input.shorts.private-outcomes.v1',
        targets: ['keep'],
        selectionRule: 'Pooled across accounts with NO account feature, offset, or centering; every displayed value is an out-of-fold prediction whose fold excluded the evaluated video.',
        identityHashSource: 'predictor-lab/channel-free-scores.json:identityHash',
    };
    algorithms['algorithm.shorts.channel-free-pooled-ridge.v1'] = {
        domain: 'shorts', kind: 'direct_embedding_axis',
        estimator: 'sklearn.linear_model.Ridge',
        parameters: { alphaGrid: [1, 10, 100, 1000, 10000], alphaSelection: 'inner 4-fold MAE on training folds only', oof: '5 shuffle seeds x 5 folds; displayed value is the seed-mean OOF prediction' },
        fit: 'One pooled direction per signal over normalized embeddings to raw keep; zero creator information.',
        scalarFormula: 'oof_prediction = clip(normalized_embedding @ coefficient + intercept, 0, 100)',
        sourceCode: ['buildings/jarvis/predictor-lab/run_channel_free_signal.py'],
    };
    artifacts['artifact.repo.shorts.channel-free-scores.v1'] = {
        domain: 'shorts', path: 'buildings/jarvis/predictor-lab/channel-free-scores.json',
        contains: ['video IDs', 'per-video held-out OOF keep predictions for visual/text/together/concat', 'runId', 'identityHash', 'validated summary metrics'],
        runtimeRevisionRequired: false,
        repoCommitted: true,
    };
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
    families['family.shorts.visual-keep-production.v1'] = {
        id: 'family.shorts.visual-keep-production.v1',
        label: 'Frozen visual-only keep forecast',
        fitDatasetId: 'dataset.shorts.visual-keep-final-fit.v1',
        selectionRule: 'The pooled Ridge setting is selected inside training-only folds, then one pooled-global formula is frozen. The canonical row coordinate accepts only a score-time value cryptographically bound to the exact input and active release. Final-fit reconstructions remain separate study metadata; leakage-controlled protocol predictions remain separate evidence.',
    };
    for (const definition of Object.values(VISUAL_KEEP_PROTOCOL_COORDINATES)) {
        families[definition.familyId] = {
            id: definition.familyId,
            label: definition.label,
            fitDatasetId: definition.datasetId,
            selectionRule: definition.description,
        };
    }
    families['family.shorts.creator-adaptive-keep.v1'] = {
        id: 'family.shorts.creator-adaptive-keep.v1',
        label: 'Creator-adaptive next-upload keep forecast',
        fitDatasetId: 'dataset.shorts.creator-adaptive-keep-prequential.v1',
        selectionRule: 'A 43,360-candidate staged registry is selected only on each creator’s chronological 50%-80% window. The locked 50/50 visual+together mixture is then evaluated on the final 20% with equal timestamps batched and only strictly earlier outcomes available.',
    };
    families['family.shorts.creator-excluded.public-axis.v1'] = {
        id: 'family.shorts.creator-excluded.public-axis.v1',
        label: 'Shared creator-excluded public axis',
        fitDatasetId: 'dataset.shorts.creator-excluded-public.v1',
        selectionRule: 'Fit one public views, outlier, or over-10M axis per modality after excluding every private row, saved row, and validation-creator row. The resulting scalar has one canonical ledger address regardless of which downstream validation protocol consumes it.',
    };
    families['family.shorts.channel-free.pooled-keep.v1'] = {
        id: 'family.shorts.channel-free.pooled-keep.v1',
        label: 'Channel-free pooled keep signal',
        fitDatasetId: 'dataset.shorts.channel-free-private-keep.v1',
        selectionRule: 'Four candidate signals (visual, text, together, concat) evaluated in one declared selection pass by minimum mean OOF MAE; the pooled fit uses no account feature, offset, or centering, and every displayed value is a held-out OOF prediction. Rank-first: absolute keep does not transfer to unseen creators.',
    };
    families['family.long.outlier-neighbor.v1'] = {
        id: 'family.long.outlier-neighbor.v1',
        label: 'Long views-per-subscriber neighbor diagnostic',
        fitDatasetId: 'dataset.long.raw-manifold.v1',
        selectionRule: 'Resolve views per subscriber from the ID-aligned Long reference manifold. This is an in-corpus diagnostic, not a held-out prediction protocol.',
    };

    inputSets['input.runtime.shorts.creator-excluded-nine-public-axes.v1'] = {
        domain: 'shorts',
        kind: 'registered-coordinate-vector',
        members: ['visual', 'text', 'together'].flatMap(modality => (
            ['views', 'outlier', 'gt10M'].map(target => (
                `shorts.creator-excluded.${modality}.${target}`
            ))
        )),
        construction: 'Exactly nine unique creator-excluded direct public coordinates. Validation protocol is attached to a downstream forecast, never represented by copying these nine values to a second ledger address.',
        sourceCode: 'buildings/jarvis/saved-channel-validation.js:STRICT_FORECAST_RAW_FEATURES',
    };
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
    representations['representation.runtime.shorts.creator-excluded-nine-axis-vector.v1'] = {
        domain: 'shorts',
        kind: 'combined registered-coordinate representation',
        dimensions: 9,
        rawInputSetIds: ['input.runtime.shorts.creator-excluded-nine-public-axes.v1'],
        construction: 'For each outer training fold, subtract each coordinate mean and divide by its training standard deviation. A missing coordinate is encoded as standardized zero, which is exactly training-mean imputation.',
    };
    datasets['dataset.runtime.shorts.observed-joined.v1'] = {
        domain: 'shorts',
        role: 'evaluation truth',
        selectionRule: 'Join saved-channel and private/public outcome snapshots by exact video ID.',
        rowCount: runtime.joinedEvaluationPopulation.count,
        videoIdHash: runtime.joinedEvaluationPopulation.idSha256,
        byAccount: runtime.joinedEvaluationPopulation.byAccount,
    };
    datasets['dataset.shorts.visual-keep-final-fit.v1'] = {
        ...(datasets['dataset.shorts.visual-keep-final-fit.v1'] || {}),
        id: 'dataset.shorts.visual-keep-final-fit.v1',
        domain: 'shorts',
        role: 'final frozen model fit',
        selectionRule: 'Every private row with a canonical 1,536D visual opening embedding and a finite stayed-to-watch label. The final formula is fit once after nested candidate selection.',
        runtimeSnapshot: runtime.visualKeepModel ? {
            rowCount: runtime.visualKeepModel.fitPopulation
                && runtime.visualKeepModel.fitPopulation.n || null,
            videoIdHash: runtime.visualKeepModel.fitPopulation
                && runtime.visualKeepModel.fitPopulation.videoIdSha256 || null,
            byAccount: runtime.visualKeepModel.fitPopulation
                && runtime.visualKeepModel.fitPopulation.byAccount || null,
            artifactRevision: runtime.visualKeepModel.artifact
                && runtime.visualKeepModel.artifact.artifactSha256 || null,
        } : null,
    };
    datasets['dataset.shorts.visual-keep-video-holdout.v1'] = {
        id: 'dataset.shorts.visual-keep-video-holdout.v1',
        domain: 'shorts',
        role: 'known-creator nested video holdout',
        selectionRule: 'Deterministic balanced five-fold video holdout. Every test video is excluded from the outer fit; pooled Ridge strength, creator-specific Ridge strength, and blend weight are selected again in four inner folds.',
        runtimeSnapshot: runtime.visualKeepModel ? {
            population: runtime.visualKeepModel.population,
            predictorArtifactRevision:
                runtime.predictorArtifact.artifactSha256 || null,
        } : null,
    };
    datasets['dataset.shorts.visual-keep-forward-time.v1'] = {
        id: 'dataset.shorts.visual-keep-forward-time.v1',
        domain: 'shorts',
        role: 'same-creator chronological backtest',
        selectionRule: 'For each creator and test window, model kind, lookback, and Ridge strength are selected on still-earlier windows and fitted only on uploads published before the test window.',
        runtimeSnapshot: runtime.visualKeepModel ? {
            population: runtime.visualKeepModel.population,
            predictorArtifactRevision:
                runtime.predictorArtifact.artifactSha256 || null,
        } : null,
    };
    datasets['dataset.shorts.visual-keep-account-holdout.v1'] = {
        id: 'dataset.shorts.visual-keep-account-holdout.v1',
        domain: 'shorts',
        role: 'whole-creator holdout',
        selectionRule: 'Every labeled video from the evaluated creator is excluded. Ridge strength is selected by leaving each remaining training creator out in turn before the model is fitted to all remaining creators.',
        runtimeSnapshot: runtime.visualKeepModel ? {
            population: runtime.visualKeepModel.population,
            predictorArtifactRevision:
                runtime.predictorArtifact.artifactSha256 || null,
        } : null,
    };
    datasets['dataset.shorts.creator-adaptive-keep-prequential.v1'] = {
        ...(datasets['dataset.shorts.creator-adaptive-keep-prequential.v1'] || {}),
        id: 'dataset.shorts.creator-adaptive-keep-prequential.v1',
        domain: 'shorts',
        role: 'known-creator chronological next-upload evaluation',
        selectionRule: 'The per-creator 50%-80% chronological window selects one global candidate from a fixed 43,360-candidate registry. The final 20% is replayed prequentially, with every equal-timestamp batch predicted before any outcome in that batch is revealed. This proves time-ordering, not a causal effect. The matched null is the mean of at most 30 strictly earlier same-creator labels.',
        runtimeSnapshot: runtime.creatorAdaptiveKeepModel ? {
            population: runtime.creatorAdaptiveKeepModel.population,
            selected: runtime.creatorAdaptiveKeepModel.selected,
            candidateRegistrySha256:
                runtime.creatorAdaptiveKeepModel.candidateRegistrySha256,
            candidateCountWithAllAccounts:
                runtime.creatorAdaptiveKeepModel.candidateCountWithAllAccounts,
            evaluationTarget: runtime.creatorAdaptiveKeepModel.evaluationTarget,
            honestHistoryBaseline:
                runtime.creatorAdaptiveKeepModel.honestHistoryBaseline,
            predictorEligibility:
                runtime.creatorAdaptiveKeepModel.predictorEligibility,
            artifactRevision: runtime.creatorAdaptiveKeepModel.artifact
                && runtime.creatorAdaptiveKeepModel.artifact.artifactSha256 || null,
        } : null,
    };
    algorithms['algorithm.shorts.visual-keep-pooled-ridge.v1'] = {
        ...(algorithms['algorithm.shorts.visual-keep-pooled-ridge.v1'] || {}),
        id: 'algorithm.shorts.visual-keep-pooled-ridge.v1',
        domain: 'shorts',
        kind: 'frozen combined forecast',
        fit: 'One pooled Ridge on every permitted labeled L2-normalized 1,536D visual opening vector. Creator identity is not an input and no creator-specific formula is selected at scoring time.',
        scalarFormula: 'intercept + dot(L2-normalized visual embedding, 1,536 persisted coefficients)',
        selectedHyperparameters: runtime.visualKeepModel
            && runtime.visualKeepModel.selected
            && {
                pooledAlpha: runtime.visualKeepModel.selected.pooledAlpha,
            } || null,
    };
    algorithms['algorithm.shorts.visual-keep-video-holdout-nested-blend.v1'] = {
        id: 'algorithm.shorts.visual-keep-video-holdout-nested-blend.v1',
        domain: 'shorts',
        kind: 'nested held-out combined forecast',
        fit: 'Inside each outer video fold, select pooled alpha, creator alpha, and creator blend weight from four inner folds, then fit only on the outer-training rows.',
        scalarFormula: 'clip((1 - selected creator weight) × pooled Ridge prediction + selected creator weight × same-creator Ridge prediction, 0, 100); use the pooled prediction when the outer-training creator history is insufficient.',
    };
    algorithms['algorithm.shorts.visual-keep-forward-time-ridge.v1'] = {
        id: 'algorithm.shorts.visual-keep-forward-time-ridge.v1',
        domain: 'shorts',
        kind: 'chronological held-out forecast',
        fit: 'Within each creator, select a trailing-history mean or Ridge lookback and alpha using earlier windows, then fit it only on uploads before the evaluated window.',
        scalarFormula: 'Selected trailing mean or intercept + dot(L2-normalized visual embedding, training-window Ridge coefficients).',
    };
    algorithms['algorithm.shorts.visual-keep-account-holdout-ridge.v1'] = {
        id: 'algorithm.shorts.visual-keep-account-holdout-ridge.v1',
        domain: 'shorts',
        kind: 'whole-creator held-out forecast',
        fit: 'Select pooled Ridge alpha by inner leave-creator-out error among the training creators, then fit on every creator except the evaluated one.',
        scalarFormula: 'intercept + dot(L2-normalized visual embedding, whole-creator-held-out Ridge coefficients).',
    };
    algorithms['algorithm.shorts.creator-adaptive-causal-mixture.v1'] = {
        ...(algorithms['algorithm.shorts.creator-adaptive-causal-mixture.v1'] || {}),
        id: 'algorithm.shorts.creator-adaptive-causal-mixture.v1',
        domain: 'shorts',
        kind: 'chronological known-creator combined forecast',
        fit: 'Select one staged prequential formula on the 50%-80% window, then lock it before the final tail. Creator centering, residual corrections, gates, and interval residuals update only after an entire equal-time batch.',
        scalarFormula: 'clip(0.5 × centered-together pooled residual analog + 0.5 × visual+together semantic stack, 0, 100)',
        selectedHyperparameters: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.selected || null,
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
    artifacts['artifact.shorts.visual-keep-model.v1'] = {
        ...(artifacts['artifact.shorts.visual-keep-model.v1'] || {}),
        id: 'artifact.shorts.visual-keep-model.v1',
        domain: 'shorts',
        location: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.canonicalKey
            || 'raw/predictor-lab/visual-keep-model-v1.json',
        artifactSha256: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.artifactSha256 || null,
        archiveKey: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.archiveKey || null,
        manifestKey: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.manifestKey || null,
        manifestSha256: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.manifestSha256 || null,
        generatedAt: runtime.visualKeepModel
            && runtime.visualKeepModel.artifact
            && runtime.visualKeepModel.artifact.generatedAt || null,
        coordinateId: runtime.visualKeepModel
            && runtime.visualKeepModel.coordinateId || VISUAL_KEEP_COORDINATE_ID,
        runtimeRevisionRequired: true,
        runtimeRevisionRequiredFields: [
            'artifactSha256',
            'archiveKey',
            'producerSourceSha256',
        ],
        runtimeRevision: {
            artifactSha256: runtime.visualKeepModel
                && runtime.visualKeepModel.artifact
                && runtime.visualKeepModel.artifact.artifactSha256 || null,
            archiveKey: runtime.visualKeepModel
                && runtime.visualKeepModel.artifact
                && runtime.visualKeepModel.artifact.archiveKey || null,
            manifestSha256: runtime.visualKeepModel
                && runtime.visualKeepModel.artifact
                && runtime.visualKeepModel.artifact.manifestSha256 || null,
            producerSourceSha256: runtime.visualKeepModel
                && runtime.visualKeepModel.artifact
                && runtime.visualKeepModel.artifact.producerSourceSha256 || null,
        },
    };
    artifacts['artifact.shorts.creator-adaptive-keep-model.v1'] = {
        ...(artifacts['artifact.shorts.creator-adaptive-keep-model.v1'] || {}),
        id: 'artifact.shorts.creator-adaptive-keep-model.v1',
        domain: 'shorts',
        location: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.canonicalKey
            || 'raw/predictor-lab/creator-adaptive-keep-model-v1.json',
        artifactSha256: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.artifactSha256 || null,
        archiveKey: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.archiveKey || null,
        manifestKey: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.manifestKey || null,
        manifestSha256: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.manifestSha256 || null,
        generatedAt: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.artifact
            && runtime.creatorAdaptiveKeepModel.artifact.generatedAt || null,
        coordinateId: runtime.creatorAdaptiveKeepModel
            && runtime.creatorAdaptiveKeepModel.coordinateId
            || CREATOR_ADAPTIVE_KEEP_MODEL_COORDINATE_ID,
        runtimeRevisionRequired: true,
        runtimeRevisionRequiredFields: [
            'artifactSha256',
            'archiveKey',
            'producerSourceSha256',
        ],
        runtimeRevision: {
            artifactSha256: runtime.creatorAdaptiveKeepModel
                && runtime.creatorAdaptiveKeepModel.artifact
                && runtime.creatorAdaptiveKeepModel.artifact.artifactSha256 || null,
            archiveKey: runtime.creatorAdaptiveKeepModel
                && runtime.creatorAdaptiveKeepModel.artifact
                && runtime.creatorAdaptiveKeepModel.artifact.archiveKey || null,
            manifestSha256: runtime.creatorAdaptiveKeepModel
                && runtime.creatorAdaptiveKeepModel.artifact
                && runtime.creatorAdaptiveKeepModel.artifact.manifestSha256 || null,
            producerSourceSha256: runtime.creatorAdaptiveKeepModel
                && runtime.creatorAdaptiveKeepModel.artifact
                && runtime.creatorAdaptiveKeepModel.artifact.producerSourceSha256 || null,
        },
    };
    artifacts['artifact.runtime.saved-channel-validation.v6'] = {
        domain: 'shorts',
        location: 'buildings/jarvis/saved-channel-validation.js',
        coordinateRegistryVersion: LEDGER_VERSION,
        coordinateGovernanceVersion: runtime.coordinateGovernanceVersion,
        coordinateGovernanceSha256: runtime.coordinateGovernanceSha256,
        artifactRevision: runtime.validationArtifact.sourceFingerprint,
        generatedAt: runtime.validationArtifact.generatedAt,
        producerSourceSha256: runtime.validationArtifact.producerSourceSha256,
        revisionMeaning: 'SHA-256 over every source artifact consumed by buildSavedChannelValidationBuffer(), including predictor, manifests, private tables, saved-channel manifests, contract, and this producer source.',
        runtimeRevisionRequired: true,
        runtimeRevisionRequiredFields: [
            'artifactRevision',
            'producerSourceSha256',
            'coordinateGovernanceSha256',
        ],
        runtimeRevision: {
            artifactRevision: runtime.validationArtifact.sourceFingerprint,
            producerSourceSha256: runtime.validationArtifact.producerSourceSha256,
            coordinateGovernanceSha256: runtime.coordinateGovernanceSha256,
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

function buildShortsMapProjectionInventory(lineageCatalog) {
    const keys = contract.crossDomainInventory.shorts.mapProjections.slice();
    const maps = Object.entries(lineageCatalog.visualizations || {})
        .filter(([, definition]) => definition.domain === 'shorts')
        .map(([id, definition]) => ({
            id,
            mapKey: definition.mapKey,
            target: definition.target,
        }));
    const errors = [];
    const keyCounts = new Map();
    for (const key of keys) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of keyCounts.entries()) {
        if (count !== 1) errors.push(`duplicate-projection-key:${key}`);
    }
    const mapCounts = new Map();
    for (const map of maps) {
        mapCounts.set(map.mapKey, (mapCounts.get(map.mapKey) || 0) + 1);
        if (
            map.id === 'map.shorts.swipe.v1'
            || map.mapKey === 'swipe'
            || map.target === '100 - keep'
        ) {
            errors.push(`retired-swipe-map-advertised:${map.id}`);
        }
    }
    if (keyCounts.has('swipe')) {
        errors.push('retired-swipe-projection-advertised:swipe');
    }
    for (const key of keys) {
        if (mapCounts.get(key) !== 1) {
            errors.push(
                `projection-map-cardinality:${key}:${mapCounts.get(key) || 0}`
            );
        }
    }
    for (const map of maps) {
        if (!keyCounts.has(map.mapKey)) {
            errors.push(`unadvertised-canonical-map:${map.id}`);
        }
    }
    if (errors.length) {
        throw new Error(
            `Invalid canonical Shorts map inventory: ${errors.join(', ')}`
        );
    }
    return {
        keys,
        mapIds: maps.map(map => map.id),
        note: 'Canonical fitted map planes only. Swipe-away is supplied separately by the governed non-stored 100 - keep display transform.',
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

function lineageForCreatorExcludedPublic(definition) {
    const targetKey = definition.target === 'gt10M'
        ? 'gt10M'
        : definition.target;
    return {
        rawInputIds: groupInputIds(definition.group),
        representationId: groupRepresentationId(definition.group),
        fitDatasetId: 'dataset.shorts.creator-excluded-public.v1',
        fitDataset: [{
            id: 'dataset.shorts.creator-excluded-public.v1',
            role: `One shared fit for ${definition.group}.${targetKey}. Every private row, saved row, and validation-creator row is excluded before fitting.`,
        }],
        targetField: definition.target === 'views'
            ? 'log10(public lifetime views + 1)'
            : (definition.target === 'outlier'
                ? 'log10(public views/subscribers + 1)'
                : definition.target),
        algorithmId: definition.target === 'gt10M'
            ? 'algorithm.shorts.public-heldout-pls1-binary.v1'
            : 'algorithm.shorts.public-heldout-pls1-quantile.v1',
        scalarProjection: definition.target === 'gt10M'
            ? 'L2-normalized 1536D embedding enters one creator-excluded public PLS axis; the displayed probability is the local observed 10M rate near its fitted rank.'
            : 'L2-normalized 1536D embedding enters one creator-excluded public PLS axis; its fitted rank is quantile-mapped to the sorted public outcome distribution.',
        calibrationId: definition.target === 'views' || definition.target === 'outlier'
            ? 'calibration.inverse-log10-nonnegative.v1'
            : 'calibration.identity-target-units.v1',
        validationProtocolId: 'family.shorts.creator-excluded.public-axis.v1',
        artifactId: 'artifact.runtime.shorts.blind-predictor.v1',
        sourceCode: [
            'buildings/jarvis/predictor-lab/run_predictor_lab.py:fit_public_axes',
        ],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        underlyingAxisId:
            `axis.shorts.creator-excluded.${definition.group}.${targetKey}`,
        computationReuse: 'One fitted scalar is reused as an input to both video-held-out and account-held-out downstream forecast protocols without duplicating its ledger address.',
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
    const axisInputId =
        'input.runtime.shorts.creator-excluded-nine-public-axes.v1';
    const axisRepresentationId =
        'representation.runtime.shorts.creator-excluded-nine-axis-vector.v1';
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
        artifactId: 'artifact.runtime.saved-channel-validation.v6',
        sourceCode: ['buildings/jarvis/saved-channel-validation.js:attachScore21Forecasts'],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        forecastBundle: checkpoint ? 'checkpoints' : 'scalar',
        reproducibility: { status: 'deterministic-from-blind-artifact' },
    };
}

function lineageForVisualKeepForecast() {
    return {
        rawInputIds: ['input.shorts.first5-montage.v1'],
        representationId: 'representation.shorts.visual.gemini1536.v1',
        fitDatasetId: 'dataset.shorts.visual-keep-final-fit.v1',
        fitDataset: [{
            id: 'dataset.shorts.visual-keep-final-fit.v1',
            role: 'Fits one frozen final pooled Ridge formula after nested candidate selection.',
        }],
        targetField: 'observed stayed-to-watch percentage',
        algorithmId: 'algorithm.shorts.visual-keep-pooled-ridge.v1',
        scalarProjection: 'The complete L2-normalized 1,536D visual opening embedding enters one frozen pooled Ridge formula. Creator identity is never an input, so the same vector always receives the same scalar.',
        calibrationId: 'calibration.identity-target-units.v1',
        validationProtocolId: 'family.shorts.visual-keep-production.v1',
        artifactId: 'artifact.shorts.visual-keep-model.v1',
        sourceCode: [
            'buildings/jarvis/predictor-lab/run_predictor_lab.py:run_visual_keep_study',
            'raw_upload.py:visual_keep_forecast',
        ],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        reproducibility: {
            status: 'frozen-artifact-pinned',
            warning: 'This coordinate accepts only the exact score-time scalar persisted with a cryptographically bound input manifest and active artifact/manifest release tuple. Final-fit training reconstructions are excluded from this coordinate and retained only as study metadata. Video, forward-time, and account holdouts are separate validation coordinates.',
        },
    };
}

function lineageForVisualKeepProtocol(protocolKey) {
    const definition = VISUAL_KEEP_PROTOCOL_COORDINATES[protocolKey];
    if (!definition) throw new Error(`Unknown visual keep protocol: ${protocolKey}`);
    return {
        rawInputIds: ['input.shorts.first5-montage.v1'],
        representationId: 'representation.shorts.visual.gemini1536.v1',
        fitDatasetId: definition.datasetId,
        fitDataset: [{
            id: definition.datasetId,
            role: definition.description,
        }],
        targetField: 'observed stayed-to-watch percentage',
        algorithmId: definition.algorithmId,
        scalarProjection: `${definition.description} The returned value is already a keep-rate percentage; no second outcome-fitted calibration is applied.`,
        calibrationId: 'calibration.identity-target-units.v1',
        validationProtocolId: definition.familyId,
        artifactId: 'artifact.runtime.shorts.blind-predictor.v1',
        sourceCode: [
            'buildings/jarvis/predictor-lab/run_predictor_lab.py:run_visual_keep_study',
            'buildings/jarvis/saved-channel-validation.js:buildValidation',
        ],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        reproducibility: {
            status: 'deterministic-protocol-artifact',
            warning: 'This is a protocol-specific research prediction, not the frozen production scalar and not the visual keep map estimate. It is available only for rows that participated in this exact held-out protocol.',
        },
    };
}

function lineageForCreatorAdaptiveKeepForecast() {
    return {
        rawInputIds: [
            'input.shorts.first5-montage-transcript.v1',
            'input.shorts.private-outcomes.v1',
        ],
        representationId: [
            'representation.shorts.visual.gemini1536.v1',
            'representation.shorts.together.gemini1536.v1',
        ],
        fitDatasetId: 'dataset.shorts.creator-adaptive-keep-prequential.v1',
        fitDataset: [{
            id: 'dataset.shorts.creator-adaptive-keep-prequential.v1',
            role: 'For each evaluated upload, use only the same creator profile and its strictly earlier measured keep outcomes.',
        }],
        targetField: 'observed stayed-to-watch percentage',
        algorithmId: 'algorithm.shorts.creator-adaptive-causal-mixture.v1',
        scalarProjection: 'Return a 50/50 mixture of the selection-locked centered-together residual analog and visual+together chronological semantic stack, using up to 30 strictly earlier creator labels as the baseline.',
        calibrationId: 'calibration.identity-target-units.v1',
        validationProtocolId: 'family.shorts.creator-adaptive-keep.v1',
        artifactId: 'artifact.shorts.creator-adaptive-keep-model.v1',
        sourceCode: [
            'buildings/jarvis/predictor-lab/run_predictor_lab.py:run_creator_adaptive_keep_study',
            'scripts/benchmark-causal-keep-mixture.py',
        ],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: true,
        reproducibility: {
            status: 'causal-prequential-artifact-pinned',
            warning: 'Valid only for an explicit known creator profile with sufficient earlier labeled history. It is multimodal, has no single native 2D embedding plane, and is not a cold-start or anonymous-upload forecast.',
        },
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
        artifactId: 'artifact.runtime.saved-channel-validation.v6',
        sourceCode: ['buildings/jarvis/saved-channel-validation.js:OUTCOME_DEFINITIONS'],
        visualizationId: 'map.runtime.none.v1',
        usesEmbedding: false,
        reproducibility: { status: 'deterministic-from-observed-snapshot' },
    };
}

function longLineage(group, metric) {
    const rawInputId = {
        visual: 'input.long.thumbnail.v1',
        text: 'input.long.title.v1',
        together: 'input.long.thumbnail-title.v1',
    }[group];
    const representationId = {
        visual: 'representation.long.visual.gemini1536.v1',
        text: 'representation.long.text.gemini1536.v1',
        together: 'representation.long.together.gemini1536.v1',
    }[group];
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
            ? 'family.long.ctrviews-neighbor.v1'
            : (metric.key === 'ctr' || metric.key === 'ret30'
                ? 'family.long.ctr-ret30-neighbor.v1'
                : (metric.key === 'views'
                    ? 'family.long.views-neighbor.v1'
                    : (metric.key === 'scaled_views'
                        ? 'family.long.outlier-neighbor.v1'
                    : (metric.key === 'realviews'
                        ? 'family.long.realviews-neighbor.v1'
                        : 'family.long.gt10m-neighbor.v1')))));
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
            id: {
                visual: 'artifact.long.embeddings.visual.v1',
                text: 'artifact.long.embeddings.text.v1',
                together: 'artifact.long.embeddings.together.v1',
            }[group],
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
    } else if (
        metric.key === 'views'
        || metric.key === 'scaled_views'
        || metric.key === 'gt10m'
    ) {
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
                    ? 'L2-normalize the query; select up to 24 archive neighbors; retain the 1-24 IDs present in the ctrviews map; weight the persisted ctrviews estimate array by max(sim, 0)^8; rank the result in that same estimate array. If the map has geometry but no estimate array, this scalar is unavailable and only the separately registered map placement may be displayed.'
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
        visualizationId: `map.long.${metric.projectionKey}.v1`,
        visualization: [{
            id: `map.long.${metric.projectionKey}.v1`,
            role: frozenVisual
                ? 'Related target display only; it is not the frozen scalar ladder used by the score.'
                : 'Registered display map for the same named reference metric. Its x/y marker and percentile are a separate map-placement diagnostic and are never substituted for the scalar estimate.',
        }],
        usesEmbedding: true,
        reproducibility: {
            status: frozenVisual
                ? 'frozen-artifact-required-not-held-out'
                : 'diagnostic-not-held-out',
            validationStatus: 'not-held-out',
            disclosure: frozenVisual
                ? 'The direct visual coordinate is available only when the frozen scorer_visual.npz artifact (or its legacy JSON serialization) is present. Its current fit population is not an account- or video-held-out accuracy study.'
                : 'This Long neighbor estimate is an in-corpus diagnostic. It cannot support predictive-accuracy claims until a registered video/account-held-out Long evaluation is added.',
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
            const targetPopulations = value
                && value.scalarEligibilityByTarget;
            return value
                && Number.isInteger(Number(value.scalarEligible))
                && exactHash(value.scalarEligibleVideoIdSha256)
                && targetPopulations
                && Object.values(targetPopulations).length > 0
                && Object.values(targetPopulations).every(population => (
                    population
                    && Number.isInteger(Number(population.n))
                    && Number(population.n) >= 0
                    && exactHash(population.videoIdSha256)
                ))
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
    const runtimeProvenanceInvalid = [];
    const runtimeFieldDiagnostic = (field, value) => {
        if (field !== 'materializedEligibility') {
            return {
                present: value !== null && value !== undefined,
                type: Array.isArray(value) ? 'array' : typeof value,
                status: value && value.status || null,
            };
        }
        const targetPopulations = value
            && value.scalarEligibilityByTarget;
        const invalidTargetPopulations = Object.entries(
            targetPopulations || {}
        ).filter(([, population]) => !(
            population
            && Number.isInteger(Number(population.n))
            && Number(population.n) >= 0
            && exactHash(population.videoIdSha256)
        )).map(([key]) => key);
        const invalidFoldPopulations = (
            Array.isArray(value && value.scalarFoldPopulations)
                ? value.scalarFoldPopulations
                : []
        ).map((fold, index) => ({ fold, index }))
            .filter(({ fold }) => !(
                fold
                && Number.isInteger(Number(fold.trainingRowCount))
                && Number(fold.trainingRowCount) >= 0
                && exactHash(fold.trainingVideoIdSha256)
                && Number.isInteger(Number(fold.testingRowCount))
                && Number(fold.testingRowCount) >= 0
                && exactHash(fold.testingVideoIdSha256)
            ))
            .map(({ index }) => index);
        return {
            present: value !== null && value !== undefined,
            scalarEligible: value && value.scalarEligible,
            scalarEligibleVideoIdSha256Valid:
                exactHash(value && value.scalarEligibleVideoIdSha256),
            scalarTargetPopulationCount:
                Object.keys(targetPopulations || {}).length,
            invalidTargetPopulations,
            scalarFoldSelectionCount:
                Array.isArray(value && value.scalarFolds)
                    ? value.scalarFolds.length
                    : 0,
            scalarFoldPopulationCount:
                Array.isArray(value && value.scalarFoldPopulations)
                    ? value.scalarFoldPopulations.length
                    : 0,
            invalidFoldPopulations,
        };
    };
    for (const id of [...runtimeDatasetIds].sort()) {
        const dataset = (catalog.fitDatasets || {})[id];
        if (!dataset || !Array.isArray(dataset.runtimeProvenanceRequired)) continue;
        const snapshot = dataset.runtimeSnapshot;
        for (const field of dataset.runtimeProvenanceRequired) {
            if (!runtimeFieldComplete(field, snapshot && snapshot[field])) {
                runtimeProvenanceMissing.push(`${id}:runtimeSnapshot.${field}`);
                runtimeProvenanceInvalid.push({
                    datasetId: id,
                    field,
                    diagnostic: runtimeFieldDiagnostic(
                        field,
                        snapshot && snapshot[field]
                    ),
                });
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
                const value = valueAtPath(artifact.runtimeRevision, field);
                const complete = /sha256|revision/i.test(field)
                    ? exactHash(value)
                    : (/archive(?:key|path)/i.test(field)
                        ? (
                            typeof value === 'string'
                            && value.length > 0
                            && exactHash(valueAtPath(artifact.runtimeRevision, 'artifactSha256'))
                            && value.includes(valueAtPath(artifact.runtimeRevision, 'artifactSha256'))
                        )
                        : value !== null && value !== undefined && value !== '');
                if (!complete) {
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
        runtimeProvenanceInvalid,
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

const PREDICTOR_RANKING_FAMILIES = Object.freeze(new Set([
    'creatorExcludedPublic',
    'videoHeldout',
    'accountHeldout',
    'videoForecast',
    'accountForecast',
    'creatorAdaptiveKeepPrequential',
]));

function coordinatePredictorRankingEligible(column) {
    return !!column
        && PREDICTOR_RANKING_FAMILIES.has(column.family)
        && column.status === 'canonical'
        && column.predictorEligible === true;
}

function buildCoordinateRegistry(options = {}) {
    const predictorProvenance = options.predictorProvenance || options.provenance || {};
    const blindFoldPassed = !!(
        options.blindFoldAudit && options.blindFoldAudit.passed
    );
    const publicAxisLeakagePassed = !!(
        options.publicAxisOverlapAudit
        && options.publicAxisOverlapAudit.passed
    );
    const runtime = lineageRuntimeContext(
        options.rows || [],
        predictorProvenance,
        options.predictorPrivateRows || [],
        options.forecastModel || null,
        options.visualKeepStudy || null,
        options.creatorAdaptiveStudy || null,
        options.sourceFingerprint || null,
        options.generatedAt || null
    );
    const lineageCatalog = buildCanonicalLineageCatalog(runtime);
    const shortsMapProjections = buildShortsMapProjectionInventory(
        lineageCatalog
    );
    const creatorAdaptivePromotionAudit = promotionEligibilityAudit(
        options.creatorAdaptiveStudy || null,
        'creator_adaptive_keep'
    );
    const creatorAdaptivePredictorEligible = !!(
        creatorAdaptivePromotionAudit
        && creatorAdaptivePromotionAudit.effectivePredictorEligible
    );
    const observed = OUTCOME_DEFINITIONS.filter(
        definition => definition.key !== 'swipe'
    ).map(definition => ({
        id: coordinatePattern(
            coordinateGovernance.coordinates.observedPattern,
            { outcomeKey: definition.key }
        ),
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
        id: coordinatePattern(
            coordinateGovernance.coordinates.storedPattern,
            { featureKey: definition.key }
        ),
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
        predictorEligible: false,
        validationStatus: 'diagnostic_not_held_out',
        valueClass: definition.group === 'novelty' || definition.target === 'realviews'
            ? 'embedding_derived_transform'
            : 'direct_embedding_axis',
        lineageId: `lineage.shorts.stored.${definition.key}`,
        lineage: lineageForStored(definition),
        description: 'Exact production score persisted when the video was analyzed. The estimate and percentile are one registered coordinate.',
    }));
    const visualKeepForecast = [{
        id: VISUAL_KEEP_COORDINATE_ID,
        family: 'visualKeepForecast',
        protocol: 'frozen_model',
        group: 'visual',
        key: 'visualKeepForecast',
        target: 'keep',
        label: 'Visual · frozen 1,536D keep model score',
        unit: 'percent',
        percentileAvailable: false,
        status: 'canonical',
        predictorEligible: false,
        validationStatus: 'persisted_score_time_provenance_required',
        valueClass: 'combined_forecast',
        lineageId: 'lineage.shorts.visual-keep-forecast.v1',
        lineage: lineageForVisualKeepForecast(),
        description: 'One raw keep-rate percentage persisted at score time from the immutable pooled-global visual Ridge model. The value exists here only when its source, coordinate, artifact, release manifest, input fingerprints, score-record binding, and [0,100] output contract all match. Full-fit training reconstructions never enter this coordinate.',
    }];
    const visualKeepProtocolForecasts = Object.entries(
        VISUAL_KEEP_PROTOCOL_COORDINATES
    ).map(([protocolKey, definition]) => ({
        id: definition.id,
        family: 'visualKeepProtocolForecast',
        protocol: definition.protocol,
        protocolKey,
        group: 'visual',
        key: protocolKey,
        target: 'keep',
        label: definition.label,
        unit: 'percent',
        percentileAvailable: false,
        status: 'research_diagnostic',
        predictorEligible: false,
        valueClass: 'combined_forecast',
        lineageId: `lineage.${definition.id}`,
        lineage: lineageForVisualKeepProtocol(protocolKey),
        description: `${definition.description} This value is already out of fold and is never substituted for the frozen production forecast or a stored map estimate.`,
    }));
    const creatorAdaptiveKeepPrequential = [{
        id: CREATOR_ADAPTIVE_KEEP_PREQUENTIAL_COORDINATE_ID,
        family: 'creatorAdaptiveKeepPrequential',
        protocol: 'prequential',
        group: 'multimodal',
        key: 'creatorAdaptiveKeepPrequential',
        target: 'keep',
        label: 'Visual + both · prequential next-upload keep mixture',
        unit: 'percent',
        percentileAvailable: false,
        status: creatorAdaptivePredictorEligible
            ? 'canonical'
            : 'research_diagnostic',
        predictorEligible: creatorAdaptivePredictorEligible,
        validationStatus: creatorAdaptivePredictorEligible
            ? 'prospectively_confirmed_creator_diverse'
            : 'research_only_retrospective',
        promotionAudit: creatorAdaptivePromotionAudit,
        valueClass: 'combined_forecast',
        lineageId: 'lineage.shorts.creator-adaptive-keep.v1',
        lineage: lineageForCreatorAdaptiveKeepForecast(),
        description: creatorAdaptivePredictorEligible
            ? 'One raw keep-rate percentage from the canonical visual and together embeddings plus an explicit creator profile’s strictly earlier measured uploads. It is unavailable for cold start.'
            : 'Retrospective research coordinate from the canonical visual and together embeddings plus strictly earlier creator history. Historical target attainment cannot promote it: it stays excluded from blind-predictor rankings until an immutable prospective registration/result chain and the governed creator sample minimum both pass.',
    }];
    const creatorExcludedPublic = contract.features.filter(definition => (
        definition.group !== 'novelty'
        && coordinateGovernance.expansions.creatorExcludedPublicTargets.includes(
            definition.target
        )
    )).map(definition => ({
        id: coordinatePattern(
            coordinateGovernance.coordinates.creatorExcludedPublicPattern,
            { featureKey: definition.key }
        ),
        family: 'creatorExcludedPublic',
        protocol: 'creator_excluded',
        group: definition.group,
        key: definition.key,
        target: definition.target,
        label: `Creator-excluded ${definition.group === 'together' ? 'Both' : definition.group} · ${definition.label}`,
        unit: definition.displayUnit || definition.unit,
        storageUnit: 'blind_model_coordinate',
        sourceKey: `${definition.key}.raw`,
        percentileAvailable: false,
        status: 'canonical',
        predictorEligible: publicAxisLeakagePassed,
        validationStatus: 'research_only_creator_excluded_retrospective',
        valueClass: 'direct_embedding_axis',
        lineageId: `lineage.shorts.creator-excluded.${definition.key}`,
        lineage: lineageForCreatorExcludedPublic(definition),
        description: 'One public-corpus axis fitted after excluding every private, saved, and validation-creator video. This scalar has one ledger address and may feed multiple downstream validation protocols.',
    }));
    const direct = ['video', 'account'].flatMap(protocol => (
        contract.features.filter(definition => (
            definition.group !== 'novelty'
            && coordinateGovernance.expansions.privateHeldoutTargets.includes(
                definition.target
            )
        )).map(definition => ({
            id: coordinatePattern(
                coordinateGovernance.coordinates.privateHeldoutPattern,
                { protocol, featureKey: definition.key }
            ),
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
            status: blindFoldPassed
                && (
                    ['keep', 'ret5', 'realviews'].includes(definition.target)
                    || publicAxisLeakagePassed
                )
                ? 'canonical'
                : 'research_diagnostic',
            predictorEligible: blindFoldPassed
                && (
                    ['keep', 'ret5', 'realviews'].includes(definition.target)
                    || publicAxisLeakagePassed
                ),
            validationStatus: blindFoldPassed
                ? 'research_only_retrospective_holdout'
                : 'unverified_fold_lineage',
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
        OUTCOME_DEFINITIONS.filter(
            definition => definition.key !== 'swipe'
        ).map(definition => ({
            id: coordinatePattern(
                coordinateGovernance.coordinates.forecastPattern,
                { protocol, outcomeKey: definition.key }
            ),
            family: `${protocol}Forecast`,
            protocol,
            group: 'combined',
            key: definition.key,
            target: displayTargetForOutcome(definition.key),
            label: `${protocol === 'video' ? 'Video-held-out' : 'Account-held-out'} combined forecast · ${definition.label}`,
            unit: definition.key === 'hit10M' ? 'probability' : definition.unit,
            percentileAvailable: false,
            status: blindFoldPassed && publicAxisLeakagePassed
                ? 'canonical'
                : 'research_diagnostic',
            predictorEligible: blindFoldPassed
                && publicAxisLeakagePassed,
            validationStatus: blindFoldPassed && publicAxisLeakagePassed
                ? 'research_only_retrospective_holdout'
                : 'unverified_input_or_fold_lineage',
            valueClass: 'combined_forecast',
            lineageId: `lineage.shorts.${protocol}-forecast.${definition.key}`,
            lineage: lineageForForecast(definition, protocol),
            description: 'Fold-fitted forecast from the nine creator-excluded public views, outlier, and 10M coordinates. It is not an additional embedding axis.',
        }))
    ));
    const aliases = buildCoordinateAliases();
    const displayTransforms = (
        coordinateGovernance.displayTransforms || []
    ).map(transform => ({
        ...transform,
        valueClass: 'governed_display_transform',
        description: 'Swipe-away is rendered from canonical keep and is not stored or counted as a second estimator or outcome coordinate.',
    }));
    const aliasMap = Object.fromEntries(
        aliases.map(alias => [alias.id, alias.canonicalId])
    );
    const retired = (coordinateGovernance.compatibility.retired || []).map(
        definition => {
            const coordinateIdentity = {
                coordinateId: definition.id,
                family: 'retiredDiagnostic',
                status: 'retired',
                registry: 'quant-coordinate-governance',
                registryVersion:
                    coordinateGovernance.schemaVersion,
                registrySha256:
                    coordinateGovernanceFileSha256(),
                replacementCoordinateId:
                    definition.replacement || null,
            };
            return {
                ...definition,
                coordinateId: definition.id,
                family: 'retiredDiagnostic',
                status: 'retired',
                active: false,
                predictorEligible: false,
                predictor_eligible: false,
                coordinateIdentity,
                coordinateIdentitySha256:
                    sha256Json(coordinateIdentity),
            };
        }
    );
    const channelFree = CHANNEL_FREE_SIGNALS.map(signalKey => ({
        id: `shorts.channel-free.${signalKey}.keep`,
        family: 'channelFree',
        protocol: 'pooled_no_creator_information',
        group: signalKey === 'concat' ? 'combined' : signalKey,
        key: `cfs.${signalKey}`,
        target: 'keep',
        label: `Channel-free ${signalKey === 'concat' ? 'concat (selected)' : signalKey} · Keep rate`,
        unit: 'percent',
        storageUnit: 'blind_model_coordinate',
        sourceKey: `cfs.${signalKey}`,
        percentileAvailable: false,
        status: 'research_diagnostic',
        predictorEligible: false,
        validationStatus: 'research_only_retrospective_holdout',
        valueClass: 'direct_embedding_axis',
        lineageId: `lineage.shorts.channel-free.${signalKey}.keep`,
        lineage: {
            rawInputIds: signalKey === 'concat'
                ? [
                    'input.shorts.first5-montage.v1',
                    'input.shorts.first5-transcript.v1',
                    'input.shorts.first5-montage-transcript.v1',
                ]
                : groupInputIds(signalKey),
            representationId: signalKey === 'concat'
                ? 'representation.shorts.concat.gemini4608.v1'
                : groupRepresentationId(signalKey),
            fitDatasetId: 'dataset.shorts.channel-free-private-keep.v1',
            fitDataset: [{
                id: 'dataset.shorts.channel-free-private-keep.v1',
                role: 'Pooled 584-video private keep fit with zero creator information; the evaluated video is excluded by its OOF fold.',
            }],
            targetField: 'keep',
            algorithmId: 'algorithm.shorts.channel-free-pooled-ridge.v1',
            scalarProjection: 'Normalized embedding enters a pooled Ridge direction (alpha by inner training-fold MAE); the displayed value is the seed-mean out-of-fold prediction clipped to [0, 100].',
            calibrationId: 'calibration.identity-target-units.v1',
            artifactId: 'artifact.repo.shorts.channel-free-scores.v1',
            sourceCode: ['buildings/jarvis/predictor-lab/run_channel_free_signal.py'],
            usesEmbedding: true,
            validationProtocolId: 'family.shorts.channel-free.pooled-keep.v1',
            visualizationId: 'map.runtime.none.v1',
            runId: CHANNEL_FREE_RUN_ID,
            ledgerFinding: 'channelFreeKeepDirection',
            validatedSummary: CHANNEL_FREE_SUMMARY[signalKey] || null,
            reproducibility: { status: 'repo-committed-artifact', runner: 'predictor-lab/run_channel_free_signal.py' },
        },
        description: 'One pooled direction fitted with ZERO creator information (no offsets, '
            + 'per-account refits, or centering). The stored value is the per-video held-out '
            + 'OOF prediction — the model never saw this video. Rank transfers to unseen '
            + 'creators; absolute keep does not (deploy as percentile/rank).',
    }));
    const columns = [
        ...observed,
        ...stored,
        ...visualKeepForecast,
        ...visualKeepProtocolForecasts,
        ...creatorAdaptiveKeepPrequential,
        ...creatorExcludedPublic,
        ...direct,
        ...forecasts,
        ...channelFree,
    ];
    const familyMeta = [
        ['observed', 'Observed outcomes', 'Measured truth; never an embedding.'],
        ['stored', 'Stored production scores', 'The exact 21 score-card coordinates.'],
        ['visualKeepForecast', 'Frozen visual keep model score', 'One persisted score-time full-vector score from the existing visual embedding. Exact release and input provenance is required; full-fit training reconstructions remain outside the ledger.'],
        ['visualKeepProtocolForecast', 'Visual keep protocol predictions', 'Three protocol-specific research outputs. Each is already held out under its named protocol and is distinct from both the frozen production scalar and stored map coordinates.'],
        ['creatorAdaptiveKeepPrequential', 'Creator-adaptive historical prequential validation', 'One row-specific chronological replay from the existing visual and together embeddings plus only the creator history available before that historical row. It proves that future labels were excluded, not a causal effect, and is not the live future-upload shadow score.'],
        ['creatorExcludedPublic', 'Creator-excluded public axes', 'Nine unique retrospective public views, outlier, and over-10M axes shared by downstream validation protocols without duplicate ledger columns. Creator exclusion prevents direct account leakage but does not make the calibration prospective or confirmatory.'],
        ['videoHeldout', 'Video-held-out private scores', 'Six private keep/ret5 axes plus three realistic-views transforms rebuilt without the evaluated video.'],
        ['accountHeldout', 'Account-held-out private scores', 'Six private keep/ret5 axes plus three realistic-views transforms rebuilt without the evaluated account.'],
        ['videoForecast', 'Video-held-out combined forecasts', 'Twelve stored outcomes forecast from nine creator-excluded public axes; swipe is a display transform of keep.'],
        ['accountForecast', 'Account-held-out combined forecasts', 'Twelve stored account-transfer outcomes; swipe is a display transform of keep.'],
        ['channelFree', 'Channel-free keep signals', 'Four pooled directions (visual, text, together, concat) fitted with zero creator information; values are per-video held-out OOF predictions. Rank-first research diagnostics — ledger finding channelFreeKeepDirection.'],
    ].map(([key, label, description]) => ({
        key,
        label,
        description,
        count: columns.filter(column => column.family === key).length,
    }));
    const longQuantColumns = LONG_QUANT_GROUPS.flatMap(group => LONG_QUANT_METRICS.map(metric => ({
        id: coordinatePattern(
            coordinateGovernance.coordinates.longOutputPattern,
            { group, metricKey: metric.key }
        ),
        family: 'longStored',
        protocol: 'stored',
        group,
        key: `${group}.${metric.key}`,
        target: metric.target,
        label: `${
            group === 'together' ? 'Both'
                : group === 'text' ? 'Text'
                    : 'Visual'
        } · ${metric.label}`,
        unit: metric.unit,
        status: 'canonical',
        predictorEligible: false,
        validationStatus: 'not-held-out',
        valueClass: group === 'visual' && metric.key === 'ctrviews'
            ? 'direct_embedding_axis'
            : 'embedding_derived_transform',
        lineageId: `lineage.long.output.${group}.${metric.key}`,
        lineage: longLineage(group, metric),
        description: 'Canonical nullable Long Quant scalar output. A missing estimate remains missing; a 2D map marker is stored and displayed under its separate map-placement address.',
    })));
    const longMapPlacements = LONG_QUANT_GROUPS.flatMap(group => (
        (contract.crossDomainInventory.longQuant.mapProjections || []).map(
            projectionKey => ({
                id: coordinatePattern(
                    coordinateGovernance.coordinates.longMapPlacementPattern,
                    { group, projectionKey }
                ),
                group,
                projectionKey,
                mapId: `map.long.${projectionKey}.v1`,
                valueClass: 'map_placement',
                predictorEligible: false,
                validationStatus: 'not-held-out',
                description: 'Query marker on a registered two-dimensional Long map. It is visualization geometry, not a scalar outcome estimate.',
            })
        )
    ));
    for (const column of [...columns, ...longQuantColumns]) {
        column.lineage = canonicalizeLineage(column.lineage);
        column.coordinateIdentity = buildCoordinateIdentity(column, lineageCatalog);
    }
    const lineageAudit = buildLineageAudit(columns, longQuantColumns, lineageCatalog);
    const duplicateLongCoordinateIds = [...new Set(
        longQuantColumns
            .map(column => column.id)
            .filter((id, index, ids) => ids.indexOf(id) !== index)
    )];
    const duplicateLongMapPlacementIds = [...new Set(
        longMapPlacements
            .map(placement => placement.id)
            .filter((id, index, ids) => ids.indexOf(id) !== index)
    )];
    const activeAxisGroups = new Map();
    for (const column of columns) {
        const fingerprint = column.coordinateIdentity.axisFingerprint;
        if (!activeAxisGroups.has(fingerprint)) {
            activeAxisGroups.set(fingerprint, []);
        }
        activeAxisGroups.get(fingerprint).push(column.id);
    }
    const duplicateActiveAxes = [...activeAxisGroups.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([axisFingerprint, ids]) => ({ axisFingerprint, ids }));
    const activeIds = new Set(columns.map(column => column.id));
    const aliasErrors = aliases.flatMap(alias => {
        const errors = [];
        if (activeIds.has(alias.id)) {
            errors.push(`${alias.id}:alias-is-active`);
        }
        if (!activeIds.has(alias.canonicalId)) {
            errors.push(`${alias.id}:missing-canonical:${alias.canonicalId}`);
        }
        return errors;
    });
    const displayTransformIds = new Set();
    const displayTransformErrors = displayTransforms.flatMap(transform => {
        const errors = [];
        if (
            !transform.id
            || displayTransformIds.has(transform.id)
        ) {
            errors.push(`${transform.id || 'missing-id'}:duplicate-transform`);
        }
        displayTransformIds.add(transform.id);
        if (activeIds.has(transform.id)) {
            errors.push(`${transform.id}:display-transform-is-stored`);
        }
        if (!activeIds.has(transform.sourceCoordinateId)) {
            errors.push(
                `${transform.id}:missing-source:${transform.sourceCoordinateId}`
            );
        }
        if (
            transform.formula !== '100 - source'
            || transform.stored !== false
            || transform.predictorEligible !== false
        ) {
            errors.push(`${transform.id}:display-transform-contract-differs`);
        }
        return errors;
    });
    lineageAudit.duplicateActiveAxes = duplicateActiveAxes;
    lineageAudit.aliasErrors = aliasErrors;
    lineageAudit.displayTransformErrors = displayTransformErrors;
    lineageAudit.duplicateLongCoordinateIds = duplicateLongCoordinateIds;
    lineageAudit.duplicateLongMapPlacementIds = duplicateLongMapPlacementIds;
    lineageAudit.passed = lineageAudit.passed
        && duplicateActiveAxes.length === 0
        && aliasErrors.length === 0
        && displayTransformErrors.length === 0
        && duplicateLongCoordinateIds.length === 0
        && duplicateLongMapPlacementIds.length === 0;
    lineageAudit.structuralPassed = lineageAudit.structuralPassed
        && duplicateActiveAxes.length === 0
        && aliasErrors.length === 0
        && displayTransformErrors.length === 0
        && duplicateLongCoordinateIds.length === 0
        && duplicateLongMapPlacementIds.length === 0;
    lineageAudit.rule += ' Active columns must also have unique axis fingerprints, every compatibility alias must resolve to exactly one active canonical coordinate, and every non-stored display transform must resolve to an active source without entering the ledger.';
    const valueClassCounts = columns.reduce((counts, column) => {
        counts[column.valueClass] = (counts[column.valueClass] || 0) + 1;
        return counts;
    }, {});
    const directAxisColumns = columns.filter(column => column.valueClass === 'direct_embedding_axis');
    const distinctDirectAxisCount = new Set(
        directAxisColumns.map(column => column.coordinateIdentity.axisFingerprint),
    ).size;
    const blindColumns = columns.filter(coordinatePredictorRankingEligible);
    const blindUniquePredictionCount = new Set(
        blindColumns.map(column => column.coordinateIdentity.axisFingerprint),
    ).size;
    const diagnosticColumns = columns.filter(column => (
        column.family === 'stored'
        || column.family === 'visualKeepForecast'
        || column.family === 'visualKeepProtocolForecast'
        || column.predictorEligible === false
    ));
    const outcomeColumns = columns.filter(column => column.family === 'observed');
    return {
        version: LEDGER_VERSION,
        contractVersion: contract.version,
        governanceVersion: coordinateGovernance.schemaVersion,
        governanceSha256: coordinateGovernanceFileSha256(),
        rules: [
            ...coordinateGovernance.rules,
            'A relationship graph pairs one score-coordinate ID with one observed-outcome ID; it never creates a new score.',
            'Stored production, held-out reconstruction, combined forecast, and observed truth are different families and may not substitute for one another.',
            'Percentiles belong to their coordinate cell; they are not new estimates.',
            'Re-scoring parity is defined by identical input fingerprint plus scorer, model, and artifact revisions.',
            `Promotion fails closed unless at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} independently evaluated creator accounts contribute at least ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} rows each and immutable result/preregistration bytes reproduce their hashes while locking model, protocol, outcome, and evaluation-population hashes.`,
            'Stayed-to-watch and swipe-away are one feed-decision outcome family. Swipe remains visible as an algebraic complement but cannot cast a second model-selection vote.',
            `The ${columns.length} active Shorts row columns are not ${columns.length} embedding spaces: ${directAxisColumns.length} are unique direct fitted axes; the frozen visual and creator-adaptive forecasts reuse existing embeddings, and transforms, forecasts, observations, and diagnostics are counted separately.`,
        ],
        columns,
        displayTransforms,
        aliases,
        aliasMap,
        retired,
        compatibility: {
            aliases,
            retired,
            activeColumnsContainAliases: false,
            activeColumnsContainRetired: false,
        },
        families: familyMeta,
        classification: {
            blind: {
                columns: blindColumns.length,
                uniquePredictions: blindUniquePredictionCount,
                aliasColumns: blindColumns.length - blindUniquePredictionCount,
                families: [...new Set(blindColumns.map(column => column.family))],
                meaning: 'Coordinates currently eligible for leakage-controlled predictor ranking. Every active blind column is one unique scalar prediction; compatibility aliases are outside the active ledger.',
            },
            diagnostics: {
                columns: diagnosticColumns.length,
                families: [...new Set(diagnosticColumns.map(column => column.family))],
                meaning: 'Stored production outputs, provenance-bound score-time forecasts, and research-only candidates. Full-fit training reconstructions and retired historical diagnostics remain outside active ledger columns.',
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
            shortsCompatibilityAliases: aliases.length,
            shortsRetiredCoordinates: retired.length,
            shortsLegacyDiagnostics: 0,
            shortsStoredProduction: stored.length,
            shortsVisualKeepForecasts: visualKeepForecast.length,
            shortsVisualKeepProtocolForecasts: visualKeepProtocolForecasts.length,
            shortsCreatorAdaptiveKeepPrequential:
                creatorAdaptiveKeepPrequential.length,
            shortsCreatorExcludedPublic: creatorExcludedPublic.length,
            shortsDirectHeldout: direct.length,
            shortsCombinedForecasts:
                valueClassCounts.combined_forecast || 0,
            shortsHeldoutCombinedForecasts: forecasts.length,
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
            shortsLegacyColumns: 0,
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
            groups: LONG_QUANT_GROUPS.slice(),
            metrics: LONG_QUANT_METRICS.map(metric => ({ ...metric })),
            mapPlacements: longMapPlacements,
            mapProjections: contract.crossDomainInventory.longQuant.mapProjections.slice(),
            validationStatus: 'not-held-out',
            note: 'All 21 nullable scalar addresses are distinct from the 36 map-placement addresses. Long scalar and map diagnostics are not predictive evidence until a registered held-out Long study exists.',
        },
        shortsMapProjections,
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

function creatorContentFamilyInference(points, binary) {
    const families = new Map();
    for (const point of points || []) {
        if (!finite(point.actual) || !finite(point.predicted)) continue;
        const accountId = String(point.accountId || 'unknown');
        const familyId = String(
            point.contentFamilyEvidence
                && point.contentFamilyEvidence.familyId
            || point.contentFamilyId
            || validationContentFamilyId(point)
        );
        const key = `${accountId}\u0000${familyId}`;
        if (!families.has(key)) {
            families.set(key, {
                accountId,
                familyId,
                actual: [],
                predicted: [],
            });
        }
        families.get(key).actual.push(Number(point.actual));
        families.get(key).predicted.push(Number(point.predicted));
    }
    const collapsed = [...families.values()].map(group => ({
        accountId: group.accountId,
        familyId: group.familyId,
        actual: average(group.actual),
        predicted: average(group.predicted),
    }));
    const byAccount = new Map();
    for (const point of collapsed) {
        if (!byAccount.has(point.accountId)) byAccount.set(point.accountId, []);
        byAccount.get(point.accountId).push(point);
    }
    const creatorEffects = [];
    for (const [accountId, accountPoints] of byAccount) {
        let effect = null;
        if (binary) {
            effect = rocAuc(
                accountPoints.map(point => point.actual >= 0.5 ? 1 : 0),
                accountPoints.map(point => point.predicted)
            );
            if (finite(effect)) effect = Number(effect) - 0.5;
        } else if (accountPoints.length >= 3) {
            effect = spearman(
                accountPoints.map(point => point.actual),
                accountPoints.map(point => point.predicted)
            );
        }
        if (finite(effect)) {
            creatorEffects.push({
                accountId,
                effect: Number(effect),
                contentFamilies: accountPoints.length,
            });
        }
    }
    const creatorCount = creatorEffects.length;
    const centeredEffect = creatorCount
        ? average(creatorEffects.map(item => item.effect))
        : null;
    const reportedEffect = binary && finite(centeredEffect)
        ? Number(centeredEffect) + 0.5
        : centeredEffect;
    let p = null;
    if (creatorCount >= 3 && creatorCount <= 18) {
        const observed = Math.abs(Number(centeredEffect));
        const permutations = 2 ** creatorCount;
        let atLeastAsExtreme = 0;
        for (let mask = 0; mask < permutations; mask++) {
            const candidate = average(creatorEffects.map((item, index) => (
                item.effect * ((mask >> index) & 1 ? 1 : -1)
            )));
            if (Math.abs(candidate) >= observed - 1e-12) {
                atLeastAsExtreme++;
            }
        }
        p = atLeastAsExtreme / permutations;
    }
    return {
        effect: finite(reportedEffect) ? Number(reportedEffect) : null,
        p: finite(p) ? round(p, 8) : null,
        creatorCount,
        contentFamilyCount: collapsed.length,
        creatorEffects,
        uncertaintyUnit: 'creator_account',
        familyUnit: 'content_family',
        method: creatorCount >= 3
            ? 'exact-creator-sign-flip-after-content-family-collapse'
            : 'descriptive-only-insufficient-creators',
    };
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

function creatorExcludedPublicFeatureValue(row, featureName) {
    const video = blindFeatureValue(row, featureName, 'video');
    return finite(video) ? Number(video) : null;
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
    const value = protocol === 'creator_excluded'
        ? creatorExcludedPublicFeatureValue(row, `${definition.key}.raw`)
        : blindFeatureValue(row, `${definition.key}.raw`, protocol);
    if (!finite(value)) return null;
    return ['views', 'realviews', 'outlier'].includes(definition.target)
        ? Math.max(0, 10 ** Number(value) - 1)
        : Number(value);
}

function ledgerValue(row, column) {
    if (column.family === 'observed') {
        const definition = OUTCOME_DEFINITIONS.find(outcome => outcome.key === column.key);
        return definition ? number(definition.accessor(row)) : null;
    }
    if (column.family === 'stored') {
        return featureDisplayValue(row, contract.features.find(feature => feature.key === column.key), 'stored');
    }
    if (column.family === 'visualKeepForecast') {
        return number(row.predictions && row.predictions.visualKeepForecast);
    }
    if (column.family === 'visualKeepProtocolForecast') {
        return number(
            row.predictions
            && row.predictions.visualKeepProtocols
            && row.predictions.visualKeepProtocols[column.protocolKey]
            && row.predictions.visualKeepProtocols[column.protocolKey].predicted
        );
    }
    if (column.family === 'creatorAdaptiveKeepPrequential') {
        return number(
            row.predictions
            && row.predictions.creatorAdaptiveKeepPrequential
        );
    }
    if (column.family === 'creatorExcludedPublic') {
        const definition = contract.features.find(
            feature => feature.key === column.key
        );
        return featureDisplayValue(row, definition, 'creator_excluded');
    }
    if (column.family === 'videoHeldout' || column.family === 'accountHeldout') {
        const definition = contract.features.find(feature => feature.key === column.key);
        return featureDisplayValue(row, definition, column.family === 'videoHeldout' ? 'video' : 'account');
    }
    if (column.family === 'channelFree') {
        const scored = CHANNEL_FREE_BY_ID.get(String(row.id));
        const signalKey = String(column.key || '').replace(/^cfs\./, '');
        return scored ? number(scored[signalKey]) : null;
    }
    if (column.family === 'videoForecast' || column.family === 'accountForecast') {
        const protocol = column.family === 'videoForecast' ? 'video' : 'account';
        return number(row.predictions && row.predictions.score21 && row.predictions.score21[protocol]
            && row.predictions.score21[protocol][column.key]);
    }
    return null;
}

function ledgerBaselineValue(row, column) {
    if (column.family === 'videoForecast' || column.family === 'accountForecast') {
        const protocol = column.family === 'videoForecast' ? 'video' : 'account';
        return number(forecastBaseline(row, protocol, column.key));
    }
    if (column.family === 'visualKeepProtocolForecast') {
        return number(
            row.predictions
            && row.predictions.visualKeepProtocols
            && row.predictions.visualKeepProtocols[column.protocolKey]
            && row.predictions.visualKeepProtocols[column.protocolKey].baseline
        );
    }
    if (column.family === 'creatorAdaptiveKeepPrequential') {
        return number(
            row.predictions
            && row.predictions.creatorAdaptiveKeepBaseline
        );
    }
    return null;
}

function ledgerPercentile(row, column) {
    if (column.family !== 'stored') return null;
    const index = contract.features.findIndex(feature => feature.key === column.key);
    return index >= 0 ? number(row.storedPercentile[index]) : null;
}

function attachCoordinateLedger(
    rows,
    registry,
    visualKeepStudy = null,
    creatorAdaptiveStudy = null
) {
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
    const ignoredSharedPublicCompatibilityMismatches = [];
    const sharedPublicColumns = registry.columns.filter(
        column => column.family === 'creatorExcludedPublic'
    );
    for (const row of rows) {
        for (const column of sharedPublicColumns) {
            const featureName = `${column.key}.raw`;
            const video = blindFeatureValue(row, featureName, 'video');
            const account = blindFeatureValue(row, featureName, 'account');
            if (!finite(video) || !finite(account)) continue;
            const tolerance = Math.max(
                1e-10,
                Math.max(
                    Math.abs(Number(video)),
                    Math.abs(Number(account))
                ) * 1e-10
            );
            if (Math.abs(Number(video) - Number(account)) > tolerance) {
                ignoredSharedPublicCompatibilityMismatches.push(
                    `${row.id}:${column.key}:value`
                );
            }
        }
    }
    const visualKeepProtocolParityMismatches = [];
    const rowsById = new Map(rows.map(row => [String(row.id), row]));
    for (const [protocolKey, definition] of Object.entries(
        VISUAL_KEEP_PROTOCOL_COORDINATES
    )) {
        const ledgerIndex = registry.columns.findIndex(
            column => column.id === definition.id
        );
        const protocolPoints = pointMap(
            visualKeepStudy
            && visualKeepStudy.protocols
            && visualKeepStudy.protocols[protocolKey]
            && visualKeepStudy.protocols[protocolKey].points
        );
        for (const [id, expected] of protocolPoints) {
            const row = rowsById.get(id);
            if (!row) continue;
            const actual = ledgerIndex >= 0
                && row.scoreLedger
                && row.scoreLedger.values
                && row.scoreLedger.values[ledgerIndex];
            if (!finite(expected.predicted)
                || !finite(actual)
                || Math.abs(Number(expected.predicted) - Number(actual)) > 1e-6) {
                visualKeepProtocolParityMismatches.push(
                    `${id}:${protocolKey}:prediction`
                );
            }
        }
        for (const row of rows) {
            if (protocolPoints.has(String(row.id))) continue;
            const actual = ledgerIndex >= 0
                && row.scoreLedger
                && row.scoreLedger.values
                && row.scoreLedger.values[ledgerIndex];
            if (finite(actual)) {
                visualKeepProtocolParityMismatches.push(
                    `${row.id}:${protocolKey}:outside-protocol`
                );
            }
        }
    }
    const creatorAdaptiveParityMismatches = [];
    const creatorCoordinateIndex = registry.columns.findIndex(
        column => (
            column.id
            === CREATOR_ADAPTIVE_KEEP_PREQUENTIAL_COORDINATE_ID
        )
    );
    const creatorArtifactSha256 = creatorAdaptiveStudy
        && creatorAdaptiveStudy.modelArtifact
        && creatorAdaptiveStudy.modelArtifact.artifactSha256
        || null;
    const creatorMinimumHistory = number(
        creatorAdaptiveStudy
        && creatorAdaptiveStudy.formula
        && creatorAdaptiveStudy.formula.minimumHistoryN
    );
    const creatorPoints = pointMap(
        creatorAdaptiveStudy
        && creatorAdaptiveStudy.evaluation
        && creatorAdaptiveStudy.evaluation.points
    );
    for (const [id, expected] of creatorPoints) {
        const row = rowsById.get(id);
        if (!row) {
            creatorAdaptiveParityMismatches.push(`${id}:missing-ledger-row`);
            continue;
        }
        const predicted = row.predictions || {};
        const actual = creatorCoordinateIndex >= 0
            && row.scoreLedger
            && row.scoreLedger.values
            && row.scoreLedger.values[creatorCoordinateIndex];
        if (!finite(expected.predicted)
            || !finite(actual)
            || Math.abs(Number(expected.predicted) - Number(actual)) > 1e-6) {
            creatorAdaptiveParityMismatches.push(`${id}:prediction`);
        }
        if (String(expected.account || '') !== String(row.accountId || '')) {
            creatorAdaptiveParityMismatches.push(`${id}:account`);
        }
        if (!finite(expected.baseline)
            || !finite(predicted.creatorAdaptiveKeepBaseline)
            || Math.abs(
                Number(expected.baseline)
                - Number(predicted.creatorAdaptiveKeepBaseline)
            ) > 1e-6) {
            creatorAdaptiveParityMismatches.push(`${id}:baseline`);
        }
        if (number(expected.historyN) !== number(predicted.creatorAdaptiveKeepHistoryN)
            || (finite(creatorMinimumHistory)
                && Number(expected.historyN) < Number(creatorMinimumHistory))) {
            creatorAdaptiveParityMismatches.push(`${id}:history`);
        }
        if (number(expected.historyEnd) !== number(predicted.creatorAdaptiveKeepHistoryEnd)) {
            creatorAdaptiveParityMismatches.push(`${id}:history-cutoff`);
        }
        if (number(expected.componentA)
            !== number(predicted.creatorAdaptiveKeepComponentA)) {
            creatorAdaptiveParityMismatches.push(`${id}:component-a`);
        }
        if (number(expected.componentB)
            !== number(predicted.creatorAdaptiveKeepComponentB)) {
            creatorAdaptiveParityMismatches.push(`${id}:component-b`);
        }
        if (sha256Json(
            (expected.historyVideoIds || []).map(String)
        ) !== sha256Json(
            (predicted.creatorAdaptiveKeepHistoryVideoIds || []).map(String)
        )) {
            creatorAdaptiveParityMismatches.push(`${id}:history-video-ids`);
        }
        if (creatorArtifactSha256
            && predicted.creatorAdaptiveKeepArtifactSha256 !== creatorArtifactSha256) {
            creatorAdaptiveParityMismatches.push(`${id}:artifact-revision`);
        }
    }
    for (const row of rows) {
        if (creatorPoints.has(String(row.id))) continue;
        const actual = creatorCoordinateIndex >= 0
            && row.scoreLedger
            && row.scoreLedger.values
            && row.scoreLedger.values[creatorCoordinateIndex];
        if (finite(actual)) {
            creatorAdaptiveParityMismatches.push(`${row.id}:outside-evaluation`);
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
            && visualKeepProtocolParityMismatches.length === 0
            && creatorAdaptiveParityMismatches.length === 0
            && (!registry.lineageAudit || registry.lineageAudit.passed),
        registryVersion: registry.version,
        columns: registry.columns.length,
        rows: rows.length,
        duplicateIds,
        rowLengthMismatches,
        storedParityMismatches: storedParityMismatches.slice(0, 50),
        creatorExcludedPublicCanonicalSource:
            coordinateGovernance.expansions
                .creatorExcludedPublicCanonicalSource,
        ignoredSharedPublicCompatibilityMismatches:
            ignoredSharedPublicCompatibilityMismatches.slice(0, 50),
        visualKeepProtocolParityMismatches:
            visualKeepProtocolParityMismatches.slice(0, 50),
        creatorAdaptiveParityMismatches: creatorAdaptiveParityMismatches.slice(0, 50),
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
    'withinAccountAuc',
    'inferentialEffect',
    'inferentialPValue',
    'inferentialEstimand',
    'inferentialN',
    'inferentialCreatorCount',
    'inferentialMethod',
    'predictionR2',
    'predictionSpearman',
    'predictionMae',
    'predictionBaselineMae',
    'predictionMaeImprovementVsBaseline',
    'predictionProtocolBaselineR2',
    'predictionMedianFactorError',
    'predictionAuc',
    'predictionBrier',
    'n',
    'predictionN',
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

function coordinateModelBaseline(row, column) {
    const value = ledgerBaselineValue(row, column);
    if (!finite(value)) return null;
    if (column.unit === 'views'
        || column.target === 'views'
        || column.target === 'realviews'
        || column.target === 'outlier') {
        return Math.log10(Math.max(0, Number(value)) + 1);
    }
    return Number(value);
}

function nativeOutcomeKey(column) {
    if (!column || column.valueClass === 'observed_outcome') return null;
    if ((column.family === 'videoForecast' || column.family === 'accountForecast')
        && OUTCOME_DEFINITIONS.some(outcome => outcome.key === column.key)) {
        return column.key;
    }
    if (column.target === 'keep') return 'keep';
    if (column.target === 'ret5') return 'ret5';
    if (column.target === 'averageRetention') return 'averageRetention';
    if (column.target === 'views' || column.target === 'realviews') return 'views';
    if (column.target === 'outlier') return 'outlier';
    if (column.target === 'gt10M' || column.target === 'hit10M') return 'hit10M';
    if (/^(survival|drop)(5|10|20)$/.test(String(column.target || ''))) {
        return column.target;
    }
    return null;
}

function coordinateEvaluationMode(column, outcome) {
    if (!column || column.valueClass === 'observed_outcome') {
        return 'outcome_not_predictor';
    }
    if (!outcome || nativeOutcomeKey(column) !== outcome.key) {
        return 'association_only';
    }
    if (column.family === 'visualKeepProtocolForecast') {
        return 'registered_heldout_identity';
    }
    if (column.family === 'creatorAdaptiveKeepPrequential') {
        return 'registered_prequential_identity';
    }
    if (column.family === 'creatorExcludedPublic') {
        return 'creator_excluded_identity';
    }
    if (column.family === 'visualKeepForecast') {
        return 'persisted_score_time_identity';
    }
    if (column.family === 'videoHeldout'
        || column.family === 'videoForecast') {
        return 'registered_video_heldout_identity';
    }
    if (column.family === 'accountHeldout'
        || column.family === 'accountForecast') {
        return 'registered_account_heldout_identity';
    }
    return 'diagnostic_identity';
}

function coordinateValidationTier(column, outcome) {
    if (!column || column.valueClass === 'observed_outcome') return 'outcome_not_predictor';
    const mode = coordinateEvaluationMode(column, outcome);
    if (mode === 'association_only') return 'cross_outcome_association_only';
    if (column.family === 'creatorExcludedPublic') return 'creator_excluded_public_axis_identity';
    if (column.family === 'accountHeldout') return 'account_held_out_coordinate_identity';
    if (column.family === 'accountForecast') return 'account_held_out_forecast_identity';
    if (column.family === 'videoHeldout') return 'video_held_out_coordinate_identity';
    if (column.family === 'videoForecast') return 'video_held_out_forecast_identity';
    if (column.family === 'stored') return 'stored_coordinate_diagnostic_identity';
    if (column.family === 'visualKeepForecast') return 'persisted_score_time_forecast_identity';
    if (column.family === 'visualKeepProtocolForecast') return `identity_${column.protocol}`;
    if (column.family === 'creatorAdaptiveKeepPrequential') {
        return 'creator_prequential_historical_identity';
    }
    if (column.family === 'channelFree') {
        return 'channel_free_pooled_no_creator_identity';
    }
    return 'diagnostic_identity';
}

function coordinatePlainEnglish(column, outcome) {
    if (column.valueClass === 'observed_outcome') {
        return `${column.label} is measured truth, not a candidate predictor. It is present so every score-ledger column remains auditable, but it is excluded from ranking and calibration against ${outcome.label}.`;
    }
    const mode = coordinateEvaluationMode(column, outcome);
    const protocol = mode === 'association_only'
        ? `This coordinate is not a registered numerical prediction of ${outcome.label}; this cell reports association only and cannot manufacture a second estimator.`
        : 'The prediction chart evaluates this exact ledger scalar in its registered target units. No chart-specific fit, rescaling, or second calibration is permitted.';
    const upstream = column.family === 'stored'
        ? 'This is the exact production value stored with the scored video. Neither the stored value nor its historical rank-to-outcome calibration is treated as held-out evidence here; the upstream axis or calibration may include the scored account or video.'
        : (column.family === 'visualKeepForecast'
            ? 'This is the exact raw percentage persisted at score time by the active pooled-global frozen visual model. The row is present only when its release manifest, artifact, input fingerprints, score-record binding, null account model, and [0,100] output contract validate. Full-fit training reconstructions are excluded; only the separately displayed protocol predictions are held-out evidence.'
            : (column.family === 'visualKeepProtocolForecast'
                ? 'This is one exact research prediction from the named visual-only holdout protocol. It is not the frozen production value and it is not a stored visual keep map estimate.'
            : (column.family === 'creatorAdaptiveKeepPrequential'
                ? 'This is the exact row-specific historical prequential percentage produced from visual and together embeddings plus only labels available before that historical row. It is distinct from the live future-upload creator-profile score.'
                : (column.family === 'creatorExcludedPublic'
                    ? `${column.description} Creator exclusion makes this a retrospective account-external diagnostic, not prospective confirmation.`
                    : column.description))));
    return `${upstream} ${protocol}`;
}

function identityCoordinateEvaluation(points, outcome, mode) {
    const predictions = (points || []).filter(point => (
        point && point.id && point.accountId
        && finite(point.actual) && finite(point.predicted)
    )).map(point => ({
        id: String(point.id),
        accountId: String(point.accountId),
        actual: Number(point.actual),
        predicted: Number(point.predicted),
        baseline: finite(point.baseline) ? Number(point.baseline) : null,
    }));
    return {
        mode,
        valueSource: 'scoreLedger.values[coordinateRegistry.index]',
        transform: outcome.transform || 'identity',
        identity: true,
        fittedByRelationshipChart: false,
        eligibleN: predictions.length,
        predictions,
        audit: {
            mode,
            fittedParameterCount: 0,
            trainingRowsReadByChart: 0,
            trainingOutcomesReadByChart: 0,
            predictedN: predictions.length,
            rule: 'Evaluate the exact registered ledger value in its native target units. The relationship chart is forbidden from fitting or rescaling it.',
        },
    };
}

function identityCoordinateDiagnostics(evaluation, outcome) {
    if (!evaluation || !evaluation.predictions.length) return null;
    const points = evaluation.predictions;
    const regression = regressionMetrics(points, {
        total: evaluation.eligibleN,
        logScale: !!outcome.transform,
    });
    const actualRange = finite(regression.actualMin) && finite(regression.actualMax)
        ? Number(regression.actualMax) - Number(regression.actualMin)
        : null;
    const predictedRange = finite(regression.predictedMin) && finite(regression.predictedMax)
        ? Number(regression.predictedMax) - Number(regression.predictedMin)
        : null;
    const perAccount = [...new Set(points.map(point => point.accountId))].sort().map(accountId => {
        const account = regressionMetrics(
            points.filter(point => point.accountId === accountId),
            { logScale: !!outcome.transform }
        );
        const accountActualRange = finite(account.actualMin) && finite(account.actualMax)
            ? Number(account.actualMax) - Number(account.actualMin)
            : null;
        const accountPredictedRange = finite(account.predictedMin) && finite(account.predictedMax)
            ? Number(account.predictedMax) - Number(account.predictedMin)
            : null;
        return {
            accountId,
            n: account.n || 0,
            r2: number(account.r2),
            protocolBaselineR2: number(account.protocolBaselineR2),
            spearman: number(account.spearman),
            mae: number(account.mae),
            baselineMae: number(account.baselineMae),
            maeImprovementVsBaseline: number(
                account.maeImprovementVsBaseline
            ),
            actualMin: number(account.actualMin),
            actualMax: number(account.actualMax),
            predictedMin: number(account.predictedMin),
            predictedMax: number(account.predictedMax),
            actualRange: round(accountActualRange),
            predictedRange: round(accountPredictedRange),
            rangeRatio: accountActualRange > 0
                ? round(accountPredictedRange / accountActualRange)
                : null,
        };
    });
    return {
        scale: outcome.transform || 'identity',
        n: regression.n || 0,
        actualMin: number(regression.actualMin),
        actualMax: number(regression.actualMax),
        predictedMin: number(regression.predictedMin),
        predictedMax: number(regression.predictedMax),
        actualRange: round(actualRange),
        predictedRange: round(predictedRange),
        rangeRatio: actualRange > 0 ? round(predictedRange / actualRange) : null,
        calibrationSlope: number(regression.calibrationSlope),
        calibrationIntercept: number(regression.calibrationIntercept),
        bias: number(regression.bias),
        rmse: number(regression.rmse),
        baselineMae: number(regression.baselineMae),
        maeImprovementVsBaseline: number(
            regression.maeImprovementVsBaseline
        ),
        protocolBaselineR2: number(regression.protocolBaselineR2),
        perAccount,
        independentAccountCount: perAccount.length,
        uncertaintyUnit: 'creator_account',
        uncertaintyNote: 'Rows quantify video-level error; content families are collapsed within creator and creator accounts are the independent replication unit. Exact creator sign-flip p-values require at least three creators; no creator-clustered confidence interval is claimed.',
    };
}

function rawCoordinateAssociation(points, outcome, scopeKey) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted))
        .map(point => ({
            id: point.id,
            accountId: point.accountId,
            contentFamilyId: point.contentFamilyId,
            contentFamilyEvidence: point.contentFamilyEvidence,
            title: point.title,
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
    const pooled = scopeKey === 'pooled';
    const blocked = creatorContentFamilyInference(
        observed,
        outcome.unit === 'binary'
    );
    const inferentialEffect = number(blocked.effect);
    return {
        n: observed.length,
        spearman: round(rawSpearman),
        withinAccountSpearman: round(within),
        auc: round(rawAuc),
        withinAccountAuc: pooled && outcome.unit === 'binary'
            ? round(blocked.effect)
            : null,
        inferentialEffect: round(inferentialEffect),
        inferentialPValue: blocked.p,
        inferentialEstimand: outcome.unit === 'binary'
            ? 'creator_macro_content_family_auc'
            : 'creator_macro_content_family_spearman',
        inferentialN: blocked.contentFamilyCount,
        inferentialCreatorCount: blocked.creatorCount,
        inferentialMethod: blocked.method,
    };
}

function predictionCoordinateMetrics(evaluation, outcome) {
    if (!evaluation || !evaluation.predictions.length) {
        return {
            predictionR2: null,
            predictionSpearman: null,
            predictionMae: null,
            predictionBaselineMae: null,
            predictionMaeImprovementVsBaseline: null,
            predictionProtocolBaselineR2: null,
            predictionMedianFactorError: null,
            predictionAuc: null,
            predictionBrier: null,
            predictionN: 0,
        };
    }
    if (outcome.unit === 'binary') {
        const binary = binaryMetrics(evaluation.predictions.map(point => ({
            actual: point.actual,
            predicted: point.predicted,
        })), evaluation.eligibleN);
        return {
            predictionR2: null,
            predictionSpearman: null,
            predictionMae: null,
            predictionBaselineMae: null,
            predictionMaeImprovementVsBaseline: null,
            predictionProtocolBaselineR2: null,
            predictionMedianFactorError: null,
            predictionAuc: number(binary.auc),
            predictionBrier: number(binary.brier),
            predictionN: binary.n || 0,
        };
    }
    const transformedOutcome = !!outcome.transform;
    const regression = regressionMetrics(evaluation.predictions.map(point => ({
        id: point.id,
        accountId: point.accountId,
        actual: point.actual,
        predicted: point.predicted,
        baseline: point.baseline,
    })), {
        total: evaluation.eligibleN,
        logScale: transformedOutcome,
    });
    return {
        predictionR2: number(regression.r2),
        predictionSpearman: number(regression.spearman),
        predictionMae: transformedOutcome ? null : number(regression.mae),
        predictionBaselineMae: transformedOutcome
            ? null
            : number(regression.baselineMae),
        predictionMaeImprovementVsBaseline: transformedOutcome
            ? null
            : number(regression.maeImprovementVsBaseline),
        predictionProtocolBaselineR2: number(regression.protocolBaselineR2),
        predictionMedianFactorError: transformedOutcome
            ? number(regression.medianFactorError)
            : null,
        predictionAuc: null,
        predictionBrier: null,
        predictionN: regression.n || 0,
    };
}

function ledgerEvidence(metrics, column, inference) {
    if (column.valueClass === 'observed_outcome') return 'outcome_not_predictor';
    if (inference && inference.selectionDuplicateOf) {
        return 'algebraic_duplicate_display_only';
    }
    if (!metrics || metrics.n < 20 || metrics.predictionN < 20) {
        return 'insufficient_evidence';
    }
    const diagnosticOnly = column.family === 'stored'
        || column.family === 'visualKeepForecast'
        || column.family === 'visualKeepProtocolForecast'
        || column.predictorEligible === false;
    const confirmatory = !!(
        inference
        && inference.confirmatoryEligible === true
        && inference.creatorDiversityPassed === true
        && inference.prospectiveConfirmed === true
        && inference.creatorClusteredIntervalAvailable === true
    );
    if (finite(metrics.predictionAuc)) {
        if (finite(metrics.qValue)
            && metrics.qValue <= 0.05
            && finite(metrics.inferentialEffect)
            && metrics.inferentialEffect >= 0.65) {
            if (diagnosticOnly) return 'strong_diagnostic_signal_not_blind';
            return confirmatory
                ? 'strong_blind_signal'
                : 'exploratory_signal_needs_more_creators';
        }
        if (finite(metrics.inferentialEffect)
            && metrics.inferentialEffect >= 0.6) {
            if (diagnosticOnly) return 'directional_diagnostic_signal_not_blind';
            return confirmatory
                ? 'directional_blind_signal'
                : 'exploratory_signal_needs_more_creators';
        }
        return 'not_predictive';
    }
    const rank = Math.abs(number(metrics.inferentialEffect) || 0);
    if (finite(metrics.qValue)
        && metrics.qValue <= 0.05
        && rank >= 0.3) {
        if (diagnosticOnly) return 'strong_diagnostic_signal_not_blind';
        return confirmatory
            ? 'strong_blind_signal'
            : 'exploratory_signal_needs_more_creators';
    }
    if (rank >= 0.2) {
        if (diagnosticOnly) return 'directional_diagnostic_signal_not_blind';
        return confirmatory
            ? 'directional_blind_signal'
            : 'exploratory_signal_needs_more_creators';
    }
    return 'not_predictive';
}

function adjustLedgerQValues(entries) {
    const groups = new Map();
    entries.filter(entry => finite(entry._pValue)).forEach((entry, index) => {
        const hypothesisId = entry._hypothesisId || `unregistered:${index}`;
        if (!groups.has(hypothesisId)) {
            groups.set(hypothesisId, {
                id: hypothesisId,
                pValue: Number(entry._pValue),
                entries: [],
            });
        }
        const group = groups.get(hypothesisId);
        group.pValue = Math.max(group.pValue, Number(entry._pValue));
        group.entries.push(entry);
    });
    const eligible = [...groups.values()]
        .sort((left, right) => left.pValue - right.pValue);
    let running = 1;
    for (let index = eligible.length - 1; index >= 0; index--) {
        running = Math.min(
            running,
            eligible[index].pValue * eligible.length / (index + 1)
        );
        for (const entry of eligible[index].entries) {
            entry.metrics.qValue = round(running, 8);
        }
    }
    entries.forEach(entry => {
        delete entry._pValue;
        delete entry._hypothesisId;
    });
    return {
        eligibleRows: [...groups.values()].reduce(
            (sum, group) => sum + group.entries.length,
            0
        ),
        uniqueHypotheses: eligible.length,
        duplicateHypothesisRows: [...groups.values()].reduce(
            (sum, group) => sum + Math.max(0, group.entries.length - 1),
            0
        ),
    };
}

function buildLedgerOutcomeMatrix(rows, coordinateRegistry, scopeKey) {
    const matrix = {};
    for (const outcome of OUTCOME_DEFINITIONS) {
        const outcomeRows = rows.filter(row => finite(outcome.accessor(row))).length;
        const coordinates = coordinateRegistry.columns.map(column => {
            const points = rows.map(row => ({
                id: row.id,
                accountId: row.accountId,
                title: row.title,
                contentFamilyId: (
                    row.contentFamilyEvidence
                    || validationContentFamilyEvidence(row)
                ).familyId,
                contentFamilyEvidence: row.contentFamilyEvidence
                    || validationContentFamilyEvidence(row),
                actual: transformOutcome(outcome.accessor(row), outcome),
                predicted: coordinateModelValue(row, column),
                baseline: coordinateModelBaseline(row, column),
                validationSource: row.validationSource || 'saved_channel_join',
            }));
            const raw = rawCoordinateAssociation(points, outcome, scopeKey);
            const isOutcome = column.valueClass === 'observed_outcome';
            const evaluationMode = coordinateEvaluationMode(column, outcome);
            const nativePrediction = !isOutcome
                && evaluationMode !== 'association_only';
            const evaluation = nativePrediction
                ? identityCoordinateEvaluation(points, outcome, evaluationMode)
                : null;
            const predictionMetrics = predictionCoordinateMetrics(
                evaluation,
                outcome
            );
            const coordinateRows = points.filter(point => finite(point.predicted)).length;
            const pairedRows = raw.n;
            const pairedBlindOnlyRows = points.filter(point => (
                point.validationSource === 'predictor_blind_inputs_only'
                && finite(point.actual) && finite(point.predicted)
            )).length;
            const independentAccountCount = new Set(points.filter(point => (
                finite(point.actual) && finite(point.predicted)
            )).map(point => point.accountId)).size;
            const available = !isOutcome && pairedRows >= 3;
            const predictorRankingEligible =
                coordinatePredictorRankingEligible(column);
            const modelSelectionEligible = available
                && predictorRankingEligible
                && outcome.selectionRepresentative;
            let availabilityNote = null;
            if (isOutcome) {
                availabilityNote = 'outcome_not_predictor: measured outcomes are never ranked or evaluated as predictors.';
            } else if (!pairedRows) {
                availabilityNote = 'No row has both this coordinate and this observed outcome.';
            } else if (pairedRows < 3) {
                availabilityNote = 'Fewer than three paired rows; association is not estimable.';
            } else if (evaluationMode === 'association_only') {
                const native = nativeOutcomeKey(column);
                availabilityNote = `Association only: ${column.id} is registered to predict ${native || column.target}, not ${outcome.key}. The chart does not fit a new cross-outcome estimator.`;
            }
            if (outcome.selectionDuplicateOf) {
                availabilityNote = `${
                    availabilityNote ? `${availabilityNote} ` : ''
                }Displayed for interpretation only: ${outcome.key} is an algebraic or governed duplicate of ${outcome.selectionDuplicateOf} and is excluded from model selection.`;
            }
            const confirmatoryBlockers = [
                'No prospective confirmation is evaluated by this retrospective relationship cell.',
                independentAccountCount >= MIN_CONFIRMATORY_ACCOUNT_COUNT
                    ? null
                    : `Only ${independentAccountCount} independent creator account${
                        independentAccountCount === 1 ? '' : 's'
                    } are represented; ${MIN_CONFIRMATORY_ACCOUNT_COUNT} are required.`,
                'The reported p-value, when available, is an exact creator-level sign-flip test over creator-macro content-family effects. Fewer than three independent creators produce no transfer p-value.',
                outcome.selectionDuplicateOf
                    ? `${outcome.key} duplicates the ${outcome.selectionDuplicateOf} outcome family for selection.`
                    : null,
            ].filter(Boolean);
            const metrics = {
                spearman: isOutcome ? null : raw.spearman,
                withinAccountSpearman: isOutcome ? null : raw.withinAccountSpearman,
                auc: isOutcome ? null : raw.auc,
                withinAccountAuc: isOutcome ? null : raw.withinAccountAuc,
                inferentialEffect: isOutcome ? null : raw.inferentialEffect,
                inferentialPValue:
                    isOutcome ? null : raw.inferentialPValue,
                inferentialEstimand:
                    isOutcome ? null : raw.inferentialEstimand,
                inferentialN: isOutcome ? 0 : raw.inferentialN,
                inferentialCreatorCount:
                    isOutcome ? 0 : raw.inferentialCreatorCount,
                inferentialMethod:
                    isOutcome ? null : raw.inferentialMethod,
                predictionR2: isOutcome ? null : predictionMetrics.predictionR2,
                predictionSpearman: isOutcome
                    ? null
                    : predictionMetrics.predictionSpearman,
                predictionMae: isOutcome ? null : predictionMetrics.predictionMae,
                predictionBaselineMae: isOutcome
                    ? null
                    : predictionMetrics.predictionBaselineMae,
                predictionMaeImprovementVsBaseline: isOutcome
                    ? null
                    : predictionMetrics.predictionMaeImprovementVsBaseline,
                predictionProtocolBaselineR2: isOutcome
                    ? null
                    : predictionMetrics.predictionProtocolBaselineR2,
                predictionMedianFactorError: isOutcome
                    ? null
                    : predictionMetrics.predictionMedianFactorError,
                predictionAuc: isOutcome
                    ? null
                    : predictionMetrics.predictionAuc,
                predictionBrier: isOutcome
                    ? null
                    : predictionMetrics.predictionBrier,
                n: pairedRows,
                predictionN: isOutcome ? 0 : predictionMetrics.predictionN,
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
                predictorEligible: predictorRankingEligible,
                modelSelectionEligible,
                selectionDuplicateOf: outcome.selectionDuplicateOf,
                availabilityNote,
                nativeOutcomeKey: nativeOutcomeKey(column),
                evaluationMode,
                validationTier: coordinateValidationTier(column, outcome),
                plainEnglish: coordinatePlainEnglish(column, outcome),
                coverage: {
                    cohortRows: rows.length,
                    outcomeRows,
                    coordinateRows,
                    pairedRows,
                    pairedFraction: rows.length ? round(pairedRows / rows.length) : 0,
                    pairedBlindOnlyRows,
                    accountCount: independentAccountCount,
                    evaluationMode,
                    predictionRows: predictionMetrics.predictionN,
                    chartFittedParameterCount: 0,
                    chartTrainingRowsRead: 0,
                    chartTrainingOutcomesRead: 0,
                },
                inference: {
                    status:
                        'exploratory-creator-blocked-exact-sign-flip',
                    hypothesisFamily: outcome.hypothesisFamily,
                    selectionRepresentative:
                        outcome.selectionRepresentative,
                    selectionDuplicateOf: outcome.selectionDuplicateOf,
                    modelSelectionEligible,
                    independentAccountCount,
                    minimumIndependentAccountsForConfirmatoryClaim:
                        coordinateGovernance.inference
                            .minimumIndependentAccountsForConfirmatoryClaim,
                    creatorDiversityPassed:
                        independentAccountCount >= MIN_CONFIRMATORY_ACCOUNT_COUNT,
                    prospectiveConfirmed: false,
                    confirmatoryEligible: false,
                    confirmatoryBlockers,
                    uncertaintyUnit: 'creator_account',
                    creatorClusteredIntervalAvailable: false,
                    warning: 'Content families are collapsed within creator. An exact creator-level sign-flip p-value is available only with at least three contributing creators, and remains exploratory until prospective confirmation.',
                    interpretation: independentAccountCount >= coordinateGovernance
                        .inference.minimumIndependentAccountsForConfirmatoryClaim
                        ? 'The creator count clears the diversity floor, but this retrospective creator-blocked sign-flip analysis has no prospective confirmation, so it remains exploratory.'
                        : `Only ${independentAccountCount} independent creator account${independentAccountCount === 1 ? '' : 's'} support this cell; video rows do not create additional independent creator replications.`,
                },
                evaluation: evaluation ? {
                    mode: evaluation.mode,
                    valueSource: evaluation.valueSource,
                    outputScale: evaluation.transform,
                    identity: evaluation.identity,
                    fittedByRelationshipChart:
                        evaluation.fittedByRelationshipChart,
                    audit: evaluation.audit,
                    diagnostics: identityCoordinateDiagnostics(
                        evaluation,
                        outcome
                    ),
                } : null,
                metrics,
                _pValue: isOutcome || !predictorRankingEligible
                    ? null
                    : raw.inferentialPValue,
                _hypothesisId: isOutcome || !predictorRankingEligible
                    ? null
                    : `${column.coordinateIdentity.axisFingerprint}:${outcome.hypothesisFamily}`,
            };
            return entry;
        });
        matrix[outcome.key] = {
            outcome: {
                ...Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'accessor')),
                observedRows: outcomeRows,
                cohortRows: rows.length,
                plainEnglish: outcome.selectionDuplicateOf
                    ? `Measured ${outcome.label}. This is the governed algebraic complement of ${outcome.selectionDuplicateOf}; it remains visible but cannot count as a second model-selection outcome.`
                    : `Measured ${outcome.label}. Every canonical score-ledger coordinate is tested against this same outcome definition.`,
            },
            coordinates,
        };
    }
    const columnsById = new Map(coordinateRegistry.columns.map(column => [column.id, column]));
    const globalFamily = Object.values(matrix).flatMap(result => result.coordinates);
    const qValueAudit = adjustLedgerQValues(globalFamily);
    Object.values(matrix).forEach(result => {
        result.outcome.qValueFamily =
            'global_unique_coordinate_axis_by_outcome_hypothesis';
        result.outcome.qValueEligibleTests = qValueAudit.uniqueHypotheses;
        result.outcome.qValueEligibleRows = qValueAudit.eligibleRows;
        result.outcome.qValueDuplicateRowsRemoved =
            qValueAudit.duplicateHypothesisRows;
    });
    globalFamily.forEach(entry => {
        entry.metrics.evidence = ledgerEvidence(
            entry.metrics,
            columnsById.get(entry.coordinateId),
            entry.inference,
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
        if (definition.variant === 'percentile') {
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

function fitRidgeMulti(rows, targets, lambda) {
    if (rows.length < 8 || !targets.length) return null;
    const featureMeans = STRICT_FORECAST_RAW_FEATURES.map(name => {
        const values = rows.map(
            row => creatorExcludedPublicFeatureValue(row, name)
        ).filter(finite);
        return values.length ? average(values) : 0;
    });
    const featureScales = STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
        const values = rows.map(
            row => creatorExcludedPublicFeatureValue(row, name)
        ).filter(finite);
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
    const parameterCount = STRICT_FORECAST_RAW_FEATURES.length * 2 + 1;
    const left = Array.from({ length: parameterCount }, () => Array(parameterCount).fill(0));
    const right = Array.from({ length: parameterCount }, () => Array(targets.length).fill(0));
    for (const row of rows) {
        const missing = STRICT_FORECAST_RAW_FEATURES.map(name => (
            finite(creatorExcludedPublicFeatureValue(row, name)) ? 0 : 1
        ));
        const x = [1, ...STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
            const value = creatorExcludedPublicFeatureValue(row, name);
            return finite(value) ? (Number(value) - featureMeans[index]) / featureScales[index] : 0;
        }), ...missing];
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
        missingnessIndicators: true,
        predict(row) {
            const missing = STRICT_FORECAST_RAW_FEATURES.map(name => (
                finite(creatorExcludedPublicFeatureValue(row, name)) ? 0 : 1
            ));
            const x = [1, ...STRICT_FORECAST_RAW_FEATURES.map((name, index) => {
                const value = creatorExcludedPublicFeatureValue(row, name);
                return finite(value) ? (Number(value) - featureMeans[index]) / featureScales[index] : 0;
            }), ...missing];
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

function targetSelectionFamily(target) {
    return String(target && (target.selectionFamily || target.key) || 'unknown');
}

function targetSelectionFamilySummary(targets) {
    const families = new Map();
    for (const target of targets) {
        const family = targetSelectionFamily(target);
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(target.key);
    }
    return [...families.entries()].map(([family, targetKeys]) => ({
        family,
        targetKeys,
        weight: round(1 / families.size),
        withinFamilyTargetWeight: round(1 / targetKeys.length),
    }));
}

function selectRidgeLambda(rows, targets, salt) {
    const accountIds = [...new Set(rows.map(row => row.accountId))].sort();
    const useAccountFolds = accountIds.length >= 2;
    const foldCount = rows.length >= 80 ? 4 : 3;
    const groupedAssignment = useAccountFolds
        ? null
        : contentFamilyFoldAssignments(rows, foldCount, salt);
    const rowIndices = new Map(
        rows.map((row, index) => [row, index])
    );
    const folds = useAccountFolds
        ? accountIds
        : Array.from(
            { length: groupedAssignment.folds },
            (_, index) => index
        );
    let best = {
        lambda: RIDGE_LAMBDAS[0],
        error: Infinity,
        creatorMacroStandardizedMse: Infinity,
        worstCreatorStandardizedMse: Infinity,
    };
    for (const lambda of RIDGE_LAMBDAS) {
        const squaredErrorsByAccountFamily = new Map();
        for (const fold of folds) {
            const inFold = row => useAccountFolds
                ? row.accountId === fold
                : groupedAssignment.assignments[rowIndices.get(row)] === fold;
            const training = rows.filter(row => !inFold(row));
            const testing = rows.filter(inFold);
            const model = fitRidgeMulti(training, targets, lambda);
            if (!model || !testing.length) continue;
            for (const row of testing) {
                const predicted = model.predict(row);
                targets.forEach((target, index) => {
                    const scale = model.targetScales[index] || 1;
                    const residual = (predicted[index] - Number(target.accessor(row))) / scale;
                    const family = targetSelectionFamily(target);
                    if (!squaredErrorsByAccountFamily.has(row.accountId)) {
                        squaredErrorsByAccountFamily.set(
                            row.accountId,
                            new Map()
                        );
                    }
                    const accountFamilies =
                        squaredErrorsByAccountFamily.get(row.accountId);
                    if (!accountFamilies.has(family)) {
                        accountFamilies.set(family, []);
                    }
                    accountFamilies.get(family).push(residual * residual);
                });
            }
        }
        const creatorErrors = [...squaredErrorsByAccountFamily.values()]
            .map(families => [...families.values()]
                .filter(errors => errors.length)
                .map(errors => average(errors)))
            .filter(familyErrors => familyErrors.length)
            .map(familyErrors => average(familyErrors));
        const creatorMacroError = creatorErrors.length
            ? average(creatorErrors)
            : Infinity;
        const worstCreatorError = creatorErrors.length
            ? Math.max(...creatorErrors)
            : Infinity;
        const objective = finite(creatorMacroError)
            && finite(worstCreatorError)
            ? 0.75 * creatorMacroError + 0.25 * worstCreatorError
            : Infinity;
        if (objective < best.error - 1e-12
            || (Math.abs(objective - best.error) <= 1e-12
                && lambda > best.lambda)) {
            best = {
                lambda,
                error: objective,
                creatorMacroStandardizedMse: creatorMacroError,
                worstCreatorStandardizedMse: worstCreatorError,
                selectionFamilyCount: new Set(
                    targets.map(targetSelectionFamily)
                ).size,
                creatorCount: creatorErrors.length,
                innerFoldUnit: useAccountFolds
                    ? 'creator_account'
                    : 'content_family',
            };
        }
    }
    return best;
}

function crossValidatedTarget(rows, target, foldMode) {
    const eligible = rows.filter(row => finite(target.accessor(row)));
    const predictions = new Map(), baselines = new Map(), selected = [];
    const outerFoldPopulations = [];
    const groupedAssignment = foldMode === 'account'
        ? null
        : contentFamilyFoldAssignments(rows, 5, 'outer');
    const foldByFamily = groupedAssignment
        ? new Map(rows.map((row, index) => [
            validationContentFamilyId(row),
            groupedAssignment.assignments[index],
        ]))
        : null;
    const folds = foldMode === 'account'
        ? [...new Set(eligible.map(row => row.accountId))]
        : [...new Set(eligible.map(row => (
            foldByFamily.get(validationContentFamilyId(row))
        )))].filter(finite).sort((left, right) => left - right);
    for (const fold of folds) {
        const inFold = row => {
            if (foldMode === 'account') return row.accountId === fold;
            return foldByFamily.get(
                validationContentFamilyId(row)
            ) === fold;
        };
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
        const choice = selectRidgeLambda(
            training,
            [target],
            `inner:${foldMode}:${target.key}:${fold}`
        );
        const model = fitRidgeMulti(training, [target], choice.lambda);
        if (!model) continue;
        selected.push({
            fold: String(fold),
            targetKey: target.key,
            lambda: choice.lambda,
            innerStandardizedMse: round(choice.error),
            innerFamilyBalancedStandardizedMse: round(choice.error),
            innerCreatorMacroStandardizedMse:
                round(choice.creatorMacroStandardizedMse),
            innerWorstCreatorStandardizedMse:
                round(choice.worstCreatorStandardizedMse),
            innerCreatorCount: choice.creatorCount || 0,
            innerFoldUnit: choice.innerFoldUnit || 'unavailable',
            selectionFamilyCount: choice.selectionFamilyCount || 0,
            selectionFamilies: targetSelectionFamilySummary([target]),
        });
        for (const row of testing) {
            predictions.set(row.id, model.predict(row)[0]);
            baselines.set(row.id, model.targetMeans[0]);
        }
    }
    return {
        eligible: eligible.length,
        eligibleVideoIdSha256: sha256Ids(eligible.map(row => row.id)),
        outerFoldPopulations,
        outerFoldLineage: foldMode === 'account'
            ? {
                algorithm: 'leave-one-creator-account-out',
                unit: 'creator_account',
            }
            : {
                algorithm: 'content-family-grouped-balanced-v1',
                unit: 'content_family',
                assignmentSha256: sha256Json(
                    [...foldByFamily.entries()]
                        .map(([contentFamilyId, fold]) => ({
                            contentFamilyId,
                            fold,
                        }))
                        .sort((left, right) => (
                            left.contentFamilyId.localeCompare(
                                right.contentFamilyId
                            )
                        ))
                ),
                contentFamilies: groupedAssignment.contentFamilies,
            },
        predictions,
        baselines,
        selected,
        targetKey: target.key,
    };
}

function crossValidatedMulti(rows, targets, foldMode) {
    const runs = targets.map(target => (
        crossValidatedTarget(rows, target, foldMode)
    ));
    const predictions = new Map(), baselines = new Map();
    const setValue = (map, id, index, value) => {
        if (!map.has(id)) map.set(id, Array(targets.length).fill(null));
        map.get(id)[index] = finite(value) ? Number(value) : null;
    };
    runs.forEach((run, targetIndex) => {
        run.predictions.forEach((value, id) => (
            setValue(predictions, id, targetIndex, value)
        ));
        run.baselines.forEach((value, id) => (
            setValue(baselines, id, targetIndex, value)
        ));
    });
    const eligibleIds = [...new Set(runs.flatMap(
        run => rows.filter(row => finite(
            targets.find(target => target.key === run.targetKey).accessor(row)
        )).map(row => row.id)
    ))];
    return {
        eligible: eligibleIds.length,
        eligibleVideoIdSha256: sha256Ids(eligibleIds),
        targetEligibility: Object.fromEntries(runs.map(run => [
            run.targetKey,
            {
                n: run.eligible,
                videoIdSha256: run.eligibleVideoIdSha256,
            },
        ])),
        outerFoldPopulations: runs.flatMap(run => (
            run.outerFoldPopulations.map(population => ({
                targetKey: run.targetKey,
                ...population,
            }))
        )),
        outerFoldLineage: runs[0]
            ? runs[0].outerFoldLineage
            : null,
        outerFoldLineageConsistent: runs.every(run => (
            sha256Json(run.outerFoldLineage)
                === sha256Json(runs[0] && runs[0].outerFoldLineage)
        )),
        predictions,
        baselines,
        selected: runs.flatMap(run => run.selected),
        featureNames: STRICT_FORECAST_RAW_FEATURES.slice(),
        targetKeys: targets.map(target => target.key),
        targetSelectionFamilies: targetSelectionFamilySummary(targets),
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
        { key: 'keep', selectionFamily: 'feed-decision', accessor: row => row.actual.keep },
        { key: 'ret5', selectionFamily: 'early-retention', accessor: row => row.actual.ret5 },
        { key: 'averageRetention', selectionFamily: 'overall-retention', accessor: row => row.actual.averageRetention },
        { key: 'logViews', selectionFamily: 'reach', accessor: row => finite(row.actual.viewsCurrent) ? Math.log10(Math.max(0, Number(row.actual.viewsCurrent)) + 1) : null },
        { key: 'logOutlier', selectionFamily: 'reach', accessor: row => finite(row.actual.outlierCurrent) ? Math.log10(Math.max(0, Number(row.actual.outlierCurrent)) + 1) : null },
        { key: 'hit10M', selectionFamily: 'reach', accessor: row => row.actual.hit10MCurrent },
    ];
    const checkpointTargets = [
        { key: 'survival5', selectionFamily: 'retention-checkpoint-5s', accessor: row => curveValue(row, 'normalized', 5) },
        { key: 'survival10', selectionFamily: 'retention-checkpoint-10s', accessor: row => curveValue(row, 'normalized', 10) },
        { key: 'survival20', selectionFamily: 'retention-checkpoint-20s', accessor: row => curveValue(row, 'normalized', 20) },
        { key: 'drop5', selectionFamily: 'retention-checkpoint-5s', accessor: row => curveValue(row, 'drop', 5) },
        { key: 'drop10', selectionFamily: 'retention-checkpoint-10s', accessor: row => curveValue(row, 'drop', 10) },
        { key: 'drop20', selectionFamily: 'retention-checkpoint-20s', accessor: row => curveValue(row, 'drop', 20) },
    ];
    const curveTargets = CURVE_SECONDS.slice(1).map(second => ({
        key: `second${second}`,
        selectionFamily: 'retention-trajectory',
        accessor: row => curveValue(row, 'normalized', second),
    }));
    const runs = {
        video: {
            scalar: crossValidatedMulti(rows, scalarTargets, 'video'),
            checkpoints: crossValidatedMulti(rows, checkpointTargets, 'video'),
            curve: crossValidatedMulti(rows, curveTargets, 'video'),
        },
        account: {
            scalar: crossValidatedMulti(rows, scalarTargets, 'account'),
            checkpoints: crossValidatedMulti(rows, checkpointTargets, 'account'),
            curve: crossValidatedMulti(rows, curveTargets, 'account'),
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
                if (!values || !values.some(finite)) return null;
                const byKey = Object.fromEntries(scalarTargets.map(
                    (target, index) => [
                        target.key,
                        finite(values[index]) ? Number(values[index]) : NaN,
                    ]
                ));
                const checkpointsByKey = checkpointValues
                    ? Object.fromEntries(checkpointTargets.map((target, index) => [target.key, checkpointValues[index]]))
                    : {};
                return {
                    keep: round(byKey.keep),
                    swipe: round(100 - byKey.keep),
                    ret5: round(byKey.ret5),
                    averageRetention: round(byKey.averageRetention),
                    views: finite(byKey.logViews)
                        ? round(Math.max(0, 10 ** byKey.logViews - 1), 2)
                        : null,
                    outlier: finite(byKey.logOutlier)
                        ? round(Math.max(0, 10 ** byKey.logOutlier - 1))
                        : null,
                    hit10M: finite(byKey.hit10M)
                        ? round(clamp(byKey.hit10M, 0, 1))
                        : null,
                    survival5: round(checkpointsByKey.survival5),
                    survival10: round(checkpointsByKey.survival10),
                    survival20: round(checkpointsByKey.survival20),
                    drop5: round(checkpointsByKey.drop5),
                    drop10: round(checkpointsByKey.drop10),
                    drop20: round(checkpointsByKey.drop20),
                    retentionCurve: curveValues
                        && curveValues.some(finite)
                        ? [100, ...curveValues.map(value => round(value))]
                        : null,
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
            scalarEligibilityByTarget: run.scalar.targetEligibility,
            scalarOuterFoldLineage: run.scalar.outerFoldLineage,
            scalarOuterFoldLineageConsistent:
                run.scalar.outerFoldLineageConsistent,
            checkpointEligible: run.checkpoints.eligible,
            checkpointEligibleVideoIdSha256: run.checkpoints.eligibleVideoIdSha256,
            checkpointEligibilityByTarget:
                run.checkpoints.targetEligibility,
            checkpointOuterFoldLineage:
                run.checkpoints.outerFoldLineage,
            checkpointOuterFoldLineageConsistent:
                run.checkpoints.outerFoldLineageConsistent,
            curveEligibleThrough20s: run.curve.eligible,
            curveEligibleVideoIdSha256: run.curve.eligibleVideoIdSha256,
            curveEligibilityByTarget: run.curve.targetEligibility,
            curveOuterFoldLineage: run.curve.outerFoldLineage,
            curveOuterFoldLineageConsistent:
                run.curve.outerFoldLineageConsistent,
            scalarFolds: run.scalar.selected,
            scalarFoldPopulations: run.scalar.outerFoldPopulations,
            scalarSelectionFamilies: run.scalar.targetSelectionFamilies,
            checkpointFolds: run.checkpoints.selected,
            checkpointFoldPopulations: run.checkpoints.outerFoldPopulations,
            checkpointSelectionFamilies:
                run.checkpoints.targetSelectionFamilies,
            curveFolds: run.curve.selected,
            curveFoldPopulations: run.curve.outerFoldPopulations,
            curveSelectionFamilies: run.curve.targetSelectionFamilies,
            selectionWeightingRule: 'Each target has its own eligible population and Ridge fit. Inner selection averages standardized loss equally across creators and adds a 25% worst-creator penalty, so large creators cannot dominate hyperparameter choice.',
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
        key
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
    const joinedKeys = new Set(joinedRows.map(row => (
        `${String(row.accountId)}\u0000${String(row.id)}`
    )));
    const blindOnlyRows = [];
    for (const source of (blindInputs && blindInputs.rows) || []) {
        const id = String(source && source.id || '');
        const accountId = String(
            source && (source.account || source.accountId) || ''
        );
        if (!id || !accountId
            || joinedKeys.has(`${accountId}\u0000${id}`)) continue;
        const keep = number(source.actualKeep);
        const views = number(source.actualViews);
        blindOnlyRows.push({
            id,
            channelId: null,
            accountId,
            accountName: String(source.accountName || source.account || 'Unknown account'),
            title: String(source.title || id),
            publishedAt: number(source.publishedAt),
            duration: number(source.duration),
            subscribers: null,
            transcript: '',
            inputManifest: null,
            contentFamilyId: source.contentFamilyId
                || source.content_family_id
                || null,
            sourceContentId: source.sourceContentId
                || source.source_content_id
                || null,
            perceptualHash: source.perceptualHash
                || source.perceptual_hash
                || null,
            montageSha256: source.montageSha256
                || source.montage_sha256
                || null,
            noveltyProvenance: null,
            storedRaw: contract.features.map(() => null),
            storedPercentile: contract.features.map(() => null),
            blindFeatureNames,
            blindVideoHeldOut: Array.isArray(source.videoHeldOut) ? source.videoHeldOut : [],
            blindAccountHeldOut: Array.isArray(source.accountHeldOut) ? source.accountHeldOut : [],
            validationSource: 'predictor_blind_inputs_only',
            actual: {
                keep,
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

function creatorAdaptiveModelAuthority(study, suppliedModel) {
    if (!study) return null;
    const model = suppliedModel && (suppliedModel.model || suppliedModel);
    if (!model) return study;
    const comparableSelection = value => {
        const selection = value && value.selection || {};
        return {
            protocol: selection.protocol || null,
            candidateCount: number(selection.candidateCount),
            candidateRegistrySha256: selection.candidateRegistrySha256 || null,
            candidateCountWithAllAccounts: number(
                selection.candidateCountWithAllAccounts
            ),
            selected: selection.selected || null,
        };
    };
    const comparableBatch = value => {
        const batch = value && value.batchFreezeStress || {};
        return {
            protocol: batch.protocol || null,
            metrics: batch.metrics || null,
        };
    };
    const comparable = value => ({
        coordinateId: value && value.coordinateId || null,
        input: value && value.input || null,
        valueDefinition: value && value.valueDefinition || null,
        population: value && value.population || null,
        selection: comparableSelection(value),
        evaluation: value && value.evaluation || null,
        batchFreezeStress: comparableBatch(value),
        formula: value && value.formula || null,
        status: value && value.status || null,
    });
    if (sha256Json(comparable(study)) !== sha256Json(comparable(model))) {
        const error = new Error(
            'Predictor results disagree with the immutable creator-adaptive keep model.'
        );
        error.code = 'CREATOR_ADAPTIVE_MODEL_PARITY_MISMATCH';
        throw error;
    }
    const artifactSha256 = suppliedModel.artifactSha256
        || study.modelArtifact && study.modelArtifact.artifactSha256
        || null;
    return {
        ...study,
        ...(model.input !== undefined ? { input: model.input } : {}),
        ...(model.valueDefinition !== undefined
            ? { valueDefinition: model.valueDefinition }
            : {}),
        population: model.population,
        selection: {
            ...(study.selection || {}),
            ...(model.selection || {}),
        },
        evaluation: model.evaluation,
        ...(model.batchFreezeStress || study.batchFreezeStress
            ? {
                batchFreezeStress: {
                    ...(study.batchFreezeStress || {}),
                    ...(model.batchFreezeStress || {}),
                },
            }
            : {}),
        formula: model.formula,
        status: model.status,
        modelArtifact: {
            ...(study.modelArtifact || {}),
            ...(artifactSha256 ? { artifactSha256 } : {}),
        },
    };
}

function buildValidation({
    channels,
    predictor,
    creatorAdaptiveKeepModel = null,
    generatedAt = Date.now(),
    sourceFingerprint = null,
}) {
    if (!predictor || !predictor.targets || !predictor.targets.keep) {
        throw new Error('Predictor artifact is missing the keep target.');
    }
    const keepTarget = predictor.targets.keep || {};
    const viewsTarget = predictor.targets.views || {};
    const visualKeepStudy = keepTarget.visualOnlyStudy || null;
    const creatorAdaptiveStudy = creatorAdaptiveModelAuthority(
        keepTarget.creatorAdaptiveStudy || null,
        creatorAdaptiveKeepModel
    );
    const promotionAudits = {
        visualKeep: promotionEligibilityAudit(
            visualKeepStudy,
            'visual_keep'
        ),
        creatorAdaptiveKeep: promotionEligibilityAudit(
            creatorAdaptiveStudy,
            'creator_adaptive_keep'
        ),
    };
    const predictorProvenance = predictor.provenance || {};
    const visualKeepModelArtifact = visualKeepStudy
        && visualKeepStudy.modelArtifact
        || predictorProvenance.visualKeepModelArtifact
        || null;
    const visualKeepArtifactSha256 = (
        visualKeepModelArtifact
        && /^[a-f0-9]{64}$/i.test(String(visualKeepModelArtifact.artifactSha256 || ''))
    ) ? String(visualKeepModelArtifact.artifactSha256).toLowerCase() : null;
    const visualKeepRelease = predictorProvenance.runtimeManifests
        && predictorProvenance.runtimeManifests.visualKeepModelRelease
        || {};
    const visualKeepManifestSha256 = exactSha256(
        visualKeepRelease.manifestSha256
    ) ? String(visualKeepRelease.manifestSha256).toLowerCase() : null;
    const visualKeepReleaseArtifactSha256 = exactSha256(
        visualKeepRelease.artifactSha256
    ) ? String(visualKeepRelease.artifactSha256).toLowerCase() : null;
    const visualKeepReleaseParityPassed = !!(
        visualKeepArtifactSha256
        && visualKeepManifestSha256
        && visualKeepReleaseArtifactSha256
            === visualKeepArtifactSha256
    );
    const visualKeepProduction = pointMap(
        visualKeepStudy
        && visualKeepStudy.production
        && visualKeepStudy.production.points
    );
    const visualKeepProtocolMaps = Object.fromEntries(
        Object.keys(VISUAL_KEEP_PROTOCOL_COORDINATES).map(protocolKey => [
            protocolKey,
            pointMap(
                visualKeepStudy
                && visualKeepStudy.protocols
                && visualKeepStudy.protocols[protocolKey]
                && visualKeepStudy.protocols[protocolKey].points
            ),
        ])
    );
    const visualKeepProtocolValues = id => Object.fromEntries(
        Object.entries(visualKeepProtocolMaps).map(([protocolKey, points]) => {
            const point = points.get(String(id)) || {};
            return [protocolKey, {
                predicted: number(point.predicted),
                baseline: number(point.baseline),
                fold: point.fold == null ? null : String(point.fold),
            }];
        })
    );
    const creatorAdaptiveEvaluation = pointMap(
        creatorAdaptiveStudy
        && creatorAdaptiveStudy.evaluation
        && creatorAdaptiveStudy.evaluation.points
    );
    const keepKnown = pointMap(keepTarget.points);
    const keepUnseen = pointMap(predictorStress(keepTarget, 'Unseen-account transfer').points);
    const keepForward = pointMap(predictorStress(keepTarget, 'Forward-time keep-rate transfer').points);
    const viewsKnown = pointMap(viewsTarget.points);
    const viewsUnseen = pointMap(predictorStress(viewsTarget, 'Unseen-channel transfer').points);
    const viewsForward = pointMap(predictorStress(viewsTarget, 'Forward-time public-views transfer').points);
    const blindInputs = keepTarget.blindInputs || {};
    const blindFeatureNames = Array.isArray(blindInputs.featureNames) ? blindInputs.featureNames : [];
    const blindById = new Map();
    for (const blindRow of blindInputs.rows || []) {
        const id = String(blindRow && blindRow.id || '');
        const accountId = String(
            blindRow && (blindRow.account || blindRow.accountId) || ''
        );
        if (!id || !accountId) {
            const error = new Error(
                'Every blind-validation row must declare both video ID and canonical account ID.'
            );
            error.code = 'BLIND_ROW_IDENTITY_MISSING';
            throw error;
        }
        if (blindById.has(id)) {
            const error = new Error(
                `Blind-validation artifact contains duplicate video ID ${id}.`
            );
            error.code = 'BLIND_ROW_DUPLICATE_VIDEO_ID';
            throw error;
        }
        blindById.set(id, blindRow);
    }
    const rows = [];
    const joinSummary = [];

    for (const source of channels || []) {
        const privateVideos = (source.privateTable && source.privateTable.videos) || [];
        const savedVideos = (source.manifest && source.manifest.videos) || [];
        const savedById = new Map(savedVideos.map(video => [String(video.id), video]));
        let matched = 0;
        let legacyLedgerMissing = 0;
        let invalidLedgerExcluded = 0;
        let legacyManifestBindingMissing = 0;
        let invalidManifestBindingExcluded = 0;
        for (const privateVideo of privateVideos) {
            const id = String(privateVideo.id || privateVideo.videoId || '');
            const saved = savedById.get(id);
            if (!id || !saved || saved.status !== 'done') continue;
            const ledgerState = scoreLedgerValidationSummary(saved);
            if (ledgerState.valid !== true) {
                if (ledgerState.state === 'legacy-missing') {
                    legacyLedgerMissing++;
                } else {
                    invalidLedgerExcluded++;
                }
                continue;
            }
            const manifestBinding =
                validateManifestRowBinding(saved);
            if (manifestBinding.valid !== true) {
                if (manifestBinding.state === 'legacy-missing') {
                    legacyManifestBindingMissing++;
                } else {
                    invalidManifestBindingExcluded++;
                }
                continue;
            }
            matched++;
            const blind = blindById.get(id) || {};
            if (blindById.has(id)
                && String(blind.account || blind.accountId || '')
                    !== String(source.accountId || '')) {
                const error = new Error(
                    `Blind-validation account mismatch for ${id}.`
                );
                error.code = 'BLIND_ROW_ACCOUNT_MISMATCH';
                throw error;
            }
            const knownKeep = keepKnown.get(id) || {};
            const unseenKeep = keepUnseen.get(id) || {};
            const forwardKeep = keepForward.get(id) || {};
            const knownViews = viewsKnown.get(id) || {};
            const unseenViews = viewsUnseen.get(id) || {};
            const forwardViews = viewsForward.get(id) || {};
            const frozenVisualKeep = visualKeepProduction.get(id) || {};
            const creatorAdaptiveKeep = creatorAdaptiveEvaluation.get(id) || {};
            const persistedVisualKeep = saved.visual_keep_forecast
                && typeof saved.visual_keep_forecast === 'object'
                ? saved.visual_keep_forecast
                : null;
            const persistedVisualKeepAudit =
                persistedVisualKeepForecastAudit(
                    saved,
                    visualKeepReleaseParityPassed
                        ? visualKeepArtifactSha256
                        : null,
                    visualKeepManifestSha256,
                    visualKeepStudy,
                    contract.version,
                    FEATURE_CONTRACT_DOCUMENT_SHA256
                );
            const currentPersistedVisualKeep =
                persistedVisualKeepAudit.valid
                    ? persistedVisualKeep
                    : null;
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
                sourceScoreLedgerSha256:
                    saved.score_ledger
                    && saved.score_ledger.ledger_sha256 || null,
                sourceScoreRecordSha256:
                    saved.score_record_sha256 || null,
                title: String(saved.title || privateVideo.title || id),
                publishedAt: parseDate(privateVideo.published || saved.published),
                duration,
                subscribers: number(saved.subscribers),
                transcript: String(saved.transcript || ''),
                inputManifest: saved.input_manifest && typeof saved.input_manifest === 'object'
                    ? saved.input_manifest
                    : null,
                contentFamilyId: saved.contentFamilyId
                    || saved.content_family_id
                    || blind.contentFamilyId
                    || blind.content_family_id
                    || null,
                sourceContentId: saved.sourceContentId
                    || saved.source_content_id
                    || blind.sourceContentId
                    || blind.source_content_id
                    || null,
                perceptualHash: saved.perceptualHash
                    || saved.perceptual_hash
                    || blind.perceptualHash
                    || blind.perceptual_hash
                    || null,
                montageSha256: saved.montageSha256
                    || saved.montage_sha256
                    || blind.montageSha256
                    || blind.montage_sha256
                    || null,
                noveltyProvenance: saved.novelty_provenance && typeof saved.novelty_provenance === 'object'
                    ? saved.novelty_provenance
                    : null,
                contentFamilyEvidence:
                    validationContentFamilyEvidence({
                        ...blind,
                        ...saved,
                        inputManifest: saved.input_manifest,
                        title: String(
                            saved.title || privateVideo.title || id
                        ),
                    }),
                studyMetadata: {
                    visualKeep: {
                        persistedScoreTimeForecastAudit:
                            persistedVisualKeepAudit,
                    },
                },
                storedRaw: storedCells.map(cell => cell.raw),
                storedPercentile: storedCells.map(cell => cell.percentile),
                blindFeatureNames,
                blindVideoHeldOut,
                blindAccountHeldOut,
                actual: {
                    keep,
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
                    visualKeepForecast: number(
                        currentPersistedVisualKeep
                        && (currentPersistedVisualKeep.raw != null
                            ? currentPersistedVisualKeep.raw
                            : currentPersistedVisualKeep.est)
                    ),
                    visualKeepForecastSource: currentPersistedVisualKeep
                        ? 'live_frozen_model_score'
                        : null,
                    visualKeepForecastEvaluationStatus:
                        currentPersistedVisualKeep
                            ? promotionAudits.visualKeep
                                && promotionAudits.visualKeep
                                    .prospectiveConfirmed
                                ? 'immutable_preregistered_result_audit_passed'
                                : 'retrospective_score_time_prediction_not_confirmed_by_preregistered_result'
                            : null,
                    visualKeepForecastArtifactSha256: (
                        currentPersistedVisualKeep
                        && currentPersistedVisualKeep.model_artifact_sha256
                    ),
                    visualKeepForecastManifestSha256: (
                        currentPersistedVisualKeep
                        && currentPersistedVisualKeep.model_manifest_sha256
                    ),
                    visualKeepForecastInputFingerprint: (
                        currentPersistedVisualKeep
                        && persistedVisualKeepAudit.inputFingerprint
                    ),
                    visualKeepForecastInputRevisionFingerprint: (
                        currentPersistedVisualKeep
                        && persistedVisualKeepAudit
                            .inputRevisionFingerprint
                    ),
                    visualKeepForecastRejectedRevision: (
                        persistedVisualKeep && !currentPersistedVisualKeep
                            ? persistedVisualKeep.model_artifact_sha256 || 'unversioned'
                            : null
                    ),
                    visualKeepForecastRejectionReasons: (
                        persistedVisualKeep && !currentPersistedVisualKeep
                            ? persistedVisualKeepAudit.blockers
                            : []
                    ),
                    visualKeepProtocols: visualKeepProtocolValues(id),
                    creatorAdaptiveKeepPrequential: number(
                        creatorAdaptiveKeep.predicted
                    ),
                    creatorAdaptiveKeepPrequentialSource: finite(
                        creatorAdaptiveKeep.predicted
                    ) ? 'causal_final20_prequential' : null,
                    creatorAdaptiveKeepBaseline: number(
                        creatorAdaptiveKeep.baseline
                    ),
                    creatorAdaptiveKeepHistoryN: number(
                        creatorAdaptiveKeep.historyN
                    ),
                    creatorAdaptiveKeepHistoryEnd: number(
                        creatorAdaptiveKeep.historyEnd
                    ),
                    creatorAdaptiveKeepComponentA: number(
                        creatorAdaptiveKeep.componentA
                    ),
                    creatorAdaptiveKeepComponentB: number(
                        creatorAdaptiveKeep.componentB
                    ),
                    creatorAdaptiveKeepHistoryVideoIds: Array.isArray(
                        creatorAdaptiveKeep.historyVideoIds
                    ) ? creatorAdaptiveKeep.historyVideoIds.map(String) : [],
                    creatorAdaptiveKeepArtifactSha256: finite(
                        creatorAdaptiveKeep.predicted
                    ) && creatorAdaptiveStudy && creatorAdaptiveStudy.modelArtifact
                        ? creatorAdaptiveStudy.modelArtifact.artifactSha256
                        : null,
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
            canonicalLedgerRows: savedVideos.filter(video => (
                video.status === 'done'
                && scoreLedgerValidationSummary(video).valid === true
            )).length,
            canonicalManifestRows: savedVideos.filter(video => (
                video.status === 'done'
                && validateManifestRowBinding(video).valid === true
            )).length,
            legacyLedgerMissing,
            invalidLedgerExcluded,
            legacyManifestBindingMissing,
            invalidManifestBindingExcluded,
            matchedRows: matched,
            unmatchedPrivateRows: privateVideos.length - matched,
        });
    }

    rows.sort((left, right) => (right.publishedAt || 0) - (left.publishedAt || 0) || left.id.localeCompare(right.id));
    const blindFoldAudit = auditBlindFoldLineage(blindInputs);
    const creatorChannelIdentityAudit =
        validationCreatorChannelIdentityAudit(
            channels,
            predictorProvenance
        );
    const publicAxisOverlapAudit = auditPublicAxisOverlap(
        predictorProvenance,
        (blindInputs.rows || []).map(row => row.id),
        rows.map(row => row.id),
        creatorChannelIdentityAudit
    );
    const validationCohort = buildValidationCohort(rows, blindInputs, blindFeatureNames);
    const score21Model = attachScore21Forecasts(
        validationCohort.rows
    );
    for (const row of validationCohort.rows) {
        const frozenVisualKeep = visualKeepProduction.get(String(row.id)) || {};
        const creatorAdaptiveKeep = creatorAdaptiveEvaluation.get(String(row.id)) || {};
        row.predictions = row.predictions || {};
        row.contentFamilyEvidence = row.contentFamilyEvidence
            || validationContentFamilyEvidence(row);
        row.studyMetadata = row.studyMetadata || {};
        row.studyMetadata.visualKeep =
            row.studyMetadata.visualKeep || {};
        if (finite(frozenVisualKeep.predicted)) {
            row.studyMetadata.visualKeep
                .fullFitTrainingDiagnostic = {
                    relatedCoordinateId:
                        VISUAL_KEEP_COORDINATE_ID,
                    diagnosticId:
                        'shorts.visual-keep.full-fit-training-diagnostic.v1',
                    value: number(frozenVisualKeep.predicted),
                    source:
                        'current_model_full_fit_training_diagnostic',
                    modelArtifactSha256:
                        visualKeepArtifactSha256,
                    modelManifestSha256:
                        visualKeepManifestSha256,
                    excludedFromCanonicalLedger: true,
                    excludedFromValidationMatrix: true,
                    claimBoundary:
                        'This row was reconstructed from the final fitting model. It is retained only as study metadata and is never substituted into the canonical score-time forecast coordinate.',
                };
        }
        row.predictions.visualKeepProtocols = visualKeepProtocolValues(row.id);
        if (!Object.prototype.hasOwnProperty.call(
            row.predictions,
            'visualKeepForecast'
        )) {
            row.predictions.visualKeepForecast = null;
            row.predictions.visualKeepForecastSource = null;
            row.predictions.visualKeepForecastEvaluationStatus = null;
            row.predictions.visualKeepForecastArtifactSha256 = null;
            row.predictions.visualKeepForecastManifestSha256 = null;
            row.predictions.visualKeepForecastInputFingerprint = null;
            row.predictions.visualKeepForecastInputRevisionFingerprint =
                null;
            row.predictions.visualKeepForecastRejectionReasons = [];
        }
        if (!finite(
            row.predictions.creatorAdaptiveKeepPrequential
        )) {
            row.predictions.creatorAdaptiveKeepPrequential = number(
                creatorAdaptiveKeep.predicted
            );
            row.predictions.creatorAdaptiveKeepPrequentialSource = finite(
                creatorAdaptiveKeep.predicted
            ) ? 'causal_final20_prequential' : null;
            row.predictions.creatorAdaptiveKeepBaseline = number(
                creatorAdaptiveKeep.baseline
            );
            row.predictions.creatorAdaptiveKeepHistoryN = number(
                creatorAdaptiveKeep.historyN
            );
            row.predictions.creatorAdaptiveKeepHistoryEnd = number(
                creatorAdaptiveKeep.historyEnd
            );
            row.predictions.creatorAdaptiveKeepComponentA = number(
                creatorAdaptiveKeep.componentA
            );
            row.predictions.creatorAdaptiveKeepComponentB = number(
                creatorAdaptiveKeep.componentB
            );
            row.predictions.creatorAdaptiveKeepHistoryVideoIds = Array.isArray(
                creatorAdaptiveKeep.historyVideoIds
            ) ? creatorAdaptiveKeep.historyVideoIds.map(String) : [];
            row.predictions.creatorAdaptiveKeepArtifactSha256 = finite(
                creatorAdaptiveKeep.predicted
            ) && creatorAdaptiveStudy && creatorAdaptiveStudy.modelArtifact
                ? creatorAdaptiveStudy.modelArtifact.artifactSha256
                : null;
        }
        if (!finite(row.predictions.creatorAdaptiveKeepBaseline)) {
            row.predictions.creatorAdaptiveKeepBaseline = number(
                creatorAdaptiveKeep.baseline
            );
        }
        if (!finite(row.predictions.creatorAdaptiveKeepComponentA)) {
            row.predictions.creatorAdaptiveKeepComponentA = number(
                creatorAdaptiveKeep.componentA
            );
        }
        if (!finite(row.predictions.creatorAdaptiveKeepComponentB)) {
            row.predictions.creatorAdaptiveKeepComponentB = number(
                creatorAdaptiveKeep.componentB
            );
        }
        if (!Array.isArray(
            row.predictions.creatorAdaptiveKeepHistoryVideoIds
        )) {
            row.predictions.creatorAdaptiveKeepHistoryVideoIds = Array.isArray(
                creatorAdaptiveKeep.historyVideoIds
            ) ? creatorAdaptiveKeep.historyVideoIds.map(String) : [];
        }
    }
    const validationContentFamilyAudit =
        contentFamilyEvidenceAudit(validationCohort.rows);
    const visualKeepForecastProvenanceAudit = {
        failClosed: true,
        coordinateId: VISUAL_KEEP_COORDINATE_ID,
        requiredSource: 'live_frozen_model_score',
        requiredCalibrationScope: 'pooled_global',
        requiredAccountModel: null,
        requiredOutputBounds: [0, 100],
        expectedModelArtifactSha256: visualKeepArtifactSha256,
        expectedModelManifestSha256: visualKeepManifestSha256,
        releaseArtifactParityPassed:
            visualKeepReleaseParityPassed,
        modelOutputContract:
            visualKeepModelOutputAudit(visualKeepStudy),
        persistedForecastRows: validationCohort.rows.filter(row => (
            row.studyMetadata
            && row.studyMetadata.visualKeep
            && row.studyMetadata.visualKeep
                .persistedScoreTimeForecastAudit
            && row.studyMetadata.visualKeep
                .persistedScoreTimeForecastAudit.state
                !== 'missing_persisted_forecast'
        )).length,
        canonicalAcceptedRows: validationCohort.rows.filter(row => (
            finite(
                row.predictions
                && row.predictions.visualKeepForecast
            )
        )).length,
        rejectedPersistedRows: validationCohort.rows.filter(row => (
            row.studyMetadata
            && row.studyMetadata.visualKeep
            && row.studyMetadata.visualKeep
                .persistedScoreTimeForecastAudit
            && row.studyMetadata.visualKeep
                .persistedScoreTimeForecastAudit.state
                === 'rejected_persisted_forecast'
        )).length,
        fullFitTrainingDiagnosticsRetainedAsStudyMetadata:
            validationCohort.rows.filter(row => (
                row.studyMetadata
                && row.studyMetadata.visualKeep
                && row.studyMetadata.visualKeep
                    .fullFitTrainingDiagnostic
            )).length,
        fullFitTrainingDiagnosticsInsertedIntoCanonicalLedger: 0,
        rule: 'The canonical visual keep coordinate is populated only by an exact persisted score-time forecast bound to its score record, input fingerprints, input revision, canonical montage, and active artifact/manifest release. Final-fit training reconstructions never fill missing or rejected values.',
    };
    const coordinateRegistry = buildCoordinateRegistry({
        rows,
        predictorProvenance,
        predictorPrivateRows: blindInputs.rows || [],
        forecastModel: score21Model,
        visualKeepStudy,
        creatorAdaptiveStudy,
        sourceFingerprint,
        generatedAt,
        blindFoldAudit,
        publicAxisOverlapAudit,
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
    const ledgerAudit = attachCoordinateLedger(
        validationCohort.rows,
        coordinateRegistry,
        visualKeepStudy,
        creatorAdaptiveStudy
    );
    if (!ledgerAudit.passed) {
        const error = new Error(
            'Canonical score-ledger parity failed; refusing to expose values that do not resolve to one source of truth.'
        );
        error.code = 'SCORE_LEDGER_PARITY_MISMATCH';
        error.ledgerAudit = ledgerAudit;
        throw error;
    }
    const scopes = {
        pooled: buildScope(rows, validationCohort.rows, 'pooled', coordinateRegistry),
        tyler: buildScope(rows, validationCohort.rows, 'tyler', coordinateRegistry),
        hafu: buildScope(rows, validationCohort.rows, 'hafu', coordinateRegistry),
    };
    const blindFeatureVectorsAligned = validationCohort.rows.length > 0
        && new Set(blindFeatureNames).size === blindFeatureNames.length
        && validationCohort.rows.every(
            row => row.blindVideoHeldOut.length === blindFeatureNames.length
        )
        && validationCohort.rows.every(
            row => row.blindAccountHeldOut.length === blindFeatureNames.length
        );
    const requiredInputIndices = STRICT_FORECAST_RAW_FEATURES.map(
        name => blindFeatureNames.indexOf(name)
    );
    const finiteInputRows = validationCohort.rows.filter(row => (
        requiredInputIndices.every(index => (
            index >= 0
            && finite(row.blindVideoHeldOut[index])
            && finite(row.blindAccountHeldOut[index])
        ))
    )).length;
    const allRequiredInputsFinite = validationCohort.rows.length > 0
        && finiteInputRows === validationCohort.rows.length;
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
        sourceScoreLedgerSha256: row.sourceScoreLedgerSha256,
        sourceScoreRecordSha256: row.sourceScoreRecordSha256,
        actual: row.actual,
        predictions: row.predictions,
        scoreLedger: row.scoreLedger,
        contentFamilyEvidence: row.contentFamilyEvidence,
        studyMetadata: row.studyMetadata,
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
        visualKeepStudy,
        creatorAdaptiveStudy,
        promotionAudits,
        coordinateRegistry,
        ledgerAudit,
        outcomeDefinitions: OUTCOME_DEFINITIONS.map(definition => (
            Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'accessor'))
        )),
        validationContract: {
            stored: 'Exact 21 values persisted by the channel scorer. Their upstream fit and historical rank calibration may include the scored account or video, so they are in-sample/unknown-generation diagnostics and never confirmatory evidence.',
            videoHeldOut: `${blindInputs.videoHeldOutProtocol || 'The evaluated video is excluded from every target-aligned fit.'} The canonical matrix evaluates that exact registered value; it does not fit a second chart-only calibration. This remains retrospective evidence rather than prospective confirmation.`,
            accountHeldOut: `${blindInputs.accountHeldOutProtocol || 'The evaluated account is excluded from every target-aligned fit.'} The canonical matrix evaluates that exact registered value; it does not fit a second chart-only calibration. Whole-account exclusion measures historical transfer, not future prospective confirmation.`,
            publicViewsAxis: 'The one-component PLS direction and rank-to-outcome calibration are refit on public corpus videos after excluding private rows, saved rows, and every video from each validation creator. This is a retrospective creator-excluded research axis, not a confirmatory or prospective calibration.',
            forwardTime: 'Training labels precede test labels, but the present-day representation remains fixed; this is a partial backtest.',
            visualKeepStudy: `A separate visual-only study fits directly from the canonical 1,536-dimensional opening montage embedding. Nested video holdout, historical forward-time, and whole-creator holdout remain research evidence. Promotion additionally requires at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} independently evaluated creators with at least ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} rows each and an immutable prospective registration/result chain; missing evidence fails closed.`,
            creatorAdaptiveKeepStudy: `The creator-adaptive coordinate is a separate known-creator next-upload claim. Its final chronological predictions use the visual and together embeddings plus only that creator’s strictly earlier measured uploads. Equal timestamps are simultaneous batches. Cold start and anonymous upload scoring are explicitly unsupported. Retrospective replay cannot promote without the governed creator sample floor and an immutable prospective registration/result chain.`,
            ledgerOutcomeMatrix: `The single canonical ${coordinateRegistry.columns.length}-coordinate by 13-outcome validation matrix. Coordinates remain in score-ledger order and are never renamed or re-created for a chart.`,
            retentionCurve: 'Observed YouTube retention is interpolated from its native percent-of-duration curve to exact seconds 0 through 20, then divided by that video\'s observed opening value. Forecasts use only nine public axes rebuilt after both validation creators were excluded.',
            coordinateLedger: 'Every displayed scalar is resolved by canonical coordinate ID. A relationship graph is only a score-coordinate/outcome pairing and cannot mint a new score.',
            glossary: {
                rawAssociation: 'Pooled Spearman and pooled AUC are descriptive. For pooled inference, effect, p, and q all use the same within-account centered Spearman or within-account pair-weighted AUC on the same paired population; between-creator level shifts cannot supply inferential evidence.',
                nativePrediction: 'A coordinate receives prediction-error metrics only for the outcome it was registered to predict. The plotted prediction is the exact ledger value after only its registered unit transform.',
                crossOutcome: 'A coordinate paired with any other outcome receives association metrics only. The relationship atlas is forbidden from fitting a new estimator.',
                prequentialTime: 'Uploads are evaluated in chronological order. A prediction may use outcomes from earlier uploads, but the current upload’s outcome becomes available only after its prediction and can enter only later predictions.',
                predictionR2: 'Conventional held-out R-squared: prediction error compared with the variance of the displayed test outcomes. It is distinct from protocol-baseline skill.',
                predictionProtocolBaselineR2: 'MSE skill relative to an explicitly registered upstream protocol baseline. It is null when no such baseline exists.',
                predictionMae: 'Average absolute error of the exact registered prediction in the outcome unit, such as percentage points.',
                predictionMedianFactorError: 'For log-scaled views or outlier outcomes, the median multiplicative miss. 1.0 is perfect; 2.0 means a typical two-fold error.',
                predictionSpearman: 'Rank agreement between exact registered predictions and outcomes. 1 is perfect ordering, 0 is no monotonic ordering, and -1 is reversed.',
                predictionAuc: 'For over-10M classification, the chance that a randomly selected hit receives a higher registered probability than a miss. 0.5 is chance.',
                predictionBrier: 'Mean squared probability error for registered over-10M predictions. Lower is better; zero is perfect.',
                predictionRange: 'The maximum exact ledger prediction minus the minimum. Range ratio divides that span by the observed span. A narrow ratio exposes regression to the mean even when R-squared looks favorable.',
                plotModes: 'Native prediction plots and row tables read the exact score-ledger cell. Cross-outcome plots show raw association only. The browser performs no fold assignment, fit, or recalibration.',
                qValue: `The full eligible ${coordinateRegistry.columns.length}-coordinate by 13-outcome display grid is not treated as independent tests. Global Benjamini-Hochberg adjustment operates on unique predictor-coordinate-axis by governed outcome-family hypotheses. Each q-value adjusts the p-value for the displayed inferentialEffect and inferentialEstimand; pooled descriptive effects never replace it. Diagnostic/in-sample coordinates do not enter the selection family, and stayed-to-watch plus its exact swipe-away complement count once.`,
                outcomeSelection: 'Swipe-away is displayed but aliases stayed-to-watch for selection. Every modeled outcome now has its own eligible population and Ridge fit; lambda selection balances creator-macro loss with a worst-creator penalty instead of allowing creator row counts or sibling outcomes to dominate.',
                promotion: `Promotion fails closed. An artifact must explicitly mark itself promoted, at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} independent creators must contribute at least ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} evaluation rows each, and immutable result plus preregistration bytes must reproduce their declared hashes while locking model, protocol, outcome, and population hashes. Matching 64-character strings alone are not evidence. Predictor ranking also requires an explicit predictor-eligible claim.`,
                creatorAwareUncertainty: 'Video rows measure within-account error but do not create independent creator replications. Content families are collapsed within creator, creators are the inferential units, and an exact creator-level sign-flip p-value is reported only with at least three independent creators.',
                outcomeNotPredictor: 'Twelve independently stored measured-outcome columns stay in the ledger for traceability and are excluded from predictor ranking. Swipe-away remains available only as the governed 100 - keep display transform.',
                coverage: 'Counts are explicit because not every artifact contains every truth field. Blind-only rows add real keep, ret5, and views labels, but never receive fabricated stored scores, average retention, outlier, or retention curves.',
            },
        },
        leakageAudit: {
            passedForBlindInputs: blindFeatureVectorsAligned
                && blindFoldAudit.passed
                && blindFoldAudit
                    .strongDuplicateProtectionPassed
                && publicAxisOverlapAudit.passed,
            coordinateLedgerPassed: ledgerAudit.passed,
            coordinateLedgerVersion: coordinateRegistry.version,
            privateRowsExcludedFromPublicAxis:
                publicAxisOverlapAudit.privateOverlap.length === 0
                && publicAxisOverlapAudit.manifestsComplete,
            savedRowsExcludedFromPublicAxis:
                publicAxisOverlapAudit.savedOverlap.length === 0
                && publicAxisOverlapAudit.manifestsComplete,
            validationCreatorsExcludedFromPublicAxis:
                publicAxisOverlapAudit.validationCreatorOverlap.length === 0
                && publicAxisOverlapAudit.manifestsComplete
                && creatorChannelIdentityAudit.passed,
            validationAccountCount,
            savedDrilldownAccountCount,
            blindFoldAudit,
            validationContentFamilyAudit,
            validationCreatorChannelIdentityAudit:
                creatorChannelIdentityAudit,
            visualKeepForecastProvenanceAudit,
            publicAxisOverlapAudit,
            blindFeatureVectorsAligned,
            requiredFiniteInputRows: finiteInputRows,
            requiredFiniteInputTotal: validationCohort.rows.length,
            allRequiredInputsFinite,
            missingInputPolicy: 'Training-fold mean imputation plus one explicit missingness indicator per coordinate. Complete-case coverage is reported separately.',
            promotionAudits,
            savedAxisCandidateOverlapRemoved: number(predictorProvenance.savedAxisCandidateOverlapRemoved),
            validationCreatorVideoCountExcluded: number(predictorProvenance.validationCreatorVideoCountExcluded),
            validationCreatorChannelIds:
                creatorChannelIdentityAudit
                    .canonicalChannelIds,
            scorerVersionPersistedPerVideo: !!predictorProvenance.featureScorerVersionPersistedPerVideo,
            predictorGeneratedAt: number(predictor.generatedAt),
            featureContractVersion: contract.version,
            warnings: [
                'Tyler stored keep/ret5 values are in-sample because the upload scorer was fit on Tyler labels.',
                'Stored saved-channel rows do not persist an immutable scorer generation, so their 21 values remain diagnostics even when the video ID was excluded later.',
                'Current public views are lifetime snapshots, not fixed-horizon outcomes; publication age can still confound view error.',
                `${validationAccountCount} creator account${validationAccountCount === 1 ? '' : 's'} contribute persisted blind-input truth to the expanded matrix; ${savedDrilldownAccountCount} have joined saved score cards and richer private outcomes. Creator-level confidence is bounded by the former count, while original-card drilldown is bounded by the latter.`,
                'Swipe-away is the exact inverse of stayed-to-watch. It remains visible, shares the feed-decision hypothesis family, and is excluded as a second model-selection vote.',
                `No model is promotion-eligible unless prospectively completed result and preregistration evidence bytes reproduce their declared hashes and at least ${MIN_CONFIRMATORY_ACCOUNT_COUNT} independent creator accounts contribute ${MIN_CONFIRMATORY_ROWS_PER_ACCOUNT} or more evaluation rows each. Historical row count, video-fold performance, caller booleans, synthetic hash strings, or in-sample public calibration cannot substitute for either gate.`,
                'Transfer inference is creator-blocked: content families are collapsed within creator and creators are the inferential units. Exact creator sign-flip p-values require at least three independent creators and remain exploratory until prospective confirmation.',
                validationContentFamilyAudit.warning,
                'The combined forecasts use only nine creator-excluded public views/outlier/10M axes. Private-label-aligned keep, ret5, and realistic-views coordinates remain visible in the single-score matrix but are not stacked into the forecast.',
                'The 20-second curve forecast is evaluated only where the observed video and retention curve reach that second.',
            ].filter(Boolean),
        },
    };
}

module.exports = {
    VERSION,
    LEDGER_VERSION,
    CREATOR_ADAPTIVE_KEEP_MODEL_COORDINATE_ID,
    CREATOR_ADAPTIVE_KEEP_PREQUENTIAL_COORDINATE_ID,
    GOVERNANCE_SHA256: coordinateGovernanceFileSha256(),
    SUPPORTED_CHANNELS,
    contract,
    coordinateGovernance,
    buildValidation,
    regressionMetrics,
    binaryMetrics,
    featureCell,
    buildCoordinateRegistry,
    resolveCoordinateId,
    _nativeOutcomeKey: nativeOutcomeKey,
    _identityCoordinateEvaluation: identityCoordinateEvaluation,
    _rawCoordinateAssociation: rawCoordinateAssociation,
    _crossValidatedMulti: crossValidatedMulti,
    _selectRidgeLambda: selectRidgeLambda,
    _contentFamilyFoldAssignments: contentFamilyFoldAssignments,
    _validationContentFamilyId: validationContentFamilyId,
    _validationContentFamilyEvidence:
        validationContentFamilyEvidence,
    _contentFamilyEvidenceAudit: contentFamilyEvidenceAudit,
    _persistedVisualKeepForecastAudit:
        persistedVisualKeepForecastAudit,
    _blindFoldManifestRows: blindFoldManifestRows,
    _canonicalFitManifestRows: canonicalFitManifestRows,
    _retentionCurveSnapshot: retentionCurveSnapshot,
    _sha256Json: sha256Json,
    _promotionEligibilityAudit: promotionEligibilityAudit,
    _minimumConfirmatoryRowsPerAccount:
        MIN_CONFIRMATORY_ROWS_PER_ACCOUNT,
};
