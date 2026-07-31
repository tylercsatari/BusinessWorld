#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const analysis = require('../buildings/jarvis/saved-channel-analysis');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');
const {
    sha256Canonical,
    scoreRecordBindingSha256,
} = require('../buildings/jarvis/shorts-score-ledger');
const {
    manifestRowBindingSha256,
} = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const {
    canonicalArtifactIdentity,
} = require('../buildings/jarvis/canonical-json-artifact');

assert.strictEqual(analysis.contract.features.length, 21, 'saved channels must expose exactly 21 canonical outputs');
assert.deepStrictEqual(analysis.contract.groups.map(group => group.key), ['visual', 'text', 'together', 'novelty']);

function exactInputManifest(index, transcriptUsed) {
    const montageSha256 = sha256Canonical({
        fixture: 'saved-channel-analysis',
        index,
    });
    const transcript = transcriptUsed
        ? `Synthetic transcript ${index}`
        : '';
    const embeddingInput = {
        schema: 'shorts-embedding-input-v2',
        montage_sha256: montageSha256,
        transcript,
        channels: {
            visual: '5-frame-montage',
            text: transcriptUsed
                ? 'normalized-transcript'
                : 'absent',
            together: transcriptUsed
                ? '5-frame-montage+normalized-transcript'
                : '5-frame-montage',
        },
    };
    const embeddingFingerprint = sha256Canonical(embeddingInput);
    const scoreInput = {
        schema: 'shorts-score-input-v2',
        embedding_input_fingerprint: embeddingFingerprint,
        embedding_input: embeddingInput,
        duration_ms: 5000,
        creator_profile: null,
    };
    const scoreInputFingerprint = sha256Canonical(scoreInput);
    return {
        domain: 'shorts_raw',
        canonical_montage: {
            montage_sha256: montageSha256,
        },
        transcript_used: transcriptUsed,
        duration_s: 5,
        creator_profile: null,
        embedding_input_fingerprint: embeddingFingerprint,
        score_input_fingerprint: scoreInputFingerprint,
        input_fingerprint: scoreInputFingerprint,
        revision_fingerprint: 'fixture-revision',
        channels: {
            text: {
                text: transcript,
            },
        },
    };
}

const videos = [];
for (let index = 0; index < 48; index++) {
    const signal = Math.sin(index * 0.41) + ((index * 17) % 11) / 20;
    const logViews = 6.2 + signal * 0.9 + Math.sin(index * 2.17) * 0.04;
    const features = {};
    analysis.contract.features.forEach((feature, featureIndex) => {
        if (feature.group === 'text' && index % 4 === 0) return;
        const percentile = feature.key === 'visual.keep'
            ? 50 + signal * 24
            : 50 + Math.sin(index * (featureIndex + 3) * 0.73) * 28;
        const estimate = feature.key === 'visual.views'
            ? Math.pow(10, 6.2 + signal * 0.95)
            : feature.unit === 'views'
                ? Math.pow(10, 6.1 + Math.sin(index * (featureIndex + 5) * 0.39) * 0.7)
                : feature.unit === 'probability'
                    ? Math.max(0, Math.min(1, percentile / 100))
                : percentile;
        features[feature.key] = [estimate, percentile];
    });
    const published = `2025${String((index % 12) + 1).padStart(2, '0')}${String((index % 27) + 1).padStart(2, '0')}`;
    const publishedAt = Date.UTC(
        Number(published.slice(0, 4)),
        Number(published.slice(4, 6)) - 1,
        Number(published.slice(6, 8))
    );
    const views = Math.round(Math.pow(10, logViews));
    const video = {
        id: `v${String(index).padStart(10, '0')}`,
        title: `Synthetic Short ${index}`,
        status: 'done',
        silent: index % 4 === 0,
        views,
        published,
        viewsObservedAt: Date.UTC(2026, 6, 1),
        fixed_horizon_outcome: {
            views,
            horizon_days: 30,
            observed_at: publishedAt + 30 * 86400000,
        },
        features,
        score_ledger: scoreLedgerFromFeatures(features),
        input_manifest: exactInputManifest(index, index % 4 !== 0),
        evidence_state: 'canonical_bound',
        canonical: true,
        predictor_eligible: true,
        evidence_warning: null,
    };
    video.score_record_sha256 =
        scoreRecordBindingSha256(video);
    const fullRecordArtifact = canonicalArtifactIdentity({
        ...video,
    });
    video.record_artifact_sha256 =
        fullRecordArtifact.sha256;
    video.record_byte_length =
        fullRecordArtifact.byte_length;
    video.manifest_row_sha256 =
        manifestRowBindingSha256(video);
    videos.push(video);
}

function rebindVideo(source) {
    const video = {
        ...source,
        input_manifest: JSON.parse(JSON.stringify(source.input_manifest)),
    };
    delete video.manifest_row_sha256;
    delete video.record_artifact_sha256;
    delete video.record_byte_length;
    video.score_record_sha256 = scoreRecordBindingSha256(video);
    const artifact = canonicalArtifactIdentity({ ...video });
    video.record_artifact_sha256 = artifact.sha256;
    video.record_byte_length = artifact.byte_length;
    video.manifest_row_sha256 = manifestRowBindingSha256(video);
    return video;
}

const first = analysis.analyzeChannel({ id: 'chtest', name: 'Synthetic', videos });
assert.strictEqual(first.status, 'fixed_horizon_association');
assert.strictEqual(first.version, 12, 'quant-rigor contract must invalidate legacy cached responses');
assert.strictEqual(first.n, 48);
assert.strictEqual(first.eligibility.completedWithPublicViews, 48, 'eligibility must distinguish scored public-view rows from optional age metadata');
assert.strictEqual(first.eligibility.analysisRows, 48);
assert.strictEqual(
    first.eligibility.canonicalInputBoundWithPublicViews,
    48
);
assert.strictEqual(
    first.eligibility.historicalInputUnboundWithPublicViews,
    0
);
assert.strictEqual(first.eligibility.canonicalLedgerValid, 48);
assert.strictEqual(first.eligibility.legacyLedgerMissing, 0);
assert.strictEqual(first.eligibility.invalidLedgerExcluded, 0);
assert.strictEqual(first.eligibility.hashBoundManifestRows, 48);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        first.eligibility,
        'canonicalManifestRows'
    ),
    false,
    'hash binding and exact canonical input evidence must not be conflated',
);
assert.strictEqual(
    first.evidence.mode,
    'canonical_fixed_horizon_association'
);
assert.strictEqual(first.evidence.inputBoundAnalysisEligible, true);
assert.strictEqual(first.evidence.predictorEligible, false);
assert.strictEqual(first.evidence.blindValidationEligible, false);
assert.strictEqual(first.evidence.upstreamFitExclusionVerified, false);
assert.strictEqual(first.evidence.fixedOutcomeHorizon, true);
assert.strictEqual(first.evidence.fixedOutcomeHorizonDays, 30);
assert.strictEqual(first.inference.confirmatory, false);
assert.strictEqual(first.inference.multiplicityAdjusted, false);
assert.strictEqual(first.inference.decisionEligible, false);
assert.strictEqual(first.evidence.invalidInputEvidenceRows, 0);
assert.strictEqual(first.eligibility.knownPublicationDates, 48);
assert.strictEqual(first.search.exhaustiveCandidates, 1561);
assert.strictEqual(
    first.search.nestedCandidateRegistry,
    'fixed exhaustive singles, pairs, and triples only'
);
assert.strictEqual(
    first.search.exploratoryForwardPathEligibleForHeadline,
    false,
    'full-data forward selection must never enter the headline nested search'
);
assert.strictEqual(first.singles[0].key, 'visual.keep', 'the known synthetic signal must rank first');
assert(first.singles[0].oof.r2 > 0.8, 'known signal should predict unseen rows');
assert(first.models.nestedSelected.r2 > 0.7, 'nested selection should recover the held-out signal');
assert.strictEqual(first.models.nestedSelected.points.length, videos.length);
assert.strictEqual(first.indicatorMatrix.columns.length, 21, 'matrix must contain every canonical indicator');
assert.strictEqual(first.indicatorMatrix.rows.length, videos.length, 'matrix must retain every scored Short');
assert.strictEqual(first.indicatorMatrix.rows[0].views, Math.max(...videos.map(video => video.views)), 'matrix rows should make actual-view trajectory visually explicit');
assert.strictEqual(first.indicatorMatrix.rows[0].rawValues.length, 21, 'matrix must retain exact stored values for point-level readouts');
assert.strictEqual(first.indicatorRelationships.columns.length, 21, 'redundancy map must cover every indicator');
assert.strictEqual(first.indicatorRelationships.matrix.length, 21, 'redundancy map must contain every row');
assert.strictEqual(first.indicatorRelationships.matrix[0].length, 21, 'redundancy map must be square');
assert(first.indicatorRelationships.matrix[0][0].spearman > 0.99, 'an indicator must be perfectly rank-correlated with itself');
assert.strictEqual(first.featureProfiles.length, 21, 'every indicator needs a visible score-to-outcome profile');
assert(first.featureProfiles.every(profile => profile.bins.length >= 2), 'every populated indicator needs visible trajectory bins');
assert(first.featureProfiles.find(profile => profile.key === 'text.keep').missing > 0, 'profile coverage must surface missing text inputs');
assert(first.outcomeProfile.histogram.reduce((sum, bin) => sum + bin.n, 0) === videos.length, 'outcome histogram must account for every analyzed Short');
assert.strictEqual(first.signalSummary.strongestTrajectory.key, 'visual.keep', 'known high-to-high signal should lead the trajectory summary');
assert.strictEqual(first.signalSummary.strongestTrajectory.decisionEligible, false);
assert.strictEqual(first.signalSummary.strongestTrajectory.evidenceTier, 'full-sample-descriptive-screen');
assert(
    first.signalSummary.nestedSinglePolicy.performance.r2 > 0.7,
);
assert.strictEqual(
    Object.hasOwn(
        first.signalSummary.nestedSinglePolicy,
        'mostFrequentlySelectedFeature'
    ),
    false,
    'an adaptive policy cannot inherit one feature name',
);
assert.strictEqual(
    first.signalSummary.strongestFixedSingleExploratory.key,
    'visual.keep',
);
assert.strictEqual(
    first.signalSummary.strongestFixedSingleExploratory
        .evidenceTier,
    'multiplicity-uncorrected-fixed-feature-screen',
);
assert.strictEqual(
    first.signalSummary.nestedSinglePolicy.evidenceTier,
    'input-bound-fixed-horizon-grouped-oof-association',
);
assert.strictEqual(
    first.signalSummary.nestedSinglePolicy.confirmationRequired,
    true,
);
assert.strictEqual(
    first.signalSummary.nestedSinglePolicy.decisionEligible,
    false,
);
assert.strictEqual(
    Object.hasOwn(
        first.signalSummary,
        'strongestBlindSingle'
    ),
    false,
    'an adaptive nested policy must not masquerade as one fixed feature',
);
assert(first.topCombinations.every(row => row.decisionEligible === false));
assert(first.risk.model.topCombinations.every(row => row.decisionEligible === false));
assert(first.singles.find(row => row.key === 'text.keep').coverage < 1, 'missing transcripts must be reported, not silently counted as observed');
assert.strictEqual(
    first.risk.model.status,
    'fixed_horizon_retrospective_association',
    '10M association should run only with its fixed-horizon status visible'
);
assert(first.risk.model.nestedSelected.brierSkill > 0.5, 'selection-safe tail model should recover the synthetic hit signal');
const tenMillionRisk = first.risk.targets.find(target => target.targetViews === 10000000).cohorts.find(cohort => cohort.minAgeDays === 0);
const visualViewsRisk = tenMillionRisk.viewsSignals.find(signalRow => signalRow.key === 'visual.views');
const thirtyMillionThreshold = visualViewsRisk.thresholds.find(row => row.threshold === 30000000);
assert(thirtyMillionThreshold.n > 0 && thirtyMillionThreshold.hitRate > tenMillionRisk.baseRate, '30M normal-views embedding threshold should show conditional lift');
assert(thirtyMillionThreshold.ciLow < thirtyMillionThreshold.hitRate, 'risk table must expose uncertainty instead of treating an observed hit rate as certainty');
const matchedThirtyMillion = first.risk.matchedQuestions.find(question => question.targetViews === 30000000);
assert.strictEqual(matchedThirtyMillion.scoreThreshold, 30000000, 'fixed risk questions must compare like-for-like embedded and actual view cutoffs');
assert.deepStrictEqual(matchedThirtyMillion.signals.map(signal => signal.key), ['visual.views', 'text.views', 'together.views'], 'fixed risk questions must keep visual, text, and combined ordinary views axes distinct');
assert(matchedThirtyMillion.signals[0].passed > 0, 'fixed 30M evidence must retain the sample behind the probability');
assert(first.risk.model.chronological && first.risk.model.chronological.testN > 0, 'newer Shorts must receive a time-ordered retrospective check');
assert.strictEqual(first.risk.model.chronological.prospective, false);
assert.strictEqual(first.risk.model.chronological.fixedHorizon, true);
assert.strictEqual(first.risk.model.predictorEligible, false);
assert.strictEqual(first.risk.model.decisionEligible, false);
assert.strictEqual(first.outcome.fixedHorizon, true);
assert.strictEqual(first.outcome.fixedHorizonDays, 30);
assert.strictEqual(
    first.risk.probabilityCalibrationStatus,
    'descriptive_fixed_horizon_not_end_to_end_blind'
);
assert(
    first.models.nestedSelected.groupedUncertainty.validReplicates >= 160,
    'continuous policy must expose content-family bootstrap uncertainty'
);
assert(
    first.risk.model.nestedSelected.groupedUncertainty
        .validReplicates >= 160,
    'binary policy must expose content-family bootstrap uncertainty'
);
assert(
    first.risk.model.nestedSelected.calibrationBins.every(bin => (
        bin.observedCiLow != null && bin.observedCiHigh != null
    )),
    'OOF calibration bins must expose observed-rate uncertainty'
);
assert.strictEqual(
    first.risk.model.nestedSelected.groupedCalibration.unit,
    'content_family',
);
assert(
    first.risk.model.nestedSelected.groupedCalibration.bins.some(bin => (
        bin.observedInterval
        && bin.observedInterval.validReplicates >= 160
    )),
    'calibration uncertainty must resample complete content families',
);

const lifetimeVideos = videos.map(video => {
    const publishedText = String(video.published);
    const publishedAt = Date.UTC(
        Number(publishedText.slice(0, 4)),
        Number(publishedText.slice(4, 6)) - 1,
        Number(publishedText.slice(6, 8))
    );
    const ageDays = (
        Number(video.viewsObservedAt) - publishedAt
    ) / 86400000;
    const views = Math.round(Math.pow(
        10,
        4 + Math.max(0, Math.min(1, (ageDays - 150) / 550)) * 4
    ));
    const lifetime = {
        ...video,
        views,
    };
    delete lifetime.fixed_horizon_outcome;
    return rebindVideo(lifetime);
});
const lifetime = analysis.analyzeChannel({
    id: 'ch-lifetime',
    name: 'Age-confounded lifetime snapshots',
    videos: lifetimeVideos,
});
assert.strictEqual(
    lifetime.status,
    'right_censored_retrospective',
);
assert.strictEqual(
    lifetime.evidence.mode,
    'right_censored_lifetime_retrospective',
);
assert.strictEqual(lifetime.evidence.fixedOutcomeHorizon, false);
assert.strictEqual(lifetime.evidence.predictorEligible, false);
assert.strictEqual(lifetime.outcome.fixedHorizon, false);
assert(
    lifetime.risk.viewAgeConfound.pearsonLogAgeToLogViews > 0.95,
    'age-only synthetic outcomes should expose the observation-time confound',
);
assert.strictEqual(
    lifetime.risk.probabilityCalibrationStatus,
    'quarantined_right_censored_lifetime',
);
assert.deepStrictEqual(
    lifetime.risk.probabilityCalibration,
    [],
    'right-censored lifetime labels cannot produce a future-probability calibration surface',
);
assert.strictEqual(
    lifetime.risk.model.futureProbabilityEligible,
    false,
);
if (lifetime.risk.model.chronological) {
    assert.strictEqual(
        lifetime.risk.model.chronological.evaluationClass,
        'right-censored-time-ordered-lifetime-association',
    );
    assert.strictEqual(
        lifetime.risk.model.chronological.futureProbabilityEligible,
        false,
    );
}

const nullPermutation = [
    19, 2, 37, 11, 43, 7, 29, 0, 31, 13, 47, 5,
    23, 41, 17, 3, 35, 9, 27, 45, 15, 1, 39, 21,
    6, 33, 12, 46, 24, 8, 42, 18, 4, 30, 16, 44,
    26, 10, 38, 20, 14, 34, 22, 40, 28, 32, 36, 25,
];
const nullVideos = videos.map((video, index) => {
    const permutedViews = videos[nullPermutation[index]].views;
    return rebindVideo({
        ...video,
        views: permutedViews,
        fixed_horizon_outcome: {
            ...video.fixed_horizon_outcome,
            views: permutedViews,
        },
    });
});
const nullAnalysis = analysis.analyzeChannel({
    id: 'ch-null',
    name: 'Null multiplicity fixture',
    videos: nullVideos,
});
assert.strictEqual(nullAnalysis.inference.claimStatus, 'exploratory_only');
assert.strictEqual(
    nullAnalysis.inference.hypothesisAccounting
        .registeredSinglePairTripleModels,
    1561,
);
assert.strictEqual(
    nullAnalysis.inference.hypothesisAccounting
        .directionalFeatureScreens,
    1008,
);
assert.strictEqual(
    nullAnalysis.inference.hypothesisAccounting
        .promotedUnadjustedClaims,
    0,
    'a best-looking null feature cannot be promoted after the multiplicity screen',
);
assert(
    nullAnalysis.topCombinations.every(row => (
        row.decisionEligible === false
    )),
);
assert.strictEqual(
    nullAnalysis.signalSummary.strongestFixedSingleExploratory
        .decisionEligible,
    false,
);

const invalidInputVideos = videos.map(video => ({
    ...video,
    input_manifest: JSON.parse(
        JSON.stringify(video.input_manifest)
    ),
}));
invalidInputVideos[0].input_manifest[
    'embedding_input_fingerprint'
] = 'f'.repeat(64);
invalidInputVideos[0].score_record_sha256 =
    scoreRecordBindingSha256(invalidInputVideos[0]);
const invalidInputArtifact = canonicalArtifactIdentity({
    ...invalidInputVideos[0],
});
invalidInputVideos[0].record_artifact_sha256 =
    invalidInputArtifact.sha256;
invalidInputVideos[0].record_byte_length =
    invalidInputArtifact.byte_length;
invalidInputVideos[0].manifest_row_sha256 =
    manifestRowBindingSha256(invalidInputVideos[0]);
const invalidInputAnalysis = analysis.analyzeChannel({
    id: 'chtest',
    name: 'Synthetic invalid input',
    videos: invalidInputVideos,
});
assert.strictEqual(
    invalidInputAnalysis.status,
    'fixed_horizon_association',
    'remaining exact input-bound fixed-horizon rows may still support retrospective association analysis',
);
assert.strictEqual(invalidInputAnalysis.n, videos.length - 1);
assert.strictEqual(
    invalidInputAnalysis.evidence.mode,
    'canonical_fixed_horizon_subset_association',
);
assert.strictEqual(
    invalidInputAnalysis.evidence.invalidInputEvidenceRows,
    1,
    'a hash-bound row with an internally invalid input fingerprint must be excluded',
);

const historicalVideos = videos.map(video => {
    const historical = {
        ...video,
        evidence_state: 'historical_unbound_input',
        canonical: false,
        predictor_eligible: false,
        evidence_warning:
            'Historical display evidence only. Exact input bytes are unbound.',
    };
    historical.manifest_row_sha256 =
        manifestRowBindingSha256(historical);
    return historical;
});
const historical = analysis.analyzeChannel({
    id: 'chtest',
    name: 'Synthetic historical',
    videos: historicalVideos,
});
assert.strictEqual(historical.status, 'historical_diagnostic');
assert.strictEqual(
    historical.evidence.mode,
    'historical_input_diagnostic'
);
assert.strictEqual(historical.evidence.predictorEligible, false);
assert.strictEqual(
    historical.eligibility.canonicalInputBoundWithPublicViews,
    0
);
assert.strictEqual(
    historical.eligibility.historicalInputUnboundWithPublicViews,
    historicalVideos.length
);
assert.strictEqual(
    historical.signalSummary.nestedSinglePolicy.predictorEligible,
    false
);
assert.strictEqual(
    historical.signalSummary.nestedSinglePolicy.evidenceTier,
    'historical-input-diagnostic'
);
assert.strictEqual(
    historical.models.nestedSelected.predictorEligible,
    false
);
const mixedEvidenceVideos = historicalVideos.map(video => ({
    ...video,
}));
Object.assign(mixedEvidenceVideos[0], {
    evidence_state: 'canonical_bound',
    canonical: true,
    predictor_eligible: false,
    evidence_warning: null,
});
mixedEvidenceVideos[0].manifest_row_sha256 =
    manifestRowBindingSha256(mixedEvidenceVideos[0]);
const mixedEvidence = analysis.analyzeChannel({
    id: 'chtest',
    name: 'Synthetic mixed evidence',
    videos: mixedEvidenceVideos,
});
assert.strictEqual(mixedEvidence.status, 'historical_diagnostic');
assert.strictEqual(mixedEvidence.n, historicalVideos.length - 1);
assert.strictEqual(
    mixedEvidence.evidence.invalidEvidenceRows,
    1,
    'historical diagnostics must not absorb other nonpredictive evidence states',
);
const fingerprint = analysis.savedChannelAnalysisFingerprint({ videos });
const changedVideos = videos.map((video, index) => index ? video : { ...video, views: video.views + 1 });
assert.notStrictEqual(fingerprint, analysis.savedChannelAnalysisFingerprint({ videos: changedVideos }), 'view refreshes must invalidate cached risk analysis');
const changedInputVideos = videos.map((video, index) => (
    index
        ? video
        : {
            ...video,
            input_manifest: {
                ...video.input_manifest,
                duration_s: 5.001,
            },
        }
));
assert.notStrictEqual(
    fingerprint,
    analysis.savedChannelAnalysisFingerprint({
        videos: changedInputVideos,
    }),
    'any exact input-manifest change must invalidate cached analysis',
);
const corruptLedgerVideo = {
    ...videos[0],
    score_ledger: {
        schema: 'broken',
        ledger_sha256: 'a'.repeat(64),
        entries: [{ coordinate_id: 'shorts.stored.visual.keep', value: 70 }],
    },
};
const changedCorruptLedgerVideo = {
    ...corruptLedgerVideo,
    score_ledger: {
        ...corruptLedgerVideo.score_ledger,
        entries: [{ coordinate_id: 'shorts.stored.visual.keep', value: 71 }],
    },
};
assert.notStrictEqual(
    analysis.savedChannelAnalysisFingerprint({
        videos: [corruptLedgerVideo],
    }),
    analysis.savedChannelAnalysisFingerprint({
        videos: [changedCorruptLedgerVideo],
    }),
    'an invalid ledger payload must invalidate analysis even when its claimed SHA is unchanged'
);

const rawCoordinateFeatures = Object.fromEntries(
    analysis.contract.features.map((feature, index) => [
        feature.key,
        [
            feature.key === 'visual.keep'
                ? 73
                : feature.unit === 'probability'
                    ? 0.5
                    : index + 1,
            1,
        ],
    ])
);
const rawCoordinateVideo = {
    score_ledger: scoreLedgerFromFeatures(rawCoordinateFeatures),
};
const visualKeepDefinition = analysis.contract.features.find(
    feature => feature.key === 'visual.keep'
);
assert.strictEqual(
    analysis.modelFeatureValue(rawCoordinateVideo, visualKeepDefinition),
    73,
    'model input must use the declared raw keep coordinate, not its percentile',
);
rawCoordinateFeatures['visual.keep'][1] = 99;
rawCoordinateVideo.score_ledger = scoreLedgerFromFeatures(
    rawCoordinateFeatures
);
assert.strictEqual(
    analysis.modelFeatureValue(rawCoordinateVideo, visualKeepDefinition),
    73,
    'changing only a percentile must never change a raw-coordinate model input',
);

const duplicateRows = [
    { id: 'duplicate-a', title: 'Same Short!', y: 1, video: {} },
    { id: 'duplicate-b', title: ' same short ', y: 0, video: {} },
    { id: 'unique-a', title: 'Unique A', y: 1, video: {} },
    { id: 'unique-b', title: 'Unique B', y: 0, video: {} },
    { id: 'unique-c', title: 'Unique C', y: 1, video: {} },
    { id: 'unique-d', title: 'Unique D', y: 0, video: {} },
    { id: 'unique-e', title: 'Unique E', y: 1, video: {} },
    { id: 'unique-f', title: 'Unique F', y: 0, video: {} },
];
const groupedFolds = analysis.foldAssignments(duplicateRows, 2);
assert.strictEqual(
    groupedFolds.assignments[0],
    groupedFolds.assignments[1],
    'normalized duplicate/repost families must never cross held-out folds'
);
const groupedBinaryFolds = analysis.stratifiedFoldAssignments(
    duplicateRows,
    2
);
assert.strictEqual(
    groupedBinaryFolds.assignments[0],
    groupedBinaryFolds.assignments[1],
    'binary validation must also keep duplicate/repost families together'
);
for (let fold = 0; fold < groupedBinaryFolds.folds; fold++) {
    const testRows = duplicateRows.filter(
        (_, index) => groupedBinaryFolds.assignments[index] === fold
    );
    const trainRows = duplicateRows.filter(
        (_, index) => groupedBinaryFolds.assignments[index] !== fold
    );
    assert(testRows.some(row => row.y >= 0.5));
    assert(testRows.some(row => row.y < 0.5));
    assert(trainRows.some(row => row.y >= 0.5));
    assert(trainRows.some(row => row.y < 0.5));
}
const transformedRepostRows = duplicateRows.map(
    (row, index) => ({
        ...row,
        title: index < 2 ? 'Same transformed repost' : row.title,
        video: {
            input_manifest: {
                canonical_montage: {
                    montage_sha256: String(index).padStart(64, '0'),
                },
            },
        },
    })
);
const transformedRepostFolds = analysis.foldAssignments(
    transformedRepostRows,
    2
);
assert.strictEqual(
    transformedRepostFolds.assignments[0],
    transformedRepostFolds.assignments[1],
    'same-title transformed reposts must stay together despite different montage bytes',
);
const onePositiveFamilyRows = [
    { id: 'p1', title: 'p1', y: 1, contentFamilyId: 'positive-family', video: {} },
    { id: 'p2', title: 'p2', y: 1, contentFamilyId: 'positive-family', video: {} },
    { id: 'n1', title: 'n1', y: 0, contentFamilyId: 'negative-1', video: {} },
    { id: 'n2', title: 'n2', y: 0, contentFamilyId: 'negative-2', video: {} },
    { id: 'n3', title: 'n3', y: 0, contentFamilyId: 'negative-3', video: {} },
    { id: 'n4', title: 'n4', y: 0, contentFamilyId: 'negative-4', video: {} },
    { id: 'n5', title: 'n5', y: 0, contentFamilyId: 'negative-5', video: {} },
    { id: 'n6', title: 'n6', y: 0, contentFamilyId: 'negative-6', video: {} },
];
assert.strictEqual(
    analysis.stratifiedFoldAssignments(
        onePositiveFamilyRows,
        5
    ),
    null,
    'one positive content family cannot support grouped binary CV',
);
const declaredFamilyRows = duplicateRows.map((row, index) => ({
    ...row,
    title: `Unrelated title ${index}`,
    contentFamilyId: index < 2 ? 'shared-content-hash' : `family-${index}`,
}));
const declaredFamilyFolds = analysis.foldAssignments(
    declaredFamilyRows,
    2
);
assert.strictEqual(
    declaredFamilyFolds.assignments[0],
    declaredFamilyFolds.assignments[1],
    'declared content identity must override unrelated titles and remain in one fold',
);
assert.strictEqual(
    analysis.foldAssignments(
        duplicateRows.map(row => ({ ...row, title: 'One repost family' })),
        5
    ).folds,
    0,
    'one repost family cannot create a held-out validation claim'
);

assert.deepStrictEqual(
    analysis.foldAssignments(duplicateRows, 2),
    analysis.foldAssignments(duplicateRows, 2),
    'grouped fold construction must be deterministic'
);

const insufficient = analysis.analyzeChannel({ id: 'small', videos: videos.slice(0, 7) });
assert.strictEqual(insufficient.status, 'insufficient');

const ui = fs.readFileSync(path.join(__dirname, '..', 'buildings/jarvis/jarvis-retention.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
for (const marker of ['data-savedbank', 'data-savedchanneladd', 'data-savedchannelvideo', 'prediction analysis', 'Exploratory public analysis', 'Leakage-controlled retrospective validation', 'data-savedvalidation-canonical', 'All ${allColumns.length} coordinates × all ${outcomes.length} observed outcomes', '${allColumns.length} ledger columns do not mean ${allColumns.length} independent embeddings', 'data-savedvalidationscope', 'data-savedvalidationfeature', 'data-savedvalidationcell', 'data-savedvalidation-video-table', 'Registered held-out prediction', 'data-savedvalidationplotmode', 'data-savedvisualkeep-study', 'Best tested visual-only keep-rate predictor', 'other videos from the same creator may remain', 'This is not a forward-time test', 'data-savedchannelrelationshipatlas', 'data-savedchannelrelationshipplot', 'drawSavedChannelRelationshipPlots', 'Which single indicators track log views?', 'data-savedchannelanalysisevidence', 'Historical diagnostic only', 'diagnostic OOF R²', 'Execution-risk research · does an embedding score separate later view outcomes?', 'data-savedchannelrisktarget', 'data-savedchannelriskcutoff', 'data-savedchannelmatchedquestions', 'data-savedchannelriskprojection', 'data-savedchannelriskevidence', 'data-savedchannelriskinspector', 'data-savedchannelriskdrill', 'data-savedchannelriskthresholdtable', 'data-savedchannelriskcurve', 'data-savedchannelriskcalibration', 'the exact videos behind the number', 'data-savedchannelriskglossary', 'data-savedchannelanalysisartifact', 'conservative EV', 'data-savedchannelmatrix', 'Closest high → high trajectory', 'data-savedchannelindicatorplayground', 'data-savedchannelrelationships', 'data-savedchannelprofileatlas', 'data-savedchannelresiduals', 'savedChannelBinaryCurve', 'continue ${unfinished} unfinished', "st.savedChannelSort = 'feature'", 'wireSavedChannelImages', 'record.montageDataUrl = `/api/raw/saved-channel/']) {
    assert(ui.includes(marker), `Shorts Experiment UI is missing ${marker}`);
}
for (const route of ['/api/raw/saved-channels', '/api/raw/saved-channel', '/api/raw/saved-channel-validation', '/api/raw/hook-enrich', 'savedChannelValidation.buildValidation', 'analyzeSavedChannelOffThread(', 'serveR2ObjectForRequest(req, res, key']) {
    assert(server.includes(route), `server is missing ${route}`);
}
for (const cacheMarker of ["'X-Saved-Analysis'", "'ETag': etag", "storage: persisted ? 'R2'"]) {
    assert(server.includes(cacheMarker), `saved analysis persistence is missing ${cacheMarker}`);
}
assert(
    server.includes("'local:saved-channel-feature-contract.json'")
        && server.includes('savedChannelFeatureContractBytes')
        && server.includes("'local:quant-coordinate-governance.json'")
        && server.includes('quantCoordinateGovernanceBytes'),
    'validation cache fingerprint must include the feature contract and coordinate governance'
);
assert(
    server.includes("'shortsScoreLedgerProducerSource', 'shorts_score_ledger.py'")
        && server.includes(
            "'shortsScoreLedgerReaderSource', 'buildings/jarvis/shorts-score-ledger.js'"
        ),
    'validation fingerprints must include both canonical ledger runtimes'
);
assert(
    server.includes('allowStaleOnSourceError: false'),
    'blind validation must fail closed instead of serving a stale statistical claim'
);
assert(
    server.includes("require('worker_threads')")
        && server.includes('await analyzeSavedChannelOffThread(')
        && server.includes('savedChannelAnalysisInflight'),
    'exhaustive saved-channel analysis must be queued off the HTTP event loop and deduplicated'
);
const analysisSource = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'buildings/jarvis/saved-channel-analysis.js'
    ),
    'utf8'
);
assert(
    analysisSource.includes('const nested = nestedSelection(rows, candidates);')
        && !analysisSource.includes('nestedCandidates'),
    'full-data exploratory feature selection must not enter nested headline validation'
);
assert(auth.includes("saved-channel\\/ch[a-f0-9]{16}\\/montage"), 'saved-channel public-Short montages must be readable by media requests without exposing score records');

console.log(JSON.stringify({
    ok: true,
    features: analysis.contract.features.length,
    candidates: first.search.exhaustiveCandidates,
    topSingle: first.singles[0].key,
    topSingleOofR2: first.singles[0].oof.r2,
    nestedOofR2: first.models.nestedSelected.r2,
    riskBrierSkill: first.risk.model.nestedSelected.brierSkill,
    threshold30MHitRate: thirtyMillionThreshold.hitRate,
}));
