// Instagram Home visibility only. Keep all decisions on the page.
(() => {
  const marker = 'data-xfp-instagram-suggested';
  const feed = 'main article, [role="main"] article';
  const rootMode = 'data-xfp-instagram-home';
  let mode = 'off';
  let enabled = true;
  let scheduled = false;

  function refresh() {
    scheduled = false;
    const home = enabled && location.pathname === '/' && ['all', 'suggested'].includes(mode);
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
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  const observer = new MutationObserver(schedule);
  function configure() {
    observer.disconnect();
    if (enabled && ['all', 'suggested'].includes(mode)) {
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
    mode = settings.instagramHomeMode;
    enabled = settings.vibeFilterSettings?.enabled !== false;
    configure();
  }
  window.addEventListener('popstate', refresh);
  window.addEventListener('pageshow', refresh);
  window.navigation?.addEventListener('currententrychange', refresh);
  load();
})();
