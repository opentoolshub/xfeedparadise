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

  // Restore hidden panel state
  chrome.storage.local.get('hiddenPanelOpen', (result) => {
    if (result.hiddenPanelOpen) {
      document.getElementById('hiddenTweetsPanel').classList.add('show');
      updateHiddenTweetsList();
    }
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

  document.getElementById('clearData').addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Are you sure you want to clear all stored tweet data?')) {
      await chrome.storage.local.clear();
      updateStats();
    }
  });

  // Hidden tweets panel toggle
  document.getElementById('hiddenStat').addEventListener('click', () => {
    const panel = document.getElementById('hiddenTweetsPanel');
    const isOpen = panel.classList.toggle('show');
    chrome.storage.local.set({ hiddenPanelOpen: isOpen });
    if (isOpen) {
      updateHiddenTweetsList();
    }
  });

  document.getElementById('closeHiddenPanel').addEventListener('click', () => {
    document.getElementById('hiddenTweetsPanel').classList.remove('show');
    chrome.storage.local.set({ hiddenPanelOpen: false });
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
        document.getElementById('tweetCount').textContent = response.stats?.tweetCount || 0;
        document.getElementById('sessionCount').textContent = response.processedCount || 0;
        document.getElementById('hiddenCount').textContent = response.hiddenCount || 0;
      }
    } catch (error) {
      document.getElementById('tweetCount').textContent = '-';
      document.getElementById('sessionCount').textContent = '-';
      document.getElementById('hiddenCount').textContent = '-';
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

  // Query the background script for AI status
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AI_STATUS_BG' });
    if (response) {
      if (response.aiReady) {
        indicator.className = 'ai-indicator ready';
        text.textContent = 'AI model active';
      } else if (response.aiLoading) {
        indicator.className = 'ai-indicator loading';
        const progress = response.aiProgress || 0;
        text.textContent = `Loading AI model... ${progress}%`;
        // Poll for updates while loading
        setTimeout(updateAIStatus, 500);
      } else {
        indicator.className = 'ai-indicator error';
        text.textContent = 'AI initializing...';
        setTimeout(updateAIStatus, 1000);
      }
      return;
    }
  } catch (error) {
    // Background script not ready
  }

  indicator.className = 'ai-indicator loading';
  text.textContent = 'Initializing...';
  setTimeout(updateAIStatus, 1000);
}
