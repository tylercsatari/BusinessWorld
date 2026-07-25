#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_PATH = path.join(__dirname, 'artifact.json');

const SOURCE_PATHS = {
    operations: 'buildings/jarvis/operations-lab/.cache/principles85.json',
    predictor: 'buildings/jarvis/predictor-lab/results.json',
    opening: 'buildings/jarvis/promise-lab/.cache/pooled-opening-predictions.json',
    openingContext: 'buildings/jarvis/promise-lab/.cache/opening-context-study.json',
    retention: 'buildings/jarvis/retention-study/retention_study.json',
    bridgeLegacy: 'buildings/jarvis/bridge_top_principles.json',
    retentionLegacy: 'buildings/jarvis/retention-patterns.json',
    predictionLegacy: 'buildings/jarvis/prediction-model.json',
    forwardResponseLegacy: 'buildings/jarvis/promise-lab/.cache/forward-response.json',
    hookQualityLegacy: 'buildings/jarvis/promise-lab/.cache/hook-quality.json',
};

const TRANSFORMATIONS = [
    { id: 'outcome_blind', label: 'Outcome-blind discovery', family: 'selection' },
    { id: 'algorithm', label: 'Algorithm change', family: 'geometry' },
    { id: 'resolution', label: 'Semantic resolution', family: 'geometry' },
    { id: 'resample', label: 'Grouped resampling', family: 'stability' },
    { id: 'threshold', label: 'Threshold shift', family: 'measurement' },
    { id: 'topic', label: 'Topic adjustment', family: 'confounding' },
    { id: 'time', label: 'Forward time', family: 'distribution' },
    { id: 'source', label: 'Unseen source', family: 'distribution' },
    { id: 'format', label: 'Cross-format transfer', family: 'distribution' },
    { id: 'observed', label: 'Observed outcome', family: 'measurement' },
    { id: 'prospective', label: 'Prospective lockbox', family: 'prediction' },
];

const LEVELS = [
    {
        id: 'mechanism',
        label: 'Mechanism',
        definition: 'A stable pattern or model inside one observed setting.',
    },
    {
        id: 'local_invariant',
        label: 'Local invariant',
        definition: 'Survives grouped resampling and perturbations inside one bounded corpus.',
    },
    {
        id: 'regional_invariant',
        label: 'Regional invariant',
        definition: 'Predicts in independently held-out sources inside one content domain.',
    },
    {
        id: 'domain_invariant',
        label: 'Domain invariant',
        definition: 'Survives multiple independently sampled corpora, sources, and formats.',
    },
    {
        id: 'universal_invariant',
        label: 'Universal invariant',
        definition: 'Keeps predicting across every tested domain and transformation. Current data cannot justify this tier.',
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

function sourceFingerprint(relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    const bytes = fs.readFileSync(absolutePath);
    return {
        path: relativePath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        modifiedAt: fs.statSync(absolutePath).mtime.toISOString(),
    };
}

function finite(value, fallback = null) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function compactMetrics(metrics, keys = [
    'n', 'r2', 'pearson', 'spearman', 'mae', 'rmse',
    'medianFactorError', 'calibrationSlope',
]) {
    if (!metrics) return null;
    return Object.fromEntries(keys
        .filter(key => Number.isFinite(Number(metrics[key])))
        .map(key => [key, Number(metrics[key])]));
}

function intervalExcludesZero(interval) {
    return Array.isArray(interval)
        && interval.length === 2
        && Number.isFinite(Number(interval[0]))
        && Number.isFinite(Number(interval[1]))
        && (Number(interval[0]) > 0 || Number(interval[1]) < 0);
}

function evidence(state, measure, detail, value = null) {
    return { state, measure, detail, value };
}

function transformation(id, state, detail, value = null) {
    return { id, state, detail, value };
}

function descriptionStats(statement) {
    const text = String(statement || '').trim();
    const tokens = text ? text.split(/\s+/).length : 0;
    const bytes = Buffer.byteLength(text, 'utf8');
    return {
        tokens,
        bytes,
        mdlEligible: false,
        boundary: 'This is display-description length, not total model description length or a valid MDL score.',
    };
}

function levelRank(level) {
    return LEVELS.findIndex(row => row.id === level);
}

function buildOperationsCandidates(operations) {
    return (operations.principles || []).map(principle => {
        const target = principle.effects?.together_keep || {};
        const projectedCi = target.keepDeltaCi95 || target.ci95;
        const projectedCorrected = finite(target.q, 1) <= 0.05
            && intervalExcludesZero(projectedCi)
            && finite(target.foldSignConsistency, 0) >= 0.8;
        const observed = principle.observedDiagnostic || {};
        const observedContinuous = observed.continuous || {};
        const observedConsistency = Boolean(
            observed.directionalConsistencyWithSaved?.passes
            && intervalExcludesZero(observedContinuous.ci95GroupedBootstrap)
        );
        const algorithmCount = finite(principle.algorithmSupport, (principle.algorithms || []).length) || 0;
        const resolutionCount = finite(principle.resolutionSupport, (principle.resolutions || []).length) || 0;
        const stabilityMedian = finite(principle.stability?.median, 0);
        const geometryPass = algorithmCount >= 2;
        const resamplePass = stabilityMedian >= 0.6;
        const level = projectedCorrected ? 'local_invariant' : 'mechanism';
        const statement = `${principle.familyLabel || 'Visual semantic region'}: ${principle.comparisonLabel || principle.label}`;
        const sourceDiversity = {
            independentSources: 0,
            groupedUnits: finite(operations.method?.lineages?.groupCount, 0),
            observedDiagnosticSources: finite(observed.uniqueGroups, 0),
            boundary: 'Discovery rows do not persist creator identity. Semantic lineages are not independent creators.',
        };

        return {
            id: `operations:${principle.id}`,
            family: 'visual_operations',
            familyLabel: 'Outcome-blind visual operations',
            label: principle.comparisonLabel || principle.label,
            statement,
            level,
            ceiling: 'local_invariant',
            status: projectedCorrected ? 'supported_locally' : 'exploratory',
            direction: principle.direction || 'unknown',
            sourceIds: ['operations_saved_hooks', 'operations_observed_diagnostic'],
            sample: {
                observations: finite(principle.n, 0),
                discoveryPopulation: finite(operations.source?.n, 0),
                prevalence: finite(principle.prevalence, null),
                ...sourceDiversity,
            },
            prerequisites: {
                distinguishability: evidence(
                    geometryPass ? 'pass' : 'fail',
                    `${algorithmCount} algorithms`,
                    'The semantic region had to recur under at least two outcome-blind clustering algorithms.',
                    algorithmCount
                ),
                similarity: evidence(
                    resamplePass ? 'pass' : 'fail',
                    `median stability ${stabilityMedian.toFixed(3)}`,
                    'Member similarity was tested by lineage-group resampling before outcomes were attached.',
                    stabilityMedian
                ),
                persistence: evidence(
                    projectedCorrected ? 'pass' : 'diagnostic',
                    `${Math.round(finite(target.foldSignConsistency, 0) * 100)}% fold direction`,
                    projectedCorrected
                        ? 'The projected association survived global BY correction, grouped intervals, and lineage folds.'
                        : 'The geometry persisted, but the projected outcome association did not clear the complete corrected contract.',
                    finite(target.foldSignConsistency, 0)
                ),
                predictability: evidence(
                    observedConsistency ? 'diagnostic' : projectedCorrected ? 'diagnostic' : 'not_tested',
                    observedConsistency
                        ? `observed keep Δ ${finite(observedContinuous.meanDifference, 0).toFixed(2)} pts`
                        : `projected keep Δ ${finite(target.keepDelta, 0).toFixed(2)} pts`,
                    observedConsistency
                        ? 'Exact-ID-disjoint observed keep agrees directionally, but this diagnostic is not multiplicity-corrected replication.'
                        : 'Projected keep is produced by the same scorer family and cannot independently validate prediction.',
                    observedConsistency
                        ? finite(observedContinuous.meanDifference, null)
                        : finite(target.keepDelta, null)
                ),
            },
            outcomes: {
                projectedTogetherKeep: {
                    meanDifferencePoints: finite(target.keepDelta, null),
                    confidence95: projectedCi || null,
                    q: finite(target.q, null),
                    foldSignConsistency: finite(target.foldSignConsistency, null),
                    riskDifference85: finite(target.riskDifference, null),
                    riskRatio85: finite(target.riskRatio, null),
                    projected: true,
                },
                observedKeepDiagnostic: observed.status === 'ok' ? {
                    n: finite(observed.n, null),
                    sources: finite(observed.uniqueGroups, null),
                    meanDifferencePoints: finite(observedContinuous.meanDifference, null),
                    confidence95: observedContinuous.ci95GroupedBootstrap || null,
                    directionallyConsistent: observedConsistency,
                    multiplicityCorrected: false,
                    replicationClaim: false,
                } : null,
            },
            geometry: {
                algorithms: principle.algorithms || [],
                resolutions: principle.resolutions || [],
                algorithmSupport: algorithmCount,
                resolutionSupport: resolutionCount,
                stability: principle.stability || null,
                transportTier: principle.transportEvidenceTier || 'geometry_only',
            },
            transformations: [
                transformation('outcome_blind', 'pass', 'Cluster membership was frozen before keep outcomes were attached.'),
                transformation('algorithm', geometryPass ? 'pass' : 'fail', `${algorithmCount} supporting algorithms.`, algorithmCount),
                transformation('resolution', resolutionCount > 1 ? 'pass' : 'tested', `${resolutionCount} supporting semantic resolutions.`, resolutionCount),
                transformation('resample', resamplePass ? 'pass' : 'fail', `Median stability ${stabilityMedian.toFixed(3)}.`, stabilityMedian),
                transformation('threshold', 'tested', 'Projected 82.5, 85, and 87.5 thresholds were reported descriptively.'),
                transformation('topic', (principle.resolutions || []).some(row => String(row).startsWith('residual__')) ? 'pass' : 'not_tested',
                    (principle.resolutions || []).some(row => String(row).startsWith('residual__'))
                        ? 'A topic-adjusted residual resolution supports this region.'
                        : 'No topic-adjusted residual resolution supports this retained region.'),
                transformation('time', 'not_tested', 'No forward-time creator-aware discovery split is available.'),
                transformation('source', observedConsistency ? 'diagnostic' : 'not_tested',
                    observedConsistency
                        ? 'Observed private groups agree directionally, without corrected independent replication.'
                        : 'No corrected unseen-source replication.'),
                transformation('format', 'not_tested', 'The region has not been transported to an independent content format.'),
                transformation('observed', observedConsistency ? 'diagnostic' : 'not_tested',
                    observedConsistency
                        ? 'Observed keep direction agrees in an exact-ID-disjoint diagnostic.'
                        : 'Only scorer-projected keep association is available.'),
                transformation('prospective', 'not_tested', 'No prospectively sealed publication test.'),
            ],
            description: descriptionStats(statement),
            claimBoundary: principle.transport?.interpretationBoundary
                || operations.measurementBoundary?.projected
                || 'Association does not establish causality.',
            nextTest: 'Persist creator identity, freeze membership, and test the same contrast on prospectively collected observed keep from unseen creators.',
            examples: (principle.representativeHooks || []).slice(0, 4).map(item => (
                typeof item === 'string' ? item : item.hook || item.title || item.description || ''
            )).filter(Boolean),
        };
    });
}

function buildSystemCandidates(predictor, opening, openingContext, retention) {
    const keep = predictor.targets?.keep || {};
    const views = predictor.targets?.views || {};
    const strict = opening.evaluation?.strictBlindExternal || {};
    const semanticVsBaseline = opening.evaluation?.strictBlindCandidateVsBaseline?.families?.entryIndexed || {};
    const crossDomain = predictor.corpusBenchmark?.crossDomainLongForm?.modalities || {};
    const togetherCorpus = predictor.corpusBenchmark?.modalities?.together || {};
    const retentionPredictor = retention.predictor?.v_best || {};
    const retentionSelection = retention.selection?.interp || {};

    return [
        {
            id: 'system:shorts-opening-decay-baseline',
            family: 'opening_retention',
            familyLabel: 'Opening retention',
            label: 'Pooled Shorts opening-decay baseline',
            statement: 'A duration-conditioned pooled decay curve predicts the average shape of unseen Shorts openings within the observed account family.',
            level: 'regional_invariant',
            ceiling: 'regional_invariant',
            status: 'supported_regionally',
            direction: 'neutral',
            sourceIds: ['promise_blind_openings'],
            sample: {
                observations: finite(strict.videos, 0),
                independentSources: 3,
                groupedUnits: finite(strict.contentComponents, 0),
                boundary: 'Three external accounts in one platform and format; this is not broad domain diversity.',
            },
            prerequisites: {
                distinguishability: evidence('pass', 'second-indexed retention curve', 'Observed curves contain repeatable temporal structure rather than identical outcomes.'),
                similarity: evidence('pass', `${finite(strict.contentComponents, 0)} content components`, 'Exact and near reposts share one statistical vote.', finite(strict.contentComponents, 0)),
                persistence: evidence('pass', 'sealed external cohort', 'Predictions and content-isolation policy were sealed before outcomes were joined.'),
                predictability: evidence('pass', `${finite(strict.sourceEqualCurveMAEPercentagePoints, 0).toFixed(2)}-point curve MAE`, 'This validates the pooled baseline only, not semantic component skill.', finite(strict.sourceEqualCurveMAEPercentagePoints, null)),
            },
            outcomes: {
                strictBlindExternal: {
                    videos: finite(strict.videos, null),
                    contentComponents: finite(strict.contentComponents, null),
                    curveMaePoints: finite(strict.sourceEqualCurveMAEPercentagePoints, null),
                    curveRmsePoints: finite(strict.cellWeightedCurveRMSEPercentagePoints, null),
                    endpointMaePoints: finite(strict.endpointMAEPercentagePoints, null),
                    residualBandCoverage: finite(strict.residualBandCoverageFraction, null),
                },
            },
            transformations: [
                transformation('outcome_blind', 'pass', 'Prediction manifest and isolation policy were sealed before outcome join.'),
                transformation('algorithm', 'tested', 'The promoted stage is the pooled baseline; semantic variants were compared separately.'),
                transformation('resolution', 'tested', 'Retention is evaluated second by second on duration-conditioned risk sets.'),
                transformation('resample', 'pass', 'External repost groups are collapsed to content components.'),
                transformation('threshold', 'not_applicable', 'This candidate predicts a continuous curve, not a threshold event.'),
                transformation('topic', 'pass', 'The baseline does not condition on topic.'),
                transformation('time', 'diagnostic', 'Development chronology was evaluated, but the external claim is a sealed present-day holdout.'),
                transformation('source', 'pass', '361 strict-blind videos from three external accounts.'),
                transformation('format', 'not_tested', 'Only YouTube Shorts retention curves.'),
                transformation('observed', 'pass', 'Measured retention curves were opened after predictions were sealed.'),
                transformation('prospective', 'not_tested', 'The cohort is blind but retrospective, not a future publication lockbox.'),
            ],
            description: descriptionStats('Pooled Shorts opening-decay baseline'),
            claimBoundary: 'This is a stable baseline for average retention decay. It does not show that semantic hook components explain individual differences.',
            nextTest: 'Seal the baseline on future uploads from at least ten unseen accounts and compare both calibration and per-video rank skill.',
            examples: [],
        },
        {
            id: 'system:opening-semantic-increment',
            family: 'opening_retention',
            familyLabel: 'Opening retention',
            label: 'Semantic components add retention prediction',
            statement: 'The four-cluster semantic component and relationship model improves individual retention-curve prediction beyond the pooled opening baseline.',
            level: 'mechanism',
            ceiling: 'regional_invariant',
            status: 'falsified_currently',
            direction: 'positive',
            sourceIds: ['promise_blind_openings', 'promise_context'],
            sample: {
                observations: finite(semanticVsBaseline.videos, 0),
                independentSources: 3,
                groupedUnits: finite(semanticVsBaseline.contentComponents, 0),
                boundary: 'Strict-blind external comparison across three accounts.',
            },
            prerequisites: {
                distinguishability: evidence('pass', `${finite(openingContext.categoryCount, 4)} frozen clusters`, 'A repeatable four-cluster semantic partition exists.', finite(openingContext.categoryCount, 4)),
                similarity: evidence('pass', 'content-isolated groups', 'Near-duplicate policies were frozen without outcomes.'),
                persistence: evidence('fail', 'external candidate lost', 'The semantic candidate did not preserve its development advantage on the strict-blind external cohort.'),
                predictability: evidence('fail', `${finite(semanticVsBaseline.pairedImprovementPercentagePoints, 0).toFixed(3)} points vs baseline`, 'Negative improvement means the candidate was worse than the simpler pooled baseline.', finite(semanticVsBaseline.pairedImprovementPercentagePoints, null)),
            },
            outcomes: {
                strictBlindCandidateVsBaseline: {
                    candidateStage: semanticVsBaseline.candidateStage || null,
                    videos: finite(semanticVsBaseline.videos, null),
                    baselineCurveMaePoints: finite(semanticVsBaseline.baselineCurveMAEPercentagePoints, null),
                    candidateCurveMaePoints: finite(semanticVsBaseline.candidateCurveMAEPercentagePoints, null),
                    improvementPoints: finite(semanticVsBaseline.pairedImprovementPercentagePoints, null),
                    confidence95: semanticVsBaseline.pairedImprovementConfidence95 || null,
                    winFraction: finite(semanticVsBaseline.candidateWinFraction, null),
                },
            },
            transformations: [
                transformation('outcome_blind', 'pass', 'External inference and isolation were sealed before outcomes.'),
                transformation('algorithm', 'tested', 'Baseline and semantic relationship stages were compared.'),
                transformation('resolution', 'pass', 'Variable-length component lattice and four frozen categories.'),
                transformation('resample', 'pass', 'Content-component statistical units collapse reposts.'),
                transformation('threshold', 'not_applicable', 'Continuous curve error comparison.'),
                transformation('topic', 'tested', 'External accounts provide different content mixtures.'),
                transformation('time', 'diagnostic', 'Chronological development folds exist but did not promote the semantic stage.'),
                transformation('source', 'fail', 'Strict-blind external candidate was worse than baseline.'),
                transformation('format', 'not_tested', 'No cross-format retention test.'),
                transformation('observed', 'fail', 'Observed external retention did not support incremental semantic skill.'),
                transformation('prospective', 'not_tested', 'No future publication lockbox.'),
            ],
            description: descriptionStats('Semantic components add retention prediction'),
            claimBoundary: opening.evaluation?.claimBoundary || 'Current evidence does not justify semantic predictive skill.',
            nextTest: 'Keep the four categories frozen, redesign only the incremental model, and require positive paired improvement on a new sealed cohort.',
            examples: [],
        },
        modelCandidate({
            id: 'system:known-account-keep',
            family: 'embedding_predictors',
            familyLabel: 'Embedding predictors',
            label: 'Known-account keep-rate model',
            statement: 'The 45 stored embedding indicators predict observed keep rate across videos from already-known accounts.',
            target: keep,
            localMetric: 'R²',
            localValue: keep.metrics?.r2,
            forwardValue: keep.prospectiveMetrics?.r2,
            unseenValue: keep.stressTests?.find(row => row.label === 'Unseen-account transfer')?.metrics?.r2,
            observations: keep.n,
            sources: keep.sourceSummary?.independentSources,
            sourceIds: ['predictor_private'],
            unit: 'percentage points',
            nextTest: 'Add creator-diverse accounts, freeze the scorer and formula, then require positive R² on entirely unseen accounts and forward uploads.',
        }),
        modelCandidate({
            id: 'system:known-channel-views',
            family: 'embedding_predictors',
            familyLabel: 'Embedding predictors',
            label: 'Known-channel public-views model',
            statement: 'The 45 stored embedding indicators predict current public views for videos from already-known channels.',
            target: views,
            localMetric: 'R²',
            localValue: views.metrics?.r2,
            forwardValue: views.prospectiveMetrics?.r2,
            unseenValue: views.stressTests?.find(row => row.label === 'Unseen-channel transfer')?.metrics?.r2,
            observations: views.n,
            sources: views.sourceSummary?.independentSources,
            sourceIds: ['predictor_saved_channels'],
            unit: 'log10 views',
            nextTest: 'Freeze age-normalized outcomes and test on future videos from at least ten entirely unseen channels.',
        }),
        {
            id: 'system:raw-geometry-views',
            family: 'embedding_geometry',
            familyLabel: 'Embedding geometry',
            label: 'Raw multimodal geometry predicts public views',
            statement: 'Raw multimodal Gemini geometry contains a stable video-level views direction that transports across creators.',
            level: 'mechanism',
            ceiling: 'domain_invariant',
            status: 'falsified_currently',
            direction: 'positive',
            sourceIds: ['predictor_corpus'],
            sample: {
                observations: finite(togetherCorpus.n, 0),
                independentSources: finite(togetherCorpus.sourceSummary?.independentSources, 0),
                groupedUnits: finite(togetherCorpus.n, 0),
                boundary: 'Large video count but creator-macro performance is the relevant diversity test.',
            },
            prerequisites: {
                distinguishability: evidence('pass', '1,536D raw geometry', 'The embedding space separates observations.'),
                similarity: evidence('pass', `video-level ρ ${finite(togetherCorpus.metrics?.spearman, 0).toFixed(3)}`, 'Held-out video ranks show modest within-corpus structure.', finite(togetherCorpus.metrics?.spearman, null)),
                persistence: evidence('fail', `creator-macro R² ${finite(togetherCorpus.sourceSummary?.macroR2, 0).toFixed(2)}`, 'The apparent video-level relationship does not preserve calibrated performance across creators.', finite(togetherCorpus.sourceSummary?.macroR2, null)),
                predictability: evidence('diagnostic', `video-level R² ${finite(togetherCorpus.metrics?.r2, 0).toFixed(3)}`, 'Positive pooled video skill is real inside this sample but does not justify creator-general prediction.', finite(togetherCorpus.metrics?.r2, null)),
            },
            outcomes: {
                groupedVideoFolds: compactMetrics(togetherCorpus.metrics),
                creatorMacro: {
                    independentSources: finite(togetherCorpus.sourceSummary?.independentSources, null),
                    r2: finite(togetherCorpus.sourceSummary?.macroR2, null),
                    spearman: finite(togetherCorpus.sourceSummary?.macroSpearman, null),
                },
            },
            transformations: [
                transformation('outcome_blind', 'pass', 'Raw embeddings exist before view labels are fit.'),
                transformation('algorithm', 'tested', 'Ridge refits occur inside creator-group folds.'),
                transformation('resolution', 'tested', 'Visual, text, and together modalities are reported separately.'),
                transformation('resample', 'pass', 'Creator-group folds hold out videos.'),
                transformation('threshold', 'tested', 'Continuous views and tail-risk outcomes are both reported.'),
                transformation('topic', 'not_tested', 'No complete topic intervention.'),
                transformation('time', 'diagnostic', 'Age cohorts are reported; labels remain current snapshots.'),
                transformation('source', 'fail', 'Creator-macro calibration is strongly negative.'),
                transformation('format', 'diagnostic', 'Long-to-Short transfer is a separate weak rank signal.'),
                transformation('observed', 'pass', 'Public views are observed outcomes.'),
                transformation('prospective', 'not_tested', 'No sealed future views cohort.'),
            ],
            description: descriptionStats('Raw multimodal geometry predicts public views'),
            claimBoundary: 'Pooled rank signal is not a creator-general law. Large n does not substitute for heterogeneous source survival.',
            nextTest: 'Use source-balanced training and a sealed set of unseen creators with fixed-age outcomes.',
            examples: [],
        },
        {
            id: 'system:long-to-short-views',
            family: 'cross_format_transfer',
            familyLabel: 'Cross-format transfer',
            label: 'Long-form views axis transfers to Shorts',
            statement: 'A frozen Long Quant title-and-thumbnail views axis predicts Shorts views without seeing a Shorts outcome.',
            level: 'mechanism',
            ceiling: 'domain_invariant',
            status: 'partial_signal',
            direction: 'positive',
            sourceIds: ['long_to_short_transfer'],
            sample: {
                observations: finite(crossDomain.together?.metrics?.n, 0),
                independentSources: finite(togetherCorpus.sourceSummary?.independentSources, 0),
                groupedUnits: finite(crossDomain.together?.metrics?.n, 0),
                boundary: 'Cross-format rank association is positive, but absolute calibration and error remain poor.',
            },
            prerequisites: {
                distinguishability: evidence('pass', 'frozen Long Quant axis', 'The direction is learned entirely in the long-form corpus.'),
                similarity: evidence('diagnostic', `Shorts ρ ${finite(crossDomain.together?.metrics?.spearman, 0).toFixed(3)}`, 'A small rank signal survives the format change.', finite(crossDomain.together?.metrics?.spearman, null)),
                persistence: evidence('diagnostic', 'three modalities agree weakly', 'Visual, text, and together transfer correlations are all positive.'),
                predictability: evidence('fail', `Shorts R² ${finite(crossDomain.together?.metrics?.r2, 0).toFixed(3)}`, 'Negative R² means the transferred absolute prediction is worse than a Shorts mean baseline.', finite(crossDomain.together?.metrics?.r2, null)),
            },
            outcomes: {
                visual: compactMetrics(crossDomain.visual?.metrics),
                text: compactMetrics(crossDomain.text?.metrics),
                together: compactMetrics(crossDomain.together?.metrics),
                longFormTrainN: finite(crossDomain.together?.longFormTrainN, null),
            },
            transformations: [
                transformation('outcome_blind', 'pass', 'No Shorts outcome fits the transferred Long Quant direction.'),
                transformation('algorithm', 'tested', 'Regularization is selected on Long Quant only.'),
                transformation('resolution', 'pass', 'Visual, text, and together modalities are tested.'),
                transformation('resample', 'tested', 'Long-form training sensitivity is reported.'),
                transformation('threshold', 'not_tested', 'The transfer is evaluated as continuous views.'),
                transformation('topic', 'diagnostic', 'Cross-format content mix changes substantially.'),
                transformation('time', 'not_tested', 'No fixed-age forward cohort.'),
                transformation('source', 'diagnostic', 'Many Shorts creators are present, but source-level calibration is not promoted.'),
                transformation('format', 'diagnostic', 'Positive rank signal, negative absolute R².'),
                transformation('observed', 'pass', 'Shorts views are observed.'),
                transformation('prospective', 'not_tested', 'No future lockbox.'),
            ],
            description: descriptionStats('Long-form views axis transfers to Shorts'),
            claimBoundary: 'This is evidence of weak shared geometry, not a usable cross-format views predictor.',
            nextTest: 'Pre-register a monotonic rank-only transfer metric and evaluate it on fixed-age future Shorts from unseen creators.',
            examples: [],
        },
        {
            id: 'system:keep-retention-duration',
            family: 'retention_views',
            familyLabel: 'Retention to views',
            label: 'Keep, retention, and duration jointly predict views',
            statement: 'Observed keep rate, average retention, and duration jointly preserve useful views information within the private Shorts cohort.',
            level: 'local_invariant',
            ceiling: 'local_invariant',
            status: 'supported_locally',
            direction: 'positive',
            sourceIds: ['retention_private'],
            sample: {
                observations: finite(retention.meta?.n, retention.scatter?.length || 0),
                independentSources: 1,
                groupedUnits: finite(retention.meta?.n, retention.scatter?.length || 0),
                boundary: 'One private creator cohort; all inputs are post-upload observations.',
            },
            prerequisites: {
                distinguishability: evidence('pass', 'three measured variables', 'Keep, retention, and duration vary across videos.'),
                similarity: evidence('pass', `CV R² ${finite(retentionSelection.cv_r2, 0).toFixed(3)}`, 'Cross-validation preserves a moderate within-cohort relationship.', finite(retentionSelection.cv_r2, null)),
                persistence: evidence('diagnostic', 'one creator cohort', 'The relationship repeats across folds but not independent creators.'),
                predictability: evidence('pass', `CV R² ${finite(retentionPredictor.cv_r2, 0).toFixed(3)}`, 'The combination improves within-cohort views prediction over single metrics.', finite(retentionPredictor.cv_r2, null)),
            },
            outcomes: {
                model: {
                    features: retentionPredictor.features || [],
                    coefficients: retentionPredictor.coef || [],
                    intercept: finite(retentionPredictor.intercept, null),
                    cvR2: finite(retentionPredictor.cv_r2, null),
                    residualSdLog10: finite(retentionPredictor.resid_sd_log10, null),
                },
            },
            transformations: [
                transformation('outcome_blind', 'not_applicable', 'This is a supervised post-upload relationship.'),
                transformation('algorithm', 'tested', 'Feature subsets were compared by cross-validation.'),
                transformation('resolution', 'tested', 'Keep, average retention, 5-second retention, and duration subsets were compared.'),
                transformation('resample', 'pass', 'Cross-validation inside the private cohort.'),
                transformation('threshold', 'not_applicable', 'Continuous log views.'),
                transformation('topic', 'not_tested', 'No complete topic adjustment.'),
                transformation('time', 'not_tested', 'No forward-time lockbox.'),
                transformation('source', 'not_tested', 'Single creator cohort.'),
                transformation('format', 'not_tested', 'Shorts only.'),
                transformation('observed', 'pass', 'All inputs and views are observed.'),
                transformation('prospective', 'not_tested', 'Post-upload variables cannot validate pre-upload prediction.'),
            ],
            description: descriptionStats('Keep, retention, and duration jointly predict views'),
            claimBoundary: 'This is a local post-upload relationship, not a pre-upload virality principle.',
            nextTest: 'Freeze the formula and test creator-balanced, fixed-age views outcomes in unseen channels.',
            examples: [],
        },
    ];
}

function modelCandidate(config) {
    const unseenPass = finite(config.unseenValue, -Infinity) > 0;
    const forwardPass = finite(config.forwardValue, -Infinity) > 0;
    const localPass = finite(config.localValue, -Infinity) > 0;
    const status = unseenPass && forwardPass ? 'supported_regionally' : 'falsified_currently';
    const level = unseenPass && forwardPass ? 'regional_invariant' : 'mechanism';
    const stress = config.target.stressTests || [];

    return {
        id: config.id,
        family: config.family,
        familyLabel: config.familyLabel,
        label: config.label,
        statement: config.statement,
        level,
        ceiling: 'regional_invariant',
        status,
        direction: 'positive',
        sourceIds: config.sourceIds,
        sample: {
            observations: finite(config.observations, 0),
            independentSources: finite(config.sources, 0),
            groupedUnits: finite(config.observations, 0),
            boundary: config.target.sourceSummary?.intervalCaveat || 'Limited heterogeneous sources.',
        },
        prerequisites: {
            distinguishability: evidence('pass', `${config.target.singleFeatures?.length || 45} candidate inputs`, 'Stored embedding indicators vary across videos.'),
            similarity: evidence(localPass ? 'pass' : 'fail', `known-source ${config.localMetric} ${finite(config.localValue, 0).toFixed(3)}`, 'Retrospective held-out videos inside known sources.', finite(config.localValue, null)),
            persistence: evidence(forwardPass ? 'pass' : 'fail', `forward ${config.localMetric} ${finite(config.forwardValue, 0).toFixed(3)}`, 'Forward-time performance is the stronger temporal test.', finite(config.forwardValue, null)),
            predictability: evidence(unseenPass ? 'pass' : 'fail', `unseen-source ${config.localMetric} ${finite(config.unseenValue, 0).toFixed(3)}`, 'A principle-like predictor must survive an entirely unseen source.', finite(config.unseenValue, null)),
        },
        outcomes: {
            knownSource: compactMetrics(config.target.metrics),
            contentOnly: compactMetrics(config.target.contentOnlyMetrics),
            withinSource: compactMetrics(config.target.withinSourceMetrics),
            forwardTime: compactMetrics(config.target.prospectiveMetrics),
            stressTests: stress.map(row => ({
                label: row.label,
                metrics: compactMetrics(row.metrics),
            })),
        },
        transformations: [
            transformation('outcome_blind', 'not_applicable', 'This is a supervised predictor.'),
            transformation('algorithm', 'pass', '50,000 deterministic feature subsets were compared inside training partitions.'),
            transformation('resolution', 'pass', 'Visual, text, together, novelty, and metadata inputs were evaluated.'),
            transformation('resample', localPass ? 'pass' : 'fail', `Known-source R² ${finite(config.localValue, 0).toFixed(3)}.`),
            transformation('threshold', 'tested', 'Continuous outcomes and tail thresholds are separately evaluated.'),
            transformation('topic', 'not_tested', 'No complete topic intervention.'),
            transformation('time', forwardPass ? 'pass' : 'fail', `Forward-time R² ${finite(config.forwardValue, 0).toFixed(3)}.`),
            transformation('source', unseenPass ? 'pass' : 'fail', `Unseen-source R² ${finite(config.unseenValue, 0).toFixed(3)}.`),
            transformation('format', 'not_tested', 'No independent platform format test for this fitted model.'),
            transformation('observed', 'pass', `The target is observed ${config.unit}.`),
            transformation('prospective', 'not_tested', 'Forward-time backtests are retrospective and upstream embeddings use current axes.'),
        ],
        description: descriptionStats(config.label),
        claimBoundary: config.target.warning || config.target.primaryValidation || 'Known-source interpolation is not universal prediction.',
        nextTest: config.nextTest,
        examples: [],
    };
}

function assignParetoFronts(candidates) {
    const operationCandidates = candidates.filter(candidate => candidate.family === 'visual_operations');
    const metrics = operationCandidates.map(candidate => ({
        candidate,
        values: [
            finite(candidate.geometry?.algorithmSupport, 0),
            finite(candidate.geometry?.resolutionSupport, 0),
            finite(candidate.geometry?.stability?.median, 0),
            candidate.prerequisites.persistence.state === 'pass' ? 1 : 0,
            candidate.prerequisites.predictability.state === 'diagnostic' ? 1 : 0,
            -finite(candidate.description?.tokens, 0),
        ],
    }));

    let remaining = metrics.slice();
    let front = 1;
    while (remaining.length) {
        const current = remaining.filter(row => !remaining.some(other => {
            if (row === other) return false;
            const noWorse = other.values.every((value, index) => value >= row.values[index]);
            const strictlyBetter = other.values.some((value, index) => value > row.values[index]);
            return noWorse && strictlyBetter;
        }));
        current.forEach(row => {
            row.candidate.pareto = {
                comparableFamily: 'visual_operations',
                front,
                dimensions: [
                    'algorithm support',
                    'resolution support',
                    'median resample stability',
                    'corrected projected persistence',
                    'observed diagnostic availability',
                    'shorter display description',
                ],
                boundary: 'Pareto fronts rank only visual-operation candidates on like-for-like evidence. They are not a scalar principleness score.',
            };
        });
        const ids = new Set(current.map(row => row.candidate.id));
        remaining = remaining.filter(row => !ids.has(row.candidate.id));
        front += 1;
    }

    candidates.filter(candidate => candidate.family !== 'visual_operations').forEach(candidate => {
        candidate.pareto = {
            comparableFamily: null,
            front: null,
            dimensions: [],
            boundary: 'Heterogeneous targets are not collapsed into a cross-study scalar.',
        };
    });
}

function summarize(candidates, sources) {
    const levelCounts = Object.fromEntries(LEVELS.map(level => [
        level.id,
        candidates.filter(candidate => candidate.level === level.id).length,
    ]));
    const statusCounts = candidates.reduce((acc, candidate) => {
        acc[candidate.status] = (acc[candidate.status] || 0) + 1;
        return acc;
    }, {});
    const transformationCounts = Object.fromEntries(TRANSFORMATIONS.map(item => {
        const states = candidates.map(candidate => (
            candidate.transformations.find(row => row.id === item.id)?.state || 'not_tested'
        ));
        return [item.id, {
            pass: states.filter(state => state === 'pass').length,
            fail: states.filter(state => state === 'fail').length,
            diagnostic: states.filter(state => state === 'diagnostic').length,
            tested: states.filter(state => state === 'tested').length,
            notTested: states.filter(state => ['not_tested', 'not_applicable'].includes(state)).length,
        }];
    }));

    return {
        candidateCount: candidates.length,
        sourceCount: sources.length,
        levelCounts,
        statusCounts,
        transformationCounts,
        universalClaims: 0,
        domainClaims: levelCounts.domain_invariant || 0,
        headline: 'Current evidence supports bounded local and regional invariants, not universal principles.',
        strongestSupported: candidates
            .filter(candidate => levelRank(candidate.level) >= levelRank('local_invariant'))
            .map(candidate => candidate.id),
        strongestFalsifications: candidates
            .filter(candidate => candidate.status === 'falsified_currently')
            .map(candidate => candidate.id),
    };
}

function buildArtifact() {
    const operations = readJson(SOURCE_PATHS.operations);
    const predictor = readJson(SOURCE_PATHS.predictor);
    const opening = readJson(SOURCE_PATHS.opening);
    const openingContext = readJson(SOURCE_PATHS.openingContext);
    const retention = readJson(SOURCE_PATHS.retention);

    const sources = [
        {
            id: 'operations_saved_hooks',
            label: 'Operations saved-hook discovery bank',
            domain: 'Shorts visual openings',
            outcome: 'Projected keep',
            observations: finite(operations.source?.n, 0),
            independentSources: null,
            grouping: `${finite(operations.method?.lineages?.groupCount, 0)} semantic lineages`,
            validation: 'Outcome-blind multi-algorithm discovery plus grouped internal inference',
            eligibility: 'local_only',
            claimBoundary: operations.measurementBoundary?.grouping,
            fingerprint: sourceFingerprint(SOURCE_PATHS.operations),
        },
        {
            id: 'operations_observed_diagnostic',
            label: 'Exact-ID-disjoint private keep diagnostic',
            domain: 'Shorts visual openings',
            outcome: 'Observed keep',
            observations: finite(operations.source?.broadCorpus?.observedRows, 0),
            independentSources: finite(operations.source?.broadCorpus?.observedUniqueGroups, 0),
            grouping: 'Private account groups',
            validation: 'Directional diagnostic; no multiplicity-corrected replication',
            eligibility: 'diagnostic_only',
            claimBoundary: operations.measurementBoundary?.observed,
            fingerprint: sourceFingerprint(SOURCE_PATHS.operations),
        },
        {
            id: 'predictor_private',
            label: 'Private pooled retention outcomes',
            domain: 'Shorts',
            outcome: 'Observed keep',
            observations: finite(predictor.coverage?.privateRetentionRows, 0),
            independentSources: finite(predictor.targets?.keep?.sourceSummary?.independentSources, 0),
            grouping: 'Account',
            validation: 'Known-account folds, forward-time backtest, unseen-account stress test',
            eligibility: 'regional_test',
            claimBoundary: predictor.targets?.keep?.warning,
            fingerprint: sourceFingerprint(SOURCE_PATHS.predictor),
        },
        {
            id: 'predictor_saved_channels',
            label: 'Saved-channel public views',
            domain: 'Shorts',
            outcome: 'Current public views',
            observations: finite(predictor.targets?.views?.n, 0),
            independentSources: finite(predictor.targets?.views?.sourceSummary?.independentSources, 0),
            grouping: 'Channel',
            validation: 'Known-channel folds, forward-time backtest, unseen-channel stress test',
            eligibility: 'regional_test',
            claimBoundary: predictor.targets?.views?.warning,
            fingerprint: sourceFingerprint(SOURCE_PATHS.predictor),
        },
        {
            id: 'predictor_corpus',
            label: 'Science Center raw embedding corpus',
            domain: 'Shorts',
            outcome: 'Current public views',
            observations: finite(predictor.corpusBenchmark?.modalities?.together?.n, 0),
            independentSources: finite(predictor.corpusBenchmark?.modalities?.together?.sourceSummary?.independentSources, 0),
            grouping: 'Creator-group folds',
            validation: 'Raw 1,536D geometry refit inside creator-group folds',
            eligibility: 'regional_test',
            claimBoundary: predictor.corpusBenchmark?.description,
            fingerprint: sourceFingerprint(SOURCE_PATHS.predictor),
        },
        {
            id: 'long_to_short_transfer',
            label: 'Long Quant to Shorts frozen transfer',
            domain: 'Long-form to Shorts',
            outcome: 'Current public views',
            observations: finite(predictor.corpusBenchmark?.crossDomainLongForm?.modalities?.together?.metrics?.n, 0),
            independentSources: finite(predictor.corpusBenchmark?.modalities?.together?.sourceSummary?.independentSources, 0),
            grouping: 'Cross-format plus creator',
            validation: 'Long-form-only fit transferred without Shorts labels',
            eligibility: 'domain_test',
            claimBoundary: predictor.corpusBenchmark?.crossDomainLongForm?.description,
            fingerprint: sourceFingerprint(SOURCE_PATHS.predictor),
        },
        {
            id: 'promise_blind_openings',
            label: 'Sealed pooled opening-retention evaluation',
            domain: 'Shorts openings',
            outcome: 'Observed retention curves',
            observations: finite(opening.sources, 0),
            independentSources: Array.isArray(opening.accounts) ? opening.accounts.length : 0,
            grouping: `${finite(opening.blindValidation?.strictBlindContentComponents, 0)} strict-blind content components`,
            validation: 'Prediction-only manifest sealed before outcomes and near-duplicate isolation',
            eligibility: 'regional_test',
            claimBoundary: opening.evaluation?.claimBoundary,
            fingerprint: sourceFingerprint(SOURCE_PATHS.opening),
        },
        {
            id: 'promise_context',
            label: 'Four-cluster opening context study',
            domain: 'Shorts opening semantics',
            outcome: 'Observed forward retention response',
            observations: finite(opening.support?.sourceVideos, 0),
            independentSources: 4,
            grouping: 'Source-grouped folds',
            validation: 'Observed ordering association plus synthetic sensitivity controls',
            eligibility: 'diagnostic_only',
            claimBoundary: openingContext.claimBoundary,
            fingerprint: sourceFingerprint(SOURCE_PATHS.openingContext),
        },
        {
            id: 'retention_private',
            label: 'Private Shorts retention study',
            domain: 'Shorts',
            outcome: 'Observed keep, retention, duration, and views',
            observations: finite(retention.meta?.n, retention.scatter?.length || 0),
            independentSources: 1,
            grouping: 'Video folds inside one creator cohort',
            validation: 'Retrospective cross-validation',
            eligibility: 'local_only',
            claimBoundary: 'Post-upload observational inputs; one creator cohort.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.retention),
        },
    ];

    const candidates = [
        ...buildOperationsCandidates(operations),
        ...buildSystemCandidates(predictor, opening, openingContext, retention),
    ];
    assignParetoFronts(candidates);

    const quarantinedSources = [
        {
            id: 'legacy_bridge',
            label: 'Legacy mechanism-to-indicator bridge',
            reason: 'Retrospective chain-strength ranking without the current discovery, correction, and transport contract.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.bridgeLegacy),
        },
        {
            id: 'legacy_retention_patterns',
            label: 'Legacy retention pattern waves',
            reason: 'Exploratory findings and design-language interpretations are not an independent validation artifact.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.retentionLegacy),
        },
        {
            id: 'legacy_prediction_model',
            label: 'Legacy v27 prediction model',
            reason: 'Contains a documented history of circular-feature removal; retained for audit, not principle promotion.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.predictionLegacy),
        },
        {
            id: 'legacy_forward_response',
            label: 'Promise Lab forward-response diagnostic',
            reason: 'Artifact explicitly marks itself deconfounded but unvalidated and conditional on a post-hoc category map.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.forwardResponseLegacy),
        },
        {
            id: 'legacy_hook_quality',
            label: 'Promise Lab hook-quality diagnostic',
            reason: 'Useful component diagnostics, but not promoted over the sealed strict-blind candidate-versus-baseline result.',
            fingerprint: sourceFingerprint(SOURCE_PATHS.hookQualityLegacy),
        },
    ];

    const artifact = {
        schema: 'predictive-abstraction-lab-v1',
        version: 1,
        generatedAt: new Date().toISOString(),
        title: 'Predictive Abstraction Lab',
        thesis: 'An abstraction is justified only to the extent that it compresses observations and continues to predict after the mechanism, source, time, and domain change.',
        operationalContract: {
            prerequisites: [
                {
                    id: 'distinguishability',
                    label: 'Distinguishability',
                    question: 'Is the proposed pattern measurably different from alternatives?',
                    gate: 'A candidate needs a reproducible contrast, geometry, or outcome difference.',
                },
                {
                    id: 'similarity',
                    label: 'Similarity',
                    question: 'Do related observations remain close under a declared metric?',
                    gate: 'Similarity must survive resampling or an alternative representation.',
                },
                {
                    id: 'persistence',
                    label: 'Persistence',
                    question: 'Does the structure recur when samples, thresholds, or time change?',
                    gate: 'A one-split effect is a mechanism candidate, not an invariant.',
                },
                {
                    id: 'predictability',
                    label: 'Predictability',
                    question: 'Does the compressed representation improve prediction on data that could not select it?',
                    gate: 'The candidate must beat an appropriate baseline out of fold or out of distribution.',
                },
            ],
            ranking: {
                scalarScore: false,
                method: 'Pareto fronts within comparable target families',
                reason: 'Description length, stability, source diversity, and predictive error are not commensurable enough for an honest universal weighted sum.',
                weakestLinkRule: 'A failed prerequisite caps promotion regardless of sample size or strength on the other dimensions.',
            },
            hierarchy: LEVELS,
            predictionLoop: [
                'Observations',
                'Mechanisms',
                'Candidate invariants',
                'Predictions on unseen mechanisms',
                'New observations',
            ],
            diversityRule: 'Independent mechanism and source families matter more than repeated rows from the same family.',
            mdlBoundary: 'A valid minimum-description-length score must encode the model, abstraction, and residuals. Display-label length is shown only as an audit field and never promotes a candidate.',
        },
        transformations: TRANSFORMATIONS,
        sources,
        quarantinedSources,
        candidates,
        summary: summarize(candidates, sources),
        flow: {
            nodes: [
                { id: 'observations', label: 'Source rows', count: sources.reduce((sum, source) => sum + (source.observations || 0), 0), level: 0 },
                { id: 'mechanisms', label: 'Mechanisms', count: candidates.filter(candidate => candidate.level === 'mechanism').length, level: 1 },
                { id: 'local', label: 'Local invariants', count: candidates.filter(candidate => candidate.level === 'local_invariant').length, level: 2 },
                { id: 'regional', label: 'Regional invariants', count: candidates.filter(candidate => candidate.level === 'regional_invariant').length, level: 3 },
                { id: 'domain', label: 'Domain invariants', count: candidates.filter(candidate => candidate.level === 'domain_invariant').length, level: 4 },
                { id: 'universal', label: 'Universal invariants', count: 0, level: 5 },
                { id: 'prediction', label: 'Unseen predictions', count: candidates.filter(candidate => candidate.transformations.some(row => row.id === 'source' && ['pass', 'fail'].includes(row.state))).length, level: 6 },
                { id: 'new_observations', label: 'New observations', count: 0, level: 7 },
            ],
            edges: [
                ['observations', 'mechanisms'],
                ['mechanisms', 'local'],
                ['local', 'regional'],
                ['regional', 'domain'],
                ['domain', 'universal'],
                ['universal', 'prediction'],
                ['domain', 'prediction'],
                ['regional', 'prediction'],
                ['local', 'prediction'],
                ['prediction', 'new_observations'],
                ['new_observations', 'observations'],
            ],
        },
    };

    const withoutHash = JSON.stringify(artifact);
    artifact.artifactHash = crypto.createHash('sha256').update(withoutHash).digest('hex');
    return artifact;
}

if (require.main === module) {
    const artifact = buildArtifact();
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
    console.log(`Candidates: ${artifact.summary.candidateCount}`);
    console.log(`Sources: ${artifact.summary.sourceCount}`);
    console.log(`Artifact: ${artifact.artifactHash}`);
}

module.exports = {
    LEVELS,
    SOURCE_PATHS,
    TRANSFORMATIONS,
    buildArtifact,
    intervalExcludesZero,
};
