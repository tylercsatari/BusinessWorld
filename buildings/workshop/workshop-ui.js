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
    let showTypes = { video: true, component: true, order: true, inventory: true };
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
            return `<span class="wsp-stage-chip${st.bottleneck ? ' bottleneck' : ''}">${st.icon} ${escHtml(st.label)}</span>`;
        }).join('');
        if (max && f.length > max) html += `<span class="wsp-stage-chip more">+${f.length - max}</span>`;
        if (!f.length) html = `<span class="wsp-stage-chip done-chip">✅ Complete</span>`;
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
                        <button class="wsp-tab active" data-tab="pipeline">Pipeline</button>
                        <button class="wsp-tab" data-tab="projects">Projects</button>
                        <button class="wsp-tab" data-tab="orders">Orders</button>
                        <button class="wsp-tab" data-tab="inventory">Storage Room</button>
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
    }

    // ============ TAB 1: PIPELINE BOARD — the single view of everything ============

    const NODE_W = 152, NODE_H = 72, GAP_X = 60, GAP_Y = 26, PAD = 24;

    // One color per entity type — same colors everywhere (dots, legend, panel)
    const DOT_COLORS = { video: '#00b894', component: '#1565c0', order: '#e8a020', inventory: '#8e44ad' };
    const GROUP_COLORS = { Concept: '#4a9eff', Planning: '#e8a020', Procurement: '#e67e22', Build: '#7f8c9b', Production: '#e74c3c', Post: '#27ae60' };
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

    // Dot strip: one dot per item, colored by type — the at-a-glance view
    function dotsRow(dots) {
        if (!dots.length) return '';
        const MAX = 16;
        const shown = dots.slice(0, MAX);
        return `<div class="wsp-node-dots">${shown.map(d =>
            `<span class="wsp-dot" style="background:${d.color}" title="${escAttr(d.title)}"></span>`).join('')}${dots.length > MAX ? `<span class="wsp-dot-more">+${dots.length - MAX}</span>` : ''}</div>`;
    }

    function pipelineFilterBarHtml() {
        const all = pipelineVideos();
        const projects = SVC().projects.getAll().filter(p => p.status !== 'archived');
        const sponsors = [...new Set(all.map(v => v.sponsorId).filter(Boolean))].map(id => SVC().sponsors.getById(id)).filter(Boolean);
        const legend = [
            ['video', '🎬 Videos'], ['component', '🧩 Components'], ['order', '📦 Orders'], ['inventory', '🗃️ Inventory']
        ];
        return `<div class="wsp-filterbar wsp-pipeline-filters">
            <div class="wsp-legend">
                ${legend.map(([key, label]) => `
                    <button class="wsp-legend-chip${showTypes[key] ? ' on' : ''}" data-toggle-type="${key}" style="--dotcolor:${DOT_COLORS[key]}">
                        <span class="wsp-dot" style="background:${DOT_COLORS[key]}"></span>${label}
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
        // dashed reference edge: Ordering ↔ Component Library (check inventory before buying)
        `<path d="M ${pos['order'].x + NODE_W / 2} ${pos['order'].y + NODE_H} L ${pos['_inventory'].x + NODE_W / 2} ${pos['_inventory'].y}" class="wsp-edge ref" />`;

        const nodesHtml = PS().STAGES.map(s => {
            const p = pos[s.id];
            const e = entities[s.id];
            const total = e.videos.length + e.components.length + e.orders.length;
            const blockedHere = e.videos.filter(v => videoBlockers(v).length > 0).length;
            const dots = [
                ...e.videos.map(v => ({ color: DOT_COLORS.video, title: `🎬 ${v.name}` })),
                ...e.components.map(c => ({ color: DOT_COLORS.component, title: `🧩 ${c.name}${projectName(c.projectId) ? ' · ' + projectName(c.projectId) : ''}` })),
                ...e.orders.map(o => ({ color: DOT_COLORS.order, title: `📦 ${o.name} (${o.status})` }))
            ];
            return `<div class="wsp-node${s.bottleneck ? ' bottleneck' : ''}${selectedStageId === s.id ? ' selected' : ''}${total ? ' has-videos' : ''}"
                        data-stage="${s.id}" style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px;--groupcolor:${GROUP_COLORS[s.group] || '#ccc'};">
                <div class="wsp-node-label">${s.icon} ${escHtml(s.label)}</div>
                <div class="wsp-node-sub">${s.bottleneck ? '<span class="wsp-bottleneck-tag">bottleneck</span>' : `<span class="wsp-node-group" style="color:${GROUP_COLORS[s.group]}">${escHtml(s.group)}</span>`}</div>
                ${dotsRow(dots)}
                ${blockedHere ? `<span class="wsp-node-blocked" title="${blockedHere} blocked here">🔒</span>` : ''}
            </div>`;
        }).join('');

        // Component Library node: inventory dots colored by readiness
        const invItems = showTypes.inventory ? filteredInventory() : [];
        const INV_STATUS_COLORS = { ready: '#27ae60', building: '#e8a020', planned: '#b0a8a0' };
        const invDots = invItems.map(i => ({ color: INV_STATUS_COLORS[i.status] || '#b0a8a0', title: `🗃️ ${i.name} (${i.status})` }));
        const readyInv = invItems.filter(i => i.status === 'ready').length;
        const invNode = `<div class="wsp-node inv-node" data-goto="inventory" style="left:${pos['_inventory'].x}px;top:${pos['_inventory'].y}px;width:${NODE_W}px;height:64px;">
            <div class="wsp-node-label">🗃️ Storage Room</div>
            <div class="wsp-node-sub"><span class="wsp-node-group">${readyInv}/${invItems.length} ready</span></div>
            ${dotsRow(invDots)}
        </div>`;

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
                initMediaSection(ev, 'hook');
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
            showTypes.video ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">🎬 ${vids.length}</span>` : '',
            showTypes.component ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">🧩 ${comps.length}</span>` : '',
            showTypes.order ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.order}">📦 ${orders.length}</span>` : '',
            showTypes.inventory ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.inventory}">🗃️ ${inv.length}</span>` : ''
        ].join('');

        const INV_STATUS_COLORS = { ready: '#27ae60', building: '#e8a020', planned: '#b0a8a0' };

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div class="wsp-stage-panel-headmain">
                    <div class="wsp-stage-panel-title">🌐 Everything in flight ${breakdown}</div>
                    <div class="wsp-stage-panel-desc">All work matching the filters above. Click a stage node on the board to focus on one stage.</div>
                </div>
            </div>
            <div class="wsp-stage-panel-list">
                ${total === 0 ? '<div class="workshop-empty">Nothing matches the current filters. Queue an idea from the Library to feed the pipeline!</div>' : ''}
                ${vids.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.video}">🎬 Videos in the pipeline</div>${vids.map(v => stageVideoRowHtml(v, null)).join('')}` : ''}
                ${comps.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.component}">🧩 Components being built</div>${comps.map(c => `
                    <div class="wsp-row" data-comp="${c.id}" style="border-left: 3px solid ${DOT_COLORS.component}">
                        <span class="wsp-row-name">🧩 ${escHtml(c.name)} ${projectName(c.projectId) ? `<span class="wsp-hint">🛠️ ${escHtml(projectName(c.projectId))}</span>` : ''}</span>
                        <div class="wsp-status-cycle">
                            ${COMPONENT_STATUSES.map(s => `<button class="wsp-pill ${c.status === s ? 'active' : ''}" data-comp-status="${s}">${s}</button>`).join('')}
                        </div>
                    </div>`).join('')}` : ''}
                ${orders.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.order}">📦 Open orders</div>${orders.map(orderRowHtml).join('')}` : ''}
                ${inv.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.inventory}">🗃️ Storage room (Component Library)</div>${inv.map(i => `
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
            e.videos.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">🎬 ${e.videos.length}</span>` : '',
            e.components.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">🧩 ${e.components.length}</span>` : '',
            e.orders.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.order}">📦 ${e.orders.length}</span>` : ''
        ].join('');

        const compRows = e.components.map(c => `
            <div class="wsp-row" data-comp="${c.id}" style="border-left: 3px solid ${DOT_COLORS.component}">
                <span class="wsp-row-name">🧩 ${escHtml(c.name)} ${projectName(c.projectId) ? `<span class="wsp-hint">🛠️ ${escHtml(projectName(c.projectId))}</span>` : ''}</span>
                <div class="wsp-status-cycle">
                    ${COMPONENT_STATUSES.map(s => `<button class="wsp-pill ${c.status === s ? 'active' : ''}" data-comp-status="${s}">${s}</button>`).join('')}
                </div>
            </div>`).join('');

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div class="wsp-stage-panel-headmain">
                    <div class="wsp-stage-panel-title">${stage.icon} ${escHtml(stage.label)} ${breakdown}</div>
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
                ${compRows ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.component}">🧩 Components being worked here</div>${compRows}` : ''}
                ${e.orders.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.order}">📦 Open orders</div>${e.orders.map(orderRowHtml).join('')}` : ''}
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
        overlay.innerHTML = `
            <div class="wsp-picker wsp-branch-modal">
                <div class="wsp-picker-header"><span>🧩 Decomposition — break "${escHtml(v.name)}" down</span><button class="wsp-picker-close" data-close>✕</button></div>
                <div class="wsp-branch-list">
                    <div class="wsp-hint">Only branches switched ON will ever see this video — everything else is skipped automatically. That's the validation: nobody gets handed work that doesn't apply.</div>
                    ${PS().BRANCH_QUESTIONS.map(q => `
                        <label class="wsp-branch-row">
                            <input type="checkbox" data-flag="${q.flag}" ${b[q.flag] === true ? 'checked' : ''}>
                            <span class="wsp-branch-label">${q.label}</span>
                            <span class="wsp-hint">${escHtml(q.hint)}</span>
                        </label>`).join('')}
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
                        <span class="wsp-check-label">${st.icon} ${escHtml(st.label)}${autoTag}</span>
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
        const allProjects = SVC().projects.getAll().filter(p => p.status !== 'archived');
        const linkedProjects = (v.projectIds || []).map(id => SVC().projects.getById(id)).filter(Boolean);
        const myOrders = SVC().ordersForVideo(v.id);
        const myComps = componentsForVideo(v.id);

        // Typed dependencies (video / component / order) — only unfinished
        // things are offerable; finished things are never blockers.
        const deps = videoDeps(v);
        const depKey = d => d.kind + ':' + d.id;
        const depSet = new Set(deps.map(depKey));
        const DEP_ICONS = { video: '🎬', component: '🧩', order: '📦' };
        const depChips = deps.map(d => {
            let label = '(missing)', done = false;
            if (d.kind === 'video') { const o = VideoService.getById(d.id); if (o) { label = o.name; done = o.status === 'posted'; } }
            else if (d.kind === 'component') { const c = SVC().components.getById(d.id); if (c) { label = c.name; done = c.status === 'done'; } }
            else if (d.kind === 'order') { const o = SVC().orders.getById(d.id); if (o) { label = o.name; done = o.status === 'received'; } }
            return { id: depKey(d), label: `${DEP_ICONS[d.kind]} ${label}${done ? ' ✅' : ' ⏳'}` };
        });
        const depVideoOpts = VideoService.getPipeline().filter(o => o.id !== v.id && !depSet.has('video:' + o.id));
        const depCompOpts = SVC().components.getAll().filter(c => c.status !== 'done' && !depSet.has('component:' + c.id));
        const depOrderOpts = SVC().orders.getAll().filter(o => o.status !== 'received' && !depSet.has('order:' + o.id));

        return `
            <div class="workshop-detail-summary">${sourceIdeaHtml}</div>

            ${blockers.length ? `<div class="wsp-blockers-box">
                <div class="wsp-blockers-title">🔒 Waiting on:</div>
                ${blockers.map(b => `<div class="wsp-blocker-line">${DEP_ICONS[b.kind] || '🗃️'} ${escHtml(b.label)} <span class="wsp-hint">${escHtml(b.detail)}</span></div>`).join('')}
            </div>` : ''}

            <label>Video Name</label>
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
                        <option value="">⏩ Move to stage…</option>
                        ${PS().STAGES.map(s => `<option value="${s.id}">${s.icon} ${escHtml(s.label)}</option>`).join('')}
                    </select>
                    <button class="wsp-mini-btn" id="wsp-edit-branches">🧩 ${PS().branchesDecided(v) ? 'Edit branch decisions' : 'Decide branches'}</button>
                </div>
            </div>
            ${stageChecklistHtml(v)}

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">💡 Context <span class="wsp-hint">— ideation notes, angles, details</span></div>
                <textarea id="workshop-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">🪝 Hook <span class="wsp-hint">— write it and Hook Development completes itself; the hook FOOTAGE below gates Editing</span></div>
                <textarea id="workshop-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>
                <div class="wsp-add-row">
                    <label class="wsp-hint" style="font-style:normal;font-weight:700;">Hook Type:</label>
                    <select id="wsp-hook-type" class="wsp-inline-select" title="Sets the branch automatically: animation → Animation stage; practical → Practical Hook Filming">
                        <option value="">— not decided —</option>
                        <option value="animation" ${v.hookType === 'animation' ? 'selected' : ''}>🎞️ Animation</option>
                        <option value="practical" ${v.hookType === 'practical' ? 'selected' : ''}>🎯 Practical</option>
                    </select>
                    <span class="wsp-hint">${v.hookType === 'animation' ? 'waits at Animation until the hook video is linked' : v.hookType === 'practical' ? 'waits at Practical Hook Filming until the hook video is linked' : 'pick one — it flips the Animation / Practical Hook branches automatically'}</span>
                </div>
                <div id="wsp-hookvid-section">
                    ${v.hookVideoPath
                        ? '' /* filled by initMediaSection */
                        : v.project
                            ? '<div class="wsp-hint">Checking the hook/ folder…</div>'
                            : '<div class="wsp-blockers-box"><div class="wsp-blocker-line">⛔ Select a Channel Project first — the hook video lives in that project\'s Dropbox folder.</div></div>'}
                </div>
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">📝 Script <span class="wsp-hint">— fill it in and Script Writing completes itself</span></div>
                ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', 'Script') : '<textarea id="workshop-script"></textarea>'}
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">🧩 Components <span class="wsp-hint">— broken out at Decomposition; each flows through the pipeline on its own and the video waits for it</span></div>
                ${myComps.map(c => `
                    <div class="wsp-row" data-comp="${c.id}" style="border-left: 3px solid ${DOT_COLORS.component}">
                        <span class="wsp-row-name">🧩 ${escHtml(c.name)}</span>
                        <div class="wsp-status-cycle">
                            ${COMPONENT_STATUSES.map(s => `<button class="wsp-pill ${c.status === s ? 'active' : ''}" data-comp-status="${s}">${s}</button>`).join('')}
                        </div>
                        <button class="wsp-mini-btn danger" data-comp-del="${c.id}">✕</button>
                    </div>`).join('')}
                <div class="wsp-add-row">
                    <input type="text" id="wsp-new-vcomp" placeholder="Add component (e.g. 'Doc Ock arm')">
                    <button class="wsp-mini-btn done" id="wsp-add-vcomp">Add</button>
                </div>
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">⛓️ Waiting on <span class="wsp-hint">— a video, component or order that must finish first. Finished things never block.</span></div>
                <div class="wsp-chips">${chipListHtml(depChips, 'data-undep')}</div>
                <div class="wsp-add-row">
                    <select id="wsp-add-dep">
                        <option value="">Add something to wait on…</option>
                        ${depVideoOpts.length ? `<optgroup label="🎬 Videos in the pipeline">${depVideoOpts.map(o => `<option value="video:${o.id}">${escHtml(o.name)}</option>`).join('')}</optgroup>` : ''}
                        ${depCompOpts.length ? `<optgroup label="🧩 Components not done">${depCompOpts.map(c => `<option value="component:${c.id}">${escHtml(c.name)} (${c.status})</option>`).join('')}</optgroup>` : ''}
                        ${depOrderOpts.length ? `<optgroup label="📦 Orders not received">${depOrderOpts.map(o => `<option value="order:${o.id}">${escHtml(o.name)} (${o.status})</option>`).join('')}</optgroup>` : ''}
                    </select>
                </div>
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">📦 Orders for this video</div>
                ${myOrders.map(orderRowHtml).join('')}
                ${addOrderRowHtml({ videoId: v.id })}
            </div>

            <div class="wsp-subsection">
                <div class="wsp-subsection-title">🛠️ Build projects <span class="wsp-hint">— shared builds this video uses (project components live in the Projects tab)</span></div>
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
                <div class="wsp-subsection-title">🎙️ Voiceover <span class="wsp-hint">— one per video, stored in the project's vo/ folder in Dropbox. Sits just before Editing: the stage completes itself the moment one is linked.</span></div>
                <div id="wsp-vo-section">
                    ${v.voPath
                        ? '' /* filled by initMediaSection */
                        : v.project
                            ? '<div class="wsp-hint">Checking the vo/ folder…</div>'
                            : '<div class="wsp-blockers-box"><div class="wsp-blocker-line">⛔ Select a Channel Project first — the voiceover lives in that project\'s Dropbox folder, so no project means nowhere to put it.</div></div>'}
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

        // Autosave the simple fields — no Back button needed in the drop-down
        let saveTimer = null;
        const scheduleSave = () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => saveFieldsFor(VideoService.getById(v.id) || v, true), 1200);
        };
        ['workshop-name', 'workshop-hook', 'workshop-context'].forEach(id => get(id)?.addEventListener('input', scheduleSave));
        ['workshop-deadline', 'workshop-sponsor', 'workshop-project'].forEach(id => get(id)?.addEventListener('change', scheduleSave));

        // Branch decisions (the decomposition validation gate)
        get('wsp-edit-branches').addEventListener('click', () => openBranchDialog(v.id, false));

        // Hook type → deterministically flips the animation/hookfilm branches
        get('wsp-hook-type').addEventListener('change', async (e) => {
            const hookType = e.target.value;
            const branches = { ...(VideoService.getById(v.id)?.branches || v.branches || {}) };
            if (hookType === 'animation') { branches.animation = true; branches.hookfilm = false; }
            else if (hookType === 'practical') { branches.hookfilm = true; branches.animation = false; }
            await VideoService.update(v.id, { hookType, branches, status: normalizedStatus(v) });
            rerender();
        });

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

        // Project links
        get('wsp-link-project').addEventListener('change', async (e) => {
            let pid = e.target.value;
            if (!pid) return;
            if (pid === '__new__') {
                const name = prompt('New project name:');
                if (!name || !name.trim()) { rerender(); return; }
                const p = await SVC().projects.create({ name: name.trim(), description: '', status: 'active', deadline: '', notes: '' });
                pid = p.id;
            }
            const fresh = VideoService.getById(v.id) || v;
            const projectIds = [...new Set([...(fresh.projectIds || []), pid])];
            await VideoService.update(v.id, { projectIds, status: normalizedStatus(fresh) });
            rerender();
        });
        root.querySelectorAll('[data-unlink-project]').forEach(b => b.addEventListener('click', async () => {
            const fresh = VideoService.getById(v.id) || v;
            const projectIds = (fresh.projectIds || []).filter(id => id !== b.dataset.unlinkProject);
            await VideoService.update(v.id, { projectIds, status: normalizedStatus(fresh) });
            rerender();
        }));

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
        root.querySelectorAll('[data-comp-del]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Remove this component?')) return;
            await SVC().components.remove(b.dataset.compDel);
            const fresh = VideoService.getById(v.id) || v;
            await saveDeps(fresh, videoDeps(fresh).filter(d => !(d.kind === 'component' && d.id === b.dataset.compDel)));
            rerender();
        }));

        // Typed dependencies
        get('wsp-add-dep').addEventListener('change', async (e) => {
            if (!e.target.value) return;
            const [kind, id] = e.target.value.split(':');
            const fresh = VideoService.getById(v.id) || v;
            await saveDeps(fresh, [...videoDeps(fresh), { kind, id }]);
            rerender();
        });
        root.querySelectorAll('[data-undep]').forEach(b => b.addEventListener('click', async () => {
            const [kind, id] = b.dataset.undep.split(':');
            const fresh = VideoService.getById(v.id) || v;
            await saveDeps(fresh, videoDeps(fresh).filter(d => !(d.kind === kind && d.id === id)));
            rerender();
        }));

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

        // Voiceover + hook video sections (async — talk to Dropbox)
        initMediaSection(v, 'vo');
        initMediaSection(v, 'hook');

        // 3D egg preview
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
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
    }

    // ============ DROPBOX MEDIA SECTIONS (voiceover <project>/vo/, hook video <project>/hook/) ============

    async function dropboxRootPath() {
        try {
            const cfg = await HtmlUtils.getConfig();
            return (cfg.dropbox && cfg.dropbox.rootPath) || '';
        } catch (e) { return ''; }
    }

    const MEDIA_SECTIONS = {
        vo:   { elId: 'wsp-vo-section',      folder: 'vo',   pathField: 'voPath',        nameField: 'voName',        accept: 'audio/*', icon: '🎙️', noun: 'voiceover',  color: '#8e44ad' },
        hook: { elId: 'wsp-hookvid-section', folder: 'hook', pathField: 'hookVideoPath', nameField: 'hookVideoName', accept: 'video/*', icon: '🪝', noun: 'hook video', color: '#e8a020' }
    };

    async function initMediaSection(v, key) {
        const cfg = MEDIA_SECTIONS[key];
        const el = document.getElementById(cfg.elId);
        if (!el) return;
        const linkedPath = v[cfg.pathField];

        // --- A file is linked: play/open it or unlink it ---
        if (linkedPath) {
            const name = v[cfg.nameField] || linkedPath.split('/').pop();
            const isAudio = cfg.accept.startsWith('audio');
            el.innerHTML = `
                <div class="wsp-row" style="border-left: 3px solid ${cfg.color}">
                    <span class="wsp-row-name">${cfg.icon} ${escHtml(name)} <span class="wsp-hint">linked ✅</span></span>
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

        const stillThere = document.getElementById(cfg.elId);
        if (!stillThere || !selectedVideo || selectedVideo.id !== v.id) return; // user navigated away

        stillThere.innerHTML = `
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
            const btn = document.getElementById(`${cfg.elId}-upload`);
            btn.textContent = 'Uploading…'; btn.disabled = true;
            try {
                const dest = `${folder}/${file.name}`;
                const r = await fetch(`/api/dropbox/upload?path=${encodeURIComponent(dest)}`, { method: 'POST', body: file });
                const meta = await r.json();
                if (!r.ok || !(meta.path_display || meta.path_lower)) throw new Error(meta.error_summary || meta.error || `upload failed (${r.status})`);
                await VideoService.update(v.id, {
                    [cfg.pathField]: meta.path_display || meta.path_lower,
                    [cfg.nameField]: meta.name || file.name,
                    status: normalizedStatus(v)
                });
                toast(`${cfg.icon} ${cfg.noun} uploaded to ${v.project}/${cfg.folder}`);
                rerenderEditor(v.id);
            } catch (e) {
                console.warn(`${cfg.noun} upload failed`, e);
                alert(`${cfg.noun} upload failed: ` + e.message);
                btn.textContent = '⬆ Upload & link'; btn.disabled = false;
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
        const hookStageActive = (v.branches && (v.branches.animation === true || v.branches.hookfilm === true));
        if ((anc.has('animation') || anc.has('hookfilm')) && hookStageActive && !v.hookVideoPath) {
            missing.push('• Hook video — link or upload the hook footage first');
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
        if (!v) return;
        const get = id => document.getElementById(id);
        if (!get('workshop-name')) return; // no editor mounted
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
        } catch (e) {
            console.warn('Workshop: save failed', e);
            if (!silent) alert('Failed to save. Check connection.');
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
