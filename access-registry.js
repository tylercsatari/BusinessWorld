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
        Workshop: { tabSel: '.wsp-tab', sections: [] }
    };

    window.sectionsFor = (b) => (window.ACCESS_REGISTRY[b] && window.ACCESS_REGISTRY[b].sections) || null;

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
        if (!reg || !a || a.all) return;
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
        if (!window.ACCESS_REGISTRY[building]) return;
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
