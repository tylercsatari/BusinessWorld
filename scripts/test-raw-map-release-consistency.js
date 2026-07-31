#!/usr/bin/env node
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SHORT_SOURCE = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
const LONG_SOURCE = fs.readFileSync(
    path.join(ROOT, 'buildings/jarvis/jarvis-longquant.js'),
    'utf8'
);
const SHORT_PUBLISHER = fs.readFileSync(
    path.join(ROOT, 'add_steered_proj.py'),
    'utf8'
);
const LONG_PUBLISHER = fs.readFileSync(
    path.join(ROOT, 'add_steered_proj_long.py'),
    'utf8'
);

function loadPrivateApi(source, marker, replacement) {
    assert(
        source.includes(marker),
        'release test instrumentation point changed'
    );
    const sandbox = {
        console,
        module: { exports: {} },
        exports: {},
        window: {
            addEventListener() {},
            clearInterval() {},
            clearTimeout,
            document: { wasDiscarded: false },
            localStorage: {
                getItem() { return null; },
                removeItem() {},
                setItem() {},
            },
            setInterval() { return 1; },
            setTimeout,
        },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(
        source.replace(marker, replacement),
        sandbox,
        { timeout: 10000 }
    );
    return sandbox.module.exports.__releaseConsistency;
}

const shortApi = loadPrivateApi(
    SHORT_SOURCE,
    `    return {
        mount,
        mountExperiment,
        unmountExperiment,
        getExperimentContext: () => LAB_CONTEXT,
        __st: () => st,
    };`,
    `    return {
        mount,
        mountExperiment,
        unmountExperiment,
        getExperimentContext: () => LAB_CONTEXT,
        __st: () => st,
        __releaseConsistency: {
            compactPlotCacheKey: rtCompactPlotCacheKey,
            compactPlotRelease: rtCompactPlotRelease,
            predictorFetchMatchedRelease,
            predictorReleasePair,
            rawMapRelease: rtRawMapRelease,
            releaseResponseIsCurrent: rtReleaseResponseIsCurrent,
        },
    };`
);
const longApi = loadPrivateApi(
    LONG_SOURCE,
    '    return { mount };',
    `    return {
        mount,
        __releaseConsistency: {
            compactPlotCacheKey: lqxCompactPlotCacheKey,
            compactPlotRelease: lqxCompactPlotRelease,
            rawMapRelease: lqxRawMapRelease,
            releaseResponseIsCurrent: lqxReleaseResponseIsCurrent,
        },
    };`
);

const SHA = {
    manifest: 'a'.repeat(64),
    pointer: 'b'.repeat(64),
    artifact: 'c'.repeat(64),
    nextManifest: 'd'.repeat(64),
    nextPointer: 'e'.repeat(64),
    nextArtifact: 'f'.repeat(64),
};

function rawHeaders(overrides) {
    return {
        mapReleaseSha256: SHA.manifest,
        mapPointerSha256: SHA.pointer,
        artifactSha256: SHA.artifact,
        etag: `"${SHA.artifact}"`,
        ...(overrides || {}),
    };
}

function compactRelease(overrides) {
    return {
        manifest_sha256: SHA.manifest,
        pointer_sha256: SHA.pointer,
        artifact_sha256: SHA.artifact,
        ...(overrides || {}),
    };
}

function verifyClient(name, api) {
    assert(api, `${name} release-consistency API is unavailable`);
    const raw = api.rawMapRelease(rawHeaders());
    assert.equal(
        raw.identity,
        `${SHA.manifest}:${SHA.pointer}:${SHA.artifact}`,
        `${name} Raw map identity must bind all three release hashes`
    );
    for (const field of [
        'mapReleaseSha256',
        'mapPointerSha256',
        'artifactSha256',
    ]) {
        assert.throws(
            () => api.rawMapRelease(
                rawHeaders({ [field]: null })
            ),
            /exact immutable release headers/,
            `${name} accepted a Raw map without ${field}`
        );
    }
    assert.throws(
        () => api.rawMapRelease(
            rawHeaders({
                artifactSha256:
                    SHA.artifact.toUpperCase(),
            })
        ),
        /exact immutable release headers/,
        `${name} accepted a non-canonical uppercase SHA-256 header`
    );

    const compact = api.compactPlotRelease(
        compactRelease()
    );
    assert.equal(
        compact.identity,
        `${SHA.manifest}:${SHA.pointer}:${SHA.artifact}`,
        `${name} compact release identity is incomplete`
    );
    assert.throws(
        () => api.compactPlotRelease(
            compactRelease({ pointer_sha256: null })
        ),
        /exact immutable release identity/,
        `${name} compact plot accepted a missing pointer hash`
    );

    const baseKey = 'visual:ledger:neighbors';
    const firstKey = api.compactPlotCacheKey(
        baseKey,
        compact
    );
    const next = api.compactPlotRelease({
        manifest_sha256: SHA.nextManifest,
        pointer_sha256: SHA.nextPointer,
        artifact_sha256: SHA.nextArtifact,
    });
    const nextKey = api.compactPlotCacheKey(
        baseKey,
        next
    );
    assert.notEqual(
        firstKey,
        nextKey,
        `${name} compact cache key ignored release rollover`
    );
    assert(firstKey.includes(compact.identity));
    assert(nextKey.includes(next.identity));

    const originalRequest = {
        sequence: 1,
        startedReleaseIdentity: compact.identity,
    };
    assert.equal(
        api.releaseResponseIsCurrent(
            originalRequest,
            originalRequest,
            compact,
            compact
        ),
        true,
        `${name} rejected the current response`
    );
    assert.equal(
        api.releaseResponseIsCurrent(
            originalRequest,
            { ...originalRequest, sequence: 2 },
            compact,
            compact
        ),
        false,
        `${name} accepted a superseded request`
    );
    assert.equal(
        api.releaseResponseIsCurrent(
            originalRequest,
            originalRequest,
            compact,
            next
        ),
        false,
        `${name} accepted an older response after release rollover`
    );
    assert.equal(
        api.releaseResponseIsCurrent(
            originalRequest,
            originalRequest,
            next,
            next
        ),
        true,
        `${name} rejected the response matching the active release`
    );
}

function assertOrdered(source, labels) {
    let previous = -1;
    for (const [label, needle] of labels) {
        const index = source.indexOf(needle, previous + 1);
        assert(
            index > previous,
            `${label} is missing or is published out of order`
        );
        previous = index;
    }
}

async function verifyPredictorRollover() {
    const releaseA = {
        release: '1'.repeat(64),
        artifact: '2'.repeat(64),
    };
    const releaseB = {
        release: '3'.repeat(64),
        artifact: '4'.repeat(64),
    };
    const artifact = release => {
        const value = {};
        Object.defineProperty(value, '_response_headers', {
            value: {
                predictorReleaseSha256: release.release,
                artifactSha256: release.artifact,
            },
        });
        return value;
    };
    const status = release => ({
        releaseSha256: release.release,
        artifactSha256: release.artifact,
        sourceOfTruth: 'raw/predictor-lab/release.json',
    });
    let artifactReads = 0;
    const waits = [];
    const result =
        await shortApi.predictorFetchMatchedRelease(
            async url => {
                if (url === '/api/raw/predictor-lab') {
                    artifactReads += 1;
                    return artifact(
                        artifactReads === 1
                            ? releaseA
                            : releaseB
                    );
                }
                return status(releaseB);
            },
            async delay => waits.push(delay)
        );
    assert.equal(
        artifactReads,
        2,
        'Predictor rollover did not refetch the artifact'
    );
    assert.deepEqual(
        waits,
        [150],
        'Predictor rollover retry delay drifted'
    );
    assert.equal(
        result.release.releaseSha256,
        releaseB.release
    );
    assert.equal(
        result.release.artifactSha256,
        releaseB.artifact
    );
    assert.throws(
        () => shortApi.predictorReleasePair(
            {},
            status(releaseA)
        ),
        error => (
            error
            && error.code === 'PREDICTOR_RELEASE_INVALID'
        ),
        'Predictor accepted an artifact without release headers'
    );
}

async function main() {
    verifyClient('Shorts', shortApi);
    verifyClient('Long', longApi);

    assertOrdered(SHORT_PUBLISHER, [
        [
            'Shorts immutable map artifact',
            'put_immutable(map_archive_key',
        ],
        [
            'Shorts immutable plot artifact',
            'put_immutable(plot_archive_key',
        ],
        [
            'Shorts immutable release manifest',
            'put_immutable_release_manifest(\n        manifest_archive_key',
        ],
        [
            'Shorts mutable map compatibility alias',
            "r2_put(f'raw/{ch}/map.json'",
        ],
        [
            'Shorts mutable plot compatibility alias',
            "r2_put(f'raw/{ch}/plot.json'",
        ],
        [
            'Shorts mutable release pointer',
            "f'raw/{ch}/map.manifest.json'",
        ],
    ]);
    const shortModelReleaseBlock = SHORT_PUBLISHER.slice(
        SHORT_PUBLISHER.indexOf(
            "archive_key = f'raw/steer_models/"
        ),
        SHORT_PUBLISHER.indexOf(
            '# Preserve every staged input'
        )
    );
    assertOrdered(shortModelReleaseBlock, [
        [
            'Shorts immutable steering artifact',
            'put_immutable(\n    archive_key',
        ],
        [
            'Shorts immutable steering manifest',
            'put_immutable_release_manifest(',
        ],
        [
            'Shorts mutable steering artifact alias',
            "'raw/steer_models.npz'",
        ],
        [
            'Shorts mutable steering release pointer',
            "'raw/steer_manifest.json'",
        ],
    ]);

    const longReleaseBlock = LONG_PUBLISHER.slice(
        LONG_PUBLISHER.indexOf(
            'map_immutable_key = '
        ),
        LONG_PUBLISHER.indexOf(
            'CHANNEL_MANIFESTS.append'
        )
    );
    assertOrdered(longReleaseBlock, [
        [
            'Long immutable map artifact',
            'put_immutable(\n        map_immutable_key',
        ],
        [
            'Long immutable plot artifact',
            'put_immutable(\n        plot_immutable_key',
        ],
        [
            'Long immutable release manifest',
            'put_immutable(\n        manifest_immutable_key',
        ],
        [
            'Long mutable release pointer',
            "f'raw-long/{ch}/map.manifest.json'",
        ],
    ]);

    assert(
        SHORT_SOURCE.includes(
            'const release = rtRawMapRelease(headers);'
        )
        && LONG_SOURCE.includes(
            'const release = lqxRawMapRelease(headers);'
        ),
        'Raw map loaders do not fail closed through the release validator'
    );
    assert(
        SHORT_SOURCE.includes(
            'rtReleaseResponseIsCurrent('
        )
        && LONG_SOURCE.includes(
            'lqxReleaseResponseIsCurrent('
        ),
        'Compact plot loaders do not reject out-of-order responses'
    );
    assert(
        SHORT_SOURCE.includes(
            'predictorScheduleRolloverRetry();'
        ),
        'Predictor rollover cannot recover automatically'
    );

    await verifyPredictorRollover();
    console.log(
        'raw-map release consistency tests passed'
    );
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
