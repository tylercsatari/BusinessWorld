/**
 * Dynamic DAG Flowchart Visualizer for Business World Notes.
 * Embeds an interactive, deterministic, modifiable SVG flowchart
 * directly into the note editor based on the note body architecture.
 *
 * Principles:
 *  - deterministic output: same graph data → same layout (hash-seeded)
 *  - visual abstraction: layered SVG with color-coded node types
 *  - DAG structure: topological sort + Sugiyama-style layering
 *  - embedded integration: mounts inside a designated DOM container
 *  - data freshness: reads from note body, writes back on change
 */
const DagFlowchart = (() => {
    'use strict';

    // --- Hash-based deterministic pseudo-random ---
    function cyrb53(str, seed = 0) {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 4294967296;
    }

    function hashString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
    }

    // Seeded PRNG for deterministic layout jitter
    function makeRng(seed) {
        let s = seed;
        return () => {
            s = (s * 16807 + 0) % 2147483647;
            return (s - 1) / 2147483646;
        };
    }

    // --- Graph data model ---
    const NODE_TYPES = {
        project:    { label: 'Project',    color: '#d4a060', bg: '#fff3e0', stroke: '#8d6e63', shape: 'rect' },
        video:      { label: 'Video',      color: '#6bb3d6', bg: '#e3f2fd', stroke: '#2980b9', shape: 'rect' },
        stage:      { label: 'Stage',      color: '#7bed9f', bg: '#e8f5e9', stroke: '#27ae60', shape: 'rect' },
        parallel:   { label: 'Parallel',   color: '#f368e0', bg: '#fce4ec', stroke: '#e84393', shape: 'rect' },
        principle:  { label: 'Principle',  color: '#d4a060', bg: '#fff8ee', stroke: '#d4a060', shape: 'pill' },
        mechanism:  { label: 'Mechanism',  color: '#d4a060', bg: '#fff8ee', stroke: '#d4a060', shape: 'pill' },
        custom:     { label: 'Custom',     color: '#a29bfe', bg: '#f3f0ff', stroke: '#6c5ce7', shape: 'rect' },
    };

    const EDGE_TYPES = {
        causality:   { color: '#c0392b', dash: '6,4',  label: 'Causality' },
        decompose:   { color: '#5a3e1b', dash: '',     label: 'Decomposes' },
        pipeline:    { color: '#5a3e1b', dash: '',     label: 'Pipeline' },
        cross:       { color: '#e67e22', dash: '4,3',  label: 'Cross-dep' },
        parallel:    { color: '#e84393', dash: '4,3',  label: 'Parallel' },
        custom:      { color: '#6c5ce7', dash: '',     label: '' },
    };

    function parseGraphFromBody(body) {
        // 1. Try to read embedded JSON dag-data
        const dagDataMatch = body.match(/<!--\s*dag-data:\s*([\s\S]*?)\s*-->/);
        if (dagDataMatch) {
            try {
                return JSON.parse(dagDataMatch[1]);
            } catch (e) {}
        }

        // 2. Fallback: parse markdown architecture into graph
        const nodes = [];
        const edges = [];
        let layerY = 0;
        const layerHeight = 160;

        // Helper to add node
        function addNode(id, type, label, sublabel, info, x, y) {
            nodes.push({ id, type, label, sublabel, info, x, y, width: 140, height: 55 });
            return nodes[nodes.length - 1];
        }

        // Extract layers from markdown
        const layer1Match = body.match(/### Layer 1:.*?\n([\s\S]*?)(?=### Layer 2:|## |$)/);
        const layer2Match = body.match(/### Layer 2:.*?\n([\s\S]*?)(?=### Layer 3:|## |$)/);
        const layer3Match = body.match(/### Layer 3:.*?\n([\s\S]*?)(?=## |$)/);
        const principlesMatch = body.match(/## Principles Satisfied\n([\s\S]*?)(?=## |$)/);
        const mechanismsMatch = body.match(/## Mechanisms Used\n([\s\S]*?)(?=## |$)/);

        // --- Layer 1: Projects ---
        if (layer1Match) {
            const text = layer1Match[1];
            const projectNames = [];
            let m;
            const re = /\*\*(.+?)\*\*/g;
            while ((m = re.exec(text)) !== null) projectNames.push(m[1]);
            if (projectNames.length === 0) projectNames.push('Project A', 'Project B');

            projectNames.forEach((name, i) => {
                addNode(`proj-${i}`, 'project', name, '', `Project: ${name} — Top-level scope node.`, 200 + i * 300, 50);
            });
            // Causality edge
            if (projectNames.length > 1) {
                edges.push({ from: 'proj-0', to: 'proj-1', type: 'causality' });
            }
            // Decompose edges (to layer 2)
            projectNames.forEach((_, i) => {
                edges.push({ from: `proj-${i}`, to: `videos-${i}`, type: 'decompose' });
            });
        }

        // --- Layer 2: Videos ---
        if (layer2Match) {
            const text = layer2Match[1];
            const videoNames = [];
            let m;
            const re = /\*\*(.+?)\*\*/g;
            while ((m = re.exec(text)) !== null) videoNames.push(m[1]);
            if (videoNames.length === 0) {
                // Default video decomposition
                const projCount = nodes.filter(n => n.type === 'project').length || 1;
                for (let p = 0; p < projCount; p++) {
                    for (let v = 0; v < 3; v++) {
                        const id = `vid-${p}-${v}`;
                        addNode(id, 'video', `Video ${v+1}`, `Project ${p+1}`, `Video instance for Project ${p+1}.`, 80 + p * 360 + v * 170, 200);
                        edges.push({ from: `proj-${p}`, to: id, type: 'decompose' });
                    }
                }
            } else {
                // Parse explicit videos (heuristic grouping)
                videoNames.forEach((name, i) => {
                    const id = `vid-${i}`;
                    addNode(id, 'video', name, '', `Video: ${name}`, 80 + i * 170, 200);
                    // Link to nearest project above
                    const proj = nodes.find(n => n.type === 'project');
                    if (proj) edges.push({ from: proj.id, to: id, type: 'decompose' });
                });
            }
        } else {
            // Default videos
            const projCount = nodes.filter(n => n.type === 'project').length || 1;
            for (let p = 0; p < projCount; p++) {
                for (let v = 0; v < 3; v++) {
                    const id = `vid-${p}-${v}`;
                    addNode(id, 'video', `Video ${v+1}`, `Project ${p+1}`, `Video instance for Project ${p+1}.`, 80 + p * 360 + v * 170, 200);
                    edges.push({ from: `proj-${p}`, to: id, type: 'decompose' });
                }
            }
        }

        // --- Layer 3: Stages ---
        if (layer3Match) {
            const text = layer3Match[1];
            const stageItems = [];
            const lines = text.split('\n');
            let stageNum = 1;
            lines.forEach(line => {
                const m = line.match(/^\s*\d+\.\s*\*\*(.+?)\*\*\s*[-\u2014]\s*(.+)/);
                if (m) {
                    stageItems.push({ name: m[1], desc: m[2], num: stageNum++ });
                } else {
                    const m2 = line.match(/^\s*\d+[a-z]\.\s*\*\*(.+?)\*\*\s*[-\u2014]\s*(.+)/);
                    if (m2) {
                        stageItems.push({ name: m2[1], desc: m2[2], num: stageNum++, sub: true });
                    }
                }
            });
            if (stageItems.length === 0) {
                // Fallback: default 10 stages
                const defaults = [
                    ['Incubator','Idea + Context'],
                    ['Research','Viral Analysis'],
                    ['Script','Library Writer'],
                    ['Assets','Brand Library'],
                    ['Voiceover','Recording Booth'],
                    ['Edit','Timeline Build'],
                    ['Review Gate','QA + Sign-off'],
                    ['Render','Distributed Farm'],
                    ['Publish','YouTube + Pen'],
                    ['Analytics','Metrics + Swipe']
                ];
                defaults.forEach(([name, sub], i) => {
                    const isParallel = (name === 'Assets' || name === 'Voiceover');
                    const type = isParallel ? 'parallel' : 'stage';
                    const id = `stage-${i}`;
                    const x = 50 + i * 140;
                    const y = (isParallel && name === 'Voiceover') ? 410 : 350;
                    addNode(id, type, `${i+1}. ${name}`, sub, `Stage ${i+1}: ${name} — ${sub}.`, x, y);
                    if (i > 0) {
                        if (name === 'Assets') {
                            edges.push({ from: `stage-2`, to: id, type: 'pipeline' }); // from Script
                        } else if (name === 'Voiceover') {
                            edges.push({ from: `stage-2`, to: id, type: 'pipeline' }); // from Script
                            edges.push({ from: id, to: `stage-5`, type: 'parallel' }); // merge to Edit
                        } else if (name === 'Edit') {
                            edges.push({ from: `stage-3`, to: id, type: 'pipeline' }); // from Assets
                            edges.push({ from: `stage-4`, to: id, type: 'parallel' }); // from Voiceover
                        } else {
                            edges.push({ from: `stage-${i-1}`, to: id, type: 'pipeline' });
                        }
                    }
                });
            } else {
                stageItems.forEach((s, i) => {
                    const isParallel = s.sub;
                    const type = isParallel ? 'parallel' : 'stage';
                    const id = `stage-${i}`;
                    const x = 50 + i * 140;
                    const y = (isParallel && s.name.includes('Voiceover')) ? 410 : 350;
                    addNode(id, type, `${s.num}. ${s.name}`, s.desc, `Stage ${s.num}: ${s.name} — ${s.desc}.`, x, y);
                    if (i > 0) {
                        edges.push({ from: `stage-${i-1}`, to: id, type: 'pipeline' });
                    }
                });
            }
        } else {
            // Default 10 stages
            const defaults = [
                ['Incubator','Idea + Context'],
                ['Research','Viral Analysis'],
                ['Script','Library Writer'],
                ['Assets','Brand Library'],
                ['Voiceover','Recording Booth'],
                ['Edit','Timeline Build'],
                ['Review Gate','QA + Sign-off'],
                ['Render','Distributed Farm'],
                ['Publish','YouTube + Pen'],
                ['Analytics','Metrics + Swipe']
            ];
            defaults.forEach(([name, sub], i) => {
                const isParallel = (name === 'Assets' || name === 'Voiceover');
                const type = isParallel ? 'parallel' : 'stage';
                const id = `stage-${i}`;
                const x = 50 + i * 140;
                const y = (isParallel && name === 'Voiceover') ? 410 : 350;
                addNode(id, type, `${i+1}. ${name}`, sub, `Stage ${i+1}: ${name} — ${sub}.`, x, y);
                if (i > 0) {
                    if (name === 'Assets') {
                        edges.push({ from: `stage-2`, to: id, type: 'pipeline' });
                    } else if (name === 'Voiceover') {
                        edges.push({ from: `stage-2`, to: id, type: 'pipeline' });
                        edges.push({ from: id, to: `stage-5`, type: 'parallel' });
                    } else if (name === 'Edit') {
                        edges.push({ from: `stage-3`, to: id, type: 'pipeline' });
                        edges.push({ from: `stage-4`, to: id, type: 'parallel' });
                    } else {
                        edges.push({ from: `stage-${i-1}`, to: id, type: 'pipeline' });
                    }
                }
            });
        }

        // Video → Stage 1 funnel edges
        const videoNodes = nodes.filter(n => n.type === 'video');
        const stage1 = nodes.find(n => n.id === 'stage-0');
        if (stage1 && videoNodes.length) {
            videoNodes.forEach(vn => {
                edges.push({ from: vn.id, to: stage1.id, type: 'pipeline' });
            });
        }

        // --- Principles ---
        if (principlesMatch) {
            const text = principlesMatch[1];
            const principles = [];
            let m;
            const re = /-\s*\*\*(.+?)\*\*/g;
            while ((m = re.exec(text)) !== null) principles.push(m[1]);
            principles.forEach((p, i) => {
                const row = Math.floor(i / 5);
                const col = i % 5;
                addNode(`prin-${i}`, 'principle', p, '', `Principle: ${p}`, 60 + col * 240, 540 + row * 60);
            });
        }

        // --- Mechanisms ---
        if (mechanismsMatch) {
            const text = mechanismsMatch[1];
            const mechanisms = [];
            let m;
            const re = /-\s*(.+?)(?:\n|$)/g;
            while ((m = re.exec(text)) !== null) mechanisms.push(m[1].trim());
            mechanisms.forEach((mech, i) => {
                const row = Math.floor(i / 5);
                const col = i % 5;
                addNode(`mech-${i}`, 'mechanism', mech, '', `Mechanism: ${mech}`, 60 + col * 200, 760 + row * 60);
            });
        }

        return { nodes, edges };
    }

    function serializeGraphToBody(body, graph) {
        const json = JSON.stringify(graph);
        // Remove existing dag-data block
        body = body.replace(/<!--\s*dag-data:\s*[\s\S]*?\s*-->/, '');
        // Append new block
        body = body.trim() + '\n\n<!-- dag-data: ' + json + ' -->';
        return body;
    }

    // --- Layout engine (Sugiyama-style deterministic) ---
    function computeLayout(graph) {
        const { nodes, edges } = graph;
        if (!nodes.length) return graph;

        // Build adjacency
        const adj = new Map();
        const radj = new Map();
        nodes.forEach(n => { adj.set(n.id, []); radj.set(n.id, []); });
        edges.forEach(e => {
            if (adj.has(e.from) && adj.has(e.to)) {
                adj.get(e.from).push(e.to);
                radj.get(e.to).push(e.from);
            }
        });

        // Topological sort (Kahn's algorithm)
        const inDegree = new Map();
        nodes.forEach(n => inDegree.set(n.id, 0));
        edges.forEach(e => { if (inDegree.has(e.to)) inDegree.set(e.to, inDegree.get(e.to) + 1); });
        const queue = [];
        nodes.forEach(n => { if (inDegree.get(n.id) === 0) queue.push(n.id); });
        const topo = [];
        while (queue.length) {
            queue.sort(); // deterministic
            const id = queue.shift();
            topo.push(id);
            adj.get(id).forEach(v => {
                inDegree.set(v, inDegree.get(v) - 1);
                if (inDegree.get(v) === 0) queue.push(v);
            });
        }

        // Assign layers (longest path from source)
        const layer = new Map();
        topo.forEach(id => {
            let l = 0;
            radj.get(id).forEach(p => { l = Math.max(l, (layer.get(p) || 0) + 1); });
            layer.set(id, l);
        });

        const maxLayer = Math.max(...layer.values(), 0);
        const layerNodes = Array.from({ length: maxLayer + 1 }, () => []);
        topo.forEach(id => layerNodes[layer.get(id)].push(id));

        // Seed from graph content hash
        const seed = hashString(nodes.map(n => n.id).sort().join(',') + edges.map(e => e.from + '->' + e.to).sort().join(','));
        const rng = makeRng(seed);

        // LEFT-TO-RIGHT: topological layers advance in X; nodes within a layer stack in Y.
        // Cross-cutting infrastructure (mechanism/principle) sits in a band along the bottom.
        // EVERY node gets concrete dimensions — dag-data JSON nodes carry none, which rendered
        // width="undefined" rects + NaN edge paths (the "missing boxes and arrows" bug).
        const NODE_W = 172, NODE_H = 62;
        nodes.forEach(n => {
            n.width = n.width || (n.type === 'project' ? 200 : NODE_W);
            n.height = n.height || NODE_H;
        });
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const isInfra = (n) => n.type === 'principle' || n.type === 'mechanism';

        // Within-layer ORDERING — barycenter sweeps minimise edge crossings (Sugiyama method).
        const order = layerNodes.map(ids => ids.filter(id => !isInfra(nodeMap.get(id))));
        const posMap = () => { const p = new Map(); order.forEach(ids => ids.forEach((id, i) => p.set(id, i))); return p; };
        for (let sweep = 0; sweep < 4; sweep++) {
            const p = posMap();
            const down = sweep % 2 === 0;
            const layers = order.map((_, i) => i);
            if (!down) layers.reverse();
            layers.forEach(l => {
                const side = down ? radj : adj;
                order[l] = order[l].map(id => {
                    const nb = (side.get(id) || []).filter(x => p.has(x));
                    const bary = nb.length ? nb.reduce((sum, x) => sum + p.get(x), 0) / nb.length : p.get(id);
                    return { id, bary };
                }).sort((a, b) => a.bary - b.bary).map(o => o.id);
            });
        }

        // LEFT-TO-RIGHT placement: each layer is an X column, its nodes centred vertically.
        const LAYER_X_GAP = 250, BASE_X = 60, ROW_GAP = 108, BASE_Y = 70;
        const maxRows = Math.max(1, ...order.map(ids => ids.length));
        const midY = BASE_Y + (maxRows - 1) * ROW_GAP / 2;
        order.forEach((ids, l) => {
            const top = midY - (ids.length - 1) * ROW_GAP / 2;
            ids.forEach((id, i) => {
                const n = nodeMap.get(id);
                n.x = BASE_X + l * LAYER_X_GAP;
                n.y = top + i * ROW_GAP;
            });
        });

        // Cross-cutting infrastructure (mechanism/principle) → a band below the pipeline.
        const mainMaxY = Math.max(BASE_Y, ...nodes.filter(n => !isInfra(n)).map(n => n.y + n.height));
        nodes.filter(isInfra).forEach((n, i) => {
            n.width = 196; n.height = 56;
            n.x = BASE_X + i * 218;
            n.y = mainMaxY + 90 + (i % 2) * 66;
        });

        return graph;
    }

    // --- SVG Renderer ---
    function renderSvg(graph, containerId, opts = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const { nodes, edges } = graph;
        if (!nodes.length) {
            container.innerHTML = '<div style="padding:20px;color:#888;font-size:13px;">No graph data. Edit the note to add architecture.</div>';
            return;
        }

        const width = Math.max(1200, Math.max(0, ...nodes.map(n => n.x + (n.width || 140))) + 100);
        const height = Math.max(520, Math.max(0, ...nodes.map(n => n.y + (n.height || 55))) + 90);

        // Build node map
        const nodeMap = new Map(nodes.map(n => [n.id, n]));

        // Compute SVG paths for edges (orthogonal routing with rounded corners)
        function routeEdge(e) {
            const from = nodeMap.get(e.from);
            const to = nodeMap.get(e.to);
            if (!from || !to) return '';
            const fcx = from.x + from.width / 2, fcy = from.y + from.height / 2;
            const tcx = to.x + to.width / 2, tcy = to.y + to.height / 2;
            const dx = tcx - fcx, dy = tcy - fcy;
            if (Math.abs(dx) >= Math.abs(dy)) { // horizontal-dominant: exit right/left (the L->R flow)
                const fx = dx >= 0 ? from.x + from.width : from.x;
                const tx = dx >= 0 ? to.x : to.x + to.width;
                const midX = fx + (tx - fx) / 2;
                return `M ${fx} ${fcy} L ${midX} ${fcy} L ${midX} ${tcy} L ${tx} ${tcy}`;
            }
            const fy = dy >= 0 ? from.y + from.height : from.y; // vertical-dominant: infra <-> pipeline
            const ty = dy >= 0 ? to.y : to.y + to.height;
            const midY = fy + (ty - fy) / 2;
            return `M ${fcx} ${fy} L ${fcx} ${midY} L ${tcx} ${midY} L ${tcx} ${ty}`;
        }

        function renderNode(n) {
            const style = NODE_TYPES[n.type] || NODE_TYPES.custom;
            const rx = style.shape === 'pill' ? n.height / 2 : 8;
            const labelY = n.y + n.height / 2 + 4;
            const sublabelY = n.y + n.height / 2 + 18;
            const sublabel = n.sublabel ? `<text x="${n.x + n.width/2}" y="${sublabelY}" text-anchor="middle" font-size="9" fill="${style.color}">${esc(n.sublabel)}</text>` : '';
            return `
                <g class="dagflow-node" data-id="${esc(n.id)}" data-info="${esc(n.info || n.label)}" style="cursor:pointer;" transform="translate(${n.x},${n.y})">
                    <rect width="${n.width}" height="${n.height}" rx="${rx}" fill="${style.bg}" stroke="${style.stroke}" stroke-width="2" filter="url(#shadow)"/>
                    <text x="${n.width/2}" y="${n.height/2 + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#3d2b1f">${esc(n.label)}</text>
                    ${sublabel}
                </g>
            `;
        }

        function renderEdge(e) {
            const style = EDGE_TYPES[e.type] || EDGE_TYPES.custom;
            const path = routeEdge(e);
            if (!path) return '';
            const dash = style.dash ? `stroke-dasharray="${style.dash}"` : '';
            const label = style.label ? `<text x="${(nodeMap.get(e.from).x + nodeMap.get(e.to).x + nodeMap.get(e.from).width/2 + nodeMap.get(e.to).width/2)/2}" y="${(nodeMap.get(e.from).y + nodeMap.get(e.from).height + nodeMap.get(e.to).y)/2 - 6}" text-anchor="middle" font-size="9" fill="${style.color}" font-weight="600">${esc(style.label)}</text>` : '';
            return `
                <path d="${path}" fill="none" stroke="${style.color}" stroke-width="2" ${dash} marker-end="url(#arrow-${style.color.replace('#','')})" />
                ${label}
            `;
        }

        // Build arrow markers dynamically
        const markerColors = new Set();
        edges.forEach(e => {
            const style = EDGE_TYPES[e.type] || EDGE_TYPES.custom;
            markerColors.add(style.color);
        });
        const markers = Array.from(markerColors).map(c => `
            <marker id="arrow-${c.replace('#','')}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L10,5 L0,10 L2,5 z" fill="${c}" />
            </marker>
        `).join('');

        const layerLabels = [];
        const layerLabelSvg = layerLabels.map(l => `<text x="700" y="${l.y}" text-anchor="middle" font-size="14" font-weight="700" fill="#5a3e1b">${esc(l.text)}</text>`).join('');

        const svg = `
            <svg id="dagflow-svg" viewBox="0 0 ${width} ${height}" style="width:${width}px;height:${height}px;display:block;" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.12"/>
                    </filter>
                    ${markers}
                    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e8e0d4" stroke-width="0.5"/>
                    </pattern>
                </defs>
                <rect width="${width}" height="${height}" fill="url(#grid)" />
                ${layerLabelSvg}
                ${edges.map(renderEdge).join('')}
                ${nodes.map(renderNode).join('')}
            </svg>
        `;

        container.innerHTML = `
            <div class="dagflow-wrapper" style="width:100%;height:100%;overflow:auto;background:#f8f6f2;position:relative;" id="dagflow-wrapper-${containerId}">
                <div class="dagflow-toolbar" style="position:sticky;top:0;z-index:10;background:#f8f6f2;padding:8px 12px;border-bottom:1px solid #e0d8cc;display:flex;gap:8px;align-items:center;">
                    <span style="font-weight:700;color:#5a3e1b;font-size:13px;">DAG Pipeline Visualizer</span>
                    <span style="flex:1"></span>
                    <button class="dagflow-zoom-btn" id="dagflow-zoom-in-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">Zoom In</button>
                    <button class="dagflow-zoom-btn" id="dagflow-zoom-out-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">Zoom Out</button>
                    <button class="dagflow-zoom-btn" id="dagflow-reset-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">Reset</button>
                    <button class="dagflow-zoom-btn" id="dagflow-add-node-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">+ Node</button>
                    <button class="dagflow-zoom-btn" id="dagflow-add-edge-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">+ Edge</button>
                    <button class="dagflow-zoom-btn" id="dagflow-relayout-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:12px;cursor:pointer;">Relayout</button>
                    <button class="dagflow-zoom-btn" id="dagflow-fullscreen-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#5a3e1b;color:#fff;font-size:12px;cursor:pointer;font-weight:700;">⛶ Full Screen</button>
                </div>
                <div class="dagflow-canvas-wrap" id="dagflow-canvas-wrap-${containerId}" style="transform-origin:0 0;transition:transform 0.2s ease;">
                    ${svg}
                </div>
                <div class="dagflow-info-panel" id="dagflow-info-panel-${containerId}" style="position:fixed;bottom:20px;right:20px;width:320px;background:#fff;border:1px solid #d4a060;border-radius:8px;padding:12px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:20;display:none;max-height:260px;overflow-y:auto;">
                    <div style="font-weight:700;color:#5a3e1b;font-size:13px;margin-bottom:6px;">Node Details</div>
                    <div id="dagflow-info-text-${containerId}" style="font-size:12px;color:#5a3e1b;line-height:1.4;"></div>
                    <div id="dagflow-info-editor-${containerId}" style="display:none;margin-top:8px;">
                        <input type="text" id="dagflow-edit-label-${containerId}" placeholder="Label" style="width:100%;margin-bottom:4px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;" />
                        <input type="text" id="dagflow-edit-sublabel-${containerId}" placeholder="Sublabel" style="width:100%;margin-bottom:4px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;" />
                        <select id="dagflow-edit-type-${containerId}" style="width:100%;margin-bottom:4px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;">
                            ${Object.entries(NODE_TYPES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
                        </select>
                        <button id="dagflow-edit-save-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#f8f6f2;color:#5a3e1b;font-size:11px;cursor:pointer;margin-right:4px;">Save</button>
                        <button id="dagflow-edit-delete-${containerId}" style="padding:4px 10px;border:1px solid #c0392b;border-radius:6px;background:#fff;color:#c0392b;font-size:11px;cursor:pointer;">Delete</button>
                    </div>
                    <button id="dagflow-info-close-${containerId}" style="margin-top:8px;padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#f8f6f2;color:#5a3e1b;font-size:11px;cursor:pointer;">Close</button>
                </div>
                <div id="dagflow-edge-dialog-${containerId}" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border:1px solid #d4a060;border-radius:8px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:30;width:260px;">
                    <div style="font-weight:700;color:#5a3e1b;font-size:13px;margin-bottom:8px;">Add Edge</div>
                    <select id="dagflow-edge-from-${containerId}" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;">
                        <option value="">From node...</option>
                        ${nodes.map(n => `<option value="${esc(n.id)}">${esc(n.label)} (${n.id})</option>`).join('')}
                    </select>
                    <select id="dagflow-edge-to-${containerId}" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;">
                        <option value="">To node...</option>
                        ${nodes.map(n => `<option value="${esc(n.id)}">${esc(n.label)} (${n.id})</option>`).join('')}
                    </select>
                    <select id="dagflow-edge-type-${containerId}" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;">
                        ${Object.entries(EDGE_TYPES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
                    </select>
                    <div style="display:flex;gap:6px;justify-content:flex-end;">
                        <button id="dagflow-edge-cancel-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#f8f6f2;color:#5a3e1b;font-size:11px;cursor:pointer;">Cancel</button>
                        <button id="dagflow-edge-ok-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:11px;cursor:pointer;">Add</button>
                    </div>
                </div>
                <div id="dagflow-node-dialog-${containerId}" style="display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border:1px solid #d4a060;border-radius:8px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:30;width:260px;">
                    <div style="font-weight:700;color:#5a3e1b;font-size:13px;margin-bottom:8px;">Add Node</div>
                    <input type="text" id="dagflow-node-label-${containerId}" placeholder="Label" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;" />
                    <input type="text" id="dagflow-node-sublabel-${containerId}" placeholder="Sublabel (optional)" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;" />
                    <select id="dagflow-node-type-${containerId}" style="width:100%;margin-bottom:6px;padding:4px;border:1px solid #d4a060;border-radius:4px;font-size:11px;">
                        ${Object.entries(NODE_TYPES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
                    </select>
                    <div style="display:flex;gap:6px;justify-content:flex-end;">
                        <button id="dagflow-node-cancel-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#f8f6f2;color:#5a3e1b;font-size:11px;cursor:pointer;">Cancel</button>
                        <button id="dagflow-node-ok-${containerId}" style="padding:4px 10px;border:1px solid #d4a060;border-radius:6px;background:#fff;color:#5a3e1b;font-size:11px;cursor:pointer;">Add</button>
                    </div>
                </div>
            </div>
        `;

        // --- Zoom / Pan ---
        let zoom = 1;
        const canvasWrap = document.getElementById(`dagflow-canvas-wrap-${containerId}`);
        const _wrapEl = document.getElementById(`dagflow-wrapper-${containerId}`);
        // FIT TO VIEW on first render — the pipeline is very wide, so default to showing the WHOLE
        // thing (start → finish) instead of just the right-hand tail. Reset returns to this fit.
        function fitToView() {
            const wrapW = (_wrapEl ? _wrapEl.clientWidth : 0) || 1000;
            const fit = Math.min(1, (wrapW - 24) / width);
            zoom = Math.max(0.12, fit);
            canvasWrap.style.transform = `scale(${zoom})`;
            if (_wrapEl) _wrapEl.scrollLeft = 0;
        }
        setTimeout(fitToView, 0);
        document.getElementById(`dagflow-zoom-in-${containerId}`).addEventListener('click', () => {
            zoom = Math.min(zoom * 1.2, 3);
            canvasWrap.style.transform = `scale(${zoom})`;
        });
        document.getElementById(`dagflow-zoom-out-${containerId}`).addEventListener('click', () => {
            zoom = Math.max(zoom / 1.2, 0.1);
            canvasWrap.style.transform = `scale(${zoom})`;
        });
        document.getElementById(`dagflow-reset-${containerId}`).addEventListener('click', fitToView);
        document.getElementById(`dagflow-relayout-${containerId}`).addEventListener('click', () => {
            computeLayout(graph);
            renderSvg(graph, containerId, opts);
            if (opts.onChange) opts.onChange(graph);
        });
        const fsBtn = document.getElementById(`dagflow-fullscreen-${containerId}`);
        const wrapper = document.getElementById(`dagflow-wrapper-${containerId}`);
        if (fsBtn && wrapper) {
            fsBtn.addEventListener('click', () => {
                const req = wrapper.requestFullscreen || wrapper.webkitRequestFullscreen;
                const exit = document.exitFullscreen || document.webkitExitFullscreen;
                if (!document.fullscreenElement) {
                    try { req.call(wrapper); } catch (e) {}
                    wrapper.style.height = '100vh';
                    fsBtn.textContent = '✕ Exit Full Screen';
                } else {
                    try { exit.call(document); } catch (e) {}
                    wrapper.style.height = '100%';
                    fsBtn.textContent = '⛶ Full Screen';
                }
            });
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement) { wrapper.style.height = '100%'; fsBtn.textContent = '⛶ Full Screen'; }
            });
        }

        // --- Node interactions ---
        const infoPanel = document.getElementById(`dagflow-info-panel-${containerId}`);
        const infoText = document.getElementById(`dagflow-info-text-${containerId}`);
        const infoEditor = document.getElementById(`dagflow-info-editor-${containerId}`);
        let selectedNodeId = null;

        container.querySelectorAll('.dagflow-node').forEach(node => {
            node.addEventListener('mouseenter', () => {
                node.querySelector('rect')?.setAttribute('stroke-width', '3');
                const info = node.dataset.info;
                if (info && !selectedNodeId) {
                    infoText.textContent = info;
                    infoPanel.style.display = 'block';
                    infoEditor.style.display = 'none';
                }
            });
            node.addEventListener('mouseleave', () => {
                node.querySelector('rect')?.setAttribute('stroke-width', '2');
            });
            node.addEventListener('click', () => {
                const id = node.dataset.id;
                selectedNodeId = id;
                const n = nodeMap.get(id);
                if (n) {
                    infoText.textContent = n.info || n.label;
                    infoPanel.style.display = 'block';
                    infoEditor.style.display = 'block';
                    document.getElementById(`dagflow-edit-label-${containerId}`).value = n.label;
                    document.getElementById(`dagflow-edit-sublabel-${containerId}`).value = n.sublabel || '';
                    document.getElementById(`dagflow-edit-type-${containerId}`).value = n.type;
                }
            });
        });

        document.getElementById(`dagflow-info-close-${containerId}`).addEventListener('click', () => {
            infoPanel.style.display = 'none';
            selectedNodeId = null;
        });

        // Edit node
        document.getElementById(`dagflow-edit-save-${containerId}`).addEventListener('click', () => {
            if (!selectedNodeId) return;
            const n = nodeMap.get(selectedNodeId);
            if (n) {
                n.label = document.getElementById(`dagflow-edit-label-${containerId}`).value;
                n.sublabel = document.getElementById(`dagflow-edit-sublabel-${containerId}`).value;
                n.type = document.getElementById(`dagflow-edit-type-${containerId}`).value;
                n.info = `${n.label} — ${n.sublabel || n.type}`;
                renderSvg(graph, containerId, opts);
                if (opts.onChange) opts.onChange(graph);
            }
        });

        // Delete node
        document.getElementById(`dagflow-edit-delete-${containerId}`).addEventListener('click', () => {
            if (!selectedNodeId) return;
            graph.nodes = graph.nodes.filter(n => n.id !== selectedNodeId);
            graph.edges = graph.edges.filter(e => e.from !== selectedNodeId && e.to !== selectedNodeId);
            selectedNodeId = null;
            computeLayout(graph);
            renderSvg(graph, containerId, opts);
            if (opts.onChange) opts.onChange(graph);
        });

        // Add node dialog
        const nodeDialog = document.getElementById(`dagflow-node-dialog-${containerId}`);
        document.getElementById(`dagflow-add-node-${containerId}`).addEventListener('click', () => {
            nodeDialog.style.display = 'block';
        });
        document.getElementById(`dagflow-node-cancel-${containerId}`).addEventListener('click', () => {
            nodeDialog.style.display = 'none';
        });
        document.getElementById(`dagflow-node-ok-${containerId}`).addEventListener('click', () => {
            const label = document.getElementById(`dagflow-node-label-${containerId}`).value.trim();
            if (!label) return;
            const sublabel = document.getElementById(`dagflow-node-sublabel-${containerId}`).value.trim();
            const type = document.getElementById(`dagflow-node-type-${containerId}`).value;
            const id = `custom-${Date.now()}`;
            const x = 100 + (graph.nodes.length % 5) * 160;
            const y = 100 + Math.floor(graph.nodes.length / 5) * 80;
            graph.nodes.push({ id, type, label, sublabel, info: `${label} — ${sublabel || type}`, x, y, width: 140, height: 55 });
            nodeDialog.style.display = 'none';
            document.getElementById(`dagflow-node-label-${containerId}`).value = '';
            document.getElementById(`dagflow-node-sublabel-${containerId}`).value = '';
            computeLayout(graph);
            renderSvg(graph, containerId, opts);
            if (opts.onChange) opts.onChange(graph);
        });

        // Add edge dialog
        const edgeDialog = document.getElementById(`dagflow-edge-dialog-${containerId}`);
        document.getElementById(`dagflow-add-edge-${containerId}`).addEventListener('click', () => {
            // Refresh options
            const fromSel = document.getElementById(`dagflow-edge-from-${containerId}`);
            const toSel = document.getElementById(`dagflow-edge-to-${containerId}`);
            fromSel.innerHTML = '<option value="">From node...</option>' + graph.nodes.map(n => `<option value="${esc(n.id)}">${esc(n.label)} (${n.id})</option>`).join('');
            toSel.innerHTML = '<option value="">To node...</option>' + graph.nodes.map(n => `<option value="${esc(n.id)}">${esc(n.label)} (${n.id})</option>`).join('');
            edgeDialog.style.display = 'block';
        });
        document.getElementById(`dagflow-edge-cancel-${containerId}`).addEventListener('click', () => {
            edgeDialog.style.display = 'none';
        });
        document.getElementById(`dagflow-edge-ok-${containerId}`).addEventListener('click', () => {
            const from = document.getElementById(`dagflow-edge-from-${containerId}`).value;
            const to = document.getElementById(`dagflow-edge-to-${containerId}`).value;
            const type = document.getElementById(`dagflow-edge-type-${containerId}`).value;
            if (!from || !to || from === to) return;
            graph.edges.push({ from, to, type });
            edgeDialog.style.display = 'none';
            computeLayout(graph);
            renderSvg(graph, containerId, opts);
            if (opts.onChange) opts.onChange(graph);
        });
    }

    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // --- Public API ---
    return {
        parseGraphFromBody,
        serializeGraphToBody,
        computeLayout,
        renderSvg,
        NODE_TYPES,
        EDGE_TYPES,
    };
})();

if (typeof window !== 'undefined') {
    window.DagFlowchart = DagFlowchart;
}
