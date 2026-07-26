#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

require('dotenv').config({ quiet: true });

const {
    initR2,
    getR2Stream,
    listR2Objects,
} = require('../../../../cloud-storage');

const CACHE_DIR = path.join(__dirname, '.cache', 'embeddings');
const CHANNELS = [
    ['shorts', 'visual', 'raw/visual/embeddings.npz'],
    ['shorts', 'text', 'raw/text/embeddings.npz'],
    ['shorts', 'together', 'raw/together/embeddings.npz'],
    ['long', 'visual', 'raw-long/visual/embeddings.npz'],
    ['long', 'text', 'raw-long/text/embeddings.npz'],
    ['long', 'together', 'raw-long/together/embeddings.npz'],
];

async function cache(format, modality, key) {
    const folder = path.join(CACHE_DIR, format);
    const output = path.join(folder, `${modality}.npz`);
    fs.mkdirSync(folder, { recursive: true });
    const metadata = (await listR2Objects(key))[0];
    if (!metadata) throw new Error(`Missing ${key}`);
    if (fs.existsSync(output) && fs.statSync(output).size === metadata.size) {
        return { format, modality, key, output, bytes: metadata.size, reused: true };
    }
    const partial = `${output}.partial`;
    fs.rmSync(partial, { force: true });
    const stream = await getR2Stream(key);
    if (!stream) throw new Error(`Missing stream for ${key}`);
    await pipeline(stream, fs.createWriteStream(partial));
    if (fs.statSync(partial).size !== metadata.size) {
        throw new Error(`Size mismatch for ${key}`);
    }
    fs.renameSync(partial, output);
    return { format, modality, key, output, bytes: metadata.size, reused: false };
}

async function main() {
    if (!initR2()) throw new Error('R2 credentials are required.');
    const requested = new Set(process.argv.slice(2));
    const channels = requested.size
        ? CHANNELS.filter(([format, modality]) => (
            requested.has(`${format}:${modality}`)
            || requested.has(format)
            || requested.has(modality)
        ))
        : CHANNELS;
    for (const channel of channels) {
        const result = await cache(...channel);
        console.log(JSON.stringify(result));
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
