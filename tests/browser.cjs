const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;

function markup(text, id='m') {
    return `<div role="presentation"><span dir="auto"><div dir="auto" id="${id}">${text}</div></span></div>`;
}
async function fixture(html=markup('danger'), responder=null, timeout=2000, initialHistory=false) {
    const page = await browser.newPage({viewport:{width:1000,height:700}});
    const stats = {calls:0, active:0, peak:0, texts:[], errors:[]};
    page.on('pageerror', error => stats.errors.push(error.message));
    await page.route('**/*', async route => {
        if (route.request().url().includes('127.0.0.1:5000/analyze')) {
            const body = route.request().postDataJSON();
            stats.calls++; stats.active++; stats.peak = Math.max(stats.peak, stats.active); stats.texts.push(body.text);
            try {
                const value = responder ? await responder(body, stats) : {risk_level:body.text.includes('safe')?'low':'high',category:'test'};
                await route.fulfill({status:value.status || 200, contentType:'application/json',
                    headers:{'Access-Control-Allow-Origin':'https://www.messenger.com',
                        'Access-Control-Expose-Headers':'X-Analysis-Source, Retry-After',...value.headers,'X-Analysis-Source':'gemini'},
                    body:JSON.stringify(value.body || value)});
            } catch (error) {
                // Closing a test page or AbortController can cancel the route.
                if (!page.isClosed()) stats.errors.push(error.message);
            } finally { stats.active--; }
        } else await route.fulfill({contentType:'text/html',body:`<!doctype html><html><head></head><body><main id="messages" role="grid">${initialHistory ? html : markup("","seed")}</main><aside id="other"></aside></body></html>`});
    });
    await page.goto('https://www.messenger.com/t/fixture');
    // Accelerate only startup/retry/deadline timers, preserving production logic.
    const instrumented = source.replace('}, 3000);','}, 30);')
        .replace('const RETRY_DELAYS_MS = [1000, 3000];','const RETRY_DELAYS_MS = [100, 200];')
        .replace('const REQUEST_TIMEOUT_MS = 30000;',`const REQUEST_TIMEOUT_MS = ${timeout};`);
    await page.addScriptTag({content:instrumented});
    await page.waitForFunction(() => isReady);
    if (!initialHistory) {
        await page.locator('#messages').evaluate((group, content) => group.insertAdjacentHTML('beforeend', content), html);
    }
    return {page,stats};
}
async function check(name, fn) {
    const started = Date.now();
    try { await fn(); results.push({name,pass:true,ms:Date.now()-started}); console.log('PASS',name); }
    catch(error) { results.push({name,pass:false,error:error.stack}); console.log('FAIL',name,error.message); }
}
async function withFixture(html,responder,fn,timeout) {
    const f = await fixture(html,responder,timeout);
    try { await fn(f); assert.deepEqual(f.stats.errors,[]); }
    finally { await f.page.close(); }
}

(async()=>{
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    await check('switching chats analyzes all visible arrivals and prepended history; quota retry targets one message',async()=>{
        const {page,stats}=await fixture(markup('safe A'),(body,stats)=>
            body.text==='new' && stats.texts.filter(t=>t==='new').length===1 ? {status:429,headers:{'Retry-After':'1'}} : {risk_level:'low',category:'test'},2000,true);
        try {
            await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudStatus==='done');
            await page.evaluate(html=>{
                history.pushState(null,'','/t/other');
                document.querySelector('#messages').innerHTML=html;
            },Array.from({length:8},(_,i)=>markup('B'+i,'b'+i)).join(''));
            await page.waitForFunction(()=>document.querySelectorAll('[data-antifraud-status="done"]').length===8);
            assert.deepEqual([...stats.texts].sort(),['B0','B1','B2','B3','B4','B5','B6','B7','safe A']);
            await page.locator('#messages').evaluate((el,html)=>el.insertAdjacentHTML('afterbegin',html),markup('older','older'));
            await page.waitForFunction(()=>document.querySelector('#older').dataset.antifraudStatus==='done');
            assert.equal(await page.getByRole('button').count(),0);
            await page.locator('#messages').evaluate((el,html)=>el.insertAdjacentHTML('beforeend',html),markup('new','latest'));
            const retry=page.getByRole('button',{name:/重試這一則/});
            await retry.waitFor(); assert.equal(await retry.isDisabled(),true);
            await retry.click();
            await page.waitForFunction(()=>document.querySelector('#latest').dataset.antifraudStatus==='done');
            assert.deepEqual(stats.texts.slice(9),['older','new','new']);
            assert.deepEqual(stats.errors,[]);
        } finally {await page.close();}
    });
    await check('in-place edit reanalyzed; old high warning cleared',()=>withFixture(markup('danger'),null,async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        await page.locator('#m').evaluate(el=>el.firstChild.data='safe replacement');
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudStatus==='done' && !document.querySelector('#m').hasAttribute('data-antifraud-risk'));
        assert.deepEqual(stats.texts,['danger','safe replacement']);
    }));
    await check('late old response cannot annotate changed text',()=>withFixture(markup('danger'),async body=>{
        if(body.text==='danger') await wait(250);
        return {risk_level:body.text==='danger'?'high':'low',category:'test'};
    },async({page,stats})=>{
        await page.waitForFunction(()=>pendingRequests.size===1);
        await page.locator('#m').evaluate(el=>el.textContent='safe now');
        await wait(450);
        assert.equal(await page.locator('#m').getAttribute('data-antifraud-risk'),null);
        assert.equal(await page.locator('#m').getAttribute('data-antifraud-status'),'done');
        assert.equal(stats.calls,2);
    }));
    await check('12 concurrent duplicate bubbles issue one request',()=>withFixture(Array.from({length:12},(_,i)=>markup('duplicate',`m${i}`)).join(''),async()=>{
        await wait(100);return {risk_level:'high',category:'test'};
    },async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelectorAll('[data-antifraud-risk="high"]').length===12);
        assert.equal(stats.calls,1);
    }));
    await check('transient error retries and recovers',()=>withFixture(markup('danger'),async(body,stats)=>stats.calls===1?{status:503,body:{risk_level:'error'}}:{risk_level:'high',category:'test'},async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        assert.equal(stats.calls,2);
    }));
    await check('429 shows quota warning without retrying that message',()=>withFixture(markup('danger'),async()=>({status:429,body:{error:'provider_rate_limited'}}),async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudStatus==='error');
        assert.match(await page.locator('#m').getAttribute('data-antifraud-warning'),/用量上限/);
        await wait(450);
        assert.equal(stats.calls,1);
    }));
    await check('manual context keeps identical target text independent by history',()=>withFixture(
        markup('轉好了嗎？','one') + markup('轉好了嗎？','two'),
        async body=>body.messages ?
            {risk_level:body.messages[0].text==='朋友分帳'?'low':'high',category:'前文測試',
                evidence:[{message:1,kind:'risk_signal',quote:body.messages[0].text}]} :
            {risk_level:'low',category:'單句測試'},
        async({page,stats})=>{
            await page.waitForFunction(()=>document.querySelectorAll('[data-antifraud-status="done"]').length===2);
            await page.evaluate(async()=>{
                await reviewMessage(document.querySelector('#one'),[{speaker:'self',text:'朋友分帳'}],'other');
                await reviewMessage(document.querySelector('#two'),[{speaker:'other',text:'拒絕核對'}],'other');
            });
            assert.equal(await page.locator('#one').getAttribute('data-antifraud-risk'),null);
            assert.equal(await page.locator('#two').getAttribute('data-antifraud-risk'),'high');
            assert.match(await page.locator('#two').getAttribute('data-antifraud-warning'),/第 1 則.*拒絕核對/);
            assert.equal(stats.calls,3);
        }));
    await check('context 429 preserves the initial high warning',()=>withFixture(markup('danger'),async body=>
        body.messages ? {status:429,body:{error:'provider_rate_limited'}} : {risk_level:'high',category:'警示'},
        async({page})=>{
            await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
            await page.evaluate(()=>reviewMessage(document.querySelector('#m'),[{speaker:'other',text:'prior'}],'other').catch(()=>{}));
            assert.equal(await page.locator('#m').getAttribute('data-antifraud-risk'),'high');
            assert.match(await page.locator('#m').getAttribute('data-antifraud-warning'),/警示.*複核未完成/);
        }));
    await check('automatic context requires opt-in for the recognized chat container',()=>withFixture(
        markup('earlier','prior') + markup('initial high','m'),
        async body=>({risk_level:body.messages ? 'medium' : 'high',category:'test',
            evidence:body.messages ? [{message:1,kind:'risk_signal',quote:'earlier'}] : []}),
        async({page,stats})=>{
            await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudStatus==='done');
            await page.evaluate(()=>{
                history.replaceState(null,'','/t/fixture');
                document.querySelector('#messages').setAttribute('role','grid');
            });
            assert.ok(stats.texts.every(text=>typeof text==='string'));
            await page.evaluate(()=>{
                const scope=chatScope(document.querySelector('#m'));
                contextEnabled.set(scope.path,scope.group);
                document.querySelector('#m').textContent='new high text';
            });
            await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudWarning?.startsWith('前文複核：'));
            assert.equal(stats.texts.filter(text=>text===undefined).length,1);
        }));
    await check('persistent error stops after three attempts with visible status',()=>withFixture(markup('danger'),async()=>({status:503,body:{risk_level:'error'}}),async({page,stats})=>{
        await page.waitForFunction(()=>processedElements.get(document.querySelector('#m'))?.attempts===3 && document.querySelector('#m').dataset.antifraudStatus==='error');
        await wait(400);assert.equal(stats.calls,3);
        assert.match(await page.locator('#m').getAttribute('data-antifraud-warning'),/請勿視為安全/);
        assert.equal(await page.evaluate(()=>pendingRequests.size),0);
    }));
    await check('invalid model schema never cached or marked safe',()=>withFixture(markup('danger'),async()=>({risk_level:'low',category:42}),async({page})=>{
        await page.waitForFunction(()=>processedElements.get(document.querySelector('#m'))?.attempts===3 && document.querySelector('#m').dataset.antifraudStatus==='error');
        assert.equal(await page.evaluate(()=>resultCache.size),0);
    }));
    await check('long replacement clears risk and shows skipped state',()=>withFixture(markup('danger'),null,async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        await page.locator('#m').evaluate(el=>el.textContent='x'.repeat(1000));
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudStatus==='skipped');
        assert.equal(await page.locator('#m').getAttribute('data-antifraud-risk'),null);
        assert.equal(stats.calls,1);
    }));
    await check('offscreen message waits until visible',()=>withFixture('<div style="height:1600px"></div>'+markup('danger'),null,async({page,stats})=>{
        await wait(150);assert.equal(stats.calls,0);
        await page.locator('#m').scrollIntoViewIfNeeded();
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        assert.equal(stats.calls,1);
    }));
    await check('12 unique requests never exceed four active fetches',()=>withFixture(Array.from({length:12},(_,i)=>markup(`unique ${i}`,`m${i}`)).join(''),async()=>{
        await wait(100);return {risk_level:'low',category:'test'};
    },async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelectorAll('[data-antifraud-status="done"]').length===12);
        assert.equal(stats.calls,12);assert.equal(stats.peak,4);
        assert.equal(await page.evaluate(()=>metrics.maxActive),4);
    }));
    await check('LRU bounded at 500; expired result fetched again',()=>withFixture('',null,async({page,stats})=>{
        const state=await page.evaluate(async()=>{
            for(let i=0;i<510;i++)cacheResult('cache '+i,{risk_level:'low',category:'test'});
            const count=resultCache.size, evicted=!resultCache.has('cache 0');
            await analyzeText('fresh');
            resultCache.get(JSON.stringify(['single', 'fresh'])).expiresAt=Date.now()-1;
            await analyzeText('fresh');
            return {count,evicted};
        });
        assert.deepEqual(state,{count:500,evicted:true});assert.equal(stats.calls,2);
    }));
    await check('detached nodes released from observers and state',()=>withFixture(markup('danger'),null,async({page})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        await page.locator('#messages').evaluate(el=>el.textContent='');
        await page.waitForFunction(()=>observedElements.size===0 && visibleElements.size===0);
    }));
    await check('replacement node reuses cached result',()=>withFixture(markup('danger'),null,async({page,stats})=>{
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        await page.locator('#messages').evaluate((el,html)=>el.innerHTML=html,markup('danger'));
        await page.waitForFunction(()=>document.querySelector('#m').dataset.antifraudRisk==='high');
        assert.equal(stats.calls,1);
        assert.equal(await page.locator('#m').getAttribute('data-antifraud-source'),'memory');
    }));
    await check('high-risk advice and source timing are attached to the warning',()=>withFixture(markup('danger'),async()=>({risk_level:'high',category:'釣魚'}),async({page})=>{
        await page.waitForFunction(()=>document.querySelector('#m').hasAttribute('data-antifraud-latency-ms'));
        assert.match(await page.locator('#m').getAttribute('data-antifraud-warning'),/請勿提供驗證碼/);
        assert.equal(await page.locator('#m').getAttribute('data-antifraud-source'),'gemini');
        assert.ok(Number(await page.locator('#m').getAttribute('data-antifraud-latency-ms'))>=0);
    }));
    await check('fetch deadline releases pending slot and reports error',()=>withFixture(markup('danger'),async()=>{
        await wait(200);return {risk_level:'high',category:'test'};
    },async({page,stats})=>{
        await page.waitForFunction(()=>processedElements.get(document.querySelector('#m'))?.attempts===3 && document.querySelector('#m').dataset.antifraudStatus==='error');
        await page.waitForFunction(()=>pendingRequests.size===0 && activeRequests===0);
        assert.equal(stats.calls,3);
    },50));
    const out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({browser:browser.version(),
        fixture:'Headless Chrome, synthetic messenger-shaped DOM, intercepted local API; startup/retry/deadline timers shortened',
        summary:{passed:results.filter(r=>r.pass).length,total:results.length},tests:results},null,2));
    await browser.close();
    if(results.some(r=>!r.pass))process.exitCode=1;
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1});
