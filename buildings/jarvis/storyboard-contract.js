'use strict';

const {
    canonicalJsonBytes,
    exactSha256,
    sha256Bytes,
} = require('./canonical-json-artifact');
const shortsScoreLedger = require('./shorts-score-ledger');
const storyboardStylePresets = require('./storyboard-style-presets');

const SCHEMA = 'shorts-storyboard-document-v1';
const INDEX_SCHEMA = 'shorts-storyboard-index-v1';
const PANEL_COUNT = 5;
const ID_PATTERN = /^sb[a-z0-9]{10,40}$/;
const MEDIA_URL_PATTERN =
    /^\/api\/storyboards\/media\/([a-f0-9]{64})\.(jpg|png|webp)$/;
const SCORE_INPUT_SCHEMA = 'shorts-storyboard-score-input-v2';

function cleanText(value, maxLength) {
    return String(value == null ? '' : value)
        .replace(/\u0000/g, '')
        .slice(0, maxLength);
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function jsonClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizedText(value) {
    return String(value == null ? '' : value)
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanSourcePanels(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(Number)
        .filter(index => Number.isInteger(index)
            && index >= 0
            && index < PANEL_COUNT))]
        .sort((left, right) => left - right);
}

function cleanStrokes(value) {
    return (Array.isArray(value) ? value : [])
        .slice(-200)
        .map(stroke => ({
            tool: stroke && stroke.tool === 'eraser' ? 'eraser' : 'pen',
            color: /^#[a-f0-9]{6}$/i.test(String(stroke && stroke.color || ''))
                ? String(stroke.color).toLowerCase()
                : '#ff3b30',
            size: Math.max(1, Math.min(
                64,
                finiteNumber(stroke && stroke.size, 7)
            )),
            points: (Array.isArray(stroke && stroke.points)
                ? stroke.points
                : [])
                .slice(0, 2000)
                .map(point => [
                    Math.max(0, Math.min(320, finiteNumber(point && point[0]))),
                    Math.max(0, Math.min(569, finiteNumber(point && point[1]))),
                ]),
        }))
        .filter(stroke => stroke.points.length);
}

function cleanMedia(media) {
    if (!media) return null;
    const url = cleanText(
        typeof media === 'string' ? media : media.url,
        180
    );
    const match = url.match(MEDIA_URL_PATTERN);
    if (!match) return null;
    const sha256 = match[1];
    const extension = match[2];
    const mediaType = extension === 'png'
        ? 'image/png'
        : extension === 'webp'
            ? 'image/webp'
            : 'image/jpeg';
    const byteLength = finiteNumber(
        typeof media === 'object' && media.byte_length,
        0
    );
    return {
        schema: 'shorts-storyboard-media-v1',
        url,
        key: `raw/storyboards/v1/media/by-sha256/${sha256}.${extension}`,
        sha256,
        byte_length: Math.max(0, Math.floor(byteLength)),
        media_type: mediaType,
    };
}

function cleanRevision(value) {
    if (!value || typeof value !== 'object') return null;
    const media = cleanMedia(value.media || value.image);
    if (!media) return null;
    return {
        media,
        source: cleanText(value.source || 'revision', 48),
        relation: ['new', 'edit', 'compose'].includes(value.relation)
            ? value.relation
            : 'new',
        sourcePanels: cleanSourcePanels(value.sourcePanels),
        prompt: cleanText(value.prompt, 1800),
        at: Math.max(0, finiteNumber(value.at, 0)),
    };
}

function cleanPanel(value, index) {
    const panel = value && typeof value === 'object' ? value : {};
    const cleaned = {
        id: cleanText(panel.id || `panel-${index + 1}`, 64),
        prompt: cleanText(panel.prompt, 1800),
        media: cleanMedia(panel.media || panel.image),
        source: cleanText(panel.source || 'empty', 48),
        relation: ['new', 'edit', 'compose'].includes(panel.relation)
            ? panel.relation
            : 'new',
        sourcePanels: cleanSourcePanels(panel.sourcePanels),
        revisions: (Array.isArray(panel.revisions)
            ? panel.revisions
            : [])
            .slice(-12)
            .map(cleanRevision)
            .filter(Boolean),
        strokes: cleanStrokes(panel.strokes),
    };
    if (Array.isArray(panel.contextPanels)) {
        cleaned.contextPanels = cleanSourcePanels(
            panel.contextPanels
        ).filter(panelIndex => panelIndex !== index);
    }
    return cleaned;
}

function cleanReference(value) {
    if (!value || typeof value !== 'object') return null;
    const media = cleanMedia(value.media || value.image);
    if (!media) return null;
    return {
        id: cleanText(value.id || '', 64),
        name: cleanText(value.name || 'Reference', 80),
        media,
        global: value.global !== false,
        panels: cleanSourcePanels(value.panels),
    };
}

function cleanTranscriptProvenance(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return {
        schema: cleanText(value.schema, 80),
        provider: cleanText(value.provider, 40),
        model: cleanText(value.model, 80) || null,
        provider_call_count: Math.max(
            0,
            Math.floor(finiteNumber(value.provider_call_count, 0))
        ),
        source_population_count: Math.max(
            0,
            Math.floor(finiteNumber(value.source_population_count, 0))
        ),
        example_count: Math.max(
            0,
            Math.floor(finiteNumber(value.example_count, 0))
        ),
        example_selection:
            cleanText(value.example_selection, 300) || null,
        source_join: cleanText(value.source_join, 300) || null,
        source_window: cleanText(value.source_window, 300) || null,
        examples: (Array.isArray(value.examples) ? value.examples : [])
            .slice(0, 24)
            .map(example => ({
                video_id: cleanText(example && example.video_id, 32),
                actual_keep_rate_percent: finiteNumber(
                    example && example.actual_keep_rate_percent,
                    0
                ),
                measured_window_seconds: Math.max(
                    0,
                    finiteNumber(
                        example && example.measured_window_seconds,
                        0
                    )
                ),
                transcript: cleanText(
                    example && example.transcript,
                    500
                ),
                transcript_source:
                    cleanText(
                        example && example.transcript_source,
                        80
                    ) || null,
            }))
            .filter(example => example.video_id && example.transcript),
        examples_sha256:
            exactSha256(value.examples_sha256)
                ? value.examples_sha256
                : null,
        structural_examples_only:
            value.structural_examples_only === true,
        scoring_text_input: value.scoring_text_input === true,
    };
}

function bindScoreInput(value) {
    const panelMediaSha256s = Array.isArray(
        value && value.panel_media_sha256s
    )
        ? value.panel_media_sha256s.slice()
        : [];
    if (
        !exactSha256(value && value.montage_sha256)
        || panelMediaSha256s.length !== PANEL_COUNT
        || panelMediaSha256s.some(sha256 => !exactSha256(sha256))
        || !exactSha256(value && value.score_ledger_sha256)
        || !exactSha256(value && value.score_record_sha256)
        || !exactSha256(value && value.output_fingerprint)
        || !exactSha256(value && value.scorer_revision_fingerprint)
    ) {
        throw new Error(
            'storyboard score input must bind its montage, five panels, '
                + 'ledger, score record, and scorer output'
        );
    }
    const payload = {
        schema: SCORE_INPUT_SCHEMA,
        montage_sha256: value.montage_sha256,
        panel_media_sha256s: panelMediaSha256s,
        hook_text_sha256: sha256Bytes(Buffer.from(
            normalizedText(value.hookText),
            'utf8'
        )),
        score_input_fingerprint:
            exactSha256(value.score_input_fingerprint)
                ? value.score_input_fingerprint
                : null,
        score_ledger_sha256: value.score_ledger_sha256,
        score_record_sha256: value.score_record_sha256,
        output_fingerprint: value.output_fingerprint,
        scorer_revision_fingerprint:
            value.scorer_revision_fingerprint,
    };
    return {
        ...payload,
        binding_sha256: sha256Bytes(canonicalJsonBytes(payload)),
    };
}

function validateScoreInput(value, expected = {}) {
    const errors = [];
    if (
        !value
        || value.schema !== SCORE_INPUT_SCHEMA
        || !exactSha256(value.binding_sha256)
    ) {
        return {
            valid: false,
            errors: ['storyboard score input binding is missing'],
        };
    }
    let rebound = null;
    try {
        rebound = bindScoreInput({
            ...value,
            hookText:
                expected.hookText !== undefined
                    ? expected.hookText
                    : '',
        });
    } catch (error) {
        errors.push(error.message);
    }
    if (rebound) {
        if (rebound.hook_text_sha256 !== value.hook_text_sha256) {
            errors.push('storyboard score text binding differs');
        }
        if (rebound.binding_sha256 !== value.binding_sha256) {
            errors.push('storyboard score input binding differs');
        }
    }
    if (
        expected.montageSha256
        && value.montage_sha256 !== expected.montageSha256
    ) {
        errors.push('storyboard score montage differs');
    }
    if (expected.panelMediaSha256s) {
        const actual = JSON.stringify(value.panel_media_sha256s || []);
        const wanted = JSON.stringify(expected.panelMediaSha256s);
        if (actual !== wanted) {
            errors.push('storyboard score panels differ');
        }
    }
    [
        ['scoreLedgerSha256', 'score_ledger_sha256', 'ledger'],
        ['scoreRecordSha256', 'score_record_sha256', 'score record'],
        ['outputFingerprint', 'output_fingerprint', 'scorer output'],
        [
            'scorerRevisionFingerprint',
            'scorer_revision_fingerprint',
            'scorer revision',
        ],
    ].forEach(([expectedKey, actualKey, label]) => {
        if (
            expected[expectedKey]
            && value[actualKey] !== expected[expectedKey]
        ) {
            errors.push(`storyboard score ${label} differs`);
        }
    });
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function cleanScore(value) {
    if (!value || typeof value !== 'object' || !value.score_ledger) {
        return null;
    }
    const validation = shortsScoreLedger.validateScoreLedger(
        value.score_ledger
    );
    if (!validation.valid) {
        throw new Error(
            'storyboard score ledger is invalid: '
                + validation.errors.join('; ')
        );
    }
    const calculatedScoreRecordSha256 =
        shortsScoreLedger.scoreRecordBindingSha256(value);
    if (
        !exactSha256(value.score_record_sha256)
        || value.score_record_sha256 !== calculatedScoreRecordSha256
    ) {
        throw new Error(
            'storyboard score record does not match its canonical evidence'
        );
    }
    const scoreMontage = cleanMedia(
        value.score_montage || value.scoreMontage
    );
    if (!scoreMontage) {
        throw new Error(
            'storyboard score must include its exact canonical montage'
        );
    }
    const scoreInput = value.score_input
        && typeof value.score_input === 'object'
        ? jsonClone(value.score_input)
        : null;
    const scoreInputValidation = validateScoreInput(
        scoreInput,
        {
            hookText: value.text || value.transcript || '',
            montageSha256: scoreMontage.sha256,
            panelMediaSha256s:
                scoreInput && scoreInput.panel_media_sha256s,
            scoreLedgerSha256: value.score_ledger.ledger_sha256,
            scoreRecordSha256: value.score_record_sha256,
            outputFingerprint:
                value.input_manifest
                && value.input_manifest.output_fingerprint,
            scorerRevisionFingerprint:
                value.input_manifest
                && value.input_manifest.revision_fingerprint,
        }
    );
    if (!scoreInputValidation.valid) {
        throw new Error(scoreInputValidation.errors.join('; '));
    }
    const durationValue = value.duration_s !== undefined
        ? value.duration_s
        : value.dur_s;
    return {
        title: cleanText(value.title || '', 140),
        text: cleanText(
            value.text !== undefined
                ? value.text
                : value.transcript,
            2000
        ),
        duration_s:
            durationValue !== null
            && durationValue !== ''
            && Number.isFinite(Number(durationValue))
                ? Number(durationValue)
                : null,
        score_ledger: value.score_ledger,
        score_ledger_validation:
            jsonClone(value.score_ledger_validation) || null,
        score_record_sha256:
            exactSha256(value.score_record_sha256)
                ? value.score_record_sha256
                : null,
        input_manifest:
            value.input_manifest
            && typeof value.input_manifest === 'object'
                ? jsonClone(value.input_manifest)
                : null,
        score_montage: scoreMontage,
        score_input: scoreInput,
        indicators:
            value.indicators && typeof value.indicators === 'object'
                ? jsonClone(value.indicators)
                : null,
        novelty_provenance:
            value.novelty_provenance
            && typeof value.novelty_provenance === 'object'
                ? jsonClone(value.novelty_provenance)
                : null,
        channels:
            value.channels && typeof value.channels === 'object'
                ? jsonClone(value.channels)
                : null,
        emb_preview:
            value.emb_preview && typeof value.emb_preview === 'object'
                ? jsonClone(value.emb_preview)
                : null,
        visual_keep_forecast:
            value.visual_keep_forecast
            && typeof value.visual_keep_forecast === 'object'
                ? jsonClone(value.visual_keep_forecast)
                : null,
        creator_adaptive_keep_forecast:
            value.creator_adaptive_keep_forecast
            && typeof value.creator_adaptive_keep_forecast === 'object'
                ? jsonClone(value.creator_adaptive_keep_forecast)
                : null,
        creator_adaptive_keep_forecast_error:
            cleanText(
                value.creator_adaptive_keep_forecast_error,
                500
            ) || null,
    };
}

function documentRevisionPayload(document) {
    const payload = { ...document };
    delete payload.revision;
    return payload;
}

function bindDocument(value) {
    const stylePreset = storyboardStylePresets.normalizeStylePreset(
        value.stylePreset
    );
    const document = {
        schema: SCHEMA,
        version: 1,
        id: cleanText(value.id, 42),
        parentRevision:
            exactSha256(value.parentRevision)
                ? value.parentRevision
                : null,
        name: cleanText(value.name || 'Untitled opening', 80),
        brief: cleanText(value.brief, 8000),
        hookText: cleanText(value.hookText, 2000),
        model: cleanText(value.model || 'flux-2-pro', 48),
        generationMode:
            value.generationMode === 'directed'
                ? 'directed'
                : 'composite',
        ...(stylePreset !== storyboardStylePresets.DEFAULT_STYLE_ID
            ? { stylePreset }
            : {}),
        selectedPanel: Math.max(
            0,
            Math.min(PANEL_COUNT - 1, Math.floor(
                finiteNumber(value.selectedPanel, 0)
            ))
        ),
        composite: cleanMedia(value.composite),
        references: (Array.isArray(value.references)
            ? value.references
            : [])
            .slice(0, 8)
            .map(cleanReference)
            .filter(Boolean),
        panels: Array.from(
            { length: PANEL_COUNT },
            (_, index) => cleanPanel(
                value.panels && value.panels[index],
                index
            )
        ),
        score: cleanScore(value.score),
        savedHookId: cleanText(value.savedHookId, 64) || null,
        complete: false,
        createdAt: Math.max(0, finiteNumber(value.createdAt, Date.now())),
        updatedAt: Math.max(0, finiteNumber(value.updatedAt, Date.now())),
    };
    if (Array.isArray(value.transcriptBeatAlignment)) {
        document.transcriptBeatAlignment = Array.from(
            { length: PANEL_COUNT },
            (_, index) => cleanText(
                value.transcriptBeatAlignment[index],
                300
            )
        );
    }
    const transcriptProvenance = cleanTranscriptProvenance(
        value.transcriptProvenance
    );
    if (transcriptProvenance) {
        document.transcriptProvenance = transcriptProvenance;
    }
    if (!ID_PATTERN.test(document.id)) {
        throw new Error('storyboard id is invalid');
    }
    document.complete = document.panels.every(panel => !!panel.media);
    document.revision = sha256Bytes(
        canonicalJsonBytes(documentRevisionPayload(document))
    );
    return document;
}

function validateDocument(value) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { valid: false, errors: ['document must be an object'] };
    }
    if (value.schema !== SCHEMA || value.version !== 1) {
        errors.push('document schema/version');
    }
    if (!ID_PATTERN.test(String(value.id || ''))) {
        errors.push('document id');
    }
    if (!Array.isArray(value.panels)
        || value.panels.length !== PANEL_COUNT) {
        errors.push('document must have exactly five panels');
    }
    const expectedComplete = (
        Array.isArray(value.panels)
        && value.panels.length === PANEL_COUNT
        && value.panels.every(panel => !!cleanMedia(
            panel && (panel.media || panel.image)
        ))
    );
    if (value.complete !== expectedComplete) {
        errors.push('document complete state');
    }
    if (!exactSha256(value.revision)) {
        errors.push('document revision');
    } else if (
        value.revision
        !== sha256Bytes(canonicalJsonBytes(documentRevisionPayload(value)))
    ) {
        errors.push('document revision binding');
    }
    if (value.score) {
        const validation = shortsScoreLedger.validateScoreLedger(
            value.score.score_ledger
        );
        if (!validation.valid) errors.push('document score ledger');
        const scoreInputValidation = validateScoreInput(
            value.score.score_input,
            {
                hookText: value.hookText,
                montageSha256:
                    value.score.score_montage
                    && value.score.score_montage.sha256,
                panelMediaSha256s: Array.isArray(value.panels)
                    ? value.panels.map(panel => (
                        panel
                        && panel.media
                        && panel.media.sha256
                    ))
                    : [],
                scoreLedgerSha256:
                    value.score.score_ledger
                    && value.score.score_ledger.ledger_sha256,
                scoreRecordSha256:
                    value.score.score_record_sha256,
                outputFingerprint:
                    value.score.input_manifest
                    && value.score.input_manifest.output_fingerprint,
                scorerRevisionFingerprint:
                    value.score.input_manifest
                    && value.score.input_manifest.revision_fingerprint,
            }
        );
        if (!scoreInputValidation.valid) {
            errors.push(...scoreInputValidation.errors);
        }
    }
    try {
        const canonical = bindDocument(value);
        if (
            !canonicalJsonBytes(canonical).equals(
                canonicalJsonBytes(value)
            )
        ) {
            errors.push('document canonical shape');
        }
    } catch (error) {
        errors.push(`document canonicalization: ${error.message}`);
    }
    return { valid: errors.length === 0, errors };
}

function compactDocument(value) {
    return {
        id: value.id,
        revision: value.revision,
        name: value.name,
        model: value.model,
        generationMode: value.generationMode,
        complete: value.complete,
        scored: !!value.score,
        scoreLedgerSha256:
            value.score
            && value.score.score_ledger
            && value.score.score_ledger.ledger_sha256
            || null,
        savedHookId: value.savedHookId || null,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

function cleanCompactDocument(value) {
    const row = value && typeof value === 'object' ? value : {};
    return {
        id: cleanText(row.id, 42),
        revision: exactSha256(row.revision) ? row.revision : null,
        name: cleanText(row.name || 'Untitled opening', 80),
        model: cleanText(row.model || 'flux-2-pro', 48),
        generationMode:
            row.generationMode === 'directed'
                ? 'directed'
                : 'composite',
        complete: row.complete === true,
        scored: row.scored === true,
        scoreLedgerSha256:
            exactSha256(row.scoreLedgerSha256)
                ? row.scoreLedgerSha256
                : null,
        savedHookId: cleanText(row.savedHookId, 64) || null,
        createdAt: Math.max(0, finiteNumber(row.createdAt, 0)),
        updatedAt: Math.max(0, finiteNumber(row.updatedAt, 0)),
    };
}

function bindIndex(value) {
    const rows = (Array.isArray(value && value.storyboards)
        ? value.storyboards
        : [])
        .map(cleanCompactDocument)
        .filter(row => ID_PATTERN.test(row.id))
        .sort((left, right) => (
            Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
        ));
    return {
        schema: INDEX_SCHEMA,
        version: 1,
        updatedAt: Math.max(0, finiteNumber(
            value && value.updatedAt,
            Date.now()
        )),
        storyboards: rows,
    };
}

function validateIndex(value) {
    const errors = [];
    if (!value || value.schema !== INDEX_SCHEMA || value.version !== 1) {
        errors.push('index schema/version');
    }
    if (!Array.isArray(value && value.storyboards)) {
        errors.push('index storyboards');
    } else {
        const ids = value.storyboards.map(row => row && row.id);
        if (new Set(ids).size !== ids.length) {
            errors.push('index storyboard ids must be unique');
        }
        if (ids.some(id => !ID_PATTERN.test(String(id || '')))) {
            errors.push('index storyboard id');
        }
        value.storyboards.forEach((row, index) => {
            const canonical = cleanCompactDocument(row);
            if (
                !exactSha256(canonical.revision)
                || typeof row.name !== 'string'
                || typeof row.model !== 'string'
                || !['composite', 'directed'].includes(
                    row.generationMode
                )
                || typeof row.complete !== 'boolean'
                || typeof row.scored !== 'boolean'
                || (
                    row.scored
                    && !exactSha256(row.scoreLedgerSha256)
                )
                || (
                    !row.scored
                    && row.scoreLedgerSha256 !== null
                )
                || !Number.isFinite(Number(row.createdAt))
                || !Number.isFinite(Number(row.updatedAt))
                || Number(row.createdAt) < 0
                || Number(row.updatedAt) < 0
                || !canonicalJsonBytes(canonical).equals(
                    canonicalJsonBytes(row)
                )
            ) {
                errors.push(`index storyboard row ${index + 1}`);
            }
            if (
                index > 0
                && Number(value.storyboards[index - 1].updatedAt)
                    < Number(row.updatedAt)
            ) {
                errors.push('index storyboards must be newest first');
            }
        });
    }
    return { valid: errors.length === 0, errors };
}

module.exports = Object.freeze({
    ID_PATTERN,
    INDEX_SCHEMA,
    MEDIA_URL_PATTERN,
    PANEL_COUNT,
    SCHEMA,
    SCORE_INPUT_SCHEMA,
    bindDocument,
    bindIndex,
    bindScoreInput,
    cleanMedia,
    compactDocument,
    documentRevisionPayload,
    validateDocument,
    validateIndex,
    validateScoreInput,
});
