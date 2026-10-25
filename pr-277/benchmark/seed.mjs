import {readFileSync} from 'node:fs';
import { cli,base,startService,stopService,save,sleep,serviceHome } from './common.mjs';
import {prepareClickFixture} from './hot.mjs';
const s=await startService(base,'baseline-seed');console.log(JSON.stringify({initialStartMs:s.ms}));
try {
 const rows=[];
 for(let i=0;i<50;i++){
  const n=String(i).padStart(2,'0');
  const r=await cli(base,['create','Page '+n,'--id','perf-'+n,'--html','<!doctype html><html><body><h1>Page '+n+'</h1><button id="send" onclick="It.action(\'ping\',{n:1})">Send</button></body></html>'],{IT_HARNESS:'claude-code',IT_SESSION:'perf-session'}); rows.push(r.ms);
  if(i%10===9)console.log('seeded '+(i+1));
  await sleep(1100);
 }
 await cli(base,['whoami']);
 const token=JSON.parse(readFileSync(serviceHome+'/token.json','utf8')).token;
 const fixture=await prepareClickFixture({token});
 save('seed',{initialStartMs:s.ms,publishMs:rows,fixture});
}finally{await stopService(s.p)}
