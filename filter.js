// Vibe-based tweet filtering algorithm
// Scores tweets from -100 (pure outrage) to +100 (pure enlightenment)
// Uses multiple AI APIs with fallback: Groq -> Together.ai -> Keywords

const VibeFilter = {
  // Default settings
  settings: {
    enabled: true,
    threshold: 0,
    showScores: false,
    filterMode: 'hide',
    useAI: true,
    debugMode: false,
    customPositiveWords: [],
    customNegativeWords: [],
  },

  aiScorer: null,

  // Callback for rate limit notifications (set by content.js)
  onRateLimit: null,

  // API Configuration
  apis: {
    groq: {
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      defaultKey: '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',
      userKey: null,
      rateLimited: false,
      rateLimitReset: 0,
      lastRequest: 0,
      minInterval: 2200, // ~27 RPM
      usage: { remaining: null, limit: null }
    },
    together: {
      name: 'Together',
      baseUrl: 'https://api.together.xyz/v1/chat/completions',
      model: 'meta-llama/Llama-3.2-3B-Instruct-Turbo',
      defaultKey: null, // User must provide
      userKey: null,
      rateLimited: false,
      rateLimitReset: 0,
      lastRequest: 0,
      minInterval: 1100, // ~55 RPM (under 60 RPM limit)
      usage: { remaining: null, limit: null }
    }
  },

  // Current API preference order
  apiOrder: ['groq', 'together'],

  // Batch processing
  batchQueue: [],
  batchProcessing: false,
  batchSize: 10, // Smaller batches for faster response
  batchDelay: 150, // Very short delay - fire fast!
  batchTimeout: null,

  // Score cache
  scoreCache: new Map(),

  // Custom prompt
  customPrompt: null,

  // Debug logging
  debug(...args) {
    if (this.settings.debugMode) {
      console.log('🌴 [XFP Debug]', ...args);
    }
  },

  // Get active API key for an API
  getApiKey(apiName) {
    const api = this.apis[apiName];
    return api?.userKey || api?.defaultKey;
  },

  // Check if an API is available (has key and not rate limited)
  isApiAvailable(apiName) {
    const api = this.apis[apiName];
    if (!api) return false;

    const hasKey = !!(api.userKey || api.defaultKey);
    const isRateLimited = api.rateLimited && Date.now() < api.rateLimitReset;

    return hasKey && !isRateLimited;
  },

  // Get the best available API
  getBestApi() {
    for (const apiName of this.apiOrder) {
      if (this.isApiAvailable(apiName)) {
        return apiName;
      }
    }
    return null;
  },

  // Default batch prompt
  getBatchPrompt(tweets) {
    return `Rate the sentiment/vibe of each tweet from -100 (very negative, toxic, outrage-bait) to +100 (very positive, uplifting, enlightening).

Consider for each: Is it angry/divisive? Inflammatory? Spreading fear/hate? Or kind, helpful, educational, inspiring?

Reply with ONLY the scores as a JSON array of integers, like: [25, -30, 50, -10, ...]
One number per tweet, in the same order. No other text.

Tweets to rate:
${tweets.map((t, i) => `${i + 1}. "${t.slice(0, 200)}"`).join('\n')}`;
  },

  // Queue a tweet for batch AI scoring
  queueForAIScoring(tweetId, text, callback) {
    if (!this.settings.useAI) return;

    // Skip if no API available
    const bestApi = this.getBestApi();
    if (!bestApi) {
      this.debug('No API available, skipping AI queue');
      return;
    }

    // Skip if already cached with AI score
    const cached = this.scoreCache.get(tweetId);
    if (cached && cached.source === 'ai') return;

    this.batchQueue.push({ tweetId, text, callback });
    this.debug(`Queued tweet ${tweetId}. Queue: ${this.batchQueue.length}, API: ${bestApi}`);

    // Start batch timer
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => {
        this.batchTimeout = null;
        this.processBatchQueue();
      }, this.batchDelay);
    }

    // Process immediately if queue is full
    if (this.batchQueue.length >= this.batchSize) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
      this.processBatchQueue();
    }
  },

  // Process the batch queue
  async processBatchQueue() {
    if (this.batchProcessing || this.batchQueue.length === 0) return;
    this.batchProcessing = true;

    while (this.batchQueue.length > 0) {
      const apiName = this.getBestApi();

      if (!apiName) {
        // No API available - fall back to keywords for all queued
        this.debug('No API available, using keywords for queued tweets');
        console.warn('🌴 XFP: All APIs rate limited. Using keyword scoring.');

        while (this.batchQueue.length > 0) {
          const { tweetId, text, callback } = this.batchQueue.shift();
          const keywordScore = this.calculateKeywordScore(text);
          this.scoreCache.set(tweetId, { score: keywordScore, source: 'keyword', timestamp: Date.now() });
          if (callback) callback(keywordScore, 'keyword');
        }
        break;
      }

      const api = this.apis[apiName];

      // Rate limiting wait
      const now = Date.now();
      const timeSince = now - api.lastRequest;
      if (timeSince < api.minInterval) {
        await new Promise(r => setTimeout(r, api.minInterval - timeSince));
      }

      // Grab a batch
      const batch = this.batchQueue.splice(0, this.batchSize);
      api.lastRequest = Date.now();

      this.debug(`Scoring ${batch.length} tweets with ${api.name}...`);

      try {
        const scores = await this.scoreBatchWithApi(apiName, batch.map(b => b.text));

        if (scores && scores.length === batch.length) {
          batch.forEach((item, i) => {
            const aiScore = scores[i];
            if (aiScore !== null) {
              const keywordScore = this.calculateKeywordScore(item.text);
              const finalScore = Math.round(aiScore * 0.85 + keywordScore * 0.15);
              const clampedScore = Math.max(-100, Math.min(100, finalScore));

              this.scoreCache.set(item.tweetId, {
                score: clampedScore,
                source: 'ai',
                api: apiName,
                timestamp: Date.now()
              });

              this.debug(`Tweet ${item.tweetId}: AI=${aiScore}, Final=${clampedScore} (${api.name})`);
              if (item.callback) item.callback(clampedScore, 'ai');
            }
          });
        } else {
          // Scoring failed, put items back in queue to try another API
          this.debug(`${api.name} returned invalid scores, will retry with fallback`);
          this.batchQueue.unshift(...batch);
        }
      } catch (error) {
        console.error(`🌴 XFP: ${api.name} error:`, error);
        this.debug(`${api.name} error: ${error.message}`);
        // Put items back to try another API
        this.batchQueue.unshift(...batch);
      }
    }

    this.batchProcessing = false;
  },

  // Score batch with a specific API
  async scoreBatchWithApi(apiName, texts) {
    const api = this.apis[apiName];
    const apiKey = this.getApiKey(apiName);

    if (!apiKey || texts.length === 0) return null;

    const prompt = this.customPrompt
      ? `${this.customPrompt}\n\nRate each of these ${texts.length} tweets. Reply with ONLY a JSON array of ${texts.length} integers.\n\nTweets:\n${texts.map((t, i) => `${i + 1}. "${t.slice(0, 200)}"`).join('\n')}`
      : this.getBatchPrompt(texts);

    try {
      const response = await fetch(api.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 200
        })
      });

      // Update usage from headers (Groq-style)
      const remaining = response.headers.get('x-ratelimit-remaining-requests');
      const limit = response.headers.get('x-ratelimit-limit-requests');
      if (remaining) api.usage.remaining = parseInt(remaining);
      if (limit) api.usage.limit = parseInt(limit);

      this.debug(`${api.name} usage: ${api.usage.remaining}/${api.usage.limit}`);

      if (response.status === 429) {
        const resetHeader = response.headers.get('x-ratelimit-reset-requests') ||
                           response.headers.get('retry-after');
        const waitTime = this.parseResetTime(resetHeader) || 60000;
        const waitSeconds = Math.round(waitTime / 1000);

        console.warn(`🌴 XFP: ${api.name} rate limited for ${waitSeconds}s. Switching to fallback.`);
        this.debug(`${api.name} rate limited. Reset: ${waitTime}ms`);

        api.rateLimited = true;
        api.rateLimitReset = Date.now() + waitTime;

        // Notify UI
        if (this.onRateLimit) {
          this.onRateLimit(api.name, waitSeconds);
        }

        return null;
      }

      if (!response.ok) {
        console.warn(`🌴 XFP: ${api.name} error ${response.status}`);
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();

      this.debug(`${api.name} response: ${content}`);

      return this.parseScoresFromResponse(content, texts.length);
    } catch (error) {
      console.error(`🌴 XFP: ${api.name} error:`, error);
      return null;
    }
  },

  // Parse scores from API response
  parseScoresFromResponse(content, expectedCount) {
    if (!content) return null;

    try {
      // Try to extract JSON array
      const arrayMatch = content.match(/\[[\d\s,\-]+\]/);
      if (arrayMatch) {
        const scores = JSON.parse(arrayMatch[0]);
        if (Array.isArray(scores) && scores.length === expectedCount) {
          return scores.map(s => Math.max(-100, Math.min(100, Math.round(Number(s)))));
        }
      }
    } catch (e) {
      this.debug(`JSON parse failed: ${e.message}`);
    }

    // Fallback: extract numbers
    const numbers = content.match(/-?\d+/g);
    if (numbers && numbers.length === expectedCount) {
      return numbers.map(n => Math.max(-100, Math.min(100, parseInt(n))));
    }

    return null;
  },

  // Parse reset time from header
  parseResetTime(resetHeader) {
    if (!resetHeader) return 60000;

    // Handle numeric seconds
    const numericSec = parseInt(resetHeader);
    if (!isNaN(numericSec) && numericSec < 1000) return numericSec * 1000;

    // Handle "1m30s" format
    let ms = 0;
    const minMatch = resetHeader.match(/(\d+)m/);
    const secMatch = resetHeader.match(/(\d+)s/);
    if (minMatch) ms += parseInt(minMatch[1]) * 60000;
    if (secMatch) ms += parseInt(secMatch[1]) * 1000;

    return ms || 60000;
  },

  // Load API keys from storage
  async loadGroqApiKey() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['groqApiKey', 'togetherApiKey', 'customPrompt'], (result) => {
        this.apis.groq.userKey = result.groqApiKey || null;
        this.apis.together.userKey = result.togetherApiKey || null;
        this.customPrompt = result.customPrompt || null;

        // For backward compatibility
        this.groqApiKey = this.getApiKey('groq');

        resolve({
          groqApiKey: this.getApiKey('groq'),
          togetherApiKey: this.getApiKey('together'),
          customPrompt: this.customPrompt
        });
      });
    });
  },

  // Save Groq API key
  async saveGroqApiKey(key) {
    this.apis.groq.userKey = key || null;
    this.groqApiKey = this.getApiKey('groq');
    return new Promise((resolve) => {
      chrome.storage.sync.set({ groqApiKey: key }, resolve);
    });
  },

  // Save Together API key
  async saveTogetherApiKey(key) {
    this.apis.together.userKey = key || null;
    return new Promise((resolve) => {
      chrome.storage.sync.set({ togetherApiKey: key }, resolve);
    });
  },

  // Save custom prompt
  async saveCustomPrompt(prompt) {
    this.customPrompt = prompt;
    return new Promise((resolve) => {
      chrome.storage.sync.set({ customPrompt: prompt }, resolve);
    });
  },

  // Backward compatibility getter
  get groqApiKey() {
    return this.getApiKey('groq');
  },
  set groqApiKey(val) {
    // Handled by saveGroqApiKey
  },

  // Get usage stats for UI
  get groqUsage() {
    return {
      requestsRemaining: this.apis.groq.usage.remaining,
      requestsLimit: this.apis.groq.usage.limit,
      rateLimited: this.apis.groq.rateLimited,
      lastUpdated: Date.now()
    };
  },

  // Default prompt for single tweet (backward compat)
  defaultPrompt: `Rate the sentiment/vibe of this tweet from -100 (very negative, toxic, outrage-bait) to +100 (very positive, uplifting, enlightening). Consider: Is it angry/divisive? Does it use inflammatory language? Is it spreading fear or hate? Or is it kind, helpful, educational, or inspiring? Reply with ONLY a single integer number, nothing else.`,

  // Keyword patterns
  positivePatterns: [
    { pattern: /\b(learn(ed|ing)?|discover(ed|ing)?|insight|wisdom|understand(ing)?)\b/gi, weight: 8 },
    { pattern: /\b(curious|fascinated|interesting|remarkable)\b/gi, weight: 6 },
    { pattern: /\b(breakthrough|innovation|creative|inspired)\b/gi, weight: 8 },
    { pattern: /\b(grateful|thankful|blessed|appreciate|gratitude)\b/gi, weight: 10 },
    { pattern: /\b(beautiful|wonderful|amazing|incredible)\b/gi, weight: 5 },
    { pattern: /\b(love|joy|happy|excited|thrilled)\b/gi, weight: 6 },
    { pattern: /\b(hope|optimistic|bright future|promising)\b/gi, weight: 7 },
    { pattern: /\b(together|community|collaborate|support(ing)?|help(ing|ed)?)\b/gi, weight: 7 },
    { pattern: /\b(kind(ness)?|compassion|empathy|generous)\b/gi, weight: 9 },
    { pattern: /\b(friend(s)?|connection|relationship)\b/gi, weight: 4 },
    { pattern: /\b(achieved|accomplished|success|progress|milestone)\b/gi, weight: 6 },
    { pattern: /\b(built|created|launched|shipped)\b/gi, weight: 5 },
    { pattern: /\b(proud|celebrate|congrats|congratulations)\b/gi, weight: 6 },
    { pattern: /\b(mindful|peaceful|calm|serene|present)\b/gi, weight: 8 },
    { pattern: /\b(growth|evolving|transform|journey)\b/gi, weight: 6 },
    { pattern: /\b(heal(ing)?|recover(y|ing)?|wellness)\b/gi, weight: 7 },
    { pattern: /\b(research|study|evidence|data shows)\b/gi, weight: 5 },
    { pattern: /\b(nuanced|complex|thoughtful|considered)\b/gi, weight: 7 },
    { pattern: /\bTIL\b|today I learned/gi, weight: 6 },
  ],

  negativePatterns: [
    { pattern: /\b(outrage|outraged|outrageous|infuriating)\b/gi, weight: -15 },
    { pattern: /\b(furious|angry|rage|hatred|hate)\b/gi, weight: -12 },
    { pattern: /\b(disgusting|disgusted|vile|despicable)\b/gi, weight: -12 },
    { pattern: /\b(unacceptable|unbelievable|shocking)\b/gi, weight: -8 },
    { pattern: /\b(enemy|enemies|destroy|crush|defeat them)\b/gi, weight: -15 },
    { pattern: /\b(wake up|sheeple|they don't want you to)\b/gi, weight: -12 },
    { pattern: /\b(us vs them|pick a side|with us or against)\b/gi, weight: -10 },
    { pattern: /\b(terrifying|horrifying|nightmare|catastrophe)\b/gi, weight: -10 },
    { pattern: /\b(dangerous|threat|warned|warning)\b/gi, weight: -5 },
    { pattern: /\b(crisis|emergency|urgent|breaking)\b/gi, weight: -4 },
    { pattern: /\b(stupid|idiot|moron|dumb|fool)\b/gi, weight: -15 },
    { pattern: /\b(clown|joke|pathetic|loser)\b/gi, weight: -12 },
    { pattern: /\b(trash|garbage|worthless)\b/gi, weight: -10 },
    { pattern: /\b(everyone knows|obviously|clearly you)\b/gi, weight: -6 },
    { pattern: /\b(exposed|busted|caught|lie|liar|lying)\b/gi, weight: -8 },
    { pattern: /ratio|L\s*\+|cope|seethe/gi, weight: -10 },
    { pattern: /\b(fight|battle|war|attack(ed|ing)?)\b/gi, weight: -6 },
    { pattern: /\b(slam(s|med)?|blast(s|ed)?|destroy(s|ed)?|wreck(s|ed)?)\b/gi, weight: -8 },
    { pattern: /\b(demolish|eviscerate|obliterate)\b/gi, weight: -10 },
    { pattern: /\b(doomed|hopeless|end times|collapse)\b/gi, weight: -10 },
    { pattern: /\b(worst|terrible|horrible|awful)\b/gi, weight: -6 },
    { pattern: /\b(never|always|everyone|no one) (does|is|will)\b/gi, weight: -5 },
  ],

  structuralPatterns: [
    { test: (text) => {
      const words = text.split(/\s+/).filter(w => w.length > 3);
      const capsWords = words.filter(w => w === w.toUpperCase() && /[A-Z]/.test(w));
      return capsWords.length > 3 ? -15 : capsWords.length > 1 ? -8 : 0;
    }},
    { test: (text) => {
      const excessive = (text.match(/[!?]{2,}/g) || []).length;
      return excessive > 2 ? -12 : excessive > 0 ? -5 : 0;
    }},
    { test: (text) => {
      if (/^(Am I the only one|Does anyone else|Why is no one talking about)/i.test(text)) return -8;
      if (/Thoughts\?$|Agree\?$|Right\?$/i.test(text)) return -5;
      return 0;
    }},
    { test: (text) => {
      if (/^(Thread|🧵|A thread|Here's why|1\/)/i.test(text)) return -3;
      if (/like and retweet|retweet if you|share this/i.test(text)) return -10;
      return 0;
    }},
    { test: (text) => {
      if (/what (do you think|are your thoughts|have you learned)/i.test(text)) return 5;
      if (/how (do you|did you|can we)/i.test(text)) return 4;
      return 0;
    }},
  ],

  // Calculate keyword score (instant, no API)
  calculateKeywordScore(text) {
    let score = 0;

    for (const { pattern, weight } of this.positivePatterns) {
      const matches = text.match(pattern);
      if (matches) score += weight * matches.length;
    }

    for (const { pattern, weight } of this.negativePatterns) {
      const matches = text.match(pattern);
      if (matches) score += weight * matches.length;
    }

    for (const { test } of this.structuralPatterns) {
      score += test(text);
    }

    const lowerText = text.toLowerCase();
    for (const word of this.settings.customPositiveWords) {
      if (lowerText.includes(word.toLowerCase())) score += 10;
    }
    for (const word of this.settings.customNegativeWords) {
      if (lowerText.includes(word.toLowerCase())) score -= 10;
    }

    return Math.max(-100, Math.min(100, score));
  },

  // Get instant score and queue for AI refinement
  getScoreWithRefinement(tweetId, text, onUpdate) {
    const cached = this.scoreCache.get(tweetId);
    if (cached) {
      this.debug(`Cache hit: ${tweetId} = ${cached.score} (${cached.source})`);
      return { score: cached.score, source: cached.source };
    }

    const keywordScore = this.calculateKeywordScore(text);
    this.scoreCache.set(tweetId, { score: keywordScore, source: 'keyword', timestamp: Date.now() });

    if (this.settings.useAI && this.getBestApi()) {
      this.queueForAIScoring(tweetId, text, onUpdate);
    }

    return { score: keywordScore, source: 'keyword' };
  },

  // Legacy async method
  async calculateScore(tweet) {
    const { score } = this.getScoreWithRefinement(tweet.id || `temp-${Date.now()}`, tweet.text || '', null);
    return score;
  },

  calculateScoreSync(tweet) {
    return this.calculateKeywordScore(tweet.text || '');
  },

  shouldShow(score) {
    return score >= this.settings.threshold;
  },

  getVibeLabel(score) {
    if (score >= 50) return { label: '✨ Enlightening', class: 'vibe-enlightening' };
    if (score >= 20) return { label: '🌱 Uplifting', class: 'vibe-uplifting' };
    if (score >= 0) return { label: '😐 Neutral', class: 'vibe-neutral' };
    if (score >= -20) return { label: '😕 Meh', class: 'vibe-meh' };
    if (score >= -50) return { label: '😤 Negative', class: 'vibe-negative' };
    return { label: '🔥 Outrage-bait', class: 'vibe-outrage' };
  },

  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('vibeFilterSettings', (result) => {
        if (result.vibeFilterSettings) {
          this.settings = { ...this.settings, ...result.vibeFilterSettings };
        }
        resolve(this.settings);
      });
    });
  },

  async saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    return new Promise((resolve) => {
      chrome.storage.sync.set({ vibeFilterSettings: this.settings }, resolve);
    });
  },

  clearCache() {
    this.scoreCache.clear();
    this.debug('Cache cleared');
  },

  // Get API status for UI
  getApiStatus() {
    return {
      groq: {
        available: this.isApiAvailable('groq'),
        hasKey: !!this.getApiKey('groq'),
        rateLimited: this.apis.groq.rateLimited,
        usage: this.apis.groq.usage
      },
      together: {
        available: this.isApiAvailable('together'),
        hasKey: !!this.getApiKey('together'),
        rateLimited: this.apis.together.rateLimited,
        usage: this.apis.together.usage
      },
      activeApi: this.getBestApi()
    };
  }
};

window.VibeFilter = VibeFilter;
