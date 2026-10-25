import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {cli,home,base,root} from './common.mjs';
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
export async function browserRun(bundle,{profile=false,shot=false,network=false}={}){
 const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
 try {
 const state=home+'/bench/browser-state.json';
 const context=await browser.newContext({viewport:{width:1440,height:900},...(existsSync(state)?{storageState:state}:{})});
 const page=await context.newPage();
  if(!existsSync(state)) {
   const {value}=await cli(bundle,['site','--no-open']);
   await page.goto(value.url); await page.locator('header.bar').waitFor();
   await context.storageState({path:state});
   await page.goto('about:blank');
  }
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  if(network)await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:20,downloadThroughput:1250000,uploadThroughput:1250000});
  if(profile){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  const start=performance.now();
  await page.goto('http://localhost:4930/',{waitUntil:'load'});
  await page.waitForFunction(()=>document.querySelectorAll('.page-card').length===50);
  const gridVisibleMs=performance.now()-start;
  await page.locator('.grid-sort').selectOption('az');
  await page.waitForFunction(()=>document.querySelector('.card-title')?.textContent?.trim()==='Page 00');
  const gridInteractiveMs=performance.now()-start;
  const nav=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return {loadMs:n.loadEventEnd,domContentMs:n.domContentLoadedEventEnd,resources:performance.getEntriesByType('resource').filter(r=>/\/assets\/.*\.js/.test(r.name)).map(r=>({bytes:r.encodedBodySize,duration:r.duration,file:r.name.split('/').at(-1)}))}});
  if(profile){const {profile:p}=await cdp.send('Profiler.stop');writeFileSync(home+'/bench/site-'+(bundle===base?'baseline':'candidate')+'.cpuprofile',JSON.stringify(p));}
  if(shot)await page.screenshot({path:home+'/bench/grid.png',fullPage:true});
  const openStart=performance.now();
  await page.locator('.card-title[href="/p/perf-00"]').click();
  await page.frameLocator('iframe').locator('#send').waitFor({state:'visible'});
  const frame=page.frames().find(f=>f!==page.mainFrame());
  await frame.evaluate(()=>new Promise(resolve=>It.onState(()=>resolve(true))));
  const openMs=performance.now()-openStart;
  return {browser,context,page,metrics:{gridVisibleMs,gridInteractiveMs,openMs,...nav}};
 }catch(e){await browser.close();throw e}
}
