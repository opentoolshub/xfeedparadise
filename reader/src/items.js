// Validation for uploaded posts. Only the disclosed fields are stored; the
// post URL is rebuilt from handle + id and thumbnails must be X's image CDN.

export const LIMITS = {
  batch: 50,
  perUser: 2000,
  ttlDays: 30,
  text: 4000,
  name: 100,
  pageDefault: 30,
  pageMax: 100
};

const ID_RE = /^\d{1,25}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;
const THUMB_RE = /^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9_\-./%?=&]{1,400}$/;

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  // Drop control characters except newline/tab; cap length.
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Returns a normalized item or null if it is not acceptable.
export function normalizeItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '');
  const handle = String(raw.handle ?? '');
  if (!ID_RE.test(id) || !HANDLE_RE.test(handle)) return null;
  const score = Number(raw.score);
  if (!Number.isFinite(score)) return null;
  let postedAt = toMs(raw.postedAt);
  // Reject nonsense times (before X existed or more than a day ahead).
  if (postedAt !== null && (postedAt < Date.UTC(2006, 0, 1) || postedAt > now + 86_400_000)) postedAt = null;
  const thumb = typeof raw.thumb === 'string' && THUMB_RE.test(raw.thumb) ? raw.thumb : null;
  return {
    id,
    handle,
    name: cleanText(raw.name, LIMITS.name) || handle,
    text: cleanText(raw.text, LIMITS.text),
    url: `https://x.com/${handle}/status/${id}`,
    postedAt: postedAt ?? now,
    score: Math.max(-100, Math.min(100, Math.round(score))),
    kept: raw.kept === true,
    thumb
  };
}

export function encodeCursor(item) {
  return Buffer.from(`${item.postedAt}:${item.id}`).toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return null;
  const s = Buffer.from(String(value), 'base64url').toString('utf8');
  const m = /^(\d{1,15}):(\d{1,25})$/.exec(s);
  return m ? { postedAt: Number(m[1]), id: m[2] } : undefined;
}

// Sort newest post first; ties broken by id (descending, numeric-aware).
export function compareItems(a, b) {
  if (a.postedAt !== b.postedAt) return b.postedAt - a.postedAt;
  return compareIds(b.id, a.id);
}

export function compareIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
