# Privacy Policy for XFeed Paradise

**Last Updated:** December 9, 2024

## Overview

XFeed Paradise is a browser extension that filters your social media feeds to surface uplifting content and hide negative or outrage-bait posts. We are committed to protecting your privacy.

## Data Collection

### Data Stored Locally
The following data is stored **only on your device** using Chrome's local storage:
- Your filter settings and preferences
- Cached tweet/post data for scoring purposes
- Your Groq API key (if you provide one)

### Data Sent to External Services

#### Groq API (Optional)
If you enable AI-powered scoring:
- Tweet/post text is sent to Groq's API for sentiment analysis
- No personally identifiable information is sent
- You can use your own API key or the default shared key
- See [Groq's Privacy Policy](https://groq.com/privacy-policy/)

#### Community Sync (Optional)
If you enable "Sync to community feed":
- A randomly generated anonymous user ID is created
- Tweet/post metadata (text, author handle, scores) may be synced to our Supabase database
- This data is used to build a shared curated feed
- **No personal information is collected or linked to this data**
- You can disable this feature at any time in Settings

### Data We Do NOT Collect
- Your name, email, or any personal identifiers
- Your browsing history outside of X/Twitter and Google News
- Your Twitter/X account credentials
- Any data when the extension is disabled

## Data Storage

- Local data is stored using Chrome's `storage.sync` and IndexedDB APIs
- Synced community data is stored on Supabase servers (US-based)
- We do not sell or share your data with third parties

## Your Rights

You can:
- Disable the extension at any time
- Clear all stored data via Settings > "Clear stored data"
- Disable community sync in Settings
- Use your own Groq API key instead of the shared one

## Third-Party Services

This extension uses:
- **Groq API** for AI sentiment analysis - [Privacy Policy](https://groq.com/privacy-policy/)
- **Supabase** for optional community sync - [Privacy Policy](https://supabase.com/privacy)

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted to the extension's GitHub repository.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/tmad4000/XFeedParadise/issues

## Open Source

This extension is open source. You can review all code at:
https://github.com/tmad4000/XFeedParadise
