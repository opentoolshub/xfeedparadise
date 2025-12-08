// XFeed Paradise - Background Service Worker
// Note: Local Transformers.js AI is disabled due to Chrome extension worker limitations
// AI scoring is handled via Groq API in the content script

// Track Groq API status
let groqApiKeySet = false;

// Check if Groq API key is configured
async function checkGroqStatus() {
  const result = await chrome.storage.sync.get('groqApiKey');
  groqApiKeySet = !!(result.groqApiKey && result.groqApiKey.startsWith('gsk_'));
  return groqApiKeySet;
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_AI_STATUS_BG') {
    // Return Groq-based AI status
    checkGroqStatus().then(hasKey => {
      sendResponse({
        aiReady: hasKey,
        aiLoading: false,
        aiProgress: hasKey ? 100 : 0,
        usingGroq: true
      });
    });
    return true; // Keep channel open for async

  } else if (message.type === 'INIT_AI_REQUEST') {
    // No local AI to init - just check Groq status
    checkGroqStatus().then(hasKey => {
      sendResponse({ status: hasKey ? 'ready' : 'no_api_key' });
    });
    return true;

  } else if (message.type === 'SCORE_TWEET_REQUEST') {
    // Local AI is disabled - scoring happens via Groq in content script
    sendResponse({ score: null, aiReady: false, useGroq: true });
    return true;
  }
  return true;
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
