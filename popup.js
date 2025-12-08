// XFeed Paradise - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  // Load current settings
  const settings = await loadSettings();

  // Initialize UI with current settings
  document.getElementById('enableToggle').checked = settings.enabled;
  document.getElementById('thresholdSlider').value = settings.threshold;
  document.getElementById('thresholdValue').textContent = settings.threshold;
  document.getElementById('showScores').checked = settings.showScores;

  // Set active mode button
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === settings.filterMode);
  });

  // Load stats
  updateStats();

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

  document.getElementById('clearData').addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Are you sure you want to clear all stored tweet data?')) {
      await chrome.storage.local.clear();
      updateStats();
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
      }
    } catch (error) {
      document.getElementById('tweetCount').textContent = '-';
      document.getElementById('sessionCount').textContent = '-';
    }
  }
}

function showRefreshNotice() {
  const notice = document.getElementById('refreshNotice');
  notice.classList.add('show');
  setTimeout(() => notice.classList.remove('show'), 3000);
}
