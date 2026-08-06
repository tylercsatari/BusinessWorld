'use strict';

const OPENAI_IMAGE_MODEL = 'gpt-image-2';
const OPENAI_IMAGE_API = 'https://api.openai.com/v1/images';
const OPENAI_IMAGE_TIMEOUT_MS = 180000;
const OPENAI_IMAGE_QUALITY = 'medium';
const OPENAI_IMAGE_FORMAT = 'jpeg';
const OPENAI_IMAGE_COMPRESSION = 90;

const OUTPUT_SIZES = Object.freeze({
    'storyboard-sheet': Object.freeze({
        width: 2880,
        height: 1024,
        value: '2880x1024',
    }),
    '9:16': Object.freeze({
        width: 1152,
        height: 2048,
        value: '1152x2048',
    }),
});

function outputSize(aspectRatio) {
    return OUTPUT_SIZES[aspectRatio] || OUTPUT_SIZES['9:16'];
}

function imageError(message, statusCode, code, details = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    Object.assign(error, details);
    return error;
}

function referenceBlob(value, index) {
    const match = String(value || '').match(
        /^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/=\s]+)$/i
    );
    if (!match) {
        throw imageError(
            `OpenAI reference image ${index + 1} is invalid.`,
            422,
            'openai_image_reference_invalid'
        );
    }
    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!bytes.length) {
        throw imageError(
            `OpenAI reference image ${index + 1} is empty.`,
            422,
            'openai_image_reference_empty'
        );
    }
    const mediaType = match[1].toLowerCase() === 'image/jpg'
        ? 'image/jpeg'
        : match[1].toLowerCase();
    const extension = mediaType === 'image/jpeg'
        ? 'jpg'
        : mediaType.split('/')[1];
    return {
        blob: new Blob([bytes], { type: mediaType }),
        filename: `storyboard-reference-${index + 1}.${extension}`,
    };
}

function requestFor({ apiKey, model, prompt, refs, aspectRatio }) {
    if (!apiKey) {
        throw imageError(
            'OpenAI image generation is not configured on this server. '
                + 'Set OPENAI_API_KEY.',
            503,
            'openai_image_key_missing'
        );
    }
    if (typeof FormData !== 'function' || typeof Blob !== 'function') {
        throw imageError(
            'This server runtime does not support OpenAI image uploads.',
            500,
            'openai_image_runtime_unsupported'
        );
    }
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
        throw imageError(
            'OpenAI image generation requires a prompt.',
            400,
            'openai_image_prompt_required'
        );
    }
    const images = (refs || []).filter(Boolean);
    const size = outputSize(aspectRatio);
    const endpoint = images.length ? 'edits' : 'generations';
    const common = {
        model: model || OPENAI_IMAGE_MODEL,
        prompt: cleanPrompt,
        size: size.value,
        quality: OPENAI_IMAGE_QUALITY,
        output_format: OPENAI_IMAGE_FORMAT,
        output_compression: OPENAI_IMAGE_COMPRESSION,
        moderation: 'auto',
    };
    if (!images.length) {
        return {
            url: `${OPENAI_IMAGE_API}/${endpoint}`,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ...common, n: 1 }),
            },
            endpoint,
            size,
        };
    }
    const body = new FormData();
    Object.entries(common).forEach(([key, value]) => {
        body.append(key, String(value));
    });
    images.forEach((image, index) => {
        const reference = referenceBlob(image, index);
        body.append('image[]', reference.blob, reference.filename);
    });
    return {
        url: `${OPENAI_IMAGE_API}/${endpoint}`,
        init: {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body,
        },
        endpoint,
        size,
    };
}

function responseError(response, payload) {
    const source = payload && payload.error || {};
    const providerCode = String(
        source.code || source.type || 'request_failed'
    );
    const requestId = response.headers
        && typeof response.headers.get === 'function'
        ? response.headers.get('x-request-id')
        : null;
    let statusCode = response.status >= 500 ? 502 : response.status;
    let message = String(source.message || '').trim();
    let code = `openai_image_${providerCode.replace(/[^a-z0-9_]+/gi, '_')}`;
    if (response.status === 401 || response.status === 403) {
        statusCode = 503;
        code = 'openai_image_credential_rejected';
        message = 'OpenAI rejected the server image-generation credential. '
            + 'Update OPENAI_API_KEY.';
    } else if (providerCode === 'insufficient_quota') {
        statusCode = 402;
        code = 'openai_image_out_of_credits';
        message = 'OpenAI image generation is out of credits or has reached '
            + 'its spend limit.';
    } else if (response.status === 429) {
        code = 'openai_image_rate_limited';
        message = 'OpenAI image generation is temporarily rate-limited. '
            + 'Try again shortly.';
    } else if (providerCode === 'moderation_blocked') {
        statusCode = 422;
        code = 'openai_image_moderation_blocked';
        message = 'OpenAI could not generate this image because the prompt '
            + 'or references were blocked. Revise them and try again.';
    } else if (!message) {
        message = `OpenAI image generation failed (HTTP ${response.status}).`;
    }
    return imageError(message, statusCode || 502, code, {
        providerCode,
        providerStatus: response.status,
        requestId,
    });
}

async function generateImage({
    apiKey,
    model = OPENAI_IMAGE_MODEL,
    prompt,
    refs = [],
    aspectRatio = '9:16',
    fetchWithTimeout,
    shouldStop,
}) {
    const request = requestFor({
        apiKey,
        model,
        prompt,
        refs,
        aspectRatio,
    });
    const execute = typeof fetchWithTimeout === 'function'
        ? fetchWithTimeout
        : (url, init) => fetch(url, init);
    if (typeof shouldStop === 'function' && await shouldStop()) {
        throw imageError(
            'OpenAI image generation was stopped by the user.',
            409,
            'HOOK_GENERATION_STOPPED'
        );
    }
    const stopController = typeof shouldStop === 'function'
        && typeof AbortController === 'function'
        ? new AbortController()
        : null;
    let stopTimer = null;
    let stoppedByUser = false;
    let stopCheckActive = false;
    let stopChecksFinished = false;
    const scheduleStopCheck = () => {
        if (
            stopChecksFinished
            || !stopController
            || stopController.signal.aborted
        ) return;
        stopTimer = setTimeout(async () => {
            if (stopCheckActive) {
                scheduleStopCheck();
                return;
            }
            stopCheckActive = true;
            try {
                if (await shouldStop()) {
                    stoppedByUser = true;
                    stopController.abort();
                    return;
                }
            } catch (error) {
                // The owning worker still performs authoritative cancellation
                // checks between stages; a transient marker read must not turn
                // a provider request into a false stop.
            } finally {
                stopCheckActive = false;
            }
            scheduleStopCheck();
        }, 500);
    };
    scheduleStopCheck();
    let response;
    try {
        response = await execute(
            request.url,
            {
                ...request.init,
                ...(stopController
                    ? { signal: stopController.signal }
                    : {}),
            },
            OPENAI_IMAGE_TIMEOUT_MS
        );
    } catch (error) {
        if (stoppedByUser) {
            throw imageError(
                'OpenAI image generation was stopped by the user.',
                409,
                'HOOK_GENERATION_STOPPED'
            );
        }
        if (error && error.name === 'AbortError') {
            throw imageError(
                'OpenAI image generation timed out after three minutes.',
                504,
                'openai_image_timeout'
            );
        }
        throw imageError(
            `OpenAI image generation could not be reached: ${
                String(error && error.message || error).slice(0, 240)
            }`,
            502,
            'openai_image_unreachable'
        );
    } finally {
        stopChecksFinished = true;
        if (stopTimer) clearTimeout(stopTimer);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw responseError(response, payload);
    const encoded = payload
        && payload.data
        && payload.data[0]
        && payload.data[0].b64_json;
    if (!encoded || typeof encoded !== 'string') {
        throw imageError(
            'OpenAI returned no image data.',
            502,
            'openai_image_output_missing'
        );
    }
    return {
        dataUrl: `data:image/${OPENAI_IMAGE_FORMAT};base64,${encoded}`,
        endpoint: request.endpoint,
        model,
        provider: 'openai',
        requestId: response.headers
            && typeof response.headers.get === 'function'
            ? response.headers.get('x-request-id')
            : null,
        size: request.size,
    };
}

module.exports = {
    OPENAI_IMAGE_MODEL,
    OPENAI_IMAGE_QUALITY,
    OUTPUT_SIZES,
    generateImage,
    outputSize,
    requestFor,
};
