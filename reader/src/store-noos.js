// No graph credentials reach the extension or phone. The reader verifies OIDC,
// then signs a short, owner/op/body-bound assertion for Noos' dedicated route.
import { createHash, createHmac } from 'node:crypto';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function createNoosStore({ baseUrl, secret, issuer, fetchImpl = fetch, now = Date.now }) {
  const url = new URL(baseUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !/^https:\/\//.test(issuer) || !secret || secret.length < 32) throw Error('Explicit secure Noos archive configuration required');
  const base = baseUrl.replace(/\/$/, '');
  async function call(sub, op, data) {
    if (typeof sub !== 'string' || !sub || sub.length > 512) throw Error('Verified subject required');
    const body = JSON.stringify(data);
    const iat = Math.floor(now() / 1000);
    const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'paradise-reader', aud: 'noos-paradise-store', sub, owner_iss: issuer, op, bodyHash: createHash('sha256').update(body).digest('hex'), iat, exp: iat + 60 })}`;
    const token = `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
    const res = await fetchImpl(`${base}/${op}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    if (!res.ok) throw Error(`Noos archive unavailable (${res.status})`);
    return res.json();
  }
  return { kind: 'noos', archive: true, async init() {}, async close() {}, async sweep() { return 0; },
    upsert: (sub, items) => call(sub, 'upsert', { items }),
    list: (sub, options = {}) => call(sub, 'list', options),
    stats: sub => call(sub, 'stats', {}),
    async deleteAll(sub) { return (await call(sub, 'deleteAll', {})).deleted; }
  };
}
