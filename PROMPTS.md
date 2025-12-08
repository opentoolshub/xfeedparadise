# User Prompts Log

## 2025-12-07 - Debug Mode and Batching Request

By the way at the very least our app should definitely give descriptive error messages when we hit the rate limit if you're in debug mode with the chrome extension, at least which you should be able to change in settings. And let's batch as many as we can, but like I really want this to work at the speed of scrolling if at all possible if you have an idea about how to do this

---

## 2025-12-07 - Gemini Rate Limits Question

Would there be less for rate limit on Gemini?

---

## 2025-12-07 - Speed Strategy Discussion

But the app needs to go really fast like as fast as I can scroll. Can we strategize about this like is this just the rate limit on the API or is this API even going to work? Let's brainstorm

---

## 2025-12-07 - Groq Rate Limit Error

As I'm going through the app, I get this error is a rate limit or something Groq API error: 429

---

## 2025-12-07 - Filtering Not Working

Also, can you look at the app and figure out why when I'm using it? It's not actually working like it's not hiding or filtering anything

---

## 2025-12-07 - Local Project Only

I wanted it only for our local file our local project not uni

---

## 2025-12-07 - Prompt Logging Setup

I would like you to head the prompts in prompt. MD every time. Should we put them in claude.MD or something or what's the

---

## 2024-12-07 - Add AI Scoring

Also, I want it to be doing this using AI. Can we install an AI library to make this work?

---

## 2024-12-07 - Icon Rename Request

Rename the files for default icons that I downloaded correctly, please and also change the icons page

---

## 2024-12-07 - Initial Project Request

So, okay, make a Chrome extension which sits on top of your Twitter feed, like your X feed, and reads the content of the page. And what it should do is two things. Firstly, it should extract all the tweets that you read into a database of all tweets. All users of this Chrome extension. It'll ingest their own feeds.

It'll remember whose feed it came from. And have all the meta information on the tweets that it can access just by looking at the screen easily. And then, that's one part of it. And then the second part of it, which can be independent of this. But it's also synergistic, which is it just takes your X feed and it filters it according to your own algorithm, which you as a user can provide. And the default algorithm can be something like look for items that will raise your vibration and activate you and enlighten you instead of outraging you.

And there can be two versions of this. One merely filters the feed that you already have and basically hides the items that are on your feed that would not do that. And maybe this is the MVP, maybe we start with this here. And maybe it fetches more or something if it needs to, but that's also step one and a half. And then the second version of this app can take the aggregated set of all the users of this app's items and basically bring your own newsfeed, have your own newsfeed algorithm which will surface tweets from this custom shared database, this open Twitter, open X database, which should be viewable elsewhere.

Anyway, maybe. Let's start with the first step of it, the first version of this.

---

# Developer Instructions

## Feature Parity Maintenance

When modifying the UI or functionality of settings, you MUST ensure strict feature parity between the **Extension Popup** (`popup.html` / `popup.js`) and the **Floating Panel** (`content.js` / HTML injected into page).

- **Bi-directional Sync:** Any setting changed in one interface must be reflected in the other. This is primarily handled via `chrome.storage.sync` and message passing.
- **UI Consistency:** Controls added to one (e.g., the "Custom Prompt" textarea) must be added to the other with similar styling and behavior.
- **Avoid Cut-off:** When adding content to the Floating Panel, ensure `max-height` in CSS is sufficient (e.g., `80vh`) to prevent content from being cut off at the bottom of the screen.

**Reference Names:**
- **Extension Popup:** The menu that appears when clicking the extension icon in the Chrome toolbar.
- **Floating Panel:** The in-page widget (with the palm tree icon) that floats on the X/Twitter interface.