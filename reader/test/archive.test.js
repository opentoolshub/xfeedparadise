import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createNoosStore } from '../src/store-noos.js';
import { createMemoryStore } from '../src/store-memory.js';
import { bookmarkItems, importBookmarks } from '../import-saves.mjs';

const fixture = { id: '123', handle: 'fixture', name: 'Fixture', text: 'original rendered text', postedAt: Date.UTC(2026, 10, 1), score: null, kept: null, sources: ['x-feed'], saved: false, policy: null, thumb: null };
test('archive preserves raw capture, decisions, saves, identity and restart-independent contract', async () => {
  const store = createMemoryStore({ archive: true });
  await store.upsert('a', [fixture, { ...fixture, score: -70, kept: false, policy: '{"threshold":0}' }]);
  await store.upsert('a', [{ ...fixture, saved: true, sources: ['x-bookmarks'] }]);
  await store.upsert('b', [fixture]);
  const { items } = await store.list('a', { saved: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].score, -70);
  assert.equal(items[0].saved, true);
  assert.deepEqual(items[0].sources, ['x-feed', 'x-bookmarks']);
  assert.equal(items[0].observations.length, 3);
  assert.equal(items[0].observations[0].score, null);
  assert.equal((await store.list('a', { kept: true })).items.length, 0);
  await store.deleteAll('a');
  assert.equal((await store.stats('b')).count, 1);
});
test('Noos calls bind the immutable subject, operation and exact body to a short assertion', async () => {
  const calls = [];
  const secret = 'synthetic-noos-shared-secret-00000000000';
  const store = createNoosStore({ baseUrl: 'https://noos.test/api/paradise-store', secret, issuer: 'https://id.test/api/auth', now: () => 1000000,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ saved: 1, total: 1 }) }; } });
  await store.upsert('immutable-subject', [fixture]);
  const { options, url } = calls[0];
  assert.equal(url, 'https://noos.test/api/paradise-store/upsert');
  assert.equal(options.redirect, 'error');
  const [header, body, signature] = options.headers.authorization.slice(7).split('.');
  assert.equal(signature, createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url'));
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  assert.equal(claims.sub, 'immutable-subject');
  assert.equal(claims.op, 'upsert');
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(options.body.includes(secret), false);
  assert.throws(() => createNoosStore({ baseUrl: 'http://untrusted.test', secret, issuer: 'https://id.test' }));
});
const snapshot = { source: 'x-saved', mode: 'snapshot', complete: false, rows: [{ source: 'x-saved', sourceId: '123', body: 'saved words', createdAt: '2026-11-01T00:00:00Z', xContent: { author: { handle: 'fixture', name: 'Fixture' } }, _raw: { secret: 'must be dropped' } }] };
test('bookmark import retains real saved provenance, drops raw credentials and reports partial coverage', async () => {
  const items = bookmarkItems(snapshot);
  assert.equal(items[0].saved, true);
  assert.equal(items[0].score, null);
  assert.equal(JSON.stringify(items).includes('must be dropped'), false);
  const result = await importBookmarks({ snapshot, readerUrl: 'https://reader.test/', token: 'fixture-token', fetchImpl: async () => ({ ok: true, json: async () => ({ rejected: 0 }) }) });
  assert.equal(result.sourceComplete, false);
  assert.equal(result.imported, 1);
  const partial = await importBookmarks({ snapshot, readerUrl: 'https://reader.test/', token: 'fixture-token', fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(partial.remaining, 1);
  assert.throws(() => bookmarkItems({ ...snapshot, source: 'x-for-you' }));
});
