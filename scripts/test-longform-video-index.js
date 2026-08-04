#!/usr/bin/env node
'use strict';

const assert = require('assert');
const videoIndex = require(
    '../buildings/jarvis/longform-video-index'
);

const database = {
    updated: 1234,
    videos: {
        aaaaaa: {
            videoId: 'aaaaaa',
            stored: true,
            views: 100,
            subs: 10,
            storedAt: 20,
        },
        bbbbbb: {
            videoId: 'bbbbbb',
            stored: true,
            views: 300,
            subs: 100,
            storedAt: 10,
        },
        cccccc: {
            videoId: 'cccccc',
            stored: false,
            views: 1000,
            storedAt: 30,
        },
    },
};
const sourceBytes = Buffer.from(JSON.stringify(database));
const index = videoIndex.buildIndex(
    database,
    sourceBytes,
    { generatedAtMs: 999 }
);
assert.strictEqual(videoIndex.validateIndex(index).valid, true);
assert.deepStrictEqual(
    index.lists.views.map(row => row.videoId),
    ['bbbbbb', 'aaaaaa']
);
assert.deepStrictEqual(
    index.lists.recent.map(row => row.videoId),
    ['aaaaaa', 'bbbbbb']
);
assert.deepStrictEqual(
    index.lists.outlier.map(row => row.videoId),
    ['aaaaaa', 'bbbbbb']
);
const release = videoIndex.bindRelease(index);
assert.strictEqual(
    videoIndex.validateRelease(release).valid,
    true
);

const tamperedIndex = JSON.parse(JSON.stringify(index));
tamperedIndex.lists.views[0].views = 1;
assert.strictEqual(
    videoIndex.validateIndex(tamperedIndex).valid,
    false
);
const tamperedRelease = JSON.parse(JSON.stringify(release));
tamperedRelease.index.sha256 = '0'.repeat(64);
assert.strictEqual(
    videoIndex.validateRelease(tamperedRelease).valid,
    false
);

process.stdout.write(JSON.stringify({
    ok: true,
    stored: index.stored_video_count,
    index_sha256: index.artifact_sha256,
    release_sha256: release.release_sha256,
}) + '\n');
