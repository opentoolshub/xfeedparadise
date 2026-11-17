// Extension-owned Later controls. Text-only metadata; no scoring, network, or DOM snapshots.
(function () {
  'use strict';
  const popup = !['x.com', 'twitter.com', 'news.google.com'].includes(location.hostname);
  const protectedRoute = () => !popup && /^\/(messages|i\/chat|i\/direct_messages)(\/|$)/.test(location.pathname);
  if (globalThis.xfpSecretaryUI) return;
  globalThis.xfpSecretaryUI = true;
  let snapshot, selected, panel, host, root, cue, message, list, form, settingsForm;
  let shown = new Set(), articles = new Map();
  const expandedGroups = new Set(), rowSignatures = new WeakMap();
  let renderedSignature = '';
  const api = async (action, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ type: 'XFP_SECRETARY', action,
      operationId: crypto.randomUUID(), ...extra });
    if (!response || response.error) throw Error(response?.error || 'Storage unavailable; item was not saved');
    return response;
  };
  function el(tag, text, parent, attrs = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent?.append(node); return node;
  }
  function button(text, parent, action) {
    const b = el('button', text, parent, { type: 'button' });
    b.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(action).catch(error => tell(error.message)); });
    return b;
  }
  const tell = text => { if (message) message.textContent = text; };
  const dateText = ms => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const minutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const timeText = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  function input(label, type, parent, value = '') {
    const wrap = el('label', label, parent); const node = el('input', '', wrap, { type });
    if (type === 'checkbox') node.checked = value === true; else node.value = value;
    return node;
  }
  function current(item) { return snapshot?.items.find(i => i.id === item.id); }
  async function change(action, item, extra = {}) {
    await api(action, { url: item.canonicalUrl, expectedRevision: item.revision || 0, ...extra });
    await refresh();
  }
  function open(item) {
    selected = item; form.hidden = !item; panel.hidden = false;
    if (item) {
      form.replaceChildren();
      el('h3', 'Later · ' + (item.title || 'Saved item'), form);
      const choiceLabel = el('label', 'Target window', form);
      const choice = el('select', '', choiceLabel);
      for (const [value, text] of [['review', 'Delivery window (default: Friday review)'], ['tonight', 'Tonight (20:00 local)'], ['custom', 'Choose date and time'], ['break', 'After this break — choose its end']]) el('option', text, choice, { value });
      const custom = input('Date and time (local)', 'datetime-local', form);
      const dueLabel = el('p', '', form);
      const important = input('Important to me (does not bypass quiet hours)', 'checkbox', form, item.importance);
      const reason = input('Why return to this? (optional)', 'text', form, item.reason || ''); reason.maxLength = 200;
      const urgent = input('Truly urgent — bypass quiet hours until deadline', 'checkbox', form);
      const urgentReason = input('Urgent reason (required for bypass)', 'text', form); urgentReason.maxLength = 200;
      const deadline = input('Urgent deadline (within 24 hours)', 'datetime-local', form);
      function resolve() {
        if (choice.value === 'review') return XFPSecretary.nextReview(Date.now(), snapshot.config);
        if (choice.value === 'tonight') { const d = new Date(); d.setHours(20, 0, 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return +d; }
        return +new Date(custom.value);
      }
      function preview() {
        const due = resolve(); dueLabel.textContent = Number.isFinite(due) ? 'Target: ' + dateText(due) + '. Quiet windows delay presentation; missed review windows wait for the next delivery window.' : 'Choose an explicit date and time.';
        custom.required = ['custom', 'break'].includes(choice.value);
      }
      choice.addEventListener('change', preview); custom.addEventListener('input', preview); preview();
      const save = el('button', 'Save for later', form, { type: 'submit' });
      form.onsubmit = async event => {
        event.preventDefault(); save.disabled = true;
        try {
          const due = resolve();
          await change('save', item, { title: item.title, scheduleKind: choice.value === 'review' ? 'review' : 'instant', dueAtUtc: due,
            importance: important.checked, reason: reason.value,
            urgentRequested: urgent.checked, urgentReason: urgent.checked ? urgentReason.value : '', urgentUntil: urgent.checked ? +new Date(deadline.value) : 0,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
          tell('Saved for ' + dateText(due) + ' · local to this browser. Remove to undo.');
          form.hidden = true; selected = null;
        } catch (error) { tell(error.message + ' · original remains visible.'); }
        finally { save.disabled = false; }
      };
      button('Cancel', form, () => { form.hidden = true; selected = null; });
      choice.focus();
    }
    render();
  }
  function render() {
    if (!snapshot || !list) return;
    const signature = JSON.stringify([snapshot.config, snapshot.items]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const focusKey = root.activeElement?.dataset.focusKey;
    list.replaceChildren();
    const ready = snapshot.items.filter(i => i.ready).sort((a, b) => Number(b.importance) - Number(a.importance) || a.dueAtUtc - b.dueAtUtc);
    const scheduled = snapshot.items.filter(i => i.status === 'scheduled' && !i.ready).sort((a, b) => a.dueAtUtc - b.dueAtUtc);
    const saved = snapshot.items.filter(i => i.status === 'saved');
    cue.textContent = ready.length + ' ready · Later';
    el('p', 'Review digest · ' + ready.length + ' ready · ' + scheduled.length + ' scheduled · ' + saved.length + ' saved', list);
    el('p', 'Discovery only. Source messages and notifications are never scheduled here. Browser closed? Review at next open; no push alerts.', list);
    for (const [title, items] of [['Ready', ready], ['Scheduled', scheduled], ['Saved', saved], ['Done', snapshot.items.filter(i => i.status === 'done')]]) {
      const group = el('section', '', list); el('h3', title + ' (' + items.length + ')', group);
      let count = 0;
      function row(item) {
        const row = el('div', '', group, { class: 'item' });
        el('a', (item.importance ? 'Important · ' : '') + (item.title || item.canonicalUrl), row, { href: item.canonicalUrl, target: '_blank', rel: 'noopener noreferrer' });
        el('p', (item.reason ? item.reason + ' · ' : '') + 'Target: ' + dateText(item.dueAtUtc), row);
        if (item.status !== 'done') {
          button('Reschedule', row, () => open(item)).dataset.focusKey = item.id + ':reschedule';
          button('Keep saved', row, () => change('saved', item)).dataset.focusKey = item.id + ':saved';
          button('Done', row, () => change('done', item)).dataset.focusKey = item.id + ':done';
        }
        button('Remove', row, () => change('remove', item)).dataset.focusKey = item.id + ':remove';
      }
      count = expandedGroups.has(title) ? items.length : 3; items.slice(0, count).forEach(row);
      if (items.length > count) {
        const more = button('View all ' + items.length, group, () => { items.slice(count).forEach(row); count = items.length; expandedGroups.add(title); more.remove(); });
      }
    }
    if (focusKey) {
      const target = [...list.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey);
      (target || cue).focus();
    }
  }
  async function refresh() {
    if (protectedRoute()) { teardown(); return; }
    snapshot = await api('list');
    render();
    if (selected && (current(selected)?.status === 'removed' || (selected.revision > 0 && !current(selected)))) {
      const focused = form.contains(root.activeElement); selected = null; form.replaceChildren(); form.hidden = true; tell('Item removed.'); if (focused) cue.focus();
    }
    const digest = document.querySelector('[data-xfp-secretary="digest"]');
    if (digest && digest.dataset.readySignature !== readySignature()) {
      const focused = digest.contains(document.activeElement); digest.remove();
      if (focused) cue?.focus();
    }
    for (const [article, item] of articles) {
      if (!article.isConnected) { articles.delete(article); continue; }
      reconcile(article, item);
    }
  }
  function create() {
    if (protectedRoute() || host) return;
    host = el('div', '', popup ? document.body : document.documentElement, { 'data-xfp-secretary': 'owned' });
    root = host.attachShadow({ mode: popup ? 'open' : 'closed' });
    el('style', `:host{all:initial;font:14px system-ui,sans-serif;color:#e2e8f0}*{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{min-height:44px}button{cursor:pointer;border:1px solid #475569;border-radius:7px;padding:8px;background:#253247;color:#f1f5f9;margin:3px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #a78bfa;outline-offset:2px}button:disabled{opacity:.5}a{color:#c4b5fd;display:block;overflow-wrap:anywhere;padding:6px}label{display:block;margin:8px 0}input:not([type=checkbox]),select{display:block;width:100%;background:#172033;color:#fff;border:1px solid #64748b;border-radius:4px;padding:6px}h2,h3{margin:12px 0 6px}p{margin:6px 0;color:#cbd5e1;line-height:1.45}.item{border-top:1px solid #475569;padding:8px 0}[hidden]{display:none!important}#cue{${popup ? '' : 'position:fixed;bottom:14px;left:14px;z-index:2147483600;'}background:#172033}#panel{${popup ? '' : 'position:fixed;bottom:72px;left:12px;z-index:2147483601;'}width:min(380px,calc(100vw - 24px));max-height:75vh;overflow:auto;border:1px solid #64748b;border-radius:10px;background:#172033;padding:14px;box-shadow:0 8px 24px #0005}#message{white-space:pre-wrap}`, root);
    cue = button('Later', root, () => open()); cue.id = 'cue';
    panel = el('section', '', root, { id: 'panel', 'aria-label': 'Later review and scheduling' }); panel.hidden = !popup;
    el('h2', 'Later · your secretary', panel);
    button('Close', panel, () => { panel.hidden = true; cue.focus(); });
    panel.addEventListener('keydown', e => { if (e.key === 'Escape') { panel.hidden = true; cue.focus(); } });
    message = el('p', '', panel, { id: 'message', role: 'status', 'aria-live': 'polite' });
    form = el('form', '', panel); form.hidden = true;
    if (!popup) button('Show ready in feed', panel, injectDigest);
    list = el('div', '', panel);
    const details = el('details', '', panel); el('summary', 'Delivery and quiet windows', details);
    settingsForm = el('form', '', details);
    const day = el('select', '', el('label', 'Delivery day', settingsForm));
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach((name, i) => el('option', name, day, { value: String(i) }));
    const fields = {};
    for (const [key, label] of [['deliveryStart','Delivery begins'],['deliveryEnd','Delivery ends'],['quietStart','Focus begins'],['quietEnd','Focus ends'],['bedtime','Quiet before bed'],['wake','Morning resumes']]) fields[key] = input(label + ' (local)', 'time', settingsForm);
    el('button', 'Save windows', settingsForm, { type: 'submit' });
    settingsForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const config = { deliveryDay: Number(day.value) };
        for (const [key, node] of Object.entries(fields)) config[key] = minutes(node.value);
        await api('settings', { config }); await refresh(); tell('Windows saved. Recurring review follows this device’s local time zone.');
      } catch (error) { tell(error.message); }
    };
    button('Export local queue', panel, () => {
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = el('a', 'Download queue export', panel, { href: url, download: 'paradise-later.json' }); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
    });
    if (popup) button('Delete all Later data', panel, async () => { if (confirm('Delete all Later items? This cannot be undone.')) { await api('clear'); await refresh(); } });
    refresh().then(() => { day.value = snapshot.config.deliveryDay; for (const [key, node] of Object.entries(fields)) node.value = timeText(snapshot.config[key]); }).catch(e => tell(e.message));
  }
  function identity(article) {
    if (article.closest('[data-xfp-secretary]')) return null;
    const anchors = article.querySelectorAll('a[href]');
    for (const a of anchors) {
      try {
        const source = XFPSecretary.canonical(a.href);
        const title = (article.querySelector('[data-testid="tweetText"]') || article.querySelector('h3,h4') || a).textContent.trim().slice(0, 300);
        return { ...source, title };
      } catch {}
    }
    return null;
  }
  function reconcile(article, item) {
    const actual = identity(article);
    if (!actual || actual.id !== item.id) {
      article.classList.remove('xfp-secretary-deferred'); article.querySelector('.xfps-row')?.remove(); articles.delete(article);
      if (actual) attach(article); return;
    }
    const record = current(item);
    const collapsed = record?.status === 'scheduled' && !shown.has(item.id);
    article.classList.toggle('xfp-secretary-deferred', !!collapsed);
    let row = article.querySelector('.xfps-row');
    if (!row) {
      row = el('div', '', article, { class: 'xfps-row', 'data-xfp-secretary': 'row' });
    }
    const signature = JSON.stringify([item.id, record?.revision, record?.ready, collapsed]);
    if (rowSignatures.get(article) === signature && row.childNodes.length) return;
    rowSignatures.set(article, signature);
    const focusedLabel = row.contains(document.activeElement) ? document.activeElement.textContent : null;
    row.replaceChildren();
    if (collapsed) {
      el('span', (record.ready ? 'Ready · ' : 'Later · ') + dateText(record.dueAtUtc) + (record.reason ? ' · ' + record.reason : ''), row);
      button('Show now', row, () => { shown.add(item.id); reconcile(article, item); });
      button('Reschedule', row, () => open(record));
      button('Remove / Undo', row, () => change('remove', record));
    } else button('Later', row, () => open(record && record.status !== 'removed' ? record : { ...item, revision: record?.revision || 0 }));
    if (focusedLabel) ([...row.querySelectorAll('button')].find(node => node.textContent === focusedLabel) || row.querySelector('button') || cue).focus();
  }
  function attach(article) {
    if (!snapshot || protectedRoute()) return;
    const item = identity(article);
    if (!item) { article.classList.remove('xfp-secretary-deferred'); article.querySelector('.xfps-row')?.remove(); articles.delete(article); return; }
    articles.set(article, item); reconcile(article, item);
  }
  function scan(node) {
    if (node.nodeType !== 1 || node.closest('[data-xfp-secretary]')) return;
    if (node.matches('article')) attach(node);
    node.querySelectorAll('article').forEach(attach);
  }
  function readySignature() {
    return snapshot.items.filter(i => i.ready).map(i => i.id + ':' + i.revision).sort().join('|');
  }
  function injectDigest() {
    if (protectedRoute()) return;
    const first = document.querySelector('article');
    if (!first) { tell('No supported feed boundary. Use the Later panel links.'); return; }
    document.querySelector('[data-xfp-secretary="digest"]')?.remove();
    const shelf = document.createElement('section'); shelf.setAttribute('data-xfp-secretary', 'digest'); shelf.className = 'xfps-digest';
    el('h2', 'Your Later review', shelf);
    const ready = snapshot.items.filter(i => i.ready).sort((a,b) => Number(b.importance)-Number(a.importance) || a.dueAtUtc-b.dueAtUtc);
    if (!ready.length) { tell('No items ready in this window.'); return; }
    shelf.dataset.readySignature = readySignature();
    ready.slice(0,3).forEach(item => { el('a', (item.importance ? 'Important · ' : '') + (item.title || item.canonicalUrl), shelf, { href: item.canonicalUrl, target: '_blank', rel: 'noopener noreferrer' }); });
    button('Review all ' + ready.length, shelf, () => open());
    button('Dismiss digest', shelf, () => shelf.remove());
    first.before(shelf); tell('Review inserted above the feed. Opening a link does not mark it done.');
  }
  function teardown() {
    host?.remove(); host = root = panel = null; renderedSignature = ''; selected = null;
    document.querySelector('[data-xfp-secretary="digest"]')?.remove();
    for (const article of articles.keys()) { article.classList.remove('xfp-secretary-deferred'); article.querySelector('.xfps-row')?.remove(); }
    articles.clear(); snapshot = null; shown.clear();
  }
  create();
  if (!popup) {
    let route = location.pathname;
    new MutationObserver(mutations => {
      if (route !== location.pathname) {
        route = location.pathname; teardown(); create();
        if (!protectedRoute()) refresh().then(() => scan(document.body)).catch(() => {});
      }
      if (protectedRoute()) return;
      for (const mutation of mutations) {
        if (mutation.target.closest?.('[data-xfp-secretary]')) continue;
        if (mutation.type === 'attributes') { const article = mutation.target.closest('article'); if (article) attach(article); }
        else {
          // Reconcile the owning card even when only a text/link descendant is replaced.
          const changed = [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType !== 1 || !node.hasAttribute('data-xfp-secretary'));
          if (changed) { const article = mutation.target.closest?.('article'); if (article) attach(article); }
          for (const node of mutation.addedNodes) scan(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    refresh().then(() => scan(document.body)).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });
    setInterval(() => { if (!document.hidden && !protectedRoute()) refresh().catch(() => {}); }, 60000);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[XFPSecretary.KEY] && !protectedRoute()) refresh().catch(() => {});
  });
})();
