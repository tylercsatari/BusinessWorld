/**
 * Library UI — Apple Notes-style script editor with Notion sync.
 * Auto-saves to Notion as you type. No save button.
 */
const LibraryUI = (() => {
    let container = null;
    let videosPageId = '';
    let scripts = []; // { id, title, created, lastEdited, preview }
    let selectedId = null;
    let selectedBlocks = []; // block objects from Notion
    let saveTimer = null;
    let titleSaveTimer = null;
    let dirty = false;

    // --- Config ---
    async function loadConfig() {
        if (videosPageId) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.notion && cfg.notion.videosPageId) videosPageId = cfg.notion.videosPageId;
        } catch (e) { console.warn('Library: config load failed', e); }
    }

    // --- Notion API helpers ---
    async function fetchScripts() {
        if (!videosPageId) return [];
        try {
            const res = await fetch(`/api/notion/blocks/${videosPageId}/children`);
            const data = await res.json();
            if (!data.results) return [];
            return data.results
                .filter(b => b.type === 'child_page')
                .map(b => ({
                    id: b.id,
                    title: b.child_page.title,
                    created: b.created_time,
                    lastEdited: b.last_edited_time
                }));
        } catch (e) {
            console.warn('Library: fetch scripts failed', e);
            return [];
        }
    }

    async function fetchPageContent(pageId) {
        try {
            const res = await fetch(`/api/notion/blocks/${pageId}/children`);
            const data = await res.json();
            return data.results || [];
        } catch (e) {
            console.warn('Library: fetch content failed', e);
            return [];
        }
    }

    async function createPage(title, content) {
        const children = textToBlocks(content);
        const res = await fetch('/api/notion/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                parent: { page_id: videosPageId },
                properties: { title: { title: [{ text: { content: title } }] } },
                children
            })
        });
        if (!res.ok) throw new Error('Failed to create page');
        return await res.json();
    }

    async function updatePageTitle(pageId, title) {
        await fetch(`/api/notion/pages/${pageId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                properties: { title: { title: [{ text: { content: title } }] } }
            })
        });
    }

    async function archivePage(pageId) {
        await fetch(`/api/notion/pages/${pageId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: true })
        });
    }

    async function deleteBlock(blockId) {
        await fetch(`/api/notion/blocks/${blockId}`, { method: 'DELETE' });
    }

    async function appendBlocks(pageId, blocks) {
        await fetch(`/api/notion/blocks/${pageId}/children`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ children: blocks })
        });
    }

    // --- Text <-> Notion block conversion ---
    function blocksToText(blocks) {
        return blocks
            .filter(b => b.type === 'paragraph')
            .map(b => {
                const rt = b.paragraph && b.paragraph.rich_text;
                if (!rt || rt.length === 0) return '';
                return rt.map(t => t.plain_text || t.text?.content || '').join('');
            })
            .join('\n');
    }

    function textToBlocks(text) {
        const lines = text.split('\n');
        const blocks = lines.map(line => ({
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: line } }]
            }
        }));
        if (blocks.length === 0) {
            blocks.push({
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ type: 'text', text: { content: '' } }] }
            });
        }
        return blocks;
    }

    // --- Title helper: auto-append "Script" ---
    function ensureScriptSuffix(title) {
        const trimmed = title.trim();
        if (!trimmed) return '';
        if (/script$/i.test(trimmed)) return trimmed;
        return trimmed + ' Script';
    }

    // --- Relative date formatting (Apple Notes style) ---
    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = now - d;
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffDays === 0) {
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        } else if (diffDays === 1) {
            return 'Yesterday';
        } else if (diffDays < 7) {
            return d.toLocaleDateString('en-US', { weekday: 'long' });
        }
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // --- Save indicator ---
    function setSaveStatus(status) {
        const el = document.getElementById('library-save-status');
        if (!el) return;
        el.textContent = status;
        el.className = 'library-save-status' + (status === 'Saved' ? ' saved' : status === 'Saving...' ? ' saving' : '');
    }

    // --- Auto-save content (debounced) ---
    function scheduleContentSave() {
        dirty = true;
        setSaveStatus('Editing...');
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveContent(), 1500);
    }

    async function saveContent() {
        if (!selectedId || !dirty) return;
        const textarea = document.getElementById('library-editor-textarea');
        if (!textarea) return;

        setSaveStatus('Saving...');
        dirty = false;

        try {
            // Delete all existing blocks then re-create
            for (const block of selectedBlocks) {
                await deleteBlock(block.id);
            }
            const newBlocks = textToBlocks(textarea.value);
            await appendBlocks(selectedId, newBlocks);
            // Refresh block references
            selectedBlocks = await fetchPageContent(selectedId);
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: save failed', e);
            setSaveStatus('Save failed');
            dirty = true;
        }
    }

    // --- Auto-save title (debounced) ---
    function scheduleTitleSave() {
        if (titleSaveTimer) clearTimeout(titleSaveTimer);
        titleSaveTimer = setTimeout(() => saveTitleNow(), 1200);
    }

    async function saveTitleNow() {
        if (!selectedId) return;
        const input = document.getElementById('library-editor-title');
        if (!input) return;
        const rawTitle = input.value.trim();
        const title = ensureScriptSuffix(rawTitle);

        setSaveStatus('Saving...');
        try {
            await updatePageTitle(selectedId, title);
            // Update local list
            const script = scripts.find(s => s.id === selectedId);
            if (script) script.title = title;
            renderList();
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: title save failed', e);
            setSaveStatus('Save failed');
        }
    }

    // --- Render ---
    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="library-panel">
                <div class="library-sidebar">
                    <div class="library-sidebar-header">
                        <h2 class="library-sidebar-title">Scripts</h2>
                        <button class="library-new-btn" id="library-new-btn" title="New Script">+</button>
                    </div>
                    <div class="library-list" id="library-list">
                        <div class="library-empty">Loading...</div>
                    </div>
                </div>
                <div class="library-divider"></div>
                <div class="library-editor" id="library-editor">
                    <div class="library-editor-empty">
                        <div class="library-editor-empty-icon">📝</div>
                        <div>Select a script or create a new one</div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('library-new-btn').addEventListener('click', handleNew);
    }

    function renderList() {
        const listEl = document.getElementById('library-list');
        if (!listEl) return;

        if (scripts.length === 0) {
            listEl.innerHTML = '<div class="library-empty">No scripts yet</div>';
            return;
        }

        listEl.innerHTML = scripts.map(s => {
            const isSelected = s.id === selectedId;
            const date = formatDate(s.lastEdited || s.created);
            return `<div class="library-list-item${isSelected ? ' selected' : ''}" data-id="${s.id}">
                <div class="library-list-title">${escHtml(s.title)}</div>
                <div class="library-list-meta">
                    <span class="library-list-date">${date}</span>
                </div>
                <button class="library-delete-btn" data-id="${s.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

        // Click handlers
        listEl.querySelectorAll('.library-list-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('library-delete-btn')) return;
                selectScript(el.dataset.id);
            });
        });
        listEl.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDelete(btn.dataset.id);
            });
        });
    }

    function renderEditor(title, content) {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;

        // Strip "Script" suffix for the input so user sees just the base name
        const displayTitle = title.replace(/\s*Script$/i, '');

        editorEl.innerHTML = `
            <div class="library-editor-header">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title"
                        value="${escAttr(displayTitle)}" placeholder="Title" />
                    <span class="library-editor-suffix">Script</span>
                </div>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <textarea class="library-editor-textarea" id="library-editor-textarea"
                placeholder="Start writing...">${escHtml(content)}</textarea>
        `;

        // Auto-save on typing
        document.getElementById('library-editor-textarea').addEventListener('input', scheduleContentSave);
        document.getElementById('library-editor-title').addEventListener('input', scheduleTitleSave);
    }

    function renderEditorEmpty() {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;
        editorEl.innerHTML = `
            <div class="library-editor-empty">
                <div class="library-editor-empty-icon">📝</div>
                <div>Select a script or create a new one</div>
            </div>
        `;
    }

    // --- Actions ---
    async function selectScript(id) {
        // Save any pending changes first
        if (dirty && selectedId) await saveContent();

        selectedId = id;
        renderList(); // update selection highlight

        const editorEl = document.getElementById('library-editor');
        if (editorEl) editorEl.innerHTML = '<div class="library-loading">Loading...</div>';

        const script = scripts.find(s => s.id === id);
        selectedBlocks = await fetchPageContent(id);
        const content = blocksToText(selectedBlocks);
        renderEditor(script ? script.title : '', content);
    }

    async function handleNew() {
        const title = ensureScriptSuffix('Untitled');
        setSaveStatus('Creating...');

        try {
            const page = await createPage(title, '');
            const newScript = {
                id: page.id,
                title,
                created: page.created_time,
                lastEdited: page.last_edited_time
            };
            scripts.unshift(newScript);
            selectedId = page.id;
            selectedBlocks = [];
            renderList();
            renderEditor(title, '');
            // Focus the title input
            const titleInput = document.getElementById('library-editor-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: create failed', e);
            setSaveStatus('Create failed');
        }
    }

    async function handleDelete(id) {
        const script = scripts.find(s => s.id === id);
        if (!script) return;
        if (!confirm(`Delete "${script.title}"?`)) return;

        try {
            await archivePage(id);
            scripts = scripts.filter(s => s.id !== id);
            if (selectedId === id) {
                selectedId = scripts.length > 0 ? scripts[0].id : null;
                if (selectedId) {
                    await selectScript(selectedId);
                } else {
                    renderEditorEmpty();
                }
            }
            renderList();
        } catch (e) {
            console.warn('Library: delete failed', e);
        }
    }

    // --- Helpers ---
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // --- Public ---
    return {
        async open(bodyEl) {
            await loadConfig();
            render(bodyEl);
            scripts = await fetchScripts();
            renderList();
            // Auto-select first script
            if (scripts.length > 0) {
                selectScript(scripts[0].id);
            }
        },
        close() {
            // Flush pending saves
            if (saveTimer) { clearTimeout(saveTimer); saveContent(); }
            if (titleSaveTimer) { clearTimeout(titleSaveTimer); saveTitleNow(); }
            container = null;
            selectedId = null;
            selectedBlocks = [];
            dirty = false;
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl) => LibraryUI.open(bodyEl),
    close: () => LibraryUI.close()
});
