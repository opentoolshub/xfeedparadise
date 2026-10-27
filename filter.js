// Vibe-based tweet filtering algorithm
// Scores tweets from -100 (pure outrage) to +100 (pure enlightenment)
// Order: primary AI provider -> optional fallback provider -> keywords.
// Provider HTTP calls run in the background worker (see providers.js);
// this content-script side batches posts and blends AI with keyword scores.

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

  // Callbacks for provider notifications (set by content scripts).
  // onRateLimit(name, waitSeconds, usingName) / onApiError(name, reason, usingName)
  // usingName is the provider now scoring, or null when keywords take over.
  onRateLimit: null,
  onApiError: null,

  // Provider configuration summary (no keys kept here)
  provider: {
    primary: 'groq',
    primaryName: 'Groq',
    primaryModel: 'openai/gpt-oss-20b',
    fallback: null,
    fallbackName: null,
    configured: false
  },

  // When every configured provider failed, stay on keywords until this time.
  aiPausedUntil: 0,

  // Batch processing
  batchQueue: [],
  batchProcessing: false,
  batchSize: 10, // Smaller batches for faster response
  batchDelay: 150, // Very short delay - fire fast!
  batchTimeout: null,

  // Score cache
  scoreCache: new Map(),

  // Custom prompt (read by the background worker from storage)
  customPrompt: null,

  // Debug logging
  debug(...args) {
    if (this.settings.debugMode) {
      console.log('🌴 [XFP Debug]', ...args);
    }
  },

  // True when at least one provider is configured and not paused.
  hasAI() {
    return this.provider.configured && Date.now() >= this.aiPausedUntil;
  },

  // Default batch prompt (shared with the background worker)
  getBatchPrompt(tweets) {
    return XFPProviders.buildBatchPrompt(tweets, this.customPrompt);
  },

  // Queue a tweet for batch AI scoring
  queueForAIScoring(tweetId, text, callback) {
    if (!this.settings.useAI) return;

    if (!this.hasAI()) {
      this.debug('No AI provider available, skipping AI queue');
      return;
    }

    // Skip if already cached with AI score
    const cached = this.scoreCache.get(tweetId);
    if (cached && cached.source === 'ai') return;

    this.batchQueue.push({ tweetId, text, callback });
    this.debug(`Queued tweet ${tweetId}. Queue: ${this.batchQueue.length}, provider: ${this.provider.primaryName}`);

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

  // Ask the background worker to score a batch (primary, then fallback).
  async requestScores(texts) {
    try {
      return await chrome.runtime.sendMessage({ type: 'XFP_SCORE_BATCH', texts });
    } catch (error) {
      // Extension reloaded or worker unavailable
      return { scores: null, attempts: [], retryAfterMs: 30000 };
    }
  },

  // Surface fresh provider failures to the page (toasts).
  reportAttempts(result) {
    const usingName = result && result.scores ? result.providerName : null;
    for (const a of (result && result.attempts) || []) {
      if (!a.fresh || a.state === 'working') continue;
      if (a.state === 'rate_limited') {
        if (this.onRateLimit) this.onRateLimit(a.name, a.waitSeconds || 60, usingName);
      } else if (this.onApiError) {
        const reason = a.state === 'auth_error' ? (a.httpStatus || 401)
          : a.state === 'api_error' ? (a.httpStatus || 'api_error')
          : a.state;
        this.onApiError(a.name, reason, usingName);
      }
    }
  },

  // Process the batch queue
  async processBatchQueue() {
    if (this.batchProcessing || this.batchQueue.length === 0) return;
    this.batchProcessing = true;

    while (this.batchQueue.length > 0) {
      const batch = this.batchQueue.splice(0, this.batchSize);

      if (!this.hasAI()) {
        this.scoreWithKeywords(batch);
        continue;
      }

      this.debug(`Scoring ${batch.length} tweets via background...`);
      const result = await this.requestScores(batch.map(b => b.text));
      this.reportAttempts(result);

      if (result && Array.isArray(result.scores) && result.scores.length === batch.length) {
        batch.forEach((item, i) => {
          const aiScore = result.scores[i];
          if (aiScore === null || aiScore === undefined) return;
          const keywordScore = this.calculateKeywordScore(item.text);
          const finalScore = Math.round(aiScore * 0.85 + keywordScore * 0.15);
          const clampedScore = Math.max(-100, Math.min(100, finalScore));

          this.scoreCache.set(item.tweetId, {
            score: clampedScore,
            source: 'ai',
            api: result.provider,
            timestamp: Date.now()
          });

          this.debug(`Tweet ${item.tweetId}: AI=${aiScore}, Final=${clampedScore} (${result.providerName})`);
          if (item.callback) item.callback(clampedScore, 'ai');
        });
      } else {
        // Every configured provider failed: keywords for this batch, then pause.
        this.aiPausedUntil = Date.now() + Math.min((result && result.retryAfterMs) || 30000, 5 * 60 * 1000);
        console.warn('🌴 XFP: No AI provider available right now. Using keyword scoring.');
        this.scoreWithKeywords(batch);
      }
    }

    this.batchProcessing = false;
  },

  scoreWithKeywords(batch) {
    for (const { tweetId, text, callback } of batch) {
      const keywordScore = this.calculateKeywordScore(text);
      this.scoreCache.set(tweetId, { score: keywordScore, source: 'keyword', timestamp: Date.now() });
      if (callback) callback(keywordScore, 'keyword');
    }
  },

  // Parse scores from a model response (kept for compatibility; see providers.js)
  parseScoresFromResponse(content, expectedCount) {
    return XFPProviders.parseScores(content, expectedCount);
  },

  // Load provider configuration (primary, fallback, readiness) from storage
  async loadProviderConfig() {
    const config = await XFPProviders.loadConfig();
    const primary = config.providers[config.primary];
    this.customPrompt = config.customPrompt;
    this.provider = {
      primary: config.primary,
      primaryName: XFPProviders.displayName(config.primary),
      primaryModel: primary.model,
      primaryConfigured: XFPProviders.isConfigured(primary),
      fallback: config.fallback,
      fallbackName: config.fallback ? XFPProviders.displayName(config.fallback) : null,
      configured: XFPProviders.chain(config).length > 0
    };
    this.aiPausedUntil = 0;
    return this.provider;
  },

  // Backward-compatible name used by older content-script code
  async loadGroqApiKey() {
    return this.loadProviderConfig();
  },

  // Reload provider config whenever the popup (or another tab) changes it.
  watchProviderConfig(onChange) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      if (!Object.keys(changes).some(key => XFPProviders.SYNC_KEYS.includes(key))) return;
      this.loadProviderConfig().then(() => { if (onChange) onChange(this.provider); });
    });
  },

  // Save the key for the active (primary) provider
  async saveActiveProviderKey(key) {
    await XFPProviders.saveProvider(this.provider.primary, { apiKey: key || '' });
    return this.loadProviderConfig();
  },

  // Save custom prompt
  async saveCustomPrompt(prompt) {
    this.customPrompt = prompt;
    return new Promise((resolve) => {
      chrome.storage.sync.set({ customPrompt: prompt }, resolve);
    });
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

    if (this.settings.useAI && this.hasAI()) {
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

  // Provider summary for UI
  getApiStatus() {
    return {
      ...this.provider,
      paused: Date.now() < this.aiPausedUntil,
      activeApi: this.hasAI() ? this.provider.primary : null
    };
  }
};

window.VibeFilter = VibeFilter;
