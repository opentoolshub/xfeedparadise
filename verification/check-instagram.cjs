// Run with the repository's Playwright dependency and its Chromium installed.
const { chromium } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://www.instagram.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<main><article id="pick"><header><span>Suggested for you</span></header></article>' +
        '<article id="friend"><header>Friend</header><p>Suggested for you</p></article>' +
        '<div role="dialog"><article id="modal">Shared post</article></div></main>',
    }));
    await page.goto('https://www.instagram.com/');
    await page.evaluate(() => {
      window.state = {};
      window.chrome = { storage: {
        sync: { get: async () => state },
        onChanged: { addListener: callback => { window.changed = callback; } },
      } };
    });
    await page.addStyleTag({ path: path.join(root, 'instagram.css') });
    await page.addScriptTag({ path: path.join(root, 'content-instagram.js') });
    const visible = id => page.locator(id).evaluate(el => getComputedStyle(el).display !== 'none');
    async function mode(value, enabled = true) {
      await page.evaluate(([value, enabled]) => {
        state = { instagramHomeMode: value, vibeFilterSettings: { enabled } };
        changed({ instagramHomeMode: {} }, 'sync');
      }, [value, enabled]);
    }
    assert.ok(await visible('#pick'));
    await mode('suggested');
    assert.equal(await visible('#pick'), false);
    assert.ok(await visible('#friend'));
    await page.locator('#pick span').evaluate(el => { el.textContent = 'Following'; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#pick')).display !== 'none');
    await mode('all');
    assert.equal(await visible('#friend'), false);
    assert.ok(await visible('#modal'));
    for (const route of ['/direct/inbox/', '/reels/', '/explore/', '/p/example/', '/profile/']) {
      await page.evaluate(route => history.pushState({}, '', route), route);
      assert.ok(await visible('#friend'), route);
    }
    await page.evaluate(() => history.pushState({}, '', '/'));
    assert.equal(await visible('#friend'), false);
    await mode('all', false);
    assert.ok(await visible('#friend'));
    await mode('off');
    assert.ok(await visible('#pick'));
    console.log('Instagram Home modes, reused cards, master switch, dialogs and routes passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
