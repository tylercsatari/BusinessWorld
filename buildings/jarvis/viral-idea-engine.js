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

function loadAllArtifacts(opts = {}) {
    // skipMechanisms: skip mechanisms.json (~2.8MB). Only its top-level
    // n_mechanisms / n_videos_pool scalars are read by compress(); nothing
    // downstream references the body. The ideas endpoint passes this on
    // Render to keep the dyno under the 2GB memory cap.
    const skipMechanisms = !!opts.skipMechanisms;
    return {
        findings: loadJsonSafe('findings-summary.json'),
        answers: loadJsonSafe('research_answers.json'),
        principles: loadJsonSafe('principles.json'),
        bridgeTop: loadJsonSafe('bridge_top_principles.json'),
        components: loadJsonSafe('components.json'),
        mechanisms: skipMechanisms ? null : loadJsonSafe('mechanisms.json'),
        questions: loadJsonSafe('research_questions.json'),
        retentionPatterns: loadJsonSafe('retention-patterns.json'),
        wordImpact: loadJsonSafe('word-retention-impact.json'),
        videoScorecards: loadJsonSafe('video-scorecards.json'),
        predictionModel: loadJsonSafe('prediction-model.json'),
        preuploadModel: loadJsonSafe('preupload-model.json'),
        indicatorRegistry: loadJsonSafe('indicator-registry.json'),
        candidateProposals: loadJsonSafe('candidate_proposals.json'),
        mechanismIndicatorLinks: loadJsonSafe('mechanism_indicator_links.json'),
        signals: loadJsonSafe('signals-dataset.json'),
    };
}

// ──────────────────────────────────────────────────────────────────────
// Narrow-predictor helpers (carried over from v1, tightened)
// ──────────────────────────────────────────────────────────────────────

function normalizeIndicatorMetadata(data) {
    if (!data || typeof data !== 'object') return data;
    return Object.assign({}, data);
}

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
        const diversityBucket = collapseFamily(row.key);
        if (seen.has(diversityBucket)) continue;
        seen.add(diversityBucket);
        out.push({ key: row.key, key_pattern: diversityBucket, diversity_bucket: diversityBucket, r_to_views: round(row.r, 4) });
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
    const kept = (findings.kept_signals || []).map(sig => ({
        signal: sig.signal,
        delta_r2: sig.delta_r2,
        meaning: sig.meaning,
        signal_kind: sig.signal_kind,
    }));
    const discoveries = (findings.top_discoveries || [])
        .filter(d => d.r_partial === null || Math.abs(d.r_partial) >= 0.2)
        .map(d => ({ discovery: d.discovery, r_partial: d.r_partial, meaning: d.meaning }));
    const retention = (findings.retention_patterns || []).map(p => ({ pattern: p.pattern, evidence: p.evidence }));
    const conceptSignals = kept.filter(s => s.signal_kind === 'concept' || s.signal_kind === 'content');
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

function getCandidateProposalDiversityBuckets(candidates) {
    if (!candidates) return [];
    if (Array.isArray(candidates.diversity_buckets)) return candidates.diversity_buckets;
    return [];
}

function buildHookPrescription(rp, candidates) {
    if (!rp) return null;
    const brk = rp.BREAKTHROUGH_WAVE20 || {};
    const ow = rp.opening_words || {};
    const sp = rp.speaking_patterns || {};
    const hookTax = (rp.wave11_12_new_signals && rp.wave11_12_new_signals.hook_taxonomy) || null;
    // Opening speech rate candidate (target)
    let opening_rate_target = null;
    const candidateBuckets = getCandidateProposalDiversityBuckets(candidates);
    if (candidateBuckets.length) {
        for (const fam of candidateBuckets) {
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
        progression_patterns: wave7.progression_patterns || null,
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
            candidate_proposal_diversity_buckets: getCandidateProposalDiversityBuckets(candidateProposals).length,
            // Active synthesis traces now use only source-video-led diversity_bucket naming.
            synthesis_trace_primary_diversity_axis: 'diversity_bucket',
            keep_rate_top_indicators_primary_evidence_type: 'wave7.progression_patterns',
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
// parts, sensation words, visual action, safety tier, and explicit proof
// anchors.
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
// specificity of endpoint). Top N survive on explicit premise evidence,
// not an abstract classification layer. Risky atoms are excluded up front.

const OBJECT_MOTIFS = [
    {
        id: 'pushups_one_day',
        verb_past_phrase: 'Did',
        verb_present_phrase: 'do',
        noun_subject_phrase: 'push-ups',
        title_premise_line: 'I Did {N} Push-Ups In One Day',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'in my garage',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'plank_hold_hours',
        verb_past_phrase: 'Held',
        verb_present_phrase: 'hold',
        noun_subject_phrase: 'a plank',
        title_premise_line: 'I Held A Plank For {D}',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'on gym flooring with a timer overlay',
        endpoint_kinds: ['time_to_target', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'weighted_backpack_march',
        verb_past_phrase: 'Marched With',
        verb_present_phrase: 'march with',
        noun_subject_phrase: 'a weighted backpack',
        title_premise_line: 'I Marched With A Weighted Backpack For {D}',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a marked road',
        endpoint_kinds: ['exact_distance', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'stair_climb_repeats',
        verb_past_phrase: 'Climbed',
        verb_present_phrase: 'climb',
        noun_subject_phrase: 'a single flight of stairs',
        title_premise_line: 'I Climbed A Single Flight Of Stairs {N} Times',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'in a stairwell',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'jump_rope_day',
        verb_past_phrase: 'Jumped Rope',
        verb_present_phrase: 'jump rope',
        noun_subject_phrase: 'jump rope',
        title_premise_line: 'I Jumped Rope {N} Times In One Day',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a driveway',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'sandbag_carry',
        verb_past_phrase: 'Carried',
        verb_present_phrase: 'carry',
        noun_subject_phrase: 'a 100-lb sandbag',
        title_premise_line: 'I Carried A 100-Lb Sandbag For {D}',
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
        diversity_bucket: 'endurance',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a long stretch of road',
        endpoint_kinds: ['exact_distance', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'memorize_book',
        verb_past_phrase: 'Memorized',
        verb_present_phrase: 'memorize',
        noun_subject_phrase: 'a short novel',
        title_premise_line: 'I Memorized Every Page Of A Short Novel In {T}',
        title_premise_line_reps: 'I Memorized {N} Pages Of A Short Novel In One Day',
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
        diversity_bucket: 'cognitive_feat',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a desk with a page tally on the wall',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'handwritten_letters',
        verb_past_phrase: 'Hand-Wrote',
        verb_present_phrase: 'hand-write',
        noun_subject_phrase: 'letters',
        title_premise_line: 'I Hand-Wrote {N} Letters — One To Every Contact In My Phone',
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
        diversity_bucket: 'repetition_outreach',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a desk beside a stack of stamped envelopes',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'portrait_drawing_strangers',
        verb_past_phrase: 'Drew Portraits Of',
        verb_present_phrase: 'draw portraits of',
        noun_subject_phrase: 'strangers on one street corner',
        title_premise_line: 'I Drew Portraits Of {N} Strangers On One Street Corner',
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
        diversity_bucket: 'repetition_outreach',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a busy sidewalk',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'rubber_band_ball',
        verb_past_phrase: 'Built',
        verb_present_phrase: 'build',
        noun_subject_phrase: 'a rubber-band ball',
        title_premise_line: 'I Built A Rubber-Band Ball Out Of {N} Bands',
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
        diversity_bucket: 'craft_patience',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a desk with a band counter and a ruler against the ball',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'origami_cranes',
        verb_past_phrase: 'Folded',
        verb_present_phrase: 'fold',
        noun_subject_phrase: 'origami cranes',
        title_premise_line: 'I Folded {N} Origami Cranes In One Day',
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
        diversity_bucket: 'craft_patience',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a table with a growing pile of cranes',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'jigsaw_speedrun',
        verb_past_phrase: 'Solved',
        verb_present_phrase: 'solve',
        noun_subject_phrase: 'a jigsaw puzzle',
        title_premise_line: 'I Solved A {N}-Piece Jigsaw Puzzle In One Day',
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
        diversity_bucket: 'cognitive_feat',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a long puzzle table',
        endpoint_kinds: ['exact_count', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'coin_edge_tower',
        verb_past_phrase: 'Stacked',
        verb_present_phrase: 'stack',
        noun_subject_phrase: 'coins on their edges',
        title_premise_line: 'I Stacked {N} Coins On Their Edges Into One Tower',
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
        diversity_bucket: 'craft_patience',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a table with a height ruler taped behind the tower',
        endpoint_kinds: ['exact_count', 'body_quit'],
        implied_material_words: [],
    },
    // ── build_test bucket ────────────────────────────────────────────
    {
        id: 'cardboard_boat_row',
        verb_past_phrase: 'Built And Rowed',
        verb_present_phrase: 'row',
        noun_subject_phrase: 'a cardboard boat',
        title_premise_line: 'I Built A Boat Out Of Only Cardboard And Tape And Rowed It {D}',
        logline_action: 'build a boat out of only cardboard and packing tape, then row it across a lake as far as the seams hold',
        concrete_kind: 'distance',
        scales: ['1 mile', '2 miles', '3 miles'],
        body_parts: ['shoulders', 'stomach', 'skin'],
        body_part_phrase: 'shoulders',
        sensation_words: ['curious', 'feeling', 'bigger', 'numb'],
        first_frame_action: 'taping the last cardboard seam on a finished hull with the shoreline framing the shot',
        visual_action_short: 'oars pulling as the cardboard boat slides out from the dock',
        action_intensity: 'medium',
        safety_tier: 'safe',
        diversity_bucket: 'build_test',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a calm shallow lake wearing a life vest',
        endpoint_kinds: ['exact_distance', 'build_test_outcome'],
        implied_material_words: [],
    },
    {
        id: 'two_by_four_bike',
        verb_past_phrase: 'Built And Rode',
        verb_present_phrase: 'ride',
        noun_subject_phrase: 'a bike made of 2x4s',
        title_premise_line: 'I Built A Bike Out Of 2x4s And Rode It {D} To See What Broke First',
        logline_action: 'build a working bike out of only 2x4s and hardware, then ride it on pavement until something gives',
        concrete_kind: 'distance',
        scales: ['2 miles', '5 miles', '10 miles'],
        body_parts: ['shoulders', 'foot', 'skin'],
        body_part_phrase: 'shoulders',
        sensation_words: ['curious', 'feeling', 'bigger', 'numb'],
        first_frame_action: 'tightening the last bolt on a plywood frame with a completed 2x4 bike in view',
        visual_action_short: 'pedals turning on the wooden bike with a mile-counter overlay',
        action_intensity: 'medium',
        safety_tier: 'safe',
        diversity_bucket: 'build_test',
        preferred_hook_type: 'mystery',
        setting_hint: 'on a closed empty parking lot wearing a helmet',
        endpoint_kinds: ['exact_distance', 'build_test_outcome'],
        implied_material_words: [],
    },
    // ── body_transformation bucket ───────────────────────────────────
    {
        id: 'one_food_thirty_days',
        verb_past_phrase: 'Ate Only',
        verb_present_phrase: 'eat only',
        noun_subject_phrase: 'potatoes',
        title_premise_line: 'I Ate Only Potatoes For {D} — My Body Did Something I Didn\u2019t Expect',
        title_has_builtin_reveal: true,
        logline_action: 'eat only plain potatoes three times a day and film a morning weigh-in at the same hour every day',
        concrete_kind: 'duration',
        scales: ['30 days', '60 days', '90 days'],
        body_parts: ['stomach', 'skin', 'feeling'],
        body_part_phrase: 'stomach',
        sensation_words: ['stomach', 'skin', 'bigger', 'feeling', 'curious', 'numb'],
        first_frame_action: 'morning day-1: a plain potato on the plate next to the scale with the reading on screen',
        visual_action_short: 'a cut between identical morning weigh-ins and identical potato plates',
        action_intensity: 'low',
        safety_tier: 'safe',
        diversity_bucket: 'body_transformation',
        preferred_hook_type: 'transformation',
        setting_hint: 'at the same kitchen counter every morning',
        endpoint_kinds: ['transformation_reveal', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'daily_mile_one_year',
        verb_past_phrase: 'Ran',
        verb_present_phrase: 'run',
        noun_subject_phrase: 'a single mile every day',
        title_premise_line: 'I Ran The Same Mile Every Day For {D} — The First And Last Run Are The Same Shot',
        title_has_builtin_reveal: true,
        logline_action: 'run the same neighborhood mile every morning and film the same starting frame on day 1 and day N',
        concrete_kind: 'duration',
        scales: ['100 days', '365 days'],
        body_parts: ['foot', 'stomach', 'skin'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'stomach', 'skin', 'bigger', 'feeling', 'numb'],
        first_frame_action: 'the exact same driveway starting frame with a big day-counter label in the corner',
        visual_action_short: 'a cut between two runs at the same starting line on day 1 and day N',
        action_intensity: 'medium',
        safety_tier: 'safe',
        diversity_bucket: 'body_transformation',
        preferred_hook_type: 'transformation',
        setting_hint: 'on the exact same one-mile neighborhood loop',
        endpoint_kinds: ['transformation_reveal', 'time_to_target'],
        implied_material_words: [],
    },
    // ── mystery_experiment bucket ────────────────────────────────────
    {
        id: 'silent_seven_days',
        verb_past_phrase: 'Didn\u2019t Speak For',
        verb_present_phrase: 'stop speaking for',
        noun_subject_phrase: 'a week',
        title_premise_line: 'I Didn\u2019t Speak A Single Word For {D} — Here\u2019s What People Started Assuming About Me',
        title_has_builtin_reveal: true,
        logline_action: 'go a full week without saying a single word out loud and film every reaction from the people around me',
        concrete_kind: 'duration',
        scales: ['7 days', '14 days', '30 days'],
        body_parts: ['skin', 'feeling', 'stomach'],
        body_part_phrase: 'feeling',
        sensation_words: ['curious', 'feeling', 'bigger', 'numb'],
        first_frame_action: 'a cashier asking me a question while I point at a notebook that says \u201cday 1, silent\u201d',
        visual_action_short: 'short encounters where I gesture and people react on camera',
        action_intensity: 'low',
        safety_tier: 'safe',
        diversity_bucket: 'mystery_experiment',
        preferred_hook_type: 'mystery',
        setting_hint: 'in everyday errands around my neighborhood',
        endpoint_kinds: ['experiment_observation', 'time_to_target'],
        implied_material_words: [],
    },
    {
        id: 'phoneless_fortnight',
        verb_past_phrase: 'Left Behind',
        verb_present_phrase: 'leave behind',
        noun_subject_phrase: 'my phone',
        title_premise_line: 'I Left My Phone At Home For {D} — Every Hour Of My Day Rearranged Itself',
        title_has_builtin_reveal: true,
        logline_action: 'leave my phone in a drawer for two weeks and film what fills the hours I used to spend scrolling',
        concrete_kind: 'duration',
        scales: ['7 days', '14 days', '30 days'],
        body_parts: ['feeling', 'skin'],
        body_part_phrase: 'feeling',
        sensation_words: ['curious', 'feeling', 'bigger'],
        first_frame_action: 'placing my phone into a drawer, closing it, and turning a calendar to \u201cday 1\u201d',
        visual_action_short: 'time-lapse of a day that used to be scrolling and is now something else',
        action_intensity: 'low',
        safety_tier: 'safe',
        diversity_bucket: 'mystery_experiment',
        preferred_hook_type: 'mystery',
        setting_hint: 'at home, at work, and on public transit where the phone used to live',
        endpoint_kinds: ['experiment_observation', 'time_to_target'],
        implied_material_words: [],
    },
    // ── identity bucket ──────────────────────────────────────────────
    {
        id: 'pro_boxer_day',
        verb_past_phrase: 'Trained With',
        verb_present_phrase: 'train with',
        noun_subject_phrase: 'a professional boxer',
        title_premise_line: 'I Trained With A Pro Boxer For One Full Day — He Told Me When To Stop',
        title_has_builtin_reveal: true,
        logline_action: 'shadow a professional boxer through every single thing he does in his training day — warm-up, bag work, sparring, ice, food',
        concrete_kind: 'duration',
        scales: ['1 day', '2 days', '7 days'],
        body_parts: ['foot', 'shoulders', 'stomach', 'skin'],
        body_part_phrase: 'shoulders',
        sensation_words: ['foot', 'stomach', 'painful', 'numb', 'feeling', 'bigger'],
        first_frame_action: 'a pro boxer wrapping my hands with his gym behind him in the same frame',
        visual_action_short: 'matching his bag work beat for beat with both fighters in the shot',
        action_intensity: 'high',
        safety_tier: 'safe',
        diversity_bucket: 'identity',
        preferred_hook_type: 'transformation',
        setting_hint: 'inside a pro fighter\u2019s actual gym',
        endpoint_kinds: ['identity_dayend', 'body_quit'],
        implied_material_words: [],
    },
    {
        id: 'firefighter_shift_shadow',
        verb_past_phrase: 'Shadowed',
        verb_present_phrase: 'shadow',
        noun_subject_phrase: 'a firefighter crew',
        title_premise_line: 'I Shadowed A Firefighter Crew For An Entire {D} Shift',
        logline_action: 'shadow a full firehouse crew through every call, drill, meal, and nap across a real working shift',
        concrete_kind: 'duration',
        scales: ['12-hour', '24-hour', '48-hour'],
        body_parts: ['foot', 'shoulders', 'skin', 'stomach'],
        body_part_phrase: 'foot',
        sensation_words: ['foot', 'stomach', 'painful', 'bigger', 'numb', 'feeling'],
        first_frame_action: 'a firehouse bell ringing while crew members snap into the rig and I run in right behind them',
        visual_action_short: 'me stepping into gear next to the crew as the truck rolls out',
        action_intensity: 'high',
        safety_tier: 'safe',
        diversity_bucket: 'identity',
        preferred_hook_type: 'mystery',
        setting_hint: 'inside an active firehouse with full crew consent',
        endpoint_kinds: ['identity_dayend', 'body_quit'],
        implied_material_words: [],
    },
    // ── skill_dare bucket ────────────────────────────────────────────
    {
        id: 'learn_500_words_day',
        verb_past_phrase: 'Learned',
        verb_present_phrase: 'learn',
        noun_subject_phrase: 'words of a new language',
        title_premise_line: 'I Tried To Learn {N} Words Of A New Language In One Day — A Native Speaker Tested Me At The End',
        title_has_builtin_reveal: true,
        logline_action: 'drill flashcards in a language I don\u2019t speak from morning until night, then sit with a native speaker who quizzes every word',
        concrete_kind: 'reps',
        scales: [300, 500, 1000],
        body_parts: ['feeling', 'skin'],
        body_part_phrase: 'feeling',
        sensation_words: ['curious', 'feeling', 'bigger', 'painful', 'numb'],
        first_frame_action: 'a stack of flashcards with a single unfamiliar word on the top card and a count overlay at zero',
        visual_action_short: 'flashcards moving from an unknown-pile to a known-pile with a running tally',
        action_intensity: 'medium',
        safety_tier: 'safe',
        diversity_bucket: 'skill_dare',
        preferred_hook_type: 'transformation',
        setting_hint: 'at a kitchen table with a native speaker sitting opposite me at dusk',
        endpoint_kinds: ['exact_count', 'experiment_observation'],
        implied_material_words: [],
    },
    {
        id: 'learn_song_from_scratch',
        verb_past_phrase: 'Learned To Play',
        verb_present_phrase: 'learn to play',
        noun_subject_phrase: 'a full song on an instrument I\u2019ve never touched',
        title_premise_line: 'I Had {T} To Learn A Full Song On An Instrument I\u2019ve Never Touched — I Performed It For A Crowd',
        title_has_builtin_reveal: true,
        logline_action: 'pick up an instrument I\u2019ve never held and learn a complete song well enough to perform it for a real audience by the end',
        concrete_kind: 'duration',
        scales: ['1 day', '3 days', '7 days'],
        body_parts: ['skin', 'feeling'],
        body_part_phrase: 'hand',
        sensation_words: ['curious', 'painful', 'numb', 'bigger', 'feeling'],
        first_frame_action: 'hands touching the instrument for the very first time with a countdown label in frame',
        visual_action_short: 'a first awkward note progressing into a full clean phrase by the end',
        action_intensity: 'medium',
        safety_tier: 'safe',
        diversity_bucket: 'skill_dare',
        preferred_hook_type: 'transformation',
        setting_hint: 'in a practice room, ending on a small stage in front of a real crowd',
        endpoint_kinds: ['identity_dayend', 'time_to_target'],
        implied_material_words: [],
    },
];

for (const premiseAtom of OBJECT_MOTIFS) {
    if (!premiseAtom.title_core_tpl && premiseAtom.title_premise_line) premiseAtom.title_core_tpl = premiseAtom.title_premise_line;
    if (!premiseAtom.title_core_tpl_reps && premiseAtom.title_premise_line_reps) premiseAtom.title_core_tpl_reps = premiseAtom.title_premise_line_reps;
    if (!premiseAtom.title_premise_line && premiseAtom.title_core_tpl) premiseAtom.title_premise_line = premiseAtom.title_core_tpl;
    if (!premiseAtom.title_premise_line_reps && premiseAtom.title_core_tpl_reps) premiseAtom.title_premise_line_reps = premiseAtom.title_core_tpl_reps;
}

function getTitlePremiseLine(obj, concreteKind = null) {
    if (!obj) return '';
    if ((concreteKind || obj.concrete_kind) === 'pages' && obj.title_premise_line_reps) return obj.title_premise_line_reps;
    return obj.title_premise_line || obj.title_core_tpl || '';
}

const ENDPOINT_MOTIFS = [
    { id: 'exact_count',           kind: 'count',          reveal_label: 'the counter froze at' },
    { id: 'time_to_target',        kind: 'timer',          reveal_label: 'the timer froze at' },
    { id: 'exact_distance',        kind: 'distance',       reveal_label: 'the mile counter froze at' },
    { id: 'body_quit',             kind: 'body',           reveal_label: 'my body quit at' },
    // Non-numeric endpoints — the title premise line already carries the reveal frame,
    // so composeTitle returns the core as-is (no " — The Counter Froze At …" suffix).
    { id: 'transformation_reveal', kind: 'transformation', reveal_label: 'the before/after frame landed on' },
    { id: 'experiment_observation',kind: 'experiment',     reveal_label: 'the observation was' },
    { id: 'identity_dayend',       kind: 'identity',       reveal_label: 'the day ended with' },
    { id: 'build_test_outcome',    kind: 'build_test',     reveal_label: 'the build held until' },
];

// ──────────────────────────────────────────────────────────────────────
// Source-video seed path
// ──────────────────────────────────────────────────────────────────────
// Candidate pool: every video in signals-dataset.json (203 entries).
// Premise-spec assignment is fully dataset-derived:
//   - inferPremiseSpecFromVideo() deterministically infers {obj_id, endpoint_id}
//     from the exact validated source video title.
//   - selectPrimarySourceVideos() ranks exact dataset videos by quality_score.
//     No surrogate abstraction-layer dedup is allowed in primary source selection,
//     so every retained slot is chosen as a concrete validated video first.
//
// Selection: quality_score = z_score × retention/100 × keep/100.
// All dataset videos are ranked and deduped only by ytId; slice(0, N)
// draws the highest-performing source-video anchors. Same dataset → same
// output (deterministic).
//
// What remains predefined after this pass:
//   - ~1/2 of seeds still come from OBJECT_MOTIFS × scoreMotifCombo
//   - composeSeed produces the same structure regardless of path
//   - obj_id/endpoint_id still reference predefined premise atoms
//   - inferPremiseSpecFromVideo uses keyword rules (heuristic, not learned)
//   - source-video seeds still use those atoms internally, but downstream
//     balances them by exact source video instead of abstract buckets

// Deterministic premise-spec inference from a validated source video.
// Primary signal is title keywords; when title rules fall back to the generic
// default path, lightweight dataset metrics help disambiguate the endpoint.
function inferPremiseSpecFromVideo(video) {
    const t = ((video && video.name) || '').toLowerCase();
    const duration = Number(video && video.duration_s) || 0;
    const keep = Number(video && video.keep) || 0;
    const novelty = Number(video && video.novelty) || 0;
    const retentionPerSec = Number(video && video.retention_per_sec) || 0;

    let endpoint_id;
    let endpoint_source = 'title_default';
    if (/\b(days? without|didn'?t speak|no phone|no social|isolated|solitary|silent)\b/.test(t)) {
        endpoint_id = 'experiment_observation';
        endpoint_source = 'title_keyword';
    } else if (/\b\d+\s*days? (eating only|of only|on only)\b|only \w+ for \d+\s*days?/.test(t)) {
        endpoint_id = 'transformation_reveal';
        endpoint_source = 'title_keyword';
    } else if (/\b(trained like|became a bodybuilder|lived as|shadowed|survived .{0,20}training)\b/.test(t)) {
        endpoint_id = 'identity_dayend';
        endpoint_source = 'title_keyword';
    } else if (/\b\d[\d,]*\s*(pushups?|pull.?ups?|squats?|steps?|cranes?|coins?|reps?)\b/.test(t)) {
        endpoint_id = 'exact_count';
        endpoint_source = 'title_keyword';
    } else if (/\b\d+[\d.]*\s*(miles?|km|kilometers?)\b|marathon/.test(t)) {
        endpoint_id = 'exact_distance';
        endpoint_source = 'title_keyword';
    } else if (/\b(built?|made?|building|can (this|a|it)|will it|does it|stop a|cut through|proof|testing)\b/.test(t)) {
        endpoint_id = 'build_test_outcome';
        endpoint_source = 'title_keyword';
    } else if (/\bfor \d+ (hours?|minutes?)\b/.test(t)) {
        endpoint_id = 'time_to_target';
        endpoint_source = 'title_keyword';
    } else {
        endpoint_id = 'body_quit';
    }

    if (endpoint_source === 'title_default') {
        if (duration >= 45 && keep >= 70 && novelty >= 7) {
            endpoint_id = 'identity_dayend';
            endpoint_source = 'signal_fallback';
        } else if (duration >= 35 && retentionPerSec <= 3) {
            endpoint_id = 'experiment_observation';
            endpoint_source = 'signal_fallback';
        } else if (duration <= 22 && retentionPerSec >= 4) {
            endpoint_id = 'exact_count';
            endpoint_source = 'signal_fallback';
        } else if (duration <= 28 && novelty >= 8 && keep >= 75) {
            endpoint_id = 'build_test_outcome';
            endpoint_source = 'signal_fallback';
        }
    }

    let obj_id;
    let obj_source = 'endpoint_default';
    if (/push.?up/.test(t))                                         { obj_id = 'pushups_one_day'; obj_source = 'title_keyword'; }
    else if (/\bplank\b/.test(t))                                   { obj_id = 'plank_hold_hours'; obj_source = 'title_keyword'; }
    else if (/\bbackpack\b|ruck.?sack/.test(t))                     { obj_id = 'weighted_backpack_march'; obj_source = 'title_keyword'; }
    else if (/\bstair/.test(t))                                     { obj_id = 'stair_climb_repeats'; obj_source = 'title_keyword'; }
    else if (/jump.?rope|skipping rope/.test(t))                    { obj_id = 'jump_rope_day'; obj_source = 'title_keyword'; }
    else if (/\bsandbag\b/.test(t))                                 { obj_id = 'sandbag_carry'; obj_source = 'title_keyword'; }
    else if (/memorize|memoris/.test(t))                            { obj_id = 'memorize_book'; obj_source = 'title_keyword'; }
    else if (/\bletters?\b/.test(t))                                { obj_id = 'handwritten_letters'; obj_source = 'title_keyword'; }
    else if (/\bportrait/.test(t))                                  { obj_id = 'portrait_drawing_strangers'; obj_source = 'title_keyword'; }
    else if (/rubber.?band/.test(t))                                { obj_id = 'rubber_band_ball'; obj_source = 'title_keyword'; }
    else if (/origami|\bcrane/.test(t))                             { obj_id = 'origami_cranes'; obj_source = 'title_keyword'; }
    else if (/jigsaw|puzzle/.test(t))                               { obj_id = 'jigsaw_speedrun'; obj_source = 'title_keyword'; }
    else if (/\bcoin\b/.test(t))                                    { obj_id = 'coin_edge_tower'; obj_source = 'title_keyword'; }
    else if (/cardboard.{0,10}boat|boat.{0,10}cardboard/.test(t))  { obj_id = 'cardboard_boat_row'; obj_source = 'title_keyword'; }
    else if (/2x4|wooden.{0,5}bike|bike.{0,5}wood/.test(t))        { obj_id = 'two_by_four_bike'; obj_source = 'title_keyword'; }
    else if (/laser|bullet.?proof|bulletproof|\bshield\b|\barmor\b/.test(t)) { obj_id = 'two_by_four_bike'; obj_source = 'title_keyword'; }
    else if (/only \w+ for \d+\s*days?|ate only|eating only/.test(t)) { obj_id = 'one_food_thirty_days'; obj_source = 'title_keyword'; }
    else if (/mile every day|ran every day|daily.{0,5}mile/.test(t)) { obj_id = 'daily_mile_one_year'; obj_source = 'title_keyword'; }
    else if (/\bsilent\b|didn'?t speak/.test(t))                    { obj_id = 'silent_seven_days'; obj_source = 'title_keyword'; }
    else if (/\bphone\b|\bsmartphone\b/.test(t))                    { obj_id = 'phoneless_fortnight'; obj_source = 'title_keyword'; }
    else if (/\bboxer\b|\bboxing\b|\bmma\b/.test(t))                { obj_id = 'pro_boxer_day'; obj_source = 'title_keyword'; }
    else if (/firefighter|fireman/.test(t))                         { obj_id = 'firefighter_shift_shadow'; obj_source = 'title_keyword'; }
    else if (/\blanguage\b|\bwords of\b/.test(t))                   { obj_id = 'learn_500_words_day'; obj_source = 'title_keyword'; }
    else if (/\b(song|instrument|piano|guitar|violin|drums?)\b/.test(t)) { obj_id = 'learn_song_from_scratch'; obj_source = 'title_keyword'; }
    else {
        const ENDPOINT_OBJ_DEFAULTS = {
            exact_count:            'stair_climb_repeats',
            body_quit:              'pushups_one_day',
            exact_distance:         'weighted_backpack_march',
            time_to_target:         'plank_hold_hours',
            transformation_reveal:  'one_food_thirty_days',
            experiment_observation: 'phoneless_fortnight',
            identity_dayend:        'pro_boxer_day',
            build_test_outcome:     'cardboard_boat_row',
        };
        obj_id = ENDPOINT_OBJ_DEFAULTS[endpoint_id] || 'pushups_one_day';
        if (endpoint_source === 'signal_fallback') obj_source = 'signal_fallback';
    }

    return { obj_id, endpoint_id, endpoint_source, obj_source };
}

// Ranks all dataset videos by quality_score (z_score × retention/100 × keep/100).
// Every source-video assignment is inferred directly from the source video title,
// but selection is done on the exact source video rows themselves, not a
// surrogate abstraction-layer grouping.
function selectPrimarySourceVideos(dataset) {
    const scored = (dataset || []).filter(v => v.ytId).map(v => {
        const quality_score = round(
            (v.z_score || 0) * (v.retention || 0) / 100 * (v.keep || 0) / 100, 3
        );
        const spec = inferPremiseSpecFromVideo(v);
        return {
            spec: { ytId: v.ytId, ...spec },
            video: v,
            quality_score,
            source_selection_reason: `${spec.endpoint_source}:${spec.endpoint_id};${spec.obj_source}:${spec.obj_id}`,
        };
    }).sort((a, b) => b.quality_score - a.quality_score);

    const seenYtIds = new Set();
    return scored.filter(row => {
        if (seenYtIds.has(row.video.ytId)) return false;
        seenYtIds.add(row.video.ytId);
        return true;
    });
}

// Compose one source-video-derived seed. This keeps the existing premise/endpoint
// structure for compatibility, but the seed is explicitly grounded in a real
// validated video instead of a synthetic fallback slot.
function buildVideoDerivedSeed(spec, video, quality_score, source_reason, ctx, rank, seedPath, sourceRole) {
    const obj = OBJECT_MOTIFS.find(m => m.id === spec.obj_id);
    const endpoint = ENDPOINT_MOTIFS.find(e => e.id === spec.endpoint_id);
    if (!obj || !endpoint) return null;
    const scored = scoreMotifCombo(obj, endpoint, ctx);
    const seed = composeSeed(obj, endpoint, ctx, rank, scored.score, scored.drivers, {
        score: scored.creator_fit_score,
        drivers: scored.creator_fit_drivers,
        core_score: scored.core_score,
    }, {
        score: scored.proof_clarity_score,
        drivers: scored.proof_clarity_drivers,
    }, {
        score: scored.visual_legibility_score,
        drivers: scored.visual_legibility_drivers,
    }, video);
    if (seed.synthesis_trace) {
        seed.synthesis_trace.seed_path = seedPath;
        seed.synthesis_trace.diversity_bucket = video.ytId ? `video:${video.ytId}` : (obj.diversity_bucket || null);
        seed.synthesis_trace.diversity_bucket_source = video.ytId ? 'source_video' : 'premise_atom';
        seed.synthesis_trace.proof_surface = getProofSurfaceKey(obj);
        const lineage = {
            ytId: video.ytId,
            name: video.name,
            views: video.views,
            keep: video.keep,
            retention: video.retention,
            z_score: video.z_score,
            novelty: video.novelty != null ? video.novelty : null,
            quality_score,
            source_video_role: sourceRole,
            inferred_obj_id: spec.obj_id,
            inferred_endpoint_id: spec.endpoint_id,
            source_selection_reason: source_reason,
        };
        seed.synthesis_trace.source_video_lineage = lineage;
    }
    return seed;
}

// Generates seeds derived from specific validated videos in signals-dataset.json.
// Each seed carries synthesis_trace.seed_path='source_video_primary' and
// synthesis_trace.source_video_lineage with the original video's metrics.
function synthesizeVideoPrototypeSeeds(brief, artifacts, maxCount = 4) {
    const dataset = loadJsonSafe('signals-dataset.json');
    if (!dataset || !dataset.length) return [];
    const primarySourceVideos = selectPrimarySourceVideos(dataset).slice(0, maxCount);
    const ctx = deriveMotifContext(brief, artifacts);
    const seeds = [];
    for (const { spec, video, quality_score, source_selection_reason } of primarySourceVideos) {
        const seed = buildVideoDerivedSeed(spec, video, quality_score, source_selection_reason, ctx, seeds.length + 1, 'source_video_primary', 'primary');
        if (seed) seeds.push(seed);
    }
    return seeds;
}

// Backfill the remaining pool with additional validated videos from the
// dataset, rather than OBJECT_MOTIFS × ENDPOINT_MOTIFS fallback slots.
function synthesizeValidatedVideoSeeds(brief, artifacts, maxCount = 8, excludeYtIds = new Set()) {
    const dataset = loadJsonSafe('signals-dataset.json');
    if (!dataset || !dataset.length) return [];
    const ctx = deriveMotifContext(brief, artifacts);
    const candidates = (dataset || [])
        .filter(v => v && v.ytId && !excludeYtIds.has(v.ytId))
        .map(v => {
            const quality_score = round(
                (v.z_score || 0) * (v.retention || 0) / 100 * (v.keep || 0) / 100, 3
            );
            const spec = inferPremiseSpecFromVideo(v);
            return {
                spec: { ytId: v.ytId, ...spec },
                video: v,
                quality_score,
                source_selection_reason: `${spec.endpoint_source}:${spec.endpoint_id};${spec.obj_source}:${spec.obj_id}`,
            };
        })
        .sort((a, b) => b.quality_score - a.quality_score)
        .slice(0, maxCount * 3);

    const seeds = [];
    for (const row of candidates) {
        const seed = buildVideoDerivedSeed(row.spec, row.video, row.quality_score, row.source_selection_reason, ctx, seeds.length + 1, 'source_video_secondary', 'secondary');
        if (seed) seeds.push(seed);
        if (seeds.length >= maxCount) break;
    }
    return seeds;
}

// ──────────────────────────────────────────────────────────────────────
// Synthetic new-concept seed path
// ──────────────────────────────────────────────────────────────────────
// Generates NEW project ideas (not rewrites of existing source videos) by
// combining the corpus's strongest project patterns with validated IP anchors.
// Each synthetic seed:
//   - title follows Tyler's proven "Verb POWER_WORD IP Object" format
//     (impersonal framing r=+0.257, power word + object r=+0.203)
//   - is rejected if its tokens overlap >= 0.7 jaccard with any existing
//     signals-dataset.json title (so we never silently dupe a real video)
//   - flows through the same scoreMotifCombo pipeline as source-video seeds
//     (creator_fit, proof_clarity, visual_legibility, ip_anchor)
//   - tags synthesis_trace.seed_path='synthetic_new_concept' and writes a
//     synthetic_new_concept block citing the corpus pattern, the IP anchor,
//     the supporting indicators, and the duplicate-check result
//
// Patterns and IP anchors are NOT made up — every entry cites concrete
// signals-dataset.json videos and indicator-registry.json rows that
// validate the structure. Combinations not present in the corpus are
// generated; combinations that already exist are skipped.

const SYNTHETIC_NEW_CONCEPT_PATTERNS = [
    {
        id: 'indestructible_make',
        power_word: 'INDESTRUCTIBLE',
        verb_present: 'Making',
        verb_past: 'Made',
        test_action: 'tested with hammers, drops, and crushing weights on camera',
        first_frame: 'the finished {OBJECT} on a workbench surrounded by the tools that will test it',
        visual_action: 'hammers, drops, and crushing weights tested against the {OBJECT} while the camera holds on every impact',
        setting: 'in my workshop',
        evidence: 'signals-dataset.json: "Making INDESTRUCTIBLE armour" 285M views (top of corpus); "Testing INDESTRUCTIBLE Shoes" 34.1M; indicator_registry.playbook_2_indestructible_making 143.8M avg (~18x baseline, 80% hit rate at keep>75)',
        indicators: [
            'signals-dataset.json::indestructible_armour=285M views, keep=79.4',
            'indicator_registry.playbook_2_indestructible_making (143.8M avg, 80% hit rate)',
            'indicator_registry.making_x_tension r_partial=+0.351 (strongest single pre-upload signal)',
            'indicator_registry.making_superhero_synergy 2.57x synergy ratio, 20.4M avg',
        ],
    },
    {
        id: 'bulletproof_make',
        power_word: 'BULLETPROOF',
        verb_present: 'Making',
        verb_past: 'Made',
        test_action: 'firing real rounds at it on a controlled range',
        first_frame: 'the finished {OBJECT} mounted on a stand with the rifle and the impact backstop both in frame',
        visual_action: 'rounds being fired at the {OBJECT} while the camera holds on the impact surface after every shot',
        setting: 'in my workshop, then on a controlled outdoor range',
        evidence: 'signals-dataset.json: "How I made BULLETPROOF Batman Armour" 80.0M views, keep 84.6 — strongest single power_word + IP + object combo in the corpus',
        indicators: [
            'signals-dataset.json::bulletproof_batman_armour=80M views, keep=84.6',
            'indicator_registry.making_superhero_synergy 2.57x synergy ratio',
            'indicator_registry.superhero_build_best_converter 0.194% conversion (+73% vs vehicle/machine baseline)',
            'indicator_registry.superhero_category r=+0.159 vs log(views), +216% lift',
        ],
    },
    {
        id: 'fireproof_make',
        power_word: 'FIREPROOF',
        verb_present: 'Making',
        verb_past: 'Made',
        test_action: 'putting it through a controlled flamethrower test',
        first_frame: 'the finished {OBJECT} clamped in front of a flamethrower nozzle with the ignition trigger visible',
        visual_action: 'the flame on the {OBJECT} while the camera holds on the surface for charring or hold',
        setting: 'in my workshop, then at a controlled outdoor fire pit',
        evidence: 'signals-dataset.json: "Making FIREPROOF Batman Helmet" 18.1M views, keep 83.2; "Making a fire proof shield" 62.4M views, keep 78.3 — fireproof + protective wearable proven in corpus',
        indicators: [
            'signals-dataset.json::fireproof_batman_helmet=18.1M views, keep=83.2',
            'signals-dataset.json::fireproof_shield=62.4M views, keep=78.3',
            'indicator_registry.making_superhero_synergy 2.57x synergy ratio',
            'indicator_registry.superhero_build_best_converter 0.194% conversion',
        ],
    },
    {
        id: 'magnetic_climb',
        power_word: 'MAGNETIC',
        verb_present: 'Climbing With',
        verb_past: 'Climbed With',
        test_action: 'climbing a vertical steel wall with it on camera',
        first_frame: 'the {OBJECT} pressed onto the steel surface with my body weight beginning to lift off the ground',
        visual_action: 'climbing up a sheet-metal wall while the {OBJECT} holds at every step',
        setting: 'on a vertical steel sheet rigged for the test',
        evidence: 'signals-dataset.json: "Climbing with MAGNET Shoes" 55.2M views, keep 74.4; "How many magnets does it take to make me float?" 41.8M, keep 83.8 — magnet + wearable + capability demo proven in corpus',
        indicators: [
            'signals-dataset.json::magnet_shoes_climbing=55.2M views, keep=74.4',
            'signals-dataset.json::magnet_float=41.8M views, keep=83.8 (capability demo class)',
            'indicator_registry.superhero_build_best_converter 0.194% conversion',
            'indicator_registry.making_x_tension r_partial=+0.351',
        ],
        object_filter: ['gloves', 'boots', 'gauntlets', 'vest'],
    },
    {
        id: 'invincible_make',
        power_word: 'INVINCIBLE',
        verb_present: 'Making',
        verb_past: 'Made',
        test_action: 'every weapon I own against it in sequence',
        first_frame: 'the finished {OBJECT} on a stand with a wall of test weapons lined up behind it',
        visual_action: 'each weapon striking the {OBJECT} in sequence with the camera holding on the surface after every hit',
        setting: 'in my workshop, then on a controlled test range',
        evidence: 'signals-dataset.json: "INVINCIBLE armour" 4.3M views, keep 72.7 — underexplored vs INDESTRUCTIBLE; same playbook structure with fresh power-word framing',
        indicators: [
            'signals-dataset.json::invincible_armour=4.3M views (underexplored vs INDESTRUCTIBLE 285M)',
            'indicator_registry.playbook_2_indestructible_making (transferable to invincible variant)',
            'indicator_registry.making_x_tension r_partial=+0.351',
        ],
    },
];

const SYNTHETIC_NEW_CONCEPT_OBJECTS = [
    { word: 'Helmet',    body_part_phrase: 'head',      body_parts: ['head', 'face', 'skin'],      sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Armor',     body_part_phrase: 'body',      body_parts: ['body', 'chest', 'shoulders'], sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Shield',    body_part_phrase: 'arm',       body_parts: ['arm', 'shoulders', 'skin'],   sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Suit',      body_part_phrase: 'body',      body_parts: ['body', 'chest', 'shoulders'], sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Gloves',    body_part_phrase: 'hands',     body_parts: ['hands', 'fingers', 'skin'],   sensation_words: ['hands', 'painful', 'feeling'] },
    { word: 'Boots',     body_part_phrase: 'feet',      body_parts: ['feet', 'legs', 'skin'],       sensation_words: ['feet', 'painful', 'feeling'] },
    { word: 'Mask',      body_part_phrase: 'face',      body_parts: ['face', 'eyes', 'skin'],       sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Gauntlets', body_part_phrase: 'hands',     body_parts: ['hands', 'arms', 'skin'],      sensation_words: ['hands', 'painful', 'feeling'] },
    { word: 'Vest',      body_part_phrase: 'chest',     body_parts: ['chest', 'body', 'skin'],      sensation_words: ['painful', 'numb', 'feeling'] },
    { word: 'Cape',      body_part_phrase: 'shoulders', body_parts: ['shoulders', 'back', 'skin'],  sensation_words: ['painful', 'numb', 'feeling'] },
];

// IP anchors validated by indicator-registry.json (superhero_category +216%
// lift, making_superhero_synergy 2.57x) and the corpus IP_ANCHORS list.
// Order roughly reflects per-anchor corpus performance evidence.
const SYNTHETIC_NEW_CONCEPT_IP_ANCHORS = [
    { id: 'batman',          display: 'Batman',          evidence: 'signals-dataset.json: BULLETPROOF Batman Armour 80M + FIREPROOF Batman Helmet 18.1M — strongest IP × power-word combo in corpus' },
    { id: 'spider_man',      display: 'Spider-Man',      evidence: 'IP_ANCHORS validated franchise; indicator_registry.superhero_category r=+0.159 (+216% lift); underexplored in BULLETPROOF/MAGNETIC formats' },
    { id: 'iron_man',        display: 'Iron Man',        evidence: 'IP_ANCHORS validated franchise; indicator_registry.superhero_category notes explicitly name Iron Man' },
    { id: 'goku',            display: 'Goku',            evidence: 'signals-dataset.json: Walking 50,000 steps in Goku Shoes 21M, keep 81.4 — Goku × wearable proven in corpus' },
    { id: 'captain_america', display: 'Captain America', evidence: 'IP_ANCHORS validated franchise; signals-dataset fireproof shield 62.4M + IP-anchor 1.72x lift extends naturally to Captain America Shield' },
    { id: 'wolverine',       display: 'Wolverine',       evidence: 'IP_ANCHORS validated franchise; INDESTRUCTIBLE / adamantium narrative is the perfect alignment for indestructible_make pattern' },
    { id: 'mandalorian',     display: 'Mandalorian',     evidence: 'IP_ANCHORS validated franchise; beskar helmet/armor lore aligns directly with making playbook' },
    { id: 'thor',            display: 'Thor',            evidence: 'IP_ANCHORS validated franchise; armor/helmet/cape combos culturally aligned' },
];

const _SYNTH_DEDUP_STOP = new Set([
    'i', 'a', 'an', 'the', 'in', 'on', 'at', 'for', 'to', 'of', 'and', 'or',
    'my', 'it', 'is', 'with', 'this', 'that', 'how', 'when', 'one', 'made',
    'make', 'makes', 'making', 'did', 'do',
]);

function _syntheticTokenize(s) {
    return new Set(String(s || '').toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !_SYNTH_DEDUP_STOP.has(t)));
}

// Token-jaccard against every signals-dataset.json title. Anything at or
// above the threshold is rejected so a synthetic concept never silently
// duplicates a video Tyler has already shipped.
function syntheticTitleOverlap(syntheticTitle, dataset) {
    if (!dataset || !dataset.length) return { max_jaccard: 0, closest: null };
    const synTokens = _syntheticTokenize(syntheticTitle);
    if (!synTokens.size) return { max_jaccard: 0, closest: null };
    let maxJ = 0;
    let closest = null;
    for (const v of dataset) {
        if (!v || !v.name) continue;
        const vTokens = _syntheticTokenize(v.name);
        if (!vTokens.size) continue;
        let inter = 0;
        for (const t of synTokens) if (vTokens.has(t)) inter++;
        const union = synTokens.size + vTokens.size - inter;
        if (union <= 0) continue;
        const j = inter / union;
        if (j > maxJ) { maxJ = j; closest = v.name; }
    }
    return { max_jaccard: maxJ, closest };
}

function buildSyntheticTitle(pattern, ipAnchor, object) {
    return `${pattern.verb_present} ${pattern.power_word} ${ipAnchor.display} ${object.word}`;
}

function buildSyntheticObj(pattern, ipAnchor, object) {
    const objectLower = object.word.toLowerCase();
    const title = buildSyntheticTitle(pattern, ipAnchor, object);
    const objLabel = `${ipAnchor.display} ${objectLower}`;
    return {
        id: `synthetic__${pattern.id}__${ipAnchor.id}__${objectLower}`,
        verb_past_phrase: `${pattern.verb_past} ${pattern.power_word} ${ipAnchor.display} ${object.word}`,
        verb_present_phrase: `${pattern.verb_present.toLowerCase()} a ${pattern.power_word.toLowerCase()} ${objLabel}`,
        noun_subject_phrase: `a ${pattern.power_word.toLowerCase()} ${objLabel}`,
        title_premise_line: title,
        title_has_builtin_reveal: true,
        logline_action: `build a ${pattern.power_word.toLowerCase()} ${objLabel} from raw materials, then ${pattern.test_action} until the result is visibly resolved on camera`,
        concrete_kind: 'pieces',
        scales: [1],
        body_parts: object.body_parts,
        body_part_phrase: object.body_part_phrase,
        sensation_words: object.sensation_words,
        first_frame_action: pattern.first_frame.replace('{OBJECT}', objLabel),
        visual_action_short: pattern.visual_action.replace('{OBJECT}', objLabel),
        action_intensity: 'high',
        safety_tier: 'safe',
        diversity_bucket: 'build_test',
        preferred_hook_type: 'transformation',
        setting_hint: pattern.setting,
        endpoint_kinds: ['build_test_outcome'],
        implied_material_words: [],
    };
}

// Generates seeds from corpus pattern × IP anchor × object combinations
// that DON'T already exist in signals-dataset.json. Each seed is scored
// through scoreMotifCombo (same path as source-video seeds) and tagged
// with synthesis_trace.seed_path='synthetic_new_concept' plus a
// synthetic_new_concept block citing the corpus pattern, IP anchor,
// supporting indicators, and the duplicate-check result.
function synthesizeSyntheticNewConceptSeeds(brief, artifacts, maxCount = 4) {
    if (maxCount <= 0) return [];
    const dataset = (artifacts && artifacts.signals) || loadJsonSafe('signals-dataset.json') || [];
    const ctx = deriveMotifContext(brief, artifacts);
    const buildTestEndpoint = ENDPOINT_MOTIFS.find(e => e.id === 'build_test_outcome');
    if (!buildTestEndpoint) return [];

    const candidates = [];
    for (const pattern of SYNTHETIC_NEW_CONCEPT_PATTERNS) {
        for (const ipAnchor of SYNTHETIC_NEW_CONCEPT_IP_ANCHORS) {
            for (const object of SYNTHETIC_NEW_CONCEPT_OBJECTS) {
                if (pattern.object_filter && !pattern.object_filter.includes(object.word.toLowerCase())) continue;
                const synthObj = buildSyntheticObj(pattern, ipAnchor, object);
                const overlap = syntheticTitleOverlap(synthObj.title_premise_line, dataset);
                if (overlap.max_jaccard >= 0.7) continue;
                const scored = scoreMotifCombo(synthObj, buildTestEndpoint, ctx);
                candidates.push({ synthObj, scored, overlap, pattern, ipAnchor, object });
            }
        }
    }

    candidates.sort((a, b) => b.scored.score - a.scored.score);

    // Per-(pattern,object), per-pattern, and per-IP caps so the synthetic pool
    // surfaces varied power-words and IP anchors instead of stacking the same
    // pattern across every object slot. Per-IP cap=1 forces fresh IPs until
    // every IP has been used; per-pattern cap is small (max 2) so the pool
    // distributes across power-word patterns rather than sweeping all objects
    // for one pattern. The final MMR re-rank in generateIdeas uses
    // diversity_bucket=`synthetic__${pattern_id}` to apply the same pressure
    // when assembling the top-N output slate.
    const seeds = [];
    const usedPatternObject = new Map();
    const usedPattern = new Map();
    const usedIp = new Map();
    const patternCap = 2;
    const ipCap = 1;
    for (const cand of candidates) {
        if (seeds.length >= maxCount) break;
        const poKey = `${cand.pattern.id}__${cand.object.word.toLowerCase()}`;
        if ((usedPatternObject.get(poKey) || 0) >= 1) continue;
        if ((usedPattern.get(cand.pattern.id) || 0) >= patternCap) continue;
        if ((usedIp.get(cand.ipAnchor.id) || 0) >= ipCap) continue;
        const seed = composeSeed(
            cand.synthObj,
            buildTestEndpoint,
            ctx,
            seeds.length + 1,
            cand.scored.score,
            cand.scored.drivers,
            { score: cand.scored.creator_fit_score, drivers: cand.scored.creator_fit_drivers, core_score: cand.scored.core_score },
            { score: cand.scored.proof_clarity_score, drivers: cand.scored.proof_clarity_drivers },
            { score: cand.scored.visual_legibility_score, drivers: cand.scored.visual_legibility_drivers },
            null,
        );
        if (!seed) continue;
        if (seed.synthesis_trace) {
            seed.synthesis_trace.seed_path = 'synthetic_new_concept';
            seed.synthesis_trace.diversity_bucket = `synthetic__${cand.pattern.id}`;
            seed.synthesis_trace.diversity_bucket_source = 'synthetic_new_concept';
            seed.synthesis_trace.proof_surface = getProofSurfaceKey(cand.synthObj);
            seed.synthesis_trace.synthetic_new_concept = {
                pattern_id: cand.pattern.id,
                power_word: cand.pattern.power_word,
                title_verb: cand.pattern.verb_present,
                ip_anchor_id: cand.ipAnchor.id,
                ip_anchor_display: cand.ipAnchor.display,
                object_word: cand.object.word,
                body_anchor: cand.object.body_part_phrase,
                source_pattern_evidence: cand.pattern.evidence,
                ip_anchor_evidence: cand.ipAnchor.evidence,
                supporting_indicators: cand.pattern.indicators,
                title_format_evidence: 'impersonal "Verb POWER_WORD IP Object" framing (r=+0.257 impersonal title, r=+0.203 power-word + object) — proven format for top-of-corpus videos like "Making INDESTRUCTIBLE armour" (285M) and "How I made BULLETPROOF Batman Armour" (80M)',
                duplicate_check: {
                    closest_existing_title: cand.overlap.closest,
                    max_jaccard_to_existing: round(cand.overlap.max_jaccard, 3),
                    rejection_threshold: 0.7,
                    note: 'Generated title was checked for token-jaccard against every signals-dataset.json title; passed because max overlap was below the duplicate-rejection threshold — this is a NEW project, not a rewrite of an existing video.',
                },
                derivation_path: 'corpus pattern (power-word + protective wearable + workshop framing, validated by signals-dataset top performers) × indicator-validated IP anchor (indicator_registry.superhero_category +216% lift, IP-anchored 1.72x view lift) × object slot — combined into the impersonal "Verb POWER_WORD IP Object" title format proven by signals-dataset top performers',
            };
        }
        usedPatternObject.set(poKey, (usedPatternObject.get(poKey) || 0) + 1);
        usedPattern.set(cand.pattern.id, (usedPattern.get(cand.pattern.id) || 0) + 1);
        usedIp.set(cand.ipAnchor.id, (usedIp.get(cand.ipAnchor.id) || 0) + 1);
        seeds.push(seed);
    }

    // If per-IP cap starved the pool below the target (more synthetic slots
    // remain than fresh IPs), relax the IP cap and fill the rest from the
    // remaining candidates. (pattern-object dedup is still respected so we
    // never emit two seeds with the exact same pattern+object combination.)
    if (seeds.length < maxCount) {
        for (const cand of candidates) {
            if (seeds.length >= maxCount) break;
            const poKey = `${cand.pattern.id}__${cand.object.word.toLowerCase()}`;
            if ((usedPatternObject.get(poKey) || 0) >= 1) continue;
            if ((usedPattern.get(cand.pattern.id) || 0) >= patternCap) continue;
            const seed = composeSeed(
                cand.synthObj,
                buildTestEndpoint,
                ctx,
                seeds.length + 1,
                cand.scored.score,
                cand.scored.drivers,
                { score: cand.scored.creator_fit_score, drivers: cand.scored.creator_fit_drivers, core_score: cand.scored.core_score },
                { score: cand.scored.proof_clarity_score, drivers: cand.scored.proof_clarity_drivers },
                { score: cand.scored.visual_legibility_score, drivers: cand.scored.visual_legibility_drivers },
                null,
            );
            if (!seed) continue;
            if (seed.synthesis_trace) {
                seed.synthesis_trace.seed_path = 'synthetic_new_concept';
                seed.synthesis_trace.diversity_bucket = `synthetic__${cand.pattern.id}`;
                seed.synthesis_trace.diversity_bucket_source = 'synthetic_new_concept';
                seed.synthesis_trace.proof_surface = getProofSurfaceKey(cand.synthObj);
                seed.synthesis_trace.synthetic_new_concept = {
                    pattern_id: cand.pattern.id,
                    power_word: cand.pattern.power_word,
                    title_verb: cand.pattern.verb_present,
                    ip_anchor_id: cand.ipAnchor.id,
                    ip_anchor_display: cand.ipAnchor.display,
                    object_word: cand.object.word,
                    body_anchor: cand.object.body_part_phrase,
                    source_pattern_evidence: cand.pattern.evidence,
                    ip_anchor_evidence: cand.ipAnchor.evidence,
                    supporting_indicators: cand.pattern.indicators,
                    title_format_evidence: 'impersonal "Verb POWER_WORD IP Object" framing (r=+0.257 impersonal title, r=+0.203 power-word + object) — proven format for top-of-corpus videos like "Making INDESTRUCTIBLE armour" (285M) and "How I made BULLETPROOF Batman Armour" (80M)',
                    duplicate_check: {
                        closest_existing_title: cand.overlap.closest,
                        max_jaccard_to_existing: round(cand.overlap.max_jaccard, 3),
                        rejection_threshold: 0.7,
                        note: 'Generated title was checked for token-jaccard against every signals-dataset.json title; passed because max overlap was below the duplicate-rejection threshold — this is a NEW project, not a rewrite of an existing video.',
                    },
                    derivation_path: 'corpus pattern (power-word + protective wearable + workshop framing, validated by signals-dataset top performers) × indicator-validated IP anchor (indicator_registry.superhero_category +216% lift, IP-anchored 1.72x view lift) × object slot — combined into the impersonal "Verb POWER_WORD IP Object" title format proven by signals-dataset top performers',
                    backfill_pass: true,
                };
            }
            usedPatternObject.set(poKey, (usedPatternObject.get(poKey) || 0) + 1);
            usedPattern.set(cand.pattern.id, (usedPattern.get(cand.pattern.id) || 0) + 1);
            usedIp.set(cand.ipAnchor.id, (usedIp.get(cand.ipAnchor.id) || 0) + 1);
            seeds.push(seed);
        }
    }

    return seeds;
}

// Mix validated source-video seeds with synthetic new-concept seeds in a
// rough 2:1 ratio so synthetic ideas surface alongside grounded ones. Two
// validated, then one synthetic, repeat until either pool runs out.
function mixValidatedAndSyntheticSeeds(validatedSeeds, syntheticSeeds, maxCount) {
    if (!syntheticSeeds.length) return validatedSeeds.slice(0, maxCount);
    if (!validatedSeeds.length) return syntheticSeeds.slice(0, maxCount);
    const result = [];
    let vi = 0, si = 0;
    while (result.length < maxCount && (vi < validatedSeeds.length || si < syntheticSeeds.length)) {
        if (vi < validatedSeeds.length && result.length < maxCount) result.push(validatedSeeds[vi++]);
        if (vi < validatedSeeds.length && result.length < maxCount) result.push(validatedSeeds[vi++]);
        if (si < syntheticSeeds.length && result.length < maxCount) result.push(syntheticSeeds[si++]);
    }
    return result;
}

// Interleave primary source-video seeds with secondary validated-video seeds in a 2:1
// ratio so the pool stays grounded in exact validated sources throughout.
function interleaveSeeds(vpSeeds, secondarySeeds, maxCount) {
    if (!vpSeeds.length) return secondarySeeds.slice(0, maxCount);
    const result = [];
    let vi = 0, si = 0;
    while (result.length < maxCount) {
        if (vi < vpSeeds.length) result.push(vpSeeds[vi++]);
        if (result.length < maxCount && vi < vpSeeds.length) result.push(vpSeeds[vi++]);
        if (result.length < maxCount && si < secondarySeeds.length) result.push(secondarySeeds[si++]);
        if (vi >= vpSeeds.length) {
            while (result.length < maxCount && si < secondarySeeds.length) result.push(secondarySeeds[si++]);
            break;
        }
    }
    return result;
}

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

// ──────────────────────────────────────────────────────────────────────
// Creator-fit / production-fit score (v3.2)
//
// Biases toward the strongest maker/body/workshop DNA already present in
// the evidence corpus — NOT hand-curated Tyler taste. Every weight is
// justified by an on-disk indicator:
//   - making/build/test/construct framing   → findings.kept_signals.pat_making_v2
//                                               (delta_r2=+0.012; 34 videos avg 19.7M vs 5.6M)
//                                              + proven_discoveries.title_making_keyword
//                                               ('Making' = $24M avg across 23 videos)
//   - workshop/object/hands-visible framing → indicator_registry.visual_is_workshop
//                                               (r_direct=+0.236, r_partial=+0.219, 42/203 pos 2.6x)
//                                              + pre_workshop_x_making (r_partial=+0.229)
//                                              + tension_x_workshop (r_partial=+0.283)
//   - sensory/body > technical/jargon       → retention-patterns.top_3_peak_causes
//                                               .PHYSICAL_SENSORY_LANGUAGE (sensory-rate weight +1.59)
//                                              vs .top_3_drop_causes
//                                               .TECHNICAL_MATERIAL_LANGUAGE (plastic=-0.171 etc)
//   - feasible-on-camera proof moments      → top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES
//                                               (action frames 28% at peaks vs 8% at drops)
//                                              + wave11_12.end_begin_ratio / title_making_keyword
//                                               (single-shot visible-proof payoff structure)
//
// Every driver returned exposes the indicator(s) it was justified against.
function computeCreatorFit(obj, endpoint, ctx) {
    const drivers = [];
    let score = 0;

    const titleTpl = String(getTitlePremiseLine(obj)).toLowerCase();
    const verbPast = String(obj.verb_past_phrase || '').toLowerCase();
    const setting = String(obj.setting_hint || '').toLowerCase();
    const visual = String(obj.visual_action_short || '').toLowerCase();
    const firstFrame = String(obj.first_frame_action || '').toLowerCase();
    const bodyParts = obj.body_parts || [];
    const senseWords = obj.sensation_words || [];
    const impliedMat = obj.implied_material_words || [];
    const positiveWords = ctx.positiveWords || new Set();
    const negativeWords = ctx.negativeWords || new Set();

    // 1. Title-level making / build / test / construct keyword
    //    pat_making_v2 and title_making_keyword are TITLE-level patterns —
    //    the transcript-level negative delta on "built" (-0.095) lives in a
    //    different axis (say it in the spoken body and it hurts retention;
    //    have it in the title and the video averages 19.7M vs 5.6M).
    const MAKING_TITLE_RE = /\b(built|build|making|made|make|creat|construct|test|folded|stacked|wrote|drew|drew portraits|solved|rowed|rode)\b/;
    const titleMatch = titleTpl.match(MAKING_TITLE_RE);
    const verbMatch = verbPast.match(MAKING_TITLE_RE);
    if (titleMatch || verbMatch) {
        const d = 0.28;
        score += d;
        drivers.push({
            driver: 'title_making_keyword_match',
            delta: d,
            matched: (titleMatch && titleMatch[0]) || (verbMatch && verbMatch[0]),
            source: 'findings.kept_signals.pat_making_v2 (delta_r2=+0.012; 34 videos avg 19.7M vs 5.6M) + proven_discoveries.title_making_keyword ($24M avg, 23 videos)',
        });
    }

    // 2. Workshop / tactile / hands-visible frame
    //    Two sub-signals, each evidenced by an indicator-registry row.
    //    Setting regex matches fixed hands-on environments; visual regex
    //    matches hand-driven action verbs in the premise copy.
    const WORKSHOP_SETTING_RE = /\b(desk|table|counter|garage|workbench|firehouse|practice room|puzzle table|stairwell|gym|kitchen|flooring)\b/;
    const HANDS_VISIBLE_RE = /\b(hand|fingers|folding|stacking|wrapping|drawing|writing|tightening|taping|sliding|placing|pressing|stretching|flipping|checkmarks|fold|wrap|slide|press|draw|writ|tape|tighten|stack|place)\b/;
    const workshopSetting = WORKSHOP_SETTING_RE.test(setting);
    const handsVisible = HANDS_VISIBLE_RE.test(visual) || HANDS_VISIBLE_RE.test(firstFrame);
    if (workshopSetting || handsVisible) {
        const both = workshopSetting && handsVisible;
        const d = both ? 0.28 : 0.18;
        score += d;
        drivers.push({
            driver: `workshop_frame_fit${workshopSetting ? '_setting' : ''}${handsVisible ? '_hands' : ''}`,
            delta: d,
            source: 'indicator_registry.visual_is_workshop r_direct=+0.236 (42/203 pos, 2.6x); pre_workshop_x_making r_partial=+0.229; tension_x_workshop r_partial=+0.283',
        });
    }

    // 3. Generic-outdoor / abstract-framing penalty (inverse of workshop fit)
    //    Triggered only when setting reads as roaming outdoor OR abstract
    //    experience AND no workshop/hands signal was found.
    const GENERIC_OUTDOOR_RE = /\b(long stretch of road|on a marked road|on pavement|on a driveway|on the street|on a closed empty parking lot|neighborhood loop|one-mile neighborhood loop|calm shallow lake)\b/;
    const ABSTRACT_RE = /\b(everyday errands|at work|fill the hours|around my neighborhood|at home, at work)\b/;
    const genericOutdoor = GENERIC_OUTDOOR_RE.test(setting);
    const abstract = ABSTRACT_RE.test(setting) || ABSTRACT_RE.test(visual);
    if ((genericOutdoor || abstract) && !workshopSetting && !handsVisible) {
        const d = -0.18;
        score += d;
        drivers.push({
            driver: abstract ? 'abstract_setting_penalty' : 'generic_outdoor_no_object_penalty',
            delta: d,
            source: 'inverse of visual_is_workshop (r=+0.236); HIGH_ENERGY_ACTION_FRAMES peak cause favors tactile fixed framing over roaming outdoor',
        });
    }

    // 4. Proof-on-body alignment — body_parts × positive-word list + sensation × positive
    const bodyHits = bodyParts.filter(b => positiveWords.has(b));
    const senseHits = senseWords.filter(s => positiveWords.has(s));
    const proofDelta = round(bodyHits.length * 0.035 + senseHits.length * 0.015, 3);
    if (proofDelta > 0) {
        score += proofDelta;
        drivers.push({
            driver: `proof_on_body_alignment_${bodyHits.length}bp_${senseHits.length}sw`,
            delta: proofDelta,
            body_hits: bodyHits,
            sense_hits: senseHits,
            source: 'top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE (sensory-rate regression weight +1.59; per-word positive deltas +0.04-0.06 above-baseline in word-retention-impact.json)',
        });
    }

    // 5. Technical/material exposure penalty — or a small credit when the
    //    premise is tactile yet does NOT trigger the drop-cause word list.
    const matHits = impliedMat.filter(w => negativeWords.has(w));
    if (matHits.length) {
        const d = round(-0.25 * matHits.length, 3);
        score += d;
        drivers.push({
            driver: 'technical_material_exposure_penalty',
            delta: d,
            words: matHits,
            source: 'top_3_drop_causes.TECHNICAL_MATERIAL_LANGUAGE (plastic=-0.171, solid=-0.163, materials=-0.136 above-baseline)',
        });
    } else if (workshopSetting || handsVisible) {
        const d = 0.06;
        score += d;
        drivers.push({
            driver: 'workshop_without_material_naming',
            delta: d,
            source: 'tactile frame preserved without triggering TECHNICAL_MATERIAL_LANGUAGE drop cause — sensory > technical axis',
        });
    }

    // 6. Feasibility / proof-clarity — endpoint readable in a single shot
    if (endpoint.kind === 'count' || endpoint.kind === 'timer' || endpoint.kind === 'distance') {
        const d = 0.07;
        score += d;
        drivers.push({
            driver: `feasibility_numeric_counter_endpoint_${endpoint.kind}`,
            delta: d,
            source: 'HIGH_ENERGY_ACTION_FRAMES peak cause + wave11_12.end_begin_ratio (numeric counter freeze = single-shot visible payoff)',
        });
    } else if (endpoint.kind === 'transformation' || endpoint.kind === 'build_test') {
        const d = 0.10;
        score += d;
        drivers.push({
            driver: `feasibility_visible_transformation_endpoint_${endpoint.kind}`,
            delta: d,
            source: 'title_making_keyword ($24M avg for build/test format) + wave11_12.end_begin_ratio (single-shot before/after or build-until-fail visible payoff)',
        });
    }

    // 7. Logistically diffuse setting penalty (multi-location / abstract)
    const DIFFUSE_RE = /\b(everyday errands|every errand|at work|on public transit|fill the hours|around my neighborhood|at home, at work)\b/;
    if (DIFFUSE_RE.test(setting)) {
        const d = -0.08;
        score += d;
        drivers.push({
            driver: 'logistically_diffuse_setting_penalty',
            delta: d,
            source: 'visual_is_workshop r=+0.236 favors a fixed familiar environment over roaming multi-location shoots',
        });
    }

    return { score: round(score, 3), drivers };
}

// ──────────────────────────────────────────────────────────────────────
// Proof-clarity / mechanism-visibility score (v3.3)
//
// Biases toward ideas whose on-camera PROOF MOMENT is single-frame
// legible — the pattern Tyler flagged: hand-writing 300 letters is
// specific but the payoff is a stack whose content is untestable; a
// cardboard boat that rows across a lake OR a potato-only diet with a
// daily weigh-in both land single-shot visible proof.
//
// Every driver cites an on-disk indicator:
//   - build-test hybrids (verb "built … and rowed/rode/drove …")
//       → findings.proven_discoveries.title_making_keyword ($24M avg)
//         + top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES (28% at peaks
//         vs 8% at drops — action frames ARE the proof moment)
//         + wave11_12.end_begin_ratio (single-shot before/after payoff)
//   - body-transformation with explicit before/after anchor
//       → bucket=body_transformation + weigh-in / same-starting-frame
//         language → wave11_12.end_begin_ratio
//   - single-frame numeric endpoint (count / timer / distance)
//       → HIGH_ENERGY_ACTION_FRAMES + end_begin_ratio (the freeze-frame
//         IS the proof shot)
//   - named physical artifact in the premise's first_frame_action /
//     visual_action_short (counter, stack, tower, bar, scale, overlay)
//       → HIGH_ENERGY_ACTION_FRAMES (visible artifact in frame)
// Inverse rewards (penalties):
//   - mystery_experiment / identity endpoint with NO named artifact
//     (silent week, phoneless fortnight)
//       → inverse of HIGH_ENERGY_ACTION_FRAMES + inverse of end_begin_ratio
//         (payoff is an observation, not a shot)
//   - repetition_outreach bucket without a physical-test verb (letters,
//     portrait stacks)
//       → stack-of-envelopes is visible but the CONTENT is untestable —
//         lower end_begin_ratio than build-then-test or body change
//   - cognitive / head-framed payoff with action_intensity=low (memorize
//     book, silent)
//       → inverse of HIGH_ENERGY_ACTION_FRAMES and PHYSICAL_SENSORY_LANGUAGE
//
// The score is added to the combo score so the slate-balancing selector
// and the final blueprint re-rank both reward proof-clarity within each
// premise lane. No hand-picked top-5 list — every weight reads
// a factual field on the premise atom and cites a corpus indicator.
function computeProofClarity(obj, endpoint, ctx) {
    const drivers = [];
    let score = 0;

    const bucketKey = String(obj.diversity_bucket || '').toLowerCase();
    const titleTpl = String(getTitlePremiseLine(obj)).toLowerCase();
    const logline = String(obj.logline_action || '').toLowerCase();
    const firstFrame = String(obj.first_frame_action || '').toLowerCase();
    const visual = String(obj.visual_action_short || '').toLowerCase();
    const bodyPart = String(obj.body_part_phrase || '').toLowerCase();
    const allText = `${titleTpl} ${logline} ${firstFrame} ${visual}`;

    // A. Build-test hybrid detection — premise copy contains BOTH a build
    //    verb and a physical-test verb. This unifies make + test in one
    //    shoot; the strongest visible-proof pattern in the corpus.
    const BUILD_VERB_RE = /\b(built|build|made|make|constructed|construct|welded|assembled|rigged|crafted|hand-built)\b/;
    const TEST_VERB_RE = /\b(rowed|row|rode|ride|drove|drive|launched|sailed|flew|flown|fired|tested|test|raced|race|broke|holds until|gives|performs|performed|rowing|riding|driving)\b/;
    const hasBuildVerb = BUILD_VERB_RE.test(allText);
    const hasTestVerb = TEST_VERB_RE.test(allText);
    if (hasBuildVerb && hasTestVerb) {
        const d = 0.38;
        score += d;
        drivers.push({
            driver: 'build_test_hybrid_in_premise_copy',
            delta: d,
            matched_build_verb: (allText.match(BUILD_VERB_RE) || [])[0],
            matched_test_verb: (allText.match(TEST_VERB_RE) || [])[0],
            source: 'proven_discoveries.title_making_keyword ($24M avg, 23 videos) + top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops) + wave11_12.end_begin_ratio (single-shot visible payoff)',
        });
    }

    // B. Body-transformation with a concrete single-shot proof anchor
    //    (weigh-in / same starting frame / before-after / same shot).
    const BODY_PROOF_ANCHOR_RE = /\b(weigh-in|weigh in|weigh|scale|same starting frame|same shot|before\/after|morning weigh-?in|same driveway|same kitchen counter|day \d+ vs|first and last run|first and last)\b/;
    const isBodyBucket = bucketKey === 'body_transformation';
    const hasBodyProof = BODY_PROOF_ANCHOR_RE.test(allText);
    if (isBodyBucket && hasBodyProof) {
        const d = 0.32;
        score += d;
        drivers.push({
            driver: 'body_transformation_with_proof_anchor',
            delta: d,
            matched_anchor: (allText.match(BODY_PROOF_ANCHOR_RE) || [])[0],
            source: 'premise lane=body_transformation AND premise copy names a before/after anchor — wave11_12.end_begin_ratio (single-frame before/after payoff structure)',
        });
    } else if (isBodyBucket) {
        const d = 0.12;
        score += d;
        drivers.push({
            driver: 'body_transformation_without_proof_anchor',
            delta: d,
            source: 'premise lane=body_transformation but premise copy lacks a single-shot before/after anchor — partial end_begin_ratio credit',
        });
    }

    // C. Single-frame numeric endpoint (counter / timer / distance)
    //    — the freeze-frame IS the proof. Transformation / build_test
    //    endpoints carry their own proof via A / B above.
    if (endpoint.kind === 'count' || endpoint.kind === 'timer' || endpoint.kind === 'distance') {
        const d = 0.22;
        score += d;
        drivers.push({
            driver: `single_frame_numeric_endpoint_${endpoint.kind}`,
            delta: d,
            source: 'top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES + wave11_12.end_begin_ratio — numeric counter freeze is single-shot legible proof',
        });
    } else if (endpoint.kind === 'transformation' || endpoint.kind === 'build_test') {
        const d = 0.14;
        score += d;
        drivers.push({
            driver: `single_shot_qualitative_endpoint_${endpoint.kind}`,
            delta: d,
            source: 'wave11_12.end_begin_ratio — qualitative reveal is single-shot legible when premise copy names a concrete artifact (scored in D)',
        });
    }

    // D. Named physical artifact / overlay in the premise's first_frame or
    //    visual_action_short — proof object is in frame.
    const ARTIFACT_PROOF_RE = /\b(stack|pile|tower|counter|overlay|completion bar|completion %|distance overlay|mile-counter|mile counter|timer overlay|page tally|page grid|finished stack|weigh|scale|ruler|height ruler|envelope|addressed envelopes|finished portraits|crane pile|puzzle pieces|coins|band counter|hull|oars|pedals|bike frame|step-?by-?step)\b/;
    const hasArtifact = ARTIFACT_PROOF_RE.test(allText);
    if (hasArtifact) {
        const d = 0.12;
        score += d;
        drivers.push({
            driver: 'physical_artifact_or_overlay_in_frame',
            delta: d,
            matched_artifact: (allText.match(ARTIFACT_PROOF_RE) || [])[0],
            source: 'first_frame_action / visual_action_short names a physical artifact or overlay — HIGH_ENERGY_ACTION_FRAMES peak cause (artifact visible in the proof shot)',
        });
    }

    // E. Abstract-payoff penalty — experiment / identity endpoint with
    //    no artifact described. Proof requires context or trust.
    //    (v3.4: penalty strengthened -0.25 → -0.38 — observation-only
    //    payoffs were still surviving diversity selection.)
    const abstractEndpoint = endpoint.kind === 'experiment' || endpoint.kind === 'identity';
    if (abstractEndpoint && !hasArtifact) {
        const d = -0.38;
        score += d;
        drivers.push({
            driver: `abstract_payoff_no_artifact_${endpoint.kind}`,
            delta: d,
            source: 'endpoint is experiment/identity and no single-frame artifact is named — inverse of HIGH_ENERGY_ACTION_FRAMES + inverse of end_begin_ratio (payoff reads only with context)',
        });
    }

    // F. Cognitive / head-framed payoff.
    //    (v3.4: dropped the action_intensity=low gate — cognitive body
    //    framing is invisible on camera regardless of hand activity, so
    //    the old gate let medium-intensity cognitive premises like language
    //    drills slip past. Penalty bumped -0.14 → -0.24.)
    const COGNITIVE_BODY_PARTS_PC = new Set(['head', 'feeling', 'mind', 'brain', 'memory']);
    if (COGNITIVE_BODY_PARTS_PC.has(bodyPart)) {
        const d = -0.24;
        score += d;
        drivers.push({
            driver: `low_visual_cognitive_body_part_${bodyPart}`,
            delta: d,
            source: 'body_part_phrase ∈ {head, feeling, mind, brain, memory} — inverse of HIGH_ENERGY_ACTION_FRAMES + PHYSICAL_SENSORY_LANGUAGE (cognitive change has no legible body surface regardless of action intensity)',
        });
    }

    // G. repetition_outreach / repetition_patience bucket without a
    //    physical-test verb: proof is a stack whose contents are
    //    untestable to the viewer. (v3.4: -0.18 → -0.26.)
    if ((bucketKey === 'repetition_outreach' || bucketKey === 'repetition_patience') && !hasTestVerb) {
        const d = -0.26;
        score += d;
        drivers.push({
            driver: `${bucketKey}_without_physical_test_verb`,
            delta: d,
            source: 'premise lane=repetition_outreach/patience AND no test verb — proof is a stack, not a test; lower end_begin_ratio than build_test / body_transformation premises',
        });
    }

    // H. Mystery_experiment bucket without artifact — observation, not
    //    a shot. Stacks with E but the bucket-level signal is cleaner.
    //    (v3.4: -0.18 → -0.28.)
    if (bucketKey === 'mystery_experiment' && !hasArtifact) {
        const d = -0.28;
        score += d;
        drivers.push({
            driver: 'mystery_experiment_without_artifact',
            delta: d,
            source: 'premise lane=mystery_experiment AND no artifact in frame — inverse of HIGH_ENERGY_ACTION_FRAMES (payoff is an observation)',
        });
    }

    // I. Body-transformation OR build_test lane × active intensity —
    //    combo bonus when the premise lane ALREADY implies a visible
    //    proof axis AND the daily act is itself filmable physical action.
    if ((isBodyBucket || bucketKey === 'build_test') && (obj.action_intensity === 'medium' || obj.action_intensity === 'high')) {
        const d = 0.08;
        score += d;
        drivers.push({
            driver: `${bucketKey}_with_active_intensity`,
            delta: d,
            source: 'premise lane=body_transformation|build_test AND action_intensity ≥ medium — PHYSICAL_SENSORY_LANGUAGE + HIGH_ENERGY_ACTION_FRAMES stack (daily act itself is visible action)',
        });
    }

    // J. Object-interaction signal — HANDS_VISIBLE regex over
    //    first_frame + visual. Distinguishes premises where the viewer
    //    watches hands manipulate something from premises where the
    //    viewer watches a person react (silent, phoneless, boxer-shadow).
    const HANDS_VISIBLE_RE = /\b(hand|fingers|folding|stacking|wrapping|drawing|writing|tightening|taping|sliding|placing|pressing|stretching|flipping|checkmarks|fold|wrap|slide|press|draw|writ|tape|tighten|stack|place|rowing|pedaling|climbing|carrying|holding)\b/;
    const handsVisible = HANDS_VISIBLE_RE.test(visual) || HANDS_VISIBLE_RE.test(firstFrame);
    if (handsVisible) {
        const d = 0.06;
        score += d;
        drivers.push({
            driver: 'object_interaction_hands_visible_in_frame',
            delta: d,
            source: 'HANDS_VISIBLE match in visual_action_short / first_frame_action — indicator_registry.visual_is_workshop axis (hands-on-object framing)',
        });
    }

    return { score: round(score, 3), drivers };
}

// ──────────────────────────────────────────────────────────────────────
// Visual-legibility score (v3.4)
//
// Proof-clarity already rewards a single-shot visible payoff at the
// *endpoint* and penalizes observation/stack payoffs. But cognitive /
// abstract premises were still surviving the top-5 by gaming cosmetic
// proof tokens ("stack of flashcards", "tally", "count overlay") while
// the actual reveal was a verbal quiz or a social observation. The
// visual-legibility score reads the premise atom along four axes that
// are independent of the endpoint kind:
//
//   V1 — Invisible body-part penalty (feeling/head/mind/brain/memory):
//        the payoff has no legible body surface — inverse of
//        PHYSICAL_SENSORY_LANGUAGE + HIGH_ENERGY_ACTION_FRAMES.
//   V2 — Cognitive verb without a physical-action verb in the premise's
//        copy (learn/memorize/study/recite/recall/translate with no
//        row/ride/carry/build/fold/march/etc.):
//        the action itself is off-camera — inverse of
//        HIGH_ENERGY_ACTION_FRAMES.
//   V3 — Cognitive premise-surface penalty (explicitly cognitive copy,
//        invisible body anchors, and non-physical reveal surface):
//        head-framed payoff — inverse of
//        HIGH_ENERGY_ACTION_FRAMES + PHYSICAL_SENSORY_LANGUAGE.
//   V4 — Title-payoff legibility. Parses the title premise line for the reveal
//        phrase and classifies it:
//          physical / single-shot  → +0.20  (same shot, weigh-in,
//            first and last, body did, rowed it, rode it, held until,
//            broke first, quits first, froze at, told me when to stop,
//            to see what broke first)
//          verbal / observational  → -0.28  (tested me, quizzed me,
//            assuming about me, started assuming, rearranged itself,
//            people said, what they said, you wouldn't guess, figured
//            out, rewrote my, changed how).
//        Grounded in wave11_12.end_begin_ratio: a payoff the viewer
//        reads from the frame vs. a verdict the viewer has to trust.
//   V5 — Frame-1 comprehensibility. Requires first_frame_action to
//        name an action verb AND at least one of an object / gauge.
//        A premise whose opening frame lacks an action verb cannot be
//        comprehended in the first second — penalized regardless of
//        how many proof props appear in the rest of the premise.
//   V6 — Build-test / before-after contrast visible in
//        visual_action_short (cut between, day 1 vs day N, growing
//        pile/stack/tower, slides out, pedals turning, mile-counter,
//        completion %). A state-A → state-B transform is the signal
//        wave11_12.end_begin_ratio is quantifying.
//   V7 — mystery_experiment/identity without physical verb AND without
//        a gauge or physical object in frame — observation-only cut.
//
// Every driver cites an on-disk indicator. No abstract classification layer; no
// hand-picked top 5.
const VL_COGNITIVE_BODY_PARTS = new Set(['feeling', 'head', 'mind', 'brain', 'memory']);
const VL_COG_VERB_RE = /\b(memoriz|learn|studied|study|studying|recit|recall|translat|remember)\w*\b/;
// Strong physical-action stems. Purposefully excludes ambiguous "test",
// "fire", "hold" — they can be verbal ("tested me", "fired me", "hold
// that thought") and would mislabel cognitive premises as physical.
const VL_PHYS_STRONG_RE = /\b(press|slid|slide|pour|hammer|paint|sand|assembl|bolt|tapp|tight|drew|drawing|fold|wrap|writ|flip|stack|plac|lift|heav|squat|stretch|step|walk|march|ran|running|climb|jump|carry|carried|carrying|rowed|rowing|pedal|ride|rode|drove|driving|sail|sailed|launch|race|raced|weigh|pull|push|hit|paddle|throw|threw|roll|kick|cranked|shove|shoved|rig|rigging|unfold|unfolded)\w*\b/;
const VL_COG_BUCKETS = new Set(['cognitive_feat']);
const VL_COGNITIVE_SURFACE_RE = /\b(flashcards?|native speaker|instrument|song|novel|page(?:s)?|book|puzzle|piece(?:s)?|language|memor|learn|study|recit|recall|translate|perform(?:ed)? it)\b/;
const VL_TITLE_PHYSICAL_REVEAL_RE = /(same shot|same frame|same starting|first and last|body did|weigh-?in|broke first|broke at|rode it|rowed it|held until|hit exactly|quits first|froze at|to see what broke|let me know it was over|told me when to stop)/;
const VL_TITLE_ABSTRACT_REVEAL_RE = /(tested me|quizzed me|assuming about me|started assuming|rearranged itself|native speaker|decides when|people said|what they said|you wouldn'?t guess|you'?ll never guess|figured out|rewrote my|changed how i|rewired my|here'?s what people)/;
const VL_FRAME_ACTION_RE = /\bmid-\w+\b|\b(heav|tighten|tap|flip|plac|press|wrap|fold|draw|writ|pedal|row|carri|carry|carrying|runn|climb|jump|stack|point|ring|step|hold|lift|walk|march|squat|stretch|gestur|hitting|pulling|pushing|slid|pour|hammer|paint|cranked|paddl|rigging|boots hitting|boots in motion|oars pulling|pedals turning)\w*\b/;
const VL_FRAME_GAUGE_RE = /\b(counter|timer|overlay|scale|ruler|mile-?counter|distance overlay|completion bar|completion %|page tally|page grid|band counter|height ruler|day-?counter|timer overlay|tally|stopwatch)\b/;
const VL_FRAME_OBJECT_RE = /\b(sandbag|backpack|bag|rope|stairs|plank|boat|bike|hull|oar|oars|pedal|pedals|pages|book|letters|envelope|envelopes|crane|cranes|puzzle|piece|coin|tower|stack|pile|portrait|portraits|bell|rig|gym|truck|drawer|phone|notebook|hammer|wood|cardboard|plate|potato|driveway|shoreline)\b/;
const VL_CONTRAST_RE = /(cut between|day 1.*day ?\d|starting line.*day ?\d|before.*after|identical.*identical|seams hold|first.*phrase|awkward.*clean|growing.*tower|growing.*pile|growing.*stack|stack of.*growing|held out|slides out|pedals turning|oars pulling|mile-?counter|distance overlay|completion bar|completion %|tally|running counter|counter overlay)/;

function computeVisualLegibility(obj, endpoint, ctx) {
    const drivers = [];
    let score = 0;

    const bucketKey = String(obj.diversity_bucket || '').toLowerCase();
    const titleTpl = String(getTitlePremiseLine(obj)).toLowerCase();
    const logline = String(obj.logline_action || '').toLowerCase();
    const firstFrame = String(obj.first_frame_action || '').toLowerCase();
    const visual = String(obj.visual_action_short || '').toLowerCase();
    const bodyPart = String(obj.body_part_phrase || '').toLowerCase();
    const bodyParts = (obj.body_parts || []).map(p => String(p).toLowerCase());
    const allText = `${titleTpl} ${logline} ${firstFrame} ${visual}`;

    // V1 — Invisible body_part_phrase penalty (applies regardless of
    //      action_intensity — cognitive change has no body surface to
    //      film). Distinct from proof-clarity's F (which applied the
    //      same axis at a softer weight); kept separate so the driver
    //      shows up in the visual_legibility trace where its intent is
    //      "the payoff has nothing to show," not "the endpoint is
    //      abstract."
    if (VL_COGNITIVE_BODY_PARTS.has(bodyPart)) {
        const d = -0.32;
        score += d;
        drivers.push({
            driver: `invisible_body_part_phrase_${bodyPart}`,
            delta: d,
            source: 'body_part_phrase ∈ {feeling, head, mind, brain, memory} — no visible body surface for the payoff to land on; inverse of PHYSICAL_SENSORY_LANGUAGE (top peak cause, +1.59 weight) and HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops)',
        });
    }

    // V1b — Physical body_parts list presence (independent of the
    //       phrase — body_parts is the array of per-frame anchors the
    //       premise can cut to; a premise with only cognitive tokens has
    //       nothing to close on).
    const physicalBodyParts = bodyParts.filter(p => !VL_COGNITIVE_BODY_PARTS.has(p));
    if (physicalBodyParts.length === 0) {
        const d = -0.18;
        score += d;
        drivers.push({
            driver: 'no_physical_body_part_in_list',
            delta: d,
            source: 'body_parts lists only invisible tokens — no concrete limb/torso to cut to; inverse of top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE',
        });
    } else {
        const d = round(Math.min(0.12, physicalBodyParts.length * 0.04), 3);
        score += d;
        drivers.push({
            driver: 'physical_body_parts_present',
            delta: d,
            count: physicalBodyParts.length,
            parts: physicalBodyParts,
            source: 'body_parts lists at least one visible limb/torso — cuts to per-beat close-ups legible; top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE',
        });
    }

    // V2 — Cognitive verb without physical-action verb.
    const hasCogVerb = VL_COG_VERB_RE.test(allText);
    const hasPhysVerb = VL_PHYS_STRONG_RE.test(allText);
    if (hasCogVerb && !hasPhysVerb) {
        const d = -0.30;
        score += d;
        drivers.push({
            driver: 'cognitive_verb_without_physical_action',
            delta: d,
            matched_cog_verb: (allText.match(VL_COG_VERB_RE) || [])[0],
            source: 'verb stem is cognitive (memorize/learn/study/recite/recall/translate) AND premise copy contains no physical-action verb — the act itself is off-camera; inverse of HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops)',
        });
    } else if (hasPhysVerb) {
        const d = 0.10;
        score += d;
        drivers.push({
            driver: 'physical_action_verb_in_copy',
            delta: d,
            matched_phys_verb: (allText.match(VL_PHYS_STRONG_RE) || [])[0],
            source: 'physical-action verb stem present in premise copy — the daily act is filmable action; top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES',
        });
    }

    // V3 — Cognitive premise surface. This intentionally keys off explicit
    //      copy + body anchors rather than an abstract taxonomy tag.
    const hasCognitiveSurface = VL_COG_BUCKETS.has(bucketKey)
        || (!physicalBodyParts.length && (hasCogVerb || VL_COGNITIVE_SURFACE_RE.test(allText)));
    if (hasCognitiveSurface) {
        const d = -0.22;
        score += d;
        drivers.push({
            driver: `cognitive_premise_surface_${bucketKey || 'explicit_copy'}`,
            delta: d,
            source: 'explicit premise copy/body anchors indicate a cognitive or verbal reveal surface rather than a visible physical payoff; inverse of HIGH_ENERGY_ACTION_FRAMES + PHYSICAL_SENSORY_LANGUAGE',
        });
    }

    // V4 — Title-payoff legibility. Classifies the reveal in the title
    //      itself; catches premises that pass proof-clarity via cosmetic
    //      artifact tokens (stack/pile/tally) but actually land on a
    //      verbal / social / cognitive verdict.
    const absReveal = titleTpl.match(VL_TITLE_ABSTRACT_REVEAL_RE);
    const physReveal = titleTpl.match(VL_TITLE_PHYSICAL_REVEAL_RE);
    if (absReveal) {
        const d = -0.28;
        score += d;
        drivers.push({
            driver: 'title_payoff_abstract_or_verbal',
            delta: d,
            matched_reveal: absReveal[0],
            source: 'title premise line signals a verbal / observational / cognitive reveal — wave11_12.end_begin_ratio requires a single-frame visible payoff, not a verdict the viewer has to trust',
        });
    }
    if (physReveal) {
        const d = 0.20;
        score += d;
        drivers.push({
            driver: 'title_payoff_physical_reveal',
            delta: d,
            matched_reveal: physReveal[0],
            source: 'title premise line signals a single-frame payoff (same-shot / weigh-in / freeze-frame / break point / call-it moment) — wave11_12.end_begin_ratio (single-shot end-over-start reveal)',
        });
    } else if (!absReveal && !obj.title_has_builtin_reveal && (endpoint.kind === 'count' || endpoint.kind === 'timer' || endpoint.kind === 'distance' || endpoint.kind === 'body' || endpoint.kind === 'build_test')) {
        // composeTitle() appends "— The Counter Froze At {N}" / "— The
        // Timer Hit {N} Exactly" / "— The Mile Counter Froze At {N}" /
        // "— My {Body Part} Quit First" / "— The Build Held Until {N}"
        // to numeric/body/build_test endpoints when the premise has no
        // builtin reveal. That appended phrase IS a single-frame
        // freeze — credit it in V4 so endurance / body_quit / bike
        // premises are not falsely neutral relative to premises whose
        // reveal is hard-coded into the title premise line.
        const d = 0.16;
        score += d;
        drivers.push({
            driver: `title_payoff_implicit_freeze_frame_${endpoint.kind}`,
            delta: d,
            source: 'endpoint is numeric/body/build_test AND the premise has no builtin reveal — composeTitle() appends a single-frame freeze ("The Counter Froze At N" / "The Timer Hit N Exactly" / "The Mile Counter Froze At N" / "My {part} Quit First" / "The Build Held Until N"); wave11_12.end_begin_ratio',
        });
    }

    // V5 — Frame-1 comprehensibility. Action verb + (gauge OR object).
    //      A premise whose first_frame_action lacks an action verb has
    //      no filmable opening — viewer cannot read the challenge at
    //      t=0s regardless of what appears later in the shot.
    const hasFrameAction = VL_FRAME_ACTION_RE.test(firstFrame);
    const hasFrameGauge = VL_FRAME_GAUGE_RE.test(firstFrame);
    const hasFrameObject = VL_FRAME_OBJECT_RE.test(firstFrame);
    if (hasFrameAction && (hasFrameGauge || hasFrameObject)) {
        const d = (hasFrameGauge && hasFrameObject) ? 0.18 : 0.10;
        score += d;
        drivers.push({
            driver: hasFrameGauge && hasFrameObject ? 'frame1_comprehensible_action_object_gauge' : 'frame1_comprehensible_action_plus_one',
            delta: d,
            matched: {
                action: (firstFrame.match(VL_FRAME_ACTION_RE) || [])[0] || null,
                object: hasFrameObject ? (firstFrame.match(VL_FRAME_OBJECT_RE) || [])[0] : null,
                gauge: hasFrameGauge ? (firstFrame.match(VL_FRAME_GAUGE_RE) || [])[0] : null,
            },
            source: 'first_frame_action names an action verb + at least one of {gauge, physical object} — the challenge is legible at t=0s; HIGH_ENERGY_ACTION_FRAMES peak cause applied at the opening',
        });
    } else if (!hasFrameAction && !hasFrameGauge && !hasFrameObject) {
        const d = -0.12;
        score += d;
        drivers.push({
            driver: 'frame1_not_comprehensible',
            delta: d,
            source: 'first_frame_action lacks an action verb, a gauge, AND a physical object — viewer cannot parse the challenge from the first frame; inverse of HIGH_ENERGY_ACTION_FRAMES',
        });
    }

    // V6 — Build-test / before-after contrast in visual_action_short.
    const contrastMatch = visual.match(VL_CONTRAST_RE);
    if (contrastMatch) {
        const d = 0.08;
        score += d;
        drivers.push({
            driver: 'visual_action_short_shows_state_contrast',
            delta: d,
            matched: contrastMatch[0],
            source: 'visual_action_short names a state→state change (cut between, day1 vs dayN, growing stack/pile/tower, slides out, pedals turning, mile-counter) — wave11_12.end_begin_ratio (legible progress / before-after)',
        });
    }

    // V7 — mystery_experiment / identity with no physical verb AND no
    //      gauge/object in frame. Observation-only cut that reads only
    //      with context.
    if ((bucketKey === 'mystery_experiment' || bucketKey === 'identity') && !hasPhysVerb && !hasFrameGauge && !hasFrameObject) {
        const d = -0.18;
        score += d;
        drivers.push({
            driver: `${bucketKey}_without_physical_frame_signals`,
            delta: d,
            source: 'premise lane=mystery_experiment|identity AND no physical verb / gauge / object in frame — observation-only payoff; inverse of HIGH_ENERGY_ACTION_FRAMES + end_begin_ratio',
        });
    }

    return { score: round(score, 3), drivers };
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
    } else if (endpoint.kind === 'transformation' || endpoint.kind === 'experiment' || endpoint.kind === 'identity' || endpoint.kind === 'build_test') {
        // Qualitative reveals don't carry a numeric freeze-frame, but they do
        // carry single-shot payoff that matches the end_begin_ratio signal.
        score += 0.14; drivers.push({ driver: `qualitative_reveal_${endpoint.kind}`, delta: 0.14 });
    }

    // Hook-taxonomy match bonus: transformation / mystery hooks are the top
    // two performing labels in the corpus (2.24M / 2.20M vs 1.12M for stakes).
    // Reward premises that declare a preferred_hook_type in that top-2 set.
    const preferred = String(obj.preferred_hook_type || '').toLowerCase();
    if (preferred && ctx.preferHookTypes && ctx.preferHookTypes.includes(preferred)) {
        const idx = ctx.preferHookTypes.indexOf(preferred);
        const d = idx === 0 ? 0.18 : 0.12;
        score += d; drivers.push({ driver: `hook_taxonomy_match_${preferred}_rank${idx + 1}`, delta: d });
    }

    // Creator-fit bias — biases toward the strongest maker/body/workshop
    // DNA already present in the corpus. Added to the combo score so the
    // slate-balancing selector rewards fit within each premise lane.
    const fit = computeCreatorFit(obj, endpoint, ctx);

    // Proof-clarity / mechanism-visibility — rewards combos with a
    // single-shot legible proof moment (build+test, body before/after,
    // numeric counter freeze + named artifact) and penalizes abstract
    // payoffs (experiment/identity observation, cognitive change,
    // stacks whose contents are untestable).
    const proof = computeProofClarity(obj, endpoint, ctx);

    // Visual-legibility (v3.4) — independent of endpoint kind. Reads
    // body_part_phrase, verb stems, explicit premise surface, title-payoff
    // phrasing, frame-1 comprehensibility, and state-to-state visual
    // contrast. Catches premises that pass proof-clarity via cosmetic
    // artifact tokens (stack/pile/tally) while actually landing on a
    // verbal / social / cognitive verdict.
    const legibility = computeVisualLegibility(obj, endpoint, ctx);

    const core = round(score, 3);
    return {
        score: round(core + fit.score + proof.score + legibility.score, 3),
        drivers,
        core_score: core,
        creator_fit_score: fit.score,
        creator_fit_drivers: fit.drivers,
        proof_clarity_score: proof.score,
        proof_clarity_drivers: proof.drivers,
        visual_legibility_score: legibility.score,
        visual_legibility_drivers: legibility.drivers,
    };
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

function deriveOpeningSpeechRate(obj, sourceVideo) {
    const duration = Number(sourceVideo && sourceVideo.duration_s) || 0;
    const keep = Number(sourceVideo && sourceVideo.keep) || 0;
    const retention = Number(sourceVideo && sourceVideo.retention) || 0;
    const titleLen = String((sourceVideo && sourceVideo.name) || obj.id || '').length;
    const hashNudge = ((titleLen % 5) - 2) * 0.01;
    const durationAdj = duration > 0 ? clamp((42 - duration) / 200, -0.08, 0.08) : 0;
    const keepAdj = keep > 0 ? clamp((keep - 74) / 150, -0.05, 0.05) : 0;
    const retentionAdj = retention > 0 ? clamp((retention - 78) / 220, -0.04, 0.04) : 0;
    return round(clamp(2.58 + durationAdj + keepAdj + retentionAdj + hashNudge, 2.45, 2.72), 2);
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
    if (endpoint.kind === 'distance' || endpoint.kind === 'build_test') {
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

// endpointPhrase drives the logline, promise, payoff, and climax hints. New
// endpoint kinds (transformation/experiment/identity/build_test) do not land
// on a numeric reveal — they land on a qualitative payoff tied to the premise.
function endpointPhraseFor(obj, endpoint, scale, revealVal, bodyPart) {
    switch (endpoint.kind) {
        case 'count':    return `the counter freezes at ${revealVal}`;
        case 'timer':    return `the timer hits exactly ${revealVal}`;
        case 'distance': return `the mile counter freezes at ${revealVal}`;
        case 'body':     return `my ${bodyPart} quits first`;
        case 'transformation': return `the final-${scale.display} frame holds the whole transformation in one shot`;
        case 'experiment':     return `the observation from the last ${scale.display} lands as a single on-screen sentence`;
        case 'identity':       return `the person I shadowed decides out loud when my day is over`;
        case 'build_test':     return `the build holds until ${revealVal} and then visibly gives`;
        default:               return `the result lands at ${revealVal}`;
    }
}

function composeTitle(obj, endpoint, scale, bodyPart) {
    // Build the core title from the premise atom's validated premise line, substituting {N}/{D}/{T}
    let core = getTitlePremiseLine(obj, obj.concrete_kind);
    // Always run all three substitutions — some premise atoms (e.g. memorize_book)
    // carry {T} in their premise line even though concrete_kind is 'pages'.
    core = core.replace('{N}', String(scale.display));
    core = core.replace('{D}', capitalize(scale.display));
    core = core.replace('{T}', capitalize(scale.display));

    const revealVal = overDeliveryRevealValue(scale, endpoint);
    // Some premise atoms (body_transformation, identity, skill_dare) encode their
    // reveal directly in their title premise line (e.g. "— He Told Me When To Stop").
    // Appending a numeric suffix on top of a qualitative reveal reads as a
    // double ending. If the premise signals a builtin reveal, return core.
    if (obj.title_has_builtin_reveal) return core;
    if (endpoint.kind === 'count')    return `${core} \u2014 The Counter Froze At ${revealVal}`;
    if (endpoint.kind === 'timer')    return `${core} \u2014 The Timer Hit ${revealVal} Exactly`;
    if (endpoint.kind === 'distance') return `${core} \u2014 The Mile Counter Froze At ${revealVal}`;
    if (endpoint.kind === 'body')     return `${core} \u2014 My ${capitalize(bodyPart)} Quit First`;
    if (endpoint.kind === 'build_test') return `${core} \u2014 The Build Held Until ${revealVal}`;
    // transformation / experiment / identity — the title premise line already carries the reveal
    return core;
}

// Removes emojis, trailing decorative symbols, and collapses whitespace so a
// raw video title like "Making a GRAPPLING GUN 😎" reads as "Making a GRAPPLING GUN"
// before it gets parsed as a premise. No abstraction, just surface cleanup.
function stripSourceTitleDecorations(s) {
    return String(s || '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]/gu, '')
        .replace(/\s+/g, ' ')
        .replace(/\s+([?.!,:;])/g, '$1')
        .trim();
}

// Picks a grounded body-part triple from the exact validated source title by
// reading factual tokens (feet ↔ marathon/shoes/steps, shoulders ↔ pushup/plank,
// hands ↔ grip/deadhang, lungs ↔ oxygen/breath, eyes ↔ dark/blind). No category
// layer — each branch is one keyword check against the real title text.
function inferSourceBodyAnchor(titleLower) {
    if (/\b(feet|foot|toes?|shoes?|marathon|running|walking|walked|stairs?|steps?|hike|hiking|skydive|skydiving)\b/.test(titleLower)) {
        return { body_part_phrase: 'feet', body_parts: ['feet', 'legs', 'skin'], sensation_words: ['feet', 'painful', 'numb', 'feeling'] };
    }
    if (/\b(push.?up|plank|pull.?up|dip|bench|chest|triceps)\b/.test(titleLower)) {
        return { body_part_phrase: 'shoulders', body_parts: ['shoulders', 'chest', 'skin'], sensation_words: ['painful', 'shoulders', 'numb', 'feeling'] };
    }
    if (/\b(hand|hands|grip|hold|hang|deadhang|crane|fingers?|iron fist|punch)\b/.test(titleLower)) {
        return { body_part_phrase: 'hands', body_parts: ['hands', 'shoulders', 'skin'], sensation_words: ['hands', 'painful', 'numb', 'feeling'] };
    }
    if (/\b(eye|eyes|sight|dark|darkness|blind|see)\b/.test(titleLower)) {
        return { body_part_phrase: 'eyes', body_parts: ['eyes', 'face', 'skin'], sensation_words: ['curious', 'feeling', 'numb'] };
    }
    if (/\b(breath|breathe|oxygen|lungs?|smoke|gas|suffocat)\b/.test(titleLower)) {
        return { body_part_phrase: 'lungs', body_parts: ['lungs', 'chest', 'skin'], sensation_words: ['painful', 'numb', 'feeling'] };
    }
    if (/\b(arm|arms|bicep|forearm)\b/.test(titleLower)) {
        return { body_part_phrase: 'arm', body_parts: ['arm', 'shoulders', 'skin'], sensation_words: ['painful', 'numb', 'arm', 'feeling'] };
    }
    return { body_part_phrase: 'body', body_parts: ['body', 'shoulders', 'skin'], sensation_words: ['feeling', 'numb', 'painful'] };
}

// Source-grounded view used when no per-video handcrafted rule matches.
// The premise line IS the exact validated title. No category rewrite,
// no template rewrite, no "— Here's What Actually Happened" tail. Support
// fields (logline, visual, reveal, setting) quote the cleaned title text
// directly so they carry the source instead of an abstract template.
// title_has_builtin_reveal is set so composeTitle never tacks a generic
// endpoint suffix onto this source-grounded title.
//
// Trailing parenthetical decorators like "(Possible?)", "(HARD)",
// "(this happens)" are stripped from the premise line because they read
// as clickbait suffix rather than the core claim; the core statement is
// preserved verbatim, keeping the creator's exact phrasing and casing.
function buildGenericSourceGroundedView(sourceVideo) {
    const rawTitle = stripSourceTitleDecorations((sourceVideo && sourceVideo.name) || '');
    if (!rawTitle) return null;
    const core = rawTitle.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawTitle;
    const coreL = core.toLowerCase();
    const anchor = inferSourceBodyAnchor(coreL);
    return {
        title_has_builtin_reveal: true,
        body_part_phrase: anchor.body_part_phrase,
        body_parts: anchor.body_parts,
        sensation_words: anchor.sensation_words,
        source_grounded_form: 'verbatim_validated_title',
        title_premise_line: core,
        logline_action: `carry out the exact premise of "${coreL}" on camera and keep filming until the outcome is visible`,
        first_frame_action: `the setup required for "${coreL}" framed before the first move`,
        visual_action_short: `"${coreL}" unfolding while the camera holds on the consequence`,
        setting_hint: `inside the exact environment where "${coreL}" plays out`,
        reveal_phrase: `the real outcome of "${coreL}" lands on camera and the frame freezes on it`,
        promise_tail: `the real outcome of "${coreL}" lands`,
    };
}

// Returns the exact validated source title with decorative noise (emojis,
// collapsed whitespace) stripped and trailing parenthetical clickbait tails
// like "(Possible?)", "(this happens)", "(HARD)" removed. The creator's
// original casing and phrasing of the core claim is preserved so the
// premise reads exactly like the source that was actually validated.
function cleanVerbatimSourceTitle(sourceVideo) {
    const rawName = String((sourceVideo && sourceVideo.name) || '').trim();
    if (!rawName) return '';
    const cleaned = stripSourceTitleDecorations(rawName);
    if (!cleaned) return '';
    const core = cleaned.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return core || cleaned;
}

// Wraps the handcrafted / generic source-grounded view so the title_premise_line
// is ALWAYS the exact validated source title. Per-video handcrafted rules still
// contribute body anchor, reveal phrase, logline, and visual craft — but the
// emitted title itself never drifts from the exact validated video framing.
// The source_grounded_form trace is preserved (or upgraded to a *_verbatim
// marker) so the audit trail records both the craft layer that matched and
// the verbatim-title enforcement.
function deriveSourceVideoPremiseView(sourceVideo) {
    const inner = _deriveSourceVideoPremiseCraftedView(sourceVideo);
    if (!inner) return null;
    const verbatim = cleanVerbatimSourceTitle(sourceVideo);
    if (!verbatim) return inner;
    const priorForm = inner.source_grounded_form
        || (inner.title_premise_line === verbatim ? 'verbatim_validated_title' : 'handcrafted_source_rule');
    const nextForm = priorForm.endsWith('_verbatim') || priorForm === 'verbatim_validated_title'
        ? priorForm
        : `${priorForm}_verbatim`;
    return {
        ...inner,
        title_premise_line: verbatim,
        source_grounded_form: nextForm,
    };
}

function _deriveSourceVideoPremiseCraftedView(sourceVideo) {
    const rawTitle = String((sourceVideo && sourceVideo.name) || '').trim();
    if (!rawTitle) return null;
    const t = rawTitle.toLowerCase();

    if (/laser/.test(t) && /(arm|skin)/.test(t)) {
        const target = /skin/.test(t) ? 'skin' : 'arm';
        return {
            title_premise_line: `I Put My ${capitalize(target)} In Front Of A $20,000 Laser To See If It Would Actually Cut Through — Here’s What Actually Happened`,
            title_has_builtin_reveal: true,
            logline_action: `put my ${target} in front of a high-powered laser, increase the exposure in controlled steps, and keep filming until the test gives a real answer`,
            first_frame_action: `the laser head powering on while my ${target} and the safety rig are both clearly in frame`,
            visual_action_short: `my ${target} moving toward the laser path with the power setting visible on screen`,
            setting_hint: 'inside a workshop test rig with visible safety barriers and a live power readout',
            reveal_phrase: `the laser either cuts through my ${target} or it visibly doesn’t, and the camera freezes on the real result`,
            promise_tail: `the laser gives a visible answer on my ${target}`,
            body_part_phrase: target,
            body_parts: [target, 'skin', 'hand'],
            sensation_words: [target, 'skin', 'painful', 'numb', 'feeling'],
        };
    }

    if (/(stop a bullet|bullet proof|bulletproof|oobleck)/.test(t)) {
        const isShield = /shield/.test(t);
        const material = /oobleck/.test(t) ? 'oobleck' : (isShield ? 'a homemade shield' : 'different homemade materials');
        return {
            title_premise_line: isShield
                ? 'I Built A Shield To See If It Could Actually Stop A Bullet — Here’s What Happened'
                : /oobleck/.test(t)
                    ? 'I Tested Whether Oobleck Could Actually Stop A Bullet — Here’s What Happened'
                    : 'I Tested Homemade Materials To See If Any Could Actually Stop A Bullet — Here’s What Happened',
            title_has_builtin_reveal: true,
            logline_action: `test whether ${material} can stop a bullet by escalating through real shots until the answer is visually undeniable`,
            first_frame_action: 'the target rig, impact zone, and projectile test setup all framed together before the first shot',
            visual_action_short: 'a projectile test hitting the target while the impact result is frozen on screen',
            setting_hint: 'at an outdoor ballistic range with the target rig and impact camera both visible',
            reveal_phrase: `the bullet either gets stopped by ${material} or it visibly punches through, and the impact frame freezes on the real result`,
            promise_tail: `${material} either stops the bullet or visibly fails`,
            body_part_phrase: 'hands',
            body_parts: ['hands', 'shoulders', 'skin'],
            sensation_words: ['painful', 'curious', 'skin', 'numb'],
        };
    }

    if (/banned shoes/.test(t) && /marathon/.test(t)) {
        return {
            title_premise_line: 'I Ran A Marathon In Banned Shoes To See When My Feet Would Start Fighting Me',
            title_has_builtin_reveal: true,
            logline_action: 'run a full marathon in banned racing shoes and keep filming each physical change until my feet make the cost obvious',
            first_frame_action: 'lacing up the banned shoes next to the start line with the race clock already visible',
            visual_action_short: 'the shoes pounding pavement while the race clock and stride stay in frame',
            setting_hint: 'on a live marathon course with the race clock and road markings visible',
            reveal_phrase: 'my feet hit the exact moment they stop cooperating with the banned shoes on the marathon course',
            promise_tail: 'my feet decide how far the banned shoes can carry me',
            body_part_phrase: 'feet',
            body_parts: ['feet', 'legs', 'skin'],
            sensation_words: ['feet', 'painful', 'numb', 'feeling'],
        };
    }

    if (/shock collar/.test(t) && /marathon/.test(t)) {
        return {
            title_premise_line: 'I Ran A Marathon With A Shock Collar To See When The Pain Would Change My Pace',
            title_has_builtin_reveal: true,
            logline_action: 'run a full marathon while a shock collar keeps threatening the next step, and keep filming until the pain visibly changes my stride',
            first_frame_action: 'the shock collar clicking on beside the race bib before the first step',
            visual_action_short: 'my stride changing on course while the collar and race clock both stay visible',
            setting_hint: 'on a live road race course with the clock and collar both visible in frame',
            reveal_phrase: 'the shock collar visibly changes my stride on the marathon course and the camera holds on the moment it lands',
            promise_tail: 'the shock collar forces my stride to change on camera',
            body_part_phrase: 'legs',
            body_parts: ['legs', 'feet', 'skin'],
            sensation_words: ['painful', 'numb', 'feet', 'feeling'],
        };
    }

    if (/painful shoes|electrocute you/.test(t)) {
        const adjective = /electrocute/.test(t) ? 'electric' : 'painful';
        return {
            title_premise_line: `I Tried The Most ${capitalize(adjective)} Shoes I Could Find To See How Long My Feet Would Last`,
            title_has_builtin_reveal: true,
            logline_action: `wear brutally ${adjective} shoes and keep escalating the test until my feet force a visible decision`,
            first_frame_action: `slipping into the ${adjective} shoes while the camera holds on the sole and my reaction in the same frame`,
            visual_action_short: `taking real steps in the shoes while the reaction and the shoe contact stay visible`,
            setting_hint: 'on a simple test course where every step and reaction reads clearly on camera',
            reveal_phrase: `my feet force the first visible moment the ${adjective} shoes become impossible to ignore`,
            promise_tail: `my feet call it before the ${adjective} shoes do`,
            body_part_phrase: 'feet',
            body_parts: ['feet', 'legs', 'skin'],
            sensation_words: ['feet', 'painful', 'numb', 'feeling'],
        };
    }

    if (/impossible pushup/.test(t)) {
        return {
            title_premise_line: 'I Tried To Beat The Impossible Pushup Until My Body Finally Gave Me An Answer',
            title_has_builtin_reveal: true,
            logline_action: 'keep attempting the impossible pushup variation, adjusting form and effort on camera until my body gives a visible answer',
            first_frame_action: 'my hands setting into the impossible pushup position before the first attempt',
            visual_action_short: 'full-body pushup attempts with the form and failure point both visible',
            setting_hint: 'on a simple gym floor with one angle that makes the leverage obvious',
            reveal_phrase: 'my body lands a visible answer on the impossible pushup and the camera freezes on the single frame that settles it',
            promise_tail: 'the impossible pushup gets a visible answer from my body',
            body_part_phrase: 'shoulders',
            body_parts: ['shoulders', 'chest', 'skin'],
            sensation_words: ['painful', 'numb', 'shoulders', 'feeling'],
        };
    }

    if (/world record/.test(t)) {
        return {
            title_premise_line: 'I Tried To Break A World Record Until The Attempt Turned Into Its Own Story',
            title_has_builtin_reveal: true,
            logline_action: 'chase a real world record attempt from setup to failure or success, keeping the counter and the emotional swing visible the whole time',
            first_frame_action: 'the record setup and the number to beat both visible before the first attempt starts',
            visual_action_short: 'each attempt tightening while the target number stays on screen',
            setting_hint: 'inside the record attempt setup with the goal number and attempt both visible',
            reveal_phrase: 'the record attempt lands on whatever the real final number turns out to be with the counter still in frame',
            promise_tail: 'the world record attempt lands on its real final number',
            body_part_phrase: 'hands',
            body_parts: ['hands', 'shoulders', 'skin'],
            sensation_words: ['painful', 'curious', 'numb', 'feeling'],
        };
    }

    if (/became a bodybuilder|called fat/.test(t)) {
        return {
            title_premise_line: 'I Got Called Fat So I Trained Until My Body Actually Looked Different',
            title_has_builtin_reveal: true,
            logline_action: 'rebuild my body like a bodybuilder and keep comparing the same poses until the before and after become impossible to argue with',
            first_frame_action: 'a side-by-side day-1 mirror frame locked to the exact pose I will repeat at the end',
            visual_action_short: 'matching gym reps and identical pose checks cutting against each other',
            setting_hint: 'in the same gym and mirror setup every time so the change is undeniable',
            reveal_phrase: 'the matching before/after pose cut lands and the change becomes impossible to argue with',
            promise_tail: 'the before/after pose makes the change undeniable',
            body_part_phrase: 'body',
            body_parts: ['body', 'shoulders', 'stomach'],
            sensation_words: ['body', 'bigger', 'painful', 'feeling'],
        };
    }

    if (/military training/.test(t)) {
        return {
            title_premise_line: 'I Tried To Survive Insane Military Training For A Full Day',
            title_has_builtin_reveal: true,
            logline_action: 'follow a brutal military training day from the first drill to the last and keep filming the moment my body starts negotiating with me',
            first_frame_action: 'the first command getting yelled while I step into the training field already behind everyone else',
            visual_action_short: 'matching the drill pace while the instructors and the field stay visible in frame',
            setting_hint: 'inside a real military-style training course with the instructors in frame',
            reveal_phrase: 'my body starts visibly negotiating with the drill and the instructor’s response lands in the same frame',
            promise_tail: 'my body starts visibly negotiating with the drill',
            body_part_phrase: 'shoulders',
            body_parts: ['shoulders', 'legs', 'stomach'],
            sensation_words: ['painful', 'numb', 'stomach', 'feeling'],
        };
    }

    if (/solitary/.test(t)) {
        return {
            title_premise_line: 'I Locked My Little Sister In Solitary To See How Fast The Situation Got Weird',
            title_has_builtin_reveal: true,
            logline_action: 'run a controlled solitary-style isolation test and keep filming the moment the emotional effect becomes undeniable',
            first_frame_action: 'the door closing while the timer starts and the isolation room is fully visible',
            visual_action_short: 'the timer climbing while every new reaction is filmed through the same viewpoint',
            setting_hint: 'inside a controlled room with a visible timer and one consistent camera angle',
            reveal_phrase: 'the isolation visibly changes what she does with the room and the timer is still running in the same frame',
            promise_tail: 'the isolation visibly shifts what she does with the room',
            body_part_phrase: 'face',
            body_parts: ['face', 'skin', 'feeling'],
            sensation_words: ['curious', 'feeling', 'numb'],
        };
    }

    if (/oxygen save my life/.test(t)) {
        return {
            title_premise_line: 'Can Pure Oxygen Actually Save Me In A Real Test',
            title_has_builtin_reveal: true,
            logline_action: 'test whether pure oxygen actually changes a dangerous physical situation and keep filming until the answer becomes obvious',
            first_frame_action: 'the oxygen rig, my body, and the countdown to the test all visible in the same frame',
            visual_action_short: 'the oxygen test running while the physical response stays in frame',
            setting_hint: 'inside a controlled test setup with the oxygen rig and timer both visible',
            reveal_phrase: 'the pure oxygen either visibly changes the physical outcome or it doesn’t, and the camera freezes on which',
            promise_tail: 'the pure oxygen test forces a visible verdict on my body',
            body_part_phrase: 'lungs',
            body_parts: ['lungs', 'chest', 'skin'],
            sensation_words: ['painful', 'numb', 'feeling'],
        };
    }

    // Fallback: derive a grounded view directly from the exact validated video
    // title. Every validated source video — not just the handcrafted ones —
    // gets a source-grounded premise so no top seed falls through to a generic
    // premise-atom template.
    return buildGenericSourceGroundedView(sourceVideo);
}

function composeSeed(obj, endpoint, ctx, rank, premiseScore, premiseDrivers, creatorFit, proofClarity, visualLegibility, sourceVideo = null) {
    const sourcePremise = sourceVideo ? deriveSourceVideoPremiseView(sourceVideo) : null;
    const premiseObj = sourcePremise ? { ...obj, ...sourcePremise } : obj;
    const scale = pickScale(obj);
    const bodyPart = premiseObj.body_part_phrase || (premiseObj.body_parts && premiseObj.body_parts[0]) || 'body';
    const title = composeTitle(premiseObj, endpoint, scale, bodyPart);
    const revealVal = overDeliveryRevealValue(scale, endpoint);

    const endpointPhrase = endpointPhraseFor(premiseObj, endpoint, scale, revealVal, bodyPart);
    // When the premise is grounded in an exact validated source video, the
    // source's own reveal language replaces the generic endpoint phrase across
    // logline / payoff / climax / 90-100 beat. Seeds without a sourcePremise
    // (raw OBJECT_MOTIFS \u00d7 ENDPOINT path) still use endpointPhrase unchanged.
    const revealPhrase = premiseObj.reveal_phrase || endpointPhrase;

    const action = premiseObj.logline_action || `${premiseObj.verb_present_phrase} ${premiseObj.noun_subject_phrase}`;
    const isQualitativeReveal = ['transformation', 'experiment', 'identity'].includes(endpoint.kind);
    const logline = `I ${action} ${premiseObj.setting_hint}, narrating every sensation in my ${bodyPart} until ${revealPhrase}.`;
    const promiseTail = premiseObj.promise_tail
        || (endpoint.kind === 'body' ? `my ${bodyPart} gives out`
        : endpoint.kind === 'transformation' ? 'the before/after lands in one shot'
        : endpoint.kind === 'experiment' ? 'one observation replaces every assumption'
        : endpoint.kind === 'identity' ? `the person I shadowed says we\u2019re done`
        : endpoint.kind === 'build_test' ? 'the build holds or visibly gives'
        : 'the counter lands on a specific number');
    const promise = `You\'re watching me ${action} \u2014 the question is where ${promiseTail}.`;
    const payoffTail = isQualitativeReveal
        ? 'a single word of reaction lands as overlay.'
        : 'a single sensation word appears as overlay.';
    const payoff = `Final 5% of runtime: ${revealPhrase}; ${payoffTail}`;
    // Source-grounded over-delivery note when a validated source video is the
    // seed: the hook is the exact validated title and the payoff is the source
    // reveal, so the over-delivery claim reads against the actual title-tease
    // rather than a template scale (e.g. "5 miles") inherited from the premise
    // atom. Seeds without a sourcePremise still use the scale-based phrasing.
    const overDelivery = sourcePremise
        ? `Hook is the exact validated title tease; payoff delivers ${revealPhrase} as the single visible on-camera moment that resolves it \u2014 the resolved frame over-delivers vs the headline question.`
        : isQualitativeReveal
            ? `Hook implies a legible answer to the premise (${scale.display}); payoff delivers the reveal as one frame/phrase \u2014 specificity of the single shot over-delivers vs the rounded premise.`
            : `Hook implies a round target (${scale.display}); payoff lands on a specific, non-round value (${revealVal}) \u2014 specificity over-delivers vs the rounded promise.`;

    // Narrative structures — pick top 4-5 from ranked lattice list + always include the key three
    const strBase = ['late_peak_arc', 'golden_final_5pct', 'visceral_body_language'];
    const more = ctx.structureRanked.filter(s => !strBase.includes(s));
    if (obj.action_intensity === 'high' && !more.includes('fast_pacing_no_pauses')) more.push('fast_pacing_no_pauses');
    if (obj.concrete_kind === 'distance' || obj.concrete_kind === 'reps') more.push('monotonic_rise');
    const narrative = [...new Set([...strBase, ...more])].slice(0, 6);

    // Vocabulary — commit only to peak words that are in corpus positive list + body parts in positive list
    const useWords = Array.from(new Set([
        ...(premiseObj.sensation_words || []).filter(w => ctx.positiveWords.has(w)),
        ...(premiseObj.body_parts || []).filter(w => ctx.positiveWords.has(w)),
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

    // Opening speech rate target — deterministic and source-video-informed
    const openingRate = deriveOpeningSpeechRate(obj, sourceVideo);

    // First frame — derive from obj.first_frame_action + top frame mech at first_5s (if POSITIVE rho)
    const topFirst5 = (ctx.frameMechs.first_5s || []).filter(m => m.outcome === 'log_views' && m.rho > 0)[0];
    const firstFrameExtras = topFirst5 ? `; composition emphasizes ${topFirst5.id.replace('frame_','').replace('_at_first_5s','').replace(/_/g,' ')} (rho=${round(topFirst5.rho, 3)} vs log_views)` : '';
    const firstFrame = `Close on ${premiseObj.first_frame_action}. Counter visible. No explanatory overlay${firstFrameExtras}.`;
    // First line: for source-grounded seeds the opening narration drops the
    // premise-atom scale (e.g. "5 miles") — which is a template relic, not
    // anything the source video actually claims — and hangs on the body
    // anchor that the source title already implies. Non-source seeds keep
    // the scale-display anchor so the legacy path is unchanged.
    const firstLine = (sourcePremise
        ? `${capitalize(firstWord)} — my ${bodyPart} is going to tell you when it\'s over.`
        : `${capitalize(firstWord)} — ${scale.display}, and my ${bodyPart} is going to tell you when it\'s over.`
    ).replace('shoulders is', 'shoulders are').replace('feet is', 'feet are').replace('hands is', 'hands are').replace('legs is', 'legs are').replace('eyes is', 'eyes are').replace('lungs is', 'lungs are');
    const openingAction = `Camera locked on ${premiseObj.visual_action_short} for the first 3 seconds; I enter motion inside the first second.`;

    // Build phases — retention-pattern driven by top_5_retention_predictors
    const buildPhases = [
        { zone_pct: '0-10', beat: `enter ${premiseObj.setting_hint.replace(/^at |^on |^in /, '')}; ${premiseObj.visual_action_short}; premise named on screen`, visceral: true, note: 'Concept + body inside first 10%. Design rule v3 #6 (5.4x gap).' },
        { zone_pct: '10-25', beat: `first ${bodyPart} sensation narration; counter begins to tick; ${premiseObj.visual_action_short}`, visceral: true, note: 'Divergence lock-in at ~22%. Sensory-word ramp begins.' },
        { zone_pct: '25-60', beat: `escalating ${premiseObj.visual_action_short} with sensory updates; utterances < 10 words; no pauses > 1s`, visceral: true, note: 'Monotonic rise in distress / counter. Peak-word density increases.' },
        { zone_pct: '60-90', beat: `peak zone — slow to 3.0 w/s; short sentence on a single sensation; reaction → wide on the count or distance milestone`, visceral: true, note: 'Peak 60-80%. Peak-speaking-rate 3.86 wps confirmed; utterance 7.9 words.' },
        { zone_pct: '90-100', beat: `${revealPhrase}; single-word overlay (sensation); wide shot of the final state`, visceral: true, note: 'Golden final 5% + END_RECOVERY. Emotion word in final 10% = +0.069.' },
    ];

    const climaxHint = `At 95% of runtime, ${revealPhrase}; camera holds on the final position; I say one word and the overlay freezes.`;
    const closingLineHint = `Close with ${bodyPart} + impact word: "${bodyPart}\'s numb — ${closingWords[0] || 'insane'}."`;

    // Visual prescription per zone — derived from top frame mechanisms at each bucket
    const zoneRec = (zone) => {
        const mechs = (ctx.frameMechs[zone] || []).filter(m => m.outcome === 'log_views').slice(0, 3);
        return mechs.length
            ? mechs.map(m => m.id.replace(`_at_${zone}`, '').replace('frame_', '').replace(/_/g, ' ') + ` (rho=${round(m.rho, 3)})`)
            : [];
    };
    const visualHints = {
        first_5s: [`${premiseObj.first_frame_action}`, 'no explanatory overlay', 'counter visible', ...zoneRec('first_5s')],
        hook_quarter: [`${premiseObj.visual_action_short}`, 'body in motion only', ...zoneRec('hook_quarter')],
        mid: [`alternate ${bodyPart} close-ups with ${premiseObj.visual_action_short}`, 'text overlay at beat moments only', ...zoneRec('mid')],
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
            premise_score: premiseScore,
            premise_drivers: premiseDrivers,
            creator_fit: creatorFit ? {
                score: creatorFit.score,
                drivers: creatorFit.drivers,
                core_premise_score: creatorFit.core_score,
                derived_from_indicators: [
                    'findings.kept_signals.pat_making_v2 (delta_r2=+0.012; 34 videos avg 19.7M vs 5.6M)',
                    'proven_discoveries.title_making_keyword ($24M avg, 23 videos with "Making")',
                    'indicator_registry.visual_is_workshop (r_direct=+0.236, r_partial=+0.219)',
                    'indicator_registry.pre_workshop_x_making (r_partial=+0.229)',
                    'indicator_registry.tension_x_workshop (r_partial=+0.283)',
                    'retention-patterns.top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE (sensory-rate weight +1.59)',
                    'retention-patterns.top_3_drop_causes.TECHNICAL_MATERIAL_LANGUAGE (plastic=-0.171, solid=-0.163, materials=-0.136)',
                    'retention-patterns.top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops)',
                    'retention-patterns.wave11_12.end_begin_ratio (single-shot visible payoff structure)',
                ],
                note: 'Creator-fit is added to the combo score so the diversity-aware selector rewards maker/body/workshop alignment at the concrete premise level. Weights derived from indicator strengths above — no hand-curated creator taste beyond what the corpus already implies.',
            } : null,
            proof_clarity: proofClarity ? {
                score: proofClarity.score,
                drivers: proofClarity.drivers,
                derived_from_indicators: [
                    'retention-patterns.top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops — action frames ARE the proof moment)',
                    'retention-patterns.wave11_12_new_signals.end_begin_ratio (single-shot before/after visible payoff structure)',
                    'findings.proven_discoveries.title_making_keyword ($24M avg, 23 videos with "Making" — build+test hybrids)',
                    'retention-patterns.top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE (sensory-rate weight +1.59 — body/physical payoff is readable)',
                    'indicator_registry.visual_is_workshop r_direct=+0.236 (hands-on-object framing axis)',
                ],
                note: 'Proof-clarity rewards single-shot legible payoffs (build+test hybrids, body before/after anchors, numeric counter freeze + named artifact) and penalizes observation/identity endpoints with no artifact, cognitive/head-framed payoffs, and stacks whose contents are untestable to the viewer. Added to the combo score so the diversity-aware selector and final re-rank both reward mechanism visibility at the concrete premise level. No hand-picked top-5 — every weight reads a factual premise field and cites a corpus indicator.',
            } : null,
            visual_legibility: visualLegibility ? {
                score: visualLegibility.score,
                drivers: visualLegibility.drivers,
                derived_from_indicators: [
                    'retention-patterns.top_3_peak_causes.HIGH_ENERGY_ACTION_FRAMES (28% at peaks vs 8% at drops — action frame at t=0s IS comprehension)',
                    'retention-patterns.top_3_peak_causes.PHYSICAL_SENSORY_LANGUAGE (body-surface visibility; sensory-rate weight +1.59)',
                    'retention-patterns.wave11_12_new_signals.end_begin_ratio (single-frame before/after vs. verdict-the-viewer-trusts)',
                    'indicator_registry.visual_is_workshop r_direct=+0.236 (hands-on-object framing axis)',
                    'findings.kept_signals.pat_making_v2 delta_r2=+0.012 (build/test framing in title)',
                ],
                note: 'Visual-legibility is endpoint-independent. It reads the concrete premise along six axes (invisible body part, cognitive verb without physical action, explicit cognitive surface, title-payoff phrasing, frame-1 comprehensibility, and visual state-contrast) plus an identity/mystery frame-signal check. Designed to catch premises that pass proof-clarity via cosmetic artifact tokens ("stack", "tally", "count overlay") while the actual reveal is a verbal quiz, a social observation, or a cognitive verdict. No abstract classification layer — the six axes are factual premise fields plus the title string. No hand-picked top 5.',
            } : null,
            object_atom_id: obj.id,
            endpoint_atom_id: endpoint.id,
            scale_kind: scale.kind,
            scale_value: scale.value,
            ip_anchor: (() => {
                const detection = detectIpAnchor(title, sourceVideo && sourceVideo.name);
                return {
                    ...detection,
                    scanned_inputs: {
                        idea_title: title,
                        source_video_title: (sourceVideo && sourceVideo.name) || null,
                    },
                    derived_from_indicators: IP_ANCHOR_CORPUS_EVIDENCE,
                    note: 'Deterministic franchise-anchor scan over the emitted title and the source video title. Matched anchors add a boost in scoreIdea() (applied_weight_in_scoreIdea, score, boost_applied are written back at scoring time).',
                };
            })(),
            validated_premise_signature: {
                object_atom_id: obj.id,
                endpoint_atom_id: endpoint.id,
                proof_surface: getProofSurfaceKey(obj),
                title_premise_line: getTitlePremiseLine(premiseObj, premiseObj.concrete_kind),
                action_line: premiseObj.logline_action,
                first_frame_action: premiseObj.first_frame_action,
                setting_hint: premiseObj.setting_hint,
                visible_body_anchor: premiseObj.body_part_phrase,
                scale_kind: scale.kind,
                scale_value: scale.value,
                source_video_override_applied: !!sourcePremise,
                source_grounded_form: sourcePremise
                    ? (sourcePremise.source_grounded_form || 'handcrafted_source_rule')
                    : 'none',
                reveal_phrase_source: sourcePremise && sourcePremise.reveal_phrase
                    ? (sourcePremise.source_grounded_form || 'handcrafted_source_rule')
                    : 'endpoint_kind_default',
            },
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
                'creator_fit ← pat_making_v2 + visual_is_workshop + pre_workshop_x_making + tension_x_workshop + PHYSICAL_SENSORY_LANGUAGE vs TECHNICAL_MATERIAL_LANGUAGE + HIGH_ENERGY_ACTION_FRAMES + end_begin_ratio',
                'proof_clarity ← HIGH_ENERGY_ACTION_FRAMES (action frames IS the proof shot) + end_begin_ratio (single-shot before/after) + title_making_keyword (build+test hybrids) + inverse on abstract/cognitive/untestable-stack payoffs',
                'visual_legibility ← HIGH_ENERGY_ACTION_FRAMES (action verb + gauge/object in frame 1) + PHYSICAL_SENSORY_LANGUAGE (visible body_part_phrase) + end_begin_ratio (title reveal phrasing classified physical vs verbal/observational) + visual_is_workshop (state-contrast in visual_action_short) + inverse on invisible body_parts / cognitive verbs / explicit cognitive-surface copy / verbal-reveal titles / non-comprehensible frame-1 / observation-only identity or mystery cuts',
            ],
            remaining_static_inputs: [
                'source-premise atoms (verb/noun/scale/body_parts/sensation_words/safety_tier)',
                'endpoint atoms (count / timer / distance / body-quit)',
                'build_phases zone boundaries (0-10, 10-25, 25-60, 60-90, 90-100)',
                sourceVideo ? null : 'opening speech rate fallback when no source-video metrics exist',
                'duration_band_id default ("sweet_spot_46_60")',
            ].filter(Boolean),
            still_hardcoded: [
                'source-premise atoms (verb/noun/scale/body_parts/sensation_words/safety_tier)',
                'endpoint atoms (count / timer / distance / body-quit)',
                'build_phases zone boundaries (0-10, 10-25, 25-60, 60-90, 90-100)',
                sourceVideo ? null : 'opening speech rate fallback when no source-video metrics exist',
                'duration_band_id default ("sweet_spot_46_60")',
            ].filter(Boolean),
        },
    };
}

// ──────────────────────────────────────────────────────────────────────
// Validated-video-first seed selection (MMR over premise lanes + explicit proof surfaces)
//
// The old selector carried abstraction-layer bias. That kept the ranking orbiting
// broad abstractions instead of concrete validated idea shapes.
//
// The current selector balances the slate at three explicit levels:
//   1. Premise lane (still stored on each premise atom as `obj.diversity_bucket`
//      for legacy/on-disk compatibility; values: endurance / build_test /
//      body_transformation / mystery_experiment / identity / skill_dare /
//      craft_patience / cognitive_feat / repetition_outreach) — at most 1 per
//      lane until every represented lane has been used once.
//   2. Endpoint kind (count / timer / distance / body / transformation /
//      experiment / identity / build_test) — penalty for repeats, hard cap
//      at 2 per kind.
//   3. Proof surface — soft penalty for repeats on the same visible proof
//      surface (same concrete kind + same body anchor), so the top slate
//      stays idea-specific rather than lane-specific.
//
// Selection uses Maximal-Marginal-Relevance:
//   pick_score(c) = raw_score(c) − λ·similarity(c, already_selected)
// Similarity combines premise-lane, endpoint, and proof-surface overlap.
// Every selection decision is logged to synthesis_trace.diversity_log so the
// reason each slot was chosen is auditable.

function getProofSurfaceKey(obj) {
    const concrete = String(obj.concrete_kind || 'unknown');
    const body = String(obj.body_part_phrase || 'none');
    return `${concrete}__${body}`;
}

function comboSimilarity(a, b) {
    let s = 0;
    if ((a.obj.diversity_bucket || 'unknown') === (b.obj.diversity_bucket || 'unknown')) s += 0.60;
    if (a.endpoint.kind === b.endpoint.kind) s += 0.35;
    if (getProofSurfaceKey(a.obj) === getProofSurfaceKey(b.obj)) s += 0.20;
    return s;
}

// Clusters combos by their premise lane. The lane is still read from
// `obj.diversity_bucket` because that is the on-disk data field; the local name
// reflects the role rather than the legacy field name.
function clusterCombosByDiversityBucket(combos) {
    const clusters = new Map();
    for (const c of combos) {
        const bucket = c.obj.diversity_bucket || 'unknown';
        if (!clusters.has(bucket)) clusters.set(bucket, []);
        clusters.get(bucket).push(c);
    }
    for (const arr of clusters.values()) arr.sort((a, b) => b.score - a.score);
    return clusters;
}

function selectDiverseCombos(combos, maxCount, lambda = 0.55) {
    const clusters = clusterCombosByDiversityBucket(combos);
    const diversityBucketOrder = [...clusters.keys()]
        .map(bucket => ({ bucket, best: clusters.get(bucket)[0] ? clusters.get(bucket)[0].score : -Infinity }))
        .sort((a, b) => b.best - a.best)
        .map(x => x.bucket);

    const picked = [];
    const log = [];
    // Per-pick alternates: premise-id of picked combo → [up to 2 nearby rejected neighbors].
    // Each entry records enough for the UI to render "why the winner beat this one"
    // without dumping the full combo corpus.
    const alternatesByPremiseId = new Map();
    const perDiversityBucket = new Map();
    const perEndpoint = new Map();
    const perProofSurface = new Map();
    const usedPremiseIds = new Set();

    function compactAlt(c, chosen, extra) {
        return {
            premise_id: c.obj.id,
            diversity_bucket: c.obj.diversity_bucket || 'unknown',
            endpoint_id: c.endpoint.id,
            endpoint_kind: c.endpoint.kind,
            proof_surface: getProofSurfaceKey(c.obj),
            raw_score: round(c.score, 3),
            score_delta: round(c.score - chosen.score, 3),
            ...extra,
        };
    }

    // Phase 1: one combo per premise lane, in descending best-lane-score
    // order. This guarantees lane coverage before any second slot is taken.
    for (const bucket of diversityBucketOrder) {
        if (picked.length >= maxCount) break;
        const candidates = clusters.get(bucket) || [];
        let best = null, bestKey = null;
        for (const c of candidates) {
            if (usedPremiseIds.has(c.obj.id)) continue;
            if ((perEndpoint.get(c.endpoint.kind) || 0) >= 2) continue;
            // Prefer candidates whose endpoint is not yet represented
            const key = c.score - 0.25 * (perEndpoint.get(c.endpoint.kind) || 0);
            if (!best || key > bestKey) { best = c; bestKey = key; }
        }
        if (!best) continue;

        // Capture up to 2 nearby within-bucket alternates before mutating state.
        // Cross-lane alternates get picked on their own round, so limiting
        // to the same lane cluster keeps this audit layer focused on the
        // actual decision made at this slot.
        const alts = [];
        for (const c of candidates) {
            if (c === best) continue;
            if (alts.length >= 2) break;
            let reason;
            if (usedPremiseIds.has(c.obj.id)) reason = 'premise-id already selected in earlier slot';
            else if ((perEndpoint.get(c.endpoint.kind) || 0) >= 2) reason = `endpoint-kind cap hit (${c.endpoint.kind}=2)`;
            else reason = 'lower raw score within this premise lane';
            alts.push(compactAlt(c, best, { rejection_reason: reason }));
        }
        alternatesByPremiseId.set(best.obj.id, alts);

        picked.push(best);
        usedPremiseIds.add(best.obj.id);
        perDiversityBucket.set(bucket, (perDiversityBucket.get(bucket) || 0) + 1);
        perEndpoint.set(best.endpoint.kind, (perEndpoint.get(best.endpoint.kind) || 0) + 1);
        perProofSurface.set(getProofSurfaceKey(best.obj), (perProofSurface.get(getProofSurfaceKey(best.obj)) || 0) + 1);
        log.push({
            phase: 'diversity_round_robin',
            slot: picked.length,
            diversity_bucket: bucket,
            premise_id: best.obj.id,
            endpoint_id: best.endpoint.id,
            endpoint_kind: best.endpoint.kind,
            raw_score: best.score,
            diversity_bucket_size: candidates.length,
            reason: `first slot for premise lane "${bucket}" (highest-scoring concrete premise in lane; endpoint rotated; premise-id hard-dedup)`,
        });
    }

    // Phase 2: MMR fill — allow a second pick from the same premise lane
    // only after every lane has been represented and the new combo's
    // marginal relevance beats its similarity penalty against picked slots.
    const alreadyPickedSet = new Set(picked);
    const remaining = combos.filter(c => !alreadyPickedSet.has(c));
    while (picked.length < maxCount && remaining.length) {
        let bestIdx = -1, bestMR = -Infinity, bestSim = 0;
        // Score every remaining combo so we can surface the runners-up that
        // lost to the pick (or were blocked by a cap) — not just find the max.
        const scoredRemaining = [];
        for (let i = 0; i < remaining.length; i++) {
            const c = remaining[i];
            let blocked = null;
            if (usedPremiseIds.has(c.obj.id)) blocked = 'premise-id already selected';
            else if ((perDiversityBucket.get(c.obj.diversity_bucket || 'unknown') || 0) >= 2) blocked = `premise-lane cap hit (${c.obj.diversity_bucket || 'unknown'}=2)`;
            else if ((perEndpoint.get(c.endpoint.kind) || 0) >= 2) blocked = `endpoint-kind cap hit (${c.endpoint.kind}=2)`;
            let sim = 0;
            for (const p of picked) sim = Math.max(sim, comboSimilarity(c, p));
            const mr = c.score - lambda * sim;
            scoredRemaining.push({ i, c, mr, sim, blocked });
            if (!blocked && mr > bestMR) { bestMR = mr; bestIdx = i; bestSim = sim; }
        }
        if (bestIdx < 0) break;
        const chosen = remaining[bestIdx];

        // Runners-up for this slot: everything except the winner, sorted by
        // marginal relevance. Blocked neighbors are still ranked and shown
        // so the "why not this one?" reason is visible.
        const alts = scoredRemaining
            .filter(m => m.c !== chosen)
            .sort((a, b) => b.mr - a.mr)
            .slice(0, 2)
            .map(m => ({
                premise_id: m.c.obj.id,
                diversity_bucket: m.c.obj.diversity_bucket || 'unknown',
                endpoint_id: m.c.endpoint.id,
                endpoint_kind: m.c.endpoint.kind,
                proof_surface: getProofSurfaceKey(m.c.obj),
                raw_score: round(m.c.score, 3),
                mmr_score: round(m.mr, 3),
                similarity: round(m.sim, 3),
                score_delta: round(m.c.score - chosen.score, 3),
                mmr_delta: round(m.mr - bestMR, 3),
                rejection_reason: m.blocked || 'lower mmr(score − λ·sim) at this slot',
            }));
        alternatesByPremiseId.set(chosen.obj.id, alts);

        remaining.splice(bestIdx, 1);
        picked.push(chosen);
        usedPremiseIds.add(chosen.obj.id);
        const bucket = chosen.obj.diversity_bucket || 'unknown';
        perDiversityBucket.set(bucket, (perDiversityBucket.get(bucket) || 0) + 1);
        perEndpoint.set(chosen.endpoint.kind, (perEndpoint.get(chosen.endpoint.kind) || 0) + 1);
        perProofSurface.set(getProofSurfaceKey(chosen.obj), (perProofSurface.get(getProofSurfaceKey(chosen.obj)) || 0) + 1);
        log.push({
            phase: 'mmr_fill',
            slot: picked.length,
            diversity_bucket: bucket,
            premise_id: chosen.obj.id,
            endpoint_id: chosen.endpoint.id,
            endpoint_kind: chosen.endpoint.kind,
            raw_score: chosen.score,
            max_similarity_to_selected: round(bestSim, 3),
            mmr_score: round(bestMR, 3),
            lambda,
            reason: `mmr(score − lambda·max_sim) = ${round(bestMR, 3)}; diversity-bucket cap=2, endpoint-kind cap=2, proof-surface overlap penalty, premise-id hard-dedup`,
        });
    }

    return {
        picked,
        log,
        diversity_bucket_coverage: [...perDiversityBucket.keys()],
        endpoint_coverage: [...perEndpoint.keys()],
        proof_surface_coverage: [...perProofSurface.keys()],
        per_diversity_bucket: Object.fromEntries(perDiversityBucket),
        per_endpoint: Object.fromEntries(perEndpoint),
        per_proof_surface: Object.fromEntries(perProofSurface),
        alternates_by_premise_id: alternatesByPremiseId,
        total_combos_considered: combos.length,
        total_diversity_buckets_considered: clusters.size,
    };
}

function synthesizeSeeds(brief, artifacts, maxCount = 12) {
    // Two seed paths share the pool:
    //   1. Source-video-grounded seeds (every seed cites an exact validated
    //      video in signals-dataset.json) — primary path, ~2/3 of the pool.
    //   2. Synthetic new-concept seeds (corpus pattern × validated IP anchor ×
    //      object, dedup-checked against signals-dataset titles) — ~1/3 of
    //      the pool so NEW project ideas (not just rewrites of existing
    //      videos) surface alongside the validated grounding.
    const validatedTarget = Math.max(2, Math.ceil(maxCount * 2 / 3));
    const vpMax = Math.ceil(validatedTarget * 2 / 3);
    const vpSeeds = synthesizeVideoPrototypeSeeds(brief, artifacts, vpMax);
    const vpYtIds = new Set(
        vpSeeds.map(s => s.synthesis_trace && s.synthesis_trace.source_video_lineage && s.synthesis_trace.source_video_lineage.ytId).filter(Boolean)
    );
    const secondarySeeds = synthesizeValidatedVideoSeeds(brief, artifacts, validatedTarget, vpYtIds);
    const validatedSeeds = interleaveSeeds(vpSeeds, secondarySeeds, validatedTarget)
        .filter(seed => seed && seed.synthesis_trace && seed.synthesis_trace.source_video_lineage);

    const syntheticTarget = Math.max(2, maxCount - validatedSeeds.length);
    const syntheticSeeds = synthesizeSyntheticNewConceptSeeds(brief, artifacts, syntheticTarget)
        .filter(seed => seed && seed.synthesis_trace && seed.synthesis_trace.seed_path === 'synthetic_new_concept');

    return mixValidatedAndSyntheticSeeds(validatedSeeds, syntheticSeeds, maxCount);
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
// IP-anchor signal (v3.6)
//
// Known high-performing franchise anchors measurably lift outcomes in the
// validated corpus, independent of premise/endpoint/proof structure.
// Evidence the boost is grounded in:
//   - indicator-registry.superhero_category: r=0.159 vs log(views); SUPERHERO
//     videos avg 25.0M views (+216% lift); notes explicitly cite "Batman/Iron
//     Man concepts resonate"
//   - indicator-registry.superhero_build_best_converter: SUPERHERO_BUILD
//     converts at 0.194% — 73% better than VEHICLE_MACHINE (0.112%)
//   - indicator-registry.making_superhero_synergy: MAKING+SUPERHERO combo,
//     2.57x synergy ratio, avg 20.4M views
//   - signals-dataset (observed in this corpus): IP-anchored titles avg
//     13.2M views vs 7.7M for non-IP (1.72x lift); keep 78.8 vs 74.3
//   - Concrete evidence: "How I made BULLETPROOF Batman Armour" 80.0M views,
//     "Walking 50,000 steps in Goku Shoes" 20.9M, "Making FIREPROOF Batman
//     Helmet" 18.1M — the franchise anchor is doing measurable work
//
// Detection is deterministic: both the generated idea title and the source
// video title are scanned for franchise aliases using word-boundary matches.
// The detection result is written to synthesis_trace.ip_anchor so the audit
// trail records which anchor was found, where, and how much boost it added.
// ──────────────────────────────────────────────────────────────────────

const IP_ANCHORS = [
    // Marvel
    { id: 'iron_man', franchise: 'Marvel', aliases: ['iron man', 'iron-man', 'ironman'] },
    { id: 'spider_man', franchise: 'Marvel', aliases: ['spider-man', 'spiderman', 'spider man'] },
    { id: 'wolverine', franchise: 'Marvel', aliases: ['wolverine'] },
    { id: 'thor', franchise: 'Marvel', aliases: ['thor'] },
    { id: 'captain_america', franchise: 'Marvel', aliases: ['captain america'] },
    { id: 'hulk', franchise: 'Marvel', aliases: ['hulk'] },
    { id: 'black_panther', franchise: 'Marvel', aliases: ['black panther'] },
    { id: 'doctor_octopus', franchise: 'Marvel', aliases: ['doctor octopus', 'doc ock'] },
    { id: 'deadpool', franchise: 'Marvel', aliases: ['deadpool'] },
    { id: 'venom', franchise: 'Marvel', aliases: ['venom'] },
    { id: 'groot', franchise: 'Marvel', aliases: ['groot'] },
    { id: 'avengers', franchise: 'Marvel', aliases: ['avenger', 'avengers'] },
    // DC
    { id: 'batman', franchise: 'DC', aliases: ['batman'] },
    { id: 'superman', franchise: 'DC', aliases: ['superman'] },
    { id: 'joker', franchise: 'DC', aliases: ['joker'] },
    { id: 'flash', franchise: 'DC', aliases: ['the flash'] },
    // Star Wars
    { id: 'darth_vader', franchise: 'StarWars', aliases: ['darth vader'] },
    { id: 'mandalorian', franchise: 'StarWars', aliases: ['mandalorian'] },
    { id: 'yoda', franchise: 'StarWars', aliases: ['yoda'] },
    { id: 'grogu', franchise: 'StarWars', aliases: ['grogu', 'baby yoda'] },
    // Other franchise IPs validated in corpus or culturally adjacent
    { id: 'predator', franchise: 'Predator', aliases: ['predator'] },
    { id: 'xenomorph', franchise: 'Alien', aliases: ['xenomorph'] },
    { id: 'goku', franchise: 'DragonBall', aliases: ['goku'] },
    { id: 'saiyan', franchise: 'DragonBall', aliases: ['saiyan', 'super saiyan'] },
    { id: 'minecraft', franchise: 'Minecraft', aliases: ['minecraft'] },
    { id: 'mario', franchise: 'Mario', aliases: ['super mario', 'mario'] },
    { id: 'sonic', franchise: 'Sonic', aliases: ['sonic the hedgehog'] },
    { id: 'pokemon', franchise: 'Pokemon', aliases: ['pokemon', 'pokémon'] },
    { id: 'pikachu', franchise: 'Pokemon', aliases: ['pikachu'] },
    { id: 'zelda', franchise: 'Zelda', aliases: ['zelda'] },
    { id: 'terminator', franchise: 'Terminator', aliases: ['terminator', 't-800', 't-1000'] },
    { id: 'godzilla', franchise: 'Godzilla', aliases: ['godzilla'] },
];

const IP_ANCHOR_CORPUS_EVIDENCE = [
    'indicator_registry.superhero_category: r=0.159 vs log(views); SUPERHERO videos avg 25.0M (+216% lift) — notes explicitly name Batman/Iron Man',
    'indicator_registry.superhero_build_best_converter: SUPERHERO_BUILD converts at 0.194% (73% better than VEHICLE_MACHINE 0.112%)',
    'indicator_registry.making_superhero_synergy: MAKING+SUPERHERO 2.57x synergy ratio, 20.4M avg (n=6)',
    'signals-dataset observed: IP-anchored titles 13.2M avg vs 7.7M non-IP (1.72x lift), keep 78.8 vs 74.3',
    'signals-dataset top anchors: "BULLETPROOF Batman Armour" 80.0M, "Walking 50,000 steps in Goku Shoes" 20.9M, "FIREPROOF Batman Helmet" 18.1M',
];

function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Word-boundary match so "thor" doesn't fire on "author" or "thorough".
// Deterministic, no randomness, no LLM calls.
function detectIpAnchor(...texts) {
    const clean = texts.filter(t => t != null && String(t).trim()).map(String);
    if (!clean.length) return { matched: false, anchors: [], franchises: [], source_text: null };
    const joined = clean.join(' | ').toLowerCase();
    const hits = [];
    for (const anchor of IP_ANCHORS) {
        for (const alias of anchor.aliases) {
            const re = new RegExp(`(^|[^a-z0-9])${_escapeRegex(alias)}([^a-z0-9]|$)`, 'i');
            if (re.test(joined)) {
                hits.push({ id: anchor.id, franchise: anchor.franchise, matched_alias: alias });
                break;
            }
        }
    }
    return {
        matched: hits.length > 0,
        anchors: hits,
        franchises: [...new Set(hits.map(h => h.franchise))],
        source_text: clean.join(' | '),
    };
}

// Turns a detection result into a normalized [0,1] score. One franchise
// anchor lands full weight (that's where the Batman-Armor / Goku-Shoes lift
// comes from). Additional anchors give diminishing returns so stacking names
// can't game the signal.
function ipAnchorScore(detection) {
    if (!detection || !detection.matched) return 0;
    const n = detection.anchors.length;
    if (n <= 0) return 0;
    if (n === 1) return 1.0;
    if (n === 2) return 1.0;
    return 1.0; // flat — stacking more names doesn't keep adding lift in corpus
}

// ──────────────────────────────────────────────────────────────────────
// Scoring (carried over from v1) — used for rank ordering
// ──────────────────────────────────────────────────────────────────────

function scoreIdea(idea, brief) {
    const parts = { hook: 0, narrative: 0, duration: 0, bridge: 0, vocabulary: 0, interactions: 0, premise: 0, fit: 0, proof: 0, legibility: 0, ip: 0 };

    // Motif-synthesis score (lattice-driven object/endpoint alignment)
    if (idea.synthesis_trace && typeof idea.synthesis_trace.premise_score === 'number') {
        parts.premise += idea.synthesis_trace.premise_score * 0.15;
    }

    // Creator-fit / production-fit score — biases toward maker/body/workshop
    // DNA. Added as a separate component so it shows up in score_breakdown
    // and the diversity-aware re-rank can trade fit against diversity-bucket spread.
    if (idea.synthesis_trace && idea.synthesis_trace.creator_fit && typeof idea.synthesis_trace.creator_fit.score === 'number') {
        parts.fit += idea.synthesis_trace.creator_fit.score * 0.12;
    }

    // Proof-clarity / mechanism-visibility — biases toward single-shot
    // legible proof moments (build+test hybrids, body before/after,
    // numeric counter freeze + named artifact) and penalizes abstract
    // payoffs. Shown in score_breakdown so the final re-rank sees it.
    if (idea.synthesis_trace && idea.synthesis_trace.proof_clarity && typeof idea.synthesis_trace.proof_clarity.score === 'number') {
        parts.proof += idea.synthesis_trace.proof_clarity.score * 0.14;
    }

    // Visual-legibility (v3.4) — independent of endpoint kind. Biases
    // toward ideas a viewer can comprehend from frame 1 and verify from
    // the final beat (action verb + gauge/object in frame, decisive
    // physical reveal in title, state-contrast in the cut-to), and
    // away from cognitive/abstract premises that gamed proof-clarity via
    // cosmetic artifact tokens. Weighted slightly above proof_clarity
    // because it reads the reveal phrasing directly, not just the
    // endpoint taxonomy.
    if (idea.synthesis_trace && idea.synthesis_trace.visual_legibility && typeof idea.synthesis_trace.visual_legibility.score === 'number') {
        parts.legibility += idea.synthesis_trace.visual_legibility.score * 0.16;
    }

    // IP-anchor signal (v3.6) — franchise anchors (Batman, Iron Man, Goku,
    // Mandalorian, etc.) measurably lift views/keep in the validated corpus
    // independent of premise/proof structure. See IP_ANCHOR_CORPUS_EVIDENCE.
    // Weight 0.14 sits between fit (0.12) and legibility (0.16) — mirrors
    // proof_clarity because the lift magnitude (+216% SUPERHERO, 1.72x IP/non-IP)
    // is comparable to proof-visibility effects in this corpus.
    const IP_ANCHOR_WEIGHT = 0.14;
    if (idea.synthesis_trace && idea.synthesis_trace.ip_anchor && idea.synthesis_trace.ip_anchor.matched) {
        const score = ipAnchorScore(idea.synthesis_trace.ip_anchor);
        parts.ip += score * IP_ANCHOR_WEIGHT;
        idea.synthesis_trace.ip_anchor.applied_weight_in_scoreIdea = IP_ANCHOR_WEIGHT;
        idea.synthesis_trace.ip_anchor.score = score;
        idea.synthesis_trace.ip_anchor.boost_applied = round(score * IP_ANCHOR_WEIGHT, 4);
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

    const total = parts.hook + parts.narrative + parts.duration + parts.bridge + parts.vocabulary + parts.interactions + parts.premise + parts.fit + parts.proof + parts.legibility + parts.ip;
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
    try {
        const mini = variableCatalog.describeVariableMini(key);
        if (!mini || typeof mini !== 'object') return mini;
        return normalizeIndicatorMetadata(mini);
    } catch (e) { return null; }
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
        if (def.diversity_bucket && !row.diversity_bucket) row.diversity_bucket = def.diversity_bucket;
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
            evidence_sources: [
                'retention-patterns.speaking_patterns.opening_density',
                'candidate_proposals.diversity_buckets (opening_speech_rate_3s)',
            ],
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
            rationale: 'Build phases are validated against the top-5 retention predictors + narrative_arc_analysis (best/worst arc labels) + wave7 retention-shape evidence.',
            evidence_sources: [
                'retention-patterns.top_5_retention_predictors',
                'retention-patterns.narrative_arc_analysis',
                'retention-patterns.wave7_new_signals.progression_patterns',
                'retention-patterns.wave9_10_new_signals',
            ],
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

    // ── Creator-fit / production-fit ─────────────────────────────
    {
        const fit = seed.synthesis_trace && seed.synthesis_trace.creator_fit;
        const drivers = (fit && fit.drivers) || [];
        const indicator_keys = [
            'pat_making_v2',
            'title_making_keyword',
            'visual_is_workshop',
            'pre_workshop_x_making',
            'tension_x_workshop',
            'PHYSICAL_SENSORY_LANGUAGE',
            'TECHNICAL_MATERIAL_LANGUAGE',
            'HIGH_ENERGY_ACTION_FRAMES',
            'end_begin_ratio',
        ];
        const top_indicators = [
            { key: 'pat_making_v2', evidence_type: 'findings.kept_signals', delta_r2: 0.012, modality: 'title pattern', quantification: 'Title contains making/build/creat/construct — 34 videos avg 19.7M vs 5.6M', why: 'keep_signal delta_r2=+0.012' },
            { key: 'title_making_keyword', evidence_type: 'proven_discoveries', modality: 'title word', quantification: "'Making' keyword videos avg $24M views (n=23)", why: 'highest-value single title-word pattern in corpus' },
            { key: 'visual_is_workshop', evidence_type: 'indicator_registry', r_direct: 0.236, r_partial: 0.219, modality: 'visual frame', quantification: 'Video shot in workshop-like environment (42/203 positive, 2.6x)', why: 'r_direct=+0.236 vs log(views)' },
            { key: 'pre_workshop_x_making', evidence_type: 'indicator_registry', r_partial: 0.229, r_direct: 0.235, modality: 'pre-upload composite', quantification: 'Workshop × making title interaction', why: '39/203 positive, 2.7x' },
            { key: 'tension_x_workshop', evidence_type: 'indicator_registry', r_partial: 0.283, r_direct: 0.222, modality: 'composite', quantification: 'Narrative tension × workshop visual', why: 'strongest workshop-indicator interaction' },
            { key: 'PHYSICAL_SENSORY_LANGUAGE', evidence_type: 'top_3_peak_causes', modality: 'transcript', quantification: 'Sensory-rate weight +1.59 in retention regression', why: 'painful(+0.059), curious(+0.061), numb(+0.050), stomach(+0.051)' },
            { key: 'TECHNICAL_MATERIAL_LANGUAGE', evidence_type: 'top_3_drop_causes', modality: 'transcript', quantification: 'Material-naming words depress above-baseline retention', why: 'plastic=-0.171, solid=-0.163, materials=-0.136' },
            { key: 'HIGH_ENERGY_ACTION_FRAMES', evidence_type: 'top_3_peak_causes', modality: 'visual', quantification: 'Action frames appear 28% at peaks vs 8% at drops', why: 'feasibility-on-camera proxy for visible-proof moments' },
            { key: 'end_begin_ratio', evidence_type: 'wave11_12', modality: 'retention structure', quantification: 'End-state delta above opening promise', why: 'single-shot visible payoff structure rewards transformation/build endings' },
        ];
        traces.creator_fit = makeTrace({
            field: 'creator_fit',
            rationale: 'Creator-fit is derived purely from corpus indicators that empirically prefer maker/body/workshop DNA: title-level making/build keywords (pat_making_v2, title_making_keyword), workshop/hands-visible framing (visual_is_workshop, pre_workshop_x_making, tension_x_workshop), sensory-over-technical language (top peak/drop causes), and feasible single-shot visible-proof endpoints (HIGH_ENERGY_ACTION_FRAMES, end_begin_ratio). Every weight in computeCreatorFit() cites a specific indicator; no hand-curated creator taste is added beyond what these indicators already imply.',
            evidence_sources: [
                'findings-summary.kept_signals.pat_making_v2',
                'findings-summary.top_discoveries.title_making_keyword',
                'indicator-registry.visual_is_workshop',
                'indicator-registry.pre_workshop_x_making',
                'indicator-registry.tension_x_workshop',
                'retention-patterns.top_3_retention_peak_causes',
                'retention-patterns.top_3_retention_drop_causes',
                'retention-patterns.wave11_12_new_signals.end_begin_ratio',
            ],
            indicators_considered_count: indicator_keys.length,
            indicator_keys,
            top_indicators,
            filter: 'indicators with published r/r_partial/delta_r2 in the evidence lattice above a minimum effect threshold',
            extra: {
                fit_score: fit && fit.score,
                core_premise_score: fit && fit.core_premise_score,
                drivers_triggered: drivers.map(d => ({ driver: d.driver, delta: d.delta, source: d.source })),
                applied_weight_in_scoreIdea: 0.12,
                selection_effect: 'Added to the combo score so the diversity pass and MMR fill both reward maker/body/workshop alignment at the concrete premise level.',
            },
        });
    }

    // ── Proof-clarity / mechanism-visibility ─────────────────────
    {
        const pc = seed.synthesis_trace && seed.synthesis_trace.proof_clarity;
        const pcDrivers = (pc && pc.drivers) || [];
        const indicator_keys = [
            'HIGH_ENERGY_ACTION_FRAMES',
            'end_begin_ratio',
            'title_making_keyword',
            'PHYSICAL_SENSORY_LANGUAGE',
            'visual_is_workshop',
        ];
        const top_indicators = [
            { key: 'HIGH_ENERGY_ACTION_FRAMES', evidence_type: 'top_3_peak_causes', modality: 'visual', quantification: 'Action-frame share at best vs worst moments (28% vs 8%)', why: 'the proof MOMENT is an action frame — visible build/test/body/counter state in one shot' },
            { key: 'end_begin_ratio', evidence_type: 'wave11_12_new_signals', modality: 'retention structure', quantification: 'End-state delta above opening promise', why: 'single-shot before/after / build-test / counter-freeze payoff structure' },
            { key: 'title_making_keyword', evidence_type: 'proven_discoveries', modality: 'title word', quantification: "'Making' keyword videos avg $24M views (n=23)", why: 'build+test hybrids pattern-align here' },
            { key: 'PHYSICAL_SENSORY_LANGUAGE', evidence_type: 'top_3_peak_causes', modality: 'transcript', quantification: 'Sensory-rate weight +1.59', why: 'body/physical payoff reads on camera; cognitive payoff does not' },
            { key: 'visual_is_workshop', evidence_type: 'indicator_registry', r_direct: 0.236, r_partial: 0.219, modality: 'visual frame', quantification: 'hands-on-object framing', why: 'object interaction makes the proof legible vs face-only reaction' },
        ];
        traces.proof_clarity = makeTrace({
            field: 'proof_clarity',
            rationale: 'Proof-clarity rewards ideas with a single-shot legible payoff: build+test hybrids (verb combo match), body-transformation with an explicit before/after anchor (same shot / weigh-in / day 1 vs day N), numeric endpoints with a named artifact in frame (counter/overlay/stack/tower/hull/pedals). Penalizes abstract observation/identity payoffs without artifacts, head/feeling-framed low-action payoffs, and repetition_outreach stacks whose contents are untestable to the viewer. The signal is factual — it reads the title premise line, logline_action, first_frame_action, visual_action_short, endpoint.kind, action_intensity, and body_part_phrase — not taste.',
            evidence_sources: [
                'retention-patterns.top_3_retention_peak_causes.HIGH_ENERGY_ACTION_FRAMES',
                'retention-patterns.wave11_12_new_signals.end_begin_ratio',
                'findings-summary.top_discoveries.title_making_keyword',
                'retention-patterns.top_3_retention_peak_causes.PHYSICAL_SENSORY_LANGUAGE',
                'indicator-registry.visual_is_workshop',
            ],
            indicators_considered_count: indicator_keys.length,
            indicator_keys,
            top_indicators,
            filter: 'factual premise fields × endpoint kind — each driver exposes the matched verb/anchor/artifact and the corpus indicator it cites',
            extra: {
                proof_clarity_score: pc && pc.score,
                drivers_triggered: pcDrivers.map(d => ({
                    driver: d.driver,
                    delta: d.delta,
                    matched: d.matched_build_verb || d.matched_test_verb || d.matched_anchor || d.matched_artifact || null,
                    source: d.source,
                })),
                applied_weight_in_scoreIdea: 0.14,
                selection_effect: 'Added to the combo score so the diversity pass, MMR fill, AND the final blueprint re-rank all reward single-shot visible proof at the concrete premise level.',
            },
        });
    }

    // ── Visual-legibility (v3.4) ─────────────────────────────────
    {
        const vl = seed.synthesis_trace && seed.synthesis_trace.visual_legibility;
        const vlDrivers = (vl && vl.drivers) || [];
        const indicator_keys = [
            'HIGH_ENERGY_ACTION_FRAMES',
            'PHYSICAL_SENSORY_LANGUAGE',
            'end_begin_ratio',
            'visual_is_workshop',
            'pat_making_v2',
        ];
        const top_indicators = [
            { key: 'HIGH_ENERGY_ACTION_FRAMES', evidence_type: 'top_3_peak_causes', modality: 'visual', quantification: 'Action frames appear 28% at peaks vs 8% at drops', why: 'frame-1 comprehensibility IS an action frame at t=0s — action verb in first_frame_action is the opening-second proxy for this cause' },
            { key: 'PHYSICAL_SENSORY_LANGUAGE', evidence_type: 'top_3_peak_causes', modality: 'transcript + framing', quantification: 'Sensory-rate weight +1.59', why: 'visible body_part_phrase (foot/shoulders/stomach/hand) has a surface to film; feeling/head/mind/brain/memory do not' },
            { key: 'end_begin_ratio', evidence_type: 'wave11_12_new_signals', modality: 'retention structure', quantification: 'End-state delta above opening promise', why: 'title premise line reveal phrasing classified: physical single-shot reveals align, verbal/observational reveals regress' },
            { key: 'visual_is_workshop', evidence_type: 'indicator_registry', r_direct: 0.236, r_partial: 0.219, modality: 'visual frame', quantification: 'hands-on-object framing', why: 'state-contrast in visual_action_short (cut between, growing stack, slides out, pedals turning) is the hands-on-object axis applied across the build' },
            { key: 'pat_making_v2', evidence_type: 'findings.kept_signals', delta_r2: 0.012, modality: 'title pattern', quantification: 'Title contains making/build/creat/construct — 34 videos avg 19.7M vs 5.6M', why: 'title_making_keyword pattern aligns with physical reveal phrasing' },
        ];
        traces.visual_legibility = makeTrace({
            field: 'visual_legibility',
            rationale: 'Visual-legibility is endpoint-independent. It reads the concrete premise on six axes — (1) invisible body_part_phrase, (2) cognitive verb without a physical-action verb, (3) explicit cognitive-surface copy, (4) title premise line reveal phrasing classified physical-reveal vs verbal/observational, (5) frame-1 comprehensibility (action verb + gauge/object in first_frame_action), (6) state-contrast in visual_action_short — plus a mystery/identity frame-signal check. Designed to catch premises that gamed proof-clarity via cosmetic proof tokens ("stack of flashcards", "tally", "count overlay") while the actual reveal was a verbal quiz, a social observation, or a cognitive verdict. Every driver exposes the matched phrase or stem and cites an on-disk corpus indicator; no abstract classification layer; no hand-picked top 5.',
            evidence_sources: [
                'retention-patterns.top_3_retention_peak_causes.HIGH_ENERGY_ACTION_FRAMES',
                'retention-patterns.top_3_retention_peak_causes.PHYSICAL_SENSORY_LANGUAGE',
                'retention-patterns.wave11_12_new_signals.end_begin_ratio',
                'indicator-registry.visual_is_workshop',
                'findings-summary.kept_signals.pat_making_v2',
            ],
            indicators_considered_count: indicator_keys.length,
            indicator_keys,
            top_indicators,
            filter: 'six factual premise axes + title string — each driver exposes the matched stem/phrase/body-part and the corpus indicator it cites',
            extra: {
                visual_legibility_score: vl && vl.score,
                drivers_triggered: vlDrivers.map(d => ({
                    driver: d.driver,
                    delta: d.delta,
                    matched: d.matched_cog_verb || d.matched_phys_verb || d.matched_reveal || d.matched || (d.parts && d.parts.join(',')) || null,
                    source: d.source,
                })),
                applied_weight_in_scoreIdea: 0.16,
                selection_effect: 'Added to the combo score alongside proof_clarity so the diversity-aware selector, MMR fill, AND the final blueprint re-rank all push cognitive/abstract/verbal-reveal premises below zero before any top-5 slot is assigned.',
            },
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
            { key: 'progression_pattern_triple_up', evidence_type: 'wave7.progression_patterns', quantification: '↑↑↑ vs ↓↓↓ median views', why: '4.19M vs 222K (19x)' },
            { key: 'best_after_worst', evidence_type: 'wave9_10', quantification: 'median views when nadir precedes climax', why: '5x gap (3.3M vs 650K)' },
        ];
        traces.keep_rate = makeTrace({
            field: 'estimated_metrics.keep_rate',
            rationale: 'Additive model: corpus mean keep + deltas from over-delivery structure, monotonic rise, and nadir placement — each grounded in an explicit retention-pattern signal.',
            evidence_sources: [
                'retention-patterns.top_5_retention_predictors',
                'retention-patterns.wave7_new_signals.progression_patterns',
                'retention-patterns.wave9_10_new_signals.best_after_worst',
                'findings-summary.kept_signals',
            ],
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
        candidate_proposal_diversity_buckets: (brief.source_sizes && brief.source_sizes.candidate_proposal_diversity_buckets) || null,
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
// Validated video anchors — deterministic grounding from signals-dataset
//
// Matches each generated idea against specific videos in signals-dataset.json
// using actual title/premise token overlap plus either source-video concept
// tokens (preferred for source-video seeds) or premise-bucket concept words.
// No LLM calls. Returns top 3 anchors with direct evidence fields so every
// idea card can show which specific real videos validate the format.
// ──────────────────────────────────────────────────────────────────────

const _ANCHOR_STOP_WORDS = new Set([
    'i', 'a', 'an', 'the', 'in', 'on', 'at', 'for', 'to', 'of', 'and', 'or',
    'my', 'it', 'is', 'did', 'does', 'do', 'one', 'day', 'how', 'with', 'all',
    'this', 'that', 'was', 'are', 'be', 'as', 'by', 'not', 'from', 'every',
    'no', 'so', 'up', 'out', 'we', 'me', 'he', 'she', 'you', 'our', 'has',
    'had', 'but', 'just', 'what', 'when', 'where', 'can', 'got', 'get', 'let',
    'way', 'set', 'put', 'than', 'see', 'off', 'two', 'its', 'into', 'over',
    'also', 'only', 'will', 'then', 'them', 'they', 'been', 'were', 'more',
    'some', 'have', 'after',
]);

function _anchorTokenize(text) {
    return String(text || '').toLowerCase()
        .split(/[\s\-_,\.!?'"()/\\:;]+/)
        .filter(t => t.length >= 4 && /^[a-z]+$/.test(t) && !_ANCHOR_STOP_WORDS.has(t));
}

// Returns up to 3 validated video anchors sorted by match quality then metric quality.
// match_tier: 1=strong title overlap, 2=moderate overlap, 3=source/premise overlap, 4=metric anchor
function matchValidatedVideoAnchors(idea, seed, dataset) {
    if (!dataset || !Array.isArray(dataset) || !dataset.length) return [];

    const sourceVideo = (seed && seed.synthesis_trace && seed.synthesis_trace.source_video_lineage) || null;
    const ideaTitleTokens = new Set(_anchorTokenize(idea.title || ''));
    const ideaLoglineTokens = new Set(_anchorTokenize((idea.concept && idea.concept.logline) || idea.one_line_premise || ''));
    const sourceConcepts = sourceVideo ? _anchorTokenize(sourceVideo.name || '') : [];

    const scored = dataset.map(video => {
        const videoTokens = new Set(_anchorTokenize(video.name || ''));
        const videoNameLower = String(video.name || '').toLowerCase();
        const exactSourceMatch = !!(sourceVideo && sourceVideo.ytId && video.ytId === sourceVideo.ytId);

        const titleOverlap = [...ideaTitleTokens].filter(t => videoTokens.has(t));
        const loglineOverlap = [...ideaLoglineTokens].filter(t => videoTokens.has(t) && !ideaTitleTokens.has(t));
        const sourceMatched = sourceConcepts.filter(t => videoNameLower.includes(t));

        const matchTier =
            exactSourceMatch ? 1 :
            titleOverlap.length >= 2 ? 1 :
            titleOverlap.length >= 1 ? 2 :
            sourceMatched.length >= 2 ? 2 :
            loglineOverlap.length >= 1 || sourceMatched.length >= 1 ? 3 : 4;

        // Quality score: z_score and keep_rate are the primary per-video signals in the dataset
        const qualityScore =
            (video.z_score || 0) * 0.4 +
            (video.keep || 0) * 0.03 +
            Math.min(1, Math.log10(Math.max(1, video.views || 1)) / 7) * 2;
        const textBoost = titleOverlap.length * 3 + loglineOverlap.length + sourceMatched.length * 2 + (exactSourceMatch ? 6 : 0);
        const score = ([0, 12, 8, 4, 0][matchTier] || 0) + textBoost + qualityScore;

        const reasons = [];
        if (exactSourceMatch) reasons.push('exact source video');
        if (matchTier === 4) reasons.push('top-metric anchor (no title overlap)');
        if (titleOverlap.length) reasons.push(`title match: ${titleOverlap.slice(0, 3).join(', ')}`);
        if (loglineOverlap.length) reasons.push(`premise match: ${loglineOverlap.slice(0, 2).join(', ')}`);
        if (sourceMatched.length) reasons.push(`source-video overlap: ${sourceMatched.slice(0, 3).join(', ')}`);
        const vFmt = (v) => v == null ? '?' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1000) + 'K';
        reasons.push(`keep=${video.keep != null ? video.keep + '%' : '?'}, z=${video.z_score != null ? video.z_score : '?'}, ${vFmt(video.views)} views`);

        return { video, score, matchTier, reasons };
    });

    // Sort: lower tier (better text match) first, then by quality score
    scored.sort((a, b) => a.matchTier !== b.matchTier ? a.matchTier - b.matchTier : b.score - a.score);

    return scored.slice(0, 3).map(s => ({
        name: s.video.name,
        ytId: s.video.ytId,
        views: s.video.views,
        keep: s.video.keep,
        retention: s.video.retention,
        z_score: s.video.z_score,
        match_tier: s.matchTier,
        match_score: round(s.score, 3),
        why_this_matches: s.reasons.join(' · '),
    }));
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
    const proofScore = seed.synthesis_trace && seed.synthesis_trace.proof_clarity && seed.synthesis_trace.proof_clarity.score;
    const proofDriverCount = seed.synthesis_trace && seed.synthesis_trace.proof_clarity && seed.synthesis_trace.proof_clarity.drivers ? seed.synthesis_trace.proof_clarity.drivers.length : 0;
    const vlTrace = seed.synthesis_trace && seed.synthesis_trace.visual_legibility;
    const vlScore = vlTrace && vlTrace.score;
    const vlDrivers = (vlTrace && vlTrace.drivers) || [];
    const vlPositive = vlDrivers.filter(d => typeof d.delta === 'number' && d.delta > 0).length;
    const vlNegative = vlDrivers.filter(d => typeof d.delta === 'number' && d.delta < 0).length;
    idea.why_it_works = [
        `Specific premise (${seed.title.length <= 90 ? seed.title : seed.title.slice(0, 87) + '…'}) — every concrete choice (object, timer, endpoint) survives the validation filter below.`,
        `Arc = ${idea.arc.arc_shape} with nadir placed at ~${idea.arc.nadir_placement_pct}% (best_after_worst 5x gap).`,
        `Hook-retention@20s modeled ${idea.estimated_metrics.hook_retention_20s.band} (${(idea.estimated_metrics.hook_retention_20s.modeled_value * 100).toFixed(1)}%) — first-20s is the single strongest view predictor (r=0.6).`,
        `Over-delivery structure: hook promises less than the 95% payoff delivers (hook_payoff_gap rewards over-delivery, r=-0.52).`,
        `Vocabulary: commits to ${((seed.vocabulary_hints && seed.vocabulary_hints.use_peak_words) || []).length} peak words and avoids ${((seed.vocabulary_hints && seed.vocabulary_hints.avoid_material_words) || []).length} material-class words.`,
        `Proof-clarity: score=${proofScore != null ? proofScore : '—'} from ${proofDriverCount} drivers (build+test hybrid, body before/after anchor, numeric counter + named artifact) — single-shot legible payoff backed by HIGH_ENERGY_ACTION_FRAMES + end_begin_ratio.`,
        `Visual-legibility: score=${vlScore != null ? vlScore : '—'} from ${vlDrivers.length} drivers (+${vlPositive}/-${vlNegative}) — frame-1 comprehensibility + decisive physical reveal in title + state-contrast in the cut-to; penalizes invisible body parts, cognitive verbs, and verbal/observational reveals regardless of endpoint kind.`,
        `Validation trace: ${secCount} blueprint sections and ${metricCount} modeled metrics carry explicit indicator lineage (pool size, filter, top indicators w/ r/rho/csw and quantification).`,
    ];

    // Validated video anchors — specific grounding from the signals dataset
    idea.validated_video_anchors = matchValidatedVideoAnchors(idea, seed, (artifacts && artifacts.signals) || null);

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
    // Pull a wider pool so the post-blueprint diversity re-rank has room.
    const pool = Math.max(count * 2, 10);
    const seeds = synthesizeSeeds(brief, artifacts, pool);
    const ideas = seeds.map((seed, i) => assembleBlueprint(seed, brief, i + 1, artifacts));

    // Slate-balancing re-rank on blueprint scores. The old code sorted by
    // score_breakdown.total alone, which let one or two premise lanes
    // dominate every top slot because their premise_score advantage propagated.
    // The new rank applies MMR on blueprint totals with premise-lane +
    // endpoint + proof-surface similarity, then enforces per-lane /
    // per-endpoint caps at the final-output level so the same lane cannot
    // take more than ~2 of the top `count` slots when other lanes remain.
    const scored = ideas.map(idea => {
        const seedPath = idea.synthesis_trace && idea.synthesis_trace.seed_path;
        // source_video_primary seeds get the strongest bonus (validated source).
        // synthetic_new_concept seeds get a smaller bonus so corpus-derived
        // NEW project ideas still surface in the top-N alongside grounded ones,
        // without overwhelming the validated path.
        const vpRankBonus = seedPath === 'source_video_primary'
            ? 0.35
            : seedPath === 'synthetic_new_concept'
                ? 0.20
                : 0;
        return {
            idea,
            // Premise-lane axis for final ranking. Active seeds now write
            // only the source-video-led `diversity_bucket` field here.
            bucket: (idea.synthesis_trace && idea.synthesis_trace.diversity_bucket) || 'unknown',
            endpoint_kind: (() => {
                const eid = idea.synthesis_trace && idea.synthesis_trace.endpoint_atom_id;
                const e = ENDPOINT_MOTIFS.find(x => x.id === eid);
                return e ? e.kind : null;
            })(),
            total: ((idea.score_breakdown && idea.score_breakdown.total) || 0) + vpRankBonus,
            proof_surface: (idea.synthesis_trace && idea.synthesis_trace.proof_surface) || null,
            vpRankBonus,
        };
    });
    const perBucketCap = 2;
    const perEndCap = 2;
    const lambda = 0.35;
    const ranked = [];
    const remaining = scored.slice();
    const perBucket = new Map();
    const perEnd = new Map();
    const perProofSurface = new Map();
    // Per-idea displaced alternates captured at the moment each slot was
    // picked. Written back onto idea.synthesis_trace.final_rank_alternates
    // so the UI can show "nearby ideas that lost to this one at top-N".
    const finalAlternatesByIdeaId = new Map();
    while (ranked.length < Math.min(count, scored.length) && remaining.length) {
        let bestIdx = -1, bestMR = -Infinity;
        const scoredRemaining = [];
        for (let i = 0; i < remaining.length; i++) {
            const c = remaining[i];
            let blocked = null;
            if ((perBucket.get(c.bucket) || 0) >= perBucketCap) blocked = `diversity-bucket cap hit (${c.bucket}=${perBucketCap})`;
            else if (c.endpoint_kind && (perEnd.get(c.endpoint_kind) || 0) >= perEndCap) blocked = `endpoint-kind cap hit (${c.endpoint_kind}=${perEndCap})`;
            let sim = 0;
            for (const p of ranked) {
                let s = 0;
                if (p.bucket === c.bucket) s += 0.60;
                if (p.endpoint_kind && p.endpoint_kind === c.endpoint_kind) s += 0.35;
                if (p.proof_surface && p.proof_surface === c.proof_surface) s += 0.20;
                if (s > sim) sim = s;
            }
            const mr = c.total - lambda * sim;
            scoredRemaining.push({ i, c, mr, sim, blocked });
            if (!blocked && mr > bestMR) { bestMR = mr; bestIdx = i; }
        }
        if (bestIdx < 0) {
            // Fall back: relax caps if no valid candidate remains (shouldn't
            // happen given the seed pool, but guard against starvation).
            bestIdx = remaining.findIndex(c => true);
            if (bestIdx < 0) break;
        }
        const chosen = remaining[bestIdx];
        const chosenMR = bestMR;
        const alts = scoredRemaining
            .filter(m => m.c !== chosen)
            .sort((a, b) => b.mr - a.mr)
            .slice(0, 2)
            .map(m => {
                const t = (m.c.idea && m.c.idea.title) || '';
                return {
                    idea_id: m.c.idea && m.c.idea.id,
                    title: t.length > 90 ? t.slice(0, 87) + '…' : t,
                    diversity_bucket: m.c.bucket,
                    endpoint_kind: m.c.endpoint_kind,
                    proof_surface: m.c.proof_surface,
                    blueprint_total: round(m.c.total, 3),
                    mmr_score: round(m.mr, 3),
                    similarity: round(m.sim, 3),
                    total_delta: round(m.c.total - chosen.total, 3),
                    mmr_delta: round(m.mr - chosenMR, 3),
                    rejection_reason: m.blocked || 'lower mmr(total − λ·sim) at this slot',
                };
            });
        if (chosen.idea && chosen.idea.id) finalAlternatesByIdeaId.set(chosen.idea.id, alts);
        remaining.splice(bestIdx, 1);
        ranked.push(chosen);
        perBucket.set(chosen.bucket, (perBucket.get(chosen.bucket) || 0) + 1);
        if (chosen.endpoint_kind) perEnd.set(chosen.endpoint_kind, (perEnd.get(chosen.endpoint_kind) || 0) + 1);
        if (chosen.proof_surface) perProofSurface.set(chosen.proof_surface, (perProofSurface.get(chosen.proof_surface) || 0) + 1);
    }
    const topN = ranked.map(r => r.idea);
    topN.forEach((x, i) => { x.rank = i + 1; });
    // Attach final-rank diversity snapshot to each idea so the audit trail
    // includes which diversity-bucket/endpoint caps were in effect at top-level rank.
    for (let i = 0; i < topN.length; i++) {
        const idea = topN[i];
        if (idea.synthesis_trace) {
            idea.synthesis_trace.final_rank_diversity = {
                per_diversity_bucket_in_topN: Object.fromEntries(perBucket),
                per_endpoint_kind_in_topN: Object.fromEntries(perEnd),
                per_proof_surface_in_topN: Object.fromEntries(perProofSurface),
                caps: { per_diversity_bucket_cap: perBucketCap, per_endpoint_kind_cap: perEndCap },
                mmr_lambda: lambda,
            };
            // Alternates displaced by this idea during final top-N MMR.
            // Captures candidate pressure at the blueprint-total level so
            // Tyler can see which nearby blueprints lost — and why — rather
            // than just the winning slate.
            const alts = finalAlternatesByIdeaId.get(idea.id) || [];
            idea.synthesis_trace.final_rank_alternates = {
                stage: 'final_rank',
                slot: i + 1,
                ideas_considered: scored.length,
                caps_in_effect: { per_diversity_bucket_cap: perBucketCap, per_endpoint_kind_cap: perEndCap },
                mmr_lambda: lambda,
                nearby_displaced: alts,
                note: 'Top 2 blueprints that lost to this idea during the final MMR re-rank. Rejection reasons: diversity-bucket cap, endpoint-kind cap, or lower MMR(total − λ·sim) against already-ranked slots.',
            };
        }
    }
    // Per-idea aggregate evidence/lineage summary. Computed last so it can
    // fold in both seed-stage and final-rank alternates.
    for (const idea of topN) {
        const summary = computeEvidenceSummary(idea);
        if (summary) {
            idea.evidence_summary = summary;
            if (idea.validation) idea.validation.summary = summary;
        }
    }
    return topN;
}

// Aggregate per-idea evidence/lineage summary. Rolls the section and metric
// validation traces (plus seed/final-rank alternates) into a compact top-level
// block so the UI card can answer "how much evidence supports this idea?"
// without expanding every trace. Raw totals are reported alongside unique
// indicator counts so a reader can tell whether an indicator is load-bearing
// across many sections or only referenced once.
function computeEvidenceSummary(idea) {
    const v = idea && idea.validation;
    if (!v) return null;
    const sections = v.section_traces || {};
    const metrics = v.metric_traces || {};
    let indicatorsConsideredRaw = 0;
    let indicatorKeysUsedRaw = 0;
    const uniqSection = new Set();
    const uniqMetric = new Set();
    const uniqAll = new Set();
    for (const s of Object.values(sections)) {
        indicatorsConsideredRaw += (+s.indicators_considered_count) || 0;
        const keys = Array.isArray(s.indicator_keys) ? s.indicator_keys : [];
        indicatorKeysUsedRaw += keys.length;
        for (const k of keys) {
            const key = String(k);
            uniqSection.add(key);
            uniqAll.add(key);
        }
    }
    for (const m of Object.values(metrics)) {
        indicatorsConsideredRaw += (+m.indicators_considered_count) || 0;
        const keys = Array.isArray(m.indicator_keys) ? m.indicator_keys : [];
        indicatorKeysUsedRaw += keys.length;
        for (const k of keys) {
            const key = String(k);
            uniqMetric.add(key);
            uniqAll.add(key);
        }
    }
    const st = idea.synthesis_trace || {};
    const seedAlts = (st.seed_alternates && Array.isArray(st.seed_alternates.nearby_rejected))
        ? st.seed_alternates.nearby_rejected : [];
    const finalAlts = (st.final_rank_alternates && Array.isArray(st.final_rank_alternates.nearby_displaced))
        ? st.final_rank_alternates.nearby_displaced : [];
    const seedPool = (st.seed_alternates && st.seed_alternates.candidates_considered) || null;
    const finalPool = (st.final_rank_alternates && st.final_rank_alternates.ideas_considered) || null;
    return {
        section_trace_count: Object.keys(sections).length,
        metric_trace_count: Object.keys(metrics).length,
        indicators_considered_total_raw: indicatorsConsideredRaw,
        indicator_keys_used_total_raw: indicatorKeysUsedRaw,
        unique_indicator_keys_used: uniqAll.size,
        unique_indicator_keys_used_in_sections: uniqSection.size,
        unique_indicator_keys_used_in_metrics: uniqMetric.size,
        nearby_alternates_total: seedAlts.length + finalAlts.length,
        nearby_alternates_seed_stage: seedAlts.length,
        nearby_alternates_final_rank: finalAlts.length,
        seed_pool_candidates_considered: seedPool,
        final_rank_pool_ideas_considered: finalPool,
        note: 'Raw totals sum across traces and can double-count indicators reused in multiple sections. "unique_indicator_keys_used" deduplicates.',
    };
}

function buildModel(opts = {}) {
    const artifacts = loadAllArtifacts(opts);
    return { brief: compress(artifacts), artifacts };
}

function buildIdeas(count = 5, opts = {}) {
    const { brief, artifacts } = buildModel(opts);
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
