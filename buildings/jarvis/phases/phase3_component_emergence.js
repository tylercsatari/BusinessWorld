#!/usr/bin/env node
'use strict';
/**
 * Phase 3 — Component emergence.
 *
 * Per §6 of the meta-architecture, components are recurring sub-parts of
 * mechanisms, lifted from the catalog after repeated observation — not
 * declared in advance.
 *
 * Phase 2 mechanism IDs have a deterministic shape:
 *   <source_kind>_<family_or_label>_at_<position_bucket>
 *
 * The natural fragments to lift are: the source_kind, the family/label, and
 * the position_bucket. A fragment becomes a component if it appears in
 * ≥ MIN_RECURRENCE distinct mechanism IDs.
 *
 * Outputs:
 *   components.json
 *   mechanism_components.json
 */

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');

const PHASE_ID = 'phase_3_components';
const JARVIS = lib.JARVIS_DIR;
const MIN_RECURRENCE = 3;

function decomposeMechanismId(id) {
    // Expected: <kind>_<rest>_at_<bucket>
    // <kind> ∈ {segment, phrase, frame}
    // <rest> can contain underscores
    // <bucket> is the trailing segment after _at_
    const atIdx = id.lastIndexOf('_at_');
    if (atIdx < 0) return null;
    const head = id.slice(0, atIdx);
    const bucket = id.slice(atIdx + 4);
    const us = head.indexOf('_');
    if (us < 0) return null;
    const kind = head.slice(0, us);
    const family = head.slice(us + 1);
    return { kind, family, bucket };
}

function main() {
    const startedAt = lib.nowIso();
    lib.setPhaseProgress(PHASE_ID, { step: 'starting', started_at: startedAt });
    console.log(`[${PHASE_ID}] start`);

    const mechFile = path.join(JARVIS, 'mechanisms.json');
    const mechBlob = lib.readJson(mechFile, null);
    if (!mechBlob || !Array.isArray(mechBlob.mechanisms)) {
        throw new Error('mechanisms.json missing or malformed; phase 2 must run first');
    }
    const mechanisms = mechBlob.mechanisms;
    console.log(`  ${mechanisms.length} mechanisms in catalog`);

    // Aggregate fragments
    const frags = new Map(); // key: `${kind}::${value}` -> {kind, value, mech_ids:Set, n_obs}

    function bump(kind, value, mechId, nObs) {
        const k = `${kind}::${value}`;
        if (!frags.has(k)) frags.set(k, { kind, value, mech_ids: new Set(), n_obs_total: 0 });
        const slot = frags.get(k);
        slot.mech_ids.add(mechId);
        slot.n_obs_total += nObs;
    }

    const mechToComps = {};
    for (const m of mechanisms) {
        const d = decomposeMechanismId(m.id);
        if (!d) continue;
        bump('source_kind', d.kind, m.id, m.n_observations || 0);
        bump('family', d.family, m.id, m.n_observations || 0);
        bump('position_bucket', d.bucket, m.id, m.n_observations || 0);
        // Pair-of-fragments: family + bucket, kind + bucket — useful for
        // recognizing "a phrase family at a particular slot in the timeline"
        bump('family_at_bucket', `${d.family}__${d.bucket}`, m.id, m.n_observations || 0);
        bump('kind_at_bucket', `${d.kind}__${d.bucket}`, m.id, m.n_observations || 0);
    }

    // Lift recurring fragments to components
    const components = [];
    let nextId = 1;
    for (const [, slot] of frags.entries()) {
        if (slot.mech_ids.size < MIN_RECURRENCE) continue;
        const compId = `comp_${String(nextId).padStart(4, '0')}`;
        nextId++;
        components.push({
            id: compId,
            label: `${slot.kind}: ${slot.value}`,
            fragment_kind: slot.kind,
            fragment_value: slot.value,
            n_mechanisms_using: slot.mech_ids.size,
            n_observations_total: slot.n_obs_total,
            mechanism_ids: Array.from(slot.mech_ids),
        });
    }
    components.sort((a, b) => b.n_mechanisms_using - a.n_mechanisms_using);

    // Build mechanism_components.json
    for (const c of components) {
        for (const m of c.mechanism_ids) {
            if (!mechToComps[m]) mechToComps[m] = [];
            mechToComps[m].push(c.id);
        }
    }

    const decomposedCount = Object.keys(mechToComps).length;
    const coveragePct = mechanisms.length ? +(decomposedCount / mechanisms.length * 100).toFixed(2) : 0;

    const compFile = path.join(JARVIS, 'components.json');
    lib.writeJson(compFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        min_recurrence: MIN_RECURRENCE,
        n_components: components.length,
        n_mechanisms_decomposed: decomposedCount,
        coverage_pct: coveragePct,
        components,
    });
    console.log(`  wrote components.json (${components.length} components, ${decomposedCount}/${mechanisms.length} mechanisms decomposed = ${coveragePct}%)`);

    const mechCompFile = path.join(JARVIS, 'mechanism_components.json');
    lib.writeJson(mechCompFile, {
        version: '1.0',
        generated_at: lib.nowIso(),
        n_mechanisms: Object.keys(mechToComps).length,
        mechanism_components: mechToComps,
    });
    console.log(`  wrote mechanism_components.json`);

    lib.patchStatus(s => {
        s.current_phase = PHASE_ID;
        s.current_phase_progress = { step: 'completed', completed_at: lib.nowIso() };
        s.phase_results = s.phase_results || {};
        s.phase_results[PHASE_ID] = {
            status: 'completed',
            started_at: startedAt,
            completed_at: lib.nowIso(),
            n_components: components.length,
            n_mechanisms_decomposed: decomposedCount,
            coverage_pct: coveragePct,
        };
        s.completed_phases = Array.from(new Set([...(s.completed_phases || []), PHASE_ID]));
        s.totals = s.totals || {};
        s.totals.n_components = components.length;
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
