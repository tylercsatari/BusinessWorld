require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const cs = require('./cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf = await cs.downloadFromR2('jarvis/derived_experiments_compact.json');
    const d = JSON.parse(buf.toString());
    const arr = Array.isArray(d) ? d : (d.experiments || d);
    console.log('R2 compact:', Array.isArray(arr) ? arr.length : 'not array');
  } catch(e) { console.log('R2 compact ERR:', e.message); }
  try {
    const buf2 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d2 = JSON.parse(buf2.toString());
    console.log('R2 progress active=' + d2.active + ' completed=' + d2.completed + ' run=' + d2.run_id + ' stop=' + d2.stop_reason);
  } catch(e) { console.log('R2 progress ERR:', e.message); }
}
check().catch(e=>console.error(e.message));
