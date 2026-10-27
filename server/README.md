# xfeed-score — built-in scoring service

Small Node service behind the extension's **Built-in (free, daily limit)** provider.
It scores post text with a hosted model so people can use AI scoring without
their own API key, up to a daily cap. No npm dependencies; Node 20+.

## API

| Route | Purpose |
|---|---|
| `POST /v1/score` | Body `{"installId": "<uuid>", "texts": ["…", …]}` (1–10 strings, each truncated to 400 characters). Returns `{"scores": [-100..100 or null, …], "remaining": N}` or `{"error": "daily_limit" \| "global_budget" \| "rate_limited" \| "bad_request" \| "backend_error"}`. When fewer posts remain than were sent, the extra entries are `null`. |
| `GET /v1/status?installId=` | `{"remaining", "limit", "state": "ok" \| "daily_limit" \| "global_budget", "resetsAt"}` |
| `GET /api/ok` | Health check (Cloud Run reserves `/healthz`). |

CORS: only `chrome-extension://` and `safari-web-extension://` origins are
allowed; any other `Origin` gets 403. Requests with no `Origin` (curl, health
checks) are served. Request bodies are capped at 16 KB.

## Backends

Tried in the order given by `XFEED_BACKENDS` (default `jev,decisions,nano`);
backends without a key are skipped, and a failure moves on to the next one.

| id | API | Key env var |
|---|---|---|
| `jev` | TypeSafe System One (`jev-latest`), one call per post, ≤5 concurrent | `TYPESAFE_API_KEY` |
| `decisions` | OpenAI Decisions (`gpt-6-luna`), one call per batch: the posts are numbered in one input with one named `score` question each | `OPENAI_API_KEY` |
| `nano` | OpenAI chat completions (`gpt-5.4-nano`) with the extension's batch prompt | `OPENAI_API_KEY` |

`jev` and `decisions` use the same 7-level rubric (outrage-bait → divisive →
negative → neutral → pleasant → constructive → uplifting); the expected level
`0..6` maps linearly to `-100..100`.

## Caps (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `XFEED_INSTALL_DAILY_POSTS` | 1000 | posts per install per UTC day |
| `XFEED_IP_DAILY_POSTS` | 3000 | posts per client IP per UTC day |
| `XFEED_GLOBAL_DAILY_USD` | 3 | estimated spend per UTC day, from returned token usage × price table |
| `XFEED_INSTALL_REQUESTS_PER_MINUTE` | 60 | requests per install per minute |
| `XFEED_PRICES` | built in | JSON override of USD-per-million-token prices, e.g. `{"nano":{"input":0.2,"output":1.25}}` |
| `XFEED_MAX_CHARS` | 400 | per-post truncation |
| `XFEED_TRUST_PROXY` | on | use the rightmost `X-Forwarded-For` entry as the client IP (set `0` to use the socket address) |

Counters live in memory. The service runs with `--max-instances=1` so they
are authoritative, and `--min-instances=1` so they (including the global
spend cap) are not reset by scale-to-zero. They still reset on deploys and
platform restarts; that is acceptable for v1.

## Privacy

Post text is forwarded to the scoring backend and is never logged or stored.
Each request logs one JSON line with the route, status, post count, backend,
latency, token usage, estimated cost and error codes only. Install IDs and IPs
are not logged. Backend error bodies (which can echo the input) are discarded.

## Run locally

```bash
cd server
npm test
PORT=7xxx OPENAI_API_KEY="$(cat ~/.config/openai/api-key)" node index.js
curl -s localhost:7xxx/api/ok
```

## Deploy (requires approval)

`deploy.sh` is idempotent. It creates or updates the Secret Manager secrets
`xfeed-openai-api-key` (and `xfeed-typesafe-api-key` when a TypeSafe key file
exists) from local key files with `--data-file`, grants the runtime service
account access, deploys the `xfeed-score` service from source with
`--max-instances=1`, and prints the URL.

```bash
server/deploy.sh
```

The extension expects `https://xfeed-score-874749606899.us-central1.run.app`
(`XFEED_SCORE_URL` in `providers.js`).

## Rollback

```bash
G="gcloud --account=874749606899-compute@developer.gserviceaccount.com --project=boreal-conquest-464203-v2"
# Stop all spending immediately (every request returns global_budget; the extension uses keywords):
$G run services update xfeed-score --region=us-central1 --update-env-vars=XFEED_GLOBAL_DAILY_USD=0
# Return to a previous revision:
$G run revisions list --service=xfeed-score --region=us-central1
$G run services update-traffic xfeed-score --region=us-central1 --to-revisions=<REVISION>=100
# Remove the service entirely (the extension falls back to keyword scoring):
$G run services delete xfeed-score --region=us-central1
```
