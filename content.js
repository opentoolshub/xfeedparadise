// XFeed Paradise - Content Script
// Monitors X/Twitter feed, extracts tweets, and filters based on vibe score
// Now with AI-powered sentiment analysis!

(async function() {
  'use strict';

  console.log('🌴 XFeed Paradise: Initializing...');

  // Wait for dependencies
  await window.tweetDB.ready;
  await VibeFilter.loadSettings();

  // Initialize AI Scorer
  let aiScorerReady = false;
  async function initAIScorer() {
    try {
      console.log('🌴 XFeed Paradise: Loading AI model...');

      // Dynamic import of transformers.js
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1');

      // Use sentiment analysis pipeline
      const classifier = await pipeline(
        'sentiment-analysis',
        'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
        { progress_callback: (progress) => {
          if (progress.status === 'progress') {
            console.log(`🌴 AI Model loading: ${Math.round(progress.progress)}%`);
          }
        }}
      );

      // Create AI scorer object
      window.AIScorer = {
        isReady: true,
        classifier,
        async scoreTweet(text) {
          try {
            const result = await this.classifier(text.slice(0, 512)); // Limit text length
            if (result && result[0]) {
              const { label, score } = result[0];
              if (label === 'POSITIVE') {
                return Math.round((score - 0.5) * 200);
              } else {
                return Math.round((0.5 - score) * 200);
              }
            }
          } catch (e) {
            console.error('AI scoring error:', e);
          }
          return null;
        }
      };

      VibeFilter.aiScorer = window.AIScorer;
      aiScorerReady = true;
      console.log('🌴 XFeed Paradise: AI model loaded! Using AI-powered scoring.');

      // Reprocess visible tweets with AI
      reprocessVisibleTweets();

    } catch (error) {
      console.warn('🌴 XFeed Paradise: AI model failed to load, using keyword scoring:', error.message);
    }
  }

  // Start loading AI in background (don't block initial filtering)
  if (VibeFilter.settings.useAI !== false) {
    initAIScorer();
  }

  // Track processed tweets to avoid duplicates
  const processedTweets = new Set();

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
      switch (VibeFilter.settings.filterMode) {
        case 'hide':
          article.closest('[data-testid="cellInnerDiv"]')?.classList.add('xfp-hidden');
          break;
        case 'dim':
          article.closest('[data-testid="cellInnerDiv"]')?.classList.add('xfp-dimmed');
          break;
        case 'label':
          article.closest('[data-testid="cellInnerDiv"]')?.classList.add('xfp-labeled');
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
            });
            article.prepend(warning);
          }
          break;
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
        sendResponse({ stats, processedCount: processedTweets.size });
      });
      return true; // Keep channel open for async response
    } else if (message.type === 'GET_AI_STATUS') {
      sendResponse({
        aiReady: aiScorerReady,
        aiLoading: !aiScorerReady && VibeFilter.settings.useAI
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

    // Clear processed set to force reprocessing
    processedTweets.clear();
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
