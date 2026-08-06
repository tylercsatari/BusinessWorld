'use strict';

const retentionTable = require('./retention-study/retention_table.json');
const measuredOpeningExamples = require('./measured-opening-examples.json');

const CONTRACT_SCHEMA = 'shorts-opening-transcript-writer-v2';
const DEFAULT_EXAMPLE_COUNT = 12;
const MEASURED_WINDOW_SECONDS = 5;
const WORD_BUDGET_MARGIN = 1.5;

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

function cadenceProfile(population = sourcePopulation()) {
    const measured = (Array.isArray(population) ? population : []).map(
        record => ({
            wordCount: words(record && record.transcript).length,
            seconds: finite(record && record.measuredWindowSeconds),
        })
    ).filter(record => (
        record.wordCount > 0
        && record.seconds > 0
    ));
    const sourceCount = measured.length;
    const totalWords = measured.reduce(
        (sum, record) => sum + record.wordCount,
        0
    );
    const totalSeconds = measured.reduce(
        (sum, record) => sum + record.seconds,
        0
    );
    const averageWordsPerSecond = totalSeconds > 0
        ? totalWords / totalSeconds
        : 0;
    const averageWordsPerWindow =
        averageWordsPerSecond * MEASURED_WINDOW_SECONDS;
    const hardWordCap = Math.max(
        1,
        Math.ceil(averageWordsPerWindow * WORD_BUDGET_MARGIN)
    );
    return Object.freeze({
        sourceCount,
        measuredWindowSeconds: MEASURED_WINDOW_SECONDS,
        averageWordsPerSecond,
        averageWordsPerWindow,
        marginMultiplier: WORD_BUDGET_MARGIN,
        hardWordCap,
    });
}

function capTranscriptWords(value, maximum) {
    const tokens = words(value);
    const hardCap = Math.max(1, Math.floor(Number(maximum) || 1));
    const kept = tokens.slice(0, hardCap);
    return Object.freeze({
        transcript: kept.join(' '),
        originalWordCount: tokens.length,
        wordCount: kept.length,
        wasTruncated: tokens.length > hardCap,
    });
}

function buildMessages({
    videoIdea,
    hookTreatment,
    panels,
    examples,
    population,
} = {}) {
    const evidence = (examples || []).map((example, index) => (
        `EXAMPLE ${index + 1}: ${cleanText(example.transcript, 500)}`
    )).join('\n');
    const range = observedWordRange(examples);
    const cadence = cadenceProfile(population || sourcePopulation());
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
                `The spoken opening must contain no more than ${cadence.hardWordCap} words. This is a hard limit derived from ${cadence.sourceCount} measured channel openings, not a suggestion.`,
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
                    : `The selected examples contain ${range.minimum}-${range.maximum} spoken words in their first five seconds (median ${range.median}).`,
                `CHANNEL CADENCE: ${cadence.sourceCount} measured openings average ${cadence.averageWordsPerWindow.toFixed(2)} words in five seconds (${cadence.averageWordsPerSecond.toFixed(2)} words/second). HARD MAXIMUM: ${cadence.hardWordCap} spoken words, including the ${Math.round((cadence.marginMultiplier - 1) * 100)}% margin. Shorter is allowed. Never exceed it.`,
                'REAL HIGH-KEEP TYLER OPENINGS, FIRST FIVE MEASURED SECONDS:',
                evidence,
            ].filter(Boolean).join('\n\n'),
        },
    ];
}

function parseResult(value, options = {}) {
    const result = value && typeof value === 'object' ? value : {};
    const cadence = options.cadence
        || cadenceProfile(options.population || sourcePopulation());
    const capped = capTranscriptWords(
        cleanText(result.transcript, 2000),
        cadence.hardWordCap
    );
    if (!capped.transcript) {
        const error = new Error('transcript writer returned no spoken opening');
        error.code = 'SHORTS_TRANSCRIPT_OUTPUT_INVALID';
        throw error;
    }
    const alignment = !capped.wasTruncated
        && Array.isArray(result.beat_alignment)
        ? result.beat_alignment.map(item => cleanText(item, 300)).slice(0, 5)
        : [];
    while (alignment.length < 5) alignment.push('');
    return {
        transcript: capped.transcript,
        beatAlignment: alignment,
        wordCount: capped.wordCount,
        originalWordCount: capped.originalWordCount,
        wasTruncated: capped.wasTruncated,
        wordBudget: cadence,
    };
}

module.exports = Object.freeze({
    CONTRACT_SCHEMA,
    DEFAULT_EXAMPLE_COUNT,
    MEASURED_WINDOW_SECONDS,
    WORD_BUDGET_MARGIN,
    buildMessages,
    cadenceProfile,
    capTranscriptWords,
    cleanText,
    measuredEvidenceSchema:
        measuredOpeningExamples.schema,
    observedWordRange,
    parseResult,
    sourceExamples,
    sourcePopulation,
});
