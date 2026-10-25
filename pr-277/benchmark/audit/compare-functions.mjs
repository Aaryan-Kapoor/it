import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const dir='/tmp/it-perf/cli-audit';
mkdirSync(dir,{recursive:true});
const resource=fileURLToPath(new URL('./resource.cjs',import.meta.url));
const variants={baseline:'/tmp/it-perf/baseline/it.mjs','functions-eager':dir+'/functions-eager.mjs','functions-lazy':dir+'/functions-lazy.mjs'};
const env={...process.env,IT_HOME:dir+'/compare-home',IT_PORT:'4930',IT_TELEMETRY_ENABLED:'0',IT_UPDATE_CHECK:'0'};
for(const key of ['IT_URL','IT_SESSION','IT_HARNESS','CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','HERMES_SESSION_ID','OPENCLAW_SESSION_ID','OPENCODE_SESSION_ID','PI_SESSION_ID','NODE_OPTIONS','NODE_COMPILE_CACHE'])delete env[key];
const results={};
for(const args of [['version'],['help'],['displays']]){
 const names=Object.keys(variants);
 const runs=Object.fromEntries(names.map(n=>[n,[]]));
 const outputs={};
 for(let i=0;i<13;i++){
  const order=names.slice(i%names.length).concat(names.slice(0,i%names.length));
  for(const name of order){
   const t=performance.now();
   const r=spawnSync(process.execPath,['--require',resource,variants[name],...args],{env,encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe','pipe']});
   const wallMs=performance.now()-t;
   if(r.error)throw r.error;
   const usage=JSON.parse(r.output[3]);
   if(i>=3)runs[name].push({wallMs,cpuMs:(usage.userCPUTime+usage.systemCPUTime)/1000,userMs:usage.userCPUTime/1000,systemMs:usage.systemCPUTime/1000,rssKb:usage.maxRSS});
   outputs[name]=JSON.stringify({status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});
  }
 }
 const median=(a)=>{const s=[...a].sort((a,b)=>a-b);return(s[4]+s[5])/2;};
 const summary=Object.fromEntries(names.map(name=>[name,{wallMs:median(runs[name].map(r=>r.wallMs)),cpuMs:median(runs[name].map(r=>r.cpuMs)),rssKb:median(runs[name].map(r=>r.rssKb)),outputIdentical:outputs[name]===outputs.baseline}]));
 results[args.join(' ')]={summary,runs};
 console.log(JSON.stringify({args,summary},null,2));
}
writeFileSync(dir+'/functions-comparison.json',JSON.stringify({node:process.version,preload:resource,rounds:13,warmups:3,variants,results},null,2));
