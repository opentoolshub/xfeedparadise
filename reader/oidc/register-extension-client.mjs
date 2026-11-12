// One-shot registration of the XFeed Paradise Chrome extension as a PUBLIC
// Ideaflow ID client (Authorization Code + S256 PKCE, no client secret,
// refresh tokens for background sync). APPROVAL STEP: see reader/DEPLOY.md.
//
// Runs from an ideaflow-auth checkout at current main (it reuses that repo's
// auth instance and admin-session helpers), with DATABASE_URL,
// BETTER_AUTH_SECRET and BETTER_AUTH_URL injected for the production
// provider. Dry run by default: it verifies the admin owner and that no
// duplicate exists, then prints the request body. Set
// XFEED_EXT_CONFIRM=register to create the client.
//
//   cd <ideaflow-auth checkout>
//   XFEED_EXT_OWNER_EMAIL=<admin email> \
//   XFEED_EXT_REDIRECT_URIS=https://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/ \
//   node /path/to/reader/oidc/register-extension-client.mjs
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLIENT_NAME = 'XFeed Paradise (Chrome extension)';
export const CLIENT_URI = 'https://xfeed-reader-874749606899.us-central1.run.app';
const REDIRECT_RE = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/;

export function buildClientBody(redirectUris) {
  if (!redirectUris.length) throw new Error('XFEED_EXT_REDIRECT_URIS is required');
  for (const uri of redirectUris) {
    if (!REDIRECT_RE.test(uri)) throw new Error(`Not a Chrome extension redirect URI: ${uri}`);
  }
  return {
    client_name: CLIENT_NAME,
    client_uri: CLIENT_URI,
    redirect_uris: redirectUris,
    scope: 'openid profile email offline_access',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    type: 'user-agent-based',
    require_pkce: true,
    skip_consent: true,
    enable_end_session: false,
    metadata: { application: 'xfeed-paradise', platform: 'chrome-extension', environment: 'production' }
  };
}

async function main(env = process.env) {
  const ownerEmail = (env.XFEED_EXT_OWNER_EMAIL || '').trim();
  const redirectUris = String(env.XFEED_EXT_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  const outputPath = env.XFEED_EXT_OUTPUT_PATH || '';
  const confirmed = env.XFEED_EXT_CONFIRM === 'register';
  if (!ownerEmail) throw new Error('XFEED_EXT_OWNER_EMAIL is required');
  const body = buildClientBody(redirectUris);

  const src = p => import(pathToFileURL(join(process.cwd(), 'src', p)).href);
  const { auth, database } = await src('auth.js');
  const { createAdminSessionHeaders, destroyAdminSession, findAdminOwner } = await src('oauth-client-registration.js');

  let session;
  try {
    const owner = await findAdminOwner(database, ownerEmail);
    const { rows } = await database.query('select "clientId" from "oauthClient" where name = $1 limit 1', [CLIENT_NAME]);
    if (rows[0]) {
      throw new Error(`${CLIENT_NAME} is already registered as ${rows[0].clientId}; update its redirect URIs instead of creating a duplicate`);
    }
    if (!confirmed) {
      console.log(JSON.stringify({ dryRun: true, owner: owner.email, body }, null, 2));
      return;
    }
    const created = await createAdminSessionHeaders(auth, owner.id);
    session = created.session;
    const client = await auth.api.adminCreateOAuthClient({ headers: created.headers, body });
    if (outputPath) {
      const destination = resolve(outputPath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, `${JSON.stringify({
        issuer: `${String(env.BETTER_AUTH_URL).replace(/\/$/, '')}/api/auth`,
        client_id: client.client_id,
        redirect_uris: redirectUris
      }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(destination, 0o600);
    }
    // Public client: there is no secret; the ID is safe to print.
    console.log(JSON.stringify({ created: true, clientId: client.client_id }));
  } finally {
    await destroyAdminSession(auth, session);
    await database.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
