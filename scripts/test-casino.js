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
const server = read('server.js');

assert(index.includes('buildings/casino/casino.css'), 'Casino stylesheet is not loaded');
assert(index.includes('buildings/casino/casino-ui.js'), 'Casino UI module is not loaded');
assert(index.includes("makeClickable(g, 'Casino')"), 'Casino is not clickable in the 3D world');
assert(index.includes("'Casino': casino"), 'Casino is absent from the persistent building lookup');
assert(index.includes("_mk(createCasino, 'casino')"), 'Casino is not created during world initialization');
assert(casinoUi.includes("BuildingRegistry.register('Casino'"), 'Casino is absent from BuildingRegistry');
assert(casinoUi.includes('https://app.gtobase.com/viewer?id=109&q=20#onePlayer-strategy'), 'Casino does not target the requested GTOBase chart');
assert(casinoUi.includes('rel="noopener noreferrer"'), 'External viewer link is missing opener protection');
assert(casinoUi.includes('title="GTOBase MTT 9-max 20bb poker strategy viewer"'), 'Embedded viewer needs an accessible title');
assert(authGate.includes("'Casino'"), 'Casino is absent from profile permissions');
assert(server.includes("'Casino'"), 'Casino is absent from server-side layout persistence');

console.log('Casino integration checks passed.');
