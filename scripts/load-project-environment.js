'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadProjectEnvironment(options = {}) {
    const scriptDirectory = options.scriptDirectory || __dirname;
    const workingDirectory = options.workingDirectory || process.cwd();
    const candidates = [
        process.env.BUSINESS_WORLD_ENV_FILE,
        path.join(workingDirectory, '.env'),
        path.join(scriptDirectory, '..', '.env'),
        path.join(scriptDirectory, '..', '..', '..', '.env'),
    ].filter(Boolean);
    const envPath = candidates.find(candidate => fs.existsSync(candidate));
    if (envPath) {
        dotenv.config({ path: envPath, quiet: true });
    }
    return envPath || null;
}

module.exports = {
    loadProjectEnvironment,
};
