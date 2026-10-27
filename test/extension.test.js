const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Minimal promise-style chrome.storage area backed by a plain object.
function storageArea(initial = {}) {
  const data = { ...initial };
  const pick = keys => {
    if (keys === null || keys === undefined) return { ...data };
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const key of list) if (key in data) out[key] = data[key];
    return out;
  };
  return {
    data,
    get(keys, callback) {
      const result = pick(keys);
      if (callback) callback(result);
      return Promise.resolve(result);
    },
    set(values, callback) {
      Object.assign(data, values);
      if (callback) callback();
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of [].concat(keys)) delete data[key];
      if (callback) callback();
      return Promise.resolve();
    }
  };
}

function makeContext({ fetchImpl, sync = {}, local = {}, permissions = true, extra = {} } = {}) {
  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    chrome: {
      storage: { sync: storageArea(sync), local: storageArea(local), onChanged: { addListener() {} } },
      permissions: { contains: async () => permissions }
    },
    ...extra
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('providers.js'), context);
  return context;
}

function jsonResponse(status, json, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json ?? {})),
    json: async () => json
  };
}

const chat = content => ({ choices: [{ message: { content } }] });

// Records each fetch call and replies using the supplied handler.
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, fetchImpl };
}

const status = (ctx, id) => ctx.chrome.storage.local.data[`xfpStatus_${id}`];

// ------------------------------------------------------------------ release hygiene

test('release runtime has no community upload endpoint or queue', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.host_permissions.some(host => host.includes('supabase')), false);
  for (const file of ['db.js', 'content.js', 'content-googlenews.js', 'popup.js', 'popup.html', 'providers.js', 'background.js']) {
    assert.doesNotMatch(read(file), /queueForSync|SUPABASE_URL|xfp_sync_enabled|syncEnabled/);
  }
  assert.doesNotMatch(read('db.js'), /\bfetch\s*\(/);
});

test('manifest keeps Groq required and other providers optional', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.host_permissions.includes('https://api.groq.com/*'));
  for (const origin of ['https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://api.typesafe.ai/*',
    'https://generativelanguage.googleapis.com/*', 'https://openrouter.ai/*', 'https://api.together.xyz/*',
    'https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']) {
    assert.ok(manifest.optional_host_permissions.includes(origin), origin);
    assert.equal(manifest.host_permissions.includes(origin), false, origin);
  }
  for (const script of manifest.content_scripts) {
    assert.ok(script.js.indexOf('providers.js') < script.js.indexOf('filter.js'));
  }
  // Content scripts never call provider APIs directly; only the worker does.
  for (const file of ['filter.js', 'content.js', 'content-googlenews.js']) {
    assert.doesNotMatch(read(file), /\bfetch\s*\(/, file);
  }
});

// ------------------------------------------------------------------ migration + config

test('existing Groq users keep working with no action', async () => {
  const ctx = makeContext({ sync: { groqApiKey: 'gsk_existing' } });
  const config = await ctx.XFPProviders.loadConfig();
  assert.equal(config.primary, 'groq');
  assert.equal(config.fallback, null);
  assert.equal(config.providers.groq.apiKey, 'gsk_existing');
  assert.equal(config.providers.groq.model, 'openai/gpt-oss-20b');
  const chain = ctx.XFPProviders.chain(config);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].id, 'groq');
});

test('legacy Together key and a non-gsk Groq key are handled', async () => {
  const ctx = makeContext({ sync: { groqApiKey: 'not-a-groq-key', togetherApiKey: 'tg', aiProvider: 'groq', fallbackProvider: 'together' } });
  const config = await ctx.XFPProviders.loadConfig();
  assert.equal(ctx.XFPProviders.configProblem(config.providers.groq), 'key_format');
  assert.deepEqual([...ctx.XFPProviders.chain(config).map(e => e.id)], ['together']);
});

test('saving a provider stores its key and only model overrides', async () => {
  const ctx = makeContext({ local: { xfpStatus_openai: { state: 'auth_error', checkedAt: Date.now() } } });
  const P = ctx.XFPProviders;
  await P.saveProvider('openai', { apiKey: ' sk-new ', model: P.PROVIDERS.openai.defaultModel });
  await P.saveSelection({ primary: 'openai', fallback: 'groq' });
  const sync = ctx.chrome.storage.sync.data;
  assert.equal(sync.openaiApiKey, 'sk-new');
  assert.equal(sync.aiProvider, 'openai');
  assert.equal(sync.fallbackProvider, 'groq');
  assert.equal(sync.providerOptions.openai.model, undefined);
  assert.equal(status(ctx, 'openai'), undefined);
  await P.saveProvider('openai', { model: 'gpt-5-nano' });
  assert.equal((await P.loadConfig()).providers.openai.model, 'gpt-5-nano');
});

// ------------------------------------------------------------------ adapters

test('Groq uses OpenAI-compatible chat completions and records a working connection', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, chat('[42]')));
  const ctx = makeContext({ fetchImpl, sync: { groqApiKey: 'gsk_test' } });
  const result = await ctx.XFPProviders.scoreBatch(['A nice day']);
  assert.deepEqual([...result.scores], [42]);
  assert.equal(result.provider, 'groq');
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer gsk_test');
  assert.equal(calls[0].body.model, 'openai/gpt-oss-20b');
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.equal(calls[0].body.max_completion_tokens, 256);
  assert.match(calls[0].body.messages[0].content, /JSON array/);
  assert.equal(status(ctx, 'groq').state, 'working');
});

test('OpenAI and Gemini requests use their endpoints and parameter styles', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, chat('Scores: [10, -20]')));
  const ctx = makeContext({ fetchImpl, sync: { openaiApiKey: 'sk-o', geminiApiKey: 'AIza-g' } });
  const P = ctx.XFPProviders;
  const config = await P.loadConfig();
  const openai = await P.callProvider(config.providers.openai, ['a', 'b']);
  const gemini = await P.callProvider(config.providers.gemini, ['a', 'b']);
  assert.deepEqual([...openai.scores], [10, -20]);
  assert.deepEqual([...gemini.scores], [10, -20]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-5.4-nano');
  assert.equal('temperature' in calls[0].body, false);
  assert.equal(calls[0].body.max_completion_tokens, 1024);
  assert.equal(calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[1].headers.Authorization, 'Bearer AIza-g');
  assert.equal(calls[1].body.model, 'gemini-3.8-flash');
});

test('Anthropic uses the native Messages API with browser-access headers', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, {
    content: [{ type: 'text', text: '[55, -70]' }]
  }));
  const ctx = makeContext({ fetchImpl, sync: { aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-x' } });
  const result = await ctx.XFPProviders.scoreBatch(['kind words', 'angry words']);
  assert.deepEqual([...result.scores], [55, -70]);
  const call = calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-x');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.body.max_tokens, 256);
  assert.equal(call.body.messages[0].role, 'user');
});

test('TypeSafe Jev scores each post on a rubric with capped concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    const uplifting = body.state.startsWith('good');
    return jsonResponse(200, {
      model: 'jev-1.13.0',
      answers: {
        vibe: {
          type: 'score',
          score: uplifting ? 4 : 0.5,
          confidence: 0.6,
          probabilities: uplifting ? { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } : { 0: 0.5, 1: 0.5, 2: 0, 3: 0, 4: 0 }
        }
      }
    });
  };
  const ctx = makeContext({ fetchImpl, sync: { aiProvider: 'jev', jevApiKey: 'ts-key' } });
  const texts = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'bad post' : 'good post'));
  const result = await ctx.XFPProviders.scoreBatch(texts);
  assert.equal(calls.length, 12);
  assert.ok(maxInFlight <= 5, `max in flight ${maxInFlight}`);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].headers.Authorization, 'Bearer ts-key');
  assert.equal(calls[0].body.model, 'jev-latest');
  const q = calls[0].body.questions.vibe;
  assert.equal(q.type, 'score');
  assert.ok(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10);
  assert.match(q.criteria[0], /Outrage/);
  assert.match(q.criteria[q.criteria.length - 1], /Uplifting/);
  // good: level 4 of 0..4 -> +100; bad: expected level 0.5 -> -75
  assert.equal(result.scores[0], 100);
  assert.equal(result.scores[1], -75);
});

test('Jev expected value uses probabilities and falls back to score', () => {
  const ctx = makeContext();
  const P = ctx.XFPProviders;
  assert.equal(P.jevToVibe({ probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 } }), 0);
  assert.equal(P.jevToVibe({ probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.5, 4: 0.5 } }), 75);
  assert.equal(P.jevToVibe({ score: 1 }), -50);
  assert.equal(P.jevToVibe({}), null);
});

test('Custom endpoint works without a key and builds the chat URL', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(200, chat('[7]')));
  const ctx = makeContext({
    fetchImpl,
    sync: { aiProvider: 'custom', providerOptions: { custom: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2' } } }
  });
  const P = ctx.XFPProviders;
  const config = await P.loadConfig();
  assert.equal(P.isConfigured(config.providers.custom), true);
  const result = await P.scoreBatch(['hello']);
  assert.deepEqual([...result.scores], [7]);
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.model, 'llama3.2');
  assert.equal(P.permissionOrigin('custom', 'http://localhost:11434/v1'), 'http://localhost/*');
  assert.equal(P.permissionOrigin('custom', 'https://llm.example.com/v1'), 'https://llm.example.com/*');
  assert.equal(P.permissionOrigin('custom', 'http://192.168.1.5:11434/v1'), null);
});

test('a 400 naming an unsupported parameter is retried once without it', async () => {
  const { calls, fetchImpl } = recorder((call, n) => (n === 1
    ? jsonResponse(400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } })
    : jsonResponse(200, chat('[12]'))));
  const ctx = makeContext({ fetchImpl, sync: { aiProvider: 'openai', openaiApiKey: 'sk-o', providerOptions: { openai: { model: 'gpt-4o-mini' } } } });
  const result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.deepEqual([...result.scores], [12]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.equal('reasoning_effort' in calls[1].body, false);
  assert.equal(calls[1].body.max_completion_tokens, 1024);
});

test('unsupported-param retry happens only once and renames token limits', async () => {
  const P = makeContext().XFPProviders;
  const body = { max_tokens: 100, temperature: 0 };
  const changed = P.stripUnsupportedParams(body,
    "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  assert.deepEqual([...changed], ['max_tokens']);
  assert.deepEqual({ ...body }, { temperature: 0, max_completion_tokens: 100 });

  const { calls, fetchImpl } = recorder(() => jsonResponse(400, { error: { message: 'temperature is not supported' } }));
  const ctx = makeContext({ fetchImpl, sync: { groqApiKey: 'gsk_x' } });
  const result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(result.scores, null);
  assert.equal(calls.length, 2);
  assert.equal(status(ctx, 'groq').state, 'api_error');
});

// ------------------------------------------------------------------ failover + status

test('primary rate limit fails over to the fallback provider', async () => {
  const { calls, fetchImpl } = recorder(call => (call.url.includes('groq')
    ? jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '2' })
    : jsonResponse(200, chat('[33]'))));
  const ctx = makeContext({ fetchImpl, sync: { groqApiKey: 'gsk_x', openaiApiKey: 'sk-o', fallbackProvider: 'openai' } });
  const P = ctx.XFPProviders;
  const result = await P.scoreBatch(['x']);
  assert.deepEqual([...result.scores], [33]);
  assert.equal(result.provider, 'openai');
  assert.equal(result.attempts[0].state, 'rate_limited');
  assert.equal(result.attempts[0].waitSeconds, 2);
  assert.equal(result.attempts[1].state, 'working');
  assert.equal(status(ctx, 'groq').state, 'rate_limited');
  assert.equal(status(ctx, 'openai').state, 'working');

  // While cooling down, the primary is skipped without another request.
  const second = await P.scoreBatch(['y']);
  assert.equal(second.provider, 'openai');
  assert.equal(second.attempts[0].fresh, false);
  assert.equal(calls.filter(c => c.url.includes('groq')).length, 1);
});

test('fallback also failing returns no scores so callers use keywords', async () => {
  const { fetchImpl } = recorder(call => (call.url.includes('anthropic')
    ? jsonResponse(500, 'oops')
    : jsonResponse(200, chat('not a number list at all'))));
  const ctx = makeContext({ fetchImpl, sync: { aiProvider: 'anthropic', anthropicApiKey: 'sk-ant', fallbackProvider: 'openrouter', openrouterApiKey: 'sk-or' } });
  const result = await ctx.XFPProviders.scoreBatch(['a', 'b']);
  assert.equal(result.scores, null);
  assert.deepEqual([...result.attempts.map(a => a.state)], ['api_error', 'invalid_response']);
  assert.ok(result.retryAfterMs > 0);
});

test('rejected key, network failure and missing permission record visible states', async () => {
  let ctx = makeContext({ fetchImpl: async () => jsonResponse(401, { error: 'bad key' }), sync: { groqApiKey: 'gsk_bad' } });
  let result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(result.scores, null);
  assert.equal(status(ctx, 'groq').state, 'auth_error');
  assert.equal(status(ctx, 'groq').httpStatus, 401);

  ctx = makeContext({ fetchImpl: async () => { throw new Error('offline'); }, sync: { groqApiKey: 'gsk_x' } });
  await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(status(ctx, 'groq').state, 'network_error');

  let fetched = false;
  ctx = makeContext({ fetchImpl: async () => { fetched = true; }, permissions: false, sync: { aiProvider: 'openai', openaiApiKey: 'sk-o' } });
  result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(fetched, false);
  assert.equal(result.attempts[0].state, 'permission_needed');
  assert.equal(status(ctx, 'openai').state, 'permission_needed');
});

test('status labels name the provider and never include key material', () => {
  const P = makeContext().XFPProviders;
  const secret = 'sk-ant-SECRET-123';
  for (const state of ['working', 'available', 'auth_error', 'rate_limited', 'model_error', 'network_error',
    'invalid_response', 'permission_needed', 'api_error', undefined]) {
    const { label } = P.describeStatus({ id: 'anthropic', apiKey: secret, model: 'claude-haiku-5-5', baseUrl: '' },
      state ? { state, httpStatus: 500 } : null);
    assert.doesNotMatch(label, /SECRET/);
    assert.match(label, /Anthropic/);
  }
});

// ------------------------------------------------------------------ content-script side

function loadFilter(sendMessage) {
  const ctx = makeContext({ sync: { groqApiKey: 'gsk_x', openaiApiKey: 'sk-o', fallbackProvider: 'openai' } });
  ctx.chrome.runtime = { sendMessage };
  vm.runInContext(read('filter.js'), ctx);
  return ctx.window.VibeFilter;
}

test('content script blends fallback scores and names the fallback in warnings', async () => {
  const filter = loadFilter(async message => {
    assert.equal(message.type, 'XFP_SCORE_BATCH');
    return {
      scores: message.texts.map(() => 80), provider: 'openai', providerName: 'OpenAI',
      attempts: [
        { provider: 'groq', name: 'Groq', state: 'rate_limited', waitSeconds: 9, fresh: true },
        { provider: 'openai', name: 'OpenAI', state: 'working', fresh: true }
      ]
    };
  });
  await filter.loadProviderConfig();
  assert.equal(filter.provider.configured, true);
  assert.equal(filter.provider.fallbackName, 'OpenAI');
  const notices = [];
  filter.onRateLimit = (...args) => notices.push(args);
  const results = [];
  filter.batchQueue.push({ tweetId: '1', text: 'hello there', callback: (score, source) => results.push([score, source]) });
  await filter.processBatchQueue();
  assert.equal(results[0][1], 'ai');
  assert.equal(results[0][0], Math.round(80 * 0.85 + filter.calculateKeywordScore('hello there') * 0.15));
  assert.deepEqual(notices[0], ['Groq', 9, 'OpenAI']);
});

test('content script falls back to keywords and pauses when no provider works', async () => {
  const filter = loadFilter(async () => ({ scores: null, attempts: [], retryAfterMs: 20000 }));
  await filter.loadProviderConfig();
  const results = [];
  filter.batchQueue.push({ tweetId: '1', text: 'I am grateful', callback: (score, source) => results.push(source) });
  await filter.processBatchQueue();
  assert.deepEqual(results, ['keyword']);
  assert.equal(filter.hasAI(), false);
});

// ------------------------------------------------------------------ popup status

function popupContext({ sync, local = {} }) {
  const indicator = { className: '' };
  const text = { textContent: '' };
  const keyStatus = { textContent: '', className: '' };
  const fallbackStatus = { textContent: '', className: '' };
  const warning = {
    textContent: '',
    visible: false,
    classList: { toggle(_name, value) { warning.visible = value; } }
  };
  const elements = {
    aiStatus: { querySelector: selector => (selector === '.ai-indicator' ? indicator : text) },
    apiKeyStatus: keyStatus,
    fallbackStatus,
    connectionWarning: warning
  };
  const ctx = makeContext({
    sync: { vibeFilterSettings: { useAI: true }, ...sync },
    local,
    extra: { document: { addEventListener() {}, getElementById: id => elements[id] }, Date, Promise }
  });
  vm.runInContext(read('popup.js'), ctx);
  return { ctx, indicator, text, keyStatus, fallbackStatus, warning };
}

test('popup shows a warning for the last failed scoring request', async () => {
  const ui = popupContext({
    sync: { groqApiKey: 'gsk_test' },
    local: { xfpStatus_groq: { state: 'auth_error', httpStatus: 401, checkedAt: Date.now() } }
  });
  await ui.ctx.updateAIStatus();
  assert.equal(ui.indicator.className, 'ai-indicator error');
  assert.match(ui.text.textContent, /Groq rejected this key/);
  assert.equal(ui.warning.visible, true);
  assert.match(ui.warning.textContent, /keyword filtering remains available/);
});

test('a saved key alone is not reported as a working connection', async () => {
  const ui = popupContext({ sync: { groqApiKey: 'gsk_test' } });
  await ui.ctx.updateAIStatus();
  assert.equal(ui.indicator.className, 'ai-indicator loading');
  assert.match(ui.text.textContent, /not yet verified/);
  assert.equal(ui.warning.visible, false);
});

test('popup names the active provider and the fallback that takes over', async () => {
  const ui = popupContext({
    sync: { aiProvider: 'jev', jevApiKey: 'ts', fallbackProvider: 'openai', openaiApiKey: 'sk-o' },
    local: {
      xfpStatus_jev: { state: 'rate_limited', httpStatus: 429, checkedAt: Date.now() },
      xfpStatus_openai: { state: 'working', checkedAt: Date.now() }
    }
  });
  await ui.ctx.updateAIStatus();
  assert.match(ui.keyStatus.textContent, /TypeSafe Jev rate limit/);
  assert.match(ui.warning.textContent, /Falling back to OpenAI/);
  assert.match(ui.fallbackStatus.textContent, /OpenAI AI scoring is working/);
});

test('popup asks for a key for a newly selected provider', async () => {
  const ui = popupContext({ sync: { aiProvider: 'anthropic' } });
  await ui.ctx.updateAIStatus();
  assert.equal(ui.indicator.className, 'ai-indicator disabled');
  assert.match(ui.text.textContent, /Anthropic key/);
});

// ------------------------------------------------------------------ built-in provider (v1.4.0)

const BUILTIN_URL = 'https://xfeed-score-874749606899.us-central1.run.app';

test('built-in provider is the default for fresh installs and needs a required host permission', async () => {
  const ctx = makeContext();
  const P = ctx.XFPProviders;
  assert.equal(P.XFEED_SCORE_URL, BUILTIN_URL);
  assert.equal(P.ORDER[0], 'builtin');
  assert.equal(P.PROVIDERS.builtin.name, 'Built-in (free, daily limit)');
  const config = await P.loadConfig();
  assert.equal(config.primary, 'builtin');
  assert.equal(P.configProblem(config.providers.builtin), null);
  assert.deepEqual([...P.chain(config).map(e => e.id)], ['builtin']);
  assert.ok(!P.SYNC_KEYS.includes('builtinApiKey'));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.4.0');
  assert.ok(manifest.host_permissions.includes(`${BUILTIN_URL}/*`));
  assert.equal(P.PROVIDERS.builtin.origin, `${BUILTIN_URL}/*`);
  assert.ok(read('popup.html').includes(`XFeed Paradise v${manifest.version}<`), 'popup footer version matches manifest');
});

test('upgrade moves installs without a key to built-in once; users with a key keep theirs', async () => {
  // v1.3.3 user who picked Groq but never added a key.
  let ctx = makeContext({ sync: { aiProvider: 'groq' } });
  assert.equal(await ctx.XFPProviders.applyBuiltinDefault(), true);
  assert.equal(ctx.chrome.storage.sync.data.aiProvider, 'builtin');
  // The migration runs once: a later explicit choice sticks.
  await ctx.XFPProviders.saveSelection({ primary: 'groq' });
  assert.equal(await ctx.XFPProviders.applyBuiltinDefault(), false);
  assert.equal((await ctx.XFPProviders.loadConfig()).primary, 'groq');

  ctx = makeContext({ sync: { aiProvider: 'openai', openaiApiKey: 'sk-o', fallbackProvider: 'groq' } });
  assert.equal(await ctx.XFPProviders.applyBuiltinDefault(), false);
  assert.equal(ctx.chrome.storage.sync.data.aiProvider, 'openai');

  // Legacy Groq key with no saved provider keeps Groq.
  ctx = makeContext({ sync: { groqApiKey: 'gsk_old' } });
  assert.equal(await ctx.XFPProviders.applyBuiltinDefault(), false);
  assert.equal((await ctx.XFPProviders.loadConfig()).primary, 'groq');

  // Built-in can be the fallback for someone with their own key.
  ctx = makeContext({ sync: { aiProvider: 'groq', groqApiKey: 'gsk_x', fallbackProvider: 'builtin' } });
  const config = await ctx.XFPProviders.loadConfig();
  assert.deepEqual([...ctx.XFPProviders.chain(config).map(e => e.id)], ['groq', 'builtin']);
});

test('built-in adapter sends a stable install ID and truncated posts, no key', async () => {
  const { calls, fetchImpl } = recorder(call => jsonResponse(200, {
    scores: call.body.texts.map((_, i) => (i === 2 ? null : 50 - i * 100)), remaining: 997
  }));
  const ctx = makeContext({ fetchImpl, extra: { crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' } } });
  const P = ctx.XFPProviders;
  const result = await P.scoreBatch(['kind', 'x'.repeat(1000), 'beyond the cap']);
  assert.deepEqual([...result.scores], [50, -50, null]);
  assert.equal(result.provider, 'builtin');
  assert.equal(calls[0].url, `${BUILTIN_URL}/v1/score`);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.installId, '11111111-2222-4333-8444-555555555555');
  assert.equal(calls[0].body.texts[1].length, 400);
  assert.equal(status(ctx, 'builtin').state, 'working');
  assert.equal(P.usageFor('builtin').postsRemaining, 997);
  P.resetRuntime();
  await P.scoreBatch(['again']);
  assert.equal(calls[1].body.installId, calls[0].body.installId);
  assert.equal(ctx.chrome.storage.local.data.xfpInstallId, calls[0].body.installId);
});

test('install ID falls back to a random v4 UUID without crypto.randomUUID', async () => {
  const id = await makeContext().XFPProviders.getInstallId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('daily_limit uses keywords, reports once and backs off until the reset (even after a worker restart)', async () => {
  const resetsAt = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const { calls, fetchImpl } = recorder(() => jsonResponse(429, { error: 'daily_limit', resetsAt }));
  const ctx = makeContext({ fetchImpl });
  const P = ctx.XFPProviders;
  const first = await P.scoreBatch(['a']);
  assert.equal(first.scores, null);
  assert.equal(first.attempts[0].state, 'daily_limit');
  assert.equal(first.attempts[0].fresh, true);
  assert.ok(first.retryAfterMs > 4 * 3600 * 1000);
  const block = ctx.chrome.storage.local.data.xfpBuiltinBlock;
  assert.equal(block.state, 'daily_limit');
  assert.ok(Math.abs(block.until - Date.parse(resetsAt)) < 5000);
  const second = await P.scoreBatch(['b']);
  assert.equal(second.attempts[0].fresh, false);
  assert.equal(calls.length, 1);
  // A restarted worker (fresh runtime, same storage) still does not call the server.
  P.resetRuntime();
  const third = await P.scoreBatch(['c']);
  assert.equal(third.attempts[0].state, 'daily_limit');
  assert.equal(third.attempts[0].fresh, false);
  assert.equal(calls.length, 1);
  const label = P.describeStatus((await P.loadConfig()).providers.builtin, status(ctx, 'builtin')).label;
  assert.equal(label, 'Free AI limit reached for today — add your own key in Settings for unlimited scoring');
});

test('global_budget on built-in fails over to the fallback provider', async () => {
  const { calls, fetchImpl } = recorder(call => (call.url.startsWith(BUILTIN_URL)
    ? jsonResponse(503, { error: 'global_budget' })
    : jsonResponse(200, chat('[33]'))));
  const ctx = makeContext({ fetchImpl, sync: { aiProvider: 'builtin', fallbackProvider: 'groq', groqApiKey: 'gsk_x' } });
  const result = await ctx.XFPProviders.scoreBatch(['hello']);
  assert.deepEqual([...result.scores], [33]);
  assert.equal(result.provider, 'groq');
  assert.equal(result.attempts[0].state, 'global_budget');
  assert.equal(calls.length, 2);
  // Without a reset time, the back-off lasts until the next UTC day.
  const until = ctx.chrome.storage.local.data.xfpBuiltinBlock.until;
  const d = new Date();
  assert.equal(until >= Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1000, true);
});

test('built-in network error or server error falls back to keywords with a short cooldown', async () => {
  let ctx = makeContext({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  let result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(result.scores, null);
  assert.equal(result.attempts[0].state, 'network_error');
  assert.ok(result.retryAfterMs <= 60000);
  assert.equal(ctx.chrome.storage.local.data.xfpBuiltinBlock, undefined);

  ctx = makeContext({ fetchImpl: async () => jsonResponse(502, { error: 'backend_error' }) });
  result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(result.attempts[0].state, 'api_error');
  assert.equal(status(ctx, 'builtin').httpStatus, 502);

  ctx = makeContext({ fetchImpl: async () => jsonResponse(429, { error: 'rate_limited', retryAfterSeconds: 7 }) });
  result = await ctx.XFPProviders.scoreBatch(['x']);
  assert.equal(result.attempts[0].state, 'rate_limited');
  assert.equal(result.attempts[0].waitSeconds, 7);
});

test('built-in status reports posts left and lifts a stale back-off', async () => {
  const replies = [
    { remaining: 0, limit: 1000, state: 'daily_limit', resetsAt: new Date(Date.now() + 3600000).toISOString() },
    { remaining: 1000, limit: 1000, state: 'ok', resetsAt: new Date(Date.now() + 3600000).toISOString() }
  ];
  const urls = [];
  const ctx = makeContext({ fetchImpl: async url => { urls.push(url); return jsonResponse(200, replies.shift()); } });
  const P = ctx.XFPProviders;
  const limited = await P.builtinStatus();
  assert.equal(limited.remaining, 0);
  assert.equal(ctx.chrome.storage.local.data.xfpBuiltinBlock.state, 'daily_limit');
  assert.match(urls[0], new RegExp(`^${BUILTIN_URL}/v1/status\\?installId=[0-9a-f-]{36}$`));
  const ok = await P.builtinStatus();
  assert.equal(ok.remaining, 1000);
  assert.equal(ctx.chrome.storage.local.data.xfpBuiltinBlock, undefined);
});

test('content scripts show the one-time free-limit notice', async () => {
  const filter = loadFilter(async message => ({
    scores: null,
    attempts: [{ provider: 'builtin', name: 'Built-in AI', state: 'daily_limit', fresh: true }],
    retryAfterMs: 3600000
  }));
  await filter.loadProviderConfig();
  const errors = [];
  filter.onApiError = (...args) => errors.push(args);
  filter.batchQueue.push({ tweetId: '1', text: 'hi', callback() {} });
  await filter.processBatchQueue();
  assert.deepEqual(errors, [['Built-in AI', 'daily_limit', null]]);
  for (const file of ['content.js', 'content-googlenews.js']) {
    assert.match(read(file), /reason === 'daily_limit' \|\| reason === 'global_budget'[\s\S]{0,80}BUILTIN_LIMIT_NOTICE/, file);
  }
});

test('popup shows built-in status without asking for a key', async () => {
  const ui = popupContext({ sync: {} });
  await ui.ctx.updateAIStatus();
  assert.equal(ui.indicator.className, 'ai-indicator ready');
  assert.match(ui.text.textContent, /Built-in AI is on/);
  assert.doesNotMatch(ui.keyStatus.textContent, /key/i);
  const limited = popupContext({ sync: {}, local: { xfpStatus_builtin: { state: 'daily_limit', checkedAt: Date.now() } } });
  await limited.ctx.updateAIStatus();
  assert.match(limited.warning.textContent, /^Free AI limit reached for today — add your own key in Settings/);
});
