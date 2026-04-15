#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const jarvisRunner = require('./jarvis-runner');
console.log('[node-autorun] Starting zygarnik/open-loop push: maxIter=5000 maxMin=30 preRatio=0.70');
jarvisRunner.autoRun({ maxIterations: 5000, maxMinutes: 30, maxFailures: 200, preuploadRatio: 0.70 })
  .then(() => { console.log('[node-autorun] Complete.'); process.exit(0); })
  .catch(err => { console.error('[node-autorun] Error:', err.message); process.exit(1); });
