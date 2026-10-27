// XFeed Paradise - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  // Load current settings
  const settings = await loadSettings();

  // Initialize UI with current settings
  document.getElementById('enableToggle').checked = settings.enabled;
  document.getElementById('thresholdSlider').value = settings.threshold;
  document.getElementById('thresholdValue').textContent = settings.threshold;
  document.getElementById('showScores').checked = settings.showScores;
  document.getElementById('useAI').checked = settings.useAI !== false;
  document.getElementById('showFloatingBtn').checked = !settings.floatingHidden;

  // Set active mode button
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.filterMode);
  });

  // Load stats and AI status
  updateStats();
  updateAIStatus();
  updateHiddenTweetsList();

  // Restore collapsible section states
  chrome.storage.local.get(['popupHiddenExpanded', 'popupSettingsExpanded'], (result) => {
    // Default: hidden tweets expanded, settings collapsed
    const hiddenExpanded = result.popupHiddenExpanded !== false;
    const settingsExpanded = result.popupSettingsExpanded === true;

    const hiddenToggle = document.getElementById('hiddenTweetsToggle');
    const hiddenContent = document.getElementById('hiddenTweetsContent');
    const settingsToggle = document.getElementById('settingsToggle');
    const settingsContent = document.getElementById('settingsContent');

    if (hiddenExpanded) {
      hiddenToggle.classList.add('expanded');
      hiddenContent.classList.add('show');
    } else {
      hiddenToggle.classList.remove('expanded');
      hiddenContent.classList.remove('show');
    }

    if (settingsExpanded) {
      settingsToggle.classList.add('expanded');
      settingsContent.classList.add('show');
    } else {
      settingsToggle.classList.remove('expanded');
      settingsContent.classList.remove('show');
    }
  });

  // Hidden tweets section toggle
  document.getElementById('hiddenTweetsToggle').addEventListener('click', () => {
    const toggle = document.getElementById('hiddenTweetsToggle');
    const content = document.getElementById('hiddenTweetsContent');
    toggle.classList.toggle('expanded');
    content.classList.toggle('show');
    chrome.storage.local.set({ popupHiddenExpanded: content.classList.contains('show') });
  });

  // Settings section toggle
  document.getElementById('settingsToggle').addEventListener('click', () => {
    const toggle = document.getElementById('settingsToggle');
    const content = document.getElementById('settingsContent');
    toggle.classList.toggle('expanded');
    content.classList.toggle('show');
    chrome.storage.local.set({ popupSettingsExpanded: content.classList.contains('show') });
  });

  // Event listeners
  document.getElementById('enableToggle').addEventListener('change', async (e) => {
    await saveSettings({ enabled: e.target.checked });
    sendToContentScript({ type: 'TOGGLE_ENABLED', enabled: e.target.checked });
  });

  document.getElementById('thresholdSlider').addEventListener('input', (e) => {
    document.getElementById('thresholdValue').textContent = e.target.value;
  });

  document.getElementById('thresholdSlider').addEventListener('change', async (e) => {
    await saveSettings({ threshold: parseInt(e.target.value) });
    sendToContentScript({ type: 'UPDATE_SETTINGS', settings: { threshold: parseInt(e.target.value) } });
    showRefreshNotice();
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await saveSettings({ filterMode: btn.dataset.mode });
      sendToContentScript({ type: 'UPDATE_SETTINGS', settings: { filterMode: btn.dataset.mode } });
      showRefreshNotice();
    });
  });

  document.getElementById('showScores').addEventListener('change', async (e) => {
    await saveSettings({ showScores: e.target.checked });
    sendToContentScript({ type: 'UPDATE_SETTINGS', settings: { showScores: e.target.checked } });
    showRefreshNotice();
  });

  document.getElementById('showFloatingBtn').addEventListener('change', async (e) => {
    await saveSettings({ floatingHidden: !e.target.checked });
    sendToContentScript({ type: 'UPDATE_FLOATING_VISIBILITY', visible: e.target.checked });
  });

  // Site feature flags
  const twitterToggle = document.getElementById('twitterEnabled');
  const googleNewsToggle = document.getElementById('googleNewsEnabled');

  // Load site settings
  chrome.storage.sync.get(['xfp_twitter_enabled', 'xfp_google_news_enabled'], (result) => {
    // Both default to ON
    twitterToggle.checked = result.xfp_twitter_enabled !== false;
    googleNewsToggle.checked = result.xfp_google_news_enabled !== false;
  });

  // Save Twitter setting
  twitterToggle.addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ xfp_twitter_enabled: e.target.checked });
    showRefreshNotice();
  });

  // Save Google News setting
  googleNewsToggle.addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ xfp_google_news_enabled: e.target.checked });
    showRefreshNotice();
  });

  // Load More button toggle
  const loadMoreToggle = document.getElementById('loadMoreEnabled');

  // Load Load More setting
  chrome.storage.sync.get(['xfp_load_more_enabled'], (result) => {
    // Load More defaults to ON
    loadMoreToggle.checked = result.xfp_load_more_enabled !== false;
  });

  // Save Load More setting
  loadMoreToggle.addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ xfp_load_more_enabled: e.target.checked });
    sendToContentScript({ type: 'UPDATE_LOAD_MORE_VISIBILITY', visible: e.target.checked });
  });

  document.getElementById('useAI').addEventListener('change', async (e) => {
    await saveSettings({ useAI: e.target.checked });
    sendToContentScript({ type: 'UPDATE_SETTINGS', settings: { useAI: e.target.checked } });
    updateAIStatus();
    showRefreshNotice();
  });

  // ---- AI provider settings: one active provider, optional fallback ----
  const P = XFPProviders;
  const $ = id => document.getElementById(id);
  const customPromptInput = $('customPrompt');
  const slots = {
    primary: {
      select: $('providerSelect'), key: $('providerApiKey'), toggle: $('toggleApiKey'),
      keyLabel: $('providerKeyLabel'), keyLink: $('providerKeyLink'), keyHint: $('providerKeyHint'),
      baseUrlRow: $('providerBaseUrlRow'), baseUrl: $('providerBaseUrl'), model: $('providerModel'),
      test: $('testProvider')
    },
    fallback: {
      select: $('fallbackSelect'), fields: $('fallbackFields'), key: $('fallbackApiKey'), toggle: $('toggleFallbackKey'),
      keyLabel: $('fallbackKeyLabel'), keyLink: $('fallbackKeyLink'), keyHint: $('fallbackKeyHint'),
      baseUrlRow: $('fallbackBaseUrlRow'), baseUrl: $('fallbackBaseUrl'), model: $('fallbackModel'),
      test: $('testFallback')
    }
  };
  let providerConfig = await P.loadConfig();

  function addOption(select, value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  for (const id of P.ORDER) {
    addOption(slots.primary.select, id, id === 'groq' ? `${P.PROVIDERS[id].name} (free key)` : P.PROVIDERS[id].name);
  }
  addOption(slots.fallback.select, '', 'None (keywords only)');
  for (const id of P.ORDER) addOption(slots.fallback.select, id, P.PROVIDERS[id].name);

  const selectedId = slotName => slots[slotName].select.value || null;

  function renderSlot(slotName) {
    const slot = slots[slotName];
    const id = selectedId(slotName);
    if (slot.fields) slot.fields.hidden = !id;
    if (!id) return;
    const def = P.PROVIDERS[id];
    const entry = providerConfig.providers[id];
    // The built-in provider needs no key or model: hide those fields.
    for (const el of [slot.keyLabel.parentElement, slot.key.parentElement, slot.model.parentElement]) {
      if (el) el.style.display = def.noKey ? 'none' : '';
    }
    slot.keyLabel.textContent = `${P.displayName(id)} API key${def.keyOptional ? ' (optional)' : ''}`;
    slot.keyLink.hidden = !def.keyUrl;
    if (def.keyUrl) slot.keyLink.href = def.keyUrl;
    slot.keyHint.textContent = def.keyHint || '';
    slot.key.value = entry.apiKey;
    slot.key.placeholder = def.keyPlaceholder || '';
    slot.baseUrlRow.hidden = !def.customBaseUrl;
    slot.baseUrl.value = def.customBaseUrl ? entry.baseUrl : '';
    slot.model.value = entry.model;
    slot.model.placeholder = def.defaultModel || 'Model name, e.g. llama3.2';
  }

  function renderPrivacy() {
    const target = id => (P.PROVIDERS[id].noKey ? 'the XFeed Paradise scoring server'
      : P.PROVIDERS[id].customBaseUrl ? 'your custom endpoint' : P.displayName(id));
    const fallback = providerConfig.fallback;
    const usesBuiltin = [providerConfig.primary, fallback].some(id => id && P.PROVIDERS[id].noKey);
    const usesOwnKey = [providerConfig.primary, fallback].some(id => id && !P.PROVIDERS[id].noKey);
    $('providerPrivacy').textContent = `AI scoring sends post text to ${target(providerConfig.primary)}` +
      `${fallback ? ` (or ${target(fallback)} as fallback)` : ''}${usesOwnKey ? ', using your key' : ''}. ` +
      (usesBuiltin ? 'The scoring server forwards it to OpenAI or TypeSafe for scoring and does not keep it. ' : '') +
      'Feed items are not uploaded to a community database.';
    // The fallback cannot be the same provider as the primary.
    for (const option of slots.fallback.select.options) {
      option.disabled = option.value !== '' && option.value === providerConfig.primary;
    }
  }

  function renderAll() {
    slots.primary.select.value = providerConfig.primary;
    slots.fallback.select.value = providerConfig.fallback || '';
    renderSlot('primary');
    renderSlot('fallback');
    renderPrivacy();
  }

  function readSlot(slotName) {
    const slot = slots[slotName];
    return { apiKey: slot.key.value.trim(), model: slot.model.value.trim(), baseUrl: slot.baseUrl.value.trim() };
  }

  // Ask for the provider's host permission. Starts synchronously so the
  // request happens inside the user gesture that triggered it.
  function requestPermission(slotName) {
    const id = selectedId(slotName);
    if (!id) return Promise.resolve(false);
    if (P.PROVIDERS[id].requiredPermission) return Promise.resolve(true);
    const origin = P.permissionOrigin(id, slots[slotName].baseUrl.value.trim());
    if (!origin || !chrome.permissions) return Promise.resolve(false);
    return chrome.permissions.request({ origins: [origin] }).catch(() => false);
  }

  async function hasPermission(id) {
    if (P.PROVIDERS[id].requiredPermission) return true;
    const origin = P.permissionOrigin(id, providerConfig.providers[id].baseUrl);
    if (!origin) return false;
    try { return await chrome.permissions.contains({ origins: [origin] }); } catch (e) { return false; }
  }

  async function saveSlot(slotName) {
    const id = selectedId(slotName);
    if (!id) return;
    await P.saveProvider(id, readSlot(slotName));
    providerConfig = await P.loadConfig();
    sendToContentScript({ type: 'UPDATE_PROVIDER' });
    updateAIStatus();
  }

  async function testSlot(slotName, granted) {
    const id = selectedId(slotName);
    const slot = slots[slotName];
    if (!id || !P.isConfigured(providerConfig.providers[id])) {
      updateAIStatus();
      return;
    }
    if (granted === false) {
      await P.recordStatus(id, 'permission_needed');
      updateAIStatus();
      return;
    }
    slot.test.disabled = true;
    slot.test.textContent = 'Checking…';
    try {
      await chrome.runtime.sendMessage({ type: 'XFP_TEST_PROVIDER', provider: id });
    } catch (error) {
      await P.recordStatus(id, 'network_error');
    } finally {
      slot.test.disabled = false;
      slot.test.textContent = 'Test connection';
    }
    updateAIStatus();
  }

  renderAll();
  updateAIStatus();

  slots.primary.select.addEventListener('change', async () => {
    const primary = selectedId('primary');
    const update = { primary };
    if (providerConfig.fallback === primary) update.fallback = '';
    await P.saveSelection(update);
    providerConfig = await P.loadConfig();
    renderAll();
    sendToContentScript({ type: 'UPDATE_PROVIDER' });
    updateAIStatus();
  });

  slots.fallback.select.addEventListener('change', async () => {
    await P.saveSelection({ fallback: selectedId('fallback') || '' });
    providerConfig = await P.loadConfig();
    renderAll();
    sendToContentScript({ type: 'UPDATE_PROVIDER' });
    updateAIStatus();
  });

  for (const slotName of Object.keys(slots)) {
    const slot = slots[slotName];
    for (const input of [slot.key, slot.model, slot.baseUrl]) {
      input.addEventListener('change', async () => {
        const permission = requestPermission(slotName);
        await saveSlot(slotName);
        const id = selectedId(slotName);
        if (id && P.isConfigured(providerConfig.providers[id])) testSlot(slotName, await permission);
      });
    }
    slot.test.addEventListener('click', async () => {
      const permission = requestPermission(slotName);
      await saveSlot(slotName);
      testSlot(slotName, await permission);
    });
    slot.toggle.addEventListener('click', () => {
      const show = slot.key.type === 'password';
      slot.key.type = show ? 'text' : 'password';
      slot.toggle.textContent = show ? 'Hide' : 'Show';
    });
  }

  // First run after an upgrade: check the active provider once if it has no status yet.
  (async () => {
    const id = providerConfig.primary;
    if (!P.isConfigured(providerConfig.providers[id])) return;
    const statuses = await P.loadStatuses();
    if (!statuses[id]) testSlot('primary', await hasPermission(id));
  })();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.keys(changes).some(key => key.startsWith('xfpStatus_'))) updateAIStatus();
  });

  // Custom prompt: show the saved prompt, or the default one so it can be edited.
  chrome.storage.sync.get(['customPrompt'], (result) => {
    if (result.customPrompt) {
      customPromptInput.value = result.customPrompt;
    } else {
      sendToContentScript({ type: 'GET_DEFAULT_PROMPT' }).then(response => {
        if (response && response.defaultPrompt) customPromptInput.value = response.defaultPrompt;
      });
    }
  });

  // Save Custom Prompt on change (empty = use the default prompt)
  customPromptInput.addEventListener('change', async () => {
    const prompt = customPromptInput.value.trim();
    const valueToSave = prompt === '' ? null : prompt;

    await chrome.storage.sync.set({ customPrompt: valueToSave });
    sendToContentScript({ type: 'UPDATE_CUSTOM_PROMPT', prompt: valueToSave });

    // If cleared, re-fetch default to show it
    if (valueToSave === null) {
       const response = await sendToContentScript({ type: 'GET_DEFAULT_PROMPT' });
       if (response && response.defaultPrompt) {
         customPromptInput.value = response.defaultPrompt;
       }
    }
    showRefreshNotice();
  });

  // Advanced section toggle (fallback provider + usage)
  const advancedToggle = $('advancedToggle');
  const advancedContent = $('advancedContent');

  advancedToggle.addEventListener('click', () => {
    advancedToggle.classList.toggle('expanded');
    advancedContent.classList.toggle('show');
    const open = advancedContent.classList.contains('show');
    advancedToggle.setAttribute('aria-expanded', String(open));
    if (open) updateUsageStats();
  });
  // Open Advanced automatically when a fallback is already configured.
  if (providerConfig.fallback) {
    advancedToggle.classList.add('expanded');
    advancedContent.classList.add('show');
    advancedToggle.setAttribute('aria-expanded', 'true');
  }

  // Usage reported by the active provider's rate-limit headers (if any)
  async function updateUsageStats() {
    const requestsEl = $('requestsRemaining');
    const tokensEl = $('tokensRemaining');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'XFP_GET_USAGE' });
      if (response && response.providerName) $('usageLabel').textContent = `${response.providerName} usage`;
      const usage = response && response.usage;
      requestsEl.textContent = usage && usage.requestsRemaining !== null ? usage.requestsRemaining.toLocaleString() : 'No data yet';
      tokensEl.textContent = usage && usage.tokensRemaining !== null ? usage.tokensRemaining.toLocaleString() : 'No data yet';
    } catch (error) {
      requestsEl.textContent = 'No data yet';
      tokensEl.textContent = 'No data yet';
    }
  }

  document.getElementById('clearData').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all stored tweet data?')) {
      // Clear IndexedDB via content script
      await sendToContentScript({ type: 'CLEAR_DATA' });
      // Also clear local storage as backup (the install ID is settings, not data)
      const kept = await chrome.storage.local.get(XFPProviders.INSTALL_ID_KEY);
      await chrome.storage.local.clear();
      await chrome.storage.local.set(kept);
      updateStats();
      updateHiddenTweetsList();
    }
  });
});

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('vibeFilterSettings', (result) => {
      const defaults = {
        enabled: true,
        threshold: 0,
        showScores: false,
        filterMode: 'hide',
        useAI: true,
        floatingHidden: false,
        floatingPosition: 'bottom-right',
        customPositiveWords: [],
        customNegativeWords: []
      };
      resolve({ ...defaults, ...result.vibeFilterSettings });
    });
  });
}

async function saveSettings(newSettings) {
  const current = await loadSettings();
  const updated = { ...current, ...newSettings };
  return new Promise((resolve) => {
    chrome.storage.sync.set({ vibeFilterSettings: updated }, resolve);
  });
}

async function sendToContentScript(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSupportedSite = tab && (
    tab.url?.includes('twitter.com') ||
    tab.url?.includes('x.com') ||
    tab.url?.includes('news.google.com')
  );
  if (isSupportedSite) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      // Content script might not be loaded yet
      console.log('Could not send message to content script');
      return null;
    }
  }
  return null;
}

async function updateStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSupportedSite = tab && (
    tab.url?.includes('twitter.com') ||
    tab.url?.includes('x.com') ||
    tab.url?.includes('news.google.com')
  );
  if (isSupportedSite) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' });
      if (response) {
        const hiddenCount = response.hiddenCount || 0;
        document.getElementById('tweetCount').textContent = response.stats?.tweetCount || 0;
        document.getElementById('sessionCount').textContent = response.processedCount || 0;
        document.getElementById('hiddenCount').textContent = hiddenCount;
        document.getElementById('hiddenCountLabel').textContent = `(${hiddenCount})`;
      }
    } catch (error) {
      document.getElementById('tweetCount').textContent = '-';
      document.getElementById('sessionCount').textContent = '-';
      document.getElementById('hiddenCount').textContent = '-';
      document.getElementById('hiddenCountLabel').textContent = '(0)';
    }
  }
}

function showRefreshNotice() {
  const notice = document.getElementById('refreshNotice');
  notice.classList.add('show');
  setTimeout(() => notice.classList.remove('show'), 3000);
}

async function updateHiddenTweetsList() {
  const listEl = document.getElementById('hiddenTweetsList');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSupportedSite = tab && (
    tab.url?.includes('twitter.com') ||
    tab.url?.includes('x.com') ||
    tab.url?.includes('news.google.com')
  );
  if (isSupportedSite) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' });
      if (response && response.hiddenTweets && response.hiddenTweets.length > 0) {
        listEl.innerHTML = response.hiddenTweets.map(tweet => `
          <div class="hidden-tweet" data-url="${tweet.url}">
            <div class="hidden-tweet-author">@${tweet.authorHandle}</div>
            <div class="hidden-tweet-text">${escapeHtml(tweet.text)}</div>
            <div class="hidden-tweet-meta">
              <span>${tweet.vibeLabel}</span>
              <span>Score: ${tweet.score}</span>
            </div>
          </div>
        `).join('');

        // Add click handlers to open tweets
        listEl.querySelectorAll('.hidden-tweet').forEach(el => {
          el.addEventListener('click', () => {
            chrome.tabs.create({ url: el.dataset.url });
          });
        });
        return;
      }
    } catch (error) {
      // Content script not loaded
    }
  }

  listEl.innerHTML = '<div class="no-hidden">No tweets hidden yet</div>';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function updateAIStatus() {
  const P = XFPProviders;
  const settings = await loadSettings();
  const statusEl = document.getElementById('aiStatus');
  const indicator = statusEl.querySelector('.ai-indicator');
  const text = statusEl.querySelector('span:last-child');
  const keyStatus = document.getElementById('apiKeyStatus');
  const [config, statuses] = await Promise.all([P.loadConfig(), P.loadStatuses()]);
  const primary = config.providers[config.primary];
  const info = P.describeStatus(primary, statuses[primary.id]);
  const fallback = config.fallback ? config.providers[config.fallback] : null;
  const fallbackInfo = fallback ? P.describeStatus(fallback, statuses[fallback.id]) : null;
  const fallbackUsable = !!(fallback && P.isConfigured(fallback) && fallbackInfo.state !== 'error');
  const statusClass = state => `api-key-status ${state === 'ready' ? 'connected' : state === 'error' ? 'error' : ''}`;

  keyStatus.textContent = info.label;
  keyStatus.className = statusClass(info.state);
  const fallbackStatus = document.getElementById('fallbackStatus');
  if (fallbackStatus) {
    fallbackStatus.textContent = fallbackInfo ? fallbackInfo.label : '';
    fallbackStatus.className = statusClass(fallbackInfo ? fallbackInfo.state : '');
  }

  const next = fallbackUsable
    ? `Falling back to ${P.displayName(fallback.id)}.`
    : 'Local keyword filtering remains available.';
  const warning = document.getElementById('connectionWarning');
  warning.textContent = info.state === 'error' ? `${info.label}. ${next}` : '';
  warning.classList.toggle('show', settings.useAI && info.state === 'error');

  const usesBuiltin = [config.primary, config.fallback].some(id => id && P.PROVIDERS[id].noKey);
  updateBuiltinQuota(settings.useAI && usesBuiltin);

  if (!settings.useAI) {
    indicator.className = 'ai-indicator disabled';
    text.textContent = 'AI scoring disabled';
    return;
  }
  indicator.className = `ai-indicator ${info.state}`;
  if (info.state === 'disabled') {
    text.textContent = fallbackUsable
      ? `Using fallback ${P.displayName(fallback.id)}`
      : `Keywords only — add your ${P.displayName(primary.id)} key`;
  } else {
    text.textContent = info.state === 'error' && fallbackUsable ? `${info.label} · ${next}` : info.label;
  }
}

// "Built-in AI: N posts left today", refreshed at most every 10 seconds.
let builtinQuotaFetchedAt = 0;
let builtinQuotaText = '';
async function updateBuiltinQuota(show) {
  const el = document.getElementById('builtinQuota');
  if (!el) return;
  if (!show) {
    el.hidden = true;
    return;
  }
  if (Date.now() - builtinQuotaFetchedAt > 10000) {
    builtinQuotaFetchedAt = Date.now();
    try {
      const status = await chrome.runtime.sendMessage({ type: 'XFP_BUILTIN_STATUS' });
      builtinQuotaText = status && Number.isFinite(status.remaining)
        ? `Built-in AI: ${status.remaining.toLocaleString()} post${status.remaining === 1 ? '' : 's'} left today`
        : '';
    } catch (error) {
      builtinQuotaText = '';
    }
  }
  el.textContent = builtinQuotaText;
  el.hidden = !builtinQuotaText;
}
