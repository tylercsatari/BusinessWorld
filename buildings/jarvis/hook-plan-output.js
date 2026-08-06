'use strict';

const FRAME_KEYS = Object.freeze([
    'frames',
    'panels',
    'beats',
    'shots',
    'scenes',
    'sequence',
    'visuals',
]);
const PLAN_KEYS = Object.freeze([
    'attempts',
    'ideas',
    'hooks',
    'candidates',
    'plans',
    'outputs',
    'results',
    'result',
    'data',
    'output',
    'prediction',
]);
const PREMISE_KEYS = Object.freeze([
    'premise',
    'hook',
    'hook_text',
    'hookText',
    'opening',
    'title',
    'idea',
    'concept',
    'summary',
]);
const FRAME_TEXT_KEYS = Object.freeze([
    'prompt',
    'description',
    'visual_description',
    'visualDescription',
    'visual',
    'scene',
    'shot',
    'beat',
    'frame',
    'text',
    'caption',
]);

function nonEmptyText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

function jsonValues(text) {
    const source = String(text || '').trim();
    if (!source) return [];
    const candidates = [source];
    const unfenced = source.replace(
        /^```(?:json|javascript|js)?\s*/i,
        ''
    ).replace(/\s*```$/, '').trim();
    if (unfenced && unfenced !== source) candidates.push(unfenced);
    const objectStart = source.indexOf('{');
    const objectEnd = source.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        candidates.push(source.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = source.indexOf('[');
    const arrayEnd = source.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        candidates.push(source.slice(arrayStart, arrayEnd + 1));
    }
    const parsed = [];
    const seen = new Set();
    candidates.forEach(candidate => {
        if (seen.has(candidate)) return;
        seen.add(candidate);
        try {
            const value = JSON.parse(candidate);
            if (value !== candidate) parsed.push(value);
        } catch (error) {}
    });
    return parsed;
}

function frameText(value) {
    const direct = nonEmptyText(value);
    if (direct) return direct;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return '';
    }
    for (const key of FRAME_TEXT_KEYS) {
        const text = nonEmptyText(value[key]);
        if (text) return text;
    }
    return '';
}

function looksLikeFrameValue(value) {
    if (nonEmptyText(value)) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    if (FRAME_KEYS.some(key => Array.isArray(value[key]))) return false;
    if (PREMISE_KEYS.some(key => nonEmptyText(value[key]))) return false;
    return !!frameText(value);
}

function planFrames(value) {
    if (!value || typeof value !== 'object') return [];
    for (const key of FRAME_KEYS) {
        if (!Array.isArray(value[key])) continue;
        const frames = value[key].map(frameText).filter(Boolean);
        if (frames.length >= 5) return frames.slice(0, 5);
    }
    const numbered = [];
    for (let index = 1; index <= 5; index += 1) {
        const keys = [
            `frame_${index}`,
            `frame${index}`,
            `panel_${index}`,
            `panel${index}`,
            `beat_${index}`,
            `beat${index}`,
        ];
        let text = '';
        for (const key of keys) {
            text = frameText(value[key]);
            if (text) break;
        }
        if (!text) return [];
        numbered.push(text);
    }
    return numbered;
}

function planPremise(value, fallbackPremise) {
    for (const key of PREMISE_KEYS) {
        const text = nonEmptyText(value && value[key]);
        if (text) return text;
    }
    return nonEmptyText(fallbackPremise);
}

function normalizedPlan(value, fallbackPremise) {
    if (Array.isArray(value)) {
        if (!value.every(looksLikeFrameValue)) return null;
        const frames = value.map(frameText).filter(Boolean);
        if (frames.length < 5) return null;
        return {
            premise: nonEmptyText(fallbackPremise),
            frames: frames.slice(0, 5),
            cohesion_mode: '',
            reasoning: '',
        };
    }
    if (!value || typeof value !== 'object') return null;
    const frames = planFrames(value);
    if (frames.length !== 5) return null;
    const premise = planPremise(value, fallbackPremise);
    if (!premise) return null;
    return {
        premise,
        frames,
        cohesion_mode: nonEmptyText(
            value.cohesion_mode || value.cohesionMode
        ),
        reasoning: nonEmptyText(
            value.reasoning || value.rationale || value.explanation
        ),
    };
}

function treatmentText(plan) {
    const frames = planFrames(plan);
    if (frames.length !== 5) return '';
    const cohesion = nonEmptyText(
        plan && (plan.cohesion_mode || plan.cohesionMode)
    );
    return [
        cohesion ? `Five-beat ${cohesion} opening.` : 'Five-beat opening.',
        ...frames.map((frame, index) => (
            `Beat ${index + 1}: ${frame.slice(0, 320)}`
        )),
    ].join(' ').slice(0, 2000);
}

function outputShape(value, depth = 0) {
    if (depth > 2) return '...';
    if (value == null) return String(value);
    if (typeof value === 'string') return `string(${value.length})`;
    if (Array.isArray(value)) {
        const first = value.length
            ? `>${outputShape(value[0], depth + 1)}`
            : '';
        return `array(${value.length})${first}`;
    }
    if (typeof value === 'object') {
        return `object(${Object.keys(value).slice(0, 8).join(',')})`;
    }
    return typeof value;
}

function parseHookPlans(rawOutput, options = {}) {
    const fallbackPremise = nonEmptyText(options.fallbackPremise);
    const limit = Math.max(
        1,
        Math.min(24, Number.parseInt(options.limit, 10) || 8)
    );
    const queue = [rawOutput];
    const visitedObjects = new Set();
    const visitedStrings = new Set();
    const plans = [];
    const planKeys = new Set();
    let inspected = 0;

    while (queue.length && plans.length < limit && inspected < 160) {
        const value = queue.shift();
        inspected += 1;
        if (typeof value === 'string') {
            if (visitedStrings.has(value)) continue;
            visitedStrings.add(value);
            jsonValues(value).forEach(parsed => queue.push(parsed));
            continue;
        }
        if (!value || typeof value !== 'object') continue;
        if (visitedObjects.has(value)) continue;
        visitedObjects.add(value);

        if (Array.isArray(value)) {
            let joinedValues = [];
            if (value.every(item => typeof item === 'string')) {
                joinedValues = [value.join(''), value.join('\n')]
                    .flatMap(jsonValues);
                joinedValues.forEach(parsed => queue.push(parsed));
            }
            if (!joinedValues.length) {
                const plan = normalizedPlan(value, fallbackPremise);
                if (plan) {
                    const key = JSON.stringify([
                        plan.premise,
                        plan.frames,
                    ]);
                    if (!planKeys.has(key)) {
                        planKeys.add(key);
                        plans.push(plan);
                    }
                }
            }
            value.forEach(item => queue.push(item));
            continue;
        }
        const plan = normalizedPlan(value, fallbackPremise);
        if (plan) {
            const key = JSON.stringify([plan.premise, plan.frames]);
            if (!planKeys.has(key)) {
                planKeys.add(key);
                plans.push(plan);
            }
        }
        PLAN_KEYS.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                queue.push(value[key]);
            }
        });
    }

    if (!plans.length) {
        const error = new Error(
            'fine-tuned hook model returned no valid five-frame plans '
            + `(output shape: ${outputShape(rawOutput)})`
        );
        error.code = 'HOOK_PLAN_OUTPUT_INVALID';
        throw error;
    }
    return plans;
}

module.exports = Object.freeze({
    parseHookPlans,
    outputShape,
    treatmentText,
});
