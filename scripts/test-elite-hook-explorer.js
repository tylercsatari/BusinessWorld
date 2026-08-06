'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const elite = require('../buildings/jarvis/elite-hook-explorer');
const {
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');

const ids = Array.from({ length: 10 }, (_, index) => `video-${index}`);
const ascending = Array.from({ length: 10 }, (_, index) => index * 10);
const map = {
    n: ids.length,
    id: ids,
    title: ids.map(id => `Title ${id}`),
    txt: ids.map(id => `Opening for ${id}`),
    views: ids.map((_, index) => 1000 * (index + 1)),
    owner: ids.map(() => ''),
    clusters: {
        24: ids.map((_, index) => index % 3),
    },
    proj: {
        keep: { x: ascending },
        ret5: { x: ascending.slice().reverse() },
        views: { x: ascending },
        hi10m: { x: ascending },
    },
};
const mapBytes = Buffer.from(JSON.stringify(map));
const mapSha256 = sha256Bytes(mapBytes);
const mapManifest = {
    embeddingModel: 'gemini-embedding-2',
    embeddingDimensions: 1536,
    publishedMap: {
        archiveKey: `raw/together/maps/by-sha256/${mapSha256}.json`,
        artifactSha256: mapSha256,
        rowCount: ids.length,
        videoIdSha256: 'a'.repeat(64),
    },
};
function entry(coordinateId, percentile) {
    return {
        coordinate_id: coordinateId,
        available: true,
        percentile,
    };
}
const savedChannelIndex = {
    payloadSha256: 'b'.repeat(64),
    channels: [{
        id: 'channel-1',
        name: 'Channel One',
        manifestKey: 'raw/saved-channels/channel-1/manifest.json',
        manifestSha256: 'c'.repeat(64),
        completed: 2,
    }],
};
const savedChannelManifests = {
    'channel-1': {
        videos: [
            { id: 'video-9', title: 'Existing row' },
            {
                id: 'supplemental-1',
                title: 'Saved-only elite row',
                transcript: 'A saved-channel opening absent from the map',
                views: 20000,
                canonical: false,
                score_ledger: {
                    entries: [
                        entry('shorts.stored.together.keep', 98),
                        entry('shorts.stored.together.ret5', 96),
                        entry('shorts.stored.together.views', 97),
                        entry('shorts.stored.together.gt10M', 95),
                    ],
                },
            },
        ],
    },
};

const index = elite.buildIndex({
    map,
    mapManifest,
    mapBytesSha256: mapSha256,
    savedChannelIndex,
    savedChannelIndexBytesSha256: 'd'.repeat(64),
    savedChannelManifests,
    generatedAt: '2026-08-05T00:00:00.000Z',
});
assert.equal(elite.validateIndex(index).valid, true);
const deterministicInput = {
    map,
    mapManifest,
    mapBytesSha256: mapSha256,
    savedChannelIndex: {
        ...savedChannelIndex,
        updatedAt: 1785888000000,
    },
    savedChannelIndexBytesSha256: 'd'.repeat(64),
    savedChannelManifests,
};
const deterministicIndex = elite.buildIndex(deterministicInput);
assert.equal(
    deterministicIndex.generated_at,
    new Date(1785888000000).toISOString()
);
assert.equal(
    deterministicIndex.content_sha256,
    elite.buildIndex(deterministicInput).content_sha256,
    'identical source artifacts must produce an identical index hash'
);
assert.equal(index.corpus.row_count, 10);
assert(index.rows.some(row => (
    row.id === 'supplemental-1'
    && row.embedding_available === false
    && row.source_evidence_state
        === 'historical_saved_channel_ledger_retrieval_only'
)));
const channelRows = elite.eligibleRows(index, {
    metric: 'together_keep_geometry',
    cutoff: 90,
    channelOriented: true,
    channelId: 'channel-1',
});
assert.deepEqual(
    channelRows.map(row => row.id).sort(),
    ['supplemental-1', 'video-9']
);
const sources = elite.selectSources({
    rows: channelRows,
    metric: 'together_keep_geometry',
    query: 'saved elite opening',
    semanticResults: [{
        id: 'video-9',
        query_similarity: 0.9,
        centroid_similarity: 0.8,
    }],
    limit: 2,
    attemptIndex: 1,
});
assert.equal(sources.length, 2);
assert(sources.every(source => (
    source.evidence_role === 'descriptive_retrieval_only'
)));
const prompt = elite.generationPrompt({
    seedPremise: 'Build a safer robot arm',
    sources,
    channelName: 'Channel One',
    channelOriented: true,
    attemptIndex: 2,
});
assert(prompt.includes('IMMUTABLE VIDEO REALM'));
assert(prompt.includes('retrieval evidence, not templates and not causal truths'));
assert(prompt.includes('SOURCE 1'));
const summary = elite.publicSummary(index);
assert.equal(summary.minimum_index_percentile, 80);
assert.equal(summary.channels[0].corpus_match_count, 2);
assert.equal(summary.governance.runtime_rebuild, false);
const tampered = JSON.parse(JSON.stringify(index));
tampered.rows[0].title = 'tampered';
assert.equal(elite.validateIndex(tampered).valid, false);

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const uiSource = fs.readFileSync(
    path.join(root, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
const authSource = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
[
    '/api/hooks/elite-corpus',
    "explorationMode === 'elite-corpus'",
    'prepareEliteHookRetrieval',
    'elite_sources',
    'elite_index_content_sha256',
    'generateFivePanelStoryboard',
    'scoreMontage',
].forEach(fragment => assert(
    serverSource.includes(fragment),
    `server is missing elite contract fragment: ${fragment}`
));
assert(
    !serverSource.includes('rebuildEliteHookCorpus'),
    'the live server must never launch the memory-heavy corpus builder'
);
[
    'Elite corpus explorer',
    'data-grindelitemetric',
    'data-grindchanneloriented',
    'data-grindelitechannel',
    'elite source',
    'Semantic retrieval degraded',
    'Source geometry chose evidence only',
].forEach(fragment => assert(
    uiSource.includes(fragment),
    `shared experiment UI is missing elite fragment: ${fragment}`
));
assert(authSource.includes('generate|warmup|grind|elite-corpus'));

console.log('elite hook explorer tests passed');
