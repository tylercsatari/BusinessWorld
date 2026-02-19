/**
 * Library UI — Scripts, Ideas, and To-Do list.
 * Scripts tab: Notion-backed script editor.
 * Ideas tab: Notion-backed ideas with hook + context (via NotesService).
 * To-Do tab: Notion-backed to_do blocks.
 */
const LibraryUI = (() => {
    let container = null;
    let videosPageId = '';
    let todoPageId = '';
    let scripts = [];
    let selectedId = null;
    let selectedBlocks = [];
    let selectedScriptMeta = null; // {project, linkedIdeaId, linkedVideoId}
    let saveTimer = null;
    let titleSaveTimer = null;
    let dirty = false;
    let currentPage = 'list';
    let activeTab = 'scripts';
    let selectedNote = null;
    let noteSaveTimer = null;
    let noteDirty = false;
    let todoItems = [];  // [{id, text, done}] — Notion to_do blocks
    let selectedVideo = null;
    let videoSaveTimer = null;
    let videoDirty = false;

    // --- Idea content helpers (JSON in content field) ---
    function parseIdeaContent(content) {
        if (!content) return { hook: '', context: '' };
        try {
            const obj = JSON.parse(content);
            return { hook: obj.hook || '', context: obj.context || '' };
        } catch (e) {
            // Legacy plain text — treat as context
            return { hook: '', context: content };
        }
    }
    function ideaContentToString(hook, context) {
        return JSON.stringify({ hook, context });
    }

    // --- Config ---
    async function loadConfig() {
        if (videosPageId) return;
        try {
            const res = await fetch('/api/config');
            const cfg = await res.json();
            if (cfg.notion) {
                if (cfg.notion.videosPageId) videosPageId = cfg.notion.videosPageId;
                if (cfg.notion.todoPageId) todoPageId = cfg.notion.todoPageId;
            }
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
                .map(b => ({ id: b.id, title: b.child_page.title, project: '', created: b.created_time, lastEdited: b.last_edited_time }));
        } catch (e) { console.warn('Library: fetch scripts failed', e); return []; }
    }

    async function fetchPageContent(pageId) {
        try {
            const res = await fetch(`/api/notion/blocks/${pageId}/children`);
            const data = await res.json();
            return data.results || [];
        } catch (e) { console.warn('Library: fetch content failed', e); return []; }
    }

    async function createPage(title, content) {
        const children = textToBlocks(content);
        const res = await fetch('/api/notion/pages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent: { page_id: videosPageId }, properties: { title: { title: [{ text: { content: title } }] } }, children })
        });
        if (!res.ok) throw new Error('Failed to create page');
        return await res.json();
    }

    async function updatePageTitle(pageId, title) {
        await fetch(`/api/notion/pages/${pageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ properties: { title: { title: [{ text: { content: title } }] } } }) });
    }

    async function archivePage(pageId) {
        await fetch(`/api/notion/pages/${pageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    }

    async function deleteBlock(blockId) { await fetch(`/api/notion/blocks/${blockId}`, { method: 'DELETE' }); }

    async function appendBlocks(pageId, blocks) {
        await fetch(`/api/notion/blocks/${pageId}/children`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ children: blocks }) });
    }

    function blocksToText(blocks) {
        return blocks.filter(b => b.type === 'paragraph').map(b => {
            const rt = b.paragraph && b.paragraph.rich_text;
            if (!rt || rt.length === 0) return '';
            return rt.map(t => t.plain_text || t.text?.content || '').join('');
        }).join('\n');
    }

    function extractScriptMeta(blocks) {
        for (const b of blocks) {
            if (b.type === 'code') {
                const text = (b.code.rich_text || []).map(t => t.plain_text).join('');
                try { return JSON.parse(text); } catch (e) {}
            }
        }
        return { project: '' };
    }

    async function saveScriptMeta(pageId, meta) {
        // Find and delete existing code blocks, then append new one
        const res = await fetch(`/api/notion/blocks/${pageId}/children`);
        if (res.ok) {
            const data = await res.json();
            for (const block of (data.results || [])) {
                if (block.type === 'code') {
                    await fetch(`/api/notion/blocks/${block.id}`, { method: 'DELETE' });
                }
            }
        }
        await appendBlocks(pageId, [{
            object: 'block', type: 'code',
            code: { language: 'json', rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }] }
        }]);
    }

    function textToBlocks(text) {
        const lines = text.split('\n');
        const blocks = lines.map(line => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } }));
        if (blocks.length === 0) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '' } }] } });
        return blocks;
    }

    function ensureScriptSuffix(title) {
        const t = title.trim();
        if (!t) return '';
        return /script$/i.test(t) ? t : t + ' Script';
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const now = new Date();
        const diff = Math.floor((now - d) / 86400000);
        if (diff === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function setSaveStatus(status) {
        const el = document.getElementById('library-save-status');
        if (!el) return;
        el.textContent = status;
        el.className = 'library-save-status' + (status === 'Saved' ? ' saved' : status === 'Saving...' ? ' saving' : '');
    }

    // --- Script auto-save ---
    function scheduleContentSave() {
        dirty = true; setSaveStatus('Editing...');
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveContent(), 1500);
    }

    async function saveContent() {
        if (!selectedId || !dirty) return;
        const textarea = document.getElementById('library-editor-textarea');
        if (!textarea) return;
        setSaveStatus('Saving...'); dirty = false;
        try {
            for (const block of selectedBlocks) await deleteBlock(block.id);
            const blocks = textToBlocks(textarea.value);
            // Append metadata code block if we have metadata
            if (selectedScriptMeta) {
                const projectEl = document.getElementById('library-script-project');
                if (projectEl) selectedScriptMeta.project = projectEl.value;
                blocks.push({ object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text', text: { content: JSON.stringify(selectedScriptMeta) } }] } });
            }
            await appendBlocks(selectedId, blocks);
            selectedBlocks = await fetchPageContent(selectedId);
            setSaveStatus('Saved');
        } catch (e) { console.warn('Library: save failed', e); setSaveStatus('Save failed'); dirty = true; }
    }

    function scheduleTitleSave() {
        if (titleSaveTimer) clearTimeout(titleSaveTimer);
        titleSaveTimer = setTimeout(() => saveTitleNow(), 1200);
    }

    async function saveTitleNow() {
        if (!selectedId) return;
        const input = document.getElementById('library-editor-title');
        if (!input) return;
        const title = ensureScriptSuffix(input.value.trim());
        setSaveStatus('Saving...');
        try {
            await updatePageTitle(selectedId, title);
            const s = scripts.find(s => s.id === selectedId);
            if (s) s.title = title;
            setSaveStatus('Saved');
        } catch (e) { console.warn('Library: title save failed', e); setSaveStatus('Save failed'); }
    }

    // --- Navigation ---
    function showListPage() {
        currentPage = 'list';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-editor');
        panel.classList.add('show-list');
        if (activeTab === 'scripts') renderList();
        else if (activeTab === 'notes') renderNotesList();
        else if (activeTab === 'projects') renderProjectsList();
    }

    function showEditorPage() {
        currentPage = 'editor';
        const panel = container.querySelector('.library-panel');
        if (!panel) return;
        panel.classList.remove('show-list');
        panel.classList.add('show-editor');
    }

    // --- Main render ---
    function render(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <div class="library-panel show-list">
                <div class="library-page library-list-page" id="library-list-page">
                    <div class="library-tabs">
                        <button class="library-tab active" data-tab="scripts">Scripts</button>
                        <button class="library-tab" data-tab="notes">Ideas</button>
                        <button class="library-tab" data-tab="todo">To-Do</button>
                        <button class="library-tab" data-tab="projects">Projects</button>
                    </div>
                    <div class="library-list-header" id="library-list-header">
                        <h2 class="library-list-heading" id="library-list-heading">Scripts</h2>
                        <button class="library-new-btn" id="library-new-btn" title="New">+</button>
                    </div>
                    <div class="library-list" id="library-list"><div class="library-empty">Loading...</div></div>
                    <div class="library-notes-list" id="library-notes-list" style="display:none;"><div class="library-empty">Loading...</div></div>
                    <div class="library-todo-container" id="library-todo-container" style="display:none;"></div>
                    <div class="library-projects-container" id="library-projects-container" style="display:none;"></div>
                </div>
                <div class="library-page library-editor-page" id="library-editor-page">
                    <div class="library-editor" id="library-editor">
                        <div class="library-editor-empty"><div class="library-editor-empty-icon">📝</div><div>Select a script or create a new one</div></div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('library-new-btn').addEventListener('click', () => {
            if (activeTab === 'scripts') handleNew();
            else if (activeTab === 'notes') handleNewNote();
            // todo uses inline input, no + button action needed — but we'll focus the input
            else if (activeTab === 'todo') focusTodoInput();
        });
        container.querySelectorAll('.library-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        container.querySelectorAll('.library-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        const heading = document.getElementById('library-list-heading');
        const scriptList = document.getElementById('library-list');
        const notesList = document.getElementById('library-notes-list');
        const todoContainer = document.getElementById('library-todo-container');
        const projectsContainer = document.getElementById('library-projects-container');

        if (scriptList) scriptList.style.display = 'none';
        if (notesList) notesList.style.display = 'none';
        if (todoContainer) todoContainer.style.display = 'none';
        if (projectsContainer) projectsContainer.style.display = 'none';

        const newBtn = document.getElementById('library-new-btn');

        if (tab === 'scripts') {
            if (heading) heading.textContent = 'Scripts';
            if (scriptList) scriptList.style.display = '';
            if (newBtn) newBtn.style.display = '';
        } else if (tab === 'notes') {
            if (heading) heading.textContent = 'Ideas';
            if (notesList) notesList.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderNotesList();
        } else if (tab === 'todo') {
            if (heading) heading.textContent = 'To-Do';
            if (todoContainer) todoContainer.style.display = '';
            if (newBtn) newBtn.style.display = '';
            renderTodoList();
            if (todoLoaded) backgroundRefreshTodo();
        } else if (tab === 'projects') {
            if (heading) heading.textContent = 'Projects';
            if (projectsContainer) projectsContainer.style.display = '';
            if (newBtn) newBtn.style.display = 'none';
            renderProjectsList();
        }
    }

    // =====================
    // --- TO-DO LIST (Notion to_do blocks) ---
    // =====================
    let todoLoaded = false;

    async function fetchTodoItems() {
        if (!todoPageId) return [];
        const res = await fetch(`/api/notion/blocks/${todoPageId}/children`);
        if (!res.ok) return [];
        const data = await res.json();
        if (!data.results) return [];
        return data.results
            .filter(b => b.type === 'to_do')
            .map(b => ({
                id: b.id,
                text: (b.to_do.rich_text || []).map(t => t.plain_text).join(''),
                done: b.to_do.checked || false
            }));
    }

    let todoBusy = false; // true while an add/delete/toggle API call is in progress

    function renderTodoList() {
        const el = document.getElementById('library-todo-container');
        if (!el) return;

        if (!todoLoaded) {
            el.innerHTML = '<div class="library-empty">Loading to-do list...</div>';
            fetchTodoItems().then(items => {
                todoItems = items;
                todoLoaded = true;
                renderTodoList();
                updateTodoBadge();
            }).catch(() => {
                el.innerHTML = '<div class="library-empty">Could not load to-do list.</div>';
            });
            return;
        }

        renderTodoContent(el);
    }

    // Background refresh — only called when switching to the tab, not on every render
    function backgroundRefreshTodo() {
        if (todoBusy) return; // don't overwrite optimistic updates mid-operation
        fetchTodoItems().then(freshItems => {
            if (todoBusy) return; // check again after await
            if (freshItems && freshItems.length >= 0) {
                todoItems = freshItems;
                updateTodoBadge();
                const currentEl = document.getElementById('library-todo-container');
                if (currentEl) renderTodoContent(currentEl);
            }
        }).catch(() => {});
    }

    function renderTodoContent(el) {
        if (!el) return;

        el.innerHTML = `
            <div class="library-todo-input-row">
                <input type="text" class="library-todo-input" id="library-todo-input" placeholder="Add a new task..." />
                <button class="library-todo-add-btn" id="library-todo-add-btn">Add</button>
            </div>
            ${todoItems.length === 0 ? '<div class="library-todo-empty">No tasks yet. Type above to add one.</div>' : ''}
            <div class="library-todo-items" id="library-todo-items">
                ${todoItems.map((item, i) => `
                    <div class="library-todo-item ${item.done ? 'done' : ''}" data-idx="${i}">
                        <button class="library-todo-check" data-idx="${i}">${item.done ? '&#10003;' : ''}</button>
                        <span class="library-todo-text">${escHtml(item.text)}</span>
                        <button class="library-todo-delete" data-idx="${i}">&times;</button>
                    </div>
                `).join('')}
            </div>
        `;

        const input = document.getElementById('library-todo-input');
        const addBtn = document.getElementById('library-todo-add-btn');

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
                addTodoItem(input.value.trim());
                input.value = '';
            }
        });
        addBtn.addEventListener('click', () => {
            if (input.value.trim()) {
                addTodoItem(input.value.trim());
                input.value = '';
                input.focus();
            }
        });

        el.querySelectorAll('.library-todo-check').forEach(btn => {
            btn.addEventListener('click', () => toggleTodoItem(parseInt(btn.dataset.idx)));
        });
        el.querySelectorAll('.library-todo-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteTodoItem(parseInt(btn.dataset.idx)));
        });
    }

    function focusTodoInput() {
        const input = document.getElementById('library-todo-input');
        if (input) input.focus();
    }

    async function addTodoItem(text) {
        if (!todoPageId) { alert('To-Do page not configured.'); return; }
        todoBusy = true;
        const tempItem = { id: null, text, done: false };
        todoItems.unshift(tempItem);
        renderTodoList();
        updateTodoBadge();

        try {
            const res = await fetch(`/api/notion/blocks/${todoPageId}/children`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    children: [{
                        object: 'block',
                        type: 'to_do',
                        to_do: {
                            rich_text: [{ type: 'text', text: { content: text } }],
                            checked: false
                        }
                    }]
                })
            });
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            const newBlock = data.results && data.results[0];
            if (newBlock) tempItem.id = newBlock.id;
        } catch (e) {
            console.warn('Library: add todo failed', e);
            todoItems = todoItems.filter(i => i !== tempItem);
            renderTodoList();
            updateTodoBadge();
            alert('Failed to add task. Check connection.');
        } finally {
            todoBusy = false;
        }
    }

    async function toggleTodoItem(idx) {
        if (idx < 0 || idx >= todoItems.length) return;
        todoBusy = true;
        const item = todoItems[idx];
        item.done = !item.done;
        renderTodoList();
        updateTodoBadge();

        if (item.id) {
            try {
                await fetch(`/api/notion/blocks/${item.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to_do: {
                            rich_text: [{ type: 'text', text: { content: item.text } }],
                            checked: item.done
                        }
                    })
                });
            } catch (e) {
                console.warn('Library: toggle todo failed', e);
                item.done = !item.done;
                renderTodoList();
                updateTodoBadge();
            }
        }
        todoBusy = false;
    }

    async function deleteTodoItem(idx) {
        if (idx < 0 || idx >= todoItems.length) return;
        if (!confirm('Delete this task?')) return;
        todoBusy = true;
        const item = todoItems[idx];
        todoItems.splice(idx, 1);
        renderTodoList();
        updateTodoBadge();

        if (item.id) {
            try {
                const res = await fetch(`/api/notion/blocks/${item.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('Delete failed');
            } catch (e) {
                console.warn('Library: delete todo failed', e);
                todoItems.splice(idx, 0, item);
                renderTodoList();
                updateTodoBadge();
                alert('Failed to delete task. It has been restored.');
            }
        }
        todoBusy = false;
    }

    // =====================
    // --- IDEAS ---
    // =====================
    function renderNotesList() {
        const el = document.getElementById('library-notes-list');
        if (!el) return;
        const ideas = NotesService.getAll().filter(n => n.type !== 'todo')
            .sort((a, b) => (b.lastEdited || '').localeCompare(a.lastEdited || ''));
        if (ideas.length === 0) {
            el.innerHTML = '<div class="library-empty">No ideas yet. Tap + to add one.</div>';
            return;
        }
        el.innerHTML = ideas.map(n => {
            const isConverted = n.type === 'converted';
            const parsed = parseIdeaContent(n.content);
            const preview = parsed.hook || parsed.context || '';
            const badge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(n.project) : '';
            // Show actual pipeline status if converted
            let statusHtml = '';
            if (isConverted) {
                const linkedVideo = VideoService.getByIdeaId(n.id);
                if (linkedVideo && window.EggRenderer) {
                    statusHtml = ' ' + window.EggRenderer.statusBadgeHtml(linkedVideo.status);
                } else {
                    statusHtml = ' <span class="library-converted-badge-inline">Sent</span>';
                }
            }
            return `
            <div class="library-list-item ${isConverted ? 'converted' : ''}" data-note-id="${n.id}">
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(n.name)}${statusHtml}</div>
                    <div class="library-list-date">${badge}${!badge ? escHtml(preview ? preview.substring(0, 60) : 'idea') : ''}</div>
                </div>
                <button class="library-delete-btn" data-note-id="${n.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-list-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('library-delete-btn')) return;
                selectNote(item.dataset.noteId);
            });
        });
        el.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteNote(btn.dataset.noteId); });
        });
    }

    function selectNote(id) {
        selectedNote = NotesService.getById(id);
        if (!selectedNote) return;
        showEditorPage();
        renderNoteEditor(selectedNote);
    }

    async function renderNoteEditor(note) {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;

        let projectOptions = '';
        try {
            const projs = await VideoService.getProjects();
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${p === note.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}

        const isConverted = note.type === 'converted';
        let linkedVideo = null;
        if (isConverted) linkedVideo = VideoService.getByIdeaId(note.id);

        let incubatorSection = '';
        if (isConverted && linkedVideo) {
            const stBadge = window.EggRenderer ? window.EggRenderer.statusBadgeHtml(linkedVideo.status) : linkedVideo.status;
            incubatorSection = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">${stBadge}</div><div class="library-linked-video">Video: ${escHtml(linkedVideo.name)}</div>`;
        } else if (isConverted) {
            incubatorSection = `<div class="library-converted-badge">Sent to Incubator</div>`;
        } else {
            incubatorSection = `<button class="library-send-btn" id="library-send-incubator">Send to Incubator</button>`;
        }

        const parsed = parseIdeaContent(note.content);

        // Script linker section
        let scriptSection = '';
        if (note.linkedScriptId) {
            const linkedScript = scripts.find(s => s.id === note.linkedScriptId);
            const scriptName = linkedScript ? linkedScript.title : 'Linked Script';
            scriptSection = `
                <div class="library-idea-field">
                    <label class="library-idea-label">Script</label>
                    <div class="library-script-linked">
                        <span class="library-script-badge">${escHtml(scriptName)}</span>
                        <button class="library-script-open-btn" id="library-open-script">Open</button>
                        <button class="library-script-unlink-btn" id="library-unlink-script">Unlink</button>
                    </div>
                </div>`;
        } else {
            scriptSection = `
                <div class="library-idea-field">
                    <label class="library-idea-label">Script</label>
                    <div class="library-script-actions">
                        <button class="library-script-link-btn" id="library-link-script">Link Script</button>
                        <button class="library-script-new-btn" id="library-new-script-for-idea">New Script</button>
                    </div>
                </div>`;
        }

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Ideas
                </button>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title" value="${escAttr(note.name)}" placeholder="Idea title..." />
                </div>
                <div class="library-meta-row">
                    <label class="library-meta-label">Project</label>
                    <select class="library-project-select" id="library-note-project">
                        <option value="">None (optional)</option>
                        ${projectOptions}
                    </select>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Hook</label>
                    <textarea class="library-idea-hook" id="library-idea-hook" placeholder="What's the hook? (optional)">${escHtml(parsed.hook)}</textarea>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Context</label>
                    <textarea class="library-idea-context" id="library-idea-context" placeholder="More details, angles, notes... (optional)">${escHtml(parsed.context)}</textarea>
                </div>
                ${scriptSection}
                <div class="library-incubator-section">${incubatorSection}</div>
            </div>
            <div class="library-script-picker-overlay" id="library-script-picker-overlay" style="display:none;">
                <div class="library-script-picker">
                    <div class="library-script-picker-header">
                        <h3>Link a Script</h3>
                        <button class="library-script-picker-close" id="library-script-picker-close">&times;</button>
                    </div>
                    <div class="library-script-picker-list" id="library-script-picker-list"></div>
                </div>
            </div>
        `;
        document.getElementById('library-back-btn').addEventListener('click', () => saveNoteAndBack());
        document.getElementById('library-idea-hook').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-idea-context').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-editor-title').addEventListener('input', scheduleNoteSave);
        document.getElementById('library-note-project').addEventListener('change', scheduleNoteSave);
        const sendBtn = document.getElementById('library-send-incubator');
        if (sendBtn) sendBtn.addEventListener('click', () => sendToIncubator());

        // Script linker events
        const linkBtn = document.getElementById('library-link-script');
        if (linkBtn) linkBtn.addEventListener('click', () => showIdeaScriptPicker());
        const newScriptBtn = document.getElementById('library-new-script-for-idea');
        if (newScriptBtn) newScriptBtn.addEventListener('click', () => createScriptForIdea());
        const unlinkBtn = document.getElementById('library-unlink-script');
        if (unlinkBtn) unlinkBtn.addEventListener('click', () => unlinkScriptFromIdea());
        const openBtn = document.getElementById('library-open-script');
        if (openBtn) openBtn.addEventListener('click', () => {
            if (note.linkedScriptId) { switchTab('scripts'); selectScript(note.linkedScriptId); }
        });
        const pickerClose = document.getElementById('library-script-picker-close');
        if (pickerClose) pickerClose.addEventListener('click', () => {
            document.getElementById('library-script-picker-overlay').style.display = 'none';
        });
        const pickerOverlay = document.getElementById('library-script-picker-overlay');
        if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) pickerOverlay.style.display = 'none';
        });
    }

    function getLinkedScriptIds() {
        // Collect all linkedScriptIds from all ideas and videos
        const fromIdeas = NotesService.getAll().filter(n => n.linkedScriptId).map(n => n.linkedScriptId);
        const fromVideos = VideoService.getAll().filter(v => v.linkedScriptId).map(v => v.linkedScriptId);
        const currentId = selectedNote ? selectedNote.linkedScriptId : '';
        const set = new Set([...fromIdeas, ...fromVideos]);
        if (currentId) set.delete(currentId); // don't exclude the current note's own linked script
        return set;
    }

    function showIdeaScriptPicker() {
        const overlay = document.getElementById('library-script-picker-overlay');
        const listEl = document.getElementById('library-script-picker-list');
        if (!overlay || !listEl) return;

        const linkedIds = getLinkedScriptIds();
        const available = scripts.filter(s => !linkedIds.has(s.id));

        if (available.length === 0) {
            listEl.innerHTML = '<div class="library-empty">No available scripts. Create one with "New Script".</div>';
        } else {
            listEl.innerHTML = available.map(s => `
                <div class="library-script-picker-item" data-id="${s.id}">
                    <div class="library-script-picker-info">
                        <div class="library-script-picker-name">${escHtml(s.title)}</div>
                        <div class="library-script-picker-project">${escHtml(s.project || 'No project')}</div>
                    </div>
                    <button class="library-script-picker-link-btn" data-id="${s.id}">Link</button>
                </div>`).join('');
            async function doLink(scriptId) {
                if (!selectedNote) return;
                try {
                    await NotesService.update(selectedNote.id, { linkedScriptId: scriptId });
                    selectedNote = NotesService.getById(selectedNote.id);
                    overlay.style.display = 'none';
                    renderNoteEditor(selectedNote);
                } catch (e) {
                    console.warn('Library: link script failed', e);
                    alert('Failed to link script.');
                }
            }
            listEl.querySelectorAll('.library-script-picker-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); doLink(btn.dataset.id); });
            });
            listEl.querySelectorAll('.library-script-picker-item').forEach(item => {
                item.addEventListener('click', () => doLink(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    async function createScriptForIdea() {
        if (!selectedNote) return;
        const btn = document.getElementById('library-new-script-for-idea');
        if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }
        try {
            const title = ensureScriptSuffix(selectedNote.name || 'Untitled');
            const page = await createPage(title, '');
            const meta = { project: selectedNote.project || '', linkedIdeaId: selectedNote.id };
            await saveScriptMeta(page.id, meta);
            scripts.unshift({ id: page.id, title, project: meta.project, created: page.created_time, lastEdited: page.last_edited_time });
            await NotesService.update(selectedNote.id, { linkedScriptId: page.id });
            selectedNote = NotesService.getById(selectedNote.id);
            renderNoteEditor(selectedNote);
        } catch (e) {
            console.warn('Library: create script for idea failed', e);
            alert('Failed to create script.');
        } finally {
            if (btn) { btn.textContent = 'New Script'; btn.disabled = false; }
        }
    }

    async function unlinkScriptFromIdea() {
        if (!selectedNote) return;
        await NotesService.update(selectedNote.id, { linkedScriptId: '' });
        selectedNote = NotesService.getById(selectedNote.id);
        renderNoteEditor(selectedNote);
    }

    async function sendToIncubator() {
        if (!selectedNote) return;
        const existing = VideoService.getByIdeaId(selectedNote.id);
        if (existing) { alert('This idea has already been sent to the Incubator.'); return; }

        const name = document.getElementById('library-editor-title')?.value.trim() || selectedNote.name || 'Untitled';
        const hookEl = document.getElementById('library-idea-hook');
        const ctxEl = document.getElementById('library-idea-context');
        const projectEl = document.getElementById('library-note-project');
        const hook = hookEl?.value || '';
        const context = ctxEl?.value || '';
        const project = projectEl?.value || '';

        try {
            await VideoService.create({ name, hook, context, project, sourceIdeaId: selectedNote.id });
            await NotesService.update(selectedNote.id, { type: 'converted' });
            selectedNote = NotesService.getById(selectedNote.id);
            renderNoteEditor(selectedNote);
        } catch (e) { console.warn('Library: send to incubator failed', e); alert('Failed to send to Incubator. Check connection.'); }
    }

    function scheduleNoteSave() {
        noteDirty = true; setSaveStatus('Editing...');
        if (noteSaveTimer) clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => saveNote(), 1500);
    }

    async function saveNote() {
        if (!selectedNote || !noteDirty) return;
        const titleEl = document.getElementById('library-editor-title');
        const hookEl = document.getElementById('library-idea-hook');
        const ctxEl = document.getElementById('library-idea-context');
        const projectEl = document.getElementById('library-note-project');
        if (!titleEl) return;
        setSaveStatus('Saving...'); noteDirty = false;
        try {
            const content = ideaContentToString(hookEl?.value || '', ctxEl?.value || '');
            const newName = titleEl.value.trim() || 'Untitled';
            const newProject = projectEl?.value || '';
            await NotesService.update(selectedNote.id, {
                name: newName,
                content,
                project: newProject
            });
            selectedNote = NotesService.getById(selectedNote.id);
            // Bidirectional sync: if this idea has a linked video, update it too
            const linkedVideo = VideoService.getByIdeaId(selectedNote.id);
            if (linkedVideo) {
                const newHook = hookEl?.value || '';
                const newContext = ctxEl?.value || '';
                VideoService.update(linkedVideo.id, { name: newName, hook: newHook, context: newContext, project: newProject }).catch(() => {});
            }
            setSaveStatus('Saved');
        } catch (e) { setSaveStatus('Save failed'); noteDirty = true; }
    }

    async function saveNoteAndBack() {
        if (noteDirty && selectedNote) await saveNote();
        selectedNote = null;
        showListPage();
        renderNotesList();
    }

    async function handleNewNote() {
        try {
            const note = await NotesService.create({ name: 'Untitled', type: 'idea', content: ideaContentToString('', '') });
            selectedNote = note;
            showEditorPage();
            await renderNoteEditor(note);
            const titleInput = document.getElementById('library-editor-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
        } catch (e) {
            console.warn('Library: create note failed', e);
            alert('Failed to create idea. Check connection.');
        }
    }

    async function handleDeleteNote(id) {
        const note = NotesService.getById(id);
        if (!note || !confirm(`Delete "${note.name}"?`)) return;
        try {
            await NotesService.remove(id);
            if (selectedNote && selectedNote.id === id) { selectedNote = null; if (currentPage === 'editor') showListPage(); }
            renderNotesList();
        } catch (e) { console.warn('Library: delete note failed', e); }
    }

    // =====================
    // --- VIDEO EDITOR (from Projects tab) ---
    // =====================

    function openVideoEditor(videoId) {
        selectedVideo = VideoService.getById(videoId);
        if (!selectedVideo) return;
        showEditorPage();
        renderVideoEditor();
    }

    async function renderVideoEditor() {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl || !selectedVideo) return;
        const v = selectedVideo;

        const statusBadge = window.EggRenderer ? window.EggRenderer.statusBadgeHtml(v.status) : v.status;

        let projectOptions = '';
        try {
            const projs = await VideoService.getProjects();
            projectOptions = projs.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('');
        } catch (e) {}

        // Script linker
        let scriptSection = '';
        if (v.linkedScriptId) {
            const linkedScript = scripts.find(s => s.id === v.linkedScriptId);
            const scriptName = linkedScript ? linkedScript.title : 'Linked Script';
            scriptSection = `
                <div class="library-idea-field">
                    <label class="library-idea-label">Script</label>
                    <div class="library-script-linked">
                        <span class="library-script-badge">${escHtml(scriptName)}</span>
                        <button class="library-script-open-btn" id="library-video-open-script">Open</button>
                        <button class="library-script-unlink-btn" id="library-video-unlink-script">Unlink</button>
                    </div>
                </div>`;
        } else {
            scriptSection = `
                <div class="library-idea-field">
                    <label class="library-idea-label">Script</label>
                    <div class="library-script-actions">
                        <button class="library-script-link-btn" id="library-video-link-script">Link Script</button>
                        <button class="library-script-new-btn" id="library-video-new-script">New Script</button>
                    </div>
                </div>`;
        }

        // Source idea badge
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="library-converted-badge">Source Idea: ${escHtml(idea ? idea.name : 'Unknown')}</div>`;
        }

        editorEl.innerHTML = `
            <div class="library-editor-toolbar">
                <button class="library-back-btn" id="library-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <span class="library-save-status saved" id="library-save-status">Saved</span>
            </div>
            <div class="library-editor-body">
                <div class="library-editor-title-row">
                    <input type="text" class="library-editor-title" id="library-editor-title" value="${escAttr(v.name)}" placeholder="Video title..." />
                </div>
                <div style="margin-bottom:8px;">${statusBadge}</div>
                ${sourceIdeaHtml}
                <div class="library-meta-row">
                    <label class="library-meta-label">Project</label>
                    <select class="library-project-select" id="library-video-project">
                        <option value="">No project</option>
                        ${projectOptions}
                    </select>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Hook</label>
                    <textarea class="library-idea-hook" id="library-video-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                </div>
                <div class="library-idea-field">
                    <label class="library-idea-label">Context</label>
                    <textarea class="library-idea-context" id="library-video-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                </div>
                ${scriptSection}
            </div>
            <div class="library-script-picker-overlay" id="library-video-script-picker-overlay" style="display:none;">
                <div class="library-script-picker">
                    <div class="library-script-picker-header">
                        <h3>Link a Script</h3>
                        <button class="library-script-picker-close" id="library-video-script-picker-close">&times;</button>
                    </div>
                    <div class="library-script-picker-list" id="library-video-script-picker-list"></div>
                </div>
            </div>
        `;

        document.getElementById('library-back-btn').addEventListener('click', () => saveVideoAndBack());
        document.getElementById('library-editor-title').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-hook').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-context').addEventListener('input', scheduleVideoSave);
        document.getElementById('library-video-project').addEventListener('change', scheduleVideoSave);

        // Script linker events
        const linkBtn = document.getElementById('library-video-link-script');
        if (linkBtn) linkBtn.addEventListener('click', () => showVideoScriptPicker());
        const newBtn = document.getElementById('library-video-new-script');
        if (newBtn) newBtn.addEventListener('click', () => createScriptForVideo());
        const unlinkBtn = document.getElementById('library-video-unlink-script');
        if (unlinkBtn) unlinkBtn.addEventListener('click', () => unlinkScriptFromVideo());
        const openBtn = document.getElementById('library-video-open-script');
        if (openBtn) openBtn.addEventListener('click', () => {
            if (v.linkedScriptId) { switchTab('scripts'); selectScript(v.linkedScriptId); }
        });
        const pickerClose = document.getElementById('library-video-script-picker-close');
        if (pickerClose) pickerClose.addEventListener('click', () => {
            document.getElementById('library-video-script-picker-overlay').style.display = 'none';
        });
        const pickerOverlay = document.getElementById('library-video-script-picker-overlay');
        if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) pickerOverlay.style.display = 'none';
        });
    }

    function scheduleVideoSave() {
        videoDirty = true; setSaveStatus('Editing...');
        if (videoSaveTimer) clearTimeout(videoSaveTimer);
        videoSaveTimer = setTimeout(() => saveVideo(), 1500);
    }

    async function saveVideo() {
        if (!selectedVideo || !videoDirty) return;
        const titleEl = document.getElementById('library-editor-title');
        const hookEl = document.getElementById('library-video-hook');
        const ctxEl = document.getElementById('library-video-context');
        const projectEl = document.getElementById('library-video-project');
        if (!titleEl) return;
        setSaveStatus('Saving...'); videoDirty = false;
        try {
            const name = titleEl.value.trim() || 'Untitled';
            const hook = hookEl?.value || '';
            const context = ctxEl?.value || '';
            const project = projectEl?.value || '';
            await VideoService.update(selectedVideo.id, { name, hook, context, project });
            selectedVideo = VideoService.getById(selectedVideo.id);
            // Bidirectional sync: update linked idea
            if (selectedVideo.sourceIdeaId) {
                const idea = NotesService.getById(selectedVideo.sourceIdeaId);
                if (idea) {
                    const content = JSON.stringify({ hook, context });
                    NotesService.update(idea.id, { name, content, project }).catch(() => {});
                }
            }
            setSaveStatus('Saved');
        } catch (e) { setSaveStatus('Save failed'); videoDirty = true; }
    }

    async function saveVideoAndBack() {
        if (videoDirty && selectedVideo) await saveVideo();
        selectedVideo = null;
        showListPage();
        // Return to projects tab
        switchTab('projects');
    }

    function showVideoScriptPicker() {
        const overlay = document.getElementById('library-video-script-picker-overlay');
        const listEl = document.getElementById('library-video-script-picker-list');
        if (!overlay || !listEl) return;

        const linkedIds = getLinkedScriptIds();
        const available = scripts.filter(s => !linkedIds.has(s.id));

        if (available.length === 0) {
            listEl.innerHTML = '<div class="library-empty">No available scripts. Create one with "New Script".</div>';
        } else {
            listEl.innerHTML = available.map(s => `
                <div class="library-script-picker-item" data-id="${s.id}">
                    <div class="library-script-picker-info">
                        <div class="library-script-picker-name">${escHtml(s.title)}</div>
                        <div class="library-script-picker-project">${escHtml(s.project || 'No project')}</div>
                    </div>
                    <button class="library-script-picker-link-btn" data-id="${s.id}">Link</button>
                </div>`).join('');
            async function doLink(scriptId) {
                if (!selectedVideo) return;
                try {
                    await VideoService.update(selectedVideo.id, { linkedScriptId: scriptId });
                    selectedVideo = VideoService.getById(selectedVideo.id);
                    overlay.style.display = 'none';
                    renderVideoEditor();
                } catch (e) {
                    console.warn('Library: link script to video failed', e);
                    alert('Failed to link script.');
                }
            }
            listEl.querySelectorAll('.library-script-picker-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); doLink(btn.dataset.id); });
            });
            listEl.querySelectorAll('.library-script-picker-item').forEach(item => {
                item.addEventListener('click', () => doLink(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    async function createScriptForVideo() {
        if (!selectedVideo) return;
        const btn = document.getElementById('library-video-new-script');
        if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }
        try {
            const title = ensureScriptSuffix(selectedVideo.name || 'Untitled');
            const page = await createPage(title, '');
            const meta = { project: selectedVideo.project || '', linkedVideoId: selectedVideo.id };
            await saveScriptMeta(page.id, meta);
            scripts.unshift({ id: page.id, title, project: meta.project, created: page.created_time, lastEdited: page.last_edited_time });
            await VideoService.update(selectedVideo.id, { linkedScriptId: page.id });
            selectedVideo = VideoService.getById(selectedVideo.id);
            renderVideoEditor();
        } catch (e) {
            console.warn('Library: create script for video failed', e);
            alert('Failed to create script.');
        } finally {
            if (btn) { btn.textContent = 'New Script'; btn.disabled = false; }
        }
    }

    async function unlinkScriptFromVideo() {
        if (!selectedVideo) return;
        await VideoService.update(selectedVideo.id, { linkedScriptId: '' });
        selectedVideo = VideoService.getById(selectedVideo.id);
        renderVideoEditor();
    }

    // =====================
    // --- PROJECTS ---
    // =====================
    let projectsLoaded = false;
    let selectedProject = null;
    let scriptMetaLoaded = false;

    async function loadScriptMetaBulk() {
        if (scriptMetaLoaded) return;
        for (const s of scripts) {
            if (s.project) continue; // already loaded
            try {
                const blocks = await fetchPageContent(s.id);
                const meta = extractScriptMeta(blocks);
                s.project = meta.project || '';
            } catch (e) {}
        }
        scriptMetaLoaded = true;
    }

    async function renderProjectsList() {
        const el = document.getElementById('library-projects-container');
        if (!el) return;

        if (!projectsLoaded) {
            el.innerHTML = '<div class="library-empty">Loading projects...</div>';
            try {
                await VideoService.getProjects();
                await loadScriptMetaBulk();
                projectsLoaded = true;
                renderProjectsList();
            } catch (e) {
                el.innerHTML = '<div class="library-empty">Could not load projects.</div>';
            }
            return;
        }

        if (selectedProject) {
            renderProjectDetail(el);
            return;
        }

        const projs = VideoService.getCachedProjects();
        if (projs.length === 0) {
            el.innerHTML = '<div class="library-empty">No projects found in Dropbox.</div>';
            return;
        }

        el.innerHTML = projs.map(p => {
            const videoCount = VideoService.getByProject(p).length;
            const ideaCount = NotesService.getByProject(p).length;
            const counts = [];
            if (videoCount) counts.push(`${videoCount} video${videoCount !== 1 ? 's' : ''}`);
            if (ideaCount) counts.push(`${ideaCount} idea${ideaCount !== 1 ? 's' : ''}`);
            const color = window.EggRenderer ? window.EggRenderer.getProjectColor(p) : '#ccc';
            const rectFlag = window.EggRenderer ? window.EggRenderer.projectFlagSvg(p, 32, true) : '';
            return `
            <div class="library-project-card" data-project="${escAttr(p)}" style="border-left:3px solid ${color}">
                ${rectFlag ? `<div class="library-project-flag">${rectFlag}</div>` : ''}
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(p)}</div>
                    <div class="library-list-date">${counts.length ? counts.join(' / ') : 'No items yet'}</div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>
            </div>`;
        }).join('');

        el.querySelectorAll('.library-project-card').forEach(card => {
            card.addEventListener('click', () => {
                selectedProject = card.dataset.project;
                renderProjectsList();
            });
        });
    }

    function renderProjectDetail(el) {
        if (!el || !selectedProject) return;
        const p = selectedProject;

        const projectVideos = VideoService.getByProject(p);
        const projectIdeas = NotesService.getByProject(p);

        const statusLabel = (s) => s === 'incubator' ? 'Incubator' : s === 'workshop' ? 'Workshop' : s === 'posted' ? 'Posted' : s;

        let html = `
            <div class="library-project-detail-header">
                <button class="library-back-btn" id="library-project-back">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Projects
                </button>
            </div>
            <div class="library-project-detail-title">${escHtml(p)}</div>
        `;

        // Videos section — show linked script under each video
        html += `<div class="library-project-section"><div class="library-project-section-header">Videos (${projectVideos.length})</div>`;
        if (projectVideos.length === 0) {
            html += '<div class="library-project-section-empty">No videos in this project</div>';
        } else {
            html += projectVideos.map(v => {
                let scriptInfo = '';
                if (v.linkedScriptId) {
                    const linked = scripts.find(s => s.id === v.linkedScriptId);
                    scriptInfo = `<div class="library-project-item-sub" data-script-id="${v.linkedScriptId}">Script: ${escHtml(linked ? linked.title : 'Linked')}</div>`;
                }
                return `
                <div class="library-project-item library-project-item-clickable" data-video-id="${v.id}">
                    <span class="library-project-item-name">${escHtml(v.name)}</span>
                    <span class="library-project-item-status status-${v.status}">${statusLabel(v.status)}</span>
                </div>
                ${scriptInfo}`;
            }).join('');
        }
        html += '</div>';

        // Ideas section — show linked script under each idea
        html += `<div class="library-project-section"><div class="library-project-section-header">Ideas (${projectIdeas.length})</div>`;
        if (projectIdeas.length === 0) {
            html += '<div class="library-project-section-empty">No ideas in this project</div>';
        } else {
            html += projectIdeas.map(n => {
                let scriptInfo = '';
                if (n.linkedScriptId) {
                    const linked = scripts.find(s => s.id === n.linkedScriptId);
                    scriptInfo = `<div class="library-project-item-sub" data-script-id="${n.linkedScriptId}">Script: ${escHtml(linked ? linked.title : 'Linked')}</div>`;
                }
                return `
                <div class="library-project-item library-project-item-clickable" data-note-id="${n.id}">
                    <span class="library-project-item-name">${escHtml(n.name)}</span>
                    <span class="library-project-item-status">${n.type === 'converted' ? 'Sent' : 'Idea'}</span>
                </div>
                ${scriptInfo}`;
            }).join('');
        }
        html += '</div>';

        // Add Idea button
        html += `<div class="library-project-actions"><button class="library-send-btn" id="library-project-add-note">+ Add Idea</button></div>`;

        el.innerHTML = html;

        // Event listeners
        document.getElementById('library-project-back').addEventListener('click', () => {
            selectedProject = null;
            renderProjectsList();
        });

        el.querySelectorAll('[data-video-id]').forEach(item => {
            item.addEventListener('click', () => {
                openVideoEditor(item.dataset.videoId);
            });
        });

        el.querySelectorAll('[data-note-id]').forEach(item => {
            item.addEventListener('click', () => {
                switchTab('notes');
                selectNote(item.dataset.noteId);
            });
        });

        el.querySelectorAll('[data-script-id]').forEach(item => {
            item.addEventListener('click', () => {
                switchTab('scripts');
                selectScript(item.dataset.scriptId);
            });
        });

        document.getElementById('library-project-add-note').addEventListener('click', async () => {
            try {
                const note = await NotesService.create({ name: 'Untitled', type: 'idea', project: p, content: ideaContentToString('', '') });
                switchTab('notes');
                selectedNote = note;
                showEditorPage();
                await renderNoteEditor(note);
                const titleInput = document.getElementById('library-editor-title');
                if (titleInput) { titleInput.focus(); titleInput.select(); }
            } catch (e) {
                console.warn('Library: create note for project failed', e);
                alert('Failed to create note.');
            }
        });
    }

    // =====================
    // --- SCRIPTS ---
    // =====================
    function renderList() {
        const listEl = document.getElementById('library-list');
        if (!listEl) return;
        if (scripts.length === 0) { listEl.innerHTML = '<div class="library-empty">No scripts yet</div>'; return; }
        listEl.innerHTML = scripts.map(s => {
            const isSelected = s.id === selectedId;
            const badge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(s.project) : '';
            // Find linked video/idea for this script
            let linkedInfo = '';
            const linkedVideo = VideoService.getAll().find(v => v.linkedScriptId === s.id);
            const linkedIdea = !linkedVideo ? NotesService.getAll().find(n => n.linkedScriptId === s.id) : null;
            if (linkedVideo) {
                const stBadge = window.EggRenderer ? window.EggRenderer.statusBadgeHtml(linkedVideo.status) : '';
                linkedInfo = `<span style="margin-left:6px;font-size:12px;color:#888;">${escHtml(linkedVideo.name)}</span> ${stBadge}`;
            } else if (linkedIdea) {
                linkedInfo = `<span style="margin-left:6px;font-size:12px;color:#888;">${escHtml(linkedIdea.name)}</span>`;
            }
            return `<div class="library-list-item${isSelected ? ' selected' : ''}" data-id="${s.id}">
                <div class="library-list-item-content">
                    <div class="library-list-title">${escHtml(s.title)}</div>
                    <div class="library-list-date">${badge}${linkedInfo}${!badge && !linkedInfo ? formatDate(s.lastEdited || s.created) : ''}</div>
                </div>
                <button class="library-delete-btn" data-id="${s.id}" title="Delete">&times;</button>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.library-list-item').forEach(el => {
            el.addEventListener('click', (e) => { if (!e.target.classList.contains('library-delete-btn')) selectScript(el.dataset.id); });
        });
        listEl.querySelectorAll('.library-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); handleDelete(btn.dataset.id); });
        });
    }

    async function renderEditor(title, content) {
        const editorEl = document.getElementById('library-editor');
        if (!editorEl) return;
        const displayTitle = title.replace(/\s*Script$/i, '');

        // Build "Linked to" section — show what idea/video this script belongs to
        let linkedToHtml = '';
        const linkedIdeaId = selectedScriptMeta ? selectedScriptMeta.linkedIdeaId || '' : '';
        const linkedVideoId = selectedScriptMeta ? selectedScriptMeta.linkedVideoId || '' : '';
        if (linkedIdeaId) {
            const idea = NotesService.getById(linkedIdeaId);
            linkedToHtml = `
                <div class="library-script-linked">
                    <span class="library-script-badge">${escHtml(idea ? idea.name : 'Idea')}</span>
                    <button class="library-script-unlink-btn" id="library-script-unlink">Unlink</button>
                </div>`;
        } else if (linkedVideoId) {
            const video = VideoService.getById(linkedVideoId);
            linkedToHtml = `
                <div class="library-script-linked">
                    <span class="library-script-badge">${escHtml(video ? video.name : 'Video')}</span>
                    <button class="library-script-unlink-btn" id="library-script-unlink">Unlink</button>
                </div>`;
        } else {
            linkedToHtml = `
                <div class="library-script-actions">
                    <button class="library-script-link-btn" id="library-script-link-to">Link to Idea / Video</button>
                </div>`;
        }

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
                    <input type="text" class="library-editor-title" id="library-editor-title" value="${escAttr(displayTitle)}" placeholder="Title" />
                    <span class="library-editor-suffix">Script</span>
                </div>
                <div class="library-meta-row">
                    <label class="library-meta-label">Linked to</label>
                    ${linkedToHtml}
                </div>
                <textarea class="library-editor-textarea" id="library-editor-textarea" placeholder="Start writing...">${escHtml(content)}</textarea>
            </div>
            <div class="library-script-picker-overlay" id="library-script-link-overlay" style="display:none;">
                <div class="library-script-picker">
                    <div class="library-script-picker-header">
                        <h3>Link to Idea or Video</h3>
                        <button class="library-script-picker-close" id="library-script-link-close">&times;</button>
                    </div>
                    <div class="library-script-link-filter" id="library-script-link-filter"></div>
                    <div class="library-script-picker-list" id="library-script-link-list"></div>
                </div>
            </div>
        `;
        document.getElementById('library-back-btn').addEventListener('click', handleBack);
        document.getElementById('library-editor-textarea').addEventListener('input', scheduleContentSave);
        document.getElementById('library-editor-title').addEventListener('input', scheduleTitleSave);

        // Linked to events
        const linkToBtn = document.getElementById('library-script-link-to');
        if (linkToBtn) linkToBtn.addEventListener('click', () => showScriptLinkToPicker());
        const unlinkBtn = document.getElementById('library-script-unlink');
        if (unlinkBtn) unlinkBtn.addEventListener('click', async () => {
            if (selectedScriptMeta) {
                selectedScriptMeta.linkedIdeaId = '';
                selectedScriptMeta.linkedVideoId = '';
                selectedScriptMeta.project = '';
                const s = scripts.find(s => s.id === selectedId);
                if (s) s.project = '';
            }
            scheduleContentSave();
            const script = scripts.find(s => s.id === selectedId);
            await renderEditor(script ? script.title : '', document.getElementById('library-editor-textarea')?.value || '');
        });
        const linkClose = document.getElementById('library-script-link-close');
        if (linkClose) linkClose.addEventListener('click', () => {
            document.getElementById('library-script-link-overlay').style.display = 'none';
        });
        const linkOverlay = document.getElementById('library-script-link-overlay');
        if (linkOverlay) linkOverlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) linkOverlay.style.display = 'none';
        });
    }

    function showScriptLinkToPicker() {
        const overlay = document.getElementById('library-script-link-overlay');
        const listEl = document.getElementById('library-script-link-list');
        const filterEl = document.getElementById('library-script-link-filter');
        if (!overlay || !listEl) return;

        // Build filter bar with projects
        const allProjs = VideoService.getCachedProjects();
        let filterProject = '';
        if (filterEl) {
            filterEl.innerHTML = `
                <button class="incubator-filter-btn active" data-project="">All</button>
                ${allProjs.map(p => `<button class="incubator-filter-btn" data-project="${escAttr(p)}">${escHtml(p)}</button>`).join('')}
            `;
            filterEl.style.cssText = 'display:flex;gap:6px;padding:8px 16px;overflow-x:auto;flex-shrink:0;';
            filterEl.querySelectorAll('.incubator-filter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    filterProject = btn.dataset.project;
                    filterEl.querySelectorAll('.incubator-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
                    renderLinkItems();
                });
            });
        }

        function renderLinkItems() {
            const ideas = NotesService.getAll().filter(n => n.type !== 'converted' && n.type !== 'todo');
            const videos = VideoService.getAll();
            let filteredIdeas = filterProject ? ideas.filter(n => n.project === filterProject) : ideas;
            let filteredVideos = filterProject ? videos.filter(v => v.project === filterProject) : videos;

            let html = '';
            if (filteredVideos.length > 0) {
                html += `<div style="padding:8px 14px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;">Videos</div>`;
                html += filteredVideos.map(v => `
                    <div class="library-script-picker-item" data-type="video" data-id="${v.id}">
                        <div class="library-script-picker-info">
                            <div class="library-script-picker-name">${escHtml(v.name)}</div>
                            <div class="library-script-picker-project">${escHtml(v.project || 'No project')} · ${v.status}</div>
                        </div>
                        <button class="library-script-picker-link-btn" data-type="video" data-id="${v.id}">Link</button>
                    </div>`).join('');
            }
            if (filteredIdeas.length > 0) {
                html += `<div style="padding:8px 14px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;">Ideas</div>`;
                html += filteredIdeas.map(n => `
                    <div class="library-script-picker-item" data-type="idea" data-id="${n.id}">
                        <div class="library-script-picker-info">
                            <div class="library-script-picker-name">${escHtml(n.name)}</div>
                            <div class="library-script-picker-project">${escHtml(n.project || 'No project')}</div>
                        </div>
                        <button class="library-script-picker-link-btn" data-type="idea" data-id="${n.id}">Link</button>
                    </div>`).join('');
            }
            if (!html) html = '<div class="library-empty">No ideas or videos found.</div>';
            listEl.innerHTML = html;

            async function doLinkTo(type, id) {
                try {
                    if (selectedScriptMeta) {
                        if (type === 'idea') {
                            selectedScriptMeta.linkedIdeaId = id;
                            selectedScriptMeta.linkedVideoId = '';
                            const idea = NotesService.getById(id);
                            if (idea) { selectedScriptMeta.project = idea.project || ''; }
                            await NotesService.update(id, { linkedScriptId: selectedId });
                        } else {
                            selectedScriptMeta.linkedVideoId = id;
                            selectedScriptMeta.linkedIdeaId = '';
                            const video = VideoService.getById(id);
                            if (video) { selectedScriptMeta.project = video.project || ''; }
                            await VideoService.update(id, { linkedScriptId: selectedId });
                        }
                        const s = scripts.find(s => s.id === selectedId);
                        if (s) s.project = selectedScriptMeta.project;
                    }
                    scheduleContentSave();
                    overlay.style.display = 'none';
                    const script = scripts.find(s => s.id === selectedId);
                    await renderEditor(script ? script.title : '', document.getElementById('library-editor-textarea')?.value || '');
                } catch (e) {
                    console.warn('Library: link script to item failed', e);
                    alert('Failed to link. Check connection.');
                }
            }
            listEl.querySelectorAll('.library-script-picker-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); doLinkTo(btn.dataset.type, btn.dataset.id); });
            });
            listEl.querySelectorAll('.library-script-picker-item').forEach(item => {
                item.addEventListener('click', () => doLinkTo(item.dataset.type, item.dataset.id));
            });
        }
        renderLinkItems();
        overlay.style.display = 'flex';
    }

    async function handleBack() { if (dirty && selectedId) await saveContent(); showListPage(); }

    async function selectScript(id) {
        if (dirty && selectedId) await saveContent();
        selectedId = id; renderList(); showEditorPage();
        const editorEl = document.getElementById('library-editor');
        if (editorEl) editorEl.innerHTML = '<div class="library-loading">Loading...</div>';
        const script = scripts.find(s => s.id === id);
        selectedBlocks = await fetchPageContent(id);
        selectedScriptMeta = extractScriptMeta(selectedBlocks);
        if (script) script.project = selectedScriptMeta.project || '';
        await renderEditor(script ? script.title : '', blocksToText(selectedBlocks));
    }

    async function handleNew() {
        const title = ensureScriptSuffix('Untitled');
        try {
            const page = await createPage(title, '');
            scripts.unshift({ id: page.id, title, project: '', created: page.created_time, lastEdited: page.last_edited_time });
            selectedId = page.id; selectedBlocks = [];
            selectedScriptMeta = { project: '' };
            renderList(); showEditorPage(); await renderEditor(title, '');
            const titleInput = document.getElementById('library-editor-title');
            if (titleInput) { titleInput.focus(); titleInput.select(); }
            setSaveStatus('Saved');
        } catch (e) { console.warn('Library: create failed', e); alert('Failed to create script. Check connection.'); }
    }

    async function handleDelete(id) {
        const script = scripts.find(s => s.id === id);
        if (!script || !confirm(`Delete "${script.title}"?`)) return;
        try {
            await archivePage(id);
            scripts = scripts.filter(s => s.id !== id);
            if (selectedId === id) { selectedId = null; selectedBlocks = []; if (currentPage === 'editor') showListPage(); }
            renderList();
        } catch (e) { console.warn('Library: delete failed', e); }
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    function updateTodoBadge() {
        const badge = document.getElementById('todo-badge');
        if (!badge) return;
        const count = todoItems.filter(i => !i.done).length;
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }

    return {
        async open(bodyEl, opts) {
            await loadConfig();
            render(bodyEl);
            scripts = await fetchScripts();
            renderList();
            NotesService.sync().catch(() => {});
            if (opts && opts.tab) switchTab(opts.tab);
        },
        close() {
            if (saveTimer) { clearTimeout(saveTimer); saveContent(); }
            if (titleSaveTimer) { clearTimeout(titleSaveTimer); saveTitleNow(); }
            if (noteSaveTimer) { clearTimeout(noteSaveTimer); saveNote(); }
            if (videoSaveTimer) { clearTimeout(videoSaveTimer); saveVideo(); }
            container = null; selectedId = null; selectedBlocks = []; selectedScriptMeta = null; selectedNote = null;
            selectedVideo = null; videoDirty = false;
            dirty = false; noteDirty = false;
            // Keep todoLoaded and todoItems cached across close/open
            projectsLoaded = false; selectedProject = null; scriptMetaLoaded = false;
            currentPage = 'list'; activeTab = 'scripts';
        },
        // Public: access scripts from other buildings (e.g. Incubator)
        getScripts() { return scripts; },
        async fetchScriptsIfNeeded() {
            if (scripts.length === 0) {
                await loadConfig();
                scripts = await fetchScripts();
            }
            return scripts;
        },
        // Public: load script content for inline editing in other buildings
        async loadScriptContent(scriptId) {
            const blocks = await fetchPageContent(scriptId);
            const meta = extractScriptMeta(blocks);
            const text = blocksToText(blocks);
            return { blocks, meta, text };
        },
        // Public: save script content from inline editing in other buildings
        async saveScriptContent(scriptId, text, meta) {
            const blocks = await fetchPageContent(scriptId);
            for (const b of blocks) {
                if (b.type === 'paragraph' || b.type === 'code') {
                    await deleteBlock(b.id);
                }
            }
            const newBlocks = textToBlocks(text);
            if (meta) {
                newBlocks.push({ object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text', text: { content: JSON.stringify(meta) } }] } });
            }
            await appendBlocks(scriptId, newBlocks);
        },
        // Public: preload to-do count for badge (called on page load)
        async preloadTodoCount() {
            await loadConfig();
            if (!todoLoaded) {
                try {
                    todoItems = await fetchTodoItems();
                    todoLoaded = true;
                } catch (e) {}
            }
            updateTodoBadge();
        },
        getTodoCount() {
            return todoItems.filter(i => !i.done).length;
        }
    };
})();

BuildingRegistry.register('Library', {
    open: (bodyEl, opts) => LibraryUI.open(bodyEl, opts),
    close: () => LibraryUI.close()
});
