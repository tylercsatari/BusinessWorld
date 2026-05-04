require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf = await cs.downloadFromR2('jarvis/derived_experiments.json');
    const d = JSON.parse(buf.toString());
    const arr = d.experiments || d;
    console.log('R2 derived_experiments:', Array.isArray(arr) ? arr.length : Object.keys(arr).length);
  } catch(e) { console.log('R2 derived_experiments: ERROR', e.message); }
  try {
    const buf2 = await cs.downloadFromR2('jarvis/graph.json');
    const d2 = JSON.parse(buf2.toString());
    console.log('R2 graph nodes:', (d2.nodes||[]).length, 'derived_edges:', (d2.derived_edges||[]).length);
  } catch(e) { console.log('R2 graph: ERROR', e.message); }
  try {
    const buf3 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d3 = JSON.parse(buf3.toString());
    console.log('R2 progress: run=' + d3.run_id + ' status=' + d3.status + ' done=' + d3.experiments_done + ' updated=' + d3.updated_at);
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
  try {
    const buf5 = await cs.downloadFromR2('jarvis/autonomous_runs.json');
    const d5 = JSON.parse(buf5.toString());
    const runs = Array.isArray(d5) ? d5 : d5.runs || [];
    const last = runs[runs.length-1] || {};
    console.log('R2 autonomous_runs: count=' + runs.length + ' last_id=' + last.id + ' last_completed=' + last.completed + ' stop_reason=' + last.stop_reason);
  } catch(e) { console.log('R2 autonomous_runs: ERROR', e.message); }
  try {
    const buf4 = await cs.downloadFromR2('jarvis/experiments_log.json');
    const d4 = JSON.parse(buf4.toString());
    const arr = Array.isArray(d4) ? d4 : (d4.experiments || []);
    console.log('R2 experiments_log:', arr.length);
  } catch(e) { console.log('R2 experiments_log: ERROR', e.message); }
}
check().catch(e=>console.error(e.message));
