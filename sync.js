// XFeed Paradise - Paradise Reader sync (opt-in, off by default).
//
// When the user turns on "Paradise Reader (phone)" in the popup AND signs in
// with Ideaflow, the background worker uploads the X posts the extension
// scored to the user's private reader, so they can browse the pre-filtered
// feed on their phone. Nothing is uploaded while the feature is off or the
// user is signed out. Google News items are never uploaded.
//
// Fields sent per post: id, author handle and display name, text, post time,
// vibe score, kept/hidden, and an X image-CDN thumbnail URL. The server
// rebuilds the post URL from handle + id.
//
// Loaded by background.js (service worker). Exposes globalThis.XFPReaderSync.
(function (root) {
  'use strict';

  const DEFAULT_READER_ORIGIN = 'https://xfeed-reader-874749606899.us-central1.run.app';
  const KEYS = {
    state: 'xfpReader',        // { optIn, account, syncedTotal, lastSyncAt, lastError }
    auth: 'xfpReaderAuth',     // { idToken, refreshToken, exp }
    queue: 'xfpReaderQueue',   // pending posts (bounded)
    origin: 'xfpReaderOrigin'  // optional override of the reader URL (development)
  };
  const BATCH = 50;
  const QUEUE_MAX = 500;
  const DEBOUNCE_MS = 8000;
  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_MAX_MS = 10 * 60 * 1000;
  const REFRESH_EARLY_SEC = 300;
  const SCOPE = 'openid profile email offline_access';

  const ID_RE = /^\d{1,25}$/;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;
  const THUMB_RE = /^https:\/\/pbs\.twimg\.com\//;

  // Content-script payload -> upload item, or null if it is not a real post.
  function toItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    const handle = String(raw.handle || '');
    const score = Number(raw.score);
    if (!ID_RE.test(id) || !HANDLE_RE.test(handle) || !Number.isFinite(score)) return null;
    const postedAt = Number(raw.postedAt);
    return {
      id,
      handle,
      name: String(raw.name || handle).slice(0, 100),
      text: String(raw.text || '').slice(0, 4000),
      postedAt: Number.isFinite(postedAt) ? postedAt : Date.now(),
      score: Math.max(-100, Math.min(100, Math.round(score))),
      kept: raw.kept === true,
      thumb: typeof raw.thumb === 'string' && THUMB_RE.test(raw.thumb) ? raw.thumb.slice(0, 400) : null
    };
  }

  function b64urlBytes(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeJwtPayload(token) {
    try {
      const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(Array.from(atob(part), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  function createReaderSync(deps = {}) {
    const chrome = deps.chrome || root.chrome;
    const fetchImpl = deps.fetch || ((...a) => root.fetch(...a));
    const now = deps.now || (() => Date.now());
    const setTimer = deps.setTimeout || ((fn, ms) => root.setTimeout(fn, ms));
    const clearTimer = deps.clearTimeout || (t => root.clearTimeout(t));
    const cryptoImpl = deps.crypto || root.crypto;
    const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    const local = chrome.storage.local;

    let queue = null; // Map id -> item, loaded lazily from storage
    let timer = null;
    let failures = 0;
    let retryAt = 0;
    let flushing = null;
    let configCache = null;

    const randomString = (n = 32) => b64urlBytes(cryptoImpl.getRandomValues(new Uint8Array(n)));

    async function getState() {
      const r = await local.get(KEYS.state);
      return { optIn: false, account: null, syncedTotal: 0, lastSyncAt: null, lastError: null, ...(r[KEYS.state] || {}) };
    }
    async function setState(patch) {
      const next = { ...(await getState()), ...patch };
      await local.set({ [KEYS.state]: next });
      return next;
    }
    async function getAuth() {
      return (await local.get(KEYS.auth))[KEYS.auth] || null;
    }
    async function readerOrigin() {
      const r = await local.get(KEYS.origin);
      return (r[KEYS.origin] || DEFAULT_READER_ORIGIN).replace(/\/$/, '');
    }
    async function active() {
      const [state, auth] = await Promise.all([getState(), getAuth()]);
      return Boolean(state.optIn && state.account && auth && auth.idToken);
    }

    async function loadQueue() {
      if (queue) return queue;
      const stored = (await local.get(KEYS.queue))[KEYS.queue];
      queue = new Map(Array.isArray(stored) ? stored.map(item => [item.id, item]) : []);
      return queue;
    }
    async function saveQueue() {
      await local.set({ [KEYS.queue]: [...queue.values()] });
    }
    async function clearQueue() {
      queue = new Map();
      if (timer) clearTimer(timer);
      timer = null;
      await local.remove(KEYS.queue);
    }

    function schedule(delay = debounceMs) {
      if (timer) return;
      const wait = Math.max(delay, retryAt - now());
      timer = setTimer(() => {
        timer = null;
        flush().catch(() => {});
      }, wait);
    }

    // Accepts posts from the content script. Dropped unless opted in + signed in.
    async function enqueue(rawItems) {
      if (!(await active())) return { queued: 0 };
      const q = await loadQueue();
      let queued = 0;
      for (const raw of [].concat(rawItems)) {
        const item = toItem(raw);
        if (!item) continue;
        q.delete(item.id); // re-insert so the newest score wins and order is recent-last
        q.set(item.id, item);
        queued++;
      }
      while (q.size > QUEUE_MAX) q.delete(q.keys().next().value);
      await saveQueue();
      if (queued) schedule();
      return { queued };
    }

    async function readerConfig() {
      if (configCache) return configCache;
      const res = await fetchImpl(`${await readerOrigin()}/api/config`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`reader config failed (${res.status})`);
      configCache = await res.json();
      return configCache;
    }

    async function discovery(issuer) {
      const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`sign-in service unavailable (${res.status})`);
      const doc = await res.json();
      if (doc.issuer !== issuer) throw new Error('sign-in issuer mismatch');
      return doc;
    }

    async function storeTokens(tokens, { clientId, issuer, nonce }) {
      const claims = decodeJwtPayload(tokens.id_token);
      if (!claims || claims.iss !== issuer) throw new Error('unexpected token issuer');
      const aud = [].concat(claims.aud);
      if (!aud.includes(clientId)) throw new Error('unexpected token audience');
      if (nonce !== undefined && claims.nonce !== nonce) throw new Error('sign-in nonce mismatch');
      const previous = await getAuth();
      await local.set({ [KEYS.auth]: {
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token || (previous && previous.refreshToken) || null,
        exp: claims.exp
      } });
      return claims;
    }

    async function refreshTokens() {
      const auth = await getAuth();
      if (!auth || !auth.refreshToken) return false;
      try {
        const cfg = await readerConfig();
        const d = await discovery(cfg.issuer);
        const res = await fetchImpl(d.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: cfg.extensionClientId }).toString()
        });
        if (!res.ok) return false;
        await storeTokens(await res.json(), { clientId: cfg.extensionClientId, issuer: cfg.issuer });
        return true;
      } catch {
        return false;
      }
    }

    async function validToken() {
      const auth = await getAuth();
      if (!auth || !auth.idToken) return null;
      if (auth.exp && auth.exp - REFRESH_EARLY_SEC <= now() / 1000) {
        if (!(await refreshTokens())) return null;
        return (await getAuth()).idToken;
      }
      return auth.idToken;
    }

    async function signedOut(message) {
      await local.remove(KEYS.auth);
      await clearQueue();
      await setState({ account: null, lastError: message || null });
    }

    async function upload(items, token) {
      return fetchImpl(`${await readerOrigin()}/v1/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ items })
      });
    }

    async function flushOnce() {
      if (!(await active())) {
        await clearQueue();
        return;
      }
      const q = await loadQueue();
      while (q.size > 0) {
        if (now() < retryAt) {
          schedule(0);
          return;
        }
        let token = await validToken();
        if (!token) {
          await signedOut('Sign-in expired. Sign in again to keep syncing.');
          return;
        }
        const batch = [...q.values()].slice(0, BATCH);
        let res;
        try {
          res = await upload(batch, token);
          if (res.status === 401 && (await refreshTokens())) {
            token = (await getAuth()).idToken;
            res = await upload(batch, token);
          }
        } catch {
          res = null;
        }
        if (res && res.status === 401) {
          await signedOut('Sign-in expired. Sign in again to keep syncing.');
          return;
        }
        if (!res || !res.ok) {
          failures++;
          const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
          retryAt = now() + delay;
          const status = res ? res.status : 'network';
          await setState({ lastError: status === 429 ? 'Reader is busy; retrying shortly.' : `Upload failed (${status}); retrying.` });
          schedule(delay);
          return;
        }
        const body = await res.json().catch(() => ({}));
        for (const item of batch) {
          // Keep an item re-scored while the request was in flight.
          if (q.get(item.id) === item) q.delete(item.id);
        }
        await saveQueue();
        failures = 0;
        retryAt = 0;
        await setState({ syncedTotal: Number(body.total) || 0, lastSyncAt: now(), lastError: null });
      }
    }

    function flush() {
      if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
      return flushing;
    }

    async function signIn() {
      configCache = null;
      const cfg = await readerConfig();
      if (!cfg.extensionClientId) throw new Error('Sign-in is not set up on the reader yet.');
      const d = await discovery(cfg.issuer);
      const redirectUri = chrome.identity.getRedirectURL();
      const state = randomString();
      const nonce = randomString();
      const verifier = randomString(48);
      const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.extensionClientId,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: b64urlBytes(digest),
        code_challenge_method: 'S256'
      }).toString();
      const responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
      const back = new URL(responseUrl);
      if (back.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted. Please try again.');
      if (back.searchParams.get('error')) throw new Error('Sign-in was cancelled.');
      const iss = back.searchParams.get('iss');
      if (iss && iss !== cfg.issuer) throw new Error('Sign-in issuer mismatch.');
      const res = await fetchImpl(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code') || '',
          redirect_uri: redirectUri,
          client_id: cfg.extensionClientId,
          code_verifier: verifier
        }).toString()
      });
      if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
      const claims = await storeTokens(await res.json(), { clientId: cfg.extensionClientId, issuer: cfg.issuer, nonce });
      return setState({ account: { name: claims.name || null, email: claims.email || null }, lastError: null });
    }

    async function signOut() {
      const auth = await getAuth();
      if (auth && auth.refreshToken) {
        try {
          const cfg = await readerConfig();
          const d = await discovery(cfg.issuer);
          if (d.revocation_endpoint) {
            await fetchImpl(d.revocation_endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: auth.refreshToken, token_type_hint: 'refresh_token', client_id: cfg.extensionClientId }).toString()
            });
          }
        } catch {
          // Best effort; local tokens are removed regardless.
        }
      }
      await signedOut(null);
      return getState();
    }

    async function setOptIn(on) {
      const state = await setState({ optIn: Boolean(on), lastError: null });
      if (!on) await clearQueue();
      return state;
    }

    async function deleteAll() {
      const token = await validToken();
      if (!token) throw new Error('Sign in first.');
      const res = await fetchImpl(`${await readerOrigin()}/v1/items`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
      const body = await res.json();
      await clearQueue();
      await setState({ syncedTotal: 0, lastSyncAt: null });
      return body.deleted;
    }

    async function status() {
      const [state, auth, q, origin] = await Promise.all([getState(), getAuth(), loadQueue(), readerOrigin()]);
      return { ...state, signedIn: Boolean(auth && auth.idToken && state.account), pending: q.size, readerUrl: origin };
    }

    // Resume a queue persisted before the worker was stopped.
    async function resume() {
      if ((await loadQueue()).size > 0) schedule(0);
    }

    function handleMessage(message, sendResponse) {
      const reply = promise => {
        promise.then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: String(error && error.message || error) }));
        return true;
      };
      switch (message && message.type) {
        case 'XFP_READER_ITEM': return reply(enqueue(message.item));
        case 'XFP_READER_STATUS': return reply(status());
        case 'XFP_READER_SET_OPT_IN': return reply(setOptIn(message.on));
        case 'XFP_READER_SIGN_IN': return reply(signIn());
        case 'XFP_READER_SIGN_OUT': return reply(signOut());
        case 'XFP_READER_DELETE_ALL': return reply(deleteAll());
        case 'XFP_READER_FLUSH': return reply(flush());
        default: return undefined;
      }
    }

    return { enqueue, flush, signIn, signOut, setOptIn, deleteAll, status, resume, handleMessage };
  }

  root.XFPReaderSync = { KEYS, BATCH, DEFAULT_READER_ORIGIN, toItem, decodeJwtPayload, createReaderSync };
})(globalThis);
