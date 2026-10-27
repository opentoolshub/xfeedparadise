// XFeed Paradise - AI provider registry and request adapters.
//
// Loaded as a classic script by the popup and content scripts, and imported
// for side effects by the background service worker. Provider HTTP calls run
// only in the background worker (extension origin, not subject to page CORS).
// API keys are never logged and never included in status messages.

(function (root) {
  'use strict';

  const SAMPLE_TEXT = 'Thank you all for helping me learn something new today. Grateful for this community!';

  // Rubric for TypeSafe Jev, ordered from the low end of the scale to the high end.
  const JEV_CRITERIA = [
    'Outrage-bait: hostile, insulting or inflammatory; written to provoke anger, fear or tribal conflict',
    'Negative: cynical, mocking, alarmist or divisive, without being openly hostile',
    'Neutral: plain information, announcements or everyday chatter with little emotional charge',
    'Positive: friendly, constructive, helpful or encouraging',
    'Uplifting: kind, insightful, educational or inspiring; leaves the reader better off'
  ];
  const JEV_INSTRUCTIONS = 'How uplifting versus outrage-inducing is this social media post?';

  // kind: 'openai' (chat completions), 'anthropic' (Messages API), 'jev' (System One score)
  const PROVIDERS = {
    groq: {
      id: 'groq',
      name: 'Groq',
      kind: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'openai/gpt-oss-20b',
      keyUrl: 'https://console.groq.com/keys',
      keyHint: 'Free key, no card required.',
      keyPlaceholder: 'gsk_...',
      keyPrefix: 'gsk_',
      requiredPermission: true, // listed in manifest host_permissions
      origin: 'https://api.groq.com/*',
      minInterval: 2200, // ~27 requests/minute on the free tier
      params: { temperature: 0, max_completion_tokens: 256, reasoning_effort: 'low', include_reasoning: false }
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.4-nano',
      keyUrl: 'https://platform.openai.com/api-keys',
      keyHint: 'Paid API key from the OpenAI platform.',
      keyPlaceholder: 'sk-...',
      origin: 'https://api.openai.com/*',
      minInterval: 300,
      // GPT-5 family: reasoning models reject non-default temperature and max_tokens.
      params: { max_completion_tokens: 1024, reasoning_effort: 'low' }
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-haiku-5-5',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      keyHint: 'Paid API key from the Anthropic Console.',
      keyPlaceholder: 'sk-ant-...',
      origin: 'https://api.anthropic.com/*',
      minInterval: 300,
      params: { max_tokens: 256 } // temperature is deprecated on current Claude models
    },
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      kind: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-3.8-flash',
      keyUrl: 'https://aistudio.google.com/apikey',
      keyHint: 'API key from Google AI Studio.',
      keyPlaceholder: 'AIza...',
      origin: 'https://generativelanguage.googleapis.com/*',
      minInterval: 500,
      params: { temperature: 0, max_tokens: 1024, reasoning_effort: 'low' }
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-oss-20b',
      keyUrl: 'https://openrouter.ai/keys',
      keyHint: 'One key for many model vendors.',
      keyPlaceholder: 'sk-or-...',
      origin: 'https://openrouter.ai/*',
      minInterval: 500,
      params: { temperature: 0, max_tokens: 512, reasoning_effort: 'low', include_reasoning: false }
    },
    together: {
      id: 'together',
      name: 'Together',
      kind: 'openai',
      baseUrl: 'https://api.together.xyz/v1',
      defaultModel: 'openai/gpt-oss-120b',
      keyUrl: 'https://api.together.ai/settings/api-keys',
      keyHint: 'API key from Together AI.',
      keyPlaceholder: 'Together API key',
      origin: 'https://api.together.xyz/*',
      minInterval: 1100,
      params: { temperature: 0, max_tokens: 512, reasoning_effort: 'low' }
    },
    jev: {
      id: 'jev',
      name: 'TypeSafe Jev',
      kind: 'jev',
      baseUrl: 'https://api.typesafe.ai/v1',
      defaultModel: 'jev-latest',
      keyUrl: 'https://console.typesafe.ai/keys',
      keyHint: 'Scores each post on a fixed rubric; the custom prompt is not used.',
      keyPlaceholder: 'TypeSafe API key',
      origin: 'https://api.typesafe.ai/*',
      minInterval: 0,
      concurrency: 5
    },
    custom: {
      id: 'custom',
      name: 'Custom (OpenAI-compatible)',
      shortName: 'Custom endpoint',
      kind: 'openai',
      baseUrl: '',
      defaultModel: '',
      keyUrl: null,
      keyHint: 'Any OpenAI-compatible server, e.g. Ollama at http://localhost:11434/v1. Key optional.',
      keyPlaceholder: 'Optional',
      keyOptional: true,
      customBaseUrl: true,
      minInterval: 0,
      params: { temperature: 0, max_tokens: 512 }
    }
  };

  const ORDER = ['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'together', 'jev', 'custom'];

  const SYNC_KEYS = ['aiProvider', 'fallbackProvider', 'providerOptions', 'customPrompt']
    .concat(ORDER.map(keyName));

  // Storage name for each provider's key. Groq and Together keep their v1.3.2 names.
  function keyName(id) {
    return `${id}ApiKey`;
  }

  function statusKey(id) {
    return `xfpStatus_${id}`;
  }

  function chromeApi() {
    return root.chrome;
  }

  function displayName(id) {
    const def = PROVIDERS[id];
    return def ? (def.shortName || def.name) : id;
  }

  // ---------------------------------------------------------------- config

  function configFromStorage(stored) {
    const options = (stored && stored.providerOptions) || {};
    const providers = {};
    for (const id of ORDER) {
      const def = PROVIDERS[id];
      const opt = options[id] || {};
      providers[id] = {
        id,
        name: displayName(id),
        apiKey: (stored && typeof stored[keyName(id)] === 'string') ? stored[keyName(id)].trim() : '',
        model: (opt.model || def.defaultModel || '').trim(),
        baseUrl: (def.customBaseUrl ? (opt.baseUrl || '') : def.baseUrl).trim()
      };
    }
    const primary = PROVIDERS[stored && stored.aiProvider] ? stored.aiProvider : 'groq';
    let fallback = PROVIDERS[stored && stored.fallbackProvider] ? stored.fallbackProvider : null;
    if (fallback === primary) fallback = null;
    return {
      primary,
      fallback,
      customPrompt: (stored && stored.customPrompt) || null,
      providers
    };
  }

  async function loadConfig() {
    const stored = await chromeApi().storage.sync.get(SYNC_KEYS);
    return configFromStorage(stored);
  }

  // Returns null when ready, else a reason: 'no_key' | 'key_format' | 'no_base_url' | 'no_model' | 'bad_base_url'
  function configProblem(entry) {
    if (!entry) return 'no_key';
    const def = PROVIDERS[entry.id];
    if (def.customBaseUrl) {
      if (!entry.baseUrl) return 'no_base_url';
      if (!permissionOrigin(entry.id, entry.baseUrl)) return 'bad_base_url';
    }
    if (!entry.model) return 'no_model';
    if (!def.keyOptional && !entry.apiKey) return 'no_key';
    if (def.keyPrefix && entry.apiKey && !entry.apiKey.startsWith(def.keyPrefix)) return 'key_format';
    return null;
  }

  function isConfigured(entry) {
    return configProblem(entry) === null;
  }

  // Ordered list of configured providers to try: primary, then fallback.
  function chain(config) {
    const ids = [config.primary];
    if (config.fallback && config.fallback !== config.primary) ids.push(config.fallback);
    return ids.map(id => config.providers[id]).filter(isConfigured);
  }

  // Host-permission match pattern needed for a provider, or null if invalid.
  // Required (manifest) permissions are reported too; callers can skip them.
  function permissionOrigin(id, baseUrl) {
    const def = PROVIDERS[id];
    if (!def) return null;
    if (!def.customBaseUrl) return def.origin;
    let url;
    try { url = new URL(baseUrl); } catch (e) { return null; }
    const host = url.hostname;
    if (url.protocol === 'https:') return `https://${host}/*`;
    if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return `http://${host}/*`;
    return null;
  }

  async function saveProvider(id, values) {
    const chrome = chromeApi();
    const def = PROVIDERS[id];
    if (!def) throw new Error(`Unknown provider ${id}`);
    const updates = {};
    if (values.apiKey !== undefined) updates[keyName(id)] = String(values.apiKey || '').trim();
    if (values.model !== undefined || values.baseUrl !== undefined) {
      const { providerOptions = {} } = await chrome.storage.sync.get('providerOptions');
      const current = { ...(providerOptions[id] || {}) };
      if (values.model !== undefined) {
        const model = String(values.model || '').trim();
        // Store only overrides so future default upgrades reach existing users.
        if (!model || model === def.defaultModel) delete current.model; else current.model = model;
      }
      if (values.baseUrl !== undefined && def.customBaseUrl) {
        current.baseUrl = String(values.baseUrl || '').trim().replace(/\/+$/, '');
      }
      updates.providerOptions = { ...providerOptions, [id]: current };
    }
    await chrome.storage.sync.set(updates);
    await chrome.storage.local.remove(statusKey(id));
  }

  async function saveSelection({ primary, fallback }) {
    const updates = {};
    if (primary !== undefined) updates.aiProvider = PROVIDERS[primary] ? primary : 'groq';
    if (fallback !== undefined) updates.fallbackProvider = PROVIDERS[fallback] ? fallback : '';
    await chromeApi().storage.sync.set(updates);
  }

  // ---------------------------------------------------------------- status

  const STATUS_TTL = 15 * 60 * 1000;

  async function recordStatus(id, state, httpStatus = null) {
    await chromeApi().storage.local.set({
      [statusKey(id)]: { state, httpStatus, checkedAt: Date.now() }
    });
  }

  async function loadStatuses() {
    const stored = await chromeApi().storage.local.get(ORDER.map(statusKey));
    const out = {};
    for (const id of ORDER) {
      const s = stored[statusKey(id)];
      if (s && Date.now() - s.checkedAt <= STATUS_TTL) out[id] = s;
    }
    return out;
  }

  // Human-readable status. Never includes key material.
  function describeStatus(entry, status) {
    const name = entry ? displayName(entry.id) : 'AI provider';
    const problem = configProblem(entry);
    if (problem === 'no_key') return { state: 'disabled', label: `Add your ${name} key to enable AI scoring` };
    if (problem === 'no_base_url') return { state: 'disabled', label: 'Add a base URL to enable the custom endpoint' };
    if (problem === 'bad_base_url') return { state: 'error', label: 'Base URL must use https, or http://localhost' };
    if (problem === 'no_model') return { state: 'disabled', label: `Choose a ${name} model` };
    if (problem === 'key_format') {
      return { state: 'error', label: `Invalid ${name} key format (expected ${PROVIDERS[entry.id].keyPrefix})` };
    }
    switch (status && status.state) {
      case 'working': return { state: 'ready', label: `${name} AI scoring is working` };
      case 'available': return { state: 'loading', label: `${name} key and model reachable; scoring not yet verified` };
      case 'auth_error': return { state: 'error', label: `${name} rejected this key — check or replace it` };
      case 'rate_limited': return { state: 'error', label: `${name} rate limit reached` };
      case 'model_error': return { state: 'error', label: `Model "${entry.model}" is unavailable on ${name}` };
      case 'network_error': return { state: 'error', label: `Cannot reach ${name}` };
      case 'invalid_response': return { state: 'error', label: `${name} returned an unusable score` };
      case 'permission_needed': return { state: 'error', label: `Access to ${name} not granted — click Test connection` };
      case 'api_error':
        return { state: 'error', label: `${name} API error${status.httpStatus ? ` (${status.httpStatus})` : ''}` };
      default: return { state: 'loading', label: `${name} configured; connection not yet verified` };
    }
  }

  // ---------------------------------------------------------------- prompt + parsing

  function buildBatchPrompt(texts, customPrompt) {
    const list = texts.map((t, i) => `${i + 1}. "${String(t).slice(0, 200)}"`).join('\n');
    if (customPrompt) {
      return `${customPrompt}\n\nRate each of these ${texts.length} tweets. Reply with ONLY a JSON array of ${texts.length} integers.\n\nTweets:\n${list}`;
    }
    return `Rate the sentiment/vibe of each tweet from -100 (very negative, toxic, outrage-bait) to +100 (very positive, uplifting, enlightening).

Consider for each: Is it angry/divisive? Inflammatory? Spreading fear/hate? Or kind, helpful, educational, inspiring?

Reply with ONLY the scores as a JSON array of integers, like: [25, -30, 50, -10, ...]
One number per tweet, in the same order. No other text.

Tweets to rate:
${list}`;
  }

  function clampScore(n) {
    return Math.max(-100, Math.min(100, Math.round(Number(n))));
  }

  function parseScores(content, expectedCount) {
    if (!content || typeof content !== 'string') return null;
    try {
      const arrayMatch = content.match(/\[[\d\s,.\-]+\]/);
      if (arrayMatch) {
        const scores = JSON.parse(arrayMatch[0]);
        if (Array.isArray(scores) && scores.length === expectedCount && scores.every(s => Number.isFinite(Number(s)))) {
          return scores.map(clampScore);
        }
      }
    } catch (e) {
      // fall through to loose number extraction
    }
    const numbers = content.match(/-?\d+/g);
    if (numbers && numbers.length === expectedCount) return numbers.map(clampScore);
    return null;
  }

  // Map a Jev score answer (levels 0..n-1) to -100..100 using the expected value
  // over the returned probabilities (falls back to the score field).
  function jevToVibe(answer, levels = JEV_CRITERIA.length) {
    if (!answer) return null;
    let position = null;
    const probs = answer.probabilities;
    if (probs && typeof probs === 'object') {
      let total = 0;
      let weighted = 0;
      for (const [level, p] of Object.entries(probs)) {
        const lv = Number(level);
        const pv = Number(p);
        if (Number.isFinite(lv) && Number.isFinite(pv)) {
          total += pv;
          weighted += lv * pv;
        }
      }
      if (total > 0) position = weighted / total;
    }
    if (position === null && Number.isFinite(Number(answer.score))) position = Number(answer.score);
    if (position === null) return null;
    return clampScore(-100 + (200 * position) / (levels - 1));
  }

  // ---------------------------------------------------------------- HTTP helpers

  function parseResetTime(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(str)) {
      const sec = parseFloat(str);
      return sec < 100000 ? Math.ceil(sec * 1000) : null;
    }
    const date = Date.parse(str);
    if (!Number.isNaN(date) && /\d{4}-\d{2}-\d{2}/.test(str)) return Math.max(1000, date - Date.now());
    let ms = 0;
    const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
    let m;
    while ((m = re.exec(str))) {
      const n = parseFloat(m[1]);
      ms += m[2] === 'h' ? n * 3600000 : m[2] === 'm' ? n * 60000 : m[2] === 's' ? n * 1000 : n;
    }
    return ms ? Math.ceil(ms) : null;
  }

  function header(response, name) {
    try { return response.headers && response.headers.get ? response.headers.get(name) : null; } catch (e) { return null; }
  }

  function readUsage(response) {
    const num = v => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));
    return {
      requestsRemaining: num(header(response, 'x-ratelimit-remaining-requests') ?? header(response, 'anthropic-ratelimit-requests-remaining')),
      requestsLimit: num(header(response, 'x-ratelimit-limit-requests') ?? header(response, 'anthropic-ratelimit-requests-limit')),
      tokensRemaining: num(header(response, 'x-ratelimit-remaining-tokens') ?? header(response, 'anthropic-ratelimit-tokens-remaining'))
    };
  }

  const STRIPPABLE = ['temperature', 'reasoning_effort', 'include_reasoning', 'top_p', 'max_completion_tokens', 'max_tokens'];

  // Remove request params that a 400 error message names as unsupported.
  // Returns the list of params changed (empty if none matched).
  function stripUnsupportedParams(body, message) {
    if (!message) return [];
    const msg = String(message);
    const mentions = param => new RegExp(`(^|[^a-z_])${param}([^a-z_]|$)`, 'i').test(msg);
    const present = STRIPPABLE.filter(param => param in body);
    const changed = [];
    for (const param of present) {
      if (!mentions(param)) continue;
      const value = body[param];
      delete body[param];
      // Token limits are renamed rather than dropped (OpenAI reasoning models
      // want max_completion_tokens; many compatible servers only know max_tokens).
      if (param === 'max_tokens' && mentions('max_completion_tokens')) body.max_completion_tokens = value;
      if (param === 'max_completion_tokens') body.max_tokens = value;
      changed.push(param);
    }
    return changed;
  }

  function classifyHttpError(status, message) {
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'model_error';
    if (status === 400 && /model/i.test(message || '') &&
        /(not found|does not exist|not exist|invalid|unknown|not supported|decommissioned|no such)/i.test(message || '')) {
      return 'model_error';
    }
    return 'api_error';
  }

  async function safeText(response) {
    try { return await response.text(); } catch (e) { return ''; }
  }

  async function postJson(fetchImpl, url, headers, body, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(response) {
    const text = await safeText(response);
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function failure(response, message) {
    const status = response.status;
    const state = classifyHttpError(status, message);
    const retryAfterMs = state === 'rate_limited'
      ? (parseResetTime(header(response, 'retry-after')) ||
         parseResetTime(header(response, 'x-ratelimit-reset-requests')) ||
         parseResetTime(header(response, 'anthropic-ratelimit-requests-reset')) || 60000)
      : null;
    return { ok: false, state, httpStatus: status, retryAfterMs, usage: readUsage(response) };
  }

  // Send a request; on a 400 that names an unsupported param, retry once without it.
  async function sendTolerant(fetchImpl, url, headers, body) {
    let response = await postJson(fetchImpl, url, headers, body);
    if (response.ok) return { response, retried: [] };
    const message = await safeText(response);
    if (response.status === 400) {
      const changed = stripUnsupportedParams(body, message);
      if (changed.length) {
        response = await postJson(fetchImpl, url, headers, body);
        if (response.ok) return { response, retried: changed };
        return { response, message: await safeText(response), retried: changed };
      }
    }
    return { response, message, retried: [] };
  }

  function chatEndpoint(entry) {
    const base = entry.baseUrl.replace(/\/+$/, '');
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  // ---------------------------------------------------------------- adapters

  async function callOpenAICompatible(entry, texts, prompt, fetchImpl) {
    const def = PROVIDERS[entry.id];
    const body = { model: entry.model, messages: [{ role: 'user', content: prompt }], ...(def.params || {}) };
    const headers = {};
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    if (entry.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/opentoolshub/xfeedparadise';
      headers['X-Title'] = 'XFeed Paradise';
    }
    const { response, message, retried } = await sendTolerant(fetchImpl, chatEndpoint(entry), headers, body);
    if (!response.ok) return failure(response, message);
    const data = await readJson(response);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    const scores = parseScores(typeof content === 'string' ? content.trim() : null, texts.length);
    return scores
      ? { ok: true, scores, usage: readUsage(response), retried }
      : { ok: false, state: 'invalid_response', httpStatus: response.status, usage: readUsage(response) };
  }

  async function callAnthropic(entry, texts, prompt, fetchImpl) {
    const def = PROVIDERS[entry.id];
    const body = { model: entry.model, messages: [{ role: 'user', content: prompt }], ...(def.params || {}) };
    const headers = {
      'x-api-key': entry.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    const { response, message, retried } = await sendTolerant(fetchImpl, `${entry.baseUrl}/messages`, headers, body);
    if (!response.ok) return failure(response, message);
    const data = await readJson(response);
    const block = data && Array.isArray(data.content)
      ? (data.content.find(b => b && b.type === 'text') || data.content[0]) : null;
    const scores = parseScores(block && typeof block.text === 'string' ? block.text.trim() : null, texts.length);
    return scores
      ? { ok: true, scores, usage: readUsage(response), retried }
      : { ok: false, state: 'invalid_response', httpStatus: response.status, usage: readUsage(response) };
  }

  async function callJev(entry, texts, _prompt, fetchImpl) {
    const def = PROVIDERS[entry.id];
    const scores = new Array(texts.length).fill(null);
    let failed = null;
    let usage = null;
    let next = 0;

    async function worker() {
      while (!failed && next < texts.length) {
        const index = next++;
        const body = {
          model: entry.model,
          state: String(texts[index]).slice(0, 2000),
          questions: {
            vibe: { type: 'score', instructions: JEV_INSTRUCTIONS, criteria: JEV_CRITERIA }
          }
        };
        const response = await postJson(fetchImpl, `${entry.baseUrl}/systemone`,
          { Authorization: `Bearer ${entry.apiKey}` }, body, 15000);
        if (!response.ok) {
          if (!failed) failed = failure(response, await safeText(response));
          return;
        }
        usage = readUsage(response);
        const data = await readJson(response);
        const vibe = jevToVibe(data && data.answers && data.answers.vibe);
        if (vibe === null) {
          if (!failed) failed = { ok: false, state: 'invalid_response', httpStatus: response.status };
          return;
        }
        scores[index] = vibe;
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(def.concurrency || 5, texts.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (failed) return failed;
    return { ok: true, scores, usage, retried: [] };
  }

  const ADAPTERS = { openai: callOpenAICompatible, anthropic: callAnthropic, jev: callJev };

  // One scoring call to one provider. Never throws.
  async function callProvider(entry, texts, options = {}) {
    const fetchImpl = options.fetch || root.fetch.bind(root);
    const def = PROVIDERS[entry.id];
    const prompt = options.prompt || buildBatchPrompt(texts, options.customPrompt);
    try {
      return await ADAPTERS[def.kind](entry, texts, prompt, fetchImpl);
    } catch (error) {
      return { ok: false, state: 'network_error', httpStatus: null };
    }
  }

  // ---------------------------------------------------------------- orchestration (background)

  // Per-provider runtime state: throttling and cooldowns. Lives in the worker.
  const runtime = {};

  function rt(id) {
    if (!runtime[id]) runtime[id] = { nextSlot: 0, blockedUntil: 0, blockedState: null, usage: null };
    return runtime[id];
  }

  function resetRuntime(id) {
    if (id) delete runtime[id];
    else for (const key of Object.keys(runtime)) delete runtime[key];
  }

  const COOLDOWN = {
    auth_error: Infinity, // until the key or provider changes
    model_error: Infinity,
    permission_needed: Infinity,
    api_error: 60000,
    network_error: 30000,
    invalid_response: 30000
  };

  async function throttle(id) {
    const def = PROVIDERS[id];
    const state = rt(id);
    const now = Date.now();
    const wait = Math.max(0, state.nextSlot - now);
    state.nextSlot = Math.max(now, state.nextSlot) + (def.minInterval || 0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  async function hasPermission(entry) {
    const def = PROVIDERS[entry.id];
    if (def.requiredPermission) return true;
    const origin = permissionOrigin(entry.id, entry.baseUrl);
    if (!origin) return false;
    const perms = chromeApi() && chromeApi().permissions;
    if (!perms || !perms.contains) return true; // non-extension context (tests)
    try { return await perms.contains({ origins: [origin] }); } catch (e) { return false; }
  }

  // Score with one provider, applying throttling, permission checks, status and cooldowns.
  async function attempt(entry, texts, options = {}) {
    const id = entry.id;
    const state = rt(id);
    if (!options.force && state.blockedUntil > Date.now()) {
      return { ok: false, state: state.blockedState, skipped: true, retryAfterMs: state.blockedUntil - Date.now() };
    }
    if (!(await hasPermission(entry))) {
      state.blockedUntil = Infinity;
      state.blockedState = 'permission_needed';
      await recordStatus(id, 'permission_needed');
      return { ok: false, state: 'permission_needed', httpStatus: null };
    }
    if (!options.force) await throttle(id);
    const result = await callProvider(entry, texts, options);
    if (result.usage) state.usage = result.usage;
    if (result.ok) {
      state.blockedUntil = 0;
      state.blockedState = null;
      await recordStatus(id, 'working', null);
      return result;
    }
    const cooldown = result.state === 'rate_limited' ? (result.retryAfterMs || 60000) : (COOLDOWN[result.state] || 30000);
    state.blockedUntil = Date.now() + cooldown;
    state.blockedState = result.state;
    await recordStatus(id, result.state, result.httpStatus || null);
    return result;
  }

  // Primary → fallback → (caller uses keywords). Returns scores or null with attempts.
  async function scoreBatch(texts, options = {}) {
    const config = options.config || await loadConfig();
    const attempts = [];
    for (const entry of chain(config)) {
      const result = await attempt(entry, texts, { ...options, customPrompt: config.customPrompt });
      attempts.push({
        provider: entry.id,
        name: displayName(entry.id),
        state: result.ok ? 'working' : result.state,
        httpStatus: result.httpStatus || null,
        waitSeconds: result.retryAfterMs && Number.isFinite(result.retryAfterMs) ? Math.round(result.retryAfterMs / 1000) : null,
        fresh: !result.skipped
      });
      if (result.ok) {
        return { scores: result.scores, provider: entry.id, providerName: displayName(entry.id), attempts };
      }
    }
    const waits = attempts.map(a => (a.waitSeconds ? a.waitSeconds * 1000 : 30000));
    return {
      scores: null,
      provider: null,
      providerName: null,
      attempts,
      retryAfterMs: attempts.length ? Math.min(...waits) : null
    };
  }

  // Explicit connection test: a real one-post scoring call, bypassing cooldowns.
  async function testProvider(id, options = {}) {
    const config = options.config || await loadConfig();
    const entry = config.providers[id];
    if (!isConfigured(entry)) return { state: 'not_configured', problem: configProblem(entry) };
    resetRuntime(id);
    const result = await attempt(entry, [SAMPLE_TEXT], { ...options, force: true, customPrompt: config.customPrompt });
    return { state: result.ok ? 'working' : result.state, httpStatus: result.httpStatus || null };
  }

  function usageFor(id) {
    return (runtime[id] && runtime[id].usage) || null;
  }

  root.XFPProviders = {
    PROVIDERS,
    ORDER,
    SYNC_KEYS,
    JEV_CRITERIA,
    keyName,
    statusKey,
    displayName,
    configFromStorage,
    loadConfig,
    configProblem,
    isConfigured,
    chain,
    permissionOrigin,
    saveProvider,
    saveSelection,
    recordStatus,
    loadStatuses,
    describeStatus,
    buildBatchPrompt,
    parseScores,
    jevToVibe,
    parseResetTime,
    stripUnsupportedParams,
    callProvider,
    scoreBatch,
    testProvider,
    resetRuntime,
    usageFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
