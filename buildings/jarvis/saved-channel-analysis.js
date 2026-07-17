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

function buildRows(manifest) {
    return (manifest.videos || []).filter(video => video && video.status === 'done' && finite(video.views) && Number(video.views) > 0)
        .map(video => ({ id: video.id, title: video.title || video.id, views: Number(video.views), y: Math.log10(Number(video.views) + 1), video }));
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

function evaluateCandidateRows(rows, candidates) {
    const scored = [];
    for (const keys of candidates) {
        const result = evaluateFeatureSet(rows, keys, 5, 1);
        if (result) scored.push({ keys, ...cleanMetric(result) });
    }
    scored.sort((a, b) => (b.r2 == null ? -Infinity : b.r2) - (a.r2 == null ? -Infinity : a.r2));
    return scored;
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

function analyzeChannel(manifest) {
    const rows = buildRows(manifest || {});
    const keys = contract.features.map(feature => feature.key);
    const generatedAt = Date.now();
    if (rows.length < 8) return {
        version: 1,
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

    return {
        version: 1,
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
    };
}

module.exports = {
    contract,
    featureCell,
    modelFeatureValue,
    pearson,
    spearman,
    evaluateFeatureSet,
    analyzeChannel,
};
