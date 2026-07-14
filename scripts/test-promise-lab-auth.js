#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { routeBuilding, permsAllow } = require('../auth');

const summary = '/api/longquant/promise-lab/opening-20s';
const detail = '/api/longquant/promise-lab/opening-20s/example-video';
const jarvisProfile = { buildings: ['Jarvis'], features: {} };
const workshopOnly = { buildings: ['Workshop'], features: {} };

assert.strictEqual(routeBuilding(summary), 'Jarvis');
assert.strictEqual(routeBuilding(detail), 'Jarvis');
assert.strictEqual(permsAllow(jarvisProfile, summary, 'GET'), true);
assert.strictEqual(permsAllow(jarvisProfile, detail, 'GET'), true);
assert.strictEqual(permsAllow(workshopOnly, summary, 'GET'), false);

console.log('Promise Lab auth mapping: pass');
