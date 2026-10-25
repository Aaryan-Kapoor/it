import os from 'node:os';
import {statfsSync,rmSync,existsSync} from 'node:fs';
import {cli,base,candidate,home,startService,stopService,save,sleep} from './common.mjs';
const rows=[];
for(let round=0;round<5;round++)for(const label of ['baseline','candidate']){
 if(existsSync(home+`/cold-${round}-${label}`))throw new Error('Every cold sample requires a new service folder.');
}
for(let round=0;round<5;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
 const bundle=label==='baseline'?base:candidate;
 const disk=statfsSync('/tmp');if(disk.bavail*disk.bsize<4*2**30)throw new Error('less than 4 GiB free');
 const startedAt=new Date().toISOString(), loadBefore=os.loadavg();
 const directory=home+`/cold-${round}-${label}`;
 const opts={IT_HOME:directory};
 const setup=await cli(bundle,['setup','--none','--no-service','--name','Performance benchmark'],opts);
 const s=await startService(bundle,`cold-${round}-${label}`,opts);
 try{rows.push({round,label,freshSetupMs:setup.ms,firstServeMs:s.ms,startedAt,loadBefore,loadAfter:os.loadavg()});save('cold',{rows});console.log(JSON.stringify(rows.at(-1)))}finally{await stopService(s.p);rmSync(directory,{recursive:true,force:true})}
 await sleep(500);
}
