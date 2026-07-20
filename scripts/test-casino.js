#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const index = read('index.html');
const casinoUi = read('buildings/casino/casino-ui.js');
const casinoAgent = read('buildings/casino/casino-agent.js');
const authGate = read('auth-gate.js');
const server = read('server.js');

assert(index.includes('buildings/casino/casino.css'), 'Casino stylesheet is not loaded');
assert(index.includes('buildings/casino/casino-agent.js'), 'Casino agent module is not loaded');
assert(index.includes('buildings/casino/casino-ui.js'), 'Casino UI module is not loaded');
assert(index.includes("makeClickable(g, 'Casino')"), 'Casino is not clickable in the 3D world');
assert(index.includes("'Casino': casino"), 'Casino is absent from the persistent building lookup');
assert(index.includes("_mk(createCasino, 'casino')"), 'Casino is not created during world initialization');
assert(casinoUi.includes("BuildingRegistry.register('Casino'"), 'Casino is absent from BuildingRegistry');
assert(casinoUi.includes('casino-hand-input'), 'Casino is missing mobile hole-card entry');
assert(casinoUi.includes('casino-answer'), 'Casino is missing the incoming call answer action');
assert(casinoUi.includes('casino-mic'), 'Casino is missing voice input');
assert(casinoUi.includes('/api/openai/transcribe'), 'Casino is not connected to transcription');
assert(casinoUi.includes('/api/openai/tts'), 'Casino is not connected to voice playback');
assert(casinoAgent.includes('crypto.getRandomValues'), 'Mixed actions are not selected with secure randomness');
assert(casinoAgent.includes('9: Object.freeze([30, 25, 20, 17, 15, 12.5, 10])'), '9-max reference stacks are incomplete');
assert(casinoAgent.includes('8: Object.freeze([40, 50, 75, 100])'), '8-max reference stacks are incomplete');
assert(casinoAgent.includes('NOT connected to the paid GTOBase solver'), 'Approximate advice is not clearly constrained');
assert(!casinoUi.includes('<iframe'), 'Casino must not embed the third-party GTOBase login flow');
assert(!casinoUi.toLowerCase().includes('tylerdaviscsatari'), 'Casino UI must not contain private login details');
assert(!casinoAgent.toLowerCase().includes('tylerdaviscsatari'), 'Casino agent must not contain private login details');
assert(authGate.includes("'Casino'"), 'Casino is absent from profile permissions');
assert(server.includes("'Casino'"), 'Casino is absent from server-side layout persistence');

const agentContext = { window: { crypto: { getRandomValues(values) { values[0] = 0; return values; } } }, fetch: () => {} };
vm.createContext(agentContext);
vm.runInContext(casinoAgent, agentContext);
assert.strictEqual(agentContext.window.CasinoAgent.nearestStack(9, 36), 30, '9-max 36bb must use the 30bb reference');
assert.strictEqual(agentContext.window.CasinoAgent.nearestStack(9, 13.7), 12.5, '9-max nearest stack selection failed');
assert.strictEqual(agentContext.window.CasinoAgent.nearestStack(8, 36), 40, '8-max 36bb must use the 40bb reference');
assert.strictEqual(agentContext.window.CasinoAgent.chooseMixedAction([
    { action: 'raise', frequency: 0.25 },
    { action: 'fold', frequency: 0.75 }
]).action, 'raise', 'Mixed strategy RNG did not select by cumulative frequency');

console.log('Casino integration checks passed.');
