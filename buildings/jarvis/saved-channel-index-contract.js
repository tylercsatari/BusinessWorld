'use strict';

const {
    canonicalArtifactIdentity,
    canonicalJsonBytes,
    sha256Bytes,
} = require('./canonical-json-artifact');
const {
    canonicalJson,
} = require('./shorts-score-ledger');

const INDEX_SCHEMA = 'saved-channel-navigation-index-v1';
const INDEX_VERSION = 1;
const INDEX_KEY = 'raw/saved-channels/index.json';
const MANIFEST_KEY_PATTERN =
    /^raw\/saved-channels\/(ch[a-f0-9]{16})\/manifest\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const SCORE_AUTHORITY = Object.freeze({
    artifactRole: 'non_authoritative_navigation',
    canonicalManifestPattern:
        'raw/saved-channels/{channel_id}/manifest.json',
    scoreAuthority: 'manifest-row score_ledger',
    scoreAuthorityPath: 'manifest.videos[].score_ledger',
    indexAuthoritative: false,
    scoreValuesPresent: false,
});

const INDEX_KEYS = Object.freeze([
    'schema',
    'version',
    'updatedAt',
    'authority',
    'channels',
    'payloadSha256',
]);
const AUTHORITY_KEYS = Object.freeze(Object.keys(SCORE_AUTHORITY));
const CHANNEL_KEYS = Object.freeze([
    'id',
    'manifestKey',
    'manifestSha256',
    'manifestBytes',
    'url',
    'name',
    'status',
    'phase',
    'createdAt',
    'updatedAt',
    'discovered',
    'completed',
    'failed',
    'integrityFailures',
    'queued',
    'current',
    'error',
]);
const CURRENT_KEYS = Object.freeze(['id', 'title', 'number']);

function stableJson(value) {
    return canonicalJson(value);
}

function canonicalBytes(value) {
    return canonicalJsonBytes(value);
}

function exactKeys(value, keys) {
    return !!value
        && !Array.isArray(value)
        && typeof value === 'object'
        && stableJson(Object.keys(value).sort())
            === stableJson(keys.slice().sort());
}

function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value) {
    return value === null || typeof value === 'string';
}

function normalizeNullableString(value, limit) {
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'string' ? value.slice(0, limit) : null;
}

function normalizeNonnegativeInteger(value, fallback = 0) {
    if (value === null || value === undefined || value === ''
        || typeof value === 'boolean') {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : fallback;
}

function manifestStatusCount(videos, statuses) {
    const accepted = new Set(statuses);
    return videos.filter(video => (
        video && accepted.has(video.status)
    )).length;
}

function canonicalManifestKey(channelId) {
    return `raw/saved-channels/${channelId}/manifest.json`;
}

function isCanonicalManifestKey(key) {
    return MANIFEST_KEY_PATTERN.test(String(key || ''));
}

function sanitizeCurrent(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
        return null;
    }
    const id = normalizeNullableString(value.id, 80);
    const title = normalizeNullableString(value.title, 200);
    const number = normalizeNonnegativeInteger(value.number, 0);
    if (!id && !title && !number) return null;
    return { id, title, number };
}

function channelEntryFromManifest(artifact) {
    if (!artifact || typeof artifact !== 'object') {
        throw new TypeError('Manifest artifact must be an object');
    }
    const manifest = artifact.manifest;
    const manifestKey = String(artifact.key || '');
    const match = MANIFEST_KEY_PATTERN.exec(manifestKey);
    if (!match) {
        throw new Error(
            `Non-canonical saved-channel manifest key: ${manifestKey}`
        );
    }
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
        throw new Error(`${manifestKey} is not a JSON object`);
    }
    const id = String(manifest.id || '');
    if (id !== match[1]) {
        throw new Error(
            `${manifestKey} ID ${id || '(missing)'} does not match its key`
        );
    }
    if (!Array.isArray(manifest.videos)) {
        throw new Error(`${manifestKey} does not contain a videos array`);
    }
    const bytes = Buffer.isBuffer(artifact.bytes)
        ? artifact.bytes
        : Buffer.from(artifact.bytes || '', 'utf8');
    if (!bytes.length) {
        throw new Error(`${manifestKey} has no immutable source bytes`);
    }
    const videos = manifest.videos;
    return {
        id,
        manifestKey,
        manifestSha256: sha256Bytes(bytes),
        manifestBytes: bytes.length,
        url: normalizeNullableString(manifest.url, 500),
        name: normalizeNullableString(manifest.name, 200),
        status: normalizeNullableString(manifest.status, 80),
        phase: normalizeNullableString(manifest.phase, 80),
        createdAt: normalizeNonnegativeInteger(manifest.createdAt),
        updatedAt: normalizeNonnegativeInteger(manifest.updatedAt),
        discovered: normalizeNonnegativeInteger(
            manifest.discovered,
            videos.length
        ),
        completed: normalizeNonnegativeInteger(
            manifest.completed,
            manifestStatusCount(videos, ['done'])
        ),
        failed: normalizeNonnegativeInteger(
            manifest.failed,
            manifestStatusCount(videos, ['error'])
        ),
        integrityFailures: normalizeNonnegativeInteger(
            manifest.integrityFailures
        ),
        queued: normalizeNonnegativeInteger(
            manifest.queued,
            manifestStatusCount(videos, ['queued', 'scoring'])
        ),
        current: sanitizeCurrent(manifest.current),
        error: normalizeNullableString(manifest.error, 500),
    };
}

function canonicalChannelOrder(left, right) {
    const leftUpdatedAt = nonnegativeInteger(left && left.updatedAt)
        ? left.updatedAt
        : 0;
    const rightUpdatedAt = nonnegativeInteger(right && right.updatedAt)
        ? right.updatedAt
        : 0;
    return rightUpdatedAt - leftUpdatedAt
        || String(left && left.id || '').localeCompare(
            String(right && right.id || '')
        );
}

function indexPayload(index) {
    return {
        schema: index.schema,
        version: index.version,
        updatedAt: index.updatedAt,
        authority: index.authority,
        channels: index.channels,
    };
}

function buildSavedChannelIndex(artifacts, options = {}) {
    const channels = (artifacts || []).map(channelEntryFromManifest)
        .sort(canonicalChannelOrder);
    return buildSavedChannelIndexFromEntries(channels, options);
}

function buildSavedChannelIndexFromEntries(entries, options = {}) {
    const channels = (entries || []).map(entry => ({ ...entry }))
        .sort(canonicalChannelOrder);
    const ids = channels.map(channel => channel.id);
    const duplicateIds = ids.filter(
        (id, index) => ids.indexOf(id) !== index
    );
    if (duplicateIds.length) {
        throw new Error(
            `Duplicate saved-channel IDs: ${[...new Set(duplicateIds)].join(', ')}`
        );
    }
    const deterministicUpdatedAt = channels.reduce(
        (maximum, channel) => Math.max(
            maximum,
            normalizeNonnegativeInteger(channel.updatedAt)
        ),
        0
    );
    const updatedAt = options.updatedAt === undefined
        ? deterministicUpdatedAt
        : normalizeNonnegativeInteger(options.updatedAt);
    const index = {
        schema: INDEX_SCHEMA,
        version: INDEX_VERSION,
        updatedAt,
        authority: { ...SCORE_AUTHORITY },
        channels,
        payloadSha256: null,
    };
    index.payloadSha256 = sha256Bytes(
        canonicalBytes(indexPayload(index))
    );
    const validation = validateSavedChannelIndex(index);
    if (!validation.valid) {
        throw new Error(
            `Built saved-channel index is invalid: ${validation.errors.join('; ')}`
        );
    }
    return index;
}

function replaceSavedChannelIndexEntry(index, artifact, options = {}) {
    const validation = index
        ? validateSavedChannelIndex(index)
        : { valid: true, errors: [] };
    if (!validation.valid) {
        throw new Error(
            `Cannot update invalid saved-channel index: ${validation.errors.join('; ')}`
        );
    }
    const entry = channelEntryFromManifest(artifact);
    const retained = (
        index && Array.isArray(index.channels) ? index.channels : []
    ).filter(channel => channel.id !== entry.id);
    return buildSavedChannelIndexFromEntries(
        [...retained, entry],
        options
    );
}

function removeSavedChannelIndexEntry(index, channelId, options = {}) {
    const validation = validateSavedChannelIndex(index);
    if (!validation.valid) {
        throw new Error(
            `Cannot update invalid saved-channel index: ${validation.errors.join('; ')}`
        );
    }
    return buildSavedChannelIndexFromEntries(
        index.channels.filter(channel => channel.id !== channelId),
        options
    );
}

function validateCurrent(value, prefix, errors) {
    if (value === null) return;
    if (!exactKeys(value, CURRENT_KEYS)) {
        errors.push(`${prefix} current has non-canonical fields`);
        return;
    }
    if (!nullableString(value.id)) errors.push(`${prefix} current.id is invalid`);
    if (!nullableString(value.title)) {
        errors.push(`${prefix} current.title is invalid`);
    }
    if (!nonnegativeInteger(value.number)) {
        errors.push(`${prefix} current.number is invalid`);
    }
}

function validateChannel(channel, index, errors) {
    const prefix = `channels[${index}]`;
    if (!exactKeys(channel, CHANNEL_KEYS)) {
        errors.push(`${prefix} has non-canonical fields`);
        return;
    }
    if (!/^ch[a-f0-9]{16}$/.test(channel.id)) {
        errors.push(`${prefix}.id is invalid`);
    }
    if (channel.manifestKey !== canonicalManifestKey(channel.id)) {
        errors.push(`${prefix}.manifestKey does not match the channel ID`);
    }
    if (!SHA256_PATTERN.test(channel.manifestSha256)) {
        errors.push(`${prefix}.manifestSha256 is invalid`);
    }
    if (!Number.isSafeInteger(channel.manifestBytes)
        || channel.manifestBytes <= 0) {
        errors.push(`${prefix}.manifestBytes is invalid`);
    }
    for (const field of ['url', 'name', 'status', 'phase', 'error']) {
        if (!nullableString(channel[field])) {
            errors.push(`${prefix}.${field} is invalid`);
        }
    }
    for (const field of [
        'createdAt',
        'updatedAt',
        'discovered',
        'completed',
        'failed',
        'integrityFailures',
        'queued',
    ]) {
        if (!nonnegativeInteger(channel[field])) {
            errors.push(`${prefix}.${field} is invalid`);
        }
    }
    validateCurrent(channel.current, prefix, errors);
}

function validateSavedChannelIndex(index) {
    const errors = [];
    if (!exactKeys(index, INDEX_KEYS)) {
        errors.push('index has non-canonical top-level fields');
    }
    if (!index || index.schema !== INDEX_SCHEMA) {
        errors.push(`schema must equal ${INDEX_SCHEMA}`);
    }
    if (!index || index.version !== INDEX_VERSION) {
        errors.push(`version must equal ${INDEX_VERSION}`);
    }
    if (!index || !nonnegativeInteger(index.updatedAt)) {
        errors.push('updatedAt must be a nonnegative integer');
    }
    if (!index || !exactKeys(index.authority, AUTHORITY_KEYS)) {
        errors.push('authority contract has non-canonical fields');
    } else if (stableJson(index.authority) !== stableJson(SCORE_AUTHORITY)) {
        errors.push('authority contract does not identify manifest-row score_ledger');
    }
    if (!index || !Array.isArray(index.channels)) {
        errors.push('channels must be an array');
    }
    const channels = index && Array.isArray(index.channels)
        ? index.channels
        : [];
    channels.forEach((channel, channelIndex) => (
        validateChannel(channel, channelIndex, errors)
    ));
    const ids = channels.map(channel => channel && channel.id);
    const duplicateIds = [...new Set(ids.filter(
        (id, channelIndex) => ids.indexOf(id) !== channelIndex
    ))];
    if (duplicateIds.length) {
        errors.push(`duplicate channel IDs: ${duplicateIds.join(', ')}`);
    }
    const manifestKeys = channels.map(
        channel => channel && channel.manifestKey
    );
    const duplicateManifestKeys = [...new Set(manifestKeys.filter(
        (key, channelIndex) => manifestKeys.indexOf(key) !== channelIndex
    ))];
    if (duplicateManifestKeys.length) {
        errors.push(
            `duplicate manifest keys: ${duplicateManifestKeys.join(', ')}`
        );
    }
    const ordered = channels.slice().sort(canonicalChannelOrder);
    if (stableJson(ordered) !== stableJson(channels)) {
        errors.push('channels are not in canonical updatedAt/id order');
    }
    const computedPayloadSha256 = index
        ? sha256Bytes(canonicalBytes(indexPayload(index)))
        : null;
    if (
        !index
        || !SHA256_PATTERN.test(String(index.payloadSha256 || ''))
        || index.payloadSha256 !== computedPayloadSha256
    ) {
        errors.push('payloadSha256 does not match the canonical payload');
    }
    return {
        valid: errors.length === 0,
        errors,
        duplicateIds,
        duplicateManifestKeys,
        computedPayloadSha256,
        channelCount: channels.length,
        authority: index && index.authority || null,
    };
}

function canonicalIndexBytes(index) {
    const validation = validateSavedChannelIndex(index);
    if (!validation.valid) {
        throw new Error(
            `Cannot serialize invalid saved-channel index: ${validation.errors.join('; ')}`
        );
    }
    return canonicalBytes(index);
}

function canonicalIndexArtifactIdentity(index) {
    const validation = validateSavedChannelIndex(index);
    if (!validation.valid) {
        throw new Error(
            `Cannot identify invalid saved-channel index: ${validation.errors.join('; ')}`
        );
    }
    return canonicalArtifactIdentity(index);
}

module.exports = {
    INDEX_SCHEMA,
    INDEX_VERSION,
    INDEX_KEY,
    MANIFEST_KEY_PATTERN,
    SCORE_AUTHORITY,
    INDEX_KEYS,
    CHANNEL_KEYS,
    CURRENT_KEYS,
    stableJson,
    canonicalBytes,
    sha256Bytes,
    canonicalManifestKey,
    isCanonicalManifestKey,
    channelEntryFromManifest,
    buildSavedChannelIndex,
    buildSavedChannelIndexFromEntries,
    replaceSavedChannelIndexEntry,
    removeSavedChannelIndexEntry,
    validateSavedChannelIndex,
    canonicalIndexBytes,
    canonicalIndexArtifactIdentity,
    indexPayload,
};
