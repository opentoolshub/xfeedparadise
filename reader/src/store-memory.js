// In-memory store with the same contract as store-pg.js. Used by tests and
// by local runs without DATABASE_URL. Data is lost on restart.
import { LIMITS, compareIds, compareItems, decodeCursor, encodeCursor } from './items.js';

export function createMemoryStore({ perUser = LIMITS.perUser, ttlDays = LIMITS.ttlDays, archive = false } = {}) {
  const users = new Map(); // sub -> Map(id -> row)
  const ttlMs = ttlDays * 86_400_000;
  const live = (row, now) => archive || row.savedAt > now - ttlMs;

  function rows(sub) {
    if (!users.has(sub)) users.set(sub, new Map());
    return users.get(sub);
  }

  function enforce(sub, now) {
    const map = rows(sub);
    for (const [id, row] of map) if (!live(row, now)) map.delete(id);
    if (!archive && map.size > perUser) {
      const order = [...map.values()].sort((a, b) => (b.savedAt - a.savedAt) || compareIds(b.id, a.id));
      for (const row of order.slice(perUser)) map.delete(row.id);
    }
  }

  return {
    kind: 'memory',
    archive,
    async init() {},
    async close() {},
    async upsert(sub, items, now = Date.now()) {
      const map = rows(sub);
      for (const item of items) {
        const prev = map.get(item.id);
        const observations = [...(prev?.observations || [])];
        if (!observations.some(x => JSON.stringify(x) === JSON.stringify(item))) observations.push(item);
        const next = { ...item, savedAt: now, saved: item.saved || prev?.saved === true,
          sources: [...new Set([...(prev?.sources || []), ...(item.sources || [])])], observations };
        if (item.score === null && prev?.score != null) Object.assign(next, { score: prev.score, kept: prev.kept, policy: prev.policy });
        map.set(item.id, next);
      }
      enforce(sub, now);
      return { saved: items.length, total: map.size };
    },
    async list(sub, { minScore = null, kept = null, saved = null, cursor = null, limit = LIMITS.pageDefault } = {}, now = Date.now()) {
      const after = decodeCursor(cursor);
      const out = [...rows(sub).values()]
        .filter(r => live(r, now))
        .filter(r => minScore === null || r.score >= minScore)
        .filter(r => kept === null || r.kept === kept)
        .filter(r => saved === null || r.saved === saved)
        .filter(r => !after || compareItems(r, after) > 0)
        .sort(compareItems)
        .slice(0, limit + 1);
      const page = out.slice(0, limit);
      return { items: page, nextCursor: out.length > limit ? encodeCursor(page[page.length - 1]) : null };
    },
    async deleteAll(sub) {
      const n = users.get(sub)?.size || 0;
      users.delete(sub);
      return n;
    },
    async stats(sub, now = Date.now()) {
      const list = [...rows(sub).values()].filter(r => live(r, now));
      return { count: list.length, lastSavedAt: list.length ? Math.max(...list.map(r => r.savedAt)) : null };
    },
    async sweep(now = Date.now()) {
      let n = 0;
      for (const map of users.values()) {
        for (const [id, row] of map) if (!live(row, now)) { map.delete(id); n++; }
      }
      return n;
    }
  };
}
