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
