// X route policies and the DOM signals used to recognize participation.
// The extension popup also uses the settings helpers in this module.
const XFPContext = (() => {
  const selectors = Object.freeze({
    tweet: 'article[data-testid="tweet"]',
    cell: '[data-testid="cellInnerDiv"]',
    primary: '[data-testid="primaryColumn"]',
    timeline: 'section[role="region"]',
    profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
    switcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
    composer: '[data-testid="tweetTextarea_0"]',
    avatar: '[data-testid^="UserAvatar-Container-"] a[href]',
    author: '[data-testid="User-Name"]',
    repost: '[data-testid="socialContext"]',
    undoRepost: '[data-testid="unretweet"]',
    text: '[data-testid="tweetText"]',
    quote: '[data-testid="quoteTweet"]',
    replyingTo: '[data-testid="replyingTo"], [data-testid="replyTo"]',
    dialog: '[role="dialog"]'
  });

  const policies = Object.freeze({
    ownProfile: { label: 'Your profile', default: 'off' },
    profile: { label: 'Other profiles', default: 'disclose' },
    thread: { label: 'Threads you’re in', default: 'disclose' },
    search: { label: 'Search', default: 'disclose' },
    notifications: { label: 'Notifications', default: 'disclose' },
    bookmarks: { label: 'Bookmarks', default: 'off' }
  });
  const choices = { normal: 'Normal', disclose: 'Disclose', off: 'Off' };
  const reserved = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings',
    'compose', 'login', 'logout', 'jobs', 'account', 'intent', 'share',
    'hashtag', 'topics', 'tos', 'privacy', 'download', 'about', 'premium'
  ]);
  const handlePattern = /^[a-z0-9_]{1,15}$/i;
  const profilePattern = /^\/([a-z0-9_]{1,15})(?:\/(with_replies|media|likes|highlights|articles))?\/?$/i;
  const threadPattern = /^\/(?:([a-z0-9_]{1,15})\/status|i\/(?:web\/)?status)\/(\d+)(?=\/|$)/i;
  const storagePrefix = 'xfp_context_';
  const ownKey = 'alwaysShowOwnPosts';
  const keys = [...Object.keys(policies), ownKey];
  const storageKeys = keys.map(key => storagePrefix + key);

  function handle(value) {
    return typeof value === 'string' && handlePattern.test(value) ? value.toLowerCase() : null;
  }

  function pathOf(link) {
    const href = link?.getAttribute('href');
    if (!href) return '';
    try {
      const url = new URL(href, 'https://x.com');
      return url.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname)
        ? url.pathname : '';
    } catch {
      return '';
    }
  }

  function linkedHandle(link) {
    const match = pathOf(link).match(/^\/([a-z0-9_]{1,15})\/?$/i);
    const name = handle(match?.[1]);
    return reserved.has(name) ? null : name;
  }

  function classify(pathname, search, me) {
    const route = pathname.split('/')[1]?.toLowerCase();
    if (route === 'messages') return { kind: 'messages' };
    if (route === 'compose') return { kind: 'viewer' };
    if (route === 'notifications') return { kind: 'notifications', tab: pathname.split('/')[2] || 'all' };
    if (route === 'search') return { kind: 'search', tab: new URLSearchParams(search).get('f') || 'top' };
    if (/^\/i\/bookmarks(?:\/|$)/i.test(pathname)) return { kind: 'bookmarks' };

    const thread = pathname.match(threadPattern);
    if (thread && (!reserved.has(route) || route === 'i')) {
      const [, author, focalId] = thread;
      const kind = /\/(photo|video)(?:\/|$)/i.test(pathname) ? 'viewer' : 'thread';
      const name = handle(author);
      return { kind, handle: name, focalId, participating: !!name && name === handle(me) };
    }
    const profile = !reserved.has(route) && pathname.match(profilePattern);
    if (profile) {
      const name = handle(profile[1]);
      return { kind: name === handle(me) ? 'ownProfile' : 'profile', handle: name, tab: profile[2] || 'posts' };
    }
    return { kind: 'feed' };
  }

  function policyFor(ctx, settings) {
    if (ctx.kind === 'messages' || ctx.kind === 'viewer') return 'off';
    if (ctx.kind === 'thread' && !ctx.participating) return 'normal';
    return preference(ctx.kind, settings);
  }

  function preference(key, settings) {
    if (key === ownKey) return settings.alwaysShowOwnPosts !== false;
    const chosen = settings.contextPolicies?.[key];
    return Object.hasOwn(choices, chosen) ? chosen : policies[key]?.default || 'normal';
  }

  // Separate sync keys let a setting change in one tab preserve other controls.
  function preferences(values) {
    return {
      contextPolicies: Object.fromEntries(Object.keys(policies).map(key => [key, values[storagePrefix + key]])),
      alwaysShowOwnPosts: values[storagePrefix + ownKey] !== false
    };
  }

  async function loadPreferences() {
    return preferences(await chrome.storage.sync.get(storageKeys));
  }

  function watchPreferences(onChange) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && storageKeys.some(key => Object.hasOwn(changes, key))) onChange(changes);
    });
  }

  function applyPreferences(settings, changes) {
    const values = {};
    for (const key of keys) {
      const storageKey = storagePrefix + key;
      values[storageKey] = Object.hasOwn(changes, storageKey) ? changes[storageKey].newValue : preference(key, settings);
    }
    return preferences(values);
  }

  async function savePreference(key, value) {
    await chrome.storage.sync.set({ [storagePrefix + key]: value });
  }

  function mountSettings(root, settings) {
    const fields = new Map();
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    let current = settings;

    for (const key of keys) {
      const label = document.createElement('label');
      const title = document.createElement('span');
      title.id = `xfp-setting-label-${key}`;
      title.textContent = policies[key]?.label || 'Always show my posts and reposts';
      const field = document.createElement(key === ownKey ? 'input' : 'select');
      field.setAttribute('aria-labelledby', title.id);
      if (key === ownKey) {
        field.type = 'checkbox';
      } else {
        for (const [value, text] of Object.entries(choices)) {
          field.add(new Option(text, value));
        }
      }
      label.append(title, field);
      root.append(label);
      fields.set(key, field);
      field.addEventListener('change', async () => {
        status.textContent = '';
        try {
          await savePreference(key, key === ownKey ? field.checked : field.value);
        } catch {
          update(current);
          status.textContent = 'Could not save filter setting.';
        }
      });
    }
    root.append(status);

    function update(next) {
      current = next;
      for (const [key, field] of fields) {
        if (key === ownKey) field.checked = preference(key, next);
        else field.value = preference(key, next);
      }
    }
    update(settings);
    return update;
  }

  function probeViewer(doc, pathname) {
    // The account switcher can update before the profile link on account change.
    const switcher = doc.querySelector(selectors.switcher);
    const account = [...(switcher?.querySelectorAll('span') || [])]
      .map(span => span.textContent.trim().match(/^@([a-z0-9_]{1,15})$/i)?.[1])
      .find(Boolean);
    const profile = linkedHandle(doc.querySelector(selectors.profileLink));
    if (profile) return { handle: profile, account: handle(account) };
    if (account) return { handle: handle(account), account: handle(account) };

    if (pathname === '/home' || pathname === '/home/') {
      const composer = doc.querySelector(selectors.primary)?.querySelector(selectors.composer);
      for (let parent = composer?.parentElement; parent && !parent.matches(selectors.primary); parent = parent.parentElement) {
        if (parent.querySelector(selectors.tweet)) break;
        const owner = linkedHandle(parent.querySelector(selectors.avatar));
        if (owner) return { handle: owner, account: null };
      }
    }
    return { handle: null, account: null };
  }

  function ownContent(node, article) {
    return node.closest(selectors.tweet) === article && !node.closest(selectors.quote);
  }

  function tweetIdentity(article) {
    const header = [...article.querySelectorAll(selectors.author)].find(node => ownContent(node, article));
    const author = [...(header?.querySelectorAll('a[href]') || [])].map(linkedHandle).find(Boolean);
    const timeLinks = [...article.querySelectorAll('time')].map(time => time.closest('a[href]')).filter(Boolean);
    const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];
    for (const link of [...timeLinks, ...statusLinks]) {
      if (!ownContent(link, article) || link.closest(selectors.text)) continue;
      const match = pathOf(link).match(threadPattern);
      if (!match || (author && match[1] && handle(match[1]) !== author)) continue;
      return { id: match[2], author: author || handle(match[1]), time: link.querySelector('time') };
    }
    return null;
  }

  function isOwn(article, identity, me) {
    if (!me) return false;
    if (identity.author === me) return true;
    const repost = article.querySelector(selectors.repost);
    if (!repost || !ownContent(repost, article)) return false;
    const links = [repost.closest('a[href]'), ...repost.querySelectorAll('a[href]')];
    const attributedTo = links.map(linkedHandle).find(Boolean);
    return attributedTo ? attributedTo === me
      : [...article.querySelectorAll(selectors.undoRepost)].some(control => ownContent(control, article));
  }

  function repliesTo(article, me) {
    if (!me) return false;
    const block = article.querySelector(selectors.replyingTo);
    if (block && ownContent(block, article)) {
      return [...block.querySelectorAll('a[href]')].some(link => linkedHandle(link) === me);
    }

    // X also renders an unnamed reply preamble between the header and post text.
    const header = article.querySelector(selectors.author);
    const text = article.querySelector(selectors.text);
    if (!header || !text) return false;
    return [...article.querySelectorAll('a[href]')].some(link =>
      ownContent(link, article) && linkedHandle(link) === me &&
      link.textContent.trim().toLowerCase() === '@' + me &&
      !header.contains(link) && !text.contains(link) &&
      !!(header.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !!(link.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  }

  return {
    selectors, policies, classify, policyFor, probeViewer, handle, tweetIdentity, isOwn, repliesTo,
    loadPreferences, watchPreferences, applyPreferences, savePreference, mountSettings
  };
})();
