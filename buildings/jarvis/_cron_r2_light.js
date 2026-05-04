require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  // Only check small files: progress and queue length via list
  try {
    const buf3 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d3 = JSON.parse(buf3.toString());
    console.log('R2 progress:', JSON.stringify({active: d3.active, completed: d3.completed, run_id: d3.run_id, stop_reason: d3.stop_reason, updated_at: d3.updated_at}));
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
  try {
    const buf4 = await cs.downloadFromR2('jarvis/autonomous_runs.json');
    const d4 = JSON.parse(buf4.toString());
    const runs = Array.isArray(d4) ? d4 : [];
    const last = runs.slice(-3);
    console.log('R2 last 3 runs:', JSON.stringify(last.map(r => ({id: r.run_id||r.id, completed: r.completed, stop: r.stop_reason, total_derived: r.total_derived_after}))));
  } catch(e) { console.log('R2 runs: ERROR', e.message); }
}
check().catch(e=>console.error(e.message));
