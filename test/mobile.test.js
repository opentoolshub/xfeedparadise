// Mobile / Safari support: mobile.js behaviour and the Safari resource build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function fakeElement(classes = []) {
  const set = new Set(classes);
  return {
    classList: {
      contains: c => set.has(c),
      add: c => set.add(c)
    },
    closest(selector) {
      return selector === '.xfp-dimmed' && set.has('xfp-dimmed') ? this : null;
    }
  };
}

function runMobile({ hoverNone, chrome, browser }) {
  const listeners = [];
  const context = {
    matchMedia: query => ({ matches: query === '(hover: none)' && hoverNone }),
    document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) }
  };
  if (chrome) context.chrome = chrome;
  if (browser) context.browser = browser;
  vm.createContext(context);
  vm.runInContext(read('mobile.js'), context);
  return { context, listeners };
}

function tap(listener, target) {
  const event = { target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  listener.fn(event);
  return event;
}

test('mobile.js aliases browser to chrome only when chrome is missing', () => {
  const browser = { runtime: {} };
  assert.equal(runMobile({ hoverNone: false, browser }).context.chrome, browser);
  const chrome = { runtime: { id: 'c' } };
  assert.equal(runMobile({ hoverNone: false, chrome, browser }).context.chrome, chrome);
});

test('desktop pointers keep hover-to-peek and add no tap handler', () => {
  assert.equal(runMobile({ hoverNone: false, chrome: {} }).listeners.length, 0);
});

test('on touch the first tap reveals a dimmed post, the next tap goes through', () => {
  const { listeners } = runMobile({ hoverNone: true, chrome: {} });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'click');
  assert.equal(listeners[0].capture, true);

  const post = fakeElement(['xfp-dimmed']);
  const first = tap(listeners[0], post);
  assert.ok(first.prevented && first.stopped);
  assert.ok(post.classList.contains('xfp-revealed'));

  const second = tap(listeners[0], post);
  assert.ok(!second.prevented && !second.stopped);

  const normal = tap(listeners[0], fakeElement());
  assert.ok(!normal.prevented);
});

test('mobile.js loads first in every content script list', () => {
  const manifest = JSON.parse(read('manifest.json'));
  for (const script of manifest.content_scripts) assert.equal(script.js[0], 'mobile.js');
  assert.match(read('build.sh'), /\bmobile\.js\b/);
});

test('touch CSS keeps dimmed posts dimmed under sticky hover', () => {
  const css = read('styles.css');
  assert.match(css, /@media \(hover: none\)[\s\S]*\.xfp-dimmed\.xfp-revealed/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

const python = ['python3', 'python'].find(bin => spawnSync(bin, ['--version']).status === 0);

test('Safari build copies referenced files and makes a classic background worker', { skip: !python && 'python3 not available' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'xfp-safari-'));
  try {
    const result = spawnSync(python, [path.join(root, 'safari/scripts/sync-extension.py'), '--root', root, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const source = JSON.parse(read('manifest.json'));
    assert.deepEqual(manifest.background, { service_worker: 'background.js' });
    assert.equal(manifest.version, source.version);
    assert.deepEqual(manifest.content_scripts, source.content_scripts);

    for (const script of manifest.content_scripts) {
      for (const file of [...script.js, ...script.css]) assert.ok(fs.existsSync(path.join(out, file)), file);
    }
    for (const file of ['popup.html', 'popup.js', 'providers.js', 'icons/icon128.png']) {
      assert.ok(fs.existsSync(path.join(out, file)), file);
    }

    const worker = fs.readFileSync(path.join(out, 'background.js'), 'utf8');
    assert.doesNotMatch(worker, /^\s*import\s/m);
    assert.ok(worker.indexOf('XFPProviders =') < worker.indexOf('const Providers = globalThis.XFPProviders'));
    assert.doesNotThrow(() => new vm.Script(worker)); // parses as a classic script
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('changing filter mode re-filters x.com posts instead of un-filtering them', () => {
  const source = read('content.js');
  const body = source.slice(source.indexOf('function reprocessVisibleTweets'), source.indexOf('function createFloatingPanel'));
  // registerTweet/processTweet skip articles that still carry these flags.
  assert.match(body, /delete article\.dataset\.xfpProcessed/);
  assert.match(body, /delete article\.dataset\.xfpObserved/);
  assert.match(body, /'xfp-revealed'/);
});
