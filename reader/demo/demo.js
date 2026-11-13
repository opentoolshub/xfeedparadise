(() => {
  'use strict';
  const KEY = 'paradise-reader-demo-v1';
  const $ = id => document.getElementById(id);
  const deck = [
    ['Mira Chen', 'mira_sample', 'Today I learned a beautiful way to understand a complex idea: draw the smallest example first. Curious what other people discover when they try it.'],
    ['Rowan Ellis', 'rowan_sample', 'BREAKING: this is an OUTRAGE. Everyone knows these idiots are lying. Disgusting, pathetic, and completely unacceptable!!!'],
    ['Imani Cole', 'imani_sample', 'We built a tiny community library together. Grateful for the generous friends who helped, and excited to see what people learn next.'],
    ['Louis Park', 'louis_sample', 'A thoughtful research note: distinguish the evidence you have from the story you tell about it. Nuanced questions lead to interesting experiments.'],
    ['Theo Gray', 'theo_sample', 'This crisis is a terrible nightmare. The worst part is that everyone knows it is doomed.'],
    ['Jules Hart', 'jules_sample', 'A peaceful morning walk. Mindful of the small things, thankful for good friends, and feeling hopeful.'],
    ['Ada Rivers', 'ada_sample', 'Photo notes from a walk by the river. This post was captured before a score was available.'],
    ['Kit Morgan', 'kit_sample', 'The neighborhood market opens at 9 on Saturday. Bring a bag if you are planning to stop by.'],
    ['Nora Vale', 'nora_sample', 'A breakthrough does not have to be dramatic. Sometimes progress is a kind conversation that helps someone understand the next step.'],
    ['Alex Stone', 'alex_sample', 'They do not want you to know! Wake up! These clowns are the enemy. Shocking, outrageous garbage.'],
    ['Sam Reed', 'sam_sample', 'Shipped a small creative experiment with friends. Amazing how much growth comes from being curious and supporting each other.'],
    ['Leah Moss', 'leah_sample', 'A useful reminder: an old bookmark can be a new connection. I am grateful for people who share their insight generously.'],
  ];
  let model = { version: 1, threshold: 0, rows: [], activity: [], next: 8 };
  let view = 'filtered', search = '', persistFailed = false;
  const opened = new Set();
  const score = text => window.VibeFilter.calculateKeywordScore(text);
  const kept = row => row.score !== null && row.score >= model.threshold;
  const saved = row => row.bookmarked || row.localSaved;
  const signed = n => n > 0 ? `+${n}` : String(n);
  const clone = value => JSON.parse(JSON.stringify(value));

  function node(tag, attrs = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') element.textContent = value;
      else if (key === 'class') element.className = value;
      else element.setAttribute(key, value);
    }
    for (const child of children) if (child) element.append(child);
    return element;
  }
  function announce(message, error = false) {
    $('notice').textContent = message;
    $('notice').className = error ? 'status error' : 'status';
    $('notice').hidden = false;
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(model)); persistFailed = false; }
    catch { persistFailed = true; announce('Your browser could not save this demo. You can still try it, but changes may disappear on reload.', true); }
  }
  function log(text) { model.activity.unshift({ text, at: Date.now() }); model.activity = model.activity.slice(0, 20); }
  function event(row, kind, extra = {}) {
    row.history.push({ kind, at: Date.now(), score: row.score, threshold: model.threshold, ...extra });
    row.history = row.history.slice(-30);
  }
  function sample(index) {
    const [name, handle, text] = deck[index % deck.length];
    return { key: `sample:${index % deck.length}`, name, handle, text, sample: true, url: null, postedAt: Date.now() - index * 4 * 60000 };
  }
  function capture(input, { bookmark = false, pending = false, source = 'feed' } = {}) {
    let row = model.rows.find(r => r.key === input.key);
    const existed = Boolean(row);
    if (!row) {
      if (model.rows.length >= 60) throw Error('This demo holds 60 posts. Reset it before adding more.');
      row = { ...input, raw: [input.text], score: null, bookmarked: bookmark, localSaved: false, sources: [source], history: [], capturedAt: Date.now() };
      model.rows.unshift(row);
      event(row, 'capture');
    } else {
      if (row.text !== input.text) {
        row.raw.push(input.text); row.raw = row.raw.slice(-10); row.text = input.text;
        event(row, 'capture');
      }
      row.sources = [...new Set([...row.sources, source])];
      if (bookmark && !row.bookmarked) { row.bookmarked = true; event(row, 'bookmark'); }
    }
    if (!pending) {
      const nextScore = score(row.text);
      if (row.score !== nextScore) { row.score = nextScore; event(row, 'score'); }
    }
    log(existed ? `Revisited @${row.handle} · same archive item` : `Captured @${row.handle}${pending ? ' · awaiting score' : ' · locally scored'}`);
    return { row, existed };
  }
  function reset() {
    model = { version: 1, threshold: 0, rows: [], activity: [], next: 8 };
    for (let i = 7; i >= 0; i--) capture(sample(i), { pending: i === 6, bookmark: i === 3 || i === 4, source: i === 3 || i === 4 ? 'bookmarks' : 'feed' });
    persist();
  }
  function restore() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY));
      if (value?.version !== 1 || !Number.isInteger(value.threshold) || value.threshold < -100 || value.threshold > 100 || !Array.isArray(value.rows) || value.rows.length > 60 || !Array.isArray(value.activity)) throw Error();
      for (const r of value.rows) {
        if (typeof r.key !== 'string' || typeof r.name !== 'string' || typeof r.handle !== 'string' || typeof r.text !== 'string' || r.text.length > 40000 || !Array.isArray(r.raw) || !r.raw.every(t => typeof t === 'string') || !Array.isArray(r.history) || !Array.isArray(r.sources) || !(r.score === null || Number.isInteger(r.score) && Math.abs(r.score) <= 100)) throw Error();
        if (r.url && !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,30}\/status\/\d{1,25}$/.test(r.url)) throw Error();
      }
      model = value;
    } catch { reset(); }
  }
  function time(at) { return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function label(row) {
    if (row.score === null) return ['Unscored', 'vibe-neutral'];
    return [signed(row.score) + ' · Keywords', row.score >= 20 ? 'vibe-uplifting' : row.score < -20 ? 'vibe-outrage' : 'vibe-neutral'];
  }
  function history(row) {
    const details = node('details', { class: 'capture-history' });
    details.open = opened.has(row.key);
    details.addEventListener('toggle', () => details.open ? opened.add(row.key) : opened.delete(row.key));
    details.append(node('summary', { text: `Capture history · ${row.history.length} events` }));
    details.append(node('p', { class: 'who-meta', text: 'Original captured text' }));
    for (const raw of row.raw) details.append(node('blockquote', { class: 'history-raw', text: raw }));
    for (const e of [...row.history].reverse()) {
      const title = e.kind === 'capture' ? 'Captured before scoring' : e.kind === 'bookmark' ? 'Also found in bookmarks' : e.kind === 'save' ? (e.saved ? 'Saved in this demo' : 'Local save removed') : `${e.score >= e.threshold ? 'Kept' : 'Filtered out'} · score ${signed(e.score)} · threshold ${signed(e.threshold)}`;
      details.append(node('div', { class: 'capture-event' }, [node('p', { text: title }), node('time', { datetime: new Date(e.at).toISOString(), text: time(e.at) })]));
    }
    return details;
  }
  function card(row) {
    const [title, color] = label(row);
    const initial = row.name.charAt(0).toUpperCase();
    const avatar = node('span', { class: 'monogram', 'aria-hidden': 'true', text: initial });
    avatar.style.background = `hsl(${[...row.handle].reduce((n, c) => n + c.charCodeAt(0) * 7, 0) % 360} 36% 34%)`;
    const item = node('li', { class: `post${row.score !== null && !kept(row) ? ' is-hidden' : ''}`, 'data-key': row.key }, [
      node('div', { class: 'post-head' }, [avatar, node('div', { class: 'who' }, [node('div', { class: 'who-name', text: row.name }), node('div', { class: 'who-meta', text: `@${row.handle}${row.sample ? ' · sample' : ' · your capture'}` })]), node('span', { class: `vibe ${color}`, text: title })]),
      node('p', { class: 'post-text', text: row.text }),
    ]);
    const save = node('button', { class: 'save-button', type: 'button', 'data-action': 'save', 'aria-label': `${row.localSaved ? 'Unsave' : 'Save'} post by ${row.name}`, 'aria-pressed': String(row.localSaved), text: row.localSaved ? 'Saved ✓' : 'Save' });
    save.addEventListener('click', () => {
      row.localSaved = !row.localSaved; event(row, 'save', { saved: row.localSaved });
      log(`${row.localSaved ? 'Saved' : 'Removed local save'} · @${row.handle}`); persist(); render();
      const replacement = [...document.querySelectorAll('[data-key]')].find(x => x.dataset.key === row.key);
      (replacement?.querySelector('[data-action="save"]') || document.querySelector(`[data-view="${view}"]`)).focus({ preventScroll: true });
    });
    const sources = row.sources.map(s => s === 'bookmarks' ? 'Bookmarks' : s === 'paste' ? 'Pasted text' : 'Feed');
    const foot = node('div', { class: 'post-foot' }, [node('span', { class: 'source-badge', text: [...sources, ...(row.bookmarked ? ['saved at source'] : [])].join(' · ') }), save]);
    if (row.url) foot.append(node('a', { class: 'post-link', href: row.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on X ↗' }));
    if (row.score === null) {
      const run = node('button', { class: 'demo-button', type: 'button', 'data-action': 'score', text: 'Score post' });
      run.addEventListener('click', () => { row.score = score(row.text); event(row, 'score'); log(`Scored pending capture · @${row.handle}`); persist(); render(); announce('Scored locally. The original capture is still in its history.'); });
      foot.prepend(run);
    }
    item.append(foot, history(row));
    return item;
  }
  function render() {
    const titles = { filtered: 'Your filtered feed', all: 'All captured posts', saved: 'Your saves' };
    const short = { filtered: 'Filtered feed', all: 'All captured', saved: 'Saves' };
    document.title = `${short[view]} · Demo — Paradise Reader`;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
    $('threshold').value = String(model.threshold); $('thresholdValue').textContent = signed(model.threshold);
    $('capturedCount').textContent = model.rows.length;
    $('keptCount').textContent = model.rows.filter(kept).length;
    $('savedCount').textContent = model.rows.filter(saved).length;
    const pending = model.rows.filter(r => r.score === null).length;
    $('thresholdHelp').textContent = `Originals stay in All captured.${pending ? ` ${pending} post${pending === 1 ? '' : 's'} awaiting a score.` : ''}`;
    const needle = search.toLocaleLowerCase();
    const rows = model.rows.filter(r => view === 'all' || view === 'saved' ? view === 'all' || saved(r) : kept(r)).filter(r => `${r.name} ${r.handle} ${r.text}`.toLocaleLowerCase().includes(needle));
    $('viewTitle').textContent = titles[view]; $('viewCount').textContent = `${rows.length} post${rows.length === 1 ? '' : 's'}`;
    $('viewHelp').textContent = view === 'filtered' ? 'Kept by your current filter. Every original is still in the archive.' : view === 'saved' ? 'Bookmarks and local saves stay here, even when your filter hides them.' : 'The originals, including filtered-out and unscored posts.';
    $('feed').replaceChildren(...rows.map(card));
    $('empty').hidden = rows.length > 0;
    $('emptyCopy').textContent = search ? 'Try a different search or show all captured posts.' : view === 'saved' ? 'Save a post, or load the sample bookmark batch below.' : 'Lower the threshold or try All captured. Nothing was deleted.';
    $('activityCount').textContent = `(${model.activity.length})`;
    $('activityList').replaceChildren(...model.activity.slice(0, 8).map(e => node('li', {}, [node('span', { text: e.text }), node('time', { text: time(e.at) })])));
  }
  function setView(next) { view = next; historyRoute(); render(); }
  function historyRoute() { window.history.replaceState(null, '', `#/${view}`); }
  function parseUrl(value) {
    if (!value.trim()) return null;
    const u = new URL(value);
    const match = /^\/([A-Za-z0-9_]{1,30})\/status\/(\d{1,25})\/?$/.exec(u.pathname);
    if (u.protocol !== 'https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname) || u.username || u.password || !match) throw Error('Use a link like https://x.com/name/status/123, or leave it blank.');
    return { key: `x:${match[2]}`, handle: match[1], url: `https://x.com/${match[1]}/status/${match[2]}` };
  }
  function importRows(document) {
    if (document?.source !== 'x-saved' || document.mode !== 'snapshot' || !Array.isArray(document.rows) || document.rows.length > 2000) throw Error('Choose a sanitized x-saved snapshot from Bloomscroll.');
    const rows = document.rows.map((r, i) => {
      if (r.source !== 'x-saved' || typeof r.sourceId !== 'string' || !/^\d{1,25}$/.test(r.sourceId) || typeof r.body !== 'string' || r.body.length > 40000) throw Error('The snapshot contains an invalid saved-post row. Nothing was imported.');
      const handle = r.xContent?.author?.handle || 'imported_post';
      if (!/^[A-Za-z0-9_]{1,30}$/.test(handle)) throw Error('The snapshot contains an invalid author handle.');
      return { key: `x:${r.sourceId}`, handle, name: String(r.xContent?.author?.name || handle).slice(0,100), text: r.body, sample: false, url: `https://x.com/${handle}/status/${r.sourceId}`, postedAt: Date.now() - i * 1000 };
    });
    const newKeys = new Set(rows.filter(r => !model.rows.some(x => x.key === r.key)).map(r => r.key));
    if (model.rows.length + newKeys.size > 60) throw Error('This demo holds 60 posts. Choose a smaller snapshot; nothing was imported.');
    for (const row of rows) capture(row, { bookmark: true, pending: true, source: 'bookmarks' });
    persist(); setView('saved'); announce(`Imported ${rows.length} bookmark rows into this browser. Repeated post IDs were combined; incomplete snapshots never remove saves.`);
  }

  restore();
  const route = location.hash.slice(2);
  if (['filtered','all','saved'].includes(route)) view = route;
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
  window.addEventListener('hashchange', () => { const next = location.hash.slice(2); if (['filtered','all','saved'].includes(next)) { view = next; render(); } });
  $('search').addEventListener('input', e => { search = e.target.value; render(); });
  $('threshold').addEventListener('input', e => { model.threshold = Number(e.target.value); render(); });
  $('threshold').addEventListener('change', () => { for (const row of model.rows) if (row.score !== null && row.history.at(-1)?.threshold !== model.threshold) event(row, 'filter'); log(`Filter changed · keep at ${signed(model.threshold)} or above`); persist(); render(); });
  $('captureBtn').addEventListener('click', () => { try { const result = capture(sample(model.next++ % deck.length)); persist(); setView('all'); announce(result.existed ? 'Already captured. This revisit kept the same archive item.' : 'Captured the original, then scored it locally. Open its history to inspect both steps.'); } catch (e) { announce(e.message, true); } });
  $('pasteBtn').addEventListener('click', () => { $('pasteError').hidden = true; $('pasteSheet').showModal(); $('postText').focus(); });
  $('aboutBtn').addEventListener('click', () => $('aboutSheet').showModal());
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  $('pasteForm').addEventListener('submit', e => {
    e.preventDefault();
    try {
      const text = $('postText').value.trim();
      if (!text) throw Error('Paste some text first.');
      const link = parseUrl($('postUrl').value);
      const input = { key: `paste:${Date.now()}:${Math.random()}`, name: 'Your capture', handle: 'you', url: null, sample: false, text, postedAt: Date.now(), ...(link || {}) };
      const { row, existed } = capture(input, { source: 'paste' });
      if ($('postSave').checked) { row.localSaved = true; event(row, 'save', { saved: true }); }
      persist(); $('pasteSheet').close(); $('pasteForm').reset(); search = ''; $('search').value = ''; setView('all'); opened.add(row.key); render();
      announce(`${existed ? 'Updated the same captured post' : 'Captured and scored locally'} · ${signed(row.score)}. Your text stays in this browser.`);
    } catch (error) { $('pasteError').textContent = error.message; $('pasteError').hidden = false; }
  });
  $('importSampleBtn').addEventListener('click', () => { try { const before = model.rows.length; for (const i of [0,8,9]) capture(sample(i), { bookmark: true, pending: true, source: 'bookmarks' }); persist(); setView('saved'); announce(`Loaded 3 sample bookmarks; ${model.rows.length - before} new posts. The existing tweet kept its identity and gained bookmark provenance.`); } catch (e) { announce(e.message, true); } });
  $('importFileBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => { const file = e.target.files[0]; if (!file) return; try { if (file.size > 1000000) throw Error('Choose a sanitized snapshot smaller than 1 MB for this demo.'); importRows(JSON.parse(await file.text())); } catch (error) { announce(error instanceof SyntaxError ? 'That file is not valid JSON. Nothing was imported.' : error.message, true); } finally { e.target.value = ''; } });
  $('showAllBtn').addEventListener('click', () => { search = ''; $('search').value = ''; setView('all'); });
  $('resetBtn').addEventListener('click', () => $('resetSheet').showModal());
  $('confirmResetBtn').addEventListener('click', () => { reset(); opened.clear(); search = ''; $('search').value = ''; $('resetSheet').close(); setView('filtered'); announce('Restored the fictional sample feed.'); });
  render();
  if (persistFailed) announce('Your browser could not save this demo. Changes may disappear on reload.', true);
})();
