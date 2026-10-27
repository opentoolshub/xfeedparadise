# 🌴 XFeed Paradise

A Chrome extension that transforms your X/Twitter feed into a paradise of uplifting, enlightening content by filtering out outrage-bait and negativity.

## Features

### Version 1.4.1
- **Safari on iPhone, iPad and Mac**: a Safari Web Extension build lives in `safari/` (see `safari/README.md`); touch-friendly panel, tap-to-reveal for dimmed posts
- **Fix**: changing the filter mode or threshold on X no longer un-filters visible posts until reload

### Version 1.4.0
- **Vibe-based filtering**: Automatically scores tweets based on whether they're uplifting vs. outrage-inducing
- **Multiple filter modes**:
  - **Hide**: Completely hides low-vibe tweets
  - **Dim**: Fades out negative content (hover to reveal)
  - **Collapse**: Shows a label with option to expand
- **Adjustable threshold**: Set your own vibe score cutoff
- **Debug mode**: Optionally show vibe scores on tweets
- **Local database**: Stores all tweets you see in IndexedDB for future features
- **Built-in AI, no key needed**: Fresh installs score posts with AI out of the box through the XFeed Paradise scoring service ([`server/`](server/)), free up to a daily limit per install. When the limit is reached the extension shows a one-time notice and uses keyword scoring until the next UTC day. The popup shows how many built-in posts are left today
- **AI scoring with your own key, any provider**: Groq (free key), OpenAI, Anthropic, Google Gemini, OpenRouter, Together, TypeSafe Jev, or any OpenAI-compatible endpoint such as a local Ollama server
- **Optional fallback provider**: A second provider (its own key and model) takes over when the main one errors, rate-limits or returns an unusable score. Order: main provider → fallback → local keyword scoring
- **Connection status**: The popup tests each provider with a real one-post scoring call and reports scoring failures; a warning on the page names the provider that failed and what took over
- **No community upload**: Viewed posts and articles stay in the browser's local database; AI scoring sends only scoring text, to the built-in scoring service or the provider you choose

The current extension does not call Cloudflare Workers AI.

### Scoring System
The algorithm scores tweets from -100 (pure outrage) to +100 (enlightening) based on:

**Positive signals (+points):**
- Learning & growth language (discover, insight, wisdom)
- Gratitude & appreciation (grateful, thankful, blessed)
- Connection & community (together, support, kindness)
- Achievement & progress (accomplished, milestone, launched)
- Mindfulness & wellness (peaceful, healing, growth)
- Intellectual content (research, nuanced, evidence)

**Negative signals (-points):**
- Outrage language (furious, disgusting, unacceptable)
- Divisiveness (enemy, us vs them, wake up sheeple)
- Fear-mongering (terrifying, crisis, warning)
- Contempt & insults (stupid, idiot, pathetic)
- Manipulation tactics (obviously, exposed, ratio)
- Engagement bait (ALL CAPS, excessive punctuation, "retweet if")

## Installation

### From Source (Developer Mode)

1. **Clone or download this repository**
   ```bash
   git clone https://github.com/opentoolshub/xfeedparadise.git
   cd xfeedparadise
   ```

2. **Load in Chrome**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `XFeedParadise` folder

3. **Configure AI scoring (optional)**
   - AI scoring works with no setup: the default provider is **Built-in (free, daily limit)**. Add your own key for unlimited scoring.
   - Open the extension popup → **Settings & Stats** → **AI provider**, pick a provider, and paste your key. Each provider has a **Get a key** link.
   - The **Model** field is prefilled with a cheap, fast default and is editable; use any model your key can access.
   - For a non-Groq provider, Chrome asks once for permission to contact that provider's API host. Nothing is contacted until you add a key.
   - Use **Test connection** to run a one-post scoring call. The popup also reports errors from real scoring requests.
   - Optional: open **Advanced** to add a **Fallback provider** with its own key and model.
   - Keys are saved in Chrome sync storage. The extension does not bundle an API key; the built-in provider's keys live on the scoring server.
   - Upgrading: installs with a configured key keep their provider. Installs without a key switch to the built-in provider once (choosing another provider afterwards sticks). An existing Groq key keeps working with no action.

### AI providers

| Provider | Default model (editable) | Key | API |
|---|---|---|---|
| Built-in (default) | managed | None (daily limit) | XFeed Paradise scoring service (`server/`): OpenAI Decisions or TypeSafe Jev on a seven-level rubric |
| Groq | `openai/gpt-oss-20b` | [Free key, no card](https://console.groq.com/keys) | OpenAI-compatible chat completions |
| OpenAI | `gpt-5.4-nano` | [platform.openai.com](https://platform.openai.com/api-keys) | Chat completions |
| Anthropic | `claude-haiku-5-5` | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Messages API |
| Google Gemini | `gemini-3.8-flash` | [Google AI Studio](https://aistudio.google.com/apikey) | Gemini OpenAI-compatible endpoint |
| OpenRouter | `openai/gpt-oss-20b` | [openrouter.ai](https://openrouter.ai/keys) | OpenAI-compatible |
| Together | `openai/gpt-oss-120b` | [together.ai](https://api.together.ai/settings/api-keys) | OpenAI-compatible |
| TypeSafe Jev | `jev-latest` | [console.typesafe.ai](https://console.typesafe.ai/keys) | System One `score` on a five-level rubric |
| Custom | none (enter one) | Optional | Any OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` |

Notes:
- Chat models score posts in batches of 10 and return a JSON array of scores from -100 to 100. TypeSafe Jev scores each post separately (up to 5 requests in parallel) against an ordered rubric from outrage-bait to uplifting. The extension maps the probability-weighted level to -100 to 100. Jev does not use the custom prompt.
- The built-in provider sends batches of up to 10 posts (each truncated to 400 characters) with a random install ID to the scoring service. It ignores the custom prompt. On `daily_limit` or `global_budget` it backs off until the next UTC day, or until the service's status route reports posts available again, and the fallback provider or keyword scoring takes over.
- AI scores are blended 85/15 with the local keyword score.
- Parameters differ between providers and models. If a provider rejects a parameter (for example, `temperature` on current Claude models or `reasoning_effort` on older OpenAI models), the extension retries once without it.
- A sensible two-provider setup: **TypeSafe Jev** as the main provider for calibrated rubric scores, with **OpenAI** (`gpt-5.4-nano`) or **Groq** as the fallback.
- **Custom / Ollama**: base URLs must use `https://`, or `http://localhost` or `http://127.0.0.1`. If Ollama rejects the extension's requests (HTTP 403), start it with `OLLAMA_ORIGINS=chrome-extension://*`.

4. **Visit X/Twitter or Google News**
   - Go to https://x.com or https://twitter.com
   - The extension will start filtering your feed automatically

## Usage

### Popup Controls
Click the extension icon to access:

- **Filter Active**: Toggle filtering on/off
- **Vibe Threshold**: Slider to set minimum score (-50 to +50)
  - 0: Hide negative content
  - -20: Only hide very negative content
  - +20: Only show genuinely positive content
- **Filter Mode**: Choose how to handle low-vibe tweets
- **Show vibe scores**: Debug mode to see scores on each tweet
- **Stats**: View how many tweets have been collected

### Customization
Edit `filter.js` to customize the scoring algorithm:
- Add words to `positivePatterns` or `negativePatterns`
- Adjust weights for different categories
- Add structural pattern detection

## Data Storage

All tweets are stored locally in your browser using IndexedDB:
- Tweet text and metadata
- Author information
- Engagement metrics
- Vibe scores
- Timestamp when collected
- Which feed it came from

When AI scoring is enabled, tweet or news-item text is sent to the built-in scoring service (which forwards it to OpenAI or TypeSafe and does not keep it) or to the provider you selected with your key (and to your fallback provider only when the main one fails). Local browsing data can be cleared via the popup.

## Development

### Project Structure
```
XFeedParadise/
├── manifest.json       # Extension configuration
├── content.js          # Main content script (runs on X/Twitter)
├── filter.js           # Vibe scoring algorithm, batching, keyword fallback
├── providers.js        # AI provider registry, request adapters, fallback order
├── db.js              # IndexedDB wrapper
├── background.js      # Service worker (makes all provider API calls)
├── popup.html/js      # Extension popup UI
├── styles.css         # Injected styles
├── icons/             # Extension icons
└── server/            # Built-in scoring service (Cloud Run); see server/README.md
```

### Testing Changes
Run the unit tests with `npm test` (`node --test`). They exercise every provider adapter with a mocked `fetch`, and include the scoring service's tests in `server/test/`.

1. Make your edits
2. Go to `chrome://extensions/`
3. Click the refresh icon on the XFeed Paradise card
4. Reload X/Twitter

## Contributing

PRs welcome! Some ideas:
- Improve the scoring algorithm
- Add support for different languages
- Create better pattern detection

## License

MIT

---

*Transform your timeline. Raise your vibe.* 🌴
