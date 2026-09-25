# Privacy Policy for XFeed Paradise

**Last Updated:** September 24, 2026

## Overview

XFeed Paradise is a browser extension that filters your social media feeds to surface uplifting content and hide negative or outrage-bait posts. We are committed to protecting your privacy.

## Data Collection

### Browser Storage
- Filter settings and your Groq API key (if provided) are saved in Chrome `storage.sync`, which may sync across devices signed in to the same Chrome account.
- Cached tweet/post data is saved locally in IndexedDB.

### Data Sent to External Services

#### Groq API (Optional)
If you enable AI-powered scoring:
- Tweet/post or news-item text is sent to Groq's API for sentiment analysis. This text may itself contain personal information.
- The extension uses the API key you provide; it does not include a shared key.
- See [Groq's Privacy Policy](https://groq.com/privacy-policy/)

#### Community Sync (Optional)
If you enable "Sync to community feed":
- A randomly generated anonymous user ID is created
- Tweet/post metadata (text, author handle, scores) may be synced to our Supabase database
- This data is used to build a shared curated feed
- Author handles and post text may identify people, even though the generated user ID is anonymous.
- You can disable this feature at any time in Settings

### Data We Do NOT Collect
- Your name, email, or any personal identifiers
- Your browsing history outside of X/Twitter and Google News
- Your Twitter/X account credentials
- Any data when the extension is disabled

## Data Storage

- Browser data is stored using Chrome's `storage.sync` and IndexedDB APIs as described above
- Synced community data is stored on Supabase servers (US-based)
- We do not sell your data. Groq and Supabase receive the limited data described above when their respective features are enabled.

## Your Rights

You can:
- Disable the extension at any time
- Clear all stored data via Settings > "Clear stored data"
- Disable community sync in Settings
- Remove your Groq API key in the extension popup to use keyword-only scoring

## Third-Party Services

This extension uses:
- **Groq API** for AI sentiment analysis - [Privacy Policy](https://groq.com/privacy-policy/)
- **Supabase** for optional community sync - [Privacy Policy](https://supabase.com/privacy)

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted to the extension's GitHub repository.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/opentoolshub/xfeedparadise/issues

## Open Source

This extension is open source. You can review all code at:
https://github.com/opentoolshub/xfeedparadise
