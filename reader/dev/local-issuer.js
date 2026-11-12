// A tiny local OIDC issuer for tests and local end-to-end runs. NOT for
// production. Signs EdDSA (Ed25519) ID tokens like Ideaflow ID, serves
// discovery + JWKS, auto-approves /authorize for a fixed test user, checks
// PKCE at /token, and exposes POST /dev/mint to hand a test token to the
// extension. Run: node dev/local-issuer.js --port 7xxx
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

const b64url = v => Buffer.from(v).toString('base64url');

export async function startTestIssuer({ port = 0, clients = {}, user = { sub: 'user-a', name: 'Test Reader', email: 'reader@example.test' }, idTokenTtlSec = 3600 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'EdDSA', use: 'sig' };
  const codes = new Map();
  const refresh = new Map();
  let issuer = '';
  const state = { user, clients, calls: { token: 0, jwks: 0 } };

  function mint(claims = {}, { key = privateKey, kid = 'test-key', alg = 'EdDSA' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iss: issuer, sub: state.user.sub, name: state.user.name, email: state.user.email, iat: now, exp: now + idTokenTtlSec, ...claims }));
    const sig = sign(null, Buffer.from(`${header}.${payload}`), key);
    return `${header}.${payload}.${b64url(sig)}`;
  }

  // Dev-only CORS so an unpacked extension can complete sign-in against this
  // issuer without extra host permissions. (Ideaflow ID itself has none.)
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST' });
      return res.end();
    }
    const path = url.pathname.replace(/^\/api\/auth/, '');
    if (path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/oauth2/revoke`,
        code_challenge_methods_supported: ['S256']
      });
    }
    if (path === '/jwks') {
      state.calls.jwks++;
      return json(res, 200, { keys: [jwk] });
    }
    if (path === '/oauth2/authorize') {
      const q = Object.fromEntries(url.searchParams);
      const client = state.clients[q.client_id];
      if (!client || !client.redirectUris.includes(q.redirect_uri)) return json(res, 400, { error: 'invalid_client' });
      if (q.code_challenge_method !== 'S256' || !q.code_challenge) return json(res, 400, { error: 'pkce_required' });
      const code = b64url(randomBytes(16));
      codes.set(code, { ...q });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state || '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === '/oauth2/token' && req.method === 'POST') {
      state.calls.token++;
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      let clientId = form.client_id;
      let secret = form.client_secret;
      const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      if (basic) {
        const [id, s] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
        clientId = id;
        secret = s;
      }
      const client = state.clients[clientId];
      if (!client || (client.secret && client.secret !== secret)) return json(res, 401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        const entry = codes.get(form.code);
        codes.delete(form.code);
        if (!entry || entry.client_id !== clientId || entry.redirect_uri !== form.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
        const challenge = b64url(createHash('sha256').update(form.code_verifier || '').digest());
        if (challenge !== entry.code_challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
        const rt = (entry.scope || '').includes('offline_access') ? b64url(randomBytes(16)) : undefined;
        if (rt) refresh.set(rt, clientId);
        return json(res, 200, { access_token: b64url(randomBytes(16)), token_type: 'Bearer', expires_in: 3600, id_token: mint({ aud: clientId, azp: clientId, nonce: entry.nonce }), refresh_token: rt });
      }
      if (form.grant_type === 'refresh_token') {
        if (refresh.get(form.refresh_token) !== clientId) return json(res, 400, { error: 'invalid_grant' });
        refresh.delete(form.refresh_token);
        const rt = b64url(randomBytes(16));
        refresh.set(rt, clientId);
        return json(res, 200, { access_token: b64url(randomBytes(16)), token_type: 'Bearer', expires_in: 3600, id_token: mint({ aud: clientId, azp: clientId }), refresh_token: rt });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (path === '/oauth2/revoke' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      refresh.delete(form.token);
      return json(res, 200, {});
    }
    if (path === '/dev/mint' && req.method === 'POST') {
      const claims = JSON.parse((await body(req)) || '{}');
      const rt = b64url(randomBytes(16));
      if (claims.aud) refresh.set(rt, claims.aud);
      return json(res, 200, { id_token: mint({ azp: claims.aud, ...claims }), refresh_token: rt });
    }
    json(res, 404, { error: 'not_found' });
  });

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  issuer = `${base}/api/auth`;
  return {
    issuer,
    base,
    mint,
    state,
    setUser(u) { state.user = u; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

// CLI: node dev/local-issuer.js --port 7123 [--sub S --name N] --client id[:secret]=redirect1,redirect2 ...
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let port = 0;
  const clients = {};
  const user = { sub: 'user-a', name: 'Test Reader', email: 'reader@example.test' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--sub') user.sub = args[++i];
    else if (args[i] === '--name') user.name = args[++i];
    else if (args[i] === '--client') {
      const [idPart, redirects] = args[++i].split('=');
      const [id, secret] = idPart.split(':');
      clients[id] = { secret: secret || null, redirectUris: redirects.split(',') };
    }
  }
  const issuer = await startTestIssuer({ port, clients, user });
  console.log(JSON.stringify({ issuer: issuer.issuer }));
}
