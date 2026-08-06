'use strict';

const hookPlanOutput = require('./hook-plan-output');

const FINE_TUNED_MODE = 'fine-tuned';
const STANDARD_MODE = 'standard';
const STANDARD_SOURCE_CUTOFF_PERCENTILE = 90;

function normalizeMode(value) {
    return value === STANDARD_MODE ? STANDARD_MODE : FINE_TUNED_MODE;
}

function sourceMetricForCoordinate(coordinateId) {
    const id = String(coordinateId || '');
    if (id.endsWith('.ret5')) return 'together_ret5_geometry';
    if (id.endsWith('.views')) return 'together_views_geometry';
    if (id.endsWith('.gt10M')) return 'together_gt10m_geometry';
    return 'together_keep_geometry';
}

function publicDescriptor(mode, standardModel) {
    const normalized = normalizeMode(mode);
    if (normalized === STANDARD_MODE) {
        return Object.freeze({
            mode: STANDARD_MODE,
            label: 'Standard exploration model',
            provider: 'openai',
            model: String(standardModel || 'gpt-4o'),
            sourceRole:
                'frozen_embedding_retrieval_generation_inspiration_only',
        });
    }
    return Object.freeze({
        mode: FINE_TUNED_MODE,
        label: 'Fine-tuned hook model',
        provider: 'replicate',
        model: 'idea_r7',
        sourceRole: null,
    });
}

function standardMessages({ generationPrompt, count, invent } = {}) {
    const requestedCount = Math.max(
        1,
        Math.min(8, Number.parseInt(count, 10) || 1)
    );
    const system = [
        'You are the standard exploratory hook planner for a short-form video system.',
        'You are not the fine-tuned planner. Explore deliberately instead of converging on one familiar sentence pattern.',
        'The user message contains an immutable video idea, a measured directional-search assignment, prior candidates to avoid, and sometimes retrieved high-scoring corpus evidence.',
        'Preserve every fact of the immutable video idea. Change only how the opening reveals and visually sequences those facts.',
        'Retrieved examples are descriptive inspiration only. Abstract information order, visual action, tension, contrast, reveal timing, camera logic, and escalation. Never copy their subject, wording, people, objects, claims, or outcomes.',
        `Return exactly ${requestedCount} materially distinct hook plans. Each plan must contain a concise premise describing its opening treatment and exactly five chronological visual frames.`,
        'Every frame must advance the same opening and add visible information. Avoid generic hype, decorative cutaways, title cards, and unrelated stakes.',
        'Return JSON only in this shape: {"hooks":[{"premise":"...","reasoning":"...","frames":["...","...","...","...","..."]}]}.',
        'Do not include markdown or hidden reasoning. The reasoning field should be one short, observable design rationale.',
    ].join('\n');
    const user = [
        String(generationPrompt || '').trim(),
        invent
            ? 'No immutable realm was supplied. Invent one coherent, filmable realm, then keep all five beats inside it.'
            : 'The immutable realm is supplied above. Do not change it.',
        `Produce exactly ${requestedCount} plans now. Make sibling plans differ in concrete visual event and information order, not merely synonyms.`,
    ].filter(Boolean).join('\n\n').slice(0, 11500);
    return Object.freeze([
        Object.freeze({ role: 'system', content: system }),
        Object.freeze({ role: 'user', content: user }),
    ]);
}

function parseStandardPlans(rawOutput, {
    fallbackPremise,
    count,
} = {}) {
    return hookPlanOutput.parseHookPlans(rawOutput, {
        fallbackPremise,
        limit: count,
    }).slice(0, Math.max(1, Number.parseInt(count, 10) || 1)).map(plan => ({
        ...plan,
        treatment_source: 'standard_exploratory_json',
    }));
}

module.exports = Object.freeze({
    FINE_TUNED_MODE,
    STANDARD_MODE,
    STANDARD_SOURCE_CUTOFF_PERCENTILE,
    normalizeMode,
    sourceMetricForCoordinate,
    publicDescriptor,
    standardMessages,
    parseStandardPlans,
});
