import {readFileSync,statfsSync} from 'node:fs';
import os from 'node:os';
import {base,candidate,startService,stopService,save,sleep} from './common.mjs';
import {browserRun} from './browser-diagnostic.mjs';
const rows=[];
function host(){const d=statfsSync('/tmp');return {at:new Date().toISOString(),load:os.loadavg(),freeGiB:d.bavail*d.bsize/2**30,cpu:readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)}}
function proc(pid){const t=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');return {userTicks:+t[11],systemTicks:+t[12]}}
for(let round=0;round<6;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
 const bundle=label==='baseline'?base:candidate, samples=[host()];if(samples[0].freeGiB<4)throw new Error('disk limit');
 const timer=setInterval(()=>samples.push(host()),1000);let s,b;
 try{
  s=await startService(bundle,label+'-diagnostic');const startupCpu=proc(s.p.pid);
  await sleep(1500);b=await browserRun(bundle);
  const row={round,label,startMs:s.ms,startupCpu,metrics:b.metrics,host:samples};
  await b.browser.close();b=null;samples.push(host());rows.push(row);save('diagnose', {rows});
  console.log(JSON.stringify({round,label,start:row.startMs,load:row.metrics.loadMs,grid:row.metrics.gridInteractiveMs,open:row.metrics.openMs,diagnostic:row.metrics.diagnostic}));
 }finally{clearInterval(timer);try{await b?.browser.close()}finally{if(s)await stopService(s.p)}}
 await sleep(1200);
}
