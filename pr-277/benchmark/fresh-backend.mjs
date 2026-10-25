import {readFileSync,statfsSync,mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {cli,base,candidate,startService,stopService,save,serviceHome,home,root,env} from './common.mjs';
import {runHotBackend} from './hot.mjs';
const rows=[];
for(let round=0;round<5;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
 const disk=statfsSync('/tmp');if(disk.bavail*disk.bsize<4*2**30)throw new Error('less than 4 GiB free');
 const row={round,label,startedAt:new Date().toISOString(),loadBefore:os.loadavg()};
 const bundle=label==='baseline'?base:candidate;
 const s=await startService(bundle,label+'-fresh-backend');
 try {
  await cli(bundle,['whoami']);
  const token=JSON.parse(readFileSync(serviceHome+'/token.json')).token;
  row.hot=await runHotBackend({token,iterations:1,warmup:0});
  row.loadAfter=os.loadavg();rows.push(row);save('fresh-backend',{rows});
  console.log(JSON.stringify({round,label,cache:row.hot.measurements.map(m=>[m.operation,m.server.samples?.map(s=>s?.cached??null)??null])}));
  if(round===0){
   const dir=home+'/profiles';mkdirSync(dir,{recursive:true});
   await new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['--cpu-prof','--cpu-prof-interval=100','--cpu-prof-dir='+dir,'--cpu-prof-name='+label+'-publish.cpuprofile',bundle,'create','Page 48','--id','perf-48','--html','<h1>Page 48</h1>'],{cwd:root,env:{...env,IT_HARNESS:'claude-code',IT_SESSION:'perf-session'},stdio:'ignore'});
    p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('profile command failed '+code)));
   });
  }
 }finally{await stopService(s.p)}
}
