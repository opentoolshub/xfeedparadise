// Synthetic unauthenticated-environment UI fixture. No real identity/provider
// access; the auth stub is confined to this standalone development process.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createMemoryStore } from '../src/store-memory.js';

const evidence = process.env.PARADISE_UI_EVIDENCE || '/tmp/paradise-ui';
await mkdir(evidence, { recursive: true });
const store = createMemoryStore({ archive: true });
const post = { id: '123', handle: 'fixture', name: 'Fixture Author', text: 'A post worth returning to. <script>window.badCapture=true</script>', postedAt: Date.UTC(2026,10,1), score: null, kept: null, thumb: null, saved: false, sources: ['x-feed'] };
await store.upsert('fixture-a', [post, { ...post, score: -65, kept: false, saved: true, sources: ['x-bookmarks'], policy: '{"threshold":0,"source":"keyword"}' }, { ...post, id: '124', text: 'A useful discovery', score: 70, kept: true }, { ...post, id: '125', text: 'Captured while scoring was unavailable' }]);
await store.upsert('fixture-b', [{ ...post, id: '999', text: 'Other account private fixture' }]);
let server, base;
for (let attempt = 0; attempt < 20; attempt++) {
  const port = 7000 + Math.floor(Math.random() * 3000);
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({ PUBLIC_ORIGIN: base, SESSION_SECRET: 'synthetic-only-reader-session-00000000' });
  const auth = { session: req => req.headers.cookie?.includes('fixture_session=a') ? { sub: 'fixture-a', name: 'Fixture Reader' } : null };
  server = createApp({ config, store, auth, log: () => {} });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); break; }
  catch (e) { if (attempt === 19) throw e; }
}
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PARADISE_CHROMIUM ? { executablePath: process.env.PARADISE_CHROMIUM } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await context.addCookies([{ name: 'fixture_session', value: 'a', url: base }]);
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => requests.push(req.url()));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#feed > li').length === 1);
  assert.equal(await page.title(), 'Filtered feed — Paradise Reader');
  await page.getByRole('button', { name: 'All captured', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#feed > li').length === 3);
  assert.equal(await page.title(), 'All captured — Paradise Reader');
  assert.match(await page.locator('#feed').innerText(), /Unscored/);
  assert.doesNotMatch(await page.locator('#feed').innerText(), /Other account private fixture/);
  await page.getByRole('button', { name: 'Saves', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#feed > li').length === 1);
  assert.equal(await page.title(), 'Saves — Paradise Reader');
  await page.locator('summary').click();
  assert.match(await page.locator('.capture-history').innerText(), /Captured before scoring/);
  assert.match(await page.locator('.capture-history').innerText(), /Filtered out/);
  assert.equal(await page.evaluate(() => window.badCapture), undefined);
  await page.screenshot({ path: `${evidence}/archive-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  assert.equal(await page.locator('#accountSheet').evaluate(x => x.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#accountSheet').evaluate(x => x.open), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${evidence}/archive-desktop.png`, fullPage: true });
  await context.clearCookies();
  await page.reload();
  await page.getByRole('link', { name: 'Sign in with Ideaflow', exact: true }).waitFor();
  assert.equal(await page.title(), 'Sign in — Paradise Reader');
  assert.equal(await page.locator('#feed').innerText(), '');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => url.startsWith(base)), 'no third-party requests from the fixture reader');
  console.log(JSON.stringify({ status: 'passed', views: ['Filtered','All captured','Saves','Sign in'], widths: [320,390,1280], rawAndScoredHistory: true, ownerIsolation: true, executableText: false, thirdPartyRequests: 0, fixtureOnly: true, iPhoneTested: false }));
  await context.close();
} finally {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
