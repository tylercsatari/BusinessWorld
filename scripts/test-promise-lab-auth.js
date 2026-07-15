#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { routeBuilding, permsAllow } = require('../auth');

const summary = '/api/shortsquant/promise-lab/opening-predictions';
const detail = '/api/shortsquant/promise-lab/opening-prediction/example-video';
const pooledSummary = `${summary}?scope=all`;
const pooledDetail = `${detail}?scope=all`;
const jarvisProfile = { buildings: ['Jarvis'], features: {} };
const workshopOnly = { buildings: ['Workshop'], features: {} };

assert.strictEqual(routeBuilding(summary), 'Jarvis');
assert.strictEqual(routeBuilding(detail), 'Jarvis');
assert.strictEqual(routeBuilding(pooledSummary), 'Jarvis');
assert.strictEqual(routeBuilding(pooledDetail), 'Jarvis');
assert.strictEqual(permsAllow(jarvisProfile, summary, 'GET'), true);
assert.strictEqual(permsAllow(jarvisProfile, detail, 'GET'), true);
assert.strictEqual(permsAllow(jarvisProfile, pooledSummary, 'GET'), true);
assert.strictEqual(permsAllow(jarvisProfile, pooledDetail, 'GET'), true);
assert.strictEqual(permsAllow(workshopOnly, summary, 'GET'), false);

console.log('Promise Lab auth mapping: pass');
