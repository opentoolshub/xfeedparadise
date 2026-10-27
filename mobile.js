// XFeed Paradise - Platform and touch support
// Loaded first in every content-script list, so it must not depend on the
// other scripts. Safe no-op on desktop Chrome.

(function() {
  'use strict';

  // Safari Web Extensions always expose `browser` and usually `chrome` too;
  // the rest of the extension is written against `chrome`, so alias it when
  // only `browser` exists.
  if (typeof globalThis.chrome === 'undefined' && typeof globalThis.browser !== 'undefined') {
    globalThis.chrome = globalThis.browser;
  }

  // Touch screens have no hover, so a dimmed post could never be peeked at.
  // On touch devices the first tap on a dimmed post reveals it (instead of
  // opening it); later taps behave normally.
  const touchOnly = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
  if (!touchOnly) return;

  document.addEventListener('click', (event) => {
    const target = event.target;
    const dimmed = target && target.closest ? target.closest('.xfp-dimmed') : null;
    if (!dimmed || dimmed.classList.contains('xfp-revealed')) return;
    event.preventDefault();
    event.stopPropagation();
    dimmed.classList.add('xfp-revealed');
  }, true);
})();
