const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function loadFilter(fetchImpl) {
  let status = null;
  const context = {
    window: {},
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    chrome: {
      storage: {
        local: {
          set(value) { status = value.xfpGroqStatus; },
          remove() { status = null; return Promise.resolve(); }
        }
      }
    }
  };
  vm.runInNewContext(read('filter.js'), context);
  context.window.VibeFilter.apis.groq.userKey = 'gsk_test';
  return { filter: context.window.VibeFilter, getStatus: () => status };
}

function response(status, content, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name] || null },
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

test('release runtime has no community upload endpoint or queue', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.host_permissions.some(host => host.includes('supabase')), false);
  for (const file of ['db.js', 'content.js', 'content-googlenews.js', 'popup.js', 'popup.html']) {
    assert.doesNotMatch(read(file), /queueForSync|SUPABASE_URL|xfp_sync_enabled|syncEnabled/);
  }
  assert.doesNotMatch(read('db.js'), /\bfetch\s*\(/);
});

test('successful Groq scoring records a working connection', async () => {
  const { filter, getStatus } = loadFilter(async () => response(200, '[42]'));
  const scores = await filter.scoreBatchWithApi('groq', ['A nice day']);
  assert.equal(scores[0], 42);
  assert.equal(getStatus().state, 'working');
});

test('rejected Groq key records an error and falls back', async () => {
  const { filter, getStatus } = loadFilter(async () => response(401));
  const warnings = [];
  filter.onApiError = (...args) => warnings.push(args);
  const scores = await filter.scoreBatchWithApi('groq', ['A nice day']);
  assert.equal(scores, null);
  assert.equal(getStatus().state, 'auth_error');
  assert.equal(getStatus().httpStatus, 401);
  assert.equal(warnings[0][1], 401);
});

test('Groq rate limit records a visible fallback state', async () => {
  const { filter, getStatus } = loadFilter(async () => response(429, null, { 'retry-after': '2' }));
  let waitSeconds = null;
  filter.onRateLimit = (_name, wait) => { waitSeconds = wait; };
  const scores = await filter.scoreBatchWithApi('groq', ['A nice day']);
  assert.equal(scores, null);
  assert.equal(getStatus().state, 'rate_limited');
  assert.equal(waitSeconds, 2);
});

test('network failure records a visible fallback state', async () => {
  const { filter, getStatus } = loadFilter(async () => { throw new Error('offline'); });
  const scores = await filter.scoreBatchWithApi('groq', ['A nice day']);
  assert.equal(scores, null);
  assert.equal(getStatus().state, 'network_error');
});

test('popup shows a warning for the last failed scoring request', async () => {
  const indicator = { className: '' };
  const text = { textContent: '' };
  const keyStatus = { textContent: '', className: '' };
  const warning = {
    textContent: '',
    visible: false,
    classList: { toggle(_name, value) { warning.visible = value; } }
  };
  const elements = {
    aiStatus: { querySelector: selector => selector === '.ai-indicator' ? indicator : text },
    apiKeyStatus: keyStatus,
    connectionWarning: warning
  };
  const context = {
    document: {
      addEventListener() {},
      getElementById: id => elements[id]
    },
    chrome: {
      storage: {
        sync: {
          get(key, callback) {
            const result = key === 'groqApiKey' ? { groqApiKey: 'gsk_test' } : { vibeFilterSettings: { useAI: true } };
            if (callback) callback(result);
            else return Promise.resolve(result);
          }
        },
        local: { get: async () => ({ xfpGroqStatus: { state: 'auth_error', httpStatus: 401, checkedAt: Date.now() } }) }
      }
    },
    Date,
    Promise
  };
  vm.runInNewContext(read('popup.js'), context);
  await context.updateAIStatus();
  assert.equal(indicator.className, 'ai-indicator error');
  assert.match(text.textContent, /rejected this key/);
  assert.equal(warning.visible, true);
  assert.match(warning.textContent, /keyword filtering remains available/);
});

test('a saved Groq key alone is not reported as a working connection', async () => {
  const indicator = { className: '' };
  const text = { textContent: '' };
  const keyStatus = { textContent: '', className: '' };
  const warning = {
    textContent: '',
    visible: false,
    classList: { toggle(_name, value) { warning.visible = value; } }
  };
  const elements = {
    aiStatus: { querySelector: selector => selector === '.ai-indicator' ? indicator : text },
    apiKeyStatus: keyStatus,
    connectionWarning: warning
  };
  const context = {
    document: { addEventListener() {}, getElementById: id => elements[id] },
    chrome: {
      storage: {
        sync: {
          get(key, callback) {
            const result = key === 'groqApiKey' ? { groqApiKey: 'gsk_test' } : { vibeFilterSettings: { useAI: true } };
            if (callback) callback(result);
            else return Promise.resolve(result);
          }
        },
        local: { get: async () => ({}) }
      }
    },
    Date,
    Promise
  };
  vm.runInNewContext(read('popup.js'), context);
  await context.updateAIStatus();
  assert.equal(indicator.className, 'ai-indicator loading');
  assert.match(text.textContent, /not yet verified/);
  assert.equal(warning.visible, false);
});
