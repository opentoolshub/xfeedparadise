// XFeed Paradise - Content Script
// Monitors X/Twitter feed, extracts tweets, and filters based on vibe score
// Now with AI-powered sentiment analysis!

(async function() {
  'use strict';

  console.log('🌴 XFeed Paradise: Initializing...');

  // Wait for dependencies
  await window.tweetDB.ready;
  await VibeFilter.loadSettings();
  await VibeFilter.loadGroqApiKey();

  // AI Scorer state - now uses Groq API instead of local model
  let groqApiReady = !!VibeFilter.groqApiKey;

  // Check Groq API status
  async function checkGroqStatus() {
    groqApiReady = !!(VibeFilter.groqApiKey && VibeFilter.groqApiKey.startsWith('gsk_'));
    return groqApiReady;
  }

  // Initialize AI (just checks Groq status)
  async function initAIScorer() {
    console.log('🌴 XFeed Paradise: Checking Groq API status...');
    await checkGroqStatus();
    if (groqApiReady) {
      console.log('🌴 XFeed Paradise: Groq API ready for AI scoring');
    } else {
      console.log('🌴 XFeed Paradise: No Groq API key - using keyword scoring');
    }
    updateFloatingPanel();
  }

  // Local AI scorer is disabled - Groq scoring happens in filter.js
  window.AIScorer = {
    get isReady() { return false; }, // Local AI disabled
    scoreTweet: async () => null
  };
  VibeFilter.aiScorer = window.AIScorer;

  // Check Groq status on init
  if (VibeFilter.settings.useAI !== false) {
    initAIScorer();
  }

  // Track processed tweets to avoid duplicates
  const processedTweets = new Set();

  // Track hidden tweets with their info
  let hiddenCount = 0;
  const hiddenTweets = []; // Array of { id, text, author, score, url }

  // Get current user's handle (feed owner)
  function getFeedOwner() {
    // Try to get from the page
    const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountSwitcher) {
      const spans = accountSwitcher.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.startsWith('@')) {
          return span.textContent.slice(1);
        }
      }
    }
    return 'unknown';
  }

  // Extract tweet data from a tweet element
  function extractTweetData(tweetElement) {
    try {
      // Get tweet article
      const article = tweetElement.closest('article[data-testid="tweet"]');
      if (!article) return null;

      // Extract tweet ID from link
      const tweetLink = article.querySelector('a[href*="/status/"]');
      const tweetId = tweetLink?.href?.match(/status\/(\d+)/)?.[1];
      if (!tweetId) return null;

      // Already processed?
      if (processedTweets.has(tweetId)) return null;

      // Extract author info
      const authorLink = article.querySelector('a[href^="/"][role="link"]:not([href*="/status/"])');
      const authorHandle = authorLink?.href?.split('/').pop() || 'unknown';

      const displayNameEl = article.querySelector('[data-testid="User-Name"]');
      const displayName = displayNameEl?.querySelector('span')?.textContent || authorHandle;

      // Get author avatar
      const avatarImg = article.querySelector('img[src*="profile_images"]');
      const avatarUrl = avatarImg?.src || '';

      // Extract tweet text
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      const tweetText = tweetTextEl?.textContent || '';

      // Extract timestamp
      const timeEl = article.querySelector('time');
      const timestamp = timeEl?.dateTime ? new Date(timeEl.dateTime).getTime() : Date.now();

      // Extract engagement metrics
      const getMetric = (testId) => {
        const el = article.querySelector(`[data-testid="${testId}"]`);
        const text = el?.textContent || '0';
        return parseInt(text.replace(/[^0-9]/g, '')) || 0;
      };

      const replyCount = getMetric('reply');
      const retweetCount = getMetric('retweet');
      const likeCount = getMetric('like');

      // Check for media
      const hasImage = !!article.querySelector('[data-testid="tweetPhoto"]');
      const hasVideo = !!article.querySelector('[data-testid="videoPlayer"]');
      const hasQuote = !!article.querySelector('[data-testid="quoteTweet"]');

      // Check if it's a retweet
      const isRetweet = !!article.querySelector('[data-testid="socialContext"]')?.textContent?.includes('reposted');

      // Build tweet object
      const tweet = {
        id: tweetId,
        text: tweetText,
        authorId: authorHandle,
        authorName: displayName,
        authorAvatar: avatarUrl,
        timestamp,
        feedOwner: getFeedOwner(),
        metrics: {
          replies: replyCount,
          retweets: retweetCount,
          likes: likeCount
        },
        media: {
          hasImage,
          hasVideo,
          hasQuote
        },
        isRetweet,
        url: `https://x.com/${authorHandle}/status/${tweetId}`,
        collectedAt: Date.now()
      };

      return tweet;
    } catch (error) {
      console.error('XFeed Paradise: Error extracting tweet:', error);
      return null;
    }
  }

  // Apply filter to a tweet element
  function applyFilter(article, tweet, score) {
    if (!VibeFilter.settings.enabled) return;

    const shouldShow = VibeFilter.shouldShow(score);
    const vibeLabel = VibeFilter.getVibeLabel(score);

    // Remove any existing vibe indicators
    article.querySelector('.xfp-vibe-indicator')?.remove();

    // Add score indicator if enabled
    if (VibeFilter.settings.showScores) {
      const indicator = document.createElement('div');
      indicator.className = `xfp-vibe-indicator ${vibeLabel.class}`;
      indicator.innerHTML = `${vibeLabel.label} (${score})`;
      article.style.position = 'relative';
      article.prepend(indicator);
    }

    // Apply filter mode
    if (!shouldShow) {
      const container = article.closest('[data-testid="cellInnerDiv"]');
      const wasAlreadyHidden = container?.classList.contains('xfp-hidden') ||
                               container?.classList.contains('xfp-dimmed') ||
                               container?.classList.contains('xfp-labeled');

      switch (VibeFilter.settings.filterMode) {
        case 'hide':
          container?.classList.add('xfp-hidden');
          break;
        case 'dim':
          container?.classList.add('xfp-dimmed');
          break;
        case 'label':
          container?.classList.add('xfp-labeled');
          if (!article.querySelector('.xfp-warning-label')) {
            const warning = document.createElement('div');
            warning.className = 'xfp-warning-label';
            warning.innerHTML = `
              <span>🌴 Hidden by XFeed Paradise: ${vibeLabel.label}</span>
              <button class="xfp-show-anyway">Show anyway</button>
            `;
            warning.querySelector('.xfp-show-anyway').addEventListener('click', (e) => {
              e.stopPropagation();
              article.closest('[data-testid="cellInnerDiv"]')?.classList.remove('xfp-labeled');
              warning.remove();
              hiddenCount = Math.max(0, hiddenCount - 1);
            });
            article.prepend(warning);
          }
          break;
      }

      // Track hidden tweet info if newly hidden
      if (!wasAlreadyHidden) {
        hiddenCount++;
        hiddenTweets.unshift({
          id: tweet.id,
          text: tweet.text?.slice(0, 100) + (tweet.text?.length > 100 ? '...' : ''),
          author: tweet.authorName || tweet.authorId,
          authorHandle: tweet.authorId,
          score: score,
          url: tweet.url,
          vibeLabel: vibeLabel.label
        });
        // Keep only last 50 hidden tweets
        if (hiddenTweets.length > 50) {
          hiddenTweets.pop();
        }
      }
    } else {
      // Ensure shown tweets are visible
      const container = article.closest('[data-testid="cellInnerDiv"]');
      container?.classList.remove('xfp-hidden', 'xfp-dimmed', 'xfp-labeled');
    }
  }

  // Process a single tweet element - FAST, non-blocking
  function processTweet(tweetElement) {
    const tweet = extractTweetData(tweetElement);
    if (!tweet) return;

    // Mark as processed early to avoid duplicate processing
    processedTweets.add(tweet.id);

    const article = tweetElement.closest('article[data-testid="tweet"]');

    // Get score with AI refinement callback
    const { score, source } = VibeFilter.getScoreWithRefinement(
      tweet.id,
      tweet.text,
      // Callback when AI score arrives - update the filter
      (aiScore, aiSource) => {
        if (article && article.isConnected) {
          tweet.vibeScore = aiScore;
          tweet.scoredWithAI = true;
          applyFilter(article, tweet, aiScore);
          updateFloatingPanel();

          // Update in database
          window.tweetDB.saveTweet({ ...tweet, vibeScore: aiScore, scoredWithAI: true }).catch(() => {});
        }
      }
    );

    tweet.vibeScore = score;
    tweet.scoredWithAI = source === 'ai';

    // Apply filter immediately with initial score
    if (article) {
      applyFilter(article, tweet, score);
    }

    // Save to database (non-blocking)
    window.tweetDB.saveTweet(tweet).catch(error => {
      console.error('XFeed Paradise: Error saving tweet:', error);
    });
  }

  // Process all visible tweets - non-blocking, fires all at once
  function processVisibleTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    tweets.forEach(tweet => processTweet(tweet));
  }

  // Observe DOM for new tweets
  function observeTweets() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node contains tweets
            const tweets = node.querySelectorAll?.('article[data-testid="tweet"]') || [];
            tweets.forEach(tweet => processTweet(tweet));

            // Also check if the node itself is a tweet
            if (node.matches?.('article[data-testid="tweet"]')) {
              processTweet(node);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return observer;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_SETTINGS') {
      VibeFilter.settings = { ...VibeFilter.settings, ...message.settings };
      // Reprocess visible tweets with new settings
      reprocessVisibleTweets();
      sendResponse({ success: true });
    } else if (message.type === 'CLEAR_DATA') {
      // Clear IndexedDB and reset local state
      window.tweetDB.clearAll().then(() => {
        processedTweets.clear();
        hiddenCount = 0;
        hiddenTweets.length = 0;
        updateFloatingPanel();
        sendResponse({ success: true });
      }).catch(error => {
        console.error('XFeed Paradise: Error clearing data:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true; // Keep channel open for async response
    } else if (message.type === 'GET_STATS') {
      window.tweetDB.getStats().then(stats => {
        sendResponse({
          stats,
          processedCount: processedTweets.size,
          hiddenCount,
          hiddenTweets: hiddenTweets.slice(0, 20) // Return up to 20 for popup
        });
      });
      return true; // Keep channel open for async response
    } else if (message.type === 'GET_AI_STATUS') {
      sendResponse({
        aiReady: groqApiReady,
        aiLoading: !groqApiReady && VibeFilter.settings.useAI,
        aiProgress: 100
      });
    } else if (message.type === 'TOGGLE_ENABLED') {
      VibeFilter.settings.enabled = message.enabled;
      reprocessVisibleTweets();
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_FLOATING_VISIBILITY') {
      const panel = document.querySelector('.xfp-floating-panel');
      if (panel) {
        if (message.visible) {
          panel.classList.remove('hidden');
        } else {
          panel.classList.add('hidden');
        }
        VibeFilter.settings.floatingHidden = !message.visible;
      }
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_GROQ_API_KEY') {
      // Update Groq API key
      VibeFilter.groqApiKey = message.apiKey || null;
      console.log('🌴 XFeed Paradise: Groq API key updated');
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_CUSTOM_PROMPT') {
      // Update Custom Prompt
      VibeFilter.customPrompt = message.prompt || null;
      console.log('🌴 XFeed Paradise: Custom prompt updated');
      sendResponse({ success: true });
    } else if (message.type === 'GET_GROQ_USAGE') {
      // Return Groq API usage stats
      sendResponse({ usage: VibeFilter.groqUsage });
    } else if (message.type === 'GET_DEFAULT_PROMPT') {
      sendResponse({ defaultPrompt: VibeFilter.defaultPrompt });
    }
    return true;
  });

  // Reprocess all visible tweets (after settings change)
  function reprocessVisibleTweets() {
    const containers = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    containers.forEach(container => {
      container.classList.remove('xfp-hidden', 'xfp-dimmed', 'xfp-labeled');
      container.querySelector('.xfp-vibe-indicator')?.remove();
      container.querySelector('.xfp-warning-label')?.remove();
    });

    // Reset counts and reprocess
    processedTweets.clear();
    hiddenCount = 0;
    hiddenTweets.length = 0;
    processVisibleTweets();
  }

  // Create floating panel UI
  function createFloatingPanel() {
    // Remove existing panel if any
    document.querySelector('.xfp-floating-panel')?.remove();

    // Get saved position
    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    const isHidden = VibeFilter.settings.floatingHidden || false;

    const panel = document.createElement('div');
    panel.className = `xfp-floating-panel pos-${position}`;
    if (isHidden) panel.classList.add('hidden');

    panel.innerHTML = `
      <div class="xfp-floating-dropdown">
        <div class="xfp-dropdown-header">
          <span class="xfp-dropdown-title">🌴 XFeed Paradise</span>
          <button class="xfp-dropdown-close">&times;</button>
        </div>

        <!-- Hidden Tweets Section (collapsible) -->
        <div class="xfp-section">
          <button class="xfp-section-toggle xfp-hidden-toggle expanded">
            <span>Hidden Tweets <span class="xfp-hidden-count-label">(0)</span></span>
            <span class="xfp-toggle-icon">▼</span>
          </button>
          <div class="xfp-section-content xfp-hidden-content show">
            <div class="xfp-dropdown-list">
              <div class="xfp-dropdown-empty">No tweets hidden yet</div>
            </div>
          </div>
        </div>

        <!-- All Settings Section (collapsible) -->
        <div class="xfp-section">
          <button class="xfp-section-toggle xfp-settings-toggle">
            <span>Settings & Stats</span>
            <span class="xfp-toggle-icon">▼</span>
          </button>
          <div class="xfp-section-content xfp-settings-content">
            <!-- Filter Active -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-filter-active-cb" checked>
                <span>Filter Active</span>
              </label>
            </div>

            <!-- Filter Mode -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Filter Mode</label>
              <div class="xfp-setting-options xfp-filter-modes">
                <button class="xfp-setting-btn" data-mode="hide">Hide</button>
                <button class="xfp-setting-btn" data-mode="dim">Dim</button>
                <button class="xfp-setting-btn" data-mode="label">Collapse</button>
              </div>
            </div>

            <!-- Threshold -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Vibe Threshold</label>
              <div class="xfp-slider-row">
                <input type="range" class="xfp-slider xfp-threshold-slider" min="-50" max="50" value="0">
                <span class="xfp-slider-value xfp-threshold-value">0</span>
              </div>
            </div>

            <!-- Show Scores -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-show-scores-cb">
                <span>Show vibe scores on tweets</span>
              </label>
            </div>

            <!-- Debug Mode -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-debug-mode-cb">
                <span>Debug mode (console logs)</span>
              </label>
            </div>

            <!-- AI Status & Toggle -->
            <div class="xfp-setting-row xfp-ai-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-use-ai-cb" checked>
                <span>Use AI scoring</span>
              </label>
              <div class="xfp-ai-status-inline">
                <span class="xfp-ai-dot"></span>
                <span class="xfp-ai-text">Loading...</span>
              </div>
              <button class="xfp-gear-btn" title="AI Settings">
                <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              </button>
            </div>

            <!-- API Key & Prompt Section (Hidden) -->
            <div class="xfp-api-key-container">
              <label class="xfp-setting-label">Groq API Key <a href="https://console.groq.com/keys" target="_blank" style="color: #60a5fa; text-decoration: none;">(Get key)</a></label>
              <input type="password" class="xfp-api-input" placeholder="gsk_...">
              <div class="xfp-setting-label" style="font-size: 10px; opacity: 0.7; margin-top: 4px;">Enter key for faster scoring</div>
              
              <label class="xfp-setting-label" style="margin-top: 10px;">Custom Prompt (Optional)</label>
              <textarea class="xfp-prompt-input" placeholder="Default: Rate the sentiment/vibe..."></textarea>
              <div class="xfp-setting-label" style="font-size: 10px; opacity: 0.7; margin-top: 4px;">Leave empty to use default. Must ask for a number -100 to 100.</div>
            </div>

            <!-- Stats -->
            <div class="xfp-setting-row xfp-stats-row">
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-hidden">0</span>
                <span class="xfp-stat-label">Hidden</span>
              </div>
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-processed">0</span>
                <span class="xfp-stat-label">Processed</span>
              </div>
              <div class="xfp-stat-item">
                <span class="xfp-stat-value xfp-stat-saved">0</span>
                <span class="xfp-stat-label">Saved</span>
              </div>
            </div>

            <!-- Divider -->
            <div class="xfp-divider"></div>

            <!-- Button Position -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Button Position</label>
              <div class="xfp-setting-options xfp-positions">
                <button class="xfp-setting-btn" data-pos="bottom-right">↘</button>
                <button class="xfp-setting-btn" data-pos="bottom-left">↙</button>
                <button class="xfp-setting-btn" data-pos="top-right">↗</button>
                <button class="xfp-setting-btn" data-pos="top-left">↖</button>
                <button class="xfp-setting-btn" data-pos="middle-right">→</button>
              </div>
            </div>

            <!-- Hide Button -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-hide-btn-cb">
                <span>Hide floating button</span>
              </label>
            </div>

            <!-- Clear Data -->
            <div class="xfp-setting-row">
              <button class="xfp-clear-data-btn">Clear stored data</button>
            </div>
          </div>
        </div>
      </div>
      <button class="xfp-floating-btn">
        <span class="xfp-floating-btn-icon">🌴</span>
        <span class="xfp-floating-badge">0</span>
      </button>
    `;

    document.body.appendChild(panel);

    // Toggle dropdown
    const btn = panel.querySelector('.xfp-floating-btn');
    const dropdown = panel.querySelector('.xfp-floating-dropdown');
    const closeBtn = panel.querySelector('.xfp-dropdown-close');

    btn.addEventListener('click', () => {
      dropdown.classList.toggle('show');
      if (dropdown.classList.contains('show')) {
        updateFloatingPanel();
      }
    });

    closeBtn.addEventListener('click', () => {
      dropdown.classList.remove('show');
    });

    // Hidden tweets section toggle
    const hiddenToggle = panel.querySelector('.xfp-hidden-toggle');
    const hiddenContent = panel.querySelector('.xfp-hidden-content');

    chrome.storage.local.get('floatingHiddenExpanded', (result) => {
      if (result.floatingHiddenExpanded === false) {
        hiddenToggle.classList.remove('expanded');
        hiddenContent.classList.remove('show');
      }
    });

    hiddenToggle.addEventListener('click', () => {
      hiddenToggle.classList.toggle('expanded');
      hiddenContent.classList.toggle('show');
      chrome.storage.local.set({ floatingHiddenExpanded: hiddenContent.classList.contains('show') });
    });

    // Settings section toggle
    const settingsToggle = panel.querySelector('.xfp-settings-toggle');
    const settingsContent = panel.querySelector('.xfp-settings-content');

    chrome.storage.local.get('floatingSettingsExpanded', (result) => {
      if (result.floatingSettingsExpanded) {
        settingsToggle.classList.add('expanded');
        settingsContent.classList.add('show');
      }
    });

    settingsToggle.addEventListener('click', () => {
      settingsToggle.classList.toggle('expanded');
      settingsContent.classList.toggle('show');
      chrome.storage.local.set({ floatingSettingsExpanded: settingsContent.classList.contains('show') });
    });

    // Gear button (API Key) toggle
    const gearBtn = panel.querySelector('.xfp-gear-btn');
    const apiKeyContainer = panel.querySelector('.xfp-api-key-container');
    const apiInput = panel.querySelector('.xfp-api-input');
    const promptInput = panel.querySelector('.xfp-prompt-input');

    gearBtn.addEventListener('click', () => {
      apiKeyContainer.classList.toggle('show');
      // Load current key and prompt when showing
      if (apiKeyContainer.classList.contains('show')) {
        apiInput.value = VibeFilter.groqApiKey || '';
        // Show custom prompt, or default if no custom set
        promptInput.value = VibeFilter.customPrompt || VibeFilter.defaultPrompt;
      }
    });

    // API Key input handling
    apiInput.addEventListener('change', async () => {
      const newKey = apiInput.value.trim();
      VibeFilter.groqApiKey = newKey;
      await VibeFilter.saveGroqApiKey(newKey);
      initAIScorer();
    });

    // Custom Prompt input handling
    promptInput.addEventListener('change', async () => {
      const newPrompt = promptInput.value.trim();
      // If user clears it (empty string), we treat as null (use default)
      const valueToSave = newPrompt === '' ? null : newPrompt;
      VibeFilter.customPrompt = valueToSave;
      await VibeFilter.saveCustomPrompt(valueToSave);
      
      // If cleared, immediately show default again so they know what's happening
      if (valueToSave === null) {
        promptInput.value = VibeFilter.defaultPrompt;
      }
    });

    // Filter Active checkbox
    const filterActiveCb = panel.querySelector('.xfp-filter-active-cb');
    filterActiveCb.addEventListener('change', () => {
      VibeFilter.settings.enabled = filterActiveCb.checked;
      VibeFilter.saveSettings({ enabled: filterActiveCb.checked });
      reprocessVisibleTweets();
    });

    // Filter mode buttons
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        VibeFilter.settings.filterMode = btn.dataset.mode;
        VibeFilter.saveSettings({ filterMode: btn.dataset.mode });
        reprocessVisibleTweets();
      });
    });

    // Threshold slider
    const thresholdSlider = panel.querySelector('.xfp-threshold-slider');
    const thresholdValue = panel.querySelector('.xfp-threshold-value');
    thresholdSlider.addEventListener('input', () => {
      thresholdValue.textContent = thresholdSlider.value;
    });
    thresholdSlider.addEventListener('change', () => {
      VibeFilter.settings.threshold = parseInt(thresholdSlider.value);
      VibeFilter.saveSettings({ threshold: parseInt(thresholdSlider.value) });
      reprocessVisibleTweets();
    });

    // Show scores checkbox
    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    showScoresCb.addEventListener('change', () => {
      VibeFilter.settings.showScores = showScoresCb.checked;
      VibeFilter.saveSettings({ showScores: showScoresCb.checked });
      reprocessVisibleTweets();
    });

    // Debug mode checkbox
    const debugModeCb = panel.querySelector('.xfp-debug-mode-cb');
    debugModeCb.addEventListener('change', () => {
      VibeFilter.settings.debugMode = debugModeCb.checked;
      VibeFilter.saveSettings({ debugMode: debugModeCb.checked });
      if (debugModeCb.checked) {
        console.log('🌴 XFP Debug mode enabled. API status:', VibeFilter.getApiStatus());
      }
    });

    // Use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    useAiCb.addEventListener('change', () => {
      VibeFilter.settings.useAI = useAiCb.checked;
      VibeFilter.saveSettings({ useAI: useAiCb.checked });
      if (useAiCb.checked && !groqApiReady) {
        initAIScorer();
      }
      reprocessVisibleTweets();
    });

    // Position buttons
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panel.className = `xfp-floating-panel pos-${btn.dataset.pos}`;
        VibeFilter.settings.floatingPosition = btn.dataset.pos;
        VibeFilter.saveSettings({ floatingPosition: btn.dataset.pos });
      });
    });

    // Hide button checkbox
    const hideBtnCb = panel.querySelector('.xfp-hide-btn-cb');
    hideBtnCb.addEventListener('change', () => {
      if (hideBtnCb.checked) {
        panel.classList.add('hidden');
        VibeFilter.settings.floatingHidden = true;
        VibeFilter.saveSettings({ floatingHidden: true });
      }
    });

    // Clear data button
    const clearDataBtn = panel.querySelector('.xfp-clear-data-btn');
    clearDataBtn.addEventListener('click', async () => {
      if (confirm('Clear all stored tweet data?')) {
        await window.tweetDB.clearAll();
        processedTweets.clear();
        hiddenCount = 0;
        hiddenTweets.length = 0;
        updateFloatingPanel();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target)) {
        dropdown.classList.remove('show');
      }
    });

    return panel;
  }

  // Update floating panel content
  async function updateFloatingPanel() {
    const panel = document.querySelector('.xfp-floating-panel');
    if (!panel) return;

    const badge = panel.querySelector('.xfp-floating-badge');
    const list = panel.querySelector('.xfp-dropdown-list');
    const aiDot = panel.querySelector('.xfp-ai-dot');
    const aiText = panel.querySelector('.xfp-ai-text');
    const hiddenCountLabel = panel.querySelector('.xfp-hidden-count-label');

    // Update badge and hidden count label
    if (badge) {
      badge.textContent = hiddenCount;
      badge.style.display = hiddenCount > 0 ? 'flex' : 'none';
    }
    if (hiddenCountLabel) {
      hiddenCountLabel.textContent = `(${hiddenCount})`;
    }

    // Update AI status (now shows Groq status)
    if (aiDot && aiText) {
      const hasGroqKey = !!(VibeFilter.groqApiKey && VibeFilter.groqApiKey.startsWith('gsk_'));
      if (VibeFilter.settings.useAI === false) {
        aiDot.classList.remove('ready');
        aiText.textContent = 'AI disabled';
      } else if (hasGroqKey) {
        aiDot.classList.add('ready');
        aiText.textContent = 'Groq AI active';
      } else {
        aiDot.classList.remove('ready');
        aiText.textContent = 'Keywords only';
      }
    }

    // Update hidden tweets list
    if (list) {
      if (hiddenTweets.length === 0) {
        list.innerHTML = '<div class="xfp-dropdown-empty">No tweets hidden yet</div>';
      } else {
        list.innerHTML = hiddenTweets.slice(0, 20).map(tweet => `
          <div class="xfp-dropdown-item" data-url="${tweet.url}">
            <div class="xfp-dropdown-author">@${tweet.authorHandle}</div>
            <div class="xfp-dropdown-text">${escapeHtml(tweet.text)}</div>
            <div class="xfp-dropdown-meta">
              <span>${tweet.vibeLabel}</span>
              <span>Score: ${tweet.score}</span>
            </div>
          </div>
        `).join('');

        // Add click handlers
        list.querySelectorAll('.xfp-dropdown-item').forEach(item => {
          item.addEventListener('click', () => {
            window.open(item.dataset.url, '_blank');
          });
        });
      }
    }

    // Update filter active checkbox
    const filterActiveCb = panel.querySelector('.xfp-filter-active-cb');
    if (filterActiveCb) {
      filterActiveCb.checked = VibeFilter.settings.enabled !== false;
    }

    // Update filter mode buttons
    const filterMode = VibeFilter.settings.filterMode || 'hide';
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === filterMode);
    });

    // Update threshold slider
    const thresholdSlider = panel.querySelector('.xfp-threshold-slider');
    const thresholdValue = panel.querySelector('.xfp-threshold-value');
    if (thresholdSlider && thresholdValue) {
      thresholdSlider.value = VibeFilter.settings.threshold || 0;
      thresholdValue.textContent = VibeFilter.settings.threshold || 0;
    }

    // Update show scores checkbox
    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    if (showScoresCb) {
      showScoresCb.checked = VibeFilter.settings.showScores || false;
    }

    // Update debug mode checkbox
    const debugModeCb = panel.querySelector('.xfp-debug-mode-cb');
    if (debugModeCb) {
      debugModeCb.checked = VibeFilter.settings.debugMode || false;
    }

    // Update use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    if (useAiCb) {
      useAiCb.checked = VibeFilter.settings.useAI !== false;
    }

    // Update position buttons
    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pos === position);
    });

    // Update stats
    try {
      const stats = await window.tweetDB.getStats();
      const statHidden = panel.querySelector('.xfp-stat-hidden');
      const statProcessed = panel.querySelector('.xfp-stat-processed');
      const statSaved = panel.querySelector('.xfp-stat-saved');

      if (statHidden) statHidden.textContent = hiddenCount;
      if (statProcessed) statProcessed.textContent = processedTweets.size;
      if (statSaved) statSaved.textContent = stats?.tweetCount || 0;
    } catch (error) {
      console.warn('Could not update stats:', error);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // Create the floating panel
  const floatingPanel = createFloatingPanel();

  // Update badge whenever hidden count changes (called from applyFilter)
  const originalHiddenCount = { value: 0 };
  setInterval(() => {
    if (originalHiddenCount.value !== hiddenCount) {
      originalHiddenCount.value = hiddenCount;
      updateFloatingPanel();
    }
  }, 500);

  // Initialize
  console.log('🌴 XFeed Paradise: Starting tweet observation...');
  processVisibleTweets();
  observeTweets();

  // Log stats periodically
  setInterval(async () => {
    const stats = await window.tweetDB.getStats();
    console.log(`🌴 XFeed Paradise: ${stats.tweetCount} tweets collected, ${processedTweets.size} processed this session`);
  }, 60000);

  console.log('🌴 XFeed Paradise: Active and filtering your feed!');
})();
