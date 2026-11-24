const fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const baselinePath=process.argv[2];
if(!baselinePath)throw new Error('Usage: node tests/benchmark_browser.cjs BASELINE_CONTENT_JS');
const baseline=fs.readFileSync(baselinePath,'utf8'), optimized=fs.readFileSync(path.join(root,'extension/content.js'),'utf8');
const selector='div[role="presentation"] span[dir="auto"] > div[dir="auto"]';
const bubble='<div role="presentation"><span dir="auto"><div dir="auto">repeated benign fixture text</div></span></div>';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const rows=[];
 for(let trial=1;trial<=5;trial++)for(const [label,source] of [['baseline',baseline],['optimized',optimized]]){
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  let calls=0;
  await page.route('**/*',async route=>{
   if(route.request().url().includes('127.0.0.1:5000/analyze')){
    calls++;await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://www.messenger.com'},body:JSON.stringify({risk_level:'low',category:'test'})});
   }else await route.fulfill({contentType:'text/html',body:`<html><head></head><body><main id="messages">${bubble.repeat(1000)}</main></body></html>`});
  });
  await page.goto('https://www.messenger.com/benchmark-fixture');
  await page.evaluate(selector=>{
   window.measure={documentQueries:0,elementQueries:0,matchedNodes:0,observeCalls:0,selectorMs:0};
   for(const [proto,key] of [[Document.prototype,'documentQueries'],[Element.prototype,'elementQueries']]){
    const original=proto.querySelectorAll;
    proto.querySelectorAll=function(s){const start=performance.now();const result=original.call(this,s);
     if(s===selector){measure[key]++;measure.matchedNodes+=result.length;measure.selectorMs+=performance.now()-start;}return result;};
   }
   const original=IntersectionObserver.prototype.observe;
   IntersectionObserver.prototype.observe=function(el){measure.observeCalls++;return original.call(this,el);};
  },selector);
  await page.addScriptTag({content:source.replace('}, 3000);','}, 30);')});
  await page.waitForFunction(()=>isReady);
  await page.waitForTimeout(300);
  await page.evaluate(()=>{for(const k of Object.keys(measure))measure[k]=0;});
  const before=calls;
  for(let batch=0;batch<20;batch++){
   await page.locator('#messages').evaluate((el,html)=>el.insertAdjacentHTML('beforeend',html),bubble);
   await page.waitForTimeout(150);
  }
  const measured=await page.evaluate(()=>measure);
  rows.push({trial,version:label,...measured,additionalRequests:calls-before});
  console.log(JSON.stringify(rows.at(-1)));
  await page.close();
 }
 const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
 const summary={};
 for(const label of ['baseline','optimized']){
  const data=rows.filter(r=>r.version===label);summary[label]={};
  for(const field of ['documentQueries','elementQueries','matchedNodes','observeCalls','selectorMs','additionalRequests'])summary[label][field]=med(data.map(r=>r[field]));
 }
 const report={browser:browser.version(),workload:'1000 initial message elements; 20 batches each append one identical offscreen message, 150 ms apart; 5 paired trials; initial scans excluded; API mocked; startup 30 ms',rows,median:summary};
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/browser-benchmark.json'),JSON.stringify(report,null,2));
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
