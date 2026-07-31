#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const longSavedThumbnailRecord = require(
    '../buildings/jarvis/long-saved-thumbnail-record'
);
const {
    existingLongQuantIndex,
    hasGeneratedWork,
    loadCanonicalSavedVideoIds,
    validateCanonicalLongScore,
} = require('./queue-longquant-channel-grinds');
const {
    jpeg,
    makeScore,
} = require('./test-migrate-long-saved-thumbnails');

function sha256(bytes) {
    return crypto
        .createHash('sha256')
        .update(bytes)
        .digest('hex');
}

const title = 'Canonical queue evidence';
const image = jpeg('queue-evidence');
const imageSha256 = sha256(image);
const score = makeScore(image, title, 88);
const record = longSavedThumbnailRecord.bindRecord({
    id: 'ltqueuefixture',
    savedAt: 1700000000002,
    title,
    prompt: 'Canonical queue prompt',
    source: 'channel-grind',
    score,
    media: {
        kind: 'thumbnail-jpeg',
        key:
            `longform/saved-thumbs/media/by-sha256/${imageSha256}.jpg`,
        thumbnail_sha256: imageSha256,
        byte_length: image.length,
    },
    sourceVideo: {
        id: 'video-saved',
        title,
    },
});
const row = longSavedThumbnailRecord.compactIndexRow(record);
const index = longSavedThumbnailRecord.bindIndex({
    rows: [row],
    legacy_unbound: [],
});

assert.strictEqual(
    validateCanonicalLongScore(score).valid,
    true,
    validateCanonicalLongScore(score).errors.join('; ')
);
assert.strictEqual(
    hasGeneratedWork({
        status: 'won',
        best: 99,
        winner: 0,
        autosaved: { id: 'legacy-alias' },
        attempts: [{
            pct: 99,
            thumbs: [{
                status: 'done',
                image: 'legacy-image',
                pct: 99,
                score: {
                    pctile: 0.99,
                    reward: 0.99,
                },
            }],
        }],
    }),
    false,
    'queue utility trusted aliases as generated evidence'
);
assert.strictEqual(
    hasGeneratedWork({
        status: 'running',
        baseline: { score },
        attempts: [],
    }),
    false,
    'queue utility treated running/baseline state as generated evidence'
);
assert.strictEqual(
    hasGeneratedWork({
        status: 'running',
        attempts: [{
            thumbs: [{
                status: 'done',
                image: 'canonical-image',
                score,
            }],
        }],
    }),
    true,
    'queue utility rejected canonical generated evidence'
);

const tamperedScore = JSON.parse(JSON.stringify(score));
tamperedScore.long_score_ledger.values_by_id[
    'long.output.visual.views'
] += 1;
assert.strictEqual(
    validateCanonicalLongScore(tamperedScore).valid,
    false,
    'queue utility accepted a tampered Long ledger'
);

async function canonicalIndexRecordsAreRequired() {
    const records = new Map([
        [row.record_key, record],
    ]);
    const ids = await loadCanonicalSavedVideoIds(
        index,
        async key => records.get(key) || null
    );
    assert.deepStrictEqual(
        [...ids],
        ['video-saved']
    );

    await assert.rejects(
        () => loadCanonicalSavedVideoIds(
            {
                thumbs: [{
                    id: record.id,
                    sourceVideo: record.sourceVideo,
                    pctile: 0.88,
                }],
            },
            async () => null
        ),
        /index is not canonical/,
        'queue utility accepted the legacy saved-thumbnails array'
    );

    const swappedRecord = {
        ...record,
        sourceVideo: {
            id: 'video-repointed',
            title,
        },
    };
    swappedRecord.record_content_sha256 =
        longSavedThumbnailRecord.recordContentSha256(
            swappedRecord
        );
    await assert.rejects(
        () => loadCanonicalSavedVideoIds(
            index,
            async () => swappedRecord
        ),
        /index\/record binding differs/,
        'queue utility accepted a repointed canonical record'
    );
}

async function existingIndexUsesOnlyCanonicalAuthority() {
    const validRunKey =
        'longform/grind/runs/valid.json';
    const aliasRunKey =
        'longform/grind/runs/alias.json';
    const values = new Map([
        [
            validRunKey,
            {
                rid: 'valid',
                source: 'channel-grind',
                sourceVideo: { id: 'video-valid' },
                status: 'running',
                attempts: [{
                    thumbs: [{
                        status: 'done',
                        image: 'canonical-image',
                        score,
                    }],
                }],
            },
        ],
        [
            aliasRunKey,
            {
                rid: 'alias',
                source: 'channel-grind',
                sourceVideo: { id: 'video-alias' },
                status: 'running',
                best: 99,
                winner: 0,
                attempts: [{
                    pct: 99,
                    thumbs: [{
                        status: 'done',
                        image: 'legacy-image',
                        pct: 99,
                        score: { pctile: 0.99 },
                    }],
                }],
            },
        ],
        [
            'longform/saved-thumbs/index.json',
            index,
        ],
        [row.record_key, record],
    ]);
    const result = await existingLongQuantIndex({
        listKeys: async prefix => (
            prefix === 'longform/grind/runs/'
                ? [validRunKey, aliasRunKey]
                : []
        ),
        readJson: async key => values.get(key) || null,
    });
    assert.deepStrictEqual(
        [...result.generatedVideoIds].sort(),
        ['video-saved', 'video-valid']
    );
    assert.deepStrictEqual(
        [...result.pendingVideoIds],
        ['video-alias']
    );
    await assert.rejects(
        () => existingLongQuantIndex({
            listKeys: async () => {
                throw new Error('listing unavailable');
            },
            readJson: async () => null,
        }),
        /listing unavailable/,
        'queue utility converted an authority read failure into an empty index'
    );
}

async function main() {
    await canonicalIndexRecordsAreRequired();
    await existingIndexUsesOnlyCanonicalAuthority();
    process.stdout.write(`${JSON.stringify({
        ok: true,
        cases: [
            'aliases never mark generated work',
            'canonical Long score contracts are required',
            'canonical saved index-record pairs are required',
            'tampered ledgers and repointed records fail closed',
            'authority read failures fail closed',
        ],
    })}\n`);
}

main().catch(error => {
    process.stderr.write(
        `${error.stack || error.message}\n`
    );
    process.exitCode = 1;
});
