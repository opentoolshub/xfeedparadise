# XFeedParadise Mobile Server - Implementation Plan

## Goal
Build a server that provides filtered Twitter/X "For You" feeds to mobile web users (2-10 friends).

---

## Research: How to Access Twitter's "For You" Feed (Dec 2024)

### Option 1: Official Twitter API v2
| Tier | Cost | Limits | Home Timeline? |
|------|------|--------|----------------|
| Free | $0 | Write-only | NO |
| Basic | $100/mo | 10k tweets, 7 days | NO |
| Pro | $5,000/mo | 1M tweets | Limited |
| Enterprise | $42,000/mo | Full | Yes |

**Verdict**: Too expensive. Basic/Pro don't include algorithmic home timeline.

Sources: [Twitter API Pricing](https://developer.twitter.com/en/products/twitter-api), [Data365 Guide](https://data365.co/guides/twitter-api-limitations-and-pricing)

---

### Option 2: Playwright/Puppeteer DOM Scraping
- Requires authenticated session (cookies)
- Works from local machines
- **BLOCKED from cloud providers** (AWS, GCP) - returns "JavaScript not enabled"
- Requires anti-detect browsers (Browserless.io, Brightdata) - adds ~$50-200/mo
- Must maintain DOM selectors as Twitter changes UI
- Twitter's anti-bot detection tightened significantly in 2024

**Verdict**: Fragile, expensive for cloud hosting, high maintenance.

Sources: [Jonathan Soma Guide](https://jonathansoma.com/everything/scraping/scraping-twitter-playwright/), [Browserless.io](https://www.browserless.io/scraping)

---

### Option 3: Third-Party Scraping APIs (RapidAPI)
| Service | Cost | Notes |
|---------|------|-------|
| TwttrAPI | Pay-per-use | GraphQL-based, 2FA support |
| Old Bird V2 | $179.99/mo | 1M tweets |
| Apify | Pay-per-use | Various scrapers |
| SocialData | SHUT DOWN | Was popular |

**Verdict**: Adds cost, third-party dependency, some have shut down.

Sources: [TwttrAPI](https://twttrapi.com/), [ScrapingDog Comparison](https://www.scrapingdog.com/blog/best-twitter-scraper/)

---

### Option 4: Python GraphQL Libraries ⭐ RECOMMENDED

Two excellent Python libraries call Twitter's **internal GraphQL APIs** directly - no browser automation needed.

#### Option 4a: twikit ⭐ TOP PICK

| Attribute | Value |
|-----------|-------|
| GitHub Stars | **3.8k** |
| Latest Version | 2.3.1 (Feb 2025) |
| Contributors | 17 |
| Async Support | Required (v2.0+) |

**Key Methods:**
- `get_timeline()` - Returns "For You" algorithmic feed
- `get_latest_timeline()` - Returns "Following" chronological feed
- Built-in pagination with `.next()` / `.previous()`

**Authentication:**
```python
from twikit import Client

client = Client()
await client.login(
    auth_info_1=USERNAME,
    auth_info_2=EMAIL,
    password=PASSWORD,
    cookies_file='cookies.json'
)

# Get For You feed
tweets = await client.get_timeline()
```

**Pros:**
- More actively maintained (recent releases)
- Larger community
- Better documentation (ReadTheDocs)
- Async-first (great for FastAPI)
- Clean pagination API

**Cons:**
- 119 open issues
- Async-only (requires await)

Sources: [GitHub](https://github.com/d60/twikit), [Docs](https://twikit.readthedocs.io/), [PyPI](https://pypi.org/project/twikit/)

---

#### Option 4b: twitter-api-client

| Attribute | Value |
|-----------|-------|
| GitHub Stars | 1.9k |
| Latest Version | 0.10.22 (Apr 2024) |
| Async Support | Optional |

**Key Methods:**
- `home_timeline()` - Returns "For You" feed
- `home_latest_timeline(limit=500)` - Returns "Following" feed

**Authentication:**
```python
from twitter.account import Account

# Cookie-based (recommended)
account = Account(cookies={"ct0": "...", "auth_token": "..."})

# Or credentials
account = Account(email, username, password)

tweets = account.home_timeline()
```

**Pros:**
- Sync and async options
- Cookie-based auth supported

**Cons:**
- Less actively maintained
- Smaller community

Sources: [GitHub](https://github.com/trevorhobenshield/twitter-api-client), [PyPI](https://pypi.org/project/twitter-api-client/)

---

#### Comparison & Conclusion

| Feature | twikit | twitter-api-client |
|---------|--------|-------------------|
| For You feed | `get_timeline()` | `home_timeline()` |
| Following feed | `get_latest_timeline()` | `home_latest_timeline()` |
| GitHub stars | **3.8k** | 1.9k |
| Last release | **Feb 2025** | Apr 2024 |
| Async | Required | Optional |
| Pagination | Built-in `.next()` | Manual |
| Auth | Username/password | Cookies preferred |

**Verdict**: Use **twikit** - more popular, better maintained, cleaner API, and async-first design fits FastAPI perfectly.

---

### Option 5: Nitter
- **SHUT DOWN February 2024**
- Guest tokens removed by Twitter
- Self-hosting requires real accounts (gets banned)

**Verdict**: Dead.

Sources: [Nitter Wikipedia](https://en.wikipedia.org/wiki/Nitter), [Cogipas Analysis](https://www.cogipas.com/nitter-shut-down-x-twitter-alternatives/)

---

### Option 6: Browser Streaming (Remote Desktop)
- Run Chrome server-side, stream video to mobile
- High bandwidth (2-5 Mbps/user)
- 100-500ms input latency
- Requires WebRTC, TURN servers

**Verdict**: Overkill, poor mobile UX.

---

## Recommended Architecture

Use **twikit** Python library (GraphQL-based, no browser automation):

```
┌─────────────────┐     ┌─────────────────────────────────┐     ┌──────────────┐
│  Mobile Web UI  │────▶│       Python/FastAPI Server     │────▶│   SQLite/    │
│  (React PWA)    │ API │  ┌───────────┐ ┌─────────────┐  │     │   Postgres   │
└─────────────────┘     │  │  twikit   │ │ Vibe Scorer │  │     │  - users     │
                        │  │ (GraphQL) │ │ (filter.py) │  │     │  - sessions  │
                        │  └───────────┘ └─────────────┘  │     │  - tweets    │
                        └─────────────────────────────────┘     └──────────────┘
```

### Why twikit + Python?
- twikit is Python-only, async-first (perfect for FastAPI)
- Direct GraphQL access to Twitter's internal APIs
- `get_timeline()` returns "For You" feed as JSON
- Port `filter.js` to Python (straightforward - regex + API calls)
- Fallback: twitter-api-client if twikit has issues

---

## Authentication Flow

Users provide their Twitter credentials to the server:

1. **Server Login**: Server logs in with user credentials (handles 2FA)
2. Cookies saved to file per user (encrypted)
3. Session reused for subsequent requests

Cookies stored encrypted (AES-256-GCM) on server.

---

## Components to Build

### 1. Server (Python + FastAPI)
- **Feed Fetcher** - Use `twikit` to call `get_timeline()` and `get_latest_timeline()`
- **Vibe Scorer** - Port filter.js patterns and Groq API calls
- **Session Manager** - Store twikit cookies per user (encrypted)
- **REST API**:
  - `GET /api/feed` - Filtered For You feed
  - `GET /api/feed/following` - Filtered Following feed
  - `GET /api/feed/hidden` - Hidden tweets
  - `POST /api/settings` - Update threshold/mode
  - `POST /api/auth/login` - Login with Twitter credentials (server handles 2FA)

### 2. Database (SQLite for simplicity, Postgres for scale)
- `users` - User accounts
- `twitter_sessions` - Encrypted cookies per user
- `tweets` - Cached tweets with scores
- `settings` - Per-user preferences

### 3. Mobile Web UI (React + Tailwind PWA)
- Feed selector (For You / Following)
- Tweet cards with vibe badges
- Threshold slider
- Filter mode toggle (hide/dim/collapse)
- Hidden tweets drawer
- PWA install prompt

---

## Files to Port/Reuse from Extension

| Extension File | Server Usage |
|----------------|--------------|
| `filter.js` | Port to `vibe_scorer.py` (keyword patterns + Groq API) |
| `db.js` | Reference for schema design |
| `styles.css` | Reference vibe indicator colors for mobile UI |
| `content.js` | NOT NEEDED - twikit returns structured JSON |

---

## Security

- **Cookies**: AES-256-GCM encrypted at rest, key in env var
- **Auth**: Simple password (bcrypt) + short-lived JWT
- **API**: HTTPS only, CORS restricted, rate limited
- **Twitter Cookies**: Never exposed to client, only stored server-side

---

## Tech Stack

- **Runtime**: Python 3.10+
- **Framework**: FastAPI (async)
- **Twitter Access**: twikit (primary), twitter-api-client (fallback)
- **AI Scoring**: Groq API (existing integration)
- **Database**: SQLite (dev) / PostgreSQL (prod)
- **Frontend**: React + Tailwind CSS
- **Hosting**: Railway, Render, or any VPS

---

## Implementation Order

1. **Validate twikit** - Test `get_timeline()` works with login auth
2. **Port filter.js to Python** - Keyword scorer + Groq API integration
3. **Build FastAPI server** - Feed endpoints, auth, settings
4. **Set up database** - User accounts, encrypted sessions, cached tweets
5. **Create mobile web UI** - Tweet cards, controls, PWA
6. **Deploy** - Railway/Render with HTTPS

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Twitter blocks GraphQL endpoints | Medium | Fallback to twitter-api-client, then Playwright |
| twikit library breaks | Low-Medium | Switch to twitter-api-client (same API pattern) |
| Rate limiting | Medium | Cache aggressively, respect limits |
| Account bans | Low | Use dedicated accounts, don't spam |
| 2FA handling | Low | twikit supports 2FA flow |

---

## Open Questions

1. How often to refresh the feed? (On-demand vs polling interval)
2. Do you want the "Following" timeline too, or just "For You"?
3. Any specific mobile UI preferences?

---

## Research Summary

We evaluated 6 approaches to access Twitter's "For You" feed:

1. **Official API** - Too expensive ($100-$42k/mo), no home timeline on lower tiers
2. **Playwright/Puppeteer** - Blocked from cloud, requires anti-detect browsers ($50-200/mo)
3. **Third-party APIs** - Adds cost/dependency, some shut down
4. **twikit** ⭐ - Best option: 3.8k stars, async, `get_timeline()` for For You
5. **twitter-api-client** - Good fallback: 1.9k stars, sync/async options
6. **Nitter** - Dead (Feb 2024)
7. **Browser streaming** - Overkill, poor mobile UX

**Conclusion**: Use **twikit** with server-side login. Falls back to twitter-api-client if needed.
