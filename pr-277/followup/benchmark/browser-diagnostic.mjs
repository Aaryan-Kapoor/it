import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cli,home,root} from './common.mjs';
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
export async function browserRun(bundle,{network=false,encoding,shot}={}){
 const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
 try {
  const state=home+'/bench/browser-state.json';
  const context=await browser.newContext({viewport:{width:1440,height:900},...(existsSync(state)?{storageState:state}:{})});
  await context.addInitScript(()=>{
   window.__perf={};const stamp=()=>performance.timeOrigin+performance.now();
   if(window===window.top){
    document.addEventListener('click',e=>{if(e.target.closest?.('.card-title[href="/p/perf-00"]'))window.__perf.clickAt=stamp()},true);
    document.addEventListener('change',e=>{if(e.target.matches?.('.grid-sort'))window.__perf.sortAt=stamp()},true);
    const check=()=>{
     if(!window.__perf.cardsAt&&document.querySelectorAll('.page-card').length===50)window.__perf.cardsAt=stamp();
     if(window.__perf.sortAt&&!window.__perf.sortedAt&&document.querySelector('.card-title')?.textContent?.trim()==='Page 00')window.__perf.sortedAt=stamp();
     const frame=document.querySelector('.mount iframe');
     if(window.__perf.clickAt&&frame&&!window.__perf.frameAt){window.__perf.frameAt=stamp();frame.addEventListener('load',()=>window.__perf.frameLoadAt=stamp(),{once:true})}
    };
    new MutationObserver(check).observe(document,{subtree:true,childList:true,characterData:true});
   }else{
    document.addEventListener('DOMContentLoaded',()=>{
     window.__perf.domAt=stamp();
     if(window.It)It.onState(()=>{window.__perf.stateAt??=stamp()});
    },{once:true});
   }
  });
  const page=await context.newPage();
  const browserErrors={page:0,console:0,http:{}};page.on('pageerror',()=>browserErrors.page++);page.on('console',m=>{if(m.type()==='error')browserErrors.console++});page.on('response',r=>{if(r.status()>=400)browserErrors.http[r.status()]=(browserErrors.http[r.status()]??0)+1});
  if(!existsSync(state)){
   const {value}=await cli(bundle,['site','--no-open']);await page.goto(value.url);await page.locator('header.bar').waitFor();
   await context.storageState({path:state});await page.goto('about:blank');
  }
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  if(encoding)await cdp.send('Network.setAcceptedEncodings',{encodings:encoding==='identity'?[]:['gzip']});
  if(network)await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:20,downloadThroughput:1250000,uploadThroughput:1250000});
  const events=[],sent=new Map();const now=()=>performance.now();let start=now();
  cdp.on('Network.webSocketFrameSent',({response})=>{try{const m=JSON.parse(response.payloadData);if(['Mutation','Action'].includes(m.type))sent.set(m.requestId,{type:m.type,at:now(),name:m.udfPath});}catch{}});
  cdp.on('Network.webSocketFrameReceived',({response})=>{try{const m=JSON.parse(response.payloadData);const k=sent.get(m.requestId);if(k&&['MutationResponse','ActionResponse'].includes(m.type)){events.push({kind:k.type,name:k.name,startMs:k.at-start,durationMs:now()-k.at,success:m.success,...(!m.success&&m.errorData&&typeof m.errorData==='object'&&typeof m.errorData.code==='string'?{code:m.errorData.code}:{} )});sent.delete(m.requestId)}}catch{}});
  start=now();await page.goto('http://localhost:4930/',{waitUntil:'load'});
  await page.waitForFunction(()=>document.querySelectorAll('.page-card').length===50);
  const gridVisibleMs=now()-start;
  await page.locator('.grid-sort').selectOption('az');
  await page.waitForFunction(()=>document.querySelector('.card-title')?.textContent?.trim()==='Page 00');
  const gridInteractiveMs=now()-start;
  const nav=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {timeOrigin:performance.timeOrigin,loadMs:n.loadEventEnd,domContentMs:n.domContentLoadedEventEnd,resources:performance.getEntriesByType('resource').filter(r=>/\/assets\/.*\.js/.test(r.name)).map(r=>({bytes:r.encodedBodySize,duration:r.duration,file:r.name.split('/').at(-1)}))}});
  const openStart=now();await page.locator('.card-title[href="/p/perf-00"]').click();const clickReturned=now();
  await page.frameLocator('iframe').locator('#send').waitFor({state:'visible'});const visibleReturned=now();
  const frame=page.frames().find(f=>f!==page.mainFrame());await frame.evaluate(()=>new Promise(resolve=>It.onState(()=>resolve(true))));
  const openMs=now()-openStart;
  const inPage=await page.evaluate(()=>window.__perf),inFrame=await frame.evaluate(()=>window.__perf);
  if(shot)await page.screenshot({path:shot,fullPage:true});
  const diagnostic={clickCallMs:clickReturned-openStart,preClickMs:inPage.clickAt-(performance.timeOrigin+openStart),postReadyMs:(performance.timeOrigin+openStart+openMs)-inFrame.stateAt,visibilityPollMs:visibleReturned-clickReturned,domClickToStateMs:inFrame.stateAt-inPage.clickAt,domClickToFrameMs:inPage.frameAt-inPage.clickAt,domClickToFrameLoadMs:inPage.frameLoadAt-inPage.clickAt,domFrameToStateMs:inFrame.stateAt-inPage.frameAt,domGridVisibleMs:inPage.cardsAt-nav.timeOrigin,domGridSortedMs:inPage.sortedAt-nav.timeOrigin,events};
  return {browser,context,page,metrics:{gridVisibleMs,gridInteractiveMs,openMs,...nav,diagnostic,browserErrors}};
 }catch(e){await browser.close();throw e}
}
