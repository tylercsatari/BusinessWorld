/**
 * Library UI — Apple Notes-style script editor with Notion sync.
 * Two-page navigation: script list → full-screen editor with back button.
 * Auto-saves to Notion as you type.
 */
const LibraryUI = (() => {
    let container = null;
    let videosPageId = '';
    let scripts = [];
    let selectedId = null;
    let selectedBlocks = [];
    let saveTimer = null;
    let titleSaveTimer = null;
    let dirty = false;
    let currentPage = 'list'; // 'list' or 'editor'

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

    function ensureScriptSuffix(title) {
        const trimmed = title.trim();
        if (!trimmed) return '';
        if (/script$/i.test(trimmed)) return trimmed;
        return trimmed + ' Script';
    }

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
            for (const block of selectedBlocks) {
                await deleteBlock(block.id);
            }
            const newBlocks = textToBlocks(textarea.value);
            await appendBlocks(selectedId, newBlocks);
            selectedBlocks = await fetchPageContent(selectedId);
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: save failed', e);
            setSaveStatus('Save failed');
            dirty = true;
        }
    }

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
            const script = scripts.find(s => s.id === selectedId);
            if (script) script.title = title;
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: title save failed', e);
            setSaveStatus('Save failed');
        }
    }

    // --- Page navigation ---
    function showListPage() {
        currentPage = 'list';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-editor');
        panel.classList.add('show-list');
        // Re-render list to reflect any title changes
        renderList();
    }

    function showEditorPage() {
        currentPage = 'editor';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-list');
        panel.classList.add('show-editor');
    }

    // --- Render ---
    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="library-panel show-list">
                <div class="library-page library-list-page" id="library-list-page">
                    <div class="library-list-header">
                        <h2 class="library-list-heading">Scripts</h2>
                        <button class="library-new-btn" id="library-new-btn" title="New Script">+</button>
                    </div>
                    <div class="library-list" id="library-list">
                        <div class="library-empty">Loading...</div>
                    </div>
                </div>
                <div class="library-page library-editor-page" id="library-editor-page">
                    <div class="library-editor" id="library-editor">
                        <div class="library-editor-empty">
                            <div class="library-editor-empty-icon">📝</div>
                            <div>Select a script or create a new one</div>
                        </div>
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
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(s.title)}</div>
                    <div class="library-list-date">${date}</div>
                </div>
                <button class="library-delete-btn" data-id="${s.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

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

        const displayTitle = title.replace(/\s*Script$/i, '');

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Scripts
                </button>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title"
                        value="${escAttr(displayTitle)}" placeholder="Title" />
                    <span class="library-editor-suffix">Script</span>
                </div>
                <textarea class="library-editor-textarea" id="library-editor-textarea"
                    placeholder="Start writing...">${escHtml(content)}</textarea>
            </div>
        `;

        document.getElementById('library-back-btn').addEventListener('click', handleBack);
        document.getElementById('library-editor-textarea').addEventListener('input', scheduleContentSave);
        document.getElementById('library-editor-title').addEventListener('input', scheduleTitleSave);
    }

    // --- Actions ---
    async function handleBack() {
        if (dirty && selectedId) await saveContent();
        showListPage();
    }

    async function selectScript(id) {
        if (dirty && selectedId) await saveContent();

        selectedId = id;
        renderList();
        showEditorPage();

        const editorEl = document.getElementById('library-editor');
        if (editorEl) editorEl.innerHTML = '<div class="library-loading">Loading...</div>';

        const script = scripts.find(s => s.id === id);
        selectedBlocks = await fetchPageContent(id);
        const content = blocksToText(selectedBlocks);
        renderEditor(script ? script.title : '', content);
    }

    async function handleNew() {
        const title = ensureScriptSuffix('Untitled');

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
            showEditorPage();
            renderEditor(title, '');
            const titleInput = document.getElementById('library-editor-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
            setSaveStatus('Saved');
        } catch (e) {
            console.warn('Library: create failed', e);
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
                selectedId = null;
                selectedBlocks = [];
                if (currentPage === 'editor') showListPage();
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
        },
        close() {
            if (saveTimer) { clearTimeout(saveTimer); saveContent(); }
            if (titleSaveTimer) { clearTimeout(titleSaveTimer); saveTitleNow(); }
            container = null;
            selectedId = null;
            selectedBlocks = [];
            dirty = false;
            currentPage = 'list';
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl) => LibraryUI.open(bodyEl),
    close: () => LibraryUI.close()
});
