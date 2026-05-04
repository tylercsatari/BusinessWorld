'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const keys = [
  'jarvis/derived_experiments_compact.json',
  'jarvis/graph.json',
  'jarvis/indicators_compact.json',
  'jarvis/autonomous_progress.json',
  'jarvis/resolutions.json',
];

const localFiles = {
  'jarvis/derived_experiments_compact.json': path.join(__dirname, 'derived_experiments_compact.json'),
  'jarvis/graph.json': path.join(__dirname, 'graph.json'),
  'jarvis/indicators_compact.json': path.join(__dirname, 'indicators_compact.json'),
  'jarvis/autonomous_progress.json': path.join(__dirname, 'autonomous_progress.json'),
  'jarvis/resolutions.json': path.join(__dirname, 'resolutions.json'),
};

async function run() {
  for (const key of keys) {
    let r2Size = null, r2Date = null;
    let localSize = null, localDate = null;

    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      r2Size = head.ContentLength;
      r2Date = head.LastModified;
    } catch(e) { r2Size = 'ERR: ' + e.message; }

    try {
      const stat = fs.statSync(localFiles[key]);
      localSize = stat.size;
      localDate = stat.mtime;
    } catch(e) { localSize = 'missing'; }

    const ahead = (typeof localSize === 'number' && typeof r2Size === 'number') ? (localSize > r2Size ? 'LOCAL_AHEAD' : localSize === r2Size ? 'EQUAL' : 'R2_AHEAD') : '?';
    console.log(`${key}: local=${localSize} r2=${r2Size} => ${ahead} | local_mtime=${localDate ? new Date(localDate).toISOString() : '?'} r2_mtime=${r2Date ? new Date(r2Date).toISOString() : '?'}`);
  }
}

run().catch(e => { console.error('FATAL:', e.message); });
