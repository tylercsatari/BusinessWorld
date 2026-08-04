#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    bindDocument,
    bindIndex,
    bindScoreInput,
    cleanMedia,
    compactDocument,
    documentRevisionPayload,
    validateDocument,
    validateIndex,
} = require('../buildings/jarvis/storyboard-contract');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');
const {
    scoreRecordBindingSha256,
} = require('../buildings/jarvis/shorts-score-ledger');
const {
    ANIMATION_STYLE_ID,
} = require('../buildings/jarvis/storyboard-style-presets');

const sha = character => character.repeat(64);
const media = (character, extension = 'jpg', byteLength = 1024) => ({
    url: `/api/storyboards/media/${sha(character)}.${extension}`,
    byte_length: byteLength,
});
const panels = Array.from({ length: 5 }, (_, index) => ({
    id: `panel-${index + 1}`,
    prompt: `Shot ${index + 1}`,
    media: media(String(index + 1)),
    source: 'fixture',
    relation: index ? 'edit' : 'new',
    sourcePanels: index ? [index - 1] : [],
    revisions: [],
    strokes: [{
        tool: 'pen',
        color: '#FF3B30',
        size: 7,
        points: [[-20, -10], [500, 900]],
    }],
}));
const ledger = scoreLedgerFromFeatures({});
const hookText = 'This machine should not be able to do this.';
const scoreMontage = media('d', 'jpg', 8192);
const inputManifest = {
    score_input_fingerprint: sha('e'),
    input_fingerprint: sha('e'),
    output_fingerprint: sha('f'),
    revision_fingerprint: sha('a'),
};
const scoreRecord = {
    title: 'Coherent opening',
    text: hookText,
    score_ledger: ledger,
    input_manifest: inputManifest,
    indicators: { fixture: true },
    channels: { visual: { neighbors: [] } },
};
scoreRecord.score_record_sha256 =
    scoreRecordBindingSha256(scoreRecord);
const scoreInput = bindScoreInput({
    montage_sha256: sha('d'),
    panel_media_sha256s: panels.map(panel => (
        panel.media.url.match(/[a-f0-9]{64}/)[0]
    )),
    hookText,
    score_input_fingerprint: sha('e'),
    score_ledger_sha256: ledger.ledger_sha256,
    score_record_sha256: scoreRecord.score_record_sha256,
    output_fingerprint: inputManifest.output_fingerprint,
    scorer_revision_fingerprint:
        inputManifest.revision_fingerprint,
});

const document = bindDocument({
    id: 'sb0123456789',
    name: 'Coherent opening',
    brief: 'One visual story across five panels.',
    hookText,
    model: 'flux-2-pro',
    generationMode: 'composite',
    panels,
    references: [{
        id: 'reference-1',
        name: 'Machine',
        media: media('a', 'png', 2048),
        global: true,
        panels: [],
    }],
    composite: media('b', 'webp', 4096),
    score: {
        ...scoreRecord,
        score_montage: scoreMontage,
        score_input: scoreInput,
    },
    createdAt: 100,
    updatedAt: 200,
});

assert.strictEqual(document.panels.length, 5);
assert.strictEqual(document.complete, true);
assert.strictEqual(document.panels[0].strokes[0].color, '#ff3b30');
assert.deepStrictEqual(document.panels[0].strokes[0].points, [
    [0, 0],
    [320, 569],
]);
assert.strictEqual(document.score.score_ledger.ledger_sha256, ledger.ledger_sha256);
assert.strictEqual(document.score.score_input.binding_sha256, scoreInput.binding_sha256);
assert.strictEqual(document.score.score_montage.sha256, sha('d'));
assert.deepStrictEqual(document.score.indicators, { fixture: true });
assert(validateDocument(document).valid, 'bound document must validate');
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(document, 'stylePreset'),
    false,
    'legacy photographic storyboards must retain their canonical shape'
);
const animatedDocument = bindDocument({
    ...document,
    id: 'sbanimated001',
    stylePreset: ANIMATION_STYLE_ID,
});
assert.strictEqual(animatedDocument.stylePreset, ANIMATION_STYLE_ID);
assert(
    validateDocument(animatedDocument).valid,
    'the animation style must persist inside the immutable storyboard revision'
);
assert.notStrictEqual(animatedDocument.revision, document.revision);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        document.panels[0],
        'contextPanels'
    ),
    false,
    'legacy manifests must remain canonical without frame context'
);

const contextDocument = bindDocument({
    ...document,
    id: 'sbcontext0001',
    panels: document.panels.map((panel, index) => ({
        ...panel,
        contextPanels: [0, 1, 2, 3, 4]
            .filter(panelIndex => panelIndex !== index),
    })),
});
assert.deepStrictEqual(
    contextDocument.panels[0].contextPanels,
    [1, 2, 3, 4]
);
assert(
    validateDocument(contextDocument).valid,
    'new manifests must canonically retain explicit frame context'
);

const rebound = bindDocument({
    ...document,
    parentRevision: document.revision,
    updatedAt: 201,
});
assert.notStrictEqual(rebound.revision, document.revision);
assert.strictEqual(rebound.parentRevision, document.revision);

const tampered = JSON.parse(JSON.stringify(document));
tampered.panels[0].prompt = 'tampered';
assert(
    validateDocument(tampered).errors.includes('document revision binding'),
    'revision must bind every persisted field'
);

const inconsistentComplete = JSON.parse(JSON.stringify(document));
inconsistentComplete.complete = false;
inconsistentComplete.revision = sha256Bytes(
    canonicalJsonBytes(documentRevisionPayload(inconsistentComplete))
);
assert(
    validateDocument(inconsistentComplete).errors.includes(
        'document complete state'
    ),
    'complete must equal the five persisted panel states'
);

assert.throws(
    () => bindDocument({
        ...document,
        id: 'not-valid',
    }),
    /storyboard id is invalid/
);
assert.throws(
    () => bindDocument({
        ...document,
        score: {
            score_ledger: {
                ...ledger,
                ledger_sha256: sha('f'),
            },
            score_montage: scoreMontage,
            score_input: scoreInput,
        },
    }),
    /score ledger is invalid/
);

assert.throws(
    () => bindDocument({
        ...document,
        score: {
            ...document.score,
            score_input: {
                ...document.score.score_input,
                panel_media_sha256s: [
                    sha('a'),
                    sha('2'),
                    sha('3'),
                    sha('4'),
                    sha('5'),
                ],
            },
        },
    }),
    /score input binding differs/
);

assert.throws(
    () => bindDocument({
        ...document,
        score: {
            ...document.score,
            score_record_sha256: sha('0'),
        },
    }),
    /score record does not match/,
    'a ledger cannot be detached from its canonical score record'
);

assert.throws(
    () => bindScoreInput({
        montage_sha256: sha('d'),
        panel_media_sha256s:
            scoreInput.panel_media_sha256s,
        hookText,
        score_input_fingerprint: sha('e'),
        score_ledger_sha256: ledger.ledger_sha256,
        score_record_sha256:
            scoreRecord.score_record_sha256,
        output_fingerprint: sha('f'),
        scorer_revision_fingerprint: null,
    }),
    /scorer output/,
    'a score-input binding must identify its scorer revision'
);

const malformedRevision = JSON.parse(JSON.stringify(document));
malformedRevision.panels[0].revisions = [{ source: 'missing-media' }];
malformedRevision.revision = sha256Bytes(
    canonicalJsonBytes(documentRevisionPayload(malformedRevision))
);
assert(
    validateDocument(malformedRevision).errors.includes(
        'document canonical shape'
    ),
    'malformed revision shapes must not validate'
);

assert.strictEqual(cleanMedia('https://example.com/image.jpg'), null);
assert.strictEqual(cleanMedia('data:image/jpeg;base64,AA=='), null);
assert.strictEqual(
    cleanMedia(media('c')).key,
    `raw/storyboards/v1/media/by-sha256/${sha('c')}.jpg`
);

const compact = compactDocument(document);
assert.strictEqual(compact.scored, true);
assert.strictEqual(compact.scoreLedgerSha256, ledger.ledger_sha256);

const index = bindIndex({
    updatedAt: 300,
    storyboards: [
        compact,
        { ...compact, id: 'sbabcdefghij', updatedAt: 400 },
    ],
});
assert.deepStrictEqual(
    index.storyboards.map(row => row.id),
    ['sbabcdefghij', 'sb0123456789']
);
assert(validateIndex(index).valid, 'bound index must validate');
assert(
    !validateIndex({
        ...index,
        storyboards: [compact, compact],
    }).valid,
    'duplicate storyboard ids must fail'
);
assert(
    !validateIndex({
        ...index,
        storyboards: [
            { ...index.storyboards[0], undeclared: true },
            index.storyboards[1],
        ],
    }).valid,
    'index rows must not accept undeclared fields'
);
assert(
    !validateIndex({
        ...index,
        storyboards: index.storyboards.slice().reverse(),
    }).valid,
    'the index must remain newest first'
);

console.log(JSON.stringify({
    ok: true,
    revision: document.revision,
    ledgerSha256: ledger.ledger_sha256,
    panels: document.panels.length,
}, null, 2));
