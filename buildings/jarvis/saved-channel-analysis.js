'use strict';

const contract = require('./saved-channel-feature-contract.json');

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

function stableHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function featureCell(video, key) {
    const cell = video && video.features && video.features[key];
    if (Array.isArray(cell)) return { value: finite(cell[0]) ? Number(cell[0]) : null, percentile: finite(cell[1]) ? Number(cell[1]) : null };
    if (cell && typeof cell === 'object') return {
        value: finite(cell.v != null ? cell.v : cell.value) ? Number(cell.v != null ? cell.v : cell.value) : null,
        percentile: finite(cell.p != null ? cell.p : cell.percentile) ? Number(cell.p != null ? cell.p : cell.percentile) : null,
    };
    return { value: null, percentile: null };
}

function modelFeatureValue(video, definition) {
    const cell = featureCell(video, definition.key);
    if (cell.percentile != null) return cell.percentile / 100;
    if (cell.value == null) return null;
    if (definition.unit === 'views') return Math.log10(Math.max(0, cell.value) + 1);
    return cell.value;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(values, probability) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const position = clamp(probability, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position), upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function parsePublished(value) {
    if (value == null || value === '') return null;
    const text = String(value).trim();
    if (/^\d{8}$/.test(text)) {
        const year = Number(text.slice(0, 4)), month = Number(text.slice(4, 6)) - 1, day = Number(text.slice(6, 8));
        const timestamp = Date.UTC(year, month, day);
        return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (finite(value)) {
        const numeric = Number(value);
        const millis = numeric < 1e12 ? numeric * 1000 : numeric;
        return millis > 0 ? millis : null;
    }
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function wilsonInterval(successes, total, z) {
    if (!total) return { low: null, high: null };
    const confidenceZ = finite(z) ? Number(z) : 1.959963984540054;
    const rate = successes / total, z2 = confidenceZ * confidenceZ;
    const denominator = 1 + z2 / total;
    const center = (rate + z2 / (2 * total)) / denominator;
    const margin = confidenceZ * Math.sqrt((rate * (1 - rate) + z2 / (4 * total)) / total) / denominator;
    return { low: clamp(center - margin, 0, 1), high: clamp(center + margin, 0, 1) };
}

function rank(values) {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
    const ranks = new Array(values.length);
    for (let i = 0; i < order.length;) {
        let end = i + 1;
        while (end < order.length && order[end].value === order[i].value) end++;
        const tiedRank = (i + end - 1) / 2;
        for (let j = i; j < end; j++) ranks[order[j].index] = tiedRank;
        i = end;
    }
    return ranks;
}

function pearson(xs, ys) {
    if (!xs || xs.length < 3 || xs.length !== ys.length) return null;
    const mx = average(xs), my = average(ys);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) {
        const ax = xs[i] - mx, ay = ys[i] - my;
        num += ax * ay; dx += ax * ax; dy += ay * ay;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function spearman(xs, ys) {
    return pearson(rank(xs), rank(ys));
}

function solveLinear(matrix, vector) {
    const n = vector.length;
    const augmented = matrix.map((row, i) => row.slice().concat([vector[i]]));
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
        if (Math.abs(augmented[pivot][col]) < 1e-10) augmented[pivot][col] = 1e-10;
        if (pivot !== col) [augmented[pivot], augmented[col]] = [augmented[col], augmented[pivot]];
        const divisor = augmented[col][col];
        for (let j = col; j <= n; j++) augmented[col][j] /= divisor;
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = augmented[row][col];
            if (!factor) continue;
            for (let j = col; j <= n; j++) augmented[row][j] -= factor * augmented[col][j];
        }
    }
    return augmented.map(row => row[n]);
}

function trainModel(rows, keys, lambda) {
    const definitions = keys.map(key => contract.features.find(feature => feature.key === key));
    const columns = definitions.map(definition => rows.map(row => modelFeatureValue(row.video, definition)).filter(finite));
    const medians = columns.map(column => median(column) == null ? 0 : median(column));
    const means = [], scales = [];
    for (let j = 0; j < definitions.length; j++) {
        const filled = rows.map(row => {
            const value = modelFeatureValue(row.video, definitions[j]);
            return finite(value) ? Number(value) : medians[j];
        });
        const mean = average(filled) || 0;
        const variance = average(filled.map(value => (value - mean) ** 2)) || 0;
        means.push(mean); scales.push(Math.sqrt(variance) || 1);
    }
    const width = definitions.length + 1;
    const xtx = Array.from({ length: width }, () => Array(width).fill(0));
    const xty = Array(width).fill(0);
    for (const row of rows) {
        const values = [1];
        for (let j = 0; j < definitions.length; j++) {
            const raw = modelFeatureValue(row.video, definitions[j]);
            values.push(((finite(raw) ? Number(raw) : medians[j]) - means[j]) / scales[j]);
        }
        for (let a = 0; a < width; a++) {
            xty[a] += values[a] * row.y;
            for (let b = 0; b < width; b++) xtx[a][b] += values[a] * values[b];
        }
    }
    const penalty = Number.isFinite(lambda) ? lambda : 1;
    for (let j = 1; j < width; j++) xtx[j][j] += penalty;
    xtx[0][0] += 1e-8;
    return { keys, definitions, medians, means, scales, coefficients: solveLinear(xtx, xty) };
}

function predictModel(model, row) {
    let prediction = model.coefficients[0];
    for (let j = 0; j < model.definitions.length; j++) {
        const raw = modelFeatureValue(row.video, model.definitions[j]);
        const value = finite(raw) ? Number(raw) : model.medians[j];
        prediction += model.coefficients[j + 1] * ((value - model.means[j]) / model.scales[j]);
    }
    return prediction;
}

function foldAssignments(rows, requested) {
    const folds = clamp(Math.min(requested || 5, Math.floor(rows.length / 4)), 2, 5);
    const order = rows.map((row, index) => ({ index, hash: stableHash(row.id) })).sort((a, b) => a.hash - b.hash || a.index - b.index);
    const assignments = new Array(rows.length);
    order.forEach((item, index) => { assignments[item.index] = index % folds; });
    return { folds, assignments };
}

function stratifiedFoldAssignments(rows, requested) {
    const positives = [], negatives = [];
    rows.forEach((row, index) => (row.y >= 0.5 ? positives : negatives).push({ index, hash: stableHash(row.id) }));
    const folds = Math.min(requested || 5, positives.length, negatives.length, Math.max(2, Math.floor(rows.length / 4)));
    if (folds < 2) return null;
    positives.sort((a, b) => a.hash - b.hash || a.index - b.index);
    negatives.sort((a, b) => a.hash - b.hash || a.index - b.index);
    const assignments = new Array(rows.length);
    positives.forEach((item, index) => { assignments[item.index] = index % folds; });
    negatives.forEach((item, index) => { assignments[item.index] = index % folds; });
    return { folds, assignments };
}

function rocAuc(actual, scores) {
    if (!actual.length || actual.length !== scores.length) return null;
    const positives = actual.filter(Boolean).length, negatives = actual.length - positives;
    if (!positives || !negatives) return null;
    const ranked = rank(scores);
    let positiveRankSum = 0;
    actual.forEach((value, index) => { if (value) positiveRankSum += ranked[index]; });
    return (positiveRankSum - positives * (positives - 1) / 2) / (positives * negatives);
}

function averagePrecision(actual, scores) {
    const positives = actual.filter(Boolean).length;
    if (!positives) return null;
    const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score || a.index - b.index);
    let hits = 0, precisionSum = 0;
    order.forEach((item, index) => {
        if (actual[item.index]) { hits++; precisionSum += hits / (index + 1); }
    });
    return precisionSum / positives;
}

function binaryPredictionMetrics(actual, predicted, baseline) {
    if (!actual.length) return { n: 0 };
    const safe = predicted.map(value => clamp(Number(value), 1e-6, 1 - 1e-6));
    const base = (baseline || []).map(value => clamp(Number(value), 1e-6, 1 - 1e-6));
    const brier = average(actual.map((value, index) => (value - safe[index]) ** 2));
    const baselineBrier = base.length ? average(actual.map((value, index) => (value - base[index]) ** 2)) : null;
    const logLoss = -average(actual.map((value, index) => value * Math.log(safe[index]) + (1 - value) * Math.log(1 - safe[index])));
    const calibrationBins = [];
    for (let bin = 0; bin < 10; bin++) {
        const points = safe.map((probability, index) => ({ probability, actual: actual[index] }))
            .filter(point => point.probability >= bin / 10 && (bin === 9 ? point.probability <= 1 : point.probability < (bin + 1) / 10));
        if (!points.length) continue;
        calibrationBins.push({ n: points.length, predicted: average(points.map(point => point.probability)), observed: average(points.map(point => point.actual)) });
    }
    const calibrationError = calibrationBins.reduce((sum, bin) => sum + bin.n / actual.length * Math.abs(bin.predicted - bin.observed), 0);
    return {
        n: actual.length,
        positives: actual.filter(Boolean).length,
        baseRate: average(actual),
        brier,
        baselineBrier,
        brierSkill: baselineBrier > 0 ? 1 - brier / baselineBrier : null,
        logLoss,
        rocAuc: rocAuc(actual, safe),
        prAuc: averagePrecision(actual, safe),
        calibrationError,
        calibrationBins,
    };
}

function trainLogisticModel(rows, keys, lambda) {
    const definitions = keys.map(key => contract.features.find(feature => feature.key === key));
    const columns = definitions.map(definition => rows.map(row => modelFeatureValue(row.video, definition)).filter(finite));
    const medians = columns.map(column => median(column) == null ? 0 : median(column));
    const means = [], scales = [];
    for (let j = 0; j < definitions.length; j++) {
        const filled = rows.map(row => {
            const value = modelFeatureValue(row.video, definitions[j]);
            return finite(value) ? Number(value) : medians[j];
        });
        const mean = average(filled) || 0;
        const variance = average(filled.map(value => (value - mean) ** 2)) || 0;
        means.push(mean); scales.push(Math.sqrt(variance) || 1);
    }
    const design = rows.map(row => [1].concat(definitions.map((definition, index) => {
        const raw = modelFeatureValue(row.video, definition);
        return ((finite(raw) ? Number(raw) : medians[index]) - means[index]) / scales[index];
    })));
    const width = definitions.length + 1, penalty = finite(lambda) ? Number(lambda) : 1;
    const positiveRate = (rows.filter(row => row.y >= 0.5).length + 0.5) / (rows.length + 1);
    const coefficients = Array(width).fill(0);
    coefficients[0] = Math.log(positiveRate / (1 - positiveRate));
    for (let iteration = 0; iteration < 30; iteration++) {
        const hessian = Array.from({ length: width }, () => Array(width).fill(0));
        const gradient = Array(width).fill(0);
        design.forEach((values, rowIndex) => {
            const linear = values.reduce((sum, value, index) => sum + value * coefficients[index], 0);
            const probability = 1 / (1 + Math.exp(-clamp(linear, -30, 30)));
            const weight = Math.max(1e-6, probability * (1 - probability));
            for (let a = 0; a < width; a++) {
                gradient[a] += values[a] * (rows[rowIndex].y - probability);
                for (let b = 0; b < width; b++) hessian[a][b] += values[a] * values[b] * weight;
            }
        });
        for (let index = 1; index < width; index++) {
            hessian[index][index] += penalty;
            gradient[index] -= penalty * coefficients[index];
        }
        hessian[0][0] += 1e-8;
        const delta = solveLinear(hessian, gradient);
        let largest = 0;
        delta.forEach((value, index) => { coefficients[index] += value; largest = Math.max(largest, Math.abs(value)); });
        if (largest < 1e-6) break;
    }
    return { keys, definitions, medians, means, scales, coefficients };
}

function predictLogistic(model, row) {
    let linear = model.coefficients[0];
    for (let index = 0; index < model.definitions.length; index++) {
        const raw = modelFeatureValue(row.video, model.definitions[index]);
        const value = finite(raw) ? Number(raw) : model.medians[index];
        linear += model.coefficients[index + 1] * ((value - model.means[index]) / model.scales[index]);
    }
    return 1 / (1 + Math.exp(-clamp(linear, -30, 30)));
}

function evaluateBinaryFeatureSet(rows, keys, requestedFolds, lambda, logistic) {
    if (rows.length < 8 || !keys.length) return null;
    const assignment = stratifiedFoldAssignments(rows, requestedFolds || 5);
    if (!assignment) return null;
    const actual = [], predicted = [], baseline = [];
    for (let fold = 0; fold < assignment.folds; fold++) {
        const train = rows.filter((_, index) => assignment.assignments[index] !== fold);
        const test = rows.filter((_, index) => assignment.assignments[index] === fold);
        if (!train.length || !test.length) continue;
        const model = logistic ? trainLogisticModel(train, keys, lambda) : trainModel(train, keys, lambda);
        const trainRate = (train.filter(row => row.y >= 0.5).length + 0.5) / (train.length + 1);
        for (const row of test) {
            actual.push(row.y >= 0.5 ? 1 : 0);
            predicted.push(logistic ? predictLogistic(model, row) : clamp(predictModel(model, row), 0.001, 0.999));
            baseline.push(trainRate);
        }
    }
    return { ...binaryPredictionMetrics(actual, predicted, baseline), actual, predicted, baseline };
}

function predictionMetrics(actual, predicted, baseline) {
    if (!actual.length) return { n: 0, r2: null, rmseLog: null, maeLog: null, medianFactor: null, spearman: null };
    const residuals = actual.map((value, index) => value - predicted[index]);
    const sse = residuals.reduce((sum, value) => sum + value * value, 0);
    const baseSse = baseline ? actual.reduce((sum, value, index) => sum + (value - baseline[index]) ** 2, 0)
        : actual.reduce((sum, value) => sum + (value - average(actual)) ** 2, 0);
    return {
        n: actual.length,
        r2: baseSse > 0 ? 1 - sse / baseSse : null,
        rmseLog: Math.sqrt(sse / actual.length),
        maeLog: average(residuals.map(Math.abs)),
        medianFactor: Math.pow(10, median(residuals.map(Math.abs)) || 0),
        spearman: spearman(actual, predicted),
    };
}

function evaluateFeatureSet(rows, keys, requestedFolds, lambda) {
    if (rows.length < 8 || !keys.length) return null;
    const { folds, assignments } = foldAssignments(rows, requestedFolds || 5);
    const actual = [], predicted = [], baseline = [];
    for (let fold = 0; fold < folds; fold++) {
        const train = rows.filter((_, index) => assignments[index] !== fold);
        const test = rows.filter((_, index) => assignments[index] === fold);
        if (!train.length || !test.length) continue;
        const model = trainModel(train, keys, lambda);
        const trainMean = average(train.map(row => row.y));
        for (const row of test) {
            actual.push(row.y);
            predicted.push(predictModel(model, row));
            baseline.push(trainMean);
        }
    }
    return { ...predictionMetrics(actual, predicted, baseline), actual, predicted, baseline };
}

function combinations(values, size) {
    const out = [];
    const walk = (start, chosen) => {
        if (chosen.length === size) { out.push(chosen.slice()); return; }
        for (let i = start; i <= values.length - (size - chosen.length); i++) {
            chosen.push(values[i]); walk(i + 1, chosen); chosen.pop();
        }
    };
    walk(0, []);
    return out;
}

function cleanMetric(metric) {
    if (!metric) return null;
    const round = value => value == null || !finite(value) ? null : Number(Number(value).toFixed(4));
    return {
        n: metric.n,
        r2: round(metric.r2),
        rmseLog: round(metric.rmseLog),
        maeLog: round(metric.maeLog),
        medianFactor: round(metric.medianFactor),
        spearman: round(metric.spearman),
    };
}

function cleanBinaryMetric(metric) {
    if (!metric) return null;
    const round = value => value == null || !finite(value) ? null : Number(Number(value).toFixed(4));
    return {
        n: metric.n,
        positives: metric.positives,
        baseRate: round(metric.baseRate),
        brier: round(metric.brier),
        baselineBrier: round(metric.baselineBrier),
        brierSkill: round(metric.brierSkill),
        logLoss: round(metric.logLoss),
        rocAuc: round(metric.rocAuc),
        prAuc: round(metric.prAuc),
        calibrationError: round(metric.calibrationError),
        calibrationBins: (metric.calibrationBins || []).map(bin => ({ n: bin.n, predicted: round(bin.predicted), observed: round(bin.observed) })),
    };
}

function buildRows(manifest, observedAt) {
    const now = finite(observedAt) ? Number(observedAt) : Date.now();
    return (manifest.videos || []).filter(video => video && video.status === 'done' && finite(video.views) && Number(video.views) > 0)
        .map(video => {
            const publishedAt = parsePublished(video.publishedAt != null ? video.publishedAt : video.published);
            const viewsObservedAt = finite(video.viewsObservedAt) ? Number(video.viewsObservedAt) : (finite(video.scoredAt) ? Number(video.scoredAt) : now);
            const ageDays = publishedAt != null && viewsObservedAt >= publishedAt ? (viewsObservedAt - publishedAt) / 86400000 : null;
            const viewsHistory = (video.viewsHistory || []).filter(point => point && finite(point.at) && finite(point.views))
                .map(point => ({ at: Number(point.at), views: Number(point.views) })).sort((a, b) => a.at - b.at);
            return {
                id: video.id,
                title: video.title || video.id,
                views: Number(video.views),
                y: Math.log10(Number(video.views) + 1),
                publishedAt,
                viewsObservedAt,
                ageDays,
                viewsHistory,
                video,
            };
        });
}

function directFeatureStats(rows, definition) {
    const observed = rows.map(row => ({ x: modelFeatureValue(row.video, definition), yLog: row.y, yRaw: row.views })).filter(point => finite(point.x));
    const xs = observed.map(point => Number(point.x));
    return {
        available: observed.length,
        coverage: rows.length ? observed.length / rows.length : 0,
        pearsonLogViews: pearson(xs, observed.map(point => point.yLog)),
        pearsonRawViews: pearson(xs, observed.map(point => point.yRaw)),
        spearmanViews: spearman(xs, observed.map(point => point.yRaw)),
    };
}

function directBinaryFeatureStats(rows, definition, targetViews) {
    const observed = rows.map(row => ({ score: modelFeatureValue(row.video, definition), hit: row.views >= targetViews }))
        .filter(point => finite(point.score));
    const scores = observed.map(point => Number(point.score)), actual = observed.map(point => point.hit ? 1 : 0);
    const higherAuc = rocAuc(actual, scores);
    const direction = higherAuc != null && higherAuc < 0.5 ? 'lower' : 'higher';
    const orientedScores = direction === 'lower' ? scores.map(value => -value) : scores;
    const ordered = orientedScores.map((score, index) => ({ score, hit: actual[index] })).sort((a, b) => b.score - a.score);
    const topCount = Math.max(1, Math.ceil(ordered.length * 0.1));
    const top = ordered.slice(0, topCount), topHits = top.filter(point => point.hit).length;
    const interval = wilsonInterval(topHits, top.length);
    const baseRate = actual.length ? average(actual) : null;
    return {
        key: definition.key,
        group: definition.group,
        label: definition.label,
        available: observed.length,
        coverage: rows.length ? observed.length / rows.length : 0,
        direction,
        rocAucHigher: higherAuc,
        directionalAuc: higherAuc == null ? null : Math.max(higherAuc, 1 - higherAuc),
        prAuc: averagePrecision(actual, orientedScores),
        topDecile: {
            n: top.length,
            hits: topHits,
            hitRate: top.length ? topHits / top.length : null,
            ciLow: interval.low,
            ciHigh: interval.high,
            lift: baseRate > 0 && top.length ? (topHits / top.length) / baseRate : null,
        },
    };
}

function rawFeatureValue(video, definition) {
    const cell = featureCell(video, definition.key);
    return cell.value != null && finite(cell.value) ? Number(cell.value) : null;
}

function thresholdCandidates(values) {
    const fixed = [100000, 300000, 1000000, 3000000, 10000000, 20000000, 30000000, 50000000, 100000000];
    const empirical = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map(probability => quantile(values, probability));
    const unique = new Map();
    fixed.concat(empirical).filter(finite).forEach(value => {
        const numeric = Math.max(0, Number(value));
        const key = numeric >= 100000 ? Math.round(numeric / 10000) * 10000 : Number(numeric.toPrecision(6));
        unique.set(key, key);
    });
    return Array.from(unique.values()).sort((a, b) => a - b);
}

function thresholdRisk(rows, definition, targetViews) {
    const observed = rows.map(row => ({ score: rawFeatureValue(row.video, definition), views: row.views, hit: row.views >= targetViews }))
        .filter(point => finite(point.score));
    const scores = observed.map(point => point.score), totalHits = observed.filter(point => point.hit).length;
    const baseRate = observed.length ? totalHits / observed.length : null;
    const thresholds = thresholdCandidates(scores).map(threshold => {
        const passed = observed.filter(point => point.score >= threshold);
        const hits = passed.filter(point => point.hit).length;
        const interval = wilsonInterval(hits, passed.length);
        const actualViews = passed.map(point => point.views);
        return {
            threshold,
            n: passed.length,
            passRate: observed.length ? passed.length / observed.length : null,
            hits,
            misses: passed.length - hits,
            hitRate: passed.length ? hits / passed.length : null,
            ciLow: interval.low,
            ciHigh: interval.high,
            lift: baseRate > 0 && passed.length ? (hits / passed.length) / baseRate : null,
            recall: totalHits ? hits / totalHits : null,
            actualViewsP10: quantile(actualViews, 0.1),
            actualViewsP25: quantile(actualViews, 0.25),
            actualViewsMedian: median(actualViews),
            actualViewsP75: quantile(actualViews, 0.75),
        };
    });
    const evidenceMinimum = Math.max(5, Math.ceil(observed.length * 0.05));
    const bestEvidence = thresholds.filter(row => row.n >= evidenceMinimum && row.ciLow != null)
        .sort((a, b) => b.ciLow - a.ciLow || b.hitRate - a.hitRate || b.n - a.n)[0] || null;
    const calibrationBins = [];
    const sorted = observed.slice().sort((a, b) => a.score - b.score);
    const binCount = Math.min(10, Math.max(2, Math.floor(Math.sqrt(sorted.length))));
    for (let bin = 0; bin < binCount; bin++) {
        const start = Math.floor(bin * sorted.length / binCount), end = Math.floor((bin + 1) * sorted.length / binCount);
        const points = sorted.slice(start, end);
        if (!points.length) continue;
        const hits = points.filter(point => point.hit).length, interval = wilsonInterval(hits, points.length);
        calibrationBins.push({
            n: points.length,
            scoreMedian: median(points.map(point => point.score)),
            actualViewsMedian: median(points.map(point => point.views)),
            hitRate: hits / points.length,
            ciLow: interval.low,
            ciHigh: interval.high,
        });
    }
    return {
        key: definition.key,
        label: `${definition.group === 'together' ? 'Both' : definition.group} · ${definition.label}`,
        available: observed.length,
        baseRate,
        thresholds,
        calibrationBins,
        bestEvidence,
    };
}

function evaluateCandidateRows(rows, candidates) {
    const scored = [];
    for (const keys of candidates) {
        const result = evaluateFeatureSet(rows, keys, 5, 1);
        if (result) scored.push({ keys, ...cleanMetric(result) });
    }
    scored.sort((a, b) => (b.r2 == null ? -Infinity : b.r2) - (a.r2 == null ? -Infinity : a.r2));
    return scored;
}

function evaluateBinaryCandidateRows(rows, candidates) {
    const scored = [];
    for (const keys of candidates) {
        const result = evaluateBinaryFeatureSet(rows, keys, 5, 1, false);
        if (result) scored.push({ keys, ...cleanBinaryMetric(result) });
    }
    scored.sort((a, b) => (b.brierSkill == null ? -Infinity : b.brierSkill) - (a.brierSkill == null ? -Infinity : a.brierSkill)
        || (b.prAuc == null ? -Infinity : b.prAuc) - (a.prAuc == null ? -Infinity : a.prAuc)
        || a.keys.length - b.keys.length);
    return scored;
}

function probabilityFeatureCalibration(rows, definition, targetViews) {
    const observed = rows.map(row => ({ probability: rawFeatureValue(row.video, definition), actual: row.views >= targetViews ? 1 : 0 }))
        .filter(point => finite(point.probability));
    if (!observed.length) return { key: definition.key, available: 0, metrics: null };
    const baseRate = average(observed.map(point => point.actual));
    return {
        key: definition.key,
        available: observed.length,
        metrics: cleanBinaryMetric(binaryPredictionMetrics(
            observed.map(point => point.actual),
            observed.map(point => clamp(Number(point.probability), 0.001, 0.999)),
            observed.map(() => clamp(baseRate, 0.001, 0.999)),
        )),
    };
}

function forwardPath(rows, keys) {
    const selected = [], remaining = keys.slice(), path = [];
    while (remaining.length) {
        let best = null;
        for (const key of remaining) {
            const candidate = selected.concat([key]);
            const result = evaluateFeatureSet(rows, candidate, 5, 1);
            if (!result) continue;
            if (!best || (result.r2 == null ? -Infinity : result.r2) > (best.result.r2 == null ? -Infinity : best.result.r2)) best = { key, candidate, result };
        }
        if (!best) break;
        selected.push(best.key);
        remaining.splice(remaining.indexOf(best.key), 1);
        path.push({ size: selected.length, added: best.key, keys: selected.slice(), ...cleanMetric(best.result) });
    }
    return path;
}

function nestedSelection(rows, candidates) {
    if (rows.length < 12 || !candidates.length) return null;
    const { folds, assignments } = foldAssignments(rows, 5);
    const actual = [], predicted = [], baseline = [], chosen = {};
    const points = [];
    for (let fold = 0; fold < folds; fold++) {
        const train = rows.filter((_, index) => assignments[index] !== fold);
        const test = rows.filter((_, index) => assignments[index] === fold);
        let best = null;
        for (const keys of candidates) {
            const metric = evaluateFeatureSet(train, keys, 3, 1);
            if (!metric) continue;
            if (!best || (metric.r2 == null ? -Infinity : metric.r2) > (best.metric.r2 == null ? -Infinity : best.metric.r2)) best = { keys, metric };
        }
        if (!best) continue;
        const label = best.keys.join(' + ');
        chosen[label] = (chosen[label] || 0) + 1;
        const model = trainModel(train, best.keys, 1);
        const trainMean = average(train.map(row => row.y));
        for (const row of test) {
            const prediction = predictModel(model, row);
            actual.push(row.y); predicted.push(prediction); baseline.push(trainMean);
            points.push({ id: row.id, title: row.title, actualViews: row.views, predictedViews: Math.max(0, Math.round(Math.pow(10, prediction) - 1)), actualLog: row.y, predictedLog: prediction });
        }
    }
    const metric = predictionMetrics(actual, predicted, baseline);
    return {
        ...cleanMetric(metric),
        selections: Object.entries(chosen).map(([features, count]) => ({ features: features.split(' + '), folds: count })).sort((a, b) => b.folds - a.folds),
        points: points.sort((a, b) => b.actualViews - a.actualViews),
    };
}

function nestedBinarySelection(rows, candidates) {
    if (rows.length < 12 || !candidates.length) return null;
    const assignment = stratifiedFoldAssignments(rows, 5);
    if (!assignment) return null;
    const actual = [], predicted = [], baseline = [], chosen = {}, points = [];
    for (let fold = 0; fold < assignment.folds; fold++) {
        const train = rows.filter((_, index) => assignment.assignments[index] !== fold);
        const test = rows.filter((_, index) => assignment.assignments[index] === fold);
        let best = null;
        for (const keys of candidates) {
            const metric = evaluateBinaryFeatureSet(train, keys, 3, 1, false);
            if (!metric) continue;
            const score = metric.brierSkill == null ? -Infinity : metric.brierSkill;
            if (!best || score > best.score || (score === best.score && keys.length < best.keys.length)) best = { keys, score };
        }
        if (!best) continue;
        const label = best.keys.join(' + ');
        chosen[label] = (chosen[label] || 0) + 1;
        const model = trainLogisticModel(train, best.keys, 1);
        const trainRate = (train.filter(row => row.y >= 0.5).length + 0.5) / (train.length + 1);
        for (const row of test) {
            const probability = predictLogistic(model, row), hit = row.y >= 0.5 ? 1 : 0;
            actual.push(hit); predicted.push(probability); baseline.push(trainRate);
            points.push({ id: row.id, title: row.title, actualViews: row.views, hit, probability });
        }
    }
    const metric = binaryPredictionMetrics(actual, predicted, baseline);
    return {
        ...cleanBinaryMetric(metric),
        selections: Object.entries(chosen).map(([features, count]) => ({ features: features.split(' + '), folds: count })).sort((a, b) => b.folds - a.folds),
        points: points.sort((a, b) => b.probability - a.probability),
    };
}

function chronologicalBinarySelection(rows, candidates) {
    const dated = rows.filter(row => finite(row.publishedAt)).sort((a, b) => a.publishedAt - b.publishedAt || stableHash(a.id) - stableHash(b.id));
    if (dated.length < 20) return null;
    const split = Math.max(12, Math.min(dated.length - 6, Math.floor(dated.length * 0.7)));
    const train = dated.slice(0, split), test = dated.slice(split);
    if (train.filter(row => row.y >= 0.5).length < 2 || train.filter(row => row.y < 0.5).length < 2
        || !test.some(row => row.y >= 0.5) || !test.some(row => row.y < 0.5)) return null;
    let best = null;
    for (const keys of candidates) {
        const metric = evaluateBinaryFeatureSet(train, keys, 4, 1, false);
        if (!metric) continue;
        const score = metric.brierSkill == null ? -Infinity : metric.brierSkill;
        if (!best || score > best.score || (score === best.score && keys.length < best.keys.length)) best = { keys, score };
    }
    if (!best) return null;
    const model = trainLogisticModel(train, best.keys, 1);
    const trainRate = (train.filter(row => row.y >= 0.5).length + 0.5) / (train.length + 1);
    const actual = test.map(row => row.y >= 0.5 ? 1 : 0), predicted = test.map(row => predictLogistic(model, row));
    const metric = binaryPredictionMetrics(actual, predicted, test.map(() => trainRate));
    return {
        ...cleanBinaryMetric(metric),
        features: best.keys,
        trainN: train.length,
        testN: test.length,
        trainThrough: train[train.length - 1].publishedAt,
        testFrom: test[0].publishedAt,
        points: test.map((row, index) => ({ id: row.id, title: row.title, actualViews: row.views, hit: actual[index], probability: predicted[index] }))
            .sort((a, b) => b.probability - a.probability),
    };
}

function targetRisk(rows, targetViews) {
    const ageMinimums = [0, 7, 30, 90, 180, 365];
    const viewsDefinitions = contract.features.filter(definition => definition.unit === 'views');
    const cohorts = ageMinimums.map(minAgeDays => {
        const cohortRows = minAgeDays ? rows.filter(row => row.ageDays != null && row.ageDays >= minAgeDays) : rows;
        const positives = cohortRows.filter(row => row.views >= targetViews).length;
        return {
            minAgeDays,
            n: cohortRows.length,
            knownAge: cohortRows.filter(row => row.ageDays != null).length,
            positives,
            baseRate: cohortRows.length ? positives / cohortRows.length : null,
            featureRankings: contract.features.map(definition => directBinaryFeatureStats(cohortRows, definition, targetViews))
                .sort((a, b) => (b.directionalAuc == null ? -Infinity : b.directionalAuc) - (a.directionalAuc == null ? -Infinity : a.directionalAuc)),
            viewsSignals: viewsDefinitions.map(definition => thresholdRisk(cohortRows, definition, targetViews)),
        };
    });
    return { targetViews, cohorts };
}

function savedChannelAnalysisFingerprint(manifest) {
    const rows = (manifest && manifest.videos || []).map(video => {
        const features = video.features || {};
        const featureState = Object.keys(features).sort().map(key => `${key}=${JSON.stringify(features[key])}`).join('|');
        return [
            video.id,
            video.status,
            video.views,
            video.viewsObservedAt,
            video.publishedAt != null ? video.publishedAt : video.published,
            video.scoredAt,
            stableHash(featureState).toString(16),
            stableHash(JSON.stringify(video.viewsHistory || [])).toString(16),
        ].join(':');
    }).sort();
    return `v2:${stableHash(rows.join('|')).toString(16)}:${rows.length}`;
}

function analyzeChannel(manifest) {
    const generatedAt = Date.now();
    const rows = buildRows(manifest || {}, generatedAt);
    const keys = contract.features.map(feature => feature.key);
    if (rows.length < 8) return {
        version: 2,
        generatedAt,
        channelId: manifest && manifest.id,
        n: rows.length,
        featureContract: contract,
        status: 'insufficient',
        message: 'At least 8 scored Shorts with public view counts are required for held-out analysis.',
    };

    const singles = contract.features.map(definition => {
        const direct = directFeatureStats(rows, definition);
        const oof = evaluateFeatureSet(rows, [definition.key], 5, 1);
        return { key: definition.key, group: definition.group, label: definition.label, ...direct, oof: cleanMetric(oof) };
    }).sort((a, b) => ((b.oof && b.oof.r2) == null ? -Infinity : b.oof.r2) - ((a.oof && a.oof.r2) == null ? -Infinity : a.oof.r2));

    const candidates = combinations(keys, 1).concat(combinations(keys, 2), combinations(keys, 3));
    const candidateScores = evaluateCandidateRows(rows, candidates);
    const path = forwardPath(rows, keys);
    const nestedCandidates = candidates.concat(path.map(step => step.keys).filter(stepKeys => stepKeys.length > 3));
    const nested = nestedSelection(rows, nestedCandidates);
    const allIndicators = cleanMetric(evaluateFeatureSet(rows, keys, 5, 1));
    const baselineLog = average(rows.map(row => row.y));
    const primaryRiskTarget = 10000000;
    const riskTargetValues = [100000, 300000, 1000000, 3000000, 10000000, 30000000, 50000000, 100000000];
    const riskTargets = riskTargetValues.map(targetViews => targetRisk(rows, targetViews));
    const riskRows = rows.map(row => ({ ...row, y: row.views >= primaryRiskTarget ? 1 : 0 }));
    const riskPositives = riskRows.filter(row => row.y >= 0.5).length, riskNegatives = riskRows.length - riskPositives;
    let riskCandidateScores = [], riskNested = null, riskAll = null, riskChronological = null;
    if (riskPositives >= 3 && riskNegatives >= 3) {
        riskCandidateScores = evaluateBinaryCandidateRows(riskRows, candidates);
        riskNested = nestedBinarySelection(riskRows, candidates);
        riskAll = cleanBinaryMetric(evaluateBinaryFeatureSet(riskRows, keys, 5, 1, true));
        riskChronological = chronologicalBinarySelection(riskRows, candidates);
    }
    const datedRows = rows.filter(row => row.ageDays != null && row.ageDays > 0);
    const historyRows = rows.map(row => {
        const history = row.viewsHistory || [];
        if (history.length < 2) return null;
        const first = history[0], last = history[history.length - 1], spanDays = (last.at - first.at) / 86400000;
        if (!(spanDays > 0)) return null;
        return { spanDays, growthFactor: (last.views + 1) / (first.views + 1) };
    }).filter(Boolean);
    const viewAgeCorrelation = datedRows.length >= 3
        ? pearson(datedRows.map(row => Math.log10(row.ageDays + 1)), datedRows.map(row => row.y)) : null;

    return {
        version: 2,
        generatedAt,
        channelId: manifest && manifest.id,
        channelName: manifest && manifest.name,
        status: 'ready',
        n: rows.length,
        transcriptCoverage: rows.filter(row => !row.video.silent).length / rows.length,
        featureContract: contract,
        outcome: {
            primary: 'log10(raw YouTube views + 1)',
            secondary: 'raw YouTube views',
            baselineViews: Math.round(Math.pow(10, baselineLog) - 1),
            validation: 'Deterministic out-of-fold predictions; preprocessing is fit inside each training fold.',
        },
        search: {
            exhaustiveThroughSize: 3,
            exhaustiveCandidates: candidates.length,
            theoreticalAllSubsets: Math.pow(2, keys.length) - 1,
            forwardPathModels: path.length,
            note: 'Singles, pairs, and triples are exhaustive. Larger sets use a deterministic forward path plus an all-21 ridge model; the nested-selected score is the selection-safe headline.',
        },
        singles,
        topCombinations: candidateScores.slice(0, 30),
        bestBySize: [1, 2, 3].map(size => candidateScores.find(row => row.keys.length === size)).filter(Boolean),
        forwardPath: path,
        models: {
            nestedSelected: nested,
            allIndicators,
            bestExploratory: candidateScores[0] || null,
        },
        risk: {
            primaryTargetViews: primaryRiskTarget,
            targetOptions: riskTargetValues,
            targets: riskTargets,
            viewAgeConfound: {
                knownAge: datedRows.length,
                total: rows.length,
                pearsonLogAgeToLogViews: viewAgeCorrelation == null ? null : Number(viewAgeCorrelation.toFixed(4)),
                note: 'Public views are a cumulative snapshot. Minimum-age cohorts keep young, right-censored Shorts from being silently compared with mature Shorts.',
            },
            viewHistory: {
                videosWithMultipleSnapshots: historyRows.length,
                total: rows.length,
                medianSpanDays: historyRows.length ? Number(median(historyRows.map(row => row.spanDays)).toFixed(2)) : null,
                medianGrowthFactor: historyRows.length ? Number(median(historyRows.map(row => row.growthFactor)).toFixed(3)) : null,
                note: 'Each channel refresh appends a bounded public-view snapshot. Multiple snapshots enable future score-at-time-T versus later-outcome validation.',
            },
            model: {
                status: riskPositives >= 3 && riskNegatives >= 3 ? 'ready' : 'insufficient',
                targetViews: primaryRiskTarget,
                positives: riskPositives,
                negatives: riskNegatives,
                exhaustiveCandidates: candidates.length,
                validation: 'Tail probabilities are predicted out of fold. Combination selection happens inside each training fold; the chronological test trains on older Shorts and evaluates only newer Shorts.',
                nestedSelected: riskNested,
                allIndicators: riskAll,
                chronological: riskChronological,
                topCombinations: riskCandidateScores.slice(0, 30),
            },
            probabilityCalibration: contract.features.filter(definition => definition.target === 'gt10M')
                .map(definition => probabilityFeatureCalibration(rows, definition, primaryRiskTarget)),
        },
    };
}

module.exports = {
    contract,
    featureCell,
    modelFeatureValue,
    pearson,
    spearman,
    evaluateFeatureSet,
    evaluateBinaryFeatureSet,
    wilsonInterval,
    savedChannelAnalysisFingerprint,
    analyzeChannel,
};
