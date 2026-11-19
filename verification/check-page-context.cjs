// Synthetic pages only. Run with the repo's Playwright or XFP_PLAYWRIGHT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.XFP_PLAYWRIGHT || 'playwright');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const negative = 'Furious hateful enemy trash outrage';
const profile = name => `<a data-testid="AppTabBar_Profile_Link" href="/${name}"></a>`;
const switcher = name => `<button data-testid="SideNav_AccountSwitcher_Button"><span>@${name}</span></button>`;
function post(id, author, { text = negative, before = '', after = '', social = '' } = {}) {
  return `<div data-testid="cellInnerDiv" id="cell${id}"><article data-testid="tweet" id="p${id}" style="min-height:80px">
    ${social}<div data-testid="User-Name"><a href="/${author}"><span>@${author}</span></a>
      <a href="/${author}/status/${id}"><time datetime="2026-11-18T23:00:00Z">1h</time></a></div>
    ${before}<div data-testid="tweetText">${text}</div>${after}</article></div>`;
}

function setup({ local = {}, sync = {} } = {}) {
  const watchers = [];
  const messages = [];
  const writes = [];
  function area(data, name) {
    return {
      async get(keys, callback) {
        const selected = keys == null ? Object.keys(data) : [].concat(keys);
        const result = Object.fromEntries(selected.map(key => [key, data[key]]).filter(([, value]) => value !== undefined));
        callback?.(result);
        return result;
      },
      async set(values, callback) {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => {
          const oldValue = data[key];
          data[key] = structuredClone(value);
          return [key, { newValue: value, oldValue }];
        }));
        watchers.forEach(fn => fn(changes, name));
        callback?.();
      },
      async remove(key) { delete data[key]; }
    };
  }
  window.chrome = {
    storage: {
      sync: area({ vibeFilterSettings: { useAI: false, showScores: true }, ...sync }, 'sync'),
      local: area(local, 'local'),
      onChanged: { addListener(fn) { watchers.push(fn); } }
    },
    runtime: {
      getManifest: () => ({ version: '1.5.0' }),
      onMessage: { addListener(fn) { messages.push(fn); } },
      async sendMessage(message) {
        if (message.type !== 'XFP_SCORE_BATCH') throw Error('Unexpected scoring call');
        const scores = await Promise.all(message.texts.map(text => {
          if (!text.startsWith('fixture-delay')) return null;
          return new Promise(resolve => (window.pendingScores[text] ||= []).push(resolve));
        }));
        return { scores, provider: 'fixture', providerName: 'Fixture' };
      }
    },
    tabs: { query: async () => [] }
  };
  window.receive = message => new Promise(resolve => messages.forEach(fn => fn(message, {}, resolve)));
  window.writes = writes;
  window.tweetDB = {
    ready: Promise.resolve(),
    saveTweet: async tweet => { writes.push(structuredClone(tweet)); },
    getStats: async () => ({ tweetCount: writes.length })
  };
  window.pendingScores = {};
}

async function fixture(browser, { host = 'x.com', route = '/home', posts = '', nav = profile('Mine'),
  background = '#fff', local, sync, touch } = {}) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 680 },
    hasTouch: !!touch
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', req => req.request().isNavigationRequest()
    ? req.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="background:${background};margin:0">${nav}<main data-testid="primaryColumn"><section role="region" id="posts">${posts}</section></main>` })
    : req.abort());
  await page.goto(`https://${host}${route}`);
  await page.evaluate(setup, { local, sync });
  await page.addStyleTag({ content: read('styles.css') });
  for (const file of ['mobile.js', 'providers.js', 'filter.js', 'page-context.js']) {
    await page.addScriptTag({ content: read(file) });
  }
  await page.addScriptTag({ content: read('content.js') });
  await page.locator('.xfp-floating-panel').waitFor({ state: 'attached' });

  let checks = 0;
  async function check(condition, data) {
    await page.waitForFunction(condition, data, { timeout: 5000 });
    checks++;
  }
  async function settings(settings) {
    await page.evaluate(settings => window.receive({ type: 'UPDATE_SETTINGS', settings }), settings);
  }
  async function navigate(url, posts) {
    await page.evaluate(({ url, posts }) => {
      history.pushState({}, '', url);
      if (posts !== undefined) document.querySelector('#posts').innerHTML = posts;
    }, { url, posts });
  }
  async function add(posts, target = '#posts') {
    await page.evaluate(({ posts, target }) => document.querySelector(target).insertAdjacentHTML('beforeend', posts), { posts, target });
  }
  async function state(id, expected) {
    try {
      await check(({ id, expected }) => {
        const article = document.getElementById('p' + id);
        if (!article) return false;
        const row = article.previousElementSibling;
        return ({
          hidden: !!article.closest('.xfp-hidden'),
          dim: !!article.closest('.xfp-dimmed'),
          stub: article.hidden && row?.matches('.xfp-stub') && row.textContent.includes('Hidden by XFeed Paradise'),
          shown: !article.hidden && row?.matches('.xfp-stub') && row.textContent.includes('Shown by you'),
          threshold: !article.hidden && row?.matches('.xfp-stub') && row.textContent.includes('Below threshold'),
          visible: !article.hidden && !article.closest('.xfp-hidden, .xfp-dimmed')
        })[expected];
      }, { id, expected });
    } catch (error) {
      throw new Error(`${page.url()} post ${id} expected ${expected}; page errors: ${errors.join(', ')}`, { cause: error });
    }
  }
  async function banner(text) {
    try {
      await check(text => {
        const banner = document.querySelector('.xfp-context-banner');
        return text ? banner?.firstElementChild.textContent.includes(text) : !banner;
      }, text);
    } catch (error) {
      throw new Error(`${page.url()} wanted banner "${text}"; got "${await page.locator('.xfp-context-banner').allTextContents()}"`, { cause: error });
    }
  }
  async function close() {
    assert.deepEqual(errors, []);
    await context.close();
    return checks;
  }

  return { page, check, settings, navigate, add, state, banner, close };
}

async function browsingAndParticipation(browser) {
  const ownRepost = post(3, 'bystander', { social: '<a href="/Mine"><span data-testid="socialContext">Ha republicado</span></a>' });
  const f = await fixture(browser, { posts: post(1, 'another') + post(2, 'MINE') + ownRepost });
  const { page, check, settings, navigate, add, state, banner } = f;
  await state(1, 'hidden');
  await state(2, 'visible');
  await state(3, 'visible');
  await banner(null);
  await check(() => document.querySelector('.xfp-floating-badge').textContent === '1');

  await settings({ filterMode: 'dim' });
  await state(1, 'dim');
  await state(2, 'visible');
  await settings({ filterMode: 'label' });
  await state(1, 'stub');
  await banner(null);
  await settings({ enabled: false });
  await state(1, 'visible');
  await settings({ enabled: true, filterMode: 'hide' });
  await state(1, 'hidden');

  await navigate('/mine/likes');
  await banner('Filter paused on your profile');
  await state(1, 'visible');
  await check(() => document.querySelector('#p1 .xfp-vibe-indicator') &&
    document.querySelector('.xfp-floating-btn').ariaLabel.includes('Filter paused here') &&
    getComputedStyle(document.querySelector('.xfp-floating-badge')).display === 'none');
  await navigate('/i/bookmarks');
  await banner('Filter paused on bookmarks');
  await state(1, 'visible');
  await navigate('/another');
  await state(1, 'stub');
  await banner('1 post hidden');
  await navigate('/i/lists/9');
  await state(1, 'hidden');
  await banner(null);

  const ancestors = post(10, 'parent') + post(11, 'middle');
  const focal = post(12, 'another');
  const reply = post(13, 'someone');
  await navigate('/another/status/12', ancestors + focal + reply);
  await state(10, 'visible');
  await state(11, 'visible');
  await state(12, 'visible');
  await state(13, 'hidden');
  await banner(null);
  await add(post(14, 'mine'));
  await banner('You’re in this thread');
  await state(13, 'stub');
  await state(14, 'visible');
  await page.evaluate(() => document.querySelector('#cell14').remove());
  await banner('You’re in this thread');
  await page.evaluate(() => document.querySelector('#cell12').remove());
  await state(13, 'visible');

  const addressedToYou = '<div data-testid="replyingTo">En réponse à <a href="/MINE">@MINE</a></div>';
  await navigate('/another/status/12?thread=2', ancestors + post(12, 'another', { before: addressedToYou }) + reply);
  await state(13, 'stub');
  await banner('1 reply hidden');
  await check(() => document.querySelector('.xfp-context-banner').nextElementSibling?.id === 'posts');
  await page.evaluate(() => document.querySelector('.xfp-context-banner').remove());
  await banner('1 reply hidden');
  await navigate('/another/status/12/photo/1');
  await state(13, 'visible');
  await banner('Filter paused on this view');

  await navigate('/home', post(25, 'another'));
  await state(25, 'hidden');
  await page.evaluate(() => {
    const article = document.querySelector('#cell25');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    dialog.append(article);
  });
  await state(25, 'visible');
  await add(post(26, 'another'), '[role=dialog]');
  await state(26, 'visible');
  await check(() => !window.writes.some(tweet => tweet.id === '26'));

  await navigate('/messages', post(28, 'another'));
  await banner('Filter paused on messages');
  await state(28, 'visible');
  await check(() => !window.writes.some(tweet => tweet.id === '28'));
  return f.close();
}

async function overridesAndLateScores(browser) {
  const f = await fixture(browser, {
    host: 'twitter.com', route: '/search?q=first', background: '#15202b', touch: true,
    sync: { vibeFilterSettings: { useAI: true, showScores: true } },
    posts: post(31, 'another') + post(32, 'another', { text: 'fixture-delay-32' }) +
      '<div style="height:1200px"></div>' + post(33, 'another', { text: 'fixture-delay-33' })
  });
  const { page, check, settings, navigate, add, state, banner } = f;
  await state(31, 'stub');
  await banner('1 result hidden');
  await check(() => document.querySelector('.xfp-context-banner').dataset.theme === 'dark');
  const expand = page.getByRole('group', { name: /Hidden by XFeed Paradise/ }).getByRole('button', { name: 'Show', exact: true });
  await expand.focus();
  await page.keyboard.press('Enter');
  await state(31, 'shown');
  await check(() => document.activeElement.textContent === 'Hide' && document.activeElement.ariaExpanded === 'true');
  await page.keyboard.press('Enter');
  await state(31, 'stub');
  await check(() => document.activeElement.textContent === 'Show' && document.activeElement.ariaExpanded === 'false' &&
    document.activeElement.getBoundingClientRect().height >= 44);
  await page.keyboard.press('Enter');
  await state(31, 'shown');

  await check(() => pendingScores['fixture-delay-32']?.length && pendingScores['fixture-delay-33']?.length);
  await page.evaluate(() => {
    pendingScores['fixture-delay-32'][0](-82);
    pendingScores['fixture-delay-33'][0](-82);
  });
  await state(32, 'threshold');
  await state(33, 'stub');
  await page.locator('#p32').locator('xpath=preceding-sibling::*[1]').getByRole('button', { name: 'Hide' }).click();
  await state(32, 'stub');

  await settings({ filterMode: 'dim' });
  await state(32, 'dim');
  await banner('2 results dimmed');
  await page.locator('#p32 [data-testid="tweetText"]').tap();
  await check(() => document.querySelector('#cell32').classList.contains('xfp-revealed'));
  await state(31, 'visible');
  await settings({ filterMode: 'hide' });
  await state(31, 'shown');
  await state(32, 'stub');

  await page.getByRole('button', { name: 'Show all', exact: true }).click();
  await banner('Showing all on this visit');
  await state(32, 'visible');
  await add(post(34, 'newpost'));
  await state(34, 'visible');
  await navigate('/search?q=second');
  await banner('3 results hidden');
  await state(31, 'shown');
  await state(34, 'stub');
  await page.getByRole('button', { name: 'Always show in search' }).click();
  await banner('Filter paused on search');
  await state(34, 'visible');
  await check(async () => (await chrome.storage.sync.get('xfp_context_search')).xfp_context_search === 'off');
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByLabel('Search', { exact: true }).selectOption('disclose');
  await state(34, 'stub');

  await navigate('/notifications/mentions', post(35, 'another') + '<div data-testid="notification" id="native">Followed you</div>');
  await banner('1 mention hidden');
  await state(35, 'stub');
  await check(() => document.querySelector('#native').getBoundingClientRect().height > 0);
  await page.evaluate(() => {
    document.body.style.backgroundColor = '#000';
    document.querySelector('#p35 a[href*="/status/"]').href = '/another/status/31';
  });
  await state(35, 'shown');
  await check(() => document.querySelector('.xfp-context-banner').dataset.theme === 'dark');

  await page.evaluate(() => document.querySelector('#p35 a[href*="/status/"]').remove());
  await state(35, 'visible');
  await check(() => !document.querySelector('#cell35 .xfp-stub'));

  await navigate('/search?q=late', post(36, 'another', { text: 'fixture-delay' }));
  await state(36, 'visible');
  await check(() => !!window.pendingScores['fixture-delay']?.length);
  await navigate('/i/bookmarks', post(36, 'another') + post(37, 'another'));
  await banner('Filter paused on bookmarks');
  await page.evaluate(() => pendingScores['fixture-delay'][0](-95));
  await check(() => !VibeFilter.batchProcessing);
  await state(36, 'visible');
  await check(() => !document.querySelector('#p36 .xfp-vibe-indicator').textContent.includes('-95'));
  return f.close();
}

async function refinementHandoff(browser) {
  const pendingNav = post(51, 'another', { text: 'fixture-delay-route' });
  const f = await fixture(browser, {
    sync: { vibeFilterSettings: { useAI: true, showScores: true } },
    posts: pendingNav
  });
  const { page, check, settings, navigate, add, state } = f;
  const waitForRequest = text => check(text => pendingScores[text]?.length === 1, text);
  const resolve = (text, score = -85) => page.evaluate(({ text, score }) => pendingScores[text][0](score), { text, score });

  // Replace a pending card across routes. One transport result belongs to
  // the new eligible card with the same ID and text.
  await waitForRequest('fixture-delay-route');
  await navigate('/explore', pendingNav);
  await check(() => writes.filter(tweet => tweet.id === '51').length === 2);
  await resolve('fixture-delay-route');
  await state(51, 'hidden');
  await check(() => pendingScores['fixture-delay-route'].length === 1 &&
    writes.filter(tweet => tweet.id === '51' && tweet.scoredWithAI).length === 1);

  // Recycle a node to another post on the same route, with the original
  // pending post mounted in a new cell.
  const pendingRecycle = post(52, 'another', { text: 'fixture-delay-recycle' });
  await add(pendingRecycle);
  await waitForRequest('fixture-delay-recycle');
  await page.evaluate(post => {
    const article = document.querySelector('#p52');
    article.id = 'p53';
    article.querySelector('a[href*="/status/"]').href = '/another/status/53';
    article.querySelector('[data-testid="tweetText"]').textContent = 'Wonderful progress';
    document.querySelector('#posts').insertAdjacentHTML('beforeend', post);
  }, pendingRecycle.replace('id="cell52"', 'id="replacement52"'));
  await check(() => writes.filter(tweet => tweet.id === '52').length === 2);
  await resolve('fixture-delay-recycle');
  await state(52, 'hidden');
  await state(53, 'visible');
  await check(() => !writes.some(tweet => tweet.id === '53' && tweet.scoredWithAI));

  // A late result cannot apply to changed text even when the ID is unchanged.
  await add(post(54, 'another', { text: 'fixture-delay-old-text' }));
  await waitForRequest('fixture-delay-old-text');
  await page.evaluate(() => {
    document.querySelector('#p54 [data-testid="tweetText"]').textContent = 'Wonderful progress';
  });
  await check(() => writes.some(tweet => tweet.id === '54' && tweet.text === 'Wonderful progress'));
  await resolve('fixture-delay-old-text');
  await check(() => !VibeFilter.batchProcessing);
  await state(54, 'visible');
  await check(() => !writes.some(tweet => tweet.id === '54' && tweet.scoredWithAI));

  // Cache the finished request while filtering is off, then reconcile it
  // into the same mounted card when filtering is enabled again.
  await add(post(55, 'another', { text: 'fixture-delay-disabled' }));
  await waitForRequest('fixture-delay-disabled');
  await settings({ enabled: false });
  await resolve('fixture-delay-disabled');
  await check(() => !VibeFilter.batchProcessing && !writes.some(tweet => tweet.id === '55' && tweet.scoredWithAI));
  await state(55, 'visible');
  await settings({ enabled: true });
  await state(55, 'hidden');
  await check(() => writes.filter(tweet => tweet.id === '55' && tweet.scoredWithAI).length === 1);
  return f.close();
}

async function isolatedStubRemoval(browser) {
  const f = await fixture(browser, { route: '/search?q=stub', posts: post(56, 'another') });
  const { page, check, state, settings, banner } = f;
  await state(56, 'stub');
  await banner('1 result hidden');
  // Let initialization finish. Then remove just the row, with no navigation,
  // settings change, or non-extension mutation to trigger a rescan.
  await page.locator('.xfp-load-more-container').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    window.originalPost = document.querySelector('#p56');
    window.originalPost.previousElementSibling.remove();
  });
  await check(() => {
    const article = document.querySelector('#p56');
    return article === window.originalPost && article.hidden &&
      article.previousElementSibling?.querySelector('button')?.ariaExpanded === 'false' &&
      document.querySelectorAll('.xfp-stub').length === 1;
  });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await state(56, 'shown');
  await settings({ enabled: false });
  await state(56, 'visible');
  await check(() => !document.querySelector('.xfp-stub'));
  return f.close();
}

async function identityFallbacks(browser) {
  const f = await fixture(browser, { nav: '', local: { xfp_me: 'MINE' }, route: '/mine/media', posts: post(40, 'other') });
  const { page, check, navigate, state, banner } = f;
  await banner('Filter paused on your profile');
  await state(40, 'visible');
  await navigate('/home', post(41, 'mine') + post(42, 'other'));
  await state(41, 'visible');
  await state(42, 'hidden');
  await page.evaluate(({ profile, switcher }) => {
    document.body.insertAdjacentHTML('afterbegin', profile + switcher);
  }, { profile: profile('Mine'), switcher: switcher('Other') });
  await state(41, 'hidden');
  await state(42, 'visible');
  await check(async () => (await chrome.storage.local.get('xfp_me')).xfp_me === 'other');
  await page.evaluate(() => chrome.storage.sync.set({ xfp_context_alwaysShowOwnPosts: false }));
  await state(42, 'hidden');
  await page.evaluate(() => {
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]').remove();
    document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]').remove();
  });
  await navigate('/logout');
  await check(async () => !(await chrome.storage.local.get('xfp_me')).xfp_me);
  await page.evaluate(() => chrome.storage.sync.set({ xfp_context_alwaysShowOwnPosts: true }));
  await navigate('/home', '<div><div data-testid="UserAvatar-Container-newme"><a href="/NewMe"></a></div>' +
    '<div><div data-testid="tweetTextarea_0"></div></div></div>' + post(43, 'newme'));
  await check(async () => (await chrome.storage.local.get('xfp_me')).xfp_me === 'newme');
  await state(43, 'visible');
  return f.close();
}

async function popupPreferences(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(setup, { local: { popupSettingsExpanded: true } });
  const files = new Set(['popup.html', 'popup.js', 'page-context.js', 'providers.js', 'secretary.js', 'secretary-ui.js']);
  await page.route('**/*', request => {
    const url = new URL(request.request().url());
    const file = url.pathname.slice(1);
    if (url.origin !== 'https://fixture.invalid' || !files.has(file)) return request.abort();
    return request.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript', body: read(file) });
  });
  await page.goto('https://fixture.invalid/popup.html');
  const search = page.getByRole('combobox', { name: 'Search', exact: true });
  const profiles = page.getByRole('combobox', { name: 'Other profiles', exact: true });
  await search.waitFor();
  assert.equal(await search.inputValue(), 'disclose');
  assert.equal(await page.getByRole('combobox', { name: 'Your profile', exact: true }).inputValue(), 'off');
  await search.selectOption('off');
  await profiles.selectOption('normal');
  assert.deepEqual(await page.evaluate(() => chrome.storage.sync.get(['xfp_context_search', 'xfp_context_profile'])), {
    xfp_context_search: 'off', xfp_context_profile: 'normal'
  });
  await page.evaluate(() => chrome.storage.sync.set({ xfp_context_search: 'normal' }));
  assert.equal(await search.inputValue(), 'normal');
  assert.deepEqual(errors, []);
  await context.close();
  return 4;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.XFP_CHROME_CHANNEL || 'chrome', chromiumSandbox: true, headless: true
  });
  try {
    const checks = await browsingAndParticipation(browser) + await overridesAndLateScores(browser) +
      await identityFallbacks(browser) + await popupPreferences(browser) +
      await refinementHandoff(browser) + await isolatedStubRemoval(browser);
    console.log(`PASS: ${checks} sandboxed Chrome fixture checks, plus keyboard, settings and zero page errors`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
