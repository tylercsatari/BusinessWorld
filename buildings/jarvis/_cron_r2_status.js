require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf = await cs.downloadFromR2('jarvis/derived_experiments_compact.json');
    const d = JSON.parse(buf.toString());
    const arr = Array.isArray(d) ? d : (d.experiments || d);
    console.log('R2 derived_experiments_compact:', Array.isArray(arr) ? arr.length : Object.keys(arr).length);
  } catch(e) { console.log('R2 derived_experiments_compact: ERROR', e.message); }
  try {
    const buf3 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d3 = JSON.parse(buf3.toString());
    console.log('R2 progress: active=' + d3.active + ' completed=' + d3.completed + ' run=' + d3.run_id + ' stop=' + d3.stop_reason);
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
  try {
    const buf4 = await cs.downloadFromR2('jarvis/candidate_queue.json');
    const d4 = JSON.parse(buf4.toString());
    const items = Array.isArray(d4) ? d4 : [];
    console.log('R2 candidate_queue:', items.length);
  } catch(e) { console.log('R2 candidate_queue: ERROR', e.message); }
}
check().catch(e=>console.error(e.message));
