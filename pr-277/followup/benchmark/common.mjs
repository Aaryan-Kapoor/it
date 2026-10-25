import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, realpathSync, accessSync, constants } from 'node:fs';
import { resolve, join, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
export const root=resolve(process.env.IT_BENCH_ROOT || process.cwd());
export const home='/tmp/it-perf';
export const base=home+'/baseline/it.mjs';
export const candidate=home+'/candidate/it.mjs';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
process.env.IT_E2E_APPS=home+'/apps';
const backend=process.env.IT_BACKEND_BIN;
if(!backend || !isAbsolute(backend)) throw new Error('IT_BACKEND_BIN must name an absolute path to a cached backend executable.');
const ownerHome=join(homedir(),'.it');
const inOwnerHome=path=>path===ownerHome || path.startsWith(ownerHome+sep);
if(inOwnerHome(resolve(backend))) throw new Error('Use a backend cache outside the owner service folder.');
const backendPath=realpathSync(backend);
if(inOwnerHome(backendPath)) throw new Error('Use a backend cache outside the owner service folder.');
accessSync(backendPath,constants.X_OK);
process.env.IT_BACKEND_BIN=backendPath;
process.env.IT_STACK_LOGS=home+'/logs';
process.env.IT_E2E_USAGE_URL='http://127.0.0.1:9/usage';
const {itEnv,reachesAnApp}=await import(pathToFileURL(join(root,'e2e/lib.mjs')).href);
export {reachesAnApp};
mkdirSync(home+'/logs',{recursive:true,mode:0o700});
mkdirSync(home+'/bench',{recursive:true,mode:0o700});
export const serviceHome=home+'/service';
export const env={...itEnv(serviceHome),IT_PORT:'4930'};
if(reachesAnApp(env,home+'/apps')) throw new Error('The isolated app environment is required.');
function childEnv(extra) {
 const result={...env,...extra};
 if(result.IT_PORT!=='4930' || result.IT_BACKEND_BIN!==backendPath ||
    (result.IT_HOME!==serviceHome && !/^\/tmp\/it-perf\/cold-[0-4]-(baseline|candidate)$/.test(result.IT_HOME))) {
  throw new Error('The isolated benchmark environment is required.');
 }
 return result;
}
const ownedServices=new Map();
export async function cli(bundle,args,extra={}) {
 const start=performance.now();
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[bundle,...args],{env:childEnv(extra),cwd:root,stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
  p.on('error',reject);p.on('close',code=>{let value;try {value=JSON.parse(out)}catch{value=out}; if(code!==0){let reason;try{reason=JSON.parse(err.trim().split('\n').at(-1)).error?.code}catch{}; reject(Object.assign(new Error(`command ${args[0]} failed (${code}, ${reason??'unknown'})`),{detail:err}));}else resolve({ms:performance.now()-start,value});});
 });
}
export async function startService(bundle,label='service',extra={}) {
 const surroundings=childEnv(extra);
 const fd=openSync(home+'/logs/'+label+'.log','a',0o600);
 const start=performance.now();let p;
 try {p=spawn(process.execPath,[bundle,'serve'],{env:surroundings,cwd:root,stdio:['ignore',fd,fd]});}
 finally {closeSync(fd);}
 let spawnError;
 p.on('error',error=>{spawnError=error;});
 const closed=new Promise(resolve=>p.once('close',resolve));
 ownedServices.set(p,closed);
 try {
  for(let i=0;i<1200;i++) {
   if(spawnError)throw new Error('The service could not be started.');
   if(p.exitCode!==null || p.signalCode!==null)throw new Error('The service exited before readiness.');
   const healthy=await fetch('http://localhost:4930/health').then(r=>r.ok).catch(()=>false);
   if(readFileSync(home+'/logs/'+label+'.log','utf8').includes('service started (pid '+p.pid+')') && healthy && await fetch('http://localhost:4930/').then(r=>r.ok).catch(()=>false) && await fetch('http://127.0.0.1:4971/health').then(r=>r.json()).then(v=>v.it===true).catch(()=>false)) return {p,ms:performance.now()-start};
   await sleep(25);
  }
  throw new Error('The service did not become ready.');
 }catch(error){await stopService(p);throw error;}
}
export async function stopService(p) {
 const closed=ownedServices.get(p);
 if(!closed)throw new Error('Only a service started by this process may be stopped.');
 if(p.pid && p.exitCode===null && p.signalCode===null)p.kill('SIGTERM');
 await closed;
 ownedServices.delete(p);
}
export function save(name,data){writeFileSync(home+'/bench/'+name+'.json',JSON.stringify(data,null,2)+'\n');}
export function summary(values) {
 const a=[...values].sort((a,b)=>a-b);
 if(!a.length)return {n:0};
 const q=p=>{const at=(a.length-1)*p,low=Math.floor(at),high=Math.ceil(at);return a[low]+(a[high]-a[low])*(at-low);};
 return {n:a.length,median:q(.5),p25:q(.25),p75:q(.75),min:a[0],max:a.at(-1)};
}
