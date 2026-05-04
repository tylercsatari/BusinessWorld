'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  const buf = await cs.downloadFromR2('jarvis/autonomous_progress.json');
  const d = JSON.parse(buf.toString());
  console.log('R2 progress: active=' + d.active + ' run=' + d.run_id + ' completed=' + d.completed + ' stop=' + d.stop_reason);
  const buf2 = await cs.downloadFromR2('jarvis/candidate_queue.json');
  const cq = JSON.parse(buf2.toString());
  const cands = Array.isArray(cq) ? cq.length : (cq.queue || cq.candidates || []).length;
  console.log('R2 candidate_queue:', cands);
  // Check compact experiments count
  try {
    const buf3 = await cs.downloadFromR2('jarvis/derived_experiments_compact.json');
    const dc = JSON.parse(buf3.toString());
    console.log('R2 derived_experiments_compact:', Array.isArray(dc) ? dc.length : Object.keys(dc).length);
  } catch(e) { console.log('R2 derived_experiments_compact: ERROR', e.message); }
}
check().catch(e => { console.error(e.message); process.exit(1); });
