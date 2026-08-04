'use strict';

const crypto = require('crypto');
const { canonicalJson } = require('./shorts-score-ledger');

const SCHEMA = 'longform-video-index-v1';
const SCHEMA_VERSION = 1;
const SOURCE_KEY = 'longform/db.json';
const INDEX_ROOT = 'longform/video-index/by-sha256/';
const RELEASE_KEY = 'longform/video-index-release-v1.json';
const MAX_ROWS = 400;

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function compactRow(video) {
    const videoId = String(video && video.videoId || '');
    const views = finiteOrNull(video && video.views);
    const subscribers = finiteOrNull(video && video.subs);
    const storedOutlier = finiteOrNull(video && video.outlier);
    const outlier = storedOutlier == null
        && views != null
        && subscribers > 0
        ? Number((views / subscribers).toFixed(1))
        : storedOutlier;
    return {
        videoId,
        title: String(video && video.title || ''),
        channel: String(video && video.channel || ''),
        channelUrl: video && video.channelUrl || null,
        views,
        subs: subscribers,
        outlier,
        publishedAt: video && video.publishedAt || null,
        uploadDate: video && video.uploadDate || null,
        likes: finiteOrNull(video && video.likes),
        comments: finiteOrNull(video && video.comments),
        durationSec: finiteOrNull(video && video.durationSec),
        width: finiteOrNull(video && video.width),
        height: finiteOrNull(video && video.height),
        storedAt: finiteOrNull(video && video.storedAt),
        thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        url: video && video.url
            || `https://www.youtube.com/watch?v=${videoId}`,
    };
}

function bindIndex(index) {
    const bound = { ...index };
    delete bound.artifact_sha256;
    bound.artifact_sha256 = sha256Bytes(
        Buffer.from(canonicalJson(bound))
    );
    return bound;
}

function immutableIndexKey(index) {
    return `${INDEX_ROOT}${index.artifact_sha256}.json`;
}

function bindRelease(index) {
    const release = {
        schema: 'longform-video-index-release-v1',
        schema_version: 1,
        source: { ...index.source },
        index: {
            key: immutableIndexKey(index),
            sha256: index.artifact_sha256,
            stored_video_count: index.stored_video_count,
            max_rows_per_list: index.max_rows_per_list,
        },
        generated_at_ms: index.generated_at_ms,
    };
    release.release_sha256 = sha256Bytes(
        Buffer.from(canonicalJson(release))
    );
    return release;
}

function buildIndex(database, sourceBytes, options = {}) {
    const videos = Object.values(
        database && database.videos || {}
    ).filter(video => video && video.stored === true);
    const rows = videos.map(compactRow);
    const limit = Math.min(
        MAX_ROWS,
        Math.max(1, Number(options.maxRows) || MAX_ROWS)
    );
    const sortBy = key => rows.slice().sort((left, right) => (
        (Number(right[key]) || 0) - (Number(left[key]) || 0)
        || left.videoId.localeCompare(right.videoId)
    )).slice(0, limit);
    return bindIndex({
        schema: SCHEMA,
        schema_version: SCHEMA_VERSION,
        source: {
            key: SOURCE_KEY,
            sha256: sha256Bytes(sourceBytes),
            updated_at_ms:
                finiteOrNull(database && database.updated),
        },
        generated_at_ms:
            finiteOrNull(options.generatedAtMs) || Date.now(),
        stored_video_count: rows.length,
        max_rows_per_list: limit,
        lists: {
            recent: sortBy('storedAt'),
            views: sortBy('views'),
            outlier: sortBy('outlier'),
        },
    });
}

function validateIndex(index) {
    const errors = [];
    if (!index || typeof index !== 'object' || Array.isArray(index)) {
        return { valid: false, errors: ['video index is missing'] };
    }
    if (
        index.schema !== SCHEMA
        || index.schema_version !== SCHEMA_VERSION
    ) {
        errors.push('video index schema is invalid');
    }
    if (
        !index.source
        || index.source.key !== SOURCE_KEY
        || !/^[a-f0-9]{64}$/.test(String(index.source.sha256 || ''))
    ) {
        errors.push('video index source binding is invalid');
    }
    const lists = index.lists || {};
    const expectedLists = ['recent', 'views', 'outlier'];
    if (
        Object.keys(lists).length !== expectedLists.length
        || expectedLists.some(key => !Array.isArray(lists[key]))
    ) {
        errors.push('video index list inventory is invalid');
    }
    const maxRows = Number(index.max_rows_per_list);
    if (
        !Number.isInteger(maxRows)
        || maxRows < 1
        || maxRows > MAX_ROWS
    ) {
        errors.push('video index row limit is invalid');
    }
    for (const key of expectedLists) {
        const rows = Array.isArray(lists[key]) ? lists[key] : [];
        if (rows.length > maxRows) {
            errors.push(`${key} list exceeds its declared row limit`);
        }
        const ids = rows.map(row => String(row && row.videoId || ''));
        if (
            ids.some(id => !/^[\w-]{6,20}$/.test(id))
            || new Set(ids).size !== ids.length
        ) {
            errors.push(`${key} list has invalid or duplicate video ids`);
        }
        const sortKey = key === 'recent' ? 'storedAt' : key;
        for (let indexAt = 1; indexAt < rows.length; indexAt++) {
            const previous = Number(rows[indexAt - 1][sortKey]) || 0;
            const current = Number(rows[indexAt][sortKey]) || 0;
            if (current > previous) {
                errors.push(`${key} list is not sorted descending`);
                break;
            }
        }
    }
    const payload = { ...index };
    delete payload.artifact_sha256;
    const calculated = sha256Bytes(
        Buffer.from(canonicalJson(payload))
    );
    if (
        !/^[a-f0-9]{64}$/.test(String(index.artifact_sha256 || ''))
        || index.artifact_sha256 !== calculated
    ) {
        errors.push('video index content hash does not match');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        source_sha256:
            errors.length === 0 ? index.source.sha256 : null,
        artifact_sha256:
            errors.length === 0 ? index.artifact_sha256 : null,
    };
}

function validateRelease(release) {
    const errors = [];
    if (
        !release
        || release.schema !== 'longform-video-index-release-v1'
        || release.schema_version !== 1
    ) {
        errors.push('video index release schema is invalid');
    }
    if (
        !release
        || !release.source
        || release.source.key !== SOURCE_KEY
        || !/^[a-f0-9]{64}$/.test(String(release.source.sha256 || ''))
    ) {
        errors.push('video index release source is invalid');
    }
    if (
        !release
        || !release.index
        || !/^[a-f0-9]{64}$/.test(String(release.index.sha256 || ''))
        || release.index.key
            !== `${INDEX_ROOT}${release.index.sha256}.json`
    ) {
        errors.push('video index immutable reference is invalid');
    }
    const payload = { ...(release || {}) };
    delete payload.release_sha256;
    const calculated = sha256Bytes(
        Buffer.from(canonicalJson(payload))
    );
    if (
        !/^[a-f0-9]{64}$/.test(
            String(release && release.release_sha256 || '')
        )
        || release.release_sha256 !== calculated
    ) {
        errors.push('video index release hash does not match');
    }
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        release_sha256:
            errors.length === 0 ? release.release_sha256 : null,
    };
}

module.exports = {
    INDEX_ROOT,
    MAX_ROWS,
    RELEASE_KEY,
    SCHEMA,
    SCHEMA_VERSION,
    SOURCE_KEY,
    bindIndex,
    bindRelease,
    buildIndex,
    compactRow,
    immutableIndexKey,
    sha256Bytes,
    validateIndex,
    validateRelease,
};
