// XFeed Paradise - Background Service Worker
// Manages offscreen document for AI processing

let aiReady = false;
let aiLoading = false;
let aiProgress = 0;
let offscreenCreated = false;

// Create offscreen document for AI processing
async function setupOffscreenDocument() {
  if (offscreenCreated) return;

  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
      offscreenCreated = true;
      return;
    }

    // Create offscreen document
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'AI model processing for tweet sentiment analysis'
    });

    offscreenCreated = true;
    aiLoading = true;
    console.log('🌴 Background: Offscreen document created');

  } catch (error) {
    console.error('🌴 Background: Failed to create offscreen document:', error);
  }
}

// Listen for messages from offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AI_READY') {
    aiReady = true;
    aiLoading = false;
    aiProgress = 100;
    console.log('🌴 Background: AI model ready');
  } else if (message.type === 'AI_PROGRESS') {
    aiProgress = message.progress;
    aiLoading = true;
  } else if (message.type === 'AI_ERROR') {
    aiLoading = false;
    console.error('🌴 Background: AI error:', message.error);
  }
  return true;
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCORE_TWEET_REQUEST') {
    // Forward to offscreen document
    if (!aiReady) {
      sendResponse({ score: null, aiReady: false });
      return true;
    }

    chrome.runtime.sendMessage({ type: 'SCORE_TWEET', text: message.text })
      .then(response => {
        sendResponse({ score: response?.score, aiReady: true });
      })
      .catch(() => {
        sendResponse({ score: null, aiReady: false });
      });
    return true; // Keep channel open

  } else if (message.type === 'GET_AI_STATUS_BG') {
    sendResponse({
      aiReady,
      aiLoading,
      aiProgress
    });
  } else if (message.type === 'INIT_AI_REQUEST') {
    setupOffscreenDocument();
    sendResponse({ status: 'initializing' });
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

  // Setup offscreen document
  setupOffscreenDocument();
});

// Setup on startup
chrome.runtime.onStartup.addListener(() => {
  setupOffscreenDocument();
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
    // Ensure offscreen is ready when visiting X
    if (tab.url?.includes('twitter.com') || tab.url?.includes('x.com')) {
      setupOffscreenDocument();
    }
  }
});
