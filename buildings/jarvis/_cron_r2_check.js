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
    const buf2 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d2 = JSON.parse(buf2.toString());
    console.log('R2 progress: active=' + d2.active + ' completed=' + d2.completed + ' run=' + d2.run_id + ' updated=' + d2.updated_at);
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
}
check().catch(e=>console.error('ERR:', e.message));
