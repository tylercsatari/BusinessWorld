'use strict';

const { parentPort, workerData } = require('worker_threads');
const analysis = require('./saved-channel-analysis');

try {
    parentPort.postMessage({
        ok: true,
        value: analysis.analyzeChannel(workerData.manifest),
    });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        error: error && error.stack || String(error),
    });
}
