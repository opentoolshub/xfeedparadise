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

  // AI Scorer state (managed via background script)
  let aiScorerReady = false;
  let aiLoadingProgress = 0;

  // Request AI initialization via background script
  async function initAIScorer() {
    console.log('🌴 XFeed Paradise: Requesting AI initialization...');
    chrome.runtime.sendMessage({ type: 'INIT_AI_REQUEST' });

    // Poll for AI status
    const checkStatus = async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_AI_STATUS_BG' });
        if (response) {
          aiLoadingProgress = response.aiProgress || 0;
          if (response.aiReady) {
            aiScorerReady = true;
            console.log('🌴 XFeed Paradise: AI model ready! Reprocessing feed...');
            reprocessVisibleTweets();
            return;
          }
          if (response.aiLoading) {
            console.log(`🌴 AI Model loading: ${aiLoadingProgress}%`);
            setTimeout(checkStatus, 1000);
          }
        }
      } catch (error) {
        console.warn('🌴 AI status check failed:', error);
      }
    };

    checkStatus();
  }

  // Score tweet via background script (which forwards to offscreen doc)
  async function scoreWithAI(text) {
    if (!aiScorerReady) return null;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SCORE_TWEET_REQUEST',
        text
      });
      return response?.score ?? null;
    } catch (error) {
      console.error('AI scoring error:', error);
      return null;
    }
  }

  // Create AI scorer interface for filter.js
  window.AIScorer = {
    get isReady() { return aiScorerReady; },
    scoreTweet: scoreWithAI
  };
  VibeFilter.aiScorer = window.AIScorer;

  // Start loading AI in background (don't block initial filtering)
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

  // Process a single tweet element
  async function processTweet(tweetElement) {
    const tweet = extractTweetData(tweetElement);
    if (!tweet) return;

    // Mark as processed early to avoid duplicate processing
    processedTweets.add(tweet.id);

    // Calculate vibe score (async - uses AI when available)
    const score = await VibeFilter.calculateScore(tweet);
    tweet.vibeScore = score;
    tweet.scoredWithAI = aiScorerReady;

    // Save to database
    try {
      await window.tweetDB.saveTweet(tweet);
    } catch (error) {
      console.error('XFeed Paradise: Error saving tweet:', error);
    }

    // Apply visual filter
    const article = tweetElement.closest('article[data-testid="tweet"]');
    if (article) {
      applyFilter(article, tweet, score);
    }
  }

  // Process all visible tweets
  async function processVisibleTweets() {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    for (const tweet of tweets) {
      await processTweet(tweet);
    }
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
        aiReady: aiScorerReady,
        aiLoading: !aiScorerReady && VibeFilter.settings.useAI,
        aiProgress: aiLoadingProgress
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

    // Use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    useAiCb.addEventListener('change', () => {
      VibeFilter.settings.useAI = useAiCb.checked;
      VibeFilter.saveSettings({ useAI: useAiCb.checked });
      if (useAiCb.checked && !aiScorerReady) {
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
  function updateFloatingPanel() {
    const panel = document.querySelector('.xfp-floating-panel');
    if (!panel) return;

    const badge = panel.querySelector('.xfp-floating-badge');
    const list = panel.querySelector('.xfp-dropdown-list');
    const aiDot = panel.querySelector('.xfp-ai-dot');
    const aiText = panel.querySelector('.xfp-ai-text');

    if (badge) {
      badge.textContent = hiddenCount;
      badge.style.display = hiddenCount > 0 ? 'flex' : 'none';
    }

    if (aiDot && aiText) {
      if (aiScorerReady) {
        aiDot.classList.add('ready');
        aiText.textContent = 'AI active';
      } else {
        aiDot.classList.remove('ready');
        aiText.textContent = `AI loading... ${aiLoadingProgress}%`;
      }
    }

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

    // Update settings UI to reflect current values
    const filterMode = VibeFilter.settings.filterMode || 'hide';
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === filterMode);
    });

    const thresholdSlider = panel.querySelector('.xfp-threshold-slider');
    const thresholdValue = panel.querySelector('.xfp-threshold-value');
    if (thresholdSlider && thresholdValue) {
      thresholdSlider.value = VibeFilter.settings.threshold || 0;
      thresholdValue.textContent = VibeFilter.settings.threshold || 0;
    }

    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    if (showScoresCb) {
      showScoresCb.checked = VibeFilter.settings.showScores || false;
    }

    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.pos === position);
    });
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
