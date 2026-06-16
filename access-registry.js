/**
 * access-registry.js — the catalog of gateable parts of Business World.
 *
 * Building-level access is profile.buildings[]. For buildings that have internal
 * tabs/sections, profile.features[`<Building>:<section>`] restricts WHICH tabs a
 * person sees. If a building is granted but has no section restrictions, they get
 * all its sections (full building access). Adding a new building's permissions =
 * add an entry here (its tab CSS selector + section list); the generic gating and
 * the profile editor pick it up automatically.
 */
(function () {
    window.ACCESS_REGISTRY = {
        Library: {
            tabSel: '.library-tab',
            sections: [
                { id: 'notes', label: 'Ideas' },
                { id: 'freenotes', label: 'Notes' },
                { id: 'todo', label: 'To-Do' },
                { id: 'calendar', label: 'Calendar' },
                { id: 'projects', label: 'Projects' },
                { id: 'sponsors', label: 'Sponsors' },
                { id: 'ideamap', label: 'Idea Map' },
                { id: 'dagflow', label: 'DAG Flow' }
            ]
        },
        // Workshop is now the pipeline only. Per-stage (node-level) permissions
        // are defined separately (see WORKSHOP_STAGES) — granting Workshop grants
        // the pipeline; which stages/nodes a profile sees is gated per-stage.
        Workshop: { tabSel: '.wsp-tab', sections: [] },
        // The Pen's world entities are gated separately so granting another
        // building never leaks them: posted-video creatures + project flags.
        'The Pen': { tabSel: null, sections: [{ id: 'videos', label: 'Posted videos' }, { id: 'flags', label: 'Project flags' }] }
    };

    window.sectionsFor = (b) => (window.ACCESS_REGISTRY[b] && window.ACCESS_REGISTRY[b].sections) || null;

    // The pipeline stages (nodes) — kept in sync with buildings/workshop/pipeline-stages.js.
    // A profile grants each stage one of: none | read | write. This drives the
    // profile editor and the per-node gating inside the Workshop.
    window.WORKSHOP_STAGES = [
        { id: 'ideate', label: 'Video Ideation', group: 'Concept' },
        { id: 'hook', label: 'Hook Development', group: 'Concept' },
        { id: 'script', label: 'Script Writing', group: 'Concept' },
        { id: 'animation', label: 'Animation', group: 'Concept' },
        { id: 'decomp', label: 'Decomposition', group: 'Planning' },
        { id: 'design', label: 'Design Research', group: 'Planning' },
        { id: 'propdesign', label: 'Props / Set Design', group: 'Planning' },
        { id: 'cad', label: 'CAD', group: 'Planning' },
        { id: 'pcb', label: 'PCB Design', group: 'Planning' },
        { id: 'order', label: 'Ordering', group: 'Procurement' },
        { id: 'precision', label: 'Precision Manufacturing', group: 'Build' },
        { id: 'software', label: 'Software Development', group: 'Build' },
        { id: 'assembly', label: 'Manufacturing Assembly', group: 'Build' },
        { id: 'artistic', label: 'Artistic Design', group: 'Build' },
        { id: 'hookfilm', label: 'Practical Hook Filming', group: 'Production' },
        { id: 'film', label: 'Filming / Production', group: 'Production' },
        { id: 'voiceover', label: 'Voiceover', group: 'Post' },
        { id: 'edit', label: 'Editing', group: 'Post' },
        { id: 'splittest', label: 'Split Test Trials', group: 'Post' },
        { id: 'post', label: 'Posting', group: 'Post' }
    ];

    // What access does the current user have to a pipeline stage? none | read | write.
    // owner → write everywhere; Workshop not granted → none; Workshop granted with NO
    // per-stage keys → write everywhere (whole-pipeline access, backward compatible).
    window.stageAccess = function (stageId) {
        const a = window.__access;
        if (!a || a.all) return 'write';
        if (!(a.buildings || []).includes('Workshop')) return 'none';
        const feats = a.features || {};
        const keys = Object.keys(feats).filter(k => k.indexOf('Workshop:stage:') === 0);
        if (!keys.length) return 'write';
        const v = feats['Workshop:stage:' + stageId];
        return v === 'write' ? 'write' : v === 'read' ? 'read' : 'none';
    };
    window.canSeeStage = (id) => window.stageAccess(id) !== 'none';
    window.canWriteStage = (id) => window.stageAccess(id) === 'write';

    // World entities gated under "The Pen" so other buildings never leak them.
    const penEntity = (section) => {
        const a = window.__access;
        if (!a || a.all) return true;
        return (a.buildings || []).includes('The Pen') && window.sectionGranted('The Pen', section);
    };
    window.canSeePenVideos = () => penEntity('videos');   // posted-video creatures
    window.canSeePenFlags = () => penEntity('flags');     // project flags in the world

    // Field-level visibility inside a video / component (so people only see the
    // sections relevant to them). Each is data-vfield / data-cfield in the editor.
    // Stored as features["Workshop:vfield:<id>"] / ["Workshop:cfield:<id>"].
    // No keys for a kind = all of that kind's fields visible (back-compat).
    window.VIDEO_FIELDS = [
        ['sourceidea', 'Source idea'], ['waiting', 'Waiting on'], ['name', 'Video name'],
        ['deadline', 'Deadline'], ['sponsor', 'Sponsor'], ['project', 'Channel project'],
        ['progress', 'Pipeline progress'], ['context', 'Context'], ['hook', 'Hook'],
        ['script', 'Script'], ['decomp', 'Decomposition'], ['voiceover', 'Voiceover'],
        ['editing', 'Editing (final videos)']
    ];
    window.COMPONENT_FIELDS = [
        ['status', 'Stage'], ['needs', 'What it needs'], ['source', 'Type (build / order / task)'],
        ['media', 'Media'], ['cad', 'CAD file'], ['pcb', 'PCB file'],
        ['sketches', 'Sketches'], ['links', 'Assets & links'], ['notes', 'Notes']
    ];
    // Which pipeline STAGE "owns" each video field as its deliverable. A node-
    // scoped worker writes only the field its node owns and reads the rest.
    const FIELD_OWNER_STAGE = {
        context: 'ideate', hook: 'hook', script: 'script', decomp: 'decomp',
        voiceover: 'voiceover', editing: 'edit'
    };
    const isStageScopedProfile = (a) => {
        if (!a || a.all) return false;
        const feats = a.features || {};
        return Object.keys(feats).some(k => k.indexOf('Workshop:stage:') === 0);
    };
    // Field access is none | read | write. Precedence:
    //   owner → write everything
    //   explicit profile key for this field → that value (legacy `true` = write)
    //   no key but profile is node-scoped → DELIVERABLE DEFAULT: write only the
    //     field this worker's node owns, read everything else (so e.g. an animator
    //     reads context/hook/script and only writes their deliverable)
    //   no field keys + not scoped → write (full, back-compat)
    const fieldAccess = (kind, id) => {
        const a = window.__access;
        if (!a || a.all) return 'write';
        if (!(a.buildings || []).includes('Workshop')) return 'write'; // not a Workshop concern
        const feats = a.features || {}, prefix = 'Workshop:' + kind + ':';
        const keys = Object.keys(feats).filter(k => k.indexOf(prefix) === 0);
        const v = feats[prefix + id];
        if (v === true || v === 'write') return 'write';
        if (v === 'read') return 'read';
        if (v === 'none') return 'none';
        // no explicit value for this field
        if (keys.length) return 'none';                 // restricted set, not listed → hidden
        if (kind === 'vfield' && isStageScopedProfile(a)) {
            const owner = FIELD_OWNER_STAGE[id];
            if (!owner) return 'read';                  // meta fields (name/deadline/…) read for scoped workers
            return (window.canWriteStage && window.canWriteStage(owner)) ? 'write' : 'read';
        }
        return 'write';                                  // unconfigured + unscoped → full
    };
    window.videoFieldAccess = (id) => fieldAccess('vfield', id);
    window.componentFieldAccess = (id) => fieldAccess('cfield', id);
    window.videoFieldVisible = (id) => fieldAccess('vfield', id) !== 'none';
    window.componentFieldVisible = (id) => fieldAccess('cfield', id) !== 'none';
    // Open/view buttons stay clickable even in a read-only section.
    const KEEP_CLICKABLE = '[data-link-open],[data-media-open],[data-cf-open],[data-hooki-open],[data-anim-asset-open],[data-open-comp],[data-open-video],[data-expand]';
    // Hide ungranted sections; lock read-only ones (inputs disabled, only view buttons live).
    function gateFields(root, attr, access) {
        const a = window.__access;
        if (!a || a.all || !root) return;
        root.querySelectorAll('[' + attr + ']').forEach(el => {
            const acc = access(el.getAttribute(attr));
            if (acc === 'none') { el.style.display = 'none'; return; }
            el.style.display = '';
            el.classList.toggle('ag-readonly', acc === 'read');
            if (acc === 'read') gateReadSection(el);
        });
    }
    // Elements that count as real, deliverable-relevant CONTENT (so a section
    // with one of these is worth showing; otherwise it's hidden entirely).
    const CONTENT_SEL = '.ag-readtext, [data-deliv-open], .wsp-row, .wsp-media-tile, .wsp-sketch-tile, [data-anim-asset-open], [data-hooki-open], audio, img';
    // Turn a read-only section into a clean DELIVERED BRIEF — nothing more,
    // nothing less. Provided inputs become plain readable text; everything the
    // worker doesn't need (empty fields, editor instructions, dropdowns,
    // checkboxes, add/delete buttons) is removed; an empty section is hidden
    // entirely. The worker's own DELIVERABLE stays fully live.
    function gateReadSection(el) {
        // 1. mark the deliverable controls this worker IS allowed to write
        const open = [];
        el.querySelectorAll('[data-deliv-stage]').forEach(d => {
            if (window.canWriteStage && window.canWriteStage(d.getAttribute('data-deliv-stage'))) {
                d.setAttribute('data-deliv-open', '1');
                open.push(d);
            }
        });
        const inOpen = (node) => open.some(d => d.contains(node));
        // 2. text inputs → flowing text, but ONLY when provided; empty ones vanish.
        //    Empty text fields are NOT marked done, so a re-gate (after async/sync
        //    editors populate them) can still render them once they have a value.
        el.querySelectorAll('input, textarea, select, [contenteditable]').forEach(c => {
            if (inOpen(c) || c.dataset.agDone) return;
            if (c.type === 'checkbox' || c.type === 'radio') { c.dataset.agDone = '1'; const w = c.closest('label') || c; w.style.display = 'none'; return; }
            if (c.tagName === 'SELECT') { c.dataset.agDone = '1'; c.style.display = 'none'; return; }
            const val = (c.value != null ? c.value : c.textContent || '').toString().trim();
            c.style.display = 'none';
            if (val) {
                c.dataset.agDone = '1';
                const span = document.createElement('div');
                span.className = 'ag-readtext';
                span.textContent = val;
                if (c.parentNode) c.parentNode.insertBefore(span, c);
            }
        });
        // 3. hide controls/buttons they can't use (add / delete / upload), keep view buttons + deliverable
        el.querySelectorAll('button').forEach(b => {
            if (inOpen(b) || b.matches(KEEP_CLICKABLE) || b.dataset.agDone) return;
            b.dataset.agDone = '1';
            b.style.display = 'none';
        });
        // 4. strip editor instructions (the muted hint text) — they aren't a brief.
        el.querySelectorAll('.wsp-hint').forEach(h => { h.style.display = 'none'; });
        // 4b. relabel the section so it reads as a brief — clearly separating the
        //     HOOK they're delivering from the CONTEXT they have to work with.
        const READ_LABEL = { hook: 'The hook to make', context: 'Context — what you have to work with', script: 'The script', decomp: 'Components', voiceover: 'Voiceover', editing: 'Final videos to upload' };
        const fid = el.getAttribute('data-vfield') || el.getAttribute('data-cfield');
        if (fid && READ_LABEL[fid]) { const nm = el.querySelector('.wsp-sub-name'); if (nm) nm.textContent = READ_LABEL[fid]; }
        // 4c. hide nested labeled sub-blocks that have nothing in them (e.g. the
        //     animation-assets block when no assets were provided).
        el.querySelectorAll('.wsp-anim-assets').forEach(b => {
            if (!inOpen(b) && !b.querySelector('[data-anim-asset-open]')) b.style.display = 'none';
        });
        // 5. hide the whole section if there's nothing real to show (and no
        //    deliverable); re-show it if a later pass populated it.
        el.style.display = (open.length || el.querySelector(CONTENT_SEL)) ? '' : 'none';
    }
    window.applyVideoFieldGating = (root) => gateFields(root, 'data-vfield', window.videoFieldAccess);
    window.applyComponentFieldGating = (root) => gateFields(root, 'data-cfield', window.componentFieldAccess);

    // Capability flags (e.g. delete). Owner always; otherwise only if granted.
    window.hasCapability = function (cap) {
        const a = window.__access;
        if (!a || a.all) return true;
        return !!(a.features && a.features['Workshop:cap:' + cap]);
    };
    window.canDelete = () => window.hasCapability('delete');

    // Is a whole building visible to the current user?
    window.hasBuilding = function (b) {
        const a = window.__access;
        if (!a || a.all) return true;
        return (a.buildings || []).includes(b);
    };

    // Is a specific section within a building granted? (building must be granted;
    // if no section keys exist for it, all sections are granted.)
    window.sectionGranted = function (b, s) {
        const a = window.__access;
        if (!a || a.all) return true;
        if (!(a.buildings || []).includes(b)) return false;
        const feats = a.features || {};
        const keys = Object.keys(feats).filter(k => k.indexOf(b + ':') === 0);
        if (!keys.length) return true;           // building granted, unrestricted
        return !!feats[b + ':' + s];
    };

    // Hide the tabs a profile isn't granted, after a building's UI renders.
    let _gateTimer = null;
    window.applySectionGating = function (building) {
        const reg = window.ACCESS_REGISTRY[building];
        const a = window.__access;
        if (!reg || !reg.tabSel || !a || a.all) return;
        const body = document.getElementById('modal-body');
        if (!body) return;
        const tabs = body.querySelectorAll(reg.tabSel);
        if (!tabs.length) return;
        let firstVisible = null, activeHidden = false;
        tabs.forEach(t => {
            const ok = window.sectionGranted(building, t.dataset.tab);
            t.style.display = ok ? '' : 'none';
            if (ok && !firstVisible) firstVisible = t;
            if (!ok && t.classList.contains('active')) activeHidden = true;
        });
        if (activeHidden && firstVisible) firstVisible.click();
    };

    // Re-apply gating whenever a building re-renders its tabs (debounced).
    window.watchSectionGating = function (building) {
        if (window.__secObs) { window.__secObs.disconnect(); window.__secObs = null; }
        if (!window.ACCESS_REGISTRY[building] || !window.ACCESS_REGISTRY[building].tabSel) return;
        const a = window.__access;
        if (!a || a.all) return;
        const body = document.getElementById('modal-body');
        if (!body) return;
        window.applySectionGating(building);
        window.__secObs = new MutationObserver(() => {
            clearTimeout(_gateTimer);
            _gateTimer = setTimeout(() => window.applySectionGating(building), 60);
        });
        window.__secObs.observe(body, { childList: true, subtree: true });
    };
    window.stopSectionGating = function () { if (window.__secObs) { window.__secObs.disconnect(); window.__secObs = null; } };
})();
