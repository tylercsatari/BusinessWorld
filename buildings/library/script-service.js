/**
 * Script Service — Notion-backed scripts for the Library.
 * Extracted from LibraryUI so all buildings can access script data
 * without depending on a UI layer.
 *
 * Each script = a child page under the Scripts parent page (videosPageId).
 * Content = paragraph blocks (the script text).
 * Metadata = a JSON code block (project, linkedIdeaId, linkedVideoId).
 */
const ScriptService = (() => {
    let scripts = [];
    let videosPageId = '';
    let videosDataPageId = '';
    let todoPageId = '';
    let calendarPageId = '';
    const protectedPageIds = new Set();
    function normalizeId(id) { return id ? id.replace(/-/g, '') : ''; }
    let _lastSync = 0;
    let _syncPromise = null;

    async function loadConfig() {
        if (videosPageId) return;
        const cfg = await NotionHelpers.getConfig();
        if (cfg.notion) {
            if (cfg.notion.videosPageId) videosPageId = cfg.notion.videosPageId;
            if (cfg.notion.videosDataPageId) { videosDataPageId = cfg.notion.videosDataPageId; protectedPageIds.add(normalizeId(videosDataPageId)); }
            if (cfg.notion.todoPageId) { todoPageId = cfg.notion.todoPageId; protectedPageIds.add(normalizeId(todoPageId)); }
            if (cfg.notion.calendarPageId) { calendarPageId = cfg.notion.calendarPageId; protectedPageIds.add(normalizeId(calendarPageId)); }
        }
    }

    async function fetchScriptPages() {
        if (!videosPageId) return [];
        try {
            const res = await fetch(`/api/notion/blocks/${videosPageId}/children`);
            const data = await res.json();
            if (!data.results) return [];
            return data.results
                .filter(b => b.type === 'child_page' && !protectedPageIds.has(normalizeId(b.id)))
                .map(b => ({ id: b.id, title: b.child_page.title, project: '', created: b.created_time, lastEdited: b.last_edited_time }));
        } catch (e) { console.warn('ScriptService: fetch scripts failed', e); return []; }
    }

    // --- Block-level helpers for script content ---
    async function fetchPageBlocks(pageId) {
        try {
            const res = await fetch(`/api/notion/blocks/${pageId}/children`);
            const data = await res.json();
            return data.results || [];
        } catch (e) { console.warn('ScriptService: fetch blocks failed', e); return []; }
    }

    function blocksToText(blocks) {
        return blocks.filter(b => b.type === 'paragraph').map(b => {
            const rt = b.paragraph && b.paragraph.rich_text;
            if (!rt || rt.length === 0) return '';
            return rt.map(t => t.plain_text || t.text?.content || '').join('');
        }).join('\n');
    }

    function extractMeta(blocks) {
        for (const b of blocks) {
            if (b.type === 'code') {
                const text = (b.code.rich_text || []).map(t => t.plain_text).join('');
                try { return JSON.parse(text); } catch (e) {}
            }
        }
        return { project: '' };
    }

    function textToBlocks(text) {
        const lines = text.split('\n');
        const blocks = lines.map(line => ({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: line } }] }
        }));
        if (blocks.length === 0) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '' } }] } });
        return blocks;
    }

    function ensureScriptSuffix(title) {
        const t = title.trim();
        if (!t) return '';
        return /script$/i.test(t) ? t : t + ' Script';
    }

    return {
        /**
         * Sync scripts from Notion with dedup guard + 60s cache.
         */
        async sync(force) {
            if (!force && scripts.length > 0 && Date.now() - _lastSync < 60000) return scripts;
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                await loadConfig();
                scripts = await fetchScriptPages();
                _lastSync = Date.now();
                return scripts;
            })();
            try { return await _syncPromise; } finally { _syncPromise = null; }
        },

        getAll() { return scripts; },

        getById(id) { return scripts.find(s => s.id === id); },

        /**
         * Get the parent page ID for scripts (needed by Library for createPage).
         */
        async getScriptsPageId() {
            await loadConfig();
            return videosPageId;
        },

        /**
         * Load full script content: blocks, meta, and text.
         * Used by LinkService and inline script editor.
         */
        async loadContent(scriptId) {
            const blocks = await fetchPageBlocks(scriptId);
            const meta = extractMeta(blocks);
            const text = blocksToText(blocks);
            return { blocks, meta, text };
        },

        /**
         * Save script content: deletes old blocks, writes new text + meta.
         * Used by LinkService and inline script editor.
         */
        async saveContent(scriptId, text, meta) {
            const blocks = await fetchPageBlocks(scriptId);
            const toDelete = blocks.filter(b => b.type === 'paragraph' || b.type === 'code');
            await Promise.all(toDelete.map(b => fetch(`/api/notion/blocks/${b.id}`, { method: 'DELETE' })));
            const newBlocks = textToBlocks(text);
            if (meta) {
                newBlocks.push({
                    object: 'block', type: 'code',
                    code: { language: 'json', rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }] }
                });
            }
            await fetch(`/api/notion/blocks/${scriptId}/children`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ children: newBlocks })
            });
        },

        /**
         * Create a new script page. Returns the script object added to cache.
         */
        async create(title, project) {
            await loadConfig();
            if (!videosPageId) throw new Error('Videos page not configured');
            const scriptTitle = ensureScriptSuffix(title);
            const res = await fetch('/api/notion/pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: { page_id: videosPageId },
                    properties: { title: { title: [{ text: { content: scriptTitle } }] } },
                    children: []
                })
            });
            if (!res.ok) throw new Error(`Create script failed: ${res.status}`);
            const result = await res.json();
            const script = { id: result.id, title: scriptTitle, project: project || '', created: result.created_time, lastEdited: result.last_edited_time };
            scripts.unshift(script);
            return script;
        },

        /**
         * Archive a script page.
         */
        async remove(scriptId) {
            if (protectedPageIds.has(normalizeId(scriptId))) {
                console.warn('ScriptService: blocked deletion of protected page');
                return;
            }
            await NotionHelpers.archivePage(scriptId);
            scripts = scripts.filter(s => s.id !== scriptId);
        },

        ensureScriptSuffix
    };
})();
