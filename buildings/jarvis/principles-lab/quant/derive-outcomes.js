#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
    finite,
    mean,
    median,
    quantile,
    variance,
    standardDeviation,
    correlation,
    spearman,
    rSquared,
    mae,
    deterministicFold,
    gunzipJson,
    gzipJson,
    hash,
    round,
} = require('./core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PANEL_PATH = path.join(__dirname, '.cache', 'unified-panel.json.gz');
const SEMANTIC_FAMILY_PATH = path.join(__dirname, '.cache', 'semantic-families.json.gz');
const TARGET_PATH = path.join(__dirname, '.cache', 'opportunity-targets.json.gz');
const STRICT_CLUSTER_PANEL_PATH = path.join(__dirname, '.cache', 'strict-cluster-panel.json');
const OUTPUT_PATH = path.join(__dirname, 'opportunity-adjustment.json');
const AGE_KNOT_DAYS = [7, 30, 90, 180, 365, 730];

function ageFeatures(ageDays) {
    const x = Math.log1p(Math.max(0, finite(ageDays, 0)));
    return [
        1,
        x,
        x * x,
        x * x * x,
        ...AGE_KNOT_DAYS.map(days => Math.max(0, x - Math.log1p(days))),
    ];
}

function solve(matrix, vector) {
    const size = vector.length;
    const augmented = matrix.map((row, index) => row.slice().concat(vector[index]));
    for (let column = 0; column < size; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < size; row += 1) {
            if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
        }
        if (Math.abs(augmented[pivot][column]) < 1e-12) continue;
        [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
        const divisor = augmented[column][column];
        for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
        for (let row = 0; row < size; row += 1) {
            if (row === column) continue;
            const factor = augmented[row][column];
            if (!factor) continue;
            for (let index = column; index <= size; index += 1) {
                augmented[row][index] -= factor * augmented[column][index];
            }
        }
    }
    return augmented.map((row, index) => (
        Number.isFinite(row[size]) ? row[size] : (index === 0 ? mean(vector) : 0)
    ));
}

function fitRidge(rows, lambda = 1e-3) {
    const width = ageFeatures(0).length;
    const gram = Array.from({ length: width }, () => Array(width).fill(0));
    const rhs = Array(width).fill(0);
    for (const row of rows) {
        const features = ageFeatures(row.ageDays);
        const target = row.outcomes.logViews;
        for (let left = 0; left < width; left += 1) {
            rhs[left] += features[left] * target;
            for (let right = 0; right < width; right += 1) {
                gram[left][right] += features[left] * features[right];
            }
        }
    }
    for (let index = 1; index < width; index += 1) gram[index][index] += lambda * rows.length;
    return solve(gram, rhs);
}

function predict(coefficients, ageDays) {
    return ageFeatures(ageDays).reduce((sum, value, index) => (
        sum + value * coefficients[index]
    ), 0);
}

function varianceComponents(rows) {
    const residualVariance = Math.max(1e-6, variance(rows.map(row => row.ageResidual)));
    const bySource = new Map();
    for (const row of rows) {
        if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, []);
        bySource.get(row.sourceId).push(row.ageResidual);
    }
    const sourceGroups = [...bySource.values()].filter(values => values.length >= 2);
    const sourceMeans = sourceGroups.map(values => mean(values));
    const samplingVariance = mean(sourceGroups.map(values => residualVariance / values.length));
    const sourceVariance = Math.max(
        residualVariance * 1e-4,
        variance(sourceMeans) - samplingVariance
    );
    return { residualVariance, sourceVariance };
}

function posteriorSourceEffect(history, components) {
    const precision = (
        (1 / components.sourceVariance)
        + (history.length / components.residualVariance)
    );
    const effect = (
        history.reduce((sum, row) => sum + row.ageResidual, 0)
        / components.residualVariance
    ) / precision;
    return {
        effect,
        variance: 1 / precision,
    };
}

function sourceMacro(rows, key) {
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.sourceId)) groups.set(row.sourceId, []);
        groups.get(row.sourceId).push(row[key]);
    }
    const centers = [...groups.values()].map(values => mean(values));
    return {
        sources: centers.length,
        mean: round(mean(centers)),
        standardDeviation: round(standardDeviation(centers)),
        p10: round(quantile(centers, 0.1)),
        p90: round(quantile(centers, 0.9)),
    };
}

function processFormat(format, inputRows, semanticFamilies) {
    const rows = inputRows
        .filter(row => (
            row.format === format
            && row.sourceId
            && finite(row.publishedSeconds) != null
            && finite(row.ageDays) != null
            && finite(row.outcomes?.logViews) != null
        ))
        .map(row => ({
            ...row,
            exactContentFamilyId: row.contentFamilyId,
            semanticFamilyId: semanticFamilies?.[row.videoId] || row.contentFamilyId,
        }));

    const foldModels = [];
    for (let fold = 0; fold < 5; fold += 1) {
        const training = rows.filter(row => deterministicFold(row.sourceId, 5) !== fold);
        foldModels.push(fitRidge(training));
    }
    for (const row of rows) {
        const fold = deterministicFold(row.sourceId, 5);
        row.agePrediction = predict(foldModels[fold], row.ageDays);
        row.ageResidual = row.outcomes.logViews - row.agePrediction;
    }
    const components = varianceComponents(rows);

    const bySource = new Map();
    for (const row of rows) {
        if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, []);
        bySource.get(row.sourceId).push(row);
    }
    for (const sourceRows of bySource.values()) {
        sourceRows.sort((left, right) => (
            left.publishedSeconds - right.publishedSeconds
            || left.videoId.localeCompare(right.videoId)
        ));
        const history = [];
        for (const row of sourceRows) {
            const eligibleHistory = history
                .filter(previous => (
                    previous.observationSeconds <= row.publishedSeconds
                    && previous.semanticFamilyId !== row.semanticFamilyId
                ));
            row.priorHistoryCount = eligibleHistory.length;
            if (eligibleHistory.length) {
                row.latestPriorObservedSeconds = Math.max(
                    ...eligibleHistory.map(previous => previous.observationSeconds)
                );
                const posterior = posteriorSourceEffect(eligibleHistory, components);
                row.historyCenter = posterior.effect;
                row.historyVariance = posterior.variance;
                row.opportunityPrediction = row.agePrediction + posterior.effect;
                row.creatorRelativeLift = row.ageResidual - posterior.effect;
                row.creatorRelativeZ = row.creatorRelativeLift / Math.sqrt(
                    components.residualVariance + posterior.variance
                );
                row.priorPercentile = (
                    eligibleHistory.filter(previous => previous.ageResidual <= row.ageResidual).length
                    + 0.5
                ) / (eligibleHistory.length + 1);
            }
            history.push(row);
        }
    }

    const eligible = rows.filter(row => finite(row.creatorRelativeLift) != null);
    const actual = eligible.map(row => row.outcomes.logViews);
    const agePredicted = eligible.map(row => row.agePrediction);
    const opportunityPredicted = eligible.map(row => row.opportunityPrediction);
    const lifts = eligible.map(row => row.creatorRelativeLift);
    const zScores = eligible.map(row => row.creatorRelativeZ);
    const ages = eligible.map(row => Math.log1p(row.ageDays));

    const targetRows = eligible.map(row => ({
        observationId: row.observationId,
        videoId: row.videoId,
        format,
        sourceId: row.sourceId,
        contentFamilyId: row.semanticFamilyId,
        exactContentFamilyId: row.exactContentFamilyId,
        publishedSeconds: row.publishedSeconds,
        observationSeconds: row.observationSeconds,
        ageDays: round(row.ageDays, 4),
        logViews: round(row.outcomes.logViews),
        agePrediction: round(row.agePrediction),
        priorHistoryCount: row.priorHistoryCount,
        latestPriorObservedSeconds: row.latestPriorObservedSeconds,
        sourceHistoryCenter: round(row.historyCenter),
        sourceHistoryPosteriorVariance: round(row.historyVariance),
        opportunityPrediction: round(row.opportunityPrediction),
        creatorRelativeLift: round(row.creatorRelativeLift),
        creatorRelativeZ: round(row.creatorRelativeZ),
        priorPercentile: round(row.priorPercentile),
        modalities: Object.fromEntries(Object.entries(row.modalities || {}).map(([modality, payload]) => [
            modality,
            {
                silent: Boolean(payload.silent),
                clusters: payload.clusters,
            },
        ])),
    }));

    return {
        targetRows,
        summary: {
            format,
            candidateRows: rows.length,
            eligibleRows: eligible.length,
            eligibleSources: new Set(eligible.map(row => row.sourceId)).size,
            eligibilityFraction: round(eligible.length / rows.length),
            foldPolicy: 'The global age spline is fit on four source folds and applied to the fifth. Creator opportunity uses only historically observable videos from the same source, excludes outcome-free semantic near-copy families, and never includes the target outcome in its baseline.',
            historyObservabilityRule: 'A prior video is usable only when its outcome observation time is no later than the target publication time.',
            sourceShrinkage: {
                model: 'normal-normal empirical Bayes',
                residualVariance: round(components.residualVariance),
                sourcePriorVariance: round(components.sourceVariance),
                minimumHistory: 1,
                maximumHistory: null,
            },
            ageModel: {
                features: ['log1p(ageDays)', 'polynomial degree 3', ...AGE_KNOT_DAYS.map(days => `hinge@${days}d`)],
                sourceHeldOutR2: round(rSquared(actual, agePredicted)),
                sourceHeldOutSpearman: round(spearman(actual, agePredicted)),
                maeLog10: round(mae(actual, agePredicted)),
            },
            opportunityModel: {
                strictlyPriorHistoryR2: round(rSquared(actual, opportunityPredicted)),
                strictlyPriorHistorySpearman: round(spearman(actual, opportunityPredicted)),
                maeLog10: round(mae(actual, opportunityPredicted)),
                incrementalR2OverAge: round(
                    rSquared(actual, opportunityPredicted) - rSquared(actual, agePredicted)
                ),
            },
            adjustedTarget: {
                meanLift: round(mean(lifts)),
                standardDeviationLift: round(standardDeviation(lifts)),
                p10Lift: round(quantile(lifts, 0.1)),
                p50Lift: round(quantile(lifts, 0.5)),
                p90Lift: round(quantile(lifts, 0.9)),
                meanZ: round(mean(zScores)),
                ageCorrelation: round(correlation(lifts, ages)),
                sourceMacro: sourceMacro(eligible, 'creatorRelativeLift'),
            },
        },
    };
}

async function main() {
    if (!fs.existsSync(PANEL_PATH)) {
        throw new Error(`Missing ${path.relative(ROOT, PANEL_PATH)}. Run quant/build-panel.js first.`);
    }
    const panel = gunzipJson(fs.readFileSync(PANEL_PATH));
    if (!fs.existsSync(SEMANTIC_FAMILY_PATH)) {
        throw new Error(`Missing ${path.relative(ROOT, SEMANTIC_FAMILY_PATH)}. Run quant/build_semantic_families.py first.`);
    }
    const semanticArtifact = gunzipJson(fs.readFileSync(SEMANTIC_FAMILY_PATH));
    const analyses = ['shorts', 'long'].map(format => processFormat(
        format,
        panel.rows,
        semanticArtifact.formats?.[format] || {}
    ));
    const targetRows = analyses.flatMap(row => row.targetRows);
    const targetArtifact = {
        schema: 'creator-relative-opportunity-targets-v2',
        generatedAt: new Date().toISOString(),
        snapshotRunId: panel.snapshotRunId,
        minimumPriorHistory: 1,
        maximumPriorHistory: null,
        semanticFamilyHash: semanticArtifact.contentHash,
        sourcePanelHash: hash(fs.readFileSync(PANEL_PATH)),
        rows: targetRows,
    };
    targetArtifact.contentHash = hash(JSON.stringify(targetArtifact));
    fs.writeFileSync(TARGET_PATH, gzipJson(targetArtifact));
    fs.writeFileSync(STRICT_CLUSTER_PANEL_PATH, JSON.stringify({
        schema: 'strict-cluster-outcome-panel-v1',
        snapshotRunId: panel.snapshotRunId,
        rows: targetRows.map(row => ({
            format: row.format,
            videoId: row.videoId,
            sourceId: row.sourceId,
            strictEligible: true,
            stored: true,
            rechecked: false,
            publishedSeconds: row.publishedSeconds,
            observedSeconds: row.observationSeconds,
            history: {
                count: row.priorHistoryCount,
                latestObservedSeconds: row.latestPriorObservedSeconds,
            },
            outcomes: {
                opportunityResidual: row.creatorRelativeLift,
            },
        })),
    }));

    const output = {
        schema: 'creator-relative-opportunity-adjustment-v2',
        generatedAt: new Date().toISOString(),
        estimand: 'Historically timed log views minus a source-held-out age expectation and an empirical-Bayes creator effect built only from non-duplicate outcomes observed before the target was published.',
        targetAvailability: 'Selected-corpus observational target with historically observable creator context. It is not impression-normalized or causal package lift.',
        leakageBoundary: [
            'The target video outcome is never used in its opportunity baseline.',
            'The age curve excludes the target source entirely.',
            'Only same-source outcomes observed before the target publication contribute to source opportunity.',
            'Outcome-free exact and semantic near-copy families are excluded from source history.',
            'Current subscribers, likes, comments, projected scores, and future same-source videos are excluded.',
        ],
        formats: analyses.map(row => row.summary),
        targetRows: targetRows.length,
        targetPath: path.relative(ROOT, TARGET_PATH),
        strictClusterPanelPath: path.relative(ROOT, STRICT_CLUSTER_PANEL_PATH),
        sourcePanelHash: hash(fs.readFileSync(PANEL_PATH)),
        targetHash: targetArtifact.contentHash,
        semanticFamilyHash: semanticArtifact.contentHash,
        falsificationRule: 'A content abstraction must add positive source-macro predictive value for creator-relative lift in fold-local rolling-origin, unseen-creator, and family-OOD tests. Pooled raw-view association is insufficient.',
    };
    output.contentHash = hash(JSON.stringify(output));
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
