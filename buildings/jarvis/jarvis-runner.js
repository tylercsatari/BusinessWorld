/**
 * jarvis-runner.js — Node-native Jarvis pipeline runner.
 * Replaces Python pipeline.py for hosted (Render) execution.
 * Uses jarvis-store.js for R2 persistence, jarvis-metrics.js for stats.
 */

const fs = require('fs');
const path = require('path');
const metrics = require('./jarvis-metrics');
const jarvisStore = require('./jarvis-store');

const VIDEO_DATA_DIR = path.join(__dirname, '..', '..', 'video_data');

// ── Helpers ──────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

function log(msg) {
    const line = `[jarvis-runner ${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(line);
    // Append to runner log buffer (read by server for logTail)
    if (module.exports._logBuffer != null) {
        module.exports._logBuffer += line + '\n';
        if (module.exports._logBuffer.length > 32768)
            module.exports._logBuffer = module.exports._logBuffer.slice(-32768);
    }
}


// ── Video corpus loader ──────────────────────────────────────────────────

function loadVideos() {
    const videos = [];
    if (!fs.existsSync(VIDEO_DATA_DIR)) {
        log(`ERROR: video_data dir not found: ${VIDEO_DATA_DIR}`);
        return videos;
    }
    const dirs = fs.readdirSync(VIDEO_DATA_DIR);
    for (const d of dirs) {
        const ap = path.join(VIDEO_DATA_DIR, d, 'analysis.json');
        try {
            if (!fs.existsSync(ap)) continue;
            const data = JSON.parse(fs.readFileSync(ap, 'utf8'));
            const analytics = data.analytics || {};
            if (analytics.retentionCurve && analytics.avgRetention != null) {
                data._ytId = d;
                videos.push(data);
            }
        } catch { /* skip bad files */ }
    }
    log(`Loaded ${videos.length} videos`);
    return videos;
}


// ── Pipeline steps ───────────────────────────────────────────────────────

function stepPrepDataset(key, videos) {
    const dataset = [];
    const skipCounts = {};
    for (const vid of videos) {
        const viewCount = (vid.metadata || {}).viewCount || 0;
        if (!viewCount) { skipCounts['no viewCount'] = (skipCounts['no viewCount'] || 0) + 1; continue; }
        const [value, skipReason] = metrics.extractMetric(key, vid);
        if (value == null || !isFinite(value)) {
            const r = skipReason || 'invalid value';
            skipCounts[r] = (skipCounts[r] || 0) + 1;
            continue;
        }
        dataset.push({
            ytId: vid._ytId,
            value: Number(value),
            target_value: Math.log10(viewCount),
        });
    }
    const skipped = Object.values(skipCounts).reduce((a, b) => a + b, 0);
    log(`  [DATASET]   ${dataset.length} videos, ${skipped} skipped`);
    return dataset;
}

function stepRunExperiment(key, dataset, tools) {
    const tool = tools.find(t => t.id === 'pearson_r');
    if (!tool) { log('  [EXPERIMENT] ERROR: pearson_r tool not found'); return null; }

    const minN = 50;
    if (dataset.length < minN) {
        log(`  [EXPERIMENT] SKIP: ${dataset.length} < min_n=${minN}`);
        return null;
    }

    // Filter NaN/Inf
    const clean = dataset.filter(d => isFinite(d.value) && isFinite(d.target_value));
    const n = clean.length;
    if (n < minN) { log(`  [EXPERIMENT] SKIP after clean: ${n} < ${minN}`); return null; }

    const x = clean.map(d => d.value);
    const y = clean.map(d => d.target_value);

    // Pearson r + 95% CI via Fisher z-transform
    const pr = metrics.pearsonr(x, y);
    const r = pr.r, pVal = pr.p;
    const z = 0.5 * Math.log((1 + r + 1e-10) / (1 - r + 1e-10));
    const se = 1.0 / Math.sqrt(Math.max(n - 3, 1));
    const ciLow = Math.tanh(z - 1.96 * se);
    const ciHigh = Math.tanh(z + 1.96 * se);

    // Spearman rho
    const sr = metrics.spearmanr(x, y);
    const rho = sr.r || sr.rho || 0;
    const pRho = sr.p || 1;

    const expId = `exp_${key}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;

    log(`  [EXPERIMENT] Pearson r=${r.toFixed(3)}, rho=${rho.toFixed(3)}, p=${pVal.toFixed(4)}, n=${n}`);

    return {
        id: expId,
        tool_id: 'pearson_r',
        tool_version: tool.version || '1.0',
        tool_name: tool.name,
        parameters: { target: 'views', transform_target: 'log10', confounds: [], min_n: minN },
        ran_at: nowIso(),
        n_videos: n,
        outputs: {
            r: r, p_value: pVal, n: n,
            ci_low: ciLow, ci_high: ciHigh,
            rho: rho, p_rho: pRho,
        },
    };
}

function stepBuildResult(key, exp) {
    const r = exp.outputs.r;
    const rho = exp.outputs.rho;
    const n = exp.outputs.n;
    const p = exp.outputs.p_value;
    const ciLow = exp.outputs.ci_low;
    const ciHigh = exp.outputs.ci_high;

    const absR = Math.abs(r);
    const direction = r >= 0 ? 'positive' : 'negative';
    const strengthLabel = absR >= 0.5 ? 'strong' : absR >= 0.3 ? 'moderate' : absR >= 0.1 ? 'weak' : 'none';

    const defn = metrics.getMetricDefinition(key) || {};
    const desc = defn.description || key;
    const shortDesc = desc.split('—')[0].trim();

    let conclusion, practicalInsight;
    if (strengthLabel === 'none') {
        conclusion = `No meaningful linear relationship found between ${key} and views ` +
            `(r=${r.toFixed(3)}, 95% CI [${ciLow.toFixed(3)}, ${ciHigh.toFixed(3)}], p=${p.toFixed(4)}, n=${n}). ` +
            `Spearman rho=${rho.toFixed(3)} also confirms no rank-order relationship.`;
        practicalInsight = `${shortDesc} does not meaningfully predict views. Safe to deprioritize.`;
    } else {
        const dirWord = direction === 'positive' ? 'positively' : 'negatively';
        const linearNote = Math.abs(absR - Math.abs(rho)) < 0.1 ? 'linear' : 'partially non-linear';
        conclusion = `${desc} Is ${strengthLabel}ly ${dirWord} correlated with views ` +
            `(r=${r.toFixed(3)}, 95% CI [${ciLow.toFixed(3)}, ${ciHigh.toFixed(3)}], p=${p.toFixed(4)}, n=${n}). ` +
            `Spearman rho=${rho.toFixed(3)} confirms a ${linearNote} relationship. ` +
            `${direction === 'positive' ? 'Higher' : 'Lower'} ${key} values predict more views.`;
        practicalInsight = direction === 'positive'
            ? `Maximize ${shortDesc.toLowerCase()} to increase views.`
            : `Minimize ${shortDesc.toLowerCase()} to increase views.`;
    }

    log(`  [RESULT]    ${strengthLabel} ${direction}: ${practicalInsight}`);
    return {
        primary_r: r, rho, p_value: p,
        ci_low: ciLow, ci_high: ciHigh,
        direction, strength_label: strengthLabel,
        status: 'discovery', conclusion, practical_insight: practicalInsight,
    };
}

function stepResolve(key, resolutions) {
    const resInfo = metrics.getResolutionForKey(key);
    const resolutionId = resInfo[0];
    const exists = resolutions.some(r => r.id === resolutionId);

    if (!exists) {
        let defn = metrics.DEFAULT_RESOLUTION_DEFS[resolutionId];
        if (!defn) {
            const [, sp, ep, sd, ed] = resInfo;
            let label, desc, gran;
            if (sp != null && ep != null) {
                if (sp === ep) { label = `${sp}% Point`; desc = `Single-point at ${sp}%.`; gran = 'video_window'; }
                else { label = `${sp}-${ep}% of Video`; desc = `Retention window ${sp}%-${ep}%.`; gran = (sp === 0 && ep === 100) ? 'whole' : 'video_window'; }
            } else if (sd != null && ed != null) {
                label = `Days ${sd}-${ed}`; desc = `View data days ${sd}-${ed}.`; gran = 'time_window';
            } else {
                label = resolutionId; desc = 'Auto-generated resolution.'; gran = 'whole';
            }
            defn = { id: resolutionId, label, description: desc, start_pct: sp, end_pct: ep, start_day: sd, end_day: ed, granularity: gran };
        }
        resolutions.push({
            ...defn,
            created_from: 'pipeline',
            created_at: nowIso(),
            indicator_keys: [],
            depth_in_hierarchy: resolutionId === 'r0' ? 0 : 1,
        });
        resolutions.sort((a, b) => (a.start_pct ?? 999) - (b.start_pct ?? 999) || a.id.localeCompare(b.id));
        log(`  [RESOLVE]   New shelf: ${resolutionId} (${defn.label})`);
    }

    for (const r of resolutions) {
        if (r.id === resolutionId) {
            if (!r.indicator_keys) r.indicator_keys = [];
            if (!r.indicator_keys.includes(key)) r.indicator_keys.push(key);
            break;
        }
    }
    return resolutionId;
}

/**
 * Rebuild node.connections from graph.edges + graph.derived_edges
 * so atomic nodes reflect all their real connections (not just "views").
 */
function rebuildConnections(graph) {
    const connMap = {};  // key → Set of connected keys
    for (const e of (graph.edges || [])) {
        if (!connMap[e.from]) connMap[e.from] = new Set();
        if (!connMap[e.to]) connMap[e.to] = new Set();
        connMap[e.from].add(e.to);
        connMap[e.to].add(e.from);
    }
    for (const de of (graph.derived_edges || [])) {
        if (!connMap[de.from]) connMap[de.from] = new Set();
        if (!connMap[de.to]) connMap[de.to] = new Set();
        connMap[de.from].add(de.to);
        connMap[de.to].add(de.from);
        // Also connect both to the target (e.g. "views")
        if (de.target) {
            connMap[de.from].add(de.target);
            connMap[de.to].add(de.target);
        }
    }
    for (const node of (graph.nodes || [])) {
        const set = connMap[node.key] || new Set();
        node.connections = [...set];
    }
}

function stepUpdateGraph(indicator, graph) {
    const key = indicator.key;
    const target = indicator.target;
    const isComposite = metrics.isCompositeKey(key);

    if (isComposite) {
        // Composite: add a derived edge referencing component keys, no atomic node
        const parsed = metrics.parseCompositeKey(key);
        if (!graph.derived_edges) graph.derived_edges = [];
        graph.derived_edges = graph.derived_edges.filter(e =>
            e.interaction_key !== key && e.experiment_key !== key);
        graph.derived_edges.push({
            from: parsed.a,
            to: parsed.b,
            kind: 'interaction_to_views',
            depth: 2,
            target,
            interaction_key: key,
            experiment_key: key,
            interaction_r: indicator.result.primary_r,
            component_keys: [parsed.a, parsed.b],
            experiment_id: indicator.experiment.id,
            strength_label: indicator.result.strength_label,
            direction: indicator.result.direction,
            added_at: nowIso(),
        });
        graph.updated_at = nowIso();
        log(`  [GRAPH]     Derived edge added: ${parsed.a} × ${parsed.b} → '${target}', depth=2`);
    } else {
        // Atomic: add node + edge as before
        const depth = 1;
        const node = {
            key, label: indicator.label, type: 'indicator',
            layer: indicator.layer, depth,
            r_partial: indicator.result.primary_r,
            resolution_id: indicator.resolution_id,
            connections: [target],
            description: (indicator.metric_definition || {}).description || key,
            experiment_id: indicator.experiment.id,
            status: indicator.result.status,
            strength_label: indicator.result.strength_label,
        };

        graph.nodes = (graph.nodes || []).filter(n => n.key !== key);
        graph.nodes.push(node);

        const edge = {
            from: key, to: target,
            r: indicator.result.primary_r,
            experiment_id: indicator.experiment.id,
            added_at: nowIso(),
        };
        graph.edges = (graph.edges || []).filter(e => !(e.from === key && e.to === target));
        graph.edges.push(edge);
        graph.updated_at = nowIso();
        log(`  [GRAPH]     Node added, depth=${depth}, → '${target}'`);
    }

    // Sync all node.connections from edges + derived_edges
    rebuildConnections(graph);
}


// ── Process one indicator ────────────────────────────────────────────────

function processIndicator(key, videos, existingKeys, resolutions, graph, tools) {
    log(`\n${'='.repeat(50)}`);
    log(`INDICATOR: ${key}`);

    if (existingKeys.has(key)) { log('  Already exists — skip'); return null; }

    const metricDef = metrics.getMetricDefinition(key);
    if (!metricDef) { log('  No metric definition — skip'); return null; }

    const resolutionId = stepResolve(key, resolutions);

    const dataset = stepPrepDataset(key, videos);
    if (dataset.length < 50) { log(`  Only ${dataset.length} videos — skip`); return null; }

    const target = 'views';
    const exp = stepRunExperiment(key, dataset, tools);
    if (!exp) return null;

    const result = stepBuildResult(key, exp);

    const isComposite = metrics.isCompositeKey(key);
    const parsed = isComposite ? metrics.parseCompositeKey(key) : null;

    const indicator = {
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        layer: metricDef.layer || 'post',
        status: result.status,
        resolution_id: resolutionId,
        depth: 1,
        target,
        metric_definition: metricDef,
        dataset,
        experiment: exp,
        result,
        connections: [target],
        created_at: nowIso(),
        updated_at: nowIso(),
    };

    // Add composite-specific fields
    if (isComposite && parsed) {
        indicator.kind = 'interaction_to_views';
        indicator.depth = 2;
        indicator.component_keys = [parsed.a, parsed.b];
        indicator.derived_formula = `${parsed.a} * ${parsed.b}`;
    }

    stepUpdateGraph(indicator, graph);
    log(`  [DONE]      r=${result.primary_r.toFixed(3)} (${result.strength_label} ${result.direction})`);
    return indicator;
}


// ── Progress tracking ────────────────────────────────────────────────────

function initProgress(runId, requestedIterations) {
    return {
        active: true, run_id: runId, mode: 'hybrid_auto',
        started_at: nowIso(), updated_at: nowIso(), finished_at: null,
        requested_iterations: requestedIterations,
        attempted: 0, completed: 0, failures: 0,
        llm_proposed: 0, llm_completed: 0,
        no_signal_streak: 0, stop_reason: null,
        current_candidate: null, last_completed_candidate: null, last_completed_r: null,
        recent_events: [],
    };
}

async function updateProgress(prog, updates) {
    Object.assign(prog, updates);
    prog.updated_at = nowIso();
    try { await jarvisStore.saveJson('autonomous_progress', prog); } catch { /* best-effort */ }
}

function appendProgressEvent(prog, event) {
    event.ts = nowIso();
    prog.recent_events = prog.recent_events || [];
    prog.recent_events.push(event);
    if (prog.recent_events.length > 20) prog.recent_events = prog.recent_events.slice(-20);
}

async function finishProgress(prog, stopReason) {
    await updateProgress(prog, { active: false, finished_at: nowIso(), stop_reason: stopReason, current_candidate: null });
}


// ── Queue runner (--run N) ───────────────────────────────────────────────

async function runQueue(nToRun) {
    log(`Queue run: ${nToRun} indicators`);
    const indicators = await jarvisStore.loadJson('indicators', []);
    const derivedExperiments = await jarvisStore.loadJson('derived_experiments', []);
    const tools = await jarvisStore.loadJson('tools', []);
    const resolutions = await jarvisStore.loadJson('resolutions', []);
    const graph = await jarvisStore.loadJson('graph', { nodes: [], edges: [], derived_edges: [] });
    rebuildConnections(graph);  // migrate existing node.connections
    const queue = await jarvisStore.loadJson('candidate_queue', metrics.DEFAULT_CANDIDATES);
    const existingKeys = new Set([...indicators.map(i => i.key), ...derivedExperiments.map(d => d.key)]);

    const videos = loadVideos();
    if (!videos.length) { log('ERROR: No videos loaded'); return; }

    let ran = 0;
    for (const key of queue) {
        if (ran >= nToRun) break;
        if (existingKeys.has(key)) continue;

        const result = processIndicator(key, videos, existingKeys, resolutions, graph, tools);
        if (result) {
            const isComposite = metrics.isCompositeKey(key);
            if (isComposite) {
                // Store compact form only (no dataset) to avoid 512MB+ bloat
                const rVal = (result.result && result.result.r) ||
                    (result.experiment && result.experiment.outputs && result.experiment.outputs.r) || null;
                derivedExperiments.push({
                    key: result.key,
                    r: rVal,
                    status: result.status,
                    layer: result.layer,
                    target: result.target,
                    resolution_id: result.resolution_id,
                    kind: 'interaction',
                });
            } else {
                indicators.push(result);
            }
            const expLog = await jarvisStore.loadJson('experiments_log', []);
            expLog.push({
                id: result.experiment.id,
                indicator_key: key,
                tool_id: result.experiment.tool_id,
                tool_name: result.experiment.tool_name,
                target: result.target,
                parameters: result.experiment.parameters,
                outputs: result.experiment.outputs,
                n_videos: result.experiment.n_videos,
                status: result.result.status,
                ran_at: result.experiment.ran_at,
                kind: isComposite ? 'interaction' : 'atomic',
            });
            await jarvisStore.saveJson('experiments_log', expLog);
            await jarvisStore.saveJson('indicators', indicators);
            await jarvisStore.saveJson('derived_experiments', derivedExperiments);
            await jarvisStore.saveJson('resolutions', resolutions);
            await jarvisStore.saveJson('graph', graph);
            existingKeys.add(key);
            ran++;
        }
    }
    log(`Queue run complete: ${ran} indicators processed`);
}


// ── Autonomous runner (--auto-run N) ─────────────────────────────────────

async function autoRun(opts = {}) {
    const {
        maxIterations = 10,
        maxMinutes = null,
        maxFailures = null,
        maxNoSignal = null,
        preuploadRatio = null,
    } = opts;

    const startTime = Date.now();
    const runId = `auto_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;

    log(`\n${'='.repeat(60)}`);
    log(`AUTONOMOUS RUN: ${runId}`);
    log(`  maxIterations=${maxIterations}, maxMinutes=${maxMinutes}, maxFailures=${maxFailures}, maxNoSignal=${maxNoSignal}, preuploadRatio=${preuploadRatio}`);

    const prog = initProgress(runId, maxIterations);
    await updateProgress(prog, {});

    const indicators = await jarvisStore.loadJson('indicators', []);
    const derivedExperiments = await jarvisStore.loadJson('derived_experiments', []);
    const tools = await jarvisStore.loadJson('tools', []);
    const resolutions = await jarvisStore.loadJson('resolutions', []);
    const graph = await jarvisStore.loadJson('graph', { nodes: [], edges: [], derived_edges: [] });
    rebuildConnections(graph);  // migrate existing node.connections
    const existingKeys = new Set([...indicators.map(i => i.key), ...derivedExperiments.map(d => d.key)]);

    // No LLM on hosted path — deterministic only (llm_proposed = 0)
    await updateProgress(prog, { llm_proposed: 0 });

    // Build candidate pool: auto-generated + legacy queue
    const autoCandidates = metrics.generateAutonomousCandidates();
    const queueCandidates = await jarvisStore.loadJson('candidate_queue', metrics.DEFAULT_CANDIDATES);
    const seen = new Set();
    let merged = [];
    for (const k of autoCandidates) { if (!seen.has(k)) { seen.add(k); merged.push(k); } }
    for (const k of queueCandidates) { if (!seen.has(k)) { seen.add(k); merged.push(k); } }

    let pool = merged.filter(k => !existingKeys.has(k));

    if (preuploadRatio != null) {
        const preCt = pool.filter(k => metrics.getCandidateLayer(k) === 'pre').length;
        log(`Pool before bias: ${preCt} pre, ${pool.length - preCt} post`);
        pool = metrics.biasPool(pool, preuploadRatio);
    }

    log(`Candidate pool: ${pool.length} unrun (${existingKeys.size} already done)`);

    // Load videos
    const videos = loadVideos();
    if (!videos.length) {
        log('ERROR: No videos loaded');
        await finishProgress(prog, 'no_videos');
        return;
    }

    let attempted = 0, completed = 0, failures = 0;
    let consecutiveFailures = 0, noSignalStreak = 0;
    let stopReason = 'exhausted_candidates';
    const processedKeys = [];
    let topRAbs = 0;
    let preAttempted = 0, preCompleted = 0, postAttempted = 0, postCompleted = 0;

    try {
        for (const key of pool) {
            // Stop conditions
            if (attempted >= maxIterations) { stopReason = 'max_iterations'; break; }
            if (maxMinutes && (Date.now() - startTime) / 60000 >= maxMinutes) { stopReason = 'max_minutes'; break; }
            if (maxFailures && consecutiveFailures >= maxFailures) { stopReason = 'max_failures'; break; }
            if (maxNoSignal && noSignalStreak >= maxNoSignal) { stopReason = 'max_no_signal'; break; }

            attempted++;
            const keyLayer = metrics.getCandidateLayer(key);
            const isPre = keyLayer === 'pre';
            if (isPre) preAttempted++; else postAttempted++;

            await updateProgress(prog, {
                current_candidate: key, attempted, completed, failures,
                no_signal_streak: noSignalStreak,
                pre_attempted: preAttempted, pre_completed: preCompleted,
                post_attempted: postAttempted, post_completed: postCompleted,
            });

            const result = processIndicator(key, videos, existingKeys, resolutions, graph, tools);

            if (result) {
                const isComposite = metrics.isCompositeKey(key);
                if (isComposite) {
                    // Store compact form only (no dataset) to avoid 512MB+ bloat
                    const rVal = (result.result && result.result.r) ||
                        (result.experiment && result.experiment.outputs && result.experiment.outputs.r) || null;
                    derivedExperiments.push({
                        key: result.key,
                        r: rVal,
                        status: result.status,
                        layer: result.layer,
                        target: result.target,
                        resolution_id: result.resolution_id,
                        kind: 'interaction',
                    });
                } else {
                    indicators.push(result);
                }
                const expLog = await jarvisStore.loadJson('experiments_log', []);
                expLog.push({
                    id: result.experiment.id,
                    indicator_key: key,
                    tool_id: result.experiment.tool_id,
                    tool_name: result.experiment.tool_name,
                    target: result.target,
                    parameters: result.experiment.parameters,
                    outputs: result.experiment.outputs,
                    n_videos: result.experiment.n_videos,
                    status: result.result.status,
                    ran_at: result.experiment.ran_at,
                    source: 'deterministic',
                    kind: isComposite ? 'interaction' : 'atomic',
                });
                await jarvisStore.saveJson('experiments_log', expLog);
                await jarvisStore.saveJson('indicators', indicators);
                await jarvisStore.saveJson('derived_experiments', derivedExperiments);
                await jarvisStore.saveJson('resolutions', resolutions);
                await jarvisStore.saveJson('graph', graph);
                existingKeys.add(key);

                completed++;
                if (isPre) preCompleted++; else postCompleted++;
                consecutiveFailures = 0;
                processedKeys.push(key);

                const rVal = result.result.primary_r;
                const rAbs = Math.abs(rVal);
                if (rAbs > topRAbs) topRAbs = rAbs;
                if (rAbs < 0.05) noSignalStreak++; else noSignalStreak = 0;

                appendProgressEvent(prog, {
                    type: 'completed', key,
                    r: Math.round(rVal * 10000) / 10000,
                    resolution_id: result.resolution_id || 'r0',
                    target: result.target || 'views',
                    layer: keyLayer,
                });
                await updateProgress(prog, {
                    completed, failures, no_signal_streak: noSignalStreak,
                    last_completed_candidate: key,
                    last_completed_r: Math.round(rVal * 10000) / 10000,
                    pre_attempted: preAttempted, pre_completed: preCompleted,
                    post_attempted: postAttempted, post_completed: postCompleted,
                });
            } else {
                failures++;
                consecutiveFailures++;
                processedKeys.push(`FAIL:${key}`);
                appendProgressEvent(prog, { type: 'failed', key, reason: 'processIndicator returned null', layer: keyLayer });
                await updateProgress(prog, {
                    failures, no_signal_streak: noSignalStreak,
                    pre_attempted: preAttempted, pre_completed: preCompleted,
                    post_attempted: postAttempted, post_completed: postCompleted,
                });
            }
        }
    } catch (err) {
        log(`CRASH: ${err.message}`);
        await finishProgress(prog, `crashed: ${String(err.message).slice(0, 200)}`);
        throw err;
    }

    await finishProgress(prog, stopReason);

    const elapsedMin = (Date.now() - startTime) / 60000;

    // Save run record
    const runRecord = {
        id: runId,
        started_at: new Date(startTime).toISOString(),
        finished_at: nowIso(),
        mode: 'hybrid_auto',
        llm_proposed: 0,
        llm_completed: 0,
        attempted, completed, failures,
        pre_attempted: preAttempted, pre_completed: preCompleted,
        post_attempted: postAttempted, post_completed: postCompleted,
        preupload_ratio_requested: preuploadRatio,
        no_signal_streak_end: noSignalStreak,
        stop_reason: stopReason,
        candidate_keys_processed: processedKeys.slice(0, 200),
        top_new_r_abs: Math.round(topRAbs * 10000) / 10000,
        elapsed_minutes: Math.round(elapsedMin * 100) / 100,
        total_indicators_after: indicators.length,
        total_derived_after: derivedExperiments.length,
    };

    const runs = await jarvisStore.loadJson('autonomous_runs', []);
    runs.push(runRecord);
    await jarvisStore.saveJson('autonomous_runs', runs);

    log(`\n${'='.repeat(60)}`);
    log(`AUTONOMOUS RUN COMPLETE: ${runId}`);
    log(`  Attempted: ${attempted}, Completed: ${completed}, Failures: ${failures}`);
    log(`  Pre: ${preAttempted}/${preCompleted}, Post: ${postAttempted}/${postCompleted}`);
    log(`  Stop: ${stopReason}, Top |r|: ${topRAbs.toFixed(4)}, Elapsed: ${elapsedMin.toFixed(1)}m`);
    log(`  Total indicators: ${indicators.length}`);
}


// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    autoRun,
    runQueue,
    loadVideos,
    processIndicator,
    _logBuffer: '',   // server reads this for logTail
    log,
};
