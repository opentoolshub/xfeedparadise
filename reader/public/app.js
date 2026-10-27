// Paradise Reader client. No third-party code, no analytics.
const $ = id => document.getElementById(id);
const app = $('app');
const feed = $('feed');
const PREFS_KEY = 'xfr-prefs';
const PAGE = 30;

const state = {
  mode: 'kept',
  minScore: -50,
  cursor: null,
  loading: false,
  done: false,
  generation: 0,
  me: null
};

try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (saved.mode === 'all' || saved.mode === 'kept') state.mode = saved.mode;
  if (Number.isInteger(saved.minScore)) state.minScore = Math.max(-50, Math.min(50, saved.minScore));
} catch { /* ignore */ }

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: state.mode, minScore: state.minScore }));
}

function reportError(message) {
  try {
    fetch('/api/frontend-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'error', message: String(message).slice(0, 300) }) });
  } catch { /* ignore */ }
}
window.addEventListener('error', e => reportError(e.message));
window.addEventListener('unhandledrejection', e => reportError(e.reason && e.reason.message));

// ---------------------------------------------------------------- formatting

function vibe(score) {
  if (score >= 50) return ['Enlightening', 'vibe-enlightening'];
  if (score >= 20) return ['Uplifting', 'vibe-uplifting'];
  if (score >= 0) return ['Neutral', 'vibe-neutral'];
  if (score >= -20) return ['Meh', 'vibe-meh'];
  if (score >= -50) return ['Negative', 'vibe-negative'];
  return ['Outrage-bait', 'vibe-outrage'];
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

// CSSOM, not a style attribute, so the strict CSP (no inline styles) allows it.
function monogram(initial, handle) {
  const node = el('div', { class: 'monogram', 'aria-hidden': 'true', text: initial });
  node.style.background = `hsl(${hue(handle)} 45% 38%)`;
  return node;
}

function card(item) {
  const [label, cls] = vibe(item.score);
  const initial = (item.name || item.handle || '?').trim().charAt(0).toUpperCase();
  const posted = new Date(item.postedAt);
  const head = el('div', { class: 'post-head' }, [
    monogram(initial, item.handle),
    el('div', { class: 'who' }, [
      el('div', { class: 'who-name', text: item.name || item.handle }),
      el('div', { class: 'who-meta' }, [
        document.createTextNode(`@${item.handle} · `),
        el('time', { datetime: posted.toISOString(), title: posted.toLocaleString(), text: ago(item.postedAt) })
      ])
    ]),
    el('span', { class: `vibe ${cls}`, title: `Vibe score ${item.score}`, text: `${label} ${item.score > 0 ? '+' : ''}${item.score}` })
  ]);
  const body = item.text ? el('p', { class: 'post-text', text: item.text }) : null;
  const thumb = item.thumb ? el('img', { class: 'post-thumb', src: item.thumb, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : null;
  const foot = el('div', { class: 'post-foot' }, [
    item.kept ? null : el('span', { class: 'tag-hidden', text: 'Hidden on X' }),
    el('a', { class: 'post-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on X ↗' })
  ]);
  if (thumb) thumb.addEventListener('error', () => thumb.remove());
  return el('li', { class: `post${item.kept ? '' : ' is-hidden'}` }, [head, body, thumb, foot]);
}

// ---------------------------------------------------------------- data

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401) {
    showSignIn();
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return { body: res.status === 204 ? null : await res.json(), cached: res.headers.get('x-reader-cache') === 'hit' };
}

function query(cursor) {
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (state.mode === 'kept') q.set('kept', 'true');
  if (state.minScore > -50) q.set('minScore', String(state.minScore));
  if (cursor) q.set('cursor', cursor);
  return `/v1/items?${q}`;
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text || '';
  s.className = `status ${kind}`;
  s.hidden = !text;
}

async function loadMore() {
  if (state.loading || state.done || app.dataset.view !== 'feed') return;
  state.loading = true;
  const gen = state.generation;
  $('moreSpinner').hidden = false;
  try {
    const { body, cached } = await api(query(state.cursor));
    if (gen !== state.generation) return;
    if (!state.cursor) feed.replaceChildren();
    for (const item of body.items) feed.append(card(item));
    state.cursor = body.nextCursor;
    state.done = !body.nextCursor;
    $('empty').hidden = feed.children.length > 0;
    if (state.mode === 'kept' || state.minScore > -50) {
      $('emptyText').textContent = 'No posts match these filters yet. Try Everything or lower the minimum vibe.';
    }
    setStatus(cached ? 'Offline. Showing the last page you loaded.' : '');
  } catch (error) {
    if (error.message !== 'signed out') setStatus(navigator.onLine ? 'Could not load posts. Pull down to try again.' : 'You are offline.', 'error');
    state.done = true;
  } finally {
    if (gen === state.generation) state.loading = false;
    $('moreSpinner').hidden = true;
  }
}

async function refresh() {
  state.generation++;
  state.cursor = null;
  state.done = false;
  state.loading = false;
  window.scrollTo({ top: 0 });
  await loadMore();
  loadMe();
}

async function loadMe() {
  try {
    const { body } = await api('/v1/me');
    state.me = body;
    $('accountInitial').textContent = (body.name || '?').trim().charAt(0).toUpperCase() || '?';
    $('accountName').textContent = body.name ? `Signed in as ${body.name}` : 'Signed in';
    $('accountStats').textContent = `${body.count.toLocaleString()} saved post${body.count === 1 ? '' : 's'}${body.lastSavedAt ? ` · last sync ${ago(body.lastSavedAt)} ago` : ''}`.replace('now ago', 'just now');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- views

function showSignIn() {
  app.dataset.view = 'signin';
  $('signin').hidden = false;
  for (const id of ['controls', 'accountBtn', 'footer', 'empty', 'status']) $(id).hidden = true;
  feed.replaceChildren();
  if (new URLSearchParams(location.search).get('signin') === 'failed') {
    $('signinNotice').textContent = 'Sign-in did not finish. Please try again.';
    $('signinNotice').hidden = false;
  }
}

function showFeed() {
  app.dataset.view = 'feed';
  $('signin').hidden = true;
  for (const id of ['controls', 'accountBtn', 'footer']) $(id).hidden = false;
  if (location.search) history.replaceState(null, '', '/');
}

function renderControls() {
  for (const b of document.querySelectorAll('.seg')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  $('threshold').value = String(state.minScore);
  $('thresholdValue').textContent = state.minScore <= -50 ? 'Any' : `≥ ${state.minScore > 0 ? '+' : ''}${state.minScore}`;
}

async function clearCachedData() {
  if ('caches' in window) await caches.delete('xfr-data').catch(() => {});
}

// ---------------------------------------------------------------- events

for (const b of document.querySelectorAll('.seg')) {
  b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode;
    savePrefs();
    renderControls();
    refresh();
  });
}

let sliderTimer = null;
$('threshold').addEventListener('input', e => {
  state.minScore = Number(e.target.value);
  renderControls();
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => { savePrefs(); refresh(); }, 250);
});

$('accountBtn').addEventListener('click', () => { loadMe(); $('accountSheet').showModal(); });
for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
}
$('refreshBtn').addEventListener('click', () => { $('accountSheet').close(); refresh(); });
$('signoutBtn').addEventListener('click', async () => {
  $('accountSheet').close();
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  await clearCachedData();
  showSignIn();
  $('signinBtn').href = '/auth/login?prompt=select_account';
});
$('deleteBtn').addEventListener('click', () => { $('accountSheet').close(); $('deleteSheet').showModal(); });
$('confirmDeleteBtn').addEventListener('click', async () => {
  const btn = $('confirmDeleteBtn');
  btn.disabled = true;
  try {
    const { body } = await api('/v1/items', { method: 'DELETE' });
    await clearCachedData();
    $('deleteSheet').close();
    setStatus(`Deleted ${body.deleted.toLocaleString()} post${body.deleted === 1 ? '' : 's'}.`);
    feed.replaceChildren();
    $('empty').hidden = false;
    state.done = true;
    loadMe();
  } catch {
    setStatus('Delete failed. Please try again.', 'error');
    $('deleteSheet').close();
  } finally {
    btn.disabled = false;
  }
});

// Infinite scroll
new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting)) loadMore();
}, { rootMargin: '600px 0px' }).observe($('sentinel'));

// Pull to refresh (touch)
(() => {
  const ptr = $('ptr');
  const text = $('ptrText');
  const THRESHOLD = 70;
  let startY = null;
  let pull = 0;
  window.addEventListener('touchstart', e => {
    if (window.scrollY > 0 || app.dataset.view !== 'feed' || document.querySelector('dialog[open]')) return;
    startY = e.touches[0].clientY;
    pull = 0;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (startY === null) return;
    pull = Math.max(0, Math.min(120, (e.touches[0].clientY - startY) * 0.5));
    ptr.classList.add('dragging');
    ptr.style.height = `${pull}px`;
    text.textContent = pull >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    ptr.classList.remove('dragging');
    if (pull >= THRESHOLD) {
      ptr.style.height = '44px';
      ptr.classList.add('loading');
      text.textContent = 'Refreshing';
      await refresh();
      ptr.classList.remove('loading');
    }
    ptr.style.height = '0px';
  });
})();

// ---------------------------------------------------------------- start

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderControls();
(async () => {
  if (await loadMe()) {
    showFeed();
    loadMore();
  } else if (app.dataset.view !== 'signin') {
    // Offline with nothing cached, or a server error.
    showSignIn();
  }
})();
