require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d = JSON.parse(buf.toString());
    console.log('R2 progress: active=' + d.active + ' completed=' + d.completed + ' run=' + d.run_id + ' stop=' + d.stop_reason);
    const buf2 = await cs.downloadFromR2('jarvis/derived_experiments.json');
    const exps = JSON.parse(buf2.toString());
    console.log('R2 derived_experiments count: ' + exps.length);
    const buf3 = await cs.downloadFromR2('jarvis/candidate_queue.json');
    const q = JSON.parse(buf3.toString());
    const cands = Array.isArray(q) ? q : (q.candidates || q.queue || []);
    console.log('R2 candidate_queue count: ' + cands.length);
  } catch(e) { console.log('ERROR: ' + e.message); }
  process.exit(0);
}
check().catch(e => { console.error(e.message); process.exit(1); });
