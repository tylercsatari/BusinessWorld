#!/usr/bin/env node
'use strict';
/**
 * Phase 6 — Persist into Jarvis surfaces.
 *
 * Augments findings-summary.json, writes overnight_report.md, and
 * additively extends graph.json with mechanism nodes and
 * mechanism→indicator edges. If the merged graph would grow >25%, the
 * mechanism extension is written to graph_mechanisms.json instead.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const PHASE_ID = 'phase_6_persist';
const JARVIS = lib.JARVIS_DIR;
const GROW_LIMIT_PCT = 25;

function bytesOf(file) {
    try { return fs.statSync(file).size; } catch { return 0; }
}

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const status = lib.readJson(path.join(JARVIS, 'overnight_status.json'), {});
    const mechBlob = lib.readJson(path.join(JARVIS, 'mechanisms.json'), { mechanisms: [] });
    const compBlob = lib.readJson(path.join(JARVIS, 'components.json'), { components: [] });
    const principlesBlob = lib.readJson(path.join(JARVIS, 'principles.json'), { principles: [] });
    const linksBlob = lib.readJson(path.join(JARVIS, 'mechanism_indicator_links.json'), { links: [] });
    const bridgeBlob = lib.readJson(path.join(JARVIS, 'bridge_validation.json'), { rows: [] });
    const topBlob = lib.readJson(path.join(JARVIS, 'bridge_top_principles.json'), { top: [] });
    const obsBlob = lib.readJson(path.join(JARVIS, 'mechanism_observations.json'), { n_videos_processed: 0, n_observations_total: 0 });
    const gapsBlob = lib.readJson(path.join(JARVIS, 'principle_gaps.json'), { gaps: [], n_gaps: 0 });

    // ── Augment findings-summary.json ────────────────────────────────────
    const findingsFile = path.join(JARVIS, 'findings-summary.json');
    const findings = lib.readJson(findingsFile, {});
    findings.overnight = {
        run_at: lib.nowIso(),
        phase_results: status.phase_results || {},
        n_videos_processed: obsBlob.n_videos_processed || 0,
        n_mechanism_observations: obsBlob.n_observations_total || 0,
        n_mechanisms: (mechBlob.mechanisms || []).length,
        n_components: (compBlob.components || []).length,
        n_principles: (principlesBlob.principles || []).length,
        n_principle_gaps: gapsBlob.n_gaps || 0,
        n_bridges_validated: (bridgeBlob.rows || []).length,
        top_25_principles: (topBlob.top || []).slice(0, 25),
        top_10_mechanisms_by_support: (mechBlob.mechanisms || []).slice(0, 10).map(m => ({
            id: m.id, n_videos: m.n_videos, n_observations: m.n_observations,
        })),
        top_10_components: (compBlob.components || []).slice(0, 10).map(c => ({
            id: c.id, label: c.label, n_mechanisms_using: c.n_mechanisms_using,
        })),
    };
    lib.writeJson(findingsFile, findings);
    console.log(`  augmented findings-summary.json`);

    // ── Write overnight_report.md ────────────────────────────────────────
    const reportFile = path.join(JARVIS, 'overnight_report.md');
    const lines = [];
    lines.push(`# Overnight Build Report`);
    lines.push(``);
    lines.push(`Run finished: ${lib.nowIso()}`);
    lines.push(``);
    lines.push(`## Totals`);
    lines.push(`- Videos processed: ${obsBlob.n_videos_processed || 0}`);
    lines.push(`- Mechanism observations: ${obsBlob.n_observations_total || 0}`);
    lines.push(`- Distinct mechanisms: ${(mechBlob.mechanisms || []).length}`);
    lines.push(`- Components lifted: ${(compBlob.components || []).length}`);
    lines.push(`- Candidate principles: ${(principlesBlob.principles || []).length}`);
    lines.push(`- Principle gaps (mechanisms with no principle yet): ${gapsBlob.n_gaps || 0}`);
    lines.push(`- Bridges validated: ${(bridgeBlob.rows || []).length}`);
    lines.push(``);
    lines.push(`## Top 10 mechanisms by support`);
    for (const m of (mechBlob.mechanisms || []).slice(0, 10)) {
        lines.push(`- \`${m.id}\` — ${m.n_videos} videos, ${m.n_observations} observations`);
    }
    lines.push(``);
    lines.push(`## Top 10 components`);
    for (const c of (compBlob.components || []).slice(0, 10)) {
        lines.push(`- \`${c.id}\` — ${c.label} (${c.n_mechanisms_using} mechanisms)`);
    }
    lines.push(``);
    lines.push(`## Top 25 candidate principles by chain strength`);
    for (const p of (topBlob.top || []).slice(0, 25)) {
        lines.push(`- \`${p.principle_id}\` — ${p.mechanism_id} → ${p.via_indicator} → views | chain=${p.chain_strength}, n=${p.n_videos_used}`);
    }
    lines.push(``);
    lines.push(`## Phase results`);
    for (const [pid, pr] of Object.entries(status.phase_results || {})) {
        lines.push(`- ${pid}: ${pr.status}`);
    }
    lines.push(``);
    lines.push(`## Notes`);
    lines.push(`Every principle here is **status: candidate**. Promotion is a human pass.`);
    lines.push(`Mechanism IDs are observation-derived; categorization is allowed to evolve.`);
    fs.writeFileSync(reportFile, lines.join('\n'));
    console.log(`  wrote overnight_report.md`);

    // ── Additively extend graph.json (or write graph_mechanisms.json) ────
    const graphFile = path.join(JARVIS, 'graph.json');
    const beforeBytes = bytesOf(graphFile);
    const graph = lib.readJson(graphFile, { nodes: [], edges: [], derived_edges: [] });
    if (!graph.nodes) graph.nodes = [];
    if (!graph.edges) graph.edges = [];

    // Construct mechanism nodes + mechanism→indicator edges from links blob
    const newNodes = [];
    const newEdges = [];
    const existingNodeKeys = new Set((graph.nodes || []).map(n => n.key));
    for (const m of (mechBlob.mechanisms || [])) {
        const key = `mech::${m.id}`;
        if (existingNodeKeys.has(key)) continue;
        newNodes.push({
            key,
            label: m.label || m.id,
            type: 'mechanism',
            layer: 'mechanism',
            depth: 1,
            resolution_id: 'r0',
            connections: [],
            n_observations: m.n_observations,
            n_videos: m.n_videos,
            source_kinds: m.source_kinds,
            description: m.rough_description,
        });
    }
    for (const lk of (linksBlob.links || [])) {
        newEdges.push({
            from: `mech::${lk.mechanism_id}`,
            to: lk.indicator_key,
            kind: 'mechanism_to_indicator',
            rho: lk.rho,
            n: lk.n,
            added_at: lib.nowIso(),
        });
    }

    const trial = {
        ...graph,
        nodes: [...(graph.nodes || []), ...newNodes],
        edges: [...(graph.edges || []), ...newEdges],
        updated_at: lib.nowIso(),
    };
    const trialJson = JSON.stringify(trial);
    const trialBytes = Buffer.byteLength(trialJson, 'utf8');
    const growthPct = beforeBytes > 0 ? ((trialBytes - beforeBytes) / beforeBytes) * 100 : 100;

    let mergedInPlace = false;
    let extensionFile = null;
    if (growthPct <= GROW_LIMIT_PCT) {
        lib.writeJson(graphFile, trial);
        mergedInPlace = true;
        console.log(`  graph.json merged in place (+${growthPct.toFixed(1)}%, ${newNodes.length} nodes, ${newEdges.length} edges)`);
    } else {
        extensionFile = path.join(JARVIS, 'graph_mechanisms.json');
        lib.writeJson(extensionFile, {
            version: '1.0',
            generated_at: lib.nowIso(),
            note: `growth would have been +${growthPct.toFixed(1)}% — exceeds ${GROW_LIMIT_PCT}% safety limit; written as a separate file for parent agent to merge.`,
            nodes: newNodes,
            edges: newEdges,
        });
        console.log(`  growth ${growthPct.toFixed(1)}% > ${GROW_LIMIT_PCT}% — wrote graph_mechanisms.json (${newNodes.length} nodes, ${newEdges.length} edges)`);
    }

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            graph_merged_in_place: mergedInPlace,
            graph_extension_file: extensionFile,
            new_mech_nodes: newNodes.length,
            new_mech_edges: newEdges.length,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
        s.overall_status = 'completed';
        s.finished_at = lib.nowIso();
        s.updated_at = lib.nowIso();
        return s;
    });

    console.log(`[${PHASE_ID}] completed`);
}

if (require.main === module) {
    try { main(); process.exit(0); }
    catch (err) {
        console.error(`[${PHASE_ID}] FAILED:`, err.stack || err.message);
        lib.patchStatus(s => {
            s.failed_phase = PHASE_ID;
            s.failure_reason = String(err.message || err).slice(0, 500);
            s.updated_at = lib.nowIso();
            return s;
        });
        process.exit(1);
    }
}
