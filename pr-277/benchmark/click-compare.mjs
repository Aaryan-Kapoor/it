import {readFileSync,statfsSync} from 'node:fs';
import os from 'node:os';
import {cli,base,candidate,startService,stopService,save,serviceHome} from './common.mjs';
import {browserRun} from './browser.mjs';
import {prepareClickFixture,runClickDelivery} from './hot.mjs';
const rows=[];
for(let round=0;round<2;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
 const disk=statfsSync('/tmp');if(disk.bavail*disk.bsize<4*2**30)throw new Error('less than 4 GiB free');
 const row={round,label,loadBefore:os.loadavg(),startedAt:new Date().toISOString()};
 const bundle=label==='baseline'?base:candidate;let s,b;
 try{
  s=await startService(bundle,label+'-click-comparison');
  await cli(bundle,['whoami']);
  const token=JSON.parse(readFileSync(serviceHome+'/token.json')).token;
  row.fixture=await prepareClickFixture({token});
  b=await browserRun(bundle);
  row.clicks=await runClickDelivery({page:b.page,iterations:5,warmup:1});
  row.loadAfter=os.loadavg();rows.push(row);save('click-compare',{rows});
  console.log(JSON.stringify({round,label,clicks:row.clicks.clickToDeliveryMs}));
 }finally{try{await b?.browser.close();}finally{if(s)await stopService(s.p)}}
}
