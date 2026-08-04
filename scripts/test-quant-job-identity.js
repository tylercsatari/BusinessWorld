'use strict';

const assert = require('assert');
const identity = require(
    '../buildings/jarvis/quant-job-identity'
);

const scorer = {
    coordinate_governance_sha256: 'a'.repeat(64),
    revision_fingerprint: 'b'.repeat(64),
};
const first = identity.requestFingerprint({
    kind: 'score-upload',
    namespace: 'longform',
    input: {
        image_sha256: identity.sha256Buffer(Buffer.from('image-a')),
        title: 'A title',
    },
    scorer,
});
const repeated = identity.requestFingerprint({
    kind: 'score-upload',
    namespace: 'longform',
    input: {
        title: 'A title',
        image_sha256: identity.sha256Buffer(Buffer.from('image-a')),
    },
    scorer,
});
const changedInput = identity.requestFingerprint({
    kind: 'score-upload',
    namespace: 'longform',
    input: {
        image_sha256: identity.sha256Buffer(Buffer.from('image-b')),
        title: 'A title',
    },
    scorer,
});
const changedScorer = identity.requestFingerprint({
    kind: 'score-upload',
    namespace: 'longform',
    input: {
        image_sha256: identity.sha256Buffer(Buffer.from('image-a')),
        title: 'A title',
    },
    scorer: {
        ...scorer,
        revision_fingerprint: 'c'.repeat(64),
    },
});

assert.strictEqual(first, repeated);
assert.notStrictEqual(first, changedInput);
assert.notStrictEqual(first, changedScorer);
assert.strictEqual(
    identity.reusableJobId(
        {
            jid: 'j1',
            ts: 1000,
            requestFingerprint: first,
        },
        first,
        2000
    ),
    'j1'
);
assert.strictEqual(
    identity.reusableJobId(
        {
            jid: 'j1',
            ts: 1000,
            requestFingerprint: first,
        },
        changedInput,
        2000
    ),
    ''
);
assert.strictEqual(
    identity.reusableJobId(
        {
            jid: 'j1',
            ts: 1000,
            requestFingerprint: first,
        },
        first,
        1000 + identity.REQUEST_REUSE_TTL_MS
    ),
    ''
);
assert.strictEqual(
    identity.normalizeRequestId(' ../bad ID!_ok '),
    'badID_ok'
);

console.log('quant job identity tests passed');
