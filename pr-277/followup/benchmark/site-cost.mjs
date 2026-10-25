import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';import {performance} from 'node:perf_hooks';
const root=resolve(process.env.IT_BENCH_ROOT||process.cwd());
const {build}=await import(pathToFileURL(join(root,'node_modules/esbuild/lib/main.js')).href);
for(const label of ['baseline','candidate'])await build({absWorkingDir:root,entryPoints:['packages/cli/src/serve/site.ts'],bundle:true,platform:'node',format:'esm',outfile:`/tmp/it-perf/bench/site-cost-${label}.mjs`,plugins:label==='baseline'?[{name:'original-handler',setup(b){b.onLoad({filter:/\/serve\/site\.ts$/},()=>({contents:execFileSync('git',['show','71b888ac:packages/cli/src/serve/site.ts'],{cwd:root,encoding:'utf8'}),loader:'ts'}))}}]:[]});
const b=await import('./site-cost-baseline.mjs'),c=await import('./site-cost-candidate.mjs');const name=Object.keys(c.BUILT).find(x=>/^assets\/index-.*\.js$/.test(x));const packed=c.BUILT[name];const bytes=gunzipSync(Buffer.from(packed.bytes,'base64'));const plain={type:packed.type,bytes:bytes.toString('base64')};const rows=[];
for(let round=0;round<60;round++)for(const kind of (round%2?['candidateIdentity','candidateGzip','baselineIdentity']:['baselineIdentity','candidateGzip','candidateIdentity'])){
 const file={...(kind==='baselineIdentity'?plain:packed)};const site={[name]:file};const fn=kind==='baselineIdentity'?b.answerSite:c.answerSite;const headers=new Headers({host:'localhost:4930','accept-encoding':kind==='candidateGzip'?'gzip':'identity'});
 const start=performance.now(),cpu=process.cpuUsage();const response=fn(site,'GET','/'+name,headers);const body=Buffer.from(await response.arrayBuffer());const used=process.cpuUsage(cpu),wallMs=performance.now()-start;
 if(!(kind==='candidateGzip'?gunzipSync(body):body).equals(bytes))throw new Error('serving changed the decoded bytes');
 rows.push({round,kind,warmup:round<10,wallMs,cpuMs:(used.user+used.system)/1000,bytes:body.length});
}
writeFileSync('/tmp/it-perf/bench/site-cost.json',JSON.stringify({fixtureDecodedBytes:bytes.length,rows},null,2));console.log('saved 50 measured cold-file requests per representation after 10 warmups');
