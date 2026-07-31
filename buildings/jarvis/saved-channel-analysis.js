'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contract = require('./saved-channel-feature-contract.json');
const {
    FEATURE_CONTRACT_BYTES,
    GOVERNANCE_BYTES,
    sha256Canonical,
    scoreFeatureCell,
    scoreLedgerValidationSummary,
    validateScoreLedger,
    validateShortsInputManifest,
} = require('./shorts-score-ledger');
const {
    CANONICAL_EVIDENCE_STATE,
    HISTORICAL_EVIDENCE_STATE,
    validateManifestRowBinding,
} = require('./saved-channel-manifest-binding');
const VERSION = 12;
const ANALYSIS_IMPLEMENTATION_SHA256 = (() => {
    const hash = crypto.createHash('sha256');
    for (const source of [
        fs.readFileSync(__filename),
        fs.readFileSync(path.join(__dirname, 'shorts-score-ledger.js')),
        fs.readFileSync(path.join(
            __dirname,
            'saved-channel-manifest-binding.js'
        )),
        FEATURE_CONTRACT_BYTES,
        GOVERNANCE_BYTES,
    ]) {
        hash.update(source);
        hash.update('\0');
    }
    return hash.digest('hex');
})();

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

function sha256Text(value) {
    return crypto.createHash('sha256')
        .update(String(value || ''))
        .digest('hex');
}

function featureCell(video, key) {
    const cell = scoreFeatureCell(video, key);
    return {
        value: cell.value,
        percentile: cell.percentile,
    };
}

function modelFeatureValue(video, definition) {
    const cell = featureCell(video, definition.key);
    if (cell.value == null) return null;
    if (definition.unit === 'views') return Math.log10(Math.max(0, cell.value) + 1);
    return Number(cell.value);
}

function canonicalFeatureCells(video) {
    const validation = validateScoreLedger(
        video && video.score_ledger
    );
    if (!validation.valid) return {};
    return Object.fromEntries(contract.features.map(definition => {
        const coordinateId = `shorts.stored.${definition.key}`;
        const entry = validation.entriesById.get(coordinateId);
        return [
            definition.key,
            entry && entry.available === true
                ? {
                    value: Number(entry.value),
                    percentile:
                        finite(entry.percentile)
                            ? Number(entry.percentile)
                            : null,
                }
                : { value: null, percentile: null },
        ];
    }));
}

function rowFeatureCell(row, definition) {
    const cell = row && row.canonicalFeatureCells
        && row.canonicalFeatureCells[definition.key];
    return cell || { value: null, percentile: null };
}

function rowFeatureValue(row, definition) {
    const cell = rowFeatureCell(row, definition);
    if (cell.value == null) return null;
    if (definition.unit === 'views') {
        return Math.log10(Math.max(0, cell.value) + 1);
    }
    return Number(cell.value);
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

function fixedHorizonViewOutcome(video, publishedAt) {
    const record = video && (
        video.fixedHorizonOutcome
        || video.fixed_horizon_outcome
    );
    if (!record || typeof record !== 'object' || publishedAt == null) {
        return null;
    }
    const views = record.views;
    const horizonDays = (
        record.horizonDays != null
            ? record.horizonDays
            : record.horizon_days
    );
    const observedAt = parsePublished(
        record.observedAt != null
            ? record.observedAt
            : record.observed_at
    );
    if (
        !finite(views)
        || Number(views) <= 0
        || !finite(horizonDays)
        || Number(horizonDays) <= 0
        || observedAt == null
    ) {
        return null;
    }
    const expectedAt = publishedAt + Number(horizonDays) * 86400000;
    const toleranceMs = 36 * 3600000;
    if (Math.abs(observedAt - expectedAt) > toleranceMs) return null;
    return {
        views: Number(views),
        horizonDays: Number(horizonDays),
        observedAt,
        expectedAt,
        timestampToleranceHours: toleranceMs / 3600000,
    };
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
    const columns = definitions.map(definition => rows.map(row => rowFeatureValue(row, definition)).filter(finite));
    const medians = columns.map(column => median(column) == null ? 0 : median(column));
    const means = [], scales = [];
    for (let j = 0; j < definitions.length; j++) {
        const filled = rows.map(row => {
            const value = rowFeatureValue(row, definitions[j]);
            return finite(value) ? Number(value) : medians[j];
        });
        const mean = average(filled) || 0;
        const variance = average(filled.map(value => (value - mean) ** 2)) || 0;
        means.push(mean); scales.push(Math.sqrt(variance) || 1);
    }
    const width = definitions.length * 2 + 1;
    const xtx = Array.from({ length: width }, () => Array(width).fill(0));
    const xty = Array(width).fill(0);
    for (const row of rows) {
        const values = [1];
        for (let j = 0; j < definitions.length; j++) {
            const raw = rowFeatureValue(row, definitions[j]);
            values.push(((finite(raw) ? Number(raw) : medians[j]) - means[j]) / scales[j]);
        }
        for (let j = 0; j < definitions.length; j++) {
            values.push(
                finite(rowFeatureValue(row, definitions[j]))
                    ? 0
                    : 1
            );
        }
        for (let a = 0; a < width; a++) {
            xty[a] += values[a] * row.y;
            for (let b = 0; b < width; b++) xtx[a][b] += values[a] * values[b];
        }
    }
    const penalty = Number.isFinite(lambda) ? lambda : 1;
    for (let j = 1; j < width; j++) xtx[j][j] += penalty;
    xtx[0][0] += 1e-8;
    return {
        keys,
        definitions,
        medians,
        means,
        scales,
        coefficients: solveLinear(xtx, xty),
        missingnessIndicators: true,
    };
}

function predictModel(model, row) {
    let prediction = model.coefficients[0];
    for (let j = 0; j < model.definitions.length; j++) {
        const raw = rowFeatureValue(row, model.definitions[j]);
        const value = finite(raw) ? Number(raw) : model.medians[j];
        prediction += model.coefficients[j + 1] * ((value - model.means[j]) / model.scales[j]);
    }
    for (let j = 0; j < model.definitions.length; j++) {
        const raw = rowFeatureValue(row, model.definitions[j]);
        prediction += model.coefficients[
            1 + model.definitions.length + j
        ] * (finite(raw) ? 0 : 1);
    }
    return prediction;
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

function contentFamilyId(row) {
    const video = row && row.video || {};
    for (const value of [
        row && row.contentFamilyId,
        row && row.content_family_id,
        row && row.sourceContentId,
        row && row.source_content_id,
        row && row.originalContentId,
        row && row.original_content_id,
        video.contentFamilyId,
        video.content_family_id,
        video.sourceContentId,
        video.source_content_id,
        video.originalContentId,
        video.original_content_id,
    ]) {
        if (value != null && String(value).trim()) {
            return `source:${String(value).trim().toLowerCase()}`;
        }
    }
    for (const value of [
        row && row.perceptualHash,
        row && row.perceptual_hash,
        video.perceptualHash,
        video.perceptual_hash,
    ]) {
        if (value != null && String(value).trim()) {
            return `perceptual:${String(value).trim().toLowerCase()}`;
        }
    }
    const title = normalizedContentText(
        row && row.title != null ? row.title : video.title
    );
    if (title) return `title:${title}`;
    for (const value of [
        row && row.montageSha256,
        row && row.montage_sha256,
        row && row.inputManifest
            && row.inputManifest.canonical_montage
            && row.inputManifest.canonical_montage.montage_sha256,
        video.montageSha256,
        video.montage_sha256,
        video.input_manifest
            && video.input_manifest.canonical_montage
            && video.input_manifest.canonical_montage.montage_sha256,
    ]) {
        if (value != null && String(value).trim()) {
            return `montage:${String(value).trim().toLowerCase()}`;
        }
    }
    return `video:${row && row.id || ''}`;
}

function purgeContentFamilyOverlap(trainRows, testRows) {
    const heldOutFamilies = new Set(
        (testRows || []).map(contentFamilyId)
    );
    const retained = (trainRows || []).filter(
        row => !heldOutFamilies.has(contentFamilyId(row))
    );
    return {
        rows: retained,
        audit: {
            trainBefore: (trainRows || []).length,
            trainAfter: retained.length,
            purged: (trainRows || []).length - retained.length,
            heldOutFamilies: heldOutFamilies.size,
            rule: 'No content family may occur in both training and evaluation rows.',
        },
    };
}

function contentFamilyGroups(rows) {
    const byFamily = new Map();
    rows.forEach((row, index) => {
        const familyId = contentFamilyId(row);
        if (!byFamily.has(familyId)) {
            byFamily.set(familyId, {
                familyId,
                indices: [],
                positives: 0,
                negatives: 0,
                hash: stableHash(familyId),
            });
        }
        const group = byFamily.get(familyId);
        group.indices.push(index);
        if (row.y >= 0.5) group.positives++;
        else group.negatives++;
    });
    return [...byFamily.values()];
}

function foldAssignments(rows, requested) {
    const groups = contentFamilyGroups(rows);
    const folds = Math.min(
        requested || 5,
        Math.floor(rows.length / 4),
        groups.length,
        5
    );
    if (folds < 2) {
        return {
            folds: 0,
            assignments: new Array(rows.length).fill(null),
            contentFamilies: groups.length,
        };
    }
    const order = groups.sort(
        (a, b) => b.indices.length - a.indices.length
            || a.hash - b.hash
            || a.familyId.localeCompare(b.familyId)
    );
    const assignments = new Array(rows.length);
    const foldSizes = Array(folds).fill(0);
    order.forEach(group => {
        let selected = 0;
        for (let fold = 1; fold < folds; fold++) {
            if (foldSizes[fold] < foldSizes[selected]) selected = fold;
        }
        group.indices.forEach(index => { assignments[index] = selected; });
        foldSizes[selected] += group.indices.length;
    });
    return {
        folds,
        assignments,
        contentFamilies: groups.length,
    };
}

function stratifiedFoldAssignments(rows, requested) {
    const groups = contentFamilyGroups(rows);
    const positiveFamilies = groups.filter(
        group => group.positives > 0
    ).length;
    const negativeFamilies = groups.filter(
        group => group.negatives > 0
    ).length;
    const maximumFolds = Math.min(
        requested || 5,
        positiveFamilies,
        negativeFamilies,
        groups.length,
        Math.max(2, Math.floor(rows.length / 4))
    );
    if (maximumFolds < 2) return null;
    const totalPositives = groups.reduce(
        (sum, group) => sum + group.positives,
        0
    );
    const totalNegatives = groups.reduce(
        (sum, group) => sum + group.negatives,
        0
    );
    const orderedGroups = groups.slice().sort(
        (a, b) => (
            Number(b.positives > 0 && b.negatives > 0)
                - Number(a.positives > 0 && a.negatives > 0)
            || b.indices.length - a.indices.length
            || a.hash - b.hash
            || a.familyId.localeCompare(b.familyId)
        )
    );
    for (let folds = maximumFolds; folds >= 2; folds--) {
        const assignments = new Array(rows.length);
        const foldState = Array.from(
            { length: folds },
            () => ({ rows: 0, positives: 0, negatives: 0 })
        );
        orderedGroups.forEach(group => {
            let selected = 0;
            let selectedTuple = null;
            for (let fold = 0; fold < folds; fold++) {
                const state = foldState[fold];
                const coverageGain = (
                    Number(
                        state.positives === 0
                        && group.positives > 0
                    )
                    + Number(
                        state.negatives === 0
                        && group.negatives > 0
                    )
                );
                const tuple = [
                    -coverageGain,
                    state.rows + group.indices.length,
                    Math.abs(
                        state.positives + group.positives
                        - (totalPositives / folds)
                    ) + Math.abs(
                        state.negatives + group.negatives
                        - (totalNegatives / folds)
                    ),
                    fold,
                ];
                if (
                    !selectedTuple
                    || tuple.some((value, index) => (
                        value < selectedTuple[index]
                        && tuple.slice(0, index).every(
                            (prior, priorIndex) => (
                                prior === selectedTuple[priorIndex]
                            )
                        )
                    ))
                ) {
                    selected = fold;
                    selectedTuple = tuple;
                }
            }
            group.indices.forEach(index => {
                assignments[index] = selected;
            });
            foldState[selected].rows += group.indices.length;
            foldState[selected].positives += group.positives;
            foldState[selected].negatives += group.negatives;
        });
        const valid = foldState.every(state => (
            state.rows > 0
            && state.positives > 0
            && state.negatives > 0
            && totalPositives - state.positives > 0
            && totalNegatives - state.negatives > 0
        ));
        if (valid) {
            return {
                folds,
                assignments,
                contentFamilies: groups.length,
                foldState,
            };
        }
    }
    return null;
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
        const successes = points.reduce(
            (sum, point) => sum + Number(point.actual >= 0.5),
            0
        );
        const interval = wilsonInterval(successes, points.length);
        calibrationBins.push({
            n: points.length,
            predicted: average(points.map(point => point.probability)),
            observed: successes / points.length,
            observedCiLow: interval.low,
            observedCiHigh: interval.high,
        });
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
        calibrationIntervalScope: (
            'Row-level Wilson intervals are descriptive only and do not '
            + 'model within-content-family dependence. Use groupedCalibration '
            + 'for family-resampled uncertainty.'
        ),
    };
}

function trainLogisticModel(rows, keys, lambda) {
    const definitions = keys.map(key => contract.features.find(feature => feature.key === key));
    const columns = definitions.map(definition => rows.map(row => rowFeatureValue(row, definition)).filter(finite));
    const medians = columns.map(column => median(column) == null ? 0 : median(column));
    const means = [], scales = [];
    for (let j = 0; j < definitions.length; j++) {
        const filled = rows.map(row => {
            const value = rowFeatureValue(row, definitions[j]);
            return finite(value) ? Number(value) : medians[j];
        });
        const mean = average(filled) || 0;
        const variance = average(filled.map(value => (value - mean) ** 2)) || 0;
        means.push(mean); scales.push(Math.sqrt(variance) || 1);
    }
    const design = rows.map(row => [1]
        .concat(definitions.map((definition, index) => {
            const raw = rowFeatureValue(row, definition);
            return (
                (finite(raw) ? Number(raw) : medians[index])
                - means[index]
            ) / scales[index];
        }))
        .concat(definitions.map(definition => (
            finite(rowFeatureValue(row, definition)) ? 0 : 1
        ))));
    const width = definitions.length * 2 + 1;
    const penalty = finite(lambda) ? Number(lambda) : 1;
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
    return {
        keys,
        definitions,
        medians,
        means,
        scales,
        coefficients,
        missingnessIndicators: true,
    };
}

function predictLogistic(model, row) {
    let linear = model.coefficients[0];
    for (let index = 0; index < model.definitions.length; index++) {
        const raw = rowFeatureValue(row, model.definitions[index]);
        const value = finite(raw) ? Number(raw) : model.medians[index];
        linear += model.coefficients[index + 1] * ((value - model.means[index]) / model.scales[index]);
    }
    for (let index = 0; index < model.definitions.length; index++) {
        const raw = rowFeatureValue(row, model.definitions[index]);
        linear += model.coefficients[
            1 + model.definitions.length + index
        ] * (finite(raw) ? 0 : 1);
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
        if (
            !train.some(row => row.y >= 0.5)
            || !train.some(row => row.y < 0.5)
            || !test.some(row => row.y >= 0.5)
            || !test.some(row => row.y < 0.5)
        ) {
            return null;
        }
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
    if (!actual.length) {
        return {
            n: 0,
            total: 0,
            missingPairsExcluded: 0,
            r2: null,
            protocolBaselineR2: null,
            rmseLog: null,
            maeLog: null,
            medianFactor: null,
            spearman: null,
        };
    }
    const observed = actual.map((value, index) => ({
        actual: value,
        predicted: predicted[index],
        baseline: baseline && baseline[index],
    })).filter(point => finite(point.actual) && finite(point.predicted));
    if (!observed.length) {
        return {
            n: 0,
            total: actual.length,
            missingPairsExcluded: actual.length,
            r2: null,
            protocolBaselineR2: null,
            rmseLog: null,
            maeLog: null,
            medianFactor: null,
            spearman: null,
        };
    }
    const observedActual = observed.map(point => Number(point.actual));
    const observedPredicted = observed.map(point => Number(point.predicted));
    const residuals = observedActual.map(
        (value, index) => value - observedPredicted[index]
    );
    const sse = residuals.reduce((sum, value) => sum + value * value, 0);
    const actualMean = average(observedActual);
    const totalSumSquares = observedActual.reduce(
        (sum, value) => sum + (value - actualMean) ** 2,
        0
    );
    const hasProtocolBaseline = !!baseline
        && observed.every(point => finite(point.baseline));
    const protocolBaselineSse = hasProtocolBaseline
        ? observed.reduce(
            (sum, point) => (
                sum + (Number(point.actual) - Number(point.baseline)) ** 2
            ),
            0
        )
        : null;
    return {
        n: observed.length,
        total: actual.length,
        missingPairsExcluded: actual.length - observed.length,
        r2: totalSumSquares > 0 ? 1 - sse / totalSumSquares : null,
        protocolBaselineR2:
            protocolBaselineSse > 0
                ? 1 - sse / protocolBaselineSse
                : null,
        rmseLog: Math.sqrt(sse / observed.length),
        maeLog: average(residuals.map(Math.abs)),
        medianFactor: Math.pow(10, median(residuals.map(Math.abs)) || 0),
        spearman: spearman(observedActual, observedPredicted),
    };
}

function deterministicRandom(seed) {
    let state = stableHash(seed) || 0x9e3779b9;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function intervalSummary(values) {
    const observed = values.filter(finite).map(Number);
    if (!observed.length) return null;
    return {
        low: quantile(observed, 0.025),
        median: median(observed),
        high: quantile(observed, 0.975),
        validReplicates: observed.length,
    };
}

function groupedBootstrapUncertainty(points, kind, seed, replicates) {
    const groups = new Map();
    (points || []).forEach(point => {
        const familyId = point.familyId;
        if (!groups.has(familyId)) groups.set(familyId, []);
        groups.get(familyId).push(point);
    });
    const families = [...groups.keys()].sort();
    const requestedReplicates = Math.max(
        50,
        Math.min(500, Number(replicates) || 200)
    );
    if (families.length < 3) {
        return {
            status: 'insufficient_content_families',
            unit: 'content_family',
            contentFamilies: families.length,
            requestedReplicates,
            validReplicates: 0,
            intervals: {},
        };
    }
    const random = deterministicRandom(
        `${seed}:${kind}:${families.join('|')}`
    );
    const collected = kind === 'binary'
        ? {
            brier: [],
            brierSkill: [],
            rocAuc: [],
            prAuc: [],
            calibrationError: [],
        }
        : {
            r2: [],
            protocolBaselineR2: [],
            rmseLog: [],
            maeLog: [],
            spearman: [],
        };
    let validReplicates = 0;
    for (
        let replicate = 0;
        replicate < requestedReplicates;
        replicate++
    ) {
        const sample = [];
        for (let index = 0; index < families.length; index++) {
            const family = families[
                Math.floor(random() * families.length)
            ];
            sample.push(...groups.get(family));
        }
        const actual = sample.map(point => point.actual);
        const predicted = sample.map(point => point.predicted);
        const baseline = sample.map(point => point.baseline);
        if (
            kind === 'binary'
            && (
                !actual.some(value => value >= 0.5)
                || !actual.some(value => value < 0.5)
            )
        ) continue;
        const metric = kind === 'binary'
            ? binaryPredictionMetrics(actual, predicted, baseline)
            : predictionMetrics(actual, predicted, baseline);
        validReplicates++;
        Object.keys(collected).forEach(key => {
            if (finite(metric[key])) collected[key].push(metric[key]);
        });
    }
    return {
        status: validReplicates >= Math.ceil(requestedReplicates * 0.8)
            ? 'descriptive'
            : 'unstable',
        unit: 'content_family',
        method: (
            'Deterministic percentile cluster bootstrap over complete '
            + 'content families. These intervals describe resampling '
            + 'uncertainty for the already-selected OOF policy; they are '
            + 'not selection-adjusted confidence intervals.'
        ),
        contentFamilies: families.length,
        requestedReplicates,
        validReplicates,
        intervals: Object.fromEntries(
            Object.entries(collected).map(([key, values]) => [
                key,
                intervalSummary(values),
            ])
        ),
    };
}

function groupedCalibrationDiagnostics(points, seed, replicates) {
    const groups = new Map();
    (points || []).forEach(point => {
        if (!groups.has(point.familyId)) groups.set(point.familyId, []);
        groups.get(point.familyId).push(point);
    });
    const families = [...groups.keys()].sort();
    const requestedReplicates = Math.max(
        50,
        Math.min(500, Number(replicates) || 200)
    );
    const original = Array.from({ length: 10 }, (_, bin) => {
        const members = (points || []).filter(point => (
            point.predicted >= bin / 10
            && (
                bin === 9
                    ? point.predicted <= 1
                    : point.predicted < (bin + 1) / 10
            )
        ));
        return {
            bin,
            n: members.length,
            contentFamilies: new Set(
                members.map(point => point.familyId)
            ).size,
            predicted: average(members.map(point => point.predicted)),
            observed: average(members.map(point => point.actual)),
            bootstrapObserved: [],
        };
    }).filter(bin => bin.n > 0);
    if (families.length < 3) {
        return {
            status: 'insufficient_content_families',
            unit: 'content_family',
            contentFamilies: families.length,
            requestedReplicates,
            bins: original.map(({ bootstrapObserved, ...bin }) => ({
                ...bin,
                observedInterval: null,
                validReplicates: 0,
            })),
        };
    }
    const random = deterministicRandom(
        `${seed}:grouped-calibration:${families.join('|')}`
    );
    for (
        let replicate = 0;
        replicate < requestedReplicates;
        replicate++
    ) {
        const sample = [];
        for (let index = 0; index < families.length; index++) {
            const family = families[
                Math.floor(random() * families.length)
            ];
            sample.push(...groups.get(family));
        }
        original.forEach(bin => {
            const members = sample.filter(point => (
                point.predicted >= bin.bin / 10
                && (
                    bin.bin === 9
                        ? point.predicted <= 1
                        : point.predicted < (bin.bin + 1) / 10
                )
            ));
            if (members.length) {
                bin.bootstrapObserved.push(
                    average(members.map(point => point.actual))
                );
            }
        });
    }
    return {
        status: 'descriptive',
        unit: 'content_family',
        contentFamilies: families.length,
        requestedReplicates,
        method: (
            'Reliability bins are fixed before resampling. Complete content '
            + 'families are sampled with replacement; intervals are '
            + 'descriptive percentile cluster-bootstrap intervals and are '
            + 'not selection-adjusted.'
        ),
        bins: original.map(({ bootstrapObserved, ...bin }) => ({
            ...bin,
            observedInterval:
                bootstrapObserved.length >= requestedReplicates * 0.8
                    ? intervalSummary(bootstrapObserved)
                    : null,
            validReplicates: bootstrapObserved.length,
        })),
    };
}

function evaluateFeatureSet(rows, keys, requestedFolds, lambda) {
    if (rows.length < 8 || !keys.length) return null;
    const { folds, assignments } = foldAssignments(rows, requestedFolds || 5);
    if (folds < 2) return null;
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
        total: metric.total,
        missingPairsExcluded: metric.missingPairsExcluded,
        r2: round(metric.r2),
        protocolBaselineR2: round(metric.protocolBaselineR2),
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
        calibrationIntervalScope: metric.calibrationIntervalScope,
        calibrationBins: (metric.calibrationBins || []).map(bin => ({
            n: bin.n,
            predicted: round(bin.predicted),
            observed: round(bin.observed),
            observedCiLow: round(bin.observedCiLow),
            observedCiHigh: round(bin.observedCiHigh),
        })),
    };
}

function buildRows(manifest, observedAt) {
    const now = finite(observedAt) ? Number(observedAt) : Date.now();
    return (manifest.videos || []).filter(video => (
        video
        && video.status === 'done'
        && finite(video.views)
        && Number(video.views) > 0
        && scoreLedgerValidationSummary(video).valid === true
        && validateManifestRowBinding(video).valid === true
    ))
        .map(video => {
            const publishedAt = parsePublished(video.publishedAt != null ? video.publishedAt : video.published);
            const viewsObservedAt = finite(video.viewsObservedAt) ? Number(video.viewsObservedAt) : (finite(video.scoredAt) ? Number(video.scoredAt) : now);
            const fixedHorizonOutcome = fixedHorizonViewOutcome(
                video,
                publishedAt
            );
            const outcomeViews = fixedHorizonOutcome
                ? fixedHorizonOutcome.views
                : Number(video.views);
            const outcomeObservedAt = fixedHorizonOutcome
                ? fixedHorizonOutcome.observedAt
                : viewsObservedAt;
            const ageDays = (
                publishedAt != null
                && outcomeObservedAt >= publishedAt
            )
                ? (outcomeObservedAt - publishedAt) / 86400000
                : null;
            const viewsHistory = (video.viewsHistory || []).filter(point => point && finite(point.at) && finite(point.views))
                .map(point => ({ at: Number(point.at), views: Number(point.views) })).sort((a, b) => a.at - b.at);
            const inputEvidenceValidation =
                validateShortsInputManifest(video);
            const declaredCanonical = (
                video.evidence_state
                    === CANONICAL_EVIDENCE_STATE
                && video.canonical === true
            );
            return {
                id: video.id,
                title: video.title || video.id,
                views: outcomeViews,
                currentLifetimeViews: Number(video.views),
                y: Math.log10(outcomeViews + 1),
                publishedAt,
                viewsObservedAt,
                outcomeObservedAt,
                ageDays,
                fixedHorizonOutcome,
                viewsHistory,
                video,
                evidenceState: video.evidence_state,
                canonicalInputBound: (
                    declaredCanonical
                    && inputEvidenceValidation.valid === true
                ),
                predictorEligible: (
                    declaredCanonical
                    && video.predictor_eligible === true
                    && inputEvidenceValidation.valid === true
                ),
                inputEvidenceValid:
                    inputEvidenceValidation.valid === true,
                inputEvidenceErrors:
                    inputEvidenceValidation.errors || [],
                canonicalFeatureCells:
                    canonicalFeatureCells(video),
            };
        });
}

function selectAnalysisPopulation(allRows) {
    const canonicalRows = allRows.filter(
        row => row.predictorEligible === true
    );
    const historicalRows = allRows.filter(
        row => row.evidenceState === HISTORICAL_EVIDENCE_STATE
    );
    const invalidEvidenceRows = allRows.filter(row => (
        !row.predictorEligible
        && row.evidenceState !== HISTORICAL_EVIDENCE_STATE
    ));
    const invalidInputEvidenceRows = allRows.filter(
        row => row.inputEvidenceValid !== true
    );
    const useCanonical = canonicalRows.length >= 8;
    const rows = useCanonical ? canonicalRows : historicalRows;
    const fixedHorizonDays = useCanonical
        ? [...new Set(canonicalRows.map(row => (
            row.fixedHorizonOutcome
                ? Number(row.fixedHorizonOutcome.horizonDays.toFixed(6))
                : null
        )))]
        : [];
    const fixedHorizonOutcome = (
        useCanonical
        && fixedHorizonDays.length === 1
        && fixedHorizonDays[0] != null
    );
    const mode = !useCanonical
        ? 'historical_input_diagnostic'
        : fixedHorizonOutcome
            ? (
                canonicalRows.length === allRows.length
                    ? 'canonical_fixed_horizon_association'
                    : 'canonical_fixed_horizon_subset_association'
            )
            : 'right_censored_lifetime_retrospective';
    const claimBoundary = useCanonical
        ? fixedHorizonOutcome
            ? (
                'Every fitted row has exact input binding and the same '
                + `${fixedHorizonDays[0]}-day timestamp-validated outcome `
                + 'horizon. This removes unequal outcome exposure, but this '
                + 'module still does not prove that upstream supervised axes '
                + 'excluded the evaluated video, content family, or creator. '
                + 'Results remain retrospective associations.'
            )
            : (
            'Every fitted row is declared canonical and predictor-eligible '
            + 'by its hash-bound manifest evidence record, and its input '
            + 'fingerprints validate internally. Historical '
            + 'unbound rows are excluded before fitting. This proves exact '
            + 'row identity, not upstream axis exclusion: stored axes may '
            + 'have used the evaluated video or creator during their own '
            + 'fit, and public views are not observed at one fixed horizon. '
            + 'These results are therefore reproducible retrospective '
            + 'associations, not end-to-end blind forecasts.'
            )
        : (
            'Fewer than eight exact input-bound rows are available. '
            + 'Calculations use structurally valid historical ledgers only '
            + 'as browseable diagnostics; they are not blind validation, '
            + 'training evidence, or predictor-eligible.'
        );
    return {
        rows,
        canonicalRows,
        historicalRows,
        invalidEvidenceRows,
        invalidInputEvidenceRows,
        mode,
        claimBoundary,
        inputBoundAnalysisEligible: useCanonical,
        fixedHorizonOutcome,
        fixedHorizonDays:
            fixedHorizonOutcome ? fixedHorizonDays[0] : null,
        predictorEligible: false,
    };
}

function directFeatureStats(rows, definition) {
    const observed = rows.map(row => ({ x: rowFeatureValue(row, definition), yLog: row.y, yRaw: row.views })).filter(point => finite(point.x));
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
    const observed = rows.map(row => ({ score: rowFeatureValue(row, definition), hit: row.views >= targetViews }))
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

function rawFeatureValue(row, definition) {
    const cell = rowFeatureCell(row, definition);
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
    const observed = rows.map(row => ({ score: rawFeatureValue(row, definition), views: row.views, hit: row.views >= targetViews }))
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
        bestEvidence: bestEvidence ? {
            ...bestEvidence,
            evidenceTier: 'full-sample-threshold-screen',
            decisionEligible: false,
            uncertaintyWarning: 'The threshold was selected on these same rows; its Wilson interval is descriptive and is not a post-selection confidence interval.',
        } : null,
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
        const result = evaluateBinaryFeatureSet(rows, keys, 5, 1, true);
        if (result) scored.push({ keys, ...cleanBinaryMetric(result) });
    }
    scored.sort((a, b) => (b.brierSkill == null ? -Infinity : b.brierSkill) - (a.brierSkill == null ? -Infinity : a.brierSkill)
        || (b.prAuc == null ? -Infinity : b.prAuc) - (a.prAuc == null ? -Infinity : a.prAuc)
        || a.keys.length - b.keys.length);
    return scored;
}

function probabilityFeatureCalibration(rows, definition, targetViews) {
    const observed = rows.map(row => ({ probability: rawFeatureValue(row, definition), actual: row.views >= targetViews ? 1 : 0 }))
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
    if (folds < 2) return null;
    const actual = [], predicted = [], baseline = [], chosen = {};
    const points = [], uncertaintyPoints = [];
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
            uncertaintyPoints.push({
                familyId: contentFamilyId(row),
                actual: row.y,
                predicted: prediction,
                baseline: trainMean,
            });
        }
    }
    const metric = predictionMetrics(actual, predicted, baseline);
    return {
        ...cleanMetric(metric),
        groupedUncertainty: groupedBootstrapUncertainty(
            uncertaintyPoints,
            'continuous',
            `nested:${candidates.length}`,
            200
        ),
        selections: Object.entries(chosen).map(([features, count]) => ({ features: features.split(' + '), folds: count })).sort((a, b) => b.folds - a.folds),
        points: points.sort((a, b) => b.actualViews - a.actualViews),
    };
}

function nestedBinarySelection(rows, candidates) {
    if (rows.length < 12 || !candidates.length) return null;
    const assignment = stratifiedFoldAssignments(rows, 5);
    if (!assignment) return null;
    const actual = [], predicted = [], baseline = [], chosen = {}, points = [];
    const uncertaintyPoints = [];
    for (let fold = 0; fold < assignment.folds; fold++) {
        const train = rows.filter((_, index) => assignment.assignments[index] !== fold);
        const test = rows.filter((_, index) => assignment.assignments[index] === fold);
        let best = null;
        for (const keys of candidates) {
            const metric = evaluateBinaryFeatureSet(train, keys, 3, 1, true);
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
            uncertaintyPoints.push({
                familyId: contentFamilyId(row),
                actual: hit,
                predicted: probability,
                baseline: trainRate,
            });
        }
    }
    const metric = binaryPredictionMetrics(actual, predicted, baseline);
    return {
        ...cleanBinaryMetric(metric),
        groupedUncertainty: groupedBootstrapUncertainty(
            uncertaintyPoints,
            'binary',
            `nested-binary:${candidates.length}`,
            200
        ),
        groupedCalibration: groupedCalibrationDiagnostics(
            uncertaintyPoints,
            `nested-binary:${candidates.length}`,
            200
        ),
        selections: Object.entries(chosen).map(([features, count]) => ({ features: features.split(' + '), folds: count })).sort((a, b) => b.folds - a.folds),
        points: points.sort((a, b) => b.probability - a.probability),
    };
}

function chronologicalBinarySelection(rows, candidates, options) {
    const fixedHorizon = !!(
        options && options.fixedHorizon
    );
    const dated = rows.filter(row => finite(row.publishedAt)).sort((a, b) => a.publishedAt - b.publishedAt || stableHash(a.id) - stableHash(b.id));
    if (dated.length < 20) return null;
    const split = Math.max(12, Math.min(dated.length - 6, Math.floor(dated.length * 0.7)));
    const testFrom = dated[split].publishedAt;
    const candidateTrain = dated.filter(
        row => row.publishedAt < testFrom
    );
    const test = dated.filter(
        row => row.publishedAt >= testFrom
    );
    const purged = purgeContentFamilyOverlap(candidateTrain, test);
    const train = purged.rows;
    if (train.filter(row => row.y >= 0.5).length < 2 || train.filter(row => row.y < 0.5).length < 2
        || !test.some(row => row.y >= 0.5) || !test.some(row => row.y < 0.5)) return null;
    let best = null;
    for (const keys of candidates) {
        const metric = evaluateBinaryFeatureSet(train, keys, 4, 1, true);
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
        evaluationClass: fixedHorizon
            ? 'retrospective-time-ordered-fixed-horizon-association'
            : 'right-censored-time-ordered-lifetime-association',
        prospective: false,
        fixedHorizon,
        futureProbabilityEligible: false,
        trainN: train.length,
        testN: test.length,
        trainThrough: train[train.length - 1].publishedAt,
        testFrom: test[0].publishedAt,
        contentFamilyPurge: purged.audit,
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

function matchedViewsQuestions(riskTargets) {
    const normalViewsKeys = new Set(['visual.views', 'text.views', 'together.views']);
    return [30000000, 50000000].map(targetViews => {
        const target = riskTargets.find(item => item.targetViews === targetViews);
        const cohort = target && target.cohorts.find(item => item.minAgeDays === 0);
        return {
            targetViews,
            scoreThreshold: targetViews,
            eligible: cohort ? cohort.n : 0,
            positives: cohort ? cohort.positives : 0,
            baseRate: cohort ? cohort.baseRate : null,
            signals: cohort ? cohort.viewsSignals.filter(signal => normalViewsKeys.has(signal.key)).map(signal => {
                const threshold = signal.thresholds.find(row => row.threshold === targetViews);
                return {
                    key: signal.key,
                    label: signal.label,
                    available: signal.available,
                    passed: threshold ? threshold.n : 0,
                    hits: threshold ? threshold.hits : 0,
                    misses: threshold ? threshold.misses : 0,
                    hitRate: threshold ? threshold.hitRate : null,
                    ciLow: threshold ? threshold.ciLow : null,
                    ciHigh: threshold ? threshold.ciHigh : null,
                    lift: threshold ? threshold.lift : null,
                    recall: threshold ? threshold.recall : null,
                    actualViewsMedian: threshold ? threshold.actualViewsMedian : null,
                };
            }) : [],
        };
    });
}

function buildIndicatorMatrix(rows) {
    const definitions = contract.features;
    const percentileByFeature = definitions.map(definition => {
        const observed = rows.map((row, rowIndex) => ({ rowIndex, value: rowFeatureValue(row, definition) }))
            .filter(point => finite(point.value));
        const ranked = rank(observed.map(point => Number(point.value)));
        const values = new Map();
        observed.forEach((point, index) => {
            const percentile = observed.length <= 1 ? 100 : ranked[index] / (observed.length - 1) * 100;
            values.set(point.rowIndex, Number(percentile.toFixed(2)));
        });
        return values;
    });
    const viewRanks = rank(rows.map(row => row.views));
    return {
        normalization: 'Within-channel percentile of the exact feature value used by the prediction models. Rows are ordered by actual public views; sorting is descriptive and never enters training.',
        columns: definitions.map(definition => ({ key: definition.key, group: definition.group, label: definition.label })),
        rows: rows.map((row, rowIndex) => ({
            id: row.id,
            title: row.title,
            views: row.views,
            publishedAt: row.publishedAt,
            ageDays: row.ageDays == null ? null : Number(row.ageDays.toFixed(2)),
            viewsPercentile: rows.length <= 1 ? 100 : Number((viewRanks[rowIndex] / (rows.length - 1) * 100).toFixed(2)),
            values: percentileByFeature.map(values => values.has(rowIndex) ? values.get(rowIndex) : null),
            rawValues: definitions.map(definition => rawFeatureValue(row, definition)),
        })).sort((a, b) => b.views - a.views || stableHash(a.id) - stableHash(b.id)),
    };
}

function buildIndicatorRelationships(rows) {
    const definitions = contract.features;
    const matrix = definitions.map(left => definitions.map(right => {
        const observed = rows.map(row => ({
            left: rowFeatureValue(row, left),
            right: rowFeatureValue(row, right),
        })).filter(point => finite(point.left) && finite(point.right));
        const xs = observed.map(point => Number(point.left)), ys = observed.map(point => Number(point.right));
        return {
            n: observed.length,
            pearson: pearson(xs, ys),
            spearman: spearman(xs, ys),
        };
    }));
    return {
        normalization: 'Pairwise-complete correlation of the exact feature values used by the models. Spearman exposes monotonic redundancy; Pearson exposes linear redundancy.',
        columns: definitions.map(definition => ({ key: definition.key, group: definition.group, label: definition.label })),
        matrix,
    };
}

function buildFeatureProfiles(rows) {
    return contract.features.map(definition => {
        const observed = rows.map(row => ({
            id: row.id,
            title: row.title,
            score: rowFeatureValue(row, definition),
            raw: rawFeatureValue(row, definition),
            views: row.views,
        })).filter(point => finite(point.score));
        const sorted = observed.slice().sort((a, b) => Number(a.score) - Number(b.score) || stableHash(a.id) - stableHash(b.id));
        const binCount = Math.min(10, Math.max(2, Math.floor(Math.sqrt(sorted.length))));
        const bins = [];
        for (let bin = 0; bin < binCount; bin++) {
            const start = Math.floor(bin * sorted.length / binCount), end = Math.floor((bin + 1) * sorted.length / binCount);
            const points = sorted.slice(start, end);
            if (!points.length) continue;
            const views = points.map(point => point.views), hits = points.filter(point => point.views >= 10000000).length;
            const interval = wilsonInterval(hits, points.length);
            bins.push({
                n: points.length,
                scoreMedian: median(points.map(point => Number(point.score))),
                rawMedian: median(points.map(point => point.raw).filter(finite).map(Number)),
                actualViewsP25: quantile(views, 0.25),
                actualViewsMedian: median(views),
                actualViewsP75: quantile(views, 0.75),
                hitRate10M: hits / points.length,
                hitRate10MCiLow: interval.low,
                hitRate10MCiHigh: interval.high,
            });
        }
        const raw = observed.map(point => point.raw).filter(finite).map(Number);
        return {
            key: definition.key,
            group: definition.group,
            label: definition.label,
            unit: definition.unit,
            available: observed.length,
            missing: rows.length - observed.length,
            rawDistribution: raw.length ? {
                min: Math.min(...raw),
                p10: quantile(raw, 0.1),
                p25: quantile(raw, 0.25),
                median: median(raw),
                p75: quantile(raw, 0.75),
                p90: quantile(raw, 0.9),
                max: Math.max(...raw),
            } : null,
            bins,
        };
    });
}

function buildOutcomeProfile(rows) {
    const views = rows.map(row => row.views).filter(finite).map(Number);
    const logs = views.map(value => Math.log10(value + 1));
    const binCount = Math.min(14, Math.max(5, Math.floor(Math.sqrt(logs.length))));
    const lo = Math.min(...logs), hi = Math.max(...logs), width = (hi - lo) / binCount || 1;
    const histogram = Array.from({ length: binCount }, (_, index) => ({
        logLow: lo + index * width,
        logHigh: index === binCount - 1 ? hi : lo + (index + 1) * width,
        n: 0,
    }));
    logs.forEach(value => {
        const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - lo) / width)));
        histogram[index].n++;
    });
    return {
        n: views.length,
        min: Math.min(...views),
        p10: quantile(views, 0.1),
        p25: quantile(views, 0.25),
        median: median(views),
        p75: quantile(views, 0.75),
        p90: quantile(views, 0.9),
        max: Math.max(...views),
        histogram,
    };
}

function savedChannelAnalysisFingerprint(manifest) {
    const rows = (manifest && manifest.videos || []).map(video => {
        const ledgerValidation = scoreLedgerValidationSummary(video);
        const manifestBinding =
            validateManifestRowBinding(video);
        const ledgerState = ledgerValidation.state === 'canonical-valid'
            ? `valid:${ledgerValidation.ledger_sha256}`
            : ledgerValidation.state === 'canonical-invalid'
                ? `invalid:${sha256Text(JSON.stringify(video.score_ledger))}`
                : 'missing';
        return [
            video.id,
            video.status,
            video.views,
            video.viewsObservedAt,
            video.publishedAt != null ? video.publishedAt : video.published,
            video.scoredAt,
            video.title || '',
            video.silent === true ? 'silent' : 'speech-or-unknown',
            video.contentFamilyId
                || video.content_family_id
                || video.sourceContentId
                || video.source_content_id
                || video.originalContentId
                || video.original_content_id
                || video.perceptualHash
                || video.perceptual_hash
                || video.montageSha256
                || video.montage_sha256
                || video.input_manifest
                    && video.input_manifest.canonical_montage
                    && video.input_manifest.canonical_montage.montage_sha256
                || '',
            ledgerState,
            `${manifestBinding.state}:${
                manifestBinding.recorded_sha256 || ''
            }`,
            sha256Canonical(video.input_manifest || null),
            sha256Text(JSON.stringify(video.viewsHistory || [])),
            sha256Canonical(
                video.fixedHorizonOutcome
                || video.fixed_horizon_outcome
                || null
            ),
        ].join(':');
    }).sort();
    return `v${VERSION}:${ANALYSIS_IMPLEMENTATION_SHA256}:${sha256Text(rows.join('\n'))}:${rows.length}`;
}

function analyzeChannel(manifest) {
    const generatedAt = Date.now();
    const allRows = buildRows(manifest || {}, generatedAt);
    const population = selectAnalysisPopulation(allRows);
    const rows = population.rows;
    const keys = contract.features.map(feature => feature.key);
    const manifestVideos = manifest && manifest.videos || [];
    const completedVideos = manifestVideos.filter(
        video => video && video.status === 'done'
    );
    const completedLedgerStates = completedVideos.map(
        scoreLedgerValidationSummary
    );
    const completedManifestBindingStates = completedVideos.map(
        validateManifestRowBinding
    );
    const eligibility = {
        discovered: manifestVideos.length,
        completed: completedVideos.length,
        completedWithPublicViews: allRows.length,
        analysisRows: rows.length,
        canonicalInputBoundWithPublicViews:
            population.canonicalRows.length,
        historicalInputUnboundWithPublicViews:
            population.historicalRows.length,
        invalidEvidenceStateWithPublicViews:
            population.invalidEvidenceRows.length,
        invalidInputEvidenceWithPublicViews:
            population.invalidInputEvidenceRows.length,
        canonicalLedgerValid: completedLedgerStates.filter(
            state => state.valid === true
        ).length,
        legacyLedgerMissing: completedLedgerStates.filter(
            state => state.state === 'legacy-missing'
        ).length,
        invalidLedgerExcluded: completedLedgerStates.filter(
            state => state.state === 'canonical-invalid'
        ).length,
        hashBoundManifestRows: completedManifestBindingStates.filter(
            state => state.valid === true
        ).length,
        legacyManifestBindingMissing:
            completedManifestBindingStates.filter(
                state => state.state === 'legacy-missing'
            ).length,
        invalidManifestBindingExcluded:
            completedManifestBindingStates.filter(
                state => state.state === 'canonical-invalid'
            ).length,
        knownPublicationDates:
            rows.filter(row => row.ageDays != null).length,
        missingPublicationDates:
            rows.filter(row => row.ageDays == null).length,
        note: (
            'Hash-valid score records and exact input-bound evidence are '
            + 'separate requirements. Canonical fitting uses only rows '
            + 'whose manifest declares canonical_bound, canonical=true, '
            + 'and predictor_eligible=true, and whose montage/text input '
            + 'fingerprints validate internally. Historical unbound rows remain '
            + 'browseable but cannot support predictor claims. '
            + 'Minimum-age cohorts additionally require a publication '
            + 'timestamp.'
        ),
    };
    const evidence = {
        mode: population.mode,
        inputBoundAnalysisEligible:
            population.inputBoundAnalysisEligible,
        predictorEligible: false,
        blindValidationEligible: false,
        upstreamFitExclusionVerified: false,
        fixedOutcomeHorizon: population.fixedHorizonOutcome,
        fixedOutcomeHorizonDays: population.fixedHorizonDays,
        analysisRows: rows.length,
        canonicalInputBoundRows:
            population.canonicalRows.length,
        historicalInputUnboundRows:
            population.historicalRows.length,
        invalidEvidenceRows:
            population.invalidEvidenceRows.length,
        invalidInputEvidenceRows:
            population.invalidInputEvidenceRows.length,
        claimBoundary: population.claimBoundary,
    };
    const inference = {
        confirmatory: false,
        multiplicityAdjusted: false,
        decisionEligible: false,
        claimStatus: 'exploratory_only',
        hypothesisAccounting: {
            continuousSingleScreens: contract.features.length,
            registeredSinglePairTripleModels: 1561,
            publicViewTargets: 8,
            minimumAgeSlicesPerTarget: 6,
            directionalFeatureScreens:
                contract.features.length * 8 * 6,
            thresholdCutoffs: 'data-dependent and fixed cutoffs per views axis',
            promotedUnadjustedClaims: 0,
        },
        searchedFamilies: [
            '21 single-coordinate continuous associations',
            '1,561 fixed single/pair/triple registries',
            'eight public-view outcome thresholds',
            'six minimum-age descriptive cohorts',
            'multiple score cutoffs per views-valued coordinate',
        ],
        note: (
            'All rankings, favorable-direction AUCs, threshold screens, '
            + 'and confidence intervals are exploratory. No familywise '
            + 'or false-discovery correction has been applied, and an '
            + 'independent fixed-horizon confirmation set is required '
            + 'before decision use.'
        ),
    };
    if (rows.length < 8) return {
        version: VERSION,
        implementationSha256: ANALYSIS_IMPLEMENTATION_SHA256,
        generatedAt,
        channelId: manifest && manifest.id,
        n: rows.length,
        eligibility,
        evidence,
        inference,
        featureContract: contract,
        status: 'insufficient',
        message: (
            'At least 8 eligible rows are required. Exact input-bound rows '
            + 'are required for predictor claims; historical rows may only '
            + 'support explicitly labeled diagnostics.'
        ),
    };

    const evidenceTier = population.inputBoundAnalysisEligible
        ? population.fixedHorizonOutcome
            ? 'input-bound-fixed-horizon-grouped-oof-association'
            : 'input-bound-right-censored-retrospective-association'
        : 'historical-input-diagnostic';
    const singles = contract.features.map(definition => {
        const direct = directFeatureStats(rows, definition);
        const oof = evaluateFeatureSet(rows, [definition.key], 5, 1);
        return {
            key: definition.key,
            group: definition.group,
            label: definition.label,
            ...direct,
            oof: cleanMetric(oof),
            evidenceTier,
            predictorEligible: false,
            decisionEligible: false,
        };
    }).sort((a, b) => ((b.oof && b.oof.r2) == null ? -Infinity : b.oof.r2) - ((a.oof && a.oof.r2) == null ? -Infinity : a.oof.r2));

    const candidates = combinations(keys, 1).concat(combinations(keys, 2), combinations(keys, 3));
    const candidateScores = evaluateCandidateRows(rows, candidates);
    const path = forwardPath(rows, keys);
    const nested = nestedSelection(rows, candidates);
    const nestedSingles = nestedSelection(
        rows,
        combinations(keys, 1)
    );
    const allIndicators = cleanMetric(evaluateFeatureSet(rows, keys, 5, 1));
    const baselineLog = average(rows.map(row => row.y));
    const primaryRiskTarget = 10000000;
    const riskTargetValues = [100000, 300000, 1000000, 3000000, 10000000, 30000000, 50000000, 100000000];
    const riskTargets = riskTargetValues.map(targetViews => targetRisk(rows, targetViews));
    const matchedQuestions = matchedViewsQuestions(riskTargets);
    const riskRows = rows.map(row => ({ ...row, y: row.views >= primaryRiskTarget ? 1 : 0 }));
    const riskPositives = riskRows.filter(row => row.y >= 0.5).length, riskNegatives = riskRows.length - riskPositives;
    let riskCandidateScores = [], riskNested = null, riskNestedSingles = null;
    let riskAll = null, riskChronological = null;
    if (riskPositives >= 3 && riskNegatives >= 3) {
        riskCandidateScores = evaluateBinaryCandidateRows(riskRows, candidates);
        riskNested = nestedBinarySelection(riskRows, candidates);
        riskNestedSingles = nestedBinarySelection(
            riskRows,
            combinations(keys, 1)
        );
        riskAll = cleanBinaryMetric(evaluateBinaryFeatureSet(riskRows, keys, 5, 1, true));
        riskChronological = chronologicalBinarySelection(
            riskRows,
            candidates,
            { fixedHorizon: population.fixedHorizonOutcome }
        );
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

    const primaryRisk = riskTargets.find(target => target.targetViews === primaryRiskTarget);
    const primaryCohort = primaryRisk && primaryRisk.cohorts.find(cohort => cohort.minAgeDays === 0);
    const strongestTrajectory = singles.filter(row => row.spearmanViews != null && row.spearmanViews > 0)
        .sort((a, b) => b.spearmanViews - a.spearmanViews)[0] || null;
    const nestedSinglePolicy = nestedSingles ? {
        performance: Object.fromEntries(
            Object.entries(nestedSingles).filter(
                ([key]) => !['points', 'selections'].includes(key)
            )
        ),
        selections: nestedSingles.selections,
        evidenceTier,
        predictorEligible: false,
        decisionEligible: false,
        confirmationRequired: true,
        label: 'Nested single-feature selection policy',
        warning: (
            'Performance belongs to the fold-local selection policy. '
            + 'Selection frequencies are shown as a distribution; no one '
            + 'feature name inherits the adaptive policy score.'
        ),
    } : null;
    const nestedTailPolicy = riskNestedSingles ? {
        performance: Object.fromEntries(
            Object.entries(riskNestedSingles).filter(
                ([key]) => !['points', 'selections'].includes(key)
            )
        ),
        selections: riskNestedSingles.selections,
        evidenceTier,
        predictorEligible: false,
        decisionEligible: false,
        confirmationRequired: true,
        label: 'Nested single-feature tail selection policy',
        warning: (
            'Performance belongs to the fold-local selection policy. '
            + 'No one feature name inherits the adaptive policy score.'
        ),
    } : null;
    const strongestFixedSingleExploratory = singles[0] ? {
        key: singles[0].key,
        group: singles[0].group,
        label: singles[0].label,
        oof: singles[0].oof,
        evidenceTier: 'multiplicity-uncorrected-fixed-feature-screen',
        predictorEligible: false,
        decisionEligible: false,
        warning: (
            'This names one fixed feature and reports only that feature’s '
            + 'own grouped OOF result. It was ranked after screening all '
            + `${contract.features.length} features and is exploratory.`
        ),
    } : null;

    return {
        version: VERSION,
        implementationSha256: ANALYSIS_IMPLEMENTATION_SHA256,
        generatedAt,
        channelId: manifest && manifest.id,
        channelName: manifest && manifest.name,
        status: !population.inputBoundAnalysisEligible
            ? 'historical_diagnostic'
            : population.fixedHorizonOutcome
                ? 'fixed_horizon_association'
                : 'right_censored_retrospective',
        n: rows.length,
        eligibility,
        evidence,
        inference,
        transcriptCoverage: rows.filter(row => !row.video.silent).length / rows.length,
        featureContract: contract,
        outcome: {
            primary: population.fixedHorizonOutcome
                ? (
                    `log10(${population.fixedHorizonDays}-day `
                    + 'YouTube views + 1)'
                )
                : 'log10(current cumulative YouTube views + 1)',
            secondary: population.fixedHorizonOutcome
                ? `${population.fixedHorizonDays}-day YouTube views`
                : 'current cumulative YouTube views',
            fixedHorizon: population.fixedHorizonOutcome,
            fixedHorizonDays: population.fixedHorizonDays,
            observationSemantics: population.fixedHorizonOutcome
                ? (
                    'explicit timestamp-validated common post-publication '
                    + 'outcome horizon'
                )
                : (
                    'current cumulative public-view snapshot at '
                    + 'viewsObservedAt; unequal exposure is right-censored'
                ),
            baselineViews: Math.round(Math.pow(10, baselineLog) - 1),
            modelCoordinate: 'raw canonical score-ledger value with the feature contract unit; view-valued coordinates are transformed once with log10(value + 1)',
            validation: population.inputBoundAnalysisEligible
                ? (
                    'Deterministic content-family-grouped out-of-fold '
                    + 'associations over exact input-bound rows. Medians, '
                    + 'scaling, and the missing-input indicator are fit '
                    + 'inside each training fold. '
                    + (
                        population.fixedHorizonOutcome
                            ? (
                                'Every outcome uses the same timestamp-'
                                + 'validated horizon. '
                            )
                            : (
                                'Cumulative views have unequal exposure and '
                                + 'remain right-censored. '
                            )
                    )
                    + 'Upstream coordinate fits are not certified held out '
                    + 'here, so this is not an end-to-end blind forecast.'
                )
                : (
                    'Diagnostic content-family-grouped out-of-fold '
                    + 'arithmetic over historical unbound scores. It does '
                    + 'not establish blind predictor performance.'
                ),
        },
        search: {
            exhaustiveThroughSize: 3,
            exhaustiveCandidates: candidates.length,
            theoreticalAllSubsets: Math.pow(2, keys.length) - 1,
            forwardPathModels: path.length,
            nestedCandidateRegistry: 'fixed exhaustive singles, pairs, and triples only',
            exploratoryForwardPathEligibleForHeadline: false,
            note: 'Singles, pairs, and triples are the fixed nested-selection registry. The larger deterministic forward path is a full-data exploratory screen only and is never admitted to the headline nested score. The all-21 ridge model is a separately fixed model.',
        },
        singles,
        signalSummary: {
            strongestTrajectory: strongestTrajectory ? {
                ...strongestTrajectory,
                evidenceTier: population.inputBoundAnalysisEligible
                    ? 'full-sample-descriptive-screen'
                    : 'historical-input-diagnostic',
                predictorEligible: false,
                decisionEligible: false,
            } : null,
            nestedSinglePolicy,
            nestedTailPolicy,
            strongestFixedSingleExploratory,
            note: population.inputBoundAnalysisEligible
                ? (
                    'The single and tail policies select inside nested '
                    + 'training folds, but upstream axis exclusion is not '
                    + 'certified here. Full-sample rankings and policy '
                    + 'scores remain retrospective and are never '
                    + 'decision-eligible.'
                )
                : (
                    'All summaries use historical unbound scores and are '
                    + 'diagnostic only. None is blind, predictor-eligible, '
                    + 'or decision-eligible.'
                ),
        },
        indicatorMatrix: buildIndicatorMatrix(rows),
        indicatorRelationships: buildIndicatorRelationships(rows),
        featureProfiles: buildFeatureProfiles(rows),
        outcomeProfile: buildOutcomeProfile(rows),
        topCombinations: candidateScores.slice(0, 30).map(row => ({
            ...row,
            evidenceTier: population.inputBoundAnalysisEligible
                ? 'full-sample-exploratory-screen'
                : 'historical-input-diagnostic',
            predictorEligible: false,
            decisionEligible: false,
        })),
        bestBySize: [1, 2, 3].map(size => candidateScores.find(row => row.keys.length === size))
            .filter(Boolean)
            .map(row => ({
                ...row,
                evidenceTier: population.inputBoundAnalysisEligible
                    ? 'full-sample-exploratory-screen'
                    : 'historical-input-diagnostic',
                predictorEligible: false,
                decisionEligible: false,
            })),
        forwardPath: path,
        models: {
            nestedSelected: nested ? {
                ...nested,
                evidenceTier,
                predictorEligible: false,
                decisionEligible: false,
            } : null,
            allIndicators: allIndicators ? {
                ...allIndicators,
                evidenceTier,
                predictorEligible: false,
                decisionEligible: false,
            } : null,
            bestExploratory: candidateScores[0] ? {
                ...candidateScores[0],
                evidenceTier: population.inputBoundAnalysisEligible
                    ? 'full-sample-exploratory-screen'
                    : 'historical-input-diagnostic',
                predictorEligible: false,
            } : null,
        },
        risk: {
            primaryTargetViews: primaryRiskTarget,
            targetOptions: riskTargetValues,
            targets: riskTargets,
            matchedQuestions,
            viewAgeConfound: {
                fixedHorizon: population.fixedHorizonOutcome,
                fixedHorizonDays: population.fixedHorizonDays,
                knownAge: datedRows.length,
                total: rows.length,
                pearsonLogAgeToLogViews: viewAgeCorrelation == null ? null : Number(viewAgeCorrelation.toFixed(4)),
                note: population.fixedHorizonOutcome
                    ? (
                        'Every analyzed outcome uses the same explicit '
                        + `${population.fixedHorizonDays}-day timestamped `
                        + 'horizon. This removes unequal exposure but does '
                        + 'not certify upstream axis exclusion.'
                    )
                    : (
                        'Public views are cumulative snapshots at unequal '
                        + 'horizons. Minimum-age cohorts expose and reduce '
                        + 'the youngest censoring, but they do not create '
                        + 'fixed-horizon labels or calibrated future hit '
                        + 'probabilities.'
                    ),
            },
            viewHistory: {
                videosWithMultipleSnapshots: historyRows.length,
                total: rows.length,
                medianSpanDays: historyRows.length ? Number(median(historyRows.map(row => row.spanDays)).toFixed(2)) : null,
                medianGrowthFactor: historyRows.length ? Number(median(historyRows.map(row => row.growthFactor)).toFixed(3)) : null,
                note: 'Each channel refresh appends a bounded public-view snapshot. Multiple snapshots enable future score-at-time-T versus later-outcome validation.',
            },
            model: {
                status: riskPositives < 3 || riskNegatives < 3
                    ? 'insufficient'
                    : population.fixedHorizonOutcome
                        ? 'fixed_horizon_retrospective_association'
                        : 'right_censored_retrospective_association',
                targetViews: primaryRiskTarget,
                positives: riskPositives,
                negatives: riskNegatives,
                exhaustiveCandidates: candidates.length,
                evidenceTier,
                predictorEligible: false,
                decisionEligible: false,
                fixedHorizon: population.fixedHorizonOutcome,
                futureProbabilityEligible: false,
                validation: population.inputBoundAnalysisEligible
                    ? (
                        'Tail classifications are calculated out of fold. '
                        + 'Combination selection happens inside each '
                        + 'training fold. The time-ordered split trains on '
                        + 'older Shorts and evaluates newer Shorts. '
                        + (
                            population.fixedHorizonOutcome
                                ? 'Outcomes share one fixed horizon, but '
                                : 'Unequal exposure remains right-censored, and '
                        )
                        + 'uncertified upstream axis exclusion prevents a '
                        + 'prospective probability claim.'
                    )
                    : (
                        'Tail calculations use historical unbound scores '
                        + 'and are diagnostic only. They do not estimate '
                        + 'prospective hit probability.'
                    ),
                nestedSelected: riskNested,
                nestedSingleSelected: riskNestedSingles,
                allIndicators: riskAll,
                chronological: riskChronological,
                topCombinations: riskCandidateScores.slice(0, 30).map(row => ({
                    ...row,
                    evidenceTier: population.inputBoundAnalysisEligible
                        ? 'full-sample-exploratory-screen'
                        : 'historical-input-diagnostic',
                    predictorEligible: false,
                    decisionEligible: false,
                })),
            },
            probabilityCalibrationStatus: population.fixedHorizonOutcome
                ? 'descriptive_fixed_horizon_not_end_to_end_blind'
                : 'quarantined_right_censored_lifetime',
            probabilityCalibration: population.fixedHorizonOutcome
                ? contract.features.filter(
                    definition => definition.target === 'gt10M'
                ).map(definition => probabilityFeatureCalibration(
                    rows,
                    definition,
                    primaryRiskTarget
                ))
                : [],
        },
    };
}

module.exports = {
    VERSION,
    contract,
    featureCell,
    modelFeatureValue,
    pearson,
    spearman,
    evaluateFeatureSet,
    evaluateBinaryFeatureSet,
    contentFamilyId,
    foldAssignments,
    stratifiedFoldAssignments,
    _predictionMetrics: predictionMetrics,
    _purgeContentFamilyOverlap: purgeContentFamilyOverlap,
    wilsonInterval,
    savedChannelAnalysisFingerprint,
    analyzeChannel,
};
