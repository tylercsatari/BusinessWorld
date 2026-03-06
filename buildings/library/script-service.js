/**
 * Script Service — R2-backed scripts for the Library.
 * Each script = a record in /api/data/scripts.
 * Script body is stored inline as a field (no more block manipulation).
 */
const ScriptService = (() => {
    let scripts = [];
    let _lastSync = 0;
    let _syncPromise = null;

    function ensureScriptSuffix(title) {
        const t = title.trim();
        if (!t) return '';
        return /script$/i.test(t) ? t : t + ' Script';
    }

    return {
        async sync(force) {
            if (!force && scripts.length > 0 && Date.now() - _lastSync < 60000) return scripts;
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                const res = await fetch('/api/data/scripts');
                if (!res.ok) throw new Error(`Scripts fetch failed: ${res.status}`);
                scripts = await res.json();
                _lastSync = Date.now();
                return scripts;
            })();
            try { return await _syncPromise; } finally { _syncPromise = null; }
        },

        getAll() { return scripts; },

        getById(id) { return scripts.find(s => s.id === id); },

        /**
         * Load full script content (body + meta).
         * Returns { meta: {project, linkedIdeaId, linkedVideoId}, text: string }
         */
        async loadContent(scriptId) {
            const res = await fetch(`/api/data/scripts/${scriptId}`);
            if (!res.ok) return { meta: { project: '' }, text: '' };
            const record = await res.json();
            return {
                meta: {
                    project: record.project || '',
                    linkedIdeaId: record.linkedIdeaId || '',
                    linkedVideoId: record.linkedVideoId || ''
                },
                text: record.body || ''
            };
        },

        /**
         * Save script content: body text + metadata fields.
         */
        async saveContent(scriptId, text, meta) {
            const fields = { body: text };
            if (meta) {
                if (meta.project !== undefined) fields.project = meta.project;
                if (meta.linkedIdeaId !== undefined) fields.linkedIdeaId = meta.linkedIdeaId;
                if (meta.linkedVideoId !== undefined) fields.linkedVideoId = meta.linkedVideoId;
            }
            const res = await fetch(`/api/data/scripts/${scriptId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fields)
            });
            if (!res.ok) throw new Error(`Save script failed: ${res.status}`);
            // Update local cache
            const updated = await res.json();
            const idx = scripts.findIndex(s => s.id === scriptId);
            if (idx >= 0) scripts[idx] = updated;
        },

        /**
         * Create a new script. Returns the script object added to cache.
         */
        async create(title, project) {
            const scriptTitle = ensureScriptSuffix(title);
            const res = await fetch('/api/data/scripts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: scriptTitle,
                    project: project || '',
                    body: '',
                    linkedIdeaId: '',
                    linkedVideoId: ''
                })
            });
            if (!res.ok) throw new Error(`Create script failed: ${res.status}`);
            const script = await res.json();
            scripts.unshift(script);
            return script;
        },

        /**
         * Delete a script.
         */
        async remove(scriptId) {
            const res = await fetch(`/api/data/scripts/${scriptId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(`Delete script failed: ${res.status}`);
            scripts = scripts.filter(s => s.id !== scriptId);
        },

        ensureScriptSuffix
    };
})();
