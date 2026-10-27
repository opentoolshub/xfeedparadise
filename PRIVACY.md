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

The extension does not upload viewed feed items to a community database. A previous version had a community-sync setting; this release no longer uses it, including for existing installations where that setting was enabled.

### Data We Do NOT Collect
- Your name, email, or any personal identifiers
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

## Third-Party Services

This extension uses:
- The AI provider you select (and an optional fallback) for sentiment analysis, as listed above. No provider is used unless you add a key.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted to the extension's GitHub repository.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/opentoolshub/xfeedparadise/issues

## Open Source

This extension is open source. You can review all code at:
https://github.com/opentoolshub/xfeedparadise
