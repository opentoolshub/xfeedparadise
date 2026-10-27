'use strict';

// XFeed Paradise built-in scoring service.
//   POST /v1/score   {installId, texts[]} -> {scores[]} | {error}
//   GET  /v1/status?installId=           -> remaining posts today
//   GET  /api/ok                          -> health (Cloud Run reserves /healthz)
// Post text is forwarded to a scoring backend and never logged or stored.

const { BACKENDS } = require('./backends');
const { Limits } = require('./limits');

const MAX_TEXTS = 10;
const BODY_LIMIT = 16 * 1024;
const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;
const ALLOWED_ORIGIN = /^(chrome-extension|safari-web-extension):\/\/[A-Za-z0-9._-]+$/;

// USD per million tokens. Override with XFEED_PRICES='{"nano":{"input":0.2,"output":1.25}}'.
const DEFAULT_PRICES = {
  decisions: { input: 0.10, output: 0 },
  jev: { input: 0.042, output: 0 },
  nano: { input: 0.20, output: 1.25 }
};

function intEnv(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env) {
  let prices = DEFAULT_PRICES;
  if (env.XFEED_PRICES) {
    try {
      const override = JSON.parse(env.XFEED_PRICES);
      prices = { ...DEFAULT_PRICES };
      for (const [id, p] of Object.entries(override)) prices[id] = { ...(prices[id] || {}), ...p };
    } catch (e) { /* keep defaults */ }
  }
  const order = String(env.XFEED_BACKENDS || 'jev,decisions,nano')
    .split(',').map(s => s.trim()).filter(Boolean);
  const backends = order
    .filter(id => BACKENDS[id] && env[BACKENDS[id].keyEnv])
    .map(id => ({ backend: BACKENDS[id], apiKey: env[BACKENDS[id].keyEnv] }));
  return {
    backends,
    prices,
    maxChars: intEnv(env, 'XFEED_MAX_CHARS', 400),
    trustProxy: env.XFEED_TRUST_PROXY !== '0',
    limits: {
      perInstall: intEnv(env, 'XFEED_INSTALL_DAILY_POSTS', 1000),
      perIp: intEnv(env, 'XFEED_IP_DAILY_POSTS', 3000),
      globalUsd: intEnv(env, 'XFEED_GLOBAL_DAILY_USD', 3),
      perMinute: intEnv(env, 'XFEED_INSTALL_REQUESTS_PER_MINUTE', 60)
    }
  };
}

function estimateCost(prices, backendId, usage, texts) {
  const price = prices[backendId] || { input: 1, output: 1 };
  let input = usage && usage.inputTokens;
  const output = (usage && usage.outputTokens) || 0;
  // Without reported usage, assume ~4 chars/token plus rubric overhead per post.
  if (!input) input = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4) + 200, 0);
  return (input * (price.input || 0) + output * (price.output || 0)) / 1e6;
}

function defaultLogger(entry) {
  process.stdout.write(`${JSON.stringify({ severity: entry.status >= 500 ? 'ERROR' : 'INFO', ...entry })}\n`);
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      // The rightmost entry is the one added by the platform front end;
      // anything to its left is client-supplied.
      const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('too_large'), { code: 'too_large' });
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      req.resume(); // discard
      reject(tooLarge());
      return;
    }
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function createApp({ env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = defaultLogger } = {}) {
  const config = loadConfig(env);
  const limits = new Limits({ ...config.limits, now });

  function send(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  async function score(req, res, ip, log) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      log.error = e && e.code === 'too_large' ? 'too_large' : 'bad_json';
      return send(res, 400, { error: 'bad_request' });
    }
    const installId = payload && payload.installId;
    const texts = payload && payload.texts;
    if (typeof installId !== 'string' || !INSTALL_ID.test(installId) ||
        !Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS ||
        !texts.every(t => typeof t === 'string')) {
      log.error = 'bad_request';
      return send(res, 400, { error: 'bad_request' });
    }
    log.posts = texts.length;
    const wait = limits.hitRate(installId);
    if (wait) {
      log.error = 'rate_limited';
      return send(res, 429, { error: 'rate_limited', retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
    }
    const reservation = limits.reserve(installId, ip, texts.length);
    if (reservation.error) {
      log.error = reservation.error;
      return send(res, reservation.error === 'global_budget' ? 503 : 429,
        { error: reservation.error, resetsAt: limits.resetsAt() });
    }
    const batch = texts.slice(0, reservation.granted)
      .map(t => (t.trim() ? t.slice(0, config.maxChars) : '(empty post)'));
    log.granted = batch.length;
    log.failures = [];
    for (const { backend, apiKey } of config.backends) {
      try {
        const result = await backend.score(batch, { fetch: fetchImpl, apiKey, env });
        const costUsd = estimateCost(config.prices, backend.id, result.usage, batch);
        limits.settle(installId, ip, reservation, batch.length, costUsd);
        Object.assign(log, { backend: backend.id, inputTokens: result.usage.inputTokens, costUsd: Number(costUsd.toFixed(6)) });
        const scores = result.scores.concat(new Array(texts.length - batch.length).fill(null));
        return send(res, 200, { scores, remaining: limits.remaining(installId, ip), backend: backend.id });
      } catch (error) {
        log.failures.push({ backend: backend.id, code: error.code || 'error', httpStatus: error.httpStatus || null });
      }
    }
    limits.settle(installId, ip, reservation, 0, 0);
    log.error = config.backends.length ? 'backend_error' : 'no_backend';
    return send(res, 502, { error: 'backend_error' });
  }

  function status(url, res, ip, log) {
    const installId = url.searchParams.get('installId') || '';
    if (!INSTALL_ID.test(installId)) {
      log.error = 'bad_request';
      return send(res, 400, { error: 'bad_request' });
    }
    const exhausted = limits.budgetExhausted();
    const remaining = limits.remaining(installId, ip);
    return send(res, 200, {
      remaining: exhausted ? 0 : remaining,
      limit: limits.perInstall,
      state: exhausted ? 'global_budget' : remaining > 0 ? 'ok' : 'daily_limit',
      resetsAt: limits.resetsAt()
    });
  }

  async function handle(req, res) {
    const started = now();
    const url = new URL(req.url, 'http://localhost');
    const log = { method: req.method, route: url.pathname };
    const origin = req.headers.origin;
    try {
      if (origin) {
        if (!ALLOWED_ORIGIN.test(origin)) {
          log.error = 'forbidden_origin';
          return send(res, 403, { error: 'forbidden_origin' });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600'
        });
        return res.end();
      }
      const ip = clientIp(req, config.trustProxy);
      if (req.method === 'GET' && url.pathname === '/api/ok') {
        return send(res, 200, { ok: true, backends: config.backends.map(b => b.backend.id) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/status') return status(url, res, ip, log);
      if (req.method === 'POST' && url.pathname === '/v1/score') return await score(req, res, ip, log);
      log.error = 'not_found';
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      log.error = 'internal';
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    } finally {
      log.status = res.statusCode;
      log.latencyMs = now() - started;
      try { logger(log); } catch (e) { /* never fail a request on logging */ }
    }
  }

  return { handle, limits, config };
}

module.exports = { createApp, loadConfig, estimateCost, clientIp, DEFAULT_PRICES };
