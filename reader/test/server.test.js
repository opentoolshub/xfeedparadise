// Server tests against a local test issuer (no production services).
// Runs against the in-memory store, and against Postgres too when
// TEST_DATABASE_URL points at a disposable database.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { startTestIssuer } from '../dev/local-issuer.js';
import { createApp } from '../src/server.js';
import { createAuth } from '../src/oidc.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';
import { createPgStore } from '../src/store-pg.js';

const READER = 'http://reader.test';
const EXT_ID = 'dljipjmfogkcfmbainbepkmblodkndph';
const EXT = `chrome-extension://${EXT_ID}`;
const DAY = 86_400_000;

const stores = [['memory', () => createMemoryStore({ perUser: 5, ttlDays: 30 })]];
if (process.env.TEST_DATABASE_URL) {
  stores.push(['postgres', () => createPgStore({ connectionString: process.env.TEST_DATABASE_URL, perUser: 5, ttlDays: 30 })]);
}

function post(i, extra = {}) {
  return {
    id: String(1_800_000_000_000_000_000n + BigInt(i)),
    handle: `user${i}`,
    name: `User ${i}`,
    text: `fixture post number ${i} SECRET-TEXT-${i}`,
    postedAt: Date.UTC(2026, 9, 20) + i * 60_000,
    score: i * 10 - 20,
    kept: i % 2 === 0,
    thumb: i === 1 ? 'https://pbs.twimg.com/media/abc.jpg' : 'https://evil.example/t.gif',
    ...extra
  };
}

for (const [kind, makeStore] of stores) {
  describe(`reader server (${kind} store)`, () => {
    let issuer, store, server, base, clock, logs;

    before(async () => {
      issuer = await startTestIssuer({
        clients: {
          'web-client': { secret: 'web-secret', redirectUris: [`${READER}/auth/callback`] },
          'ext-client': { secret: null, redirectUris: [`https://${EXT_ID}.chromiumapp.org/`] }
        }
      });
      const config = loadConfig({
        PUBLIC_ORIGIN: READER,
        EXTENSION_ORIGINS: EXT,
        OIDC_ISSUER: issuer.issuer,
        OIDC_WEB_CLIENT_ID: 'web-client',
        OIDC_WEB_CLIENT_SECRET: 'web-secret',
        OIDC_EXTENSION_CLIENT_IDS: 'ext-client',
        SESSION_SECRET: 'x'.repeat(40),
        READER_MAX_ITEMS: '5'
      });
      store = makeStore();
      await store.init();
      if (kind === 'postgres') await store.deleteAll('user-a'), await store.deleteAll('user-b');
      // Real time, so tokens minted by the issuer (which uses Date.now) line up.
      clock = { t: Date.now() };
      logs = [];
      const now = () => clock.t;
      const auth = createAuth(config, { now });
      server = createApp({ config, store, auth, now, log: line => logs.push(line) });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      await store.deleteAll('user-a');
      await store.deleteAll('user-b');
      await store.close();
      await issuer.close();
    });

    const tokenFor = (sub, extra = {}) => issuer.mint({ sub, aud: 'ext-client', azp: 'ext-client', iat: Math.floor(clock.t / 1000), exp: Math.floor(clock.t / 1000) + 3600, ...extra });
    const call = (path, { token, method = 'GET', body, origin, cookie } = {}) => fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });

    test('health check is public', async () => {
      const res = await call('/api/ok');
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
    });

    test('item routes require a valid token', async () => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await call('/v1/items', { method, body: method === 'POST' ? { items: [] } : undefined });
        assert.equal(res.status, 401, method);
      }
      const bad = [
        'not-a-jwt',
        tokenFor('user-a', { aud: 'some-other-app', azp: 'some-other-app' }),
        tokenFor('user-a', { iss: 'https://evil.example/api/auth' }),
        tokenFor('user-a', { exp: Math.floor(clock.t / 1000) - 3600 })
      ];
      // Token signed by a key the issuer never published.
      const { privateKey } = generateKeyPairSync('ed25519');
      bad.push(issuer.mint({ sub: 'user-a', aud: 'ext-client' }, { key: privateKey }));
      for (const token of bad) {
        assert.equal((await call('/v1/items', { token })).status, 401);
      }
      assert.equal((await call('/v1/me', { token: tokenFor('user-a') })).status, 200);
    });

    test('batch upsert, validation, ordering and filters', async () => {
      const token = tokenFor('user-a');
      const res = await call('/v1/items', { token, method: 'POST', body: { items: [post(1), post(2), post(3), { id: 'x', handle: 'bad' }, post(2, { score: 55 })] } });
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.saved, 3);
      assert.equal(out.rejected, 1);
      const list = await (await call('/v1/items', { token })).json();
      assert.deepEqual(list.items.map(i => i.handle), ['user3', 'user2', 'user1']);
      const two = list.items.find(i => i.handle === 'user2');
      assert.equal(two.score, 55, 'later duplicate in a batch wins');
      assert.equal(two.url, `https://x.com/user2/status/${post(2).id}`);
      assert.equal(list.items.find(i => i.handle === 'user1').thumb, 'https://pbs.twimg.com/media/abc.jpg');
      assert.equal(list.items.find(i => i.handle === 'user3').thumb, null, 'non-X thumbnails dropped');
      const kept = await (await call('/v1/items?kept=true', { token })).json();
      assert.deepEqual(kept.items.map(i => i.handle), ['user2']);
      const min = await (await call('/v1/items?minScore=10', { token })).json();
      assert.deepEqual(min.items.map(i => i.handle), ['user3', 'user2']);
      assert.equal((await call('/v1/items?minScore=abc', { token })).status, 400);
    });

    test('cursor pagination walks every item once', async () => {
      const token = tokenFor('user-a');
      const seen = [];
      let cursor = null;
      do {
        const page = await (await call(`/v1/items?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { token })).json();
        seen.push(...page.items.map(i => i.handle));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, ['user3', 'user2', 'user1']);
    });

    test('users are isolated', async () => {
      const a = tokenFor('user-a');
      const b = tokenFor('user-b');
      assert.equal((await (await call('/v1/items', { token: b })).json()).items.length, 0);
      await call('/v1/items', { token: b, method: 'POST', body: { items: [post(9)] } });
      assert.deepEqual((await (await call('/v1/items', { token: b })).json()).items.map(i => i.handle), ['user9']);
      assert.equal((await call('/v1/items', { token: b, method: 'DELETE' })).status, 200);
      assert.equal((await (await call('/v1/items', { token: a })).json()).items.length, 3, "b's delete leaves a untouched");
    });

    test('keeps only the newest N per user and expires after the TTL', async () => {
      const token = tokenFor('user-b');
      for (let i = 10; i < 18; i++) {
        clock.t += 1000;
        await call('/v1/items', { token: tokenFor('user-b'), method: 'POST', body: { items: [post(i)] } });
      }
      const me = await (await call('/v1/me', { token })).json();
      assert.equal(me.count, 5);
      const handles = (await (await call('/v1/items', { token: tokenFor('user-b') })).json()).items.map(i => i.handle);
      assert.deepEqual(handles, ['user17', 'user16', 'user15', 'user14', 'user13']);
      // Re-saving an old post refreshes it rather than duplicating it.
      clock.t += 1000;
      await call('/v1/items', { token: tokenFor('user-b'), method: 'POST', body: { items: [post(13, { score: 99 })] } });
      assert.equal((await (await call('/v1/me', { token: tokenFor('user-b') })).json()).count, 5);

      clock.t += 31 * DAY;
      const later = tokenFor('user-b');
      assert.equal((await (await call('/v1/items', { token: later })).json()).items.length, 0);
      assert.equal((await (await call('/v1/me', { token: later })).json()).count, 0);
      assert.ok(await store.sweep(clock.t) >= 5);
      clock.t -= 31 * DAY;
    });

    test('delete-all removes everything for the caller', async () => {
      const token = tokenFor('user-a');
      await call('/v1/items', { token, method: 'POST', body: { items: [post(1), post(2), post(3)] } });
      const res = await call('/v1/items', { token, method: 'DELETE' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).deleted, 3);
      assert.equal((await (await call('/v1/items', { token })).json()).items.length, 0);
    });

    test('batches over 50 items are refused', async () => {
      const items = Array.from({ length: 51 }, (_, i) => post(100 + i));
      assert.equal((await call('/v1/items', { token: tokenFor('user-a'), method: 'POST', body: { items } })).status, 413);
    });

    test('CORS allows only the extension and the reader origin', async () => {
      for (const origin of [EXT, READER]) {
        const pre = await call('/v1/items', { method: 'OPTIONS', origin });
        assert.equal(pre.status, 204, origin);
        assert.equal(pre.headers.get('access-control-allow-origin'), origin);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
      }
      const res = await call('/v1/items', { token: tokenFor('user-a'), origin: EXT });
      assert.equal(res.headers.get('access-control-allow-origin'), EXT);
      for (const origin of ['https://evil.example', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
        const pre = await call('/v1/items', { method: 'OPTIONS', origin });
        assert.equal(pre.status, 403);
        assert.equal(pre.headers.get('access-control-allow-origin'), null);
        const get = await call('/v1/items', { token: tokenFor('user-a'), origin });
        assert.equal(get.status, 403);
        assert.equal(get.headers.get('access-control-allow-origin'), null);
      }
    });

    test('reader sign-in: code + PKCE, session cookie, CSRF guard, sign-out', async () => {
      const start = await call('/auth/login');
      assert.equal(start.status, 302);
      const authorize = new URL(start.headers.get('location'));
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorize.searchParams.get('client_id'), 'web-client');
      const flowCookie = start.headers.get('set-cookie').split(';')[0];
      assert.match(start.headers.get('set-cookie'), /HttpOnly/);

      const back = await fetch(authorize, { redirect: 'manual' });
      const callback = new URL(back.headers.get('location'));
      assert.equal(callback.origin, READER);

      // Wrong state is refused.
      const forged = await call(`/auth/callback?code=${callback.searchParams.get('code')}&state=forged`, { cookie: flowCookie });
      assert.equal(forged.headers.get('location'), '/?signin=failed');

      // Fresh flow, correct state.
      const start2 = await call('/auth/login');
      const flow2 = start2.headers.get('set-cookie').split(';')[0];
      const back2 = await fetch(new URL(start2.headers.get('location')), { redirect: 'manual' });
      const cb2 = new URL(back2.headers.get('location'));
      const done = await call(`/auth/callback${cb2.search}`, { cookie: flow2 });
      assert.equal(done.status, 302);
      assert.equal(done.headers.get('location'), '/');
      const session = done.headers.getSetCookie().find(c => c.startsWith('xfr_session=')).split(';')[0];

      const me = await call('/v1/me', { cookie: session });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).name, 'Test Reader');
      // Cookie-authenticated writes need the reader's own Origin.
      assert.equal((await call('/v1/items', { cookie: session, method: 'DELETE' })).status, 403);
      assert.equal((await call('/v1/items', { cookie: session, method: 'DELETE', origin: READER })).status, 200);
      // A tampered cookie is rejected.
      assert.equal((await call('/v1/me', { cookie: session.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) })).status, 401);
      const out = await call('/auth/logout', { method: 'POST', origin: READER, cookie: session });
      assert.match(out.headers.get('set-cookie'), /xfr_session=;.*Max-Age=0/);
    });

    test('pages are served with a strict CSP and no third-party scripts', async () => {
      const res = await call('/');
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      const html = await res.text();
      assert.doesNotMatch(html, /<script[^>]+src="https?:/);
      assert.equal((await call('/../package.json')).status, 404);
    });

    test('post text never appears in server logs', () => {
      assert.ok(logs.some(l => l.startsWith('POST /v1/items 200')));
      assert.equal(logs.some(l => /SECRET-TEXT|fixture post/.test(l)), false);
    });
  });
}
