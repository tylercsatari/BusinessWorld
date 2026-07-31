#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cloud = require('../cloud-storage');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');
const displayContract = require('../embedding-display-contract');
const longSavedThumbnailRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const longHookLibraryIndex = require(
    '../buildings/jarvis/long-hook-library-index'
);
const longScoreLedger = require(
    '../buildings/jarvis/long-score-ledger'
);
const savedChannelManifestBinding = require(
    '../buildings/jarvis/saved-channel-manifest-binding'
);
const savedChannelRecordBinding = require(
    '../buildings/jarvis/saved-channel-record-binding'
);
const savedChannelValidation = require(
    '../buildings/jarvis/saved-channel-validation'
);
const savedHookRecordBinding = require(
    '../buildings/jarvis/saved-hook-record-binding'
);
const savedHookRuntimeIndex = require(
    '../buildings/jarvis/saved-hook-runtime-index'
);
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);

const ROOT = path.resolve(__dirname, '..');
const R2_MODE = process.argv.includes('--r2')
    || process.argv.includes('--deep-media');
const DEEP_MEDIA = process.argv.includes('--deep-media');
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAVED_CHANNEL_ROOT = 'raw/saved-channels/';
const SAVED_HOOK_INDEX_KEY = 'raw/saved-hooks/index.json';
const LONG_THUMB_INDEX_KEY = 'longform/saved-thumbs/index.json';
const LONG_HOOK_INDEX_KEY = 'longform/hook-embeds/index.json';
const PREDICTOR_RELEASE_KEY = 'raw/predictor-lab/release-v1.json';
const R2_OPERATION_TIMEOUT_MS = Math.max(
    15000,
    Number(process.env.QUANT_AUDIT_R2_TIMEOUT_MS || 60000)
);
const R2_RECORD_CONCURRENCY = Math.max(
    1,
    Math.min(
        16,
        Number.parseInt(
            process.env.QUANT_AUDIT_R2_CONCURRENCY || '12',
            10
        ) || 12
    )
);

const report = {
    schema: 'quant-ledger-integrity-audit-v1',
    generated_at: new Date().toISOString(),
    mode: R2_MODE
        ? DEEP_MEDIA ? 'r2-deep-media' : 'r2-structural'
        : 'local-structural',
    ok: true,
    canonical_failures: [],
    warnings: [],
    surfaces: {},
    summary: {},
};

function sha256Bytes(value) {
    return crypto
        .createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : Buffer.from(value))
        .digest('hex');
}

function unique(values) {
    return [...new Set(values)];
}

function surface(name) {
    if (!report.surfaces[name]) {
        report.surfaces[name] = {
            checks: [],
            canonical_failures: 0,
            warnings: 0,
        };
    }
    return report.surfaces[name];
}

function check(surfaceName, name, passed, details = null, options = {}) {
    const target = surface(surfaceName);
    const severity = options.severity || 'error';
    const entry = {
        name,
        passed: !!passed,
        severity,
        details,
    };
    if (passed && options.recordPassed === false) return entry;
    target.checks.push(entry);
    if (passed) return entry;
    const issue = {
        surface: surfaceName,
        check: name,
        details,
    };
    if (severity === 'warning') {
        target.warnings += 1;
        report.warnings.push(issue);
    } else {
        target.canonical_failures += 1;
        report.canonical_failures.push(issue);
        report.ok = false;
    }
    return entry;
}

function safeJson(buffer, key) {
    if (!buffer) throw new Error(`${key} is missing`);
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
        throw new Error(`${key} is invalid JSON: ${error.message}`);
    }
}

async function r2Buffer(key, required = true) {
    const buffer = await cloud.downloadFromR2(key, {
        timeoutMs: R2_OPERATION_TIMEOUT_MS,
    }).catch(error => {
        if (required) throw error;
        return null;
    });
    if (!buffer && required) throw new Error(`${key} is missing`);
    return buffer;
}

function fileSha256(relativePath) {
    return sha256Bytes(fs.readFileSync(path.join(ROOT, relativePath)));
}

function sourceSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(
        endMarker,
        start + startMarker.length
    );
    return start >= 0 && end > start
        ? source.slice(start, end)
        : '';
}

function localStructuralAudit() {
    const contract = shortsScoreLedger.FEATURE_CONTRACT;
    const governance = shortsScoreLedger.GOVERNANCE;
    const featureIds = shortsScoreLedger.EXPECTED_COORDINATE_IDS;
    const longIds = longScoreLedger.OUTPUT_COORDINATES;
    const registry = savedChannelValidation.buildCoordinateRegistry({});
    const activeIds = registry.columns.map(column => column.id);
    const activeIdSet = new Set(activeIds);
    const aliases = registry.aliases || [];
    const retired = registry.retired || [];

    check(
        'contracts',
        'Shorts feature contract has 21 unique stored coordinates',
        featureIds.length === 21
            && new Set(featureIds).size === featureIds.length,
        { count: featureIds.length }
    );
    check(
        'contracts',
        'Long output contract has 21 unique scalar coordinates',
        longIds.length === 21
            && new Set(longIds).size === longIds.length,
        { count: longIds.length }
    );
    check(
        'contracts',
        'feature-contract bytes match the loaded document hash',
        shortsScoreLedger.FEATURE_CONTRACT_DOCUMENT_SHA256
            === fileSha256(
                'buildings/jarvis/saved-channel-feature-contract.json'
            ),
        {
            sha256:
                shortsScoreLedger.FEATURE_CONTRACT_DOCUMENT_SHA256,
        }
    );
    check(
        'contracts',
        'coordinate-governance bytes match the loaded document hash',
        shortsScoreLedger.GOVERNANCE_SHA256
            === fileSha256(
                'buildings/jarvis/quant-coordinate-governance.json'
            ),
        { sha256: shortsScoreLedger.GOVERNANCE_SHA256 }
    );
    check(
        'contracts',
        'percentiles use one explicit 0-100 storage unit',
        governance.percentileStorageUnit === 'percentile_0_100'
            && longScoreLedger.PERCENTILE_STORAGE_UNIT
                === governance.percentileStorageUnit,
        {
            governance: governance.percentileStorageUnit,
            long: longScoreLedger.PERCENTILE_STORAGE_UNIT,
        }
    );

    check(
        'coordinate-registry',
        'active Shorts validation coordinate IDs are unique',
        activeIds.length === new Set(activeIds).size,
        { count: activeIds.length }
    );
    check(
        'coordinate-registry',
        'registry lineage is structurally complete',
        !!(
            registry.lineageAudit
            && registry.lineageAudit.structuralPassed
        ),
        registry.lineageAudit
            ? {
                missing: registry.lineageAudit.missing,
                brokenReferences:
                    registry.lineageAudit.brokenReferences,
                duplicateActiveAxes:
                    registry.lineageAudit.duplicateActiveAxes,
                aliasErrors: registry.lineageAudit.aliasErrors,
                displayTransformErrors:
                    registry.lineageAudit.displayTransformErrors,
            }
            : null
    );
    check(
        'coordinate-registry',
        'active direct-axis fingerprints are not duplicated',
        !!(
            registry.lineageAudit
            && Array.isArray(
                registry.lineageAudit.duplicateActiveAxes
            )
            && registry.lineageAudit.duplicateActiveAxes.length === 0
        ),
        registry.lineageAudit
            && registry.lineageAudit.duplicateActiveAxes
    );
    check(
        'coordinate-registry',
        'compatibility aliases remain outside the active ledger',
        aliases.every(alias => (
            !activeIdSet.has(alias.id)
            && activeIdSet.has(alias.canonicalId)
        )),
        {
            aliases: aliases.length,
            invalid: aliases.filter(alias => (
                activeIdSet.has(alias.id)
                || !activeIdSet.has(alias.canonicalId)
            )),
        }
    );
    check(
        'coordinate-registry',
        'retired coordinate IDs remain outside the active ledger',
        retired.every(item => !activeIdSet.has(item.id)),
        {
            retired: retired.length,
            activeRetired: retired
                .filter(item => activeIdSet.has(item.id))
                .map(item => item.id),
        }
    );
    check(
        'coordinate-registry',
        'non-stored display transforms resolve to one active source',
        governance.displayTransforms.every(transform => (
            transform.stored === false
            && transform.predictorEligible === false
            && !activeIdSet.has(transform.id)
            && activeIdSet.has(transform.sourceCoordinateId)
        )),
        governance.displayTransforms
    );
    const longMapIds = governance.expansions.longGroups.flatMap(group => (
        contract.crossDomainInventory.longQuant.mapProjections.map(
            projection => governance.coordinates
                .longMapPlacementPattern
                .replace('{group}', group)
                .replace('{projectionKey}', projection)
        )
    ));
    check(
        'coordinate-registry',
        'Long map placements are unique and never scalar outputs',
        longMapIds.length === new Set(longMapIds).size
            && longMapIds.every(id => !longIds.includes(id)),
        {
            placements: longMapIds.length,
            scalarOutputs: longIds.length,
        }
    );
    check(
        'coordinate-registry',
        'empty-provenance registry promotes no blind predictor',
        registry.classification.blind.columns === 0
            && registry.columns.every(column => (
                column.family === 'observed'
                || column.predictorEligible !== true
            )),
        registry.classification
    );

    check(
        'quant-rigor',
        'keep and swipe are one hypothesis family',
        governance.inference.outcomeHypothesisFamilies.keep
            === governance.inference.outcomeHypothesisFamilies.swipe,
        governance.inference.outcomeHypothesisFamilies
    );
    check(
        'quant-rigor',
        'confirmatory claims require creator-diverse evidence',
        Number(
            governance.inference
                .minimumIndependentAccountsForConfirmatoryClaim
        ) >= 5,
        {
            minimumIndependentAccounts:
                governance.inference
                    .minimumIndependentAccountsForConfirmatoryClaim,
            status:
                governance.inference.currentPValueStatus,
        }
    );
    const metricProbe = savedChannelValidation.regressionMetrics([
        { actual: 0, predicted: 0 },
        { actual: 100, predicted: 50 },
        { actual: 50, predicted: 50 },
    ]);
    check(
        'quant-rigor',
        'R-squared uses observed-target total variance',
        Math.abs(Number(metricProbe.r2) - 0.5) < 1e-12,
        metricProbe
    );

    const serverSource = fs.readFileSync(
        path.join(ROOT, 'server.js'),
        'utf8'
    );
    const shortsUiSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'jarvis-retention.js'
        ),
        'utf8'
    );
    const longUiSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'jarvis-longquant.js'
        ),
        'utf8'
    );
    const savedChannelAnalysisSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'saved-channel-analysis.js'
        ),
        'utf8'
    );
    const predictorSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'predictor-lab',
            'run_predictor_lab.py'
        ),
        'utf8'
    );
    const r2JsonCasSource = fs.readFileSync(
        path.join(
            ROOT,
            'buildings',
            'jarvis',
            'r2-json-cas.js'
        ),
        'utf8'
    );
    const predictorReleaseReaders = [
        sourceSection(
            serverSource,
            'async function readPredictorLabReleaseManifest(',
            'async function readPinnedPredictorArtifactBytes('
        ),
        sourceSection(
            serverSource,
            'async function readVisualKeepReleaseManifest(',
            'async function readVisualKeepModel('
        ),
        sourceSection(
            serverSource,
            'async function readCreatorAdaptiveKeepReleaseManifest(',
            'async function readCreatorAdaptiveKeepModel('
        ),
    ];
    check(
        'runtime-authority',
        'all Predictor release readers fail closed on stale feature-contract identity',
        predictorReleaseReaders.length === 3
            && predictorReleaseReaders.every(reader => (
                reader.includes(
                    'Number(savedChannelFeatureContract.version)'
                )
                && reader.includes(
                    'savedChannelFeatureContractDocumentSha256'
                )
                && /Number\(manifest\.featureContractVersion\)\s*!==/.test(
                    reader
                )
                && /manifest\.featureContractSha256\s*!==/.test(
                    reader
                )
                && reader.includes('throw new Error(')
            )),
        {
            readers: [
                'predictor-lab',
                'visual-keep',
                'creator-adaptive-keep',
            ],
            currentFeatureContractVersion:
                shortsScoreLedger.FEATURE_CONTRACT.version,
            currentFeatureContractDocumentSha256:
                shortsScoreLedger
                    .FEATURE_CONTRACT_DOCUMENT_SHA256,
        }
    );
    check(
        'runtime-authority',
        'production server has no mutable Predictor Lab results fallback',
        !serverSource.includes('predictor-lab/results.json'),
        null
    );
    check(
        'runtime-authority',
        'Shorts compatibility caches are validated then removed at the API boundary',
        serverSource.includes('delete result.features;')
            && serverSource.includes('delete result.steer;')
            && serverSource.includes(
                'canonical ledger remains the sole runtime authority'
            ),
        null
    );
    check(
        'runtime-authority',
        'Shorts and Long UIs resolve displayed scores through ledger readers',
        shortsUiSource.includes(
            'function shortsRegisteredCoordinate('
        )
            && shortsUiSource.includes(
                'function shortsDisplayLedgerState(up)'
            )
            && shortsUiSource.includes(
                'const state = shortsDisplayLedgerState(up);'
            )
            && shortsUiSource.includes(
                'function rawUploadIsScored(upload)'
            )
            && shortsUiSource.includes(
                '&& shortsLedgerState(upload).valid'
            )
            && longUiSource.includes(
                'function lqxLedgerState('
            )
            && longUiSource.includes(
                'score.long_score_ledger'
            ),
        null
    );
    check(
        'runtime-authority',
        'saved-channel statistics separate exact input evidence from hash binding and never blend evidence tiers',
        savedChannelAnalysisSource.includes(
            'function selectAnalysisPopulation('
        )
            && savedChannelAnalysisSource.includes(
                'validateShortsInputManifest(video)'
            )
            && savedChannelAnalysisSource.includes(
                "'historical_input_diagnostic'"
            )
            && savedChannelAnalysisSource.includes(
                'historicalInputUnboundWithPublicViews'
            )
            && savedChannelAnalysisSource.includes(
                'invalidInputEvidenceWithPublicViews'
            )
            && savedChannelAnalysisSource.includes(
                'useCanonical ? canonicalRows : historicalRows'
            )
            && !savedChannelAnalysisSource.includes(
                'useCanonical ? canonicalRows : allRows'
            )
            && shortsUiSource.includes(
                'data-savedchannelanalysisevidence'
            )
            && shortsUiSource.includes(
                'Historical diagnostic only'
            )
            && !savedChannelAnalysisSource.includes(
                'allowLegacy: true'
            ),
        null
    );
    const savedRowLoaderStart = predictorSource.indexOf(
        'def load_saved_channel_rows('
    );
    const savedRowLoaderEnd = predictorSource.indexOf(
        '\ndef ',
        savedRowLoaderStart + 5
    );
    const savedRowLoaderSource = predictorSource.slice(
        savedRowLoaderStart,
        savedRowLoaderEnd < 0
            ? predictorSource.length
            : savedRowLoaderEnd
    );
    check(
        'runtime-authority',
        'Predictor fitting excludes historical and prior-revision saved-channel rows',
        savedRowLoaderSource.includes(
            'historicalUnboundRows'
        )
            && savedRowLoaderSource.includes(
                'entries = validate_score_ledger(ledger)'
            )
            && !savedRowLoaderSource.includes(
                'migrate_prior_canonical_score_ledger'
            ),
        null
    );
    const shortsMapInventory = (
        contract.crossDomainInventory
        && contract.crossDomainInventory.shorts
        && contract.crossDomainInventory.shorts.mapProjections
        || []
    );
    check(
        'runtime-authority',
        'retired swipe plane is absent while the governed display transform remains',
        !shortsMapInventory.includes('swipe')
            && new Set(shortsMapInventory).size
                === shortsMapInventory.length
            && governance.displayTransforms.some(transform => (
                transform.id === 'shorts.observed.swipe'
                && transform.formula === '100 - source'
                && transform.stored === false
            )),
        {
            mapProjections: shortsMapInventory,
            displayTransform:
                governance.displayTransforms.find(
                    transform => (
                        transform.id
                            === 'shorts.observed.swipe'
                    )
                ) || null,
        }
    );
    for (const forbidden of [
        'materializeHistoricalScoreLedger(',
        'migratePriorCanonicalScoreLedger(',
        'migratePriorLongScoreLedger(',
        'canonicalizeSavedChannelRecordBinding(',
    ]) {
        check(
            'runtime-authority',
            `production server does not invoke ${forbidden}`,
            !serverSource.includes(forbidden),
            null
        );
    }
    check(
        'runtime-authority',
        'shared JSON CAS uses conditional writes and exact verification',
        r2JsonCasSource.includes('canonicalJsonBytes')
            && r2JsonCasSource.includes(
                'ifMatch: revision.etag'
            )
            && r2JsonCasSource.includes(
                "ifNoneMatch: '*'"
            )
            && r2JsonCasSource.includes(
                'failed exact read-after-write verification'
            ),
        null
    );
    check(
        'runtime-authority',
        'all mutable quant navigation indexes share CAS',
        serverSource.includes(
            'const savedHookIndexCas = createR2JsonCasMutator({'
        )
            && serverSource.includes(
                'const savedChannelIndexCas = createR2JsonCasMutator({'
            )
            && serverSource.includes(
                'const longSavedThumbnailIndexCas = createR2JsonCasMutator({'
            )
            && serverSource.includes(
                'const longHookLibraryIndexCas = createR2JsonCasMutator({'
            )
            && serverSource.includes(
                'storage: r2JsonCasStorage'
            ),
        null
    );
    check(
        'runtime-authority',
        'saved-hook and Long index mutations delegate to shared CAS',
        serverSource.includes(
            'return savedHookIndexCas.mutate(async index =>'
        )
            && serverSource.includes(
                'return longSavedThumbnailIndexCas.mutate(async index =>'
            ),
        null
    );
    const channelWorkerSource = fs.readFileSync(
        path.join(ROOT, 'yt_relay_watcher.py'),
        'utf8'
    );
    check(
        'runtime-authority',
        'saved-channel runtime never migrates or repairs historical scores',
        !channelWorkerSource.includes(
            'def migrate_done_record_bindings'
        )
            && !channelWorkerSource.includes(
                'def requeue_invalid_done_ledgers'
            )
            && !channelWorkerSource.includes(
                'migrate_prior_canonical_score_ledger'
            ),
        null
    );

    report.summary.local = {
        shorts_stored_coordinates: featureIds.length,
        long_scalar_coordinates: longIds.length,
        shorts_validation_coordinates: activeIds.length,
        observed_outcomes:
            registry.classification.outcomes.columns,
        active_direct_embedding_axes:
            registry.totals.shortsDistinctDirectEmbeddingAxes,
        display_transforms:
            governance.displayTransforms.length,
        compatibility_aliases: aliases.length,
        retired_coordinates: retired.length,
        long_map_placements: longMapIds.length,
    };
}

function validateReleaseComponent(component, prefix) {
    return !!(
        component
        && HASH_PATTERN.test(String(component.artifactSha256 || ''))
        && HASH_PATTERN.test(String(component.manifestSha256 || ''))
        && component.artifactKey
            === `${prefix}${component.artifactSha256}.json`
        && component.manifestKey
            === `${prefix}${component.artifactSha256}.manifest.json`
    );
}

async function auditPredictorRelease() {
    const releaseBytes = await r2Buffer(PREDICTOR_RELEASE_KEY);
    const release = safeJson(releaseBytes, PREDICTOR_RELEASE_KEY);
    const currentFeatureContractVersion = Number(
        shortsScoreLedger.FEATURE_CONTRACT.version
    );
    const currentFeatureContractDocumentSha256 =
        shortsScoreLedger.FEATURE_CONTRACT_DOCUMENT_SHA256;
    const components = [
        ['predictor', release.predictor, 'raw/predictor-lab/by-sha256/'],
        [
            'visualKeepModel',
            release.visualKeepModel,
            'raw/predictor-lab/visual-keep-model/by-sha256/',
        ],
        [
            'creatorAdaptiveKeepModel',
            release.creatorAdaptiveKeepModel,
            'raw/predictor-lab/creator-adaptive-keep-model/by-sha256/',
        ],
    ];
    check(
        'predictor-release',
        'atomic release pointer uses current feature contract',
        Number(release.schemaVersion) === 1
            && Number(release.featureContractVersion)
                === currentFeatureContractVersion
            && release.featureContractSha256
                === currentFeatureContractDocumentSha256,
        {
            releaseSha256: sha256Bytes(releaseBytes),
            featureContractVersion:
                release.featureContractVersion,
            currentFeatureContractVersion,
            featureContractSha256:
                release.featureContractSha256,
            currentFeatureContractDocumentSha256,
        }
    );
    const loaded = {};
    for (const [name, component, prefix] of components) {
        const shapeValid = validateReleaseComponent(
            component,
            prefix
        );
        check(
            'predictor-release',
            `${name} release paths are content addressed`,
            shapeValid,
            component
        );
        if (!shapeValid) continue;
        const [artifactBytes, manifestBytes] = await Promise.all([
            r2Buffer(component.artifactKey),
            r2Buffer(component.manifestKey),
        ]);
        const artifactSha256 = sha256Bytes(artifactBytes);
        const manifestSha256 = sha256Bytes(manifestBytes);
        const manifest = safeJson(
            manifestBytes,
            component.manifestKey
        );
        const artifact = safeJson(
            artifactBytes,
            component.artifactKey
        );
        const hashesValid = (
            artifactSha256 === component.artifactSha256
            && manifestSha256 === component.manifestSha256
            && manifest.artifactSha256 === artifactSha256
            && manifest.archiveKey === component.artifactKey
        );
        check(
            'predictor-release',
            `${name} artifact and manifest hashes agree`,
            hashesValid,
            {
                artifactSha256,
                manifestSha256,
                recordedArtifactSha256:
                    component.artifactSha256,
                recordedManifestSha256:
                    component.manifestSha256,
            }
        );
        check(
            'predictor-release',
            `${name} manifest uses the current feature contract and matches the atomic release`,
            Number(manifest.featureContractVersion)
                === currentFeatureContractVersion
                && manifest.featureContractSha256
                    === currentFeatureContractDocumentSha256
                && Number(manifest.featureContractVersion)
                    === Number(release.featureContractVersion)
                && manifest.featureContractSha256
                    === release.featureContractSha256
                && manifest.producerSourceSha256
                    === release.producerSourceSha256
                && Number(manifest.generatedAt)
                    === Number(release.generatedAt),
            {
                manifestGeneratedAt: manifest.generatedAt,
                releaseGeneratedAt: release.generatedAt,
                manifestFeatureContractVersion:
                    manifest.featureContractVersion,
                releaseFeatureContractVersion:
                    release.featureContractVersion,
                currentFeatureContractVersion,
                manifestFeatureContractSha256:
                    manifest.featureContractSha256,
                currentFeatureContractDocumentSha256,
            }
        );
        const artifactIdentity = name === 'predictor'
            ? artifact && artifact.provenance
            : artifact;
        check(
            'predictor-release',
            `${name} artifact uses the current feature contract`,
            !!artifactIdentity
                && Number(artifactIdentity.featureContractVersion)
                    === currentFeatureContractVersion
                && artifactIdentity.featureContractSha256
                    === currentFeatureContractDocumentSha256,
            artifactIdentity
                ? {
                    featureContractVersion:
                        artifactIdentity.featureContractVersion,
                    currentFeatureContractVersion,
                    featureContractSha256:
                        artifactIdentity.featureContractSha256,
                    currentFeatureContractDocumentSha256,
                }
                : null
        );
        loaded[name] = {
            artifact,
            artifactSha256,
            manifest,
            manifestSha256,
        };
    }
    const predictor = loaded.predictor
        && loaded.predictor.artifact;
    const visual = loaded.visualKeepModel
        && loaded.visualKeepModel.artifact;
    const creator = loaded.creatorAdaptiveKeepModel
        && loaded.creatorAdaptiveKeepModel.artifact;
    if (predictor && visual) {
        const reference = predictor
            && predictor.targets
            && predictor.targets.keep
            && predictor.targets.keep.visualOnlyStudy
            && predictor.targets.keep.visualOnlyStudy.modelArtifact
            || predictor.provenance
            && predictor.provenance.visualKeepModelArtifact;
        check(
            'predictor-release',
            'predictor points to the exact visual keep artifact',
            !!reference
                && reference.artifactSha256
                    === loaded.visualKeepModel.artifactSha256
                && reference.archiveKey
                    === release.visualKeepModel.artifactKey,
            reference || null
        );
        check(
            'quant-rigor',
            'frozen visual keep serving model is pooled and clipped',
            visual.coordinateId
                === shortsScoreLedger.GOVERNANCE.coordinates
                    .visualKeepForecast.id
                && visual.formula
                && visual.formula.scope === 'pooled_global'
                && !visual.formula.accounts
                && visual.formula.outputTransform
                    === 'clip(linear_prediction, 0, 100)'
                && Array.isArray(visual.formula.outputBounds)
                && Number(visual.formula.outputBounds[0]) === 0
                && Number(visual.formula.outputBounds[1]) === 100,
            visual.formula || null
        );
    }
    if (predictor && creator) {
        const reference = predictor
            && predictor.targets
            && predictor.targets.keep
            && predictor.targets.keep.creatorAdaptiveStudy
            && predictor.targets.keep.creatorAdaptiveStudy.modelArtifact
            || predictor.provenance
            && predictor.provenance.creatorAdaptiveKeepModelArtifact;
        check(
            'predictor-release',
            'predictor points to the exact creator-adaptive artifact',
            !!reference
                && reference.artifactSha256
                    === loaded.creatorAdaptiveKeepModel.artifactSha256
                && reference.archiveKey
                    === release.creatorAdaptiveKeepModel.artifactKey,
            reference || null
        );
        check(
            'quant-rigor',
            'retrospective creator-adaptive study is not promoted',
            creator.status
                && creator.status.predictorEligible === false
                && creator.status.promoted === false,
            creator.status || null
        );
    }
    const currentProducerSha256 = fileSha256(
        'buildings/jarvis/predictor-lab/run_predictor_lab.py'
    );
    check(
        'predictor-release',
        'deployed release producer matches current source',
        release.producerSourceSha256 === currentProducerSha256,
        {
            deployed: release.producerSourceSha256,
            current: currentProducerSha256,
            note: (
                'A mismatch means the immutable release is historical. '
                + 'It remains replayable but must be rebuilt before '
                + 'claiming the current source produced it.'
            ),
        },
        { severity: 'warning' }
    );
    report.summary.predictor_release = {
        release_sha256: sha256Bytes(releaseBytes),
        generated_at: release.generatedAt || null,
        feature_contract_version:
            release.featureContractVersion || null,
        feature_contract_document_sha256:
            release.featureContractSha256 || null,
        components_verified: Object.keys(loaded).length,
    };
}

async function auditSavedChannels() {
    const keys = await cloud.listR2Keys(
        SAVED_CHANNEL_ROOT,
        { timeoutMs: R2_OPERATION_TIMEOUT_MS }
    );
    const manifestKeys = keys
        .filter(key => /\/manifest\.json$/.test(key))
        .sort();
    const globalVideoOwners = new Map();
    let doneRows = 0;
    let validRows = 0;
    let historicalRows = 0;
    const historicalSamples = [];
    let invalidRows = 0;
    let mediaVerified = 0;
    for (const manifestKey of manifestKeys) {
        const manifest = safeJson(
            await r2Buffer(manifestKey),
            manifestKey
        );
        const rows = Array.isArray(manifest.videos)
            ? manifest.videos
            : [];
        const ids = rows.map(row => String(row && row.id || ''));
        check(
            'saved-channels',
            `${manifest.id || manifestKey} has unique nonempty video IDs`,
            ids.every(Boolean)
                && new Set(ids).size === ids.length,
            {
                rows: ids.length,
                duplicateIds: unique(
                    ids.filter((id, at) => (
                        !id || ids.indexOf(id) !== at
                    ))
                ).slice(0, 20),
            }
        );
        for (const row of rows) {
            if (!row || !row.id) continue;
            const owners = globalVideoOwners.get(String(row.id)) || [];
            owners.push(manifest.id || manifestKey);
            globalVideoOwners.set(String(row.id), owners);
        }
        const completedRows = rows.filter(row => (
            row && row.id && row.status === 'done'
        ));
        doneRows += completedRows.length;
        for (
            let offset = 0;
            offset < completedRows.length;
            offset += R2_RECORD_CONCURRENCY
        ) {
            const batch = completedRows.slice(
                offset,
                offset + R2_RECORD_CONCURRENCY
            );
            await Promise.all(batch.map(async row => {
            const rowLedger =
                shortsScoreLedger.validateScoreLedger(
                    row.score_ledger
                );
            const rowBinding =
                savedChannelManifestBinding
                    .validateManifestRowBinding(row);
            const recordKey =
                savedChannelRecordBinding
                    .savedChannelRecordArtifactKey(
                        manifest.id,
                        row.record_artifact_sha256
                    );
            const recordBytes = await r2Buffer(
                recordKey,
                false
            );
            if (!recordBytes) {
                check(
                    'saved-channels',
                    `${row.id} full score record exists`,
                    false,
                    { recordKey }
                );
                return;
            }
            const record = safeJson(recordBytes, recordKey);
            const pair =
                savedChannelRecordBinding
                    .validateSavedChannelRecordBinding(record, row);
            const recordArtifactValid = (
                row.record_artifact_sha256
                    === sha256Bytes(recordBytes)
                && row.record_byte_length
                    === recordBytes.length
            );
            const noCaches = !Object.prototype.hasOwnProperty.call(
                row,
                'features'
            )
                && !Object.prototype.hasOwnProperty.call(
                    record,
                    'features'
                )
                && !Object.prototype.hasOwnProperty.call(
                    record,
                    'steer'
                );
            let montageBytes = null;
            let inputBinding =
                shortsScoreLedger.validateShortsInputManifest(
                    record,
                    {
                        text:
                            record.text !== undefined
                                ? record.text
                                : record.transcript || '',
                        durationS:
                            record.input_manifest
                            && record.input_manifest.duration_s,
                        creatorProfile:
                            record.input_manifest
                            && record.input_manifest.creator_profile,
                    }
                );
            if (DEEP_MEDIA) {
                const montageKey =
                    `${SAVED_CHANNEL_ROOT}${manifest.id}/montages/${row.id}.jpg`;
                montageBytes = await r2Buffer(
                    montageKey,
                    false
                );
                inputBinding =
                    shortsScoreLedger.validateShortsInputManifest(
                        record,
                        {
                            montageBytes,
                            text:
                                record.text !== undefined
                                    ? record.text
                                    : record.transcript || '',
                            durationS:
                                record.input_manifest
                                && record.input_manifest.duration_s,
                            creatorProfile:
                                record.input_manifest
                                && record.input_manifest.creator_profile,
                        }
                    );
                if (inputBinding.valid) mediaVerified += 1;
            }
            const evidenceValidation =
                savedChannelRecordBinding
                    .validateSavedChannelEvidenceState(
                        record,
                        row,
                        DEEP_MEDIA ? montageBytes : undefined
                    );
            const structurallyValid = rowLedger.valid
                && rowBinding.valid === true
                && pair.valid
                && recordArtifactValid
                && noCaches
                && evidenceValidation.valid;
            const canonicalEvidence = (
                row.evidence_state
                    === savedChannelManifestBinding
                        .CANONICAL_EVIDENCE_STATE
            );
            if (
                structurallyValid
                && canonicalEvidence
                && inputBinding.valid
            ) {
                validRows += 1;
            } else if (
                structurallyValid
                && row.evidence_state
                    === savedChannelManifestBinding
                        .HISTORICAL_EVIDENCE_STATE
            ) {
                historicalRows += 1;
                if (historicalSamples.length < 20) {
                    historicalSamples.push({
                        channel: manifest.id || manifestKey,
                        id: row.id,
                        evidence_state: row.evidence_state,
                        warning: row.evidence_warning || null,
                        inputErrors: inputBinding.errors,
                    });
                }
            } else {
                invalidRows += 1;
                check(
                    'saved-channels',
                    `${manifest.id}/${row.id} canonical score binding`,
                    false,
                    {
                        rowLedgerErrors: rowLedger.errors,
                        rowBindingErrors: rowBinding.errors,
                        pairErrors: pair.errors,
                        evidenceErrors:
                            evidenceValidation.errors,
                        recordArtifactValid,
                        recordedRecordArtifactSha256:
                            row.record_artifact_sha256 || null,
                        actualRecordArtifactSha256:
                            sha256Bytes(recordBytes),
                        inputErrors: inputBinding.errors,
                        denormalizedCachesPresent: !noCaches,
                    },
                    { recordPassed: false }
                );
            }
            }));
        }
    }
    if (historicalRows) {
        check(
            'saved-channels',
            'historical saved-channel rows remain quarantined from fitting',
            false,
            {
                rows: historicalRows,
                samples: historicalSamples,
                note: (
                    'These rows remain browseable, but their exact media '
                    + 'and transcript inputs are not bound to the stored '
                    + 'score record. They are excluded from predictor '
                    + 'training and validation.'
                ),
            },
            {
                severity: 'warning',
                recordPassed: false,
            }
        );
    }
    const crossChannelDuplicates = [...globalVideoOwners.entries()]
        .filter(([, owners]) => new Set(owners).size > 1)
        .map(([id, owners]) => ({ id, owners: unique(owners) }));
    check(
        'saved-channels',
        'a video ID belongs to at most one saved channel',
        crossChannelDuplicates.length === 0,
        crossChannelDuplicates.slice(0, 30)
    );
    report.summary.saved_channels = {
        manifests: manifestKeys.length,
        done_rows: doneRows,
        canonical_rows: validRows,
        historical_unbound_rows: historicalRows,
        invalid_rows: invalidRows,
        media_verified: mediaVerified,
    };
}

function validateSavedHookRuntimeIndex(index) {
    const validation = savedHookRuntimeIndex.validateIndex(index);
    return {
        ...validation,
        expected: validation.expected_sha256,
    };
}

async function auditSavedHooks() {
    const indexBytes = await r2Buffer(
        SAVED_HOOK_INDEX_KEY,
        false
    );
    if (!indexBytes) {
        check(
            'saved-hooks',
            'saved-hook runtime index exists',
            false,
            null,
            { severity: 'warning' }
        );
        return;
    }
    const index = safeJson(indexBytes, SAVED_HOOK_INDEX_KEY);
    const indexValidation =
        validateSavedHookRuntimeIndex(index);
    check(
        'saved-hooks',
        'runtime index is hash-bound and nonduplicated',
        indexValidation.valid,
        indexValidation
    );
    let canonicalValid = 0;
    let mediaVerified = 0;
    for (const row of index.hooks || []) {
        const recordKey = `raw/saved-hooks/${row.id}.json`;
        const recordBytes = await r2Buffer(recordKey, false);
        if (!recordBytes) {
            check(
                'saved-hooks',
                `${row.id} source record exists`,
                false,
                { recordKey }
            );
            continue;
        }
        const record = safeJson(recordBytes, recordKey);
        const domain =
            displayContract.scoreDomainForRecord(record);
        const recordHash =
            displayContract.savedHookScoreRecordSha256(record);
        const compactPair =
            displayContract.validateCompactSavedHookSource(
                row,
                record
            );
        const noCaches = !Object.prototype.hasOwnProperty.call(
            record,
            'features'
        )
            && !Object.prototype.hasOwnProperty.call(
                record,
                'steer'
            );
        let scoreValid;
        let scoreErrors;
        if (domain === 'longquant') {
            const validations = [
                longScoreLedger.validateLongScoreLedger(
                    record.long_score_ledger
                ),
                longScoreLedger.validateLongOutputContract(record),
                longScoreLedger.validateLongScoreAliasContract(record),
                longScoreLedger.validateLongScoreRewardContract(record),
                longScoreLedger.validateLongInputManifest(record),
            ];
            scoreValid = validations.every(result => result.valid);
            scoreErrors = validations.flatMap(
                result => result.errors || []
            );
        } else {
            const ledger =
                shortsScoreLedger.validateScoreLedger(
                    record.score_ledger
                );
            const input =
                shortsScoreLedger.validateShortsInputManifest(
                    record,
                    {
                        text: record.text || '',
                        durationS:
                            record.input_manifest
                            && record.input_manifest.duration_s,
                        creatorProfile:
                            record.input_manifest
                            && record.input_manifest.creator_profile,
                    }
                );
            scoreValid = ledger.valid && input.valid;
            scoreErrors = [
                ...ledger.errors,
                ...input.errors,
            ];
        }
        let mediaValid = true;
        if (DEEP_MEDIA && record.montage_ref) {
            const media = await r2Buffer(
                record.montage_ref.key,
                false
            );
            mediaValid = !!media
                && media.length === record.montage_ref.byte_length
                && sha256Bytes(media)
                    === record.montage_ref.sha256;
            if (mediaValid && record.kind === 'scored') {
                const input = domain === 'longquant'
                    ? longScoreLedger.validateLongInputManifest(
                        record,
                        { imageBytes: media }
                    )
                    : shortsScoreLedger.validateShortsInputManifest(
                        record,
                        {
                            montageBytes: media,
                            text: record.text || '',
                            durationS:
                                record.input_manifest
                                && record.input_manifest.duration_s,
                            creatorProfile:
                                record.input_manifest
                                && record.input_manifest.creator_profile,
                        }
                    );
                mediaValid = input.valid;
                scoreErrors.push(...(input.errors || []));
            }
            if (mediaValid) mediaVerified += 1;
        }
        const valid = (
            record.score_record_sha256 === recordHash
            && compactPair
            && noCaches
            && scoreValid
            && mediaValid
        );
        if (valid) canonicalValid += 1;
        check(
            'saved-hooks',
            `${row.id} canonical record and evidence binding`,
            valid,
            {
                domain,
                recordHashMatches:
                    record.score_record_sha256 === recordHash,
                compactSourceMatches: compactPair,
                denormalizedCachesPresent: !noCaches,
                scoreErrors: unique(scoreErrors),
                mediaValid,
            },
            { recordPassed: false }
        );
    }
    if ((index.legacy_hooks || []).length) {
        check(
            'saved-hooks',
            'legacy saved hooks remain quarantined and non-predictive',
            false,
            {
                count: index.legacy_hooks.length,
                sample: index.legacy_hooks.slice(0, 20).map(row => ({
                    id: row.id,
                    evidence_state: row.evidence_state,
                    warning: row.evidence_warning || null,
                })),
            },
            { severity: 'warning' }
        );
    }
    report.summary.saved_hooks = {
        canonical_rows: (index.hooks || []).length,
        canonical_valid: canonicalValid,
        legacy_unbound: (index.legacy_hooks || []).length,
        media_verified: mediaVerified,
    };
}

async function auditLongSavedThumbnails() {
    const indexBytes = await r2Buffer(
        LONG_THUMB_INDEX_KEY,
        false
    );
    if (!indexBytes) {
        check(
            'long-saved-thumbnails',
            'Long saved-thumbnail index exists',
            false,
            null,
            { severity: 'warning' }
        );
        return;
    }
    const index = safeJson(indexBytes, LONG_THUMB_INDEX_KEY);
    const indexValidation =
        longSavedThumbnailRecord.validateIndex(index);
    check(
        'long-saved-thumbnails',
        'Long saved-thumbnail index is hash-bound',
        indexValidation.valid,
        indexValidation
    );
    let canonicalValid = 0;
    let mediaVerified = 0;
    for (const row of index.rows || []) {
        const recordBytes = await r2Buffer(
            row.record_key,
            false
        );
        if (!recordBytes) {
            check(
                'long-saved-thumbnails',
                `${row.id} record exists`,
                false,
                { key: row.record_key }
            );
            continue;
        }
        const record = safeJson(recordBytes, row.record_key);
        const pair =
            longSavedThumbnailRecord
                .validateIndexRecordPair(row, record);
        let mediaValid = true;
        if (DEEP_MEDIA) {
            const media = await r2Buffer(
                row.media_key,
                false
            );
            mediaValid = !!media
                && media.length === record.media.byte_length
                && sha256Bytes(media)
                    === row.thumbnail_sha256;
            if (mediaValid) mediaVerified += 1;
        }
        const valid = pair.valid && mediaValid;
        if (valid) canonicalValid += 1;
        check(
            'long-saved-thumbnails',
            `${row.id} index, record, score, and media binding`,
            valid,
            {
                pairErrors: pair.errors,
                mediaValid,
            },
            { recordPassed: false }
        );
    }
    if ((index.legacy_unbound || []).length) {
        check(
            'long-saved-thumbnails',
            'legacy Long thumbnails remain quarantined and non-predictive',
            false,
            {
                count: index.legacy_unbound.length,
                sample: index.legacy_unbound.slice(0, 20).map(row => ({
                    id: row.id,
                    state: row.state,
                    errors: row.errors || [],
                })),
            },
            { severity: 'warning' }
        );
    }
    if (index.migration_release) {
        const pointer = index.migration_release;
        const releaseBytes = await r2Buffer(
            pointer.key,
            false
        );
        const releaseValid = !!releaseBytes
            && releaseBytes.length === pointer.byte_length
            && sha256Bytes(releaseBytes)
                === pointer.artifact_sha256;
        check(
            'long-saved-thumbnails',
            'offline migration origin is immutable and byte-exact',
            releaseValid,
            pointer
        );
    }
    report.summary.long_saved_thumbnails = {
        canonical_rows: (index.rows || []).length,
        canonical_valid: canonicalValid,
        legacy_unbound: (index.legacy_unbound || []).length,
        media_verified: mediaVerified,
    };
}

async function auditLongHookLibrary() {
    const indexBytes = await r2Buffer(
        LONG_HOOK_INDEX_KEY,
        false
    );
    if (!indexBytes) {
        check(
            'long-hook-library',
            'Long hook library index exists',
            false,
            null,
            { severity: 'warning' }
        );
        return;
    }
    const index = safeJson(indexBytes, LONG_HOOK_INDEX_KEY);
    const indexValidation =
        longHookLibraryIndex.validateIndex(index);
    check(
        'long-hook-library',
        'Long hook library navigation index is hash-bound',
        indexValidation.valid,
        indexValidation
    );
    let pairValid = 0;
    for (const row of index.rows || []) {
        const recordBytes = await r2Buffer(
            row.record_key,
            false
        );
        if (!recordBytes) {
            check(
                'long-hook-library',
                `${row.id} full record exists`,
                false,
                { key: row.record_key }
            );
            continue;
        }
        const record = safeJson(
            recordBytes,
            row.record_key
        );
        const pair =
            longHookLibraryIndex.validateRowRecordPair(
                row,
                record,
                recordBytes
            );
        if (pair.valid) pairValid += 1;
        check(
            'long-hook-library',
            `${row.id} navigation row matches exact full record`,
            pair.valid,
            pair.errors,
            { recordPassed: false }
        );
    }
    const legacyRows = (index.rows || []).filter(
        row => row.evidence_state === 'legacy_unbound'
    );
    if (legacyRows.length) {
        check(
            'long-hook-library',
            'historical Long hook scores remain explicitly non-predictive',
            false,
            {
                count: legacyRows.length,
                note: (
                    'The original text scores lack current ledger and '
                    + 'input bindings. Their observed hook metadata is '
                    + 'available, but their cached scores are not served '
                    + 'as canonical values.'
                ),
            },
            { severity: 'warning' }
        );
    }
    const release = index.migration_release;
    if (release && release.source_archive_key) {
        const archive = await r2Buffer(
            release.source_archive_key,
            false
        );
        check(
            'long-hook-library',
            'legacy index origin is archived byte-exactly',
            !!archive
                && sha256Bytes(archive)
                    === release.source_index_sha256,
            release
        );
    }
    report.summary.long_hook_library = {
        rows: (index.rows || []).length,
        exact_record_pairs: pairValid,
        canonical_bound:
            index.counts && index.counts.canonical_bound || 0,
        legacy_unbound:
            index.counts && index.counts.legacy_unbound || 0,
    };
}

async function r2Audit() {
    if (!cloud.initR2()) {
        throw new Error(
            'R2 credentials are not configured; source the project .env'
        );
    }
    await auditPredictorRelease();
    await auditSavedChannels();
    await auditSavedHooks();
    await auditLongSavedThumbnails();
    await auditLongHookLibrary();
}

async function main() {
    if (R2_MODE) {
        loadProjectEnvironment({ scriptDirectory: __dirname });
    }
    localStructuralAudit();
    if (R2_MODE) await r2Audit();
    report.summary.canonical_failures =
        report.canonical_failures.length;
    report.summary.warnings = report.warnings.length;
    report.summary.surfaces = Object.keys(report.surfaces).length;
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
}

main().catch(error => {
    report.ok = false;
    report.canonical_failures.push({
        surface: 'audit-runtime',
        check: 'audit completed',
        details: error.stack || error.message,
    });
    report.summary.canonical_failures =
        report.canonical_failures.length;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
});
