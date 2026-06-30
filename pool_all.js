#!/usr/bin/env node
// pool_all.js — builds the POOLED retention table (every account merged) and uploads it to R2 as
// retention/all.json, recording which accounts went in (meta.sources). Run this whenever you add a
// new account, then `python3 build_study.py all` to rebuild the pooled study:
//   node pool_all.js && python3 build_study.py all
require('dotenv').config();
const c = require('./cloud-storage');
(async () => {
    await c.initR2();
    const ch = JSON.parse((await c.downloadFromR2('retention/channels.json')).toString());
    const videos = [], sources = [];
    for (const cc of ch.channels) {
        let t;
        try {
            if (cc.owner || cc.id === 'tyler') t = require('./buildings/jarvis/retention-study/retention_table.json');
            else t = JSON.parse((await c.downloadFromR2('retention/' + cc.id + '.json')).toString());
        } catch (e) { console.log('skip ' + cc.id + ': ' + e.message.slice(0, 50)); continue; }
        const vs = (t.videos || t).filter(v => v.keep_rate != null && v.views != null);
        vs.forEach(v => videos.push(Object.assign({ _chan: cc.id }, v)));
        sources.push({ id: cc.id, name: cc.name, n: vs.length });
        console.log('  + ' + cc.name + ' (' + cc.id + '): ' + vs.length + ' videos');
    }
    const out = { meta: { n: videos.length, pooled: true, sources }, videos };
    await c.uploadToR2('retention/all.json', Buffer.from(JSON.stringify(out)), 'application/json');
    console.log('\nPooled → R2 retention/all.json : ' + videos.length + ' videos from ' + sources.length + ' accounts');
    console.log('Now run:  python3 build_study.py all');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
