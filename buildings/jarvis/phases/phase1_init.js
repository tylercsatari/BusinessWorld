#!/usr/bin/env node
'use strict';
/**
 * Phase 1 — Architecture, contracts, registries.
 *
 * Lays down schema files for layers the meta-architecture promises but the
 * codebase has not yet realized: mechanisms, components, principles, plus
 * supporting registries.
 *
 * Idempotent: re-running overwrites only the files declared as outputs.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const PHASE_ID = 'phase_1_init';
const JARVIS = lib.JARVIS_DIR;

const SCHEMAS = {
    mechanisms: {
        version: '1.0',
        generated_at: lib.nowIso(),
        schema: {
            id: 'stable rough-language identifier (e.g. open_with_curiosity_gap_first_5s)',
            label: 'human-readable label',
            rough_description: 'free-text description of the move',
            source_kinds: 'array of evidence kinds that produced this id (segment_label, transcript_phrase, frame_engagement)',
            n_observations: 'total observation count across the corpus',
            n_videos: 'distinct videos in which this mechanism was observed',
            sample_evidence: 'up to 3 evidence rows for inspection',
            emergence_method: 'how the id was produced (always observation-derived)',
        },
        mechanisms: [],
    },
    components: {
        version: '1.0',
        generated_at: lib.nowIso(),
        schema: {
            id: 'stable component identifier',
            label: 'human-readable label',
            fragment_kind: 'phrase_family | position_bucket | evidence_kind | segment_label',
            fragment_value: 'the recurring fragment value',
            n_mechanisms_using: 'count of distinct mechanism ids that include this fragment',
            n_observations_total: 'sum of observation counts across those mechanisms',
            mechanism_ids: 'list of mechanism ids that use this component',
        },
        components: [],
    },
    principles: {
        version: '1.0',
        generated_at: lib.nowIso(),
        schema: {
            id: 'principle id',
            edge: '{from_mechanism, via_indicator, to_outcome}',
            hypothesis_text: 'templated rationale tied to mechanism evidence + indicator family',
            supporting_n: 'video count behind the supporting correlation',
            mechanism_indicator_rho: 'rank correlation of mechanism observation count vs indicator value',
            indicator_outcome_r: 'pearson r of indicator vs views(log10)',
            status: 'always candidate; promotion is a human pass',
        },
        principles: [],
    },
    mechanism_observations: {
        version: '1.0',
        generated_at: lib.nowIso(),
        observations: [],
    },
    bridge_validation: {
        version: '1.0',
        generated_at: lib.nowIso(),
        rows: [],
    },
};

function writeSchemaFile(name, body) {
    const file = path.join(JARVIS, `${name}.json`);
    lib.writeJson(file, body);
    return { file, bytes: fs.statSync(file).size };
}

function buildResearchQuestions() {
    const old = lib.readJson(path.join(JARVIS, 'research_questions.json'), {});
    const legacy = (old && typeof old === 'object') ? old : {};

    const layers = ['outcome', 'post_indicator', 'pre_indicator', 'mechanism', 'component', 'principle'];
    const resolutions = ['global', 'first_10s', 'mid', 'final', 'first_3_days', 'days_7_to_14'];

    const questions = [];
    let nextId = 1;
    for (const layer of layers) {
        for (const res of resolutions) {
            questions.push({
                id: `q${String(nextId).padStart(4, '0')}`,
                layer,
                resolution: res,
                question: `What ${layer} signals at resolution=${res} most strongly relate to views(log10), and through which mechanism?`,
                status: 'open',
                generated_at: lib.nowIso(),
            });
            nextId++;
        }
    }

    return {
        version: '2.0',
        generated_at: lib.nowIso(),
        legacy,
        questions,
    };
}

function buildIndicatorRegistry() {
    const indicators = lib.readJson(path.join(JARVIS, 'indicators.json'), []);
    const derived = lib.readJson(path.join(JARVIS, 'derived_experiments.json'), []);
    const registry = [];
    const seen = new Set();
    for (const ind of (Array.isArray(indicators) ? indicators : [])) {
        if (!ind || !ind.key || seen.has(ind.key)) continue;
        seen.add(ind.key);
        registry.push({
            key: ind.key,
            kind: 'atomic',
            layer: ind.layer || 'unknown',
            resolution_id: ind.resolution_id || 'r0',
            r: (ind.result && ind.result.primary_r) || null,
            target: ind.target || 'views',
        });
    }
    for (const d of (Array.isArray(derived) ? derived : [])) {
        if (!d || !d.key || seen.has(d.key)) continue;
        seen.add(d.key);
        registry.push({
            key: d.key,
            kind: 'derived',
            layer: d.layer || 'unknown',
            resolution_id: d.resolution_id || 'r0',
            r: d.r || null,
            target: d.target || 'views',
        });
    }
    return {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_entries: registry.length,
        entries: registry,
    };
}

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const written = {};

    for (const [name, body] of Object.entries(SCHEMAS)) {
        const res = writeSchemaFile(name, body);
        written[name] = res;
        console.log(`  wrote ${name}.json (${res.bytes} bytes)`);
    }

    const rq = buildResearchQuestions();
    const rqFile = path.join(JARVIS, 'research_questions.json');
    lib.writeJson(rqFile, rq);
    written.research_questions = { file: rqFile, bytes: fs.statSync(rqFile).size, n_questions: rq.questions.length };
    console.log(`  wrote research_questions.json (${rq.questions.length} questions)`);

    const reg = buildIndicatorRegistry();
    const regFile = path.join(JARVIS, 'indicator-registry.json');
    lib.writeJson(regFile, reg);
    written.indicator_registry = { file: regFile, bytes: fs.statSync(regFile).size, n_entries: reg.n_entries };
    console.log(`  wrote indicator-registry.json (${reg.n_entries} entries)`);

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            written,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
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
