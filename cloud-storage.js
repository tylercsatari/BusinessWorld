/**
 * Cloud Storage — R2 (S3-compatible) + Dropbox upload abstraction + job persistence.
 */
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
        DeleteObjectCommand, ListObjectsV2Command,
        CreateMultipartUploadCommand, UploadPartCommand,
        CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── R2 Client ──────────────────────────────────────────────

let s3 = null;
let bucket = null;
let r2DownloadPartSequence = 0;

const DEFAULT_R2_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
// Quant manifests are still bounded control-plane objects, but the largest
// saved-channel manifest is currently about 14 MiB. A 64 KiB ceiling made the
// compare-and-swap path impossible on real data and silently encouraged
// callers back toward unconditional writes. Keep a hard, explicit ceiling
// while covering the production artifact population.
const DEFAULT_R2_SMALL_OBJECT_MAX_BYTES = 32 * 1024 * 1024;
const R2_DOWNLOAD_ERROR_CODES = Object.freeze({
    MISSING: 'R2_OBJECT_MISSING',
    STORAGE: 'R2_STORAGE_ERROR',
    TOO_LARGE: 'R2_OBJECT_TOO_LARGE',
});
const R2_CONDITIONAL_ERROR_CODES = Object.freeze({
    PRECONDITION_FAILED: 'R2_PRECONDITION_FAILED',
});

class R2DownloadError extends Error {
    constructor(message, { code, kind, statusCode, key, cause, ...details }) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.kind = kind;
        this.statusCode = statusCode;
        this.httpStatusCode = statusCode;
        this.key = key;
        if (cause) this.cause = cause;
        Object.assign(this, details);
    }
}

class R2ObjectMissingError extends R2DownloadError {
    constructor(key, cause) {
        super(`R2 object not found: ${key}`, {
            code: R2_DOWNLOAD_ERROR_CODES.MISSING,
            kind: 'missing',
            statusCode: 404,
            key,
            cause,
            retryable: false,
        });
    }
}

class R2StorageError extends R2DownloadError {
    constructor(key, cause, message = `R2 storage failed while downloading: ${key}`) {
        super(message, {
            code: R2_DOWNLOAD_ERROR_CODES.STORAGE,
            kind: 'storage',
            statusCode: 502,
            key,
            cause,
            retryable: true,
        });
    }
}

class R2ObjectTooLargeError extends R2DownloadError {
    constructor(key, maxBytes, receivedBytes, details = {}) {
        super(`R2 object exceeds the ${maxBytes}-byte download limit: ${key}`, {
            code: R2_DOWNLOAD_ERROR_CODES.TOO_LARGE,
            kind: 'too-large',
            statusCode: 413,
            key,
            retryable: false,
            maxBytes,
            receivedBytes,
            ...details,
        });
    }
}

class R2PreconditionFailedError extends R2DownloadError {
    constructor(key, condition, cause) {
        super(`R2 conditional write precondition failed: ${key}`, {
            code: R2_CONDITIONAL_ERROR_CODES.PRECONDITION_FAILED,
            kind: 'precondition-failed',
            statusCode: 412,
            key,
            cause,
            retryable: false,
            condition: Object.freeze({ ...condition }),
        });
    }
}

function isMissingR2ObjectError(error) {
    return error?.name === 'NoSuchKey'
        || error?.name === 'NotFound'
        || error?.Code === 'NoSuchKey'
        || error?.code === 'NoSuchKey'
        || error?.$metadata?.httpStatusCode === 404
        || error?.statusCode === 404;
}

function isR2PreconditionFailedError(error) {
    return error instanceof R2PreconditionFailedError
        || error?.code === R2_CONDITIONAL_ERROR_CODES.PRECONDITION_FAILED
        || error?.name === 'PreconditionFailed'
        || error?.name === 'ConditionalRequestConflict'
        || error?.Code === 'PreconditionFailed'
        || error?.Code === 'ConditionalRequestConflict'
        || error?.code === 'PreconditionFailed'
        || error?.code === 'ConditionalRequestConflict'
        || error?.$metadata?.httpStatusCode === 412
        || error?.statusCode === 412;
}

async function stopR2Body(body, iterator) {
    if (iterator && typeof iterator.return === 'function') {
        try { await iterator.return(); } catch (e) {}
    }
    if (body && typeof body.destroy === 'function') {
        try { body.destroy(); } catch (e) {}
    }
}

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
    // Large buffers (>16MB) via multipart — a single PutObject of a 100-180MB tribe .json exceeds the
    // 90s requestTimeout and fails. Multipart sends 16MB parts (each well under the timeout) and is
    // resilient to a single part hiccup (that part retries, not the whole object).
    if (buffer && buffer.length > 16 * 1024 * 1024) return uploadLargeToR2(key, buffer, contentType);
    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType
    }));
}

// Manual multipart upload (no @aws-sdk/lib-storage dep). 16MB parts, sequential.
async function uploadLargeToR2(key, buffer, contentType) {
    if (!s3) throw new Error('R2 not ready');
    const PART = 16 * 1024 * 1024;
    const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    const uploadId = created.UploadId;
    try {
        const parts = [];
        for (let off = 0, n = 1; off < buffer.length; off += PART, n++) {
            const body = buffer.subarray(off, Math.min(off + PART, buffer.length));
            const r = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body }));
            parts.push({ ETag: r.ETag, PartNumber: n });
        }
        await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    } catch (e) {
        try { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })); } catch (e2) {}
        throw e;
    }
}

// Upload a file from DISK to R2 with bounded memory: small files as one
// PutObject; larger ones as sequential 16MB multipart parts read straight
// from the file handle (the whole file is never in RAM) — safe for multi-GB
// videos on the 2GB box.
async function uploadFileToR2(key, filePath, contentType) {
    if (!s3) throw new Error('R2 not ready');
    const PART = 16 * 1024 * 1024;
    const size = (await fs.promises.stat(filePath)).size;
    if (size <= PART) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: await fs.promises.readFile(filePath), ContentType: contentType }));
        return;
    }
    const fh = await fs.promises.open(filePath, 'r');
    const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    const uploadId = created.UploadId;
    try {
        const parts = [];
        for (let off = 0, n = 1; off < size; off += PART, n++) {
            const len = Math.min(PART, size - off);
            const buf = Buffer.allocUnsafe(len);
            await fh.read(buf, 0, len, off);
            const r = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: buf }));
            parts.push({ ETag: r.ETag, PartNumber: n });
        }
        await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    } catch (e) {
        try { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })); } catch (e2) {}
        throw e;
    } finally {
        await fh.close().catch(() => {});
    }
}

async function downloadFromR2(key, options = {}) {
    if (!s3) throw new Error('R2 not ready');
    const timeout = createR2OperationTimeout(
        'downloadFromR2',
        options.timeoutMs
    );
    try {
        const resp = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            timeout.signalOptions
        );
        const chunks = [];
        for await (const chunk of resp.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
    } finally {
        timeout.clear();
    }
}

function validateR2SmallObjectKey(key) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key, 'utf8') > 1024) {
        throw new TypeError('R2 small-object key must be a non-empty string no larger than 1024 bytes');
    }
}

function validateR2SmallObjectLimit(maxBytes) {
    const parsed = Number(maxBytes);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > DEFAULT_R2_SMALL_OBJECT_MAX_BYTES) {
        throw new RangeError(
            `maxBytes must be a non-negative safe integer no larger than ${DEFAULT_R2_SMALL_OBJECT_MAX_BYTES}`
        );
    }
    return parsed;
}

function normalizeR2Etag(etag, key, operation) {
    const normalized = typeof etag === 'string' ? etag.trim() : '';
    if (!normalized) {
        throw new R2StorageError(
            key,
            new Error(`R2 ${operation} response did not contain an ETag`),
            `R2 ${operation} response did not contain the ETag required for compare-and-swap: ${key}`
        );
    }
    return normalized;
}

function normalizeR2Metadata(metadata) {
    if (metadata === undefined || metadata === null) return {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new TypeError('R2 object metadata must be a plain object');
    }
    const normalized = {};
    for (const key of Object.keys(metadata).sort()) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
            throw new TypeError(`Invalid R2 metadata key: ${key}`);
        }
        const value = metadata[key];
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024) {
            throw new TypeError(`R2 metadata value for "${key}" must be a string no larger than 1024 bytes`);
        }
        normalized[key] = value;
    }
    return normalized;
}

function normalizeR2SmallObjectBody(body, key, maxBytes) {
    let buffer;
    if (Buffer.isBuffer(body)) buffer = body;
    else if (body instanceof Uint8Array) buffer = Buffer.from(body);
    else if (typeof body === 'string') buffer = Buffer.from(body, 'utf8');
    else throw new TypeError('R2 small-object body must be a Buffer, Uint8Array, or string');

    if (buffer.length > maxBytes) {
        throw new R2ObjectTooLargeError(key, maxBytes, buffer.length, {
            contentLength: buffer.length,
            bytesWritten: 0,
        });
    }
    return buffer;
}

async function bufferR2SmallObjectBody(key, response, maxBytes) {
    const advertisedLength = Number(response?.ContentLength);
    const contentLength = Number.isSafeInteger(advertisedLength) && advertisedLength >= 0
        ? advertisedLength
        : null;
    const body = response?.Body;

    if (contentLength !== null && contentLength > maxBytes) {
        await stopR2Body(body, null);
        throw new R2ObjectTooLargeError(key, maxBytes, contentLength, {
            contentLength,
            bytesWritten: 0,
        });
    }
    if (!body && contentLength === 0) return { body: Buffer.alloc(0), contentLength };
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        await stopR2Body(body, null);
        throw new R2StorageError(
            key,
            new TypeError('R2 small-object response body is not an async iterable'),
            `R2 returned an invalid small-object body: ${key}`
        );
    }

    const chunks = [];
    let receivedBytes = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
        while (true) {
            const step = await iterator.next();
            if (step.done) break;
            const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
            receivedBytes += chunk.length;
            if (receivedBytes > maxBytes) {
                throw new R2ObjectTooLargeError(key, maxBytes, receivedBytes, {
                    contentLength,
                    bytesWritten: 0,
                });
            }
            if (chunk.length) chunks.push(chunk);
        }
    } catch (cause) {
        await stopR2Body(body, iterator);
        if (cause instanceof R2ObjectTooLargeError) throw cause;
        throw new R2StorageError(
            key,
            cause,
            `R2 small-object stream failed while downloading: ${key}`
        );
    }
    if (contentLength !== null && receivedBytes !== contentLength) {
        throw new R2StorageError(
            key,
            new Error(`Expected ${contentLength} bytes but received ${receivedBytes}`),
            `R2 small-object Content-Length did not match the received body: ${key}`
        );
    }
    return { body: Buffer.concat(chunks, receivedBytes), contentLength };
}

function createR2SmallObjectStore({
    client,
    bucketName,
    maxBytes = DEFAULT_R2_SMALL_OBJECT_MAX_BYTES,
}) {
    if (!client || typeof client.send !== 'function') {
        throw new TypeError('R2 small-object store requires a client with a send(command) method');
    }
    if (typeof bucketName !== 'string' || !bucketName) {
        throw new TypeError('R2 small-object store requires a non-empty bucketName');
    }
    const hardMaxBytes = validateR2SmallObjectLimit(maxBytes);

    return Object.freeze({
        async get(key, options = {}) {
            validateR2SmallObjectKey(key);
            const requestMaxBytes = validateR2SmallObjectLimit(
                options.maxBytes === undefined ? hardMaxBytes : options.maxBytes
            );
            if (requestMaxBytes > hardMaxBytes) {
                throw new RangeError(`maxBytes cannot exceed this store's ${hardMaxBytes}-byte limit`);
            }
            if (
                options.ifMatch !== undefined
                && (
                    typeof options.ifMatch !== 'string'
                    || !options.ifMatch.trim()
                    || options.ifMatch === '*'
                )
            ) {
                throw new TypeError('ifMatch must be a non-empty exact ETag');
            }

            let response;
            try {
                response = await client.send(new GetObjectCommand({
                    Bucket: bucketName,
                    Key: key,
                    ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
                }));
            } catch (cause) {
                if (isMissingR2ObjectError(cause)) throw new R2ObjectMissingError(key, cause);
                if (isR2PreconditionFailedError(cause)) {
                    throw new R2PreconditionFailedError(key, { ifMatch: options.ifMatch }, cause);
                }
                throw new R2StorageError(key, cause, `R2 small-object read failed: ${key}`);
            }

            const buffered = await bufferR2SmallObjectBody(key, response, requestMaxBytes);
            const metadata = normalizeR2Metadata(response.Metadata);
            let lastModified = null;
            if (response.LastModified) {
                const timestamp = new Date(response.LastModified);
                if (!Number.isFinite(timestamp.getTime())) {
                    throw new R2StorageError(
                        key,
                        new TypeError('R2 LastModified value is invalid'),
                        `R2 returned invalid small-object metadata: ${key}`
                    );
                }
                lastModified = timestamp.toISOString();
            }
            return Object.freeze({
                key,
                body: buffered.body,
                etag: normalizeR2Etag(response.ETag, key, 'read'),
                contentLength: buffered.contentLength === null
                    ? buffered.body.length
                    : buffered.contentLength,
                contentType: response.ContentType || null,
                metadata: Object.freeze(metadata),
                lastModified,
                versionId: response.VersionId || null,
            });
        },

        async put(key, body, options = {}) {
            validateR2SmallObjectKey(key);
            const requestMaxBytes = validateR2SmallObjectLimit(
                options.maxBytes === undefined ? hardMaxBytes : options.maxBytes
            );
            if (requestMaxBytes > hardMaxBytes) {
                throw new RangeError(`maxBytes cannot exceed this store's ${hardMaxBytes}-byte limit`);
            }

            const ifMatch = options.ifMatch;
            const ifNoneMatch = options.ifNoneMatch;
            if ((ifMatch ? 1 : 0) + (ifNoneMatch ? 1 : 0) !== 1) {
                throw new TypeError('Conditional R2 put requires exactly one of ifMatch or ifNoneMatch');
            }
            if (ifMatch !== undefined && (typeof ifMatch !== 'string' || !ifMatch.trim() || ifMatch === '*')) {
                throw new TypeError('ifMatch must be a non-empty exact ETag');
            }
            if (ifNoneMatch !== undefined && ifNoneMatch !== '*') {
                throw new TypeError('ifNoneMatch must be exactly "*"');
            }

            const buffer = normalizeR2SmallObjectBody(body, key, requestMaxBytes);
            const metadata = normalizeR2Metadata(options.metadata);
            let response;
            try {
                response = await client.send(new PutObjectCommand({
                    Bucket: bucketName,
                    Key: key,
                    Body: buffer,
                    ContentLength: buffer.length,
                    ContentType: options.contentType || 'application/octet-stream',
                    Metadata: metadata,
                    ...(ifMatch ? { IfMatch: ifMatch } : {}),
                    ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
                }));
            } catch (cause) {
                if (isR2PreconditionFailedError(cause)) {
                    throw new R2PreconditionFailedError(key, {
                        ...(ifMatch ? { ifMatch } : {}),
                        ...(ifNoneMatch ? { ifNoneMatch } : {}),
                    }, cause);
                }
                throw new R2StorageError(key, cause, `R2 conditional small-object write failed: ${key}`);
            }
            return Object.freeze({
                key,
                etag: normalizeR2Etag(response.ETag, key, 'write'),
                versionId: response.VersionId || null,
            });
        },
    });
}

function getDefaultR2SmallObjectStore() {
    if (!s3) {
        throw new R2StorageError(
            '',
            new Error('R2 not ready'),
            'R2 storage is not initialized'
        );
    }
    return createR2SmallObjectStore({
        client: s3,
        bucketName: bucket,
        maxBytes: DEFAULT_R2_SMALL_OBJECT_MAX_BYTES,
    });
}

async function getR2SmallObject(key, options = {}) {
    return getDefaultR2SmallObjectStore().get(key, options);
}

async function putR2SmallObjectConditional(key, body, options = {}) {
    return getDefaultR2SmallObjectStore().put(key, body, options);
}

/**
 * Stream an R2 object to disk with a hard byte ceiling and atomic publication.
 *
 * The destination is replaced only after the full object has been written to a
 * sibling temporary file. Missing objects, R2 failures, and size violations
 * have stable error classes/codes; local filesystem errors retain their native
 * Node error codes.
 */
async function downloadFromR2ToFile(key, filePath, options = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('R2 key must be a non-empty string');
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Destination path must be a non-empty string');

    const maxBytes = options.maxBytes === undefined
        ? DEFAULT_R2_DOWNLOAD_MAX_BYTES
        : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError('maxBytes must be a non-negative safe integer');
    }
    if (!s3) {
        throw new R2StorageError(key, new Error('R2 not ready'), 'R2 storage is not initialized');
    }

    let response;
    try {
        response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cause) {
        if (isMissingR2ObjectError(cause)) throw new R2ObjectMissingError(key, cause);
        throw new R2StorageError(key, cause);
    }

    const body = response?.Body;
    const parsedContentLength = Number(response?.ContentLength);
    const contentLength = Number.isSafeInteger(parsedContentLength) && parsedContentLength >= 0
        ? parsedContentLength
        : null;

    if (contentLength !== null && contentLength > maxBytes) {
        await stopR2Body(body, null);
        throw new R2ObjectTooLargeError(key, maxBytes, contentLength, {
            contentLength,
            bytesWritten: 0,
        });
    }
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        await stopR2Body(body, null);
        throw new R2StorageError(key, new TypeError('R2 response body is not an async iterable'));
    }

    const tempPath = `${filePath}.part-${process.pid}-${Date.now()}-${++r2DownloadPartSequence}`;
    let fileHandle = null;
    let iterator = null;
    let bytesWritten = 0;
    let committed = false;

    try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        fileHandle = await fs.promises.open(tempPath, 'wx');
        iterator = body[Symbol.asyncIterator]();

        while (true) {
            let step;
            try {
                step = await iterator.next();
            } catch (cause) {
                throw new R2StorageError(key, cause, `R2 object stream failed while downloading: ${key}`);
            }
            if (step.done) break;

            let chunk;
            try {
                chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
            } catch (cause) {
                throw new R2StorageError(key, cause, `R2 object stream returned an invalid chunk: ${key}`);
            }

            const receivedBytes = bytesWritten + chunk.length;
            if (receivedBytes > maxBytes) {
                throw new R2ObjectTooLargeError(key, maxBytes, receivedBytes, {
                    contentLength,
                    bytesWritten,
                });
            }

            let chunkOffset = 0;
            while (chunkOffset < chunk.length) {
                const result = await fileHandle.write(
                    chunk,
                    chunkOffset,
                    chunk.length - chunkOffset,
                    null
                );
                if (!result.bytesWritten) {
                    const error = new Error(`Filesystem made no progress writing ${tempPath}`);
                    error.code = 'R2_FILE_WRITE_STALLED';
                    throw error;
                }
                chunkOffset += result.bytesWritten;
            }
            bytesWritten = receivedBytes;
        }

        await fileHandle.close();
        fileHandle = null;
        await fs.promises.rename(tempPath, filePath);
        committed = true;

        return {
            key,
            path: filePath,
            bytesWritten,
            contentLength,
            etag: response.ETag || null,
            contentType: response.ContentType || null,
        };
    } catch (error) {
        await stopR2Body(body, iterator);
        throw error;
    } finally {
        if (fileHandle) await fileHandle.close().catch(() => {});
        if (!committed) await fs.promises.unlink(tempPath).catch(() => {});
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

function createR2OperationTimeout(
    operation,
    timeoutMs
) {
    const value = timeoutMs === undefined
        ? null
        : Number(timeoutMs);
    if (
        value !== null
        && (
            !Number.isSafeInteger(value)
            || value <= 0
        )
    ) {
        throw new RangeError(
            `${operation} timeoutMs must be a positive safe integer`
        );
    }
    const controller = value === null
        ? null
        : new AbortController();
    const timer = controller
        ? setTimeout(() => controller.abort(), value)
        : null;
    return {
        signalOptions: controller
            ? { abortSignal: controller.signal }
            : undefined,
        clear() {
            if (timer) clearTimeout(timer);
        },
    };
}

async function listR2Keys(prefix, options = {}) {
    if (!s3) throw new Error('R2 not ready');
    const timeout = createR2OperationTimeout(
        'listR2Keys',
        options.timeoutMs
    );
    const keys = [];
    let continuationToken;
    try {
        do {
            const resp = await s3.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
                timeout.signalOptions
            );
            for (const obj of (resp.Contents || [])) keys.push(obj.Key);
            continuationToken = resp.IsTruncated
                ? resp.NextContinuationToken
                : undefined;
        } while (continuationToken);
        return keys;
    } finally {
        timeout.clear();
    }
}

async function listR2Objects(prefix, options = {}) {
    if (!s3) throw new Error('R2 not ready');
    const timeout = createR2OperationTimeout(
        'listR2Objects',
        options.timeoutMs
    );
    const objects = [];
    let continuationToken;
    try {
        do {
            const resp = await s3.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
                timeout.signalOptions
            );
            for (const obj of (resp.Contents || [])) {
                objects.push({
                    key: obj.Key,
                    size: Number(obj.Size) || 0,
                    etag: String(obj.ETag || ''),
                    lastModified: obj.LastModified
                        ? new Date(obj.LastModified).getTime()
                        : 0,
                });
            }
            continuationToken = resp.IsTruncated
                ? resp.NextContinuationToken
                : undefined;
        } while (continuationToken);
        return objects;
    } finally {
        timeout.clear();
    }
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
    initR2, isR2Ready, uploadToR2, uploadFileToR2, downloadFromR2, downloadFromR2ToFile,
    getR2Stream, getR2SignedUrl,
    existsInR2, deleteFromR2, listR2Keys, listR2Objects,
    getR2SmallObject, putR2SmallObjectConditional, createR2SmallObjectStore,
    DEFAULT_R2_DOWNLOAD_MAX_BYTES, DEFAULT_R2_SMALL_OBJECT_MAX_BYTES,
    R2_DOWNLOAD_ERROR_CODES, R2_CONDITIONAL_ERROR_CODES,
    R2DownloadError, R2ObjectMissingError, R2StorageError, R2ObjectTooLargeError,
    R2PreconditionFailedError, isMissingR2ObjectError, isR2PreconditionFailedError,
    // Dropbox
    getDropboxToken, getDropboxAuthStatus, uploadToDropbox, uploadLargeToDropbox, createDropboxFolder,
    // Job persistence
    saveJobState, loadJobState, loadAllActiveJobs, deleteJobState,
    // Analytics snapshots
    saveAnalyticsSnapshot, listAnalyticsSnapshots, getLatestAnalyticsSnapshot, getAllAnalyticsSnapshots,
    // Utils
    sanitizeTitle
};
