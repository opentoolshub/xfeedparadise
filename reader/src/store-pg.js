// Postgres store: one table, rows keyed by (Ideaflow ID subject, post id).
// Caps: newest `perUser` rows by save time; rows older than `ttlDays` are
// invisible immediately and deleted on the next write or hourly sweep.
import pg from 'pg';
import { LIMITS, decodeCursor, encodeCursor } from './items.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reader_items (
  user_sub  text     NOT NULL,
  post_id   text     NOT NULL,
  sort_id   text     NOT NULL,
  handle    text     NOT NULL,
  name      text     NOT NULL,
  body      text     NOT NULL,
  posted_at bigint   NOT NULL,
  score     smallint NOT NULL,
  kept      boolean  NOT NULL,
  thumb     text,
  saved_at  bigint   NOT NULL,
  PRIMARY KEY (user_sub, post_id)
);
CREATE INDEX IF NOT EXISTS reader_items_feed  ON reader_items (user_sub, posted_at DESC, sort_id DESC);
CREATE INDEX IF NOT EXISTS reader_items_saved ON reader_items (user_sub, saved_at DESC, sort_id DESC);
CREATE INDEX IF NOT EXISTS reader_items_expiry ON reader_items (saved_at);
`;

const sortId = id => id.padStart(25, '0');

function rowToItem(r) {
  return {
    id: r.post_id,
    handle: r.handle,
    name: r.name,
    text: r.body,
    url: `https://x.com/${r.handle}/status/${r.post_id}`,
    postedAt: Number(r.posted_at),
    score: r.score,
    kept: r.kept,
    thumb: r.thumb,
    savedAt: Number(r.saved_at)
  };
}

export function createPgStore({ connectionString, perUser = LIMITS.perUser, ttlDays = LIMITS.ttlDays, pool } = {}) {
  const db = pool || new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  const ttlMs = ttlDays * 86_400_000;

  return {
    kind: 'postgres',
    async init() {
      await db.query(SCHEMA);
    },
    async close() {
      await db.end();
    },
    async upsert(sub, items, now = Date.now()) {
      if (items.length === 0) return { saved: 0, total: (await this.stats(sub, now)).count };
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const values = [];
        const params = [];
        items.forEach((it, i) => {
          const b = i * 11;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`);
          params.push(sub, it.id, sortId(it.id), it.handle, it.name, it.text, it.postedAt, it.score, it.kept, it.thumb, now);
        });
        await client.query(
          `INSERT INTO reader_items (user_sub, post_id, sort_id, handle, name, body, posted_at, score, kept, thumb, saved_at)
           VALUES ${values.join(',')}
           ON CONFLICT (user_sub, post_id) DO UPDATE SET
             handle = EXCLUDED.handle, name = EXCLUDED.name, body = EXCLUDED.body, posted_at = EXCLUDED.posted_at,
             score = EXCLUDED.score, kept = EXCLUDED.kept, thumb = EXCLUDED.thumb, saved_at = EXCLUDED.saved_at`,
          params
        );
        await client.query(
          `DELETE FROM reader_items WHERE user_sub = $1 AND (
             saved_at <= $2 OR (saved_at, sort_id) < (
               SELECT saved_at, sort_id FROM reader_items WHERE user_sub = $1
               ORDER BY saved_at DESC, sort_id DESC OFFSET $3 LIMIT 1))`,
          [sub, now - ttlMs, perUser - 1]
        );
        const { rows } = await client.query('SELECT count(*)::int AS n FROM reader_items WHERE user_sub = $1', [sub]);
        await client.query('COMMIT');
        return { saved: items.length, total: rows[0].n };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async list(sub, { minScore = null, kept = null, cursor = null, limit = LIMITS.pageDefault } = {}, now = Date.now()) {
      const after = decodeCursor(cursor);
      const { rows } = await db.query(
        `SELECT post_id, handle, name, body, posted_at, score, kept, thumb, saved_at FROM reader_items
         WHERE user_sub = $1 AND saved_at > $2
           AND ($3::int IS NULL OR score >= $3::int)
           AND ($4::boolean IS NULL OR kept = $4::boolean)
           AND ($5::bigint IS NULL OR (posted_at, sort_id) < ($5::bigint, $6::text))
         ORDER BY posted_at DESC, sort_id DESC
         LIMIT $7`,
        [sub, now - ttlMs, minScore, kept, after ? after.postedAt : null, after ? sortId(after.id) : null, limit + 1]
      );
      const items = rows.slice(0, limit).map(rowToItem);
      return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
    },
    async deleteAll(sub) {
      const { rowCount } = await db.query('DELETE FROM reader_items WHERE user_sub = $1', [sub]);
      return rowCount;
    },
    async stats(sub, now = Date.now()) {
      const { rows } = await db.query(
        'SELECT count(*)::int AS n, max(saved_at) AS last FROM reader_items WHERE user_sub = $1 AND saved_at > $2',
        [sub, now - ttlMs]
      );
      return { count: rows[0].n, lastSavedAt: rows[0].last === null ? null : Number(rows[0].last) };
    },
    async sweep(now = Date.now()) {
      const { rowCount } = await db.query('DELETE FROM reader_items WHERE saved_at <= $1', [now - ttlMs]);
      return rowCount;
    }
  };
}
