// Import the sanitized x-saved snapshot produced by Bloomscroll's existing
// owner-checked Bird workflow. Does not read cookies, mutate X, or infer removals.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeItem } from './src/items.js';

export function bookmarkItems(snapshot) {
  if (snapshot?.source !== 'x-saved' || snapshot.mode !== 'snapshot' || !Array.isArray(snapshot.rows) || snapshot.rows.length > 100000) throw Error('Expected a normalized x-saved snapshot');
  return snapshot.rows.map(row => {
    if (row.source !== 'x-saved' || !/^\d{1,25}$/.test(row.sourceId) || typeof row.sourceId !== 'string' || typeof row.body !== 'string') throw Error('Invalid bookmark row');
    const stamp = typeof row.createdAt === 'number' ? row.createdAt : Date.parse(row.createdAt);
    if (!Number.isFinite(stamp) || stamp < Date.UTC(2006, 0, 1) || stamp > Date.now() + 86400000) throw Error('Invalid bookmark time');
    const media = (row.xContent?.media || []).slice(0, 4).filter(m => ['photo','video'].includes(m.type) && typeof m.url === 'string' && /^https:\/\/(pbs|video)\.twimg\.com\//.test(m.url)).map(m => ({ type: m.type, url: m.url.slice(0, 500) }));
    const item = normalizeItem({ id: row.sourceId, handle: row.xContent?.author?.handle || 'unknown', name: row.xContent?.author?.name || 'Unknown author', text: row.body,
      postedAt: stamp, score: null, kept: null, saved: true, sources: ['x-bookmarks'],
      thumb: row.xContent?.media?.find(m => m.type === 'photo')?.url || null,
      context: JSON.stringify({ quoteText: typeof row.xContent?.quote?.body === 'string' ? row.xContent.quote.body.slice(0, 6000) : null, media }) });
    if (!item) throw Error('Invalid bookmark row');
    return item;
  });
}

export async function importBookmarks({ snapshot, readerUrl, token, fetchImpl = fetch }) {
  const url = new URL(readerUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('An HTTPS reader origin is required');
  if (!token) throw Error('PARADISE_ID_TOKEN is required');
  const items = bookmarkItems(snapshot); // Validate the entire file before writing.
  let imported = 0;
  for (let i = 0; i < items.length;) {
    const batch = [];
    let bytes = 20;
    for (const item of items.slice(i, i + 50)) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (batch.length && bytes + size > 2500000) break;
      batch.push(item); bytes += size;
    }
    let response;
    try { response = await fetchImpl(`${url.origin}/v1/items`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ items: batch }) }); }
    catch { return { status: 'partial', imported, remaining: items.length - imported, uncertainBatch: true }; }
    if (!response.ok) return { status: 'partial', imported, remaining: items.length - imported, httpStatus: response.status };
    const result = await response.json();
    if (result.rejected) return { status: 'partial', imported, remaining: items.length - imported, rejected: result.rejected };
    imported += batch.length;
    i += batch.length;
  }
  return { status: 'imported', imported, remaining: 0, sourceComplete: snapshot.complete === true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = await importBookmarks({ snapshot, readerUrl: process.argv[3], token: process.env.PARADISE_ID_TOKEN });
    console.log(JSON.stringify(result));
    if (result.status !== 'imported') process.exitCode = 1;
  } catch {
    console.error('Bookmark import failed; verify the normalized snapshot, reader origin and local sign-in token.');
    process.exitCode = 1;
  }
}
