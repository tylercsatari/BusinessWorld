#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_PATH = path.join(__dirname, 'artifact.json');

const PATHS = {
    system: 'buildings/jarvis/principles-lab/system-analysis.json',
    operations: 'buildings/jarvis/operations-lab/.cache/principles85.json',
    predictor: 'buildings/jarvis/predictor-lab/results.json',
    promiseManifest: 'buildings/jarvis/promise-lab/.cache/manifest.json',
    promiseDiscovery: 'buildings/jarvis/promise-lab/.cache/discovery-summary.json',
    promisePartition: 'buildings/jarvis/promise-lab/.cache/canonical-partition-model.json',
    promiseQuality: 'buildings/jarvis/promise-lab/.cache/hook-quality.json',
    promiseForward: 'buildings/jarvis/promise-lab/.cache/forward-response.json',
    pooledOpening: 'buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json',
    pooledBlind: 'buildings/jarvis/promise-lab/.cache/pooled-opening-blind-manifest.json',
    openingContext: 'buildings/jarvis/promise-lab/.cache/opening-context-study.json',
    opening20s: 'buildings/jarvis/promise-lab/.cache/opening-20s.json',
    clusterOutcomes: 'buildings/jarvis/promise-lab/.cache/cluster-outcomes.json',
    marketReward: 'buildings/jarvis/promise-lab/.cache/market-reward.json',
    longTitlePrior: 'buildings/jarvis/promise-lab/.cache/long-title-prior.json',
    retention: 'buildings/jarvis/retention-study/retention_study.json',
    tribe: 'buildings/jarvis/retention-study/tribe-corr.json',
    graph: 'buildings/jarvis/graph_compact.json',
    indicators: 'buildings/jarvis/indicators_compact.json',
    legacyExperiments: 'buildings/jarvis/experiments_log_compact.json',
    legacyDerived: 'buildings/jarvis/derived_experiments_compact.json',
    legacyRetention: 'buildings/jarvis/retention-patterns.json',
    legacyPredictor: 'buildings/jarvis/prediction-model.json',
    bridge: 'buildings/jarvis/bridge_top_principles.json',
    quantSnapshot: 'buildings/jarvis/principles-lab/quant/snapshot-manifest.json',
    quantIntegrity: 'buildings/jarvis/principles-lab/quant/snapshot-integrity.json',
    quantReconstructed:
        'buildings/jarvis/principles-lab/quant/reconstructed-geometry-summary.json',
    quantSemanticFamilies:
        'buildings/jarvis/principles-lab/quant/semantic-family-summary.json',
    quantPanel: 'buildings/jarvis/principles-lab/quant/panel-summary.json',
    quantOpportunity:
        'buildings/jarvis/principles-lab/quant/opportunity-adjustment.json',
    quantRawValidation:
        'buildings/jarvis/principles-lab/quant/raw-embedding-validation.json',
    quantNestedValidation:
        'buildings/jarvis/principles-lab/quant/nested-outcome-validation.json',
    quantCreatorDelta:
        'buildings/jarvis/principles-lab/quant/within-creator-delta-validation.json',
    quantSensitivity:
        'buildings/jarvis/principles-lab/quant/baseline-sensitivity-validation.json',
    quantClusterOutcomes:
        'buildings/jarvis/principles-lab/quant/cluster-outcomes-adjusted.json',
    quantClusterInvariance:
        'buildings/jarvis/principles-lab/quant/cluster-invariance.json',
    quantFactorized:
        'buildings/jarvis/principles-lab/quant/factorized-validation.json',
    quantPromotion:
        'buildings/jarvis/principles-lab/quant/promotion-ledger.json',
};

const EVIDENCE_KINDS = [
    {
        id: 'observed_input',
        label: 'Observed input',
        definition: 'Media, title, transcript, duration, source, and upload time actually observed.',
        color: '#67d5ff',
    },
    {
        id: 'observed_outcome',
        label: 'Observed outcome',
        definition: 'CTR, keep, retention, or views measured at an explicit horizon.',
        color: '#37d99a',
    },
    {
        id: 'projected_score',
        label: 'Projected score',
        definition: 'An embedding axis, percentile, estimated views, novelty, or class probability. It is a feature, not independent truth.',
        color: '#f3c95f',
    },
    {
        id: 'generated_candidate',
        label: 'Generated candidate',
        definition: 'A generated hook, idea, thumbnail, title, or grind result that has not been published and measured.',
        color: '#bd94ff',
    },
    {
        id: 'model_counterfactual',
        label: 'Model counterfactual',
        definition: 'A deletion, swap, reorder, or recomposition used to probe a model. It is not a randomized human experiment.',
        color: '#ff9d70',
    },
    {
        id: 'post_outcome_indicator',
        label: 'Post-outcome indicator',
        definition: 'Likes, comments, outlier ratios, endpoint-conditioned corrections, and descendants of outcomes.',
        color: '#ff6f87',
    },
];

const TRANSFORMATIONS = [
    { id: 'outcome_blind', label: 'Outcome-blind discovery', family: 'selection' },
    { id: 'algorithm', label: 'Algorithm family', family: 'geometry' },
    { id: 'resolution', label: 'Resolution / k', family: 'geometry' },
    { id: 'modality', label: 'Visual / text / together', family: 'representation' },
    { id: 'resample', label: 'Grouped resampling', family: 'stability' },
    { id: 'confounds', label: 'Confound controls', family: 'causal' },
    { id: 'source', label: 'Unseen source', family: 'distribution' },
    { id: 'time', label: 'Forward time', family: 'distribution' },
    { id: 'format', label: 'Shorts / Long transfer', family: 'distribution' },
    { id: 'prospective', label: 'Prospective outcome', family: 'prediction' },
];

const LEVELS = [
    {
        id: 'taxonomy',
        label: 'Taxonomy',
        definition: 'A reproducible organization of observations. It does not yet predict an unseen outcome.',
    },
    {
        id: 'mechanism',
        label: 'Mechanism',
        definition: 'A reproducible relation inside one bounded setting.',
    },
    {
        id: 'local_invariant',
        label: 'Local invariant',
        definition: 'Survives resampling, algorithms, and perturbations inside one corpus.',
    },
    {
        id: 'regional_invariant',
        label: 'Regional invariant',
        definition: 'Survives unseen sources or later time inside one format.',
    },
    {
        id: 'domain_invariant',
        label: 'Domain invariant',
        definition: 'Survives a genuinely distinct corpus or Shorts/Long format change.',
    },
    {
        id: 'universal_invariant',
        label: 'Universal invariant',
        definition: 'Survives independent domains and prospective intervention. Nothing in this artifact reaches this level.',
    },
];

function readJson(relativePath, required = true) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
        if (required) throw new Error(`Missing required source: ${relativePath}`);
        return null;
    }
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    const bytes = fs.readFileSync(absolutePath);
    const stats = fs.statSync(absolutePath);
    return {
        id: `local:${relativePath}`,
        location: 'local',
        path: relativePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
        modifiedAt: stats.mtime.toISOString(),
    };
}

function finite(value, fallback = null) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function round(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return null;
    return Number(Number(value).toFixed(digits));
}

function mean(values) {
    const rows = values.filter(Number.isFinite);
    return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function correlation(left, right) {
    if (left.length !== right.length || left.length < 3) return null;
    const leftMean = mean(left);
    const rightMean = mean(right);
    let numerator = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index] - leftMean;
        const b = right[index] - rightMean;
        numerator += a * b;
        leftSum += a * a;
        rightSum += b * b;
    }
    return leftSum > 0 && rightSum > 0
        ? numerator / Math.sqrt(leftSum * rightSum)
        : null;
}

function ranks(values) {
    const indexed = values.map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value);
    const output = new Array(values.length);
    let cursor = 0;
    while (cursor < indexed.length) {
        let end = cursor + 1;
        while (end < indexed.length && indexed[end].value === indexed[cursor].value) end += 1;
        const averageRank = (cursor + end - 1) / 2;
        for (let index = cursor; index < end; index += 1) {
            output[indexed[index].index] = averageRank;
        }
        cursor = end;
    }
    return output;
}

function spearman(left, right) {
    return correlation(ranks(left), ranks(right));
}

function marketTransfer(marketReward) {
    const rows = marketReward.hooks || [];
    const targets = {
        viewedPercent: 'viewed_percent',
        retention5s: 'retention_5s',
        averageRetention: 'average_retention',
        logViews: 'log_views',
    };
    return Object.fromEntries(Object.entries(targets).map(([label, target]) => {
        const pairs = rows
            .map(row => [
                finite(row.score?.coordinate),
                finite(row.outcomes?.[target]?.actual),
            ])
            .filter(pair => pair.every(Number.isFinite));
        return [label, {
            n: pairs.length,
            pearson: round(correlation(
                pairs.map(pair => pair[0]),
                pairs.map(pair => pair[1])
            ), 6),
            spearman: round(spearman(
                pairs.map(pair => pair[0]),
                pairs.map(pair => pair[1])
            ), 6),
        }];
    }));
}

function countToken(relativePath, token) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    const descriptor = fs.openSync(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let carry = '';
    let count = 0;
    let bytesRead = 0;
    try {
        do {
            bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
            let offset = 0;
            while ((offset = text.indexOf(token, offset)) !== -1) {
                count += 1;
                offset += token.length;
            }
            carry = text.slice(-(token.length - 1));
        } while (bytesRead);
    } finally {
        fs.closeSync(descriptor);
    }
    return count;
}

function compactMetrics(metrics) {
    if (!metrics) return null;
    const keys = [
        'n', 'r2', 'pearson', 'spearman', 'mae', 'rmse',
        'calibrationSlope', 'calibrationIntercept', 'medianFactorError',
    ];
    return Object.fromEntries(keys
        .filter(key => Number.isFinite(Number(metrics[key])))
        .map(key => [key, round(Number(metrics[key]), 5)]));
}

function test(id, status, value, detail, sourceIds, extra = {}) {
    return {
        id,
        status,
        value,
        detail,
        sourceIds,
        ...extra,
    };
}

function invariant({
    id,
    title,
    headline,
    claim,
    level,
    status,
    scope,
    implication,
    tests,
    systems,
    confounds = [],
    nextFalsifier,
    boundary,
}) {
    const counts = tests.reduce((output, row) => {
        output[row.status] = (output[row.status] || 0) + 1;
        return output;
    }, {});
    return {
        id,
        title,
        headline,
        claim,
        level,
        status,
        scope,
        implication,
        tests,
        testCounts: counts,
        systems,
        confounds,
        nextFalsifier,
        boundary,
    };
}

function surfaceInventory({
    system,
    predictor,
    operations,
    promiseManifest,
    promiseDiscovery,
    promiseQuality,
    promiseForward,
    pooledOpening,
    marketReward,
    retention,
    tribe,
    graph,
    indicators,
    legacyExperimentCount,
    legacyDerivedCount,
}) {
    const shorts = system.databases.find(row => row.format === 'shorts');
    const long = system.databases.find(row => row.format === 'long');
    return [
        {
            id: 'shorts_library',
            area: 'Shorts Quant',
            section: 'Library + Raw',
            status: 'ingested',
            observations: shorts.records,
            accounts: shorts.channels,
            evidenceKinds: ['observed_input', 'observed_outcome', 'projected_score'],
            summary: 'Public Shorts corpus, current view snapshots, media, six supervised/unsupervised projections, and four cluster resolutions per modality.',
            sourceIds: ['r2:library/db.json', 'r2:raw/visual/map.json', 'r2:raw/text/map.json', 'r2:raw/together/map.json'],
        },
        {
            id: 'long_library',
            area: 'Long Quant',
            section: 'Library + Raw',
            status: 'ingested',
            observations: long.records,
            accounts: long.channels,
            evidenceKinds: ['observed_input', 'observed_outcome', 'projected_score'],
            summary: 'Public long-form title/thumbnail corpus with visual, text, and together maps.',
            sourceIds: ['r2:longform/db.json', 'r2:raw-long/visual/map.json', 'r2:raw-long/text/map.json', 'r2:raw-long/together/map.json'],
        },
        {
            id: 'shorts_prediction',
            area: 'Shorts Quant',
            section: 'Prediction + Relationship Atlas',
            status: predictor.artifactState?.complete ? 'ingested' : 'partial',
            observations: finite(predictor.targets?.keep?.n, 0) + finite(predictor.targets?.views?.n, 0),
            accounts: finite(predictor.targets?.keep?.accounts?.length, 0) + finite(predictor.coverage?.savedChannels, 0),
            evidenceKinds: ['observed_input', 'observed_outcome', 'projected_score'],
            summary: 'Private keep labels, saved-channel public views, feature search, calibration, forward-time diagnostics, and Long-to-Short transfer.',
            sourceIds: ['local:buildings/jarvis/predictor-lab/results.json'],
        },
        {
            id: 'shorts_experiments',
            area: 'Shorts Quant',
            section: 'Experiments',
            status: 'ingested_as_candidate_store',
            observations: finite(operations.source?.n, 0),
            accounts: null,
            evidenceKinds: ['generated_candidate', 'projected_score'],
            summary: 'Saved hooks, generated hooks, channel scoring, score-from-link, and grind outputs. Generated rows are not outcome validation until published.',
            sourceIds: ['local:buildings/jarvis/operations-lab/.cache/principles85.json'],
        },
        {
            id: 'operations',
            area: 'Shorts Quant',
            section: 'Operations',
            status: 'ingested',
            observations: finite(operations.source?.n, 0),
            accounts: finite(operations.source?.broadCorpus?.observedUniqueGroups, 0),
            evidenceKinds: ['observed_input', 'projected_score', 'observed_outcome'],
            summary: `${finite(operations.method?.partitionSummary?.partitionsTested, 0).toLocaleString()} partitions across ${Object.keys(operations.method?.partitionSummary?.resolutions || {}).length} descriptor resolutions; labels remain projected-score discoveries.`,
            sourceIds: ['local:buildings/jarvis/operations-lab/.cache/principles85.json'],
        },
        {
            id: 'promise_lattice',
            area: 'Shorts Quant',
            section: 'Promise Lab / Opening Library',
            status: 'ingested',
            observations: finite(promiseManifest.counts?.openings, promiseDiscovery.hooks),
            accounts: 1,
            evidenceKinds: ['observed_input', 'observed_outcome', 'model_counterfactual'],
            summary: `${finite(promiseManifest.counts?.savedProjectionPoints, 0).toLocaleString()} contiguous spans, variable exact-cover components, sequence/context graph, retention-response tests, and a frozen external-text Market Hold transfer.`,
            sourceIds: [
                'local:buildings/jarvis/promise-lab/.cache/manifest.json',
                'local:buildings/jarvis/promise-lab/.cache/hook-quality.json',
                'local:buildings/jarvis/promise-lab/.cache/forward-response.json',
            ],
        },
        {
            id: 'pooled_openings',
            area: 'Shorts Quant',
            section: 'Pooled Opening Validation',
            status: 'ingested',
            observations: finite(pooledOpening.sources, 0),
            accounts: finite(pooledOpening.accounts?.length, 0),
            evidenceKinds: ['observed_input', 'observed_outcome', 'projected_score'],
            summary: 'Sealed-before-outcome pooled curve forecasts across four accounts, reported separately for calibration and discrimination.',
            sourceIds: ['local:buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json'],
        },
        {
            id: 'retention',
            area: 'Shorts Quant',
            section: 'Retention',
            status: 'ingested',
            observations: finite(retention.meta?.n, 0),
            accounts: 1,
            evidenceKinds: ['observed_outcome', 'post_outcome_indicator'],
            summary: 'Observed keep, duration, retention shape, and views relationships on the owned-channel cohort.',
            sourceIds: ['local:buildings/jarvis/retention-study/retention_study.json'],
        },
        {
            id: 'tribe',
            area: 'Shorts Quant',
            section: 'Tribe',
            status: 'ingested_as_diagnostic',
            observations: finite(tribe.n, 0),
            accounts: 1,
            evidenceKinds: ['observed_input', 'observed_outcome', 'post_outcome_indicator'],
            summary: `${finite(tribe.indicatorIds?.length, 0)} brain-region/network indicators on a Main-account subset. Outcome-derived realviews is quarantined from pre-upload validation.`,
            sourceIds: ['local:buildings/jarvis/retention-study/tribe-corr.json'],
        },
        {
            id: 'long_experiments',
            area: 'Long Quant',
            section: 'Experiments + Channel Grind',
            status: 'candidate_store_only',
            observations: null,
            accounts: null,
            evidenceKinds: ['generated_candidate', 'projected_score'],
            summary: 'Idea, title, thumbnail generation, scoring, saved runs, and threshold grinding. These test model behavior, not realized audience outcomes.',
            sourceIds: [],
        },
        {
            id: 'legacy_research',
            area: 'Jarvis',
            section: 'Analytical / Variables / Mechanisms / Knowledge / Resolution',
            status: 'hypothesis_registry',
            observations: finite(graph.nodes?.length, 0),
            accounts: null,
            evidenceKinds: ['post_outcome_indicator'],
            summary: `${finite(indicators.length, 0).toLocaleString()} compact indicators, ${legacyExperimentCount.toLocaleString()} exploratory runs, and ${legacyDerivedCount.toLocaleString()} derived interactions. This is one adaptive discovery universe, not independent replication.`,
            sourceIds: [
                'local:buildings/jarvis/graph_compact.json',
                'local:buildings/jarvis/indicators_compact.json',
                'local:buildings/jarvis/experiments_log_compact.json',
                'local:buildings/jarvis/derived_experiments_compact.json',
            ],
        },
        {
            id: 'model_workspaces',
            area: 'Jarvis',
            section: 'Idea Model / Hook Model / Brain / Autoresearch',
            status: 'operational_not_validation',
            observations: null,
            accounts: null,
            evidenceKinds: ['generated_candidate', 'projected_score'],
            summary: 'Training, generation, candidate queues, autonomous search, and research orchestration. They produce hypotheses and actions; they cannot validate themselves.',
            sourceIds: [],
        },
        {
            id: 'tactical_meta',
            area: 'Jarvis',
            section: 'Tactical / Project Ideas / Meta-Architecture',
            status: 'knowledge_surface',
            observations: null,
            accounts: null,
            evidenceKinds: [],
            summary: 'Human-facing plans, rules, and architecture. Included in the system map, excluded from statistical confirmation.',
            sourceIds: [],
        },
    ];
}

function buildModels({ system, predictor, promisePartition, promiseQuality, promiseForward, pooledOpening, marketReward, longTitlePrior, clusterOutcomes, operations, retention }) {
    const mapRows = system.rawMaps.flatMap(map => map.partitions.map(partition => ({
        map: map.id,
        k: partition.clusterCount,
        globalEta: partition.global.viewsEtaSquared,
        sourceCenteredEta: partition.sourceTransfer.sourceCenteredClusterEtaSquared,
        creatorFoldR2: partition.sourceTransfer.creatorFoldR2,
    })));
    const pooled20 = pooledOpening.evaluation?.allPooled?.fixedHorizons?.['20']
        || pooledOpening.evaluation?.allPooled?.fixed20Second;
    const keepUnseen = predictor.targets?.keep?.stressTests?.find(row => /unseen-account/i.test(row.label));
    const viewsUnseen = predictor.targets?.views?.stressTests?.find(row => /unseen-channel/i.test(row.label));
    const marketMetrics = marketTransfer(marketReward);
    return [
        {
            id: 'raw_cluster_views',
            target: 'Public view snapshot',
            role: 'Cluster outcome association',
            status: 'taxonomy_not_portable_predictor',
            development: {
                rows: mapRows.length,
                strongestGlobalEta: round(Math.max(...mapRows.map(row => row.globalEta || 0))),
            },
            validation: {
                strongestCreatorFoldR2: round(Math.max(...mapRows.map(row => row.creatorFoldR2 || 0))),
                weakestCreatorFoldR2: round(Math.min(...mapRows.map(row => row.creatorFoldR2 || 0))),
            },
            boundary: 'Outcome-blind clusters organize content, but cluster means do not rank lift inside unseen creators.',
            rows: mapRows,
        },
        {
            id: 'shorts_keep_predictor',
            target: 'Observed keep rate',
            role: 'Pre-upload ranking',
            status: predictor.targets?.keep?.decisionStatus || 'unknown',
            development: compactMetrics(predictor.targets?.keep?.metrics),
            contentOnly: compactMetrics(predictor.targets?.keep?.contentOnlyMetrics),
            withinSource: compactMetrics(predictor.targets?.keep?.withinSourceMetrics),
            forwardTime: compactMetrics(predictor.targets?.keep?.prospectiveMetrics),
            unseenSource: compactMetrics(keepUnseen?.metrics),
            boundary: predictor.targets?.keep?.prospectiveValidation,
        },
        {
            id: 'shorts_views_predictor',
            target: 'Log10 current public views',
            role: 'Pre-upload ranking',
            status: predictor.targets?.views?.decisionStatus || 'unknown',
            development: compactMetrics(predictor.targets?.views?.metrics),
            contentOnly: compactMetrics(predictor.targets?.views?.contentOnlyMetrics),
            withinSource: compactMetrics(predictor.targets?.views?.withinSourceMetrics),
            forwardTime: compactMetrics(predictor.targets?.views?.prospectiveMetrics),
            unseenSource: compactMetrics(viewsUnseen?.metrics),
            boundary: 'Current view snapshots mix content, creator opportunity, age, and distribution. Fixed-age outcomes are not yet available.',
        },
        {
            id: 'long_to_short_transfer',
            target: 'Shorts log views',
            role: 'Cross-format transfer',
            status: 'failed',
            modalities: Object.fromEntries(Object.entries(
                predictor.corpusBenchmark?.crossDomainLongForm?.modalities || {}
            ).map(([modality, row]) => [modality, compactMetrics(row.metrics)])),
            boundary: predictor.corpusBenchmark?.crossDomainLongForm?.description,
        },
        {
            id: 'promise_boundary',
            target: 'Outcome-blind component boundary',
            role: 'Structural segmentation',
            status: 'local_geometry_supported',
            development: {
                heldoutAuc: finite(promisePartition.boundaryModel?.heldoutAuc),
                heldoutAveragePrecision: finite(promisePartition.boundaryModel?.heldoutAveragePrecision),
                components: finite(promiseQuality.audit?.componentRows, promiseQuality.components?.length),
                hooks: finite(promiseQuality.model?.trainingHooks, 208),
            },
            boundary: promisePartition.categoryClaimStatus,
        },
        {
            id: 'promise_quality',
            target: 'Hook retention factor',
            role: 'Whole-hook and component score',
            status: promiseQuality.model?.validationStatus || 'diagnostic',
            development: {
                heldoutSpearman: finite(promiseQuality.model?.heldoutSpearman),
                heldoutPearson: finite(promiseQuality.model?.heldoutPearson),
                permutationP: finite(promiseQuality.model?.rankPermutationP),
            },
            forwardTime: {
                spearman: finite(promiseQuality.model?.chronologicalHeldoutSpearman),
                permutationP: finite(promiseQuality.model?.chronologicalRankPermutationP),
            },
            boundary: 'A frozen segmentation can be structurally useful even when its outcome axis does not survive chronology.',
        },
        {
            id: 'promise_forward_response',
            target: 'Forward retention response after a spoken component',
            role: 'Component timing',
            status: promiseForward.validationStatus,
            development: {
                wholeHookSpearman: finite(promiseForward.wholeHookModel?.heldoutSpearman),
                componentBalancedSpearman: finite(promiseForward.componentModel?.heldoutCategoryBalancedSpearman),
                selectedLagSeconds: finite(promiseForward.metricContract?.selectedLagSeconds),
                processingLagSupported: Boolean(promiseForward.deconfoundingAudit?.processingLagSupported),
            },
            boundary: promiseForward.categoryClaimStatus,
        },
        {
            id: 'pooled_opening_curve',
            target: 'Entry-indexed retention curve',
            role: 'Curve calibration and video discrimination',
            status: 'calibrated_mean_not_discriminative',
            development: {
                videos: finite(pooledOpening.sources),
                accounts: finite(pooledOpening.accounts?.length),
                curveMaePoints: finite(pooledOpening.evaluation?.allPooled?.sourceEqualCurveMAEPercentagePoints),
            },
            fixed20Second: pooled20 ? {
                videos: finite(pooled20.videos),
                predictedMean: finite(pooled20.predictedMeanPercent),
                actualMean: finite(pooled20.actualMeanPercent),
                mae: finite(pooled20.maePercentagePoints),
                predictedSd: finite(pooled20.predictedStandardDeviationPercent),
                actualSd: finite(pooled20.actualStandardDeviationPercent),
                pearson: finite(pooled20.pearson),
                spearman: finite(pooled20.spearman),
                r2: finite(pooled20.r2AgainstSecondMean),
            } : null,
            boundary: 'Mean trajectory accuracy and between-video discrimination are separate estimands.',
        },
        {
            id: 'market_hold_transfer',
            target: 'Owned-hook retention from frozen external text market axis',
            role: 'Cross-source semantic transfer',
            status: marketReward.status,
            development: {
                externalTrainingRows: finite(marketReward.externalTraining?.nonOwnedTrainingRows),
                externalSourceGroups: finite(marketReward.externalTraining?.sourceGroups),
                ownedHooks: finite(marketReward.audit?.ownedHooks),
            },
            validation: marketMetrics,
            boundary: marketReward.rewardContract?.claimBoundary,
        },
        {
            id: 'long_title_prior',
            target: 'Long-form title log views',
            role: 'Independent title-market prior',
            status: 'random_holdout_only',
            development: {
                rows: finite(longTitlePrior.corpus?.labeledTitleRecords),
                coverage: finite(longTitlePrior.corpus?.embeddedCoverageFraction),
            },
            validation: {
                policy: longTitlePrior.validation?.policy,
                r2: finite(longTitlePrior.validation?.heldoutR2),
                pearson: finite(longTitlePrior.validation?.heldoutPearson),
                spearman: finite(longTitlePrior.validation?.heldoutSpearman),
                rmse: finite(longTitlePrior.validation?.heldoutRMSELog10Views),
            },
            boundary: longTitlePrior.claimBoundary,
        },
        {
            id: 'promise_cluster_outcomes',
            target: 'Outcomes conditioned on the four Promise clusters',
            role: 'Wide cluster-outcome search',
            status: 'failed_chronological_validation',
            development: {
                experiments: finite(clusterOutcomes.experimentCount),
                selectedFamilies: finite(clusterOutcomes.selectedFamilyCount),
                randomFoldSupported: finite(clusterOutcomes.randomFoldSupportedFamilyCount),
            },
            validation: {
                chronologicalValidatedFamilies: finite(clusterOutcomes.validatedFamilyCount),
            },
            boundary: clusterOutcomes.claimBoundary,
        },
        {
            id: 'operations_85',
            target: 'Projected keep >=85%',
            role: 'Outcome-blind visual region discovery',
            status: 'surrogate_only',
            development: {
                savedHooks: finite(operations.source?.n),
                partitions: finite(operations.method?.partitionSummary?.partitionsTested),
                acceptedRegions: finite(operations.method?.partitionSummary?.acceptedConsensusComponents),
                retainedContrasts: finite(operations.summary?.principlesRetained),
                correctedPositive: finite(operations.summary?.together_keep?.correctedPositivePrinciples),
            },
            boundary: operations.measurementBoundary?.headline,
        },
        {
            id: 'owned_retention_views',
            target: 'Owned-channel log views',
            role: 'Observed retention relationship',
            status: 'observational_local',
            development: {
                n: finite(retention.meta?.n),
                contentUniqueR2: finite(retention.Q1?.content_unique_r2),
                keepFromRetentionR2: finite(retention.Q3?.keep_from_retention_cv_r2),
                viewsRetentionOnlyR2: finite(retention.Q3?.views_retention_only),
                viewsPlusKeepR2: finite(retention.Q3?.views_plus_keep),
                durationUniqueR2: finite(retention.Q4?.duration_unique_r2),
            },
            boundary: retention.meta?.caveat,
        },
    ];
}

function buildInvariants({ system, predictor, promisePartition, promiseQuality, promiseForward, pooledOpening, marketReward, longTitlePrior, clusterOutcomes, operations, retention }) {
    const allPartitions = system.rawMaps.flatMap(map => map.partitions.map(partition => ({
        map: map.id,
        format: map.format,
        modality: map.modality,
        k: partition.clusterCount,
        globalEta: finite(partition.global?.viewsEtaSquared, 0),
        centeredEta: finite(partition.sourceTransfer?.sourceCenteredClusterEtaSquared, 0),
        creatorR2: finite(partition.sourceTransfer?.creatorFoldR2, 0),
        maxLift: finite(partition.global?.maximumLift10m, 0),
    })));
    const globalEta = allPartitions.map(row => row.globalEta);
    const centeredEta = allPartitions.map(row => row.centeredEta);
    const creatorR2 = allPartitions.map(row => row.creatorR2);
    const kCorrelationGlobal = [];
    const kCorrelationTransfer = [];
    for (const map of system.rawMaps) {
        const rows = map.partitions;
        kCorrelationGlobal.push(correlation(
            rows.map(row => row.clusterCount),
            rows.map(row => row.global.viewsEtaSquared)
        ));
        kCorrelationTransfer.push(correlation(
            rows.map(row => row.clusterCount),
            rows.map(row => row.sourceTransfer.creatorFoldR2)
        ));
    }
    const silentEdge = system.modalityEdges.find(row => row.id === 'shorts:visual:together');
    const silentNmi = mean(silentEdge?.silent?.byResolution?.map(row => row.nmi) || []);
    const voicedNmi = mean(silentEdge?.voiced?.byResolution?.map(row => row.nmi) || []);
    const pooled20 = pooledOpening.evaluation?.allPooled?.fixedHorizons?.['20']
        || pooledOpening.evaluation?.allPooled?.fixed20Second;
    const crossFormat = predictor.corpusBenchmark?.crossDomainLongForm?.modalities || {};
    const crossFormatR2 = Object.values(crossFormat).map(row => finite(row.metrics?.r2, 0));
    const keepUnseen = predictor.targets?.keep?.stressTests?.find(row => /unseen-account/i.test(row.label));
    const viewsUnseen = predictor.targets?.views?.stressTests?.find(row => /unseen-channel/i.test(row.label));
    const marketMetrics = marketTransfer(marketReward);
    const promiseCounts = promiseQuality.partition?.validation?.componentCounts
        || promiseQuality.partition?.validation?.componentCountDistribution
        || null;

    return [
        invariant({
            id: 'source_opportunity_dominates_cluster_lift',
            title: 'The cohort map is not the lift map',
            headline: 'Global clusters separate views; the same cluster effects vanish inside unseen creators.',
            claim: 'The current visual/text/together clusters primarily organize source, category, and opportunity regimes rather than portable within-channel virality lift.',
            level: 'domain_invariant',
            status: 'supported_negative',
            scope: '24 partitions across Shorts and Long, all three modalities',
            implication: 'A valid pre-upload score must estimate creator-relative lift after modeling source opportunity separately. Global “viral clusters” cannot be used as universal buy signals.',
            tests: [
                test(
                    'global_view_separation',
                    'pass',
                    { meanEtaSquared: round(mean(globalEta)), maxEtaSquared: round(Math.max(...globalEta)) },
                    'Cluster membership explains visible variation in the pooled public snapshot.',
                    ['r2:raw/visual/map.json', 'r2:raw-long/together/map.json']
                ),
                test(
                    'source_centered_separation',
                    'fail',
                    { meanEtaSquared: round(mean(centeredEta)), maxEtaSquared: round(Math.max(...centeredEta)) },
                    'After centering outcomes within channel, almost none of the pooled cluster separation remains.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
                test(
                    'unseen_creator_transfer',
                    'fail',
                    { meanR2: round(mean(creatorR2)), maxR2: round(Math.max(...creatorR2)), minR2: round(Math.min(...creatorR2)) },
                    'Cluster means fit on four channel folds do not rank the fifth channel.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
                test(
                    'format_replication',
                    'pass',
                    { formats: 2, modalities: 3 },
                    'The collapse repeats in both Shorts and Long maps and in visual, text, and together representations.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
            ],
            systems: ['shorts_library', 'long_library', 'shorts_prediction'],
            confounds: ['Channel title is the current source join; immutable channel IDs should replace it.', 'Public views are current snapshots, not fixed-age outcomes.'],
            nextFalsifier: 'A creator-held-out, fixed-horizon model that retains positive source-macro R² after fitting opportunity and age.',
            boundary: 'This is a robust finding about the present BusinessWorld representations, not a universal law of recommendation systems.',
        }),
        invariant({
            id: 'resolution_fit_without_transfer',
            title: 'Granularity creates a fit mirage',
            headline: 'More clusters increase pooled separation without increasing unseen-creator prediction.',
            claim: 'Increasing k exposes finer cohort structure, but does not make the abstraction more principle-like unless OOD predictive compression also rises.',
            level: 'domain_invariant',
            status: 'supported_negative',
            scope: 'k=6, 10, 16, and 24 in six maps',
            implication: 'Choose resolution by prequential OOD value and stability, never by the prettiest separation or largest pooled eta-squared.',
            tests: [
                test(
                    'pooled_complexity_trend',
                    'pass',
                    { meanCorrelationKToEta: round(mean(kCorrelationGlobal)) },
                    'Pooled view separation generally rises with cluster count.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
                test(
                    'transfer_complexity_trend',
                    'fail',
                    { meanCorrelationKToCreatorR2: round(mean(kCorrelationTransfer)) },
                    'Creator-fold predictive value does not rise with cluster count.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
                test(
                    'resolution_identity',
                    'mixed',
                    {
                        meanNmi: round(mean(system.rawMaps.flatMap(map => map.resolutionEdges.map(edge => edge.nmi)))),
                    },
                    'Moderate NMI means stable cores coexist with splits and merges; there is no single natural k in the tested range.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
            ],
            systems: ['shorts_library', 'long_library'],
            nextFalsifier: 'A resolution selected without outcomes that improves grouped OOD bits over all simpler resolutions.',
            boundary: 'This does not say fine clusters are useless. It says descriptive detail is not predictive depth.',
        }),
        invariant({
            id: 'modalities_are_complementary_sensors',
            title: 'Modalities are different sensors, not 21 votes',
            headline: 'Visual, text, and together maps disagree substantially, and the useful fusion pattern changes by format.',
            claim: 'The 21 displayed Shorts outputs are correlated projections of three representations. Their disagreement is information about modality, not independent replication.',
            level: 'regional_invariant',
            status: 'supported',
            scope: 'Six maps plus random-fold heldout diagnostics',
            implication: 'Model modality-specific mechanisms first, then learn a format-conditioned fusion. Confidence must not rise just because correlated projections agree.',
            tests: [
                ...system.modalityEdges.map(edge => test(
                    `nmi_${edge.id}`,
                    edge.meanNmi < 0.6 ? 'pass' : 'mixed',
                    { common: edge.commonObservations, meanNmi: edge.meanNmi },
                    `${edge.left} and ${edge.right} form overlapping but non-equivalent partitions in ${edge.format}.`,
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                )),
                test(
                    'cross_format_axis_transfer',
                    'fail',
                    {
                        modalities: Object.fromEntries(Object.entries(crossFormat).map(([name, row]) => [
                            name,
                            round(finite(row.metrics?.r2)),
                        ])),
                    },
                    'Long-form views axes do not transfer as calibrated Shorts views predictors.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
            ],
            systems: ['shorts_library', 'long_library', 'shorts_prediction'],
            nextFalsifier: 'A frozen shared latent mechanism that improves unseen-source and cross-format predictive bits in every modality.',
            boundary: 'Current NMI compares cluster labels on paired observations; it does not align semantic meaning by label number.',
        }),
        invariant({
            id: 'missing_modality_changes_fusion',
            title: 'Missing speech changes what “together” means',
            headline: 'Visual/together agreement is much higher on silent Shorts than voiced Shorts.',
            claim: 'When text is absent, the together representation partially degenerates toward visual. Silent rows cannot be treated as ordinary multimodal observations.',
            level: 'local_invariant',
            status: 'supported',
            scope: `${finite(silentEdge?.commonObservations, 0).toLocaleString()} paired Shorts`,
            implication: 'Use an explicit text-present gate and report modality availability. Visual and together scores on silent rows are not independent evidence.',
            tests: [
                test(
                    'silent_visual_together_nmi',
                    'pass',
                    { observations: silentEdge?.silent?.observations, meanNmi: round(silentNmi) },
                    'Silent rows show stronger partition agreement.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
                test(
                    'voiced_visual_together_nmi',
                    'pass',
                    { observations: silentEdge?.voiced?.observations, meanNmi: round(voicedNmi) },
                    'Voiced rows add a genuinely different text signal and reduce visual/together identity.',
                    ['local:buildings/jarvis/principles-lab/system-analysis.json']
                ),
            ],
            systems: ['shorts_library', 'shorts_prediction'],
            nextFalsifier: 'A missing-modality-aware fusion model whose visual/together residuals remain independent on silent rows.',
            boundary: 'NMI is partition agreement, not predictive accuracy.',
        }),
        invariant({
            id: 'retrospective_fit_is_not_deployment',
            title: 'Retrospective fit is not deployment skill',
            headline: 'Keep and views look useful in random known-source folds, then fail forward time.',
            claim: 'Same-source interpolation materially overstates pre-upload generalization in the current predictor studies.',
            level: 'regional_invariant',
            status: 'supported_negative',
            scope: `${finite(predictor.targets?.keep?.n, 0)} private keep rows and ${finite(predictor.targets?.views?.n, 0)} saved-channel view rows`,
            implication: 'The UI must lead with forward-time and source-macro evidence. Random-fold R² is a development diagnostic only.',
            tests: [
                test(
                    'keep_retrospective',
                    'pass',
                    compactMetrics(predictor.targets?.keep?.metrics),
                    'Known-account random folds show retrospective signal.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'keep_forward',
                    'fail',
                    compactMetrics(predictor.targets?.keep?.prospectiveMetrics),
                    'Expanding-window keep prediction is not validated.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'keep_unseen_account',
                    'fail',
                    compactMetrics(keepUnseen?.metrics),
                    'Leaving an entire account out of axis fitting, formula selection, and calibration produces negative R².',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'views_retrospective',
                    'pass',
                    compactMetrics(predictor.targets?.views?.metrics),
                    'Saved-channel random folds show retrospective signal.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'views_forward',
                    'fail',
                    compactMetrics(predictor.targets?.views?.prospectiveMetrics),
                    'Expanding-window views prediction has negative R².',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'views_unseen_channel',
                    'fail',
                    compactMetrics(viewsUnseen?.metrics),
                    'Leaving an entire saved channel out reverses rank and produces large factor error.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
            ],
            systems: ['shorts_prediction', 'pooled_openings'],
            nextFalsifier: 'Hash-committed predictions on future uploads with fixed outcome horizons and positive source-macro net bits.',
            boundary: 'Forward backtests still use present-day representation artifacts, so even they are partial rather than historical reconstructions.',
        }),
        invariant({
            id: 'calibration_not_discrimination',
            title: 'A mean curve is not a video forecast',
            headline: 'The opening model tracks the population trajectory but emits almost no between-video spread.',
            claim: 'Calibration of an average retention curve and discrimination between candidate openings are separate abilities.',
            level: 'regional_invariant',
            status: 'supported_negative',
            scope: `${finite(pooledOpening.sources, 0)} pooled openings across ${finite(pooledOpening.accounts?.length, 0)} accounts`,
            implication: 'Never convert a well-calibrated average curve into a percentile or “better hook” claim without rank discrimination.',
            tests: [
                test(
                    'curve_mean_error',
                    'pass',
                    {
                        sourceEqualMaePoints: round(finite(pooledOpening.evaluation?.allPooled?.sourceEqualCurveMAEPercentagePoints)),
                        fixed20MaePoints: round(finite(pooled20?.maePercentagePoints)),
                    },
                    'The frozen model produces a usable population-average trajectory.',
                    ['local:buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json']
                ),
                test(
                    'fixed20_discrimination',
                    'fail',
                    {
                        predictedSd: round(finite(pooled20?.predictedStandardDeviationPercent), 4),
                        actualSd: round(finite(pooled20?.actualStandardDeviationPercent), 4),
                        pearson: round(finite(pooled20?.pearson)),
                        r2: round(finite(pooled20?.r2AgainstSecondMean)),
                    },
                    'At 20 seconds the prediction variance collapses while actual videos vary substantially.',
                    ['local:buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json']
                ),
            ],
            systems: ['promise_lattice', 'pooled_openings'],
            nextFalsifier: 'A frozen opening representation with positive rank correlation and R² at fixed horizons on unseen accounts.',
            boundary: 'The current model remains useful as a baseline trajectory and uncertainty reference.',
        }),
        invariant({
            id: 'external_market_semantics_transfer_to_retention',
            title: 'External market semantics transfer to retention',
            headline: 'A text direction learned without owned outcomes ranks retention on the 208 owned hooks.',
            claim: 'The language geometry associated with market success in 5,353 non-owned Shorts contains a weak but reproducible retention-relevant direction when frozen and transferred to the owned hook corpus.',
            level: 'regional_invariant',
            status: 'supported',
            scope: `${finite(marketReward.externalTraining?.nonOwnedTrainingRows, 0).toLocaleString()} external texts across ${finite(marketReward.externalTraining?.sourceGroups, 0).toLocaleString()} groups → ${finite(marketReward.audit?.ownedHooks, 0)} owned hooks`,
            implication: 'This is the current best candidate feedback axis for hook language. Keep it separate from topical relevance, visual packaging, and the four Promise categories.',
            tests: [
                test(
                    'external_training_isolation',
                    'pass',
                    {
                        externalRows: finite(marketReward.externalTraining?.nonOwnedTrainingRows),
                        sourceGroups: finite(marketReward.externalTraining?.sourceGroups),
                        ownedLabelsUsed: Boolean(marketReward.externalTraining?.ownedOutcomeLabelsUsedToFitOrSelectAxis),
                    },
                    'The text direction and alpha were fit on non-owned transcripts grouped by channel/copy; owned outcome labels did not select the axis.',
                    ['local:buildings/jarvis/promise-lab/.cache/market-reward.json']
                ),
                test(
                    'owned_average_retention_transfer',
                    'pass',
                    marketMetrics.averageRetention,
                    'The frozen coordinate ranks average retention in the disjoint owned hook corpus.',
                    ['local:buildings/jarvis/promise-lab/.cache/market-reward.json']
                ),
                test(
                    'owned_viewed_percent_transfer',
                    'pass',
                    marketMetrics.viewedPercent,
                    'The same frozen coordinate ranks viewed percentage without refitting the axis.',
                    ['local:buildings/jarvis/promise-lab/.cache/market-reward.json']
                ),
                test(
                    'owned_retention_5s_transfer',
                    'pass',
                    marketMetrics.retention5s,
                    'The same coordinate ranks five-second retention more weakly.',
                    ['local:buildings/jarvis/promise-lab/.cache/market-reward.json']
                ),
                test(
                    'owned_views_transfer',
                    'fail',
                    marketMetrics.logViews,
                    'The direction does not directly rank owned log views; it is a retention proxy, not a universal virality score.',
                    ['local:buildings/jarvis/promise-lab/.cache/market-reward.json']
                ),
                test(
                    'prospective_same_topic_intervention',
                    'unknown',
                    null,
                    'No randomized or prospectively frozen same-topic hook-variant test has been completed.',
                    []
                ),
            ],
            systems: ['shorts_library', 'promise_lattice', 'shorts_prediction'],
            confounds: ['The owned hook corpus is one creator domain.', 'External outcomes are current views, not fixed-age views.', 'The axis may encode market-language resemblance rather than a causal promise mechanism.'],
            nextFalsifier: 'Hash-commit same-topic hook variants before publishing and test whether the frozen score ranks observed keep on future videos.',
            boundary: marketReward.rewardContract?.claimBoundary,
        }),
        invariant({
            id: 'promise_structure_before_promise_value',
            title: 'We found segmentation before we found promise value',
            headline: 'Component boundaries have local geometric support; the four names and outcome axis do not.',
            claim: 'The Promise lattice can decompose openings reproducibly, but it has not yet discovered a portable semantic “promise quality” direction.',
            level: 'mechanism',
            status: 'mixed',
            scope: `${finite(promiseQuality.model?.trainingHooks, 208)} owned hooks and ${finite(promiseQuality.audit?.componentRows, promiseQuality.components?.length)} selected components`,
            implication: 'Keep the lattice, exact cover, and sequence graph. Treat category names and quality percentiles as hypotheses until chronology and unseen sources pass.',
            tests: [
                test(
                    'boundary_geometry',
                    'pass',
                    {
                        auc: round(finite(promisePartition.boundaryModel?.heldoutAuc)),
                        averagePrecision: round(finite(promisePartition.boundaryModel?.heldoutAveragePrecision)),
                    },
                    'Outcome-blind boundary features separate selected boundaries locally.',
                    ['local:buildings/jarvis/promise-lab/.cache/canonical-partition-model.json']
                ),
                test(
                    'category_ontology',
                    'invalid',
                    { categories: finite(promisePartition.categoryModel?.clusterCount, 4), componentDistribution: promiseCounts },
                    'The k=4 vocabulary was chosen after manual probes; it cannot validate the supplied interpretation.',
                    ['local:buildings/jarvis/promise-lab/.cache/canonical-partition-model.json']
                ),
                test(
                    'hook_quality_random',
                    'mixed',
                    {
                        spearman: round(finite(promiseQuality.model?.heldoutSpearman)),
                        p: round(finite(promiseQuality.model?.rankPermutationP)),
                    },
                    'Random folds show a weak association.',
                    ['local:buildings/jarvis/promise-lab/.cache/hook-quality.json']
                ),
                test(
                    'hook_quality_time',
                    'fail',
                    {
                        spearman: round(finite(promiseQuality.model?.chronologicalHeldoutSpearman)),
                        p: round(finite(promiseQuality.model?.chronologicalRankPermutationP)),
                    },
                    'The hook-quality direction collapses chronologically.',
                    ['local:buildings/jarvis/promise-lab/.cache/hook-quality.json']
                ),
            ],
            systems: ['promise_lattice'],
            nextFalsifier: 'Outcome-blind categories selected without manual examples, then positive fixed-horizon discrimination on unseen accounts.',
            boundary: promisePartition.categoryClaimStatus,
        }),
        invariant({
            id: 'positive_processing_lag_not_supported',
            title: 'The data does not support a positive response lag',
            headline: 'Forward component-response tests did not justify shifting viewer response one to five seconds forward.',
            claim: 'For the current timestamp alignment and cohort, serving a positive processing lag would be an unsupported researcher degree of freedom.',
            level: 'local_invariant',
            status: 'supported_negative',
            scope: `${finite(promiseForward.audit?.components, promiseForward.components?.length)} components`,
            implication: 'Serve lag 0, show all lag tests, and keep reverse-time controls. Re-estimate only on independent aligned data.',
            tests: [
                test(
                    'forward_response',
                    'fail',
                    {
                        validated: Boolean(promiseForward.validated),
                        wholeHookSpearman: round(finite(promiseForward.wholeHookModel?.heldoutSpearman)),
                        componentBalancedSpearman: round(finite(promiseForward.componentModel?.heldoutCategoryBalancedSpearman)),
                    },
                    'The component and whole-hook response axes are not validated.',
                    ['local:buildings/jarvis/promise-lab/.cache/forward-response.json']
                ),
                test(
                    'processing_lag',
                    promiseForward.deconfoundingAudit?.processingLagSupported ? 'pass' : 'fail',
                    {
                        servedLagSeconds: finite(promiseForward.metricContract?.selectedLagSeconds),
                        supported: Boolean(promiseForward.deconfoundingAudit?.processingLagSupported),
                    },
                    'The predeclared forward/reverse family did not support a positive lag.',
                    ['local:buildings/jarvis/promise-lab/.cache/forward-response.json']
                ),
            ],
            systems: ['promise_lattice'],
            nextFalsifier: 'Word-level acoustic alignment plus a preregistered lag family on new videos with a stable positive lag and failed reverse-time controls.',
            boundary: 'A null lag result does not prove instantaneous cognition; it says this dataset cannot identify the delay.',
        }),
        invariant({
            id: 'surrogate_clusters_are_not_observed_keep',
            title: 'Projected keep can discover geometry, not truth',
            headline: 'Operations found stable visual regions, but only against a projected 85% threshold.',
            claim: 'Outcome-blind operational clusters are candidate mechanisms until replicated against observed keep in independent creators.',
            level: 'taxonomy',
            status: 'taxonomy_only',
            scope: `${finite(operations.source?.n, 0)} saved hooks, ${finite(operations.method?.partitionSummary?.partitionsTested, 0)} partitions`,
            implication: 'Use Operations to generate English hypotheses and candidate interventions, never as proof that a mechanism causes 85% keep.',
            tests: [
                test(
                    'outcome_blind_geometry',
                    'pass',
                    {
                        validPartitions: finite(operations.method?.partitionSummary?.partitionsValid),
                        acceptedRegions: finite(operations.method?.partitionSummary?.acceptedConsensusComponents),
                    },
                    'Geometry was discovered before attaching the projected target.',
                    ['local:buildings/jarvis/operations-lab/.cache/principles85.json']
                ),
                test(
                    'projected_association',
                    'mixed',
                    {
                        positive: finite(operations.summary?.together_keep?.correctedPositivePrinciples),
                        lower: finite(operations.summary?.together_keep?.correctedNegativePrinciples),
                    },
                    'A small corrected family is associated with the projected score.',
                    ['local:buildings/jarvis/operations-lab/.cache/principles85.json']
                ),
                test(
                    'observed_replication',
                    'unknown',
                    {
                        groups: finite(operations.source?.broadCorpus?.observedUniqueGroups),
                        observedTailHits85: finite(operations.source?.broadCorpus?.observedTailHits85),
                    },
                    'Observed diagnostics are too sparse and not a corrected external replication.',
                    ['local:buildings/jarvis/operations-lab/.cache/principles85.json']
                ),
            ],
            systems: ['operations', 'shorts_experiments'],
            nextFalsifier: 'Freeze the regions, score them on new published hooks, and test observed keep with creator-held-out multiplicity control.',
            boundary: operations.measurementBoundary?.projected,
        }),
        invariant({
            id: 'views_factorization',
            title: 'Virality must be factorized before it is predicted',
            headline: 'One global views axis is trying to absorb four different processes.',
            claim: 'A more faithful architecture is Views(h) = Opportunity(source,time,h) × Packaging conversion × Attention survival × Distribution amplification.',
            level: 'mechanism',
            status: 'synthesis_hypothesis',
            scope: 'Joint synthesis of Raw, Predictor, Retention, Promise, and Long transfer results',
            implication: 'Train and validate each factor on its own available outcome, then recombine probabilistically. Source opportunity cannot be hidden inside a content score.',
            tests: [
                test(
                    'opportunity_term',
                    'pass',
                    {
                        viewsWithinSourceR2: round(finite(predictor.targets?.views?.withinSourceMetrics?.r2)),
                        pooledViewsR2: round(finite(predictor.targets?.views?.metrics?.r2)),
                    },
                    'Large pooled-to-within-source collapse identifies a strong source/opportunity term.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'attention_term',
                    'pass',
                    {
                        keepAddsForViewsR2: round(finite(retention.Q3?.keep_adds_for_views)),
                        durationUniqueR2: round(finite(retention.Q4?.duration_unique_r2)),
                    },
                    'Observed keep, retention shape, and duration add separable local information in the owned cohort.',
                    ['local:buildings/jarvis/retention-study/retention_study.json']
                ),
                test(
                    'cross_format_identity',
                    'fail',
                    {
                        meanLongToShortR2: round(mean(crossFormatR2)),
                    },
                    'A single format-agnostic content axis is contradicted by direct Long-to-Short transfer.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'prospective_product',
                    'unknown',
                    null,
                    'The multiplicative factorization has not been fit and prospectively tested as one frozen model.',
                    []
                ),
            ],
            systems: ['shorts_library', 'long_library', 'shorts_prediction', 'retention', 'promise_lattice'],
            confounds: ['Exposure/impressions are not currently observed.', 'Public views lack fixed-age histories.', 'Packaging and content execution are correlated choices.'],
            nextFalsifier: 'A simpler single-axis model that beats the factorized model on crossed unseen-source plus forward-time log score.',
            boundary: 'This is the strongest architecture implied by the failures, not yet a promoted predictive principle.',
        }),
        invariant({
            id: 'evidence_events_not_output_count',
            title: 'Twenty-one outputs are not twenty-one replications',
            headline: 'Views, log views, outlier, scaled views, and 10M class often descend from the same snapshot and embedding.',
            claim: 'Confidence must be counted by independent evidence events, not by the number of transformed outputs or charts.',
            level: 'local_invariant',
            status: 'methodological',
            scope: 'All Shorts and Long scoring surfaces',
            implication: 'Assign one evidence_event_id per raw outcome snapshot and one representation_id per model/preprocessing hash; transformed descendants share lineage.',
            tests: [
                test(
                    'representation_count',
                    'pass',
                    { primaryRepresentations: 3, displayedShortsOutputs: 21 },
                    'Visual, text, and together are the primary representation families; their multiple axes are correlated descendants.',
                    ['local:buildings/jarvis/predictor-lab/results.json']
                ),
                test(
                    'model_version_identity',
                    'fail',
                    {
                        recordLevelVersionPersisted: Boolean(
                            operations.source?.broadCorpus?.embeddingContract?.recordLevelModelVersionPersisted
                        ),
                    },
                    'Legacy rows do not persist immutable scorer/model identity per observation.',
                    ['local:buildings/jarvis/operations-lab/.cache/principles85.json']
                ),
            ],
            systems: ['shorts_library', 'long_library', 'shorts_prediction', 'shorts_experiments', 'long_experiments'],
            nextFalsifier: 'A lineage audit showing genuinely independent labels, encoders, sources, and outcome events behind each claimed replication.',
            boundary: 'Transforms can still be useful features. They simply do not multiply evidentiary confidence.',
        }),
    ];
}

function graphData(surfaces) {
    const nodes = [
        { id: 'reality', label: 'Videos + audiences', layer: 0, kind: 'world' },
        { id: 'shorts_inputs', label: '81K Shorts inputs', layer: 1, kind: 'observed_input' },
        { id: 'long_inputs', label: '104K Long inputs', layer: 1, kind: 'observed_input' },
        { id: 'private_outcomes', label: 'Private keep + curves', layer: 1, kind: 'observed_outcome' },
        { id: 'public_outcomes', label: 'Public view snapshots', layer: 1, kind: 'observed_outcome' },
        { id: 'visual_repr', label: 'Visual representation', layer: 2, kind: 'representation' },
        { id: 'text_repr', label: 'Text representation', layer: 2, kind: 'representation' },
        { id: 'together_repr', label: 'Together representation', layer: 2, kind: 'representation' },
        { id: 'opening_lattice', label: 'Opening component lattice', layer: 2, kind: 'representation' },
        { id: 'cluster_atlas', label: 'Cluster atlas', layer: 3, kind: 'taxonomy' },
        { id: 'sequence_graph', label: 'Sequence/context graph', layer: 3, kind: 'taxonomy' },
        { id: 'operations_regions', label: 'Operations regions', layer: 3, kind: 'taxonomy' },
        { id: 'predictor_models', label: 'Predictor models', layer: 4, kind: 'mechanism' },
        { id: 'retention_models', label: 'Retention response models', layer: 4, kind: 'mechanism' },
        { id: 'invariant_tests', label: 'Transformation tests', layer: 5, kind: 'test' },
        { id: 'principles', label: 'Promoted invariants', layer: 6, kind: 'principle' },
        { id: 'failures', label: 'Falsified shortcuts', layer: 6, kind: 'failure' },
    ];
    const edges = [
        ['reality', 'shorts_inputs', 'observe'],
        ['reality', 'long_inputs', 'observe'],
        ['reality', 'private_outcomes', 'measure'],
        ['reality', 'public_outcomes', 'measure'],
        ['shorts_inputs', 'visual_repr', 'encode'],
        ['shorts_inputs', 'text_repr', 'encode'],
        ['shorts_inputs', 'together_repr', 'encode'],
        ['long_inputs', 'visual_repr', 'encode'],
        ['long_inputs', 'text_repr', 'encode'],
        ['long_inputs', 'together_repr', 'encode'],
        ['shorts_inputs', 'opening_lattice', 'segment'],
        ['visual_repr', 'cluster_atlas', 'cluster'],
        ['text_repr', 'cluster_atlas', 'cluster'],
        ['together_repr', 'cluster_atlas', 'cluster'],
        ['opening_lattice', 'sequence_graph', 'relate'],
        ['visual_repr', 'operations_regions', 'cluster'],
        ['cluster_atlas', 'predictor_models', 'feature'],
        ['sequence_graph', 'retention_models', 'feature'],
        ['private_outcomes', 'retention_models', 'train fold only'],
        ['private_outcomes', 'predictor_models', 'train fold only'],
        ['public_outcomes', 'predictor_models', 'train fold only'],
        ['predictor_models', 'invariant_tests', 'stress test'],
        ['retention_models', 'invariant_tests', 'stress test'],
        ['operations_regions', 'invariant_tests', 'stress test'],
        ['invariant_tests', 'principles', 'survives'],
        ['invariant_tests', 'failures', 'fails'],
    ].map(([from, to, type], index) => ({ id: `edge_${index}`, from, to, type }));
    return {
        nodes,
        edges,
        surfaceIds: surfaces.map(row => row.id),
        boundary: 'Outcome edges enter models only inside training folds. Generated candidates and legacy post-outcome indicators are side branches, not confirmation paths.',
    };
}

function buildTransformationMatrix(invariants) {
    const matrix = {
        source_opportunity_dominates_cluster_lift: {
            outcome_blind: 'survived', algorithm: 'survived', resolution: 'survived',
            modality: 'survived', resample: 'tested', confounds: 'partial',
            source: 'survived', time: 'untested', format: 'survived', prospective: 'untested',
        },
        resolution_fit_without_transfer: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'survived',
            modality: 'survived', resample: 'untested', confounds: 'partial',
            source: 'survived', time: 'untested', format: 'survived', prospective: 'untested',
        },
        modalities_are_complementary_sensors: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'survived',
            modality: 'survived', resample: 'untested', confounds: 'partial',
            source: 'partial', time: 'untested', format: 'survived', prospective: 'untested',
        },
        missing_modality_changes_fusion: {
            outcome_blind: 'survived', algorithm: 'untested', resolution: 'survived',
            modality: 'survived', resample: 'untested', confounds: 'partial',
            source: 'untested', time: 'untested', format: 'untested', prospective: 'untested',
        },
        retrospective_fit_is_not_deployment: {
            outcome_blind: 'partial', algorithm: 'partial', resolution: 'partial',
            modality: 'partial', resample: 'survived', confounds: 'partial',
            source: 'survived', time: 'survived', format: 'partial', prospective: 'untested',
        },
        calibration_not_discrimination: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'partial',
            modality: 'partial', resample: 'survived', confounds: 'partial',
            source: 'survived', time: 'partial', format: 'untested', prospective: 'partial',
        },
        external_market_semantics_transfer_to_retention: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'partial',
            modality: 'partial', resample: 'survived', confounds: 'partial',
            source: 'survived', time: 'untested', format: 'untested', prospective: 'untested',
        },
        promise_structure_before_promise_value: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'partial',
            modality: 'untested', resample: 'survived', confounds: 'partial',
            source: 'failed', time: 'failed', format: 'untested', prospective: 'untested',
        },
        positive_processing_lag_not_supported: {
            outcome_blind: 'survived', algorithm: 'partial', resolution: 'partial',
            modality: 'untested', resample: 'survived', confounds: 'survived',
            source: 'untested', time: 'partial', format: 'untested', prospective: 'untested',
        },
        surrogate_clusters_are_not_observed_keep: {
            outcome_blind: 'survived', algorithm: 'survived', resolution: 'survived',
            modality: 'untested', resample: 'survived', confounds: 'partial',
            source: 'untested', time: 'untested', format: 'untested', prospective: 'untested',
        },
        views_factorization: {
            outcome_blind: 'partial', algorithm: 'partial', resolution: 'partial',
            modality: 'survived', resample: 'partial', confounds: 'partial',
            source: 'survived', time: 'partial', format: 'survived', prospective: 'untested',
        },
        evidence_events_not_output_count: {
            outcome_blind: 'survived', algorithm: 'untested', resolution: 'untested',
            modality: 'survived', resample: 'untested', confounds: 'survived',
            source: 'survived', time: 'survived', format: 'survived', prospective: 'untested',
        },
    };
    return invariants.map(row => ({
        invariantId: row.id,
        cells: Object.fromEntries(TRANSFORMATIONS.map(transformation => [
            transformation.id,
            {
                status: matrix[row.id]?.[transformation.id] || 'untested',
                testIds: row.tests
                    .filter(testRow => {
                        const text = `${testRow.id} ${testRow.detail}`.toLowerCase();
                        if (transformation.id === 'source') return /source|creator|channel|account/.test(text);
                        if (transformation.id === 'time') return /time|chronolog|forward/.test(text);
                        if (transformation.id === 'format') return /format|long|short/.test(text);
                        if (transformation.id === 'modality') return /visual|text|together|modality|silent|voiced/.test(text);
                        if (transformation.id === 'resolution') return /resolution|cluster count|\\bk\\b/.test(text);
                        if (transformation.id === 'algorithm') return /algorithm|geometry|partition/.test(text);
                        if (transformation.id === 'resample') return /fold|bootstrap|resampl/.test(text);
                        if (transformation.id === 'confounds') return /center|confound|lag|availability|opportunity/.test(text);
                        if (transformation.id === 'prospective') return /prospective|published|future upload/.test(text);
                        return /outcome-blind|before attaching|discovery/.test(text);
                    })
                    .map(testRow => testRow.id),
            },
        ])),
    }));
}

function compactValidationSplit(row) {
    if (!row) return null;
    return {
        n: finite(row.n),
        r2: finite(row.r2),
        pearson: finite(row.pearson),
        spearman: finite(row.spearman),
        bitsPerObservation: finite(row.gaussianBitsPerObservation),
        maeLog10Lift: finite(row.maeLog10Lift),
        nullMaeLog10Lift: finite(row.nullMaeLog10Lift),
        topDecileAuc: finite(row.topDecileAuc),
        predictionStandardDeviation: finite(row.predictionStandardDeviation),
        actualStandardDeviation: finite(row.actualStandardDeviation),
        sourceMacro: row.sourceMacro || null,
        pairwise: row.withinSourcePairwise || null,
        calibration: row.calibration || null,
        bootstrap: row.sourceBlockBootstrap || null,
        permutation: row.withinSourcePermutation || null,
        multiplicity: row.multiplicity || null,
    };
}

function compactValidationChannels(artifact) {
    return (artifact.channels || []).map(channel => ({
        id: channel.id,
        format: channel.format,
        modality: channel.modality,
        dimensions: finite(channel.dimensions),
        observations: finite(channel.observations, finite(channel.support?.rows)),
        unseenCreator: compactValidationSplit(channel.unseenCreator),
        laterVideo: compactValidationSplit(channel.laterVideo),
    }));
}

function buildQuantAudit(inputs) {
    const {
        snapshot,
        integrity,
        reconstructed,
        semanticFamilies,
        panel,
        opportunity,
        rawValidation,
        nestedValidation,
        creatorDelta,
        sensitivity,
        clusterOutcomeAudit,
        clusterInvarianceAudit,
        factorized,
        promotion,
    } = inputs;
    const panelAudit = promotion.audits?.unifiedPanel || {};
    const promoted = promotion.findings?.promotedFindings || [];
    const nestedChannels = compactValidationChannels(nestedValidation);
    const rawChannels = compactValidationChannels(rawValidation);
    const deltaChannels = (creatorDelta.channels || []).map(channel => ({
        id: channel.id,
        format: channel.format,
        modality: channel.modality,
        support: channel.support,
        absoluteHistoryMatched: {
            unseenCreator: compactValidationSplit(
                channel.absoluteHistoryMatched?.unseenCreator
            ),
            laterVideo: compactValidationSplit(
                channel.absoluteHistoryMatched?.laterVideo
            ),
        },
        creatorDelta: {
            unseenCreator: compactValidationSplit(
                channel.creatorDelta?.unseenCreator
            ),
            laterVideo: compactValidationSplit(
                channel.creatorDelta?.laterVideo
            ),
        },
        incremental: channel.incremental,
    }));
    const factorLedger = factorized.outOfDistributionPredictiveBits?.ledger || [];
    const supportedFactors = factorLedger.filter(
        row => row.status === 'supported_ood_bits'
    );
    const shortsVisual = nestedChannels.find(row => row.id === 'shorts:visual');
    const shortsTogether = nestedChannels.find(row => row.id === 'shorts:together');
    const deltaVisual = deltaChannels.find(row => row.id === 'shorts:visual');
    const deltaTogether = deltaChannels.find(row => row.id === 'shorts:together');
    const snapshotBytes = (snapshot.objects || []).reduce(
        (sum, row) => sum + finite(row.bytes, 0),
        0
    );
    const opportunityFormats = Object.fromEntries(
        (opportunity.formats || []).map(row => [row.format, row])
    );
    const strictFormats = Object.fromEntries(
        (panel.formats || []).map(row => [row.format, row])
    );
    const nativeFailures = integrity.failures || [];
    const clusterClaims = clusterInvarianceAudit.conclusions?.claims || [];

    return {
        schema: 'principles-quant-audit-v1',
        generatedAt: promotion.generatedAt,
        verdict: {
            status: promoted.length ? 'promoted' : 'no_promoted_principle',
            headline: promoted.length
                ? `${promoted.length} claim${promoted.length === 1 ? '' : 's'} cleared every gate`
                : 'No virality principle has cleared every gate yet.',
            summary:
                'Two semantic factors carry repeatable out-of-distribution information for viewed '
                + 'percentage and five-second retention. Absolute Shorts geometry also ranks broad '
                + 'content styles, but creator-relative next-video alpha is only a few points above '
                + 'chance and is sensitive to the nuisance baseline. Long-form confirmation is '
                + 'underpowered. These are useful research results, not a solved universal predictor.',
            promotedPrinciples: promoted.length,
            supportedRegionalFactors: supportedFactors.length,
            clusterOutcomeSurvivors:
                finite(clusterOutcomeAudit.familyWiseSignificantTests, 0),
            validatedClusterRelationships:
                finite(
                    clusterInvarianceAudit.conclusions?.mechanisms
                        ?.validatedPairRelationships,
                    0
                ),
        },
        decisionSummary: [
            {
                id: 'market_hold_entry',
                label: 'Semantic Market Hold -> viewed percentage',
                status: 'supported_regional',
                primary:
                    supportedFactors.find(row => row.id === 'market-hold-viewed_percent')
                    || null,
                interpretation:
                    'A text direction trained outside the owned channels adds predictive bits in '
                    + 'both grouped and forward tests. Calibration still uses prior owned outcomes.',
            },
            {
                id: 'market_hold_ret5',
                label: 'Semantic Market Hold -> five-second retention',
                status: 'supported_regional',
                primary:
                    supportedFactors.find(row => row.id === 'market-hold-retention_5s')
                    || null,
                interpretation:
                    'The same external semantic direction contains repeatable attention-survival '
                    + 'information, but it is not yet a prospective intervention.',
            },
            {
                id: 'absolute_short_geometry',
                label: 'Absolute Shorts visual/together geometry',
                status: 'broad_style_signal',
                primary: {
                    visualUnseen: shortsVisual?.unseenCreator,
                    visualLater: shortsVisual?.laterVideo,
                    togetherUnseen: shortsTogether?.unseenCreator,
                    togetherLater: shortsTogether?.laterVideo,
                },
                interpretation:
                    'The full embedding ranks broad corpus styles after source-held-out target '
                    + 'construction. Most of the pooled rank correlation is not a within-creator '
                    + 'decision edge.',
            },
            {
                id: 'creator_delta',
                label: 'Creator-relative next-video content delta',
                status: 'detectable_not_decision_grade',
                primary: {
                    visualUnseen: deltaVisual?.creatorDelta?.unseenCreator,
                    visualLater: deltaVisual?.creatorDelta?.laterVideo,
                    togetherUnseen: deltaTogether?.creatorDelta?.unseenCreator,
                    togetherLater: deltaTogether?.creatorDelta?.laterVideo,
                },
                interpretation:
                    'The incremental content edge is statistically detectable in the large Shorts '
                    + 'panel, but later pairwise accuracy is roughly 51-52% and net information is '
                    + 'around one-thousandth of a bit per video.',
            },
            {
                id: 'clusters',
                label: 'Discrete cluster membership',
                status: 'not_supported_as_alpha',
                primary: {
                    familyWiseSignificant:
                        finite(clusterOutcomeAudit.familyWiseSignificantTests, 0),
                    bestLater: clusterOutcomeAudit.bestLaterVideo,
                    geometry: clusterInvarianceAudit.conclusions?.geometry,
                },
                interpretation:
                    'Clusters reveal partial local geometry. No cluster outcome test or cross-modal '
                    + 'relationship survives the complete correction and transfer contract.',
            },
            {
                id: 'long',
                label: 'Long-form portable validation',
                status: 'blocked_for_power',
                primary: {
                    strictAllModalityRows:
                        strictFormats.long?.historicallyObservableSupport
                            ?.targetsWithAllModalities,
                    requiredBeforeDesignEffect:
                        panelAudit.gates?.longStrictAllModalitySupport?.evidence
                            ?.minimumIndependentRowsBeforeDesignEffect,
                },
                interpretation:
                    'Long visual and text geometry can be rebuilt from raw vectors, but the strict '
                    + 'historical all-modality outcome panel is far below the confirmatory power floor.',
            },
        ],
        lineage: {
            snapshot: {
                runId: snapshot.runId,
                identityHash: snapshot.identityHash,
                objects: (snapshot.objects || []).length,
                bytes: snapshotBytes,
                completeReadsPerObject: snapshot.protocol?.completeReadsPerObject,
                serverSideConditionalCopy:
                    snapshot.protocol?.serverSideConditionalCopy,
                mutableSourcesChangedAfterFreeze:
                    snapshot.protocol?.sourceObjectsChangedDuringFreeze || [],
            },
            nativeIntegrity: {
                accepted: integrity.accepted,
                acceptedChannels: integrity.acceptedChannels,
                rejectedChannels: integrity.rejectedChannels,
                failures: nativeFailures,
            },
            reconstructedGeometry: {
                pass:
                    panelAudit.gates?.mapVectorGenerationCoherence?.pass === true,
                outcomesUsed: reconstructed.method?.outcomesUsed,
                channels: reconstructed.channels,
                remediation:
                    panelAudit.gates?.mapVectorGenerationCoherence?.evidence
                        ?.reconstructedOutcomeBlindGeometry?.remediation,
            },
            semanticFamilies: {
                outcomesUsed: semanticFamilies.outcomesUsed,
                formats: semanticFamilies.formats,
                boundary: semanticFamilies.claimBoundary,
            },
            hardGates: Object.entries(panelAudit.gates || {}).map(
                ([id, row]) => ({
                    id,
                    pass: row.pass,
                    required: row.required,
                    evidence: row.evidence,
                })
            ),
            governedArtifacts:
                panelAudit.invalidatedConfirmatoryArtifacts || [],
        },
        support: {
            formats: panel.formats,
            strictOutcomeRows: finite(opportunity.targetRows),
            strictOpportunityByFormat: opportunity.formats,
            note: panel.primaryLimitation,
        },
        opportunity: {
            shorts: opportunityFormats.shorts,
            long: opportunityFormats.long,
            estimand: opportunity.estimand,
            boundary: opportunity.leakageBoundary,
        },
        signals: {
            rawFoldLocal: rawChannels,
            nestedFoldLocal: nestedChannels,
            creatorDelta: deltaChannels,
            baselineSensitivity: {
                grid: sensitivity.grid,
                stability: sensitivity.stability,
                historySupportStability:
                    sensitivity.historySupportStability,
                specifications: sensitivity.specifications,
                historySupportSpecifications:
                    sensitivity.historySupportSpecifications,
                claimBoundary: sensitivity.claimBoundary,
            },
            factorized: {
                objective: factorized.objective,
                contract: factorized.factorContract,
                validation: factorized.validationContract,
                leakageAudit: factorized.leakageAudit,
                inventory: factorized.artifactInventory,
                summary:
                    factorized.outOfDistributionPredictiveBits?.summary,
                ledger: factorLedger,
            },
        },
        clusters: {
            outcomeAudit: {
                tests: clusterOutcomeAudit.tests,
                familyWiseSignificantTests:
                    clusterOutcomeAudit.familyWiseSignificantTests,
                bestLaterVideo: clusterOutcomeAudit.bestLaterVideo,
                bestUnseenCreator: clusterOutcomeAudit.bestUnseenCreator,
                formats: clusterOutcomeAudit.formats,
                boundary: clusterOutcomeAudit.evidenceBoundary,
            },
            invariance: {
                geometry: clusterInvarianceAudit.conclusions?.geometry,
                transport: clusterInvarianceAudit.conclusions?.transport,
                mechanisms: clusterInvarianceAudit.conclusions?.mechanisms,
                claims: clusterClaims,
                strictPanel: clusterInvarianceAudit.outcomeAudit?.strictPanel,
            },
        },
        promotion: {
            alpha: promotion.alpha,
            searchUniverse: promotion.adaptiveSearchUniverse,
            findings: promotion.findings,
            ceilings: promotion.promotionCeilings,
            multiplicityPolicy: promotion.multiplicityPolicy,
            auditRisks: promotion.auditRisks,
        },
        definitions: {
            pooledRank:
                'How well scores order all eligible videos together. It can be driven by stable '
                + 'creator or style differences.',
            sourceMacro:
                'Compute rank correlation separately inside each creator, then give each creator '
                + 'equal weight.',
            pairwise:
                'Among two videos from the same creator, how often the model orders their relative '
                + 'performance correctly. 50% is chance.',
            predictiveBits:
                'Out-of-sample Gaussian log-score gain over the null. Zero means no information; '
                + 'negative values are worse than the null.',
            familyWiseP:
                'Permutation probability after taking the best result across the complete declared '
                + 'cluster family. It protects against choosing whichever map happened to look best.',
            opportunityLift:
                'Observed log views minus age maturity and a creator baseline built only from '
                + 'different prior videos whose outcomes were already observable.',
        },
    };
}

function main() {
    const system = readJson(PATHS.system);
    const operations = readJson(PATHS.operations);
    const predictor = readJson(PATHS.predictor);
    const promiseManifest = readJson(PATHS.promiseManifest);
    const promiseDiscovery = readJson(PATHS.promiseDiscovery);
    const promisePartition = readJson(PATHS.promisePartition);
    const promiseQuality = readJson(PATHS.promiseQuality);
    const promiseForward = readJson(PATHS.promiseForward);
    const pooledOpening = readJson(PATHS.pooledOpening);
    const pooledBlind = readJson(PATHS.pooledBlind);
    const openingContext = readJson(PATHS.openingContext);
    const opening20s = readJson(PATHS.opening20s);
    const clusterOutcomes = readJson(PATHS.clusterOutcomes);
    const marketReward = readJson(PATHS.marketReward);
    const longTitlePrior = readJson(PATHS.longTitlePrior);
    const retention = readJson(PATHS.retention);
    const tribe = readJson(PATHS.tribe);
    const graph = readJson(PATHS.graph);
    const indicatorsObject = readJson(PATHS.indicators);
    const indicators = Array.isArray(indicatorsObject)
        ? indicatorsObject
        : Object.values(indicatorsObject || {});
    const legacyExperimentCount = countToken(PATHS.legacyExperiments, '"id":') || 0;
    const legacyDerivedCount = countToken(PATHS.legacyDerived, '"key":') || 0;
    const quantInputs = {
        snapshot: readJson(PATHS.quantSnapshot),
        integrity: readJson(PATHS.quantIntegrity),
        reconstructed: readJson(PATHS.quantReconstructed),
        semanticFamilies: readJson(PATHS.quantSemanticFamilies),
        panel: readJson(PATHS.quantPanel),
        opportunity: readJson(PATHS.quantOpportunity),
        rawValidation: readJson(PATHS.quantRawValidation),
        nestedValidation: readJson(PATHS.quantNestedValidation),
        creatorDelta: readJson(PATHS.quantCreatorDelta),
        sensitivity: readJson(PATHS.quantSensitivity),
        clusterOutcomeAudit: readJson(PATHS.quantClusterOutcomes),
        clusterInvarianceAudit: readJson(PATHS.quantClusterInvariance),
        factorized: readJson(PATHS.quantFactorized),
        promotion: readJson(PATHS.quantPromotion),
    };
    const quantAudit = buildQuantAudit(quantInputs);

    const inputs = {
        system,
        predictor,
        operations,
        promiseManifest,
        promiseDiscovery,
        promisePartition,
        promiseQuality,
        promiseForward,
        pooledOpening,
        marketReward,
        longTitlePrior,
        clusterOutcomes,
        retention,
        tribe,
        graph,
        indicators,
        legacyExperimentCount,
        legacyDerivedCount,
    };
    const surfaces = surfaceInventory(inputs);
    const models = buildModels(inputs);
    const invariants = buildInvariants(inputs);
    const transformationMatrix = buildTransformationMatrix(invariants);
    const localProvenance = Object.values(PATHS).map(fingerprint).filter(Boolean);
    const provenance = [...system.provenance, ...localProvenance]
        .filter((row, index, rows) => rows.findIndex(candidate => candidate.id === row.id) === index);

    const artifact = {
        schema: 'business-world-principles-atlas-v2',
        generatedAt: quantAudit.generatedAt,
        title: 'Principles Atlas',
        mission: 'Discover the smallest abstractions that preserve predictive information across the widest transformations in every quantitative Jarvis surface.',
        verdict: {
            headline: quantAudit.verdict.headline,
            summary: quantAudit.verdict.summary,
            promoted: quantAudit.verdict.promotedPrinciples,
            mixed: invariants.filter(row => ['mixed', 'taxonomy_only', 'synthesis_hypothesis'].includes(row.status)).length,
            universal: 0,
        },
        researchQuestion: {
            question: 'When is an abstraction justified?',
            operationalAnswer: 'When a frozen relational description saves predictive bits on observations that could not have influenced its discovery.',
            discoveryOrder: [
                'Observations',
                'Representations',
                'Outcome-blind clusters',
                'Relational mechanisms',
                'Transformation tests',
                'Predictive compression',
                'Promoted invariant',
                'Prospective falsification',
            ],
            nonGoals: [
                'Naming a cluster and treating the name as evidence.',
                'Counting correlated projections as independent confirmation.',
                'Promoting a retrospective association that fails unseen source or forward time.',
                'Calling generated candidates audience observations.',
            ],
        },
        evidenceKinds: EVIDENCE_KINDS,
        transformations: TRANSFORMATIONS,
        levels: LEVELS,
        quantAudit,
        corpus: {
            databases: system.databases,
            privateKeep: {
                videos: finite(predictor.targets?.keep?.n),
                accounts: predictor.targets?.keep?.accounts || [],
            },
            savedChannels: {
                videos: finite(predictor.coverage?.savedChannelRows),
                channels: finite(predictor.coverage?.savedChannels),
            },
            promise: {
                hooks: finite(promiseManifest.counts?.openings, promiseDiscovery.hooks),
                allContiguousSpans: finite(promiseManifest.counts?.savedProjectionPoints),
                selectedComponents: finite(promiseQuality.audit?.componentRows, promiseQuality.components?.length),
                sequenceRelationships: finite(promiseManifest.counts?.sequenceRelationships),
                opening20s: {
                    videos: finite(opening20s.sourceVideos),
                    tokens: finite(opening20s.tokenCount),
                    spans: finite(opening20s.spanCount),
                    components: finite(opening20s.componentCount),
                    edges: finite(opening20s.edgeCount),
                    medianTimingErrorSeconds: finite(opening20s.independentTimingAudit?.medianStartAgreementSeconds),
                    p95TimingErrorSeconds: finite(opening20s.independentTimingAudit?.p95StartAgreementSeconds),
                },
                marketHold: {
                    externalRows: finite(marketReward.externalTraining?.nonOwnedTrainingRows),
                    externalGroups: finite(marketReward.externalTraining?.sourceGroups),
                    transfer: marketTransfer(marketReward),
                },
            },
            operations: {
                savedHooks: finite(operations.source?.n),
                partitionsTested: finite(operations.method?.partitionSummary?.partitionsTested),
                acceptedRegions: finite(operations.method?.partitionSummary?.acceptedConsensusComponents),
            },
            tribe: {
                videos: finite(tribe.n),
                indicators: finite(tribe.indicatorIds?.length),
                account: tribe.account,
            },
            legacy: {
                graphNodes: finite(graph.nodes?.length),
                graphEdges: finite(graph.edges?.length),
                displayedDerivedEdges: finite(graph.derived_edges?.length),
                totalDerivedEdges: finite(graph._meta?.total_derived_edges, legacyDerivedCount),
                compactIndicators: indicators.length,
                experimentRows: legacyExperimentCount,
                derivedExperimentRows: legacyDerivedCount,
                interpretation: 'One adaptive hypothesis-generation universe. It does not provide hundreds of thousands of independent replications.',
            },
        },
        surfaces,
        systemGraph: graphData(surfaces),
        clusterAtlas: {
            maps: system.rawMaps,
            modalityEdges: system.modalityEdges,
            mapCount: system.rawMaps.length,
            partitionCount: system.rawMaps.reduce((sum, map) => sum + map.partitions.length, 0),
            observationIdentity: {
                current: 'Exact YouTube video ID; source joined from the corresponding database.',
                required: [
                    'platform:video_id upload identity',
                    'decoded media hash',
                    'near-duplicate content family',
                    'stable channel ID',
                    'outcome snapshot horizon',
                    'representation model and preprocessing hash',
                ],
            },
            mappingRule: 'Cluster numbers are map-local. Cross-map links use shared-observation overlap, NMI, variation of information, and split/merge links; matching numbers never imply matching meaning.',
        },
        models,
        invariants,
        transformationMatrix,
        operationsAtlas: {
            boundary: operations.measurementBoundary,
            method: {
                discoveryFirst: operations.method?.discoveryFirst,
                outcomeBlind: operations.method?.outcomeBlindClustering,
                partitions: operations.method?.partitionSummary,
                lineages: operations.method?.lineages,
                multipleTesting: operations.method?.multipleTesting,
            },
            principles: (operations.principles || []).map(row => ({
                id: row.id,
                label: row.comparisonLabel || row.label,
                family: row.familyLabel,
                n: finite(row.n),
                prevalence: finite(row.prevalence),
                algorithms: row.algorithms || [],
                resolutions: row.resolutions || [],
                stability: row.stability,
                effects: row.effects,
                observedDiagnostic: row.observedDiagnostic,
            })),
        },
        promiseAtlas: {
            manifest: {
                status: promiseManifest.status,
                embeddingModel: promiseManifest.embeddingModel,
                dimensions: promiseManifest.embeddingDimensions,
                counts: promiseManifest.counts,
                scoringContract: promiseManifest.scoringContract,
                evidenceBoundary: promiseManifest.evidenceBoundary,
            },
            discovery: {
                hooks: promiseDiscovery.hooks,
                experiments: promiseDiscovery.experiments,
                candidateInstances: promiseDiscovery.candidateInstances,
                outcomesUsed: promiseDiscovery.outcomesUsed,
            },
            canonicalPartition: {
                mapId: promisePartition.mapId,
                methodVersion: promisePartition.methodVersion,
                categoryCount: promisePartition.categoryModel?.clusterCount,
                categoryClaimStatus: promisePartition.categoryClaimStatus,
                constraints: promisePartition.constraints,
                boundaryModel: {
                    heldoutAuc: promisePartition.boundaryModel?.heldoutAuc,
                    heldoutAveragePrecision: promisePartition.boundaryModel?.heldoutAveragePrecision,
                    heldoutBalancedAccuracy: promisePartition.boundaryModel?.heldoutBalancedAccuracy,
                },
            },
            componentSample: (promiseQuality.components || []).slice(0, 324).map(row => ({
                videoId: row.videoId,
                component: row.component,
                category: row.category,
                start: row.start,
                end: row.end,
                text: row.text,
                categoryProbability: row.categoryProbability,
                deletionEffect: row.deletionEffect,
                categoryPercentile: row.categoryPercentile,
                forwardResponse: row.forwardResponse,
            })),
            relationshipSample: (promiseForward.relationships || []).slice(0, 250),
            contextStudy: {
                status: openingContext.status,
                categoryCount: openingContext.categoryCount,
                primaryLagSeconds: openingContext.primaryLagSeconds,
                testedForwardLagsSeconds: openingContext.testedForwardLagsSeconds,
                categories: (openingContext.categories || []).map(category => ({
                    category: category.category,
                    frozenCategory: category.frozenCategory,
                    componentRows: category.componentRows,
                    primaryLagSeconds: category.primaryLagSeconds,
                    primaryOutcomePlane: {
                        xAxis: category.primaryOutcomePlane?.xAxis,
                        yAxis: category.primaryOutcomePlane?.yAxis,
                        directionStatus: category.primaryOutcomePlane?.directionStatus,
                        orientationUsesOutcomes: category.primaryOutcomePlane?.orientationUsesOutcomes,
                        coordinatesOutOfFold: category.primaryOutcomePlane?.coordinatesOutOfFold,
                        pointPredictionsOutOfFold: category.primaryOutcomePlane?.pointPredictionsOutOfFold,
                        leakageBoundary: category.primaryOutcomePlane?.leakageBoundary,
                    },
                    lagExperiments: (category.lagExperiments || []).map(row => ({
                        lagSeconds: row.lagSeconds,
                        rows: row.rows,
                        sourceVideos: row.sourceVideos,
                        status: row.status,
                        incrementalViewerContextReplicated: row.incrementalViewerContextReplicated,
                        replicationStatus: row.replicationStatus,
                    })),
                })),
                claimBoundary: openingContext.claimBoundary,
            },
            opening20s: {
                methodVersion: opening20s.methodVersion,
                analysisHorizonSeconds: opening20s.analysisHorizonSeconds,
                sourceVideos: opening20s.sourceVideos,
                sourceMediaOrigins: opening20s.sourceMediaOrigins,
                mediaAlignmentConfidenceBands: opening20s.mediaAlignmentConfidenceBands,
                independentTimingAudit: opening20s.independentTimingAudit,
                independentHookEndpointAudit: opening20s.independentHookEndpointAudit,
                tokenCount: opening20s.tokenCount,
                componentCount: opening20s.componentCount,
                spanCount: opening20s.spanCount,
                edgeCount: opening20s.edgeCount,
                categoryCount: opening20s.categoryCount,
                lengthSupport: opening20s.lengthSupport,
                partitionContract: opening20s.partitionContract,
                latticeContract: opening20s.latticeContract,
                retentionContract: opening20s.retentionContract,
            },
            clusterOutcomes: {
                experimentCount: clusterOutcomes.experimentCount,
                selectedFamilyCount: clusterOutcomes.selectedFamilyCount,
                randomFoldSupportedFamilyCount: clusterOutcomes.randomFoldSupportedFamilyCount,
                validatedFamilyCount: clusterOutcomes.validatedFamilyCount,
                claimBoundary: clusterOutcomes.claimBoundary,
                timingAudit: clusterOutcomes.timingAudit,
                normalization: clusterOutcomes.normalization,
                validation: clusterOutcomes.validation,
            },
            marketReward: {
                status: marketReward.status,
                methodVersion: marketReward.methodVersion,
                scoreScale: marketReward.scoreScale,
                externalTraining: marketReward.externalTraining,
                transfer: marketTransfer(marketReward),
                domainGate: marketReward.domainGate,
                rewardContract: marketReward.rewardContract,
                audit: marketReward.audit,
            },
            longTitlePrior: {
                status: longTitlePrior.status,
                methodVersion: longTitlePrior.methodVersion,
                corpus: longTitlePrior.corpus,
                validation: longTitlePrior.validation,
                claimBoundary: longTitlePrior.claimBoundary,
            },
            pooledBlind: {
                status: pooledBlind.status,
                sources: pooledBlind.sources,
                nonDevelopmentVideos: pooledBlind.nonDevelopmentVideos,
                externalHoldoutVideos: pooledBlind.externalHoldoutVideos,
                externalHoldoutIdsDisjoint: pooledBlind.externalHoldoutIdsDisjoint,
                policy: pooledBlind.blindIsolationPrimaryPolicy,
                sealedAt: pooledBlind.sealedAt,
            },
        },
        failureLab: [
            {
                id: 'pooled_cluster_virality',
                title: 'Pooled cluster = portable virality',
                status: 'falsified',
                reason: 'Creator-fold source-relative R² is approximately zero across every raw map and k.',
                systems: ['shorts_library', 'long_library'],
            },
            {
                id: 'more_clusters_deeper',
                title: 'More clusters = deeper principle',
                status: 'falsified',
                reason: 'Pooled fit rises while creator transfer does not.',
                systems: ['shorts_library', 'long_library'],
            },
            {
                id: 'random_fold_deployment',
                title: 'Random fold = deployment performance',
                status: 'falsified',
                reason: 'Keep, views, and hook-quality results contract or reverse in chronology.',
                systems: ['shorts_prediction', 'promise_lattice'],
            },
            {
                id: 'mean_curve_ranking',
                title: 'Mean curve accuracy = opening ranking',
                status: 'falsified',
                reason: 'At fixed horizons predicted between-video variance is near zero and R² is negative.',
                systems: ['pooled_openings'],
            },
            {
                id: 'four_categories_ontology',
                title: 'The four Promise labels are discovered ontology',
                status: 'invalidated',
                reason: 'The category map was selected after manual phrase probes.',
                systems: ['promise_lattice'],
            },
            {
                id: 'promise_cluster_outcomes',
                title: 'Random-fold Promise cluster effects are validated outcomes',
                status: 'falsified',
                reason: `${finite(clusterOutcomes.experimentCount, 0).toLocaleString()} cluster-outcome searches produced ${finite(clusterOutcomes.randomFoldSupportedFamilyCount, 0)} random-fold families and ${finite(clusterOutcomes.validatedFamilyCount, 0)} chronological validations.`,
                systems: ['promise_lattice'],
            },
            {
                id: 'legacy_volume_replication',
                title: 'Hundreds of thousands of legacy tests = replication',
                status: 'invalidated',
                reason: 'They form one adaptive, heavily dependent discovery universe and include post-outcome features.',
                systems: ['legacy_research'],
            },
            {
                id: 'long_short_same_axis',
                title: 'A Long views axis transfers directly to Shorts',
                status: 'falsified',
                reason: 'Every tested direct Long-to-Short modality has negative R².',
                systems: ['long_library', 'shorts_prediction'],
            },
        ],
        implementationContract: {
            document: 'DISCOVERY_CONTRACT.md',
            evidenceIdentity: [
                'upload_id',
                'asset_hash',
                'content_family_id',
                'source_id',
                'snapshot_id',
                'representation_id',
                'segment_id',
                'candidate_id',
            ],
            causalAvailability: [
                'A0 creator history',
                'A1 final pre-upload package',
                'A2(t) viewer context observed by time t',
                'A3 platform exposure',
                'A4(h) outcome at fixed horizon h',
                'A5 descendants of outcomes',
                'S synthetic/counterfactual world',
            ],
            predictiveCompression: 'Net bits = L(null outcomes | confounds) - [L(abstraction) + L(outcomes | abstraction, confounds)].',
            lockboxes: [
                'content-family',
                'whole unseen source',
                'forward time',
                'Shorts-to-Long and Long-to-Short',
                'crossed unseen-source + future-time',
                'prospective publication',
            ],
            promotionRule: 'The weakest required transformation sets the ceiling. English labels are attached only after freezing and never select a region.',
        },
        liveStatus: system.liveStatus,
        provenance,
        sourceHash: system.analysisHash,
    };
    artifact.artifactHash = sha256(Buffer.from(JSON.stringify(artifact)));
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(artifact)}\n`);
    console.log(JSON.stringify({
        output: path.relative(ROOT, OUTPUT_PATH),
        schema: artifact.schema,
        artifactHash: artifact.artifactHash,
        surfaces: artifact.surfaces.length,
        maps: artifact.clusterAtlas.mapCount,
        partitions: artifact.clusterAtlas.partitionCount,
        sampledObservations: artifact.clusterAtlas.maps.reduce(
            (sum, map) => sum + map.atlasSample.length,
            0
        ),
        invariants: artifact.invariants.length,
        failures: artifact.failureLab.length,
        provenance: artifact.provenance.length,
    }, null, 2));
}

main();
