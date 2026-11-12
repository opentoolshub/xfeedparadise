// Entry point: node src/index.js
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { createAuth } from './oidc.js';
import { createMemoryStore } from './store-memory.js';
import { createNoosStore } from './store-noos.js';

const config = loadConfig();
let store;
if (config.noosUrl) {
  store = createNoosStore({ baseUrl: config.noosUrl, secret: config.noosSecret, issuer: config.issuer });
} else if (config.allowMemoryStore) {
  store = createMemoryStore({ archive: true });
} else {
  throw new Error('NOOS_PARADISE_URL and NOOS_PARADISE_SECRET are required (READER_STORE=memory is disposable only)');
}
await store.init();

const auth = createAuth(config);
const server = createApp({ config, store, auth });

const sweep = async () => {
  try {
    const n = await store.sweep();
    if (n) console.log(`sweep removed ${n} expired items`);
  } catch (error) {
    console.log(`sweep failed: ${error.message}`);
  }
};
sweep();
const timer = setInterval(sweep, 60 * 60_000);
timer.unref();

server.listen(config.port, () => {
  console.log(`xfeed-reader listening on :${config.port} (${store.kind} store, origin ${config.publicOrigin})`);
});

const shutdown = () => {
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
