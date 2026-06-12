/**
 * Workshop UI — the deterministic video pipeline.
 * Replaces the old Incubator → Workshop two-step with one pipeline that
 * mirrors the flowchart from the Library DAG note. Tabs:
 *   Pipeline  — the live flowchart board; videos sit at their current stages
 *   Videos    — every video in the pipeline, filterable (stage/type/project/sponsor/blocked/deadline)
 *   Projects  — build projects + their components (e.g. Doc Ock Suit → Claw)
 *   Orders    — everything to buy: needed → ordered → received
 *   Inventory — the Component Library: props/footage/sets, ready or in progress
 *
 * Queue an idea from the Library and it enters at Video Ideation; mark stages
 * done and it flows through the graph; mark Posting done and it hatches into
 * the Pen, flipping anything it produced into ready Inventory.
 */
const WorkshopUI = (() => {
    let container = null;
    let dropboxProjects = []; // legacy Dropbox folder names (egg colors/flags)
    let activeTab = 'pipeline';
    let selectedVideo = null;
    let selectedStageId = null;
    let selectedProjectId = null;
    let currentPage = 'list';

    // Videos tab filters
    let fSearch = '', fStage = '', fType = '', fProject = '', fSponsor = '', fAssignee = '', fFlag = '';
    // Inventory tab filters
    let invType = '', invStatus = '';

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;
    const PS = () => PipelineStages;
    const SVC = () => PipelineService;

    const VIDEO_TYPES = ['Short', 'Long-form', 'Series', 'Collab', 'Sponsored', 'Vlog'];
    const COMPONENT_STATUSES = ['design', 'cad', 'manufacturing', 'assembly', 'done'];
    const ORDER_STATUSES = ['needed', 'ordered', 'received'];
    const INVENTORY_STATUSES = ['planned', 'building', 'ready'];
    const INVENTORY_TYPES = ['prop', 'footage', 'set', 'material', 'other'];
    const INV_TYPE_ICONS = { prop: '🪛', footage: '🎞️', set: '🏠', material: '🧱', other: '📦' };

    // ============ HELPERS ============

    function pipelineVideos() {
        return VideoService.getPipeline();
    }

    function getAssignedPeople(video) {
        if (!video) return [];
        const fromList = Array.isArray(video.assignedToList) ? video.assignedToList : [];
        const merged = fromList.length ? fromList : (video.assignedTo ? [video.assignedTo] : []);
        return [...new Set(merged.map(v => String(v || '').trim()).filter(Boolean))];
    }

    function getWorkerColor(name) {
        if (!name) return '';
        if (window.EmployeeService && window.EmployeeService.colorForName) {
            return window.EmployeeService.colorForName(name);
        }
        return '';
    }

    function rosterNames(current) {
        const names = (window.EmployeeService ? window.EmployeeService.getNames() : ['You', 'Robin', 'Jordan', 'Tennille']);
        const extras = (current || []).filter(n => n && !names.includes(n));
        return [...extras, ...names];
    }

    function workerPill(name) {
        if (!name) return '';
        const c = getWorkerColor(name);
        const style = c ? ` style="background:${escAttr(c)}18;color:${escAttr(c)}"` : '';
        return `<span class="workshop-card-worker"${style}>${escHtml(name)}</span>`;
    }

    function sponsorName(id) {
        if (!id) return '';
        const s = SVC().sponsors.getById(id);
        return s ? (s.name || '') : '';
    }

    function projectName(id) {
        const p = SVC().projects.getById(id);
        return p ? (p.name || '') : '';
    }

    function deadlineInfo(video) {
        if (!video.deadline) return null;
        const d = new Date(video.deadline + 'T23:59:59');
        if (isNaN(d)) return null;
        const days = Math.ceil((d - Date.now()) / 86400000);
        const cls = days < 0 ? 'overdue' : days <= 7 ? 'soon' : '';
        const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'due today' : `${days}d left`;
        return { days, cls, label, date: video.deadline };
    }

    function videoBlockers(video) {
        return PS().blockers(video, VideoService.getAll(), SVC().inventory.getAll());
    }

    function blockedBadge(video) {
        const b = videoBlockers(video);
        if (!b.length) return '';
        const titles = b.map(x => `${x.label} — ${x.detail}`).join('\n');
        return `<span class="wsp-blocked-badge" title="${escAttr(titles)}">🔒 ${b.length}</span>`;
    }

    function frontierChips(video, max) {
        const f = PS().frontier(video);
        const shown = max ? f.slice(0, max) : f;
        let html = shown.map(id => {
            const st = PS().get(id);
            return `<span class="wsp-stage-chip${st.bottleneck ? ' bottleneck' : ''}">${st.icon} ${escHtml(st.label)}</span>`;
        }).join('');
        if (max && f.length > max) html += `<span class="wsp-stage-chip more">+${f.length - max}</span>`;
        if (!f.length) html = `<span class="wsp-stage-chip done-chip">✅ Complete</span>`;
        return html;
    }

    function progressBar(video) {
        const p = PS().progress(video);
        return `<div class="wsp-progress" title="${p.done}/${p.total} stages done">
            <div class="wsp-progress-fill" style="width:${p.pct}%"></div>
        </div>`;
    }

    function flagOrDot(project) {
        if (project && window.EggRenderer) {
            return window.EggRenderer.projectFlagSvg(project, 18) ||
                `<span class="project-dot" style="background:${window.EggRenderer.getProjectColor(project)}"></span>`;
        }
        return '';
    }

    function toast(msg, duration = 2000) {
        const t = document.createElement('div');
        t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;z-index:99999;pointer-events:none;transition:opacity 0.3s;';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
    }

    // ============ ROOT RENDER ============

    function render() {
        container.innerHTML = `
            <div class="workshop-panel show-list">
                <div class="workshop-page workshop-list-page">
                    <div class="workshop-header">
                        <h2>Workshop</h2>
                        <span class="workshop-count" id="wsp-count"></span>
                        <button class="wsp-header-btn" id="wsp-queue-idea-btn" title="Queue an idea from the Library">📚 Queue Idea</button>
                        <button class="wsp-header-btn primary" id="wsp-new-video-btn">＋ New Video</button>
                    </div>
                    <div class="wsp-tabs">
                        <button class="wsp-tab active" data-tab="pipeline">Pipeline</button>
                        <button class="wsp-tab" data-tab="videos">Videos</button>
                        <button class="wsp-tab" data-tab="projects">Projects</button>
                        <button class="wsp-tab" data-tab="orders">Orders</button>
                        <button class="wsp-tab" data-tab="inventory">Inventory</button>
                    </div>
                    <div class="wsp-tab-body" id="wsp-tab-body">
                        <div class="workshop-empty">Loading pipeline…</div>
                    </div>
                </div>
                <div class="workshop-page workshop-detail-page">
                    <div class="workshop-detail" id="workshop-detail"></div>
                </div>
                <div class="wsp-picker-overlay" id="wsp-picker-overlay" style="display:none;">
                    <div class="wsp-picker">
                        <div class="wsp-picker-header">
                            <span id="wsp-picker-title">Pick an idea from the Library</span>
                            <button class="wsp-picker-close" id="wsp-picker-close">✕</button>
                        </div>
                        <div class="wsp-picker-list" id="wsp-picker-list"></div>
                    </div>
                </div>
            </div>
        `;

        container.querySelectorAll('.wsp-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
        document.getElementById('wsp-queue-idea-btn').addEventListener('click', showIdeaPicker);
        document.getElementById('wsp-new-video-btn').addEventListener('click', newVideoDraft);
        document.getElementById('wsp-picker-close').addEventListener('click', hidePicker);
        document.getElementById('wsp-picker-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'wsp-picker-overlay') hidePicker();
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        container.querySelectorAll('.wsp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        renderTab();
    }

    function renderTab() {
        const el = document.getElementById('wsp-tab-body');
        if (!el) return;
        updateCount();
        if (activeTab === 'pipeline') renderPipelineTab(el);
        else if (activeTab === 'videos') renderVideosTab(el);
        else if (activeTab === 'projects') renderProjectsTab(el);
        else if (activeTab === 'orders') renderOrdersTab(el);
        else if (activeTab === 'inventory') renderInventoryTab(el);
    }

    function updateCount() {
        const el = document.getElementById('wsp-count');
        if (el) el.textContent = `${pipelineVideos().length} in pipeline`;
    }

    // ============ TAB 1: PIPELINE BOARD ============

    const NODE_W = 150, NODE_H = 60, GAP_X = 60, GAP_Y = 26, PAD = 24;

    function boardPositions() {
        // Column = topological layer, row = index within layer (centered vertically)
        const layers = PS().LAYERS;
        const maxRows = Math.max(...layers.map(l => l.length), 2);
        const boardH = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y + 90; // +90 for the inventory node row
        const pos = {};
        layers.forEach((ids, li) => {
            const x = PAD + li * (NODE_W + GAP_X);
            const totalH = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
            const y0 = (boardH - 90 - totalH) / 2 + PAD / 2;
            ids.forEach((id, ri) => {
                pos[id] = { x, y: y0 + ri * (NODE_H + GAP_Y) };
            });
        });
        const boardW = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X;
        // Component Library (Inventory) reference node sits under Ordering
        const orderPos = pos['order'];
        pos['_inventory'] = { x: orderPos.x, y: boardH - 78 };
        return { pos, boardW, boardH };
    }

    function stageCounts() {
        const counts = {};
        PS().STAGES.forEach(s => { counts[s.id] = []; });
        pipelineVideos().forEach(v => {
            PS().frontier(v).forEach(id => counts[id].push(v));
        });
        return counts;
    }

    function edgePath(a, b) {
        const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
        const x2 = b.x, y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }

    function renderPipelineTab(el) {
        const { pos, boardW, boardH } = boardPositions();
        const counts = stageCounts();

        const edgesSvg = PS().EDGES.map(([f, t]) => {
            return `<path d="${edgePath(pos[f], pos[t])}" class="wsp-edge" />`;
        }).join('') +
        // dashed reference edges: Ordering ↔ Component Library
        `<path d="M ${pos['order'].x + NODE_W / 2} ${pos['order'].y + NODE_H} L ${pos['_inventory'].x + NODE_W / 2} ${pos['_inventory'].y}" class="wsp-edge ref" />`;

        const nodesHtml = PS().STAGES.map(s => {
            const p = pos[s.id];
            const vids = counts[s.id];
            const blockedHere = vids.filter(v => videoBlockers(v).length > 0).length;
            return `<div class="wsp-node${s.bottleneck ? ' bottleneck' : ''}${selectedStageId === s.id ? ' selected' : ''}${vids.length ? ' has-videos' : ''}"
                        data-stage="${s.id}" style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px;">
                <div class="wsp-node-label">${s.icon} ${escHtml(s.label)}</div>
                <div class="wsp-node-sub">${s.bottleneck ? '<span class="wsp-bottleneck-tag">bottleneck</span>' : `<span class="wsp-node-group">${escHtml(s.group)}</span>`}</div>
                ${vids.length ? `<span class="wsp-node-count">${vids.length}</span>` : ''}
                ${blockedHere ? `<span class="wsp-node-blocked" title="${blockedHere} blocked here">🔒</span>` : ''}
            </div>`;
        }).join('');

        const readyInv = SVC().inventory.getAll().filter(i => i.status === 'ready').length;
        const invNode = `<div class="wsp-node inv-node" data-goto="inventory" style="left:${pos['_inventory'].x}px;top:${pos['_inventory'].y}px;width:${NODE_W}px;height:54px;">
            <div class="wsp-node-label">🗃️ Component Library</div>
            <div class="wsp-node-sub"><span class="wsp-node-group">${readyInv} ready in inventory</span></div>
        </div>`;

        el.innerHTML = `
            <div class="wsp-board-wrap">
                <div class="wsp-board" style="width:${boardW}px;height:${boardH}px;">
                    <svg class="wsp-edges" width="${boardW}" height="${boardH}">${edgesSvg}</svg>
                    ${nodesHtml}
                    ${invNode}
                </div>
            </div>
            <div class="wsp-stage-panel" id="wsp-stage-panel"></div>
        `;

        el.querySelectorAll('.wsp-node[data-stage]').forEach(node => {
            node.addEventListener('click', () => {
                selectedStageId = selectedStageId === node.dataset.stage ? null : node.dataset.stage;
                renderPipelineTab(el);
            });
        });
        const goInv = el.querySelector('.wsp-node[data-goto="inventory"]');
        if (goInv) goInv.addEventListener('click', () => switchTab('inventory'));

        renderStagePanel();
    }

    function renderStagePanel() {
        const panel = document.getElementById('wsp-stage-panel');
        if (!panel) return;
        if (!selectedStageId) {
            const total = pipelineVideos().length;
            panel.innerHTML = `<div class="wsp-stage-panel-hint">Click a stage to see the videos sitting there. ${total ? '' : 'Queue an idea from the Library to start the pipeline.'}</div>`;
            return;
        }
        const stage = PS().get(selectedStageId);
        const vids = stageCounts()[selectedStageId] || [];

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div>
                    <div class="wsp-stage-panel-title">${stage.icon} ${escHtml(stage.label)} <span class="wsp-stage-panel-count">${vids.length}</span></div>
                    <div class="wsp-stage-panel-desc">${escHtml(stage.desc || '')}</div>
                </div>
                <button class="wsp-picker-close" id="wsp-stage-panel-close">✕</button>
            </div>
            <div class="wsp-stage-panel-list">
                ${vids.length === 0 ? '<div class="workshop-empty">No videos at this stage.</div>' : vids.map(v => {
                    const dl = deadlineInfo(v);
                    return `<div class="wsp-stage-video" data-id="${v.id}">
                        <div class="wsp-stage-video-main">
                            <div class="wsp-stage-video-name">${flagOrDot(v.project)} ${escHtml(v.name)} ${blockedBadge(v)}</div>
                            <div class="wsp-stage-video-meta">
                                ${v.videoType ? `<span class="wsp-type-chip">${escHtml(v.videoType)}</span>` : ''}
                                ${dl ? `<span class="wsp-deadline ${dl.cls}">⏰ ${dl.label}</span>` : ''}
                                ${getAssignedPeople(v).map(workerPill).join('')}
                            </div>
                        </div>
                        <div class="wsp-stage-video-actions">
                            <select class="wsp-claim-select" data-id="${v.id}" title="Assign / claim">
                                <option value="">＋ assign</option>
                                ${rosterNames(getAssignedPeople(v)).map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('')}
                            </select>
                            <button class="wsp-mini-btn done" data-done="${v.id}" title="Mark ${escAttr(stage.label)} done for this video">✓ Done</button>
                            <button class="wsp-mini-btn" data-open="${v.id}">Open</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        `;

        document.getElementById('wsp-stage-panel-close').addEventListener('click', () => {
            selectedStageId = null;
            renderTab();
        });
        panel.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openDetail(b.dataset.open)));
        panel.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            await setStageState(b.dataset.done, selectedStageId, 'done');
            renderTab();
        }));
        panel.querySelectorAll('.wsp-claim-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                const name = sel.value;
                if (!name) return;
                const v = VideoService.getById(sel.dataset.id);
                const people = [...new Set([...getAssignedPeople(v), name])];
                await VideoService.update(v.id, { assignedTo: people[0] || '', assignedToList: people, status: normalizedStatus(v) });
                renderStagePanel();
            });
        });
    }

    function normalizedStatus(video) {
        // First touch upgrades legacy incubator/workshop records into the pipeline
        return PS().isInPipeline(video) ? 'pipeline' : video.status;
    }

    // Serialize stage updates per video — two quick toggles would otherwise
    // both spread from the same stale stageState and clobber each other.
    let _stageUpdateChain = Promise.resolve();
    function setStageState(videoId, stageId, state) {
        _stageUpdateChain = _stageUpdateChain.catch(() => {}).then(async () => {
            const v = VideoService.getById(videoId);
            if (!v) return;
            const stageState = { ...(v.stageState || {}) };
            if (state) stageState[stageId] = state;
            else delete stageState[stageId];

            if (stageId === 'post' && state === 'done') {
                await postVideoRecord(v, stageState);
                return;
            }
            await VideoService.update(videoId, { stageState, status: normalizedStatus(v) });
        });
        return _stageUpdateChain;
    }

    // Posting is the deterministic end of the pipeline: hatch into the Pen,
    // flip produced inventory to ready.
    async function postVideoRecord(v, stageState) {
        await VideoService.update(v.id, {
            stageState: stageState || { ...(v.stageState || {}), post: 'done' },
            status: 'posted',
            postedDate: v.postedDate || new Date().toISOString()
        });
        await SVC().markProducedInventoryReady(v).catch(() => {});
        if (typeof spawnPostedCreatures === 'function') spawnPostedCreatures(true);
        window.dispatchEvent(new CustomEvent('video-posted'));
        const panel = container && container.querySelector('.workshop-panel');
        if (panel && window.EggRenderer && v.project) {
            window.EggRenderer.showHatchAnimation(v.project, panel, () => {});
        } else {
            toast(`"${v.name}" posted 🎉`);
        }
    }

    // ============ TAB 2: VIDEOS ============

    function renderVideosTab(el) {
        const all = pipelineVideos();
        const types = [...new Set(all.map(v => v.videoType).filter(Boolean))];
        const usedProjects = [...new Set(all.flatMap(v => (v.projectIds || [])))].map(id => SVC().projects.getById(id)).filter(Boolean);
        const usedSponsors = [...new Set(all.map(v => v.sponsorId).filter(Boolean))].map(id => SVC().sponsors.getById(id)).filter(Boolean);
        const assignees = [...new Set(all.flatMap(getAssignedPeople))];

        let list = all;
        if (fSearch) {
            const q = fSearch.toLowerCase();
            list = list.filter(v => (v.name || '').toLowerCase().includes(q) || (v.hook || '').toLowerCase().includes(q));
        }
        if (fStage) list = list.filter(v => PS().frontier(v).includes(fStage));
        if (fType) list = list.filter(v => v.videoType === fType);
        if (fProject) list = list.filter(v => (v.projectIds || []).includes(fProject));
        if (fSponsor) list = list.filter(v => v.sponsorId === fSponsor);
        if (fAssignee === 'none') list = list.filter(v => getAssignedPeople(v).length === 0);
        else if (fAssignee) list = list.filter(v => getAssignedPeople(v).includes(fAssignee));
        if (fFlag === 'blocked') list = list.filter(v => videoBlockers(v).length > 0);
        if (fFlag === 'deadline') list = list.filter(v => { const d = deadlineInfo(v); return d && d.days <= 7; });

        // Soonest deadline first, then most recently updated
        list = [...list].sort((a, b) => {
            const da = a.deadline || '9999', db = b.deadline || '9999';
            if (da !== db) return da < db ? -1 : 1;
            return (b.updatedAt || '') < (a.updatedAt || '') ? -1 : 1;
        });

        el.innerHTML = `
            <div class="wsp-filterbar">
                <input type="text" class="wsp-search" id="wsp-f-search" placeholder="Search videos…" value="${escAttr(fSearch)}">
                <select id="wsp-f-stage">
                    <option value="">All stages</option>
                    ${PS().STAGES.map(s => `<option value="${s.id}" ${fStage === s.id ? 'selected' : ''}>${s.icon} ${escHtml(s.label)}</option>`).join('')}
                </select>
                ${types.length ? `<select id="wsp-f-type"><option value="">All types</option>${types.map(t => `<option ${fType === t ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}</select>` : ''}
                ${usedProjects.length ? `<select id="wsp-f-project"><option value="">All projects</option>${usedProjects.map(p => `<option value="${p.id}" ${fProject === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}</select>` : ''}
                ${usedSponsors.length ? `<select id="wsp-f-sponsor"><option value="">All sponsors</option>${usedSponsors.map(s => `<option value="${s.id}" ${fSponsor === s.id ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('')}</select>` : ''}
                ${assignees.length ? `<select id="wsp-f-assignee"><option value="">Anyone</option>${assignees.map(a => `<option ${fAssignee === a ? 'selected' : ''}>${escHtml(a)}</option>`).join('')}<option value="none" ${fAssignee === 'none' ? 'selected' : ''}>Unassigned</option></select>` : ''}
                <div class="wsp-flag-btns">
                    <button class="workshop-filter-btn ${fFlag === 'blocked' ? 'active' : ''}" data-flag="blocked">🔒 Blocked</button>
                    <button class="workshop-filter-btn ${fFlag === 'deadline' ? 'active' : ''}" data-flag="deadline">⏰ Due soon</button>
                </div>
            </div>
            <div class="workshop-items" id="wsp-video-list">
                ${list.length === 0 ? '<div class="workshop-empty">No videos match. Queue an idea from the Library to feed the pipeline!</div>' : list.map(videoCardHtml).join('')}
            </div>
        `;

        const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('change', () => { fn(e.value); renderTab(); }); };
        const search = document.getElementById('wsp-f-search');
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => { fSearch = search.value; renderTab(); const s2 = document.getElementById('wsp-f-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }, 250);
            });
        }
        bind('wsp-f-stage', v => fStage = v);
        bind('wsp-f-type', v => fType = v);
        bind('wsp-f-project', v => fProject = v);
        bind('wsp-f-sponsor', v => fSponsor = v);
        bind('wsp-f-assignee', v => fAssignee = v);
        el.querySelectorAll('[data-flag]').forEach(b => b.addEventListener('click', () => {
            fFlag = fFlag === b.dataset.flag ? '' : b.dataset.flag;
            renderTab();
        }));
        el.querySelectorAll('.workshop-card').forEach(card => {
            card.addEventListener('click', () => openDetail(card.dataset.id));
        });
        requestAnimationFrame(() => renderCardAssets());
    }

    function videoCardHtml(v) {
        const dl = deadlineInfo(v);
        const projChips = (v.projectIds || []).map(id => {
            const p = SVC().projects.getById(id);
            return p ? `<span class="wsp-proj-chip">🛠️ ${escHtml(p.name)}</span>` : '';
        }).join('');
        const sp = sponsorName(v.sponsorId);
        return `
        <div class="workshop-card" data-id="${v.id}">
            <div class="workshop-card-egg">
                <canvas class="workshop-egg-canvas" data-project="${escAttr(v.project)}" width="80" height="100" style="width:52px;height:64px"></canvas>
            </div>
            <div class="workshop-card-info">
                <div class="workshop-card-name"><span class="workshop-card-name-text">${escHtml(v.name)}</span> ${blockedBadge(v)}</div>
                <div class="wsp-card-stages">${frontierChips(v, 3)}</div>
                <div class="workshop-card-meta">
                    ${v.videoType ? `<span class="wsp-type-chip">${escHtml(v.videoType)}</span>` : ''}
                    ${dl ? `<span class="wsp-deadline ${dl.cls}">⏰ ${dl.label}</span>` : ''}
                    ${sp ? `<span class="wsp-sponsor-chip">💰 ${escHtml(sp)}</span>` : ''}
                    ${projChips}
                    ${v.project ? `<span class="workshop-card-project">${escHtml(v.project)}</span>` : ''}
                    ${getAssignedPeople(v).map(workerPill).join('')}
                </div>
                ${progressBar(v)}
            </div>
        </div>`;
    }

    async function renderCardAssets() {
        if (!window.EggRenderer || !container) return;
        const eggPromises = [];
        container.querySelectorAll('.workshop-egg-canvas').forEach(canvas => {
            eggPromises.push(window.EggRenderer.renderEggSnapshot(canvas.dataset.project, canvas, 40));
        });
        container.querySelectorAll('.workshop-avatar-canvas').forEach(canvas => {
            window.EggRenderer.renderCharacterAvatar(canvas.dataset.worker, canvas, 32);
        });
        await Promise.all(eggPromises);
    }

    // ============ TAB 3: PROJECTS ============

    function renderProjectsTab(el) {
        const projects = SVC().projects.getAll().filter(p => p.status !== 'archived');
        const selected = selectedProjectId ? SVC().projects.getById(selectedProjectId) : null;

        if (selected) { renderProjectDetail(el, selected); return; }

        el.innerHTML = `
            <div class="wsp-section-head">
                <span class="wsp-section-title">Build projects — physical builds that videos depend on</span>
                <button class="wsp-header-btn primary" id="wsp-add-project">＋ New Project</button>
            </div>
            <div class="wsp-grid">
                ${projects.length === 0 ? '<div class="workshop-empty">No projects yet. A project is a build (e.g. "Doc Ock Suit") that one or more videos need.</div>' : projects.map(p => {
                    const comps = SVC().componentsForProject(p.id);
                    const compsDone = comps.filter(c => c.status === 'done').length;
                    const vids = pipelineVideos().filter(v => (v.projectIds || []).includes(p.id));
                    const openOrders = SVC().ordersForProject(p.id).filter(o => o.status !== 'received').length;
                    return `<div class="wsp-tile" data-project="${p.id}">
                        <div class="wsp-tile-title">🛠️ ${escHtml(p.name)} ${p.status === 'done' ? '✅' : ''}</div>
                        ${p.description ? `<div class="wsp-tile-desc">${escHtml(p.description)}</div>` : ''}
                        <div class="wsp-tile-meta">
                            <span>${comps.length ? `${compsDone}/${comps.length} components` : 'no components'}</span>
                            <span>${vids.length} video${vids.length === 1 ? '' : 's'}</span>
                            ${openOrders ? `<span class="wsp-deadline soon">${openOrders} open order${openOrders === 1 ? '' : 's'}</span>` : ''}
                        </div>
                    </div>`;
                }).join('')}
            </div>
        `;
        document.getElementById('wsp-add-project').addEventListener('click', async () => {
            const name = prompt('Project name (e.g. "Doc Ock Suit"):');
            if (!name || !name.trim()) return;
            const p = await SVC().projects.create({ name: name.trim(), description: '', status: 'active', deadline: '', notes: '' });
            selectedProjectId = p.id;
            renderTab();
        });
        el.querySelectorAll('[data-project]').forEach(tile => {
            tile.addEventListener('click', () => { selectedProjectId = tile.dataset.project; renderTab(); });
        });
    }

    // --- Component tree (infinitely nestable: Doc Ock Suit → Arm → Claw → Actuator) ---
    function componentChildren(projectId, parentId) {
        return SVC().components.getAll()
            .filter(c => c.projectId === projectId && (c.parentComponentId || '') === (parentId || ''))
            .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    }
    function componentDescendants(projectId, parentId) {
        const kids = componentChildren(projectId, parentId);
        return kids.flatMap(k => [k, ...componentDescendants(projectId, k.id)]);
    }
    function componentTreeHtml(projectId, parentId, depth) {
        return componentChildren(projectId, parentId).map(c => {
            const sub = componentDescendants(projectId, c.id);
            const subDone = sub.filter(k => k.status === 'done').length;
            return `<div class="wsp-row wsp-comp-row${depth ? ' nested' : ''}" data-comp="${c.id}" style="margin-left:${depth * 24}px">
                <span class="wsp-row-name">${depth ? '<span class="wsp-comp-branch">↳</span> ' : ''}${escHtml(c.name)}${sub.length ? ` <span class="wsp-hint">${subDone}/${sub.length} sub-components done</span>` : ''}</span>
                <div class="wsp-status-cycle">
                    ${COMPONENT_STATUSES.map(s => `<button class="wsp-pill ${c.status === s ? 'active' : ''}" data-comp-status="${s}">${s}</button>`).join('')}
                </div>
                <button class="wsp-mini-btn" data-comp-sub="${c.id}" title="Break this down further — add a sub-component">＋ sub</button>
                <button class="wsp-mini-btn danger" data-comp-del="${c.id}">✕</button>
            </div>` + componentTreeHtml(projectId, c.id, depth + 1);
        }).join('');
    }

    function renderProjectDetail(el, p) {
        const comps = SVC().componentsForProject(p.id);
        const vids = VideoService.getAll().filter(v => (v.projectIds || []).includes(p.id));
        const orders = SVC().ordersForProject(p.id);
        const inv = SVC().inventoryForProject(p.id);

        el.innerHTML = `
            <div class="wsp-section-head">
                <button class="wsp-mini-btn" id="wsp-proj-back">← Projects</button>
                <span class="wsp-section-title">🛠️ ${escHtml(p.name)}</span>
                <select id="wsp-proj-status" class="wsp-inline-select">
                    ${['active', 'done', 'archived'].map(s => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <button class="wsp-mini-btn danger" id="wsp-proj-delete">Delete</button>
            </div>
            <div class="wsp-proj-body">
                <textarea id="wsp-proj-desc" class="wsp-textarea" placeholder="What is this project?">${escHtml(p.description || '')}</textarea>

                <div class="wsp-subsection">
                    <div class="wsp-subsection-title">Components <span class="wsp-hint">— break the build down as deep as you need (＋ sub on any component); each layer tracks design → cad → manufacturing → assembly → done</span></div>
                    ${componentTreeHtml(p.id, '', 0)}
                    <div class="wsp-add-row">
                        <input type="text" id="wsp-new-comp" placeholder="Add component (e.g. 'Arm')">
                        <button class="wsp-mini-btn done" id="wsp-add-comp">Add</button>
                    </div>
                </div>

                <div class="wsp-subsection">
                    <div class="wsp-subsection-title">Videos using this project</div>
                    ${vids.length === 0 ? '<div class="wsp-hint">None linked yet — link from a video\'s detail page.</div>' : vids.map(v => `
                        <div class="wsp-row clickable" data-video="${v.id}">
                            <span class="wsp-row-name">${escHtml(v.name)}</span>
                            ${v.status === 'posted' ? '<span class="wsp-pill active">posted</span>' : frontierChips(v, 2)}
                        </div>`).join('')}
                </div>

                <div class="wsp-subsection">
                    <div class="wsp-subsection-title">Orders for this project</div>
                    ${orders.length === 0 ? '<div class="wsp-hint">No orders.</div>' : orders.map(orderRowHtml).join('')}
                    ${addOrderRowHtml({ projectId: p.id })}
                </div>

                <div class="wsp-subsection">
                    <div class="wsp-subsection-title">Inventory from this project</div>
                    ${inv.length === 0 ? '<div class="wsp-hint">Nothing yet.</div>' : inv.map(i => `
                        <div class="wsp-row">
                            <span class="wsp-row-name">${INV_TYPE_ICONS[i.type] || '📦'} ${escHtml(i.name)}</span>
                            <span class="wsp-pill ${i.status === 'ready' ? 'active' : ''}">${i.status}</span>
                        </div>`).join('')}
                </div>
            </div>
        `;

        document.getElementById('wsp-proj-back').addEventListener('click', () => { selectedProjectId = null; renderTab(); });
        document.getElementById('wsp-proj-status').addEventListener('change', async (e) => {
            await SVC().projects.update(p.id, { status: e.target.value });
        });
        let descTimer = null;
        document.getElementById('wsp-proj-desc').addEventListener('input', (e) => {
            clearTimeout(descTimer);
            descTimer = setTimeout(() => SVC().projects.update(p.id, { description: e.target.value }).catch(() => {}), 800);
        });
        document.getElementById('wsp-proj-delete').addEventListener('click', async () => {
            if (!confirm(`Delete project "${p.name}"? (Videos and inventory are kept — only the project record and its components are removed.)`)) return;
            await Promise.all(comps.map(c => SVC().components.remove(c.id).catch(() => {})));
            await SVC().projects.remove(p.id);
            selectedProjectId = null;
            renderTab();
        });
        document.getElementById('wsp-add-comp').addEventListener('click', addComp);
        document.getElementById('wsp-new-comp').addEventListener('keydown', (e) => { if (e.key === 'Enter') addComp(); });
        async function addComp() {
            const input = document.getElementById('wsp-new-comp');
            const name = input.value.trim();
            if (!name) return;
            await SVC().components.create({ projectId: p.id, parentComponentId: '', name, status: 'design', notes: '' });
            renderTab();
        }
        el.querySelectorAll('[data-comp]').forEach(row => {
            const compId = row.dataset.comp;
            row.querySelectorAll('[data-comp-status]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await SVC().components.update(compId, { status: btn.dataset.compStatus });
                    renderTab();
                });
            });
        });
        // Componentize any component: add a child layer beneath it
        el.querySelectorAll('[data-comp-sub]').forEach(btn => btn.addEventListener('click', async () => {
            const parent = SVC().components.getById(btn.dataset.compSub);
            const name = prompt(`Sub-component of "${parent ? parent.name : ''}":`);
            if (!name || !name.trim()) return;
            await SVC().components.create({ projectId: p.id, parentComponentId: btn.dataset.compSub, name: name.trim(), status: 'design', notes: '' });
            renderTab();
        }));
        // Deleting a component removes its whole subtree
        el.querySelectorAll('[data-comp-del]').forEach(btn => btn.addEventListener('click', async () => {
            const comp = SVC().components.getById(btn.dataset.compDel);
            const sub = componentDescendants(p.id, btn.dataset.compDel);
            if (sub.length && !confirm(`Delete "${comp ? comp.name : ''}" and its ${sub.length} sub-component${sub.length === 1 ? '' : 's'}?`)) return;
            await Promise.all(sub.map(s => SVC().components.remove(s.id).catch(() => {})));
            await SVC().components.remove(btn.dataset.compDel);
            renderTab();
        }));
        el.querySelectorAll('[data-video]').forEach(row => row.addEventListener('click', () => openDetail(row.dataset.video)));
        bindOrderRows(el);
    }

    // ============ TAB 4: ORDERS ============

    function orderRowHtml(o) {
        const v = o.videoId ? VideoService.getById(o.videoId) : null;
        const p = o.projectId ? SVC().projects.getById(o.projectId) : null;
        return `<div class="wsp-row" data-order="${o.id}">
            <span class="wsp-row-name">${escHtml(o.name)}${o.cost ? ` <span class="wsp-hint">$${escHtml(String(o.cost))}</span>` : ''}${o.link ? ` <a href="${escAttr(o.link)}" target="_blank" rel="noopener" class="wsp-link">link</a>` : ''}</span>
            ${v ? `<span class="wsp-hint">🎬 ${escHtml(v.name)}</span>` : ''}
            ${p ? `<span class="wsp-hint">🛠️ ${escHtml(p.name)}</span>` : ''}
            <div class="wsp-status-cycle">
                ${ORDER_STATUSES.map(s => `<button class="wsp-pill ${o.status === s ? 'active' : ''}" data-order-status="${s}">${s}</button>`).join('')}
            </div>
            <button class="wsp-mini-btn danger" data-order-del="${o.id}">✕</button>
        </div>`;
    }

    function addOrderRowHtml(ctx) {
        const ctxAttrs = `${ctx.videoId ? `data-ctx-video="${ctx.videoId}"` : ''} ${ctx.projectId ? `data-ctx-project="${ctx.projectId}"` : ''}`;
        return `<div class="wsp-add-row wsp-add-order" ${ctxAttrs}>
            <input type="text" class="wsp-new-order-name" placeholder="Order something (e.g. 'Servo motors x4')">
            <input type="text" class="wsp-new-order-link" placeholder="Link (optional)">
            <input type="number" class="wsp-new-order-cost" placeholder="$" min="0" step="0.01">
            <button class="wsp-mini-btn done wsp-add-order-btn">Add</button>
        </div>`;
    }

    function bindOrderRows(scope) {
        scope.querySelectorAll('[data-order]').forEach(row => {
            const orderId = row.dataset.order;
            row.querySelectorAll('[data-order-status]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await SVC().orders.update(orderId, { status: btn.dataset.orderStatus });
                    renderTab();
                    if (currentPage === 'detail' && selectedVideo) renderDetail();
                });
            });
        });
        scope.querySelectorAll('[data-order-del]').forEach(btn => btn.addEventListener('click', async () => {
            await SVC().orders.remove(btn.dataset.orderDel);
            renderTab();
            if (currentPage === 'detail' && selectedVideo) renderDetail();
        }));
        scope.querySelectorAll('.wsp-add-order').forEach(rowEl => {
            const btn = rowEl.querySelector('.wsp-add-order-btn');
            const add = async () => {
                const name = rowEl.querySelector('.wsp-new-order-name').value.trim();
                if (!name) return;
                await SVC().orders.create({
                    name,
                    link: rowEl.querySelector('.wsp-new-order-link').value.trim(),
                    cost: parseFloat(rowEl.querySelector('.wsp-new-order-cost').value) || 0,
                    qty: 1,
                    status: 'needed',
                    videoId: rowEl.dataset.ctxVideo || '',
                    projectId: rowEl.dataset.ctxProject || '',
                    componentId: '',
                    notes: ''
                });
                renderTab();
                if (currentPage === 'detail' && selectedVideo) renderDetail();
            };
            btn.addEventListener('click', add);
            rowEl.querySelector('.wsp-new-order-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        });
    }

    function renderOrdersTab(el) {
        const orders = SVC().orders.getAll();
        el.innerHTML = `
            <div class="wsp-section-head">
                <span class="wsp-section-title">Ordering — the bottleneck. Keep this empty.</span>
            </div>
            <div class="wsp-order-cols">
                ${ORDER_STATUSES.map(status => {
                    const items = orders.filter(o => o.status === status);
                    const titles = { needed: '🛒 Needed', ordered: '🚚 Ordered', received: '✅ Received' };
                    return `<div class="wsp-order-col">
                        <div class="wsp-order-col-title">${titles[status]} <span class="wsp-stage-panel-count">${items.length}</span></div>
                        ${items.map(orderRowHtml).join('') || '<div class="wsp-hint">—</div>'}
                    </div>`;
                }).join('')}
            </div>
            <div class="wsp-subsection">${addOrderRowHtml({})}</div>
        `;
        bindOrderRows(el);
    }

    // ============ TAB 5: INVENTORY ============

    function renderInventoryTab(el) {
        let items = SVC().inventory.getAll();
        if (invType) items = items.filter(i => i.type === invType);
        if (invStatus) items = items.filter(i => i.status === invStatus);
        items = [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        el.innerHTML = `
            <div class="wsp-section-head">
                <span class="wsp-section-title">Component Library — what exists & what's usable right now</span>
            </div>
            <div class="wsp-filterbar">
                <select id="wsp-inv-type"><option value="">All types</option>${INVENTORY_TYPES.map(t => `<option ${invType === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
                <select id="wsp-inv-status"><option value="">Any status</option>${INVENTORY_STATUSES.map(s => `<option ${invStatus === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
            </div>
            <div class="wsp-grid">
                ${items.length === 0 ? '<div class="workshop-empty">Nothing in inventory. Props you build, footage you film, sets you make — they all live here so future videos can reuse them.</div>' : items.map(i => {
                    const proj = i.projectId ? SVC().projects.getById(i.projectId) : null;
                    const prod = i.producedByVideoId ? VideoService.getById(i.producedByVideoId) : null;
                    return `<div class="wsp-tile inv-tile ${i.status}">
                        <div class="wsp-tile-title">${INV_TYPE_ICONS[i.type] || '📦'} ${escHtml(i.name)}</div>
                        <div class="wsp-status-cycle">
                            ${INVENTORY_STATUSES.map(s => `<button class="wsp-pill ${i.status === s ? 'active' : ''}" data-inv="${i.id}" data-inv-status="${s}">${s}</button>`).join('')}
                        </div>
                        <div class="wsp-tile-meta">
                            <span>${escHtml(i.type || 'other')}${i.source ? ` · ${escHtml(i.source)}` : ''}</span>
                            ${proj ? `<span>🛠️ ${escHtml(proj.name)}</span>` : ''}
                            ${prod ? `<span>from 🎬 ${escHtml(prod.name)}</span>` : ''}
                        </div>
                        <button class="wsp-mini-btn danger wsp-tile-del" data-inv-del="${i.id}">✕</button>
                    </div>`;
                }).join('')}
            </div>
            <div class="wsp-add-row wsp-subsection">
                <input type="text" id="wsp-new-inv-name" placeholder="Add item (e.g. 'Iron Man helmet')">
                <select id="wsp-new-inv-type">${INVENTORY_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
                <select id="wsp-new-inv-status">${INVENTORY_STATUSES.map(s => `<option ${s === 'ready' ? 'selected' : ''}>${s}</option>`).join('')}</select>
                <button class="wsp-mini-btn done" id="wsp-add-inv">Add</button>
            </div>
        `;

        document.getElementById('wsp-inv-type').addEventListener('change', e => { invType = e.target.value; renderTab(); });
        document.getElementById('wsp-inv-status').addEventListener('change', e => { invStatus = e.target.value; renderTab(); });
        const add = async () => {
            const name = document.getElementById('wsp-new-inv-name').value.trim();
            if (!name) return;
            await SVC().inventory.create({
                name,
                type: document.getElementById('wsp-new-inv-type').value,
                status: document.getElementById('wsp-new-inv-status').value,
                source: 'owned', projectId: '', producedByVideoId: '', location: '', notes: ''
            });
            renderTab();
        };
        document.getElementById('wsp-add-inv').addEventListener('click', add);
        document.getElementById('wsp-new-inv-name').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
        el.querySelectorAll('[data-inv-status]').forEach(btn => btn.addEventListener('click', async () => {
            await SVC().inventory.update(btn.dataset.inv, { status: btn.dataset.invStatus });
            renderTab();
        }));
        el.querySelectorAll('[data-inv-del]').forEach(btn => btn.addEventListener('click', async () => {
            if (!confirm('Remove this inventory item?')) return;
            await SVC().inventory.remove(btn.dataset.invDel);
            renderTab();
        }));
    }

    // ============ QUEUE IDEA / NEW VIDEO ============

    function showIdeaPicker() {
        const overlay = document.getElementById('wsp-picker-overlay');
        const listEl = document.getElementById('wsp-picker-list');
        if (!overlay || !listEl) return;
        document.getElementById('wsp-picker-title').textContent = 'Queue an idea into the pipeline';

        const ideas = NotesService.getAll().filter(n => n.type === 'idea');
        if (ideas.length === 0) {
            listEl.innerHTML = '<div class="workshop-empty">No unqueued ideas in the Library. Write ideas there first — good or bad, they all live in the Library.</div>';
        } else {
            listEl.innerHTML = ideas.map(n => {
                const preview = n.hook || n.context || '';
                return `<div class="wsp-picker-item" data-id="${n.id}">
                    <div class="wsp-picker-name">${escHtml(n.name)}${n.script ? ' <span class="wsp-hint">📜 has script</span>' : ''}</div>
                    <div class="wsp-picker-preview">${escHtml(preview.substring(0, 90))}</div>
                </div>`;
            }).join('');
            listEl.querySelectorAll('.wsp-picker-item').forEach(item => {
                item.addEventListener('click', () => queueIdea(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    function hidePicker() {
        const overlay = document.getElementById('wsp-picker-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    async function queueIdea(noteId) {
        const note = NotesService.getById(noteId);
        if (!note) return;
        const existing = VideoService.getByIdeaId(noteId);
        if (existing) { alert('This idea is already in the pipeline.'); hidePicker(); return; }

        const item = document.querySelector(`.wsp-picker-item[data-id="${noteId}"]`);
        if (item) { item.style.opacity = '0.5'; item.style.pointerEvents = 'none'; }

        try {
            const video = await VideoService.create({
                name: note.name || 'Untitled Video',
                hook: note.hook || '',
                context: note.context || '',
                script: note.script || '',
                project: note.project || '',
                sourceIdeaId: note.id,
                status: 'pipeline',
                stageState: {}
            });
            // The idea stays in the Library — it's just marked as queued
            await NotesService.update(note.id, { type: 'converted' });
            hidePicker();
            const panel = container.querySelector('.workshop-panel');
            if (panel && window.EggRenderer && note.project) {
                window.EggRenderer.showEggReveal(note.project, panel, () => openDetail(video.id), 'Queued into the pipeline!');
            } else {
                openDetail(video.id);
            }
        } catch (e) {
            console.warn('Workshop: queue idea failed', e);
            alert('Failed to queue idea. Check connection.');
        }
    }

    async function newVideoDraft() {
        const name = prompt('Video name:');
        if (!name || !name.trim()) return;
        try {
            const video = await VideoService.create({ name: name.trim(), status: 'pipeline', stageState: {} });
            openDetail(video.id);
        } catch (e) {
            console.warn('Workshop: create video failed', e);
            alert('Failed to create video. Check connection.');
        }
    }

    // ============ VIDEO DETAIL ============

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
        const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
        if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();
        currentPage = 'list';
        selectedVideo = null;
        const panel = container.querySelector('.workshop-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderTab();
    }

    function stageChecklistHtml(v) {
        // Stages grouped by topo layer, left → right like the board
        return `<div class="wsp-checklist">
            ${PS().LAYERS.map(ids => `<div class="wsp-checklist-col">
                ${ids.map(id => {
                    const st = PS().get(id);
                    const state = PS().stateOf(v, id);
                    const ready = PS().isReady(v, id);
                    const cls = state === 'done' ? 'done' : state === 'na' ? 'na' : ready ? 'ready' : 'locked';
                    return `<div class="wsp-check ${cls}" data-stage="${id}" title="${escAttr(st.desc || '')}">
                        <span class="wsp-check-mark">${state === 'done' ? '✓' : state === 'na' ? '–' : ready ? '●' : '○'}</span>
                        <span class="wsp-check-label">${st.icon} ${escHtml(st.label)}</span>
                        <span class="wsp-check-actions">
                            <button class="wsp-check-btn" data-act="done" title="Mark done">✓</button>
                            <button class="wsp-check-btn" data-act="na" title="Not applicable for this video">N/A</button>
                        </span>
                    </div>`;
                }).join('')}
            </div>`).join('')}
        </div>`;
    }

    function chipListHtml(items, removeAttr) {
        return items.map(i => `<span class="wsp-chip">${escHtml(i.label)} <button class="wsp-chip-x" ${removeAttr}="${i.id}">✕</button></span>`).join('');
    }

    function renderDetail() {
        const el = document.getElementById('workshop-detail');
        if (!el || !selectedVideo) return;
        const v = VideoService.getById(selectedVideo.id) || selectedVideo;
        selectedVideo = v;

        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="workshop-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }

        const assignedPeople = getAssignedPeople(v);
        const blockers = videoBlockers(v);
        const sponsors = SVC().sponsors.getAll();
        const allProjects = SVC().projects.getAll().filter(p => p.status !== 'archived');
        const linkedProjects = (v.projectIds || []).map(id => SVC().projects.getById(id)).filter(Boolean);
        const deps = (v.dependsOn || []).map(id => VideoService.getById(id)).filter(Boolean);
        const reqInv = (v.requiredInventoryIds || []).map(id => SVC().inventory.getById(id)).filter(Boolean);
        const prodInv = (v.producesInventoryIds || []).map(id => SVC().inventory.getById(id)).filter(Boolean);
        const myOrders = SVC().ordersForVideo(v.id);
        const otherVideos = VideoService.getAll().filter(o => o.id !== v.id && !(v.dependsOn || []).includes(o.id));
        const inventoryAll = SVC().inventory.getAll();

        el.innerHTML = `
            <div class="workshop-detail-toolbar">
                <button class="workshop-back-btn" id="workshop-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <div class="workshop-detail-actions">
                    <button class="workshop-action-btn post-btn" id="workshop-post">Post Video</button>
                    <button class="workshop-action-btn" id="workshop-to-library">Return to Library</button>
                    <button class="workshop-action-btn danger-btn" id="workshop-delete">Delete</button>
                </div>
            </div>
            <div class="workshop-detail-body">
                <div class="workshop-detail-egg">
                    ${v.project ? `<canvas id="workshop-detail-egg-canvas" class="workshop-egg-preview-canvas" width="160" height="200"></canvas>` : window.EggRenderer ? window.EggRenderer.renderSilhouetteEgg() : ''}
                    ${assignedPeople.length ? `<div class="workshop-detail-avatars">${assignedPeople.map((name, idx) => `<canvas class="workshop-detail-avatar" id="workshop-detail-avatar-${idx}" data-worker="${escAttr(name)}" width="64" height="64"></canvas>`).join('')}</div>` : ''}
                    ${progressBar(v)}
                </div>
                <div class="workshop-detail-fields">
                    <div class="workshop-detail-summary">${sourceIdeaHtml}</div>

                    ${blockers.length ? `<div class="wsp-blockers-box">
                        <div class="wsp-blockers-title">🔒 Blocked — bottlenecked by:</div>
                        ${blockers.map(b => `<div class="wsp-blocker-line">${b.kind === 'video' ? '🎬' : '🗃️'} ${escHtml(b.label)} <span class="wsp-hint">${escHtml(b.detail)}</span></div>`).join('')}
                    </div>` : ''}

                    <label>Video Name</label>
                    <input type="text" id="workshop-name" value="${escAttr(v.name)}">

                    <div class="wsp-field-grid">
                        <div>
                            <label>Type</label>
                            <input type="text" id="workshop-type" list="wsp-type-list" value="${escAttr(v.videoType || '')}" placeholder="e.g. Short">
                            <datalist id="wsp-type-list">${VIDEO_TYPES.map(t => `<option>${t}</option>`).join('')}</datalist>
                        </div>
                        <div>
                            <label>Deadline</label>
                            <input type="date" id="workshop-deadline" value="${escAttr(v.deadline || '')}">
                        </div>
                        <div>
                            <label>Sponsor</label>
                            <select id="workshop-sponsor">
                                <option value="">No sponsor</option>
                                ${sponsors.map(s => `<option value="${s.id}" ${v.sponsorId === s.id ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('')}
                            </select>
                        </div>
                        <div>
                            <label>Channel Project (egg)</label>
                            <select id="workshop-project">
                                <option value="">No project</option>
                                ${dropboxProjects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <label>Assigned To</label>
                    <details class="workshop-assignee-picker" id="workshop-assignee-picker">
                        <summary>${escHtml(assignedPeople.length ? assignedPeople.join(', ') : 'Unassigned')}</summary>
                        <div class="workshop-assignee-menu">
                            ${rosterNames(assignedPeople).map(w => `<label class="workshop-assignee-option"><input type="checkbox" value="${escAttr(w)}" ${assignedPeople.includes(w) ? 'checked' : ''}> <span>${escHtml(w)}</span></label>`).join('')}
                        </div>
                    </details>

                    <label>Pipeline Progress</label>
                    ${stageChecklistHtml(v)}

                    <div class="wsp-subsection">
                        <div class="wsp-subsection-title">🛠️ Build projects <span class="wsp-hint">— builds this video needs (shared across videos)</span></div>
                        <div class="wsp-chips">${chipListHtml(linkedProjects.map(p => ({ id: p.id, label: p.name })), 'data-unlink-project')}</div>
                        <div class="wsp-add-row">
                            <select id="wsp-link-project">
                                <option value="">Link a project…</option>
                                ${allProjects.filter(p => !(v.projectIds || []).includes(p.id)).map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('')}
                                <option value="__new__">＋ New project…</option>
                            </select>
                        </div>
                    </div>

                    <div class="wsp-subsection">
                        <div class="wsp-subsection-title">⛓️ Depends on <span class="wsp-hint">— videos that must be finished before this one (e.g. part 1 makes the prop)</span></div>
                        <div class="wsp-chips">${chipListHtml(deps.map(d => ({ id: d.id, label: d.name + (d.status === 'posted' ? ' ✅' : ' ⏳') })), 'data-undep')}</div>
                        <div class="wsp-add-row">
                            <select id="wsp-add-dep">
                                <option value="">Add dependency…</option>
                                ${otherVideos.map(o => `<option value="${o.id}">${escHtml(o.name)}${o.status === 'posted' ? ' (posted)' : ''}</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="wsp-subsection">
                        <div class="wsp-subsection-title">🗃️ Needs from inventory <span class="wsp-hint">— props/footage this video uses; blocks until ready</span></div>
                        <div class="wsp-chips">${chipListHtml(reqInv.map(i => ({ id: i.id, label: `${i.name}${i.status === 'ready' ? ' ✅' : ` (${i.status})`}` })), 'data-unreq')}</div>
                        <div class="wsp-add-row">
                            <select id="wsp-add-req">
                                <option value="">Add required item…</option>
                                ${inventoryAll.filter(i => !(v.requiredInventoryIds || []).includes(i.id)).map(i => `<option value="${i.id}">${escHtml(i.name)} (${i.status})</option>`).join('')}
                            </select>
                        </div>
                    </div>

                    <div class="wsp-subsection">
                        <div class="wsp-subsection-title">🎁 Produces <span class="wsp-hint">— props/footage this video creates; become reusable inventory once posted</span></div>
                        <div class="wsp-chips">${chipListHtml(prodInv.map(i => ({ id: i.id, label: `${i.name} (${i.status})` })), 'data-unprod')}</div>
                        <div class="wsp-add-row">
                            <input type="text" id="wsp-new-produce" placeholder="e.g. 'Doc Ock claw prop'">
                            <select id="wsp-new-produce-type">${INVENTORY_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
                            <button class="wsp-mini-btn done" id="wsp-add-produce">Add</button>
                        </div>
                    </div>

                    <div class="wsp-subsection">
                        <div class="wsp-subsection-title">📦 Orders for this video</div>
                        ${myOrders.map(orderRowHtml).join('')}
                        ${addOrderRowHtml({ videoId: v.id })}
                    </div>

                    <label>Hook</label>
                    <textarea id="workshop-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                    <label>Context</label>
                    <textarea id="workshop-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
                    <label>Script</label>
                    ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', 'Script') : '<textarea id="workshop-script"></textarea>'}
                </div>
            </div>
        `;

        // --- bindings ---
        document.getElementById('workshop-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('workshop-post').addEventListener('click', () => postFromDetail());
        document.getElementById('workshop-to-library').addEventListener('click', () => backToLibrary());
        document.getElementById('workshop-delete').addEventListener('click', async () => {
            if (!confirm(`Delete "${v.name}"? The source idea (if any) stays in the Library.`)) return;
            await VideoService.remove(v.id);
            showList();
        });

        const assigneePicker = document.getElementById('workshop-assignee-picker');
        if (assigneePicker) {
            const summaryEl = assigneePicker.querySelector('summary');
            assigneePicker.querySelectorAll('input[type="checkbox"]').forEach(input => {
                input.addEventListener('change', () => {
                    const selected = readAssignedPeopleFromPicker();
                    summaryEl.textContent = selected.length ? selected.join(', ') : 'Unassigned';
                });
            });
        }

        // Stage checklist
        el.querySelectorAll('.wsp-check').forEach(row => {
            const stageId = row.dataset.stage;
            row.querySelectorAll('.wsp-check-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const cur = PS().stateOf(v, stageId);
                    const want = btn.dataset.act; // 'done' | 'na'
                    const next = cur === want ? '' : want;
                    if (stageId === 'post' && next === 'done') {
                        await saveFields(false);
                        await postFromDetail();
                        return;
                    }
                    await setStageState(v.id, stageId, next);
                    renderDetail();
                });
            });
        });

        // Project links
        document.getElementById('wsp-link-project').addEventListener('change', async (e) => {
            let pid = e.target.value;
            if (!pid) return;
            if (pid === '__new__') {
                const name = prompt('New project name:');
                if (!name || !name.trim()) { renderDetail(); return; }
                const p = await SVC().projects.create({ name: name.trim(), description: '', status: 'active', deadline: '', notes: '' });
                pid = p.id;
            }
            const projectIds = [...new Set([...(v.projectIds || []), pid])];
            await VideoService.update(v.id, { projectIds, status: normalizedStatus(v) });
            renderDetail();
        });
        el.querySelectorAll('[data-unlink-project]').forEach(b => b.addEventListener('click', async () => {
            const projectIds = (v.projectIds || []).filter(id => id !== b.dataset.unlinkProject);
            await VideoService.update(v.id, { projectIds, status: normalizedStatus(v) });
            renderDetail();
        }));

        // Dependencies
        document.getElementById('wsp-add-dep').addEventListener('change', async (e) => {
            if (!e.target.value) return;
            const dependsOn = [...new Set([...(v.dependsOn || []), e.target.value])];
            await VideoService.update(v.id, { dependsOn, status: normalizedStatus(v) });
            renderDetail();
        });
        el.querySelectorAll('[data-undep]').forEach(b => b.addEventListener('click', async () => {
            const dependsOn = (v.dependsOn || []).filter(id => id !== b.dataset.undep);
            await VideoService.update(v.id, { dependsOn, status: normalizedStatus(v) });
            renderDetail();
        }));

        // Required inventory
        document.getElementById('wsp-add-req').addEventListener('change', async (e) => {
            if (!e.target.value) return;
            const requiredInventoryIds = [...new Set([...(v.requiredInventoryIds || []), e.target.value])];
            await VideoService.update(v.id, { requiredInventoryIds, status: normalizedStatus(v) });
            renderDetail();
        });
        el.querySelectorAll('[data-unreq]').forEach(b => b.addEventListener('click', async () => {
            const requiredInventoryIds = (v.requiredInventoryIds || []).filter(id => id !== b.dataset.unreq);
            await VideoService.update(v.id, { requiredInventoryIds, status: normalizedStatus(v) });
            renderDetail();
        }));

        // Produces inventory
        document.getElementById('wsp-add-produce').addEventListener('click', async () => {
            const nameEl = document.getElementById('wsp-new-produce');
            const name = nameEl.value.trim();
            if (!name) return;
            const item = await SVC().inventory.create({
                name,
                type: document.getElementById('wsp-new-produce-type').value,
                status: 'building',
                source: 'built',
                projectId: (v.projectIds || [])[0] || '',
                producedByVideoId: v.id,
                location: '', notes: ''
            });
            const producesInventoryIds = [...new Set([...(v.producesInventoryIds || []), item.id])];
            await VideoService.update(v.id, { producesInventoryIds, status: normalizedStatus(v) });
            renderDetail();
        });
        el.querySelectorAll('[data-unprod]').forEach(b => b.addEventListener('click', async () => {
            const producesInventoryIds = (v.producesInventoryIds || []).filter(id => id !== b.dataset.unprod);
            await VideoService.update(v.id, { producesInventoryIds, status: normalizedStatus(v) });
            renderDetail();
        }));

        bindOrderRows(el);

        // Inline script editor
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

        // 3D egg preview + avatars
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
        if (assignedPeople.length && window.EggRenderer) {
            requestAnimationFrame(() => {
                assignedPeople.forEach((name, idx) => {
                    const avatarCanvas = document.getElementById(`workshop-detail-avatar-${idx}`);
                    if (avatarCanvas) window.EggRenderer.renderCharacterAvatar(name, avatarCanvas, 32);
                });
            });
        }
    }

    function readAssignedPeopleFromPicker() {
        return [...(container ? container.querySelectorAll('#workshop-assignee-picker input[type="checkbox"]:checked') : [])]
            .map(input => String(input.value || '').trim())
            .filter(Boolean);
    }

    async function saveFields(silent) {
        if (!selectedVideo) return;
        const name = document.getElementById('workshop-name')?.value.trim() || selectedVideo.name;
        const project = document.getElementById('workshop-project')?.value || '';
        const assignedToList = readAssignedPeopleFromPicker();
        const assignedTo = assignedToList[0] || '';
        const hook = document.getElementById('workshop-hook')?.value || '';
        const context = document.getElementById('workshop-context')?.value || '';
        const videoType = document.getElementById('workshop-type')?.value.trim() || '';
        const deadline = document.getElementById('workshop-deadline')?.value || '';
        const sponsorId = document.getElementById('workshop-sponsor')?.value || '';
        try {
            await VideoService.saveWithIdeaSync(selectedVideo.id, {
                name, project, assignedTo, assignedToList, hook, context,
                videoType, deadline, sponsorId,
                status: normalizedStatus(selectedVideo)
            });
        } catch (e) {
            console.warn('Workshop: save failed', e);
            if (!silent) alert('Failed to save. Check connection.');
        }
    }

    async function saveAndBack() {
        await saveFields(true);
        showList();
    }

    async function postFromDetail() {
        const v = selectedVideo;
        if (!v) return;
        if (!v.script && !document.getElementById('workshop-inline-script-textarea')?.value) {
            if (!confirm('No script on this video. Post anyway?')) return;
        }
        const btn = document.getElementById('workshop-post');
        if (btn) { btn.textContent = 'Posting...'; btn.disabled = true; }
        try {
            await saveFields(true);
            const stageState = { ...(VideoService.getById(v.id)?.stageState || {}), post: 'done' };
            await postVideoRecord(VideoService.getById(v.id) || v, stageState);
            setTimeout(() => showList(), 100);
        } catch (e) {
            console.warn('Workshop: post failed', e);
            alert('Failed to post video. Check connection.');
            if (btn) { btn.textContent = 'Post Video'; btn.disabled = false; }
        }
    }

    async function backToLibrary() {
        if (!selectedVideo) return;
        if (!confirm('Move this back to the Library as an idea? The pipeline entry will be removed (the idea and script are kept).')) return;
        const btn = document.getElementById('workshop-to-library');
        if (btn) { btn.textContent = 'Moving...'; btn.disabled = true; }
        try {
            const v = selectedVideo;
            if (v.sourceIdeaId) {
                const idea = NotesService.getById(v.sourceIdeaId);
                if (idea) {
                    await NotesService.update(idea.id, { type: 'idea', script: v.script || idea.script || '' });
                }
            } else {
                await NotesService.create({
                    name: v.name || 'Untitled',
                    type: 'idea',
                    hook: v.hook || '',
                    context: v.context || '',
                    script: v.script || '',
                    project: v.project || ''
                });
            }
            await VideoService.remove(v.id);
            if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
            toast('Moved back to Library');
            showList();
        } catch (e) {
            console.warn('Workshop: back to library failed', e);
            alert('Failed to move back to Library. Check connection.');
            if (btn) { btn.textContent = 'Return to Library'; btn.disabled = false; }
        }
    }

    // ============ PUBLIC API ============

    return {
        async open(bodyEl, opts) {
            container = bodyEl;
            activeTab = (opts && opts.tab) || 'pipeline';
            render();
            container.querySelectorAll('.wsp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
            const [p] = await Promise.all([
                VideoService.getProjects(),
                VideoService.sync(),
                NotesService.sync().catch(() => {}),
                SVC().syncAll().catch(() => {})
            ]);
            dropboxProjects = p;
            renderTab();
            if (opts && opts.videoId) openDetail(opts.videoId);
        },
        close() {
            if (currentPage === 'detail' && selectedVideo) {
                saveFields(true).catch(() => {});
            }
            const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
            if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();
            container = null;
            selectedVideo = null;
            selectedStageId = null;
            selectedProjectId = null;
            currentPage = 'list';
            activeTab = 'pipeline';
            fSearch = fStage = fType = fProject = fSponsor = fAssignee = fFlag = '';
        }
    };
})();

BuildingRegistry.register('Workshop', {
    open: (bodyEl, opts) => WorkshopUI.open(bodyEl, opts),
    close: () => WorkshopUI.close()
});
