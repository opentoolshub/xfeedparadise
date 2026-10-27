// XFeed Paradise - Background Service Worker
// All AI provider HTTP calls happen here (extension origin, not page CORS).
// Content scripts send batches of post text; the worker tries the primary
// provider, then the optional fallback. Callers use keywords if both fail.

import './providers.js';

const Providers = globalThis.XFPProviders;

let configCache = null;

async function getConfig() {
  if (!configCache) configCache = await Providers.loadConfig();
  return configCache;
}

// Any provider/key/model change invalidates cached config and cooldowns.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (Object.keys(changes).some(key => Providers.SYNC_KEYS.includes(key))) {
    configCache = null;
    Providers.resetRuntime();
  }
});

async function aiStatus() {
  const config = await getConfig();
  const ready = Providers.chain(config);
  return {
    aiReady: ready.length > 0,
    aiLoading: false,
    aiProgress: ready.length > 0 ? 100 : 0,
    provider: config.primary,
    providerName: Providers.displayName(config.primary),
    fallback: config.fallback,
    fallbackName: config.fallback ? Providers.displayName(config.fallback) : null
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'XFP_SCORE_BATCH': {
      const texts = Array.isArray(message.texts) ? message.texts.map(t => String(t)) : [];
      if (texts.length === 0) {
        sendResponse({ scores: null, attempts: [] });
        return false;
      }
      getConfig()
        .then(config => Providers.scoreBatch(texts, { config }))
        .then(sendResponse)
        .catch(() => sendResponse({ scores: null, attempts: [], retryAfterMs: 30000 }));
      return true;
    }
    case 'XFP_TEST_PROVIDER': {
      configCache = null;
      Providers.testProvider(message.provider)
        .then(sendResponse)
        .catch(() => sendResponse({ state: 'network_error' }));
      return true;
    }
    case 'XFP_GET_USAGE': {
      getConfig().then(config => {
        sendResponse({
          provider: config.primary,
          providerName: Providers.displayName(config.primary),
          usage: Providers.usageFor(config.primary)
        });
      });
      return true;
    }
    case 'GET_AI_STATUS_BG': {
      aiStatus().then(sendResponse);
      return true;
    }
    case 'INIT_AI_REQUEST': {
      aiStatus().then(status => sendResponse({ status: status.aiReady ? 'ready' : 'no_api_key' }));
      return true;
    }
    default:
      return false;
  }
});

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('🌴 XFeed Paradise installed!');

    // Set default settings
    chrome.storage.sync.set({
      vibeFilterSettings: {
        enabled: true,
        threshold: 0,
        showScores: false,
        filterMode: 'hide',
        useAI: true,
        customPositiveWords: [],
        customNegativeWords: []
      }
    });
  }
  // v1.3.2 kept one Groq status record; providers now have their own.
  chrome.storage.local.remove('xfpGroqStatus');
});

// Badge update for stats
async function updateBadge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes('twitter.com') || tab.url?.includes('x.com')) {
      chrome.action.setBadgeBackgroundColor({ color: '#8b5cf6' });
      chrome.action.setBadgeText({ text: '✓', tabId });
    }
  } catch (error) {
    // Tab might not exist
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    updateBadge(tabId);
  }
});
