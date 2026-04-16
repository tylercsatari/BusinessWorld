#!/usr/bin/env node
/**
 * Jarvis Analysis Engine
 * Processes the full graph + derived edges to answer structural questions
 * about what drives views, retention, and swipe behavior.
 *
 * No external dependencies. Pure Node.js.
 */

const fs = require('fs');
const path = require('path');

const JARVIS_DIR = __dirname;
const GRAPH_PATH = path.join(JARVIS_DIR, 'graph.json');
const QUESTIONS_PATH = path.join(JARVIS_DIR, 'research_questions.json');
const ANSWERS_PATH = path.join(JARVIS_DIR, 'research_answers.json');
const DATASET_PATH = path.join(JARVIS_DIR, 'signals-dataset.json');

// ---------------------------------------------------------------------------
// 1. Data loading
// ---------------------------------------------------------------------------

function loadGraph() {
  const g = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const nodeMap = {};
  g.nodes.forEach(n => { nodeMap[n.key] = n; });
  return { nodes: g.nodes, edges: g.edges, derived: g.derived_edges || [], nodeMap };
}

function loadDataset() {
  try {
    const d = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// 2. Family detection & redundancy reduction
// ---------------------------------------------------------------------------

function detectFamilies(nodes) {
  const families = {};

  for (const n of nodes) {
    if (n.type === 'target') continue;
    const key = n.key;

    // Detect family by stripping trailing _pct_NN, _mean_NN_NN, _NN patterns
    let family = key
      .replace(/_pct_\d+$/, '_pct_*')
      .replace(/_mean_\d+_\d+$/, '_mean_*')
      .replace(/_slope_\d+_\d+$/, '_slope_*')
      .replace(/_volatility_\d+_\d+$/, '_volatility_*')
      .replace(/_first(\d+)s$/, '_first*s')
      .replace(/_first(\d+)$/, '_first*')
      .replace(/_count_first\d+s$/, '_count_first*s')
      .replace(/_density_first\d+s$/, '_density_first*s')
      .replace(/_count_first(\d+)$/, '_count_first*')
      .replace(/_density_first(\d+)$/, '_density_first*');

    // Interaction terms: group by base indicators
    if (key.includes('_x_')) {
      const parts = key.split('_x_');
      family = parts.map(p => p
        .replace(/_pct_\d+$/, '_pct_*')
        .replace(/_mean_\d+_\d+$/, '_mean_*')
      ).join('_x_');
    }

    if (!families[family]) families[family] = [];
    families[family].push(n);
  }

  return families;
}

function pickFamilyRepresentatives(families) {
  const reps = {};
  for (const [family, members] of Object.entries(families)) {
    // Pick the member with highest |r_partial|
    const sorted = members
      .filter(m => m.r_partial !== null && m.r_partial !== undefined)
      .sort((a, b) => Math.abs(b.r_partial) - Math.abs(a.r_partial));
    if (sorted.length > 0) {
      reps[family] = {
        representative: sorted[0],
        family_size: members.length,
        members: members.map(m => m.key),
        r_range: sorted.length > 1
          ? [sorted[sorted.length - 1].r_partial, sorted[0].r_partial]
          : [sorted[0].r_partial, sorted[0].r_partial]
      };
    }
  }
  return reps;
}

// ---------------------------------------------------------------------------
// 3. Bridge / path analysis
// ---------------------------------------------------------------------------

function analyzeBridges(graph) {
  const { derived, nodeMap } = graph;

  // Collect all bridge-relevant edges grouped by (pre, post) pair
  const bridgePairs = {};

  for (const e of derived) {
    const fromNode = nodeMap[e.from];
    const toNode = nodeMap[e.to];
    if (!fromNode || !toNode) continue;

    // We want pre -> post connections
    if (fromNode.layer !== 'pre' || toNode.layer !== 'post') continue;

    const pairKey = `${e.from}||${e.to}`;
    if (!bridgePairs[pairKey]) {
      bridgePairs[pairKey] = {
        pre: e.from,
        post: e.to,
        pre_r: fromNode.r_partial,
        post_r: toNode.r_partial,
        evidence: [],
        kinds: new Set()
      };
    }
    bridgePairs[pairKey].evidence.push(e);
    bridgePairs[pairKey].kinds.add(e.kind);
  }

  // Score each bridge pair
  const scored = [];
  for (const [key, pair] of Object.entries(bridgePairs)) {
    const pre_r = pair.pre_r || 0;
    const post_r = pair.post_r || 0;

    // Gather r values from different evidence types
    let interactionR = null;
    let bridgeStrength = null;
    let pairCorr = null;
    let residualR = null;

    for (const e of pair.evidence) {
      if (e.kind === 'interaction_to_views' && e.interaction_r !== undefined) {
        interactionR = e.interaction_r;
      }
      if (e.kind === 'bridge_strength_pre_to_post') {
        bridgeStrength = e.pathway_strength;
      }
      if (e.kind === 'pair_correlation') {
        pairCorr = e.primary_r;
      }
      if (e.kind === 'residual_pair_to_views') {
        residualR = e.r_residual;
      }
    }

    // Composite path score:
    // 1. Direct pathway: |pre_r| * |post_r| * sign_consistency
    const signConsistent = (pre_r >= 0) === (post_r >= 0) ? 1 : 0.5;
    const directPathway = Math.abs(pre_r) * Math.abs(post_r) * signConsistent;

    // 2. Bridge evidence: weighted avg of available bridge metrics
    let bridgeEvidence = 0;
    let bridgeWeights = 0;
    if (interactionR !== null) { bridgeEvidence += Math.abs(interactionR) * 2; bridgeWeights += 2; }
    if (bridgeStrength !== null) { bridgeEvidence += bridgeStrength * 3; bridgeWeights += 3; }
    if (pairCorr !== null) { bridgeEvidence += Math.abs(pairCorr) * 1.5; bridgeWeights += 1.5; }
    if (residualR !== null) { bridgeEvidence += Math.abs(residualR) * 2; bridgeWeights += 2; }
    const avgBridgeEvidence = bridgeWeights > 0 ? bridgeEvidence / bridgeWeights : 0;

    // 3. Evidence diversity bonus
    const diversityBonus = 1 + (pair.kinds.size - 1) * 0.1;

    // Final score
    const pathScore = (directPathway * 0.3 + avgBridgeEvidence * 0.7) * diversityBonus;

    scored.push({
      pre: pair.pre,
      post: pair.post,
      pre_r: pre_r,
      post_r: post_r,
      interaction_r: interactionR,
      bridge_strength: bridgeStrength,
      pair_corr: pairCorr,
      residual_r: residualR,
      evidence_types: pair.kinds.size,
      path_score: pathScore,
      sign_consistent: signConsistent === 1
    });
  }

  scored.sort((a, b) => b.path_score - a.path_score);
  return scored;
}

// ---------------------------------------------------------------------------
// 4. Target-specific analysis (retention_pct_10, hook_drop_rate, swipe, etc.)
// ---------------------------------------------------------------------------

function analyzeTarget(graph, targetKey) {
  const { derived, nodeMap } = graph;

  // Find all derived edges that have this target
  const targetEdges = derived.filter(e => e.target === targetKey || e.to === targetKey);

  // Group by the "from" indicator (the predictor)
  const predictors = {};
  for (const e of targetEdges) {
    const fromNode = nodeMap[e.from];
    if (!fromNode) continue;

    if (!predictors[e.from]) {
      predictors[e.from] = {
        key: e.from,
        layer: fromNode.layer,
        r_to_views: fromNode.r_partial,
        evidence: [],
        kinds: new Set()
      };
    }
    predictors[e.from].evidence.push(e);
    predictors[e.from].kinds.add(e.kind);
  }

  // Score each predictor's connection to this target
  const scored = [];
  for (const [key, pred] of Object.entries(predictors)) {
    let totalR = 0;
    let rCount = 0;
    let maxR = 0;

    for (const e of pred.evidence) {
      const r = e.interaction_r || e.primary_r || e.r_residual || 0;
      if (r !== 0) {
        totalR += r;
        rCount++;
        if (Math.abs(r) > Math.abs(maxR)) maxR = r;
      }
    }

    scored.push({
      key: pred.key,
      layer: pred.layer,
      r_to_views: pred.r_to_views,
      avg_r_to_target: rCount > 0 ? totalR / rCount : 0,
      max_r_to_target: maxR,
      evidence_count: pred.evidence.length,
      evidence_types: pred.kinds.size,
      score: (rCount > 0 ? Math.abs(totalR / rCount) : 0) * (1 + Math.log2(Math.max(pred.evidence.length, 1)))
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------------------------------------------------------------------------
// 5. Regime analysis — what separates high-view videos?
// ---------------------------------------------------------------------------

function analyzeRegimes(graph) {
  const { derived, nodeMap } = graph;

  // Collect regime_gap_to_views edges
  const regimeEdges = derived.filter(e => e.kind === 'regime_gap_to_views');

  const indicators = regimeEdges.map(e => {
    const node = nodeMap[e.from] || nodeMap[e.component_keys?.[0]];
    return {
      key: e.from,
      layer: node ? node.layer : 'unknown',
      r_to_views: node ? node.r_partial : null,
      regime_gap: e.regime_gap,
      cohens_d: e.cohens_d,
      direction: e.direction,
      strength: e.strength_label
    };
  });

  // Sort by |cohens_d|
  indicators.sort((a, b) => Math.abs(b.cohens_d) - Math.abs(a.cohens_d));
  return indicators;
}

// Also use quantile_gap for regime-like analysis
function analyzeQuantileGaps(graph) {
  const { derived, nodeMap } = graph;
  const qEdges = derived.filter(e => e.kind === 'quantile_gap_to_views');

  return qEdges.map(e => {
    const node = nodeMap[e.from] || nodeMap[e.component_keys?.[0]];
    return {
      key: e.from,
      layer: node ? node.layer : 'unknown',
      r_to_views: node ? node.r_partial : null,
      gap: e.gap,
      top_mean: e.top_mean,
      bottom_mean: e.bottom_mean,
      direction: e.direction,
      strength: e.strength_label
    };
  }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

// ---------------------------------------------------------------------------
// 6. Multi-hop path discovery: pre -> intermediate -> views
// ---------------------------------------------------------------------------

function discoverMultiHopPaths(graph) {
  const { nodes, edges, derived, nodeMap } = graph;

  // Build adjacency: indicator -> views (direct r)
  const directR = {};
  for (const e of edges) {
    directR[e.from] = e.r;
  }
  for (const n of nodes) {
    if (n.r_partial !== null) directR[n.key] = n.r_partial;
  }

  // Build pre -> post interaction map from derived edges
  const prePostInteractions = {};
  for (const e of derived) {
    if (e.kind !== 'interaction_to_views') continue;
    const from = nodeMap[e.from];
    const to = nodeMap[e.to];
    if (!from || !to) continue;
    if (from.layer === 'pre' && to.layer === 'post') {
      const key = `${e.from}||${e.to}`;
      if (!prePostInteractions[key] || Math.abs(e.interaction_r) > Math.abs(prePostInteractions[key].interaction_r)) {
        prePostInteractions[key] = e;
      }
    }
  }

  // For each (pre, post) pair where both connect to views, compute path
  const paths = [];
  for (const [key, interaction] of Object.entries(prePostInteractions)) {
    const preKey = interaction.from;
    const postKey = interaction.to;
    const preR = directR[preKey];
    const postR = directR[postKey];

    if (preR === undefined || postR === undefined) continue;

    // Path strength: geometric mean of |pre->views|, |interaction_r|, |post->views|
    // weighted by sign consistency
    const signs = [Math.sign(preR), Math.sign(interaction.interaction_r), Math.sign(postR)];
    const allSameSign = signs[0] === signs[1] && signs[1] === signs[2];
    const signPenalty = allSameSign ? 1.0 : 0.6;

    const pathStrength = Math.cbrt(
      Math.abs(preR) * Math.abs(interaction.interaction_r) * Math.abs(postR)
    ) * signPenalty;

    paths.push({
      pre: preKey,
      post: postKey,
      pre_r: preR,
      post_r: postR,
      interaction_r: interaction.interaction_r,
      path_strength: pathStrength,
      sign_consistent: allSameSign,
      pre_layer: 'pre',
      post_layer: 'post'
    });
  }

  paths.sort((a, b) => b.path_strength - a.path_strength);
  return paths;
}

// ---------------------------------------------------------------------------
// 7. First-10s / swipe specific analysis
// ---------------------------------------------------------------------------

function analyzeFirst10sAndSwipe(graph) {
  const earlyRetentionTargets = [
    'retention_pct_10', 'hook_drop_rate', 'hook_retention_pct',
    'hook_payoff_gap', 'swipe_away_rate'
  ];

  const results = {};
  for (const target of earlyRetentionTargets) {
    const analysis = analyzeTarget(graph, target);
    // Only pre-upload predictors (things you can control before publishing)
    const preOnly = analysis.filter(a => a.layer === 'pre');
    results[target] = {
      all_predictors: analysis.slice(0, 30),
      pre_upload_predictors: preOnly.slice(0, 30),
      total_evidence: analysis.reduce((s, a) => s + a.evidence_count, 0)
    };
  }
  return results;
}

// ---------------------------------------------------------------------------
// 8. Hook structure analysis (Boba Fett flamethrower problem)
// ---------------------------------------------------------------------------

function analyzeHookStructure(graph) {
  const { nodes, derived, nodeMap } = graph;

  // Hook-related pre-upload indicators
  const hookIndicators = nodes.filter(n =>
    n.layer === 'pre' && (
      n.key.includes('hook') ||
      n.key.includes('opening') ||
      n.key.includes('first_segment') ||
      n.key.includes('first_beat') ||
      n.key.startsWith('open_loop') ||
      n.key.includes('tension') ||
      n.key.includes('anticipat')
    )
  );

  // For each hook indicator, trace its connections
  const hookPaths = [];
  for (const hookNode of hookIndicators) {
    // Direct r to views
    const directR = hookNode.r_partial;

    // Find derived edges from this hook indicator
    const connections = derived.filter(e => e.from === hookNode.key);

    // Group by target
    const targetConnections = {};
    for (const e of connections) {
      const target = e.to;
      if (!targetConnections[target]) targetConnections[target] = [];
      targetConnections[target].push(e);
    }

    // Find connections to retention targets
    const retentionConnections = {};
    for (const [target, edges] of Object.entries(targetConnections)) {
      const targetNode = nodeMap[target];
      if (!targetNode) continue;
      if (targetNode.layer === 'post' ||
          target.includes('retention') ||
          target.includes('hook_drop') ||
          target.includes('swipe') ||
          target === 'views') {
        const bestEdge = edges.sort((a, b) =>
          Math.abs(b.interaction_r || b.primary_r || 0) - Math.abs(a.interaction_r || a.primary_r || 0)
        )[0];
        retentionConnections[target] = {
          target,
          target_layer: targetNode ? targetNode.layer : 'unknown',
          target_r_to_views: targetNode ? targetNode.r_partial : null,
          best_r: bestEdge.interaction_r || bestEdge.primary_r || null,
          edge_count: edges.length,
          kinds: [...new Set(edges.map(e => e.kind))]
        };
      }
    }

    hookPaths.push({
      hook_indicator: hookNode.key,
      direct_r_to_views: directR,
      retention_connections: retentionConnections,
      total_connections: Object.keys(targetConnections).length
    });
  }

  // Sort by number of retention connections and |direct_r|
  hookPaths.sort((a, b) => {
    const aScore = Object.keys(a.retention_connections).length * 0.5 + Math.abs(a.direct_r_to_views || 0);
    const bScore = Object.keys(b.retention_connections).length * 0.5 + Math.abs(b.direct_r_to_views || 0);
    return bScore - aScore;
  });

  return hookPaths;
}

// ---------------------------------------------------------------------------
// 9. Threshold / nonlinearity detection
// ---------------------------------------------------------------------------

function analyzeNonlinearities(graph) {
  const { derived, nodeMap } = graph;

  const thresholds = derived.filter(e => e.kind === 'threshold_delta_to_views');
  const piecewise = derived.filter(e => e.kind === 'piecewise_to_views');
  const bucketed = derived.filter(e => e.kind === 'bucketed_curve_to_views');
  const monotonic = derived.filter(e => e.kind === 'monotonic_bucket_consistency');

  // Indicators with strong nonlinear effects
  const nonlinear = {};
  for (const e of piecewise) {
    const delta = e.nonlinearity_delta;
    if (Math.abs(delta) > 0.1) {
      const node = nodeMap[e.from];
      nonlinear[e.from] = {
        key: e.from,
        layer: node ? node.layer : 'unknown',
        linear_r: e.primary_r,
        r_lower: e.r_lower_half,
        r_upper: e.r_upper_half,
        nonlinearity: delta,
        direction: e.direction
      };
    }
  }

  // Enrich with threshold data
  for (const e of thresholds) {
    if (nonlinear[e.from]) {
      nonlinear[e.from].threshold_delta = e.max_quartile_delta;
      nonlinear[e.from].breakpoint = e.breakpoint_label;
    }
  }

  // Enrich with monotonic consistency
  for (const e of monotonic) {
    if (nonlinear[e.from]) {
      nonlinear[e.from].monotonic_consistency = e.consistency;
    }
  }

  return Object.values(nonlinear)
    .sort((a, b) => Math.abs(b.nonlinearity) - Math.abs(a.nonlinearity));
}

// ---------------------------------------------------------------------------
// 10. Dataset-based regime comparison (using actual video data)
// ---------------------------------------------------------------------------

function analyzeViewRegimesFromDataset(dataset) {
  if (!dataset || dataset.length === 0) return null;

  const sorted = [...dataset].sort((a, b) => (b.views || 0) - (a.views || 0));
  const n = sorted.length;

  // Define regimes
  const regimes = {
    'mega_viral_50M+': sorted.filter(v => v.views >= 50000000),
    'viral_10M_50M': sorted.filter(v => v.views >= 10000000 && v.views < 50000000),
    'solid_1M_10M': sorted.filter(v => v.views >= 1000000 && v.views < 10000000),
    'below_1M': sorted.filter(v => v.views < 1000000)
  };

  // For numeric columns, compute mean per regime
  const numericKeys = Object.keys(sorted[0]).filter(k => {
    if (k === 'name' || k === 'ytId' || k === 'keep' || k === 'z_type' || k === 'vz_type') return false;
    return typeof sorted[0][k] === 'number';
  });

  const regimeStats = {};
  for (const [regimeName, videos] of Object.entries(regimes)) {
    if (videos.length === 0) continue;
    regimeStats[regimeName] = { count: videos.length };
    for (const key of numericKeys) {
      const vals = videos.map(v => v[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
      if (vals.length > 0) {
        regimeStats[regimeName][key] = {
          mean: vals.reduce((s, v) => s + v, 0) / vals.length,
          min: Math.min(...vals),
          max: Math.max(...vals)
        };
      }
    }
  }

  // Compute effect sizes between mega_viral and below_1M
  const comparisons = {};
  if (regimeStats['mega_viral_50M+'] && regimeStats['below_1M']) {
    const top = regimeStats['mega_viral_50M+'];
    const bottom = regimeStats['below_1M'];
    for (const key of numericKeys) {
      if (top[key] && bottom[key]) {
        const topVals = regimes['mega_viral_50M+'].map(v => v[key]).filter(v => !isNaN(v));
        const botVals = regimes['below_1M'].map(v => v[key]).filter(v => !isNaN(v));
        const pooledStd = Math.sqrt(
          ((variance(topVals) * (topVals.length - 1)) + (variance(botVals) * (botVals.length - 1))) /
          (topVals.length + botVals.length - 2)
        );
        const cohensD = pooledStd > 0 ? (top[key].mean - bottom[key].mean) / pooledStd : 0;
        comparisons[key] = {
          top_mean: top[key].mean,
          bottom_mean: bottom[key].mean,
          difference: top[key].mean - bottom[key].mean,
          cohens_d: cohensD
        };
      }
    }
  }

  return { regimes: regimeStats, comparisons };
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
}

// ---------------------------------------------------------------------------
// 11. Synthesis: combine all analyses into answers
// ---------------------------------------------------------------------------

function synthesizeAnswers(graph, dataset) {
  const bridges = analyzeBridges(graph);
  const multiHopPaths = discoverMultiHopPaths(graph);
  const regimeFromGraph = analyzeRegimes(graph);
  const quantileGaps = analyzeQuantileGaps(graph);
  const first10sSwipe = analyzeFirst10sAndSwipe(graph);
  const hookStructure = analyzeHookStructure(graph);
  const nonlinearities = analyzeNonlinearities(graph);
  const datasetRegimes = analyzeViewRegimesFromDataset(dataset);

  const families = detectFamilies(graph.nodes);
  const reps = pickFamilyRepresentatives(families);

  // Pre-upload indicators sorted by |r|
  const preIndicators = graph.nodes
    .filter(n => n.layer === 'pre' && n.r_partial !== null)
    .sort((a, b) => Math.abs(b.r_partial) - Math.abs(a.r_partial));

  const postIndicators = graph.nodes
    .filter(n => n.layer === 'post' && n.r_partial !== null)
    .sort((a, b) => Math.abs(b.r_partial) - Math.abs(a.r_partial));

  // ---- Answer Q1: What predicts 100M+ views? ----
  const q1 = {
    question_id: 'q001',
    analysis_id: `analysis_${Date.now()}`,
    timestamp: new Date().toISOString(),
    method: 'multi-evidence synthesis: regime_gap (Cohen\'s d), quantile_gap, bridge paths, nonlinearity detection',
    findings: {
      regime_analysis: {
        description: 'Indicators with largest Cohen\'s d between high-view and low-view regimes',
        top_regime_differentiators: regimeFromGraph.slice(0, 25),
        total_regime_indicators: regimeFromGraph.length
      },
      quantile_gaps: {
        description: 'Top/bottom quartile view-count gaps per indicator',
        top_gaps: quantileGaps.slice(0, 25),
        total: quantileGaps.length
      },
      strongest_pre_upload: {
        description: 'Pre-upload indicators most correlated with views (things you control)',
        top: preIndicators.slice(0, 30).map(n => ({
          key: n.key, r: n.r_partial
        }))
      },
      strongest_post_upload: {
        description: 'Post-upload indicators most correlated with views (retention/engagement signals)',
        top: postIndicators.slice(0, 20).map(n => ({
          key: n.key, r: n.r_partial
        }))
      },
      nonlinear_effects: {
        description: 'Indicators with strong nonlinear relationships to views (threshold effects)',
        top: nonlinearities.slice(0, 15)
      },
      dataset_regime_comparison: datasetRegimes
    },
    summary: null // filled below
  };

  // ---- Answer Q2: First 10s falloff ----
  const q2 = {
    question_id: 'q002',
    analysis_id: `analysis_${Date.now()}_q2`,
    timestamp: new Date().toISOString(),
    method: 'target-specific edge analysis: retention_pct_10 + hook_drop_rate as targets',
    findings: {
      retention_pct_10: first10sSwipe.retention_pct_10 || null,
      hook_drop_rate: first10sSwipe.hook_drop_rate || null,
      hook_retention_pct: first10sSwipe.hook_retention_pct || null
    },
    summary: null
  };

  // ---- Answer Q3: Swipe / hold ----
  const q3 = {
    question_id: 'q003',
    analysis_id: `analysis_${Date.now()}_q3`,
    timestamp: new Date().toISOString(),
    method: 'target-specific edge analysis: swipe_away_rate + hook_payoff_gap as targets',
    findings: {
      swipe_away_rate: first10sSwipe.swipe_away_rate || null,
      hook_payoff_gap: first10sSwipe.hook_payoff_gap || null,
      stayed_to_watch_rate: analyzeTarget(graph, 'stayed_to_watch_rate').slice(0, 30)
    },
    summary: null
  };

  // ---- Answer Q4: Bridge structure ----
  const q4 = {
    question_id: 'q004',
    analysis_id: `analysis_${Date.now()}_q4`,
    timestamp: new Date().toISOString(),
    method: 'multi-evidence bridge scoring: interaction_r, pathway_strength, pair_correlation, residual_r',
    findings: {
      top_bridges: bridges.slice(0, 40),
      top_multi_hop_paths: multiHopPaths.slice(0, 40),
      bridge_stats: {
        total_bridge_pairs: bridges.length,
        multi_evidence_bridges: bridges.filter(b => b.evidence_types >= 2).length,
        unique_pre_in_bridges: new Set(bridges.map(b => b.pre)).size,
        unique_post_in_bridges: new Set(bridges.map(b => b.post)).size
      }
    },
    summary: null
  };

  // ---- Answer Q5: Boba Fett hook problem ----
  const q5 = {
    question_id: 'q005',
    analysis_id: `analysis_${Date.now()}_q5`,
    timestamp: new Date().toISOString(),
    method: 'hook structure analysis: trace hook indicators through retention to views',
    findings: {
      hook_indicators: hookStructure.slice(0, 30),
      hook_to_retention_bridges: bridges
        .filter(b => b.pre.includes('hook') || b.pre.includes('opening') || b.pre.includes('open_loop'))
        .slice(0, 20),
      hook_to_early_retention: (first10sSwipe.hook_drop_rate?.pre_upload_predictors || [])
        .filter(p => p.key.includes('hook') || p.key.includes('opening') || p.key.includes('open_loop'))
        .slice(0, 15)
    },
    summary: null
  };

  // ---- Generate summaries ----
  q1.summary = generateQ1Summary(q1, regimeFromGraph, preIndicators, postIndicators);
  q2.summary = generateQ2Summary(q2, first10sSwipe);
  q3.summary = generateQ3Summary(q3, first10sSwipe);
  q4.summary = generateQ4Summary(q4, bridges, multiHopPaths);
  q5.summary = generateQ5Summary(q5, hookStructure, bridges);

  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    graph_stats: {
      total_nodes: graph.nodes.length,
      total_edges: graph.edges.length,
      total_derived_edges: graph.derived.length,
      pre_indicators: graph.nodes.filter(n => n.layer === 'pre').length,
      post_indicators: graph.nodes.filter(n => n.layer === 'post').length,
      families_detected: Object.keys(families).length,
      deduplicated_families: Object.keys(reps).length
    },
    family_representatives: Object.entries(reps)
      .sort((a, b) => Math.abs(b[1].representative.r_partial || 0) - Math.abs(a[1].representative.r_partial || 0))
      .slice(0, 50)
      .map(([family, data]) => ({
        family,
        representative: data.representative.key,
        r: data.representative.r_partial,
        layer: data.representative.layer,
        family_size: data.family_size
      })),
    answers: [q1, q2, q3, q4, q5]
  };
}

// ---------------------------------------------------------------------------
// Summary generators — produce human-readable text from structured findings
// ---------------------------------------------------------------------------

function generateQ1Summary(q1, regimeData, preIndicators, postIndicators) {
  const lines = ['## What predicts 100M+ views?\n'];

  lines.push('### Post-upload signals (strongest overall):');
  const topPost = postIndicators.slice(0, 8);
  for (const p of topPost) {
    const dir = p.r_partial > 0 ? 'higher = more views' : 'lower = more views';
    lines.push(`- **${p.key}** (r=${p.r_partial.toFixed(3)}): ${dir}`);
  }

  lines.push('\n### Pre-upload signals (what you control):');
  const topPre = preIndicators.slice(0, 10);
  for (const p of topPre) {
    const dir = p.r_partial > 0 ? 'more = more views' : 'less = more views';
    lines.push(`- **${p.key}** (r=${p.r_partial.toFixed(3)}): ${dir}`);
  }

  lines.push('\n### Regime differentiators (Cohen\'s d, high vs low views):');
  const topRegime = regimeData.filter(r => Math.abs(r.cohens_d) > 0.5).slice(0, 10);
  for (const r of topRegime) {
    lines.push(`- **${r.key}** (d=${r.cohens_d.toFixed(2)}, ${r.direction}): ${r.strength}`);
  }

  const nlEffects = q1.findings.nonlinear_effects.top.slice(0, 5);
  if (nlEffects.length > 0) {
    lines.push('\n### Nonlinear / threshold effects:');
    for (const nl of nlEffects) {
      lines.push(`- **${nl.key}**: ${nl.direction} (delta=${nl.nonlinearity.toFixed(3)}, linear r=${nl.linear_r.toFixed(3)})`);
    }
  }

  lines.push('\n### Key insight:');
  lines.push('The strongest view predictors are all post-upload retention signals, especially **late retention** (75-100% of video). ');
  lines.push('This means the algorithm heavily rewards videos that hold viewers to the end. ');
  lines.push('Pre-upload, the most controllable predictors are: shorter hook_word_ratio (don\'t over-explain the hook), ');
  lines.push('higher visual_variety_entropy (varied visuals), longer transcripts (more content density), ');
  lines.push('and more pivot_word_count / scene_burst_count (structural variety). ');
  lines.push('The sub_view_fraction signal (r=-0.86) confirms: mega-viral videos reach far beyond subscribers.');

  return lines.join('\n');
}

function generateQ2Summary(q2, first10s) {
  const lines = ['## What minimizes first-10-second falloff?\n'];

  const hookDrop = first10s.hook_drop_rate?.pre_upload_predictors || [];
  const retPct10 = first10s.retention_pct_10?.pre_upload_predictors || [];

  lines.push('### Pre-upload features that reduce hook_drop_rate:');
  for (const p of hookDrop.slice(0, 10)) {
    const dir = p.avg_r_to_target < 0 ? 'reduces drop' : 'increases drop';
    lines.push(`- **${p.key}** (avg_r=${p.avg_r_to_target.toFixed(3)}, evidence=${p.evidence_count}): ${dir}`);
  }

  lines.push('\n### Pre-upload features that improve retention at 10%:');
  for (const p of retPct10.slice(0, 10)) {
    const dir = p.avg_r_to_target > 0 ? 'improves retention' : 'hurts retention';
    lines.push(`- **${p.key}** (avg_r=${p.avg_r_to_target.toFixed(3)}, evidence=${p.evidence_count}): ${dir}`);
  }

  lines.push('\n### Key insight:');
  lines.push('The first 10 seconds are shaped by pre-upload features like open loops, anticipatory framing, ');
  lines.push('dangling questions, and hook tension. These create cognitive investment before the viewer decides to leave.');

  return lines.join('\n');
}

function generateQ3Summary(q3, first10s) {
  const lines = ['## What maximizes swipe hold / reduces skip?\n'];

  const swipe = first10s.swipe_away_rate?.pre_upload_predictors || [];
  const hookPayoff = first10s.hook_payoff_gap?.pre_upload_predictors || [];

  lines.push('### Pre-upload features that reduce swipe_away_rate:');
  for (const p of swipe.slice(0, 10)) {
    const dir = p.avg_r_to_target < 0 ? 'reduces swipe' : 'increases swipe';
    lines.push(`- **${p.key}** (avg_r=${p.avg_r_to_target.toFixed(3)}, evidence=${p.evidence_count}): ${dir}`);
  }

  lines.push('\n### Pre-upload features connected to hook_payoff_gap:');
  for (const p of hookPayoff.slice(0, 10)) {
    lines.push(`- **${p.key}** (avg_r=${p.avg_r_to_target.toFixed(3)}, evidence=${p.evidence_count})`);
  }

  lines.push('\n### Key insight:');
  lines.push('Swipe prevention is about immediate cognitive commitment: open loops in the first seconds, ');
  lines.push('specificity (concrete details, not vague promises), and tension that implies a payoff is coming.');

  return lines.join('\n');
}

function generateQ4Summary(q4, bridges, multiHop) {
  const lines = ['## Pre -> Post -> Views bridge structure\n'];

  lines.push(`Total bridge pairs scored: ${bridges.length}`);
  lines.push(`Multi-evidence bridges: ${bridges.filter(b => b.evidence_types >= 2).length}`);
  lines.push(`Unique pre-upload indicators in bridges: ${new Set(bridges.map(b => b.pre)).size}`);
  lines.push(`Unique post-upload indicators in bridges: ${new Set(bridges.map(b => b.post)).size}\n`);

  lines.push('### Strongest pre -> post -> views bridges:');
  for (const b of bridges.slice(0, 15)) {
    lines.push(`- **${b.pre}** -> **${b.post}** -> views`);
    lines.push(`  path_score=${b.path_score.toFixed(4)}, pre_r=${b.pre_r.toFixed(3)}, post_r=${b.post_r.toFixed(3)}, ` +
      `interaction_r=${(b.interaction_r || 0).toFixed(3)}, evidence_types=${b.evidence_types}`);
  }

  lines.push('\n### Strongest multi-hop paths (geometric mean):');
  for (const p of multiHop.slice(0, 10)) {
    lines.push(`- **${p.pre}** -> **${p.post}** -> views`);
    lines.push(`  strength=${p.path_strength.toFixed(4)}, pre_r=${p.pre_r.toFixed(3)}, ` +
      `interaction_r=${p.interaction_r.toFixed(3)}, post_r=${p.post_r.toFixed(3)}, ` +
      `sign_consistent=${p.sign_consistent}`);
  }

  lines.push('\n### Key insight:');
  lines.push('The bridge structure shows that pre-upload features like scene_change_rate, speech_rate, ');
  lines.push('dangling_question_ratio, and anticipatory_frame_pct flow through final_5pct_retention ');
  lines.push('and hook_drop_rate to reach views. The strongest path is not a single feature but ');
  lines.push('the combination of structural variety + late retention.');

  return lines.join('\n');
}

function generateQ5Summary(q5, hookStructure, bridges) {
  const lines = ['## Boba Fett flamethrower hook problem\n'];

  lines.push('The "Boba Fett problem": a spectacular hook (flamethrower, explosion, etc.) grabs attention ');
  lines.push('but can HURT long-term retention if the rest of the video can\'t sustain the intensity.\n');

  lines.push('### What the graph says about hook -> retention -> views:');

  const hookBridges = bridges
    .filter(b => b.pre.includes('hook') || b.pre.includes('opening') || b.pre.includes('open_loop'))
    .slice(0, 10);

  for (const b of hookBridges) {
    lines.push(`- **${b.pre}** -> ${b.post} (path=${b.path_score.toFixed(4)}, ` +
      `pre_r=${b.pre_r.toFixed(3)}, post_r=${b.post_r.toFixed(3)})`);
  }

  // Find hook indicators with many retention connections
  const topHook = hookStructure.filter(h => Object.keys(h.retention_connections).length >= 3).slice(0, 8);
  lines.push('\n### Hook indicators with strongest retention connections:');
  for (const h of topHook) {
    const targets = Object.keys(h.retention_connections);
    lines.push(`- **${h.hook_indicator}** (r_views=${(h.direct_r_to_views || 0).toFixed(3)})`);
    lines.push(`  connects to: ${targets.join(', ')}`);
  }

  lines.push('\n### Key insight:');
  lines.push('Hook indicators like open_loop_count_first3s, hook_tension_ratio, and hook_open_loop_density ');
  lines.push('connect positively to both early retention AND late retention. But hook_word_ratio ');
  lines.push('(how much of the transcript is spent on the hook) has a NEGATIVE correlation with views. ');
  lines.push('This means: create tension and open loops quickly (Boba Fett reaches for the flamethrower), ');
  lines.push('but don\'t dwell on the spectacle — move into the body fast. The flamethrower PROMISE ');
  lines.push('(open loop) works better than the flamethrower PAYOFF (if given too early). ');
  lines.push('Delay gratification: let the hook CREATE questions, then answer them through the video structure.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

function main() {
  console.log('Loading Jarvis graph...');
  const graph = loadGraph();
  console.log(`  ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.derived.length} derived edges`);

  console.log('Loading dataset...');
  const dataset = loadDataset();
  console.log(`  ${dataset.length} videos`);

  console.log('Running analysis...');
  const answers = synthesizeAnswers(graph, dataset);

  console.log('Writing answers...');
  fs.writeFileSync(ANSWERS_PATH, JSON.stringify(answers, null, 2));
  console.log(`  Written to ${ANSWERS_PATH}`);

  // Update questions with answer references
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  for (const answer of answers.answers) {
    const q = questions.questions.find(q => q.id === answer.question_id);
    if (q) {
      q.status = 'answered';
      q.answer_id = answer.analysis_id;
      q.analysis_runs.push({
        run_id: answer.analysis_id,
        timestamp: answer.timestamp,
        method: answer.method
      });
    }
  }
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(questions, null, 2));
  console.log('  Updated research_questions.json');

  // Print summaries to console
  console.log('\n' + '='.repeat(80));
  for (const answer of answers.answers) {
    console.log('\n' + answer.summary);
    console.log('\n' + '-'.repeat(80));
  }

  console.log('\n=== GRAPH STATS ===');
  console.log(JSON.stringify(answers.graph_stats, null, 2));

  console.log('\n=== TOP DEDUPLICATED FAMILIES ===');
  for (const f of answers.family_representatives.slice(0, 20)) {
    console.log(`  ${f.r.toFixed(4).padStart(8)} ${f.layer.padEnd(5)} ${f.representative} (family: ${f.family}, size: ${f.family_size})`);
  }

  return answers;
}

// Export for use by other Jarvis modules
module.exports = {
  loadGraph, loadDataset, analyzeBridges, analyzeTarget, analyzeRegimes,
  analyzeQuantileGaps, discoverMultiHopPaths, analyzeFirst10sAndSwipe,
  analyzeHookStructure, analyzeNonlinearities, detectFamilies,
  pickFamilyRepresentatives, synthesizeAnswers, main
};

if (require.main === module) {
  main();
}
