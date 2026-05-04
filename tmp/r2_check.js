require('dotenv').config();
const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');
const fs=require('fs');
const client=new S3Client({
  region:'auto',
  endpoint:process.env.R2_ENDPOINT,
  credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}
});
async function main(){
  const keys=['jarvis/autonomous_progress.json','jarvis/graph.json','jarvis/resolutions.json'];
  for(const k of keys){
    try{
      const r=await client.send(new GetObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:k}));
      const body=await r.Body.transformToString();
      const d=JSON.parse(body);
      if(k.includes('autonomous')){
        console.log('R2 autonomous_progress:');
        console.log('  run_id='+d.run_id);
        console.log('  active='+d.active);
        console.log('  completed='+d.completed);
        console.log('  candidates_remaining='+d.candidates_remaining);
        console.log('  derived_experiments_total='+d.derived_experiments_total);
        console.log('  updated_at='+d.updated_at);
      } else if(k.includes('graph')){
        const nodes=(d.nodes||[]).length;
        const edges=(d.edges||[]).length;
        console.log('R2 graph: nodes='+nodes+' edges='+edges);
      } else if(k.includes('resolutions')){
        const cnt=Array.isArray(d)?d.length:Object.keys(d).length;
        console.log('R2 resolutions count='+cnt);
      }
    }catch(e){console.log(k,'error:',e.message);}
  }
  // Local comparison
  try {
    const lp=JSON.parse(fs.readFileSync('buildings/jarvis/autonomous_progress.json'));
    const lg=JSON.parse(fs.readFileSync('buildings/jarvis/graph.json'));
    const lr=JSON.parse(fs.readFileSync('buildings/jarvis/resolutions.json'));
    console.log('---LOCAL---');
    console.log('  run_id='+lp.run_id);
    console.log('  active='+lp.active);
    console.log('  completed='+lp.completed);
    console.log('  candidates_remaining='+lp.candidates_remaining);
    console.log('  derived_total='+lp.derived_experiments_total);
    console.log('  updated_at='+lp.updated_at);
    console.log('  graph nodes='+(lg.nodes||[]).length+' edges='+(lg.edges||[]).length);
    const rCnt=Array.isArray(lr)?lr.length:Object.keys(lr).length;
    console.log('  resolutions='+rCnt);
  } catch(e){ console.log('local read err:', e.message); }
}
main().catch(console.error);
