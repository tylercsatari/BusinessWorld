require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf = await cs.downloadFromR2('jarvis/derived_experiments_compact.json');
    const d = JSON.parse(buf.toString());
    const arr = d.experiments || d;
    console.log('R2 derived_experiments_compact:', Array.isArray(arr) ? arr.length : Object.keys(arr).length);
  } catch(e) { console.log('R2 derived_experiments_compact: ERROR', e.message); }
  try {
    const buf2 = await cs.downloadFromR2('jarvis/graph.json');
    const d2 = JSON.parse(buf2.toString());
    console.log('R2 graph nodes:', (d2.nodes||[]).length);
  } catch(e) { console.log('R2 graph: ERROR', e.message); }
  try {
    const buf3 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d3 = JSON.parse(buf3.toString());
    console.log('R2 progress: active=' + d3.active + ' completed=' + d3.completed + ' run=' + d3.run_id + ' updated=' + d3.updated_at);
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
}
check().catch(e=>console.error(e.message));
