// XFeed Paradise Reader HTTP server (node:http, no framework).
// Logs one line per request: method, route, status, item count, duration.
// Request bodies and post text are never logged.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, decodeCursor, normalizeItem } from './items.js';
import { TokenError } from './jwt.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const VERSION = '0.1.0';
const MAX_BODY = 512 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://pbs.twimg.com",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rateLimiter({ perMinute }) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const windowStart = now - 60_000;
    const list = (hits.get(key) || []).filter(t => t > windowStart);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) for (const [k, v] of hits) if (v[v.length - 1] <= windowStart) hits.delete(k);
    return list.length <= perMinute;
  };
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function createApp({ config, store, auth, log = line => console.log(line), now = Date.now }) {
  const allowedOrigins = new Set([config.publicOrigin, ...config.extensionOrigins]);
  const allowPost = rateLimiter({ perMinute: 120 });

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers
    });
    res.end(payload);
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      return true;
    }
    return false;
  }

  async function requireUser(req) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) {
      try {
        return await auth.verifyBearer(header.slice(7).trim());
      } catch (error) {
        if (error instanceof TokenError) throw new HttpError(401, 'invalid token');
        throw error;
      }
    }
    const user = auth.session(req);
    if (!user) throw new HttpError(401, 'sign in required');
    // Cookie sessions may only change data from the reader's own pages.
    if (req.method !== 'GET' && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'cross-origin request refused');
    return user;
  }

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'not found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const ext = extname(file);
    const fresh = ext === '.html' || rel === '/sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': fresh ? 'no-cache' : 'public, max-age=3600',
      ...SECURITY_HEADERS,
      ...(ext === '.html' ? { 'content-security-policy': CSP } : {})
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function route(req, res, url, meta) {
    const { pathname } = url;
    const method = req.method;

    if (pathname.startsWith('/v1/') || pathname.startsWith('/api/')) {
      const corsOk = applyCors(req, res);
      if (method === 'OPTIONS') {
        if (!corsOk) return send(res, 403, { error: 'origin not allowed' });
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-max-age': '600',
          ...SECURITY_HEADERS
        });
        return res.end();
      }
      // A browser request from any other origin is refused outright.
      if (req.headers.origin && !corsOk) return send(res, 403, { error: 'origin not allowed' });
    }

    if (pathname === '/api/ok' && method === 'GET') return send(res, 200, { ok: true, version: VERSION, store: store.kind });

    if (pathname === '/api/config' && method === 'GET') {
      return send(res, 200, {
        issuer: config.issuer,
        extensionClientId: config.extensionClientIds[0] || null,
        readerUrl: config.publicOrigin,
        limits: { batch: LIMITS.batch, perUser: config.perUser, ttlDays: config.ttlDays }
      });
    }

    if (pathname === '/api/frontend-log' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const level = ['error', 'warn', 'info'].includes(body.level) ? body.level : 'info';
      log(`frontend-log ${level} ${String(body.message || '').slice(0, 300).replace(/\s+/g, ' ')}`);
      return send(res, 204);
    }

    if (pathname === '/v1/items') {
      const user = await requireUser(req);
      if (method === 'GET') {
        const q = url.searchParams;
        const minScore = q.get('minScore') === null || q.get('minScore') === '' ? null : Number(q.get('minScore'));
        if (minScore !== null && !Number.isInteger(minScore)) throw new HttpError(400, 'minScore must be an integer');
        const keptParam = q.get('kept');
        const kept = keptParam === 'true' ? true : keptParam === 'false' ? false : null;
        const cursor = q.get('cursor') || null;
        if (cursor && !decodeCursor(cursor)) throw new HttpError(400, 'bad cursor');
        const limit = Math.min(LIMITS.pageMax, Math.max(1, Number(q.get('limit')) || LIMITS.pageDefault));
        const page = await store.list(user.sub, { minScore, kept, cursor, limit }, now());
        meta.count = page.items.length;
        return send(res, 200, page);
      }
      if (method === 'POST') {
        if (!allowPost(user.sub, now())) throw new HttpError(429, 'slow down');
        const body = await readJson(req);
        if (!Array.isArray(body.items)) throw new HttpError(400, 'items must be an array');
        if (body.items.length > LIMITS.batch) throw new HttpError(413, `at most ${LIMITS.batch} items per request`);
        const t = now();
        const byId = new Map();
        let rejected = 0;
        for (const raw of body.items) {
          const item = normalizeItem(raw, t);
          if (item) byId.set(item.id, item); else rejected++;
        }
        const result = await store.upsert(user.sub, [...byId.values()], t);
        meta.count = result.saved;
        return send(res, 200, { ...result, rejected });
      }
      if (method === 'DELETE') {
        const deleted = await store.deleteAll(user.sub);
        meta.count = deleted;
        return send(res, 200, { deleted });
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (pathname === '/v1/me' && method === 'GET') {
      const user = await requireUser(req);
      const stats = await store.stats(user.sub, now());
      return send(res, 200, { name: user.name, ...stats, limits: { perUser: config.perUser, ttlDays: config.ttlDays } });
    }

    if (pathname === '/auth/login' && method === 'GET') {
      const prompt = url.searchParams.get('prompt') === 'select_account' ? 'select_account' : undefined;
      const { location, setCookie } = await auth.beginLogin({ prompt });
      res.writeHead(302, { location, 'set-cookie': setCookie, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return res.end();
    }

    if (pathname === '/auth/callback' && method === 'GET') {
      try {
        const cookies = await auth.finishLogin(req, Object.fromEntries(url.searchParams));
        res.writeHead(302, { location: '/', 'set-cookie': cookies, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return res.end();
      } catch (error) {
        log(`auth callback failed: ${String(error.message).slice(0, 120)}`);
        res.writeHead(302, { location: '/?signin=failed', 'set-cookie': auth.logoutCookies(), 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return res.end();
      }
    }

    if (pathname === '/auth/logout' && method === 'POST') {
      if (req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'cross-origin request refused');
      return send(res, 200, { ok: true }, { 'set-cookie': auth.logoutCookies() });
    }

    if (pathname.startsWith('/v1/') || pathname.startsWith('/api/') || pathname.startsWith('/auth/')) throw new HttpError(404, 'not found');
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
    throw new HttpError(405, 'method not allowed');
  }

  return createServer(async (req, res) => {
    const started = now();
    const meta = { count: null };
    let url;
    try {
      url = new URL(req.url, 'http://reader.invalid');
      // Cloud Run answers on more than one hostname; keep pages (and their
      // cookies and sign-in redirects) on the configured public origin.
      if (config.canonicalHost && req.headers.host && req.headers.host !== config.canonicalHost
          && (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v1/')) {
        res.writeHead(308, { location: `${config.publicOrigin}${url.pathname}${url.search}`, ...SECURITY_HEADERS });
        return res.end();
      }
      await route(req, res, url, meta);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`error ${error && error.name}: ${String(error && error.message).slice(0, 200)}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : error.message });
      else res.end();
    } finally {
      const path = url ? url.pathname : '?';
      log(`${req.method} ${path} ${res.statusCode}${meta.count !== null ? ` n=${meta.count}` : ''} ${now() - started}ms`);
    }
  });
}
