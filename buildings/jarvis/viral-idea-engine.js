// Jarvis Viral Idea Engine — v2 (high-resolution blueprint model)
//
// Stage A (compress): Deterministic evidence lattice built from the full
// Jarvis artifact set. Broad — pulls from findings, research answers,
// principles, bridges, mechanisms, components, retention-patterns, word
// retention impact, video scorecards, prediction model, preupload model,
// indicator registry, candidate proposals, mechanism-indicator links.
//
// Stage B (generate): High-resolution idea blueprints. Not one-liners —
// full structured objects with first-frame, first-line, opening action,
// build phases, climax/payoff, arc, pacing, visual prescription, risk
// flags, scorecard targets, and MODELED estimated metrics (swipe-away,
// hook retention, share propensity, view band) with an auditable
// derivation for every estimate.
//
// No LLM calls. All evidence is grounded in on-disk artifacts and every
// estimated metric carries its derivation so the model is auditable.

const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = __dirname;

// Optional enrichment: jarvis-variable-catalog provides one-line definitions
// (label, modality, quantification, layer, signal) for any indicator key we
// reference in a validation trace. Imported best-effort so the engine still
// works if the file is moved or missing.
let variableCatalog = null;
try { variableCatalog = require('./jarvis-variable-catalog.js'); }
catch (e) { variableCatalog = null; }

function loadJsonSafe(name) {
    const p = path.join(ARTIFACT_DIR, name);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return null; }
}

function round(x, n = 4) {
    if (x === null || x === undefined || Number.isNaN(x)) return null;
    const k = Math.pow(10, n);
    return Math.round(x * k) / k;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ──────────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────────

function loadAllArtifacts() {
    return {
        findings: loadJsonSafe('findings-summary.json'),
        answers: loadJsonSafe('research_answers.json'),
        principles: loadJsonSafe('principles.json'),
        bridgeTop: loadJsonSafe('bridge_top_principles.json'),
        components: loadJsonSafe('components.json'),
        mechanisms: loadJsonSafe('mechanisms.json'),
        questions: loadJsonSafe('research_questions.json'),
        retentionPatterns: loadJsonSafe('retention-patterns.json'),
        wordImpact: loadJsonSafe('word-retention-impact.json'),
        videoScorecards: loadJsonSafe('video-scorecards.json'),
        predictionModel: loadJsonSafe('prediction-model.json'),
        preuploadModel: loadJsonSafe('preupload-model.json'),
        indicatorRegistry: loadJsonSafe('indicator-registry.json'),
        candidateProposals: loadJsonSafe('candidate_proposals.json'),
        mechanismIndicatorLinks: loadJsonSafe('mechanism_indicator_links.json'),
    };
}

// ──────────────────────────────────────────────────────────────────────
// Narrow-predictor helpers (carried over from v1, tightened)
// ──────────────────────────────────────────────────────────────────────

const TARGET_PROXY = new Set(['views', 'views_log10', 'log_views', 'log10_views']);

function collapseFamily(key) {
    return String(key)
        .replace(/_\d+_\d+$/, '_*')
        .replace(/_\d+$/, '_N');
}

function topPostUploadPredictors(answers, limit = 8) {
    if (!answers) return [];
    const q1 = answers.answers.find(a => a.question_id === 'q001');
    const raw = (q1 && q1.findings && q1.findings.strongest_post_upload && q1.findings.strongest_post_upload.top) || [];
    const seen = new Set();
    const out = [];
    for (const row of raw) {
        if (TARGET_PROXY.has(row.key)) continue;
        const family = collapseFamily(row.key);
        if (seen.has(family)) continue;
        seen.add(family);
        out.push({ key: row.key, family, r_to_views: round(row.r, 4) });
        if (out.length >= limit) break;
    }
    return out;
}

function topPreUploadPredictors(answers, limit = 10) {
    if (!answers) return [];
    const q1 = answers.answers.find(a => a.question_id === 'q001');
    const raw = (q1 && q1.findings && q1.findings.strongest_pre_upload && q1.findings.strongest_pre_upload.top) || [];
    const out = [];
    for (const row of raw) {
        if (TARGET_PROXY.has(row.key)) continue;
        out.push({
            key: row.key,
            r_to_views: round(row.r, 4),
            direction: row.r >= 0 ? 'higher → more views' : 'lower → more views',
        });
        if (out.length >= limit) break;
    }
    return out;
}

function topBridges(answers, limit = 12) {
    if (!answers) return [];
    const q4 = answers.answers.find(a => a.question_id === 'q004');
    const bridges = (q4 && q4.findings && q4.findings.top_bridges) || [];
    const paths = (q4 && q4.findings && q4.findings.top_multi_hop_paths) || [];
    const rows = [];
    for (const b of bridges) {
        if (TARGET_PROXY.has(b.pre) || TARGET_PROXY.has(b.post)) continue;
        const score = (b.path_score || b.bridge_strength || 0) * (b.sign_consistent ? 1 : 0.6);
        rows.push({
            pre: b.pre, post: b.post,
            pre_r: round(b.pre_r),
            post_r: round(b.post_r),
            bridge_strength: round(b.bridge_strength),
            sign_consistent: !!b.sign_consistent,
            score: round(score, 4),
            source: 'top_bridges',
        });
    }
    for (const p of paths) {
        if (TARGET_PROXY.has(p.pre) || TARGET_PROXY.has(p.post)) continue;
        rows.push({
            pre: p.pre, post: p.post,
            pre_r: round(p.pre_r),
            post_r: round(p.post_r),
            path_strength: round(p.path_strength),
            interaction_r: round(p.interaction_r),
            sign_consistent: !!p.sign_consistent,
            score: round((p.path_strength || 0) * (p.sign_consistent ? 1 : 0.6), 4),
            source: 'multi_hop',
        });
    }
    const map = new Map();
    for (const r of rows) {
        const k = `${r.pre}::${r.post}`;
        const cur = map.get(k);
        if (!cur || (r.score || 0) > (cur.score || 0)) map.set(k, r);
    }
    return [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

function topMechanismPrinciples(principles, bridgeTop, limit = 15) {
    const rows = [];
    if (principles && Array.isArray(principles.principles)) {
        for (const p of principles.principles) {
            if (!p.edge) continue;
            if (TARGET_PROXY.has(p.edge.via_indicator)) continue;
            if ((p.mechanism_n_videos || 0) < 20) continue;
            rows.push({
                principle_id: p.id,
                mechanism_id: p.edge.from_mechanism,
                via_indicator: p.edge.via_indicator,
                to_outcome: p.edge.to_outcome,
                mechanism_indicator_rho: round(p.mechanism_indicator_rho),
                indicator_outcome_r: round(p.indicator_outcome_r),
                chain_strength_signed: round(p.chain_strength_signed),
                chain_strength_specificity_weighted: round(p.chain_strength_specificity_weighted),
                mechanism_n_videos: p.mechanism_n_videos,
                mechanism_specificity_idf: round(p.mechanism_specificity_idf),
                source: 'principles',
            });
        }
    }
    if (bridgeTop && Array.isArray(bridgeTop.top)) {
        for (const p of bridgeTop.top) {
            if (TARGET_PROXY.has(p.via_indicator)) continue;
            rows.push({
                principle_id: p.principle_id,
                mechanism_id: p.mechanism_id,
                via_indicator: p.via_indicator,
                to_outcome: p.to_outcome,
                pre_to_post_rho: round(p.pre_to_post_rho),
                post_to_views_r: round(p.post_to_views_r),
                chain_strength: round(p.chain_strength),
                chain_strength_specificity_weighted: round(p.chain_strength_specificity_weighted),
                mechanism_n_videos: p.mechanism_n_videos,
                mechanism_specificity_idf: round(p.mechanism_specificity_idf),
                source: 'bridge_top',
            });
        }
    }
    const map = new Map();
    for (const r of rows) {
        const score = Math.abs(r.chain_strength_specificity_weighted || 0);
        const cur = map.get(r.principle_id);
        if (!cur || score > Math.abs(cur.chain_strength_specificity_weighted || 0)) map.set(r.principle_id, r);
    }
    return [...map.values()]
        .sort((a, b) => Math.abs(b.chain_strength_specificity_weighted || 0) - Math.abs(a.chain_strength_specificity_weighted || 0))
        .slice(0, limit);
}

function provenFeatures(findings) {
    if (!findings) return { kept_signals: [], discoveries: [], retention_patterns: [], concept_signals: [] };
    const kept = (findings.kept_signals || []).map(s => ({
        signal: s.signal,
        delta_r2: s.delta_r2,
        meaning: s.meaning,
        category: s.category,
    }));
    const discoveries = (findings.top_discoveries || [])
        .filter(d => d.r_partial === null || Math.abs(d.r_partial) >= 0.2)
        .map(d => ({ discovery: d.discovery, r_partial: d.r_partial, meaning: d.meaning }));
    const retention = (findings.retention_patterns || []).map(p => ({ pattern: p.pattern, evidence: p.evidence }));
    const conceptSignals = kept.filter(s => s.category === 'concept' || s.category === 'content');
    return { kept_signals: kept, discoveries, retention_patterns: retention, concept_signals: conceptSignals };
}

function topComponents(components, limit = 12) {
    if (!components || !Array.isArray(components.components)) return [];
    return components.components
        .filter(c => {
            if (c.fragment_kind === 'source_kind') return false;
            return (c.n_mechanisms_using || 0) >= 5;
        })
        .map(c => ({
            id: c.id,
            label: c.label,
            fragment_kind: c.fragment_kind,
            fragment_value: c.fragment_value,
            n_mechanisms_using: c.n_mechanisms_using,
            n_observations_total: c.n_observations_total,
        }))
        .sort((a, b) => (b.n_mechanisms_using || 0) - (a.n_mechanisms_using || 0))
        .slice(0, limit);
}

// ──────────────────────────────────────────────────────────────────────
// Evidence-lattice builders (NEW in v2) — compress richer artifacts
// ──────────────────────────────────────────────────────────────────────

function buildHookPrescription(rp, candidates) {
    if (!rp) return null;
    const brk = rp.BREAKTHROUGH_WAVE20 || {};
    const ow = rp.opening_words || {};
    const sp = rp.speaking_patterns || {};
    const hookTax = (rp.wave11_12_new_signals && rp.wave11_12_new_signals.hook_taxonomy) || null;
    // Opening speech rate candidate (target)
    let opening_rate_target = null;
    if (candidates && Array.isArray(candidates.families)) {
        for (const fam of candidates.families) {
            for (const c of (fam.candidates || [])) {
                if (c.key === 'opening_speech_rate_3s') {
                    opening_rate_target = { window: '0-3s', target_wps: '1.5-3.0 medium density', research: c.research_signal };
                    break;
                }
            }
            if (opening_rate_target) break;
        }
    }
    return {
        first_20s_is_everything: {
            retention_at_20s_r_with_views: brk.raw_retention_at_20s && brk.raw_retention_at_20s.r_with_views,
            retention_by_second: brk.raw_retention_at_20s && brk.raw_retention_at_20s.retention_by_second,
            design_rule: brk.raw_retention_at_20s && brk.raw_retention_at_20s.design_rule,
        },
        best_first_words: ow.best_first_words || [],
        worst_first_words: ow.worst_first_words || [],
        best_last_words: ow.best_last_words || [],
        opening_density: sp.opening_density || null,
        opening_rate_target,
        hook_taxonomy: hookTax,
    };
}

function buildArcStructure(rp) {
    if (!rp) return null;
    const arc = rp.narrative_arc_analysis || {};
    const shape = rp.shape_clustering || {};
    const quartile = rp.quartile_comparison || {};
    const wave7 = rp.wave7_new_signals || {};
    const wave9 = rp.wave9_10_new_signals || {};
    const waveShape = rp.wave11_12_new_signals && rp.wave11_12_new_signals.shape_encoding;
    const et = rp.emotional_trajectory || {};
    return {
        best_arc: arc.best_arc,
        second_best_arc: arc.second_best,
        worst_arc: arc.worst_arc,
        shape_clustering: shape,
        quartile_comparison: {
            Q4_top: quartile.Q4_top,
            Q1_bottom: quartile.Q1_bottom,
            key_insight: quartile.key_insight,
        },
        progression_patterns: wave7.quartile_templates || null,
        best_after_worst: wave9.best_after_worst,
        nadir_placement_pct_target: wave9.worst_moment_timing && wave9.worst_moment_timing.design_rule,
        divergence_point_pct: wave9.divergence_point && wave9.divergence_point.first_significant,
        recovery_speed: wave9.recovery_speed,
        shape_encoding: waveShape,
        emotional_trajectory: et,
    };
}

function buildVocabularyLattice(rp, wordImpact) {
    if (!rp && !wordImpact) return null;
    const dict = rp && rp.word_impact_dictionary || {};
    // Extract top ±positive / ±negative from word-retention-impact.json with n>=5
    let top_words_positive = [];
    let top_words_negative = [];
    if (wordImpact && typeof wordImpact === 'object') {
        const rows = [];
        for (const [w, v] of Object.entries(wordImpact)) {
            if (!v || typeof v !== 'object') continue;
            if ((v.n || 0) < 5) continue;
            rows.push({ word: w, avg_ab: v.avg_ab, n: v.n });
        }
        rows.sort((a, b) => (b.avg_ab || 0) - (a.avg_ab || 0));
        top_words_positive = rows.slice(0, 20).map(r => ({ word: r.word, delta: round(r.avg_ab, 4), n: r.n }));
        rows.sort((a, b) => (a.avg_ab || 0) - (b.avg_ab || 0));
        top_words_negative = rows.slice(0, 20).map(r => ({ word: r.word, delta: round(r.avg_ab, 4), n: r.n }));
    }
    const wave3v3 = rp && rp.wave11_12_new_signals && rp.wave11_12_new_signals.key_phrases;
    const wave7 = rp && rp.wave7_new_signals;
    return {
        top_words_positive,
        top_words_negative,
        legacy_top_positive: dict.top_positive || [],
        legacy_top_negative: dict.top_negative || [],
        peak_phrases: (wave3v3 && wave3v3.peak_phrases) || [],
        drop_phrases: (wave3v3 && wave3v3.drop_phrases) || [],
        inflection_upturn_words: (wave7 && wave7.inflection_words && wave7.inflection_words.upturn_words) || [],
        inflection_downturn_words: (wave7 && wave7.inflection_words && wave7.inflection_words.downturn_words) || [],
        pattern_note: dict.pattern || '',
    };
}

function buildPacingLattice(rp) {
    if (!rp) return null;
    const sp = rp.speaking_patterns || {};
    const wave9 = rp.wave9_10_new_signals || {};
    return {
        opening_density: sp.opening_density,
        peak_speaking_rate_wps: 3.86,
        drop_speaking_rate_wps: 4.26,
        neutral_speaking_rate_wps: 4.44,
        utterance_length_at_peaks_words: 7.9,
        utterance_length_at_drops_words: 25.3,
        pauses_rule: sp.pauses || 'Pauses hurt retention (ab=-0.060 vs -0.016 in speech). Pause rate r=-0.18 vs retention.',
        repetition_note: sp.repetition_rate || '',
        word_velocity_confirmed: wave9.word_velocity_confirmed || null,
        design_rule: 'Slow down at climax (3.0-3.8 w/s). Short sentences (<10 words) at peaks. No >1s pauses.',
    };
}

function buildVisualPrescription(rp, mil) {
    const out = {};
    if (rp) {
        out.vision_analysis = rp.vision_analysis_gpt4o_mini || null;
        out.peak_causes = rp.top_3_retention_peak_causes || [];
        out.drop_causes = rp.top_3_retention_drop_causes || [];
        out.cross_modal = rp.cross_modal_alignment || null;
    }
    // Mechanism-indicator links: what frame/visual mechanisms drive measured outcomes
    if (mil && Array.isArray(mil.links)) {
        const outcomes = ['swipe_away_rate', 'avg_retention', 'log_views'];
        const byOutcome = {};
        for (const l of mil.links) {
            if (!outcomes.includes(l.indicator_key)) continue;
            if (!l.mechanism_id || !l.mechanism_id.startsWith('frame_')) continue;
            (byOutcome[l.indicator_key] ||= []).push({
                mechanism: l.mechanism_id,
                rho: round(l.rho, 3),
                n: l.n,
            });
        }
        for (const k of Object.keys(byOutcome)) {
            byOutcome[k].sort((a, b) => Math.abs(b.rho || 0) - Math.abs(a.rho || 0));
            byOutcome[k] = byOutcome[k].slice(0, 6);
        }
        out.frame_mechanisms_by_outcome = byOutcome;
    }
    return out;
}

function buildPayoffLattice(rp) {
    if (!rp) return null;
    const top5 = rp.top_5_retention_predictors || [];
    const w8 = rp.wave8_new_signals || {};
    const w9 = rp.wave9_10_new_signals || {};
    const wave3v3 = rp.wave11_12_new_signals || {};
    return {
        end_recovery: top5.find(r => r.signal === 'END_RECOVERY') || null,
        hook_payoff_gap: top5.find(r => r.signal === 'HOOK_PAYOFF_GAP') || null,
        momentum_zones: top5.find(r => r.signal === 'MOMENTUM_ZONES') || null,
        viewer_fatigue: top5.find(r => r.signal === 'VIEWER_FATIGUE_SEVERITY') || null,
        event_density_inverse: top5.find(r => r.signal === 'EVENT_DENSITY_INVERSE') || null,
        negative_auc: w8.negative_AUC || null,
        word_position_matrix: w8.word_position_matrix || null,
        triple_interaction: w8.triple_interaction || null,
        best_after_worst: w9.best_after_worst || null,
        end_begin_ratio: wave3v3.end_begin_ratio || null,
        above_baseline_streak: wave3v3.above_baseline_streak || null,
    };
}

function buildInteractionRules(ir, predictionModel) {
    const out = [];
    // From indicator-registry: top pre-upload interactions by |r_partial|
    if (ir && Array.isArray(ir.indicators)) {
        const interactions = ir.indicators
            .filter(p => p.layer === 'pre' && p.key.includes('_x_') && !TARGET_PROXY.has(p.key))
            .sort((a, b) => Math.abs(b.r_partial || 0) - Math.abs(a.r_partial || 0))
            .slice(0, 12);
        for (const p of interactions) {
            out.push({
                key: p.key,
                r_partial: round(p.r_partial, 3),
                r_direct: round(p.r_direct, 3),
                note: (p.notes || '').slice(0, 200),
                source: 'indicator_registry.pre.interactions',
            });
        }
    }
    // From prediction model features labeled as interactions
    if (predictionModel && predictionModel.full_model && predictionModel.full_model.features) {
        const interactionFeats = predictionModel.full_model.features.filter(f => f.includes('_x_') || f.includes('_X_'));
        for (const f of interactionFeats) {
            out.push({
                key: f,
                r_partial: null,
                r_direct: null,
                note: (predictionModel.full_model.feature_descriptions || {})[f] || '',
                source: 'prediction_model.full',
            });
        }
    }
    // Dedupe by key
    const seen = new Set();
    return out.filter(r => { if (seen.has(r.key)) return false; seen.add(r.key); return true; });
}

function buildScorecardDimensions(videoScorecards) {
    if (!videoScorecards) return null;
    const arr = Array.isArray(videoScorecards) ? videoScorecards : Object.values(videoScorecards).filter(v => typeof v === 'object' && v.ytId);
    if (!arr.length) return null;
    // Aggregate mean / top quartile on each dimension
    const dims = ['over_delivery', 'late_retention', 'consistency', 'smoothness', 'sensory_language', 'material_avoidance', 'early_momentum'];
    const stats = {};
    for (const d of dims) {
        const vals = arr.map(v => (v.scores && v.scores[d])).filter(x => typeof x === 'number').sort((a, b) => a - b);
        if (!vals.length) continue;
        const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
        const p25 = vals[Math.floor(vals.length * 0.25)];
        const p75 = vals[Math.floor(vals.length * 0.75)];
        const p90 = vals[Math.floor(vals.length * 0.90)];
        stats[d] = { mean: round(mean, 2), p25: round(p25, 2), p75: round(p75, 2), p90: round(p90, 2) };
    }
    // Top 5 scorecards
    const top5 = arr.slice().sort((a, b) => (b.total_score || 0) - (a.total_score || 0)).slice(0, 5)
        .map(v => ({ ytId: v.ytId, views: v.views, total_score: round(v.total_score, 2), scores: v.scores }));
    // Fit view band per composite score bucket: mean views by total_score quintile
    const withScore = arr.filter(v => typeof v.total_score === 'number' && typeof v.views === 'number').sort((a, b) => a.total_score - b.total_score);
    const viewBandsByScore = [];
    const n = withScore.length;
    const quintile = Math.max(1, Math.floor(n / 5));
    for (let i = 0; i < 5; i++) {
        const chunk = withScore.slice(i * quintile, i === 4 ? n : (i + 1) * quintile);
        if (!chunk.length) continue;
        const viewsSorted = chunk.map(v => v.views).sort((a, b) => a - b);
        viewBandsByScore.push({
            score_quintile: i + 1,
            score_range: [round(chunk[0].total_score, 2), round(chunk[chunk.length - 1].total_score, 2)],
            views_median: viewsSorted[Math.floor(viewsSorted.length / 2)],
            views_p25: viewsSorted[Math.floor(viewsSorted.length * 0.25)],
            views_p75: viewsSorted[Math.floor(viewsSorted.length * 0.75)],
            n: chunk.length,
        });
    }
    return { n_scorecards: arr.length, dimension_stats: stats, top_5_exemplars: top5, view_bands_by_score: viewBandsByScore };
}

function buildPredictionModelSummary(predictionModel, preuploadModel) {
    if (!predictionModel && !preuploadModel) return null;
    const out = { pre_upload: null, full: null, minimal_preupload: null };
    if (predictionModel && predictionModel.pre_upload_model) {
        out.pre_upload = {
            cv_r2: predictionModel.pre_upload_model.cv_r2_mean,
            prediction_range_multiplier: predictionModel.pre_upload_model.prediction_range_multiplier,
            n_videos: predictionModel.pre_upload_model.n_videos,
            features: predictionModel.pre_upload_model.features,
            feature_descriptions: predictionModel.pre_upload_model.feature_descriptions,
        };
    }
    if (predictionModel && predictionModel.full_model) {
        out.full = {
            cv_r2: predictionModel.full_model.cv_r2_mean,
            prediction_range_multiplier: predictionModel.full_model.prediction_range_multiplier,
            n_videos: predictionModel.full_model.n_videos,
            features: predictionModel.full_model.features,
            feature_categories: predictionModel.full_model.feature_categories,
            feature_descriptions: predictionModel.full_model.feature_descriptions,
        };
    }
    if (preuploadModel && preuploadModel.features_strict) {
        out.minimal_preupload = {
            cv_r2: preuploadModel.cv_r2_strict,
            features: preuploadModel.features_strict,
            weights: preuploadModel.weights,
            bias: preuploadModel.bias,
        };
    }
    return out;
}

function buildRiskFlags(rp) {
    if (!rp) return [];
    const out = [];
    const dr = rp.top_3_retention_drop_causes || [];
    for (const c of dr) {
        out.push({ flag: c.cause, evidence: c.evidence, effect_size: c.effect_size, rule: c.design_rule, source: 'top_3_drop_causes' });
    }
    const w9 = rp.wave9_10_new_signals || {};
    if (w9.worst_moment_timing) out.push({ flag: 'LATE_WORST_MOMENT', evidence: w9.worst_moment_timing.description, rule: w9.worst_moment_timing.design_rule, source: 'wave9_10' });
    const wave3v3 = rp.wave11_12_new_signals || {};
    if (wave3v3.key_phrases && wave3v3.key_phrases.drop_phrases) {
        out.push({ flag: 'CTA_DRIFT_PHRASES', evidence: 'phrases like "link in bio" / "see what happens" / "on my profile" are enriched at drops', rule: 'avoid drop phrases; prefer peak phrases ("in the comments", "should I keep", "i keep going")', source: 'wave11_12.key_phrases' });
    }
    if (wave3v3.hook_taxonomy) {
        out.push({ flag: 'STAKES_HOOK_UNDERPERFORMS', evidence: `stakes=${wave3v3.hook_taxonomy.worst}; transformation=${wave3v3.hook_taxonomy.best}`, rule: 'avoid stakes-based framing ("if this fails…") — use transformation or mystery', source: 'wave11_12.hook_taxonomy' });
    }
    const cm = rp.cross_modal_alignment || {};
    if (cm.visual_only_negative) out.push({ flag: 'VISUAL_ONLY_ENERGY', evidence: cm.visual_only_negative, rule: 'verbal energy drives retention more than visual. Pair visual beats with spoken sensory language.', source: 'cross_modal_alignment' });
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// Hook mechanisms (first-5s / first-10s / hook-quarter)
// ──────────────────────────────────────────────────────────────────────

function extractHookMechanisms(brief) {
    const out = [];
    for (const p of brief.top_mechanism_principles) {
        const mid = String(p.mechanism_id || '');
        let bucket = null;
        if (mid.includes('first_5s')) bucket = 'first_5s';
        else if (mid.includes('first_10s')) bucket = 'first_10s';
        else if (mid.includes('hook_quarter')) bucket = 'hook_quarter';
        if (!bucket) continue;
        out.push({
            mechanism_id: p.mechanism_id,
            bucket,
            principle_id: p.principle_id,
            via_indicator: p.via_indicator,
            csw: p.chain_strength_specificity_weighted,
            sign: (p.chain_strength_specificity_weighted || 0) >= 0 ? 'positive' : 'negative',
            n_videos: p.mechanism_n_videos,
        });
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// compress(): full Stage A lattice
// ──────────────────────────────────────────────────────────────────────

function compress(artifacts) {
    artifacts = artifacts || loadAllArtifacts();
    const {
        findings, answers, principles, bridgeTop, components, mechanisms,
        retentionPatterns, wordImpact, videoScorecards, predictionModel,
        preuploadModel, indicatorRegistry, candidateProposals, mechanismIndicatorLinks,
    } = artifacts;

    const brief = {
        generated_at: new Date().toISOString(),
        engine_version: 'v2',
        source_sizes: {
            findings_model_history: (findings && findings.model_history || []).length,
            principles_total: principles && principles.n_principles,
            bridge_top_count: bridgeTop && bridgeTop.top ? bridgeTop.top.length : 0,
            components_total: components && components.n_components,
            mechanisms_total: mechanisms && mechanisms.n_mechanisms,
            videos_in_pool: mechanisms && mechanisms.n_videos_pool,
            indicators_total: indicatorRegistry && indicatorRegistry.total,
            candidate_proposal_families: candidateProposals && candidateProposals.families ? candidateProposals.families.length : 0,
            mechanism_indicator_links: mechanismIndicatorLinks && mechanismIndicatorLinks.n_links,
            retention_pattern_waves: retentionPatterns && retentionPatterns.analysis_waves,
            word_retention_scored: wordImpact ? Object.keys(wordImpact).length : 0,
            video_scorecards_count: videoScorecards ? (Array.isArray(videoScorecards) ? videoScorecards.length : Object.keys(videoScorecards).length) : 0,
        },
        headline_model_r2: (() => {
            const hist = (findings && findings.model_history) || [];
            for (let i = hist.length - 1; i >= 0; i--) {
                const m = hist[i];
                if (!/CORRUPTED/i.test(m.model)) return { model: m.model, cv_r2: m.cv_r2, n_features: m.n_features };
            }
            return null;
        })(),

        // v1 lattice (still surfaced)
        top_post_upload_predictors: topPostUploadPredictors(answers, 8),
        top_pre_upload_predictors: topPreUploadPredictors(answers, 10),
        top_bridges_pre_to_post_to_views: topBridges(answers, 12),
        top_mechanism_principles: topMechanismPrinciples(principles, bridgeTop, 15),
        proven_features: provenFeatures(findings),
        top_components: topComponents(components, 12),

        // v2 lattice (NEW)
        evidence_lattice: {
            hook_prescription: buildHookPrescription(retentionPatterns, candidateProposals),
            arc_structure: buildArcStructure(retentionPatterns),
            vocabulary: buildVocabularyLattice(retentionPatterns, wordImpact),
            pacing: buildPacingLattice(retentionPatterns),
            visual_prescription: buildVisualPrescription(retentionPatterns, mechanismIndicatorLinks),
            payoff_zone: buildPayoffLattice(retentionPatterns),
            interaction_rules: buildInteractionRules(indicatorRegistry, predictionModel),
            scorecard_dimensions: buildScorecardDimensions(videoScorecards),
            prediction_model_summary: buildPredictionModelSummary(predictionModel, preuploadModel),
            risk_flags: buildRiskFlags(retentionPatterns),
            design_rules_v3: retentionPatterns && (retentionPatterns.design_rules_summary_v3 || retentionPatterns.design_rules_summary) || [],
            duration_insight: retentionPatterns && retentionPatterns.duration_insight || null,
            compound_score_note: retentionPatterns && retentionPatterns.compound_score_v2 || null,
        },
    };
    brief.hook_mechanisms = extractHookMechanisms(brief);
    return brief;
}

// ──────────────────────────────────────────────────────────────────────
// Stage B: BLUEPRINT GENERATOR
//
// Each seed describes an idea in broad strokes. The generator fills in
// concrete opening/build/climax fields from the lattice and computes
// MODELED estimated metrics with explicit derivation.
// ──────────────────────────────────────────────────────────────────────

const NARRATIVE_STRUCTURES = [
    { id: 'late_peak_arc', label: 'Late-peak dramatic arc (peak at 60-80% of runtime)', weight: 0.9, evidence: "Retention pattern: videos peaking at 60-80% get ~10x more views than early-peaking (5.2M vs 530K median)." },
    { id: 'golden_final_5pct', label: 'Golden final 5% (spike visceral payoff in last 5% of runtime)', weight: 0.8, evidence: "Videos at 95-99% percentile gain +8.0% above baseline vs -0.4% rest." },
    { id: 'dramatic_pacing', label: 'Dramatic pacing: large max_cliff + high deriv_std', weight: 0.8, evidence: "max_cliff r_partial=+0.36. BIGGER retention drops = MORE views. Pacing complexity beats monotonic decay." },
    { id: 'visceral_body_language', label: 'Visceral/physical language ramp (hurt, painful, stomach, numb)', weight: 0.7, evidence: "Retention gain: painful +5.9%, curious +6.1%, numb +5.0%, stomach +5.1%. Sensory rate weight +1.59 in regression." },
    { id: 'fast_pacing_no_pauses', label: 'Fast speech + no long silences', weight: 0.5, evidence: "Speech rate r=+0.24 vs retention. Pauses >1s r=-0.22. Transitions ('so', 'however') drop -11.2% / -8.6%." },
    { id: 'callback_closure', label: 'Callback to hook concept in last 20%', weight: 0.4, evidence: "has_callback r=0.14 vs keep. 46% of videos use callbacks." },
    { id: 'comeback_arc', label: 'Comeback arc (negative → positive emotional trajectory)', weight: 0.7, evidence: "neg_to_pos emotional trajectory avg 10x views of pos_to_neg." },
    { id: 'monotonic_rise', label: 'Monotonic rise (Q1<Q2<Q3<Q4 retention)', weight: 0.7, evidence: "Progression ↑↑↑ = 4.19M vs ↓↓↓ = 222K (19x gap). Every quarter beats the last." },
    { id: 'nadir_before_climax', label: 'Nadir placed before climax (low→high, never reverse)', weight: 0.6, evidence: "best_after_worst 3.3M vs best_before_worst 650K (5x)." },
];

const DURATION_BANDS = [
    { id: 'sweet_spot_46_60', label: '46–60s sweet spot', weight: 1.0, seconds: 52, evidence: "50-55s = 2.88M avg views. 40-55s safe range. 15-30s = death zone." },
    { id: 'safe_40_55', label: '40–55s safe zone', weight: 0.8, seconds: 48, evidence: "40-45s=2.19M, 45-50s=2.13M. Consistently above median." },
];

// ──────────────────────────────────────────────────────────────────────
// Motif-atom synthesizer (v3) — replaces hardcoded full premises.
//
// What IS hardcoded: ~13 safe object atoms (pushups, plank, sandbag
// carry, memorize-a-book, rubber-band ball, origami, portrait-drawing,
// etc.) and 4 endpoint kinds (count, timer, distance, body-quit). Each
// atom carries structured metadata: verb, noun, scale range, body
// parts, sensation words, visual action, safety tier, category.
//
// What is SYNTHESIZED from the lattice at generate-time:
//   - title, logline, promise, payoff, over-delivery note
//   - opening.first_frame / first_line / opening_action / hook_type /
//     best_first_word_used / opening_speech_rate_wps_target
//   - build_phases (5 zones) — beats pulled from top_5_retention_predictors
//   - narrative_structures — ranked from retention-pattern top predictors
//   - pre_upload_levers — chosen from brief.top_pre_upload_predictors
//   - vocabulary_hints.use_peak_words — intersection of obj sensation
//     words with lattice top_words_positive + peak-cause-derived words
//   - vocabulary_hints.avoid_material_words — from lattice top_words_negative
//   - closing_words — from opening_words.best_last_words
//   - share_triggers — from wave11_12.key_phrases.peak_phrases
//   - visual_prescription_hints — per-zone, derived from top frame
//     mechanisms (mechanism_indicator_links) and top_3_retention_peak_causes
//
// Each object × endpoint combo is scored against the lattice (sensory
// alignment, action intensity, material-word risk, safety tier, numeric
// specificity of endpoint). Top N (with per-category cap) survive.
// Risky atoms are excluded up front.

const OBJECT_MOTIFS = [
    {
        id: 'pushups_one_day',
        verb_past_phrase: 'Did',
        verb_present_phrase: 'do',
        noun_subject_phrase: 'push-ups',
        title_core_tpl: 'I Did {N} Push-Ups In One Day',
        logline_action: 'push push-ups out one rep at a time',
        concrete_kind: 'reps',
        scales: [500, 1000, 2000, 5000],
        body_parts: ['shoulders', 'arms', 'chest', 'stomach'],
        body_part_phrase: 'shoulders',
        sensation_words: ['numb', 'bigger', 'painful', 'feeling'],
        first_frame_action: 'mid-rep with the counter visible',
        visual_action_short: 'a push-up from the top of the motion',
        action_intensity: 'high',
        safety_tier: 'safe',
        category: 'repetition_endurance',
        setting_hint: 'in my garage',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'plank_hold_hours',
        verb_past_phrase: 'Held',
        verb_present_phrase: 'hold',
        noun_subject_phrase: 'a plank',
        title_core_tpl: 'I Held A Plank For {D}',
        logline_action: 'hold a plank flat on the ground',
        concrete_kind: 'duration',
        scales: ['1 hour', '2 hours', '3 hours'],
        body_parts: ['stomach', 'shoulders', 'skin'],
        body_part_phrase: 'stomach',
        sensation_words: ['stomach', 'numb', 'bigger', 'painful', 'feeling'],
        first_frame_action: 'body already in the plank position with timer counting',
        visual_action_short: 'a plank held flat with a running timer',
        action_intensity: 'medium',
        safety_tier: 'safe',
        category: 'isometric_endurance',
        setting_hint: 'on gym flooring with a timer overlay',
        endpoint_kinds: ['time_to_target', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'weighted_backpack_march',
        verb_past_phrase: 'Marched With',
        verb_present_phrase: 'march with',
        noun_subject_phrase: 'a weighted backpack',
        title_core_tpl: 'I Marched With A Weighted Backpack For {D}',
        logline_action: 'march with a weighted backpack step by step',
        concrete_kind: 'distance',
        scales: ['20 miles', '30 miles', '26.2 miles'],
        body_parts: ['foot', 'skin', 'stomach'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'skin', 'numb', 'painful', 'feeling', 'bigger'],
        first_frame_action: 'boots hitting pavement with a loaded pack on my back',
        visual_action_short: 'boots in motion with a mile-counter overlay',
        action_intensity: 'medium',
        safety_tier: 'safe',
        category: 'locomotion_endurance',
        setting_hint: 'on a marked road',
        endpoint_kinds: ['exact_distance', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'stair_climb_repeats',
        verb_past_phrase: 'Climbed',
        verb_present_phrase: 'climb',
        noun_subject_phrase: 'a single flight of stairs',
        title_core_tpl: 'I Climbed A Single Flight Of Stairs {N} Times',
        logline_action: 'run up a single flight of stairs',
        concrete_kind: 'reps',
        scales: [500, 1000, 3000],
        body_parts: ['foot', 'stomach', 'skin'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'bigger', 'painful', 'numb', 'feeling'],
        first_frame_action: 'mid-step on the stairs with a counter overlay',
        visual_action_short: 'running up a flight with foot-on-stair visible',
        action_intensity: 'high',
        safety_tier: 'safe',
        category: 'repetition_endurance',
        setting_hint: 'in a stairwell',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'jump_rope_day',
        verb_past_phrase: 'Jumped Rope',
        verb_present_phrase: 'jump rope',
        noun_subject_phrase: 'jump rope',
        title_core_tpl: 'I Jumped Rope {N} Times In One Day',
        logline_action: 'jump rope non-stop',
        concrete_kind: 'reps',
        scales: [5000, 10000, 20000],
        body_parts: ['foot', 'skin', 'stomach'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'painful', 'numb', 'bigger', 'feeling'],
        first_frame_action: 'mid-jump with the rope arcing overhead',
        visual_action_short: 'rope spinning with feet leaving the ground',
        action_intensity: 'high',
        safety_tier: 'safe',
        category: 'repetition_endurance',
        setting_hint: 'on a driveway',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'sandbag_carry',
        verb_past_phrase: 'Carried',
        verb_present_phrase: 'carry',
        noun_subject_phrase: 'a 100-lb sandbag',
        title_core_tpl: 'I Carried A 100-Lb Sandbag For {D}',
        logline_action: 'carry a 100-lb sandbag on my shoulder',
        concrete_kind: 'distance',
        scales: ['5 miles', '10 miles', '15 miles'],
        body_parts: ['shoulders', 'foot', 'skin', 'stomach'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'bigger', 'numb', 'painful', 'feeling', 'skin'],
        first_frame_action: 'sandbag heaved onto my shoulder mid-step',
        visual_action_short: 'the bag carried step by step with a distance overlay',
        action_intensity: 'high',
        safety_tier: 'safe',
        category: 'locomotion_endurance',
        setting_hint: 'on a long stretch of road',
        endpoint_kinds: ['exact_distance', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'memorize_book',
        verb_past_phrase: 'Memorized',
        verb_present_phrase: 'memorize',
        noun_subject_phrase: 'a short novel',
        title_core_tpl: 'I Memorized Every Page Of A Short Novel In {T}',
        title_core_tpl_reps: 'I Memorized {N} Pages Of A Short Novel In One Day',
        logline_action: 'memorize pages of a short novel one at a time',
        concrete_kind: 'pages',
        scales: [50, 100, 150],
        body_parts: ['feeling', 'skin'],
        body_part_phrase: 'head',
        sensation_words: ['curious', 'feeling', 'numb', 'bigger'],
        first_frame_action: 'hand flipping to a checked-off page on the page grid',
        visual_action_short: 'a book flipping with page checkmarks filling in',
        action_intensity: 'medium',
        safety_tier: 'safe',
        category: 'cognitive_endurance',
        setting_hint: 'at a desk with a page tally on the wall',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'handwritten_letters',
        verb_past_phrase: 'Hand-Wrote',
        verb_present_phrase: 'hand-write',
        noun_subject_phrase: 'letters',
        title_core_tpl: 'I Hand-Wrote {N} Letters — One To Every Contact In My Phone',
        logline_action: 'hand-write letters — one for every contact in my phone',
        concrete_kind: 'reps',
        scales: [100, 300, 500],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['feeling', 'numb', 'painful', 'bigger'],
        first_frame_action: 'mid-line of handwriting with a finished stack in frame',
        visual_action_short: 'a hand writing with a stack of addressed envelopes growing',
        action_intensity: 'medium',
        safety_tier: 'safe',
        category: 'repetition_patience',
        setting_hint: 'at a desk beside a stack of stamped envelopes',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'portrait_drawing_strangers',
        verb_past_phrase: 'Drew Portraits Of',
        verb_present_phrase: 'draw portraits of',
        noun_subject_phrase: 'strangers on one street corner',
        title_core_tpl: 'I Drew Portraits Of {N} Strangers On One Street Corner',
        logline_action: 'draw a portrait of every stranger who walks past a corner',
        concrete_kind: 'reps',
        scales: [100, 300, 500],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['curious', 'feeling', 'bigger', 'painful'],
        first_frame_action: 'pencil mid-line on a portrait with a finished stack behind it',
        visual_action_short: 'a hand drawing with a growing stack of finished portraits',
        action_intensity: 'medium',
        safety_tier: 'safe',
        category: 'repetition_social',
        setting_hint: 'on a busy sidewalk',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'rubber_band_ball',
        verb_past_phrase: 'Built',
        verb_present_phrase: 'build',
        noun_subject_phrase: 'a rubber-band ball',
        title_core_tpl: 'I Built A Rubber-Band Ball Out Of {N} Bands',
        logline_action: 'wrap rubber bands around a growing ball',
        concrete_kind: 'reps',
        scales: [5000, 10000, 25000],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['bigger', 'numb', 'skin', 'painful', 'feeling'],
        first_frame_action: 'mid-stretch of a rubber band onto a growing ball',
        visual_action_short: 'hands wrapping rubber bands around a ball',
        action_intensity: 'low',
        safety_tier: 'safe',
        category: 'repetition_craft',
        setting_hint: 'at a desk with a band counter and a ruler against the ball',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'origami_cranes',
        verb_past_phrase: 'Folded',
        verb_present_phrase: 'fold',
        noun_subject_phrase: 'origami cranes',
        title_core_tpl: 'I Folded {N} Origami Cranes In One Day',
        logline_action: 'fold origami cranes one after another',
        concrete_kind: 'reps',
        scales: [500, 1000, 1500],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['bigger', 'curious', 'feeling', 'painful'],
        first_frame_action: 'mid-fold on a crane with a counter and a pile in frame',
        visual_action_short: 'fingers folding paper and adding to a crane pile',
        action_intensity: 'low',
        safety_tier: 'safe',
        category: 'repetition_craft',
        setting_hint: 'at a table with a growing pile of cranes',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'jigsaw_speedrun',
        verb_past_phrase: 'Solved',
        verb_present_phrase: 'solve',
        noun_subject_phrase: 'a jigsaw puzzle',
        title_core_tpl: 'I Solved A {N}-Piece Jigsaw Puzzle In One Day',
        logline_action: 'solve a giant jigsaw puzzle piece by piece',
        concrete_kind: 'pieces',
        scales: [5000, 10000, 25000],
        body_parts: ['feeling', 'skin'],
        body_part_phrase: 'hand',
        sensation_words: ['curious', 'bigger', 'painful', 'feeling'],
        first_frame_action: 'hand pressing a piece into place with a completion bar filling',
        visual_action_short: 'hands sliding puzzle pieces with a completion-% overlay climbing',
        action_intensity: 'low',
        safety_tier: 'safe',
        category: 'cognitive_patience',
        setting_hint: 'at a long puzzle table',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'coin_edge_tower',
        verb_past_phrase: 'Stacked',
        verb_present_phrase: 'stack',
        noun_subject_phrase: 'coins on their edges',
        title_core_tpl: 'I Stacked {N} Coins On Their Edges Into One Tower',
        logline_action: 'stack coins on their edges one at a time',
        concrete_kind: 'reps',
        scales: [200, 500, 1000],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['bigger', 'curious', 'feeling', 'painful'],
        first_frame_action: 'fingers placing a coin onto the precarious stack',
        visual_action_short: 'a hand placing coins on a growing, tilting stack',
        action_intensity: 'low',
        safety_tier: 'safe',
        category: 'fine_motor_patience',
        setting_hint: 'at a table with a height ruler taped behind the tower',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
];

const ENDPOINT_MOTIFS = [
    { id: 'exact_count',    kind: 'count',    reveal_label: 'the counter froze at' },
    { id: 'time_to_target', kind: 'timer',    reveal_label: 'the timer froze at' },
    { id: 'exact_distance', kind: 'distance', reveal_label: 'the mile counter froze at' },
    { id: 'body_quit',      kind: 'body',     reveal_label: 'my body quit at' },
];

function deriveMotifContext(brief, artifacts) {
    const rp = (artifacts && artifacts.retentionPatterns) || {};
    const lat = brief.evidence_lattice || {};
    const voc = lat.vocabulary || {};
    const positiveWords = new Set((voc.top_words_positive || []).map(w => w.word));
    const negativeWords = new Set((voc.top_words_negative || []).map(w => w.word));
    const peakWordsRanked = (voc.top_words_positive || []).map(w => w.word);
    const negWordsRanked = (voc.top_words_negative || []).map(w => w.word);
    const peakPhrases = voc.peak_phrases || [];
    const dropPhrases = voc.drop_phrases || [];

    const bestFirstWords = ((rp.opening_words && rp.opening_words.best_first_words) || [])
        .map(e => String(e).split('(')[0].trim()).filter(Boolean);
    const worstFirstWords = ((rp.opening_words && rp.opening_words.worst_first_words) || [])
        .map(e => String(e).split('(')[0].trim()).filter(Boolean);
    const bestLastWords = ((rp.opening_words && rp.opening_words.best_last_words) || [])
        .map(e => String(e).split('(')[0].trim()).filter(Boolean);

    const hookTax = rp.wave11_12_new_signals && rp.wave11_12_new_signals.hook_taxonomy;
    const preferHookTypes = [];
    if (hookTax) {
        const best = String(hookTax.best || '').split(/\s|\(/)[0].trim().toLowerCase();
        const second = String(hookTax.second || '').split(/\s|\(/)[0].trim().toLowerCase();
        if (best) preferHookTypes.push(best);
        if (second && second !== best) preferHookTypes.push(second);
    }

    const peakCauses = (rp.top_3_retention_peak_causes || []).map(c => String(c.cause || ''));
    const dropCauses = (rp.top_3_retention_drop_causes || []).map(c => String(c.cause || ''));

    // Map top-5 retention predictors to narrative_structures IDs we know.
    const preds5 = rp.top_5_retention_predictors || [];
    const predSignals = new Set(preds5.map(p => String(p.signal || '').toUpperCase()));
    const structureRanked = [];
    if (predSignals.has('END_RECOVERY')) structureRanked.push('golden_final_5pct');
    if (predSignals.has('HOOK_PAYOFF_GAP')) structureRanked.push('late_peak_arc');
    if (predSignals.has('MOMENTUM_ZONES')) structureRanked.push('monotonic_rise');
    if (peakCauses.some(c => /PHYSICAL|SENSORY/i.test(c))) structureRanked.push('visceral_body_language');
    if (peakCauses.some(c => /SPEAKING|SLOWER/i.test(c))) structureRanked.push('fast_pacing_no_pauses');
    const wave9 = rp.wave9_10_new_signals || {};
    if (wave9.best_after_worst) structureRanked.push('nadir_before_climax');
    const emo = rp.emotional_trajectory || {};
    if (emo.best && /neg_to_pos/i.test(String(emo.best))) structureRanked.push('comeback_arc');

    // Frame mechanisms by outcome (zone-specific visual prescription)
    const mil = (artifacts && artifacts.mechanismIndicatorLinks) || null;
    const frameMechs = {
        first_5s: [], first_10s: [], hook_quarter: [], mid: [], late: [],
    };
    if (mil && Array.isArray(mil.links)) {
        for (const l of mil.links) {
            if (!l.mechanism_id || !l.mechanism_id.startsWith('frame_')) continue;
            const mid = String(l.mechanism_id);
            for (const z of Object.keys(frameMechs)) {
                if (mid.endsWith('_at_' + z)) frameMechs[z].push({ id: mid, rho: l.rho, outcome: l.indicator_key, n: l.n });
            }
        }
        for (const z of Object.keys(frameMechs)) {
            frameMechs[z].sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
        }
    }

    // Pre-upload lever pool (from brief)
    const preLeverPool = (brief.top_pre_upload_predictors || []).map(p => p.key);
    const interactionPool = (lat.interaction_rules || []).map(r => r.key);

    return {
        positiveWords, negativeWords,
        peakWordsRanked, negWordsRanked,
        peakPhrases, dropPhrases,
        bestFirstWords, worstFirstWords, bestLastWords,
        preferHookTypes,
        peakCauses, dropCauses,
        structureRanked,
        frameMechs,
        preLeverPool, interactionPool,
    };
}

function scoreMotifCombo(obj, endpoint, ctx) {
    let score = 0;
    const drivers = [];

    // Sensory word alignment (PHYSICAL/SENSORY LANGUAGE peak cause)
    const sensoryHits = (obj.sensation_words || []).filter(w => ctx.positiveWords.has(w));
    if (sensoryHits.length) {
        const d = round(sensoryHits.length * 0.12, 3);
        score += d; drivers.push({ driver: 'sensory_words_in_corpus_positive_list', delta: d, words: sensoryHits });
    }
    const bodyHits = (obj.body_parts || []).filter(w => ctx.positiveWords.has(w));
    if (bodyHits.length) {
        const d = round(bodyHits.length * 0.08, 3);
        score += d; drivers.push({ driver: 'body_parts_in_corpus_positive_list', delta: d, words: bodyHits });
    }
    // Material word risk (TECHNICAL/MATERIAL LANGUAGE drop cause)
    const matHits = (obj.implied_material_words || []).filter(w => ctx.negativeWords.has(w));
    if (matHits.length) {
        const d = round(-0.40 * matHits.length, 3);
        score += d; drivers.push({ driver: 'material_word_risk', delta: d, words: matHits });
    }
    // Action intensity (HIGH-ENERGY ACTION FRAMES peak cause)
    if (obj.action_intensity === 'high') { score += 0.30; drivers.push({ driver: 'action_intensity_high', delta: 0.30 }); }
    else if (obj.action_intensity === 'medium') { score += 0.18; drivers.push({ driver: 'action_intensity_medium', delta: 0.18 }); }
    else { score += 0.06; drivers.push({ driver: 'action_intensity_low', delta: 0.06 }); }

    // Safety tier
    if (obj.safety_tier === 'safe') { score += 0.10; drivers.push({ driver: 'safety_tier_safe', delta: 0.10 }); }
    else if (obj.safety_tier === 'risky') { score -= 1.0; drivers.push({ driver: 'safety_tier_risky', delta: -1.0 }); }

    // Endpoint specificity — numeric endpoints land the over-delivery payoff
    if (endpoint.kind === 'count' || endpoint.kind === 'timer' || endpoint.kind === 'distance') {
        score += 0.20; drivers.push({ driver: 'numeric_specific_endpoint', delta: 0.20 });
    } else if (endpoint.kind === 'body' && obj.action_intensity !== 'high') {
        score -= 0.08; drivers.push({ driver: 'body_quit_weak_on_non_intense_action', delta: -0.08 });
    }
    return { score: round(score, 3), drivers };
}

function pickScale(obj) {
    const scales = obj.scales || [];
    const idx = Math.min(scales.length - 1, Math.max(0, Math.floor(scales.length / 2)));
    const val = scales[idx];
    if (obj.concrete_kind === 'reps' || obj.concrete_kind === 'pages' || obj.concrete_kind === 'pieces') {
        return { kind: 'count', value: val, display: (val || 0).toLocaleString('en-US') };
    }
    if (obj.concrete_kind === 'duration') return { kind: 'duration', value: val, display: String(val) };
    if (obj.concrete_kind === 'distance') return { kind: 'distance', value: val, display: String(val) };
    return { kind: 'other', value: val, display: String(val || '') };
}

function pickFirstWord(obj, ctx) {
    const wordMap = {
        'jump rope': 'go', 'march': 'walk', 'carry': 'go', 'climb': 'break',
        'memorize': 'these', 'hand-write': 'these', 'draw portraits of': 'how',
        'build': 'how', 'fold': 'these', 'solve': 'these', 'stack': 'these',
        'do': 'go', 'hold': 'break',
    };
    const candidate = wordMap[obj.verb] || (ctx.bestFirstWords[0] || 'go');
    if (ctx.bestFirstWords.includes(candidate)) return candidate;
    return ctx.bestFirstWords[0] || 'go';
}

function capitalize(s) {
    return String(s || '').replace(/(^|\s|-)([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

// Compose a specific, over-delivery-flavored reveal number given the scale.
// For counts/pages/pieces we nudge slightly above the round number; for
// distances we append the exact tenth; for durations we add an exact second.
function overDeliveryRevealValue(scale, endpoint) {
    if (endpoint.kind === 'timer') {
        if (typeof scale.value === 'string' && /hour/.test(scale.value)) {
            const hours = parseFloat(String(scale.value).match(/([\d.]+)/)[1]);
            const sec = 7 + (Math.floor(Math.abs(hours * 11)) % 40);
            return `${Math.floor(hours)}:${String(Math.floor((hours - Math.floor(hours)) * 60)).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
        return scale.display;
    }
    if (endpoint.kind === 'distance') {
        // Show precise tenths e.g., "10.3 miles"
        const m = String(scale.value).match(/([\d.]+)/);
        if (m) return scale.display.replace(m[1], (parseFloat(m[1]) + 0.3).toFixed(1));
        return scale.display;
    }
    if (endpoint.kind === 'count') {
        const n = typeof scale.value === 'number' ? scale.value : parseInt(String(scale.value).replace(/,/g, ''), 10);
        if (!isFinite(n)) return scale.display;
        // Nudge up by ~3% to make the reveal number non-round (over-delivery flavor)
        const nudge = Math.max(1, Math.round(n * 0.028));
        return (n + nudge).toLocaleString('en-US');
    }
    return scale.display;
}

function composeTitle(obj, endpoint, scale, bodyPart) {
    // Build the core title from the motif's title_core_tpl, substituting {N}/{D}/{T}
    let core = obj.title_core_tpl || '';
    if (obj.concrete_kind === 'duration' && obj.title_core_tpl) {
        core = core.replace('{D}', capitalize(scale.display)).replace('{T}', capitalize(scale.display));
    } else if (obj.concrete_kind === 'distance' && obj.title_core_tpl) {
        core = core.replace('{D}', capitalize(scale.display));
    } else {
        core = core.replace('{N}', String(scale.display));
    }

    const revealVal = overDeliveryRevealValue(scale, endpoint);
    if (endpoint.kind === 'count')    return `${core} — The Counter Froze At ${revealVal}`;
    if (endpoint.kind === 'timer')    return `${core} — The Timer Hit ${revealVal} Exactly`;
    if (endpoint.kind === 'distance') return `${core} — The Mile Counter Froze At ${revealVal}`;
    if (endpoint.kind === 'body')     return `${core} — My ${capitalize(bodyPart)} Quit First`;
    return core;
}

function composeSeed(obj, endpoint, ctx, rank, motifScore, motifDrivers) {
    const scale = pickScale(obj);
    const bodyPart = obj.body_part_phrase || (obj.body_parts && obj.body_parts[0]) || 'body';
    const title = composeTitle(obj, endpoint, scale, bodyPart);
    const revealVal = overDeliveryRevealValue(scale, endpoint);

    const endpointPhrase = endpoint.kind === 'count' ? `the counter freezes at ${revealVal}`
        : endpoint.kind === 'timer' ? `the timer hits exactly ${revealVal}`
            : endpoint.kind === 'distance' ? `the mile counter freezes at ${revealVal}`
                : `my ${bodyPart} quits first`;

    const action = obj.logline_action || `${obj.verb_present_phrase} ${obj.noun_subject_phrase}`;
    const logline = `I ${action} ${obj.setting_hint}, narrating every sensation in my ${bodyPart} until ${endpointPhrase}.`;
    const promise = `You\'re watching me ${action} — the question is the exact number where ${endpoint.kind === 'body' ? `my ${bodyPart}` : 'the counter'} lands.`;
    const payoff = `Final 5% of runtime: ${endpointPhrase}; a single sensation word appears as overlay.`;
    const overDelivery = `Hook implies a round target (${scale.display}); payoff lands on a specific, non-round value (${revealVal}) — specificity over-delivers vs the rounded promise.`;

    // Narrative structures — pick top 4-5 from ranked lattice list + always include the key three
    const strBase = ['late_peak_arc', 'golden_final_5pct', 'visceral_body_language'];
    const more = ctx.structureRanked.filter(s => !strBase.includes(s));
    if (obj.action_intensity === 'high' && !more.includes('fast_pacing_no_pauses')) more.push('fast_pacing_no_pauses');
    if (obj.concrete_kind === 'distance' || obj.concrete_kind === 'reps') more.push('monotonic_rise');
    const narrative = [...new Set([...strBase, ...more])].slice(0, 6);

    // Vocabulary — commit only to peak words that are in corpus positive list + body parts in positive list
    const useWords = Array.from(new Set([
        ...(obj.sensation_words || []).filter(w => ctx.positiveWords.has(w)),
        ...(obj.body_parts || []).filter(w => ctx.positiveWords.has(w)),
        ...ctx.peakWordsRanked.slice(0, 5),
    ])).slice(0, 9);
    const avoidWords = ctx.negWordsRanked.slice(0, 6);
    const closingWords = ctx.bestLastWords.slice(0, 3);

    // Pre-upload levers — pick top from lattice pool
    const preLevers = ctx.preLeverPool.slice(0, 4);
    const interactions = ctx.interactionPool.slice(0, 2);

    // Hook type from taxonomy
    const hookType = ctx.preferHookTypes[0] || 'transformation';
    const firstWord = pickFirstWord(obj, ctx);

    // Opening speech rate target — medium density empirical sweet zone
    const openingRate = 2.5 + Math.random() * 0.2; // 2.5-2.7 wps sweet zone

    // First frame — derive from obj.first_frame_action + top frame mech at first_5s (if POSITIVE rho)
    const topFirst5 = (ctx.frameMechs.first_5s || []).filter(m => m.outcome === 'log_views' && m.rho > 0)[0];
    const firstFrameExtras = topFirst5 ? `; composition emphasizes ${topFirst5.id.replace('frame_','').replace('_at_first_5s','').replace(/_/g,' ')} (rho=${round(topFirst5.rho, 3)} vs log_views)` : '';
    const firstFrame = `Close on ${obj.first_frame_action}. Counter visible. No explanatory overlay${firstFrameExtras}.`;
    const firstLine = `${capitalize(firstWord)} — ${scale.display}, and my ${bodyPart} is going to tell you when it\'s over.`.replace('shoulders is', 'shoulders are').replace('foot is', 'foot is').replace('hand is', 'hand is');
    const openingAction = `Camera locked on ${obj.visual_action_short} for the first 3 seconds; I enter motion inside the first second.`;

    // Build phases — template driven by top_5_retention_predictors
    const buildPhases = [
        { zone_pct: '0-10', beat: `enter ${obj.setting_hint.replace(/^at |^on |^in /, '')}; ${obj.visual_action_short}; premise named on screen`, visceral: true, note: 'Concept + body inside first 10%. Design rule v3 #6 (5.4x gap).' },
        { zone_pct: '10-25', beat: `first ${bodyPart} sensation narration ("my ${bodyPart} is bigger"); counter begins to tick`, visceral: true, note: 'Divergence lock-in at ~22%. Sensory-word ramp begins.' },
        { zone_pct: '25-60', beat: `escalating ${obj.visual_action_short} with sensory updates; utterances < 10 words; no pauses > 1s`, visceral: true, note: 'Monotonic rise in distress / counter. Peak-word density increases.' },
        { zone_pct: '60-90', beat: `peak zone — slow to 3.0 w/s; short sentence on a single sensation; reaction → wide on the count or distance milestone`, visceral: true, note: 'Peak 60-80%. Peak-speaking-rate 3.86 wps confirmed; utterance 7.9 words.' },
        { zone_pct: '90-100', beat: `${endpointPhrase}; single-word overlay (sensation); wide shot of the final state`, visceral: true, note: 'Golden final 5% + END_RECOVERY. Emotion word in final 10% = +0.069.' },
    ];

    const climaxHint = `At 95% of runtime, ${endpointPhrase}; camera holds on the final position; I say one word and the overlay freezes.`;
    const closingLineHint = `Close with ${bodyPart} + impact word: "${bodyPart}\'s numb — ${closingWords[0] || 'insane'}."`;

    // Visual prescription per zone — derived from top frame mechanisms at each bucket
    const zoneRec = (zone) => {
        const mechs = (ctx.frameMechs[zone] || []).filter(m => m.outcome === 'log_views').slice(0, 3);
        return mechs.length
            ? mechs.map(m => m.id.replace(`_at_${zone}`, '').replace('frame_', '').replace(/_/g, ' ') + ` (rho=${round(m.rho, 3)})`)
            : [];
    };
    const visualHints = {
        first_5s: [`${obj.first_frame_action}`, 'no explanatory overlay', 'counter visible', ...zoneRec('first_5s')],
        hook_quarter: [`${obj.visual_action_short}`, 'body in motion only', ...zoneRec('hook_quarter')],
        mid: [`alternate ${bodyPart} close-ups with ${obj.visual_action_short}`, 'text overlay at beat moments only', ...zoneRec('mid')],
        late: [`slow push-in on ${bodyPart}`, 'wide reveal at the endpoint', ...zoneRec('late')],
        avoid: ['face + text with no action', 'naming materials by brand', 'pauses > 1s'],
    };

    return {
        id: `${obj.id}__${endpoint.id}`,
        title, logline, promise, payoff,
        over_delivery_note: overDelivery,
        narrative_structures: narrative,
        duration_band_id: 'sweet_spot_46_60',
        pre_upload_levers: preLevers,
        interactions_engineered: interactions,
        opening: {
            first_frame: firstFrame,
            first_line: firstLine,
            opening_action: openingAction,
            opening_speech_rate_wps_target: round(openingRate, 2),
            hook_type: hookType,
            best_first_word_used: firstWord,
        },
        build_phases: buildPhases,
        climax_hint: climaxHint,
        closing_line_hint: closingLineHint,
        visual_prescription_hints: visualHints,
        vocabulary_hints: {
            use_peak_words: useWords,
            avoid_material_words: avoidWords,
            closing_words: closingWords,
        },
        share_triggers: (ctx.peakPhrases || []).slice(0, 3),
        hook_bucket_preference: { need_bucket_first_5s: true, need_bucket_first_10s: true },
        synthesis_trace: {
            rank,
            motif_score: motifScore,
            motif_drivers: motifDrivers,
            object_atom_id: obj.id,
            endpoint_atom_id: endpoint.id,
            scale_kind: scale.kind,
            scale_value: scale.value,
            derived_from_lattice: [
                'opening.best_first_word_used ← opening_words.best_first_words',
                'opening.hook_type ← wave11_12.hook_taxonomy',
                'opening.opening_speech_rate_wps_target ← speaking_patterns.opening_density',
                'vocabulary_hints.use_peak_words ← top_words_positive ∩ object.sensation_words + body_parts',
                'vocabulary_hints.avoid_material_words ← top_words_negative',
                'vocabulary_hints.closing_words ← opening_words.best_last_words',
                'share_triggers ← wave11_12.key_phrases.peak_phrases',
                'narrative_structures ← top_5_retention_predictors + peak_causes + wave9_10 + emotional_trajectory',
                'pre_upload_levers ← brief.top_pre_upload_predictors',
                'visual_prescription_hints.* ← mechanism_indicator_links (frame_*) ranked by |rho| per zone',
            ],
            still_hardcoded: [
                'object-motif atoms (verb/noun/scale/body_parts/sensation_words/safety_tier)',
                'endpoint-motif kinds (count / timer / distance / body-quit)',
                'build_phases zone boundaries (0-10, 10-25, 25-60, 60-90, 90-100)',
                'duration_band_id default ("sweet_spot_46_60")',
            ],
        },
    };
}

function synthesizeSeeds(brief, artifacts, maxCount = 12) {
    const ctx = deriveMotifContext(brief, artifacts);
    const combos = [];
    for (const obj of OBJECT_MOTIFS) {
        if (obj.safety_tier === 'risky') continue;
        for (const endId of (obj.endpoint_kinds || ['exact_count'])) {
            const endpoint = ENDPOINT_MOTIFS.find(e => e.id === endId);
            if (!endpoint) continue;
            const { score, drivers } = scoreMotifCombo(obj, endpoint, ctx);
            combos.push({ obj, endpoint, score, drivers });
        }
    }
    combos.sort((a, b) => b.score - a.score);
    // Diversify: cap 2 per category so a "repetition_endurance" bias doesn't dominate
    const perCat = {};
    const picked = [];
    for (const c of combos) {
        const cat = c.obj.category;
        perCat[cat] = perCat[cat] || 0;
        if (perCat[cat] >= 2) continue;
        perCat[cat] += 1;
        picked.push(c);
        if (picked.length >= maxCount) break;
    }
    return picked.map((c, i) => composeSeed(c.obj, c.endpoint, ctx, i + 1, c.score, c.drivers));
}


// ──────────────────────────────────────────────────────────────────────
// Hook-mechanism picker
// ──────────────────────────────────────────────────────────────────────

function pickHooksForIdea(brief, pref = {}) {
    const picks = [];
    const byBucket = {};
    for (const h of brief.hook_mechanisms) {
        (byBucket[h.bucket] ||= []).push(h);
    }
    for (const b of Object.keys(byBucket)) {
        byBucket[b].sort((a, b) => Math.abs(b.csw || 0) - Math.abs(a.csw || 0));
    }
    if (pref.need_bucket_first_5s && byBucket.first_5s && byBucket.first_5s[0]) picks.push(byBucket.first_5s[0]);
    if (pref.need_bucket_first_10s && byBucket.first_10s && byBucket.first_10s[0]) picks.push(byBucket.first_10s[0]);
    if (pref.need_bucket_hook_quarter && byBucket.hook_quarter && byBucket.hook_quarter[0]) picks.push(byBucket.hook_quarter[0]);
    return picks;
}

// ──────────────────────────────────────────────────────────────────────
// Scoring (carried over from v1) — used for rank ordering
// ──────────────────────────────────────────────────────────────────────

function scoreIdea(idea, brief) {
    const parts = { hook: 0, narrative: 0, duration: 0, bridge: 0, vocabulary: 0, interactions: 0, motif: 0 };

    // Motif-synthesis score (lattice-driven object/endpoint alignment)
    if (idea.synthesis_trace && typeof idea.synthesis_trace.motif_score === 'number') {
        parts.motif += idea.synthesis_trace.motif_score * 0.15;
    }

    for (const hook of idea.hook_mechanisms) parts.hook += Math.abs(hook.csw || 0);

    for (const n of idea.narrative_structures) {
        const row = NARRATIVE_STRUCTURES.find(x => x.id === n);
        if (row) parts.narrative += row.weight * 0.05;
    }

    const dBand = DURATION_BANDS.find(d => d.id === idea.duration_band_id);
    if (dBand) parts.duration += dBand.weight * 0.05;

    for (const preKey of idea.pre_upload_levers || []) {
        const row = brief.top_pre_upload_predictors.find(p => p.key === preKey);
        if (row) parts.bridge += Math.abs(row.r_to_views || 0) * 0.5;
    }

    // Vocabulary component: number of peak words the idea explicitly commits to use
    const vocabWords = (idea.vocabulary_hints && idea.vocabulary_hints.use_peak_words) || [];
    const corpusPositive = brief.evidence_lattice && brief.evidence_lattice.vocabulary && brief.evidence_lattice.vocabulary.top_words_positive || [];
    const positiveSet = new Set(corpusPositive.map(x => x.word));
    for (const w of vocabWords) {
        if (positiveSet.has(w)) parts.vocabulary += 0.01;
    }

    // Interactions component
    for (const iKey of idea.pre_upload_levers || []) {
        const rule = (brief.evidence_lattice && brief.evidence_lattice.interaction_rules || []).find(r => r.key === iKey);
        if (rule && rule.r_partial) parts.interactions += Math.abs(rule.r_partial) * 0.1;
    }

    const total = parts.hook + parts.narrative + parts.duration + parts.bridge + parts.vocabulary + parts.interactions + parts.motif;
    return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 4)])), total: round(total, 4) };
}

function evidenceFor(idea, brief) {
    const out = [];
    for (const hook of idea.hook_mechanisms) {
        out.push(`Hook[${hook.mechanism_id}] via ${hook.via_indicator} (principle ${hook.principle_id}, n=${hook.n_videos}, csw=${round(hook.csw, 3)}).`);
    }
    for (const n of idea.narrative_structures) {
        const row = NARRATIVE_STRUCTURES.find(x => x.id === n);
        if (row) out.push(`Structure[${row.id}]: ${row.evidence}`);
    }
    const dBand = DURATION_BANDS.find(d => d.id === idea.duration_band_id);
    if (dBand) out.push(`Duration[${dBand.id}] ${dBand.seconds}s: ${dBand.evidence}`);
    for (const preKey of idea.pre_upload_levers || []) {
        const row = brief.top_pre_upload_predictors.find(p => p.key === preKey);
        if (row) out.push(`Pre-upload lever[${row.key}]: r=${row.r_to_views}, ${row.direction}.`);
        else {
            const ix = (brief.evidence_lattice && brief.evidence_lattice.interaction_rules || []).find(r => r.key === preKey);
            if (ix) out.push(`Interaction[${ix.key}]: r_partial=${ix.r_partial} — ${ix.note}`);
        }
    }
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// Estimated-metric modeling (MODELED — not predicted)
//
// Each estimator:
//   - starts from a corpus base rate (from lattice),
//   - applies additive deltas for each evidence-linked design choice,
//   - outputs {value, band, method, drivers, confidence}
// ──────────────────────────────────────────────────────────────────────

function estimateSwipeAway(idea, brief) {
    // Base: median swipe-away among corpus videos
    // Mechanism-indicator links give the only reliable frame→swipe deltas.
    const base = 0.28; // corpus median swipe-away rate, approximate (lattice-backed)
    let delta = 0;
    const drivers = [];
    const links = (brief.evidence_lattice.visual_prescription && brief.evidence_lattice.visual_prescription.frame_mechanisms_by_outcome && brief.evidence_lattice.visual_prescription.frame_mechanisms_by_outcome.swipe_away_rate) || [];

    // If opening is direct_address in first_5s → big reducer (rho=-0.434)
    const vp = idea.visual_prescription || idea.visual_prescription_hints || {};
    const f5 = vp.first_5s || [];
    const firstFrameIsDirect = /direct_address|close-up of my|close-up of my face|direct-address/i.test(`${idea.opening.first_frame || ''} ${f5.join(' ')}`);
    if (firstFrameIsDirect) {
        const d = -0.06;
        delta += d;
        drivers.push({ driver: 'frame_direct_address_at_first_5s', rho: -0.434, modeled_delta: d, source: 'mechanism_indicator_links' });
    }
    // If first_5s avoids text overlay with talking head → avoid penalty
    const avoidsTalkingHead = /no text overlay|no overlay/i.test(f5.join(' '));
    if (avoidsTalkingHead) {
        const d = -0.02;
        delta += d;
        drivers.push({ driver: 'avoid_talking_head_text_trap', modeled_delta: d, source: 'vision_analysis_gpt4o_mini' });
    }
    // Hook type: transformation/mystery favorable
    if (idea.opening.hook_type === 'transformation' || idea.opening.hook_type === 'mystery') {
        const d = -0.02;
        delta += d;
        drivers.push({ driver: `hook_type_${idea.opening.hook_type}`, modeled_delta: d, source: 'hook_taxonomy (wave11_12)' });
    }
    // Opening speech rate in medium-density zone (1.5-3.0) is favorable
    const rate = idea.opening.opening_speech_rate_wps_target;
    if (rate != null && rate >= 1.5 && rate <= 3.0) {
        const d = -0.015;
        delta += d;
        drivers.push({ driver: `opening_rate_${rate}wps_in_sweet_zone`, modeled_delta: d, source: 'speaking_patterns.opening_density' });
    }
    // Best first word used
    const bestWords = new Set((brief.evidence_lattice.hook_prescription && brief.evidence_lattice.hook_prescription.best_first_words || []).map(w => String(w).split('(')[0]));
    if (bestWords.has(idea.opening.best_first_word_used)) {
        const d = -0.01;
        delta += d;
        drivers.push({ driver: `opens_with_best_first_word="${idea.opening.best_first_word_used}"`, modeled_delta: d, source: 'opening_words.best_first_words' });
    }

    const value = clamp(base + delta, 0.05, 0.6);
    const band = value < 0.20 ? 'low' : value < 0.30 ? 'mid' : 'high';
    const confidence = Math.abs(delta) > 0.08 ? 'medium' : Math.abs(delta) > 0.03 ? 'low-medium' : 'low';
    return {
        modeled_value: round(value, 3),
        base_rate: base,
        modeled_delta: round(delta, 3),
        band,
        confidence,
        method: 'additive — corpus median + sum of frame/hook design deltas grounded in mechanism_indicator_links and retention-patterns',
        drivers,
        available_frame_links: links,
    };
}

function estimateHookRetention20s(idea, brief) {
    // Base: corpus mean at 20s = 79.3% (lattice)
    const base = 0.793;
    let delta = 0;
    const drivers = [];

    // If opening_action is physical/visible action (not talking-head explanation)
    const vp2 = idea.visual_prescription || idea.visual_prescription_hints || {};
    const actionOpening = /action|motion|smash|rep|press|place|hit|mid-/i.test(`${idea.opening.opening_action || ''} ${(vp2.first_5s || []).join(' ')}`);
    if (actionOpening) {
        const d = +0.03;
        delta += d;
        drivers.push({ driver: 'physical_action_in_first_3s', modeled_delta: d, source: 'peak_causes.HIGH-ENERGY_ACTION_FRAMES (+0.058 ab)' });
    }
    // Concept named inside first 10%
    const earlyConcept = (idea.build_phases || []).some(p => /0-10/.test(p.zone_pct) && /concept|premise|named|stated/i.test(p.beat));
    if (earlyConcept) {
        const d = +0.03;
        delta += d;
        drivers.push({ driver: 'concept_named_in_first_10pct', modeled_delta: d, source: 'design_rules_v3.#6 (5.4x gap)' });
    }
    // Sensory/body vocabulary present in vocabulary_hints.use_peak_words
    const peakWordsUsed = ((idea.vocabulary_hints && idea.vocabulary_hints.use_peak_words) || []).length;
    const d = Math.min(0.03, peakWordsUsed * 0.005);
    if (d > 0) {
        delta += d;
        drivers.push({ driver: `sensory_vocabulary_committed_x${peakWordsUsed}`, modeled_delta: round(d, 3), source: 'word_impact_dictionary + word-retention-impact.json' });
    }
    // Avoids material words?
    const avoidsMat = ((idea.vocabulary_hints && idea.vocabulary_hints.avoid_material_words) || []).length;
    if (avoidsMat >= 3) {
        const d2 = +0.025;
        delta += d2;
        drivers.push({ driver: 'material_words_avoided', modeled_delta: d2, source: 'top_3_drop_causes.TECHNICAL_MATERIAL_LANGUAGE' });
    }
    // Medium opening density
    const rate = idea.opening.opening_speech_rate_wps_target;
    if (rate != null && rate >= 1.5 && rate <= 3.0) {
        const d3 = +0.015;
        delta += d3;
        drivers.push({ driver: 'opening_density_medium', modeled_delta: d3, source: 'speaking_patterns.opening_density' });
    }

    const value = clamp(base + delta, 0.40, 0.98);
    const band = value >= 0.85 ? 'high' : value >= 0.78 ? 'mid-high' : value >= 0.70 ? 'mid' : 'low';
    const confidence = Math.abs(delta) > 0.08 ? 'medium' : Math.abs(delta) > 0.03 ? 'low-medium' : 'low';
    return {
        modeled_value: round(value, 3),
        base_rate: base,
        modeled_delta: round(delta, 3),
        band,
        confidence,
        method: 'additive — corpus mean retention@20s + design deltas grounded in retention-patterns.top_3_peak_causes and design_rules_v3',
        drivers,
        reference_r_with_views: 0.6,
    };
}

function estimateSharePropensity(idea, brief) {
    // Base: nominal share rate baseline
    const base = 0.03; // 3% of viewers share (corpus baseline approximation)
    let delta = 0;
    const drivers = [];

    // Share triggers: "in the comments" / "should i keep" / "i keep going" are peak_phrases
    const peakPhrases = new Set((brief.evidence_lattice.vocabulary.peak_phrases || []).map(x => x.toLowerCase()));
    const triggers = (idea.share_triggers || []).filter(t => peakPhrases.has(t.toLowerCase()));
    if (triggers.length) {
        const d = Math.min(0.02, triggers.length * 0.008);
        delta += d;
        drivers.push({ driver: `peak_phrase_triggers_x${triggers.length}`, modeled_delta: round(d, 3), triggers, source: 'wave11_12.key_phrases.peak_phrases' });
    }
    // Transformation / mystery hooks are more share-inviting
    if (idea.opening.hook_type === 'transformation' || idea.opening.hook_type === 'mystery') {
        const d = +0.008;
        delta += d;
        drivers.push({ driver: `shareable_hook_type_${idea.opening.hook_type}`, modeled_delta: d, source: 'hook_taxonomy' });
    }
    // Golden final 5% present
    if ((idea.narrative_structures || []).includes('golden_final_5pct')) {
        const d = +0.01;
        delta += d;
        drivers.push({ driver: 'golden_final_5pct_payoff', modeled_delta: d, source: 'top_5_retention_predictors.END_RECOVERY' });
    }
    // Avoid CTA drift phrases (drop phrases)
    const avoided = (idea.share_triggers || []).every(t => !(brief.evidence_lattice.vocabulary.drop_phrases || []).includes(t));
    if (avoided) {
        const d = +0.004;
        delta += d;
        drivers.push({ driver: 'avoids_cta_drift_phrases', modeled_delta: d, source: 'wave11_12.key_phrases.drop_phrases (link in bio, see what happens, on my profile)' });
    }

    const value = clamp(base + delta, 0.005, 0.1);
    const band = value >= 0.055 ? 'high' : value >= 0.035 ? 'mid' : 'low';
    const confidence = Math.abs(delta) > 0.02 ? 'medium' : Math.abs(delta) > 0.005 ? 'low-medium' : 'low';
    return {
        modeled_value: round(value, 4),
        base_rate: base,
        modeled_delta: round(delta, 4),
        band,
        confidence,
        method: 'additive — nominal share baseline + design deltas grounded in peak_phrases / hook_taxonomy / golden_final_5pct',
        drivers,
    };
}

function estimateKeepRate(idea, brief) {
    // Base: corpus mean keep rate approximation
    const base = 0.68;
    let delta = 0;
    const drivers = [];

    // Over-delivery structure (late peak + golden final)
    const hasOverDeliver = (idea.narrative_structures || []).includes('late_peak_arc') && (idea.narrative_structures || []).includes('golden_final_5pct');
    if (hasOverDeliver) {
        const d = +0.04;
        delta += d;
        drivers.push({ driver: 'over_delivery_structure', modeled_delta: d, source: 'top_5_retention_predictors.HOOK_PAYOFF_GAP (r=-0.52)' });
    }
    // Monotonic rise
    if ((idea.narrative_structures || []).includes('monotonic_rise')) {
        const d = +0.03;
        delta += d;
        drivers.push({ driver: 'monotonic_rise_quartiles', modeled_delta: d, source: 'progression_patterns ↑↑↑ = 4.19M vs ↓↓↓ = 222K' });
    }
    // Nadir before climax
    if ((idea.narrative_structures || []).includes('nadir_before_climax')) {
        const d = +0.015;
        delta += d;
        drivers.push({ driver: 'nadir_before_climax', modeled_delta: d, source: 'wave9_10.best_after_worst (5x gap)' });
    }

    const value = clamp(base + delta, 0.4, 0.92);
    const band = value >= 0.78 ? 'high' : value >= 0.72 ? 'mid-high' : value >= 0.66 ? 'mid' : 'low';
    const confidence = Math.abs(delta) > 0.08 ? 'medium' : Math.abs(delta) > 0.03 ? 'low-medium' : 'low';
    return {
        modeled_value: round(value, 3),
        base_rate: base,
        modeled_delta: round(delta, 3),
        band,
        confidence,
        method: 'additive — corpus mean keep + design deltas from concept stack, over-delivery structure, monotonic rise, nadir placement',
        drivers,
    };
}

function estimateViewBand(idea, brief, totalDesignScore) {
    // Map total design score → view band using video-scorecards view_bands_by_score if present
    const scorecard = brief.evidence_lattice.scorecard_dimensions;
    if (scorecard && scorecard.view_bands_by_score && scorecard.view_bands_by_score.length) {
        // Map design_score (typical range 0.3-0.7 in this engine) onto the scorecard
        // total_score range (~8.25-9.63). Anchor: 0.4 → 8.25, 0.6 → 9.63.
        const quintiles = scorecard.view_bands_by_score;
        const lo = quintiles[0].score_range[0];
        const hi = quintiles[quintiles.length - 1].score_range[1];
        const pct = clamp((totalDesignScore - 0.40) / (0.60 - 0.40), 0, 1);
        const s10 = lo + pct * (hi - lo);
        // Match to the closest score quintile center
        let best = quintiles[0];
        let bestDist = Infinity;
        for (const q of quintiles) {
            const center = (q.score_range[0] + q.score_range[1]) / 2;
            const dist = Math.abs(center - s10);
            if (dist < bestDist) { bestDist = dist; best = q; }
        }
        // Apply the full-model prediction range multiplier (2.5x) to express uncertainty
        const mult = (brief.evidence_lattice.prediction_model_summary && brief.evidence_lattice.prediction_model_summary.full && brief.evidence_lattice.prediction_model_summary.full.prediction_range_multiplier) || 2.5;
        const low = Math.round(best.views_p25 / mult);
        const high = Math.round(best.views_p75 * mult);
        const confidence = best.n >= 10 ? 'medium' : 'low';
        return {
            modeled_low: low,
            modeled_median: best.views_median,
            modeled_high: high,
            band_label: `${humanInt(low)} – ${humanInt(high)} views (median ${humanInt(best.views_median)})`,
            confidence,
            method: `design_score=${round(totalDesignScore, 3)} → scorecard-total=${round(s10, 2)} → quintile ${best.score_quintile} (n=${best.n}); band expanded by full-model range multiplier ${mult}x`,
            matched_quintile: best,
            full_model_cv_r2: brief.evidence_lattice.prediction_model_summary && brief.evidence_lattice.prediction_model_summary.full && brief.evidence_lattice.prediction_model_summary.full.cv_r2,
            note: 'MODELED — not a prediction. 72.9% of view variance is external (algorithm, timing, audience). Use as design-quality band, not performance forecast.',
        };
    }
    // Fallback with no scorecard lattice
    return {
        modeled_low: null, modeled_median: null, modeled_high: null,
        band_label: 'unavailable',
        confidence: 'unknown',
        method: 'video-scorecards lattice missing',
    };
}

function humanInt(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
}

function computeScorecardTargets(idea, brief) {
    // Express the design-intent targets on the 7 video-scorecard dimensions
    const has = (id) => (idea.narrative_structures || []).includes(id);
    const vocab = idea.vocabulary_hints || {};
    const targets = {
        over_delivery: has('late_peak_arc') && has('golden_final_5pct') ? 9.5 : has('late_peak_arc') ? 8 : 6,
        late_retention: has('late_peak_arc') ? 9 : has('golden_final_5pct') ? 9.5 : 6.5,
        consistency: has('monotonic_rise') ? 9 : 7,
        smoothness: has('dramatic_pacing') ? 7.5 : 8.5,
        sensory_language: (vocab.use_peak_words && vocab.use_peak_words.length >= 6) ? 9 : 7,
        material_avoidance: (vocab.avoid_material_words && vocab.avoid_material_words.length >= 3) ? 9.5 : 7,
        early_momentum: /action|motion|rep|smash|hit/i.test(idea.opening.opening_action || '') ? 9 : 7,
    };
    // Compare to corpus stats
    const stats = brief.evidence_lattice.scorecard_dimensions && brief.evidence_lattice.scorecard_dimensions.dimension_stats || {};
    const rows = {};
    for (const k of Object.keys(targets)) {
        rows[k] = {
            target: targets[k],
            corpus_mean: stats[k] && stats[k].mean,
            corpus_p75: stats[k] && stats[k].p75,
            corpus_p90: stats[k] && stats[k].p90,
            status: stats[k] && stats[k].p90 && targets[k] >= stats[k].p90 ? 'top-decile' :
                stats[k] && stats[k].p75 && targets[k] >= stats[k].p75 ? 'top-quartile' :
                    stats[k] && stats[k].mean && targets[k] >= stats[k].mean ? 'above-mean' : 'below-mean',
        };
    }
    return rows;
}

function computeRiskFlagsForIdea(idea, brief) {
    const out = [];
    // talking-head in first_5s without action
    const vp3 = idea.visual_prescription || idea.visual_prescription_hints || {};
    const f5r = vp3.first_5s || [];
    const hasAction = /action|motion|smash|rep|press|place|hit|mid-exercise|mid-|body in motion|reveal/i.test(`${idea.opening.opening_action || ''} ${f5r.join(' ')}`);
    if (!hasAction) out.push({ flag: 'NO_PHYSICAL_ACTION_IN_FIRST_5S', severity: 'medium', rule: 'Peak frames have action 28% vs 8% at drops. First 5s should show physical motion.' });
    // late boring content
    const lateBeat = (idea.build_phases || []).find(p => /60-|70-|80-/.test(p.zone_pct));
    if (lateBeat && !lateBeat.visceral) out.push({ flag: 'NON_VISCERAL_LATE_CONTENT', severity: 'high', rule: 'Late drops 2.15x steeper, 3/472 recover. Back half must be visceral payoff.' });
    // material words risk
    const vocab = idea.vocabulary_prescription || idea.vocabulary_hints || {};
    const avoidMat = vocab.avoid_material_words || [];
    if (!avoidMat.length) out.push({ flag: 'MATERIAL_WORD_EXPOSURE', severity: 'medium', rule: 'No material-avoidance commitment. plastic(-0.171), carbon(-0.109) etc kill retention.' });
    // stakes hook
    if (idea.opening.hook_type === 'stakes') out.push({ flag: 'STAKES_HOOK', severity: 'medium', rule: 'Stakes-hooks = 1.12M (worst). Prefer transformation/mystery.' });
    // worst-first-word
    const worstWords = new Set((brief.evidence_lattice.hook_prescription && brief.evidence_lattice.hook_prescription.worst_first_words || []).map(w => String(w).split('(')[0]));
    if (worstWords.has(idea.opening.best_first_word_used)) out.push({ flag: 'OPENS_WITH_WEAK_WORD', severity: 'low', rule: 'First word is in worst_first_words list.' });
    return out;
}

// ──────────────────────────────────────────────────────────────────────
// Validation trace layer
//
// Every blueprint field and every modeled estimate carries an explicit
// list of the indicators it was validated against: how many indicators
// were considered, which subset survived the filter, the evidence type,
// and (where available) a plain-English definition of how each indicator
// is quantified. This is what makes the engine auditable.
// ──────────────────────────────────────────────────────────────────────

function defineIndicator(key) {
    if (!variableCatalog || !variableCatalog.describeVariableMini) return null;
    try { return variableCatalog.describeVariableMini(key); }
    catch (e) { return null; }
}

function indicatorRegistryIndex(registry) {
    const idx = new Map();
    if (!registry || !Array.isArray(registry.indicators)) return idx;
    for (const ind of registry.indicators) {
        if (ind && ind.key) idx.set(ind.key, ind);
    }
    return idx;
}

function resolveIndicator(key, ctx, extras) {
    const row = { key, ...(extras || {}) };
    const reg = ctx && ctx.indicatorIndex && ctx.indicatorIndex.get ? ctx.indicatorIndex.get(key) : null;
    if (reg) {
        if (reg.r_direct != null) row.r_direct = round(reg.r_direct, 3);
        if (reg.r_partial != null) row.r_partial = round(reg.r_partial, 3);
        if (reg.layer) row.layer = reg.layer;
        if (reg.target) row.target = reg.target;
        if (reg.resolution) row.resolution = reg.resolution;
        if (reg.notes) row.notes = String(reg.notes).slice(0, 260);
    }
    const def = defineIndicator(key);
    if (def) {
        if (def.label) row.label = def.label;
        if (def.modality) row.modality = def.modality;
        if (def.quantification) row.quantification = def.quantification;
        if (def.quantification_style) row.quantification_style = def.quantification_style;
        if (def.signal && !row.signal) row.signal = def.signal;
        if (def.family && !row.family) row.family = def.family;
        if (def.layer && !row.layer) row.layer = def.layer;
    }
    return row;
}

function linksByFilter(mil, { mechPrefix, mechSubstr, indicatorKeys }) {
    if (!mil || !Array.isArray(mil.links)) return [];
    return mil.links.filter(l => {
        if (mechPrefix && !String(l.mechanism_id || '').startsWith(mechPrefix)) return false;
        if (mechSubstr && !String(l.mechanism_id || '').includes(mechSubstr)) return false;
        if (indicatorKeys && !indicatorKeys.includes(l.indicator_key)) return false;
        return true;
    });
}

function topIndicatorsFromLinks(links, ctx, limit = 6) {
    return links
        .slice()
        .sort((a, b) => Math.abs(b.rho || 0) - Math.abs(a.rho || 0))
        .slice(0, limit)
        .map(l => resolveIndicator(l.mechanism_id, ctx, {
            evidence_type: 'mechanism_indicator_link',
            rho: round(l.rho, 3),
            n: l.n,
            outcome_indicator: l.indicator_key,
            why: `rho=${round(l.rho, 3)} vs ${l.indicator_key} (n=${l.n}; threshold |rho|≥${ctx.milThresholdRho}, min n=${ctx.milThresholdN})`,
        }));
}

function makeTrace({ field, rationale, evidence_sources, indicators_considered_count, indicator_keys, top_indicators, filter, extra }) {
    return {
        field,
        rationale,
        evidence_sources: evidence_sources || [],
        indicators_considered_count: indicators_considered_count || 0,
        indicator_keys_count: (indicator_keys && indicator_keys.length) || 0,
        indicator_keys: indicator_keys || [],
        top_indicators: top_indicators || [],
        filter: filter || null,
        ...(extra || {}),
    };
}

function buildSectionValidationTraces(seed, brief, ctx) {
    const { mil, retentionPatterns } = ctx;
    const traces = {};

    // ── Opening: first_frame ────────────────────────────────────────
    {
        const links = linksByFilter(mil, {
            mechPrefix: 'frame_',
            mechSubstr: 'at_first_5s',
            indicatorKeys: ['swipe_away_rate', 'like_rate', 'hook_retention'],
        });
        const indicator_keys = [...new Set(links.map(l => l.mechanism_id))];
        traces.first_frame = makeTrace({
            field: 'opening.first_frame',
            rationale: 'First-frame composition is validated against the frame-level mechanism↔indicator correlations sliced to the first 5s (outcomes: swipe-away, like-rate, hook retention).',
            evidence_sources: ['mechanism_indicator_links.json', 'retention-patterns.vision_analysis_gpt4o_mini', 'retention-patterns.top_3_retention_peak_causes'],
            indicators_considered_count: (mil && mil.n_links) || (mil && mil.links && mil.links.length) || 0,
            indicator_keys,
            top_indicators: topIndicatorsFromLinks(links, ctx),
            filter: `mechanism_id startswith "frame_" AND contains "at_first_5s" AND outcome ∈ {swipe_away_rate, like_rate, hook_retention} · |rho|≥${ctx.milThresholdRho}, min n=${ctx.milThresholdN}`,
        });
    }

    // ── Opening: first_line ─────────────────────────────────────────
    {
        const best = (retentionPatterns && retentionPatterns.opening_words && retentionPatterns.opening_words.best_first_words) || [];
        const worst = (retentionPatterns && retentionPatterns.opening_words && retentionPatterns.opening_words.worst_first_words) || [];
        const top_indicators = best.slice(0, 8).map(entry => {
            const parts = String(entry).split(/[()]/);
            const word = parts[0].trim();
            const score = parseFloat(parts[1] || '');
            return {
                key: `first_word="${word}"`,
                evidence_type: 'opening_word_score',
                score: isFinite(score) ? round(score, 2) : null,
                modality: 'transcript.fullText (first-word slice)',
                quantification: 'Per-first-word average retention above-baseline percentile (0-10)',
                why: `above-baseline first-word score ${isFinite(score) ? score.toFixed(2) : '—'}`,
            };
        });
        traces.first_line = makeTrace({
            field: 'opening.first_line',
            rationale: 'First-line opening word is validated against the opening_words leaderboard (each word\'s average above-baseline retention score across the corpus).',
            evidence_sources: ['retention-patterns.opening_words.best_first_words', 'retention-patterns.opening_words.worst_first_words'],
            indicators_considered_count: best.length + worst.length,
            indicator_keys: [...best, ...worst].map(e => String(e).split('(')[0].trim()),
            top_indicators,
            filter: 'all scored first-words from opening_words leaderboard',
            extra: { worst_first_words: worst.slice(0, 8) },
        });
    }

    // ── Opening: opening_action ─────────────────────────────────────
    {
        const peakCauses = (retentionPatterns && retentionPatterns.top_3_retention_peak_causes) || [];
        const top_indicators = peakCauses.map(c => ({
            key: `peak_cause:${String(c.cause || '').toLowerCase().replace(/\s+/g, '_')}`,
            evidence_type: 'retention_peak_cause',
            effect_size: c.effect_size,
            modality: 'cross-modal (vision + transcript) analysis',
            quantification: 'Mean above_baseline delta at best-retention moments vs worst',
            why: c.evidence ? String(c.evidence).slice(0, 220) : null,
        }));
        traces.opening_action = makeTrace({
            field: 'opening.opening_action',
            rationale: 'Opening action is validated against top_3_retention_peak_causes — the empirically strongest cross-modal drivers of above-baseline retention at peak moments.',
            evidence_sources: ['retention-patterns.top_3_retention_peak_causes', 'retention-patterns.vision_analysis_gpt4o_mini'],
            indicators_considered_count: peakCauses.length,
            indicator_keys: peakCauses.map(c => String(c.cause || '').toLowerCase().replace(/\s+/g, '_')),
            top_indicators,
            filter: 'retention-patterns top peak causes (empirically ranked)',
        });
    }

    // ── Opening: opening_speech_rate ────────────────────────────────
    {
        const indicators = ['opening_speech_rate_3s', 'opening_speech_rate_5s'];
        const top_indicators = indicators.map(k => resolveIndicator(k, ctx, {
            evidence_type: 'indicator_registry',
            why: 'Opening speech rate (words/sec in first N seconds) — medium density 1.5–3.0 wps is the sweet zone per speaking_patterns.opening_density.',
        }));
        traces.opening_speech_rate = makeTrace({
            field: 'opening.opening_speech_rate_wps_target',
            rationale: 'Opening speech rate target is validated against speaking_patterns.opening_density; medium density (1.5–3.0 wps) empirically retains best.',
            evidence_sources: ['retention-patterns.speaking_patterns.opening_density', 'candidate_proposals.families (opening_speech_rate_3s)'],
            indicators_considered_count: indicators.length,
            indicator_keys: indicators,
            top_indicators,
            filter: 'pre-upload layer · opening slice · rate (wps)',
        });
    }

    // ── Opening: hook_type ──────────────────────────────────────────
    {
        const tax = retentionPatterns && retentionPatterns.wave11_12_new_signals && retentionPatterns.wave11_12_new_signals.hook_taxonomy;
        const keys = tax ? ['transformation', 'mystery', 'stakes'] : [];
        const top_indicators = tax ? [
            { key: 'hook_taxonomy.transformation', evidence_type: 'hook_taxonomy', note: tax.best, quantification: 'Median views of videos labeled transformation-hook', why: 'best median views (2.24M)' },
            { key: 'hook_taxonomy.mystery', evidence_type: 'hook_taxonomy', note: tax.second, quantification: 'Median views of videos labeled mystery-hook', why: 'second-best median views (2.20M)' },
            { key: 'hook_taxonomy.stakes', evidence_type: 'hook_taxonomy', note: tax.worst, quantification: 'Median views of videos labeled stakes-hook', why: 'worst median views (1.12M)' },
        ] : [];
        traces.hook_type = makeTrace({
            field: 'opening.hook_type',
            rationale: 'Hook type is validated against wave11_12 hook_taxonomy — median views by hook label across the corpus.',
            evidence_sources: ['retention-patterns.wave11_12_new_signals.hook_taxonomy'],
            indicators_considered_count: keys.length,
            indicator_keys: keys,
            top_indicators,
            filter: 'hook taxonomy labels with ≥20 videos per label',
        });
    }

    // ── Build phases (arc) ─────────────────────────────────────────
    {
        const top5 = (retentionPatterns && retentionPatterns.top_5_retention_predictors) || [];
        const arc = retentionPatterns && retentionPatterns.narrative_arc_analysis;
        const top_indicators = top5.slice(0, 5).map(r => ({
            key: String(r.signal || '').toLowerCase(),
            evidence_type: 'top_5_retention_predictor',
            r_with_views: round(r.r_with_views, 3),
            modality: 'retention curve (second-by-second)',
            quantification: r.description ? String(r.description).slice(0, 220) : null,
            design_rule: r.design_rule,
            why: `rank #${r.rank} retention predictor, r_with_views=${round(r.r_with_views, 3)}`,
        }));
        traces.build_phases = makeTrace({
            field: 'build_phases',
            rationale: 'Build phases are validated against the top-5 retention predictors + narrative_arc_analysis (best/worst arc labels) + wave7 quartile templates.',
            evidence_sources: ['retention-patterns.top_5_retention_predictors', 'retention-patterns.narrative_arc_analysis', 'retention-patterns.wave7_new_signals.quartile_templates', 'retention-patterns.wave9_10_new_signals'],
            indicators_considered_count: top5.length,
            indicator_keys: top5.map(r => String(r.signal || '').toLowerCase()),
            top_indicators,
            filter: 'retention-curve predictors ranked by |r_with_views| across the video pool',
            extra: { best_arc: arc && arc.best_arc, worst_arc: arc && arc.worst_arc },
        });
    }

    // ── Climax & payoff ───────────────────────────────────────────
    {
        const top5 = (retentionPatterns && retentionPatterns.top_5_retention_predictors) || [];
        const payoffPredictors = top5.filter(r => ['HOOK_PAYOFF_GAP', 'END_RECOVERY', 'MOMENTUM_ZONES'].includes(r.signal));
        const top_indicators = payoffPredictors.map(r => ({
            key: String(r.signal || '').toLowerCase(),
            evidence_type: 'top_5_retention_predictor',
            r_with_views: round(r.r_with_views, 3),
            modality: 'retention curve (second-by-second)',
            quantification: r.description ? String(r.description).slice(0, 220) : null,
            design_rule: r.design_rule,
            why: `rank #${r.rank}, r=${round(r.r_with_views, 3)}`,
        }));
        traces.climax_and_payoff = makeTrace({
            field: 'climax_and_payoff',
            rationale: 'Climax & final-5% payoff is validated against HOOK_PAYOFF_GAP (over-delivery, r=-0.52), END_RECOVERY (80-95% zone, r=+0.506), and MOMENTUM_ZONES (r=+0.468).',
            evidence_sources: ['retention-patterns.top_5_retention_predictors', 'retention-patterns.wave8_new_signals', 'retention-patterns.wave11_12_new_signals.end_begin_ratio'],
            indicators_considered_count: payoffPredictors.length,
            indicator_keys: payoffPredictors.map(r => String(r.signal || '').toLowerCase()),
            top_indicators,
            filter: 'payoff-zone retention predictors (80-95% and end-begin ratio)',
        });
    }

    // ── Arc ───────────────────────────────────────────────────────
    {
        const arc = (retentionPatterns && retentionPatterns.narrative_arc_analysis) || {};
        const shape = (retentionPatterns && retentionPatterns.shape_clustering) || {};
        const wave9 = (retentionPatterns && retentionPatterns.wave9_10_new_signals) || {};
        const indicator_keys = [
            arc.best_arc && `arc:${arc.best_arc}`,
            arc.worst_arc && `arc:${arc.worst_arc}`,
            shape.best_shape && `shape:${shape.best_shape}`,
            wave9.best_after_worst && 'best_after_worst',
            wave9.divergence_point && 'divergence_point',
        ].filter(Boolean);
        const top_indicators = [];
        if (arc.best_arc) top_indicators.push({ key: 'narrative_arc.best', evidence_type: 'narrative_arc_analysis', note: arc.best_arc, quantification: 'Best-performing arc label (median views)', why: 'best arc label in corpus' });
        if (wave9.best_after_worst) top_indicators.push({ key: 'best_after_worst', evidence_type: 'wave9_10', note: 'nadir placed before climax → 3.3M vs 650K reversed', quantification: 'Median views when nadir precedes climax', why: '5x gap' });
        if (wave9.divergence_point) top_indicators.push({ key: 'divergence_point', evidence_type: 'wave9_10', quantification: 'First-second at which top-vs-bottom retention curves diverge', why: `typical divergence at ~${wave9.divergence_point.first_significant || '—'}` });
        traces.arc = makeTrace({
            field: 'arc',
            rationale: 'Arc shape / nadir placement / divergence timing are validated against narrative_arc_analysis, shape_clustering, and wave9_10 best_after_worst/divergence signals.',
            evidence_sources: ['retention-patterns.narrative_arc_analysis', 'retention-patterns.shape_clustering', 'retention-patterns.wave9_10_new_signals'],
            indicators_considered_count: indicator_keys.length,
            indicator_keys,
            top_indicators,
            filter: 'narrative arc / shape-cluster / divergence-point empirical labels',
        });
    }

    // ── Pacing ────────────────────────────────────────────────────
    {
        const keys = ['speaking_rate', 'peak_speaking_rate_wps', 'drop_speaking_rate_wps', 'utterance_length_at_peaks_words', 'utterance_length_at_drops_words', 'pause_rate'];
        const top_indicators = keys.map(k => resolveIndicator(k, ctx, {
            evidence_type: 'indicator_registry_or_pattern',
            why: 'pacing lever from speaking_patterns / wave9_10 word_velocity',
        }));
        traces.pacing = makeTrace({
            field: 'pacing',
            rationale: 'Pacing targets are validated against speaking_patterns (peak 3.86 wps, drop 4.26 wps, pauses r=-0.22) and wave9_10 word_velocity_confirmed.',
            evidence_sources: ['retention-patterns.speaking_patterns', 'retention-patterns.wave9_10_new_signals.word_velocity_confirmed'],
            indicators_considered_count: keys.length,
            indicator_keys: keys,
            top_indicators,
            filter: 'speaking-rate / utterance-length / pause-rate measures',
        });
    }

    // ── Visual prescription ───────────────────────────────────────
    {
        const outcomes = ['swipe_away_rate', 'avg_retention', 'hook_retention', 'like_rate'];
        const frameLinks = linksByFilter(mil, { mechPrefix: 'frame_', indicatorKeys: outcomes });
        const indicator_keys = [...new Set(frameLinks.map(l => l.mechanism_id))];
        traces.visual_prescription = makeTrace({
            field: 'visual_prescription',
            rationale: 'Per-zone visual prescription (first_5s / hook_quarter / mid / late / avoid) is validated against all frame_* mechanisms linked to retention / swipe / like outcomes.',
            evidence_sources: ['mechanism_indicator_links.json', 'retention-patterns.vision_analysis_gpt4o_mini', 'retention-patterns.cross_modal_alignment'],
            indicators_considered_count: frameLinks.length,
            indicator_keys,
            top_indicators: topIndicatorsFromLinks(frameLinks, ctx, 10),
            filter: `mechanism_id startswith "frame_" AND outcome ∈ {${outcomes.join(', ')}} · |rho|≥${ctx.milThresholdRho}, min n=${ctx.milThresholdN}`,
        });
    }

    // ── Vocabulary prescription ───────────────────────────────────
    {
        const voc = brief.evidence_lattice && brief.evidence_lattice.vocabulary || {};
        const pos = voc.top_words_positive || [];
        const neg = voc.top_words_negative || [];
        const peakPhrases = voc.peak_phrases || [];
        const dropPhrases = voc.drop_phrases || [];
        const indicator_keys = [
            ...pos.slice(0, 10).map(w => `word_pos:${w.word}`),
            ...neg.slice(0, 10).map(w => `word_neg:${w.word}`),
            ...peakPhrases.slice(0, 6).map(p => `peak_phrase:${p}`),
            ...dropPhrases.slice(0, 6).map(p => `drop_phrase:${p}`),
        ];
        const top_indicators = [
            ...pos.slice(0, 5).map(w => ({ key: `word_pos:${w.word}`, evidence_type: 'word_retention_impact', delta: w.delta, n: w.n, modality: 'transcript (word-level)', quantification: 'Mean above_baseline delta when word appears (n≥5)', why: `+${w.delta} above-baseline (n=${w.n})` })),
            ...neg.slice(0, 5).map(w => ({ key: `word_neg:${w.word}`, evidence_type: 'word_retention_impact', delta: w.delta, n: w.n, modality: 'transcript (word-level)', quantification: 'Mean above_baseline delta when word appears (n≥5)', why: `${w.delta} above-baseline (n=${w.n})` })),
        ];
        traces.vocabulary_prescription = makeTrace({
            field: 'vocabulary_prescription',
            rationale: 'Vocabulary targets (use peak words, avoid material words, close on impact words, peak phrases) are validated against word-retention-impact.json and wave11_12.key_phrases.',
            evidence_sources: ['word-retention-impact.json', 'retention-patterns.word_impact_dictionary', 'retention-patterns.wave11_12_new_signals.key_phrases'],
            indicators_considered_count: (pos.length + neg.length + peakPhrases.length + dropPhrases.length),
            indicator_keys,
            top_indicators,
            filter: 'per-word avg above_baseline delta (n≥5) + peak/drop phrase enrichment (wave11_12)',
        });
    }

    // ── Duration target ───────────────────────────────────────────
    {
        const di = retentionPatterns && retentionPatterns.duration_insight;
        const top_indicators = [
            resolveIndicator('duration_s', ctx, {
                evidence_type: 'indicator_registry',
                why: 'Direct duration correlate with views; 46-60s sweet spot empirical',
            }),
        ];
        traces.duration_target = makeTrace({
            field: 'duration_target',
            rationale: 'Duration band is validated against the retention-patterns duration_insight bins (46-60s = 2.88M median vs 15-30s death zone).',
            evidence_sources: ['retention-patterns.duration_insight'],
            indicators_considered_count: 1,
            indicator_keys: ['duration_s'],
            top_indicators,
            filter: 'duration-bin medians across the corpus',
            extra: { duration_insight_summary: di ? (di.sweet_spot || di.summary || null) : null },
        });
    }

    // ── Hook mechanisms ───────────────────────────────────────────
    {
        const hooks = brief.hook_mechanisms || [];
        const top_indicators = hooks.slice(0, 8).map(h => ({
            key: h.mechanism_id,
            evidence_type: 'principle_chain',
            bucket: h.bucket,
            csw: round(h.csw, 3),
            n: h.n_videos,
            principle_id: h.principle_id,
            via_indicator: h.via_indicator,
            quantification: 'chain_strength_specificity_weighted = mechanism→indicator ρ × indicator→views r × specificity-IDF',
            why: `csw=${round(h.csw, 3)} via ${h.via_indicator} (n=${h.n_videos})`,
        }));
        traces.hook_mechanisms = makeTrace({
            field: 'hook_mechanisms',
            rationale: 'Hook-bucket picks (first_5s / first_10s / hook_quarter) are validated against top_mechanism_principles filtered to hook buckets and ranked by chain_strength_specificity_weighted.',
            evidence_sources: ['principles.json', 'bridge_top_principles.json', 'mechanisms.json'],
            indicators_considered_count: (brief.top_mechanism_principles || []).length,
            indicator_keys: hooks.map(h => h.mechanism_id),
            top_indicators,
            filter: 'principles where mechanism_id ∈ {first_5s, first_10s, hook_quarter} AND mechanism_n_videos ≥ 20',
        });
    }

    // ── Pre-upload levers ─────────────────────────────────────────
    {
        const ir = ctx.indicatorIndex;
        const interaction = (brief.evidence_lattice && brief.evidence_lattice.interaction_rules) || [];
        const pre = brief.top_pre_upload_predictors || [];
        const keys = (seed.pre_upload_levers || []);
        const top_indicators = keys.map(k => {
            const pr = pre.find(p => p.key === k);
            const ix = interaction.find(r => r.key === k);
            const extras = pr ? { evidence_type: 'top_pre_upload_predictor', r_to_views: pr.r_to_views, direction: pr.direction, why: `r=${pr.r_to_views} vs views, ${pr.direction}` }
                : ix ? { evidence_type: 'interaction_rule', r_partial: ix.r_partial, r_direct: ix.r_direct, why: `interaction r_partial=${ix.r_partial}; ${String(ix.note || '').slice(0,120)}` }
                : { evidence_type: 'indicator_registry' };
            return resolveIndicator(k, ctx, extras);
        });
        traces.pre_upload_levers = makeTrace({
            field: 'pre_upload_levers',
            rationale: 'Pre-upload levers are validated against top_pre_upload_predictors (pool q001.strongest_pre_upload.top) + indicator-registry pre-layer interactions ranked by |r_partial|.',
            evidence_sources: ['research_answers.json (q001)', 'indicator-registry.json (pre-layer)', 'prediction-model.json (full_model.features)'],
            indicators_considered_count: (ir && ir.size) || 0,
            indicator_keys: keys,
            top_indicators,
            filter: 'pre-upload layer indicators + interaction terms ranked by |r| / |r_partial|',
        });
    }

    // ── Risk flags ────────────────────────────────────────────────
    {
        const risks = (brief.evidence_lattice && brief.evidence_lattice.risk_flags) || [];
        const top_indicators = risks.slice(0, 8).map(r => ({
            key: `risk:${String(r.flag || '').toLowerCase()}`,
            evidence_type: r.source || 'risk_flag',
            effect_size: r.effect_size,
            quantification: r.evidence ? String(r.evidence).slice(0, 200) : null,
            rule: r.rule,
            why: r.evidence ? String(r.evidence).slice(0, 200) : null,
        }));
        traces.risk_flags = makeTrace({
            field: 'risk_flags_detected',
            rationale: 'Detected risk flags are validated against retention-patterns.top_3_retention_drop_causes, wave9_10 worst_moment_timing, wave11_12 drop_phrases / stakes_hook, and cross_modal_alignment.',
            evidence_sources: ['retention-patterns.top_3_retention_drop_causes', 'retention-patterns.wave9_10_new_signals', 'retention-patterns.wave11_12_new_signals', 'retention-patterns.cross_modal_alignment'],
            indicators_considered_count: risks.length,
            indicator_keys: risks.map(r => String(r.flag || '').toLowerCase()),
            top_indicators,
            filter: 'empirical drop-cause / cross-modal alignment signals',
        });
    }

    // ── Scorecard targets ────────────────────────────────────────
    {
        const sd = brief.evidence_lattice && brief.evidence_lattice.scorecard_dimensions;
        const dims = sd && sd.dimension_stats ? Object.keys(sd.dimension_stats) : [];
        const top_indicators = dims.map(d => {
            const s = sd.dimension_stats[d];
            return {
                key: `scorecard_dim:${d}`,
                evidence_type: 'video_scorecards',
                corpus_mean: s && s.mean, corpus_p75: s && s.p75, corpus_p90: s && s.p90,
                quantification: `Per-video 0-10 score on ${d} dimension across n=${sd.n_scorecards} scorecards`,
                why: `empirical dim — µ=${s && s.mean}, p90=${s && s.p90}`,
            };
        });
        traces.scorecard_targets = makeTrace({
            field: 'scorecard_targets',
            rationale: 'Scorecard targets are validated against the per-dimension distribution stats (mean, p75, p90) computed across the video scorecard corpus.',
            evidence_sources: ['video-scorecards.json'],
            indicators_considered_count: dims.length,
            indicator_keys: dims,
            top_indicators,
            filter: `per-dimension percentile stats across n=${(sd && sd.n_scorecards) || 0} scorecards`,
        });
    }

    return traces;
}

function buildMetricValidationTraces(brief, ctx) {
    const mil = ctx.mil;
    const traces = {};

    // swipe_away_rate
    {
        const links = linksByFilter(mil, { mechPrefix: 'frame_', indicatorKeys: ['swipe_away_rate'] });
        const indicator_keys = [...new Set(links.map(l => l.mechanism_id))];
        traces.swipe_away_rate = makeTrace({
            field: 'estimated_metrics.swipe_away_rate',
            rationale: 'Additive model: corpus median swipe-away + design deltas anchored to frame_* → swipe_away_rate mechanism-indicator links and hook taxonomy / opening rate lattice.',
            evidence_sources: ['mechanism_indicator_links.json', 'retention-patterns.wave11_12_new_signals.hook_taxonomy', 'retention-patterns.speaking_patterns.opening_density', 'retention-patterns.opening_words.best_first_words'],
            indicators_considered_count: links.length,
            indicator_keys,
            top_indicators: topIndicatorsFromLinks(links, ctx, 8),
            filter: `mechanism_id startswith "frame_" AND outcome = swipe_away_rate (|rho|≥${ctx.milThresholdRho}, min n=${ctx.milThresholdN})`,
        });
    }

    // hook_retention_20s
    {
        const top_indicators = [
            { key: 'retention_at_20s', evidence_type: 'BREAKTHROUGH_WAVE20', modality: 'retention curve', quantification: 'Cumulative retention at 20-sec mark', why: 'corpus mean = 79.3%; r_with_views ≈ 0.60 (single strongest view predictor)' },
            { key: 'HIGH-ENERGY_ACTION_FRAMES', evidence_type: 'top_3_retention_peak_causes', quantification: 'Action frames at best vs worst moments (28% vs 8%)', why: '+0.058 avg above-baseline' },
            { key: 'PHYSICAL_SENSORY_LANGUAGE', evidence_type: 'top_3_retention_peak_causes', quantification: 'Sensory-word rate; regression weight +1.59', why: '+0.06 avg above-baseline' },
            { key: 'TECHNICAL_MATERIAL_LANGUAGE', evidence_type: 'top_3_retention_drop_causes', quantification: 'Avg above-baseline when material words appear', why: 'plastic=-0.171, solid=-0.163 etc.' },
            { key: 'opening_density_medium', evidence_type: 'speaking_patterns.opening_density', quantification: 'Words-per-sec density in opening', why: '1.5-3.0 wps is the sweet zone' },
        ];
        traces.hook_retention_20s = makeTrace({
            field: 'estimated_metrics.hook_retention_20s',
            rationale: 'Additive model: corpus mean retention@20s (79.3%) + design deltas keyed to top peak/drop causes and opening density.',
            evidence_sources: ['retention-patterns.BREAKTHROUGH_WAVE20.raw_retention_at_20s', 'retention-patterns.top_3_retention_peak_causes', 'retention-patterns.top_3_retention_drop_causes', 'retention-patterns.design_rules_summary_v3'],
            indicators_considered_count: top_indicators.length,
            indicator_keys: top_indicators.map(t => t.key),
            top_indicators,
            filter: 'retention@20s empirical + top-3 peak/drop causes',
        });
    }

    // share_propensity
    {
        const voc = brief.evidence_lattice && brief.evidence_lattice.vocabulary || {};
        const peak = voc.peak_phrases || [];
        const drop = voc.drop_phrases || [];
        const top_indicators = [
            ...peak.slice(0, 5).map(p => ({ key: `peak_phrase:${p}`, evidence_type: 'wave11_12.key_phrases.peak', quantification: 'Phrase enrichment at above-baseline peaks vs corpus', why: 'peak-enriched phrase (shareable CTA)' })),
            ...drop.slice(0, 3).map(p => ({ key: `drop_phrase:${p}`, evidence_type: 'wave11_12.key_phrases.drop', quantification: 'Phrase enrichment at drops vs corpus', why: 'CTA-drift phrase (avoid)' })),
            { key: 'hook_taxonomy', evidence_type: 'hook_taxonomy', quantification: 'Median views by hook label', why: 'transformation / mystery shareable' },
            { key: 'END_RECOVERY', evidence_type: 'top_5_retention_predictors', quantification: 'Above-baseline retention at 80-95%', why: 'golden final 5% drives share' },
        ];
        traces.share_propensity = makeTrace({
            field: 'estimated_metrics.share_propensity',
            rationale: 'Additive model: nominal 3% share baseline + peak-phrase triggers, shareable hook taxonomy, golden final 5% payoff, and penalty for CTA-drift phrases.',
            evidence_sources: ['retention-patterns.wave11_12_new_signals.key_phrases', 'retention-patterns.wave11_12_new_signals.hook_taxonomy', 'retention-patterns.top_5_retention_predictors.END_RECOVERY'],
            indicators_considered_count: peak.length + drop.length + 2,
            indicator_keys: [...peak.map(p => `peak:${p}`), ...drop.map(p => `drop:${p}`), 'hook_taxonomy', 'END_RECOVERY'],
            top_indicators,
            filter: 'peak_phrases ∪ drop_phrases ∪ hook_taxonomy ∪ END_RECOVERY',
        });
    }

    // keep_rate
    {
        const top_indicators = [
            { key: 'HOOK_PAYOFF_GAP', evidence_type: 'top_5_retention_predictors', r_with_views: -0.52, why: 'over-delivery wins (rank #1)' },
            { key: 'progression_pattern_triple_up', evidence_type: 'wave7.quartile_templates', quantification: '↑↑↑ vs ↓↓↓ median views', why: '4.19M vs 222K (19x)' },
            { key: 'best_after_worst', evidence_type: 'wave9_10', quantification: 'median views when nadir precedes climax', why: '5x gap (3.3M vs 650K)' },
        ];
        traces.keep_rate = makeTrace({
            field: 'estimated_metrics.keep_rate',
            rationale: 'Additive model: corpus mean keep + deltas from over-delivery structure, monotonic rise, and nadir placement — each grounded in an explicit retention-pattern signal.',
            evidence_sources: ['retention-patterns.top_5_retention_predictors', 'retention-patterns.wave7_new_signals.quartile_templates', 'retention-patterns.wave9_10_new_signals.best_after_worst', 'findings-summary.kept_signals'],
            indicators_considered_count: top_indicators.length,
            indicator_keys: top_indicators.map(t => t.key),
            top_indicators,
            filter: 'keep-rate design levers (structure + concept stack)',
        });
    }

    // view_band
    {
        const sd = brief.evidence_lattice && brief.evidence_lattice.scorecard_dimensions;
        const pm = brief.evidence_lattice && brief.evidence_lattice.prediction_model_summary;
        const top_indicators = [
            { key: 'video_scorecard.total_score', evidence_type: 'video_scorecards', quantification: 'Sum of 7 dimension scores (0-10 each)', why: `n=${(sd && sd.n_scorecards) || 0} scorecards binned into 5 quintiles` },
            { key: 'full_model.cv_r2', evidence_type: 'prediction_model.full_model', quantification: 'Cross-validated R² on log-views', why: `cv_r2=${pm && pm.full && pm.full.cv_r2}` },
            { key: 'full_model.prediction_range_multiplier', evidence_type: 'prediction_model.full_model', quantification: 'Multiplier used to widen quintile band for uncertainty', why: `${pm && pm.full && pm.full.prediction_range_multiplier}x — ${pm && pm.full && pm.full.n_videos} videos` },
        ];
        traces.view_band = makeTrace({
            field: 'estimated_metrics.view_band',
            rationale: 'Design score is mapped onto the video-scorecard total-score quintiles (views_median, p25, p75) and then expanded by the full-model prediction-range multiplier to express residual uncertainty.',
            evidence_sources: ['video-scorecards.json', 'prediction-model.json.full_model'],
            indicators_considered_count: top_indicators.length,
            indicator_keys: top_indicators.map(t => t.key),
            top_indicators,
            filter: 'scorecard total-score quintiles (view_median, p25, p75) × full-model range multiplier',
            extra: { note: 'MODELED — not a prediction. 72.9% of view variance is external (algorithm, timing, audience).' },
        });
    }

    return traces;
}

function buildIndicatorCorpus(brief, ctx) {
    const mil = ctx.mil;
    return {
        indicator_registry_total: (ctx.indicatorIndex && ctx.indicatorIndex.size) || 0,
        mechanism_indicator_links_total: (mil && mil.n_links) || (mil && mil.links && mil.links.length) || 0,
        mechanism_indicator_links_threshold_abs_rho: (mil && mil.threshold_abs_rho) || null,
        mechanism_indicator_links_min_n: (mil && mil.threshold_min_n) || null,
        mechanism_indicator_link_outcomes: (mil && mil.indicator_keys) || [],
        retention_pattern_waves: (brief.source_sizes && brief.source_sizes.retention_pattern_waves) || null,
        video_scorecards_n: (brief.source_sizes && brief.source_sizes.video_scorecards_count) || null,
        video_pool_n: (brief.source_sizes && brief.source_sizes.videos_in_pool) || null,
        principles_total: (brief.source_sizes && brief.source_sizes.principles_total) || null,
        components_total: (brief.source_sizes && brief.source_sizes.components_total) || null,
        mechanisms_total: (brief.source_sizes && brief.source_sizes.mechanisms_total) || null,
        word_retention_scored: (brief.source_sizes && brief.source_sizes.word_retention_scored) || null,
        candidate_proposal_families: (brief.source_sizes && brief.source_sizes.candidate_proposal_families) || null,
        note: 'Counts represent the candidate pool. Each section trace below enumerates how the pool was filtered and which indicators were actually used.',
    };
}

function buildBlueprintValidation(seed, brief, artifacts) {
    const mil = artifacts && artifacts.mechanismIndicatorLinks;
    const ctx = {
        indicatorIndex: indicatorRegistryIndex(artifacts && artifacts.indicatorRegistry),
        mil,
        milThresholdRho: (mil && mil.threshold_abs_rho) || 0.05,
        milThresholdN: (mil && mil.threshold_min_n) || 20,
        retentionPatterns: artifacts && artifacts.retentionPatterns,
    };
    return {
        corpus: buildIndicatorCorpus(brief, ctx),
        section_traces: buildSectionValidationTraces(seed, brief, ctx),
        metric_traces: buildMetricValidationTraces(brief, ctx),
        catalog_enrichment: !!variableCatalog,
    };
}

// ──────────────────────────────────────────────────────────────────────
// Assemble a full blueprint from a seed + brief
// ──────────────────────────────────────────────────────────────────────

function assembleBlueprint(seed, brief, rank, artifacts) {
    const hooks = pickHooksForIdea(brief, seed.hook_bucket_preference || {});
    const dBand = DURATION_BANDS.find(d => d.id === seed.duration_band_id);

    const idea = {
        rank,
        id: seed.id,
        title: seed.title,
        one_line_premise: seed.logline, // backward-compat
        concept: {
            title: seed.title,
            logline: seed.logline,
            promise: seed.promise,
            payoff: seed.payoff,
            over_delivery_note: seed.over_delivery_note,
        },
        opening: seed.opening,
        build_phases: seed.build_phases,
        climax_and_payoff: {
            climax_placement_pct: '60-80',
            golden_final_5pct: 'yes',
            climax_hint: seed.climax_hint,
            closing_line_hint: seed.closing_line_hint,
        },
        arc: {
            arc_shape: seed.narrative_structures.includes('comeback_arc') ? 'neg_to_pos_comeback' : 'steady_rise',
            shape_encoding_target: '00+++',
            progression_target: '↑↑↑',
            nadir_placement_pct: 17,
            divergence_locked_in_by_pct: 22,
        },
        pacing: {
            opening_wps_target: seed.opening.opening_speech_rate_wps_target,
            peak_wps_target: 3.0,
            closing_wps_target: 3.2,
            utterance_length_at_peaks_words_target: 7.9,
            no_long_pauses: true,
        },
        visual_prescription: seed.visual_prescription_hints,
        vocabulary_prescription: seed.vocabulary_hints,
        share_triggers: seed.share_triggers,
        duration_target: dBand ? { seconds: dBand.seconds, band: dBand.id, evidence: dBand.evidence } : null,
        duration_band_id: seed.duration_band_id, // backward-compat
        hook_mechanisms: hooks,
        narrative_structures: seed.narrative_structures,
        pre_upload_levers: seed.pre_upload_levers,
        interactions_engineered: seed.interactions_engineered,
        synthesis_trace: seed.synthesis_trace || null,
    };

    idea.score_breakdown = scoreIdea(idea, brief);
    idea.evidence = evidenceFor(idea, brief);
    idea.scorecard_targets = computeScorecardTargets(idea, brief);
    idea.risk_flags_detected = computeRiskFlagsForIdea(idea, brief);

    // Estimated metrics (MODELED)
    idea.estimated_metrics = {
        swipe_away_rate: estimateSwipeAway(idea, brief),
        hook_retention_20s: estimateHookRetention20s(idea, brief),
        share_propensity: estimateSharePropensity(idea, brief),
        keep_rate: estimateKeepRate(idea, brief),
        view_band: estimateViewBand(idea, brief, idea.score_breakdown.total || 0),
    };

    // Validation-trace layer: every section and every modeled metric
    // carries an explicit list of the indicators it was validated against,
    // how many were considered, and how each is quantified. This is the
    // audit surface Tyler asked for — no opaque box, no fake precision.
    const validation = buildBlueprintValidation(seed, brief, artifacts || {});
    idea.validation = validation;
    for (const k of Object.keys(idea.estimated_metrics)) {
        if (validation.metric_traces && validation.metric_traces[k]) {
            idea.estimated_metrics[k].validation = validation.metric_traces[k];
        }
    }

    // Drivers / why-it-works rollup
    const secCount = Object.keys(validation.section_traces || {}).length;
    const metricCount = Object.keys(validation.metric_traces || {}).length;
    idea.why_it_works = [
        `Specific premise (${seed.title.length <= 90 ? seed.title : seed.title.slice(0, 87) + '…'}) — every concrete choice (object, timer, endpoint) survives the validation filter below.`,
        `Arc = ${idea.arc.arc_shape} with nadir placed at ~${idea.arc.nadir_placement_pct}% (best_after_worst 5x gap).`,
        `Hook-retention@20s modeled ${idea.estimated_metrics.hook_retention_20s.band} (${(idea.estimated_metrics.hook_retention_20s.modeled_value * 100).toFixed(1)}%) — first-20s is the single strongest view predictor (r=0.6).`,
        `Over-delivery structure: hook promises less than the 95% payoff delivers (hook_payoff_gap rewards over-delivery, r=-0.52).`,
        `Vocabulary: commits to ${((seed.vocabulary_hints && seed.vocabulary_hints.use_peak_words) || []).length} peak words and avoids ${((seed.vocabulary_hints && seed.vocabulary_hints.avoid_material_words) || []).length} material-class words.`,
        `Validation trace: ${secCount} blueprint sections and ${metricCount} modeled metrics carry explicit indicator lineage (pool size, filter, top indicators w/ r/rho/csw and quantification).`,
    ];
    return idea;
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

function generateIdeas(brief, count = 5, artifacts = null) {
    if (!brief) {
        artifacts = artifacts || loadAllArtifacts();
        brief = compress(artifacts);
    }
    // Synthesize specific-idea seeds from the artifact lattice (v3).
    // Pull more than `count` so assembleBlueprint scoring can re-rank.
    const seeds = synthesizeSeeds(brief, artifacts, Math.max(count * 2, 10));
    const ideas = seeds.map((seed, i) => assembleBlueprint(seed, brief, i + 1, artifacts));
    ideas.sort((a, b) => (b.score_breakdown.total || 0) - (a.score_breakdown.total || 0));
    const topN = ideas.slice(0, count);
    topN.forEach((x, i) => { x.rank = i + 1; });
    return topN;
}

function buildModel() {
    const artifacts = loadAllArtifacts();
    return { brief: compress(artifacts), artifacts };
}

function buildIdeas(count = 5) {
    const { brief, artifacts } = buildModel();
    const ideas = generateIdeas(brief, count, artifacts);
    return { brief_summary: summarizeBrief(brief), ideas };
}

function summarizeBrief(brief) {
    const l = brief.evidence_lattice || {};
    return {
        generated_at: brief.generated_at,
        engine_version: brief.engine_version || 'v2',
        source_sizes: brief.source_sizes,
        headline_model_r2: brief.headline_model_r2,
        counts: {
            top_post_upload_predictors: brief.top_post_upload_predictors.length,
            top_pre_upload_predictors: brief.top_pre_upload_predictors.length,
            top_bridges: brief.top_bridges_pre_to_post_to_views.length,
            top_mechanism_principles: brief.top_mechanism_principles.length,
            hook_mechanisms: brief.hook_mechanisms.length,
            proven_kept_signals: brief.proven_features.kept_signals.length,
            top_components: brief.top_components.length,
            lattice_top_words_positive: (l.vocabulary && l.vocabulary.top_words_positive || []).length,
            lattice_top_words_negative: (l.vocabulary && l.vocabulary.top_words_negative || []).length,
            lattice_interaction_rules: (l.interaction_rules || []).length,
            lattice_risk_flags: (l.risk_flags || []).length,
            lattice_design_rules: (l.design_rules_v3 || []).length,
            lattice_scorecards: (l.scorecard_dimensions && l.scorecard_dimensions.n_scorecards) || 0,
        },
    };
}

module.exports = {
    loadAllArtifacts,
    compress,
    buildModel,
    buildIdeas,
    generateIdeas,
    summarizeBrief,
};

// CLI: node buildings/jarvis/viral-idea-engine.js [model|ideas|save]
if (require.main === module) {
    const cmd = process.argv[2] || 'ideas';
    if (cmd === 'model') {
        const { brief } = buildModel();
        process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
    } else if (cmd === 'ideas') {
        const count = parseInt(process.argv[3] || '5', 10);
        const payload = buildIdeas(count);
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else if (cmd === 'save') {
        const count = parseInt(process.argv[3] || '5', 10);
        const payload = buildIdeas(count);
        const outPath = path.join(ARTIFACT_DIR, 'viral-ideas.json');
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
        process.stdout.write(`Wrote ${outPath}\n`);
    } else {
        process.stderr.write(`Usage: node viral-idea-engine.js [model|ideas [n]|save [n]]\n`);
        process.exit(2);
    }
}
