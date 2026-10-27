'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp, clientIp } = require('../src/app');
const { toVibe, LEVELS } = require('../src/rubric');
const { BACKENDS, decisionsRequest } = require('../src/backends');

const INSTALL = '3f1c2b9e-0000-4000-8000-000000000001';
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SECRET_TEXT = 'my very private post about the zebra conspiracy';

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const decisionsReply = (scores, inputTokens = 100) => json(200, {
  model: 'gpt-6-luna',
  answers: scores.map((score, i) => ({ type: 'score', name: scores.length > 1 ? `post_${i + 1}` : null, score, probabilities: [], confidence: 0.9 })),
  usage: { input_tokens: inputTokens, output_tokens: 0 }
});

// Routes mocked backend calls by URL; records every call.
function mockFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const key = url.includes('/decisions') ? 'decisions' : url.includes('typesafe') ? 'jev' : 'nano';
    const handler = handlers[key];
    if (!handler) throw new Error('unexpected fetch');
    return handler(call, calls.filter(c => c.url === url).length);
  };
  return { calls, fetchImpl };
}

async function start(options = {}) {
  const logs = [];
  let clock = options.now || Date.UTC(2026, 9, 26, 12, 0, 0);
  const app = createApp({
    env: { OPENAI_API_KEY: 'sk-test', XFEED_TRUST_PROXY: '0', ...(options.env || {}) },
    fetch: options.fetch || (async () => { throw new Error('unexpected fetch'); }),
    now: () => clock,
    logger: entry => logs.push(entry)
  });
  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, origin = EXT, headers = {} } = {}) {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  const scoreReq = (texts, installId = INSTALL, extra = {}) => request('/v1/score', { method: 'POST', body: { installId, texts }, ...extra });
  return {
    app, logs, request, scoreReq,
    advance: ms => { clock += ms; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

// ------------------------------------------------------------------ rubric

test('rubric has 7 levels and maps level index to -100..100', () => {
  assert.equal(LEVELS.length, 7);
  assert.equal(toVibe({ score: 0 }), -100);
  assert.equal(toVibe({ score: 3 }), 0);
  assert.equal(toVibe({ score: 6 }), 100);
  assert.equal(toVibe({ score: 4.5 }), 50);
  assert.equal(toVibe({ score: 9 }), 100); // clamped
  assert.equal(toVibe({ probabilities: [{ value: 0, probability: 0.5 }, { value: 6, probability: 0.5 }] }), 0);
  assert.equal(toVibe({ probabilities: { 6: 1 } }), 100);
  assert.equal(toVibe({}), null);
  assert.equal(toVibe(null), null);
});

// ------------------------------------------------------------------ CORS + routes

test('CORS allows only extension origins', async t => {
  const s = await start();
  t.after(s.close);
  const ok = await s.request('/api/ok');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), EXT);
  const safari = await s.request('/api/ok', { origin: 'safari-web-extension://ABCD-1234' });
  assert.equal(safari.headers.get('access-control-allow-origin'), 'safari-web-extension://ABCD-1234');
  const web = await s.request('/api/ok', { origin: 'https://evil.example' });
  assert.equal(web.status, 403);
  assert.equal(web.headers.get('access-control-allow-origin'), null);
  const pre = await s.request('/v1/score', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  const noOrigin = await s.request('/api/ok', { origin: null });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal((await s.request('/healthz')).status, 404);
});

test('bad requests are rejected without calling a backend', async t => {
  const s = await start();
  t.after(s.close);
  for (const body of [
    { texts: ['x'] },
    { installId: 'short', texts: ['x'] },
    { installId: INSTALL, texts: [] },
    { installId: INSTALL, texts: new Array(11).fill('x') },
    { installId: INSTALL, texts: [42] },
    'not json'
  ]) {
    const r = await s.request('/v1/score', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.body, { error: 'bad_request' });
  }
  const big = await s.request('/v1/score', { method: 'POST', body: { installId: INSTALL, texts: ['x'.repeat(20000)] } });
  assert.deepEqual(big.body, { error: 'bad_request' });
  assert.equal((await s.request('/v1/status?installId=bad')).status, 400);
});

// ------------------------------------------------------------------ backends

test('Decisions scores a whole batch in one call with named questions', async t => {
  const { calls, fetchImpl } = mockFetch({ decisions: () => decisionsReply([0, 6, 3]) });
  const s = await start({ fetch: fetchImpl });
  t.after(s.close);
  const long = 'y'.repeat(1000);
  const r = await s.scoreReq(['angry', 'kind', long]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.scores, [-100, 100, 0]);
  assert.equal(r.body.backend, 'decisions');
  assert.equal(r.body.remaining, 997);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/decisions');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'gpt-6-luna');
  assert.equal(call.body.questions.length, 3);
  assert.deepEqual(call.body.questions.map(q => q.name), ['post_1', 'post_2', 'post_3']);
  assert.equal(call.body.questions[0].type, 'score');
  assert.equal(call.body.questions[0].levels.length, 7);
  assert.match(call.body.input, /^Post 1:\nangry\n\nPost 2:\nkind\n\nPost 3:\n/);
  assert.ok(call.body.input.includes('y'.repeat(400)) && !call.body.input.includes('y'.repeat(401)), 'truncated to 400 chars');
});

test('Decisions single post uses one unnamed question; answers are matched by name', async () => {
  const single = decisionsRequest(['hello'], 'gpt-6-luna');
  assert.equal(single.input, 'hello');
  assert.equal(single.questions.length, 1);
  assert.equal(single.questions[0].name, undefined);
  const reply = { answers: [{ name: 'post_2', score: 6 }, { name: 'post_1', score: 0 }], usage: { input_tokens: 10 } };
  const result = await BACKENDS.decisions.score(['a', 'b'], { fetch: async () => json(200, reply), apiKey: 'k' });
  assert.deepEqual(result.scores, [-100, 100]);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 0 });
  await assert.rejects(BACKENDS.decisions.score(['a', 'b'], { fetch: async () => json(200, { answers: [{ score: 1 }] }), apiKey: 'k' }),
    e => e.code === 'invalid_response');
});

test('TypeSafe Jev scores each post with capped concurrency', async () => {
  let active = 0;
  let peak = 0;
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return json(200, { answers: { vibe: { score: 6, probabilities: { 6: 1 } } }, usage: { input_tokens: 50 } });
  };
  const result = await BACKENDS.jev.score(new Array(8).fill('post'), { fetch: fetchImpl, apiKey: 'ts-key' });
  assert.deepEqual(result.scores, new Array(8).fill(100));
  assert.equal(result.usage.inputTokens, 400);
  assert.ok(peak <= 5, `peak ${peak}`);
  assert.equal(bodies[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(bodies[0].auth, 'Bearer ts-key');
  assert.equal(bodies[0].body.model, 'jev-latest');
  assert.equal(bodies[0].body.state, 'post');
  assert.equal(bodies[0].body.questions.vibe.type, 'score');
  assert.equal(bodies[0].body.questions.vibe.criteria.length, 7);
});

test('gpt-5.4-nano uses the batch prompt and parses a JSON array', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return json(200, { choices: [{ message: { content: '[40, -60]' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
  };
  const result = await BACKENDS.nano.score(['a', 'b'], { fetch: fetchImpl, apiKey: 'k' });
  assert.deepEqual(result.scores, [40, -60]);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.body.model, 'gpt-5.4-nano');
  assert.match(seen.body.messages[0].content, /JSON array/);
  await assert.rejects(BACKENDS.nano.score(['a', 'b'], { fetch: async () => json(200, { choices: [{ message: { content: 'nope' } }] }), apiKey: 'k' }),
    e => e.code === 'invalid_response');
});

test('backends run in the configured order, skipping ones without a key', async t => {
  // Default order jev,decisions,nano; no TypeSafe key so Jev is skipped.
  const a = await start({ fetch: mockFetch({ decisions: () => decisionsReply([3]) }).fetchImpl });
  t.after(a.close);
  assert.deepEqual(a.app.config.backends.map(b => b.backend.id), ['decisions', 'nano']);
  const withJev = await start({ env: { TYPESAFE_API_KEY: 'ts' } });
  t.after(withJev.close);
  assert.deepEqual(withJev.app.config.backends.map(b => b.backend.id), ['jev', 'decisions', 'nano']);
  const custom = await start({ env: { XFEED_BACKENDS: 'nano, decisions, bogus' } });
  t.after(custom.close);
  assert.deepEqual(custom.app.config.backends.map(b => b.backend.id), ['nano', 'decisions']);
});

test('a failing backend fails over to the next one', async t => {
  const { calls, fetchImpl } = mockFetch({
    jev: () => json(500, { error: 'boom' }),
    decisions: () => json(429, { error: 'slow down' }),
    nano: () => json(200, { choices: [{ message: { content: '[12]' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } })
  });
  const s = await start({ fetch: fetchImpl, env: { TYPESAFE_API_KEY: 'ts' } });
  t.after(s.close);
  const r = await s.scoreReq(['hello']);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.scores, [12]);
  assert.equal(r.body.backend, 'nano');
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v1/systemone', '/v1/decisions', '/v1/chat/completions']);
  const log = s.logs.find(l => l.route === '/v1/score');
  assert.deepEqual(log.failures.map(f => [f.backend, f.httpStatus]), [['jev', 500], ['decisions', 429]]);
});

test('when every backend fails the posts are refunded and backend_error returned', async t => {
  const { fetchImpl } = mockFetch({ decisions: () => json(500, {}), nano: async () => { throw new TypeError('fetch failed'); } });
  const s = await start({ fetch: fetchImpl });
  t.after(s.close);
  const r = await s.scoreReq(['a', 'b']);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'backend_error' });
  const st = await s.request(`/v1/status?installId=${INSTALL}`);
  assert.equal(st.body.remaining, 1000);
});

// ------------------------------------------------------------------ caps

test('per-install daily cap: partial batch, then daily_limit, reset at UTC midnight', async t => {
  const { calls, fetchImpl } = mockFetch({ decisions: call => decisionsReply(call.body.questions.map(() => 3)) });
  const s = await start({ fetch: fetchImpl, env: { XFEED_INSTALL_DAILY_POSTS: '5' } });
  t.after(s.close);
  assert.equal((await s.scoreReq(['a', 'b', 'c'])).body.remaining, 2);
  const partial = await s.scoreReq(['d', 'e', 'f']);
  assert.deepEqual(partial.body.scores, [0, 0, null]);
  assert.equal(partial.body.remaining, 0);
  const blocked = await s.scoreReq(['g']);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'daily_limit');
  assert.equal(blocked.body.resetsAt, '2026-10-27T00:00:00.000Z');
  assert.equal(calls.length, 2);
  const st = await s.request(`/v1/status?installId=${INSTALL}`);
  assert.deepEqual(st.body, { remaining: 0, limit: 5, state: 'daily_limit', resetsAt: '2026-10-27T00:00:00.000Z' });
  s.advance(12 * 3600 * 1000); // next UTC day
  assert.equal((await s.scoreReq(['h'])).status, 200);
  assert.equal((await s.request(`/v1/status?installId=${INSTALL}`)).body.remaining, 4);
});

test('per-IP daily cap applies across installs', async t => {
  const { fetchImpl } = mockFetch({ decisions: call => decisionsReply(call.body.questions.map(() => 3)) });
  const s = await start({ fetch: fetchImpl, env: { XFEED_IP_DAILY_POSTS: '4' } });
  t.after(s.close);
  assert.equal((await s.scoreReq(['a', 'b', 'c'], 'install-aaaaaaaa')).status, 200);
  const second = await s.scoreReq(['d', 'e'], 'install-bbbbbbbb');
  assert.deepEqual(second.body.scores, [0, null]);
  assert.equal((await s.scoreReq(['f'], 'install-cccccccc')).body.error, 'daily_limit');
});

test('global spend budget stops scoring for everyone', async t => {
  // 1,000,000 input tokens at $0.10/M = $0.10 per call; budget $0.15.
  const { calls, fetchImpl } = mockFetch({ decisions: () => decisionsReply([3], 1000000) });
  const s = await start({ fetch: fetchImpl, env: { XFEED_GLOBAL_DAILY_USD: '0.15' } });
  t.after(s.close);
  assert.equal((await s.scoreReq(['a'])).status, 200);
  assert.equal((await s.scoreReq(['b'], 'install-other-1')).status, 200);
  const blocked = await s.scoreReq(['c'], 'install-other-2');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'global_budget');
  assert.equal(calls.length, 2);
  const st = await s.request('/v1/status?installId=install-other-3');
  assert.equal(st.body.state, 'global_budget');
  assert.equal(st.body.remaining, 0);
  assert.ok(Math.abs(s.app.limits.spentUsd - 0.2) < 1e-9);
});

test('per-install request rate limit', async t => {
  const { fetchImpl } = mockFetch({ decisions: () => decisionsReply([3]) });
  const s = await start({ fetch: fetchImpl, env: { XFEED_INSTALL_REQUESTS_PER_MINUTE: '2' } });
  t.after(s.close);
  assert.equal((await s.scoreReq(['a'])).status, 200);
  assert.equal((await s.scoreReq(['b'])).status, 200);
  const limited = await s.scoreReq(['c']);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);
  assert.equal((await s.scoreReq(['d'], 'install-different')).status, 200);
  s.advance(60000);
  assert.equal((await s.scoreReq(['e'])).status, 200);
});

test('client IP uses the rightmost X-Forwarded-For entry only when trusted', () => {
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req, true), '1.2.3.4');
  assert.equal(clientIp(req, false), '10.0.0.1');
});

// ------------------------------------------------------------------ privacy

test('post text never appears in logs, even when a backend echoes it in an error', async t => {
  const { fetchImpl } = mockFetch({
    decisions: call => json(400, { error: { message: `bad input: ${call.body.input}` } }),
    nano: () => json(200, { choices: [{ message: { content: '[5]' } }], usage: { prompt_tokens: 80, completion_tokens: 4 } })
  });
  const s = await start({ fetch: fetchImpl });
  await s.scoreReq([SECRET_TEXT]);
  await s.scoreReq([SECRET_TEXT, 'x'], 'bad id!');
  t.after(s.close);
  const all = JSON.stringify(s.logs);
  assert.ok(s.logs.length >= 2);
  assert.ok(!all.includes('zebra'), 'post text leaked into logs');
  assert.ok(!all.includes(INSTALL), 'install id should not be logged');
  const entry = s.logs.find(l => l.backend === 'nano');
  assert.equal(entry.posts, 1);
  assert.equal(typeof entry.latencyMs, 'number');
  assert.equal(entry.failures[0].httpStatus, 400);
});

test('the server has a single logging path (the request logger)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['src/app.js', 'src/backends.js', 'src/limits.js', 'src/rubric.js', 'index.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)/, file);
  }
});
