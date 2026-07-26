#!/usr/bin/env node
'use strict';

/*
 * Independent factorized validation for the Jarvis prediction stack.
 *
 * This runner deliberately does not import the Principles UI or artifact builder.
 * It reads the underlying research artifacts and canonical validation manifests,
 * rebuilds its own folds, and writes one compact result JSON.
 *
 * Factor contract:
 *   opportunity       source history and, in a separate diagnostic, snapshot age
 *   packaging_entry   keep / viewed-instead-of-swiped projections
 *   attention_survival retention projections and opening-curve survival
 *   views_distribution views, outlier, realistic-views, and >10M projections
 *
 * "Predictive bits" are out-of-fold Gaussian log-score improvements over a
 * nested baseline, divided by log(2). They are predictive compression, not
 * causal information and not independent evidence when targets share videos.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    GetObjectCommand,
    S3Client,
} = require('@aws-sdk/client-s3');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const OUTPUT_PATH = path.join(__dirname, 'factorized-validation.json');

const PATHS = {
    predictor: 'buildings/jarvis/predictor-lab/results.json',
    privateRetention: 'buildings/jarvis/retention-study/retention_study.json',
    privateTable: 'buildings/jarvis/retention-study/retention_table.json',
    promiseOpening: 'buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json',
    marketHold: 'buildings/jarvis/promise-lab/.cache/market-reward.json',
    promise20s: 'buildings/jarvis/promise-lab/.cache/opening-20s.json',
    featureContract: 'buildings/jarvis/saved-channel-feature-contract.json',
};

const FACTORS = [
    'packaging_entry',
    'attention_survival',
    'views_distribution',
];

const RIDGE_ALPHAS = [0.1, 1, 10, 100];
const EPSILON = 1e-9;
const LN2 = Math.log(2);

function readEnvFile() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableHash(value) {
    return Number.parseInt(sha256(String(value)).slice(0, 13), 16);
}

function readJson(relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing required artifact: ${relativePath}`);
    }
    const bytes = fs.readFileSync(absolutePath);
    return {
        data: JSON.parse(bytes),
        provenance: {
            source: `local:${relativePath}`,
            bytes: bytes.length,
            sha256: sha256(bytes),
        },
    };
}

function finite(value) {
    return value !== null
        && value !== undefined
        && value !== ''
        && Number.isFinite(Number(value));
}

function number(value, fallback = null) {
    return finite(value) ? Number(value) : fallback;
}

function round(value, digits = 6) {
    return finite(value) ? Number(Number(value).toFixed(digits)) : null;
}

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
    const valid = values.filter(finite).map(Number);
    return valid.length ? sum(valid) / valid.length : null;
}

function quantile(values, probability) {
    const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * clamp(probability, 0, 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function median(values) {
    return quantile(values, 0.5);
}

function variance(values, sample = false) {
    const valid = values.filter(finite).map(Number);
    if (valid.length < (sample ? 2 : 1)) return null;
    const center = mean(valid);
    const denominator = sample ? valid.length - 1 : valid.length;
    return sum(valid.map(value => (value - center) ** 2)) / denominator;
}

function standardDeviation(values, sample = false) {
    const value = variance(values, sample);
    return finite(value) ? Math.sqrt(Math.max(0, value)) : null;
}

function covariance(left, right) {
    if (left.length !== right.length || left.length < 2) return null;
    const leftMean = mean(left);
    const rightMean = mean(right);
    return sum(left.map((value, index) => (
        (value - leftMean) * (right[index] - rightMean)
    ))) / left.length;
}

function pearson(left, right) {
    if (left.length !== right.length || left.length < 3) return null;
    const denominator = standardDeviation(left) * standardDeviation(right);
    return denominator > EPSILON ? covariance(left, right) / denominator : null;
}

function ranks(values) {
    const sorted = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value);
    const output = new Array(values.length);
    let cursor = 0;
    while (cursor < sorted.length) {
        let end = cursor + 1;
        while (end < sorted.length && sorted[end].value === sorted[cursor].value) end += 1;
        const rank = (cursor + end - 1) / 2;
        for (let index = cursor; index < end; index += 1) {
            output[sorted[index].index] = rank;
        }
        cursor = end;
    }
    return output;
}

function spearman(left, right) {
    return pearson(ranks(left), ranks(right));
}

function auc(scores, labels) {
    if (scores.length !== labels.length || scores.length < 3) return null;
    const positives = labels.filter(Boolean).length;
    const negatives = labels.length - positives;
    if (!positives || !negatives) return null;
    const ranked = ranks(scores);
    const positiveRankSum = sum(ranked.filter((_, index) => labels[index]));
    return (
        positiveRankSum - positives * (positives - 1) / 2
    ) / (positives * negatives);
}

function linearCalibration(actual, predicted) {
    const predVariance = variance(predicted);
    if (!(predVariance > EPSILON)) {
        return {
            intercept: mean(actual),
            slope: 0,
        };
    }
    const slope = covariance(predicted, actual) / predVariance;
    return {
        intercept: mean(actual) - slope * mean(predicted),
        slope,
    };
}

function gaussianLogLikelihood(actual, predicted, sigma) {
    const safeSigma = Math.max(number(sigma, 0), 1e-4);
    const residual = actual - predicted;
    return -Math.log(safeSigma * Math.sqrt(2 * Math.PI))
        - (residual * residual) / (2 * safeSigma * safeSigma);
}

function regressionReport(records) {
    const usable = records.filter(row => finite(row.actual) && finite(row.predicted));
    const actual = usable.map(row => Number(row.actual));
    const predicted = usable.map(row => Number(row.predicted));
    if (!usable.length) return { n: 0 };
    const residuals = usable.map(row => row.predicted - row.actual);
    const center = mean(actual);
    const sse = sum(residuals.map(value => value * value));
    const sst = sum(actual.map(value => (value - center) ** 2));
    const calibration = linearCalibration(actual, predicted);
    const highLabels = usable.map(row => Boolean(row.highLabel));
    const intervalRows = usable.filter(row => finite(row.sigma));
    const intervalCoverage = intervalRows.length
        ? mean(intervalRows.map(row => (
            Math.abs(row.actual - row.predicted) <= 1.281551565545 * row.sigma ? 1 : 0
        )))
        : null;
    return {
        n: usable.length,
        calibration: {
            bias: round(mean(residuals)),
            mae: round(mean(residuals.map(Math.abs))),
            rmse: round(Math.sqrt(sse / usable.length)),
            slope: round(calibration.slope),
            intercept: round(calibration.intercept),
            interval80Coverage: round(intervalCoverage),
            interval80MeanWidth: round(intervalRows.length
                ? mean(intervalRows.map(row => 2 * 1.281551565545 * row.sigma))
                : null),
        },
        discrimination: {
            r2: round(sst > EPSILON ? 1 - sse / sst : null),
            pearson: round(pearson(actual, predicted)),
            spearman: round(spearman(actual, predicted)),
            topQuartileAuc: round(auc(predicted, highLabels)),
            predictionSd: round(standardDeviation(predicted)),
            actualSd: round(standardDeviation(actual)),
            spreadRatio: round(
                standardDeviation(actual) > EPSILON
                    ? standardDeviation(predicted) / standardDeviation(actual)
                    : null
            ),
        },
        residual: {
            p10: round(quantile(residuals, 0.1)),
            p50: round(quantile(residuals, 0.5)),
            p90: round(quantile(residuals, 0.9)),
        },
    };
}

function mseEquivalentBits(modelRecords, baselineRecords) {
    const baselineByKey = new Map(baselineRecords.map(row => [row.key, row]));
    const pairs = modelRecords
        .map(row => [row, baselineByKey.get(row.key)])
        .filter(([model, baseline]) => (
            baseline
            && finite(model.actual)
            && finite(model.predicted)
            && finite(baseline.predicted)
        ));
    if (!pairs.length) return null;
    const modelMse = mean(pairs.map(([model]) => (model.actual - model.predicted) ** 2));
    const baselineMse = mean(
        pairs.map(([model, baseline]) => (model.actual - baseline.predicted) ** 2)
    );
    return {
        n: pairs.length,
        bitsPerObservation: round(
            modelMse > EPSILON && baselineMse > EPSILON
                ? 0.5 * Math.log2(baselineMse / modelMse)
                : null
        ),
        totalBits: round(
            modelMse > EPSILON && baselineMse > EPSILON
                ? pairs.length * 0.5 * Math.log2(baselineMse / modelMse)
                : null
        ),
        mseRatio: round(modelMse / baselineMse),
        definition: '0.5 * log2(OOS baseline MSE / OOS model MSE)',
    };
}

function logScoreBits(modelRecords, baselineRecords) {
    const baselineByKey = new Map(baselineRecords.map(row => [row.key, row]));
    const foldBits = new Map();
    let totalBits = 0;
    let count = 0;
    for (const model of modelRecords) {
        const baseline = baselineByKey.get(model.key);
        if (!baseline || !finite(model.sigma) || !finite(baseline.sigma)) continue;
        const bits = (
            gaussianLogLikelihood(model.actual, model.predicted, model.sigma)
            - gaussianLogLikelihood(baseline.actual, baseline.predicted, baseline.sigma)
        ) / LN2;
        totalBits += bits;
        count += 1;
        const fold = String(model.fold);
        const previous = foldBits.get(fold) || { bits: 0, n: 0 };
        previous.bits += bits;
        previous.n += 1;
        foldBits.set(fold, previous);
    }
    if (!count) return null;
    const folds = [...foldBits.entries()].map(([fold, value]) => ({
        fold,
        n: value.n,
        bitsPerObservation: round(value.bits / value.n),
    }));
    return {
        n: count,
        bitsPerObservation: round(totalBits / count),
        totalBits: round(totalBits),
        positiveFoldFraction: round(mean(folds.map(row => (
            row.bitsPerObservation > 0 ? 1 : 0
        )))),
        folds,
        definition: 'OOF Gaussian log-score gain over the nested baseline, in bits',
    };
}

function solveLinearSystem(matrix, vector) {
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);
    for (let column = 0; column < size; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < size; row += 1) {
            if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
                pivot = row;
            }
        }
        if (Math.abs(augmented[pivot][column]) < 1e-12) {
            augmented[pivot][column] += 1e-8;
        }
        [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
        const divisor = augmented[column][column];
        for (let index = column; index <= size; index += 1) {
            augmented[column][index] /= divisor;
        }
        for (let row = 0; row < size; row += 1) {
            if (row === column) continue;
            const factor = augmented[row][column];
            if (Math.abs(factor) < 1e-18) continue;
            for (let index = column; index <= size; index += 1) {
                augmented[row][index] -= factor * augmented[column][index];
            }
        }
    }
    return augmented.map(row => row[size]);
}

function fitRidge(rawMatrix, targets, alpha, options = {}) {
    if (!rawMatrix.length || rawMatrix.length !== targets.length) {
        throw new Error('Invalid ridge training matrix');
    }
    const width = rawMatrix[0].length;
    const medians = Array.from({ length: width }, (_, column) => median(
        rawMatrix.map(row => row[column])
    ) ?? 0);
    const imputed = rawMatrix.map(row => row.map((value, column) => (
        finite(value) ? Number(value) : medians[column]
    )));
    const means = Array.from({ length: width }, (_, column) => mean(
        imputed.map(row => row[column])
    ));
    const scales = Array.from({ length: width }, (_, column) => (
        standardDeviation(imputed.map(row => row[column])) || 1
    ));
    const design = imputed.map(row => [
        1,
        ...row.map((value, column) => (value - means[column]) / scales[column]),
    ]);
    const dimension = width + 1;
    const gram = Array.from({ length: dimension }, () => (
        Array.from({ length: dimension }, () => 0)
    ));
    const right = Array.from({ length: dimension }, () => 0);
    for (let row = 0; row < design.length; row += 1) {
        for (let left = 0; left < dimension; left += 1) {
            right[left] += design[row][left] * targets[row];
            for (let column = 0; column < dimension; column += 1) {
                gram[left][column] += design[row][left] * design[row][column];
            }
        }
    }
    for (let index = 1; index < dimension; index += 1) {
        gram[index][index] += alpha;
    }
    gram[0][0] += 1e-8;
    const coefficients = solveLinearSystem(gram, right);
    const constrained = options.nonNegativeIndices || [];
    const inactive = constrained.filter(index => coefficients[index + 1] < 0);
    if (inactive.length) {
        const inactiveSet = new Set(inactive);
        const activeColumns = Array.from(
            { length: width },
            (_, index) => index
        ).filter(index => !inactiveSet.has(index));
        const reduced = rawMatrix.map(row => activeColumns.map(index => row[index]));
        const remappedConstraints = constrained
            .filter(index => !inactiveSet.has(index))
            .map(index => activeColumns.indexOf(index));
        const reducedModel = fitRidge(reduced, targets, alpha, {
            nonNegativeIndices: remappedConstraints,
        });
        const fullCoefficients = [reducedModel.coefficients[0]];
        for (let index = 0; index < width; index += 1) {
            const activeIndex = activeColumns.indexOf(index);
            fullCoefficients.push(
                activeIndex === -1 ? 0 : reducedModel.coefficients[activeIndex + 1]
            );
        }
        return {
            ...reducedModel,
            coefficients: fullCoefficients,
            constrainedColumnsSetToZero: inactive,
            predict: matrix => reducedModel.predict(
                matrix.map(row => activeColumns.map(index => row[index]))
            ),
        };
    }
    const predict = matrix => matrix.map(row => {
        const standardized = row.map((value, column) => {
            const clean = finite(value) ? Number(value) : medians[column];
            return (clean - means[column]) / scales[column];
        });
        return coefficients[0] + sum(standardized.map(
            (value, index) => value * coefficients[index + 1]
        ));
    });
    const fitted = predict(rawMatrix);
    const sigma = Math.max(
        Math.sqrt(mean(fitted.map((value, index) => (targets[index] - value) ** 2))),
        1e-4
    );
    return {
        alpha,
        coefficients,
        medians,
        means,
        scales,
        sigma,
        predict,
        constrainedColumnsSetToZero: [],
    };
}

function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (finite(value)) {
        const numeric = Number(value);
        return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function canonicalText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenShingles(value, size = 3) {
    const tokens = canonicalText(value).split(' ').filter(Boolean);
    if (tokens.length < size) return new Set([tokens.join(' ')]);
    return new Set(Array.from(
        { length: tokens.length - size + 1 },
        (_, index) => tokens.slice(index, index + size).join(' ')
    ));
}

function jaccard(left, right) {
    let intersection = 0;
    for (const value of left) {
        if (right.has(value)) intersection += 1;
    }
    const union = left.size + right.size - intersection;
    return union ? intersection / union : 1;
}

function duplicateGroups(rows, threshold = 0.8) {
    const parent = rows.map((_, index) => index);
    const find = index => {
        while (parent[index] !== index) {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        return index;
    };
    const unite = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parent[b] = a;
    };
    const shingles = rows.map(row => tokenShingles(row.text || row.title));
    for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
            if (jaccard(shingles[left], shingles[right]) >= threshold) {
                unite(left, right);
            }
        }
    }
    const roots = new Map();
    return rows.map((_, index) => {
        const root = find(index);
        if (!roots.has(root)) roots.set(root, `copy-${roots.size + 1}`);
        return roots.get(root);
    });
}

function assert(condition, message) {
    if (!condition) throw new Error(`Leakage assertion failed: ${message}`);
}

function createR2Loader(provenance) {
    readEnvFile();
    const account = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!account || !accessKeyId || !secretAccessKey) {
        throw new Error('R2 credentials are required to load saved-channel and private-account manifests');
    }
    const client = new S3Client({
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        region: 'auto',
        credentials: { accessKeyId, secretAccessKey },
    });
    const bucket = process.env.R2_BUCKET_NAME || 'business-world-videos';
    return async key => {
        const response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        const bytes = Buffer.from(await response.Body.transformToByteArray());
        provenance.push({
            source: `r2:${key}`,
            bytes: bytes.length,
            sha256: sha256(bytes),
        });
        return JSON.parse(bytes.toString('utf8'));
    };
}

function savedFeatureValue(video, definition) {
    const cell = (video.features || {})[definition.key];
    let raw = null;
    let percentile = null;
    if (Array.isArray(cell)) {
        raw = number(cell[0]);
        percentile = number(cell[1]);
    } else if (cell && typeof cell === 'object') {
        raw = number(cell.v ?? cell.value);
        percentile = number(cell.p ?? cell.percentile);
    }
    if (percentile !== null && percentile > 1) percentile /= 100;
    if (
        raw !== null
        && definition.unit === 'views'
        && definition.source === 'steer'
    ) {
        raw = Math.log10(Math.max(0, raw) + 1);
    }
    return { raw, percentile };
}

async function loadSavedChannelRows(getR2, contract) {
    const index = await getR2('raw/saved-channels/index.json');
    const rows = [];
    for (const channel of index.channels || []) {
        const manifest = await getR2(`raw/saved-channels/${channel.id}/manifest.json`);
        for (const video of manifest.videos || []) {
            if (
                video.status !== 'done'
                || !finite(video.views)
                || Number(video.views) <= 0
            ) {
                continue;
            }
            const features = {};
            for (const definition of contract.features || []) {
                const value = savedFeatureValue(video, definition);
                features[`${definition.key}.raw`] = value.raw;
                features[`${definition.key}.percentile`] = value.percentile;
            }
            const publishedAt = parseDate(video.published);
            const observedAt = parseDate(
                video.viewsObservedAt
                || video.scoredAt
                || manifest.updatedAt
            );
            const ageDays = (
                publishedAt
                && observedAt
                && observedAt >= publishedAt
            )
                ? (observedAt - publishedAt) / 86400000
                : null;
            const textPresent = (contract.features || []).some(definition => (
                definition.group === 'text'
                && (
                    finite(features[`${definition.key}.raw`])
                    || finite(features[`${definition.key}.percentile`])
                )
            ));
            const duration = number(video.duration);
            features['text.present'] = textPresent ? 1 : 0;
            features['duration.log'] = duration !== null && duration >= 0
                ? Math.log10(duration + 1)
                : null;
            features['title.words'] = String(video.title || '').split(/\s+/).filter(Boolean).length;
            features['snapshot_age.log'] = ageDays !== null && ageDays >= 0
                ? Math.log10(ageDays + 1)
                : null;
            rows.push({
                id: String(video.id),
                title: String(video.title || video.id),
                source: String(channel.id),
                sourceName: String(manifest.name || channel.name || channel.id),
                publishedAt,
                observedAt,
                ageDays,
                y: Math.log10(Number(video.views) + 1),
                views: Number(video.views),
                features,
            });
        }
    }
    return rows;
}

async function loadPrivateRows(getR2, localTable) {
    const channels = await getR2('retention/channels.json');
    const rows = [];
    for (const channel of channels.channels || []) {
        const payload = channel.owner || channel.id === 'tyler'
            ? localTable
            : await getR2(`retention/${channel.id}.json`);
        for (const video of payload.videos || []) {
            const keep = number(video.keep_rate ?? video.stayedToWatch);
            if (!video.id || keep === null) continue;
            rows.push({
                id: String(video.id),
                title: String(video.title || video.id),
                source: String(channel.id),
                sourceName: String(channel.name || channel.id),
                publishedAt: parseDate(video.published),
                keep,
                ret5: number(video.ret5),
                averageRetention: number(video.avg_retention),
                views: number(video.views),
                duration: number(video.duration_s),
            });
        }
    }
    const unique = new Map();
    for (const row of rows) {
        if (!unique.has(row.id)) unique.set(row.id, row);
    }
    return [...unique.values()];
}

function factorFeatureNames(contract) {
    const output = {
        packaging_entry: [],
        attention_survival: [],
        views_distribution: [],
    };
    for (const definition of contract.features || []) {
        const variants = [
            `${definition.key}.raw`,
            `${definition.key}.percentile`,
        ];
        if (definition.target === 'keep') {
            output.packaging_entry.push(...variants);
        } else if (definition.target === 'ret5') {
            output.attention_survival.push(...variants);
        } else if (['views', 'realviews', 'outlier', 'gt10M'].includes(definition.target)) {
            output.views_distribution.push(...variants);
        }
    }
    return output;
}

function buildFeatureMatrices(trainRows, testRows, names, options = {}) {
    const includeAge = Boolean(options.includeAge);
    const sourceLevels = options.includeOpportunity
        ? [...new Set(trainRows.map(row => row.source))].sort()
        : [];
    const sourceColumns = sourceLevels.map(source => `opportunity.source:${source}`);
    const featureNames = [
        ...(options.controls || []),
        ...sourceColumns,
        ...(includeAge ? ['opportunity.snapshot_age'] : []),
        ...names,
    ];
    function vector(row) {
        return featureNames.map(name => {
            if (name.startsWith('opportunity.source:')) {
                return row.source === name.slice('opportunity.source:'.length) ? 1 : 0;
            }
            if (name === 'opportunity.snapshot_age') {
                return row.features['snapshot_age.log'];
            }
            return row.features[name];
        });
    }
    return {
        featureNames,
        train: trainRows.map(vector),
        test: testRows.map(vector),
        opportunity: {
            trainSourceLevels: sourceLevels,
            unseenTestSources: [...new Set(
                testRows
                    .map(row => row.source)
                    .filter(source => !sourceLevels.includes(source))
            )],
        },
    };
}

function groupFolds(rows, groupKey = 'source') {
    const groups = [...new Set(rows.map(row => row[groupKey]))].sort();
    return groups.map(group => {
        const test = rows.filter(row => row[groupKey] === group);
        const train = rows.filter(row => row[groupKey] !== group);
        assert(
            !train.some(row => row[groupKey] === group),
            `group ${group} appeared in both train and test`
        );
        return {
            id: `group:${group}`,
            train,
            test,
            heldOut: group,
        };
    }).filter(fold => fold.train.length >= 20 && fold.test.length >= 5);
}

function balancedHashFolds(rows, groupKey = 'copyGroup', count = 5) {
    const groups = [...new Set(rows.map(row => row[groupKey]))]
        .sort((left, right) => stableHash(left) - stableHash(right));
    const assignment = new Map(groups.map((group, index) => [group, index % count]));
    return Array.from({ length: count }, (_, foldIndex) => {
        const test = rows.filter(row => assignment.get(row[groupKey]) === foldIndex);
        const train = rows.filter(row => assignment.get(row[groupKey]) !== foldIndex);
        const trainGroups = new Set(train.map(row => row[groupKey]));
        assert(
            !test.some(row => trainGroups.has(row[groupKey])),
            `copy group overlap in fold ${foldIndex + 1}`
        );
        return {
            id: `hash-group:${foldIndex + 1}`,
            train,
            test,
        };
    }).filter(fold => fold.train.length >= 20 && fold.test.length >= 5);
}

function forwardFolds(rows, options = {}) {
    const dated = rows
        .filter(row => finite(row.publishedAt))
        .sort((left, right) => (
            left.publishedAt - right.publishedAt
            || String(left.id).localeCompare(String(right.id))
        ));
    const initialFraction = options.initialFraction || 0.5;
    const blockCount = options.blockCount || 4;
    const initial = Math.max(20, Math.floor(dated.length * initialFraction));
    const remaining = dated.length - initial;
    const folds = [];
    for (let block = 0; block < blockCount; block += 1) {
        const testStart = initial + Math.floor(remaining * block / blockCount);
        const testEnd = initial + Math.floor(remaining * (block + 1) / blockCount);
        const train = dated.slice(0, testStart);
        const test = dated.slice(testStart, testEnd);
        if (train.length < 20 || test.length < 5) continue;
        assert(
            Math.max(...train.map(row => row.publishedAt))
                <= Math.min(...test.map(row => row.publishedAt)),
            `forward fold ${block + 1} is not chronological`
        );
        folds.push({
            id: `forward:${block + 1}`,
            train,
            test,
            trainThrough: new Date(Math.max(...train.map(row => row.publishedAt))).toISOString(),
            testFrom: new Date(Math.min(...test.map(row => row.publishedAt))).toISOString(),
            testThrough: new Date(Math.max(...test.map(row => row.publishedAt))).toISOString(),
        });
    }
    return folds;
}

function innerFolds(rows, mode) {
    if (mode === 'grouped') {
        const grouped = groupFolds(rows);
        if (grouped.length >= 2) return grouped;
        return balancedHashFolds(rows.map(row => ({
            ...row,
            innerGroup: `hash-${stableHash(row.id) % 3}`,
        })), 'innerGroup', 3);
    }
    const forward = forwardFolds(rows, { initialFraction: 0.55, blockCount: 2 });
    if (forward.length) return forward;
    return balancedHashFolds(rows.map(row => ({
        ...row,
        innerGroup: `hash-${stableHash(row.id) % 3}`,
    })), 'innerGroup', 3);
}

function powerSet(values) {
    return Array.from({ length: 2 ** values.length }, (_, mask) => (
        values.filter((_, index) => mask & (1 << index))
    ));
}

function subsetKey(values) {
    return values.slice().sort().join('+') || 'opportunity_only';
}

function featureNamesForSubset(factorFeatures, subset) {
    return subset.flatMap(factor => factorFeatures[factor] || []);
}

function chooseAlpha(rows, mode, featureNames, options) {
    const folds = innerFolds(rows, mode);
    if (!folds.length) return 10;
    const scores = RIDGE_ALPHAS.map(alpha => {
        let squaredError = 0;
        let count = 0;
        for (const fold of folds) {
            const matrices = buildFeatureMatrices(
                fold.train,
                fold.test,
                featureNames,
                options
            );
            const model = fitRidge(
                matrices.train,
                fold.train.map(row => row.y),
                alpha,
                {
                    nonNegativeIndices: matrices.featureNames
                        .map((name, index) => (
                            (options.nonNegativeFeatures || []).includes(name)
                                ? index
                                : null
                        ))
                        .filter(index => index !== null),
                }
            );
            const predicted = model.predict(matrices.test);
            predicted.forEach((value, index) => {
                squaredError += (fold.test[index].y - value) ** 2;
                count += 1;
            });
        }
        return {
            alpha,
            rmse: count ? Math.sqrt(squaredError / count) : Infinity,
        };
    });
    scores.sort((left, right) => left.rmse - right.rmse || left.alpha - right.alpha);
    return scores[0].alpha;
}

function evaluateRidgeSubset(folds, mode, featureNames, options) {
    const records = [];
    const foldReports = [];
    for (const fold of folds) {
        const alpha = chooseAlpha(fold.train, mode, featureNames, options);
        const matrices = buildFeatureMatrices(
            fold.train,
            fold.test,
            featureNames,
            options
        );
        const model = fitRidge(
            matrices.train,
            fold.train.map(row => row.y),
            alpha,
            {
                nonNegativeIndices: matrices.featureNames
                    .map((name, index) => (
                        (options.nonNegativeFeatures || []).includes(name)
                            ? index
                            : null
                    ))
                    .filter(index => index !== null),
            }
        );
        const predicted = model.predict(matrices.test);
        const highThreshold = quantile(fold.train.map(row => row.y), 0.75);
        const foldRecords = fold.test.map((row, index) => ({
            key: `${fold.id}:${row.id}`,
            id: row.id,
            fold: fold.id,
            source: row.source,
            actual: row.y,
            predicted: predicted[index],
            sigma: model.sigma,
            highLabel: row.y >= highThreshold,
        }));
        records.push(...foldRecords);
        foldReports.push({
            fold: fold.id,
            trainN: fold.train.length,
            testN: fold.test.length,
            selectedAlpha: alpha,
            opportunityTrainSources: matrices.opportunity.trainSourceLevels.length,
            opportunityUnseenTestSources: matrices.opportunity.unseenTestSources,
            trainThrough: fold.trainThrough || null,
            testFrom: fold.testFrom || null,
            testThrough: fold.testThrough || null,
            metrics: regressionReport(foldRecords),
        });
    }
    return {
        records,
        report: regressionReport(records),
        folds: foldReports,
    };
}

function shapleyBits(modelBySubset, baselineRecords, factors = FACTORS) {
    const value = new Map();
    for (const subset of powerSet(factors)) {
        const key = subsetKey(subset);
        const model = modelBySubset[key];
        const bits = model ? logScoreBits(model.records, baselineRecords) : null;
        value.set(key, bits?.bitsPerObservation ?? null);
    }
    const factorial = value => {
        let output = 1;
        for (let index = 2; index <= value; index += 1) output *= index;
        return output;
    };
    const contributions = {};
    for (const factor of factors) {
        let contribution = 0;
        let complete = true;
        const other = factors.filter(value => value !== factor);
        for (const subset of powerSet(other)) {
            const without = value.get(subsetKey(subset));
            const withFactor = value.get(subsetKey([...subset, factor]));
            if (!finite(without) || !finite(withFactor)) {
                complete = false;
                continue;
            }
            const weight = (
                factorial(subset.length)
                * factorial(factors.length - subset.length - 1)
            ) / factorial(factors.length);
            contribution += weight * (withFactor - without);
        }
        contributions[factor] = complete ? round(contribution) : null;
    }
    return {
        unit: 'OOF Gaussian predictive bits per observation',
        baseline: 'opportunity + structural controls',
        contributions,
        total: round(sum(Object.values(contributions).filter(finite))),
        subsetValues: Object.fromEntries(
            [...value.entries()].map(([key, bits]) => [key, round(bits)])
        ),
        orderInvariant: true,
        method: 'Exact Shapley decomposition over all factor subsets',
    };
}

function evaluateSavedViewsTrack(rows, factorFeatures, includeAge) {
    const controls = ['duration.log', 'title.words', 'text.present'];
    const options = {
        controls,
        includeOpportunity: true,
        includeAge,
    };
    const controlOptions = {
        controls,
        includeOpportunity: false,
        includeAge: false,
    };
    const protocols = {
        groupedUnseenChannel: {
            mode: 'grouped',
            folds: groupFolds(rows),
        },
        forwardTime: {
            mode: 'forward',
            folds: forwardFolds(rows),
        },
    };
    const result = {};
    for (const [protocol, definition] of Object.entries(protocols)) {
        const control = evaluateRidgeSubset(
            definition.folds,
            definition.mode,
            [],
            controlOptions
        );
        const opportunity = evaluateRidgeSubset(
            definition.folds,
            definition.mode,
            [],
            options
        );
        const models = {};
        for (const subset of powerSet(FACTORS)) {
            const key = subsetKey(subset);
            models[key] = evaluateRidgeSubset(
                definition.folds,
                definition.mode,
                featureNamesForSubset(factorFeatures, subset),
                options
            );
        }
        const full = models[subsetKey(FACTORS)];
        result[protocol] = {
            population: {
                rows: full.records.length,
                folds: definition.folds.length,
                sources: [...new Set(rows.map(row => row.source))].length,
            },
            controlOnly: control.report,
            opportunity: {
                metrics: opportunity.report,
                logScoreBitsVsControl: logScoreBits(
                    opportunity.records,
                    control.records
                ),
            },
            fullFactorModel: {
                metrics: full.report,
                logScoreBitsVsOpportunity: logScoreBits(
                    full.records,
                    opportunity.records
                ),
                mseEquivalentBitsVsOpportunity: mseEquivalentBits(
                    full.records,
                    opportunity.records
                ),
            },
            factorBits: shapleyBits(models, opportunity.records),
            folds: full.folds.map((fold, index) => ({
                ...fold,
                opportunityBitsVsControl: round(
                    logScoreBits(
                        opportunity.records.filter(row => row.fold === fold.fold),
                        control.records.filter(row => row.fold === fold.fold)
                    )?.bitsPerObservation
                ),
                fullBitsVsOpportunity: round(
                    logScoreBits(
                        full.records.filter(row => row.fold === fold.fold),
                        opportunity.records.filter(row => row.fold === fold.fold)
                    )?.bitsPerObservation
                ),
                index,
            })),
        };
    }
    return result;
}

function baselinePredictionsForHeldSource(allRows, testRows, keyPrefix) {
    const heldSources = new Set(testRows.map(row => row.source));
    const train = allRows.filter(row => !heldSources.has(row.source));
    const prediction = mean(train.map(row => row.y));
    const sigma = standardDeviation(train.map(row => row.y)) || 1;
    const threshold = quantile(train.map(row => row.y), 0.75);
    return testRows.map(row => ({
        key: `${keyPrefix}:${row.id}`,
        id: row.id,
        fold: keyPrefix,
        actual: row.y,
        predicted: prediction,
        sigma,
        highLabel: row.y >= threshold,
    }));
}

function historicalBaseline(allRows, testRows, predictionRows, targetKey, keyPrefix) {
    const predictionById = new Map(predictionRows.map(row => [String(row.id), row]));
    const dated = allRows.filter(row => finite(row.publishedAt));
    const records = [];
    for (const row of testRows) {
        const prediction = predictionById.get(String(row.id));
        if (!prediction || !finite(row.publishedAt)) continue;
        const prior = dated.filter(candidate => (
            candidate.publishedAt < row.publishedAt
            && candidate.id !== row.id
        ));
        if (prior.length < 20) continue;
        const sameSource = prior.filter(candidate => candidate.source === row.source);
        const globalMean = mean(prior.map(candidate => candidate[targetKey]));
        const sourceMean = sameSource.length >= 5
            ? mean(sameSource.map(candidate => candidate[targetKey]))
            : globalMean;
        const sigma = standardDeviation(prior.map(candidate => candidate[targetKey])) || 1;
        const actual = row[targetKey];
        records.push({
            key: `${keyPrefix}:${row.id}`,
            id: row.id,
            fold: keyPrefix,
            actual,
            predicted: sourceMean,
            sigma,
            highLabel: actual >= quantile(prior.map(candidate => candidate[targetKey]), 0.75),
        });
    }
    return records;
}

function evaluatePrivateKeep(predictor, privateRows) {
    const target = predictor.targets.keep;
    const rawById = new Map(privateRows.map(row => [row.id, row]));
    const allActual = target.points.map(point => ({
        id: String(point.id),
        source: String(point.account),
        sourceName: String(point.accountName),
        y: Number(point.actual),
        publishedAt: rawById.get(String(point.id))?.publishedAt ?? null,
    }));
    const standardContent = target.points.map(point => ({
        key: `retrospective:${point.id}`,
        id: String(point.id),
        fold: `hash:${point.fold}`,
        source: String(point.account),
        actual: Number(point.actual),
        predicted: Number(point.contentOnlyPredicted),
        highLabel: Number(point.actual) >= quantile(
            target.points.filter(row => row.account === point.account).map(row => row.actual),
            0.75
        ),
    }));
    const standardFull = target.points.map(point => ({
        ...standardContent.find(row => row.id === String(point.id)),
        predicted: Number(point.predicted),
    }));

    const unseen = target.stressTests.find(test => /Unseen-account/.test(test.label));
    const groupedModel = [];
    const groupedBaseline = [];
    for (const source of [...new Set(allActual.map(row => row.source))]) {
        const testPoints = (unseen.points || []).filter(point => point.account === source);
        const testRows = testPoints.map(point => ({
            id: String(point.id),
            source,
            y: Number(point.actual),
        }));
        const baseline = baselinePredictionsForHeldSource(
            allActual,
            testRows,
            `group:${source}`
        );
        groupedBaseline.push(...baseline);
        const baselineById = new Map(baseline.map(row => [row.id, row]));
        groupedModel.push(...testPoints.map(point => {
            const base = baselineById.get(String(point.id));
            return {
                ...base,
                predicted: Number(point.predicted),
                sigma: null,
            };
        }));
    }

    const forward = target.stressTests.find(test => /Forward-time/.test(test.label));
    const forwardPoints = forward.points || [];
    const forwardPrivate = forwardPoints
        .map(point => rawById.get(String(point.id)))
        .filter(Boolean)
        .map(row => ({
            ...row,
            y: row.keep,
        }));
    const forwardBaseline = historicalBaseline(
        privateRows,
        forwardPrivate,
        forwardPoints,
        'keep',
        'forward'
    );
    const forwardBaselineById = new Map(forwardBaseline.map(row => [row.id, row]));
    const forwardModel = forwardPoints
        .filter(point => forwardBaselineById.has(String(point.id)))
        .map(point => ({
            ...forwardBaselineById.get(String(point.id)),
            predicted: Number(point.predicted),
            sigma: null,
        }));

    return {
        population: {
            rows: allActual.length,
            accounts: [...new Set(allActual.map(row => row.source))].length,
            target: 'observed keep / viewed-instead-of-swiped percentage',
        },
        leakageBoundary: {
            groupedUses: 'Predictor unseen-account stress predictions; held account was absent from axis fitting, feature selection, and calibration.',
            forwardUses: 'Predictor expanding-window predictions; present-day upstream representation remains a partial historical backtest.',
            retrospectiveOpportunityDecomposition: 'Same-account OOF interpolation only; never counted as OOD evidence.',
        },
        groupedUnseenAccount: {
            model: regressionReport(groupedModel),
            baseline: regressionReport(groupedBaseline),
            predictiveBits: mseEquivalentBits(groupedModel, groupedBaseline),
        },
        forwardTime: {
            model: regressionReport(forwardModel),
            baseline: regressionReport(forwardBaseline),
            predictiveBits: mseEquivalentBits(forwardModel, forwardBaseline),
        },
        retrospectiveKnownAccount: {
            contentOnly: regressionReport(standardContent),
            contentPlusAccountPrior: regressionReport(standardFull),
            opportunityBitsAfterContent: mseEquivalentBits(standardFull, standardContent),
            eligibleAsOodEvidence: false,
        },
    };
}

function evaluateCustomFactorModels(rows, factors, factorFeatures, protocols, options) {
    const result = {};
    for (const [protocol, definition] of Object.entries(protocols)) {
        const opportunity = evaluateRidgeSubset(
            definition.folds,
            definition.mode,
            [],
            options
        );
        const models = {};
        for (const subset of powerSet(factors)) {
            const key = subsetKey(subset);
            models[key] = evaluateRidgeSubset(
                definition.folds,
                definition.mode,
                featureNamesForSubset(factorFeatures, subset),
                options
            );
        }
        const full = models[subsetKey(factors)];
        result[protocol] = {
            opportunity: opportunity.report,
            full: full.report,
            predictiveBits: logScoreBits(full.records, opportunity.records),
            factorBits: shapleyBits(models, opportunity.records, factors),
            folds: full.folds,
        };
    }
    return result;
}

function evaluateObservedRetentionToViews(retentionStudy, localTable) {
    const dateById = new Map((localTable.videos || []).map(row => [
        String(row.id),
        parseDate(row.published),
    ]));
    const rows = (retentionStudy.scatter || [])
        .filter(row => (
            finite(row.lv)
            && finite(row.keep)
            && finite(row.ret)
            && finite(row.ret5)
            && finite(row.dur)
            && finite(dateById.get(String(row.id)))
        ))
        .map(row => ({
            id: String(row.id),
            source: 'tyler',
            publishedAt: dateById.get(String(row.id)),
            y: Number(row.lv),
            features: {
                'duration.log': Math.log10(Number(row.dur) + 1),
                'published.ordinal': dateById.get(String(row.id)) / 86400000,
                'observed.keep': Number(row.keep),
                'observed.ret5': Number(row.ret5),
                'observed.average_retention': Number(row.ret),
            },
        }));
    const timeGroups = rows
        .slice()
        .sort((left, right) => left.publishedAt - right.publishedAt)
        .map((row, index, sorted) => ({
            ...row,
            timeBlock: `block-${Math.min(4, Math.floor(index * 5 / sorted.length)) + 1}`,
        }));
    const factorFeatures = {
        packaging_entry: ['observed.keep'],
        attention_survival: [
            'observed.ret5',
            'observed.average_retention',
        ],
    };
    const factors = ['packaging_entry', 'attention_survival'];
    const protocols = {
        blockedTimeGroups: {
            mode: 'grouped',
            folds: groupFolds(timeGroups, 'timeBlock'),
        },
        forwardTime: {
            mode: 'forward',
            folds: forwardFolds(timeGroups),
        },
    };
    return {
        population: {
            rows: rows.length,
            accounts: 1,
            target: 'log10 current views snapshot',
        },
        role: 'Mechanistic upper-bound diagnostic only. Keep and retention are post-upload outcomes and are forbidden as pre-upload inputs.',
        eligibleAsPreUploadOodEvidence: false,
        validation: evaluateCustomFactorModels(
            timeGroups,
            factors,
            factorFeatures,
            protocols,
            {
                controls: ['duration.log', 'published.ordinal'],
                includeOpportunity: true,
                includeAge: false,
            }
        ),
    };
}

function constantBaseline(modelRows, referenceActual, keyPrefix) {
    const center = mean(referenceActual);
    const sigma = standardDeviation(referenceActual) || 1;
    const threshold = quantile(referenceActual, 0.75);
    return modelRows.map(row => ({
        key: `${keyPrefix}:${row.id}`,
        id: row.id,
        fold: row.fold || keyPrefix,
        actual: row.actual,
        predicted: center,
        sigma,
        highLabel: row.actual >= threshold,
    }));
}

function directModelRows(rows, keyPrefix) {
    return rows.map(row => ({
        key: `${keyPrefix}:${row.id}`,
        id: row.id,
        fold: row.fold || keyPrefix,
        source: row.source,
        actual: row.actual,
        predicted: row.predicted,
        sigma: row.sigma ?? null,
        highLabel: row.highLabel,
    }));
}

function openingPoint(row, second, family = 'entryIndexed') {
    const point = row.comparisonsByFamily?.[family]?.[String(second)]
        || row.comparisonsByFamily?.[family]?.[second];
    if (!point || !finite(point.predictedPercent) || !finite(point.actualPercent)) {
        return null;
    }
    return {
        id: String(row.videoId),
        source: String(row.accountId),
        actual: Number(point.actualPercent),
        predicted: Number(point.predictedPercent),
    };
}

function evaluatePromiseOpening(promise) {
    const development = (promise.rows || []).filter(row => (
        row.evaluationKind === 'saved-source-level-oof'
    ));
    const strictExternal = (promise.rows || []).filter(row => (
        row.strictBlindEligible === true
        && row.accountId !== 'tyler'
    ));
    const seconds = [5, 10, 20];
    const horizons = {};
    for (const second of seconds) {
        const devPoints = development.map(row => openingPoint(row, second)).filter(Boolean);
        const externalPoints = strictExternal.map(row => openingPoint(row, second)).filter(Boolean);
        const devActual = devPoints.map(row => row.actual);
        const devModel = directModelRows(devPoints, `development-oof:${second}`);
        const devBaseline = constantBaseline(
            devPoints.map(row => ({ ...row, fold: `development-oof:${second}` })),
            devActual,
            `development-oof:${second}`
        );
        const externalModel = directModelRows(
            externalPoints,
            `strict-external:${second}`
        );
        const externalBaseline = constantBaseline(
            externalPoints.map(row => ({ ...row, fold: `strict-external:${second}` })),
            devActual,
            `strict-external:${second}`
        );
        const highThreshold = quantile(devActual, 0.75);
        for (const row of [...devModel, ...externalModel, ...devBaseline, ...externalBaseline]) {
            row.highLabel = row.actual >= highThreshold;
        }
        horizons[second] = {
            unit: 'entry-indexed retention percentage; 100 at entry',
            developmentSourceLevelOof: {
                model: regressionReport(devModel),
                baseline: regressionReport(devBaseline),
                predictiveBits: mseEquivalentBits(devModel, devBaseline),
            },
            strictBlindExternalAccounts: {
                model: regressionReport(externalModel),
                baseline: regressionReport(externalBaseline),
                predictiveBits: mseEquivalentBits(externalModel, externalBaseline),
            },
        };
    }
    return {
        population: {
            developmentVideos: development.length,
            strictBlindExternalVideos: strictExternal.length,
            externalAccounts: [...new Set(strictExternal.map(row => row.accountId))].length,
        },
        leakageBoundary: {
            manifestSealedBeforeOutcomeJoin: promise.blindValidation?.status === 'sealed-before-outcome-join',
            outcomeFieldsPresentInBlindManifest: promise.blindValidation?.outcomeFieldsPresentInBlindManifest,
            predictionInputsExcludeOutcomeFields: promise.blindValidation?.predictionInputsExcludeOutcomeFields,
            exactAndNearTrainingOverlapExcluded: true,
        },
        horizons,
        forwardValidation: {
            available: false,
            reason: 'The compact row export does not contain genuinely forward-safe per-row Promise predictions. Source-level OOF and sealed external-account tests are reported instead; no forward result is invented.',
        },
    };
}

function evaluateSignalModels(rows, folds, mode, signalSets, options) {
    const baseline = evaluateRidgeSubset(folds, mode, [], options);
    const models = {};
    for (const [name, features] of Object.entries(signalSets)) {
        const evaluated = evaluateRidgeSubset(folds, mode, features, options);
        models[name] = {
            metrics: evaluated.report,
            predictiveBitsVsOpportunity: logScoreBits(
                evaluated.records,
                baseline.records
            ),
            mseEquivalentBitsVsOpportunity: mseEquivalentBits(
                evaluated.records,
                baseline.records
            ),
            folds: evaluated.folds,
            _records: evaluated.records,
        };
    }
    if (models.marketPlusPromise && models.promiseOnly) {
        models.marketPlusPromise.incrementalMarketBitsAfterPromise = logScoreBits(
            models.marketPlusPromise._records,
            models.promiseOnly._records
        );
    }
    if (models.marketPlusPromise && models.marketOnly) {
        models.marketPlusPromise.incrementalPromiseBitsAfterMarket = logScoreBits(
            models.marketPlusPromise._records,
            models.marketOnly._records
        );
    }
    for (const model of Object.values(models)) delete model._records;
    return {
        opportunity: baseline.report,
        models,
    };
}

function evaluateMarketHold(market, promise) {
    const promiseById = new Map((promise.rows || [])
        .filter(row => row.evaluationKind === 'saved-source-level-oof')
        .map(row => [String(row.videoId), row]));
    const baseRows = (market.hooks || [])
        .filter(row => (
            finite(row.score?.coordinate)
            && finite(parseDate(row.published))
        ))
        .map(row => {
            const promiseRow = promiseById.get(String(row.videoId));
            const promise5 = promiseRow?.outputs?.absoluteRetention5sPercent;
            const promise20 = openingPoint(promiseRow || {}, 20)?.predicted;
            return {
                id: String(row.videoId),
                title: String(row.title || row.videoId),
                text: String(row.text || ''),
                source: 'tyler',
                publishedAt: parseDate(row.published),
                copyGroup: null,
                outcomes: row.outcomes || {},
                features: {
                    'published.ordinal': parseDate(row.published) / 86400000,
                    'market.coordinate': Number(row.score.coordinate),
                    'promise.absolute_ret5': number(promise5),
                    'promise.entry_retention20': number(promise20),
                },
            };
        });
    const groups = duplicateGroups(baseRows);
    baseRows.forEach((row, index) => {
        row.copyGroup = groups[index];
    });
    const targetDefinitions = {
        viewed_percent: {
            factor: 'packaging_entry',
            label: 'Viewed instead of swiped',
            unit: 'percentage points',
            signals: {
                marketOnly: ['market.coordinate'],
            },
        },
        retention_5s: {
            factor: 'attention_survival',
            label: 'Absolute retention at 5 seconds',
            unit: 'percentage points',
            signals: {
                marketOnly: ['market.coordinate'],
                promiseOnly: ['promise.absolute_ret5'],
                marketPlusPromise: [
                    'market.coordinate',
                    'promise.absolute_ret5',
                ],
            },
        },
        average_retention: {
            factor: 'attention_survival',
            label: 'Average percentage viewed',
            unit: 'percentage points',
            signals: {
                marketOnly: ['market.coordinate'],
            },
        },
        log_views: {
            factor: 'views_distribution',
            label: 'Observed views snapshot',
            unit: 'log10 views',
            signals: {
                marketOnly: ['market.coordinate'],
            },
        },
    };
    const targets = {};
    for (const [targetKey, definition] of Object.entries(targetDefinitions)) {
        const rows = baseRows
            .filter(row => finite(row.outcomes?.[targetKey]?.actual))
            .map(row => ({
                ...row,
                y: Number(row.outcomes[targetKey].actual),
            }));
        const rawThreshold = quantile(rows.map(row => row.y), 0.75);
        const rawRows = rows.map(row => ({
            key: `raw:${targetKey}:${row.id}`,
            id: row.id,
            fold: 'frozen-external-axis',
            actual: row.y,
            predicted: row.features['market.coordinate'],
            highLabel: row.y >= rawThreshold,
        }));
        const protocols = {
            groupedCopyHoldout: {
                mode: 'grouped',
                folds: balancedHashFolds(rows, 'copyGroup', 5),
            },
            forwardTime: {
                mode: 'forward',
                folds: forwardFolds(rows, {
                    initialFraction: 0.4,
                    blockCount: 4,
                }),
            },
        };
        const validations = {};
        for (const [protocol, protocolDefinition] of Object.entries(protocols)) {
            validations[protocol] = evaluateSignalModels(
                rows,
                protocolDefinition.folds,
                protocolDefinition.mode,
                definition.signals,
                {
                    controls: ['published.ordinal'],
                    includeOpportunity: true,
                    includeAge: false,
                    nonNegativeFeatures: ['market.coordinate'],
                }
            );
        }
        targets[targetKey] = {
            factor: definition.factor,
            label: definition.label,
            unit: definition.unit,
            n: rows.length,
            frozenZeroShotDiscrimination: regressionReport(rawRows).discrimination,
            validation: validations,
        };
    }

    const retention20Rows = baseRows
        .map(row => {
            const promiseRow = promiseById.get(row.id);
            const point = openingPoint(promiseRow || {}, 20);
            if (!point || !finite(row.features['promise.entry_retention20'])) return null;
            return {
                ...row,
                y: point.actual,
            };
        })
        .filter(Boolean);
    if (retention20Rows.length >= 40) {
        const protocols = {
            groupedCopyHoldout: {
                mode: 'grouped',
                folds: balancedHashFolds(retention20Rows, 'copyGroup', 5),
            },
            forwardTime: {
                mode: 'forward',
                folds: forwardFolds(retention20Rows, {
                    initialFraction: 0.4,
                    blockCount: 4,
                }),
            },
        };
        const validation = {};
        for (const [protocol, protocolDefinition] of Object.entries(protocols)) {
            validation[protocol] = evaluateSignalModels(
                retention20Rows,
                protocolDefinition.folds,
                protocolDefinition.mode,
                {
                    marketOnly: ['market.coordinate'],
                    promiseOnly: ['promise.entry_retention20'],
                    marketPlusPromise: [
                        'market.coordinate',
                        'promise.entry_retention20',
                    ],
                },
                {
                    controls: ['published.ordinal'],
                    includeOpportunity: true,
                    includeAge: false,
                    nonNegativeFeatures: ['market.coordinate'],
                }
            );
        }
        targets.retention_20s = {
            factor: 'attention_survival',
            label: 'Entry-indexed retention at 20 seconds',
            unit: 'percentage points',
            n: retention20Rows.length,
            validation,
        };
    }
    const duplicateSizes = Object.values(
        baseRows.reduce((output, row) => {
            output[row.copyGroup] = (output[row.copyGroup] || 0) + 1;
            return output;
        }, {})
    );
    return {
        population: {
            hooks: baseRows.length,
            copyGroups: new Set(baseRows.map(row => row.copyGroup)).size,
            duplicateGroups: duplicateSizes.filter(size => size > 1).length,
            externalAxisTrainingRows: market.externalTraining?.nonOwnedTrainingRows,
            externalAxisSourceGroups: market.externalTraining?.sourceGroups,
        },
        leakageBoundary: {
            axisOwnedOutcomesUsedToFitOrSelect: market.externalTraining?.ownedOutcomeLabelsUsedToFitOrSelectAxis,
            axisInput: market.rewardContract?.primaryInput,
            calibration: 'Rebuilt inside each owned grouped or expanding-time training fold. Stored owned OOF calibration is not reused.',
            copyIsolation: 'Outcome-blind 3-token-shingle connected components at Jaccard >= 0.80.',
        },
        externalAxisValidation: {
            selectedAlpha: market.externalTraining?.selectedAlpha,
            nestedGroupedSpearman: round(
                market.externalTraining?.selectedValidation?.heldoutSpearman
            ),
            directionMedianCosine: round(
                market.externalTraining?.selectedValidation?.directionStability?.medianCosine
            ),
            validationDesign: market.externalTraining?.selectedValidation?.validationDesign,
        },
        targets,
    };
}

function positiveBits(value, floor = 0.005) {
    return finite(value) && Number(value) > floor;
}

function buildOodLedger(analyses) {
    const ledger = [];
    const privateKeep = analyses.privateKeep;
    ledger.push({
        id: 'private-packaging-to-entry',
        factor: 'packaging_entry',
        target: 'observed keep rate',
        evaluation: 'unseen account + forward time',
        groupedBitsPerObservation: privateKeep.groupedUnseenAccount.predictiveBits?.bitsPerObservation,
        forwardBitsPerObservation: privateKeep.forwardTime.predictiveBits?.bitsPerObservation,
        eligible: true,
        status: (
            positiveBits(privateKeep.groupedUnseenAccount.predictiveBits?.bitsPerObservation)
            && positiveBits(privateKeep.forwardTime.predictiveBits?.bitsPerObservation)
        ) ? 'supported_ood_bits' : 'not_supported',
        caveat: 'Only four private accounts; forward backtest reuses present-day upstream representation geometry.',
    });

    const decisionViews = analyses.savedChannelViews.preUploadDecisionTrack;
    const groupedOpportunity = decisionViews.groupedUnseenChannel
        .opportunity.logScoreBitsVsControl;
    const forwardOpportunity = decisionViews.forwardTime
        .opportunity.logScoreBitsVsControl;
    ledger.push({
        id: 'saved-views-opportunity',
        factor: 'opportunity',
        target: 'log10 current public views snapshot',
        evaluation: 'unseen channel + forward time',
        groupedBitsPerObservation: groupedOpportunity?.bitsPerObservation,
        groupedPositiveFoldFraction: groupedOpportunity?.positiveFoldFraction,
        forwardBitsPerObservation: forwardOpportunity?.bitsPerObservation,
        forwardPositiveFoldFraction: forwardOpportunity?.positiveFoldFraction,
        eligible: true,
        status: (
            positiveBits(groupedOpportunity?.bitsPerObservation)
            && positiveBits(forwardOpportunity?.bitsPerObservation)
            && (groupedOpportunity?.positiveFoldFraction ?? 0) >= 0.75
            && decisionViews.groupedUnseenChannel
                .opportunity.metrics.discrimination.spearman > 0
        ) ? 'supported_ood_bits' : 'known_source_only',
        caveat: 'Source fixed effects add substantial forward information for channels with history, but fail directionally on unseen channels and therefore are not portable content alpha.',
    });
    for (const factor of FACTORS) {
        const grouped = decisionViews.groupedUnseenChannel.factorBits.contributions[factor];
        const forward = decisionViews.forwardTime.factorBits.contributions[factor];
        ledger.push({
            id: `saved-views-${factor}`,
            factor,
            target: 'log10 current public views snapshot',
            evaluation: 'unseen channel + forward time',
            groupedBitsPerObservation: grouped,
            forwardBitsPerObservation: forward,
            eligible: true,
            status: positiveBits(grouped) && positiveBits(forward)
                ? 'supported_ood_bits'
                : 'not_supported',
            caveat: 'Only three channels and no fixed-horizon views labels; scorer version was not persisted per video.',
        });
    }

    const marketTargets = analyses.marketHold.targets;
    for (const [target, result] of Object.entries(marketTargets)) {
        const grouped = result.validation?.groupedCopyHoldout
            ?.models?.marketOnly?.predictiveBitsVsOpportunity;
        const forward = result.validation?.forwardTime
            ?.models?.marketOnly?.predictiveBitsVsOpportunity;
        const zeroShotSpearman = result.frozenZeroShotDiscrimination?.spearman;
        const eligible = target !== 'retention_20s'
            || Boolean(result.validation);
        const groupedMse = result.validation?.groupedCopyHoldout
            ?.models?.marketOnly?.mseEquivalentBitsVsOpportunity;
        const forwardMse = result.validation?.forwardTime
            ?.models?.marketOnly?.mseEquivalentBitsVsOpportunity;
        const stable = (
            (grouped?.positiveFoldFraction ?? 0) >= 0.75
            && (forward?.positiveFoldFraction ?? 0) >= 0.75
        );
        ledger.push({
            id: `market-hold-${target}`,
            factor: result.factor,
            target,
            evaluation: 'axis trained on non-owned sources; owned copy-grouped calibration + forward time',
            groupedBitsPerObservation: grouped?.bitsPerObservation,
            groupedPositiveFoldFraction: grouped?.positiveFoldFraction,
            groupedMseBitsPerObservation: groupedMse?.bitsPerObservation,
            forwardBitsPerObservation: forward?.bitsPerObservation,
            forwardPositiveFoldFraction: forward?.positiveFoldFraction,
            forwardMseBitsPerObservation: forwardMse?.bitsPerObservation,
            frozenZeroShotSpearman: zeroShotSpearman ?? null,
            eligible,
            status: (
                eligible
                && positiveBits(grouped?.bitsPerObservation)
                && positiveBits(forward?.bitsPerObservation)
                && positiveBits(groupedMse?.bitsPerObservation)
                && positiveBits(forwardMse?.bitsPerObservation)
                && stable
                && (!finite(zeroShotSpearman) || zeroShotSpearman > 0)
            ) ? 'supported_ood_bits' : 'not_supported',
            caveat: 'The semantic direction is cross-source; absolute calibration is learned only from prior owned outcomes and is not zero-shot.',
        });
    }

    for (const [second, horizon] of Object.entries(analyses.promiseOpening.horizons)) {
        const bits = horizon.strictBlindExternalAccounts.predictiveBits?.bitsPerObservation;
        const discrimination = horizon.strictBlindExternalAccounts.model?.discrimination || {};
        const hasDiscrimination = (
            finite(discrimination.spearman)
            && discrimination.spearman > 0.05
            && finite(discrimination.spreadRatio)
            && discrimination.spreadRatio > 0.05
        );
        ledger.push({
            id: `promise-opening-${second}s`,
            factor: 'attention_survival',
            target: `entry-indexed retention at ${second}s`,
            evaluation: 'sealed strict-blind external accounts',
            groupedBitsPerObservation: bits,
            forwardBitsPerObservation: null,
            eligible: true,
            status: positiveBits(bits) && hasDiscrimination
                ? 'tentative_ood_bits'
                : 'not_supported',
            caveat: hasDiscrimination
                ? 'External-account test is sealed and overlap-controlled, but no genuinely forward-safe row export exists.'
                : 'Any MSE gain is a cohort-level calibration shift: the exported external prediction has insufficient cross-video spread to discriminate videos.',
        });
    }

    ledger.push({
        id: 'observed-retention-to-views',
        factor: 'packaging_entry + attention_survival',
        target: 'log10 current views',
        evaluation: 'single-account blocked and forward diagnostics',
        groupedBitsPerObservation: analyses.observedRetentionToViews
            .validation.blockedTimeGroups.predictiveBits?.bitsPerObservation,
        forwardBitsPerObservation: analyses.observedRetentionToViews
            .validation.forwardTime.predictiveBits?.bitsPerObservation,
        eligible: false,
        status: 'post_outcome_diagnostic_only',
        caveat: 'Observed keep and retention happen after upload. They cannot be used as pre-upload alpha.',
    });
    return ledger;
}

function summarizeLedger(ledger) {
    const supported = ledger.filter(row => row.status === 'supported_ood_bits');
    const tentative = ledger.filter(row => row.status === 'tentative_ood_bits');
    const knownSourceOnly = ledger.filter(row => row.status === 'known_source_only');
    return {
        supported: supported.map(row => row.id),
        tentative: tentative.map(row => row.id),
        knownSourceOnly: knownSourceOnly.map(row => row.id),
        rejectedOrDiagnostic: ledger
            .filter(row => ![
                'supported_ood_bits',
                'tentative_ood_bits',
                'known_source_only',
            ].includes(row.status))
            .map(row => row.id),
        conclusion: supported.length
            ? `${supported.length} factor-target relationships contribute positive predictive bits in both OOD/grouped and forward tests under this contract.`
            : 'No factor-target relationship contributes positive predictive bits in both OOD/grouped and forward tests under this contract.',
        promotionRule: 'Supported requires >0.005 bits/observation in both an OOD/grouped test and a forward-time test, with positive frozen discrimination when available.',
    };
}

async function main() {
    const started = Date.now();
    const localSources = Object.fromEntries(
        Object.entries(PATHS).map(([key, relativePath]) => [key, readJson(relativePath)])
    );
    const provenance = Object.values(localSources).map(source => source.provenance);
    const getR2 = createR2Loader(provenance);

    const predictor = localSources.predictor.data;
    const retentionStudy = localSources.privateRetention.data;
    const localTable = localSources.privateTable.data;
    const promise = localSources.promiseOpening.data;
    const market = localSources.marketHold.data;
    const opening20s = localSources.promise20s.data;
    const contract = localSources.featureContract.data;

    assert(
        predictor.provenance?.savedAxisTrainingIdOverlap === 0,
        'saved-channel validation IDs overlap the public axis corpus'
    );
    assert(
        market.externalTraining?.ownedOutcomeLabelsUsedToFitOrSelectAxis === false,
        'Market Hold used owned outcomes to fit or select its direction'
    );
    assert(
        promise.blindValidation?.status === 'sealed-before-outcome-join',
        'Promise blind predictions were not sealed before outcomes'
    );
    assert(
        promise.blindValidation?.outcomeFieldsPresentInBlindManifest === false,
        'Promise blind manifest contains outcomes'
    );
    assert(
        promise.blindValidation?.predictionInputsExcludeOutcomeFields === true,
        'Promise prediction inputs do not explicitly exclude outcomes'
    );

    const [savedRows, privateRows] = await Promise.all([
        loadSavedChannelRows(getR2, contract),
        loadPrivateRows(getR2, localTable),
    ]);
    const predictorSavedIds = new Set(
        (predictor.targets?.views?.points || []).map(row => String(row.id))
    );
    const loadedSavedIds = new Set(savedRows.map(row => row.id));
    const missingSavedIds = [...predictorSavedIds].filter(id => !loadedSavedIds.has(id));
    assert(
        missingSavedIds.length === 0,
        `${missingSavedIds.length} Predictor saved-channel rows are absent from canonical manifests`
    );
    const validatedSavedRows = savedRows.filter(row => predictorSavedIds.has(row.id));
    const validatedSavedIds = new Set(validatedSavedRows.map(row => row.id));

    const factorFeatures = factorFeatureNames(contract);
    const savedDecision = evaluateSavedViewsTrack(
        validatedSavedRows,
        factorFeatures,
        false
    );
    const savedMaturity = evaluateSavedViewsTrack(
        validatedSavedRows,
        factorFeatures,
        true
    );
    const analyses = {
        privateKeep: evaluatePrivateKeep(predictor, privateRows),
        savedChannelViews: {
            population: {
                rows: validatedSavedRows.length,
                channels: new Set(validatedSavedRows.map(row => row.source)).size,
                fixedOutcomeHorizon: false,
                medianSnapshotAgeDays: round(median(
                    validatedSavedRows.map(row => row.ageDays)
                )),
                scorerVersionPersistedPerVideo: predictor.provenance
                    ?.featureScorerVersionPersistedPerVideo,
                newerManifestRowsExcludedWithoutCertifiedAxisOverlap: (
                    savedRows.length - validatedSavedRows.length
                ),
            },
            factorInputs: factorFeatures,
            preUploadDecisionTrack: savedDecision,
            exposureAdjustedDiagnostic: savedMaturity,
            boundary: 'The age-adjusted track explains current snapshots but is not pre-upload alpha unless a future scoring horizon is fixed.',
        },
        promiseOpening: evaluatePromiseOpening(promise),
        marketHold: evaluateMarketHold(market, promise),
        observedRetentionToViews: evaluateObservedRetentionToViews(
            retentionStudy,
            localTable
        ),
    };
    const oodLedger = buildOodLedger(analyses);
    const bitFields = [
        'groupedBitsPerObservation',
        'groupedMseBitsPerObservation',
        'forwardBitsPerObservation',
        'forwardMseBitsPerObservation',
    ];
    for (const row of oodLedger) {
        for (const field of bitFields) {
            if (!finite(row[field])) continue;
            assert(
                Math.abs(row[field]) < 8,
                `${row.id} ${field}=${row[field]} indicates a degenerate residual scale`
            );
        }
    }

    const privateIds = new Set(privateRows.map(row => row.id));
    const promiseIds = new Set((promise.rows || []).map(row => String(row.videoId)));
    const marketIds = new Set((market.hooks || []).map(row => String(row.videoId)));
    const overlap = (left, right) => [...left].filter(value => right.has(value)).length;
    const result = {
        schema: 'business-world-factorized-validation-v1',
        generatedAt: new Date().toISOString(),
        elapsedSeconds: round((Date.now() - started) / 1000, 3),
        objective: 'Separate opportunity, packaging/entry, attention survival, and views/distribution as far as current artifacts permit, under leakage-safe grouped and forward validation.',
        factorContract: {
            opportunity: {
                inputs: 'Training-only source history; snapshot age appears only in a separately labeled maturity diagnostic.',
                causalClaim: false,
            },
            packaging_entry: {
                inputs: 'Visual, text, and together keep/viewed projections; Market Hold when the target is viewed percentage.',
                causalClaim: false,
            },
            attention_survival: {
                inputs: 'Visual, text, and together ret5 projections; frozen opening survival and Market Hold transfer.',
                causalClaim: false,
            },
            views_distribution: {
                inputs: 'Views, realistic-views, outlier, >10M, and views-novelty projections.',
                causalClaim: false,
            },
        },
        validationContract: {
            grouped: 'No source or outcome-blind copy group appears in both training and test.',
            forward: 'Every training publication timestamp is <= every test timestamp.',
            modelSelection: 'Ridge alpha is selected only inside each outer training fold.',
            opportunityPrior: 'Ridge-regularized source fixed effects are fit only on outer-training rows; an unseen source receives the intercept rather than a target encoding.',
            frozenDirection: 'Market Hold is constrained nonnegative during owned calibration; no fold may profit by reversing the externally frozen direction.',
            calibration: 'Bias, MAE, RMSE, calibration slope/intercept, and 80% interval coverage.',
            discrimination: 'R2, Pearson, Spearman, top-quartile AUC, and predicted/actual spread.',
            predictiveBits: 'Out-of-fold Gaussian log-score gain; direct frozen forecasts without train sigma use MSE-equivalent compression bits.',
            shapley: 'All factor orders are averaged exactly, preventing an arbitrary entry/attention/distribution ordering.',
        },
        leakageAudit: {
            passed: true,
            assertions: [
                'Saved-channel validation IDs have zero overlap with the public axis-training corpus.',
                'Market Hold direction used no owned outcome for fitting or selection.',
                'Promise strict-blind predictions were sealed before outcome join.',
                'Promise exact and conservative near-training overlaps are excluded.',
                'Likes, comments, shares, and observed views never enter a pre-upload factor model.',
                'Observed keep and retention enter only the explicitly ineligible mechanistic diagnostic.',
            ],
            identityOverlap: {
                privateVsPromise: overlap(privateIds, promiseIds),
                privateVsMarket: overlap(privateIds, marketIds),
                promiseVsMarket: overlap(promiseIds, marketIds),
                savedViewsVsPrivate: overlap(validatedSavedIds, privateIds),
                interpretation: 'Overlapping owned rows are one evidence family and are never counted as independent confirmations.',
            },
            unresolved: [
                'Saved-channel views are current snapshots, not fixed-horizon labels.',
                'Only three saved channels and four private-retention accounts exist.',
                'Saved-channel scorer/model version is not persisted per video.',
                'Present-day embedding geometry makes forward Predictor tests partial backtests.',
                'Promise has sealed external-account validation but no row-level forward-safe prediction export.',
            ],
            numericalSanity: {
                maximumAbsolutePredictiveBitsPerObservation: round(Math.max(
                    ...oodLedger.flatMap(row => bitFields
                        .map(field => row[field])
                        .filter(finite)
                        .map(Math.abs))
                )),
                guardrail: 'Every reported factor-level bit rate must be finite and below 8 bits/observation; larger values indicate a degenerate training residual scale.',
            },
        },
        artifactInventory: {
            privateRetention: {
                rows: privateRows.length,
                accounts: new Set(privateRows.map(row => row.source)).size,
            },
            savedChannelViews: {
                rows: validatedSavedRows.length,
                channels: new Set(validatedSavedRows.map(row => row.source)).size,
            },
            promiseOpening: {
                rows: (promise.rows || []).length,
                strictBlindEligible: (promise.rows || []).filter(row => row.strictBlindEligible).length,
                twentySecondTokens: opening20s.tokenCount,
                twentySecondComponents: opening20s.componentCount,
                twentySecondEdges: opening20s.edgeCount,
            },
            marketHold: {
                ownedHooks: (market.hooks || []).length,
                externalTrainingRows: market.externalTraining?.nonOwnedTrainingRows,
                externalSourceGroups: market.externalTraining?.sourceGroups,
            },
            predictor: predictor.coverage,
        },
        analyses,
        outOfDistributionPredictiveBits: {
            summary: summarizeLedger(oodLedger),
            ledger: oodLedger,
        },
        interpretationRules: [
            'A calibrated mean curve can have low MAE while containing zero discrimination.',
            'Positive retrospective R2 does not survive unless grouped/OOD and forward bits are also positive.',
            'Projected keep, retention, and views scores are correlated features, not independent outcomes.',
            'Post-upload keep/retention can locate the views bottleneck but cannot validate a pre-upload decision rule.',
            'Three-channel results are estimates for these channels, not a creator-population theorem.',
        ],
        provenance: provenance.sort((left, right) => left.source.localeCompare(right.source)),
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result));
    const outputBytes = fs.readFileSync(OUTPUT_PATH);
    process.stdout.write(`${JSON.stringify({
        output: path.relative(ROOT, OUTPUT_PATH),
        bytes: outputBytes.length,
        sha256: sha256(outputBytes),
        elapsedSeconds: result.elapsedSeconds,
        supported: result.outOfDistributionPredictiveBits.summary.supported,
        tentative: result.outOfDistributionPredictiveBits.summary.tentative,
    }, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    auc,
    duplicateGroups,
    evaluateMarketHold,
    evaluatePromiseOpening,
    evaluateSavedViewsTrack,
    fitRidge,
    forwardFolds,
    groupFolds,
    logScoreBits,
    regressionReport,
    shapleyBits,
};
