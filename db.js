// IndexedDB wrapper for storing tweets
const DB_NAME = 'XFeedParadiseDB';
const DB_VERSION = 2; // Bumped for source index
const TWEETS_STORE = 'tweets';
const USERS_STORE = 'users';

// Supabase backend configuration
const SUPABASE_URL = 'https://xvexqhejjdcysxgxanlm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_aH6fgWyLdZO6mKILaErqsQ_5mJZN2du';

// Fetch with timeout to prevent hanging when backend is down
function fetchWithTimeout(url, options, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

class TweetDatabase {
  constructor() {
    this.db = null;
    this.ready = this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Store for tweets
        if (!db.objectStoreNames.contains(TWEETS_STORE)) {
          const tweetStore = db.createObjectStore(TWEETS_STORE, { keyPath: 'id' });
          tweetStore.createIndex('authorId', 'authorId', { unique: false });
          tweetStore.createIndex('timestamp', 'timestamp', { unique: false });
          tweetStore.createIndex('collectedAt', 'collectedAt', { unique: false });
          tweetStore.createIndex('feedOwner', 'feedOwner', { unique: false });
          tweetStore.createIndex('vibeScore', 'vibeScore', { unique: false });
          tweetStore.createIndex('source', 'source', { unique: false }); // For Google News support
        } else if (oldVersion < 2) {
          // Upgrade from v1: add source index
          const transaction = event.target.transaction;
          const tweetStore = transaction.objectStore(TWEETS_STORE);
          if (!tweetStore.indexNames.contains('source')) {
            tweetStore.createIndex('source', 'source', { unique: false });
          }
        }

        // Store for user profiles
        if (!db.objectStoreNames.contains(USERS_STORE)) {
          const userStore = db.createObjectStore(USERS_STORE, { keyPath: 'id' });
          userStore.createIndex('username', 'username', { unique: false });
        }
      };
    });
  }

  async saveTweet(tweet) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE], 'readwrite');
      const store = transaction.objectStore(TWEETS_STORE);

      tweet.collectedAt = tweet.collectedAt || Date.now();
      const request = store.put(tweet);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveTweets(tweets) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE], 'readwrite');
      const store = transaction.objectStore(TWEETS_STORE);

      tweets.forEach(tweet => {
        tweet.collectedAt = tweet.collectedAt || Date.now();
        store.put(tweet);
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getTweet(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE], 'readonly');
      const store = transaction.objectStore(TWEETS_STORE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllTweets(limit = 1000) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE], 'readonly');
      const store = transaction.objectStore(TWEETS_STORE);
      const index = store.index('collectedAt');
      const request = index.openCursor(null, 'prev');

      const tweets = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && tweets.length < limit) {
          tweets.push(cursor.value);
          cursor.continue();
        } else {
          resolve(tweets);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getTweetsByVibeScore(minScore, limit = 100) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE], 'readonly');
      const store = transaction.objectStore(TWEETS_STORE);
      const index = store.index('vibeScore');
      const range = IDBKeyRange.lowerBound(minScore);
      const request = index.openCursor(range, 'prev');

      const tweets = [];
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && tweets.length < limit) {
          tweets.push(cursor.value);
          cursor.continue();
        } else {
          resolve(tweets);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveUser(user) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([USERS_STORE], 'readwrite');
      const store = transaction.objectStore(USERS_STORE);
      const request = store.put(user);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getStats() {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE, USERS_STORE], 'readonly');
      const tweetStore = transaction.objectStore(TWEETS_STORE);
      const userStore = transaction.objectStore(USERS_STORE);

      const tweetCountReq = tweetStore.count();
      const userCountReq = userStore.count();

      const stats = {};

      tweetCountReq.onsuccess = () => { stats.tweetCount = tweetCountReq.result; };
      userCountReq.onsuccess = () => { stats.userCount = userCountReq.result; };

      transaction.oncomplete = () => resolve(stats);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async clearAll() {
    await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([TWEETS_STORE, USERS_STORE], 'readwrite');
      transaction.objectStore(TWEETS_STORE).clear();
      transaction.objectStore(USERS_STORE).clear();

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // =====================
  // Backend Sync Methods
  // =====================

  // Get or create anonymous user ID for this extension install
  async getAnonymousId() {
    return new Promise((resolve) => {
      chrome.storage.local.get('xfp_anonymous_id', (result) => {
        if (result.xfp_anonymous_id) {
          resolve(result.xfp_anonymous_id);
        } else {
          // Generate a random ID
          const id = 'xfp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
          chrome.storage.local.set({ xfp_anonymous_id: id });
          resolve(id);
        }
      });
    });
  }

  // Check if sync is enabled
  async isSyncEnabled() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('xfp_sync_enabled', (result) => {
        // Default to ON
        resolve(result.xfp_sync_enabled !== false);
      });
    });
  }

  // Upsert user and get user ID from backend
  async getOrCreateBackendUserId() {
    const anonymousId = await this.getAnonymousId();

    try {
      const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/upsert_user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
        },
        body: JSON.stringify({ p_anonymous_id: anonymousId })
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
      }

      const userId = await response.json();
      return userId;
    } catch (error) {
      console.error('[XFP] Failed to get backend user ID:', error);
      return null;
    }
  }

  // Sync items to backend
  async syncToBackend(items) {
    const syncEnabled = await this.isSyncEnabled();
    if (!syncEnabled) {
      console.log('[XFP] Sync disabled, skipping backend upload');
      return false;
    }

    if (!items || items.length === 0) {
      return true;
    }

    const userId = await this.getOrCreateBackendUserId();
    if (!userId) {
      console.error('[XFP] Cannot sync: no backend user ID');
      return false;
    }

    try {
      // Transform items to backend format
      const backendItems = items.map(item => ({
        external_id: item.id,
        source: item.source || 'twitter',
        user_id: userId,
        text: item.text,
        headline: item.headline || null,
        snippet: item.snippet || null,
        url: item.url || null,
        author_id: item.authorId || null,
        author_name: item.authorName || null,
        author_handle: item.authorHandle || null,
        vibe_score: item.vibeScore || null,
        scored_with_ai: item.scoredWithAI || false,
        was_hidden: item.wasHidden || false,
        likes: item.likes || null,
        retweets: item.retweets || null,
        replies: item.replies || null,
        original_timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null
      }));

      const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(backendItems)
      });

      if (!response.ok) {
        throw new Error(`Backend sync error: ${response.status}`);
      }

      console.log(`[XFP] Synced ${items.length} items to backend`);
      return true;
    } catch (error) {
      console.error('[XFP] Backend sync failed:', error);
      return false;
    }
  }

  // Queue items for batch sync (called after scoring)
  syncQueue = [];
  syncTimeout = null;

  queueForSync(item) {
    this.syncQueue.push(item);

    // Debounce sync - wait 5 seconds for more items
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(() => {
      this.flushSyncQueue();
    }, 5000);
  }

  async flushSyncQueue() {
    if (this.syncQueue.length === 0) return;

    const items = [...this.syncQueue];
    this.syncQueue = [];

    await this.syncToBackend(items);
  }
}

// Global instance
window.tweetDB = new TweetDatabase();
