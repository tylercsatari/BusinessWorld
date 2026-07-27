'use strict';

const contract = require('./saved-channel-feature-contract.json');

const VERSION = 1;
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
            id: point.id,
            accountId: point.accountId,
        }));
    if (!observed.length) return { n: 0 };
    const actual = observed.map(point => point.actual);
    const predicted = observed.map(point => point.predicted);
    const residual = predicted.map((value, index) => value - actual[index]);
    const actualMean = average(actual);
    const sse = residual.reduce((sum, value) => sum + value * value, 0);
    const baselineSse = actual.reduce((sum, value) => sum + (value - actualMean) ** 2, 0);
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

function buildScope(rows, key) {
    const scoped = key === 'pooled' ? rows : rows.filter(row => row.accountId === key);
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
            const row = {
                id,
                channelId: source.channelId,
                accountId: source.accountId,
                accountName: source.accountName,
                title: String(saved.title || privateVideo.title || id),
                publishedAt: parseDate(privateVideo.published || saved.published),
                duration: number(privateVideo.duration_s != null ? privateVideo.duration_s : saved.duration),
                subscribers: number(saved.subscribers),
                transcript: String(saved.transcript || ''),
                storedRaw: storedCells.map(cell => cell.raw),
                storedPercentile: storedCells.map(cell => cell.percentile),
                blindFeatureNames,
                blindVideoHeldOut,
                blindAccountHeldOut,
                actual: {
                    keep: actualKeep(privateVideo),
                    ret5: number(privateVideo.ret5),
                    averageRetention: number(privateVideo.avg_retention),
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
        validationContract: {
            stored: 'Exact 21 values persisted by the channel scorer. They are shown for diagnosis, never promoted to blind evidence.',
            videoHeldOut: blindInputs.videoHeldOutProtocol || 'The evaluated video is excluded from every target-aligned fit.',
            accountHeldOut: blindInputs.accountHeldOutProtocol || 'The evaluated account is excluded from every target-aligned fit.',
            publicViewsAxis: 'The production one-component PLS direction and rank-to-outcome calibration are refit on public corpus videos after excluding private rows, saved rows, and every video from each validation creator.',
            forwardTime: 'Training labels precede test labels, but the present-day representation remains fixed; this is a partial backtest.',
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
