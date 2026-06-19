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
    // Per-stage permission helpers (provided by access-registry.js). Default to
    // full access when absent (owner / local dev) so nothing breaks.
    const stageVisible = (id) => (typeof window.canSeeStage !== 'function') || window.canSeeStage(id);
    const stageWritable = (id) => (typeof window.canWriteStage !== 'function') || window.canWriteStage(id);
    // Owner = full access. Only the owner gets the "move it anyways" override that
    // skips mandatory-field gates.
    const isOwnerUser = () => !!(window.__access && window.__access.all === true);
    // Delete is a per-profile capability (owner always). Backstop the action even
    // though the buttons are hidden by CSS when not allowed.
    const canDeleteNow = () => (typeof window.canDelete !== 'function') || window.canDelete();
    const blockDelete = () => { alert('Your profile doesn\'t have delete access. Ask the owner to enable it.'); return false; };
    let activeTab = 'pipeline';
    let selectedVideo = null;
    let selectedStageId = null;
    let _scopedStagePicked = false;  // one-time auto-focus for single-node workers
    let expandedStageVideoId = null;
    let selectedProjectId = null;
    let _pipelineIndexed = false;   // lazy semantic-search index (per session)
    let searchType = 'all';
    let currentPage = 'list';

    // Pipeline board filters (apply to everything: dots, counts, stage panel)
    let fSearch = '', fType = '', fProject = '', fSponsor = '', fAssignee = '', fFlag = '';
    // Which entity types are visible on the board (legend toggles)
    // The Workshop board tracks two entities: videos and the components they
    // spawn. Orders/Storage live in their own tabs, not on the pipeline board.
    let showTypes = { video: true, component: true, task: true, order: false, inventory: false };
    // Inventory tab filters
    let invType = '', invStatus = '';
    // Storage Room tab: 'storage' mirrors the real Storage room (read-only);
    // 'components' lists completed build components from finished projects.
    let invSubTab = 'storage';
    let invSearch = '';
    let _storageSyncKicked = false;

    const escHtml = HtmlUtils.escHtml;
    const escAttr = HtmlUtils.escAttr;
    const PS = () => PipelineStages;
    const SVC = () => PipelineService;

    const COMPONENT_STATUSES = ['design', 'cad', 'software', 'manufacturing', 'assembly', 'done'];
    // A component has a SOURCE/type that decides how it flows the pipeline:
    //   build — made in-house: runs the build chain (design research → cad → … → assembly).
    //   order — bought: skips Design Research, sits at Ordering until it arrives.
    //   task  — an errand (neither built nor bought, just done): skips Design Research,
    //           sits at Props / Set Design until handled.
    // Each source has its own status track; 'done' (always last) drops it off the board.
    const COMPONENT_SOURCE_STATUSES = {
        build: ['design', 'cad', 'software', 'manufacturing', 'assembly', 'done'],
        order: ['needed', 'ordered', 'done'],
        task:  ['todo', 'doing', 'done']
    };
    const COMPONENT_SOURCES = [
        { key: 'build', label: 'Build in-house', icon: 'assembly',   hint: 'runs the build chain from Design Research' },
        { key: 'order', label: 'Order it',       icon: 'order',      hint: 'skips Design Research → straight to Ordering' },
        { key: 'task',  label: 'Task / errand',  icon: 'propdesign', hint: 'not built or bought — just done → Props / Set Design' }
    ];
    const statusesForSource = (source) => COMPONENT_SOURCE_STATUSES[source] || COMPONENT_SOURCE_STATUSES.build;
    // Default starting status for a freshly-typed component.
    const defaultStatusForSource = (source) => statusesForSource(source)[0];

    // A build component only flows through the stages it actually NEEDS — pick
    // them in "What it needs" and the rest are skipped (finish CAD and it jumps
    // straight to Assembly if it needs no Software). Each build stage maps to
    // its need-flag(s); a component with NONE of these selected falls back to
    // the full chain (the historical default, so untyped components are
    // unchanged). Editable at any time — toggling needs re-routes the flow live.
    const BUILD_STAGE_CHAIN = [
        { status: 'design',        needs: ['design'] },
        { status: 'cad',           needs: ['cad', 'pcb'] },
        { status: 'software',      needs: ['software'] },
        { status: 'manufacturing', needs: ['precision'] },
        { status: 'assembly',      needs: ['assembly'] }
    ];
    function buildTrackFor(needs) {
        const have = new Set(Array.isArray(needs) ? needs : []);
        const picked = BUILD_STAGE_CHAIN.filter(s => s.needs.some(n => have.has(n)));
        const chosen = picked.length ? picked : BUILD_STAGE_CHAIN;  // none picked → full chain
        return [...chosen.map(s => s.status), 'done'];
    }
    // The ordered statuses a component moves through. order/task keep their
    // fixed tracks; build uses only the needed stages.
    function componentTrack(c) {
        if (!c) return COMPONENT_SOURCE_STATUSES.build;
        if (c.source === 'order') return COMPONENT_SOURCE_STATUSES.order;
        if (c.source === 'task') return COMPONENT_SOURCE_STATUSES.task;
        return buildTrackFor(c.needs);
    }
    const defaultStatusFor = (c) => componentTrack(c)[0];
    // Next status after the component's current one. For build it's computed
    // against the full canonical order, so a removed mid-chain stage snaps
    // forward to the next stage the component still needs.
    function nextComponentStatus(c) {
        const track = componentTrack(c);
        if (!c || c.source !== 'build') {
            const i = track.indexOf(c ? c.status : null);
            return (i >= 0 && i < track.length - 1) ? track[i + 1] : 'done';
        }
        const canon = COMPONENT_SOURCE_STATUSES.build;
        const curIdx = canon.indexOf(c.status);
        return track.find(s => s !== 'done' && canon.indexOf(s) > curIdx) || 'done';
    }
    // Snap a build component onto a valid stage for its current needs: if its
    // status got filtered out, move to the next stage it still needs (or done
    // if it's already past everything that remains). Returns the new status.
    function normalizedComponentStatus(c) {
        if (!c || c.source !== 'build' || c.status === 'done') return c ? c.status : 'design';
        const track = componentTrack(c);
        if (track.includes(c.status)) return c.status;
        const canon = COMPONENT_SOURCE_STATUSES.build;
        const curIdx = canon.indexOf(c.status);
        return track.find(s => s !== 'done' && canon.indexOf(s) > curIdx) || 'done';
    }
    // Where a component sits on the pipeline board. Its SOURCE decides the lane:
    // orders → Ordering, tasks → Props / Set Design, builds → by their build status.
    function componentStageId(c) {
        if (!c || c.status === 'done') return null;
        if (c.source === 'order') return 'order';
        if (c.source === 'task') return 'propdesign';
        return COMPONENT_STAGE_MAP[c.status] || 'design';
    }
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

    // "No decomposition needed" — for videos built from footage/props you already
    // have. Marks Decomposition done and skips the whole build chain it gates
    // (planning → procurement → build) so the video jumps straight to Filming.
    // Hook stages (hook/animation/hookfilm) are left alone — they're driven by
    // the hook types, not by decomposition.
    const DECOMP_SKIP_STAGES = ['design', 'propdesign', 'cad', 'pcb', 'order', 'precision', 'software', 'assembly', 'artistic'];
    function isDecompSkipped(v) {
        return !!(v && v.noDecomp);
    }
    async function setDecompSkip(videoId, skip) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        const stageState = { ...(v.stageState || {}) };
        if (skip) {
            stageState.decomp = 'done';
            DECOMP_SKIP_STAGES.forEach(s => { stageState[s] = 'na'; });
        } else {
            // Restore: drop the overrides we added so auto/branch behavior returns
            if (stageState.decomp === 'done') delete stageState.decomp;
            DECOMP_SKIP_STAGES.forEach(s => { if (stageState[s] === 'na') delete stageState[s]; });
        }
        await VideoService.update(videoId, { stageState, noDecomp: !!skip });
        toast(skip ? '⏭ Skipped the build chain — jumped to Filming' : 'Decomposition re-enabled');
        rerenderEditor(videoId);
    }

    // Context for deterministic auto-checks (e.g. Ordering completes when all
    // of a video's orders are received)
    function ctxNow() {
        return { orders: SVC().orders.getAll(), components: SVC().components.getAll() };
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
        const noDelete = (typeof window.canDelete === 'function') && !window.canDelete();
        container.innerHTML = `
            <div class="workshop-panel show-list${noDelete ? ' wsp-no-delete' : ''}">
                <div class="workshop-page workshop-list-page">
                    <div class="workshop-header">
                        <h2>Workshop</h2>
                        <span class="workshop-count" id="wsp-count"></span>
                        <button class="wsp-header-btn" id="wsp-find-btn" title="Semantic search — find any video, project or component by meaning">🔎 Find</button>
                        <button class="wsp-header-btn" id="wsp-queue-idea-btn" title="Queue an idea from the Library">📚 Queue Idea</button>
                        <button class="wsp-header-btn primary" id="wsp-new-video-btn">＋ New Video</button>
                    </div>
                    <!-- Workshop IS the pipeline now — Projects/Orders/Storage Room tabs removed. -->
                    <div class="wsp-tabs" style="display:none;">
                        <button class="wsp-tab active" data-tab="pipeline">Pipeline <span class="wsp-tab-count" data-tabcount="pipeline"></span></button>
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
                <div class="wsp-picker-overlay" id="wsp-search-overlay" style="display:none;">
                    <div class="wsp-picker wsp-search-modal">
                        <div class="wsp-picker-header">
                            <span>🔎 Find anything in the pipeline</span>
                            <button class="wsp-picker-close" id="wsp-search-close">✕</button>
                        </div>
                        <div class="wsp-search-bar">
                            <input type="search" id="wsp-search-input" class="wsp-search" placeholder="Describe what you're looking for — by meaning, not exact words…" autocomplete="off" style="flex:1;max-width:none;">
                        </div>
                        <div class="wsp-search-types" id="wsp-search-types">
                            <button class="wsp-pill active" data-stype="all">All</button>
                            <button class="wsp-pill" data-stype="video">🎬 Videos</button>
                            <button class="wsp-pill" data-stype="project">🛠️ Projects</button>
                            <button class="wsp-pill" data-stype="component">🧩 Components</button>
                        </div>
                        <div class="wsp-search-results" id="wsp-search-results"><div class="wsp-hint" style="padding:14px;">Type to search…</div></div>
                        <div class="wsp-search-foot"><button class="wsp-mini-btn" id="wsp-search-reindex">↻ Reindex</button> <span class="wsp-hint" id="wsp-search-status"></span></div>
                    </div>
                </div>
            </div>
        `;

        container.querySelectorAll('.wsp-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
        document.getElementById('wsp-queue-idea-btn').addEventListener('click', showIdeaPicker);
        document.getElementById('wsp-new-video-btn').addEventListener('click', newVideoDraft);
        // Creating a video enters the pipeline at Ideation — only offer it to
        // profiles that can write that entry stage.
        if (!stageWritable('ideate')) {
            ['wsp-queue-idea-btn', 'wsp-new-video-btn'].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = 'none'; });
        }
        document.getElementById('wsp-picker-close').addEventListener('click', hidePicker);
        document.getElementById('wsp-picker-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'wsp-picker-overlay') hidePicker();
        });
        // Semantic search — owner only (it spans every video/project/component).
        const findBtn = document.getElementById('wsp-find-btn');
        if (findBtn && !isOwnerUser()) findBtn.style.display = 'none';
        findBtn?.addEventListener('click', openSearch);
        document.getElementById('wsp-search-close')?.addEventListener('click', closeSearch);
        document.getElementById('wsp-search-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'wsp-search-overlay') closeSearch(); });
        let searchT = null;
        document.getElementById('wsp-search-input')?.addEventListener('input', (e) => {
            const q = e.target.value; clearTimeout(searchT); searchT = setTimeout(() => runPipelineSearch(q), 320);
        });
        document.getElementById('wsp-search-types')?.querySelectorAll('[data-stype]').forEach(b => b.addEventListener('click', () => {
            searchType = b.dataset.stype;
            document.querySelectorAll('#wsp-search-types [data-stype]').forEach(x => x.classList.toggle('active', x === b));
            runPipelineSearch(document.getElementById('wsp-search-input').value);
        }));
        document.getElementById('wsp-search-reindex')?.addEventListener('click', async () => {
            await ensurePipelineIndex(true);
            runPipelineSearch(document.getElementById('wsp-search-input').value);
        });
    }

    // ============ SEMANTIC SEARCH (videos / projects / components) ============
    function closeSearch() { const ov = document.getElementById('wsp-search-overlay'); if (ov) ov.style.display = 'none'; }
    function openSearch() {
        const ov = document.getElementById('wsp-search-overlay');
        if (!ov) return;
        ov.style.display = 'flex';
        const input = document.getElementById('wsp-search-input');
        if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
        const resEl = document.getElementById('wsp-search-results');
        if (resEl) resEl.innerHTML = '<div class="wsp-hint" style="padding:14px;">Type to search…</div>';
        ensurePipelineIndex(false);
    }
    // Build/refresh the Pinecone index once per session (or when forced).
    async function ensurePipelineIndex(force) {
        if (_pipelineIndexed && !force) return;
        const status = document.getElementById('wsp-search-status');
        if (status) status.textContent = force ? 'Reindexing…' : 'Preparing search…';
        try {
            const r = await fetch('/api/pipeline/index-embeddings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
            _pipelineIndexed = true;
            if (status) status.textContent = (d.indexed != null) ? `Indexed ${d.indexed} items` : 'Ready';
        } catch (e) { if (status) status.textContent = 'Index error: ' + e.message; }
    }
    async function runPipelineSearch(q) {
        const resEl = document.getElementById('wsp-search-results');
        if (!resEl) return;
        if (!q || !q.trim()) { resEl.innerHTML = '<div class="wsp-hint" style="padding:14px;">Type to search…</div>'; return; }
        resEl.innerHTML = '<div class="wsp-hint" style="padding:14px;">Searching…</div>';
        try {
            await ensurePipelineIndex(false);
            const r = await fetch('/api/pipeline/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, typeFilter: searchType }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
            const results = (d.results || []).filter(x => x.score == null || x.score > 0.18);
            if (!results.length) { resEl.innerHTML = '<div class="workshop-empty" style="padding:18px;">No matches. Try different words, or ↻ Reindex if you just added it.</div>'; return; }
            const TM = { video: { ic: '🎬', label: 'Video' }, project: { ic: '🛠️', label: 'Project' }, component: { ic: '🧩', label: 'Component' } };
            resEl.innerHTML = results.map(x => {
                const tm = TM[x.type] || { ic: '•', label: x.type };
                return `<div class="wsp-search-row" data-sid="${escAttr(x.id)}" data-stype2="${escAttr(x.type)}">
                    <span class="wsp-search-ic">${tm.ic}</span>
                    <span class="wsp-search-name">${escHtml(x.name || '(unnamed)')}${x.status ? ` <span class="wsp-hint">${escHtml(x.status)}</span>` : ''}</span>
                    <span class="wsp-search-type">${tm.label}</span>
                </div>`;
            }).join('');
            resEl.querySelectorAll('.wsp-search-row').forEach(row => row.addEventListener('click', () => navigateToResult(row.dataset.stype2, row.dataset.sid)));
        } catch (e) {
            resEl.innerHTML = `<div class="workshop-empty" style="padding:18px;">Search failed: ${escHtml(e.message)}</div>`;
        }
    }
    function navigateToResult(type, id) {
        closeSearch();
        if (type === 'video') openDetail(id);
        else if (type === 'component') openComponentDetail(id);
        else if (type === 'project') { selectedProjectId = id; switchTab('projects'); }
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
        // Restricted accounts: count only the videos they can actually see.
        const myVideos = filteredVideos().length;
        const el = document.getElementById('wsp-count');
        if (el) el.textContent = `${myVideos} in pipeline`;
        // Live counts on every tab so the numbers are visible without clicking in
        const counts = {
            pipeline: myVideos,
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
    // video = green, component = blue, task = orange (uniform across the board)
    const DOT_COLORS = { video: '#00b894', component: '#1565c0', task: '#e67e22', order: '#e8a020', inventory: '#8e44ad' };
    // Split a component bucket into real components vs task-type errands so each
    // gets its own colored count (blue / orange).
    const splitComps = (comps) => ({
        comps: (comps || []).filter(c => c.source !== 'task'),
        tasks: (comps || []).filter(c => c.source === 'task')
    });
    const GROUP_COLORS = { Concept: '#4a9eff', Planning: '#e8a020', Procurement: '#e67e22', Build: '#14b8a6', Production: '#e74c3c', Post: '#27ae60' };
    // Where a component's build status lives on the video pipeline
    const COMPONENT_STAGE_MAP = { design: 'design', cad: 'cad', software: 'software', manufacturing: 'precision', assembly: 'assembly' };

    function boardPositions() {
        // Column = topological layer, row = index within layer (centered vertically).
        // Keep only the stages this profile can see and drop now-empty layers, so the
        // board REBUILDS compactly around the accessible nodes — one node lands right
        // up front instead of being lost in a full-width chart.
        const layers = PS().LAYERS.map(l => l.filter(id => stageVisible(id))).filter(l => l.length);
        if (!layers.length) return { pos: {}, boardW: PAD * 2, boardH: 220 };
        const maxRows = Math.max(...layers.map(l => l.length), 1);
        const hasInv = !!pos_orderVisible();
        const invPad = hasInv ? 96 : 0; // only reserve the inventory row if Ordering is shown
        const boardH = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y + invPad;
        const pos = {};
        layers.forEach((ids, li) => {
            const x = PAD + li * (NODE_W + GAP_X);
            const totalH = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
            const y0 = (boardH - invPad - totalH) / 2 + PAD / 2;
            ids.forEach((id, ri) => {
                pos[id] = { x, y: y0 + ri * (NODE_H + GAP_Y) };
            });
        });
        const boardW = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X;
        // Component Library (Inventory) reference node sits under Ordering — only if shown
        if (pos['order']) pos['_inventory'] = { x: pos['order'].x, y: boardH - 80 };
        return { pos, boardW, boardH };
    }
    function pos_orderVisible() { return stageVisible('order'); }

    // --- Filters (apply to the whole board: dots, counts, stage panel) ---

    // A profile granted only some pipeline stages should see ONLY the videos
    // currently sitting at one of those stages — their responsibility, nothing
    // else. The owner (all stages visible) sees everything. When a video's
    // deliverable is met it leaves that stage's frontier and disappears here.
    function isStageScoped() {
        try { return PS().STAGES.some(s => !stageVisible(s.id)); } catch (e) { return false; }
    }
    // True only when the profile can see NO stage at all (misconfigured) — used to
    // show a friendly note instead of a blank board.
    function hasNoVisibleStage() {
        try { return !PS().STAGES.some(s => stageVisible(s.id)); } catch (e) { return false; }
    }
    // Walk a video's previous-video chain; true if it reaches targetId (loop guard).
    function videoChainIncludes(startId, targetId) {
        let cur = startId; const seen = new Set();
        while (cur && !seen.has(cur)) {
            if (cur === targetId) return true;
            seen.add(cur);
            const vv = VideoService.getById(cur);
            cur = vv && vv.previousVideoId;
        }
        return false;
    }
    // Order a video list so each video comes AFTER its previousVideoId (priority
    // sequence), otherwise preserving the incoming order. Cycle-safe.
    function orderByChain(list) {
        const byId = new Map(list.map(v => [v.id, v]));
        const done = new Set(); const out = [];
        const visit = (v, stack) => {
            if (done.has(v.id) || stack.has(v.id)) return;
            stack.add(v.id);
            const prev = v.previousVideoId && byId.get(v.previousVideoId);
            if (prev) visit(prev, stack);
            stack.delete(v.id);
            if (!done.has(v.id)) { done.add(v.id); out.push(v); }
        };
        list.forEach(v => visit(v, new Set()));
        return out;
    }
    function filteredVideos() {
        let list = pipelineVideos();
        try {
            if (isStageScoped()) {
                const ctx = ctxNow();
                list = list.filter(v => PS().frontier(v, ctx).some(id => stageVisible(id)));
            }
        } catch (e) { console.warn('Workshop: video scoping skipped', e); }
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
        // Soonest deadline first, then re-ordered so each video follows the one it's
        // sequenced after (previousVideoId) — priority sequence.
        const byDeadline = [...list].sort((a, b) => {
            const da = a.deadline || '9999', db = b.deadline || '9999';
            if (da !== db) return da < db ? -1 : 1;
            return (a.name || '').localeCompare(b.name || '');
        });
        return orderByChain(byDeadline);
    }

    function filteredComponents() {
        let list = SVC().components.getAll().filter(c => c.status !== 'done');
        // Restricted accounts only see components/tasks sitting at a stage (node)
        // they have access to — same scoping as videos.
        try { if (isStageScoped()) list = list.filter(c => { const sid = componentStageId(c); return sid && stageVisible(sid); }); }
        catch (e) { console.warn('Workshop: component scoping skipped', e); }
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
    // The build chain between Decomposition and Filming. Here the WORK is on the
    // components, not the video — so videos don't appear as their own rows; their
    // components do (wrapped by their video). Videos only show as rows in the
    // concept stages (before) and production/post stages (Filming onward).
    const BUILD_STAGES = new Set(['design', 'propdesign', 'cad', 'pcb', 'order', 'precision', 'software', 'assembly', 'artistic']);
    const stageOrderIndex = (id) => { const i = PS().STAGES.findIndex(s => s.id === id); return i < 0 ? 9999 : i; };
    function boardEntities() {
        const ctx = ctxNow();
        const byStage = {};
        PS().STAGES.forEach(s => { byStage[s.id] = { videos: [], components: [], orders: [], videoCount: 0 }; });
        // Tasks are source==='task' components but toggle/filter separately.
        filteredComponents().forEach(c => {
            const isTask = c.source === 'task';
            if (isTask ? !showTypes.task : !showTypes.component) return;
            const sid = componentStageId(c);
            if (sid && byStage[sid]) byStage[sid].components.push(c);
        });
        if (showTypes.video) {
            filteredVideos().forEach(v => {
                // Each node counts independently: a video is "in" every stage its
                // frontier currently sits at (parallel branches → counted in each).
                PS().frontier(v, ctx).forEach(id => {
                    if (!byStage[id]) return;
                    byStage[id].videoCount++;                                 // the green number
                    if (!BUILD_STAGES.has(id)) byStage[id].videos.push(v);    // rows only in non-build stages
                });
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
        if (!a || !b) return '';   // an endpoint isn't on the board (gated out)
        // Intermediate nodes = any positioned stage whose column sits strictly
        // between the two endpoints. Driven by the ACTUAL positions, not the full
        // layer list — restricted profiles hide stages, so the board is rebuilt
        // compactly and PS().LAYERS no longer matches pos (reading pos[id].y for a
        // hidden stage was undefined → "Cannot read properties of undefined").
        let minTop = Infinity, maxBottom = -Infinity;
        Object.keys(pos).forEach(id => {
            if (id === fromId || id === toId || id === '_inventory') return;
            const p = pos[id];
            if (p && p.x > a.x && p.x < b.x) {
                minTop = Math.min(minTop, p.y);
                maxBottom = Math.max(maxBottom, p.y + NODE_H);
            }
        });
        if (minTop === Infinity) return edgePath(a, b);  // adjacent columns / nothing between
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
        const allC = filteredComponents();
        const legendCounts = {
            video: filteredVideos().length,
            component: allC.filter(c => c.source !== 'task').length,
            task: allC.filter(c => c.source === 'task').length,
            order: filteredOrders().length,
            inventory: filteredInventory().length
        };
        const legend = [
            ['video', 'video', 'Videos'], ['component', 'component', 'Components'], ['task', 'propdesign', 'Tasks']
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
        // Misconfigured profile (Workshop granted but no stage assigned) → a clear
        // note instead of a blank board.
        if (hasNoVisibleStage()) {
            el.innerHTML = `<div class="workshop-empty" style="padding:40px 20px;">
                You don't have any pipeline stages assigned yet.<br>
                <span class="wsp-hint">Ask the owner to grant you a stage in your profile (People &amp; permissions → Pipeline stages).</span>
            </div>`;
            return;
        }
        // A worker scoped to a single writable node lands straight on that node's
        // panel (where the per-instance Done buttons live), not the all-items
        // overview. One-time, so they can still click back to the board.
        if (!_scopedStagePicked) {
            _scopedStagePicked = true;
            if (selectedStageId === null && !(window.__access && window.__access.all)) {
                const writ = PS().STAGES.filter(s => stageWritable(s.id) && stageVisible(s.id));
                if (writ.length === 1) selectedStageId = writ[0].id;
            }
        }
        const { pos, boardW, boardH } = boardPositions();
        const entities = boardEntities();

        const edgesSvg =
        `<defs>
            <marker id="wspArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#b3a98f"/>
            </marker>
        </defs>` +
        PS().EDGES.filter(([f, t]) => stageVisible(f) && stageVisible(t)).map(([f, t]) => {
            return `<path d="${edgePathSmart(f, t, pos)}" class="wsp-edge" marker-end="url(#wspArrow)" />`;
        }).join('') +
        // dashed reference edge to the Storage Room node (only when shown + Ordering visible)
        (showTypes.inventory && pos['order'] && pos['_inventory'] ? `<path d="M ${pos['order'].x + NODE_W / 2} ${pos['order'].y + NODE_H} L ${pos['_inventory'].x + NODE_W / 2} ${pos['_inventory'].y}" class="wsp-edge ref" />` : '');

        const nodesHtml = PS().STAGES.filter(s => stageVisible(s.id)).map(s => {
            const p = pos[s.id];
            const e = entities[s.id];
            const { comps: compsHere, tasks: tasksHere } = splitComps(e.components);
            // GREEN = videos positioned here (counted once at their frontmost stage,
            // so green across all nodes sums to the total video count).
            const vidN = e.videoCount || 0;
            const total = vidN + e.components.length + e.orders.length;
            const blockedHere = e.videos.filter(v => videoBlockers(v).length > 0).length;
            // Separate colored count per type so it's readable at a glance:
            // green = videos, blue = components, orange = tasks, gold = orders.
            const cornerCounts = [
                vidN ? `<span class="wsp-node-count vid" title="${vidN} video${vidN === 1 ? '' : 's'} in this stage">${vidN}</span>` : '',
                compsHere.length ? `<span class="wsp-node-count comp" title="${compsHere.length} component${compsHere.length === 1 ? '' : 's'}">${compsHere.length}</span>` : '',
                tasksHere.length ? `<span class="wsp-node-count task" title="${tasksHere.length} task${tasksHere.length === 1 ? '' : 's'}">${tasksHere.length}</span>` : '',
                e.orders.length ? `<span class="wsp-node-count ord" title="${e.orders.length} order${e.orders.length === 1 ? '' : 's'}">${e.orders.length}</span>` : ''
            ].join('');
            // Same breakdown, dot form, shown inline in the node subtitle
            const counts = [
                vidN ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.video}"></i>${vidN}</span>` : '',
                compsHere.length ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.component}"></i>${compsHere.length}</span>` : '',
                tasksHere.length ? `<span class="wsp-nc"><i style="background:${DOT_COLORS.task}"></i>${tasksHere.length}</span>` : '',
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
                ${total ? `<div class="wsp-node-counts-corner">${cornerCounts}</div>` : ''}
                ${blockedHere ? `<span class="wsp-node-blocked" title="${blockedHere} blocked here">🔒</span>` : ''}
            </div>`;
        }).join('');

        // Component Library (Storage Room) node — only on the board when toggled
        // on AND it has a slot, which exists only when the Ordering stage is
        // visible (it's anchored under Ordering). Profiles that can't see
        // Ordering have no _inventory position — guard or this throws and the
        // whole pipeline gets stuck on "Loading…".
        let invNode = '';
        if (showTypes.inventory && pos['_inventory']) {
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
    // Exactly what each stage's worker must DELIVER to push the video forward.
    // The deliverable is shown plainly on every video so it's unambiguous.
    const STAGE_DELIVERABLE = {
        ideate: 'Queued from the Library', hook: 'At least one hook — a LINE + a TYPE (animation/practical)',
        script: 'A written script (100+ characters)', animation: 'The animation hook video uploaded',
        decomp: 'Decide each branch + add ≥1 component (or mark “No decomposition needed”)',
        design: 'Design research — upload your notes / reference files', propdesign: 'A prop & set plan — upload it',
        cad: 'A CAD file for every component that needs one', pcb: 'A PCB file for every component that needs one',
        order: 'Every order received', precision: '3D-printed / machined parts — upload a photo',
        software: 'Code / firmware done — upload the build or a screenshot', assembly: 'The build assembled — upload a photo',
        artistic: 'Painted / finished — upload a result photo', hookfilm: 'The practical hook filmed & uploaded',
        film: 'Filming done (no upload — footage lives in Dropbox)', voiceover: 'A voiceover file linked',
        edit: 'All THREE final video versions uploaded', splittest: 'Thumbnail / title variants — upload them',
        post: 'Publish the video'
    };
    // How a stage gets completed: 'decomp' (validation gate), 'post' (publish),
    // 'result' (upload a result file → auto-advance), or 'auto' (a structured
    // artifact handled by the editor's own upload UI → auto-advance). NONE of
    // them is a bare "Done" — completion always requires the deliverable.
    function deliverableKind(stageId) {
        if (stageId === 'decomp') return 'decomp';
        if (stageId === 'post') return 'post';
        if (PS().hasNoDeliverable && PS().hasNoDeliverable(stageId)) return 'manual';
        if (PS().isResultStage(stageId)) return 'result';
        return 'auto';
    }
    function stageResultsFor(v, stageId) {
        return (v.stageResults && Array.isArray(v.stageResults[stageId])) ? v.stageResults[stageId] : [];
    }

    function stageVideoRowHtml(v, stage) {
        const dl = deadlineInfo(v);
        const expanded = expandedStageVideoId === v.id;
        const openOrders = SVC().ordersForVideo(v.id).filter(o => o.status !== 'received').length;
        const sp = sponsorName(v.sponsorId);
        // "Ready to advance": the stage's deliverable/asset is already present but
        // the worker hasn't pressed Done yet — highlight the whole row green so it
        // stands out while scrolling a stage. (Done is still required to move it.)
        const ready = !!(stage && nodeDeliverableStatus(v, stage.id).met);
        let actions = '';
        if (stage) {
            const kind = deliverableKind(stage.id);
            if (kind === 'decomp') {
                // The video's build branches are derived from its components' needs
                // (no separate "decide branches" step). Just need ≥1 component, or
                // "no decomposition needed".
                if (!(componentsForVideo(v.id).length || v.noDecomp)) actions = `<span class="wsp-deliv-chip pending" title="Break the video into at least one component, or mark “No decomposition needed”">＋ add a component ↓</span>`;
                else actions = `<button class="wsp-mini-btn done" data-done="${v.id}" title="Done">✓ Done</button>`;
            } else if (kind === 'post') {
                actions = `<button class="wsp-mini-btn done" data-publish="${v.id}" title="Done">✓ Done</button>`;
            } else {
                // EVERY other node gets a manual DONE button right on the row — the
                // worker uploads/does the deliverable, then presses Done. It's
                // deliverable-gated: if nothing's there yet it tells them what's
                // missing instead of advancing (the bottleneck check).
                actions = `<button class="wsp-mini-btn done" data-node-done="${v.id}" data-node-stage="${stage.id}" title="Done">✓ Done</button>`;
            }
        }
        return `<div class="wsp-stage-video${expanded ? ' expanded' : ''}${ready ? ' wsp-ready' : ''}" data-id="${v.id}">
            <div class="wsp-stage-video-head" data-expand="${v.id}">
                <span class="wsp-caret">${expanded ? '▾' : '▸'}</span>
                <div class="wsp-stage-video-main">
                    <div class="wsp-stage-video-name">${flagOrDot(v.project)} ${escHtml(v.name)} ${blockedBadge(v)}${ready ? '<span class="wsp-ready-badge">✓ ready — press Done</span>' : ''}</div>
                    <div class="wsp-stage-video-meta">
                        ${!stage ? frontierChips(v, 3) : `<span class="wsp-deliv-need" title="What needs to be finished">📋 ${escHtml(STAGE_DELIVERABLE[stage.id] || stage.label)}</span>`}
                        ${(() => { if (!v.previousVideoId) return ''; const p = VideoService.getById(v.previousVideoId); if (!p) return ''; const posted = isVideoPosted(p); return `<span class="wsp-after-chip${posted ? ' clear' : ''}" title="Priority sequence — ${posted ? 'its previous video is done' : 'do its previous video first'}">▶ after ${escHtml(p.name)}${posted ? ' ✓' : ''}</span>`; })()}
                        ${dl ? `<span class="wsp-deadline ${dl.cls}">⏰ ${dl.label}</span>` : ''}
                        ${stage && stage.id === 'order' && openOrders ? `<span class="wsp-deadline soon">📦 ${openOrders} order${openOrders === 1 ? '' : 's'} open</span>` : ''}
                        ${sp ? `<span class="wsp-sponsor-chip">💰 ${escHtml(sp)}</span>` : ''}
                    </div>
                </div>
                <div class="wsp-stage-video-actions">${actions}</div>
            </div>
            ${expanded ? stageVideoBodyHtml(v, stage) : ''}
        </div>`;
    }

    // The drop-down IS the full editor — same fields as the detail page, in
    // pipeline order. A clear DELIVERABLE banner sits on top; result-upload
    // stages get their uploader right there.
    function stageVideoBodyHtml(v, stage) {
        const delivBlock = stage ? deliverableBlockHtml(v, stage) : '';
        // Every node gets a DONE button to manually mark the stage finished. It's
        // deliverable-gated: if the node's deliverable isn't met it prompts the
        // worker to finish it instead of advancing.
        const doneBtn = (stage && stage.id !== 'post')
            ? `<button class="workshop-action-btn post-btn" data-node-done="${v.id}" data-node-stage="${stage.id}">✓ Done</button>`
            : (stage && stage.id === 'post' ? `<button class="workshop-action-btn post-btn" data-publish="${v.id}">✓ Done</button>` : '');
        return `<div class="wsp-stage-video-body">
            ${delivBlock}
            <div class="workshop-detail-fields wsp-inline-editor">${detailFieldsHtml(v)}</div>
            <div class="wsp-svb-actions">
                ${doneBtn}
                <button class="workshop-action-btn danger-btn" data-inline-delete="${v.id}">Delete</button>
            </div>
        </div>`;
    }

    // Is the node's deliverable satisfied? → { met, label }. Branch-skipped nodes
    // pass automatically. Used by the per-node DONE button.
    function nodeDeliverableStatus(v, stageId) {
        const label = STAGE_DELIVERABLE[stageId] || 'this stage';
        const st = PS().effectiveState(v, stageId, ctxNow());
        if (st === 'na' || st === 'done') return { met: true, label };
        if (stageId === 'decomp') return { met: (componentsForVideo(v.id).length > 0 || v.noDecomp), label };
        // every other stage: met when its deliverable (the artifact/result) is present
        return { met: PS().deliverableMet(v, stageId, ctxNow()), label };
    }

    // Which pipeline stage "owns" each editor section, so a section can show its
    // done/not-done colour (red until done, calm green once done).
    const SECTION_STAGE = { context: 'ideate', hook: 'hook', script: 'script', decomp: 'decomp', voiceover: 'voiceover', editing: 'edit' };
    // Status colour class for an editor section: 'is-todo' (red) until its
    // deliverable is met, 'is-done' (green, recedes) once it is. Skipped/'na'
    // or non-deliverable sections stay neutral.
    function sectionStatusClass(v, vfield) {
        const st = SECTION_STAGE[vfield];
        if (!st) return '';
        if (PS().effectiveState(v, st, ctxNow()) === 'na') return '';
        return nodeDeliverableStatus(v, st).met ? 'is-done' : 'is-todo';
    }

    // The Channel Project gate for an upload area:
    //   • a project is set → nothing (uploads show)
    //   • "No project" deliberately chosen → a calm note (not an error)
    //   • genuinely undecided → the nudge to pick one
    function projectGate(v, nudge) {
        if (v.project) return '';
        if (v.noProject) return `<div class="wsp-noproj-note">🚫 No project — this video isn't tied to a channel folder, so there's nothing to upload here. Pick a Channel Project above if it needs one.</div>`;
        return `<div class="wsp-blockers-box"><div class="wsp-blocker-line">${icon('lock', 'wsp-row-ic')} ${nudge}</div></div>`;
    }

    // The DONE button: advance the node if its deliverable is met, else prompt.
    async function pushNodeForward(videoId, stageId) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        if (stageId === 'decomp') { completeDecomp(videoId); return; }
        const { met, label } = nodeDeliverableStatus(v, stageId);
        if (!met) { alert(`Before this can move forward, finish the deliverable:\n\n• ${label}`); return; }
        const ss = { ...(v.stageState || {}), [stageId]: 'done' };
        await VideoService.update(videoId, { stageState: ss, status: normalizedStatus(v) });
        if (expandedStageVideoId === videoId) expandedStageVideoId = null;
        toast('✓ Done');
        renderTab();
    }

    // The deliverable banner shown at the top of an expanded stage row.
    function deliverableBlockHtml(v, stage) {
        const kind = deliverableKind(stage.id);
        const label = STAGE_DELIVERABLE[stage.id] || stage.label;
        // Red while the deliverable isn't met, calm green once it is.
        const stateCls = nodeDeliverableStatus(v, stage.id).met ? 'is-done' : 'is-todo';
        const flag = '<span class="wsp-deliv-flag"></span>';
        if (kind === 'result') {
            const results = stageResultsFor(v, stage.id);
            const canUpload = !!v.project;
            return `<div class="wsp-deliv-banner ${stateCls}" data-deliv-stage="${stage.id}">
                <div class="wsp-deliv-title">📋 Deliverable — <b>${escHtml(label)}</b>${flag}</div>
                <div class="wsp-deliv-sub">Upload as many files as you need — nothing moves until you press <b>Done</b> at the bottom.</div>
                <div id="wsp-deliv-list">${results.map((r, i) => `<div class="wsp-row"><span class="wsp-row-name">${icon('film', 'wsp-row-ic')} ${escHtml(r.name || (r.path || '').split('/').pop())}</span><button class="wsp-mini-btn" data-deliv-preview="${i}">▶ Preview</button><button class="wsp-mini-btn danger" data-deliv-del="${i}">✕</button></div>`).join('')}</div>
                ${canUpload
                    ? `<div class="wsp-add-row"><input type="file" id="wsp-deliv-file" multiple style="font-size:11.5px;flex:1 1 160px;"><button class="wsp-mini-btn done" id="wsp-deliv-up">⬆ Upload files</button></div>`
                    : projectGate(v, 'Select a Channel Project (below) first — results go to that project\'s Dropbox folder.')}
            </div>`;
        }
        if (kind === 'post') {
            return `<div class="wsp-deliv-banner ${stateCls}"><div class="wsp-deliv-title">📋 Deliverable — <b>${escHtml(label)}</b>${flag}</div>
                <div class="wsp-deliv-sub">Hit Publish when it's live; the video hatches into the Pen.</div></div>`;
        }
        if (kind === 'decomp') {
            return `<div class="wsp-deliv-banner ${stateCls}"><div class="wsp-deliv-title">📋 Deliverable — <b>${escHtml(label)}</b>${flag}</div>
                <div class="wsp-deliv-sub">Decide the branches and add components in the Decomposition section below.</div></div>`;
        }
        if (kind === 'manual') {
            const gaps = Array.isArray(v.footageGaps) ? v.footageGaps : [];
            const rep = v.footageReport || null;
            const canCheck = !!v.project;
            const repLine = rep
                ? (rep.status === 'error'
                    ? `<div class="wsp-hint" style="color:#e74c3c">Last footage check failed: ${escHtml(rep.error || 'error')}</div>`
                    : `<div class="wsp-hint">Checked ${escHtml(new Date(rep.generatedAt).toLocaleString())} · ${rep.clipsAnalyzed} clip${rep.clipsAnalyzed === 1 ? '' : 's'} (${rep.fromCache || 0} cached) · ${rep.coveredCount || 0} covered · ${rep.gapsCount || 0} gap${rep.gapsCount === 1 ? '' : 's'}</div>`)
                : '';
            const gapsHtml = gaps.length
                ? `<div class="wsp-footage-gaps">${gaps.map(g => `
                    <div class="wsp-footage-gap">
                        <div class="wsp-footage-gap-main">
                            <div class="wsp-footage-gap-beat">⚠️ ${escHtml(g.beat)}</div>
                            ${g.scriptQuote ? `<div class="wsp-footage-gap-quote">“${escHtml(g.scriptQuote)}”</div>` : ''}
                            ${g.note ? `<div class="wsp-footage-gap-note">${escHtml(g.note)}</div>` : ''}
                        </div>
                        <button class="wsp-mini-btn danger" data-footage-del="${escAttr(g.id)}" data-fv="${escAttr(v.id)}" title="Delete this suggestion">✕</button>
                    </div>`).join('')}</div>`
                : (rep && rep.status === 'done' ? `<div class="wsp-hint" style="color:#27ae60">✅ No footage gaps found — every script beat looks covered.</div>` : '');
            return `<div class="wsp-deliv-banner ${stateCls}"><div class="wsp-deliv-title">📋 ${escHtml(label)}${flag}</div>
                <div class="wsp-deliv-sub">No upload needed — your footage already lives in Dropbox. Just press <b>Done</b> once filming is complete.</div>
                <div class="wsp-footage-tools">
                    ${canCheck
                        ? `<button class="wsp-mini-btn wsp-ai-btn${footageScans[v.id] ? ' is-scanning' : ''}" data-footage-check="${escAttr(v.id)}">${footageScans[v.id] ? '🔍 Scanning… · click to view progress' : `🔍 ${(gaps.length || (rep && rep.status === 'done')) ? 'Re-check footage coverage' : 'Check footage coverage'}`}</button>`
                        : `<span class="wsp-hint">Link a Channel Project to scan its footage.</span>`}
                    <span class="wsp-hint">Optional — watches every clip in Dropbox &amp; flags script beats with no footage. Runs server-side; you can leave the page.</span>
                </div>
                ${repLine}
                ${gapsHtml}
            </div>`;
        }
        // auto stages — the structured upload lives in a section below
        return `<div class="wsp-deliv-banner ${stateCls}"><div class="wsp-deliv-title">📋 Deliverable — <b>${escHtml(label)}</b>${flag}</div>
            <div class="wsp-deliv-sub">Complete it in the section below, then press <b>Done</b> at the bottom to move it forward.</div></div>`;
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
        panel.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', () => completeDecomp(b.dataset.done)));
        panel.querySelectorAll('[data-publish]').forEach(b => b.addEventListener('click', () => postVideoAction(VideoService.getById(b.dataset.publish))));
        // The per-node DONE button lives on every stage row (and in the expanded
        // editor) — bind them all here so a collapsed row's Done works too.
        panel.querySelectorAll('[data-node-done]').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); pushNodeForward(b.dataset.nodeDone, b.dataset.nodeStage); }));
        // Filming footage-coverage tool — run a scan, or delete a gap suggestion.
        panel.querySelectorAll('[data-footage-check]').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); footageCheckClick(b.dataset.footageCheck, b); }));
        panel.querySelectorAll('[data-footage-del]').forEach(b => b.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const v = VideoService.getById(b.dataset.fv);
            if (!v) return;
            const removed = (v.footageGaps || []).find(g => g.id === b.dataset.footageDel);
            const gaps = (v.footageGaps || []).filter(g => g.id !== b.dataset.footageDel);
            const dismissed = Array.isArray(v.footageGapsDismissed) ? v.footageGapsDismissed.slice() : [];
            if (removed && removed.beat && !dismissed.includes(removed.beat)) dismissed.push(removed.beat);   // stays gone on re-check
            await VideoService.update(b.dataset.fv, { footageGaps: gaps, footageGapsDismissed: dismissed });
            renderTab();
        }));
        bindCompStatusRows(panel, () => renderTab());
        bindOrderRows(panel);

        // An expanded row holds the full editor — wire it up
        if (expandedStageVideoId) {
            const ev = VideoService.getById(expandedStageVideoId);
            if (ev && panel.querySelector(`.wsp-stage-video[data-id="${expandedStageVideoId}"] #workshop-name`)) {
                bindDetailFields(ev);
                initMediaSection(ev, 'vo');
                initMediaSection(ev, 'music');   // optional music link/file — not tied to a stage
                initEditSlots(ev);   // Editing — three final-video upload slots (was detail-page only)
                if (selectedStageId && PS().isResultStage(selectedStageId)) initStageResultUploader(ev, selectedStageId, panel);
                panel.querySelectorAll('[data-inline-delete]').forEach(b => b.addEventListener('click', () => deleteVideoAction(VideoService.getById(expandedStageVideoId))));
                // [data-node-done] is bound once for the whole panel above (covers
                // both the collapsed row button and this expanded-editor one).
            }
        }
    }

    // Complete Decomposition — gated on the deliverable: ≥1 component (whose own
    // needs drive which build branches the video flows through) or the "No
    // decomposition" skip. No separate branch decision any more.
    async function completeDecomp(videoId) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        if (!(componentsForVideo(videoId).length || v.noDecomp)) { alert('Add at least one component, or use “No decomposition needed”, before completing Decomposition.'); return; }
        const ss = { ...(v.stageState || {}), decomp: 'done' };
        await VideoService.update(videoId, { stageState: ss, status: normalizedStatus(v) });
        toast('Decomposition complete — moving forward');
        renderTab();
    }

    // Result-deliverable uploader for "do the work, upload your result" stages.
    // Uploading ≥1 file completes the stage (auto-check) → the video advances and
    // drops off this queue on the next render.
    async function initStageResultUploader(v, stageId, scope) {
        const banner = scope.querySelector('[data-deliv-stage]');
        if (!banner) return;
        const fileInput = banner.querySelector('#wsp-deliv-file');
        const upBtn = banner.querySelector('#wsp-deliv-up');
        banner.querySelectorAll('[data-deliv-preview]').forEach(b => b.addEventListener('click', () => {
            const r = stageResultsFor(VideoService.getById(v.id) || v, stageId)[Number(b.dataset.delivPreview)];
            if (r && r.path) openFilePreview(r.path, r.name);
        }));
        banner.querySelectorAll('[data-deliv-del]').forEach(b => b.addEventListener('click', async () => {
            const fresh = VideoService.getById(v.id) || v;
            const arr = stageResultsFor(fresh, stageId).filter((_, i) => i !== Number(b.dataset.delivDel));
            const sr = { ...(fresh.stageResults || {}), [stageId]: arr };
            await VideoService.update(v.id, { stageResults: sr, status: normalizedStatus(fresh) });
            renderTab();
        }));
        if (!upBtn || !fileInput) return;
        upBtn.addEventListener('click', async () => {
            const files = fileInput.files ? [...fileInput.files] : [];
            if (!files.length) { alert('Choose a file first.'); return; }
            const fresh = VideoService.getById(v.id) || v;
            if (!fresh.project) { alert('Select a Channel Project first.'); return; }
            const root = await dropboxRootPath();
            const folder = `${root}/${fresh.project}/${stageId}`;
            const host = upBtn.parentElement;
            const bar = uploadProgressBar(host, files[0].name);
            try {
                const added = [];
                for (const file of files) { const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress); added.push({ path: meta.path_display || meta.path_lower, name: meta.name || file.name }); }
                const cur = stageResultsFor(VideoService.getById(v.id) || fresh, stageId);
                const sr = { ...((VideoService.getById(v.id) || fresh).stageResults || {}), [stageId]: [...cur, ...added] };
                await VideoService.update(v.id, { stageResults: sr, status: normalizedStatus(fresh) });
                bar.stage(`Added ${added.length} file${added.length === 1 ? '' : 's'} ✓`);
                toast(`Uploaded ${added.length} file${added.length === 1 ? '' : 's'} — add more or press Done`);
                renderTab();   // stays on the node; the worker presses Done to move on
            } catch (e) { alert('Upload failed: ' + e.message); }
        });
    }

    // No stage selected → show EVERYTHING currently in flight (filter-driven)
    function renderAllPanel(panel) {
        const vids = showTypes.video ? filteredVideos() : [];
        const comps = showTypes.component ? filteredComponents().filter(c => c.source !== 'task') : [];
        const tasks = showTypes.task ? filteredComponents().filter(c => c.source === 'task') : [];
        const orders = showTypes.order ? filteredOrders() : [];
        const inv = showTypes.inventory ? filteredInventory() : [];
        const total = vids.length + comps.length + tasks.length + orders.length + inv.length;

        const breakdown = [
            showTypes.video ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">${icon('video', 'wsp-cc-ic')} ${vids.length}</span>` : '',
            showTypes.component ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">${icon('component', 'wsp-cc-ic')} ${comps.length}</span>` : '',
            showTypes.task ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.task}">${icon('propdesign', 'wsp-cc-ic')} ${tasks.length}</span>` : '',
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
                ${tasks.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.task}">${icon('propdesign', 'wsp-sec-ic')} Tasks / errands</div>${tasks.map(c => componentRowHtml(c)).join('')}` : ''}
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

    // Render components grouped under their video — "this component is for this
    // video". The component is the focus; the video header is just context.
    function componentsByVideoHtml(comps) {
        const groups = new Map();   // videoId -> [components], preserving first-seen order
        comps.forEach(c => { const k = c.videoId || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
        // Order wrappers by their video's name (stable, readable).
        const entries = [...groups.entries()].sort((a, b) => {
            const va = a[0] ? VideoService.getById(a[0]) : null, vb = b[0] ? VideoService.getById(b[0]) : null;
            return (va ? va.name : 'zzz').localeCompare(vb ? vb.name : 'zzz');
        });
        return entries.map(([vid, list]) => {
            const v = vid ? VideoService.getById(vid) : null;
            const head = v
                ? `<button class="wsp-clickable wsp-vidwrap-name" data-open="${v.id}" title="Open the video">${icon('video', 'wsp-row-ic')} ${escHtml(v.name)}</button>`
                : `${icon('video', 'wsp-row-ic')} <span class="wsp-vidwrap-name">Unassigned</span>`;
            return `<div class="wsp-vidwrap">
                <div class="wsp-vidwrap-head">${head} <span class="wsp-hint">${list.length} here</span></div>
                <div class="wsp-vidwrap-comps">${list.map(c => componentRowHtml(c, { advance: true })).join('')}</div>
            </div>`;
        }).join('');
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

        const { comps: stageComps, tasks: stageTasks } = splitComps(e.components);
        const isBuildStage = BUILD_STAGES.has(selectedStageId);
        const breakdown = [
            e.videos.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.video}">${icon('video', 'wsp-cc-ic')} ${e.videos.length}</span>` : '',
            stageComps.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.component}">${icon('component', 'wsp-cc-ic')} ${stageComps.length}</span>` : '',
            stageTasks.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.task}">${icon('propdesign', 'wsp-cc-ic')} ${stageTasks.length}</span>` : '',
            e.orders.length ? `<span class="wsp-count-chip" style="--dotcolor:${DOT_COLORS.order}">${icon('order', 'wsp-cc-ic')} ${e.orders.length}</span>` : ''
        ].join('');

        // In build stages, wrap components under their video (the emphasis is the
        // component; the video is shown only as what it's a part of). Elsewhere a
        // flat list is fine.
        const renderCompList = (list) => isBuildStage ? componentsByVideoHtml(list) : list.map(c => componentRowHtml(c, { advance: true })).join('');
        const compRows = stageComps.length ? renderCompList(stageComps) : '';
        const taskRows = stageTasks.length ? renderCompList(stageTasks) : '';

        panel.innerHTML = `
            <div class="wsp-stage-panel-header">
                <div class="wsp-stage-panel-headmain">
                    <div class="wsp-stage-panel-title">${icon(stage.id, 'wsp-title-ic')} ${escHtml(stage.label)} ${breakdown}</div>
                    <div class="wsp-stage-panel-desc">${escHtml(stage.desc || '')}</div>
                    ${autoDesc ? `<div class="wsp-auto-desc">⚡ ${escHtml(autoDesc)}</div>` : ''}
                </div>
                <div class="wsp-stage-panel-side">
                    <button class="wsp-picker-close" id="wsp-stage-panel-close">✕</button>
                </div>
            </div>
            <div class="wsp-stage-panel-list">
                ${e.videos.length === 0 && !compRows && !taskRows && e.orders.length === 0 ? '<div class="workshop-empty">Nothing at this stage (with current filters).</div>' : ''}
                ${e.videos.map(v => stageVideoRowHtml(v, stage)).join('')}
                ${compRows ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.component}">${icon('component', 'wsp-sec-ic')} Components being worked here</div>${compRows}` : ''}
                ${taskRows ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.task}">${icon('propdesign', 'wsp-sec-ic')} Tasks / errands</div>${taskRows}` : ''}
                ${e.orders.length ? `<div class="wsp-panel-section-title" style="color:${DOT_COLORS.order}">${icon('order', 'wsp-sec-ic')} Open orders</div>${e.orders.map(orderRowHtml).join('')}` : ''}
            </div>
        `;

        document.getElementById('wsp-stage-panel-close').addEventListener('click', () => {
            selectedStageId = null;
            expandedStageVideoId = null;
            renderTab();
        });
        // [data-done] (Complete Decomposition) + [data-publish] are bound in
        // bindPanelRows. No generic bare-"Done" any more — completion is the
        // deliverable.
        bindPanelRows(panel);
        // Read-only stage: you can view/expand everything but not change it. Disable
        // the write controls (done, status pills, moves) and keep navigation.
        if (!stageWritable(selectedStageId)) {
            panel.classList.add('wsp-readonly');
            panel.querySelectorAll('[data-done], [data-node-done], .wsp-pill, [data-comp-status], [data-order-status], [data-cd-status], [data-inv-status], [data-move], [data-advance]').forEach(el => {
                el.disabled = true; el.style.pointerEvents = 'none'; el.style.opacity = '0.55';
            });
        }
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
            const setup = await confirmComponentSetup({ title: 'Add component', name });
            if (!setup) return;
            await createVideoComponent(videoId, setup);
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
            if (alsoDone) {
                // Decomposition's deliverable is the breakdown — at least one component queued.
                if (componentsForVideo(videoId).length === 0) {
                    alert('Break the video down into at least one component before completing Decomposition. (Add components in the Decomposition section.)');
                    await VideoService.update(videoId, { branches, status: normalizedStatus(fresh) }); // save branch decisions, don't complete
                    return;
                }
                changes.stageState = { ...(fresh.stageState || {}), decomp: 'done' };
            }
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
                ${componentStageGraphic(c)}
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
            if (!canDeleteNow()) return blockDelete();
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

    // ============ TAB 5: STORAGE ROOM ============
    // Two sub-views, no parallel inventory CRUD any more:
    //   • Storage    — a READ-ONLY mirror of the real Storage Room (the same
    //                  boxes/items database the Storage building manages). Orders
    //                  flow into here automatically, so we never re-track them.
    //   • Components — completed build components (their build is done, or their
    //                  video is posted). Tasks/orders are excluded: a task is just
    //                  a means to buy something, and orders already live in Storage.

    const STORAGE_SVC = () => (typeof StorageService !== 'undefined' && StorageService) ? StorageService : null;

    function renderInventoryTab(el) {
        const SS = STORAGE_SVC();
        const storeCount = SS ? (SS.getItems() || []).length : 0;
        const compCount = completedComponents().length;
        el.innerHTML = `
            <div class="wsp-section-head">
                <button class="wsp-header-btn" id="wsp-inv-back">← Pipeline</button>
                <span class="wsp-section-title">Storage Room</span>
            </div>
            <div class="wsp-tabs">
                <button class="wsp-tab ${invSubTab === 'storage' ? 'active' : ''}" data-invsub="storage">📦 Storage <span class="wsp-tab-count">${storeCount}</span></button>
                <button class="wsp-tab ${invSubTab === 'components' ? 'active' : ''}" data-invsub="components">🧩 Components <span class="wsp-tab-count">${compCount}</span></button>
            </div>
            <div id="wsp-inv-sub"></div>
        `;
        el.querySelector('#wsp-inv-back').addEventListener('click', () => switchTab('pipeline'));
        el.querySelectorAll('[data-invsub]').forEach(b => b.addEventListener('click', () => { invSubTab = b.dataset.invsub; renderTab(); }));
        const body = el.querySelector('#wsp-inv-sub');
        if (invSubTab === 'components') renderCompletedComponents(body);
        else renderStorageMirror(body);
    }

    // Normalise for searching — lower-case, and singularise if the Storage
    // canonicaliser is around (so "helmets" finds "helmet").
    function normStorage(s) {
        s = (s || '').toLowerCase().trim();
        try { if (typeof StorageCanonicalize !== 'undefined' && StorageCanonicalize.normalizeToSingular) return StorageCanonicalize.normalizeToSingular(s) || s; } catch (e) {}
        return s;
    }

    // READ-ONLY mirror of the real Storage Room (boxes + items), with a quick
    // search up top: type what you need → see instantly if it's already in
    // storage (so you don't re-order it); if it's not, order it right here.
    function renderStorageMirror(body) {
        const SS = STORAGE_SVC();
        if (!SS) { body.innerHTML = '<div class="workshop-empty">The Storage Room isn\'t available right now.</div>'; return; }
        const boxes = SS.getBoxes() || [];
        const items = SS.getItems() || [];
        if (!boxes.length && !items.length) {
            body.innerHTML = '<div class="workshop-empty">Loading the Storage Room…</div>';
            // Storage may not have synced yet (its building hasn't been opened) —
            // pull once, then re-render if we're still on this view.
            if (!_storageSyncKicked && SS.sync) {
                _storageSyncKicked = true;
                SS.sync().then(() => { if (activeTab === 'inventory' && invSubTab === 'storage') renderTab(); }).catch(() => {});
            }
            return;
        }
        const totalQty = items.reduce((s, i) => s + (i.quantity || 1), 0);
        const boxNameById = {}; boxes.forEach(b => { boxNameById[b.id] = b.name; });
        const itemBox = (i) => (i.boxIds || []).map(id => boxNameById[id]).filter(Boolean)[0] || 'Unboxed';
        const itemLine = (i, withBox) => `<div class="wsp-row">
            <span class="wsp-row-name">${escHtml(i.name)}</span>
            ${withBox ? `<span class="wsp-hint">📦 ${escHtml(itemBox(i))}</span>` : ''}
            ${(i.quantity || 1) > 1 ? `<span class="wsp-hint">×${i.quantity}</span>` : ''}
        </div>`;

        body.innerHTML = `
            <div class="wsp-section-head">
                <span class="wsp-hint">Read-only mirror of the Storage Room — ${items.length} item${items.length === 1 ? '' : 's'} (${totalQty} total) across ${boxes.length} box${boxes.length === 1 ? '' : 'es'}. Add, move or remove items in the Storage Room itself.</span>
            </div>
            <div class="wsp-filterbar">
                <input type="search" id="wsp-storage-search" class="wsp-search" placeholder="🔍 Search storage — do we already have it?" value="${escAttr(invSearch)}" autocomplete="off" style="flex:1 1 auto;max-width:none;">
            </div>
            <div id="wsp-storage-results"></div>
        `;
        const results = body.querySelector('#wsp-storage-results');

        const paintBrowse = () => {
            const boxedIds = new Set();
            const boxHtml = boxes.map(b => {
                const bi = SS.getItemsByBox(b.id) || [];
                bi.forEach(i => boxedIds.add(i.id));
                return `<div class="wsp-storage-box">
                    <div class="wsp-storage-box-title">📦 ${escHtml(b.name)} <span class="wsp-stage-panel-count">${bi.length}</span></div>
                    ${bi.length ? bi.map(i => itemLine(i, false)).join('') : '<div class="wsp-hint">empty</div>'}
                </div>`;
            }).join('');
            const loose = items.filter(i => !boxedIds.has(i.id));
            const looseHtml = loose.length ? `<div class="wsp-storage-box">
                <div class="wsp-storage-box-title">🗃️ Unboxed <span class="wsp-stage-panel-count">${loose.length}</span></div>
                ${loose.map(i => itemLine(i, false)).join('')}
            </div>` : '';
            results.innerHTML = `<div class="wsp-storage-boxes">${boxHtml}${looseHtml}</div>`;
        };

        const paintSearch = (q) => {
            const nq = normStorage(q), lq = q.toLowerCase();
            const hits = items.filter(i => {
                const name = (i.name || '').toLowerCase();
                return name.includes(lq) || normStorage(i.name).includes(nq);
            }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            const orderBtn = `<button class="wsp-mini-btn done" id="wsp-storage-order">＋ Order "${escHtml(q.trim())}"</button>`;
            if (!hits.length) {
                results.innerHTML = `<div class="wsp-storage-noresult">
                    <div class="workshop-empty" style="padding:18px 8px 12px;">No “${escHtml(q.trim())}” in storage — you'll need to order it.</div>
                    <div class="wsp-add-row" style="justify-content:center;">${orderBtn}</div>
                </div>`;
            } else {
                results.innerHTML = `<div class="wsp-section-head"><span class="wsp-hint">✓ ${hits.length} match${hits.length === 1 ? '' : 'es'} already in storage — no need to order.</span></div>
                    <div class="wsp-storage-box" style="margin:0 14px;">${hits.map(i => itemLine(i, true)).join('')}</div>
                    <div class="wsp-add-row" style="justify-content:center;">${orderBtn}</div>`;
            }
            const ob = results.querySelector('#wsp-storage-order');
            if (ob) ob.addEventListener('click', async () => {
                const name = q.trim(); if (!name) return;
                ob.disabled = true; ob.textContent = 'Ordering…';
                try {
                    await SVC().orders.create({ name, link: '', cost: 0, qty: 1, status: 'needed', videoId: '', projectId: '', componentId: '', notes: 'From storage search' });
                    ob.textContent = '✓ Added to Ordering';
                    toast(`🛒 Ordered “${name}” → Ordering (Needed)`);
                } catch (e) { ob.disabled = false; ob.textContent = '＋ Order'; alert('Could not create the order: ' + e.message); }
            });
        };

        const repaint = () => { const q = invSearch.trim(); if (q) paintSearch(invSearch); else paintBrowse(); };
        repaint();
        const search = body.querySelector('#wsp-storage-search');
        search.addEventListener('input', (e) => { invSearch = e.target.value; repaint(); });
    }

    // Completed build components — finished parts we actually have. Done if the
    // build reached 'done' OR the linked video has been posted (so every past,
    // posted project's components count). Orders & tasks are excluded.
    function isVideoPosted(v) {
        return !!v && (v.status === 'posted' || v.status === 'pen' || (v.stageState && v.stageState.post === 'done'));
    }
    function completedComponents() {
        return SVC().components.getAll().filter(c => {
            if (c.source === 'order' || c.source === 'task') return false;   // not parts we track here
            if (c.status === 'done') return true;
            return isVideoPosted(c.videoId ? VideoService.getById(c.videoId) : null);
        });
    }
    function renderCompletedComponents(body) {
        const comps = completedComponents();
        if (!comps.length) {
            body.innerHTML = '<div class="workshop-empty">No completed components yet. A build component lands here once its build is done — or once the video it was built for is posted.</div>';
            return;
        }
        // Group by project (fall back to the source video, then "Unassigned").
        const groups = {};
        comps.forEach(c => {
            const proj = c.projectId ? SVC().projects.getById(c.projectId) : null;
            const vid = c.videoId ? VideoService.getById(c.videoId) : null;
            const key = proj ? `🛠️ ${proj.name}` : (vid ? `🎬 ${vid.name}` : '— Unassigned');
            (groups[key] = groups[key] || []).push({ c, vid });
        });
        body.innerHTML = `
            <div class="wsp-section-head">
                <span class="wsp-hint">Finished build components from your projects — ${comps.length} part${comps.length === 1 ? '' : 's'}. Click one to open it.</span>
            </div>
            ${Object.keys(groups).sort().map(k => `
                <div class="wsp-storage-box">
                    <div class="wsp-storage-box-title">${escHtml(k)} <span class="wsp-stage-panel-count">${groups[k].length}</span></div>
                    ${groups[k].map(({ c, vid }) => `<div class="wsp-row">
                        <button class="wsp-row-name wsp-clickable" data-open-comp="${c.id}" title="Open this component">${icon('component', 'wsp-row-ic')} ${escHtml(c.name)}</button>
                        ${vid && !c.projectId ? '' : (vid ? `<span class="wsp-hint">🎬 ${escHtml(vid.name)}</span>` : '')}
                        <span class="wsp-comp-tag build">done</span>
                    </div>`).join('')}
                </div>`).join('')}
        `;
        bindCompStatusRows(body, () => renderTab());
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
            // Create the backing Library idea FIRST, then the video linked to it,
            // so the Library indexes every pipeline video (single source of truth).
            // type 'converted' = an idea that's already in the pipeline (same as a
            // queued idea), so it shows in the Library and stays in sync.
            let sourceIdeaId = '';
            try {
                const idea = await NotesService.create({ name: name.trim(), type: 'converted', hook: '', context: '', script: '', project: '' });
                sourceIdeaId = (idea && idea.id) || '';
            } catch (e) { console.warn('Workshop: backing idea create failed (video still created)', e); }
            const video = await VideoService.create({ name: name.trim(), status: 'pipeline', stageState: {}, sourceIdeaId });
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
            `<div class="wsp-subsection-title">${icon(iconName, 'wsp-sub-ic')} <span class="wsp-sub-name">${title}</span>${hint ? ` <span class="wsp-hint">${hint}</span>` : ''}<span class="wsp-sec-state"></span></div>`;

        return `
            <div class="workshop-detail-summary" data-vfield="sourceidea">${sourceIdeaHtml}</div>

            ${blockers.length ? `<div class="wsp-blockers-box" data-vfield="waiting">
                <div class="wsp-blockers-title">${icon('lock', 'wsp-sub-ic')} Waiting on</div>
                ${blockers.map(b => `<div class="wsp-blocker-line">${icon(DEP_ICON_NAME[b.kind] || 'inventory', 'wsp-row-ic')} ${escHtml(b.label)} <span class="wsp-hint">${escHtml(b.detail)}</span></div>`).join('')}
            </div>` : ''}

            <div data-vfield="name">
                <label>Video Name <span class="wsp-save-status saved" id="wsp-save-status">Saved</span></label>
                <input type="text" id="workshop-name" value="${escAttr(v.name)}">
            </div>

            <div class="wsp-field-grid">
                <div data-vfield="deadline">
                    <label>Deadline <span class="wsp-hint">(optional)</span></label>
                    <input type="date" id="workshop-deadline" value="${escAttr(v.deadline || '')}">
                </div>
                <div data-vfield="sponsor">
                    <label>Sponsor</label>
                    <select id="workshop-sponsor">
                        <option value="">No sponsor</option>
                        ${sponsors.map(s => `<option value="${s.id}" ${v.sponsorId === s.id ? 'selected' : ''}>${escHtml(s.name)}</option>`).join('')}
                    </select>
                </div>
                <div data-vfield="project">
                    <label>Channel Project (egg)</label>
                    <select id="workshop-project">
                        <option value="" disabled ${!v.project && !v.noProject ? 'selected' : ''}>— Pick a project —</option>
                        <option value="__none__" ${v.noProject ? 'selected' : ''}>🚫 No project (deliberate)</option>
                        ${dropboxProjects.map(p => `<option value="${escAttr(p)}" ${p === v.project ? 'selected' : ''}>${escHtml(p)}</option>`).join('')}
                    </select>
                </div>
            </div>

            <div data-vfield="progress">
            <div class="wsp-progress-head">
                <label>Pipeline Progress</label>
                <div class="wsp-progress-head-actions">
                    ${isOwnerUser() ? `<select id="wsp-move-stage" class="wsp-inline-select" title="Owner only: move this video to any stage — everything before it is marked done, that stage and after reset to pending. Forces the move regardless of deliverables.">
                        <option value="">⇄ Move to stage…</option>
                        ${PS().STAGES.map(s => `<option value="${s.id}">${escHtml(s.label)}</option>`).join('')}
                    </select>` : ''}
                </div>
            </div>
            ${stageChecklistHtml(v)}
            </div>

            <div class="wsp-subsection ${sectionStatusClass(v, 'context')}" data-vfield="context" style="--accent:#a87d3c">
                ${subTitle('ideate', 'Context', '— speak or type ideation notes, angles, details')}
                <div class="wsp-field-with-mic">
                    <textarea id="workshop-context" placeholder="Describe what you want to build, the angles, the details…">${escHtml(v.context || '')}</textarea>
                    <button class="wsp-mic-btn" id="wsp-context-mic" title="Dictate — speak and it transcribes into Context">${icon('voiceover')}</button>
                </div>
            </div>

            <div class="wsp-subsection ${sectionStatusClass(v, 'hook')}" data-vfield="hook" style="--accent:#3d8bf0">
                ${subTitle('hook', 'Hook', '— write the hook and pick its type (animation / practical). Each is its own instance you can split-test; at least one (with a type) is needed before the video moves on. The Animation / Practical branches flip on automatically from the types.')}
                ${projectGate(v, 'Select a Channel Project first — hook footage lives in that project\'s hook/ folder in Dropbox.')}
                <div id="wsp-hook-instances">
                    ${PS().hooksOf(v).map((h, i) => hookInstanceRowHtml(v, h, i)).join('')}
                </div>
                <div class="wsp-add-row">
                    <button class="wsp-mini-btn done" id="wsp-add-hooki">＋ Add hook</button>
                    <button class="wsp-mini-btn wsp-ai-btn" id="wsp-ai-hooks" title="Let AI suggest hooks from the context + script, grounded in the channel's principles">✨ AI hooks</button>
                    ${PS().hooksOf(v).length === 0 ? '<span class="wsp-hint">none yet — write your first hook and pick its type</span>' : ''}
                </div>
                ${PS().hooksOf(v).some(h => h.type === 'animation') ? `
                <div class="wsp-anim-assets">
                    <div class="wsp-cd-label" style="margin-top:10px;">🎞️ Animation assets <span class="wsp-hint">— the 3D models / reference files the animator needs to build the animation</span></div>
                    <label class="wsp-anim-noassets"><input type="checkbox" id="wsp-anim-nomodels" ${v.animNoModels ? 'checked' : ''}> No 3D models / assets needed — the animator works from the hook + context alone</label>
                    <div id="wsp-anim-assets-body" style="${v.animNoModels ? 'display:none;' : ''}">
                        <div id="wsp-anim-asset-list">${(v.animAssets || []).map((a, i) => `<div class="wsp-row"><span class="wsp-row-name">${icon('cad', 'wsp-row-ic')} ${escHtml(a.name || (a.path || '').split('/').pop())}</span><button class="wsp-mini-btn" data-anim-asset-open="${i}">▶ Open</button><button class="wsp-mini-btn danger" data-anim-asset-del="${i}">✕</button></div>`).join('')}</div>
                        ${v.project
                            ? `<div class="wsp-add-row"><input type="file" id="wsp-anim-asset-file" multiple style="font-size:11.5px;flex:1 1 160px;"><button class="wsp-mini-btn done" id="wsp-anim-asset-up">⬆ Upload assets</button></div>`
                            : `<div class="wsp-hint">Select a Channel Project first — assets go to that project's animation/assets folder in Dropbox.</div>`}
                    </div>
                </div>` : ''}
            </div>

            <div class="wsp-subsection ${sectionStatusClass(v, 'script')}" data-vfield="script" style="--accent:#27ae72">
                ${subTitle('script', 'Script', '— fill it in and Script Writing completes itself')}
                ${window.EggRenderer ? window.EggRenderer.inlineScriptEditorHtml('workshop-inline-script', 'Script') : '<textarea id="workshop-script"></textarea>'}
            </div>

            <div class="wsp-subsection wsp-decomp-section ${sectionStatusClass(v, 'decomp')}${isDecompSkipped(v) ? ' skipped' : ''}" data-vfield="decomp" style="--accent:#e8a020">
                ${subTitle('decomp', 'Decomposition', '— break the build into components. Each becomes its own entity in the pipeline (its own stages &amp; needs) while staying linked to this video, which waits for it. Click a component to open it.')}
                <div class="wsp-prevvideo-block">
                    <div class="wsp-cd-label">Previous video <span class="wsp-hint">— optional causality: sequence this video after another one in the pipeline (it'll surface in that order). Posted videos aren't listed.</span></div>
                    <select id="workshop-prevvideo" class="wsp-inline-select" style="max-width:100%;">
                        <option value="" ${!v.previousVideoId ? 'selected' : ''}>— No previous video —</option>
                        ${pipelineVideos().filter(o => o.id !== v.id).map(o => `<option value="${escAttr(o.id)}" ${v.previousVideoId === o.id ? 'selected' : ''}>${escHtml(o.name)}</option>`).join('')}
                    </select>
                </div>
                ${isDecompSkipped(v)
                    ? `<div class="wsp-skip-banner">
                            <div class="wsp-skip-banner-main">${icon('film', 'wsp-row-ic')} <b>No decomposition needed</b> — reusing existing footage / props. This video skipped the whole build chain (design → ordering → manufacturing → artistic) and jumped to <b>Filming</b>.</div>
                            <button class="wsp-mini-btn" id="wsp-unskip-decomp">↩ Re-enable decomposition</button>
                        </div>
                        ${myComps.length ? `<div class="wsp-hint" style="margin-top:8px;">Components still linked (kept for reference):</div><div id="wsp-comp-list">${myComps.map(c => componentRowHtml(c)).join('')}</div>` : '<div id="wsp-comp-list"></div>'}`
                    : `<div id="wsp-comp-list">${myComps.map(c => componentRowHtml(c)).join('')}</div>
                        <div class="wsp-add-row wsp-decomp-add">
                            <input type="text" id="wsp-new-vcomp" placeholder="What do you need to build? (e.g. 'Doc Ock arm')">
                            <button class="wsp-mini-btn done" id="wsp-add-vcomp">＋ Add component</button>
                            <button class="wsp-mini-btn wsp-ai-btn" id="wsp-ai-suggest" title="Let AI read the hook, script &amp; context and suggest components">✨ AI suggest</button>
                        </div>
                        <div class="wsp-add-row">
                            <button class="wsp-mini-btn" id="wsp-skip-decomp" title="For videos you build from footage/props you already have — skip the entire build chain and jump straight to Filming">⏭ No decomposition needed — skip to Filming</button>
                        </div>`}
            </div>

            <div class="wsp-subsection ${sectionStatusClass(v, 'voiceover')}" data-vfield="voiceover" style="--accent:#8e44ad">
                ${subTitle('voiceover', 'Voiceover', '— one per video (audio or video file), stored in the project\'s vo/ folder in Dropbox. Sits just before Editing: the stage completes itself the moment one is linked.')}
                <div id="wsp-vo-section">
                    ${v.voPath
                        ? '' /* filled by initMediaSection */
                        : v.project
                            ? '<div class="wsp-hint">Checking the vo/ folder…</div>'
                            : projectGate(v, 'Select a Channel Project first — the voiceover lives in that project\'s Dropbox folder, so no project means nowhere to put it.')}
                </div>
            </div>

            <div class="wsp-subsection" style="--accent:#16a085">
                ${subTitle('voiceover', 'Music', '— optional. Paste a song link, or upload an audio/video file (stored in the project\'s music/ folder). Not tied to any stage or task.')}
                <div id="wsp-music-section">
                    ${v.musicPath ? '' /* filled by initMediaSection */ : '<div class="wsp-hint">Loading…</div>'}
                </div>
            </div>

            <div class="wsp-subsection ${sectionStatusClass(v, 'editing')}" data-vfield="editing" style="--accent:#27ae60">
                ${subTitle('edit', 'Editing — final videos', '— upload all THREE versions. They go to the project\'s "final videos/" folder in Dropbox and link back here. Once all three are in, Editing finishes and the video moves to Split Test.')}
                ${projectGate(v, 'Select a Channel Project first — the final videos live in that project\'s Dropbox folder.')}
                <div id="wsp-edit-full" class="wsp-edit-slot"></div>
                <div id="wsp-edit-nosubs" class="wsp-edit-slot"></div>
                <div id="wsp-edit-nomusic" class="wsp-edit-slot"></div>
            </div>`;
    }

    // Wire up the editor fields (works for the detail page AND the inline
    // drop-down — only one editor is ever mounted at a time).
    function bindDetailFields(v) {
        const get = (id) => document.getElementById(id);
        const nameEl = get('workshop-name');
        if (!nameEl) return;
        const root = nameEl.closest('.workshop-detail-fields');
        if (window.applyVideoFieldGating) window.applyVideoFieldGating(root);  // hide sections this profile can't see
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
        ['workshop-name', 'workshop-context'].forEach(id => {   // hook is its own instances now, not a field here
            const el = get(id);
            if (!el) return;
            el.addEventListener('input', scheduleSave);
            el.addEventListener('blur', () => { if (saveTimer) doSave(false); });
        });
        initAnimAssets(v);
        get('workshop-deadline')?.addEventListener('change', () => doSave(false));
        get('workshop-sponsor')?.addEventListener('change', () => doSave(false));
        get('workshop-project')?.addEventListener('change', () => doSave(true));
        get('workshop-prevvideo')?.addEventListener('change', () => doSave(true));   // re-render so the sequence/order updates

        // Branch decisions removed — a video's build branches are derived from its
        // components' needs (see effectiveState/branchActive).

        // Owner-only: force-move the video to any stage (for organization)
        get('wsp-move-stage')?.addEventListener('change', async (e) => {
            const target = e.target.value;
            e.target.value = '';
            if (!target) return;
            await saveFieldsFor(VideoService.getById(v.id) || v, true);
            const moved = await moveVideoToStage(VideoService.getById(v.id) || v, target);
            if (moved) rerender();
        });

        // Hook instances (add/type/label/delete/footage)
        bindHookInstances(v, root, rerender);

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
                    // Completing Decomposition just requires >=1 component (or the
                    // "No decomposition" skip) — branches derive from component needs.
                    if (stageId === 'decomp' && next === 'done') {
                        if (componentsForVideo(v.id).length === 0 && !fresh.noDecomp) { alert('Break the video down into at least one component before completing Decomposition.'); return; }
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
            const setup = await confirmComponentSetup({ title: 'Add component', name });
            if (!setup) return;
            await createVideoComponent(v.id, setup);
            input.value = '';
            rerender();
        };
        get('wsp-add-vcomp')?.addEventListener('click', addVComp);
        get('wsp-new-vcomp')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addVComp(); });
        // "No decomposition needed" — skip the whole build chain, or undo it
        get('wsp-skip-decomp')?.addEventListener('click', async () => {
            if (!confirm('No decomposition needed?\n\nThis skips the entire build chain that Decomposition gates — design, props, CAD/PCB, ordering, manufacturing, assembly and artistic — and jumps the video straight to Filming. Use it for videos you make from footage / props you already have.\n\nYou can re-enable decomposition any time.')) return;
            await setDecompSkip(v.id, true);
        });
        get('wsp-unskip-decomp')?.addEventListener('click', () => setDecompSkip(v.id, false));
        // (component rows' click-to-open AND delete are bound by bindCompStatusRows, which
        // runs for both the detail page and the drop-down editor)

        // AI-suggest components from the hook / script / context
        get('wsp-ai-suggest')?.addEventListener('click', (e) => suggestComponents(v.id, e.currentTarget));
        get('wsp-ai-hooks')?.addEventListener('click', (e) => suggestHooks(v.id, e.currentTarget));

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
        // Re-apply read gating now that the (synchronously-populated) script editor
        // and other fields have their values — so a read worker sees a provided
        // script as a brief, and empty sections stay hidden. Also runs again after
        // a tick to catch async-loaded media (vo / edit / footage).
        if (window.applyVideoFieldGating) {
            window.applyVideoFieldGating(root);
            setTimeout(() => { try { window.applyVideoFieldGating(root); } catch (e) {} }, 500);
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
        document.getElementById('workshop-delete').addEventListener('click', () => deleteVideoAction(selectedVideo));

        bindDetailFields(v);
        // Detail context: bind comp-status + order rows here (the stage panel
        // binds them itself in the drop-down context)
        bindCompStatusRows(el, () => rerenderEditor(v.id));
        bindOrderRows(el);

        // Voiceover section (async — talks to Dropbox; hook instances are
        // wired inside bindDetailFields)
        initMediaSection(v, 'vo');
        initMediaSection(v, 'music');   // optional music link/file — not tied to a stage
        initEditSlots(v);   // Editing — three final-video upload slots

        // 3D egg preview
        if (v.project && window.EggRenderer) {
            requestAnimationFrame(() => window.EggRenderer.initEggPreview('workshop-detail-egg-canvas', v.project));
        }
    }

    // What a component can require downstream (the per-component causality the
    // user sets at Decomposition). Subset of the video's branch stages.
    const COMPONENT_NEEDS = [
        { flag: 'design',     label: 'Design',        icon: 'design' },
        { flag: 'propdesign', label: 'Props',         icon: 'propdesign' },
        { flag: 'cad',        label: 'CAD',           icon: 'cad' },
        { flag: 'pcb',        label: 'PCB',           icon: 'pcb' },
        { flag: 'precision',  label: 'Precision Mfg', icon: 'precision' },
        { flag: 'software',   label: 'Software',      icon: 'software' },
        { flag: 'assembly',   label: 'Assembly',      icon: 'assembly' },
        { flag: 'artistic',   label: 'Artistic',      icon: 'artistic' }
    ];
    const COMPONENT_NEED_LABEL = Object.fromEntries(COMPONENT_NEEDS.map(n => [n.flag, n.label]));
    const COMPONENT_NEED_FLAGS = new Set(COMPONENT_NEEDS.map(n => n.flag));
    const normalizeComponentSource = (source) => (source === 'order' || source === 'task' || source === 'build') ? source : '';
    const normalizeComponentNeeds = (needs) => [...new Set(Array.isArray(needs) ? needs : [])].filter(f => COMPONENT_NEED_FLAGS.has(f));

    function confirmComponentSetup(opts = {}) {
        return new Promise(resolve => {
            let source = normalizeComponentSource(opts.source || '');
            const needsSet = new Set(source === 'build' ? normalizeComponentNeeds(opts.needs) : []);
            const overlay = document.createElement('div');
            overlay.className = 'wsp-picker-overlay';
            overlay.style.display = 'flex';
            overlay.innerHTML = `
                <div class="wsp-picker wsp-suggest-modal wsp-component-setup-modal">
                    <div class="wsp-picker-header"><span>🧩 ${escHtml(opts.title || 'Review component setup')}</span><button class="wsp-picker-close" data-cancel>✕</button></div>
                    <div class="wsp-component-setup">
                        <div class="wsp-hint">Confirm this before the component enters the pipeline. Type and build needs decide exactly where it goes.</div>
                        <div class="wsp-cd-label">Component</div>
                        <input type="text" id="wsp-setup-name" class="wsp-setup-name" value="${escAttr(opts.name || '')}" placeholder="Component name">

                        <div class="wsp-cd-label">Type <span class="wsp-hint">— required</span></div>
                        <div class="wsp-needs-btns">
                            ${COMPONENT_SOURCES.map(s => `<button class="wsp-need-btn ${source === s.key ? 'on' : ''}" data-setup-source="${s.key}" title="${escAttr(s.hint)}">${icon(s.icon, 'wsp-need-ic')} ${s.label}</button>`).join('')}
                        </div>

                        <div class="wsp-cd-label">What it needs <span class="wsp-hint">— required for build components</span></div>
                        <div class="wsp-needs-btns" id="wsp-setup-needs">
                            ${COMPONENT_NEEDS.map(n => `<button class="wsp-need-btn ${needsSet.has(n.flag) ? 'on' : ''}" data-setup-need="${n.flag}">${icon(n.icon, 'wsp-need-ic')} ${n.label}</button>`).join('')}
                        </div>
                        <div class="wsp-setup-msg" id="wsp-setup-msg"></div>
                    </div>
                    <div class="wsp-branch-actions">
                        <button class="wsp-mini-btn" data-cancel>Cancel</button>
                        <button class="wsp-mini-btn done" id="wsp-setup-confirm">Create component</button>
                    </div>
                </div>`;
            const panel = container.querySelector('.workshop-panel') || container;
            panel.appendChild(overlay);
            const q = (sel) => overlay.querySelector(sel);
            const nameEl = q('#wsp-setup-name');
            const msg = q('#wsp-setup-msg');
            const confirmBtn = q('#wsp-setup-confirm');
            const finish = (value) => { overlay.remove(); resolve(value); };
            const render = () => {
                overlay.querySelectorAll('[data-setup-source]').forEach(b => b.classList.toggle('on', b.dataset.setupSource === source));
                const needsDisabled = source !== 'build';
                overlay.querySelectorAll('[data-setup-need]').forEach(b => {
                    b.disabled = needsDisabled;
                    b.classList.toggle('on', !needsDisabled && needsSet.has(b.dataset.setupNeed));
                });
                const name = nameEl.value.trim();
                let err = '';
                if (!name) err = 'Name the component.';
                else if (!source) err = 'Pick the type.';
                else if (source === 'build' && needsSet.size === 0) err = 'Pick at least one build step it needs.';
                else if (source === 'order') err = 'Order items go straight to Ordering.';
                else if (source === 'task') err = 'Tasks go to Props / Set Design.';
                confirmBtn.disabled = !name || !source || (source === 'build' && needsSet.size === 0);
                msg.textContent = err;
                msg.classList.toggle('ok', !!name && !!source && !(source === 'build' && needsSet.size === 0));
            };
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
            overlay.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => finish(null)));
            overlay.querySelectorAll('[data-setup-source]').forEach(b => b.addEventListener('click', () => {
                source = b.dataset.setupSource;
                if (source !== 'build') needsSet.clear();
                render();
            }));
            overlay.querySelectorAll('[data-setup-need]').forEach(b => b.addEventListener('click', () => {
                if (source !== 'build') return;
                const flag = b.dataset.setupNeed;
                if (needsSet.has(flag)) needsSet.delete(flag); else needsSet.add(flag);
                render();
            }));
            nameEl.addEventListener('input', render);
            nameEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
            confirmBtn.addEventListener('click', () => {
                if (confirmBtn.disabled) return;
                finish({ name: nameEl.value.trim(), source, needs: source === 'build' ? [...needsSet] : [] });
            });
            render();
            nameEl.focus();
            nameEl.select();
        });
    }

    async function createVideoComponent(videoId, setup) {
        const fresh = VideoService.getById(videoId) || {};
        const source = normalizeComponentSource(setup.source);
        const needs = source === 'build' ? normalizeComponentNeeds(setup.needs) : [];
        if (!setup.name || !source || (source === 'build' && !needs.length)) throw new Error('Component setup is missing Type or What it needs.');
        const comp = await SVC().components.create({
            videoId,
            projectId: (fresh.projectIds || [])[0] || '',
            parentComponentId: '',
            name: setup.name,
            notes: '',
            needs,
            status: defaultStatusFor({ source, needs }),
            source,
            links: []
        });
        const deps = videoDeps(fresh);
        if (!deps.some(d => d && d.kind === 'component' && d.id === comp.id)) {
            await saveDeps(fresh, [...deps, { kind: 'component', id: comp.id }]);
        }
        return comp;
    }

    // A component is its own pipeline entity — created at Decomposition,
    // permanently linked to the video it came from (component.videoId), and it
    // flows the build stages on its own (status = where it is now). The video
    // automatically waits on every component it spawned. Click to open its full
    // detail (assets, links, contacts, needs, stage).
    // opts.advance — show the ✓ Done button. Only TRUE inside a component's own
    // stage panel, where the worker at that stage advances it. Decomposition (and
    // overview lists) pass nothing: decomposition only CREATES components, it
    // never controls where they are in the pipeline.
    function componentRowHtml(c, opts = {}) {
        const needs = Array.isArray(c.needs) ? c.needs : [];
        const linkCount = Array.isArray(c.links) ? c.links.length : 0;
        const showDone = opts.advance && c.status !== 'done' && stageWritable(componentStageId(c));
        return `<div class="wsp-comp-row" data-comp="${c.id}">
            <button class="wsp-comp-name wsp-clickable" data-open-comp="${c.id}" title="Open this component">
                ${icon('component', 'wsp-row-ic')} <span class="wsp-comp-name-text">${escHtml(c.name)}</span>
                ${c.source === 'order' ? '<span class="wsp-comp-tag order">order</span>' : c.source === 'task' ? '<span class="wsp-comp-tag task">task</span>' : c.source === 'build' ? '<span class="wsp-comp-tag build">build</span>' : ''}
            </button>
            <div class="wsp-comp-meta">
                ${needs.map(f => `<span class="wsp-need-chip">${escHtml(COMPONENT_NEED_LABEL[f] || f)}</span>`).join('')}
                ${linkCount ? `<span class="wsp-comp-assets">${icon('link', 'wsp-cc-ic')} ${linkCount}</span>` : ''}
                <span class="wsp-comp-stage">${escHtml(c.status || 'design')}</span>
            </div>
            ${showDone ? `<button class="wsp-mini-btn done" data-comp-done="${c.id}" title="Done">✓ Done</button>` : ''}
            <button class="wsp-mini-btn danger" data-comp-del="${c.id}" title="Remove component">✕</button>
        </div>`;
    }

    // Read-only graphic of where a component sits in its pipeline track. The stage
    // is NOT editable here — a component flows on its own and is only advanced by
    // the worker who owns its CURRENT stage (via their Done button).
    function componentStageGraphic(c) {
        const track = componentTrack(c);
        const curIdx = track.indexOf(c.status);
        return `<div class="wsp-stage-track" title="Where this component is right now (read-only) — it advances when the worker at its current stage marks it done">` +
            track.map((s, i) => {
                const state = (s === 'done')
                    ? (c.status === 'done' ? 'done' : 'future')
                    : (i < curIdx ? 'past' : i === curIdx ? 'current' : 'future');
                return `<span class="wsp-stage-step ${state}">${escHtml(s)}</span>`;
            }).join('<span class="wsp-stage-sep">›</span>') +
        `</div>`;
    }

    // The deliverable required to LEAVE a component's current status. CAD/PCB
    // stages need their actual design file (in the CAD/PCB file section) — not
    // just any media. → { met, missing }.
    // Each component STAGE must have its deliverable before it can be pushed
    // forward — you can't just press Done on an empty stage.
    function componentDeliverableStatus(c) {
        const needs = Array.isArray(c.needs) ? c.needs : [];
        const hasMedia = Array.isArray(c.media) && c.media.length > 0;
        const hasNotes = !!(c.notes && c.notes.trim());
        const hasLinks = Array.isArray(c.links) && c.links.length > 0;
        switch (c.status) {
            case 'design':
                // At least one of Media or Notes (sketches & assets are optional).
                if (!(hasMedia || hasNotes)) return { met: false, missing: 'Design Research needs a deliverable — fill in at least one of Media or Notes (sketches & assets are optional).' };
                break;
            case 'cad':
                if (needs.includes('cad') && !c.cadPath) return { met: false, missing: 'Upload the CAD file in this component’s “CAD file” section (a generic media file doesn’t count).' };
                if (needs.includes('pcb') && !c.pcbPath) return { met: false, missing: 'Upload the PCB file in this component’s “PCB file” section.' };
                break;
            case 'software':
                if (!(c.softwarePath || hasLinks || hasNotes)) return { met: false, missing: 'Software needs a deliverable — upload the build/firmware file, add a repo link, or write notes.' };
                break;
            case 'manufacturing':
                if (!(c.mfgPath || hasMedia || hasNotes)) return { met: false, missing: 'Manufacturing needs a deliverable — upload the file (G-code / print / spec), a photo, or notes.' };
                break;
            case 'assembly':
                if (!(c.asmPath || hasMedia || hasNotes)) return { met: false, missing: 'Assembly needs a deliverable — upload the assembled file/photo, or write notes.' };
                break;
        }
        return { met: true };
    }

    // Advance a component to the next status in its track (build/order/task),
    // but only if the current stage's deliverable is satisfied.
    async function advanceComponent(componentId, rerenderFn) {
        const c = SVC().components.getById(componentId);
        if (!c || c.status === 'done') return;
        // Only the worker who owns the component's CURRENT stage can advance it —
        // decomposition (and any other node) can't push it through the pipeline.
        if (!stageWritable(componentStageId(c))) { alert('Only the worker at this component’s current stage can mark it done.'); return; }
        const ds = componentDeliverableStatus(c);
        if (!ds.met) { alert(`This can’t move forward yet:\n\n• ${ds.missing}`); return; }
        const next = nextComponentStatus(c);
        await SVC().components.update(componentId, { status: next });
        toast(next === 'done' ? '✓ Component done' : `✓ Component → “${next}”`);
        if (rerenderFn) rerenderFn();
    }

    // Delete a component from anywhere. The remove must always take effect on
    // screen — its dependency-cleanup is best-effort and its failure must NOT
    // skip the re-render (that was the "can't delete" bug: a throw after the
    // remove left the row on screen).
    async function deleteComponentById(id, rerenderFn) {
        if (!canDeleteNow()) return blockDelete();
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
        scope.querySelectorAll('[data-comp-done]').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            advanceComponent(btn.dataset.compDone, rerenderFn || (() => renderTab()));
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

    const MEDIA_EXTS_VIDEO = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'];
    function mediaKind(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext)) return 'image';
        if (MEDIA_EXTS_VIDEO.includes(ext)) return 'video';
        if (ext === 'pdf') return 'pdf';
        return 'file';
    }
    function mediaTileHtml(m, i) {
        const kind = mediaKind(m.name || m.path || '');
        const ic = kind === 'video' ? 'film' : kind === 'image' ? 'propdesign' : 'script';
        return `<div class="wsp-media-tile" data-mediai="${i}" title="${escAttr(m.name || '')}">
            <button class="wsp-media-open" data-media-open="${i}">${icon(ic, 'wsp-media-ic')}<span class="wsp-media-name">${escHtml(m.name || 'file')}</span></button>
            <button class="wsp-media-del" data-media-del="${i}" title="Remove">✕</button>
        </div>`;
    }
    function sketchTileHtml(s, i) {
        return `<div class="wsp-sketch-tile" data-sketchi="${i}" title="${escAttr(s.name || 'sketch')}">
            <button class="wsp-sketch-open" data-sketch-edit="${i}">
                ${s.thumb ? `<img class="wsp-sketch-thumb" src="${escAttr(s.thumb)}" alt="">` : '<div class="wsp-sketch-thumb empty">✏️</div>'}
                <span class="wsp-media-name">${escHtml(s.name || 'Sketch')}</span>
            </button>
            <button class="wsp-media-del" data-sketch-del="${i}" title="Remove">✕</button>
        </div>`;
    }

    function openComponentDetail(componentId) {
        const c = SVC().components.getById(componentId);
        if (!c) return;
        const video = c.videoId ? VideoService.getById(c.videoId) : null;
        const needs = Array.isArray(c.needs) ? c.needs : [];
        const links = Array.isArray(c.links) ? c.links : [];
        const media = Array.isArray(c.media) ? c.media : [];
        const sketches = Array.isArray(c.sketches) ? c.sketches : [];
        const source = c.source || '';
        // Color-coded section (matches the video editor): a coloured spine +
        // faint wash + icon title, so the eye locks onto each pipeline step.
        const cdSection = (cfield, accent, iconName, title, hint, inner) =>
            `<div class="wsp-subsection" data-cfield="${cfield}" style="--accent:${accent}">
                <div class="wsp-subsection-title">${icon(iconName, 'wsp-sub-ic')} <span class="wsp-sub-name">${title}</span>${hint ? ` <span class="wsp-hint">${hint}</span>` : ''}</div>
                ${inner}
            </div>`;
        // A file-deliverable stage section (CAD/PCB/Software/Mfg/Assembly): only
        // appears when the component needs that stage. The slot itself is filled
        // by the async renderer below.
        const cdStageFile = (need, cfield, accent, iconName, title, hint, slotId) =>
            needs.includes(need) ? cdSection(cfield, accent, iconName, title, hint, `<div id="${slotId}"></div>`) : '';

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

                    <!-- SETUP — type, current stage, and which steps it needs (drives the stages below) -->
                    <div class="wsp-subsection" style="--accent:#8a7a55">
                        <div class="wsp-subsection-title">${icon('component', 'wsp-sub-ic')} <span class="wsp-sub-name">Setup</span></div>
                        <div data-cfield="source">
                            <div class="wsp-cd-label">Type <span class="wsp-hint">— how it gets done (drives where it flows)</span></div>
                            <div class="wsp-needs-btns">
                                ${COMPONENT_SOURCES.map(s => `<button class="wsp-need-btn ${source === s.key ? 'on' : ''}" data-source="${s.key}" title="${escAttr(s.hint)}">${icon(s.icon, 'wsp-need-ic')} ${s.label}</button>`).join('')}
                            </div>
                        </div>
                        <div data-cfield="status" style="margin-top:10px;">
                            <div class="wsp-cd-label">Stage <span class="wsp-hint">— where it is right now (read-only; it advances when the worker at its stage marks it done)</span></div>
                            <div id="cd-status-cycle">${componentStageGraphic(c)}</div>
                        </div>
                        <div data-cfield="needs" style="margin-top:10px;">
                            <div class="wsp-cd-label">What it needs <span class="wsp-hint">— pick every step it requires; a build component only flows through these stages</span></div>
                            <div class="wsp-needs-btns">
                                ${COMPONENT_NEEDS.map(n => `<button class="wsp-need-btn ${needs.includes(n.flag) ? 'on' : ''}" data-need="${n.flag}">${icon(n.icon, 'wsp-need-ic')} ${n.label}</button>`).join('')}
                            </div>
                        </div>
                    </div>

                    <!-- PIPELINE DELIVERABLES — in build order: design → cad → pcb → software → manufacturing → assembly.
                         File stages only appear when the component needs them; each is its own deliverable slot. -->
                    ${cdSection('design', '#a87d3c', 'design', 'Design', '— sketch the part out; draw and edit ideas anytime', `
                        <div id="cd-sketches" class="wsp-cd-sketch-grid">${sketches.map((s, i) => sketchTileHtml(s, i)).join('')}</div>
                        <div class="wsp-add-row"><button class="wsp-mini-btn done" id="cd-sketch-new">✏️ New sketch</button></div>`)}

                    ${cdStageFile('cad', 'cad', '#3d8bf0', 'cad', 'CAD file', '— the CAD deliverable (SolidWorks / STL / STEP). Goes to &lt;project&gt;/cad/.', 'cd-cad-slot')}
                    ${cdStageFile('pcb', 'pcb', '#8e44ad', 'pcb', 'PCB file', '— the PCB deliverable. Goes to &lt;project&gt;/pcb/.', 'cd-pcb-slot')}
                    ${cdStageFile('software', 'software', '#27ae72', 'software', 'Software', '— firmware / build / binary deliverable (a repo URL can go under Assets &amp; links). Goes to &lt;project&gt;/software/.', 'cd-software-slot')}
                    ${cdStageFile('precision', 'precision', '#e8a020', 'precision', 'Manufacturing', '— machined / printed / fabricated deliverable (G-code, print files, specs). Goes to &lt;project&gt;/manufacturing/.', 'cd-manufacturing-slot')}
                    ${cdStageFile('assembly', 'assembly', '#d2603a', 'assembly', 'Assembly', '— final assembled deliverable: a photo or sign-off file. Goes to &lt;project&gt;/assembly/.', 'cd-assembly-slot')}

                    <!-- REFERENCE — cross-cutting attachments & notes, after the staged deliverables -->
                    ${cdSection('media', '#6b7b8c', 'propdesign', 'Media', '— photos, videos, drawings, spec sheets', `
                        <div id="cd-media" class="wsp-cd-media-grid">${media.map((m, i) => mediaTileHtml(m, i)).join('')}</div>
                        <div class="wsp-add-row">
                            <input type="file" id="cd-media-file" multiple style="font-size:11.5px;flex:1 1 160px;">
                            <button class="wsp-mini-btn done" id="cd-media-up">⬆ Upload</button>
                        </div>
                        ${video && video.project ? '' : '<div class="wsp-hint">Tip: link this component\'s video to a Channel Project to enable uploads.</div>'}`)}

                    ${cdSection('links', '#6b7b8c', 'link', 'Assets &amp; links', '— 3D models, datasheets, repo URLs, references', `
                        <div id="cd-links">${links.map((l, i) => linkRowHtml(l, i)).join('')}</div>
                        <div class="wsp-add-row">
                            <input type="text" id="cd-link-label" placeholder="label (e.g. 'STL model')">
                            <input type="text" id="cd-link-url" placeholder="https://…">
                            <button class="wsp-mini-btn done" id="cd-link-add">＋ Add</button>
                        </div>`)}

                    ${cdSection('notes', '#6b7b8c', 'design', 'Notes / info', '', `
                        <textarea id="cd-notes" placeholder="Anything else about this component…">${escHtml(c.notes || '')}</textarea>`)}

                    <div class="wsp-cd-footer">
                        ${(c.status !== 'done' && stageWritable(componentStageId(c))) ? '<button class="wsp-mini-btn done" id="cd-done">✓ Done</button>' : ''}
                        <button class="wsp-mini-btn danger" id="cd-delete">🗑 Delete component</button>
                    </div>
                </div>
            </div>`;

        const panel = container.querySelector('.workshop-panel');
        panel.appendChild(overlay);
        if (window.applyComponentFieldGating) window.applyComponentFieldGating(overlay);  // hide sections this profile can't see
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

        // Per-stage file deliverables (each slot only exists when the component
        // needs that stage). All share one generic uploader keyed by pathF/nameF.
        (async () => {
            const slots = [
                { kind: 'cad', el: 'cd-cad-slot', pathF: 'cadPath', nameF: 'cadName', accept: '.sldprt,.sldasm,.step,.stp,.stl,.iges,.igs,.x_t,.3mf,.f3d', noun: 'CAD file' },
                { kind: 'pcb', el: 'cd-pcb-slot', pathF: 'pcbPath', nameF: 'pcbName', accept: '', noun: 'PCB file' },
                { kind: 'software', el: 'cd-software-slot', pathF: 'softwarePath', nameF: 'softwareName', accept: '', noun: 'software file' },
                { kind: 'manufacturing', el: 'cd-manufacturing-slot', pathF: 'mfgPath', nameF: 'mfgName', accept: '', noun: 'manufacturing file' },
                { kind: 'assembly', el: 'cd-assembly-slot', pathF: 'asmPath', nameF: 'asmName', accept: '', noun: 'assembly file' }
            ];
            if (!slots.some(s => q('#' + s.el))) return;
            const rootP = await dropboxRootPath();
            const renderSlot = (s) => {
                const el = q('#' + s.el);
                if (!el) return;
                const c2 = cur();
                const path = c2[s.pathF];
                if (path) {
                    el.innerHTML = `<div class="wsp-row" style="border-left:3px solid #14b8a6">
                        <span class="wsp-row-name">${escHtml(c2[s.nameF] || path.split('/').pop())} <span class="wsp-hint">linked ✓</span></span>
                        <button class="wsp-mini-btn" data-cf-open>▶ Open</button>
                        <button class="wsp-mini-btn danger" data-cf-unlink>✕</button></div>`;
                    el.querySelector('[data-cf-open]').addEventListener('click', () => openFilePreview(path, c2[s.nameF] || path.split('/').pop()));
                    el.querySelector('[data-cf-unlink]').addEventListener('click', async () => {
                        if (!confirm(`Unlink this ${s.noun}? (The file stays in Dropbox.)`)) return;
                        await saveComp({ [s.pathF]: '', [s.nameF]: '' }); dirty = true; renderSlot(s);
                    });
                } else if (video && video.project) {
                    el.innerHTML = `<div class="wsp-add-row">
                        <input type="file" id="cd-${s.kind}-file" accept="${s.accept}" multiple style="font-size:11.5px;flex:1 1 160px;">
                        <button class="wsp-mini-btn done" data-cf-up>⬆ Upload</button></div>`;
                    el.querySelector('[data-cf-up]').addEventListener('click', async () => {
                        const input = q('#cd-' + s.kind + '-file');
                        const files = input && input.files ? [...input.files] : [];
                        if (!files.length) { alert('Choose one or more files first.'); return; }
                        const bar = uploadProgressBar(el, files[0].name);
                        try {
                            let first = null;
                            for (let i = 0; i < files.length; i++) {
                                const file = files[i];
                                if (files.length > 1) bar.stage(`Uploading ${i + 1}/${files.length}: ${file.name}`);
                                const meta = await uploadToDropbox(`${rootP}/${video.project}/${s.kind}/${file.name}`, file, bar.progress);
                                if (!first) first = { path: meta.path_display || meta.path_lower, name: meta.name || file.name };
                            }
                            bar.stage('Saving to component…');
                            await saveComp({ [s.pathF]: first.path, [s.nameF]: first.name });
                            dirty = true; bar.stage('Done ✓');
                            toast(`📐 ${files.length} ${s.noun}${files.length === 1 ? '' : 's'} → ${video.project}/${s.kind}`);
                            renderSlot(s);
                        } catch (e) { alert('Upload failed: ' + e.message); renderSlot(s); }
                    });
                } else {
                    el.innerHTML = `<div class="wsp-hint">Link this component's video to a Channel Project to upload the ${s.noun}.</div>`;
                }
            };
            slots.forEach(renderSlot);
        })();
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        q('[data-close]').addEventListener('click', close);
        q('#cd-delete').addEventListener('click', async () => {
            const gone = await deleteComponentById(componentId, null);
            if (gone) { overlay.remove(); rerenderEditor(selectedVideo ? selectedVideo.id : (video ? video.id : null)); }
        });
        // DONE — push the component to its next status (build: design→cad→…→done;
        // order: needed→ordered→done; task: todo→doing→done). 'done' takes it off
        // the board.
        q('#cd-done')?.addEventListener('click', async () => {   // absent when the viewer doesn't own this component's current stage
            const c2 = cur();
            if (c2.status === 'done') { alert('This component is already done.'); return; }
            if (!stageWritable(componentStageId(c2))) { alert('Only the worker at this component’s current stage can mark it done.'); return; }
            const ds = componentDeliverableStatus(c2);
            if (!ds.met) { alert(`This can’t move forward yet:\n\n• ${ds.missing}`); return; }
            const next = nextComponentStatus(c2);
            dirty = true;
            await saveComp({ status: next });
            renderStatusCycle();
            toast(next === 'done' ? '✓ Component done' : `✓ Moved to “${next}”`);
            if (next === 'done') close();
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
        // Stage — READ-ONLY graphic. The component advances on its own (the worker
        // at its current stage presses Done); you can't jump it around from here.
        // Re-renders when the type/needs change (the track can change shape).
        const renderStatusCycle = () => {
            const cyc = q('#cd-status-cycle');
            if (!cyc) return;
            cyc.innerHTML = componentStageGraphic(cur());
        };
        renderStatusCycle();
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
            needsT = setTimeout(async () => {
                const changes = { needs: [...needsSet] };
                // Re-route the flow: drop the component onto a stage it still
                // needs if its current one was just toggled off.
                const snapped = normalizedComponentStatus({ ...cur(), needs: [...needsSet] });
                if (snapped !== cur().status) changes.status = snapped;
                await saveComp(changes);
                renderStatusCycle();   // Stage pills now reflect only the needed stages
            }, 400);
        }));
        // Type / source (single-select). Switching type re-routes the component
        // (build → build chain, order → Ordering, task → Props/Set Design) and
        // swaps its status track. If the current status isn't valid for the new
        // type, snap it to that type's first stage so it lands in the right lane.
        overlay.querySelectorAll('[data-source]').forEach(btn => btn.addEventListener('click', async () => {
            dirty = true;
            const val = cur().source === btn.dataset.source ? '' : btn.dataset.source;
            overlay.querySelectorAll('[data-source]').forEach(b => b.classList.toggle('on', b === btn && !!val));
            const changes = { source: val };
            const valid = componentTrack({ ...cur(), source: val });
            if (!valid.includes(cur().status)) changes.status = valid[0];
            await saveComp(changes);
            renderStatusCycle();
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
        // Media (uploaded files in the project's Dropbox folder)
        const renderMedia = () => { q('#cd-media').innerHTML = (cur().media || []).map((m, i) => mediaTileHtml(m, i)).join(''); bindMedia(); };
        const bindMedia = () => {
            q('#cd-media').querySelectorAll('[data-media-open]').forEach(b => b.addEventListener('click', () => {
                const m = (cur().media || [])[Number(b.dataset.mediaOpen)];
                if (m && m.path) openFilePreview(m.path, m.name);
            }));
            q('#cd-media').querySelectorAll('[data-media-del]').forEach(b => b.addEventListener('click', async () => {
                dirty = true;
                const media2 = (cur().media || []).filter((_, i) => i !== Number(b.dataset.mediaDel));
                await saveComp({ media: media2 }); renderMedia();
            }));
        };
        bindMedia();
        q('#cd-media-up').addEventListener('click', async () => {
            const input = q('#cd-media-file');
            const files = input.files ? [...input.files] : [];
            if (!files.length) { alert('Choose one or more files first.'); return; }
            const project = video && video.project;
            if (!project) { alert('Link this component\'s video to a Channel Project first — uploads go to that project\'s Dropbox folder.'); return; }
            const root = await dropboxRootPath();
            const folder = `${root}/${project}/components`;
            const btn = q('#cd-media-up'); btn.disabled = true; const orig = btn.textContent;
            const addRow = btn.parentElement;
            const progHost = document.createElement('div'); progHost.style.marginTop = '6px';
            addRow.parentNode.insertBefore(progHost, addRow.nextSibling);
            const bar = uploadProgressBar(progHost, files[0].name);
            try {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (files.length > 1) bar.stage(`Uploading ${file.name} (${i + 1}/${files.length})…`);
                    const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress);
                    dirty = true;
                    await saveComp({ media: [...(cur().media || []), { path: meta.path_display || meta.path_lower, name: meta.name || file.name }] });
                }
                bar.stage(`Done ✓ — ${files.length} file${files.length === 1 ? '' : 's'}`);
                setTimeout(() => progHost.remove(), 1200);
            } catch (e) { console.warn('media upload failed', e); bar.stage('Upload failed: ' + e.message); }
            input.value = ''; btn.disabled = false; btn.textContent = orig;
            renderMedia();
        });

        // Sketches (inline editable drawings — strokes stored on the component)
        const renderSketches = () => { q('#cd-sketches').innerHTML = (cur().sketches || []).map((s, i) => sketchTileHtml(s, i)).join(''); bindSketches(); };
        const bindSketches = () => {
            q('#cd-sketches').querySelectorAll('[data-sketch-edit]').forEach(b => b.addEventListener('click', () => {
                const i = Number(b.dataset.sketchEdit);
                const s = (cur().sketches || [])[i];
                openSketchModal({
                    name: s ? s.name : '', strokes: s ? (s.strokes || []) : [],
                    onSave: async (strokes, thumb, name) => {
                        dirty = true;
                        const list = [...(cur().sketches || [])];
                        list[i] = { ...(list[i] || {}), id: (s && s.id) || ('sk' + Math.random().toString(36).slice(2, 9)), name, strokes, thumb };
                        await saveComp({ sketches: list }); renderSketches();
                    }
                });
            }));
            q('#cd-sketches').querySelectorAll('[data-sketch-del]').forEach(b => b.addEventListener('click', async () => {
                if (!confirm('Delete this sketch?')) return;
                dirty = true;
                const list = (cur().sketches || []).filter((_, i) => i !== Number(b.dataset.sketchDel));
                await saveComp({ sketches: list }); renderSketches();
            }));
        };
        bindSketches();
        q('#cd-sketch-new').addEventListener('click', () => {
            openSketchModal({
                name: '', strokes: [],
                onSave: async (strokes, thumb, name) => {
                    dirty = true;
                    const list = [...(cur().sketches || []), { id: 'sk' + Math.random().toString(36).slice(2, 9), name: name || `Sketch ${(cur().sketches || []).length + 1}`, strokes, thumb }];
                    await saveComp({ sketches: list }); renderSketches();
                }
            });
        });

        // Notes (debounced)
        let nT = null;
        q('#cd-notes').addEventListener('input', (e) => { clearTimeout(nT); flashSaving(); dirty = true; nT = setTimeout(() => saveComp({ notes: e.target.value }), 600); });
    }

    // ============ SKETCH PAD — simple in-app drawing, strokes stored on the component ============
    // A lightweight vector sketcher: pen/eraser, color, size, undo, clear. Saves
    // the strokes (so it re-opens for editing) plus a small PNG thumbnail.
    function openSketchModal(opts) {
        const W = 900, H = 620;
        const strokes = (opts.strokes || []).map(s => ({ color: s.color, size: s.size, erase: !!s.erase, points: [...(s.points || [])] }));
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay wsp-sketch-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="wsp-sketch-modal">
                <div class="wsp-sketch-toolbar">
                    <input type="text" id="sk-name" class="wsp-sketch-nameinput" placeholder="Sketch name" value="${escAttr(opts.name || '')}">
                    <span class="wsp-sketch-tools">
                        ${['#1a1a1a', '#e74c3c', '#2bb673', '#3d8bf0', '#e8a020', '#8e44ad'].map((c, i) => `<button class="wsp-sk-color${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
                        <button class="wsp-sk-tool" id="sk-pen" title="Pen">✏️</button>
                        <button class="wsp-sk-tool" id="sk-eraser" title="Eraser">🧽</button>
                        <label class="wsp-sk-size">Size <input type="range" id="sk-size" min="1" max="24" value="3"></label>
                        <button class="wsp-mini-btn" id="sk-undo">↶ Undo</button>
                        <button class="wsp-mini-btn" id="sk-clear">Clear</button>
                    </span>
                    <span class="wsp-sketch-actions">
                        <button class="wsp-mini-btn" id="sk-cancel">Cancel</button>
                        <button class="wsp-mini-btn done" id="sk-save">Save sketch</button>
                    </span>
                </div>
                <div class="wsp-sketch-canvas-wrap">
                    <canvas id="sk-canvas" width="${W}" height="${H}"></canvas>
                </div>
            </div>`;
        (container.querySelector('.workshop-panel') || document.body).appendChild(overlay);

        const canvas = overlay.querySelector('#sk-canvas');
        const ctx = canvas.getContext('2d');
        let color = '#1a1a1a', size = 3, erasing = false, drawing = false, current = null;

        const redraw = () => {
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            for (const s of strokes) {
                if (!s.points.length) continue;
                ctx.strokeStyle = s.erase ? '#ffffff' : s.color;
                ctx.lineWidth = s.erase ? s.size * 2.5 : s.size;
                ctx.beginPath();
                ctx.moveTo(s.points[0].x, s.points[0].y);
                for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
                if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y + 0.1);
                ctx.stroke();
            }
        };
        redraw();

        const pos = (e) => {
            const r = canvas.getBoundingClientRect();
            const cx = (e.touches ? e.touches[0].clientX : e.clientX), cy = (e.touches ? e.touches[0].clientY : e.clientY);
            return { x: (cx - r.left) * (W / r.width), y: (cy - r.top) * (H / r.height) };
        };
        const start = (e) => { e.preventDefault(); drawing = true; current = { color, size, erase: erasing, points: [pos(e)] }; strokes.push(current); redraw(); };
        const move = (e) => { if (!drawing) return; e.preventDefault(); current.points.push(pos(e)); redraw(); };
        const end = () => { drawing = false; current = null; };
        canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
        canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);

        const setActiveColor = (btn) => overlay.querySelectorAll('.wsp-sk-color').forEach(b => b.classList.toggle('active', b === btn));
        overlay.querySelectorAll('.wsp-sk-color').forEach(b => b.addEventListener('click', () => { color = b.dataset.color; erasing = false; setActiveColor(b); overlay.querySelector('#sk-pen').classList.add('active'); overlay.querySelector('#sk-eraser').classList.remove('active'); }));
        overlay.querySelector('#sk-pen').addEventListener('click', () => { erasing = false; overlay.querySelector('#sk-pen').classList.add('active'); overlay.querySelector('#sk-eraser').classList.remove('active'); });
        overlay.querySelector('#sk-eraser').addEventListener('click', () => { erasing = true; overlay.querySelector('#sk-eraser').classList.add('active'); overlay.querySelector('#sk-pen').classList.remove('active'); });
        overlay.querySelector('#sk-size').addEventListener('input', (e) => { size = Number(e.target.value); });
        overlay.querySelector('#sk-undo').addEventListener('click', () => { strokes.pop(); redraw(); });
        overlay.querySelector('#sk-clear').addEventListener('click', () => { if (confirm('Clear the whole sketch?')) { strokes.length = 0; redraw(); } });
        overlay.querySelector('#sk-pen').classList.add('active');

        const closeModal = () => overlay.remove();
        overlay.querySelector('#sk-cancel').addEventListener('click', closeModal);
        overlay.querySelector('#sk-save').addEventListener('click', () => {
            // small thumbnail for the tile
            const t = document.createElement('canvas'); t.width = 200; t.height = Math.round(200 * H / W);
            t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
            const thumb = t.toDataURL('image/png');
            const name = overlay.querySelector('#sk-name').value.trim() || opts.name || 'Sketch';
            opts.onSave(strokes, thumb, name);
            closeModal();
        });
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
    function openAiProgressModal(title, hint) {
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `<div class="wsp-picker wsp-suggest-modal wsp-engine-modal">
            <div class="wsp-picker-header"><span>${escHtml(title)} ${hint ? `<span class="wsp-hint">— ${escHtml(hint)}</span>` : ''}</span><button class="wsp-picker-close" data-close>✕</button></div>
            <div class="wsp-engine-trace"></div>
        </div>`;
        (container.querySelector('.workshop-panel') || container).appendChild(overlay);
        overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        const traceEl = overlay.querySelector('.wsp-engine-trace');
        const rows = {};
        const step = (id, status, text, detail) => {
            let row = rows[id];
            if (!row) { row = document.createElement('div'); row.className = 'wsp-trace-step'; traceEl.appendChild(row); rows[id] = row; }
            const running = status === 'run';
            row.innerHTML = `<div class="wsp-trace-head ${status === 'error' ? 'err' : running ? 'run' : 'done'}">
                <span class="wsp-trace-ic">${running ? '<span class="wsp-spin"></span>' : (status === 'error' ? '⚠' : '✓')}</span>
                <span class="wsp-trace-title">${escHtml(text || id)}</span>
                ${detail ? `<span class="wsp-trace-detail">${escHtml(detail)}</span>` : ''}</div>`;
            traceEl.scrollTop = traceEl.scrollHeight;
        };
        return { step, close: () => overlay.remove(), overlay };
    }

    // Filming footage coverage. The scan runs SERVER-SIDE, so it keeps going when
    // you close the modal or the whole page. footageScans[videoId] is the single
    // source of truth for the CURRENT job; the watcher and the modal both follow
    // it, so if the server restarts mid-scan (e.g. a deploy wipes the in-memory
    // job), it AUTO-RESUMES from where it left off — the per-clip work is cached
    // in R2, so resuming only re-watches the clips that hadn't finished yet.
    const footageScans = {};       // videoId -> current jobId (drives the button label)
    const footageRestarts = {};    // videoId -> auto-resume count (safety cap)
    const footageWatching = {};    // videoId -> a watcher loop is running
    const footageResuming = {};    // videoId -> in-flight resume promise (idempotency lock)
    const FOOTAGE_RESUME_CAP = 12;

    function footageReportDone(v) { return !!(v && v.footageReport && v.footageReport.status === 'done'); }

    async function footageStartJob(videoId) {
        const res = await fetch('/api/footage-coverage/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId }) });
        const start = await res.json().catch(() => ({}));
        if (!res.ok || !start.jobId) throw new Error(start.error || `Failed: ${res.status}`);
        footageScans[videoId] = start.jobId;
        ensureFootageWatcher(videoId);
        return start.jobId;
    }

    // Idempotent resume: a job vanished. If the scan isn't actually finished, start
    // a NEW job (cheap — cached clips are skipped) and update footageScans so the
    // modal/watcher keep following. Locked so the watcher + modal can't double-fire.
    function footageResume(videoId) {
        if (footageResuming[videoId]) return footageResuming[videoId];
        const p = (async () => {
            await VideoService.sync(true).catch(() => {});
            if (footageReportDone(VideoService.getById(videoId))) { delete footageScans[videoId]; renderTab(); return false; }
            if ((footageRestarts[videoId] || 0) >= FOOTAGE_RESUME_CAP) { delete footageScans[videoId]; renderTab(); return false; }
            footageRestarts[videoId] = (footageRestarts[videoId] || 0) + 1;
            try { await footageStartJob(videoId); renderTab(); return true; }
            catch (e) { console.warn('footage resume failed', e); delete footageScans[videoId]; renderTab(); return false; }
        })();
        footageResuming[videoId] = p;
        p.finally(() => { if (footageResuming[videoId] === p) delete footageResuming[videoId]; });
        return p;
    }

    // One background watcher per video: follows footageScans[videoId], auto-resumes
    // a job that died unfinished, and refreshes the data + button when it completes.
    function ensureFootageWatcher(videoId) {
        if (footageWatching[videoId]) return;
        footageWatching[videoId] = true;
        (async () => {
            try {
                while (footageScans[videoId]) {
                    const jobId = footageScans[videoId];
                    await new Promise(r => setTimeout(r, 2500));
                    if (footageScans[videoId] !== jobId) continue;   // resumed elsewhere → follow the new job
                    let pr;
                    try { pr = await fetch('/api/footage-coverage/progress?job=' + encodeURIComponent(jobId)).then(r => r.ok ? r.json() : null); } catch (_) { continue; }
                    if (pr && pr.done) { delete footageScans[videoId]; footageRestarts[videoId] = 0; await VideoService.sync(true).catch(() => {}); renderTab(); break; }
                    if (!pr) { const resumed = await footageResume(videoId); if (!resumed) break; }   // resumed → keep following
                }
            } finally { footageWatching[videoId] = false; }
        })();
    }

    async function footageCheckClick(videoId, btn) {
        if (!VideoService.getById(videoId)) return;
        // If a progress modal is already open for this video, just leave it up.
        const host = container.querySelector('.workshop-panel') || container;
        if (host.querySelector(`[data-fcov-overlay="${videoId}"]`)) { openFootageProgress(videoId); return; }
        if (btn) { const o = btn.textContent; btn.textContent = '🔍 Connecting…'; setTimeout(() => { if (btn.textContent === '🔍 Connecting…') btn.textContent = o; }, 4000); }
        // Is a job already running on the server (this session, or after a reload)?
        let jobId = null;
        try { const a = await fetch('/api/footage-coverage/active?videoId=' + encodeURIComponent(videoId)).then(r => r.json()); if (a && a.jobId) jobId = a.jobId; } catch (_) {}
        if (jobId) { footageScans[videoId] = jobId; ensureFootageWatcher(videoId); openFootageProgress(videoId); renderTab(); return; }
        // Nothing running → start. (This also RESUMES a scan that died: cached clips
        // are skipped, so it picks up from where it stopped.)
        footageRestarts[videoId] = 0;
        try { await footageStartJob(videoId); openFootageProgress(videoId); renderTab(); }
        catch (e) { console.warn('footage scan failed to start', e); if (btn) btn.textContent = '🔍 Check footage coverage'; alert('Could not start footage scan: ' + (e.message || 'error')); }
    }

    // The live, reopenable progress modal. Follows footageScans[videoId] (so it
    // rides through an auto-resume seamlessly); closing it stops only this view.
    function openFootageProgress(videoId) {
        const host = container.querySelector('.workshop-panel') || container;
        if (host.querySelector(`[data-fcov-overlay="${videoId}"]`)) return;   // don't stack duplicate modals
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        overlay.setAttribute('data-fcov-overlay', videoId);
        overlay.innerHTML = `<div class="wsp-picker wsp-suggest-modal wsp-footage-modal">
            <div class="wsp-picker-header"><span>🔍 Footage coverage <span class="wsp-hint">— <span data-fcov-phase>connecting…</span></span></span><button class="wsp-picker-close" data-close>✕</button></div>
            <div class="wsp-footage-prog">
                <div class="wsp-footage-bar"><div class="wsp-footage-bar-fill" data-fcov-fill></div></div>
                <div class="wsp-footage-count" data-fcov-count>Loading progress…</div>
            </div>
            <div class="wsp-footage-cliplist" data-fcov-list></div>
            <div class="wsp-hint" style="margin-top:8px">Runs server-side — close this or leave the page anytime, then reopen it from the same button. Results are saved to the video.</div>
        </div>`;
        host.appendChild(overlay);
        overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        const PHASE_LABEL = { starting: 'starting…', listing: 'listing footage…', analyzing: 'watching clips…', reasoning: 'reasoning over the script…', done: 'done ✓', error: 'error' };
        const ICON = { pending: '○', analyzing: '<span class="wsp-spin"></span>', cached: '⚡', done: '✓', error: '⚠' };
        const STATUS_LABEL = { pending: 'queued', analyzing: 'watching…', cached: 'cached', done: 'analyzed', error: 'failed' };
        const renderProg = (pr) => {
            if (!overlay.isConnected) return;
            const clips = pr.clips || [];
            const total = pr.total || clips.length || 0;
            const processed = clips.filter(c => c.status === 'cached' || c.status === 'done' || c.status === 'error').length;
            const fresh = clips.filter(c => c.status === 'done').length;
            const cached = clips.filter(c => c.status === 'cached').length;
            const errs = clips.filter(c => c.status === 'error').length;
            const phaseEl = overlay.querySelector('[data-fcov-phase]'); if (phaseEl) phaseEl.textContent = PHASE_LABEL[pr.phase] || pr.phase || '';
            const fill = overlay.querySelector('[data-fcov-fill]'); if (fill) fill.style.width = (total ? Math.round(processed / total * 100) : (pr.done ? 100 : 6)) + '%';
            const count = overlay.querySelector('[data-fcov-count]');
            if (count) count.textContent = total
                ? `${processed} / ${total} clips · ${fresh} newly analyzed · ${cached} cached${errs ? ` · ${errs} failed` : ''}${pr.phase === 'reasoning' ? ' · reasoning…' : ''}`
                : (pr.phase === 'listing' ? 'Listing footage…' : 'Connecting…');
            const list = overlay.querySelector('[data-fcov-list]');
            if (list) list.innerHTML = clips.map(c => `<div class="wsp-footage-clip is-${c.status}"><span class="wsp-footage-clip-ic">${ICON[c.status] || '○'}</span><span class="wsp-footage-clip-name">${escHtml(c.name)}</span><span class="wsp-footage-clip-status">${STATUS_LABEL[c.status] || c.status}</span></div>`).join('');
        };

        const setPhase = (t) => { const el = overlay.querySelector('[data-fcov-phase]'); if (el) el.textContent = t; };
        const setCount = (t, color) => { const el = overlay.querySelector('[data-fcov-count]'); if (el) { el.textContent = t; if (color) el.style.color = color; } };
        (async () => {
            while (overlay.isConnected) {
                const jobId = footageScans[videoId];   // follow the CURRENT job (rides through auto-resume)
                if (!jobId) {   // scan ended — finished, or stopped after the resume cap
                    await VideoService.sync(true).catch(() => {});
                    const v = VideoService.getById(videoId);
                    if (footageReportDone(v)) { setPhase('done ✓'); setCount(`Done — ${v.footageReport.gapsCount || 0} possible gap${v.footageReport.gapsCount === 1 ? '' : 's'}, ${v.footageReport.coveredCount || 0} covered.`); }
                    else { setPhase('stopped'); setCount('Scan stopped before finishing — click “Re-check footage coverage” to resume (already-analyzed clips are skipped).'); }
                    break;
                }
                let pr;
                try { pr = await fetch('/api/footage-coverage/progress?job=' + encodeURIComponent(jobId)).then(r => r.ok ? r.json() : null); } catch (_) { await new Promise(r => setTimeout(r, 1200)); continue; }
                if (!pr) {   // this job vanished (server restart/deploy) but the scan isn't done → resume
                    setPhase('reconnecting — resuming…');
                    setCount('The server restarted mid-scan; resuming from where it left off (cached clips are skipped)…');
                    footageResume(videoId);   // idempotent; updates footageScans, which this loop then follows
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                renderProg(pr);
                if (pr.done) {
                    setPhase(pr.error ? 'error' : 'done ✓');
                    if (pr.error) setCount('⚠ ' + pr.error, '#e74c3c');
                    break;   // watcher refreshes the data + button
                }
                await new Promise(r => setTimeout(r, 1200));
            }
        })();
    }

    async function suggestComponents(videoId, btn) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '✨ Thinking…';
        const progress = openAiProgressModal('✨ Component planner', 'watch it read the brief and prepare suggestions');
        try {
            progress.step('brief', 'run', 'Reading video brief', 'hook + script + context');
            const existing = componentsForVideo(videoId).map(c => c.name);
            // Pull the hook(s) from the instances (v.hook is just a legacy mirror),
            // including the opening visual for each — it informs what gets built.
            const hookText = (PS().hooksOf(v) || [])
                .map(h => `${(h.text || h.label || '').trim()}${h.visual ? ` [visual: ${h.visual.trim()}]` : ''}`)
                .filter(s => s.trim()).join(' | ') || v.hook || '(none)';
            progress.step('brief', 'done', 'Read video brief', `${existing.length} existing on this video`);
            // Parts already built across past projects — so we reuse instead of
            // re-building the same thing twice.
            const built = [...new Set(completedComponents().map(c => c.name).filter(Boolean))];
            progress.step('reuse', 'done', 'Checked reusable parts', `${built.length} completed components`);
            const sys = `You are a production planner for maker / engineering YouTube videos. Given a video idea, list the COMPONENTS that must be handled to pull it off. Output ONLY a JSON object and nothing else — no prose, no markdown fences, do not explain, do not think out loud. Schema: {"components":[{"name":"short concrete name","source":"build"|"order"|"task","needs":[...]}]}. "source" is "build" if you'd make it in-house, "order" if you'd buy it, "task" if it's just an errand that gets done — neither built nor bought (e.g. "book the studio", "get a permit", "borrow a ladder"). "needs" is an array containing ONLY values from this EXACT set of production steps: design, propdesign, cad, pcb, software, assembly, artistic — and only applies to "build" components; use [] for "order" and "task". These are stages of work, NOT other components — never put a component name in "needs". Consider the HOOK and SCRIPT (not just the context) to discern every component the build/shoot needs. Do NOT suggest anything in the "already built" list — we'll reuse those; only suggest genuinely new things. 3-8 components.`;
            const user = `Video title: ${v.name}\nHook(s): ${hookText}\nScript: ${(v.script || '(none)').slice(0, 4000)}\nContext: ${v.context || '(none)'}\nAlready on this video (don't repeat): ${existing.join(', ') || 'none'}\nAlready built — reuse, don't re-suggest: ${built.slice(0, 80).join(', ') || 'none'}`;
            progress.step('ai', 'run', 'Planning components with AI', 'waiting for JSON suggestions');
            const parsed = await aiJson(
                [{ role: 'system', content: sys }, { role: 'user', content: user }],
                (content) => { const o = extractJsonObject(content, 'components'); return (o && Array.isArray(o.components) && o.components.length) ? o : null; }
            );
            const list = parsed.components.filter(c => c && c.name);
            if (!list.length) {
                progress.step('error', 'error', 'No components returned', 'add more context/script and retry');
                alert('AI did not suggest any components. Add more context and try again.');
                return;
            }
            progress.step('ai', 'done', 'AI returned suggestions', `${list.length} component${list.length === 1 ? '' : 's'}`);
            progress.step('review', 'done', 'Ready for manual review', 'confirm Type + What it needs before adding');
            progress.close();
            showComponentSuggestions(videoId, list);
        } catch (e) {
            console.warn('suggestComponents failed', e);
            progress.step('error', 'error', 'AI suggest failed', e.message);
            alert('AI suggest failed: ' + e.message);
        } finally {
            btn.disabled = false; btn.textContent = orig;
        }
    }

    // ===== AI hook suggestions (Kimi, grounded in our channel's principles) =====
    const STEP_ICON = { search: '\ud83d\udd0e', voice: '\ud83d\udde3\ufe0f', mechanisms: '\u2699\ufe0f', draft: '\u270d\ufe0f', validate: '\ud83e\uddea', final: '\u2705', result: '\u2705', error: '\u26a0\ufe0f' };
    async function suggestHooks(videoId, btn) {
        const v = VideoService.getById(videoId);
        if (!v) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '\u2728 Working\u2026';
        // Open the visualizer overlay immediately \u2014 the user watches it work.
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay'; overlay.style.display = 'flex';
        overlay.innerHTML = `<div class="wsp-picker wsp-suggest-modal wsp-engine-modal">
            <div class="wsp-picker-header"><span>\u2728 Hook engine <span class="wsp-hint">\u2014 watch it search your data, reason, and validate</span></span><button class="wsp-picker-close" data-close>\u2715</button></div>
            <div class="wsp-engine-trace" id="wsp-engine-trace"></div>
            <div class="wsp-suggest-list" id="wsp-engine-hooks"></div>
        </div>`;
        (container.querySelector('.workshop-panel') || container).appendChild(overlay);
        overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        const traceEl = overlay.querySelector('#wsp-engine-trace');
        const steps = {};
        const renderStep = (ev) => {
            const id = ev.stage;
            let row = steps[id];
            if (!row) { row = document.createElement('div'); row.className = 'wsp-trace-step'; traceEl.appendChild(row); steps[id] = row; }
            const running = ev.status === 'run';
            const items = (ev.items || []).map(it => `<div class="wsp-trace-item">${escHtml(it.label || '')}${it.meta ? `<span class="wsp-trace-meta">${escHtml(it.meta)}</span>` : ''}</div>`).join('');
            row.innerHTML = `<div class="wsp-trace-head ${ev.status === 'error' ? 'err' : running ? 'run' : 'done'}">
                <span class="wsp-trace-ic">${running ? '<span class="wsp-spin"></span>' : (STEP_ICON[id] || '\u2022')}</span>
                <span class="wsp-trace-title">${escHtml(ev.title || id)}</span>
                ${ev.detail ? `<span class="wsp-trace-detail">${escHtml(ev.detail)}</span>` : ''}</div>
                ${items ? `<div class="wsp-trace-items">${items}</div>` : ''}`;
            traceEl.scrollTop = traceEl.scrollHeight;
        };

        try {
            const res = await fetch('/api/workshop/hook-engine', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: v.name || '', context: v.context || '', script: (v.script || '').slice(0, 2000),
                    existingHooks: PS().hooksOf(v).map(h => h.text || h.label).filter(Boolean)
                })
            });
            if (!res.body) throw new Error('no stream');
            const reader = res.body.getReader(); const dec = new TextDecoder();
            let buf = '', finalHooks = null, errMsg = null;
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
                    const line = chunk.replace(/^data:\s?/, '');
                    if (!line) continue;
                    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
                    if (ev.stage === 'result') { finalHooks = (ev.result && ev.result.hooks) || []; }
                    else if (ev.stage === 'error') { errMsg = ev.error; }
                    else renderStep(ev);
                }
            }
            if (errMsg) { renderStep({ stage: 'error', status: 'error', title: 'Engine error: ' + errMsg }); return; }
            const hooks = finalHooks || [];
            if (!hooks.length) { renderStep({ stage: 'error', status: 'error', title: 'No hooks returned \u2014 add more context/script and retry.' }); return; }
            renderHookCards(videoId, overlay.querySelector('#wsp-engine-hooks'), hooks, () => overlay.remove());
        } catch (e) {
            console.warn('suggestHooks failed', e);
            renderStep({ stage: 'error', status: 'error', title: 'Hook engine failed: ' + e.message });
        } finally {
            btn.disabled = false; btn.textContent = orig;
        }
    }

    // Render the finished hook cards (with validation) into a container.
    function renderHookCards(videoId, host, hooks, onClose) {
        host.innerHTML = `<div class="wsp-engine-resulthead">Hooks — each validated against your working mechanisms. Use one, then pick its type.</div>` +
            hooks.map((h, i) => `<div class="wsp-hooksug" data-sug="${i}">
                <div class="wsp-hooksug-main">
                    <div class="wsp-hooksug-line">${icon('hook', 'wsp-row-ic')} <b>${escHtml(h.line)}</b>${h.validation && h.validation.strength ? `<span class="wsp-hooksug-score" title="swipe-stopping strength · ${escAttr(h.validation.supportedBy || '')}">${h.validation.strength}/10</span>` : ''}</div>
                    ${(h.principles && h.principles.length) ? `<div class="wsp-hooksug-princ">${h.principles.map(p => `<span class="wsp-princ-tag">${escHtml(p)}</span>`).join('')}</div>` : ''}
                    ${h.visual ? `<div class="wsp-hooksug-visual">${icon('film', 'wsp-cc-ic')} <span>${escHtml(h.visual)}</span></div>` : ''}
                    ${h.why ? `<div class="wsp-hooksug-why">${escHtml(h.why)}</div>` : ''}
                    ${h.validation && h.validation.supportedBy ? `<div class="wsp-hooksug-model">✓ validated by: ${escHtml(h.validation.supportedBy)}${h.validation.concern ? ` · ⚠ ${escHtml(h.validation.concern)}` : ''}</div>` : ''}
                    ${h.modeledOn && h.modeledOn.title ? `<div class="wsp-hooksug-model">↳ evidence: "${escHtml(h.modeledOn.title)}"${typeof h.modeledOn.swipe === 'number' ? ` — kept ${(100 - h.modeledOn.swipe).toFixed(1)}% past the hook` : (h.modeledOn.views ? ` (${(h.modeledOn.views).toLocaleString()} views)` : '')}</div>` : ''}
                </div>
                <button class="wsp-mini-btn done" data-use="${i}">＋ Use</button>
            </div>`).join('');
        host.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', async () => {
            const h = hooks[+b.dataset.use];
            const hs = hooksWithEdits(videoId);
            hs.push({ id: 'h' + Math.random().toString(36).slice(2, 10), type: '', text: h.line, visual: h.visual || '', label: '', videoPath: '', videoName: '' });
            await saveHooks(videoId, hs);
            fetch('/api/workshop/hook-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: h.line, visual: h.visual || '' }) }).catch(() => {});
            if (onClose) onClose();
            rerenderEditor(videoId);
            toast('Hook added — the engine will remember it');
        }));
    }

    function showComponentSuggestions(videoId, list) {
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="wsp-picker wsp-suggest-modal">
                <div class="wsp-picker-header"><span>✨ AI-suggested components</span><button class="wsp-picker-close" data-close>✕</button></div>
                <div class="wsp-suggest-list">
                    <div class="wsp-hint" style="padding:0 2px 4px;">Review the ones that fit — Type and build needs must be confirmed before anything enters the pipeline.</div>
                    ${list.map((c, i) => {
                        const source = normalizeComponentSource(c.source) || 'build';
                        const needs = normalizeComponentNeeds(c.needs);
                        return `<div class="wsp-suggest-row" data-sug="${i}">
                            <div class="wsp-suggest-main">
                                <div class="wsp-suggest-name">${icon('component', 'wsp-row-ic')} ${escHtml(c.name)} ${source === 'order' ? '<span class="wsp-comp-tag order">order</span>' : source === 'task' ? '<span class="wsp-comp-tag task">task</span>' : '<span class="wsp-comp-tag build">build</span>'}</div>
                                <div class="wsp-comp-meta">${needs.map(f => `<span class="wsp-need-chip">${escHtml(COMPONENT_NEED_LABEL[f] || f)}</span>`).join('') || '<span class="wsp-hint">no special steps</span>'}</div>
                            </div>
                            <button class="wsp-mini-btn done" data-add-sug="${i}">Review + Add</button>
                        </div>`;
                    }).join('')}
                </div>
                <div class="wsp-branch-actions">
                    <button class="wsp-mini-btn" data-close>Close</button>
                    <button class="wsp-mini-btn done" id="wsp-add-all-sug">Review all</button>
                </div>
            </div>`;
        const panel = container.querySelector('.workshop-panel');
        panel.appendChild(overlay);
        const close = () => { overlay.remove(); rerenderEditor(videoId); };
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

        const addOne = async (i, rowBtn) => {
            const c = list[i];
            if (!c || c._added) return true;
            const oldText = rowBtn ? rowBtn.textContent : '';
            if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = 'Reviewing…'; }
            const setup = await confirmComponentSetup({
                title: 'Review AI suggestion',
                name: c.name,
                source: normalizeComponentSource(c.source) || 'build',
                needs: normalizeComponentNeeds(c.needs)
            });
            if (!setup) {
                if (rowBtn) { rowBtn.disabled = false; rowBtn.textContent = oldText || 'Review + Add'; }
                return false;
            }
            try {
                await createVideoComponent(videoId, setup);
                c._added = true;
                if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = '✓ Added'; }
                return true;
            } catch (e) {
                console.warn('add suggested component failed', e);
                alert('Could not add component: ' + e.message);
                if (rowBtn) { rowBtn.disabled = false; rowBtn.textContent = oldText || 'Review + Add'; }
                return false;
            }
        };
        overlay.querySelectorAll('[data-add-sug]').forEach(b => b.addEventListener('click', () => addOne(Number(b.dataset.addSug), b)));
        overlay.querySelector('#wsp-add-all-sug').addEventListener('click', async (e) => {
            e.target.disabled = true; e.target.textContent = 'Reviewing…';
            for (let i = 0; i < list.length; i++) {
                const ok = await addOne(i, overlay.querySelector(`[data-add-sug="${i}"]`));
                if (!ok) break;
            }
            const allAdded = list.every(c => c && c._added);
            if (allAdded) close();
            else { e.target.disabled = false; e.target.textContent = 'Review all'; }
        });
    }

    // ============ HOOK INSTANCES (split-test hooks, footage in <project>/hook/) ============

    const HOOK_TYPE_META = { animation: { icon: '🎞️', label: 'Animation' }, practical: { icon: '🎯', label: 'Practical' } };

    // A hook instance can carry MULTIPLE footage assets. Canonical store is
    // h.videos = [{path,name}]; legacy single videoPath/videoName is migrated in.
    function hookVideos(h) {
        if (Array.isArray(h.videos) && h.videos.length) return h.videos;
        if (h.videoPath) return [{ path: h.videoPath, name: h.videoName || h.videoPath.split('/').pop() }];
        return [];
    }

    function hookInstanceRowHtml(v, h, i) {
        const typed = !!h.type;
        return `<div class="wsp-hooki" data-hooki="${escAttr(h.id)}">
            <div class="wsp-hooki-head">
                <span class="wsp-hint" style="font-style:normal;font-weight:800;">Hook #${i + 1}</span>
                <select data-hooki-type="${escAttr(h.id)}" class="wsp-inline-select">
                    <option value="" ${!h.type ? 'selected' : ''}>pick type…</option>
                    <option value="animation" ${h.type === 'animation' ? 'selected' : ''}>🎞️ Animation</option>
                    <option value="practical" ${h.type === 'practical' ? 'selected' : ''}>🎯 Practical</option>
                </select>
                <button class="wsp-mini-btn danger" data-hooki-del="${escAttr(h.id)}">✕</button>
            </div>
            <textarea data-hooki-text="${escAttr(h.id)}" class="wsp-hooki-text" placeholder="Hook LINE — the spoken/on-screen opening words…">${escHtml(h.text || h.label || '')}</textarea>
            <textarea data-hooki-visual="${escAttr(h.id)}" class="wsp-hooki-visual" placeholder="Opening VISUAL — what's literally on screen in the first 1–3s (action/impact/reveal)…">${escHtml(h.visual || '')}</textarea>
            ${typed ? `<div data-deliv-stage="${h.type === 'animation' ? 'animation' : 'hookfilm'}">
            ${hookVideos(h).map((vid, vi) => `<div class="wsp-row" style="border-left: 3px solid ${h.type === 'animation' ? '#4a9eff' : '#e8a020'}">
                    <span class="wsp-row-name">${icon(h.type === 'animation' ? 'animation' : 'hookfilm', 'wsp-row-ic')} ${escHtml(vid.name || vid.path.split('/').pop())} <span class="wsp-hint">linked ✓</span></span>
                    <button class="wsp-mini-btn" data-hooki-open="${escAttr(h.id)}" data-vi="${vi}">▶ Open</button>
                    <button class="wsp-mini-btn danger" data-hooki-unlink="${escAttr(h.id)}" data-vi="${vi}">✕ Unlink</button>
                </div>`).join('')}
            <div class="wsp-add-row wsp-hooki-media" data-hooki-media="${escAttr(h.id)}" data-empty="1">
                <span class="wsp-hint">${v.project ? 'loading footage controls…' : 'select a Channel Project to attach footage'}</span>
            </div>
            </div>` : ''}
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
            hook: (hooks.find(h => (h.text || '').trim()) || {}).text || '',   // keep v.hook in sync (first phrasing) for back-compat
            hookType: '', hookVideoPath: '', hookVideoName: '',
            status: normalizedStatus(fresh || { status: 'pipeline' })
        });
    }

    // Animation assets — the 3D models / reference files the animator needs.
    // Either tick "no assets needed" or upload them to <project>/animation/assets/.
    function initAnimAssets(v) {
        const get = (id) => document.getElementById(id);
        const cb = get('wsp-anim-nomodels');
        const body = get('wsp-anim-assets-body');
        if (cb) cb.addEventListener('change', async (e) => {
            if (body) body.style.display = e.target.checked ? 'none' : '';
            await VideoService.update(v.id, { animNoModels: e.target.checked }).catch(() => {});
        });
        const animAssets = () => (VideoService.getById(v.id) || v).animAssets || [];
        const list = get('wsp-anim-asset-list');
        const rerenderList = () => {
            if (!list) return;
            list.innerHTML = animAssets().map((a, i) => `<div class="wsp-row"><span class="wsp-row-name">${icon('cad', 'wsp-row-ic')} ${escHtml(a.name || (a.path || '').split('/').pop())}</span><button class="wsp-mini-btn" data-anim-asset-open="${i}">▶ Open</button><button class="wsp-mini-btn danger" data-anim-asset-del="${i}">✕</button></div>`).join('');
            bindRows();
        };
        const bindRows = () => {
            list && list.querySelectorAll('[data-anim-asset-open]').forEach(b => b.addEventListener('click', () => {
                const a = animAssets()[Number(b.dataset.animAssetOpen)];
                if (a && a.path) openFilePreview(a.path, a.name);
            }));
            list && list.querySelectorAll('[data-anim-asset-del]').forEach(b => b.addEventListener('click', async () => {
                const next = animAssets().filter((_, i) => i !== Number(b.dataset.animAssetDel));
                await VideoService.update(v.id, { animAssets: next }).catch(() => {});
                rerenderList();
            }));
        };
        bindRows();
        const upBtn = get('wsp-anim-asset-up');
        if (upBtn) upBtn.addEventListener('click', async () => {
            const input = get('wsp-anim-asset-file');
            const files = input && input.files ? [...input.files] : [];
            if (!files.length) { alert('Choose one or more asset files first.'); return; }
            const fresh = VideoService.getById(v.id) || v;
            if (!fresh.project) { alert('Select a Channel Project first.'); return; }
            const root = await dropboxRootPath();
            const folder = `${root}/${fresh.project}/animation/assets`;
            const bar = uploadProgressBar(upBtn.parentElement, files[0].name);
            try {
                const added = [];
                for (const file of files) { const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress); added.push({ path: meta.path_display || meta.path_lower, name: meta.name || file.name }); }
                await VideoService.update(v.id, { animAssets: [...animAssets(), ...added] }).catch(() => {});
                bar.stage('Done ✓'); toast(`🎞️ ${added.length} asset${added.length === 1 ? '' : 's'} → animation/assets`);
                rerenderList();
            } catch (e) { alert('Upload failed: ' + e.message); }
        });
    }

    function bindHookInstances(v, root, rerender) {
        root.querySelector('#wsp-add-hooki')?.addEventListener('click', async () => {
            const hooks = hooksWithEdits(v.id);
            hooks.push({ id: 'h' + Math.random().toString(36).slice(2, 10), type: '', text: '', label: '', videoPath: '', videoName: '' });
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
        root.querySelectorAll('[data-hooki-text]').forEach(inp => {
            let t = null;
            const save = async () => {
                const hooks = hooksWithEdits(v.id);
                const h = hooks.find(x => x.id === inp.dataset.hookiText);
                if (!h) return;
                h.text = inp.value;
                await saveHooks(v.id, hooks);
            };
            inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 800); });
            inp.addEventListener('blur', () => { clearTimeout(t); save(); });
        });
        root.querySelectorAll('[data-hooki-visual]').forEach(inp => {
            let t = null;
            const save = async () => {
                const hooks = hooksWithEdits(v.id);
                const h = hooks.find(x => x.id === inp.dataset.hookiVisual);
                if (!h) return;
                h.visual = inp.value;
                await saveHooks(v.id, hooks);
            };
            inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 800); });
            inp.addEventListener('blur', () => { clearTimeout(t); save(); });
        });
        root.querySelectorAll('[data-hooki-del]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Remove this hook instance? (Any linked file stays in Dropbox.)')) return;
            await saveHooks(v.id, hooksWithEdits(v.id).filter(x => x.id !== b.dataset.hookiDel));
            rerender();
        }));
        root.querySelectorAll('[data-hooki-open]').forEach(b => b.addEventListener('click', () => {
            const h = hooksWithEdits(v.id).find(x => x.id === b.dataset.hookiOpen);
            if (!h) return;
            const vid = hookVideos(h)[+b.dataset.vi || 0];
            if (vid) openFilePreview(vid.path, vid.name);
        }));
        root.querySelectorAll('[data-hooki-unlink]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Unlink this hook video? (The file stays in Dropbox.)')) return;
            const hooks = hooksWithEdits(v.id);
            const h = hooks.find(x => x.id === b.dataset.hookiUnlink);
            if (!h) return;
            const list = hookVideos(h).slice();
            list.splice(+b.dataset.vi || 0, 1);
            h.videos = list;
            h.videoPath = list[0] ? list[0].path : '';   // keep legacy primary in sync
            h.videoName = list[0] ? list[0].name : '';
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
        // Animation-type footage lives in <project>/animation/, practical in <project>/hook/.
        const subFor = (h) => (h && h.type === 'animation') ? 'animation' : 'hook';
        const listFolder = async (sub) => {
            try {
                const r = await fetch('/api/dropbox/list_folder', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: `${rootPath}/${v.project}/${sub}` })
                });
                const data = await r.json();
                return Array.isArray(data.entries) ? data.entries.filter(e => e['.tag'] === 'file') : [];
            } catch (e) { return []; }
        };
        const [hookFiles, animFiles] = await Promise.all([listFolder('hook'), listFolder('animation')]);
        const files = [...hookFiles, ...animFiles];
        if (!root.isConnected) return; // user navigated away

        pending.forEach(el => {
            const hid = el.dataset.hookiMedia;
            el.innerHTML = `
                ${files.length ? `<select data-hooki-pick="${escAttr(hid)}" class="wsp-inline-select"><option value="">Link existing footage…</option>${files.map(f => `<option value="${escAttr(f.path_display || f.path_lower)}">${escHtml(f.name)}</option>`).join('')}</select>` : ''}
                <input type="file" data-hooki-file="${escAttr(hid)}" accept="video/*" multiple style="font-size:11px;flex:1 1 140px;">
                <button class="wsp-mini-btn done" data-hooki-up="${escAttr(hid)}">⬆ Upload</button>`;
        });

        const setFootage = async (hid, path, name) => {
            const hooks = hooksWithEdits(v.id);
            const h = hooks.find(x => x.id === hid);
            if (!h) return;
            const list = hookVideos(h).slice();
            if (!list.some(x => x.path === path)) list.push({ path, name });   // append, allow many
            h.videos = list;
            h.videoPath = list[0] ? list[0].path : '';   // keep legacy primary in sync
            h.videoName = list[0] ? list[0].name : '';
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
            const files = input && input.files ? [...input.files] : [];
            if (!files.length) { alert('Choose one or more video files first.'); return; }
            const h = hooksWithEdits(v.id).find(x => x.id === hid);
            const sub = subFor(h);   // animation → animation/, practical → hook/
            const rowEl = root.querySelector(`[data-hooki-media="${hid}"]`);
            const bar = uploadProgressBar(rowEl, files[0].name);
            try {
                const added = [];
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (files.length > 1) bar.stage(`Uploading ${i + 1}/${files.length}: ${file.name}`);
                    const meta = await uploadToDropbox(`${rootPath}/${v.project}/${sub}/${file.name}`, file, bar.progress);
                    added.push({ path: meta.path_display || meta.path_lower, name: meta.name || file.name });
                }
                bar.stage('Linking to this hook…');
                const hooks = hooksWithEdits(v.id);
                const h2 = hooks.find(x => x.id === hid);
                if (h2) {
                    const list = hookVideos(h2).slice();
                    for (const it of added) if (!list.some(x => x.path === it.path)) list.push(it);   // append all
                    h2.videos = list;
                    h2.videoPath = list[0] ? list[0].path : '';   // keep legacy primary in sync
                    h2.videoName = list[0] ? list[0].name : '';
                    await saveHooks(v.id, hooks);
                }
                toast(`${sub === 'animation' ? '🎞️ animation' : '🪝 hook'} ${added.length} file${added.length === 1 ? '' : 's'} → ${v.project}/${sub}`);
                rerender();
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
    // ===== Dropbox upload: single-shot for small files, chunked CONCURRENT
    // upload sessions for large ones. Chunks upload in parallel, each retries on
    // failure, and progress is aggregated across all of them — no 150 MB cap, no
    // whole-file server buffering, no stall at "100%". =====
    const DBX_CHUNK = 16 * 1024 * 1024;       // 16 MB — must be a multiple of 4 MB for concurrent sessions
    const DBX_FOURMB = 4 * 1024 * 1024;       // concurrent-session append alignment
    const DBX_SIMPLE_MAX = 100 * 1024 * 1024; // ≤ 100 MB → one fast request (Dropbox single-shot caps at 150 MB).
                                              // Covers normal clips; only large final videos use the chunked path.
    const DBX_CONCURRENCY = 4;                // parallel chunks in flight

    // Stamp the Supabase bearer token onto a raw XHR (the fetch wrapper that does
    // this automatically doesn't cover XHR, which uploads use for progress).
    function authHeader(xhr) {
        const tok = (typeof window.getAuthToken === 'function') ? window.getAuthToken() : null;
        if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
    }

    function uploadToDropbox(destPath, file, onProgress) {
        return (file.size > DBX_SIMPLE_MAX)
            ? uploadChunked(destPath, file, onProgress)
            : uploadSimple(destPath, file, onProgress);
    }

    // One XHR with up to 2 retries (exponential-ish backoff).
    function uploadSimple(destPath, file, onProgress, attempt) {
        attempt = attempt || 0;
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/dropbox/upload?path=${encodeURIComponent(destPath)}`);
            authHeader(xhr);   // raw XHR bypasses the fetch wrapper — stamp the token
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
        }).catch(err => {
            if (attempt < 2) return new Promise(r => setTimeout(r, 700 * (attempt + 1))).then(() => uploadSimple(destPath, file, onProgress, attempt + 1));
            throw err;
        });
    }

    // POST one chunk to the append endpoint, retrying up to 3× on failure.
    function putChunk(sessionId, offset, blob, onChunkProgress) {
        return new Promise((resolve, reject) => {
            const tryOnce = (n) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `/api/dropbox/session/append?session_id=${encodeURIComponent(sessionId)}&offset=${offset}`);
                authHeader(xhr);
                xhr.upload.onprogress = (e) => { if (e.lengthComputable && onChunkProgress) onChunkProgress(e.loaded); };
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) { if (onChunkProgress) onChunkProgress(blob.size); resolve(); }
                    else if (n < 3) setTimeout(() => tryOnce(n + 1), 600 * n);
                    else reject(new Error(`chunk @${offset} failed (${xhr.status})`));
                };
                xhr.onerror = () => { if (n < 3) setTimeout(() => tryOnce(n + 1), 600 * n); else reject(new Error(`chunk @${offset} network error`)); };
                xhr.send(blob);
            };
            tryOnce(1);
        });
    }

    async function uploadChunked(destPath, file, onProgress) {
        const startRes = await fetch('/api/dropbox/session/start', { method: 'POST' });
        if (!startRes.ok) throw new Error('could not start upload session');
        const sessionId = (await startRes.json()).session_id;
        if (!sessionId) throw new Error('upload session id missing');

        // CONCURRENT sessions require every APPEND to be a multiple of 4 MB; the
        // final (non-aligned) tail goes in the finish call instead. So append the
        // largest 4 MB-aligned prefix in 16 MB chunks, and keep a (0, 4 MB] tail.
        let appendBytes = Math.floor(file.size / DBX_FOURMB) * DBX_FOURMB;
        if (appendBytes >= file.size) appendBytes = Math.max(0, file.size - DBX_FOURMB);  // always leave a non-empty tail
        const tail = file.slice(appendBytes, file.size);

        const chunks = [];
        for (let off = 0; off < appendBytes; off += DBX_CHUNK) chunks.push({ offset: off, blob: file.slice(off, Math.min(off + DBX_CHUNK, appendBytes)) });

        const loaded = new Array(chunks.length).fill(0);
        const report = () => { if (onProgress) onProgress(loaded.reduce((a, b) => a + b, 0), file.size); };

        // Bounded-concurrency worker pool over the (4 MB-aligned) chunk list.
        let next = 0, failed = null;
        const worker = async () => {
            while (next < chunks.length && !failed) {
                const i = next++;
                try { await putChunk(sessionId, chunks[i].offset, chunks[i].blob, (n) => { loaded[i] = n; report(); }); }
                catch (e) { failed = e; }
            }
        };
        if (chunks.length) await Promise.all(Array.from({ length: Math.min(DBX_CONCURRENCY, chunks.length) }, worker));
        if (failed) throw failed;

        // Finish carries the tail bytes at offset = appendBytes (closes + commits).
        const finRes = await fetch(`/api/dropbox/session/finish?session_id=${encodeURIComponent(sessionId)}&offset=${appendBytes}&path=${encodeURIComponent(destPath)}`, { method: 'POST', body: tail });
        let meta;
        try { meta = await finRes.json(); } catch (e) { throw new Error(`finish failed (${finRes.status})`); }
        if (!finRes.ok || !(meta.path_display || meta.path_lower)) throw new Error(meta.error_summary || meta.error || `finish failed (${finRes.status})`);
        if (onProgress) onProgress(file.size, file.size);
        return meta;
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
        let lastT = Date.now(), lastLoaded = 0, ema = 0;
        return {
            progress(loaded, total) {
                const pct = Math.min(100, Math.round(loaded / total * 100));
                fill.style.width = pct + '%';
                const now = Date.now(), dt = (now - lastT) / 1000;
                if (dt > 0.25) { const inst = Math.max(0, (loaded - lastLoaded)) / dt; ema = ema ? ema * 0.7 + inst * 0.3 : inst; lastT = now; lastLoaded = loaded; }
                const spd = ema > 0 ? (ema / 1048576).toFixed(1) + ' MB/s' : '';
                const etaSec = ema > 0 ? Math.round((total - loaded) / ema) : null;
                const eta = etaSec == null ? '' : etaSec >= 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`;
                label.textContent = pct >= 100
                    ? 'Finalizing…'
                    : `${pct}% · ${fmt(loaded)}/${fmt(total)}${spd ? ' · ' + spd : ''}${eta ? ' · ' + eta + ' left' : ''}`;
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

    // ============ UNIVERSAL FILE PREVIEW ============
    // Opens almost any file inline — images, video, audio, PDF, text/code, and
    // STL 3D models (via Three.js). Anything else gets a clean download card.
    const PREVIEW_TYPES = {
        image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
        video: ['mp4', 'mov', 'webm', 'm4v', 'ogv'],
        audio: ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'],
        pdf: ['pdf'],
        text: ['txt', 'md', 'markdown', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'csv', 'tsv', 'log', 'xml', 'html', 'css', 'scss', 'yml', 'yaml', 'c', 'cpp', 'h', 'hpp', 'java', 'rb', 'go', 'rs', 'sh', 'sql', 'ino', 'gcode'],
        model3d: ['stl']
    };
    function fileExt(name) { return (String(name || '').split('.').pop() || '').toLowerCase(); }
    function previewKind(name) { const e = fileExt(name); for (const k in PREVIEW_TYPES) if (PREVIEW_TYPES[k].includes(e)) return k; return 'other'; }

    async function openFilePreview(path, name) {
        if (!path) { alert('No file to preview.'); return; }
        name = name || (path.split('/').pop());
        const kind = previewKind(name);
        const overlay = document.createElement('div');
        overlay.className = 'wsp-picker-overlay'; overlay.style.display = 'flex';
        overlay.innerHTML = `<div class="wsp-picker wsp-preview-modal">
            <div class="wsp-picker-header">
                <span class="wsp-preview-name">${escHtml(name)} <span class="wsp-hint">.${escHtml(fileExt(name)) || 'file'}</span></span>
                <span><button class="wsp-mini-btn" data-dl>↗ Open / Download</button> <button class="wsp-picker-close" data-close>✕</button></span>
            </div>
            <div class="wsp-preview-body" id="wsp-preview-body"><div class="wsp-preview-loading"><span class="wsp-spin"></span> Loading…</div></div>
        </div>`;
        let alive = true;
        const close = () => { alive = false; overlay.remove(); };
        (container.querySelector('.workshop-panel') || container).appendChild(overlay);
        overlay.querySelector('[data-close]').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        const body = overlay.querySelector('#wsp-preview-body');

        let link = null;
        try { const r = await fetch('/api/dropbox/get_temporary_link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }); link = (await r.json()).link; } catch (e) {}
        if (!alive) return;
        if (!link) { body.innerHTML = '<div class="wsp-preview-loading" style="color:#c0392b">Could not load this file.</div>'; return; }
        const dl = () => window.open(link, '_blank');
        overlay.querySelector('[data-dl]').addEventListener('click', dl);

        if (kind === 'image') body.innerHTML = `<img class="wsp-preview-img" src="${escAttr(link)}" alt="${escAttr(name)}">`;
        else if (kind === 'video') body.innerHTML = `<video class="wsp-preview-media" src="${escAttr(link)}" controls autoplay playsinline></video>`;
        else if (kind === 'audio') body.innerHTML = `<div style="padding:30px;width:100%;"><audio style="width:100%;" src="${escAttr(link)}" controls autoplay></audio></div>`;
        else if (kind === 'pdf') body.innerHTML = `<iframe class="wsp-preview-frame" src="${escAttr(link)}"></iframe>`;
        else if (kind === 'text') {
            try { const t = await (await fetch(link)).text(); if (alive) body.innerHTML = `<pre class="wsp-preview-text">${escHtml(t.slice(0, 300000))}</pre>`; }
            catch (e) { if (alive) body.innerHTML = '<div class="wsp-preview-loading">Could not load text.</div>'; }
        } else if (kind === 'model3d') { renderStlPreview(body, link, () => alive); }
        else body.innerHTML = `<div class="wsp-preview-other"><div class="wsp-preview-other-ic">📄</div><div>No inline preview for <b>.${escHtml(fileExt(name))}</b> files.</div><button class="wsp-mini-btn done" data-dl2>↗ Open / Download</button></div>`;
        body.querySelector('[data-dl2]')?.addEventListener('click', dl);
    }

    // STL 3D viewer — Three.js loaded on demand via the page's import map.
    async function renderStlPreview(host, link, isAlive) {
        host.innerHTML = '<div class="wsp-preview-loading"><span class="wsp-spin"></span> Loading 3D model…</div>';
        try {
            const THREE = await import('three');
            const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
            const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
            const buf = await (await fetch(link)).arrayBuffer();
            if (!isAlive()) return;
            const geo = new STLLoader().parse(buf);
            geo.computeVertexNormals(); geo.center(); geo.computeBoundingSphere();
            const rad = (geo.boundingSphere && geo.boundingSphere.radius) || 50;
            host.innerHTML = '';
            const w = host.clientWidth || 640, h = Math.max(380, host.clientHeight || 420);
            const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf3efe6);
            const cam = new THREE.PerspectiveCamera(50, w / h, rad / 100, rad * 100);
            cam.position.set(rad * 2, rad * 1.6, rad * 2);
            const renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(w, h); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            host.appendChild(renderer.domElement);
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a8c2a, metalness: 0.15, roughness: 0.55 }));
            scene.add(mesh);
            scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.15));
            const dlight = new THREE.DirectionalLight(0xffffff, 0.85); dlight.position.set(1, 1.4, 1); scene.add(dlight);
            const controls = new OrbitControls(cam, renderer.domElement); controls.enableDamping = true; controls.update();
            (function loop() { if (!isAlive() || !document.body.contains(host)) { renderer.dispose(); return; } requestAnimationFrame(loop); controls.update(); renderer.render(scene, cam); })();
        } catch (e) {
            console.warn('STL preview failed', e);
            host.innerHTML = `<div class="wsp-preview-other"><div class="wsp-preview-other-ic">🧊</div><div>Couldn't render this 3D model.</div><button class="wsp-mini-btn done" data-dl2>↗ Open / Download</button></div>`;
            host.querySelector('[data-dl2]')?.addEventListener('click', () => window.open(link, '_blank'));
        }
    }

    const MEDIA_SECTIONS = {
        vo: { elId: 'wsp-vo-section', folder: 'vo', pathField: 'voPath', nameField: 'voName', accept: 'audio/*,video/*', icon: '🎙️', iconName: 'voiceover', noun: 'voiceover', color: '#8e44ad' },
        // Music: optional, not tied to any stage. A pasted song LINK or an uploaded
        // audio/video file — purely a place to stash the track for a video.
        music: { elId: 'wsp-music-section', folder: 'music', pathField: 'musicPath', nameField: 'musicName', accept: 'audio/*,video/*', icon: '🎵', iconName: 'voiceover', noun: 'music', color: '#16a085', allowUrl: true, noStage: true }
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
            // A linked item can be an external URL (music links), or a Dropbox file
            // that's audio (inline-play) or video (open in a tab).
            const isUrl = /^https?:\/\//i.test(linkedPath);
            const isAudio = !isUrl && !VIDEO_EXTS.includes((name.split('.').pop() || '').toLowerCase());
            el.innerHTML = `
                <div class="wsp-row" style="border-left: 3px solid ${cfg.color}">
                    <span class="wsp-row-name">${icon(cfg.iconName || 'inventory', 'wsp-row-ic')} ${escHtml(name)} <span class="wsp-hint">${isUrl ? 'linked song 🔗' : 'linked ✓'}</span></span>
                    <button class="wsp-mini-btn" id="${cfg.elId}-play">${isUrl ? '🔗 Open link' : (isAudio ? '▶ Play' : '▶ Open')}</button>
                    <button class="wsp-mini-btn danger" id="${cfg.elId}-unlink">✕ Unlink</button>
                    ${isAudio ? `<audio id="${cfg.elId}-audio" style="display:none"></audio>` : ''}
                </div>`;
            const playBtn = document.getElementById(`${cfg.elId}-play`);
            playBtn.addEventListener('click', async () => {
                if (isUrl) { window.open(linkedPath, '_blank', 'noopener'); return; }
                if (!isAudio) { openFilePreview(linkedPath, name); return; }
                playBtn.disabled = true;
                try {
                    const r = await fetch('/api/dropbox/get_temporary_link', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: linkedPath })
                    });
                    const data = await r.json();
                    if (!data.link) throw new Error(data.error_summary || 'no link');
                    {
                        const audio = document.getElementById(`${cfg.elId}-audio`);
                        if (!audio.src) audio.src = data.link;
                        if (audio.paused) { audio.play(); playBtn.textContent = '⏸ Pause'; }
                        else { audio.pause(); playBtn.textContent = '▶ Play'; }
                        audio.onended = () => { playBtn.textContent = '▶ Play'; };
                    }
                } catch (e) {
                    alert(`Could not load the ${cfg.noun} from Dropbox: ` + e.message);
                } finally {
                    playBtn.disabled = false;
                }
            });
            document.getElementById(`${cfg.elId}-unlink`).addEventListener('click', async () => {
                if (!confirm(`Unlink this ${cfg.noun}? (Any uploaded file stays in Dropbox.)`)) return;
                await VideoService.update(v.id, cfg.noStage ? { [cfg.pathField]: '', [cfg.nameField]: '' } : { [cfg.pathField]: '', [cfg.nameField]: '', status: normalizedStatus(v) });
                rerenderEditor(v.id);
            });
            return;
        }

        // --- No project + no URL option: deterministic bottleneck, nothing to do.
        //     (Music allows a URL even with no project, so it doesn't bail here.) ---
        if (!v.project && !cfg.allowUrl) return;

        // --- No file yet: offer a URL link (if allowed) + existing files / upload ---
        const root = v.project ? await dropboxRootPath() : '';
        const folder = v.project ? `${root}/${v.project}/${cfg.folder}` : '';
        let files = [];
        if (v.project) {
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
        }

        // The drop-down editor has no selectedVideo — what matters is whether
        // OUR element is still mounted (a re-render/navigation replaces it)
        if (!el.isConnected) return;

        const urlRow = cfg.allowUrl ? `<div class="wsp-add-row">
                <input type="url" id="${cfg.elId}-url" placeholder="Paste a song link (YouTube, Spotify, Drive, direct file URL…)" style="font-size:11.5px;flex:1 1 220px;">
                <button class="wsp-mini-btn done" id="${cfg.elId}-urlsave">🔗 Link</button>
            </div>` : '';
        const fileRows = v.project ? `
            ${files.length ? `<div class="wsp-add-row">
                <select id="${cfg.elId}-pick">
                    <option value="">Link an existing file from ${escHtml(v.project)}/${cfg.folder}…</option>
                    ${files.map(f => `<option value="${escAttr(f.path_display || f.path_lower)}">${escHtml(f.name)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="wsp-add-row">
                <input type="file" id="${cfg.elId}-file" accept="${cfg.accept}" multiple style="font-size:11.5px;flex:1 1 180px;">
                <button class="wsp-mini-btn done" id="${cfg.elId}-upload">⬆ Upload & link</button>
            </div>
            <div class="wsp-hint">Uploads go straight to Dropbox: ${escHtml(folder)}/ (folder is created automatically).</div>`
            : (cfg.allowUrl ? `<div class="wsp-hint">Link a Channel Project to also upload a file — or just paste a link above.</div>` : '');
        el.innerHTML = urlRow + fileRows;

        const urlSave = document.getElementById(`${cfg.elId}-urlsave`);
        if (urlSave) urlSave.addEventListener('click', async () => {
            const inp = document.getElementById(`${cfg.elId}-url`);
            const u = (inp.value || '').trim();
            if (!u) { alert('Paste a link first.'); return; }
            if (!/^https?:\/\//i.test(u)) { alert('That doesn’t look like a link — it should start with http:// or https://'); return; }
            let nm = 'Linked song';
            try { const p = new URL(u); nm = decodeURIComponent(p.pathname.split('/').pop() || '') || p.hostname; } catch (e) {}
            await VideoService.update(v.id, { [cfg.pathField]: u, [cfg.nameField]: nm });
            rerenderEditor(v.id);
        });

        const pick = document.getElementById(`${cfg.elId}-pick`);
        if (pick) pick.addEventListener('change', async () => {
            if (!pick.value) return;
            const name = pick.options[pick.selectedIndex].textContent;
            await VideoService.update(v.id, cfg.noStage ? { [cfg.pathField]: pick.value, [cfg.nameField]: name } : { [cfg.pathField]: pick.value, [cfg.nameField]: name, status: normalizedStatus(v) });
            rerenderEditor(v.id);
        });
        const upBtn = document.getElementById(`${cfg.elId}-upload`);
        if (upBtn) upBtn.addEventListener('click', async () => {
            const input = document.getElementById(`${cfg.elId}-file`);
            const files = input && input.files ? [...input.files] : [];
            if (!files.length) { alert(`Choose one or more files first.`); return; }
            const bar = uploadProgressBar(el, files[0].name);
            try {
                let first = null;
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (files.length > 1) bar.stage(`Uploading ${i + 1}/${files.length}: ${file.name}`);
                    const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress);
                    if (!first) first = { path: meta.path_display || meta.path_lower, name: meta.name || file.name };
                }
                bar.stage('Linking to this video…');
                await VideoService.update(v.id, {
                    [cfg.pathField]: first.path,
                    [cfg.nameField]: first.name,
                    status: normalizedStatus(v)
                });
                bar.stage('Done ✓');
                toast(`${cfg.icon} ${files.length} ${cfg.noun}${files.length === 1 ? '' : 's'} uploaded to ${v.project}/${cfg.folder}`);
                rerenderEditor(v.id);
            } catch (e) {
                console.warn(`${cfg.noun} upload failed`, e);
                alert(`${cfg.noun} upload failed: ` + e.message);
                rerenderEditor(v.id); // restores the pick/upload controls
            }
        });
    }

    // ===== EDITING — three final-video deliverables → <project>/final videos/ =====
    const EDIT_SLOTS = [
        { key: 'full', label: 'Full video — subtitles + graphics' },
        { key: 'nosubs', label: 'Version without subtitles & graphics' },
        { key: 'nomusic', label: 'Version without music' }
    ];
    async function initEditSlots(v) {
        if (!document.getElementById('wsp-edit-full') || !v.project) return;
        const root = await dropboxRootPath();
        const folder = `${root}/${v.project}/final videos`;
        const setSlot = async (key, val) => {
            const fresh = VideoService.getById(v.id) || v;
            const finalVideos = { ...(fresh.finalVideos || {}) };
            if (val) finalVideos[key] = val; else delete finalVideos[key];
            await VideoService.update(v.id, { finalVideos, status: normalizedStatus(fresh) });
        };
        EDIT_SLOTS.forEach(slot => {
            const el = document.getElementById('wsp-edit-' + slot.key);
            if (!el || !el.isConnected) return;
            const cur = (v.finalVideos || {})[slot.key];
            if (cur && cur.path) {
                el.innerHTML = `<div class="wsp-row" style="border-left:3px solid #27ae60">
                    <span class="wsp-row-name"><b>${escHtml(slot.label)}</b> · ${escHtml(cur.name || cur.path.split('/').pop())} <span class="wsp-hint">linked ✓</span></span>
                    <button class="wsp-mini-btn" data-edit-open="${slot.key}">▶ Open</button>
                    <button class="wsp-mini-btn danger" data-edit-unlink="${slot.key}">✕</button></div>`;
                el.querySelector('[data-edit-open]').addEventListener('click', () => openFilePreview(cur.path, cur.name || cur.path.split('/').pop()));
                el.querySelector('[data-edit-unlink]').addEventListener('click', async () => {
                    if (!confirm('Unlink this version? (The file stays in Dropbox.)')) return;
                    await setSlot(slot.key, null); rerenderEditor(v.id);
                });
            } else {
                el.innerHTML = `<div class="wsp-edit-slot-label">${escHtml(slot.label)}</div>
                    <div class="wsp-add-row">
                        <input type="file" id="wsp-edit-file-${slot.key}" accept="video/*" multiple style="font-size:11.5px;flex:1 1 160px;">
                        <button class="wsp-mini-btn done" data-edit-up="${slot.key}">⬆ Upload</button></div>`;
                el.querySelector('[data-edit-up]').addEventListener('click', async () => {
                    const input = document.getElementById('wsp-edit-file-' + slot.key);
                    const files = input && input.files ? [...input.files] : [];
                    if (!files.length) { alert('Choose one or more video files first.'); return; }
                    const bar = uploadProgressBar(el, files[0].name);
                    try {
                        let first = null;
                        for (let i = 0; i < files.length; i++) {
                            const file = files[i];
                            if (files.length > 1) bar.stage(`Uploading ${i + 1}/${files.length}: ${file.name}`);
                            const meta = await uploadToDropbox(`${folder}/${file.name}`, file, bar.progress);
                            if (!first) first = { path: meta.path_display || meta.path_lower, name: meta.name || file.name };
                        }
                        bar.stage('Linking to this video…');
                        await setSlot(slot.key, first);
                        bar.stage('Done ✓');
                        toast(`🎬 ${files.length} file${files.length === 1 ? '' : 's'} → ${v.project}/final videos`);
                        rerenderEditor(v.id);
                    } catch (e) { alert('Upload failed: ' + e.message); rerenderEditor(v.id); }
                });
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
        // A profile can only move work INTO a stage it has write access to.
        if (!stageWritable(targetId)) {
            alert(`You don't have write access to ${target.label}, so you can't move work there.`);
            return false;
        }

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
            if (!isOwnerUser()) {
                alert(`Can't move to ${target.label} yet — the move would skip past mandatory fields that are still empty:\n\n${missing.join('\n')}`);
                return false;
            }
            // Owner override: skip the gates and move anyway, marking the skipped
            // stages done even though their fields are empty.
            if (!confirm(`⚠️ Override — move "${v.name}" to ${target.label} anyway?\n\nThese mandatory fields are still empty and will be skipped (their stages marked done):\n\n${missing.join('\n')}\n\nThis is an owner-only override. Move it anyways?`)) return false;
        } else if (!confirm(`Move "${v.name}" to ${target.icon} ${target.label}?\nEverything before it will be marked done; ${target.label} and everything after reset to pending.`)) {
            return false;
        }

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
        // "🚫 No project" is a deliberate choice (sentinel __none__): project stays
        // empty but noProject flags it as intentional, so we show a calm note
        // instead of the "select a project" nudge.
        const rawProject = get('workshop-project')?.value || '';
        const noProject = rawProject === '__none__';
        const project = noProject ? '' : rawProject;
        const context = get('workshop-context')?.value || '';
        const deadline = get('workshop-deadline')?.value || '';
        const sponsorId = get('workshop-sponsor')?.value || '';
        // Previous-video link (priority sequence). Guard against loops.
        let previousVideoId = get('workshop-prevvideo')?.value || '';
        if (previousVideoId && (previousVideoId === v.id || videoChainIncludes(previousVideoId, v.id))) {
            previousVideoId = '';
            if (!silent) alert('That would create a loop in the sequence — pick a different previous video.');
        }
        try {
            // NOTE: do NOT write `hook` here. The hook lives in hook INSTANCES
            // (v.hooks, saved by saveHooks) — there is no #workshop-hook field, so
            // reading it would always be '' and silently wipe the hook on the video
            // AND (via saveWithIdeaSync) on the linked Library idea.
            await VideoService.saveWithIdeaSync(v.id, {
                name, project, noProject, context, deadline, sponsorId, previousVideoId,
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
        if (!canDeleteNow()) return blockDelete();
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
            // A render that throws must NOT leave the pipeline stuck on
            // "Loading…" — surface the error in the tab body so it's visible
            // (and recoverable) instead of an infinite spinner.
            const safeRender = () => {
                try { renderTab(); }
                catch (e) {
                    console.error('Workshop renderTab failed:', e);
                    const el = document.getElementById('wsp-tab-body');
                    if (el) el.innerHTML = `<div class="workshop-empty">Couldn't render the pipeline.<br><span class="wsp-hint">${escHtml(e && e.message || String(e))}</span><br><button class="wsp-mini-btn" id="wsp-render-retry">Retry</button></div>`;
                    const r = document.getElementById('wsp-render-retry');
                    if (r) r.addEventListener('click', safeRender);
                }
            };
            // Render immediately with whatever is cached so the board ALWAYS
            // appears — it is never blocked behind a slow or hung fetch. Each
            // load below is independently caught and refreshes the board as it
            // lands, so one failed/restricted route can't stall the others.
            safeRender();
            VideoService.getProjects().then(p => { dropboxProjects = p || []; safeRender(); }).catch(() => {});
            VideoService.sync().then(safeRender).catch(() => {});
            NotesService.sync().then(safeRender).catch(() => {});
            SVC().syncAll().then(safeRender).catch(() => {});
            if (opts && opts.videoId) {
                VideoService.sync().then(() => openDetail(opts.videoId)).catch(() => {});
            }
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
            showTypes = { video: true, component: true, task: true, order: true, inventory: true };
        }
    };
})();

BuildingRegistry.register('Workshop', {
    open: (bodyEl, opts) => WorkshopUI.open(bodyEl, opts),
    close: () => WorkshopUI.close()
});
