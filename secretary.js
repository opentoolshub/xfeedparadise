// Local-only scheduling policy and single-writer extension-origin storage service.
(function (root) {
  'use strict';
  const KEY = 'xfpSecretaryV1';
  const defaults = { deliveryDay: 5, deliveryStart: 900, deliveryEnd: 1020,
    quietStart: 540, quietEnd: 720, bedtime: 1290, wake: 540 };
  const clone = value => JSON.parse(JSON.stringify(value));
  function settings(value = {}) {
    const out = { ...defaults, ...value };
    for (const key of Object.keys(defaults)) {
      if (!Number.isInteger(out[key]) || out[key] < 0 || out[key] > (key === 'deliveryDay' ? 6 : 1439)) throw Error('Invalid window');
    }
    if (out.deliveryStart >= out.deliveryEnd || out.quietStart >= out.quietEnd || out.wake >= out.bedtime) throw Error('Invalid window order');
    if (out.deliveryStart < out.wake || out.deliveryEnd > out.bedtime ||
        (out.deliveryStart < out.quietEnd && out.deliveryEnd > out.quietStart)) throw Error('Delivery must be outside quiet windows');
    return Object.fromEntries(Object.keys(defaults).map(key => [key, out[key]]));
  }
  function quiet(date, config) {
    const m = date.getHours() * 60 + date.getMinutes();
    return m < config.wake || m >= config.bedtime || (m >= config.quietStart && m < config.quietEnd);
  }
  function localTime(year, month, day, minute) {
    // Find the first valid wall minute in a DST gap; Date chooses the first
    // occurrence for repeated wall times. UTC here is only calendar arithmetic.
    const wall = new Date(Date.UTC(year, month, day, 0, minute));
    for (let offset = 0; offset <= 180; offset++) {
      const candidate = new Date(wall.getTime() + offset * 60000);
      const local = new Date(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), candidate.getUTCHours(), candidate.getUTCMinutes());
      if (local.getHours() === candidate.getUTCHours() && local.getMinutes() === candidate.getUTCMinutes()) return local;
    }
    throw Error('Local time unavailable; choose another window');
  }
  function nextReview(now, config = defaults) {
    // Construct local calendar dates, rather than adding 24h across DST.
    for (let d = 0; d <= 7; d++) {
      let date = new Date(now); date.setDate(date.getDate() + d);
      if (date.getDay() !== config.deliveryDay) continue;
      const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
      date = localTime(year, month, day, config.deliveryStart);
      const end = localTime(year, month, day, config.deliveryEnd);
      if (end.getTime() > now) return Math.max(now, date.getTime());
    }
    throw Error('No delivery window');
  }
  function reviewDue(item, config) {
    if (item.scheduleKind !== 'review' || !item.localDate) return item.dueAtUtc;
    const [year, month, day] = item.localDate.split('-').map(Number);
    return +localTime(year, month - 1, day, config.deliveryStart);
  }
  function eligible(item, now, config = defaults) {
    if (item.status !== 'scheduled' || now < reviewDue(item, config)) return false;
    if (item.urgentUntil > now && item.urgentReason) return true;
    const date = new Date(now);
    if (quiet(date, config)) return false;
    if (item.scheduleKind === 'review') {
      const minute = date.getHours() * 60 + date.getMinutes();
      return date.getDay() === config.deliveryDay && minute >= config.deliveryStart && minute < config.deliveryEnd;
    }
    return true;
  }
  function canonical(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('Unsupported source URL');
    if (['x.com', 'twitter.com'].includes(url.hostname)) {
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
      if (!match) throw Error('Only public post links can be saved');
      return { id: 'x:' + match[2], site: 'x', canonicalUrl: 'https://x.com/' + match[1] + '/status/' + match[2] };
    }
    if (url.hostname === 'news.google.com' && /^\/(?:read|articles)\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return { id: 'news:' + url.pathname.split('/').pop(), site: 'news', canonicalUrl: 'https://news.google.com' + url.pathname };
    }
    throw Error('Unsupported source URL');
  }
  const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  function createService(storage, clock = Date.now) {
    let tail = Promise.resolve();
    async function execute(message) {
      const stored = (await storage.get(KEY))[KEY];
      if (stored && stored.schemaVersion !== 1) throw Error('Unsupported queue version');
      const state = stored ? clone(stored) : { schemaVersion: 1, revision: 0, config: { ...defaults }, items: {}, operations: [] };
      const now = clock();
      if (!state.config || !state.items || !Array.isArray(state.operations)) throw Error('Queue data invalid; export before repair');
      let expired = false;
      for (const [id, item] of Object.entries(state.items)) {
        if (item.status === 'done' && item.doneAt && now - item.doneAt >= 30 * 86400000) {
          state.items[id] = { id, status: 'removed', revision: item.revision + 1 }; expired = true;
        }
      }
      if (expired) { state.revision++; await storage.set({ [KEY]: state }); }
      if (message.action === 'list') {
        return { ...state, items: Object.values(state.items).map(i => ({ ...i, dueAtUtc: reviewDue(i, state.config), ready: eligible(i, now, state.config) })), now };
      }
      if (typeof message.operationId !== 'string' || !/^[\w-]{8,100}$/.test(message.operationId)) throw Error('Operation ID required');
      if (state.operations.includes(message.operationId)) return { ok: true, duplicate: true };
      if (message.action === 'settings') state.config = settings(message.config);
      else if (message.action === 'clear') state.items = {};
      else {
        const source = canonical(message.url);
        const old = state.items[source.id];
        if ((old?.revision || 0) !== message.expectedRevision) throw Error('Item changed; refresh and try again');
        if (message.action === 'save' || message.action === 'snooze') {
          const scheduleKind = message.scheduleKind === 'review' ? 'review' : 'instant';
          const due = scheduleKind === 'review' ? nextReview(now, state.config) : Number(message.dueAtUtc);
          if (!Number.isFinite(due) || due < now - 60000 || due > now + 5 * 366 * 86400000) throw Error('Choose a valid future time');
          const urgentReason = text(message.urgentReason, 200);
          const urgentUntil = Number(message.urgentUntil) || 0;
          if ((message.urgentRequested || urgentUntil || urgentReason) && (!urgentReason || !Number.isFinite(urgentUntil) || urgentUntil <= now || urgentUntil > now + 86400000)) throw Error('Urgent requires a reason and a deadline within 24 hours');
          state.items[source.id] = { ...source, schemaVersion: 1, revision: (old?.revision || 0) + 1,
            title: text(message.title ?? old?.title, 300), capturedAt: old?.capturedAt || now,
            dueAtUtc: due, localDate: scheduleKind === 'review' ? [new Date(due).getFullYear(), String(new Date(due).getMonth() + 1).padStart(2, '0'), String(new Date(due).getDate()).padStart(2, '0')].join('-') : null, scheduleKind, timeZone: text(message.timeZone, 80),
            status: 'scheduled', importance: message.importance === true, reason: text(message.reason, 200),
            urgentReason, urgentUntil };
        } else if (['done', 'saved', 'remove'].includes(message.action) && old && old.status !== 'removed') {
          state.items[source.id] = message.action === 'remove' ? { id: source.id, status: 'removed', revision: old.revision + 1 } :
            { ...old, status: message.action, doneAt: message.action === 'done' ? now : null, revision: old.revision + 1 };
        } else throw Error('Unknown queue operation');
      }
      if (Object.values(state.items).filter(i => i.status !== 'removed').length > 500 || Object.keys(state.items).length > 2500) throw Error('Queue full; export and clear items before saving');
      state.operations = [...state.operations, message.operationId].slice(-1000);
      state.revision++;
      if (new TextEncoder().encode(JSON.stringify(state)).length > 2 * 1024 * 1024) throw Error('Queue storage limit reached');
      await storage.set({ [KEY]: state }); // Acknowledge only after durable success.
      return { ok: true, revision: state.revision };
    }
    return message => {
      const result = tail.then(() => execute(message));
      tail = result.catch(() => {});
      return result;
    };
  }
  const api = { KEY, defaults, settings, quiet, localTime, nextReview, reviewDue, eligible, canonical, createService };
  root.XFPSecretary = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
