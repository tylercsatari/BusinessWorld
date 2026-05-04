'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');
const fs=require('fs');
const path=require('path');

const accountId=process.env.R2_ACCOUNT_ID;
const client=new S3Client({
  region:'auto',
  endpoint:`https://${accountId}.r2.cloudflarestorage.com`,
  credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}
});

async function main(){
  const keys=['jarvis/autonomous_progress.json','jarvis/graph.json'];
  for(const k of keys){
    try{
      const r=await client.send(new GetObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:k}));
      const body=await r.Body.transformToString();
      const d=JSON.parse(body);
      if(k.includes('autonomous')){
        console.log('R2 autonomous_progress:');
        console.log('  run_id='+d.run_id);
        console.log('  status='+d.status);
        console.log('  total_experiments='+d.total_experiments);
        console.log('  candidates_remaining='+d.candidates_remaining);
        console.log('  pre_completed='+d.pre_completed);
        console.log('  stop_reason='+d.stop_reason);
      } else {
        const nodes=(d.nodes||[]).length;
        const edges=(d.edges||[]).length;
        console.log('R2 graph: nodes='+nodes+' edges='+edges);
      }
    }catch(e){console.log(k,'R2 error:',e.message);}
  }
  // Local comparison
  const lp=JSON.parse(fs.readFileSync(path.join(__dirname,'buildings/jarvis/autonomous_progress.json')));
  const lg=JSON.parse(fs.readFileSync(path.join(__dirname,'buildings/jarvis/graph.json')));
  console.log('Local autonomous_progress:');
  console.log('  run_id='+lp.run_id);
  console.log('  total_experiments='+lp.total_experiments);
  console.log('  candidates_remaining='+lp.candidates_remaining);
  console.log('  pre_completed='+lp.pre_completed);
  console.log('  status='+lp.status);
  console.log('Local graph: nodes='+(lg.nodes||[]).length+' edges='+(lg.edges||[]).length);
}
main().catch(console.error);
