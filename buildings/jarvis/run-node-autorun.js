#!/usr/bin/env node
/**
 * Standalone Node.js AutoResearch runner.
 * Uses jarvis-runner.js (which reads jarvis-metrics.js) directly.
 * Usage: node run-node-autorun.js [maxIterations] [maxMinutes]
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const jarvisRunner = require('./jarvis-runner');

const maxIterations = parseInt(process.argv[2] || '2000');
const maxMinutes    = parseFloat(process.argv[3] || '25');
const preuploadRatio = parseFloat(process.argv[4] || '0.65');
const maxFailures   = parseInt(process.argv[5] || '500');

console.log(`[node-autorun] Starting: maxIter=${maxIterations} maxMin=${maxMinutes} preRatio=${preuploadRatio}`);

jarvisRunner.autoRun({
    maxIterations,
    maxMinutes,
    maxFailures,
    preuploadRatio,
}).then(() => {
    console.log('[node-autorun] Complete.');
    process.exit(0);
}).catch(err => {
    console.error('[node-autorun] Error:', err.message);
    process.exit(1);
});
