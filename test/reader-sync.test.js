// Paradise Reader sync (sync.js): off by default, batching, and no uploads
// while signed out or opted out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const READER = 'https://reader.test';
const ISSUER = 'https://id.test/api/auth';
const CLIENT = 'ext-client';

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function idToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'EdDSA' })}.${b64url({ iss: ISSUER, aud: CLIENT, sub: 'user-a', name: 'Ada', iat: now, exp: now + 3600, ...claims })}.sig`;
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Fake timers: run() fires due timers in order.
function clock() {
  let t = Date.now();
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      t += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
      }
      await new Promise(r => setImmediate(r));
    }
  };
}

function setup({ local = {}, handler } = {}) {
  const calls = [];
  const c = clock();
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (call.url === `${READER}/api/config`) return json(200, { issuer: ISSUER, extensionClientId: CLIENT, readerUrl: READER });
    if (call.url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/authorize`, token_endpoint: `${ISSUER}/oauth2/token`, revocation_endpoint: `${ISSUER}/oauth2/revoke` });
    }
    return handler ? handler(call, calls) : json(200, { saved: 0, total: 0 });
  };
  const chrome = {
    storage: { local: storageArea({ xfpReaderOrigin: READER, ...local }) },
    identity: { getRedirectURL: () => 'https://abc.chromiumapp.org/', launchWebAuthFlow: null }
  };
  const context = { URL, URLSearchParams, TextEncoder, atob, btoa, crypto: globalThis.crypto, console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('sync.js'), context);
  const sync = context.XFPReaderSync.createReaderSync({
    chrome, fetch: fetchImpl, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, debounceMs: 8000
  });
  return { sync, calls, clock: c, chrome, uploads: () => calls.filter(x => x.url === `${READER}/v1/items` && x.method === 'POST') };
}

const signedIn = (extra = {}) => ({
  xfpReader: { optIn: true, account: { name: 'Ada' }, ...extra },
  xfpReaderAuth: { idToken: idToken(), refreshToken: 'rt-1', exp: Math.floor(Date.now() / 1000) + 3600 }
});

const post = i => ({ id: String(1800000000000000000n + BigInt(i)), handle: `user${i}`, name: `User ${i}`, text: `post ${i}`, postedAt: Date.UTC(2026, 9, 20) + i, score: 40, kept: true, thumb: null });

test('reader sync is off by default: nothing queued or uploaded', async () => {
  const { sync, calls, clock: c } = setup();
  const st = await sync.status();
  assert.equal(st.optIn, false);
  assert.equal(st.signedIn, false);
  assert.equal((await sync.enqueue([post(1)])).queued, 0);
  await c.advance(60_000);
  await sync.flush();
  assert.equal(calls.length, 0);
});

test('no upload while signed out, even when opted in', async () => {
  const { sync, calls, clock: c } = setup({ local: { xfpReader: { optIn: true, account: null } } });
  assert.equal((await sync.enqueue([post(1), post(2)])).queued, 0);
  await c.advance(60_000);
  await sync.flush();
  assert.equal(calls.length, 0);
});

test('no upload while opted out, even when signed in', async () => {
  const { sync, calls, clock: c } = setup({ local: signedIn({ optIn: false }) });
  assert.equal((await sync.enqueue([post(1)])).queued, 0);
  await c.advance(60_000);
  assert.equal(calls.length, 0);
});

test('opted in + signed in: debounced batches of at most 50', async () => {
  const { sync, uploads, clock: c, chrome } = setup({
    local: signedIn(),
    handler: (call, calls) => json(200, { saved: JSON.parse(call.body).items.length, total: calls.length })
  });
  for (let i = 0; i < 120; i++) await sync.enqueue([post(i)]);
  assert.equal(uploads().length, 0, 'nothing sent before the debounce window');
  await c.advance(8000);
  const sizes = uploads().map(u => JSON.parse(u.body).items.length);
  assert.deepEqual(sizes, [50, 50, 20]);
  for (const u of uploads()) assert.match(u.headers.authorization, /^Bearer /);
  const st = await sync.status();
  assert.equal(st.pending, 0);
  assert.ok(st.lastSyncAt);
  assert.equal(chrome.storage.local.data.xfpReaderQueue.length, 0);
});

test('a re-scored post is sent once with its latest score', async () => {
  const { sync, uploads, clock: c } = setup({ local: signedIn() });
  await sync.enqueue([{ ...post(1), score: -5, kept: false }]);
  await sync.enqueue([{ ...post(1), score: 60, kept: true }]);
  await c.advance(8000);
  const items = JSON.parse(uploads()[0].body).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].score, 60);
  assert.equal(items[0].kept, true);
});

test('only disclosed fields are sent; non-X thumbnails are dropped', async () => {
  const { sync, uploads, clock: c } = setup({ local: signedIn() });
  await sync.enqueue([{ ...post(1), thumb: 'https://pbs.twimg.com/media/a.jpg', authorAvatar: 'x', metrics: { likes: 1 }, feedOwner: 'me' }]);
  await sync.enqueue([{ ...post(2), thumb: 'https://tracker.example/p.gif' }]);
  await sync.enqueue([{ id: 'not-a-post', handle: 'x', score: 1 }]);
  await c.advance(8000);
  const items = JSON.parse(uploads()[0].body).items;
  assert.equal(items.length, 2);
  assert.deepEqual(Object.keys(items[0]).sort(), ['handle', 'id', 'kept', 'name', 'postedAt', 'score', 'text', 'thumb']);
  assert.equal(items[0].thumb, 'https://pbs.twimg.com/media/a.jpg');
  assert.equal(items[1].thumb, null);
});

test('server errors back off exponentially and then succeed', async () => {
  let n = 0;
  const { sync, uploads, clock: c } = setup({
    local: signedIn(),
    handler: () => (++n <= 2 ? json(503, {}) : json(200, { saved: 1, total: 1 }))
  });
  await sync.enqueue([post(1)]);
  await c.advance(8000);
  assert.equal(uploads().length, 1);
  assert.match((await sync.status()).lastError, /retrying/);
  await c.advance(4000);
  assert.equal(uploads().length, 1, 'waits for the 5s backoff');
  await c.advance(1000);
  assert.equal(uploads().length, 2);
  await c.advance(9000);
  assert.equal(uploads().length, 2, 'second backoff is 10s');
  await c.advance(1000);
  assert.equal(uploads().length, 3);
  const st = await sync.status();
  assert.equal(st.pending, 0);
  assert.equal(st.lastError, null);
});

test('a 401 refreshes the token once, then retries', async () => {
  let first = true;
  const { sync, calls, uploads, clock: c, chrome } = setup({
    local: signedIn(),
    handler: call => {
      if (call.url.endsWith('/oauth2/token')) return json(200, { id_token: idToken({ name: 'Ada' }), refresh_token: 'rt-2' });
      if (first) { first = false; return json(401, {}); }
      return json(200, { saved: 1, total: 1 });
    }
  });
  await sync.enqueue([post(1)]);
  await c.advance(8000);
  assert.equal(uploads().length, 2);
  const refresh = calls.find(x => x.url.endsWith('/oauth2/token'));
  assert.match(refresh.body, /grant_type=refresh_token/);
  assert.match(refresh.body, /client_id=ext-client/);
  assert.equal(chrome.storage.local.data.xfpReaderAuth.refreshToken, 'rt-2');
});

test('a rejected refresh signs the user out and stops uploading', async () => {
  const { sync, uploads, clock: c, chrome } = setup({
    local: signedIn(),
    handler: call => (call.url.endsWith('/oauth2/token') ? json(400, { error: 'invalid_grant' }) : json(401, {}))
  });
  await sync.enqueue([post(1)]);
  await c.advance(8000);
  assert.equal(uploads().length, 1);
  const st = await sync.status();
  assert.equal(st.signedIn, false);
  assert.match(st.lastError, /Sign in again/);
  assert.equal(chrome.storage.local.data.xfpReaderAuth, undefined);
  assert.equal((await sync.enqueue([post(2)])).queued, 0);
});

test('turning the feature off drops anything waiting', async () => {
  const { sync, uploads, clock: c } = setup({ local: signedIn() });
  await sync.enqueue([post(1), post(2)]);
  await sync.setOptIn(false);
  await c.advance(60_000);
  assert.equal(uploads().length, 0);
  assert.equal((await sync.status()).pending, 0);
});

test('sign-in uses PKCE with the extension redirect and stores the account', async () => {
  const { sync, calls, chrome } = setup({
    local: { xfpReader: { optIn: true } },
    handler: call => {
      if (call.url.endsWith('/oauth2/token')) {
        const form = new URLSearchParams(call.body);
        return json(200, { id_token: idToken({ nonce: chrome._nonce }), refresh_token: 'rt-x', form: Object.fromEntries(form) });
      }
      return json(404, {});
    }
  });
  chrome.identity.launchWebAuthFlow = async ({ url, interactive }) => {
    assert.equal(interactive, true);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, `${ISSUER}/oauth2/authorize`);
    assert.equal(u.searchParams.get('client_id'), CLIENT);
    assert.equal(u.searchParams.get('redirect_uri'), 'https://abc.chromiumapp.org/');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope'), /offline_access/);
    chrome._nonce = u.searchParams.get('nonce');
    return `https://abc.chromiumapp.org/?code=c1&state=${u.searchParams.get('state')}&iss=${encodeURIComponent(ISSUER)}`;
  };
  const st = await sync.signIn();
  assert.equal(st.account.name, 'Ada');
  const tokenCall = calls.find(x => x.url.endsWith('/oauth2/token'));
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('client_id'), CLIENT);
  assert.ok(form.get('code_verifier').length >= 43);
  assert.equal(chrome.storage.local.data.xfpReaderAuth.refreshToken, 'rt-x');
  assert.equal((await sync.status()).signedIn, true);
});

test('sign-in refuses a token minted for another client', async () => {
  const { sync, chrome } = setup({
    local: { xfpReader: { optIn: true } },
    handler: () => json(200, { id_token: idToken({ aud: 'someone-else', nonce: chrome._nonce }) })
  });
  chrome.identity.launchWebAuthFlow = async ({ url }) => {
    const u = new URL(url);
    chrome._nonce = u.searchParams.get('nonce');
    return `https://abc.chromiumapp.org/?code=c1&state=${u.searchParams.get('state')}`;
  };
  await assert.rejects(sync.signIn(), /audience/);
  assert.equal((await sync.status()).signedIn, false);
});

test('delete-all calls DELETE with the bearer token and clears local counters', async () => {
  const { sync, calls } = setup({
    local: signedIn({ syncedTotal: 12, lastSyncAt: Date.now() }),
    handler: call => (call.method === 'DELETE' ? json(200, { deleted: 12 }) : json(404, {}))
  });
  assert.equal(await sync.deleteAll(), 12);
  const del = calls.find(x => x.method === 'DELETE');
  assert.equal(del.url, `${READER}/v1/items`);
  assert.match(del.headers.authorization, /^Bearer /);
  const st = await sync.status();
  assert.equal(st.syncedTotal, 0);
});

test('content script hands posts over only when the reader is on', () => {
  const content = read('content.js');
  assert.match(content, /async function readerRecord\(article, tweet, score\) \{\n\s+await readerReady;\n\s+if \(!readerOn \|\| !VibeFilter\.settings\.enabled\) return;/);
  assert.match(content, /readerOn = readerActive\(/);
  assert.equal((content.match(/readerRecord\(article, tweet, (score|aiScore)\);/g) || []).length, 2, 'initial score and AI refinement');
  assert.doesNotMatch(read('content-googlenews.js'), /XFP_READER_ITEM/, 'Google News is never uploaded');
  assert.doesNotMatch(content, /\bfetch\s*\(/);
});

test('manifest pins the development ID and keeps version 1.3.3', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.3.3');
  assert.ok(manifest.permissions.includes('identity'));
  assert.match(manifest.key, /^MIIB[A-Za-z0-9+/=]+$/);
  // Derive the extension ID from the key the way Chrome does.
  const hash = require('node:crypto').createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = hash.replace(/[0-9a-f]/g, ch => String.fromCharCode(97 + parseInt(ch, 16)));
  assert.equal(id, 'dljipjmfogkcfmbainbepkmblodkndph');
  assert.match(read('background.js'), /import '\.\/sync\.js';/);
  assert.match(read('build.sh'), /sync\.js/);
  assert.match(read('build.sh'), /popup-reader\.js/);
});

test('popup discloses fields, destination, privacy, retention and deletion before opt-in', () => {
  const html = read('popup.html');
  const consent = html.slice(html.indexOf('id="readerConsent"'), html.indexOf('id="readerConsentYes"'));
  for (const phrase of ['post link', 'author handle and name', 'post text and time', 'vibe score', 'kept or hidden', 'image thumbnail link',
    'Where it goes', 'Ideaflow ID', 'only you can see it', 'No sharing, no community feed', '2,000 posts', '30 days', 'Delete everything']) {
    assert.ok(consent.includes(phrase), phrase);
  }
  assert.match(html, /<input type="checkbox" id="readerOptIn">/, 'toggle starts unchecked');
  assert.match(read('popup-reader.js'), /e\.target\.checked = false;\n\s+\$\('readerConsent'\)\.hidden = false;/, 'checking the toggle shows the disclosure first');
});
