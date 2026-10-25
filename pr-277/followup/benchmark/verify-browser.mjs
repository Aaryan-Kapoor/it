import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {candidate,startService,stopService,save,sleep,cli,root,home} from './common.mjs';
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
let s,b;
try{
 s=await startService(candidate,'browser-verification');await sleep(30000);
 b=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
 const context=await b.newContext({viewport:{width:1440,height:900},storageState:home+'/bench/browser-state.json'});const page=await context.newPage();
 const errors={page:0,console:0,http:{}};page.on('pageerror',()=>errors.page++);page.on('console',m=>{if(m.type()==='error')errors.console++});page.on('response',r=>{if(r.status()>=400)errors.http[r.status()]=(errors.http[r.status()]??0)+1});
 const assets=[];page.on('response',r=>{const name=new URL(r.url()).pathname;if(name==='/'||/^\/assets\//.test(name))assets.push({path:name,status:r.status(),encoding:r.headers()['content-encoding']??'identity'})});
 const response=await page.goto('http://localhost:4930/',{waitUntil:'load'});if(response.status()!==200)throw new Error('site response failed');
 await page.waitForFunction(()=>document.querySelectorAll('.page-card').length===50);await page.locator('.grid-sort').selectOption('az');await page.waitForFunction(()=>document.querySelector('.card-title')?.textContent?.trim()==='Page 00');
 const cards=await page.locator('.page-card').count();await sleep(2000);await page.screenshot({path:home+'/followup-evidence/grid.png'});
 await page.locator('.card-title[href="/p/perf-00"]').click();const iframe=page.frameLocator('.mount iframe');await iframe.locator('#send').waitFor({state:'visible'});
 const frame=await page.locator('.mount iframe').elementHandle().then(h=>h.contentFrame());const gotState=await frame.evaluate(()=>new Promise(resolve=>It.onState(()=>resolve(true))));
 await page.screenshot({path:home+'/followup-evidence/page.png'});
 const clickedAt=Date.now();await iframe.locator('#send').click();const result=await cli(candidate,['wait','--id','perf-00','--timeout','15']);if(!result.value.id||result.value.action!=='ping'||result.value.sentByThePageItself===true||result.value.at<clickedAt)throw new Error('trusted page action was not received');await cli(candidate,['ack',result.value.id]);
 if(errors.page||errors.console||Object.keys(errors.http).length)throw new Error('browser reported errors');
 const report={cards,sortedFirst:'Page 00',siteStatus:response.status(),siteEncoding:response.headers()['content-encoding']??'identity',gotState,trustedActionReceived:true,errors,assets};
 save('browser-verification',report);console.log(JSON.stringify(report));
}finally{try{await b?.close()}finally{if(s)await stopService(s.p)}}
