(function () {
    'use strict';

    if (window.JarvisUpload) return;

    let activePicker = null;

    function pickerError(message) {
        const error = new Error(message);
        error.code = 'JARVIS_UPLOAD_ERROR';
        return error;
    }

    function pickFiles(options) {
        const opts = options || {};
        const doc = window.document;
        if (!doc || !doc.body) {
            const error = pickerError('The file picker is not available yet. Reload the page and try again.');
            if (typeof opts.onError === 'function') opts.onError(error);
            return null;
        }

        if (activePicker && activePicker.parentNode) activePicker.remove();

        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = opts.accept || '';
        input.multiple = !!opts.multiple;
        input.setAttribute('aria-hidden', 'true');
        input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        activePicker = input;

        const cleanup = () => {
            if (activePicker === input) activePicker = null;
            if (input.parentNode) input.remove();
        };

        input.addEventListener('change', async () => {
            const files = Array.from(input.files || []);
            // Copy the File references, then detach the DOM input immediately. Keeping a
            // FileList-backed input alive for a multi-minute score wastes mobile memory and
            // makes the next picker impossible to open.
            cleanup();
            try {
                if (files.length && typeof opts.onSelect === 'function') await opts.onSelect(files);
            } catch (error) {
                if (typeof opts.onError === 'function') opts.onError(error);
            }
        }, { once: true });
        input.addEventListener('cancel', cleanup, { once: true });

        // The input is deliberately attached to document.body instead of a quant panel.
        // Poll-driven panel redraws can no longer detach it while the OS picker is open.
        doc.body.appendChild(input);
        try {
            input.click();
        } catch (error) {
            cleanup();
            if (typeof opts.onError === 'function') opts.onError(error);
        }
        return input;
    }

    function readDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new window.FileReader();
            reader.onerror = () => reject(pickerError('The selected file could not be read.'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
        });
    }

    function decodeImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new window.Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(pickerError('That image format could not be decoded. Use JPEG, PNG, or WebP.'));
            image.src = dataUrl;
        });
    }

    async function prepareImage(file, options) {
        const opts = options || {};
        if (!file) throw pickerError('No image was selected.');
        const name = String(file.name || 'thumbnail');
        const type = String(file.type || '').toLowerCase();
        if (Number(file.size) > 40 * 1024 * 1024) {
            throw pickerError('That image is over 40 MB. Export a normal thumbnail-sized JPEG, PNG, or WebP.');
        }
        const hasImageExtension = /\.(jpe?g|png|webp)$/i.test(name);
        if (type && !type.startsWith('image/') && !hasImageExtension) {
            throw pickerError('Choose a JPEG, PNG, or WebP image.');
        }
        if (type && !['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(type) && !hasImageExtension) {
            throw pickerError('That image format is not supported. Use JPEG, PNG, or WebP.');
        }

        const raw = await readDataUrl(file);
        if (!raw) throw pickerError('The selected image was empty.');
        const image = await decodeImage(raw);
        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;
        if (!width || !height) throw pickerError('The selected image has no readable dimensions.');

        const maxWidth = Math.max(320, Number(opts.maxWidth) || 1600);
        const maxHeight = Math.max(180, Number(opts.maxHeight) || 900);
        const maxChars = Math.max(250000, Number(opts.maxDataUrlChars) || 2800000);
        const scale = Math.min(1, maxWidth / width, maxHeight / height);
        const needsEncoding = scale < 0.999 || raw.length > maxChars || !raw.startsWith('data:image/');
        let dataUrl = raw;
        let outputWidth = width;
        let outputHeight = height;

        if (needsEncoding) {
            outputWidth = Math.max(1, Math.round(width * scale));
            outputHeight = Math.max(1, Math.round(height * scale));
            const canvas = window.document.createElement('canvas');
            canvas.width = outputWidth;
            canvas.height = outputHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw pickerError('The browser could not prepare this image for scoring.');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, outputWidth, outputHeight);
            ctx.drawImage(image, 0, 0, outputWidth, outputHeight);
            for (const quality of [0.92, 0.84, 0.74, 0.64]) {
                dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= maxChars) break;
            }
        }

        return {
            dataUrl,
            name,
            width: outputWidth,
            height: outputHeight,
            originalBytes: Number(file.size) || 0,
            preparedBytes: Math.max(0, Math.round((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 0.75)),
        };
    }

    const MIB = 1024 * 1024;

    function videoExtension(file) {
        const match = String((file && file.name) || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
        const ext = match ? match[1] : '';
        if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return ext;
        const type = String((file && file.type) || '').toLowerCase();
        if (type.includes('quicktime')) return 'mov';
        if (type.includes('webm')) return 'webm';
        if (type.includes('matroska')) return 'mkv';
        return 'mp4';
    }

    function openVideo(file, timeoutMs) {
        return new Promise((resolve, reject) => {
            const video = window.document.createElement('video');
            const url = window.URL.createObjectURL(file);
            let settled = false;
            const cleanup = () => {
                try { video.pause(); } catch (error) {}
                try { video.removeAttribute('src'); video.load(); } catch (error) {}
                try { window.URL.revokeObjectURL(url); } catch (error) {}
            };
            const fail = message => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                cleanup();
                reject(pickerError(message));
            };
            const timer = window.setTimeout(
                () => fail('The phone did not finish opening this video. Keep Business World visible and try again.'),
                Math.max(5000, Number(timeoutMs) || 20000)
            );
            video.preload = 'auto';
            video.playsInline = true;
            video.muted = true;
            video.onloadedmetadata = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                resolve({
                    video,
                    cleanup,
                    duration: Number.isFinite(video.duration) ? Number(video.duration) : 0,
                    width: Number(video.videoWidth) || 0,
                    height: Number(video.videoHeight) || 0,
                });
            };
            video.onerror = () => fail('That video could not be decoded by this browser.');
            video.src = url;
            try { video.load(); } catch (error) {}
        });
    }

    function waitForVideoFrame(video, timeoutMs) {
        if (video.readyState >= 2) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = error => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                video.removeEventListener('loadeddata', ready);
                video.removeEventListener('canplay', ready);
                error ? reject(error) : resolve();
            };
            const ready = () => finish();
            const timer = window.setTimeout(() => finish(pickerError('The browser could not decode a frame from this video.')), Math.max(2000, Number(timeoutMs) || 6000));
            video.addEventListener('loadeddata', ready, { once: true });
            video.addEventListener('canplay', ready, { once: true });
        });
    }

    function seekVideo(video, seconds, timeoutMs) {
        const target = Math.max(0, Number(seconds) || 0);
        if (video.readyState >= 2 && Math.abs((Number(video.currentTime) || 0) - target) < 0.03) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = error => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                video.removeEventListener('seeked', ready);
                video.removeEventListener('timeupdate', ready);
                error ? reject(error) : resolve();
            };
            const ready = () => {
                const current = Number(video.currentTime) || 0;
                const atEnd = Number.isFinite(video.duration) && target >= video.duration - 0.1 && current >= video.duration - 0.2;
                if (video.readyState >= 2 && (Math.abs(current - target) <= 0.12 || atEnd)) finish();
            };
            const timer = window.setTimeout(() => finish(pickerError('The browser could not seek through this video.')), Math.max(2000, Number(timeoutMs) || 6000));
            video.addEventListener('seeked', ready, { once: true });
            video.addEventListener('timeupdate', ready);
            try { video.currentTime = target; } catch (error) { finish(error); }
        });
    }

    async function extractVideoMontage(file, options) {
        const opts = options || {};
        const frameCount = Math.max(1, Math.min(8, Number(opts.frameCount) || 5));
        const frameWidth = Math.max(120, Number(opts.frameWidth) || 320);
        const frameHeight = Math.max(180, Number(opts.frameHeight) || 569);
        const seconds = Math.max(1, Number(opts.seconds) || 5);
        const opened = await openVideo(file, opts.timeoutMs || 20000);
        const video = opened.video;
        try {
            await waitForVideoFrame(video, 7000);
            const canvas = window.document.createElement('canvas');
            canvas.width = frameWidth * frameCount;
            canvas.height = frameHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw pickerError('The browser could not prepare the video frames.');
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const duration = opened.duration || seconds;
            const lastTime = Math.max(0, Math.min(seconds - 0.05, duration - 0.05));
            let drawn = 0;
            for (let index = 0; index < frameCount; index++) {
                const target = Math.min(index * (seconds / frameCount), lastTime);
                await seekVideo(video, target, 6500);
                if (!video.videoWidth || !video.videoHeight || video.readyState < 2) continue;
                const scale = Math.max(frameWidth / video.videoWidth, frameHeight / video.videoHeight);
                const width = video.videoWidth * scale;
                const height = video.videoHeight * scale;
                ctx.drawImage(video, index * frameWidth + (frameWidth - width) / 2, (frameHeight - height) / 2, width, height);
                drawn++;
            }
            if (drawn !== frameCount) throw pickerError(`The browser extracted only ${drawn} of ${frameCount} required frames.`);
            return {
                dataUrl: canvas.toDataURL('image/jpeg', 0.84),
                duration: opened.duration || 0,
                frames: drawn,
            };
        } finally {
            opened.cleanup();
        }
    }

    async function recordVideoPrefix(file, options) {
        const opts = options || {};
        const seconds = Math.max(2, Number(opts.seconds) || 6);
        const opened = await openVideo(file, opts.timeoutMs || 20000);
        const video = opened.video;
        let recorder = null;
        let stream = null;
        try {
            if (!opened.duration || opened.duration <= seconds + 0.6) {
                return { blob: null, duration: opened.duration || 0, reason: 'already-short' };
            }
            const capture = video.captureStream || video.mozCaptureStream;
            if (typeof capture !== 'function' || typeof window.MediaRecorder !== 'function') {
                return { blob: null, duration: opened.duration || 0, reason: 'capture-unsupported' };
            }
            try { stream = capture.call(video); } catch (error) { stream = null; }
            if (!stream) return { blob: null, duration: opened.duration || 0, reason: 'capture-unavailable' };
            const mimes = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
            const mime = mimes.find(value => {
                try { return window.MediaRecorder.isTypeSupported(value); } catch (error) { return false; }
            }) || '';
            const chunks = [];
            const blob = await new Promise((resolve, reject) => {
                let settled = false;
                let stopTimer = null;
                let hardTimer = null;
                const finish = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    if (stopTimer) window.clearTimeout(stopTimer);
                    if (hardTimer) window.clearTimeout(hardTimer);
                    fn(value);
                };
                try { recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {}); }
                catch (error) { finish(reject, error); return; }
                recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
                recorder.onerror = event => finish(reject, (event && event.error) || pickerError('The browser could not trim this video.'));
                recorder.onstop = () => {
                    const actualMime = String(recorder.mimeType || (chunks[0] && chunks[0].type) || mime || 'video/webm').split(';')[0];
                    finish(resolve, new window.Blob(chunks, { type: actualMime }));
                };
                hardTimer = window.setTimeout(() => {
                    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (error) {}
                    finish(reject, pickerError('The browser did not finish trimming this video.'));
                }, (seconds + 4) * 1000);
                // Hidden audible playback is rejected on mobile after asynchronous
                // metadata work and can unexpectedly play through the phone speaker.
                video.muted = true;
                Promise.resolve(video.play()).then(() => {
                    recorder.start(500);
                    stopTimer = window.setTimeout(() => {
                        try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (error) {}
                    }, seconds * 1000);
                }).catch(error => finish(reject, error));
            });
            return {
                blob: blob && blob.size > 2000 ? blob : null,
                duration: opened.duration || 0,
                reason: blob && blob.size > 2000 ? 'recorded' : 'empty-recording',
            };
        } catch (error) {
            return { blob: null, duration: opened.duration || 0, reason: 'capture-failed' };
        } finally {
            try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (error) {}
            try { if (stream && stream.getTracks) stream.getTracks().forEach(track => track.stop()); } catch (error) {}
            opened.cleanup();
        }
    }

    async function prepareVideo(file, options) {
        const opts = options || {};
        if (!file) throw pickerError('No video was selected.');
        const name = String(file.name || 'video');
        const type = String(file.type || '').toLowerCase();
        if (type && !type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) {
            throw pickerError('Choose an MP4, MOV, M4V, WebM, or MKV video.');
        }
        const originalBytes = Number(file.size) || 0;
        const maxOriginalBytes = Math.max(32 * MIB, Number(opts.maxOriginalBytes) || 8 * 1024 * MIB);
        if (!originalBytes) throw pickerError('The selected video is empty.');
        if (originalBytes > maxOriginalBytes) throw pickerError('That video is over 8 GB. Export only the opening and upload it again.');

        const directBytes = Math.max(256 * 1024, Number(opts.directBytes) || 20 * MIB);
        const maxClipBytes = Math.max(directBytes, Number(opts.maxClipBytes) || 28 * MIB);
        const prefixSeconds = Math.max(2, Number(opts.prefixSeconds) || 6);
        const ext = videoExtension(file);
        let duration = 0;
        let capture = null;

        if (originalBytes > directBytes) {
            capture = await recordVideoPrefix(file, { seconds: prefixSeconds, timeoutMs: opts.timeoutMs || 20000 });
            duration = Number(capture.duration) || 0;
            const shortDirectBytes = Math.max(directBytes, Number(opts.shortDirectBytes) || 32 * MIB);
            if (capture.reason === 'already-short' && originalBytes <= shortDirectBytes) {
                return {
                    blob: file,
                    ext,
                    duration,
                    mode: 'direct',
                    originalBytes,
                    transferBytes: originalBytes,
                    fallbackMontage: null,
                };
            }
            if (capture.blob && capture.blob.size <= maxClipBytes) {
                const clipType = String(capture.blob.type || '').toLowerCase();
                return {
                    blob: capture.blob,
                    ext: clipType.includes('mp4') ? 'mp4' : 'webm',
                    duration,
                    mode: 'trimmed',
                    originalBytes,
                    transferBytes: capture.blob.size,
                    fallbackMontage: null,
                };
            }
        } else {
            try {
                const opened = await openVideo(file, Math.min(12000, Number(opts.timeoutMs) || 12000));
                duration = opened.duration || 0;
                opened.cleanup();
            } catch (error) {}
            return {
                blob: file,
                ext,
                duration,
                mode: 'direct',
                originalBytes,
                transferBytes: originalBytes,
                fallbackMontage: null,
            };
        }

        let montage = null;
        try {
            montage = await extractVideoMontage(file, { seconds: 5, frameCount: 5, frameWidth: 320, frameHeight: 569, timeoutMs: opts.timeoutMs || 20000 });
            duration = duration || Number(montage.duration) || 0;
        } catch (error) {}

        const minHeadBytes = Math.max(512 * 1024, Number(opts.minHeadBytes) || 16 * MIB);
        const maxHeadBytes = Math.max(minHeadBytes, Number(opts.maxHeadBytes) || 56 * MIB);
        const maxTailBytes = Math.max(64 * 1024, Number(opts.maxTailBytes) || 4 * MIB);
        const estimatedPrefixBytes = duration > 0
            ? Math.ceil((originalBytes / duration) * (prefixSeconds + 2))
            : 32 * MIB;
        const minimumHoleBytes = 64 * 1024;
        const tailBytes = Math.min(maxTailBytes, Math.max(64 * 1024, originalBytes - minHeadBytes - minimumHoleBytes));
        const headLimit = originalBytes - tailBytes - minimumHoleBytes;
        const headBytes = Math.min(headLimit, Math.max(minHeadBytes, Math.min(maxHeadBytes, estimatedPrefixBytes)));
        if (headBytes <= 0 || tailBytes <= 0 || headBytes + tailBytes >= originalBytes) {
            throw pickerError('This browser could not make a bounded phone-safe upload. Trim the video to its first 10 seconds and try again.');
        }
        const blob = new window.Blob([
            file.slice(0, headBytes),
            file.slice(originalBytes - tailBytes, originalBytes),
        ], { type: 'application/octet-stream' });
        return {
            blob,
            ext,
            duration,
            mode: 'sparse',
            originalBytes,
            transferBytes: blob.size,
            sparse: { originalBytes, headBytes, tailBytes },
            fallbackMontage: montage && montage.dataUrl ? montage.dataUrl : null,
            captureReason: capture && capture.reason,
        };
    }

    window.JarvisUpload = Object.freeze({
        pickFiles,
        prepareImage,
        prepareVideo,
        extractVideoMontage,
        readDataUrl,
    });
})();
