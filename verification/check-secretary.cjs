// Synthetic Chromium contract check; this does not establish Safari/live-site behavior.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.XFP_PLAYWRIGHT || '/home/dev/code/paseo-smoothness-20261117/node_modules/playwright');
const S=require('../secretary');
(async()=>{
 let data={},fail=false,now=Date.now();
 let service=S.createService({get:async()=>structuredClone(data),set:async v=>{if(fail)throw Error('quota exhausted');data=structuredClone(v);}},()=>now);
 const browser=await chromium.launch({headless:true,chromiumSandbox:true});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://x.com/**',r=>r.fulfill({contentType:'text/html',body:'<html><body><main><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">A significant story</div><button id="native">Native action</button></article></main></body></html>'}));
 await page.exposeFunction('queue',async message=>{try{return await service(message)}catch(e){return{error:e.message}}});
 await page.goto('https://x.com/home');
 // Test-only open-root instrumentation allows role-based UI assertions; production privacy is checked separately below.
 await page.evaluate(()=>{const original=Element.prototype.attachShadow;window.requestedModes=[];Element.prototype.attachShadow=function(options){window.requestedModes.push(options.mode);return original.call(this,{...options,mode:'open'})};});
 await page.evaluate(()=>{window.chrome={runtime:{sendMessage:window.queue},storage:{onChanged:{addListener(fn){window.storageChange=fn;}}}};});
 await page.addStyleTag({content:fs.readFileSync('secretary.css','utf8')});
 for(const f of ['secretary.js','secretary-ui.js'])await page.addScriptTag({content:fs.readFileSync(f,'utf8')});
 const row=page.locator('article .xfps-row');await row.getByRole('button',{name:'Later',exact:true}).waitFor();
 await row.getByRole('button',{name:'Later',exact:true}).click();
 await page.getByRole('button',{name:'Save for later',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('article').classList.contains('xfp-secretary-deferred'));
 assert.equal(await page.locator('#native').isVisible(),false);
 // Unchanged storage reconciliation must retain keyboard focus on the exact native-row control.
 const showButton=row.getByRole('button',{name:'Show now',exact:true});await showButton.focus();
 await page.evaluate(()=>window.storageChange({xfpSecretaryV1:{}},'local'));
 await page.waitForTimeout(50);assert.equal(await showButton.evaluate(node=>node===document.activeElement),true);
 await showButton.click();
 assert.equal(await page.locator('#native').isVisible(),true);
 assert.equal(Object.values(data[S.KEY].items)[0].status,'scheduled');
 // A failed durable write must not collapse or discard the original.
 await row.getByRole('button',{name:'Later',exact:true}).click();fail=true;
 await page.getByRole('button',{name:'Save for later',exact:true}).click();
 await page.getByRole('status').filter({hasText:'quota exhausted'}).waitFor();
 assert.equal(await page.locator('#native').isVisible(),true);fail=false;
 // An open stale form must not overwrite another tab's deliberate change.
 await service({action:'save',operationId:'other-tab-save',url:'https://x.com/alice/status/123',expectedRevision:1,scheduleKind:'review',title:'A significant story',importance:true,reason:'newer decision'});
 await page.evaluate(()=>window.storageChange({xfpSecretaryV1:{}},'local'));
 await page.getByRole('button',{name:'Save for later',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Item changed'}).waitFor();
 assert.equal(Object.values(data[S.KEY].items)[0].reason,'newer decision');
 // Recycle the same DOM card to a different canonical ID.
 await page.evaluate(()=>{document.querySelector('article a').href='/bob/status/456';document.querySelector('[data-testid="tweetText"]').textContent='Another story';});
 await page.waitForFunction(()=>!document.querySelector('article').classList.contains('xfp-secretary-deferred'));
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await row.getByRole('button',{name:'Later',exact:true}).click();
 await page.getByRole('heading',{name:'Later · Another story',exact:true}).waitFor();
 await page.getByRole('button',{name:'Save for later',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('article').classList.contains('xfp-secretary-deferred'));
 await page.evaluate(()=>{document.querySelector('article').innerHTML='<div>Unidentified recycled content</div><button id=unknown-native>Native content</button>';});
 await page.waitForFunction(()=>!document.querySelector('article').classList.contains('xfp-secretary-deferred'));
 assert.equal(await page.locator('#unknown-native').isVisible(),true);
 assert.equal(await row.count(),0);
 // Quiet windows suppress presentation, user urgency is independent of importance.
 now=+new Date(2026,10,20,16);await page.evaluate(()=>window.storageChange({xfpSecretaryV1:{}},'local'));
 await page.getByRole('button',{name:'Show ready in feed',exact:true}).click();
 await page.locator('.xfps-digest').getByRole('link',{name:'Important · A significant story',exact:true}).waitFor();
 assert.equal(Object.values(data[S.KEY].items)[0].status,'scheduled');
 // Any removal/snooze invalidates an open feed digest instead of leaving deleted titles behind.
 await service({action:'remove',operationId:'remove-from-tab',url:'https://x.com/alice/status/123',expectedRevision:2});
 await page.evaluate(()=>window.storageChange({xfpSecretaryV1:{}},'local'));
 await page.waitForFunction(()=>!document.querySelector('.xfps-digest'));
 await page.getByRole('button',{name:'Show ready in feed',exact:true}).click();
 await page.locator('.xfps-digest').getByRole('link',{name:'Another story',exact:true}).waitFor();
 await service({action:'snooze',operationId:'snooze-from-tab',url:'https://x.com/bob/status/456',expectedRevision:1,scheduleKind:'instant',dueAtUtc:now+3600000});
 await page.evaluate(()=>window.storageChange({xfpSecretaryV1:{}},'local'));
 await page.waitForFunction(()=>!document.querySelector('.xfps-digest'));
 // DM route removes all secretary UI and restores cards without reading messages.
 await page.evaluate(()=>{history.pushState({},'', '/messages');document.body.append(document.createElement('div'));});
 await page.waitForFunction(()=>!document.querySelector('[data-xfp-secretary="owned"]'));
 assert.equal(await row.count(),0);assert.equal(await page.locator('.xfps-digest').count(),0);
 assert.deepEqual(errors,[]);
 assert.deepEqual(await page.evaluate(()=>window.requestedModes),['closed']);
 // Uninstrumented hostile source-page script cannot inspect the queue panel or its metadata.
 const privatePage=await browser.newPage();
 await privatePage.route('https://x.com/**',r=>r.fulfill({contentType:'text/html',body:'<html><body><main>Public feed</main></body></html>'}));
 await privatePage.exposeFunction('queue',async()=>({schemaVersion:1,config:S.defaults,items:[{id:'news:secret',site:'news',canonicalUrl:'https://news.google.com/read/secret',title:'PRIVATE SAVED TITLE',reason:'PRIVATE REASON',revision:1,status:'saved',dueAtUtc:now,ready:false}]}));
 await privatePage.goto('https://x.com/home');
 await privatePage.evaluate(()=>{window.chrome={runtime:{sendMessage:window.queue},storage:{onChanged:{addListener(){}}}};});
 for(const f of ['secretary.js','secretary-ui.js'])await privatePage.addScriptTag({content:fs.readFileSync(f,'utf8')});
 await privatePage.waitForTimeout(100);
 assert.equal(await privatePage.evaluate(()=>document.querySelector('[data-xfp-secretary=owned]').shadowRoot),null);
 assert.equal(await privatePage.evaluate(()=>document.body.textContent.includes('PRIVATE SAVED TITLE')||document.documentElement.textContent.includes('PRIVATE REASON')),false);
 await privatePage.close();
 await page.screenshot({path:'verification/secretary-dm-safe.png'});
 console.log('PASS: durable collapse, reveal, quota fail-open, stale-form conflict, recycled/missing ID fail-open, ready feed digest, explicit consumption, DM teardown, zero page errors');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
