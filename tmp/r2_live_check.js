require('dotenv').config({ path: '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/.env' });
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const endpoint = process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function main() {
  const keys = ['jarvis/graph.json', 'jarvis/autonomous_progress.json', 'jarvis/derived_experiments.json'];
  for (const k of keys) {
    try {
      const r = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: k }));
      const body = await r.Body.transformToString();
      const d = JSON.parse(body);
      if (k.includes('graph')) {
        const de = d.derived_edges;
        const count = Array.isArray(de) ? de.length : (typeof de === 'object' ? Object.keys(de).length : 0);
        console.log('R2 graph.json: derived_edges=' + count + ' nodes=' + (d.nodes ? d.nodes.length : '?') + ' updated_at=' + d.updated_at);
      } else if (k.includes('autonomous')) {
        console.log('R2 autonomous_progress: run_id=' + d.run_id + ' active=' + d.active + ' completed=' + d.completed + ' updated=' + d.updated_at);
      } else if (k.includes('derived_experiments')) {
        const count = Array.isArray(d) ? d.length : (typeof d === 'object' ? Object.keys(d).length : 0);
        console.log('R2 derived_experiments count=' + count);
      }
    } catch (e) {
      console.log(k + ' R2 error: ' + e.message);
    }
  }
}
main().catch(console.error);
