const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const context = vm.createContext({ URL, URLSearchParams });
vm.runInContext(read('page-context.js'), context);
const XFPContext = vm.runInContext('XFPContext', context);

test('route classification and default policies cover X participation and browsing', () => {
  const fixtures = [
    ['/home', 'feed', 'normal'],
    ['/ME', 'ownProfile', 'off'],
    ['/me/with_replies', 'ownProfile', 'off'],
    ['/me/media', 'ownProfile', 'off'],
    ['/me/likes', 'ownProfile', 'off'],
    ['/me/highlights', 'ownProfile', 'off'],
    ['/me/articles', 'ownProfile', 'off'],
    ['/someone/with_replies', 'profile', 'disclose'],
    ['/Someone/status/123', 'thread', 'normal'],
    ['/ME/status/123', 'thread', 'disclose'],
    ['/i/web/status/123', 'thread', 'normal'],
    ['/i/status/123', 'thread', 'normal'],
    ['/search', 'search', 'disclose'],
    ['/notifications', 'notifications', 'disclose'],
    ['/notifications/mentions', 'notifications', 'disclose'],
    ['/notifications/verified', 'notifications', 'disclose'],
    ['/i/bookmarks', 'bookmarks', 'off'],
    ['/i/bookmarks/78', 'bookmarks', 'off'],
    ['/i/lists/34', 'feed', 'normal'],
    ['/i/communities/34', 'feed', 'normal'],
    ['/explore', 'feed', 'normal'],
    ['/i/trends', 'feed', 'normal'],
    ['/jobs', 'feed', 'normal'],
    ['/settings', 'feed', 'normal'],
    ['/compose/post', 'viewer', 'off'],
    ['/me/status/123/photo/1', 'viewer', 'off'],
    ['/me/status/123/video/1', 'viewer', 'off'],
    ['/messages', 'messages', 'off'],
    ['/messages/23-41', 'messages', 'off']
  ];
  for (const [pathname, kind, policy] of fixtures) {
    const ctx = XFPContext.classify(pathname, '', 'Me');
    assert.equal(ctx.kind, kind, pathname);
    assert.equal(XFPContext.policyFor(ctx, {}), policy, pathname);
  }
  assert.equal(XFPContext.classify('/search', '?q=bird&f=live', null).tab, 'live');
  assert.equal(XFPContext.classify('/jobs/status/123', '', null).kind, 'feed');
  assert.equal(XFPContext.classify('/Elise/status/123', '', null).focalId, '123');
  assert.equal(XFPContext.classify('/me', '', null).kind, 'profile');
});

test('context preference changes preserve other keys and reject invalid values', () => {
  const current = { contextPolicies: { search: 'off', bookmarks: 'normal' }, alwaysShowOwnPosts: false };
  const updated = XFPContext.applyPreferences(current, {
    xfp_context_search: { newValue: 'normal' },
    xfp_context_notifications: { newValue: 'invalid' },
    xfp_context_alwaysShowOwnPosts: { newValue: undefined }
  });
  assert.equal(updated.alwaysShowOwnPosts, true);
  assert.equal(XFPContext.policyFor({ kind: 'search' }, updated), 'normal');
  assert.equal(XFPContext.policyFor({ kind: 'bookmarks' }, updated), 'normal');
  assert.equal(XFPContext.policyFor({ kind: 'notifications' }, updated), 'disclose');
  assert.equal(XFPContext.policyFor({ kind: 'thread', participating: true }, {
    contextPolicies: { thread: 'off' }
  }), 'off');
  assert.equal(XFPContext.policyFor({ kind: 'thread', participating: false }, {
    contextPolicies: { thread: 'off' }
  }), 'normal');
});

test('Chrome and popup load the shared policy module, while Google News stays independent', () => {
  const [x, news] = JSON.parse(read('manifest.json')).content_scripts;
  assert.ok(x.js.indexOf('page-context.js') < x.js.indexOf('content.js'));
  assert.ok(x.js.includes('page-context.js'));
  assert.ok(!news.js.includes('page-context.js'));
  assert.match(read('popup.html'), /src="page-context.js"[\s\S]+src="popup.js"/);
  assert.match(read('build.sh'), /\bpage-context\.js\b/);
});
