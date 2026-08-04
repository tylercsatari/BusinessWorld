(function attachWorldLayoutClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.WorldLayoutClient = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function worldLayoutClientFactory() {
    'use strict';

    const SAVE_SCHEMA = 'business-world-layout-save-v2';
    const DRAFT_SCHEMA = 'business-world-layout-draft-v2';
    const DEFAULT_WRITER_KEY = 'business-world:layout-writer:v2';
    const DEFAULT_DRAFT_KEY = 'business-world:layout-draft:v2';
    const METADATA_KEYS = new Set([
        '_layoutSchema',
        '_revision',
        '_savedAt',
        '_writer',
        '_writerSequence',
        '_lastMutationId',
    ]);

    function nonNegativeInteger(value) {
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? number : 0;
    }

    function identifier(value, maximumLength) {
        return String(value || '').trim().slice(0, maximumLength || 160);
    }

    function layoutData(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
        const data = {};
        Object.keys(source).forEach(key => {
            if (!METADATA_KEYS.has(key)) data[key] = source[key];
        });
        return data;
    }

    function withServerMetadata(layout, server) {
        return {
            ...layoutData(layout),
            _layoutSchema: server._layoutSchema || 'business-world-layout-v2',
            _revision: nonNegativeInteger(server._revision),
            _savedAt: typeof server._savedAt === 'string' ? server._savedAt : null,
            _writer: identifier(server._writer),
            _writerSequence: nonNegativeInteger(server._writerSequence),
            _lastMutationId: identifier(server._lastMutationId, 240),
        };
    }

    function defaultId() {
        if (
            typeof crypto !== 'undefined'
            && typeof crypto.randomUUID === 'function'
        ) {
            return crypto.randomUUID();
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function safeStorageGet(storage, key) {
        try { return storage && storage.getItem(key); } catch (error) { return null; }
    }

    function safeStorageSet(storage, key, value) {
        try { if (storage) storage.setItem(key, value); } catch (error) {}
    }

    function safeStorageRemove(storage, key) {
        try { if (storage) storage.removeItem(key); } catch (error) {}
    }

    function readJson(storage, key) {
        const raw = safeStorageGet(storage, key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (error) { return null; }
    }

    function createWorldLayoutClient(options) {
        const fetchImpl = options && options.fetchImpl;
        if (typeof fetchImpl !== 'function') {
            throw new TypeError('World layout client requires fetchImpl.');
        }
        const storage = options.storage || null;
        const createId = options.createId || defaultId;
        const onStatus = typeof options.onStatus === 'function'
            ? options.onStatus
            : function noop() {};
        const loadUrl = options.loadUrl || '/load-layout';
        const saveUrl = options.saveUrl || '/save-layout';
        const writerKey = options.writerKey || DEFAULT_WRITER_KEY;
        const draftKey = options.draftKey || DEFAULT_DRAFT_KEY;
        const retryDelays = Array.isArray(options.retryDelays)
            ? options.retryDelays.slice()
            : [0, 350, 900];
        const backgroundRetryMs = Number.isFinite(options.backgroundRetryMs)
            ? Math.max(100, options.backgroundRetryMs)
            : 5000;
        const loadTimeoutMs = Number.isFinite(options.loadTimeoutMs)
            ? Math.max(100, options.loadTimeoutMs)
            : 15000;
        const saveTimeoutMs = Number.isFinite(options.saveTimeoutMs)
            ? Math.max(100, options.saveTimeoutMs)
            : 15000;

        let writer = identifier(safeStorageGet(storage, writerKey));
        if (!writer) {
            writer = identifier(createId());
            safeStorageSet(storage, writerKey, writer);
        }

        let revision = 0;
        let writerSequence = 0;
        let serverWriter = '';
        let serverWriterSequence = 0;
        let confirmedJson = null;
        let ready = false;
        let loadPromise = null;
        let pending = null;
        let inFlight = null;
        let drainPromise = null;
        let retryTimer = null;
        let conflict = false;
        const waiters = [];

        function status(kind, message, detail) {
            onStatus({ kind, message, detail: detail || null });
        }

        function validDraft(value) {
            return !!value
                && value.schema === DRAFT_SCHEMA
                && identifier(value.writer) === writer
                && Number.isSafeInteger(value.writerSequence)
                && value.writerSequence > 0
                && Number.isSafeInteger(value.baseRevision)
                && value.baseRevision >= 0
                && identifier(value.mutationId, 240)
                && value.layout
                && typeof value.layout === 'object'
                && !Array.isArray(value.layout);
        }

        function candidateFromDraft(value) {
            const data = layoutData(value.layout);
            return {
                schema: DRAFT_SCHEMA,
                writer,
                writerSequence: value.writerSequence,
                mutationId: identifier(value.mutationId, 240),
                baseRevision: value.baseRevision,
                createdAt: Number(value.createdAt) || Date.now(),
                reason: identifier(value.reason, 80),
                keepalive: !!value.keepalive,
                layout: data,
                json: JSON.stringify(data),
            };
        }

        function persistCandidate(candidate) {
            if (!candidate) {
                safeStorageRemove(storage, draftKey);
                return;
            }
            safeStorageSet(storage, draftKey, JSON.stringify({
                schema: DRAFT_SCHEMA,
                writer,
                writerSequence: candidate.writerSequence,
                mutationId: candidate.mutationId,
                baseRevision: candidate.baseRevision,
                createdAt: candidate.createdAt,
                reason: candidate.reason,
                keepalive: candidate.keepalive,
                layout: candidate.layout,
            }));
        }

        function resolveWaiters(upToSequence, result) {
            for (let index = waiters.length - 1; index >= 0; index -= 1) {
                if (waiters[index].sequence > upToSequence) continue;
                const waiter = waiters.splice(index, 1)[0];
                waiter.resolve(result);
            }
        }

        function waitFor(sequence) {
            return new Promise(resolve => waiters.push({ sequence, resolve }));
        }

        async function responseJson(response) {
            try { return await response.json(); } catch (error) { return {}; }
        }

        async function fetchWithTimeout(url, init, timeoutMs) {
            if (typeof AbortController !== 'function') {
                return fetchImpl(url, init);
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetchImpl(url, { ...init, signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }
        }

        async function loadOnce() {
            status('loading', 'Loading layout');
            const response = await fetchWithTimeout(loadUrl, {
                cache: 'no-store',
                headers: { Accept: 'application/json' },
            }, loadTimeoutMs);
            if (!response || !response.ok) {
                const body = response ? await responseJson(response) : {};
                throw new Error(body.error || `Layout load failed (${response && response.status || 'network'})`);
            }
            const raw = await responseJson(response);
            const server = raw && typeof raw === 'object' && !Array.isArray(raw)
                ? raw
                : {};
            revision = nonNegativeInteger(server._revision);
            serverWriter = identifier(server._writer);
            serverWriterSequence = nonNegativeInteger(server._writerSequence);
            if (serverWriter === writer) {
                writerSequence = Math.max(writerSequence, serverWriterSequence);
            }
            confirmedJson = JSON.stringify(layoutData(server));

            const storedDraft = readJson(storage, draftKey);
            if (!validDraft(storedDraft)) {
                if (storedDraft) safeStorageRemove(storage, draftKey);
                status('loaded', 'Layout loaded');
                return { layout: server, recovered: false, conflict: false };
            }

            writerSequence = Math.max(writerSequence, storedDraft.writerSequence);
            if (
                serverWriter === writer
                && serverWriterSequence >= storedDraft.writerSequence
            ) {
                safeStorageRemove(storage, draftKey);
                status('loaded', 'Layout loaded');
                return { layout: server, recovered: false, conflict: false };
            }

            if (
                storedDraft.baseRevision === revision
                || (
                    serverWriter === writer
                    && serverWriterSequence < storedDraft.writerSequence
                )
            ) {
                pending = candidateFromDraft(storedDraft);
                pending.baseRevision = revision;
                persistCandidate(pending);
                status('recovering', 'Recovering unsaved layout');
                return {
                    layout: withServerMetadata(pending.layout, server),
                    recovered: true,
                    conflict: false,
                };
            }

            safeStorageRemove(storage, draftKey);
            status(
                'conflict-resolved',
                'A newer saved layout was loaded',
                { discardedDraftRevision: storedDraft.baseRevision, revision }
            );
            return { layout: server, recovered: false, conflict: true };
        }

        function load() {
            if (!loadPromise) loadPromise = loadOnce().catch(error => {
                loadPromise = null;
                status('load-error', 'Layout could not be loaded', { error: error.message });
                throw error;
            });
            return loadPromise;
        }

        function scheduleRetry() {
            if (retryTimer || conflict || !pending) return;
            retryTimer = setTimeout(function retryPendingLayout() {
                retryTimer = null;
                ensureDrain();
            }, backgroundRetryMs);
        }

        async function postCandidate(candidate) {
            let lastError = null;
            for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
                const delay = Number(retryDelays[attempt]) || 0;
                if (delay) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                try {
                    const response = await fetchWithTimeout(saveUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Accept: 'application/json',
                        },
                        body: JSON.stringify({
                            schema: SAVE_SCHEMA,
                            expectedRevision: revision,
                            writer,
                            writerSequence: candidate.writerSequence,
                            mutationId: candidate.mutationId,
                            layout: candidate.layout,
                        }),
                        keepalive: candidate.keepalive && attempt === 0,
                    }, saveTimeoutMs);
                    const body = await responseJson(response);
                    if (response.status === 409) {
                        return {
                            ok: false,
                            conflict: true,
                            error: body.error || 'The layout changed in another tab.',
                            current: body.current || null,
                        };
                    }
                    if (!response.ok) {
                        const error = new Error(body.error || `Layout save failed (${response.status})`);
                        error.retryable = response.status >= 500 || response.status === 408 || response.status === 429;
                        throw error;
                    }
                    if (
                        !body.ok
                        || !Number.isSafeInteger(body.revision)
                        || body.writer !== writer
                        || body.writerSequence !== candidate.writerSequence
                        || body.mutationId !== candidate.mutationId
                    ) {
                        throw new Error('Layout server returned an invalid save acknowledgement.');
                    }
                    return { ok: true, acknowledgement: body };
                } catch (error) {
                    lastError = error;
                    if (error.retryable === false) break;
                }
            }
            return {
                ok: false,
                conflict: false,
                error: lastError ? lastError.message : 'Layout save failed.',
            };
        }

        async function drain() {
            while (ready && pending && !conflict) {
                const candidate = pending;
                pending = null;
                inFlight = candidate;
                status('saving', 'Saving layout');
                const result = await postCandidate(candidate);
                inFlight = null;

                if (result.ok) {
                    const acknowledgement = result.acknowledgement;
                    revision = acknowledgement.revision;
                    serverWriter = acknowledgement.writer;
                    serverWriterSequence = acknowledgement.writerSequence;
                    confirmedJson = candidate.json;
                    resolveWaiters(candidate.writerSequence, {
                        ok: true,
                        revision,
                        savedAt: acknowledgement.savedAt,
                    });
                    if (pending) {
                        pending.baseRevision = revision;
                        persistCandidate(pending);
                    } else {
                        persistCandidate(null);
                        status('saved', 'Layout saved', {
                            revision,
                            savedAt: acknowledgement.savedAt,
                        });
                    }
                    continue;
                }

                if (!pending || pending.writerSequence < candidate.writerSequence) {
                    pending = candidate;
                }
                pending.baseRevision = revision;
                persistCandidate(pending);
                resolveWaiters(Number.MAX_SAFE_INTEGER, {
                    ok: false,
                    conflict: !!result.conflict,
                    error: result.error,
                });
                if (result.conflict) {
                    conflict = true;
                    status('conflict', 'Layout changed in another tab', {
                        error: result.error,
                        current: result.current,
                    });
                } else {
                    status('save-error', 'Layout is not saved yet', {
                        error: result.error,
                    });
                    scheduleRetry();
                }
            }
        }

        function ensureDrain() {
            if (!ready || conflict || !pending || drainPromise) return;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            drainPromise = drain().finally(function finishDrain() {
                drainPromise = null;
                if (ready && pending && !conflict && !retryTimer) ensureDrain();
            });
        }

        function setReady() {
            ready = true;
            ensureDrain();
        }

        function save(value, saveOptions) {
            if (!ready) {
                return Promise.resolve({
                    ok: false,
                    error: 'The saved layout has not finished loading.',
                });
            }
            if (conflict) {
                return Promise.resolve({
                    ok: false,
                    conflict: true,
                    error: 'Reload before editing because another tab saved a newer layout.',
                });
            }
            const data = layoutData(value);
            const json = JSON.stringify(data);
            if (!pending && !inFlight && json === confirmedJson) {
                return Promise.resolve({ ok: true, revision, unchanged: true });
            }
            if (pending && pending.json === json) {
                const waiting = waitFor(pending.writerSequence);
                ensureDrain();
                return waiting;
            }
            if (inFlight && !pending && inFlight.json === json) {
                return waitFor(inFlight.writerSequence);
            }

            writerSequence += 1;
            const candidate = {
                schema: DRAFT_SCHEMA,
                writer,
                writerSequence,
                mutationId: `${writer}:${writerSequence}:${identifier(createId(), 80)}`,
                baseRevision: revision,
                createdAt: Date.now(),
                reason: identifier(saveOptions && saveOptions.reason, 80),
                keepalive: !!(saveOptions && saveOptions.keepalive),
                layout: data,
                json,
            };
            pending = candidate;
            persistCandidate(candidate);
            const waiting = waitFor(candidate.writerSequence);
            ensureDrain();
            return waiting;
        }

        function getState() {
            return Object.freeze({
                ready,
                revision,
                writer,
                writerSequence,
                serverWriter,
                serverWriterSequence,
                pending: !!pending,
                inFlight: !!inFlight,
                conflict,
                confirmed: confirmedJson !== null,
            });
        }

        function dispose() {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            ready = false;
            resolveWaiters(Number.MAX_SAFE_INTEGER, {
                ok: false,
                error: 'Layout persistence was stopped.',
            });
        }

        return Object.freeze({
            load,
            save,
            setReady,
            getState,
            dispose,
            layoutData,
        });
    }

    return Object.freeze({
        DRAFT_SCHEMA,
        SAVE_SCHEMA,
        createWorldLayoutClient,
        layoutData,
        withServerMetadata,
    });
}));
