# Paradise Reader: deploy runbook

Paradise Reader is the optional phone view of XFeed Paradise. The desktop
extension saves the X posts it scored to the user's own private store, but
only after the user opts in and signs in with Ideaflow. This service holds
those posts and serves an installable web app for browsing them.

Nothing in this directory has been deployed. Every step under
"Approval step" changes shared infrastructure and needs Jacob's go-ahead.

## Shape

| Piece | Value |
| --- | --- |
| Service | Cloud Run `xfeed-reader`, project `boreal-conquest-464203-v2`, `us-central1` |
| Public URL | `https://xfeed-reader-874749606899.us-central1.run.app` (other hostnames redirect here) |
| Database | `xfeed_reader` on Cloud SQL `collablists-pg` (Postgres 18), role `xfeed_reader`, one table `reader_items` |
| Sign-in | Ideaflow ID, issuer `https://id.ideaflow.app/api/auth`, ID tokens signed EdDSA, verified against the issuer JWKS |
| Reader client | confidential web client (code + S256 PKCE, `client_secret_basic`), callback `/auth/callback` |
| Extension client | public client (code + S256 PKCE, refresh tokens), redirect `https://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/` |
| Secrets | `xfeed-reader-database-url`, `xfeed-reader-session-secret`, `xfeed-reader-oidc-client-secret` |

The unpacked extension ID `dljipjmfogkcfmbainbepkmblodkndph` is pinned by
`key` in `manifest.json`. Its private key is
`~/.config/xfeed/extension-signing-key.pem` (mode 600) on the M4 and never
goes in the repo. `build.sh` strips `key` from the Chrome Web Store ZIP,
because the store assigns its own ID (see "Chrome Web Store ID" below).

### API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/ok` | none | health |
| `GET /api/config` | none | issuer, extension client ID, reader URL (the extension reads this) |
| `POST /v1/items` | bearer ID token or session cookie | batch upsert by post id, at most 50 per request |
| `GET /v1/items?minScore=&kept=&cursor=&limit=` | same | newest first, cursor pagination |
| `DELETE /v1/items` | same | delete everything for the caller |
| `GET /v1/me` | same | count and last sync time |
| `GET /auth/login`, `/auth/callback`, `POST /auth/logout` | | reader sign-in |

Limits: the newest 2,000 posts per user (by sync time), 30-day TTL (expired
rows are hidden at once and deleted on the next write and by an hourly
sweep). CORS allows only the reader origin and the extension origin(s).
Cookie-authenticated writes must come from the reader's own origin. The
server never logs request bodies or post text.

### Why Postgres and not Noos

Noos was checked read-only (IdeaFlowCo/noos `main`, `src/routes`). It stores
knowledge-graph `Node`s with `public`/`unlisted`/`private` visibility. It has
no per-account private app-data store with batch upsert, caps or TTL. Putting
thousands of third-party X posts per user into the shared Neo4j graph would
be the wrong content for it and costly for its memory (it has hit OOM
before). So feed items use a dedicated Postgres database, while identity
stays on Ideaflow ID. If Noos later gains a private app-data API, the store
interface (`src/store-pg.js`, `src/store-memory.js`) is small enough to port.

## Local development and tests

```sh
cd reader && npm ci
npm test                                    # in-memory store
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:PORT/xfeed_reader_test npm test   # also Postgres
```

Local end to end: run `dev/local-issuer.js` (a test OIDC issuer that signs
EdDSA tokens, checks PKCE and auto-approves one test user), then
`src/index.js` with `PUBLIC_ORIGIN=http://127.0.0.1:PORT`,
`READER_STORE=memory` or a local `DATABASE_URL`, and the issuer's client IDs.
The extension points at a local reader when `chrome.storage.local.xfpReaderOrigin`
is set. The local issuer is for development only.

## Approval step

Run these in order from the M4, in `/Volumes/External_SSD/agent-worktrees/xfeed-mobile-reader`
(or the merged checkout). The compute service account
`874749606899-compute@developer.gserviceaccount.com` covers everything except
step 6, which needs an owner (`jacob@ideaflow.io`; run
`gcloud auth login jacob@ideaflow.io --no-launch-browser` first if expired).

### 1. Database (`collablists-pg`)

```sh
reader/provision.sh            # prints the plan
reader/provision.sh --apply    # creates role + DB, revokes PUBLIC, stores xfeed-reader-database-url
```

It refuses to run if the database, role or secret already exists. The
password is generated locally and never printed.

### 2. Register the reader web client in Ideaflow ID

Use ideaflow-auth's own registrar from a checkout of current `main`
(`/Volumes/External_SSD/agent-worktrees/xfeed-reader-tools/ideaflow-auth` is
a read-only clone; `git pull --ff-only && npm ci` there first). The registrar
needs the production provider's env. Inject it without printing it:

```sh
cd /Volumes/External_SSD/agent-worktrees/xfeed-reader-tools/ideaflow-auth
SA=874749606899-compute@developer.gserviceaccount.com
cloud-sql-proxy --port 5544 --gcloud-auth boreal-conquest-464203-v2:us-central1:collablists-pg &
PROXY=$!
export NODE_ENV=production BETTER_AUTH_URL=https://id.ideaflow.app
export BETTER_AUTH_SECRET="$(gcloud secrets versions access latest --secret=ideaflow-auth-secret --account=$SA --project=boreal-conquest-464203-v2)"
# Same database credentials, pointed at the local proxy instead of the /cloudsql socket.
export DATABASE_URL="$(gcloud secrets versions access latest --secret=ideaflow-auth-database-url --account=$SA --project=boreal-conquest-464203-v2 \
  | python3 -c 'import sys,urllib.parse as u; s=u.urlsplit(sys.stdin.read().strip()); print(s.scheme + "://" + s.netloc.rsplit("@", 1)[0] + "@127.0.0.1:5544" + s.path)')"

FIRST_PARTY_OAUTH_OWNER_EMAIL=<ideaflow-id admin email> \
FIRST_PARTY_OAUTH_APPLICATION=xfeed-reader \
FIRST_PARTY_OAUTH_CLIENT_NAME="XFeed Paradise Reader" \
FIRST_PARTY_OAUTH_CLIENT_URI=https://xfeed-reader-874749606899.us-central1.run.app \
FIRST_PARTY_OAUTH_REDIRECT_URIS=https://xfeed-reader-874749606899.us-central1.run.app/auth/callback \
FIRST_PARTY_OAUTH_ENVIRONMENT=production \
FIRST_PARTY_OAUTH_OUTPUT_PATH=$HOME/.config/xfeed/ideaflow-oidc-web-client.json \
npm run register:first-party-client
```

That creates a confidential web client: `client_secret_basic`,
`authorization_code` only, S256 PKCE required, scope `openid profile email`,
consent skipped (login purpose), no refresh tokens, end-session off. The
mode-600 credentials file holds the secret; only the client ID is printed.

### 3. Register the extension (public client)

In the same shell (same proxy and env):

```sh
XFEED_EXT_OWNER_EMAIL=<ideaflow-id admin email> \
XFEED_EXT_REDIRECT_URIS=https://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/ \
XFEED_EXT_OUTPUT_PATH=$HOME/.config/xfeed/ideaflow-oidc-extension-client.json \
node /Volumes/External_SSD/agent-worktrees/xfeed-mobile-reader/reader/oidc/register-extension-client.mjs
# Review the printed body, then create it:
XFEED_EXT_CONFIRM=register XFEED_EXT_OWNER_EMAIL=... XFEED_EXT_REDIRECT_URIS=... XFEED_EXT_OUTPUT_PATH=... \
node /Volumes/External_SSD/agent-worktrees/xfeed-mobile-reader/reader/oidc/register-extension-client.mjs
kill $PROXY; unset BETTER_AUTH_SECRET DATABASE_URL
```

Body: `type: user-agent-based`, `token_endpoint_auth_method: none`,
grants `authorization_code` + `refresh_token`, scope
`openid profile email offline_access`, `require_pkce: true`,
`skip_consent: true`, metadata `{application: xfeed-paradise, platform: chrome-extension}`.
If the Chrome Web Store ID is already known, list both redirect URIs
(comma-separated).

Neither registration changes the provider's code, config or audiences, so
ideaflow-auth is not redeployed. Both clients use only ID tokens (no
`resource` parameter), which keeps the single-audience workaround intact.

### 4. Secrets

```sh
reader/deploy.sh secrets   # xfeed-reader-session-secret (random), xfeed-reader-oidc-client-secret (from step 2's file)
```

### 5. Deploy

```sh
reader/deploy.sh deploy
```

This builds `us-central1-docker.pkg.dev/boreal-conquest-464203-v2/cloud-run-source-deploy/xfeed-reader:r<sha>`
with Cloud Build and deploys with the Cloud SQL connection, three secrets,
public client IDs as env, 256 MiB, max 2 instances. A new service starts
private (`--no-allow-unauthenticated`). Later deploys go out with
`--no-traffic --tag r<sha>`; check the tag URL, then `reader/deploy.sh promote xfeed-reader-r<sha>`.

### 6. Make it reachable (owner account)

```sh
OWNER_ACCOUNT=jacob@ideaflow.io reader/deploy.sh public
```

### 7. Verify

```sh
reader/deploy.sh verify
ssh m5 "curl -s -o /dev/null -w '%{http_code}' https://xfeed-reader-874749606899.us-central1.run.app/api/ok"   # 200
```

Then on the phone: open the URL, "Sign in with Ideaflow", and add it to the
home screen. On desktop: load the unpacked extension (ID must read
`dljipjmfogkcfmbainbepkmblodkndph`), open the popup, Paradise Reader (phone),
turn it on, read and accept the disclosure, sign in, scroll X, and check
that "Synced N posts" appears and the posts show on the phone. Finish with
"Delete everything" and confirm the reader is empty.

## Rollback

Undo in reverse order. Each step stands alone.

| Step | Undo |
| --- | --- |
| 6 public | `gcloud run services remove-iam-policy-binding xfeed-reader --region=us-central1 --member=allUsers --role=roles/run.invoker --project=boreal-conquest-464203-v2 --account=jacob@ideaflow.io` |
| 5 deploy | bad revision: `reader/deploy.sh promote <previous revision>`; remove entirely: `gcloud run services delete xfeed-reader --region=us-central1 --project=boreal-conquest-464203-v2` |
| 4 secrets | `gcloud secrets delete xfeed-reader-session-secret` and `xfeed-reader-oidc-client-secret` (same project) |
| 2, 3 clients | Disable rather than delete, so tokens and codes are left consistent: through the step-2 proxy, `update "oauthClient" set disabled = true where "clientId" in ('<web id>', '<extension id>');`. The provider then refuses authorize, token and introspection for them. |
| 1 database | `reader/provision.sh --rollback` (drops the `xfeed_reader` database, role and `xfeed-reader-database-url`; all saved posts are destroyed) |

Users can also remove their own data at any time with "Delete everything"
(extension popup or reader), and by turning the feature off to stop uploads.

## Chrome Web Store ID

The store assigns its own extension ID, so a store build signs in through
`https://<store-id>.chromiumapp.org/`. Once the ID is known:

1. Add the redirect to the extension client with the provider's admin API
   (`auth.api.adminUpdateOAuthClient({ body: { client_id, update: { redirect_uris: [unpacked, store] } } })`
   in the step-2 shell), or pass both URIs at registration time.
2. Add `chrome-extension://<store-id>` to `EXTENSION_ORIGINS` (comma-separated)
   and redeploy with `EXTENSION_ORIGINS=... reader/deploy.sh deploy`.
3. Update the store listing's privacy disclosures for the opt-in reader
   upload (PRIVACY.md describes it).
