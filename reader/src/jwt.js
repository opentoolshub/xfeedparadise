// JWT verification against an OIDC issuer's JWKS, using only node:crypto.
// Ideaflow ID signs with EdDSA (Ed25519); RS256 and ES256 are accepted too so
// a key-type change at the issuer does not break sign-in.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const ALGS = {
  EdDSA: { hash: null },
  RS256: { hash: 'sha256' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' }
};

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

function b64urlJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed token');
  }
}

export function decodeJwt(token) {
  if (typeof token !== 'string' || token.length > 8192) throw new TokenError('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('malformed token');
  return { header: b64urlJson(parts[0]), payload: b64urlJson(parts[1]), parts };
}

// Caches the issuer's keys; refetches at most every `minRefetchMs` when a
// token names an unknown key id (key rotation).
export function createJwks({ jwksUri, fetchImpl = fetch, ttlMs = 10 * 60_000, minRefetchMs = 30_000, now = Date.now }) {
  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null;

  async function refresh() {
    if (!inflight) {
      inflight = (async () => {
        const res = await fetchImpl(await jwksUri(), { headers: { accept: 'application/json' } });
        if (!res.ok) throw new TokenError(`jwks fetch failed (${res.status})`);
        const body = await res.json();
        const next = new Map();
        for (const jwk of body.keys || []) {
          try {
            next.set(jwk.kid || '', { jwk, key: createPublicKey({ key: jwk, format: 'jwk' }) });
          } catch {
            // Skip keys node cannot import.
          }
        }
        keys = next;
        fetchedAt = now();
      })().finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    async get(kid) {
      const age = now() - fetchedAt;
      if (!fetchedAt || age > ttlMs) await refresh();
      let entry = keys.get(kid || '') || (!kid && keys.size === 1 ? [...keys.values()][0] : null);
      if (!entry && age > minRefetchMs) {
        await refresh();
        entry = keys.get(kid || '');
      }
      if (!entry) throw new TokenError('unknown signing key');
      return entry;
    }
  };
}

// Verifies signature, issuer, audience, expiry. Returns the payload.
export async function verifyJwt(token, { jwks, issuer, audiences, now = Date.now, skewSec = 60, nonce }) {
  const { header, payload, parts } = decodeJwt(token);
  const alg = ALGS[header.alg];
  if (!alg) throw new TokenError('unsupported alg');
  const { key, jwk } = await jwks.get(header.kid);
  if (jwk.alg && jwk.alg !== header.alg) throw new TokenError('alg mismatch');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  const keyArg = alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key;
  let ok = false;
  try {
    ok = cryptoVerify(alg.hash, data, keyArg, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new TokenError('bad signature');

  const nowSec = Math.floor(now() / 1000);
  if (payload.iss !== issuer) throw new TokenError('wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const matched = aud.find(a => audiences.includes(a));
  if (!matched) throw new TokenError('wrong audience');
  if (aud.length > 1 && payload.azp && !audiences.includes(payload.azp)) throw new TokenError('wrong azp');
  if (typeof payload.exp !== 'number' || payload.exp + skewSec < nowSec) throw new TokenError('expired');
  if (typeof payload.nbf === 'number' && payload.nbf - skewSec > nowSec) throw new TokenError('not yet valid');
  if (typeof payload.iat === 'number' && payload.iat - skewSec > nowSec) throw new TokenError('issued in the future');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new TokenError('missing subject');
  if (nonce !== undefined && payload.nonce !== nonce) throw new TokenError('nonce mismatch');
  return { ...payload, matchedAudience: matched };
}
