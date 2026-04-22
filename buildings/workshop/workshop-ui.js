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
    let filterAssignee = '';

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;

    function hasContextOn(v) { return !!(v && v.context && v.context.trim().length > 0); }
    function hasScriptOn(v) { return !!(v && v.script && v.script.trim().length > 0); }
    function hasLogisticsOn(v) {
        if (!v || !v.sourceIdeaId || !window.NotesService) return false;
        const idea = NotesService.getById(v.sourceIdeaId);
        return !!(idea && idea.logistics && Object.keys(idea.logistics).length > 0);
    }
    function dotsHtml(v) {
        return '<span class="workshop-dots" title="Context / Script / Logistics">' +
            '<span class="workshop-dot' + (hasContextOn(v) ? ' has-context' : '') + '"></span>' +
            '<span class="workshop-dot dot-script' + (hasScriptOn(v) ? ' has-script' : '') + '"></span>' +
            '<span class="workshop-dot dot-logistics' + (hasLogisticsOn(v) ? ' has-logistics' : '') + '"></span>' +
            '</span>';
    }

    function getWorkerOptions(currentAssignee) {
        const names = (window.EmployeeService ? window.EmployeeService.getNames() : ['You', 'Robin', 'Jordan', 'Tennille']);
        const currentNames = Array.isArray(currentAssignee) ? currentAssignee : (currentAssignee ? [currentAssignee] : []);
        // Preserve backwards compatibility: if a video references a name
        // that no longer exists in the roster, surface it so it stays visible.
        const extras = currentNames.filter(n => n && !names.includes(n));
        if (extras.length) {
            return [...extras, ...names];
        }
        return names;
    }

    function getWorkerColor(name) {
        if (!name) return '';
        if (window.EmployeeService && window.EmployeeService.colorForName) {
            return window.EmployeeService.colorForName(name);
        }
        return '';
    }

    function getAssignedPeople(video) {
        if (!video) return [];
        const fromList = Array.isArray(video.assignedToList) ? video.assignedToList : [];
        const merged = fromList.length ? fromList : (video.assignedTo ? [video.assignedTo] : []);
        return [...new Set(merged.map(v => String(v || '').trim()).filter(Boolean))];
    }

    function getPrimaryAssignee(video) {
        return getAssignedPeople(video)[0] || '';
    }

    function videoHasAssignee(video, name) {
        return getAssignedPeople(video).includes(name);
    }

    function renderWorkerPill(name) {
        if (!name) return '';
        const workerColor = getWorkerColor(name);
        const workerStyle = workerColor ? ` style="background:${escAttr(workerColor)}18;color:${escAttr(workerColor)}"` : '';
        return `<span class="workshop-card-worker"${workerStyle}>${escHtml(name)}</span>`;
    }

    function renderAssigneePicker(video) {
        const selected = getAssignedPeople(video);
        const options = getWorkerOptions(selected);
        const summary = selected.length ? selected.join(', ') : 'Unassigned';
        return `
            <details class="workshop-assignee-picker" id="workshop-assignee-picker">
                <summary>${escHtml(summary)}</summary>
                <div class="workshop-assignee-menu">
                    ${options.map(w => `<label class="workshop-assignee-option"><input type="checkbox" value="${escAttr(w)}" ${selected.includes(w) ? 'checked' : ''}> <span>${escHtml(w)}</span></label>`).join('')}
                </div>
            </details>`;
    }

    function readAssignedPeopleFromPicker() {
        return [...(container ? container.querySelectorAll('#workshop-assignee-picker input[type="checkbox"]:checked') : [])]
            .map(input => String(input.value || '').trim())
            .filter(Boolean);
    }

    // Render 3D egg snapshots + character avatars onto card canvases after DOM insertion
    async function renderCardAssets() {
        if (!window.EggRenderer) return;
        const eggPromises = [];
        container.querySelectorAll('.workshop-egg-canvas').forEach(canvas => {
            eggPromises.push(window.EggRenderer.renderEggSnapshot(canvas.dataset.project, canvas, 40));
        });
        container.querySelectorAll('.workshop-avatar-canvas').forEach(canvas => {
            window.EggRenderer.renderCharacterAvatar(canvas.dataset.worker, canvas, 32);
        });
        await Promise.all(eggPromises);
    }

    // ============ RENDER ============

    function render() {
        container.innerHTML = `
            <div class="workshop-panel show-list">
                <div class="workshop-page workshop-list-page">
                    <div class="workshop-header">
                        <h2>Workshop</h2>
                        <span class="workshop-count" id="workshop-count"></span>
                        <button class="workshop-share-btn" id="workshop-share-btn" title="Copy share link">Share</button>
                    </div>
                    <div class="workshop-filters" id="workshop-filters"></div>
                    <div class="workshop-items" id="workshop-items">
                        ${Array(3).fill(`<div class="workshop-skeleton-card">
                            <div class="workshop-skeleton-egg"></div>
                            <div class="workshop-skeleton-lines">
                                <div class="workshop-skeleton-line"></div>
                                <div class="workshop-skeleton-line short"></div>
                            </div>
                        </div>`).join('')}
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

        // Assignee list: roster names that are actually in use, plus any non-roster names found on cards
        const rosterNames = (window.EmployeeService ? window.EmployeeService.getNames() : []);
        const usedAssigneesSet = new Set(active.flatMap(v => getAssignedPeople(v)));
        const assigneeList = [];
        rosterNames.forEach(n => { if (usedAssigneesSet.has(n)) assigneeList.push(n); });
        [...usedAssigneesSet].forEach(a => {
            if (a && !rosterNames.includes(a) && !assigneeList.includes(a)) assigneeList.push(a);
        });
        const hasUnassigned = active.some(v => getAssignedPeople(v).length === 0);

        let html = '';
        if (usedProjects.length > 0) {
            html += `<div class="workshop-filter-row">
                <button class="workshop-filter-btn ${!filterProject ? 'active' : ''}" data-project="">All (${active.length})</button>
                ${usedProjects.map(p => {
                    const count = active.filter(v => v.project === p).length;
                    return `<button class="workshop-filter-btn ${filterProject === p ? 'active' : ''}" data-project="${escAttr(p)}">${escHtml(p)} (${count})</button>`;
                }).join('')}
            </div>`;
        }
        if (assigneeList.length > 0 || hasUnassigned) {
            html += `<div class="workshop-filter-row">
                <span class="workshop-filter-row-label">Assignee:</span>
                <button class="workshop-filter-btn ${!filterAssignee ? 'active' : ''}" data-assignee="">All</button>
                ${assigneeList.map(a => {
                    const count = active.filter(v => videoHasAssignee(v, a)).length;
                    return `<button class="workshop-filter-btn ${filterAssignee === a ? 'active' : ''}" data-assignee="${escAttr(a)}">${escHtml(a)} (${count})</button>`;
                }).join('')}
                ${hasUnassigned ? `<button class="workshop-filter-btn ${filterAssignee === 'none' ? 'active' : ''}" data-assignee="none">Unassigned (${active.filter(v => getAssignedPeople(v).length === 0).length})</button>` : ''}
            </div>`;
        }
        el.innerHTML = html;
        el.querySelectorAll('[data-project]').forEach(btn => {
            btn.addEventListener('click', () => {
                filterProject = btn.dataset.project;
                renderFilters();
                renderItems();
            });
        });
        el.querySelectorAll('[data-assignee]').forEach(btn => {
            btn.addEventListener('click', () => {
                filterAssignee = btn.dataset.assignee;
                renderFilters();
                renderItems();
            });
        });
    }

    function bindShareButton() {
        const btn = document.getElementById('workshop-share-btn');
        if (!btn || btn._bound) return;
        btn._bound = true;
        btn.addEventListener('click', () => {
            const params = new URLSearchParams();
            if (filterAssignee) params.set('assignee', filterAssignee);
            if (filterProject) params.set('project', filterProject);
            const qs = params.toString();
            const shareUrl = window.location.origin + '/share/workshop' + (qs ? '?' + qs : '');
            const original = btn.textContent;
            navigator.clipboard.writeText(shareUrl)
                .then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = original; }, 1500); })
                .catch(() => { btn.textContent = 'Copy failed'; setTimeout(() => { btn.textContent = original; }, 1500); });
        });
    }

    function renderItems() {
        const el = document.getElementById('workshop-items');
        const countEl = document.getElementById('workshop-count');
        if (!el) return;
        let active = VideoService.getByStatus('workshop');
        if (countEl) countEl.textContent = `${active.length} in progress`;
        if (filterProject) active = active.filter(v => v.project === filterProject);
        if (filterAssignee === 'none') active = active.filter(v => getAssignedPeople(v).length === 0);
        else if (filterAssignee) active = active.filter(v => videoHasAssignee(v, filterAssignee));

        bindShareButton();

        if (active.length === 0) {
            el.innerHTML = '<div class="workshop-empty">Nothing in the workshop. Move ideas from the Incubator to start working!</div>';
            return;
        }
        el.innerHTML = active.map(v => {
            const preview = (v.hook || v.context || '').trim();
            const primaryAssignee = getPrimaryAssignee(v);
            const workerColor = getWorkerColor(primaryAssignee);
            const nameStyle = workerColor ? ` style="color:${escAttr(workerColor)}"` : '';
            return `
            <div class="workshop-card" data-id="${v.id}">
                <div class="workshop-card-egg">
                    <canvas class="workshop-egg-canvas" data-project="${escAttr(v.project)}" width="80" height="100" style="width:52px;height:64px"></canvas>
                </div>
                <div class="workshop-card-info">
                    <div class="workshop-card-name"><span class="workshop-card-name-text"${nameStyle}>${escHtml(v.name)}</span>${dotsHtml(v)}</div>
                    ${preview ? `<div class="workshop-card-preview">${escHtml(preview)}</div>` : ''}
                    <div class="workshop-card-meta">
                        ${v.project ? `<span class="workshop-card-project">${escHtml(v.project)}</span>` : ''}
                        ${getAssignedPeople(v).map(renderWorkerPill).join('')}
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

        // Assignee avatars
        let assigneeAvatarHtml = '';
        const assignedPeople = getAssignedPeople(v);
        if (assignedPeople.length) {
            assigneeAvatarHtml = `<div class="workshop-detail-avatars">${assignedPeople.map((name, idx) => `<canvas class="workshop-detail-avatar" id="workshop-detail-avatar-${idx}" data-worker="${escAttr(name)}" width="64" height="64"></canvas>`).join('')}</div>`;
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
                    <div class="workshop-detail-summary">
                        ${sourceIdeaHtml}
                        ${dotsHtml(v)}
                    </div>
                    <label>Video Name</label>
                    <input type="text" id="workshop-name" value="${escAttr(v.name)}">
                    <label>Project</label>
                    <select id="workshop-project">
                        <option value="">No project</option>
                        ${projects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                    </select>
                    <label>Assigned To</label>
                    ${renderAssigneePicker(v)}
                    <label>Hook</label>
                    <textarea id="workshop-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                    <label>Context</label>
                    <textarea id="workshop-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                    <label>Script</label>
                    ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', 'Script') : '<textarea id="workshop-script"></textarea>'}
                </div>
            </div>
        `;

        document.getElementById('workshop-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('workshop-post').addEventListener('click', () => postVideo());
        document.getElementById('workshop-to-incubator').addEventListener('click', () => backToIncubator());

        const assigneePicker = document.getElementById('workshop-assignee-picker');
        if (assigneePicker) {
            const summaryEl = assigneePicker.querySelector('summary');
            const updateSummary = () => {
                const selected = readAssignedPeopleFromPicker();
                summaryEl.textContent = selected.length ? selected.join(', ') : 'Unassigned';
            };
            assigneePicker.querySelectorAll('input[type="checkbox"]').forEach(input => {
                input.addEventListener('change', updateSummary);
            });
            updateSummary();
        }

        // Inline script editor — reads/writes video.script directly
        if (window.EggRenderer) {
            window.EggRenderer.initInlineScriptEditor('workshop-inline-script', {
                get: () => (selectedVideo && selectedVideo.script) || '',
                save: async (text) => {
                    if (!selectedVideo) return;
                    selectedVideo.script = text;
                    await VideoService.update(selectedVideo.id, { script: text });
                }
            });
        }

        // Init animated 3D egg preview for detail view
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
        // Render character avatars in detail
        if (assignedPeople.length && window.EggRenderer) {
            requestAnimationFrame(() => {
                assignedPeople.forEach((name, idx) => {
                    const avatarCanvas = document.getElementById(`workshop-detail-avatar-${idx}`);
                    if (avatarCanvas) window.EggRenderer.renderCharacterAvatar(name, avatarCanvas, 32);
                });
            });
        }
    }

    async function saveAndBack() {
        if (selectedVideo) {
            const name = document.getElementById('workshop-name')?.value.trim() || selectedVideo.name;
            const project = document.getElementById('workshop-project')?.value || '';
            const assignedToList = readAssignedPeopleFromPicker();
            const assignedTo = assignedToList[0] || '';
            const hook = document.getElementById('workshop-hook')?.value || '';
            const context = document.getElementById('workshop-context')?.value || '';
            await VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, assignedTo, assignedToList, hook, context });
        }
        showList();
    }

    async function postVideo() {
        if (!selectedVideo) return;

        // Require a script before posting
        if (!selectedVideo.script) {
            alert('A script is required before posting. Write a script first.');
            return;
        }

        const btn = document.getElementById('workshop-post');
        if (btn) { btn.textContent = 'Posting...'; btn.disabled = true; }

        const name = document.getElementById('workshop-name')?.value.trim() || selectedVideo.name;
        const project = document.getElementById('workshop-project')?.value || '';
        const assignedToList = readAssignedPeopleFromPicker();
        const assignedTo = assignedToList[0] || '';
        const hook = document.getElementById('workshop-hook')?.value || '';
        const context = document.getElementById('workshop-context')?.value || '';

        try {
            await VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, assignedTo, assignedToList, hook, context, status: 'posted', postedDate: new Date().toISOString() });
            // Spawn creature in 3D world immediately (skip sync — in-memory cache already updated)
            if (typeof spawnPostedCreatures === 'function') spawnPostedCreatures(true);
            // Notify Pen to auto-refresh if open
            window.dispatchEvent(new CustomEvent('video-posted'));
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
        const btn = container.querySelector('.back-to-incubator-btn');
        if (btn) { btn.textContent = 'Moving...'; btn.disabled = true; }
        try {
            await VideoService.moveToIncubator(selectedVideo.id);
            if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
            const panel = container.querySelector('.workshop-panel');
            const project = selectedVideo.project || '';
            if (panel && window.EggRenderer && project) {
                window.EggRenderer.showHatchAnimation(project, panel, () => showList());
            } else {
                showList();
            }
        } catch (e) {
            console.warn('Workshop: back to incubator failed', e);
            alert('Failed to move to Incubator.');
            if (btn) { btn.textContent = 'Back to Incubator'; btn.disabled = false; }
        }
    }

    return {
        async open(bodyEl) {
            container = bodyEl;
            render();
            const [p] = await Promise.all([
                VideoService.getProjects(),
                VideoService.sync(),
                ScriptService.sync().catch(() => {}),
                NotesService.sync().catch(() => {}),
            ]);
            projects = p;
            renderFilters();
            renderItems();
        },
        close() {
            if (currentPage === 'detail' && selectedVideo) {
                const name = document.getElementById('workshop-name')?.value.trim();
                const project = document.getElementById('workshop-project')?.value;
                const assignedToList = readAssignedPeopleFromPicker();
                const assignedTo = assignedToList[0] || '';
                const hook = document.getElementById('workshop-hook')?.value;
                const context = document.getElementById('workshop-context')?.value;
                if (name) {
                    VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, assignedTo, assignedToList, hook, context }).catch(() => {});
                }
            }
            // Cleanup 3D egg preview
            const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
            if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();

            container = null;
            selectedVideo = null;
            currentPage = 'list';
            filterProject = '';
            filterAssignee = '';
        }
    };
})();

BuildingRegistry.register('Workshop', {
    open: (bodyEl) => WorkshopUI.open(bodyEl),
    close: () => WorkshopUI.close()
});
