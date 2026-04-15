#!/usr/bin/env node
'use strict';
/**
 * Launch autorun with zygarnik/Group Q focus.
 * maxIterations=3000, maxMinutes=25, preuploadRatio=0.70, maxFailures=500
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const jarvisRunner = require('./jarvis-runner');

console.log('[launch-autorun] Starting Group Q run: maxIter=3000 maxMin=25 preRatio=0.70');

jarvisRunner.autoRun({
    maxIterations: 3000,
    maxMinutes: 25,
    maxFailures: 500,
    preuploadRatio: 0.70,
}).then(() => {
    console.log('[launch-autorun] Complete.');
    process.exit(0);
}).catch(err => {
    console.error('[launch-autorun] Error:', err.message);
    process.exit(1);
});
