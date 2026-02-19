/**
 * Notes Service — Notion-backed ideas for the Library.
 * Each idea = a child page under the Ideas parent page.
 * Content stored as a code block with JSON metadata (via NotionHelpers).
 *
 * Ideas store hook/context as top-level fields (matching Videos).
 */
const NotesService = (() => {
    let notes = [];
    let ideasPageId = '';
    let _lastSync = 0;
    let _syncPromise = null; // dedup concurrent sync() calls

    async function loadConfig() {
        if (ideasPageId) return;
        const cfg = await NotionHelpers.getConfig();
        if (cfg.notion && cfg.notion.ideasPageId) ideasPageId = cfg.notion.ideasPageId;
    }

    async function loadPageContent(pageId) {
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (!res.ok) return { hook: '', context: '', project: '', type: 'idea' };
        const data = await res.json();
        if (!data.results) return { hook: '', context: '', project: '', type: 'idea' };

        // Look for a code block with JSON metadata
        for (const block of data.results) {
            if (block.type === 'code') {
                const text = (block.code.rich_text || []).map(t => t.plain_text).join('');
                try { return JSON.parse(text); } catch (e) {}
            }
        }

        // Fallback: read paragraphs as plain text context
        const text = data.results
            .filter(b => b.type === 'paragraph')
            .map(b => (b.paragraph.rich_text || []).map(t => t.plain_text).join(''))
            .join('\n');
        return { hook: '', context: text, project: '', type: 'idea' };
    }

    return {
        async sync(force) {
            if (!force && notes.length > 0 && Date.now() - _lastSync < 60000) return notes;
            // Dedup concurrent sync() calls
            if (_syncPromise) return _syncPromise;
            _syncPromise = (async () => {
                await loadConfig();
                const pages = await NotionHelpers.fetchChildPages(ideasPageId);
                await Promise.all(pages.map(async page => {
                    try {
                        const meta = await loadPageContent(page.id);
                        // Store hook/context as top-level fields (matching Videos)
                        page.hook = meta.hook || '';
                        page.context = meta.context || '';
                        page.project = meta.project || '';
                        page.linkedScriptId = meta.linkedScriptId || '';
                        page.type = meta.type || 'idea';
                        if (meta.lastEdited) page.lastEdited = meta.lastEdited;
                        page._loaded = true;
                    } catch (e) {
                        console.warn('NotesService: load content failed for', page.id, e);
                    }
                }));
                notes = pages;
                _lastSync = Date.now();
                return notes;
            })();
            try { return await _syncPromise; } finally { _syncPromise = null; }
        },

        getAll() { return notes; },
        getByType(type) { return notes.filter(n => n.type === type); },
        getByProject(project) { return notes.filter(n => n.project === project); },
        getById(id) { return notes.find(n => n.id === id); },

        async create(data) {
            await loadConfig();
            if (!ideasPageId) throw new Error('Ideas page not configured');
            const name = data.name || 'Untitled';
            const now = new Date().toISOString();
            const meta = {
                hook: data.hook || '',
                context: data.context || '',
                project: data.project || '',
                linkedScriptId: data.linkedScriptId || '',
                type: data.type || 'idea',
                lastEdited: now
            };

            const result = await NotionHelpers.createChildPage(ideasPageId, name, meta);
            const note = {
                id: result.id,
                name,
                hook: meta.hook,
                context: meta.context,
                project: meta.project,
                linkedScriptId: meta.linkedScriptId,
                type: meta.type,
                lastEdited: now,
                _loaded: true
            };
            notes.push(note);
            return note;
        },

        async update(id, changes) {
            const note = notes.find(n => n.id === id);
            if (!note) return null;

            // Update title if changed
            if (changes.name !== undefined && changes.name !== note.name) {
                await NotionHelpers.updatePageTitle(id, changes.name);
                note.name = changes.name;
            }

            // Apply field changes
            let needsMetaUpdate = false;
            for (const key of ['hook', 'context', 'project', 'linkedScriptId', 'type']) {
                if (changes[key] !== undefined) {
                    note[key] = changes[key];
                    needsMetaUpdate = true;
                }
            }

            if (needsMetaUpdate) {
                const now = new Date().toISOString();
                await NotionHelpers.savePageMeta(id, {
                    hook: note.hook || '',
                    context: note.context || '',
                    project: note.project || '',
                    linkedScriptId: note.linkedScriptId || '',
                    type: note.type || 'idea',
                    lastEdited: now
                });
                note.lastEdited = now;
            }

            return note;
        },

        async remove(id) {
            await NotionHelpers.archivePage(id);
            notes = notes.filter(n => n.id !== id);
        }
    };
})();
