'use strict';

const retentionTable = require('./retention-study/retention_table.json');
const measuredOpeningExamples = require('./measured-opening-examples.json');

const CONTRACT_SCHEMA = 'shorts-opening-transcript-writer-v1';
const DEFAULT_EXAMPLE_COUNT = 12;

function cleanText(value, maximum = 4000) {
    return String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function words(value) {
    return cleanText(value).split(/\s+/).filter(Boolean);
}

function sourcePopulation() {
    const timedOpenings = new Map(
        (Array.isArray(measuredOpeningExamples.examples)
            ? measuredOpeningExamples.examples
            : [])
            .map(record => [
                String(record && record.video_id || ''),
                record,
            ])
    );
    const rows = Array.isArray(retentionTable && retentionTable.videos)
        ? retentionTable.videos
        : [];
    return rows.map(record => {
        const id = String(record && record.id || '');
        const timed = timedOpenings.get(id) || null;
        return {
            id,
            transcript: cleanText(timed && timed.transcript),
            transcriptSource:
                cleanText(timed && timed.transcript_source, 80),
            measuredWindowSeconds:
                finite(timed && timed.measured_window_seconds),
            keepRate: finite(record && record.keep_rate),
            views: Math.max(0, Math.round(finite(record && record.views) || 0)),
            durationSeconds: finite(record && record.duration_s),
        };
    }).filter(record => (
        record.id
        && record.transcript
        && record.measuredWindowSeconds === 5
        && record.keepRate != null
    )).sort((left, right) => (
        right.keepRate - left.keepRate
        || right.views - left.views
        || left.id.localeCompare(right.id)
    ));
}

function sourceExamples(limit = DEFAULT_EXAMPLE_COUNT) {
    return sourcePopulation().slice(
        0,
        Math.max(3, Math.min(24, Number(limit) || DEFAULT_EXAMPLE_COUNT))
    );
}

function observedWordRange(examples) {
    const counts = (examples || []).map(example => (
        words(example && example.transcript).length
    )).filter(count => count > 0).sort((left, right) => left - right);
    if (!counts.length) return { minimum: null, median: null, maximum: null };
    const middle = Math.floor(counts.length / 2);
    const median = counts.length % 2
        ? counts[middle]
        : Math.round((counts[middle - 1] + counts[middle]) / 2);
    return {
        minimum: counts[0],
        median,
        maximum: counts[counts.length - 1],
    };
}

function buildMessages({
    videoIdea,
    hookTreatment,
    panels,
    examples,
} = {}) {
    const evidence = (examples || []).map((example, index) => (
        `EXAMPLE ${index + 1}: ${cleanText(example.transcript, 500)}`
    )).join('\n');
    const range = observedWordRange(examples);
    const panelLines = Array.from({ length: 5 }, (_, index) => (
        `BEAT ${index + 1}: ${cleanText(
            panels && panels[index] || '',
            800
        ) || '(unspecified)'}`
    )).join('\n');
    return [
        {
            role: 'system',
            content: [
                'Write the spoken opening for one short-form video.',
                'The immutable video facts, selected hook treatment, and five visual beats are authoritative. Never add an object, event, result, danger, claim, or outcome that they do not support.',
                'The supplied real openings are structural evidence only. Learn their information density, cadence, sentence shape, and speed of establishing a concrete unresolved outcome. Do not copy their wording, subjects, objects, facts, or claims.',
                'Write natural spoken language, not a title, shot list, caption, screenplay direction, analytics explanation, or description of the images.',
                'The transcript must make sense from its first word, track the five beats in order, and preserve the exact video premise.',
                'Return only JSON with this shape: {"transcript":"...","beat_alignment":["...","...","...","...","..."]}. The beat_alignment entries briefly identify which transcript words align to each beat; they are metadata and must not add facts.',
            ].join(' '),
        },
        {
            role: 'user',
            content: [
                `IMMUTABLE VIDEO IDEA: ${cleanText(videoIdea, 1600) || '(invented opening)'}`,
                `SELECTED HOOK TREATMENT: ${cleanText(hookTreatment, 1600) || '(use the five visual beats)'}`,
                'ORDERED VISUAL BEATS:',
                panelLines,
                range.median == null
                    ? ''
                    : `The measured examples contain ${range.minimum}-${range.maximum} spoken words in their first five seconds (median ${range.median}). Use that observed range as a cadence reference, not a hard quota.`,
                'REAL HIGH-KEEP TYLER OPENINGS, FIRST FIVE MEASURED SECONDS:',
                evidence,
            ].filter(Boolean).join('\n\n'),
        },
    ];
}

function parseResult(value) {
    const result = value && typeof value === 'object' ? value : {};
    const transcript = cleanText(result.transcript, 2000);
    if (!transcript) {
        const error = new Error('transcript writer returned no spoken opening');
        error.code = 'SHORTS_TRANSCRIPT_OUTPUT_INVALID';
        throw error;
    }
    const alignment = Array.isArray(result.beat_alignment)
        ? result.beat_alignment.map(item => cleanText(item, 300)).slice(0, 5)
        : [];
    while (alignment.length < 5) alignment.push('');
    return { transcript, beatAlignment: alignment };
}

module.exports = Object.freeze({
    CONTRACT_SCHEMA,
    DEFAULT_EXAMPLE_COUNT,
    buildMessages,
    cleanText,
    measuredEvidenceSchema:
        measuredOpeningExamples.schema,
    observedWordRange,
    parseResult,
    sourceExamples,
    sourcePopulation,
});
