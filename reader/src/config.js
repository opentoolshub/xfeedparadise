// Environment configuration. See reader/DEPLOY.md for production values.
import { LIMITS } from './items.js';

const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const publicOrigin = String(env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
  if (!/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an origin like https://reader.example');
  const extensionOrigins = list(env.EXTENSION_ORIGINS);
  for (const origin of extensionOrigins) {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error(`EXTENSION_ORIGINS entry is not a Chrome extension origin: ${origin}`);
  }
  const isHttps = publicOrigin.startsWith('https://');
  return {
    port: Number(env.PORT) || 8080,
    publicOrigin,
    canonicalHost: isHttps ? new URL(publicOrigin).host : null,
    extensionOrigins,
    issuer: String(env.OIDC_ISSUER || 'https://id.ideaflow.app/api/auth').replace(/\/$/, ''),
    webClientId: env.OIDC_WEB_CLIENT_ID || '',
    webClientSecret: env.OIDC_WEB_CLIENT_SECRET || '',
    extensionClientIds: list(env.OIDC_EXTENSION_CLIENT_IDS),
    sessionSecret: env.SESSION_SECRET || '',
    sessionDays: Number(env.SESSION_DAYS) || 30,
    databaseUrl: env.DATABASE_URL || '',
    allowMemoryStore: env.READER_STORE === 'memory',
    perUser: Number(env.READER_MAX_ITEMS) || LIMITS.perUser,
    ttlDays: Number(env.READER_TTL_DAYS) || LIMITS.ttlDays
  };
}
