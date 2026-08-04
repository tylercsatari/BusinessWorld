'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARTIFACT_PATH = path.join(
    __dirname,
    'predictor-lab',
    'together-concat-keep-interaction.json'
);
const ARTIFACT_BYTES = fs.readFileSync(ARTIFACT_PATH);
const ARTIFACT = JSON.parse(ARTIFACT_BYTES.toString('utf8'));
const ARTIFACT_SHA256 = crypto.createHash('sha256')
    .update(ARTIFACT_BYTES)
    .digest('hex');
const GENERATOR_PATH = path.join(
    __dirname,
    'predictor-lab',
    'run_together_concat_keep_interaction.py'
);
const GENERATOR_SHA256 = crypto.createHash('sha256')
    .update(fs.readFileSync(GENERATOR_PATH))
    .digest('hex');
const COORDINATE_ID =
    'shorts.interaction.together-channel-free-concat.keep.v1';

function finite(value) {
    return value !== null
        && value !== undefined
        && value !== ''
        && Number.isFinite(Number(value));
}

function exactHash(value) {
    return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function validateArtifact() {
    const errors = [];
    const rows = Array.isArray(ARTIFACT.rows) ? ARTIFACT.rows : [];
    const ids = rows.map(row => String(row && row.id || ''));
    const protocol = ARTIFACT.protocol || {};
    const result = ARTIFACT.results && ARTIFACT.results.nestedCombined || {};
    const claim = ARTIFACT.claimBoundary || {};
    const selections = Array.isArray(ARTIFACT.outerSelections)
        ? ARTIFACT.outerSelections
        : [];
    if (ARTIFACT.schema !== 'together-concat-keep-interaction-v1') {
        errors.push('interaction artifact schema is invalid');
    }
    if (ARTIFACT.coordinateId !== COORDINATE_ID) {
        errors.push('interaction coordinate ID is invalid');
    }
    if (!/^[a-f0-9]{16}$/.test(String(ARTIFACT.runId || ''))) {
        errors.push('interaction run identity is invalid');
    }
    if (ARTIFACT.generatorSourceSha256 !== GENERATOR_SHA256) {
        errors.push('interaction generator source revision is invalid');
    }
    if (rows.length !== Number(ARTIFACT.source && ARTIFACT.source.rows)) {
        errors.push('interaction row count does not match source identity');
    }
    if (new Set(ids).size !== rows.length || ids.some(id => !id)) {
        errors.push('interaction rows do not have unique video IDs');
    }
    if (
        !Array.isArray(protocol.candidates)
        || protocol.candidates.length !== Number(protocol.candidateCount)
        || Number(protocol.candidateCount) < 2
        || Number(protocol.candidateCount) !== 23
        || !exactHash(protocol.candidateRegistrySha256)
    ) {
        errors.push('interaction candidate registry is invalid');
    }
    if (
        Number(result.n) !== rows.length
        || !finite(result.mae)
        || !finite(result.r2)
        || !finite(result.spearman)
        || !finite(result.within10pp)
    ) {
        errors.push('interaction nested OOF metrics are invalid');
    }
    if (
        rows.some(row => (
            ![0, 1, 2, 3, 4].includes(Number(row.fold))
            || !finite(row.actualKeep)
            || !finite(row.storedTogetherKeep)
            || !finite(row.channelFreeConcatKeep)
            || !finite(row.prediction)
            || !finite(row.calibratedTogetherBaseline)
            || !finite(row.absoluteError)
        ))
    ) {
        errors.push('interaction per-video OOF rows are invalid');
    }
    if (
        selections.length !== 5
        || selections.map(selection => Number(selection.fold)).sort().join(',') !== '0,1,2,3,4'
        || selections.some(selection => {
            const population = selection.populationAudit || {};
            const inner = Array.isArray(selection.innerFoldAudit)
                ? selection.innerFoldAudit
                : [];
            return Number(population.trainingRowCount) !== Number(selection.trainRows)
                || Number(population.testingRowCount) !== Number(selection.testRows)
                || !exactHash(population.trainingVideoIdSha256)
                || !exactHash(population.testingVideoIdSha256)
                || !exactHash(population.trainingContentFamilySha256)
                || !exactHash(population.testingContentFamilySha256)
                || Number(population.videoIdOverlapCount) !== 0
                || Number(population.contentFamilyOverlapCount) !== 0
                || inner.length !== 4
                || inner.some(split => (
                    !exactHash(split.trainingVideoIdSha256)
                    || !exactHash(split.testingVideoIdSha256)
                    || !exactHash(split.trainingContentFamilySha256)
                    || !exactHash(split.testingContentFamilySha256)
                    || Number(split.videoIdOverlapCount) !== 0
                    || Number(split.contentFamilyOverlapCount) !== 0
                ));
        })
    ) {
        errors.push('interaction nested fold population audit is invalid');
    }
    if (claim.status !== 'research_diagnostic_not_predictor_eligible') {
        errors.push('interaction claim boundary is invalid');
    }
    return {
        valid: errors.length === 0,
        errors,
        rows: rows.length,
        runId: ARTIFACT.runId || null,
        artifactSha256: ARTIFACT_SHA256,
    };
}

const AUDIT = Object.freeze(validateArtifact());
if (!AUDIT.valid) throw new Error(AUDIT.errors.join('; '));

const BY_ID = new Map(
    ARTIFACT.rows.map(row => [String(row.id), Object.freeze({ ...row })])
);

module.exports = {
    ARTIFACT,
    ARTIFACT_BYTES,
    ARTIFACT_PATH,
    ARTIFACT_SHA256,
    AUDIT,
    BY_ID,
    COORDINATE_ID,
    GENERATOR_PATH,
    GENERATOR_SHA256,
    validateArtifact,
};
