// XFeed Paradise - Content Script
// Monitors X/Twitter feed, extracts tweets, and filters based on vibe score
// Now with AI-powered sentiment analysis!

(async function() {
  'use strict';

  // Feature flag - check if Twitter support is enabled (defaults to ON)
  const TWITTER_ENABLED_KEY = 'xfp_twitter_enabled';

  const flagResult = await chrome.storage.sync.get(TWITTER_ENABLED_KEY);
  const isEnabled = flagResult[TWITTER_ENABLED_KEY] !== false; // Default to true

  if (!isEnabled) {
    console.log('🌴 XFeed Paradise: Twitter/X support is disabled.');
    return;
  }

  console.log('🌴 XFeed Paradise: Initializing...');

  // Wait for dependencies
  await window.tweetDB.ready;
  await VibeFilter.loadSettings();
  Object.assign(VibeFilter.settings, await XFPContext.loadPreferences());
  await VibeFilter.loadProviderConfig();

  // AI scoring state - the configured provider(s) score via the background worker
  let aiProviderReady = VibeFilter.provider.configured;

  // Re-read provider configuration (primary + fallback)
  async function checkProviderStatus() {
    await VibeFilter.loadProviderConfig();
    aiProviderReady = VibeFilter.provider.configured;
    return aiProviderReady;
  }

  // Initialize AI (just checks provider configuration)
  async function initAIScorer() {
    await checkProviderStatus();
    const { primaryName, fallbackName } = VibeFilter.provider;
    if (aiProviderReady) {
      console.log(`🌴 XFeed Paradise: ${primaryName} configured${fallbackName ? ` (fallback: ${fallbackName})` : ''}; connection not yet verified`);
    } else {
      console.log(`🌴 XFeed Paradise: No ${primaryName} key - using keyword scoring`);
    }
    updateFloatingPanel();
  }

  // Popup changes to provider, key or model apply without a reload
  VibeFilter.watchProviderConfig(() => {
    aiProviderReady = VibeFilter.provider.configured;
    updateFloatingPanel();
  });

  // Local AI scorer is disabled - provider scoring happens in filter.js
  window.AIScorer = {
    get isReady() { return false; }, // Local AI disabled
    scoreTweet: async () => null
  };
  VibeFilter.aiScorer = window.AIScorer;

  // Check provider status on init
  if (VibeFilter.settings.useAI !== false) {
    initAIScorer();
  }

  const { selectors } = XFPContext;
  const processedTweets = new Set();
  const cards = new Map();
  const stubOwners = new WeakMap();
  const revealedIds = new Set();
  const countedIds = new Set();
  const hiddenTweets = [];
  let hiddenCount = 0;
  let pageHidden = 0;
  let pageDimmed = 0;
  let pageRevealAll = false;
  let route = '';
  let context = { kind: 'feed' };
  let viewer = null;
  let accountHint = null;
  let cachedViewer = null;
  let warnedMissingTweets = false;

  try {
    cachedViewer = XFPContext.handle((await chrome.storage.local.get('xfp_me')).xfp_me);
  } catch {
    // A local storage failure still leaves DOM identity probes available.
  }

  function refreshViewer() {
    const probe = XFPContext.probeViewer(document, location.pathname);
    const accountChanged = probe.account && (accountHint
      ? accountHint !== probe.account
      : cachedViewer && cachedViewer !== probe.account && probe.handle !== probe.account);
    if (probe.account) accountHint = probe.account;
    if (accountChanged) viewer = probe.account;
    else if (probe.handle && (!probe.account || probe.handle === probe.account || viewer !== probe.account)) {
      viewer = probe.handle;
    }
    const signedOut = /^\/(login|logout|i\/flow\/login)(?:\/|$)/i.test(location.pathname) ||
      !!document.querySelector('[data-testid="loginButton"]') && !probe.handle;
    if (signedOut) {
      viewer = null;
      accountHint = null;
      if (cachedViewer) {
        cachedViewer = null;
        chrome.storage.local.remove('xfp_me').catch(() => {});
      }
      return;
    }
    viewer ||= cachedViewer;
    if (viewer && viewer !== cachedViewer) {
      cachedViewer = viewer;
      chrome.storage.local.set({ xfp_me: viewer }).catch(() => {});
    }
  }

  const routeKey = () => location.pathname + location.search;

  // Toast notification system
  let toastTimeout = null;
  function showToast(message, type = 'info', duration = 4000) {
    // Remove existing toast
    document.querySelector('.xfp-toast')?.remove();
    if (toastTimeout) clearTimeout(toastTimeout);

    const toast = document.createElement('div');
    toast.className = `xfp-toast ${type}`;

    const icon = type === 'warning' ? '⚠️' : type === 'error' ? '❌' : '🌴';
    toast.innerHTML = `<span class="xfp-toast-icon">${icon}</span><span>${message}</span>`;

    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto-hide
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Hook into VibeFilter for rate limit notifications (debounced to prevent spam)
  let lastRateLimitToast = 0;
  VibeFilter.onRateLimit = (apiName, waitSeconds, usingName) => {
    const now = Date.now();
    // Only show toast if it's been at least 30 seconds since last one
    if (now - lastRateLimitToast > 30000) {
      lastRateLimitToast = now;
      const using = usingName ? `Using fallback ${usingName}` : 'Using keyword scoring';
      showToast(`${apiName} rate limited. ${using} for ${waitSeconds}s`, 'warning', 5000);
    }
  };

  let lastApiErrorToast = 0;
  VibeFilter.onApiError = (apiName, reason, usingName) => {
    // Built-in provider used up for today: one friendly notice (the worker
    // reports it once, then backs off until the next UTC day).
    if (reason === 'daily_limit' || reason === 'global_budget') {
      showToast(XFPProviders.BUILTIN_LIMIT_NOTICE, 'info', 8000);
      return;
    }
    const now = Date.now();
    if (now - lastApiErrorToast < 30000) return;
    lastApiErrorToast = now;
    const problem = reason === 401 || reason === 403 ? 'key rejected'
      : reason === 'network_error' ? 'connection failed'
      : reason === 'invalid_response' ? 'unexpected response'
      : reason === 'model_error' ? 'model unavailable'
      : reason === 'permission_needed' ? 'access not granted'
      : `error ${reason}`;
    const using = usingName ? `Using fallback ${usingName}` : 'Using keyword scoring';
    showToast(`${apiName} ${problem}. ${using}; check the extension popup.`, 'warning', 6000);
  };

  function extractTweetData(article, identity, isOwn) {
    const authorHandle = identity.author || 'unknown';
    const displayName = article.querySelector(selectors.author)?.querySelector('span')?.textContent || authorHandle;
    const timestamp = identity.time?.dateTime ? Date.parse(identity.time.dateTime) : Date.now();
    const getMetric = testId => {
      const text = article.querySelector(`[data-testid="${testId}"]`)?.textContent || '';
      return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
    };
    return {
      id: identity.id,
      source: 'twitter',
      text: article.querySelector(selectors.text)?.textContent || '',
      authorId: authorHandle,
      authorName: displayName,
      authorAvatar: article.querySelector('img[src*="profile_images"]')?.src || '',
      timestamp,
      feedOwner: viewer || 'unknown',
      metrics: { replies: getMetric('reply'), retweets: getMetric('retweet'), likes: getMetric('like') },
      media: {
        hasImage: !!article.querySelector('[data-testid="tweetPhoto"]'),
        hasVideo: !!article.querySelector('[data-testid="videoPlayer"]'),
        hasQuote: !!article.querySelector(selectors.quote)
      },
      isRetweet: !!article.querySelector(selectors.repost),
      isOwn,
      url: `https://x.com/${authorHandle}/status/${identity.id}`,
      collectedAt: Date.now()
    };
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function isInViewport(article) {
    const rect = article.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
      rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function applyScoreBadge(article, card, vibeLabel) {
    if (!VibeFilter.settings.enabled || !VibeFilter.settings.showScores) {
      card.badge?.remove();
      article.classList.remove('xfp-vibe-position');
      return;
    }
    if (!card.badge) {
      card.badge = document.createElement('div');
      card.badge.dataset.xfpUi = '';
    }
    if (card.badge.parentElement !== article) article.prepend(card.badge);
    card.badge.className = `xfp-vibe-indicator ${vibeLabel.class}`;
    setText(card.badge, `${vibeLabel.label} (${card.score})`);
    article.classList.add('xfp-vibe-position');
  }

  function relativeTime(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'Now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  function renderStub(article, card, vibeLabel, presentation) {
    if (!card.row) {
      const row = document.createElement('div');
      row.className = 'xfp-stub';
      row.dataset.xfpUi = '';
      row.setAttribute('role', 'group');
      const label = document.createElement('span');
      const button = document.createElement('button');
      button.type = 'button';
      row.append(label, button);
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (route !== routeKey() || cards.get(article) !== card ||
            XFPContext.tweetIdentity(article)?.id !== card.tweet.id) return;
        const wasCollapsed = card.presentation === 'stub';
        card.revealAnimation?.cancel();
        if (wasCollapsed) {
          revealedIds.add(card.tweet.id);
        } else {
          revealedIds.delete(card.tweet.id);
          card.keepVisible = false;
        }
        reprocessVisibleTweets();
        if (wasCollapsed && !article.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          card.revealAnimation = article.animate({
            maxHeight: ['0px', article.getBoundingClientRect().height + 'px'],
            overflow: ['hidden', 'hidden']
          }, { duration: 150, easing: 'ease-out' });
        }
      });
      card.row = row;
      stubOwners.set(row, article);
    }
    const collapsed = presentation === 'stub';
    const description = collapsed
      ? ['Hidden by XFeed Paradise', vibeLabel.label, card.tweet.authorId === 'unknown' ? '' : `@${card.tweet.authorId}`,
          card.identity.time && relativeTime(card.tweet.timestamp)].filter(Boolean).join(' · ')
      : presentation === 'revealed' ? 'Shown by you' : 'Below threshold';
    card.row.dataset.theme = pageTheme;
    card.row.setAttribute('aria-label', description);
    setText(card.row.firstElementChild, description);
    const button = card.row.lastElementChild;
    button.setAttribute('aria-expanded', String(!collapsed));
    setText(button, collapsed ? 'Show' : 'Hide');
    if (card.row.nextElementSibling !== article) article.before(card.row);
  }

  function clearPresentation(article, card) {
    card.target?.classList.remove('xfp-hidden', 'xfp-dimmed', 'xfp-revealed');
    if (card.hidArticle) {
      article.hidden = false;
      article.classList.remove('xfp-content-hidden');
      card.hidArticle = false;
    }
  }

  function clearCard(article, card) {
    card.revealAnimation?.cancel();
    clearPresentation(article, card);
    article.classList.remove('xfp-vibe-position');
    card.badge?.remove();
    card.row?.remove();
    cards.delete(article);
  }

  function contextLabel() {
    if (context.kind === 'profile' || context.kind === 'ownProfile') return '@' + context.handle;
    return { thread: 'Thread', search: 'Search', notifications: 'Notifications', bookmarks: 'Bookmarks' }[context.kind] || 'Feed';
  }

  function recordFiltered(card, vibeLabel) {
    const tweet = card.tweet;
    if (countedIds.has(tweet.id)) return;
    countedIds.add(tweet.id);
    hiddenCount++;
    hiddenTweets.unshift({
      id: tweet.id,
      text: tweet.text.slice(0, 100) + (tweet.text.length > 100 ? '...' : ''),
      authorHandle: tweet.authorId,
      score: card.score,
      url: tweet.url,
      vibeLabel: vibeLabel.label,
      contextLabel: contextLabel()
    });
    if (hiddenTweets.length > 50) hiddenTweets.pop();
  }

  function applyFilter(article, card, protectedThreadPost, policy) {
    const settings = VibeFilter.settings;
    const vibeLabel = VibeFilter.getVibeLabel(card.score);
    const below = !VibeFilter.shouldShow(card.score);
    let presentation = 'visible';
    if (settings.enabled && below && policy !== 'off' && !pageRevealAll &&
        !protectedThreadPost && !(settings.alwaysShowOwnPosts && card.tweet.isOwn)) {
      const collapses = settings.filterMode === 'label' || (policy === 'disclose' && settings.filterMode === 'hide');
      if (revealedIds.has(card.tweet.id)) presentation = collapses ? 'revealed' : 'visible';
      else if (collapses) presentation = policy === 'disclose' && card.keepVisible ? 'threshold' : 'stub';
      else if (settings.filterMode === 'dim') presentation = 'dim';
      else if (settings.filterMode === 'hide') presentation = 'hidden';
    }

    // Shared cells can contain multiple posts. Keep their siblings independent.
    const cell = article.closest(selectors.cell);
    const target = cell?.querySelectorAll(selectors.tweet).length === 1 ? cell : article;
    if (presentation !== card.presentation || card.target !== target) {
      clearPresentation(article, card);
      card.presentation = presentation;
      card.target = target;
    }

    if (presentation === 'stub') {
      if (!article.hidden) {
        article.hidden = true;
        card.hidArticle = true;
        article.classList.add('xfp-content-hidden');
      }
    }
    if (presentation === 'dim') target.classList.add('xfp-dimmed');
    if (presentation === 'hidden') target.classList.add('xfp-hidden');

    if (['stub', 'revealed', 'threshold'].includes(presentation)) {
      renderStub(article, card, vibeLabel, presentation);
    } else {
      card.row?.remove();
    }

    if (['stub', 'dim', 'hidden'].includes(presentation)) recordFiltered(card, vibeLabel);
    applyScoreBadge(article, card, vibeLabel);
  }

  function processTweet(article, identity, tweet) {
    const { score, source } = VibeFilter.getScoreWithRefinement(tweet.id, tweet.text);
    const card = { identity, tweet, score, scoreSource: source };
    cards.set(article, card);
    processedTweets.add(tweet.id);
    saveCardScore(card);
    return card;
  }

  function saveCardScore(card) {
    window.tweetDB.saveTweet({
      ...card.tweet, vibeScore: card.score, scoredWithAI: card.scoreSource === 'ai'
    }).catch(() => {});
  }

  function reconcileRefinedScore(article, card, policy) {
    const cached = VibeFilter.getCachedScore(card.tweet.id, card.tweet.text);
    if (cached?.source !== 'ai' || (card.scoreSource === 'ai' && card.score === cached.score)) return;
    if (policy === 'disclose' && card.presentation === 'visible' &&
        VibeFilter.shouldShow(card.score) && !VibeFilter.shouldShow(cached.score) &&
        isInViewport(article)) card.keepVisible = true;
    card.score = cached.score;
    card.scoreSource = cached.source;
    saveCardScore(card);
  }

  // The scorer owns results. On completion, re-read the live route and match
  // cached results to current cards rather than retaining callbacks on old cards.
  VibeFilter.onScoreRefined = () => {
    if (VibeFilter.settings.enabled) syncPage();
  };

  let banner = null;
  let announcementTimer = null;
  let pageTheme = 'dark';

  function detectTheme() {
    const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number);
    if (!rgb || (rgb.length === 4 && rgb[3] === 0)) {
      return document.documentElement.style.colorScheme === 'light' ? 'light' : 'dark';
    }
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 140 ? 'light' : 'dark';
  }

  function openWhereToFilter() {
    const panel = document.querySelector('.xfp-floating-panel');
    panel.classList.remove('hidden');
    panel.querySelector('.xfp-floating-dropdown').classList.add('show');
    panel.querySelector('.xfp-settings-toggle').classList.add('expanded');
    panel.querySelector('.xfp-settings-content').classList.add('show');
    panel.querySelector('.xfp-context-settings select').focus();
  }

  function removeBanner() {
    banner?.remove();
    banner = null;
    clearTimeout(announcementTimer);
    announcementTimer = null;
  }

  function createBanner() {
    const row = document.createElement('div');
    row.className = 'xfp-context-banner';
    row.dataset.xfpUi = '';
    const text = document.createElement('span');
    text.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'xfp-visually-hidden';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.textContent = 'Show all';
    showAll.addEventListener('click', () => {
      if (route !== routeKey()) return;
      pageRevealAll = true;
      reprocessVisibleTweets();
      banner?.querySelector('button:not([hidden])')?.focus();
    });
    const change = document.createElement('button');
    change.type = 'button';
    change.addEventListener('click', async () => {
      if (route !== routeKey() || !Object.hasOwn(XFPContext.policies, context.kind)) return;
      if (XFPContext.policyFor(context, VibeFilter.settings) === 'off') {
        openWhereToFilter();
      } else {
        try {
          await XFPContext.savePreference(context.kind, 'off');
        } catch {
          showToast('Could not save filter setting.', 'warning');
        }
      }
    });
    row.append(text, status, showAll, change);
    return row;
  }

  function renderBanner(primary, policy) {
    if (!primary || !VibeFilter.settings.enabled || policy === 'normal') {
      if (banner) removeBanner();
      return;
    }
    const isNew = !banner;
    banner ||= createBanner();
    banner.dataset.theme = pageTheme;
    const timeline = primary.querySelector(selectors.timeline);
    if (timeline) {
      if (banner.nextElementSibling !== timeline) timeline.before(banner);
    } else if (banner.parentElement !== primary) {
      primary.prepend(banner);
    }

    const [text, status, showAll, change] = banner.children;
    const names = {
      ownProfile: 'your profile', profile: `@${context.handle}’s profile`,
      bookmarks: 'bookmarks', messages: 'messages', viewer: 'this view',
      notifications: 'notifications', search: 'search', thread: 'this thread'
    };
    const countUnit = context.kind === 'search' ? 'result'
      : context.kind === 'thread' ? 'reply'
      : context.kind === 'notifications' && context.tab === 'mentions' ? 'mention' : 'post';
    const count = pageHidden || pageDimmed;
    const plural = count === 1 ? countUnit : countUnit === 'reply' ? 'replies' : countUnit + 's';
    const summary = policy === 'off' ? `Filter paused on ${names[context.kind]}.`
      : pageRevealAll ? `Showing all on this visit · ${names[context.kind]}`
      : `${context.kind === 'thread' ? 'You’re in this thread' : 'Filtering ' + names[context.kind]} · ${count} ${plural} ${pageDimmed ? 'dimmed' : 'hidden'}`;
    const message = '🌴 ' + summary;
    setText(text, message);
    if (isNew) setText(status, message);
    else if (status.textContent !== message && announcementTimer === null) {
      announcementTimer = setTimeout(() => {
        setText(status, text.textContent);
        announcementTimer = null;
      }, 2000);
    }
    showAll.hidden = policy !== 'disclose' || pageRevealAll;
    change.hidden = !Object.hasOwn(XFPContext.policies, context.kind);
    const always = { search: 'Always show in search', profile: 'Always show on profiles' }[context.kind] || 'Always show here';
    setText(change, policy === 'off' ? 'Change' : always);
  }

  function syncPage(force = false) {
    const nextRoute = routeKey();
    const navigated = nextRoute !== route;
    if (navigated) {
      route = nextRoute;
      pageRevealAll = false;
      pageHidden = 0;
      pageDimmed = 0;
      countedIds.clear();
      removeBanner();
      for (const [article, card] of cards) clearCard(article, card);
    }

    const previousViewer = viewer;
    refreshViewer();
    const nextContext = XFPContext.classify(location.pathname, location.search, viewer);
    if (!navigated && previousViewer === viewer && context.kind === 'thread' && nextContext.kind === 'thread') {
      nextContext.participating ||= context.participating;
    }
    if (viewer !== previousViewer) {
      revealedIds.clear();
      pageRevealAll = false;
    }

    const primary = document.querySelector(selectors.primary);
    const scope = primary || document.querySelector('main') || document.body;
    const entries = [];
    if (nextContext.kind !== 'messages') {
      for (const article of scope.querySelectorAll(selectors.tweet)) {
        if (article.closest(selectors.dialog) || article.parentElement?.closest(selectors.tweet)) continue;
        const identity = XFPContext.tweetIdentity(article);
        if (identity) entries.push({ article, identity, isOwn: XFPContext.isOwn(article, identity, viewer) });
      }
    }
    if (!warnedMissingTweets && location.pathname === '/home' && !entries.length) {
      warnedMissingTweets = true;
      console.debug('XFeed Paradise: no recognized home posts yet; waiting for the timeline.');
    }
    const focalIndex = nextContext.focalId ? entries.findIndex(entry => entry.identity.id === nextContext.focalId) : -1;
    if (nextContext.kind === 'thread' && viewer) {
      nextContext.participating ||= entries.some(entry => entry.identity.author === viewer) ||
        (focalIndex >= 0 && XFPContext.repliesTo(entries[focalIndex].article, viewer));
    }

    const contextChanged = context.kind !== nextContext.kind || context.participating !== nextContext.participating;
    context = nextContext;
    const policy = XFPContext.policyFor(context, VibeFilter.settings);
    pageTheme = detectTheme();
    const live = new Set(entries.map(entry => entry.article));
    for (const [article, card] of cards) {
      if (!live.has(article)) clearCard(article, card);
    }

    const hidden = new Set();
    const dimmed = new Set();
    const priorCount = hiddenCount;
    for (const [index, { article, identity, isOwn }] of entries.entries()) {
      let card = cards.get(article);
      const content = article.querySelector(selectors.text)?.textContent || '';
      if (card && (card.tweet.id !== identity.id || card.tweet.text !== content || card.identity.author !== identity.author)) {
        clearCard(article, card);
        card = null;
      }
      if (!card && VibeFilter.settings.enabled) {
        card = processTweet(article, identity, extractTweetData(article, identity, isOwn));
      }
      if (!card) continue;
      card.identity = identity;
      const postedAt = Date.parse(identity.time?.dateTime);
      if (Number.isFinite(postedAt)) card.tweet.timestamp = postedAt;
      card.tweet.isOwn = isOwn;
      card.tweet.feedOwner = viewer || 'unknown';
      if (VibeFilter.settings.enabled) reconcileRefinedScore(article, card, policy);
      // If the canonical focal post is missing or virtualized, the order is uncertain.
      const protectedThreadPost = context.kind === 'thread' && (focalIndex < 0 || index <= focalIndex);
      applyFilter(article, card, protectedThreadPost, policy);
      if (card.presentation === 'stub' || card.presentation === 'hidden') hidden.add(identity.id);
      if (card.presentation === 'dim') dimmed.add(identity.id);
    }
    const countsChanged = pageHidden !== hidden.size || pageDimmed !== dimmed.size;
    pageHidden = hidden.size;
    pageDimmed = dimmed.size;
    renderBanner(primary || (scope === document.body ? null : scope), policy);
    if (force || navigated || contextChanged || countsChanged || priorCount !== hiddenCount) updateFloatingPanel();
  }

  function reprocessVisibleTweets() {
    syncPage(true);
  }

  // History API calls run in X's world. DOM updates and popstate catch most route
  // changes; a location-only check covers pushState/replaceState with no DOM work.
  function observeTweets() {
    const isOwnUI = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)
      ?.closest('[data-xfp-ui], .xfp-floating-panel, .xfp-load-more-container, .xfp-toast');
    const lostStub = node => {
      const article = stubOwners.get(node);
      const card = cards.get(article);
      // Intentional removal changes presentation or drops the card before the
      // observer runs. A row reinserted by us is already back in its slot.
      return article?.isConnected && card?.row === node &&
        card.presentation === 'stub' && node.nextElementSibling !== article;
    };
    const observer = new MutationObserver(mutations => {
      if (route !== routeKey() || (banner && !banner.isConnected) || mutations.some(mutation => {
        if (isOwnUI(mutation.target)) return false;
        if (mutation.type !== 'childList') return true;
        return [...mutation.removedNodes].some(lostStub) ||
          [...mutation.addedNodes, ...mutation.removedNodes].some(node => !isOwnUI(node));
      })) syncPage();
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['href', 'role', 'data-testid', 'datetime']
    });
    // Observe style separately so article-level layout changes do not rescan the feed.
    const themeObserver = new MutationObserver(() => syncPage());
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('popstate', () => syncPage());
    setInterval(() => {
      if (route !== routeKey()) syncPage();
    }, 500);
  }

  XFPContext.watchPreferences(changes => {
    Object.assign(VibeFilter.settings, XFPContext.applyPreferences(VibeFilter.settings, changes));
    updateContextSettings(VibeFilter.settings);
    reprocessVisibleTweets();
  });

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_SETTINGS') {
      VibeFilter.settings = { ...VibeFilter.settings, ...message.settings };
      // Reprocess visible tweets with new settings
      reprocessVisibleTweets();
      sendResponse({ success: true });
    } else if (message.type === 'CLEAR_DATA') {
      // Clear IndexedDB and reset local state
      window.tweetDB.clearAll().then(() => {
        processedTweets.clear();
        hiddenCount = 0;
        hiddenTweets.length = 0;
        revealedIds.clear();
        updateFloatingPanel();
        sendResponse({ success: true });
      }).catch(error => {
        console.error('XFeed Paradise: Error clearing data:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true; // Keep channel open for async response
    } else if (message.type === 'GET_STATS') {
      window.tweetDB.getStats().then(stats => {
        sendResponse({
          stats,
          processedCount: processedTweets.size,
          hiddenCount,
          hiddenTweets: hiddenTweets.slice(0, 20) // Return up to 20 for popup
        });
      });
      return true; // Keep channel open for async response
    } else if (message.type === 'GET_AI_STATUS') {
      sendResponse({
        aiReady: aiProviderReady,
        aiLoading: !aiProviderReady && VibeFilter.settings.useAI,
        provider: VibeFilter.provider.primary,
        aiProgress: 100
      });
    } else if (message.type === 'TOGGLE_ENABLED') {
      VibeFilter.settings.enabled = message.enabled;
      reprocessVisibleTweets();
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_FLOATING_VISIBILITY') {
      const panel = document.querySelector('.xfp-floating-panel');
      if (panel) {
        if (message.visible) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
        VibeFilter.settings.floatingHidden = !message.visible;
      }
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_PROVIDER' || message.type === 'UPDATE_GROQ_API_KEY') {
      // Provider, key or model changed in the popup
      checkProviderStatus().then(() => updateFloatingPanel());
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_CUSTOM_PROMPT') {
      // Update Custom Prompt
      VibeFilter.customPrompt = message.prompt || null;
      console.log('🌴 XFeed Paradise: Custom prompt updated');
      sendResponse({ success: true });
    } else if (message.type === 'GET_DEFAULT_PROMPT') {
      sendResponse({ defaultPrompt: VibeFilter.defaultPrompt });
    } else if (message.type === 'UPDATE_LOAD_MORE_VISIBILITY') {
      const container = document.querySelector('.xfp-load-more-container');
      if (container) {
        if (message.visible) {
          container.classList.remove('hidden');
        } else {
          container.classList.add('hidden');
        }
        VibeFilter.settings.hideLoadMoreButton = !message.visible;
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // Create floating panel UI
  function createFloatingPanel() {
    // Remove existing panel if any
    document.querySelector('.xfp-floating-panel')?.remove();

    // Get saved position
    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    const isHidden = VibeFilter.settings.floatingHidden || false;

    const panel = document.createElement('div');
    panel.className = `xfp-floating-panel pos-${position}`;
    if (isHidden) panel.classList.add('hidden');

    panel.innerHTML = `
      <div class="xfp-floating-dropdown">
        <div class="xfp-dropdown-header">
          <span class="xfp-dropdown-title">🌴 XFeed Paradise</span>
          <button class="xfp-dropdown-close">&times;</button>
        </div>

        <!-- Hidden Tweets Section (collapsible) -->
        <div class="xfp-section">
          <button class="xfp-section-toggle xfp-hidden-toggle expanded">
            <span>Hidden Tweets <span class="xfp-hidden-count-label">(0)</span></span>
            <span class="xfp-toggle-icon">▼</span>
          </button>
          <div class="xfp-section-content xfp-hidden-content show">
            <div class="xfp-dropdown-list">
              <div class="xfp-dropdown-empty">No tweets hidden yet</div>
            </div>
          </div>
        </div>

        <!-- All Settings Section (collapsible) -->
        <div class="xfp-section">
          <button class="xfp-section-toggle xfp-settings-toggle">
            <span>Settings & Stats</span>
            <span class="xfp-toggle-icon">▼</span>
          </button>
          <div class="xfp-section-content xfp-settings-content">
            <!-- Filter Active -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-filter-active-cb" checked>
                <span>Filter Active</span>
              </label>
            </div>

            <!-- Filter Mode -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Filter Mode</label>
              <div class="xfp-setting-options xfp-filter-modes">
                <button class="xfp-setting-btn" data-mode="hide">Hide</button>
                <button class="xfp-setting-btn" data-mode="dim">Dim</button>
                <button class="xfp-setting-btn" data-mode="label">Collapse</button>
              </div>
            </div>

            <fieldset class="xfp-context-settings">
              <legend>Where to filter on X</legend>
            </fieldset>

            <!-- Threshold -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Vibe Threshold</label>
              <div class="xfp-slider-row">
                <input type="range" class="xfp-slider xfp-threshold-slider" min="-50" max="50" value="0">
                <span class="xfp-slider-value xfp-threshold-value">0</span>
              </div>
            </div>

            <!-- Show Scores -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-show-scores-cb">
                <span>Show vibe scores on tweets</span>
              </label>
            </div>

            <div class="xfp-divider"></div>

            <!-- AI Scoring Section -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">AI Scoring</label>
            </div>

            <!-- AI Status -->
            <div class="xfp-setting-row xfp-ai-status-row">
              <div class="xfp-ai-status-inline">
                <span class="xfp-ai-dot"></span>
                <span class="xfp-ai-text">Checking AI…</span>
              </div>
            </div>

            <!-- Use AI Toggle -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-use-ai-cb" checked>
                <span>Use AI-powered scoring</span>
              </label>
            </div>

            <!-- API Key Section (always visible) -->
            <div class="xfp-api-key-section">
              <label class="xfp-setting-label"><span class="xfp-api-key-name">API Key</span> <a class="xfp-api-key-link" href="https://console.groq.com/keys" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 10px;">Get key</a></label>
              <div class="xfp-api-input-row">
                <input type="password" class="xfp-api-input" placeholder="API key">
                <button class="xfp-api-toggle-btn">Show</button>
              </div>
              <div class="xfp-api-status">Choose a provider in the extension popup</div>
            </div>

            <!-- Custom Prompt Section (always visible) -->
            <div class="xfp-prompt-section">
              <label class="xfp-setting-label">Custom Prompt (Optional)</label>
              <textarea class="xfp-prompt-input" placeholder="Rate the sentiment/vibe of this tweet from -100 (very negative, toxic, outrage-bait) to +100 (very positive, uplifting, enlightening)."></textarea>
              <div class="xfp-prompt-hint">Leave empty to use default. Must ask for a number -100 to 100.</div>
            </div>

            <div class="xfp-divider"></div>

            <!-- Stats -->
            <div class="xfp-setting-row xfp-stats-row">
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-hidden">0</span>
                <span class="xfp-stat-label">Filtered this session</span>
              </div>
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-processed">0</span>
                <span class="xfp-stat-label">Processed</span>
              </div>
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-saved">0</span>
                <span class="xfp-stat-label">Saved</span>
              </div>
            </div>

            <div class="xfp-divider"></div>

            <!-- Button Position -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Button Position</label>
              <div class="xfp-setting-options xfp-positions">
                <button class="xfp-setting-btn" data-pos="bottom-right">↘</button>
                <button class="xfp-setting-btn" data-pos="bottom-left">↙</button>
                <button class="xfp-setting-btn" data-pos="top-right">↗</button>
                <button class="xfp-setting-btn" data-pos="top-left">↖</button>
                <button class="xfp-setting-btn" data-pos="middle-right">→</button>
              </div>
            </div>

            <!-- Hide Button -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-hide-btn-cb">
                <span>Hide floating button</span>
              </label>
            </div>

            <!-- Debug Mode -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-debug-mode-cb">
                <span>Debug mode (console logs)</span>
              </label>
            </div>

            <!-- Clear Data -->
            <div class="xfp-setting-row">
              <button class="xfp-clear-data-btn">Clear stored data</button>
            </div>
          </div>
        </div>
      </div>
      <button class="xfp-floating-btn">
        <span class="xfp-floating-btn-icon">🌴</span>
        <span class="xfp-floating-badge">0</span>
      </button>
    `;

    document.body.appendChild(panel);

    // Toggle dropdown
    const btn = panel.querySelector('.xfp-floating-btn');
    const dropdown = panel.querySelector('.xfp-floating-dropdown');
    const closeBtn = panel.querySelector('.xfp-dropdown-close');

    // Restore dropdown open state from storage
    chrome.storage.local.get('floatingDropdownOpen', (result) => {
      if (result.floatingDropdownOpen) {
        dropdown.classList.add('show');
        updateFloatingPanel();
      }
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShowing = dropdown.classList.toggle('show');
      chrome.storage.local.set({ floatingDropdownOpen: isShowing });
      if (isShowing) {
        updateFloatingPanel();
      }
    });

    closeBtn.addEventListener('click', () => {
      dropdown.classList.remove('show');
      chrome.storage.local.set({ floatingDropdownOpen: false });
    });

    // Hidden tweets section toggle
    const hiddenToggle = panel.querySelector('.xfp-hidden-toggle');
    const hiddenContent = panel.querySelector('.xfp-hidden-content');

    chrome.storage.local.get('floatingHiddenExpanded', (result) => {
      if (result.floatingHiddenExpanded === false) {
        hiddenToggle.classList.remove('expanded');
        hiddenContent.classList.remove('show');
      }
    });

    hiddenToggle.addEventListener('click', () => {
      hiddenToggle.classList.toggle('expanded');
      hiddenContent.classList.toggle('show');
      chrome.storage.local.set({ floatingHiddenExpanded: hiddenContent.classList.contains('show') });
    });

    // Custom Prompt textarea (auto-saves on blur)
    const promptInput = panel.querySelector('.xfp-prompt-input');
    if (promptInput) {
      // Load current prompt
      promptInput.value = VibeFilter.customPrompt || '';

      // Auto-save on blur
      promptInput.addEventListener('blur', async () => {
        const newPrompt = promptInput.value.trim();
        const valueToSave = newPrompt === '' ? null : newPrompt;
        if (valueToSave !== VibeFilter.customPrompt) {
          VibeFilter.customPrompt = valueToSave;
          await VibeFilter.saveCustomPrompt(valueToSave);
          showToast(valueToSave ? 'Custom prompt saved!' : 'Using default prompt', 'info', 2000);
        }
      });
    }

    // API Key toggle button
    const apiToggleBtn = panel.querySelector('.xfp-api-toggle-btn');
    const apiInput = panel.querySelector('.xfp-api-key-section .xfp-api-input');
    const apiStatus = panel.querySelector('.xfp-api-status');

    if (apiToggleBtn && apiInput) {
      // Load the active provider's key (masked)
      const syncProviderKeyField = async () => {
        const config = await XFPProviders.loadConfig();
        const def = XFPProviders.PROVIDERS[config.primary];
        const name = XFPProviders.displayName(config.primary);
        if (document.activeElement !== apiInput) apiInput.value = config.providers[config.primary].apiKey || '';
        apiInput.placeholder = def.keyPlaceholder || 'API key';
        const nameEl = panel.querySelector('.xfp-api-key-name');
        const linkEl = panel.querySelector('.xfp-api-key-link');
        if (nameEl) nameEl.textContent = `${name} API Key${def.keyOptional ? ' (optional)' : ''}`;
        if (linkEl) {
          linkEl.style.display = def.keyUrl ? '' : 'none';
          if (def.keyUrl) linkEl.href = def.keyUrl;
        }
        if (apiStatus) {
          const status = (await XFPProviders.loadStatuses())[config.primary];
          apiStatus.textContent = XFPProviders.describeStatus(config.providers[config.primary], status).label;
        }
      };
      syncProviderKeyField();
      VibeFilter.watchProviderConfig(syncProviderKeyField);

      apiToggleBtn.addEventListener('click', () => {
        if (apiInput.type === 'password') {
          apiInput.type = 'text';
          apiToggleBtn.textContent = 'Hide';
        } else {
          apiInput.type = 'password';
          apiToggleBtn.textContent = 'Show';
        }
      });

      // Save API key on change
      apiInput.addEventListener('change', async () => {
        const newKey = apiInput.value.trim();
        await VibeFilter.saveActiveProviderKey(newKey);
        initAIScorer();
        if (apiStatus) {
          const name = VibeFilter.provider.primaryName;
          apiStatus.textContent = newKey
            ? `${name} key saved. Use Test connection in the extension popup to verify it.`
            : `Add your ${name} key to enable AI scoring`;
        }
      });
    }

    // Settings section toggle
    const settingsToggle = panel.querySelector('.xfp-settings-toggle');
    const settingsContent = panel.querySelector('.xfp-settings-content');

    chrome.storage.local.get('floatingSettingsExpanded', (result) => {
      if (result.floatingSettingsExpanded) {
        settingsToggle.classList.add('expanded');
        settingsContent.classList.add('show');
      }
    });

    settingsToggle.addEventListener('click', () => {
      settingsToggle.classList.toggle('expanded');
      settingsContent.classList.toggle('show');
      chrome.storage.local.set({ floatingSettingsExpanded: settingsContent.classList.contains('show') });
    });

    // Filter Active checkbox
    const filterActiveCb = panel.querySelector('.xfp-filter-active-cb');
    filterActiveCb.addEventListener('change', () => {
      VibeFilter.settings.enabled = filterActiveCb.checked;
      VibeFilter.saveSettings({ enabled: filterActiveCb.checked });
      reprocessVisibleTweets();
    });

    // Filter mode buttons
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        VibeFilter.settings.filterMode = btn.dataset.mode;
        VibeFilter.saveSettings({ filterMode: btn.dataset.mode });
        reprocessVisibleTweets();
      });
    });

    // Threshold slider
    const thresholdSlider = panel.querySelector('.xfp-threshold-slider');
    const thresholdValue = panel.querySelector('.xfp-threshold-value');
    thresholdSlider.addEventListener('input', () => {
      thresholdValue.textContent = thresholdSlider.value;
    });
    thresholdSlider.addEventListener('change', () => {
      VibeFilter.settings.threshold = parseInt(thresholdSlider.value);
      VibeFilter.saveSettings({ threshold: parseInt(thresholdSlider.value) });
      reprocessVisibleTweets();
    });

    // Show scores checkbox
    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    showScoresCb.addEventListener('change', () => {
      VibeFilter.settings.showScores = showScoresCb.checked;
      VibeFilter.saveSettings({ showScores: showScoresCb.checked });
      reprocessVisibleTweets();
    });

    // Debug mode checkbox
    const debugModeCb = panel.querySelector('.xfp-debug-mode-cb');
    debugModeCb.addEventListener('change', () => {
      VibeFilter.settings.debugMode = debugModeCb.checked;
      VibeFilter.saveSettings({ debugMode: debugModeCb.checked });
      if (debugModeCb.checked) {
        console.log('🌴 XFP Debug mode enabled. API status:', VibeFilter.getApiStatus());
      }
    });

    // Use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    useAiCb.addEventListener('change', () => {
      VibeFilter.settings.useAI = useAiCb.checked;
      VibeFilter.saveSettings({ useAI: useAiCb.checked });
      if (useAiCb.checked && !aiProviderReady) {
        initAIScorer();
      }
      reprocessVisibleTweets();
    });

    // Position buttons
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panel.className = `xfp-floating-panel pos-${btn.dataset.pos}`;
        VibeFilter.settings.floatingPosition = btn.dataset.pos;
        VibeFilter.saveSettings({ floatingPosition: btn.dataset.pos });
      });
    });

    // Hide button checkbox
    const hideBtnCb = panel.querySelector('.xfp-hide-btn-cb');
    hideBtnCb.addEventListener('change', () => {
      if (hideBtnCb.checked) {
        panel.classList.add('hidden');
        VibeFilter.settings.floatingHidden = true;
        VibeFilter.saveSettings({ floatingHidden: true });
      }
    });

    // Clear data button
    const clearDataBtn = panel.querySelector('.xfp-clear-data-btn');
    clearDataBtn.addEventListener('click', async () => {
      if (confirm('Clear all stored tweet data?')) {
        await window.tweetDB.clearAll();
        processedTweets.clear();
        hiddenCount = 0;
        hiddenTweets.length = 0;
        revealedIds.clear();
        updateFloatingPanel();
      }
    });

    // Note: Removed "click outside to close" behavior so dropdown persists during navigation
    // User can close via palm tree button toggle or X button

    return panel;
  }

  // Update floating panel content
  async function updateFloatingPanel() {
    const panel = document.querySelector('.xfp-floating-panel');
    if (!panel) return;

    const badge = panel.querySelector('.xfp-floating-badge');
    const list = panel.querySelector('.xfp-dropdown-list');
    const aiDot = panel.querySelector('.xfp-ai-dot');
    const aiText = panel.querySelector('.xfp-ai-text');
    const hiddenCountLabel = panel.querySelector('.xfp-hidden-count-label');

    // Update badge and hidden count label
    if (badge) {
      const count = VibeFilter.settings.enabled && XFPContext.policyFor(context, VibeFilter.settings) !== 'off'
        ? pageHidden + pageDimmed : 0;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
    const btn = panel.querySelector('.xfp-floating-btn');
    const paused = VibeFilter.settings.enabled && XFPContext.policyFor(context, VibeFilter.settings) === 'off';
    btn.classList.toggle('xfp-paused', paused);
    btn.title = paused ? 'XFeed Paradise · Filter paused here' : 'XFeed Paradise';
    btn.setAttribute('aria-label', btn.title);
    if (hiddenCountLabel) {
      hiddenCountLabel.textContent = `(${hiddenCount})`;
    }

    // Update AI status (active provider and optional fallback)
    if (aiDot && aiText) {
      const p = VibeFilter.provider;
      if (VibeFilter.settings.useAI === false) {
        aiDot.classList.remove('ready');
        aiText.textContent = 'AI disabled';
      } else if (VibeFilter.hasAI()) {
        aiDot.classList.add('ready');
        const lead = p.primaryConfigured ? `${p.primaryName} configured` : `${p.fallbackName} configured`;
        aiText.textContent = p.primaryConfigured && p.fallbackName ? `${lead} · fallback ${p.fallbackName}` : lead;
      } else if (p.configured) {
        aiDot.classList.remove('ready');
        aiText.textContent = 'AI unavailable · keywords for now';
      } else {
        aiDot.classList.remove('ready');
        aiText.textContent = `Keywords only · add your ${p.primaryName} key`;
      }
    }

    // Update hidden tweets list
    if (list) {
      if (hiddenTweets.length === 0) {
        list.innerHTML = '<div class="xfp-dropdown-empty">No tweets hidden yet</div>';
      } else {
        list.innerHTML = hiddenTweets.slice(0, 20).map(tweet => `
          <div class="xfp-dropdown-item" data-url="${tweet.url}">
            <div class="xfp-dropdown-author">@${tweet.authorHandle}</div>
            <div class="xfp-dropdown-text">${escapeHtml(tweet.text)}</div>
            <div class="xfp-dropdown-meta">
              <span>${tweet.vibeLabel}</span>
              <span>Score: ${tweet.score}</span>
              <span>${escapeHtml(tweet.contextLabel)}</span>
            </div>
          </div>
        `).join('');

        // Add click handlers
        list.querySelectorAll('.xfp-dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            window.open(item.dataset.url, '_blank');
          });
        });
      }
    }

    // Update filter active checkbox
    const filterActiveCb = panel.querySelector('.xfp-filter-active-cb');
    if (filterActiveCb) {
      filterActiveCb.checked = VibeFilter.settings.enabled !== false;
    }

    // Update filter mode buttons
    const filterMode = VibeFilter.settings.filterMode || 'hide';
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === filterMode);
    });

    // Update threshold slider
    const thresholdSlider = panel.querySelector('.xfp-threshold-slider');
    const thresholdValue = panel.querySelector('.xfp-threshold-value');
    if (thresholdSlider && thresholdValue) {
      thresholdSlider.value = VibeFilter.settings.threshold || 0;
      thresholdValue.textContent = VibeFilter.settings.threshold || 0;
    }

    // Update show scores checkbox
    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    if (showScoresCb) {
      showScoresCb.checked = VibeFilter.settings.showScores || false;
    }

    // Update debug mode checkbox
    const debugModeCb = panel.querySelector('.xfp-debug-mode-cb');
    if (debugModeCb) {
      debugModeCb.checked = VibeFilter.settings.debugMode || false;
    }

    // Update use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    if (useAiCb) {
      useAiCb.checked = VibeFilter.settings.useAI !== false;
    }

    // Update position buttons
    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pos === position);
    });

    // Update stats
    try {
      const stats = await window.tweetDB.getStats();
      const statHidden = panel.querySelector('.xfp-stat-hidden');
      const statProcessed = panel.querySelector('.xfp-stat-processed');
      const statSaved = panel.querySelector('.xfp-stat-saved');

      if (statHidden) statHidden.textContent = hiddenCount;
      if (statProcessed) statProcessed.textContent = processedTweets.size;
      if (statSaved) statSaved.textContent = stats?.tweetCount || 0;
    } catch (error) {
      console.warn('Could not update stats:', error);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // Create "Load More" button at bottom of feed
  async function createLoadMoreButton() {
    // Remove existing if any
    document.querySelector('.xfp-load-more-container')?.remove();

    const container = document.createElement('div');
    container.className = 'xfp-load-more-container';

    // Check if button should be hidden (from storage)
    const result = await chrome.storage.sync.get('xfp_load_more_enabled');
    const isEnabled = result.xfp_load_more_enabled !== false; // Default ON
    if (!isEnabled) {
      container.classList.add('hidden');
    }

    container.innerHTML = `
      <button class="xfp-load-more-btn">
        <span class="icon">🌴</span>
        <span class="text">Load More</span>
      </button>
    `;

    const btn = container.querySelector('.xfp-load-more-btn');
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('loading')) return;

      btn.classList.add('loading');
      btn.querySelector('.text').textContent = 'Loading...';
      btn.querySelector('.icon').innerHTML = '<div class="xfp-load-more-spinner"></div>';

      // Scroll down to trigger Twitter's infinite scroll
      const scrollAmount = window.innerHeight * 2;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });

      // Wait for new content to load
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Reset button state
      btn.classList.remove('loading');
      btn.querySelector('.text').textContent = 'Load More';
      btn.querySelector('.icon').innerHTML = '🌴';

      // Re-position the button at the new bottom
      positionLoadMoreButton();
    });

    return container;
  }

  // Position the Load More button at the bottom of the timeline
  function positionLoadMoreButton() {
    const container = document.querySelector('.xfp-load-more-container');
    if (!container) return;

    // Find the timeline container
    const timeline = document.querySelector(`${selectors.primary} ${selectors.timeline}`);
    if (!timeline) return;

    // Move to end of timeline if not already there
    const lastChild = timeline.lastElementChild;
    if (lastChild !== container) {
      timeline.appendChild(container);
    }
  }

  // Initialize Load More button
  let loadMoreContainer = null;
  (async () => {
    loadMoreContainer = await createLoadMoreButton();

    // Observe for timeline to appear and position button
    const timelineObserver = new MutationObserver(() => {
      const timeline = document.querySelector(`${selectors.primary} ${selectors.timeline}`);
      if (timeline && loadMoreContainer && !timeline.querySelector('.xfp-load-more-container')) {
        timeline.appendChild(loadMoreContainer);
      }
    });
    timelineObserver.observe(document.body, { childList: true, subtree: true });

    // Also try to add immediately
    const timeline = document.querySelector(`${selectors.primary} ${selectors.timeline}`);
    if (timeline && loadMoreContainer) {
      timeline.appendChild(loadMoreContainer);
    }
  })();

  // Create the floating panel
  const floatingPanel = createFloatingPanel();

  const updateContextSettings = XFPContext.mountSettings(
    floatingPanel.querySelector('.xfp-context-settings'), VibeFilter.settings
  );

  syncPage(true);
  observeTweets();

  // Log stats periodically
  setInterval(async () => {
    const stats = await window.tweetDB.getStats();
    console.log(`🌴 XFeed Paradise: ${stats.tweetCount} tweets collected, ${processedTweets.size} processed this session`);
  }, 60000);

  console.log('🌴 XFeed Paradise: Active and filtering your feed!');
})();
