require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cs = require('../../cloud-storage');
cs.initR2();
async function check() {
  try {
    const buf3 = await cs.downloadFromR2('jarvis/autonomous_progress.json');
    const d3 = JSON.parse(buf3.toString());
    console.log('R2 progress: active=' + d3.active + ' completed=' + d3.completed + ' run=' + d3.run_id + ' stop=' + d3.stop_reason + ' updated=' + d3.updated_at);
  } catch(e) { console.log('R2 progress: ERROR', e.message); }
  process.exit(0);
}
check().catch(e=>{console.error(e.message); process.exit(1);});
