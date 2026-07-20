'use strict';

const CasinoAgent = (() => {
    const SOLVER_STACKS = Object.freeze({
        9: Object.freeze([30, 25, 20, 17, 15, 12.5, 10]),
        8: Object.freeze([40, 50, 75, 100])
    });

    function nearestStack(tableSize, stackBb) {
        const size = Number(tableSize) === 8 ? 8 : 9;
        const stack = Number(stackBb);
        const choices = SOLVER_STACKS[size];
        if (!Number.isFinite(stack) || stack <= 0) return choices[0];
        return choices.reduce((best, candidate) => {
            const candidateDistance = Math.abs(candidate - stack);
            const bestDistance = Math.abs(best - stack);
            return candidateDistance < bestDistance ||
                (candidateDistance === bestDistance && candidate < best)
                ? candidate : best;
        }, choices[0]);
    }

    function randomUnit() {
        if (window.crypto && window.crypto.getRandomValues) {
            const sample = new Uint32Array(1);
            window.crypto.getRandomValues(sample);
            return sample[0] / 4294967296;
        }
        return Math.random();
    }

    function normalizeActions(actions) {
        const cleaned = (Array.isArray(actions) ? actions : [])
            .map(item => ({
                action: String(item && item.action || '').trim(),
                frequency: Math.max(0, Number(item && item.frequency) || 0)
            }))
            .filter(item => item.action && item.frequency > 0);
        const total = cleaned.reduce((sum, item) => sum + item.frequency, 0);
        if (!total) return [];
        return cleaned.map(item => ({
            action: item.action,
            frequency: item.frequency / total
        }));
    }

    function chooseMixedAction(actions) {
        const normalized = normalizeActions(actions);
        if (!normalized.length) return null;
        const roll = randomUnit();
        let cursor = 0;
        for (const item of normalized) {
            cursor += item.frequency;
            if (roll < cursor) {
                return { action: item.action, roll, actions: normalized };
            }
        }
        return { action: normalized[normalized.length - 1].action, roll, actions: normalized };
    }

    function parseJson(content) {
        const raw = String(content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        try { return JSON.parse(raw); } catch (error) {
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
            throw error;
        }
    }

    function systemPrompt(state) {
        const size = Number(state.tableSize) === 8 ? 8 : 9;
        const solverStack = nearestStack(size, state.stackBb);
        return `You are a concise professional tournament poker coach on a live voice call.

This version is NOT connected to the paid GTOBase solver. Give a careful AI ESTIMATE based on strong no-limit hold'em tournament fundamentals. Never claim that an answer is an exact solver output or that you opened GTOBase.

CURRENT HAND:
- Hero hand: ${state.heroHand}
- Table: ${size}-max
- Hero actual stack: ${state.stackBb || 'not stated'} bb
- Closest configured reference stack: ${solverStack} bb
- Conversation/action history: ${(state.actionHistory || []).join(' | ') || 'none yet'}

Rules:
- Extract the latest action, positions, bet sizes, effective stack and street from the user's natural speech.
- Use the closest reference stack shown above. For 9-max the available stacks are 30, 25, 20, 17, 15, 12.5 and 10 bb. For 8-max they are 40, 50, 75 and 100 bb.
- If essential information is missing, ask exactly one short follow-up question and set needsMoreInfo=true. Do not invent unseen action.
- If enough information exists, give one short recommendation and a one-sentence reason.
- When a mixed strategy is plausible, provide action frequencies totaling approximately 1. Frequencies are decimals, e.g. 0.75.
- If the strategy is effectively pure, return one action at frequency 1.
- Keep spokenText under 45 words and natural to hear aloud.

Return ONLY valid JSON with this shape:
{"needsMoreInfo":false,"followUpQuestion":"","heroPosition":"MP","street":"preflop","actualStackBb":36,"solverStackBb":30,"recommendedAction":"fold","actions":[{"action":"fold","frequency":1}],"reason":"short reason","spokenText":"short voice response"}`;
    }

    async function run(userText, state) {
        const messages = [
            { role: 'system', content: systemPrompt(state) },
            ...(state.chatHistory || []).slice(-10),
            { role: 'user', content: userText }
        ];
        const response = await fetch('/api/openai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
                temperature: 0.1,
                max_tokens: 450,
                response_format: { type: 'json_object' }
            })
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Poker coach unavailable (${response.status}): ${detail.slice(0, 120)}`);
        }
        const payload = await response.json();
        const result = parseJson(payload.choices && payload.choices[0] && payload.choices[0].message.content);
        result.solverStackBb = nearestStack(state.tableSize, result.actualStackBb || state.stackBb);
        result.actions = normalizeActions(result.actions);
        if (!result.needsMoreInfo && result.actions.length) {
            const decision = chooseMixedAction(result.actions);
            result.selectedAction = decision.action;
            result.randomRoll = decision.roll;
            result.spokenText = `${result.spokenText || result.reason || ''} Your action this time: ${decision.action}.`.trim();
        }
        return result;
    }

    return { SOLVER_STACKS, nearestStack, chooseMixedAction, run };
})();

window.CasinoAgent = CasinoAgent;
