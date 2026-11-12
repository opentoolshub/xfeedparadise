// XFeed Paradise - Paradise Reader (phone) popup section.
// Opt-in, off by default. All network work happens in the background worker
// (sync.js); this file only renders state and forwards the user's choices.
(function () {
  'use strict';

  const DEFAULT_ISSUER_ORIGIN = 'https://id.ideaflow.app';
  const $ = id => document.getElementById(id);
  let current = null;

  function send(type, extra = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type, ...extra }, response => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: 'No response' });
      });
    });
  }

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function render(st) {
    current = st;
    const on = Boolean(st.optIn);
    const signedIn = Boolean(st.signedIn);
    $('readerOptIn').checked = on;
    const pill = $('readerPill');
    pill.textContent = !on ? 'Off' : signedIn ? 'On' : 'Sign in';
    pill.className = `reader-pill${on && signedIn ? ' on' : on ? ' warn' : ''}`;
    $('readerSignIn').hidden = !on || signedIn;
    $('readerAccount').hidden = !signedIn;
    $('readerAccountName').textContent = signedIn ? `Signed in${st.account && st.account.name ? ` as ${st.account.name}` : ''}` : '';
    $('readerDelete').hidden = !signedIn;

    const status = $('readerStatus');
    status.classList.toggle('error', Boolean(st.lastError));
    if (st.lastError) {
      status.textContent = st.lastError;
    } else if (!on) {
      status.textContent = 'Off. Nothing is uploaded.';
    } else if (!signedIn) {
      status.textContent = 'Sign in to start syncing.';
    } else if (st.lastSyncAt) {
      const n = Number(st.syncedTotal) || 0;
      status.textContent = `Synced ${n.toLocaleString()} post${n === 1 ? '' : 's'} · ${ago(st.lastSyncAt)}${st.pending ? ` · ${st.pending} waiting` : ''}`;
    } else {
      status.textContent = st.pending ? `${st.pending} waiting to sync` : 'Waiting for posts. Scroll X to sync.';
    }

    const link = $('readerLink');
    link.href = st.readerUrl || '#';
    link.textContent = `Open on your phone: ${String(st.readerUrl || '').replace(/^https?:\/\//, '')}`;
    link.hidden = !st.readerUrl;
  }

  async function refresh() {
    const res = await send('XFP_READER_STATUS');
    if (res.ok) render(res.result);
  }

  function setExpanded(expanded) {
    $('readerToggle').classList.toggle('expanded', expanded);
    $('readerContent').classList.toggle('show', expanded);
  }

  document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get('popupReaderExpanded', r => setExpanded(r.popupReaderExpanded === true));
    $('readerToggle').addEventListener('click', () => {
      const expanded = !$('readerContent').classList.contains('show');
      setExpanded(expanded);
      chrome.storage.local.set({ popupReaderExpanded: expanded });
    });

    // Turning on requires reading the disclosure and confirming.
    $('readerOptIn').addEventListener('change', async e => {
      if (e.target.checked) {
        e.target.checked = false;
        $('readerConsent').hidden = false;
        return;
      }
      $('readerConsent').hidden = true;
      const res = await send('XFP_READER_SET_OPT_IN', { on: false });
      if (res.ok) render({ ...current, ...res.result });
    });
    $('readerConsentNo').addEventListener('click', () => { $('readerConsent').hidden = true; });
    $('readerConsentYes').addEventListener('click', async () => {
      $('readerConsent').hidden = true;
      await send('XFP_READER_SET_OPT_IN', { on: true });
      refresh();
    });

    $('readerSignIn').addEventListener('click', async () => {
      const btn = $('readerSignIn');
      btn.disabled = true;
      try {
        // Ideaflow ID's token endpoint has no CORS; the worker needs host access.
        const granted = await chrome.permissions.request({ origins: [`${DEFAULT_ISSUER_ORIGIN}/*`] });
        if (!granted) {
          $('readerStatus').textContent = 'Sign-in needs permission to reach id.ideaflow.app.';
          return;
        }
        $('readerStatus').textContent = 'Opening Ideaflow sign-in…';
        const res = await send('XFP_READER_SIGN_IN');
        if (!res.ok) {
          $('readerStatus').textContent = res.error || 'Sign-in failed.';
          $('readerStatus').classList.add('error');
          return;
        }
        refresh();
      } finally {
        btn.disabled = false;
      }
    });

    $('readerSignOut').addEventListener('click', async () => {
      await send('XFP_READER_SIGN_OUT');
      refresh();
    });

    $('readerDelete').addEventListener('click', async () => {
      if (!confirm('Delete every post saved in your Paradise Reader? This cannot be undone.')) return;
      const res = await send('XFP_READER_DELETE_ALL');
      if (res.ok) {
        await refresh();
        $('readerStatus').textContent = `Deleted ${Number(res.result) || 0} saved posts.`;
      } else {
        $('readerStatus').textContent = res.error || 'Delete failed.';
        $('readerStatus').classList.add('error');
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.xfpReader || changes.xfpReaderAuth)) refresh();
    });
    refresh();
  });
})();
