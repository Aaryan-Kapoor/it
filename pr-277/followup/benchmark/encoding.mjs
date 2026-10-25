import {readFileSync,statfsSync} from 'node:fs';import os from 'node:os';
import {candidate,startService,stopService,save,sleep,summary} from './common.mjs';import {browserRun} from './browser-diagnostic.mjs';
const rows=[];let s,b;
function host(){const d=statfsSync('/tmp');return {at:new Date().toISOString(),load:os.loadavg(),freeGiB:d.bavail*d.bsize/2**30,cpu:readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)}}
try{
 s=await startService(candidate,'encoding');await sleep(30000);
 for(let round=0;round<6;round++)for(const encoding of round%2?['identity','gzip']:['gzip','identity']){
  const samples=[host()];if(samples[0].freeGiB<4)throw new Error('disk limit');const timer=setInterval(()=>samples.push(host()),1000);
  try {b=await browserRun(candidate,{encoding});const row={round,encoding,metrics:b.metrics,host:samples};await b.browser.close();b=null;samples.push(host());rows.push(row);save('encoding',{rows});console.log(JSON.stringify({round,encoding,load:row.metrics.loadMs,grid:row.metrics.gridInteractiveMs,open:row.metrics.openMs,actualOpen:row.metrics.diagnostic.domClickToStateMs,failedCalls:row.metrics.diagnostic.events.filter(e=>!e.success).length,bytes:row.metrics.resources[0]?.bytes}));}
  finally{clearInterval(timer);await b?.browser.close();b=null}
  await sleep(16000);
 }
}finally{try{await b?.browser.close()}finally{if(s)await stopService(s.p)}}
for(const encoding of ['gzip','identity']){const r=rows.filter(x=>x.encoding===encoding);console.log(encoding,JSON.stringify(Object.fromEntries(['loadMs','gridInteractiveMs','openMs'].map(k=>[k,summary(r.map(x=>x.metrics[k]))]))))}
