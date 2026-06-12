/**
 * PipelineStages — the deterministic video pipeline graph.
 * Mirrors the flowchart designed in the Library DAG note
 * (note 2dd70089-4d1d-441b-b98e-5fadec3d0e01): every video flows
 * Ideation → Hook/Script → Decomposition → Design/Props → Ordering →
 * CAD/Manufacturing/Assembly → Artistic → Filming → Editing → Split Test → Post.
 *
 * Per-video state lives on the video record:
 *   video.stageState = { [stageId]: 'done' | 'na' }   (absent = not done)
 * A stage is READY when every upstream stage is done/na.
 * A video's "frontier" = ready stages that aren't done yet — that's where it
 * currently sits on the board (parallel branches mean it can be in 2+ places).
 */
const PipelineStages = (() => {

    // --- The stage graph (same nodes/edges as the DAG-note flowchart) ---
    const STAGES = [
        { id: 'ideate',     label: 'Video Ideation',          icon: '💡', group: 'Concept',       desc: 'Idea queued from the Library. Confirm the concept is worth making.' },
        { id: 'hook',       label: 'Hook Development',        icon: '🪝', group: 'Concept',       desc: 'Nail the hook before anything else.' },
        { id: 'script',     label: 'Script Writing',          icon: '📝', group: 'Concept',       desc: 'Write the full script.' },
        { id: 'animation',  label: 'Animation',               icon: '🎞️', group: 'Concept',       desc: 'Animations / motion previz driven by the hook.' },
        { id: 'decomp',     label: 'Decomposition',           icon: '🧩', group: 'Planning',      bottleneck: true, desc: 'BOTTLENECK — break the video down: what components? what props? what gets handed off? what does it cost?' },
        { id: 'design',     label: 'Design Research',         icon: '🔬', group: 'Planning',      desc: 'Research & engineering design for anything that must be built.' },
        { id: 'propdesign', label: 'Props / Set Design',      icon: '🎨', group: 'Planning',      desc: 'Plan props and set design.' },
        { id: 'order',      label: 'Ordering',                icon: '📦', group: 'Procurement',   bottleneck: true, desc: 'BOTTLENECK — order parts, props and materials. Check the Component Library (Inventory) first for things we already have.' },
        { id: 'cad',        label: 'CAD',                     icon: '📐', group: 'Build',         desc: 'CAD models for precision parts.' },
        { id: 'precision',  label: 'Precision Manufacturing', icon: '⚙️', group: 'Build',         desc: '3D printing / CNC / precision parts.' },
        { id: 'assembly',   label: 'Manufacturing Assembly',  icon: '🔧', group: 'Build',         desc: 'General manufacturing & assembly of the build.' },
        { id: 'artistic',   label: 'Artistic Design',         icon: '🖌️', group: 'Build',         desc: 'Paint, finish, look — make it pretty.' },
        { id: 'hookfilm',   label: 'Practical Hook Filming',  icon: '🎯', group: 'Production',    desc: 'Film the practical hook as soon as its parts are ready.' },
        { id: 'film',       label: 'Filming / Production',    icon: '🎥', group: 'Production',    desc: 'Main shoot.' },
        { id: 'edit',       label: 'Editing',                 icon: '✂️', group: 'Post',          desc: 'Edit the video.' },
        { id: 'splittest',  label: 'Split Test Trials',       icon: '🧪', group: 'Post',          desc: 'Thumbnail/title split tests before posting.' },
        { id: 'post',       label: 'Posting',                 icon: '🚀', group: 'Post',          desc: 'Publish. The video hatches into the Pen and any props it produced become reusable Inventory.' }
    ];

    // Pipeline edges from the flowchart (from → to).
    // (The flowchart's "Component Library" node is the Inventory — it's a
    // reference store, not a per-video work stage, so it lives on the board
    // as a special node but not in the per-video checklist.)
    const EDGES = [
        ['ideate', 'hook'],
        ['ideate', 'script'],
        ['hook', 'animation'],
        ['hook', 'decomp'],
        ['script', 'decomp'],
        ['decomp', 'design'],
        ['decomp', 'propdesign'],
        ['design', 'order'],
        ['propdesign', 'order'],
        ['design', 'cad'],
        ['cad', 'precision'],
        ['order', 'precision'],
        ['order', 'assembly'],
        ['order', 'hookfilm'],
        ['precision', 'assembly'],
        ['assembly', 'artistic'],
        ['artistic', 'film'],
        ['hookfilm', 'film'],
        ['animation', 'edit'],
        ['film', 'edit'],
        ['edit', 'splittest'],
        ['splittest', 'post']
    ];

    const stageById = {};
    STAGES.forEach(s => { stageById[s.id] = s; });

    const upstream = {};   // stageId -> [stageIds it depends on]
    const downstream = {}; // stageId -> [stageIds it feeds]
    STAGES.forEach(s => { upstream[s.id] = []; downstream[s.id] = []; });
    EDGES.forEach(([from, to]) => {
        upstream[to].push(from);
        downstream[from].push(to);
    });

    // --- Topological layering (longest path) for board layout ---
    const layerOf = {};
    (function computeLayers() {
        const order = [];
        const indeg = {};
        STAGES.forEach(s => { indeg[s.id] = upstream[s.id].length; });
        const queue = STAGES.filter(s => indeg[s.id] === 0).map(s => s.id);
        while (queue.length) {
            const id = queue.shift();
            order.push(id);
            downstream[id].forEach(d => { if (--indeg[d] === 0) queue.push(d); });
        }
        order.forEach(id => {
            layerOf[id] = upstream[id].length
                ? Math.max(...upstream[id].map(u => layerOf[u])) + 1
                : 0;
        });
    })();

    const LAYERS = (() => {
        const maxLayer = Math.max(...Object.values(layerOf));
        const layers = [];
        for (let i = 0; i <= maxLayer; i++) {
            layers.push(STAGES.filter(s => layerOf[s.id] === i).map(s => s.id));
        }
        return layers;
    })();

    // --- Per-video stage state helpers ---
    function stateOf(video, stageId) {
        return (video && video.stageState && video.stageState[stageId]) || '';
    }
    function isDone(video, stageId) {
        const st = stateOf(video, stageId);
        return st === 'done' || st === 'na';
    }
    // A stage is ready when all upstream stages are done/na
    function isReady(video, stageId) {
        return upstream[stageId].every(u => isDone(video, u));
    }
    // The frontier: ready stages not yet done — where the video sits right now
    function frontier(video) {
        return STAGES.filter(s => !isDone(video, s.id) && isReady(video, s.id)).map(s => s.id);
    }
    function isComplete(video) {
        return isDone(video, 'post');
    }
    function progress(video) {
        const done = STAGES.filter(s => stateOf(video, s.id) === 'done').length;
        const na = STAGES.filter(s => stateOf(video, s.id) === 'na').length;
        const total = STAGES.length - na;
        return { done, total: Math.max(total, 1), pct: Math.round((done / Math.max(total, 1)) * 100) };
    }

    // --- Causality / blocking ---
    // A video is blocked when a video it depends on isn't posted yet, or
    // when inventory it requires isn't ready. Blockers don't hard-stop the
    // user (you're the operator) — they're surfaced loudly in the UI.
    function blockers(video, allVideos, inventoryItems) {
        const out = [];
        (video.dependsOn || []).forEach(depId => {
            const dep = (allVideos || []).find(v => v.id === depId);
            if (!dep) return;
            const depPosted = dep.status === 'posted' || dep.status === 'pen' || isDone(dep, 'post');
            if (!depPosted) out.push({ kind: 'video', id: dep.id, label: dep.name, detail: 'must be finished first' });
        });
        (video.requiredInventoryIds || []).forEach(invId => {
            const item = (inventoryItems || []).find(i => i.id === invId);
            if (!item) return;
            if (item.status !== 'ready') out.push({ kind: 'inventory', id: item.id, label: item.name, detail: `not ready (${item.status || 'planned'})` });
        });
        return out;
    }

    // Legacy status mapping: old 'incubator'/'workshop' videos are simply
    // pipeline videos that haven't been touched yet — no data migration needed.
    function isInPipeline(video) {
        return video && (video.status === 'pipeline' || video.status === 'incubator' || video.status === 'workshop');
    }

    return {
        STAGES, EDGES, LAYERS,
        get: id => stageById[id] || null,
        upstreamOf: id => upstream[id] || [],
        downstreamOf: id => downstream[id] || [],
        layerOf: id => layerOf[id] ?? 0,
        stateOf, isDone, isReady, frontier, isComplete, progress, blockers, isInPipeline
    };
})();
