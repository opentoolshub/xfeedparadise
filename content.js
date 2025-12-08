// XFeed Paradise - Content Script
// Monitors X/Twitter feed, extracts tweets, and filters based on vibe score
// Now with AI-powered sentiment analysis!

(async function() {
  'use strict';

  console.log('🌴 XFeed Paradise: Initializing...');

  // Wait for dependencies
  await window.tweetDB.ready;
  await VibeFilter.loadSettings();

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
