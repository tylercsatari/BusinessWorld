'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();

async function run() {
  const results = {};

  // derived_experiments count
  try {
    const buf = await cs.downloadFromR2('jarvis/derived_experiments_compact.json');
    const d = JSON.parse(buf.toString());
    results.r2_derived_compact = Array.isArray(d) ? d.length : Object.keys(d).length;
  } catch(e) { results.r2_derived_compact = 'ERROR: ' + e.message; }

  // graph
  try {
    const buf = await cs.downloadFromR2('jarvis/graph.json');
    const d = JSON.parse(buf.toString());
    results.r2_graph_nodes = (d.nodes||[]).length;
    results.r2_graph_derived_edges = (d.derived_edges||[]).length;
  } catch(e) { results.r2_graph = 'ERROR: ' + e.message; }

  // indicators
  try {
    const buf = await cs.downloadFromR2('jarvis/indicators_compact.json');
    const d = JSON.parse(buf.toString());
    const arr = d.indicators || d;
    results.r2_indicators_compact = Array.isArray(arr) ? arr.length : Object.keys(arr).length;
  } catch(e) { results.r2_indicators_compact = 'ERROR: ' + e.message; }

  // autonomous_progress
  try {
    const buf = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d = JSON.parse(buf.toString());
    results.r2_progress = {
      active: d.active,
      run_id: d.run_id,
      completed: d.completed,
      updated_at: d.updated_at,
      stop_reason: d.stop_reason,
    };
  } catch(e) { results.r2_progress = 'ERROR: ' + e.message; }

  // Local counts
  try {
    const local_d = require('./derived_experiments_compact.json');
    results.local_derived_compact = Array.isArray(local_d) ? local_d.length : Object.keys(local_d).length;
  } catch(e) { results.local_derived_compact = 'ERROR: ' + e.message; }

  try {
    const local_g = require('./graph.json');
    results.local_graph_nodes = (local_g.nodes||[]).length;
    results.local_graph_derived_edges = (local_g.derived_edges||[]).length;
  } catch(e) { results.local_graph = 'ERROR: ' + e.message; }

  try {
    const local_i = require('./indicators_compact.json');
    const arr = local_i.indicators || local_i;
    results.local_indicators_compact = Array.isArray(arr) ? arr.length : Object.keys(arr).length;
  } catch(e) { results.local_indicators_compact = 'ERROR: ' + e.message; }

  console.log(JSON.stringify(results, null, 2));
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
