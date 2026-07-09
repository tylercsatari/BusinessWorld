/**
 * Cloud Storage — R2 (S3-compatible) + Dropbox upload abstraction + job persistence.
 */
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
        DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const fs = require('fs');

// ── R2 Client ──────────────────────────────────────────────

let s3 = null;
let bucket = null;

function initR2() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    bucket = process.env.R2_BUCKET_NAME || 'business-world-videos';

    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.warn('R2: Missing env vars. Cloud storage disabled — all R2 operations will fail.');
        return false;
    }

    // Force IPv4 + short connection timeout to avoid IPv6 ENETUNREACH hangs
    const agent = new https.Agent({ family: 4 });
    s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        requestHandler: new NodeHttpHandler({
            connectionTimeout: 8000,
            requestTimeout: 90000,
            throwOnRequestTimeout: true,
            httpsAgent: agent,
        }),
    });
    console.log(`R2: Connected to bucket "${bucket}"`);
    return true;
}

function isR2Ready() { return !!s3; }

async function uploadToR2(key, buffer, contentType) {
    if (!s3) throw new Error('R2 not ready');
    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType
    }));
}

async function downloadFromR2(key) {
    if (!s3) throw new Error('R2 not ready');
    try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of resp.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
    }
}

// Like downloadFromR2 but returns the raw readable stream (no buffering) so the
// caller can pipe it straight to an HTTP response — bounded RAM for huge objects
// (e.g. 100MB+ tribe-analysis files) and no local disk caching. Returns null if
// the key doesn't exist.
async function getR2Stream(key) {
    if (!s3) throw new Error('R2 not ready');
    try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return resp.Body; // a Node Readable
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
    }
}

async function getR2SignedUrl(key, expiresIn = 3600) {
    if (!s3) throw new Error('R2 not ready');
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

async function existsInR2(key) {
    if (!s3) throw new Error("R2 not ready");
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (e) {
        return false;
    }
}

async function deleteFromR2(key) {
    if (!s3) throw new Error('R2 not ready');
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function listR2Keys(prefix) {
    if (!s3) throw new Error('R2 not ready');
    const keys = [];
    let continuationToken;
    do {
        const resp = await s3.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken
        }));
        for (const obj of (resp.Contents || [])) keys.push(obj.Key);
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
}

async function listR2Objects(prefix) {
    if (!s3) throw new Error('R2 not ready');
    const objects = [];
    let continuationToken;
    do {
        const resp = await s3.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken
        }));
        for (const obj of (resp.Contents || [])) {
            objects.push({
                key: obj.Key,
                size: Number(obj.Size) || 0,
                etag: String(obj.ETag || ''),
                lastModified: obj.LastModified ? new Date(obj.LastModified).getTime() : 0,
            });
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
}

// ── Dropbox ────────────────────────────────────────────────

let dropboxTokenRefreshedThisRun = false;
let dropboxLastRefresh = null;

async function getDropboxToken(force = false) {
    if (process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET) {
        const forceRefresh = force || !!process.env._DROPBOX_TOKEN_EXPIRED;
        if (!process.env.DROPBOX_ACCESS_TOKEN || forceRefresh || !dropboxTokenRefreshedThisRun) {
            try {
                const params = new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: process.env.DROPBOX_REFRESH_TOKEN
                });
                const authHeader = 'Basic ' + Buffer.from(
                    `${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`
                ).toString('base64');
                const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
                    method: 'POST',
                    headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString()
                });
                if (tokenRes.ok) {
                    const tokenData = await tokenRes.json();
                    process.env.DROPBOX_ACCESS_TOKEN = tokenData.access_token;
                    delete process.env._DROPBOX_TOKEN_EXPIRED;
                    dropboxTokenRefreshedThisRun = true;
                    dropboxLastRefresh = { ok: true, status: tokenRes.status, at: new Date().toISOString(), error: '' };
                    console.log('Dropbox: token refreshed');
                } else {
                    const errText = await tokenRes.text().catch(() => '');
                    dropboxLastRefresh = { ok: false, status: tokenRes.status, at: new Date().toISOString(), error: errText.slice(0, 500) };
                    if (forceRefresh) delete process.env.DROPBOX_ACCESS_TOKEN;
                    console.warn('Dropbox: refresh failed', tokenRes.status, errText);
                }
            } catch (e) {
                dropboxLastRefresh = { ok: false, status: 0, at: new Date().toISOString(), error: e.message };
                if (forceRefresh) delete process.env.DROPBOX_ACCESS_TOKEN;
                console.warn('Dropbox: refresh failed', e);
            }
        }
    }
    return process.env.DROPBOX_ACCESS_TOKEN;
}

function dropboxTokenErrorMessage() {
    const missing = [];
    if (!process.env.DROPBOX_APP_KEY) missing.push('DROPBOX_APP_KEY');
    if (!process.env.DROPBOX_APP_SECRET) missing.push('DROPBOX_APP_SECRET');
    if (!process.env.DROPBOX_REFRESH_TOKEN) missing.push('DROPBOX_REFRESH_TOKEN');
    if (missing.length) return `Dropbox is missing env var(s): ${missing.join(', ')}`;
    if (dropboxLastRefresh && dropboxLastRefresh.ok === false) {
        return `Dropbox token refresh failed: ${dropboxLastRefresh.error || `HTTP ${dropboxLastRefresh.status}`}`;
    }
    return 'No Dropbox token available';
}

async function requireDropboxToken(force = false) {
    const token = await getDropboxToken(force);
    if (!token) throw new Error(dropboxTokenErrorMessage());
    return token;
}

function getDropboxAuthStatus() {
    return {
        hasAppKey: !!process.env.DROPBOX_APP_KEY,
        hasAppSecret: !!process.env.DROPBOX_APP_SECRET,
        hasRefreshToken: !!process.env.DROPBOX_REFRESH_TOKEN,
        hasAccessToken: !!process.env.DROPBOX_ACCESS_TOKEN,
        refreshedThisRun: dropboxTokenRefreshedThisRun,
        lastRefresh: dropboxLastRefresh
    };
}

async function dropboxContentFetch(endpoint, apiArg, body) {
    const call = (token) => fetch(`https://content.dropboxapi.com/2/files/${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Dropbox-API-Arg': JSON.stringify(apiArg),
            'Content-Type': 'application/octet-stream'
        },
        body
    });
    let token = await requireDropboxToken(false);
    let res = await call(token);
    if (res.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
        token = await requireDropboxToken(true);
        res = await call(token);
    }
    return res;
}

async function dropboxApiFetch(endpoint, payload) {
    const call = (token) => fetch(`https://api.dropboxapi.com/2/files/${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload || {})
    });
    let token = await requireDropboxToken(false);
    let res = await call(token);
    if (res.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
        token = await requireDropboxToken(true);
        res = await call(token);
    }
    return res;
}

// Upload buffer to Dropbox (files < 150 MB)
async function uploadToDropbox(dropboxPath, buffer) {
    const res = await dropboxContentFetch('upload', {
        path: dropboxPath,
        mode: 'overwrite',
        autorename: false,
        mute: true
    }, buffer);

    if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status}`);
    return res.json();
}

// Upload large file via upload_session (for files > 150 MB)
async function uploadLargeToDropbox(dropboxPath, filePath) {
    const CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB chunks
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    if (fileSize <= 150 * 1024 * 1024) {
        // Small enough for single upload
        const buffer = fs.readFileSync(filePath);
        return uploadToDropbox(dropboxPath, buffer);
    }

    // Start session
    const startRes = await dropboxContentFetch('upload_session/start', { close: false }, Buffer.alloc(0));
    if (!startRes.ok) throw new Error(`Dropbox session start failed: ${startRes.status}`);
    const { session_id } = await startRes.json();

    // Append chunks
    let offset = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
        while (offset < fileSize) {
            const remaining = fileSize - offset;
            const chunkSize = Math.min(CHUNK_SIZE, remaining);
            const chunk = Buffer.alloc(chunkSize);
            fs.readSync(fd, chunk, 0, chunkSize, offset);

            const isLast = (offset + chunkSize) >= fileSize;

            if (isLast) {
                // Finish
                const finishRes = await dropboxContentFetch('upload_session/finish', {
                    cursor: { session_id, offset },
                    commit: { path: dropboxPath, mode: 'overwrite', autorename: false, mute: true }
                }, chunk);
                if (!finishRes.ok) throw new Error(`Dropbox session finish failed: ${finishRes.status}`);
                return finishRes.json();
            } else {
                // Append
                const appendRes = await dropboxContentFetch('upload_session/append_v2', {
                    cursor: { session_id, offset },
                    close: false
                }, chunk);
                if (!appendRes.ok) throw new Error(`Dropbox session append failed: ${appendRes.status}`);
            }

            offset += chunkSize;
        }
    } finally {
        fs.closeSync(fd);
    }
}

async function createDropboxFolder(folderPath) {
    const res = await dropboxApiFetch('create_folder_v2', { path: folderPath, autorename: false });

    // 409 = folder already exists, that's fine
    if (res.status === 409) return;
    if (!res.ok) {
        const text = await res.text();
        // "path/conflict/folder" means folder already exists
        if (text.includes('conflict/folder')) return;
        throw new Error(`Dropbox create folder failed: ${res.status} ${text}`);
    }
}

// ── Job Persistence ────────────────────────────────────────

async function saveJobState(videoId, jobData) {
    const key = `videos/${videoId}/job.json`;
    await uploadToR2(key, Buffer.from(JSON.stringify(jobData)), 'application/json');
}

async function loadJobState(videoId) {
    const buf = await downloadFromR2(`videos/${videoId}/job.json`);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf8'));
}

async function loadAllActiveJobs() {
    if (!s3) throw new Error("R2 not ready");
    // List all video directories
    const keys = await listR2Keys('videos/');
    // Filter for job.json files
    const jobKeys = keys.filter(k => k.endsWith('/job.json'));
    const activeJobs = [];
    for (const key of jobKeys) {
        try {
            const buf = await downloadFromR2(key);
            if (!buf) continue;
            const job = JSON.parse(buf.toString('utf8'));
            if (job.status !== 'complete' && job.status !== 'error') {
                activeJobs.push(job);
            }
        } catch (e) {
            console.warn(`Failed to load job from ${key}:`, e.message);
        }
    }
    return activeJobs;
}

async function deleteJobState(videoId) {
    await deleteFromR2(`videos/${videoId}/job.json`);
}

// ── Analytics Snapshots ─────────────────────────────────────

async function saveAnalyticsSnapshot(videoId, analyticsData) {
    if (!s3) throw new Error("R2 not ready");
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `videos/${videoId}/analytics/${timestamp}.json`;
    const payload = { ...analyticsData, snapshotAt: new Date().toISOString() };
    await uploadToR2(key, Buffer.from(JSON.stringify(payload)), 'application/json');
    console.log(`R2: Analytics snapshot saved for ${videoId} at ${timestamp}`);
}

async function listAnalyticsSnapshots(videoId) {
    if (!s3) throw new Error("R2 not ready");
    const keys = await listR2Keys(`videos/${videoId}/analytics/`);
    // Sort chronologically (filenames are ISO timestamps)
    return keys.sort();
}

async function getLatestAnalyticsSnapshot(videoId) {
    const keys = await listAnalyticsSnapshots(videoId);
    if (keys.length === 0) return null;
    // Return the second-to-last snapshot (the last one is the one we just saved)
    // If only one exists, return it
    const targetKey = keys.length > 1 ? keys[keys.length - 2] : keys[keys.length - 1];
    const buf = await downloadFromR2(targetKey);
    if (!buf) return null;
    return JSON.parse(buf.toString('utf8'));
}

async function getAllAnalyticsSnapshots(videoId) {
    const keys = await listAnalyticsSnapshots(videoId);
    const snapshots = [];
    for (const key of keys) {
        try {
            const buf = await downloadFromR2(key);
            if (buf) snapshots.push(JSON.parse(buf.toString('utf8')));
        } catch (e) {
            console.warn(`Failed to load analytics snapshot ${key}:`, e.message);
        }
    }
    return snapshots;
}

// ── Sanitize title for Dropbox paths ───────────────────────

function sanitizeTitle(title) {
    return (title || 'Untitled')
        .replace(/[<>:"/\\|?*]/g, '')  // Remove illegal filename chars
        .replace(/[^\x00-\x7F]/g, '')  // Remove non-ASCII (emojis, curly quotes, ellipsis, etc.)
        .replace(/\s+/g, ' ')          // Collapse whitespace
        .trim()
        .slice(0, 100)                 // Cap length
        || 'Untitled';                 // Fallback if everything was stripped
}

module.exports = {
    // R2
    initR2, isR2Ready, uploadToR2, downloadFromR2, getR2Stream, getR2SignedUrl,
    existsInR2, deleteFromR2, listR2Keys, listR2Objects,
    // Dropbox
    getDropboxToken, getDropboxAuthStatus, uploadToDropbox, uploadLargeToDropbox, createDropboxFolder,
    // Job persistence
    saveJobState, loadJobState, loadAllActiveJobs, deleteJobState,
    // Analytics snapshots
    saveAnalyticsSnapshot, listAnalyticsSnapshots, getLatestAnalyticsSnapshot, getAllAnalyticsSnapshots,
    // Utils
    sanitizeTitle
};
