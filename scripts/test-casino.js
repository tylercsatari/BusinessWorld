#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const index = read('index.html');
const casinoUi = read('buildings/casino/casino-ui.js');
const authGate = read('auth-gate.js');
const auth = read('auth.js');
const server = read('server.js');

assert(index.includes('buildings/casino/casino.css'), 'Casino stylesheet is not loaded');
assert(!index.includes('buildings/casino/casino-agent.js'), 'Legacy estimate agent must not be loaded');
assert(index.includes('buildings/casino/casino-ui.js'), 'Casino UI module is not loaded');
assert(index.includes("makeClickable(g, 'Casino')"), 'Casino is not clickable in the 3D world');
assert(index.includes("'Casino': casino"), 'Casino is absent from the persistent building lookup');
assert(index.includes("_mk(createCasino, 'casino')"), 'Casino is not created during world initialization');
assert(casinoUi.includes("BuildingRegistry.register('Casino'"), 'Casino is absent from BuildingRegistry');
assert(casinoUi.includes('casinoGtoBaseSetupComplete'), 'Casino does not remember first-time GTOBase setup');
assert(casinoUi.includes('https://app.gtobase.com/viewer?id=109&q=20#onePlayer-strategy'), 'Casino setup does not open the requested GTOBase viewer');
assert(casinoUi.includes('casino-gtobase-login'), 'Casino is missing the first-time GTOBase login action');
assert(casinoUi.includes('rel="noopener noreferrer"'), 'GTOBase login handoff is missing opener protection');
assert(casinoUi.includes('casino-gtobase-frame'), 'Casino is missing the embedded GTOBase login panel');
assert(casinoUi.includes('scrolling="yes"'), 'Embedded GTOBase login does not allow scrolling');
assert(casinoUi.includes('casino-login-zoom'), 'Embedded GTOBase login is missing mobile zoom controls');
assert(casinoUi.includes('casino-hand-input'), 'Casino is missing mobile hole-card entry');
assert(casinoUi.includes('casino-answer'), 'Casino is missing the incoming call answer action');
assert(casinoUi.includes('casino-mic'), 'Casino is missing voice input');
assert(casinoUi.includes('/api/openai/transcribe'), 'Casino is not connected to transcription');
assert(casinoUi.includes('/api/openai/tts'), 'Casino is not connected to voice playback');
assert(casinoUi.includes('/api/casino/messages'), 'Casino is not connected to the shared coach channel');
assert(casinoUi.includes('data-casino-role="tyler"'), 'Casino is missing Tyler mode');
assert(casinoUi.includes('data-casino-role="operator"'), 'Casino is missing AI Robot mode');
assert(casinoUi.includes('casino-speaker-toggle'), 'Casino is missing the speaker/quiet control');
assert(casinoUi.includes('selectAudioOutput'), 'Casino does not offer supported private audio output selection');
assert(!casinoUi.includes('CasinoAgent.run'), 'Casino must not generate poker strategy estimates');
assert(!casinoUi.includes('await startRecording();'), 'Casino must request microphone permission from the direct mic tap, not after async work');
assert(casinoUi.includes('set Microphone to Allow'), 'Casino is missing mobile permission recovery guidance');
assert(casinoUi.includes('data:audio/wav;base64'), 'Casino does not unlock mobile audio from the Answer gesture');
assert((casinoUi.match(/<iframe/g) || []).length === 1, 'Casino should embed only the dedicated GTOBase login panel');
assert(!casinoUi.includes('type="password"'), 'Casino must not collect Google passwords');
assert(!casinoUi.toLowerCase().includes('tylerdaviscsatari'), 'Casino UI must not contain private login details');
assert(authGate.includes("'Casino'"), 'Casino is absent from profile permissions');
assert(server.includes("'Casino'"), 'Casino is absent from server-side layout persistence');
assert(auth.includes("return 'Casino'"), 'Casino message API is not permission-gated');
assert(server.includes("pathname === '/api/casino/messages' && req.method === 'GET'"), 'Casino message inbox route is missing');
assert(server.includes("pathname === '/api/casino/messages' && req.method === 'POST'"), 'Casino message send route is missing');
assert(server.includes('CASINO_CHAT_R2_KEY'), 'Casino messages are not persisted to R2');

console.log('Casino integration checks passed.');
