/**
 * PipelineStages — the deterministic video pipeline graph.
 *
 * Design rules (so the pipeline can never deviate):
 *  - There is NO path around a bottleneck. Animation is an endpoint off Hook
 *    (have it or not — it feeds nothing), so nothing can skip Decomposition.
 *    CAD feeds Ordering (not Precision directly), so even in-house parts get
 *    validated/purchased before manufacturing.
 *  - Non-bottleneck stages run in parallel: a video sits in Hook AND Script
 *    at the same time; Design/Props/CAD all run together after Decomposition.
 *  - Deterministic checkpoints: stages auto-complete when their quantitative
 *    criterion is met (queue → Ideation done; hook text → Hook done; script
 *    text → Script done; all orders received → Ordering done). Minimal review.
 *  - Decomposition is the validation gate: completing it requires explicit
 *    yes/no decisions per branch (video.branches). Branches marked "not
 *    needed" are skipped automatically, so e.g. the CAD person only ever
 *    sees videos that truly need CAD.
 *
 * Per-video state on the record:
 *   video.stageState = { [stageId]: 'done' | 'na' }   (manual overrides)
 *   video.branches   = { [flag]: true | false }        (decomp decisions)
 * Effective state = manual override, else branch-skip ('na'), else
 * auto-criterion ('auto' — counts as done), else pending.
 */
const PipelineStages = (() => {

    // --- The stages ---
    const STAGES = [
        { id: 'ideate',     label: 'Video Ideation',          icon: '💡', group: 'Concept',     desc: 'Queued from the Library — ideation is done by definition, so it immediately fans out into Hook and Script.' },
        { id: 'hook',       label: 'Hook Development',        icon: '🪝', group: 'Concept',     desc: 'Nail the hook. Fill the Hook field whenever — the stage completes itself.' },
        { id: 'script',     label: 'Script Writing',          icon: '📝', group: 'Concept',     desc: 'Write the full script. Fill the Script field whenever — the stage completes itself.' },
        { id: 'animation',  label: 'Animation',               icon: '🎞️', group: 'Concept',     desc: 'The animated hook. When Hook Type = animation, the video waits here until the hook video is uploaded to the project\'s hook/ folder — then Editing can unlock. Feeds nothing on the build side, so it can never bypass Decomposition.' },
        { id: 'decomp',     label: 'Decomposition',           icon: '🧩', group: 'Planning',    bottleneck: true, desc: 'BOTTLENECK + validation gate — break the video down and decide exactly which branches it needs (design? props? CAD? build? …). Branches you say no to are skipped automatically.' },
        { id: 'design',     label: 'Design Research',         icon: '🔬', group: 'Planning',    desc: 'Research & engineering design. Only videos flagged as needing design land here.' },
        { id: 'propdesign', label: 'Props / Set Design',      icon: '🎨', group: 'Planning',    desc: 'Plan props and set design. Only flagged videos land here.' },
        { id: 'cad',        label: 'CAD',                     icon: '📐', group: 'Planning',    desc: 'CAD models for precision parts. Only videos flagged as needing CAD land here — no confused texts from the CAD desk.' },
        { id: 'pcb',        label: 'PCB Design',              icon: '🔌', group: 'Planning',    desc: 'Design custom circuit boards. Runs parallel to CAD after Design Research, and feeds Ordering so boards get fabbed/bought with everything else. Only videos flagged as needing a PCB land here.' },
        { id: 'order',      label: 'Ordering',                icon: '📦', group: 'Procurement', bottleneck: true, desc: 'BOTTLENECK — everything passes through here. Check the Storage Room first: if it\'s already on the shelf, don\'t buy it. Auto-completes when every order for the video is received; if nothing needs buying, marking it done IS the validation.' },
        { id: 'precision',  label: 'Precision Manufacturing', icon: '⚙️', group: 'Build',       desc: '3D printing / CNC of CAD parts. Gated behind Ordering — materials validated or bought first.' },
        { id: 'software',   label: 'Software Development',    icon: '💻', group: 'Build',       desc: 'Code / firmware for the build. Runs parallel to Precision Manufacturing and feeds into Assembly — the build comes together with both its parts and its software. Only flagged videos land here.' },
        { id: 'assembly',   label: 'Manufacturing Assembly',  icon: '🔧', group: 'Build',       desc: 'General manufacturing & assembly of the build.' },
        { id: 'artistic',   label: 'Artistic Design',         icon: '🖌️', group: 'Build',       desc: 'Paint, finish, look — make it pretty.' },
        { id: 'hookfilm',   label: 'Practical Hook Filming',  icon: '🎯', group: 'Production',  desc: 'Film the practical hook as soon as its parts arrive — a side task before the main shoot. When Hook Type = practical, the video waits here until the hook video is uploaded to the project\'s hook/ folder.' },
        { id: 'film',       label: 'Filming / Production',    icon: '🎥', group: 'Production',  desc: 'Main shoot.' },
        { id: 'voiceover',  label: 'Voiceover',               icon: '🎙️', group: 'Post',        desc: 'Deterministic gate: a voiceover file must be linked (it lives in the project\'s vo/ folder in Dropbox). No VO → the video waits here; VO linked → straight to Editing.' },
        { id: 'edit',       label: 'Editing',                 icon: '✂️', group: 'Post',        desc: 'Edit the video.' },
        { id: 'splittest',  label: 'Split Test Trials',       icon: '🧪', group: 'Post',        desc: 'Thumbnail/title split tests before posting.' },
        { id: 'post',       label: 'Posting',                 icon: '🚀', group: 'Post',        desc: 'Publish. The video hatches into the Pen and any props it produced become reusable Inventory.' }
    ];

    // --- Edges (from → to). Every connection is deliberate; anything that
    // could let a video deviate around a bottleneck has been removed. ---
    const EDGES = [
        ['ideate', 'hook'],
        ['ideate', 'script'],
        ['hook', 'animation'],        // animation is an ENDPOINT — no outgoing edges
        ['hook', 'decomp'],           // decomp needs BOTH hook and script done
        ['script', 'decomp'],
        ['decomp', 'design'],
        ['decomp', 'propdesign'],
        ['design', 'cad'],            // design feeds CAD…
        ['design', 'pcb'],            // …and PCB design (parallel to CAD)
        ['design', 'order'],
        ['propdesign', 'order'],
        ['cad', 'order'],             // …but CAD output is still bottlenecked at Ordering
        ['pcb', 'order'],             // PCB boards get fabbed/ordered through the bottleneck too
        ['order', 'precision'],       // nothing gets manufactured before Ordering clears it
        ['order', 'software'],        // dev boards/licenses get ordered too
        ['order', 'assembly'],
        ['order', 'hookfilm'],
        ['precision', 'assembly'],
        ['software', 'assembly'],     // code/firmware feeds the build — assembly needs both parts and software
        ['assembly', 'artistic'],
        ['artistic', 'film'],
        ['hookfilm', 'film'],
        ['film', 'voiceover'],        // VO gate sits between the shoot and the edit
        ['voiceover', 'edit'],
        ['animation', 'edit'],        // animated-hook gate: editors get the hook video before the edit
                                      // (cannot bypass anything — edit still needs the whole film chain via voiceover)
        ['edit', 'splittest'],
        ['splittest', 'post']
    ];

    // --- Branch gates: decomp decisions → stages they switch on/off ---
    // flag false → stage auto-'na' (skipped). 'precision' rides the cad flag:
    // no CAD model, nothing to precision-manufacture.
    const BRANCH_FLAG_FOR_STAGE = {
        animation: 'animation',
        design: 'design',
        propdesign: 'propdesign',
        cad: 'cad',
        pcb: 'pcb',
        precision: 'cad',
        software: 'software',
        assembly: 'assembly',
        artistic: 'artistic',
        hookfilm: 'hookfilm'
    };
    const BRANCH_QUESTIONS = [
        { flag: 'design',     label: '🔬 Design research needed?',        hint: 'engineering/research before building' },
        { flag: 'propdesign', label: '🎨 Props / set design needed?',     hint: 'props to plan or a set to design' },
        { flag: 'cad',        label: '📐 CAD needed?',                    hint: 'parts to model → also enables Precision Manufacturing' },
        { flag: 'pcb',        label: '🔌 PCB needed?',                    hint: 'a custom circuit board to design before ordering' },
        { flag: 'software',   label: '💻 Software needed?',               hint: 'code/firmware to develop — runs parallel to manufacturing' },
        { flag: 'assembly',   label: '🔧 Build / assembly needed?',       hint: 'something physical gets built' },
        { flag: 'artistic',   label: '🖌️ Artistic finishing needed?',    hint: 'paint / finish / look' },
        { flag: 'hookfilm',   label: '🎯 Practical hook to film?',        hint: 'a practical hook shot before the main shoot' },
        { flag: 'animation',  label: '🎞️ Animation needed?',             hint: 'endpoint off the hook — never blocks anything else' }
    ];

    // --- Deterministic auto-completion criteria (quantitative checkpoints) ---
    const AUTO_CHECKS = {
        ideate: {
            desc: 'auto: done the moment the video is queued',
            test: () => true
        },
        hook: {
            desc: 'auto: done once there is at least one hook instance with phrasing + a type (animation/practical) chosen',
            test: (v) => {
                const hs = hooksOf(v).filter(h => (h.text || h.label || '').trim() && h.type);
                return hs.length > 0;
            }
        },
        script: {
            desc: 'auto: done once the Script field has 100+ characters',
            test: (v) => ((v.script || '').trim().length >= 100)
        },
        order: {
            desc: 'auto: done once every order linked to this video is received (no orders → mark done manually to validate "nothing to buy")',
            test: (v, ctx) => {
                const orders = ((ctx && ctx.orders) || []).filter(o => o.videoId === v.id);
                return orders.length > 0 && orders.every(o => o.status === 'received');
            }
        },
        voiceover: {
            desc: 'auto: done the moment a voiceover file is linked to this video',
            test: (v) => !!(v.voPath)
        },
        animation: {
            desc: 'auto: done once every ANIMATION hook instance has its video linked',
            test: (v) => {
                const a = hooksOf(v).filter(h => h.type === 'animation');
                return a.length > 0 && a.every(h => !!h.videoPath);
            }
        },
        hookfilm: {
            desc: 'auto: done once every PRACTICAL hook instance has its video linked',
            test: (v) => {
                const p = hooksOf(v).filter(h => h.type === 'practical');
                return p.length > 0 && p.every(h => !!h.videoPath);
            }
        }
    };

    // Hook instances: split-test variants of the hook, each typed
    // (animation/practical) with its own footage file. Legacy single-hook
    // fields (hookType/hookVideoPath) read as one instance.
    function hooksOf(video) {
        if (video && Array.isArray(video.hooks) && video.hooks.length) return video.hooks;
        if (video && video.hookType) {
            return [{ id: 'legacy', type: video.hookType, label: '', videoPath: video.hookVideoPath || '', videoName: video.hookVideoName || '' }];
        }
        return [];
    }

    const stageById = {};
    STAGES.forEach(s => { stageById[s.id] = s; });

    const upstream = {};
    const downstream = {};
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

    // --- Per-video stage state ---
    // ctx (optional): { orders: [...] } — needed for the Ordering auto-check.
    function stateOf(video, stageId) {
        return (video && video.stageState && video.stageState[stageId]) || '';
    }
    function effectiveState(video, stageId, ctx) {
        const manual = stateOf(video, stageId);
        if (manual) return manual; // 'done' | 'na' — manual always wins
        const flag = BRANCH_FLAG_FOR_STAGE[stageId];
        // Branch-gated stages run ONLY when explicitly switched on — an
        // undecided branch never lands in anyone's queue.
        if (flag && !(video && video.branches && video.branches[flag] === true)) return 'na';
        const auto = AUTO_CHECKS[stageId];
        if (auto && auto.test(video, ctx)) return 'auto';
        return '';
    }
    // Skipped ('na') stages are TRANSPARENT, not "done": they pass their
    // upstream's blocking straight through. Otherwise skipping Assembly/
    // Artistic would let a video reach Filming while Precision Manufacturing
    // is still pending — a bypass around the build chain.
    function isDone(video, stageId, ctx) {
        const st = effectiveState(video, stageId, ctx);
        if (st === 'done' || st === 'auto') return true;
        if (st === 'na') return upstream[stageId].every(u => isDone(video, u, ctx));
        return false;
    }
    function isReady(video, stageId, ctx) {
        return upstream[stageId].every(u => isDone(video, u, ctx));
    }
    // The frontier: ready stages not yet done — where the video sits right now.
    // Parallel branches mean a video legitimately sits in several places at once.
    function frontier(video, ctx) {
        return STAGES.filter(s => !isDone(video, s.id, ctx) && isReady(video, s.id, ctx)).map(s => s.id);
    }
    function isComplete(video, ctx) {
        return isDone(video, 'post', ctx);
    }
    function progress(video, ctx) {
        let done = 0, skipped = 0;
        STAGES.forEach(s => {
            const st = effectiveState(video, s.id, ctx);
            if (st === 'done' || st === 'auto') done++;
            else if (st === 'na') skipped++;
        });
        const total = Math.max(STAGES.length - skipped, 1);
        return { done, total, pct: Math.round((done / total) * 100) };
    }

    // Have the decomposition branch decisions been made?
    function branchesDecided(video) {
        const b = (video && video.branches) || {};
        return BRANCH_QUESTIONS.every(q => b[q.flag] === true || b[q.flag] === false);
    }

    // --- Causality / blocking ---
    // A video can wait on: another video (not yet posted), a component (not
    // yet done) or an order (not yet received). Anything already finished is
    // never a blocker — done means done, so blockers clear themselves.
    // deps: [{ kind: 'video'|'component'|'order', id }]
    // (legacy video.dependsOn = [videoId] is still honored as video deps)
    function blockers(video, refs) {
        const { videos = [], components = [], orders = [] } = refs || {};
        const out = [];
        const videoDep = (depId) => {
            const dep = videos.find(v => v.id === depId);
            if (!dep) return;
            const depPosted = dep.status === 'posted' || dep.status === 'pen' || stateOf(dep, 'post') === 'done';
            if (!depPosted) out.push({ kind: 'video', id: dep.id, label: dep.name, detail: 'video not finished yet' });
        };
        (video.dependsOn || []).forEach(videoDep);
        (video.deps || []).forEach(d => {
            if (!d || !d.id) return;
            if (d.kind === 'video') videoDep(d.id);
            else if (d.kind === 'component') {
                const c = components.find(x => x.id === d.id);
                if (c && c.status !== 'done') out.push({ kind: 'component', id: c.id, label: c.name, detail: `component still in ${c.status || 'design'}` });
            } else if (d.kind === 'order') {
                const o = orders.find(x => x.id === d.id);
                if (o && o.status !== 'received') out.push({ kind: 'order', id: o.id, label: o.name, detail: `order ${o.status || 'needed'}` });
            }
        });
        return out;
    }

    // Legacy status mapping: old 'incubator'/'workshop' videos are simply
    // pipeline videos that haven't been touched yet — no data migration needed.
    function isInPipeline(video) {
        return video && (video.status === 'pipeline' || video.status === 'incubator' || video.status === 'workshop');
    }

    // Transitive closures — used by the manual "move to stage" veto
    function ancestorsOf(stageId) {
        const out = new Set();
        const walk = (id) => upstream[id].forEach(u => { if (!out.has(u)) { out.add(u); walk(u); } });
        walk(stageId);
        return [...out];
    }
    function descendantsOf(stageId) {
        const out = new Set();
        const walk = (id) => downstream[id].forEach(d => { if (!out.has(d)) { out.add(d); walk(d); } });
        walk(stageId);
        return [...out];
    }

    return {
        STAGES, EDGES, LAYERS, BRANCH_QUESTIONS, BRANCH_FLAG_FOR_STAGE,
        get: id => stageById[id] || null,
        upstreamOf: id => upstream[id] || [],
        downstreamOf: id => downstream[id] || [],
        ancestorsOf, descendantsOf,
        layerOf: id => layerOf[id] ?? 0,
        autoDesc: id => (AUTO_CHECKS[id] ? AUTO_CHECKS[id].desc : ''),
        stateOf, effectiveState, isDone, isReady, frontier, isComplete, progress,
        branchesDecided, blockers, isInPipeline, hooksOf
    };
})();
