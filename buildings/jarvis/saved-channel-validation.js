'use strict';

const contract = require('./saved-channel-feature-contract.json');

const VERSION = 2;
const CURVE_SECONDS = Object.freeze(Array.from({ length: 21 }, (_, second) => second));
const SUPPORTED_CHANNELS = Object.freeze([
    { channelId: 'chd3f5a3dae83f3382', accountId: 'tyler', accountName: 'Tyler Csatari' },
    { channelId: 'ch87ccaa3dd3383515', accountId: 'hafu', accountName: 'Hafu Go' },
]);

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = value => finite(value) ? Number(value) : null;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 5) => finite(value) ? Number(Number(value).toFixed(digits)) : null;

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
    { key: 'hit10M', label: 'Reached 10M views', unit: 'binary', accessor: row => row.actual.hit10MCurrent },
    { key: 'survival5', label: 'Retention surviving to 5s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 5), derived: 'observed retention at 5s / observed opening retention x 100' },
    { key: 'survival10', label: 'Retention surviving to 10s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 10), derived: 'observed retention at 10s / observed opening retention x 100' },
    { key: 'survival20', label: 'Retention surviving to 20s', unit: 'percent', accessor: row => curveValue(row, 'normalized', 20), derived: 'observed retention at 20s / observed opening retention x 100' },
    { key: 'drop5', label: 'Observed drop by 5s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 5), derived: 'observed opening retention - observed retention at 5s' },
    { key: 'drop10', label: 'Observed drop by 10s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 10), derived: 'observed opening retention - observed retention at 10s' },
    { key: 'drop20', label: 'Observed drop by 20s', unit: 'percentage_points', accessor: row => curveValue(row, 'drop', 20), derived: 'observed opening retention - observed retention at 20s' },
]);

function transformOutcome(value, definition) {
    if (!finite(value)) return null;
    if (definition && definition.transform === 'log10(views + 1)') return Math.log10(Math.max(0, Number(value)) + 1);
    if (definition && definition.transform === 'log10(value + 1)') return Math.log10(Math.max(0, Number(value)) + 1);
    return Number(value);
}

function transformFeature(value, definition) {
    if (!finite(value)) return null;
    if (definition.unit === 'views') return Math.log10(Math.max(0, Number(value)) + 1);
    if (definition.unit === 'log10_views') return Number(value);
    if (definition.target === 'outlier') return Math.log10(Math.max(0, Number(value)) + 1);
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

function adjustBenjaminiHochberg(items) {
    const eligible = items.filter(item => finite(item.metrics && item.metrics.pValue))
        .sort((left, right) => left.metrics.pValue - right.metrics.pValue);
    let running = 1;
    for (let index = eligible.length - 1; index >= 0; index--) {
        running = Math.min(running, eligible[index].metrics.pValue * eligible.length / (index + 1));
        eligible[index].metrics.qValue = round(running, 8);
    }
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

function matrixFeatureValue(row, definition, index, protocol) {
    if (protocol === 'stored') return transformFeature(row.storedRaw[index], definition);
    if (definition.group === 'novelty') return null;
    const value = blindFeatureValue(row, `${definition.key}.raw`, protocol);
    if (!finite(value)) return null;
    if (definition.target === 'views' || definition.target === 'realviews') return Number(value);
    if (definition.target === 'outlier') return Number(value);
    return Number(value);
}

function associationMetrics(points, outcome, scopeKey) {
    const observed = points.filter(point => finite(point.actual) && finite(point.predicted))
        .map(point => ({
            accountId: point.accountId,
            actual: Number(point.actual),
            predicted: Number(point.predicted),
        }));
    if (observed.length < 3) return { n: observed.length };
    const actual = observed.map(point => point.actual);
    const predicted = observed.map(point => point.predicted);
    const linear = pearson(actual, predicted);
    const rank = spearman(actual, predicted);
    const withinLinear = centeredCorrelation(observed, false);
    const withinRank = centeredCorrelation(observed, true);
    const binary = outcome.unit === 'binary';
    const auc = binary ? rocAuc(actual.map(value => value >= 0.5 ? 1 : 0), predicted) : null;
    const withinAuc = binary ? aucInference(observed, true) : null;
    const selectedAuc = binary && scopeKey === 'pooled' ? withinAuc.auc : auc;
    const primary = binary
        ? (finite(selectedAuc) ? (Number(selectedAuc) - 0.5) * 2 : null)
        : (scopeKey === 'pooled' ? withinRank : rank);
    const inference = binary
        ? aucInference(observed, scopeKey === 'pooled')
        : correlationInference(primary, observed.length);
    return {
        n: observed.length,
        pearson: round(linear),
        spearman: round(rank),
        withinAccountPearson: round(withinLinear),
        withinAccountSpearman: round(withinRank),
        auc: round(auc),
        withinAccountAuc: round(withinAuc && withinAuc.auc),
        aucPairs: binary ? inference.pairs : null,
        primary: round(primary),
        direction: !finite(primary) ? 'unknown' : Number(primary) >= 0 ? 'higher score -> higher outcome' : 'higher score -> lower outcome',
        pValue: inference.p,
        qValue: null,
        ci95: inference.ci95,
        inference: 'Exploratory row-level Fisher-z interval. With only two creators, it is not creator-level population inference.',
    };
}

function evidenceLabel(metrics) {
    if (!metrics || metrics.n < 30 || !finite(metrics.primary)) return 'insufficient';
    const magnitude = Math.abs(Number(metrics.primary));
    if (finite(metrics.qValue) && Number(metrics.qValue) <= 0.05 && magnitude >= 0.15) return 'row_level_signal';
    if ((finite(metrics.qValue) && Number(metrics.qValue) <= 0.1 && magnitude >= 0.1) || magnitude >= 0.2) return 'directional';
    return 'not_supported';
}

function buildOutcomeMatrix(rows, protocol, scopeKey) {
    const matrix = {};
    for (const outcome of OUTCOME_DEFINITIONS) {
        const entries = contract.features.map((definition, index) => {
            const points = rows.map(row => ({
                accountId: row.accountId,
                actual: transformOutcome(outcome.accessor(row), outcome),
                predicted: matrixFeatureValue(row, definition, index, protocol),
            }));
            return {
                key: definition.key,
                group: definition.group,
                target: definition.target,
                label: definition.label,
                unit: definition.unit,
                available: protocol === 'stored' || definition.group !== 'novelty',
                availabilityNote: protocol !== 'stored' && definition.group === 'novelty'
                    ? 'No exact held-out rebuild exists for this stored target-specific novelty score.'
                    : null,
                provenance: contract.provenanceByTarget[
                    definition.group === 'novelty' ? 'novelty' : definition.target
                ] || null,
                metrics: associationMetrics(points, outcome, scopeKey),
            };
        });
        adjustBenjaminiHochberg(entries);
        entries.forEach(entry => { entry.metrics.evidence = evidenceLabel(entry.metrics); });
        entries.sort((left, right) => (
            Math.abs(number(right.metrics.primary) || 0) - Math.abs(number(left.metrics.primary) || 0)
            || left.key.localeCompare(right.key)
        ));
        matrix[outcome.key] = {
            ...Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'accessor')),
            protocol,
            n: rows.filter(row => finite(outcome.accessor(row))).length,
            features: entries,
        };
    }
    return matrix;
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
            checkpointEligible: run.checkpoints.eligible,
            curveEligibleThrough20s: run.curve.eligible,
            scalarFolds: run.scalar.selected,
            checkpointFolds: run.checkpoints.selected,
            curveFolds: run.curve.selected,
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

function buildScope(rows, key) {
    const scoped = key === 'pooled' ? rows : rows.filter(row => row.accountId === key);
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
    return {
        key,
        n: scoped.length,
        accounts: [...new Set(scoped.map(row => row.accountId))],
        joinedCoverage: {
            privateRows: scoped.length,
            storedRows: scoped.filter(row => row.storedRaw.some(finite)).length,
            blindRows: scoped.filter(row => row.blindVideoHeldOut.some(finite)).length,
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
        outcomeMatrix: {
            stored: buildOutcomeMatrix(scoped, 'stored', key),
            video: buildOutcomeMatrix(scoped, 'video', key),
            account: buildOutcomeMatrix(scoped, 'account', key),
        },
        score21Forecasts,
        retentionForecasts,
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
                    hit10MCurrent: finite(saved.views) ? (Number(saved.views) >= 10000000 ? 1 : 0) : null,
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
    const scopes = {
        pooled: buildScope(rows, 'pooled'),
        tyler: buildScope(rows, 'tyler'),
        hafu: buildScope(rows, 'hafu'),
    };
    const predictorProvenance = predictor.provenance || {};
    const privateAxisTrainingIdOverlap = number(predictorProvenance.privateAxisTrainingIdOverlap);
    const savedAxisTrainingIdOverlap = number(predictorProvenance.savedAxisTrainingIdOverlap);
    const validationCreatorAxisTrainingIdOverlap = number(predictorProvenance.validationCreatorAxisTrainingIdOverlap);
    const blindFeatureRowsComplete = rows.length > 0
        && rows.every(row => row.blindVideoHeldOut.length === blindFeatureNames.length)
        && rows.every(row => row.blindAccountHeldOut.length === blindFeatureNames.length);
    const publicAxisLeakageChecksPassed = privateAxisTrainingIdOverlap === 0
        && savedAxisTrainingIdOverlap === 0
        && validationCreatorAxisTrainingIdOverlap === 0;
    return {
        version: VERSION,
        generatedAt,
        sourceFingerprint,
        featureContract: contract,
        channels: SUPPORTED_CHANNELS,
        joinSummary,
        rows,
        scopes,
        score21Model,
        outcomeDefinitions: OUTCOME_DEFINITIONS.map(definition => (
            Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'accessor'))
        )),
        validationContract: {
            stored: 'Exact 21 values persisted by the channel scorer. They are shown for diagnosis, never promoted to blind evidence.',
            videoHeldOut: blindInputs.videoHeldOutProtocol || 'The evaluated video is excluded from every target-aligned fit.',
            accountHeldOut: blindInputs.accountHeldOutProtocol || 'The evaluated account is excluded from every target-aligned fit.',
            publicViewsAxis: 'The production one-component PLS direction and rank-to-outcome calibration are refit on public corpus videos after excluding private rows, saved rows, and every video from each validation creator.',
            forwardTime: 'Training labels precede test labels, but the present-day representation remains fixed; this is a partial backtest.',
            outcomeMatrix: 'Every one of the 21 exact stored upload outputs is compared with every available observed outcome. Blind matrices expose the 18 direct Visual/Text/Both analogs; unavailable novelty rebuilds remain visibly unavailable.',
            retentionCurve: 'Observed YouTube retention is interpolated from its native percent-of-duration curve to exact seconds 0 through 20, then divided by that video\'s observed opening value. Forecasts use only nine public axes rebuilt after both validation creators were excluded.',
        },
        leakageAudit: {
            passedForBlindInputs: blindFeatureRowsComplete && publicAxisLeakageChecksPassed,
            privateRowsExcludedFromPublicAxis: privateAxisTrainingIdOverlap === 0,
            savedRowsExcludedFromPublicAxis: savedAxisTrainingIdOverlap === 0,
            validationCreatorsExcludedFromPublicAxis: validationCreatorAxisTrainingIdOverlap === 0,
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
                'Only two supported channels have both saved embeddings and private keep-rate truth, so pooled uncertainty has two independent creator units.',
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
};
