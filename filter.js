// Vibe-based tweet filtering algorithm
// Scores tweets from -100 (pure outrage) to +100 (pure enlightenment)
// Uses AI (Transformers.js) when available, falls back to keyword matching

const VibeFilter = {
  // Default settings - user can customize
  settings: {
    enabled: true,
    threshold: 0, // Hide tweets below this score
    showScores: false, // Debug: show vibe scores on tweets
    filterMode: 'hide', // 'hide', 'dim', or 'label'
    useAI: true, // Use AI scoring when available
    customPositiveWords: [],
    customNegativeWords: [],
  },

  // AI scorer reference (set by content.js)
  aiScorer: null,

  // Words/phrases that indicate uplifting, enlightening content
  positivePatterns: [
    // Growth & Learning
    { pattern: /\b(learn(ed|ing)?|discover(ed|ing)?|insight|wisdom|understand(ing)?)\b/gi, weight: 8 },
    { pattern: /\b(curious|fascinated|interesting|remarkable)\b/gi, weight: 6 },
    { pattern: /\b(breakthrough|innovation|creative|inspired)\b/gi, weight: 8 },

    // Gratitude & Positivity
    { pattern: /\b(grateful|thankful|blessed|appreciate|gratitude)\b/gi, weight: 10 },
    { pattern: /\b(beautiful|wonderful|amazing|incredible)\b/gi, weight: 5 },
    { pattern: /\b(love|joy|happy|excited|thrilled)\b/gi, weight: 6 },
    { pattern: /\b(hope|optimistic|bright future|promising)\b/gi, weight: 7 },

    // Connection & Community
    { pattern: /\b(together|community|collaborate|support(ing)?|help(ing|ed)?)\b/gi, weight: 7 },
    { pattern: /\b(kind(ness)?|compassion|empathy|generous)\b/gi, weight: 9 },
    { pattern: /\b(friend(s)?|connection|relationship)\b/gi, weight: 4 },

    // Achievement & Progress
    { pattern: /\b(achieved|accomplished|success|progress|milestone)\b/gi, weight: 6 },
    { pattern: /\b(built|created|launched|shipped)\b/gi, weight: 5 },
    { pattern: /\b(proud|celebrate|congrats|congratulations)\b/gi, weight: 6 },

    // Mindfulness & Growth
    { pattern: /\b(mindful|peaceful|calm|serene|present)\b/gi, weight: 8 },
    { pattern: /\b(growth|evolving|transform|journey)\b/gi, weight: 6 },
    { pattern: /\b(heal(ing)?|recover(y|ing)?|wellness)\b/gi, weight: 7 },

    // Intellectual Content
    { pattern: /\b(research|study|evidence|data shows)\b/gi, weight: 5 },
    { pattern: /\b(nuanced|complex|thoughtful|considered)\b/gi, weight: 7 },
    { pattern: /\bTIL\b|today I learned/gi, weight: 6 },
  ],

  // Words/phrases that indicate outrage-bait, negativity
  negativePatterns: [
    // Outrage & Anger
    { pattern: /\b(outrage|outraged|outrageous|infuriating)\b/gi, weight: -15 },
    { pattern: /\b(furious|angry|rage|hatred|hate)\b/gi, weight: -12 },
    { pattern: /\b(disgusting|disgusted|vile|despicable)\b/gi, weight: -12 },
    { pattern: /\b(unacceptable|unbelievable|shocking)\b/gi, weight: -8 },

    // Divisiveness
    { pattern: /\b(enemy|enemies|destroy|crush|defeat them)\b/gi, weight: -15 },
    { pattern: /\b(wake up|sheeple|they don't want you to)\b/gi, weight: -12 },
    { pattern: /\b(us vs them|pick a side|with us or against)\b/gi, weight: -10 },

    // Fear-mongering
    { pattern: /\b(terrifying|horrifying|nightmare|catastrophe)\b/gi, weight: -10 },
    { pattern: /\b(dangerous|threat|warned|warning)\b/gi, weight: -5 },
    { pattern: /\b(crisis|emergency|urgent|breaking)\b/gi, weight: -4 },

    // Contempt & Dismissiveness
    { pattern: /\b(stupid|idiot|moron|dumb|fool)\b/gi, weight: -15 },
    { pattern: /\b(clown|joke|pathetic|loser)\b/gi, weight: -12 },
    { pattern: /\b(trash|garbage|worthless)\b/gi, weight: -10 },

    // Manipulation Tactics
    { pattern: /\b(everyone knows|obviously|clearly you)\b/gi, weight: -6 },
    { pattern: /\b(exposed|busted|caught|lie|liar|lying)\b/gi, weight: -8 },
    { pattern: /ratio|L\s*\+|cope|seethe/gi, weight: -10 },

    // Conflict Starters
    { pattern: /\b(fight|battle|war|attack(ed|ing)?)\b/gi, weight: -6 },
    { pattern: /\b(slam(s|med)?|blast(s|ed)?|destroy(s|ed)?|wreck(s|ed)?)\b/gi, weight: -8 },
    { pattern: /\b(demolish|eviscerate|obliterate)\b/gi, weight: -10 },

    // Doom & Gloom
    { pattern: /\b(doomed|hopeless|end times|collapse)\b/gi, weight: -10 },
    { pattern: /\b(worst|terrible|horrible|awful)\b/gi, weight: -6 },
    { pattern: /\b(never|always|everyone|no one) (does|is|will)\b/gi, weight: -5 },
  ],

  // Structural patterns that indicate low-quality engagement bait
  structuralPatterns: [
    // ALL CAPS shouting
    { test: (text) => {
      const words = text.split(/\s+/).filter(w => w.length > 3);
      const capsWords = words.filter(w => w === w.toUpperCase() && /[A-Z]/.test(w));
      return capsWords.length > 3 ? -15 : capsWords.length > 1 ? -8 : 0;
    }},

    // Excessive punctuation
    { test: (text) => {
      const excessive = (text.match(/[!?]{2,}/g) || []).length;
      return excessive > 2 ? -12 : excessive > 0 ? -5 : 0;
    }},

    // Engagement bait questions
    { test: (text) => {
      if (/^(Am I the only one|Does anyone else|Why is no one talking about)/i.test(text)) return -8;
      if (/Thoughts\?$|Agree\?$|Right\?$/i.test(text)) return -5;
      return 0;
    }},

    // Thread/engagement bait
    { test: (text) => {
      if (/^(Thread|🧵|A thread|Here's why|1\/)/i.test(text)) return -3;
      if (/like and retweet|retweet if you|share this/i.test(text)) return -10;
      return 0;
    }},

    // Positive: questions that invite genuine discussion
    { test: (text) => {
      if (/what (do you think|are your thoughts|have you learned)/i.test(text)) return 5;
      if (/how (do you|did you|can we)/i.test(text)) return 4;
      return 0;
    }},
  ],

  // Calculate vibe score using keywords (fallback method)
  calculateKeywordScore(text) {
    let score = 0;

    // Apply positive patterns
    for (const { pattern, weight } of this.positivePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        score += weight * matches.length;
      }
    }

    // Apply negative patterns
    for (const { pattern, weight } of this.negativePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        score += weight * matches.length; // weight is already negative
      }
    }

    // Apply structural patterns
    for (const { test } of this.structuralPatterns) {
      score += test(text);
    }

    // Apply custom words
    const lowerText = text.toLowerCase();
    for (const word of this.settings.customPositiveWords) {
      if (lowerText.includes(word.toLowerCase())) score += 10;
    }
    for (const word of this.settings.customNegativeWords) {
      if (lowerText.includes(word.toLowerCase())) score -= 10;
    }

    // Normalize to -100 to 100 range
    return Math.max(-100, Math.min(100, score));
  },

  // Calculate vibe score for a tweet (async - uses AI when available)
  async calculateScore(tweet) {
    const text = tweet.text || '';

    // Try AI scoring first if enabled and available
    if (this.settings.useAI && this.aiScorer && this.aiScorer.isReady) {
      try {
        const aiScore = await this.aiScorer.scoreTweet(text);
        if (aiScore !== null) {
          // Combine AI score with keyword adjustments for better accuracy
          const keywordAdjustment = this.calculateKeywordScore(text) * 0.3;
          const combinedScore = Math.round(aiScore * 0.7 + keywordAdjustment);
          return Math.max(-100, Math.min(100, combinedScore));
        }
      } catch (error) {
        console.error('AI scoring failed, falling back to keywords:', error);
      }
    }

    // Fall back to keyword-based scoring
    return this.calculateKeywordScore(text);
  },

  // Synchronous version for backward compatibility
  calculateScoreSync(tweet) {
    return this.calculateKeywordScore(tweet.text || '');
  },

  // Determine if tweet should be shown
  shouldShow(score) {
    return score >= this.settings.threshold;
  },

  // Get human-readable vibe label
  getVibeLabel(score) {
    if (score >= 50) return { label: '✨ Enlightening', class: 'vibe-enlightening' };
    if (score >= 20) return { label: '🌱 Uplifting', class: 'vibe-uplifting' };
    if (score >= 0) return { label: '😐 Neutral', class: 'vibe-neutral' };
    if (score >= -20) return { label: '😕 Meh', class: 'vibe-meh' };
    if (score >= -50) return { label: '😤 Negative', class: 'vibe-negative' };
    return { label: '🔥 Outrage-bait', class: 'vibe-outrage' };
  },

  // Load settings from storage
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

  // Save settings to storage
  async saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    return new Promise((resolve) => {
      chrome.storage.sync.set({ vibeFilterSettings: this.settings }, resolve);
    });
  }
};

window.VibeFilter = VibeFilter;
