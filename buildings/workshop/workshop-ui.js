/**
 * Workshop UI — Videos actively being worked on.
 * Shows 3D eggs with assigned workers (character avatars).
 * Can mark as posted (hatches egg -> pen creature).
 */
const WorkshopUI = (() => {
    let container = null;
    let projects = [];
    let selectedVideo = null;
    let currentPage = 'list';
    let filterProject = '';

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    const WORKERS = ['You', 'Robin', 'Jordan', 'Tennille'];

    function getWorkerLabel(assignedTo) {
        if (!assignedTo) return 'Unassigned';
        return assignedTo;
    }

    // Render 3D egg snapshots + character avatars onto card canvases after DOM insertion
    async function renderCardAssets() {
        if (!window.EggRenderer) return;
        const eggPromises = [];
        container.querySelectorAll('.workshop-egg-canvas').forEach(canvas => {
            eggPromises.push(window.EggRenderer.renderEggSnapshot(canvas.dataset.project, canvas, 50));
        });
        container.querySelectorAll('.workshop-avatar-canvas').forEach(canvas => {
            window.EggRenderer.renderCharacterAvatar(canvas.dataset.worker, canvas, 32);
        });
        await Promise.all(eggPromises);
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
                return window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', name);
            }
            return `<div class="workshop-script-linked">
                <span class="workshop-script-badge">${escHtml(name)}</span>
                <button class="workshop-script-unlink" id="workshop-unlink-script">Unlink</button>
            </div>`;
        }
        return `<div class="workshop-script-actions">
            <button class="workshop-script-btn" id="workshop-link-script">Link Script</button>
            <button class="workshop-script-btn primary" id="workshop-new-script">New Script</button>
        </div>`;
    }

    async function showScriptPicker() {
        const overlay = document.getElementById('workshop-script-picker-overlay');
        const listEl = document.getElementById('workshop-script-picker-list');
        if (!overlay || !listEl) return;

        let libraryScripts = [];
        try { libraryScripts = await LibraryUI.fetchScriptsIfNeeded(); } catch (e) {}

        const linkedIds = getLinkedScriptIds();
        const available = libraryScripts.filter(s => !linkedIds.has(s.id));

        if (available.length === 0) {
            listEl.innerHTML = '<div class="workshop-picker-empty">No available scripts. Create one with "New Script".</div>';
        } else {
            listEl.innerHTML = available.map(s => `
                <div class="workshop-picker-item" data-id="${s.id}">
                    <div class="workshop-picker-name">${escHtml(s.title)}</div>
                    <button class="workshop-picker-link-btn" data-id="${s.id}">Link</button>
                </div>`).join('');
            listEl.querySelectorAll('.workshop-picker-link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); linkScript(btn.dataset.id); });
            });
            listEl.querySelectorAll('.workshop-picker-item').forEach(item => {
                item.addEventListener('click', () => linkScript(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    async function linkScript(scriptId) {
        if (!selectedVideo) return;
        selectedVideo.linkedScriptId = scriptId;
        await VideoService.update(selectedVideo.id, { linkedScriptId: scriptId });
        document.getElementById('workshop-script-picker-overlay').style.display = 'none';
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
        const btn = document.getElementById('workshop-new-script');
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
            console.warn('Workshop: create script failed', e);
            alert('Failed to create script.');
        } finally {
            if (btn) { btn.textContent = 'New Script'; btn.disabled = false; }
        }
    }

    // ============ RENDER ============

    function render() {
        container.innerHTML = `
            <div class="workshop-panel show-list">
                <div class="workshop-page workshop-list-page">
                    <div class="workshop-header">
                        <h2>Workshop</h2>
                        <span class="workshop-count" id="workshop-count"></span>
                    </div>
                    <div class="workshop-filters" id="workshop-filters"></div>
                    <div class="workshop-items" id="workshop-items">
                        <div class="workshop-loading">Loading...</div>
                    </div>
                </div>
                <div class="workshop-page workshop-detail-page">
                    <div class="workshop-detail" id="workshop-detail"></div>
                </div>
            </div>
        `;
    }

    function renderFilters() {
        const el = document.getElementById('workshop-filters');
        if (!el) return;
        const active = VideoService.getByStatus('workshop');
        const usedProjects = [...new Set(active.map(v => v.project).filter(Boolean))].sort();
        if (usedProjects.length === 0) {
            el.innerHTML = '';
            return;
        }
        el.innerHTML = `
            <button class="workshop-filter-btn ${!filterProject ? 'active' : ''}" data-project="">All (${active.length})</button>
            ${usedProjects.map(p => {
                const count = active.filter(v => v.project === p).length;
                return `<button class="workshop-filter-btn ${filterProject === p ? 'active' : ''}" data-project="${escAttr(p)}">${escHtml(p)} (${count})</button>`;
            }).join('')}
        `;
        el.querySelectorAll('.workshop-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                filterProject = btn.dataset.project;
                renderFilters();
                renderItems();
            });
        });
    }

    function renderItems() {
        const el = document.getElementById('workshop-items');
        const countEl = document.getElementById('workshop-count');
        if (!el) return;
        let active = VideoService.getByStatus('workshop');
        if (countEl) countEl.textContent = `${active.length} in progress`;
        if (filterProject) active = active.filter(v => v.project === filterProject);

        if (active.length === 0) {
            el.innerHTML = '<div class="workshop-empty">Nothing in the workshop. Move ideas from the Incubator to start working!</div>';
            return;
        }
        el.innerHTML = active.map(v => {
            const color = window.EggRenderer ? window.EggRenderer.getProjectColor(v.project) : '#ccc';
            const projBadge = window.EggRenderer ? window.EggRenderer.projectBadgeHtml(v.project) : escHtml(v.project || 'No project');
            return `
            <div class="workshop-card" data-id="${v.id}">
                <div class="workshop-card-egg">
                    <canvas class="workshop-egg-canvas" data-project="${escAttr(v.project)}" width="100" height="124"></canvas>
                </div>
                <div class="workshop-card-info">
                    <div class="workshop-card-name">${escHtml(v.name)}</div>
                    <div class="workshop-card-meta">
                        <span class="workshop-card-project">${projBadge}</span>
                        <span class="workshop-card-worker">
                            ${v.assignedTo ? `<canvas class="workshop-avatar-canvas" data-worker="${escAttr(v.assignedTo)}" width="48" height="48"></canvas>` : ''}
                        </span>
                    </div>
                </div>
            </div>`;
        }).join('');

        el.querySelectorAll('.workshop-card').forEach(card => {
            card.addEventListener('click', () => openDetail(card.dataset.id));
        });

        // Render 3D assets after DOM is ready
        requestAnimationFrame(() => renderCardAssets());
    }

    function openDetail(id) {
        selectedVideo = VideoService.getById(id);
        if (!selectedVideo) return;
        currentPage = 'detail';
        const panel = container.querySelector('.workshop-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    function showList() {
        // Cleanup detail egg preview if it exists
        const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
        if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();

        currentPage = 'list';
        selectedVideo = null;
        const panel = container.querySelector('.workshop-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderFilters();
        renderItems();
    }

    function renderDetail() {
        const el = document.getElementById('workshop-detail');
        if (!el || !selectedVideo) return;
        const v = selectedVideo;

        // Source idea badge
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="workshop-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }

        // Assignee avatar
        let assigneeAvatarHtml = '';
        if (v.assignedTo) {
            assigneeAvatarHtml = `<canvas class="workshop-detail-avatar" id="workshop-detail-avatar" data-worker="${escAttr(v.assignedTo)}" width="64" height="64"></canvas>`;
        }

        el.innerHTML = `
            <div class="workshop-detail-toolbar">
                <button class="workshop-back-btn" id="workshop-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <div class="workshop-detail-actions">
                    <button class="workshop-action-btn post-btn" id="workshop-post">Post Video</button>
                    <button class="workshop-action-btn back-to-incubator-btn" id="workshop-to-incubator">Back to Incubator</button>
                </div>
            </div>
            <div class="workshop-detail-body">
                <div class="workshop-detail-egg">
                    ${v.project ? `<canvas id="workshop-detail-egg-canvas" class="workshop-egg-preview-canvas" width="160" height="200"></canvas>` : window.EggRenderer ? window.EggRenderer.renderSilhouetteEgg() : ''}
                    ${assigneeAvatarHtml}
                </div>
                <div class="workshop-detail-fields">
                    ${sourceIdeaHtml}
                    <label>Video Name</label>
                    <input type="text" id="workshop-name" value="${escAttr(v.name)}">
                    <label>Project</label>
                    <select id="workshop-project">
                        <option value="">No project</option>
                        ${projects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                    </select>
                    <label>Assigned To</label>
                    <select id="workshop-assigned">
                        <option value="">Unassigned</option>
                        ${WORKERS.map(w => `<option value="${escAttr(w)}" ${w === v.assignedTo ? 'selected' : ''}>${escHtml(w)}</option>`).join('')}
                    </select>
                    <label>Hook</label>
                    <textarea id="workshop-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                    <label>Context</label>
                    <textarea id="workshop-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                    <label>Script</label>
                    ${renderScriptLinker(v)}
                </div>
            </div>
            <div class="workshop-picker-overlay" id="workshop-script-picker-overlay" style="display:none;">
                <div class="workshop-picker">
                    <div class="workshop-picker-header">
                        <h3>Link a Script</h3>
                        <button class="workshop-picker-close" id="workshop-script-picker-close">&times;</button>
                    </div>
                    <div class="workshop-picker-list" id="workshop-script-picker-list"></div>
                </div>
            </div>
        `;

        document.getElementById('workshop-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('workshop-post').addEventListener('click', () => postVideo());
        document.getElementById('workshop-to-incubator').addEventListener('click', () => backToIncubator());

        // Script linker events — inline editor or link/new buttons
        if (v.linkedScriptId && window.EggRenderer) {
            window.EggRenderer.initInlineScriptEditor('workshop-inline-script', v.linkedScriptId, unlinkScript);
        } else {
            const unlinkBtn = document.getElementById('workshop-unlink-script');
            if (unlinkBtn) unlinkBtn.addEventListener('click', unlinkScript);
        }
        const linkBtn = document.getElementById('workshop-link-script');
        if (linkBtn) linkBtn.addEventListener('click', showScriptPicker);
        const newBtn = document.getElementById('workshop-new-script');
        if (newBtn) newBtn.addEventListener('click', createNewScript);

        // Picker close
        const pickerClose = document.getElementById('workshop-script-picker-close');
        if (pickerClose) pickerClose.addEventListener('click', () => {
            document.getElementById('workshop-script-picker-overlay').style.display = 'none';
        });
        const pickerOverlay = document.getElementById('workshop-script-picker-overlay');
        if (pickerOverlay) pickerOverlay.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) pickerOverlay.style.display = 'none';
        });

        // Init animated 3D egg preview for detail view
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
        // Render character avatar in detail
        if (v.assignedTo && window.EggRenderer) {
            requestAnimationFrame(() => {
                const avatarCanvas = document.getElementById('workshop-detail-avatar');
                if (avatarCanvas) window.EggRenderer.renderCharacterAvatar(v.assignedTo, avatarCanvas, 32);
            });
        }
    }

    async function saveAndBack() {
        if (selectedVideo) {
            const name = document.getElementById('workshop-name')?.value.trim() || selectedVideo.name;
            const project = document.getElementById('workshop-project')?.value || '';
            const assignedTo = document.getElementById('workshop-assigned')?.value || '';
            const hook = document.getElementById('workshop-hook')?.value || '';
            const context = document.getElementById('workshop-context')?.value || '';
            await VideoService.update(selectedVideo.id, { name, project, assignedTo, hook, context });
            // Bidirectional sync: update linked idea if exists
            if (selectedVideo.sourceIdeaId) {
                const idea = NotesService.getById(selectedVideo.sourceIdeaId);
                if (idea) {
                    const content = JSON.stringify({ hook, context });
                    NotesService.update(idea.id, { name, content, project }).catch(() => {});
                }
            }
        }
        showList();
    }

    async function postVideo() {
        if (!selectedVideo) return;

        // Require a linked script before posting
        if (!selectedVideo.linkedScriptId) {
            alert('A script is required before posting. Link or create a script first.');
            return;
        }

        const btn = document.getElementById('workshop-post');
        if (btn) { btn.textContent = 'Posting...'; btn.disabled = true; }

        const name = document.getElementById('workshop-name')?.value.trim() || selectedVideo.name;
        const project = document.getElementById('workshop-project')?.value || '';
        const hook = document.getElementById('workshop-hook')?.value || '';
        const context = document.getElementById('workshop-context')?.value || '';

        try {
            await VideoService.update(selectedVideo.id, { name, project, hook, context });
            await VideoService.moveToPosted(selectedVideo.id);
            // Spawn creature in 3D world immediately
            if (typeof spawnPostedCreatures === 'function') spawnPostedCreatures();
            // Play hatch animation then return to list
            const panel = container.querySelector('.workshop-panel');
            if (panel && window.EggRenderer && project) {
                window.EggRenderer.showHatchAnimation(project, panel, () => showList());
            } else {
                showList();
            }
        } catch (e) {
            console.warn('Workshop: post failed', e);
            alert('Failed to post video. Check connection.');
            if (btn) { btn.textContent = 'Post Video'; btn.disabled = false; }
        }
    }

    async function backToIncubator() {
        if (!selectedVideo) return;
        await VideoService.moveToIncubator(selectedVideo.id);
        showList();
    }

    return {
        async open(bodyEl) {
            container = bodyEl;
            render();
            projects = await VideoService.getProjects();
            await VideoService.sync();
            LibraryUI.fetchScriptsIfNeeded().catch(() => {});
            renderFilters();
            renderItems();
        },
        close() {
            if (currentPage === 'detail' && selectedVideo) {
                const name = document.getElementById('workshop-name')?.value.trim();
                const project = document.getElementById('workshop-project')?.value;
                const assignedTo = document.getElementById('workshop-assigned')?.value;
                const hook = document.getElementById('workshop-hook')?.value;
                const context = document.getElementById('workshop-context')?.value;
                if (name) {
                    VideoService.update(selectedVideo.id, { name, project, assignedTo, hook, context }).catch(() => {});
                    // Bidirectional sync on close
                    if (selectedVideo.sourceIdeaId) {
                        const idea = NotesService.getById(selectedVideo.sourceIdeaId);
                        if (idea) {
                            const content = JSON.stringify({ hook, context });
                            NotesService.update(idea.id, { name, content, project }).catch(() => {});
                        }
                    }
                }
            }
            // Cleanup 3D egg preview
            const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
            if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();

            container = null;
            selectedVideo = null;
            currentPage = 'list';
            filterProject = '';
        }
    };
})();

BuildingRegistry.register('Workshop', {
    open: (bodyEl) => WorkshopUI.open(bodyEl),
    close: () => WorkshopUI.close()
});
