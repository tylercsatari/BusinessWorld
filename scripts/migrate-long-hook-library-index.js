#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const {
    loadProjectEnvironment,
} = require('./load-project-environment');

loadProjectEnvironment();
const cloud = require('../cloud-storage');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const longHookLibraryIndex = require(
    '../buildings/jarvis/long-hook-library-index'
);
const shortsScoreLedger = require(
    '../buildings/jarvis/shorts-score-ledger'
);

const INDEX_KEY = 'longform/hook-embeds/index.json';
const ARCHIVE_ROOT =
    'longform/hook-embeds/index-archive/by-sha256/';
const WRITE = process.argv.includes('--write');
const CONCURRENCY = Math.max(
    1,
    Math.min(24, Number(
        process.env.LONG_HOOK_MIGRATION_CONCURRENCY || 12
    ))
);

function unique(values) {
    return [...new Set(values)];
}

async function mapLimit(values, limit, mapper) {
    const results = new Array(values.length);
    let cursor = 0;
    const workers = Array.from(
        { length: Math.min(limit, values.length) },
        async () => {
            while (cursor < values.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await mapper(
                    values[index],
                    index
                );
            }
        }
    );
    await Promise.all(workers);
    return results;
}

async function writeImmutableArchive(key, bytes) {
    try {
        await cloud.putR2SmallObjectConditional(
            key,
            bytes,
            {
                ifNoneMatch: '*',
                contentType: 'application/json',
            }
        );
    } catch (error) {
        if (!cloud.isR2PreconditionFailedError(error)) {
            throw error;
        }
    }
    const stored = await cloud.getR2SmallObject(key);
    if (!stored.body.equals(bytes)) {
        throw new Error(
            'Long hook source-index archive differs from exact source bytes'
        );
    }
}

async function main() {
    cloud.initR2();
    const sourceRevision =
        await cloud.getR2SmallObject(INDEX_KEY);
    const sourceBytes = sourceRevision.body;
    const sourceSha256 = sha256Bytes(sourceBytes);
    const source = JSON.parse(sourceBytes.toString('utf8'));
    const sourceValidation =
        longHookLibraryIndex.validateIndex(source);
    const listedKeys = await cloud.listR2Keys(
        longHookLibraryIndex.RECORD_ROOT
    );
    const listedIds = listedKeys
        .map(key => key.match(
            /^longform\/hook-embeds\/([^/]+)\.json$/
        ))
        .filter(match => match && match[1] !== 'index')
        .map(match => match[1]);
    const sourceIds = Array.isArray(source.rows)
        ? source.rows.map(row => String(row && row.id || ''))
            .filter(Boolean)
        : [];
    const ids = unique(sourceIds.concat(listedIds));
    const listedIdSet = new Set(listedIds);
    const records = await mapLimit(
        ids,
        CONCURRENCY,
        async id => {
            const key = `${longHookLibraryIndex.RECORD_ROOT}${id}.json`;
            const bytes = await cloud.downloadFromR2(key);
            if (!bytes) {
                return {
                    id,
                    key,
                    error: 'record is missing',
                };
            }
            try {
                const record = JSON.parse(bytes.toString('utf8'));
                if (String(record.id || '') !== id) {
                    throw new Error(
                        'record ID differs from storage key'
                    );
                }
                return {
                    id,
                    key,
                    bytes,
                    row:
                        longHookLibraryIndex.compactRecord(
                            record,
                            bytes
                        ),
                };
            } catch (error) {
                return {
                    id,
                    key,
                    error: error.message,
                };
            }
        }
    );
    const failures = records.filter(record => record.error);
    const blockingFailures = failures.filter(
        record => listedIdSet.has(record.id)
    );
    const retiredDanglingRows = failures.filter(
        record => !listedIdSet.has(record.id)
    );
    if (blockingFailures.length) {
        throw new Error(
            `${blockingFailures.length} Long hook records failed: `
                + blockingFailures.slice(0, 12)
                    .map(record => (
                        `${record.id}: ${record.error}`
                    ))
                    .join('; ')
        );
    }
    const rowsById = new Map(
        records
            .filter(record => record.row)
            .map(record => [record.id, record.row])
    );
    const orderedIds = sourceIds.concat(
        ids.filter(id => !sourceIds.includes(id)).sort()
    ).filter(id => rowsById.has(id));
    const producerSourceSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(__filename))
        .digest('hex');
    const archiveKey =
        `${ARCHIVE_ROOT}${sourceSha256}.json`;
    const migrationRelease = sourceValidation.valid
        ? source.migration_release
        : {
            schema:
                'long-hook-library-index-migration-v1',
            source_index_sha256: sourceSha256,
            source_archive_key: archiveKey,
            source_rows: sourceIds.length,
            record_ids_sha256:
                shortsScoreLedger.sha256Canonical(
                    orderedIds
                ),
            producer_source_sha256:
                producerSourceSha256,
            migrated_at: Date.now(),
        };
    const rebuilt =
        longHookLibraryIndex.bindIndex({
            rows: orderedIds.map(id => rowsById.get(id)),
            recut: source.recut || null,
            migration_release: migrationRelease,
            updated_at: sourceValidation.valid
                ? source.updated_at
                : Date.now(),
        });
    const rebuiltValidation =
        longHookLibraryIndex.validateIndex(rebuilt);
    if (!rebuiltValidation.valid) {
        throw new Error(
            rebuiltValidation.errors.join('; ')
        );
    }
    const rebuiltBytes = canonicalJsonBytes(rebuilt);
    const byteIdentical = sourceBytes.equals(rebuiltBytes);
    if (WRITE && !byteIdentical) {
        if (!sourceValidation.valid) {
            await writeImmutableArchive(
                archiveKey,
                sourceBytes
            );
        }
        await cloud.putR2SmallObjectConditional(
            INDEX_KEY,
            rebuiltBytes,
            {
                ifMatch: sourceRevision.etag,
                contentType: 'application/json',
            }
        );
        const stored =
            await cloud.getR2SmallObject(INDEX_KEY);
        if (!stored.body.equals(rebuiltBytes)) {
            throw new Error(
                'Long hook index failed exact read-after-write verification'
            );
        }
    }
    const summary = {
        schema: 'long-hook-library-index-migration-report-v1',
        mode: WRITE ? 'write' : 'dry-run',
        source_valid: sourceValidation.valid,
        source_errors: sourceValidation.errors,
        source_sha256: sourceSha256,
        source_rows: sourceIds.length,
        discovered_records: listedIds.length,
        retired_dangling_index_rows:
            retiredDanglingRows.map(record => record.id),
        output_rows: rebuilt.rows.length,
        canonical_bound:
            rebuilt.counts.canonical_bound,
        legacy_unbound:
            rebuilt.counts.legacy_unbound,
        output_sha256: rebuilt.index_sha256,
        byte_identical: byteIdentical,
        wrote: WRITE && !byteIdentical,
        concurrency: CONCURRENCY,
        archive_key:
            sourceValidation.valid ? null : archiveKey,
    };
    process.stdout.write(
        `${JSON.stringify(summary, null, 2)}\n`
    );
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
