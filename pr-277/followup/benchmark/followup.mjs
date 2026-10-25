import {readFileSync,statfsSync} from 'node:fs';
import os from 'node:os';
import {cli,base,candidate,startService,stopService,save,sleep,serviceHome} from './common.mjs';
import {browserRun} from './browser-diagnostic.mjs';
import {runHotBackend,runConnectorProbe} from './hot.mjs';
const rows=[];
function host(){const disk=statfsSync('/tmp');return {at:new Date().toISOString(),load:os.loadavg(),freeGiB:disk.bavail*disk.bsize/2**30,cpu:readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)}}

function memory(pid){const t=readFileSync('/proc/'+pid+'/smaps_rollup','utf8');return {rssMiB:Number(t.match(/^Rss:\s+(\d+)/m)[1])/1024,pssMiB:Number(t.match(/^Pss:\s+(\d+)/m)[1])/1024}}
for(let round=0;round<12;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
 const blockStart=Date.now();
 const bundle=label==='baseline'?base:candidate;
 const hostSamples=[host()];
 if(hostSamples[0].freeGiB<4)throw new Error('less than 4 GiB free; stop heavy work');
 const sampler=setInterval(()=>hostSamples.push(host()),1000);
 let s,b;
 try{
  s=await startService(bundle,label+'-compare');
  const processStat=readFileSync(`/proc/${s.p.pid}/stat`,'utf8').split(') ')[1].split(' ');
  const row={round,label,startMs:s.ms,startupCpu:{userTicks:+processStat[11],systemTicks:+processStat[12],ticksPerSecond:100},cli:{},host:hostSamples};
  await sleep(1500);
  const children=readFileSync(`/proc/${s.p.pid}/task/${s.p.pid}/children`,'utf8').trim().split(/\s+/).map(Number);
  const backend=children.find(pid=>{try{return readFileSync(`/proc/${pid}/comm`,'utf8').startsWith('convex-local')}catch{return false}});
  row.memory={service:memory(s.p.pid),backend:memory(backend)};
  b=await browserRun(bundle);row.local=b.metrics;await b.browser.close();b=null;
  await sleep(1500);
  b=await browserRun(bundle,{network:true});row.network=b.metrics;
  for(const [name,args] of Object.entries({publish:['create','Page 48','--id','perf-48','--html','<h1>Page 48</h1>'],open:['open','perf-48'],actions:['actions','--id','perf-00'],waitTimeout:['wait','--id','perf-00','--timeout','0.01']})){
   row.cli[name]=[];
   for(let i=0;i<2;i++){row.cli[name].push((await cli(bundle,args,{IT_HARNESS:'claude-code',IT_SESSION:'perf-session'})).ms);await sleep(150);}
  }
  // Open the action page again after the CLI asked displays to show perf-48.
  await b.page.goto('http://localhost:4930/p/perf-00');await b.page.frameLocator('.mount iframe').locator('#send').waitFor();
  row.cli.waitReady=[];
  for(let i=0;i<2;i++){
   const frame=b.page.frames().find(f=>f!==b.page.mainFrame());
   await frame.evaluate(()=>It.action('ping',{n:1}));
   const result=await cli(bundle,['wait','--id','perf-00','--timeout','10']);
   if(!result.value.id)throw new Error('ready wait did not print action');
   row.cli.waitReady.push(result.ms);await cli(bundle,['ack',result.value.id]);
  }
  await b.browser.close();b=null;
  await cli(bundle,['whoami']);
  const token=JSON.parse(readFileSync(serviceHome+'/token.json')).token;
  row.hot=await runHotBackend({token,iterations:5,warmup:1});
  row.probe=await runConnectorProbe({iterations:5,warmup:1});
  hostSamples.push(host());rows.push(row);save('followup',{rows});
  console.log(JSON.stringify({round,label,start:row.startMs,load:row.local.loadMs,grid:row.local.gridInteractiveMs,open:row.local.openMs,actualOpen:row.local.diagnostic.domClickToStateMs,failedCalls:[...row.local.diagnostic.events,...row.network.diagnostic.events].filter(e=>!e.success).length,networkLoad:row.network.loadMs,networkGrid:row.network.gridInteractiveMs,cli:row.cli}));
 }finally{clearInterval(sampler);try{await b?.browser.close();}finally{if(s)await stopService(s.p)}}
 await sleep(Math.max(1200,30000-(Date.now()-blockStart)));
}
console.log('interleaved comparison complete');
