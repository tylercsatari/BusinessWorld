'use strict';
/**
 * Overnight autorun launcher: zygarnik/open-loop/pre-upload focus
 * maxIter=5000, maxMin=55, preuploadRatio=0.70, maxNoSignal=100
 * (bumped from 25→100 to prevent premature abort on zero-cluster indicator families)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const jarvisRunner = require('./jarvis-runner');

console.log('[autorun] Starting zygarnik/open-loop run: maxIter=5000 maxMin=55 preRatio=0.70 maxNoSignal=100');

jarvisRunner.autoRun({
    maxIterations: 5000,
    maxMinutes: 55,
    maxFailures: 500,
    maxNoSignal: 100,
    preuploadRatio: 0.70,
}).then(result => {
    console.log('[autorun] Complete. stop_reason:', result && result.stop_reason);
    process.exit(0);
}).catch(err => {
    console.error('[autorun] Error:', err.message);
    process.exit(1);
});
