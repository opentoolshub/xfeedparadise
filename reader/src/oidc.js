// "Sign in with Ideaflow" for the reader web app (Authorization Code + S256
// PKCE, confidential client, server-side code exchange), plus the reader's
// own signed session cookie. The issuer's token endpoint has no CORS, so the
// browser never talks to it directly.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createJwks, verifyJwt } from './jwt.js';

const b64url = buf => Buffer.from(buf).toString('base64url');
const random = (n = 32) => b64url(randomBytes(n));

export function createDiscovery({ issuer, fetchImpl = fetch }) {
  let doc = null;
  return async function discovery() {
    if (doc) return doc;
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const body = await res.json();
    if (body.issuer !== issuer) throw new Error('OIDC discovery issuer mismatch');
    doc = body;
    return doc;
  };
}

// HMAC-signed, expiring cookie values: base64url(json).signature
export function createSigner(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const mac = data => createHmac('sha256', secret).update(data).digest('base64url');
  return {
    sign(obj) {
      const data = b64url(JSON.stringify(obj));
      return `${data}.${mac(data)}`;
    },
    verify(value, now = Date.now()) {
      if (typeof value !== 'string' || value.length > 4096) return null;
      const [data, sig] = value.split('.');
      if (!data || !sig) return null;
      const expected = Buffer.from(mac(data));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const obj = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        if (typeof obj.exp !== 'number' || obj.exp < now) return null;
        return obj;
      } catch {
        return null;
      }
    }
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const discovery = createDiscovery({ issuer: config.issuer, fetchImpl });
  const jwks = createJwks({ jwksUri: async () => (await discovery()).jwks_uri, fetchImpl, now });
  const signer = createSigner(config.sessionSecret);
  const secure = config.publicOrigin.startsWith('https://');
  const names = {
    session: secure ? '__Host-xfr_session' : 'xfr_session',
    flow: secure ? '__Host-xfr_flow' : 'xfr_flow'
  };
  const bearerAudiences = [...config.extensionClientIds, ...(config.webClientId ? [config.webClientId] : [])];
  const redirectUri = `${config.publicOrigin}/auth/callback`;

  function cookie(name, value, maxAgeSec) {
    return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
      `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
  }

  return {
    names,
    redirectUri,

    // Bearer ID token (extension) -> user, or throws TokenError.
    async verifyBearer(token) {
      const claims = await verifyJwt(token, { jwks, issuer: config.issuer, audiences: bearerAudiences, now });
      return { sub: claims.sub, name: claims.name || null, via: 'bearer' };
    },

    session(req) {
      const value = parseCookies(req.headers.cookie)[names.session];
      const s = value ? signer.verify(value, now()) : null;
      return s ? { sub: s.sub, name: s.name || null, via: 'cookie' } : null;
    },

    async beginLogin({ prompt } = {}) {
      if (!config.webClientId) throw new Error('reader web client is not configured');
      const d = await discovery();
      const state = random();
      const nonce = random();
      const verifier = random(48);
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.webClientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(prompt ? { prompt } : {})
      }).toString();
      const flow = signer.sign({ state, nonce, verifier, exp: now() + 10 * 60_000 });
      return { location: url.toString(), setCookie: cookie(names.flow, flow, 600) };
    },

    async finishLogin(req, query) {
      const flow = signer.verify(parseCookies(req.headers.cookie)[names.flow], now());
      if (!flow) throw new Error('sign-in expired; start again');
      if (!query.state || query.state !== flow.state) throw new Error('state mismatch');
      if (query.error) throw new Error(`provider error: ${String(query.error).slice(0, 60)}`);
      if (!query.code) throw new Error('missing code');
      const d = await discovery();
      if (query.iss && query.iss !== config.issuer) throw new Error('issuer mismatch');
      const basic = Buffer.from(`${encodeURIComponent(config.webClientId)}:${encodeURIComponent(config.webClientSecret || '')}`).toString('base64');
      const res = await fetchImpl(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, code_verifier: flow.verifier }).toString()
      });
      if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
      const tokens = await res.json();
      if (!tokens.id_token) throw new Error('no id_token');
      const claims = await verifyJwt(tokens.id_token, {
        jwks, issuer: config.issuer, audiences: [config.webClientId], now, nonce: flow.nonce
      });
      const sessionDays = config.sessionDays;
      const session = signer.sign({ sub: claims.sub, name: claims.name || null, exp: now() + sessionDays * 86_400_000 });
      return [cookie(names.session, session, sessionDays * 86_400), cookie(names.flow, '', 0)];
    },

    logoutCookies() {
      return [cookie(names.session, '', 0), cookie(names.flow, '', 0)];
    }
  };
}
