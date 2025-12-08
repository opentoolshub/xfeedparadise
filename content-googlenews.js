// XFeed Paradise - Google News Content Script
// Monitors Google News feed, extracts articles, and filters based on vibe score
// Uses the same AI-powered sentiment analysis as the Twitter version

(async function() {
  'use strict';

  // Feature flag - check if Google News support is enabled
  const GOOGLE_NEWS_ENABLED_KEY = 'xfp_google_news_enabled';

  // Check feature flag before initializing
  // DEV: Temporarily defaulting to true for testing. Change back to === true before release.
  const flagResult = await chrome.storage.sync.get(GOOGLE_NEWS_ENABLED_KEY);
  const isEnabled = flagResult[GOOGLE_NEWS_ENABLED_KEY] !== false; // Default ON for testing

  if (!isEnabled) {
    console.log('🌴 XFeed Paradise: Google News support is disabled. Enable it in settings.');
    return;
  }

  console.log('🌴 XFeed Paradise: Initializing for Google News...');

  // Wait for dependencies
  await window.tweetDB.ready;
  await VibeFilter.loadSettings();
  await VibeFilter.loadGroqApiKey();

  // AI Scorer state - uses Groq API
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
    get isReady() { return false; },
    scoreTweet: async () => null
  };
  VibeFilter.aiScorer = window.AIScorer;

  // Check Groq status on init
  if (VibeFilter.settings.useAI !== false) {
    initAIScorer();
  }

  // Track processed articles to avoid duplicates
  const processedArticles = new Set();

  // Track hidden articles with their info
  let hiddenCount = 0;
  const hiddenItems = []; // Array of { id, text, source, score, url }

  // Toast notification system
  let toastTimeout = null;
  function showToast(message, type = 'info', duration = 4000) {
    document.querySelector('.xfp-toast')?.remove();
    if (toastTimeout) clearTimeout(toastTimeout);

    const toast = document.createElement('div');
    toast.className = `xfp-toast ${type}`;

    const icon = type === 'warning' ? '⚠️' : type === 'error' ? '❌' : '🌴';
    toast.innerHTML = `<span class="xfp-toast-icon">${icon}</span><span>${message}</span>`;

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Hook into VibeFilter for rate limit notifications
  let lastRateLimitToast = 0;
  VibeFilter.onRateLimit = (apiName, waitSeconds) => {
    const now = Date.now();
    if (now - lastRateLimitToast > 30000) {
      lastRateLimitToast = now;
      showToast(`${apiName} rate limited. Using keyword scoring for ${waitSeconds}s`, 'warning', 5000);
    }
  };

  // IntersectionObserver for viewport detection
  const viewportObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const article = entry.target;
        if (!article.dataset.xfpProcessed) {
          processArticle(article);
        }
      }
    }
  }, {
    root: null,
    rootMargin: '200px',
    threshold: 0
  });

  // Hash function for generating stable IDs
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  // Extract article data from a Google News article element
  function extractNewsArticle(element) {
    try {
      // Use the element directly - don't traverse up
      if (!element) return null;

      // Use the stored headline link if available (passed from processVisibleArticles)
      // Otherwise fall back to searching within the element
      const linkEl = element._xfpHeadlineLink || element.querySelector('a[href*="/read/"]');

      if (!linkEl) {
        console.log('🌴 XFP Debug: No /read/ link found in element');
        return null;
      }

      // The headline is the link text itself
      const headline = linkEl.textContent?.trim();
      if (!headline || headline.length < 10) {
        console.log('🌴 XFP Debug: Headline too short:', headline);
        return null;
      }

      // Skip "Full Coverage" links
      if (headline === 'Full Coverage') {
        return null;
      }

      const articleUrl = linkEl.href || '';

      // Generate stable ID from URL or headline
      const id = articleUrl ? `gnews-${hashString(articleUrl)}` : `gnews-${hashString(headline)}`;

      // Find snippet/description - usually a sibling or nearby element
      let snippet = '';

      // Try to find snippet in various ways - look near the link
      const linkParent = linkEl.parentElement;
      if (linkParent) {
        // Look for sibling text blocks
        const siblings = linkParent.parentElement?.children || [];
        for (const sibling of siblings) {
          if (sibling !== linkParent && sibling !== linkEl) {
            const text = sibling.textContent?.trim();
            // Skip if it looks like a source name (short) or timestamp
            if (text && text.length > 40 && !text.match(/^\d+\s*(hour|min|day|week)/i)) {
              snippet = text;
              break;
            }
          }
        }
      }

      // Find publication/source name - usually near the time element
      // In Google News, source appears before the headline typically
      let sourceName = 'Unknown';

      // Look for time element and get source from nearby text
      const timeEl = element.querySelector('time');
      if (timeEl) {
        // Source name is often a sibling or in the same container
        const timeParent = timeEl.parentElement;
        if (timeParent) {
          // Look for a link that's not the article link (might be source link)
          const sourceLink = timeParent.querySelector('a:not([href*="/read/"])');
          if (sourceLink) {
            sourceName = sourceLink.textContent?.trim() || 'Unknown';
          } else {
            // Try getting text before time
            const parentText = timeParent.textContent?.trim();
            const timePart = timeEl.textContent?.trim() || '';
            if (parentText && timePart) {
              const beforeTime = parentText.split(timePart)[0]?.trim();
              if (beforeTime && beforeTime.length < 50 && beforeTime.length > 2) {
                sourceName = beforeTime.replace(/[·•\-–—]$/, '').trim();
              }
            }
          }
        }
      }

      // Parse timestamp
      let timestamp = Date.now();
      if (timeEl?.dateTime) {
        timestamp = new Date(timeEl.dateTime).getTime();
      } else if (timeEl?.textContent) {
        // Try to parse relative time like "2 hours ago"
        const relTime = timeEl.textContent;
        const match = relTime.match(/(\d+)\s*(hour|min|day|week|month)/i);
        if (match) {
          const num = parseInt(match[1]);
          const unit = match[2].toLowerCase();
          const multipliers = {
            'min': 60 * 1000,
            'hour': 60 * 60 * 1000,
            'day': 24 * 60 * 60 * 1000,
            'week': 7 * 24 * 60 * 60 * 1000,
            'month': 30 * 24 * 60 * 60 * 1000
          };
          timestamp = Date.now() - (num * (multipliers[unit] || multipliers['hour']));
        }
      }

      // Check for image
      const hasImage = !!element.querySelector('img[src*="http"]');

      // Detect section (for context) - look for h2 headers above
      let section = null;
      let parent = element.parentElement;
      for (let i = 0; i < 10 && parent && parent !== document.body; i++) {
        const header = parent.querySelector('h2, [role="heading"][aria-level="2"]');
        if (header) {
          const headerText = header.textContent?.trim();
          // Make sure it's a section header not an article
          if (headerText && headerText.length < 50) {
            section = headerText;
            break;
          }
        }
        parent = parent.parentElement;
      }

      console.log('🌴 XFP Debug: Extracted article:', { id, headline: headline.slice(0, 50), sourceName, section });

      // Build the article object - use same schema as tweets for compatibility
      return {
        id,
        source: 'googlenews',
        text: snippet ? `${headline}. ${snippet}` : headline, // Combined for scoring
        headline,
        snippet,
        url: articleUrl,
        timestamp,
        authorId: sourceName, // Reuse for publication
        authorName: sourceName,
        authorAvatar: '',
        feedOwner: null,
        metrics: null,
        media: { hasImage, hasVideo: false, hasQuote: false },
        isRetweet: null,
        section,
        collectedAt: Date.now()
      };
    } catch (error) {
      console.error('XFeed Paradise: Error extracting news article:', error);
      return null;
    }
  }

  // Apply filter to an article element
  function applyFilter(articleEl, article, score) {
    if (!VibeFilter.settings.enabled) return;

    const shouldShow = VibeFilter.shouldShow(score);
    const vibeLabel = VibeFilter.getVibeLabel(score);

    // Remove any existing vibe indicators
    articleEl.querySelector('.xfp-vibe-indicator')?.remove();

    // Add score indicator if enabled
    if (VibeFilter.settings.showScores) {
      const indicator = document.createElement('div');
      indicator.className = `xfp-vibe-indicator ${vibeLabel.class}`;
      indicator.innerHTML = `${vibeLabel.label} (${score})`;
      articleEl.style.position = 'relative';
      articleEl.prepend(indicator);
    }

    // Apply filter mode - apply directly to the element, don't traverse up
    if (!shouldShow) {
      const wasAlreadyHidden = articleEl.classList.contains('xfp-hidden') ||
                               articleEl.classList.contains('xfp-dimmed') ||
                               articleEl.classList.contains('xfp-labeled');

      switch (VibeFilter.settings.filterMode) {
        case 'hide':
          articleEl.classList.add('xfp-hidden');
          break;
        case 'dim':
          articleEl.classList.add('xfp-dimmed');
          break;
        case 'label':
          articleEl.classList.add('xfp-labeled');
          if (!articleEl.querySelector('.xfp-warning-label')) {
            const warning = document.createElement('div');
            warning.className = 'xfp-warning-label';
            warning.innerHTML = `
              <span>🌴 Hidden by XFeed Paradise: ${vibeLabel.label}</span>
              <button class="xfp-show-anyway">Show anyway</button>
            `;
            warning.querySelector('.xfp-show-anyway').addEventListener('click', (e) => {
              e.stopPropagation();
              articleEl.classList.remove('xfp-labeled');
              warning.remove();
              hiddenCount = Math.max(0, hiddenCount - 1);
            });
            articleEl.prepend(warning);
          }
          break;
      }

      // Track hidden article info if newly hidden
      if (!wasAlreadyHidden) {
        hiddenCount++;
        hiddenItems.unshift({
          id: article.id,
          text: article.headline?.slice(0, 100) + (article.headline?.length > 100 ? '...' : ''),
          author: article.authorName,
          authorHandle: article.authorId, // Publication name
          score: score,
          url: article.url,
          vibeLabel: vibeLabel.label
        });
        // Keep only last 50
        if (hiddenItems.length > 50) {
          hiddenItems.pop();
        }
      }
    } else {
      // Ensure shown articles are visible
      articleEl.classList.remove('xfp-hidden', 'xfp-dimmed', 'xfp-labeled');
    }
  }

  // Process a single article element
  function processArticle(articleElement) {
    // Don't go up to find containers - use the element we found directly
    // This prevents accidentally selecting parent containers
    if (!articleElement) return;

    // Check if already processed
    if (articleElement.dataset.xfpProcessed) {
      return;
    }

    const article = extractNewsArticle(articleElement);
    if (!article) return;

    // Mark as processed
    articleElement.dataset.xfpProcessed = 'true';
    articleElement.dataset.xfpArticle = 'true'; // Mark for CSS targeting
    processedArticles.add(article.id);

    // Get score with AI refinement callback
    const { score, source } = VibeFilter.getScoreWithRefinement(
      article.id,
      article.text,
      (aiScore, aiSource) => {
        if (articleElement && articleElement.isConnected) {
          article.vibeScore = aiScore;
          article.scoredWithAI = true;
          applyFilter(articleElement, article, aiScore);
          updateFloatingPanel();

          // Update in database
          window.tweetDB.saveTweet({ ...article, vibeScore: aiScore, scoredWithAI: true }).catch(() => {});
        }
      }
    );

    article.vibeScore = score;
    article.scoredWithAI = source === 'ai';

    // Apply filter immediately with initial score
    applyFilter(articleElement, article, score);

    // Save to database
    window.tweetDB.saveTweet(article).catch(error => {
      console.error('XFeed Paradise: Error saving article:', error);
    });
  }

  // Register an article with the viewport observer
  function registerArticle(element, headlineLink) {
    if (!element || element.dataset.xfpObserved) return;
    element.dataset.xfpObserved = 'true';
    // Store the headline link reference so extraction uses the right one
    element._xfpHeadlineLink = headlineLink;
    viewportObserver.observe(element);
    // Also try to process immediately
    if (!element.dataset.xfpProcessed) {
      processArticle(element);
    }
  }

  // Process all visible articles
  function processVisibleArticles() {
    // Google News uses /read/ links for articles, not /articles/
    // Find all article links - they have href containing "/read/" and substantial text
    const articleLinks = document.querySelectorAll('a[href*="/read/"]');

    console.log('🌴 XFP Debug: Found', articleLinks.length, 'article links');

    articleLinks.forEach(link => {
      // Skip if it's a "Full Coverage" link or other short text
      const linkText = link.textContent?.trim();
      if (!linkText || linkText.length < 20 || linkText === 'Full Coverage') {
        return;
      }

      // Skip if already observed
      if (link.dataset.xfpObserved) {
        return;
      }

      // Mark this specific link as observed
      link.dataset.xfpObserved = 'true';

      // Find a reasonable container - go up a few levels
      // but stop before we get to containers with many articles
      let container = link;
      for (let i = 0; i < 4; i++) {
        const parent = container.parentElement;
        if (!parent || parent.tagName === 'MAIN' || parent.tagName === 'NAV') {
          break;
        }
        // Stop if parent contains multiple article links
        const linksInParent = parent.querySelectorAll('a[href*="/read/"]');
        if (linksInParent.length > 3) {
          break;
        }
        container = parent;
      }

      console.log('🌴 XFP Debug: Registering article:', linkText.slice(0, 50));
      // Pass the original headline link so extraction uses it directly
      registerArticle(container, link);
    });

    console.log('🌴 XFP Debug: Total processed articles:', processedArticles.size);
  }

  // Observe DOM for new articles
  function observeArticles() {
    const observer = new MutationObserver((mutations) => {
      // Debounce processing
      clearTimeout(observer._timeout);
      observer._timeout = setTimeout(() => {
        processVisibleArticles();
      }, 100);
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
      reprocessVisibleArticles();
      sendResponse({ success: true });
    } else if (message.type === 'CLEAR_DATA') {
      window.tweetDB.clearAll().then(() => {
        processedArticles.clear();
        hiddenCount = 0;
        hiddenItems.length = 0;
        updateFloatingPanel();
        sendResponse({ success: true });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
      return true;
    } else if (message.type === 'GET_STATS') {
      window.tweetDB.getStats().then(stats => {
        sendResponse({
          stats,
          processedCount: processedArticles.size,
          hiddenCount,
          hiddenTweets: hiddenItems.slice(0, 20) // Keep same field name for popup compatibility
        });
      });
      return true;
    } else if (message.type === 'GET_AI_STATUS') {
      sendResponse({
        aiReady: groqApiReady,
        aiLoading: !groqApiReady && VibeFilter.settings.useAI,
        aiProgress: 100
      });
    } else if (message.type === 'TOGGLE_ENABLED') {
      VibeFilter.settings.enabled = message.enabled;
      reprocessVisibleArticles();
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
      VibeFilter.groqApiKey = message.apiKey || null;
      sendResponse({ success: true });
    } else if (message.type === 'UPDATE_CUSTOM_PROMPT') {
      VibeFilter.customPrompt = message.prompt || null;
      sendResponse({ success: true });
    } else if (message.type === 'GET_GROQ_USAGE') {
      sendResponse({ usage: VibeFilter.groqUsage });
    } else if (message.type === 'GET_DEFAULT_PROMPT') {
      sendResponse({ defaultPrompt: VibeFilter.defaultPrompt });
    }
    return true;
  });

  // Reprocess all visible articles
  function reprocessVisibleArticles() {
    const containers = document.querySelectorAll('article, c-wiz[data-n-au], [data-n-tid]');
    containers.forEach(container => {
      container.classList.remove('xfp-hidden', 'xfp-dimmed', 'xfp-labeled');
      container.querySelector('.xfp-vibe-indicator')?.remove();
      container.querySelector('.xfp-warning-label')?.remove();
      container.dataset.xfpProcessed = '';
      container.dataset.xfpObserved = '';
    });

    processedArticles.clear();
    hiddenCount = 0;
    hiddenItems.length = 0;
    processVisibleArticles();
  }

  // Create floating panel UI (adapted from content.js)
  function createFloatingPanel() {
    document.querySelector('.xfp-floating-panel')?.remove();

    const position = VibeFilter.settings.floatingPosition || 'bottom-right';
    const isHidden = VibeFilter.settings.floatingHidden || false;

    const panel = document.createElement('div');
    panel.className = `xfp-floating-panel site-googlenews pos-${position}`;
    if (isHidden) panel.classList.add('hidden');

    panel.innerHTML = `
      <div class="xfp-floating-dropdown">
        <div class="xfp-dropdown-header">
          <span class="xfp-dropdown-title">🌴 XFeed Paradise (News)</span>
          <button class="xfp-dropdown-close">&times;</button>
        </div>

        <!-- Hidden Articles Section -->
        <div class="xfp-section">
          <button class="xfp-section-toggle xfp-hidden-toggle expanded">
            <span>Hidden Articles <span class="xfp-hidden-count-label">(0)</span></span>
            <span class="xfp-toggle-icon">▼</span>
          </button>
          <div class="xfp-section-content xfp-hidden-content show">
            <div class="xfp-dropdown-list">
              <div class="xfp-dropdown-empty">No articles hidden yet</div>
            </div>
          </div>
        </div>

        <!-- Settings Section -->
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

            <!-- Show Scores -->
            <div class="xfp-setting-row">
              <label class="xfp-checkbox-row">
                <input type="checkbox" class="xfp-show-scores-cb">
                <span>Show vibe scores on articles</span>
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

            <div class="xfp-divider"></div>

            <!-- Threshold -->
            <div class="xfp-setting-row">
              <label class="xfp-setting-label">Vibe Threshold</label>
              <div class="xfp-slider-row">
                <input type="range" class="xfp-slider xfp-threshold-slider" min="-50" max="50" value="0">
                <span class="xfp-slider-value xfp-threshold-value">0</span>
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

    chrome.storage.local.get('floatingDropdownOpen', (result) => {
      if (result.floatingDropdownOpen) {
        dropdown.classList.add('show');
        updateFloatingPanel();
      }
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShowing = dropdown.classList.toggle('show');
      chrome.storage.local.set({ floatingDropdownOpen: isShowing });
      if (isShowing) {
        updateFloatingPanel();
      }
    });

    closeBtn.addEventListener('click', () => {
      dropdown.classList.remove('show');
      chrome.storage.local.set({ floatingDropdownOpen: false });
    });

    // Hidden section toggle
    const hiddenToggle = panel.querySelector('.xfp-hidden-toggle');
    const hiddenContent = panel.querySelector('.xfp-hidden-content');

    hiddenToggle.addEventListener('click', () => {
      hiddenToggle.classList.toggle('expanded');
      hiddenContent.classList.toggle('show');
    });

    // Settings section toggle
    const settingsToggle = panel.querySelector('.xfp-settings-toggle');
    const settingsContent = panel.querySelector('.xfp-settings-content');

    settingsToggle.addEventListener('click', () => {
      settingsToggle.classList.toggle('expanded');
      settingsContent.classList.toggle('show');
    });

    // Filter Active checkbox
    const filterActiveCb = panel.querySelector('.xfp-filter-active-cb');
    filterActiveCb.addEventListener('change', () => {
      VibeFilter.settings.enabled = filterActiveCb.checked;
      VibeFilter.saveSettings({ enabled: filterActiveCb.checked });
      reprocessVisibleArticles();
    });

    // Filter mode buttons
    panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-filter-modes .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        VibeFilter.settings.filterMode = btn.dataset.mode;
        VibeFilter.saveSettings({ filterMode: btn.dataset.mode });
        reprocessVisibleArticles();
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
      reprocessVisibleArticles();
    });

    // Show scores checkbox
    const showScoresCb = panel.querySelector('.xfp-show-scores-cb');
    showScoresCb.addEventListener('change', () => {
      VibeFilter.settings.showScores = showScoresCb.checked;
      VibeFilter.saveSettings({ showScores: showScoresCb.checked });
      reprocessVisibleArticles();
    });

    // Use AI checkbox
    const useAiCb = panel.querySelector('.xfp-use-ai-cb');
    useAiCb.addEventListener('change', () => {
      VibeFilter.settings.useAI = useAiCb.checked;
      VibeFilter.saveSettings({ useAI: useAiCb.checked });
      if (useAiCb.checked && !groqApiReady) {
        initAIScorer();
      }
      reprocessVisibleArticles();
    });

    // Position buttons
    panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.xfp-positions .xfp-setting-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panel.className = `xfp-floating-panel site-googlenews pos-${btn.dataset.pos}`;
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

    // Update badge and hidden count
    if (badge) {
      badge.textContent = hiddenCount;
      badge.style.display = hiddenCount > 0 ? 'flex' : 'none';
    }
    if (hiddenCountLabel) {
      hiddenCountLabel.textContent = `(${hiddenCount})`;
    }

    // Update AI status
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

    // Update hidden articles list
    if (list) {
      if (hiddenItems.length === 0) {
        list.innerHTML = '<div class="xfp-dropdown-empty">No articles hidden yet</div>';
      } else {
        list.innerHTML = hiddenItems.slice(0, 20).map(item => `
          <div class="xfp-dropdown-item" data-url="${item.url}">
            ${item.authorHandle && item.authorHandle !== 'Unknown' ? `<div class="xfp-dropdown-author">${escapeHtml(item.authorHandle)}</div>` : ''}
            <div class="xfp-dropdown-text">${escapeHtml(item.text)}</div>
            <div class="xfp-dropdown-meta">
              <span>${item.vibeLabel}</span>
              <span>Score: ${item.score}</span>
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
      if (statProcessed) statProcessed.textContent = processedArticles.size;
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

  // Update badge periodically
  const originalHiddenCount = { value: 0 };
  setInterval(() => {
    if (originalHiddenCount.value !== hiddenCount) {
      originalHiddenCount.value = hiddenCount;
      updateFloatingPanel();
    }
  }, 500);

  // Initialize
  console.log('🌴 XFeed Paradise: Starting article observation...');
  processVisibleArticles();
  observeArticles();

  // Log stats periodically
  setInterval(async () => {
    const stats = await window.tweetDB.getStats();
    console.log(`🌴 XFeed Paradise: ${stats.tweetCount} items collected, ${processedArticles.size} processed this session`);
  }, 60000);

  console.log('🌴 XFeed Paradise: Active and filtering Google News!');
})();
