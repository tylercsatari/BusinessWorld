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
    let expandedStageVideoId = null;
    let selectedProjectId = null;
    let currentPage = 'list';

    // Pipeline board filters (apply to everything: dots, counts, stage panel)
    let fSearch = '', fType = '', fProject = '', fSponsor = '', fAssignee = '', fFlag = '';
    // Which entity types are visible on the board (legend toggles)
    // The Workshop board tracks two entities: videos and the components they
    // spawn. Orders/Storage live in their own tabs, not on the pipeline board.
    let showTypes = { video: true, component: true, order: false, inventory: false };
    // Inventory tab filters
    let invType = '', invStatus = '';

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;
    const PS = () => PipelineStages;
    const SVC = () => PipelineService;

    const COMPONENT_STATUSES = ['design', 'cad', 'software', 'manufacturing', 'assembly', 'done'];
    const ORDER_STATUSES = ['needed', 'ordered', 'received'];
    const INVENTORY_STATUSES = ['planned', 'building', 'ready'];
    const INVENTORY_TYPES = ['prop', 'footage', 'set', 'material', 'other'];
    const INV_TYPE_ICONS = { prop: '🪛', footage: '🎞️', set: '🏠', material: '🧱', other: '📦' };

    // ============ CLEAN LINE ICONS (Feather-style, replace emoji) ============
    // One stroke icon per pipeline stage + per entity type. Rendered as inline
    // SVG so they inherit color (white inside the colored node badge, the text
    // color inside chips/checklist) and scale with font-size.
    const ICON_PATHS = {
        // stages
        ideate:     '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>',
        hook:       '<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>',
        script:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
        animation:  '<rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
        decomp:     '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
        design:     '<path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7 14h10"/>',
        propdesign: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
        cad:        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
        pcb:        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
        order:      '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
        precision:  '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
        software:   '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        assembly:   '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
        artistic:   '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
        hookfilm:   '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        film:       '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
        voiceover:  '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        edit:       '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
        splittest:  '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
        post:       '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
        // entity types + storage
        inventory:  '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
        video:      '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
        component:  '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
        // generic (detail sections)
        clock:      '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        lock:       '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        link:       '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        briefcase:  '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
        flag:       '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
        _default:   '<circle cx="12" cy="12" r="9"/>'
    };
    function icon(name, cls) {
        const p = ICON_PATHS[name] || ICON_PATHS._default;
        return `<svg class="wsp-ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
    }

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
        return PS().blockers(video, {
            videos: VideoService.getAll(),
            components: SVC().components.getAll(),
            orders: SVC().orders.getAll()
        });
    }

    // Components broken out of this video at Decomposition — they flow
    // through the pipeline on their own (blue dots on the board)
    function componentsForVideo(videoId) {
        return SVC().components.getAll().filter(c => c.videoId === videoId);
    }

    // Context for deterministic auto-checks (e.g. Ordering completes when all
    // of a video's orders are received)
    function ctxNow() {
        return { orders: SVC().orders.getAll() };
    }

    function blockedBadge(video) {
        const b = videoBlockers(video);
        if (!b.length) return '';
        const titles = b.map(x => `${x.label} — ${x.detail}`).join('\n');
        return `<span class="wsp-blocked-badge" title="${escAttr(titles)}">🔒 ${b.length}</span>`;
    }

    function frontierChips(video, max) {
        const f = PS().frontier(video, ctxNow());
        const shown = max ? f.slice(0, max) : f;
        let html = shown.map(id => {
            const st = PS().get(id);
            return `<span class="wsp-stage-chip${st.bottleneck ? ' bottleneck' : ''}">${icon(id, 'wsp-chip-ic')} ${escHtml(st.label)}</span>`;
        }).join('');
        if (max && f.length > max) html += `<span class="wsp-stage-chip more">+${f.length - max}</span>`;
        if (!f.length) html = `<span class="wsp-stage-chip done-chip">✓ Complete</span>`;
        return html;
    }

    function progressBar(video) {
        const p = PS().progress(video, ctxNow());
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
                        <button class="wsp-tab active" data-tab="pipeline">Pipeline <span class="wsp-tab-count" data-tabcount="pipeline"></span></button>
                        <button class="wsp-tab" data-tab="projects">Projects <span class="wsp-tab-count" data-tabcount="projects"></span></button>
                        <button class="wsp-tab" data-tab="orders">Orders <span class="wsp-tab-count" data-tabcount="orders"></span></button>
                        <button class="wsp-tab" data-tab="inventory">Storage Room <span class="wsp-tab-count" data-tabcount="inventory"></span></button>
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
        else if (activeTab === 'projects') renderProjectsTab(el);
        else if (activeTab === 'orders') renderOrdersTab(el);
        else if (activeTab === 'inventory') renderInventoryTab(el);
    }

    function updateCount() {
        const el = document.getElementById('wsp-count');
        if (el) el.textContent = `${pipelineVideos().length} in pipeline`;
        // Live counts on every tab so the numbers are visible without clicking in
        const counts = {
            pipeline: pipelineVideos().length,
            projects: SVC().projects.getAll().filter(p => p.status !== 'archived').length,
            orders: SVC().orders.getAll().filter(o => o.status !== 'received').length,
            inventory: SVC().inventory.getAll().length
        };
        document.querySelectorAll('[data-tabcount]').forEach(el2 => {
            const n = counts[el2.dataset.tabcount];
            el2.textContent = n || '';
            el2.style.display = n ? '' : 'none';
        });
    }

    // ============ TAB 1: PIPELINE BOARD — the single view of everything ============

    const NODE_W = 178, NODE_H = 66, GAP_X = 56, GAP_Y = 22, PAD = 26;

    // One color per entity type — same colors everywhere (dots, legend, panel)
    const DOT_COLORS = { video: '#00b894', component: '#1565c0', order: '#e8a020', inventory: '#8e44ad' };
    const GROUP_COLORS = { Concept: '#4a9eff', Planning: '#e8a020', Procurement: '#e67e22', Build: '#14b8a6', Production: '#e74c3c', Post: '#27ae60' };
    // Where a component's build status lives on the video pipeline
    const COMPONENT_STAGE_MAP = { design: 'design', cad: 'cad', software: 'software', manufacturing: 'precision', assembly: 'assembly' };

    function boardPositions() {
        // Column = topological layer, row = index within layer (centered vertically)
        const layers = PS().LAYERS;
        const maxRows = Math.max(...layers.map(l => l.length), 2);
        const boardH = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y + 96; // +96 for the inventory node row
        const pos = {};
        layers.forEach((ids, li) => {
            const x = PAD + li * (NODE_W + GAP_X);
            const totalH = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
            const y0 = (boardH - 96 - totalH) / 2 + PAD / 2;
            ids.forEach((id, ri) => {
                pos[id] = { x, y: y0 + ri * (NODE_H + GAP_Y) };
            });
        });
        const boardW = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X;
        // Component Library (Inventory) reference node sits under Ordering
        const orderPos = pos['order'];
        pos['_inventory'] = { x: orderPos.x, y: boardH - 80 };
        return { pos, boardW, boardH };
    }

    // --- Filters (apply to the whole board: dots, counts, stage panel) ---

    function filteredVideos() {
        let list = pipelineVideos();
        if (fSearch) {
            const q = fSearch.toLowerCase();
            list = list.filter(v => (v.name || '').toLowerCase().includes(q) || (v.hook || '').toLowerCase().includes(q));
        }
        if (fType) list = list.filter(v => v.videoType === fType);
        if (fProject) list = list.filter(v => (v.projectIds || []).includes(fProject));
        if (fSponsor) list = list.filter(v => v.sponsorId === fSponsor);
        if (fAssignee === 'none') list = list.filter(v => getAssignedPeople(v).length === 0);
        else if (fAssignee) list = list.filter(v => getAssignedPeople(v).includes(fAssignee));
        if (fFlag === 'blocked') list = list.filter(v => videoBlockers(v).length > 0);
        if (fFlag === 'deadline') list = list.filter(v => { const d = deadlineInfo(v); return d && d.days <= 7; });
        // Soonest deadline first
        return [...list].sort((a, b) => {
            const da = a.deadline || '9999', db = b.deadline || '9999';
            if (da !== db) return da < db ? -1 : 1;
            return (a.name || '').localeCompare(b.name || '');
        });
    }

    function filteredComponents() {
        let list = SVC().components.getAll().filter(c => c.status !== 'done');
        if (fProject) list = list.filter(c => c.projectId === fProject);
        if (fSearch) { const q = fSearch.toLowerCase(); list = list.filter(c => (c.name || '').toLowerCase().includes(q)); }
        return list;
    }

    function filteredOrders() {
        let list = SVC().orders.getAll().filter(o => o.status !== 'received');
        if (fProject) {
            const projVideoIds = new Set(pipelineVideos().filter(v => (v.projectIds || []).includes(fProject)).map(v => v.id));
            list = list.filter(o => o.projectId === fProject || (o.videoId && projVideoIds.has(o.videoId)));
        }
        if (fSearch) { const q = fSearch.toLowerCase(); list = list.filter(o => (o.name || '').toLowerCase().includes(q)); }
        return list;
    }

    function filteredInventory() {
        let list = SVC().inventory.getAll();
        if (fProject) list = list.filter(i => i.projectId === fProject);
        if (fSearch) { const q = fSearch.toLowerCase(); list = list.filter(i => (i.name || '').toLowerCase().includes(q)); }
        return list;
    }

    // Everything on the board, per stage, post-filter
    function boardEntities() {
        const ctx = ctxNow();
        const byStage = {};
        PS().STAGES.forEach(s => { byStage[s.id] = { videos: [], components: [], orders: [] }; });
        if (showTypes.video) {
            filteredVideos().forEach(v => PS().frontier(v, ctx).forEach(id => byStage[id].videos.push(v)));
        }
        if (showTypes.component) {
            filteredComponents().forEach(c => {
                const sid = COMPONENT_STAGE_MAP[c.status];
                if (sid) byStage[sid].components.push(c);
            });
        }
        if (showTypes.order) {
            filteredOrders().forEach(o => byStage['order'].orders.push(o));
        }
        return byStage;
    }

    function edgePath(a, b) {
        const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
        const x2 = b.x - 5, y2 = b.y + NODE_H / 2; // stop short so the arrowhead lands on the node edge
        const mx = (x1 + x2) / 2;
        return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }

    // Edges that span multiple columns route AROUND the nodes in between
    // (through a clear channel above/below them) instead of passing under them.
    function edgePathSmart(fromId, toId, pos) {
        const a = pos[fromId], b = pos[toId];
        const lf = PS().layerOf(fromId), lt = PS().layerOf(toId);
        if (lt - lf <= 1) return edgePath(a, b);

        let minTop = Infinity, maxBottom = -Infinity;
        for (let li = lf + 1; li < lt; li++) {
            PS().LAYERS[li].forEach(id => {
                minTop = Math.min(minTop, pos[id].y);
                maxBottom = Math.max(maxBottom, pos[id].y + NODE_H);
            });
        }
        const aboveY = Math.max(minTop - 16, 10);
        const belowY = maxBottom + 16;
        const midY = (a.y + b.y) / 2 + NODE_H / 2;
        const cy = Math.abs(midY - aboveY) <= Math.abs(midY - belowY) ? aboveY : belowY;

        const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
        const x2 = b.x - 5, y2 = b.y + NODE_H / 2;
        const xc1 = x1 + GAP_X * 0.8;        // where the channel starts
        const xc2 = x2 - GAP_X * 0.8;        // where it ends
        return `M ${x1} ${y1} C ${x1 + GAP_X * 0.5} ${y1}, ${xc1 - GAP_X * 0.4} ${cy}, ${xc1} ${cy} ` +
               `L ${xc2} ${cy} ` +
               `C ${xc2 + GAP_X * 0.4} ${cy}, ${x2 - GAP_X * 0.5} ${y2}, ${x2} ${y2}`;
    }

    function pipelineFilterBarHtml() {
        const all = pipelineVideos();
        const projects = SVC().projects.getAll().filter(p => p.status !== 'archived');
        const sponsors = [...new Set(all.map(v => v.sponsorId).filter(Boolean))].map(id => SVC().sponsors.getById(id)).filter(Boolean);
        const legendCounts = {
            video: filteredVideos().length,
            component: filteredComponents().length,
            order: filteredOrders().length,
            inventory: filteredInventory().length
        };
        const legend = [
            ['video', 'video', 'Videos'], ['component', 'component', 'Components']
        ];
        return `<div class="wsp-filterbar wsp-pipeline-filters">
            <div class="wsp-legend">
                ${legend.map(([key, iconName, label]) => `
                    <button class="wsp-legend-chip${showTypes[key] ? ' on' : ''}" data-toggle-type="${key}" style="--dotcolor:${DOT_COLORS[key]}" title="${showTypes[key] ? 'Hide' : 'Show'} ${escAttr(label)} on the board">
                        <span class="wsp-legend-num">${legendCounts[key]}</span>${icon(iconName, 'wsp-legend-ic')} ${label}
                    </button>`).join('')}
            </div>
            <input type="text" class="wsp-search" id="wsp-f-search" placeholder="Search everything…" value="${escAttr(fSearch)}">
            ${projects.length ? `<select id="wsp-f-project"><option value="">All projects</option>${projects.map(p => `<option value="${p.id}" ${fProject === p.id ? 'selected' : ''}>🛠️ ${escHtml(p.name)}</option>`).join('')}</select>` : ''}
            ${sponsors.length ? `<select id="wsp-f-sponsor"><option value="">All sponsors</option>${sponsors.map(s => `<option value="${s.id}" ${fSponsor === s.id ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('')}</select>` : ''}
            <div class="wsp-flag-btns">
                <button class="workshop-filter-btn ${fFlag === 'blocked' ? 'active' : ''}" data-flag="blocked">🔒 Blocked</button>
                <button class="workshop-filter-btn ${fFlag === 'deadline' ? 'active' : ''}" data-flag="deadline">⏰ Due soon</button>
            </div>
        </div>`;
    }

    function bindPipelineFilters(el) {
        el.querySelectorAll('[data-toggle-type]').forEach(b => b.addEventListener('click', () => {
            showTypes[b.dataset.toggleType] = !showTypes[b.dataset.toggleType];
            renderTab();
        }));
        const search = document.getElementById('wsp-f-search');
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    fSearch = search.value;
                    renderTab();
                    const s2 = document.getElementById('wsp-f-search');
                    if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
                }, 250);
            });
        }
        const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('change', () => { fn(e.value); renderTab(); }); };
        bind('wsp-f-project', v => fProject = v);
        bind('wsp-f-sponsor', v => fSponsor = v);
        el.querySelectorAll('[data-flag]').forEach(b => b.addEventListener('click', () => {
            fFlag = fFlag === b.dataset.flag ? '' : b.dataset.flag;
            renderTab();
        }));
    }

    function renderPipelineTab(el) {
        const { pos, boardW, boardH } = boardPositions();
        const entities = boardEntities();

        const edgesSvg =
        `<defs>
            <marker id="wspArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#b3a98f"/>
            </marker>
        </defs>` +
        PS().EDGES.map(([f, t]) => {
            return `<path d="${edgePathSmart(f, t, pos)}" class="wsp-edge" marker-end="url(#wspArrow)" />`;
        }).join('') +
        // dashed reference edge to the Storage Room node (only when shown)
        (showTypes.inventory ? `<path d="M ${pos['order'].x + NODE_W / 2} ${pos['order'].y + NODE_H} L ${pos['_inventory'].x + NODE_W / 2} ${pos['_inventory'].y}" class="wsp-edge ref" />` : '');

        const nodesHtml = PS().STAGES.map(s => {
            const p = pos[s.id];
            const e = entities[s.id];
            const total = e.videos.length + e.components.length + e.orders.length;
            const blockedHere = e.videos.filter(v => videoBlockers(v).length > 0).length;
            // Compact numeric breakdown by type (only nonzero) — colored dot + number, no emoji
            const counts = [
                e.videos.length ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.video}"></i>${e.videos.length}</span>` : '',
                e.components.length ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.component}"></i>${e.components.length}</span>` : '',
                e.orders.length ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.order}"></i>${e.orders.length}</span>` : ''
            ].join('');
            const gc = GROUP_COLORS[s.group] || '#9a8f78';
            return `<div class="wsp-node${s.bottleneck ? ' bottleneck' : ''}${selectedStageId === s.id ? ' selected' : ''}${total ? ' has-videos' : ''}"
                        data-stage="${s.id}" style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px;--groupcolor:${gc};">
                <div class="wsp-node-badge" style="background-color:${gc};box-shadow:0 3px 9px ${gc}55, inset 0 1px 2px rgba(255,255,255,0.35);">${icon(s.id)}</div>
                <div class="wsp-node-text">
                    <div class="wsp-node-label">${escHtml(s.label)}</div>
                    <div class="wsp-node-sub">${total
                        ? `<span class="wsp-node-counts">${counts}</span>`
                        : `<span class="wsp-node-group">${s.bottleneck ? 'bottleneck' : escHtml(s.group)}</span>`}</div>
                </div>
                ${total ? `<span class="wsp-node-count">${total}</span>` : ''}
                ${blockedHere ? `<span class="wsp-node-blocked" title="${blockedHere} blocked here">🔒</span>` : ''}
            </div>`;
        }).join('');

        // Component Library (Storage Room) node — only on the board when toggled on
        let invNode = '';
        if (showTypes.inventory) {
            const invItems = filteredInventory();
            const readyInv = invItems.filter(i => i.status === 'ready').length;
            const invCol = DOT_COLORS.inventory;
            invNode = `<div class="wsp-node inv-node" data-goto="inventory" style="left:${pos['_inventory'].x}px;top:${pos['_inventory'].y}px;width:${NODE_W}px;height:62px;">
                <div class="wsp-node-badge" style="background-color:${invCol};box-shadow:0 3px 9px ${invCol}55, inset 0 1px 2px rgba(255,255,255,0.35);">${icon('inventory')}</div>
                <div class="wsp-node-text">
                    <div class="wsp-node-label">Storage Room</div>
                    <div class="wsp-node-sub"><span class="wsp-node-group">${readyInv}/${invItems.length} ready on the shelf</span></div>
                </div>
                ${invItems.length ? `<span class="wsp-node-count inv">${invItems.length}</span>` : ''}
            </div>`;
        }

        el.innerHTML = `
            ${pipelineFilterBarHtml()}
            <div class="wsp-board-wrap">
                <div class="wsp-board" style="width:${boardW}px;height:${boardH}px;">
                    <svg class="wsp-edges" width="${boardW}" height="${boardH}">${edgesSvg}</svg>
                    ${nodesHtml}
                    ${invNode}
                </div>
            </div>
            <div class="wsp-stage-panel" id="wsp-stage-panel"></div>
        `;

        bindPipelineFilters(el);
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

    // Video row — works inside a stage panel (stage given: Done/Decide actions)
    // or in the all-items list (stage null: frontier chips instead of actions)
    function stageVideoRowHtml(v, stage) {
        const dl = deadlineInfo(v);
        const expanded = expandedStageVideoId === v.id;
        const openOrders = SVC().ordersForVideo(v.id).filter(o => o.status !== 'received').length;
        const sp = sponsorName(v.sponsorId);
        // Decomposition can't be completed without the branch decisions —
        // that's the validation gate that keeps irrelevant videos away from
        // CAD/design/build people.
        const needsDecisions = stage && stage.id === 'decomp' && !PS().branchesDecided(v);
        const actions = !stage ? ''
            : needsDecisions
                ? `<button class="wsp-mini-btn done" data-decide="${v.id}" title="Decide which branches this video needs before completing Decomposition">🧩 Decide</button>`
                : `<button class="wsp-mini-btn done" data-done="${v.id}" title="Mark ${escAttr(stage.label)} done for this video">✓ Done</button>`;
        return `<div class="wsp-stage-video${expanded ? ' expanded' : ''}" data-id="${v.id}">
            <div class="wsp-stage-video-head" data-expand="${v.id}">
                <span class="wsp-caret">${expanded ? '▾' : '▸'}</span>
                <div class="wsp-stage-video-main">
                    <div class="wsp-stage-video-name">${flagOrDot(v.project)} ${escHtml(v.name)} ${blockedBadge(v)}</div>
                    <div class="wsp-stage-video-meta">
                        ${!stage ? frontierChips(v, 3) : ''}
                        ${dl ? `<span class="wsp-deadline ${dl.cls}">⏰ ${dl.label}</span>` : ''}
                        ${stage && stage.id === 'order' && openOrders ? `<span class="wsp-deadline soon">📦 ${openOrders} order${openOrders === 1 ? '' : 's'} open</span>` : ''}
                        ${sp ? `<span class="wsp-sponsor-chip">💰 ${escHtml(sp)}</span>` : ''}
                    </div>
                </div>
                <div class="wsp-stage-video-actions">${actions}</div>
            </div>
            ${expanded ? stageVideoBodyHtml(v) : ''}
        </div>`;
    }

    // The drop-down IS the full editor — same fields as the detail page,
    // in pipeline order, plus the action buttons.
    function stageVideoBodyHtml(v) {
        return `<div class="wsp-stage-video-body">
            <div class="workshop-detail-fields wsp-inline-editor">${detailFieldsHtml(v)}</div>
            <div class="wsp-svb-actions">
                <button class="workshop-action-btn post-btn" data-inline-post="${v.id}">Post Video</button>
                <button class="workshop-action-btn" data-inline-library="${v.id}">Return to Library</button>
                <button class="workshop-action-btn danger-btn" data-inline-delete="${v.id}">Delete</button>
            </div>
        </div>`;
    }

    // Shared row bindings for the stage panel and the all-items list
    function bindPanelRows(panel) {
        panel.querySelectorAll('[data-expand]').forEach(head => head.addEventListener('click', (ev) => {
            if (ev.target.closest('button, select, input, textarea, a, audio, label')) return; // form controls act, don't toggle
            const id = head.dataset.expand;
            // save whatever was being edited in the previously open drop-down
            if (expandedStageVideoId) saveFieldsFor(VideoService.getById(expandedStageVideoId), true).catch(() => {});
            expandedStageVideoId = expandedStageVideoId === id ? null : id;
            renderStagePanel();
        }));
        panel.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openDetail(b.dataset.open)));
        panel.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', () => openBranchDialog(b.dataset.decide, true)));
        bindCompStatusRows(panel, () => renderTab());
        bindOrderRows(panel);

        // An expanded row holds the full editor — wire it up
        if (expandedStageVideoId) {
            const ev = VideoService.getById(expandedStageVideoId);
            if (ev && panel.querySelector(`.wsp-stage-video[data-id="${expandedStageVideoId}"] #workshop-name`)) {
                bindDetailFields(ev);
                initMediaSection(ev, 'vo');
                panel.querySelectorAll('[data-inline-post]').forEach(b => b.addEventListener('click', () => postVideoAction(VideoService.getById(expandedStageVideoId))));
                panel.querySelectorAll('[data-inline-library]').forEach(b => b.addEventListener('click', () => backToLibraryAction(VideoService.getById(expandedStageVideoId))));
                panel.querySelectorAll('[data-inline-delete]').forEach(b => b.addEventListener('click', () => deleteVideoAction(VideoService.getById(expandedStageVideoId))));
            }
        }
    }

    // No stage selected → show EVERYTHING currently in flight (filter-driven)
    function renderAllPanel(panel) {
        const vids = showTypes.video ? filteredVideos() : [];
        const comps = showTypes.component ? filteredComponents() : [];
        const orders = showTypes.order ? filteredOrders() : [];
        const inv = showTypes.inventory ? filteredInventory() : [];
        const total = vids.length + comps.length + orders.length + inv.length;

        const breakdown = [
            showTypes.video ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">${icon('video', 'wsp-cc-ic')} ${vids.length}</span>` : '',
            showTypes.component ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">${icon('component', 'wsp-cc-ic')} ${comps.length}</span>` : '',
            showTypes.order ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.order}">${icon('order', 'wsp-cc-ic')} ${orders.length}</span>` : '',
            showTypes.inventory ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.inventory}">${icon('inventory', 'wsp-cc-ic')} ${inv.length}</span>` : ''
        ].join('');

        const INV_STATUS_COLORS = { ready: '#27ae60', building: '#e8a020', planned: '#b0a8a0' };

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div class="wsp-stage-panel-headmain">
                    <div class="wsp-stage-panel-title">Everything in flight ${breakdown}</div>
                    <div class="wsp-stage-panel-desc">All work matching the filters above. Click a stage node on the board to focus on one stage.</div>
                </div>
            </div>
            <div class="wsp-stage-panel-list">
                ${total === 0 ? '<div class="workshop-empty">Nothing matches the current filters. Queue an idea from the Library to feed the pipeline!</div>' : ''}
                ${vids.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.video}">${icon('video', 'wsp-sec-ic')} Videos in the pipeline</div>${vids.map(v => stageVideoRowHtml(v, null)).join('')}` : ''}
                ${comps.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.component}">${icon('component', 'wsp-sec-ic')} Components being built</div>${comps.map(c => componentRowHtml(c)).join('')}` : ''}
                ${orders.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.order}">${icon('order', 'wsp-sec-ic')} Open orders</div>${orders.map(orderRowHtml).join('')}` : ''}
                ${inv.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.inventory}">${icon('inventory', 'wsp-sec-ic')} Storage room (Component Library)</div>${inv.map(i => `
                    <div class="wsp-row" style="border-left: 3px solid ${INV_STATUS_COLORS[i.status] || '#b0a8a0'}">
                        <span class="wsp-row-name">${INV_TYPE_ICONS[i.type] || '📦'} ${escHtml(i.name)} ${projectName(i.projectId) ? `<span class="wsp-hint">🛠️ ${escHtml(projectName(i.projectId))}</span>` : ''}</span>
                        <span class="wsp-pill ${i.status === 'ready' ? 'active' : ''}">${i.status}</span>
                    </div>`).join('')}` : ''}
            </div>
        `;
        bindPanelRows(panel);
    }

    function renderStagePanel() {
        const panel = document.getElementById('wsp-stage-panel');
        if (!panel) return;
        if (!selectedStageId) {
            renderAllPanel(panel);
            return;
        }
        const stage = PS().get(selectedStageId);
        const e = boardEntities()[selectedStageId] || { videos: [], components: [], orders: [] };
        const autoDesc = PS().autoDesc(selectedStageId);
        const owner = SVC().stageOwners()[selectedStageId] || '';
        const names = rosterNames(owner ? [owner] : []);

        const breakdown = [
            e.videos.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">${icon('video', 'wsp-cc-ic')} ${e.videos.length}</span>` : '',
            e.components.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">${icon('component', 'wsp-cc-ic')} ${e.components.length}</span>` : '',
            e.orders.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.order}">${icon('order', 'wsp-cc-ic')} ${e.orders.length}</span>` : ''
        ].join('');

        const compRows = e.components.map(c => componentRowHtml(c)).join('');

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div class="wsp-stage-panel-headmain">
                    <div class="wsp-stage-panel-title">${icon(stage.id, 'wsp-title-ic')} ${escHtml(stage.label)} ${breakdown}</div>
                    <div class="wsp-stage-panel-desc">${escHtml(stage.desc || '')}</div>
                    ${autoDesc ? `<div class="wsp-auto-desc">⚡ ${escHtml(autoDesc)}</div>` : ''}
                </div>
                <div class="wsp-stage-panel-side">
                    <label class="wsp-owner-label" title="Who owns this stage — everything here is automatically their queue">Owner
                        <select id="wsp-stage-owner">
                            <option value="">— nobody —</option>
                            ${names.map(n => `<option value="${escAttr(n)}" ${owner === n ? 'selected' : ''}>${escHtml(n)}</option>`).join('')}
                        </select>
                    </label>
                    <button class="wsp-picker-close" id="wsp-stage-panel-close">✕</button>
                </div>
            </div>
            <div class="wsp-stage-panel-list">
                ${e.videos.length === 0 && !compRows && e.orders.length === 0 ? '<div class="workshop-empty">Nothing at this stage (with current filters).</div>' : ''}
                ${e.videos.map(v => stageVideoRowHtml(v, stage)).join('')}
                ${compRows ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.component}">${icon('component', 'wsp-sec-ic')} Components being worked here</div>${compRows}` : ''}
                ${e.orders.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.order}">${icon('order', 'wsp-sec-ic')} Open orders</div>${e.orders.map(orderRowHtml).join('')}` : ''}
            </div>
        `;

        document.getElementById('wsp-stage-panel-close').addEventListener('click', () => {
            selectedStageId = null;
            expandedStageVideoId = null;
            renderTab();
        });
        document.getElementById('wsp-stage-owner').addEventListener('change', (ev) => {
            SVC().setStageOwner(selectedStageId, ev.target.value).catch(err => console.warn('stage owner save failed', err));
        });
        panel.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            await setStageState(b.dataset.done, selectedStageId, 'done');
            renderTab();
        }));
        bindPanelRows(panel);
    }

    // The Decomposition validation gate: explicit yes/no per branch.
    // Branches switched OFF are auto-skipped ('na') everywhere downstream.
    function openBranchDialog(videoId, markDecompDone) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        const b = v.branches || {};
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        const compListHtml = () => componentsForVideo(videoId).map(c =>
            `<div class="wsp-row" style="border-left: 3px solid ${DOT_COLORS.component}">
                <span class="wsp-row-name">🧩 ${escHtml(c.name)}</span>
                <span class="wsp-pill active">${c.status}</span>
            </div>`).join('');
        // The two hook branches are NOT decided here — they derive from the
        // hook instances in the Hook section (any animation instance →
        // Animation on, any practical → Practical Hook Filming on). Shown
        // read-only so the modal can't contradict the instance list.
        const hookCounts = { animation: 0, practical: 0 };
        PS().hooksOf(v).forEach(h => { if (hookCounts[h.type] !== undefined) hookCounts[h.type]++; });
        const DERIVED_FLAGS = { hookfilm: 'practical', animation: 'animation' };
        const branchRowHtml = (q) => {
            const hookType = DERIVED_FLAGS[q.flag];
            if (!hookType) return `
                        <label class="wsp-branch-row">
                            <input type="checkbox" data-flag="${q.flag}" ${b[q.flag] === true ? 'checked' : ''}>
                            <span class="wsp-branch-label">${q.label}</span>
                            <span class="wsp-hint">${escHtml(q.hint)}</span>
                        </label>`;
            const n = hookCounts[hookType];
            return `
                        <label class="wsp-branch-row" style="opacity:.75;cursor:default;">
                            <input type="checkbox" disabled ${n > 0 ? 'checked' : ''}>
                            <span class="wsp-branch-label">${q.label}</span>
                            <span class="wsp-hint">auto — ${n ? `${n} ${hookType} hook instance${n === 1 ? '' : 's'} declared` : `no ${hookType} hook instances`}; add/remove them in the 🪝 Hook section</span>
                        </label>`;
        };
        overlay.innerHTML = `
            <div class="wsp-picker wsp-branch-modal">
                <div class="wsp-picker-header"><span>🧩 Decomposition — break "${escHtml(v.name)}" down</span><button class="wsp-picker-close" data-close>✕</button></div>
                <div class="wsp-branch-list">
                    <div class="wsp-hint">Only branches switched ON will ever see this video — everything else is skipped automatically. That's the validation: nobody gets handed work that doesn't apply.</div>
                    ${PS().BRANCH_QUESTIONS.map(branchRowHtml).join('')}
                    <div class="wsp-subsection-title" style="margin-top:6px;">🧩 Components <span class="wsp-hint">— things to build/make for this video; each flows through the pipeline on its own and the video waits for it</span></div>
                    <div id="wsp-bd-comps">${compListHtml()}</div>
                    <div class="wsp-add-row">
                        <input type="text" id="wsp-bd-comp-name" placeholder="e.g. 'Doc Ock arm'">
                        <button class="wsp-mini-btn done" id="wsp-bd-comp-add">Add</button>
                    </div>
                </div>
                <div class="wsp-branch-actions">
                    <button class="wsp-mini-btn" id="wsp-branch-save">Save decisions</button>
                    ${markDecompDone ? `<button class="wsp-mini-btn done" id="wsp-branch-save-done">Save & complete Decomposition ✓</button>` : ''}
                </div>
            </div>`;
        const panel = container.querySelector('.workshop-panel');
        panel.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('[data-close]').addEventListener('click', close);

        // Quick component breakdown right inside the gate
        const addDialogComp = async () => {
            const input = overlay.querySelector('#wsp-bd-comp-name');
            const name = input.value.trim();
            if (!name) return;
            const fresh = VideoService.getById(videoId) || v;
            const comp = await SVC().components.create({
                videoId, projectId: (fresh.projectIds || [])[0] || '',
                parentComponentId: '', name, status: 'design', notes: ''
            });
            await saveDeps(fresh, [...videoDeps(fresh), { kind: 'component', id: comp.id }]);
            input.value = '';
            overlay.querySelector('#wsp-bd-comps').innerHTML = compListHtml();
            input.focus();
        };
        overlay.querySelector('#wsp-bd-comp-add').addEventListener('click', addDialogComp);
        overlay.querySelector('#wsp-bd-comp-name').addEventListener('keydown', e => { if (e.key === 'Enter') addDialogComp(); });
        const save = async (alsoDone) => {
            const branches = {};
            overlay.querySelectorAll('input[data-flag]').forEach(i => { branches[i.dataset.flag] = i.checked; });
            const fresh = VideoService.getById(videoId) || v;
            // Hook branches always derive from the instance list, never from this modal
            const hooks = PS().hooksOf(fresh);
            branches.animation = hooks.some(h => h.type === 'animation');
            branches.hookfilm = hooks.some(h => h.type === 'practical');
            const changes = { branches, status: normalizedStatus(fresh) };
            if (alsoDone) changes.stageState = { ...(fresh.stageState || {}), decomp: 'done' };
            await VideoService.update(videoId, changes);
            close();
            if (currentPage === 'detail' && selectedVideo && selectedVideo.id === videoId) renderDetail();
            else renderTab();
        };
        overlay.querySelector('#wsp-branch-save').addEventListener('click', () => save(false));
        const sd = overlay.querySelector('#wsp-branch-save-done');
        if (sd) sd.addEventListener('click', () => save(true));
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

    // ============ TAB 2: PROJECTS ============

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
                <span class="wsp-section-title">Storage Room (Component Library) — what physically exists & what's usable right now. Ordering checks here before buying.</span>
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
        renderIdeaList(listEl);
        overlay.style.display = 'flex';
    }

    // Newest first, like the Library (most-recently-edited at the top)
    function ideaTimeKey(n) { return n.lastEdited || n.createdAt || n.createdTime || ''; }

    function renderIdeaList(listEl) {
        document.getElementById('wsp-picker-title').textContent = 'Queue an idea into the pipeline';
        const ideas = NotesService.getAll().filter(n => n.type === 'idea')
            .sort((a, b) => ideaTimeKey(b).localeCompare(ideaTimeKey(a)));
        if (ideas.length === 0) {
            listEl.innerHTML = '<div class="workshop-empty">No unqueued ideas in the Library. Write ideas there first — good or bad, they all live in the Library.</div>';
            return;
        }
        listEl.innerHTML = ideas.map(n => {
            const preview = n.hook || n.context || '';
            return `<div class="wsp-picker-item" data-id="${n.id}">
                <div class="wsp-picker-name">${escHtml(n.name)}${n.script ? ' <span class="wsp-hint">📜 has script</span>' : ''}</div>
                <div class="wsp-picker-preview">${escHtml(preview.substring(0, 90))}</div>
            </div>`;
        }).join('');
        // Click an idea to SCOPE IT OUT first (preview), not queue immediately
        listEl.querySelectorAll('.wsp-picker-item').forEach(item => {
            item.addEventListener('click', () => showIdeaPreview(item.dataset.id));
        });
    }

    // Preview an idea fully before deciding to bring it into the pipeline
    function showIdeaPreview(noteId) {
        const listEl = document.getElementById('wsp-picker-list');
        const n = NotesService.getById(noteId);
        if (!listEl || !n) return;
        document.getElementById('wsp-picker-title').textContent = 'Scope out this idea';
        const already = !!VideoService.getByIdeaId(noteId);
        const field = (label, val, cls) => val ? `<div class="wsp-idea-field"><div class="wsp-cd-label">${label}</div><div class="wsp-idea-text ${cls || ''}">${escHtml(val)}</div></div>` : '';
        listEl.innerHTML = `
            <div class="wsp-idea-preview">
                <button class="wsp-mini-btn" id="wsp-idea-back">← Back to ideas</button>
                <h3 class="wsp-idea-title">${escHtml(n.name)}</h3>
                ${n.project ? `<div class="wsp-chip">${icon('flag', 'wsp-cc-ic')} ${escHtml(n.project)}</div>` : ''}
                ${field('Hook', n.hook)}
                ${field('Context', n.context)}
                ${n.script ? field('Script', n.script, 'wsp-idea-script') : '<div class="wsp-hint">No script yet — you can write it once it\'s in the pipeline.</div>'}
                <div class="wsp-idea-actions">
                    ${already
                        ? '<span class="wsp-hint">Already in the pipeline.</span>'
                        : '<button class="wsp-mini-btn done" id="wsp-idea-queue">Bring to pipeline →</button>'}
                </div>
            </div>`;
        listEl.querySelector('#wsp-idea-back').addEventListener('click', () => renderIdeaList(listEl));
        const qb = listEl.querySelector('#wsp-idea-queue');
        if (qb) qb.addEventListener('click', () => queueIdea(noteId));
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
        // collapse any inline editor — only one editor may be mounted at a time
        if (expandedStageVideoId) { expandedStageVideoId = null; renderTab(); }
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
        // clear the detail DOM so its field ids can't shadow an inline editor
        const det = document.getElementById('workshop-detail');
        if (det) det.innerHTML = '';
        renderTab();
    }

    function stageChecklistHtml(v) {
        // Stages grouped by topo layer, left → right like the board
        const ctx = ctxNow();
        return `<div class="wsp-checklist">
            ${PS().LAYERS.map(ids => `<div class="wsp-checklist-col">
                ${ids.map(id => {
                    const st = PS().get(id);
                    const state = PS().effectiveState(v, id, ctx);
                    const ready = PS().isReady(v, id, ctx);
                    const cls = (state === 'done' || state === 'auto') ? 'done' : state === 'na' ? 'na' : ready ? 'ready' : 'locked';
                    const mark = state === 'done' ? '✓' : state === 'auto' ? '⚡' : state === 'na' ? '–' : ready ? '●' : '○';
                    const autoTag = state === 'auto' ? '<span class="wsp-auto-tag">auto</span>' : '';
                    return `<div class="wsp-check ${cls}" data-stage="${id}" title="${escAttr((st.desc || '') + (PS().autoDesc(id) ? '\n⚡ ' + PS().autoDesc(id) : ''))}">
                        <span class="wsp-check-mark">${mark}</span>
                        <span class="wsp-check-label">${icon(id, 'wsp-check-ic')} ${escHtml(st.label)}${autoTag}</span>
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

    // Re-render whichever editor (detail page or inline drop-down) shows this video
    function rerenderEditor(videoId) {
        if (currentPage === 'detail' && selectedVideo && selectedVideo.id === videoId) renderDetail();
        else renderTab();
    }

    // The full video editor — ordered to MIRROR THE PIPELINE: concept work
    // (hook/script) on top, decomposition & procurement in the middle,
    // pre-edit assets (voiceover) at the bottom. Used by BOTH the detail
    // page and the inline drop-down in the stage panel.
    function detailFieldsHtml(v) {
        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="workshop-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }
        const blockers = videoBlockers(v);
        const sponsors = SVC().sponsors.getAll();
        const myComps = componentsForVideo(v.id);
        // Blocker rows still show which kind is holding the video up
        const DEP_ICON_NAME = { video: 'video', component: 'component', order: 'order' };
        // Clean section header: line-icon + title + optional muted hint
        const subTitle = (iconName, title, hint) =>
            `<div class="wsp-subsection-title">${icon(iconName, 'wsp-sub-ic')} <span class="wsp-sub-name">${title}</span>${hint ? ` <span class="wsp-hint">${hint}</span>` : ''}</div>`;

        return `
            <div class="workshop-detail-summary">${sourceIdeaHtml}</div>

            ${blockers.length ? `<div class="wsp-blockers-box">
                <div class="wsp-blockers-title">${icon('lock', 'wsp-sub-ic')} Waiting on</div>
                ${blockers.map(b => `<div class="wsp-blocker-line">${icon(DEP_ICON_NAME[b.kind] || 'inventory', 'wsp-row-ic')} ${escHtml(b.label)} <span class="wsp-hint">${escHtml(b.detail)}</span></div>`).join('')}
            </div>` : ''}

            <label>Video Name <span class="wsp-save-status saved" id="wsp-save-status">Saved</span></label>
            <input type="text" id="workshop-name" value="${escAttr(v.name)}">

            <div class="wsp-field-grid">
                <div>
                    <label>Deadline <span class="wsp-hint">(optional)</span></label>
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

            <div class="wsp-progress-head">
                <label>Pipeline Progress</label>
                <div class="wsp-progress-head-actions">
                    <select id="wsp-move-stage" class="wsp-inline-select" title="Veto: jump this video to any stage — everything before it gets marked done (hook/script/voiceover/hook video must exist if the move passes them)">
                        <option value="">Move to stage…</option>
                        ${PS().STAGES.map(s => `<option value="${s.id}">${escHtml(s.label)}</option>`).join('')}
                    </select>
                    <button class="wsp-mini-btn" id="wsp-edit-branches">${icon('decomp', 'wsp-sub-ic')} ${PS().branchesDecided(v) ? 'Edit branch decisions' : 'Decide branches'}</button>
                </div>
            </div>
            ${stageChecklistHtml(v)}

            <div class="wsp-subsection" style="--accent:#a87d3c">
                ${subTitle('ideate', 'Context', '— speak or type ideation notes, angles, details')}
                <div class="wsp-field-with-mic">
                    <textarea id="workshop-context" placeholder="Describe what you want to build, the angles, the details…">${escHtml(v.context || '')}</textarea>
                    <button class="wsp-mic-btn" id="wsp-context-mic" title="Dictate — speak and it transcribes into Context">${icon('voiceover')}</button>
                </div>
            </div>

            <div class="wsp-subsection" style="--accent:#3d8bf0">
                ${subTitle('hook', 'Hook', '— write the hook, then add hook instances to produce &amp; split-test (animation / practical). Each instance needs its footage before its stage clears.')}
                <textarea id="workshop-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                ${v.project ? '' : `<div class="wsp-blockers-box"><div class="wsp-blocker-line">${icon('lock', 'wsp-row-ic')} Select a Channel Project first — hook footage lives in that project's hook/ folder in Dropbox.</div></div>`}
                <div id="wsp-hook-instances">
                    ${PS().hooksOf(v).map((h, i) => hookInstanceRowHtml(v, h, i)).join('')}
                </div>
                <div class="wsp-add-row">
                    <button class="wsp-mini-btn done" id="wsp-add-hooki">＋ Add hook instance</button>
                    ${PS().hooksOf(v).length === 0 ? '<span class="wsp-hint">none yet — add one and pick its type; the Animation / Practical branches flip automatically</span>' : ''}
                </div>
            </div>

            <div class="wsp-subsection" style="--accent:#27ae72">
                ${subTitle('script', 'Script', '— fill it in and Script Writing completes itself')}
                ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', 'Script') : '<textarea id="workshop-script"></textarea>'}
            </div>

            <div class="wsp-subsection wsp-decomp-section" style="--accent:#e8a020">
                ${subTitle('decomp', 'Decomposition', '— break the build into components. Each becomes its own entity in the pipeline (its own stages &amp; needs) while staying linked to this video, which waits for it. Click a component to open it.')}
                <div id="wsp-comp-list">${myComps.map(c => componentRowHtml(c)).join('')}</div>
                <div class="wsp-add-row wsp-decomp-add">
                    <input type="text" id="wsp-new-vcomp" placeholder="What do you need to build? (e.g. 'Doc Ock arm')">
                    <button class="wsp-mini-btn done" id="wsp-add-vcomp">＋ Add component</button>
                    <button class="wsp-mini-btn wsp-ai-btn" id="wsp-ai-suggest" title="Let AI read the hook, script &amp; context and suggest components">✨ AI suggest</button>
                </div>
            </div>

            <div class="wsp-subsection" style="--accent:#8e44ad">
                ${subTitle('voiceover', 'Voiceover', '— one per video (audio or video file), stored in the project\'s vo/ folder in Dropbox. Sits just before Editing: the stage completes itself the moment one is linked.')}
                <div id="wsp-vo-section">
                    ${v.voPath
                        ? '' /* filled by initMediaSection */
                        : v.project
                            ? '<div class="wsp-hint">Checking the vo/ folder…</div>'
                            : `<div class="wsp-blockers-box"><div class="wsp-blocker-line">${icon('lock', 'wsp-row-ic')} Select a Channel Project first — the voiceover lives in that project's Dropbox folder, so no project means nowhere to put it.</div></div>`}
                </div>
            </div>`;
    }

    // Wire up the editor fields (works for the detail page AND the inline
    // drop-down — only one editor is ever mounted at a time).
    function bindDetailFields(v) {
        const get = (id) => document.getElementById(id);
        const nameEl = get('workshop-name');
        if (!nameEl) return;
        const root = nameEl.closest('.workshop-detail-fields');
        const rerender = () => rerenderEditor(v.id);

        // Autosave with a visible status (Editing… → Saving… → Saved ✓),
        // same pattern as the inline script editor. Typed fields debounce
        // briefly and flush the moment you leave the field; dropdowns save
        // IMMEDIATELY — and a project change re-renders so the hook/VO
        // upload sections unlock right away instead of staying blocked.
        const statusEl = get('wsp-save-status');
        const setStatus = (s) => {
            if (!statusEl) return;
            statusEl.textContent = s === 'editing' ? 'Editing…' : s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved ✓' : 'Save failed — retrying on next edit';
            statusEl.className = 'wsp-save-status' + (s === 'saved' ? ' saved' : s === 'saving' ? ' saving' : s === 'failed' ? ' failed' : '');
        };
        let saveTimer = null;
        const doSave = async (thenRerender) => {
            clearTimeout(saveTimer); saveTimer = null;
            setStatus('saving');
            const ok = await saveFieldsFor(VideoService.getById(v.id) || v, true);
            setStatus(ok ? 'saved' : 'failed');
            if (ok && thenRerender) rerender();
        };
        const scheduleSave = () => {
            setStatus('editing');
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => doSave(false), 600);
        };
        ['workshop-name', 'workshop-hook', 'workshop-context'].forEach(id => {
            const el = get(id);
            if (!el) return;
            el.addEventListener('input', scheduleSave);
            el.addEventListener('blur', () => { if (saveTimer) doSave(false); });
        });
        get('workshop-deadline')?.addEventListener('change', () => doSave(false));
        get('workshop-sponsor')?.addEventListener('change', () => doSave(false));
        get('workshop-project')?.addEventListener('change', () => doSave(true));

        // Branch decisions (the decomposition validation gate)
        get('wsp-edit-branches').addEventListener('click', () => openBranchDialog(v.id, false));

        // Hook instances (add/type/label/delete/footage)
        bindHookInstances(v, root, rerender);

        // Veto: jump straight to any stage
        get('wsp-move-stage').addEventListener('change', async (e) => {
            const target = e.target.value;
            e.target.value = '';
            if (!target) return;
            await saveFieldsFor(VideoService.getById(v.id) || v, true); // capture edits before validating
            const moved = await moveVideoToStage(VideoService.getById(v.id) || v, target);
            if (moved) rerender();
        });

        // Stage checklist
        root.querySelectorAll('.wsp-check').forEach(row => {
            const stageId = row.dataset.stage;
            row.querySelectorAll('.wsp-check-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const fresh = VideoService.getById(v.id) || v;
                    const cur = PS().stateOf(fresh, stageId);
                    const want = btn.dataset.act; // 'done' | 'na'
                    const next = cur === want ? '' : want;
                    if (stageId === 'post' && next === 'done') {
                        await saveFieldsFor(fresh, false);
                        await postVideoAction(VideoService.getById(v.id) || fresh);
                        return;
                    }
                    // Completing Decomposition requires the branch decisions
                    if (stageId === 'decomp' && next === 'done' && !PS().branchesDecided(fresh)) {
                        openBranchDialog(v.id, true);
                        return;
                    }
                    await setStageState(v.id, stageId, next);
                    rerender();
                });
            });
        });

        // Components broken out of this video (the video waits for them)
        const addVComp = async () => {
            const input = get('wsp-new-vcomp');
            const name = input.value.trim();
            if (!name) return;
            const fresh = VideoService.getById(v.id) || v;
            const comp = await SVC().components.create({
                videoId: v.id,
                projectId: (fresh.projectIds || [])[0] || '',
                parentComponentId: '',
                name, status: 'design', notes: ''
            });
            // deterministic: a component of this video automatically blocks it
            await saveDeps(fresh, [...videoDeps(fresh), { kind: 'component', id: comp.id }]);
            rerender();
        };
        get('wsp-add-vcomp').addEventListener('click', addVComp);
        get('wsp-new-vcomp').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVComp(); });
        // (component rows' click-to-open AND delete are bound by bindCompStatusRows, which
        // runs for both the detail page and the drop-down editor)

        // AI-suggest components from the hook / script / context
        get('wsp-ai-suggest')?.addEventListener('click', (e) => suggestComponents(v.id, e.currentTarget));

        // Voice dictation into the Context field
        const micBtn = get('wsp-context-mic');
        const ctxEl = get('workshop-context');
        if (micBtn && ctxEl) micBtn.addEventListener('click', () => startDictation(ctxEl, micBtn));

        // Inline script editor
        if (window.EggRenderer) {
            window.EggRenderer.initInlineScriptEditor('workshop-inline-script', {
                get: () => (VideoService.getById(v.id) || v).script || '',
                save: async (text) => { await VideoService.update(v.id, { script: text }); }
            });
        }
    }

    function renderDetail() {
        const el = document.getElementById('workshop-detail');
        if (!el || !selectedVideo) return;
        const v = VideoService.getById(selectedVideo.id) || selectedVideo;
        selectedVideo = v;

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
                    ${progressBar(v)}
                </div>
                <div class="workshop-detail-fields">${detailFieldsHtml(v)}</div>
            </div>
        `;

        document.getElementById('workshop-back-btn').addEventListener('click', () => saveAndBack());
        document.getElementById('workshop-post').addEventListener('click', () => postVideoAction(selectedVideo));
        document.getElementById('workshop-to-library').addEventListener('click', () => backToLibraryAction(selectedVideo));
        document.getElementById('workshop-delete').addEventListener('click', () => deleteVideoAction(selectedVideo));

        bindDetailFields(v);
        // Detail context: bind comp-status + order rows here (the stage panel
        // binds them itself in the drop-down context)
        bindCompStatusRows(el, () => rerenderEditor(v.id));
        bindOrderRows(el);

        // Voiceover section (async — talks to Dropbox; hook instances are
        // wired inside bindDetailFields)
        initMediaSection(v, 'vo');

        // 3D egg preview
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
    }

    // What a component can require downstream (the per-component causality the
    // user sets at Decomposition). Subset of the video's branch stages.
    const COMPONENT_NEEDS = [
        { flag: 'design',     label: 'Design',   icon: 'design' },
        { flag: 'propdesign', label: 'Props',    icon: 'propdesign' },
        { flag: 'cad',        label: 'CAD',      icon: 'cad' },
        { flag: 'pcb',        label: 'PCB',      icon: 'pcb' },
        { flag: 'software',   label: 'Software', icon: 'software' },
        { flag: 'assembly',   label: 'Assembly', icon: 'assembly' },
        { flag: 'artistic',   label: 'Finish',   icon: 'artistic' }
    ];
    const COMPONENT_NEED_LABEL = Object.fromEntries(COMPONENT_NEEDS.map(n => [n.flag, n.label]));

    // A component is its own pipeline entity — created at Decomposition,
    // permanently linked to the video it came from (component.videoId), and it
    // flows the build stages on its own (status = where it is now). The video
    // automatically waits on every component it spawned. Click to open its full
    // detail (assets, links, contacts, needs, stage).
    function componentRowHtml(c) {
        const needs = Array.isArray(c.needs) ? c.needs : [];
        const linkCount = Array.isArray(c.links) ? c.links.length : 0;
        return `<div class="wsp-comp-row" data-comp="${c.id}">
            <button class="wsp-comp-name wsp-clickable" data-open-comp="${c.id}" title="Open this component">
                ${icon('component', 'wsp-row-ic')} <span class="wsp-comp-name-text">${escHtml(c.name)}</span>
                ${c.source === 'order' ? '<span class="wsp-comp-tag order">order</span>' : c.source === 'build' ? '<span class="wsp-comp-tag build">build</span>' : ''}
            </button>
            <div class="wsp-comp-meta">
                ${needs.map(f => `<span class="wsp-need-chip">${escHtml(COMPONENT_NEED_LABEL[f] || f)}</span>`).join('')}
                ${linkCount ? `<span class="wsp-comp-assets">${icon('link', 'wsp-cc-ic')} ${linkCount}</span>` : ''}
                <span class="wsp-comp-stage">${escHtml(c.status || 'design')}</span>
            </div>
            <button class="wsp-mini-btn danger" data-comp-del="${c.id}" title="Remove component">✕</button>
        </div>`;
    }

    // Delete a component from anywhere. The remove must always take effect on
    // screen — its dependency-cleanup is best-effort and its failure must NOT
    // skip the re-render (that was the "can't delete" bug: a throw after the
    // remove left the row on screen).
    async function deleteComponentById(id, rerenderFn) {
        const c = SVC().components.getById(id);
        if (!c) return false;
        if (!confirm(`Delete component "${c.name || 'this component'}"? This can't be undone.`)) return false;
        try {
            await SVC().components.remove(id);
        } catch (e) {
            console.warn('component delete failed', e);
            alert('Could not delete the component: ' + e.message);
            return false;
        }
        if (c.videoId) {
            try {
                const v = VideoService.getById(c.videoId);
                if (v) await saveDeps(v, videoDeps(v).filter(d => !(d.kind === 'component' && d.id === id)));
            } catch (e) { console.warn('dep cleanup after component delete failed (non-fatal)', e); }
        }
        try { if (rerenderFn) rerenderFn(); } catch (e) { console.warn('rerender after delete failed', e); }
        return true;
    }

    function bindCompStatusRows(scope, rerenderFn) {
        scope.querySelectorAll('[data-comp]').forEach(row => {
            const compId = row.dataset.comp;
            row.querySelectorAll('[data-comp-status]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await SVC().components.update(compId, { status: btn.dataset.compStatus });
                    rerenderFn();
                });
            });
        });
        // Click a component name anywhere → open its full detail
        scope.querySelectorAll('[data-open-comp]').forEach(el => el.addEventListener('click', (e) => {
            e.stopPropagation();
            openComponentDetail(el.dataset.openComp);
        }));
        // Delete (✕) — works in the editor list AND the board panels
        scope.querySelectorAll('[data-comp-del]').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteComponentById(btn.dataset.compDel, rerenderFn);
        }));
    }

    // ============ COMPONENT DETAIL — components as first-class objects ============
    // A component opens like a video: its linked video, the stage it's on, what
    // it needs (per-component causality), its assets/links, contacts and notes —
    // all in one place, all autosaving.

    function linkRowHtml(l, i) {
        return `<div class="wsp-row wsp-cd-linkrow" data-linki="${i}">
            <span class="wsp-row-name">${icon('link', 'wsp-row-ic')} ${escHtml(l.label || l.url || 'link')}</span>
            ${l.url ? `<button class="wsp-mini-btn" data-link-open="${i}">↗ Open</button>` : ''}
            <button class="wsp-mini-btn danger" data-link-del="${i}">✕</button>
        </div>`;
    }

    function openComponentDetail(componentId) {
        const c = SVC().components.getById(componentId);
        if (!c) return;
        const video = c.videoId ? VideoService.getById(c.videoId) : null;
        const needs = Array.isArray(c.needs) ? c.needs : [];
        const links = Array.isArray(c.links) ? c.links : [];
        const source = c.source || '';

        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="wsp-picker wsp-comp-detail">
                <div class="wsp-picker-header wsp-comp-detail-head">
                    <span class="wsp-cd-titlewrap">${icon('component', 'wsp-title-ic')}
                        <input id="cd-name" class="wsp-cd-name-input" value="${escAttr(c.name)}" placeholder="Component name">
                    </span>
                    <span class="wsp-save-status saved" id="cd-status">Saved</span>
                    <button class="wsp-picker-close" data-close>✕</button>
                </div>
                <div class="wsp-comp-detail-body">
                    ${video
                        ? `<div class="wsp-comp-fromvideo" data-open-video="${video.id}">${icon('video', 'wsp-row-ic')} <span>From video <b>${escHtml(video.name)}</b></span> <span class="wsp-link">open ↗</span></div>`
                        : '<div class="wsp-hint">Standalone component (not linked to a video)</div>'}

                    <div class="wsp-cd-section">
                        <div class="wsp-cd-label">Stage <span class="wsp-hint">— where it is right now</span></div>
                        <div class="wsp-status-cycle" data-comp="${c.id}">
                            ${COMPONENT_STATUSES.map(s => `<button class="wsp-pill ${c.status === s ? 'active' : ''}" data-cd-status="${s}">${s}</button>`).join('')}
                        </div>
                    </div>

                    <div class="wsp-cd-section">
                        <div class="wsp-cd-label">What it needs <span class="wsp-hint">— pick every step this component requires</span></div>
                        <div class="wsp-needs-btns">
                            ${COMPONENT_NEEDS.map(n => `<button class="wsp-need-btn ${needs.includes(n.flag) ? 'on' : ''}" data-need="${n.flag}">${icon(n.icon, 'wsp-need-ic')} ${n.label}</button>`).join('')}
                        </div>
                        <div class="wsp-cd-label" style="margin-top:10px;">Source</div>
                        <div class="wsp-needs-btns">
                            <button class="wsp-need-btn ${source === 'build' ? 'on' : ''}" data-source="build">${icon('assembly', 'wsp-need-ic')} Build in-house</button>
                            <button class="wsp-need-btn ${source === 'order' ? 'on' : ''}" data-source="order">${icon('order', 'wsp-need-ic')} Order it</button>
                        </div>
                    </div>

                    <div class="wsp-cd-section">
                        <div class="wsp-cd-label">Assets &amp; links <span class="wsp-hint">— 3D models, datasheets, references</span></div>
                        <div id="cd-links">${links.map((l, i) => linkRowHtml(l, i)).join('')}</div>
                        <div class="wsp-add-row">
                            <input type="text" id="cd-link-label" placeholder="label (e.g. 'STL model')">
                            <input type="text" id="cd-link-url" placeholder="https://…">
                            <button class="wsp-mini-btn done" id="cd-link-add">＋ Add</button>
                        </div>
                    </div>

                    <div class="wsp-cd-section">
                        <div class="wsp-cd-label">Contacts</div>
                        <input type="text" id="cd-contacts" placeholder="People / suppliers / who to ask" value="${escAttr(c.contacts || '')}">
                    </div>

                    <div class="wsp-cd-section">
                        <div class="wsp-cd-label">Notes / info</div>
                        <textarea id="cd-notes" placeholder="Anything else about this component…">${escHtml(c.notes || '')}</textarea>
                    </div>

                    <div class="wsp-cd-footer">
                        <button class="wsp-mini-btn danger" id="cd-delete">🗑 Delete component</button>
                    </div>
                </div>
            </div>`;

        const panel = container.querySelector('.workshop-panel');
        panel.appendChild(overlay);
        const q = (sel) => overlay.querySelector(sel);
        const statusEl = q('#cd-status');
        const flashSaved = () => { statusEl.textContent = 'Saved ✓'; statusEl.className = 'wsp-save-status saved'; };
        const flashSaving = () => { statusEl.textContent = 'Saving…'; statusEl.className = 'wsp-save-status saving'; };
        // Serialize PATCHes so rapid edits (toggling several needs) can't race
        // and drop each other's fields at the store level.
        let saveChain = Promise.resolve();
        const saveComp = (changes) => {
            flashSaving();
            saveChain = saveChain.catch(() => {}).then(async () => {
                try { await SVC().components.update(componentId, changes); flashSaved(); }
                catch (e) { statusEl.textContent = 'Save failed'; statusEl.className = 'wsp-save-status failed'; }
            });
            return saveChain;
        };
        const cur = () => SVC().components.getById(componentId) || c;
        // Local, synchronously-updated copy of needs so concurrent toggles
        // accumulate instead of overwriting (each read was seeing stale data).
        const needsSet = new Set(Array.isArray(c.needs) ? c.needs : []);
        let dirty = false;
        const close = () => { overlay.remove(); if (dirty) rerenderEditor(selectedVideo ? selectedVideo.id : (video ? video.id : null)); };
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        q('[data-close]').addEventListener('click', close);
        q('#cd-delete').addEventListener('click', async () => {
            const gone = await deleteComponentById(componentId, null);
            if (gone) { overlay.remove(); rerenderEditor(selectedVideo ? selectedVideo.id : (video ? video.id : null)); }
        });

        // Name (debounced)
        let nameT = null;
        q('#cd-name').addEventListener('input', (e) => {
            clearTimeout(nameT); flashSaving(); dirty = true;
            nameT = setTimeout(() => saveComp({ name: e.target.value.trim() || 'Component' }), 600);
        });
        // Open the linked video
        const fv = q('[data-open-video]');
        if (fv) fv.addEventListener('click', () => { close(); openDetail(fv.dataset.openVideo); });
        // Stage
        q('.wsp-status-cycle').querySelectorAll('[data-cd-status]').forEach(btn => btn.addEventListener('click', async () => {
            dirty = true;
            await saveComp({ status: btn.dataset.cdStatus });
            q('.wsp-status-cycle').querySelectorAll('[data-cd-status]').forEach(b => b.classList.toggle('active', b === btn));
        }));
        // Needs (multi-select) — toggle the local set synchronously; debounce
        // so toggling several in a row coalesces into ONE save of the full set
        let needsT = null;
        overlay.querySelectorAll('[data-need]').forEach(btn => btn.addEventListener('click', () => {
            dirty = true;
            const flag = btn.dataset.need;
            if (needsSet.has(flag)) needsSet.delete(flag); else needsSet.add(flag);
            btn.classList.toggle('on');
            flashSaving();
            clearTimeout(needsT);
            needsT = setTimeout(() => saveComp({ needs: [...needsSet] }), 400);
        }));
        // Source (single-select)
        overlay.querySelectorAll('[data-source]').forEach(btn => btn.addEventListener('click', async () => {
            dirty = true;
            const val = cur().source === btn.dataset.source ? '' : btn.dataset.source;
            overlay.querySelectorAll('[data-source]').forEach(b => b.classList.toggle('on', b === btn && !!val));
            await saveComp({ source: val });
        }));
        // Links
        const renderLinks = () => { q('#cd-links').innerHTML = (cur().links || []).map((l, i) => linkRowHtml(l, i)).join(''); bindLinks(); };
        const bindLinks = () => {
            q('#cd-links').querySelectorAll('[data-link-del]').forEach(b => b.addEventListener('click', async () => {
                dirty = true;
                const links2 = (cur().links || []).filter((_, i) => i !== Number(b.dataset.linkDel));
                await saveComp({ links: links2 }); renderLinks();
            }));
            q('#cd-links').querySelectorAll('[data-link-open]').forEach(b => b.addEventListener('click', () => {
                const l = (cur().links || [])[Number(b.dataset.linkOpen)];
                if (l && l.url) window.open(l.url, '_blank');
            }));
        };
        bindLinks();
        q('#cd-link-add').addEventListener('click', async () => {
            const label = q('#cd-link-label').value.trim();
            let url = q('#cd-link-url').value.trim();
            if (!label && !url) return;
            if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
            dirty = true;
            await saveComp({ links: [...(cur().links || []), { label: label || url, url }] });
            q('#cd-link-label').value = ''; q('#cd-link-url').value = '';
            renderLinks();
        });
        // Contacts + notes (debounced)
        let cT = null, nT = null;
        q('#cd-contacts').addEventListener('input', (e) => { clearTimeout(cT); flashSaving(); dirty = true; cT = setTimeout(() => saveComp({ contacts: e.target.value }), 600); });
        q('#cd-notes').addEventListener('input', (e) => { clearTimeout(nT); flashSaving(); dirty = true; nT = setTimeout(() => saveComp({ notes: e.target.value }), 600); });
    }

    // ============ VOICE DICTATION (Web Speech API) ============
    function startDictation(targetEl, btn) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { alert('Voice input is not supported in this browser. Try Chrome.'); return; }
        if (btn._rec) { btn._rec.stop(); return; }
        const rec = new SR();
        rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
        const base = targetEl.value ? targetEl.value.trimEnd() + ' ' : '';
        rec.onresult = (e) => {
            let txt = '';
            for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
            targetEl.value = base + txt;
            targetEl.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const stop = () => { btn.classList.remove('recording'); btn._rec = null; };
        rec.onend = stop; rec.onerror = stop;
        btn._rec = rec; btn.classList.add('recording');
        try { rec.start(); } catch (e) { stop(); }
    }

    // ============ AI COMPONENT SUGGESTIONS (Kimi K2.6 via Fireworks) ============
    // Kimi reasons before answering, so we forbid prose AND extract the JSON
    // object even if some thinking leaks in. Falls back to OpenAI if Kimi is
    // unavailable (e.g. FIREWORKS_API_KEY not set on the server).
    // Balanced-brace, string-aware parse of the object beginning at `from`.
    function parseBalancedAt(text, from) {
        let depth = 0, inStr = false, esc = false;
        for (let i = from; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(from, i + 1)); } catch (e) { return null; } } }
        }
        return null;
    }
    // Robust to a reasoning model leaking prose around the JSON. When anchorKey
    // is given, lock onto the object that actually holds that key.
    function extractJsonObject(text, anchorKey) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) {}
        if (anchorKey) {
            const a = text.indexOf('"' + anchorKey + '"');
            if (a >= 0) {
                const open = text.lastIndexOf('{', a);
                if (open >= 0) { const o = parseBalancedAt(text, open); if (o) return o; }
            }
        }
        const s = text.indexOf('{');
        return s >= 0 ? parseBalancedAt(text, s) : null;
    }
    // Ask Kimi first (lots of token headroom since it reasons before the JSON);
    // validate its output parses, otherwise fall back to OpenAI's strict JSON
    // mode. validate(content) → parsed object, or null if unusable.
    async function aiJson(messages, validate) {
        try {
            // Kimi K2.6 reasons before answering — give it room to finish AND
            // emit the final JSON, which the anchored extractor then pulls out.
            const r = await fetch('/api/kimi/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, temperature: 0.2, max_tokens: 8000 }) });
            if (r.ok) { const c = (await r.json()).choices?.[0]?.message?.content; const v = validate(c); if (v) return v; }
        } catch (e) { /* fall through */ }
        const r2 = await fetch('/api/openai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, temperature: 0.3, max_tokens: 1200, response_format: { type: 'json_object' } }) });
        if (!r2.ok) throw new Error(`AI request failed (${r2.status})`);
        const v2 = validate((await r2.json()).choices?.[0]?.message?.content);
        if (!v2) throw new Error('AI returned malformed output');
        return v2;
    }
    async function suggestComponents(videoId, btn) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '✨ Thinking…';
        try {
            const existing = componentsForVideo(videoId).map(c => c.name);
            const sys = `You are a production planner for maker / engineering YouTube videos. Given a video idea, list the physical COMPONENTS that must be built or bought to pull it off. Output ONLY a JSON object and nothing else — no prose, no markdown fences, do not explain, do not think out loud. Schema: {"components":[{"name":"short concrete name","source":"build"|"order","needs":[...]}]}. "source" is "build" if you'd make it in-house, "order" if you'd buy it. "needs" is an array containing ONLY values from this EXACT set of production steps: design, propdesign, cad, pcb, software, assembly, artistic. These are stages of work, NOT other components — never put a component name in "needs". Use [] when a component needs none of those steps (e.g. an off-the-shelf part you just order). 3-8 components.`;
            const user = `Video title: ${v.name}\nHook: ${v.hook || '(none)'}\nScript: ${(v.script || '(none)').slice(0, 2000)}\nContext: ${v.context || '(none)'}\nAlready added (don't repeat): ${existing.join(', ') || 'none'}`;
            const parsed = await aiJson(
                [{ role: 'system', content: sys }, { role: 'user', content: user }],
                (content) => { const o = extractJsonObject(content, 'components'); return (o && Array.isArray(o.components) && o.components.length) ? o : null; }
            );
            const list = parsed.components.filter(c => c && c.name);
            if (!list.length) { alert('AI did not suggest any components. Add more context and try again.'); return; }
            showComponentSuggestions(videoId, list);
        } catch (e) {
            console.warn('suggestComponents failed', e);
            alert('AI suggest failed: ' + e.message);
        } finally {
            btn.disabled = false; btn.textContent = orig;
        }
    }

    function showComponentSuggestions(videoId, list) {
        const ALLOWED = new Set(COMPONENT_NEEDS.map(n => n.flag));
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="wsp-picker wsp-suggest-modal">
                <div class="wsp-picker-header"><span>✨ AI-suggested components</span><button class="wsp-picker-close" data-close>✕</button></div>
                <div class="wsp-suggest-list">
                    <div class="wsp-hint" style="padding:0 2px 4px;">Add the ones that fit — each becomes its own pipeline entity linked to this video.</div>
                    ${list.map((c, i) => {
                        const needs = (c.needs || []).filter(f => ALLOWED.has(f));
                        return `<div class="wsp-suggest-row" data-sug="${i}">
                            <div class="wsp-suggest-main">
                                <div class="wsp-suggest-name">${icon('component', 'wsp-row-ic')} ${escHtml(c.name)} ${c.source === 'order' ? '<span class="wsp-comp-tag order">order</span>' : '<span class="wsp-comp-tag build">build</span>'}</div>
                                <div class="wsp-comp-meta">${needs.map(f => `<span class="wsp-need-chip">${escHtml(COMPONENT_NEED_LABEL[f] || f)}</span>`).join('') || '<span class="wsp-hint">no special steps</span>'}</div>
                            </div>
                            <button class="wsp-mini-btn done" data-add-sug="${i}">＋ Add</button>
                        </div>`;
                    }).join('')}
                </div>
                <div class="wsp-branch-actions">
                    <button class="wsp-mini-btn" data-close>Close</button>
                    <button class="wsp-mini-btn done" id="wsp-add-all-sug">Add all</button>
                </div>
            </div>`;
        const panel = container.querySelector('.workshop-panel');
        panel.appendChild(overlay);
        const close = () => { overlay.remove(); rerenderEditor(videoId); };
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

        const addOne = async (i, rowBtn) => {
            const c = list[i];
            if (!c || c._added) return;
            c._added = true;
            if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = '✓ Added'; }
            const fresh = VideoService.getById(videoId);
            const comp = await SVC().components.create({
                videoId, projectId: (fresh.projectIds || [])[0] || '', parentComponentId: '',
                name: c.name, status: 'design', notes: '',
                needs: (c.needs || []).filter(f => ALLOWED.has(f)),
                source: c.source === 'order' ? 'order' : 'build', links: []
            });
            await saveDeps(fresh, [...videoDeps(fresh), { kind: 'component', id: comp.id }]);
        };
        overlay.querySelectorAll('[data-add-sug]').forEach(b => b.addEventListener('click', () => addOne(Number(b.dataset.addSug), b)));
        overlay.querySelector('#wsp-add-all-sug').addEventListener('click', async (e) => {
            e.target.disabled = true; e.target.textContent = 'Adding…';
            for (let i = 0; i < list.length; i++) await addOne(i, overlay.querySelector(`[data-add-sug="${i}"]`));
            close();
        });
    }

    // ============ HOOK INSTANCES (split-test hooks, footage in <project>/hook/) ============

    const HOOK_TYPE_META = { animation: { icon: '🎞️', label: 'Animation' }, practical: { icon: '🎯', label: 'Practical' } };

    function hookInstanceRowHtml(v, h, i) {
        const meta = HOOK_TYPE_META[h.type];
        const linked = !!h.videoPath;
        return `<div class="wsp-hooki" data-hooki="${escAttr(h.id)}">
            <div class="wsp-add-row">
                <span class="wsp-hint" style="font-style:normal;font-weight:800;">#${i + 1}</span>
                <select data-hooki-type="${escAttr(h.id)}" class="wsp-inline-select">
                    <option value="" ${!h.type ? 'selected' : ''}>type…</option>
                    <option value="animation" ${h.type === 'animation' ? 'selected' : ''}>Animation</option>
                    <option value="practical" ${h.type === 'practical' ? 'selected' : ''}>Practical</option>
                </select>
                <input type="text" data-hooki-label="${escAttr(h.id)}" placeholder="label (optional, e.g. 'POV version')" value="${escAttr(h.label || '')}">
                <button class="wsp-mini-btn danger" data-hooki-del="${escAttr(h.id)}">✕</button>
            </div>
            ${linked
                ? `<div class="wsp-row" style="border-left: 3px solid ${h.type === 'animation' ? '#4a9eff' : '#e8a020'}">
                    <span class="wsp-row-name">${icon(h.type === 'animation' ? 'animation' : 'hookfilm', 'wsp-row-ic')} ${escHtml(h.videoName || h.videoPath.split('/').pop())} <span class="wsp-hint">linked ✓</span></span>
                    <button class="wsp-mini-btn" data-hooki-open="${escAttr(h.id)}">▶ Open</button>
                    <button class="wsp-mini-btn danger" data-hooki-unlink="${escAttr(h.id)}">✕ Unlink</button>
                </div>`
                : `<div class="wsp-add-row wsp-hooki-media" data-hooki-media="${escAttr(h.id)}" data-empty="1">
                    <span class="wsp-hint">${v.project ? 'loading footage controls…' : 'select a Channel Project to attach footage'}</span>
                </div>`}
        </div>`;
    }

    function hooksWithEdits(videoId) {
        return PS().hooksOf(VideoService.getById(videoId) || {}).map(h => ({ ...h }));
    }

    // Writing the instances also derives the branches deterministically:
    // any animation instance → Animation stage on; any practical → Practical
    // Hook Filming on. Legacy single-hook fields are retired on first write.
    async function saveHooks(videoId, hooks) {
        const fresh = VideoService.getById(videoId);
        const branches = { ...((fresh && fresh.branches) || {}) };
        branches.animation = hooks.some(h => h.type === 'animation');
        branches.hookfilm = hooks.some(h => h.type === 'practical');
        await VideoService.update(videoId, {
            hooks, branches,
            hookType: '', hookVideoPath: '', hookVideoName: '',
            status: normalizedStatus(fresh || { status: 'pipeline' })
        });
    }

    function bindHookInstances(v, root, rerender) {
        root.querySelector('#wsp-add-hooki')?.addEventListener('click', async () => {
            const hooks = hooksWithEdits(v.id);
            hooks.push({ id: 'h' + Math.random().toString(36).slice(2, 10), type: '', label: '', videoPath: '', videoName: '' });
            await saveHooks(v.id, hooks);
            rerender();
        });
        root.querySelectorAll('[data-hooki-type]').forEach(sel => sel.addEventListener('change', async () => {
            const hooks = hooksWithEdits(v.id);
            const h = hooks.find(x => x.id === sel.dataset.hookiType);
            if (!h) return;
            h.type = sel.value;
            await saveHooks(v.id, hooks);
            rerender();
        }));
        root.querySelectorAll('[data-hooki-label]').forEach(inp => {
            let t = null;
            inp.addEventListener('input', () => {
                clearTimeout(t);
                t = setTimeout(async () => {
                    const hooks = hooksWithEdits(v.id);
                    const h = hooks.find(x => x.id === inp.dataset.hookiLabel);
                    if (!h) return;
                    h.label = inp.value;
                    await saveHooks(v.id, hooks);
                }, 1000);
            });
        });
        root.querySelectorAll('[data-hooki-del]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Remove this hook instance? (Any linked file stays in Dropbox.)')) return;
            await saveHooks(v.id, hooksWithEdits(v.id).filter(x => x.id !== b.dataset.hookiDel));
            rerender();
        }));
        root.querySelectorAll('[data-hooki-open]').forEach(b => b.addEventListener('click', async () => {
            const h = hooksWithEdits(v.id).find(x => x.id === b.dataset.hookiOpen);
            if (!h || !h.videoPath) return;
            const r = await fetch('/api/dropbox/get_temporary_link', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: h.videoPath })
            });
            const data = await r.json();
            if (data.link) window.open(data.link, '_blank');
            else alert('Could not load the hook video: ' + (data.error_summary || 'no link'));
        }));
        root.querySelectorAll('[data-hooki-unlink]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Unlink this hook video? (The file stays in Dropbox.)')) return;
            const hooks = hooksWithEdits(v.id);
            const h = hooks.find(x => x.id === b.dataset.hookiUnlink);
            if (!h) return;
            h.videoPath = ''; h.videoName = '';
            await saveHooks(v.id, hooks);
            rerender();
        }));
        initHookInstanceMedia(v, root, rerender);
    }

    // Async: fill in the link/upload controls for instances without footage
    // (one Dropbox folder listing for the whole section)
    async function initHookInstanceMedia(v, root, rerender) {
        if (!v.project) return;
        const pending = [...root.querySelectorAll('[data-hooki-media][data-empty="1"]')];
        if (!pending.length) return;
        const rootPath = await dropboxRootPath();
        const folder = `${rootPath}/${v.project}/hook`;
        let files = [];
        try {
            const r = await fetch('/api/dropbox/list_folder', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: folder })
            });
            const data = await r.json();
            if (Array.isArray(data.entries)) files = data.entries.filter(e => e['.tag'] === 'file');
        } catch (e) { /* folder doesn't exist yet — created on first upload */ }
        if (!root.isConnected) return; // user navigated away

        pending.forEach(el => {
            const hid = el.dataset.hookiMedia;
            el.innerHTML = `
                ${files.length ? `<select data-hooki-pick="${escAttr(hid)}" class="wsp-inline-select"><option value="">Link existing from ${escHtml(v.project)}/hook…</option>${files.map(f => `<option value="${escAttr(f.path_display || f.path_lower)}">${escHtml(f.name)}</option>`).join('')}</select>` : ''}
                <input type="file" data-hooki-file="${escAttr(hid)}" accept="video/*" style="font-size:11px;flex:1 1 140px;">
                <button class="wsp-mini-btn done" data-hooki-up="${escAttr(hid)}">⬆ Upload</button>`;
        });

        const setFootage = async (hid, path, name) => {
            const hooks = hooksWithEdits(v.id);
            const h = hooks.find(x => x.id === hid);
            if (!h) return;
            h.videoPath = path; h.videoName = name;
            await saveHooks(v.id, hooks);
            rerender();
        };
        root.querySelectorAll('[data-hooki-pick]').forEach(sel => sel.addEventListener('change', () => {
            if (!sel.value) return;
            setFootage(sel.dataset.hookiPick, sel.value, sel.options[sel.selectedIndex].textContent);
        }));
        root.querySelectorAll('[data-hooki-up]').forEach(btn => btn.addEventListener('click', async () => {
            const hid = btn.dataset.hookiUp;
            const input = root.querySelector(`[data-hooki-file="${hid}"]`);
            const file = input && input.files && input.files[0];
            if (!file) { alert('Choose a video file first.'); return; }
            const rowEl = root.querySelector(`[data-hooki-media="${hid}"]`);
            const bar = uploadProgressBar(rowEl, file.name);
            try {
                const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress);
                bar.stage('Linking to this hook…');
                toast(`🪝 hook video uploaded to ${v.project}/hook`);
                await setFootage(hid, meta.path_display || meta.path_lower, meta.name || file.name);
            } catch (e) {
                console.warn('hook video upload failed', e);
                alert('Hook video upload failed: ' + e.message);
                rerender(); // restores the pick/upload controls
            }
        }));
    }

    // ============ DROPBOX MEDIA SECTIONS (voiceover <project>/vo/, hook video <project>/hook/) ============

    // XHR (fetch can't report upload progress). onProgress(loaded, total)
    // covers browser→server; the server then forwards to Dropbox before
    // responding, so 100% switches to a "processing" stage until resolve.
    function uploadToDropbox(destPath, file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/dropbox/upload?path=${encodeURIComponent(destPath)}`);
            xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
            xhr.onload = () => {
                try {
                    const meta = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300 && (meta.path_display || meta.path_lower)) resolve(meta);
                    else reject(new Error(meta.error_summary || meta.error || `upload failed (${xhr.status})`));
                } catch (e) { reject(new Error(`upload failed (${xhr.status})`)); }
            };
            xhr.onerror = () => reject(new Error('network error during upload'));
            xhr.send(file);
        });
    }

    // Swap an element's content for a live progress bar; returns updaters.
    function uploadProgressBar(hostEl, fileName) {
        hostEl.innerHTML = `<div class="wsp-upload-progress" title="${escAttr(fileName)}">
            <div class="wsp-upload-bar"><div class="wsp-upload-fill" style="width:0%"></div></div>
            <span class="wsp-upload-label">Starting upload…</span>
        </div>`;
        const fill = hostEl.querySelector('.wsp-upload-fill');
        const label = hostEl.querySelector('.wsp-upload-label');
        const fmt = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
        return {
            progress(loaded, total) {
                const pct = Math.min(100, Math.round(loaded / total * 100));
                fill.style.width = pct + '%';
                label.textContent = pct >= 100 ? 'Sending to Dropbox…' : `Uploading ${pct}% — ${fmt(loaded)} of ${fmt(total)}`;
            },
            stage(text) { fill.style.width = '100%'; label.textContent = text; }
        };
    }

    async function dropboxRootPath() {
        try {
            const cfg = await HtmlUtils.getConfig();
            return (cfg.dropbox && cfg.dropbox.rootPath) || '';
        } catch (e) { return ''; }
    }

    const MEDIA_SECTIONS = {
        vo: { elId: 'wsp-vo-section', folder: 'vo', pathField: 'voPath', nameField: 'voName', accept: 'audio/*,video/*', icon: '🎙️', iconName: 'voiceover', noun: 'voiceover', color: '#8e44ad' }
    };
    const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'];

    async function initMediaSection(v, key) {
        const cfg = MEDIA_SECTIONS[key];
        const el = document.getElementById(cfg.elId);
        if (!el) return;
        const linkedPath = v[cfg.pathField];

        // --- A file is linked: play/open it or unlink it ---
        if (linkedPath) {
            const name = v[cfg.nameField] || linkedPath.split('/').pop();
            // VO can be audio OR video — inline-play audio, open video in a tab
            const isAudio = !VIDEO_EXTS.includes((name.split('.').pop() || '').toLowerCase());
            el.innerHTML = `
                <div class="wsp-row" style="border-left: 3px solid ${cfg.color}">
                    <span class="wsp-row-name">${icon(cfg.iconName || 'inventory', 'wsp-row-ic')} ${escHtml(name)} <span class="wsp-hint">linked ✓</span></span>
                    <button class="wsp-mini-btn" id="${cfg.elId}-play">${isAudio ? '▶ Play' : '▶ Open'}</button>
                    <button class="wsp-mini-btn danger" id="${cfg.elId}-unlink">✕ Unlink</button>
                    ${isAudio ? `<audio id="${cfg.elId}-audio" style="display:none"></audio>` : ''}
                </div>`;
            const playBtn = document.getElementById(`${cfg.elId}-play`);
            playBtn.addEventListener('click', async () => {
                playBtn.disabled = true;
                try {
                    const r = await fetch('/api/dropbox/get_temporary_link', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: linkedPath })
                    });
                    const data = await r.json();
                    if (!data.link) throw new Error(data.error_summary || 'no link');
                    if (isAudio) {
                        const audio = document.getElementById(`${cfg.elId}-audio`);
                        if (!audio.src) audio.src = data.link;
                        if (audio.paused) { audio.play(); playBtn.textContent = '⏸ Pause'; }
                        else { audio.pause(); playBtn.textContent = '▶ Play'; }
                        audio.onended = () => { playBtn.textContent = '▶ Play'; };
                    } else {
                        window.open(data.link, '_blank');
                    }
                } catch (e) {
                    alert(`Could not load the ${cfg.noun} from Dropbox: ` + e.message);
                } finally {
                    playBtn.disabled = false;
                }
            });
            document.getElementById(`${cfg.elId}-unlink`).addEventListener('click', async () => {
                if (!confirm(`Unlink this ${cfg.noun}? (The file stays in Dropbox.)`)) return;
                await VideoService.update(v.id, { [cfg.pathField]: '', [cfg.nameField]: '', status: normalizedStatus(v) });
                rerenderEditor(v.id);
            });
            return;
        }

        // --- No project selected: deterministic bottleneck, nothing to do ---
        if (!v.project) return;

        // --- No file yet: offer existing files from <project>/<folder>/ + upload ---
        const root = await dropboxRootPath();
        const folder = `${root}/${v.project}/${cfg.folder}`;
        let files = [];
        try {
            const r = await fetch('/api/dropbox/list_folder', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: folder })
            });
            const data = await r.json();
            if (Array.isArray(data.entries)) {
                files = data.entries.filter(e => e['.tag'] === 'file');
            }
        } catch (e) { /* folder doesn't exist yet — created on first upload */ }

        // The drop-down editor has no selectedVideo — what matters is whether
        // OUR element is still mounted (a re-render/navigation replaces it)
        if (!el.isConnected) return;

        el.innerHTML = `
            ${files.length ? `<div class="wsp-add-row">
                <select id="${cfg.elId}-pick">
                    <option value="">Link an existing file from ${escHtml(v.project)}/${cfg.folder}…</option>
                    ${files.map(f => `<option value="${escAttr(f.path_display || f.path_lower)}">${escHtml(f.name)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="wsp-add-row">
                <input type="file" id="${cfg.elId}-file" accept="${cfg.accept}" style="font-size:11.5px;flex:1 1 180px;">
                <button class="wsp-mini-btn done" id="${cfg.elId}-upload">⬆ Upload & link</button>
            </div>
            <div class="wsp-hint">Uploads go straight to Dropbox: ${escHtml(folder)}/ (folder is created automatically).</div>`;

        const pick = document.getElementById(`${cfg.elId}-pick`);
        if (pick) pick.addEventListener('change', async () => {
            if (!pick.value) return;
            const name = pick.options[pick.selectedIndex].textContent;
            await VideoService.update(v.id, { [cfg.pathField]: pick.value, [cfg.nameField]: name, status: normalizedStatus(v) });
            rerenderEditor(v.id);
        });
        document.getElementById(`${cfg.elId}-upload`).addEventListener('click', async () => {
            const input = document.getElementById(`${cfg.elId}-file`);
            const file = input.files && input.files[0];
            if (!file) { alert(`Choose a file first.`); return; }
            const bar = uploadProgressBar(el, file.name);
            try {
                const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress);
                bar.stage('Linking to this video…');
                await VideoService.update(v.id, {
                    [cfg.pathField]: meta.path_display || meta.path_lower,
                    [cfg.nameField]: meta.name || file.name,
                    status: normalizedStatus(v)
                });
                bar.stage('Done ✓');
                toast(`${cfg.icon} ${cfg.noun} uploaded to ${v.project}/${cfg.folder}`);
                rerenderEditor(v.id);
            } catch (e) {
                console.warn(`${cfg.noun} upload failed`, e);
                alert(`${cfg.noun} upload failed: ` + e.message);
                rerenderEditor(v.id); // restores the pick/upload controls
            }
        });
    }

    // Veto move: jump a video to any stage. Everything upstream of the
    // target gets marked done so the target becomes the frontier; the target
    // and everything after it are reset to pending. Hard requirements are
    // only the FIELD gates the move would skip over (hook text, script text,
    // linked voiceover) — components/branches are NOT mandatory here, this
    // is the escape hatch for pre-pipeline videos.
    async function moveVideoToStage(v, targetId) {
        const target = PS().get(targetId);
        if (!v || !target) return false;

        const anc = new Set(PS().ancestorsOf(targetId));
        const missing = [];
        if (anc.has('hook') && (v.hook || '').trim().length < 10) missing.push('• Hook — write at least a line in the Hook field');
        if (anc.has('script') && (v.script || '').trim().length < 100) missing.push('• Script — the Script field needs real content');
        if (anc.has('voiceover') && !v.voPath) missing.push('• Voiceover — link or upload one first');
        const typedHooks = PS().hooksOf(v).filter(h => h.type === 'animation' || h.type === 'practical');
        if ((anc.has('animation') || anc.has('hookfilm')) && typedHooks.length && typedHooks.some(h => !h.videoPath)) {
            missing.push('• Hook footage — every declared hook instance needs its video linked');
        }
        if (missing.length) {
            alert(`Can't move to ${target.label} yet — the move would skip past mandatory fields that are still empty:\n\n${missing.join('\n')}`);
            return false;
        }

        if (!confirm(`Move "${v.name}" to ${target.icon} ${target.label}?\nEverything before it will be marked done; ${target.label} and everything after reset to pending.`)) return false;

        const cur = { ...(v.stageState || {}) };
        const resetSet = new Set([targetId, ...PS().descendantsOf(targetId)]);
        const stageState = {};
        PS().STAGES.forEach(s => {
            if (anc.has(s.id)) {
                stageState[s.id] = cur[s.id] === 'na' ? 'na' : 'done';   // everything before: done (keep explicit N/As)
            } else if (resetSet.has(s.id)) {
                if (cur[s.id] === 'na') stageState[s.id] = 'na';          // target & after: pending (keep explicit N/As)
            } else if (cur[s.id]) {
                stageState[s.id] = cur[s.id];                             // unrelated parallel branches: untouched
            }
        });
        await VideoService.update(v.id, { stageState, status: normalizedStatus(v) });
        toast(`Moved to ${target.icon} ${target.label}`);
        return true;
    }

    // Merge legacy dependsOn (plain video ids) into the typed deps list
    function videoDeps(v) {
        const typed = Array.isArray(v.deps) ? v.deps.filter(d => d && d.id && d.kind) : [];
        const seen = new Set(typed.map(d => d.kind + ':' + d.id));
        (v.dependsOn || []).forEach(id => {
            if (!seen.has('video:' + id)) typed.push({ kind: 'video', id });
        });
        return typed;
    }
    async function saveDeps(v, deps) {
        // dedupe, write typed deps, retire the legacy field
        const seen = new Set();
        const clean = deps.filter(d => {
            const k = d.kind + ':' + d.id;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        await VideoService.update(v.id, { deps: clean, dependsOn: [], status: normalizedStatus(v) });
    }

    // Save the editor's simple fields for a specific video — works whether
    // the editor is the detail page or the inline drop-down (only one is
    // ever mounted, so the field ids are unambiguous).
    async function saveFieldsFor(v, silent) {
        if (!v) return true;
        const get = id => document.getElementById(id);
        if (!get('workshop-name')) return true; // no editor mounted — nothing to save
        const name = get('workshop-name').value.trim() || v.name;
        const project = get('workshop-project')?.value || '';
        const hook = get('workshop-hook')?.value || '';
        const context = get('workshop-context')?.value || '';
        const deadline = get('workshop-deadline')?.value || '';
        const sponsorId = get('workshop-sponsor')?.value || '';
        try {
            await VideoService.saveWithIdeaSync(v.id, {
                name, project, hook, context, deadline, sponsorId,
                status: normalizedStatus(v)
            });
            return true;
        } catch (e) {
            console.warn('Workshop: save failed', e);
            if (!silent) alert('Failed to save. Check connection.');
            return false;
        }
    }
    function saveFields(silent) { return saveFieldsFor(selectedVideo, silent); }

    async function saveAndBack() {
        await saveFields(true);
        showList();
    }

    function closeEditorContext() {
        expandedStageVideoId = null;
        if (currentPage === 'detail') setTimeout(() => showList(), 100);
        else renderTab();
    }

    async function postVideoAction(v) {
        if (!v) return;
        if (!v.script && !document.getElementById('workshop-inline-script-textarea')?.value) {
            if (!confirm('No script on this video. Post anyway?')) return;
        }
        try {
            await saveFieldsFor(v, true);
            const fresh = VideoService.getById(v.id) || v;
            await postVideoRecord(fresh, { ...(fresh.stageState || {}), post: 'done' });
            closeEditorContext();
        } catch (e) {
            console.warn('Workshop: post failed', e);
            alert('Failed to post video. Check connection.');
        }
    }

    async function backToLibraryAction(v) {
        if (!v) return;
        if (!confirm('Move this back to the Library as an idea? The pipeline entry will be removed (the idea and script are kept).')) return;
        try {
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
            closeEditorContext();
        } catch (e) {
            console.warn('Workshop: back to library failed', e);
            alert('Failed to move back to Library. Check connection.');
        }
    }

    async function deleteVideoAction(v) {
        if (!v) return;
        if (!confirm(`Delete "${v.name}"? The source idea (if any) stays in the Library.`)) return;
        await VideoService.remove(v.id);
        closeEditorContext();
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
            } else if (expandedStageVideoId) {
                saveFieldsFor(VideoService.getById(expandedStageVideoId), true).catch(() => {});
            }
            const previewCanvas = document.getElementById('workshop-detail-egg-canvas');
            if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();
            container = null;
            selectedVideo = null;
            selectedStageId = null;
            expandedStageVideoId = null;
            selectedProjectId = null;
            currentPage = 'list';
            activeTab = 'pipeline';
            fSearch = fType = fProject = fSponsor = fAssignee = fFlag = '';
            showTypes = { video: true, component: true, order: true, inventory: true };
        }
    };
})();

BuildingRegistry.register('Workshop', {
    open: (bodyEl, opts) => WorkshopUI.open(bodyEl, opts),
    close: () => WorkshopUI.close()
});
