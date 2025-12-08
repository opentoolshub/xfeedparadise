// IndexedDB wrapper for storing tweets
const DB_NAME = 'XFeedParadiseDB';
const DB_VERSION = 2; // Bumped for source index
const TWEETS_STORE = 'tweets';
const USERS_STORE = 'users';

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
}

// Global instance
window.tweetDB = new TweetDatabase();
