'use strict';

const crypto = require('crypto');
const {
    GOVERNANCE,
    GOVERNANCE_SHA256,
    canonicalJson,
    sha256Canonical,
} = require('./shorts-score-ledger');

const OUTPUT_CHANNELS = Object.freeze([
    ...GOVERNANCE.expansions.longGroups,
]);
const METRIC_DEFINITIONS = Object.freeze(
    GOVERNANCE.expansions.longMetrics.map(definition => Object.freeze({
        ...definition,
    }))
);
const OUTPUT_METRICS = Object.freeze(
    METRIC_DEFINITIONS.map(definition => definition.key)
);

function longOutputCoordinate(channel, metric) {
    return GOVERNANCE.coordinates.longOutputPattern
        .replace('{group}', String(channel))
        .replace('{metricKey}', String(metric));
}

function longMapPlacementCoordinate(channel, projection) {
    return GOVERNANCE.coordinates.longMapPlacementPattern
        .replace('{group}', String(channel))
        .replace('{projectionKey}', String(projection));
}

const OUTPUT_COORDINATES = Object.freeze(
    OUTPUT_CHANNELS.flatMap(channel => OUTPUT_METRICS.map(metric => (
        longOutputCoordinate(channel, metric)
    )))
);
const VISUAL_THRESHOLD_COORDINATE =
    longOutputCoordinate('visual', 'ctrviews');
const TEXT_CTRVIEWS_COORDINATE =
    longOutputCoordinate('text', 'ctrviews');
const TEXT_VIEWS_COORDINATE =
    longOutputCoordinate('text', 'views');
const OUTPUT_CONTRACT_VERSION = 3;
const PERCENTILE_STORAGE_UNIT = GOVERNANCE.percentileStorageUnit;
const SCORE_ALIAS_SCHEMA = 'long-score-alias-contract-v1';
const REWARD_TRACE_SCHEMA = 'long-score-reward-trace-v1';
const SCORE_ALIAS_FIELDS = Object.freeze([
    'pctile',
    'visual_pctile',
    'thumbnail_potential',
    'text_pctile',
]);
const SCORE_ALIAS_SPECS = Object.freeze({
    [VISUAL_THRESHOLD_COORDINATE]: Object.freeze({
        aliases: Object.freeze([
            'pctile',
            'visual_pctile',
            'thumbnail_potential',
        ]),
        decisionUse: 'thumbnail_threshold_and_rewards',
        decisionEligible: true,
    }),
    [TEXT_CTRVIEWS_COORDINATE]: Object.freeze({
        aliases: Object.freeze(['pctile', 'text_pctile']),
        decisionUse: 'text_diagnostic_only',
        decisionEligible: false,
    }),
    [TEXT_VIEWS_COORDINATE]: Object.freeze({
        aliases: Object.freeze(['pctile', 'text_pctile']),
        decisionUse: 'text_diagnostic_only',
        decisionEligible: false,
    }),
});
const VISUAL_CTRVIEWS_ARTIFACT_KEY =
    'longform/thumb-rl/scorer_visual.npz';
const VISUAL_CTRVIEWS_MANIFEST_KEY =
    'longform/thumb-rl/scorer_visual.manifest.json';
const VISUAL_CTRVIEWS_ARCHIVE_PREFIX =
    'longform/thumb-rl/by-sha256';
const VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION = 1;
const QUERY_INPUT_GENERATION = 'longquant-query-input-v2';
const QUERY_INPUT_SCHEMA_VERSION = 2;

if (
    OUTPUT_CHANNELS.join(',') !== 'visual,text,together'
    || OUTPUT_METRICS.length !== 7
    || OUTPUT_COORDINATES.length !== 21
    || new Set(OUTPUT_COORDINATES).size !== OUTPUT_COORDINATES.length
) {
    throw new Error(
        'canonical Long score contract must define visual/text/together x 7'
    );
}

const finite = value => (
    value !== null
    && value !== undefined
    && value !== ''
    && typeof value !== 'boolean'
    && Number.isFinite(Number(value))
);

function sameOptionalNumber(left, right) {
    if (left == null || right == null) {
        return left == null && right == null;
    }
    return finite(left)
        && finite(right)
        && Math.abs(Number(left) - Number(right)) <= 1e-9;
}

function normalizedPercentile(value) {
    if (!finite(value)) return null;
    const numeric = Number(value);
    if (numeric < 0 || numeric > 100) return null;
    return Math.round(numeric * 100) / 10000;
}

function exactArray(value, expected) {
    return Array.isArray(value)
        && value.length === expected.length
        && value.every((item, index) => item === expected[index]);
}

function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length === expected.length
        && keys.every(key => expected.includes(key));
}

function exactSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function sha256Bytes(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function textInputRevision(value) {
    const text = String(value == null ? '' : value);
    const bytes = Buffer.from(text, 'utf8');
    return {
        present: text.length > 0,
        sha256: sha256Bytes(bytes),
        utf8_byte_length: bytes.length,
    };
}

function validateLongInputManifest(scoreOrRecord, expected = {}) {
    const score = scoreOrRecord
        && scoreOrRecord.score
        && typeof scoreOrRecord.score === 'object'
        ? scoreOrRecord.score
        : scoreOrRecord;
    const manifest = score && score.input_manifest;
    const query = manifest && manifest.query_input;
    const errors = [];
    if (!manifest || typeof manifest !== 'object') {
        return {
            valid: false,
            errors: ['Long score input manifest is missing'],
            manifest: null,
            query: null,
        };
    }
    if (
        manifest.domain !== 'longquant'
        || !query
        || typeof query !== 'object'
    ) {
        errors.push('Long score query input identity is missing');
    } else {
        const fingerprintPayload = {
            schema_version: query.schema_version,
            thumbnail: query.thumbnail,
            title: query.title,
            idea: query.idea,
            score_text: query.score_text,
            selected_text_source: query.selected_text_source,
        };
        const fingerprint = sha256Canonical(fingerprintPayload);
        if (
            query.schema_version !== QUERY_INPUT_SCHEMA_VERSION
            || query.generation !== QUERY_INPUT_GENERATION
            || !exactSha256(query.fingerprint_sha256)
            || query.fingerprint_sha256 !== fingerprint
        ) {
            errors.push('Long score query fingerprint differs');
        }
        if (
            canonicalJson(query.text)
                !== canonicalJson(query.score_text)
            || query.text_source !== query.selected_text_source
        ) {
            errors.push('Long score query text compatibility alias differs');
        }
        if (
            manifest.query_input_fingerprint
                !== query.fingerprint_sha256
            || manifest.thumbnail_sha256
                !== (query.thumbnail && query.thumbnail.sha256)
            || manifest.score_text_sha256
                !== (query.score_text && query.score_text.sha256)
        ) {
            errors.push('Long score input manifest aliases differ');
        }
        const expectedThumbnailSha = expected.thumbnailSha256
            || (
                expected.imageBytes != null
                    ? sha256Bytes(expected.imageBytes)
                    : null
            );
        if (
            expectedThumbnailSha
            && (
                !query.thumbnail
                || query.thumbnail.present !== true
                || query.thumbnail.sha256 !== expectedThumbnailSha
                || (
                    expected.imageBytes != null
                    && query.thumbnail.byte_length
                        !== Buffer.byteLength(expected.imageBytes)
                )
            )
        ) {
            errors.push('Long score is bound to different thumbnail bytes');
        }
        for (const [field, value] of [
            ['title', expected.title],
            ['idea', expected.idea],
            ['score_text', expected.scoreText],
        ]) {
            if (
                value !== undefined
                && canonicalJson(query[field])
                    !== canonicalJson(textInputRevision(value))
            ) {
                errors.push(`Long score is bound to different ${field}`);
            }
        }
        const ledger = score && score.long_score_ledger;
        for (const entry of (
            ledger && Array.isArray(ledger.entries)
                ? ledger.entries
                : []
        )) {
            if (
                entry
                && entry.available === true
                && (
                    !entry.provenance
                    || !entry.provenance.query_input
                    || entry.provenance.query_input.fingerprint_sha256
                        !== query.fingerprint_sha256
                )
            ) {
                errors.push(
                    `${entry.coordinate_id || 'Long coordinate'} query binding differs`
                );
            }
        }
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        manifest,
        query,
    };
}

function validateVisualCtrviewsRelease(entry) {
    const errors = [];
    const provenance = entry && entry.provenance;
    const revision = provenance && provenance.artifact_revision;
    const lineage = provenance && provenance.dataset_lineage;
    if (!revision || typeof revision !== 'object') {
        return [
            `${VISUAL_THRESHOLD_COORDINATE} artifact revision is missing`,
        ];
    }
    const artifactSha256 = revision.sha256;
    const expectedArchiveKey = exactSha256(artifactSha256)
        ? `${VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifactSha256}.npz`
        : null;
    const expectedImmutableManifestKey = exactSha256(artifactSha256)
        ? `${VISUAL_CTRVIEWS_ARCHIVE_PREFIX}/${artifactSha256}.manifest.json`
        : null;
    if (
        revision.key !== VISUAL_CTRVIEWS_ARTIFACT_KEY
        || !exactSha256(artifactSha256)
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} mutable artifact identity differs`
        );
    }
    if (
        !expectedArchiveKey
        || revision.immutable_key !== expectedArchiveKey
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} immutable artifact identity differs`
        );
    }
    if (
        revision.manifest_key !== VISUAL_CTRVIEWS_MANIFEST_KEY
        || !exactSha256(revision.manifest_sha256)
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} release manifest identity differs`
        );
    }
    if (
        !expectedImmutableManifestKey
        || revision.immutable_manifest_key !== expectedImmutableManifestKey
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} immutable manifest identity differs`
        );
    }
    if (
        revision.lineage_schema_version
            !== VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION
        || !exactSha256(revision.lineage_manifest_sha256)
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} lineage identity differs`
        );
    }
    if (
        !lineage
        || lineage.lineage_manifest_sha256
            !== revision.lineage_manifest_sha256
        || lineage.release_manifest_sha256 !== revision.manifest_sha256
        || !lineage.lineage_manifest
        || lineage.lineage_manifest.schemaVersion
            !== VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION
    ) {
        errors.push(
            `${VISUAL_THRESHOLD_COORDINATE} dataset lineage is not release-bound`
        );
    }
    return errors;
}

function validateLongScoreLedger(ledger) {
    const entries = ledger && Array.isArray(ledger.entries)
        ? ledger.entries
        : [];
    const valuesById = ledger && ledger.values_by_id;
    const percentilesById = ledger && ledger.percentiles_by_id;
    const coordinateIds = entries.map(entry => (
        entry && entry.coordinate_id
    ));
    const errors = [];
    const entriesById = new Map();

    if (!ledger || typeof ledger !== 'object') {
        errors.push('Long score ledger is missing');
    } else {
        if (ledger.schema !== 'long-stored-score-ledger-v1') {
            errors.push('Long score ledger schema is not canonical');
        }
        if (ledger.schema_version !== 1) {
            errors.push('Long score ledger schema version is unsupported');
        }
        if (
            Object.prototype.hasOwnProperty.call(
                ledger,
                'migration_provenance'
            )
        ) {
            errors.push(
                'Long score ledger migration history must remain outside canonical score identity'
            );
        }
        if (ledger.percentile_unit !== PERCENTILE_STORAGE_UNIT) {
            errors.push('Long score ledger percentile unit differs');
        }
        if (ledger.ledger_version !== GOVERNANCE.ledgerVersion) {
            errors.push('Long score ledger version does not match governance');
        }
        if (
            ledger.governance_schema_version !== GOVERNANCE.schemaVersion
            || ledger.governance_sha256 !== GOVERNANCE_SHA256
        ) {
            errors.push('Long score ledger governance does not match');
        }
        if (!exactArray(ledger.coordinate_ids, OUTPUT_COORDINATES)) {
            errors.push('Long score ledger coordinate inventory differs');
        }
        if (
            !exactArray(coordinateIds, OUTPUT_COORDINATES)
            || new Set(coordinateIds).size !== coordinateIds.length
        ) {
            errors.push(
                'Long score ledger coordinate order or identity differs'
            );
        }
        if (!exactKeys(valuesById, OUTPUT_COORDINATES)) {
            errors.push('Long score ledger value index is not exact');
        }
        if (!exactKeys(percentilesById, OUTPUT_COORDINATES)) {
            errors.push('Long score ledger percentile index is not exact');
        }
        const hashPayload = { ...ledger };
        delete hashPayload.ledger_sha256;
        if (
            typeof ledger.ledger_sha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(ledger.ledger_sha256)
            || ledger.ledger_sha256 !== sha256Canonical(hashPayload)
        ) {
            errors.push('Long score ledger content hash does not match');
        }
    }

    let availableCount = 0;
    OUTPUT_COORDINATES.forEach((coordinate, index) => {
        const entry = entries[index];
        if (!entry || typeof entry !== 'object') return;
        entriesById.set(entry.coordinate_id, entry);
        const [, , expectedGroup, expectedMetric] = coordinate.split('.');
        if (
            entry.coordinate_id !== coordinate
            || entry.group !== expectedGroup
            || entry.metric !== expectedMetric
        ) {
            errors.push(`${coordinate} identity differs`);
        }
        const valueAvailable = finite(entry.value);
        if ((entry.available === true) !== valueAvailable) {
            errors.push(`${coordinate} availability differs`);
        }
        if (entry.available === true) {
            availableCount++;
            if (
                !valuesById
                || Number(valuesById[coordinate]) !== Number(entry.value)
            ) {
                errors.push(`${coordinate} value index differs`);
            }
            if (
                entry.percentile == null
                    ? !percentilesById
                        || percentilesById[coordinate] != null
                    : !finite(entry.percentile)
                        || Number(entry.percentile) < 0
                        || Number(entry.percentile) > 100
                        || !percentilesById
                        || Number(percentilesById[coordinate])
                            !== Number(entry.percentile)
            ) {
                errors.push(`${coordinate} percentile index differs`);
            }
            if (entry.unavailable_reason != null) {
                errors.push(`${coordinate} has an unavailable reason`);
            }
            if (
                !entry.provenance
                || entry.provenance.coordinate !== coordinate
            ) {
                errors.push(`${coordinate} provenance is not addressed`);
            }
            if (coordinate === VISUAL_THRESHOLD_COORDINATE) {
                errors.push(...validateVisualCtrviewsRelease(entry));
            }
        } else {
            if (valuesById && valuesById[coordinate] != null) {
                errors.push(`${coordinate} unavailable value is indexed`);
            }
            if (
                entry.percentile != null
                || (
                    percentilesById
                    && percentilesById[coordinate] != null
                )
            ) {
                errors.push(
                    `${coordinate} unavailable percentile is indexed`
                );
            }
            if (!entry.unavailable_reason) {
                errors.push(`${coordinate} lacks an unavailable reason`);
            }
        }
    });

    const producerErrors = (
        ledger && Array.isArray(ledger.producer_errors)
            ? ledger.producer_errors
            : []
    );
    errors.push(...producerErrors.map(error => `producer: ${error}`));
    if (
        ledger
        && (
            ledger.expected_count !== OUTPUT_COORDINATES.length
            || ledger.schema_complete !== true
            || ledger.available_count !== availableCount
            || ledger.all_values_available
                !== (availableCount === OUTPUT_COORDINATES.length)
            || ledger.contract_valid !== (producerErrors.length === 0)
        )
    ) {
        errors.push('Long score ledger summary counts differ');
    }

    return {
        valid: errors.length === 0,
        errors,
        entries,
        entriesById,
        availableCount,
        ledgerPresent: !!ledger,
    };
}

function migratePriorLongScoreLedger(ledger) {
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
        return null;
    }
    const revisions = (
        GOVERNANCE.compatibility
        && GOVERNANCE.compatibility.migratableLongLedgerRevisions
    ) || [];
    const coordinateIdsSha256 = Array.isArray(ledger.coordinate_ids)
        ? sha256Canonical(ledger.coordinate_ids)
        : null;
    const approvedRevision = revisions.find(revision => (
        revision
        && ledger.ledger_version === revision.ledgerVersion
        && ledger.governance_schema_version
            === revision.governanceSchemaVersion
        && ledger.governance_sha256 === revision.governanceSha256
        && coordinateIdsSha256 === revision.coordinateIdsSha256
    ));
    if (!approvedRevision) return null;
    const priorHashPayload = { ...ledger };
    delete priorHashPayload.ledger_sha256;
    if (
        !exactSha256(ledger.ledger_sha256)
        || ledger.ledger_sha256 !== sha256Canonical(priorHashPayload)
    ) {
        return null;
    }
    const migrated = JSON.parse(JSON.stringify(ledger));
    migrated.ledger_version = GOVERNANCE.ledgerVersion;
    migrated.governance_schema_version = GOVERNANCE.schemaVersion;
    migrated.governance_sha256 = GOVERNANCE_SHA256;
    migrated.percentile_unit = PERCENTILE_STORAGE_UNIT;
    delete migrated.migration_provenance;
    delete migrated.ledger_sha256;
    migrated.ledger_sha256 = sha256Canonical(migrated);
    return validateLongScoreLedger(migrated).valid
        ? migrated
        : null;
}

function longOutputContract(ledger) {
    const validation = validateLongScoreLedger(ledger);
    const unavailable = validation.entries
        .filter(entry => entry && !entry.available)
        .map(entry => ({
            coordinate: entry.coordinate_id,
            reason: entry.unavailable_reason || 'unavailable',
        }));
    return {
        version: OUTPUT_CONTRACT_VERSION,
        ledger_version: GOVERNANCE.ledgerVersion,
        percentile_unit: PERCENTILE_STORAGE_UNIT,
        ledger_sha256: validation.valid && ledger
            ? ledger.ledger_sha256
            : null,
        channels: [...OUTPUT_CHANNELS],
        channel_inputs: {
            visual: 'thumbnail image only',
            text: 'title or idea text only',
            together: 'thumbnail image plus title or idea',
        },
        metrics: [...OUTPUT_METRICS],
        metric_definitions: METRIC_DEFINITIONS.map(
            definition => ({ ...definition })
        ),
        coordinates: [...OUTPUT_COORDINATES],
        expected: OUTPUT_COORDINATES.length,
        available: validation.availableCount,
        unavailable,
        producer_errors: validation.errors,
        schema_complete:
            validation.entries.length === OUTPUT_COORDINATES.length,
        all_values_available: unavailable.length === 0,
        complete: validation.valid,
        contract_valid: validation.valid,
        meaning: 'Complete means the canonical 21-address ledger is structurally valid. Nullable scalar outputs remain explicitly unavailable and are never replaced by 2D map markers.',
    };
}

function validateLongOutputContract(score) {
    const ledger = score && score.long_score_ledger;
    const contract = score && score.output_contract;
    const expected = longOutputContract(ledger);
    const errors = [];
    if (!contract || typeof contract !== 'object') {
        errors.push('Long output contract is missing');
    } else {
        const identityFields = [
            'version',
            'ledger_version',
            'percentile_unit',
            'ledger_sha256',
            'expected',
            'available',
            'schema_complete',
            'all_values_available',
            'complete',
            'contract_valid',
        ];
        for (const field of identityFields) {
            if (contract[field] !== expected[field]) {
                errors.push(`Long output contract ${field} differs`);
            }
        }
        for (const [field, value] of [
            ['channels', OUTPUT_CHANNELS],
            ['metrics', OUTPUT_METRICS],
            ['coordinates', OUTPUT_COORDINATES],
        ]) {
            if (!exactArray(contract[field], value)) {
                errors.push(`Long output contract ${field} differs`);
            }
        }
        if (
            canonicalJson(contract.metric_definitions)
                !== canonicalJson(expected.metric_definitions)
        ) {
            errors.push('Long output contract metric definitions differ');
        }
        if (
            canonicalJson(contract.channel_inputs)
                !== canonicalJson(expected.channel_inputs)
        ) {
            errors.push('Long output contract channel inputs differ');
        }
        if (
            canonicalJson(contract.unavailable)
                !== canonicalJson(expected.unavailable)
        ) {
            errors.push('Long output contract unavailable inventory differs');
        }
        if (
            canonicalJson(contract.producer_errors)
                !== canonicalJson(expected.producer_errors)
        ) {
            errors.push('Long output contract producer errors differ');
        }
    }
    return {
        valid: errors.length === 0 && expected.contract_valid,
        errors: expected.producer_errors.concat(errors),
        ledgerValidation: validateLongScoreLedger(ledger),
        expected,
    };
}

function longLedgerCell(score, group, metric) {
    const coordinateId = GOVERNANCE.coordinates.longOutputPattern
        .replace('{group}', group)
        .replace('{metricKey}', metric);
    if (
        !OUTPUT_CHANNELS.includes(group)
        || !OUTPUT_METRICS.includes(metric)
    ) {
        return {
            ledgerPresent: !!(score && score.long_score_ledger),
            valid: false,
            coordinateId,
            value: null,
            percentile: null,
            entry: null,
            errors: ['unknown Long score coordinate'],
        };
    }
    const ledger = score && score.long_score_ledger;
    const validation = validateLongScoreLedger(ledger);
    const entry = validation.valid
        ? validation.entriesById.get(coordinateId)
        : null;
    const available = !!(
        entry
        && entry.available === true
        && finite(entry.value)
    );
    return {
        ledgerPresent: !!ledger,
        valid: validation.valid,
        coordinateId,
        value: available ? Number(entry.value) : null,
        percentile: available && finite(entry.percentile)
            ? Number(entry.percentile)
            : null,
        entry: available ? entry : null,
        ledgerSha256:
            validation.valid && ledger ? ledger.ledger_sha256 : null,
        errors: validation.errors,
    };
}

function validateLongScoreAliasContract(score) {
    const alias = score && score.score_alias_contract;
    const errors = [];
    if (alias == null) {
        return {
            valid: false,
            errors: ['Long score alias contract is missing'],
        };
    }
    if (
        !alias
        || typeof alias !== 'object'
        || alias.schema !== SCORE_ALIAS_SCHEMA
    ) {
        errors.push('Long score alias contract schema differs');
        return { valid: false, errors };
    }
    const coordinateId = alias.canonical_coordinate_id;
    const spec = SCORE_ALIAS_SPECS[coordinateId];
    if (!OUTPUT_COORDINATES.includes(coordinateId) || !spec) {
        errors.push('Long score alias canonical coordinate is unknown');
    }
    if (alias.canonical_field !== 'percentile') {
        errors.push('Long score alias canonical field differs');
    }
    const [, , group, metric] = String(coordinateId || '').split('.');
    const cell = longLedgerCell(score, group, metric);
    const expectedValue = normalizedPercentile((
        cell.valid
        && cell.entry
        && finite(cell.entry.percentile)
    ) ? cell.entry.percentile : null);
    if (
        alias.canonical_value == null
            ? expectedValue != null
            : !finite(alias.canonical_value)
                || Number(alias.canonical_value) !== expectedValue
    ) {
        errors.push('Long score alias canonical value differs');
    }
    const compatibilityAliases = alias.compatibility_aliases;
    if (
        !compatibilityAliases
        || typeof compatibilityAliases !== 'object'
        || Array.isArray(compatibilityAliases)
    ) {
        errors.push('Long score compatibility aliases are missing');
    } else if (spec) {
        const names = Object.keys(compatibilityAliases);
        if (
            names.length !== spec.aliases.length
            || !spec.aliases.every(name => names.includes(name))
        ) {
            errors.push('Long score compatibility alias set differs');
        }
        for (const [name, binding] of Object.entries(compatibilityAliases)) {
            if (
                !spec.aliases.includes(name)
                || !binding
                || binding.coordinate_id !== coordinateId
                || binding.field !== 'percentile'
            ) {
                errors.push('Long score compatibility alias binding differs');
                break;
            }
        }
        if (
            alias.decision_use !== spec.decisionUse
            || alias.decision_eligible !== spec.decisionEligible
        ) {
            errors.push('Long score alias decision contract differs');
        }
        for (const name of SCORE_ALIAS_FIELDS) {
            const expected = spec.aliases.includes(name)
                ? expectedValue
                : null;
            if (!sameOptionalNumber(score && score[name], expected)) {
                errors.push(`Long score compatibility field ${name} differs`);
            }
        }
    }
    return { valid: errors.length === 0, errors };
}

function validateLongScoreRewardContract(score) {
    const alias = score && score.score_alias_contract;
    const coordinateId = alias && alias.canonical_coordinate_id;
    if (coordinateId !== VISUAL_THRESHOLD_COORDINATE) {
        return { valid: true, applicable: false, errors: [] };
    }
    const errors = [];
    const trace = score && score.reward_trace;
    const requiredTraceFields = [
        'schema',
        'visual_pctile',
        'relevance',
        'relevance_floor',
        'relevance_penalty',
        'density',
        'density_floor',
        'density_penalty',
        'idea_model_reward',
        'thumbnail_model_reward',
        'threshold_score',
        'threshold_channel',
        'together_used_for_threshold',
    ];
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
        return {
            valid: false,
            applicable: true,
            errors: ['Long score reward trace is missing'],
        };
    }
    if (
        trace.schema !== REWARD_TRACE_SCHEMA
        || !requiredTraceFields.every(field => (
            Object.prototype.hasOwnProperty.call(trace, field)
        ))
    ) {
        errors.push('Long score reward trace schema differs');
    }
    const cell = longLedgerCell(score, 'visual', 'ctrviews');
    const percentile = normalizedPercentile(
        cell.valid && cell.entry ? cell.entry.percentile : null
    );
    const nullableNumbers = [
        trace.relevance,
        trace.relevance_floor,
        trace.relevance_penalty,
        trace.density,
        trace.density_floor,
        trace.density_penalty,
        trace.idea_model_reward,
        trace.thumbnail_model_reward,
    ];
    if (!nullableNumbers.every(value => value == null || finite(value))) {
        errors.push('Long score reward trace contains a non-numeric value');
    }
    if (
        !sameOptionalNumber(trace.visual_pctile, percentile)
        || !sameOptionalNumber(trace.threshold_score, percentile)
        || trace.threshold_channel !== 'visual'
        || trace.together_used_for_threshold !== false
    ) {
        errors.push('Long score reward threshold binding differs');
    }
    if (
        !sameOptionalNumber(trace.relevance, score && score.relevance)
        || !sameOptionalNumber(trace.density, score && score.nn_cos)
        || !sameOptionalNumber(
            trace.idea_model_reward,
            score && score.idea_model_reward
        )
        || !sameOptionalNumber(
            trace.thumbnail_model_reward,
            score && score.thumbnail_model_reward
        )
        || !sameOptionalNumber(
            score && score.training_reward,
            score && score.thumbnail_model_reward
        )
    ) {
        errors.push('Long score reward output binding differs');
    }
    const expectedReward = score && score.thumbnail_model_reward == null
        ? percentile
        : score.thumbnail_model_reward;
    if (!sameOptionalNumber(score && score.reward, expectedReward)) {
        errors.push('Long score primary reward differs');
    }
    return {
        valid: errors.length === 0,
        applicable: true,
        errors,
    };
}

module.exports = {
    METRIC_DEFINITIONS,
    OUTPUT_CHANNELS,
    OUTPUT_CONTRACT_VERSION,
    OUTPUT_COORDINATES,
    OUTPUT_METRICS,
    PERCENTILE_STORAGE_UNIT,
    SCORE_ALIAS_SCHEMA,
    REWARD_TRACE_SCHEMA,
    VISUAL_THRESHOLD_COORDINATE,
    VISUAL_CTRVIEWS_ARCHIVE_PREFIX,
    VISUAL_CTRVIEWS_ARTIFACT_KEY,
    VISUAL_CTRVIEWS_LINEAGE_SCHEMA_VERSION,
    VISUAL_CTRVIEWS_MANIFEST_KEY,
    longLedgerCell,
    longMapPlacementCoordinate,
    longOutputCoordinate,
    longOutputContract,
    migratePriorLongScoreLedger,
    validateLongInputManifest,
    validateLongOutputContract,
    validateLongScoreAliasContract,
    validateLongScoreRewardContract,
    validateLongScoreLedger,
};
