# Paradise Noos archive fork: deployment boundary

This branch combines released extension main with the existing phone reader and
adds a Noos archive. It has not been deployed. The original reader's Cloud SQL
provisioning plan does not apply, and `provision.sh` cannot mutate infrastructure.
Existing sign-in/rollout approval gates remain in force; a fork request or a local
test does not grant those previously gated infrastructure operations.

## Architecture

Extension capture (explicit opt-in) → authenticated Paradise Reader → dedicated
Noos `/api/paradise-store` → isolated private Noos graph storage. The phone PWA
reads that same owner-scoped reader API. The reader verifies Ideaflow ID tokens
against discovery/JWKS and uses code+S256 PKCE for web sign-in. Store assertions
bind the issuer/subject, operation and body for 60 seconds; no Noos credentials
or service signing secret go to the extension/phone.

Deploy the matching Noos `feat/paradise-archive` source (noos-v64v). Its
`docs/PARADISE_ARCHIVE.md` owns activation and isolation prerequisites. The
separate database driver is mandatory: private archive data must be unreachable
through legacy graph/query/search/export credentials. Merely using different
labels is insufficient. That is a deployment proof, not something synthetic
owner tests establish.

Reader environment:

| Variable | Purpose |
|---|---|
| `NOOS_PARADISE_URL` | Approved HTTPS Noos archive endpoint, ending `/api/paradise-store` |
| `NOOS_PARADISE_SECRET` | Shared only with that Noos service; at least 32 characters |
| `PUBLIC_ORIGIN` | Reader's HTTPS origin |
| `SESSION_SECRET` | Reader cookie signing secret; at least 32 characters |
| `OIDC_ISSUER` | `https://id.ideaflow.app/api/auth` |
| `OIDC_WEB_CLIENT_ID`, `OIDC_WEB_CLIENT_SECRET` | Approved confidential web client; callback `/auth/callback` |
| `OIDC_EXTENSION_CLIENT_IDS`, `EXTENSION_ORIGINS` | Approved PKCE client and actual extension ID(s) |

`DATABASE_URL` is not used by this fork's production entry point. `READER_STORE=memory`
is explicitly disposable test/demo storage. The extension checks the reader's
`archive` capability before uploading; it cannot silently upload this broader
capture stream to the older capped Postgres reader.

## Concrete reader proposal, awaiting activation approval

The helper's proposed service is **xfeed-noos-reader** in existing GCP project
`boreal-conquest-464203-v2`, `us-central1`, separate from `xfeed-reader`. It uses
256 MiB, one CPU, zero minimum and at most two instances. It adds no Cloud SQL
attachment. The shared archive secret `xfeed-noos-archive-secret` must already
exist from the approved Noos storage setup. The helper can create separate reader
session and OIDC secrets only after authorization.

Before running mutating commands:

1. Choose/verify the isolated Noos database deployment and prove legacy access
   cannot read it; size disk/retention for an archive without an automatic TTL.
2. Approve the Noos activation and new reader deployment. Preserve the existing
   curated Noos production line/release review and rollback procedure.
3. Register or explicitly authorize reuse of the correct Ideaflow ID clients.
   Select their admin owner; verify redirect URLs and token exchange. The inherited
   development key pins the original unpacked extension ID; a parallel-installed
   fork needs its own extension identity/client. Source branching does not change
   any existing browser installation or sign-in registration.
4. Set `WEB_CLIENT_FILE`, `EXT_CLIENT_FILE` explicitly for the approved clients;
   no original reader credential-file default is reused by this helper. Use the
   existing compute service account for GCP operations.
5. Only then use `deploy.sh secrets`, `deploy.sh deploy`, inspect the no-traffic
   revision, authorize public service invocation if needed, verify the exact
   artifact/identity/owner isolation, and promote deliberately. Never claim live
   success from a health endpoint alone.

Rollback: disable the new reader's traffic/capture and `NOOS_PARADISE_ENABLED`;
preserve archive data for recovery. Never drop the old reader database or alter
the original extension as an incidental rollback.

## Validation and acquisition

- Root `npm test`: providers, server, mobile resource generation and capture sync.
- `cd reader && npm ci && npm test`: real synthetic OIDC/JWKS/PKCE flows and
  archive/import behavior. No production credentials.
- `node reader/dev/check-archive-ui.mjs`: synthetic fixture-only phone/desktop
  check using installed Playwright/Chromium (`PARADISE_CHROMIUM` can select an
  existing executable; `PARADISE_UI_EVIDENCE` selects the task evidence folder).
- Noos: `node scripts/test-operational.mjs src/paradise/paradise.test.ts`, using
  the existing disposable synthetic database harness.

Capture covers rendered X post text and bounded context, not every raw API byte,
all historical feed items, or downloaded media. Raw and scored snapshots are
retained independently; reads show the latest 30 lightweight decision summaries.
The phone offers Filtered, All captured, and Saves. Private responses are network-only.
The local pending extension queue has explicit bounds and reports dropped captures.

For saves, reuse Bloomscroll's existing owner-checked acquisition workflow on the
actual source browser machine. Feed discoveries are not bookmark membership.
`node reader/import-saves.mjs /path/to/sanitized/x-saved.json https://APPROVED-READER/`
reads `PARADISE_ID_TOKEN` from the local process environment and prints only a
count/status receipt. It accepts the sanitized `source:x-saved, mode:snapshot,
rows:[...]` contract, validates the entire file before writing, imports in batches,
and preserves partial-source coverage. It performs no X writes or deletions and
is safe to retry by tweet/snapshot identity. Network failures can leave a partial
import; the receipt reports progress rather than claiming completion.

Fresh authenticated source acquisition, all-page bookmark backfill, background
refresh scheduling, actual Ideaflow login and real iPhone acceptance remain
separate verification steps. No timer, account linking, install or deployment is
performed by these tests.
