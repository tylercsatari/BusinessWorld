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
            try {
                if (files.length && typeof opts.onSelect === 'function') await opts.onSelect(files);
            } catch (error) {
                if (typeof opts.onError === 'function') opts.onError(error);
            } finally {
                cleanup();
            }
        }, { once: true });

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

    window.JarvisUpload = Object.freeze({ pickFiles, prepareImage, readDataUrl });
})();
