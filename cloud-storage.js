/**
 * Cloud Storage — R2 (S3-compatible) + Dropbox upload abstraction + job persistence.
 */
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
        DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
        throw new Error('R2: Missing env vars (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY). Cannot start without cloud storage.');
    }

    s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey }
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

// ── Dropbox ────────────────────────────────────────────────

async function getDropboxToken() {
    if (process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET) {
        if (!process.env.DROPBOX_ACCESS_TOKEN || process.env._DROPBOX_TOKEN_EXPIRED) {
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
                    console.log('Dropbox: token refreshed');
                }
            } catch (e) { console.warn('Dropbox: refresh failed', e); }
        }
    }
    return process.env.DROPBOX_ACCESS_TOKEN;
}

// Upload buffer to Dropbox (files < 150 MB)
async function uploadToDropbox(dropboxPath, buffer) {
    const token = await getDropboxToken();
    if (!token) throw new Error('No Dropbox token available');

    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Dropbox-API-Arg': JSON.stringify({
                path: dropboxPath,
                mode: 'overwrite',
                autorename: false,
                mute: true
            }),
            'Content-Type': 'application/octet-stream'
        },
        body: buffer
    });

    if (res.status === 401 && process.env.DROPBOX_REFRESH_TOKEN) {
        // Token expired — refresh and retry once
        process.env._DROPBOX_TOKEN_EXPIRED = '1';
        const newToken = await getDropboxToken();
        const retry = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${newToken}`,
                'Dropbox-API-Arg': JSON.stringify({
                    path: dropboxPath,
                    mode: 'overwrite',
                    autorename: false,
                    mute: true
                }),
                'Content-Type': 'application/octet-stream'
            },
            body: buffer
        });
        if (!retry.ok) throw new Error(`Dropbox upload failed: ${retry.status}`);
        return retry.json();
    }

    if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status}`);
    return res.json();
}

// Upload large file via upload_session (for files > 150 MB)
async function uploadLargeToDropbox(dropboxPath, filePath) {
    const token = await getDropboxToken();
    if (!token) throw new Error('No Dropbox token available');

    const CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB chunks
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    if (fileSize <= 150 * 1024 * 1024) {
        // Small enough for single upload
        const buffer = fs.readFileSync(filePath);
        return uploadToDropbox(dropboxPath, buffer);
    }

    // Start session
    const startRes = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Dropbox-API-Arg': JSON.stringify({ close: false }),
            'Content-Type': 'application/octet-stream'
        },
        body: Buffer.alloc(0)
    });
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
                const finishRes = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Dropbox-API-Arg': JSON.stringify({
                            cursor: { session_id, offset },
                            commit: { path: dropboxPath, mode: 'overwrite', autorename: false, mute: true }
                        }),
                        'Content-Type': 'application/octet-stream'
                    },
                    body: chunk
                });
                if (!finishRes.ok) throw new Error(`Dropbox session finish failed: ${finishRes.status}`);
                return finishRes.json();
            } else {
                // Append
                const appendRes = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Dropbox-API-Arg': JSON.stringify({
                            cursor: { session_id, offset },
                            close: false
                        }),
                        'Content-Type': 'application/octet-stream'
                    },
                    body: chunk
                });
                if (!appendRes.ok) throw new Error(`Dropbox session append failed: ${appendRes.status}`);
            }

            offset += chunkSize;
        }
    } finally {
        fs.closeSync(fd);
    }
}

async function createDropboxFolder(folderPath) {
    const token = await getDropboxToken();
    if (!token) throw new Error('No Dropbox token available');

    const res = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: folderPath, autorename: false })
    });

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
    initR2, isR2Ready, uploadToR2, downloadFromR2, getR2SignedUrl,
    existsInR2, deleteFromR2, listR2Keys,
    // Dropbox
    getDropboxToken, uploadToDropbox, uploadLargeToDropbox, createDropboxFolder,
    // Job persistence
    saveJobState, loadJobState, loadAllActiveJobs, deleteJobState,
    // Analytics snapshots
    saveAnalyticsSnapshot, listAnalyticsSnapshots, getLatestAnalyticsSnapshot, getAllAnalyticsSnapshots,
    // Utils
    sanitizeTitle
};
