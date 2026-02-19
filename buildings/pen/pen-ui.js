/**
 * Pen UI — Posted videos gallery.
 * Each posted video shows a 3D egg (same as Incubator/Workshop).
 * Panel shows all posted videos, filterable by project.
 * Can import old/backlog videos.
 */
const PenUI = (() => {
    let container = null;
    let projects = [];
    let filterProject = '';
    let selectedVideo = null;
    let currentPage = 'list';

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // Render 3D creature snapshots onto card canvases after DOM insertion
    function renderCardCreatures() {
        if (!window.EggRenderer) return;
        container.querySelectorAll('.pen-creature-canvas').forEach(canvas => {
            window.EggRenderer.renderCreatureSnapshot(canvas.dataset.project, canvas, 44);
        });
    }

    // ============ SCRIPT LINKER ============

    function getLinkedScriptIds() {
        const fromVideos = VideoService.getAll().filter(v => v.linkedScriptId).map(v => v.linkedScriptId);
        const fromIdeas = NotesService.getAll().filter(n => n.linkedScriptId).map(n => n.linkedScriptId);
        const currentId = selectedVideo ? selectedVideo.linkedScriptId : '';
        const set = new Set([...fromVideos, ...fromIdeas]);
        if (currentId) set.delete(currentId);
        return set;
    }

    function renderScriptLinker(v) {
        if (v.linkedScriptId) {
            const libScripts = LibraryUI.getScripts();
            const linked = libScripts.find(s => s.id === v.linkedScriptId);
            const name = linked ? linked.title : 'Linked Script';
            if (window.EggRenderer) {
                return window.EggRenderer.inlineScriptEditorHtml('pen-inline-script', name);
            }
            return `<div class="pen-script-linked">
                <span class="pen-script-badge">${escHtml(name)}</span>
                <button class="pen-script-unlink" id="pen-unlink-script">Unlink</button>
            </div>`;
        }
        return `<div class="pen-script-actions">
            <button class="pen-script-btn" id="pen-link-script">Link Script</button>
            <button class="pen-script-btn primary" id="pen-new-script">New Script</button>
        </div>`;
    }

    async function showScriptPicker() {
        const overlay = document.getElementById('pen-script-picker-overlay');
        const listEl = document.getElementById('pen-script-picker-list');
        if (!overlay || !listEl) return;

        let libraryScripts = [];
        try { libraryScripts = await LibraryUI.fetchScriptsIfNeeded(); } catch (e) {}

        const linkedIds = getLinkedScriptIds();
        const available = libraryScripts.filter(s => !linkedIds.has(s.id));

        if (available.length === 0) {
            listEl.innerHTML = '<div class="pen-picker-empty">No available scripts. Create one with "New Script".</div>';
        } else {
            listEl.innerHTML = available.map(s => `
                <div class="pen-picker-item" data-id="${s.id}">
                    <div class="pen-picker-name">${escHtml(s.title)}</div>
                    <button class="pen-picker-link-btn" data-id="${s.id}">Link</button>
                </div>`).join('');
            listEl.querySelectorAll('.pen-picker-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); linkScript(btn.dataset.id); });
            });
            listEl.querySelectorAll('.pen-picker-item').forEach(item => {
                item.addEventListener('click', () => linkScript(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    async function linkScript(scriptId) {
        if (!selectedVideo) return;
        selectedVideo.linkedScriptId = scriptId;
        await VideoService.update(selectedVideo.id, { linkedScriptId: scriptId });
        document.getElementById('pen-script-picker-overlay').style.display = 'none';
        renderDetail();
    }

    async function unlinkScript() {
        if (!selectedVideo) return;
        selectedVideo.linkedScriptId = '';
        await VideoService.update(selectedVideo.id, { linkedScriptId: '' });
        renderDetail();
    }

    async function createNewScript() {
        if (!selectedVideo) return;
        const btn = document.getElementById('pen-new-script');
        if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }
        try {
            await LibraryUI.fetchScriptsIfNeeded();
            const scriptName = (selectedVideo.name || 'Untitled') + ' Script';
            const cfgRes = await fetch('/api/config');
            const cfg = await cfgRes.json();
            const videosPageId = cfg.notion && cfg.notion.videosPageId;
            if (!videosPageId) throw new Error('Videos page not configured');

            const res = await fetch('/api/notion/pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    parent: { page_id: videosPageId },
                    properties: { title: { title: [{ text: { content: scriptName } }] } },
                    children: [{
                        object: 'block', type: 'code',
                        code: { language: 'json', rich_text: [{ type: 'text', text: { content: JSON.stringify({ project: selectedVideo.project || '', linkedVideoId: selectedVideo.id }) } }] }
                    }]
                })
            });
            if (!res.ok) throw new Error(`Create script failed: ${res.status}`);
            const result = await res.json();
            const libScripts = LibraryUI.getScripts();
            libScripts.unshift({ id: result.id, title: scriptName, project: selectedVideo.project || '', created: result.created_time, lastEdited: result.last_edited_time });
            selectedVideo.linkedScriptId = result.id;
            await VideoService.update(selectedVideo.id, { linkedScriptId: result.id });
            renderDetail();
        } catch (e) {
            console.warn('Pen: create script failed', e);
            alert('Failed to create script.');
        } finally {
            if (btn) { btn.textContent = 'New Script'; btn.disabled = false; }
        }
    }

    // ============ RENDER ============

    function render() {
        container.innerHTML = `
            <div class="pen-panel show-list">
                <div class="pen-page pen-list-page">
                    <div class="pen-header">
                        <h2>The Pen</h2>
                        <button class="pen-import-btn" id="pen-import-btn">+ Import Video</button>
                    </div>
                    <div class="pen-filters" id="pen-filters"></div>
                    <div class="pen-videos" id="pen-videos">
                        <div class="pen-loading">Loading...</div>
                    </div>
                </div>
                <div class="pen-page pen-detail-page">
                    <div class="pen-detail" id="pen-detail"></div>
                </div>
            </div>
        `;
        document.getElementById('pen-import-btn').addEventListener('click', handleImport);
    }

    function renderFilters() {
        const el = document.getElementById('pen-filters');
        if (!el) return;
        const posted = VideoService.getByStatus('posted');
        const usedProjects = [...new Set(posted.map(v => v.project).filter(Boolean))].sort();

        el.innerHTML = `
            <button class="pen-filter-btn ${!filterProject ? 'active' : ''}" data-project="">All (${posted.length})</button>
            ${usedProjects.map(p => {
                const count = posted.filter(v => v.project === p).length;
                return `<button class="pen-filter-btn ${filterProject === p ? 'active' : ''}" data-project="${escAttr(p)}">${escHtml(p)} (${count})</button>`;
            }).join('')}
        `;

        el.querySelectorAll('.pen-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                filterProject = btn.dataset.project;
                renderFilters();
                renderVideos();
            });
        });
    }

    function renderVideos() {
        const el = document.getElementById('pen-videos');
        if (!el) return;
        let posted = VideoService.getByStatus('posted');
        if (filterProject) posted = posted.filter(v => v.project === filterProject);

        // Sort by posted date, newest first
        posted.sort((a, b) => (b.postedDate || '').localeCompare(a.postedDate || ''));

        if (posted.length === 0) {
            el.innerHTML = '<div class="pen-empty">No posted videos yet. Hatch eggs from the Workshop!</div>';
            return;
        }

        el.innerHTML = posted.map(v => {
            const isBacklog = !v.hook && !v.context && v.links;
            const color = window.EggRenderer ? window.EggRenderer.getProjectColor(v.project || v.name) : '#ccc';
            const projBadge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(v.project) : escHtml(v.project || 'No project');
            return `
            <div class="pen-video-card ${isBacklog ? 'backlog' : ''}" data-id="${v.id}">
                <div class="pen-video-badge">
                    <canvas class="pen-creature-canvas" data-project="${escAttr(v.project || v.name)}" width="88" height="88"></canvas>
                </div>
                <div class="pen-video-info">
                    <div class="pen-video-name">${escHtml(v.name)}</div>
                    <div class="pen-video-meta">
                        <span class="pen-video-project">${projBadge}</span>
                        ${v.postedDate ? `<span class="pen-video-date">${formatDate(v.postedDate)}</span>` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');

        el.querySelectorAll('.pen-video-card').forEach(card => {
            card.addEventListener('click', () => openDetail(card.dataset.id));
        });

        // Render 3D creatures after DOM is ready
        requestAnimationFrame(() => renderCardCreatures());
    }

    function openDetail(id) {
        selectedVideo = VideoService.getById(id);
        if (!selectedVideo) return;
        currentPage = 'detail';
        const panel = container.querySelector('.pen-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    function showList() {
        currentPage = 'list';
        selectedVideo = null;
        const panel = container.querySelector('.pen-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderFilters();
        renderVideos();
    }

    function renderDetail() {
        const el = document.getElementById('pen-detail');
        if (!el || !selectedVideo) return;
        const v = selectedVideo;

        // Source idea badge
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="pen-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }

        el.innerHTML = `
            <div class="pen-detail-toolbar">
                <button class="pen-back-btn" id="pen-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <button class="pen-delete-btn" id="pen-delete-btn">Delete</button>
            </div>
            <div class="pen-detail-body">
                <div class="pen-detail-egg">
                    <canvas id="pen-detail-creature-canvas" class="pen-creature-preview-canvas" width="160" height="160"></canvas>
                </div>
                <div class="pen-detail-fields">
                    ${sourceIdeaHtml}
                    <label>Video Name</label>
                    <input type="text" id="pen-name" value="${escAttr(v.name)}">
                    <label>Project</label>
                    <select id="pen-project">
                        <option value="">No project</option>
                        ${projects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                    </select>
                    <label>Posted Date</label>
                    <input type="text" id="pen-date" value="${escAttr(v.postedDate)}" placeholder="YYYY-MM-DD">
                    <label>Hook</label>
                    <textarea id="pen-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                    <label>Context</label>
                    <textarea id="pen-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                    <label>Script</label>
                    ${renderScriptLinker(v)}
                    <label>Links</label>
                    <textarea id="pen-links" placeholder="YouTube, TikTok, Instagram URLs...">${escHtml(v.links)}</textarea>
                </div>
            </div>
            <div class="pen-picker-overlay" id="pen-script-picker-overlay" style="display:none;">
                <div class="pen-picker">
                    <div class="pen-picker-header">
                        <h3>Link a Script</h3>
                        <button class="pen-picker-close" id="pen-script-picker-close">&times;</button>
                    </div>
                    <div class="pen-picker-list" id="pen-script-picker-list"></div>
                </div>
            </div>
        `;

        document.getElementById('pen-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('pen-delete-btn').addEventListener('click', () => handleDelete());

        // Script linker events — inline editor or link/new buttons
        if (v.linkedScriptId && window.EggRenderer) {
            window.EggRenderer.initInlineScriptEditor('pen-inline-script', v.linkedScriptId, unlinkScript);
        } else {
            const unlinkBtn = document.getElementById('pen-unlink-script');
            if (unlinkBtn) unlinkBtn.addEventListener('click', unlinkScript);
        }
        const linkBtn = document.getElementById('pen-link-script');
        if (linkBtn) linkBtn.addEventListener('click', showScriptPicker);
        const newBtn = document.getElementById('pen-new-script');
        if (newBtn) newBtn.addEventListener('click', createNewScript);

        const pickerClose = document.getElementById('pen-script-picker-close');
        if (pickerClose) pickerClose.addEventListener('click', () => {
            document.getElementById('pen-script-picker-overlay').style.display = 'none';
        });
        const pickerOverlay = document.getElementById('pen-script-picker-overlay');
        if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) pickerOverlay.style.display = 'none';
        });

        // Init 3D creature preview
        if (window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.renderCreatureSnapshot(v.project || v.name, document.getElementById('pen-detail-creature-canvas'), 80));
        }
    }

    async function saveAndBack() {
        if (selectedVideo) {
            const name = document.getElementById('pen-name')?.value.trim() || selectedVideo.name;
            const project = document.getElementById('pen-project')?.value || '';
            const postedDate = document.getElementById('pen-date')?.value || '';
            const hook = document.getElementById('pen-hook')?.value || '';
            const context = document.getElementById('pen-context')?.value || '';
            const links = document.getElementById('pen-links')?.value || '';
            await VideoService.update(selectedVideo.id, { name, project, postedDate, hook, context, links });
        }
        showList();
    }

    async function handleDelete() {
        if (!selectedVideo) return;
        if (!confirm(`Delete "${selectedVideo.name}"?`)) return;
        await VideoService.remove(selectedVideo.id);
        showList();
    }

    async function handleImport() {
        try {
            const video = await VideoService.create({
                name: 'Untitled Video',
                status: 'posted',
                postedDate: new Date().toISOString()
            });
            openDetail(video.id);
            setTimeout(() => {
                const nameEl = document.getElementById('pen-name');
                if (nameEl) { nameEl.focus(); nameEl.select(); }
            }, 50);
        } catch (e) {
            console.warn('Pen: import failed', e);
        }
    }

    return {
        async open(bodyEl, opts) {
            container = bodyEl;
            render();
            // Fast path: if opening a specific video, show detail immediately
            if (opts && opts.openVideoId) {
                projects = VideoService.getCachedProjects() || [];
                openDetail(opts.openVideoId);
                // Load remaining data in background for Back navigation
                VideoService.getProjects().then(p => { projects = p; }).catch(() => {});
                VideoService.sync().catch(() => {});
                LibraryUI.fetchScriptsIfNeeded().catch(() => {});
                return;
            }
            projects = await VideoService.getProjects();
            await VideoService.sync();
            LibraryUI.fetchScriptsIfNeeded().catch(() => {});
            renderFilters();
            renderVideos();
        },
        close() {
            if (currentPage === 'detail' && selectedVideo) {
                const name = document.getElementById('pen-name')?.value.trim();
                const project = document.getElementById('pen-project')?.value;
                const hook = document.getElementById('pen-hook')?.value;
                const context = document.getElementById('pen-context')?.value;
                const links = document.getElementById('pen-links')?.value;
                if (name) VideoService.update(selectedVideo.id, { name, project, hook, context, links }).catch(() => {});
            }
            container = null;
            selectedVideo = null;
            filterProject = '';
            currentPage = 'list';
        }
    };
})();

BuildingRegistry.register('The Pen', {
    open: (bodyEl, opts) => PenUI.open(bodyEl, opts),
    close: () => PenUI.close()
});
