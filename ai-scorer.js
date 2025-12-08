// AI-powered vibe scoring using Transformers.js
// Runs sentiment analysis locally in the browser

const AIScorer = {
  pipeline: null,
  isLoading: false,
  isReady: false,
  loadError: null,

  // Custom prompt for vibe classification
  vibeLabels: [
    'uplifting and inspiring',
    'informative and educational',
    'neutral or mundane',
    'negative or complaining',
    'outrage-bait or inflammatory'
  ],

  // Initialize the AI model
  async init() {
    if (this.isReady || this.isLoading) return;

    this.isLoading = true;
    console.log('🌴 AI Scorer: Loading model...');

    try {
      // Dynamic import of transformers.js
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1');

      // Use sentiment analysis pipeline (small, fast model)
      this.pipeline = await pipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english');

      this.isReady = true;
      this.isLoading = false;
      console.log('🌴 AI Scorer: Model loaded successfully!');
    } catch (error) {
      this.loadError = error;
      this.isLoading = false;
      console.error('🌴 AI Scorer: Failed to load model:', error);
    }
  },

  // Score a tweet using AI
  async scoreTweet(text) {
    if (!this.isReady) {
      // Fall back to keyword scoring if AI not ready
      return null;
    }

    try {
      const result = await this.pipeline(text);

      if (result && result[0]) {
        const { label, score } = result[0];

        // Convert sentiment to vibe score
        // POSITIVE -> positive score, NEGATIVE -> negative score
        // Score ranges from 0.5 to 1.0, we map to -100 to +100
        if (label === 'POSITIVE') {
          return Math.round((score - 0.5) * 200); // 0.5 -> 0, 1.0 -> 100
        } else {
          return Math.round((0.5 - score) * 200); // 0.5 -> 0, 1.0 -> -100
        }
      }
    } catch (error) {
      console.error('🌴 AI Scorer: Error scoring tweet:', error);
    }

    return null;
  },

  // Batch score multiple tweets
  async scoreTweets(tweets) {
    if (!this.isReady) return tweets.map(() => null);

    const texts = tweets.map(t => t.text || '');
    const scores = [];

    for (const text of texts) {
      const score = await this.scoreTweet(text);
      scores.push(score);
    }

    return scores;
  },

  // Check if a tweet is uplifting (for quick filtering)
  async isUplifting(text) {
    const score = await this.scoreTweet(text);
    return score !== null ? score > 0 : null;
  },

  // Get loading status
  getStatus() {
    if (this.isReady) return 'ready';
    if (this.isLoading) return 'loading';
    if (this.loadError) return 'error';
    return 'idle';
  }
};

// Export for use in content script
window.AIScorer = AIScorer;
