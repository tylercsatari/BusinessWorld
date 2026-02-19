/**
 * NotionHelpers — shared Notion primitives + config cache.
 * Single source for config, child pages, page metadata, and HTML escaping.
 * All services and UIs use this instead of their own internal copies.
 */
const NotionHelpers = (() => {
    let _config = null;
    let _configPromise = null;

    return {
        /**
         * Single cached /api/config fetch. Returns the full config object.
         * Replaces 4 independent config fetches across services.
         */
        async getConfig() {
            if (_config) return _config;
            if (_configPromise) return _configPromise;
            _configPromise = (async () => {
                try {
                    const res = await fetch('/api/config');
                    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
                    _config = await res.json();
                } catch (e) {
                    console.warn('NotionHelpers: config load failed', e);
                    // Don't cache failure — allow retry on next call
                }
                return _config || {};
            })();
            try { return await _configPromise; } finally { _configPromise = null; }
        },

        /**
         * List child pages under a parent page. Returns [{id, name, created, lastEdited}].
         */
        async fetchChildPages(parentId) {
            if (!parentId) return [];
            const res = await fetch(`/api/notion/blocks/${parentId}/children`);
            if (!res.ok) throw new Error(`Notion fetch failed: ${res.status}`);
            const data = await res.json();
            if (!data.results) return [];
            return data.results
                .filter(b => b.type === 'child_page' && !b.archived)
                .map(b => ({
                    id: b.id,
                    name: b.child_page.title,
                    created: b.created_time,
                    lastEdited: b.last_edited_time,
                    _loaded: false
                }));
        },

        /**
         * Read JSON metadata from the first code block of a page.
         * Returns the parsed object, or defaultMeta if none found.
         */
        async loadPageMeta(pageId, defaultMeta) {
            const res = await fetch(`/api/notion/blocks/${pageId}/children`);
            if (!res.ok) return defaultMeta || {};
            const data = await res.json();
            if (!data.results) return defaultMeta || {};
            for (const block of data.results) {
                if (block.type === 'code') {
                    const text = (block.code.rich_text || []).map(t => t.plain_text).join('');
                    try { return JSON.parse(text); } catch (e) {}
                }
            }
            return defaultMeta || {};
        },

        /**
         * Save JSON metadata as a code block on a page.
         * Deletes existing code blocks first, then appends new one.
         */
        async savePageMeta(pageId, meta) {
            const res = await fetch(`/api/notion/blocks/${pageId}/children`);
            if (res.ok) {
                const data = await res.json();
                const deletes = (data.results || [])
                    .filter(b => b.type === 'code')
                    .map(b => fetch(`/api/notion/blocks/${b.id}`, { method: 'DELETE' }));
                await Promise.all(deletes);
            }
            const appendRes = await fetch(`/api/notion/blocks/${pageId}/children`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    children: [{
                        object: 'block',
                        type: 'code',
                        code: {
                            language: 'json',
                            rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }]
                        }
                    }]
                })
            });
            if (!appendRes.ok) throw new Error(`Failed to save metadata: ${appendRes.status}`);
        },

        /**
         * Create a child page under parentId with optional metadata code block.
         */
        async createChildPage(parentId, title, meta) {
            const children = [];
            if (meta) {
                children.push({
                    object: 'block',
                    type: 'code',
                    code: {
                        language: 'json',
                        rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }]
                    }
                });
            }
            const res = await fetch('/api/notion/pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: { page_id: parentId },
                    properties: { title: { title: [{ text: { content: title } }] } },
                    children
                })
            });
            if (!res.ok) throw new Error(`Create page failed: ${res.status}`);
            return await res.json();
        },

        /**
         * Update a page's title.
         */
        async updatePageTitle(pageId, title) {
            await fetch(`/api/notion/pages/${pageId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    properties: { title: { title: [{ text: { content: title } }] } }
                })
            });
        },

        /**
         * Archive (soft-delete) a page.
         */
        async archivePage(pageId) {
            await fetch(`/api/notion/pages/${pageId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: true })
            });
        },

        /**
         * Shared HTML escaping utilities. Replaces 4 copies across buildings.
         */
        escHtml(s) {
            const d = document.createElement('div');
            d.textContent = s || '';
            return d.innerHTML;
        },

        escAttr(s) {
            return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        }
    };
})();
