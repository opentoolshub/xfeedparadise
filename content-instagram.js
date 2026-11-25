// Instagram Home visibility only. Keep all decisions on the page.
(() => {
  const marker = 'data-xfp-instagram-suggested';
  const feed = 'main article, [role="main"] article';
  const rootMode = 'data-xfp-instagram-home';
  let mode = 'off';
  let enabled = true;
  let scheduled = false;
  let lastPath;
  let routeTimer;

  function refresh() {
    scheduled = false;
    lastPath = location.pathname;
    const home = enabled && lastPath === '/' && ['all', 'suggested'].includes(mode);
    if (!home) {
      document.documentElement.removeAttribute(rootMode);
      return;
    }
    if (mode === 'suggested') {
      for (const post of document.querySelectorAll(feed)) {
        // Only accept explicit recommendation labels in post headers. A caption
        // or comment containing the same words is still an ordinary post.
        const labels = post.querySelectorAll('header span, header [aria-label]');
        const suggested = Array.from(labels).some(label =>
          [label.textContent, label.getAttribute('aria-label')].some(
            value => value?.trim().toLowerCase() === 'suggested for you'));
        post.toggleAttribute(marker, suggested);
      }
    }
    document.documentElement.setAttribute(rootMode, mode);
  }

  function schedule() {
    if (location.pathname !== lastPath) {
      refresh();
      return;
    }
    if (mode !== 'suggested' || lastPath !== '/' || scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  const observer = new MutationObserver(schedule);
  function configure() {
    observer.disconnect();
    clearInterval(routeTimer);
    if (enabled && ['all', 'suggested'].includes(mode)) {
      // Older WebKit can change routes without a navigation event or DOM edit.
      routeTimer = setInterval(() => {
        if (location.pathname !== lastPath) refresh();
      }, 250);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    refresh();
  }
  let revision = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('instagramHomeMode' in changes || 'vibeFilterSettings' in changes)) return;
    load();
  });
  async function load() {
    const current = ++revision;
    const settings = await chrome.storage.sync.get(['instagramHomeMode', 'vibeFilterSettings']);
    if (current !== revision) return;
    mode = settings.instagramHomeMode ?? 'suggested';
    enabled = settings.vibeFilterSettings?.enabled !== false;
    configure();
  }
  window.addEventListener('popstate', refresh);
  window.addEventListener('pageshow', refresh);
  window.navigation?.addEventListener('currententrychange', refresh);
  load();
})();
