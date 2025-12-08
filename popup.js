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

  document.getElementById('useAI').addEventListener('change', async (e) => {
    await saveSettings({ useAI: e.target.checked });
    sendToContentScript({ type: 'UPDATE_SETTINGS', settings: { useAI: e.target.checked } });
    updateAIStatus();
    showRefreshNotice();
  });

  // Groq API Key handling
  const apiKeyInput = document.getElementById('groqApiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const apiKeyStatus = document.getElementById('apiKeyStatus');

  // Load saved API key
  chrome.storage.sync.get('groqApiKey', (result) => {
    if (result.groqApiKey) {
      apiKeyInput.value = result.groqApiKey;
      updateApiKeyStatus(result.groqApiKey);
    } else {
      // Show that default key is being used
      updateApiKeyStatus(null, true);
    }
  });

  // Toggle show/hide API key
  toggleApiKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleApiKeyBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      toggleApiKeyBtn.textContent = 'Show';
    }
  });

  // Save API key on change
  apiKeyInput.addEventListener('change', async () => {
    const apiKey = apiKeyInput.value.trim();
    await chrome.storage.sync.set({ groqApiKey: apiKey });
    updateApiKeyStatus(apiKey);
    // Notify content script of new API key
    sendToContentScript({ type: 'UPDATE_GROQ_API_KEY', apiKey });
    showRefreshNotice();
  });

  function updateApiKeyStatus(apiKey, usingDefault = false) {
    if (apiKey && apiKey.startsWith('gsk_')) {
      apiKeyStatus.textContent = 'Custom API key saved - using Groq';
      apiKeyStatus.className = 'api-key-status connected';
    } else if (apiKey) {
      apiKeyStatus.textContent = 'Invalid key format (should start with gsk_)';
      apiKeyStatus.className = 'api-key-status error';
    } else if (usingDefault) {
      apiKeyStatus.textContent = 'Using default API key - Groq active';
      apiKeyStatus.className = 'api-key-status connected';
    } else {
      apiKeyStatus.textContent = 'Enter API key for faster, smarter scoring';
      apiKeyStatus.className = 'api-key-status';
    }
  }

  document.getElementById('clearData').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all stored tweet data?')) {
      // Clear IndexedDB via content script
      await sendToContentScript({ type: 'CLEAR_DATA' });
      // Also clear local storage as backup
      await chrome.storage.local.clear();
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
  if (tab && (tab.url?.includes('twitter.com') || tab.url?.includes('x.com'))) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      // Content script might not be loaded yet
      console.log('Could not send message to content script');
    }
  }
}

async function updateStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && (tab.url?.includes('twitter.com') || tab.url?.includes('x.com'))) {
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
  if (tab && (tab.url?.includes('twitter.com') || tab.url?.includes('x.com'))) {
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
  const settings = await loadSettings();
  const statusEl = document.getElementById('aiStatus');
  const indicator = statusEl.querySelector('.ai-indicator');
  const text = statusEl.querySelector('span:last-child');

  if (!settings.useAI) {
    indicator.className = 'ai-indicator disabled';
    text.textContent = 'AI scoring disabled';
    return;
  }

  // Check if Groq API key is configured
  chrome.storage.sync.get('groqApiKey', (result) => {
    const hasGroqKey = !!(result.groqApiKey && result.groqApiKey.startsWith('gsk_'));

    if (hasGroqKey) {
      indicator.className = 'ai-indicator ready';
      text.textContent = 'Groq AI active';
    } else {
      indicator.className = 'ai-indicator error';
      text.textContent = 'Add API key for AI scoring';
    }
  });
}
