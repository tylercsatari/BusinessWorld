/**
 * Notes Service — Notion-backed ideas for the Library.
 * Each idea = a child page under the Ideas parent page.
 * Content stored as a code block with JSON metadata.
 */
const NotesService = (() => {
    let notes = [];
    let ideasPageId = '';

    async function loadConfig() {
        if (ideasPageId) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.notion && cfg.notion.ideasPageId) ideasPageId = cfg.notion.ideasPageId;
        } catch (e) { console.warn('NotesService: config load failed', e); }
    }

    async function fetchChildPages() {
        if (!ideasPageId) return [];
        const res = await fetch(`/api/notion/blocks/${ideasPageId}/children`);
        if (!res.ok) throw new Error(`Notion fetch failed: ${res.status}`);
        const data = await res.json();
        if (!data.results) return [];
        return data.results
            .filter(b => b.type === 'child_page' && !b.archived)
            .map(b => ({
                id: b.id,
                name: b.child_page.title,
                content: '',
                project: '',
                script: '',
                type: 'idea',
                lastEdited: b.last_edited_time || b.created_time || '',
                _loaded: false
            }));
    }

    async function loadPageContent(pageId) {
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (!res.ok) return { hook: '', context: '', project: '', script: '', type: 'idea' };
        const data = await res.json();
        if (!data.results) return { hook: '', context: '', project: '', script: '', type: 'idea' };

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
        return { hook: '', context: text, project: '', script: '', type: 'idea' };
    }

    async function savePageContent(pageId, meta) {
        // Get existing blocks to find and replace the code block
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (res.ok) {
            const data = await res.json();
            // Delete existing code blocks
            for (const block of (data.results || [])) {
                if (block.type === 'code') {
                    await fetch(`/api/notion/blocks/${block.id}`, { method: 'DELETE' });
                }
            }
        }
        // Append new code block with JSON
        await fetch(`/api/notion/blocks/${pageId}/children`, {
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
    }

    return {
        async sync() {
            await loadConfig();
            const pages = await fetchChildPages();
            // Load content for each page
            for (const page of pages) {
                try {
                    const meta = await loadPageContent(page.id);
                    page.content = JSON.stringify({ hook: meta.hook || '', context: meta.context || '' });
                    page.project = meta.project || '';
                    page.script = meta.script || '';
                    page.linkedScriptId = meta.linkedScriptId || '';
                    page.type = meta.type || 'idea';
                    if (meta.lastEdited) page.lastEdited = meta.lastEdited;
                    page._loaded = true;
                } catch (e) {
                    console.warn('NotesService: load content failed for', page.id, e);
                }
            }
            notes = pages;
            return notes;
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
                hook: '', context: '',
                project: data.project || '',
                script: data.script || '',
                linkedScriptId: data.linkedScriptId || '',
                type: data.type || 'idea',
                lastEdited: now
            };
            // Parse content if it's JSON
            if (data.content) {
                try {
                    const parsed = JSON.parse(data.content);
                    meta.hook = parsed.hook || '';
                    meta.context = parsed.context || '';
                } catch (e) { meta.context = data.content; }
            }

            // Create child page with code block
            const res = await fetch('/api/notion/pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: { page_id: ideasPageId },
                    properties: { title: { title: [{ text: { content: name } }] } },
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
            if (!res.ok) throw new Error(`Create idea failed: ${res.status}`);
            const result = await res.json();
            const note = {
                id: result.id,
                name,
                content: JSON.stringify({ hook: meta.hook, context: meta.context }),
                project: meta.project,
                script: meta.script,
                linkedScriptId: meta.linkedScriptId,
                type: meta.type,
                lastEdited: new Date().toISOString(),
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
                await fetch(`/api/notion/pages/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        properties: { title: { title: [{ text: { content: changes.name } }] } }
                    })
                });
                note.name = changes.name;
            }

            // Update content/project/script/type via code block
            let needsMetaUpdate = false;
            if (changes.content !== undefined) { note.content = changes.content; needsMetaUpdate = true; }
            if (changes.project !== undefined) { note.project = changes.project; needsMetaUpdate = true; }
            if (changes.script !== undefined) { note.script = changes.script; needsMetaUpdate = true; }
            if (changes.linkedScriptId !== undefined) { note.linkedScriptId = changes.linkedScriptId; needsMetaUpdate = true; }
            if (changes.type !== undefined) { note.type = changes.type; needsMetaUpdate = true; }

            if (needsMetaUpdate) {
                let hook = '', context = '';
                try {
                    const parsed = JSON.parse(note.content);
                    hook = parsed.hook || '';
                    context = parsed.context || '';
                } catch (e) { context = note.content; }
                const now = new Date().toISOString();
                await savePageContent(id, { hook, context, project: note.project, script: note.script || '', linkedScriptId: note.linkedScriptId || '', type: note.type, lastEdited: now });
                note.lastEdited = now;
            }

            return note;
        },

        async remove(id) {
            await fetch(`/api/notion/pages/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: true })
            });
            notes = notes.filter(n => n.id !== id);
        }
    };
})();
