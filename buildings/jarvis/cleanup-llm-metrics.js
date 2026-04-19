#!/usr/bin/env node
/**
 * cleanup-llm-metrics.js
 *
 * Removes all LLM-dependent metrics (frame-analysis, segment-label, LLM-scored)
 * from Jarvis data files. These metrics lack prompt provenance and are not
 * reproducible.
 *
 * Run: node buildings/jarvis/cleanup-llm-metrics.js
 */

const fs = require('fs');
const path = require('path');

const JARVIS_DIR = __dirname;

// ── Definitive list of removed keys ──────────────────────────────────────

const REMOVED_KEYS = new Set([
    // Frame-analysis metrics (read from frames[*].analysis — LLM-generated, no prompt)
    'face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count',
    'scene_change_rate', 'unique_scene_ratio', 'visual_technique_count_mean',
    'close_up_frame_pct', 'hand_presence_frame_pct', 'motion_word_frame_pct',
    'action_frame_pct', 'visual_stake_frame_pct', 'anticipatory_frame_pct',
    'setup_visual_frame_count', 'demonstration_frame_pct', 'result_reveal_frame_pct',
    // 2nd pass: additional frame-analysis metrics
    'visual_variety_entropy', 'dramatic_frame_pct', 'face_action_alternation_rate',
    'face_alone_pct', 'face_intro_delay_frames', 'face_with_action_pct',
    'frame_cluster_count', 'frame_text_variety', 'object_face_transition_count',
    'object_focus_pct', 'opening_frame_has_face', 'opening_frame_has_text',
    'outdoor_frame_pct', 'scene_burst_count', 'scene_transition_spacing_cv',
    'scene_transition_spacing_mean', 'scene_transition_spacing_variance',
    'visual_mode_dominant_pct', 'visual_mode_entropy', 'visual_monotony_score',
    'visual_pacing_variance', 'visual_return_count', 'words_per_scene',
    'workshop_frame_pct', 'cluster_transition_rate', 'dominant_cluster_pct',
    'text_density_q1_q4_ratio', 'text_first_appearance_pct', 'text_gap_mean',
    'text_overlay_burst_count', 'text_overlay_early_pct',

    // Segment-label metrics (read from aiAnalysis.segments — LLM-generated, no prompt)
    'segment_count', 'avg_segment_duration_s', 'longest_segment_duration_s',
    'shortest_segment_duration_s', 'has_hook_segment', 'hook_duration_s',
    'hook_duration_pct', 'hook_position_s', 'has_climax_segment',
    'climax_position_pct', 'hook_to_climax_gap_s', 'hook_payoff_gap',
    'narrative_arc_completeness', 'setup_duration_s', 'setup_duration_pct',
    'hook_plus_setup_duration_pct', 'payoff_position_pct', 'hook_to_payoff_gap_pct',
    // 2nd pass: additional segment-label metrics
    'has_conclusion_segment', 'has_setup_segment', 'first_segment_duration_pct',
    'last_segment_duration_pct', 'segment_count_per_minute', 'segment_duration_variance',
    'segment_length_ratio_max_min', 'segment_type_count', 'hook_body_ratio',
    'hook_conclusion_combined_pct', 'climax_late_flag', 'golden_ratio_segment_flag',
    'structural_thirds_balance', 'body_segment_count', 'silence_before_climax_s',

    // Segment-transcript metrics (use segment boundaries to slice transcript)
    'open_loop_density_mid', 'closure_density_mid', 'story_stake_density_first_quarter',
    'visual_proof_density_hook', 'reference_callback_density_mid',
    'pre_gratification_open_loop_count', 'stake_introduction_position_pct',
    'proof_density_post_midpoint', 'callback_before_payoff_flag',
    'delayed_gratification_peak_position_pct',

    // 3rd pass: stragglers still in data
    'anticipatory_frame_pct', 'callback_before_payoff_flag',
    'demonstration_frame_pct', 'hook_plus_setup_duration_pct',
    'proof_density_post_midpoint', 'reference_callback_rate_per_min',
    'setup_duration_pct', 'setup_duration_s', 'early_stakes_flag',

    // LLM-scored variables (no extractMetric code, no prompt documented)
    'z_score', 'z_type', 'vz_score', 'vz_type',
    'novelty', 'cognitive_load', 'net_novelty',
]);

// Also match pattern-based keys: object_mention_frame_pct_first{N}s
function isRemovedKey(key) {
    if (REMOVED_KEYS.has(key)) return true;
    if (/^object_mention_frame_pct_first\d+s$/.test(key)) return true;
    // Interaction terms where either component is removed
    const xm = key.match(/^(.+)_x_(.+)$/);
    if (xm) {
        return isRemovedKey(xm[1]) || isRemovedKey(xm[2]);
    }
    return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function loadJson(name) {
    const fp = path.join(JARVIS_DIR, `${name}.json`);
    if (!fs.existsSync(fp)) { console.log(`  SKIP: ${name}.json not found`); return null; }
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
}

function saveJson(name, data) {
    const fp = path.join(JARVIS_DIR, `${name}.json`);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function fileSizeMB(name) {
    const fp = path.join(JARVIS_DIR, `${name}.json`);
    if (!fs.existsSync(fp)) return 0;
    return (fs.statSync(fp).size / 1024 / 1024).toFixed(1);
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
    console.log('=== Jarvis LLM-Dependent Metric Cleanup ===\n');
    console.log(`Removed keys: ${REMOVED_KEYS.size} explicit + pattern-based + interaction terms\n`);

    // 1. indicators.json
    console.log('--- indicators.json ---');
    console.log(`  Before: ${fileSizeMB('indicators')} MB`);
    const indicators = loadJson('indicators');
    if (indicators && Array.isArray(indicators)) {
        const before = indicators.length;
        const cleaned = indicators.filter(ind => !isRemovedKey(ind.key));
        console.log(`  Indicators: ${before} → ${cleaned.length} (removed ${before - cleaned.length})`);
        saveJson('indicators', cleaned);
        console.log(`  After: ${fileSizeMB('indicators')} MB`);
    }

    // 2. graph.json
    console.log('\n--- graph.json ---');
    console.log(`  Before: ${fileSizeMB('graph')} MB`);
    const graph = loadJson('graph');
    if (graph) {
        const nodesBefore = (graph.nodes || []).length;
        const edgesBefore = (graph.edges || []).length;
        const derivedBefore = (graph.derived_edges || []).length;

        graph.nodes = (graph.nodes || []).filter(n => !isRemovedKey(n.key));
        graph.edges = (graph.edges || []).filter(e => !isRemovedKey(e.from) && !isRemovedKey(e.to));
        graph.derived_edges = (graph.derived_edges || []).filter(e => !isRemovedKey(e.from) && !isRemovedKey(e.to));

        // Clean connections on remaining nodes
        for (const node of graph.nodes) {
            if (node.connections) {
                node.connections = node.connections.filter(c => !isRemovedKey(c));
            }
        }

        console.log(`  Nodes: ${nodesBefore} → ${graph.nodes.length} (removed ${nodesBefore - graph.nodes.length})`);
        console.log(`  Edges: ${edgesBefore} → ${graph.edges.length} (removed ${edgesBefore - graph.edges.length})`);
        console.log(`  Derived edges: ${derivedBefore} → ${graph.derived_edges.length} (removed ${derivedBefore - graph.derived_edges.length})`);
        saveJson('graph', graph);
        console.log(`  After: ${fileSizeMB('graph')} MB`);
    }

    // 3. derived_experiments.json
    console.log('\n--- derived_experiments.json ---');
    console.log(`  Before: ${fileSizeMB('derived_experiments')} MB`);
    const derived = loadJson('derived_experiments');
    if (derived && Array.isArray(derived)) {
        const before = derived.length;
        const cleaned = derived.filter(d => !isRemovedKey(d.key));
        console.log(`  Derived: ${before} → ${cleaned.length} (removed ${before - cleaned.length})`);
        saveJson('derived_experiments', cleaned);
        console.log(`  After: ${fileSizeMB('derived_experiments')} MB`);
    }

    // 4. candidate_queue.json
    console.log('\n--- candidate_queue.json ---');
    console.log(`  Before: ${fileSizeMB('candidate_queue')} MB`);
    const queue = loadJson('candidate_queue');
    if (queue && Array.isArray(queue)) {
        const before = queue.length;
        const cleaned = queue.filter(k => !isRemovedKey(k));
        console.log(`  Candidates: ${before} → ${cleaned.length} (removed ${before - cleaned.length})`);
        saveJson('candidate_queue', cleaned);
        console.log(`  After: ${fileSizeMB('candidate_queue')} MB`);
    }

    // 5. experiments_log.json
    console.log('\n--- experiments_log.json ---');
    console.log(`  Before: ${fileSizeMB('experiments_log')} MB`);
    const experiments = loadJson('experiments_log');
    if (experiments && Array.isArray(experiments)) {
        const before = experiments.length;
        const cleaned = experiments.filter(e => !isRemovedKey(e.indicator_key));
        console.log(`  Experiments: ${before} → ${cleaned.length} (removed ${before - cleaned.length})`);
        saveJson('experiments_log', cleaned);
        console.log(`  After: ${fileSizeMB('experiments_log')} MB`);
    }

    // 6. indicator-registry.json
    console.log('\n--- indicator-registry.json ---');
    console.log(`  Before: ${fileSizeMB('indicator-registry')} MB`);
    const registry = loadJson('indicator-registry');
    if (registry && typeof registry === 'object') {
        const keys = Object.keys(registry);
        const before = keys.length;
        for (const k of keys) {
            if (isRemovedKey(k)) delete registry[k];
        }
        const after = Object.keys(registry).length;
        console.log(`  Registry entries: ${before} → ${after} (removed ${before - after})`);
        saveJson('indicator-registry', registry);
        console.log(`  After: ${fileSizeMB('indicator-registry')} MB`);
    }

    console.log('\n=== Cleanup complete ===');
}

main();
