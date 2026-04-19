const fs = require('fs');
const path = require('path');

const ap = JSON.parse(fs.readFileSync(path.join(__dirname, 'autonomous_progress.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.join(__dirname, 'autonomous_runs.json'), 'utf8'));

// runs may be object-keyed or array
const runs = Array.isArray(ar) ? ar : Object.values(ar);
const last3 = runs.slice(-3);

console.log('=== LOCAL STATE ===');
console.log('active:', ap.active);
console.log('run_id:', ap.run_id);
console.log('stop_reason:', ap.stop_reason);
console.log('completed:', ap.completed, '/ attempted:', ap.attempted);
console.log('no_signal_streak:', ap.no_signal_streak);
console.log('finished_at:', ap.finished_at);
console.log('Total runs in history:', runs.length);
console.log('Last 3 runs:');
last3.forEach(r => {
  console.log(' -', r.id || r.run_id, '| status:', r.status, '| done:', r.completed || r.experiments_completed, '| stop:', r.stop_reason);
});

// Check graph
const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'graph.json'), 'utf8'));
console.log('graph nodes:', (g.nodes||[]).length, 'derived_edges:', (g.derived_edges||[]).length);

// Check resolutions
const res = JSON.parse(fs.readFileSync(path.join(__dirname, 'resolutions.json'), 'utf8'));
const resArr = Array.isArray(res) ? res : (res.resolutions || []);
console.log('resolutions:', resArr.length);
