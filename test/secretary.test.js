const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const S = require('../secretary.js');
const friday = new Date(2026, 10, 20, 16).getTime();
function fixture() {
  let data = {}, fail = false;
  const storage = { get: async () => structuredClone(data), set: async value => { if (fail) throw Error('quota'); data = structuredClone(value); } };
  return { storage, fail: value => { fail = value; }, data: () => data };
}
const message = (extra = {}) => ({ action: 'save', operationId: 'operation-1', url: 'https://x.com/alice/status/123', expectedRevision: 0,
  title: '<img src=x onerror=alert(1)>', scheduleKind: 'review', ...extra });
test('durable acknowledgement, restart, duplicate operation and failed writes', async () => {
  const f = fixture(); let service = S.createService(f.storage, () => friday);
  await service(message());
  service = S.createService(f.storage, () => friday);
  assert.equal((await service(message())).duplicate, true);
  let list = await service({ action: 'list' });
  assert.equal(list.items.length, 1); assert.equal(list.items[0].ready, true);
  f.fail(true);
  await assert.rejects(service(message({ action: 'remove', expectedRevision: 1, operationId: 'operation-2' })), /quota/);
  list = await service({ action: 'list' }); assert.equal(list.items[0].status, 'scheduled');
});
test('two tabs serialize and stale revisions cannot overwrite each other', async () => {
  const f = fixture(); const service = S.createService(f.storage, () => friday);
  const result = await Promise.allSettled([service(message()), service(message({ operationId: 'operation-2', title: 'other tab' }))]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(result.find(r => r.status === 'rejected').reason.message, /changed/);
  assert.equal((await service({ action: 'list' })).items[0].title, '<img src=x onerror=alert(1)>');
});
test('delete before due remains deleted after restart; resave requires current tombstone revision', async () => {
  const f = fixture(); let service = S.createService(f.storage, () => friday);
  await service(message({ scheduleKind: 'instant', dueAtUtc: friday + 60000 }));
  await service(message({ action: 'remove', operationId: 'operation-2', expectedRevision: 1 }));
  service = S.createService(f.storage, () => friday + 120000);
  const removed = (await service({ action: 'list' })).items[0];
  assert.equal(removed.status, 'removed'); assert.equal(removed.ready, false);
  await assert.rejects(service(message({ operationId: 'operation-3' })), /changed/);
  await service(message({ operationId: 'operation-4', expectedRevision: 2 }));
  assert.equal((await service({ action: 'list' })).items[0].revision, 3);
});
test('quiet and delivery boundaries; importance never implies urgency', () => {
  const item = { status: 'scheduled', dueAtUtc: 0, scheduleKind: 'review', importance: true };
  for (const [day, hour, minute, ready] of [[20,14,59,false],[20,15,0,true],[20,16,59,true],[20,17,0,false],[21,16,0,false]]) {
    assert.equal(S.eligible(item, +new Date(2026,10,day,hour,minute)), ready);
  }
  item.scheduleKind = 'instant';
  for (const [h,m,ready] of [[8,59,false],[9,0,false],[11,59,false],[12,0,true],[21,29,true],[21,30,false]]) assert.equal(S.eligible(item,+new Date(2026,10,20,h,m)),ready);
  const now = +new Date(2026,10,20,10);
  assert.equal(S.eligible({...item,urgentUntil:now+1000,urgentReason:'explicit deadline'},now),true);
  assert.equal(S.eligible({...item,urgentUntil:now,urgentReason:'expired'},now),false);
});
test('missed review windows reconcile at next review; snooze avoids same-visit resurfacing', async () => {
  const f = fixture(); const service = S.createService(f.storage, () => friday);
  await service(message());
  await service(message({ action:'snooze',operationId:'operation-2',expectedRevision:1,scheduleKind:'instant',dueAtUtc:friday+3600000 }));
  assert.equal((await service({action:'list'})).items[0].ready,false);
  assert.equal(new Date(S.nextReview(+new Date(2026,10,20,18))).getDate(),27);
});
test('URL validation excludes DMs, credentials, injected protocols and non-source hosts', () => {
  for (const url of ['https://x.com/messages/123','https://x.com/i/chat/123','javascript:alert(1)','https://evil.test/a','https://alice:secret@x.com/a/status/1','https://x.com:4430/a/status/1']) assert.throws(()=>S.canonical(url));
  assert.equal(S.canonical('https://twitter.com/alice/status/123?tracking=yes').canonicalUrl,'https://x.com/alice/status/123');
});
test('invalid windows and unsupported urgency fail without storage writes', async () => {
  const f = fixture(); const service = S.createService(f.storage, () => friday);
  await assert.rejects(service(message({ urgentRequested:true, urgentReason:'',urgentUntil:0 })), /Urgent/);
  await assert.rejects(service(message({ urgentRequested:true, urgentReason:'deadline',urgentUntil:friday+86400001 })), /Urgent/);
  await assert.rejects(service({action:'settings',operationId:'settings-1',config:{deliveryStart:600}}), /quiet/);
  assert.deepEqual(f.data(),{});
});
test('Saved and Done are explicit; opening/listing does not consume an item', async () => {
  const f = fixture(); const service = S.createService(f.storage, () => friday);
  await service(message()); await service({action:'list'});
  await service(message({action:'saved',operationId:'operation-2',expectedRevision:1}));
  assert.equal((await service({action:'list'})).items[0].ready,false);
  await service(message({action:'done',operationId:'operation-3',expectedRevision:2}));
  assert.equal((await service({action:'list'})).items[0].status,'done');
});
test('DST calendar review and absolute deadlines survive time-zone travel', () => {
  const script = `const S=require('./secretary'); const s={...S.defaults,deliveryDay:0,deliveryStart:150,deliveryEnd:240,quietStart:540,quietEnd:720,wake:0,bedtime:1439};const n=S.nextReview(+new Date(2026,2,7,12),s);console.log(JSON.stringify([new Date(n).getHours(),new Date(n).getMinutes(),new Date(n).getDate()]));`;
  const out = spawnSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
  assert.equal(out.status,0); assert.deepEqual(JSON.parse(out.stdout),[3,0,8]); // nonexistent 02:30 resolves to the first valid minute.
  const instant = Date.parse('2026-11-20T20:00:00Z');
  const travel = spawnSync(process.execPath,['-e',`const S=require('./secretary');console.log(S.eligible({status:'scheduled',scheduleKind:'instant',dueAtUtc:${instant}},${instant}));`],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ:'America/Los_Angeles'},encoding:'utf8'});
  assert.equal(travel.stdout.trim(),'true');
});
test('500 active-item budget rejects the next save without losing existing items', async () => {
  const f = fixture(); const service = S.createService(f.storage, () => friday);
  for(let i=0;i<500;i++) await service(message({operationId:'operation-'+i,url:'https://x.com/a/status/'+i}));
  await assert.rejects(service(message({operationId:'operation-501',url:'https://x.com/a/status/501'})),/full/);
  assert.equal((await service({action:'list'})).items.length,500);
});
test('recurring review follows local wall time when traveling, while instant remains absolute', () => {
  const script = `const S=require('./secretary');const item={status:'scheduled',scheduleKind:'review',localDate:'2026-11-20',dueAtUtc:Date.parse('2026-11-20T23:00:00Z')};console.log(S.eligible(item,+new Date(2026,10,20,15,30)));console.log(new Date(S.reviewDue(item,S.defaults)).getHours());`;
  for (const TZ of ['Asia/Tokyo','America/Los_Angeles']) {
    const out=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'});
    assert.equal(out.status,0);assert.equal(out.stdout.trim(),'true\n15');
  }
});
test('Done expires after 30 days without retaining title/URL; individual deletion strips metadata', async () => {
  const f=fixture();let now=friday;const service=S.createService(f.storage,()=>now);
  await service(message());await service(message({action:'done',operationId:'operation-2',expectedRevision:1}));
  now+=30*86400000;
  const item=(await service({action:'list'})).items[0];
  assert.deepEqual(item,{id:'x:123',status:'removed',revision:3,dueAtUtc:undefined,ready:false});
  assert.equal(f.data()[S.KEY].items['x:123'].title,undefined);
});
test('worker validates sender origin, protects message routes/incognito and keeps clear popup-only', async () => {
  const vm=require('node:vm'),fs=require('node:fs');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../background.js'),'utf8').split('const secretary = globalThis.XFPSecretary.createService')[1];
  const f=fixture();let listener;
  const chrome={runtime:{id:'our-extension',onMessage:{addListener:fn=>listener=fn}},storage:{local:f.storage}};
  const context={chrome,URL,XFPSecretary:S}; context.globalThis=context;vm.createContext(context);
  vm.runInContext('const secretary = globalThis.XFPSecretary.createService'+source,context);
  const send=(sender,extra={})=>new Promise(resolve=>listener({type:'XFP_SECRETARY',action:'list',...extra},sender,resolve));
  for(const sender of [
    {id:'other',url:'https://x.com/home',tab:{}},
    {id:'our-extension',url:'https://x.com/messages',tab:{}},
    {id:'our-extension',url:'https://x.com/i/chat',tab:{}},
    {id:'our-extension',url:'https://x.com/home',tab:{incognito:true}},
    {id:'our-extension',url:'https://evil.test/',tab:{}}
  ]) assert.match((await send(sender)).error,/unavailable/);
  assert.equal((await send({id:'our-extension',url:'https://x.com/home',tab:{}})).items.length,0);
  assert.match((await send({id:'our-extension',url:'https://x.com/home',tab:{}},{action:'clear'})).error,/unavailable/);
  assert.equal((await send({id:'our-extension',url:'chrome-extension://our-extension/popup.html'})).items.length,0);
});
