# Privacy Policy for XFeed Paradise

**Last Updated:** September 24, 2026 (v1.3.2)

## Overview

XFeed Paradise is a browser extension that filters your social media feeds to surface uplifting content and hide negative or outrage-bait posts. We are committed to protecting your privacy.

## Data Collection

### Browser Storage
- Filter settings and your Groq API key (if provided) are saved in Chrome `storage.sync`, which may sync across devices signed in to the same Chrome account.
- Cached tweet/post data is saved locally in IndexedDB.

### Data Sent to External Services

#### Groq API (Optional)
If you enable AI-powered scoring and provide a Groq key:
- Tweet/post or news-item text is sent to Groq's API for sentiment analysis. This text may itself contain personal information.
- The extension uses the API key you provide; it does not include a shared key.
- See [Groq's Privacy Policy](https://groq.com/privacy-policy/)

The extension does not upload viewed feed items to a community database. A previous version had a community-sync setting; this release no longer uses it, including for existing installations where that setting was enabled.

### Data We Do NOT Collect
- Your name, email, or any personal identifiers
- Your browsing history outside of X/Twitter and Google News
- Your Twitter/X account credentials
- New feed data while filtering is disabled

## Data Storage

- Browser data is stored using Chrome's `storage.sync` and IndexedDB APIs as described above
- We do not sell your data. Groq receives the scoring text described above only when AI scoring is enabled with your key.

## Your Rights

You can:
- Disable the extension at any time
- Clear all stored data via Settings > "Clear stored data"
- Remove your Groq API key in the extension popup to use keyword-only scoring

## Third-Party Services

This extension uses:
- **Groq API** for AI sentiment analysis - [Privacy Policy](https://groq.com/privacy-policy/)

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted to the extension's GitHub repository.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/opentoolshub/xfeedparadise/issues

## Open Source

This extension is open source. You can review all code at:
https://github.com/opentoolshub/xfeedparadise
