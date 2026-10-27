# Privacy Policy for XFeed Paradise

**Last Updated:** October 26, 2026 (v1.3.3)

## Overview

XFeed Paradise is a browser extension that filters your social media feeds to surface uplifting content and hide negative or outrage-bait posts. We are committed to protecting your privacy.

## Data Collection

### Browser Storage
- Filter settings, your chosen AI provider and model, and any API keys you provide are saved in Chrome `storage.sync`, which may sync across devices signed in to the same Chrome account. Connection status is saved in local extension storage. Keys are never written to logs or status messages.
- Cached tweet/post data is saved locally in IndexedDB.

### Data Sent to External Services

#### AI provider you choose (Optional)
Nothing is sent to any AI provider unless you add a key (or, for a custom endpoint, a base URL). If you enable AI-powered scoring:
- Tweet/post or news-item text is sent to the provider you select for sentiment scoring. This text may itself contain personal information.
- If you configure a fallback provider, the same text is sent to it only when the main provider fails, is rate-limited or returns an unusable score.
- The extension uses the API key you provide; it does not include a shared key. Each provider receives only its own key.
- Supported providers and their privacy policies: [Groq](https://groq.com/privacy-policy/), [OpenAI](https://openai.com/policies/privacy-policy/), [Anthropic](https://www.anthropic.com/legal/privacy), [Google Gemini API](https://ai.google.dev/gemini-api/terms), [OpenRouter](https://openrouter.ai/privacy), [Together AI](https://www.together.ai/privacy), [TypeSafe](https://typesafe.ai). A custom endpoint (for example, a local Ollama server) receives the text at the URL you enter.
- For providers other than Groq, Chrome asks for your permission before the extension can contact that provider's host.

#### Paradise Reader (optional, off by default)
Paradise Reader lets you read your filtered X feed on your phone. Nothing is uploaded unless you turn on **Paradise Reader (phone)** in the popup, confirm the disclosure, and sign in with your Ideaflow ID. While it is on and you are signed in:
- For each X post the extension scores, it uploads: the post ID and link, the author's handle and display name, the post text, the post time, the vibe score, whether the post was kept or hidden, and an image thumbnail link on X's image server (`pbs.twimg.com`). Avatars, engagement counts and your X account name are not uploaded. Google News items are never uploaded.
- Posts go to the XFeed Paradise Reader service (Google Cloud Run and Cloud SQL, US region) and are linked to your Ideaflow ID account identifier. Only you can read them, after signing in. There is no sharing and no community feed.
- The service keeps your newest 2,000 posts, each for at most 30 days. It does not log post text.
- Sign-in uses Ideaflow ID (`id.ideaflow.app`). The extension keeps its sign-in tokens in local extension storage (not synced).
- "Delete everything" in the popup or in the reader permanently deletes all your saved posts. Turning the feature off or signing out stops uploads immediately; "Clear stored data" also signs the extension out.
- The reader web app has no analytics or third-party scripts. Thumbnails load from X's image server without a referrer.

The extension does not upload viewed feed items to a community database. A previous version had a community-sync setting; this release no longer uses it, including for existing installations where that setting was enabled.

### Data We Do NOT Collect
- Your name, email, or any personal identifiers (unless you sign in to Paradise Reader, which links your saved posts to your Ideaflow ID account identifier)
- Your browsing history outside of X/Twitter and Google News
- Your Twitter/X account credentials
- New feed data while filtering is disabled

## Data Storage

- Browser data is stored using Chrome's `storage.sync` and IndexedDB APIs as described above
- We do not sell your data. Your selected AI provider (and fallback, if configured) receives the scoring text described above only when AI scoring is enabled with your key.

## Your Rights

You can:
- Disable the extension at any time
- Clear all stored data via Settings > "Clear stored data"
- Remove your API key(s) in the extension popup to use keyword-only scoring
- Turn off Paradise Reader, sign out, or delete everything it saved, from the popup or the reader

## Third-Party Services

This extension uses:
- The AI provider you select (and an optional fallback) for sentiment analysis, as listed above. No provider is used unless you add a key.
- Ideaflow ID and the XFeed Paradise Reader service, only if you turn on Paradise Reader, as described above.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted to the extension's GitHub repository.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/opentoolshub/xfeedparadise/issues

## Open Source

This extension is open source. You can review all code at:
https://github.com/opentoolshub/xfeedparadise
