#!/usr/bin/env node
'use strict';

const path = require('path');

try {
    require('dotenv').config({
        path: path.join(__dirname, '..', '.env'),
    });
} catch (_) {}

const cloud = require('../cloud-storage');
const videoIndex = require(
    '../buildings/jarvis/longform-video-index'
);

async function main() {
    const write = process.argv.includes('--write');
    cloud.initR2();
    if (!cloud.isR2Ready()) {
        throw new Error('R2 is not configured.');
    }
    const sourceBytes = await cloud.downloadFromR2(
        videoIndex.SOURCE_KEY
    );
    if (!sourceBytes) {
        throw new Error(`${videoIndex.SOURCE_KEY} is missing.`);
    }
    const database = JSON.parse(sourceBytes.toString('utf8'));
    const index = videoIndex.buildIndex(database, sourceBytes);
    const release = videoIndex.bindRelease(index);
    const indexValidation = videoIndex.validateIndex(index);
    const releaseValidation = videoIndex.validateRelease(release);
    if (!indexValidation.valid || !releaseValidation.valid) {
        throw new Error(
            []
                .concat(indexValidation.errors || [])
                .concat(releaseValidation.errors || [])
                .join('; ')
        );
    }
    if (write) {
        await cloud.uploadToR2(
            videoIndex.immutableIndexKey(index),
            Buffer.from(JSON.stringify(index)),
            'application/json'
        );
        const roundTrip = await cloud.downloadFromR2(
            videoIndex.immutableIndexKey(index)
        );
        const roundTripIndex = JSON.parse(roundTrip.toString('utf8'));
        const roundTripValidation =
            videoIndex.validateIndex(roundTripIndex);
        if (
            !roundTripValidation.valid
            || roundTripIndex.artifact_sha256
                !== index.artifact_sha256
        ) {
            throw new Error(
                'immutable video index failed read-after-write validation'
            );
        }
        await cloud.uploadToR2(
            videoIndex.RELEASE_KEY,
            Buffer.from(JSON.stringify(release)),
            'application/json'
        );
        const releaseRoundTrip = JSON.parse(
            (
                await cloud.downloadFromR2(
                    videoIndex.RELEASE_KEY
                )
            ).toString('utf8')
        );
        if (
            !videoIndex.validateRelease(releaseRoundTrip).valid
            || releaseRoundTrip.release_sha256
                !== release.release_sha256
        ) {
            throw new Error(
                'video index release failed read-after-write validation'
            );
        }
    }
    process.stdout.write(`${JSON.stringify({
        ok: true,
        write,
        source_bytes: sourceBytes.length,
        source_sha256: index.source.sha256,
        stored_video_count: index.stored_video_count,
        rows_per_list: Object.fromEntries(
            Object.entries(index.lists).map(
                ([key, rows]) => [key, rows.length]
            )
        ),
        index_key: videoIndex.immutableIndexKey(index),
        index_sha256: index.artifact_sha256,
        release_key: videoIndex.RELEASE_KEY,
        release_sha256: release.release_sha256,
    }, null, 2)}\n`);
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
