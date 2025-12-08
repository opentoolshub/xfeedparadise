// XFeed Paradise - Background Service Worker

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
        customPositiveWords: [],
        customNegativeWords: []
      }
    });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TWEET_COLLECTED') {
    // Could be used for cross-tab syncing or analytics
    console.log(`🌴 Tweet collected: ${message.tweetId}`);
  }
  return true;
});

// Badge update for stats (optional)
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

// Update badge when tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    updateBadge(tabId);
  }
});
