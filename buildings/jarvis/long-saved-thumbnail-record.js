'use strict';

const longScoreLedger = require('./long-score-ledger');
const shortsScoreLedger = require('./shorts-score-ledger');
const {
    canonicalArtifactIdentity,
} = require('./canonical-json-artifact');

const RECORD_SCHEMA = 'long-saved-thumbnail-v3';
const INDEX_SCHEMA = 'long-saved-thumbnail-index-v2';
const MIGRATION_POINTER_SCHEMA =
    'long-saved-thumbnail-index-pointer-v1';
const SCORE_SCHEMA = 'long-saved-thumbnail-score-v1';
const DECISION_TRACE_SCHEMA =
    'long-saved-thumbnail-decision-trace-v1';
const GEOMETRY_SCHEMA =
    'long-saved-thumbnail-geometry-v1';
const MEDIA_SCHEMA =
    'long-saved-thumbnail-media-v1';
const MEDIA_REF_SCHEMA =
    'long-saved-thumbnail-media-ref-v1';
const SCORE_AUTHORITY = 'long_score_ledger';
const DECISION_TRACE_AUTHORITY =
    'non_authoritative_decision_trace';
const GEOMETRY_AUTHORITY =
    'non_authoritative_visualization_only';
const MEDIA_PREFIX =
    'longform/saved-thumbs/media/by-sha256';
const MEDIA_ROUTE_PREFIX =
    '/api/longquant/thumbs/media';
const VISUAL_THRESHOLD_COORDINATE =
    longScoreLedger.VISUAL_THRESHOLD_COORDINATE;
const SCORE_REQUIRED_FIELDS = Object.freeze([
    'schema',
    'scalar_score_authority',
    'long_score_ledger',
    'output_contract',
    'input_manifest',
]);
const SCORE_OPTIONAL_FIELDS = Object.freeze([
    'decision_trace',
    'non_authoritative_geometry',
]);
const GEOMETRY_CHANNEL_FIELDS = Object.freeze([
    'neighbors',
    'map_placements',
    'embedding_preview',
]);
const MAP_PROJECTIONS = Object.freeze({
    ctrviews: 'ctrviews',
    ctr: 'ctr',
    ret30: 'ret30',
    views: 'views',
    scaled_views: 'outlier',
    realviews: 'realviews',
    gt10m: 'hi10m',
});

const REDUNDANT_RECORD_FIELDS = Object.freeze([
    'pct',
    'pctile',
    'pct100',
    'visual_pctile',
    'text_pctile',
    'thumbnail_potential',
    'reward',
    'training_reward',
    'idea_model_reward',
    'thumbnail_model_reward',
    'reward_trace',
    'relevance',
    'nn_cos',
    'metrics',
    'channels',
    'emb_preview',
    'input_manifest',
    'long_score_ledger',
    'output_contract',
    'score_alias_contract',
    'decision_trace',
    'non_authoritative_geometry',
]);

const REDUNDANT_NESTED_EVIDENCE_FIELDS = new Set([
    ...REDUNDANT_RECORD_FIELDS,
    'score',
    'percentile',
    'score_percentile',
    'values_by_id',
    'percentiles_by_id',
    'ledger_sha256',
    'best',
    'winner',
]);
const FORBIDDEN_INPUT_MANIFEST_SCORE_FIELDS = new Set([
    'pct',
    'pctile',
    'pct100',
    'percentile',
    'score_percentile',
    'visual_pctile',
    'text_pctile',
    'thumbnail_potential',
    'reward',
    'training_reward',
    'idea_model_reward',
    'thumbnail_model_reward',
    'reward_trace',
    'relevance',
    'nn_cos',
    'values_by_id',
    'percentiles_by_id',
    'long_score_ledger',
    'score_alias_contract',
]);
const INDEX_ROW_KEYS = Object.freeze([
    'id',
    'saved_at',
    'record_key',
    'record_content_sha256',
    'record_artifact_sha256',
    'record_byte_length',
    'score_record_sha256',
    'ledger_sha256',
    'media_key',
    'thumbnail_sha256',
    'index_row_sha256',
]);
const LEGACY_INDEX_ROW_KEYS = Object.freeze([
    'id',
    'state',
    'savedAt',
    'title',
    'prompt',
    'sourceVideo',
    'quarantine_key',
    'quarantine_sha256',
    'errors',
]);
const INDEX_REQUIRED_KEYS = Object.freeze([
    'schema',
    'rows',
    'legacy_unbound',
    'index_sha256',
]);
const INDEX_OPTIONAL_KEYS = Object.freeze([
    'updated_at',
    'migration_release',
]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    const allowed = new Set(required.concat(optional));
    return required.every(key => (
        Object.prototype.hasOwnProperty.call(value, key)
    )) && keys.every(key => allowed.has(key));
}

function finiteNumber(value) {
    return (
        value !== null
        && value !== undefined
        && value !== ''
        && typeof value !== 'boolean'
        && Number.isFinite(Number(value))
    );
}

function nullableFiniteNumber(value) {
    return value == null || finiteNumber(value);
}

function exactSha256(value) {
    return typeof value === 'string'
        && /^[a-f0-9]{64}$/.test(value);
}

function collectRedundantEvidencePaths(
    value,
    prefix,
    paths,
    seen
) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        const path = `${prefix}.${key}`;
        if (REDUNDANT_NESTED_EVIDENCE_FIELDS.has(key)) {
            paths.push(path);
        }
        collectRedundantEvidencePaths(
            child,
            path,
            paths,
            seen
        );
    }
}

function redundantNumericalEvidencePaths(record) {
    if (!record || typeof record !== 'object') return [];
    const paths = [];
    for (const [root, value] of Object.entries(record)) {
        if (root === 'score' || root === 'media') continue;
        collectRedundantEvidencePaths(
            value,
            root,
            paths,
            new Set()
        );
    }
    return [...new Set(paths)].sort();
}

function inputManifestScoreEvidencePaths(manifest) {
    const paths = [];
    const walk = (value, prefix, seen) => {
        if (!value || typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (
                FORBIDDEN_INPUT_MANIFEST_SCORE_FIELDS.has(key)
            ) {
                paths.push(path);
            }
            walk(child, path, seen);
        }
    };
    walk(manifest, 'input_manifest', new Set());
    return [...new Set(paths)].sort();
}

function canonicalDecisionTrace(score) {
    const supplied = score && score.decision_trace;
    if (supplied != null) {
        if (
            score.reward_trace != null
            || score.relevance != null
            || score.nn_cos != null
        ) {
            throw new Error(
                'Long saved-thumbnail decision trace has duplicate sources'
            );
        }
        const validation = validateDecisionTrace(supplied);
        if (!validation.valid) {
            throw new Error(validation.errors.join('; '));
        }
        return clone(supplied);
    }
    const legacyCoordinate = score
        && score.score_alias_contract
        && score.score_alias_contract
            .canonical_coordinate_id;
    if (
        legacyCoordinate
        && legacyCoordinate !== VISUAL_THRESHOLD_COORDINATE
    ) {
        return null;
    }
    const legacy = score && score.reward_trace;
    for (const [field, value] of [
        ['relevance', score && score.relevance],
        ['nn_cos', score && score.nn_cos],
        ['reward_trace.relevance', legacy && legacy.relevance],
        ['reward_trace.density', legacy && legacy.density],
        [
            'reward_trace.relevance_floor',
            legacy && legacy.relevance_floor,
        ],
        [
            'reward_trace.density_floor',
            legacy && legacy.density_floor,
        ],
    ]) {
        if (value != null && !finiteNumber(value)) {
            throw new Error(
                `Long saved-thumbnail decision trace ${field} is invalid`
            );
        }
    }
    if (
        legacy
        && score.relevance != null
        && legacy.relevance != null
        && Math.abs(
            Number(score.relevance)
            - Number(legacy.relevance)
        ) > 1e-9
    ) {
        throw new Error(
            'Long saved-thumbnail decision trace relevance sources differ'
        );
    }
    if (
        legacy
        && score.nn_cos != null
        && legacy.density != null
        && Math.abs(
            Number(score.nn_cos)
            - Number(legacy.density)
        ) > 1e-9
    ) {
        throw new Error(
            'Long saved-thumbnail decision trace density sources differ'
        );
    }
    const hasLegacyInputs = !!(
        legacy
        || score && score.relevance != null
        || score && score.nn_cos != null
    );
    if (!hasLegacyInputs) return null;
    if (
        legacy
        && (
            !isPlainObject(legacy)
            || (
                legacy.threshold_channel != null
                && legacy.threshold_channel !== 'visual'
            )
            || (
                legacy.together_used_for_threshold != null
                && legacy.together_used_for_threshold !== false
            )
        )
    ) {
        throw new Error(
            'Long saved-thumbnail decision trace policy differs'
        );
    }
    const trace = {
        schema: DECISION_TRACE_SCHEMA,
        authority: DECISION_TRACE_AUTHORITY,
        threshold_coordinate_id:
            VISUAL_THRESHOLD_COORDINATE,
        packaging_used_for_threshold: false,
        observations: {
            topical_relevance_cosine:
                legacy && legacy.relevance != null
                    ? Number(legacy.relevance)
                    : score && score.relevance != null
                        ? Number(score.relevance)
                        : null,
            visual_manifold_density_cosine:
                legacy && legacy.density != null
                    ? Number(legacy.density)
                    : score && score.nn_cos != null
                        ? Number(score.nn_cos)
                        : null,
        },
        policy_thresholds: {
            topical_relevance_floor:
                legacy && legacy.relevance_floor != null
                    ? Number(legacy.relevance_floor)
                    : null,
            visual_manifold_density_floor:
                legacy && legacy.density_floor != null
                    ? Number(legacy.density_floor)
                    : null,
        },
    };
    const validation = validateDecisionTrace(trace);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return trace;
}

function validateDecisionTrace(trace) {
    const errors = [];
    if (
        !exactKeys(
            trace,
            [
                'schema',
                'authority',
                'threshold_coordinate_id',
                'packaging_used_for_threshold',
                'observations',
                'policy_thresholds',
            ]
        )
        || trace.schema !== DECISION_TRACE_SCHEMA
        || trace.authority !== DECISION_TRACE_AUTHORITY
        || trace.threshold_coordinate_id
            !== VISUAL_THRESHOLD_COORDINATE
        || trace.packaging_used_for_threshold !== false
    ) {
        errors.push(
            'Long saved-thumbnail decision trace identity differs'
        );
        return { valid: false, errors };
    }
    if (
        !exactKeys(
            trace.observations,
            [
                'topical_relevance_cosine',
                'visual_manifold_density_cosine',
            ]
        )
        || !exactKeys(
            trace.policy_thresholds,
            [
                'topical_relevance_floor',
                'visual_manifold_density_floor',
            ]
        )
    ) {
        errors.push(
            'Long saved-thumbnail decision trace fields differ'
        );
        return { valid: false, errors };
    }
    const relevance =
        trace.observations.topical_relevance_cosine;
    const density =
        trace.observations.visual_manifold_density_cosine;
    const relevanceFloor =
        trace.policy_thresholds.topical_relevance_floor;
    const densityFloor =
        trace.policy_thresholds.visual_manifold_density_floor;
    if (
        !nullableFiniteNumber(relevance)
        || !nullableFiniteNumber(density)
        || !nullableFiniteNumber(relevanceFloor)
        || !nullableFiniteNumber(densityFloor)
        || (
            relevance != null
            && (Number(relevance) < -1 || Number(relevance) > 1)
        )
        || (
            density != null
            && (Number(density) < -1 || Number(density) > 1)
        )
        || (
            relevanceFloor != null
            && (
                Number(relevanceFloor) < -1
                || Number(relevanceFloor) > 1
            )
        )
        || (
            densityFloor != null
            && (
                Number(densityFloor) < -1
                || Number(densityFloor) > 1
            )
        )
    ) {
        errors.push(
            'Long saved-thumbnail decision trace contains invalid diagnostics'
        );
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}

function canonicalMapPlacement(
    placement,
    channel,
    metric
) {
    if (!isPlainObject(placement)) return null;
    const projection = MAP_PROJECTIONS[metric];
    const axisX = placement.axis_x;
    const axisY = placement.axis_y;
    const coordinate = String(
        placement.provenance
        && placement.provenance.coordinate
        || ''
    );
    const expectedCoordinate =
        longScoreLedger.longMapPlacementCoordinate(
            channel,
            projection
        );
    if (
        !projection
        || !finiteNumber(axisX)
        || (
            axisY != null
            && !finiteNumber(axisY)
        )
        || coordinate !== expectedCoordinate
    ) {
        return null;
    }
    return {
        axis_x: Number(axisX),
        ...(axisY == null
            ? {}
            : { axis_y: Number(axisY) }),
        projection,
        provenance: {
            coordinate: expectedCoordinate,
        },
    };
}

function canonicalGeometry(score) {
    const supplied =
        score && score.non_authoritative_geometry;
    if (supplied != null) {
        if (
            score.channels != null
            || score.emb_preview != null
        ) {
            throw new Error(
                'Long saved-thumbnail geometry has duplicate sources'
            );
        }
        const validation = validateGeometry(supplied);
        if (!validation.valid) {
            throw new Error(validation.errors.join('; '));
        }
        return clone(supplied);
    }
    const sourceChannels = isPlainObject(score && score.channels)
        ? score.channels
        : {};
    const sourcePreview = isPlainObject(score && score.emb_preview)
        ? score.emb_preview
        : {};
    const channels = {};
    for (const channel of longScoreLedger.OUTPUT_CHANNELS) {
        const source = isPlainObject(sourceChannels[channel])
            ? sourceChannels[channel]
            : {};
        const canonical = {};
        if (Array.isArray(source.neighbors)) {
            if (
                source.neighbors.some(row => (
                    !isPlainObject(row)
                    || !String(row.id || '').length
                    || !finiteNumber(row.sim)
                    || Number(row.sim) < -1
                    || Number(row.sim) > 1
                ))
            ) {
                throw new Error(
                    `Long saved-thumbnail ${channel} neighbors differ`
                );
            }
            const neighbors = source.neighbors
                .slice(0, 24)
                .map(row => ({
                    id: String(row.id),
                    sim: Number(row.sim),
                }));
            if (neighbors.length) canonical.neighbors = neighbors;
        }
        if (isPlainObject(source.map_placements)) {
            const placements = {};
            for (const metric of longScoreLedger.OUTPUT_METRICS) {
                const sourcePlacement =
                    source.map_placements[metric];
                const placement = canonicalMapPlacement(
                    sourcePlacement,
                    channel,
                    metric
                );
                if (sourcePlacement != null && !placement) {
                    throw new Error(
                        `Long saved-thumbnail ${channel}.${metric} map placement differs`
                    );
                }
                if (placement) placements[metric] = placement;
            }
            if (Object.keys(placements).length) {
                canonical.map_placements = placements;
            }
        }
        if (
            sourcePreview[channel] != null
            && (
                !Array.isArray(sourcePreview[channel])
                || !sourcePreview[channel].length
                || sourcePreview[channel].length > 1536
                || !sourcePreview[channel].every(finiteNumber)
            )
        ) {
            throw new Error(
                `Long saved-thumbnail ${channel} embedding preview differs`
            );
        }
        if (
            Array.isArray(sourcePreview[channel])
            && sourcePreview[channel].length > 0
        ) {
            canonical.embedding_preview =
                sourcePreview[channel].map(Number);
        }
        if (Object.keys(canonical).length) {
            channels[channel] = canonical;
        }
    }
    if (!Object.keys(channels).length) return null;
    const geometry = {
        schema: GEOMETRY_SCHEMA,
        authority: GEOMETRY_AUTHORITY,
        scalar_score_use: 'forbidden',
        channels,
    };
    const validation = validateGeometry(geometry);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return geometry;
}

function validateGeometry(geometry) {
    const errors = [];
    if (
        !exactKeys(
            geometry,
            [
                'schema',
                'authority',
                'scalar_score_use',
                'channels',
            ]
        )
        || geometry.schema !== GEOMETRY_SCHEMA
        || geometry.authority !== GEOMETRY_AUTHORITY
        || geometry.scalar_score_use !== 'forbidden'
        || !isPlainObject(geometry.channels)
        || !Object.keys(geometry.channels).length
    ) {
        errors.push(
            'Long saved-thumbnail non-authoritative geometry identity differs'
        );
        return { valid: false, errors };
    }
    for (const [channel, value] of Object.entries(
        geometry.channels
    )) {
        if (
            !longScoreLedger.OUTPUT_CHANNELS.includes(channel)
            || !isPlainObject(value)
            || !Object.keys(value).length
            || !Object.keys(value).every(key => (
                GEOMETRY_CHANNEL_FIELDS.includes(key)
            ))
        ) {
            errors.push(
                `Long saved-thumbnail ${channel} geometry fields differ`
            );
            continue;
        }
        if (
            value.neighbors != null
            && (
                !Array.isArray(value.neighbors)
                || !value.neighbors.length
                || value.neighbors.length > 24
                || value.neighbors.some(row => (
                    !exactKeys(row, ['id', 'sim'])
                    || !String(row.id || '')
                    || !finiteNumber(row.sim)
                    || Number(row.sim) < -1
                    || Number(row.sim) > 1
                ))
            )
        ) {
            errors.push(
                `Long saved-thumbnail ${channel} neighbors differ`
            );
        }
        if (
            value.embedding_preview != null
            && (
                !Array.isArray(value.embedding_preview)
                || !value.embedding_preview.length
                || value.embedding_preview.length > 1536
                || !value.embedding_preview.every(finiteNumber)
            )
        ) {
            errors.push(
                `Long saved-thumbnail ${channel} embedding preview differs`
            );
        }
        if (value.map_placements != null) {
            if (!isPlainObject(value.map_placements)) {
                errors.push(
                    `Long saved-thumbnail ${channel} map placements differ`
                );
            } else {
                for (const [metric, placement] of Object.entries(
                    value.map_placements
                )) {
                    const required = [
                        'axis_x',
                        'projection',
                        'provenance',
                    ];
                    if (
                        !longScoreLedger.OUTPUT_METRICS.includes(metric)
                        || !exactKeys(
                            placement,
                            required,
                            ['axis_y']
                        )
                        || !finiteNumber(placement.axis_x)
                        || (
                            placement.axis_y != null
                            && !finiteNumber(placement.axis_y)
                        )
                        || placement.projection
                            !== MAP_PROJECTIONS[metric]
                        || !exactKeys(
                            placement.provenance,
                            ['coordinate']
                        )
                        || placement.provenance.coordinate
                            !== (
                                longScoreLedger
                                    .longMapPlacementCoordinate(
                                        channel,
                                        MAP_PROJECTIONS[metric]
                                    )
                            )
                    ) {
                        errors.push(
                            `Long saved-thumbnail ${channel}.${metric} map placement differs`
                        );
                    }
                }
            }
        }
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function canonicalScore(score) {
    if (!isPlainObject(score)) {
        throw new Error(
            'saved Long thumbnail canonical score is missing'
        );
    }
    const ledgerValidation =
        longScoreLedger.validateLongScoreLedger(
            score.long_score_ledger
        );
    const outputValidation =
        longScoreLedger.validateLongOutputContract(score);
    const inputValidation =
        longScoreLedger.validateLongInputManifest(score);
    const errors = [
        ...ledgerValidation.errors,
        ...outputValidation.errors,
        ...inputValidation.errors,
    ];
    if (errors.length) {
        throw new Error([...new Set(errors)].join('; '));
    }
    const manifestEvidence =
        inputManifestScoreEvidencePaths(score.input_manifest);
    if (manifestEvidence.length) {
        throw new Error(
            'Long score input manifest duplicates scalar score evidence at '
            + manifestEvidence.join(', ')
        );
    }
    const canonical = {
        schema: SCORE_SCHEMA,
        scalar_score_authority: SCORE_AUTHORITY,
        long_score_ledger: clone(score.long_score_ledger),
        output_contract:
            longScoreLedger.longOutputContract(
                score.long_score_ledger
            ),
        input_manifest: clone(score.input_manifest),
    };
    const decisionTrace = canonicalDecisionTrace(score);
    if (decisionTrace) canonical.decision_trace = decisionTrace;
    const geometry = canonicalGeometry(score);
    if (geometry) {
        canonical.non_authoritative_geometry = geometry;
    }
    return canonical;
}

function validateScore(score) {
    const errors = [];
    if (
        !exactKeys(
            score,
            SCORE_REQUIRED_FIELDS,
            SCORE_OPTIONAL_FIELDS
        )
        || score.schema !== SCORE_SCHEMA
        || score.scalar_score_authority !== SCORE_AUTHORITY
    ) {
        errors.push(
            'saved Long thumbnail score envelope differs'
        );
        return {
            valid: false,
            errors,
            ledgerValidation:
                longScoreLedger.validateLongScoreLedger(
                    score && score.long_score_ledger
                ),
        };
    }
    const ledgerValidation =
        longScoreLedger.validateLongScoreLedger(
            score.long_score_ledger
        );
    const outputValidation =
        longScoreLedger.validateLongOutputContract(score);
    const inputValidation =
        longScoreLedger.validateLongInputManifest(score);
    errors.push(
        ...ledgerValidation.errors,
        ...outputValidation.errors,
        ...inputValidation.errors
    );
    const expectedOutputContract =
        longScoreLedger.longOutputContract(
            score.long_score_ledger
        );
    if (
        shortsScoreLedger.canonicalJson(
            score.output_contract
        ) !== shortsScoreLedger.canonicalJson(
            expectedOutputContract
        )
    ) {
        errors.push(
            'saved Long thumbnail output contract is not exact'
        );
    }
    const manifestEvidence =
        inputManifestScoreEvidencePaths(
            score.input_manifest
        );
    if (manifestEvidence.length) {
        errors.push(
            'Long score input manifest duplicates scalar score evidence at '
            + manifestEvidence.join(', ')
        );
    }
    if (score.decision_trace != null) {
        errors.push(
            ...validateDecisionTrace(
                score.decision_trace
            ).errors
        );
    }
    if (score.non_authoritative_geometry != null) {
        errors.push(
            ...validateGeometry(
                score.non_authoritative_geometry
            ).errors
        );
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        ledgerValidation,
        outputValidation,
        inputValidation,
    };
}

function canonicalMedia(media) {
    if (!isPlainObject(media)) {
        throw new Error(
            'saved Long thumbnail media identity differs'
        );
    }
    const thumbnailSha256 = String(
        media.thumbnail_sha256 || ''
    ).toLowerCase();
    const canonical = {
        schema: MEDIA_SCHEMA,
        kind: 'thumbnail-jpeg',
        key: `${MEDIA_PREFIX}/${thumbnailSha256}.jpg`,
        thumbnail_sha256: thumbnailSha256,
        byte_length: Number(media.byte_length),
        media_type: 'image/jpeg',
    };
    if (
        media.kind !== 'thumbnail-jpeg'
        || media.key !== canonical.key
        || !exactSha256(thumbnailSha256)
        || !Number.isInteger(canonical.byte_length)
        || canonical.byte_length <= 0
        || (
            media.media_type != null
            && media.media_type !== 'image/jpeg'
        )
        || (
            media.schema != null
            && media.schema !== MEDIA_SCHEMA
        )
    ) {
        throw new Error(
            'saved Long thumbnail media identity differs'
        );
    }
    return canonical;
}

function validateMedia(media) {
    const errors = [];
    if (
        !exactKeys(
            media,
            [
                'schema',
                'kind',
                'key',
                'thumbnail_sha256',
                'byte_length',
                'media_type',
            ]
        )
        || media.schema !== MEDIA_SCHEMA
        || media.kind !== 'thumbnail-jpeg'
        || !exactSha256(media.thumbnail_sha256)
        || media.key
            !== `${MEDIA_PREFIX}/${media.thumbnail_sha256}.jpg`
        || !Number.isInteger(media.byte_length)
        || media.byte_length <= 0
        || media.media_type !== 'image/jpeg'
    ) {
        errors.push(
            'saved Long thumbnail media identity differs'
        );
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}

function contentAddressedMediaRef(media) {
    const mediaValidation = validateMedia(media);
    if (!mediaValidation.valid) {
        throw new Error(mediaValidation.errors.join('; '));
    }
    return {
        schema: MEDIA_REF_SCHEMA,
        url:
            `${MEDIA_ROUTE_PREFIX}/${media.thumbnail_sha256}`,
        key: media.key,
        thumbnail_sha256: media.thumbnail_sha256,
        byte_length: media.byte_length,
        media_type: media.media_type,
        immutable: true,
    };
}

function validateMediaRef(mediaRef, expectedMedia) {
    const errors = [];
    if (
        !exactKeys(
            mediaRef,
            [
                'schema',
                'url',
                'key',
                'thumbnail_sha256',
                'byte_length',
                'media_type',
                'immutable',
            ]
        )
        || mediaRef.schema !== MEDIA_REF_SCHEMA
        || !exactSha256(mediaRef.thumbnail_sha256)
        || mediaRef.url
            !== (
                `${MEDIA_ROUTE_PREFIX}/`
                + mediaRef.thumbnail_sha256
            )
        || mediaRef.key
            !== (
                `${MEDIA_PREFIX}/`
                + `${mediaRef.thumbnail_sha256}.jpg`
            )
        || !Number.isInteger(mediaRef.byte_length)
        || mediaRef.byte_length <= 0
        || mediaRef.media_type !== 'image/jpeg'
        || mediaRef.immutable !== true
    ) {
        errors.push(
            'saved Long thumbnail media_ref identity differs'
        );
    }
    if (
        expectedMedia
        && (
            !validateMedia(expectedMedia).valid
            || mediaRef.key !== expectedMedia.key
            || mediaRef.thumbnail_sha256
                !== expectedMedia.thumbnail_sha256
            || mediaRef.byte_length
                !== expectedMedia.byte_length
            || mediaRef.media_type
                !== expectedMedia.media_type
        )
    ) {
        errors.push(
            'saved Long thumbnail media_ref points to different bytes'
        );
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function recordContentSha256(record) {
    const payload = clone(record);
    delete payload.record_content_sha256;
    return shortsScoreLedger.sha256Canonical(payload);
}

function recordArtifactIdentity(record) {
    return canonicalArtifactIdentity(record);
}

function scorePercentile(score) {
    const cell = longScoreLedger.longLedgerCell(
        score,
        'visual',
        'ctrviews'
    );
    if (!cell.valid || !cell.entry || cell.percentile == null) {
        return null;
    }
    const percentile = Number(cell.percentile);
    return Number.isFinite(percentile)
        && percentile >= 0
        && percentile <= 100
        ? percentile
        : null;
}

function bindRecord(record) {
    const redundantPaths =
        redundantNumericalEvidencePaths(record);
    if (redundantPaths.length) {
        throw new Error(
            `saved Long thumbnail duplicates numerical evidence at ${
                redundantPaths.join(', ')
            }`
        );
    }
    const bound = clone(record);
    bound.schema = RECORD_SCHEMA;
    bound.score_domain = 'longquant';
    for (const field of REDUNDANT_RECORD_FIELDS) {
        delete bound[field];
    }
    bound.score = canonicalScore(record && record.score);
    bound.media = canonicalMedia(record && record.media);
    bound.score_record_sha256 =
        shortsScoreLedger.scoreRecordBindingSha256(bound);
    bound.record_content_sha256 = recordContentSha256(bound);
    const validation = validateRecord(bound);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return bound;
}

function validateRecord(record) {
    const errors = [];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return {
            valid: false,
            errors: ['saved Long thumbnail record is missing'],
        };
    }
    if (
        record.schema !== RECORD_SCHEMA
        || record.score_domain !== 'longquant'
    ) {
        errors.push('saved Long thumbnail record schema differs');
    }
    if (!record.id || !record.title || !record.score) {
        errors.push('saved Long thumbnail record identity is incomplete');
    }
    for (const field of REDUNDANT_RECORD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(record, field)) {
            errors.push(`saved Long thumbnail duplicates ${field}`);
        }
    }
    for (const path of redundantNumericalEvidencePaths(record)) {
        errors.push(
            `saved Long thumbnail duplicates numerical evidence at ${path}`
        );
    }
    const score = record.score;
    const scoreValidation = validateScore(score);
    const ledgerValidation =
        scoreValidation.ledgerValidation;
    errors.push(...scoreValidation.errors);
    const media = record.media;
    errors.push(...validateMedia(media).errors);
    const inputValidation =
        longScoreLedger.validateLongInputManifest(
            score,
            {
                thumbnailSha256:
                    media && media.thumbnail_sha256,
                title: record.title,
            }
        );
    errors.push(...inputValidation.errors);
    if (
        record.score_record_sha256
            !== shortsScoreLedger.scoreRecordBindingSha256(record)
    ) {
        errors.push('saved Long thumbnail score binding differs');
    }
    if (
        record.record_content_sha256 !== recordContentSha256(record)
    ) {
        errors.push('saved Long thumbnail record content hash differs');
    }
    if (scorePercentile(score) == null) {
        errors.push(
            'saved Long thumbnail has no canonical visual CTR+views percentile'
        );
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        scorePercentile: scorePercentile(score),
        ledgerSha256:
            ledgerValidation && ledgerValidation.valid
                ? score.long_score_ledger.ledger_sha256
                : null,
        inputValidation,
        scoreValidation,
    };
}

function indexRowPayload(row) {
    return {
        id: row && row.id || null,
        saved_at: row && row.saved_at || null,
        record_key: row && row.record_key || null,
        record_content_sha256:
            row && row.record_content_sha256 || null,
        record_artifact_sha256:
            row && row.record_artifact_sha256 || null,
        record_byte_length:
            row && row.record_byte_length != null
                ? row.record_byte_length
                : null,
        score_record_sha256:
            row && row.score_record_sha256 || null,
        ledger_sha256: row && row.ledger_sha256 || null,
        media_key: row && row.media_key || null,
        thumbnail_sha256: row && row.thumbnail_sha256 || null,
    };
}

function compactIndexRow(record) {
    const validation = validateRecord(record);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    const artifact = recordArtifactIdentity(record);
    const row = {
        id: record.id,
        saved_at: record.savedAt,
        record_key:
            `longform/saved-thumbs/${record.id}.json`,
        record_content_sha256: record.record_content_sha256,
        record_artifact_sha256: artifact.sha256,
        record_byte_length: artifact.byte_length,
        score_record_sha256: record.score_record_sha256,
        ledger_sha256: validation.ledgerSha256,
        media_key: record.media.key,
        thumbnail_sha256: record.media.thumbnail_sha256,
    };
    row.index_row_sha256 =
        shortsScoreLedger.sha256Canonical(indexRowPayload(row));
    return row;
}

function validateIndexRow(row) {
    const errors = [];
    const id = row && String(row.id || '');
    if (
        !exactKeys(row, INDEX_ROW_KEYS)
        || !/^lt[a-z0-9]+$/i.test(id)
        || row.record_key
            !== `longform/saved-thumbs/${id}.json`
        || !/^[a-f0-9]{64}$/.test(
            String(row.record_content_sha256 || '')
        )
        || !/^[a-f0-9]{64}$/.test(
            String(row.score_record_sha256 || '')
        )
        || !/^[a-f0-9]{64}$/.test(
            String(row.record_artifact_sha256 || '')
        )
        || !Number.isSafeInteger(row.record_byte_length)
        || row.record_byte_length <= 0
        || !/^[a-f0-9]{64}$/.test(
            String(row.ledger_sha256 || '')
        )
        || !/^[a-f0-9]{64}$/.test(
            String(row.thumbnail_sha256 || '')
        )
        || row.media_key
            !== `longform/saved-thumbs/media/by-sha256/${row.thumbnail_sha256}.jpg`
    ) {
        errors.push('saved Long thumbnail index identity differs');
    }
    if (
        row
        && row.index_row_sha256
            !== shortsScoreLedger.sha256Canonical(
                indexRowPayload(row)
            )
    ) {
        errors.push('saved Long thumbnail index row hash differs');
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}

function validateIndexRecordPair(row, record) {
    const rowValidation = validateIndexRow(row);
    const recordValidation = validateRecord(record);
    const errors = [
        ...rowValidation.errors,
        ...recordValidation.errors,
    ];
    const recordArtifact = recordValidation.valid
        ? recordArtifactIdentity(record)
        : null;
    if (
        rowValidation.valid
        && recordValidation.valid
        && (
            row.id !== record.id
            || row.record_content_sha256
                !== record.record_content_sha256
            || row.score_record_sha256
                !== record.score_record_sha256
            || row.record_artifact_sha256
                !== recordArtifact.sha256
            || row.record_byte_length
                !== recordArtifact.byte_length
            || row.ledger_sha256
                !== recordValidation.ledgerSha256
            || row.media_key !== record.media.key
            || row.thumbnail_sha256
                !== record.media.thumbnail_sha256
        )
    ) {
        errors.push('saved Long thumbnail index points to different evidence');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        recordValidation,
    };
}

function indexBindingPayload(index) {
    return {
        schema: INDEX_SCHEMA,
        updated_at:
            index && index.updated_at != null
                ? index.updated_at
                : null,
        rows: Array.isArray(index && index.rows)
            ? index.rows
            : [],
        legacy_unbound:
            Array.isArray(index && index.legacy_unbound)
                ? index.legacy_unbound
                : [],
    };
}

function indexPayloadSha256(index) {
    return shortsScoreLedger.sha256Canonical(
        indexBindingPayload(index)
    );
}

function validateMigrationReleasePointer(index) {
    const pointer = index && index.migration_release;
    if (pointer == null) {
        return {
            valid: true,
            present: false,
            stale: false,
            errors: [],
            expected_index_payload_sha256:
                indexPayloadSha256(index),
        };
    }
    const errors = [];
    const expected = indexPayloadSha256(index);
    if (
        !pointer
        || typeof pointer !== 'object'
        || Array.isArray(pointer)
        || pointer.schema !== MIGRATION_POINTER_SCHEMA
        || typeof pointer.key !== 'string'
        || pointer.key.length === 0
        || !/^[a-f0-9]{64}$/.test(
            String(pointer.artifact_sha256 || '')
        )
        || !String(pointer.key || '').endsWith(
            `/by-sha256/${pointer.artifact_sha256}.json`
        )
        || !Number.isInteger(pointer.byte_length)
        || pointer.byte_length <= 0
        || !/^[a-f0-9]{64}$/.test(
            String(pointer.release_sha256 || '')
        )
        || !/^[a-f0-9]{64}$/.test(
            String(pointer.index_payload_sha256 || '')
        )
    ) {
        errors.push(
            'saved Long thumbnail migration pointer identity differs'
        );
    }
    const stale = (
        pointer
        && pointer.index_payload_sha256 !== expected
    );
    if (stale) {
        errors.push(
            'saved Long thumbnail migration pointer describes a different index payload'
        );
    }
    return {
        valid: errors.length === 0,
        present: true,
        stale,
        errors,
        expected_index_payload_sha256: expected,
        recorded_index_payload_sha256:
            pointer
            && /^[a-f0-9]{64}$/.test(
                String(pointer.index_payload_sha256 || '')
            )
                ? pointer.index_payload_sha256
                : null,
    };
}

function retireStaleMigrationRelease(index) {
    const next = clone(index || {});
    const pointer = next.migration_release;
    const expected = indexPayloadSha256(next);
    if (
        !pointer
        || pointer.index_payload_sha256 === expected
    ) {
        return {
            index: next,
            retired: false,
            expected_index_payload_sha256: expected,
            retired_pointer: null,
        };
    }
    delete next.migration_release;
    return {
        index: next,
        retired: true,
        expected_index_payload_sha256: expected,
        retired_pointer: pointer,
    };
}

function bindIndex(index) {
    const source = clone(index || {});
    let bound = {
        schema: INDEX_SCHEMA,
        rows: Array.isArray(source.rows)
            ? source.rows.slice().sort((left, right) => (
            String(left && left.id || '')
                .localeCompare(String(right && right.id || ''))
            ))
            : [],
        legacy_unbound:
            Array.isArray(source.legacy_unbound)
                ? source.legacy_unbound.slice().sort((left, right) => (
                String(left && left.id || '')
                    .localeCompare(String(right && right.id || ''))
                ))
                : [],
    };
    if (source.updated_at != null) {
        bound.updated_at = source.updated_at;
    }
    if (source.migration_release != null) {
        bound.migration_release = source.migration_release;
    }
    const retirement = retireStaleMigrationRelease(bound);
    bound = retirement.index;
    const pointerValidation =
        validateMigrationReleasePointer(bound);
    if (!pointerValidation.valid) {
        throw new Error(pointerValidation.errors.join('; '));
    }
    bound.index_sha256 = indexPayloadSha256(bound);
    return bound;
}

function validateIndex(index) {
    const errors = [];
    if (
        !index
        || !exactKeys(
            index,
            INDEX_REQUIRED_KEYS,
            INDEX_OPTIONAL_KEYS
        )
        || index.schema !== INDEX_SCHEMA
        || !Array.isArray(index.rows)
        || !Array.isArray(index.legacy_unbound)
    ) {
        return {
            valid: false,
            errors: ['saved Long thumbnail index schema differs'],
        };
    }
    const canonicalIds = index.rows.map(row => String(row && row.id || ''));
    const legacyIds = index.legacy_unbound.map(
        row => String(row && row.id || '')
    );
    if (
        canonicalIds.some((id, at) => (
            !id || canonicalIds.indexOf(id) !== at
        ))
    ) {
        errors.push(
            'saved Long thumbnail index has duplicate canonical ids'
        );
    }
    if (
        legacyIds.some((id, at) => (
            !id || legacyIds.indexOf(id) !== at
        ))
    ) {
        errors.push(
            'saved Long thumbnail index has duplicate legacy ids'
        );
    }
    const canonicalIdSet = new Set(canonicalIds);
    if (legacyIds.some(id => canonicalIdSet.has(id))) {
        errors.push(
            'saved Long thumbnail index repeats an id as canonical and legacy'
        );
    }
    for (const row of index.rows) {
        errors.push(...validateIndexRow(row).errors);
    }
    for (const row of index.legacy_unbound) {
        if (
            !row
            || !exactKeys(row, LEGACY_INDEX_ROW_KEYS)
            || !row.id
            || (
                row.state != null
                && row.state !== 'legacy_unbound_evidence'
            )
        ) {
            errors.push(
                'saved Long thumbnail legacy row classification differs'
            );
        }
        if (
            !exactSha256(row.quarantine_sha256)
            || !String(row.quarantine_key || '').endsWith(
                `/by-sha256/${row.quarantine_sha256}.json`
            )
            || !Array.isArray(row.errors)
        ) {
            errors.push(
                'saved Long thumbnail legacy row quarantine binding differs'
            );
        }
    }
    if (
        index.updated_at != null
        && (
            !Number.isSafeInteger(index.updated_at)
            || index.updated_at < 0
        )
    ) {
        errors.push('saved Long thumbnail index updated_at differs');
    }
    errors.push(
        ...validateMigrationReleasePointer(index).errors
    );
    const expected = indexPayloadSha256(index);
    if (
        !/^[a-f0-9]{64}$/.test(
            String(index.index_sha256 || '')
        )
        || index.index_sha256 !== expected
    ) {
        errors.push(
            'saved Long thumbnail index content hash differs'
        );
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        calculated_sha256: expected,
        recorded_sha256:
            /^[a-f0-9]{64}$/.test(
                String(index.index_sha256 || '')
            )
                ? index.index_sha256
                : null,
    };
}

function displayRecord(record) {
    const validation = validateRecord(record);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    const display = clone(record);
    delete display.media;
    display.media_ref = contentAddressedMediaRef(
        record.media
    );
    display.integrity = {
        valid: true,
        record_content_sha256:
            record.record_content_sha256,
        score_record_sha256:
            record.score_record_sha256,
        ledger_sha256: validation.ledgerSha256,
        thumbnail_sha256:
            record.media.thumbnail_sha256,
    };
    return display;
}

module.exports = {
    DECISION_TRACE_AUTHORITY,
    DECISION_TRACE_SCHEMA,
    GEOMETRY_AUTHORITY,
    GEOMETRY_SCHEMA,
    INDEX_SCHEMA,
    INDEX_ROW_KEYS,
    LEGACY_INDEX_ROW_KEYS,
    MEDIA_REF_SCHEMA,
    MEDIA_ROUTE_PREFIX,
    MEDIA_SCHEMA,
    MIGRATION_POINTER_SCHEMA,
    RECORD_SCHEMA,
    SCORE_AUTHORITY,
    SCORE_SCHEMA,
    bindIndex,
    bindRecord,
    canonicalDecisionTrace,
    canonicalGeometry,
    canonicalScore,
    compactIndexRow,
    contentAddressedMediaRef,
    displayRecord,
    indexBindingPayload,
    indexPayloadSha256,
    recordContentSha256,
    recordArtifactIdentity,
    redundantNumericalEvidencePaths,
    retireStaleMigrationRelease,
    scorePercentile,
    validateIndex,
    validateIndexRecordPair,
    validateIndexRow,
    validateDecisionTrace,
    validateGeometry,
    validateMedia,
    validateMediaRef,
    validateMigrationReleasePointer,
    validateRecord,
    validateScore,
};
